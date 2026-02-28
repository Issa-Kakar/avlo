import { getActiveRoomDoc, getCurrentSnapshot, getConnectorsForShape } from '@/canvas/room-runtime';
import { getStartAnchor, getEndAnchor, getOrigin, getAlign, type TextAlign } from '@avlo/shared';
import { useSelectionStore } from '@/stores/selection-store';
import { computeSelectionBounds } from '@/lib/utils/selection-utils';
import { invalidateWorld } from '@/canvas/invalidation-helpers';
import {
  useDeviceUIStore,
  TEXT_FONT_SIZE_PRESETS,
  type SizePreset,
  type ConnectorSizePreset,
} from '@/stores/device-ui-store';
import { textTool } from '@/canvas/tool-registry';
import { getTextFrame, anchorFactor } from '@/lib/text/text-system';
import * as Y from 'yjs';

// === Helpers ===

function getSelectedHandles() {
  const { selectedIds } = useSelectionStore.getState();
  if (selectedIds.length === 0) return null;
  const { objectsById } = getCurrentSnapshot();
  return { selectedIds, objectsById };
}

// === Color ===

export function setSelectedColor(color: string): void {
  const ctx = getSelectedHandles();
  if (!ctx) return;

  getActiveRoomDoc().mutate((ydoc) => {
    const objects = (ydoc.getMap('root') as Y.Map<any>).get('objects') as Y.Map<Y.Map<any>>;
    for (const id of ctx.selectedIds) {
      objects.get(id)?.set('color', color);
    }
  });

  useDeviceUIStore.getState().setDrawingColor(color);
  useSelectionStore.getState().refreshStyles();
}

// === Fill Color ===

export function setSelectedFillColor(fillColor: string | null): void {
  const ctx = getSelectedHandles();
  if (!ctx) return;

  getActiveRoomDoc().mutate((ydoc) => {
    const objects = (ydoc.getMap('root') as Y.Map<any>).get('objects') as Y.Map<Y.Map<any>>;
    for (const id of ctx.selectedIds) {
      const handle = ctx.objectsById.get(id);
      if (handle?.kind !== 'shape') continue;
      const yObj = objects.get(id);
      if (!yObj) continue;
      if (fillColor === null) yObj.delete('fillColor');
      else yObj.set('fillColor', fillColor);
    }
  });

  const ui = useDeviceUIStore.getState();
  if (fillColor === null) {
    ui.setFillEnabled(false);
  } else {
    ui.setFillColor(fillColor);
    ui.setFillEnabled(true);
  }
  useSelectionStore.getState().refreshStyles();
}

// === Width ===

export function setSelectedWidth(width: number): void {
  const ctx = getSelectedHandles();
  if (!ctx) return;

  getActiveRoomDoc().mutate((ydoc) => {
    const objects = (ydoc.getMap('root') as Y.Map<any>).get('objects') as Y.Map<Y.Map<any>>;
    for (const id of ctx.selectedIds) {
      objects.get(id)?.set('width', width);
    }
  });

  const { selectionKind } = useSelectionStore.getState();
  if (selectionKind === 'connectorsOnly') {
    useDeviceUIStore.getState().setConnectorSize(width as ConnectorSizePreset);
  } else {
    useDeviceUIStore.getState().setDrawingSize(width as SizePreset);
  }
  useSelectionStore.getState().refreshStyles();
}

// === Shape Type ===

export function setSelectedShapeType(shapeType: string): void {
  const ctx = getSelectedHandles();
  if (!ctx) return;

  getActiveRoomDoc().mutate((ydoc) => {
    const objects = (ydoc.getMap('root') as Y.Map<any>).get('objects') as Y.Map<Y.Map<any>>;
    for (const id of ctx.selectedIds) {
      const handle = ctx.objectsById.get(id);
      if (handle?.kind !== 'shape') continue;
      objects.get(id)?.set('shapeType', shapeType);
    }
  });

  useSelectionStore.getState().refreshStyles();
}

// === Delete ===

export function deleteSelected(): void {
  const { selectedIds } = useSelectionStore.getState();
  if (selectedIds.length === 0) return;

  const snapshot = getCurrentSnapshot();
  const idsToDelete = new Set(selectedIds);

  // Collect connector anchor cleanups: connectorId → { clearStart, clearEnd }
  const anchorCleanups = new Map<string, { clearStart: boolean; clearEnd: boolean }>();

  for (const id of idsToDelete) {
    const handle = snapshot.objectsById.get(id);
    if (!handle || handle.kind === 'connector') continue;

    const connectorIds = getConnectorsForShape(id);
    if (!connectorIds) continue;

    for (const connectorId of connectorIds) {
      if (idsToDelete.has(connectorId)) continue;

      const connectorHandle = snapshot.objectsById.get(connectorId);
      if (!connectorHandle) continue;

      const startAnchor = getStartAnchor(connectorHandle.y);
      const endAnchor = getEndAnchor(connectorHandle.y);
      const existing = anchorCleanups.get(connectorId) ?? { clearStart: false, clearEnd: false };

      if (startAnchor?.id === id) existing.clearStart = true;
      if (endAnchor?.id === id) existing.clearEnd = true;

      if (existing.clearStart || existing.clearEnd) {
        anchorCleanups.set(connectorId, existing);
      }
    }
  }

  getActiveRoomDoc().mutate((ydoc) => {
    const objects = (ydoc.getMap('root') as Y.Map<any>).get('objects') as Y.Map<Y.Map<any>>;

    // Clear dead anchors first
    for (const [connectorId, { clearStart, clearEnd }] of anchorCleanups) {
      const yObj = objects.get(connectorId);
      if (!yObj) continue;
      if (clearStart) yObj.delete('startAnchor');
      if (clearEnd) yObj.delete('endAnchor');
    }

    // Delete objects
    for (const id of idsToDelete) {
      objects.delete(id);
    }
  });

  useSelectionStore.getState().clearSelection();
}

