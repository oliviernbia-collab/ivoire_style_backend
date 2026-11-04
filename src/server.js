import http from 'node:http';
import app from './app.js';
import env from './config/env.js';
import { pool } from './config/db.js';
import { expireUnpaidOrders } from './services/orders.js';
import {
  retryPendingRefunds, runAutoPayouts, syncPendingJekoPayments, syncProcessingTransfers,
} from './services/payments.js';
import { initRealtime } from './realtime.js';

/**
 * Toutes les routes vivent sous /api. En hébergement cPanel (Passenger, application montée sur /api), le préfixe
 * peut arriver retiré ou non selon la configuration : on le rétablit, pour l'API comme pour le temps réel.
 * En local, /robots.txt et /sitemap.xml (proxy Vite) deviennent ainsi /api/robots.txt et /api/sitemap.xml.
 */
function withApiPrefix(req) {
  if (req.url !== '/api' && !req.url.startsWith('/api/') && !req.url.startsWith('/api?')) req.url = `/api${req.url}`;
}

/**
 * Tâche de fond exécutée par un seul processus à la fois (verrou MySQL) : l'hébergeur peut lancer
 * plusieurs instances de l'API, et un reversement ou un remboursement ne doit jamais partir deux fois.
 */
async function exclusive(name, task) {
  const conn = await pool.getConnection();
  try {
    const [[{ ok }]] = await conn.query('SELECT GET_LOCK(?, 0) AS ok', [`ivs_${name}`]);
    if (ok !== 1) return 0;
    try {
      return await task();
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [`ivs_${name}`]);
    }
  } finally {
    conn.release();
  }
}

async function start() {
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    console.error(`Impossible de se connecter à MySQL (${env.db.host}/${env.db.database}) :`, err.message);
    console.error('Lancez MySQL (XAMPP) puis exécutez « npm run db:init ».');
    process.exit(1);
  }

  // Serveur HTTP partagé par l'API et le temps réel (Socket.IO)
  const server = http.createServer(app);
  initRealtime(server);
  // Placé en tête, après Socket.IO, pour corriger l'adresse avant tout traitement
  server.prependListener('request', withApiPrefix);
  server.prependListener('upgrade', withApiPrefix);
  server.listen(env.port, '0.0.0.0', () => {
    console.log(`API Ivoire Style prête sur ${env.publicUrl}/api/v1 (paiements : ${env.payment.mode})`);
  });

  // Expiration des réservations de stock des commandes non payées
  setInterval(() => {
    exclusive('expiration', () => expireUnpaidOrders(syncPendingJekoPayments))
      .then((n) => n && console.log(`[EXPIRATION] ${n} commande(s) non payée(s) annulée(s)`))
      .catch((e) => console.error('[EXPIRATION]', e.message));
  }, 5 * 60 * 1000);

  // Remboursements automatiques : issue des virements vérifiée auprès de Jèko (même sans webhook)
  // et relance des remboursements en attente de solde
  setInterval(() => {
    exclusive('virements', syncProcessingTransfers).catch((e) => console.error('[VIREMENTS]', e.message));
  }, 2 * 60 * 1000);
  setInterval(() => {
    exclusive('remboursements', retryPendingRefunds)
      .then((n) => n && console.log(`[REMBOURSEMENT AUTO] ${n} remboursement(s) relancé(s)`))
      .catch((e) => console.error('[REMBOURSEMENT AUTO]', e.message));
  }, 5 * 60 * 1000);
  // Reversements automatiques aux vendeurs : soldes dont le délai de retours est écoulé, ou en attente de solde Jèko
  setInterval(() => {
    exclusive('reversements', runAutoPayouts)
      .then((n) => n && console.log(`[REVERSEMENT AUTO] ${n} reversement(s) envoyé(s)`))
      .catch((e) => console.error('[REVERSEMENT AUTO]', e.message));
  }, 10 * 60 * 1000);
}

start();
