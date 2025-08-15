import 'dotenv/config';
import './sentry';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { sentryHandlers } from './sentry';
import { isAllowedOrigin } from './util/origin';
import { registerWsGateway } from './ws';
import roomsRouter from './routes/rooms';
import { prisma } from './clients/prisma';
import { redis } from './clients/redis';

const app = express();
app.set('trust proxy', 1);
app.use(sentryHandlers.request); // FIRST
app.use(pinoHttp({ redact: { paths: ['req.headers','req.body','res.headers'], remove: true } }));
app.use(express.json({ limit: '1mb' }));

const allowlistCsv = process.env.ORIGIN_ALLOWLIST || '';
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, false); // disallow non-browser by default
    cb(null, isAllowedOrigin(origin, allowlistCsv));
  },
  credentials: false,
}));
app.use(helmet());

// Serve static files from server/public (client build output)
app.use(express.static('public'));

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/readyz', async (_req, res) => {
  try { 
    await redis.ping(); 
    await prisma.$queryRaw`SELECT 1`;
    return res.json({ ok: true, degraded: { db: false } });
  } catch {
    // Check which service is down
    let redisOk = true, dbOk = true;
    try { await redis.ping(); } catch { redisOk = false; }
    try { await prisma.$queryRaw`SELECT 1`; } catch { dbOk = false; }
    
    if (!redisOk) {
      return res.status(503).json({ ok: false, degraded: { redis: true, db: !dbOk } });
    }
    return res.json({ ok: true, degraded: { db: true } });
  }
});

app.use('/api/rooms', roomsRouter);
app.use(sentryHandlers.error); // LAST

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  // Server started successfully
});
registerWsGateway(server, allowlistCsv);

// Graceful shutdown: flush, then close
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
async function shutdown() {
  try { await prisma.$disconnect(); } catch { /* ignore disconnect errors */ }
  try { await redis.quit(); } catch { /* ignore quit errors */ }
  server.close(()=>process.exit(0));
}