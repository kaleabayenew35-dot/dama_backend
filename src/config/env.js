import 'dotenv/config';

const required = (key) => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
};

export const PORT = parseInt(process.env.PORT || '10000', 10);
export const NODE_ENV = process.env.NODE_ENV || 'development';
export const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/dama';
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'default-admin-token';
export const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dama-kyw6.onrender.com';
export const SYSTEM_BACKEND_URL = process.env.SYSTEM_BACKEND_URL || 'https://system-backend-1u5m.onrender.com';

// Always include these production origins plus anything set via env var
const ALWAYS_ALLOWED = [
  'https://dama-kyw6.onrender.com',
  'https://dama-backend.onrender.com',
  'https://system-admin-iou9.onrender.com',
  'https://system-backend-1u5m.onrender.com',
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
