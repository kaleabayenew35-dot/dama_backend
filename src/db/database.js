import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DB_PATH } from '../config/env.js';
import { logger } from '../utils/logger.js';

// Ensure the data directory exists
const dbDir = path.dirname(path.resolve(DB_PATH));
fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(path.resolve(DB_PATH));

// Performance and integrity pragmas
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Checkpoint on startup — flushes WAL into main .db so it's always readable by external viewers
db.pragma('wal_checkpoint(TRUNCATE)');

logger.info(`SQLite connected: ${path.resolve(DB_PATH)}`);

export default db;
