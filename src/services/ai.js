import db from '../db/database.js';

// ── helpers ──────────────────────────────────────────────────────────────
function depthToPct(depth) {
  return Math.round((depth / 20) * 100);
}

function depthToDifficulty(depth) {
  if (depth <= 6)  return 'easy';
  if (depth <= 13) return 'medium';
  return 'hard';
}

// ── Global AI config ─────────────────────────────────────────────────────

/**
 * Get the single AI config row (id = 1).
 */
export const getConfig = () => {
  return db.prepare('SELECT * FROM ai_config WHERE id = 1').get();
};

/**
 * Partial update of AI config fields.
 */
export const updateConfig = (fields) => {
  const columnMap = {
    difficulty: 'difficulty',
    depth:      'depth',
    thinkDelay: 'think_delay',
    aiName:     'ai_name',
    allowUndo:  'allow_undo',
  };

  const setClauses = ['updated_at = unixepoch()'];
  const params = [];

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const col = columnMap[key];
    if (col) {
      setClauses.push(`${col} = ?`);
      params.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    }
  }

  params.push(1);
  db.prepare(`UPDATE ai_config SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
  return getConfig();
};

// ── AI bots — own table ───────────────────────────────────────────────────

/**
 * Get all AI bots from the dedicated ai_bots table.
 */
export const getBots = () => {
  return db.prepare(`
    SELECT id, name, depth, pct, wins, losses, draws, created_at
    FROM ai_bots
    ORDER BY depth ASC, name ASC
  `).all();
};

/**
 * Update a single AI bot's name and/or depth in ai_bots.
 * Also keeps the players table difficulty column in sync.
 */
export const updateBot = (id, fields) => {
  const { name, depth } = fields;

  if (name === undefined && depth === undefined) {
    return db.prepare('SELECT * FROM ai_bots WHERE id = ?').get(id);
  }

  const sets   = [];
  const params = [];

  if (name !== undefined) {
    sets.push('name = ?');
    params.push(name);
  }

  if (depth !== undefined) {
    const pct        = depthToPct(depth);
    const difficulty = depthToDifficulty(depth);
    sets.push('depth = ?', 'pct = ?');
    params.push(depth, pct);

    // keep players.difficulty in sync so game engine still works
    db.prepare("UPDATE players SET difficulty = ? WHERE id = ? AND is_ai = 1")
      .run(difficulty, id);
  }

  params.push(id);
  db.prepare(`UPDATE ai_bots SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  return db.prepare('SELECT * FROM ai_bots WHERE id = ?').get(id);
};
