import type { ObjectHandle, ObjectKind } from '@/core/types/objects';
import { OBJECT_KINDS } from '@/core/types/objects';
import type { BBoxTuple } from '@/core/types/geometry';
import {
  getColor,
  getWidth,
  getFillColor,
  getShapeType,
  getFontSize,
  getFontFamily,
  getAlign,
  getAlignV,
  getLabelColor,
  getLanguage,
  getHeaderVisible,
  getOutputVisible,
  hasLabel,
} from '@/core/accessors';
import type { TextAlign, TextAlignV, FontFamily } from '@/core/accessors';
import { getTextFrame, getInlineStyles } from '@/core/text/text-system';
import { getCodeFrame } from '@/core/code/code-system';
import { expandBBoxEnvelope, frameToBbox } from '@/core/geometry/bounds';
import { getCurrentSnapshot, getHandle } from '@/runtime/room-runtime';
import type { SelectionKind, KindCounts, SelectedStyles, InlineStyles } from './types';
import { EMPTY_STYLES } from './types';
// Runtime-only import — circular dep is safe (only accessed inside function bodies, not at module eval)
import { useSelectionStore } from '@/stores/selection-store';

// Re-export for consumers that still import shared types from selection-utils.
export type { KindCounts, SelectedStyles, InlineStyles, SelectionKind } from './types';
export { EMPTY_STYLES, EMPTY_KIND_COUNTS, EMPTY_INLINE_STYLES } from './types';

export const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();

// === Selection Composition ===

/**
 * Single-pass composition from selected IDs.
 * Buckets IDs by kind, builds selectedIdSet, derives selectionKind and mode.
 */
export function computeSelectionComposition(ids: string[]) {
  const snapshot = getCurrentSnapshot();
  const counts: Record<ObjectKind, number> = {
    stroke: 0,
    shape: 0,
    text: 0,
    connector: 0,
    code: 0,
    image: 0,
    note: 0,
    bookmark: 0,
  };
  const selectedIdSet = new Set<string>();

  for (const id of ids) {
    const handle = snapshot.objectsById.get(id);
    if (!handle) continue;
    selectedIdSet.add(id);
    counts[handle.kind]++;
  }

  let nonZero = 0;
  let firstNonZero: ObjectKind | null = null;
  for (const k of OBJECT_KINDS) {
    if (counts[k] > 0) {
      nonZero++;
      if (!firstNonZero) firstNonZero = k;
    }
  }

  const selectionKind: SelectionKind = nonZero === 0 ? 'none' : nonZero > 1 ? 'mixed' : firstNonZero!;

  const kindCounts: KindCounts = { ...counts, total: selectedIdSet.size };

  const mode =
    selectedIdSet.size === 1 && selectionKind === 'connector'
      ? ('connector' as const)
      : selectedIdSet.size > 0
        ? ('standard' as const)
        : ('none' as const);

  return { selectionKind, kindCounts, selectedIdSet, mode };
}

// === Selection Bounds ===

/**
 * Compute padded selection bounds from selected IDs.
 * Zero-arg: reads selectedIds (+ textEditingId fallback) from selection store.
 * Text uses derived frame (WYSIWYG-accurate), others use bbox.
 */
export function computeSelectionBounds(): BBoxTuple | null {
  const { selectedIds, textEditingId, codeEditingId } = useSelectionStore.getState();
  const ids = selectedIds.length > 0 ? selectedIds : textEditingId ? [textEditingId] : codeEditingId ? [codeEditingId] : [];
  if (ids.length === 0) return null;

  const snapshot = getCurrentSnapshot();
  let result: BBoxTuple | null = null;

  for (const id of ids) {
    const handle = snapshot.objectsById.get(id);
    if (!handle) continue;
    if (handle.kind === 'text') {
      const frame = getTextFrame(id);
      if (frame) result = expandBBoxEnvelope(result, frameToBbox(frame));
      continue;
    }
    if (handle.kind === 'code') {
      const frame = getCodeFrame(id);
      if (frame) result = expandBBoxEnvelope(result, frameToBbox(frame));
      continue;
    }
    result = expandBBoxEnvelope(result, handle.bbox);
  }

  return result;
}

/**
 * Union of scale-source bboxes for the current selection.
 * Text uses layout frame (italic overhangs make bbox differ from visual frame).
 * Zero-arg: reads selectedIds from the selection store.
 */
export function computeTransformBoundsForScale(): BBoxTuple | null {
  const { selectedIds } = useSelectionStore.getState();
  if (selectedIds.length === 0) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const id of selectedIds) {
    const handle = getHandle(id);
    if (!handle) continue;
    const b = handle.kind === 'text' ? frameToBbox(getTextFrame(id) ?? [0, 0, 0, 0]) : handle.bbox;
    if (b[0] < minX) minX = b[0];
    if (b[1] < minY) minY = b[1];
    if (b[2] > maxX) maxX = b[2];
    if (b[3] > maxY) maxY = b[3];
  }
  if (!isFinite(minX)) return null;
  return [minX, minY, maxX, maxY];
}

