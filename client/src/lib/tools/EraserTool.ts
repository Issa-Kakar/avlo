import type { IRoomDocManager } from '../room-doc-manager';
import * as Y from 'yjs';

// EraserSettings type from device-ui-store
interface EraserSettings {
  size: number; // CSS pixels for cursor radius
}

interface EraserState {
  isErasing: boolean;
  pointerId: number | null;
  radiusPx: number; // CSS pixels from deviceUI
  lastWorld: [number, number] | null;
  hitNow: Set<string>; // IDs currently under cursor
  hitAccum: Set<string>; // IDs accumulated during drag
}

export class EraserTool {
  private state!: EraserState; // Will be initialized in constructor via resetState()
  private room: IRoomDocManager;
  private settings: EraserSettings;
  private userId: string;
  private onInvalidate?: () => void;
  private getViewport?: () => { cssWidth: number; cssHeight: number; dpr: number };
  private getView?: () => ViewTransform;

  constructor(
    room: IRoomDocManager,
    settings: EraserSettings,
    userId: string,
    onInvalidate?: () => void,
    getViewport?: () => { cssWidth: number; cssHeight: number; dpr: number },
    getView?: () => ViewTransform,
  ) {
    this.room = room;
    this.settings = settings;
    this.userId = userId;
    this.onInvalidate = onInvalidate;
    this.getViewport = getViewport;
    this.getView = getView;
    this.resetState();
  }

  private resetState(): void {
    this.state = {
      isErasing: false,
      pointerId: null,
      radiusPx: this.settings.size,
      lastWorld: null,
      hitNow: new Set(),
      hitAccum: new Set(),
    };
  }

  // PointerTool interface compatibility - same signature as DrawingTool
  canBegin(): boolean {
    // ONLY check tool-local readiness
    // Canvas handles mobile gating, mutate() handles read-only
    return !this.state.isErasing;
  }

  // Alias for legacy naming if needed
  canStartErasing(): boolean {
    return this.canBegin();
  }

  // PointerTool interface - polymorphic with DrawingTool
  begin(pointerId: number, worldX: number, worldY: number): void {
    this.startErasing(pointerId, worldX, worldY);
  }

  startErasing(pointerId: number, worldX: number, worldY: number): void {
    if (this.state.isErasing) return;

    this.state = {
      isErasing: true,
      pointerId,
      radiusPx: this.settings.size,
      lastWorld: [worldX, worldY],
      hitNow: new Set(),
      hitAccum: new Set(),
    };

    this.updateHitTest(worldX, worldY);
  }

  move(worldX: number, worldY: number): void {
    // Always move the cursor immediately for best overlay tracking
    this.state.lastWorld = [worldX, worldY];

    // With RBush always present, sync hit-test is cheap (O(log N + K))
    this.updateHitTest(worldX, worldY);

    // Always invalidate overlay on every move for smooth cursor
    this.onInvalidate?.();
  }

  // PointerTool interface methods for polymorphic handling
  end(worldX?: number, worldY?: number): void {
    // Remember where the pointer ended (or fall back to last hover)
    const pos = (worldX != null && worldY != null)
      ? [worldX, worldY] as [number, number]
      : this.state.lastWorld;

    // Commit the deletion (this resets state)
    this.commitErase();

    // Re-prime the hover so the cursor remains visible even without movement
    if (pos) {
      this.state.lastWorld = pos;
      this.updateHitTest(pos[0], pos[1]);
    }
  }

  cancel(): void {
    this.cancelErasing();
  }

  isActive(): boolean {
    return this.state.isErasing;
  }

  getPointerId(): number | null {
    return this.state.pointerId;
  }

  destroy(): void {
    this.resetState();
    this.onInvalidate?.(); // Clear any preview
  }

  // Compatibility alias
  isErasing(): boolean {
    return this.state.isErasing;
  }

