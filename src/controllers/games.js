import * as gamesService from '../services/games.js';
import * as playersService from '../services/players.js';
import { settleAiWin, settleAiDraw } from '../services/settlement.js';
import { ok, fail } from '../utils/response.js';
import { query } from '../db/database.js';
import { normalizePhone } from '../utils/phone.js';
import { verifyLaunchToken } from '../utils/launchToken.js';
import { SYSTEM_BACKEND_URL } from '../config/env.js';
import { getConfig as getAiConfig } from '../services/ai.js';

const now = () => Math.floor(Date.now() / 1000);

async function ensureAiEnabled(res) {
  const config = await getAiConfig();
  if (config && Number(config.ai_enabled) === 0) {
    fail(res, 'AI play is currently disabled', 403);
    return false;
  }
  return true;
}

export const listGames = async (req, res, next) => {
  try {
    const { status, playerId, limit, offset } = req.query;
    const games = await gamesService.getAll({ status, playerId, limit, offset });
    ok(res, games);
  } catch (err) { next(err); }
};

export const getGame = async (req, res, next) => {
  try {
    const game = await gamesService.getById(req.params.id);
    if (!game) return fail(res, 'Game not found', 404);
    ok(res, game);
  } catch (err) { next(err); }
};

export const createGame = async (req, res, next) => {
  try {
    const { mode, player1Id, player2Id, betAmount } = req.body;
    if (mode === 'ai' && !(await ensureAiEnabled(res))) return;
    const game = await gamesService.create({ mode, player1Id, player2Id, betAmount });
    ok(res, game, 201);
  } catch (err) { next(err); }
};

export const finishGame = async (req, res, next) => {
  try {
    const existing = await gamesService.getById(req.params.id);
    if (!existing) return fail(res, 'Game not found', 404);
    const { winnerId, durationSec, moveCount } = req.body;
    const game = await gamesService.finish(req.params.id, { winnerId, durationSec, moveCount });
    ok(res, game);
  } catch (err) { next(err); }
};

export const addMove = async (req, res, next) => {
  try {
    const existing = await gamesService.getById(req.params.id);
    if (!existing) return fail(res, 'Game not found', 404);
    const { playerId, moveData } = req.body;
    const move = await gamesService.addMove(req.params.id, playerId, moveData);
    ok(res, move, 201);
  } catch (err) { next(err); }
};

export const finishLocal = async (req, res, next) => {
  try {
    const { mode, player1Id, player2Id, winnerId, result, durationSec = 0, moveCount = 0 } = req.body;

    if ((mode || 'ai') === 'ai' && !(await ensureAiEnabled(res))) return;

    if (!player1Id || !result) return fail(res, 'player1Id and result required', 400);
    if (!['win','loss','draw'].includes(result)) return fail(res, 'result must be win, loss, or draw', 400);

    const game = await gamesService.create({ mode: mode || 'ai', player1Id, player2Id: player2Id || null, betAmount: 0 });
    await gamesService.finish(game.id, { winnerId: winnerId || null, durationSec, moveCount });

    await playersService.recordResult(player1Id, result);

    if (player2Id) {
      const p2 = await playersService.getById(player2Id);
      if (p2) {
        const p2Result = result === 'win' ? 'loss' : result === 'loss' ? 'win' : 'draw';
        await playersService.recordResult(player2Id, p2Result);
      }
    }

    const finished = await gamesService.getById(game.id);
    ok(res, finished, 201);
  } catch (err) { next(err); }
};

export const finishAiBet = async (req, res, next) => {
  try {
    const {
      gameId, humanId, aiId, result,
      betAmount, durationSec = 0, moveCount = 0,
    } = req.body;

    if (!gameId)  return fail(res, 'gameId is required',  400);
    if (!humanId) return fail(res, 'humanId is required', 400);
    if (!aiId)    return fail(res, 'aiId is required',    400);
    if (!['win', 'loss', 'draw'].includes(result)) {
      return fail(res, 'result must be win, loss, or draw', 400);
    }

    let { rows: gameRows } = await query(`SELECT * FROM games WHERE id = $1`, [gameId]);
    if (!gameRows.length) return fail(res, `Game ${gameId} not found. Call start-bet first.`, 404);
    let game = gameRows[0];
    if (game.status === 'finished') return fail(res, 'Game already finished', 409);

    if (betAmount > 0 && (game.bet_amount === 0 || game.bet_amount === null)) {
      await query(
        `UPDATE games SET bet_amount = $1, player2_id = COALESCE(player2_id, $2) WHERE id = $3`,
        [betAmount, aiId, gameId]
      );
      const { rows: refreshed } = await query(`SELECT * FROM games WHERE id = $1`, [gameId]);
      game = refreshed[0];
    }

    if (req.apiToken?.id) {
      await query(
        `UPDATE players SET token_id = $1 WHERE id = $2 AND token_id IS NULL`,
        [req.apiToken.id, humanId]
      );
    }

    const winnerId = result === 'win' ? humanId : result === 'loss' ? aiId : null;
    await gamesService.finish(gameId, { winnerId, durationSec, moveCount });

    const { rows: freshRows } = await query(`SELECT * FROM games WHERE id = $1`, [gameId]);
    const freshGame = freshRows[0];

    let settlement = {};
    if (result === 'draw') {
      settlement = await settleAiDraw(humanId, freshGame);
    } else {
      settlement = await settleAiWin(winnerId, result === 'win' ? aiId : humanId, freshGame);
    }

    const updatedPlayer = await playersService.getById(humanId);
    ok(res, {
      game:       await gamesService.getById(gameId),
      player:     updatedPlayer,
      settlement: {
        result,
        winnerPayout: settlement.winnerPayout ?? 0,
        fee:          settlement.fee          ?? 0,
        refund:       settlement.refund       ?? 0,
        ownerDelta:   settlement.ownerDelta   ?? 0,
      },
    }, 200);
  } catch (err) { next(err); }
};

