import type { CodeLanguage, FontFamily, TextAlign, TextAlignV } from '@/core/accessors';
import { detachConnectorFromShape, getAttachedConnectors, getObjects, getObjectsById, transact } from '@/runtime/room-runtime';
import { TEXT_FONT_SIZE_PRESETS, useDeviceUIStore } from '@/stores/device-ui-store';
import { useSelectionStore } from '@/stores/selection-store';
import {
  adjustByPresets,
  applyField,
  BOLD,
  CODE_FONT_SIZE,
  CODE_LANGUAGE,
  COLOR,
  FILL_COLOR,
  FONT_FAMILY,
  FONT_SIZE,
  HEADER_VISIBLE,
  HIGHLIGHT,
  ITALIC,
  LINE_NUMBERS,
  OUTPUT_VISIBLE,
  SHAPE_TYPE,
  TEXT_ALIGN,
  TEXT_ALIGN_V,
  TEXT_COLOR,
  toggleField,
  WIDTH,
  withEditorOr,
} from './selection-field-table';

// === Source-of-ids selection ===
//
// Three id sources for actions, picked by the action (not the descriptor) —
// it's "who's calling," not "what the field is."

const getSelectedIds = (): string[] => useSelectionStore.getState().selectedIds;

const getTextSelectionIds = (): string[] => {
  const { textEditingId, selectedIds } = useSelectionStore.getState();
  return textEditingId ? [textEditingId] : selectedIds;
};

const getCodeIds = (): string[] => {
  const { codeEditingId, selectedIds } = useSelectionStore.getState();
  return codeEditingId ? [codeEditingId] : selectedIds;
};

const clampInt = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(n)));

const currentTextFontSize = (): number => useSelectionStore.getState().selectedStyles.fontSize ?? useDeviceUIStore.getState().textSize;

const currentCodeFontSize = (): number => useSelectionStore.getState().selectedStyles.fontSize ?? 14;

// === Property Actions ===

export const setSelectedColor = (color: string): void => applyField(getSelectedIds(), COLOR, color);
export const setSelectedWidth = (width: number): void => applyField(getSelectedIds(), WIDTH, width);
export const setSelectedShapeType = (shapeType: string): void => applyField(getSelectedIds(), SHAPE_TYPE, shapeType);
export const setSelectedFillColor = (fillColor: string | null): void => applyField(getTextSelectionIds(), FILL_COLOR, fillColor);
export const setSelectedTextColor = (color: string): void => applyField(getTextSelectionIds(), TEXT_COLOR, color);
export const setSelectedFontSize = (size: number): void => applyField(getTextSelectionIds(), FONT_SIZE, clampInt(size, 1, 999));
export const setSelectedFontFamily = (family: FontFamily): void => applyField(getTextSelectionIds(), FONT_FAMILY, family);
export const setSelectedTextAlign = (align: TextAlign): void => applyField(getTextSelectionIds(), TEXT_ALIGN, align);
export const setSelectedTextAlignV = (alignV: TextAlignV): void => applyField(getTextSelectionIds(), TEXT_ALIGN_V, alignV);

export const incrementFontSize = (): void =>
  adjustByPresets(getTextSelectionIds(), FONT_SIZE, TEXT_FONT_SIZE_PRESETS, 'up', currentTextFontSize(), 10, 144);
export const decrementFontSize = (): void =>
  adjustByPresets(getTextSelectionIds(), FONT_SIZE, TEXT_FONT_SIZE_PRESETS, 'down', currentTextFontSize(), 10, 144);

export const toggleSelectedBold = (): void =>
  withEditorOr(
    (e) => {
      e.chain().focus().toggleBold().run();
    },
    () => toggleField(getTextSelectionIds(), BOLD, false),
  );

export const toggleSelectedItalic = (): void =>
  withEditorOr(
    (e) => {
      e.chain().focus().toggleItalic().run();
    },
    () => toggleField(getTextSelectionIds(), ITALIC, false),
  );

export const setSelectedHighlight = (color: string | null): void =>
  withEditorOr(
    (e) => {
      if (color === null) e.chain().focus().unsetHighlight().run();
      else e.chain().focus().setHighlight({ color }).run();
    },
    () => applyField(getTextSelectionIds(), HIGHLIGHT, color),
  );

// === Code Block Actions ===

export const setSelectedCodeLanguage = (language: CodeLanguage): void => applyField(getCodeIds(), CODE_LANGUAGE, language);
export const setSelectedCodeFontSize = (size: number): void => applyField(getCodeIds(), CODE_FONT_SIZE, clampInt(size, 1, 999));
export const incrementCodeFontSize = (): void =>
  adjustByPresets(getCodeIds(), CODE_FONT_SIZE, TEXT_FONT_SIZE_PRESETS, 'up', currentCodeFontSize(), 10, 144);
export const decrementCodeFontSize = (): void =>
  adjustByPresets(getCodeIds(), CODE_FONT_SIZE, TEXT_FONT_SIZE_PRESETS, 'down', currentCodeFontSize(), 10, 144);
export const toggleCodeLineNumbers = (): void => toggleField(getCodeIds(), LINE_NUMBERS, true);
export const toggleCodeHeader = (): void => toggleField(getCodeIds(), HEADER_VISIBLE, true);
export const toggleCodeOutput = (): void => toggleField(getCodeIds(), OUTPUT_VISIBLE, false);

// === Delete (structural — connector-detach prelude, not a property write) ===

export function deleteSelected(): void {
  const { selectedIds } = useSelectionStore.getState();
  if (selectedIds.length === 0) return;

  const objectsById = getObjectsById();
  const idsToDelete = new Set(selectedIds);

  // Collect (connectorId, shapeId) pairs to detach. Surviving connectors get their bound
  // endpoint(s) replaced with the cached route's first/last point.
  const detachPairs: [string, string][] = [];
  for (const id of idsToDelete) {
    const handle = objectsById.get(id);
    if (!handle || handle.kind === 'connector') continue;
    const connectorIds = getAttachedConnectors(id);
    if (!connectorIds) continue;
    for (const connectorId of connectorIds) {
      if (idsToDelete.has(connectorId)) continue;
      detachPairs.push([connectorId, id]);
    }
  }

  transact(() => {
    for (const [connectorId, shapeId] of detachPairs) {
      detachConnectorFromShape(connectorId, shapeId);
    }
    const objects = getObjects();
    for (const id of idsToDelete) objects.delete(id);
  });

  useSelectionStore.getState().clearSelection();
}
