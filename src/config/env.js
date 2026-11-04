import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 5000),
  publicUrl: process.env.API_PUBLIC_URL || 'http://localhost:5000',
  webUrl: process.env.WEB_URL || 'http://localhost:5173',
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'db_style',
  },
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev_access_secret_change_me_please_0123456789',
    accessExpires: process.env.JWT_ACCESS_EXPIRES || '15m',
    refreshDays: Number(process.env.JWT_REFRESH_DAYS || 30),
  },
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map((s) => s.trim()),
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
    folder: process.env.CLOUDINARY_FOLDER || 'ivoire-style',
  },
  payment: {
    // sandbox : simulation locale ; jeko : encaissements et virements réels via l'API Jèko
    mode: process.env.PAYMENT_MODE || 'sandbox',
    webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET || 'dev_webhook_secret',
  },
  jeko: {
    baseUrl: process.env.JEKO_API_URL || 'https://api.jeko.africa',
    apiKey: process.env.JEKO_API_KEY || '',
    apiKeyId: process.env.JEKO_API_KEY_ID || '',
    storeId: process.env.JEKO_STORE_ID || '',
    webhookSecret: process.env.JEKO_WEBHOOK_SECRET || '',
  },
};

if (!['sandbox', 'jeko'].includes(env.payment.mode)) {
  throw new Error('PAYMENT_MODE doit valoir « sandbox » ou « jeko »');
}
if (env.nodeEnv === 'production' && env.payment.mode === 'sandbox') {
  throw new Error('PAYMENT_MODE=sandbox est interdit en production');
}
if (env.payment.mode === 'jeko') {
  const missing = ['apiKey', 'apiKeyId', 'storeId', 'webhookSecret'].filter((k) => !env.jeko[k]);
  if (missing.length) throw new Error(`PAYMENT_MODE=jeko : variables Jèko manquantes (${missing.join(', ')})`);
  // Jèko renvoie le client sur l'API après paiement : il lui faut une adresse publique (ngrok en local)
  if (!/^https:\/\//.test(env.publicUrl) || /localhost|127\.0\.0\.1/.test(env.publicUrl)) {
    throw new Error('PAYMENT_MODE=jeko : API_PUBLIC_URL doit être une adresse publique en HTTPS (ex. l’URL ngrok)');
  }
}

export default env;
