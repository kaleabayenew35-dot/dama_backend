// backend/src/middleware/auth.js
import jwt from 'jsonwebtoken';

const JWT_SECRET   = process.env.JWT_SECRET   || 'dama-jwt-secret-change-me';
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN  || '';

/**
 * Protects admin routes.
 *
 * Accepts either:
 *   1. Authorization: Bearer <dama-admin-jwt>   (from dama admin login)
 *   2. X-Admin-Token: <ADMIN_TOKEN>              (from system-admin panel)
 */
export const requireAdmin = (req, res, next) => {
  // ── Path 1: shared admin token (used by system-admin panel) ──────────────
  const xToken = req.headers['x-admin-token'];
  if (xToken && ADMIN_TOKEN && xToken === ADMIN_TOKEN) {
    req.admin = { id: 0, username: 'system-admin' };
    return next();
  }

  // ── Path 2: dama admin JWT ────────────────────────────────────────────────
  const authHeader = req.headers['authorization'] || '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.admin = payload; // { id, username, iat, exp }
    next();
  } catch {
    return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
  }
};
