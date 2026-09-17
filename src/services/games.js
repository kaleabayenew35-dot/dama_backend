import { nanoid } from 'nanoid';
import db from '../db/database.js';

/**
 * Create a new game.
 * @param {{ mode: string, player1Id: string, player2Id?: string, betAmount?: number }} data
 */
export const create = (data) => {
  const { mode, player1Id, player2Id = null, betAmount = 0 } = data;
  const id = nanoid();

  db.prepare(`
    INSERT INTO games (id, mode, player1_id, player2_id, bet_amount)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, mode, player1Id, player2Id, betAmount);

  return db.prepare('SELECT * FROM games WHERE id = ?').get(id);
};

/**
 * Get all games with optional filters.
 * Resolves player names from both the players table and ai_bots table.
 * @param {{ status?: string, playerId?: string, limit?: number, offset?: number }} filters
 */
export const getAll = (filters = {}) => {
  const { status, playerId, limit = 20, offset = 0 } = filters;
  const conditions = [];
  const params = [];

  if (status) {
    conditions.push('g.status = ?');
    params.push(status);
  }
  if (playerId) {
    conditions.push('(g.player1_id = ? OR g.player2_id = ?)');
    params.push(playerId, playerId);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // Resolve names from players first, then fall back to ai_bots
  const sql = `
    SELECT
      g.*,
      COALESCE(p1.name, b1.name, g.player1_id) AS player1_name,
      COALESCE(p2.name, b2.name, g.player2_id) AS player2_name,
      COALESCE(pw.name, bw.name)               AS winner_name
    FROM games g
    LEFT JOIN players p1 ON p1.id = g.player1_id
    LEFT JOIN players p2 ON p2.id = g.player2_id
    LEFT JOIN players pw ON pw.id = g.winner_id
    LEFT JOIN ai_bots b1 ON b1.id = g.player1_id
    LEFT JOIN ai_bots b2 ON b2.id = g.player2_id
    LEFT JOIN ai_bots bw ON bw.id = g.winner_id
    ${where}
    ORDER BY g.created_at DESC
    LIMIT ? OFFSET ?
  `;
  params.push(Number(limit), Number(offset));

  return db.prepare(sql).all(...params);
};

/**
 * Get a single game by ID, including its moves.
 * @param {string} id
 */
export const getById = (id) => {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
  if (!game) return null;

  const moves = db.prepare('SELECT * FROM game_moves WHERE game_id = ? ORDER BY move_num ASC').all(id);
  return { ...game, moves };
};

/**
 * Finish a game — set winner, status, duration, move count.
 * @param {string} id
 * @param {{ winnerId?: string, durationSec: number, moveCount: number }} data
 */
export const finish = (id, data) => {
  const { winnerId = null, durationSec, moveCount } = data;

  db.prepare(`
    UPDATE games SET
      winner_id    = ?,
      status       = 'finished',
      duration_sec = ?,
      move_count   = ?,
      finished_at  = unixepoch()
    WHERE id = ?
  `).run(winnerId, durationSec, moveCount, id);

  return getById(id);
};

/**
 * Append a move to a game.
 * @param {string} gameId
 * @param {string} playerId
 * @param {{ from: object, to: object, captured?: object }} moveData
 */
export const addMove = (gameId, playerId, moveData) => {
  // Determine next move number
  const row = db.prepare('SELECT COUNT(*) as cnt FROM game_moves WHERE game_id = ?').get(gameId);
  const moveNum = (row?.cnt || 0) + 1;

  db.prepare(`
    INSERT INTO game_moves (game_id, player_id, move_data, move_num)
    VALUES (?, ?, ?, ?)
  `).run(gameId, playerId, JSON.stringify(moveData), moveNum);

  return db.prepare('SELECT * FROM game_moves WHERE game_id = ? ORDER BY move_num DESC LIMIT 1').get(gameId);
};
