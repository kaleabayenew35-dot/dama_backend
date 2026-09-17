// backend/src/db/schema.js
import { query } from './database.js';
import crypto from 'crypto';

export async function applySchema() {
  // Players table
  await query(`
    CREATE TABLE IF NOT EXISTS players (
      id           TEXT    PRIMARY KEY,
      name         TEXT    NOT NULL,
      photo        TEXT,
      phone        TEXT,
      balance      INTEGER NOT NULL DEFAULT 500,
      bet          INTEGER NOT NULL DEFAULT 100,
      piece_theme  TEXT    NOT NULL DEFAULT 'classic',
      wins         INTEGER NOT NULL DEFAULT 0,
      losses       INTEGER NOT NULL DEFAULT 0,
      draws        INTEGER NOT NULL DEFAULT 0,
      online       INTEGER NOT NULL DEFAULT 0,
      is_ready     INTEGER NOT NULL DEFAULT 0,
      ready_bet    INTEGER NOT NULL DEFAULT 0,
      last_seen    BIGINT  NOT NULL DEFAULT 0,
      last_ip      TEXT,
      last_device  TEXT,
      is_ai        INTEGER NOT NULL DEFAULT 0,
      is_demo      INTEGER NOT NULL DEFAULT 0,
      difficulty   TEXT    NOT NULL DEFAULT '',
      token_id     INTEGER,
      created_at   BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )
  `);

  // Admins table
  await query(`
    CREATE TABLE IF NOT EXISTS admins (
      id            SERIAL  PRIMARY KEY,
      username      TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      created_at    BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )
  `);

  // API Tokens table (must exist before foreign key references)
  await query(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      id         SERIAL  PRIMARY KEY,
      token      TEXT    NOT NULL UNIQUE,
      key_name   TEXT    NOT NULL,
      owner      TEXT    NOT NULL,
      backend_url TEXT,
      created_at BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      expires_at BIGINT,
      last_used  BIGINT,
      is_active  INTEGER NOT NULL DEFAULT 1
    )
  `);

  // Games table
  await query(`
    CREATE TABLE IF NOT EXISTS games (
      id           TEXT    PRIMARY KEY,
      mode         TEXT    NOT NULL,
      player1_id   TEXT    NOT NULL,
      player2_id   TEXT,
      winner_id    TEXT,
      status       TEXT    NOT NULL DEFAULT 'active',
      move_count   INTEGER NOT NULL DEFAULT 0,
      duration_sec INTEGER NOT NULL DEFAULT 0,
      bet_amount   INTEGER NOT NULL DEFAULT 0,
      created_at   BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      finished_at  BIGINT
    )
  `);

  // Game moves log
  await query(`
    CREATE TABLE IF NOT EXISTS game_moves (
      id        SERIAL  PRIMARY KEY,
      game_id   TEXT    NOT NULL,
      player_id TEXT    NOT NULL,
      move_data TEXT    NOT NULL,
      move_num  INTEGER NOT NULL,
      ts        BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )
  `);

  // Owned items
  await query(`
    CREATE TABLE IF NOT EXISTS owned_items (
      player_id TEXT    NOT NULL,
      item_id   TEXT    NOT NULL,
      bought_at BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      PRIMARY KEY (player_id, item_id)
    )
  `);

  // AI config (single row, id=1 always)
  await query(`
    CREATE TABLE IF NOT EXISTS ai_config (
      id          INTEGER PRIMARY KEY DEFAULT 1,
      difficulty  TEXT    NOT NULL DEFAULT 'medium',
      depth       INTEGER NOT NULL DEFAULT 10,
      think_delay INTEGER NOT NULL DEFAULT 600,
      ai_name     TEXT    NOT NULL DEFAULT 'Computer 🤖',
      allow_undo  INTEGER NOT NULL DEFAULT 1,
      updated_at  BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )
  `);

  await query(`INSERT INTO ai_config (id) VALUES (1) ON CONFLICT DO NOTHING`);

  // AI bots
  await query(`
    CREATE TABLE IF NOT EXISTS ai_bots (
      id         TEXT    PRIMARY KEY,
      name       TEXT    NOT NULL,
      depth      INTEGER NOT NULL DEFAULT 10,
      pct        INTEGER NOT NULL DEFAULT 50,
      wins       INTEGER NOT NULL DEFAULT 0,
      losses     INTEGER NOT NULL DEFAULT 0,
      draws      INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )
  `);

  // Game Bet Log
  await query(`
    CREATE TABLE IF NOT EXISTS game_bet_log (
      id             SERIAL  PRIMARY KEY,
      game_id        TEXT    NOT NULL,
      player_id      TEXT    NOT NULL,
      phone          TEXT,
      bet_amount     INTEGER NOT NULL DEFAULT 0,
      backend_url    TEXT,
      request_body   TEXT,
      response_body  TEXT,
      status         TEXT    NOT NULL DEFAULT 'pending',
      error          TEXT,
      created_at     BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )
  `);

  // Token owner earnings balance (one row per token)
  await query(`
    CREATE TABLE IF NOT EXISTS token_owner_balances (
      id           SERIAL  PRIMARY KEY,
      token_id     INTEGER NOT NULL UNIQUE,
      balance      INTEGER NOT NULL DEFAULT 0,
      total_earned INTEGER NOT NULL DEFAULT 0,
      updated_at   BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )
  `);

  // Token owner earnings transaction log
  await query(`
    CREATE TABLE IF NOT EXISTS token_owner_transactions (
      id              SERIAL  PRIMARY KEY,
      token_id        INTEGER NOT NULL,
      game_id         TEXT,
      type            TEXT    NOT NULL,
      amount          INTEGER NOT NULL,
      running_balance INTEGER,
      note            TEXT,
      created_at      BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )
  `);

  // Pending owner callbacks outbox
  await query(`
    CREATE TABLE IF NOT EXISTS pending_owner_callbacks (
      id           SERIAL  PRIMARY KEY,
      token_id     INTEGER NOT NULL,
      game_id      TEXT,
      action       TEXT    NOT NULL,
      payload_json TEXT    NOT NULL,
      attempts     INTEGER NOT NULL DEFAULT 0,
      last_error   TEXT,
      status       TEXT    NOT NULL DEFAULT 'pending',
      created_at   BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      updated_at   BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )
  `);

  // Seed default admin from env (INSERT OR IGNORE — never overwrites)
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const hash = crypto.createHash('sha256').update(password).digest('hex');
  await query(
    `INSERT INTO admins (username, password_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [username, hash]
  );
}
