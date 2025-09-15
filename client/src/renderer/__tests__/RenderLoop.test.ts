import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { RenderLoop } from '../RenderLoop';
import { createEmptySnapshot } from '@avlo/shared';
import {
  createMockContext,
  createMockStage,
  TestFrameScheduler,
  createTestViewTransform,
} from './test-helpers';

describe('RenderLoop', () => {
  let renderLoop: RenderLoop;
  let frameScheduler: TestFrameScheduler;
  let mockCtx: CanvasRenderingContext2D;
  let mockStage: any;

  // Mock window.matchMedia for presence-cursors.ts
  beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  const defaultConfig = () => ({
    stageRef: { current: mockStage },
    getView: () => createTestViewTransform(1, 0, 0),
    getSnapshot: () => createEmptySnapshot(),
    getViewport: () => ({
      pixelWidth: 800,
      pixelHeight: 600,
      cssWidth: 800,
      cssHeight: 600,
      dpr: 1,
    }),
    getGates: () => ({
      idbReady: true,
      wsConnected: true,
      wsSynced: true,
      awarenessReady: true,
      firstSnapshot: true,
    }),
  });

  beforeEach(() => {
    vi.useFakeTimers();

    // Setup mocks
    frameScheduler = new TestFrameScheduler();
    mockCtx = createMockContext();
    mockStage = createMockStage(mockCtx);

    // Mock requestAnimationFrame with test scheduler
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) =>
      frameScheduler.requestAnimationFrame(() => (cb as any)(0)),
    );
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    renderLoop = new RenderLoop();
  });

  afterEach(() => {
    renderLoop.destroy();
    vi.clearAllTimers();
    vi.restoreAllMocks();
  });

  describe('event-driven behavior', () => {
    it('should NOT render any frames when idle (no invalidation)', () => {
      renderLoop.start(defaultConfig());

      // Tick multiple times without invalidation
      frameScheduler.tick();
      frameScheduler.tick();
      frameScheduler.tick();

      // Should never have called render methods
      expect(mockCtx.clearRect).not.toHaveBeenCalled();
      expect(mockCtx.scale).not.toHaveBeenCalled();
      expect(mockCtx.translate).not.toHaveBeenCalled();
    });

    it('should render exactly one frame per invalidation', () => {
      renderLoop.start(defaultConfig());

      // Invalidate once
      renderLoop.invalidateAll('content-change');

      // Process the scheduled frame
      frameScheduler.tick();

      // Should have rendered once
      expect(mockCtx.clearRect).toHaveBeenCalledTimes(1);

      // Tick again - should not render
      frameScheduler.tick();
      expect(mockCtx.clearRect).toHaveBeenCalledTimes(1);
    });

    it('should coalesce multiple invalidations into one frame', () => {
      renderLoop.start(defaultConfig());

      // Multiple invalidations before frame
      renderLoop.invalidateAll('content-change');
      renderLoop.invalidateCanvas({ x: 10, y: 10, width: 50, height: 50 });
      renderLoop.invalidateWorld({ minX: 0, minY: 0, maxX: 100, maxY: 100 });

      // Process the frame
      frameScheduler.tick();

      // Should have rendered only once
      expect(mockCtx.clearRect).toHaveBeenCalledTimes(1);
    });

    it('should schedule frame immediately on invalidation', () => {
      renderLoop.start(defaultConfig());

      expect(frameScheduler.hasScheduledFrames()).toBe(false);

      renderLoop.invalidateAll('content-change');

      expect(frameScheduler.hasScheduledFrames()).toBe(true);
    });
  });

  describe('transform handling', () => {
    it('should trigger full clear when scale changes', () => {
      let currentScale = 1;
      const config = {
        ...defaultConfig(),
        getView: () => createTestViewTransform(currentScale, 0, 0),
      };

      renderLoop.start(config);

      // First frame
      renderLoop.invalidateCanvas({ x: 10, y: 10, width: 50, height: 50 });
      frameScheduler.tick();

      // Change scale and render again
      currentScale = 2;
      renderLoop.invalidateCanvas({ x: 20, y: 20, width: 30, height: 30 });
      frameScheduler.tick();

      // Should have done full clear (entire canvas)
      const clearCalls = (mockCtx.clearRect as any).mock.calls;
      const lastClear = clearCalls[clearCalls.length - 1];
      expect(lastClear).toEqual([0, 0, 800, 600]);
    });

    it('should trigger full clear when pan changes', () => {
      let currentPan = { x: 0, y: 0 };
      const config = {
        ...defaultConfig(),
        getView: () => createTestViewTransform(1, currentPan.x, currentPan.y),
      };

      renderLoop.start(config);

      // First frame
      renderLoop.invalidateCanvas({ x: 10, y: 10, width: 50, height: 50 });
      frameScheduler.tick();

      // Change pan
      currentPan = { x: 100, y: 50 };
      renderLoop.invalidateCanvas({ x: 20, y: 20, width: 30, height: 30 });
      frameScheduler.tick();

      // Should have done full clear
      const clearCalls = (mockCtx.clearRect as any).mock.calls;
      const lastClear = clearCalls[clearCalls.length - 1];
      expect(lastClear).toEqual([0, 0, 800, 600]);
    });
  });

  describe('transform application', () => {
    it('should use identity transform for clearing', () => {
      const config = {
        ...defaultConfig(),
        getView: () => createTestViewTransform(2, 100, 100),
      };

      renderLoop.start(config);
      renderLoop.invalidateAll('content-change');
      frameScheduler.tick();

      // Should set identity transform before clear
      expect(mockCtx.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);

      // Clear should happen after identity transform
      const setTransformIndex = (mockCtx.setTransform as any).mock.calls.findIndex(
        (call: any[]) => call[0] === 1 && call[1] === 0,
      );
      const clearRectIndex = (mockCtx.clearRect as any).mock.calls.length > 0 ? 0 : -1;

      expect(setTransformIndex).toBeGreaterThanOrEqual(0);
      expect(clearRectIndex).toBeGreaterThanOrEqual(0);
    });

    it('should apply scale before translate for world transform', () => {
      const config = {
        ...defaultConfig(),
        getView: () => createTestViewTransform(2, 10, 20),
      };

      renderLoop.start(config);
      renderLoop.invalidateAll('content-change');
      frameScheduler.tick();

      // Verify transform order
      expect(mockCtx.scale).toHaveBeenCalledWith(2, 2);
      expect(mockCtx.translate).toHaveBeenCalledWith(-10, -20);

      // Find the order index of scale and translate calls
      // We need to check the order of ALL calls, not just the count
      const allCalls: Array<{ method: string; index: number }> = [];

      (mockCtx.scale as any).mock.calls.forEach((_: any, i: number) => {
        allCalls.push({
          method: 'scale',
          index: (mockCtx.scale as any).mock.invocationCallOrder[i],
        });
      });

      (mockCtx.translate as any).mock.calls.forEach((_: any, i: number) => {
        allCalls.push({
          method: 'translate',
          index: (mockCtx.translate as any).mock.invocationCallOrder[i],
        });
      });

      // Sort by invocation order
      allCalls.sort((a, b) => a.index - b.index);

      // Find the last scale and translate calls (in the draw pass)
      const lastScale = allCalls.filter((c) => c.method === 'scale').pop();
      const lastTranslate = allCalls.filter((c) => c.method === 'translate').pop();

      // Scale should come before translate
      expect(lastScale).toBeDefined();
      expect(lastTranslate).toBeDefined();
      expect(lastScale!.index).toBeLessThan(lastTranslate!.index);
    });
  });

  describe('lifecycle', () => {
    it('should start and stop cleanly', () => {
      const config = defaultConfig();

      renderLoop.start(config);
      expect(() => renderLoop.stop()).not.toThrow();

      // Should be able to start again
      expect(() => renderLoop.start(config)).not.toThrow();
    });

    it('should not render after stop', () => {
      renderLoop.start(defaultConfig());
      renderLoop.invalidateAll('content-change');
      renderLoop.stop();

      frameScheduler.tick();

      // Should not have rendered
      expect(mockCtx.clearRect).not.toHaveBeenCalled();
    });

    it('should warn if started twice without stopping', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      renderLoop.start(defaultConfig());
      renderLoop.start(defaultConfig());

      expect(warnSpy).toHaveBeenCalledWith('RenderLoop already started');

      warnSpy.mockRestore();
    });

    it('should clean up event listeners on destroy', () => {
      const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');

      renderLoop.destroy();

      expect(removeEventListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    });
  });

  describe('resize handling', () => {
    it('should force full clear on resize', () => {
      const config = defaultConfig();
      renderLoop.start(config);

      // Update the mock viewport to return new dimensions after resize
      const newViewport = {
        pixelWidth: 1024,
        pixelHeight: 768,
        cssWidth: 512,
        cssHeight: 384,
        dpr: 2,
      };

      // Update config to return new viewport
      config.getViewport = () => newViewport;

      // Notify of resize
      renderLoop.setResizeInfo({ width: 1024, height: 768, dpr: 2 });
      frameScheduler.tick();

      // Should have done full clear with new dimensions
      expect(mockCtx.clearRect).toHaveBeenCalledWith(0, 0, 1024, 768);
    });
  });

  describe('frame stats', () => {
    it('should track frame statistics', () => {
      let capturedStats: any = null;
      const config = {
        ...defaultConfig(),
        onStats: (stats: any) => {
          capturedStats = stats;
        },
      };

      renderLoop.start(config);
      renderLoop.invalidateAll('content-change');
      frameScheduler.tick();

      expect(capturedStats).toBeTruthy();
      expect(capturedStats.frameCount).toBe(1);
      expect(capturedStats.lastClearType).toBe('full');
    });
  });

  describe('no-op optimization', () => {
    it('should skip rendering when nothing is dirty', () => {
      renderLoop.start(defaultConfig());

      // First frame to establish baseline
      renderLoop.invalidateAll('content-change');
      frameScheduler.tick();
      const initialClearCount = (mockCtx.clearRect as any).mock.calls.length;

      // Try to render without new invalidation
      frameScheduler.tick();
      frameScheduler.tick();

      // Should not have cleared again
      expect((mockCtx.clearRect as any).mock.calls.length).toBe(initialClearCount);
    });
  });

  describe('dirty rect invalidation', () => {
    it('should handle canvas pixel invalidation', () => {
      renderLoop.start(defaultConfig());

      renderLoop.invalidateCanvas({ x: 10, y: 10, width: 100, height: 100 });
      frameScheduler.tick();

      // Should have rendered
      expect(mockCtx.clearRect).toHaveBeenCalled();
    });

    it('should handle world bounds invalidation', () => {
      renderLoop.start(defaultConfig());

      renderLoop.invalidateWorld({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
      frameScheduler.tick();

      // Should have rendered
      expect(mockCtx.clearRect).toHaveBeenCalled();
    });
  });
});
