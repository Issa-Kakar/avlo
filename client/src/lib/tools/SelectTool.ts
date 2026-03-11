import type { WorldRect, HandleId, PointerTool, PreviewData } from './types';
import { textTool, codeTool } from '@/canvas/tool-registry';
import {
  useSelectionStore,
  type SelectionKind,
  type HandleKind,
  type TranslateTransform,
  type ScaleTransform,
  type ConnectorTopology,
  type TextReflowState,
  type CodeReflowState,
  computeHandles,
  computeSelectionBounds,
  getScaleOrigin,
  getHandleCursor,
} from '@/stores/selection-store';
import { useCameraStore, worldToCanvas } from '@/stores/camera-store';
import {
  computeEdgePinTranslation,
  computeStrokeTranslation,
  applyTransformToBounds,
  computeScaleFactors,
  applyUniformScaleToFrame,
  applyUniformScaleToPoints,
  applyTransformToFrame,
  transformFrameForTopology,
  transformPositionForTopology,
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
import type { ObjectHandle, WorldBounds } from '@avlo/shared';
import {
  getFrame,
  getPoints,
  getWidth,
  getStartAnchor,
  getEndAnchor,
  getOrigin,
  getTextProps,
  getCodeProps,
  getConnectorType,
  bboxTupleToWorldBounds,
} from '@avlo/shared';
import * as Y from 'yjs';
import { getActiveRoomDoc, getCurrentSnapshot } from '@/canvas/room-runtime';
import { isShiftPointer, isCtrlOrMetaPointer } from '@/canvas/cursor-tracking';
import { invalidateWorld, invalidateOverlay } from '@/canvas/invalidation-helpers';
import { applyCursor, setCursorOverride } from '@/stores/device-ui-store';
import { contextMenuController } from '@/canvas/ContextMenuController';
import { rerouteConnector, type EndpointOverrideValue } from '@/lib/connectors/reroute-connector';
import { findBestSnapTarget } from '@/lib/connectors/snap';
import type { SnapTarget } from '@/lib/connectors/types';
import { isCtrlHeld } from '@/canvas/cursor-tracking';
import {
  anchorFactor,
  getBaselineToTopRatio,
  getTextFrame,
  textLayoutCache,
  layoutMeasuredContent,
  getMinCharWidth,
} from '@/lib/text/text-system';
import { frameTupleToWorldBounds } from '@/lib/geometry/bounds';
import {
  getCodeFrame,
  computeLayout as computeCodeLayout,
  totalHeight as codeTotalHeight,
  getMinWidth as getCodeMinWidth,
  codeSystem,
} from '@/lib/code/code-system';

// === Constants ===
const HIT_RADIUS_PX = 6; // Screen-space hit test radius for selection
const HIT_SLACK_PX = 2.0; // Forgiving feel for touch/click precision (like EraserTool)
const MOVE_THRESHOLD_PX = 4; // Pixels before drag detected (screen space)
const CLICK_WINDOW_MS = 180; // Time threshold for gap click disambiguation

// === Types ===

type Phase = 'idle' | 'pendingClick' | 'marquee' | 'translate' | 'scale' | 'endpointDrag';

type DownTarget =
  | 'none'
  | 'handle' // Clicked resize handle (standard mode only)
  | 'connectorEndpoint' // Clicked endpoint dot (connector mode only)
  | 'objectInSelection' // Clicked object that IS selected
  | 'objectOutsideSelection' // Clicked object that is NOT selected
  | 'selectionGap' // Empty space INSIDE selection bounds (standard mode only)
  | 'background'; // Empty space OUTSIDE selection bounds

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

  private hasAddModifier(): boolean {
    return isShiftPointer() || isCtrlOrMetaPointer();
  }

  // --- PointerTool Interface ---

  canBegin(): boolean {
    return this.phase === 'idle';
  }

  begin(pointerId: number, worldX: number, worldY: number): void {
    if (this.phase !== 'idle') return;
    contextMenuController.hide();

    this.pointerId = pointerId;
    this.downWorld = [worldX, worldY];
    this.downTimeMs = performance.now();
    this.downTarget = 'none';

    // Convert to screen space for move threshold
    const [screenX, screenY] = worldToCanvas(worldX, worldY);
    this.downScreen = [screenX, screenY];

    const store = useSelectionStore.getState();
    const { mode, selectedIds, textEditingId } = store;

    // 1. Mode-specific first-priority hit targets
    if (
      mode === 'standard' &&
      selectedIds.length > 0 &&
      (!textEditingId || textTool.isEditingLabel()) &&
      !store.codeEditingId
    ) {
      // Standard mode: check resize handles first
      const selectionBounds = computeSelectionBounds();
      const { scale } = useCameraStore.getState();
      const handleHit = selectionBounds
        ? hitTestHandle(worldX, worldY, selectionBounds, scale)
        : null;
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
      //NO LONGER USED, BAD UX: if (!isSelected && selectedIds.length > 0) store.clearSelection();
      this.downTarget = isSelected ? 'objectInSelection' : 'objectOutsideSelection';
      this.phase = 'pendingClick';
      // Single text/code re-click: undo hide so editor mounts without menu flash (hide deferred to move)
      if (
        isSelected &&
        selectedIds.length === 1 &&
        (hit.kind === 'text' || hit.kind === 'code' || textTool.justClosedLabelId === hit.id)
      ) {
        contextMenuController.cancelHide();
      }
      invalidateOverlay();
      return;
    }

    // 3. No object hit - selectionGap or background
    if (mode === 'standard') {
      // Standard mode has selection bounds - can have gap clicks
      const selectionBounds = computeSelectionBounds();
      if (selectionBounds && pointInWorldRect(worldX, worldY, selectionBounds)) {
        this.downTarget = 'selectionGap';
        this.phase = 'pendingClick';
        invalidateOverlay();
        return;
      }
    }
    // Connector mode has no selection bounds → no gap, straight to background

    if (selectedIds.length > 0) store.clearSelection();
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

            // Geometry-based bounds for transform origin (fixes anchor sliding)
            const transformBounds = this.computeTransformBoundsForScale();
            // Padded bounds for dirty rects (visual coverage)
            const bboxBounds = computeSelectionBounds();

            if (transformBounds && bboxBounds) {
              // CRITICAL: Use geometry bounds for origin
              const origin = getScaleOrigin(this.activeHandle!, transformBounds);
              // Compute initial delta: distance from origin to click position
              // This ensures scale=1.0 exactly when cursor is at starting position
              const initialDelta: [number, number] = [
                this.downWorld![0] - origin[0],
                this.downWorld![1] - origin[1],
              ];
              store.beginScale(
                bboxBounds,
                transformBounds,
                origin,
                this.activeHandle!,
                initialDelta,
              );
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
              epStore.setSelection([this.endpointHitAtDown!.connectorId]);
            }

            this.phase = 'endpointDrag';

            // Begin endpoint drag transform
            const snapshot = getCurrentSnapshot();
            const connHandle = snapshot.objectsById.get(this.endpointHitAtDown!.connectorId);
            if (connHandle) {
              const originBbox = bboxTupleToWorldBounds(connHandle.bbox);
              useSelectionStore
                .getState()
                .beginEndpointDrag(
                  this.endpointHitAtDown!.connectorId,
                  this.endpointHitAtDown!.endpoint,
                  originBbox,
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
            store.setSelection([this.hitAtDown!.id]);
            this.phase = 'translate';
            const bounds = computeSelectionBounds();
            if (bounds) {
              useSelectionStore.getState().beginTranslate(bounds);
            }
            break;
          }

          case 'objectInSelection': {
            if (!passMove) break;
            contextMenuController.hide();

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
            const bounds = computeSelectionBounds();
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
            const bounds = computeSelectionBounds();
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

        // Read connector type for snap context
        const epSnapshot = getCurrentSnapshot();
        const connHandle = epSnapshot.objectsById.get(connectorId);
        const epConnectorType = connHandle ? getConnectorType(connHandle.y) : 'elbow';

        // 1. Find snap target (Ctrl suppresses snapping)
        const snap = isCtrlHeld()
          ? null
          : findBestSnapTarget({
              cursorWorld: [worldX, worldY],
              scale,
              prevAttach: epTransform.currentSnap,
              connectorType: epConnectorType,
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
        useSelectionStore
          .getState()
          .updateEndpointDrag(
            currentPosition,
            snap ?? null,
            result?.points ?? null,
            result?.bbox ?? null,
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
              store.setSelection([this.endpointHitAtDown!.connectorId]);
            }
            break;

          case 'objectOutsideSelection':
            if (this.hasAddModifier()) {
              // Additive: add to current selection
              const current = store.selectedIds;
              if (!current.includes(this.hitAtDown!.id)) {
                store.setSelection([...current, this.hitAtDown!.id]);
              }
            } else {
              // Replace selection
              store.setSelection([this.hitAtDown!.id]);
            }
            break;

          case 'objectInSelection':
            if (this.hasAddModifier()) {
              // Subtractive: remove from selection
              const remaining = store.selectedIds.filter((id) => id !== this.hitAtDown!.id);
              if (remaining.length > 0) {
                store.setSelection(remaining);
              } else {
                store.clearSelection();
              }
            } else if (store.selectedIds.length > 1) {
              // Drill down to single object
              store.setSelection([this.hitAtDown!.id]);
            } else if (
              (this.hitAtDown!.kind === 'text' || this.hitAtDown!.kind === 'shape') &&
              !textTool.isEditorMounted()
            ) {
              if (textTool.justClosedLabelId === this.hitAtDown!.id) {
                textTool.justClosedLabelId = null;
              } else {
                textTool.startEditing(this.hitAtDown!.id, this.downWorld!);
              }
            } else if (this.hitAtDown!.kind === 'code' && !codeTool.isEditorMounted()) {
              if (codeTool.justClosedCodeId === this.hitAtDown!.id) {
                codeTool.justClosedCodeId = null;
              } else {
                codeTool.startEditing(this.hitAtDown!.id);
              }
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

        const { origin, scaleX, scaleY, handleId, selectionKind, handleKind, originBounds } =
          store.transform;
        const { selectedIds, connectorTopology, textReflow, codeReflow } = store;

        // Clear transform BEFORE mutate
        store.endTransform();

        // Only commit if there was actual scaling
        if (scaleX !== 1 || scaleY !== 1) {
          this.commitScale(
            selectedIds,
            origin,
            scaleX,
            scaleY,
            handleId,
            selectionKind,
            handleKind,
            originBounds,
            connectorTopology,
            textReflow,
            codeReflow,
          );
        }
        break;
      }

      case 'endpointDrag': {
        const epStore = useSelectionStore.getState();
        if (epStore.transform.kind !== 'endpointDrag') {
          epStore.endTransform();
          break;
        }

        const { connectorId, endpoint, routedPoints, currentSnap, prevBbox, routedBbox } =
          epStore.transform;

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

    const { selectedIds, textEditingId, codeEditingId } = useSelectionStore.getState();
    if (selectedIds.length > 0 || textEditingId !== null || codeEditingId !== null) {
      contextMenuController.show();
    }

    textTool.justClosedLabelId = null;
    codeTool.justClosedCodeId = null;
    invalidateOverlay();
  }

  cancel(): void {
    // Invalidate dirty rect before clearing transform state
    if (this.phase === 'translate' || this.phase === 'scale') {
      const bounds = computeSelectionBounds();
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

    const { selectedIds, textEditingId, codeEditingId } = useSelectionStore.getState();
    if (selectedIds.length > 0 || textEditingId !== null || codeEditingId !== null) {
      contextMenuController.show();
    }

    textTool.justClosedLabelId = null;
    codeTool.justClosedCodeId = null;
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
        baseBounds = computeSelectionBounds();
      }

      if (baseBounds) {
        selectionBounds = applyTransformToBounds(baseBounds, transform);
        handles = computeHandles(selectionBounds);
      }
    }

    const isTransforming = transform.kind !== 'none' && transform.kind !== 'endpointDrag';

    return {
      kind: 'selection',
      selectionBounds,
      marqueeRect,
      handles:
        isTransforming || (store.textEditingId && !textTool.isEditingLabel()) || store.codeEditingId
          ? null
          : handles,
      isTransforming,
      selectedIds,
      bbox: null,
    };
  }

  destroy(): void {
    this.cancel();
  }

  onViewChange(): void {
    if (textTool.isEditorMounted()) textTool.onViewChange();
    if (codeTool.isEditorMounted()) codeTool.onViewChange();
    invalidateOverlay();
  }

  /**
   * Called when pointer leaves canvas - clears any hover cursor state.
   */
  onPointerLeave(): void {
    setCursorOverride(null);
    applyCursor();
  }

  // --- Hover ---

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

    if (
      mode === 'standard' &&
      (!store.textEditingId || textTool.isEditingLabel()) &&
      !store.codeEditingId
    ) {
      const bounds = computeSelectionBounds();
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

  // --- Transform Preview ---

  /**
   * Expand the transform envelope and issue a single dirty-rect invalidation.
   * Three-section structure:
   *   1. CONNECTOR TOPOLOGY — reroute connectors, track their bboxes
   *   2. COMPUTE ENVELOPE — accumulate bounds from shapes + strokes
   *   3. SINGLE INVALIDATION — one invalidateWorld() call with the full envelope
   */
  private invalidateTransformPreview(): void {
    const store = useSelectionStore.getState();
    const bounds = computeSelectionBounds();
    if (!bounds) return;

    const transform = store.transform;
    const topology = store.connectorTopology;
    const textReflow = store.textReflow;
    const codeReflow = store.codeReflow;

    // --- 1. CONNECTOR TOPOLOGY ---
    if (topology) {
      // Reroute entries: compute new routes + expand envelope
      for (const entry of topology.entries) {
        if (entry.strategy !== 'reroute') continue;

        const overrides: { start?: EndpointOverrideValue; end?: EndpointOverrideValue } = {};

        if (typeof entry.startSpec === 'string') {
          const origFrame = topology.originalFrames.get(entry.startSpec);
          if (origFrame)
            overrides.start = {
              frame: transformFrameForTopology(
                origFrame,
                transform as TranslateTransform | ScaleTransform,
              ),
            };
        } else if (entry.startSpec === true) {
          overrides.start = transformPositionForTopology(
            entry.originalPoints[0],
            transform as TranslateTransform | ScaleTransform,
          );
        }

        if (typeof entry.endSpec === 'string') {
          const origFrame = topology.originalFrames.get(entry.endSpec);
          if (origFrame)
            overrides.end = {
              frame: transformFrameForTopology(
                origFrame,
                transform as TranslateTransform | ScaleTransform,
              ),
            };
        } else if (entry.endSpec === true) {
          overrides.end = transformPositionForTopology(
            entry.originalPoints[entry.originalPoints.length - 1],
            transform as TranslateTransform | ScaleTransform,
          );
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
      const {
        selectionKind,
        handleKind,
        handleId,
        origin,
        scaleX,
        scaleY,
        originBounds,
        bboxBounds,
      } = transform;

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
          const { dx, dy } = computeStrokeTranslation(
            handle,
            originBounds,
            scaleX,
            scaleY,
            origin,
            handleId,
          );
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
        } else if (handle.kind === 'text') {
          const textFrame = getTextFrame(handle.id);
          if (!textFrame) continue;

          if (
            handleKind === 'corner' ||
            ((handleId === 'n' || handleId === 's') && selectionKind === 'textOnly')
          ) {
            // Uniform scale: corner always, textOnly N/S
            const textBounds = frameTupleToWorldBounds(textFrame);
            objBounds = computeUniformScaleBounds(textBounds, originBounds, origin, scaleX, scaleY);
          } else if ((handleId === 'e' || handleId === 'w') && textReflow) {
            const props = getTextProps(handle.y);
            if (!props) continue;
            const measured = textLayoutCache.getMeasuredContent(handle.id);
            if (!measured) continue;

            const [fx, fy, fw] = textFrame;
            const ox = origin[0];

            // Scale both edges, normalize
            const scaledLeft = ox + (fx - ox) * scaleX;
            const scaledRight = ox + (fx + fw - ox) * scaleX;
            const left = Math.min(scaledLeft, scaledRight);
            const right = Math.max(scaledLeft, scaledRight);
            const rawWidth = right - left;
            const minW = getMinCharWidth(props.fontSize, props.fontFamily);
            const targetWidth = Math.max(minW, rawWidth);

            // Anchor clamping: pin edge closest to scale origin
            let newLeft: number;
            if (targetWidth > rawWidth) {
              newLeft = Math.abs(left - ox) <= Math.abs(right - ox) ? left : right - targetWidth;
            } else {
              newLeft = left;
            }

            // Layout
            const layout = layoutMeasuredContent(measured, targetWidth, props.fontSize);
            const newOriginX = newLeft + anchorFactor(props.align) * targetWidth;
            const newOriginY = props.origin[1];

            // Store
            textReflow.layouts.set(handle.id, layout);
            textReflow.origins.set(handle.id, [newOriginX, newOriginY]);

            // Dirty rect
            const newHeight = layout.lines.length * layout.lineHeight;
            objBounds = frameTupleToWorldBounds([newLeft, fy, targetWidth, newHeight]);
          } else if ((handleId === 'n' || handleId === 's') && selectionKind === 'mixed') {
            // Mixed + N/S: edge-pin translate
            const [fx, , fw, fh] = textFrame;
            const { dx, dy } = computeEdgePinTranslation(
              fx,
              fx + fw,
              textFrame[1],
              textFrame[1] + fh,
              originBounds,
              scaleX,
              scaleY,
              origin,
              handleId,
            );
            objBounds = translateBounds(frameTupleToWorldBounds(textFrame), dx, dy);
          } else {
            continue;
          }
        } else if (handle.kind === 'code') {
          const codeFrame = getCodeFrame(handle.id);
          if (!codeFrame) continue;

          if (
            handleKind === 'corner' ||
            ((handleId === 'n' || handleId === 's') && selectionKind === 'codeOnly')
          ) {
            const codeBounds = frameTupleToWorldBounds(codeFrame);
            objBounds = computeUniformScaleBounds(codeBounds, originBounds, origin, scaleX, scaleY);
          } else if ((handleId === 'e' || handleId === 'w') && codeReflow) {
            const props = getCodeProps(handle.y);
            if (!props) continue;
            const sourceLines = codeSystem.getSourceLines(handle.id);
            if (!sourceLines) continue;

            const [fx, fy, fw] = codeFrame;
            const ox = origin[0];
            const scaledLeft = ox + (fx - ox) * scaleX;
            const scaledRight = ox + (fx + fw - ox) * scaleX;
            const left = Math.min(scaledLeft, scaledRight);
            const right = Math.max(scaledLeft, scaledRight);
            const rawWidth = right - left;
            const minW = getCodeMinWidth(props.fontSize);
            const targetWidth = Math.max(minW, rawWidth);

            let newLeft: number;
            if (targetWidth > rawWidth) {
              newLeft = Math.abs(left - ox) <= Math.abs(right - ox) ? left : right - targetWidth;
            } else {
              newLeft = left;
            }

            const layout = computeCodeLayout(sourceLines, props.fontSize, targetWidth);
            codeReflow.layouts.set(handle.id, layout);
            codeReflow.origins.set(handle.id, [newLeft, props.origin[1]]);

            const newHeight = codeTotalHeight(layout, props.fontSize);
            objBounds = frameTupleToWorldBounds([newLeft, fy, targetWidth, newHeight]);
          } else if ((handleId === 'n' || handleId === 's') && selectionKind === 'mixed') {
            const [fx, , fw, fh] = codeFrame;
            const { dx, dy } = computeEdgePinTranslation(
              fx,
              fx + fw,
              codeFrame[1],
              codeFrame[1] + fh,
              originBounds,
              scaleX,
              scaleY,
              origin,
              handleId,
            );
            objBounds = translateBounds(frameTupleToWorldBounds(codeFrame), dx, dy);
          } else {
            continue;
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

  // --- Commit ---

  private commitTranslate(
    selectedIds: string[],
    dx: number,
    dy: number,
    topology: ConnectorTopology | null,
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
        } else if (handle.kind === 'text' || handle.kind === 'code') {
          // Text/code store position as origin, not frame.
          const origin = getOrigin(yMap);
          if (!origin) continue;
          yMap.set('origin', [origin[0] + dx, origin[1] + dy]);
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
            const newPoints: [number, number][] = entry.originalPoints.map(([x, y]) => [
              x + dx,
              y + dy,
            ]);
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
    topology: ConnectorTopology | null,
    textReflow: TextReflowState | null,
    codeReflow: CodeReflowState | null,
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
          const { dx, dy } = computeStrokeTranslation(
            handle,
            originBounds,
            scaleX,
            scaleY,
            origin,
            handleId,
          );
          const points = getPoints(yMap);
          if (points.length === 0) continue;
          const newPoints: [number, number][] = points.map(([x, y]) => [x + dx, y + dy]);
          yMap.set('points', newPoints);
          continue;
        }

        // CASE 2: Stroke scaling (strokesOnly or mixed+corner)
        // Uses applyUniformScaleToPoints (bbox-center based) to match render preview
        if (isStroke) {
          const points = getPoints(yMap);
          if (points.length === 0) continue;
          const { points: newPoints, absScale } = applyUniformScaleToPoints(
            points as [number, number][],
            handle.bbox,
            originBounds,
            origin,
            scaleX,
            scaleY,
          );
          yMap.set('points', newPoints);
          yMap.set('width', getWidth(yMap) * absScale);
          continue;
        }

        // Text: corner/textOnly-N/S = uniform scale, E/W = reflow, mixed-N/S = edge-pin
        if (handle.kind === 'text') {
          if (
            handleKind === 'corner' ||
            ((handleId === 'n' || handleId === 's') && selectionKind === 'textOnly')
          ) {
            // Uniform scale for corner always + textOnly N/S
            const textFrame = getTextFrame(handle.id);
            if (!textFrame) continue;

            const props = getTextProps(yMap);
            if (!props) continue;

            const uniformScale = computeUniformScaleNoThreshold(scaleX, scaleY);
            const rawAbsScale = Math.abs(uniformScale);

            const roundedFontSize = Math.round(props.fontSize * rawAbsScale * 1000) / 1000;
            const effectiveAbsScale = roundedFontSize / props.fontSize;

            const [fx, fy, fw, fh] = textFrame;
            const cx = fx + fw / 2;
            const cy = fy + fh / 2;
            const [newCx, newCy] = computePreservedPosition(
              cx,
              cy,
              originBounds,
              origin,
              uniformScale,
            );

            const nfw = fw * effectiveAbsScale;
            const nfx = newCx - nfw / 2;
            const nfy = newCy - (fh * effectiveAbsScale) / 2;

            const newOriginX = nfx + anchorFactor(props.align) * nfw;
            const newOriginY = nfy + roundedFontSize * getBaselineToTopRatio(props.fontFamily);

            yMap.set('origin', [newOriginX, newOriginY]);
            yMap.set('fontSize', roundedFontSize);

            if (typeof props.width === 'number') {
              yMap.set('width', props.width * effectiveAbsScale);
            }
          } else if ((handleId === 'e' || handleId === 'w') && textReflow) {
            const layout = textReflow.layouts.get(handle.id);
            const reflowOrigin = textReflow.origins.get(handle.id);
            if (layout && reflowOrigin) {
              yMap.set('width', layout.boxWidth);
              yMap.set('origin', reflowOrigin);
            }
          } else if ((handleId === 'n' || handleId === 's') && selectionKind === 'mixed') {
            // Mixed + N/S: edge-pin translate origin
            const textFrame = getTextFrame(handle.id);
            if (!textFrame) continue;
            const [fx, , fw, fh] = textFrame;
            const { dy } = computeEdgePinTranslation(
              fx,
              fx + fw,
              textFrame[1],
              textFrame[1] + fh,
              originBounds,
              scaleX,
              scaleY,
              origin,
              handleId,
            );
            const curOrigin = getOrigin(yMap);
            if (curOrigin) {
              yMap.set('origin', [curOrigin[0], curOrigin[1] + dy]);
            }
          }
          continue;
        }

        // Code: corner/codeOnly-N/S = uniform scale, E/W = reflow, mixed-N/S = edge-pin
        if (handle.kind === 'code') {
          if (
            handleKind === 'corner' ||
            ((handleId === 'n' || handleId === 's') && selectionKind === 'codeOnly')
          ) {
            const codeFrame = getCodeFrame(handle.id);
            if (!codeFrame) continue;
            const props = getCodeProps(yMap);
            if (!props) continue;

            const uniformScale = computeUniformScaleNoThreshold(scaleX, scaleY);
            const rawAbsScale = Math.abs(uniformScale);
            const roundedFontSize = Math.round(props.fontSize * rawAbsScale * 1000) / 1000;
            const effectiveAbsScale = roundedFontSize / props.fontSize;

            const [fx, fy, fw, fh] = codeFrame;
            const cx = fx + fw / 2;
            const cy = fy + fh / 2;
            const [newCx, newCy] = computePreservedPosition(
              cx,
              cy,
              originBounds,
              origin,
              uniformScale,
            );

            const nfw = fw * effectiveAbsScale;
            const nfx = newCx - nfw / 2;
            const nfy = newCy - (fh * effectiveAbsScale) / 2;

            yMap.set('origin', [nfx, nfy]);
            yMap.set('fontSize', roundedFontSize);
            yMap.set('width', props.width * effectiveAbsScale);
          } else if ((handleId === 'e' || handleId === 'w') && codeReflow) {
            const layout = codeReflow.layouts.get(handle.id);
            const reflowOrigin = codeReflow.origins.get(handle.id);
            if (layout && reflowOrigin) {
              yMap.set('width', layout.totalWidth);
              yMap.set('origin', reflowOrigin);
            }
          } else if ((handleId === 'n' || handleId === 's') && selectionKind === 'mixed') {
            const codeFrame = getCodeFrame(handle.id);
            if (!codeFrame) continue;
            const [fx, , fw, fh] = codeFrame;
            const { dy } = computeEdgePinTranslation(
              fx,
              fx + fw,
              codeFrame[1],
              codeFrame[1] + fh,
              originBounds,
              scaleX,
              scaleY,
              origin,
              handleId,
            );
            const curOrigin = getOrigin(yMap);
            if (curOrigin) yMap.set('origin', [curOrigin[0], curOrigin[1] + dy]);
          }
          continue;
        }

        // CASE 3: Shape scaling
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
   * Commit endpoint drag results to Y.Doc.
   * Updates connector points, start/end positions, and anchor data.
   */
  private commitEndpointDrag(
    connectorId: string,
    endpoint: 'start' | 'end',
    routedPoints: [number, number][],
    currentSnap: SnapTarget | null,
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
      store.setSelection(selectedIds);
      // Re-enable marquee since setSelection clears it
      store.beginMarquee(marquee.anchor);
      if (marquee.current) {
        store.updateMarquee(marquee.current);
      }
    }
  }

  // --- Hit Testing ---

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
    const sorted = [...candidates].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

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
          return 'fill'; // Filled shape interior or border
        }
        if (!c.isFilled && !c.insideInterior) {
          return 'ink'; // Unfilled shape BORDER (outline stroke)
        }
        return null; // Unfilled shape interior = transparent
      }

      return 'ink'; // Fallback: treat as paint
    };

    let bestFrame: HitCandidate | null = null; // Smallest unfilled interior
    let firstPaint: HitCandidate | null = null; // First visible paint in Z
    let firstPaintClass: PaintClass | null = null;

    // Scan from topmost to bottommost, respecting occlusion
    for (const c of sorted) {
      if (isFrameInterior(c)) {
        // Transparent frame region: remember smallest, keep scanning
        if (!bestFrame || c.area < bestFrame.area) {
          bestFrame = c;
        }
        continue; // Don't stop - look for paint underneath
      }

      const paintClass = classifyPaint(c);
      if (paintClass !== null) {
        // Found first painted thing - this occludes everything below
        firstPaint = c;
        firstPaintClass = paintClass;
        break; // Stop scanning
      }
    }

    // Case 1: Only frame interiors, no paint at this pixel
    if (!firstPaint && bestFrame) {
      return bestFrame; // Return smallest frame (most nested)
    }

    // Case 2: No paint and no frames (shouldn't happen)
    if (!firstPaint) {
      return sorted[0]; // Fallback to topmost
    }

    // Case 3: First painted thing is ink (stroke/text/connector/border)
    // Ink ALWAYS beats frames
    if (firstPaintClass === 'ink') {
      return firstPaint;
    }

    // Case 4: First painted thing is a filled shape interior
    if (!bestFrame) {
      return firstPaint; // No frames to compare with
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
