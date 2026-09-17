import { Router } from 'express';
import { body } from 'express-validator';
import { validate } from '../middleware/validate.js';
import { requireTokenOrAdmin } from '../middleware/requireToken.js';
import * as ctrl from '../controllers/games.js';

const router = Router();

// All game routes require API token or admin JWT
router.use(requireTokenOrAdmin);

// GET /api/games
router.get('/', ctrl.listGames);

// GET /api/games/:id
router.get('/:id', ctrl.getGame);

// POST /api/games
router.post('/',
  [
    body('mode').isIn(['ai', 'pvp']).withMessage("mode must be 'ai' or 'pvp'"),
    body('player1Id').notEmpty().withMessage('player1Id is required'),
    body('player2Id').optional().isString(),
    body('betAmount').optional().isInt({ min: 0 }),
  ],
  validate,
  ctrl.createGame
);

// PATCH /api/games/:id/finish
router.patch('/:id/finish',
  [
    body('durationSec').isInt({ min: 0 }).withMessage('durationSec must be a non-negative integer'),
    body('moveCount').isInt({ min: 0 }).withMessage('moveCount must be a non-negative integer'),
    body('winnerId').optional().isString(),
  ],
  validate,
  ctrl.finishGame
);

// POST /api/games/:id/moves
router.post('/:id/moves',
  [
    body('playerId').notEmpty().withMessage('playerId is required'),
    body('moveData').isObject().withMessage('moveData must be an object'),
    body('moveData.from').isObject().withMessage('moveData.from is required'),
    body('moveData.to').isObject().withMessage('moveData.to is required'),
  ],
  validate,
  ctrl.addMove
);

// POST /api/games/start-bet — register game + deduct bet from token backend
router.post('/start-bet',
  [
    body('gameId').notEmpty().withMessage('gameId is required'),
    body('playerId').notEmpty().withMessage('playerId is required'),
    body('phone').notEmpty().withMessage('phone is required'),
    body('betAmount').isInt({ min: 0 }).withMessage('betAmount must be a non-negative integer'),
    body('mode').optional().isIn(['ai', 'pvp']),
    body('player2Id').optional().isString(),
  ],
  validate,
  ctrl.startBet
);

// POST /api/games/finish-local — save a completed no-bet AI or local game (stats only)
router.post('/finish-local',
  [
    body('player1Id').notEmpty().withMessage('player1Id is required'),
    body('result').isIn(['win','loss','draw']).withMessage('result must be win, loss, or draw'),
    body('mode').optional().isIn(['ai','pvp']),
    body('player2Id').optional().isString(),
    body('winnerId').optional().isString(),
    body('durationSec').optional().isInt({ min: 0 }),
    body('moveCount').optional().isInt({ min: 0 }),
  ],
  validate,
  ctrl.finishLocal
);

// POST /api/games/finish-ai-bet — settle a real-bet AI game (financial settlement + owner callback)
// Call this after start-bet when the AI game ends.
// Body: { gameId, humanId, aiId, result: 'win'|'loss'|'draw', durationSec?, moveCount? }
router.post('/finish-ai-bet',
  [
    body('gameId').notEmpty().withMessage('gameId is required'),
    body('humanId').notEmpty().withMessage('humanId is required'),
    body('aiId').notEmpty().withMessage('aiId is required'),
    body('result').isIn(['win','loss','draw']).withMessage('result must be win, loss, or draw'),
    body('durationSec').optional().isInt({ min: 0 }),
    body('moveCount').optional().isInt({ min: 0 }),
  ],
  validate,
  ctrl.finishAiBet
);

export default router;
