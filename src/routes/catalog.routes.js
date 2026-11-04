import { Router } from 'express';
import { pool, query, queryOne } from '../config/db.js';
import { optionalAuth } from '../middleware/auth.js';
import { notFound, ok, pageMeta, paginate } from '../utils/http.js';
import { listCards, PRODUCT_FROM, PUBLIC_WHERE, SORTS } from '../services/catalog.js';
import { getSettings } from '../services/common.js';
import { allProviders } from '../config/paymentProviders.js';
import { FEATURED_SQL } from '../services/promotions.js';
import { loadDeliveryZones, pricingRates } from '../services/pricing.js';

/** Tarifs par zone affichés aux clients (sans la clé de recherche interne). */
const publicZones = (zones) => zones.map((z) => ({
  type: z.zone_type, name: z.name, fee: z.fee == null ? null : Number(z.fee), delivers: Boolean(z.delivers),
}));

const router = Router();

router.get('/categories', async (_req, res) => {
  const rows = await query(
    `SELECT c.id, c.parent_id, c.name, c.slug, c.icon,
       (SELECT COUNT(*) FROM products p JOIN shops s ON s.id = p.shop_id
         WHERE p.category_id = c.id AND ${PUBLIC_WHERE}) AS product_count
     FROM categories c WHERE c.is_active = 1 ORDER BY c.sort_order, c.name`,
  );
  ok(res, rows);
});

/** Filtres de recherche → clause WHERE paramétrée. */
async function buildFilters(q) {
  const where = [PUBLIC_WHERE];
  const params = [];
  if (q.q) {
    where.push('(p.name LIKE ? OR p.description LIKE ? OR s.name LIKE ?)');
    const like = `%${String(q.q).trim()}%`;
    params.push(like, like, like);
  }
  if (q.category) {
    const cat = await queryOne(`SELECT id FROM categories WHERE slug = ?`, [q.category]);
    if (cat) {
      where.push('(c.id = ? OR c.parent_id = ?)');
      params.push(cat.id, cat.id);
    } else where.push('1 = 0');
  }
  if (q.audience) {
    where.push('p.audience = ?');
    params.push(q.audience);
  }
  if (q.shop) {
    where.push('s.slug = ?');
    params.push(q.shop);
  }
  if (q.size || q.color || q.in_stock === '1') {
    const sub = ["v.product_id = p.id", "v.status = 'active'"];
    if (q.size) { sub.push('v.size = ?'); params.push(q.size); }
    if (q.color) { sub.push('v.color = ?'); params.push(q.color); }
    if (q.in_stock === '1') sub.push('v.stock_quantity - v.reserved_quantity > 0');
    where.push(`EXISTS (SELECT 1 FROM product_variants v WHERE ${sub.join(' AND ')})`);
  }
  if (q.min_price) { where.push('p.min_price >= ?'); params.push(Number(q.min_price)); }
  if (q.max_price) { where.push('p.min_price <= ?'); params.push(Number(q.max_price)); }
  if (q.promo === '1') {
    where.push(`EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.compare_at_price > v.price)`);
  }
  if (q.new === '1') where.push('p.published_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)');
  return { where: where.join(' AND '), params };
}

router.get('/products', optionalAuth, async (req, res) => {
  const { page, limit, offset } = paginate(req.query, 12);
  const { where, params } = await buildFilters(req.query);
  const orderBy = SORTS[req.query.sort] || SORTS.newest;
  const [{ total }] = await query(`SELECT COUNT(*) AS total ${PRODUCT_FROM} WHERE ${where}`, params);
  const items = await listCards(where, params, { userId: req.user?.id, orderBy, limit, offset });
  ok(res, items, null, pageMeta(page, limit, total));
});

/** Valeurs disponibles pour les filtres (tailles, couleurs, prix). */
router.get('/products/filters', async (_req, res) => {
  const base = `FROM product_variants v JOIN products p ON p.id = v.product_id JOIN shops s ON s.id = p.shop_id
                WHERE v.status = 'active' AND ${PUBLIC_WHERE}`;
  const sizes = await query(`SELECT DISTINCT v.size ${base} ORDER BY FIELD(v.size,'XS','S','M','L','XL','XXL','3XL'), v.size`);
  const colors = await query(`SELECT v.color, MAX(v.color_hex) AS hex ${base} GROUP BY v.color ORDER BY v.color`);
  const [range] = await query(`SELECT MIN(v.price) AS min, MAX(v.price) AS max ${base}`);
  ok(res, { sizes: sizes.map((s) => s.size), colors, price: range });
});

