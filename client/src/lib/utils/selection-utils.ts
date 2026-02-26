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
import { getTextFrame } from '@/lib/text/text-system';
import { expandEnvelope, frameTupleToWorldBounds } from '@/lib/geometry/bounds';
import { getCurrentSnapshot } from '@/canvas/room-runtime';
import type { SelectionKind } from '@/stores/selection-store';

// === Types ===

export interface KindCounts {
  strokes: number;
  shapes: number;
  text: number;
  connectors: number;
  total: number;
}

export interface SelectedStyles {
  color: string;
  colorMixed: boolean;
  colorSecond: string | null;
  width: number | null;
  fillColor: string | null;
  shapeType: string | null;
  fontSize: number | null;
  textAlign: TextAlign | null;
}

// === Constants ===

export const EMPTY_STYLES: SelectedStyles = {
  color: '#262626',
  colorMixed: false,
  colorSecond: null,
  width: null,
  fillColor: null,
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
 * Text uses derived frame (WYSIWYG-accurate), others use bbox.
 */
export function computeSelectionBounds(selectedIds: string[]): WorldBounds | null {
  if (selectedIds.length === 0) return null;

  const snapshot = getCurrentSnapshot();
  let result: WorldBounds | null = null;

  for (const id of selectedIds) {
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
    if (trackFill && !fillMixed && (getFillColor(handle.y) ?? null) !== firstFill) fillMixed = true;
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
    fillColor: trackFill ? (fillMixed ? null : firstFill) : null,
    shapeType: trackShapeType
      ? shapeTypeMixed
        ? null
        : firstShapeType
      : kind === 'textOnly'
        ? 'text'
        : null,
    fontSize: trackText ? (fontSizeMixed ? null : firstFontSize) : null,
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
    a.shapeType === b.shapeType &&
    a.fontSize === b.fontSize &&
    a.textAlign === b.textAlign
  );
}
