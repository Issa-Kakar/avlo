import type { WorldRect, HandleId, PointerTool, PreviewData } from './types';
import {
  useSelectionStore,
  type SelectionKind,
  type HandleKind,
  type WorldRect as StoreWorldRect,
  computeHandles,
  getScaleOrigin,
  getHandleCursor,
} from '@/stores/selection-store';
import { useCameraStore, worldToCanvas } from '@/stores/camera-store';
import {
  computeStrokeTranslation,
  applyTransformToBounds,
  computeScaleFactors,
  applyUniformScaleToPoints,
  applyUniformScaleToFrame,
  applyTransformToFrame,
} from '@/lib/geometry/transform';
import {
  unionBounds,
  expandEnvelope,
  translateBounds,
  scaleBoundsAround,
  pointsToWorldBounds,
  expandBounds,
  computeUniformScaleBounds,
  computeRawGeometryBounds,
} from '@/lib/geometry/bounds';
import {
  pointInRect,
  pointInWorldRect,
  strokeHitTest,
  computePolylineArea,
  pointInsideShape,
  shapeEdgeHitTest,
  hitTestHandle,
  objectIntersectsRect,
} from '@/lib/geometry/hit-testing';
import type { ObjectHandle } from '@avlo/shared';
import {
  getFrame,
  getPoints,
  getWidth,
  getShapeType,
  getFillColor,
  bboxTupleToWorldBounds,
} from '@avlo/shared';
import * as Y from 'yjs';
import { getActiveRoomDoc, getCurrentSnapshot } from '@/canvas/room-runtime';
import { invalidateWorld, invalidateOverlay } from '@/canvas/invalidation-helpers';
import { applyCursor, setCursorOverride } from '@/stores/device-ui-store';

// === Constants ===
const HIT_RADIUS_PX = 6;       // Screen-space hit test radius for selection
const HIT_SLACK_PX = 2.0;      // Forgiving feel for touch/click precision (like EraserTool)
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

// === SelectTool Class ===

/**
 * SelectTool - Object selection, translation, and scaling tool
 *
 * Zero-arg constructor: reads all dependencies from module-level singletons.
 * - Room: getActiveRoomDoc()
 * - Invalidation: invalidation-helpers.ts
 * - Cursor: useDeviceUIStore (applyCursor, setCursorOverride)
 * - Camera/Selection: Zustand stores
 */
export class SelectTool implements PointerTool {
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

  constructor() {}

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
    const [screenX, screenY] = worldToCanvas(worldX, worldY);
    this.downScreen = [screenX, screenY];

    const store = useSelectionStore.getState();

    // 1. Check handles first (requires existing selection)
    if (store.selectedIds.length > 0) {
      const selectionBounds = this.computeSelectionBounds();
      const { scale } = useCameraStore.getState();
      const handleHit = selectionBounds ? hitTestHandle(worldX, worldY, selectionBounds, scale) : null;
      if (handleHit) {
        this.activeHandle = handleHit;
        this.downTarget = 'handle';
        this.phase = 'pendingClick';
        invalidateOverlay();
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
      invalidateOverlay();
      return;
    }

    // 3. No object hit - check if inside selection bounds
    const selectionBounds = this.computeSelectionBounds();
    if (selectionBounds && pointInWorldRect(worldX, worldY, selectionBounds)) {
      this.downTarget = 'selectionGap';
    } else {
      this.downTarget = 'background';
    }

    this.phase = 'pendingClick';
    invalidateOverlay();
  }

