import env from '../config/env.js';
import { query, queryOne, transaction } from '../config/db.js';
import { badRequest, notFound } from '../utils/http.js';
import { money, orderNumber, price as fmtPrice, randomCode } from '../utils/helpers.js';
import { getSettings, notify } from './common.js';
import { resolveClientPromo } from './promotions.js';
import { deliveryFee, PAYMENT_PLANS, paymentSplit, pricingRates } from './pricing.js';

export const ORDER_STATUS_LABELS = {
  pending: 'En attente de paiement',
  confirmed: 'Confirmée',
  preparing: 'En préparation',
  ready: 'Prête à expédier',
  shipped: 'Expédiée',
  in_delivery: 'En livraison',
  delivered: 'Livrée',
  cancelled: 'Annulée',
  return_requested: 'Retour demandé',
  return_accepted: 'Retour accepté',
  refunding: 'Remboursement en cours',
  refunded: 'Remboursée',
};

const PROGRESS = ['pending', 'confirmed', 'preparing', 'ready', 'shipped', 'in_delivery', 'delivered'];
export const SELLER_TRANSITIONS = {
  confirmed: ['preparing'],
  preparing: ['ready'],
  ready: ['shipped'],
  shipped: ['in_delivery', 'delivered'],
  in_delivery: ['delivered'],
};

/** Opérateurs Mobile Money utilisables pour la part payée en ligne. */
export const PAYMENT_METHODS = {
  orange_money: 'Orange Money',
  mtn_momo: 'MTN MoMo',
  wave: 'Wave',
  moov_money: 'Moov Money',
  card: 'Carte bancaire',
};

async function history(conn, orderId, status, comment, userId, itemId = null) {
  await conn.query(
    `INSERT INTO order_status_history (order_id, order_item_id, status, comment, changed_by) VALUES (?, ?, ?, ?, ?)`,
    [orderId, itemId, status, comment, userId],
  );
}

/** Contrôle du moyen de paiement (opérateur) et du plan choisis. */
export async function checkPayment(paymentMethod, plan) {
  const settings = await getSettings();
  const enabled = String(settings.payment_methods || '').split(',');
  // Jèko encaisse uniquement le Mobile Money (pas de carte bancaire)
  const jekoBlocked = env.payment.mode === 'jeko' && paymentMethod === 'card';
  if (!PAYMENT_METHODS[paymentMethod] || !enabled.includes(paymentMethod) || jekoBlocked) {
    throw badRequest('Choisissez un opérateur Mobile Money disponible', { payment_method: 'Opérateur indisponible' });
  }
  if (!PAYMENT_PLANS[plan]) throw badRequest('Mode de paiement invalide', { payment_plan: 'Mode invalide' });
  if (plan === 'deposit' && !enabled.includes('cash_on_delivery')) {
    throw badRequest('Le paiement à la livraison n’est pas disponible', { payment_plan: 'Indisponible' });
  }
}

/** Articles du panier d'une boutique (prix client et prix vendeur). */
async function cartLinesForShop(executor, userId, shopId, lock = false) {
  const [items] = await executor.query(
    `SELECT ci.id AS cart_item_id, ci.quantity, v.id AS variant_id, v.sku, v.size, v.color, v.price,
            COALESCE(v.seller_price, v.price) AS seller_price, v.stock_quantity, v.reserved_quantity, v.status AS variant_status,
            p.id AS product_id, p.name, p.status AS product_status, s.id AS shop_id, s.status AS shop_status, s.owner_user_id,
            (SELECT url FROM product_images pi WHERE pi.product_id = p.id AND pi.media_type = 'image' ORDER BY pi.sort_order, pi.id LIMIT 1) AS image
       FROM cart_items ci
       JOIN product_variants v ON v.id = ci.variant_id
       JOIN products p ON p.id = v.product_id
       JOIN shops s ON s.id = p.shop_id
      WHERE ci.user_id = ? AND s.id = ?
      ${lock ? 'FOR UPDATE' : ''}`,
    [userId, shopId],
  );
  return items;
}

/** Identifiant de la boutique à commander : explicite, ou la seule boutique du panier. */
export async function resolveShopId(userId, shopId) {
  if (shopId) return Number(shopId);
  const shops = await query(
    `SELECT DISTINCT p.shop_id FROM cart_items ci JOIN product_variants v ON v.id = ci.variant_id JOIN products p ON p.id = v.product_id
      WHERE ci.user_id = ?`, [userId]);
  if (!shops.length) throw badRequest('Votre panier est vide');
  if (shops.length > 1) throw badRequest('Votre panier contient plusieurs boutiques : commandez une boutique à la fois');
  return shops[0].shop_id;
}