// === Text Color ===

export function setSelectedTextColor(color: string): void {
  const { textEditingId, selectedIds } = useSelectionStore.getState();
  const ids = textEditingId ? [textEditingId] : selectedIds;
  if (ids.length === 0) return;

  getActiveRoomDoc().mutate((ydoc) => {
    const objects = (ydoc.getMap('root') as Y.Map<any>).get('objects') as Y.Map<Y.Map<any>>;
    for (const id of ids) objects.get(id)?.set('color', color);
  });

  useDeviceUIStore.getState().setTextColor(color);
  useSelectionStore.getState().refreshStyles();
}

// === Font Size ===

export function setSelectedFontSize(size: number): void {
  const clamped = Math.max(1, Math.min(999, Math.round(size)));
  const { textEditingId, selectedIds } = useSelectionStore.getState();
  const ids = textEditingId ? [textEditingId] : selectedIds;
  if (ids.length === 0) return;

  getActiveRoomDoc().mutate((ydoc) => {
    const objects = (ydoc.getMap('root') as Y.Map<any>).get('objects') as Y.Map<Y.Map<any>>;
    for (const id of ids) {
      const handle = getCurrentSnapshot().objectsById.get(id);
      if (handle?.kind === 'text') objects.get(id)?.set('fontSize', clamped);
    }
  });

  useDeviceUIStore.getState().setTextSize(clamped);
  useSelectionStore.getState().refreshStyles();
}

export function incrementFontSize(): void {
  const fontSize = useSelectionStore.getState().selectedStyles.fontSize;
  if (fontSize === null) return;
  const current = Math.round(fontSize);
  if (current < 10) { setSelectedFontSize(10); return; }
  const next = TEXT_FONT_SIZE_PRESETS.find(p => p > current);
  if (next !== undefined) setSelectedFontSize(next);
}

export function decrementFontSize(): void {
  const fontSize = useSelectionStore.getState().selectedStyles.fontSize;
  if (fontSize === null) return;
  const current = Math.round(fontSize);
  if (current > 144) { setSelectedFontSize(144); return; }
  let prev: number | undefined;
  for (const p of TEXT_FONT_SIZE_PRESETS) {
    if (p >= current) break;
    prev = p;
  }
  if (prev !== undefined) setSelectedFontSize(prev);
}

// === Text Alignment ===

export function setSelectedTextAlign(align: TextAlign): void {
  const { textEditingId, selectedIds } = useSelectionStore.getState();
  const ids = textEditingId ? [textEditingId] : selectedIds;
  if (ids.length === 0) return;

  getActiveRoomDoc().mutate((ydoc) => {
    const objects = (ydoc.getMap('root') as Y.Map<any>).get('objects') as Y.Map<Y.Map<any>>;
    for (const id of ids) {
      const handle = getCurrentSnapshot().objectsById.get(id);
      if (!handle || handle.kind !== 'text') continue;
      const yObj = objects.get(id);
      if (!yObj) continue;

      const oldAlign = getAlign(handle.y);
      if (oldAlign === align) continue;

      const origin = getOrigin(handle.y);
      const frame = getTextFrame(id);
      if (!origin || !frame) continue;

      const W = frame[2];
      const leftX = origin[0] - anchorFactor(oldAlign) * W;
      const newOriginX = leftX + anchorFactor(align) * W;

      yObj.set('origin', [newOriginX, origin[1]]);
      yObj.set('align', align);
    }
  });

  useDeviceUIStore.getState().setTextAlign(align);
  useSelectionStore.getState().refreshStyles();
  const bounds = computeSelectionBounds();
  if (bounds) invalidateWorld(bounds);
}

// === Inline Formatting (Bold / Italic / Highlight) ===

export function toggleSelectedBold(): void {
  const editor = textTool.getEditor();
  // Future: Yjs delta mutation for canvas-selected text (no editor)
  if (!editor) return;
  editor.chain().focus().toggleBold().run();
}

export function toggleSelectedItalic(): void {
  const editor = textTool.getEditor();
  // Future: Yjs delta mutation for canvas-selected text (no editor)
  if (!editor) return;
  editor.chain().focus().toggleItalic().run();
}

export function setSelectedHighlight(color: string | null): void {
  const editor = textTool.getEditor();
  // Future: Yjs delta mutation for canvas-selected text (no editor)
  if (!editor) return;

  if (color === null) {
    editor.chain().focus().unsetHighlight().run();
  } else {
    editor.chain().focus().setHighlight({ color }).run();
  }
}
