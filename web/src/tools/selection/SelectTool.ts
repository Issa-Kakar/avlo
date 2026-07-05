import { getConnectorType } from '@/core/accessors';
import { openBookmarkUrl } from '@/core/bookmark/bookmark-actions';
import { getOpenButtonWorldBBox, hitTestOpenButton } from '@/core/bookmark/bookmark-render';
import { hitCodePlayButton } from '@/core/code/code-system';
import { isAnchored } from '@/core/connectors/anchor-atoms';
import { getConnectorLabelRect } from '@/core/connectors/connector-label';
import { getConnectorRoute } from '@/core/connectors/connector-router';
import type { Slot } from '@/core/connectors/reroute-connector';
import { findBestSnapTarget } from '@/core/connectors/snap';
import { pointsToBBoxMut } from '@/core/geometry/bounds';
import { pointInBBox } from '@/core/geometry/hit-primitives';
import { isRunnableCodeBlock, toggleRunCodeBlock } from '@/core/py/py-manager';
import { hitEndpointDot, hitResizeHandle } from '@/core/spatial/handle-hit';
import { inBBox, pickTopmostPaint, queryHandleIds } from '@/core/spatial/object-query';
import type { BBoxTuple, Point } from '@/core/types/geometry';
import type { HandleId } from '@/core/types/handles';
import { handleCursor } from '@/core/types/handles';
import type { ObjectHandle } from '@/core/types/objects';
import { invalidateOverlay } from '@/renderer/OverlayRenderLoop';
import { invalidateWorldBBox } from '@/renderer/RenderLoop';
import { contextMenuController } from '@/runtime/ContextMenuController';
import { getLastCursorWorld } from '@/runtime/input/cursor-tracking';
import { isCtrlHeld, isCtrlOrMetaHeld, isShiftHeld } from '@/runtime/input/InputManager';
import { getHandle } from '@/runtime/room-runtime';
import { codeTool, panTool, textTool } from '@/runtime/tool-registry';
import { useCameraStore, worldToCanvas } from '@/stores/camera-store';
import { applyCursor, setCursorOverride } from '@/stores/device-ui-store';
import { computeSelectionBounds, useSelectionStore } from '@/stores/selection-store';
import {
  ConnectorFlowController,
  type FlowRenderState,
  type FlowSide,
  flowButtonGate,
  hitFlowButton,
} from '@/tools/selection/connector-flow';
import { getController } from '@/tools/selection/transform';
import type { PointerTool, PreviewData } from '../types';

// === Constants ===
const HIT_RADIUS_PX = 6; // Screen-space hit test radius for selection
const HIT_SLACK_PX = 2.0; // Forgiving feel for touch/click precision (like EraserTool)
const MOVE_THRESHOLD_PX = 4; // Pixels before drag detected (screen space)
const CLICK_WINDOW_MS = 180; // Time threshold for gap click disambiguation

// === Types ===

type Phase = 'idle' | 'pendingClick' | 'marquee' | 'translate' | 'scale' | 'endpointDrag' | 'flowDrag';

/**
 * Discriminated union of pointer-down classifications. Replaces four mutually-exclusive
 * optional instance fields + the seven-valued DownTarget enum: each variant carries
 * exactly the data the corresponding pendingClick branch consumes, with no `!.` peeks.
 */
type DownHit =
  | { kind: 'background' }
  | { kind: 'selectionGap' }
  | { kind: 'object'; handle: ObjectHandle; isSelected: boolean }
  | { kind: 'handle'; handleId: HandleId }
  | { kind: 'endpoint'; connectorId: string; slot: Slot }
  | { kind: 'openButton'; handle: ObjectHandle }
  | { kind: 'playButton'; handle: ObjectHandle }
  | { kind: 'flowButton'; side: FlowSide; sourceId: string };

// === SelectTool Class ===

/**
 * SelectTool - Object selection, translation, and scaling tool
 *
 * Zero-arg constructor: reads all dependencies from module-level singletons.
 * - Room: room-runtime helpers (transact, getHandle, etc.)
 * - Invalidation: invalidation-helpers.ts
 * - Cursor: useDeviceUIStore (applyCursor, setCursorOverride)
 * - Camera/Selection: Zustand stores
 *
 * Endpoint drag's RouteContext + buffer + bbox snapshots live on TransformController;
 * SelectTool just routes lifecycle through `getController().beginEndpointDrag(...)`
 * and the standard `endTransform` / `cancelTransform` store actions.
 */
