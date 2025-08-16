import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CRITICAL: Force load .env and override any shell environment variables
dotenv.config({
  path: path.resolve(__dirname, '../../.env'),
  override: true, // This ensures .env file takes precedence over shell env vars
});

// Validate required environment variables
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const ORIGIN_ALLOWLIST = process.env.ORIGIN_ALLOWLIST;

// Check DATABASE_URL
if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL not found in .env file');
  process.exit(1);
}

if (DATABASE_URL.includes('user:password')) {
  console.error(
    'FATAL: DATABASE_URL contains placeholder values. Please set correct credentials in .env file',
  );
  console.error('Expected format: postgresql://username:password@host:port/database');
  process.exit(1);
}

// Check REDIS_URL
if (!REDIS_URL) {
  console.error('FATAL: REDIS_URL not found in .env file');
  process.exit(1);
}

// Check ORIGIN_ALLOWLIST
if (!ORIGIN_ALLOWLIST) {
  console.error('FATAL: ORIGIN_ALLOWLIST not found in .env file');
  console.error('Expected format: comma-separated list of absolute origins');
  console.error('Example: http://localhost:5173,http://localhost:3000');
  process.exit(1);
}

// eslint-disable-next-line no-console
console.log('Environment loaded from:', path.resolve(__dirname, '../../.env'));
// eslint-disable-next-line no-console
console.log('Required environment variables validated:');
// eslint-disable-next-line no-console
console.log('  DATABASE_URL:', DATABASE_URL.replace(/:[^:@]+@/, ':****@'));
// eslint-disable-next-line no-console
console.log('  REDIS_URL:', REDIS_URL.replace(/:[^:@]+@/, ':****@'));
// eslint-disable-next-line no-console
console.log('  ORIGIN_ALLOWLIST:', ORIGIN_ALLOWLIST);

import './sentry.js';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pinoHttp = require('pino-http');
import { sentryHandlers } from './sentry.js';
import { isAllowedOrigin } from './util/origin.js';
import { registerWsGateway } from './ws.js';
import roomsRouter from './routes/rooms.js';
import { prisma } from './clients/prisma.js';
import { redis } from './clients/redis.js';
import { startTTLJanitor, stopTTLJanitor } from './ttl-janitor.js';

const app = express();
app.set('trust proxy', 1);
app.use(sentryHandlers.request); // FIRST
app.use(pinoHttp({ redact: { paths: ['req.headers', 'req.body', 'res.headers'], remove: true } }));
app.use(express.json({ limit: '1mb' }));

const allowlistCsv = process.env.ORIGIN_ALLOWLIST || '';
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, false); // disallow non-browser by default
      const allowed = isAllowedOrigin(origin, allowlistCsv);
      if (!allowed) {
        // Log origin rejection for observability
        import('./obs.js').then(({ crumb }) => {
          crumb('origin_reject_http', 'security', 'warning');
        });
      }
      cb(null, allowed);
    },
    credentials: false,
  }),
);

// Security headers with CSP Profile A
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        workerSrc: ["'self'"],
        connectSrc: ["'self'", 'https:', 'wss:'],
        frameAncestors: ["'none'"],
      },
    },
    hsts:
      process.env.NODE_ENV === 'production'
        ? {
            maxAge: 31536000, // 1 year
            includeSubDomains: true,
            preload: true,
          }
        : false,
    noSniff: true,
    referrerPolicy: { policy: 'no-referrer' },
  }),
);

// Serve static files from server/public (client build output)
const publicPath = path.resolve(__dirname, '../public');
app.use(express.static(publicPath));

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/readyz', async (_req, res) => {
  try {
    await redis.ping();
    await prisma.$queryRaw`SELECT 1`;
    return res.json({ ok: true, degraded: { db: false } });
  } catch {
    // Check which service is down
    let redisOk = true,
      dbOk = true;
    try {
      await redis.ping();
    } catch {
      redisOk = false;
    }
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      dbOk = false;
    }

    if (!redisOk) {
      return res.status(503).json({ ok: false, degraded: { redis: true, db: !dbOk } });
    }
    return res.json({ ok: true, degraded: { db: true } });
  }
});

app.use('/api/rooms', roomsRouter);

// Catch-all route for SPA - serve index.html for all non-API routes
app.get('*', (_req, res) => {
  res.sendFile('index.html', { root: publicPath });
});

app.use(sentryHandlers.error); // LAST

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  // Server started successfully
  // eslint-disable-next-line no-console
  console.log(`Server listening on port ${port}`);

  // Start TTL janitor for expired room cleanup
  startTTLJanitor();
});

try {
  registerWsGateway(server, allowlistCsv);
} catch (err) {
  import('./sentry.js').then(({ sentry }) => sentry.captureException(err));

  console.error('Failed to register WebSocket gateway:', err);
}

// Graceful shutdown: flush, then close
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
async function shutdown() {
  // eslint-disable-next-line no-console
  console.log('Shutting down gracefully...');

  // Stop TTL janitor
  stopTTLJanitor();

  try {
    await prisma.$disconnect();
  } catch {
    /* ignore disconnect errors */
  }
  try {
    await redis.quit();
  } catch {
    /* ignore quit errors */
  }
  server.close(() => process.exit(0));
}
