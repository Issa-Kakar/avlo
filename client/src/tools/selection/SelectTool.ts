import { anchorRecordFromSnap } from '@/core/connectors/anchor-atoms';
import {
  buildRouteContext,
  type EndpointDragOverride,
  type RouteContext,
  rerouteEndpointDragInto,
  SLOT_END,
  SLOT_START,
  type Slot,
} from '@/core/connectors/reroute-connector';
import { findBestSnapTarget } from '@/core/connectors/snap';
import type { SnapTarget } from '@/core/connectors/types';
import { copyBbox, pointsToBBoxMut } from '@/core/geometry/bounds';
import { pointInBBox } from '@/core/geometry/hit-primitives';
import { type EndpointHit, hitEndpointDot, hitResizeHandle } from '@/core/spatial/handle-hit';
import { inBBox, pickTopmostPaint, queryHandleIds } from '@/core/spatial/object-query';
import type { BBoxTuple, Point } from '@/core/types/geometry';
import { handleCursor } from '@/core/types/handles';
import type { ConnectorEndpoint, ObjectHandle } from '@/core/types/objects';
import { invalidateOverlay } from '@/renderer/OverlayRenderLoop';
import { invalidateWorldBBox } from '@/renderer/RenderLoop';
import { contextMenuController } from '@/runtime/ContextMenuController';
import { getLastCursorWorld } from '@/runtime/cursor-tracking';
import { isCtrlHeld, isCtrlOrMetaHeld, isShiftHeld } from '@/runtime/InputManager';
import { getHandle, getObjects, transact } from '@/runtime/room-runtime';
import { codeTool, panTool, textTool } from '@/runtime/tool-registry';
import { worldToCanvas } from '@/stores/camera-store';
import { applyCursor, setCursorOverride } from '@/stores/device-ui-store';
import { computeSelectionBounds, useSelectionStore } from '@/stores/selection-store';
import type { HandleId, PointerTool, PreviewData } from '../types';

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
  private hitAtDown: ObjectHandle | null = null;
  private pendingHandleId: HandleId | null = null;
  private endpointHitAtDown: EndpointHit | null = null;

  // Target classification for pointer down
  private downTarget: DownTarget = 'none';
  private downTimeMs: number = 0;

  // Endpoint drag — RouteContext + buffers hoisted at drag-begin, reused per pointer event.
  private dragRouteCtx: RouteContext | null = null;
  private readonly dragPointsBuf: Point[] = [];
  private readonly dragBbox: BBoxTuple = [0, 0, 0, 0];

  // Marquee — local state + scratch bbox + scratch current-point, never reallocated.
  private marqueeActive = false;
  private readonly marqueeBBox: BBoxTuple = [0, 0, 0, 0];
  private readonly marqueeCurrent: Point = [0, 0];

  private updateMarqueeBBox(curX: number, curY: number): void {
    this.marqueeCurrent[0] = curX;
    this.marqueeCurrent[1] = curY;
    pointsToBBoxMut(this.downWorld!, this.marqueeCurrent, this.marqueeBBox);
  }

  getMarqueeBBox(): Readonly<BBoxTuple> | null {
    return this.marqueeActive ? this.marqueeBBox : null;
  }

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
      const hitId = hit.id;
      const hitKind = hit.kind;
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

            // Begin endpoint drag transform — hoist RouteContext + buffer for per-event reuse.
            const connHandle = getHandle(this.endpointHitAtDown!.connectorId);
            if (connHandle) {
              this.dragRouteCtx = buildRouteContext(this.endpointHitAtDown!.connectorId, connHandle.y);
              this.dragPointsBuf.length = 0;
              // Seed dragBbox with the current connector bbox so the first frame's
              // prevBbox snapshot covers stored geometry.
              copyBbox(connHandle.bbox, this.dragBbox);
              useSelectionStore
                .getState()
                .beginEndpointDrag(
                  this.endpointHitAtDown!.connectorId,
                  this.endpointHitAtDown!.endpoint,
                  connHandle.bbox,
                  this.dragPointsBuf,
                  this.dragBbox,
                );
            }
            setCursorOverride('grabbing');
            applyCursor();
            break;
          }

          case 'objectOutsideSelection': {
            if (!passMove) break;

            const hitHandle = this.hitAtDown!;

            // Connectors: check anchor state to decide drag behavior.
            // Bound endpoints are StoredAnchor objects — `!Array.isArray(ep)` distinguishes from free Points.
            if (hitHandle.kind === 'connector') {
              const start = hitHandle.y.get('start') as ConnectorEndpoint | undefined;
              const end = hitHandle.y.get('end') as ConnectorEndpoint | undefined;
              const isAnchored = (start && !Array.isArray(start)) || (end && !Array.isArray(end));
              if (isAnchored) {
                // Anchored → marquee (can't translate anchored connector)
                this.phase = 'marquee';
                this.marqueeActive = true;
                this.updateMarqueeBBox(worldX, worldY);
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

            // Connector mode (1 connector): check anchor state via union branch.
            const inSelStore = useSelectionStore.getState();
            if (inSelStore.mode === 'connector') {
              const connHandle = getHandle(inSelStore.selectedIds[0]);
              if (connHandle?.kind === 'connector') {
                const start = connHandle.y.get('start') as ConnectorEndpoint | undefined;
                const end = connHandle.y.get('end') as ConnectorEndpoint | undefined;
                const isAnchored = (start && !Array.isArray(start)) || (end && !Array.isArray(end));
                if (isAnchored) {
                  // Anchored → marquee (gives visual feedback)
                  this.phase = 'marquee';
                  this.marqueeActive = true;
                  this.updateMarqueeBBox(worldX, worldY);
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
            this.marqueeActive = true;
            this.updateMarqueeBBox(worldX, worldY);
            this.updateMarqueeSelection();
            break;
          }
        }
        break;
      }

      case 'marquee': {
        this.updateMarqueeBBox(worldX, worldY);
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

        const { endpoint } = epTransform;
        const ctx = this.dragRouteCtx;
        if (!ctx) break;

        // 1. Snapshot the current routed bbox into prevBbox BEFORE we mutate dragBbox.
        //    routedBbox === dragBbox (shared ref); copying preserves the dirty-rect chain.
        copyBbox(this.dragBbox, epTransform.prevBbox);

        // 2. Find snap target (Ctrl suppresses snapping). connectorType comes from
        //    the hoisted RouteContext — no per-event Y.Map read.
        const snap = isCtrlHeld()
          ? null
          : findBestSnapTarget({
              cursorWorld: [worldX, worldY],
              prevAttach: epTransform.currentSnap,
              connectorType: ctx.connectorType,
            });

        // 3. Build endpoint override.
        const overrideValue: EndpointDragOverride = snap ?? [worldX, worldY];

        // 4. Reroute mutates dragBbox + dragPointsBuf in place.
        const slot: Slot = endpoint === 'start' ? SLOT_START : SLOT_END;
        const count = rerouteEndpointDragInto(ctx, slot, overrideValue, this.dragBbox, this.dragPointsBuf);

        // 5. Dirty-rect: invalidate the prev (snapshotted in step 1) + new (just-mutated dragBbox).
        invalidateWorldBBox(epTransform.prevBbox);
        if (count > 0) invalidateWorldBBox(this.dragBbox);

        // 6. Push UI state to store (no bbox arg — routedBbox is shared by reference).
        const currentPosition: [number, number] = snap ? snap.position : [worldX, worldY];
        useSelectionStore.getState().updateEndpointDrag(currentPosition, snap ?? null, count);
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
            const hitId = this.hitAtDown!.id;
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
            const hitHandle = this.hitAtDown!;
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
          default:
            // Click on background → deselect
            store.clearSelection();
            break;
        }
        break;
      }

      case 'marquee': {
        this.marqueeActive = false;
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

        const { connectorId, endpoint, pointsBuf, validCount, currentSnap, prevBbox, routedBbox } = epStore.transform;

        // Invalidate the connector region (routedBbox is the shared dragBbox — always present).
        invalidateWorldBBox(prevBbox);
        if (validCount >= 2) invalidateWorldBBox(routedBbox);

        epStore.endTransform();

        // Commit if we have valid routed points (read by validCount, not .length).
        if (validCount >= 2) {
          this.commitEndpointDrag(connectorId, endpoint, pointsBuf, validCount, currentSnap);
        }
        // Clear the gesture context; pointsBuf stays for reuse next gesture.
        this.dragRouteCtx = null;
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
      this.dragRouteCtx = null;
    }
    useSelectionStore.getState().cancelTransform();

    this.marqueeActive = false;
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
    const { selectedIds } = useSelectionStore.getState();
    if (selectedIds.length === 0 && !this.marqueeActive) return null;
    return { kind: 'selection' };
  }

  destroy(): void {
    this.cancel();
  }

  onViewChange(): void {
    if (textTool.isEditorMounted()) textTool.onViewChange();
    if (codeTool.isEditorMounted()) codeTool.onViewChange();
    invalidateOverlay();
    if (this.phase === 'idle') {
      const last = getLastCursorWorld();
      if (last) this.handleHoverCursor(last[0], last[1]);
    }
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
    // Cursor ownership: panTool owns 'grabbing' during MMB/spacebar pan. The
    // camera subscription routes those pans through onViewChange → here, so
    // bail before clobbering panTool's cursor every frame.
    if (panTool.isActive()) return;

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
   * Writes only the dragged side's union value: anchor when snapped, free Point otherwise
   * (route's first/last point captures clearance-applied / pulled-back position). The
   * deep observer reroutes canonically post-tx, populating the local route cache.
   */
  private commitEndpointDrag(
    connectorId: string,
    endpoint: 'start' | 'end',
    pointsBuf: Point[],
    validCount: number,
    currentSnap: SnapTarget | null,
  ): void {
    transact(() => {
      const yMap = getObjects().get(connectorId);
      if (!yMap) return;

      // Read the dragged-side endpoint from the valid-prefix slice — pointsBuf may
      // hold trailing high-water-mark tuples beyond `validCount`. Clone into a
      // fresh tuple so Y.Map doesn't preserve a reference into our pooled buffer.
      const idx = endpoint === 'start' ? 0 : validCount - 1;
      const src = pointsBuf[idx];
      const value: ConnectorEndpoint = currentSnap ? anchorRecordFromSnap(currentSnap) : ([src[0], src[1]] as Point);
      yMap.set(endpoint, value);
    });
  }

  private updateMarqueeSelection(): void {
    if (!this.marqueeActive) return;
    const store = useSelectionStore.getState();
    const overlappingIds = queryHandleIds(inBBox(this.marqueeBBox));
    const currentSet = store.selectedIdSet;

    if (overlappingIds.length === currentSet.size) {
      let same = true;
      for (const id of overlappingIds) {
        if (!currentSet.has(id)) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    store.setSelection(overlappingIds);
  }

  // --- Hit Testing ---

  private hitTestObjects(worldX: number, worldY: number): ObjectHandle | null {
    return pickTopmostPaint([worldX, worldY], { px: HIT_RADIUS_PX + HIT_SLACK_PX });
  }
}
