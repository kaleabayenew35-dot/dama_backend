// backend/src/controllers/tokens.js
import crypto from 'crypto';
import { query } from '../db/database.js';
import { ok, fail } from '../utils/response.js';

const now = () => Math.floor(Date.now() / 1000);

function generateToken() {
  return 'dama_' + crypto.randomBytes(24).toString('hex');
}

export const listTokens = async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT id, token, key_name, owner, backend_url, created_at, expires_at, last_used, is_active
      FROM api_tokens
      ORDER BY created_at DESC
    `);
    ok(res, rows);
  } catch (err) { next(err); }
};

export async function upsertTokenRegistration(pool, payload) {
  const token      = String(payload?.token || '').trim();
  const keyName    = String(payload?.key_name || '').trim();
  const owner      = String(payload?.owner || '').trim();
  const backendUrl = String(payload?.backend_url || '').trim() || null;
  const isActive   = payload?.is_active === 0 ? 0 : 1;
  const expiresAt  = payload?.expires_at == null ? null : Number(payload.expires_at);

  if (!token) throw new Error('token is required');

  const { rows: existing } = await query(`SELECT id FROM api_tokens WHERE token = $1`, [token]);

  if (existing.length > 0) {
    await query(`
      UPDATE api_tokens
      SET key_name = $1, owner = $2, backend_url = $3, is_active = $4, expires_at = $5
      WHERE token = $6
    `, [keyName || null, owner || null, backendUrl, isActive, expiresAt, token]);

    const { rows } = await query(`SELECT * FROM api_tokens WHERE token = $1`, [token]);
    return rows[0];
  }

  const { rows } = await query(`
    INSERT INTO api_tokens (token, key_name, owner, backend_url, is_active, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [token, keyName || null, owner || null, backendUrl, isActive, expiresAt]);
  return rows[0];
}

export const createToken = async (req, res, next) => {
  try {
    const { key_name, owner, expires_in_days, backend_url } = req.body;

    if (!key_name || !owner || !backend_url) {
      return fail(res, 'key_name, owner and backend_url are required', 400);
    }

    const token     = generateToken();
    const expiresAt = expires_in_days
      ? Math.floor(Date.now() / 1000) + Number(expires_in_days) * 86400
      : null;

    const { rows } = await query(`
      INSERT INTO api_tokens (token, key_name, owner, expires_at, backend_url)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [token, key_name.trim(), owner.trim(), expiresAt, backend_url?.trim() || null]);

    ok(res, rows[0], 201);
  } catch (err) { next(err); }
};

export const registerToken = async (req, res, next) => {
  try {
    const created = await upsertTokenRegistration(null, req.body || {});
    ok(res, created, 201);
  } catch (err) {
    next(err);
  }
};

export const toggleToken = async (req, res, next) => {
  try {
    const { rows: existing } = await query(`SELECT * FROM api_tokens WHERE id = $1`, [req.params.id]);
    if (!existing.length) return fail(res, 'Token not found', 404);

    const row = existing[0];
    await query(`UPDATE api_tokens SET is_active = $1 WHERE id = $2`, [row.is_active ? 0 : 1, row.id]);

    const { rows } = await query(`SELECT * FROM api_tokens WHERE id = $1`, [row.id]);
    ok(res, rows[0]);
  } catch (err) { next(err); }
};

export const deleteToken = async (req, res, next) => {
  try {
    const { rowCount } = await query(`DELETE FROM api_tokens WHERE id = $1`, [req.params.id]);
    if (!rowCount) return fail(res, 'Token not found', 404);
    ok(res, { deleted: true });
  } catch (err) { next(err); }
};

export const updateBackendUrl = async (req, res, next) => {
  try {
    const { backend_url } = req.body;
    const { rows: existing } = await query(`SELECT id FROM api_tokens WHERE id = $1`, [req.params.id]);
    if (!existing.length) return fail(res, 'Token not found', 404);

    await query(`UPDATE api_tokens SET backend_url = $1 WHERE id = $2`,
      [backend_url?.trim() || null, req.params.id]);

    const { rows } = await query(`SELECT * FROM api_tokens WHERE id = $1`, [req.params.id]);
    ok(res, rows[0]);
  } catch (err) { next(err); }
};

export const pingTokenBackend = async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT * FROM api_tokens WHERE id = $1`, [req.params.id]);
    if (!rows.length) return fail(res, 'Token not found', 404);

    const row = rows[0];
    if (!row.backend_url) {
      return ok(res, { online: false, reason: 'no_backend_url', latencyMs: null });
    }

    const pingUrl = row.backend_url.replace(/\/$/, '') + '/dama';
    const t0 = Date.now();
    try {
      const resp = await fetch(pingUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ping', token: row.token }),
        signal: AbortSignal.timeout(5000),
      });
      return ok(res, { online: true, latencyMs: Date.now() - t0, httpStatus: resp.status });
    } catch (fetchErr) {
      return ok(res, { online: false, reason: fetchErr.message, latencyMs: Date.now() - t0 });
    }
  } catch (err) { next(err); }
};
