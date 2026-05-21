/**
 * Selection Field Table
 *
 * Single source of truth for "what fields exist, how they're read/written/persisted
 * per kind". Adding a property = appending one `FieldDescriptor` entry.
 *
 * Pattern: `object-query.ts`'s `KIND` capability table + `transform.ts`'s mapped
 * dispatch tables + `reroute-connector.ts`'s `Pipeline` strategy. Reader/writer
 * take `ObjectHandle` directly so writers that need `id` (e.g. `TEXT_ALIGN`'s
 * origin recompute, `BOLD/ITALIC/HIGHLIGHT`'s inline-styles read) stay typed.
 */

import type { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import type { CodeLanguage, FontFamily, TextAlign, TextAlignV } from '@/core/accessors';
import {
  getAlign,
  getAlignV,
  getColor,
  getContent,
  getFillColor,
  getFontFamily,
  getFontSize,
  getHeaderVisible,
  getLabelColor,
  getLanguage,
  getLineNumbers,
  getOrigin,
  getOutputVisible,
  getShapeType,
  getWidth,
  hasLabel,
} from '@/core/accessors';
import { anchorFactor, getInlineStyles, getTextFrame } from '@/core/text/text-system';
import type { ObjectHandle, ObjectKind } from '@/core/types/objects';
import { getHandle, transact } from '@/runtime/room-runtime';
import { textTool } from '@/runtime/tool-registry';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import { useSelectionStore } from '@/stores/selection-store';
import type { SelectionKind } from './types';

// ============================================================================
// CORE TYPES
// ============================================================================

export interface FieldDescriptor<V> {
  /** Per-kind reader. Missing keys = field doesn't apply to that kind. */
  readonly read: { readonly [K in ObjectKind]?: (h: ObjectHandle) => V | undefined };
  /** Per-kind writer. Multi-key writes belong inside the closure (transact already open). */
  readonly write: { readonly [K in ObjectKind]?: (h: ObjectHandle, v: V) => void };
  /** Optional precondition (e.g. shape needs hasLabel for fontSize/labelColor). */
  readonly accepts?: { readonly [K in ObjectKind]?: (h: ObjectHandle) => boolean };
  /** Device-UI persist by aggregate SelectionKind (not handle kind). Closure may branch on v. */
  readonly persist?: { readonly [K in SelectionKind]?: (v: V) => void };
  /** Default `Object.is`; override for structural types. */
  readonly equals?: (a: V, b: V) => boolean;
}

export interface Aggregate<V> {
  readonly value: V | null;
  readonly mixed: boolean;
  /** Second distinct value, for two-color split UI. */
  readonly second: V | null;
}

// One-cast-per-loop dispatch bridge — mirrors `tools/selection/transform.ts`'s
// `APPLY_SCALE[kind]` cast. (Spatial hit dispatch was switched to a per-kind
// switch in `core/spatial/hit-dispatch.ts`, so this is now the canonical
// example of a mapped-table dispatch with biome-ignore.)
// biome-ignore lint/suspicious/noExplicitAny: dispatch boundary; mapped table proves correctness at definition
type AnyDescriptor = FieldDescriptor<any>;

// ============================================================================
// HELPERS
// ============================================================================

export function collectHandles(ids: readonly string[]): ObjectHandle[] {
  const out: ObjectHandle[] = [];
  for (const id of ids) {
    const h = getHandle(id);
    if (h) out.push(h);
  }
  return out;
}

function passesAccept(f: AnyDescriptor, h: ObjectHandle): boolean {
  const a = f.accepts?.[h.kind];
  return !a || a(h);
}

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

function setBoldOnContent(h: ObjectHandle, v: boolean): void {
  const c = getContent(h.y);
  if (c) formatFragment(c, { bold: v ? true : null });
}

function setItalicOnContent(h: ObjectHandle, v: boolean): void {
  const c = getContent(h.y);
  if (c) formatFragment(c, { italic: v ? true : null });
}

function setHighlightOnContent(h: ObjectHandle, v: string | null): void {
  const c = getContent(h.y);
  if (c) formatFragment(c, { highlight: v ? { color: v } : null });
}

// ============================================================================
// PRIMITIVES
// ============================================================================

/**
 * First-or-mixed read aggregation. First handle whose reader returns a non-undefined
 * value sets `value`; subsequent differing values set `mixed = true` + `second`.
 * Skips handles that fail `accepts` or have no reader for their kind.
 */
export function foldField<V>(handles: readonly ObjectHandle[], f: FieldDescriptor<V>): Aggregate<V> {
  const fAny = f as AnyDescriptor;
  const eq = f.equals ?? Object.is;
  let value: V | null = null;
  let second: V | null = null;
  let mixed = false;
  let hasFirst = false;

  for (const h of handles) {
    if (!passesAccept(fAny, h)) continue;
    const reader = fAny.read[h.kind];
    if (!reader) continue;
    const v = reader(h) as V | undefined;
    if (v === undefined) continue;

    if (!hasFirst) {
      value = v;
      hasFirst = true;
    } else if (!mixed && !eq(value as V, v)) {
      mixed = true;
      second = v;
    }
  }

  return { value, mixed, second };
}

/**
 * Open one transact, dispatch per-kind writes, persist by SelectionKind
 * (skipped on `mixed`/`none`), refresh styles. Multi-key writes belong inside
 * the writer closure — they share the open transact.
 */
export function applyField<V>(ids: readonly string[], f: FieldDescriptor<V>, value: V): void {
  if (ids.length === 0) return;
  const handles = collectHandles(ids);
  if (handles.length === 0) return;
  const fAny = f as AnyDescriptor;

  transact(() => {
    for (const h of handles) {
      if (!passesAccept(fAny, h)) continue;
      fAny.write[h.kind]?.(h, value);
    }
  });

  const { selectionKind } = useSelectionStore.getState();
  if (selectionKind !== 'mixed' && selectionKind !== 'none') {
    f.persist?.[selectionKind]?.(value);
  }
  useSelectionStore.getState().refreshStyles();
}

/**
 * First-applicable read → applyField(!current). Replaces the 3 byte-identical
 * code-toggle clones (lineNumbers / headerVisible / outputVisible) and the
 * bold / italic toggles. Fallback used when no applicable handle exists.
 */
export function toggleField(ids: readonly string[], f: FieldDescriptor<boolean>, fallback: boolean): void {
  if (ids.length === 0) return;
  const handles = collectHandles(ids);
  const fAny = f as AnyDescriptor;
  let current = fallback;
  for (const h of handles) {
    if (!passesAccept(fAny, h)) continue;
    const reader = fAny.read[h.kind];
    if (!reader) continue;
    const v = reader(h);
    if (v === undefined) continue;
    current = v as boolean;
    break;
  }
  applyField(ids, f, !current);
}

/**
 * Step a numeric field through a preset list. Clamps to `[clampMin, clampMax]`
 * if `current` is outside; otherwise picks the next preset above/below.
 */
export function adjustByPresets(
  ids: readonly string[],
  f: FieldDescriptor<number>,
  presets: readonly number[],
  dir: 'up' | 'down',
  current: number,
  clampMin: number,
  clampMax: number,
): void {
  if (ids.length === 0) return;
  if (dir === 'up') {
    if (current < clampMin) {
      applyField(ids, f, clampMin);
      return;
    }
    const next = presets.find((p) => p > current);
    if (next !== undefined) applyField(ids, f, next);
    return;
  }
  if (current > clampMax) {
    applyField(ids, f, clampMax);
    return;
  }
  let prev: number | undefined;
  for (const p of presets) {
    if (p >= current) break;
    prev = p;
  }
  if (prev !== undefined) applyField(ids, f, prev);
}

/**
 * Tiptap fast-path. When the editor is mounted, route to it; otherwise run
 * the field-layer fallback. Used by `toggleSelectedBold` / `toggleSelectedItalic`
 * / `setSelectedHighlight`.
 */
export function withEditorOr(whenEditor: (e: Editor) => void, otherwise: () => void): void {
  const editor = textTool.getEditor();
  if (editor) {
    whenEditor(editor);
    return;
  }
  otherwise();
}

// ============================================================================
// PERSIST SINKS (thin wrappers over device-ui-store)
// ============================================================================

const setShapeColorPersist = (v: string) => useDeviceUIStore.getState().setShapeColor(v);
const setShapeFillColorPersist = (v: string) => useDeviceUIStore.getState().setShapeFillColor(v);
const setShapeWidthPersist = (v: number) => useDeviceUIStore.getState().setShapeWidth(v);
const setStrokeWidthPersist = (v: number) => useDeviceUIStore.getState().setStrokeWidth(v);
const setConnectorColorPersist = (v: string) => useDeviceUIStore.getState().setConnectorColor(v);
const setConnectorWidthPersist = (v: number) => useDeviceUIStore.getState().setConnectorWidth(v);
const setTextSize = (v: number) => useDeviceUIStore.getState().setTextSize(v);
const setTextColor = (v: string) => useDeviceUIStore.getState().setTextColor(v);
const setTextFillColor = (v: string | null) => useDeviceUIStore.getState().setTextFillColor(v);
const setTextFontFamily = (v: FontFamily) => useDeviceUIStore.getState().setTextFontFamily(v);
const setNoteFontFamily = (v: FontFamily) => useDeviceUIStore.getState().setNoteFontFamily(v);
const setTextAlign = (v: TextAlign) => useDeviceUIStore.getState().setTextAlign(v);
const setNoteAlign = (v: TextAlign) => useDeviceUIStore.getState().setNoteAlign(v);
const setShapeAlign = (v: TextAlign) => useDeviceUIStore.getState().setShapeAlign(v);
const setNoteAlignV = (v: TextAlignV) => useDeviceUIStore.getState().setNoteAlignV(v);
const setShapeAlignV = (v: TextAlignV) => useDeviceUIStore.getState().setShapeAlignV(v);
const setCodeLineNumbers = (v: boolean) => useDeviceUIStore.getState().setCodeLineNumbers(v);
const setCodeHeaderVisible = (v: boolean) => useDeviceUIStore.getState().setCodeHeaderVisible(v);

// ============================================================================
// FIELD DESCRIPTORS
// ============================================================================

// Stroke/shape border + connector + text 'color'. Code/note/image/bookmark
// don't render a stroke color — omitted so code-only selections fall back to
// the EMPTY_STYLES default '#262626' instead of getColor's '#000' fallback.
export const COLOR: FieldDescriptor<string> = {
  read: {
    stroke: (h) => getColor(h.y),
    shape: (h) => getColor(h.y),
    text: (h) => getColor(h.y),
    connector: (h) => getColor(h.y),
  },
  write: {
    stroke: (h, v) => h.y.set('color', v),
    shape: (h, v) => h.y.set('color', v),
    text: (h, v) => h.y.set('color', v),
    connector: (h, v) => h.y.set('color', v),
  },
  persist: {
    // stroke: NO persist — pen/highlighter slots are independent of selected stroke color.
    shape: setShapeColorPersist,
    text: setTextColor,
    connector: setConnectorColorPersist,
  },
};

export const WIDTH: FieldDescriptor<number> = {
  read: {
    stroke: (h) => getWidth(h.y),
    shape: (h) => getWidth(h.y),
    connector: (h) => getWidth(h.y),
  },
  write: {
    stroke: (h, v) => h.y.set('width', v),
    shape: (h, v) => h.y.set('width', v),
    connector: (h, v) => h.y.set('width', v),
  },
  persist: {
    stroke: setStrokeWidthPersist,
    shape: setShapeWidthPersist,
    connector: setConnectorWidthPersist,
  },
};

export const SHAPE_TYPE: FieldDescriptor<string> = {
  read: { shape: (h) => getShapeType(h.y) },
  write: { shape: (h, v) => h.y.set('shapeType', v) },
};

export const FILL_COLOR: FieldDescriptor<string | null> = {
  read: {
    shape: (h) => getFillColor(h.y) ?? null,
    text: (h) => getFillColor(h.y) ?? null,
    note: (h) => getFillColor(h.y) ?? null,
  },
  write: {
    shape: (h, v) => (v === null ? h.y.delete('fillColor') : h.y.set('fillColor', v)),
    text: (h, v) => (v === null ? h.y.delete('fillColor') : h.y.set('fillColor', v)),
    note: (h, v) => (v === null ? h.y.delete('fillColor') : h.y.set('fillColor', v)),
  },
  persist: {
    // null = unfill the OBJECT only, not the device default.
    shape: (v) => {
      if (v !== null) setShapeFillColorPersist(v);
    },
    text: setTextFillColor,
    // note: omitted — note fill is per-object, not a device default
  },
};

// text/shape (only labeled). text → 'color', shape → 'labelColor'.
export const TEXT_COLOR: FieldDescriptor<string> = {
  read: {
    text: (h) => getColor(h.y),
    shape: (h) => getLabelColor(h.y),
  },
  write: {
    text: (h, v) => h.y.set('color', v),
    shape: (h, v) => h.y.set('labelColor', v),
  },
  accepts: { shape: (h) => hasLabel(h.y) },
  persist: { text: setTextColor, shape: setTextColor },
};

// text/labeled-shape. Notes derive fontSize from scale — skipped.
export const FONT_SIZE: FieldDescriptor<number> = {
  read: {
    text: (h) => Math.round(getFontSize(h.y)),
    shape: (h) => Math.round(getFontSize(h.y)),
  },
  write: {
    text: (h, v) => h.y.set('fontSize', v),
    shape: (h, v) => h.y.set('fontSize', v),
  },
  accepts: { shape: (h) => hasLabel(h.y) },
  persist: { text: setTextSize, shape: setTextSize },
};

export const FONT_FAMILY: FieldDescriptor<FontFamily> = {
  read: {
    text: (h) => getFontFamily(h.y),
    note: (h) => getFontFamily(h.y),
    shape: (h) => getFontFamily(h.y),
  },
  write: {
    text: (h, v) => h.y.set('fontFamily', v),
    note: (h, v) => h.y.set('fontFamily', v),
    shape: (h, v) => h.y.set('fontFamily', v),
  },
  accepts: { shape: (h) => hasLabel(h.y) },
  persist: {
    text: setTextFontFamily,
    shape: setTextFontFamily,
    note: setNoteFontFamily,
  },
};

export const TEXT_ALIGN: FieldDescriptor<TextAlign> = {
  read: {
    text: (h) => getAlign(h.y),
    note: (h) => getAlign(h.y, 'center'),
    shape: (h) => getAlign(h.y, 'center'),
  },
  write: {
    // Text origin shifts with align — recompute to preserve left edge. Multi-set
    // inside the open transact (atomic). `frame[0]` IS the cached left edge
    // because the cache was built with the old align.
    text: (h, v) => {
      const oldAlign = getAlign(h.y);
      if (oldAlign !== v) {
        const origin = getOrigin(h.y);
        const frame = getTextFrame(h.id);
        if (origin && frame) {
          const newOriginX = frame[0] + frame[2] * anchorFactor(v);
          h.y.set('origin', [newOriginX, origin[1]]);
        }
      }
      h.y.set('align', v);
    },
    note: (h, v) => h.y.set('align', v),
    shape: (h, v) => h.y.set('align', v),
  },
  accepts: { shape: (h) => hasLabel(h.y) },
  persist: { text: setTextAlign, note: setNoteAlign, shape: setShapeAlign },
};

export const TEXT_ALIGN_V: FieldDescriptor<TextAlignV> = {
  read: {
    note: (h) => getAlignV(h.y),
    shape: (h) => getAlignV(h.y),
  },
  write: {
    note: (h, v) => h.y.set('alignV', v),
    shape: (h, v) => h.y.set('alignV', v),
  },
  accepts: { shape: (h) => hasLabel(h.y) },
  persist: { note: setNoteAlignV, shape: setShapeAlignV },
};

// Inline-format trio. Reads from text-system cache (`getInlineStyles`); writes
// walk Y.XmlFragment via `formatFragment`. Asymmetric read/write is intentional —
// matches `computeUniformInlineStyles`. Editor fast-path lives at the action layer
// (`withEditorOr`), never inside the writer.
export const BOLD: FieldDescriptor<boolean> = {
  read: {
    text: (h) => getInlineStyles(h.id)?.allBold,
    note: (h) => getInlineStyles(h.id)?.allBold,
    shape: (h) => getInlineStyles(h.id)?.allBold,
  },
  write: {
    text: (h, v) => setBoldOnContent(h, v),
    note: (h, v) => setBoldOnContent(h, v),
    shape: (h, v) => setBoldOnContent(h, v),
  },
  accepts: { shape: (h) => hasLabel(h.y) },
};

export const ITALIC: FieldDescriptor<boolean> = {
  read: {
    text: (h) => getInlineStyles(h.id)?.allItalic,
    note: (h) => getInlineStyles(h.id)?.allItalic,
    shape: (h) => getInlineStyles(h.id)?.allItalic,
  },
  write: {
    text: (h, v) => setItalicOnContent(h, v),
    note: (h, v) => setItalicOnContent(h, v),
    shape: (h, v) => setItalicOnContent(h, v),
  },
  accepts: { shape: (h) => hasLabel(h.y) },
};

export const HIGHLIGHT: FieldDescriptor<string | null> = {
  read: {
    text: (h) => getInlineStyles(h.id)?.uniformHighlight,
    note: (h) => getInlineStyles(h.id)?.uniformHighlight,
    shape: (h) => getInlineStyles(h.id)?.uniformHighlight,
  },
  write: {
    text: (h, v) => setHighlightOnContent(h, v),
    note: (h, v) => setHighlightOnContent(h, v),
    shape: (h, v) => setHighlightOnContent(h, v),
  },
  accepts: { shape: (h) => hasLabel(h.y) },
};

export const CODE_LANGUAGE: FieldDescriptor<CodeLanguage> = {
  read: { code: (h) => getLanguage(h.y) },
  write: { code: (h, v) => h.y.set('language', v) },
};

// Multi-set: fontSize change proportionally scales width. Atomic inside the
// transact opened by applyField. Mirrors transform.ts's commitTextScale pattern.
export const CODE_FONT_SIZE: FieldDescriptor<number> = {
  read: { code: (h) => Math.round(getFontSize(h.y, 14)) },
  write: {
    code: (h, v) => {
      const oldFs = getFontSize(h.y, 14);
      const oldW = (h.y.get('width') as number) ?? 570;
      h.y.set('fontSize', v);
      h.y.set('width', Math.round(oldW * (v / oldFs)));
    },
  },
};

export const LINE_NUMBERS: FieldDescriptor<boolean> = {
  read: { code: (h) => getLineNumbers(h.y) },
  write: { code: (h, v) => h.y.set('lineNumbers', v) },
  persist: { code: setCodeLineNumbers },
};

export const HEADER_VISIBLE: FieldDescriptor<boolean> = {
  read: { code: (h) => getHeaderVisible(h.y) },
  write: { code: (h, v) => h.y.set('headerVisible', v) },
  persist: { code: setCodeHeaderVisible },
};

export const OUTPUT_VISIBLE: FieldDescriptor<boolean> = {
  read: { code: (h) => getOutputVisible(h.y) },
  write: { code: (h, v) => h.y.set('outputVisible', v) },
};
