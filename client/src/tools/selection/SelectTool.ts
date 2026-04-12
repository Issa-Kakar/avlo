import type { HandleId, PointerTool, PreviewData } from '../types';
import { textTool, codeTool } from '@/runtime/tool-registry';
import { useSelectionStore, computeHandles, computeSelectionBounds } from '@/stores/selection-store';
import { useCameraStore, worldToCanvas } from '@/stores/camera-store';
import { scaleBBoxAround, pointsToBBox, translateBBox, frameToBbox } from '@/core/geometry/bounds';
import {
  pointInBBox,
  hitTestHandle,
  hitTestEndpointDots,
  objectIntersectsRect,
  testObjectHit,
  type HitCandidate,
  type EndpointHit,
} from '@/core/geometry/hit-testing';
import type { BBoxTuple } from '@/core/types/geometry';
import { getStartAnchor, getEndAnchor, getConnectorType } from '@/core/accessors';
import { getCurrentSnapshot, getSpatialIndex, getHandle, transact, getObjects } from '@/runtime/room-runtime';
import { isShiftHeld, isCtrlOrMetaHeld, isCtrlHeld } from '@/runtime/InputManager';
import { invalidateWorldBBox } from '@/renderer/RenderLoop';
import { invalidateOverlay } from '@/renderer/OverlayRenderLoop';
import { applyCursor, setCursorOverride } from '@/stores/device-ui-store';
import { contextMenuController } from '@/runtime/ContextMenuController';
import { rerouteConnector, type EndpointOverrideValue } from '@/core/connectors/reroute-connector';
import { findBestSnapTarget } from '@/core/connectors/snap';
import type { SnapTarget } from '@/core/connectors/types';
import { scaleOrigin, handlePosition, handleCursor } from '@/core/types/handles';
import { getTextFrame } from '@/core/text/text-system';
import { getController, getTransformScaleCtx, rawScaleFactors } from './transform';

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
 * - Room: room-runtime helpers (transact, getHandle, etc.)
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

  private initialDelta: [number, number] | null = null;
  private clickOffset: [number, number] | null = null;

  constructor() {}

  private hasAddModifier(): boolean {
    return isShiftHeld() || isCtrlOrMetaHeld();
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
    if (mode === 'standard' && selectedIds.length > 0 && (!textEditingId || textTool.isEditingLabel()) && !store.codeEditingId) {
      // Standard mode: check resize handles first
      const selectionBounds = computeSelectionBounds();
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
      const { scale } = useCameraStore.getState();
      const endpointHit = hitTestEndpointDots(worldX, worldY, selectedIds, getCurrentSnapshot(), scale);
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
        (hit.kind === 'text' || hit.kind === 'code' || hit.kind === 'note' || textTool.justClosedLabelId === hit.id)
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
      if (selectionBounds && pointInBBox(worldX, worldY, selectionBounds)) {
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
            this.phase = 'scale';

            const store = useSelectionStore.getState();
            const geoBbox = this.computeTransformBoundsForScale();
            if (!geoBbox) break;

            const origin = scaleOrigin(this.activeHandle!, geoBbox);
            const handlePos = handlePosition(this.activeHandle!, geoBbox);
            this.initialDelta = [handlePos[0] - origin[0], handlePos[1] - origin[1]];
            this.clickOffset = [this.downWorld![0] - handlePos[0], this.downWorld![1] - handlePos[1]];

            const ctrl = getController();
            ctrl.beginScale(store.selectedIdSet, store.kindCounts, this.activeHandle!, origin, geoBbox);
            store.beginScale();

            setCursorOverride(handleCursor(this.activeHandle!));
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
            const connHandle = getHandle(this.endpointHitAtDown!.connectorId);
            if (connHandle) {
              useSelectionStore
                .getState()
                .beginEndpointDrag(this.endpointHitAtDown!.connectorId, this.endpointHitAtDown!.endpoint, [
                  ...connHandle.bbox,
                ] as BBoxTuple);
            }
            setCursorOverride('grabbing');
            applyCursor();
            break;
          }

          case 'objectOutsideSelection': {
            if (!passMove) break;

            // Connectors: check anchor state to decide drag behavior
            if (this.hitAtDown?.kind === 'connector') {
              const connHandle = getHandle(this.hitAtDown.id);
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
            this.beginTranslateState();
            break;
          }

          case 'objectInSelection': {
            if (!passMove) break;
            contextMenuController.hide();

            // Connector mode (1 connector): check anchor state
            const inSelStore = useSelectionStore.getState();
            if (inSelStore.mode === 'connector') {
              const connHandle = getHandle(inSelStore.selectedIds[0]);
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
            this.beginTranslateState();
            break;
          }

          case 'selectionGap': {
            // NEVER marquee from inside selection!
            if (!passMove && !passTime) break;
            // Drag intent → translate selection
            this.phase = 'translate';
            this.beginTranslateState();
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
          getController().updateTranslate(worldX - this.downWorld[0], worldY - this.downWorld[1]);
        }
        break;
      }

      case 'scale': {
        if (this.downWorld && this.activeHandle && this.initialDelta && this.clickOffset) {
          const ctrl = getController();
          const scaleCtx = ctrl.getScaleCtx();
          if (scaleCtx) {
            const [sx, sy] = rawScaleFactors(
              worldX - this.clickOffset[0],
              worldY - this.clickOffset[1],
              scaleCtx.origin,
              this.initialDelta,
              scaleCtx.handleId,
            );
            ctrl.updateScale(sx, sy);
          }
        }
        break;
      }

      case 'endpointDrag': {
        const epTransform = useSelectionStore.getState().transform;
        if (epTransform.kind !== 'endpointDrag') break;

        const { scale } = useCameraStore.getState();
        const { connectorId, endpoint } = epTransform;

        // Read connector type for snap context
        const connHandle = getHandle(connectorId);
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
        invalidateWorldBBox(epTransform.prevBbox);
        if (result) invalidateWorldBBox(result.bbox);

        // 5. Update store
        const currentPosition: [number, number] = snap ? snap.position : [worldX, worldY];
        useSelectionStore.getState().updateEndpointDrag(currentPosition, snap ?? null, result?.points ?? null, result?.bbox ?? null);
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
              (this.hitAtDown!.kind === 'text' || this.hitAtDown!.kind === 'shape' || this.hitAtDown!.kind === 'note') &&
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
                codeTool.startEditing(this.hitAtDown!.id, this.downWorld!);
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

      case 'translate':
      case 'scale': {
        const ctrl = getController();
        if (ctrl.hasChange()) {
          ctrl.commit();
        } else {
          ctrl.clear();
        }
        useSelectionStore.getState().endTransform();
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
        invalidateWorldBBox(prevBbox);
        if (routedBbox) invalidateWorldBBox(routedBbox);

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
      getController().cancel();
      useSelectionStore.getState().endTransform();
    } else if (this.phase === 'endpointDrag') {
      const store = useSelectionStore.getState();
      if (store.transform.kind === 'endpointDrag') {
        invalidateWorldBBox(store.transform.prevBbox);
      }
      useSelectionStore.getState().cancelTransform();
    } else {
      useSelectionStore.getState().cancelTransform();
    }

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
    let marqueeRect: BBoxTuple | null = null;
    if (marquee.active && marquee.anchor && marquee.current) {
      marqueeRect = pointsToBBox(marquee.anchor, marquee.current);
    }

    // Connector mode: no selection bounds, no handles
    // Standard mode: compute bounds and handles as usual
    let selectionBounds: BBoxTuple | null = null;
    let handles: { id: HandleId; x: number; y: number }[] | null = null;

    if (mode === 'standard' && selectedIds.length > 0) {
      // During scale, use geometry bounds (selBounds) so selection rect aligns with transform
      // During idle/translate, use bbox-based bounds for visual stroke coverage
      if (transform.kind === 'scale') {
        const sCtx = getTransformScaleCtx();
        if (sCtx) {
          selectionBounds = scaleBBoxAround(sCtx.selBounds, sCtx.origin as [number, number], sCtx.sx, sCtx.sy);
        }
      } else if (transform.kind === 'translate') {
        const baseBounds = computeSelectionBounds();
        const ctrl = getController();
        if (baseBounds) {
          selectionBounds = translateBBox(baseBounds, ctrl.dx, ctrl.dy);
        }
      } else {
        selectionBounds = computeSelectionBounds();
      }
      if (selectionBounds) {
        handles = computeHandles(selectionBounds);
      }
    }

    const isTransforming = transform.kind !== 'none' && transform.kind !== 'endpointDrag';

    return {
      kind: 'selection',
      selectionBounds,
      marqueeRect,
      handles: isTransforming || (store.textEditingId && !textTool.isEditingLabel()) || store.codeEditingId ? null : handles,
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

    if (mode === 'standard' && (!store.textEditingId || textTool.isEditingLabel()) && !store.codeEditingId) {
      const bounds = computeSelectionBounds();
      if (bounds) {
        const handle = hitTestHandle(worldX, worldY, bounds, scale);
        if (handle) {
          setCursorOverride(handleCursor(handle));
          applyCursor();
          return;
        }
      }
    } else if (mode === 'connector') {
      const endpointHit = hitTestEndpointDots(worldX, worldY, selectedIds, getCurrentSnapshot(), scale);
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
    this.initialDelta = null;
    this.clickOffset = null;
  }

  private computeTransformBoundsForScale(): BBoxTuple | null {
    const { selectedIds } = useSelectionStore.getState();
    if (selectedIds.length === 0) return null;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const id of selectedIds) {
      const handle = getHandle(id);
      if (!handle) continue;
      // Text: use layout frame (italic overhangs make bbox differ from visual frame)
      const b = handle.kind === 'text' ? frameToBbox(getTextFrame(id) ?? [0, 0, 0, 0]) : handle.bbox;
      minX = Math.min(minX, b[0]);
      minY = Math.min(minY, b[1]);
      maxX = Math.max(maxX, b[2]);
      maxY = Math.max(maxY, b[3]);
    }
    if (!isFinite(minX)) return null;
    return [minX, minY, maxX, maxY];
  }

  private beginTranslateState(): void {
    const store = useSelectionStore.getState();
    getController().beginTranslate(store.selectedIdSet);
    store.beginTranslate();
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
    transact(() => {
      const yMap = getObjects().get(connectorId);
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

    const marqueeBBox = pointsToBBox(marquee.anchor, marquee.current);
    // WorldBounds-compatible view for spatial index + objectIntersectsRect (external systems)
    const marqueeRect = { minX: marqueeBBox[0], minY: marqueeBBox[1], maxX: marqueeBBox[2], maxY: marqueeBBox[3] };

    // Query spatial index for objects with bbox intersecting marquee (fast filter)
    const results = getSpatialIndex().query(marqueeRect);

    // Geometry-aware intersection test for each candidate
    // Select objects whose actual geometry intersects marquee (industry standard)
    const selectedIds: string[] = [];
    for (const entry of results) {
      const handle = getHandle(entry.id);
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
    const { scale } = useCameraStore.getState();
    const radiusWorld = (HIT_RADIUS_PX + HIT_SLACK_PX) / scale;

    // Query spatial index with bounding box
    const results = getSpatialIndex().query({
      minX: worldX - radiusWorld,
      minY: worldY - radiusWorld,
      maxX: worldX + radiusWorld,
      maxY: worldY + radiusWorld,
    });

    const candidates: HitCandidate[] = [];

    for (const entry of results) {
      const handle = getHandle(entry.id);
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
    const isFrameInterior = (c: HitCandidate): boolean => c.kind === 'shape' && !c.isFilled && c.insideInterior;

    // Everything else that actually paints pixels at this point
    const classifyPaint = (c: HitCandidate): PaintClass | null => {
      if (c.kind === 'stroke' || c.kind === 'connector') return 'ink';

      if (c.kind === 'text') {
        if (c.isFilled && c.insideInterior) return 'fill';
        return 'ink';
      }

      if (c.kind === 'code') {
        if (c.insideInterior) return 'fill';
        return 'ink';
      }

      if (c.kind === 'shape') {
        if (c.isFilled) return 'fill';
        if (!c.insideInterior) return 'ink';
        return null; // Unfilled shape interior = transparent
      }

      return 'ink';
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
