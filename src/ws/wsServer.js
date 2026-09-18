// backend/src/ws/wsServer.js
import { WebSocketServer } from 'ws';
import { query } from '../db/database.js';
import * as playersService from '../services/players.js';
import * as gamesService from '../services/games.js';
import { settleWin, settleDraw, settleAiWin, settleAiDraw } from '../services/settlement.js';
import { notifyBetPlaced, getTokenIdForPlayer } from '../services/ownerCallback.js';
import { logger } from '../utils/logger.js';
import {
  CLIENT_JOIN,
  CLIENT_LEAVE,
  CLIENT_PING,
  SERVER_PONG,
  SERVER_PRESENCE,
  SERVER_PLAYER_UPDATED,
  CHALLENGE_SEND,
  CHALLENGE_ACCEPT,
  CHALLENGE_DECLINE,
  MAKE_MOVE,
  GAME_OVER,
  GAME_RESIGN,
  CHALLENGE_RECEIVE,
  CHALLENGE_DECLINED,
  GAME_START,
  MOVE_MADE,
  OPPONENT_LEFT,
  OPPONENT_REJOINED,
  KICKED,
} from './wsEvents.js';

/** @type {WebSocketServer} */
let wss;

/** Map of playerId → WebSocket */
const connections = new Map();

/** Map of playerId → NodeJS.Timeout (disconnect-resign timers) */
const disconnectTimers = new Map();

// ── Helpers ─────────────────────────────────────────────────────────────────

const send = (ws, payload) => {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
};

const broadcast = (payload) => {
  const message = JSON.stringify(payload);
  for (const ws of connections.values()) {
    if (ws.readyState === 1) ws.send(message);
  }
};

const broadcastPresence = () => {
  const online = Array.from(connections.keys());
  broadcast({ type: SERVER_PRESENCE, online });
};

export const broadcastPlayerUpdated = (player) => {
  broadcast({ type: SERVER_PLAYER_UPDATED, player });
};

export const broadcastAiConfigUpdated = (config) => {
  broadcast({ type: 'ai_config_updated', config });
};

// ── Token validation (async) ─────────────────────────────────────────────────

async function validateWsToken(raw) {
  if (!raw) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  const { rows } = await query(
    `SELECT id, is_active, expires_at FROM api_tokens WHERE token = $1`, [raw]
  );
  if (!rows.length || !rows[0].is_active) return false;
  if (rows[0].expires_at && rows[0].expires_at < nowSec) return false;
  await query(`UPDATE api_tokens SET last_used = $1 WHERE id = $2`, [nowSec, rows[0].id]);
  return true;
}

async function isAiPlayerId(playerId) {
  if (!playerId) return false;
  const { rows } = await query(`SELECT is_ai FROM players WHERE id = $1`, [playerId]);
  return rows[0]?.is_ai === 1;
}

// ── Server ───────────────────────────────────────────────────────────────────

export const attachWsServer = (httpServer) => {
  wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws, req) => {
    logger.debug('WS: new connection');

    const urlParams = new URLSearchParams(req.url?.split('?')[1] || '');
    const urlToken  = urlParams.get('token');

    ws._authenticated = false;
    ws._urlToken      = urlToken;

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch { logger.warn('WS: received invalid JSON'); return; }

      // Dispatch to async handler, swallow top-level errors
      handleMessage(ws, msg).catch((err) => {
        logger.error(`WS message handler error [${msg.type}]:`, err.message);
      });
    });

    ws.on('close', () => {
      handleClose(ws).catch((err) => logger.error('WS close handler error:', err.message));
    });

    ws.on('error', (err) => {
      logger.error('WS socket error:', err.message);
    });
  });

  setInterval(broadcastPresence, 30_000);
  logger.info('WebSocket server attached.');
};

// ── Async message handler ────────────────────────────────────────────────────

