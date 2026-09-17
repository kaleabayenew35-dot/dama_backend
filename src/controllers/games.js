import * as gamesService from '../services/games.js';
import * as playersService from '../services/players.js';
import { settleAiWin, settleAiDraw } from '../services/settlement.js';
import { ok, fail } from '../utils/response.js';
import db from '../db/database.js';
import { normalizePhone } from '../utils/phone.js';

export const listGames = async (req, res, next) => {
  try {
    const { status, playerId, limit, offset } = req.query;
    const games = gamesService.getAll({ status, playerId, limit, offset });
    ok(res, games);
  } catch (err) {
    next(err);
  }
};

export const getGame = async (req, res, next) => {
  try {
    const game = gamesService.getById(req.params.id);
    if (!game) return fail(res, 'Game not found', 404);
    ok(res, game);
  } catch (err) {
    next(err);
  }
};

export const createGame = async (req, res, next) => {
  try {
    const { mode, player1Id, player2Id, betAmount } = req.body;
    const game = gamesService.create({ mode, player1Id, player2Id, betAmount });
    ok(res, game, 201);
  } catch (err) {
    next(err);
  }
};

export const finishGame = async (req, res, next) => {
  try {
    const existing = gamesService.getById(req.params.id);
    if (!existing) return fail(res, 'Game not found', 404);
    const { winnerId, durationSec, moveCount } = req.body;
    const game = gamesService.finish(req.params.id, { winnerId, durationSec, moveCount });
    ok(res, game);
  } catch (err) {
    next(err);
  }
};

