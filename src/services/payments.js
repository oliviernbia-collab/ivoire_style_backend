import crypto from 'node:crypto';
import env from '../config/env.js';
import { pool, query, queryOne, transaction } from '../config/db.js';
import { badRequest, notFound, unauthorized } from '../utils/http.js';
import { money, randomCode } from '../utils/helpers.js';
import { pricingRates, refundSplit } from './pricing.js';
import { confirmOrder } from './orders.js';
import { getSettings, notify, notifyAdmins } from './common.js';
import * as jeko from './jeko.js';

/**
 * Paiements des commandes, remboursements et reversements.
 * - PAYMENT_MODE=sandbox : parcours simulé ; la confirmation passe par un webhook signé comme en production.
 * - PAYMENT_MODE=jeko    : encaissement via l'API Jèko (mode direct), confirmé par le webhook Jèko
 *   ou par interrogation de l'API ; remboursements et reversements par virement Mobile Money.
 */
export const isJeko = () => env.payment.mode === 'jeko';

export function signPayload(rawBody) {
  return crypto.createHmac('sha256', env.payment.webhookSecret).update(rawBody).digest('hex');
}

export function verifySignature(rawBody, signature) {
  if (!signature || !rawBody) return false;
  const expected = Buffer.from(signPayload(rawBody), 'hex');
  const given = Buffer.from(String(signature), 'hex');
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** Statuts d'un paiement déjà traité : un nouvel événement de succès est sans effet. */
const SETTLED = ['succeeded', 'refunding', 'partially_refunded', 'refunded'];

// =====================================================================
// Résultat d'un paiement (commun sandbox / Jèko)
// =====================================================================

/** Paiement encaissé. Si la commande n'attend plus ce paiement (annulée, déjà payée), il est mis à rembourser. */
async function applyPaymentSuccess(conn, payment, order, { transactionId = null, payerAccount = null } = {}) {
  const awaiting = order.status === 'pending' && !['succeeded', 'partially_paid'].includes(order.payment_status);
  if (!awaiting) {
    await conn.query(`UPDATE payments SET status = 'refunding', provider_transaction_id = COALESCE(?, provider_transaction_id),
       payer_account = COALESCE(?, payer_account), confirmed_at = NOW() WHERE id = ?`, [transactionId, payerAccount, payment.id]);
    await conn.query(
      `INSERT INTO refunds (payment_id, order_id, reference, amount, reason, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
      [payment.id, order.id, `REF-${randomCode(10)}`, payment.amount,
        order.status === 'cancelled' ? 'Paiement reçu après annulation' : 'Paiement en double'],
    );
    return { status: 'refund_required', order };
  }
  await conn.query(
    // provider_reference (demande de paiement Jèko) est conservé ; payer_account = numéro réellement débité
    `UPDATE payments SET status = 'succeeded', provider_transaction_id = COALESCE(?, provider_transaction_id),
       payer_account = COALESCE(?, payer_account), confirmed_at = NOW(), failure_reason = NULL WHERE id = ?`,
    [transactionId, payerAccount, payment.id]);
  // Totalité payée → « succeeded » ; moitié ou acompte → « partially_paid » (solde réglé au vendeur à la livraison)
  const partial = Number(order.balance_amount) > 0;
  await conn.query(`UPDATE orders SET payment_status = ?, paid_at = IF(?, paid_at, NOW()) WHERE id = ?`,
    [partial ? 'partially_paid' : 'succeeded', partial, order.id]);
  // Les autres tentatives restent payables chez Jèko pendant 30 min : un paiement tardif sera remboursé (ci-dessus)
  await conn.query(`UPDATE payments SET status = 'cancelled' WHERE order_id = ? AND id <> ? AND status IN ('initiated','pending')`, [order.id, payment.id]);
  await confirmOrder(conn, order.id, null, `Paiement confirmé (${payment.reference})`);
  await notify(order.user_id, {
    type: 'payment',
    title: partial ? 'Acompte confirmé' : 'Paiement confirmé',
    body: partial
      ? `Votre paiement en ligne pour la commande ${order.order_number} est confirmé. Le solde sera à régler au vendeur à la livraison.`
      : `Votre paiement pour la commande ${order.order_number} a été confirmé.`,
    link: `/compte/commandes/${order.id}`,
  }, conn);
  return { status: 'succeeded' };
}

async function applyPaymentFailure(conn, payment, order, status, reason) {
  await conn.query(`UPDATE payments SET status = ?, failure_reason = ? WHERE id = ?`, [status, reason || null, payment.id]);
  await conn.query(`UPDATE orders SET payment_status = 'failed' WHERE id = ? AND status = 'pending' AND payment_status IN ('initiated','pending')`, [order.id]);
  await notify(order.user_id, {
    type: 'payment',
    title: 'Paiement non abouti',
    body: `Le paiement de la commande ${order.order_number} n’a pas abouti. Vous pouvez réessayer.`,
    link: `/compte/commandes/${order.id}`,
  }, conn);
  return { status };
}

/** Paiement arrivé alors que la commande ne l'attendait plus (annulée, déjà payée) : remboursement automatique. */
async function alertLateRefund(result) {
  if (result?.status !== 'refund_required') return;
  await autoRefund(result.order.id, 'Paiement reçu alors que la commande ne l’attendait plus');
}

/** Message affiché après une annulation, selon l'issue du remboursement automatique. */
export function refundMessage(refund, base, forAdmin = false) {
  if (!refund) return base;
  // Frais de remboursement conservés par la plateforme (3 % par défaut)
  const fee = refund.fee > 0 ? ` (${refund.fee} FCFA de frais de remboursement retenus)` : '';
  if (refund.status === 'succeeded') {
    return forAdmin ? `${base} : client remboursé de ${refund.amount} FCFA${fee}` : `${base}. ${refund.amount} FCFA vous ont été remboursés${fee}.`;
  }
  if (refund.status === 'processing') {
    return forAdmin ? `${base} : virement de ${refund.amount} FCFA envoyé au client${fee}`
      : `${base}. Remboursement de ${refund.amount} FCFA envoyé sur votre compte Mobile Money${fee}.`;
  }
  if (refund.status === 'waiting') {
    return forAdmin ? `${base} : remboursement de ${refund.amount} FCFA en attente de solde Jèko (relance automatique)${fee}`
      : `${base}. Votre remboursement de ${refund.amount} FCFA sera envoyé automatiquement sur votre compte Mobile Money${fee}.`;
  }
  return forAdmin ? `${base} : remboursement automatique impossible, à traiter` : `${base}. Votre remboursement sera traité par notre équipe.`;
}

/**
 * Remboursement automatique de la part payée en ligne (annulation par le client ou l'administration,
 * paiement tardif ou en double). Ne bloque jamais l'annulation : en cas d'échec, l'administration est
 * prévenue et le remboursement reste « à traiter » (bouton Rembourser).
 */
export async function autoRefund(orderId, reason = 'Commande annulée') {
  const pending = await queryOne(`SELECT id FROM refunds WHERE order_id = ? AND status = 'pending' LIMIT 1`, [orderId]);
  if (!pending) return null;
  try {
    return await requestRefund(orderId, { reason }, null);
  } catch (e) {
    const order = await queryOne(`SELECT order_number FROM orders WHERE id = ?`, [orderId]);
    console.error('[REMBOURSEMENT AUTO]', order?.order_number, e.message);
    if (!e.adminsNotified) await notifyAdmins({
      type: 'refund',
      title: 'Remboursement automatique impossible',
      body: `Commande ${order?.order_number} : ${e.message} Remboursez depuis le détail de la commande.`,
      link: `/admin/commandes/${orderId}`,
    });
    return { status: 'failed', error: e.message };
  }
}

// =====================================================================
// Sandbox
// =====================================================================

export function providerInstructions() {
  return { type: 'sandbox', message: 'Mode démonstration : aucun débit réel. Validez ou refusez la transaction simulée.' };
}

/** Webhook du mode sandbox : signature, idempotence (event_id unique), contrôle du montant. */
export async function processWebhook(provider, rawBody, signature) {
  const valid = verifySignature(rawBody, signature);
  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw badRequest('Charge utile invalide');
  }
  if (!valid) {
    console.warn('[WEBHOOK] signature invalide', provider, event?.event_id);
    throw unauthorized('Signature invalide');
  }
  const { event_id: eventId, type, reference, amount, currency, provider_reference: providerRef, reason } = event;
  if (!eventId || !type || !reference) throw badRequest('Événement incomplet');

  const result = await transaction(async (conn) => {
    const [[payment]] = await conn.query(`SELECT * FROM payments WHERE reference = ? FOR UPDATE`, [reference]);
    const [ins] = await conn.query(
      `INSERT IGNORE INTO payment_events (payment_id, provider, event_id, event_type, payload, signature_valid)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [payment?.id || null, provider, eventId, type, rawBody.toString('utf8')]);
    if (ins.affectedRows === 0) return { duplicate: true };
    if (!payment) throw badRequest('Référence de paiement inconnue');
    if (payment.provider !== provider) throw badRequest('Prestataire incohérent');
    if (SETTLED.includes(payment.status)) return { ignored: true, status: payment.status };

    const [[order]] = await conn.query(`SELECT * FROM orders WHERE id = ? FOR UPDATE`, [payment.order_id]);
    let r = { ignored: true };
    if (type === 'payment.succeeded') {
      if (Number(amount) !== Number(payment.amount) || (currency || 'XOF') !== payment.currency) {
        await conn.query(`UPDATE payments SET status = 'failed', failure_reason = 'Montant incohérent' WHERE id = ?`, [payment.id]);
        throw badRequest('Montant ou devise incohérent');
      }
      r = await applyPaymentSuccess(conn, payment, order, { transactionId: providerRef });
    } else if (type === 'payment.failed' || type === 'payment.cancelled') {
      r = await applyPaymentFailure(conn, payment, order, type === 'payment.failed' ? 'failed' : 'cancelled', reason);
    }
    await conn.query(`UPDATE payment_events SET processed_at = NOW() WHERE provider = ? AND event_id = ?`, [provider, eventId]);
    return r;
  });
  await alertLateRefund(result);
  return result;
}

