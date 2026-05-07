import { getConnectorType } from '@/core/accessors';
import { isAnchored } from '@/core/connectors/anchor-atoms';
import type { Slot } from '@/core/connectors/reroute-connector';
import { findBestSnapTarget } from '@/core/connectors/snap';
import { pointsToBBoxMut } from '@/core/geometry/bounds';
import { pointInBBox } from '@/core/geometry/hit-primitives';
import { hitEndpointDot, hitResizeHandle } from '@/core/spatial/handle-hit';
import { inBBox, pickTopmostPaint, queryHandleIds } from '@/core/spatial/object-query';
import type { BBoxTuple, Point } from '@/core/types/geometry';
import type { HandleId } from '@/core/types/handles';
import { handleCursor } from '@/core/types/handles';
import type { ObjectHandle } from '@/core/types/objects';
import { invalidateOverlay } from '@/renderer/OverlayRenderLoop';
import { contextMenuController } from '@/runtime/ContextMenuController';
import { getLastCursorWorld } from '@/runtime/cursor-tracking';
import { isCtrlHeld, isCtrlOrMetaHeld, isShiftHeld } from '@/runtime/InputManager';
import { getHandle } from '@/runtime/room-runtime';
import { codeTool, panTool, textTool } from '@/runtime/tool-registry';
import { worldToCanvas } from '@/stores/camera-store';
import { applyCursor, setCursorOverride } from '@/stores/device-ui-store';
import { computeSelectionBounds, useSelectionStore } from '@/stores/selection-store';
import { getController } from '@/tools/selection/transform';
import type { PointerTool, PreviewData } from '../types';

// === Constants ===
const HIT_RADIUS_PX = 6; // Screen-space hit test radius for selection
const HIT_SLACK_PX = 2.0; // Forgiving feel for touch/click precision (like EraserTool)
const MOVE_THRESHOLD_PX = 4; // Pixels before drag detected (screen space)
const CLICK_WINDOW_MS = 180; // Time threshold for gap click disambiguation

// === Types ===

type Phase = 'idle' | 'pendingClick' | 'marquee' | 'translate' | 'scale' | 'endpointDrag';

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
  | { kind: 'endpoint'; connectorId: string; slot: Slot };

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

    // 2. Common: object hit test
    const hit = this.hitTestObjects(worldX, worldY);

    if (hit) {
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
        // Read connectorType from the live handle (cheaper than threading through controller).
        const handle = getHandle(epTransform.connectorId);
        if (!handle || handle.kind !== 'connector') break;
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
        }
        break;
      }

      case 'marquee': {
        this.marqueeActive = false;
        // Selection was already updated during move
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
  }

  cancel(): void {
    // Controller's cancel() handles all gesture modes (translate / scale / endpointDrag).
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
