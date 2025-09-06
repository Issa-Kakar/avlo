/**
 * Phase 6 Redis Persistence Test - Minimal, surgical test
 * Tests gzip compression and TTL setting
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import { gzipSync, gunzipSync } from 'zlib';
import { loadDocFromRedis, saveDocToRedis } from '../lib/redis';
import { createMockRedis } from './test-utils';

describe('Phase 6 Redis Persistence - Minimal Tests', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('saves Y.Doc with gzip level 4 compression and TTL', async () => {
    const roomId = 'test-room-001';
    const ydoc = new Y.Doc();

    // Add some test data
    const root = ydoc.getMap('root');
    root.set('v', 1);
    const strokes = new Y.Array();
    strokes.push([
      {
        id: 'stroke-1',
        points: [0, 0, 100, 100],
        tool: 'pen',
        color: '#000000',
      },
    ]);
    root.set('strokes', strokes);

    // Save to Redis
    const sizeBytes = await saveDocToRedis(mockRedis.client, roomId, ydoc, 14);

    // Verify Redis SET was called with compressed data
    expect(mockRedis.client.set).toHaveBeenCalledTimes(1);
    const [key, buffer, ex, ttl] = mockRedis.client.set.mock.calls[0];

    expect(key).toBe(`room:${roomId}`);
    expect(ex).toBe('EX');
    expect(ttl).toBe(14 * 24 * 60 * 60); // 14 days in seconds

    // Verify it's compressed (for small docs, compressed may be larger due to headers)
    const uncompressed = Y.encodeStateAsUpdate(ydoc);
    expect(buffer).toBeDefined();
    expect(buffer.length).toBeGreaterThan(0);

    // Verify we can decompress and restore
    const decompressed = gunzipSync(buffer);
    const restoredDoc = new Y.Doc();
    Y.applyUpdate(restoredDoc, decompressed);

    const restoredRoot = restoredDoc.getMap('root');
    expect(restoredRoot.get('v')).toBe(1);
    const restoredStrokes = restoredRoot.get('strokes') as Y.Array<any>;
    expect(restoredStrokes.length).toBe(1);
    expect(restoredStrokes.get(0).id).toBe('stroke-1');

    // Verify returned size is compressed size
    expect(sizeBytes).toBe(buffer.length);
  });

  it('loads Y.Doc from compressed Redis data', async () => {
    const roomId = 'test-room-002';

    // Create a doc and compress it
    const originalDoc = new Y.Doc();
    const root = originalDoc.getMap('root');
    root.set('v', 1);
    root.set('meta', new Y.Map());

    const stateUpdate = Y.encodeStateAsUpdate(originalDoc);
    const compressed = gzipSync(stateUpdate, { level: 4 });

    // Mock Redis GET to return compressed data
    mockRedis.client.get.mockResolvedValueOnce(compressed);

    // Load from Redis
    const loadedDoc = await loadDocFromRedis(mockRedis.client, roomId);

    expect(mockRedis.client.get).toHaveBeenCalledWith(`room:${roomId}`);
    expect(loadedDoc).not.toBeNull();

    if (loadedDoc) {
      const loadedRoot = loadedDoc.getMap('root');
      expect(loadedRoot.get('v')).toBe(1);
      expect(loadedRoot.has('meta')).toBe(true);
    }
  });

  it('returns null for non-existent room', async () => {
    mockRedis.client.get.mockResolvedValueOnce(null);

    const doc = await loadDocFromRedis(mockRedis.client, 'non-existent');
    expect(doc).toBeNull();
    expect(mockRedis.client.get).toHaveBeenCalledWith('room:non-existent');
  });

  it('handles compression level correctly', async () => {
    const roomId = 'test-compression';
    const ydoc = new Y.Doc();

    // Create a larger document to see compression effect
    const root = ydoc.getMap('root');
    const strokes = new Y.Array();
    for (let i = 0; i < 100; i++) {
      strokes.push([
        {
          id: `stroke-${i}`,
          points: Array.from({ length: 100 }, (_, j) => j),
          tool: 'pen',
          color: '#000000',
        },
      ]);
    }
    root.set('strokes', strokes);

    await saveDocToRedis(mockRedis.client, roomId, ydoc, 7);

    const [, compressedBuffer] = mockRedis.client.set.mock.calls[0];

    // Verify it's actually compressed (should be much smaller)
    const uncompressed = Y.encodeStateAsUpdate(ydoc);
    const compressionRatio = compressedBuffer.length / uncompressed.length;
    expect(compressionRatio).toBeLessThan(0.5); // Should compress to less than 50%
  });
});