/** Mode sandbox : fabrique un webhook signé comme le ferait le prestataire. */
export async function simulateProviderCallback(paymentId, outcome) {
  if (env.payment.mode !== 'sandbox') throw badRequest('Simulation indisponible');
  const payment = await queryOne(`SELECT * FROM payments WHERE id = ?`, [paymentId]);
  const body = JSON.stringify({
    event_id: `sbx_${crypto.randomUUID()}`,
    type: outcome === 'success' ? 'payment.succeeded' : 'payment.failed',
    reference: payment.reference,
    amount: Number(payment.amount),
    currency: payment.currency,
    provider_reference: `SBX-${Date.now()}`,
    reason: outcome === 'success' ? undefined : 'Transaction refusée par l’utilisateur (simulation)',
  });
  const raw = Buffer.from(body);
  return processWebhook(payment.provider, raw, signPayload(raw));
}

// =====================================================================
// Jèko : encaissement
// =====================================================================

/**
 * Lance la tentative chez Jèko (une référence par tentative : un échec opérateur la consomme).
 * returnTo : « web » (pages du site) ou « app » (lien profond de l'application mobile).
 */
export async function startJekoPayment(payment, order, phone, returnTo = 'web') {
  // Jèko n'accepte que des URL publiques : le retour passe par l'API (API_PUBLIC_URL), qui redirige
  // ensuite vers la page de paiement du site ou de l'application (voir GET /payments/return)
  const back = `${env.publicUrl}/api/v1/payments/return?p=${payment.id}&c=${order.id}&to=${returnTo === 'app' ? 'app' : 'web'}`;
  let pr;
  try {
    pr = await jeko.createPaymentRequest({
      amount: payment.amount, reference: payment.reference, method: payment.provider, payerPhone: phone,
      successUrl: back, errorUrl: `${back}&e=1`,
    });
  } catch (e) {
    await query(`UPDATE payments SET status = 'failed', failure_reason = ? WHERE id = ?`, [e.message.slice(0, 255), payment.id]);
    throw e;
  }
  await query(`UPDATE payments SET status = 'pending', provider_reference = ?, checkout_url = ? WHERE id = ?`,
    [pr.id, pr.redirectUrl || null, payment.id]);
  const ussd = jeko.USSD_METHODS.includes(payment.provider);
  return {
    type: ussd ? 'ussd' : 'redirect',
    url: ussd ? null : pr.redirectUrl,
    message: ussd
      ? 'Une demande de validation a été envoyée sur votre téléphone : composez votre code secret pour confirmer.'
      : 'Vous allez être redirigé vers votre opérateur pour valider le paiement.',
  };
}

