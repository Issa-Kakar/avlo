import type { IRoomDocManager } from '../room-doc-manager';
import type { WorldRect, SelectionPreview, HandleId } from './types';
import { useSelectionStore } from '@/stores/selection-store';

// === Constants ===
const HIT_RADIUS_PX = 6;       // Screen-space hit test radius for selection
const HANDLE_HIT_PX = 10;      // Screen-space hit radius for handles
const MOVE_THRESHOLD_PX = 4;   // Pixels before drag detected (screen space)

// === Types ===

type Phase = 'idle' | 'pendingClick' | 'marquee' | 'translate' | 'scale';

interface HitCandidate {
  id: string;
  kind: 'stroke' | 'shape' | 'text' | 'connector';
  distance: number;
  insideInterior: boolean;
  area: number;
  isFilled: boolean;
}

interface SelectToolOpts {
  invalidateWorld: (bounds: WorldRect) => void;
  invalidateOverlay: () => void;
  getView: () => ViewTransform;
  // Cursor callbacks (same pattern as PanTool)
  applyCursor: () => void;
  setCursorOverride: (cursor: string | null) => void;
}

interface ViewTransform {
  worldToCanvas: (x: number, y: number) => [number, number];
  canvasToWorld: (x: number, y: number) => [number, number];
  scale: number;
  pan: { x: number; y: number };
}

interface ObjectHandle {
  id: string;
  kind: 'stroke' | 'shape' | 'text' | 'connector';
  y: {
    get: (key: string) => unknown;
  };
  bbox: [number, number, number, number];
}

// === SelectTool Class ===

export class SelectTool {
  private room: IRoomDocManager;
  private invalidateWorld: (bounds: WorldRect) => void;
  private invalidateOverlay: () => void;
  private getView: () => ViewTransform;
  private applyCursor: () => void;
  private setCursorOverride: (cursor: string | null) => void;

  // State machine
  private phase: Phase = 'idle';
  private pointerId: number | null = null;
  private downWorld: [number, number] | null = null;
  private downScreen: [number, number] | null = null;

  // Hit testing results at pointer down
  private hitAtDown: HitCandidate | null = null;
  private activeHandle: HandleId | null = null;

  // Track previous bounds for dirty rect optimization
  private prevPreviewBounds: WorldRect | null = null;

  constructor(room: IRoomDocManager, opts: SelectToolOpts) {
    this.room = room;
    this.invalidateWorld = opts.invalidateWorld;
    this.invalidateOverlay = opts.invalidateOverlay;
    this.getView = opts.getView;
    this.applyCursor = opts.applyCursor;
    this.setCursorOverride = opts.setCursorOverride;
  }

  // === PointerTool Interface ===

  canBegin(): boolean {
    return this.phase === 'idle';
  }

  begin(pointerId: number, worldX: number, worldY: number): void {
    if (this.phase !== 'idle') return;

    this.pointerId = pointerId;
    this.downWorld = [worldX, worldY];

    // Convert to screen space for move threshold
    const view = this.getView();
    const [screenX, screenY] = view.worldToCanvas(worldX, worldY);
    this.downScreen = [screenX, screenY];

    // First, check if we're clicking on a resize handle (existing selection)
    const store = useSelectionStore.getState();
    if (store.selectedIds.length > 0) {
      const handleHit = this.hitTestHandle(worldX, worldY);
      if (handleHit) {
        this.activeHandle = handleHit;
        this.phase = 'pendingClick';
        this.invalidateOverlay();
        return;
      }
    }

    // Next, check if we hit an object
    this.hitAtDown = this.hitTestObjects(worldX, worldY);

    if (this.hitAtDown) {
      // Hit an object - might be click-select or drag-translate
      this.phase = 'pendingClick';
    } else {
      // No hit - start marquee selection
      this.phase = 'marquee';
      useSelectionStore.getState().beginMarquee([worldX, worldY]);
    }

    this.invalidateOverlay();
  }