// === Style Computation ===

/**
 * Compute unified style snapshot for a homogeneous selection.
 * Mixed selections → EMPTY_STYLES immediately (zero parsing).
 * Single-pass with early break once all fields are resolved.
 */
export function computeStyles(ids: string[], kind: SelectionKind, objectsById: ReadonlyMap<string, ObjectHandle>): SelectedStyles {
  if (kind === 'none' || kind === 'mixed' || kind === 'image' || kind === 'bookmark' || ids.length === 0) return EMPTY_STYLES;

  // Code blocks: track fontSize + language + chrome visibility
  if (kind === 'code') {
    for (const id of ids) {
      const handle = objectsById.get(id);
      if (!handle || handle.kind !== 'code') continue;
      return {
        ...EMPTY_STYLES,
        fontSize: Math.round(getFontSize(handle.y, 14)),
        codeLanguage: getLanguage(handle.y),
        codeHeaderVisible: getHeaderVisible(handle.y),
        codeOutputVisible: getOutputVisible(handle.y),
      };
    }
    return EMPTY_STYLES;
  }

  // Notes: track fillColor, fontFamily, textAlign, textAlignV (fontSize is derived, not stored)
  if (kind === 'note') {
    let firstFill: string | null = null;
    let firstFontFamily: FontFamily | null = null;
    let firstAlign: TextAlign | null = null;
    let firstAlignV: TextAlignV | null = null;
    let alignMixed = false;
    let alignVMixed = false;
    let first = true;

    for (const id of ids) {
      const handle = objectsById.get(id);
      if (!handle || handle.kind !== 'note') continue;
      if (first) {
        firstFill = getFillColor(handle.y) ?? null;
        firstFontFamily = getFontFamily(handle.y);
        firstAlign = getAlign(handle.y);
        firstAlignV = getAlignV(handle.y);
        first = false;
      } else {
        if (!alignMixed && getAlign(handle.y) !== firstAlign) alignMixed = true;
        if (!alignVMixed && getAlignV(handle.y) !== firstAlignV) alignVMixed = true;
        if (alignMixed && alignVMixed) break;
      }
    }
    if (first) return EMPTY_STYLES;
    return {
      ...EMPTY_STYLES,
      fillColor: firstFill,
      fontFamily: firstFontFamily,
      textAlign: alignMixed ? null : firstAlign,
      textAlignV: alignVMixed ? null : firstAlignV,
    };
  }

  const trackWidth = kind !== 'text';
  const trackFill = kind === 'shape' || kind === 'text';
  const trackShapeType = kind === 'shape';
  const trackTextAlign = kind === 'text' || kind === 'shape';
  const needsTextFields = kind === 'text' || kind === 'shape';

  let firstColor: string | null = null;
  let colorMixed = false;
  let colorSecond: string | null = null;
  let firstWidth: number | null = null;
  let widthMixed = false;
  let firstFill: string | null = null;
  let fillMixed = false;
  let fillSecond: string | null = null;
  let firstShapeType: string | null = null;
  let shapeTypeMixed = false;
  let firstFontSize: number | null = null;
  let firstAlign: TextAlign | null = null;
  let alignMixed = false;
  let firstAlignV: TextAlignV | null = null;
  let alignVMixed = false;
  let firstFontFamily: FontFamily | null = null;
  let firstLabelColor: string | null = null;
  let textFieldsSet = false;
  let first = true;

  for (const id of ids) {
    const handle = objectsById.get(id);
    if (!handle) continue;

    if (first) {
      firstColor = getColor(handle.y);
      if (trackWidth) firstWidth = getWidth(handle.y);
      if (trackFill) firstFill = getFillColor(handle.y) ?? null;
      if (trackShapeType) firstShapeType = getShapeType(handle.y);
      first = false;
    } else {
      if (!colorMixed && getColor(handle.y) !== firstColor) {
        colorMixed = true;
        colorSecond = getColor(handle.y);
      }
      if (trackWidth && !widthMixed && getWidth(handle.y) !== firstWidth) widthMixed = true;
      if (trackFill && !fillMixed && (getFillColor(handle.y) ?? null) !== firstFill) {
        fillMixed = true;
        fillSecond = getFillColor(handle.y) ?? null;
      }
      if (trackShapeType && !shapeTypeMixed && getShapeType(handle.y) !== firstShapeType) shapeTypeMixed = true;
      if (trackTextAlign && !alignMixed && getAlign(handle.y) !== firstAlign) alignMixed = true;
    }

    // Text fields: first object with text data wins (text objects always, shapes only if labeled)
    if (needsTextFields && !textFieldsSet) {
      if (handle.kind === 'text') {
        firstLabelColor = getColor(handle.y);
        firstFontSize = Math.round(getFontSize(handle.y));
        firstFontFamily = getFontFamily(handle.y);
        if (trackTextAlign) firstAlign = getAlign(handle.y);
        textFieldsSet = true;
      } else if (handle.kind === 'shape' && hasLabel(handle.y)) {
        firstLabelColor = getLabelColor(handle.y);
        firstFontSize = Math.round(getFontSize(handle.y));
        firstFontFamily = getFontFamily(handle.y);
        if (trackTextAlign) {
          firstAlign = getAlign(handle.y, 'center');
          firstAlignV = getAlignV(handle.y);
        }
        textFieldsSet = true;
      }
    } else if (kind === 'shape' && handle.kind === 'shape' && hasLabel(handle.y)) {
      // Track alignment mismatch across labeled shapes
      if (!alignMixed && getAlign(handle.y, 'center') !== firstAlign) alignMixed = true;
      if (!alignVMixed && getAlignV(handle.y) !== firstAlignV) alignVMixed = true;
    }

    if (
      colorMixed &&
      (!trackWidth || widthMixed) &&
      (!trackFill || fillMixed) &&
      (!trackShapeType || shapeTypeMixed) &&
      (!trackTextAlign || alignMixed)
    )
      break;
  }

  return {
    color: firstColor ?? '#262626',
    colorMixed,
    colorSecond: colorMixed ? colorSecond : null,
    width: trackWidth ? (widthMixed ? null : firstWidth) : null,
    fillColor: trackFill ? (firstFill ?? null) : null,
    fillColorMixed: trackFill && fillMixed,
    fillColorSecond: trackFill && fillMixed ? fillSecond : null,
    shapeType: trackShapeType ? (shapeTypeMixed ? null : firstShapeType) : kind === 'text' ? 'text' : null,
    fontSize: needsTextFields ? firstFontSize : null,
    textAlign: trackTextAlign ? (alignMixed ? null : firstAlign) : null,
    textAlignV: kind === 'shape' ? (alignVMixed ? null : firstAlignV) : null,
    fontFamily: needsTextFields ? firstFontFamily : null,
    labelColor: needsTextFields ? firstLabelColor : null,
    codeLanguage: null,
    codeHeaderVisible: null,
    codeOutputVisible: null,
  };
}

