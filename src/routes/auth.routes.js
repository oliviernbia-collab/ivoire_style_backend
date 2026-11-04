import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import env from '../config/env.js';
import { query, queryOne, transaction } from '../config/db.js';
import { loadUser, requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { toCloud, upload } from '../middleware/upload.js';
import { destroyByUrl } from '../services/storage.js';
import { badRequest, conflict, created, ok, unauthorized } from '../utils/http.js';
import { publicFileUrl, sha256 } from '../utils/helpers.js';
import { audit, roleId } from '../services/common.js';

const router = Router();

const tooMany = { success: false, message: 'Trop de tentatives. Réessayez dans quelques minutes.' };
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: tooMany,
});
// Inscription, mot de passe oublié, réinitialisation : limite stricte par adresse IP (création de comptes en masse,
// envoi de liens, essais de jetons)
const sensitiveLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: tooMany });
const refreshLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false, message: tooMany });

// Empreinte factice : un identifiant inconnu prend le même temps qu'un mauvais mot de passe (pas d'énumération des comptes)
const DUMMY_HASH = bcrypt.hashSync('compte-inexistant-ivoire-style', 12);

const phoneRegex = /^\+?[0-9 ]{8,20}$/;
const password = z.string().min(8, 'Au moins 8 caractères')
  .regex(/[A-Za-z]/, 'Doit contenir une lettre').regex(/[0-9]/, 'Doit contenir un chiffre');

const registerSchema = z.object({
  first_name: z.string().trim().min(2, 'Prénom requis').max(80),
  last_name: z.string().trim().min(2, 'Nom requis').max(80),
  email: z.string().trim().toLowerCase().email('E-mail invalide'),
  phone: z.string().trim().regex(phoneRegex, 'Téléphone invalide'),
  password,
});

async function issueTokens(userId, req) {
  const access_token = jwt.sign({ sub: userId }, env.jwt.accessSecret, { expiresIn: env.jwt.accessExpires, algorithm: 'HS256' });
  const refresh_token = crypto.randomBytes(48).toString('hex');
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent)
     VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? DAY), ?)`,
    [userId, sha256(refresh_token), env.jwt.refreshDays, (req.headers['user-agent'] || '').slice(0, 255)],
  );
  return { access_token, refresh_token };
}

router.post('/register', sensitiveLimiter, validate(registerSchema), async (req, res) => {
  const d = req.valid;
  const phone = d.phone.replace(/\s+/g, '');
  const exists = await queryOne(`SELECT email, phone FROM users WHERE email = ? OR phone = ?`, [d.email, phone]);
  if (exists) {
    throw conflict(exists.email === d.email ? 'Cet e-mail est déjà utilisé' : 'Ce numéro est déjà utilisé');
  }
  const hash = await bcrypt.hash(d.password, 12);
  const customerRole = await roleId('customer');
  const userId = await transaction(async (conn) => {
    const [r] = await conn.query(
      `INSERT INTO users (first_name, last_name, email, phone, password_hash) VALUES (?, ?, ?, ?, ?)`,
      [d.first_name, d.last_name, d.email, phone, hash],
    );
    await conn.query(`INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)`, [r.insertId, customerRole]);
    await conn.query(
      `INSERT INTO notifications (user_id, type, title, body) VALUES (?, 'welcome', ?, ?)`,
      [r.insertId, 'Bienvenue sur Ivoire Style !', 'Votre style, votre signature. Découvrez nos collections.'],
    );
    return r.insertId;
  });
  const tokens = await issueTokens(userId, req);
  const user = await loadUser(userId);
  created(res, { user, ...tokens }, 'Compte créé avec succès. Bienvenue !');
});

const loginSchema = z.object({
  login: z.string().trim().min(3, 'E-mail ou téléphone requis'),
  password: z.string().min(1, 'Mot de passe requis'),
});

router.post('/login', loginLimiter, validate(loginSchema), async (req, res) => {
  const { login, password: pwd } = req.valid;
  const ident = login.includes('@') ? login.toLowerCase() : login.replace(/\s+/g, '');
  const user = await queryOne(
    `SELECT id, password_hash, status, failed_logins, locked_until FROM users WHERE email = ? OR phone = ?`,
    [ident, ident],
  );
  const invalid = unauthorized('Identifiants incorrects');
  if (!user) {
    await bcrypt.compare(pwd, DUMMY_HASH);
    throw invalid;
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw unauthorized('Compte temporairement verrouillé après plusieurs échecs. Réessayez dans 15 minutes.');
  }
  if (user.status !== 'active') throw unauthorized('Ce compte est suspendu. Contactez le support.');
  const valid = await bcrypt.compare(pwd, user.password_hash);
  if (!valid) {
    const fails = user.failed_logins + 1;
    await query(
      `UPDATE users SET failed_logins = ?, locked_until = IF(? >= 5, DATE_ADD(NOW(), INTERVAL 15 MINUTE), NULL) WHERE id = ?`,
      [fails >= 5 ? 0 : fails, fails, user.id],
    );
    await audit(req, 'auth.login_failed', 'user', user.id);
    throw invalid;
  }
  await query(`UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = NOW() WHERE id = ?`, [user.id]);
  const tokens = await issueTokens(user.id, req);
  ok(res, { user: await loadUser(user.id), ...tokens }, 'Connexion réussie');
});

router.post('/refresh', refreshLimiter, async (req, res) => {
  const token = req.body?.refresh_token;
  if (!token || typeof token !== 'string') throw unauthorized('Jeton manquant');
  const row = await queryOne(`SELECT id, user_id, revoked_at, expires_at FROM refresh_tokens WHERE token_hash = ?`, [sha256(token)]);
  // Jeton déjà utilisé : il a été copié (vol de session). Toutes les sessions de ce compte sont fermées.
  // Tolérance de 30 s : deux onglets qui renouvellent la session au même moment ne sont pas un vol.
  if (row?.revoked_at && Date.now() - new Date(row.revoked_at).getTime() < 30_000) throw unauthorized('Session renouvelée, réessayez');
  if (row?.revoked_at) {
    await query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL`, [row.user_id]);
    await audit({ ip: req.ip, user: { id: row.user_id } }, 'auth.refresh_reuse', 'user', row.user_id);
    throw unauthorized('Session expirée, veuillez vous reconnecter');
  }
  if (!row || new Date(row.expires_at) <= new Date()) throw unauthorized('Session expirée, veuillez vous reconnecter');
  await query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = ?`, [row.id]);
  const user = await loadUser(row.user_id);
  if (!user || user.status !== 'active') throw unauthorized('Compte inactif');
  const tokens = await issueTokens(row.user_id, req);
  ok(res, { user, ...tokens });
});

router.post('/logout', async (req, res) => {
  const token = req.body?.refresh_token;
  if (token) await query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = ?`, [sha256(token)]);
  ok(res, null, 'Vous êtes déconnecté');
});

