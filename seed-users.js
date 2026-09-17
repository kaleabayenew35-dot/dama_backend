// seed-users.js — run once to seed sample users and shared token
// Usage: node seed-users.js
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/dama',
  ssl: (process.env.DATABASE_URL || '').includes('localhost') ? false : { rejectUnauthorized: false },
});

async function seed() {
  // ── 1. Insert shared API token ──────────────────────────────────────────
  await pool.query(`
    INSERT INTO api_tokens (token, key_name, owner, is_active)
    VALUES ($1, $2, $3, 1)
    ON CONFLICT DO NOTHING
  `, [
    'dama_a52ea8f0ac191e6a23a39347a3b2b4e61b0a176b0bc0403f',
    'shared-frontend',
    'Admin',
  ]);
  console.log('✅ Token inserted/exists');

  // ── 2. Insert player: Kaleab ────────────────────────────────────────────
  const nowSec = Math.floor(Date.now() / 1000);
  await pool.query(`
    INSERT INTO players
      (id, name, phone, balance, bet, piece_theme, wins, losses, draws, online, is_ai, is_demo, difficulty, created_at)
    VALUES ($1, $2, $3, $4, 100, 'classic', 0, 0, 0, 0, 0, 0, '', $5)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name, phone = EXCLUDED.phone, balance = EXCLUDED.balance
  `, ['ph_0909095880', 'Kaleab', '0909095880', 2000, nowSec]);
  console.log('✅ Player Kaleab inserted');

  // ── 3. Insert player: Ayenew ────────────────────────────────────────────
  await pool.query(`
    INSERT INTO players
      (id, name, phone, balance, bet, piece_theme, wins, losses, draws, online, is_ai, is_demo, difficulty, created_at)
    VALUES ($1, $2, $3, $4, 100, 'classic', 0, 0, 0, 0, 0, 0, '', $5)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name, phone = EXCLUDED.phone, balance = EXCLUDED.balance
  `, ['ph_0709095880', 'Ayenew', '0709095880', 4000, nowSec]);
  console.log('✅ Player Ayenew inserted');

  // ── Verify ──────────────────────────────────────────────────────────────
  const { rows: [token] } = await pool.query(
    `SELECT id, key_name, owner, token FROM api_tokens WHERE token = $1`,
    ['dama_a52ea8f0ac191e6a23a39347a3b2b4e61b0a176b0bc0403f']
  );
  const { rows: players } = await pool.query(
    `SELECT id, name, phone, balance FROM players WHERE id = ANY($1)`,
    [['ph_0909095880', 'ph_0709095880']]
  );

  console.log('\n── Verification ──────────────────────────');
  console.log('Token:', JSON.stringify(token, null, 2));
  console.log('Players:', JSON.stringify(players, null, 2));

  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
