import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import env from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import authRoutes from './routes/auth.routes.js';
import catalogRoutes from './routes/catalog.routes.js';
import cartRoutes from './routes/cart.routes.js';
import wishlistRoutes from './routes/wishlist.routes.js';
import accountRoutes from './routes/account.routes.js';
import ordersRoutes from './routes/orders.routes.js';
import paymentsRoutes from './routes/payments.routes.js';
import reviewsRoutes from './routes/reviews.routes.js';
import sellerRoutes from './routes/seller.routes.js';
import adminRoutes from './routes/admin.routes.js';

const app = express();

app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin(origin, cb) {
    // Les applications mobiles natives n'envoient pas d'en-tête Origin
    if (!origin || env.corsOrigins.includes(origin)) return cb(null, true);
    if (env.nodeEnv !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/.test(origin)) {
      return cb(null, true);
    }
    cb(new Error('Origine non autorisée'));
  },
}));
// rawBody conservé pour la vérification de signature des webhooks
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));
if (env.nodeEnv !== 'test') app.use(morgan('dev'));

app.use('/api', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));

// Aucun fichier n'est servi par l'API : images, vidéos et documents sont stockés sur Cloudinary.

app.get('/api/v1/health', (_req, res) => res.json({ success: true, data: { status: 'ok', time: new Date() } }));

const v1 = express.Router();
v1.use('/auth', authRoutes);
v1.use('/', catalogRoutes);
v1.use('/', reviewsRoutes);
v1.use('/cart', cartRoutes);
v1.use('/wishlist', wishlistRoutes);
v1.use('/account', accountRoutes);
v1.use('/orders', ordersRoutes);
v1.use('/payments', paymentsRoutes);
v1.use('/seller', sellerRoutes);
v1.use('/admin', adminRoutes);
app.use('/api/v1', v1);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