/**
 * Devis d'une commande (sans écriture) : sous-total, frais plateforme, remise, livraison du vendeur,
 * total, part payée en ligne et solde à la livraison.
 */
export async function quoteOrder(executor, user, { shopId, city, deliveryMode, plan, promoCode, lock = false }) {
  const [[shop]] = await executor.query(`SELECT * FROM shops WHERE id = ?`, [shopId]);
  if (!shop) throw notFound('Boutique introuvable');
  const items = await cartLinesForShop(executor, user.id, shopId, lock);
  if (!items.length) throw badRequest('Aucun article de cette boutique dans votre panier');
  let subtotal = 0;
  let sellerSubtotal = 0;
  for (const it of items) {
    it.line_total = money(it.price * it.quantity);
    it.seller_line = money(it.seller_price * it.quantity);
    subtotal = money(subtotal + it.line_total);
    sellerSubtotal = money(sellerSubtotal + it.seller_line);
  }
  const delivery = deliveryFee(shop, city, deliveryMode, subtotal);
  if (delivery === null) throw badRequest('Mode de livraison non proposé par cette boutique', { delivery_mode: 'Indisponible' });
  const promo = await resolveClientPromo(lock ? executor : null, user.id, promoCode, subtotal);
  const discount = promo?.discount || 0;
  const rates = await pricingRates();
  const split = paymentSplit({ subtotal, discount, delivery, plan, rates });
  return {
    shop, items, promo, rates,
    subtotal, sellerSubtotal, platformFee: money(subtotal - sellerSubtotal), discount, delivery, ...split,
  };
}

/** Crée la commande d'une boutique depuis le panier : prix et stocks recalculés et verrouillés côté serveur. */
export async function createOrderFromCart(user, { shop_id, address_id, delivery_mode, payment_method, payment_plan, note, promo_code }) {
  await checkPayment(payment_method, payment_plan);
  const shopId = await resolveShopId(user.id, shop_id);
  const address = await queryOne(`SELECT * FROM addresses WHERE id = ? AND user_id = ?`, [address_id, user.id]);
  if (!address) throw badRequest('Adresse de livraison invalide', { address_id: 'Choisissez une adresse' });

  return transaction(async (conn) => {
    const q = await quoteOrder(conn, user, {
      shopId, city: address.city, deliveryMode: delivery_mode, plan: payment_plan, promoCode: promo_code, lock: true,
    });
    if (q.shop.status !== 'approved') throw badRequest('Cette boutique n’accepte pas de commande pour le moment');
    for (const it of q.items) {
      if (it.variant_status !== 'active' || it.product_status !== 'published') {
        throw badRequest(`« ${it.name} » n’est plus disponible. Retirez-le du panier.`);
      }
      if (it.owner_user_id === user.id) throw badRequest('Vous ne pouvez pas acheter vos propres articles');
      const available = it.stock_quantity - it.reserved_quantity;
      if (it.quantity > available) {
        throw badRequest(`Stock insuffisant pour « ${it.name} » (${it.size} / ${it.color}) : ${Math.max(available, 0)} disponible(s)`);
      }
    }
    const number = orderNumber();
    const [o] = await conn.query(
      `INSERT INTO orders (order_number, user_id, shop_id, status, payment_status, payment_method, payment_plan, delivery_mode,
         subtotal, discount_total, promotion_id, promo_code, platform_fee, delivery_fee, total_amount, upfront_amount, balance_amount,
         currency, ship_recipient, ship_phone, ship_city, ship_commune, ship_district, ship_street, ship_instructions, customer_note)
       VALUES (?, ?, ?, 'pending', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'XOF', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [number, user.id, shopId, payment_method, payment_plan, delivery_mode, q.subtotal, q.discount, q.promo?.promotion.id || null,
        q.promo?.code || null, q.platformFee, q.delivery, q.total, q.upfront, q.balance, address.recipient_name, address.phone,
        address.city, address.commune, address.district, address.street, address.instructions, note || null],
    );
    const orderId = o.insertId;
    if (q.promo) {
      await conn.query(`UPDATE promotion_users SET used_count = used_count + 1 WHERE promotion_id = ? AND user_id = ?`,
        [q.promo.promotion.id, user.id]);
    }
    for (const it of q.items) {
      // commission_* = frais plateforme de la ligne ; seller_amount = prix vendeur (ce que le vendeur reçoit)
      await conn.query(
        `INSERT INTO order_items (order_id, shop_id, product_id, variant_id, product_name, sku, size, color, image_url,
           unit_price, quantity, line_total, commission_rate, commission_amount, seller_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [orderId, it.shop_id, it.product_id, it.variant_id, it.name, it.sku, it.size, it.color, it.image,
          it.price, it.quantity, it.line_total, q.rates.fee, money(it.line_total - it.seller_line), it.seller_line],
      );
      const [upd] = await conn.query(
        `UPDATE product_variants SET stock_quantity = stock_quantity - ? WHERE id = ? AND stock_quantity - reserved_quantity >= ?`,
        [it.quantity, it.variant_id, it.quantity],
      );
      if (upd.affectedRows !== 1) throw badRequest(`Stock insuffisant pour « ${it.name} »`);
      await conn.query(
        `INSERT INTO inventory_movements (variant_id, quantity, reason, reference, created_by) VALUES (?, ?, 'order', ?, ?)`,
        [it.variant_id, -it.quantity, number, user.id],
      );
      await conn.query(`DELETE FROM cart_items WHERE id = ?`, [it.cart_item_id]);
    }
    await history(conn, orderId, 'pending', `Commande créée — ${PAYMENT_PLANS[payment_plan]}`, user.id);
    const payment = await createPaymentAttempt(conn, { id: orderId, upfront_amount: q.upfront }, payment_method, null);

    await notify(user.id, {
      type: 'order',
      title: `Commande ${number} enregistrée`,
      body: q.balance > 0
        ? `Payez ${fmtPrice(q.upfront)} en ligne pour la confirmer ; ${fmtPrice(q.balance)} seront à régler au vendeur à la livraison.`
        : 'Finalisez le paiement pour confirmer votre commande.',
      link: `/compte/commandes/${orderId}`,
    }, conn);

    return { orderId, paymentId: payment.id };
  });
}

