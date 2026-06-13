/**
 * Cross-kind conversion: text ↔ note ↔ shape — in place, same Y.Map / same id.
 *
 * Each action is one `transact()` over per-object plans built in a PRE-READ
 * phase (cold path; reads caches + Y.Map before any write). Everything
 * downstream — `handle.kind` mirror, cache eviction/repopulation, selection
 * recompute, editor re-skin — is driven by the deep observer's kind-keychange
 * branch, so local clicks, remote peers, and undo/redo all flow one path.
 *
 * Geometry goals per direction (see builders): center-preserving placement,
 * glyph-preserving sizing (text↔note world glyph size unchanged), and
 * zero-rewrap frame inversion (text↔shape label lands pixel-true).
 */

import * as Y from 'yjs';
import { FILL_PALETTE, NO_FILL } from '@/components/context-menu/color-palette';
import type { FontFamily, TextAlign, TextWidth } from '@/core/accessors';
import {
  getAlignV,
  getColor,
  getContent,
  getFillColor,
  getFontFamily,
  getFontSize,
  getFrame,
  getNoteProps,
  getShapeType,
  hasLabel,
} from '@/core/accessors';
import { round3 } from '@/core/geometry/scale-system';
import { FONT_FAMILIES } from '@/core/text/font-config';
import { computeLabelTextBox, LABEL_PADDING } from '@/core/text/shape-label';
import {
  getNoteContentWidth,
  getNoteDerivedFontSize,
  getNoteLayout,
  getNotePadding,
  getStickyNoteTextColor,
  NOTE_WIDTH,
} from '@/core/text/sticky-note';
import { getBaselineToTopRatio } from '@/core/text/text-measure';
import { anchorFactor, getNoteContentOffsetY, getTextFrame, textLayoutCache } from '@/core/text/text-system';
import type { ObjectHandle } from '@/core/types/objects';
import { renormalizeAttachedAnchors, transact } from '@/runtime/room-runtime';
import { NOTE_COLOR_PALETTE, useDeviceUIStore } from '@/stores/device-ui-store';
import { useSelectionStore } from '@/stores/selection-store';
import { nearestPaletteColor } from '@/utils/color';
import { clamp } from '@/utils/math';
import { collectHandles } from './selection-field-table';

const CONVERT_NOTE_SCALE_MIN = 0.2;
const CONVERT_NOTE_SCALE_MAX = 6;
const CONVERT_EMPTY_SHAPE_SIDE = 100;

// ============================================================================
// FILL MAPPING — palette members swap to the nearest target-palette color;
// custom hex carries as-is.
// ============================================================================

const NOTE_FILLS: readonly string[] = NOTE_COLOR_PALETTE.map((c) => c.fill);
const SHAPE_TEXT_FILLS: readonly string[] = FILL_PALETTE.filter((c) => c !== NO_FILL);

const mapFillToNote = (fill: string): string => (SHAPE_TEXT_FILLS.includes(fill) ? nearestPaletteColor(fill, NOTE_FILLS) : fill);

const mapFillToShapeText = (fill: string): string => (NOTE_FILLS.includes(fill) ? nearestPaletteColor(fill, SHAPE_TEXT_FILLS) : fill);

// ============================================================================
// PLAN — per-object schema remap, applied atomically in commitPlans
// ============================================================================

interface ConversionPlan {
  readonly id: string;
  readonly y: Y.Map<unknown>;
  readonly sets: readonly [key: string, value: unknown][];
  readonly deletes: readonly string[];
  /** Create a fresh Y.XmlFragment 'content' inside the transact (unlabeled shape source). */
  readonly createContent: boolean;
  /** Effective outlines for connector-anchor renormalization (identity-skipping). */
  readonly fromEff: string;
  readonly toEff: string;
}

/** True when no paragraph carries any text (same walk as formatFragment). */
function fragmentIsEmpty(frag: Y.XmlFragment): boolean {
  let empty = true;
  frag.forEach((para) => {
    if (!(para instanceof Y.XmlElement)) return;
    para.forEach((child) => {
      if (child instanceof Y.XmlText && child.length > 0) empty = false;
    });
  });
  return empty;
}

// ============================================================================
// DIRECTION BUILDERS — pre-read only, no writes
// ============================================================================

