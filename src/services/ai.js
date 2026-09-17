import { query } from '../db/database.js';

const now = () => Math.floor(Date.now() / 1000);

function depthToPct(depth) {
  return Math.round((depth / 20) * 100);
}

function depthToDifficulty(depth) {
  if (depth <= 6)  return 'easy';
  if (depth <= 13) return 'medium';
  return 'hard';
}

export const getConfig = async () => {
  const { rows } = await query(`SELECT * FROM ai_config WHERE id = 1`);
  return rows[0] || null;
};

export const updateConfig = async (fields) => {
  const columnMap = {
    difficulty: 'difficulty',
    depth:      'depth',
    thinkDelay: 'think_delay',
    aiName:     'ai_name',
    allowUndo:  'allow_undo',
    aiEnabled:  'ai_enabled',
  };

  const setClauses = [`updated_at = $1`];
  const params = [now()];
  let i = 2;

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const col = columnMap[key];
    if (col) {
      setClauses.push(`${col} = $${i++}`);
      params.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    }
  }

  params.push(1);
  await query(`UPDATE ai_config SET ${setClauses.join(', ')} WHERE id = $${i}`, params);
  return getConfig();
};

export const getBots = async () => {
  const { rows } = await query(`
    SELECT id, name, depth, pct, wins, losses, draws, created_at
    FROM ai_bots
    ORDER BY depth ASC, name ASC
  `);
  return rows;
};

export const updateBot = async (id, fields) => {
  const { name, depth } = fields;

  if (name === undefined && depth === undefined) {
    const { rows } = await query(`SELECT * FROM ai_bots WHERE id = $1`, [id]);
    return rows[0] || null;
  }

  const sets   = [];
  const params = [];
  let i = 1;

  if (name !== undefined) {
    sets.push(`name = $${i++}`);
    params.push(name);
  }

  if (depth !== undefined) {
    const pct        = depthToPct(depth);
    const difficulty = depthToDifficulty(depth);
    sets.push(`depth = $${i++}`, `pct = $${i++}`);
    params.push(depth, pct);
    await query(`UPDATE players SET difficulty = $1 WHERE id = $2 AND is_ai = 1`, [difficulty, id]);
  }

  params.push(id);
  await query(`UPDATE ai_bots SET ${sets.join(', ')} WHERE id = $${i}`, params);

  const { rows } = await query(`SELECT * FROM ai_bots WHERE id = $1`, [id]);
  return rows[0] || null;
};