  move(worldX: number, worldY: number): void {
    const [screenX, screenY] = worldToCanvas(worldX, worldY);

    switch (this.phase) {
      case 'idle': {
        // Handle hover cursor when not in a gesture
        this.handleHoverCursor(worldX, worldY);
        break;
      }

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

            const store = useSelectionStore.getState();
            const selectionKind = this.computeSelectionKind(store.selectedIds);

            // Geometry-based bounds for transform origin (fixes anchor sliding)
            const transformBounds = this.computeTransformBoundsForScale();
            // Padded bounds for dirty rects (visual coverage)
            const bboxBounds = this.computeSelectionBounds();

            if (transformBounds && bboxBounds) {
              // CRITICAL: Use geometry bounds for origin
              const origin = getScaleOrigin(this.activeHandle!, transformBounds);
              // Compute initial delta: distance from origin to click position
              // This ensures scale=1.0 exactly when cursor is at starting position
              const initialDelta: [number, number] = [
                this.downWorld![0] - origin[0],
                this.downWorld![1] - origin[1],
              ];
              store.beginScale(bboxBounds, transformBounds, origin, this.activeHandle!, selectionKind, initialDelta);
            }
            const cursor = getHandleCursor(this.activeHandle!);
            setCursorOverride(cursor);
            applyCursor();
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
          const transform = useSelectionStore.getState().transform;
          if (transform.kind !== 'scale') break;
          const { scaleX, scaleY } = computeScaleFactors(worldX, worldY, transform);
          useSelectionStore.getState().updateScale(scaleX, scaleY);

          // Invalidate dirty rect
          this.invalidateTransformPreview();
        }
        break;
      }
    }

    invalidateOverlay();
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
          const [screenX, screenY] = worldToCanvas(worldX, worldY);
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
    setCursorOverride(null);
    applyCursor();

    this.resetState();
    invalidateOverlay();
  }

  cancel(): void {
    // Invalidate dirty rect before clearing transform state
    if (this.phase === 'translate' || this.phase === 'scale') {
      const bounds = this.computeSelectionBounds();
      if (bounds) {
        const store = useSelectionStore.getState();
        const transformedBounds = applyTransformToBounds(bounds, store.transform);
        // Union original + transformed bounds to clear any ghosting
        invalidateWorld(unionBounds(bounds, transformedBounds));
      }
    }

    useSelectionStore.getState().cancelTransform();
    useSelectionStore.getState().cancelMarquee();
    // Clear any cursor override on cancel
    setCursorOverride(null);
    applyCursor();
    this.resetState();
    invalidateOverlay();
  }

  isActive(): boolean {
    return this.phase !== 'idle';
  }

  getPointerId(): number | null {
    return this.pointerId;
  }

  getPreview(): PreviewData | null {
    const store = useSelectionStore.getState();
    const { selectedIds, transform, marquee } = store;

    // Compute marquee rect if active
    let marqueeRect: WorldRect | null = null;
    if (marquee.active && marquee.anchor && marquee.current) {
      marqueeRect = pointsToWorldBounds(marquee.anchor, marquee.current);
    }

    // Compute selection bounds with transform applied
    let selectionBounds: WorldRect | null = null;
    let handles: { id: HandleId; x: number; y: number }[] | null = null;

    if (selectedIds.length > 0) {
      // During scale, use originBounds (geometry-based) so selection rect aligns with transform
      // During idle/translate, use bbox-based bounds for visual stroke coverage
      let baseBounds: WorldRect | null = null;
      if (transform.kind === 'scale') {
        baseBounds = transform.originBounds;
      } else {
        baseBounds = this.computeSelectionBounds();
      }

      if (baseBounds) {
        selectionBounds = applyTransformToBounds(baseBounds, transform);
        handles = computeHandles(selectionBounds);
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
    invalidateOverlay();
  }

  /**
   * Called when pointer leaves canvas - clears any hover cursor state.
   */
  onPointerLeave(): void {
    setCursorOverride(null);
    applyCursor();
  }

  /**
   * Handle hover cursor detection when idle.
   * Called by move() when phase is 'idle'.
   */
  private handleHoverCursor(worldX: number, worldY: number): void {
    const store = useSelectionStore.getState();
    if (store.selectedIds.length === 0) {
      setCursorOverride(null);
      applyCursor();
      return;
    }

    const bounds = this.computeSelectionBounds();
    if (!bounds) {
      setCursorOverride(null);
      applyCursor();
      return;
    }
    const { scale } = useCameraStore.getState();
    const handle = hitTestHandle(worldX, worldY, bounds, scale);
    if (handle) {
      const cursor = getHandleCursor(handle);
      setCursorOverride(cursor);
    } else {
      setCursorOverride(null);
    }
    applyCursor();
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

    const snapshot = getCurrentSnapshot();
    let result: WorldRect | null = null;

    for (const id of selectedIds) {
      const handle = snapshot.objectsById.get(id);
      if (!handle) continue;
      result = expandEnvelope(result, bboxTupleToWorldBounds(handle.bbox));
    }

    return result;
  }

  /**
   * Compute geometry-based bounds for scale transforms.
   * Unlike computeSelectionBounds() which uses padded bboxes,
   * this extracts raw geometry bounds:
   * - Shapes/text: raw frame [x, y, w, h]
   * - Strokes/connectors: raw points min/max (no width inflation)
   *
   * Used for scale origin computation to prevent anchor sliding.
   */
  private computeTransformBoundsForScale(): WorldRect | null {
    const store = useSelectionStore.getState();
    const { selectedIds } = store;
    if (selectedIds.length === 0) return null;

    const snapshot = getCurrentSnapshot();

    // Collect handles for selected objects
    const handles: ObjectHandle[] = [];
    for (const id of selectedIds) {
      const handle = snapshot.objectsById.get(id);
      if (handle) handles.push(handle);
    }

    return computeRawGeometryBounds(handles);
  }

  private invalidateTransformPreview(): void {
    const bounds = this.computeSelectionBounds();
    if (!bounds) return;

    const store = useSelectionStore.getState();
    const transform = store.transform;

    if (transform.kind === 'translate') {
      // Translation: simple offset bounds
      const transformedBounds = applyTransformToBounds(bounds, transform);

      // First move: include original bounds
      if (!this.transformEnvelope) {
        this.transformEnvelope = unionBounds(bounds, transformedBounds);
      } else {
        // ACCUMULATE: expand envelope (never shrink)
        this.transformEnvelope = expandEnvelope(this.transformEnvelope, transformedBounds);
      }

      invalidateWorld(this.transformEnvelope);
      return;
    }

    if (transform.kind === 'scale') {
      // Scale: per-object bounds based on transform strategy
      const snapshot = getCurrentSnapshot();
      const { selectionKind, handleKind, handleId, origin, scaleX, scaleY, originBounds, bboxBounds } = transform;

      let combinedBounds: WorldRect | null = null;

      for (const id of store.selectedIds) {
        const handle = snapshot.objectsById.get(id);
        if (!handle) continue;

        const bbox = bboxTupleToWorldBounds(handle.bbox);
        const isStroke = handle.kind === 'stroke' || handle.kind === 'connector';
        let objBounds: WorldRect;

        // CASE 1: Mixed + side + stroke = TRANSLATE (not scale)
        if (selectionKind === 'mixed' && handleKind === 'side' && isStroke) {
          const { dx, dy } = computeStrokeTranslation(handle, originBounds, scaleX, scaleY, origin, handleId);
          objBounds = translateBounds(bbox, dx, dy);
        } else if (isStroke) {
          // CASE 2: Stroke scaling with position preservation
          objBounds = computeUniformScaleBounds(bbox, originBounds, origin, scaleX, scaleY);

          // Expand for scaled stroke width (use imported computeUniformScaleNoThreshold indirectly via result)
          const origWidth = getWidth(handle.y);
          // Re-compute absScale for width calculation (same logic as in computeUniformScaleBounds)
          const uniformScaleAbs = Math.abs(Math.max(Math.abs(scaleX), Math.abs(scaleY)));
          const scaledWidth = origWidth * uniformScaleAbs;
          const delta = (scaledWidth - origWidth) * 0.5;
          if (delta > 0) {
            objBounds = expandBounds(objBounds, delta);
          }
        } else {
          // CASE 3: Shape/text scaling
          if (selectionKind === 'mixed' && handleKind === 'corner') {
            // Mixed + corner: center-based with position preservation
            objBounds = computeUniformScaleBounds(bbox, originBounds, origin, scaleX, scaleY);
          } else {
            // Shapes-only or mixed+side: corner-based (non-uniform allowed)
            objBounds = scaleBoundsAround(bbox, origin, scaleX, scaleY);
          }
        }

        // Union with combined bounds
        combinedBounds = expandEnvelope(combinedBounds, objBounds);
      }

      if (!combinedBounds) return;

      // Include padded bboxBounds for full visual coverage (stroke width padding)
      combinedBounds = unionBounds(combinedBounds, bboxBounds);

      // ACCUMULATE envelope (expand, never shrink)
      this.transformEnvelope = expandEnvelope(this.transformEnvelope, combinedBounds);

      invalidateWorld(this.transformEnvelope);
    }
  }

  // === Commit Methods ===

  private commitTranslate(selectedIds: string[], dx: number, dy: number): void {
    const snapshot = getCurrentSnapshot();

    getActiveRoomDoc().mutate((ydoc: Y.Doc) => {
      const root = ydoc.getMap('root');
      const objects = root.get('objects') as Y.Map<Y.Map<unknown>>;

      for (const id of selectedIds) {
        const handle = snapshot.objectsById.get(id);
        if (!handle) continue;

        const yMap = objects.get(id);
        if (!yMap) continue;

        if (handle.kind === 'stroke' || handle.kind === 'connector') {
          // Offset all points
          const points = getPoints(yMap);
          if (points.length === 0) continue;
          const newPoints: [number, number][] = points.map(([x, y]) => [x + dx, y + dy]);
          yMap.set('points', newPoints);
        } else {
          // Offset frame (shapes, text)
          const frame = getFrame(yMap);
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
    handleId: HandleId,
    selectionKind: SelectionKind,
    handleKind: HandleKind,
    originBounds: StoreWorldRect
  ): void {
    const snapshot = getCurrentSnapshot();

    getActiveRoomDoc().mutate((ydoc: Y.Doc) => {
      const root = ydoc.getMap('root');
      const objects = root.get('objects') as Y.Map<Y.Map<unknown>>;

      for (const id of selectedIds) {
        const handle = snapshot.objectsById.get(id);
        if (!handle) continue;

        const yMap = objects.get(id);
        if (!yMap) continue;

        const isStroke = handle.kind === 'stroke' || handle.kind === 'connector';

        // CASE 1: Mixed + side + stroke = TRANSLATE ONLY
        if (selectionKind === 'mixed' && handleKind === 'side' && isStroke) {
          const { dx, dy } = computeStrokeTranslation(handle, originBounds, scaleX, scaleY, origin, handleId);
          const points = getPoints(yMap);
          if (points.length === 0) continue;
          const newPoints: [number, number][] = points.map(([x, y]) => [x + dx, y + dy]);
          yMap.set('points', newPoints);
          // Width UNCHANGED for translation
          continue;
        }

        // CASE 2: Stroke scaling (strokesOnly or mixed+corner)
        // Uses "copy-paste" flip behavior with position preservation:
        // - Position preserves relative arrangement in selection box
        // - Geometry uses absolute magnitude (NEVER inverted/mirrored)
        if (isStroke) {
          const points = getPoints(yMap);
          if (points.length === 0) continue;

          // Apply uniform scale with position preservation
          const { points: newPoints, absScale } = applyUniformScaleToPoints(
            points, handle.bbox, originBounds, origin, scaleX, scaleY
          );
          yMap.set('points', newPoints);

          // CRITICAL: Scale stroke width for WYSIWYG
          yMap.set('width', getWidth(yMap) * absScale);
          continue;
        }

        // CASE 3: Shape scaling
        const frame = getFrame(yMap);
        if (!frame) continue;

        if (selectionKind === 'mixed' && handleKind === 'corner') {
          // Mixed + corner: shapes use center-based scaling with position preservation
          // Matches stroke behavior: no geometry inversion, no position swap
          const newFrame = applyUniformScaleToFrame(frame, originBounds, origin, scaleX, scaleY);
          yMap.set('frame', newFrame);
        } else {
          // Shapes-only or mixed+side: use raw scaleX/scaleY (non-uniform allowed)
          const newFrame = applyTransformToFrame(frame, {
            kind: 'scale',
            origin,
            scaleX,
            scaleY,
          });
          yMap.set('frame', newFrame);
        }
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

    const snapshot = getCurrentSnapshot();
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


  private updateMarqueeSelection(): void {
    const store = useSelectionStore.getState();
    const { marquee } = store;

    if (!marquee.active || !marquee.anchor || !marquee.current) return;

    const marqueeRect = pointsToWorldBounds(marquee.anchor, marquee.current);

    // Query spatial index for objects with bbox intersecting marquee (fast filter)
    const snapshot = getCurrentSnapshot();
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
      if (objectIntersectsRect(handle, marqueeRect)) {
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

  private hitTestObjects(worldX: number, worldY: number): HitCandidate | null {
    const snapshot = getCurrentSnapshot();
    const { scale } = useCameraStore.getState();
    const radiusWorld = (HIT_RADIUS_PX + HIT_SLACK_PX) / scale;

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
        const points = getPoints(y);
        if (points.length === 0) return null;

        // Add stroke width to tolerance for more forgiving hit detection (like EraserTool)
        const strokeWidth = getWidth(y);
        const tolerance = radiusWorld + strokeWidth / 2;

        if (strokeHitTest(worldX, worldY, points, tolerance)) {
          return {
            id: handle.id,
            kind: handle.kind,
            distance: 0,
            insideInterior: false,
            area: computePolylineArea(points),
            isFilled: true, // Strokes are visually "solid"
          };
        }
        return null;
      }

      case 'shape': {
        const frame = getFrame(y);
        if (!frame) return null;

        const shapeType = getShapeType(y);
        const strokeWidth = getWidth(y, 1);
        const fillColor = getFillColor(y);
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
        const frame = getFrame(y);
        if (!frame) return null;

        const [x, yPos, w, h] = frame;
        // Text frames are always selectable by clicking inside
        if (pointInRect(worldX, worldY, x, yPos, w, h)) {
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
    const insideInterior = pointInsideShape(cx, cy, frame, shapeType);

    if (insideInterior) {
      return { distance: 0, insideInterior: true };
    }

    // Check if near stroke edge
    const halfStroke = strokeWidth / 2;
    const nearEdge = shapeEdgeHitTest(cx, cy, r + halfStroke, frame, shapeType);

    if (nearEdge !== null) {
      return { distance: nearEdge, insideInterior: false };
    }

    return null;
  }
}
