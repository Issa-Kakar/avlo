import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { prisma } from '../lib/prisma.js';
import { getRedisAdapter } from '../lib/redis.js';

const router = Router();

// Schemas
const CreateRoomSchema = z.object({
  title: z.string().max(120).optional(),
});

const RenameRoomSchema = z.object({
  title: z.string().max(120),
});

// POST /api/rooms - Create new room
router.post('/', async (req, res) => {
  try {
    const body = CreateRoomSchema.parse(req.body);
    const roomId = ulid();

    const room = await prisma.roomMetadata.create({
      data: {
        id: roomId,
        title: body.title || '',
      },
    });

    res.json({
      id: room.id,
      title: room.title,
      createdAt: room.createdAt.toISOString(),
      lastWriteAt: room.lastWriteAt.toISOString(),
      sizeBytes: 0,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request', details: error.issues });
    }
    console.error('[API] Create room error:', error);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// GET /api/rooms/:id/metadata - Get room metadata
router.get('/:id/metadata', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if room exists in Redis (authoritative)
    const redis = await getRedisAdapter(req.app.locals.env);
    const exists = await redis.exists(id);

    if (!exists) {
      return res.status(404).json({ error: 'Room not found or expired' });
    }

    // Get metadata from Postgres
    let metadata = await prisma.roomMetadata.findUnique({
      where: { id },
    });

    // Create minimal metadata if missing
    if (!metadata) {
      metadata = await prisma.roomMetadata.create({
        data: {
          id,
          title: '',
        },
      });
    }

    // Calculate expiry
    const ttlDays = req.app.locals.env.ROOM_TTL_DAYS;
    const expiresAt = new Date(metadata.lastWriteAt);
    expiresAt.setDate(expiresAt.getDate() + ttlDays);

    res.json({
      id: metadata.id,
      title: metadata.title,
      createdAt: metadata.createdAt.toISOString(),
      lastWriteAt: metadata.lastWriteAt.toISOString(),
      sizeBytes: metadata.sizeBytes,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (error) {
    console.error('[API] Get metadata error:', error);
    res.status(500).json({ error: 'Failed to get room metadata' });
  }
});

// PUT /api/rooms/:id/rename - Rename room
router.put('/:id/rename', async (req, res) => {
  try {
    const { id } = req.params;
    const body = RenameRoomSchema.parse(req.body);

    const room = await prisma.roomMetadata.update({
      where: { id },
      data: { title: body.title },
    });

    res.json({ title: room.title });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request', details: error.issues });
    }
    console.error('[API] Rename room error:', error);
    res.status(500).json({ error: 'Failed to rename room' });
  }
});

export { router as roomRoutes };