/** Glyph-preserving: scale = fontSize / noteDerivedFontSize, centered on the old text frame. */
function planTextToNote(h: ObjectHandle): ConversionPlan | null {
  const content = getContent(h.y);
  const frame = getTextFrame(h.id);
  if (!content || !frame) return null;
  // Copy frame scalars BEFORE getNoteLayout — it overwrites this id's cache
  // entry (frame nulled, measured/layout re-run at note base dims).
  const cx = frame[0] + frame[2] / 2;
  const cy = frame[1] + frame[3] / 2;
  const fontSize = getFontSize(h.y);
  const textFill = getFillColor(h.y);

  let scale = 1;
  if (!fragmentIsEmpty(content)) {
    getNoteLayout(h.id, content, getFontFamily(h.y));
    scale = round3(clamp(fontSize / getNoteDerivedFontSize(h.id), CONVERT_NOTE_SCALE_MIN, CONVERT_NOTE_SCALE_MAX));
  }
  const side = NOTE_WIDTH * scale;

  return {
    id: h.id,
    y: h.y,
    sets: [
      ['origin', [cx - side / 2, cy - side / 2]],
      ['scale', scale],
      ['alignV', 'middle'],
      ['fillColor', textFill ? mapFillToNote(textFill) : useDeviceUIStore.getState().note.fillColor],
    ],
    deletes: ['fontSize', 'color', 'width'],
    createContent: false,
    fromEff: 'rect',
    toEff: 'rect',
  };
}

/** Baseline-preserving inverse of the note's canvas draw: first line doesn't move. */
function planNoteToText(h: ObjectHandle): ConversionPlan | null {
  const props = getNoteProps(h.y);
  if (!props) return null;
  const { content, origin, scale, fontFamily, align, alignV, fillColor } = props;

  const padding = getNotePadding(scale);
  const contentWidth = getNoteContentWidth(scale); // unrounded — wrap parity with the note's base-dim flow
  // Empty note: nothing to glyph-preserve (the derived 54 is the empty-note
  // auto-size, not a user choice) — device-preferred size, and the alignV
  // offset anchors one prospective line where typing would land. The result is
  // a fixed-width text body the size of the note's content box; deliberate
  // user action, even when it renders as just a fill strip (or nothing).
  let fontSize: number;
  let contentH: number;
  if (fragmentIsEmpty(content)) {
    fontSize = useDeviceUIStore.getState().text.size;
    contentH = fontSize * FONT_FAMILIES[fontFamily].lineHeightMultiplier;
  } else {
    const layout = textLayoutCache.noteCachedLayout(h.id);
    fontSize = round3(getNoteDerivedFontSize(h.id) * scale);
    contentH = (layout ? layout.lineCount * layout.lineHeight : 0) * scale;
  }
  // Overflowing content top-pins (offset 0) — matches the canvas draw exactly.
  const frameY = origin[1] + padding + getNoteContentOffsetY(alignV, contentWidth, contentH);

  return {
    id: h.id,
    y: h.y,
    sets: [
      ['fontSize', fontSize],
      ['width', contentWidth],
      ['color', getStickyNoteTextColor(fillColor)],
      ['fillColor', mapFillToShapeText(fillColor)],
      // align set explicitly — note defaults 'center', text defaults 'left';
      // the origin anchor below bakes in the note's effective value.
      ['align', align],
      ['origin', [origin[0] + padding + anchorFactor(align) * contentWidth, frameY + fontSize * getBaselineToTopRatio(fontFamily)]],
    ],
    deletes: ['scale', 'alignV'],
    createContent: false,
    fromEff: 'rect',
    toEff: 'rect',
  };
}

/** Body-preserving: side = clamp(√(fw·fh)), centered on the old shape frame. */
function planShapeToNote(h: ObjectHandle): ConversionPlan | null {
  const frame = getFrame(h.y);
  if (!frame) return null;
  const [fx, fy, fw, fh] = frame;
  const scale = round3(clamp(Math.sqrt(fw * fh), NOTE_WIDTH * CONVERT_NOTE_SCALE_MIN, NOTE_WIDTH * CONVERT_NOTE_SCALE_MAX) / NOTE_WIDTH);
  const side = NOTE_WIDTH * scale;
  const ui = useDeviceUIStore.getState();
  const shapeFill = getFillColor(h.y);
  const labeled = hasLabel(h.y);

  const sets: [string, unknown][] = [
    ['origin', [fx + fw / 2 - side / 2, fy + fh / 2 - side / 2]],
    ['scale', scale],
    ['fillColor', shapeFill ? mapFillToNote(shapeFill) : ui.note.fillColor],
  ];
  const deletes = ['shapeType', 'frame', 'color', 'width', 'opacity'];
  if (labeled) {
    deletes.push('fontSize', 'labelColor'); // keep content / fontFamily / align / alignV
  } else {
    sets.push(['fontFamily', ui.note.fontFamily], ['align', ui.note.align], ['alignV', ui.note.alignV]);
  }

  return { id: h.id, y: h.y, sets, deletes, createContent: !labeled, fromEff: getShapeType(h.y), toEff: 'rect' };
}

