import type { WorldRect, HandleId, PointerTool, PreviewData } from './types';
import {
  useSelectionStore,
  type SelectionKind,
  type HandleKind,
  type TranslateTransform,
  type ScaleTransform,
  type ConnectorTopology,
  type ConnectorTopologyEntry,
  type EndpointSpec,
  computeHandles,
  getScaleOrigin,
  getHandleCursor,
} from '@/stores/selection-store';
import { useCameraStore, worldToCanvas } from '@/stores/camera-store';
import {
  computeStrokeTranslation,
  applyTransformToBounds,
  computeScaleFactors,
  applyUniformScaleToFrame,
  applyTransformToFrame,
  computeUniformScaleNoThreshold,
  computePreservedPosition,
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
  pointInWorldRect,
  hitTestHandle,
  hitTestEndpointDots,
  objectIntersectsRect,
  testObjectHit,
  type HitCandidate,
  type EndpointHit,
} from '@/lib/geometry/hit-testing';
import type { ObjectHandle, FrameTuple, WorldBounds } from '@avlo/shared';
import {
  getFrame,
  getPoints,
  getWidth,
  getStart,
  getEnd,
  getStartAnchor,
  getEndAnchor,
  bboxTupleToWorldBounds,
} from '@avlo/shared';
import * as Y from 'yjs';
import { getActiveRoomDoc, getCurrentSnapshot, getConnectorsForShape } from '@/canvas/room-runtime';
import { invalidateWorld, invalidateOverlay } from '@/canvas/invalidation-helpers';
import { applyCursor, setCursorOverride } from '@/stores/device-ui-store';
import { rerouteConnector, type EndpointOverrideValue } from '@/lib/connectors/reroute-connector';
import { findBestSnapTarget } from '@/lib/connectors/snap';
import type { SnapTarget } from '@/lib/connectors/types';

// === Constants ===
const HIT_RADIUS_PX = 6;       // Screen-space hit test radius for selection
const HIT_SLACK_PX = 2.0;      // Forgiving feel for touch/click precision (like EraserTool)
const MOVE_THRESHOLD_PX = 4;   // Pixels before drag detected (screen space)
const CLICK_WINDOW_MS = 180;   // Time threshold for gap click disambiguation

// === Types ===

type Phase = 'idle' | 'pendingClick' | 'marquee' | 'translate' | 'scale' | 'endpointDrag';

