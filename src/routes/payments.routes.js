import { Router } from 'express';
import { z } from 'zod';
import env from '../config/env.js';
import { queryOne, transaction } from '../config/db.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { badRequest, created, notFound, ok } from '../utils/http.js';
import { createPaymentAttempt, loadOrderDetail, PAYMENT_METHODS } from '../services/orders.js';
import {
  isJeko, processJekoWebhook, processWebhook, providerInstructions, simulateProviderCallback, startJekoPayment, syncJekoPayment,
} from '../services/payments.js';
import { JEKO_METHODS, jekoPhone, USSD_METHODS } from '../services/jeko.js';
import { getSetting } from '../services/common.js';

const router = Router();

/** Webhook Jèko : authentifié par l'en-tête Jeko-Signature (HMAC-SHA256 du corps brut). */
router.post('/webhooks/jeko', async (req, res) => {
  const result = await processJekoWebhook(req.rawBody, req.headers['jeko-signature'], req.headers['jeko-event']);
  ok(res, result);
});

/** Webhooks du mode sandbox : authentifiés par signature HMAC (pas de JWT). */
router.post('/webhooks/:provider', async (req, res) => {
  const result = await processWebhook(req.params.provider, req.rawBody, req.headers['x-ivs-signature']);
  ok(res, result);
});

/**
 * Retour du client après validation chez l'opérateur (successUrl / errorUrl transmises à Jèko).
 * Redirige vers la page de paiement du site ou vers l'application mobile, qui attend la confirmation.
 * Destinations fixes (pas de redirection ouverte) ; une redirection ne prouve jamais un paiement.
 */
router.get('/return', (req, res) => {
  const p = Number(req.query.p);
  const c = Number(req.query.c);
  if (!Number.isInteger(p) || p <= 0 || !Number.isInteger(c) || c <= 0) return res.redirect(302, env.webUrl);
  const path = `paiement/${p}?commande=${c}&retour=1${req.query.e === '1' ? '&echec=1' : ''}`;
  res.redirect(302, req.query.to === 'app' ? `ivoirestyle://${path}` : `${env.webUrl}/${path}`);
});

router.use(requireAuth);

/** Nouvelle tentative de paiement pour une commande en attente. */
router.post('/initiate', validate(z.object({
  order_id: z.coerce.number().int().positive(),
  provider: z.string().optional(),
  payer_phone: z.string().trim().regex(/^\+?[0-9 ]{8,20}$/, 'Numéro Mobile Money invalide').optional(),
  return_to: z.enum(['web', 'app']).default('web'),
})), async (req, res) => {
  const order = await queryOne(`SELECT * FROM orders WHERE id = ? AND user_id = ?`, [req.valid.order_id, req.user.id]);
  if (!order) throw notFound('Commande introuvable');
  if (order.status !== 'pending' || ['succeeded', 'partially_paid'].includes(order.payment_status)) {
    throw badRequest('Cette commande ne peut plus être payée');
  }
  const provider = req.valid.provider || order.payment_method;
  const enabled = String(await getSetting('payment_methods', '')).split(',');
  if (!PAYMENT_METHODS[provider] || !enabled.includes(provider) || (isJeko() && !JEKO_METHODS[provider])) {
    throw badRequest('Moyen de paiement indisponible');
  }
  // Jèko exige un numéro ivoirien : +225 puis 01, 05 ou 07 et huit chiffres
  const phone = isJeko() ? jekoPhone(req.valid.payer_phone) : req.valid.payer_phone || null;
  if (isJeko() && !phone) {
    throw badRequest('Numéro Mobile Money invalide', { payer_phone: 'Numéro ivoirien à 10 chiffres (01, 05 ou 07…)' });
  }
  const idem = req.headers['idempotency-key'] ? `${order.id}-${String(req.headers['idempotency-key']).slice(0, 60)}` : null;
  const payment = await transaction(async (conn) => {
    const p = await createPaymentAttempt(conn, order, provider, phone, idem);
    await conn.query(`UPDATE orders SET payment_method = ?, payment_status = 'pending' WHERE id = ?`, [provider, order.id]);
    return p;
  });
  let instructions;
  if (!isJeko()) instructions = providerInstructions();
  else if (payment.status !== 'initiated') {
    // Même clé d'idempotence (double clic) : la tentative est déjà partie chez Jèko
    const ussd = USSD_METHODS.includes(payment.provider);
    instructions = { type: ussd ? 'ussd' : 'redirect', url: ussd ? null : payment.checkout_url };
  } else instructions = await startJekoPayment(payment, order, phone, req.valid.return_to);
  const fresh = await queryOne(`SELECT * FROM payments WHERE id = ?`, [payment.id]);
  created(res, { payment: fresh, instructions }, 'Paiement initié');
});

async function ownPayment(req) {
  const p = await queryOne(
    `SELECT p.* FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = ? AND o.user_id = ?`,
    [req.params.id, req.user.id]);
  if (!p) throw notFound('Paiement introuvable');
  return p;
}

// Interrogation de Jèko au plus toutes les 4 secondes par paiement (limite API : 500 requêtes / min)
const lastSync = new Map();

/** État d'un paiement. En mode Jèko, une tentative en attente est vérifiée auprès de Jèko. */
router.get('/:id', async (req, res) => {
  let p = await ownPayment(req);
  if (isJeko() && ['pending', 'failed'].includes(p.status) && p.provider_reference) {
    const last = lastSync.get(p.id) || 0;
    if (Date.now() - last > 4000) {
      lastSync.set(p.id, Date.now());
      p = (await syncJekoPayment(p.id)) || p;
    }
  }
  ok(res, p);
});

/** Sandbox uniquement : simule la validation (ou le refus) côté prestataire. */
router.post('/:id/sandbox', validate(z.object({
  outcome: z.enum(['success', 'failure']),
  payer_phone: z.string().trim().regex(/^\+?[0-9 ]{8,20}$/, 'Numéro Mobile Money invalide').optional(),
})), async (req, res) => {
  const p = await ownPayment(req);
  if (!['initiated', 'pending'].includes(p.status)) throw badRequest('Ce paiement est déjà traité');
  const result = await simulateProviderCallback(p.id, req.valid.outcome);
  const order = await loadOrderDetail(p.order_id);
  ok(res, { result, order },
    result.status === 'succeeded' ? 'Paiement confirmé ! Votre commande est validée.' : 'Le paiement a échoué. Vous pouvez réessayer.');
});

export default router;
