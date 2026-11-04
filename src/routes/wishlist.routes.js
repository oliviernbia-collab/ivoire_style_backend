import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../config/db.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { notFound, ok } from '../utils/http.js';
import { normalizeCard, PRODUCT_FROM, productCardSelect } from '../services/catalog.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const sel = productCardSelect(req.user.id);
  const rows = await query(
    `SELECT ${sel.sql} ${PRODUCT_FROM} JOIN wishlist_items w ON w.product_id = p.id
      WHERE w.user_id = ? ORDER BY w.created_at DESC`,
    [...sel.params, req.user.id],
  );
  ok(res, rows.map(normalizeCard));
});

router.post('/items', validate(z.object({ product_id: z.coerce.number().int().positive() })), async (req, res) => {
  const p = await queryOne(`SELECT id FROM products WHERE id = ? AND status = 'published'`, [req.valid.product_id]);
  if (!p) throw notFound('Produit introuvable');
  await query(`INSERT IGNORE INTO wishlist_items (user_id, product_id) VALUES (?, ?)`, [req.user.id, p.id]);
  ok(res, { product_id: p.id, is_favorite: true }, 'Ajouté à vos favoris');
});

/** :id = identifiant du produit */
router.delete('/items/:id', async (req, res) => {
  await query(`DELETE FROM wishlist_items WHERE user_id = ? AND product_id = ?`, [req.user.id, req.params.id]);
  ok(res, { product_id: Number(req.params.id), is_favorite: false }, 'Retiré de vos favoris');
});

export default router;
