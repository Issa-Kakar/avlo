import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../clients/prisma';
import { redis } from '../clients/redis';
import { capture } from '../obs';

const limiter10h = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });

const idRe = /^[A-Za-z0-9_-]+$/;
const createSchema = z.object({ id: z.string().regex(idRe).optional(), title: z.string().max(120).optional() }).strict();
const titleSchema = z.object({ title: z.string().max(120) }).strict();

// Async error wrapper to ensure all errors are caught
type AsyncRouteHandler = (req: Request, res: Response, next: NextFunction) => Promise<void | Response>;
const asyncHandler = (fn: AsyncRouteHandler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res, next)).catch((err) => {
    capture(err, 'route_error');
    next(err);
  });
};

const router = Router();

router.post('/', limiter10h, asyncHandler(async (req: Request, res: Response) => {
  const parse = createSchema.safeParse(req.body || {});
  if (!parse.success) return res.status(400).json({ error: 'invalid_input' });
  const id = (parse.data.id || crypto.randomUUID()).replace(/-/g, '');
  
  try {
    const existing = await prisma.room.findUnique({ where: { id } });
    if (existing) return res.status(200).json({ roomId: id, shareLink: `/rooms/${id}` });
    await prisma.room.create({ data: { id, title: parse.data.title || id, createdAt: new Date(), lastWriteAt: new Date(), sizeBytes: 0 } });
    return res.status(201).json({ roomId: id, shareLink: `/rooms/${id}` });
  } catch (e) {
    capture(e, 'room_create_error');
    return res.status(500).json({ error: 'internal_error' });
  }
}));

router.get('/:id/metadata', asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id;
  
  try {
    const buf = await redis.getBuffer(`room:${id}`);
    if (!buf) return res.status(404).json({ error: 'not_found' });
    const r = await prisma.room.findUnique({ where: { id } });
    if (!r) return res.status(404).json({ error: 'not_found' });
    const expiresAt = new Date(r.lastWriteAt.getTime() + (parseInt(process.env.ROOM_TTL_DAYS || '14', 10) * 24 * 60 * 60 * 1000));
    res.json({ title: r.title, size_bytes: r.sizeBytes, created_at: r.createdAt.toISOString(), expires_at: expiresAt.toISOString() });
  } catch (e) {
    capture(e, 'room_metadata_error');
    // If Redis is down but room exists in DB, return degraded response
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ECONNREFUSED') {
      return res.status(503).json({ error: 'service_unavailable' });
    }
    return res.status(500).json({ error: 'internal_error' });
  }
}));

router.put('/:id', limiter10h, asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id;
  const parse = titleSchema.safeParse(req.body || {});
  if (!parse.success) return res.status(400).json({ error: 'invalid_input' });
  
  try {
    const exists = await redis.exists(`room:${id}`);
    if (!exists) return res.status(404).json({ error: 'not_found' });
    await prisma.room.update({ where: { id }, data: { title: parse.data.title } });
    res.json({ ok: true });
  } catch (e) {
    capture(e, 'room_rename_error');
    return res.status(500).json({ error: 'internal_error' });
  }
}));

export default router;