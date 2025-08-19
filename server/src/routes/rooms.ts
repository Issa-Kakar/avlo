import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { prisma } from '../clients/prisma.js';
import { redis } from '../clients/redis.js';
import { capture } from '../obs.js';

const limiter10h = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });

const ROOM_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
const createSchema = z
  .object({ id: z.string().regex(ROOM_ID_REGEX).optional(), title: z.string().max(120).optional() })
  .strict();
const titleSchema = z.object({ title: z.string().max(120) }).strict();

// Async error wrapper to ensure all errors are caught
type AsyncRouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<void | Response>;
const asyncHandler =
  (fn: AsyncRouteHandler) => (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      capture(err, 'route_error');
      next(err);
    });
  };

const router = Router();

router.post(
  '/',
  limiter10h,
  asyncHandler(async (req: Request, res: Response) => {
    const parse = createSchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input' });
    const id = (parse.data.id || randomUUID()).replace(/-/g, '');

    try {
      const existing = await prisma.room.findUnique({ where: { id } });
      if (existing) return res.status(200).json({ roomId: id, shareLink: `/rooms/${id}` });
      await prisma.room.create({
        data: {
          id,
          title: parse.data.title || id,
          createdAt: new Date(),
          lastWriteAt: new Date(),
          sizeBytes: 0,
        },
      });
      return res.status(201).json({ roomId: id, shareLink: `/rooms/${id}` });
    } catch (e) {
      console.error('Room creation error:', e);
      capture(e, 'room_create_error');
      
      // If PostgreSQL is down, still allow room creation (Redis will be authoritative)
      // Check if this is a connection error
      const isConnectionError = e && typeof e === 'object' && 
        ('code' in e && (e.code === 'P1001' || e.code === 'ECONNREFUSED')) ||
        (e instanceof Error && e.message.includes('connect'));
      
      if (isConnectionError) {
        console.warn('PostgreSQL unavailable, creating room without metadata entry');
        // Room will be created in Redis when first client connects
        return res.status(201).json({ roomId: id, shareLink: `/rooms/${id}` });
      }
      
      return res.status(500).json({ error: 'internal_error' });
    }
  }),
);

router.get(
  '/:id/metadata',
  asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id;
    if (!ROOM_ID_REGEX.test(id)) {
      res.status(400).json({ error: 'invalid_room_id' });
      return;
    }

    try {
      const buf = await redis.getBuffer(`room:${id}`);
      if (!buf) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const r = await prisma.room.findUnique({ where: { id } });
      if (!r) {
        // Room exists in Redis but not in PostgreSQL - create metadata entry
        console.log(`Room ${id} exists in Redis but not in PostgreSQL, creating metadata entry`);
        try {
          const newRoom = await prisma.room.create({
            data: {
              id,
              title: id,
              createdAt: new Date(),
              lastWriteAt: new Date(),
              sizeBytes: (buf as unknown as Buffer).length || 0,
            },
          });
          const expiresAt = new Date(
            newRoom.lastWriteAt.getTime() +
              parseInt(process.env.ROOM_TTL_DAYS || '14', 10) * 24 * 60 * 60 * 1000,
          );
          res.json({
            title: newRoom.title,
            size_bytes: newRoom.sizeBytes,
            created_at: newRoom.createdAt.toISOString(),
            expires_at: expiresAt.toISOString(),
          });
          return;
        } catch (createErr) {
          console.error('Failed to create room metadata:', createErr);
          // Fall back to minimal response if PostgreSQL is unavailable
          const expiresAt = new Date(
            Date.now() + parseInt(process.env.ROOM_TTL_DAYS || '14', 10) * 24 * 60 * 60 * 1000,
          );
          res.json({
            title: id,
            size_bytes: (buf as unknown as Buffer).length || 0,
            created_at: new Date().toISOString(),
            expires_at: expiresAt.toISOString(),
          });
          return;
        }
      }
      const expiresAt = new Date(
        r.lastWriteAt.getTime() +
          parseInt(process.env.ROOM_TTL_DAYS || '14', 10) * 24 * 60 * 60 * 1000,
      );
      res.json({
        title: r.title,
        size_bytes: r.sizeBytes,
        created_at: r.createdAt.toISOString(),
        expires_at: expiresAt.toISOString(),
      });
    } catch (e) {
      capture(e, 'room_metadata_error');
      // If Redis is down but room exists in DB, return degraded response
      if (e && typeof e === 'object' && 'code' in e && e.code === 'ECONNREFUSED') {
        res.status(503).json({ error: 'service_unavailable' });
        return;
      }
      res.status(500).json({ error: 'internal_error' });
    }
  }),
);

router.put(
  '/:id',
  limiter10h,
  asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id;
    if (!ROOM_ID_REGEX.test(id)) {
      res.status(400).json({ error: 'invalid_room_id' });
      return;
    }
    const parse = titleSchema.safeParse(req.body || {});
    if (!parse.success) {
      res.status(400).json({ error: 'invalid_input' });
      return;
    }

    try {
      const exists = await redis.exists(`room:${id}`);
      if (!exists) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await prisma.room.update({ where: { id }, data: { title: parse.data.title } });
      res.json({ ok: true });
    } catch (e) {
      capture(e, 'room_rename_error');
      res.status(500).json({ error: 'internal_error' });
    }
  }),
);

export default router;
