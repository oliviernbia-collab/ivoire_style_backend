import env from './env.js';

/**
 * Moyens de paiement et de reversement : libellé, couleur de marque et logos officiels
 * (stockés sur Cloudinary dans <dossier>/payments, voir database/upload-payment-logos.js).
 * Sans logo (carte, livraison, virement), les applications affichent une icône Font Awesome.
 */
const PROVIDERS = {
  orange_money: { label: 'Orange Money', color: '#FF7900', logo: true },
  mtn_momo: { label: 'MTN MoMo', color: '#FFCC00', logo: true },
  wave: { label: 'Wave', color: '#1DC3FF', logo: true },
  moov_money: { label: 'Moov Money', color: '#0059A9', logo: true },
  card: { label: 'Carte bancaire', color: '#1C1C1C', icon: 'credit-card' },
  cash_on_delivery: { label: 'Paiement à la livraison', color: '#2E7D4F', icon: 'money-bill-wave' },
  bank: { label: 'Virement bancaire', color: '#1D5D9B', icon: 'building-columns' },
};

export const LOGO_CODES = Object.keys(PROVIDERS).filter((k) => PROVIDERS[k].logo);

const logoUrl = (code, variant) =>
  `https://res.cloudinary.com/${env.cloudinary.cloudName}/image/upload/${env.cloudinary.folder}/payments/${code}${variant}.png`;

export function providerInfo(code) {
  const p = PROVIDERS[code] || { label: code, color: '#6B6B6B', icon: 'wallet' };
  return {
    code,
    label: p.label,
    color: p.color,
    icon: p.icon || null,
    logo: p.logo ? logoUrl(code, '') : null, // vignette carrée 256 px
    logo_wide: p.logo ? logoUrl(code, '-wide') : null, // bandeau 360 × 120 px
  };
}

/** Tous les moyens connus (affichage des commandes, reversements…). */
export const allProviders = () => Object.fromEntries(Object.keys(PROVIDERS).map((k) => [k, providerInfo(k)]));
