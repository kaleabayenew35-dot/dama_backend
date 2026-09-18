import { query } from '../db/database.js';

const now = () => Math.floor(Date.now() / 1000);

/**
 * Get all players with optional filters.
 */
export const getAll = async (filters = {}) => {
  const { online, search, limit = 50, offset = 0 } = filters;
  const conditions = [];
  const params = [];
  let i = 1;

  if (online === true || online === 'true') {
    conditions.push('p.online = 1');
  }
  if (search) {
    conditions.push(`p.name ILIKE $${i++}`);
    params.push(`%${search}%`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `
    SELECT
      p.*,
      COALESCE(b.depth, 10) AS ai_depth,
      COALESCE(b.pct,   50) AS ai_pct
    FROM players p
    LEFT JOIN ai_bots b ON b.id = p.id AND p.is_ai = 1
    ${where}
    ORDER BY p.created_at DESC
    LIMIT $${i++} OFFSET $${i++}
  `;
  params.push(Number(limit), Number(offset));

  const { rows } = await query(sql, params);
  return rows;
};

/**
 * Get a single player by phone number.
 */
export const getByPhone = async (phone) => {
  if (!phone) return null;
  const { rows } = await query(`SELECT * FROM players WHERE phone = $1 LIMIT 1`, [phone]);
  return rows[0] || null;
};
  const { rows } = await query(`SELECT * FROM players WHERE id = $1`, [id]);
  return rows[0] || null;
};

/**
 * Upsert a player.
 */
export const upsert = async (data) => {
  const {
    id, name, photo = null, phone = null, bet = 100,
    pieceThemeId = 'classic', isDemo = false, isAi = false,
    difficulty = '', lastIp = null, lastDevice = null, tokenId = null,
  } = data;

  const { rows: existing } = await query(`SELECT id FROM players WHERE id = $1`, [id]);

  if (existing.length > 0) {
    await query(`
      UPDATE players SET
        name        = $1,
        photo       = COALESCE($2, photo),
        phone       = COALESCE($3, phone),
        bet         = $4,
        piece_theme = $5,
        is_demo     = $6,
        is_ai       = $7,
        difficulty  = COALESCE(NULLIF($8, ''), difficulty),
        last_ip     = COALESCE($9, last_ip),
        last_device = COALESCE($10, last_device),
        token_id    = CASE WHEN $11::INTEGER IS NOT NULL THEN $11 ELSE token_id END
      WHERE id = $12
    `, [name, photo, phone, bet, pieceThemeId, isDemo ? 1 : 0, isAi ? 1 : 0,
        difficulty || '', lastIp, lastDevice, tokenId, id]);
  } else {
    await query(`
      INSERT INTO players (id, name, photo, phone, bet, piece_theme, is_demo, is_ai, difficulty, last_ip, last_device, token_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `, [id, name, photo, phone, bet, pieceThemeId, isDemo ? 1 : 0, isAi ? 1 : 0,
        difficulty || '', lastIp, lastDevice, tokenId]);
  }

  const { rows } = await query(`SELECT * FROM players WHERE id = $1`, [id]);
  return rows[0];
};

/**
 * Partial update of player fields (admin).
 */
export const update = async (id, fields) => {
  const allowed = ['name', 'wins', 'losses', 'draws', 'balance', 'bet', 'piece_theme', 'online', 'last_ip', 'last_device'];
  const columnMap = { pieceThemeId: 'piece_theme', lastIp: 'last_ip', lastDevice: 'last_device' };

  const setClauses = [];
  const params = [];
  let i = 1;

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const col = columnMap[key] || key;
    if (allowed.includes(col)) {
      setClauses.push(`${col} = $${i++}`);
      params.push(value);
    }
  }

  if (setClauses.length === 0) return getById(id);

  params.push(id);
  await query(`UPDATE players SET ${setClauses.join(', ')} WHERE id = $${i}`, params);
  return getById(id);
};

/**
 * Atomic balance adjustment. Floors at 0.
 */
export const adjustBalance = async (id, amount) => {
  await query(`
    UPDATE players SET balance = GREATEST(0, balance + $1) WHERE id = $2
  `, [amount, id]);
  return getById(id);
};

/**
 * Increment wins, losses, or draws counter.
 */
export const recordResult = async (id, result) => {
  const col = result === 'win' ? 'wins' : result === 'loss' ? 'losses' : 'draws';
  await query(`UPDATE players SET ${col} = ${col} + 1 WHERE id = $1`, [id]);
  return getById(id);
};

/**
 * Delete a player by ID.
 */
export const deletePlayer = async (id) => {
  const { rowCount } = await query(`DELETE FROM players WHERE id = $1`, [id]);
  return rowCount > 0;
};

/**
 * Set player online status and update last_seen.
 */
export const markOnline = async (id, online) => {
  await query(`
    UPDATE players SET online = $1, last_seen = $2 WHERE id = $3
  `, [online ? 1 : 0, now(), id]);
};

/**
 * Set player ready state with their chosen bet.
 */
export const setReady = async (id, betAmount) => {
  await query(`
    UPDATE players SET is_ready = 1, ready_bet = $1, bet = $1, last_seen = $2 WHERE id = $3
  `, [betAmount, now(), id]);
  return getById(id);
};

/**
 * Clear player ready state.
 */
export const clearReady = async (id) => {
  await query(`UPDATE players SET is_ready = 0, ready_bet = 0 WHERE id = $1`, [id]);
  return getById(id);
};

/**
 * Get all online ready players, optionally filtered by bet amount.
 */
export const getReadyPlayers = async (filters = {}) => {
  const { bet, excludeId } = filters;
  const conditions = ['is_ready = 1', 'online = 1', 'is_ai = 0', 'is_demo = 0'];
  const params = [];
  let i = 1;

  if (bet) {
    conditions.push(`ready_bet = $${i++}`);
    params.push(Number(bet));
  }
  if (excludeId) {
    conditions.push(`id != $${i++}`);
    params.push(excludeId);
  }

  const sql = `SELECT * FROM players WHERE ${conditions.join(' AND ')} ORDER BY last_seen DESC`;
  const { rows } = await query(sql, params);
  return rows;
};
