import multer from 'multer';
import { ApiError } from '../utils/http.js';
import { destroyMedia } from '../services/storage.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ success: false, message: `Route introuvable : ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  // Requête en échec : on retire de Cloudinary les fichiers envoyés pour elle
  const uploads = req.cloudUploads?.length ? req.cloudUploads : err?.cloudUploads;
  uploads?.forEach((u) => destroyMedia(u.public_id, u.resource_type, u.type));

  if (err instanceof ApiError) {
    return res.status(err.status).json({ success: false, message: err.message, errors: err.errors });
  }
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux (50 Mo max pour une vidéo, 5 Mo pour une image)' : 'Erreur de téléversement';
    return res.status(400).json({ success: false, message });
  }
  if (err?.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ success: false, message: 'Cette valeur existe déjà' });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'JSON invalide' });
  }
  // MySQL arrêté ou redémarré (XAMPP) : message clair et une seule ligne de journal, sans pile d'appels
  if (['ECONNREFUSED', 'ECONNRESET', 'PROTOCOL_CONNECTION_LOST', 'ETIMEDOUT'].includes(err?.code)) {
    console.error(`[BASE DE DONNÉES] ${err.code} sur ${req.method} ${req.originalUrl} : MySQL est-il démarré (XAMPP) ?`);
    return res.status(503).json({ success: false, message: 'Service momentanément indisponible. Réessayez dans un instant.' });
  }
  console.error('[ERREUR]', req.method, req.originalUrl, err);
  res.status(500).json({ success: false, message: 'Une erreur interne est survenue. Réessayez plus tard.' });
}