/** Interroge Jèko pour un paiement en attente (un échec n'envoie aucun webhook). */
export async function syncJekoPayment(paymentId) {
  if (!isJeko()) return null;
  const p = await queryOne(`SELECT * FROM payments WHERE id = ?`, [paymentId]);
  if (!p?.provider_reference || !['pending', 'failed'].includes(p.status)) return p;
  let pr;
  try {
    pr = await jeko.getPaymentRequest(p.provider_reference);
  } catch {
    return p; // Jèko injoignable : on réessaiera
  }
  if (pr.status === 'success') {
    const result = await transaction(async (conn) => {
      const [[payment]] = await conn.query(`SELECT * FROM payments WHERE id = ? FOR UPDATE`, [p.id]);
      if (SETTLED.includes(payment.status)) return null;
      const paid = pr.transaction?.amount?.amount;
      if (paid != null && Number(paid) !== jeko.toCents(payment.amount)) {
        console.error('[JEKO] montant incohérent', payment.reference, paid);
        return null;
      }
      const [[order]] = await conn.query(`SELECT * FROM orders WHERE id = ? FOR UPDATE`, [payment.order_id]);
      return applyPaymentSuccess(conn, payment, order,
        { transactionId: pr.transaction?.id || null, payerAccount: pr.transaction?.counterpartIdentifier || null });
    });
    await alertLateRefund(result);
  } else if (pr.status === 'error' && p.status === 'pending') {
    // « Payment request has expired » n'est pas définitif : un succès tardif reste possible (webhook)
    await transaction(async (conn) => {
      const [[payment]] = await conn.query(`SELECT * FROM payments WHERE id = ? FOR UPDATE`, [p.id]);
      if (payment.status !== 'pending') return;
      const [[order]] = await conn.query(`SELECT * FROM orders WHERE id = ? FOR UPDATE`, [payment.order_id]);
      await applyPaymentFailure(conn, payment, order, 'failed', pr.errorReason || 'Paiement refusé par l’opérateur');
    });
  }
  return queryOne(`SELECT * FROM payments WHERE id = ?`, [p.id]);
}

/** Avant d'annuler les commandes non payées : dernière vérification des tentatives en cours chez Jèko. */
export async function syncPendingJekoPayments() {
  if (!isJeko()) return;
  const rows = await query(
    `SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE p.status = 'pending' AND p.provider_reference IS NOT NULL AND o.status = 'pending'`);
  for (const r of rows) await syncJekoPayment(r.id);
}