/** Note body becomes the shape frame verbatim; always filled → borderless. */
function planNoteToShape(h: ObjectHandle, shapeType: string, editingId: string | null): ConversionPlan | null {
  const props = getNoteProps(h.y);
  if (!props) return null;
  const { content, origin, scale, fillColor } = props;
  const side = NOTE_WIDTH * scale;
  const mappedFill = mapFillToShapeText(fillColor);
  // Editing carve-out: deleting a fragment the Tiptap editor is bound to
  // orphans typing — keep it; commitAndClose's empty-label branch cleans up.
  const keepLabel = !fragmentIsEmpty(content) || editingId === h.id;

  const sets: [string, unknown][] = [
    ['frame', [origin[0], origin[1], side, side]],
    ['shapeType', shapeType],
    ['fillColor', mappedFill],
    // Always filled → borderless (no 'color' key); width seeds a later border pick.
    ['width', useDeviceUIStore.getState().shape.width],
  ];
  const deletes = ['origin', 'scale'];
  if (keepLabel) {
    sets.push(['fontSize', round3(getNoteDerivedFontSize(h.id) * scale)], ['labelColor', getStickyNoteTextColor(mappedFill)]);
    // keep content / fontFamily / align / alignV
  } else {
    deletes.push('content', 'fontFamily', 'align', 'alignV');
  }

  return { id: h.id, y: h.y, sets, deletes, createContent: false, fromEff: 'rect', toEff: shapeType };
}

/**
 * Zero-rewrap frame inversion: pick the shape frame whose
 * `computeLabelTextBox(t, frame)` reproduces the old text frame exactly, so
 * the label (laid out at the same fixed width) lands pixel-true with
 * `alignV:'middle'`.
 */
function planTextToShape(h: ObjectHandle, shapeType: string): ConversionPlan | null {
  const content = getContent(h.y);
  const frame = getTextFrame(h.id);
  if (!content || !frame) return null;
  const [tx, ty, tw, th] = frame;
  const tcx = tx + tw / 2;
  const tcy = ty + th / 2;
  const pad2 = 2 * LABEL_PADDING;
  const ui = useDeviceUIStore.getState();
  const textFill = getFillColor(h.y);

  let fx: number, fy: number, fw: number, fh: number;
  if (fragmentIsEmpty(content)) {
    // Only reachable while editing (empty non-editing text is deleted on close).
    fw = fh = CONVERT_EMPTY_SHAPE_SIDE;
    fx = tcx - fw / 2;
    fy = tcy - fh / 2;
  } else {
    switch (shapeType) {
      case 'ellipse':
        fw = (tw + pad2) * Math.SQRT2;
        fh = (th + pad2) * Math.SQRT2;
        fx = tcx - fw / 2;
        fy = tcy - fh / 2;
        break;
      case 'diamond':
        fw = 2 * (tw + pad2);
        fh = 2 * (th + pad2);
        fx = tcx - fw / 2;
        fy = tcy - fh / 2;
        break;
      case 'triangle':
        // Label box sits in the lower half — frame extends fh/2 above the text top.
        fw = 2 * (tw + pad2);
        fh = 2 * (th + pad2);
        fx = tcx - fw / 2;
        fy = ty - LABEL_PADDING - fh / 2;
        break;
      default: // rect / roundedRect
        fw = tw + pad2;
        fh = th + pad2;
        fx = tx - LABEL_PADDING;
        fy = ty - LABEL_PADDING;
    }
  }

  const sets: [string, unknown][] = [
    ['frame', [fx, fy, fw, fh]],
    ['shapeType', shapeType],
    ['labelColor', getColor(h.y, '#262626')],
    ['width', ui.shape.width],
    ['alignV', 'middle'],
  ];
  const deletes = ['origin'];
  // Filled → borderless; fill-less text gets the device-default border so the
  // shape is never invisible. fillColor carries untouched (shared palette).
  if (textFill) deletes.push('color');
  else sets.push(['color', ui.shape.color]);

  return { id: h.id, y: h.y, sets, deletes, createContent: false, fromEff: 'rect', toEff: shapeType };
}

