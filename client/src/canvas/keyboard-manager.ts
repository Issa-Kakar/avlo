/**
 * Keyboard Manager - Imperative keyboard shortcut dispatch
 *
 * Flat module with attach/detach lifecycle managed by CanvasRuntime.
 * Handles tool switching, undo/redo, delete, enter-to-edit, escape,
 * and clipboard shortcuts (copy/paste/cut/duplicate/selectAll).
 *
 * Guard hierarchy (top to bottom):
 * 1. Input focus → early return (Tiptap handles its own shortcuts)
 * 2. Modifier-first → clipboard/undo/redo (Cmd+C before bare c)
 * 3. Gesture-active → blocks tool switches + delete
 * 4. Bare-key → tool switches, delete, enter, escape
 *
 * @module canvas/keyboard-manager
 */

import { getCurrentTool, panTool, textTool } from './tool-registry';
import { getActiveRoomDoc, getCurrentSnapshot, hasActiveRoom } from './room-runtime';
import { useSelectionStore } from '@/stores/selection-store';
import { useDeviceUIStore, setCursorOverride, type Tool, type ShapeVariant } from '@/stores/device-ui-store';
import {
  deleteSelected,
  toggleSelectedBold,
  toggleSelectedItalic,
  setSelectedHighlight,
} from '@/lib/utils/selection-actions';
import { invalidateOverlay } from './invalidation-helpers';
import { getTextFrame } from '@/lib/text/text-system';
import { getFrame } from '@avlo/shared';
import { computeUniformInlineStyles } from '@/lib/utils/selection-utils';
import {
  copySelected,
  pasteFromClipboard,
  cutSelected,
  duplicateSelected,
  selectAll,
} from '@/lib/clipboard/clipboard-actions';

// === Spacebar Pan State ===

let spacebarPanMode = false;

export function isSpacebarPanMode(): boolean {
  return spacebarPanMode;
}

// === Lifecycle ===

export function attach(): void {
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
}

export function detach(): void {
  document.removeEventListener('keydown', onKeyDown);
  document.removeEventListener('keyup', onKeyUp);
  window.removeEventListener('blur', onBlur);
}

// === Main Dispatch ===

function onKeyDown(e: KeyboardEvent): void {
  // Guard 1: Input focus — let native/Tiptap handle everything
  const target = e.target as HTMLElement;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.contentEditable === 'true'
  ) {
    return;
  }

  if (!hasActiveRoom()) return;

  const key = e.key.toLowerCase();
  const cmdOrCtrl = e.metaKey || e.ctrlKey;

  // Guard 2: Modifier shortcuts first (disambiguates Cmd+C from bare c)
  if (cmdOrCtrl) {
    handleModifierShortcut(e, key);
    return;
  }

  // Guard 3: Gesture-active blocks tool switches + delete
  const tool = getCurrentTool();
  const gestureActive = tool?.isActive() ?? false;
  const { textEditingId } = useSelectionStore.getState();
  const isEditing = textEditingId !== null;

  // Escape — always handled (layered: cancel gesture → clear selection)
  if (key === 'escape') {
    e.preventDefault();
    if (gestureActive) {
      tool!.cancel();
    } else if (useSelectionStore.getState().selectedIds.length > 0) {
      useSelectionStore.getState().clearSelection();
      invalidateOverlay();
    }
    return;
  }

  // Spacebar — ephemeral pan mode (hold-to-pan)
  if (key === ' ') {
    e.preventDefault();
    if (e.repeat || spacebarPanMode) return;
    if (!gestureActive && !isEditing) {
      spacebarPanMode = true;
      setCursorOverride('grab');
    }
    return;
  }

  // Block remaining bare keys during gesture or text editing
  if (gestureActive || isEditing) return;

  // Guard 4: Bare-key dispatch
  handleBareKey(e, key);
}

// === Modifier Shortcuts ===