async function handleMessage(ws, msg) {
  switch (msg.type) {

    // ── JOIN ───────────────────────────────────────────────────────────────
    case CLIENT_JOIN: {
      const { playerId, apiToken } = msg;
      if (!playerId) return;

      const tokenToCheck = apiToken || ws._urlToken || null;
      const { rows: tokenCountRows } = await query(`SELECT COUNT(*) AS cnt FROM api_tokens`);
      const tokenCount = parseInt(tokenCountRows[0].cnt, 10);

      if (tokenCount > 0 && tokenToCheck) {
        if (!(await validateWsToken(tokenToCheck))) {
          send(ws, { type: 'error', message: 'Invalid or expired API token' });
          ws.close(4001, 'invalid_token');
          return;
        }
      }

      ws._authenticated = true;

      // Kick older session
      if (connections.has(playerId)) {
        const oldWs = connections.get(playerId);
        logger.info(`WS: ${playerId} joined from new device — kicking old session`);
        send(oldWs, {
          type: KICKED,
          reason: 'You have been disconnected because you logged in from another device or tab.',
        });
        oldWs.close(4000, 'session_replaced');
      }

      // Clear reconnect timer
      if (disconnectTimers.has(playerId)) {
        clearTimeout(disconnectTimers.get(playerId));
        disconnectTimers.delete(playerId);
        logger.info(`WS: ${playerId} reconnected — cancelled auto-resign timer`);
      }

      connections.set(playerId, ws);
      ws.playerId = playerId;
      await playersService.markOnline(playerId, true);
      logger.debug(`WS: player joined — ${playerId}`);
      broadcastPresence();

      // Game reconnection check
      const activeGames = await gamesService.getAll({ status: 'active', playerId });
      if (activeGames.length > 0) {
        const activeGame = activeGames[0];
        const oppId = activeGame.player1_id === playerId
          ? activeGame.player2_id
          : activeGame.player1_id;

        const oppWs = connections.get(oppId);
        if (oppWs) send(oppWs, { type: OPPONENT_REJOINED, playerId });

        const fullGame = await gamesService.getById(activeGame.id);
        const myColor  = activeGame.player1_id === playerId ? 'black' : 'white';
        const opponent = await playersService.getById(oppId);
        send(ws, {
          type: GAME_START,
          gameId: activeGame.id,
          opponent,
          myColor,
          turn: fullGame.moves.length % 2 === 0 ? 'black' : 'white',
          betAmount: activeGame.bet_amount,
          history: fullGame.moves,
        });
      }
      break;
    }

    // ── LEAVE ──────────────────────────────────────────────────────────────
    case CLIENT_LEAVE: {
      const { playerId } = msg;
      if (!playerId) return;
      connections.delete(playerId);
      await playersService.markOnline(playerId, false);
      logger.debug(`WS: player left — ${playerId}`);
      broadcastPresence();
      break;
    }

    // ── PING ───────────────────────────────────────────────────────────────
    case CLIENT_PING: {
      send(ws, { type: SERVER_PONG });
      break;
    }

    // ── CHALLENGE SEND ─────────────────────────────────────────────────────
    case CHALLENGE_SEND: {
      const { challengerId, opponentId, betAmount } = msg;
      const oppWs = connections.get(opponentId);
      if (oppWs) {
        const challenger = await playersService.getById(challengerId);
        send(oppWs, { type: CHALLENGE_RECEIVE, challenger, betAmount });
      }
      break;
    }

    // ── CHALLENGE DECLINE ──────────────────────────────────────────────────
    case CHALLENGE_DECLINE: {
      const { challengerId } = msg;
      const chalWs = connections.get(challengerId);
      if (chalWs) send(chalWs, { type: CHALLENGE_DECLINED, opponentId: msg.opponentId });
      break;
    }

    // ── CHALLENGE ACCEPT ───────────────────────────────────────────────────
    case CHALLENGE_ACCEPT: {
      const { challengerId, opponentId, betAmount } = msg;
      const chalWs = connections.get(challengerId);
      const oppWs  = connections.get(opponentId);

      const [challenger, opponent] = await Promise.all([
        playersService.getById(challengerId),
        playersService.getById(opponentId),
      ]);
      if (!challenger || !opponent) return;

      if (challenger.balance < betAmount || opponent.balance < betAmount) {
        const errMsg = 'Insufficient balance to start this match.';
        if (chalWs) send(chalWs, { type: 'error', message: errMsg });
        if (oppWs)  send(oppWs,  { type: 'error', message: errMsg });
        return;
      }

      await Promise.all([
        playersService.adjustBalance(challengerId, -betAmount),
        playersService.adjustBalance(opponentId,   -betAmount),
      ]);

      const game = await gamesService.create({
        mode: 'pvp', player1Id: challengerId, player2Id: opponentId, betAmount,
      });

      const tokenId = await getTokenIdForPlayer(challengerId);
      notifyBetPlaced(tokenId, {
        player1Id: challengerId, player2Id: opponentId, betAmount, gameId: game.id,
      }).catch(() => {});

      if (chalWs) send(chalWs, { type: GAME_START, gameId: game.id, opponent, myColor: 'black', turn: 'black', betAmount });
      if (oppWs)  send(oppWs,  { type: GAME_START, gameId: game.id, opponent: challenger, myColor: 'white', turn: 'black', betAmount });

      const [updChal, updOpp] = await Promise.all([
        playersService.getById(challengerId),
        playersService.getById(opponentId),
      ]);
      broadcast({ type: SERVER_PLAYER_UPDATED, player: updChal });
      broadcast({ type: SERVER_PLAYER_UPDATED, player: updOpp });
      break;
    }

    // ── MAKE MOVE ──────────────────────────────────────────────────────────
    case MAKE_MOVE: {
      if (!ws._authenticated) return;
      const { gameId, playerId, from, move } = msg;
      await gamesService.addMove(gameId, playerId, { from, move });

      const game = await gamesService.getById(gameId);
      if (game) {
        const oppId = game.player1_id === playerId ? game.player2_id : game.player1_id;
        const oppWs = connections.get(oppId);
        if (oppWs) send(oppWs, { type: MOVE_MADE, from, move });
      }
      break;
    }

    // ── GAME OVER ──────────────────────────────────────────────────────────
    case GAME_OVER: {
      if (!ws._authenticated) return;
      const { gameId, winnerId, reason, durationSec, moveCount } = msg;
      const game = await gamesService.getById(gameId);
      if (!game || game.status === 'finished') return;

      await gamesService.finish(gameId, { winnerId, durationSec, moveCount });

      const [p1IsAi, p2IsAi] = await Promise.all([
        isAiPlayerId(game.player1_id),
        isAiPlayerId(game.player2_id),
      ]);
      const isAiGame = p1IsAi || p2IsAi;

      let settlement = {};
      if (winnerId) {
        const loserId = game.player1_id === winnerId ? game.player2_id : game.player1_id;
        settlement = isAiGame
          ? await settleAiWin(winnerId, loserId, game)
          : await settleWin(winnerId, loserId, game);
      } else {
        if (isAiGame) {
          const humanId = p1IsAi ? game.player2_id : game.player1_id;
          settlement = await settleAiDraw(humanId, game);
        } else {
          settlement = await settleDraw(game);
        }
      }

      const [p1, p2] = await Promise.all([
        playersService.getById(game.player1_id),
        game.player2_id ? playersService.getById(game.player2_id) : Promise.resolve(null),
      ]);
      broadcast({ type: SERVER_PLAYER_UPDATED, player: p1 });
      if (p2) broadcast({ type: SERVER_PLAYER_UPDATED, player: p2 });

      const payload = {
        type: GAME_OVER, winnerId, reason,
        settlement: {
          winnerPayout: settlement.winnerPayout ?? 0,
          fee:          settlement.fee          ?? 0,
          refund:       settlement.refund       ?? 0,
          ownerDelta:   settlement.ownerDelta   ?? 0,
        },
      };
      const s1 = connections.get(game.player1_id);
      const s2 = game.player2_id ? connections.get(game.player2_id) : null;
      if (s1) send(s1, payload);
      if (s2) send(s2, payload);
      break;
    }

    // ── RESIGN ─────────────────────────────────────────────────────────────
    case GAME_RESIGN: {
      if (!ws._authenticated) return;
      const { gameId, playerId } = msg;
      const game = await gamesService.getById(gameId);
      if (!game || game.status === 'finished') return;

      const winnerId = game.player1_id === playerId ? game.player2_id : game.player1_id;
      await gamesService.finish(gameId, { winnerId, durationSec: 0, moveCount: 0 });

      const [p1IsAiR, p2IsAiR] = await Promise.all([
        isAiPlayerId(game.player1_id),
        isAiPlayerId(game.player2_id),
      ]);
      const isAiGameR = p1IsAiR || p2IsAiR;

      const resignSettlement = isAiGameR
        ? await settleAiWin(winnerId, playerId, game)
        : await settleWin(winnerId, playerId, game);

      const [rp1, rp2] = await Promise.all([
        playersService.getById(game.player1_id),
        game.player2_id ? playersService.getById(game.player2_id) : Promise.resolve(null),
      ]);
      broadcast({ type: SERVER_PLAYER_UPDATED, player: rp1 });
      if (rp2) broadcast({ type: SERVER_PLAYER_UPDATED, player: rp2 });

      const resignPayload = {
        type: GAME_OVER, winnerId, reason: 'Opponent resigned',
        settlement: {
          winnerPayout: resignSettlement.winnerPayout ?? 0,
          fee:          resignSettlement.fee          ?? 0,
          refund:       resignSettlement.refund       ?? 0,
          ownerDelta:   resignSettlement.ownerDelta   ?? 0,
        },
      };
      const rs1 = connections.get(game.player1_id);
      const rs2 = game.player2_id ? connections.get(game.player2_id) : null;
      if (rs1) send(rs1, resignPayload);
      if (rs2) send(rs2, resignPayload);
      break;
    }

    default:
      logger.warn(`WS: unknown message type "${msg.type}"`);
  }
}

