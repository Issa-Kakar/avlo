import type { ObjectHandle, WorldBounds } from '@avlo/shared';
import {
  getColor,
  getWidth,
  getFillColor,
  getShapeType,
  getFontSize,
  getAlign,
  bboxTupleToWorldBounds,
  type TextAlign,
} from '@avlo/shared';
import { getTextFrame, getInlineStyles } from '@/lib/text/text-system';
import { expandEnvelope, frameTupleToWorldBounds } from '@/lib/geometry/bounds';
import { getCurrentSnapshot } from '@/canvas/room-runtime';
import type { SelectionKind } from '@/stores/selection-store';
// Runtime-only import — circular dep is safe (only accessed inside function bodies, not at module eval)
import { useSelectionStore } from '@/stores/selection-store';

// === Types ===

export interface KindCounts {
  strokes: number;
  shapes: number;
  text: number;
  connectors: number;
  total: number;
}

export interface SelectedStyles {
  /** First object's stroke/border color. Used by all kinds. */
  color: string;
  /** Multiple different stroke colors detected. Used by strokes, shapes, connectors. */
  colorMixed: boolean;
  /** Second stroke color for split indicator. Only set when colorMixed. */
  colorSecond: string | null;
  /** Uniform stroke width, null if mixed. Used by strokes, shapes, connectors. */
  width: number | null;
  /** First shape's fill color, null = no fill. Used by shapesOnly. Kept even when mixed. */
  fillColor: string | null;
  /** Multiple different fill colors detected. Used by shapesOnly. */
  fillColorMixed: boolean;
  /** Second fill color for split indicator. Only set when fillColorMixed. */
  fillColorSecond: string | null;
  /** Uniform shape type, 'text' for textOnly, null if mixed. Used by shapesOnly, textOnly. */
  shapeType: string | null;
  /** First text object's fontSize (rounded). Used by textOnly. */
  fontSize: number | null;
  /** Uniform text alignment, null if mixed. Used by textOnly. */
  textAlign: TextAlign | null;
}

// === Constants ===

export const EMPTY_STYLES: SelectedStyles = {
  color: '#262626',
  colorMixed: false,
  colorSecond: null,
  width: null,
  fillColor: null,
  fillColorMixed: false,
  fillColorSecond: null,
  shapeType: null,
  fontSize: null,
  textAlign: null,
};
export const EMPTY_KIND_COUNTS: KindCounts = {
  strokes: 0,
  shapes: 0,
  text: 0,
  connectors: 0,
  total: 0,
};
export const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();

export interface InlineStyles {
  bold: boolean;
  italic: boolean;
  highlightColor: string | null;
}

export const EMPTY_INLINE_STYLES: InlineStyles = {
  bold: false,
  italic: false,
  highlightColor: null,
};

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
    connectors = 0;
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
    }
  }

  const kindCounts: KindCounts = {
    strokes,
    shapes,
    text,
    connectors,
    total: selectedIdSet.size,
  };

  const nonZero =
    (strokes > 0 ? 1 : 0) + (shapes > 0 ? 1 : 0) + (text > 0 ? 1 : 0) + (connectors > 0 ? 1 : 0);

  let selectionKind: SelectionKind;
  if (nonZero === 0) selectionKind = 'none';
  else if (nonZero > 1) selectionKind = 'mixed';
  else if (strokes > 0) selectionKind = 'strokesOnly';
  else if (shapes > 0) selectionKind = 'shapesOnly';
  else if (text > 0) selectionKind = 'textOnly';
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
export function computeSelectionBounds(): WorldBounds | null {
  const { selectedIds, textEditingId } = useSelectionStore.getState();
  const ids = selectedIds.length > 0 ? selectedIds : textEditingId ? [textEditingId] : [];
  if (ids.length === 0) return null;

  const snapshot = getCurrentSnapshot();
  let result: WorldBounds | null = null;

  for (const id of ids) {
    const handle = snapshot.objectsById.get(id);
    if (!handle) continue;
    if (handle.kind === 'text') {
      const frame = getTextFrame(id);
      if (frame) result = expandEnvelope(result, frameTupleToWorldBounds(frame));
      continue;
    }
    result = expandEnvelope(result, bboxTupleToWorldBounds(handle.bbox));
  }

  return result;
}

// === Style Computation ===

/**
 * Compute unified style snapshot for a homogeneous selection.
 * Mixed selections → EMPTY_STYLES immediately (zero parsing).
 * Single-pass with early break once all fields are resolved.
 */
export function computeStyles(
  ids: string[],
  kind: SelectionKind,
  objectsById: ReadonlyMap<string, ObjectHandle>,
): SelectedStyles {
  if (kind === 'none' || kind === 'mixed' || ids.length === 0) return EMPTY_STYLES;

  const trackWidth = kind !== 'textOnly';
  const trackFill = kind === 'shapesOnly';
  const trackShapeType = kind === 'shapesOnly';
  const trackText = kind === 'textOnly';

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
  let fontSizeMixed = false;
  let firstAlign: TextAlign | null = null;
  let alignMixed = false;
  let first = true;

  for (const id of ids) {
    const handle = objectsById.get(id);
    if (!handle) continue;

    if (first) {
      firstColor = getColor(handle.y);
      if (trackWidth) firstWidth = getWidth(handle.y);
      if (trackFill) firstFill = getFillColor(handle.y) ?? null;
      if (trackShapeType) firstShapeType = getShapeType(handle.y);
      if (trackText) {
        firstFontSize = Math.round(getFontSize(handle.y));
        firstAlign = getAlign(handle.y);
      }
      first = false;
      continue;
    }

    if (!colorMixed && getColor(handle.y) !== firstColor) {
      colorMixed = true;
      colorSecond = getColor(handle.y);
    }
    if (trackWidth && !widthMixed && getWidth(handle.y) !== firstWidth) widthMixed = true;
    if (trackFill && !fillMixed && (getFillColor(handle.y) ?? null) !== firstFill) {
      fillMixed = true;
      fillSecond = getFillColor(handle.y) ?? null;
    }
    if (trackShapeType && !shapeTypeMixed && getShapeType(handle.y) !== firstShapeType)
      shapeTypeMixed = true;
    if (trackText && !fontSizeMixed && Math.round(getFontSize(handle.y)) !== firstFontSize)
      fontSizeMixed = true;
    if (trackText && !alignMixed && getAlign(handle.y) !== firstAlign) alignMixed = true;

    if (
      colorMixed &&
      (!trackWidth || widthMixed) &&
      (!trackFill || fillMixed) &&
      (!trackShapeType || shapeTypeMixed) &&
      (!trackText || (fontSizeMixed && alignMixed))
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
    shapeType: trackShapeType
      ? shapeTypeMixed
        ? null
        : firstShapeType
      : kind === 'textOnly'
        ? 'text'
        : null,
    fontSize: trackText ? firstFontSize : null,
    textAlign: trackText ? (alignMixed ? null : firstAlign) : null,
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
    a.textAlign === b.textAlign
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
export function computeUniformInlineStyles(
  ids: string[],
  objectsById: ReadonlyMap<string, ObjectHandle>,
): InlineStyles {
  let bold = true, italic = true;
  let firstHighlight: string | null = null;
  let highlightMixed = false;
  let hasAny = false;

  for (const id of ids) {
    const handle = objectsById.get(id);
    if (!handle || handle.kind !== 'text') continue;
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
