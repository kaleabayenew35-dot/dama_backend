// seed-users.js — run once to seed sample users and shared token
import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(resolve(__dirname, 'data/dama.db'));

// ── 1. Insert shared API token ────────────────────────────────────────────
db.prepare(`
  INSERT OR IGNORE INTO api_tokens (token, key_name, owner, is_active)
  VALUES (?, ?, ?, 1)
`).run(
  'dama_a52ea8f0ac191e6a23a39347a3b2b4e61b0a176b0bc0403f',
  'shared-frontend',
  'Admin'
);
console.log('✅ Token inserted/exists');

// ── 2. Insert player: Kaleab ──────────────────────────────────────────────
db.prepare(`
  INSERT OR REPLACE INTO players
    (id, name, phone, balance, bet, piece_theme, wins, losses, draws, online, is_ai, is_demo, difficulty, created_at)
  VALUES (?, ?, ?, ?, 100, 'classic', 0, 0, 0, 0, 0, 0, '', unixepoch())
`).run('ph_0909095880', 'Kaleab', '0909095880', 2000);
console.log('✅ Player Kaleab inserted');

// ── 3. Insert player: Ayenew ──────────────────────────────────────────────
db.prepare(`
  INSERT OR REPLACE INTO players
    (id, name, phone, balance, bet, piece_theme, wins, losses, draws, online, is_ai, is_demo, difficulty, created_at)
  VALUES (?, ?, ?, ?, 100, 'classic', 0, 0, 0, 0, 0, 0, '', unixepoch())
`).run('ph_0709095880', 'Ayenew', '0709095880', 4000);
console.log('✅ Player Ayenew inserted');

// ── Verify ────────────────────────────────────────────────────────────────
const token = db.prepare(`SELECT id, key_name, owner, token FROM api_tokens WHERE token = ?`)
  .get('dama_a52ea8f0ac191e6a23a39347a3b2b4e61b0a176b0bc0403f');
const players = db.prepare(`SELECT id, name, phone, balance FROM players WHERE id IN ('ph_0909095880','ph_0709095880')`)
  .all();

console.log('\n── Verification ──────────────────────────');
console.log('Token:', JSON.stringify(token, null, 2));
console.log('Players:', JSON.stringify(players, null, 2));

db.close();
