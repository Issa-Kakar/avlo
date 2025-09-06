import { createClient, RESP_TYPES } from 'redis';
import { ServerEnv } from '../config/env.js';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export class RedisAdapter {
  private client: ReturnType<typeof createClient>;
  private env: ServerEnv;

  constructor(env: ServerEnv) {
    this.env = env;
    // Create client with type mapping to ensure binary strings return as Buffers
    this.client = createClient({
      url: env.REDIS_URL,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 10) return new Error('Max reconnection attempts reached');
          return Math.min(retries * 100, 3000);
        },
      },
    }).withTypeMapping({
      [RESP_TYPES.BLOB_STRING]: Buffer, // Ensure binary strings → Buffer
    });

    this.client.on('error', (err) => {
      console.error('[Redis] Client error:', err);
    });

    this.client.on('connect', () => {
      // Redis connected successfully
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }

  async saveRoom(roomId: string, docState: Uint8Array): Promise<number> {
    // Compress the document
    const compressed = await gzipAsync(Buffer.from(docState), { level: this.env.GZIP_LEVEL });

    // Save with TTL
    const ttlSeconds = this.env.ROOM_TTL_DAYS * 24 * 60 * 60;
    const key = `room:${roomId}`;

    // Store as Buffer to ensure binary data is preserved
    await this.client.setEx(key, ttlSeconds, compressed);

    return compressed.length; // Return compressed size
  }

  async loadRoom(roomId: string): Promise<Uint8Array | null> {
    const key = `room:${roomId}`;

    // Thanks to type mapping, GET returns Buffer for binary strings
    const compressed = (await this.client.get(key)) as Buffer | null;

    if (!compressed) return null;

    // Decompress the gzipped data
    const decompressed = await gunzipAsync(compressed);
    return new Uint8Array(decompressed);
  }

  async extendTTL(roomId: string): Promise<boolean> {
    const key = `room:${roomId}`;
    const ttlSeconds = this.env.ROOM_TTL_DAYS * 24 * 60 * 60;
    const result = await this.client.expire(key, ttlSeconds);
    return result === 1;
  }

  async exists(roomId: string): Promise<boolean> {
    const key = `room:${roomId}`;
    return (await this.client.exists(key)) === 1;
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.ping();
      return true;
    } catch {
      return false;
    }
  }
}

// Singleton instance
let redisAdapter: RedisAdapter | null = null;

export async function getRedisAdapter(env: ServerEnv): Promise<RedisAdapter> {
  if (!redisAdapter) {
    redisAdapter = new RedisAdapter(env);
    await redisAdapter.connect();
  }
  return redisAdapter;
}

// Helper functions for testing - match what the tests expect
export async function saveDocToRedis(
  client: any,
  roomId: string,
  ydoc: any,
  ttlDays: number,
): Promise<number> {
  const Y = await import('yjs');
  const stateUpdate = Y.encodeStateAsUpdate(ydoc);
  const compressed = await gzipAsync(Buffer.from(stateUpdate), { level: 4 });

  const ttlSeconds = ttlDays * 24 * 60 * 60;
  const key = `room:${roomId}`;

  await client.set(key, compressed, 'EX', ttlSeconds);
  return compressed.length;
}

export async function loadDocFromRedis(client: any, roomId: string): Promise<any | null> {
  const Y = await import('yjs');
  const key = `room:${roomId}`;
  const compressed = await client.get(key);

  if (!compressed) return null;

  const decompressed = await gunzipAsync(compressed);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(decompressed));
  return doc;
}
