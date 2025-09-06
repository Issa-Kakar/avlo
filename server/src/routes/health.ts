import { Router } from 'express';
import { getRedisAdapter } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';

const router = Router();

router.get('/healthz', async (req, res) => {
  const health = {
    status: 'ok',
    phase: 6,
    services: {
      redis: false,
      postgres: false,
    },
  };

  try {
    // Check Redis
    const redis = await getRedisAdapter(req.app.locals.env);
    health.services.redis = await redis.ping();

    // Check Postgres
    await prisma.$queryRaw`SELECT 1`;
    health.services.postgres = true;
  } catch (error) {
    console.error('[Health] Check failed:', error);
  }

  const httpStatus = health.services.redis && health.services.postgres ? 200 : 503;
  res.status(httpStatus).json(health);
});

export { router as healthRoutes };