  move(worldX: number, worldY: number): void {
    const view = this.getView();
    const [screenX, screenY] = view.worldToCanvas(worldX, worldY);

    switch (this.phase) {
      case 'pendingClick': {
        // Check if we've moved past the drag threshold
        if (this.downScreen) {
          const dx = screenX - this.downScreen[0];
          const dy = screenY - this.downScreen[1];
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist > MOVE_THRESHOLD_PX) {
            // Transition to actual drag mode
            if (this.activeHandle) {
              // Dragging a resize handle
              this.phase = 'scale';
              const bounds = this.computeSelectionBounds();
              if (bounds) {
                const origin = this.getScaleOrigin(this.activeHandle, bounds);
                useSelectionStore.getState().beginScale(bounds, origin);
              }
              // Set cursor for active handle
              const cursor = (this.activeHandle === 'nw' || this.activeHandle === 'se')
                ? 'nwse-resize'
                : 'nesw-resize';
              this.setCursorOverride(cursor);
              this.applyCursor();
            } else if (this.hitAtDown) {
              // Dragging selected object(s) - translate
              // First, ensure the hit object is selected
              const store = useSelectionStore.getState();
              if (!store.selectedIds.includes(this.hitAtDown.id)) {
                store.setSelection([this.hitAtDown.id]);
              }

              this.phase = 'translate';
              const bounds = this.computeSelectionBounds();
              if (bounds) {
                useSelectionStore.getState().beginTranslate(bounds);
              }
            }
          }
        }
        break;
      }

      case 'marquee': {
        // Update marquee current position
        useSelectionStore.getState().updateMarquee([worldX, worldY]);

        // Query objects within marquee bounds
        this.updateMarqueeSelection();
        break;
      }

      case 'translate': {
        if (this.downWorld) {
          const dx = worldX - this.downWorld[0];
          const dy = worldY - this.downWorld[1];
          useSelectionStore.getState().updateTranslate(dx, dy);

          // Invalidate dirty rect (union of original and transformed bounds)
          this.invalidateTransformPreview();
        }
        break;
      }

      case 'scale': {
        if (this.downWorld && this.activeHandle) {
          const { scaleX, scaleY } = this.computeScaleFactors(worldX, worldY);
          useSelectionStore.getState().updateScale(scaleX, scaleY);

          // Invalidate dirty rect
          this.invalidateTransformPreview();
        }
        break;
      }
    }

