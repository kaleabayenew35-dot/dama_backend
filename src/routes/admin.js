// backend/src/routes/admin.js
import { Router } from 'express';
import { body } from 'express-validator';
import { validate } from '../middleware/validate.js';
import { requireAdmin } from '../middleware/auth.js';
import * as ctrl from '../controllers/admin.js';
import { login, changePassword } from '../controllers/auth.js';
import { listTokens, createToken, toggleToken, deleteToken, registerToken } from '../controllers/tokens.js';
import { grantItem, revokeItem } from '../controllers/items.js';

const router = Router();

// ── Public ─────────────────────────────────────────────────────────────────

// POST /api/admin/login
router.post('/login',
  [
    body('username').isString().trim().notEmpty(),
    body('password').isString().notEmpty(),
  ],
  validate,
  login
);

// ── Protected (JWT required) ────────────────────────────────────────────────
router.use(requireAdmin);

// POST /api/admin/change-password
router.post('/change-password',
  [
    body('currentPassword').isString().notEmpty(),
    body('newPassword').isString().isLength({ min: 6 }),
  ],
  validate,
  changePassword
);

// GET /api/admin/stats
router.get('/stats', ctrl.getStats);

// GET /api/admin/token-users — tokens with their registered players + balances
router.get('/token-users', ctrl.getTokenUsers);

// GET /api/admin/owner-balances — service fee earnings per token owner
router.get('/owner-balances', ctrl.getOwnerBalances);

// GET /api/admin/owner-transactions — fee transaction log with optional date/token filters
router.get('/owner-transactions', ctrl.getOwnerTransactions);

// GET /api/admin/pending-callbacks — outbox reconciliation view (pending + failed rows)
// Query params: status, token_id, game_id, limit
router.get('/pending-callbacks', ctrl.getPendingCallbacks);

// GET /api/admin/connections — verify connectivity to game and owner backends
router.get('/connections', ctrl.getConnectionsStatus);

// GET /api/admin/item-stats — purchase counts per item
router.get('/item-stats', ctrl.getItemStats);

// POST /api/admin/register-token — let system-backend register its own token
router.post('/register-token',
  [
    body('token').isString().trim().notEmpty(),
    body('key_name').optional().isString().trim().notEmpty(),
    body('owner').optional().isString().trim().notEmpty(),
    body('backend_url').optional().isString().trim(),
  ],
  validate,
  registerToken
);

// POST /api/admin/items/grant — grant item to player for free
router.post('/items/grant',
  [body('playerId').notEmpty(), body('itemId').notEmpty()],
  validate,
  grantItem
);

// DELETE /api/admin/items/:playerId/:itemId — revoke item from player
router.delete('/items/:playerId/:itemId', revokeItem);

// GET /api/admin/players
router.get('/players', ctrl.listAllPlayers);

// DELETE /api/admin/players/demo
router.delete('/players/demo', ctrl.deleteDemoPlayers);

// POST /api/admin/players/seed
router.post('/players/seed', ctrl.seedDemoPlayers);

// PATCH /api/admin/players/:id/balance
router.patch('/players/:id/balance',
  [
    body('amount').optional().isInt(),
    body('balance').optional().isInt({ min: 0 }),
  ],
  validate,
  ctrl.adminAdjustBalance
);

export default router;
