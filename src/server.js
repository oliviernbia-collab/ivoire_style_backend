import http from 'node:http';
import app from './app.js';
import env from './config/env.js';
import { pool } from './config/db.js';
import { expireUnpaidOrders } from './services/orders.js';
import { syncPendingJekoPayments } from './services/payments.js';
import { initRealtime } from './realtime.js';

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
  server.listen(env.port, '0.0.0.0', () => {
    console.log(`API Ivoire Style prête sur ${env.publicUrl}/api/v1 (paiements : ${env.payment.mode})`);
  });

  // Expiration des réservations de stock des commandes non payées
  setInterval(() => {
    expireUnpaidOrders(syncPendingJekoPayments)
      .then((n) => n && console.log(`[EXPIRATION] ${n} commande(s) non payée(s) annulée(s)`))
      .catch((e) => console.error('[EXPIRATION]', e.message));
  }, 5 * 60 * 1000);
}

start();
