import {
  acquireLocalLock,
  getLockedFlags,
  getLockOwners,
  LOCK_SRC_ERASER,
  onRemoteLocksApplied,
  releaseLocalLocks,
} from '@/core/locks/lock-table';
import { atPoint, queryHandleIds } from '@/core/spatial/object-query';
import { getAnimationController } from '@/renderer/animation/AnimationController';
import type { EraserTrailAnimation } from '@/renderer/animation/EraserTrailAnimation';
import { invalidateOverlay } from '@/renderer/OverlayRenderLoop';
import { detachConnectorFromShape, getAttachedConnectors, getHandle, getObjects, transact } from '@/runtime/room-runtime';
import { worldToCanvas } from '@/stores/camera-store';
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
    // A peer's lock landing mid-sweep evicts those ids from the sweep (they're the peer's
    // now): drop the dim preview + the pending delete. The inert local claims left in the
    // eraser source list release harmlessly at gesture end (the `=== 1` check skips them).
    onRemoteLocksApplied((ids) => {
      if (!this.state.isErasing) return;
      let changed = false;
      for (const id of ids) {
        this.state.hitNow.delete(id);
        if (this.state.hitAccum.delete(id)) changed = true;
      }
      if (changed) invalidateOverlay();
    });
  }

  private resetState(): void {
    releaseLocalLocks(LOCK_SRC_ERASER); // no-op on the constructor call (empty source list)
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
    this.state.hitNow.clear();

    const idsInCircle = queryHandleIds(atPoint([worldX, worldY], { px: ERASER_RADIUS_PX + ERASER_SLACK_PX }));
    for (const id of idsInCircle) this.state.hitNow.add(id);

    if (this.state.isErasing) {
      for (const id of this.state.hitNow) {
        if (!this.state.hitAccum.has(id)) {
          this.state.hitAccum.add(id);
          acquireLocalLock(LOCK_SRC_ERASER, id); // lock-on-first-hit — peers see it grey immediately
        }
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

    // Loser-heal: a peer lock (or a durable lock) that landed between the last hit-test
    // and pointer-up wins — drop those ids. (Deleting from a Set mid-iteration is legal.)
    const lo = getLockOwners();
    const lf = getLockedFlags();
    for (const id of idsToDelete) {
      const handle = getHandle(id);
      if (handle && (lo[handle.slot] > 1 || lf[handle.slot] === 1)) idsToDelete.delete(id);
    }

    // Collect (connectorId, shapeId) pairs to detach. Surviving connectors get their bound
    // endpoint(s) replaced with the cached route's first/last point so they remain visible.
    const detachPairs: [string, string][] = [];
    for (const id of idsToDelete) {
      const handle = getHandle(id);
      if (!handle || handle.kind === 'connector') continue;

      const connectorIds = getAttachedConnectors(id);
      if (!connectorIds) continue;
      for (const connectorId of connectorIds) {
        if (idsToDelete.has(connectorId)) continue;
        detachPairs.push([connectorId, id]);
      }
    }

    // Single transaction: detach surviving connectors + delete objects.
    transact(() => {
      for (const [connectorId, shapeId] of detachPairs) {
        detachConnectorFromShape(connectorId, shapeId);
      }
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
