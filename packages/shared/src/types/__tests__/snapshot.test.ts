import { describe, it, expect, beforeEach } from 'vitest';
import { 
  createEmptySnapshot, 
  type Snapshot, 
  type StrokeView, 
  type TextView 
} from '../snapshot';

describe('Snapshot Types', () => {
  describe('createEmptySnapshot', () => {
    it('should create a valid empty snapshot with all required fields', () => {
      const snapshot = createEmptySnapshot();
      
      // Verify structure
      expect(snapshot).toBeDefined();
      expect(snapshot.svKey).toBe('empty'); // Per implementation
      expect(snapshot.scene).toBe(0);
      expect(snapshot.strokes).toEqual([]);
      expect(snapshot.texts).toEqual([]);
      expect(snapshot.presence).toEqual({ users: new Map(), localUserId: '' });
      expect(snapshot.spatialIndex).toBeNull();
      
      // Verify view transform
      expect(snapshot.view.scale).toBe(1);
      expect(snapshot.view.pan).toEqual({ x: 0, y: 0 });
      
      // Verify meta
      expect(snapshot.meta.bytes).toBeUndefined();
      expect(snapshot.meta.cap).toBe(15 * 1024 * 1024); // 15 MB in bytes
      expect(snapshot.meta.readOnly).toBe(false);
      expect(snapshot.meta.expiresAt).toBeUndefined();
      
      // Verify timestamp
      expect(snapshot.createdAt).toBeTypeOf('number');
      expect(snapshot.createdAt).toBeGreaterThan(0);
    });

    it('should create frozen snapshot in development', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      
      const snapshot = createEmptySnapshot();
      
      // Test immutability
      expect(() => {
        (snapshot as any).scene = 999;
      }).toThrow();
      
      expect(() => {
        (snapshot.strokes as any).push({} as StrokeView);
      }).toThrow();
      
      process.env.NODE_ENV = originalEnv;
    });

    it('should create frozen snapshot in production', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      
      const snapshot = createEmptySnapshot();
      
      // Snapshots are ALWAYS frozen per spec (immutable by contract)
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.strokes)).toBe(true);
      expect(Object.isFrozen(snapshot.texts)).toBe(true);
      
      process.env.NODE_ENV = originalEnv;
    });

    it('should never return null', () => {
      const snapshot = createEmptySnapshot();
      expect(snapshot).not.toBeNull();
      expect(snapshot).not.toBeUndefined();
    });
  });

  describe('Snapshot Type Contracts', () => {
    it('should ensure StrokeView has correct structure', () => {
      const strokeView: StrokeView = {
        id: 'stroke-123',
        points: [0, 0, 100, 100],
        polyline: null, // Always null in snapshot
        style: {
          color: '#000000',
          size: 2,
          opacity: 1,
          tool: 'pen'
        },
        bbox: [0, 0, 100, 100],
        scene: 0,
        createdAt: Date.now(),
        userId: 'user-123'
      };

      expect(strokeView.polyline).toBeNull();
      expect(Array.isArray(strokeView.points)).toBe(true);
      expect(strokeView.bbox).toHaveLength(4);
    });

    it('should ensure TextView has correct structure', () => {
      const textView: TextView = {
        id: 'text-123',
        x: 100,
        y: 200,
        w: 150,
        h: 50,
        content: 'Test text',
        color: '#000000',
        size: 16,
        scene: 0,
        createdAt: Date.now(),
        userId: 'user-123'
      };

      expect(textView.content).toBeTypeOf('string');
      expect(textView.x).toBeTypeOf('number');
      expect(textView.scene).toBeTypeOf('number');
    });

    it('should ensure ViewTransform has correct methods', () => {
      const snapshot = createEmptySnapshot();
      const { worldToCanvas, canvasToWorld } = snapshot.view;

      // Test transform functions
      const [cx, cy] = worldToCanvas(100, 200);
      expect(cx).toBe(100);
      expect(cy).toBe(200);

      const [wx, wy] = canvasToWorld(100, 200);
      expect(wx).toBe(100);
      expect(wy).toBe(200);
    });
  });

  describe('Snapshot Immutability Rules', () => {
    it('should create new arrays per snapshot', () => {
      const snap1 = createEmptySnapshot();
      const snap2 = createEmptySnapshot();
      
      // Different array instances
      expect(snap1.strokes).not.toBe(snap2.strokes);
      expect(snap1.texts).not.toBe(snap2.texts);
      
      // But same content
      expect(snap1.strokes).toEqual(snap2.strokes);
      expect(snap1.texts).toEqual(snap2.texts);
    });
  });
});