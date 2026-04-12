import type { ObjectHandle } from '@/core/types/objects';
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
import { getCurrentSnapshot } from '@/runtime/room-runtime';
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
  let strokes = 0,
    shapes = 0,
    text = 0,
    connectors = 0,
    code = 0,
    notes = 0,
    images = 0,
    bookmarks = 0;
  const selectedIdSet = new Set<string>();

  for (const id of ids) {
    const handle = snapshot.objectsById.get(id);
    if (!handle) continue;
    selectedIdSet.add(id);
    switch (handle.kind) {
      case 'stroke':
        strokes++;
        break;
      case 'shape':
        shapes++;
        break;
      case 'text':
        text++;
        break;
      case 'connector':
        connectors++;
        break;
      case 'code':
        code++;
        break;
      case 'note':
        notes++;
        break;
      case 'image':
        images++;
        break;
      case 'bookmark':
        bookmarks++;
        break;
    }
  }

  const kindCounts: KindCounts = {
    strokes,
    shapes,
    text,
    connectors,
    code,
    notes,
    images,
    bookmarks,
    total: selectedIdSet.size,
  };

  const nonZero =
    (strokes > 0 ? 1 : 0) +
    (shapes > 0 ? 1 : 0) +
    (text > 0 ? 1 : 0) +
    (connectors > 0 ? 1 : 0) +
    (code > 0 ? 1 : 0) +
    (notes > 0 ? 1 : 0) +
    (images > 0 ? 1 : 0) +
    (bookmarks > 0 ? 1 : 0);

  let selectionKind: SelectionKind;
  if (nonZero === 0) selectionKind = 'none';
  else if (nonZero > 1) selectionKind = 'mixed';
  else if (strokes > 0) selectionKind = 'strokesOnly';
  else if (shapes > 0) selectionKind = 'shapesOnly';
  else if (text > 0) selectionKind = 'textOnly';
  else if (code > 0) selectionKind = 'codeOnly';
  else if (notes > 0) selectionKind = 'notesOnly';
  else if (images > 0) selectionKind = 'imagesOnly';
  else if (bookmarks > 0) selectionKind = 'bookmarksOnly';
  else selectionKind = 'connectorsOnly';

  const mode =
    selectedIdSet.size === 1 && selectionKind === 'connectorsOnly'
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

// === Style Computation ===

/**
 * Compute unified style snapshot for a homogeneous selection.
 * Mixed selections → EMPTY_STYLES immediately (zero parsing).
 * Single-pass with early break once all fields are resolved.
 */
export function computeStyles(ids: string[], kind: SelectionKind, objectsById: ReadonlyMap<string, ObjectHandle>): SelectedStyles {
  if (kind === 'none' || kind === 'mixed' || kind === 'imagesOnly' || kind === 'bookmarksOnly' || ids.length === 0) return EMPTY_STYLES;

  // Code blocks: track fontSize + language + chrome visibility
  if (kind === 'codeOnly') {
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
  if (kind === 'notesOnly') {
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

  const trackWidth = kind !== 'textOnly';
  const trackFill = kind === 'shapesOnly' || kind === 'textOnly';
  const trackShapeType = kind === 'shapesOnly';
  const trackTextAlign = kind === 'textOnly' || kind === 'shapesOnly';
  const needsTextFields = kind === 'textOnly' || kind === 'shapesOnly';

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
    } else if (kind === 'shapesOnly' && handle.kind === 'shape' && hasLabel(handle.y)) {
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
    shapeType: trackShapeType ? (shapeTypeMixed ? null : firstShapeType) : kind === 'textOnly' ? 'text' : null,
    fontSize: needsTextFields ? firstFontSize : null,
    textAlign: trackTextAlign ? (alignMixed ? null : firstAlign) : null,
    textAlignV: kind === 'shapesOnly' ? (alignVMixed ? null : firstAlignV) : null,
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
