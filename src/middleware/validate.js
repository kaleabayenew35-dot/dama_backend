import { validationResult } from 'express-validator';

/**
 * Run express-validator checks and return 400 if any fail.
 */
export const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ ok: false, errors: errors.array() });
  }
  next();
};
