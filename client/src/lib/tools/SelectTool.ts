import type { IRoomDocManager } from '../room-doc-manager';
import type { WorldRect, SelectionPreview, HandleId } from './types';
import { useSelectionStore, type SelectionKind, type HandleKind, type WorldRect as StoreWorldRect } from '@/stores/selection-store';
import * as Y from 'yjs';

// === Constants ===
const HIT_RADIUS_PX = 6;       // Screen-space hit test radius for selection
const HIT_SLACK_PX = 2.0;      // Forgiving feel for touch/click precision (like EraserTool)
const HANDLE_HIT_PX = 10;      // Screen-space hit radius for handles
const MOVE_THRESHOLD_PX = 4;   // Pixels before drag detected (screen space)
const CLICK_WINDOW_MS = 180;   // Time threshold for gap click disambiguation

// === Types ===

type Phase = 'idle' | 'pendingClick' | 'marquee' | 'translate' | 'scale';

type DownTarget =
  | 'none'
  | 'handle'                   // Clicked resize handle
  | 'objectInSelection'        // Clicked object that IS selected
  | 'objectOutsideSelection'   // Clicked object that is NOT selected
  | 'selectionGap'             // Empty space INSIDE selection bounds
  | 'background';              // Empty space OUTSIDE selection bounds

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

  // Target classification for pointer down
  private downTarget: DownTarget = 'none';
  private downTimeMs: number = 0;

  // Track accumulating envelope for dirty rect optimization (expands, never shrinks)
  private transformEnvelope: WorldRect | null = null;

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
    this.downTimeMs = performance.now();
    this.downTarget = 'none';

    // Convert to screen space for move threshold
    const view = this.getView();
    const [screenX, screenY] = view.worldToCanvas(worldX, worldY);
    this.downScreen = [screenX, screenY];

    const store = useSelectionStore.getState();

    // 1. Check handles first (requires existing selection)
    if (store.selectedIds.length > 0) {
      const handleHit = this.hitTestHandle(worldX, worldY);
      if (handleHit) {
        this.activeHandle = handleHit;
        this.downTarget = 'handle';
        this.phase = 'pendingClick';
        this.invalidateOverlay();
        return;
      }
    }

    // 2. Check object hit
    const hit = this.hitTestObjects(worldX, worldY);
    this.hitAtDown = hit;

    if (hit) {
      const isSelected = store.selectedIds.includes(hit.id);
      this.downTarget = isSelected ? 'objectInSelection' : 'objectOutsideSelection';
      this.phase = 'pendingClick';
      this.invalidateOverlay();
      return;
    }

    // 3. No object hit - check if inside selection bounds
    const selectionBounds = this.computeSelectionBounds();
    if (selectionBounds && this.pointInWorldRect(worldX, worldY, selectionBounds)) {
      this.downTarget = 'selectionGap';
    } else {
      this.downTarget = 'background';
    }

    this.phase = 'pendingClick';
    this.invalidateOverlay();
  }

  move(worldX: number, worldY: number): void {
    const view = this.getView();
    const [screenX, screenY] = view.worldToCanvas(worldX, worldY);

    switch (this.phase) {
      case 'pendingClick': {
        // Compute distance and elapsed time for threshold checks
        if (!this.downScreen) break;

        const dx = screenX - this.downScreen[0];
        const dy = screenY - this.downScreen[1];
        const dist = Math.sqrt(dx * dx + dy * dy);
        const elapsed = performance.now() - this.downTimeMs;

        const passMove = dist > MOVE_THRESHOLD_PX;
        const passTime = elapsed >= CLICK_WINDOW_MS;

        // Target-aware branching
        switch (this.downTarget) {
          case 'handle': {
            if (!passMove) break;
            // Dragging a resize handle
            this.phase = 'scale';
            const bounds = this.computeSelectionBounds();
            if (bounds) {
              const origin = this.getScaleOrigin(this.activeHandle!, bounds);
              const store = useSelectionStore.getState();
              const selectionKind = this.computeSelectionKind(store.selectedIds);
              store.beginScale(bounds, origin, this.activeHandle!, selectionKind);
            }
            const cursor = this.getHandleCursor(this.activeHandle!);
            this.setCursorOverride(cursor);
            this.applyCursor();
            break;
          }

          case 'objectOutsideSelection': {
            if (!passMove) break;
            // Select this object, then translate
            const store = useSelectionStore.getState();
            store.setSelection([this.hitAtDown!.id]);
            this.phase = 'translate';
            const bounds = this.computeSelectionBounds();
            if (bounds) {
              useSelectionStore.getState().beginTranslate(bounds);
            }
            break;
          }

          case 'objectInSelection': {
            if (!passMove) break;
            // Keep selection as-is, translate group
            this.phase = 'translate';
            const bounds = this.computeSelectionBounds();
            if (bounds) {
              useSelectionStore.getState().beginTranslate(bounds);
            }
            break;
          }

          case 'selectionGap': {
            // NEVER marquee from inside selection!
            if (!passMove && !passTime) break;
            // Drag intent → translate selection
            this.phase = 'translate';
            const bounds = this.computeSelectionBounds();
            if (bounds) {
              useSelectionStore.getState().beginTranslate(bounds);
            }
            break;
          }

          case 'background': {
            if (!passMove && !passTime) break;
            // Empty background drag → marquee
            this.phase = 'marquee';
            useSelectionStore.getState().beginMarquee(this.downWorld!);
            useSelectionStore.getState().updateMarquee([worldX, worldY]);
            this.updateMarqueeSelection();
            break;
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

  end(worldX?: number, worldY?: number): void {
    switch (this.phase) {
      case 'pendingClick': {
        // Was a click, not a drag - target-aware finalization
        const store = useSelectionStore.getState();

        // Compute distance and elapsed for selectionGap logic
        let dist = 0;
        const elapsed = performance.now() - this.downTimeMs;
        if (this.downScreen && worldX !== undefined && worldY !== undefined) {
          const view = this.getView();
          const [screenX, screenY] = view.worldToCanvas(worldX, worldY);
          const dx = screenX - this.downScreen[0];
          const dy = screenY - this.downScreen[1];
          dist = Math.sqrt(dx * dx + dy * dy);
        }

        switch (this.downTarget) {
          case 'handle':
            // Clicked handle but didn't drag → no-op
            break;

          case 'objectOutsideSelection':
            // Click → select that object
            store.setSelection([this.hitAtDown!.id]);
            break;

          case 'objectInSelection':
            // Click on already-selected object → "drill down" if multi-select
            if (store.selectedIds.length > 1) {
              store.setSelection([this.hitAtDown!.id]);
            }
            break;

          case 'selectionGap':
            // Quick tap in gap → deselect
            // Long hold or slight movement in gap → keep selection (user was trying to drag)
            if (elapsed < CLICK_WINDOW_MS && dist <= MOVE_THRESHOLD_PX) {
              store.clearSelection();
            }
            // Else: do nothing, selection stays
            break;

          case 'background':
          default:
            // Click on background → deselect
            store.clearSelection();
            break;
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
        const store = useSelectionStore.getState();
        if (store.transform.kind !== 'translate') {
          store.endTransform();
          break;
        }

        const { dx, dy } = store.transform;
        const { selectedIds } = store;

        // Clear transform BEFORE mutate to prevent double-transform visual glitch
        store.endTransform();

        // Only commit if there was actual movement
        if (dx !== 0 || dy !== 0) {
          this.commitTranslate(selectedIds, dx, dy);
        }
        break;
      }

      case 'scale': {
        const store = useSelectionStore.getState();
        if (store.transform.kind !== 'scale') {
          store.endTransform();
          break;
        }

        const { origin, scaleX, scaleY, handleId, selectionKind, handleKind, originBounds } = store.transform;
        const { selectedIds } = store;

        // Clear transform BEFORE mutate
        store.endTransform();

        // Only commit if there was actual scaling
        if (scaleX !== 1 || scaleY !== 1) {
          this.commitScale(selectedIds, origin, scaleX, scaleY, handleId, selectionKind, handleKind, originBounds);
        }
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
    // Invalidate dirty rect before clearing transform state
    if (this.phase === 'translate' || this.phase === 'scale') {
      const bounds = this.computeSelectionBounds();
      if (bounds) {
        const store = useSelectionStore.getState();
        const transformedBounds = this.applyTransformToBounds(bounds, store.transform);
        // Union original + transformed bounds to clear any ghosting
        const unionBounds: WorldRect = {
          minX: Math.min(bounds.minX, transformedBounds.minX),
          minY: Math.min(bounds.minY, transformedBounds.minY),
          maxX: Math.max(bounds.maxX, transformedBounds.maxX),
          maxY: Math.max(bounds.maxY, transformedBounds.maxY),
        };
        this.invalidateWorld(unionBounds);
      }
    }

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
      selectedIds,
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
      const cursor = this.getHandleCursor(handle);
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
    this.downTarget = 'none';
    this.downTimeMs = 0;
    this.transformEnvelope = null;
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

      // bbox format is [minX, minY, maxX, maxY], NOT [x, y, width, height]
      const [bMinX, bMinY, bMaxX, bMaxY] = handle.bbox;
      minX = Math.min(minX, bMinX);
      minY = Math.min(minY, bMinY);
      maxX = Math.max(maxX, bMaxX);
      maxY = Math.max(maxY, bMaxY);
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
      const x1 = ox + (bounds.minX - ox) * transform.scaleX;
      const y1 = oy + (bounds.minY - oy) * transform.scaleY;
      const x2 = ox + (bounds.maxX - ox) * transform.scaleX;
      const y2 = oy + (bounds.maxY - oy) * transform.scaleY;
      // CRITICAL: Normalize for negative scale (flip) - ensures minX < maxX, minY < maxY
      return {
        minX: Math.min(x1, x2),
        minY: Math.min(y1, y2),
        maxX: Math.max(x1, x2),
        maxY: Math.max(y1, y2),
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
    const midX = (bounds.minX + bounds.maxX) / 2;
    const midY = (bounds.minY + bounds.maxY) / 2;

    // Scale origin is opposite edge/corner from the dragged handle
    switch (handle) {
      // Corners - opposite corner
      case 'nw': return [bounds.maxX, bounds.maxY];
      case 'ne': return [bounds.minX, bounds.maxY];
      case 'se': return [bounds.minX, bounds.minY];
      case 'sw': return [bounds.maxX, bounds.minY];
      // Sides - opposite edge midpoint
      case 'n': return [midX, bounds.maxY];
      case 's': return [midX, bounds.minY];
      case 'e': return [bounds.minX, midY];
      case 'w': return [bounds.maxX, midY];
    }
  }

  private computeScaleFactors(worldX: number, worldY: number): { scaleX: number; scaleY: number } {
    const store = useSelectionStore.getState();
    const transform = store.transform;

    if (transform.kind !== 'scale') {
      return { scaleX: 1, scaleY: 1 };
    }

    const { origin, originBounds, handleId } = transform;
    const [ox, oy] = origin;

    // Original dimensions
    const origWidth = originBounds.maxX - originBounds.minX;
    const origHeight = originBounds.maxY - originBounds.minY;

    // Vector from origin to cursor
    const dx = worldX - ox;
    const dy = worldY - oy;

    // Get sign multipliers based on handle direction
    const handleSignX = this.getHandleSignX(handleId);
    const handleSignY = this.getHandleSignY(handleId);

    let scaleX = 1;
    let scaleY = 1;

    const isCorner = ['nw', 'ne', 'se', 'sw'].includes(handleId);
    const isSideH = handleId === 'e' || handleId === 'w';
    const isSideV = handleId === 'n' || handleId === 's';

    if (isCorner) {
      // Corner handles: free scale in both axes (SIGNED for flip)
      scaleX = origWidth > 0 ? (dx * handleSignX) / origWidth : 1;
      scaleY = origHeight > 0 ? (dy * handleSignY) / origHeight : 1;
    } else if (isSideH) {
      // East/West handle: X scales, Y = 1
      scaleX = origWidth > 0 ? (dx * handleSignX) / origWidth : 1;
      scaleY = 1;
    } else if (isSideV) {
      // North/South handle: Y scales, X = 1
      scaleY = origHeight > 0 ? (dy * handleSignY) / origHeight : 1;
      scaleX = 1;
    }

    // Apply minimum scale magnitude (0.1) but preserve sign for flip
    const minScale = 0.1;
    scaleX = Math.sign(scaleX || 1) * Math.max(minScale, Math.abs(scaleX));
    scaleY = Math.sign(scaleY || 1) * Math.max(minScale, Math.abs(scaleY));

    return { scaleX, scaleY };
  }

  /** Returns +1 or -1 for X direction based on handle */
  private getHandleSignX(handleId: HandleId): number {
    switch (handleId) {
      case 'nw': case 'w': case 'sw': return -1;  // Left side
      case 'ne': case 'e': case 'se': return 1;   // Right side
      default: return 1;
    }
  }

  /** Returns +1 or -1 for Y direction based on handle */
  private getHandleSignY(handleId: HandleId): number {
    switch (handleId) {
      case 'nw': case 'n': case 'ne': return -1;  // Top side
      case 'sw': case 's': case 'se': return 1;   // Bottom side
      default: return 1;
    }
  }

  /** Returns appropriate cursor for handle */
  private getHandleCursor(handle: HandleId): string {
    switch (handle) {
      case 'nw': case 'se': return 'nwse-resize';
      case 'ne': case 'sw': return 'nesw-resize';
      case 'n': case 's': return 'ns-resize';
      case 'e': case 'w': return 'ew-resize';
      default: return 'default';
    }
  }

  private invalidateTransformPreview(): void {
    const bounds = this.computeSelectionBounds();
    if (!bounds) return;

    const store = useSelectionStore.getState();
    const transform = store.transform;

    if (transform.kind === 'translate') {
      // Translation: simple offset bounds
      const transformedBounds = this.applyTransformToBounds(bounds, transform);

      // First move: include original bounds
      if (!this.transformEnvelope) {
        this.transformEnvelope = {
          minX: Math.min(bounds.minX, transformedBounds.minX),
          minY: Math.min(bounds.minY, transformedBounds.minY),
          maxX: Math.max(bounds.maxX, transformedBounds.maxX),
          maxY: Math.max(bounds.maxY, transformedBounds.maxY),
        };
      } else {
        // ACCUMULATE: expand envelope (never shrink)
        this.transformEnvelope = {
          minX: Math.min(this.transformEnvelope.minX, transformedBounds.minX),
          minY: Math.min(this.transformEnvelope.minY, transformedBounds.minY),
          maxX: Math.max(this.transformEnvelope.maxX, transformedBounds.maxX),
          maxY: Math.max(this.transformEnvelope.maxY, transformedBounds.maxY),
        };
      }

      this.invalidateWorld(this.transformEnvelope);
      return;
    }

    if (transform.kind === 'scale') {
      // Scale: per-object bounds based on transform strategy
      const snapshot = this.room.currentSnapshot;
      const { selectionKind, handleKind, origin, scaleX, scaleY, originBounds } = transform;
      const [ox, oy] = origin;

      let combinedBounds: WorldRect | null = null;

      for (const id of store.selectedIds) {
        const handle = snapshot.objectsById.get(id);
        if (!handle) continue;

        const [minX, minY, maxX, maxY] = handle.bbox;
        const isStroke = handle.kind === 'stroke' || handle.kind === 'connector';
        let objBounds: WorldRect;

        // CASE 1: Mixed + side + stroke = TRANSLATE (not scale)
        if (selectionKind === 'mixed' && handleKind === 'side' && isStroke) {
          const { dx, dy } = this.computeStrokeTranslation(handle, originBounds, scaleX, scaleY, origin);
          objBounds = {
            minX: minX + dx,
            minY: minY + dy,
            maxX: maxX + dx,
            maxY: maxY + dy,
          };
        } else if (isStroke) {
          // CASE 2: Stroke scaling = uniform scale
          const uniformScale = this.computeUniformScaleWithDiagonalFlip(scaleX, scaleY);
          const absScale = Math.abs(uniformScale);
          const x1 = ox + (minX - ox) * uniformScale;
          const y1 = oy + (minY - oy) * uniformScale;
          const x2 = ox + (maxX - ox) * uniformScale;
          const y2 = oy + (maxY - oy) * uniformScale;
          objBounds = {
            minX: Math.min(x1, x2),
            minY: Math.min(y1, y2),
            maxX: Math.max(x1, x2),
            maxY: Math.max(y1, y2),
          };
          // Expand for scaled stroke width
          const origWidth = (handle.y.get('width') as number) ?? 2;
          const scaledWidth = origWidth * absScale;
          const delta = (scaledWidth - origWidth) * 0.5;
          if (delta > 0) {
            objBounds.minX -= delta;
            objBounds.minY -= delta;
            objBounds.maxX += delta;
            objBounds.maxY += delta;
          }
        } else {
          // CASE 3: Shape/text scaling
          let sx = scaleX, sy = scaleY;
          if (selectionKind === 'mixed' && handleKind === 'corner') {
            const uniformScale = this.computeUniformScaleWithDiagonalFlip(scaleX, scaleY);
            sx = uniformScale;
            sy = uniformScale;
          }
          const x1 = ox + (minX - ox) * sx;
          const y1 = oy + (minY - oy) * sy;
          const x2 = ox + (maxX - ox) * sx;
          const y2 = oy + (maxY - oy) * sy;
          objBounds = {
            minX: Math.min(x1, x2),
            minY: Math.min(y1, y2),
            maxX: Math.max(x1, x2),
            maxY: Math.max(y1, y2),
          };
        }

        // Union with combined bounds
        if (!combinedBounds) {
          combinedBounds = objBounds;
        } else {
          combinedBounds = {
            minX: Math.min(combinedBounds.minX, objBounds.minX),
            minY: Math.min(combinedBounds.minY, objBounds.minY),
            maxX: Math.max(combinedBounds.maxX, objBounds.maxX),
            maxY: Math.max(combinedBounds.maxY, objBounds.maxY),
          };
        }
      }

      if (!combinedBounds) return;

      // Include original bounds
      combinedBounds = {
        minX: Math.min(combinedBounds.minX, bounds.minX),
        minY: Math.min(combinedBounds.minY, bounds.minY),
        maxX: Math.max(combinedBounds.maxX, bounds.maxX),
        maxY: Math.max(combinedBounds.maxY, bounds.maxY),
      };

      // ACCUMULATE envelope (expand, never shrink)
      if (!this.transformEnvelope) {
        this.transformEnvelope = combinedBounds;
      } else {
        this.transformEnvelope = {
          minX: Math.min(this.transformEnvelope.minX, combinedBounds.minX),
          minY: Math.min(this.transformEnvelope.minY, combinedBounds.minY),
          maxX: Math.max(this.transformEnvelope.maxX, combinedBounds.maxX),
          maxY: Math.max(this.transformEnvelope.maxY, combinedBounds.maxY),
        };
      }

      this.invalidateWorld(this.transformEnvelope);
    }
  }

  // === Commit Methods ===

  private commitTranslate(selectedIds: string[], dx: number, dy: number): void {
    const snapshot = this.room.currentSnapshot;

    this.room.mutate((ydoc: Y.Doc) => {
      const root = ydoc.getMap('root');
      const objects = root.get('objects') as Y.Map<Y.Map<unknown>>;

      for (const id of selectedIds) {
        const handle = snapshot.objectsById.get(id);
        if (!handle) continue;

        const yMap = objects.get(id);
        if (!yMap) continue;

        if (handle.kind === 'stroke' || handle.kind === 'connector') {
          // Offset all points
          const points = yMap.get('points') as [number, number][];
          if (!points) continue;
          const newPoints: [number, number][] = points.map(([x, y]) => [x + dx, y + dy]);
          yMap.set('points', newPoints);
        } else {
          // Offset frame (shapes, text)
          const frame = yMap.get('frame') as [number, number, number, number];
          if (!frame) continue;
          const [x, y, w, h] = frame;
          yMap.set('frame', [x + dx, y + dy, w, h]);
        }
      }
    });
  }

  private commitScale(
    selectedIds: string[],
    origin: [number, number],
    scaleX: number,
    scaleY: number,
    _handleId: HandleId,
    selectionKind: SelectionKind,
    handleKind: HandleKind,
    originBounds: StoreWorldRect
  ): void {
    const snapshot = this.room.currentSnapshot;
    const [ox, oy] = origin;

    this.room.mutate((ydoc: Y.Doc) => {
      const root = ydoc.getMap('root');
      const objects = root.get('objects') as Y.Map<Y.Map<unknown>>;

      for (const id of selectedIds) {
        const handle = snapshot.objectsById.get(id);
        if (!handle) continue;

        const yMap = objects.get(id);
        if (!yMap) continue;

        const isStroke = handle.kind === 'stroke' || handle.kind === 'connector';

        // CASE 1: Mixed + side + stroke = TRANSLATE ONLY (Miro-like behavior)
        if (selectionKind === 'mixed' && handleKind === 'side' && isStroke) {
          const { dx, dy } = this.computeStrokeTranslation(handle, originBounds, scaleX, scaleY, origin);
          const points = yMap.get('points') as [number, number][];
          if (!points) continue;
          const newPoints: [number, number][] = points.map(([x, y]) => [x + dx, y + dy]);
          yMap.set('points', newPoints);
          // Width UNCHANGED for translation
          continue;
        }

        // CASE 2: Stroke scaling (strokesOnly or mixed+corner)
        if (isStroke) {
          // Use diagonal flip rule for strokes
          const uniformScale = this.computeUniformScaleWithDiagonalFlip(scaleX, scaleY);

          const points = yMap.get('points') as [number, number][];
          if (!points) continue;
          const newPoints: [number, number][] = points.map(([x, y]) => [
            ox + (x - ox) * uniformScale,
            oy + (y - oy) * uniformScale,
          ]);
          yMap.set('points', newPoints);

          // CRITICAL: Scale stroke width for WYSIWYG
          const oldWidth = (yMap.get('width') as number) ?? 2;
          yMap.set('width', oldWidth * Math.abs(uniformScale));
          continue;
        }

        // CASE 3: Shape scaling
        // Determine scale factors based on selection context
        let sx = scaleX;
        let sy = scaleY;

        if (selectionKind === 'mixed' && handleKind === 'corner') {
          // Mixed + corner: shapes use UNIFORM scale (consistent with strokes)
          const uniformScale = this.computeUniformScaleWithDiagonalFlip(scaleX, scaleY);
          sx = uniformScale;
          sy = uniformScale;
        }
        // Else: shapes-only or mixed+side: use raw scaleX/scaleY (non-uniform allowed)

        const frame = yMap.get('frame') as [number, number, number, number];
        if (!frame) continue;
        const [x, y, w, h] = frame;

        // Scale corners around origin
        const newX1 = ox + (x - ox) * sx;
        const newY1 = oy + (y - oy) * sy;
        const newX2 = ox + ((x + w) - ox) * sx;
        const newY2 = oy + ((y + h) - oy) * sy;

        // Handle negative scale (flip) - ensure positive dimensions
        yMap.set('frame', [
          Math.min(newX1, newX2),
          Math.min(newY1, newY2),
          Math.abs(newX2 - newX1),
          Math.abs(newY2 - newY1),
        ]);
        // Shape stroke width: UNCHANGED (preserved)
      }
    });
  }

  /**
   * Compute selection kind based on object types in selection.
   * Returns 'strokesOnly', 'shapesOnly', 'mixed', or 'none'.
   */
  private computeSelectionKind(selectedIds: string[]): SelectionKind {
    if (selectedIds.length === 0) return 'none';

    const snapshot = this.room.currentSnapshot;
    let hasStrokes = false;
    let hasShapes = false;

    for (const id of selectedIds) {
      const handle = snapshot.objectsById.get(id);
      if (!handle) continue;

      if (handle.kind === 'stroke' || handle.kind === 'connector') {
        hasStrokes = true;
      } else {
        hasShapes = true;
      }

      // Early exit if mixed
      if (hasStrokes && hasShapes) return 'mixed';
    }

    if (hasStrokes && !hasShapes) return 'strokesOnly';
    if (hasShapes && !hasStrokes) return 'shapesOnly';
    return 'none';
  }

  /**
   * Compute translation for a stroke in mixed + side handle scenario.
   * Strokes maintain their relative position within the selection bounds.
   */
  private computeStrokeTranslation(
    handle: ObjectHandle,
    originBounds: WorldRect,
    scaleX: number,
    scaleY: number,
    origin: [number, number]
  ): { dx: number; dy: number } {
    // Get stroke center from bbox
    const [minX, minY, maxX, maxY] = handle.bbox;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    // Relative position in original bounds (0-1)
    const bw = originBounds.maxX - originBounds.minX;
    const bh = originBounds.maxY - originBounds.minY;
    const relX = bw > 0 ? (cx - originBounds.minX) / bw : 0.5;
    const relY = bh > 0 ? (cy - originBounds.minY) / bh : 0.5;

    // Compute new bounds after scale
    const [ox, oy] = origin;
    const newMinX = ox + (originBounds.minX - ox) * scaleX;
    const newMaxX = ox + (originBounds.maxX - ox) * scaleX;
    const newMinY = oy + (originBounds.minY - oy) * scaleY;
    const newMaxY = oy + (originBounds.maxY - oy) * scaleY;

    // Normalize for flip (ensure min < max)
    const actMinX = Math.min(newMinX, newMaxX);
    const actMaxX = Math.max(newMinX, newMaxX);
    const actMinY = Math.min(newMinY, newMaxY);
    const actMaxY = Math.max(newMinY, newMaxY);

    // New center (same relative position in new bounds)
    const ncx = actMinX + relX * (actMaxX - actMinX);
    const ncy = actMinY + relY * (actMaxY - actMinY);

    return { dx: ncx - cx, dy: ncy - cy };
  }

  /**
   * Compute uniform scale with diagonal flip rule for strokes.
   * Returns scale factor that preserves aspect ratio.
   * Flip only allowed when BOTH axes would flip (diagonal).
   */
  private computeUniformScaleWithDiagonalFlip(scaleX: number, scaleY: number): number {
    const minScale = 0.05;
    const absMax = Math.max(Math.abs(scaleX), Math.abs(scaleY), minScale);

    // Diagonal flip: only when BOTH are negative
    const flipped = scaleX < 0 && scaleY < 0;
    return flipped ? -absMax : absMax;
  }

  private updateMarqueeSelection(): void {
    const store = useSelectionStore.getState();
    const { marquee } = store;

    if (!marquee.active || !marquee.anchor || !marquee.current) return;

    const marqueeRect: WorldRect = {
      minX: Math.min(marquee.anchor[0], marquee.current[0]),
      minY: Math.min(marquee.anchor[1], marquee.current[1]),
      maxX: Math.max(marquee.anchor[0], marquee.current[0]),
      maxY: Math.max(marquee.anchor[1], marquee.current[1]),
    };

    // Query spatial index for objects with bbox intersecting marquee (fast filter)
    const snapshot = this.room.currentSnapshot;
    const index = snapshot.spatialIndex;
    if (!index) return;

    const results = index.query(marqueeRect);

    // Geometry-aware intersection test for each candidate
    // Select objects whose actual geometry intersects marquee (industry standard)
    const selectedIds: string[] = [];
    for (const entry of results) {
      const handle = snapshot.objectsById.get(entry.id) as ObjectHandle | undefined;
      if (!handle) continue;

      // Use precise geometry intersection test
      if (this.objectIntersectsRect(handle, marqueeRect)) {
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

    // Test corners first (they take priority)
    const corners: { id: HandleId; x: number; y: number }[] = [
      { id: 'nw', x: bounds.minX, y: bounds.minY },
      { id: 'ne', x: bounds.maxX, y: bounds.minY },
      { id: 'se', x: bounds.maxX, y: bounds.maxY },
      { id: 'sw', x: bounds.minX, y: bounds.maxY },
    ];

    for (const h of corners) {
      const dx = worldX - h.x;
      const dy = worldY - h.y;
      if (dx * dx + dy * dy <= handleRadius * handleRadius) {
        return h.id;
      }
    }

    // Test side edges (not rendered, but for cursor/scaling)
    // Check if point is near edge and within bounds extents
    const edgeTolerance = handleRadius;

    // North edge (top)
    if (Math.abs(worldY - bounds.minY) <= edgeTolerance &&
        worldX > bounds.minX + handleRadius && worldX < bounds.maxX - handleRadius) {
      return 'n';
    }
    // South edge (bottom)
    if (Math.abs(worldY - bounds.maxY) <= edgeTolerance &&
        worldX > bounds.minX + handleRadius && worldX < bounds.maxX - handleRadius) {
      return 's';
    }
    // West edge (left)
    if (Math.abs(worldX - bounds.minX) <= edgeTolerance &&
        worldY > bounds.minY + handleRadius && worldY < bounds.maxY - handleRadius) {
      return 'w';
    }
    // East edge (right)
    if (Math.abs(worldX - bounds.maxX) <= edgeTolerance &&
        worldY > bounds.minY + handleRadius && worldY < bounds.maxY - handleRadius) {
      return 'e';
    }

    return null;
  }

  private hitTestObjects(worldX: number, worldY: number): HitCandidate | null {
    const snapshot = this.room.currentSnapshot;
    const view = this.getView();
    const radiusWorld = (HIT_RADIUS_PX + HIT_SLACK_PX) / view.scale;

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

        // Add stroke width to tolerance for more forgiving hit detection (like EraserTool)
        const strokeWidth = (y.get('width') as number) ?? 2;
        const tolerance = radiusWorld + strokeWidth / 2;

        if (this.strokeHitTest(worldX, worldY, points, tolerance)) {
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

  /**
   * Z-order aware candidate selection.
   * Scans from topmost (highest ULID) to bottommost, respecting visual occlusion.
   *
   * Key insight: Unfilled shape interiors are "transparent" for selection -
   * we keep scanning for paint underneath. But they ARE selectable if nothing
   * else is found.
   */
  private pickBestCandidate(candidates: HitCandidate[]): HitCandidate {
    if (candidates.length === 1) return candidates[0];

    // Sort by Z: ULID descending = newest/topmost first
    const sorted = [...candidates].sort((a, b) =>
      a.id < b.id ? 1 : a.id > b.id ? -1 : 0
    );

    type PaintClass = 'ink' | 'fill';

    // Unfilled shape interior = transparent logical region (not paint)
    const isFrameInterior = (c: HitCandidate): boolean =>
      c.kind === 'shape' && !c.isFilled && c.insideInterior;

    // Everything else that actually paints pixels at this point
    const classifyPaint = (c: HitCandidate): PaintClass | null => {
      if (c.kind === 'stroke' || c.kind === 'connector' || c.kind === 'text') {
        return 'ink';
      }

      if (c.kind === 'shape') {
        if (c.isFilled) {
          return 'fill';  // Filled shape interior or border
        }
        if (!c.isFilled && !c.insideInterior) {
          return 'ink';   // Unfilled shape BORDER (outline stroke)
        }
        return null;      // Unfilled shape interior = transparent
      }

      return 'ink';  // Fallback: treat as paint
    };

    let bestFrame: HitCandidate | null = null;   // Smallest unfilled interior
    let firstPaint: HitCandidate | null = null;  // First visible paint in Z
    let firstPaintClass: PaintClass | null = null;

    // Scan from topmost to bottommost, respecting occlusion
    for (const c of sorted) {
      if (isFrameInterior(c)) {
        // Transparent frame region: remember smallest, keep scanning
        if (!bestFrame || c.area < bestFrame.area) {
          bestFrame = c;
        }
        continue;  // Don't stop - look for paint underneath
      }

      const paintClass = classifyPaint(c);
      if (paintClass !== null) {
        // Found first painted thing - this occludes everything below
        firstPaint = c;
        firstPaintClass = paintClass;
        break;  // Stop scanning
      }
    }

    // Case 1: Only frame interiors, no paint at this pixel
    if (!firstPaint && bestFrame) {
      return bestFrame;  // Return smallest frame (most nested)
    }

    // Case 2: No paint and no frames (shouldn't happen)
    if (!firstPaint) {
      return sorted[0];  // Fallback to topmost
    }

    // Case 3: First painted thing is ink (stroke/text/connector/border)
    // Ink ALWAYS beats frames
    if (firstPaintClass === 'ink') {
      return firstPaint;
    }

    // Case 4: First painted thing is a filled shape interior
    if (!bestFrame) {
      return firstPaint;  // No frames to compare with
    }

    // Case 5: Both filled shape and frame(s) contain the cursor
    // "More enclosed" = smaller region wins
    if (bestFrame.area < firstPaint.area) return bestFrame;
    if (firstPaint.area < bestFrame.area) return firstPaint;

    // Equal areas: tie-break by Z (sorted is topmost-first)
    const idxPaint = sorted.indexOf(firstPaint);
    const idxFrame = sorted.indexOf(bestFrame);
    return idxPaint <= idxFrame ? firstPaint : bestFrame;
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

  // === Geometry Helpers for Marquee Selection ===

  private pointInWorldRect(px: number, py: number, rect: WorldRect): boolean {
    return px >= rect.minX && px <= rect.maxX && py >= rect.minY && py <= rect.maxY;
  }

  private rectsIntersect(a: WorldRect, b: WorldRect): boolean {
    return a.minX <= b.maxX && a.maxX >= b.minX &&
           a.minY <= b.maxY && a.maxY >= b.minY;
  }

  private segmentsIntersect(
    x1: number, y1: number, x2: number, y2: number,
    x3: number, y3: number, x4: number, y4: number
  ): boolean {
    // CCW orientation test
    const ccw = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => {
      return (cy - ay) * (bx - ax) > (by - ay) * (cx - ax);
    };

    return (
      ccw(x1, y1, x3, y3, x4, y4) !== ccw(x2, y2, x3, y3, x4, y4) &&
      ccw(x1, y1, x2, y2, x3, y3) !== ccw(x1, y1, x2, y2, x4, y4)
    );
  }

  private segmentIntersectsRect(
    x1: number, y1: number, x2: number, y2: number,
    rect: WorldRect
  ): boolean {
    // Check if either endpoint is inside rect
    if (this.pointInWorldRect(x1, y1, rect) || this.pointInWorldRect(x2, y2, rect)) {
      return true;
    }

    // Check if segment crosses any rect edge
    const edges: [[number, number], [number, number]][] = [
      [[rect.minX, rect.minY], [rect.maxX, rect.minY]], // Top
      [[rect.maxX, rect.minY], [rect.maxX, rect.maxY]], // Right
      [[rect.maxX, rect.maxY], [rect.minX, rect.maxY]], // Bottom
      [[rect.minX, rect.maxY], [rect.minX, rect.minY]], // Left
    ];

    for (const [[ex1, ey1], [ex2, ey2]] of edges) {
      if (this.segmentsIntersect(x1, y1, x2, y2, ex1, ey1, ex2, ey2)) {
        return true;
      }
    }

    return false;
  }

  private polylineIntersectsRect(points: [number, number][], rect: WorldRect): boolean {
    // Check if any point is inside rect
    for (const [px, py] of points) {
      if (this.pointInWorldRect(px, py, rect)) return true;
    }

    // Check if any segment intersects rect
    for (let i = 0; i < points.length - 1; i++) {
      if (this.segmentIntersectsRect(
        points[i][0], points[i][1],
        points[i + 1][0], points[i + 1][1],
        rect
      )) {
        return true;
      }
    }

    return false;
  }

  private ellipseIntersectsRect(
    ecx: number, ecy: number, rx: number, ry: number,
    rect: WorldRect
  ): boolean {
    // Quick bounds check first
    const ellipseBounds: WorldRect = {
      minX: ecx - rx, minY: ecy - ry,
      maxX: ecx + rx, maxY: ecy + ry
    };
    if (!this.rectsIntersect(ellipseBounds, rect)) return false;

    // Check if ellipse center is inside rect
    if (this.pointInWorldRect(ecx, ecy, rect)) return true;

    // Check if any rect corner is inside ellipse
    const corners: [number, number][] = [
      [rect.minX, rect.minY], [rect.maxX, rect.minY],
      [rect.maxX, rect.maxY], [rect.minX, rect.maxY]
    ];
    for (const [cx, cy] of corners) {
      const dx = (cx - ecx) / rx;
      const dy = (cy - ecy) / ry;
      if (dx * dx + dy * dy <= 1) return true;
    }

    // Check if ellipse edge intersects rect edges (sample ellipse perimeter)
    const SAMPLES = 16;
    for (let i = 0; i < SAMPLES; i++) {
      const angle = (i / SAMPLES) * Math.PI * 2;
      const px = ecx + rx * Math.cos(angle);
      const py = ecy + ry * Math.sin(angle);
      if (this.pointInWorldRect(px, py, rect)) return true;
    }

    return false;
  }

  private diamondIntersectsRect(
    top: [number, number], right: [number, number],
    bottom: [number, number], left: [number, number],
    rect: WorldRect
  ): boolean {
    // Check if any diamond vertex is inside rect
    for (const [vx, vy] of [top, right, bottom, left]) {
      if (this.pointInWorldRect(vx, vy, rect)) return true;
    }

    // Check if any rect corner is inside diamond
    const corners: [number, number][] = [
      [rect.minX, rect.minY], [rect.maxX, rect.minY],
      [rect.maxX, rect.maxY], [rect.minX, rect.maxY]
    ];
    for (const [cx, cy] of corners) {
      if (this.pointInDiamond(cx, cy, top, right, bottom, left)) return true;
    }

    // Check if any diamond edge intersects rect
    const diamondEdges: [[number, number], [number, number]][] = [
      [top, right], [right, bottom], [bottom, left], [left, top]
    ];
    for (const [[x1, y1], [x2, y2]] of diamondEdges) {
      if (this.segmentIntersectsRect(x1, y1, x2, y2, rect)) return true;
    }

    return false;
  }

  // === Marquee Selection Geometry Dispatch ===

  private objectIntersectsRect(handle: ObjectHandle, rect: WorldRect): boolean {
    const y = handle.y;

    switch (handle.kind) {
      case 'stroke':
      case 'connector': {
        const points = y.get('points') as [number, number][] | undefined;
        if (!points || points.length === 0) return false;
        return this.polylineIntersectsRect(points, rect);
      }

      case 'shape': {
        const frame = y.get('frame') as [number, number, number, number] | undefined;
        if (!frame) return false;

        const shapeType = (y.get('shapeType') as string) || 'rect';
        const [x, yPos, w, h] = frame;

        switch (shapeType) {
          case 'ellipse': {
            return this.ellipseIntersectsRect(
              x + w / 2, yPos + h / 2, w / 2, h / 2, rect
            );
          }
          case 'diamond': {
            const top: [number, number] = [x + w / 2, yPos];
            const right: [number, number] = [x + w, yPos + h / 2];
            const bottom: [number, number] = [x + w / 2, yPos + h];
            const left: [number, number] = [x, yPos + h / 2];
            return this.diamondIntersectsRect(top, right, bottom, left, rect);
          }
          case 'rect':
          case 'roundedRect':
          default: {
            // Rect vs rect intersection
            const shapeBounds: WorldRect = { minX: x, minY: yPos, maxX: x + w, maxY: yPos + h };
            return this.rectsIntersect(shapeBounds, rect);
          }
        }
      }

      case 'text': {
        const frame = y.get('frame') as [number, number, number, number] | undefined;
        if (!frame) return false;
        const [x, yPos, w, h] = frame;
        const textBounds: WorldRect = { minX: x, minY: yPos, maxX: x + w, maxY: yPos + h };
        return this.rectsIntersect(textBounds, rect);
      }

      default:
        return false;
    }
  }
}
