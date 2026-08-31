import { getLabelColor } from '@/core/accessors';
import { drawBookmark } from '@/core/bookmark/bookmark-render';
import { type CodeLayout, codeSystem, renderCodeLayout } from '@/core/code/code-system';
import { getConnectorLabelRect, labelOriginYFor } from '@/core/connectors/connector-label';
import { getConnectorRoute } from '@/core/connectors/connector-router';
import { bboxesIntersect } from '@/core/geometry/hit-primitives';
import { getImageMeta } from '@/core/image/image-cache';
import { getBitmap } from '@/core/image/image-manager';
import { getBBoxColumn, getHandlesBySlot, getKindCodes } from '@/core/slots/slot-table';
import { spatialTree } from '@/core/spatial/spatial-tree';
import { computeLabelTextBox, renderShapeLabelPreview, renderShapeLabelSlot } from '@/core/text/shape-label';
import { drawStickyNote } from '@/core/text/sticky-note';
import { renderTextLayout, renderTextLayoutById, type TextLayout, textLayoutCache } from '@/core/text/text-system';
import type { BBoxTuple, FrameTuple, Point } from '@/core/types/geometry';
import { K_BOOKMARK, K_CODE, K_CONNECTOR, K_IMAGE, K_NOTE, K_SHAPE, K_STROKE, K_TEXT, type ObjectHandle } from '@/core/types/objects';
import { getZOrder } from '@/runtime/room-runtime';
import { selectTool } from '@/runtime/tool-registry';
import { getVisibleBoundsTuple } from '@/stores/camera-store';
import { useSelectionStore } from '@/stores/selection-store';
import type { ConnectorEntry, EndpointDragEntry } from '@/tools/selection/connector-topology';
import {
  getEndpointDragEntry,
  getGestureLanes,
  getGestureMeta,
  getGestureSlotMap,
  getInjectSlotCount,
  getInjectSlots,
  getReflowLayout,
  getTopoEntries,
  getTransformModeCode,
  getTranslateDX,
  getTranslateDY,
} from '@/tools/selection/transform';
import {
  EPDRAG_TAG,
  G_STRIDE,
  GIDX_MASK,
  META_KIND_MASK,
  META_OP_MASK,
  META_OP_SHIFT,
  OP_FRAME_EDGES,
  OP_FRAME_UNIFORM,
  OP_OFFSET,
  OP_ORIGIN_UNIFORM,
  OP_REFLOW_CODE,
  OP_REFLOW_TEXT,
  OP_STROKE_UNIFORM,
  TOPO_TAG,
} from '@/tools/selection/transform-kernels';
import { sortU32Range } from '@/utils/sort-u32';
import { getConnectorPaths, getPath } from '../geometry-cache';
import {
  readCodeRender,
  readConnectorBaseRender,
  readConnectorRender,
  readImageOpacity,
  readShapeLabelRender,
  readShapeLabelRenderNoFrame,
  readShapeRender,
  readStrokeRender,
  readTextRender,
} from '../render-accessors';
import { paintConnector, paintConnectorFromPoints } from './connector-render-atoms';
import { paintShapeFrame } from './shape-preview';

// Module-scope scratches. Reused across frames — zero allocation on the hot path.
const _candidateHandles: ObjectHandle[] = [];
let _candRanks = new Uint32Array(256);
const _previewScratch: BBoxTuple = [0, 0, 0, 0];
const _frameScratch: FrameTuple = [0, 0, 0, 0];

/** Pow2-grow `_candRanks` to hold `count` packed ranks. MUST run before the pack
 *  loops — Uint32Array out-of-bounds stores are silent no-ops. */
function ensureCandCapacity(count: number): void {
  if (count <= _candRanks.length) return;
  let cap = _candRanks.length;
  while (cap < count) cap *= 2;
  _candRanks = new Uint32Array(cap);
}

