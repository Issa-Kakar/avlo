import {
  pointToSegmentDistance,
  strokeHitTest,
  circleRectIntersect,
  pointInDiamond,
} from '@/core/geometry/hit-testing';
import { useCameraStore, worldToCanvas } from '@/stores/camera-store';
import {
  getSpatialIndex,
  getHandle,
  transact,
  getObjects,
  getConnectorsForShape,
} from '@/runtime/room-runtime';
import { invalidateOverlay } from '@/renderer/OverlayRenderLoop';
import { getAnimationController } from '@/renderer/animation/AnimationController';
import type { EraserTrailAnimation } from '@/renderer/animation/EraserTrailAnimation';
import {
  getFrame,
  getPoints,
  getWidth,
  getShapeType,
  getFillColor,
  getStartAnchor,
  getEndAnchor,
} from '@/core/accessors';
import { getTextFrame } from '@/core/text/text-system';
import { getCodeFrame } from '@/core/code/code-system';
import { getBookmarkFrame } from '@/core/bookmark/bookmark-render';
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
    const results = getSpatialIndex().query({
      minX: worldX - radiusWorld,
      minY: worldY - radiusWorld,
      maxX: worldX + radiusWorld,
      maxY: worldY + radiusWorld,
    });

    // Test each object by kind
    for (const entry of results) {
      const handle = getHandle(entry.id);
      if (!handle) continue;

      switch (handle.kind) {
        case 'stroke':
        case 'connector': {
          const points = getPoints(handle.y);
          if (points.length === 0) break;

          if (strokeHitTest(worldX, worldY, points, radiusWorld)) {
            this.state.hitNow.add(handle.id);
          }
          break;
        }

        case 'shape': {
          const frame = getFrame(handle.y);
          if (!frame) break;

          const shapeType = getShapeType(handle.y);
          const strokeWidth = getWidth(handle.y, 1);
          const fillColor = getFillColor(handle.y);
          const isFilled = !!fillColor;

          let hit = false;

          switch (shapeType) {
            case 'diamond':
              hit = this.diamondHitTest(worldX, worldY, radiusWorld, frame, strokeWidth, isFilled);
              break;
            case 'ellipse':
              hit = this.ellipseHitTest(worldX, worldY, radiusWorld, frame, strokeWidth, isFilled);
              break;
            case 'rect':
            case 'roundedRect':
            default:
              // Rectangles can use the simpler rect test
              hit = this.rectHitTest(worldX, worldY, radiusWorld, frame, strokeWidth, isFilled);
              break;
          }

          if (hit) {
            this.state.hitNow.add(handle.id);
          }
          break;
        }

        case 'text': {
          const frame = getTextFrame(handle.id);
          if (!frame) break;

          const [x, y, w, h] = frame;
          if (circleRectIntersect(worldX, worldY, radiusWorld, x, y, w, h)) {
            this.state.hitNow.add(handle.id);
          }
          break;
        }

        case 'code': {
          const frame = getCodeFrame(handle.id);
          if (!frame) break;

          const [x, y, w, h] = frame;
          if (circleRectIntersect(worldX, worldY, radiusWorld, x, y, w, h)) {
            this.state.hitNow.add(handle.id);
          }
          break;
        }

        case 'image': {
          const frame = getFrame(handle.y);
          if (!frame) break;
          const [x, y, w, h] = frame;
          if (circleRectIntersect(worldX, worldY, radiusWorld, x, y, w, h)) {
            this.state.hitNow.add(handle.id);
          }
          break;
        }

        case 'bookmark': {
          const frame = getBookmarkFrame(handle.id);
          if (!frame) break;
          const [x, y, w, h] = frame;
          if (circleRectIntersect(worldX, worldY, radiusWorld, x, y, w, h)) {
            this.state.hitNow.add(handle.id);
          }
          break;
        }

        case 'note': {
          const frame = getTextFrame(handle.id);
          if (!frame) break;

          const [x, y, w, h] = frame;
          if (circleRectIntersect(worldX, worldY, radiusWorld, x, y, w, h)) {
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

    invalidateOverlay();
  }

  /**
   * Test if eraser circle intersects a diamond shape.
   * Diamond vertices are at midpoints of frame edges.
   */
  private diamondHitTest(
    cx: number,
    cy: number,
    r: number,
    frame: [number, number, number, number],
    strokeWidth: number,
    isFilled: boolean,
  ): boolean {
    const [x, y, w, h] = frame;
    const halfStroke = strokeWidth / 2;

    // Diamond vertices (midpoints of frame edges)
    const top: [number, number] = [x + w / 2, y];
    const right: [number, number] = [x + w, y + h / 2];
    const bottom: [number, number] = [x + w / 2, y + h];
    const left: [number, number] = [x, y + h / 2];

    // For filled diamonds: check if point is inside OR near edges
    if (isFilled) {
      if (pointInDiamond(cx, cy, top, right, bottom, left)) {
        return true;
      }
    }

    // Check distance to each edge (4 line segments)
    const edges: [[number, number], [number, number]][] = [
      [top, right],
      [right, bottom],
      [bottom, left],
      [left, top],
    ];

    for (const [p1, p2] of edges) {
      const dist = pointToSegmentDistance(cx, cy, p1[0], p1[1], p2[0], p2[1]);
      if (dist <= r + halfStroke) {
        return true;
      }
    }

    return false;
  }

  /**
   * Test if eraser circle intersects an ellipse shape.
   */
  private ellipseHitTest(
    cx: number,
    cy: number,
    r: number,
    frame: [number, number, number, number],
    strokeWidth: number,
    isFilled: boolean,
  ): boolean {
    const [x, y, w, h] = frame;
    const halfStroke = strokeWidth / 2;

    // Ellipse center and radii
    const ecx = x + w / 2;
    const ecy = y + h / 2;
    const rx = w / 2;
    const ry = h / 2;

    // Avoid division by zero for degenerate ellipses
    if (rx < 0.001 || ry < 0.001) {
      return circleRectIntersect(cx, cy, r, x, y, w, h);
    }

    // Normalize point to unit circle space
    const dx = (cx - ecx) / rx;
    const dy = (cy - ecy) / ry;
    const normalizedDist = Math.sqrt(dx * dx + dy * dy);

    // Convert eraser radius to normalized space (approximate)
    const avgRadius = (rx + ry) / 2;
    const normalizedR = r / avgRadius;
    const normalizedStroke = halfStroke / avgRadius;

    if (isFilled) {
      // For filled: hit if inside ellipse OR within stroke width of edge
      return normalizedDist <= 1 + normalizedR + normalizedStroke;
    } else {
      // For unfilled: only hit if near the stroke
      const distFromEdge = Math.abs(normalizedDist - 1);
      return distFromEdge <= normalizedR + normalizedStroke;
    }
  }

  /**
   * Test if eraser circle intersects a rectangle shape (stroke only for unfilled).
   */
  private rectHitTest(
    cx: number,
    cy: number,
    r: number,
    frame: [number, number, number, number],
    strokeWidth: number,
    isFilled: boolean,
  ): boolean {
    const [x, y, w, h] = frame;
    const halfStroke = strokeWidth / 2;

    if (isFilled) {
      // For filled: use existing circle-rect intersection (anywhere inside counts)
      // Expand rect by stroke width for edge hits
      return circleRectIntersect(cx, cy, r + halfStroke, x, y, w, h);
    }

    // For unfilled: check distance to each edge segment
    const edges: [[number, number], [number, number]][] = [
      [
        [x, y],
        [x + w, y],
      ], // Top edge
      [
        [x + w, y],
        [x + w, y + h],
      ], // Right edge
      [
        [x + w, y + h],
        [x, y + h],
      ], // Bottom edge
      [
        [x, y + h],
        [x, y],
      ], // Left edge
    ];

    for (const [p1, p2] of edges) {
      const dist = pointToSegmentDistance(cx, cy, p1[0], p1[1], p2[0], p2[1]);
      if (dist <= r + halfStroke) {
        return true;
      }
    }

    return false;
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