/** Tentative de paiement en ligne de la part due à la commande (totalité, moitié ou acompte). */
export async function createPaymentAttempt(conn, order, provider, payerPhone, idempotencyKey = null) {
  const reference = `PAY-${Date.now().toString(36).toUpperCase()}-${randomCode(6)}`;
  const key = idempotencyKey || `${order.id}-${reference}`;
  const [existing] = await conn.query(`SELECT * FROM payments WHERE idempotency_key = ?`, [key]);
  if (existing.length) return existing[0];
  const [r] = await conn.query(
    `INSERT INTO payments (order_id, provider, reference, idempotency_key, amount, currency, payer_phone, status)
     VALUES (?, ?, ?, ?, ?, 'XOF', ?, 'initiated')`,
    [order.id, provider, reference, key, order.upfront_amount, payerPhone],
  );
  const [[payment]] = await conn.query(`SELECT * FROM payments WHERE id = ?`, [r.insertId]);
  return payment;
}

/** Passe la commande en « confirmée » (paiement en ligne reçu) et prévient le vendeur. */
export async function confirmOrder(conn, orderId, userId, comment) {
  await conn.query(`UPDATE orders SET status = 'confirmed' WHERE id = ? AND status = 'pending'`, [orderId]);
  await conn.query(`UPDATE order_items SET fulfillment_status = 'confirmed' WHERE order_id = ? AND fulfillment_status = 'pending'`, [orderId]);
  await history(conn, orderId, 'confirmed', comment, userId);
  const [lines] = await conn.query(
    `SELECT oi.product_id, oi.quantity, s.owner_user_id, o.order_number, o.balance_amount
       FROM order_items oi JOIN shops s ON s.id = oi.shop_id JOIN orders o ON o.id = oi.order_id WHERE oi.order_id = ?`,
    [orderId],
  );
  for (const l of lines) {
    if (l.product_id) await conn.query(`UPDATE products SET sales_count = sales_count + ? WHERE id = ?`, [l.quantity, l.product_id]);
  }
  if (lines.length) {
    const { owner_user_id: ownerId, order_number: number, balance_amount: balance } = lines[0];
    await notify(ownerId, {
      type: 'seller_order',
      title: 'Nouvelle commande à préparer',
      body: `Commande ${number}${Number(balance) > 0 ? ` — ${fmtPrice(balance)} à encaisser à la livraison` : ' — payée en totalité'}.`,
      link: '/vendeur/commandes',
    }, conn);
  }
}

