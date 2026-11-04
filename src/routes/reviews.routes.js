import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../config/db.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { badRequest, conflict, created } from '../utils/http.js';
import { refreshRating } from '../services/catalog.js';

const router = Router();

/** Un avis n'est possible que pour un article livré à l'auteur (achat éligible). */
router.post('/products/:id/reviews', requireAuth, validate(z.object({
  rating: z.coerce.number().int().min(1, 'Note de 1 à 5').max(5, 'Note de 1 à 5'),
  comment: z.string().trim().max(1000).optional(),
})), async (req, res) => {
  const productId = Number(req.params.id);
  const item = await queryOne(
    `SELECT oi.id FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.user_id = ? AND oi.product_id = ? AND oi.fulfillment_status = 'delivered' LIMIT 1`,
    [req.user.id, productId]);
  if (!item) throw badRequest('Vous pourrez donner votre avis après la livraison de cet article');
  const exists = await queryOne(`SELECT id FROM reviews WHERE user_id = ? AND product_id = ?`, [req.user.id, productId]);
  if (exists) throw conflict('Vous avez déjà donné votre avis sur cet article');
  await query(
    `INSERT INTO reviews (product_id, user_id, order_item_id, rating, comment, status) VALUES (?, ?, ?, ?, ?, 'approved')`,
    [productId, req.user.id, item.id, req.valid.rating, req.valid.comment || null]);
  await refreshRating(productId);
  created(res, null, 'Merci ! Votre avis a été publié.');
});

export default router;