router.get('/products/:idOrSlug', optionalAuth, async (req, res) => {
  const key = req.params.idOrSlug;
  const isAdminOrOwner = (p) =>
    req.user && (req.user.roles.includes('admin') || req.user.shop?.id === p.shop_id);
  const product = await queryOne(
    `SELECT p.*, s.name AS shop_name, s.slug AS shop_slug, s.logo_url AS shop_logo, s.city AS shop_city, s.is_official AS shop_official,
            s.status AS shop_status, c.name AS category_name, c.slug AS category_slug
       ${PRODUCT_FROM} WHERE ${/^\d+$/.test(key) ? 'p.id = ?' : 'p.slug = ?'}`,
    [key],
  );
  if (!product) throw notFound('Ce vêtement est introuvable');
  const visible = product.status === 'published' && product.shop_status === 'approved';
  if (!visible && !isAdminOrOwner(product)) throw notFound('Ce vêtement est introuvable');

  product.images = await query(
    `SELECT id, url, media_type, alt FROM product_images WHERE product_id = ? ORDER BY media_type = 'video', sort_order, id`, [product.id]);
  product.variants = await query(
    `SELECT id, sku, size, color, color_hex, price, compare_at_price,
            GREATEST(stock_quantity - reserved_quantity, 0) AS stock
       FROM product_variants WHERE product_id = ? AND status = 'active'
       ORDER BY FIELD(size,'XS','S','M','L','XL','XXL','3XL'), size, color`, [product.id]);
  product.reviews = await query(
    `SELECT r.id, r.rating, r.comment, r.created_at, CONCAT(u.first_name, ' ', LEFT(u.last_name, 1), '.') AS author
       FROM reviews r JOIN users u ON u.id = r.user_id
      WHERE r.product_id = ? AND r.status = 'approved' ORDER BY r.created_at DESC LIMIT 20`, [product.id]);
  product.is_favorite = req.user
    ? Boolean(await queryOne(`SELECT 1 FROM wishlist_items WHERE user_id = ? AND product_id = ?`, [req.user.id, product.id]))
    : false;
  // Vitrine d'une boutique (?scope=shop) : suggestions limitées aux articles de cette boutique
  product.similar = req.query.scope === 'shop'
    ? await listCards(`${PUBLIC_WHERE} AND p.shop_id = ? AND p.id <> ?`, [product.shop_id, product.id],
      { userId: req.user?.id, orderBy: SORTS.popular, limit: 4 })
    : await listCards(`${PUBLIC_WHERE} AND p.category_id = ? AND p.id <> ?`, [product.category_id, product.id],
      { userId: req.user?.id, orderBy: SORTS.popular, limit: 4 });
  // Livraison assurée et facturée par la boutique
  const shop = await queryOne(
    `SELECT delivery_fee_abidjan, delivery_fee_other, free_delivery_threshold, allow_shop_pickup, delivery_info FROM shops WHERE id = ?`,
    [product.shop_id]);
  product.delivery_info = {
    abidjan: Number(shop.delivery_fee_abidjan),
    other: Number(shop.delivery_fee_other),
    free_threshold: Number(shop.free_delivery_threshold),
    shop_pickup: Boolean(shop.allow_shop_pickup),
    note: shop.delivery_info,
    // Tarifs fixés par le vendeur commune par commune (Abidjan) et ville par ville
    zones: publicZones(await loadDeliveryZones(pool, product.shop_id)),
  };
  const rates = await pricingRates();
  product.payment_terms = { deposit_rate: rates.deposit, half_rate: rates.half, cash_on_delivery: rates.cashOnDelivery };
  if (visible) await query(`UPDATE products SET views_count = views_count + 1 WHERE id = ?`, [product.id]);
  delete product.moderation_note;
  ok(res, product);
});

router.get('/shops', async (req, res) => {
  const { page, limit, offset } = paginate(req.query, 12);
  const where = ["s.status = 'approved'"];
  const params = [];
  if (req.query.q) { where.push('s.name LIKE ?'); params.push(`%${req.query.q}%`); }
  if (req.query.featured === '1') where.push(FEATURED_SQL('s'));
  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM shops s WHERE ${where.join(' AND ')}`, params);
  const rows = await query(
    `SELECT s.id, s.name, s.slug, s.description, s.logo_url, s.banner_url, s.city, s.commune, s.is_official,
       ${FEATURED_SQL('s')} AS is_featured,
       (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id AND p.status = 'published') AS product_count
     FROM shops s WHERE ${where.join(' AND ')}
     ORDER BY s.is_official DESC, is_featured DESC, s.approved_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  ok(res, rows, null, pageMeta(page, limit, total));
});

