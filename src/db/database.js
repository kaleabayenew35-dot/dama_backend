import pg from 'pg';
import { DATABASE_URL } from '../config/env.js';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('connect', () => {
  logger.info('PostgreSQL connected');
});

pool.on('error', (err) => {
  logger.error('PostgreSQL pool error:', err.message);
});

/**
 * Run a single query.
 * @param {string} text  SQL with $1, $2 … placeholders
 * @param {any[]}  [params]
 * @returns {Promise<pg.QueryResult>}
 */
export async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug(`query [${duration}ms]: ${text.slice(0, 80)}`);
    return res;
  } catch (err) {
    logger.error(`query error: ${err.message}\n  SQL: ${text}`);
    throw err;
  }
}

/**
 * Get a dedicated client for transactions.
 * Caller MUST call client.release() when done.
 */
export async function getClient() {
  return pool.connect();
}

/**
 * Run multiple statements inside a single transaction.
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export default pool;
