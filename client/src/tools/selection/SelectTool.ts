import type { HandleId, PointerTool, PreviewData } from '../types';
import { textTool, codeTool } from '@/runtime/tool-registry';
import { useSelectionStore, computeHandles, computeSelectionBounds } from '@/stores/selection-store';
import { worldToCanvas } from '@/stores/camera-store';
import { scaleBBoxAround, pointsToBBox, translateBBox } from '@/core/geometry/bounds';
import { pointInBBox } from '@/core/geometry/hit-primitives';
import { hitResizeHandle, hitEndpointDot, type EndpointHit } from '@/core/spatial/handle-hit';
import type { HitCandidate } from '@/core/spatial/kind-capability';
import { queryHits, queryHandles } from '@/core/spatial/object-query';
import { pickFrameAware } from '@/core/spatial/pickers';
import { inBBox } from '@/core/spatial/region';
import type { BBoxTuple } from '@/core/types/geometry';
import { getStartAnchor, getEndAnchor, getConnectorType } from '@/core/accessors';
import { getHandle, transact, getObjects } from '@/runtime/room-runtime';
import { isShiftHeld, isCtrlOrMetaHeld, isCtrlHeld } from '@/runtime/InputManager';
import { invalidateWorldBBox } from '@/renderer/RenderLoop';
import { invalidateOverlay } from '@/renderer/OverlayRenderLoop';
import { applyCursor, setCursorOverride } from '@/stores/device-ui-store';
import { contextMenuController } from '@/runtime/ContextMenuController';
import { rerouteConnector, type EndpointOverrideValue } from '@/core/connectors/reroute-connector';
import { findBestSnapTarget } from '@/core/connectors/snap';
import type { SnapTarget } from '@/core/connectors/types';
import { handleCursor } from '@/core/types/handles';
import { getController, getTransformScaleCtx } from './transform';

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
  private pendingHandleId: HandleId | null = null;
  private endpointHitAtDown: EndpointHit | null = null;

  // Target classification for pointer down
  private downTarget: DownTarget = 'none';
  private downTimeMs: number = 0;

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
      const handleHit = selectionBounds ? hitResizeHandle([worldX, worldY], selectionBounds) : null;
      if (handleHit) {
        this.pendingHandleId = handleHit;
        this.downTarget = 'handle';
        this.phase = 'pendingClick';
        invalidateOverlay();
        return;
      }
    } else if (mode === 'connector') {
      // Connector mode: check endpoint dots first
      const endpointHit = hitEndpointDot([worldX, worldY], selectedIds);
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
      const hitId = hit.handle.id;
      const hitKind = hit.handle.kind;
      const isSelected = selectedIds.includes(hitId);
      //NO LONGER USED, BAD UX: if (!isSelected && selectedIds.length > 0) store.clearSelection();
      this.downTarget = isSelected ? 'objectInSelection' : 'objectOutsideSelection';
      this.phase = 'pendingClick';
      // Single text/code re-click: undo hide so editor mounts without menu flash (hide deferred to move)
      if (
        isSelected &&
        selectedIds.length === 1 &&
        (hitKind === 'text' || hitKind === 'code' || hitKind === 'note' || textTool.justClosedLabelId === hitId)
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
      if (selectionBounds && pointInBBox([worldX, worldY], selectionBounds)) {
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
            useSelectionStore.getState().beginScale(this.pendingHandleId!, this.downWorld!);
            if (useSelectionStore.getState().transform.kind !== 'scale') {
              this.phase = 'idle';
              break;
            }
            setCursorOverride(handleCursor(this.pendingHandleId!));
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

            const hitHandle = this.hitAtDown!.handle;

            // Connectors: check anchor state to decide drag behavior
            if (hitHandle.kind === 'connector') {
              const sa = getStartAnchor(hitHandle.y);
              const ea = getEndAnchor(hitHandle.y);
              if (sa || ea) {
                // Anchored → marquee (can't translate anchored connector)
                this.phase = 'marquee';
                useSelectionStore.getState().beginMarquee(this.downWorld!);
                useSelectionStore.getState().updateMarquee([worldX, worldY]);
                this.updateMarqueeSelection();
                break;
              }
            }

            // Non-connector or free connector: select + translate
            const store = useSelectionStore.getState();
            store.setSelection([hitHandle.id]);
            this.phase = 'translate';
            useSelectionStore.getState().beginTranslate();
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
            useSelectionStore.getState().beginTranslate();
            break;
          }

          case 'selectionGap': {
            // NEVER marquee from inside selection!
            if (!passMove && !passTime) break;
            // Drag intent → translate selection
            this.phase = 'translate';
            useSelectionStore.getState().beginTranslate();
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
          useSelectionStore.getState().updateTranslate(worldX - this.downWorld[0], worldY - this.downWorld[1]);
        }
        break;
      }

      case 'scale': {
        if (useSelectionStore.getState().transform.kind !== 'scale') break;
        useSelectionStore.getState().updateScale(worldX, worldY);
        break;
      }

      case 'endpointDrag': {
        const epTransform = useSelectionStore.getState().transform;
        if (epTransform.kind !== 'endpointDrag') break;

        const { connectorId, endpoint } = epTransform;

        // Read connector type for snap context
        const connHandle = getHandle(connectorId);
        const epConnectorType = connHandle ? getConnectorType(connHandle.y) : 'elbow';

        // 1. Find snap target (Ctrl suppresses snapping)
        const snap = isCtrlHeld()
          ? null
          : findBestSnapTarget({
              cursorWorld: [worldX, worldY],
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

          case 'objectOutsideSelection': {
            const hitId = this.hitAtDown!.handle.id;
            if (this.hasAddModifier()) {
              // Additive: add to current selection
              const current = store.selectedIds;
              if (!current.includes(hitId)) {
                store.setSelection([...current, hitId]);
              }
            } else {
              // Replace selection
              store.setSelection([hitId]);
            }
            break;
          }

          case 'objectInSelection': {
            const hitHandle = this.hitAtDown!.handle;
            const hitId = hitHandle.id;
            if (this.hasAddModifier()) {
              // Subtractive: remove from selection
              const remaining = store.selectedIds.filter((id) => id !== hitId);
              if (remaining.length > 0) {
                store.setSelection(remaining);
              } else {
                store.clearSelection();
              }
            } else if (store.selectedIds.length > 1) {
              // Drill down to single object
              store.setSelection([hitId]);
            } else if (
              (hitHandle.kind === 'text' || hitHandle.kind === 'shape' || hitHandle.kind === 'note') &&
              !textTool.isEditorMounted()
            ) {
              if (textTool.justClosedLabelId === hitId) {
                textTool.justClosedLabelId = null;
              } else {
                textTool.startEditing(hitId, this.downWorld!);
              }
            } else if (hitHandle.kind === 'code' && !codeTool.isEditorMounted()) {
              if (codeTool.justClosedCodeId === hitId) {
                codeTool.justClosedCodeId = null;
              } else {
                codeTool.startEditing(hitId, this.downWorld!);
              }
            }
            break;
          }

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
    if (this.phase === 'endpointDrag') {
      const store = useSelectionStore.getState();
      if (store.transform.kind === 'endpointDrag') {
        invalidateWorldBBox(store.transform.prevBbox);
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

    if (mode === 'standard' && (!store.textEditingId || textTool.isEditingLabel()) && !store.codeEditingId) {
      const bounds = computeSelectionBounds();
      if (bounds) {
        const handle = hitResizeHandle([worldX, worldY], bounds);
        if (handle) {
          setCursorOverride(handleCursor(handle));
          applyCursor();
          return;
        }
      }
    } else if (mode === 'connector') {
      const endpointHit = hitEndpointDot([worldX, worldY], selectedIds);
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
    this.pendingHandleId = null;
    this.endpointHitAtDown = null;
    this.downTarget = 'none';
    this.downTimeMs = 0;
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
    const overlapping = queryHandles({ region: inBBox(marqueeBBox), precise: 'rect' });
    const currentSet = store.selectedIdSet;

    if (overlapping.length === currentSet.size) {
      let same = true;
      for (const h of overlapping) {
        if (!currentSet.has(h.id)) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    store.setSelection(overlapping.map((h) => h.id));
  }

  // --- Hit Testing ---

  private hitTestObjects(worldX: number, worldY: number): HitCandidate | null {
    return pickFrameAware(queryHits({ at: [worldX, worldY], radius: { px: HIT_RADIUS_PX + HIT_SLACK_PX } }));
  }
}
