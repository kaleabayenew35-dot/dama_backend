import jwt from 'jsonwebtoken';
const secret = process.env.JWT_SECRET || 'dama-jwt-secret-change-me';

// A JWT has exactly 3 dot-separated base64url segments.
// Dama API tokens start with "dama_" and are never JWTs.
// We only run expiry checking on strings that structurally look like JWTs so
// we don't reject API-token-bearing requests with a spurious 401.
const looksLikeJwt = (str) =>
  typeof str === 'string' && str.split('.').length === 3 && !str.startsWith('dama_');

/**
 * Middleware that rejects *expired or invalid admin JWTs* early.
 *
 * Rules:
 *  - No Authorization header → pass through (public routes / API-token routes)
 *  - Header present but value doesn't look like a JWT (e.g. a dama_ API token
 *    sent as Bearer) → pass through; route-level auth handles it
 *  - Looks like a JWT and is valid → attach req.user, pass through
 *  - Looks like a JWT and is expired/invalid → 401
 */
export const authTimeout = (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const raw = authHeader.split(' ')[1] || req.cookies?.token;

  // Nothing in the header — not an admin session request, let it through
  if (!raw) return next();

  // Not a JWT shape (e.g. a dama_ API token) — skip JWT verification entirely;
  // requireTokenOrAdmin / requireAdmin on the route will handle it correctly
  if (!looksLikeJwt(raw)) return next();

  try {
    const payload = jwt.verify(raw, secret);
    req.user = payload;
    next();
  } catch {
    // Token is JWT-shaped but invalid or expired — block it here
    res.status(401).json({ ok: false, error: 'Session expired' });
  }
};