export const startBet = async (req, res, next) => {
  try {
    const {
      gameId, playerId, phone, launch,
      betAmount = 0, mode = 'pvp', player2Id = null,
    } = req.body;

    if (!gameId)   return fail(res, 'gameId is required',   400);
    if (!playerId) return fail(res, 'playerId is required', 400);
    if (!launch)   return fail(res, 'launch token is required', 400);
    if (mode === 'ai' && !(await ensureAiEnabled(res))) return;

    let claims;
    try {
      claims = await verifyLaunchToken(launch, SYSTEM_BACKEND_URL);
    } catch {
      return fail(res, 'Invalid or expired launch token', 401);
    }
    if (!claims?.phone) return fail(res, 'Launch token has no phone claim', 401);

    const verifiedPhone    = normalizePhone(claims.phone);
    const verifiedUsername = claims.username || req.body.username || 'Player';

    // Ensure player exists
    const { rows: existingPlayer } = await query(`SELECT id FROM players WHERE id = $1`, [playerId]);
    if (!existingPlayer.length) {
      const tokenId = req.apiToken?.id || null;
      await query(
        `INSERT INTO players (id, name, phone, token_id, balance) VALUES ($1, $2, $3, $4, 500) ON CONFLICT DO NOTHING`,
        [playerId, verifiedUsername, verifiedPhone, tokenId]
      );
    } else if (req.apiToken?.id) {
      await query(
        `UPDATE players SET token_id = $1 WHERE id = $2 AND token_id IS NULL`,
        [req.apiToken.id, playerId]
      );
    }

    let { rows: gameRows } = await query(`SELECT * FROM games WHERE id = $1`, [gameId]);
    let game = gameRows[0];
    if (!game) {
      await query(
        `INSERT INTO games (id, mode, player1_id, player2_id, bet_amount) VALUES ($1,$2,$3,$4,$5)`,
        [gameId, mode, playerId, player2Id, betAmount]
      );
      const { rows } = await query(`SELECT * FROM games WHERE id = $1`, [gameId]);
      game = rows[0];
    }

    if (betAmount <= 0) {
      return ok(res, { game, betLog: null, skipped: true, reason: 'no bet amount' });
    }

    // Resolve token → backend_url
    const { rows: playerRows } = await query(`SELECT token_id, name FROM players WHERE id = $1`, [playerId]);
    const tokenId    = playerRows[0]?.token_id || req.apiToken?.id || null;

    const { rows: tokenRows } = tokenId
      ? await query(`SELECT backend_url, token FROM api_tokens WHERE id = $1 AND is_active = 1`, [tokenId])
      : { rows: [] };

    const backendUrl = tokenRows[0]?.backend_url || null;
    const tokenStr   = tokenRows[0]?.token       || null;

    const requestBody = {
      action:   'deduct', token: tokenStr,
      phone:    verifiedPhone,
      username: playerRows[0]?.name || verifiedUsername,
      playerId, amount: betAmount, gameId,
    };

    let responseBody = null;
    let status       = 'pending';
    let errorMsg     = null;

    if (backendUrl) {
      const callUrl = backendUrl.replace(/\/$/, '') + '/dama';
      try {
        const resp = await fetch(callUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(requestBody),
          signal:  AbortSignal.timeout(6000),
        });
        const text = await resp.text();
        try { responseBody = JSON.parse(text); } catch { responseBody = { raw: text }; }
        status   = resp.ok ? 'success' : 'failed';
        if (!resp.ok) errorMsg = `HTTP ${resp.status}`;
      } catch (fetchErr) {
        status   = 'error';
        errorMsg = fetchErr.message;
      }
    } else {
      status   = 'no_backend';
      errorMsg = 'No backend_url configured for this token';
    }

    await query(`
      INSERT INTO game_bet_log
        (game_id, player_id, phone, bet_amount, backend_url, request_body, response_body, status, error)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [
      gameId, playerId, verifiedPhone, betAmount,
      backendUrl || null,
      JSON.stringify(requestBody),
      responseBody ? JSON.stringify(responseBody) : null,
      status, errorMsg || null,
    ]);

    const { rows: betLogRows } = await query(
      `SELECT * FROM game_bet_log WHERE game_id = $1 AND player_id = $2 ORDER BY id DESC LIMIT 1`,
      [gameId, playerId]
    );

    return ok(res, {
      game,
      betLog: {
        ...betLogRows[0],
        requestBody, responseBody,
        backendUrl: backendUrl || null,
        status, error: errorMsg || null,
      },
    }, 201);
  } catch (err) { next(err); }
};