/** Statut global de la commande, déduit de ses lignes. */
export async function recomputeOrderStatus(conn, orderId, userId) {
  const [[order]] = await conn.query(`SELECT status FROM orders WHERE id = ?`, [orderId]);
  if (['cancelled', 'return_requested', 'return_accepted', 'refunding', 'refunded'].includes(order.status)) return order.status;
  const [items] = await conn.query(`SELECT fulfillment_status FROM order_items WHERE order_id = ?`, [orderId]);
  const active = items.filter((i) => i.fulfillment_status !== 'cancelled');
  let next;
  if (!active.length) next = 'cancelled';
  else next = PROGRESS[Math.min(...active.map((i) => PROGRESS.indexOf(i.fulfillment_status)).filter((x) => x >= 0))];
  if (next && next !== order.status) {
    await conn.query(`UPDATE orders SET status = ? WHERE id = ?`, [next, orderId]);
    await history(conn, orderId, next, ORDER_STATUS_LABELS[next], userId);
  }
  return next;
}

/** Solde réglé au vendeur à la livraison : la commande est alors entièrement payée. */
export async function markBalanceCollected(conn, orderId, userId) {
  const [r] = await conn.query(
    `UPDATE orders SET balance_paid_at = NOW(), payment_status = 'succeeded', paid_at = COALESCE(paid_at, NOW())
      WHERE id = ? AND balance_amount > 0 AND balance_paid_at IS NULL`, [orderId]);
  if (r.affectedRows) await history(conn, orderId, 'delivered', 'Solde encaissé par le vendeur à la livraison', userId);
}

/** Restitue le stock des lignes non expédiées d'une commande. */
async function restock(conn, orderId, number, userId) {
  const [items] = await conn.query(
    `SELECT id, variant_id, quantity FROM order_items WHERE order_id = ? AND fulfillment_status IN ('pending','confirmed','preparing','ready')`,
    [orderId]);
  for (const it of items) {
    if (it.variant_id) {
      await conn.query(`UPDATE product_variants SET stock_quantity = stock_quantity + ? WHERE id = ?`, [it.quantity, it.variant_id]);
      await conn.query(
        `INSERT INTO inventory_movements (variant_id, quantity, reason, reference, created_by) VALUES (?, ?, 'cancel', ?, ?)`,
        [it.variant_id, it.quantity, number, userId]);
    }
    await conn.query(`UPDATE order_items SET fulfillment_status = 'cancelled' WHERE id = ?`, [it.id]);
  }
}

