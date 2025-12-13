import { useCameraStore, worldToCanvas } from '@/stores/camera-store';
import { setCursorOverride } from '@/canvas/cursor-manager';
import { invalidateOverlay } from '@/canvas/invalidation-helpers';
import type { PointerTool, PreviewData } from './types';

/**
 * PanTool - Viewport panning tool
 *
 * Implements PointerTool interface using world coordinates.
 * Internally converts to screen space for delta calculation.
 *
 * Key insight: worldToCanvas(screenToWorld(S)) = S always!
 * Even when pan changes mid-gesture, converting world→screen
 * gives the correct screen position for delta calculation.
 *
 * Trace through:
 * Frame 1: Screen (100,100), pan=(0,0)
 *   → World (100,100)
 *   → Store lastScreen = worldToCanvas(100,100) = (100,100)
 *
 * Frame 2: Drag to screen (110,100), pan=(0,0)
 *   → World (110,100)
 *   → currentScreen = worldToCanvas(110,100) = (110,100)
 *   → dx = 10, apply pan → pan=(-10,0)
 *
 * Frame 3: Pointer still at screen (110,100), pan=(-10,0)
 *   → World = screenToWorld(110,100) = (100,100)  // Changed!
 *   → currentScreen = worldToCanvas(100,100) = (110,100)  // Same screen pos!
 *   → dx = 0 ✓
 *
 * Zero-arg constructor: reads all dependencies from module-level singletons.
 * - Camera state: useCameraStore.getState()
 * - Cursor: cursor-manager.ts
 * - Invalidation: invalidation-helpers.ts
 */
export class PanTool implements PointerTool {
  private pointerId: number | null = null;
  private lastScreen: [number, number] | null = null;

  constructor() {}

  canBegin(): boolean {
    return this.pointerId === null;
  }

  begin(pointerId: number, worldX: number, worldY: number): void {
    this.pointerId = pointerId;
    // Convert world to screen and store
    this.lastScreen = worldToCanvas(worldX, worldY);
    setCursorOverride('grabbing');
    invalidateOverlay();
  }

  move(worldX: number, worldY: number): void {
    if (!this.lastScreen) return;

    // Convert world to screen for accurate delta
    const currentScreen = worldToCanvas(worldX, worldY);

    const dx = currentScreen[0] - this.lastScreen[0];
    const dy = currentScreen[1] - this.lastScreen[1];
    this.lastScreen = currentScreen;

    const { scale, pan, setPan } = useCameraStore.getState();
    setPan({
      x: pan.x - dx / scale,
      y: pan.y - dy / scale,
    });
    invalidateOverlay();
  }

  end(_worldX?: number, _worldY?: number): void {
    this.pointerId = null;
    this.lastScreen = null;
    setCursorOverride(null);
    invalidateOverlay();
  }

  cancel(): void {
    this.end();
  }

  isActive(): boolean {
    return this.pointerId !== null;
  }

  getPointerId(): number | null {
    return this.pointerId;
  }

  getPreview(): PreviewData | null {
    return null; // Pan tool has no preview
  }

  onPointerLeave(): void {
    // PanTool has no hover state to clear
  }

  onViewChange(): void {
    // PanTool doesn't need to reposition on view change
    // (it's driving the view change!)
  }

  destroy(): void {
    this.cancel();
  }
}
