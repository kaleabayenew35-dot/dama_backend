import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { ensureDefaultApiToken } from '../src/db/migrations.js';
import { upsertTokenRegistration } from '../src/controllers/tokens.js';

describe('ensureDefaultApiToken', () => {
  it('inserts a default API token when the table is empty', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE api_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT UNIQUE,
        key_name TEXT,
        owner TEXT,
        is_active INTEGER DEFAULT 1,
        backend_url TEXT,
        expires_at INTEGER,
        created_at INTEGER,
        updated_at INTEGER,
        last_used INTEGER
      )
    `);

    ensureDefaultApiToken(db);

    const row = db.prepare('SELECT token, key_name, owner, is_active FROM api_tokens LIMIT 1').get();
    expect(row).toMatchObject({
      key_name: 'shared-frontend',
      owner: 'Admin',
      is_active: 1,
    });
    expect(row.token).toContain('dama_');

    db.close();
  });
});

describe('upsertTokenRegistration', () => {
  it('inserts a new token and updates it without duplicating rows', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE api_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT UNIQUE,
        key_name TEXT,
        owner TEXT,
        is_active INTEGER DEFAULT 1,
        backend_url TEXT,
        expires_at INTEGER,
        created_at INTEGER,
        updated_at INTEGER,
        last_used INTEGER
      )
    `);

    const first = upsertTokenRegistration(db, {
      token: 'dama_demo_token',
      key_name: 'system-backend-demo',
      owner: 'system-backend',
      backend_url: 'https://system-backend.example',
      is_active: 1,
    });

    const second = upsertTokenRegistration(db, {
      token: 'dama_demo_token',
      key_name: 'system-backend-demo',
      owner: 'system-backend',
      backend_url: 'https://system-backend-updated.example',
      is_active: 1,
    });

    const rows = db.prepare('SELECT id, token, backend_url FROM api_tokens').all();
    expect(first.token).toBe('dama_demo_token');
    expect(second.backend_url).toBe('https://system-backend-updated.example');
    expect(rows).toHaveLength(1);

    db.close();
  });
});
