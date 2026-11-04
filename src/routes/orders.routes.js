import { Router } from 'express';
import { z } from 'zod';
import { pool, query, queryOne, transaction } from '../config/db.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { badRequest, created, notFound, ok, pageMeta, paginate } from '../utils/http.js';
import {
  cancelOrder, createOrderFromCart, loadOrderDetail, ORDER_STATUS_LABELS, quoteOrder, resolveShopId,
} from '../services/orders.js';
import { providerInstructions } from '../services/payments.js';
import { deliveryOptions } from '../services/pricing.js';
import { loadCart } from './cart.routes.js';
import { getSetting, notifyAdmins } from '../services/common.js';

const router = Router();
router.use(requireAuth);

const DELIVERY_MODES = ['home', 'office', 'shop_pickup'];
const PLANS = ['full', 'half', 'deposit'];

/**
 * Devis d'une commande (une boutique) : options de livraison du vendeur, sous-total, remise,
 * livraison, total, part payée en ligne et solde à régler au vendeur à la livraison.
 */
router.post('/quote', validate(z.object({
  shop_id: z.coerce.number().int().positive().optional(),
  address_id: z.coerce.number().int().positive(),
  delivery_mode: z.enum(DELIVERY_MODES).default('home'),
  payment_plan: z.enum(PLANS).default('full'),
  promo_code: z.string().trim().max(40).optional(),
})), async (req, res) => {
  const d = req.valid;
  const address = await queryOne(`SELECT city FROM addresses WHERE id = ? AND user_id = ?`, [d.address_id, req.user.id]);
  if (!address) throw badRequest('Adresse invalide');
  const shopId = await resolveShopId(req.user.id, d.shop_id);
  const shop = await queryOne(`SELECT * FROM shops WHERE id = ?`, [shopId]);
  if (!shop) throw notFound('Boutique introuvable');
  const cart = await loadCart(req.user.id);
  const shopSubtotal = cart.items.filter((i) => i.shop_id === shopId && i.available).reduce((s, i) => s + i.line_total, 0);
  const options = deliveryOptions(shop, address.city, shopSubtotal);
  const mode = options.some((o) => o.mode === d.delivery_mode) ? d.delivery_mode : options[0].mode;
  const params = { shopId, city: address.city, deliveryMode: mode, plan: d.payment_plan, promoCode: d.promo_code };
  // Un code promo invalide n'empêche pas le devis : le motif est renvoyé pour être affiché
  let q;
  let promo_error = null;
  try {
    q = await quoteOrder(pool, req.user, params);
  } catch (e) {
    if (!e.errors?.promo_code) throw e;
    promo_error = e.message;
    q = await quoteOrder(pool, req.user, { ...params, promoCode: null });
  }
  ok(res, {
    shop: { id: shop.id, name: shop.name, slug: shop.slug, delivery_info: shop.delivery_info },
    delivery_options: options, delivery_mode: mode, payment_plan: d.payment_plan,
    rates: { deposit: q.rates.deposit, half: q.rates.half }, cash_on_delivery: q.rates.cashOnDelivery,
    subtotal: q.subtotal, discount: q.discount, delivery_fee: q.delivery, total: q.total,
    upfront: q.upfront, balance: q.balance,
    promo: q.promo ? { code: q.promo.code, title: q.promo.promotion.title } : null, promo_error,
  });
});

const orderSchema = z.object({
  shop_id: z.coerce.number().int().positive().optional(),
  address_id: z.coerce.number({ message: 'Choisissez une adresse' }).int().positive('Choisissez une adresse'),
  delivery_mode: z.enum(DELIVERY_MODES, { message: 'Mode de livraison invalide' }),
  payment_method: z.string().min(2, 'Choisissez un opérateur Mobile Money'),
  payment_plan: z.enum(PLANS, { message: 'Choisissez comment payer' }),
  note: z.string().trim().max(500).optional(),
  promo_code: z.string().trim().max(40).optional(),
});

