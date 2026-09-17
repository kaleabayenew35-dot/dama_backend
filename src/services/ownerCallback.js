// backend/src/services/ownerCallback.js
//
// All calls go to a single endpoint: POST {backend_url}/dama
// with an `action` field:
//
//   action: 'get_balance'  → { action, phone, username }
//                            expects response: { balance: number }
//
//   action: 'deduct'       → { action, phone, username, playerId, amount, gameId }
//   action: 'credit'       → { action, phone, username, playerId, amount, fee, gameId }
//   action: 'loss'         → { action, phone, username, playerId, amount, fee, gameId }
//   action: 'refund'       → { action, phone, username, playerId, amount, fee, gameId }
//
//   action: 'owner_fee'    → { action, amount, type, gameId, humanPlayerId? }
//                            Notifies owner backend of their commission/profit/loss.
//                            amount > 0 = owner earns, amount < 0 = owner pays out.
//                            type: 'pvp_win_fee' | 'pvp_draw_fee' |
//                                  'ai_win_fee'  | 'ai_profit' |
//                                  'ai_loss'     | 'ai_draw_fee'
//
// ── Durability model ─────────────────────────────────────────────────────────
// Every outbound callback that must reach the partner backend is written to the
// `pending_owner_callbacks` outbox table BEFORE the HTTP call is attempted.
// A `callbackId` field is included in every payload so the partner backend can
// optionally deduplicate retries in the future.
//
// On success  → row status is set to 'delivered'.
// On failure  → row status stays 'pending', attempts/last_error are incremented.
//               The retry worker (retryWorker.js) picks these up on an interval.
// After MAX_ATTEMPTS failures → status set to 'failed' for manual review.
//
// Failures are logged but NEVER crash the game flow.

import db from '../db/database.js';
import { logger } from '../utils/logger.js';
import { normalizePhone } from '../utils/phone.js';

// ─────────────────────────────────────────────────────────────────────────────
// Internal: outbox helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Insert a new row into pending_owner_callbacks.
 * Returns the inserted row id.
 *
 * @param {number|null} tokenId
 * @param {string|null} gameId
 * @param {string}      action
 * @param {object}      payload  — the full body that will be POSTed to /dama
 * @returns {number} outboxId
 */
function insertOutboxRow(tokenId, gameId, action, payload) {
  const result = db.prepare(`
    INSERT INTO pending_owner_callbacks
      (token_id, game_id, action, payload_json, status, attempts)
    VALUES (?, ?, ?, ?, 'pending', 0)
  `).run(tokenId, gameId || null, action, JSON.stringify(payload));
  return result.lastInsertRowid;
}

/**
 * Mark an outbox row as delivered.
 */
function markDelivered(outboxId) {
  db.prepare(`
    UPDATE pending_owner_callbacks
    SET status = 'delivered', updated_at = unixepoch()
    WHERE id = ?
  `).run(outboxId);
}

/**
 * Increment attempts and record the last error on failure.
 * If attempts reaches maxAttempts, set status to 'failed'.
 */
function markAttemptFailed(outboxId, errorMsg, maxAttempts = 10) {
  db.prepare(`
    UPDATE pending_owner_callbacks
    SET
      attempts   = attempts + 1,
      last_error = ?,
      status     = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END,
      updated_at = unixepoch()
    WHERE id = ?
  `).run(String(errorMsg).slice(0, 500), maxAttempts, outboxId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: core HTTP caller
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST to the owner's {backend_url}/dama with a JSON payload.
 * Returns parsed JSON response or null on failure.
 * Does NOT write to the outbox — callers that need durability use
 * dispatchCallback() instead.
 *
 * @param {string}  backendUrl  full base URL e.g. https://owner.com/api
 * @param {object}  body
 * @returns {Promise<object|null>}
 */
export async function callDamaEndpoint(backendUrl, body) {
  if (!backendUrl) return null;
  const url = backendUrl.replace(/\/$/, '') + '/dama';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      logger.warn(`ownerCallback ${url} responded ${res.status}`);
      return null;
    }
    logger.debug(`ownerCallback ${url} OK`);
    return await res.json();
  } catch (err) {
    logger.warn(`ownerCallback ${url} failed: ${err.message}`);
    return null;
  }
}

