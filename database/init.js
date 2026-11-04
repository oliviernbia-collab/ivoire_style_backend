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
await conn.query(`CREATE DATABASE IF NOT EXISTS \`${env.db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
await conn.query(`USE \`${env.db.database}\``);
await conn.query(fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8'));
console.log(`✔ Schéma appliqué sur ${env.db.database}`);
await seed(conn);
await conn.end();
console.log(`✔ ${await uploadPaymentLogos()} logos de paiement synchronisés sur Cloudinary`);
console.log('✔ Base prête');
