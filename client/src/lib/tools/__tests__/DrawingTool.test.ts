import { describe, it, expect, afterEach } from 'vitest';
import { DrawingTool } from '../DrawingTool';
import type { DeviceUIState } from '../types';
import { createTestManager, waitForSnapshot, mockNavigator, resetNavigator, USER_AGENTS } from '../../__tests__/test-helpers';
import { STROKE_CONFIG } from '@avlo/shared';
import type * as Y from 'yjs';

describe('DrawingTool integration tests', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    resetNavigator();
  });

  describe('state management', () => {
    it('should start and commit a basic stroke', () => {
      const { manager, frames, cleanup: testCleanup } = createTestManager('test-room');
      cleanup = testCleanup;
      
      const deviceUI: DeviceUIState = {
        tool: 'pen',
        color: '#FF0000',
        size: 4,
        opacity: 1
      };
      
      const tool = new DrawingTool(manager, deviceUI, 'test-user', undefined);
      
      // Verify initial state
      expect(tool.isDrawing()).toBe(false);
      expect(tool.canStartDrawing()).toBe(true);
      expect(tool.getPointerId()).toBeNull();
      
      // Start drawing
      tool.startDrawing(1, 100, 100);
      expect(tool.isDrawing()).toBe(true);
      expect(tool.getPointerId()).toBe(1);
      expect(tool.canStartDrawing()).toBe(false);
      
      // Add points
      tool.addPoint(150, 150);
      tool.addPoint(200, 200);
      
      // Commit stroke
      tool.commitStroke(250, 250);
      expect(tool.isDrawing()).toBe(false);
      expect(tool.getPointerId()).toBeNull();
      
      // Advance frame to publish snapshot
      frames.advanceFrame(0);
      
      // Verify stroke was added to Y.Doc through snapshot
      const snapshot = manager.currentSnapshot;
      expect(snapshot.strokes).toHaveLength(1);
      
      const stroke = snapshot.strokes[0];
      expect(stroke.style.tool).toBe('pen');
      expect(stroke.style.color).toBe('#FF0000');
      expect(stroke.style.size).toBe(4);
      expect(stroke.style.opacity).toBe(1);
      expect(stroke.userId).toBe('test-user');
      expect(stroke.scene).toBe(0); // First scene
      
      // Points should be simplified (start and end at minimum)
      expect(stroke.points.length).toBeGreaterThanOrEqual(4);
      expect(stroke.bbox).toBeTruthy();
      
      tool.destroy();
    });

    it('should freeze tool settings at gesture start', () => {
      const { manager, frames, cleanup: testCleanup } = createTestManager('test-room');
      cleanup = testCleanup;
      
      const deviceUI: DeviceUIState = {
        tool: 'pen',
        color: '#FF0000',
        size: 4,
        opacity: 1
      };
      
      const tool = new DrawingTool(manager, deviceUI, 'test-user', undefined);
      
      // Start drawing with red pen
      tool.startDrawing(1, 0, 0);
      
      // Change device UI (simulating user changing tool mid-gesture)
      deviceUI.color = '#0000FF';
      deviceUI.size = 10;
      deviceUI.tool = 'highlighter';
      
      // Continue drawing and commit
      tool.addPoint(100, 100);
      tool.commitStroke(200, 200);
      
      frames.advanceFrame(0);
      
      // Stroke should have original settings (frozen at start)
      const stroke = manager.currentSnapshot.strokes[0];
      expect(stroke.style.tool).toBe('pen');
      expect(stroke.style.color).toBe('#FF0000');
      expect(stroke.style.size).toBe(4);
      
      tool.destroy();
    });

    it('should handle highlighter opacity correctly', () => {
      const { manager, frames, cleanup: testCleanup } = createTestManager('test-room');
      cleanup = testCleanup;
      
      const deviceUI: DeviceUIState = {
        tool: 'highlighter',
        color: '#FFFF00',
        size: 20,
        opacity: 0.8 // This should be overridden
      };
      
      const tool = new DrawingTool(manager, deviceUI, 'test-user', undefined);
      
      tool.startDrawing(1, 0, 0);
      tool.commitStroke(100, 100);
      
      frames.advanceFrame(0);
      
      const stroke = manager.currentSnapshot.strokes[0];
      expect(stroke.style.tool).toBe('highlighter');
      // Highlighter should use default opacity from config
      expect(stroke.style.opacity).toBe(STROKE_CONFIG.HIGHLIGHTER_DEFAULT_OPACITY);
      
      tool.destroy();
    });

    it('should cancel drawing properly', () => {
      const { manager, cleanup: testCleanup } = createTestManager('test-room');
      cleanup = testCleanup;
      
      const deviceUI: DeviceUIState = {
        tool: 'pen',
        color: '#000000',
        size: 4,
        opacity: 1
      };
      
      const tool = new DrawingTool(manager, deviceUI, 'test-user', undefined);
      
      tool.startDrawing(1, 0, 0);
      tool.addPoint(100, 100);
      
      expect(tool.isDrawing()).toBe(true);
      
      tool.cancelDrawing();
      
      expect(tool.isDrawing()).toBe(false);
      expect(tool.getPointerId()).toBeNull();
      
      // No stroke should be committed
      expect(manager.currentSnapshot.strokes).toHaveLength(0);
      
      tool.destroy();
    });
  });

  describe('commit validation', () => {
    it('should reject strokes with too few points', () => {
      const { manager, frames, cleanup: testCleanup } = createTestManager('test-room');
      cleanup = testCleanup;
      
      const deviceUI: DeviceUIState = {
        tool: 'pen',
        color: '#000000',
        size: 4,
        opacity: 1
      };
      
      const tool = new DrawingTool(manager, deviceUI, 'test-user', undefined);
      
      // Single point (click without move)
      tool.startDrawing(1, 100, 100);
      tool.commitStroke(100, 100);
      
      frames.advanceFrame(0);
      
      // Should not create a stroke
      expect(manager.currentSnapshot.strokes).toHaveLength(0);
      
      tool.destroy();
    });

    it('should handle scene assignment correctly', () => {
      const { manager, frames, cleanup: testCleanup } = createTestManager('test-room');
      cleanup = testCleanup;
      
      const deviceUI: DeviceUIState = {
        tool: 'pen',
        color: '#000000',
        size: 4,
        opacity: 1
      };
      
      // Add a scene tick to simulate scene progression
      manager.mutate((ydoc) => {
        const meta = ydoc.getMap('root').get('meta') as Y.Map<any>;
        const sceneTicks = meta.get('scene_ticks') as Y.Array<number>;
        sceneTicks.push([Date.now()]);
      });
      
      frames.advanceFrame(0);
      
      const tool = new DrawingTool(manager, deviceUI, 'test-user', undefined);
      
      // Draw stroke - should be assigned scene 1 (after the tick we added)
      tool.startDrawing(1, 0, 0);
      tool.commitStroke(100, 100);
      
      frames.advanceFrame(0);
      
      const stroke = manager.currentSnapshot.strokes[0];
      expect(stroke.scene).toBe(1); // Second scene (0-indexed)
      
      tool.destroy();
    });

    it('should enforce budget limits on large strokes', () => {
      const { manager, frames, cleanup: testCleanup } = createTestManager('test-room');
      cleanup = testCleanup;
      
      const deviceUI: DeviceUIState = {
        tool: 'pen',
        color: '#000000',
        size: 4,
        opacity: 1
      };
      
      const tool = new DrawingTool(manager, deviceUI, 'test-user', undefined);
      
      // Create a massive stroke
      tool.startDrawing(1, 0, 0);
      
      // Add many points to exceed budget
      for (let i = 0; i < 15000; i++) {
        tool.addPoint(i, Math.sin(i * 0.1) * 100);
      }
      
      tool.commitStroke(15000, 0);
      
      frames.advanceFrame(0);
      
      // Should either simplify successfully or reject
      const strokes = manager.currentSnapshot.strokes;
      
      if (strokes.length > 0) {
        // Stroke was simplified and committed
        const stroke = strokes[0];
        expect(stroke.points.length / 2).toBeLessThanOrEqual(STROKE_CONFIG.MAX_POINTS_PER_STROKE);
      } else {
        // Stroke was rejected for being too complex
        expect(strokes).toHaveLength(0);
      }
      
      tool.destroy();
    });
  });

  describe('preview data', () => {
    it('should provide preview data during drawing', () => {
      const { manager, cleanup: testCleanup } = createTestManager('test-room');
      cleanup = testCleanup;
      
      const deviceUI: DeviceUIState = {
        tool: 'pen',
        color: '#FF0000',
        size: 8,
        opacity: 1
      };
      
      const tool = new DrawingTool(manager, deviceUI, 'test-user', undefined);
      
      // No preview initially
      expect(tool.getPreview()).toBeNull();
      
      // Start drawing - should have preview immediately
      tool.startDrawing(1, 10, 10);
      
      const preview = tool.getPreview();
      expect(preview).toBeTruthy();
      expect(preview?.tool).toBe('pen');
      expect(preview?.color).toBe('#FF0000');
      expect(preview?.size).toBe(8);
      expect(preview?.opacity).toBe(STROKE_CONFIG.CURSOR_PREVIEW_OPACITY); // 0.35
      
      // After commit, no preview
      tool.commitStroke(30, 30);
      expect(tool.getPreview()).toBeNull();
      
      tool.destroy();
    });
  });

  describe('invalidation callbacks', () => {
    it('should call invalidation callback with correct bounds', () => {
      const { manager, cleanup: testCleanup } = createTestManager('test-room');
      cleanup = testCleanup;
      
      const deviceUI: DeviceUIState = {
        tool: 'pen',
        color: '#000000',
        size: 10,
        opacity: 1
      };
      
      const invalidations: Array<[number, number, number, number]> = [];
      
      const tool = new DrawingTool(
        manager,
        deviceUI,
        'test-user',
        (bounds) => {
          invalidations.push(bounds);
        }
      );
      
      tool.startDrawing(1, 50, 50);
      tool.addPoint(100, 100);
      tool.addPoint(150, 150);
      tool.commitStroke(200, 200);
      
      // Should have received invalidations
      expect(invalidations.length).toBeGreaterThan(0);
      
      // Last invalidation should cover the stroke area
      const lastBounds = invalidations[invalidations.length - 1];
      expect(lastBounds).toBeTruthy();
      
      // Bounds should include padding for stroke width
      const padding = 10 * 0.5 + 1; // size * 0.5 + 1
      expect(lastBounds[0]).toBeLessThanOrEqual(50 - padding);
      expect(lastBounds[1]).toBeLessThanOrEqual(50 - padding);
      expect(lastBounds[2]).toBeGreaterThanOrEqual(200 + padding);
      expect(lastBounds[3]).toBeGreaterThanOrEqual(200 + padding);
      
      tool.destroy();
    });

    it('should invalidate both preview and final bounds on commit', () => {
      const { manager, cleanup: testCleanup } = createTestManager('test-room');
      cleanup = testCleanup;
      
      const deviceUI: DeviceUIState = {
        tool: 'pen',
        color: '#000000',
        size: 4,
        opacity: 1
      };
      
      const invalidations: Array<[number, number, number, number]> = [];
      
      const tool = new DrawingTool(
        manager,
        deviceUI,
        'test-user',
        (bounds) => {
          invalidations.push(bounds);
        }
      );
      
      // Draw a complex stroke that will be simplified
      tool.startDrawing(1, 0, 0);
      for (let i = 1; i <= 100; i++) {
        tool.addPoint(i, 0); // Horizontal line
      }
      
      const preCommitInvalidations = invalidations.length;
      
      tool.commitStroke(100, 0);
      
      // Should have additional invalidations after commit
      expect(invalidations.length).toBeGreaterThan(preCommitInvalidations);
      
      // Should include invalidation for clearing preview and drawing final stroke
      const finalInvalidations = invalidations.slice(preCommitInvalidations);
      expect(finalInvalidations.length).toBeGreaterThanOrEqual(1);
      
      tool.destroy();
    });
  });

  describe('mobile view-only enforcement', () => {
    it('should block mutations on mobile devices', () => {
      mockNavigator(USER_AGENTS.MOBILE_IOS);
      
      const { manager, frames, cleanup: testCleanup } = createTestManager('test-room');
      cleanup = testCleanup;
      
      const deviceUI: DeviceUIState = {
        tool: 'pen',
        color: '#000000',
        size: 4,
        opacity: 1
      };
      
      const tool = new DrawingTool(manager, deviceUI, 'test-user', undefined);
      
      // Try to draw
      tool.startDrawing(1, 0, 0);
      tool.commitStroke(100, 100);
      
      frames.advanceFrame(0);
      
      // Should be blocked by mobile guard in mutate()
      expect(manager.currentSnapshot.strokes).toHaveLength(0);
      
      tool.destroy();
    });

    it('should work on desktop after mobile test', () => {
      resetNavigator(); // Ensure desktop environment
      
      const { manager, frames, cleanup: testCleanup } = createTestManager('test-room');
      cleanup = testCleanup;
      
      const deviceUI: DeviceUIState = {
        tool: 'pen',
        color: '#000000',
        size: 4,
        opacity: 1
      };
      
      const tool = new DrawingTool(manager, deviceUI, 'test-user', undefined);
      
      tool.startDrawing(1, 0, 0);
      tool.commitStroke(100, 100);
      
      frames.advanceFrame(0);
      
      // Should work on desktop
      expect(manager.currentSnapshot.strokes).toHaveLength(1);
      
      tool.destroy();
    });
  });

  describe('error handling', () => {
    it('should handle missing scene_ticks gracefully', () => {
      const { manager, cleanup: testCleanup } = createTestManager('test-room');
      cleanup = testCleanup;
      
      // Break scene_ticks to simulate Phase 2 implementation issue
      manager.mutate((ydoc) => {
        const meta = ydoc.getMap('root').get('meta') as Y.Map<any>;
        meta.delete('scene_ticks');
      });
      
      const deviceUI: DeviceUIState = {
        tool: 'pen',
        color: '#000000',
        size: 4,
        opacity: 1
      };
      
      const tool = new DrawingTool(manager, deviceUI, 'test-user', undefined);
      
      // Try to draw
      tool.startDrawing(1, 0, 0);
      tool.commitStroke(100, 100);
      
      // Should log error but not crash
      expect(manager.currentSnapshot.strokes).toHaveLength(0);
      
      tool.destroy();
    });

    it('should handle destroy during drawing', () => {
      const { manager, cleanup: testCleanup } = createTestManager('test-room');
      cleanup = testCleanup;
      
      const deviceUI: DeviceUIState = {
        tool: 'pen',
        color: '#000000',
        size: 4,
        opacity: 1
      };
      
      const tool = new DrawingTool(manager, deviceUI, 'test-user', undefined);
      
      tool.startDrawing(1, 0, 0);
      tool.addPoint(100, 100);
      
      expect(tool.isDrawing()).toBe(true);
      
      // Destroy while drawing
      tool.destroy();
      
      expect(tool.isDrawing()).toBe(false);
      expect(manager.currentSnapshot.strokes).toHaveLength(0);
    });
  });
});