router.post('/', validate(orderSchema), async (req, res) => {
  const { orderId, paymentId } = await createOrderFromCart(req.user, req.valid);
  const order = await loadOrderDetail(orderId);
  const payment = order.payments.find((p) => p.id === paymentId);
  created(res, { order, payment, instructions: providerInstructions(payment) },
    `Commande ${order.order_number} enregistrée avec succès`);
});

router.get('/', async (req, res) => {
  const { page, limit, offset } = paginate(req.query, 10);
  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM orders WHERE user_id = ?`, [req.user.id]);
  const rows = await query(
    `SELECT o.id, o.order_number, o.status, o.payment_status, o.payment_method, o.payment_plan, o.total_amount,
       o.upfront_amount, o.balance_amount, o.balance_paid_at, o.created_at,
       (SELECT s.name FROM shops s WHERE s.id = o.shop_id) AS shop_name,
       (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
       (SELECT image_url FROM order_items oi WHERE oi.order_id = o.id ORDER BY oi.id LIMIT 1) AS image
     FROM orders o WHERE o.user_id = ? ORDER BY o.created_at DESC LIMIT ? OFFSET ?`,
    [req.user.id, limit, offset]);
  rows.forEach((r) => { r.status_label = ORDER_STATUS_LABELS[r.status]; });
  ok(res, rows, null, pageMeta(page, limit, total));
});

async function ownOrder(req) {
  const order = await loadOrderDetail(req.params.id);
  if (!order || order.user_id !== req.user.id) throw notFound('Commande introuvable');
  return order;
}

router.get('/:id', async (req, res) => ok(res, await ownOrder(req)));

router.get('/:id/tracking', async (req, res) => {
  const order = await ownOrder(req);
  ok(res, {
    order_number: order.order_number,
    status: order.status,
    status_label: order.status_label,
    history: order.history,
    shipments: order.items.map((i) => ({
      shop: i.shop_name, product: i.product_name, status: i.fulfillment_status,
      carrier: i.carrier, tracking_number: i.tracking_number, shipped_at: i.shipped_at, delivered_at: i.delivered_at,
    })),
  });
});

router.post('/:id/cancel', validate(z.object({ reason: z.string().trim().max(255).optional() })), async (req, res) => {
  await ownOrder(req);
  const r = await cancelOrder(Number(req.params.id), req.user, req.valid.reason || 'Annulée par le client');
  ok(res, await loadOrderDetail(req.params.id),
    r.refunding ? 'Commande annulée. Votre remboursement est en cours.' : 'Commande annulée avec succès');
});

router.post('/:id/return', validate(z.object({
  reason: z.string().trim().min(10, 'Décrivez le motif (10 caractères minimum)').max(500),
})), async (req, res) => {
  const order = await ownOrder(req);
  if (order.status !== 'delivered') throw badRequest('Un retour n’est possible qu’après livraison');
  const days = Number(await getSetting('return_days', 7));
  const deliveredAt = order.history.filter((h) => h.status === 'delivered').pop()?.created_at || order.updated_at;
  if (Date.now() - new Date(deliveredAt).getTime() > days * 86400000) {
    throw badRequest(`Le délai de retour de ${days} jours est dépassé`);
  }
  await transaction(async (conn) => {
    const [r] = await conn.query(`INSERT INTO return_requests (order_id, user_id, reason) VALUES (?, ?, ?)`,
      [order.id, req.user.id, req.valid.reason]);
    for (const it of order.items) {
      await conn.query(`INSERT INTO return_items (return_request_id, order_item_id, quantity) VALUES (?, ?, ?)`,
        [r.insertId, it.id, it.quantity]);
    }
    await conn.query(`UPDATE orders SET status = 'return_requested' WHERE id = ?`, [order.id]);
    await conn.query(`INSERT INTO order_status_history (order_id, status, comment, changed_by) VALUES (?, 'return_requested', ?, ?)`,
      [order.id, 'Retour demandé par le client', req.user.id]);
  });
  await notifyAdmins({ type: 'return', title: 'Nouvelle demande de retour', body: `Commande ${order.order_number}`, link: '/admin/commandes' });
  ok(res, await loadOrderDetail(order.id), 'Votre demande de retour a été envoyée');
});

export default router;
