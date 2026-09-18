import 'dotenv/config';
import http from 'http';
import app from './app.js';
import { runMigrations } from './db/migrations.js';
import { attachWsServer } from './ws/wsServer.js';
import { PORT } from './config/env.js';
import { logger } from './utils/logger.js';
import { seedAiBots } from './utils/seedAiBots.js';
import { startRetryWorker, stopRetryWorker } from './services/retryWorker.js';

// ── Keep-alive self-pinger (prevents Render free-tier sleep) ──────────────────
// Pings /api/health every 10 minutes so the service never goes idle.
// Only active in production where cold starts are a problem.
let _keepAliveTimer = null;

function startKeepAlive(baseUrl) {
  if (!baseUrl) return;
  const pingUrl = `${baseUrl.replace(/\/$/, '')}/api/health`;
  const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

  const ping = () => {
    fetch(pingUrl, { signal: AbortSignal.timeout(8000) })
      .then(r => logger.info(`[keep-alive] pinged ${pingUrl} → ${r.status}`))
      .catch(e => logger.warn(`[keep-alive] ping failed: ${e.message}`));
  };

  // Delay first ping by 2 min to let the server fully warm up
  setTimeout(() => {
    ping();
    _keepAliveTimer = setInterval(ping, INTERVAL_MS);
  }, 2 * 60 * 1000);

  logger.info(`[keep-alive] self-pinger scheduled every ${INTERVAL_MS / 60000}min → ${pingUrl}`);
}

function stopKeepAlive() {
  if (_keepAliveTimer) { clearInterval(_keepAliveTimer); _keepAliveTimer = null; }
}

async function main() {
  // Run DB migrations (idempotent)
  await runMigrations();

  // Seed AI bots if fewer than 15 exist
  await seedAiBots();

  // Start durable-callback retry worker
  startRetryWorker();

  // Create HTTP server from Express app
  const server = http.createServer(app);

  // Attach WebSocket server to the same HTTP server
  attachWsServer(server);

  // Start listening
  server.listen(PORT, '0.0.0.0', () => {
    logger.info(`Dama backend running on http://0.0.0.0:${PORT}`);
    logger.info(`WebSocket available at  ws://0.0.0.0:${PORT}`);

    // Start keep-alive self-pinger in production
    if (process.env.NODE_ENV === 'production') {
      const selfUrl = process.env.RENDER_EXTERNAL_URL
        || process.env.SELF_URL
        || 'https://dama-backend.onrender.com';
      startKeepAlive(selfUrl);
    }
  });

  // Graceful shutdown
  const shutdown = (signal) => {
    logger.info(`${signal} received — shutting down gracefully`);
    stopRetryWorker();
    stopKeepAlive();
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
