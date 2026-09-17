// backend/src/middleware/requireToken.js
import jwt from 'jsonwebtoken';
import { query } from '../db/database.js';
import { verifyLaunchToken } from '../utils/launchToken.js';
import { SYSTEM_BACKEND_URL } from '../config/env.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dama-jwt-secret-change-me';

function extractRawToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    const t = auth.slice(7).trim();
    if (t) return t;
  }
  if (req.headers['x-api-token']) return req.headers['x-api-token'];
  if (req.query?.token)    return req.query.token;
  if (req.query?.apiToken) return req.query.apiToken;
  return null;
}

async function lookupApiToken(raw) {
  if (!raw) return null;

  const normalized = String(raw).trim();
  const nowSec = Math.floor(Date.now() / 1000);

  let { rows } = await query(`
    SELECT id, token, key_name, owner, is_active, expires_at
    FROM api_tokens WHERE token = $1
  `, [normalized]);

  if (!rows.length) {
    // try with dama_ prefix
    const prefixed = `dama_${normalized.replace(/^dama_/, '')}`;
    const fallback = await query(`
      SELECT id, token, key_name, owner, is_active, expires_at
      FROM api_tokens WHERE token = $1
    `, [prefixed]);
    rows = fallback.rows;
  }

  if (!rows.length)            return null;
  const row = rows[0];
  if (!row.is_active)          return null;
  if (row.expires_at && row.expires_at < nowSec) return null;

  await query(`UPDATE api_tokens SET last_used = $1 WHERE id = $2`, [nowSec, row.id]);
  return row;
}

function maskToken(token) {
  if (typeof token !== 'string') return '';
  const t = token.trim();
  if (!t) return '';
  if (t.length <= 8) return '*'.repeat(t.length);
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

function logTokenMismatch(raw, req) {
  console.warn(`[auth] token rejected`, {
    path: req.path, method: req.method,
    receivedToken:       maskToken(raw || ''),
    headerToken:         maskToken(req.headers['x-api-token'] || ''),
    queryToken:          maskToken(req.query?.token || ''),
    queryApiToken:       maskToken(req.query?.apiToken || ''),
    authorizationHeader: req.headers.authorization ? 'present' : null,
  });
}

async function activeTokenCount() {
  const nowSec = Math.floor(Date.now() / 1000);
  const { rows } = await query(`
    SELECT COUNT(*) AS cnt FROM api_tokens
    WHERE is_active = 1 AND (expires_at IS NULL OR expires_at > $1)
  `, [nowSec]);
  return parseInt(rows[0].cnt, 10);
}

// ── Exported middleware ──────────────────────────────────────────────────────

export const requireToken = async (req, res, next) => {
  try {
    const raw = extractRawToken(req);
    if (!raw) return res.status(401).json({ ok: false, error: 'API token required' });

    const row = await lookupApiToken(raw);
    if (!row) {
      logTokenMismatch(raw, req);
      const { rows: exists } = await query(
        `SELECT is_active, expires_at FROM api_tokens WHERE token = $1`, [raw]
      );
      if (!exists.length)       return res.status(401).json({ ok: false, error: 'Invalid API token' });
      if (!exists[0].is_active) return res.status(401).json({ ok: false, error: 'API token has been revoked' });
      return res.status(401).json({ ok: false, error: 'API token has expired' });
    }

    req.apiToken = { id: row.id, key_name: row.key_name, owner: row.owner };
    next();
  } catch (err) {
    next(err);
  }
};

export const requireTokenOrAdmin = async (req, res, next) => {
  try {
    const raw = extractRawToken(req);

    // 1. Try admin JWT
    if (raw) {
      try {
        const payload = jwt.verify(raw, JWT_SECRET);
        req.admin = payload;
        return next();
      } catch { /* not a valid JWT */ }

      // 2. Try API token
      const row = await lookupApiToken(raw);
      if (row) {
        req.apiToken = { id: row.id, key_name: row.key_name, owner: row.owner };
        return next();
      }

      // 3. Try launch token auto-registration
      const launchToken = req.headers['x-launch-token'];
      if (launchToken && String(raw).startsWith('GT-')) {
        try {
          const claims = await verifyLaunchToken(launchToken, SYSTEM_BACKEND_URL);
          if (claims?.username) {
            await query(`
              INSERT INTO api_tokens (token, key_name, owner, backend_url, is_active)
              VALUES ($1, $2, $3, $4, 1)
              ON CONFLICT DO NOTHING
            `, [raw, `system-game-${claims.gameId || 'launch'}`, 'System Backend', SYSTEM_BACKEND_URL]);
            const registered = await lookupApiToken(raw);
            if (registered) {
              req.apiToken = { id: registered.id, key_name: registered.key_name, owner: registered.owner };
              return next();
            }
          }
        } catch { /* fall through */ }
      }
    }

    // 4. First-run / dev: allow if no active tokens exist
    if ((await activeTokenCount()) === 0) {
      return next();
    }

    // 5. Reject
    if (!raw) return res.status(401).json({ ok: false, error: 'API token or admin session required' });

    logTokenMismatch(raw, req);
    const { rows: exists } = await query(
      `SELECT is_active, expires_at FROM api_tokens WHERE token = $1`, [raw]
    );
    if (!exists.length)       return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    if (!exists[0].is_active) return res.status(401).json({ ok: false, error: 'API token has been revoked' });
    return res.status(401).json({ ok: false, error: 'API token has expired' });
  } catch (err) {
    next(err);
  }
};
