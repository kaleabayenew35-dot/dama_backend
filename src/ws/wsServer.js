// backend/src/ws/wsServer.js
import { WebSocketServer } from 'ws';
import db from '../db/database.js';
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

/** Send JSON to a single socket, safely. */
const send = (ws, payload) => {
  if (ws && ws.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify(payload));
  }
};

/** Broadcast JSON to every connected client. */
const broadcast = (payload) => {
  const message = JSON.stringify(payload);
  for (const ws of connections.values()) {
    if (ws.readyState === 1) ws.send(message);
  }
};

/** Collect online player IDs and broadcast presence. */
const broadcastPresence = () => {
  const online = Array.from(connections.keys());
  broadcast({ type: SERVER_PRESENCE, online });
};

/** Broadcast a player_updated event to all clients. */
export const broadcastPlayerUpdated = (player) => {
  broadcast({ type: SERVER_PLAYER_UPDATED, player });
};

/** Broadcast an ai_config_updated event to all clients. */
export const broadcastAiConfigUpdated = (config) => {
  broadcast({ type: 'ai_config_updated', config });
};

// ── Token validation ─────────────────────────────────────────────────────────

/**
 * Validate an API token string against the database.
 * Returns true and stamps last_used on success.
 * Returns false if the token is missing, invalid, revoked, or expired.
 */
function validateWsToken(raw) {
  if (!raw) return false;

  const row = db.prepare(`
    SELECT id, is_active, expires_at
    FROM api_tokens
    WHERE token = ?
  `).get(raw);

  if (!row || !row.is_active) return false;
  if (row.expires_at && row.expires_at < Math.floor(Date.now() / 1000)) return false;

  // Stamp last_used
  db.prepare('UPDATE api_tokens SET last_used = unixepoch() WHERE id = ?').run(row.id);
  return true;
}

// ── Server ───────────────────────────────────────────────────────────────────

/**
 * Attach a WebSocket server to an existing HTTP server.
 * @param {import('http').Server} httpServer
 */
