import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction } from '../config/db.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { notFound, ok, created } from '../utils/http.js';
import { userPromotions } from '../services/promotions.js';

const router = Router();
router.use(requireAuth);

// ---------------- Adresses ----------------
const addressSchema = z.object({
  label: z.string().trim().max(60).default('Domicile'),
  recipient_name: z.string().trim().min(2, 'Nom du destinataire requis').max(160),
  phone: z.string().trim().regex(/^\+?[0-9 ]{8,20}$/, 'Téléphone invalide'),
  city: z.string().trim().min(2, 'Ville requise').max(80),
  commune: z.string().trim().max(80).optional().nullable(),
  district: z.string().trim().max(120).optional().nullable(),
  street: z.string().trim().max(255).optional().nullable(),
  instructions: z.string().trim().max(255).optional().nullable(),
  is_default: z.coerce.boolean().default(false),
});

router.get('/addresses', async (req, res) => {
  ok(res, await query(`SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC`, [req.user.id]));
});

router.post('/addresses', validate(addressSchema), async (req, res) => {
  const d = req.valid;
  const id = await transaction(async (conn) => {
    const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM addresses WHERE user_id = ?`, [req.user.id]);
    const isDefault = d.is_default || n === 0;
    if (isDefault) await conn.query(`UPDATE addresses SET is_default = 0 WHERE user_id = ?`, [req.user.id]);
    const [r] = await conn.query(
      `INSERT INTO addresses (user_id, label, recipient_name, phone, city, commune, district, street, instructions, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, d.label, d.recipient_name, d.phone, d.city, d.commune || null, d.district || null,
        d.street || null, d.instructions || null, isDefault ? 1 : 0]);
    return r.insertId;
  });
  created(res, await queryOne(`SELECT * FROM addresses WHERE id = ?`, [id]), 'Adresse enregistrée');
});

router.put('/addresses/:id', validate(addressSchema), async (req, res) => {
  const d = req.valid;
  const addr = await queryOne(`SELECT id FROM addresses WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
  if (!addr) throw notFound('Adresse introuvable');
  await transaction(async (conn) => {
    if (d.is_default) await conn.query(`UPDATE addresses SET is_default = 0 WHERE user_id = ?`, [req.user.id]);
    await conn.query(
      `UPDATE addresses SET label = ?, recipient_name = ?, phone = ?, city = ?, commune = ?, district = ?, street = ?,
         instructions = ?, is_default = IF(?, 1, is_default) WHERE id = ?`,
      [d.label, d.recipient_name, d.phone, d.city, d.commune || null, d.district || null, d.street || null,
        d.instructions || null, d.is_default ? 1 : 0, addr.id]);
  });
  ok(res, await queryOne(`SELECT * FROM addresses WHERE id = ?`, [addr.id]), 'Adresse modifiée');
});

router.delete('/addresses/:id', async (req, res) => {
  await query(`DELETE FROM addresses WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
  ok(res, null, 'Adresse supprimée');
});

// ---------------- Avantages (codes promo personnels) ----------------
router.get('/promotions', async (req, res) => ok(res, await userPromotions(req.user.id)));

// ---------------- Notifications ----------------
router.get('/notifications', async (req, res) => {
  const items = await query(
    `SELECT id, type, title, body, link, read_at, created_at FROM notifications
      WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`, [req.user.id]);
  const [{ unread }] = await query(`SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND read_at IS NULL`, [req.user.id]);
  ok(res, { items, unread });
});

router.post('/notifications/read-all', async (req, res) => {
  await query(`UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL`, [req.user.id]);
  ok(res, null, 'Notifications marquées comme lues');
});

router.patch('/notifications/:id/read', async (req, res) => {
  await query(`UPDATE notifications SET read_at = NOW() WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
  ok(res, null);
});

export default router;
