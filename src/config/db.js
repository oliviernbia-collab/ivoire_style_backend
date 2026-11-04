import mysql from 'mysql2/promise';
import env from './env.js';

export const pool = mysql.createPool({
  ...env.db,
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  decimalNumbers: true,
  dateStrings: false,
  namedPlaceholders: false,
});

export async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

/**
 * Exécute fn(conn) dans une transaction SQL (commit/rollback automatique).
 * conn.afterCommit(cb) : action lancée seulement si la transaction est validée (ex. événement temps réel).
 */
export async function transaction(fn) {
  const conn = await pool.getConnection();
  const after = [];
  conn.afterCommit = (cb) => after.push(cb);
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    for (const cb of after) {
      try { cb(); } catch (e) { console.error('[afterCommit]', e.message); }
    }
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    delete conn.afterCommit;
    conn.release();
  }
}