export const addMove = async (req, res, next) => {
  try {
    const existing = gamesService.getById(req.params.id);
    if (!existing) return fail(res, 'Game not found', 404);
    const { playerId, moveData } = req.body;
    const move = gamesService.addMove(req.params.id, playerId, moveData);
    ok(res, move, 201);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/games/finish-local
 * Records a completed AI or local (no-bet) game.
 * Body: { mode, player1Id, player2Id?, winnerId?, result, durationSec, moveCount }
 *   result: 'win' | 'loss' | 'draw'  (from player1's perspective)
 *
 * NOTE: For AI games WITH a real bet, use POST /api/games/finish-ai-bet instead.
 */
export const finishLocal = async (req, res, next) => {
  try {
    const { mode, player1Id, player2Id, winnerId, result, durationSec = 0, moveCount = 0 } = req.body;

    if (!player1Id || !result) return fail(res, 'player1Id and result required', 400);
    if (!['win','loss','draw'].includes(result)) return fail(res, 'result must be win, loss, or draw', 400);

    // Create the game record (always betAmount=0 for finish-local)
    const game = gamesService.create({ mode: mode || 'ai', player1Id, player2Id: player2Id || null, betAmount: 0 });
    gamesService.finish(game.id, { winnerId: winnerId || null, durationSec, moveCount });

    // Record result for player1
    playersService.recordResult(player1Id, result);

    // Record inverse result for player2 only if they are a real DB player
    if (player2Id) {
      const p2 = playersService.getById(player2Id);
      if (p2) {
        const p2Result = result === 'win' ? 'loss' : result === 'loss' ? 'win' : 'draw';
        playersService.recordResult(player2Id, p2Result);
      }
    }

    const finished = gamesService.getById(game.id);
    ok(res, finished, 201);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/games/finish-ai-bet
 *
 * Records a completed AI game that had a real bet, runs full financial settlement,
 * updates the token owner balance, and sends callbacks to the token backend.
 *
 * Body:
 * {
 *   gameId:      string,   // the game ID created by start-bet
 *   humanId:     string,   // the real player's ID
 *   aiId:        string,   // the AI bot's player ID
 *   result:      'win' | 'loss' | 'draw',  // from the HUMAN player's perspective
 *   durationSec: number,   // optional
 *   moveCount:   number,   // optional
 * }
 *
 * Settlement logic:
 *   win  (human wins) → human credited pot−10%, owner balance −(bet−fee)
 *   loss (AI wins)    → human gets nothing,    owner balance +bet +fee
 *   draw              → human refunded bet−5%, owner balance +totalFee
 *
 * Response: { game, settlement }
 *   settlement.winnerPayout  — amount added to human's balance (0 on loss)
 *   settlement.fee           — 10%/5% commission
 *   settlement.refund        — refund on draw
 *   settlement.ownerDelta    — net change to owner balance (can be negative)
 */
export const finishAiBet = async (req, res, next) => {
  try {
    const {
      gameId,
      humanId,
      aiId,
      result,
      betAmount,        // optional — patch game row if bet_amount is 0
      durationSec = 0,
      moveCount   = 0,
    } = req.body;

    if (!gameId)  return fail(res, 'gameId is required',  400);
    if (!humanId) return fail(res, 'humanId is required', 400);
    if (!aiId)    return fail(res, 'aiId is required',    400);
    if (!['win', 'loss', 'draw'].includes(result)) {
      return fail(res, 'result must be win, loss, or draw', 400);
    }

    // Load game
    let game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    if (!game) return fail(res, `Game ${gameId} not found. Call start-bet first.`, 404);
    if (game.status === 'finished') return fail(res, 'Game already finished', 409);

    // Patch bet_amount if the game row has 0 but client sent a betAmount
    if (betAmount > 0 && (game.bet_amount === 0 || game.bet_amount === null)) {
      db.prepare('UPDATE games SET bet_amount = ?, player2_id = COALESCE(player2_id, ?) WHERE id = ?')
        .run(betAmount, aiId, gameId);
      game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    }

    // Ensure player has token_id linked (patch if missing and token in request)
    if (req.apiToken?.id) {
      db.prepare('UPDATE players SET token_id = ? WHERE id = ? AND token_id IS NULL')
        .run(req.apiToken.id, humanId);
    }

    const winnerId = result === 'win' ? humanId : result === 'loss' ? aiId : null;
    gamesService.finish(gameId, { winnerId, durationSec, moveCount });

    const freshGame = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);

    let settlement = {};
    if (result === 'draw') {
      settlement = settleAiDraw(humanId, freshGame);
    } else {
      settlement = settleAiWin(winnerId, result === 'win' ? aiId : humanId, freshGame);
    }

    const updatedPlayer = playersService.getById(humanId);
    ok(res, {
      game:       gamesService.getById(gameId),
      player:     updatedPlayer,
      settlement: {
        result,
        winnerPayout: settlement.winnerPayout ?? 0,
        fee:          settlement.fee          ?? 0,
        refund:       settlement.refund       ?? 0,
        ownerDelta:   settlement.ownerDelta   ?? 0,
      },
    }, 200);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/games/start-bet
 * Body: { gameId, playerId, phone, betAmount, mode, player2Id? }
 *
 * Steps:
 *  1. Upsert the game row in `games` (using the client-supplied gameId)
 *  2. Resolve the player's token row → backend_url
 *  3. POST {backend_url}/dama with action:'deduct'
 *  4. Write a row to game_bet_log (request + response + status)
 *  5. Return { game, betLog } to the frontend so it can display the audit trail
 */
export const startBet = async (req, res, next) => {
  try {
    const {
      gameId,
      playerId,
      phone,
      betAmount = 0,
      mode = 'pvp',
      player2Id = null,
    } = req.body;

    if (!gameId)   return fail(res, 'gameId is required',   400);
    if (!playerId) return fail(res, 'playerId is required', 400);
    if (!phone)    return fail(res, 'phone is required',    400);

    // ── 1. Ensure player exists, then upsert game record ──────────────────────
    // Auto-create the player if they don't exist yet — prevents FK violation
    // on the games INSERT and handles first-time logins gracefully.
    const existingPlayer = db.prepare('SELECT id FROM players WHERE id = ?').get(playerId);
    if (!existingPlayer) {
      const tokenId = req.apiToken?.id || null;
      db.prepare(`
        INSERT OR IGNORE INTO players (id, name, phone, token_id, balance)
        VALUES (?, ?, ?, ?, 500)
      `).run(
        playerId,
        req.body.username || 'Player',
        normalizePhone(phone),
        tokenId,
      );
    } else if (req.apiToken?.id) {
      // Ensure token_id is linked even on existing player
      db.prepare('UPDATE players SET token_id = ? WHERE id = ? AND token_id IS NULL')
        .run(req.apiToken.id, playerId);
    }

    let game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    if (!game) {
      db.prepare(`
        INSERT INTO games (id, mode, player1_id, player2_id, bet_amount)
        VALUES (?, ?, ?, ?, ?)
      `).run(gameId, mode, playerId, player2Id, betAmount);
      game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    }

    // If betAmount is 0, skip callback but still return success
    if (betAmount <= 0) {
      return ok(res, { game, betLog: null, skipped: true, reason: 'no bet amount' });
    }

    // ── 2. Resolve token_id → backend_url + token string for this player ─────
    const playerRow  = db.prepare('SELECT token_id, name FROM players WHERE id = ?').get(playerId);
    const tokenId    = playerRow?.token_id || req.apiToken?.id || null;

    const tokenRow   = tokenId
      ? db.prepare('SELECT backend_url, token FROM api_tokens WHERE id = ? AND is_active = 1').get(tokenId)
      : null;
    const backendUrl = tokenRow?.backend_url || null;
    const tokenStr   = tokenRow?.token       || null;
    const normPhone  = normalizePhone(phone);

    // ── 3. Build request body — include token so backend can authenticate ────
    const requestBody = {
      action:   'deduct',
      token:    tokenStr,
      phone:    normPhone,
      username: playerRow?.name || 'Player',
      playerId,
      amount:   betAmount,
      gameId,
    };

    // ── 4. Call token backend ───────────────────────────────────────────────
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
        status = resp.ok ? 'success' : 'failed';
        if (!resp.ok) errorMsg = `HTTP ${resp.status}`;
      } catch (fetchErr) {
        status   = 'error';
        errorMsg = fetchErr.message;
      }
    } else {
      status   = 'no_backend';
      errorMsg = 'No backend_url configured for this token';
    }

    // ── 5. Write to game_bet_log ─────────────────────────────────────────────
    db.prepare(`
      INSERT INTO game_bet_log
        (game_id, player_id, phone, bet_amount, backend_url, request_body, response_body, status, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      gameId,
      playerId,
      normPhone,
      betAmount,
      backendUrl || null,
      JSON.stringify(requestBody),
      responseBody ? JSON.stringify(responseBody) : null,
      status,
      errorMsg || null,
    );

    const betLog = db.prepare(
      'SELECT * FROM game_bet_log WHERE game_id = ? AND player_id = ? ORDER BY id DESC LIMIT 1'
    ).get(gameId, playerId);

    return ok(res, {
      game,
      betLog: {
        ...betLog,
        requestBody,
        responseBody,
        backendUrl: backendUrl || null,
        status,
        error: errorMsg || null,
      },
    }, 201);
  } catch (err) {
    next(err);
  }
};
