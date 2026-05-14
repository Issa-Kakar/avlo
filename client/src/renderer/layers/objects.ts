import { drawBookmark } from '@/core/bookmark/bookmark-render';
import { codeSystem, renderCodeLayout } from '@/core/code/code-system';
import { bboxesIntersect } from '@/core/geometry/hit-primitives';
import { getBitmap } from '@/core/image/image-manager';
import { computeLabelTextBox, layoutIntoLabelScratch, renderShapeLabel } from '@/core/text/shape-label';
import { drawStickyNote } from '@/core/text/sticky-note';
import { renderTextLayout, textLayoutCache } from '@/core/text/text-system';
import type { BBoxTuple, FrameTuple, Point } from '@/core/types/geometry';
import type { ObjectHandle } from '@/core/types/objects';
import { getObjectsById, getSpatialIndex } from '@/runtime/room-runtime';
import { selectTool } from '@/runtime/tool-registry';
import { getVisibleBoundsTuple } from '@/stores/camera-store';
import { useSelectionStore } from '@/stores/selection-store';
import type { ConnectorEntry, EndpointDragEntry } from '@/tools/selection/connector-topology';
import {
  type Entry,
  getController,
  getEndpointDragEntry,
  getScaleBehavior,
  getScaleEntry,
  getTransformInjectIds,
  getTransformTopology,
  type KindWithBBoxGeo,
} from '@/tools/selection/transform';
import type { TransformState } from '@/tools/selection/types';
import { getConnectorPaths, getPath } from '../geometry-cache';
import {
  readCodeRender,
  readConnectorBaseRender,
  readConnectorRender,
  readImageRender,
  readShapeLabelRender,
  readShapeLabelRenderNoFrame,
  readShapeRender,
  readStrokeRender,
  readTextRender,
} from '../render-accessors';
import { paintConnector, paintConnectorFromPoints } from './connector-render-atoms';
import { paintShapeFrame } from './shape-preview';

// Module-scope scratches. Reused across frames — zero allocation on the hot path.
const _candidateIds: string[] = [];
const _previewScratch: BBoxTuple = [0, 0, 0, 0];

// Per-frame editing-id snapshot, written once at the top of `drawObjects` and
// read by leaf `draw*` functions. Avoids one `useSelectionStore.getState()`
// per relevant object per frame.
let _textEditingId: string | null = null;
let _codeEditingId: string | null = null;
// Per-frame bookmark Open-button hover id. Hoisted once at frame top from
// SelectTool's singleton field; leaf bookmark dispatch reads as identity
// compare (interned-string equality when set, cheap-false when null).
let _hoveredOpenBookmarkId: string | null = null;

