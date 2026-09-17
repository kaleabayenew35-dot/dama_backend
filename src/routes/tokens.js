// backend/src/routes/tokens.js
import { Router } from 'express';
import { body } from 'express-validator';
import { validate } from '../middleware/validate.js';
import { requireAdmin } from '../middleware/auth.js';
import { listTokens, createToken, toggleToken, deleteToken, updateBackendUrl, pingTokenBackend } from '../controllers/tokens.js';

const router = Router();

// All token routes require admin JWT
router.use(requireAdmin);

// GET    /api/admin/tokens
router.get('/', listTokens);

// POST   /api/admin/tokens
router.post('/',
  [
    body('key_name').isString().trim().notEmpty().withMessage('key_name is required'),
    body('owner').isString().trim().notEmpty().withMessage('owner is required'),
    body('expires_in_days').optional().isInt({ min: 1 }),
    body('backend_url').isURL({ require_tld: false }).withMessage('backend_url is required and must be a valid URL'),
  ],
  validate,
  createToken
);

// PATCH  /api/admin/tokens/:id/toggle
router.patch('/:id/toggle', toggleToken);

// PATCH  /api/admin/tokens/:id/backend-url
router.patch('/:id/backend-url',
  [
    body('backend_url').optional({ nullable: true }).isURL({ require_tld: false }).withMessage('Must be a valid URL'),
  ],
  validate,
  updateBackendUrl
);

// POST   /api/admin/tokens/:id/ping
router.post('/:id/ping', pingTokenBackend);

// DELETE /api/admin/tokens/:id
router.delete('/:id', deleteToken);

export default router;
