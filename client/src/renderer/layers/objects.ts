import type { ObjectHandle, ObjectKind } from '@/core/types/objects';
import type { BBoxTuple, FrameTuple, Point } from '@/core/types/geometry';
import { getObjectsById, getSpatialIndex } from '@/runtime/room-runtime';
import {
  getColor,
  getOpacity,
  getWidth,
  getFrame,
  getShapeType,
  getFillColor,
  getStrokeTool,
  getStartCap,
  getEndCap,
  hasLabel,
  getLabelColor,
  getContent,
  getFontSize,
  getFontFamily,
  getStrokeProps,
  getShapeProps,
} from '@/core/accessors';
import { getPath, getConnectorPaths } from '../geometry-cache';
import { buildConnectorPaths } from '@/core/connectors/connector-paths';
import { paintConnector } from './connector-render-atoms';
import { getVisibleBoundsTuple } from '@/stores/camera-store';
import { useSelectionStore } from '@/stores/selection-store';
import { buildShapePathFromFrame } from '@/core/geometry/shape-path';
import { bboxesIntersect } from '@/core/geometry/hit-primitives';
import { textLayoutCache, renderTextLayout, renderShapeLabel, computeLabelTextBox, layoutMeasuredContent } from '@/core/text/text-system';
import { drawStickyNote } from '@/core/text/sticky-note';
import { getTextProps, getAlign, getAlignV, getCodeProps } from '@/core/accessors';
import { codeSystem, renderCodeLayout } from '@/core/code/code-system';
import { CODE_EXTENSIONS, getAssetId } from '@/core/accessors';
import { getBitmap } from '@/core/image/image-manager';
import { drawBookmark } from '@/core/bookmark/bookmark-render';
import {
  getScaleEntry,
  getScaleBehavior,
  getTranslateDelta,
  getTransformTopology,
  type Entry,
  type GeoOf,
} from '@/tools/selection/transform';
import type { CodeProps } from '@/core/accessors';

function getCodeRenderData(id: string, props: CodeProps) {
  return {
    spans: codeSystem.getSpans(id),
    lines: codeSystem.getSourceLines(id),
    title: props.headerVisible ? (props.title ?? `Untitled.${CODE_EXTENSIONS[props.language]}`) : undefined,
    output: props.outputVisible ? (props.output ?? '') : undefined,
  };
}

function withTransform(ctx: CanvasRenderingContext2D, tx: number, ty: number, sx: number, sy: number, draw: () => void): void {
  ctx.save();
  ctx.translate(tx, ty);
  ctx.scale(sx, sy);
  draw();
  ctx.restore();
}

// Module-scope scratches. Reused across frames — zero allocation on the hot path.
const _candidateIds: string[] = [];
const _previewScratch: BBoxTuple = [0, 0, 0, 0];
// Dedupes inject candidates across the three sources (selectedIds / topology.translateIdSet /
// topology.reroutes). A selected connector is typically present in both selectedIds and one
// of the topology maps — without this we'd pay getRenderBBox + viewport-test twice per frame.
const _injectSeen = new Set<string>();

/**
 * Render-time bbox for transform-injected IDs. Reads whatever cached representation
 * the active transform already maintains per frame — no recomputation:
 *   - topology connectors → `topology.prevBboxes.get(id)` (set by updateTopologyReroutes)
 *   - endpointDrag connector → `transform.routedBbox` (set by rerouteConnector)
 *   - scale (non-connector) → `entry.out.bbox` (set by apply functions)
 *   - translate (non-connector) → `handle.bbox + translateDelta`
 * Falls back to `handle.bbox` (stored position) when nothing applies.
 * The returned tuple may be the module scratch — consumers must intersect-test immediately.
 */