/** Webhook Jèko (TRANSACTION_COMPLETED) : encaissements réussis, virements réussis ou échoués. */
export async function processJekoWebhook(rawBody, signature, eventName) {
  if (!jeko.verifyJekoSignature(rawBody, signature)) {
    console.warn('[JEKO] webhook : signature invalide');
    throw unauthorized('Signature invalide');
  }
  let tx;
  try {
    tx = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw badRequest('Charge utile invalide');
  }
  if (eventName && eventName !== 'TRANSACTION_COMPLETED') return { ignored: true };
  if (tx.storeId && tx.storeId !== env.jeko.storeId) return { ignored: true };
  const reference = tx.transactionDetails?.reference;
  if (!tx.id || !reference) return { ignored: true };

  const ins = await query(
    `INSERT IGNORE INTO payment_events (provider, event_id, event_type, payload, signature_valid) VALUES ('jeko', ?, ?, ?, 1)`,
    [`${tx.id}:${tx.status}`, `${tx.transactionType}.${tx.status}`, rawBody.toString('utf8')]);
  if (ins.affectedRows === 0) return { duplicate: true };

  let result = { ignored: true };
  if (tx.transactionType === 'payment' && tx.status === 'success') {
    result = await transaction(async (conn) => {
      const [[payment]] = await conn.query(`SELECT * FROM payments WHERE reference = ? FOR UPDATE`, [reference]);
      if (!payment) return { ignored: true, reason: 'référence inconnue' };
      await conn.query(`UPDATE payment_events SET payment_id = ? WHERE provider = 'jeko' AND event_id = ?`, [payment.id, `${tx.id}:${tx.status}`]);
      if (SETTLED.includes(payment.status)) return { ignored: true, status: payment.status };
      const cents = jeko.toCents(payment.amount);
      const gross = Number(tx.amount?.amount);
      const net = gross + Number(tx.fees?.amount || 0);
      if (gross !== cents && net !== cents) {
        console.error('[JEKO] montant incohérent', reference, tx.amount, tx.fees);
        return { ignored: true, reason: 'montant incohérent' };
      }
      const [[order]] = await conn.query(`SELECT * FROM orders WHERE id = ? FOR UPDATE`, [payment.order_id]);
      return applyPaymentSuccess(conn, payment, order, { transactionId: tx.id, payerAccount: tx.counterpartIdentifier || null });
    });
    await alertLateRefund(result);
  } else if (tx.transactionType === 'transfer') {
    result = await applyTransferResult(reference, tx.status, tx.id, tx.description);
  }
  await query(`UPDATE payment_events SET processed_at = NOW() WHERE provider = 'jeko' AND event_id = ?`, [`${tx.id}:${tx.status}`]);
  return result;
}

// =====================================================================
// Remboursements
// =====================================================================

/** Comptabilise un remboursement effectif : statuts commande / paiement, annulation du crédit vendeur. */
async function finalizeRefund(conn, refundId, actorId) {
  const [[refund]] = await conn.query(`SELECT * FROM refunds WHERE id = ? FOR UPDATE`, [refundId]);
  if (!refund || refund.status === 'succeeded') return null;
  const [[payment]] = await conn.query(`SELECT * FROM payments WHERE id = ? FOR UPDATE`, [refund.payment_id]);
  const [[order]] = await conn.query(`SELECT * FROM orders WHERE id = ? FOR UPDATE`, [refund.order_id]);
  await conn.query(`UPDATE refunds SET status = 'succeeded', failure_reason = NULL WHERE id = ?`, [refund.id]);
  // Remboursé intégralement = sommes versées + frais de remboursement conservés par la plateforme
  const [[{ done }]] = await conn.query(
    `SELECT COALESCE(SUM(amount + fee_amount), 0) AS done FROM refunds WHERE payment_id = ? AND status = 'succeeded'`, [payment.id]);
  const full = Number(done) >= Number(payment.amount);
  await conn.query(`UPDATE payments SET status = ? WHERE id = ?`, [full ? 'refunded' : 'partially_refunded', payment.id]);
  // Un paiement tardif ou en double ne change pas le statut de la commande
  if (payment.status !== 'refunding' || order.status === 'refunding') {
    await conn.query(`UPDATE orders SET payment_status = ?, status = IF(?, 'refunded', status) WHERE id = ?`,
      [full ? 'refunded' : 'partially_refunded', full, order.id]);
    if (full) {
      // Annule le crédit vendeur déjà enregistré pour cette commande (montant reçu via la plateforme)
      const [[credit]] = await conn.query(
        `SELECT shop_id, COALESCE(SUM(amount), 0) AS amount FROM seller_ledger_entries
          WHERE order_id = ? AND entry_type IN ('sale', 'commission') GROUP BY shop_id`, [order.id]);
      if (credit && Number(credit.amount) !== 0) {
        await conn.query(
          `INSERT INTO seller_ledger_entries (shop_id, order_id, entry_type, amount, description) VALUES (?, ?, 'refund', ?, ?)`,
          [credit.shop_id, order.id, -Number(credit.amount), `Remboursement commande ${order.order_number}`]);
      }
      await conn.query(`UPDATE order_items SET fulfillment_status = 'refunded' WHERE order_id = ? AND fulfillment_status <> 'cancelled'`, [order.id]);
      await conn.query(`UPDATE return_requests SET status = 'refunded' WHERE order_id = ? AND status = 'accepted'`, [order.id]);
    }
  }
  const feeNote = Number(refund.fee_amount) > 0 ? ` (frais de remboursement de ${money(refund.fee_amount)} FCFA retenus)` : '';
  await conn.query(`INSERT INTO order_status_history (order_id, status, comment, changed_by) VALUES (?, ?, ?, ?)`,
    [order.id, full ? 'refunded' : 'partially_refunded', `Remboursement de ${money(refund.amount)} FCFA${feeNote} : ${refund.reason || ''}`, actorId || null]);
  await notify(order.user_id, {
    type: 'refund', title: 'Remboursement effectué',
    body: `${money(refund.amount)} FCFA ont été remboursés pour la commande ${order.order_number}${feeNote}.`,
    link: `/compte/commandes/${order.id}`,
  }, conn);
  return { amount: Number(refund.amount), fee: Number(refund.fee_amount), full };
}

