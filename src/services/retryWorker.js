// backend/src/services/retryWorker.js
import { query } from '../db/database.js';
import { logger } from '../utils/logger.js';
import { getBackendInfo } from './ownerCallback.js';

const RETRY_INTERVAL_MS = 45_000;
const MAX_ATTEMPTS      = 10;

/** @type {ReturnType<typeof setInterval>|null} */
let intervalHandle = null;

const now = () => Math.floor(Date.now() / 1000);

export async function runRetrySweep() {
  const { rows } = await query(`
    SELECT id, token_id, game_id, action, payload_json, attempts
    FROM   pending_owner_callbacks
    WHERE  status   = 'pending'
    AND    attempts < $1
    ORDER  BY created_at ASC
    LIMIT  50
  `, [MAX_ATTEMPTS]);

  if (rows.length === 0) return;

  logger.info(`[retryWorker] sweep — ${rows.length} pending callback(s) to retry`);
  await Promise.allSettled(rows.map(row => retryRow(row)));
}

async function retryRow(row) {
  const { backendUrl, tokenStr } = await getBackendInfo(row.token_id);

  if (!backendUrl) {
    await query(`
      UPDATE pending_owner_callbacks
      SET status = 'failed', last_error = 'no backend_url for token', updated_at = $1
      WHERE id = $2
    `, [now(), row.id]);
    logger.warn(`[retryWorker] outbox=${row.id} — no backend_url, marked failed`);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    await query(`
      UPDATE pending_owner_callbacks
      SET status = 'failed', last_error = 'invalid payload JSON', updated_at = $1
      WHERE id = $2
    `, [now(), row.id]);
    return;
  }

  if (!payload.callbackId) payload.callbackId = row.id;
  // Always overwrite the token with the current active token for the backend,
  // since old payloads may carry a dama_xxx API token which doesn't authenticate /dama.
  if (tokenStr) payload.token = tokenStr;

  const url = backendUrl.replace(/\/$/, '') + '/dama';

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(8000),
    });

    if (res.ok) {
      await query(`
        UPDATE pending_owner_callbacks SET status = 'delivered', updated_at = $1 WHERE id = $2
      `, [now(), row.id]);
      logger.info(`[retryWorker] outbox=${row.id} action=${row.action} delivered on retry #${row.attempts + 1}`);
    } else {
      const errMsg = `HTTP ${res.status}`;
      await incrementFailure(row.id, errMsg, row.attempts);
      logger.warn(`[retryWorker] outbox=${row.id} retry #${row.attempts + 1} → ${errMsg}`);
    }
  } catch (err) {
    await incrementFailure(row.id, err.message, row.attempts);
    logger.warn(`[retryWorker] outbox=${row.id} retry #${row.attempts + 1} failed: ${err.message}`);
  }
}

async function incrementFailure(outboxId, errorMsg, currentAttempts) {
  const newAttempts = currentAttempts + 1;
  const newStatus   = newAttempts >= MAX_ATTEMPTS ? 'failed' : 'pending';

  await query(`
    UPDATE pending_owner_callbacks
    SET attempts = $1, last_error = $2, status = $3, updated_at = $4
    WHERE id = $5
  `, [newAttempts, String(errorMsg).slice(0, 500), newStatus, now(), outboxId]);

  if (newStatus === 'failed') {
    logger.error(`[retryWorker] outbox=${outboxId} exhausted ${MAX_ATTEMPTS} attempts — marked failed`);
  }
}

export function startRetryWorker() {
  if (intervalHandle !== null) return;

  logger.info(`[retryWorker] started — sweep every ${RETRY_INTERVAL_MS / 1000}s, max ${MAX_ATTEMPTS} attempts`);

  setTimeout(() => runRetrySweep().catch(err => logger.error('[retryWorker] sweep error:', err)), 5_000);

  intervalHandle = setInterval(() => {
    runRetrySweep().catch(err => logger.error('[retryWorker] sweep error:', err));
  }, RETRY_INTERVAL_MS);

  if (intervalHandle.unref) intervalHandle.unref();
}

export function stopRetryWorker() {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('[retryWorker] stopped');
  }
}
