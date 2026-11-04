import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import { query, queryOne } from '../config/db.js';
import { forbidden, unauthorized } from '../utils/http.js';

export async function loadUser(userId) {
  const user = await queryOne(
    `SELECT id, first_name, last_name, email, phone, avatar_url, status, created_at
       FROM users WHERE id = ?`,
    [userId],
  );
  if (!user) return null;
  const roles = await query(
    `SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`,
    [userId],
  );
  user.roles = roles.map((r) => r.code);
  const shop = await queryOne(
    `SELECT id, name, slug, status, logo_url, rejection_reason, is_official FROM shops WHERE owner_user_id = ?`,
    [userId],
  );
  if (shop) shop.is_official = Boolean(shop.is_official);
  user.shop = shop;
  return user;
}

function readToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

export async function requireAuth(req, _res, next) {
  const token = readToken(req);
  if (!token) throw unauthorized();
  let payload;
  try {
    payload = jwt.verify(token, env.jwt.accessSecret, { algorithms: ['HS256'] });
  } catch {
    throw unauthorized('Session expirée, veuillez vous reconnecter');
  }
  const user = await loadUser(payload.sub);
  if (!user || user.status !== 'active') throw unauthorized('Compte inactif ou suspendu');
  req.user = user;
  next();
}

export async function optionalAuth(req, _res, next) {
  const token = readToken(req);
  if (token) {
    try {
      const payload = jwt.verify(token, env.jwt.accessSecret, { algorithms: ['HS256'] });
      const user = await loadUser(payload.sub);
      if (user && user.status === 'active') req.user = user;
    } catch {
      /* visiteur anonyme */
    }
  }
  next();
}

export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) throw unauthorized();
  if (!roles.some((r) => req.user.roles.includes(r))) throw forbidden();
  next();
};

/** Vendeur dont la boutique est validée. */
export function requireApprovedSeller(req, _res, next) {
  const shop = req.user?.shop;
  if (!shop) throw forbidden("Vous n'avez pas encore de boutique");
  if (shop.status !== 'approved') {
    throw forbidden(
      shop.status === 'pending'
        ? 'Votre boutique est en cours de validation'
        : 'Votre boutique n’est pas active',
    );
  }
  req.shopId = shop.id;
  next();
}
