import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import { CORS_ORIGINS, NODE_ENV, FRONTEND_URL } from './config/env.js';
import apiRouter from './routes/index.js';
import { authTimeout } from './middleware/authTimeout.js';
import { errorHandler } from './middleware/errorHandler.js';

const app = express();

// Temporary request logging for deployment debugging
app.use((req, res, next) => {
  console.log('[INCOMING]', req.method, req.path, JSON.stringify({
    headers: req.headers,
    query: req.query,
  }));
  next();
});

// Trust reverse-proxy headers so req.ip gives the real client IP
app.set('trust proxy', true);

// Security headers
app.use(helmet());

// CORS
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, Telegram Mini App, curl, etc.)
      if (!origin) return callback(null, true);
      if (CORS_ORIGINS.includes(origin)) return callback(null, true);
      // Log blocked origin in dev
      if (NODE_ENV === 'development') {
        console.warn(`CORS blocked: ${origin}`);
      }
      // Return proper CORS rejection (not a throw — that causes 500)
      return callback(null, false);
    },
    credentials: true,
  })
);

// HTTP request logging
app.use(morgan(NODE_ENV === 'development' ? 'dev' : 'combined'));

// JSON body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API routes
app.use(authTimeout);
app.use('/api', apiRouter);

// Root — health/info page
app.get('/', (req, res) => {
  res.json({
    ok: true,
    name: 'Dama Game Backend',
    description: 'Ethiopian Checkers API Server',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health:  '/api/health',
      players: '/api/players',
      games:   '/api/games',
      ai:      '/api/ai',
    },
    frontend: FRONTEND_URL,
  });
});

// 404 for unmatched routes
app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Route not found: ${req.method} ${req.path}` });
});

// Global error handler (must be last)
app.use(errorHandler);

export default app;