export const attachWsServer = (httpServer) => {
  wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws, req) => {
    logger.debug('WS: new connection');

    // Parse token from URL query string: ws://host/?token=dama_xxx
    const urlParams = new URLSearchParams(req.url?.split('?')[1] || '');
    const urlToken = urlParams.get('token');

    // Mark socket as unauthenticated until a valid join message arrives
    ws._authenticated = false;
    ws._urlToken = urlToken; // may be null if client doesn't pass it in URL

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        logger.warn('WS: received invalid JSON');
        return;
      }

      switch (msg.type) {

        // ── JOIN ─────────────────────────────────────────────────────────────
        case CLIENT_JOIN: {
          const { playerId, sessionToken, apiToken } = msg;
          if (!playerId) return;

          // Validate API token — accept from URL query, join message, or skip
          // if no api_tokens have been created yet (dev mode convenience).
          const tokenToCheck = apiToken || ws._urlToken || null;
          const tokenCount = db.prepare('SELECT COUNT(*) as cnt FROM api_tokens').get().cnt;

          if (tokenCount > 0 && tokenToCheck) {
            if (!validateWsToken(tokenToCheck)) {
              send(ws, { type: 'error', message: 'Invalid or expired API token' });
              ws.close(4001, 'invalid_token');
              return;
            }
          }
          // If no tokens exist in DB at all, allow connection (first-run / dev)

          ws._authenticated = true;

          // ── Single-session enforcement: kick older connection ─────────────
          if (connections.has(playerId)) {
            const oldWs = connections.get(playerId);
            logger.info(`WS: ${playerId} joined from new device — kicking old session`);
            send(oldWs, {
              type: KICKED,
              reason: 'You have been disconnected because you logged in from another device or tab.',
            });
            oldWs.close(4000, 'session_replaced');
          }

          // ── Clear reconnect timer if present ─────────────────────────────
          if (disconnectTimers.has(playerId)) {
            clearTimeout(disconnectTimers.get(playerId));
            disconnectTimers.delete(playerId);
            logger.info(`WS: ${playerId} reconnected — cancelled auto-resign timer`);
          }

          connections.set(playerId, ws);
          ws.playerId = playerId;
          playersService.markOnline(playerId, true);
          logger.debug(`WS: player joined — ${playerId}`);
          broadcastPresence();

          // ── Game reconnection check ───────────────────────────────────────
          const activeGames = gamesService.getAll({ status: 'active', playerId });
          if (activeGames.length > 0) {
            const activeGame = activeGames[0];
            const oppId =
              activeGame.player1_id === playerId
                ? activeGame.player2_id
                : activeGame.player1_id;

            const oppWs = connections.get(oppId);
            if (oppWs) send(oppWs, { type: OPPONENT_REJOINED, playerId });

            const fullGame = gamesService.getById(activeGame.id);
            const myColor = activeGame.player1_id === playerId ? 'black' : 'white';
            const opponent = playersService.getById(oppId);
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

        // ── LEAVE ─────────────────────────────────────────────────────────────
        case CLIENT_LEAVE: {
          const { playerId } = msg;
          if (!playerId) return;
          connections.delete(playerId);
          playersService.markOnline(playerId, false);
          logger.debug(`WS: player left — ${playerId}`);
          broadcastPresence();
          break;
        }

        // ── PING ──────────────────────────────────────────────────────────────
        case CLIENT_PING: {
          send(ws, { type: SERVER_PONG });
          break;
        }

        // ── CHALLENGE SEND ────────────────────────────────────────────────────
        case CHALLENGE_SEND: {
          const { challengerId, opponentId, betAmount } = msg;
          const oppWs = connections.get(opponentId);
          if (oppWs) {
            const challenger = playersService.getById(challengerId);
            send(oppWs, { type: CHALLENGE_RECEIVE, challenger, betAmount });
          }
          break;
        }

        // ── CHALLENGE DECLINE ─────────────────────────────────────────────────
        case CHALLENGE_DECLINE: {
          const { challengerId } = msg;
          const chalWs = connections.get(challengerId);
          if (chalWs) send(chalWs, { type: CHALLENGE_DECLINED, opponentId: msg.opponentId });
          break;
        }

        // ── CHALLENGE ACCEPT ──────────────────────────────────────────────────
        case CHALLENGE_ACCEPT: {
          const { challengerId, opponentId, betAmount } = msg;
          const chalWs = connections.get(challengerId);
          const oppWs  = connections.get(opponentId);

          const challenger = playersService.getById(challengerId);
          const opponent   = playersService.getById(opponentId);
          if (!challenger || !opponent) return;

          if (challenger.balance < betAmount || opponent.balance < betAmount) {
            const errMsg = 'Insufficient balance to start this match.';
            if (chalWs) send(chalWs, { type: 'error', message: errMsg });
            if (oppWs)  send(oppWs,  { type: 'error', message: errMsg });
            return;
          }

          // Deduct bets
          playersService.adjustBalance(challengerId, -betAmount);
          playersService.adjustBalance(opponentId,   -betAmount);

          // Create game record
          const game = gamesService.create({
            mode: 'pvp',
            player1Id: challengerId,
            player2Id: opponentId,
            betAmount,
          });

          // Fire-and-forget: notify token owner's backend that bets were placed
          const tokenId = getTokenIdForPlayer(challengerId);
          notifyBetPlaced(tokenId, {
            player1Id: challengerId,
            player2Id: opponentId,
            betAmount,
            gameId: game.id,
          }).catch(() => {});

          // Challenger = BLACK (moves first), Opponent = WHITE
          if (chalWs) {
            send(chalWs, {
              type: GAME_START,
              gameId: game.id,
              opponent,
              myColor: 'black',
              turn: 'black',
              betAmount,
            });
          }
          if (oppWs) {
            send(oppWs, {
              type: GAME_START,
              gameId: game.id,
              opponent: challenger,
              myColor: 'white',
              turn: 'black',
              betAmount,
            });
          }

          broadcast({ type: SERVER_PLAYER_UPDATED, player: playersService.getById(challengerId) });
          broadcast({ type: SERVER_PLAYER_UPDATED, player: playersService.getById(opponentId) });
          break;
        }

        // ── MAKE MOVE ─────────────────────────────────────────────────────────
        case MAKE_MOVE: {
          if (!ws._authenticated) return;
          const { gameId, playerId, from, move } = msg;
          gamesService.addMove(gameId, playerId, { from, move });

          const game = gamesService.getById(gameId);
          if (game) {
            const oppId = game.player1_id === playerId ? game.player2_id : game.player1_id;
            const oppWs = connections.get(oppId);
            if (oppWs) send(oppWs, { type: MOVE_MADE, from, move });
          }
          break;
        }

        // ── GAME OVER ─────────────────────────────────────────────────────────
        case GAME_OVER: {
          if (!ws._authenticated) return;
          const { gameId, winnerId, reason, durationSec, moveCount } = msg;
          const game = gamesService.getById(gameId);
          if (!game || game.status === 'finished') return;

          gamesService.finish(gameId, { winnerId, durationSec, moveCount });

          // Determine if this is an AI game (one of the players is_ai = 1)
          const p1IsAi = db.prepare('SELECT is_ai FROM players WHERE id = ?').get(game.player1_id)?.is_ai === 1;
          const p2IsAi = game.player2_id
            ? db.prepare('SELECT is_ai FROM players WHERE id = ?').get(game.player2_id)?.is_ai === 1
            : false;
          const isAiGame = p1IsAi || p2IsAi;

          let settlement = {};
          if (winnerId) {
            const loserId = game.player1_id === winnerId ? game.player2_id : game.player1_id;
            if (isAiGame) {
              settlement = settleAiWin(winnerId, loserId, game);
            } else {
              settlement = settleWin(winnerId, loserId, game);
            }
          } else {
            // Draw
            if (isAiGame) {
              // Find the human player
              const humanId = p1IsAi ? game.player2_id : game.player1_id;
              settlement = settleAiDraw(humanId, game);
            } else {
              settlement = settleDraw(game);
            }
          }

          broadcast({ type: SERVER_PLAYER_UPDATED, player: playersService.getById(game.player1_id) });
          if (game.player2_id) {
            broadcast({ type: SERVER_PLAYER_UPDATED, player: playersService.getById(game.player2_id) });
          }

          // Include settlement details in GAME_OVER so the frontend can display winnings
          const payload = {
            type: GAME_OVER,
            winnerId,
            reason,
            settlement: {
              winnerPayout:  settlement.winnerPayout  ?? 0,
              fee:           settlement.fee           ?? 0,
              refund:        settlement.refund        ?? 0,
              ownerDelta:    settlement.ownerDelta    ?? 0,
            },
          };
          const s1 = connections.get(game.player1_id);
          const s2 = game.player2_id ? connections.get(game.player2_id) : null;
          if (s1) send(s1, payload);
          if (s2) send(s2, payload);
          break;
        }

        // ── RESIGN ────────────────────────────────────────────────────────────
        case GAME_RESIGN: {
          if (!ws._authenticated) return;
          const { gameId, playerId } = msg;
          const game = gamesService.getById(gameId);
          if (!game || game.status === 'finished') return;

          const winnerId = game.player1_id === playerId ? game.player2_id : game.player1_id;
          gamesService.finish(gameId, { winnerId, durationSec: 0, moveCount: 0 });

          // Route to correct settler based on game type
          const p1IsAiR = db.prepare('SELECT is_ai FROM players WHERE id = ?').get(game.player1_id)?.is_ai === 1;
          const p2IsAiR = game.player2_id
            ? db.prepare('SELECT is_ai FROM players WHERE id = ?').get(game.player2_id)?.is_ai === 1
            : false;
          const isAiGameR = p1IsAiR || p2IsAiR;

          let resignSettlement = {};
          if (isAiGameR) {
            resignSettlement = settleAiWin(winnerId, playerId, game);
          } else {
            resignSettlement = settleWin(winnerId, playerId, game);
          }

          broadcast({ type: SERVER_PLAYER_UPDATED, player: playersService.getById(game.player1_id) });
          if (game.player2_id) {
            broadcast({ type: SERVER_PLAYER_UPDATED, player: playersService.getById(game.player2_id) });
          }

          const resignPayload = {
            type: GAME_OVER,
            winnerId,
            reason: 'Opponent resigned',
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
    });

    // ── Disconnect handler ───────────────────────────────────────────────────
    ws.on('close', () => {
      if (!ws.playerId) return;
      if (connections.get(ws.playerId) !== ws) return; // stale ref (was kicked)

      connections.delete(ws.playerId);
      playersService.markOnline(ws.playerId, false);
      logger.debug(`WS: disconnected — ${ws.playerId}`);
      broadcastPresence();

      // 15-second grace period for active games
      const activeGames = gamesService.getAll({ status: 'active', playerId: ws.playerId });
      if (activeGames.length > 0) {
        const activeGame = activeGames[0];
        const myId  = ws.playerId;
        const oppId = activeGame.player1_id === myId ? activeGame.player2_id : activeGame.player1_id;

        const oppWs = connections.get(oppId);
        if (oppWs) send(oppWs, { type: OPPONENT_LEFT, playerId: myId });

        logger.info(`WS: ${myId} disconnected mid-game — starting 15s reconnect timer`);

        const timer = setTimeout(() => {
          disconnectTimers.delete(myId);
          logger.info(`WS: ${myId} failed to reconnect — auto-resigning`);

          const freshGame = gamesService.getById(activeGame.id);
          if (!freshGame || freshGame.status !== 'active') return;

          const winnerId = oppId;
          gamesService.finish(activeGame.id, {
            winnerId,
            durationSec: 0,
            moveCount: freshGame.moves.length,
          });

          // Route to correct settler
          const dp1IsAi = db.prepare('SELECT is_ai FROM players WHERE id = ?').get(freshGame.player1_id)?.is_ai === 1;
          const dp2IsAi = freshGame.player2_id
            ? db.prepare('SELECT is_ai FROM players WHERE id = ?').get(freshGame.player2_id)?.is_ai === 1
            : false;
          const isAiGameD = dp1IsAi || dp2IsAi;
          const dcSettlement = isAiGameD
            ? settleAiWin(winnerId, myId, freshGame)
            : settleWin(winnerId, myId, freshGame);

          const winWs = connections.get(winnerId);
          if (winWs) send(winWs, {
            type: GAME_OVER,
            winnerId,
            reason: 'Opponent disconnected',
            settlement: {
              winnerPayout: dcSettlement.winnerPayout ?? 0,
              fee:          dcSettlement.fee          ?? 0,
              refund:       dcSettlement.refund       ?? 0,
              ownerDelta:   dcSettlement.ownerDelta   ?? 0,
            },
          });

          broadcast({ type: SERVER_PLAYER_UPDATED, player: playersService.getById(activeGame.player1_id) });
          if (activeGame.player2_id) {
            broadcast({ type: SERVER_PLAYER_UPDATED, player: playersService.getById(activeGame.player2_id) });
          }
        }, 15_000);

        disconnectTimers.set(myId, timer);
      }
    });

    ws.on('error', (err) => {
      logger.error('WS socket error:', err.message);
    });
  });

  // Periodic presence broadcast every 30s
  setInterval(broadcastPresence, 30_000);

  logger.info('WebSocket server attached.');
};
