import multer from 'multer';
import { badRequest } from '../utils/http.js';
import { isVideoMime, uploadFile } from '../services/storage.js';

/**
 * Téléversements : les fichiers sont reçus en mémoire (jamais écrits sur le disque du serveur),
 * contrôlés (type, taille), puis envoyés sur Cloudinary par `toCloud` une fois le formulaire validé.
 */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
const DOC_TYPES = [...IMAGE_TYPES, 'application/pdf'];

const MB = 1024 * 1024;
export const MAX_IMAGE = 5 * MB;
export const MAX_VIDEO = 50 * MB;

// Types acceptés par champ de formulaire
const ACCEPT = {
  images: [...IMAGE_TYPES, ...VIDEO_TYPES], // médias produit : photos et vidéos
  logo: IMAGE_TYPES,
  banner: IMAGE_TYPES,
  avatar: IMAGE_TYPES,
  document: DOC_TYPES,
};

function fileFilter(_req, file, cb) {
  const allowed = ACCEPT[file.fieldname] || IMAGE_TYPES;
  if (!allowed.includes(file.mimetype)) {
    return cb(badRequest(`Type de fichier non autorisé pour « ${file.fieldname} » (${file.mimetype})`));
  }
  cb(null, true);
}

export const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: MAX_VIDEO, files: 10 },
});

const listFiles = (req) => [
  ...(req.file ? [req.file] : []),
  ...(Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat()),
];

/**
 * Envoie les fichiers reçus vers Cloudinary. folders : { champ: 'dossier' } ; le champ « document »
 * est stocké en privé. Chaque fichier reçoit `file.cloud` = { url, public_id, resource_type, media_type }.
 * Les envois sont mémorisés dans req.cloudUploads pour être supprimés si la requête échoue ensuite.
 */
/**
 * Vérifie le contenu réel du fichier (signature des premiers octets), pas seulement le type annoncé par le
 * navigateur, facile à falsifier : un script renommé en .jpg est refusé.
 */
const SIGNATURES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  'application/pdf': (b) => b.toString('ascii', 0, 5) === '%PDF-',
  'video/mp4': (b) => b.toString('ascii', 4, 8) === 'ftyp',
  'video/quicktime': (b) => ['ftyp', 'moov', 'mdat', 'wide', 'free'].includes(b.toString('ascii', 4, 8)),
  'video/webm': (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3,
};
const contentMatches = (f) => Boolean(f.buffer && f.buffer.length >= 12 && SIGNATURES[f.mimetype]?.(f.buffer));

export const toCloud = (folders) => async (req, _res, next) => {
  const files = listFiles(req);
  for (const f of files) {
    const max = isVideoMime(f.mimetype) ? MAX_VIDEO : MAX_IMAGE;
    if (f.size > max) throw badRequest(`« ${f.originalname} » est trop volumineux (${Math.round(max / MB)} Mo max)`);
    if (!contentMatches(f)) throw badRequest(`« ${f.originalname} » n’est pas un fichier ${f.mimetype.split('/')[1].toUpperCase()} valide`);
  }
  req.cloudUploads = [];
  try {
    for (const f of files) {
      const privateDoc = f.fieldname === 'document';
      f.cloud = await uploadFile(f, folders[f.fieldname] || 'misc', { privateDoc });
      f.cloud.type = privateDoc ? 'authenticated' : 'upload';
      f.buffer = null; // libère la mémoire
      req.cloudUploads.push(f.cloud);
    }
  } catch (e) {
    console.error('[CLOUDINARY] envoi échoué', e.message);
    const err = badRequest('Le téléversement du fichier a échoué. Réessayez.');
    err.cloudUploads = req.cloudUploads;
    throw err;
  }
  next();
};
