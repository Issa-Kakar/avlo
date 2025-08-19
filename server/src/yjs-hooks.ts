import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { prisma } from './clients/prisma.js';
import { redis } from './clients/redis.js';
import { crumb, capture, recordFlushTiming, count } from './obs.js';

export const yjsEvents = new EventEmitter();
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const TTL_SECONDS = parseInt(process.env.ROOM_TTL_DAYS || '14', 10) * 24 * 60 * 60;
const HARD_CAP = 10 * 1024 * 1024; // 10MB
const STATS_DELTA = 100 * 1024; // 100KB

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const lastFlushAt = new Map<string, number>();
const lastBytes = new Map<string, number>();
const lastSeen = new Map<string, number>();

export function scheduleWrite(roomId: string, producer: () => Uint8Array) {
  const now = Date.now();
  const prev = lastFlushAt.get(roomId) || 0;
  const dueIn = Math.max(0, 2000 - (now - prev)); // ~2s debounce
  clearTimeout(timers.get(roomId));
  const t = setTimeout(() => flush(roomId, producer), Math.min(dueIn, 5000)); // ≤5s worst
  timers.set(roomId, t);
  markRoomActive(roomId);
}

export function markRoomActive(roomId: string) {
  lastSeen.set(roomId, Date.now());
}

export function clearRoomTimer(roomId: string) {
  const t = timers.get(roomId);
  if (t) clearTimeout(t);
  timers.delete(roomId);
  lastSeen.delete(roomId);
  lastFlushAt.delete(roomId);
  lastBytes.delete(roomId);
}

async function flush(roomId: string, producer: () => Uint8Array) {
  // Skip persistence if REDIS_OFF is set (for testing)
  if (process.env.REDIS_OFF === 'true') {
    console.log('[Persistence] Skipping Redis write for room:', roomId, '(REDIS_OFF=true)');
    return;
  }

  const flushStart = Date.now();
  try {
    const binary = Buffer.from(producer());
    const compressed = await gzipAsync(binary, { level: 4 });
    const bytes = (compressed as Buffer).length;

    const isReadOnly = bytes >= HARD_CAP;
    if (!isReadOnly) {
      await redis.set(`room:${roomId}`, compressed as Buffer, { EX: TTL_SECONDS });
      crumb('redis_write_accept');
      count('redis_write_accept', 'persistence');
      
      // Try to update PostgreSQL metadata, but don't fail if it's unavailable
      try {
        await prisma.room.upsert({
          where: { id: roomId },
          update: { sizeBytes: bytes, lastWriteAt: new Date() },
          create: {
            id: roomId,
            title: roomId,
            createdAt: new Date(),
            lastWriteAt: new Date(),
            sizeBytes: bytes,
          },
        });
      } catch (pgError) {
        // Log but don't throw - Redis is authoritative
        console.warn(`Failed to update PostgreSQL metadata for room ${roomId}:`, pgError);
        count('postgres_metadata_update_fail', 'persistence');
      }
    } else {
      crumb('redis_write_skip_readonly', 'persistence', 'warning');
      count('redis_write_skip_readonly', 'persistence');
    }

    // Record flush timing for observability
    const flushDuration = Date.now() - flushStart;
    recordFlushTiming(flushDuration);

    // room_stats cadence
    const prevBytes = lastBytes.get(roomId) || 0;
    const prevAt = lastFlushAt.get(roomId) || 0;
    const now = Date.now();
    if (now - prevAt >= 5000 || Math.abs(bytes - prevBytes) >= STATS_DELTA) {
      yjsEvents.emit('room_stats', { roomId, bytes, cap: HARD_CAP });
      crumb('room_stats_publish');
      count('room_stats_publish', 'metrics');
      lastBytes.set(roomId, bytes);
      lastFlushAt.set(roomId, now);
    } else {
      lastFlushAt.set(roomId, now);
    }

    // Check for soft limit (8MB warning)
    const SOFT_CAP = 8 * 1024 * 1024; // 8MB
    if (bytes >= SOFT_CAP && bytes < HARD_CAP) {
      count('limit_soft_hits', 'capacity');
    }

    if (isReadOnly) {
      yjsEvents.emit('readonly', { roomId });
      count('limit_hard_hits', 'capacity');
    }
  } catch (e) {
    capture(e, 'prisma_upsert_fail');
  }
}

export async function loadState(roomId: string): Promise<Uint8Array | null> {
  // Skip persistence if REDIS_OFF is set (for testing)
  if (process.env.REDIS_OFF === 'true') {
    console.log('[Persistence] Skipping Redis load for room:', roomId, '(REDIS_OFF=true)');
    return null;
  }

  try {
    const compressed = await redis.getBuffer(`room:${roomId}`);
    if (!compressed) return null;
    // redis v5 returns Buffer | string | number | boolean | ... we know it's a Buffer
    const buffer = compressed as unknown as Buffer;
    const decompressed = await gunzipAsync(buffer);
    return new Uint8Array(decompressed);
  } catch (e) {
    capture(e, 'redis_load_fail');
    return null;
  }
}

// Periodic GC for abandoned rooms (no clients + idle > 10 min)
setInterval(() => {
  const now = Date.now();
  for (const [roomId, ts] of lastSeen) {
    if (now - ts > 10 * 60 * 1000) {
      // Room has been idle for more than 10 minutes
      clearRoomTimer(roomId);
    }
  }
}, 60 * 1000); // Run every minute