export function stylesEqual(a: SelectedStyles, b: SelectedStyles): boolean {
  return (
    a.color === b.color &&
    a.colorMixed === b.colorMixed &&
    a.colorSecond === b.colorSecond &&
    a.width === b.width &&
    a.fillColor === b.fillColor &&
    a.fillColorMixed === b.fillColorMixed &&
    a.fillColorSecond === b.fillColorSecond &&
    a.shapeType === b.shapeType &&
    a.fontSize === b.fontSize &&
    a.textAlign === b.textAlign &&
    a.textAlignV === b.textAlignV &&
    a.fontFamily === b.fontFamily &&
    a.labelColor === b.labelColor &&
    a.codeLanguage === b.codeLanguage &&
    a.codeHeaderVisible === b.codeHeaderVisible &&
    a.codeOutputVisible === b.codeOutputVisible
  );
}

export function inlineStylesEqual(a: InlineStyles, b: InlineStyles): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.highlightColor === b.highlightColor;
}

/**
 * Aggregate inline styles from text-system cache across all text IDs.
 * All must be bold for bold:true, same for italic.
 * Highlight must be identical non-null across all for highlightColor to be non-null.
 */
export function computeUniformInlineStyles(ids: string[], objectsById: ReadonlyMap<string, ObjectHandle>): InlineStyles {
  let bold = true,
    italic = true;
  let firstHighlight: string | null = null;
  let highlightMixed = false;
  let hasAny = false;

  for (const id of ids) {
    const handle = objectsById.get(id);
    if (!handle || (handle.kind !== 'text' && handle.kind !== 'shape' && handle.kind !== 'note')) continue;
    if (handle.kind === 'shape' && !hasLabel(handle.y)) continue;
    const u = getInlineStyles(id);
    if (!u) continue;
    if (!hasAny) {
      firstHighlight = u.uniformHighlight;
      hasAny = true;
    } else {
      if (!highlightMixed && u.uniformHighlight !== firstHighlight) highlightMixed = true;
    }
    if (!u.allBold) bold = false;
    if (!u.allItalic) italic = false;
    if (!bold && !italic && highlightMixed) break;
  }

  return {
    bold: hasAny && bold,
    italic: hasAny && italic,
    highlightColor: hasAny && !highlightMixed ? firstHighlight : null,
  };
}