/**
 * Remboursement demandé par l'administration, dans la limite du paiement d'origine.
 * Sandbox : effectif immédiatement. Jèko : virement vers le numéro qui a payé, confirmé par webhook.
 */
export async function requestRefund(orderId, { amount: wanted, reason }, actorId) {
  const prepared = await transaction(async (conn) => {
    const [[order]] = await conn.query(`SELECT * FROM orders WHERE id = ? FOR UPDATE`, [orderId]);
    if (!order) throw notFound('Commande introuvable');
    const [[payment]] = await conn.query(
      `SELECT * FROM payments WHERE order_id = ? AND status IN ('succeeded','refunding','partially_refunded')
        ORDER BY status = 'refunding' DESC, id DESC LIMIT 1 FOR UPDATE`,
      [order.id]);
    if (!payment) throw badRequest('Aucun paiement confirmé à rembourser');
    // Déjà engagé : sommes versées ou en cours de virement + frais déjà retenus
    const [[{ engaged }]] = await conn.query(
      `SELECT COALESCE(SUM(amount + fee_amount), 0) AS engaged FROM refunds WHERE payment_id = ? AND status IN ('succeeded','processing')`, [payment.id]);
    const remaining = money(Number(payment.amount) - Number(engaged));
    if (remaining <= 0) throw badRequest('Ce paiement est déjà remboursé ou en cours de remboursement');
    // Montant libre saisi par l'administration : versé tel quel. Sinon : reste à rembourser moins les frais (3 %).
    let amount;
    let fee = 0;
    if (wanted != null) {
      amount = money(wanted);
      if (amount > remaining) throw badRequest(`Montant supérieur au reste remboursable (${remaining} FCFA)`);
    } else {
      ({ amount, fee } = refundSplit(remaining, (await pricingRates()).refundFee));
    }
    // Une demande en attente ou en échec pour ce paiement (ex. créée à l'annulation) est reprise
    const [[pending]] = await conn.query(
      `SELECT id FROM refunds WHERE payment_id = ? AND status IN ('pending','failed') ORDER BY id LIMIT 1 FOR UPDATE`, [payment.id]);
    let refundId = pending?.id;
    // Nouvelle référence à chaque envoi : Jèko refuse une référence déjà utilisée
    const reference = `REF-${randomCode(10)}`;
    if (refundId) {
      await conn.query(`UPDATE refunds SET status = 'processing', reference = ?, amount = ?, fee_amount = ?, failure_reason = NULL,
          reason = COALESCE(?, reason), created_by = ? WHERE id = ?`, [reference, amount, fee, reason, actorId, refundId]);
    } else {
      const [r] = await conn.query(
        `INSERT INTO refunds (payment_id, order_id, reference, amount, fee_amount, reason, status, created_by) VALUES (?, ?, ?, ?, ?, ?, 'processing', ?)`,
        [payment.id, order.id, reference, amount, fee, reason, actorId]);
      refundId = r.insertId;
    }
    if (!isJeko()) return { refundId, amount, fee, done: await finalizeRefund(conn, refundId, actorId) };
    const [[user]] = await conn.query(`SELECT first_name, last_name, phone FROM users WHERE id = ?`, [order.user_id]);
    return { refundId, amount, fee, reference, payment, order, user };
  });
  if (prepared.done) return { amount: prepared.amount, fee: prepared.fee, status: 'succeeded', full: prepared.done.full };
  return { ...await sendRefund(prepared, actorId), fee: prepared.fee };
}

