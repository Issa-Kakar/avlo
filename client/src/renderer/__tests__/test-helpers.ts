// @ts-nocheck - Tests are disabled during rapid refactor phase
import { vi } from 'vitest';
import type { Snapshot, ViewTransform } from '@avlo/shared';
import { createEmptySnapshot } from '@avlo/shared';

/**
 * Mock Canvas Context for render testing
 * Focused on the methods actually used by RenderLoop
 */
export function createMockContext(): CanvasRenderingContext2D {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    translate: vi.fn(),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    canvas: {
      width: 800,
      height: 600,
    } as HTMLCanvasElement,
  } as any;
}

/**
 * Mock CanvasStageHandle for testing
 */
export function createMockStage(ctx: CanvasRenderingContext2D): any {
  return {
    withContext: vi.fn((callback) => callback(ctx)),
    getBounds: vi.fn(() => ({ width: 800, height: 600, x: 0, y: 0 })),
  };
}

/**
 * Test frame scheduler for deterministic frame control
 */
export class TestFrameScheduler {
  private callbacks: Array<() => void> = [];
  private nextId = 1;

  requestAnimationFrame(callback: () => void): number {
    const id = this.nextId++;
    this.callbacks.push(callback);
    return id;
  }

  cancelAnimationFrame(_id: number): void {
    // Simple implementation - clear all on next tick
  }

  tick(): void {
    const cbs = [...this.callbacks];
    this.callbacks = [];
    cbs.forEach((cb) => cb());
  }

  hasScheduledFrames(): boolean {
    return this.callbacks.length > 0;
  }
}

/**
 * Simple test ViewTransform
 */
export function createTestViewTransform(scale = 1, panX = 0, panY = 0): ViewTransform {
  return {
    scale,
    pan: { x: panX, y: panY },
    worldToCanvas: (worldX: number, worldY: number) => [
      (worldX - panX) * scale,
      (worldY - panY) * scale,
    ],
    canvasToWorld: (canvasX: number, canvasY: number) => [
      canvasX / scale + panX,
      canvasY / scale + panY,
    ],
  };
}
