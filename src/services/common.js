import { query, queryOne } from '../config/db.js';

export async function notify(userId, { type, title, body = null, link = null }, conn = null) {
  const sql = `INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)`;
  const params = [userId, type, title, body, link];
  if (conn) await conn.query(sql, params);
  else await query(sql, params);
  // Point d'extension : envoi push (Firebase Cloud Messaging) / e-mail / SMS.
}

export async function notifyAdmins(payload) {
  const admins = await query(
    `SELECT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.code = 'admin'`,
  );
  for (const a of admins) await notify(a.user_id, payload);
}

export async function audit(req, action, entity = null, entityId = null, details = null) {
  await query(
    `INSERT INTO audit_logs (user_id, action, entity, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)`,
    [req.user?.id || null, action, entity, entityId ? String(entityId) : null,
      details ? JSON.stringify(details).slice(0, 1000) : null, req.ip],
  );
}

let settingsCache = null;
let settingsAt = 0;

export async function getSettings() {
  if (settingsCache && Date.now() - settingsAt < 30_000) return settingsCache;
  const rows = await query(`SELECT setting_key, setting_value FROM platform_settings`);
  settingsCache = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
  settingsAt = Date.now();
  return settingsCache;
}

export function clearSettingsCache() {
  settingsCache = null;
}

export async function getSetting(key, fallback = null) {
  const s = await getSettings();
  return s[key] ?? fallback;
}

export async function roleId(code) {
  const r = await queryOne(`SELECT id FROM roles WHERE code = ?`, [code]);
  return r?.id;
}
