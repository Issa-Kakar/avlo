import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { drawStrokes, clearStrokeCache, getStrokeCacheSize } from '../../layers/strokes';
import type { Snapshot, ViewTransform, PresenceView, StrokeView } from '@avlo/shared';
import type { ViewportInfo } from '../../types';

// Helper to create extended mock context with stroke methods
function createStrokeMockContext(): any {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    translate: vi.fn(),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    stroke: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    strokeStyle: '#000000',
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineCap: 'butt',
    lineJoin: 'miter',
    canvas: {
      width: 800,
      height: 600,
    } as HTMLCanvasElement,
  };
}

// Helper to create empty PresenceView matching the shared type
function createEmptyPresenceView(): PresenceView {
  return {
    users: new Map(),
    localUserId: '',
  };
}

// Helper to create a test stroke
function createTestStroke(id: string, options: Partial<StrokeView> = {}): StrokeView {
  return {
    id,
    points: [100, 100, 200, 200],
    polyline: null,
    style: { color: '#FF0000', size: 3, opacity: 1, tool: 'pen' },
    bbox: [100, 100, 200, 200],
    scene: 0,
    createdAt: Date.now(),
    userId: 'user-1',
    ...options,
  };
}

// Helper to create a test snapshot
function createTestSnapshot(
  strokes: StrokeView[],
  scene = 0,
  viewTransform?: ViewTransform,
): Snapshot {
  const defaultViewTransform: ViewTransform = {
    scale: 1,
    pan: { x: 0, y: 0 },
    worldToCanvas: (x: number, y: number) => [x, y],
    canvasToWorld: (x: number, y: number) => [x, y],
  };

  return {
    docVersion: 1,
    scene,
    strokes,
    texts: [],
    presence: createEmptyPresenceView(),
    spatialIndex: null,
    view: viewTransform || defaultViewTransform,
    meta: { cap: 15000000, readOnly: false },
    createdAt: Date.now(),
  };
}

