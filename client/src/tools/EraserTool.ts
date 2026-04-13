import { strokeHitTest, circleRectIntersect, circleHitsShape } from '@/core/geometry/hit-primitives';
import { frameOf } from '@/core/geometry/frame-of';
import { useCameraStore, worldToCanvas } from '@/stores/camera-store';
import { getSpatialIndex, getHandle, transact, getObjects, getConnectorsForShape } from '@/runtime/room-runtime';
import { invalidateOverlay } from '@/renderer/OverlayRenderLoop';
import { getAnimationController } from '@/renderer/animation/AnimationController';
import type { EraserTrailAnimation } from '@/renderer/animation/EraserTrailAnimation';
import { getFrame, getPoints, getWidth, getShapeType, getFillColor, getStartAnchor, getEndAnchor } from '@/core/accessors';
import type { PointerTool } from './types';

// Fixed radius configuration
const ERASER_RADIUS_PX = 10; // Fixed screen-space radius
const ERASER_SLACK_PX = 2.0; // Forgiving feel - don't require precise alignment

interface EraserState {
  isErasing: boolean;
  pointerId: number | null;
  lastWorld: [number, number] | null;
  hitNow: Set<string>; // Objects currently under cursor
  hitAccum: Set<string>; // Objects accumulated during drag
}

/**
 * EraserTool - Geometry-aware object deletion.
 *
 * PHASE 1.5 REFACTOR: Zero-arg constructor pattern.
 * All dependencies are read at runtime from module-level singletons:
 * - getActiveRoomDoc() for Y.Doc access (snapshot reading and mutations)
 * - useCameraStore.getState() for scale (eraser radius conversion)
 * - invalidateOverlay() for render loop updates
 *
 * This allows the tool to be constructed once as a singleton and reused
 * across tool switches without React lifecycle involvement.
 */
export class EraserTool implements PointerTool {
  private state!: EraserState;

  /**
   * Zero-arg constructor. All dependencies are read at runtime.
   * Can be constructed once and reused across gestures and tool switches.
   */
  constructor() {
    this.resetState();
  }

  private resetState(): void {
    this.state = {
      isErasing: false,
      pointerId: null,
      lastWorld: null,
      hitNow: new Set(),
      hitAccum: new Set(),
    };
  }

  canBegin(): boolean {
    return !this.state.isErasing;
  }

  begin(pointerId: number, worldX: number, worldY: number): void {
    if (this.state.isErasing) return;

    this.state.isErasing = true;
    this.state.pointerId = pointerId;
    this.state.lastWorld = [worldX, worldY];
    this.state.hitNow.clear();
    this.state.hitAccum.clear();

    // Start eraser trail animation
    const trailAnim = getAnimationController().get<EraserTrailAnimation>('eraser-trail');
    if (trailAnim) {
      trailAnim.start();
      const [screenX, screenY] = worldToCanvas(worldX, worldY);
      trailAnim.addPoint(screenX, screenY, performance.now());
    }

    this.updateHitTest(worldX, worldY);
    invalidateOverlay();
  }

  move(worldX: number, worldY: number): void {
    this.state.lastWorld = [worldX, worldY];

    // Update trail animation and hit-test when actively erasing
    if (this.state.isErasing) {
      const trailAnim = getAnimationController().get<EraserTrailAnimation>('eraser-trail');
      if (trailAnim) {
        const [screenX, screenY] = worldToCanvas(worldX, worldY);
        trailAnim.addPoint(screenX, screenY, performance.now());
      }
      this.updateHitTest(worldX, worldY);
    }
    invalidateOverlay();
  }

  end(_worldX?: number, _worldY?: number): void {
    if (!this.state.isErasing) return;
    this.commitErase();
  }

  cancel(): void {
    // Stop trail animation (it will decay naturally)
    const trailAnim = getAnimationController().get<EraserTrailAnimation>('eraser-trail');
    trailAnim?.stop();

    this.resetState();
    invalidateOverlay();
  }

  isActive(): boolean {
    return this.state.isErasing;
  }

  getPointerId(): number | null {
    return this.state.pointerId;
  }

  destroy(): void {
    this.resetState();
    invalidateOverlay();
  }

  onPointerLeave(): void {
    // Clear cursor state when pointer leaves canvas
    if (!this.state.isErasing) {
      this.state.lastWorld = null;
      invalidateOverlay();
    }
  }

  onViewChange(): void {
    // Re-compute hits if actively erasing and view changes
    if (this.state.isErasing && this.state.lastWorld) {
      this.updateHitTest(this.state.lastWorld[0], this.state.lastWorld[1]);
    }
  }

