import 'dotenv/config';

const required = (key) => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
};

export const PORT = parseInt(process.env.PORT || '5000', 10);
export const NODE_ENV = process.env.NODE_ENV || 'development';
export const DB_PATH = process.env.DB_PATH || './data/dama.db';
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'default-admin-token';
export const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dama-game-6d2b.onrender.com';

// Always include these production origins plus anything set via env var
const ALWAYS_ALLOWED = [
  'https://dama-game-6d2b.onrender.com',
  'https://dama-game-backend.onrender.com',
  'https://dama-admin.onrender.com',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:4173',
];

const envOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const CORS_ORIGINS = [...new Set([...ALWAYS_ALLOWED, ...envOrigins])];

export const isDev = NODE_ENV === 'development';
