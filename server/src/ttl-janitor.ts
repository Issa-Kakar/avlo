import { redis } from './clients/redis.js';
import { prisma } from './clients/prisma.js';
import { crumb, count } from './obs.js';

const JANITOR_INTERVAL = parseInt(process.env.TTL_JANITOR_INTERVAL_MS || '3600000', 10); // Default: 1 hour
const ROOM_TTL_DAYS = parseInt(process.env.ROOM_TTL_DAYS || '14', 10);
const ROOM_TTL_MS = ROOM_TTL_DAYS * 24 * 60 * 60 * 1000;

let janitorTimer: ReturnType<typeof setInterval> | null = null;

async function cleanupExpiredRooms(): Promise<void> {
  const startTime = Date.now();
  let deletedCount = 0;
  let errorCount = 0;

  try {
    crumb('ttl_janitor_start', 'janitor', 'info');

    // Get all room records from PostgreSQL to check for expiry
    const rooms = await prisma.room.findMany({
      select: {
        id: true,
        lastWriteAt: true,
      },
      where: {
        lastWriteAt: {
          lt: new Date(Date.now() - ROOM_TTL_MS),
        },
      },
    });

    crumb(`ttl_janitor_found_expired: ${rooms.length}`, 'janitor', 'info');
    count('ttl_janitor_expired_rooms', 'janitor');

    for (const room of rooms) {
      try {
        // Check if Redis key still exists
        const exists = await redis.exists(`room:${room.id}`);

        if (exists) {
          // Redis key exists but should be expired - delete it
          await redis.del(`room:${room.id}`);
          crumb(`ttl_janitor_deleted_redis: ${room.id}`, 'janitor', 'info');
        }

        // Clean up PostgreSQL record
        await prisma.room.delete({
          where: { id: room.id },
        });

        deletedCount++;
        count('ttl_janitor_rooms_deleted', 'janitor');
      } catch (error) {
        errorCount++;
        crumb(`ttl_janitor_error_room: ${room.id} - ${error}`, 'janitor', 'error');
        count('ttl_janitor_errors', 'janitor');
      }
    }

    // Also check for Redis keys without PostgreSQL records (orphaned)
    const redisKeys = await redis.keys('room:*');
    const orphanedKeys: string[] = [];

    for (const key of redisKeys) {
      const roomId = key.replace('room:', '');
      const dbRoom = await prisma.room.findUnique({
        where: { id: roomId },
      });

      if (!dbRoom) {
        orphanedKeys.push(key);
      }
    }

    if (orphanedKeys.length > 0) {
      crumb(`ttl_janitor_orphaned_keys: ${orphanedKeys.length}`, 'janitor', 'warning');
      count('ttl_janitor_orphaned_keys', 'janitor');

      // Delete orphaned Redis keys
      for (const key of orphanedKeys) {
        await redis.del(key);
        deletedCount++;
      }
    }

    const duration = Date.now() - startTime;
    crumb(
      `ttl_janitor_complete: deleted=${deletedCount}, errors=${errorCount}, duration=${duration}ms`,
      'janitor',
      'info',
    );
    count('ttl_janitor_runs', 'janitor');
  } catch (error) {
    crumb(`ttl_janitor_fatal_error: ${error}`, 'janitor', 'error');
    count('ttl_janitor_fatal_errors', 'janitor');
  }
}

export function startTTLJanitor(): void {
  if (janitorTimer) {
    clearInterval(janitorTimer);
  }

  // Run immediately on startup
  cleanupExpiredRooms().catch((error) => {
    crumb(`TTL janitor initial run failed: ${error}`, 'janitor', 'error');
  });

  // Then run periodically
  janitorTimer = setInterval(() => {
    cleanupExpiredRooms().catch((error) => {
      crumb(`TTL janitor periodic run failed: ${error}`, 'janitor', 'error');
    });
  }, JANITOR_INTERVAL);

  crumb(
    `TTL janitor started with interval: ${JANITOR_INTERVAL}ms (${JANITOR_INTERVAL / 1000 / 60} minutes)`,
    'janitor',
    'info',
  );
}

export function stopTTLJanitor(): void {
  if (janitorTimer) {
    clearInterval(janitorTimer);
    janitorTimer = null;
    crumb('TTL janitor stopped', 'janitor', 'info');
  }
}