router.get('/shops/:slug', async (req, res) => {
  const shop = await queryOne(
    `SELECT s.id, s.name, s.slug, s.description, s.logo_url, s.banner_url, s.city, s.commune, s.created_at, s.is_official,
       s.delivery_fee_abidjan, s.delivery_fee_other, s.free_delivery_threshold, s.allow_shop_pickup, s.delivery_info,
       (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id AND p.status = 'published') AS product_count,
       (SELECT ROUND(AVG(p.rating_avg), 1) FROM products p WHERE p.shop_id = s.id AND p.rating_count > 0) AS rating,
       (SELECT COALESCE(SUM(p.rating_count), 0) FROM products p WHERE p.shop_id = s.id AND p.status = 'published') AS review_count
     FROM shops s WHERE s.slug = ? AND s.status = 'approved'`,
    [req.params.slug],
  );
  if (!shop) throw notFound('Boutique introuvable');
  shop.delivery_zones = publicZones(await loadDeliveryZones(pool, shop.id));
  ok(res, shop);
});

router.get('/shops/:slug/products', optionalAuth, async (req, res) => {
  const { page, limit, offset } = paginate(req.query, 12);
  const { where, params } = await buildFilters({ ...req.query, shop: req.params.slug });
  const [{ total }] = await query(`SELECT COUNT(*) AS total ${PRODUCT_FROM} WHERE ${where}`, params);
  const items = await listCards(where, params, {
    userId: req.user?.id, orderBy: SORTS[req.query.sort] || SORTS.newest, limit, offset,
  });
  ok(res, items, null, pageMeta(page, limit, total));
});

/** Données agrégées de la page d'accueil (web et mobile). */
router.get('/home', optionalAuth, async (req, res) => {
  const userId = req.user?.id;
  const [categories, newest, popular, promos, featured, shops] = await Promise.all([
    query(`SELECT id, name, slug, icon FROM categories WHERE is_active = 1 AND parent_id IS NULL ORDER BY sort_order LIMIT 10`),
    listCards(PUBLIC_WHERE, [], { userId, orderBy: SORTS.newest, limit: 8 }),
    listCards(PUBLIC_WHERE, [], { userId, orderBy: SORTS.popular, limit: 8 }),
    listCards(`${PUBLIC_WHERE} AND EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.compare_at_price > v.price)`,
      [], { userId, orderBy: SORTS.newest, limit: 8 }),
    listCards(`${PUBLIC_WHERE} AND p.is_featured = 1`, [], { userId, orderBy: SORTS.newest, limit: 8 }),
    query(`SELECT s.id, s.name, s.slug, s.logo_url, s.city, s.description, s.is_official FROM shops s WHERE s.status = 'approved'
           ORDER BY s.is_official DESC, ${FEATURED_SQL('s')} DESC, s.approved_at DESC LIMIT 6`),
  ]);
  ok(res, { categories, newest, popular, promos, featured, shops });
});

router.get('/settings/public', async (_req, res) => {
  const s = await getSettings();
  const rates = await pricingRates();
  ok(res, {
    // Modèle : frais plateforme ajoutés au prix ; paiement total, moitié, ou acompte pour le paiement à la livraison
    platform_fee_rate: rates.fee,
    seller_commission_rate: rates.sellerCommission,
    deposit_rate: rates.deposit,
    half_payment_rate: rates.half,
    cash_on_delivery: rates.cashOnDelivery,
    // En mode Jèko, seuls les quatre opérateurs Mobile Money sont proposés
    payment_methods: (s.payment_methods || '').split(',')
      .filter((m) => m && m !== 'cash_on_delivery' && (process.env.PAYMENT_MODE !== 'jeko' || m !== 'card')),
    // Libellés, couleurs et logos officiels de tous les moyens de paiement / reversement
    payment_providers: allProviders(),
    payment_mode: process.env.PAYMENT_MODE || 'sandbox',
    contact_phone: s.contact_phone,
    contact_email: s.contact_email,
    // Liens de partage avec aperçu (image, nom) sur WhatsApp / Facebook : servis par l'API (/partage/...)
    share_base_url: (process.env.SHARE_BASE_URL || process.env.API_PUBLIC_URL || '').replace(/\/$/, ''),
  });
});

export default router;
