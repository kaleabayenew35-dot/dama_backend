// backend/src/routes/players.js
import { Router } from 'express';
import { body, query } from 'express-validator';
import { validate } from '../middleware/validate.js';
import { requireAdmin } from '../middleware/auth.js';
import { requireTokenOrAdmin } from '../middleware/requireToken.js';
import * as ctrl from '../controllers/players.js';
import { getOwnedItems, purchaseItem } from '../controllers/items.js';

const router = Router();

// GET /api/players/ready — list ready+online players, optionally filtered by bet
// Must be before /:id to avoid route conflict
router.get('/ready',
  requireTokenOrAdmin,
  [
    query('bet').optional().isInt({ min: 1 }),
    query('excludeId').optional().isString(),
  ],
  validate,
  ctrl.listReadyPlayers
);

// GET /api/players/:id/owned — get owned item IDs (before /:id to avoid conflict)
router.get('/:id/owned', requireTokenOrAdmin, getOwnedItems);

// POST /api/players/:id/purchase — buy an item
router.post('/:id/purchase',
  requireTokenOrAdmin,
  [body('itemId').isString().notEmpty().withMessage('itemId required')],
  validate,
  purchaseItem
);

// GET /api/players — requires API token or admin JWT
router.get('/', requireTokenOrAdmin, ctrl.listPlayers);

// GET /api/players/:id — requires API token or admin JWT
router.get('/:id', requireTokenOrAdmin, ctrl.getPlayer);

// POST /api/players — requires API Token or Admin JWT (saves token owner link)
router.post('/',
  requireTokenOrAdmin,
  [
    body('id').notEmpty().withMessage('id is required'),
    body('name').notEmpty().withMessage('name is required'),
    body('bet').optional().isInt({ min: 0 }),
    body('isDemo').optional().isBoolean(),
  ],
  validate,
  ctrl.upsertPlayer
);

// PATCH /api/players/:id/ready — set player ready with bet amount
router.patch('/:id/ready',
  requireTokenOrAdmin,
  [body('bet').isInt({ min: 1 }).withMessage('bet must be a positive integer')],
  validate,
  ctrl.setReady
);

// PATCH /api/players/:id/unready — clear ready state
router.patch('/:id/unready', requireTokenOrAdmin, ctrl.clearReady);

// PATCH /api/players/:id — admin JWT only
router.patch('/:id',
  requireAdmin,
  [
    body('name').optional().notEmpty(),
    body('wins').optional().isInt({ min: 0 }),
    body('losses').optional().isInt({ min: 0 }),
    body('draws').optional().isInt({ min: 0 }),
    body('balance').optional().isInt({ min: 0 }),
    body('bet').optional().isInt({ min: 0 }),
    body('online').optional().isBoolean(),
  ],
  validate,
  ctrl.updatePlayer
);

// PATCH /api/players/:id/balance — API token or admin
router.patch('/:id/balance',
  requireTokenOrAdmin,
  [body('amount').isInt().withMessage('amount must be an integer')],
  validate,
  ctrl.adjustBalance
);

// DELETE /api/players/:id — admin JWT only
router.delete('/:id', requireAdmin, ctrl.deletePlayer);

// POST /api/players/:id/result — API token or admin
router.post('/:id/result',
  requireTokenOrAdmin,
  [body('result').isIn(['win', 'loss', 'draw']).withMessage("result must be 'win', 'loss', or 'draw'")],
  validate,
  ctrl.recordResult
);

export default router;
