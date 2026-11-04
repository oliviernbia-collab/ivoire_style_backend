import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../config/db.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { badRequest, notFound, ok } from '../utils/http.js';
import { money } from '../utils/helpers.js';

const router = Router();
router.use(requireAuth);

export async function loadCart(userId) {
  const items = await query(
    `SELECT ci.id, ci.quantity, v.id AS variant_id, v.sku, v.size, v.color, v.color_hex, v.price, v.compare_at_price,
            GREATEST(v.stock_quantity - v.reserved_quantity, 0) AS stock, v.status AS variant_status,
            p.id AS product_id, p.name, p.slug, p.status AS product_status,
            s.id AS shop_id, s.name AS shop_name, s.slug AS shop_slug, s.status AS shop_status,
            (SELECT url FROM product_images pi WHERE pi.product_id = p.id AND pi.media_type = 'image' ORDER BY pi.sort_order, pi.id LIMIT 1) AS image
       FROM cart_items ci
       JOIN product_variants v ON v.id = ci.variant_id
       JOIN products p ON p.id = v.product_id
       JOIN shops s ON s.id = p.shop_id
      WHERE ci.user_id = ? ORDER BY ci.created_at DESC`,
    [userId],
  );
  let subtotal = 0;
  let count = 0;
  for (const it of items) {
    it.available = it.variant_status === 'active' && it.product_status === 'published' && it.shop_status === 'approved';
    it.issue = !it.available ? 'Article indisponible'
      : it.stock < it.quantity ? (it.stock === 0 ? 'Rupture de stock' : `Plus que ${it.stock} en stock`) : null;
    it.line_total = money(it.price * it.quantity);
    if (it.available) {
      subtotal += it.line_total;
      count += it.quantity;
    }
  }
  return { items, subtotal: money(subtotal), count };
}

router.get('/', async (req, res) => ok(res, await loadCart(req.user.id)));

const addSchema = z.object({
  variant_id: z.coerce.number().int().positive('Choisissez une taille et une couleur'),
  quantity: z.coerce.number().int().min(1).max(20).default(1),
});

router.post('/items', validate(addSchema), async (req, res) => {
  const { variant_id, quantity } = req.valid;
  const v = await queryOne(
    `SELECT v.id, GREATEST(v.stock_quantity - v.reserved_quantity, 0) AS stock, p.shop_id
       FROM product_variants v JOIN products p ON p.id = v.product_id JOIN shops s ON s.id = p.shop_id
      WHERE v.id = ? AND v.status = 'active' AND p.status = 'published' AND s.status = 'approved'`,
    [variant_id],
  );
  if (!v) throw notFound('Article indisponible');
  if (req.user.shop?.id === v.shop_id) throw badRequest('Vous ne pouvez pas acheter vos propres articles');
  const existing = await queryOne(`SELECT quantity FROM cart_items WHERE user_id = ? AND variant_id = ?`, [req.user.id, variant_id]);
  const newQty = (existing?.quantity || 0) + quantity;
  if (newQty > v.stock) throw badRequest(v.stock === 0 ? 'Article en rupture de stock' : `Stock insuffisant (${v.stock} disponible(s))`);
  await query(
    `INSERT INTO cart_items (user_id, variant_id, quantity) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE quantity = VALUES(quantity)`,
    [req.user.id, variant_id, newQty],
  );
  ok(res, await loadCart(req.user.id), 'Article ajouté au panier');
});

const updateSchema = z.object({
  quantity: z.coerce.number().int().min(1).max(20).optional(),
  variant_id: z.coerce.number().int().positive().optional(),
});

router.patch('/items/:id', validate(updateSchema), async (req, res) => {
  const item = await queryOne(
    `SELECT ci.*, v.product_id FROM cart_items ci JOIN product_variants v ON v.id = ci.variant_id
      WHERE ci.id = ? AND ci.user_id = ?`, [req.params.id, req.user.id]);
  if (!item) throw notFound('Article introuvable dans le panier');
  const variantId = req.valid.variant_id || item.variant_id;
  const quantity = req.valid.quantity || item.quantity;
  const v = await queryOne(
    `SELECT id, GREATEST(stock_quantity - reserved_quantity, 0) AS stock FROM product_variants
      WHERE id = ? AND product_id = ? AND status = 'active'`, [variantId, item.product_id]);
  if (!v) throw badRequest('Variante invalide');
  if (quantity > v.stock) throw badRequest(`Stock insuffisant (${v.stock} disponible(s))`);
  if (variantId !== item.variant_id) {
    // Changement de taille/couleur : fusion si la variante est déjà au panier
    await query(`DELETE FROM cart_items WHERE id = ?`, [item.id]);
    await query(
      `INSERT INTO cart_items (user_id, variant_id, quantity) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE quantity = LEAST(quantity + VALUES(quantity), ?)`,
      [req.user.id, variantId, quantity, v.stock]);
  } else {
    await query(`UPDATE cart_items SET quantity = ? WHERE id = ?`, [quantity, item.id]);
  }
  ok(res, await loadCart(req.user.id), 'Panier mis à jour');
});

router.delete('/items/:id', async (req, res) => {
  await query(`DELETE FROM cart_items WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
  ok(res, await loadCart(req.user.id), 'Article retiré du panier');
});

router.delete('/', async (req, res) => {
  await query(`DELETE FROM cart_items WHERE user_id = ?`, [req.user.id]);
  ok(res, await loadCart(req.user.id), 'Panier vidé');
});

export default router;
