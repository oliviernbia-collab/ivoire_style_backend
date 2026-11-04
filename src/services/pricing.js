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
    refundFee: Number(s.refund_fee_rate ?? 3),
  };
}

/**
 * Remboursement : la plateforme conserve refund_fee_rate % (3 % par défaut) de la somme à rembourser.
 * Renvoie { fee, amount } : frais conservés et montant versé au client (arrondis au franc).
 */
export function refundSplit(total, feeRate) {
  const fee = Math.round((Number(total) * Number(feeRate)) / 100);
  return { fee, amount: money(Number(total) - fee) };
}

/** Prix affiché au client à partir du prix vendeur (arrondi au franc). */
export const withFee = (sellerPrice, feeRate) => Math.round(Number(sellerPrice) * (1 + Number(feeRate) / 100));

/** Nom de commune / ville normalisé pour la comparaison : « Port-Bouët » = « port bouet ». */
export const zoneKey = (name) => String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export const isAbidjan = (city) => zoneKey(city).includes('abidjan');

/** Tarifs par zone d'une boutique (communes d'Abidjan et villes). */
export async function loadDeliveryZones(executor, shopId) {
  const [rows] = await executor.query(
    `SELECT zone_type, name, name_key, fee, delivers FROM shop_delivery_zones WHERE shop_id = ? ORDER BY zone_type, name`, [shopId]);
  return rows;
}

/**
 * Tarif de livraison pour une adresse : commune (à Abidjan) ou ville, sinon tarif par défaut de la boutique.
 * Renvoie { fee, zone (libellé), delivers }.
 */
export function resolveDelivery(shop, zones, { city, commune }) {
  const abidjan = isAbidjan(city);
  const type = abidjan ? 'commune' : 'city';
  const key = zoneKey(abidjan ? commune : city);
  const zone = key ? (zones || []).find((z) => z.zone_type === type && z.name_key === key) : null;
  const fallback = Number(abidjan ? shop.delivery_fee_abidjan : shop.delivery_fee_other);
  return {
    fee: zone && zone.fee != null ? Number(zone.fee) : fallback,
    zone: zone?.name || (abidjan ? (commune ? `${commune}, Abidjan` : 'Abidjan') : city || ''),
    delivers: zone ? Boolean(zone.delivers) : true,
  };
}

/** Modes et frais de livraison proposés par une boutique pour une adresse { city, commune }. */
export function deliveryOptions(shop, address, subtotal, zones = []) {
  const threshold = Number(shop.free_delivery_threshold || 0);
  const free = threshold > 0 && subtotal >= threshold;
  const rule = resolveDelivery(shop, zones, address);
  const fee = free ? 0 : rule.fee;
  // Zone non desservie : seul le retrait en boutique reste possible
  const options = rule.delivers ? [
    { mode: 'home', label: 'Livraison à domicile', fee, zone: rule.zone },
    { mode: 'office', label: 'Livraison au bureau', fee, zone: rule.zone },
  ] : [];
  if (shop.allow_shop_pickup) options.push({ mode: 'shop_pickup', label: 'Retrait en boutique', fee: 0 });
  return options;
}

export function deliveryFee(shop, address, mode, subtotal, zones = []) {
  const option = deliveryOptions(shop, address, subtotal, zones).find((o) => o.mode === mode);
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
