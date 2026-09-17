import { nanoid } from 'nanoid';
import { query } from '../db/database.js';

const now = () => Math.floor(Date.now() / 1000);

/**
 * Create a new game.
 */
export const create = async (data) => {
  const { mode, player1Id, player2Id = null, betAmount = 0 } = data;
  const id = nanoid();

  await query(`
    INSERT INTO games (id, mode, player1_id, player2_id, bet_amount)
    VALUES ($1, $2, $3, $4, $5)
  `, [id, mode, player1Id, player2Id, betAmount]);

  const { rows } = await query(`SELECT * FROM games WHERE id = $1`, [id]);
  return rows[0];
};

/**
 * Get all games with optional filters.
 */
export const getAll = async (filters = {}) => {
  const { status, playerId, limit = 20, offset = 0 } = filters;
  const conditions = [];
  const params = [];
  let i = 1;

  if (status) {
    conditions.push(`g.status = $${i++}`);
    params.push(status);
  }
  if (playerId) {
    conditions.push(`(g.player1_id = $${i} OR g.player2_id = $${i})`);
    params.push(playerId);
    i++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

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
    LIMIT $${i++} OFFSET $${i++}
  `;
  params.push(Number(limit), Number(offset));

  const { rows } = await query(sql, params);
  return rows;
};

/**
 * Get a single game by ID, including its moves.
 */
export const getById = async (id) => {
  const { rows: gameRows } = await query(`SELECT * FROM games WHERE id = $1`, [id]);
  if (!gameRows.length) return null;

  const { rows: moves } = await query(
    `SELECT * FROM game_moves WHERE game_id = $1 ORDER BY move_num ASC`, [id]
  );
  return { ...gameRows[0], moves };
};

/**
 * Finish a game — set winner, status, duration, move count.
 */
export const finish = async (id, data) => {
  const { winnerId = null, durationSec, moveCount } = data;

  await query(`
    UPDATE games SET
      winner_id    = $1,
      status       = 'finished',
      duration_sec = $2,
      move_count   = $3,
      finished_at  = $4
    WHERE id = $5
  `, [winnerId, durationSec, moveCount, now(), id]);

  return getById(id);
};

/**
 * Append a move to a game.
 */
export const addMove = async (gameId, playerId, moveData) => {
  const { rows: countRows } = await query(
    `SELECT COUNT(*) AS cnt FROM game_moves WHERE game_id = $1`, [gameId]
  );
  const moveNum = (parseInt(countRows[0].cnt, 10) || 0) + 1;

  await query(`
    INSERT INTO game_moves (game_id, player_id, move_data, move_num)
    VALUES ($1, $2, $3, $4)
  `, [gameId, playerId, JSON.stringify(moveData), moveNum]);

  const { rows } = await query(
    `SELECT * FROM game_moves WHERE game_id = $1 ORDER BY move_num DESC LIMIT 1`, [gameId]
  );
  return rows[0];
};
