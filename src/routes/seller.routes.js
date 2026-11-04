import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction } from '../config/db.js';
import { requireApprovedSeller, requireAuth, loadUser } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { toCloud, upload } from '../middleware/upload.js';
import { destroyByUrl, destroyMedia } from '../services/storage.js';
import { shopPromotions } from '../services/promotions.js';
import { badRequest, conflict, created, notFound, ok, pageMeta, paginate } from '../utils/http.js';
import { money, price, publicFileUrl, randomCode, slugify } from '../utils/helpers.js';
import { audit, getSetting, notify, notifyAdmins, roleId } from '../services/common.js';
import { refreshMinPrice } from '../services/catalog.js';
import {
  creditSellerOnDelivery, markBalanceCollected, ORDER_STATUS_LABELS, recomputeOrderStatus, SELLER_TRANSITIONS,
} from '../services/orders.js';
import { isAbidjan, pricingRates, withFee, zoneKey } from '../services/pricing.js';

const router = Router();
router.use(requireAuth);

const phone = z.string().trim().regex(/^\+?[0-9 ]{8,20}$/, 'Téléphone invalide');

// =====================================================================
// Demande d'ouverture de boutique (« Je veux vendre sur Ivoire Style »)
// =====================================================================
const applySchema = z.object({
  shop_name: z.string().trim().min(3, 'Nom commercial requis (3 caractères min.)').max(120),
  responsible_name: z.string().trim().min(3, 'Nom du responsable requis').max(160),
  phone,
  email: z.string().trim().toLowerCase().email('E-mail invalide'),
  city: z.string().trim().min(2, 'Ville requise').max(80),
  commune: z.string().trim().max(80).optional(),
  address: z.string().trim().max(255).optional(),
  description: z.string().trim().min(20, 'Présentez votre boutique (20 caractères min.)').max(2000),
  rccm: z.string().trim().max(80).optional(),
  payout_method: z.enum(['orange_money', 'mtn_momo', 'wave', 'moov_money', 'bank'], { message: 'Choisissez un mode de reversement' }),
  payout_account: z.string().trim().min(6, 'Numéro de reversement requis').max(60),
  payout_holder: z.string().trim().max(120).optional(),
  accept_terms: z.preprocess((v) => v === true || v === 'true' || v === '1', z.literal(true, { message: 'Vous devez accepter les conditions vendeurs' })),
});

