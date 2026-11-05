/**
 * Mise à jour d'une base existante vers le schéma courant, sans perte de données : npm run db:migrate
 * (étapes dans migrations.js, aussi appliquées automatiquement au démarrage de l'API).
 */
import { pool } from '../src/config/db.js';
import { migrate } from './migrations.js';

const conn = await pool.getConnection();
try {
  const changes = await migrate(conn);
  console.log(changes ? `✔ Migration terminée (${changes} modification(s))` : '✔ Base déjà à jour');
} finally {
  conn.release();
  await pool.end();
}
