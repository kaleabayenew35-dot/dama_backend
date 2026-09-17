import 'dotenv/config';
import http from 'http';
import app from './app.js';
import { runMigrations } from './db/migrations.js';
import { attachWsServer } from './ws/wsServer.js';
import { PORT } from './config/env.js';
import { logger } from './utils/logger.js';
import { seedAiBots } from './utils/seedAiBots.js';
import { startRetryWorker, stopRetryWorker } from './services/retryWorker.js';

// Run DB migrations (idempotent)
runMigrations();

// Seed AI bots if fewer than 15 exist
seedAiBots();

// Start durable-callback retry worker
startRetryWorker();

// Create HTTP server from Express app
const server = http.createServer(app);

// Attach WebSocket server to the same HTTP server
attachWsServer(server);

// Start listening — bind to 0.0.0.0 so Render can detect the open port
server.listen(PORT, '0.0.0.0', () => {
  logger.info(`Dama backend running on http://0.0.0.0:${PORT}`);
  logger.info(`WebSocket available at  ws://0.0.0.0:${PORT}`);
});

// Graceful shutdown
const shutdown = (signal) => {
  logger.info(`${signal} received — shutting down gracefully`);
  stopRetryWorker();
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
