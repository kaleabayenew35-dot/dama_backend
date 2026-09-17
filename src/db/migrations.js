import { query } from './database.js';
import { applySchema } from './schema.js';
import { logger } from '../utils/logger.js';
import crypto from 'crypto';

export async function ensureDefaultApiToken() {
  const { rows } = await query(`SELECT id FROM api_tokens WHERE token = $1`, ['dama_shared_frontend']);
  if (rows.length > 0) return null;

  const token = 'dama_' + crypto.randomBytes(24).toString('hex');
  await query(
    `INSERT INTO api_tokens (token, key_name, owner, is_active) VALUES ($1, $2, $3, 1)`,
    [token, 'shared-frontend', 'Admin']
  );
  return token;
}

export const runMigrations = async () => {
  logger.info('Running database migrations...');
  await applySchema();

  // Ensure running_balance column exists on token_owner_transactions
  await query(`
    ALTER TABLE token_owner_transactions ADD COLUMN IF NOT EXISTS running_balance INTEGER
  `);

  // Seed a default API token on fresh deployments
  const seededToken = await ensureDefaultApiToken();
  if (seededToken) {
    logger.info(`Seeded default API token: ${seededToken}`);
  }

  // Backfill token_id for real players whose phone is set but token_id is null
  try {
    const { rows: tokenRows } = await query(
      `SELECT id FROM api_tokens WHERE is_active = 1 ORDER BY id ASC LIMIT 1`
    );
    if (tokenRows.length > 0) {
      const firstTokenId = tokenRows[0].id;
      const { rowCount } = await query(
        `UPDATE players SET token_id = $1
         WHERE token_id IS NULL AND phone IS NOT NULL AND is_ai = 0 AND is_demo = 0`,
        [firstTokenId]
      );
      if (rowCount > 0) {
        logger.info(`Backfilled token_id=${firstTokenId} for ${rowCount} player(s).`);
      }
    }
  } catch (err) {
    logger.warn('token_id backfill skipped:', err.message);
  }

  logger.info('Migrations complete.');
};