export async function cancelOrder(orderId, actor, reason, { force = false } = {}) {
  return transaction(async (conn) => {
    const [[order]] = await conn.query(`SELECT * FROM orders WHERE id = ? FOR UPDATE`, [orderId]);
    if (!order) throw notFound('Commande introuvable');
    const cancellable = ['pending', 'confirmed'].includes(order.status) || (force && ['preparing', 'ready'].includes(order.status));
    if (!cancellable) {
      throw badRequest(order.status === 'cancelled'
        ? 'Cette commande est déjà annulée'
        : 'Cette commande ne peut plus être annulée. Une demande de retour sera possible après livraison.');
    }
    await restock(conn, orderId, order.order_number, actor?.id || null);
    // Le code promo utilisé redevient disponible pour le client
    if (order.promotion_id) {
      await conn.query(
        `UPDATE promotion_users SET used_count = GREATEST(used_count - 1, 0) WHERE promotion_id = ? AND user_id = ?`,
        [order.promotion_id, order.user_id]);
    }
    // La part payée en ligne (totalité, moitié ou acompte) est remboursée
    const paid = ['succeeded', 'partially_paid'].includes(order.payment_status);
    await conn.query(
      `UPDATE orders SET status = ?, payment_status = ?, cancelled_reason = ? WHERE id = ?`,
      [paid ? 'refunding' : 'cancelled', paid ? 'refunding' : 'cancelled', reason || null, orderId]);
    await conn.query(`UPDATE payments SET status = 'cancelled' WHERE order_id = ? AND status IN ('initiated','pending')`, [orderId]);
    if (paid) {
      const [[pay]] = await conn.query(`SELECT id, amount FROM payments WHERE order_id = ? AND status = 'succeeded' ORDER BY id DESC LIMIT 1`, [orderId]);
      if (pay) {
        await conn.query(
          `INSERT INTO refunds (payment_id, order_id, reference, amount, reason, status, created_by) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
          [pay.id, orderId, `REF-${randomCode(10)}`, pay.amount, reason || 'Annulation', actor?.id || null]);
        await conn.query(`UPDATE payments SET status = 'refunding' WHERE id = ?`, [pay.id]);
      }
    }
    await history(conn, orderId, 'cancelled', reason ? `Annulée : ${reason}` : 'Commande annulée', actor?.id || null);
    await notify(order.user_id, {
      type: 'order',
      title: `Commande ${order.order_number} annulée`,
      body: paid ? 'Le montant payé en ligne vous sera remboursé.' : 'Votre commande a été annulée.',
      link: `/compte/commandes/${orderId}`,
    }, conn);
    // Le vendeur est prévenu, sauf si la commande n'avait jamais été payée (il ne l'a donc jamais reçue)
    if (order.status !== 'pending') {
      const [[shop]] = await conn.query(`SELECT owner_user_id FROM shops WHERE id = ?`, [order.shop_id]);
      if (shop) {
        await notify(shop.owner_user_id, {
          type: 'order',
          title: `Commande ${order.order_number} annulée`,
          body: `${actor?.id === order.user_id ? 'Le client a annulé' : 'La commande a été annulée'}${reason ? ` (${reason})` : ''}. Ne la préparez pas : les articles ont été remis en stock.`,
          link: '/vendeur/commandes',
        }, conn);
      }
    }
    return { refunding: paid };
  });
}

/** Annule automatiquement les commandes dont la part en ligne n'a pas été payée dans le délai de réservation. */
export async function expireUnpaidOrders(beforeExpire = null) {
  // Mode Jèko : vérifie d'abord les tentatives en cours (un paiement réussi ne doit pas être annulé)
  if (beforeExpire) await beforeExpire();
  const s = await getSettings();
  const minutes = Number(s.reservation_minutes || 60);
  const rows = await query(
    `SELECT id FROM orders WHERE status = 'pending' AND payment_status IN ('pending','initiated','failed')
       AND created_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [minutes]);
  for (const r of rows) {
    try {
      await cancelOrder(r.id, null, 'Délai de paiement dépassé');
    } catch (e) {
      console.error('[EXPIRATION]', r.id, e.message);
    }
  }
  return rows.length;
}

/**
 * À la livraison, le vendeur est crédité de ce que la plateforme a encaissé pour lui :
 * part payée en ligne − frais plateforme (+ remise promo, prise en charge par la plateforme).
 * Le solde éventuel, il l'a encaissé directement auprès du client. Une seule fois par commande.
 */
export async function creditSellerOnDelivery(conn, orderId) {
  const [[o]] = await conn.query(
    `SELECT o.*, (SELECT COUNT(*) FROM seller_ledger_entries e WHERE e.order_id = o.id AND e.entry_type = 'sale') AS credited
       FROM orders o WHERE o.id = ?`, [orderId]);
  if (!o || o.credited || !o.shop_id) return;
  const platformNet = money(Number(o.platform_fee) - Number(o.discount_total));
  await conn.query(
    `INSERT INTO seller_ledger_entries (shop_id, order_id, entry_type, amount, description) VALUES
       (?, ?, 'sale', ?, ?), (?, ?, 'commission', ?, ?)`,
    [o.shop_id, o.id, o.upfront_amount, `Paiement en ligne ${o.order_number}`,
      o.shop_id, o.id, -platformNet,
      Number(o.discount_total) > 0 ? `Frais plateforme (remise ${o.promo_code} offerte par la plateforme)` : 'Frais plateforme']);
}

export async function loadOrderDetail(orderId) {
  const order = await queryOne(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  if (!order) return null;
  order.items = await query(
    `SELECT oi.*, s.name AS shop_name, s.slug AS shop_slug, p.slug AS product_slug,
       (SELECT COUNT(*) FROM reviews r WHERE r.user_id = ? AND r.product_id = oi.product_id) > 0 AS reviewed
       FROM order_items oi JOIN shops s ON s.id = oi.shop_id LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ? ORDER BY oi.id`, [order.user_id, orderId]);
  order.items.forEach((i) => { i.reviewed = Boolean(i.reviewed); });
  order.shop = order.shop_id
    ? await queryOne(`SELECT id, name, slug, phone, delivery_info FROM shops WHERE id = ?`, [order.shop_id])
    : null;
  order.history = await query(
    `SELECT status, comment, created_at FROM order_status_history WHERE order_id = ? ORDER BY created_at, id`, [orderId]);
  order.payments = await query(
    `SELECT id, provider, reference, amount, status, failure_reason, created_at, confirmed_at
       FROM payments WHERE order_id = ? ORDER BY id DESC`, [orderId]);
  order.returns = await query(`SELECT id, reason, status, decision_note, created_at FROM return_requests WHERE order_id = ?`, [orderId]);
  order.status_label = ORDER_STATUS_LABELS[order.status];
  order.payment_method_label = PAYMENT_METHODS[order.payment_method] || order.payment_method;
  order.payment_plan_label = PAYMENT_PLANS[order.payment_plan];
  return order;
}
