import type { IRoomDocManager } from '../room-doc-manager';
import * as Y from 'yjs';

// Fixed radius configuration
const ERASER_RADIUS_PX = 10; // Fixed screen-space radius

interface EraserState {
  isErasing: boolean;
  pointerId: number | null;
  lastWorld: [number, number] | null;
  hitNow: Set<string>;   // Objects currently under cursor
  hitAccum: Set<string>; // Objects accumulated during drag
}

export class EraserTool {
  private state!: EraserState;
  private room: IRoomDocManager;
  private onInvalidate?: () => void;
  private getView?: () => ViewTransform;

  constructor(
    room: IRoomDocManager,
    _settings: any, // Unused - radius is fixed
    userId: string,
    onInvalidate?: () => void,
    _getViewport?: any, // Unused
    getView?: () => ViewTransform,
  ) {
    this.room = room;

    this.onInvalidate = onInvalidate;
    this.getView = getView;
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

    this.updateHitTest(worldX, worldY);
    this.onInvalidate?.();
  }

  move(worldX: number, worldY: number): void {
    this.state.lastWorld = [worldX, worldY];

    // Only hit-test when actively erasing
    if (this.state.isErasing) {
      this.updateHitTest(worldX, worldY);
    }
    this.onInvalidate?.();
  }

  end(_worldX?: number, _worldY?: number): void {
    if (!this.state.isErasing) return;
    this.commitErase();
  }

  cancel(): void {
    this.resetState();
    this.onInvalidate?.();
  }

  isActive(): boolean {
    return this.state.isErasing;
  }

  getPointerId(): number | null {
    return this.state.pointerId;
  }

  destroy(): void {
    this.resetState();
    this.onInvalidate?.();
  }

  clearHover(): void {
    // No hover state in new design
    if (!this.state.isErasing) {
      this.state.lastWorld = null;
      this.onInvalidate?.();
    }
  }

  onViewChange(): void {
    // Re-compute hits if actively erasing and view changes
    if (this.state.isErasing && this.state.lastWorld) {
      this.updateHitTest(this.state.lastWorld[0], this.state.lastWorld[1]);
    }
  }

  private updateHitTest(worldX: number, worldY: number): void {
    const snapshot = this.room.currentSnapshot;
    const viewTransform = this.getView ? this.getView() : snapshot.view;
    
    // Convert fixed screen radius to world units
    const radiusWorld = ERASER_RADIUS_PX / viewTransform.scale;

    this.state.hitNow.clear();

    const index = snapshot.spatialIndex;
    if (!index) {
      this.onInvalidate?.();
      return;
    }

    // Query spatial index with bounding box
    const results = index.query({
      minX: worldX - radiusWorld,
      minY: worldY - radiusWorld,
      maxX: worldX + radiusWorld,
      maxY: worldY + radiusWorld,
    });

    // Test each object by kind
    for (const entry of results) {
      const handle = snapshot.objectsById.get(entry.id);
      if (!handle) continue;

      switch (handle.kind) {
        case 'stroke':
        case 'connector': {
          const points = handle.y.get('points') as [number, number][];
          if (!points) break;
          
          if (this.strokeHitTest(worldX, worldY, points, radiusWorld)) {
            this.state.hitNow.add(handle.id);
          }
          break;
        }
        
        case 'shape': {
          const frame = handle.y.get('frame') as [number, number, number, number] | undefined;
          if (!frame) break;
          
          const [x, y, w, h] = frame;
          if (this.circleRectIntersect(worldX, worldY, radiusWorld, x, y, w, h)) {
            this.state.hitNow.add(handle.id);
          }
          break;
        }
        
        case 'text': {
          const frame = handle.y.get('frame') as [number, number, number, number] | undefined;
          if (!frame) break;
          
          const [x, y, w, h] = frame;
          if (this.circleRectIntersect(worldX, worldY, radiusWorld, x, y, w, h)) {
            this.state.hitNow.add(handle.id);
          }
          break;
        }
      }
    }

    // Add to accumulator when erasing
    if (this.state.isErasing) {
      for (const id of this.state.hitNow) {
        this.state.hitAccum.add(id);
      }
    }

    this.onInvalidate?.();
  }

  private strokeHitTest(
    px: number,
    py: number,
    points: [number, number][],
    radius: number,
  ): boolean {
    // Handle single-point stroke
    if (points.length === 1) {
      const [x, y] = points[0];
      const dx = px - x;
      const dy = py - y;
      return dx * dx + dy * dy <= radius * radius;
    }

    // Test each segment
    for (let i = 0; i < points.length - 1; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[i + 1];
      
      if (this.pointToSegmentDistance(px, py, x1, y1, x2, y2) <= radius) {
        return true;
      }
    }
    return false;
  }

  private pointToSegmentDistance(
    px: number, py: number,
    x1: number, y1: number,
    x2: number, y2: number,
  ): number {
    const dx = x2 - x1;
    const dy = y2 - y1;

    if (dx === 0 && dy === 0) {
      return Math.hypot(px - x1, py - y1);
    }

    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;

    return Math.hypot(px - projX, py - projY);
  }

  private circleRectIntersect(
    cx: number, cy: number, r: number,
    x: number, y: number, w: number, h: number
  ): boolean {
    const closestX = Math.max(x, Math.min(cx, x + w));
    const closestY = Math.max(y, Math.min(cy, y + h));
    const dx = cx - closestX;
    const dy = cy - closestY;
    return (dx * dx + dy * dy) <= (r * r);
  }

  private commitErase(): void {
    if (this.state.hitAccum.size === 0) {
      this.resetState();
      this.onInvalidate?.();
      return;
    }

    // Delete all accumulated objects in one transaction
    this.room.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      const objects = root.get('objects') as Y.Map<Y.Map<any>>;
      
      for (const id of this.state.hitAccum) {
        objects.delete(id);
      }
    });

    this.resetState();
    this.onInvalidate?.();
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

interface ViewTransform {
  worldToCanvas: (x: number, y: number) => [number, number];
  canvasToWorld: (x: number, y: number) => [number, number];
  scale: number;
  pan: { x: number; y: number };
}

export interface EraserPreview {
  kind: 'eraser';
  circle: { cx: number; cy: number; r_px: number };
  hitIds: string[];
  dimOpacity: number;
}