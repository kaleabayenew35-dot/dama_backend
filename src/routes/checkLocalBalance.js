import { Router } from 'express';
import db from '../db/database.js';
import { ok } from '../utils/response.js';
import { validate } from '../middleware/validate.js';
import { body } from 'express-validator';

const router = Router();

/**
 * POST /api/check-local-balance
 * Body: { phone, username, expectedBalance }
 * Returns { result: 'yes' } if balance matches, otherwise { result: 'no', reason }.
 */
import { normalizePhone } from '../utils/phone.js';

router.post(
  '/',
  [
    body('phone').notEmpty().withMessage('phone required'),
    body('username').notEmpty().withMessage('username required'),
    body('expectedBalance').isNumeric().withMessage('expectedBalance must be a number'),
  ],
  validate,
  (req, res) => {
    const { phone, username, expectedBalance } = req.body;
    const normalizedPhone = normalizePhone(phone);
    const row = db.prepare('SELECT balance FROM players WHERE phone = ? AND name = ?').get(normalizedPhone, username);
    if (!row) {
      return ok(res, { result: 'no', reason: 'User not found in local DB' });
    }
    const actual = Number(row.balance);
    if (actual === Number(expectedBalance)) {
      return ok(res, { result: 'yes' });
    }
    return ok(res, { result: 'no', reason: `Balance mismatch (expected ${expectedBalance}, got ${actual})` });
  }
);

export default router;
