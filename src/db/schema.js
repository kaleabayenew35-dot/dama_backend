// backend/src/db/schema.js
import db from './database.js';
import crypto from 'crypto';

export function applySchema() {
  db.exec(`
    -- Players table
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
      last_seen    INTEGER NOT NULL DEFAULT 0,
      last_ip      TEXT,
      last_device  TEXT,
      is_ai        INTEGER NOT NULL DEFAULT 0,
      is_demo      INTEGER NOT NULL DEFAULT 0,
      difficulty   TEXT    NOT NULL DEFAULT '',
      token_id     INTEGER,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (token_id) REFERENCES api_tokens(id)
    );

    -- Admins table
    CREATE TABLE IF NOT EXISTS admins (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Games table
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
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      finished_at  INTEGER,
      FOREIGN KEY (player1_id) REFERENCES players(id),
      FOREIGN KEY (player2_id) REFERENCES players(id)
    );

    -- Game moves log
    CREATE TABLE IF NOT EXISTS game_moves (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id   TEXT    NOT NULL,
      player_id TEXT    NOT NULL,
      move_data TEXT    NOT NULL,
      move_num  INTEGER NOT NULL,
      ts        INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (game_id) REFERENCES games(id)
    );

    -- Owned items
    CREATE TABLE IF NOT EXISTS owned_items (
      player_id TEXT    NOT NULL,
      item_id   TEXT    NOT NULL,
      bought_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (player_id, item_id),
      FOREIGN KEY (player_id) REFERENCES players(id)
    );

    -- API Tokens table
    CREATE TABLE IF NOT EXISTS api_tokens (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      token      TEXT    NOT NULL UNIQUE,
      key_name   TEXT    NOT NULL,
      owner      TEXT    NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at INTEGER,
      last_used  INTEGER,
      is_active  INTEGER NOT NULL DEFAULT 1
    );

    -- AI config (single row, id=1 always)
    CREATE TABLE IF NOT EXISTS ai_config (
      id          INTEGER PRIMARY KEY DEFAULT 1,
      difficulty  TEXT    NOT NULL DEFAULT 'medium',
      depth       INTEGER NOT NULL DEFAULT 10,
      think_delay INTEGER NOT NULL DEFAULT 600,
      ai_name     TEXT    NOT NULL DEFAULT 'Computer 🤖',
      allow_undo  INTEGER NOT NULL DEFAULT 1,
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    INSERT OR IGNORE INTO ai_config (id) VALUES (1);

    -- AI bots — dedicated table, owns depth & pct independent of players
    CREATE TABLE IF NOT EXISTS ai_bots (
      id         TEXT    PRIMARY KEY,
      name       TEXT    NOT NULL,
      depth      INTEGER NOT NULL DEFAULT 10,
      pct        INTEGER NOT NULL DEFAULT 50,
      wins       INTEGER NOT NULL DEFAULT 0,
      losses     INTEGER NOT NULL DEFAULT 0,
      draws      INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Game Bet Log — records each bet deduction callback to the token backend
    CREATE TABLE IF NOT EXISTS game_bet_log (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id        TEXT    NOT NULL,
      player_id      TEXT    NOT NULL,
      phone          TEXT,
      bet_amount     INTEGER NOT NULL DEFAULT 0,
      backend_url    TEXT,
      request_body   TEXT,
      response_body  TEXT,
      status         TEXT    NOT NULL DEFAULT 'pending',
      error          TEXT,
      created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (game_id) REFERENCES games(id)
    );

    -- Token owner earnings balance (one row per token)
    CREATE TABLE IF NOT EXISTS token_owner_balances (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id     INTEGER NOT NULL UNIQUE,
      balance      INTEGER NOT NULL DEFAULT 0,
      total_earned INTEGER NOT NULL DEFAULT 0,
      updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (token_id) REFERENCES api_tokens(id)
    );

    -- Token owner earnings transaction log
    CREATE TABLE IF NOT EXISTS token_owner_transactions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id   INTEGER NOT NULL,
      game_id    TEXT,
      type       TEXT NOT NULL,
      amount     INTEGER NOT NULL,
      note       TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (token_id) REFERENCES api_tokens(id)
    );

    -- Durable outbox for owner-backend financial callbacks.
    -- Rows are written BEFORE every HTTP call to the partner /dama endpoint.
    -- The retry worker reads rows with status='pending' and attempts < max.
    CREATE TABLE IF NOT EXISTS pending_owner_callbacks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id     INTEGER NOT NULL,
      game_id      TEXT,
      action       TEXT    NOT NULL,
      payload_json TEXT    NOT NULL,
      attempts     INTEGER NOT NULL DEFAULT 0,
      last_error   TEXT,
      status       TEXT    NOT NULL DEFAULT 'pending',
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (token_id) REFERENCES api_tokens(id)
    );
  `);

  // ── Column migrations — idempotent, errors mean column already exists ───────
  const columnMigrations = [
    'ALTER TABLE players ADD COLUMN name TEXT',
    'ALTER TABLE players ADD COLUMN photo TEXT',
    'ALTER TABLE players ADD COLUMN bet INTEGER NOT NULL DEFAULT 100',
    'ALTER TABLE players ADD COLUMN wins INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE players ADD COLUMN losses INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE players ADD COLUMN draws INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE players ADD COLUMN online INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE players ADD COLUMN is_ready INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE players ADD COLUMN ready_bet INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE players ADD COLUMN token_id INTEGER',
    'ALTER TABLE players ADD COLUMN is_ai INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE players ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE players ADD COLUMN difficulty TEXT NOT NULL DEFAULT \'\'',
    'ALTER TABLE players ADD COLUMN last_ip TEXT',
    'ALTER TABLE players ADD COLUMN last_device TEXT',
    'ALTER TABLE players ADD COLUMN phone TEXT',
    'ALTER TABLE ai_config ADD COLUMN depth INTEGER NOT NULL DEFAULT 10',
    // Token owner backend URL
    'ALTER TABLE api_tokens ADD COLUMN backend_url TEXT',
  ];
  for (const sql of columnMigrations) {
    try { db.prepare(sql).run(); } catch { /* already exists */ }
  }

  // ── Migrate existing AI players → ai_bots (runs once, idempotent) ──────────
  try {
    const botsExist = db.prepare('SELECT COUNT(*) as cnt FROM ai_bots').get();
    if (botsExist.cnt === 0) {
      const aiPlayers = db.prepare(
        "SELECT id, name, difficulty, wins, losses, draws FROM players WHERE is_ai = 1"
      ).all();
      if (aiPlayers.length > 0) {
        const insert = db.prepare(`
          INSERT OR IGNORE INTO ai_bots (id, name, depth, pct, wins, losses, draws)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const diffToDepth = (d) => d === 'easy' ? 4 : d === 'hard' ? 18 : 10;
        const migrate = db.transaction(() => {
          for (const p of aiPlayers) {
            const depth = diffToDepth(p.difficulty);
            const pct   = Math.round((depth / 20) * 100);
            insert.run(p.id, p.name, depth, pct, p.wins || 0, p.losses || 0, p.draws || 0);
          }
        });
        migrate();
      }
    }
  } catch { /* table may not have existed yet on first run — seeder handles it */ }

  // ── Seed default admin from env (INSERT OR IGNORE — never overwrites) ────────
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const hash = crypto.createHash('sha256').update(password).digest('hex');
  try {
    db.prepare('INSERT OR IGNORE INTO admins (username, password_hash) VALUES (?, ?)')
      .run(username, hash);
  } catch { /* ignore */ }
}