// Per-frame editing-id snapshot, written once at the top of `drawObjects` and
// read by leaf `draw*` functions. Avoids one `useSelectionStore.getState()`
// per relevant object per frame.
let _textEditingId: string | null = null;
let _codeEditingId: string | null = null;
// Per-frame bookmark Open-button hover id. Hoisted once at frame top from
// SelectTool's singleton field; leaf bookmark dispatch reads as identity
// compare (interned-string equality when set, cheap-false when null).
let _hoveredOpenBookmarkId: string | null = null;
// Per-frame slot-column snapshots (live refs — refetched each frame): kind
// codes drive `drawObject`'s int jump table; the bbox column feeds the
// image draw rect. Gesture lanes/meta feed `renderScaleEntryLanes`.
let _kindCodes: Uint8Array = new Uint8Array(0);
let _colFrame: Float64Array = new Float64Array(0);
let _tlanes: Float64Array = new Float64Array(0);
let _tmeta: Uint32Array = new Uint32Array(0);

export function drawObjects(ctx: CanvasRenderingContext2D, clipBuf: Float64Array | null, clipCount: number): void {
  const sel = useSelectionStore.getState();

  // Hoist editing IDs ONCE per frame — leaf draw fns read these instead of
  // polling `useSelectionStore.getState()` per object.
  _textEditingId = sel.textEditingId;
  _codeEditingId = sel.codeEditingId;
  _hoveredOpenBookmarkId = selectTool.getHoveredOpenBookmarkId();

  // Transform state comes from the gesture engine's module state — the store
  // discriminant is React/overlay-only. `sg` routes every gestured slot
  // (gesture entry / topology entry / endpoint drag) in one load + sign test.
  const tmode = getTransformModeCode();
  const transforming = tmode !== 0;
  const sg = getGestureSlotMap();
  _tlanes = getGestureLanes();
  _tmeta = getGestureMeta();
  const topoEntries = getTopoEntries();
  const epEntry = getEndpointDragEntry();
  const tdx = getTranslateDX();
  const tdy = getTranslateDY();
  _kindCodes = getKindCodes();

  // Hoists BEFORE the query — rank state, reverse map, bbox column.
  // (Legal: nothing between here and the pack mutates rank state or slots.)
  const zOrder = getZOrder();
  zOrder.ensureRanksValid();
  const ranks = zOrder.getRanks();
  const slotsByRank = zOrder.getSlotsByRank();
  const bySlot = getHandlesBySlot();
  const col = getBBoxColumn();
  _colFrame = col;
  const injectCount = transforming ? getInjectSlotCount() : 0;

  const viewport = getVisibleBoundsTuple();
  const n = spatialTree.query(viewport[0], viewport[1], viewport[2], viewport[3]);
  const res = spatialTree.results; // fetched AFTER the query — growth swaps the buffer

  // Pre-size BEFORE packing — Uint32Array OOB stores are SILENT no-ops, and
  // injected candidates pack past the query count (bound = n + injectCount).
  ensureCandCapacity(n + injectCount);

  const hasClip = clipBuf !== null && clipCount > 0;
  const cbuf = clipBuf; // narrowed local — avoids repeated NNA inside hot loop

  // Main pack loop: viewport slots → ranks, clip-filtered on the raw bbox column.
  // A steady non-transform frame touches zero handle objects pre-sort; even
  // mid-gesture the skip is one sparse-map load + sign test (no handle
  // recovery, no string-Set probes). Gestured slots are re-packed below via
  // their preview bbox.
  let k = 0;
  for (let i = 0; i < n; i++) {
    const slot = res[i];
    if (transforming && sg[slot] >= 0) continue;

    if (hasClip && cbuf !== null) {
      const s4 = slot * 4; // slot * 4, never << 2
      let hit = false;
      for (let ci = 0; ci < clipCount; ci++) {
        const off = ci * 4;
        if (col[s4] <= cbuf[off + 2] && col[s4 + 2] >= cbuf[off] && col[s4 + 1] <= cbuf[off + 3] && col[s4 + 3] >= cbuf[off + 1]) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;
    }
    _candRanks[k++] = ranks[slot];
  }

  // Slot-keyed inject cull — packs preview-bbox-visible inject ranks past k.
  if (transforming) {
    k = cullInjectedSlots(getInjectSlots(), injectCount, viewport, tmode, sg, _tlanes, col, topoEntries, epEntry, tdx, tdy, ranks, k);
  }

  // Sort by fractional z-key rank (bottom -> top), comparator-free: the packed
  // u32 ranks sort in place, then the candidate list rebuilds through the
  // rank→slot inverse permutation. Ranks are unique (a permutation), so the
  // total order is identical to a comparator sort. Rank table is dirty-flag-
  // guarded; clean frames early-out in one compare. Main loop excludes
  // gestured slots and the cull's tag validation excludes evicted ones — no
  // post-sort dedupe.
  sortU32Range(_candRanks, 0, k);
  for (let i = 0; i < k; i++) _candidateHandles[i] = bySlot[slotsByRank[_candRanks[i]]]!;
  // MANDATORY truncation — indexed fills don't shrink length; without this the
  // paint loop draws stale handles from prior frames (incl. deleted objects)
  // and roots deleted Y.Maps.
  _candidateHandles.length = k;

  for (let i = 0; i < _candidateHandles.length; i++) {
    const handle = _candidateHandles[i];

    // Paint routing: one sparse-map load resolves the entire gesture dispatch —
    // topology connector / endpoint drag / translate / scale-preview. Background
    // objects (and everything when idle) flow to the plain draw.
    if (transforming) {
      const g = sg[handle.slot];
      if (g >= 0) {
        if (g & TOPO_TAG) drawConnectorEntry(ctx, handle, topoEntries![g & GIDX_MASK], tdx, tdy);
        else if (g & EPDRAG_TAG) drawConnectorEntry(ctx, handle, epEntry!, tdx, tdy);
        else if (tmode === 2) {
          ctx.save();
          ctx.translate(tdx, tdy);
          drawObject(ctx, handle);
          ctx.restore();
        } else renderScaleEntryLanes(ctx, handle, g);
        continue;
      }
    }
    drawObject(ctx, handle);
  }
}

/**
 * Connector dispatch under active transform. Static / translate / reroute —
 * handles every gesture mode uniformly. `tdx`/`tdy` are the hoisted translate
 * delta (zero when not translating); the `translate` case is the only consumer.
 */
function drawConnectorEntry(ctx: CanvasRenderingContext2D, handle: ObjectHandle, ce: ConnectorEntry, tdx: number, tdy: number): void {
  switch (ce.mode) {
    case 'static':
      drawConnector(ctx, handle);
      return;
    case 'translate':
      ctx.save();
      ctx.translate(tdx, tdy);
      drawConnector(ctx, handle);
      ctx.restore();
      return;
    case 'reroute':
      if (ce.validCount > 0) drawConnectorFromPoints(ctx, handle, ce.pointsBuf, ce.validCount);
      else drawConnector(ctx, handle);
      return;
  }
}

/**
 * Slot-keyed inject cull. Each inject slot is RE-VALIDATED against the sparse
 * gesture map — a tag mismatch (g < 0) means the slot was evicted mid-gesture
 * (delete / kind conversion), which both prevents recycled-slot aliasing and
 * guarantees no double-pack against the main loop. Zero Map/handle lookups:
 * topology + epDrag rects come off their entries, translate rects off the
 * LIVE column + delta (translate paint draws live geometry offset by d, so
 * the cull must track the live rect), scale rects off the out-bbox lanes
 * (paint is frozen-derived preview — consistent both ways).
 *
 * Packs each visible inject's rank into `_candRanks[k++]` (capacity pre-sized
 * by the caller) and returns the new cursor.
 */
function cullInjectedSlots(
  injectSlots: Uint32Array,
  injectCount: number,
  vp: Readonly<BBoxTuple>,
  tmode: number,
  sg: Int32Array,
  tlanes: Float64Array,
  col: Float64Array,
  topoEntries: readonly ConnectorEntry[] | null,
  epEntry: EndpointDragEntry | null,
  tdx: number,
  tdy: number,
  ranks: Uint32Array,
  k: number,
): number {
  for (let i = 0; i < injectCount; i++) {
    const slot = injectSlots[i];
    const g = sg[slot];
    if (g < 0) continue; // evicted mid-gesture — the object draws canonically via the main loop
    if (g & TOPO_TAG) {
      if (bboxesIntersect(topoEntries![g & GIDX_MASK].currBbox, vp)) _candRanks[k++] = ranks[slot];
      continue;
    }
    if (g & EPDRAG_TAG) {
      if (bboxesIntersect(epEntry!.currBbox, vp)) _candRanks[k++] = ranks[slot];
      continue;
    }
    if (tmode === 2) {
      const s4 = slot * 4;
      _previewScratch[0] = col[s4] + tdx;
      _previewScratch[1] = col[s4 + 1] + tdy;
      _previewScratch[2] = col[s4 + 2] + tdx;
      _previewScratch[3] = col[s4 + 3] + tdy;
    } else {
      const b = g * G_STRIDE;
      _previewScratch[0] = tlanes[b + 8];
      _previewScratch[1] = tlanes[b + 9];
      _previewScratch[2] = tlanes[b + 10];
      _previewScratch[3] = tlanes[b + 11];
    }
    if (bboxesIntersect(_previewScratch, vp)) _candRanks[k++] = ranks[slot];
  }
  return k;
}

function drawObject(ctx: CanvasRenderingContext2D, handle: ObjectHandle): void {
  // Int jump table off the slot kind column — no string dispatch.
  switch (_kindCodes[handle.slot]) {
    case K_STROKE:
      drawStroke(ctx, handle);
      break;
    case K_SHAPE:
      drawShape(ctx, handle);
      break;
    case K_TEXT:
      drawText(ctx, handle);
      break;
    case K_CONNECTOR:
      drawConnector(ctx, handle);
      break;
    case K_CODE:
      drawCode(ctx, handle);
      break;
    case K_IMAGE: {
      const o4 = handle.slot * 4;
      const col = _colFrame;
      drawImage(ctx, handle, col[o4], col[o4 + 1], col[o4 + 2] - col[o4], col[o4 + 3] - col[o4 + 1]);
      break;
    }
    case K_NOTE:
      drawStickyNote(ctx, handle, _textEditingId === handle.id);
      break;
    case K_BOOKMARK:
      drawBookmark(ctx, handle, _hoveredOpenBookmarkId === handle.id);
      break;
  }
}

function drawStroke(ctx: CanvasRenderingContext2D, handle: ObjectHandle): void {
  const r = readStrokeRender(handle.y);
  const path = getPath(handle.id, handle);

  ctx.save();
  ctx.globalAlpha = r.opacity;

  // STROKES ARE ALWAYS FILLED POLYGONS
  ctx.fillStyle = r.color;
  if (r.tool === 'highlighter') {
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.fill(path);

  ctx.restore();
}

function drawShape(ctx: CanvasRenderingContext2D, handle: ObjectHandle): void {
  const r = readShapeRender(handle.y);
  const path = getPath(handle.id, handle);

  ctx.save();
  ctx.globalAlpha = r.opacity;

  if (r.fillColor) {
    ctx.fillStyle = r.fillColor;
    ctx.fill(path);
  }

  if (r.color && r.width > 0) {
    ctx.strokeStyle = r.color;
    ctx.lineWidth = r.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  }

  // Single content read inside readShapeLabelRender — null when shape has no label.
  drawShapeLabel(ctx, handle);

  ctx.restore();
}

function drawShapeLabel(ctx: CanvasRenderingContext2D, handle: ObjectHandle): void {
  if (_textEditingId === handle.id) return;
  const r = readShapeLabelRender(handle.y);
  if (!r) return;
  const textBox = computeLabelTextBox(r.shapeType, r.frame);
  if (textBox[2] <= 0 || textBox[3] <= 0) return;
  // getLayout refreshes the entry for the current fontSize/family/width
  // (comparison staleness) and hands back its slot for the pooled-lane draw.
  const sc = textLayoutCache.getLayout(handle.id, r.content, r.fontSize, r.fontFamily, textBox[2]);
  renderShapeLabelSlot(ctx, sc.slot, textBox, r.labelColor, r.align, r.alignV);
}

function drawShapeLabelWithFrame(ctx: CanvasRenderingContext2D, handle: ObjectHandle, frame: FrameTuple): void {
  if (_textEditingId === handle.id) return;
  const r = readShapeLabelRenderNoFrame(handle.y);
  if (!r) return;
  const textBox = computeLabelTextBox(r.shapeType, frame);
  renderShapeLabelPreview(ctx, handle.slot, handle.id, r.fontSize, textBox, r.labelColor, r.align, r.alignV);
}

/**
 * Draw text object using Y.XmlFragment-based rich text.
 * Skips rendering if the text is currently being edited (DOM overlay handles it).
 */
function drawText(ctx: CanvasRenderingContext2D, handle: ObjectHandle): void {
  const { id, y } = handle;
  if (_textEditingId === id) return;

  const r = readTextRender(y);
  // Slot-accelerated pooled-lane draw; no-ops on the cold-miss race (observer
  // fills the cache before render).
  renderTextLayoutById(ctx, handle.slot, id, r.originX, r.originY, r.color, r.align, r.fillColor);
}

// Code-block chrome — the spans/source/origin/title/output/outputCache
// derivation shared by the three code draw sites (idle draw, ORIGIN_UNIFORM
// preview, REFLOW preview). Module scratch, filled once per code object per
// frame and consumed immediately by the renderCodeLayout call at the site.
interface CodeChrome {
  spans: NonNullable<ReturnType<typeof codeSystem.getSpans>>;
  source: NonNullable<ReturnType<typeof codeSystem.getSource>>;
  originX: number;
  originY: number;
  fontSize: number;
  title: string | undefined;
  output: string | undefined;
  outputCache: NonNullable<ReturnType<typeof codeSystem.getOutputCache>> | undefined;
}
const _codeChrome: CodeChrome = {
  spans: null as unknown as CodeChrome['spans'],
  source: null as unknown as CodeChrome['source'],
  originX: 0,
  originY: 0,
  fontSize: 0,
  title: undefined,
  output: undefined,
  outputCache: undefined,
};

/** Null when spans/source are missing (cold-miss race — caller bails). */
function fillCodeChrome(handle: ObjectHandle): CodeChrome | null {
  const id = handle.id;
  const spans = codeSystem.getSpans(id);
  const source = codeSystem.getSource(id);
  if (!spans || !source) return null;
  const r = readCodeRender(handle.y);
  const c = _codeChrome;
  c.spans = spans;
  c.source = source;
  c.originX = r.originX;
  c.originY = r.originY;
  c.fontSize = r.fontSize;
  c.title = r.headerVisible ? (r.title ?? 'Untitled') : undefined;
  const output = r.outputVisible ? (r.output ?? '') : undefined;
  c.output = output;
  c.outputCache = output !== undefined ? (codeSystem.getOutputCache(id, output) ?? undefined) : undefined;
  return c;
}

function drawCode(ctx: CanvasRenderingContext2D, handle: ObjectHandle): void {
  // Skip rendering if currently being edited (DOM overlay handles it)
  if (_codeEditingId === handle.id) return;

  const layout = codeSystem.getLayoutById(handle.id);
  if (!layout) return; // cold-miss race — observer fills the cache before render
  const c = fillCodeChrome(handle);
  if (!c) return;
  renderCodeLayout(ctx, layout, c.originX, c.originY, c.fontSize, c.spans, c.source, c.title, c.output, c.outputCache);
}

/**
 * Draw an image at `(x, y, w, h)`. Image bbox === frame — zero stroke padding
 * (`computeBBoxForInto` case 'image'), so the envelope read as `[x, y, w, h]`
 * IS the draw rect; `hit-dispatch.ts` derives the hit-rect the same way.
 * The normal path passes the slot's column rect; the scale preview passes
 * out-bbox lanes — one rect shape, both call sites.
 */
function drawImage(ctx: CanvasRenderingContext2D, handle: ObjectHandle, x: number, y: number, w: number, h: number): void {
  const meta = getImageMeta(handle.id);
  if (!meta) return; // cold-miss race — observer fills the cache before render
  const bitmap = getBitmap(meta.assetId);

  ctx.save();
  ctx.globalAlpha = readImageOpacity(handle.y);
  if (bitmap) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, x, y, w, h);
  } else {
    // Placeholder: light gray rect with subtle border
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#d1d5db';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
  }
  ctx.restore();
}