function getRenderBBox(
  handle: ObjectHandle,
  transform: ReturnType<typeof useSelectionStore.getState>['transform'],
  connTopology: ReturnType<typeof getTransformTopology>,
): BBoxTuple {
  const topoPrev = connTopology?.prevBboxes.get(handle.id);
  if (topoPrev) return topoPrev;

  if (transform.kind === 'translate') {
    const delta = getTranslateDelta();
    if (delta) {
      const b = handle.bbox;
      _previewScratch[0] = b[0] + delta[0];
      _previewScratch[1] = b[1] + delta[1];
      _previewScratch[2] = b[2] + delta[0];
      _previewScratch[3] = b[3] + delta[1];
      return _previewScratch;
    }
  } else if (transform.kind === 'scale' && handle.kind !== 'connector') {
    const entry = getScaleEntry(handle.kind, handle.id);
    if (entry) return (entry.out as { bbox: BBoxTuple }).bbox;
  } else if (transform.kind === 'endpointDrag') {
    if (handle.id === transform.connectorId && transform.routedBbox) return transform.routedBbox;
  }
  return handle.bbox;
}

export function drawObjects(ctx: CanvasRenderingContext2D, clipBuf: Float64Array | null, clipCount: number): void {
  const spatialIndex = getSpatialIndex();
  const objectsById = getObjectsById();
  // === READ SELECTION STATE FOR TRANSFORM PREVIEW ===
  const selectionState = useSelectionStore.getState();
  const selectedSet = selectionState.selectedIdSet;
  const selectedIds = selectionState.selectedIds;
  const transform = selectionState.transform;
  const isTransforming = transform.kind !== 'none';

  // Read topology from transform-state module (not from Zustand)
  const connTopology = getTransformTopology();
  const translateSet = connTopology?.translateIdSet;
  const reroutes = connTopology?.reroutes;

  const viewport = getVisibleBoundsTuple() as BBoxTuple;
  const entries = spatialIndex.queryBBox(viewport);

  _candidateIds.length = 0;
  const hasClip = clipBuf !== null && clipCount > 0;
  const cbuf = clipBuf; // narrowed local — avoids repeated NNA inside hot loop

  // Main loop: rbush entries from the viewport, rect-filtered by clipBuf.
  // Transform-injected IDs (selected / translate-topology / reroute-topology) are
  // skipped here and re-pushed below via their PREVIEW bbox — this replaces the
  // old "blind inject to compensate for edge-scroll stale rbush" workaround with
  // a correctness-first filter by actual render position.
  for (let k = 0; k < entries.length; k++) {
    const e = entries[k];
    if (
      isTransforming &&
      (selectedSet.has(e.id) || (translateSet !== undefined && translateSet.has(e.id)) || (reroutes !== undefined && reroutes.has(e.id)))
    )
      continue;

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

  // Inject transform IDs using their preview bbox, viewport-culled.
  // A selected connector appears in both `selectedIds` and one of the topology maps —
  // _injectSeen de-duplicates so we don't getRenderBBox/viewport-test twice per frame.
  if (isTransforming) {
    _injectSeen.clear();
    for (let i = 0; i < selectedIds.length; i++) {
      const id = selectedIds[i];
      if (_injectSeen.has(id)) continue;
      const h = objectsById.get(id);
      if (!h) continue;
      _injectSeen.add(id);
      if (bboxesIntersect(getRenderBBox(h, transform, connTopology), viewport)) {
        _candidateIds.push(id);
      }
    }
    if (connTopology) {
      for (const id of connTopology.translateIdSet) {
        if (_injectSeen.has(id)) continue;
        const h = objectsById.get(id);
        if (!h) continue;
        _injectSeen.add(id);
        if (bboxesIntersect(getRenderBBox(h, transform, connTopology), viewport)) {
          _candidateIds.push(id);
        }
      }
      for (const id of connTopology.reroutes.keys()) {
        if (_injectSeen.has(id)) continue;
        const h = objectsById.get(id);
        if (!h) continue;
        _injectSeen.add(id);
        if (bboxesIntersect(getRenderBBox(h, transform, connTopology), viewport)) {
          _candidateIds.push(id);
        }
      }
    }
  }

  // Sort by ULID for deterministic draw order (oldest first -> newest on top).
  // Main loop excludes inject-set IDs and _injectSeen de-dupes within inject, so
  // _candidateIds is provably unique — no post-sort dedupe needed.
  _candidateIds.sort();

  for (let i = 0; i < _candidateIds.length; i++) {
    const id = _candidateIds[i];
    const handle = objectsById.get(id);
    if (!handle) continue;

    // === TRANSFORM SELECTED OBJECTS DURING ACTIVE TRANSFORM ===
    const isSelected = selectedSet.has(id);
    const needsTransform = isTransforming && isSelected;

    if (needsTransform) {
      if (transform.kind === 'translate') {
        const delta = getTranslateDelta();
        if (!delta) {
          drawObject(ctx, handle);
        } else if (handle.kind === 'connector') {
          // Connector during translate: check topology reroutes
          const points = connTopology?.reroutes.get(handle.id);
          if (points) {
            drawConnectorFromPoints(ctx, handle, points);
          } else if (connTopology?.translateIdSet.has(handle.id)) {
            ctx.save();
            ctx.translate(delta[0], delta[1]);
            drawObject(ctx, handle);
            ctx.restore();
          } else {
            drawObject(ctx, handle);
          }
        } else {
          // Non-connector: use ctx.translate with cached Path2D (efficient)
          ctx.save();
          ctx.translate(delta[0], delta[1]);
          drawObject(ctx, handle);
          ctx.restore();
        }
      } else if (transform.kind === 'scale') {
        // Scale: entry-based rendering (typed by kind)
        if (handle.kind !== 'connector') {
          renderScaleEntry(ctx, handle);
        } else {
          const points = connTopology?.reroutes.get(handle.id);
          if (points) {
            drawConnectorFromPoints(ctx, handle, points);
          } else {
            drawObject(ctx, handle);
          }
        }
      } else if (transform.kind === 'endpointDrag') {
        if (handle.kind === 'connector' && handle.id === transform.connectorId && transform.routedPoints) {
          drawConnectorFromPoints(ctx, handle, transform.routedPoints);
        } else {
          drawObject(ctx, handle);
        }
      } else {
        drawObject(ctx, handle);
      }
    } else {
      // Non-selected: check topology for connector overrides
      if (handle.kind === 'connector' && connTopology) {
        const points = connTopology.reroutes.get(id);
        if (points) {
          drawConnectorFromPoints(ctx, handle, points);
        } else if (connTopology.translateIdSet.has(id)) {
          const delta = getTranslateDelta();
          if (delta) {
            ctx.save();
            ctx.translate(delta[0], delta[1]);
            drawObject(ctx, handle);
            ctx.restore();
          } else {
            drawObject(ctx, handle);
          }
        } else {
          drawObject(ctx, handle);
        }
      } else {
        drawObject(ctx, handle);
      }
    }
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
      drawStickyNote(ctx, handle);
      break;
    case 'bookmark':
      drawBookmark(ctx, handle);
      break;
  }
}

function drawStroke(ctx: CanvasRenderingContext2D, handle: ObjectHandle): void {
  const props = getStrokeProps(handle.y);
  if (!props) return;
  const { color, opacity, tool } = props;

  const path = getPath(handle.id, handle);

  ctx.save();
  ctx.globalAlpha = opacity;

  // STROKES ARE ALWAYS FILLED POLYGONS
  ctx.fillStyle = color;
  if (tool === 'highlighter') {
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.fill(path);

  ctx.restore();
}

function drawShape(ctx: CanvasRenderingContext2D, handle: ObjectHandle): void {
  const props = getShapeProps(handle.y);
  if (!props) return;
  const { fillColor, color, width, opacity } = props;

  const path = getPath(handle.id, handle);

  ctx.save();
  ctx.globalAlpha = opacity;

  if (fillColor) {
    ctx.fillStyle = fillColor;
    ctx.fill(path);
  }

  if (color && width > 0) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  }

  if (hasLabel(handle.y)) drawShapeLabel(ctx, handle);

  ctx.restore();
}

function drawShapeLabel(ctx: CanvasRenderingContext2D, handle: ObjectHandle): void {
  if (useSelectionStore.getState().textEditingId === handle.id) return;
  const content = getContent(handle.y);
  if (!content) return;
  const frame = getFrame(handle.y)!;
  const textBox = computeLabelTextBox(getShapeType(handle.y), frame);
  if (textBox[2] <= 0 || textBox[3] <= 0) return;
  const fontSize = getFontSize(handle.y);
  const fontFamily = getFontFamily(handle.y);
  const align = getAlign(handle.y, 'center');
  const alignV = getAlignV(handle.y);
  const layout = textLayoutCache.getLayout(handle.id, content, fontSize, fontFamily, textBox[2]);
  renderShapeLabel(ctx, layout, textBox, getLabelColor(handle.y), fontFamily, align, alignV);
}

function drawShapeLabelWithFrame(ctx: CanvasRenderingContext2D, handle: ObjectHandle, frame: FrameTuple): void {
  if (useSelectionStore.getState().textEditingId === handle.id) return;
  const measured = textLayoutCache.getMeasuredContent(handle.id);
  if (!measured) return;
  const textBox = computeLabelTextBox(getShapeType(handle.y), frame);
  if (textBox[2] <= 0 || textBox[3] <= 0) return;
  const fontSize = getFontSize(handle.y);
  const fontFamily = getFontFamily(handle.y);
  const align = getAlign(handle.y, 'center');
  const alignV = getAlignV(handle.y);
  const layout = layoutMeasuredContent(measured, textBox[2], fontSize);
  renderShapeLabel(ctx, layout, textBox, getLabelColor(handle.y), fontFamily, align, alignV);
}

/**
 * Draw text object using Y.XmlFragment-based rich text.
 * Skips rendering if the text is currently being edited (DOM overlay handles it).
 */
function drawText(ctx: CanvasRenderingContext2D, handle: ObjectHandle): void {
  const { id, y } = handle;
  if (useSelectionStore.getState().textEditingId === id) return;

  const props = getTextProps(y);
  if (!props) return;

  const color = getColor(y);
  const fillColor = getFillColor(y);
  const layout = textLayoutCache.getLayout(id, props.content, props.fontSize, props.fontFamily, props.width);
  renderTextLayout(ctx, layout, props.origin[0], props.origin[1], color, props.align, fillColor);
}

function drawCode(ctx: CanvasRenderingContext2D, handle: ObjectHandle): void {
  const { id, y } = handle;

  // Skip rendering if currently being edited (DOM overlay handles it)
  const codeEditingId = useSelectionStore.getState().codeEditingId;
  if (codeEditingId === id) return;

  const props = getCodeProps(y);
  if (!props) return;

  const layout = codeSystem.getLayout(id, props.content, props.fontSize, props.width, props.language, props.lineNumbers);
  const { spans, lines, title, output } = getCodeRenderData(id, props);
  renderCodeLayout(ctx, layout, props.origin[0], props.origin[1], props.fontSize, spans, lines, title, output);
}

function drawImage(ctx: CanvasRenderingContext2D, handle: ObjectHandle, frameOverride?: FrameTuple): void {
  const frame = frameOverride ?? getFrame(handle.y);
  if (!frame || frame[2] < 0.001 || frame[3] < 0.001) return;
  const assetId = getAssetId(handle.y);
  if (!assetId) return;

  const bitmap = getBitmap(assetId);
  const opacity = getOpacity(handle.y);

  ctx.save();
  ctx.globalAlpha = opacity;
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
  const { id, y } = handle;
  paintConnector(ctx, getConnectorPaths(id, handle), getColor(y), getWidth(y));
}

/**
 * Draw a connector from explicit points (for rerouted connectors during transforms).
 * Reads styles from handle.y, builds fresh paths from the given points.
 */
function drawConnectorFromPoints(ctx: CanvasRenderingContext2D, handle: ObjectHandle, points: Point[]): void {
  if (points.length < 2) return;
  const { y } = handle;
  const width = getWidth(y);
  const paths = buildConnectorPaths({ points, strokeWidth: width, startCap: getStartCap(y), endCap: getEndCap(y) });
  paintConnector(ctx, paths, getColor(y), width);
}

// ============================================================================
// Entry-Based Scale Transform Rendering
// ============================================================================

function renderScaleEntry(ctx: CanvasRenderingContext2D, handle: ObjectHandle): void {
  switch (handle.kind) {
    case 'shape': {
      const entry = getScaleEntry('shape', handle.id);
      if (!entry) break;
      const { frame, bbox } = entry.out;
      if (bbox[2] - bbox[0] < 0.001 || bbox[3] - bbox[1] < 0.001) return;

      const shapeType = getShapeType(handle.y);
      const fillColor = getFillColor(handle.y);
      const color = getColor(handle.y);
      const width = getWidth(handle.y, 1);
      const opacity = getOpacity(handle.y);

      const path = buildShapePathFromFrame(shapeType, frame);

      ctx.save();
      ctx.globalAlpha = opacity;
      if (fillColor) {
        ctx.fillStyle = fillColor;
        ctx.fill(path);
      }
      if (color && width > 0) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke(path);
      }
      if (hasLabel(handle.y)) drawShapeLabelWithFrame(ctx, handle, frame);
      ctx.restore();
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
        const color = getColor(handle.y);
        const opacity = getOpacity(handle.y);
        const tool = getStrokeTool(handle.y);
        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.fillStyle = color;
        if (tool === 'highlighter') ctx.globalCompositeOperation = 'source-over';
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
        renderTextLayout(
          ctx,
          entry.out.layout,
          entry.out.origin[0],
          entry.out.origin[1],
          getColor(handle.y),
          getAlign(handle.y),
          getFillColor(handle.y),
        );
      } else if (behavior === 'uniform') {
        const ratio = entry.out.fontSize / entry.frozen.fontSize!;
        const props = getTextProps(handle.y);
        if (!props) break;
        const layout = textLayoutCache.getLayout(handle.id, props.content, props.fontSize, props.fontFamily, props.width);
        const color = getColor(handle.y);
        const fillColor = getFillColor(handle.y);
        withTransform(ctx, entry.out.origin[0], entry.out.origin[1], ratio, ratio, () =>
          renderTextLayout(ctx, layout, 0, 0, color, props.align, fillColor),
        );
      } else {
        renderTranslatedEntry(ctx, handle, entry);
      }
      break;
    }

    case 'code': {
      const entry = getScaleEntry('code', handle.id);
      if (!entry) break;
      const behavior = getScaleBehavior('code');
      if (behavior === 'reflow' && entry.out.layout) {
        const props = getCodeProps(handle.y);
        if (!props) break;
        const { spans, lines, title, output } = getCodeRenderData(handle.id, props);
        renderCodeLayout(ctx, entry.out.layout, entry.out.origin[0], entry.out.origin[1], props.fontSize, spans, lines, title, output);
      } else if (behavior === 'uniform') {
        const ratio = entry.out.fontSize / entry.frozen.fontSize!;
        const props = getCodeProps(handle.y);
        if (!props) break;
        const layout = codeSystem.getLayout(handle.id, props.content, props.fontSize, props.width, props.language, props.lineNumbers);
        const { spans, lines, title, output } = getCodeRenderData(handle.id, props);
        const b = entry.out.bbox;
        withTransform(ctx, b[0], b[1], ratio, ratio, () =>
          renderCodeLayout(ctx, layout, 0, 0, props.fontSize, spans, lines, title, output),
        );
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
        withTransform(ctx, entry.out.origin[0], entry.out.origin[1], ratio, ratio, () => {
          ctx.translate(-entry.frozen.origin[0], -entry.frozen.origin[1]);
          drawObject(ctx, handle);
        });
      } else {
        renderTranslatedEntry(ctx, handle, entry);
      }
      break;
    }
  }
}

/** Kinds whose GeoOf has bbox — safe for entry.frozen.bbox access */
type KindWithBBoxGeo = { [K in ObjectKind]: GeoOf<K> extends { bbox: BBoxTuple } ? K : never }[ObjectKind];

function renderTranslatedEntry(ctx: CanvasRenderingContext2D, handle: ObjectHandle, entry: Entry<KindWithBBoxGeo>): void {
  const dx = entry.out.bbox[0] - entry.frozen.bbox[0];
  const dy = entry.out.bbox[1] - entry.frozen.bbox[1];
  ctx.save();
  ctx.translate(dx, dy);
  drawObject(ctx, handle);
  ctx.restore();
}
