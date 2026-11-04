/**
 * Migration vers Cloudinary (sans perte de données) : npm run db:migrate-cloudinary
 *  1. ajoute les colonnes public_id / media_type à product_images si besoin ;
 *  2. envoie sur Cloudinary chaque fichier local encore référencé (/uploads/public/...) et met à jour les URL ;
 *  3. envoie les pièces justificatives (uploads/private) en stockage privé « authenticated ».
 * Idempotent : peut être relancé, seules les références encore locales sont traitées.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/config/db.js';
import { uploadPath } from '../src/services/storage.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(dir, '../uploads/public');
const PRIVATE_DIR = path.resolve(dir, '../uploads/private');
const LOCAL = '/uploads/public/';

const conn = await pool.getConnection();
const stats = { uploaded: 0, updatedRows: 0, documents: 0, missing: [] };

async function addColumn(table, column, definition) {
  const [rows] = await conn.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
  if (!rows.length) {
    await conn.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`✔ Colonne ${table}.${column} ajoutée`);
  }
}

const cache = new Map();
/** URL locale → { url, public_id, media_type } sur Cloudinary (null si le fichier est introuvable). */
async function migrateUrl(localUrl, folder) {
  if (cache.has(localUrl)) return cache.get(localUrl);
  const name = path.basename(localUrl);
  const file = path.join(PUBLIC_DIR, name);
  let result = null;
  if (fs.existsSync(file)) {
    const isVideo = /\.(mp4|webm|mov)$/i.test(name);
    const seed = name.startsWith('seed-');
    const r = await uploadPath(file, {
      folder: seed ? 'seed' : folder,
      public_id: path.parse(name).name,
      overwrite: false,
      resource_type: isVideo ? 'video' : 'image',
    });
    result = { url: r.secure_url, public_id: r.public_id, media_type: isVideo ? 'video' : 'image' };
    stats.uploaded++;
  } else {
    stats.missing.push(localUrl);
  }
  cache.set(localUrl, result);
  return result;
}

async function migrateColumn(table, column, folder, extra = null) {
  const [rows] = await conn.query(`SELECT id, ${column} AS url FROM ${table} WHERE ${column} LIKE ?`, [`${LOCAL}%`]);
  for (const row of rows) {
    const m = await migrateUrl(row.url, folder);
    if (!m) continue;
    if (extra) await conn.query(`UPDATE ${table} SET ${column} = ?, public_id = ?, media_type = ? WHERE id = ?`, [m.url, m.public_id, m.media_type, row.id]);
    else await conn.query(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [m.url, row.id]);
    stats.updatedRows++;
  }
}

try {
  await addColumn('product_images', 'public_id', 'VARCHAR(255) NULL AFTER url');
  await addColumn('product_images', 'media_type', "ENUM('image','video') NOT NULL DEFAULT 'image' AFTER public_id");

  await migrateColumn('product_images', 'url', 'products', true);
  await migrateColumn('shops', 'logo_url', 'shops');
  await migrateColumn('shops', 'banner_url', 'shops');
  await migrateColumn('users', 'avatar_url', 'avatars');
  await migrateColumn('order_items', 'image_url', 'products');

  // Pièces justificatives : chemin local (nom de fichier seul) → public_id Cloudinary privé
  const [docs] = await conn.query(`SELECT id, file_path FROM seller_documents WHERE file_path NOT LIKE '%/%'`);
  for (const d of docs) {
    const file = path.join(PRIVATE_DIR, d.file_path);
    if (!fs.existsSync(file)) { stats.missing.push(`private/${d.file_path}`); continue; }
    const r = await uploadPath(file, { folder: 'documents', resource_type: 'raw', type: 'authenticated', use_filename: false, unique_filename: true });
    await conn.query(`UPDATE seller_documents SET file_path = ? WHERE id = ?`, [r.public_id, d.id]);
    stats.documents++;
  }

  console.log(`✔ ${stats.uploaded} média(s) envoyé(s) sur Cloudinary, ${stats.updatedRows} référence(s) mise(s) à jour`);
  console.log(`✔ ${stats.documents} pièce(s) justificative(s) passée(s) en stockage privé Cloudinary`);
  if (stats.missing.length) console.warn('⚠ Fichiers introuvables (références conservées) :', stats.missing);
  const [[left]] = await conn.query(`SELECT
      (SELECT COUNT(*) FROM product_images WHERE url LIKE '${LOCAL}%') +
      (SELECT COUNT(*) FROM shops WHERE logo_url LIKE '${LOCAL}%' OR banner_url LIKE '${LOCAL}%') +
      (SELECT COUNT(*) FROM users WHERE avatar_url LIKE '${LOCAL}%') +
      (SELECT COUNT(*) FROM order_items WHERE image_url LIKE '${LOCAL}%') +
      (SELECT COUNT(*) FROM seller_documents WHERE file_path NOT LIKE '%/%') AS n`);
  console.log(left.n === 0
    ? '✔ Plus aucune référence locale : le dossier backend/uploads peut être supprimé.'
    : `⚠ ${left.n} référence(s) encore locale(s).`);
} finally {
  conn.release();
  await pool.end();
}