/** Jèko : envoi du virement de remboursement (contrôles du numéro, du minimum et du solde). */
async function sendRefund({ refundId, amount, reference, payment, order, user }, actorId) {
  // Le remboursement part sur le compte réellement débité, jamais sur un numéro deviné
  const phone = await payerAccount(payment);
  if (!phone || !jeko.JEKO_METHODS[payment.provider]) {
    await query(`UPDATE refunds SET status = 'failed', failure_reason = ? WHERE id = ?`, ['Compte Mobile Money du payeur inconnu', refundId]);
    throw badRequest('Compte Mobile Money du payeur introuvable chez Jèko : remboursez-le manuellement.');
  }
  // Jèko refuse les virements de moins de 5 FCFA (500 centimes)
  if (jeko.toCents(amount) < 500) {
    await query(`UPDATE refunds SET status = 'failed', failure_reason = ? WHERE id = ?`, ['Montant inférieur au minimum Jèko (5 FCFA)', refundId]);
    throw badRequest(`Montant de ${amount} FCFA inférieur au minimum de virement Jèko (5 FCFA) : remboursez manuellement.`);
  }
  // Solde du magasin insuffisant : le remboursement attend et sera relancé automatiquement
  const balance = await jeko.getStoreBalance().catch(() => null);
  if (balance != null && balance < jeko.toCents(amount)) return waitForBalance(refundId, amount, order, balance);
  return sendTransfer('refund', refundId, {
    amount, reference, method: payment.provider, phone, name: `${user.first_name} ${user.last_name}`,
    description: `Remboursement commande ${order.order_number}`,
  }, actorId);
}

/**
 * Numéro qui reçoit le remboursement, par ordre de priorité :
 * 1. payer_account : numéro confirmé par le client à l'annulation (ou corrigé par l'administration) ;
 * 2. numéro du payeur enregistré par Jèko ;
 * 3. numéro saisi au paiement.
 * Avec Wave et Orange, l'opérateur ne transmet pas le compte réellement débité : Jèko enregistre le numéro saisi.
 * D'où la confirmation du numéro par le client au moment de l'annulation.
 */
async function payerAccount(payment) {
  let account = jeko.jekoPhone(payment.payer_account);
  if (!account && payment.provider_reference) {
    const pr = await jeko.getPaymentRequest(payment.provider_reference).catch(() => null);
    account = jeko.jekoPhone(pr?.transaction?.counterpartIdentifier);
  }
  return account || jeko.jekoPhone(payment.payer_phone);
}

/** Remboursement en attente de solde : relancé automatiquement ; l'administration est prévenue une seule fois. */
const WAITING_BALANCE = 'En attente : solde Jèko insuffisant, nouvel essai automatique';
async function waitForBalance(refundId, amount, order, balanceCents = null) {
  const before = await queryOne(`SELECT failure_reason FROM refunds WHERE id = ?`, [refundId]);
  await query(`UPDATE refunds SET status = 'pending', failure_reason = ? WHERE id = ?`, [WAITING_BALANCE, refundId]);
  if (before?.failure_reason !== WAITING_BALANCE) {
    await notifyAdmins({
      type: 'refund', title: 'Solde Jèko insuffisant pour rembourser',
      body: `Remboursement de ${money(amount)} FCFA (commande ${order.order_number}) en attente`
        + `${balanceCents != null ? ` — solde actuel ${jeko.fromCents(balanceCents)} FCFA` : ''}. Rechargez votre magasin Jèko : il partira automatiquement.`,
      link: `/admin/commandes/${order.id}`,
    });
  }
  return { amount: Number(amount), status: 'waiting' };
}

/** Relance automatique des remboursements en attente (solde insuffisant au premier essai). */
export async function retryPendingRefunds() {
  if (!isJeko()) return 0;
  const rows = await query(
    `SELECT order_id, amount, reason FROM refunds WHERE status = 'pending' AND failure_reason = ? AND created_at > NOW() - INTERVAL 30 DAY`,
    [WAITING_BALANCE]);
  let sent = 0;
  for (const r of rows) {
    try {
      // Montant recalculé (reste à rembourser moins les frais de remboursement)
      const res = await requestRefund(r.order_id, { reason: r.reason }, null);
      if (res.status !== 'waiting') sent += 1;
    } catch (e) {
      console.error('[REMBOURSEMENT AUTO] relance', r.order_id, e.message);
    }
  }
  return sent;
}

/** Statut des virements en cours vérifié auprès de Jèko (si un webhook n'est pas arrivé, ex. tunnel coupé). */
export async function syncProcessingTransfers() {
  if (!isJeko()) return;
  const rows = [
    ...await query(`SELECT reference, provider_reference FROM refunds WHERE status = 'processing' AND provider_reference IS NOT NULL`),
    ...await query(`SELECT reference, provider_reference FROM seller_payouts WHERE status = 'pending' AND provider_reference IS NOT NULL`),
  ];
  for (const r of rows) {
    const t = await jeko.getTransfer(r.provider_reference).catch(() => null);
    if (t && t.status !== 'pending') await applyTransferResult(r.reference, t.status, t.id, t.status === 'error' ? 'Virement refusé par l’opérateur' : null);
  }
}

// =====================================================================
// Reversements vendeurs
// =====================================================================

/** Reversement marqué payé : le vendeur est prévenu. */
async function markPayoutPaid(conn, payoutId) {
  const [[p]] = await conn.query(
    `SELECT p.*, s.owner_user_id FROM seller_payouts p JOIN shops s ON s.id = p.shop_id WHERE p.id = ? FOR UPDATE`, [payoutId]);
  if (!p || p.status !== 'pending') return null;
  await conn.query(`UPDATE seller_payouts SET status = 'paid', paid_at = NOW(), failure_reason = NULL WHERE id = ?`, [p.id]);
  await notify(p.owner_user_id, {
    type: 'payout', title: 'Reversement effectué', body: `${money(p.amount)} FCFA (réf. ${p.reference})`, link: '/vendeur/finances',
  }, conn);
  return p;
}

