import crypto from 'node:crypto';
import env from '../config/env.js';
import { query, queryOne, transaction } from '../config/db.js';
import { badRequest, notFound, unauthorized } from '../utils/http.js';
import { money, randomCode } from '../utils/helpers.js';
import { confirmOrder } from './orders.js';
import { notify, notifyAdmins } from './common.js';
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
async function applyPaymentSuccess(conn, payment, order, providerRef) {
  const awaiting = order.status === 'pending' && !['succeeded', 'partially_paid'].includes(order.payment_status);
  if (!awaiting) {
    await conn.query(`UPDATE payments SET status = 'refunding', provider_reference = COALESCE(?, provider_reference), confirmed_at = NOW() WHERE id = ?`,
      [providerRef || null, payment.id]);
    await conn.query(
      `INSERT INTO refunds (payment_id, order_id, reference, amount, reason, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
      [payment.id, order.id, `REF-${randomCode(10)}`, payment.amount,
        order.status === 'cancelled' ? 'Paiement reçu après annulation' : 'Paiement en double'],
    );
    return { status: 'refund_required', order };
  }
  await conn.query(
    `UPDATE payments SET status = 'succeeded', provider_reference = COALESCE(?, provider_reference), confirmed_at = NOW(), failure_reason = NULL WHERE id = ?`,
    [providerRef || null, payment.id]);
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

async function alertLateRefund(result) {
  if (result?.status !== 'refund_required') return;
  await notifyAdmins({
    type: 'refund',
    title: 'Remboursement à traiter',
    body: `Un paiement est arrivé pour la commande ${result.order.order_number} alors qu’elle n’attendait plus de paiement.`,
    link: `/admin/commandes/${result.order.id}`,
  });
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
      r = await applyPaymentSuccess(conn, payment, order, providerRef);
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
      return applyPaymentSuccess(conn, payment, order, pr.transaction?.id || pr.id);
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
      return applyPaymentSuccess(conn, payment, order, tx.id);
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
  const [[{ done }]] = await conn.query(
    `SELECT COALESCE(SUM(amount), 0) AS done FROM refunds WHERE payment_id = ? AND status = 'succeeded'`, [payment.id]);
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
  await conn.query(`INSERT INTO order_status_history (order_id, status, comment, changed_by) VALUES (?, ?, ?, ?)`,
    [order.id, full ? 'refunded' : 'partially_refunded', `Remboursement de ${money(refund.amount)} FCFA : ${refund.reason || ''}`, actorId || null]);
  await notify(order.user_id, {
    type: 'refund', title: 'Remboursement effectué',
    body: `${money(refund.amount)} FCFA ont été remboursés pour la commande ${order.order_number}.`, link: `/compte/commandes/${order.id}`,
  }, conn);
  return { amount: Number(refund.amount), full };
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
    const [[{ engaged }]] = await conn.query(
      `SELECT COALESCE(SUM(amount), 0) AS engaged FROM refunds WHERE payment_id = ? AND status IN ('succeeded','processing')`, [payment.id]);
    const remaining = money(Number(payment.amount) - Number(engaged));
    if (remaining <= 0) throw badRequest('Ce paiement est déjà remboursé ou en cours de remboursement');
    const amount = money(wanted ?? remaining);
    if (amount > remaining) throw badRequest(`Montant supérieur au reste remboursable (${remaining} FCFA)`);
    // Une demande « pending » (créée à l'annulation) du même montant est reprise
    const [[pending]] = await conn.query(
      `SELECT id FROM refunds WHERE payment_id = ? AND status IN ('pending','failed') AND amount = ? ORDER BY id LIMIT 1 FOR UPDATE`, [payment.id, amount]);
    let refundId = pending?.id;
    // Nouvelle référence à chaque envoi : Jèko refuse une référence déjà utilisée
    const reference = `REF-${randomCode(10)}`;
    if (refundId) {
      await conn.query(`UPDATE refunds SET status = 'processing', reference = ?, reason = COALESCE(?, reason), created_by = ? WHERE id = ?`,
        [reference, reason, actorId, refundId]);
    } else {
      const [r] = await conn.query(
        `INSERT INTO refunds (payment_id, order_id, reference, amount, reason, status, created_by) VALUES (?, ?, ?, ?, ?, 'processing', ?)`,
        [payment.id, order.id, reference, amount, reason, actorId]);
      refundId = r.insertId;
    }
    if (!isJeko()) return { refundId, amount, done: await finalizeRefund(conn, refundId, actorId) };
    const [[user]] = await conn.query(`SELECT first_name, last_name, phone FROM users WHERE id = ?`, [order.user_id]);
    return { refundId, amount, reference, payment, order, user };
  });
  if (prepared.done) return { amount: prepared.amount, status: 'succeeded', full: prepared.done.full };

  const { refundId, amount, reference, payment, order, user } = prepared;
  const phone = jeko.jekoPhone(payment.payer_phone) || jeko.jekoPhone(user.phone);
  if (!phone || !jeko.JEKO_METHODS[payment.provider]) {
    await query(`UPDATE refunds SET status = 'failed', failure_reason = ? WHERE id = ?`, ['Numéro Mobile Money du client inconnu', refundId]);
    throw badRequest('Numéro Mobile Money du client introuvable : remboursez-le manuellement.');
  }
  return sendTransfer('refund', refundId, {
    amount, reference, method: payment.provider, phone, name: `${user.first_name} ${user.last_name}`,
    description: `Remboursement commande ${order.order_number}`,
  }, actorId);
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

// =====================================================================
// Virements Jèko (remboursements et reversements)
// =====================================================================

const TRANSFER_TABLE = { refund: 'refunds', payout: 'seller_payouts' };

async function sendTransfer(kind, id, params, actorId) {
  let t;
  try {
    t = await jeko.createTransfer(params);
  } catch (e) {
    await applyTransferResult(params.reference, 'error', null, e.message, kind);
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