/** Label text box becomes the text frame; baseline/anchor reproduce renderShapeLabel. */
function planShapeToText(h: ObjectHandle): ConversionPlan | null {
  const frame = getFrame(h.y);
  if (!frame) return null;
  const shapeType = getShapeType(h.y);
  const tb = computeLabelTextBox(shapeType, frame);
  // Module-shared scratch — copy the four slots immediately.
  const tbx = tb[0];
  const tby = tb[1];
  const tbw = tb[2];
  const tbh = tb[3];

  const ui = useDeviceUIStore.getState();
  const labeled = hasLabel(h.y);
  const content = labeled ? getContent(h.y) : null;
  const fontSize = (h.y.get('fontSize') as number | undefined) ?? ui.text.size;
  const fontFamily = (h.y.get('fontFamily') as FontFamily | undefined) ?? ui.text.fontFamily;
  const align = (h.y.get('align') as TextAlign | undefined) ?? ui.text.align;
  const nonEmpty = content !== null && !fragmentIsEmpty(content);
  // Text-box basis: a non-empty label keeps the label box (zero-rewrap — the
  // label was laid out at exactly tbw); an empty source spans the shape frame
  // itself — the inscribed label box is tiny on non-rect shapes, and users
  // expect the converted text to keep the shape's overall width.
  const useLabelBox = nonEmpty && tbw > 0;
  const bx = useLabelBox ? tbx : frame[0];
  const by = useLabelBox ? tby : frame[1];
  const bw = useLabelBox ? tbw : frame[2];
  const bh = useLabelBox ? tbh : frame[3];
  const width: TextWidth = bw > 0 ? bw : 'auto';

  // First-baseline parity with renderShapeLabel: clipped content top-pins
  // (offset 0 either way), otherwise the alignV offset applies. Empty sources
  // anchor one prospective line per alignV within the old shape body.
  let contentH = fontSize * FONT_FAMILIES[fontFamily].lineHeightMultiplier;
  if (content && useLabelBox) {
    const layout = textLayoutCache.getLayout(h.id, content, fontSize, fontFamily, tbw);
    contentH = layout.lineCount * layout.lineHeight;
  }
  const vOff = getNoteContentOffsetY(getAlignV(h.y), bh, contentH);

  return {
    id: h.id,
    y: h.y,
    sets: [
      ['origin', [bx + anchorFactor(align) * bw, by + vOff + fontSize * getBaselineToTopRatio(fontFamily)]],
      ['fontSize', fontSize],
      ['fontFamily', fontFamily],
      ['align', align],
      ['color', (h.y.get('labelColor') as string | undefined) ?? ui.text.color],
      ['width', width],
    ],
    deletes: ['shapeType', 'frame', 'opacity', 'labelColor', 'alignV'],
    createContent: !labeled,
    fromEff: shapeType,
    toEff: 'rect',
  };
}

// ============================================================================
// PUBLIC API
// ============================================================================

export function convertObjectsTo(ids: readonly string[], target: 'text' | 'note'): void {
  const plans: ConversionPlan[] = [];
  for (const h of collectHandles(ids)) {
    if (h.kind === target) continue;
    let plan: ConversionPlan | null = null;
    if (target === 'note') {
      if (h.kind === 'text') plan = planTextToNote(h);
      else if (h.kind === 'shape') plan = planShapeToNote(h);
    } else {
      if (h.kind === 'note') plan = planNoteToText(h);
      else if (h.kind === 'shape') plan = planShapeToText(h);
    }
    if (plan) plans.push(plan);
  }
  commitPlans(plans, target);
}

export function convertObjectsToShape(ids: readonly string[], shapeType: string): void {
  // shape→shape never reaches here — the dropdown routes it to setSelectedShapeType.
  const editingId = useSelectionStore.getState().textEditingId;
  const plans: ConversionPlan[] = [];
  for (const h of collectHandles(ids)) {
    let plan: ConversionPlan | null = null;
    if (h.kind === 'text') plan = planTextToShape(h, shapeType);
    else if (h.kind === 'note') plan = planNoteToShape(h, shapeType, editingId);
    if (plan) plans.push(plan);
  }
  commitPlans(plans, 'shape');
}

function commitPlans(plans: readonly ConversionPlan[], targetKind: 'text' | 'note' | 'shape'): void {
  if (plans.length === 0) return;
  transact(() => {
    for (const p of plans) {
      if (p.createContent) p.y.set('content', new Y.XmlFragment());
      for (const key of p.deletes) p.y.delete(key);
      for (const s of p.sets) p.y.set(s[0], s[1]);
      // kind LAST — the new schema is complete the instant it flips.
      p.y.set('kind', targetKind);
      renormalizeAttachedAnchors(p.id, p.fromEff, p.toEff);
    }
  });
  // Post-transact: nothing. The observer's kind branch + selection bridge
  // recompute selection/styles/menu synchronously inside the transact dispatch.
}