function drawConnector(ctx: CanvasRenderingContext2D, handle: ObjectHandle): void {
  const r = readConnectorBaseRender(handle.y);
  // Resolve the label rect from the committed route — null for label-less connectors
  // (no clip, no glyph draw). The route is clipped out beneath the rect; caps on top.
  const route = getConnectorRoute(handle.id);
  const labelRect = route ? getConnectorLabelRect(handle.id, route, route.length) : null;
  paintConnector(ctx, getConnectorPaths(handle.id, handle), r.color, r.width, labelRect);
  drawConnectorLabelText(ctx, handle, labelRect);
}

/**
 * Draw a connector from explicit points (rerouted connectors during transforms).
 * `count` is required — `paintConnectorFromPoints` short-circuits on `count < 2`.
 *
 * Hot path: emits straight into ctx (zero Path2D allocation per frame).
 */
function drawConnectorFromPoints(ctx: CanvasRenderingContext2D, handle: ObjectHandle, points: Point[], count: number): void {
  const r = readConnectorRender(handle.y);
  // Recompute the label rect from the live preview points so it tracks the route.
  const labelRect = getConnectorLabelRect(handle.id, points, count);
  paintConnectorFromPoints(ctx, points, count, r.width, r.startCap, r.endCap, r.color, labelRect);
  drawConnectorLabelText(ctx, handle, labelRect);
}

