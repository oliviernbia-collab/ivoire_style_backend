/**
 * Envoie sur Cloudinary les logos officiels des moyens de paiement (database/payment-logos/*.png).
 * Identifiants fixes (<dossier>/payments/<code>[-wide]) : relançable sans créer de doublons.
 * Usage : npm run assets:payment-logos (appelé aussi par db:init)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uploadPath } from '../src/services/storage.js';
import { LOGO_CODES } from '../src/config/paymentProviders.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'payment-logos');

export async function uploadPaymentLogos() {
  let n = 0;
  for (const code of LOGO_CODES) {
    for (const variant of ['', '-wide']) {
      const file = path.join(dir, `${code}${variant}.png`);
      if (!fs.existsSync(file)) throw new Error(`Logo manquant : ${file}`);
      await uploadPath(file, { folder: 'payments', public_id: `${code}${variant}`, overwrite: true, invalidate: true, resource_type: 'image' });
      n++;
    }
  }
  return n;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  console.log(`✔ ${await uploadPaymentLogos()} logos de paiement envoyés sur Cloudinary`);
}
