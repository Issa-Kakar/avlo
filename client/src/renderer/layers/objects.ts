import type { Snapshot, ViewTransform, ObjectHandle, IndexEntry, FrameTuple } from '@avlo/shared';
import {
  getColor,
  getOpacity,
  getWidth,
  getPoints,
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
} from '@avlo/shared';
import type { ViewportInfo } from '../types';
import { getObjectCacheInstance } from '../object-cache';
import { buildConnectorPaths, ARROW_ROUNDING_LINE_WIDTH } from '@/lib/connectors/connector-paths';
import { getVisibleWorldBounds } from '@/stores/camera-store';
import {
  useSelectionStore,
  type ScaleTransform,
  type ConnectorTopology,
  type TextReflowState,
  type CodeReflowState,
} from '@/stores/selection-store';
import {
  computeEdgePinTranslation,
  computeStrokeTranslation,
  applyTransformToFrame,
  applyUniformScaleToPoints,
  applyUniformScaleToFrame,
} from '@/lib/geometry/transform';
import { getStroke } from 'perfect-freehand';
import { PF_OPTIONS_BASE, getSvgPathFromStroke } from '../types';
import { buildShapePathFromFrame } from '@/lib/utils/shape-path';
import {
  textLayoutCache,
  renderTextLayout,
  renderShapeLabel,
  computeLabelTextBox,
  layoutMeasuredContent,
  anchorFactor,
  getBaselineToTopRatio,
  getTextFrame,
  getLineStartX,
  getNoteContentOffsetY,
  renderNoteBody,
  getNotePadding,
  getNoteContentWidth,
  getNoteDerivedFontSize,
  NOTE_WIDTH,
} from '@/lib/text/text-system';
import { getTextProps, getAlign, getAlignV, getCodeProps, getNoteProps } from '@avlo/shared';
import { computeUniformScaleNoThreshold, computePreservedPosition } from '@/lib/geometry/transform';
import { codeSystem, renderCodeLayout, getCodeFrame } from '@/lib/code/code-system';
import { CODE_EXTENSIONS } from '@avlo/shared';
import { getAssetId } from '@avlo/shared';
import { getBitmap } from '@/lib/image/image-manager';

