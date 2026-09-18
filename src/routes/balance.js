// backend/src/routes/balance.js
// POST /api/player-balance
//
// Called by the frontend immediately on load.
//
// Security model
// ──────────────
// The frontend never sends a raw phone number.  Instead system-backend mints a
// short-lived signed JWT (the "launch token") that contains { phone, username,
// balance, gameId }.  The frontend forwards that opaque string here along with
// its Dama API token.  This backend asks system-backend to verify the token and
// extracts the phone/username — the browser never sees either value in plain text.
//
// Flow:
//   1. Verify `launch` JWT with verifyLaunchToken() → { phone, username, … }
//   2. Call existing fetchOwnerBalance(token, phone, username) — unchanged.
//   3. Return { balance, username } to the frontend.

import { Router } from 'express';
import { body } from 'express-validator';
import { query } from '../db/database.js';   // PostgreSQL query helper — NOT db.prepare
import { validate } from '../middleware/validate.js';
import { fetchOwnerBalance } from '../services/ownerCallback.js';
import { verifyLaunchToken } from '../utils/launchToken.js';
import { ok } from '../utils/response.js';
import { normalizePhone } from '../utils/phone.js';
import { logger } from '../utils/logger.js';
import { SYSTEM_BACKEND_URL } from '../config/env.js';

const router = Router();

/**
 * POST /api/player-balance
 *
 * Body: { token, launch }
 *   token  — Dama API token string (identifies which partner backend to query)
 *   launch — short-lived signed JWT from system-backend containing phone/username
 *
 * Response: { balance: number | null, username: string | null }
 *
 * balance is null when:
 *  - token has no backend_url configured
 *  - owner backend unreachable
 * Frontend falls back to the URL ?balance= param in those cases.
 */
router.post('/',
  [
    body('token').notEmpty().withMessage('token is required'),
    body('launch').notEmpty().withMessage('launch token is required'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { token, launch } = req.body;

      // ── 1. Look up token in PostgreSQL ────────────────────────────────────
      const { rows } = await query(
        'SELECT backend_url FROM api_tokens WHERE token = $1 AND is_active = 1',
        [token]
      );
      const tokenRow = rows[0] || null;

      if (!tokenRow) {
        // Token not found — try verifying via system-backend directly
        // (handles newly-created game tokens before a manual Dama token sync)
        let claims;
        try {
          claims = await verifyLaunchToken(launch, SYSTEM_BACKEND_URL);
        } catch (err) {
          logger.warn(`[balance] system launch verification failed: ${err.message}`);
          return ok(res, { balance: null, username: null });
        }
        if (!claims) return ok(res, { balance: null, username: null });

        // Register the token lazily so future requests don't repeat this path
        try {
          await query(
            `INSERT INTO api_tokens (token, key_name, owner, backend_url, is_active)
             VALUES ($1, $2, $3, $4, 1)
             ON CONFLICT (token) DO NOTHING`,
            [token, `system-game-${claims.gameId || 'launch'}`, 'System Backend', SYSTEM_BACKEND_URL]
          );
        } catch (registrationErr) {
          logger.warn(`[balance] system token registration failed: ${registrationErr.message}`);
        }

        return ok(res, { balance: claims.balance, username: claims.username });
      }

      if (!tokenRow.backend_url) {
        logger.warn(`[balance] Token has no backend_url configured`);
        return ok(res, { balance: null, username: null });
      }

      logger.info(`[balance] Token found: backend=${tokenRow.backend_url}`);

      // ── 2. Verify launch token with the token's backend ───────────────────
      let claims;
      try {
        logger.info(`[balance] Verifying launch token with ${tokenRow.backend_url}...`);
        claims = await verifyLaunchToken(launch, tokenRow.backend_url);
      } catch (err) {
        logger.warn(`[balance] Launch token verification error: ${err.message}`);
        return ok(res, { balance: null, username: null });
      }

      if (!claims) {
        logger.warn(`[balance] Launch token returned null claims`);
        return ok(res, { balance: null, username: null });
      }

      logger.info(`[balance] Launch token verified: username=${claims.username}`);

      // ── 3. Fetch live balance from owner backend ──────────────────────────
      const { phone, username } = claims;
      let data = null;
      try {
        data = await fetchOwnerBalance(token, normalizePhone(phone), username);
      } catch (err) {
        logger.warn(`[balance] Balance lookup failed: ${err.message}`);
        return ok(res, { balance: null, username: null });
      }

      // ── 4. Return to frontend (phone intentionally excluded) ──────────────
      ok(res, {
        balance:  data ? data.balance  : null,
        username: data ? data.username : null,
      });

    } catch (err) {
      next(err);
    }
  }
);

export default router;