/**
 * Paint the connector's rich-text label — H + V centred on the route-midpoint
 * anchor (centre of `labelRect`) via `renderTextLayout` with `align='center'`.
 * No `fillColor` (transparent background); the polyline was already clipped out
 * beneath the rect by the paint atom. Skipped while editing (DOM overlay owns
 * the glyphs) — but the clip-out still ran, so the route stays cut behind the editor.
 */
function drawConnectorLabelText(ctx: CanvasRenderingContext2D, handle: ObjectHandle, labelRect: BBoxTuple | null): void {
  if (!labelRect || _textEditingId === handle.id) return;
  const sc = textLayoutCache.getLayoutScalarsById(handle.id);
  if (!sc) return;
  const anchorX = (labelRect[0] + labelRect[2]) / 2;
  const anchorY = (labelRect[1] + labelRect[3]) / 2;
  renderTextLayoutById(ctx, handle.slot, handle.id, anchorX, labelOriginYFor(sc, anchorY), getLabelColor(handle.y), 'center');
}

// ============================================================================
// Lane-Based Scale Transform Rendering
// ============================================================================

/**
 * Scale-preview paint for gesture entry `gi` — dispatches on the meta op (int
 * switch), inner kind switch only where an op spans kinds. All geometry comes
 * off the lane buffer; sg membership ⇒ the entry exists (no null probes).
 */