    this.invalidateOverlay();
  }

  end(_worldX?: number, _worldY?: number): void {
    switch (this.phase) {
      case 'pendingClick': {
        // Was a click, not a drag
        if (this.activeHandle) {
          // Clicked on handle but didn't drag - do nothing
        } else if (this.hitAtDown) {
          // Select the clicked object
          useSelectionStore.getState().setSelection([this.hitAtDown.id]);
        } else {
          // Clicked on empty space - clear selection
          useSelectionStore.getState().clearSelection();
        }
        break;
      }

      case 'marquee': {
        // Finalize marquee selection
        useSelectionStore.getState().endMarquee();
        // Selection was already updated during move
        break;
      }

      case 'translate': {
        // TODO: Step 6 - Commit translate to Y.Doc
        // For now, just end the transform (no persistence)
        useSelectionStore.getState().endTransform();
        break;
      }

      case 'scale': {
        // TODO: Step 6 - Commit scale to Y.Doc
        // For now, just end the transform (no persistence)
        useSelectionStore.getState().endTransform();
        break;
      }
    }

    // Clear any cursor override on gesture end
    this.setCursorOverride(null);
    this.applyCursor();

    this.resetState();
    this.invalidateOverlay();
  }

  cancel(): void {
    useSelectionStore.getState().cancelTransform();
    useSelectionStore.getState().cancelMarquee();
    // Clear any cursor override on cancel
    this.setCursorOverride(null);
    this.applyCursor();
    this.resetState();
    this.invalidateOverlay();
  }

  isActive(): boolean {
    return this.phase !== 'idle';
  }

  getPointerId(): number | null {
    return this.pointerId;
  }

  getPreview(): SelectionPreview | null {
    const store = useSelectionStore.getState();
    const { selectedIds, transform, marquee } = store;

    // Compute marquee rect if active
    let marqueeRect: WorldRect | null = null;
    if (marquee.active && marquee.anchor && marquee.current) {
      marqueeRect = {
        minX: Math.min(marquee.anchor[0], marquee.current[0]),
        minY: Math.min(marquee.anchor[1], marquee.current[1]),
        maxX: Math.max(marquee.anchor[0], marquee.current[0]),
        maxY: Math.max(marquee.anchor[1], marquee.current[1]),
      };
    }

    // Compute selection bounds with transform applied
    let selectionBounds: WorldRect | null = null;
    let handles: { id: HandleId; x: number; y: number }[] | null = null;

    if (selectedIds.length > 0) {
      const baseBounds = this.computeSelectionBounds();
      if (baseBounds) {
        selectionBounds = this.applyTransformToBounds(baseBounds, transform);
        handles = this.computeHandles(selectionBounds);
      }
    }

    const isTransforming = transform.kind !== 'none';

    return {
      kind: 'selection',
      selectionBounds,
      marqueeRect,
      handles: isTransforming ? null : handles, // Hide handles during transform
      isTransforming,
      bbox: null,
    };
  }

  destroy(): void {
    this.cancel();
  }

  onViewChange(): void {
    // Re-invalidate overlay when view changes
    this.invalidateOverlay();
  }

  /**
   * Called on pointer move when idle (no active gesture).
   * Detects handle hover and sets appropriate cursor.
   */
  updateHoverCursor(worldX: number, worldY: number): void {
    const store = useSelectionStore.getState();
    if (store.selectedIds.length === 0) {
      this.setCursorOverride(null);
      this.applyCursor();
      return;
    }

    const handle = this.hitTestHandle(worldX, worldY);
    if (handle) {
      // Map handle to cursor
      const cursor = (handle === 'nw' || handle === 'se')
        ? 'nwse-resize'
        : 'nesw-resize';
      this.setCursorOverride(cursor);
    } else {
      this.setCursorOverride(null);
    }
    this.applyCursor();
  }

  /**
   * Called when pointer leaves canvas - clears any hover cursor state.
   */
  clearHover(): void {
    this.setCursorOverride(null);
    this.applyCursor();
  }

  // === Private Helpers ===

  private resetState(): void {
    this.phase = 'idle';
    this.pointerId = null;
    this.downWorld = null;
    this.downScreen = null;
    this.hitAtDown = null;
    this.activeHandle = null;
    this.prevPreviewBounds = null;
  }

  // === Bounds Helpers ===

  private computeSelectionBounds(): WorldRect | null {
    const store = useSelectionStore.getState();
    const { selectedIds } = store;
    if (selectedIds.length === 0) return null;

    const snapshot = this.room.currentSnapshot;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const id of selectedIds) {
      const handle = snapshot.objectsById.get(id);
      if (!handle) continue;

      const [bx, by, bw, bh] = handle.bbox;
      minX = Math.min(minX, bx);
      minY = Math.min(minY, by);
      maxX = Math.max(maxX, bx + bw);
      maxY = Math.max(maxY, by + bh);
    }

    if (!isFinite(minX)) return null;

    return { minX, minY, maxX, maxY };
  }

  private applyTransformToBounds(bounds: WorldRect, transform: { kind: string; dx?: number; dy?: number; scaleX?: number; scaleY?: number; origin?: [number, number] }): WorldRect {
    if (transform.kind === 'translate' && transform.dx !== undefined && transform.dy !== undefined) {
      return {
        minX: bounds.minX + transform.dx,
        minY: bounds.minY + transform.dy,
        maxX: bounds.maxX + transform.dx,
        maxY: bounds.maxY + transform.dy,
      };
    }

    if (transform.kind === 'scale' && transform.origin && transform.scaleX !== undefined && transform.scaleY !== undefined) {
      const [ox, oy] = transform.origin;
      return {
        minX: ox + (bounds.minX - ox) * transform.scaleX,
        minY: oy + (bounds.minY - oy) * transform.scaleY,
        maxX: ox + (bounds.maxX - ox) * transform.scaleX,
        maxY: oy + (bounds.maxY - oy) * transform.scaleY,
      };
    }

    return bounds;
  }

  private computeHandles(bounds: WorldRect): { id: HandleId; x: number; y: number }[] {
    return [
      { id: 'nw', x: bounds.minX, y: bounds.minY },
      { id: 'ne', x: bounds.maxX, y: bounds.minY },
      { id: 'se', x: bounds.maxX, y: bounds.maxY },
      { id: 'sw', x: bounds.minX, y: bounds.maxY },
    ];
  }

  private getScaleOrigin(handle: HandleId, bounds: WorldRect): [number, number] {
    // Scale origin is opposite corner from the dragged handle
    switch (handle) {
      case 'nw': return [bounds.maxX, bounds.maxY]; // Opposite is SE
      case 'ne': return [bounds.minX, bounds.maxY]; // Opposite is SW
      case 'se': return [bounds.minX, bounds.minY]; // Opposite is NW
      case 'sw': return [bounds.maxX, bounds.minY]; // Opposite is NE
    }
  }

  private computeScaleFactors(worldX: number, worldY: number): { scaleX: number; scaleY: number } {
    const store = useSelectionStore.getState();
    const transform = store.transform;

    if (transform.kind !== 'scale') {
      return { scaleX: 1, scaleY: 1 };
    }

    const { origin, originBounds } = transform;
    const [ox, oy] = origin;

    // Original distances from origin to handle
    const origWidth = originBounds.maxX - originBounds.minX;
    const origHeight = originBounds.maxY - originBounds.minY;

    // Determine which direction from origin based on handle
    // For now, simple scale based on cursor distance from origin
    const dx = worldX - ox;
    const dy = worldY - oy;

    // Compute scale factors based on original dimensions
    // Avoid division by zero
    const scaleX = origWidth > 0 ? Math.abs(dx) / (origWidth / 2) : 1;
    const scaleY = origHeight > 0 ? Math.abs(dy) / (origHeight / 2) : 1;

    return { scaleX: Math.max(0.1, scaleX), scaleY: Math.max(0.1, scaleY) };
  }

  private invalidateTransformPreview(): void {
    const bounds = this.computeSelectionBounds();
    if (!bounds) return;

    const store = useSelectionStore.getState();
    const transformedBounds = this.applyTransformToBounds(bounds, store.transform);

    // Union with previous bounds for proper dirty rect
    if (this.prevPreviewBounds) {
      const unionBounds: WorldRect = {
        minX: Math.min(this.prevPreviewBounds.minX, transformedBounds.minX),
        minY: Math.min(this.prevPreviewBounds.minY, transformedBounds.minY),
        maxX: Math.max(this.prevPreviewBounds.maxX, transformedBounds.maxX),
        maxY: Math.max(this.prevPreviewBounds.maxY, transformedBounds.maxY),
      };
      this.invalidateWorld(unionBounds);
    } else {
      this.invalidateWorld(transformedBounds);
    }

    this.prevPreviewBounds = transformedBounds;
  }

  private updateMarqueeSelection(): void {
    const store = useSelectionStore.getState();
    const { marquee } = store;

    if (!marquee.active || !marquee.anchor || !marquee.current) return;

    const marqueeRect = {
      minX: Math.min(marquee.anchor[0], marquee.current[0]),
      minY: Math.min(marquee.anchor[1], marquee.current[1]),
      maxX: Math.max(marquee.anchor[0], marquee.current[0]),
      maxY: Math.max(marquee.anchor[1], marquee.current[1]),
    };

    // Query spatial index for objects intersecting marquee
    const snapshot = this.room.currentSnapshot;
    const index = snapshot.spatialIndex;
    if (!index) return;

    const results = index.query(marqueeRect);

    // Select objects whose bbox center is inside marquee (intuitive behavior)
    const selectedIds: string[] = [];
    for (const entry of results) {
      const handle = snapshot.objectsById.get(entry.id);
      if (!handle) continue;

      const [bx, by, bw, bh] = handle.bbox;
      const cx = bx + bw / 2;
      const cy = by + bh / 2;

      if (cx >= marqueeRect.minX && cx <= marqueeRect.maxX &&
          cy >= marqueeRect.minY && cy <= marqueeRect.maxY) {
        selectedIds.push(entry.id);
      }
    }

    // Update selection (preserving marquee state)
    if (JSON.stringify(selectedIds.sort()) !== JSON.stringify(store.selectedIds.sort())) {
      // Only update if changed to avoid thrashing
      store.setSelection(selectedIds);
      // Re-enable marquee since setSelection clears it
      store.beginMarquee(marquee.anchor);
      if (marquee.current) {
        store.updateMarquee(marquee.current);
      }
    }
  }

  // === Hit Testing ===

  private hitTestHandle(worldX: number, worldY: number): HandleId | null {
    const store = useSelectionStore.getState();
    if (store.selectedIds.length === 0) return null;

    const bounds = this.computeSelectionBounds();
    if (!bounds) return null;

    const view = this.getView();
    const handleRadius = HANDLE_HIT_PX / view.scale;

    const handles: { id: HandleId; x: number; y: number }[] = [
      { id: 'nw', x: bounds.minX, y: bounds.minY },
      { id: 'ne', x: bounds.maxX, y: bounds.minY },
      { id: 'se', x: bounds.maxX, y: bounds.maxY },
      { id: 'sw', x: bounds.minX, y: bounds.maxY },
    ];

    for (const h of handles) {
      const dx = worldX - h.x;
      const dy = worldY - h.y;
      if (dx * dx + dy * dy <= handleRadius * handleRadius) {
        return h.id;
      }
    }

    return null;
  }

  private hitTestObjects(worldX: number, worldY: number): HitCandidate | null {
    const snapshot = this.room.currentSnapshot;
    const view = this.getView();
    const radiusWorld = HIT_RADIUS_PX / view.scale;

    const index = snapshot.spatialIndex;
    if (!index) return null;

    // Query spatial index with bounding box
    const results = index.query({
      minX: worldX - radiusWorld,
      minY: worldY - radiusWorld,
      maxX: worldX + radiusWorld,
      maxY: worldY + radiusWorld,
    });

    const candidates: HitCandidate[] = [];

    for (const entry of results) {
      const handle = snapshot.objectsById.get(entry.id) as ObjectHandle | undefined;
      if (!handle) continue;

      const candidate = this.testObject(worldX, worldY, radiusWorld, handle);
      if (candidate) candidates.push(candidate);
    }

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    return this.pickBestCandidate(candidates);
  }

  private testObject(
    worldX: number,
    worldY: number,
    radiusWorld: number,
    handle: ObjectHandle
  ): HitCandidate | null {
    const y = handle.y;

    switch (handle.kind) {
      case 'stroke':
      case 'connector': {
        const points = y.get('points') as [number, number][] | undefined;
        if (!points || points.length === 0) return null;

        if (this.strokeHitTest(worldX, worldY, points, radiusWorld)) {
          return {
            id: handle.id,
            kind: handle.kind,
            distance: 0,
            insideInterior: false,
            area: this.computePolylineArea(points),
            isFilled: true, // Strokes are visually "solid"
          };
        }
        return null;
      }

      case 'shape': {
        const frame = y.get('frame') as [number, number, number, number] | undefined;
        if (!frame) return null;

        const shapeType = (y.get('shapeType') as string) || 'rect';
        const strokeWidth = (y.get('width') as number) ?? 1;
        const fillColor = y.get('fillColor') as string | undefined;
        const isFilled = !!fillColor;

        // For SELECT: click inside unfilled shapes still selects them
        const hitResult = this.shapeHitTestForSelection(
          worldX, worldY, radiusWorld, frame, shapeType, strokeWidth, isFilled
        );

        if (hitResult) {
          return {
            id: handle.id,
            kind: 'shape',
            distance: hitResult.distance,
            insideInterior: hitResult.insideInterior,
            area: frame[2] * frame[3],
            isFilled,
          };
        }
        return null;
      }

      case 'text': {
        const frame = y.get('frame') as [number, number, number, number] | undefined;
        if (!frame) return null;

        const [x, yPos, w, h] = frame;
        // Text frames are always selectable by clicking inside
        if (this.pointInRect(worldX, worldY, x, yPos, w, h)) {
          return {
            id: handle.id,
            kind: 'text',
            distance: 0,
            insideInterior: true,
            area: w * h,
            isFilled: true,
          };
        }
        return null;
      }
    }
  }

  private pickBestCandidate(candidates: HitCandidate[]): HitCandidate {
    // Separate interior vs edge hits
    const interiorHits = candidates.filter(c => c.insideInterior);
    const pool = interiorHits.length > 0 ? interiorHits : candidates;

    // Sort by priority
    pool.sort((a, b) => {
      // 1. Kind priority: text=0, stroke/connector=1, shape=2
      const kindPriority = (c: HitCandidate) =>
        c.kind === 'text' ? 0 :
        (c.kind === 'stroke' || c.kind === 'connector') ? 1 : 2;

      const kindDiff = kindPriority(a) - kindPriority(b);
      if (kindDiff !== 0) return kindDiff;

      // 2. Smaller area wins (for shapes - nested shapes win)
      if (a.area !== b.area) return a.area - b.area;

      // 3. Topmost by ULID (higher = newer = on top, so reverse compare)
      return b.id.localeCompare(a.id);
    });

    return pool[0];
  }

  // === Shape-Specific Hit Testing (Selection Mode) ===

  private shapeHitTestForSelection(
    cx: number, cy: number, r: number,
    frame: [number, number, number, number],
    shapeType: string,
    strokeWidth: number,
    _isFilled: boolean // Unused - selection mode always allows interior clicks
  ): { distance: number; insideInterior: boolean } | null {
    // For selection, we select if:
    // 1. Point is inside shape interior (regardless of fill)
    // 2. Point is near stroke edge

    // First check if inside interior
    const insideInterior = this.pointInsideShape(cx, cy, frame, shapeType);

    if (insideInterior) {
      return { distance: 0, insideInterior: true };
    }

    // Check if near stroke edge
    const halfStroke = strokeWidth / 2;
    const nearEdge = this.shapeEdgeHitTest(cx, cy, r + halfStroke, frame, shapeType);

    if (nearEdge) {
      return { distance: nearEdge, insideInterior: false };
    }

    return null;
  }

  private pointInsideShape(cx: number, cy: number, frame: [number, number, number, number], shapeType: string): boolean {
    const [x, y, w, h] = frame;

    switch (shapeType) {
      case 'diamond': {
        // Diamond vertices at frame edge midpoints
        const top: [number, number] = [x + w / 2, y];
        const right: [number, number] = [x + w, y + h / 2];
        const bottom: [number, number] = [x + w / 2, y + h];
        const left: [number, number] = [x, y + h / 2];
        return this.pointInDiamond(cx, cy, top, right, bottom, left);
      }

      case 'ellipse': {
        // Ellipse center and radii
        const ecx = x + w / 2;
        const ecy = y + h / 2;
        const rx = w / 2;
        const ry = h / 2;

        if (rx < 0.001 || ry < 0.001) return false;

        // Normalized distance from center
        const dx = (cx - ecx) / rx;
        const dy = (cy - ecy) / ry;
        return (dx * dx + dy * dy) <= 1;
      }

      case 'rect':
      case 'roundedRect':
      default:
        return this.pointInRect(cx, cy, x, y, w, h);
    }
  }

  private shapeEdgeHitTest(
    cx: number, cy: number, tolerance: number,
    frame: [number, number, number, number],
    shapeType: string
  ): number | null {
    const [x, y, w, h] = frame;

    switch (shapeType) {
      case 'diamond': {
        const top: [number, number] = [x + w / 2, y];
        const right: [number, number] = [x + w, y + h / 2];
        const bottom: [number, number] = [x + w / 2, y + h];
        const left: [number, number] = [x, y + h / 2];

        const edges: [[number, number], [number, number]][] = [
          [top, right],
          [right, bottom],
          [bottom, left],
          [left, top]
        ];

        let minDist = Infinity;
        for (const [p1, p2] of edges) {
          const dist = this.pointToSegmentDistance(cx, cy, p1[0], p1[1], p2[0], p2[1]);
          minDist = Math.min(minDist, dist);
        }
        return minDist <= tolerance ? minDist : null;
      }

      case 'ellipse': {
        const ecx = x + w / 2;
        const ecy = y + h / 2;
        const rx = w / 2;
        const ry = h / 2;

        if (rx < 0.001 || ry < 0.001) return null;

        const dx = (cx - ecx) / rx;
        const dy = (cy - ecy) / ry;
        const normalizedDist = Math.sqrt(dx * dx + dy * dy);
        const avgRadius = (rx + ry) / 2;
        const normalizedTolerance = tolerance / avgRadius;

        const distFromEdge = Math.abs(normalizedDist - 1);
        return distFromEdge <= normalizedTolerance ? distFromEdge * avgRadius : null;
      }

      case 'rect':
      case 'roundedRect':
      default: {
        const edges: [[number, number], [number, number]][] = [
          [[x, y], [x + w, y]],         // Top
          [[x + w, y], [x + w, y + h]], // Right
          [[x + w, y + h], [x, y + h]], // Bottom
          [[x, y + h], [x, y]]          // Left
        ];

        let minDist = Infinity;
        for (const [p1, p2] of edges) {
          const dist = this.pointToSegmentDistance(cx, cy, p1[0], p1[1], p2[0], p2[1]);
          minDist = Math.min(minDist, dist);
        }
        return minDist <= tolerance ? minDist : null;
      }
    }
  }

  // === Geometry Utilities (from EraserTool) ===

  private strokeHitTest(
    px: number,
    py: number,
    points: [number, number][],
    radius: number
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
    x2: number, y2: number
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

  private pointInRect(
    px: number, py: number,
    x: number, y: number, w: number, h: number
  ): boolean {
    return px >= x && px <= x + w && py >= y && py <= y + h;
  }

  private pointInDiamond(
    px: number, py: number,
    top: [number, number],
    right: [number, number],
    bottom: [number, number],
    left: [number, number]
  ): boolean {
    // Use cross product sign consistency for convex polygon
    const vertices = [top, right, bottom, left];
    let sign: number | null = null;

    for (let i = 0; i < 4; i++) {
      const [x1, y1] = vertices[i];
      const [x2, y2] = vertices[(i + 1) % 4];

      // Cross product of edge vector and point-to-vertex vector
      const cross = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);

      if (sign === null) {
        sign = cross >= 0 ? 1 : -1;
      } else if ((cross >= 0 ? 1 : -1) !== sign) {
        return false; // Point is outside
      }
    }

    return true;
  }

  private computePolylineArea(points: [number, number][]): number {
    // Approximate area using bounding box (fast, good enough for selection priority)
    if (points.length === 0) return 0;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of points) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }

    return (maxX - minX) * (maxY - minY);
  }
}