  // Clear hover state when pointer leaves canvas
  clearHover(): void {
    this.state.lastWorld = null;
    this.state.hitNow.clear();
    if (!this.state.isErasing) {
      this.state.hitAccum.clear();
    }
    this.onInvalidate?.();
  }

  // Update hit-testing when view transforms (pan/zoom) while stationary
  onViewChange(): void {
    const p = this.state.lastWorld;
    if (p) {
      this.updateHitTest(p[0], p[1]);
    }
  }

  private updateHitTest(worldX: number, worldY: number): void {
    const snapshot = this.room.currentSnapshot;
    // USE LIVE VIEW, FALLBACK TO SNAPSHOT IF NOT PROVIDED
    const viewTransform = this.getView ? this.getView() : snapshot.view;

    // Convert radius to world units with micro-slack for better feel
    const ERASER_SLACK_PX = 0.9; // Tweak 0.5-1.0 for best feel
    const radiusWorld = (this.state.radiusPx + ERASER_SLACK_PX) / viewTransform.scale;

    // Clear hitNow for fresh hit-test
    this.state.hitNow.clear();

    // Spatial index is always available, use combined query for both strokes AND texts
    if (snapshot.spatialIndex && 'queryRectAll' in snapshot.spatialIndex) {
      // Query with eraser's bounding square
      // Since bbox already includes stroke width, no extra inflation needed!
      const results = (snapshot.spatialIndex as any).queryRectAll(
        worldX - radiusWorld,
        worldY - radiusWorld,
        worldX + radiusWorld,
        worldY + radiusWorld,
      );

      // Test strokes - bbox already includes stroke width
      for (const stroke of results.strokes) {
        // Fine-grained segment test (bbox already has stroke width)
        if (this.strokeHitTest(worldX, worldY, stroke.points, radiusWorld)) {
          this.state.hitNow.add(stroke.id);
        }
      }

      // Test texts - simple circle-rect intersection
      for (const text of results.texts) {
        // Check if eraser circle overlaps text rect
        if (this.circleRectIntersect(
          worldX, worldY, radiusWorld,
          text.x, text.y, text.w, text.h
        )) {
          this.state.hitNow.add(text.id);
        }
      }
    }

    // Update accumulator if dragging
    if (this.state.pointerId !== null) {
      for (const id of this.state.hitNow) {
        this.state.hitAccum.add(id);
      }
    }

    // Trigger overlay redraw
    this.onInvalidate?.();
  }

  private strokeHitTest(
    px: number,
    py: number,
    points: ReadonlyArray<number>,
    radius: number,
  ): boolean {
    // Handle single-point stroke (e.g., 1px dot)
    if (points.length === 2) {
      const dx = px - points[0];
      const dy = py - points[1];
      return (dx * dx + dy * dy) <= (radius * radius);
    }

    // Test each segment
    for (let i = 0; i < points.length - 2; i += 2) {
      const x1 = points[i],
        y1 = points[i + 1];
      const x2 = points[i + 2],
        y2 = points[i + 3];

      const dist = this.pointToSegmentDistance(px, py, x1, y1, x2, y2);
      if (dist <= radius) return true;
    }
    return false;
  }

