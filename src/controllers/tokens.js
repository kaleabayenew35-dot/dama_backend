// backend/src/controllers/tokens.js
import crypto from 'crypto';
import db from '../db/database.js';
import { ok, fail } from '../utils/response.js';

/** Generate a secure random token: dama_<32 hex chars> */
function generateToken() {
  return 'dama_' + crypto.randomBytes(24).toString('hex');
}

// GET /api/admin/tokens
export const listTokens = (req, res, next) => {
  try {
    const tokens = db.prepare(`
      SELECT id, token, key_name, owner, backend_url, created_at, expires_at, last_used, is_active
      FROM api_tokens
      ORDER BY created_at DESC
    `).all();
    ok(res, tokens);
  } catch (err) { next(err); }
};

export function upsertTokenRegistration(targetDb = db, payload) {
  const token = String(payload?.token || '').trim();
  const keyName = String(payload?.key_name || '').trim();
  const owner = String(payload?.owner || '').trim();
  const backendUrl = String(payload?.backend_url || '').trim() || null;
  const isActive = payload?.is_active === 0 ? 0 : 1;
  const expiresAt = payload?.expires_at == null ? null : Number(payload.expires_at);

  if (!token) {
    throw new Error('token is required');
  }

  const existing = targetDb.prepare('SELECT id FROM api_tokens WHERE token = ?').get(token);
  if (existing) {
    targetDb.prepare(`
      UPDATE api_tokens
      SET key_name = ?, owner = ?, backend_url = ?, is_active = ?, expires_at = ?
      WHERE token = ?
    `).run(keyName || null, owner || null, backendUrl, isActive, expiresAt, token);

    return targetDb.prepare('SELECT * FROM api_tokens WHERE token = ?').get(token);
  }

  const info = targetDb.prepare(`
    INSERT INTO api_tokens (token, key_name, owner, backend_url, is_active, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(token, keyName || null, owner || null, backendUrl, isActive, expiresAt);

  return targetDb.prepare('SELECT * FROM api_tokens WHERE id = ?').get(info.lastInsertRowid);
}

// POST /api/admin/tokens
export const createToken = (req, res, next) => {
  try {
    const { key_name, owner, expires_in_days, backend_url } = req.body;

    if (!key_name || !owner || !backend_url) {
      return fail(res, 'key_name, owner and backend_url are required', 400);
    }

    const token     = generateToken();
    const expiresAt = expires_in_days
      ? Math.floor(Date.now() / 1000) + Number(expires_in_days) * 86400
      : null;

    const info = db.prepare(`
      INSERT INTO api_tokens (token, key_name, owner, expires_at, backend_url)
      VALUES (?, ?, ?, ?, ?)
    `).run(token, key_name.trim(), owner.trim(), expiresAt, backend_url?.trim() || null);

    const created = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(info.lastInsertRowid);
    ok(res, created, 201);
  } catch (err) { next(err); }
};

export const registerToken = (req, res, next) => {
  try {
    const payload = req.body || {};
    const created = upsertTokenRegistration(db, payload);
    ok(res, created, 201);
  } catch (err) {
    next(err);
  }
};

// PATCH /api/admin/tokens/:id/toggle
export const toggleToken = (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(req.params.id);
    if (!row) return fail(res, 'Token not found', 404);

    db.prepare('UPDATE api_tokens SET is_active = ? WHERE id = ?')
      .run(row.is_active ? 0 : 1, row.id);

    const updated = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(row.id);
    ok(res, updated);
  } catch (err) { next(err); }
};

// DELETE /api/admin/tokens/:id
export const deleteToken = (req, res, next) => {
  try {
    const info = db.prepare('DELETE FROM api_tokens WHERE id = ?').run(req.params.id);
    if (!info.changes) return fail(res, 'Token not found', 404);
    ok(res, { deleted: true });
  } catch (err) { next(err); }
};

// PATCH /api/admin/tokens/:id/backend-url
export const updateBackendUrl = (req, res, next) => {
  try {
    const { backend_url } = req.body;
    const row = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(req.params.id);
    if (!row) return fail(res, 'Token not found', 404);

    db.prepare('UPDATE api_tokens SET backend_url = ? WHERE id = ?')
      .run(backend_url?.trim() || null, row.id);

    const updated = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(row.id);
    ok(res, updated);
  } catch (err) { next(err); }
};

// POST /api/admin/tokens/:id/ping
// Tries to reach the token's backend_url and reports online/offline + latency.
export const pingTokenBackend = async (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(req.params.id);
    if (!row) return fail(res, 'Token not found', 404);

    const backendUrl = row.backend_url;
    if (!backendUrl) {
      return ok(res, { online: false, reason: 'no_backend_url', latencyMs: null });
    }

    const pingUrl = backendUrl.replace(/\/$/, '') + '/dama';
    const t0 = Date.now();
    try {
      const resp = await fetch(pingUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ping', token: row.token }),
        signal: AbortSignal.timeout(5000),
      });
      const latencyMs = Date.now() - t0;
      // Any HTTP response (even 4xx) means the server is reachable
      return ok(res, { online: true, latencyMs, httpStatus: resp.status });
    } catch (fetchErr) {
      const latencyMs = Date.now() - t0;
      return ok(res, { online: false, reason: fetchErr.message, latencyMs });
    }
  } catch (err) { next(err); }
};