export class SelectTool implements PointerTool {
  // State machine
  private phase: Phase = 'idle';
  private pointerId: number | null = null;
  private downWorld: [number, number] | null = null;
  private downScreen: [number, number] | null = null;
  private downTimeMs: number = 0;
  private downHit: DownHit = { kind: 'background' };

  // Marquee — local state + scratch bbox + scratch current-point, never reallocated.
  private marqueeActive = false;
  private readonly marqueeBBox: BBoxTuple = [0, 0, 0, 0];
  private readonly marqueeCurrent: Point = [0, 0];

  // Bookmark Open-button hover indicator. Drives base-canvas hover-fill via
  // objects.ts frame-top read of getHoveredOpenBookmarkId().
  private hoveredOpenBookmarkId: string | null = null;

  // Connector-flow controller — owns flow-button hover + drag state. Never
  // touches selection-store.transform (transform.kind stays 'none').
  private readonly connectorFlow = new ConnectorFlowController();

  private updateMarqueeBBox(curX: number, curY: number): void {
    this.marqueeCurrent[0] = curX;
    this.marqueeCurrent[1] = curY;
    pointsToBBoxMut(this.downWorld!, this.marqueeCurrent, this.marqueeBBox);
  }

  getMarqueeBBox(): Readonly<BBoxTuple> | null {
    return this.marqueeActive ? this.marqueeBBox : null;
  }

  /** Connector-flow render snapshot for the overlay (mirrors getMarqueeBBox). */
  getConnectorFlowRender(): FlowRenderState {
    return this.connectorFlow.getRenderSnapshot();
  }

  getHoveredOpenBookmarkId(): string | null {
    return this.hoveredOpenBookmarkId;
  }

  private clearBookmarkOpenHoverIfAny(): void {
    if (this.hoveredOpenBookmarkId !== null) {
      const id = this.hoveredOpenBookmarkId;
      this.hoveredOpenBookmarkId = null;
      const bbox = getOpenButtonWorldBBox(id);
      if (bbox) invalidateWorldBBox(bbox);
    }
  }

