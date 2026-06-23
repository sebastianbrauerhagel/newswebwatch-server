// Entry point: starts the Express read API and the background poller in one process.
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { api } from './routes/api.js';
import { startPoller, stopPoller } from './poller.js';
import { startIssuerCache } from './issuersCache.js';
import { log } from './log.js';

const app = express();
app.disable('x-powered-by');

// CORS for the Vercel-hosted dashboard. ALLOWED_ORIGINS=* allows any origin (dev);
// in production set it to your Vercel origin(s).
const allowAll = config.allowedOrigins.includes('*');
app.use(
  cors({
    origin: allowAll ? true : config.allowedOrigins,
    methods: ['GET'],
  }),
);

app.use('/api', api);

const server = app.listen(config.port, config.host, () => {
  log.info(`HTTP API listening on http://${config.host}:${config.port}`);
  log.info(`CORS origins: ${allowAll ? '* (any)' : config.allowedOrigins.join(', ')}`);
  startIssuerCache();
  startPoller();
});

// Crash-safety: log instead of dying silently. PM2 restarts on actual exit.
process.on('unhandledRejection', (reason) => log.error('Unhandled promise rejection:', reason));
process.on('uncaughtException', (err) => log.error('Uncaught exception:', err));

function shutdown(signal) {
  log.info(`${signal} received — shutting down.`);
  stopPoller();
  server.close(() => process.exit(0));
  // Force exit if connections linger.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