describe('Stroke Rendering Layer', () => {
  let ctx: ReturnType<typeof createStrokeMockContext>;
  let viewTransform: ViewTransform;
  let viewport: ViewportInfo;

  beforeEach(() => {
    ctx = createStrokeMockContext();
    viewTransform = {
      scale: 1,
      pan: { x: 0, y: 0 },
      worldToCanvas: (x: number, y: number) => [x, y],
      canvasToWorld: (x: number, y: number) => [x, y],
    };
    viewport = {
      pixelWidth: 800,
      pixelHeight: 600,
      cssWidth: 800,
      cssHeight: 600,
      dpr: 1,
    };
    clearStrokeCache();
  });

  afterEach(() => {
    clearStrokeCache();
  });

  describe('basic rendering', () => {
    it('should render visible strokes', () => {
      const stroke = createTestStroke('stroke-1');
      const snapshot = createTestSnapshot([stroke]);

      drawStrokes(ctx, snapshot, viewTransform, viewport);

      // Should set stroke style
      expect(ctx.strokeStyle).toBe('#FF0000');
      expect(ctx.lineWidth).toBe(3);
      expect(ctx.globalAlpha).toBe(1);
      expect(ctx.lineCap).toBe('round');
      expect(ctx.lineJoin).toBe('round');

      // Should stroke the path (fallback since Path2D not available in tests)
      expect(ctx.beginPath).toHaveBeenCalled();
      expect(ctx.moveTo).toHaveBeenCalledWith(100, 100);
      expect(ctx.lineTo).toHaveBeenCalledWith(200, 200);
      expect(ctx.stroke).toHaveBeenCalled();

      // Should save/restore context
      expect(ctx.save).toHaveBeenCalledTimes(1);
      expect(ctx.restore).toHaveBeenCalledTimes(1);
    });

    it('should render multiple strokes', () => {
      const strokes = [
        createTestStroke('stroke-1', { points: [0, 0, 100, 100] }),
        createTestStroke('stroke-2', { points: [200, 200, 300, 300] }),
        createTestStroke('stroke-3', { points: [400, 400, 500, 500] }),
      ];
      const snapshot = createTestSnapshot(strokes);

      drawStrokes(ctx, snapshot, viewTransform, viewport);

      // Should render all visible strokes
      expect(ctx.stroke).toHaveBeenCalledTimes(3);
      expect(ctx.save).toHaveBeenCalledTimes(3);
      expect(ctx.restore).toHaveBeenCalledTimes(3);
    });

    it('should skip strokes with less than 2 points', () => {
      const strokes = [
        createTestStroke('single-point', { points: [100, 100] }), // Single point
        createTestStroke('empty', { points: [] }), // No points
        createTestStroke('valid', { points: [100, 100, 200, 200] }), // Valid
      ];
      const snapshot = createTestSnapshot(strokes);

      drawStrokes(ctx, snapshot, viewTransform, viewport);

      // Should only render the valid stroke
      expect(ctx.stroke).toHaveBeenCalledTimes(1);
    });
  });

  describe('tool-specific rendering', () => {
    it('should apply highlighter settings correctly', () => {
      const highlighter = createTestStroke('highlighter-1', {
        style: { color: '#FFFF00', size: 10, opacity: 0.25, tool: 'highlighter' },
      });
      const snapshot = createTestSnapshot([highlighter]);

      drawStrokes(ctx, snapshot, viewTransform, viewport);

      expect(ctx.strokeStyle).toBe('#FFFF00');
      expect(ctx.lineWidth).toBe(10);
      expect(ctx.globalAlpha).toBe(0.25);
      expect(ctx.globalCompositeOperation).toBe('source-over');
    });

    it('should render mixed pen and highlighter strokes', () => {
      const strokes = [
        createTestStroke('pen-1', {
          style: { color: '#FF0000', size: 2, opacity: 1, tool: 'pen' },
        }),
        createTestStroke('highlighter-1', {
          style: { color: '#FFFF00', size: 15, opacity: 0.3, tool: 'highlighter' },
        }),
        createTestStroke('pen-2', {
          style: { color: '#0000FF', size: 3, opacity: 0.8, tool: 'pen' },
        }),
      ];
      const snapshot = createTestSnapshot(strokes);

      drawStrokes(ctx, snapshot, viewTransform, viewport);

      // All strokes should be rendered
      expect(ctx.stroke).toHaveBeenCalledTimes(3);

      // Each should have save/restore to isolate styles
      expect(ctx.save).toHaveBeenCalledTimes(3);
      expect(ctx.restore).toHaveBeenCalledTimes(3);
    });
  });

  describe('viewport culling', () => {
    it('should cull strokes completely outside viewport', () => {
      const strokes = [
        createTestStroke('visible', {
          points: [100, 100, 200, 200],
          bbox: [100, 100, 200, 200],
        }),
        createTestStroke('offscreen', {
          points: [2000, 2000, 2100, 2100], // Move further away to ensure it's culled
          bbox: [2000, 2000, 2100, 2100],
        }),
      ];
      const snapshot = createTestSnapshot(strokes);

      drawStrokes(ctx, snapshot, viewTransform, viewport);

      // Should only render the visible stroke
      // Viewport with margin is [-50, -50, 850, 650], stroke at [2000, 2000] is definitely outside
      expect(ctx.stroke).toHaveBeenCalledTimes(1);
    });

    it('should render strokes partially in viewport', () => {
      const stroke = createTestStroke('partial', {
        points: [700, 500, 900, 700], // Extends beyond 800x600 viewport
        bbox: [700, 500, 900, 700],
      });
      const snapshot = createTestSnapshot([stroke]);

      drawStrokes(ctx, snapshot, viewTransform, viewport);

      // Should render partially visible stroke
      expect(ctx.stroke).toHaveBeenCalledTimes(1);
    });

    it('should account for stroke width in culling', () => {
      // Stroke just outside viewport but within stroke width
      const stroke = createTestStroke('edge', {
        points: [802, 100, 802, 200], // Just outside 800 width
        bbox: [802, 100, 802, 200],
        style: { color: '#000', size: 10, opacity: 1, tool: 'pen' }, // Width 10
      });
      const snapshot = createTestSnapshot([stroke]);

      drawStrokes(ctx, snapshot, viewTransform, viewport);

      // Should render because inflated bbox (halfWidth=5) makes it visible
      expect(ctx.stroke).toHaveBeenCalledTimes(1);
    });

    it('should use CSS pixels for viewport calculations', () => {
      // Test with different CSS and pixel dimensions
      const customViewport: ViewportInfo = {
        pixelWidth: 1600, // 2x DPR
        pixelHeight: 1200,
        cssWidth: 800, // CSS dimensions used for culling
        cssHeight: 600,
        dpr: 2,
      };

      const stroke = createTestStroke('css-test', {
        points: [750, 550, 850, 650], // Within CSS viewport, would be outside pixel viewport
        bbox: [750, 550, 850, 650],
      });
      const snapshot = createTestSnapshot([stroke]);

      drawStrokes(ctx, snapshot, viewTransform, customViewport);

      // Should render based on CSS dimensions
      expect(ctx.stroke).toHaveBeenCalledTimes(1);
    });
  });

  describe('LOD (Level of Detail)', () => {
    it('should skip tiny strokes at low zoom', () => {
      const tinyStroke = createTestStroke('tiny', {
        points: [100, 100, 100.5, 100.5], // 0.7px diagonal
        bbox: [100, 100, 100.5, 100.5],
      });
      const snapshot = createTestSnapshot([tinyStroke]);

      drawStrokes(ctx, snapshot, viewTransform, viewport);

      // Should skip stroke < 2px diagonal
      expect(ctx.stroke).not.toHaveBeenCalled();
    });

    it('should render tiny strokes when zoomed in', () => {
      const tinyStroke = createTestStroke('tiny', {
        points: [100, 100, 100.5, 100.5],
        bbox: [100, 100, 100.5, 100.5],
      });
      const snapshot = createTestSnapshot([tinyStroke]);

      // Zoom in 5x
      const zoomedTransform: ViewTransform = {
        scale: 5,
        pan: { x: 0, y: 0 },
        worldToCanvas: (x: number, y: number) => [x * 5, y * 5],
        canvasToWorld: (x: number, y: number) => [x / 5, y / 5],
      };

      drawStrokes(ctx, snapshot, zoomedTransform, viewport);

      // At 5x zoom, 0.7px becomes 3.5px, should render
      expect(ctx.stroke).toHaveBeenCalledTimes(1);
    });

    it('should apply LOD threshold correctly', () => {
      const strokes = [
        createTestStroke('tiny', {
          points: [100, 100, 101, 101], // 1.4px diagonal - below threshold
          bbox: [100, 100, 101, 101],
        }),
        createTestStroke('small', {
          points: [200, 200, 202, 202], // 2.8px diagonal - above threshold
          bbox: [200, 200, 202, 202],
        }),
        createTestStroke('normal', {
          points: [300, 300, 400, 400], // 141px diagonal - definitely visible
          bbox: [300, 300, 400, 400],
        }),
      ];
      const snapshot = createTestSnapshot(strokes);

      drawStrokes(ctx, snapshot, viewTransform, viewport);

      // Should skip tiny, render small and normal
      expect(ctx.stroke).toHaveBeenCalledTimes(2);
    });
  });

  describe('scene management', () => {
    it('should clear cache on scene change', () => {
      const stroke1 = createTestStroke('stroke-1');
      const snapshot1 = createTestSnapshot([stroke1], 0);

      drawStrokes(ctx, snapshot1, viewTransform, viewport);
      const initialSize = getStrokeCacheSize();
      expect(initialSize).toBe(1);

      // Change scene
      const stroke2 = createTestStroke('stroke-2');
      const snapshot2 = createTestSnapshot([stroke2], 1);

      drawStrokes(ctx, snapshot2, viewTransform, viewport);

      // Cache should be cleared and have only new stroke
      expect(getStrokeCacheSize()).toBe(1);
    });

    it('should not clear cache when scene stays the same', () => {
      const stroke1 = createTestStroke('stroke-1');
      const stroke2 = createTestStroke('stroke-2');

      const snapshot1 = createTestSnapshot([stroke1], 0);
      drawStrokes(ctx, snapshot1, viewTransform, viewport);
      expect(getStrokeCacheSize()).toBe(1);

      const snapshot2 = createTestSnapshot([stroke1, stroke2], 0); // Same scene
      drawStrokes(ctx, snapshot2, viewTransform, viewport);

      // Cache should accumulate
      expect(getStrokeCacheSize()).toBe(2);
    });

    it('should handle rapid scene changes', () => {
      for (let scene = 0; scene < 5; scene++) {
        const stroke = createTestStroke(`stroke-${scene}`);
        const snapshot = createTestSnapshot([stroke], scene);
        drawStrokes(ctx, snapshot, viewTransform, viewport);

        // Each scene change should clear cache
        expect(getStrokeCacheSize()).toBe(1);
      }
    });
  });

  describe('cache usage', () => {
    it('should reuse cached render data', () => {
      const stroke = createTestStroke('stroke-1');
      const snapshot = createTestSnapshot([stroke]);

      // First render - builds cache
      drawStrokes(ctx, snapshot, viewTransform, viewport);
      const firstStrokeCallCount = ctx.stroke.mock.calls.length;

      // Reset mock
      ctx.stroke.mockClear();

      // Second render - uses cache
      drawStrokes(ctx, snapshot, viewTransform, viewport);
      const secondStrokeCallCount = ctx.stroke.mock.calls.length;

      // Should still render but use cached path data
      expect(firstStrokeCallCount).toBe(secondStrokeCallCount);
      expect(getStrokeCacheSize()).toBe(1); // Cache unchanged
    });

    it('should build cache progressively', () => {
      const strokes = [
        createTestStroke('stroke-1'),
        createTestStroke('stroke-2'),
        createTestStroke('stroke-3'),
      ];

      // Render strokes one by one
      for (let i = 1; i <= strokes.length; i++) {
        const snapshot = createTestSnapshot(strokes.slice(0, i));
        drawStrokes(ctx, snapshot, viewTransform, viewport);
        expect(getStrokeCacheSize()).toBe(i);
      }
    });
  });

  describe('transform integration', () => {
    it('should cull strokes outside panned viewport', () => {
      const stroke = createTestStroke('stroke-1', {
        points: [100, 100, 200, 200],
        bbox: [100, 100, 200, 200],
      });
      const snapshot = createTestSnapshot([stroke]);

      // Pan view far away so stroke is definitely outside viewport
      const pannedTransform: ViewTransform = {
        scale: 1,
        pan: { x: 5000, y: 5000 }, // Pan very far away
        worldToCanvas: (x: number, y: number) => [x - 5000, y - 5000],
        canvasToWorld: (x: number, y: number) => [x + 5000, y + 5000],
      };

      // Test the actual culling calculation
      const [minX, minY] = pannedTransform.canvasToWorld(0, 0);
      const [maxX, maxY] = pannedTransform.canvasToWorld(viewport.cssWidth, viewport.cssHeight);
      const margin = 50;
      const _visibleBounds = {
        minX: minX - margin,
        minY: minY - margin,
        maxX: maxX + margin,
        maxY: maxY + margin,
      };

      drawStrokes(ctx, snapshot, pannedTransform, viewport);

      // When panned by [5000, 5000], viewport sees world [5000, 5000] to [5800, 5600]
      // With margin, approximately [4950, 4950, 5850, 5650]
      // Stroke at [100, 100, 200, 200] is definitely outside
      expect(ctx.stroke).not.toHaveBeenCalled();
    });

    it('should work with scaled view', () => {
      const stroke = createTestStroke('stroke-1', {
        points: [400, 300, 500, 400],
        bbox: [400, 300, 500, 400],
      });
      const snapshot = createTestSnapshot([stroke]);

      // Scale 0.5x (zoom out)
      const scaledTransform: ViewTransform = {
        scale: 0.5,
        pan: { x: 0, y: 0 },
        worldToCanvas: (x: number, y: number) => [x * 0.5, y * 0.5],
        canvasToWorld: (x: number, y: number) => [x * 2, y * 2],
      };

      drawStrokes(ctx, snapshot, scaledTransform, viewport);

      // At 0.5x scale, viewport sees world [0,0] to [1600,1200]
      // Stroke at [400,300] is visible
      expect(ctx.stroke).toHaveBeenCalledTimes(1);
    });

    it('should handle combined pan and scale', () => {
      const stroke = createTestStroke('stroke-1', {
        points: [100, 100, 200, 200],
        bbox: [100, 100, 200, 200],
      });
      const snapshot = createTestSnapshot([stroke]);

      // Scale 2x and pan
      const complexTransform: ViewTransform = {
        scale: 2,
        pan: { x: 50, y: 50 },
        worldToCanvas: (x: number, y: number) => [(x - 50) * 2, (y - 50) * 2],
        canvasToWorld: (x: number, y: number) => [x / 2 + 50, y / 2 + 50],
      };

      drawStrokes(ctx, snapshot, complexTransform, viewport);

      // Stroke [100,100] -> [(100-50)*2, (100-50)*2] = [100,100] in canvas
      // Should be visible
      expect(ctx.stroke).toHaveBeenCalledTimes(1);
    });
  });

  describe('edge cases', () => {
    it('should handle empty stroke array', () => {
      const snapshot = createTestSnapshot([]);

      expect(() => {
        drawStrokes(ctx, snapshot, viewTransform, viewport);
      }).not.toThrow();

      expect(ctx.stroke).not.toHaveBeenCalled();
    });

    it('should handle strokes with zero-area bounds', () => {
      const stroke = createTestStroke('zero-area', {
        points: [100, 100, 100, 100], // Same point twice
        bbox: [100, 100, 100, 100], // Zero area
      });
      const snapshot = createTestSnapshot([stroke]);

      expect(() => {
        drawStrokes(ctx, snapshot, viewTransform, viewport);
      }).not.toThrow();

      // Stroke with zero diagonal (0px) is culled by LOD check (< 2px threshold)
      expect(ctx.stroke).not.toHaveBeenCalled();
    });

    it('should handle very large strokes', () => {
      const largeStroke = createTestStroke('large', {
        points: [-10000, -10000, 10000, 10000],
        bbox: [-10000, -10000, 10000, 10000],
      });
      const snapshot = createTestSnapshot([largeStroke]);

      drawStrokes(ctx, snapshot, viewTransform, viewport);

      // Should render (partially visible)
      expect(ctx.stroke).toHaveBeenCalledTimes(1);
    });

    it('should handle strokes with many points', () => {
      // Create stroke with 100 points
      const manyPoints: number[] = [];
      for (let i = 0; i < 100; i++) {
        manyPoints.push(i * 5, i * 5);
      }

      const complexStroke = createTestStroke('complex', {
        points: manyPoints,
        bbox: [0, 0, 495, 495],
      });
      const snapshot = createTestSnapshot([complexStroke]);

      drawStrokes(ctx, snapshot, viewTransform, viewport);

      expect(ctx.stroke).toHaveBeenCalledTimes(1);
      expect(ctx.moveTo).toHaveBeenCalledWith(0, 0);
      // Should have many lineTo calls
      expect(ctx.lineTo.mock.calls.length).toBeGreaterThan(50);
    });
  });
});
