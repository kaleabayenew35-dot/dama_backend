// backend/src/services/retryWorker.js
//
// Interval-based retry loop for the pending_owner_callbacks outbox.
//
// Every RETRY_INTERVAL_MS it reads rows with:
//   status = 'pending' AND attempts < MAX_ATTEMPTS
// and retries callDamaEndpoint for each one.
//
// Success  → marks the row 'delivered'
// Failure  → increments attempts/last_error; at MAX_ATTEMPTS sets status='failed'
//
// The worker is started once at server boot (via server.js) and runs for the
// lifetime of the process.  It is intentionally simple: no concurrency limits
// beyond SQLite's own serialization, no distributed locks.  For the expected
// volume of a single-node deployment this is sufficient.

import db from '../db/database.js';
import { logger } from '../utils/logger.js';
import { getBackendInfo } from './ownerCallback.js';

const RETRY_INTERVAL_MS = 45_000;   // 45 s between sweeps
const MAX_ATTEMPTS      = 10;        // give up after 10 total tries

/** @type {ReturnType<typeof setInterval>|null} */
let intervalHandle = null;

// ─────────────────────────────────────────────────────────────────────────────
// Core retry sweep
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a single retry sweep: fetch all eligible pending rows and try to deliver.
 * Exported for testing and manual invocation.
 */
export async function runRetrySweep() {
  const rows = db.prepare(`
    SELECT id, token_id, game_id, action, payload_json, attempts
    FROM   pending_owner_callbacks
    WHERE  status   = 'pending'
    AND    attempts < ?
    ORDER  BY created_at ASC
    LIMIT  50
  `).all(MAX_ATTEMPTS);

  if (rows.length === 0) return;

  logger.info(`[retryWorker] sweep — ${rows.length} pending callback(s) to retry`);

  await Promise.allSettled(rows.map(row => retryRow(row)));
}

/**
 * Attempt to deliver a single outbox row.
 * Updates the DB row in place regardless of outcome.
 *
 * @param {{ id: number, token_id: number, game_id: string|null, action: string, payload_json: string, attempts: number }} row
 */
async function retryRow(row) {
  const { backendUrl, tokenStr } = getBackendInfo(row.token_id);

  if (!backendUrl) {
    // Token no longer has a backend URL — no point retrying; mark failed immediately
    db.prepare(`
      UPDATE pending_owner_callbacks
      SET status = 'failed', last_error = 'no backend_url for token', updated_at = unixepoch()
      WHERE id = ?
    `).run(row.id);
    logger.warn(`[retryWorker] outbox=${row.id} — no backend_url, marked failed`);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    db.prepare(`
      UPDATE pending_owner_callbacks
      SET status = 'failed', last_error = 'invalid payload JSON', updated_at = unixepoch()
      WHERE id = ?
    `).run(row.id);
    return;
  }

  // Ensure callbackId is present (may be missing for very old rows written before
  // the outbox feature was added — add it now so retries carry the id)
  if (!payload.callbackId) {
    payload.callbackId = row.id;
  }

  // Refresh the token string in the payload in case it was null on first write
  if (tokenStr && !payload.token) {
    payload.token = tokenStr;
  }

  const url = backendUrl.replace(/\/$/, '') + '/dama';

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(8000),  // slightly longer timeout on retries
    });

    if (res.ok) {
      db.prepare(`
        UPDATE pending_owner_callbacks
        SET status = 'delivered', updated_at = unixepoch()
        WHERE id = ?
      `).run(row.id);
      logger.info(`[retryWorker] outbox=${row.id} action=${row.action} delivered on retry #${row.attempts + 1}`);
    } else {
      const errMsg = `HTTP ${res.status}`;
      incrementFailure(row.id, errMsg, row.attempts);
      logger.warn(`[retryWorker] outbox=${row.id} retry #${row.attempts + 1} → ${errMsg}`);
    }

  } catch (err) {
    incrementFailure(row.id, err.message, row.attempts);
    logger.warn(`[retryWorker] outbox=${row.id} retry #${row.attempts + 1} failed: ${err.message}`);
  }
}

/**
 * Increment the attempt counter and optionally flip to 'failed'.
 */
function incrementFailure(outboxId, errorMsg, currentAttempts) {
  const newAttempts = currentAttempts + 1;
  const newStatus   = newAttempts >= MAX_ATTEMPTS ? 'failed' : 'pending';

  db.prepare(`
    UPDATE pending_owner_callbacks
    SET
      attempts   = ?,
      last_error = ?,
      status     = ?,
      updated_at = unixepoch()
    WHERE id = ?
  `).run(newAttempts, String(errorMsg).slice(0, 500), newStatus, outboxId);

  if (newStatus === 'failed') {
    logger.error(`[retryWorker] outbox=${outboxId} exhausted ${MAX_ATTEMPTS} attempts — marked failed`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start the retry worker interval.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function startRetryWorker() {
  if (intervalHandle !== null) return;

  logger.info(`[retryWorker] started — sweep every ${RETRY_INTERVAL_MS / 1000}s, max ${MAX_ATTEMPTS} attempts`);

  // Run an initial sweep shortly after boot so any rows left from a previous
  // crashed process are retried quickly.
  setTimeout(() => runRetrySweep().catch(err => logger.error('[retryWorker] sweep error:', err)), 5_000);

  intervalHandle = setInterval(() => {
    runRetrySweep().catch(err => logger.error('[retryWorker] sweep error:', err));
  }, RETRY_INTERVAL_MS);

  // Allow the process to exit even if the interval is still active
  if (intervalHandle.unref) intervalHandle.unref();
}

/**
 * Stop the retry worker (used in tests / graceful shutdown).
 */
export function stopRetryWorker() {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('[retryWorker] stopped');
  }
}