export async function setPayoutStatus(payoutId, status, reason = null) {
  return transaction(async (conn) => {
    if (status === 'paid') return markPayoutPaid(conn, payoutId);
    const [r] = await conn.query(`UPDATE seller_payouts SET status = 'failed', failure_reason = ? WHERE id = ? AND status = 'pending'`,
      [reason, payoutId]);
    return r.affectedRows ? { id: payoutId } : null;
  });
}

/** Jèko : envoie le reversement sur le compte Mobile Money du vendeur (sinon traitement manuel). */
export async function sendPayout(payoutId, actorId) {
  if (!isJeko()) return { status: 'pending', manual: true };
  const p = await queryOne(
    `SELECT p.*, s.payout_method, s.payout_account, s.payout_holder, s.name AS shop_name
       FROM seller_payouts p JOIN shops s ON s.id = p.shop_id WHERE p.id = ?`, [payoutId]);
  const phone = jeko.jekoPhone(p.payout_account);
  if (!jeko.JEKO_METHODS[p.payout_method] || !phone) return { status: 'pending', manual: true };
  return sendTransfer('payout', payoutId, {
    amount: p.amount, reference: p.reference, method: p.payout_method, phone, name: p.payout_holder || p.shop_name,
    description: `Reversement Ivoire Style ${p.reference}`,
  }, actorId);
}

/**
 * Solde reversable d'une boutique : ventes créditées depuis au moins delayDays jours (livraison),
 * plus les écritures négatives (remboursements, ajustements), moins les reversements payés ou en cours.
 */
export async function shopPayableBalance(executor, shopId, delayDays = 0) {
  const [[r]] = await executor.query(
    `SELECT
       (SELECT COALESCE(SUM(amount), 0) FROM seller_ledger_entries WHERE shop_id = ?
          AND (entry_type NOT IN ('sale','commission') OR created_at <= NOW() - INTERVAL ? DAY)) -
       (SELECT COALESCE(SUM(amount), 0) FROM seller_payouts WHERE shop_id = ? AND status IN ('paid','pending')) AS balance`,
    [shopId, Number(delayDays) || 0, shopId]);
  return money(r.balance);
}

