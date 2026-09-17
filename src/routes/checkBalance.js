import { Router } from 'express';
import { body } from 'express-validator';
import { validate } from '../middleware/validate.js';
import { fetchOwnerBalance } from '../services/ownerCallback.js';
import { ok } from '../utils/response.js';

const router = Router();

/**
 * POST /api/check-balance
 * Body: { token, phone, username, expectedBalance }
 * Returns { result: 'yes'|'no', reason? }
 */
import { normalizePhone } from '../utils/phone.js';

router.post(
  '/',
  [
    body('token').notEmpty().withMessage('token required'),
    body('phone').notEmpty().withMessage('phone required'),
    body('username').notEmpty().withMessage('username required'),
    body('expectedBalance').isNumeric().withMessage('expectedBalance must be a number'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { token, phone, username, expectedBalance } = req.body;
      const result = await fetchOwnerBalance(token, normalizePhone(phone), username);
      if (result === null) {
        return ok(res, { result: 'no', reason: 'Owner backend unavailable' });
      }
      const balance = result.balance;
      if (Number(balance) === Number(expectedBalance)) {
        return ok(res, { result: 'yes' });
      }
      return ok(res, {
        result: 'no',
        reason: `Balance mismatch (expected ${expectedBalance}, got ${balance})`,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
