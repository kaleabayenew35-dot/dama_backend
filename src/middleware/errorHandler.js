import { isDev } from '../config/env.js';
import { logger } from '../utils/logger.js';

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  logger.error(`${req.method} ${req.path} → ${status}: ${message}`);
  if (isDev && err.stack) logger.debug(err.stack);

  const body = { ok: false, error: message };
  if (isDev && err.stack) body.stack = err.stack;

  res.status(status).json(body);
};