/** Crée un reversement (administration ou automatique), dans la limite du solde reversable. */
export async function createPayout(shopId, amount, note, actorId, { delayDays = 0 } = {}) {
  return transaction(async (conn) => {
    // Verrou sur la boutique : deux reversements simultanés ne peuvent pas dépasser le solde
    const [[shop]] = await conn.query(`SELECT * FROM shops WHERE id = ? FOR UPDATE`, [shopId]);
    if (!shop) throw notFound('Boutique introuvable');
    const balance = await shopPayableBalance(conn, shopId, delayDays);
    const value = money(amount ?? balance);
    if (value <= 0 || value > balance) throw badRequest(`Montant supérieur au solde disponible (${balance} FCFA)`);
    const reference = `PO-${randomCode(10)}`;
    const [r] = await conn.query(
      `INSERT INTO seller_payouts (shop_id, reference, amount, method, status, note, created_by) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      [shopId, reference, value, shop.payout_method, note || null, actorId || null]);
    return { id: r.insertId, reference, amount: value };
  });
}

const PAYOUT_LOW_BALANCE = 'Solde Jèko insuffisant pour les reversements';

/**
 * Reversement automatique d'une boutique (après livraison) : tout le solde reversable part par virement Jèko
 * sur son compte Mobile Money. Ignoré si désactivé, compte bancaire ou incomplet, montant < 5 FCFA,
 * ou échec récent (évite de relancer en boucle un numéro erroné). Solde Jèko insuffisant : nouvel essai plus tard.
 */
export async function autoPayoutShop(shopId) {
  if (!isJeko()) return null;
  const s = await getSettings();
  if (String(s.auto_payouts ?? '1') !== '1') return null;
  const shop = await queryOne(`SELECT id, name, status, payout_method, payout_account FROM shops WHERE id = ?`, [shopId]);
  if (!shop || !['approved', 'suspended'].includes(shop.status)) return null;
  if (!jeko.JEKO_METHODS[shop.payout_method] || !jeko.jekoPhone(shop.payout_account)) return null;
  const recentFailure = await queryOne(
    `SELECT id FROM seller_payouts WHERE shop_id = ? AND status = 'failed' AND created_at > NOW() - INTERVAL 1 DAY LIMIT 1`, [shopId]);
  if (recentFailure) return null;
  const delayDays = Number(s.payout_delay_days ?? 0);
  const balance = await shopPayableBalance(pool, shopId, delayDays);
  if (jeko.toCents(balance) < 500) return null; // minimum de virement Jèko : 5 FCFA
  const storeBalance = await jeko.getStoreBalance().catch(() => null);
  if (storeBalance != null && storeBalance < jeko.toCents(balance)) {
    // Une seule alerte par jour à l'administration
    const alerted = await queryOne(
      `SELECT id FROM notifications WHERE title = ? AND created_at > NOW() - INTERVAL 1 DAY LIMIT 1`, [PAYOUT_LOW_BALANCE]);
    if (!alerted) {
      await notifyAdmins({
        type: 'payout', title: PAYOUT_LOW_BALANCE,
        body: `${shop.name} attend ${money(balance)} FCFA (solde Jèko : ${jeko.fromCents(storeBalance)} FCFA). Le reversement partira automatiquement après rechargement.`,
        link: '/admin/reversements',
      });
    }
    return { status: 'waiting' };
  }
  let payout;
  try {
    payout = await createPayout(shopId, balance, 'Reversement automatique après livraison', null, { delayDays });
  } catch {
    return null; // solde modifié entre-temps : le prochain passage s'en chargera
  }
  return sendPayout(payout.id, null).catch((e) => {
    console.error('[REVERSEMENT AUTO]', shop.name, e.message);
    return { status: 'failed' };
  });
}

/** Passage périodique : reverse automatiquement toutes les boutiques qui ont un solde (délai de retours écoulé). */
export async function runAutoPayouts() {
  if (!isJeko()) return 0;
  const shops = await query(
    `SELECT DISTINCT e.shop_id AS id FROM seller_ledger_entries e JOIN shops s ON s.id = e.shop_id WHERE s.status IN ('approved','suspended')`);
  let sent = 0;
  for (const { id } of shops) {
    const r = await autoPayoutShop(id).catch((e) => { console.error('[REVERSEMENT AUTO]', id, e.message); return null; });
    if (r && !['waiting', 'failed'].includes(r.status)) sent += 1;
  }
  return sent;
}

// =====================================================================
// Virements Jèko (remboursements et reversements)
// =====================================================================

const TRANSFER_TABLE = { refund: 'refunds', payout: 'seller_payouts' };

async function sendTransfer(kind, id, params, actorId) {
  let t;
  try {
    t = await jeko.createTransfer(params);
  } catch (e) {
    // Solde insuffisant (frais de virement compris) : le remboursement attend, il sera relancé automatiquement
    if (kind === 'refund' && e.jekoId === 'insufficient_balance') {
      const r = await queryOne(`SELECT r.id, r.amount, o.id AS order_id, o.order_number FROM refunds r JOIN orders o ON o.id = r.order_id WHERE r.id = ?`, [id]);
      return waitForBalance(r.id, r.amount, { id: r.order_id, order_number: r.order_number });
    }
    await applyTransferResult(params.reference, 'error', null, e.message, kind);
    e.adminsNotified = true; // applyTransferResult a déjà prévenu l'administration
    throw e;
  }
  await query(`UPDATE ${TRANSFER_TABLE[kind]} SET provider_reference = ? WHERE id = ?`, [t.id, id]);
  // Sans paiement asynchrone, Jèko peut répondre directement « success » ou « error »
  if (t.status !== 'pending') await applyTransferResult(params.reference, t.status, t.id, null, kind, actorId);
  return { amount: Number(params.amount), status: t.status === 'success' ? 'succeeded' : t.status === 'error' ? 'failed' : 'processing' };
}

/** Résultat d'un virement (réponse directe ou webhook) retrouvé par sa référence. */
async function applyTransferResult(reference, status, providerRef, reason, kindHint = null, actorId = null) {
  if (status === 'pending') return { ignored: true };
  const refund = (!kindHint || kindHint === 'refund') ? await queryOne(`SELECT * FROM refunds WHERE reference = ?`, [reference]) : null;
  if (refund) {
    if (refund.status !== 'processing') return { ignored: true, status: refund.status };
    if (status === 'success') {
      await transaction((conn) => finalizeRefund(conn, refund.id, actorId));
      return { status: 'refund_succeeded' };
    }
    await query(`UPDATE refunds SET status = 'failed', failure_reason = ? WHERE id = ?`, [String(reason || 'Virement refusé').slice(0, 255), refund.id]);
    await notifyAdmins({
      type: 'refund', title: 'Remboursement échoué',
      body: `Le virement ${reference} (${money(refund.amount)} FCFA) n’a pas abouti. Relancez-le ou remboursez manuellement.`,
      link: `/admin/commandes/${refund.order_id}`,
    });
    return { status: 'refund_failed' };
  }
  const payout = (!kindHint || kindHint === 'payout') ? await queryOne(`SELECT * FROM seller_payouts WHERE reference = ?`, [reference]) : null;
  if (payout) {
    if (payout.status !== 'pending') return { ignored: true, status: payout.status };
    if (status === 'success') {
      await setPayoutStatus(payout.id, 'paid');
      return { status: 'payout_paid' };
    }
    await setPayoutStatus(payout.id, 'failed', String(reason || 'Virement refusé').slice(0, 255));
    await notifyAdmins({
      type: 'payout', title: 'Reversement échoué',
      body: `Le virement ${reference} (${money(payout.amount)} FCFA) n’a pas abouti. Vérifiez le compte du vendeur.`,
      link: '/admin/reversements',
    });
    return { status: 'payout_failed' };
  }
  if (providerRef) console.warn('[JEKO] virement inconnu', reference, providerRef);
  return { ignored: true };
}
