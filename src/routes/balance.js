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
// extracts the phone/username — the browser never sees either value in plain
// text.
//
// Flow:
//   1. Verify `launch` JWT with verifyLaunchToken() → { phone, username, … }
//   2. Call existing fetchOwnerBalance(token, phone, username) — unchanged.
//   3. Return { balance, username } to the frontend.

import { Router } from 'express';
import { body } from 'express-validator';
import db from '../db/database.js';
import { validate } from '../middleware/validate.js';
import { fetchOwnerBalance } from '../services/ownerCallback.js';
import { verifyLaunchToken } from '../utils/launchToken.js';
import { ok, fail } from '../utils/response.js';
import { normalizePhone } from '../utils/phone.js';
import { logger } from '../utils/logger.js';

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
 *
 * 401 when launch token is missing, invalid, or expired.
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

      // ── 1. Verify token exists and has a backend_url ───────────────────────
      const tokenRow = db.prepare(
        'SELECT backend_url FROM api_tokens WHERE token = ? AND is_active = 1'
      ).get(token);

      if (!tokenRow || !tokenRow.backend_url) {
        logger.warn(`[balance] Token lookup failed: token=${token ? 'provided' : 'missing'}, row=${tokenRow ? 'found' : 'not found'}`);
        return ok(res, { balance: null, username: null });
      }

      logger.info(`[balance] Token found: backend=${tokenRow.backend_url}`);

      // ── 2. Verify launch token with system-backend ────────────────────────
      let claims;
      try {
        logger.info(`[balance] Verifying launch token with ${tokenRow.backend_url}...`);
        claims = await verifyLaunchToken(launch, tokenRow.backend_url);
      } catch (err) {
        logger.warn(`[balance] Launch token verification error: ${err.message}`);
        return ok(res, { balance: null, username: null });
      }

      if (!claims) {
        // null → missing/empty string or missing required claims
        logger.warn(`[balance] Launch token returned null`);
        return ok(res, { balance: null, username: null });
      }

      logger.info(`[balance] Launch token verified: phone=${claims.phone}, username=${claims.username}`);

      // ── 3. Fetch balance from owner backend using server-extracted values ──
      // phone and username come exclusively from the verified JWT — the client
      // has no way to supply or tamper with them.
      const { phone, username } = claims;
      let data = null;
      try {
        data = await fetchOwnerBalance(token, normalizePhone(phone), username);
      } catch (err) {
        logger.warn(`[balance] Balance lookup failed: ${err.message}`);
        return ok(res, { balance: null, username: null });
      }

      // ── 4. Return balance to frontend ──────────────────────────────────────
      // NOTE: phone is intentionally NOT included in this response.
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