type DownTarget =
  | 'none'
  | 'handle'                   // Clicked resize handle (standard mode only)
  | 'connectorEndpoint'        // Clicked endpoint dot (connector mode only)
  | 'objectInSelection'        // Clicked object that IS selected
  | 'objectOutsideSelection'   // Clicked object that is NOT selected
  | 'selectionGap'             // Empty space INSIDE selection bounds (standard mode only)
  | 'background';              // Empty space OUTSIDE selection bounds

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
  private endpointHitAtDown: EndpointHit | null = null;

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
    const { mode, selectedIds } = store;

    // 1. Mode-specific first-priority hit targets
    if (mode === 'standard' && selectedIds.length > 0) {
      // Standard mode: check resize handles first
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
    } else if (mode === 'connector') {
      // Connector mode: check endpoint dots first
      const snapshot = getCurrentSnapshot();
      const { scale } = useCameraStore.getState();
      const endpointHit = hitTestEndpointDots(worldX, worldY, selectedIds, snapshot, scale);
      if (endpointHit) {
        this.endpointHitAtDown = endpointHit;
        this.downTarget = 'connectorEndpoint';
        this.phase = 'pendingClick';
        setCursorOverride('grabbing');
        applyCursor();
        invalidateOverlay();
        return;
      }
    }

    // 2. Common: object hit test
    const hit = this.hitTestObjects(worldX, worldY);
    this.hitAtDown = hit;

    if (hit) {
      const isSelected = selectedIds.includes(hit.id);
      this.downTarget = isSelected ? 'objectInSelection' : 'objectOutsideSelection';
      this.phase = 'pendingClick';
      invalidateOverlay();
      return;
    }

    // 3. No object hit - selectionGap or background
    if (mode === 'standard') {
      // Standard mode has selection bounds - can have gap clicks
      const selectionBounds = this.computeSelectionBounds();
      if (selectionBounds && pointInWorldRect(worldX, worldY, selectionBounds)) {
        this.downTarget = 'selectionGap';
        this.phase = 'pendingClick';
        invalidateOverlay();
        return;
      }
    }
    // Connector mode has no selection bounds → no gap, straight to background

    this.downTarget = 'background';
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
              this.buildConnectorTopology('scale');
            }
            const cursor = getHandleCursor(this.activeHandle!);
            setCursorOverride(cursor);
            applyCursor();
            break;
          }

          case 'connectorEndpoint': {
            // Connector mode only: dragging an endpoint dot
            if (!passMove) break;

            // Drill down to single connector if multiple selected
            const epStore = useSelectionStore.getState();
            if (epStore.selectedIds.length > 1) {
              epStore.setSelection(
                [this.endpointHitAtDown!.connectorId],
                'connectorsOnly'
              );
            }

            this.phase = 'endpointDrag';

            // Begin endpoint drag transform
            const snapshot = getCurrentSnapshot();
            const connHandle = snapshot.objectsById.get(this.endpointHitAtDown!.connectorId);
            if (connHandle) {
              const originBbox = bboxTupleToWorldBounds(connHandle.bbox);
              useSelectionStore.getState().beginEndpointDrag(
                this.endpointHitAtDown!.connectorId,
                this.endpointHitAtDown!.endpoint,
                originBbox
              );
            }
            setCursorOverride('grabbing');
            applyCursor();
            break;
          }

          case 'objectOutsideSelection': {
            if (!passMove) break;

            // Connectors: check anchor state to decide drag behavior
            if (this.hitAtDown?.kind === 'connector') {
              const snapshot = getCurrentSnapshot();
              const connHandle = snapshot.objectsById.get(this.hitAtDown.id);
              if (connHandle) {
                const sa = getStartAnchor(connHandle.y);
                const ea = getEndAnchor(connHandle.y);
                if (sa || ea) {
                  // Anchored → marquee (can't translate anchored connector)
                  this.phase = 'marquee';
                  useSelectionStore.getState().beginMarquee(this.downWorld!);
                  useSelectionStore.getState().updateMarquee([worldX, worldY]);
                  this.updateMarqueeSelection();
                  break;
                }
              }
            }

            // Non-connector or free connector: select + translate
            const store = useSelectionStore.getState();
            store.setSelection([this.hitAtDown!.id], this.computeSelectionKind([this.hitAtDown!.id]));
            this.phase = 'translate';
            const bounds = this.computeSelectionBounds();
            if (bounds) {
              useSelectionStore.getState().beginTranslate(bounds);
              this.buildConnectorTopology('translate');
            }
            break;
          }

          case 'objectInSelection': {
            if (!passMove) break;

            // Connector mode (1 connector): check anchor state
            const inSelStore = useSelectionStore.getState();
            if (inSelStore.mode === 'connector') {
              const snapshot = getCurrentSnapshot();
              const connHandle = snapshot.objectsById.get(inSelStore.selectedIds[0]);
              if (connHandle?.kind === 'connector') {
                const sa = getStartAnchor(connHandle.y);
                const ea = getEndAnchor(connHandle.y);
                if (sa || ea) {
                  // Anchored → marquee (gives visual feedback)
                  this.phase = 'marquee';
                  useSelectionStore.getState().beginMarquee(this.downWorld!);
                  useSelectionStore.getState().updateMarquee([worldX, worldY]);
                  this.updateMarqueeSelection();
                  break;
                }
              }
            }

            // Standard mode or free connector: translate group
            this.phase = 'translate';
            const bounds = this.computeSelectionBounds();
            if (bounds) {
              useSelectionStore.getState().beginTranslate(bounds);
              this.buildConnectorTopology('translate');
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
              this.buildConnectorTopology('translate');
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
          this.invalidateTransformPreview();
        }
        break;
      }

      case 'endpointDrag': {
        const epTransform = useSelectionStore.getState().transform;
        if (epTransform.kind !== 'endpointDrag') break;

        const { scale } = useCameraStore.getState();
        const { connectorId, endpoint } = epTransform;

        // 1. Find snap target
        const snap = findBestSnapTarget({
          cursorWorld: [worldX, worldY],
          scale,
          prevAttach: epTransform.currentSnap,
        });

        // 2. Build endpoint override
        const overrideValue: EndpointOverrideValue = snap ?? [worldX, worldY];
        const endpointOverride: { start?: EndpointOverrideValue; end?: EndpointOverrideValue } = {};
        endpointOverride[endpoint] = overrideValue;

        // 3. Reroute
        const result = rerouteConnector(connectorId, endpointOverride);

        // 4. Invalidate prev + current dirty rects
        invalidateWorld(epTransform.prevBbox);
        if (result) invalidateWorld(result.bbox);

        // 5. Update store
        const currentPosition: [number, number] = snap ? snap.position : [worldX, worldY];
        useSelectionStore.getState().updateEndpointDrag(
          currentPosition,
          snap ?? null,
          result?.points ?? null,
          result?.bbox ?? null
        );
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

          case 'connectorEndpoint':
            // Clicked endpoint dot but didn't drag → drill down to single connector
            if (store.selectedIds.length > 1) {
              store.setSelection(
                [this.endpointHitAtDown!.connectorId],
                'connectorsOnly'
              );
            }
            break;

          case 'objectOutsideSelection':
            // Click → select that object
            store.setSelection([this.hitAtDown!.id], this.computeSelectionKind([this.hitAtDown!.id]));
            break;

          case 'objectInSelection':
            // Click on already-selected object → "drill down" if multi-select
            if (store.selectedIds.length > 1) {
              store.setSelection([this.hitAtDown!.id], this.computeSelectionKind([this.hitAtDown!.id]));
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
        const { selectedIds, connectorTopology } = store;

        // Clear transform BEFORE mutate to prevent double-transform visual glitch
        store.endTransform();

        // Only commit if there was actual movement
        if (dx !== 0 || dy !== 0) {
          this.commitTranslate(selectedIds, dx, dy, connectorTopology);
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
        const { selectedIds, connectorTopology } = store;

        // Clear transform BEFORE mutate
        store.endTransform();

        // Only commit if there was actual scaling
        if (scaleX !== 1 || scaleY !== 1) {
          this.commitScale(selectedIds, origin, scaleX, scaleY, handleId, selectionKind, handleKind, originBounds, connectorTopology);
        }
        break;
      }

      case 'endpointDrag': {
        const epStore = useSelectionStore.getState();
        if (epStore.transform.kind !== 'endpointDrag') {
          epStore.endTransform();
          break;
        }

        const { connectorId, endpoint, routedPoints, currentSnap, prevBbox, routedBbox } = epStore.transform;

        // Invalidate the connector region
        invalidateWorld(prevBbox);
        if (routedBbox) invalidateWorld(routedBbox);

        epStore.endTransform();

        // Commit if we have valid routed points
        if (routedPoints && routedPoints.length >= 2) {
          this.commitEndpointDrag(connectorId, endpoint, routedPoints, currentSnap);
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
    } else if (this.phase === 'endpointDrag') {
      const store = useSelectionStore.getState();
      if (store.transform.kind === 'endpointDrag') {
        // Invalidate connector's original bbox to clear any preview
        invalidateWorld(store.transform.prevBbox);
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
    const { selectedIds, mode, transform, marquee } = store;

    // Compute marquee rect if active
    let marqueeRect: WorldRect | null = null;
    if (marquee.active && marquee.anchor && marquee.current) {
      marqueeRect = pointsToWorldBounds(marquee.anchor, marquee.current);
    }

    // Connector mode: no selection bounds, no handles
    // Standard mode: compute bounds and handles as usual
    let selectionBounds: WorldRect | null = null;
    let handles: { id: HandleId; x: number; y: number }[] | null = null;

    if (mode === 'standard' && selectedIds.length > 0) {
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
   *
   * Standard mode: resize cursors on handles.
   * Connector mode: grab cursor on endpoint dots.
   */
  private handleHoverCursor(worldX: number, worldY: number): void {
    const store = useSelectionStore.getState();
    const { mode, selectedIds } = store;

    if (mode === 'none') {
      setCursorOverride(null);
      applyCursor();
      return;
    }

    const { scale } = useCameraStore.getState();

    if (mode === 'standard') {
      const bounds = this.computeSelectionBounds();
      if (bounds) {
        const handle = hitTestHandle(worldX, worldY, bounds, scale);
        if (handle) {
          setCursorOverride(getHandleCursor(handle));
          applyCursor();
          return;
        }
      }
    } else if (mode === 'connector') {
      const snapshot = getCurrentSnapshot();
      const endpointHit = hitTestEndpointDots(worldX, worldY, selectedIds, snapshot, scale);
      if (endpointHit) {
        setCursorOverride('grab');
        applyCursor();
        return;
      }
    }

    setCursorOverride(null);
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
    this.endpointHitAtDown = null;
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
    const topology = store.connectorTopology;

    // --- 1. CONNECTOR TOPOLOGY ---
    if (topology) {
      // Reroute entries: compute new routes + expand envelope
      for (const entry of topology.entries) {
        if (entry.strategy !== 'reroute') continue;

        const overrides: { start?: EndpointOverrideValue; end?: EndpointOverrideValue } = {};

        if (typeof entry.startSpec === 'string') {
          const origFrame = topology.originalFrames.get(entry.startSpec);
          if (origFrame) overrides.start = { frame: this.transformFrame(origFrame, transform) };
        } else if (entry.startSpec === true) {
          overrides.start = this.transformPosition(entry.originalPoints[0], transform as TranslateTransform | ScaleTransform);
        }

        if (typeof entry.endSpec === 'string') {
          const origFrame = topology.originalFrames.get(entry.endSpec);
          if (origFrame) overrides.end = { frame: this.transformFrame(origFrame, transform) };
        } else if (entry.endSpec === true) {
          overrides.end = this.transformPosition(entry.originalPoints[entry.originalPoints.length - 1], transform as TranslateTransform | ScaleTransform);
        }

        const hasOverrides = overrides.start !== undefined || overrides.end !== undefined;
        const result = rerouteConnector(entry.connectorId, hasOverrides ? overrides : undefined);
        topology.reroutes.set(entry.connectorId, result?.points ?? null);

        // Track bbox for envelope
        const prev = topology.prevBboxes.get(entry.connectorId);
        if (prev) this.transformEnvelope = expandEnvelope(this.transformEnvelope, prev);
        if (result) {
          this.transformEnvelope = expandEnvelope(this.transformEnvelope, result.bbox);
          topology.prevBboxes.set(entry.connectorId, result.bbox);
        }
      }

      // TranslateOnly envelope (translate only)
      if (transform.kind === 'translate') {
        for (const entry of topology.entries) {
          if (entry.strategy !== 'translate') continue;
          const translated = translateBounds(entry.originalBbox, transform.dx, transform.dy);
          this.transformEnvelope = expandEnvelope(this.transformEnvelope, entry.originalBbox);
          this.transformEnvelope = expandEnvelope(this.transformEnvelope, translated);
        }
      }
    }

    // --- 2. COMPUTE ENVELOPE (shapes + strokes) ---
    if (transform.kind === 'translate') {
      const transformedBounds = applyTransformToBounds(bounds, transform);

      if (!this.transformEnvelope) {
        this.transformEnvelope = unionBounds(bounds, transformedBounds);
      } else {
        this.transformEnvelope = expandEnvelope(this.transformEnvelope, transformedBounds);
      }
    } else if (transform.kind === 'scale') {
      const snapshot = getCurrentSnapshot();
      const { selectionKind, handleKind, handleId, origin, scaleX, scaleY, originBounds, bboxBounds } = transform;

      let combinedBounds: WorldRect | null = null;

      for (const id of store.selectedIds) {
        const handle = snapshot.objectsById.get(id);
        if (!handle) continue;

        // Connectors handled via topology above
        if (handle.kind === 'connector') continue;

        const bbox = bboxTupleToWorldBounds(handle.bbox);
        const isStroke = handle.kind === 'stroke';
        let objBounds: WorldRect;

        if (selectionKind === 'mixed' && handleKind === 'side' && isStroke) {
          const { dx, dy } = computeStrokeTranslation(handle, originBounds, scaleX, scaleY, origin, handleId);
          objBounds = translateBounds(bbox, dx, dy);
        } else if (isStroke) {
          objBounds = computeUniformScaleBounds(bbox, originBounds, origin, scaleX, scaleY);
          const origWidth = getWidth(handle.y);
          const uniformScaleAbs = Math.abs(Math.max(Math.abs(scaleX), Math.abs(scaleY)));
          const scaledWidth = origWidth * uniformScaleAbs;
          const delta = (scaledWidth - origWidth) * 0.5;
          if (delta > 0) {
            objBounds = expandBounds(objBounds, delta);
          }
        } else {
          if (selectionKind === 'mixed' && handleKind === 'corner') {
            objBounds = computeUniformScaleBounds(bbox, originBounds, origin, scaleX, scaleY);
          } else {
            objBounds = scaleBoundsAround(bbox, origin, scaleX, scaleY);
          }
        }

        combinedBounds = expandEnvelope(combinedBounds, objBounds);
      }

      if (combinedBounds) {
        combinedBounds = unionBounds(combinedBounds, bboxBounds);
        this.transformEnvelope = expandEnvelope(this.transformEnvelope, combinedBounds);
      }
    }

    // --- 3. SINGLE INVALIDATION ---
    if (this.transformEnvelope) {
      invalidateWorld(this.transformEnvelope);
    }
  }

  // === Commit Methods ===

  private commitTranslate(
    selectedIds: string[],
    dx: number,
    dy: number,
    topology: ConnectorTopology | null
  ): void {
    const snapshot = getCurrentSnapshot();

    getActiveRoomDoc().mutate((ydoc: Y.Doc) => {
      const root = ydoc.getMap('root');
      const objects = root.get('objects') as Y.Map<Y.Map<unknown>>;

      for (const id of selectedIds) {
        const handle = snapshot.objectsById.get(id);
        if (!handle) continue;

        // Connectors: handled entirely by topology below
        if (handle.kind === 'connector') continue;

        const yMap = objects.get(id);
        if (!yMap) continue;

        if (handle.kind === 'stroke') {
          const points = getPoints(yMap);
          if (points.length === 0) continue;
          const newPoints: [number, number][] = points.map(([x, y]) => [x + dx, y + dy]);
          yMap.set('points', newPoints);
        } else {
          const frame = getFrame(yMap);
          if (!frame) continue;
          const [x, y, w, h] = frame;
          yMap.set('frame', [x + dx, y + dy, w, h]);
        }
      }

      // Topology-managed connectors
      if (topology) {
        for (const entry of topology.entries) {
          const yMap = objects.get(entry.connectorId);
          if (!yMap) continue;

          if (entry.strategy === 'translate') {
            const newPoints: [number, number][] = entry.originalPoints.map(([x, y]) => [x + dx, y + dy]);
            yMap.set('points', newPoints);
            yMap.set('start', newPoints[0]);
            yMap.set('end', newPoints[newPoints.length - 1]);
          } else {
            const points = topology.reroutes.get(entry.connectorId);
            if (!points || points.length < 2) continue;
            yMap.set('points', points);
            yMap.set('start', points[0]);
            yMap.set('end', points[points.length - 1]);
          }
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
    originBounds: WorldBounds,
    topology: ConnectorTopology | null
  ): void {
    const snapshot = getCurrentSnapshot();

    getActiveRoomDoc().mutate((ydoc: Y.Doc) => {
      const root = ydoc.getMap('root');
      const objects = root.get('objects') as Y.Map<Y.Map<unknown>>;

      for (const id of selectedIds) {
        const handle = snapshot.objectsById.get(id);
        if (!handle) continue;

        // Connectors: handled entirely by topology below
        if (handle.kind === 'connector') continue;

        const yMap = objects.get(id);
        if (!yMap) continue;

        const isStroke = handle.kind === 'stroke';

        // CASE 1: Mixed + side + stroke = TRANSLATE ONLY
        if (selectionKind === 'mixed' && handleKind === 'side' && isStroke) {
          const { dx, dy } = computeStrokeTranslation(handle, originBounds, scaleX, scaleY, origin, handleId);
          const points = getPoints(yMap);
          if (points.length === 0) continue;
          const newPoints: [number, number][] = points.map(([x, y]) => [x + dx, y + dy]);
          yMap.set('points', newPoints);
          continue;
        }

        // CASE 2: Stroke scaling (strokesOnly or mixed+corner)
        if (isStroke) {
          const points = getPoints(yMap);
          if (points.length === 0) continue;

          // Compute uniform scale factor
          const uniformScale = computeUniformScaleNoThreshold(scaleX, scaleY);
          const absScale = Math.abs(uniformScale);

          // Apply position preservation
          const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
          const cy = points.reduce((s, p) => s + p[1], 0) / points.length;
          const newCenter = computePreservedPosition(cx, cy, originBounds, origin, uniformScale);
          const dx = newCenter[0] - cx;
          const dy = newCenter[1] - cy;

          const newPoints: [number, number][] = points.map(([x, y]) => {
            // Scale around center, then translate to preserved position
            const sx = cx + (x - cx) * absScale + dx;
            const sy = cy + (y - cy) * absScale + dy;
            return [sx, sy];
          });
          yMap.set('points', newPoints);
          yMap.set('width', getWidth(yMap) * absScale);
          continue;
        }

        // CASE 3: Shape/text scaling
        const frame = getFrame(yMap);
        if (!frame) continue;

        if (selectionKind === 'mixed' && handleKind === 'corner') {
          const newFrame = applyUniformScaleToFrame(frame, originBounds, origin, scaleX, scaleY);
          yMap.set('frame', newFrame);
        } else {
          const newFrame = applyTransformToFrame(frame, { kind: 'scale', origin, scaleX, scaleY });
          yMap.set('frame', newFrame);
        }
      }

      // Topology-managed connectors (reroutes only — no translateEntries in scale)
      if (topology) {
        for (const entry of topology.entries) {
          if (entry.strategy !== 'reroute') continue;
          const points = topology.reroutes.get(entry.connectorId);
          if (!points || points.length < 2) continue;
          const yMap = objects.get(entry.connectorId);
          if (!yMap) continue;
          yMap.set('points', points);
          yMap.set('start', points[0]);
          yMap.set('end', points[points.length - 1]);
        }
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
    let hasConnectors = false;

    for (const id of selectedIds) {
      const handle = snapshot.objectsById.get(id);
      if (!handle) continue;

      if (handle.kind === 'stroke') {
        hasStrokes = true;
      } else if (handle.kind === 'connector') {
        hasConnectors = true;
      } else {
        hasShapes = true;
      }
    }

    // Pure cases
    if (hasConnectors && !hasStrokes && !hasShapes) return 'connectorsOnly';
    if (hasStrokes && !hasConnectors && !hasShapes) return 'strokesOnly';
    if (hasShapes && !hasStrokes && !hasConnectors) return 'shapesOnly';

    // Any combination is mixed
    if (hasStrokes || hasShapes || hasConnectors) return 'mixed';
    return 'none';
  }

  /**
   * Build connector topology at transform begin.
   * Determines which connectors need rerouting vs translateOnly,
   * computes per-endpoint specs, and writes ConnectorTopology to store.
   *
   * Strategy:
   *   Translate: both endpoints move → translateOnly; else → reroute
   *   Scale: always → reroute
   *
   * EndpointSpec per endpoint:
   *   Anchored + shape selected → shapeId (string)
   *   Free + connector selected → true
   *   Otherwise → null (canonical)
   */
  private buildConnectorTopology(transformKind: 'translate' | 'scale'): void {
    const snapshot = getCurrentSnapshot();
    const { selectedIds } = useSelectionStore.getState();
    const selectedSet = new Set(selectedIds);

    const entries: ConnectorTopologyEntry[] = [];
    const translateIdSet = new Set<string>();
    const originalFrames = new Map<string, FrameTuple>();

    // Collect all connectors that have at least one moving endpoint
    const visited = new Set<string>();

    const processConnector = (connId: string, isSelected: boolean) => {
      if (visited.has(connId)) return;
      visited.add(connId);

      const connHandle = snapshot.objectsById.get(connId);
      if (!connHandle || connHandle.kind !== 'connector') return;

      const startAnchor = getStartAnchor(connHandle.y);
      const endAnchor = getEndAnchor(connHandle.y);

      // Determine if each endpoint moves
      const startMoves = isSelected
        ? (!startAnchor || selectedSet.has(startAnchor.id))
        : (!!startAnchor && selectedSet.has(startAnchor.id));
      const endMoves = isSelected
        ? (!endAnchor || selectedSet.has(endAnchor.id))
        : (!!endAnchor && selectedSet.has(endAnchor.id));

      if (!startMoves && !endMoves) return;

      const points = getPoints(connHandle.y);
      const originalPoints: [number, number][] = points.length > 0
        ? points as [number, number][]
        : [((getStart(connHandle.y) ?? [0, 0]) as [number, number]), ((getEnd(connHandle.y) ?? [0, 0]) as [number, number])];
      const originalBbox = bboxTupleToWorldBounds(connHandle.bbox);

      // Determine strategy
      if (transformKind === 'translate' && startMoves && endMoves) {
        // Both endpoints move together → translateOnly
        entries.push({
          connectorId: connId, strategy: 'translate',
          originalPoints, originalBbox, startSpec: null, endSpec: null,
        });
        translateIdSet.add(connId);
      } else {
        // At least one endpoint needs rerouting — compute specs inline
        const startSpec: EndpointSpec =
          (startAnchor && selectedSet.has(startAnchor.id)) ? startAnchor.id :
          (!startAnchor && isSelected) ? true : null;
        const endSpec: EndpointSpec =
          (endAnchor && selectedSet.has(endAnchor.id)) ? endAnchor.id :
          (!endAnchor && isSelected) ? true : null;

        entries.push({
          connectorId: connId, strategy: 'reroute',
          originalPoints, originalBbox, startSpec, endSpec,
        });
      }
    };

    // Pass 1: Selected connectors
    for (const id of selectedIds) {
      const handle = snapshot.objectsById.get(id);
      if (handle?.kind === 'connector') {
        processConnector(id, true);
      }
    }

    // Pass 2: Non-selected connectors anchored to selected shapes
    for (const id of selectedIds) {
      const handle = snapshot.objectsById.get(id);
      if (!handle || (handle.kind !== 'shape' && handle.kind !== 'text')) continue;
      const connectors = getConnectorsForShape(id);
      if (!connectors) continue;
      for (const connId of connectors) {
        processConnector(connId, selectedSet.has(connId));
      }
    }

    if (entries.length === 0) return;

    // Collect original frames for all selected shapes (for frame overrides)
    for (const id of selectedIds) {
      const handle = snapshot.objectsById.get(id);
      if (!handle || (handle.kind !== 'shape' && handle.kind !== 'text')) continue;
      const frame = getFrame(handle.y);
      if (frame) originalFrames.set(id, frame);
    }

    // Pre-allocate mutable caches
    const reroutes = new Map<string, [number, number][] | null>();
    const prevBboxes = new Map<string, WorldBounds>();
    for (const entry of entries) {
      if (entry.strategy === 'reroute') {
        reroutes.set(entry.connectorId, null);
        prevBboxes.set(entry.connectorId, entry.originalBbox);
      }
    }

    const topology: ConnectorTopology = {
      entries,
      translateIdSet,
      originalFrames,
      reroutes,
      prevBboxes,
    };
    useSelectionStore.getState().setConnectorTopology(topology);
  }

  /**
   * Compute a transformed frame for a shape, matching the transform logic.
   */
  private transformFrame(
    frame: FrameTuple,
    transform: { kind: string; dx?: number; dy?: number; origin?: [number, number]; scaleX?: number; scaleY?: number; selectionKind?: SelectionKind; handleKind?: HandleKind; originBounds?: WorldBounds }
  ): FrameTuple {
    if (transform.kind === 'translate') {
      const { dx = 0, dy = 0 } = transform;
      return [frame[0] + dx, frame[1] + dy, frame[2], frame[3]];
    }

    const { origin, scaleX = 1, scaleY = 1, selectionKind, handleKind, originBounds } = transform;
    if (selectionKind === 'mixed' && handleKind === 'corner' && originBounds && origin) {
      return applyUniformScaleToFrame(frame, originBounds, origin, scaleX, scaleY);
    }
    if (origin) {
      return applyTransformToFrame(frame, { kind: 'scale', origin, scaleX, scaleY });
    }
    return frame;
  }

  /**
   * Transform a free endpoint position using the current translate/scale transform.
   */
  private transformPosition(
    position: [number, number],
    transform: TranslateTransform | ScaleTransform
  ): [number, number] {
    if (transform.kind === 'translate') {
      return [position[0] + transform.dx, position[1] + transform.dy];
    }

    const { origin, scaleX, scaleY, selectionKind, handleKind, originBounds } = transform;

    if (selectionKind === 'mixed' && handleKind === 'corner') {
      const uniformScale = computeUniformScaleNoThreshold(scaleX, scaleY);
      return computePreservedPosition(position[0], position[1], originBounds, origin, uniformScale);
    }

    // Non-uniform: same as shape corner scaling
    const [ox, oy] = origin;
    return [
      ox + (position[0] - ox) * scaleX,
      oy + (position[1] - oy) * scaleY,
    ];
  }

  /**
   * Commit endpoint drag results to Y.Doc.
   * Updates connector points, start/end positions, and anchor data.
   */
  private commitEndpointDrag(
    connectorId: string,
    endpoint: 'start' | 'end',
    routedPoints: [number, number][],
    currentSnap: SnapTarget | null
  ): void {
    getActiveRoomDoc().mutate((ydoc: Y.Doc) => {
      const root = ydoc.getMap('root');
      const objects = root.get('objects') as Y.Map<Y.Map<unknown>>;
      const yMap = objects.get(connectorId);
      if (!yMap) return;

      // Update routed path
      yMap.set('points', routedPoints);
      yMap.set('start', routedPoints[0]);
      yMap.set('end', routedPoints[routedPoints.length - 1]);

      // Update anchor for the dragged endpoint
      const anchorKey = endpoint === 'start' ? 'startAnchor' : 'endAnchor';
      if (currentSnap) {
        yMap.set(anchorKey, {
          id: currentSnap.shapeId,
          side: currentSnap.side,
          anchor: currentSnap.normalizedAnchor,
        });
      } else {
        yMap.delete(anchorKey);
      }
    });
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
      store.setSelection(selectedIds, this.computeSelectionKind(selectedIds));
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

      const candidate = testObjectHit(worldX, worldY, radiusWorld, handle);
      if (candidate) candidates.push(candidate);
    }

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    return this.pickBestCandidate(candidates);
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
}
