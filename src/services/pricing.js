import { getSettings } from './common.js';
import { money } from '../utils/helpers.js';

/**
 * Modèle économique
 *  - Le vendeur fixe son prix ; le client voit ce prix + frais plateforme (5 % par défaut),
 *    qui reviennent à la plateforme. Le vendeur reçoit son prix, sans commission.
 *  - Chaque vendeur gère et facture sa livraison (frais intégralement pour lui).
 *  - Paiement : totalité en ligne, moitié en ligne + solde à la livraison,
 *    ou paiement à la livraison avec acompte en ligne (10 %). Le solde est encaissé par le vendeur.
 */
export const PAYMENT_PLANS = {
  full: 'Paiement de la totalité en ligne',
  half: 'Moitié en ligne, le reste à la livraison',
  deposit: 'Paiement à la livraison (acompte en ligne)',
};

export async function pricingRates() {
  const s = await getSettings();
  return {
    fee: Number(s.platform_fee_rate ?? 5),
    deposit: Number(s.deposit_rate ?? 10),
    half: Number(s.half_payment_rate ?? 50),
    cashOnDelivery: String(s.payment_methods || '').split(',').includes('cash_on_delivery'),
  };
}

/** Prix affiché au client à partir du prix vendeur (arrondi au franc). */
export const withFee = (sellerPrice, feeRate) => Math.round(Number(sellerPrice) * (1 + Number(feeRate) / 100));

const isAbidjan = (city) => /abidjan/i.test(city || '');

/** Modes et frais de livraison proposés par une boutique pour une adresse donnée. */
export function deliveryOptions(shop, city, subtotal) {
  const threshold = Number(shop.free_delivery_threshold || 0);
  const free = threshold > 0 && subtotal >= threshold;
  const base = free ? 0 : Number(isAbidjan(city) ? shop.delivery_fee_abidjan : shop.delivery_fee_other);
  const options = [
    { mode: 'home', label: 'Livraison à domicile', fee: base },
    { mode: 'office', label: 'Livraison au bureau', fee: base },
  ];
  if (shop.allow_shop_pickup) options.push({ mode: 'shop_pickup', label: 'Retrait en boutique', fee: 0 });
  return options;
}

export function deliveryFee(shop, city, mode, subtotal) {
  const option = deliveryOptions(shop, city, subtotal).find((o) => o.mode === mode);
  return option ? option.fee : null;
}

/**
 * Montants d'une commande. subtotal : prix clients ; discount : remise promo (à la charge de la plateforme).
 * Renvoie le total, la part payée en ligne (upfront) et le solde réglé au vendeur à la livraison (balance).
 */
export function paymentSplit({ subtotal, discount = 0, delivery, plan, rates }) {
  const total = money(subtotal - discount + delivery);
  let upfront = total;
  if (plan === 'half') upfront = Math.round((total * rates.half) / 100);
  if (plan === 'deposit') upfront = Math.max(1, Math.round(((subtotal - discount) * rates.deposit) / 100));
  upfront = Math.min(upfront, total);
  return { total, upfront, balance: money(total - upfront) };
}
