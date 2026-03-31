import { getActiveRoomDoc, getCurrentSnapshot, getConnectorsForShape } from '@/canvas/room-runtime';
import {
  getStartAnchor,
  getEndAnchor,
  getOrigin,
  getAlign,
  getContent,
  getFontSize,
  getLineNumbers,
  getHeaderVisible,
  getOutputVisible,
  hasLabel,
} from '@/lib/object-accessors';
import type { TextAlign, TextAlignV, FontFamily, CodeLanguage } from '@/lib/object-accessors';
import { useSelectionStore } from '@/stores/selection-store';
import {
  useDeviceUIStore,
  TEXT_FONT_SIZE_PRESETS,
  type SizePreset,
  type ConnectorSizePreset,
} from '@/stores/device-ui-store';
import { textTool } from '@/canvas/tool-registry';
import { getTextFrame, anchorFactor } from '@/lib/text/text-system';
import { computeUniformInlineStyles } from './selection-utils';
import * as Y from 'yjs';

// === Helpers ===

function getSelectedHandles() {
  const { selectedIds } = useSelectionStore.getState();
  if (selectedIds.length === 0) return null;
  const { objectsById } = getCurrentSnapshot();
  return { selectedIds, objectsById };
}

/** Resolve text IDs: prefer textEditingId, fall back to selectedIds. */
function getTextIds(): string[] {
  const { textEditingId, selectedIds } = useSelectionStore.getState();
  return textEditingId ? [textEditingId] : selectedIds;
}

// === Color ===

export function setSelectedColor(color: string): void {
  const ctx = getSelectedHandles();
  if (!ctx) return;

  getActiveRoomDoc().mutate(() => {
    for (const id of ctx.selectedIds) {
      ctx.objectsById.get(id)?.y.set('color', color);
    }
  });

  useDeviceUIStore.getState().setDrawingColor(color);
  useSelectionStore.getState().refreshStyles();
}

// === Fill Color ===

export function setSelectedFillColor(fillColor: string | null): void {
  const { selectedIds, selectionKind, textEditingId } = useSelectionStore.getState();
  const isNote = selectionKind === 'notesOnly';
  const isText = !isNote && (textEditingId !== null || selectionKind === 'textOnly');
  const ids = isText || isNote ? getTextIds() : selectedIds;
  if (ids.length === 0) return;

  const { objectsById } = getCurrentSnapshot();
  getActiveRoomDoc().mutate(() => {
    for (const id of ids) {
      const handle = objectsById.get(id);
      if (!handle || (handle.kind !== 'shape' && handle.kind !== 'text' && handle.kind !== 'note'))
        continue;
      if (fillColor === null) handle.y.delete('fillColor');
      else handle.y.set('fillColor', fillColor);
    }
  });

  // Note fill is per-object, not a device default — skip device-ui persist
  if (!isNote) {
    const ui = useDeviceUIStore.getState();
    if (isText) {
      ui.setTextFillColor(fillColor);
    } else {
      if (fillColor === null) {
        ui.setFillEnabled(false);
      } else {
        ui.setFillColor(fillColor);
        ui.setFillEnabled(true);
      }
    }
  }
  useSelectionStore.getState().refreshStyles();
}

// === Width ===

