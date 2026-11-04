/**
 * Crée la base db_style, applique le schéma puis insère les données de référence et de démonstration.
 * Usage : npm run db:init   (ATTENTION : supprime et recrée toutes les tables)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import env from '../src/config/env.js';
import { seed } from './seed.js';
import { uploadPaymentLogos } from './upload-payment-logos.js';

const dir = path.dirname(fileURLToPath(import.meta.url));

const conn = await mysql.createConnection({
  host: env.db.host, port: env.db.port, user: env.db.user, password: env.db.password,
  multipleStatements: true, charset: 'utf8mb4',
});
// Garde-fous : ce script efface toutes les tables et recrée des comptes de démonstration aux mots de passe publics
if (env.nodeEnv === 'production') {
  console.error('✖ db:init est interdit en production (effacement complet + comptes de démonstration). Utilisez « npm run db:migrate ».');
  process.exit(1);
}
await conn.query(`CREATE DATABASE IF NOT EXISTS \`${env.db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
await conn.query(`USE \`${env.db.database}\``);
const [[existing]] = await conn.query(
  `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = 'users'`, [env.db.database]);
if (existing.n && !process.argv.includes('--effacer-tout')) {
  const [[{ users }]] = await conn.query('SELECT COUNT(*) AS users FROM users');
  if (users > 0) {
    console.error(`✖ La base ${env.db.database} contient déjà ${users} compte(s) : rien n’a été effacé.`);
    console.error('  Pour mettre la base à jour sans perte : npm run db:migrate');
    console.error('  Pour TOUT effacer et repartir des données de démonstration : npm run db:init -- --effacer-tout');
    await conn.end();
    process.exit(1);
  }
}
await conn.query(fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8'));
console.log(`✔ Schéma appliqué sur ${env.db.database}`);
await seed(conn);
await conn.end();
console.log(`✔ ${await uploadPaymentLogos()} logos de paiement synchronisés sur Cloudinary`);
console.log('✔ Base prête');