/**
 * Durable variant of callDamaEndpoint.
 *
 * 1. Writes an outbox row with status='pending' (before the HTTP call).
 * 2. Attempts the call.
 * 3. On success: marks the row 'delivered'.
 * 4. On failure: increments attempts/last_error; row stays 'pending'
 *    for the retry worker.
 *
 * @param {number|null} tokenId
 * @param {string|null} gameId
 * @param {string}      backendUrl
 * @param {object}      payload   — will be POSTed as-is to /dama
 * @returns {Promise<object|null>}  raw parsed JSON on success, null on failure
 */
export async function dispatchCallback(tokenId, gameId, backendUrl, payload) {
  if (!backendUrl) return null;

  const action    = payload.action || 'unknown';
  const outboxId  = insertOutboxRow(tokenId, gameId, action, payload);

  // Attach the outbox id so the partner backend can optionally deduplicate
  const enrichedPayload = { ...payload, callbackId: outboxId };

  const url = backendUrl.replace(/\/$/, '') + '/dama';
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(enrichedPayload),
      signal:  AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const errMsg = `HTTP ${res.status}`;
      logger.warn(`dispatchCallback [outbox=${outboxId}] ${url} → ${errMsg}`);
      markAttemptFailed(outboxId, errMsg);
      return null;
    }

    let json = null;
    try {
      json = await res.json();
    } catch {
      // Non-JSON success body — still counts as delivered
    }

    markDelivered(outboxId);
    logger.debug(`dispatchCallback [outbox=${outboxId}] ${url} OK`);
    return json;

  } catch (err) {
    logger.warn(`dispatchCallback [outbox=${outboxId}] ${url} failed: ${err.message}`);
    markAttemptFailed(outboxId, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DB lookup helpers (used internally and by the retry worker)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch the full token row (backend_url, etc.) for a given token string.
 */
export function getTokenRow(tokenStr) {
  if (!tokenStr) return null;
  return db.prepare('SELECT * FROM api_tokens WHERE token = ? AND is_active = 1').get(tokenStr) || null;
}

/**
 * Fetch backend_url AND the raw token string for a given token_id.
 * Returns { backendUrl, tokenStr } or null values if not found.
 */
export function getBackendInfo(tokenId) {
  if (!tokenId) return { backendUrl: null, tokenStr: null };
  const row = db.prepare('SELECT backend_url, token FROM api_tokens WHERE id = ?').get(tokenId);
  return {
    backendUrl: row?.backend_url || null,
    tokenStr:   row?.token       || null,
  };
}

/**
 * Get token_id for a player.
 */
export function getTokenIdForPlayer(playerId) {
  const row = db.prepare('SELECT token_id FROM players WHERE id = ?').get(playerId);
  return row?.token_id || null;
}

/**
 * Get phone for a player.
 */
function getPlayerPhone(playerId) {
  const row = db.prepare('SELECT phone FROM players WHERE id = ?').get(playerId);
  return row?.phone || null;
}

/**
 * Get name for a player.
 */
function getPlayerName(playerId) {
  const row = db.prepare('SELECT name FROM players WHERE id = ?').get(playerId);
  return row?.name || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: balance fetch (not a durable callback — read-only, no outbox needed)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch real balance from owner's backend for a player.
 * Called on login to get the live balance.
 * Not written to the outbox (read-only, safe to drop on failure).
 */
export async function fetchOwnerBalance(tokenStr, phone, username) {
  const tokenRow = getTokenRow(tokenStr);
  if (!tokenRow?.backend_url) return null;

  const result = await callDamaEndpoint(tokenRow.backend_url, {
    action:   'get_balance',
    token:    tokenStr,
    phone:    normalizePhone(phone),
    username,
  });

  if (!result) return null;

  let balance = null;
  if (typeof result.balance === 'number') {
    balance = result.balance;
  } else if (typeof result.balance === 'string') {
    const n = parseInt(result.balance, 10);
    balance = isNaN(n) ? null : n;
  }

  return {
    balance,
    username: result.username || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: durable financial event dispatchers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Notify owner: bets deducted (called when a match starts).
 * Each player gets its own outbox row so retries are independent.
 */
export async function notifyBetPlaced(tokenId, { player1Id, player2Id, betAmount, gameId }) {
  const { backendUrl, tokenStr } = getBackendInfo(tokenId);
  if (!backendUrl) return;

  await Promise.allSettled([
    dispatchCallback(tokenId, gameId, backendUrl, {
      action:   'deduct',
      token:    tokenStr,
      playerId: player1Id,
      phone:    normalizePhone(getPlayerPhone(player1Id)),
      username: getPlayerName(player1Id),
      amount:   betAmount,
      gameId,
    }),
    dispatchCallback(tokenId, gameId, backendUrl, {
      action:   'deduct',
      token:    tokenStr,
      playerId: player2Id,
      phone:    normalizePhone(getPlayerPhone(player2Id)),
      username: getPlayerName(player2Id),
      amount:   betAmount,
      gameId,
    }),
  ]);
}

/**
 * Notify owner: winner credited.
 * Each notification (credit + loss) gets its own outbox row.
 */
export async function notifyWinPayout(tokenId, { winnerId, loserId, winnerPayout, fee, gameId }) {
  const { backendUrl, tokenStr } = getBackendInfo(tokenId);
  if (!backendUrl) return;

  await Promise.allSettled([
    dispatchCallback(tokenId, gameId, backendUrl, {
      action:   'credit',
      token:    tokenStr,
      playerId: winnerId,
      phone:    normalizePhone(getPlayerPhone(winnerId)),
      username: getPlayerName(winnerId),
      amount:   winnerPayout,
      fee,
      gameId,
    }),
    dispatchCallback(tokenId, gameId, backendUrl, {
      action:   'loss',
      token:    tokenStr,
      playerId: loserId,
      phone:    normalizePhone(getPlayerPhone(loserId)),
      username: getPlayerName(loserId),
      amount:   0,
      fee,
      gameId,
    }),
  ]);
}

/**
 * Notify owner: draw — each player refunded.
 * Each refund notification gets its own outbox row.
 */
export async function notifyDrawRefund(tokenId, { player1Id, player2Id, refund, fee, gameId }) {
  const { backendUrl, tokenStr } = getBackendInfo(tokenId);
  if (!backendUrl) return;

  await Promise.allSettled([
    dispatchCallback(tokenId, gameId, backendUrl, {
      action:   'refund',
      token:    tokenStr,
      playerId: player1Id,
      phone:    normalizePhone(getPlayerPhone(player1Id)),
      username: getPlayerName(player1Id),
      amount:   refund,
      fee,
      gameId,
    }),
    dispatchCallback(tokenId, gameId, backendUrl, {
      action:   'refund',
      token:    tokenStr,
      playerId: player2Id,
      phone:    normalizePhone(getPlayerPhone(player2Id)),
      username: getPlayerName(player2Id),
      amount:   refund,
      fee,
      gameId,
    }),
  ]);
}

/**
 * Notify owner backend of their commission / profit / loss for a game.
 * Written to outbox before sending.
 *
 * Body sent to {backend_url}/dama:
 * {
 *   action:         'owner_fee',
 *   token:          string,
 *   amount:         number,     // positive = owner earns, negative = owner pays out
 *   type:           string,
 *   gameId:         string,
 *   humanPlayerId?: string,
 *   callbackId:     number      // outbox row id for idempotency
 * }
 */
export async function notifyOwnerFee(tokenId, { amount, type, gameId, humanPlayerId }) {
  const { backendUrl, tokenStr } = getBackendInfo(tokenId);
  if (!backendUrl) return;

  await dispatchCallback(tokenId, gameId, backendUrl, {
    action:  'owner_fee',
    token:   tokenStr,
    amount,
    type,
    gameId,
    ...(humanPlayerId ? { humanPlayerId } : {}),
  });
}
