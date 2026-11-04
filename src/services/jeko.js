import crypto from 'node:crypto';
import env from '../config/env.js';
import { ApiError } from '../utils/http.js';

/**
 * Client de la Partner API Jèko (https://api.jeko.africa).
 * Montants en centimes : 1 XOF = 100 centimes. Les secrets restent dans backend/.env.
 */

// Codes internes → codes Jèko
export const JEKO_METHODS = { orange_money: 'orange', mtn_momo: 'mtn', wave: 'wave', moov_money: 'moov' };
// Opérateurs qui confirment par USSD (demande de code sur le téléphone, pas de page à ouvrir)
export const USSD_METHODS = ['mtn_momo', 'moov_money'];

const ERROR_MESSAGES = {
  monthly_collection_limit_exceeded: 'Le plafond mensuel d’encaissement de la plateforme est atteint. Réessayez plus tard.',
  third_party_payment_provider_error: 'L’opérateur n’a pas pu traiter la demande. Vérifiez le numéro et réessayez.',
  insufficient_balance: 'Solde Jèko insuffisant pour effectuer ce virement.',
  business_not_enabled_for_api_access: 'L’accès API Jèko n’est pas encore activé pour ce compte.',
  unauthorized: 'Clés API Jèko invalides.',
};

export const toCents = (amount) => Math.round(Number(amount) * 100);
export const fromCents = (cents) => Number(cents) / 100;

/** Numéro ivoirien au format Jèko : +225 suivi de 01, 05 ou 07 et huit chiffres. */
export function jekoPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00225')) d = d.slice(5);
  else if (d.startsWith('225')) d = d.slice(3);
  return /^(01|05|07)\d{8}$/.test(d) ? `+225${d}` : null;
}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(`${env.jeko.baseUrl}${path}`, {
      method,
      headers: {
        'X-API-KEY': env.jeko.apiKey,
        'X-API-KEY-ID': env.jeko.apiKeyId,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    console.error('[JEKO]', method, path, e.message);
    throw new ApiError(502, 'Le service de paiement est momentanément indisponible. Réessayez.');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* corps non JSON */ }
  if (!res.ok) {
    console.error('[JEKO]', method, path, res.status, text.slice(0, 500));
    const id = data?.id;
    // Erreurs de validation : sous extras.errors ou directement sous errors selon la réponse
    const list = data?.extras?.errors || data?.errors;
    const details = Array.isArray(list) ? list.map((e) => e.message).join(', ') : '';
    const err = new ApiError(res.status >= 500 ? 502 : 400,
      ERROR_MESSAGES[id] || (details ? `Paiement refusé : ${details}` : 'Le service de paiement a refusé la demande.'));
    err.jekoId = id;
    throw err;
  }
  return data;
}

/** Demande de paiement en mode direct : le payeur est envoyé chez son opérateur (ou reçoit un USSD). */
export function createPaymentRequest({ amount, reference, method, payerPhone, successUrl, errorUrl }) {
  return call('POST', '/partner_api/payment_requests', {
    storeId: env.jeko.storeId,
    amountCents: toCents(amount),
    currency: 'XOF',
    reference,
    paymentDetails: {
      type: 'redirect',
      data: { paymentMethod: JEKO_METHODS[method], forceProviderDirect: true, payerPhone, successUrl, errorUrl },
    },
  });
}

export const getPaymentRequest = (id) => call('GET', `/partner_api/payment_requests/${encodeURIComponent(id)}`);

/** Virement Mobile Money (remboursement client ou reversement vendeur), bénéficiaire inline. */
export function createTransfer({ amount, reference, method, phone, name, description }) {
  return call('POST', '/partner_api/transfers', {
    storeId: env.jeko.storeId,
    amountCents: toCents(amount),
    currency: 'XOF',
    reference,
    description: description?.slice(0, 255),
    name: String(name || 'Bénéficiaire').slice(0, 255),
    paymentMethod: JEKO_METHODS[method],
    identifier: { reference: phone },
  });
}

/** Solde disponible du magasin, en centimes (reçoit les encaissements, finance remboursements et reversements). */
export async function getStoreBalance() {
  const b = await call('GET', `/partner_api/stores/${encodeURIComponent(env.jeko.storeId)}/balance`);
  return Number(b?.amount ?? 0);
}

export const getTransfer = (id) => call('GET', `/partner_api/transfers/${encodeURIComponent(id)}`);

/** En-tête Jeko-Signature : HMAC-SHA256 hexadécimal du corps brut, comparé en temps constant. */
export function verifyJekoSignature(rawBody, signature) {
  if (!rawBody || !signature || !/^[0-9a-f]+$/i.test(String(signature))) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', env.jeko.webhookSecret).update(rawBody).digest('hex'), 'hex');
  const given = Buffer.from(String(signature), 'hex');
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