export function drawObjects(ctx: CanvasRenderingContext2D, clipBuf: Float64Array | null, clipCount: number): void {
  const spatialIndex = getSpatialIndex();
  const objectsById = getObjectsById();
  const sel = useSelectionStore.getState();
  const selectedSet = sel.selectedIdSet;
  const transform = sel.transform;
  const tm = transform.kind;
  const isTransforming = tm !== 'none';
  const isTranslating = tm === 'translate';
  const isScaling = tm === 'scale';

  // Hoist editing IDs ONCE per frame — leaf draw fns read these instead of
  // polling `useSelectionStore.getState()` per object.
  _textEditingId = sel.textEditingId;
  _codeEditingId = sel.codeEditingId;
  _hoveredOpenBookmarkId = selectTool.getHoveredOpenBookmarkId();

  // Pre-resolve per-frame dispatch tokens. Topology mode → connEntries Map.get;
  // endpoint drag → string equality on epDragId. Both null when idle.
  const topology = getTransformTopology();
  const connEntries: ReadonlyMap<string, ConnectorEntry> | null = topology?.byId ?? null;
  const attachedSet: ReadonlySet<string> | null = topology?.attachedConnectorIds ?? null;
  const haveAttached = attachedSet !== null;

  const epDragEntry = getEndpointDragEntry();
  const epDragId: string | null = epDragEntry?.id ?? null;

  // Hoist translate dx/dy as scalars once per frame. Avoids the per-iteration
  // `getTranslateDelta()` allocation when threading through inner loops.
  const ctrl = isTranslating ? getController() : null;
  const tdx = ctrl ? ctrl.dx : 0;
  const tdy = ctrl ? ctrl.dy : 0;

  const viewport = getVisibleBoundsTuple();
  const entries = spatialIndex.queryBBox(viewport);

  _candidateIds.length = 0;
  const hasClip = clipBuf !== null && clipCount > 0;
  const cbuf = clipBuf; // narrowed local — avoids repeated NNA inside hot loop

  // Main loop: rbush entries from the viewport, rect-filtered by clipBuf.
  // Transform-injected IDs (selected + attached-topology connectors, or the
  // dragged endpoint connector — already in selectedSet by drill invariant)
  // are skipped here and re-pushed below via their preview bbox.
  for (let k = 0; k < entries.length; k++) {
    const e = entries[k];
    if (isTransforming) {
      if (selectedSet.has(e.id)) continue;
      if (haveAttached && attachedSet!.has(e.id)) continue;
    }

    if (hasClip && cbuf !== null) {
      let hit = false;
      for (let i = 0; i < clipCount; i++) {
        const off = i * 4;
        if (e.minX <= cbuf[off + 2] && e.maxX >= cbuf[off] && e.minY <= cbuf[off + 3] && e.maxY >= cbuf[off + 1]) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;
    }
    _candidateIds.push(e.id);
  }

  // Pre-dispatched inject cull. Outer switch picks the loop body once;
  // inner is straight-line per kind.
  if (isTransforming) {
    const injectIds = getTransformInjectIds() ?? sel.selectedIds;
    cullInjected(injectIds, objectsById, viewport, transform, connEntries, epDragEntry, tdx, tdy);
  }

  // Sort by ULID for deterministic draw order (oldest first -> newest on top).
  // Main loop excludes inject-set IDs and injectIds is provably unique — no post-sort dedupe needed.
  _candidateIds.sort();

  for (let i = 0; i < _candidateIds.length; i++) {
    const id = _candidateIds[i];
    const handle = objectsById.get(id);
    if (!handle) continue;

    // Connector branch: ONE Map.get (topology) OR ONE string compare (endpoint
    // drag) + ONE dispatch. No optional chaining on the hot path. The
    // endpoint-drag synthetic entry has `mode: 'reroute'`, structurally
    // identical to a topology reroute — same `drawConnectorEntry` dispatch.
    if (handle.kind === 'connector') {
      let ce: ConnectorEntry | null = null;
      if (connEntries) ce = connEntries.get(handle.id) ?? null;
      else if (epDragId !== null && handle.id === epDragId) ce = epDragEntry;
      if (ce) drawConnectorEntry(ctx, handle, ce, tdx, tdy);
      else drawConnector(ctx, handle);
      continue;
    }

    // Non-connector path. endpointDrag never affects non-connectors and
    // selectedSet narrows to the dragged connector by drill invariant — the
    // `else` arm below is unreachable for non-connectors and intentionally
    // omitted (impossible state, no fallback paint).
    if (!isTransforming || !selectedSet.has(id)) {
      drawObject(ctx, handle);
      continue;
    }
    if (isTranslating) {
      ctx.save();
      ctx.translate(tdx, tdy);
      drawObject(ctx, handle);
      ctx.restore();
    } else if (isScaling) {
      renderScaleEntry(ctx, handle);
    }
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
 * Pre-dispatched inject cull. The outer switch resolves the transform mode
 * once per frame, then the inner loop is monomorphic — no per-iteration
 * `switch (transform.kind)`. EndpointDrag is a single ID so the loop is
 * elided entirely (read directly off `epDragEntry`).
 */
function cullInjected(
  injectIds: readonly string[],
  objectsById: ReturnType<typeof getObjectsById>,
  viewport: Readonly<BBoxTuple>,
  transform: TransformState,
  connEntries: ReadonlyMap<string, ConnectorEntry> | null,
  epDragEntry: EndpointDragEntry | null,
  tdx: number,
  tdy: number,
): void {
  switch (transform.kind) {
    case 'translate': {
      for (let i = 0; i < injectIds.length; i++) {
        const id = injectIds[i];
        const h = objectsById.get(id);
        if (!h) continue;
        const ce = connEntries?.get(id);
        if (ce) {
          if (bboxesIntersect(ce.currBbox, viewport)) _candidateIds.push(id);
          continue;
        }
        // Non-connector translate: handle.bbox + delta. Inline writes — no allocation.
        const b = h.bbox;
        _previewScratch[0] = b[0] + tdx;
        _previewScratch[1] = b[1] + tdy;
        _previewScratch[2] = b[2] + tdx;
        _previewScratch[3] = b[3] + tdy;
        if (bboxesIntersect(_previewScratch, viewport)) _candidateIds.push(id);
      }
      return;
    }
    case 'scale': {
      for (let i = 0; i < injectIds.length; i++) {
        const id = injectIds[i];
        const h = objectsById.get(id);
        if (!h) continue;
        const ce = connEntries?.get(id);
        if (ce) {
          if (bboxesIntersect(ce.currBbox, viewport)) _candidateIds.push(id);
          continue;
        }
        if (h.kind !== 'connector') {
          const entry = getScaleEntry(h.kind, id);
          const bbox = entry ? (entry.out as { bbox: BBoxTuple }).bbox : h.bbox;
          if (bboxesIntersect(bbox, viewport)) _candidateIds.push(id);
        } else if (bboxesIntersect(h.bbox, viewport)) {
          _candidateIds.push(id);
        }
      }
      return;
    }
    case 'endpointDrag': {
      // Single connector — read directly off the controller's synthetic entry.
      if (!epDragEntry) return;
      if (bboxesIntersect(epDragEntry.currBbox, viewport)) _candidateIds.push(epDragEntry.id);
      return;
    }
    case 'none':
      return;
  }
}

function drawObject(ctx: CanvasRenderingContext2D, handle: ObjectHandle): void {
  switch (handle.kind) {
    case 'stroke':
      drawStroke(ctx, handle);
      break;
    case 'shape':
      drawShape(ctx, handle);
      break;
    case 'text':
      drawText(ctx, handle);
      break;
    case 'connector':
      drawConnector(ctx, handle);
      break;
    case 'code':
      drawCode(ctx, handle);
      break;
    case 'image':
      drawImage(ctx, handle);
      break;
    case 'note':
      drawStickyNote(ctx, handle, _textEditingId === handle.id);
      break;
    case 'bookmark':
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
  const layout = textLayoutCache.getLayout(handle.id, r.content, r.fontSize, r.fontFamily, textBox[2]);
  renderShapeLabel(ctx, layout, textBox, r.labelColor, r.fontFamily, r.align, r.alignV);
}

function drawShapeLabelWithFrame(ctx: CanvasRenderingContext2D, handle: ObjectHandle, frame: FrameTuple): void {
  if (_textEditingId === handle.id) return;
  const r = readShapeLabelRenderNoFrame(handle.y);
  if (!r) return;
  const measured = textLayoutCache.getMeasuredContent(handle.id);
  if (!measured) return;
  const textBox = computeLabelTextBox(r.shapeType, frame);
  if (textBox[2] <= 0 || textBox[3] <= 0) return;
  const layout = layoutIntoLabelScratch(measured, textBox[2], r.fontSize);
  renderShapeLabel(ctx, layout, textBox, r.labelColor, r.fontFamily, r.align, r.alignV);
}

/**
 * Draw text object using Y.XmlFragment-based rich text.
 * Skips rendering if the text is currently being edited (DOM overlay handles it).
 */
function drawText(ctx: CanvasRenderingContext2D, handle: ObjectHandle): void {
  const { id, y } = handle;
  if (_textEditingId === id) return;

  const layout = textLayoutCache.getLayoutById(id);
  if (!layout) return; // cold-miss race — observer fills the cache before render
  const r = readTextRender(y);
  renderTextLayout(ctx, layout, r.originX, r.originY, r.color, r.align, r.fillColor);
}

function drawCode(ctx: CanvasRenderingContext2D, handle: ObjectHandle): void {
  const { id, y } = handle;

  // Skip rendering if currently being edited (DOM overlay handles it)
  if (_codeEditingId === id) return;

  const layout = codeSystem.getLayoutById(id);
  if (!layout) return; // cold-miss race — observer fills the cache before render
  const spans = codeSystem.getSpans(id);
  const source = codeSystem.getSource(id);
  if (!spans || !source) return;
  const r = readCodeRender(y);
  const title = r.headerVisible ? (r.title ?? 'Untitled') : undefined;
  const output = r.outputVisible ? (r.output ?? '') : undefined;
  const outputCache = output !== undefined ? (codeSystem.getOutputCache(id, output) ?? undefined) : undefined;
  renderCodeLayout(ctx, layout, r.originX, r.originY, r.fontSize, spans, source, title, output, outputCache);
}

function drawImage(ctx: CanvasRenderingContext2D, handle: ObjectHandle, frameOverride?: FrameTuple): void {
  const r = readImageRender(handle.y);
  const frame = frameOverride ?? r.frame!;
  const bitmap = getBitmap(r.assetId!);

  ctx.save();
  ctx.globalAlpha = r.opacity;
  if (bitmap) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, frame[0], frame[1], frame[2], frame[3]);
  } else {
    // Placeholder: light gray rect with subtle border
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(frame[0], frame[1], frame[2], frame[3]);
    ctx.strokeStyle = '#d1d5db';
    ctx.lineWidth = 1;
    ctx.strokeRect(frame[0], frame[1], frame[2], frame[3]);
  }
  ctx.restore();
}

function drawConnector(ctx: CanvasRenderingContext2D, handle: ObjectHandle): void {
  const r = readConnectorBaseRender(handle.y);
  paintConnector(ctx, getConnectorPaths(handle.id, handle), r.color, r.width);
}

/**
 * Draw a connector from explicit points (rerouted connectors during transforms).
 * `count` is required — `paintConnectorFromPoints` short-circuits on `count < 2`.
 *
 * Hot path: emits straight into ctx (zero Path2D allocation per frame).
 */
function drawConnectorFromPoints(ctx: CanvasRenderingContext2D, handle: ObjectHandle, points: Point[], count: number): void {
  const r = readConnectorRender(handle.y);
  paintConnectorFromPoints(ctx, points, count, r.width, r.startCap, r.endCap, r.color);
}

// ============================================================================
// Entry-Based Scale Transform Rendering
// ============================================================================

function renderScaleEntry(ctx: CanvasRenderingContext2D, handle: ObjectHandle): void {
  switch (handle.kind) {
    case 'shape': {
      const entry = getScaleEntry('shape', handle.id);
      if (!entry) break;
      const { frame } = entry.out;

      const r = readShapeRender(handle.y);
      paintShapeFrame(ctx, r.shapeType, frame, r.fillColor, r.color, r.width, r.opacity);
      drawShapeLabelWithFrame(ctx, handle, frame);
      break;
    }

    case 'image': {
      const entry = getScaleEntry('image', handle.id);
      if (!entry) break;
      drawImage(ctx, handle, entry.out.frame);
      break;
    }

    case 'stroke': {
      const entry = getScaleEntry('stroke', handle.id);
      if (!entry) break;
      const behavior = getScaleBehavior('stroke');
      if (behavior === 'uniform') {
        // BBox-based ctx.scale: reuse cached Path2D, no per-frame point mutation
        const { factor, fcx, fcy } = entry.out;
        const ncx = (entry.out.bbox[0] + entry.out.bbox[2]) / 2,
          ncy = (entry.out.bbox[1] + entry.out.bbox[3]) / 2;
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
      } else {
        renderTranslatedEntry(ctx, handle, entry);
      }
      break;
    }

    case 'text': {
      const entry = getScaleEntry('text', handle.id);
      if (!entry) break;
      const behavior = getScaleBehavior('text');
      if (behavior === 'reflow' && entry.out.layout) {
        const r = readTextRender(handle.y);
        renderTextLayout(ctx, entry.out.layout, entry.out.origin[0], entry.out.origin[1], r.color, r.align, r.fillColor);
      } else if (behavior === 'uniform') {
        const layout = textLayoutCache.getLayoutById(handle.id);
        if (!layout) break;
        const ratio = entry.out.fontSize / entry.frozen.fontSize!;
        const r = readTextRender(handle.y);
        ctx.save();
        ctx.translate(entry.out.origin[0], entry.out.origin[1]);
        ctx.scale(ratio, ratio);
        renderTextLayout(ctx, layout, 0, 0, r.color, r.align, r.fillColor);
        ctx.restore();
      } else {
        renderTranslatedEntry(ctx, handle, entry);
      }
      break;
    }

    case 'code': {
      const entry = getScaleEntry('code', handle.id);
      if (!entry) break;
      const behavior = getScaleBehavior('code');
      if (behavior === 'reflow' && entry.out.layout.visualLineCount > 0) {
        const spans = codeSystem.getSpans(handle.id);
        const source = codeSystem.getSource(handle.id);
        if (!spans || !source) break;
        const r = readCodeRender(handle.y);
        const title = r.headerVisible ? (r.title ?? 'Untitled') : undefined;
        const output = r.outputVisible ? (r.output ?? '') : undefined;
        const outputCache = output !== undefined ? (codeSystem.getOutputCache(handle.id, output) ?? undefined) : undefined;
        renderCodeLayout(
          ctx,
          entry.out.layout,
          entry.out.origin[0],
          entry.out.origin[1],
          r.fontSize,
          spans,
          source,
          title,
          output,
          outputCache,
        );
      } else if (behavior === 'uniform') {
        const layout = codeSystem.getLayoutById(handle.id);
        if (!layout) break;
        const spans = codeSystem.getSpans(handle.id);
        const source = codeSystem.getSource(handle.id);
        if (!spans || !source) break;
        const ratio = entry.out.fontSize / entry.frozen.fontSize!;
        const r = readCodeRender(handle.y);
        const title = r.headerVisible ? (r.title ?? 'Untitled') : undefined;
        const output = r.outputVisible ? (r.output ?? '') : undefined;
        const outputCache = output !== undefined ? (codeSystem.getOutputCache(handle.id, output) ?? undefined) : undefined;
        const b = entry.out.bbox;
        ctx.save();
        ctx.translate(b[0], b[1]);
        ctx.scale(ratio, ratio);
        renderCodeLayout(ctx, layout, 0, 0, r.fontSize, spans, source, title, output, outputCache);
        ctx.restore();
      } else {
        renderTranslatedEntry(ctx, handle, entry);
      }
      break;
    }

    case 'note':
    case 'bookmark': {
      const entry = getScaleEntry(handle.kind, handle.id);
      if (!entry) break;
      const behavior = getScaleBehavior(handle.kind);
      if (behavior === 'uniform') {
        const ratio = entry.out.scale / entry.frozen.scale!;
        ctx.save();
        ctx.translate(entry.out.origin[0], entry.out.origin[1]);
        ctx.scale(ratio, ratio);
        ctx.translate(-entry.frozen.origin[0], -entry.frozen.origin[1]);
        drawObject(ctx, handle);
        ctx.restore();
      } else {
        renderTranslatedEntry(ctx, handle, entry);
      }
      break;
    }
  }
}

function renderTranslatedEntry(ctx: CanvasRenderingContext2D, handle: ObjectHandle, entry: Entry<KindWithBBoxGeo>): void {
  const dx = entry.out.bbox[0] - entry.frozen.bbox[0];
  const dy = entry.out.bbox[1] - entry.frozen.bbox[1];
  ctx.save();
  ctx.translate(dx, dy);
  drawObject(ctx, handle);
  ctx.restore();
}