  private rehoverFromLastCursor(): void {
    if (this.phase !== 'idle') return;
    const last = getLastCursorWorld();
    if (last) this.handleHoverCursor(last[0], last[1]);
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
    // Any gesture other than the openButton branch consumes prior hover;
    // openButton re-sets it below before invalidating the overlay.
    this.clearBookmarkOpenHoverIfAny();

    this.pointerId = pointerId;
    this.downWorld = [worldX, worldY];
    this.downTimeMs = performance.now();

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
        this.downHit = { kind: 'handle', handleId: handleHit };
        this.phase = 'pendingClick';
        invalidateOverlay();
        return;
      }
    } else if (mode === 'connector') {
      // Connector mode: check endpoint dots first
      const endpointHit = hitEndpointDot([worldX, worldY], selectedIds);
      if (endpointHit) {
        this.downHit = { kind: 'endpoint', connectorId: endpointHit.connectorId, slot: endpointHit.slot };
        this.phase = 'pendingClick';
        setCursorOverride('grabbing');
        applyCursor();
        invalidateOverlay();
        return;
      }
    }

    // 1b. Flow buttons — single bindable selection. Tested before the generic
    // object hit so a button overlapping a neighboring object still starts a flow.
    const flowGate = flowButtonGate();
    if (flowGate) {
      const flowSide = hitFlowButton([worldX, worldY], flowGate.bbox, useCameraStore.getState().scale);
      if (flowSide) {
        // Ensure the hover preview exists for end()'s commit — covers a touch
        // tap with no prior hover move. Idempotent for the mouse path.
        this.connectorFlow.updateHover(flowGate.handle.id, flowSide, flowGate.handle);
        this.downHit = { kind: 'flowButton', side: flowSide, sourceId: flowGate.handle.id };
        this.phase = 'pendingClick';
        invalidateOverlay();
        return;
      }
    }

    // 2. Common: object hit test
    const hit = this.hitTestObjects(worldX, worldY);

    if (hit) {
      // Bookmark Open-button: handled below standard handle/endpoint priority
      // (those returned already) but above the regular object click. Shift/Ctrl
      // falls through to additive object selection — standard convention.
      if (hit.kind === 'bookmark' && !this.hasAddModifier() && hitTestOpenButton(hit, worldX, worldY)) {
        this.downHit = { kind: 'openButton', handle: hit };
        this.hoveredOpenBookmarkId = hit.id;
        this.phase = 'pendingClick';
        invalidateOverlay();
        return;
      }
      // Code play/stop button — same priority slot as the bookmark Open chip.
      // Gated on runnability (python only, v1) so other languages keep the
      // decorative button + plain click-to-select behavior.
      if (
        hit.kind === 'code' &&
        !this.hasAddModifier() &&
        isRunnableCodeBlock(hit.id) &&
        hitCodePlayButton(hit.id, hit.y, worldX, worldY)
      ) {
        this.downHit = { kind: 'playButton', handle: hit };
        this.phase = 'pendingClick';
        invalidateOverlay();
        return;
      }
      const isSelected = selectedIds.includes(hit.id);
      this.downHit = { kind: 'object', handle: hit, isSelected };
      this.phase = 'pendingClick';
      // Single-selected editable-text re-click: undo deferred hide so end()'s
      // editor mount doesn't flash. Covers every kind that can enter text editing
      // on click — text, code, note, and shape (label-less shapes create the label
      // on first click, so they belong here too).
      if (
        isSelected &&
        selectedIds.length === 1 &&
        (hit.kind === 'text' || hit.kind === 'code' || hit.kind === 'note' || hit.kind === 'shape')
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
        this.downHit = { kind: 'selectionGap' };
        this.phase = 'pendingClick';
        invalidateOverlay();
        return;
      }
    }
    // Connector mode has no selection bounds → no gap, straight to background

    if (selectedIds.length > 0) store.clearSelection();
    this.downHit = { kind: 'background' };
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
        switch (this.downHit.kind) {
          case 'handle': {
            if (!passMove) break;
            const handleId = this.downHit.handleId;
            this.phase = 'scale';
            useSelectionStore.getState().beginScale(handleId, this.downWorld!);
            if (useSelectionStore.getState().transform.kind !== 'scale') {
              this.phase = 'idle';
              break;
            }
            setCursorOverride(handleCursor(handleId));
            applyCursor();
            break;
          }

          case 'flowButton': {
            if (!passMove) break;
            const { side, sourceId } = this.downHit;
            const handle = getHandle(sourceId);
            if (!handle || !this.connectorFlow.beginDrag(sourceId, side, handle)) {
              this.phase = 'idle';
              break;
            }
            // Drag clears the selection — hides handles + buttons — then runs a
            // live connector exactly like ConnectorTool.
            this.phase = 'flowDrag';
            this.connectorFlow.clearHover();
            useSelectionStore.getState().clearSelection();
            this.connectorFlow.updateDrag(worldX, worldY);
            break;
          }

          case 'endpoint': {
            // Connector mode only: dragging an endpoint dot
            if (!passMove) break;

            const { connectorId, slot } = this.downHit;
            // Drill down to single connector if multiple selected
            const epStore = useSelectionStore.getState();
            if (epStore.selectedIds.length > 1) epStore.setSelection([connectorId]);

            const connHandle = getHandle(connectorId);
            if (!connHandle) break;
            // Controller owns RouteContext + buffer + bbox snapshots for the gesture.
            if (!getController().beginEndpointDrag(connectorId, slot, connHandle)) break;
            this.phase = 'endpointDrag';
            useSelectionStore.getState().beginEndpointDrag(connectorId, slot);
            setCursorOverride('grabbing');
            applyCursor();
            break;
          }

          case 'object': {
            if (!passMove) break;
            const { handle, isSelected } = this.downHit;
            const store = useSelectionStore.getState();
            // Anchored connectors: marquee (cannot translate them rigidly).
            if (handle.kind === 'connector' && isAnchored(handle)) {
              this.phase = 'marquee';
              this.marqueeActive = true;
              this.updateMarqueeBBox(worldX, worldY);
              this.updateMarqueeSelection();
              break;
            }
            if (isSelected) contextMenuController.hide();
            else store.setSelection([handle.id]);
            this.phase = 'translate';
            useSelectionStore.getState().beginTranslate();
            break;
          }

          case 'openButton': {
            if (!passMove) break;
            // Drift on a pressed Open button is a translate intent — user is
            // moving the bookmark, exactly as if they'd clicked elsewhere on
            // the card. Promote to translate; mirrors the 'object' case. Hover
            // state stays set: ambient `ctx.translate(tdx, tdy)` in objects.ts
            // carries the hover-painted button along with the bookmark, so the
            // cursor stays attached to the button visually for the whole drag.
            const { handle } = this.downHit;
            const store = useSelectionStore.getState();
            const isSelected = store.selectedIds.includes(handle.id);
            if (isSelected) contextMenuController.hide();
            else store.setSelection([handle.id]);
            this.phase = 'translate';
            useSelectionStore.getState().beginTranslate();
            break;
          }

          case 'playButton': {
            if (!passMove) break;
            // Drift on a pressed play button = translate intent (mirrors the
            // bookmark openButton promotion).
            const { handle } = this.downHit;
            const store = useSelectionStore.getState();
            const isSelected = store.selectedIds.includes(handle.id);
            if (isSelected) contextMenuController.hide();
            else store.setSelection([handle.id]);
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

      case 'flowDrag': {
        this.connectorFlow.updateDrag(worldX, worldY);
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
        // Read connectorType from the live handle (cheaper than threading through controller).
        const handle = getHandle(epTransform.connectorId);
        if (handle?.kind !== 'connector') break;
        const snap = isCtrlHeld()
          ? null
          : findBestSnapTarget({
              cursorWorld: [worldX, worldY],
              prevAttach: epTransform.currentSnap,
              connectorType: getConnectorType(handle.y),
            });
        getController().updateEndpointDrag(worldX, worldY, snap);
        const currentPosition: [number, number] = snap ? snap.position : [worldX, worldY];
        useSelectionStore.getState().updateEndpointDrag(currentPosition, snap);
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

        switch (this.downHit.kind) {
          case 'handle':
            // Clicked handle but didn't drag → no-op
            break;

          case 'flowButton': {
            // Click (no drag) → commit the precomputed hover preview.
            const id = this.connectorFlow.commitHover();
            if (id) store.setSelection([id]);
            this.connectorFlow.clearHover();
            break;
          }

          case 'endpoint':
            // Clicked endpoint dot but didn't drag → drill down to single connector
            if (store.selectedIds.length > 1) store.setSelection([this.downHit.connectorId]);
            break;

          case 'object': {
            const { handle, isSelected } = this.downHit;
            const hitId = handle.id;
            if (!isSelected) {
              if (this.hasAddModifier()) {
                // Additive: add to current selection
                const current = store.selectedIds;
                if (!current.includes(hitId)) store.setSelection([...current, hitId]);
              } else {
                store.setSelection([hitId]);
              }
              break;
            }
            if (this.hasAddModifier()) {
              // Subtractive: remove from selection
              const remaining = store.selectedIds.filter((id) => id !== hitId);
              if (remaining.length > 0) store.setSelection(remaining);
              else store.clearSelection();
            } else if (store.selectedIds.length > 1) {
              // Drill down to single object
              store.setSelection([hitId]);
            } else if ((handle.kind === 'text' || handle.kind === 'shape' || handle.kind === 'note') && !textTool.isEditorMounted()) {
              if (textTool.justClosedLabelId === hitId) textTool.justClosedLabelId = null;
              else textTool.startEditing(hitId, this.downWorld!);
            } else if (handle.kind === 'code' && !codeTool.isEditorMounted()) {
              codeTool.startEditing(hitId, this.downWorld!);
            } else if (handle.kind === 'connector' && !textTool.isEditorMounted() && this.downWorld) {
              // Sole-selected connector: a second click strictly inside the label
              // rect edits it. Label-less connectors (null rect) ignore body clicks —
              // labels are created via the context-menu "Add label" affordance.
              const route = getConnectorRoute(hitId);
              const labelRect = route ? getConnectorLabelRect(hitId, route, route.length) : null;
              if (labelRect && pointInBBox(this.downWorld, labelRect)) {
                if (textTool.justClosedLabelId === hitId) textTool.justClosedLabelId = null;
                else textTool.startEditing(hitId, this.downWorld);
              }
            }
            break;
          }

          case 'selectionGap':
            // Quick tap in gap → deselect
            // Long hold or slight movement in gap → keep selection (user was trying to drag)
            if (elapsed < CLICK_WINDOW_MS && dist <= MOVE_THRESHOLD_PX) store.clearSelection();
            // Else: do nothing, selection stays
            break;

          case 'background':
            // Click on background → deselect
            store.clearSelection();
            break;

          case 'openButton': {
            // Re-verify against a fresh handle (bookmark may have been deleted
            // mid-press) and re-test the button rect (cursor may have left the
            // visible button between down and up — drift >MOVE_THRESHOLD_PX
            // would have already promoted to translate above, so here we just
            // re-confirm we're still on the button at release).
            const { handle: stored } = this.downHit;
            const handle = getHandle(stored.id);
            if (
              handle &&
              handle.kind === 'bookmark' &&
              worldX !== undefined &&
              worldY !== undefined &&
              hitTestOpenButton(handle, worldX, worldY)
            ) {
              openBookmarkUrl(handle.id);
            }
            break;
          }

          case 'playButton': {
            // Re-verify like openButton: block may have been deleted or edited
            // mid-press; re-test the button at release. LOCAL GESTURE — one of
            // exactly three legal toggleRunCodeBlock call sites (never-auto-run).
            const { handle: stored } = this.downHit;
            const handle = getHandle(stored.id);
            if (
              handle &&
              handle.kind === 'code' &&
              worldX !== undefined &&
              worldY !== undefined &&
              hitCodePlayButton(handle.id, handle.y, worldX, worldY)
            ) {
              toggleRunCodeBlock(handle.id);
            }
            break;
          }
        }
        break;
      }

      case 'marquee': {
        this.marqueeActive = false;
        // Selection was already updated during move
        break;
      }

      case 'flowDrag': {
        // Commit the live connector; abort (too short) → reselect the source.
        const id = this.connectorFlow.commitDrag() ?? this.connectorFlow.getSourceId();
        if (id) useSelectionStore.getState().setSelection([id]);
        this.connectorFlow.cancelDrag();
        break;
      }

      case 'translate':
      case 'scale':
      case 'endpointDrag': {
        // endTransform routes by transform.kind: endpointDrag → controller.commitEndpointDrag(snap).
        useSelectionStore.getState().endTransform();
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
    invalidateOverlay();
    // Re-evaluate hover against the post-transform frame so a just-committed
    // bookmark scale immediately reflects in the hover indicator without
    // requiring a cursor wiggle.
    this.rehoverFromLastCursor();
  }

  cancel(): void {
    // Controller's cancel() handles all gesture modes (translate / scale / endpointDrag).
    useSelectionStore.getState().cancelTransform();

    this.marqueeActive = false;
    this.connectorFlow.cancelDrag();
    this.connectorFlow.clearHover();
    this.clearBookmarkOpenHoverIfAny();
    // Clear any cursor override on cancel
    setCursorOverride(null);
    applyCursor();
    this.resetState();

    const { selectedIds, textEditingId, codeEditingId } = useSelectionStore.getState();
    if (selectedIds.length > 0 || textEditingId !== null || codeEditingId !== null) {
      contextMenuController.show();
    }

    textTool.justClosedLabelId = null;
    invalidateOverlay();
    this.rehoverFromLastCursor();
  }

  isActive(): boolean {
    return this.phase !== 'idle';
  }

  getPointerId(): number | null {
    return this.pointerId;
  }

  getPreview(): PreviewData | null {
    const { selectedIds } = useSelectionStore.getState();
    // The 3rd term keeps the drag preview alive after the flow drag clears the selection.
    if (selectedIds.length === 0 && !this.marqueeActive && !this.connectorFlow.isDragging()) return null;
    return { kind: 'selection' };
  }

  destroy(): void {
    this.cancel();
  }

  onViewChange(): void {
    if (textTool.isEditorMounted()) textTool.onViewChange();
    if (codeTool.isEditorMounted()) codeTool.onViewChange();
    if (this.phase === 'flowDrag') this.connectorFlow.onViewChange();
    invalidateOverlay();
    this.rehoverFromLastCursor();
  }

  /**
   * Called when pointer leaves canvas - clears any hover cursor state.
   */
  onPointerLeave(): void {
    this.clearBookmarkOpenHoverIfAny();
    this.connectorFlow.clearHover();
    setCursorOverride(null);
    applyCursor();
  }

  // --- Hover ---

  /**
   * Handle hover cursor detection when idle.
   * Called by move() when phase is 'idle'.
   *
   * Standard mode: resize cursors on handles (highest priority).
   * Connector mode: grab cursor on endpoint dots (highest priority).
   * All modes: pointer cursor + hover paint on visible Open buttons of
   * bookmarks (gated below handle/endpoint priority — handles/endpoints
   * always win). Occlusion via `pickTopmostPaint`.
   */
  private handleHoverCursor(worldX: number, worldY: number): void {
    // Cursor ownership: panTool owns 'grabbing' during MMB/spacebar pan. The
    // camera subscription routes those pans through onViewChange → here, so
    // bail before clobbering panTool's cursor every frame.
    if (panTool.isActive()) return;

    const store = useSelectionStore.getState();
    const { mode, selectedIds } = store;

    if (mode === 'standard' && (!store.textEditingId || textTool.isEditingLabel()) && !store.codeEditingId) {
      const bounds = computeSelectionBounds();
      if (bounds) {
        const handle = hitResizeHandle([worldX, worldY], bounds);
        if (handle) {
          this.clearBookmarkOpenHoverIfAny();
          setCursorOverride(handleCursor(handle));
          applyCursor();
          return;
        }
      }
    } else if (mode === 'connector') {
      const endpointHit = hitEndpointDot([worldX, worldY], selectedIds);
      if (endpointHit) {
        this.clearBookmarkOpenHoverIfAny();
        setCursorOverride('grab');
        applyCursor();
        return;
      }
    }

    // Flow-button hover — grow the hovered button + compute its preview. The
    // dots ARE the feedback, so the cursor stays the Select default (no override).
    const flowGate = flowButtonGate();
    const flowSide = flowGate ? hitFlowButton([worldX, worldY], flowGate.bbox, useCameraStore.getState().scale) : null;
    if (flowGate && flowSide) {
      this.clearBookmarkOpenHoverIfAny();
      this.connectorFlow.updateHover(flowGate.handle.id, flowSide, flowGate.handle);
      setCursorOverride(null);
      applyCursor();
      return;
    }
    this.connectorFlow.clearHover();

    // Bookmark Open-button hover — occlusion via `pickTopmostPaint` (framed
    // kinds always paint 'ink' on hit, so a bookmark winning the picker means
    // the cursor is on genuinely visible bookmark pixels — no separate
    // 4-corner sampling needed).
    const topmost = pickTopmostPaint([worldX, worldY], { px: HIT_RADIUS_PX });
    if (topmost && topmost.kind === 'bookmark' && hitTestOpenButton(topmost, worldX, worldY)) {
      if (this.hoveredOpenBookmarkId !== topmost.id) {
        const prevId = this.hoveredOpenBookmarkId;
        this.hoveredOpenBookmarkId = topmost.id;
        if (prevId !== null) {
          const oldBbox = getOpenButtonWorldBBox(prevId);
          if (oldBbox) invalidateWorldBBox(oldBbox);
        }
        const newBbox = getOpenButtonWorldBBox(topmost.id);
        if (newBbox) invalidateWorldBBox(newBbox);
      }
      setCursorOverride('pointer');
      applyCursor();
      return;
    }

    this.clearBookmarkOpenHoverIfAny();
    setCursorOverride(null);
    applyCursor();
  }

  private resetState(): void {
    this.phase = 'idle';
    this.pointerId = null;
    this.downWorld = null;
    this.downScreen = null;
    this.downHit = { kind: 'background' };
    this.downTimeMs = 0;
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
