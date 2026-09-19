// backend/src/services/ownerCallback.js
import { query } from '../db/database.js';
import { logger } from '../utils/logger.js';
import { normalizePhone } from '../utils/phone.js';

const now = () => Math.floor(Date.now() / 1000);

// ─────────────────────────────────────────────────────────────────────────────
// Internal: outbox helpers
// ─────────────────────────────────────────────────────────────────────────────

async function insertOutboxRow(tokenId, gameId, action, payload) {
  const { rows } = await query(`
    INSERT INTO pending_owner_callbacks
      (token_id, game_id, action, payload_json, status, attempts, created_at, updated_at)
    VALUES ($1, $2, $3, $4, 'pending', 0, $5, $5)
    RETURNING id
  `, [tokenId, gameId || null, action, JSON.stringify(payload), now()]);
  return rows[0].id;
}

async function markDelivered(outboxId) {
  await query(`
    UPDATE pending_owner_callbacks SET status = 'delivered', updated_at = $1 WHERE id = $2
  `, [now(), outboxId]);
}

async function markAttemptFailed(outboxId, errorMsg, maxAttempts = 10) {
  await query(`
    UPDATE pending_owner_callbacks
    SET
      attempts   = attempts + 1,
      last_error = $1,
      status     = CASE WHEN attempts + 1 >= $2 THEN 'failed' ELSE 'pending' END,
      updated_at = $3
    WHERE id = $4
  `, [String(errorMsg).slice(0, 500), maxAttempts, now(), outboxId]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: core HTTP caller
// ─────────────────────────────────────────────────────────────────────────────

export async function callDamaEndpoint(backendUrl, body) {
  if (!backendUrl) return null;
  const url = backendUrl.replace(/\/$/, '') + '/dama';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000), // 15 s — accommodates cold starts on partner backends
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

export async function dispatchCallback(tokenId, gameId, backendUrl, payload) {
  if (!backendUrl) return null;

  const action   = payload.action || 'unknown';
  const outboxId = await insertOutboxRow(tokenId, gameId, action, payload);
  const enrichedPayload = { ...payload, callbackId: outboxId };

  const url = backendUrl.replace(/\/$/, '') + '/dama';
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(enrichedPayload),
      signal:  AbortSignal.timeout(15000), // 15 s — accommodates cold starts on partner backends
    });

    if (!res.ok) {
      const errMsg = `HTTP ${res.status}`;
      logger.warn(`dispatchCallback [outbox=${outboxId}] ${url} → ${errMsg}`);
      await markAttemptFailed(outboxId, errMsg);
      return null;
    }

    let json = null;
    try { json = await res.json(); } catch { /* non-JSON success */ }

    await markDelivered(outboxId);
    logger.debug(`dispatchCallback [outbox=${outboxId}] ${url} OK`);
    return json;

  } catch (err) {
    logger.warn(`dispatchCallback [outbox=${outboxId}] ${url} failed: ${err.message}`);
    await markAttemptFailed(outboxId, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DB lookup helpers
// ─────────────────────────────────────────────────────────────────────────────

export async function getTokenRow(tokenStr) {
  if (!tokenStr) return null;
  const { rows } = await query(
    `SELECT * FROM api_tokens WHERE token = $1 AND is_active = 1`, [tokenStr]
  );
  return rows[0] || null;
}

export async function getBackendInfo(tokenId) {
  if (!tokenId) {
    // No token at all — use system_backend as fallback with the Dama game token
    return {
      backendUrl: process.env.SYSTEM_BACKEND_URL || null,
      tokenStr:   process.env.DAMA_GAME_TOKEN    || null,
    };
  }
  const { rows } = await query(
    `SELECT backend_url, token FROM api_tokens WHERE id = $1`, [tokenId]
  );
  const row = rows[0];
  if (!row) {
    return {
      backendUrl: process.env.SYSTEM_BACKEND_URL || null,
      tokenStr:   process.env.DAMA_GAME_TOKEN    || null,
    };
  }

  // If this token has no backend_url (native dama_xxx token without an owner backend),
  // fall back to system_backend with the Dama game token for balance callbacks.
  const backendUrl = row.backend_url || process.env.SYSTEM_BACKEND_URL || null;
  const tokenStr   = row.backend_url
    ? (row.token || null)
    : (process.env.DAMA_GAME_TOKEN || row.token || null);

  return { backendUrl, tokenStr };
}

export async function getTokenIdForPlayer(playerId) {
  const { rows } = await query(`SELECT token_id FROM players WHERE id = $1`, [playerId]);
  return rows[0]?.token_id || null;
}

async function getPlayerPhone(playerId) {
  const { rows } = await query(`SELECT phone FROM players WHERE id = $1`, [playerId]);
  return rows[0]?.phone || null;
}

async function getPlayerName(playerId) {
  const { rows } = await query(`SELECT name FROM players WHERE id = $1`, [playerId]);
  return rows[0]?.name || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: balance fetch
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchOwnerBalance(tokenStr, phone, username) {
  const tokenRow = await getTokenRow(tokenStr);
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

  return { balance, username: result.username || null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: durable financial event dispatchers
// ─────────────────────────────────────────────────────────────────────────────

export async function notifyBetPlaced(tokenId, { player1Id, player2Id, betAmount, gameId }) {
  const { backendUrl, tokenStr } = await getBackendInfo(tokenId);
  if (!backendUrl) return;

  await Promise.allSettled([
    dispatchCallback(tokenId, gameId, backendUrl, {
      action: 'deduct', token: tokenStr,
      telegramId: player1Id,   // dama player IDs = Telegram IDs
      playerId:   player1Id,
      phone:    normalizePhone(await getPlayerPhone(player1Id)),
      username: await getPlayerName(player1Id),
      amount: betAmount, gameId,
    }),
    dispatchCallback(tokenId, gameId, backendUrl, {
      action: 'deduct', token: tokenStr,
      telegramId: player2Id,
      playerId:   player2Id,
      phone:    normalizePhone(await getPlayerPhone(player2Id)),
      username: await getPlayerName(player2Id),
      amount: betAmount, gameId,
    }),
  ]);
}

export async function notifyWinPayout(tokenId, { winnerId, loserId, winnerPayout, fee, gameId }) {
  const { backendUrl, tokenStr } = await getBackendInfo(tokenId);
  if (!backendUrl) return;

  await Promise.allSettled([
    dispatchCallback(tokenId, gameId, backendUrl, {
      action: 'credit', token: tokenStr,
      telegramId: winnerId,
      playerId:   winnerId,
      phone:    normalizePhone(await getPlayerPhone(winnerId)),
      username: await getPlayerName(winnerId),
      amount: winnerPayout, fee, gameId,
    }),
    dispatchCallback(tokenId, gameId, backendUrl, {
      action: 'loss', token: tokenStr,
      telegramId: loserId,
      playerId:   loserId,
      phone:    normalizePhone(await getPlayerPhone(loserId)),
      username: await getPlayerName(loserId),
      amount: 0, fee, gameId,
    }),
  ]);
}

export async function notifyDrawRefund(tokenId, { player1Id, player2Id, refund, fee, gameId }) {
  const { backendUrl, tokenStr } = await getBackendInfo(tokenId);
  if (!backendUrl) return;

  await Promise.allSettled([
    dispatchCallback(tokenId, gameId, backendUrl, {
      action: 'refund', token: tokenStr,
      telegramId: player1Id,
      playerId:   player1Id,
      phone:    normalizePhone(await getPlayerPhone(player1Id)),
      username: await getPlayerName(player1Id),
      amount: refund, fee, gameId,
    }),
    dispatchCallback(tokenId, gameId, backendUrl, {
      action: 'refund', token: tokenStr,
      telegramId: player2Id,
      playerId:   player2Id,
      phone:    normalizePhone(await getPlayerPhone(player2Id)),
      username: await getPlayerName(player2Id),
      amount: refund, fee, gameId,
    }),
  ]);
}

export async function notifyOwnerFee(tokenId, { amount, type, gameId, humanPlayerId }) {
  const { backendUrl, tokenStr } = await getBackendInfo(tokenId);
  if (!backendUrl) return;

  await dispatchCallback(tokenId, gameId, backendUrl, {
    action: 'owner_fee', token: tokenStr, amount, type, gameId,
    ...(humanPlayerId ? { humanPlayerId } : {}),
  });
}
