// backend/src/controllers/auth.js
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import db from '../db/database.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dama-jwt-secret-change-me';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';

/**
 * POST /api/admin/login
 * Body: { username, password }
 *
 * Looks up the admin in the `admins` table, compares the SHA-256 hashed
 * password, and returns a signed JWT on success.
 */
export const login = (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Username and password are required' });
  }

  const hash = crypto.createHash('sha256').update(password).digest('hex');

  const admin = db
    .prepare('SELECT id, username FROM admins WHERE username = ? AND password_hash = ?')
    .get(username, hash);

  if (!admin) {
    return res.status(401).json({ ok: false, error: 'Invalid username or password' });
  }

  const token = jwt.sign(
    { id: admin.id, username: admin.username },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );

  return res.json({ ok: true, token, username: admin.username });
};

/**
 * POST /api/admin/change-password
 * Body: { currentPassword, newPassword }
 * Requires: valid JWT (requireAdmin middleware)
 *
 * Updates the password hash in the database for the authenticated admin.
 */
export const changePassword = (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ ok: false, error: 'Both currentPassword and newPassword are required' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ ok: false, error: 'New password must be at least 6 characters' });
  }

  const currentHash = crypto.createHash('sha256').update(currentPassword).digest('hex');

  const admin = db
    .prepare('SELECT id FROM admins WHERE id = ? AND password_hash = ?')
    .get(req.admin.id, currentHash);

  if (!admin) {
    return res.status(401).json({ ok: false, error: 'Current password is incorrect' });
  }

  const newHash = crypto.createHash('sha256').update(newPassword).digest('hex');
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(newHash, admin.id);

  return res.json({ ok: true, message: 'Password updated successfully' });
};