export function setSelectedWidth(width: number): void {
  const ctx = getSelectedHandles();
  if (!ctx) return;

  getActiveRoomDoc().mutate(() => {
    for (const id of ctx.selectedIds) {
      ctx.objectsById.get(id)?.y.set('width', width);
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

  getActiveRoomDoc().mutate(() => {
    for (const id of ctx.selectedIds) {
      const handle = ctx.objectsById.get(id);
      if (handle?.kind !== 'shape') continue;
      handle.y.set('shapeType', shapeType);
    }
  });

  useSelectionStore.getState().refreshStyles();
}

// === Delete ===

export function deleteSelected(): void {
  const { selectedIds } = useSelectionStore.getState();
  if (selectedIds.length === 0) return;

  const { objectsById } = getCurrentSnapshot();
  const idsToDelete = new Set(selectedIds);

  // Collect connector anchor cleanups for surviving connectors
  const anchorCleanups = new Map<
    string,
    { y: Y.Map<unknown>; clearStart: boolean; clearEnd: boolean }
  >();

  for (const id of idsToDelete) {
    const handle = objectsById.get(id);
    if (!handle || handle.kind === 'connector') continue;

    const connectorIds = getConnectorsForShape(id);
    if (!connectorIds) continue;

    for (const connectorId of connectorIds) {
      if (idsToDelete.has(connectorId)) continue;

      const connectorHandle = objectsById.get(connectorId);
      if (!connectorHandle) continue;

      const startAnchor = getStartAnchor(connectorHandle.y);
      const endAnchor = getEndAnchor(connectorHandle.y);
      const existing = anchorCleanups.get(connectorId) ?? {
        y: connectorHandle.y,
        clearStart: false,
        clearEnd: false,
      };

      if (startAnchor?.id === id) existing.clearStart = true;
      if (endAnchor?.id === id) existing.clearEnd = true;

      if (existing.clearStart || existing.clearEnd) {
        anchorCleanups.set(connectorId, existing);
      }
    }
  }

  const roomDoc = getActiveRoomDoc();
  roomDoc.mutate(() => {
    // Clear dead anchors via live handle references
    for (const { y, clearStart, clearEnd } of anchorCleanups.values()) {
      if (clearStart) y.delete('startAnchor');
      if (clearEnd) y.delete('endAnchor');
    }

    // Delete objects
    for (const id of idsToDelete) roomDoc.objects.delete(id);
  });

  useSelectionStore.getState().clearSelection();
}

// === Text Color ===

export function setSelectedTextColor(color: string): void {
  const ids = getTextIds();
  if (ids.length === 0) return;

  const { objectsById } = getCurrentSnapshot();
  getActiveRoomDoc().mutate(() => {
    for (const id of ids) {
      const handle = objectsById.get(id);
      if (!handle) continue;
      if (handle.kind === 'text') {
        handle.y.set('color', color);
      } else if (handle.kind === 'shape' && hasLabel(handle.y)) {
        handle.y.set('labelColor', color);
      }
    }
  });

  useDeviceUIStore.getState().setTextColor(color);
  useSelectionStore.getState().refreshStyles();
}

// === Font Size ===

export function setSelectedFontSize(size: number): void {
  const clamped = Math.max(1, Math.min(999, Math.round(size)));
  const ids = getTextIds();
  if (ids.length === 0) return;

  const { objectsById } = getCurrentSnapshot();
  getActiveRoomDoc().mutate(() => {
    for (const id of ids) {
      const handle = objectsById.get(id);
      if (!handle) continue;
      if (handle.kind === 'note') continue; // Notes derive fontSize from scale — skip
      if (handle.kind === 'text' || (handle.kind === 'shape' && hasLabel(handle.y))) {
        handle.y.set('fontSize', clamped);
      }
    }
  });

  useDeviceUIStore.getState().setTextSize(clamped);
  useSelectionStore.getState().refreshStyles();
}

export function incrementFontSize(): void {
  const fontSize =
    useSelectionStore.getState().selectedStyles.fontSize ?? useDeviceUIStore.getState().textSize;
  const current = Math.round(fontSize);
  if (current < 10) {
    setSelectedFontSize(10);
    return;
  }
  const next = TEXT_FONT_SIZE_PRESETS.find((p) => p > current);
  if (next !== undefined) setSelectedFontSize(next);
}

export function decrementFontSize(): void {
  const fontSize =
    useSelectionStore.getState().selectedStyles.fontSize ?? useDeviceUIStore.getState().textSize;
  const current = Math.round(fontSize);
  if (current > 144) {
    setSelectedFontSize(144);
    return;
  }
  let prev: number | undefined;
  for (const p of TEXT_FONT_SIZE_PRESETS) {
    if (p >= current) break;
    prev = p;
  }
  if (prev !== undefined) setSelectedFontSize(prev);
}

// === Font Family ===

export function setSelectedFontFamily(family: FontFamily): void {
  const ids = getTextIds();
  if (ids.length === 0) return;
  const { objectsById } = getCurrentSnapshot();
  getActiveRoomDoc().mutate(() => {
    for (const id of ids) {
      const handle = objectsById.get(id);
      if (!handle) continue;
      if (
        handle.kind === 'text' ||
        handle.kind === 'note' ||
        (handle.kind === 'shape' && hasLabel(handle.y))
      ) {
        handle.y.set('fontFamily', family);
      }
    }
  });
  const { selectionKind } = useSelectionStore.getState();
  if (selectionKind === 'notesOnly') {
    useDeviceUIStore.getState().setNoteFontFamily(family);
  } else {
    useDeviceUIStore.getState().setFontFamily(family);
  }
  useSelectionStore.getState().refreshStyles();
}

// === Text Alignment ===

export function setSelectedTextAlign(align: TextAlign): void {
  const ids = getTextIds();
  if (ids.length === 0) return;

  const { objectsById } = getCurrentSnapshot();
  getActiveRoomDoc().mutate(() => {
    for (const id of ids) {
      const handle = objectsById.get(id);
      if (!handle) continue;

      // Notes: top-left origin, no anchor math
      if (handle.kind === 'note') {
        handle.y.set('align', align);
        continue;
      }

      // Shapes: frame-based positioning, no anchor math needed
      if (handle.kind === 'shape') {
        handle.y.set('align', align);
        continue;
      }

      if (handle.kind !== 'text') continue;

      const oldAlign = getAlign(handle.y);
      if (oldAlign === align) continue;

      const origin = getOrigin(handle.y);
      const frame = getTextFrame(id);
      if (!origin || !frame) continue;

      const W = frame[2];
      const leftX = origin[0] - anchorFactor(oldAlign) * W;
      handle.y.set('origin', [leftX + anchorFactor(align) * W, origin[1]]);
      handle.y.set('align', align);
    }
  });

  const { selectionKind } = useSelectionStore.getState();
  if (selectionKind === 'notesOnly') {
    useDeviceUIStore.getState().setNoteAlign(align);
  } else if (selectionKind === 'shapesOnly') {
    useDeviceUIStore.getState().setShapeAlign(align);
  } else {
    useDeviceUIStore.getState().setTextAlign(align);
  }
  useSelectionStore.getState().refreshStyles();
}

export function setSelectedTextAlignV(alignV: TextAlignV): void {
  const ids = getTextIds();
  if (ids.length === 0) return;

  const { objectsById } = getCurrentSnapshot();
  getActiveRoomDoc().mutate(() => {
    for (const id of ids) {
      const handle = objectsById.get(id);
      if (!handle || (handle.kind !== 'note' && handle.kind !== 'shape')) continue;
      handle.y.set('alignV', alignV);
    }
  });

  const { selectionKind } = useSelectionStore.getState();
  if (selectionKind === 'notesOnly') {
    useDeviceUIStore.getState().setNoteAlignV(alignV);
  } else if (selectionKind === 'shapesOnly') {
    useDeviceUIStore.getState().setShapeAlignV(alignV);
  }
  useSelectionStore.getState().refreshStyles();
}

// === Inline Formatting (Bold / Italic / Highlight) ===

function formatFragment(fragment: Y.XmlFragment, attrs: Record<string, unknown>): void {
  fragment.forEach((para) => {
    if (!(para instanceof Y.XmlElement)) return;
    para.forEach((child) => {
      if (child instanceof Y.XmlText && child.length > 0) {
        child.format(0, child.length, attrs);
      }
    });
  });
}

export function toggleSelectedBold(): void {
  const editor = textTool.getEditor();
  if (editor) {
    editor.chain().focus().toggleBold().run();
    return;
  }

  const ids = getTextIds();
  if (ids.length === 0) return;
  const { objectsById } = getCurrentSnapshot();
  const { bold: allBold } = computeUniformInlineStyles(ids, objectsById);

  getActiveRoomDoc().mutate(() => {
    for (const id of ids) {
      const handle = objectsById.get(id);
      if (handle?.kind !== 'text' && handle?.kind !== 'shape' && handle?.kind !== 'note') continue;
      const content = getContent(handle.y);
      if (content) formatFragment(content, { bold: allBold ? null : true });
    }
  });
}

export function toggleSelectedItalic(): void {
  const editor = textTool.getEditor();
  if (editor) {
    editor.chain().focus().toggleItalic().run();
    return;
  }

  const ids = getTextIds();
  if (ids.length === 0) return;
  const { objectsById } = getCurrentSnapshot();
  const { italic: allItalic } = computeUniformInlineStyles(ids, objectsById);

  getActiveRoomDoc().mutate(() => {
    for (const id of ids) {
      const handle = objectsById.get(id);
      if (handle?.kind !== 'text' && handle?.kind !== 'shape' && handle?.kind !== 'note') continue;
      const content = getContent(handle.y);
      if (content) formatFragment(content, { italic: allItalic ? null : true });
    }
  });
}

export function setSelectedHighlight(color: string | null): void {
  const editor = textTool.getEditor();
  if (editor) {
    if (color === null) editor.chain().focus().unsetHighlight().run();
    else editor.chain().focus().setHighlight({ color }).run();
    return;
  }

  const ids = getTextIds();
  if (ids.length === 0) return;
  const { objectsById } = getCurrentSnapshot();

  getActiveRoomDoc().mutate(() => {
    for (const id of ids) {
      const handle = objectsById.get(id);
      if (handle?.kind !== 'text' && handle?.kind !== 'shape' && handle?.kind !== 'note') continue;
      const content = getContent(handle.y);
      if (content) formatFragment(content, { highlight: color ? { color } : null });
    }
  });
}

// === Code Block Actions ===

/** Resolve code IDs: prefer codeEditingId, fall back to selectedIds. */
function getCodeIds(): string[] {
  const { codeEditingId, selectedIds } = useSelectionStore.getState();
  return codeEditingId ? [codeEditingId] : selectedIds;
}

export function setSelectedCodeLanguage(language: CodeLanguage): void {
  const ids = getCodeIds();
  if (ids.length === 0) return;
  const { objectsById } = getCurrentSnapshot();

  getActiveRoomDoc().mutate(() => {
    for (const id of ids) {
      const handle = objectsById.get(id);
      if (handle?.kind !== 'code') continue;
      handle.y.set('language', language);
    }
  });

  useSelectionStore.getState().refreshStyles();
}

export function incrementCodeFontSize(): void {
  const fontSize = useSelectionStore.getState().selectedStyles.fontSize ?? 14;
  const current = Math.round(fontSize);
  if (current < 10) {
    setSelectedCodeFontSize(10);
    return;
  }
  const next = TEXT_FONT_SIZE_PRESETS.find((p) => p > current);
  if (next !== undefined) setSelectedCodeFontSize(next);
}

export function decrementCodeFontSize(): void {
  const fontSize = useSelectionStore.getState().selectedStyles.fontSize ?? 14;
  const current = Math.round(fontSize);
  if (current > 144) {
    setSelectedCodeFontSize(144);
    return;
  }
  let prev: number | undefined;
  for (const p of TEXT_FONT_SIZE_PRESETS) {
    if (p >= current) break;
    prev = p;
  }
  if (prev !== undefined) setSelectedCodeFontSize(prev);
}

export function setSelectedCodeFontSize(size: number): void {
  const clamped = Math.max(1, Math.min(999, Math.round(size)));
  const ids = getCodeIds();
  if (ids.length === 0) return;
  const { objectsById } = getCurrentSnapshot();

  getActiveRoomDoc().mutate(() => {
    for (const id of ids) {
      const handle = objectsById.get(id);
      if (handle?.kind !== 'code') continue;
      const curFs = getFontSize(handle.y, 14);
      const curW = (handle.y.get('width') as number) ?? 570;
      handle.y.set('fontSize', clamped);
      handle.y.set('width', Math.round(curW * (clamped / curFs)));
    }
  });

  useSelectionStore.getState().refreshStyles();
}

export function toggleCodeLineNumbers(): void {
  const ids = getCodeIds();
  if (ids.length === 0) return;
  const { objectsById } = getCurrentSnapshot();

  // Read current value from first code object
  let current = true;
  for (const id of ids) {
    const handle = objectsById.get(id);
    if (handle?.kind === 'code') {
      current = getLineNumbers(handle.y);
      break;
    }
  }
  const newValue = !current;

  getActiveRoomDoc().mutate(() => {
    for (const id of ids) {
      const handle = objectsById.get(id);
      if (handle?.kind !== 'code') continue;
      handle.y.set('lineNumbers', newValue);
    }
  });

  useDeviceUIStore.getState().setCodeLineNumbers(newValue);
  useSelectionStore.getState().refreshStyles();
}

export function toggleCodeHeader(): void {
  const ids = getCodeIds();
  if (ids.length === 0) return;
  const { objectsById } = getCurrentSnapshot();

  let current = true;
  for (const id of ids) {
    const handle = objectsById.get(id);
    if (handle?.kind === 'code') {
      current = getHeaderVisible(handle.y);
      break;
    }
  }

  getActiveRoomDoc().mutate(() => {
    for (const id of ids) {
      const handle = objectsById.get(id);
      if (handle?.kind !== 'code') continue;
      handle.y.set('headerVisible', !current);
    }
  });

  useSelectionStore.getState().refreshStyles();
}

export function toggleCodeOutput(): void {
  const ids = getCodeIds();
  if (ids.length === 0) return;
  const { objectsById } = getCurrentSnapshot();

  let current = false;
  for (const id of ids) {
    const handle = objectsById.get(id);
    if (handle?.kind === 'code') {
      current = getOutputVisible(handle.y);
      break;
    }
  }

  getActiveRoomDoc().mutate(() => {
    for (const id of ids) {
      const handle = objectsById.get(id);
      if (handle?.kind !== 'code') continue;
      handle.y.set('outputVisible', !current);
    }
  });

  useSelectionStore.getState().refreshStyles();
}
