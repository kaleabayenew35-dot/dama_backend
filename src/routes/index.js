import { Router } from 'express';
import db from '../db/database.js';
import healthRouter        from './health.js';
import playersRouter       from './players.js';
import gamesRouter         from './games.js';
import aiRouter            from './ai.js';
import adminRouter         from './admin.js';
import tokensRouter        from './tokens.js';
import balanceRouter       from './balance.js';
import checkBalanceRouter  from './checkBalance.js';
import checkLocalRouter    from './checkLocalBalance.js';

const router = Router();

// POST /api/token-backend-url — gets partner backend URL for the active API token
router.post('/token-backend-url', async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ ok: false, error: 'Token is required' });

    const row = db.prepare('SELECT backend_url FROM api_tokens WHERE token = ? AND is_active = 1').get(token);
    if (!row) return res.status(404).json({ ok: false, error: 'Invalid or inactive API token' });

    res.json({ ok: true, data: { backendUrl: row.backend_url } });
  } catch (err) {
    next(err);
  }
});

router.use('/health',           healthRouter);
router.use('/players',          playersRouter);
router.use('/games',            gamesRouter);
router.use('/ai',               aiRouter);
router.use('/admin',            adminRouter);
router.use('/admin/tokens',     tokensRouter);
router.use('/player-balance',   balanceRouter);
router.use('/check-balance',    checkBalanceRouter);
router.use('/check-local-balance', checkLocalRouter);

export default router;