router.post('/apply',
  upload.fields([{ name: 'logo', maxCount: 1 }, { name: 'document', maxCount: 1 }]),
  validate(applySchema),
  // Contrôles avant tout envoi vers Cloudinary
  (req, _res, next) => {
    const existing = req.user.shop;
    if (existing && existing.status !== 'rejected') {
      throw conflict(existing.status === 'pending'
        ? 'Votre demande est déjà en cours de validation'
        : 'Vous possédez déjà une boutique');
    }
    if (!req.files?.document?.[0] && !existing) {
      throw badRequest('Pièce justificative requise', { document: 'Ajoutez une pièce d’identité ou un RCCM' });
    }
    next();
  },
  toCloud({ logo: 'shops', document: 'documents' }),
  async (req, res) => {
    const d = req.valid;
    const existing = req.user.shop;
    const logo = publicFileUrl(req.files?.logo?.[0]);
    const doc = req.files?.document?.[0];

    let slug = slugify(d.shop_name);
    const clash = await queryOne(`SELECT id FROM shops WHERE slug = ? AND owner_user_id <> ?`, [slug, req.user.id]);
    if (clash) slug = `${slug}-${randomCode(4).toLowerCase()}`;
    // Pas de commission vendeur : la plateforme se rémunère par les frais ajoutés au prix client
    const rate = 0;

    const shopId = await transaction(async (conn) => {
      let id = existing?.id;
      const fields = [d.shop_name, slug, d.responsible_name, d.description, d.phone.replace(/\s+/g, ''), d.email,
        d.city, d.commune || null, d.address || null, d.rccm || null, d.payout_method, d.payout_account];
      if (existing) {
        await conn.query(
          `UPDATE shops SET name = ?, slug = ?, responsible_name = ?, description = ?, phone = ?, email = ?, city = ?,
             commune = ?, address = ?, rccm = ?, payout_method = ?, payout_account = ?, logo_url = COALESCE(?, logo_url),
             status = 'pending', rejection_reason = NULL WHERE id = ?`,
          [...fields, logo, id]);
      } else {
        const [r] = await conn.query(
          `INSERT INTO shops (name, slug, responsible_name, description, phone, email, city, commune, address, rccm,
             payout_method, payout_account, logo_url, owner_user_id, commission_rate, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
          [...fields, logo, req.user.id, rate]);
        id = r.insertId;
      }
      if (doc) {
        await conn.query(
          `INSERT INTO seller_documents (shop_id, doc_type, file_path, original_name, mime_type) VALUES (?, ?, ?, ?, ?)`,
          [id, d.rccm ? 'rccm' : 'piece_identite', doc.cloud.public_id, doc.originalname.slice(0, 255), doc.mimetype]);
      }
      await conn.query(`UPDATE shops SET payout_holder = ? WHERE id = ?`, [d.payout_holder || d.responsible_name, id]);
      await conn.query(
        `INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, 'seller', ?, ?, '/vendeur')`,
        [req.user.id, 'Demande vendeur reçue', 'Notre équipe vérifie votre boutique. Vous serez notifié de la décision.']);
      return id;
    });
    if (logo && existing?.logo_url) await destroyByUrl(existing.logo_url);
    await notifyAdmins({ type: 'seller_request', title: 'Nouvelle demande vendeur', body: d.shop_name, link: '/admin/boutiques' });
    await audit(req, 'seller.apply', 'shop', shopId);
    created(res, { user: await loadUser(req.user.id) },
      'Demande envoyée ! Votre boutique sera activée après validation par notre équipe.');
  });

router.get('/shop', async (req, res) => {
  if (!req.user.shop) return ok(res, null);
  ok(res, await queryOne(`SELECT * FROM shops WHERE id = ?`, [req.user.shop.id]));
});

// ---------------- Les routes suivantes exigent une boutique validée ----------------
router.use(requireApprovedSeller);

router.patch('/shop',
  upload.fields([{ name: 'logo', maxCount: 1 }, { name: 'banner', maxCount: 1 }]),
  validate(z.object({
    description: z.string().trim().min(20, '20 caractères minimum').max(2000),
    phone,
    email: z.string().trim().toLowerCase().email('E-mail invalide'),
    city: z.string().trim().min(2).max(80),
    commune: z.string().trim().max(80).optional(),
    address: z.string().trim().max(255).optional(),
    // Recevoir mon argent
    payout_method: z.enum(['orange_money', 'mtn_momo', 'wave', 'moov_money', 'bank'], { message: 'Choisissez un moyen de reversement' }),
    payout_account: z.string().trim().min(6, 'Numéro ou compte requis').max(60),
    payout_holder: z.string().trim().min(3, 'Nom du titulaire requis').max(120),
    // Livraison gérée par le vendeur
    delivery_fee_abidjan: z.coerce.number().min(0, 'Montant invalide').max(1_000_000),
    delivery_fee_other: z.coerce.number().min(0, 'Montant invalide').max(1_000_000),
    free_delivery_threshold: z.coerce.number().min(0).max(100_000_000).default(0),
    allow_shop_pickup: z.preprocess((v) => v === true || v === 'true' || v === '1', z.boolean()),
    delivery_info: z.string().trim().max(500).optional(),
  })),
  toCloud({ logo: 'shops', banner: 'shops' }),
  async (req, res) => {
    const d = req.valid;
    const before = await queryOne(`SELECT logo_url, banner_url FROM shops WHERE id = ?`, [req.shopId]);
    await query(
      `UPDATE shops SET description = ?, phone = ?, email = ?, city = ?, commune = ?, address = ?, payout_method = ?,
         payout_account = ?, payout_holder = ?, delivery_fee_abidjan = ?, delivery_fee_other = ?, free_delivery_threshold = ?,
         allow_shop_pickup = ?, delivery_info = ?, logo_url = COALESCE(?, logo_url), banner_url = COALESCE(?, banner_url) WHERE id = ?`,
      [d.description, d.phone.replace(/\s+/g, ''), d.email, d.city, d.commune || null, d.address || null, d.payout_method,
        d.payout_account, d.payout_holder, d.delivery_fee_abidjan, d.delivery_fee_other, d.free_delivery_threshold,
        d.allow_shop_pickup ? 1 : 0, d.delivery_info || null,
        publicFileUrl(req.files?.logo?.[0]), publicFileUrl(req.files?.banner?.[0]), req.shopId]);
    // Les anciens visuels remplacés sont supprimés de Cloudinary
    if (req.files?.logo?.[0]) await destroyByUrl(before.logo_url);
    if (req.files?.banner?.[0]) await destroyByUrl(before.banner_url);
    ok(res, await queryOne(`SELECT * FROM shops WHERE id = ?`, [req.shopId]), 'Boutique mise à jour');
  });

// =====================================================================
// Tarifs de livraison par commune d'Abidjan et par ville
// =====================================================================
router.get('/delivery-zones', async (req, res) => {
  const zones = await query(
    `SELECT zone_type, name, fee, delivers FROM shop_delivery_zones WHERE shop_id = ? ORDER BY zone_type, name`, [req.shopId]);
  ok(res, zones.map((z) => ({ ...z, fee: z.fee == null ? null : Number(z.fee), delivers: Boolean(z.delivers) })));
});

/** Remplace l'ensemble des tarifs par zone (fee vide = tarif par défaut ; delivers faux = zone non desservie). */
router.put('/delivery-zones', validate(z.object({
  zones: z.array(z.object({
    zone_type: z.enum(['commune', 'city']),
    name: z.string().trim().min(2, 'Nom de zone requis').max(80),
    fee: z.preprocess((v) => (v === '' || v === undefined ? null : v), z.coerce.number().min(0, 'Montant invalide').max(1_000_000).nullable()),
    delivers: z.coerce.boolean().default(true),
  })).max(300, '300 zones maximum'),
})), async (req, res) => {
  // Seules les zones utiles sont gardées : un tarif propre, ou « je ne livre pas »
  const seen = new Set();
  const zones = req.valid.zones.filter((zn) => zn.fee != null || !zn.delivers).filter((zn) => {
    const key = `${zn.zone_type}:${zoneKey(zn.name)}`;
    if (!zoneKey(zn.name) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Ville « Abidjan » : ses tarifs se règlent commune par commune
  if (zones.some((zn) => zn.zone_type === 'city' && isAbidjan(zn.name))) {
    throw badRequest('Pour Abidjan, indiquez les tarifs commune par commune', { zones: 'Abidjan se règle par commune' });
  }
  await transaction(async (conn) => {
    await conn.query(`DELETE FROM shop_delivery_zones WHERE shop_id = ?`, [req.shopId]);
    for (const zn of zones) {
      await conn.query(
        `INSERT INTO shop_delivery_zones (shop_id, zone_type, name, name_key, fee, delivers) VALUES (?, ?, ?, ?, ?, ?)`,
        [req.shopId, zn.zone_type, zn.name, zoneKey(zn.name), zn.fee, zn.delivers ? 1 : 0]);
    }
  });
  await audit(req, 'shop.delivery_zones', 'shop', req.shopId, { count: zones.length });
  ok(res, zones, zones.length ? `Tarifs de livraison enregistrés (${zones.length} zone(s))` : 'Tarifs par zone retirés : vos tarifs par défaut s’appliquent');
});

router.get('/dashboard', async (req, res) => {
  const id = req.shopId;
  const sales = await queryOne(
    // Ventes au prix du vendeur (les frais plateforme sont payés par le client en plus)
    `SELECT COALESCE(SUM(oi.seller_amount), 0) AS gross, COUNT(DISTINCT oi.order_id) AS orders
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.shop_id = ? AND oi.fulfillment_status NOT IN ('pending','cancelled')`, [id]);
  const byStatus = await query(
    `SELECT fulfillment_status AS status, COUNT(*) AS n FROM order_items WHERE shop_id = ? GROUP BY fulfillment_status`, [id]);
  const products = await queryOne(
    `SELECT SUM(status = 'published') AS published, SUM(status = 'pending') AS pending, COUNT(*) AS total
       FROM products WHERE shop_id = ?`, [id]);
  const lowStock = await query(
    `SELECT v.id, v.sku, v.size, v.color, v.stock_quantity, p.id AS product_id, p.name
       FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE p.shop_id = ? AND v.status = 'active' AND p.status <> 'disabled' AND v.stock_quantity <= ?
      ORDER BY v.stock_quantity LIMIT 10`, [id, Number(await getSetting('low_stock_threshold', 3))]);
  const fin = await queryOne(`SELECT COALESCE(SUM(amount), 0) AS balance FROM seller_ledger_entries WHERE shop_id = ?`, [id]);
  // Soldes que le vendeur doit encaisser lui-même à la livraison (commandes en cours)
  const toCollect = await queryOne(
    `SELECT COALESCE(SUM(balance_amount), 0) AS amount, COUNT(*) AS n FROM orders
      WHERE shop_id = ? AND balance_amount > 0 AND balance_paid_at IS NULL AND status IN ('confirmed','preparing','ready','shipped','in_delivery')`, [id]);
  const shopInfo = await queryOne(`SELECT payout_method, payout_account, payout_holder, slug FROM shops WHERE id = ?`, [id]);
  const paid = await queryOne(
    `SELECT COALESCE(SUM(amount), 0) AS paid, COALESCE(SUM(CASE WHEN status = 'pending' THEN amount END), 0) AS pending_payouts
       FROM seller_payouts WHERE shop_id = ?`, [id]);
  const salesByDay = await query(
    `SELECT DATE(o.created_at) AS day, SUM(oi.seller_amount) AS total
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.shop_id = ? AND oi.fulfillment_status NOT IN ('pending','cancelled') AND o.created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
      GROUP BY DATE(o.created_at) ORDER BY day`, [id]);
  const recent = await query(
    `SELECT oi.id, oi.product_name, oi.size, oi.color, oi.quantity, oi.seller_amount AS line_total, oi.fulfillment_status, o.order_number, o.created_at
       FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.shop_id = ? ORDER BY oi.id DESC LIMIT 6`, [id]);
  const statusMap = Object.fromEntries(byStatus.map((s) => [s.status, s.n]));
  ok(res, {
    gross_sales: Number(sales.gross),
    orders_count: Number(sales.orders),
    orders_by_status: statusMap,
    to_prepare: (statusMap.confirmed || 0) + (statusMap.preparing || 0),
    products: { published: Number(products.published || 0), pending: Number(products.pending || 0), total: Number(products.total) },
    low_stock: lowStock,
    to_collect: Number(toCollect.amount),
    to_collect_orders: toCollect.n,
    payout_ready: Boolean(shopInfo.payout_method && shopInfo.payout_account && shopInfo.payout_holder),
    paid_out: Number(paid.paid),
    pending_payouts: Number(paid.pending_payouts),
    balance: money(Number(fin.balance) - Number(paid.paid)),
    sales_by_day: salesByDay,
    recent_items: recent,
    promotions: await shopPromotions(id),
  });
});

// =====================================================================
// Produits
// =====================================================================
router.get('/products', async (req, res) => {
  const { page, limit, offset } = paginate(req.query, 20);
  const where = ['p.shop_id = ?'];
  const params = [req.shopId];
  if (req.query.status) { where.push('p.status = ?'); params.push(req.query.status); }
  if (req.query.q) { where.push('p.name LIKE ?'); params.push(`%${req.query.q}%`); }
  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM products p WHERE ${where.join(' AND ')}`, params);
  const rows = await query(
    `SELECT p.id, p.name, p.slug, p.status, p.moderation_note, p.min_price AS price, p.sales_count, p.created_at,
       c.name AS category_name,
       (SELECT url FROM product_images pi WHERE pi.product_id = p.id AND pi.media_type = 'image' ORDER BY pi.sort_order, pi.id LIMIT 1) AS image,
       (SELECT COALESCE(SUM(stock_quantity), 0) FROM product_variants v WHERE v.product_id = p.id AND v.status = 'active') AS stock,
       (SELECT COUNT(*) FROM product_variants v WHERE v.product_id = p.id AND v.status = 'active') AS variant_count
     FROM products p JOIN categories c ON c.id = p.category_id
     WHERE ${where.join(' AND ')} ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  ok(res, rows, null, pageMeta(page, limit, total));
});

async function ownProduct(req, id = req.params.id) {
  const p = await queryOne(`SELECT * FROM products WHERE id = ? AND shop_id = ?`, [id, req.shopId]);
  if (!p) throw notFound('Produit introuvable');
  return p;
}

router.get('/products/:id', async (req, res) => {
  const p = await ownProduct(req);
  p.images = await query(`SELECT id, url, media_type, alt, sort_order FROM product_images WHERE product_id = ? ORDER BY sort_order, id`, [p.id]);
  // price / compare_at_price renvoyés = prix VENDEUR (saisis dans le formulaire) ; client_price = prix affiché au client
  p.variants = (await query(`SELECT * FROM product_variants WHERE product_id = ? AND status = 'active' ORDER BY id`, [p.id]))
    .map((v) => ({
      ...v, client_price: v.price, client_compare_at_price: v.compare_at_price,
      price: v.seller_price ?? v.price, compare_at_price: v.seller_compare_at_price ?? v.compare_at_price,
    }));
  p.platform_fee_rate = (await pricingRates()).fee;
  ok(res, p);
});

const variantSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  size: z.string().trim().min(1, 'Taille requise').max(20),
  color: z.string().trim().min(1, 'Couleur requise').max(40),
  color_hex: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable(),
  price: z.coerce.number().positive('Prix invalide').max(100_000_000),
  compare_at_price: z.coerce.number().nonnegative().optional().nullable(),
  stock_quantity: z.coerce.number().int().min(0, 'Stock invalide').max(100000),
});

const productSchema = z.object({
  name: z.string().trim().min(3, 'Nom requis (3 caractères min.)').max(160),
  category_id: z.coerce.number({ message: 'Catégorie requise' }).int().positive('Catégorie requise'),
  description: z.string().trim().min(20, 'Description requise (20 caractères min.)').max(5000),
  audience: z.enum(['homme', 'femme', 'enfant', 'bebe', 'unisexe']),
  material: z.string().trim().max(120).optional(),
  fit: z.string().trim().max(80).optional(),
  care: z.string().trim().max(255).optional(),
  origin: z.string().trim().max(80).optional(),
  size_guide: z.string().trim().max(2000).optional(),
  variants: z.preprocess((v) => (typeof v === 'string' ? JSON.parse(v) : v),
    z.array(variantSchema).min(1, 'Ajoutez au moins une variante (taille / couleur)').max(60)),
  remove_image_ids: z.preprocess((v) => (typeof v === 'string' ? JSON.parse(v || '[]') : v ?? []),
    z.array(z.coerce.number().int())).optional(),
  submit: z.preprocess((v) => v !== 'false' && v !== false, z.boolean()).default(true),
});

function checkVariants(variants) {
  const keys = new Set();
  for (const v of variants) {
    const k = `${v.size.toLowerCase()}|${v.color.toLowerCase()}`;
    if (keys.has(k)) throw badRequest(`Variante en double : ${v.size} / ${v.color}`);
    keys.add(k);
    if (v.compare_at_price && v.compare_at_price <= v.price) {
      throw badRequest('Le prix barré doit être supérieur au prix de vente');
    }
  }
}

/**
 * Variantes : le vendeur saisit SON prix (v.price) ; le prix affiché au client est ce prix + frais plateforme.
 */
async function saveVariants(conn, productId, shopId, variants, userId) {
  const { fee } = await pricingRates();
  const [current] = await conn.query(`SELECT id, stock_quantity FROM product_variants WHERE product_id = ?`, [productId]);
  const currentMap = new Map(current.map((v) => [v.id, v]));
  const kept = new Set();
  for (const v of variants) {
    const prices = [v.price, v.compare_at_price || null, withFee(v.price, fee), v.compare_at_price ? withFee(v.compare_at_price, fee) : null];
    if (v.id && currentMap.has(v.id)) {
      kept.add(v.id);
      const diff = v.stock_quantity - currentMap.get(v.id).stock_quantity;
      await conn.query(
        `UPDATE product_variants SET size = ?, color = ?, color_hex = ?, seller_price = ?, seller_compare_at_price = ?, price = ?,
           compare_at_price = ?, stock_quantity = ?, status = 'active' WHERE id = ?`,
        [v.size, v.color, v.color_hex || null, ...prices, v.stock_quantity, v.id]);
      if (diff !== 0) {
        await conn.query(`INSERT INTO inventory_movements (variant_id, quantity, reason, created_by) VALUES (?, ?, 'adjustment', ?)`,
          [v.id, diff, userId]);
      }
    } else {
      const sku = `IVS-${shopId}-${productId}-${slugify(v.size)}-${slugify(v.color)}-${randomCode(3)}`.toUpperCase().slice(0, 80);
      const [r] = await conn.query(
        `INSERT INTO product_variants (product_id, sku, size, color, color_hex, seller_price, seller_compare_at_price, price,
           compare_at_price, stock_quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [productId, sku, v.size, v.color, v.color_hex || null, ...prices, v.stock_quantity]);
      if (v.stock_quantity > 0) {
        await conn.query(`INSERT INTO inventory_movements (variant_id, quantity, reason, created_by) VALUES (?, ?, 'initial', ?)`,
          [r.insertId, v.stock_quantity, userId]);
      }
    }
  }
  // Variantes retirées : désactivées (conservées pour l'historique des commandes)
  for (const v of current) {
    if (!kept.has(v.id)) await conn.query(`UPDATE product_variants SET status = 'inactive' WHERE id = ?`, [v.id]);
  }
  await refreshMinPrice(productId, conn);
}

/** Statut d'un produit enregistré : la boutique officielle (super admin) publie sans modération. */
async function targetStatus(submit, req) {
  if (!submit) return 'draft';
  if (req.user.shop?.is_official) return 'published';
  return String(await getSetting('product_moderation', '1')) === '1' ? 'pending' : 'published';
}

const MAX_MEDIA = 8;
const MAX_VIDEOS = 2;
const isImageFile = (f) => f.mimetype.startsWith('image/');

async function insertMedia(conn, productId, files, alt, startOrder) {
  let order = startOrder;
  for (const f of files) {
    await conn.query(
      `INSERT INTO product_images (product_id, url, public_id, media_type, alt, sort_order) VALUES (?, ?, ?, ?, ?, ?)`,
      [productId, f.cloud.url, f.cloud.public_id, f.cloud.media_type, alt, order++]);
  }
}

/** Contrôles des médias d'un produit avant envoi vers Cloudinary (existing : médias conservés). */
function checkMedia(files, existing, submit) {
  const all = [...existing.map((m) => m.media_type), ...files.map((f) => (isImageFile(f) ? 'image' : 'video'))];
  if (all.length > MAX_MEDIA) throw badRequest(`${MAX_MEDIA} photos et vidéos maximum`, { images: `${MAX_MEDIA} médias maximum` });
  if (all.filter((t) => t === 'video').length > MAX_VIDEOS) {
    throw badRequest(`${MAX_VIDEOS} vidéos maximum par vêtement`, { images: `${MAX_VIDEOS} vidéos maximum` });
  }
  if (submit && !all.includes('image')) throw badRequest('Ajoutez au moins une photo', { images: 'Ajoutez au moins une photo' });
}

router.post('/products', upload.array('images', MAX_MEDIA), validate(productSchema), async (req, _res, next) => {
  const d = req.valid;
  checkVariants(d.variants);
  const cat = await queryOne(`SELECT id FROM categories WHERE id = ? AND is_active = 1`, [d.category_id]);
  if (!cat) throw badRequest('Catégorie invalide', { category_id: 'Catégorie invalide' });
  checkMedia(req.files || [], [], d.submit);
  next();
}, toCloud({ images: 'products' }), async (req, res) => {
  const d = req.valid;
  const status = await targetStatus(d.submit, req);
  const productId = await transaction(async (conn) => {
    const slug = `${slugify(d.name)}-${randomCode(5).toLowerCase()}`;
    const [r] = await conn.query(
      `INSERT INTO products (shop_id, category_id, name, slug, description, audience, material, fit, care, origin, size_guide,
         status, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.shopId, d.category_id, d.name, slug, d.description, d.audience, d.material || null, d.fit || null,
        d.care || null, d.origin || null, d.size_guide || null, status, status === 'published' ? new Date() : null]);
    await insertMedia(conn, r.insertId, req.files || [], d.name, 0);
    await saveVariants(conn, r.insertId, req.shopId, d.variants, req.user.id);
    return r.insertId;
  });
  if (status === 'pending') {
    await notifyAdmins({ type: 'moderation', title: 'Produit à modérer', body: d.name, link: '/admin/produits' });
  }
  const msg = status === 'pending' ? 'Produit enregistré et envoyé en validation'
    : status === 'published' ? 'Produit publié avec succès' : 'Brouillon enregistré';
  created(res, { id: productId, status }, msg);
});

router.put('/products/:id', upload.array('images', MAX_MEDIA), validate(productSchema), async (req, _res, next) => {
  req.product = await ownProduct(req);
  checkVariants(req.valid.variants);
  const removed = new Set(req.valid.remove_image_ids || []);
  const kept = (await query(`SELECT id, media_type FROM product_images WHERE product_id = ?`, [req.product.id]))
    .filter((m) => !removed.has(m.id));
  checkMedia(req.files || [], kept, req.valid.submit);
  next();
}, toCloud({ images: 'products' }), async (req, res) => {
  const p = req.product;
  const d = req.valid;
  const toDelete = d.remove_image_ids?.length
    ? await query(`SELECT public_id, media_type FROM product_images WHERE product_id = ? AND id IN (?)`, [p.id, d.remove_image_ids])
    : [];
  // Toute modification d'un produit publié repasse en modération si elle est active
  const status = p.status === 'disabled' ? 'disabled' : await targetStatus(d.submit, req);
  await transaction(async (conn) => {
    await conn.query(
      `UPDATE products SET category_id = ?, name = ?, description = ?, audience = ?, material = ?, fit = ?, care = ?,
         origin = ?, size_guide = ?, status = ?, moderation_note = NULL,
         published_at = IF(? = 'published' AND published_at IS NULL, NOW(), published_at) WHERE id = ?`,
      [d.category_id, d.name, d.description, d.audience, d.material || null, d.fit || null, d.care || null,
        d.origin || null, d.size_guide || null, status, status, p.id]);
    if (d.remove_image_ids?.length) {
      await conn.query(`DELETE FROM product_images WHERE product_id = ? AND id IN (?)`, [p.id, d.remove_image_ids]);
    }
    const [[{ maxOrder }]] = await conn.query(`SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM product_images WHERE product_id = ?`, [p.id]);
    await insertMedia(conn, p.id, req.files || [], d.name, maxOrder + 1);
    await saveVariants(conn, p.id, req.shopId, d.variants, req.user.id);
  });
  // Médias retirés : supprimés de Cloudinary une fois la modification enregistrée
  for (const m of toDelete) await destroyMedia(m.public_id, m.media_type);
  ok(res, { id: p.id, status }, status === 'pending' ? 'Modifications enregistrées et envoyées en validation' : 'Produit mis à jour');
});

router.patch('/products/:id/status', validate(z.object({ status: z.enum(['disabled', 'active']) })), async (req, res) => {
  const p = await ownProduct(req);
  let status = 'disabled';
  if (req.valid.status === 'active') {
    status = p.published_at && p.status === 'disabled' && String(await getSetting('product_moderation', '1')) !== '1'
      ? 'published' : await targetStatus(true, req);
  }
  await query(`UPDATE products SET status = ? WHERE id = ?`, [status, p.id]);
  ok(res, { id: p.id, status }, status === 'disabled' ? 'Produit désactivé' : 'Produit réactivé');
});

router.patch('/variants/:id/stock', validate(z.object({ stock_quantity: z.coerce.number().int().min(0).max(100000) })), async (req, res) => {
  const v = await queryOne(
    `SELECT v.id, v.stock_quantity FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ? AND p.shop_id = ?`,
    [req.params.id, req.shopId]);
  if (!v) throw notFound('Variante introuvable');
  const diff = req.valid.stock_quantity - v.stock_quantity;
  await transaction(async (conn) => {
    await conn.query(`UPDATE product_variants SET stock_quantity = ? WHERE id = ?`, [req.valid.stock_quantity, v.id]);
    if (diff) await conn.query(`INSERT INTO inventory_movements (variant_id, quantity, reason, created_by) VALUES (?, ?, 'adjustment', ?)`, [v.id, diff, req.user.id]);
  });
  ok(res, { id: v.id, stock_quantity: req.valid.stock_quantity }, 'Stock mis à jour');
});

// =====================================================================
// Commandes (le vendeur ne voit que les lignes de sa boutique)
// =====================================================================
router.get('/orders', async (req, res) => {
  const { page, limit, offset } = paginate(req.query, 15);
  const where = ['oi.shop_id = ?', "oi.fulfillment_status <> 'pending'"];
  const params = [req.shopId];
  if (req.query.status) { where.push('oi.fulfillment_status = ?'); params.push(req.query.status); }
  const [{ total }] = await query(`SELECT COUNT(DISTINCT oi.order_id) AS total FROM order_items oi WHERE ${where.join(' AND ')}`, params);
  const orders = await query(
    `SELECT o.id, o.order_number, o.created_at, o.payment_method, o.payment_status, o.payment_plan, o.delivery_mode,
            o.delivery_fee, o.total_amount, o.upfront_amount, o.balance_amount, o.balance_paid_at, o.discount_total, o.platform_fee,
            o.ship_recipient, o.ship_phone, o.ship_city, o.ship_commune, o.ship_district, o.ship_street, o.ship_instructions
       FROM orders o WHERE o.id IN (SELECT DISTINCT oi.order_id FROM order_items oi WHERE ${where.join(' AND ')})
      ORDER BY o.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  if (orders.length) {
    const items = await query(
      `SELECT oi.* FROM order_items oi WHERE oi.shop_id = ? AND oi.order_id IN (?) ORDER BY oi.id`,
      [req.shopId, orders.map((o) => o.id)]);
    for (const o of orders) {
      o.items = items.filter((i) => i.order_id === o.id).map((i) => ({ ...i, next_statuses: SELLER_TRANSITIONS[i.fulfillment_status] || [] }));
      o.shop_total = money(o.items.reduce((s, i) => s + Number(i.line_total), 0));
      // Ce que le vendeur touche : son prix + sa livraison (une partie via la plateforme, le solde en main propre)
      o.seller_amount = money(o.items.reduce((s, i) => s + Number(i.seller_amount), 0) + Number(o.delivery_fee));
      o.balance_due = Number(o.balance_amount) > 0 && !o.balance_paid_at ? Number(o.balance_amount) : 0;
    }
  }
  ok(res, orders, null, pageMeta(page, limit, total));
});

router.patch('/order-items/:id/status', validate(z.object({
  status: z.enum(['preparing', 'ready', 'shipped', 'in_delivery', 'delivered']),
  carrier: z.string().trim().max(80).optional(),
  tracking_number: z.string().trim().max(80).optional(),
  apply_to_order: z.coerce.boolean().default(true),
  // À la livraison : le vendeur confirme avoir encaissé le solde (moitié restante ou 90 % du paiement à la livraison)
  balance_collected: z.coerce.boolean().default(false),
})), async (req, res) => {
  const d = req.valid;
  const item = await queryOne(`SELECT * FROM order_items WHERE id = ? AND shop_id = ?`, [req.params.id, req.shopId]);
  if (!item) throw notFound('Ligne de commande introuvable');
  const ord = await queryOne(`SELECT balance_amount, balance_paid_at FROM orders WHERE id = ?`, [item.order_id]);
  const balanceDue = Number(ord.balance_amount) > 0 && !ord.balance_paid_at;
  if (d.status === 'delivered' && balanceDue && !d.balance_collected) {
    throw badRequest(`Confirmez l’encaissement du solde de ${price(ord.balance_amount)} auprès du client`,
      { balance_collected: 'Solde à encaisser' });
  }
  await transaction(async (conn) => {
    // Applique la transition à toutes les lignes de la boutique dans cette commande ayant le même statut
    const [lines] = await conn.query(
      `SELECT * FROM order_items WHERE order_id = ? AND shop_id = ? AND ${d.apply_to_order ? 'fulfillment_status = ?' : 'id = ?'} FOR UPDATE`,
      [item.order_id, req.shopId, d.apply_to_order ? item.fulfillment_status : item.id]);
    for (const line of lines) {
      const allowed = SELLER_TRANSITIONS[line.fulfillment_status] || [];
      if (!allowed.includes(d.status)) {
        throw badRequest(`Transition impossible : ${ORDER_STATUS_LABELS[line.fulfillment_status]} → ${ORDER_STATUS_LABELS[d.status]}`);
      }
      await conn.query(
        `UPDATE order_items SET fulfillment_status = ?, carrier = COALESCE(?, carrier), tracking_number = COALESCE(?, tracking_number),
           shipped_at = IF(? = 'shipped', NOW(), shipped_at), delivered_at = IF(? = 'delivered', NOW(), delivered_at) WHERE id = ?`,
        [d.status, d.carrier || null, d.tracking_number || null, d.status, d.status, line.id]);
      await conn.query(
        `INSERT INTO order_status_history (order_id, order_item_id, status, comment, changed_by) VALUES (?, ?, ?, ?, ?)`,
        [line.order_id, line.id, d.status, `${line.product_name} : ${ORDER_STATUS_LABELS[d.status]}`, req.user.id]);
    }
    if (d.status === 'delivered') {
      if (balanceDue) await markBalanceCollected(conn, item.order_id, req.user.id);
      await creditSellerOnDelivery(conn, item.order_id);
    }
    if (d.status === 'shipped') {
      await conn.query(`INSERT INTO shipments (order_id, shop_id, carrier, tracking_number, status, shipped_at) VALUES (?, ?, ?, ?, 'shipped', NOW())`,
        [item.order_id, req.shopId, d.carrier || null, d.tracking_number || null]);
    }
    await recomputeOrderStatus(conn, item.order_id, req.user.id);
    const [[order]] = await conn.query(`SELECT user_id, order_number FROM orders WHERE id = ?`, [item.order_id]);
    await notify(order.user_id, {
      type: 'order', title: `Commande ${order.order_number}`,
      body: `Mise à jour : ${ORDER_STATUS_LABELS[d.status]}${d.tracking_number ? ` (suivi ${d.tracking_number})` : ''}`,
      link: `/compte/commandes/${item.order_id}`,
    }, conn);
  });
  ok(res, null, `Statut mis à jour : ${ORDER_STATUS_LABELS[d.status]}`);
});

// =====================================================================
// Finances : ventes, commissions, reversements
// =====================================================================
router.get('/finances', async (req, res) => {
  const id = req.shopId;
  const ledger = await queryOne(
    `SELECT COALESCE(SUM(CASE WHEN entry_type = 'sale' THEN amount END), 0) AS sales,
            COALESCE(SUM(CASE WHEN entry_type = 'commission' THEN -amount END), 0) AS commissions,
            COALESCE(SUM(CASE WHEN entry_type = 'refund' THEN -amount END), 0) AS refunds,
            COALESCE(SUM(amount), 0) AS earned
       FROM seller_ledger_entries WHERE shop_id = ?`, [id]);
  const payouts = await queryOne(
    `SELECT COALESCE(SUM(CASE WHEN status = 'paid' THEN amount END), 0) AS paid,
            COALESCE(SUM(CASE WHEN status = 'pending' THEN amount END), 0) AS pending
       FROM seller_payouts WHERE shop_id = ?`, [id]);
  const upcoming = await queryOne(
    // Montant payé en ligne pour les commandes en cours, crédité au vendeur à la livraison (net des frais plateforme)
    `SELECT COALESCE(SUM(upfront_amount - platform_fee + discount_total), 0) AS amount FROM orders
      WHERE shop_id = ? AND status IN ('confirmed','preparing','ready','shipped','in_delivery')`, [id]);
  const entries = await query(
    `SELECT id, entry_type, amount, description, created_at FROM seller_ledger_entries WHERE shop_id = ? ORDER BY id DESC LIMIT 50`, [id]);
  const payoutList = await query(`SELECT * FROM seller_payouts WHERE shop_id = ? ORDER BY id DESC LIMIT 50`, [id]);
  const shop = await queryOne(`SELECT payout_method, payout_account, payout_holder FROM shops WHERE id = ?`, [id]);
  const toCollect = await queryOne(
    `SELECT COALESCE(SUM(balance_amount), 0) AS amount FROM orders
      WHERE shop_id = ? AND balance_amount > 0 AND balance_paid_at IS NULL AND status IN ('confirmed','preparing','ready','shipped','in_delivery')`, [id]);
  ok(res, {
    platform_fee_rate: (await pricingRates()).fee,
    payout_method: shop.payout_method,
    payout_account: shop.payout_account,
    payout_holder: shop.payout_holder,
    to_collect: Number(toCollect.amount),
    gross_sales: Number(ledger.sales),
    commissions: Number(ledger.commissions),
    refunds: Number(ledger.refunds),
    net_earned: Number(ledger.earned),
    paid_out: Number(payouts.paid),
    pending_payouts: Number(payouts.pending),
    balance: money(Number(ledger.earned) - Number(payouts.paid) - Number(payouts.pending)),
    upcoming: Number(upcoming.amount),
    entries,
    payouts: payoutList,
  });
});

export default router;

// Rôle « seller » ajouté lors de la validation par l'administrateur (voir admin.routes.js)
export async function grantSellerRole(conn, userId) {
  const id = await roleId('seller');
  await conn.query(`INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)`, [userId, id]);
}
