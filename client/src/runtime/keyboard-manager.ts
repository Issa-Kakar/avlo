/**
 * Keyboard Manager - Pure keyboard shortcut dispatch logic
 *
 * No DOM listeners — InputManager owns all event registration and forwards here.
 * Handles tool switching, undo/redo, delete, enter-to-edit, escape,
 * and clipboard shortcuts (copy/paste/cut/duplicate/selectAll).
 *
 * Guard hierarchy (top to bottom):
 * 1. Input focus → early return (Tiptap handles its own shortcuts)
 * 2. Modifier-first → clipboard/undo/redo (Cmd+C before bare c)
 * 3. Gesture-active → blocks tool switches + delete
 * 4. Bare-key → tool switches, delete, enter, escape
 *
 * @module runtime/keyboard-manager
 */

import { getCurrentTool, panTool, textTool, codeTool } from './tool-registry';
import { undo, redo, getObjectsById, getHandle, hasActiveRoom } from './room-runtime';
import { useSelectionStore } from '@/stores/selection-store';
import { useDeviceUIStore, setCursorOverride, type Tool, type ShapeVariant } from '@/stores/device-ui-store';
import { deleteSelected, toggleSelectedBold, toggleSelectedItalic, setSelectedHighlight } from '@/tools/selection/selection-actions';
import { invalidateOverlay } from '@/renderer/OverlayRenderLoop';
import { frameOf } from '@/core/geometry/frame-of';
import { computeUniformInlineStyles } from '@/tools/selection/selection-utils';
import {
  copySelected,
  pasteFromClipboard,
  cutSelected,
  duplicateSelected,
  selectAll,
  pasteImage,
} from '@/core/clipboard/clipboard-actions';
import { zoomIn, zoomOut, animateZoomReset } from './viewport/zoom';
import { startDirection, stopDirection, stopAll as stopArrowPan } from './viewport/arrow-key-pan';
import { openImageFilePicker } from '@/core/image/image-actions';

// === Spacebar Pan State ===

let spacebarPanMode = false;

export function isSpacebarPanMode(): boolean {
  return spacebarPanMode;
}

// === Main Dispatch ===

export function handleKeyDown(e: KeyboardEvent): void {
  // Guard 1: Input focus — let native/Tiptap handle everything
  const target = e.target as HTMLElement;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable ||
    (document.activeElement as HTMLElement | null)?.isContentEditable ||
    textTool.isEditorMounted() ||
    codeTool.isEditorMounted()
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

  // Arrow keys — continuous pan
  if (e.key.startsWith('Arrow')) {
    if (e.repeat) return;
    if (gestureActive || isEditing || spacebarPanMode) return;
    e.preventDefault();
    startDirection(e.key);
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

    // case 'v' handled by DOM paste listener (onPaste) for OS file paste support

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
      if (e.shiftKey) {
        if (gestureActive) return;
        redo();
      } else {
        if (gestureActive) {
          tool!.cancel();
          return;
        }
        undo();
      }
      return;

    case 'y':
      e.preventDefault();
      if (gestureActive) return;
      redo();
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
        const objectsById = getObjectsById();
        const { highlightColor } = computeUniformInlineStyles(selectedIds, objectsById);
        if (highlightColor) {
          setSelectedHighlight(null);
        } else {
          const deviceHighlight = useDeviceUIStore.getState().highlightColor;
          setSelectedHighlight(deviceHighlight || '#ffd43b');
        }
      }
      return;

    case '=':
    case '+':
      e.preventDefault();
      zoomIn();
      return;

    case '-':
      e.preventDefault();
      zoomOut();
      return;

    case '0':
      e.preventDefault();
      animateZoomReset();
      return;
  }
}

// === Bare Key Dispatch ===

const TOOL_KEYS: Record<string, Tool> = {
  p: 'pen',
  e: 'eraser',
  t: 'text',
  n: 'note',
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

  // Image file picker (action, not a tool switch)
  if (key === 'i') {
    e.preventDefault();
    openImageFilePicker();
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
    const handle = getHandle(selectedIds[0]);
    if (!handle || (handle.kind !== 'text' && handle.kind !== 'shape' && handle.kind !== 'note')) return;

    // Compute center
    const frame = frameOf(handle);
    if (!frame) return;

    const centerX = frame[0] + frame[2] / 2;
    const centerY = frame[1] + frame[3] / 2;

    e.preventDefault();
    textTool.startEditing(handle.id, [centerX, centerY]);
    return;
  }
}

// === Paste ===

export function handlePaste(e: ClipboardEvent): void {
  const target = e.target as HTMLElement;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable ||
    (document.activeElement as HTMLElement | null)?.isContentEditable ||
    textTool.isEditorMounted() ||
    codeTool.isEditorMounted()
  ) {
    return;
  }
  if (!hasActiveRoom()) return;

  e.preventDefault();

  // OS file copy → clipboardData.files
  const files = e.clipboardData?.files;
  if (files && files.length > 0) {
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) {
        pasteImage(file);
        return;
      }
    }
  }

  // All other paste paths (internal, external HTML/text, browser image copy)
  pasteFromClipboard();
}

// === Key Up & Blur ===

export function handleKeyUp(e: KeyboardEvent): void {
  if (e.key === ' ' && spacebarPanMode) {
    spacebarPanMode = false;
    if (!panTool.isActive()) {
      setCursorOverride(null);
    }
    // If panTool IS active (mid-drag), let it finish via pointerup
  }

  if (e.key.startsWith('Arrow')) {
    stopDirection(e.key);
  }
}

export function handleBlur(): void {
  if (spacebarPanMode) {
    spacebarPanMode = false;
    if (!panTool.isActive()) setCursorOverride(null);
  }
  stopArrowPan();
}
