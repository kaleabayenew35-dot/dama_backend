import { Router } from 'express';
import { body } from 'express-validator';
import { validate } from '../middleware/validate.js';
import { requireAdmin } from '../middleware/auth.js';
import * as ctrl from '../controllers/ai.js';

const router = Router();

// GET /api/ai — global config (public, used by frontend game)
router.get('/', ctrl.getConfig);

// PUT /api/ai — update global config (admin only)
router.put('/', requireAdmin,
  [
    body('difficulty').optional().isIn(['easy', 'medium', 'hard']),
    body('depth').optional().isInt({ min: 1, max: 20 }),
    body('thinkDelay').optional().isInt({ min: 0 }),
    body('aiName').optional().isString().notEmpty(),
    body('allowUndo').optional().isBoolean(),
  ],
  validate,
  ctrl.updateConfig
);

// GET /api/ai/bots/public — list AI bots for game client (public, no auth needed)
// Must be before /bots to avoid route conflict with /bots/:id
router.get('/bots/public', ctrl.getBotsPublic);

// GET /api/ai/bots — list all AI bots (admin only)
router.get('/bots', requireAdmin, ctrl.getBots);

// PATCH /api/ai/bots/:id — update a single bot's name/depth (admin only)
router.patch('/bots/:id', requireAdmin,
  [
    body('name').optional().isString().notEmpty(),
    body('depth').optional().isInt({ min: 1, max: 20 }),
  ],
  validate,
  ctrl.updateBot
);

// POST /api/ai/move — ask Gemini LLM to pick the best move (public)
// Body: { board, moves, aiPlayer, difficulty }
// Returns: { move } or { fallback: true } if LLM unavailable
router.post('/move', ctrl.getLLMMove);

export default router;

