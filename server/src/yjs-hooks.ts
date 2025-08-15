import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { prisma } from './clients/prisma.js';
import { redis } from './clients/redis.js';
import { crumb, capture } from './obs.js';

export const yjsEvents = new EventEmitter();
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const TTL_SECONDS = parseInt(process.env.ROOM_TTL_DAYS || '14', 10) * 24 * 60 * 60;
const HARD_CAP = 10 * 1024 * 1024; // 10MB
const STATS_DELTA = 100 * 1024; // 100KB

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const lastFlushAt = new Map<string, number>();
const lastBytes = new Map<string, number>();

export function scheduleWrite(roomId: string, producer: () => Uint8Array) {
  const now = Date.now();
  const prev = lastFlushAt.get(roomId) || 0;
  const dueIn = Math.max(0, 2000 - (now - prev)); // ~2s debounce
  clearTimeout(timers.get(roomId));
  const t = setTimeout(() => flush(roomId, producer), Math.min(dueIn, 5000)); // ≤5s worst
  timers.set(roomId, t);
}

async function flush(roomId: string, producer: () => Uint8Array) {
  try {
    const binary = Buffer.from(producer());
    const compressed = await gzipAsync(binary, { level: 4 });
    const bytes = (compressed as Buffer).length;

    const isReadOnly = bytes >= HARD_CAP;
    if (!isReadOnly) {
      await redis.set(`room:${roomId}`, compressed as Buffer, { EX: TTL_SECONDS });
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
      crumb('redis_write_accept');
    } else {
      crumb('redis_write_skip_readonly', 'gateway', 'warning');
    }

    // room_stats cadence
    const prevBytes = lastBytes.get(roomId) || 0;
    const prevAt = lastFlushAt.get(roomId) || 0;
    const now = Date.now();
    if (now - prevAt >= 5000 || Math.abs(bytes - prevBytes) >= STATS_DELTA) {
      yjsEvents.emit('room_stats', { roomId, bytes, cap: HARD_CAP });
      crumb('room_stats_publish');
      lastBytes.set(roomId, bytes);
      lastFlushAt.set(roomId, now);
    } else {
      lastFlushAt.set(roomId, now);
    }

    if (isReadOnly) yjsEvents.emit('readonly', { roomId });
  } catch (e) {
    capture(e, 'prisma_upsert_fail');
  }
}

export async function loadState(roomId: string): Promise<Uint8Array | null> {
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