export function drawObjects(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  viewTransform: ViewTransform,
  viewport: ViewportInfo,
): void {
  const { spatialIndex, objectsById } = snapshot;
  if (!spatialIndex) return;
  // === READ SELECTION STATE FOR TRANSFORM PREVIEW ===
  const selectionState = useSelectionStore.getState();
  const selectedSet = new Set(selectionState.selectedIds);
  const transform = selectionState.transform;
  const isTransforming = transform.kind !== 'none';

  // Read connector topology and text/code reflow state
  const connTopology = selectionState.connectorTopology;
  const textReflow = selectionState.textReflow;
  const codeReflow = selectionState.codeReflow;

  // Calculate visible world bounds for culling (reads from camera store)
  const visibleBounds = getVisibleWorldBounds();

  // Use spatial index for efficient querying
  let candidateEntries: IndexEntry[];

  if (viewport.clipWorldRects) {
    // OPTIMIZATION: Query each dirty rect and union results
    const entrySet = new Map<string, IndexEntry>();

    for (const rect of viewport.clipWorldRects) {
      const results = spatialIndex.query({
        minX: rect.minX,
        minY: rect.minY,
        maxX: rect.maxX,
        maxY: rect.maxY,
      });

      for (const entry of results) {
        // Use Map to avoid duplicates by ID
        entrySet.set(entry.id, entry);
      }
    }

    candidateEntries = Array.from(entrySet.values());
  } else {
    // Full viewport query
    candidateEntries = spatialIndex.query(visibleBounds);
  }

  // During active transforms, spatial index stores ORIGINAL positions. If the camera
  // has panned (e.g. edge scroll), originals may leave the viewport/dirty-rect bounds
  // while rendered positions (original + offset) are still on screen. Inject all
  // selected + topology objects so they're never culled mid-transform.
  if (isTransforming) {
    const candidateSet = new Set(candidateEntries.map((e) => e.id));
    const inject = (id: string) => {
      if (candidateSet.has(id)) return;
      const h = objectsById.get(id);
      if (!h) return;
      candidateEntries.push({
        id,
        kind: h.kind,
        minX: h.bbox[0],
        minY: h.bbox[1],
        maxX: h.bbox[2],
        maxY: h.bbox[3],
      });
      candidateSet.add(id);
    };
    for (const id of selectionState.selectedIds) inject(id);
    if (connTopology) {
      for (const id of connTopology.translateIdSet) inject(id);
      for (const id of connTopology.reroutes.keys()) inject(id);
    }
  }

  // ========== CRITICAL FIX: Sort by ULID for deterministic draw order ==========
  // WHY: RBush query order is non-deterministic
  // SOLUTION: ULID (object.id) provides globally consistent ordering

  const sortedCandidates = [...candidateEntries].sort((a, b) => {
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // Draw in ULID order (oldest first -> newest on top)
  for (const entry of sortedCandidates) {
    const handle = objectsById.get(entry.id);
    if (!handle) continue;

    // LOD check still needed (spatial query is coarse)
    if (shouldSkipLOD(handle.bbox, viewTransform)) {
      continue;
    }

    // === TRANSFORM SELECTED OBJECTS DURING ACTIVE TRANSFORM ===
    const isSelected = selectedSet.has(entry.id);
    const needsTransform = isTransforming && isSelected;

    if (needsTransform) {
      if (transform.kind === 'translate') {
        if (handle.kind === 'connector') {
          // Connector during translate: translateOnly or rerouted
          if (connTopology?.translateIdSet.has(handle.id)) {
            ctx.save();
            ctx.translate(transform.dx, transform.dy);
            drawObject(ctx, handle);
            ctx.restore();
          } else {
            const points = connTopology?.reroutes.get(handle.id);
            if (points) {
              drawConnectorFromPoints(ctx, handle, points);
            } else {
              drawObject(ctx, handle);
            }
          }
        } else {
          // Non-connector: use ctx.translate with cached Path2D
          ctx.save();
          ctx.translate(transform.dx, transform.dy);
          drawObject(ctx, handle);
          ctx.restore();
        }
      } else if (transform.kind === 'scale') {
        // Scale: context-aware rendering based on selectionKind and handleKind
        renderSelectedObjectWithScaleTransform(
          ctx,
          handle,
          transform,
          connTopology,
          textReflow,
          codeReflow,
        );
      } else if (transform.kind === 'endpointDrag') {
        // Endpoint drag: draw from rerouted points if available
        if (
          handle.kind === 'connector' &&
          handle.id === transform.connectorId &&
          transform.routedPoints
        ) {
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
        if (transform.kind === 'translate' && connTopology.translateIdSet.has(entry.id)) {
          ctx.save();
          ctx.translate(transform.dx, transform.dy);
          drawObject(ctx, handle);
          ctx.restore();
        } else {
          const points = connTopology.reroutes.get(entry.id);
          if (points) {
            drawConnectorFromPoints(ctx, handle, points);
          } else {
            drawObject(ctx, handle);
          }
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
  }
}

function drawStroke(ctx: CanvasRenderingContext2D, handle: ObjectHandle): void {
  const { id, y } = handle;
  const color = getColor(y);
  const opacity = getOpacity(y);
  const tool = getStrokeTool(y);

  const cache = getObjectCacheInstance();
  const path = cache.getPath(id, handle);

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
  const { id, y } = handle;

  const fillColor = getFillColor(y);
  const color = getColor(y);
  const width = getWidth(y, 1);
  const opacity = getOpacity(y);

  const cache = getObjectCacheInstance();
  const path = cache.getPath(id, handle);

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

  if (hasLabel(y)) drawShapeLabel(ctx, handle);

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

function drawShapeLabelWithFrame(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  frame: FrameTuple,
): void {
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
  const layout = textLayoutCache.getLayout(
    id,
    props.content,
    props.fontSize,
    props.fontFamily,
    props.width,
  );
  renderTextLayout(ctx, layout, props.origin[0], props.origin[1], color, props.align, fillColor);
}

function drawStickyNote(ctx: CanvasRenderingContext2D, handle: ObjectHandle): void {
  const { id, y } = handle;
  const props = getNoteProps(y);
  if (!props) return;

  const { origin, scale: noteScale, fontFamily, fillColor, content, align, alignV } = props;

  const layout = textLayoutCache.getNoteLayout(id, content, fontFamily);
  const derivedFontSize = getNoteDerivedFontSize(id);

  ctx.save();
  ctx.translate(origin[0], origin[1]);
  ctx.scale(noteScale, noteScale);

  // Body at base dimensions (shadow + fill rect) — always drawn, even during editing
  renderNoteBody(ctx, 0, 0, NOTE_WIDTH, NOTE_WIDTH, fillColor);

  if (useSelectionStore.getState().textEditingId === id) {
    ctx.restore();
    return;
  }

  // Text rendering at base dimensions
  const padding = getNotePadding(1);
  const contentWidth = getNoteContentWidth(1);
  const maxContentH = contentWidth;
  const { lineHeight } = layout;
  const baselineToTop = getBaselineToTopRatio(fontFamily) * derivedFontSize;
  const contentH = layout.lines.length * lineHeight;
  const vOffset = getNoteContentOffsetY(alignV, maxContentH, contentH);
  const textY = padding + vOffset + baselineToTop;
  const noteAnchorX = padding + anchorFactor(align) * contentWidth;
  const containerLeft = padding;
  const containerRight = padding + contentWidth;
  const hlR = derivedFontSize * 0.25;

  // Clip overflow (at min step + content overflows)
  const needsClip = contentH > maxContentH;
  if (needsClip) {
    ctx.beginPath();
    ctx.rect(padding, padding, contentWidth, maxContentH);
    ctx.clip();
  }

  ctx.textBaseline = 'alphabetic';

  for (const line of layout.lines) {
    if (line.runs.length === 0) continue;
    const lineY = textY + line.baselineY;
    const lineW = line.alignmentWidth;
    const startX = getLineStartX(noteAnchorX, contentWidth, lineW, align);

    // Pass 1: highlight rects
    for (const run of line.runs) {
      if (!run.highlight) continue;
      ctx.fillStyle = run.highlight;
      const hlX = startX + run.advanceX;
      const hlY = lineY - baselineToTop;
      const hlEnd = hlX + run.advanceWidth;
      const clL = Math.max(hlX, containerLeft);
      const clR = Math.min(hlEnd, containerRight);
      if (clR > clL) {
        const rL = clL > hlX ? 0 : hlR;
        const rR = clR < hlEnd ? 0 : hlR;
        ctx.beginPath();
        ctx.roundRect(clL, hlY, clR - clL, lineHeight, [rL, rR, rR, rL]);
        ctx.fill();
      }
    }

    // Pass 2: text
    ctx.fillStyle = '#1a1a1a';
    for (const run of line.runs) {
      ctx.font = run.font;
      ctx.fillText(run.text, startX + run.advanceX, lineY);
    }
  }

  ctx.restore();
}

function drawCode(ctx: CanvasRenderingContext2D, handle: ObjectHandle): void {
  const { id, y } = handle;

  // Skip rendering if currently being edited (DOM overlay handles it)
  const codeEditingId = useSelectionStore.getState().codeEditingId;
  if (codeEditingId === id) return;

  const props = getCodeProps(y);
  if (!props) return;

  const layout = codeSystem.getLayout(
    id,
    props.content,
    props.fontSize,
    props.width,
    props.language,
    props.lineNumbers,
  );
  const spans = codeSystem.getSpans(id);
  const lines = codeSystem.getSourceLines(id);
  const title = props.headerVisible ? (props.title ?? `Untitled.${CODE_EXTENSIONS[props.language]}`) : undefined;
  const output = props.outputVisible ? (props.output ?? '') : undefined;
  renderCodeLayout(ctx, layout, props.origin[0], props.origin[1], props.fontSize, spans, lines, title, output);
}

function drawImage(ctx: CanvasRenderingContext2D, handle: ObjectHandle): void {
  const frame = getFrame(handle.y);
  if (!frame) return;
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
    // Placeholder: light gray rect
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

  const color = getColor(y);
  const width = getWidth(y);
  const opacity = getOpacity(y);

  const cache = getObjectCacheInstance();
  const paths = cache.getConnectorPaths(id, handle);

  ctx.save();
  ctx.globalAlpha = opacity;

  // Pass 1: Stroke polyline with rounded caps/joins
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(paths.polyline);

  // Pass 2: Render arrows (fill + stroke for rounded corners)
  // Fixed lineWidth for consistent ~2.5 unit corner radius at all sizes
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = ARROW_ROUNDING_LINE_WIDTH;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  if (paths.startArrow) {
    ctx.fill(paths.startArrow);
    ctx.stroke(paths.startArrow);
  }
  if (paths.endArrow) {
    ctx.fill(paths.endArrow);
    ctx.stroke(paths.endArrow);
  }

  ctx.restore();
}

/**
 * Draw a connector from explicit points (for rerouted connectors during transforms).
 * Reads styles from handle.y, builds fresh paths from the given points.
 */
function drawConnectorFromPoints(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  points: [number, number][],
): void {
  if (points.length < 2) return;

  const { y } = handle;
  const color = getColor(y);
  const width = getWidth(y);
  const opacity = getOpacity(y);
  const startCap = getStartCap(y);
  const endCap = getEndCap(y);

  const paths = buildConnectorPaths({ points, strokeWidth: width, startCap, endCap });

  ctx.save();
  ctx.globalAlpha = opacity;

  // Pass 1: Stroke polyline
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(paths.polyline);

  // Pass 2: Arrows
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = ARROW_ROUNDING_LINE_WIDTH;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  if (paths.startArrow) {
    ctx.fill(paths.startArrow);
    ctx.stroke(paths.startArrow);
  }
  if (paths.endArrow) {
    ctx.fill(paths.endArrow);
    ctx.stroke(paths.endArrow);
  }

  ctx.restore();
}

function shouldSkipLOD(bbox: [number, number, number, number], view: ViewTransform): boolean {
  const [minX, minY, maxX, maxY] = bbox;
  const diagonal = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2);
  const screenDiagonal = diagonal * view.scale;
  return screenDiagonal < 2;
}

// Note: applySelectionTransform and computeUniformScale removed - replaced by
// context-aware rendering dispatch via renderSelectedObjectWithScaleTransform

/**
 * Draw shape with transform applied to frame (WYSIWYG - stroke width NOT scaled)
 */
function drawShapeWithTransform(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  transform: {
    kind: string;
    dx?: number;
    dy?: number;
    origin?: [number, number];
    scaleX?: number;
    scaleY?: number;
  },
): void {
  const { y } = handle;

  // Get original frame and compute transformed frame
  const frame = getFrame(y);
  if (!frame) return;

  const transformedFrame = applyTransformToFrame(frame, transform);

  // Skip render if dimensions collapsed to near-zero
  const [, , w, h] = transformedFrame;
  if (w < 0.001 || h < 0.001) return;

  // Get styling
  const shapeType = getShapeType(y);
  const fillColor = getFillColor(y);
  const color = getColor(y);
  const width = getWidth(y, 1);
  const opacity = getOpacity(y);

  // Build path from TRANSFORMED frame (not cached)
  const path = buildShapePathFromFrame(shapeType, transformedFrame);

  ctx.save();
  ctx.globalAlpha = opacity;

  if (fillColor) {
    ctx.fillStyle = fillColor;
    ctx.fill(path);
  }

  if (color && width > 0) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width; // ORIGINAL width - NOT scaled!
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  }

  if (hasLabel(handle.y)) drawShapeLabelWithFrame(ctx, handle, transformedFrame);

  ctx.restore();
}

// === Scale Transform Rendering Functions ===

/**
 * Draw stroke with scaled geometry and width using fresh PF outline.
 * This is the WYSIWYG preview - generates new Path2D each frame.
 *
 * Uses "copy-paste" flip behavior with position preservation:
 * - Position preserves relative arrangement in selection box
 * - Geometry uses absolute magnitude (NEVER inverted/mirrored)
 * - No threshold - immediate flip when dominant axis < 0
 */
function drawScaledStrokePreview(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  transform: ScaleTransform,
): void {
  const { y } = handle;
  const points = getPoints(y);
  const originalWidth = getWidth(y);
  const color = getColor(y);
  const opacity = getOpacity(y);
  const tool = getStrokeTool(y);

  if (!points?.length) return;

  const { origin, scaleX, scaleY, originBounds } = transform;

  // Apply uniform scale with position preservation (copy-paste flip behavior)
  const { points: scaledPoints, absScale } = applyUniformScaleToPoints(
    points,
    handle.bbox,
    originBounds,
    origin,
    scaleX,
    scaleY,
  );

  // Scale width for WYSIWYG
  const scaledWidth = originalWidth * absScale;

  // Generate FRESH PF outline (not cached)
  const outline = getStroke(scaledPoints, {
    ...PF_OPTIONS_BASE,
    size: scaledWidth,
    last: true,
  });

  const path = new Path2D(getSvgPathFromStroke(outline, false));

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.fillStyle = color;
  if (tool === 'highlighter') {
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.fill(path);
  ctx.restore();
}

/**
 * Draw shape with uniform scale and position preservation (for mixed + corner selection).
 * Uses center-based scaling with absScale (no geometry inversion) and preserved positions.
 */
function drawShapeWithUniformScale(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  transform: ScaleTransform,
): void {
  const { y } = handle;
  const frame = getFrame(y);
  if (!frame) return;

  const { scaleX, scaleY, origin, originBounds } = transform;

  // Apply uniform scale with position preservation (matches stroke behavior)
  const transformedFrame = applyUniformScaleToFrame(frame, originBounds, origin, scaleX, scaleY);

  // Skip render if dimensions collapsed to near-zero
  const [, , newW, newH] = transformedFrame;
  if (newW < 0.001 || newH < 0.001) return;

  // Get styling
  const shapeType = getShapeType(y);
  const fillColor = getFillColor(y);
  const color = getColor(y);
  const width = getWidth(y, 1);
  const opacity = getOpacity(y);

  // Build path from TRANSFORMED frame (not cached)
  const path = buildShapePathFromFrame(shapeType, transformedFrame);

  ctx.save();
  ctx.globalAlpha = opacity;

  if (fillColor) {
    ctx.fillStyle = fillColor;
    ctx.fill(path);
  }

  if (color && width > 0) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width; // ORIGINAL width - NOT scaled!
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  }

  if (hasLabel(handle.y)) drawShapeLabelWithFrame(ctx, handle, transformedFrame);

  ctx.restore();
}

/**
 * Draw text with uniform scale preview using ctx.scale on cached layout.
 * Font size is rounded to 3dp for WYSIWYG match with commit.
 */
function drawScaledTextPreview(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  transform: ScaleTransform,
): void {
  const textFrame = getTextFrame(handle.id);
  if (!textFrame) {
    drawText(ctx, handle);
    return;
  }

  const props = getTextProps(handle.y);
  if (!props) return;

  const { scaleX, scaleY, originBounds, origin } = transform;

  const uniformScale = computeUniformScaleNoThreshold(scaleX, scaleY);
  const rawAbsScale = Math.abs(uniformScale);
  if (rawAbsScale < 0.001) return;

  // Round fontSize → derive effective scale (mirrors commit exactly)
  const roundedFontSize = Math.round(props.fontSize * rawAbsScale * 1000) / 1000;
  const effectiveAbsScale = roundedFontSize / props.fontSize;

  // New center via position preservation (raw scale for continuous cursor tracking)
  const [fx, fy, fw, fh] = textFrame;
  const cx = fx + fw / 2;
  const cy = fy + fh / 2;
  const [newCx, newCy] = computePreservedPosition(cx, cy, originBounds, origin, uniformScale);

  // New frame with effective (rounded) dimensions
  const nfw = fw * effectiveAbsScale;
  const nfh = fh * effectiveAbsScale;
  const nfx = newCx - nfw / 2;
  const nfy = newCy - nfh / 2;

  // Derive virtual origin in new frame
  const newOriginX = nfx + anchorFactor(props.align) * nfw;
  const newOriginY = nfy + roundedFontSize * getBaselineToTopRatio(props.fontFamily);

  // Reuse cached layout — ctx.scale does the visual scaling
  const color = getColor(handle.y);
  const fillColor = getFillColor(handle.y);
  const layout = textLayoutCache.getLayout(
    handle.id,
    props.content,
    props.fontSize,
    props.fontFamily,
    props.width,
  );

  ctx.save();
  ctx.translate(newOriginX, newOriginY);
  ctx.scale(effectiveAbsScale, effectiveAbsScale);
  renderTextLayout(ctx, layout, 0, 0, color, props.align, fillColor);
  ctx.restore();
}

/**
 * Draw text with reflow preview from pre-computed layout/origin.
 */
function drawReflowedTextPreview(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  textReflow: TextReflowState,
): void {
  const layout = textReflow.layouts.get(handle.id);
  const reflowOrigin = textReflow.origins.get(handle.id);
  if (!layout || !reflowOrigin) {
    drawText(ctx, handle);
    return;
  }
  renderTextLayout(
    ctx,
    layout,
    reflowOrigin[0],
    reflowOrigin[1],
    getColor(handle.y),
    getAlign(handle.y),
    getFillColor(handle.y),
  );
}

/**
 * Draw code block with uniform scale preview using ctx.scale on cached layout.
 * Font size is rounded to 3dp for WYSIWYG match with commit.
 */
function drawScaledCodePreview(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  transform: ScaleTransform,
): void {
  const codeFrame = getCodeFrame(handle.id);
  if (!codeFrame) {
    drawCode(ctx, handle);
    return;
  }

  const props = getCodeProps(handle.y);
  if (!props) return;

  const { scaleX, scaleY, originBounds, origin } = transform;

  const uniformScale = computeUniformScaleNoThreshold(scaleX, scaleY);
  const rawAbsScale = Math.abs(uniformScale);
  if (rawAbsScale < 0.001) return;

  const roundedFontSize = Math.round(props.fontSize * rawAbsScale * 1000) / 1000;
  const effectiveAbsScale = roundedFontSize / props.fontSize;

  const [fx, fy, fw, fh] = codeFrame;
  const cx = fx + fw / 2;
  const cy = fy + fh / 2;
  const [newCx, newCy] = computePreservedPosition(cx, cy, originBounds, origin, uniformScale);

  const nfw = fw * effectiveAbsScale;
  const nfx = newCx - nfw / 2;
  const nfy = newCy - (fh * effectiveAbsScale) / 2;

  // Reuse cached layout — ctx.scale does the visual scaling
  const layout = codeSystem.getLayout(
    handle.id,
    props.content,
    props.fontSize,
    props.width,
    props.language,
    props.lineNumbers,
  );
  const spans = codeSystem.getSpans(handle.id);
  const lines = codeSystem.getSourceLines(handle.id);
  const title = props.headerVisible ? (props.title ?? `Untitled.${CODE_EXTENSIONS[props.language]}`) : undefined;
  const output = props.outputVisible ? (props.output ?? '') : undefined;

  ctx.save();
  ctx.translate(nfx, nfy);
  ctx.scale(effectiveAbsScale, effectiveAbsScale);
  renderCodeLayout(ctx, layout, 0, 0, props.fontSize, spans, lines, title, output);
  ctx.restore();
}

/**
 * Draw sticky note with uniform scale preview using ctx.scale.
 * Uses bbox center for position preservation (handles are at bbox positions).
 * drawStickyNote internally applies ctx.scale(noteScale) — nested scales compose.
 */
function drawScaledNotePreview(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  transform: ScaleTransform,
): void {
  const props = getNoteProps(handle.y);
  if (!props) {
    drawStickyNote(ctx, handle);
    return;
  }

  const { scaleX, scaleY, originBounds, origin } = transform;

  const uniformScale = computeUniformScaleNoThreshold(scaleX, scaleY);
  const absScale = Math.abs(uniformScale);
  if (absScale < 0.001) return;

  // Quantize to 3dp for consistency with commit
  const roundedScale = Math.round(props.scale * absScale * 1000) / 1000;
  const effectiveAbsScale = roundedScale / props.scale;

  // Use bbox center for position preservation
  const [bMinX, bMinY, bMaxX, bMaxY] = handle.bbox;
  const bcx = (bMinX + bMaxX) / 2;
  const bcy = (bMinY + bMaxY) / 2;
  const [newBcx, newBcy] = computePreservedPosition(bcx, bcy, originBounds, origin, uniformScale);

  const bboxW = bMaxX - bMinX;
  const bboxH = bMaxY - bMinY;
  const newBboxW = bboxW * effectiveAbsScale;
  const newBboxH = bboxH * effectiveAbsScale;
  const newBMinX = newBcx - newBboxW / 2;
  const newBMinY = newBcy - newBboxH / 2;
  const oxOff = props.origin[0] - bMinX;
  const oyOff = props.origin[1] - bMinY;
  const newOriginX = newBMinX + oxOff * effectiveAbsScale;
  const newOriginY = newBMinY + oyOff * effectiveAbsScale;

  // drawStickyNote does ctx.translate(origin)+ctx.scale(noteScale), so we
  // wrap it with the transform's uniform scale around the note's origin.
  ctx.save();
  ctx.translate(newOriginX, newOriginY);
  ctx.scale(effectiveAbsScale, effectiveAbsScale);
  ctx.translate(-props.origin[0], -props.origin[1]);
  drawStickyNote(ctx, handle);
  ctx.restore();
}

/**
 * Draw code block with reflow preview from pre-computed layout/origin.
 */
function drawReflowedCodePreview(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  codeReflow: CodeReflowState,
): void {
  const layout = codeReflow.layouts.get(handle.id);
  const reflowOrigin = codeReflow.origins.get(handle.id);
  if (!layout || !reflowOrigin) {
    drawCode(ctx, handle);
    return;
  }

  const props = getCodeProps(handle.y);
  if (!props) return;

  const spans = codeSystem.getSpans(handle.id);
  const lines = codeSystem.getSourceLines(handle.id);
  const title = props.headerVisible ? (props.title ?? `Untitled.${CODE_EXTENSIONS[props.language]}`) : undefined;
  const output = props.outputVisible ? (props.output ?? '') : undefined;
  renderCodeLayout(ctx, layout, reflowOrigin[0], reflowOrigin[1], props.fontSize, spans, lines, title, output);
}

/**
 * Context-aware scale transform rendering for selected objects.
 * Dispatches to correct rendering strategy based on selectionKind + handleKind.
 */
function renderSelectedObjectWithScaleTransform(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  transform: ScaleTransform,
  connTopology: ConnectorTopology | null,
  textReflow: TextReflowState | null,
  codeReflow: CodeReflowState | null,
): void {
  const { selectionKind, handleKind, handleId, origin, scaleX, scaleY, originBounds } = transform;

  // Connectors: draw from rerouted points (never stroke-scale)
  if (handle.kind === 'connector') {
    const points = connTopology?.reroutes.get(handle.id);
    if (points) {
      drawConnectorFromPoints(ctx, handle, points);
    } else {
      drawObject(ctx, handle); // Not in topology = static
    }
    return;
  }

  const isStroke = handle.kind === 'stroke';

  // CASE 1: Mixed + side + stroke = TRANSLATE ONLY
  if (selectionKind === 'mixed' && handleKind === 'side' && isStroke) {
    const { dx, dy } = computeStrokeTranslation(
      handle,
      originBounds,
      scaleX,
      scaleY,
      origin,
      handleId,
    );
    ctx.save();
    ctx.translate(dx, dy);
    drawObject(ctx, handle); // Use cached Path2D
    ctx.restore();
    return;
  }

  // CASE 2: Stroke scaling (strokesOnly OR mixed+corner) = PF-per-frame
  if (isStroke) {
    drawScaledStrokePreview(ctx, handle, transform);
    return;
  }

  // CASE 3: Image scaling — always uniform, except mixed+side = edge-pin translate
  if (handle.kind === 'image') {
    const frame = getFrame(handle.y);
    if (!frame) {
      drawObject(ctx, handle);
      return;
    }

    if (selectionKind === 'mixed' && handleKind === 'side') {
      // Edge-pin translate (no dimension change)
      const { dx, dy } = computeEdgePinTranslation(
        frame[0],
        frame[0] + frame[2],
        frame[1],
        frame[1] + frame[3],
        originBounds,
        scaleX,
        scaleY,
        origin,
        handleId,
      );
      ctx.save();
      ctx.translate(dx, dy);
      drawImage(ctx, handle);
      ctx.restore();
    } else {
      // Uniform scale for all other cases
      const transformedFrame = applyUniformScaleToFrame(
        frame,
        originBounds,
        origin,
        scaleX,
        scaleY,
      );
      const [, , tw, th] = transformedFrame;
      if (tw < 0.001 || th < 0.001) return;
      const assetId = getAssetId(handle.y);
      if (!assetId) return;
      const bitmap = getBitmap(assetId);
      const opacity = getOpacity(handle.y);
      ctx.save();
      ctx.globalAlpha = opacity;
      if (bitmap) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, transformedFrame[0], transformedFrame[1], tw, th);
      } else {
        ctx.fillStyle = '#f0f0f0';
        ctx.fillRect(transformedFrame[0], transformedFrame[1], tw, th);
      }
      ctx.restore();
    }
    return;
  }

  // CASE 4: Note scaling — always uniform, except mixed+side = edge-pin translate
  if (handle.kind === 'note') {
    if (selectionKind === 'mixed' && handleKind === 'side') {
      // Edge-pin: use bbox bounds (matches computeRawGeometryBounds)
      const [bMinX, bMinY, bMaxX, bMaxY] = handle.bbox;
      const { dx, dy } = computeEdgePinTranslation(
        bMinX, bMaxX, bMinY, bMaxY,
        originBounds, scaleX, scaleY, origin, handleId,
      );
      ctx.save();
      ctx.translate(dx, dy);
      drawStickyNote(ctx, handle);
      ctx.restore();
    } else {
      drawScaledNotePreview(ctx, handle, transform);
    }
    return;
  }

  // CASE 5: Shape scaling
  // Mixed + corner: uniform scale
  // Shapes-only or mixed+side: non-uniform scale (existing behavior)
  if (handle.kind === 'shape') {
    if (selectionKind === 'mixed' && handleKind === 'corner') {
      drawShapeWithUniformScale(ctx, handle, transform);
    } else {
      drawShapeWithTransform(ctx, handle, transform);
    }
    return;
  }

  // CASE 5: Text — corner/textOnly-N/S = uniform scale, E/W = reflow, mixed-N/S = edge-pin
  if (handle.kind === 'text') {
    if (
      handleKind === 'corner' ||
      ((handleId === 'n' || handleId === 's') && selectionKind === 'textOnly')
    ) {
      drawScaledTextPreview(ctx, handle, transform);
    } else if ((handleId === 'e' || handleId === 'w') && textReflow?.layouts.has(handle.id)) {
      drawReflowedTextPreview(ctx, handle, textReflow);
    } else if ((handleId === 'n' || handleId === 's') && selectionKind === 'mixed') {
      // Mixed + N/S: edge-pin translate
      const textFrame = getTextFrame(handle.id);
      if (textFrame) {
        const [fx, , fw, fh] = textFrame;
        const { dx, dy } = computeEdgePinTranslation(
          fx,
          fx + fw,
          textFrame[1],
          textFrame[1] + fh,
          originBounds,
          scaleX,
          scaleY,
          origin,
          handleId,
        );
        ctx.save();
        ctx.translate(dx, dy);
        drawText(ctx, handle);
        ctx.restore();
      } else {
        drawText(ctx, handle);
      }
    } else {
      drawText(ctx, handle);
    }
    return;
  }

  // CASE 6: Code — corner/codeOnly-N/S = uniform scale, E/W = reflow, mixed-N/S = edge-pin
  if (handle.kind === 'code') {
    if (
      handleKind === 'corner' ||
      ((handleId === 'n' || handleId === 's') && selectionKind === 'codeOnly')
    ) {
      drawScaledCodePreview(ctx, handle, transform);
    } else if ((handleId === 'e' || handleId === 'w') && codeReflow?.layouts.has(handle.id)) {
      drawReflowedCodePreview(ctx, handle, codeReflow);
    } else if ((handleId === 'n' || handleId === 's') && selectionKind === 'mixed') {
      const codeFrame = getCodeFrame(handle.id);
      if (codeFrame) {
        const [fx, , fw, fh] = codeFrame;
        const { dx, dy } = computeEdgePinTranslation(
          fx,
          fx + fw,
          codeFrame[1],
          codeFrame[1] + fh,
          originBounds,
          scaleX,
          scaleY,
          origin,
          handleId,
        );
        ctx.save();
        ctx.translate(dx, dy);
        drawCode(ctx, handle);
        ctx.restore();
      } else {
        drawCode(ctx, handle);
      }
    } else {
      drawCode(ctx, handle);
    }
    return;
  }

  // Fallback
  drawObject(ctx, handle);
}
