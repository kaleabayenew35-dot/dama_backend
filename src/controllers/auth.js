// backend/src/controllers/auth.js
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { query } from '../db/database.js';

const JWT_SECRET  = process.env.JWT_SECRET  || 'dama-jwt-secret-change-me';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';

export const login = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Username and password are required' });
  }

  const hash = crypto.createHash('sha256').update(password).digest('hex');

  const { rows } = await query(
    `SELECT id, username FROM admins WHERE username = $1 AND password_hash = $2`,
    [username, hash]
  );

  if (!rows.length) {
    return res.status(401).json({ ok: false, error: 'Invalid username or password' });
  }

  const admin = rows[0];
  const token = jwt.sign(
    { id: admin.id, username: admin.username },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );

  return res.json({ ok: true, token, username: admin.username });
};

export const changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ ok: false, error: 'Both currentPassword and newPassword are required' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ ok: false, error: 'New password must be at least 6 characters' });
  }

  const currentHash = crypto.createHash('sha256').update(currentPassword).digest('hex');

  const { rows } = await query(
    `SELECT id FROM admins WHERE id = $1 AND password_hash = $2`,
    [req.admin.id, currentHash]
  );

  if (!rows.length) {
    return res.status(401).json({ ok: false, error: 'Current password is incorrect' });
  }

  const newHash = crypto.createHash('sha256').update(newPassword).digest('hex');
  await query(`UPDATE admins SET password_hash = $1 WHERE id = $2`, [newHash, rows[0].id]);

  return res.json({ ok: true, message: 'Password updated successfully' });
};
