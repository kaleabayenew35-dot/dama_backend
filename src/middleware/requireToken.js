// backend/src/middleware/requireToken.js
import jwt from 'jsonwebtoken';
import db from '../db/database.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dama-jwt-secret-change-me';

/**
 * Extract a raw token string from the request.
 * Priority: Authorization Bearer → X-API-Token header → ?token= query param
 */
function extractRawToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    const t = auth.slice(7).trim();
    if (t) return t;
  }
  if (req.headers['x-api-token']) return req.headers['x-api-token'];
  if (req.query?.token) return req.query.token;
  if (req.query?.apiToken) return req.query.apiToken;
  return null;
}

/**
 * Validate a raw string against the api_tokens table.
 * Returns the db row on success, null otherwise.
 * Stamps last_used on success.
 */
function lookupApiToken(raw) {
  if (!raw) return null;

  const normalized = String(raw).trim();
  const row = db.prepare(`
    SELECT id, token, key_name, owner, is_active, expires_at
    FROM api_tokens WHERE token = ?
  `).get(normalized);

  if (!row) {
    const fallback = db.prepare(`
      SELECT id, token, key_name, owner, is_active, expires_at
      FROM api_tokens WHERE token = ?
    `).get(`dama_${normalized.replace(/^dama_/, '')}`);
    if (fallback) return fallback;
  }

  if (!row) return null;
  if (!row.is_active) return null;
  if (row.expires_at && row.expires_at < Math.floor(Date.now() / 1000)) return null;

  db.prepare('UPDATE api_tokens SET last_used = unixepoch() WHERE id = ?').run(row.id);
  return row;
}

function maskToken(token) {
  if (typeof token !== 'string') return '';
  const trimmed = token.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) return '*'.repeat(trimmed.length);
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

function logTokenMismatch(raw, req) {
  const receivedToken = typeof raw === 'string' ? raw.trim() : '';
  console.warn(`[auth] token rejected`, {
    path: req.path,
    method: req.method,
    receivedToken: maskToken(receivedToken),
    headerToken: maskToken(req.headers['x-api-token'] || ''),
    queryToken: maskToken(req.query?.token || ''),
    queryApiToken: maskToken(req.query?.apiToken || ''),
    authorizationHeader: req.headers.authorization ? 'present' : null,
  });
}

/**
 * Count active, non-expired tokens in the DB.
 * When zero tokens exist the app is in "first-run / dev" mode and open access is allowed.
 */
function activeTokenCount() {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(`
    SELECT COUNT(*) AS cnt FROM api_tokens
    WHERE is_active = 1 AND (expires_at IS NULL OR expires_at > ?)
  `).get(now).cnt;
}

// ── Exported middleware ──────────────────────────────────────────────────────

/**
 * requireToken
 * Requires a valid API token. Never falls through to open access.
 */
export const requireToken = (req, res, next) => {
  const raw = extractRawToken(req);
  if (!raw) return res.status(401).json({ ok: false, error: 'API token required' });

  const row = lookupApiToken(raw);
  if (!row) {
    logTokenMismatch(raw, req);
    const exists = db.prepare('SELECT is_active, expires_at FROM api_tokens WHERE token = ?').get(raw);
    if (!exists)         return res.status(401).json({ ok: false, error: 'Invalid API token' });
    if (!exists.is_active) return res.status(401).json({ ok: false, error: 'API token has been revoked' });
    return res.status(401).json({ ok: false, error: 'API token has expired' });
  }

  req.apiToken = { id: row.id, key_name: row.key_name, owner: row.owner };
  next();
};

/**
 * requireTokenOrAdmin
 * Accepts: valid admin JWT  OR  valid API token.
 *
 * Special case: if NO active tokens exist in the DB (first-run / dev),
 * the request is allowed through so the app is usable before tokens are created.
 */
export const requireTokenOrAdmin = (req, res, next) => {
  const raw = extractRawToken(req);

  // ── 1. Try admin JWT ───────────────────────────────────────────────────────
  if (raw) {
    try {
      const payload = jwt.verify(raw, JWT_SECRET);
      req.admin = payload;
      return next();
    } catch {
      // Not a valid JWT — fall through
    }

    // ── 2. Try API token ─────────────────────────────────────────────────────
    const row = lookupApiToken(raw);
    if (row) {
      req.apiToken = { id: row.id, key_name: row.key_name, owner: row.owner };
      return next();
    }
  }

  // ── 3. First-run / dev: allow if no active tokens exist ───────────────────
  if (activeTokenCount() === 0) {
    return next();
  }

  // ── 4. Reject ─────────────────────────────────────────────────────────────
  if (!raw) return res.status(401).json({ ok: false, error: 'API token or admin session required' });

  // Give a specific reason
  logTokenMismatch(raw, req);
  const exists = db.prepare('SELECT is_active, expires_at FROM api_tokens WHERE token = ?').get(raw);
  if (!exists)           return res.status(401).json({ ok: false, error: 'Invalid credentials' });
  if (!exists.is_active) return res.status(401).json({ ok: false, error: 'API token has been revoked' });
  return res.status(401).json({ ok: false, error: 'API token has expired' });
};