  private updateHitTest(worldX: number, worldY: number): void {
    const { scale } = useCameraStore.getState();

    // Convert fixed screen radius to world units (with slack for forgiving feel)
    const radiusWorld = (ERASER_RADIUS_PX + ERASER_SLACK_PX) / scale;

    this.state.hitNow.clear();

    // Query spatial index with bounding box
    const results = getSpatialIndex().queryRadius(worldX, worldY, radiusWorld);

    for (const entry of results) {
      const handle = getHandle(entry.id);
      if (!handle) continue;

      const cursor: [number, number] = [worldX, worldY];

      if (handle.kind === 'stroke' || handle.kind === 'connector') {
        const points = getPoints(handle.y);
        if (points.length === 0) continue;
        if (strokeHitTest(cursor, points, radiusWorld)) {
          this.state.hitNow.add(handle.id);
        }
        continue;
      }

      if (handle.kind === 'shape') {
        const frame = getFrame(handle.y);
        if (!frame) continue;
        const shapeType = getShapeType(handle.y);
        const strokeWidth = getWidth(handle.y, 1);
        const isFilled = !!getFillColor(handle.y);
        if (circleHitsShape(cursor, radiusWorld, frame, shapeType, strokeWidth, isFilled)) {
          this.state.hitNow.add(handle.id);
        }
        continue;
      }

      // All remaining bindable kinds (text/note/code/image/bookmark) are
      // rect-framed and always opaque throughout their bbox.
      const frame = frameOf(handle);
      if (!frame) continue;
      if (circleRectIntersect(cursor, radiusWorld, frame)) {
        this.state.hitNow.add(handle.id);
      }
    }

    // Add to accumulator when erasing
    if (this.state.isErasing) {
      for (const id of this.state.hitNow) {
        this.state.hitAccum.add(id);
      }
    }

    invalidateOverlay();
  }

  private commitErase(): void {
    // Stop trail animation (it will decay naturally)
    const trailAnim = getAnimationController().get<EraserTrailAnimation>('eraser-trail');
    trailAnim?.stop();

    if (this.state.hitAccum.size === 0) {
      this.resetState();
      invalidateOverlay();
      return;
    }

    const idsToDelete = this.state.hitAccum;

    // Collect connector anchor cleanups needed
    // Map: connectorId → { clearStart: boolean, clearEnd: boolean }
    const anchorCleanups = new Map<string, { clearStart: boolean; clearEnd: boolean }>();

    for (const id of idsToDelete) {
      // Skip connectors - they don't have shapes anchored to them
      const handle = getHandle(id);
      if (!handle || handle.kind === 'connector') continue;

      // Find connectors anchored to this shape
      const connectorIds = getConnectorsForShape(id);
      if (!connectorIds) continue;

      for (const connectorId of connectorIds) {
        // Skip if connector is also being deleted
        if (idsToDelete.has(connectorId)) continue;

        const connectorHandle = getHandle(connectorId);
        if (!connectorHandle) continue;

        // Check which anchor(s) point to this shape
        const startAnchor = getStartAnchor(connectorHandle.y);
        const endAnchor = getEndAnchor(connectorHandle.y);

        const existing = anchorCleanups.get(connectorId) ?? { clearStart: false, clearEnd: false };

        if (startAnchor?.id === id) {
          existing.clearStart = true;
        }
        if (endAnchor?.id === id) {
          existing.clearEnd = true;
        }

        if (existing.clearStart || existing.clearEnd) {
          anchorCleanups.set(connectorId, existing);
        }
      }
    }

    // Single transaction: clear dead anchors + delete objects
    transact(() => {
      // Step 1: Clear dead anchors from affected connectors
      for (const [connectorId, { clearStart, clearEnd }] of anchorCleanups) {
        const connectorYMap = getObjects().get(connectorId);
        if (!connectorYMap) continue;

        if (clearStart) {
          connectorYMap.delete('startAnchor');
        }
        if (clearEnd) {
          connectorYMap.delete('endAnchor');
        }
      }

      // Step 2: Delete the objects
      for (const id of idsToDelete) {
        getObjects().delete(id);
      }
    });

    this.resetState();
    invalidateOverlay();
  }

  getPreview(): EraserPreview | null {
    // Only return preview when actively erasing
    if (!this.state.isErasing || !this.state.lastWorld) {
      return null;
    }

    return {
      kind: 'eraser',
      circle: {
        cx: this.state.lastWorld[0],
        cy: this.state.lastWorld[1],
        r_px: ERASER_RADIUS_PX,
      },
      hitIds: Array.from(this.state.hitAccum), // Only accumulated hits
      dimOpacity: 0.75,
    };
  }
}

export interface EraserPreview {
  kind: 'eraser';
  circle: { cx: number; cy: number; r_px: number };
  hitIds: string[];
  dimOpacity: number;
}