function handleModifierShortcut(e: KeyboardEvent, key: string): void {
  const tool = getCurrentTool();
  const gestureActive = tool?.isActive() ?? false;

  switch (key) {
    case 'c':
      e.preventDefault();
      copySelected();
      return;

    case 'v':
      e.preventDefault();
      pasteFromClipboard();
      return;

    case 'x':
      e.preventDefault();
      cutSelected();
      return;

    case 'd':
      e.preventDefault();
      if (!gestureActive) duplicateSelected();
      return;

    case 'a':
      e.preventDefault();
      if (gestureActive && useDeviceUIStore.getState().activeTool !== 'select') tool!.cancel();
      selectAll();
      return;

    case 'z':
      e.preventDefault();
      if (gestureActive) tool!.cancel();
      if (e.shiftKey) {
        getActiveRoomDoc().redo();
      } else {
        getActiveRoomDoc().undo();
      }
      return;

    case 'y':
      e.preventDefault();
      if (gestureActive) tool!.cancel();
      getActiveRoomDoc().redo();
      return;

    case 'b':
      e.preventDefault();
      if (!gestureActive) toggleSelectedBold();
      return;

    case 'i':
      e.preventDefault();
      if (!gestureActive) toggleSelectedItalic();
      return;

    case 'h':
      e.preventDefault();
      if (!gestureActive) {
        const { selectedIds } = useSelectionStore.getState();
        const { objectsById } = getCurrentSnapshot();
        const { highlightColor } = computeUniformInlineStyles(selectedIds, objectsById);
        if (highlightColor) {
          setSelectedHighlight(null);
        } else {
          const deviceHighlight = useDeviceUIStore.getState().highlightColor;
          setSelectedHighlight(deviceHighlight || '#ffd43b');
        }
      }
      return;
  }
}

// === Bare Key Dispatch ===

const TOOL_KEYS: Record<string, Tool> = {
  p: 'pen',
  e: 'eraser',
  t: 'text',
  v: 'select',
  h: 'pan',
  a: 'connector',
};

const SHAPE_KEYS: Record<string, ShapeVariant> = {
  r: 'rectangle',
  o: 'ellipse',
  d: 'diamond',
};

function handleBareKey(e: KeyboardEvent, key: string): void {
  if (spacebarPanMode) return; // Block tool switches during space-hold

  // Tool switch
  const toolId = TOOL_KEYS[key];
  if (toolId) {
    e.preventDefault();
    useDeviceUIStore.getState().setActiveTool(toolId);
    return;
  }

  // Shape variant switch
  const variant = SHAPE_KEYS[key];
  if (variant) {
    e.preventDefault();
    const store = useDeviceUIStore.getState();
    store.setActiveTool('shape');
    store.setShapeVariant(variant);
    return;
  }

  const { selectedIds } = useSelectionStore.getState();

  // Delete / Backspace
  if ((key === 'delete' || key === 'backspace') && selectedIds.length > 0) {
    e.preventDefault();
    deleteSelected();
    return;
  }

  // Enter — edit single text or shape
  if (key === 'enter' && useDeviceUIStore.getState().activeTool === 'select') {
    if (selectedIds.length !== 1) return;
    const { objectsById } = getCurrentSnapshot();
    const handle = objectsById.get(selectedIds[0]);
    if (!handle || (handle.kind !== 'text' && handle.kind !== 'shape')) return;

    // Compute center
    const frame = handle.kind === 'text' ? getTextFrame(handle.id) : getFrame(handle.y);
    if (!frame) return;

    const centerX = frame[0] + frame[2] / 2;
    const centerY = frame[1] + frame[3] / 2;

    e.preventDefault();
    textTool.startEditing(handle.id, [centerX, centerY]);
    return;
  }
}

// === Key Up & Blur ===

function onKeyUp(e: KeyboardEvent): void {
  if (e.key === ' ' && spacebarPanMode) {
    spacebarPanMode = false;
    if (!panTool.isActive()) {
      setCursorOverride(null);
    }
    // If panTool IS active (mid-drag), let it finish via pointerup
  }
}

function onBlur(): void {
  if (spacebarPanMode) {
    spacebarPanMode = false;
    if (!panTool.isActive()) setCursorOverride(null);
  }
}