function renderScaleEntryLanes(ctx: CanvasRenderingContext2D, handle: ObjectHandle, gi: number): void {
  const lanes = _tlanes;
  const b = gi * G_STRIDE;
  const m = _tmeta[gi];
  switch ((m >>> META_OP_SHIFT) & META_OP_MASK) {
    case OP_FRAME_UNIFORM:
    case OP_FRAME_EDGES: {
      if ((m & META_KIND_MASK) === K_SHAPE) {
        _frameScratch[0] = lanes[b + 12];
        _frameScratch[1] = lanes[b + 13];
        _frameScratch[2] = lanes[b + 14];
        _frameScratch[3] = lanes[b + 15];
        const r = readShapeRender(handle.y);
        paintShapeFrame(ctx, r.shapeType, _frameScratch, r.fillColor, r.color, r.width, r.opacity);
        drawShapeLabelWithFrame(ctx, handle, _frameScratch);
      } else {
        // image
        drawImage(ctx, handle, lanes[b + 8], lanes[b + 9], lanes[b + 10] - lanes[b + 8], lanes[b + 11] - lanes[b + 9]);
      }
      break;
    }

    case OP_STROKE_UNIFORM: {
      // BBox-based ctx.scale: reuse cached Path2D, no per-frame point mutation.
      const fcx = lanes[b + 12];
      const fcy = lanes[b + 13];
      const factor = lanes[b + 14];
      const ncx = (lanes[b + 8] + lanes[b + 10]) / 2;
      const ncy = (lanes[b + 9] + lanes[b + 11]) / 2;
      const path = getPath(handle.id, handle);
      const r = readStrokeRender(handle.y);
      ctx.save();
      ctx.globalAlpha = r.opacity;
      ctx.fillStyle = r.color;
      if (r.tool === 'highlighter') ctx.globalCompositeOperation = 'source-over';
      ctx.translate(ncx, ncy);
      ctx.scale(factor, factor);
      ctx.translate(-fcx, -fcy);
      ctx.fill(path);
      ctx.restore();
      break;
    }

    case OP_ORIGIN_UNIFORM: {
      switch (m & META_KIND_MASK) {
        case K_TEXT: {
          const ratio = lanes[b + 14] / lanes[b + 6];
          const r = readTextRender(handle.y);
          ctx.save();
          ctx.translate(lanes[b + 12], lanes[b + 13]);
          ctx.scale(ratio, ratio);
          // No-op inside the transform block when the layout is absent —
          // visually identical to the old null-probe break.
          renderTextLayoutById(ctx, handle.slot, handle.id, 0, 0, r.color, r.align, r.fillColor);
          ctx.restore();
          break;
        }
        case K_CODE: {
          const layout = codeSystem.getLayoutById(handle.id);
          if (!layout) break;
          const c = fillCodeChrome(handle);
          if (!c) break;
          const ratio = lanes[b + 14] / lanes[b + 6];
          ctx.save();
          ctx.translate(lanes[b + 8], lanes[b + 9]);
          ctx.scale(ratio, ratio);
          renderCodeLayout(ctx, layout, 0, 0, c.fontSize, c.spans, c.source, c.title, c.output, c.outputCache);
          ctx.restore();
          break;
        }
        default: {
          // note / bookmark — ratio around the output origin.
          const ratio = lanes[b + 14] / lanes[b + 6];
          ctx.save();
          ctx.translate(lanes[b + 12], lanes[b + 13]);
          ctx.scale(ratio, ratio);
          ctx.translate(-lanes[b + 4], -lanes[b + 5]);
          drawObject(ctx, handle);
          ctx.restore();
          break;
        }
      }
      break;
    }

    case OP_REFLOW_TEXT: {
      const layout = getReflowLayout(gi) as TextLayout;
      if (layout.lineCount > 0) {
        const r = readTextRender(handle.y);
        renderTextLayout(ctx, layout, lanes[b + 12], lanes[b + 13], r.color, r.align, r.fillColor);
      } else {
        // Begin→first-move window (pooled layout zeroed at freeze): draw in
        // place — seeded oBBox = fBBox makes the offset draw exact (delta 0).
        // Same fallback as the code arm below; a blank frame is strictly worse.
        renderOffsetLanes(ctx, handle, lanes, b);
      }
      break;
    }

    case OP_REFLOW_CODE: {
      const layout = getReflowLayout(gi) as CodeLayout;
      if (layout.visualLineCount > 0) {
        const c = fillCodeChrome(handle);
        if (!c) break;
        // Live fontSize (not the frozen lane) — exact port of the pre-SoA arm.
        renderCodeLayout(ctx, layout, lanes[b + 12], lanes[b + 13], c.fontSize, c.spans, c.source, c.title, c.output, c.outputCache);
      } else {
        // Begin→first-move window (empty pooled layout): draw in place — the
        // old else-chain fell through to the translated draw with delta 0.
        renderOffsetLanes(ctx, handle, lanes, b);
      }
      break;
    }

    case OP_OFFSET: {
      // Scale-edgePin: translated draw by the out−frozen bbox delta.
      renderOffsetLanes(ctx, handle, lanes, b);
      break;
    }
  }
}

function renderOffsetLanes(ctx: CanvasRenderingContext2D, handle: ObjectHandle, lanes: Float64Array, b: number): void {
  const dx = lanes[b + 8] - lanes[b];
  const dy = lanes[b + 9] - lanes[b + 1];
  ctx.save();
  ctx.translate(dx, dy);
  drawObject(ctx, handle);
  ctx.restore();
}
