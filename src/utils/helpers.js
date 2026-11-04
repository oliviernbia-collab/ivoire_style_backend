import crypto from 'node:crypto';

export function slugify(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 150);
}

export function randomCode(len = 6) {
  return crypto.randomBytes(len).toString('hex').slice(0, len).toUpperCase();
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Arrondi monétaire à 2 décimales en évitant les erreurs binaires (calcul en centimes). */
export function money(value) {
  return Math.round(Number(value) * 100) / 100;
}

/** Montant lisible en FCFA (messages d'erreur, notifications). */
export function price(value) {
  return `${Math.round(Number(value) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} FCFA`;
}

export function percentOf(amount, rate) {
  return Math.round(Number(amount) * Number(rate)) / 100;
}

export function orderNumber() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `IVS-${ymd}-${randomCode(6)}`;
}

/** URL publique (CDN Cloudinary) d'un fichier téléversé via le middleware toCloud. */
export function publicFileUrl(file) {
  return file?.cloud?.url || null;
}
