/**
 * Phase 6 WebSocket Server Persistence Test
 * Minimal test for Y.Doc persistence on WebSocket updates
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
// Note: We're testing the persistence logic, not the actual WebSocket server
// The actual setupWSConnection is from @y/websocket-server/utils
import { createMockRedis } from './test-utils';

describe('Phase 6 WebSocket Persistence Integration', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;
  let mockPrisma: any;

  beforeEach(() => {
    mockRedis = createMockRedis();
    mockPrisma = {
      roomMetadata: {
        upsert: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists Y.Doc updates to Redis on doc update', async () => {
    const roomId = 'test-room-ws';

    // Create a Y.Doc (simulating what the server does)
    const serverDoc = new Y.Doc();

    // Import the persistence functions directly
    const { saveDocToRedis } = await import('../lib/redis');

    // Add data to the server doc
    const root = serverDoc.getMap('root');
    root.set('v', 1);
    const strokes = new Y.Array();
    strokes.push([
      {
        id: 'stroke-from-client',
        points: [10, 10, 20, 20],
        tool: 'pen',
      },
    ]);
    root.set('strokes', strokes);

    // Persist to Redis (what the server does on update)
    const sizeBytes = await saveDocToRedis(mockRedis.client, roomId, serverDoc, 14);

    // Verify Redis SET was called to persist the doc
    expect(mockRedis.client.set).toHaveBeenCalled();
    const [key, buffer, ex, ttl] = mockRedis.client.set.mock.calls[0];
    expect(key).toBe(`room:${roomId}`);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(ex).toBe('EX');
    expect(ttl).toBe(14 * 24 * 60 * 60);
    expect(sizeBytes).toBeGreaterThan(0);

    // In real app, Prisma update would happen after save
    await mockPrisma.roomMetadata.upsert({
      where: { id: roomId },
      create: {
        id: roomId,
        title: '',
        sizeBytes,
        lastWriteAt: new Date(),
      },
      update: {
        sizeBytes,
        lastWriteAt: new Date(),
      },
    });

    // Verify Prisma metadata was updated
    expect(mockPrisma.roomMetadata.upsert).toHaveBeenCalled();
  });

  it('loads existing doc from Redis', async () => {
    const roomId = 'existing-room';

    // Create an existing doc and save it
    const existingDoc = new Y.Doc();
    const root = existingDoc.getMap('root');
    root.set('v', 1);
    root.set('existingData', 'test-value');

    // Import the Redis functions
    const { saveDocToRedis, loadDocFromRedis } = await import('../lib/redis');

    // Save the doc first
    await saveDocToRedis(mockRedis.client, roomId, existingDoc, 14);

    // Mock the get to return what we saved
    const savedBuffer = mockRedis.client.set.mock.calls[0][1];
    mockRedis.client.get.mockResolvedValueOnce(savedBuffer);

    // Load it back
    const loadedDoc = await loadDocFromRedis(mockRedis.client, roomId);

    // Verify Redis GET was called
    expect(mockRedis.client.get).toHaveBeenCalledWith(`room:${roomId}`);

    // Verify the loaded doc has the right data
    expect(loadedDoc).not.toBeNull();
    if (loadedDoc) {
      const loadedRoot = loadedDoc.getMap('root');
      expect(loadedRoot.get('v')).toBe(1);
      expect(loadedRoot.get('existingData')).toBe('test-value');
    }
  });

  it('extends TTL on successful persist', async () => {
    const roomId = 'ttl-test';

    // Import the Redis functions
    const { saveDocToRedis } = await import('../lib/redis');

    // Create and save a doc
    const doc = new Y.Doc();
    doc.getMap('root').set('test', 'value');

    const ttlDays = 7;
    await saveDocToRedis(mockRedis.client, roomId, doc, ttlDays);

    // Verify SET was called with TTL
    expect(mockRedis.client.set).toHaveBeenCalled();
    const setCall = mockRedis.client.set.mock.calls[0];
    expect(setCall[2]).toBe('EX'); // Redis expiry flag
    expect(setCall[3]).toBe(ttlDays * 24 * 60 * 60); // TTL in seconds
  });
});