// ── Async close handler ──────────────────────────────────────────────────────

async function handleClose(ws) {
  if (!ws.playerId) return;
  if (connections.get(ws.playerId) !== ws) return; // stale ref

  connections.delete(ws.playerId);
  await playersService.markOnline(ws.playerId, false);
  logger.debug(`WS: disconnected — ${ws.playerId}`);
  broadcastPresence();

  const activeGames = await gamesService.getAll({ status: 'active', playerId: ws.playerId });
  if (activeGames.length === 0) return;

  const activeGame = activeGames[0];
  const myId  = ws.playerId;
  const oppId = activeGame.player1_id === myId ? activeGame.player2_id : activeGame.player1_id;

  const oppWs = connections.get(oppId);
  if (oppWs) send(oppWs, { type: OPPONENT_LEFT, playerId: myId });

  logger.info(`WS: ${myId} disconnected mid-game — starting 5s reconnect timer`);

  const timer = setTimeout(async () => {
    disconnectTimers.delete(myId);
    logger.info(`WS: ${myId} failed to reconnect — auto-resigning`);

    try {
      const freshGame = await gamesService.getById(activeGame.id);
      if (!freshGame || freshGame.status !== 'active') return;

      const winnerId = oppId;
      await gamesService.finish(activeGame.id, {
        winnerId, durationSec: 0, moveCount: freshGame.moves.length,
      });

      const [dp1IsAi, dp2IsAi] = await Promise.all([
        isAiPlayerId(freshGame.player1_id),
        isAiPlayerId(freshGame.player2_id),
      ]);
      const isAiGameD   = dp1IsAi || dp2IsAi;
      const dcSettlement = isAiGameD
        ? await settleAiWin(winnerId, myId, freshGame)
        : await settleWin(winnerId, myId, freshGame);

      const winWs = connections.get(winnerId);
      if (winWs) send(winWs, {
        type: GAME_OVER, winnerId, reason: 'Opponent disconnected',
        settlement: {
          winnerPayout: dcSettlement.winnerPayout ?? 0,
          fee:          dcSettlement.fee          ?? 0,
          refund:       dcSettlement.refund       ?? 0,
          ownerDelta:   dcSettlement.ownerDelta   ?? 0,
        },
      });

      const [fp1, fp2] = await Promise.all([
        playersService.getById(activeGame.player1_id),
        activeGame.player2_id ? playersService.getById(activeGame.player2_id) : Promise.resolve(null),
      ]);
      broadcast({ type: SERVER_PLAYER_UPDATED, player: fp1 });
      if (fp2) broadcast({ type: SERVER_PLAYER_UPDATED, player: fp2 });
    } catch (err) {
      logger.error('WS: auto-resign error:', err.message);
    }
  }, 5_000);

  disconnectTimers.set(myId, timer);
}

// exported for use in tests / admin
export { connections, disconnectTimers };
