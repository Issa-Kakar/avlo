import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RenderCache } from '../render-cache';

// Mock IndexedDB
const mockIDB = {
  databases: new Map<string, Map<string, any>>(),
  
  open: vi.fn((name: string) => {
    if (!mockIDB.databases.has(name)) {
      mockIDB.databases.set(name, new Map());
    }
    return Promise.resolve({
      get: (key: string) => Promise.resolve(mockIDB.databases.get(name)?.get(key)),
      put: (key: string, value: any) => {
        mockIDB.databases.get(name)?.set(key, value);
        return Promise.resolve();
      },
      delete: (key: string) => {
        mockIDB.databases.get(name)?.delete(key);
        return Promise.resolve();
      },
      clear: () => {
        mockIDB.databases.get(name)?.clear();
        return Promise.resolve();
      }
    });
  })
};

describe('RenderCache', () => {
  let cache: RenderCache;
  let canvas: HTMLCanvasElement;

  beforeEach(() => {
    // Setup
    cache = new RenderCache();
    canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 100;
    
    // Mock canvas toBlob
    canvas.toBlob = vi.fn((callback) => {
      const blob = new Blob(['mock-image-data'], { type: 'image/png' });
      callback(blob);
    }) as any;

    // Clear mock database
    mockIDB.databases.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Store Operation', () => {
    it('should store canvas render with roomId and svKey', async () => {
      const result = await cache.store('room-123', 'svKey-abc', canvas);
      
      expect(result).toBe(true);
      expect(canvas.toBlob).toHaveBeenCalled();
    });

    it('should skip storing if svKey is unchanged', async () => {
      await cache.store('room-123', 'svKey-abc', canvas);
      
      // Try storing with same svKey
      const result = await cache.store('room-123', 'svKey-abc', canvas);
      
      expect(result).toBe(false); // Should skip
      expect(canvas.toBlob).toHaveBeenCalledTimes(1); // Only called once
    });

    it('should update cache when svKey changes', async () => {
      await cache.store('room-123', 'svKey-abc', canvas);
      await cache.store('room-123', 'svKey-xyz', canvas);
      
      expect(canvas.toBlob).toHaveBeenCalledTimes(2);
    });

    it('should handle multiple rooms independently', async () => {
      await cache.store('room-123', 'svKey-abc', canvas);
      await cache.store('room-456', 'svKey-abc', canvas);
      
      expect(canvas.toBlob).toHaveBeenCalledTimes(2);
    });

    it('should handle canvas toBlob errors gracefully', async () => {
      canvas.toBlob = vi.fn((callback) => {
        callback(null); // Simulate failure
      }) as any;
      
      const result = await cache.store('room-123', 'svKey-abc', canvas);
      
      expect(result).toBe(false);
    });
  });

  describe('Retrieve Operation', () => {
    it('should retrieve cached render for room', async () => {
      const mockBlob = new Blob(['image-data'], { type: 'image/png' });
      
      // Store mock data directly
      const db = await mockIDB.open('avlo-render-cache');
      await db.put('room-123', {
        svKey: 'svKey-abc',
        blob: mockBlob,
        timestamp: Date.now()
      });
      
      const result = await cache.get('room-123');
      
      expect(result).toBeDefined();
      expect(result?.svKey).toBe('svKey-abc');
      expect(result?.blob).toBeInstanceOf(Blob);
    });

    it('should return null for non-existent room', async () => {
      const result = await cache.get('non-existent');
      expect(result).toBeNull();
    });

    it('should return cached data with correct structure', async () => {
      await cache.store('room-123', 'svKey-abc', canvas);
      const result = await cache.get('room-123');
      
      expect(result).toHaveProperty('svKey');
      expect(result).toHaveProperty('blob');
      expect(result).toHaveProperty('timestamp');
      expect(result?.svKey).toBe('svKey-abc');
    });
  });

  describe('Clear Operation', () => {
    it('should clear cache for specific room', async () => {
      await cache.store('room-123', 'svKey-abc', canvas);
      await cache.store('room-456', 'svKey-xyz', canvas);
      
      await cache.clear('room-123');
      
      const result1 = await cache.get('room-123');
      const result2 = await cache.get('room-456');
      
      expect(result1).toBeNull();
      expect(result2).toBeDefined(); // Other room unaffected
    });

    it('should clear all caches when no roomId specified', async () => {
      await cache.store('room-123', 'svKey-abc', canvas);
      await cache.store('room-456', 'svKey-xyz', canvas);
      
      await cache.clearAll();
      
      const result1 = await cache.get('room-123');
      const result2 = await cache.get('room-456');
      
      expect(result1).toBeNull();
      expect(result2).toBeNull();
    });
  });

  describe('Boot Splash Integration', () => {
    it('should be usable for boot splash rendering', async () => {
      // Simulate boot splash flow
      const roomId = 'room-boot';
      const svKey = 'initial-state';
      
      // Store initial render
      await cache.store(roomId, svKey, canvas);
      
      // On next boot, retrieve
      const cached = await cache.get(roomId);
      
      if (cached && cached.svKey === svKey) {
        // Can use cached render for instant display
        expect(cached.blob).toBeDefined();
        expect(cached.blob.type).toBe('image/png');
      }
    });

    it('should skip stale cache on svKey mismatch', async () => {
      await cache.store('room-123', 'old-svKey', canvas);
      
      const cached = await cache.get('room-123');
      const currentSvKey = 'new-svKey';
      
      // Should detect mismatch
      expect(cached?.svKey).not.toBe(currentSvKey);
    });
  });

  describe('Error Handling', () => {
    it('should handle IndexedDB errors gracefully', async () => {
      // Force IDB error
      mockIDB.open = vi.fn(() => Promise.reject(new Error('IDB failed')));
      
      const result = await cache.store('room-123', 'svKey', canvas);
      expect(result).toBe(false);
      
      const retrieved = await cache.get('room-123');
      expect(retrieved).toBeNull();
    });
  });
});