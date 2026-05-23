import { hasLabel } from '@/core/accessors';
import { getInlineStyles } from '@/core/text/text-system';
import type { ObjectKind } from '@/core/types/objects';
import { OBJECT_KINDS } from '@/core/types/objects';
import { getObjectsById } from '@/runtime/room-runtime';
import {
  CODE_FONT_SIZE,
  CODE_LANGUAGE,
  COLOR,
  collectHandles,
  FILL_COLOR,
  FONT_FAMILY,
  FONT_SIZE,
  foldField,
  HEADER_VISIBLE,
  OUTPUT_VISIBLE,
  SHAPE_TYPE,
  TEXT_ALIGN,
  TEXT_ALIGN_V,
  TEXT_COLOR,
  WIDTH,
} from './selection-field-table';
import type { InlineStyles, KindCounts, SelectedStyles, SelectionKind } from './types';
import { EMPTY_STYLES } from './types';

export const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();

// === Selection Composition ===

/**
 * Single-pass composition from selected IDs.
 * Buckets IDs by kind, builds selectedIdSet, derives selectionKind and mode.
 */
export function computeSelectionComposition(ids: string[]) {
  const objectsById = getObjectsById();
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
    const handle = objectsById.get(id);
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

// === Style Computation ===

/**
 * Unified style snapshot via declarative `foldField` composition over the field
 * table. Each named aggregate handles "first observed value, mixed flag, second
 * for split UI". Code-only fields gate on `kind === 'code'` so non-code selections
 * don't surface stale values.
 */
export function computeStyles(ids: string[], kind: SelectionKind): SelectedStyles {
  if (kind === 'none' || kind === 'mixed' || kind === 'image' || kind === 'bookmark' || ids.length === 0) {
    return EMPTY_STYLES;
  }
  const handles = collectHandles(ids);
  if (handles.length === 0) return EMPTY_STYLES;

  const color = foldField(handles, COLOR);
  const width = foldField(handles, WIDTH);
  const fill = foldField(handles, FILL_COLOR);
  const shape = foldField(handles, SHAPE_TYPE);
  const fontSize = foldField(handles, FONT_SIZE);
  const codeFs = foldField(handles, CODE_FONT_SIZE);
  const align = foldField(handles, TEXT_ALIGN);
  const alignV = foldField(handles, TEXT_ALIGN_V);
  const family = foldField(handles, FONT_FAMILY);
  const label = foldField(handles, TEXT_COLOR);
  const lang = foldField(handles, CODE_LANGUAGE);
  const header = foldField(handles, HEADER_VISIBLE);
  const output = foldField(handles, OUTPUT_VISIBLE);

  return {
    color: color.value,
    colorMixed: color.mixed,
    width: width.mixed ? null : width.value,
    fillColor: fill.value,
    fillColorMixed: fill.mixed,
    shapeType: shape.mixed ? null : (shape.value ?? (kind === 'text' ? 'text' : null)),
    fontSize: kind === 'code' ? codeFs.value : fontSize.value,
    textAlign: align.mixed ? null : align.value,
    textAlignV: alignV.mixed ? null : alignV.value,
    fontFamily: family.value,
    labelColor: label.value,
    codeLanguage: kind === 'code' ? (lang.mixed ? null : lang.value) : null,
    codeHeaderVisible: kind === 'code' ? (header.mixed ? null : header.value) : null,
    codeOutputVisible: kind === 'code' ? (output.mixed ? null : output.value) : null,
  };
}

export function stylesEqual(a: SelectedStyles, b: SelectedStyles): boolean {
  return (
    a.color === b.color &&
    a.colorMixed === b.colorMixed &&
    a.width === b.width &&
    a.fillColor === b.fillColor &&
    a.fillColorMixed === b.fillColorMixed &&
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
 *
 * Stays standalone — its bool-AND-fold over `allBold`/`allItalic` doesn't fit
 * `Aggregate<V>`'s "first-or-mixed" shape.
 */
export function computeUniformInlineStyles(ids: string[]): InlineStyles {
  const objectsById = getObjectsById();
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
