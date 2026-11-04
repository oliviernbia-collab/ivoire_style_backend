import { query } from '../config/db.js';
import { badRequest } from '../utils/http.js';
import { money, price as fmtPrice } from '../utils/helpers.js';

/**
 * Promotions ciblées
 *  - clients : code de réduction personnel (réservé aux clients choisis), remise prise en charge par la plateforme
 *    (la part du vendeur n'est jamais diminuée) ;
 *  - vendeurs : mise en avant de la boutique sur l'accueil pendant la période
 *    (les vendeurs ne paient pas de commission : les frais plateforme sont ajoutés au prix client).
 */
export const ACTIVE = (alias = 'p') =>
  `${alias}.is_active = 1 AND (${alias}.starts_at IS NULL OR ${alias}.starts_at <= NOW()) AND (${alias}.ends_at IS NULL OR ${alias}.ends_at >= NOW())`;

/** Expression SQL : boutique mise en avant (manuellement ou par une promotion vendeur active). */
export const FEATURED_SQL = (shopAlias = 's') => `(${shopAlias}.is_featured = 1 OR EXISTS (
  SELECT 1 FROM promotion_shops fps JOIN promotions fp ON fp.id = fps.promotion_id
   WHERE fps.shop_id = ${shopAlias}.id AND fp.target = 'sellers' AND fp.feature_shops = 1 AND ${ACTIVE('fp')}))`;

export function computeDiscount(promo, subtotal) {
  const value = Number(promo.discount_value);
  const d = promo.discount_type === 'percent' ? Math.round((subtotal * value) / 100) : value;
  return money(Math.min(d, subtotal));
}

/**
 * Vérifie un code promo pour un client et calcule la remise.
 * executor : connexion de transaction (verrouillage de l'usage) ou null.
 */
export async function resolveClientPromo(executor, userId, rawCode, subtotal) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return null;
  const run = async (sql, params) => (executor ? (await executor.query(sql, params))[0] : query(sql, params));
  const [promo] = await run(
    `SELECT p.*, pu.user_id AS eligible_user, pu.used_count,
            (p.starts_at IS NULL OR p.starts_at <= NOW()) AS started, (p.ends_at IS NULL OR p.ends_at >= NOW()) AS not_ended
       FROM promotions p LEFT JOIN promotion_users pu ON pu.promotion_id = p.id AND pu.user_id = ?
      WHERE p.code = ? AND p.target = 'clients' ${executor ? 'FOR UPDATE' : ''}`,
    [userId, code]);
  const invalid = (msg) => badRequest(msg, { promo_code: msg });
  if (!promo) throw invalid('Code promo invalide');
  if (!promo.eligible_user) throw invalid('Ce code promo ne vous est pas destiné');
  if (!promo.is_active || !promo.not_ended) throw invalid('Ce code promo a expiré');
  if (!promo.started) throw invalid('Ce code promo n’est pas encore valable');
  if (promo.used_count >= promo.max_uses_per_user) throw invalid('Vous avez déjà utilisé ce code promo');
  if (subtotal < Number(promo.min_order_amount)) {
    throw invalid(`Ce code est valable dès ${fmtPrice(promo.min_order_amount)} d’achat`);
  }
  return { promotion: promo, code, discount: computeDiscount(promo, subtotal) };
}

/** Codes promo encore utilisables par un client. */
export function userPromotions(userId) {
  return query(
    `SELECT p.id, p.code, p.title, p.description, p.discount_type, p.discount_value, p.min_order_amount, p.ends_at,
            p.max_uses_per_user - pu.used_count AS remaining_uses
       FROM promotion_users pu JOIN promotions p ON p.id = pu.promotion_id
      WHERE pu.user_id = ? AND p.target = 'clients' AND ${ACTIVE()} AND pu.used_count < p.max_uses_per_user
      ORDER BY p.ends_at IS NULL, p.ends_at`, [userId]);
}

/** Récompenses vendeur en cours pour une boutique. */
export function shopPromotions(shopId) {
  return query(
    `SELECT p.id, p.title, p.description, p.commission_rate, p.feature_shops, p.starts_at, p.ends_at
       FROM promotion_shops ps JOIN promotions p ON p.id = ps.promotion_id
      WHERE ps.shop_id = ? AND p.target = 'sellers' AND ${ACTIVE()} ORDER BY p.ends_at IS NULL, p.ends_at`, [shopId]);
}

/** Vendeurs classés par activité sur la période (hors boutique officielle). */
export function sellerAudience({ days, minOrders, minAmount }) {
  return query(
    `SELECT s.id, s.name, s.slug, s.city, s.commission_rate, CONCAT(u.first_name, ' ', u.last_name) AS owner_name, u.email,
            COUNT(DISTINCT oi.order_id) AS orders, COALESCE(SUM(oi.line_total), 0) AS revenue,
            (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id AND p.status = 'published') AS products
       FROM shops s
       JOIN users u ON u.id = s.owner_user_id
       LEFT JOIN order_items oi ON oi.shop_id = s.id
            AND oi.fulfillment_status NOT IN ('pending', 'cancelled', 'refunded')
            AND oi.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      WHERE s.status = 'approved' AND s.is_official = 0
      GROUP BY s.id
     HAVING orders >= ? AND revenue >= ?
      ORDER BY revenue DESC, orders DESC
      LIMIT 200`, [days, minOrders, minAmount]);
}

/** Clients classés par activité sur la période (commandes non annulées). */
export function clientAudience({ days, minOrders, minAmount }) {
  return query(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.phone,
            COUNT(o.id) AS orders, COALESCE(SUM(o.total_amount), 0) AS spent, MAX(o.created_at) AS last_order
       FROM users u
       JOIN orders o ON o.user_id = u.id
            AND o.status NOT IN ('pending', 'cancelled', 'refunding', 'refunded')
            AND o.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      WHERE u.status = 'active'
      GROUP BY u.id
     HAVING orders >= ? AND spent >= ?
      ORDER BY spent DESC, orders DESC
      LIMIT 500`, [days, minOrders, minAmount]);
}
