import { query } from '../db/database.js';
import { logger } from './logger.js';
import { nanoid } from 'nanoid';

function depthToPct(depth) {
  return Math.round((depth / 20) * 100);
}

const BOT_DEPTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 18];

export const seedAiBots = async () => {
  const { rows: existing } = await query(`SELECT COUNT(*) AS cnt FROM ai_bots`);
  const count  = parseInt(existing[0]?.cnt || '0', 10);
  const needed = 15 - count;
  if (needed <= 0) return;

  logger.info(`Seeding ${needed} AI bots into ai_bots table`);

  for (let i = 0; i < needed; i++) {
    const botNum  = count + i + 1;
    const botId   = `ai_${nanoid(6)}`;
    const botName = `AI-Bot-${botNum}`;
    const depth   = BOT_DEPTHS[count + i] ?? 10;
    const pct     = depthToPct(depth);

    await query(`
      INSERT INTO ai_bots (id, name, depth, pct, wins, losses, draws)
      VALUES ($1, $2, $3, $4, 0, 0, 0)
      ON CONFLICT DO NOTHING
    `, [botId, botName, depth, pct]);
  }

  // Keep players table in sync
  const { rows: bots } = await query(`SELECT id, name FROM ai_bots`);
  for (const bot of bots) {
    await query(`
      INSERT INTO players (id, name, is_ai, difficulty, piece_theme, balance, bet, is_demo)
      VALUES ($1, $2, 1, 'medium', 'classic', 500, 0, 0)
      ON CONFLICT DO NOTHING
    `, [bot.id, bot.name]);
  }
};
