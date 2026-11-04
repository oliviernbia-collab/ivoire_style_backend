import { Router } from 'express';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { query, queryOne, transaction } from '../config/db.js';
import { loadUser, requireAuth, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { privateDocumentUrl } from '../services/storage.js';
import { badRequest, conflict, created, notFound, ok, pageMeta, paginate } from '../utils/http.js';
import { money, price, randomCode, slugify } from '../utils/helpers.js';
import { audit, clearSettingsCache, notify } from '../services/common.js';
import {
  cancelOrder, creditSellerOnDelivery, loadOrderDetail, markBalanceCollected, ORDER_STATUS_LABELS,
} from '../services/orders.js';
import { refreshRating } from '../services/catalog.js';
import { grantSellerRole } from './seller.routes.js';
import { clientAudience, sellerAudience } from '../services/promotions.js';
import { requestRefund, sendPayout, setPayoutStatus } from '../services/payments.js';

const router = Router();
router.use(requireAuth, requireRole('admin', 'support'));
const adminOnly = requireRole('admin');

// =====================================================================
// Tableau de bord
// =====================================================================
router.get('/dashboard', adminOnly, async (_req, res) => {
  const counts = await queryOne(`SELECT
      (SELECT COUNT(*) FROM users u WHERE u.status = 'active') AS users,
      (SELECT COUNT(*) FROM shops WHERE status = 'approved') AS sellers,
      (SELECT COUNT(*) FROM shops WHERE status = 'pending') AS shops_pending,
      (SELECT COUNT(*) FROM products WHERE status = 'published') AS products_published,
      (SELECT COUNT(*) FROM products WHERE status = 'pending') AS products_pending,
      (SELECT COUNT(*) FROM orders) AS orders,
      (SELECT COUNT(*) FROM return_requests WHERE status = 'requested') AS returns_pending,
      (SELECT COUNT(*) FROM refunds WHERE status IN ('pending','failed')) AS refunds_pending,
      (SELECT COALESCE(SUM(amount), 0) FROM refunds WHERE status IN ('pending','failed')) AS refunds_pending_amount`);
  const money1 = await queryOne(`SELECT
      COALESCE(SUM(CASE WHEN status NOT IN ('cancelled') THEN total_amount END), 0) AS gmv,
      COALESCE(SUM(CASE WHEN payment_status = 'succeeded' THEN total_amount END), 0) AS paid,
      COALESCE(SUM(CASE WHEN status NOT IN ('cancelled') THEN discount_total END), 0) AS discounts
    FROM orders`);
  const activePromos = await queryOne(
    `SELECT COUNT(*) AS n FROM promotions p WHERE p.is_active = 1 AND (p.starts_at IS NULL OR p.starts_at <= NOW())
        AND (p.ends_at IS NULL OR p.ends_at >= NOW())`);
  const commissions = await queryOne(
    `SELECT COALESCE(SUM(commission_amount), 0) AS total FROM order_items WHERE fulfillment_status NOT IN ('pending','cancelled','refunded')`);
  const refunds = await queryOne(`SELECT COALESCE(SUM(amount), 0) AS total FROM refunds WHERE status = 'succeeded'`);
  const due = await queryOne(`SELECT
      (SELECT COALESCE(SUM(amount), 0) FROM seller_ledger_entries) -
      (SELECT COALESCE(SUM(amount), 0) FROM seller_payouts WHERE status IN ('paid','pending')) AS amount`);
  const byStatus = await query(`SELECT status, COUNT(*) AS n FROM orders GROUP BY status`);
  const salesByDay = await query(
    `SELECT DATE(created_at) AS day, SUM(total_amount) AS total, COUNT(*) AS orders FROM orders
      WHERE status <> 'cancelled' AND created_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
      GROUP BY DATE(created_at) ORDER BY day`);
  const topShops = await query(
    `SELECT s.name, s.slug, SUM(oi.line_total) AS sales FROM order_items oi JOIN shops s ON s.id = oi.shop_id
      WHERE oi.fulfillment_status NOT IN ('pending','cancelled') GROUP BY s.id ORDER BY sales DESC LIMIT 5`);
  ok(res, {
    ...counts,
    gmv: Number(money1.gmv),
    paid_total: Number(money1.paid),
    platform_revenue: Number(commissions.total),
    // Remises des codes promo, prises en charge par la plateforme (revenu net = commissions - remises)
    promo_discounts: Number(money1.discounts),
    net_revenue: money(Number(commissions.total) - Number(money1.discounts)),
    active_promotions: activePromos.n,
    refunds: Number(refunds.total),
    due_to_sellers: Number(due.amount),
    orders_by_status: Object.fromEntries(byStatus.map((s) => [s.status, s.n])),
    sales_by_day: salesByDay,
    top_shops: topShops,
  });
});

// =====================================================================
// Utilisateurs
// =====================================================================
router.get('/users', adminOnly, async (req, res) => {
  const { page, limit, offset } = paginate(req.query, 20);
  const where = ["u.status <> 'deleted'"];
  const params = [];
  if (req.query.q) {
    where.push("(u.email LIKE ? OR u.phone LIKE ? OR CONCAT(u.first_name, ' ', u.last_name) LIKE ?)");
    const like = `%${req.query.q}%`;
    params.push(like, like, like);
  }
  if (req.query.role) {
    where.push('EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.code = ?)');
    params.push(req.query.role);
  }
  if (req.query.status) { where.push('u.status = ?'); params.push(req.query.status); }
  const total = (await queryOne(`SELECT COUNT(*) AS n FROM users u WHERE ${where.join(' AND ')}`, params)).n;
  const rows = await query(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.status, u.created_at, u.last_login_at,
       (SELECT GROUP_CONCAT(r.code) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id) AS roles,
       (SELECT name FROM shops WHERE owner_user_id = u.id) AS shop_name,
       (SELECT COUNT(*) FROM orders WHERE user_id = u.id) AS orders_count
     FROM users u WHERE ${where.join(' AND ')} ORDER BY u.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  rows.forEach((r) => { r.roles = r.roles ? r.roles.split(',') : []; });
  ok(res, rows, null, pageMeta(page, limit, total));
});

router.patch('/users/:id/status', adminOnly, validate(z.object({ status: z.enum(['active', 'suspended']) })), async (req, res) => {
  if (Number(req.params.id) === req.user.id) throw badRequest('Vous ne pouvez pas modifier votre propre statut');
  await query(`UPDATE users SET status = ? WHERE id = ? AND status <> 'deleted'`, [req.valid.status, req.params.id]);
  if (req.valid.status === 'suspended') {
    await query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL`, [req.params.id]);
  }
  await audit(req, `user.${req.valid.status}`, 'user', req.params.id);
  ok(res, null, req.valid.status === 'suspended' ? 'Compte suspendu' : 'Compte réactivé');
});

router.put('/users/:id/roles', adminOnly, validate(z.object({
  roles: z.array(z.enum(['customer', 'seller', 'admin', 'support'])).min(1),
})), async (req, res) => {
  if (Number(req.params.id) === req.user.id && !req.valid.roles.includes('admin')) {
    throw badRequest('Vous ne pouvez pas retirer votre propre rôle administrateur');
  }
  await transaction(async (conn) => {
    await conn.query(`DELETE FROM user_roles WHERE user_id = ?`, [req.params.id]);
    await conn.query(
      `INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE code IN (?)`, [req.params.id, req.valid.roles]);
  });
  await audit(req, 'user.roles', 'user', req.params.id, req.valid.roles);
  ok(res, null, 'Rôles mis à jour');
});

// =====================================================================
// Boutiques (validation des vendeurs)
// =====================================================================
router.get('/shops', adminOnly, async (req, res) => {
  const { page, limit, offset } = paginate(req.query, 20);
  const where = ['1 = 1'];
  const params = [];
  if (req.query.status) { where.push('s.status = ?'); params.push(req.query.status); }
  if (req.query.q) { where.push('s.name LIKE ?'); params.push(`%${req.query.q}%`); }
  const total = (await queryOne(`SELECT COUNT(*) AS n FROM shops s WHERE ${where.join(' AND ')}`, params)).n;
  const rows = await query(
    `SELECT s.*, CONCAT(u.first_name, ' ', u.last_name) AS owner_name, u.email AS owner_email,
       (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id) AS product_count,
       (SELECT COUNT(*) FROM seller_documents d WHERE d.shop_id = s.id) AS document_count
     FROM shops s JOIN users u ON u.id = s.owner_user_id
     WHERE ${where.join(' AND ')} ORDER BY FIELD(s.status, 'pending', 'approved', 'suspended', 'rejected'), s.created_at DESC
     LIMIT ? OFFSET ?`, [...params, limit, offset]);
  ok(res, rows, null, pageMeta(page, limit, total));
});

router.get('/shops/:id', adminOnly, async (req, res) => {
  const shop = await queryOne(
    `SELECT s.*, CONCAT(u.first_name, ' ', u.last_name) AS owner_name, u.email AS owner_email, u.phone AS owner_phone
       FROM shops s JOIN users u ON u.id = s.owner_user_id WHERE s.id = ?`, [req.params.id]);
  if (!shop) throw notFound('Boutique introuvable');
  shop.documents = await query(`SELECT id, doc_type, original_name, mime_type, created_at FROM seller_documents WHERE shop_id = ?`, [shop.id]);
  ok(res, shop);
});

/** Documents sensibles : jamais publics, servis uniquement aux administrateurs. */
router.get('/shops/:id/documents/:docId', adminOnly, async (req, res) => {
  const doc = await queryOne(`SELECT * FROM seller_documents WHERE id = ? AND shop_id = ?`, [req.params.docId, req.params.id]);
  if (!doc) throw notFound('Document introuvable');
  // Document privé sur Cloudinary : téléchargement via une URL signée de courte durée, relayé par le serveur
  const remote = await fetch(privateDocumentUrl(doc.file_path));
  if (!remote.ok) throw notFound('Fichier indisponible');
  await audit(req, 'shop.document_view', 'shop', req.params.id, { doc: doc.id });
  res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="document-${doc.id}"`);
  res.setHeader('Cache-Control', 'no-store');
  Readable.fromWeb(remote.body).pipe(res);
});

router.patch('/shops/:id/decision', adminOnly, validate(z.object({
  decision: z.enum(['approve', 'reject', 'suspend', 'reactivate']),
  reason: z.string().trim().max(255).optional(),
})), async (req, res) => {
  const { decision, reason } = req.valid;
  const shop = await queryOne(`SELECT * FROM shops WHERE id = ?`, [req.params.id]);
  if (!shop) throw notFound('Boutique introuvable');
  if (['reject', 'suspend'].includes(decision) && !reason) throw badRequest('Indiquez un motif', { reason: 'Motif requis' });
  const status = { approve: 'approved', reject: 'rejected', suspend: 'suspended', reactivate: 'approved' }[decision];
  await transaction(async (conn) => {
    await conn.query(
      `UPDATE shops SET status = ?, rejection_reason = ?, approved_at = IF(? = 'approved' AND approved_at IS NULL, NOW(), approved_at) WHERE id = ?`,
      [status, reason || null, status, shop.id]);
    if (status === 'approved') await grantSellerRole(conn, shop.owner_user_id);
    const messages = {
      approve: ['Votre boutique est validée !', 'Félicitations, vous pouvez maintenant publier vos vêtements sur Ivoire Style.'],
      reject: ['Demande vendeur refusée', `Motif : ${reason}. Vous pouvez corriger et soumettre à nouveau.`],
      suspend: ['Boutique suspendue', `Motif : ${reason}. Contactez le support.`],
      reactivate: ['Boutique réactivée', 'Votre boutique est de nouveau visible.'],
    }[decision];
    await notify(shop.owner_user_id, { type: 'seller', title: messages[0], body: messages[1], link: '/vendeur' }, conn);
  });
  await audit(req, `shop.${decision}`, 'shop', shop.id, { reason });
  const label = { approve: 'Boutique validée', reject: 'Demande refusée', suspend: 'Boutique suspendue', reactivate: 'Boutique réactivée' };
  ok(res, null, label[decision]);
});

/** Réglages d'une boutique par l'admin : mise en avant (pas de commission : frais plateforme ajoutés au prix client). */
router.patch('/shops/:id', adminOnly, validate(z.object({ is_featured: z.coerce.boolean() })), async (req, res) => {
  await query(`UPDATE shops SET is_featured = ? WHERE id = ?`, [req.valid.is_featured ? 1 : 0, req.params.id]);
  await audit(req, 'shop.update', 'shop', req.params.id, req.valid);
  ok(res, null, 'Boutique mise à jour');
});

// =====================================================================
// Produits (modération)
// =====================================================================
router.get('/products', adminOnly, async (req, res) => {
  const { page, limit, offset } = paginate(req.query, 20);
  const where = ['1 = 1'];
  const params = [];
  if (req.query.status) { where.push('p.status = ?'); params.push(req.query.status); }
  if (req.query.q) { where.push('(p.name LIKE ? OR s.name LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  const total = (await queryOne(`SELECT COUNT(*) AS n FROM products p JOIN shops s ON s.id = p.shop_id WHERE ${where.join(' AND ')}`, params)).n;
  const rows = await query(
    `SELECT p.id, p.name, p.slug, p.status, p.moderation_note, p.is_featured, p.min_price AS price, p.created_at, p.description,
       s.name AS shop_name, c.name AS category_name,
       (SELECT url FROM product_images pi WHERE pi.product_id = p.id AND pi.media_type = 'image' ORDER BY pi.sort_order, pi.id LIMIT 1) AS image,
       (SELECT COALESCE(SUM(stock_quantity), 0) FROM product_variants v WHERE v.product_id = p.id AND v.status = 'active') AS stock
     FROM products p JOIN shops s ON s.id = p.shop_id JOIN categories c ON c.id = p.category_id
     WHERE ${where.join(' AND ')} ORDER BY FIELD(p.status, 'pending') DESC, p.updated_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]);
  ok(res, rows, null, pageMeta(page, limit, total));
});

router.patch('/products/:id/moderate', adminOnly, validate(z.object({
  action: z.enum(['approve', 'reject', 'disable']),
  note: z.string().trim().max(255).optional(),
})), async (req, res) => {
  const { action, note } = req.valid;
  const p = await queryOne(`SELECT p.*, s.owner_user_id FROM products p JOIN shops s ON s.id = p.shop_id WHERE p.id = ?`, [req.params.id]);
  if (!p) throw notFound('Produit introuvable');
  if (action !== 'approve' && !note) throw badRequest('Indiquez un motif', { note: 'Motif requis' });
  const status = { approve: 'published', reject: 'rejected', disable: 'disabled' }[action];
  await query(
    `UPDATE products SET status = ?, moderation_note = ?, published_at = IF(? = 'published' AND published_at IS NULL, NOW(), published_at) WHERE id = ?`,
    [status, note || null, status, p.id]);
  await notify(p.owner_user_id, {
    type: 'moderation',
    title: action === 'approve' ? `« ${p.name} » est en ligne` : `« ${p.name} » n’a pas été publié`,
    body: action === 'approve' ? 'Votre vêtement est maintenant visible par les clients.' : `Motif : ${note}`,
    link: `/vendeur/produits/${p.id}`,
  });
  await audit(req, `product.${action}`, 'product', p.id, { note });
  ok(res, null, { approve: 'Produit publié', reject: 'Produit refusé', disable: 'Produit désactivé' }[action]);
});

router.patch('/products/:id/featured', adminOnly, validate(z.object({ is_featured: z.coerce.boolean() })), async (req, res) => {
  await query(`UPDATE products SET is_featured = ? WHERE id = ?`, [req.valid.is_featured ? 1 : 0, req.params.id]);
  ok(res, null, req.valid.is_featured ? 'Produit mis en avant' : 'Produit retiré de la mise en avant');
});

// =====================================================================
// Commandes, paiements, retours, remboursements (support : lecture seule)
// =====================================================================
router.get('/orders', async (req, res) => {
  const { page, limit, offset } = paginate(req.query, 20);
  const where = ['1 = 1'];
  const params = [];
  if (req.query.status) { where.push('o.status = ?'); params.push(req.query.status); }
  if (req.query.payment_status) { where.push('o.payment_status = ?'); params.push(req.query.payment_status); }
  if (req.query.q) {
    where.push('(o.order_number LIKE ? OR u.email LIKE ? OR o.ship_phone LIKE ?)');
    params.push(`%${req.query.q}%`, `%${req.query.q}%`, `%${req.query.q}%`);
  }
  const total = (await queryOne(`SELECT COUNT(*) AS n FROM orders o JOIN users u ON u.id = o.user_id WHERE ${where.join(' AND ')}`, params)).n;
  const rows = await query(
    `SELECT o.id, o.order_number, o.status, o.payment_status, o.payment_method, o.total_amount, o.created_at,
       CONCAT(u.first_name, ' ', u.last_name) AS customer, u.email,
       (SELECT COUNT(DISTINCT shop_id) FROM order_items oi WHERE oi.order_id = o.id) AS shop_count
     FROM orders o JOIN users u ON u.id = o.user_id WHERE ${where.join(' AND ')} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]);
  rows.forEach((r) => { r.status_label = ORDER_STATUS_LABELS[r.status]; });
  ok(res, rows, null, pageMeta(page, limit, total));
});

router.get('/orders/:id', async (req, res) => {
  const order = await loadOrderDetail(req.params.id);
  if (!order) throw notFound('Commande introuvable');
  order.customer = await queryOne(`SELECT id, first_name, last_name, email, phone FROM users WHERE id = ?`, [order.user_id]);
  order.refunds = await query(`SELECT * FROM refunds WHERE order_id = ? ORDER BY id DESC`, [order.id]);
  ok(res, order);
});

router.post('/orders/:id/cancel', adminOnly, validate(z.object({ reason: z.string().trim().min(3, 'Motif requis').max(255) })), async (req, res) => {
  const r = await cancelOrder(Number(req.params.id), req.user, req.valid.reason, { force: true });
  await audit(req, 'order.cancel', 'order', req.params.id, req.valid);
  ok(res, await loadOrderDetail(req.params.id), r.refunding ? 'Commande annulée, remboursement à traiter' : 'Commande annulée');
});

/** Remboursement (total ou partiel) dans la limite du paiement d'origine ; en mode Jèko, virement vers le client. */
router.post('/orders/:id/refund', adminOnly, validate(z.object({
  amount: z.coerce.number().positive('Montant invalide').optional(),
  reason: z.string().trim().min(3, 'Motif requis').max(255),
})), async (req, res) => {
  const result = await requestRefund(Number(req.params.id), req.valid, req.user.id);
  await audit(req, 'order.refund', 'order', req.params.id, result);
  const message = result.status === 'succeeded'
    ? `Remboursement de ${result.amount} FCFA effectué`
    : result.status === 'processing'
      ? `Virement de ${result.amount} FCFA envoyé au client : en attente de confirmation de l’opérateur`
      : 'Le virement de remboursement a échoué';
  ok(res, await loadOrderDetail(req.params.id), message);
});
router.patch('/orders/:id/status', adminOnly, validate(z.object({
  status: z.enum(['confirmed', 'preparing', 'ready', 'shipped', 'in_delivery', 'delivered']),
  comment: z.string().trim().max(255).optional(),
})), async (req, res) => {
  const { status, comment } = req.valid;
  await transaction(async (conn) => {
    const [[order]] = await conn.query(`SELECT * FROM orders WHERE id = ? FOR UPDATE`, [req.params.id]);
    if (!order) throw notFound('Commande introuvable');
    if (['cancelled', 'refunded'].includes(order.status)) throw badRequest('Commande clôturée');
    await conn.query(`UPDATE orders SET status = ? WHERE id = ?`, [status, order.id]);
    const [items] = await conn.query(`SELECT * FROM order_items WHERE order_id = ? AND fulfillment_status NOT IN ('cancelled','delivered')`, [order.id]);
    for (const it of items) {
      await conn.query(`UPDATE order_items SET fulfillment_status = ?, delivered_at = IF(? = 'delivered', NOW(), delivered_at) WHERE id = ?`,
        [status, status, it.id]);
    }
    if (status === 'delivered') {
      // Livrée par décision de l'administration : le solde est considéré comme réglé au vendeur
      await markBalanceCollected(conn, order.id, req.user.id);
      await creditSellerOnDelivery(conn, order.id);
    }
    await conn.query(`INSERT INTO order_status_history (order_id, status, comment, changed_by) VALUES (?, ?, ?, ?)`,
      [order.id, status, comment || `Statut modifié par l'administration`, req.user.id]);
    await notify(order.user_id, { type: 'order', title: `Commande ${order.order_number}`, body: ORDER_STATUS_LABELS[status], link: `/compte/commandes/${order.id}` }, conn);
  });
  await audit(req, 'order.status', 'order', req.params.id, req.valid);
  ok(res, await loadOrderDetail(req.params.id), `Statut : ${ORDER_STATUS_LABELS[status]}`);
});

router.patch('/returns/:id', adminOnly, validate(z.object({
  decision: z.enum(['accept', 'reject']),
  note: z.string().trim().max(255).optional(),
})), async (req, res) => {
  const rr = await queryOne(`SELECT * FROM return_requests WHERE id = ?`, [req.params.id]);
  if (!rr || rr.status !== 'requested') throw badRequest('Demande de retour introuvable ou déjà traitée');
  await transaction(async (conn) => {
    const accepted = req.valid.decision === 'accept';
    await conn.query(`UPDATE return_requests SET status = ?, decision_note = ? WHERE id = ?`,
      [accepted ? 'accepted' : 'rejected', req.valid.note || null, rr.id]);
    await conn.query(`UPDATE orders SET status = ? WHERE id = ?`, [accepted ? 'return_accepted' : 'delivered', rr.order_id]);
    if (accepted) {
      const [items] = await conn.query(
        `SELECT oi.variant_id, ri.quantity, o.order_number FROM return_items ri JOIN order_items oi ON oi.id = ri.order_item_id
           JOIN orders o ON o.id = oi.order_id WHERE ri.return_request_id = ?`, [rr.id]);
      for (const it of items) {
        if (!it.variant_id) continue;
        await conn.query(`UPDATE product_variants SET stock_quantity = stock_quantity + ? WHERE id = ?`, [it.quantity, it.variant_id]);
        await conn.query(`INSERT INTO inventory_movements (variant_id, quantity, reason, reference, created_by) VALUES (?, ?, 'return', ?, ?)`,
          [it.variant_id, it.quantity, it.order_number, req.user.id]);
      }
    }
    await conn.query(`INSERT INTO order_status_history (order_id, status, comment, changed_by) VALUES (?, ?, ?, ?)`,
      [rr.order_id, accepted ? 'return_accepted' : 'return_rejected', req.valid.note || null, req.user.id]);
    await notify(rr.user_id, {
      type: 'return', title: accepted ? 'Retour accepté' : 'Retour refusé',
      body: accepted ? 'Votre remboursement sera traité après réception des articles.' : (req.valid.note || 'Votre demande de retour a été refusée.'),
      link: `/compte/commandes/${rr.order_id}`,
    }, conn);
  });
  ok(res, null, req.valid.decision === 'accept' ? 'Retour accepté' : 'Retour refusé');
});

// =====================================================================
// Reversements vendeurs
// =====================================================================
router.get('/payouts', adminOnly, async (_req, res) => {
  const balances = await query(
    `SELECT s.id, s.name, s.payout_method, s.payout_account, s.payout_holder,
       COALESCE((SELECT SUM(amount) FROM seller_ledger_entries e WHERE e.shop_id = s.id), 0) AS earned,
       COALESCE((SELECT SUM(amount) FROM seller_payouts p WHERE p.shop_id = s.id AND p.status IN ('paid','pending')), 0) AS paid_or_pending
     FROM shops s WHERE s.status IN ('approved','suspended') ORDER BY s.name`);
  balances.forEach((b) => { b.balance = money(Number(b.earned) - Number(b.paid_or_pending)); });
  const payouts = await query(
    `SELECT p.*, s.name AS shop_name FROM seller_payouts p JOIN shops s ON s.id = p.shop_id ORDER BY p.id DESC LIMIT 100`);
  ok(res, { balances, payouts });
});

router.post('/payouts', adminOnly, validate(z.object({
  shop_id: z.coerce.number().int().positive(),
  amount: z.coerce.number().positive('Montant invalide'),
  note: z.string().trim().max(255).optional(),
})), async (req, res) => {
  const { shop_id, amount, note } = req.valid;
  const ref = await transaction(async (conn) => {
    const [[shop]] = await conn.query(`SELECT * FROM shops WHERE id = ? FOR UPDATE`, [shop_id]);
    if (!shop) throw notFound('Boutique introuvable');
    const [[{ earned }]] = await conn.query(`SELECT COALESCE(SUM(amount), 0) AS earned FROM seller_ledger_entries WHERE shop_id = ?`, [shop_id]);
    const [[{ out }]] = await conn.query(`SELECT COALESCE(SUM(amount), 0) AS \`out\` FROM seller_payouts WHERE shop_id = ? AND status IN ('paid','pending')`, [shop_id]);
    const balance = money(Number(earned) - Number(out));
    if (amount > balance) throw badRequest(`Montant supérieur au solde disponible (${balance} FCFA)`);
    const reference = `PO-${randomCode(10)}`;
    await conn.query(`INSERT INTO seller_payouts (shop_id, reference, amount, method, status, note, created_by) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      [shop_id, reference, amount, shop.payout_method, note || null, req.user.id]);
    return reference;
  });
  await audit(req, 'payout.create', 'shop', shop_id, { amount, ref });
  const payout = await queryOne(`SELECT id FROM seller_payouts WHERE reference = ?`, [ref]);
  // Mode Jèko : virement immédiat sur le compte Mobile Money du vendeur ; sinon paiement manuel puis « payé »
  const sent = await sendPayout(payout.id, req.user.id);
  created(res, { reference: ref, status: sent.status, manual: Boolean(sent.manual) },
    sent.manual ? `Reversement ${ref} créé : à payer manuellement`
      : sent.status === 'succeeded' ? `Reversement ${ref} payé`
        : `Reversement ${ref} envoyé au vendeur : en attente de confirmation de l’opérateur`);
});

router.patch('/payouts/:id', adminOnly, validate(z.object({ status: z.enum(['paid', 'failed']) })), async (req, res) => {
  const p = await queryOne(`SELECT * FROM seller_payouts WHERE id = ?`, [req.params.id]);
  if (!p || p.status !== 'pending') throw badRequest('Reversement introuvable ou déjà traité');
  // Un virement Jèko en cours se termine par le webhook, pas à la main
  if (p.provider_reference) throw badRequest('Ce reversement est un virement Jèko : son statut sera mis à jour automatiquement');
  await setPayoutStatus(p.id, req.valid.status, req.valid.status === 'failed' ? 'Marqué en échec par l’administration' : null);
  await audit(req, `payout.${req.valid.status}`, 'payout', p.id);
  ok(res, null, req.valid.status === 'paid' ? 'Reversement marqué comme payé' : 'Reversement marqué en échec');
});

// =====================================================================
// Catégories
// =====================================================================
const categorySchema = z.object({
  name: z.string().trim().min(2, 'Nom requis').max(100),
  parent_id: z.coerce.number().int().positive().optional().nullable(),
  icon: z.string().trim().max(60).optional(),
  sort_order: z.coerce.number().int().default(0),
  is_active: z.coerce.boolean().default(true),
});

router.get('/categories', adminOnly, async (_req, res) => {
  ok(res, await query(`SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count
                         FROM categories c ORDER BY c.sort_order, c.name`));
});

router.post('/categories', adminOnly, validate(categorySchema), async (req, res) => {
  const d = req.valid;
  const r = await query(`INSERT INTO categories (name, slug, parent_id, icon, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?)`,
    [d.name, slugify(d.name), d.parent_id || null, d.icon || 'shirt', d.sort_order, d.is_active ? 1 : 0]);
  created(res, { id: r.insertId }, 'Catégorie créée');
});

router.put('/categories/:id', adminOnly, validate(categorySchema), async (req, res) => {
  const d = req.valid;
  await query(`UPDATE categories SET name = ?, parent_id = ?, icon = ?, sort_order = ?, is_active = ? WHERE id = ?`,
    [d.name, d.parent_id || null, d.icon || 'shirt', d.sort_order, d.is_active ? 1 : 0, req.params.id]);
  ok(res, null, 'Catégorie modifiée');
});

router.delete('/categories/:id', adminOnly, async (req, res) => {
  const used = await queryOne(`SELECT COUNT(*) AS n FROM products WHERE category_id = ?`, [req.params.id]);
  if (used.n > 0) throw badRequest('Catégorie utilisée par des produits : désactivez-la plutôt');
  await query(`DELETE FROM categories WHERE id = ?`, [req.params.id]);
  ok(res, null, 'Catégorie supprimée');
});

// =====================================================================
// Paramètres et journaux
// =====================================================================
router.get('/settings', adminOnly, async (_req, res) => {
  ok(res, await query(`SELECT setting_key, setting_value, description FROM platform_settings ORDER BY setting_key`));
});

const RATE_KEYS = { platform_fee_rate: [0, 50], deposit_rate: [1, 100], half_payment_rate: [1, 99] };

router.put('/settings', adminOnly, validate(z.object({ settings: z.record(z.string(), z.coerce.string().max(500)) })), async (req, res) => {
  const s = req.valid.settings;
  for (const [key, [min, max]] of Object.entries(RATE_KEYS)) {
    if (s[key] === undefined) continue;
    const n = Number(s[key]);
    if (!Number.isFinite(n) || n < min || n > max) throw badRequest(`${key} : valeur entre ${min} et ${max} attendue`, { [key]: 'Valeur invalide' });
  }
  const before = (await queryOne(`SELECT setting_value FROM platform_settings WHERE setting_key = 'platform_fee_rate'`))?.setting_value;
  for (const [key, value] of Object.entries(s)) {
    await query(`UPDATE platform_settings SET setting_value = ? WHERE setting_key = ?`, [value, key]);
  }
  clearSettingsCache();
  // Nouveau taux de frais plateforme : tous les prix affichés aux clients sont recalculés à partir des prix vendeurs
  let repriced = 0;
  if (s.platform_fee_rate !== undefined && Number(s.platform_fee_rate) !== Number(before)) {
    const r = await query(
      `UPDATE product_variants SET price = ROUND(COALESCE(seller_price, price) * (1 + ? / 100)),
         compare_at_price = IF(seller_compare_at_price IS NULL, compare_at_price, ROUND(seller_compare_at_price * (1 + ? / 100)))
       WHERE seller_price IS NOT NULL`, [s.platform_fee_rate, s.platform_fee_rate]);
    await query(`UPDATE products p SET min_price = COALESCE((SELECT MIN(price) FROM product_variants v WHERE v.product_id = p.id AND v.status = 'active'), 0)`);
    repriced = r.affectedRows;
  }
  await audit(req, 'settings.update', 'settings', null, s);
  ok(res, { repriced }, repriced ? `Paramètres enregistrés — ${repriced} prix client(s) recalculé(s)` : 'Paramètres enregistrés');
});

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide (AAAA-MM-JJ)').optional().or(z.literal(''));

/** Journal d'activité, filtrable par période (du … au …, jours inclus). */
router.get('/audit-logs', adminOnly, validate(z.object({ from: isoDay, to: isoDay }).passthrough(), 'query'), async (req, res) => {
  const { page, limit, offset } = paginate(req.query, 30, 100);
  const { from, to } = req.valid;
  if (from && to && from > to) throw badRequest('La date de début doit précéder la date de fin', { from: 'Période invalide' });
  const where = ['1 = 1'];
  const params = [];
  if (from) { where.push('a.created_at >= ?'); params.push(`${from} 00:00:00`); }
  if (to) { where.push('a.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(to); }
  const total = (await queryOne(`SELECT COUNT(*) AS n FROM audit_logs a WHERE ${where.join(' AND ')}`, params)).n;
  const rows = await query(
    `SELECT a.*, CONCAT(u.first_name, ' ', u.last_name) AS user_name FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
      WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  ok(res, rows, null, pageMeta(page, limit, total));
});

// =====================================================================
// Boutique officielle de la plateforme (le super admin vend ses propres produits)
// =====================================================================
router.get('/official-shop', adminOnly, async (req, res) => {
  ok(res, await queryOne(`SELECT * FROM shops WHERE owner_user_id = ?`, [req.user.id]));
});

router.post('/official-shop', adminOnly, validate(z.object({
  name: z.string().trim().min(3, 'Nom requis').max(120),
  description: z.string().trim().min(20, 'Présentez la boutique (20 caractères min.)').max(2000),
  phone: z.string().trim().regex(/^\+?[0-9 ]{8,20}$/, 'Téléphone invalide'),
  email: z.string().trim().toLowerCase().email('E-mail invalide'),
  city: z.string().trim().min(2).max(80),
  commune: z.string().trim().max(80).optional(),
})), async (req, res) => {
  const d = req.valid;
  const existing = await queryOne(`SELECT id, is_official FROM shops WHERE owner_user_id = ?`, [req.user.id]);
  let slug = slugify(d.name);
  if (await queryOne(`SELECT id FROM shops WHERE slug = ? AND owner_user_id <> ?`, [slug, req.user.id])) slug = `${slug}-officiel`;
  const shopId = await transaction(async (conn) => {
    const values = [d.name, slug, `${req.user.first_name} ${req.user.last_name}`, d.description, d.phone.replace(/\s+/g, ''),
      d.email, d.city, d.commune || null];
    let id = existing?.id;
    if (existing) {
      // Une demande vendeur existante du super admin devient la boutique officielle
      await conn.query(
        `UPDATE shops SET name = ?, slug = ?, responsible_name = ?, description = ?, phone = ?, email = ?, city = ?, commune = ?,
           status = 'approved', rejection_reason = NULL, is_official = 1, commission_rate = 0,
           approved_at = COALESCE(approved_at, NOW()) WHERE id = ?`, [...values, id]);
    } else {
      const [r] = await conn.query(
        `INSERT INTO shops (name, slug, responsible_name, description, phone, email, city, commune, owner_user_id,
           status, is_official, is_featured, commission_rate, approved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 1, 1, 0, NOW())`, [...values, req.user.id]);
      id = r.insertId;
    }
    await grantSellerRole(conn, req.user.id);
    return id;
  });
  await audit(req, 'shop.official_created', 'shop', shopId);
  ok(res, { shop: await queryOne(`SELECT * FROM shops WHERE id = ?`, [shopId]), user: await loadUser(req.user.id) },
    'Boutique officielle activée : vous pouvez publier vos produits');
});

// =====================================================================
// Promotions ciblées : clients actifs (codes promo) et vendeurs très actifs (commission réduite)
// =====================================================================
const audienceSchema = z.object({
  target: z.enum(['clients', 'sellers']),
  days: z.coerce.number().int().min(1).max(365).default(30),
  min_orders: z.coerce.number().int().min(0).max(10000).default(1),
  min_amount: z.coerce.number().min(0).default(0),
});

router.get('/promotions/audience', adminOnly, validate(audienceSchema, 'query'), async (req, res) => {
  const { target, days, min_orders: minOrders, min_amount: minAmount } = req.valid;
  const rows = target === 'sellers'
    ? await sellerAudience({ days, minOrders, minAmount })
    : await clientAudience({ days, minOrders, minAmount });
  ok(res, rows);
});

router.get('/promotions', adminOnly, async (_req, res) => {
  ok(res, await query(
    `SELECT p.*,
       (p.is_active = 1 AND (p.starts_at IS NULL OR p.starts_at <= NOW()) AND (p.ends_at IS NULL OR p.ends_at >= NOW())) AS running,
       (SELECT COUNT(*) FROM promotion_users pu WHERE pu.promotion_id = p.id) AS client_count,
       (SELECT COUNT(*) FROM promotion_shops ps WHERE ps.promotion_id = p.id) AS shop_count,
       (SELECT COUNT(*) FROM orders o WHERE o.promotion_id = p.id AND o.status <> 'cancelled') AS uses,
       (SELECT COALESCE(SUM(o.discount_total), 0) FROM orders o WHERE o.promotion_id = p.id AND o.status <> 'cancelled') AS discount_given
     FROM promotions p ORDER BY p.id DESC LIMIT 200`));
});

router.get('/promotions/:id', adminOnly, async (req, res) => {
  const promo = await queryOne(`SELECT * FROM promotions WHERE id = ?`, [req.params.id]);
  if (!promo) throw notFound('Promotion introuvable');
  promo.clients = await query(
    `SELECT u.id, u.first_name, u.last_name, u.email, pu.used_count FROM promotion_users pu JOIN users u ON u.id = pu.user_id
      WHERE pu.promotion_id = ? ORDER BY u.first_name`, [promo.id]);
  promo.shops = await query(
    `SELECT s.id, s.name, s.slug, s.commission_rate FROM promotion_shops ps JOIN shops s ON s.id = ps.shop_id WHERE ps.promotion_id = ?`, [promo.id]);
  ok(res, promo);
});

const dateField = z.preprocess((v) => (v === '' || v == null ? null : v), z.coerce.date().nullable()).optional();
const promotionSchema = z.object({
  target: z.enum(['clients', 'sellers']),
  title: z.string().trim().min(3, 'Titre requis').max(120),
  description: z.string().trim().max(500).optional(),
  starts_at: dateField,
  ends_at: dateField,
  // Clients
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{4,20}$/, '4 à 20 caractères : lettres, chiffres, tirets').optional().or(z.literal('')),
  discount_type: z.enum(['percent', 'fixed']).optional(),
  discount_value: z.coerce.number().min(0).optional(),
  min_order_amount: z.coerce.number().min(0).default(0),
  max_uses_per_user: z.coerce.number().int().min(1).max(100).default(1),
  user_ids: z.array(z.coerce.number().int().positive()).max(5000).default([]),
  // Vendeurs : mise en avant de la boutique (pas de commission vendeur dans le modèle actuel)
  feature_shops: z.coerce.boolean().default(true),
  shop_ids: z.array(z.coerce.number().int().positive()).max(1000).default([]),
});

router.post('/promotions', adminOnly, validate(promotionSchema), async (req, res) => {
  const d = req.valid;
  if (d.starts_at && d.ends_at && d.ends_at <= d.starts_at) throw badRequest('La fin doit être après le début', { ends_at: 'Date invalide' });
  if (d.ends_at && d.ends_at < new Date()) throw badRequest('La date de fin est déjà passée', { ends_at: 'Date passée' });
  const isClients = d.target === 'clients';
  if (isClients) {
    if (!d.user_ids.length) throw badRequest('Sélectionnez au moins un client');
    if (!d.discount_type || !d.discount_value) throw badRequest('Indiquez la remise', { discount_value: 'Remise requise' });
    if (d.discount_type === 'percent' && d.discount_value > 90) throw badRequest('Remise maximale : 90 %', { discount_value: '90 % maximum' });
  } else {
    if (!d.shop_ids.length) throw badRequest('Sélectionnez au moins un vendeur');
    if (!d.feature_shops) throw badRequest('La récompense vendeur est la mise en avant de la boutique', { feature_shops: 'Requis' });
  }
  const code = isClients ? (d.code || `IVS-${randomCode(6)}`) : null;
  if (code && await queryOne(`SELECT id FROM promotions WHERE code = ?`, [code])) throw conflict('Ce code promo existe déjà');

  const result = await transaction(async (conn) => {
    const [r] = await conn.query(
      `INSERT INTO promotions (target, code, title, description, discount_type, discount_value, min_order_amount, max_uses_per_user,
         commission_rate, feature_shops, starts_at, ends_at, is_active, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [d.target, code, d.title, d.description || null, d.discount_type || 'percent', isClients ? d.discount_value : 0,
        isClients ? d.min_order_amount : 0, isClients ? d.max_uses_per_user : 1,
        null, isClients ? 0 : 1,
        d.starts_at || null, d.ends_at || null, req.user.id]);
    const id = r.insertId;
    const until = d.ends_at ? ` jusqu’au ${d.ends_at.toLocaleDateString('fr-FR')}` : '';
    let recipients;
    if (isClients) {
      const [users] = await conn.query(`SELECT id FROM users WHERE id IN (?) AND status = 'active'`, [d.user_ids]);
      if (!users.length) throw badRequest('Aucun client actif dans la sélection');
      await conn.query(`INSERT INTO promotion_users (promotion_id, user_id) VALUES ?`, [users.map((u) => [id, u.id])]);
      const gift = d.discount_type === 'percent' ? `-${d.discount_value} %` : `-${price(d.discount_value)}`;
      const min = d.min_order_amount > 0 ? ` dès ${price(d.min_order_amount)} d’achat` : '';
      await conn.query(`INSERT INTO notifications (user_id, type, title, body, link) VALUES ?`,
        [users.map((u) => [u.id, 'promotion', `Cadeau : ${gift} avec le code ${code}`,
          `${d.title}. Valable${min}${until}. Saisissez le code à la validation de votre commande.`, '/compte/avantages'])]);
      recipients = users.length;
    } else {
      const [shops] = await conn.query(
        `SELECT id, owner_user_id FROM shops WHERE id IN (?) AND status = 'approved' AND is_official = 0`, [d.shop_ids]);
      if (!shops.length) throw badRequest('Aucune boutique active dans la sélection');
      await conn.query(`INSERT INTO promotion_shops (promotion_id, shop_id) VALUES ?`, [shops.map((s) => [id, s.id])]);
      const perks = 'boutique mise en avant sur l’accueil';
      await conn.query(`INSERT INTO notifications (user_id, type, title, body, link) VALUES ?`,
        [shops.map((s) => [s.owner_user_id, 'promotion', 'Récompense vendeur actif',
          `Merci pour votre activité ! ${d.title} : ${perks}${until}.`, '/vendeur'])]);
      recipients = shops.length;
    }
    return { id, code, recipients };
  });
  await audit(req, 'promotion.create', 'promotion', result.id, { target: d.target, recipients: result.recipients });
  created(res, result, `Promotion créée et envoyée à ${result.recipients} ${isClients ? 'client(s)' : 'vendeur(s)'}`);
});

router.patch('/promotions/:id', adminOnly, validate(z.object({ is_active: z.coerce.boolean() })), async (req, res) => {
  const r = await query(`UPDATE promotions SET is_active = ? WHERE id = ?`, [req.valid.is_active ? 1 : 0, req.params.id]);
  if (!r.affectedRows) throw notFound('Promotion introuvable');
  await audit(req, req.valid.is_active ? 'promotion.resume' : 'promotion.stop', 'promotion', req.params.id);
  ok(res, null, req.valid.is_active ? 'Promotion réactivée' : 'Promotion arrêtée');
});

router.get('/reviews', adminOnly, async (_req, res) => {
  ok(res, await query(
    `SELECT r.*, p.name AS product_name, CONCAT(u.first_name, ' ', u.last_name) AS author
       FROM reviews r JOIN products p ON p.id = r.product_id JOIN users u ON u.id = r.user_id ORDER BY r.id DESC LIMIT 100`));
});

router.patch('/reviews/:id', adminOnly, validate(z.object({ status: z.enum(['approved', 'rejected']) })), async (req, res) => {
  const r = await queryOne(`SELECT product_id FROM reviews WHERE id = ?`, [req.params.id]);
  if (!r) throw notFound('Avis introuvable');
  await query(`UPDATE reviews SET status = ? WHERE id = ?`, [req.valid.status, req.params.id]);
  await refreshRating(r.product_id);
  ok(res, null, req.valid.status === 'approved' ? 'Avis publié' : 'Avis masqué');
});

export default router;
