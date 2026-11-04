import { v2 as cloudinary } from 'cloudinary';
import env from '../config/env.js';

/**
 * Stockage des médias sur Cloudinary (aucun fichier n'est conservé sur le serveur).
 *  - Images et vidéos publiques : livrées par le CDN Cloudinary (URL https stockée en base).
 *  - Pièces justificatives vendeurs : type « authenticated », accessibles uniquement via
 *    une URL signée et temporaire générée côté serveur (jamais exposée au public).
 */
const { cloudName, apiKey, apiSecret, folder: ROOT } = env.cloudinary;

if (!cloudName || !apiKey || !apiSecret) {
  throw new Error('Cloudinary non configuré : renseignez CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY et CLOUDINARY_API_SECRET dans .env');
}
cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });

export const isVideoMime = (mime) => String(mime).startsWith('video/');

function uploadStream(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => (err ? reject(err) : resolve(result)));
    stream.end(buffer);
  });
}

/** Envoie un fichier multer (mémoire) vers Cloudinary. folder : sous-dossier (products, shops, avatars, documents). */
export async function uploadFile(file, folder, { privateDoc = false } = {}) {
  const options = privateDoc
    ? { folder: `${ROOT}/${folder}`, resource_type: 'raw', type: 'authenticated', use_filename: false, unique_filename: true }
    : { folder: `${ROOT}/${folder}`, resource_type: isVideoMime(file.mimetype) ? 'video' : 'image', unique_filename: true };
  const r = await uploadStream(file.buffer, options);
  return {
    url: r.secure_url,
    public_id: r.public_id,
    resource_type: r.resource_type,
    media_type: r.resource_type === 'video' ? 'video' : 'image',
  };
}

/** Envoi d'un fichier local (migration, données de démonstration). */
export async function uploadPath(filePath, options) {
  return cloudinary.uploader.upload(filePath, { ...options, folder: options.folder ? `${ROOT}/${options.folder}` : undefined });
}

/** Retrouve public_id et type de ressource à partir d'une URL Cloudinary de ce compte. */
export function parseCloudinaryUrl(url) {
  const m = String(url || '').match(new RegExp(`res\\.cloudinary\\.com/${cloudName}/(image|video|raw)/upload/(?:[^/]+/)*?(?:v\\d+/)?(${ROOT}/.+?)(?:\\.[a-z0-9]+)?$`, 'i'));
  return m ? { resource_type: m[1], public_id: m[2] } : null;
}

/** Supprime un média (silencieux : une suppression ratée ne doit pas bloquer l'action métier). */
export async function destroyMedia(publicId, resourceType = 'image', type = 'upload') {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, type, invalidate: true });
  } catch (e) {
    console.warn('[CLOUDINARY] suppression impossible', publicId, e.message);
  }
}

export async function destroyByUrl(url) {
  const p = parseCloudinaryUrl(url);
  if (p) await destroyMedia(p.public_id, p.resource_type);
}

/** URL signée, valable quelques minutes, pour télécharger une pièce justificative privée. */
export function privateDocumentUrl(publicId, ttlSeconds = 300) {
  return cloudinary.utils.private_download_url(publicId, '', {
    resource_type: 'raw',
    type: 'authenticated',
    expires_at: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
}

export { cloudinary };
