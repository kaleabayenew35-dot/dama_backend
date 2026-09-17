// backend/src/middleware/auth.js
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dama-jwt-secret-change-me';

/**
 * Protects admin routes.
 * Expects:  Authorization: Bearer <jwt>
 * The JWT was issued by POST /api/admin/login and signed with JWT_SECRET.
 */
export const requireAdmin = (req, res, next) => {
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
