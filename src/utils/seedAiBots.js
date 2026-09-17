import db from '../db/database.js';
import { logger } from './logger.js';
import { nanoid } from 'nanoid';

// depth → pct helper
function depthToPct(depth) {
  return Math.round((depth / 20) * 100);
}

// Spread 15 bots evenly across the 1–20 depth range
const BOT_DEPTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 18];

export const seedAiBots = () => {
  // ── Ensure ai_bots has 15 rows ──────────────────────────────────────────
  const existing = db.prepare('SELECT COUNT(*) as cnt FROM ai_bots').get();
  const count    = existing?.cnt || 0;
  const needed   = 15 - count;
  if (needed <= 0) return;

  logger.info(`Seeding ${needed} AI bots into ai_bots table`);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO ai_bots (id, name, depth, pct, wins, losses, draws)
    VALUES (?, ?, ?, ?, 0, 0, 0)
  `);

  const seed = db.transaction(() => {
    for (let i = 0; i < needed; i++) {
      const botNum   = count + i + 1;
      const botId    = `ai_${nanoid(6)}`;
      const botName  = `AI-Bot-${botNum}`;
      const depth    = BOT_DEPTHS[count + i] ?? 10;
      const pct      = depthToPct(depth);
      insert.run(botId, botName, depth, pct);
    }
  });
  seed();

  // ── Keep players table in sync so game logic still works ────────────────
  const bots = db.prepare('SELECT id, name, depth FROM ai_bots').all();
  const upsertPlayer = db.prepare(`
    INSERT OR IGNORE INTO players (id, name, is_ai, difficulty, piece_theme, balance, bet, is_demo)
    VALUES (?, ?, 1, 'medium', 'classic', 500, 0, 0)
  `);
  const syncPlayers = db.transaction(() => {
    for (const bot of bots) {
      upsertPlayer.run(bot.id, bot.name);
    }
  });
  syncPlayers();
};
