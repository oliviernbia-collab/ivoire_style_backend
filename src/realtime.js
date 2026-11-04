import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import env from './config/env.js';
import { loadUser } from './middleware/auth.js';

/**
 * Temps réel (Socket.IO) : chaque utilisateur rejoint son canal « user:<id> », l'administration et le
 * support le canal « staff ». Les clients reçoivent les notifications et rechargent les écrans concernés.
 * Chemin /api/v1/realtime : passe par le même proxy que l'API (Vite, ngrok).
 */
let io = null;

const STAFF_ROLES = ['admin', 'support'];

export function initRealtime(httpServer) {
  io = new Server(httpServer, {
    path: '/api/v1/realtime',
    cors: {
      origin(origin, cb) {
        // Applications mobiles : pas d'en-tête Origin
        if (!origin || env.corsOrigins.includes(origin)) return cb(null, true);
        if (env.nodeEnv !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/.test(origin)) {
          return cb(null, true);
        }
        return cb(new Error('Origine non autorisée'));
      },
    },
  });

  // Authentification par le jeton d'accès (le même que pour l'API)
  io.use(async (socket, next) => {
    try {
      const payload = jwt.verify(String(socket.handshake.auth?.token || ''), env.jwt.accessSecret);
      const user = await loadUser(payload.sub);
      if (!user || user.status !== 'active') return next(new Error('unauthorized'));
      socket.data.user = user;
      return next();
    } catch {
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const { user } = socket.data;
    socket.join(`user:${user.id}`);
    if (user.roles.some((r) => STAFF_ROLES.includes(r))) socket.join('staff');
  });
  return io;
}

/** Envoie un événement à un utilisateur (tous ses onglets et appareils connectés). */
export function emitToUser(userId, event, data) {
  io?.to(`user:${userId}`).emit(event, data);
}

/** Envoie un événement à l'administration et au support. */
export function emitToStaff(event, data) {
  io?.to('staff').emit(event, data);
}
