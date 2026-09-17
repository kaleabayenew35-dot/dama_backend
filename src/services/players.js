import db from '../db/database.js';

/**
 * Get all players with optional filters.
 * For AI players, depth and pct are joined from the ai_bots table.
 * @param {{ online?: boolean, search?: string, limit?: number, offset?: number }} filters
 */
export const getAll = (filters = {}) => {
  const { online, search, limit = 50, offset = 0 } = filters;
  const conditions = [];
  const params = [];

  if (online === true || online === 'true') {
    conditions.push('p.online = 1');
  }
  if (search) {
    conditions.push('p.name LIKE ?');
    params.push(`%${search}%`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `
    SELECT
      p.*,
      COALESCE(b.depth, 10)  AS ai_depth,
      COALESCE(b.pct,   50)  AS ai_pct
    FROM players p
    LEFT JOIN ai_bots b ON b.id = p.id AND p.is_ai = 1
    ${where}
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?
  `;
  params.push(Number(limit), Number(offset));

  return db.prepare(sql).all(...params);
};

/**
 * Get a single player by ID.
 * @param {string} id
 */
export const getById = (id) => {
  return db.prepare('SELECT * FROM players WHERE id = ?').get(id);
};

/**
 * Upsert a player (INSERT OR REPLACE).
 * @param {{ id: string, name: string, photo?: string, bet?: number, pieceThemeId?: string, isDemo?: boolean, isAi?: boolean, difficulty?: string, lastIp?: string, lastDevice?: string }} data
 */
export const upsert = (data) => {
  const { id, name, photo = null, phone = null, bet = 100, pieceThemeId = 'classic', isDemo = false, isAi = false, difficulty = '', lastIp = null, lastDevice = null, tokenId = null } = data;

  const existing = db.prepare('SELECT * FROM players WHERE id = ?').get(id);

  if (existing) {
    db.prepare(`
      UPDATE players SET
        name        = ?,
        photo       = COALESCE(?, photo),
        phone       = COALESCE(?, phone),
        bet         = ?,
        piece_theme = ?,
        is_demo     = ?,
        is_ai       = ?,
        difficulty  = COALESCE(?, difficulty),
        last_ip     = COALESCE(?, last_ip),
        last_device = COALESCE(?, last_device),
        token_id    = CASE WHEN ? IS NOT NULL THEN ? ELSE token_id END
      WHERE id = ?
    `).run(name, photo, phone, bet, pieceThemeId, isDemo ? 1 : 0, isAi ? 1 : 0, difficulty || null, lastIp, lastDevice, tokenId, tokenId, id);
  } else {
    db.prepare(`
      INSERT INTO players (id, name, photo, phone, bet, piece_theme, is_demo, is_ai, difficulty, last_ip, last_device, token_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, photo, phone, bet, pieceThemeId, isDemo ? 1 : 0, isAi ? 1 : 0, difficulty || '', lastIp, lastDevice, tokenId);
  }

  return db.prepare('SELECT * FROM players WHERE id = ?').get(id);
};

/**
 * Partial update of player fields (admin).
 * @param {string} id
 * @param {object} fields
 */
export const update = (id, fields) => {
  const allowed = ['name', 'wins', 'losses', 'draws', 'balance', 'bet', 'piece_theme', 'online', 'last_ip', 'last_device'];
  const columnMap = { pieceThemeId: 'piece_theme', lastIp: 'last_ip', lastDevice: 'last_device' };

  const setClauses = [];
  const params = [];

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;  // skip fields not provided
    const col = columnMap[key] || key;
    if (allowed.includes(col)) {
      setClauses.push(`${col} = ?`);
      params.push(value);
    }
  }

  if (setClauses.length === 0) return getById(id);

  params.push(id);
  db.prepare(`UPDATE players SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
  return db.prepare('SELECT * FROM players WHERE id = ?').get(id);
};

/**
 * Atomic balance adjustment. Floors at 0.
 * @param {string} id
 * @param {number} amount  positive = add, negative = deduct
 */
export const adjustBalance = (id, amount) => {
  db.prepare(`
    UPDATE players
    SET balance = MAX(0, balance + ?)
    WHERE id = ?
  `).run(amount, id);
  return db.prepare('SELECT * FROM players WHERE id = ?').get(id);
};

/**
 * Increment wins, losses, or draws counter.
 * @param {string} id
 * @param {'win'|'loss'|'draw'} result
 */
export const recordResult = (id, result) => {
  const col = result === 'win' ? 'wins' : result === 'loss' ? 'losses' : 'draws';
  db.prepare(`UPDATE players SET ${col} = ${col} + 1 WHERE id = ?`).run(id);
  return db.prepare('SELECT * FROM players WHERE id = ?').get(id);
};

/**
 * Delete a player by ID.
 * @param {string} id
 */
export const deletePlayer = (id) => {
  const info = db.prepare('DELETE FROM players WHERE id = ?').run(id);
  return info.changes > 0;
};

/**
 * Set player online status and update last_seen.
 * @param {string} id
 * @param {boolean} online
 */
export const markOnline = (id, online) => {
  db.prepare(`
    UPDATE players SET online = ?, last_seen = unixepoch() WHERE id = ?
  `).run(online ? 1 : 0, id);
};

/**
 * Set player ready state with their chosen bet.
 * @param {string} id
 * @param {number} betAmount
 */
export const setReady = (id, betAmount) => {
  db.prepare(`
    UPDATE players SET is_ready = 1, ready_bet = ?, bet = ?, last_seen = unixepoch()
    WHERE id = ?
  `).run(betAmount, betAmount, id);
  return db.prepare('SELECT * FROM players WHERE id = ?').get(id);
};

/**
 * Clear player ready state.
 * @param {string} id
 */
export const clearReady = (id) => {
  db.prepare(`UPDATE players SET is_ready = 0, ready_bet = 0 WHERE id = ?`).run(id);
  return db.prepare('SELECT * FROM players WHERE id = ?').get(id);
};

/**
 * Get all online ready players, optionally filtered by bet amount.
 * Excludes AI and demo players.
 * @param {{ bet?: number, excludeId?: string }} filters
 */
export const getReadyPlayers = (filters = {}) => {
  const { bet, excludeId } = filters;
  const conditions = ['is_ready = 1', 'online = 1', 'is_ai = 0', 'is_demo = 0'];
  const params = [];

  if (bet) {
    conditions.push('ready_bet = ?');
    params.push(Number(bet));
  }
  if (excludeId) {
    conditions.push('id != ?');
    params.push(excludeId);
  }

  const sql = `
    SELECT * FROM players
    WHERE ${conditions.join(' AND ')}
    ORDER BY last_seen DESC
  `;
  return db.prepare(sql).all(...params);
};