  private pointToSegmentDistance(
    px: number,
    py: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): number {
    const dx = x2 - x1,
      dy = y2 - y1;

    // Handle degenerate segment
    if (dx === 0 && dy === 0) {
      return Math.hypot(px - x1, py - y1);
    }

    // Project point onto segment
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));

    const projX = x1 + t * dx;
    const projY = y1 + t * dy;

    return Math.hypot(px - projX, py - projY);
  }

  cancelErasing(): void {
    this.resetState();
    this.onInvalidate?.(); // Clear any preview
  }

  commitErase(): void {
    if (!this.state.isErasing) return;
    if (this.state.hitAccum.size === 0) {
      this.cancelErasing();
      return;
    }

    // Atomic delete in single transaction
    // This single mutate() constitutes ONE undo step per user (UndoManager origin=userId)
    this.room.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      const objects = root.get('objects') as Y.Map<Y.Map<any>>;
      const hit = this.state.hitAccum;

      // Direct deletion by ID from Y.Map
      for (const id of hit) {
        objects.delete(id);
      }
    });

    this.resetState();
    this.onInvalidate?.(); // Clear preview after committing
  }

  getPreview(): EraserPreview | null {
    if (!this.state.lastWorld) return null;

    // Combine hover + accumulated hits
    const allHits = new Set([...this.state.hitNow, ...this.state.hitAccum]);

    return {
      kind: 'eraser',
      circle: {
        cx: this.state.lastWorld[0], // World coords, transformed by overlay
        cy: this.state.lastWorld[1],
        r_px: this.state.radiusPx, // Screen pixels, fixed size
      },
      hitIds: Array.from(allHits),
      dimOpacity: 0.75, // Stronger effect for clear feedback
    };
  }

  // Helper methods
  private getVisibleWorldBounds(viewTransform: ViewTransform): WorldBounds {
    if (!this.getViewport) {
      // Fallback: return large bounds if viewport not available
      return { minX: -10000, minY: -10000, maxX: 10000, maxY: 10000 };
    }

    const vp = this.getViewport();
    const marginPx = this.state.radiusPx + 50; // Add margin for partial visibility
    const marginWorld = marginPx / viewTransform.scale;

    // Convert viewport corners to world coordinates
    const [minWorldX, minWorldY] = viewTransform.canvasToWorld(0, 0);
    const [maxWorldX, maxWorldY] = viewTransform.canvasToWorld(vp.cssWidth, vp.cssHeight);

    return {
      minX: minWorldX - marginWorld,
      minY: minWorldY - marginWorld,
      maxX: maxWorldX + marginWorld,
      maxY: maxWorldY + marginWorld,
    };
  }

  private isInBounds(
    bbox: number[] | [number, number, number, number],
    bounds: WorldBounds,
  ): boolean {
    return !(
      bbox[2] < bounds.minX || // bbox right < viewport left
      bbox[0] > bounds.maxX || // bbox left > viewport right
      bbox[3] < bounds.minY || // bbox bottom < viewport top
      bbox[1] > bounds.maxY // bbox top > viewport bottom
    );
  }

  private inflateBbox(
    bbox: number[] | [number, number, number, number],
    radius: number,
  ): [number, number, number, number] {
    return [bbox[0] - radius, bbox[1] - radius, bbox[2] + radius, bbox[3] + radius];
  }

  private pointInBbox(px: number, py: number, bbox: [number, number, number, number]): boolean {
    return px >= bbox[0] && px <= bbox[2] && py >= bbox[1] && py <= bbox[3];
  }

  // Helper for circle-rect intersection
  private circleRectIntersect(
    cx: number, cy: number, r: number,
    x: number, y: number, w: number, h: number
  ): boolean {
    // Find closest point on rect to circle center
    const closestX = Math.max(x, Math.min(cx, x + w));
    const closestY = Math.max(y, Math.min(cy, y + h));

    // Check if distance is within radius
    const dx = cx - closestX;
    const dy = cy - closestY;
    return (dx * dx + dy * dy) <= (r * r);
  }
}

// Type for world bounds used in hit testing
interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// Type for ViewTransform (should match the one in room-doc-manager)
interface ViewTransform {
  worldToCanvas: (x: number, y: number) => [number, number];
  canvasToWorld: (x: number, y: number) => [number, number];
  scale: number;
  pan: { x: number; y: number };
}

// Type for EraserPreview
export interface EraserPreview {
  kind: 'eraser';
  /** Center in world coords; overlay does worldToCanvas() */
  circle: { cx: number; cy: number; r_px: number };
  hitIds: string[];
  dimOpacity: number;
}