router.post('/forgot-password', sensitiveLimiter, validate(z.object({ email: z.string().trim().toLowerCase().email('E-mail invalide') })), async (req, res) => {
  const user = await queryOne(`SELECT id FROM users WHERE email = ? AND status = 'active'`, [req.valid.email]);
  const data = {};
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    await query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR))`,
      [user.id, sha256(token)],
    );
    const link = `${env.webUrl}/reinitialiser-mot-de-passe?token=${token}`;
    // Point d'extension : envoi par e-mail transactionnel.
    // Le lien donne accès au compte : jamais dans les journaux ni la réponse en production.
    if (env.nodeEnv !== 'production') {
      console.log(`[RESET] Lien de réinitialisation pour ${req.valid.email} : ${link}`);
      data.dev_reset_link = link;
    }
    await audit({ ip: req.ip, user: { id: user.id } }, 'auth.password_reset_requested', 'user', user.id);
  }
  ok(res, data, 'Si un compte existe pour cet e-mail, un lien de réinitialisation a été envoyé.');
});

router.post('/reset-password', sensitiveLimiter, validate(z.object({ token: z.string().min(10).max(200), password })), async (req, res) => {
  const row = await queryOne(
    `SELECT id, user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()`,
    [sha256(req.valid.token)],
  );
  if (!row) throw badRequest('Lien invalide ou expiré');
  const hash = await bcrypt.hash(req.valid.password, 12);
  await transaction(async (conn) => {
    await conn.query(`UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?`, [hash, row.user_id]);
    await conn.query(`UPDATE password_resets SET used_at = NOW() WHERE id = ?`, [row.id]);
    await conn.query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL`, [row.user_id]);
  });
  await audit({ ip: req.ip, user: { id: row.user_id } }, 'auth.password_reset', 'user', row.user_id);
  ok(res, null, 'Mot de passe modifié. Vous pouvez vous connecter.');
});

router.get('/me', requireAuth, (req, res) => ok(res, req.user));

const profileSchema = z.object({
  first_name: z.string().trim().min(2).max(80),
  last_name: z.string().trim().min(2).max(80),
  phone: z.string().trim().regex(phoneRegex, 'Téléphone invalide'),
});

router.patch('/me', requireAuth, upload.single('avatar'), validate(profileSchema), async (req, res, next) => {
  const phone = req.valid.phone.replace(/\s+/g, '');
  const taken = await queryOne(`SELECT id FROM users WHERE phone = ? AND id <> ?`, [phone, req.user.id]);
  if (taken) throw conflict('Ce numéro est déjà utilisé');
  next();
}, toCloud({ avatar: 'avatars' }), async (req, res) => {
  const d = req.valid;
  const avatar = publicFileUrl(req.file);
  await query(
    `UPDATE users SET first_name = ?, last_name = ?, phone = ?, avatar_url = COALESCE(?, avatar_url) WHERE id = ?`,
    [d.first_name, d.last_name, d.phone.replace(/\s+/g, ''), avatar, req.user.id],
  );
  if (avatar && req.user.avatar_url) await destroyByUrl(req.user.avatar_url);
  ok(res, await loadUser(req.user.id), 'Profil mis à jour');
});

/** Photo de profil : envoyée seule (JPG, PNG ou WEBP, 5 Mo max, contenu vérifié), stockée sur Cloudinary. */
router.put('/me/avatar', requireAuth, upload.single('avatar'), (req, _res, next) => {
  if (!req.file) throw badRequest('Choisissez une photo', { avatar: 'Photo requise' });
  next();
}, toCloud({ avatar: 'avatars' }), async (req, res) => {
  await query(`UPDATE users SET avatar_url = ? WHERE id = ?`, [publicFileUrl(req.file), req.user.id]);
  // L'ancienne photo est supprimée de Cloudinary
  if (req.user.avatar_url) await destroyByUrl(req.user.avatar_url);
  ok(res, await loadUser(req.user.id), 'Photo de profil mise à jour');
});

router.delete('/me/avatar', requireAuth, async (req, res) => {
  if (req.user.avatar_url) {
    await query(`UPDATE users SET avatar_url = NULL WHERE id = ?`, [req.user.id]);
    await destroyByUrl(req.user.avatar_url);
  }
  ok(res, await loadUser(req.user.id), 'Photo de profil retirée');
});

router.post('/change-password', requireAuth,
  validate(z.object({ current_password: z.string().min(1, 'Mot de passe actuel requis'), new_password: password })),
  async (req, res) => {
    const u = await queryOne(`SELECT password_hash FROM users WHERE id = ?`, [req.user.id]);
    if (!(await bcrypt.compare(req.valid.current_password, u.password_hash))) {
      throw badRequest('Mot de passe actuel incorrect', { current_password: 'Mot de passe actuel incorrect' });
    }
    await query(`UPDATE users SET password_hash = ? WHERE id = ?`, [await bcrypt.hash(req.valid.new_password, 12), req.user.id]);
    // Toutes les autres sessions (autres appareils, session volée) sont fermées ; celle-ci reçoit de nouveaux jetons
    await query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL`, [req.user.id]);
    await audit(req, 'auth.password_changed', 'user', req.user.id);
    ok(res, await issueTokens(req.user.id, req), 'Mot de passe modifié. Vos autres appareils ont été déconnectés.');
  });

/** Demande de suppression : anonymisation (les commandes sont conservées pour les obligations comptables). */
router.delete('/me', requireAuth, async (req, res) => {
  const id = req.user.id;
  await transaction(async (conn) => {
    await conn.query(
      `UPDATE users SET status = 'deleted', first_name = 'Utilisateur', last_name = 'supprimé',
         email = CONCAT('deleted-', id, '@ivoirestyle.invalid'), phone = CONCAT('000', id), avatar_url = NULL
       WHERE id = ?`, [id]);
    await conn.query(`DELETE FROM addresses WHERE user_id = ?`, [id]);
    await conn.query(`DELETE FROM cart_items WHERE user_id = ?`, [id]);
    await conn.query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ?`, [id]);
  });
  await audit(req, 'user.self_delete', 'user', id);
  ok(res, null, 'Votre compte a été supprimé');
});

export default router;
