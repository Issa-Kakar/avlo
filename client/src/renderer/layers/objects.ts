import type { Snapshot, ViewTransform, ObjectHandle, IndexEntry } from '@avlo/shared';
import {
  getColor,
  getOpacity,
  getWidth,
  getPoints,
  getFrame,
  getShapeType,
  getFillColor,
  getText,
  getFontSize,
  getFontFamily,
  getFontWeight,
  getFontStyle,
  getTextAlignH,
  getStrokeTool,
} from '@avlo/shared';
import type { ViewportInfo } from '../types';
import { getObjectCacheInstance } from '../object-cache';
import { ARROW_ROUNDING_LINE_WIDTH } from '@/lib/connectors/connector-paths';
import { getVisibleWorldBounds } from '@/stores/camera-store';
import { useSelectionStore, type ScaleTransform } from '@/stores/selection-store';
import {
  computeUniformScaleNoThreshold,
  computePreservedPosition,
  computeStrokeTranslation,
} from '@/lib/geometry/scale-transform';
import { getStroke } from 'perfect-freehand';
import { PF_OPTIONS_BASE, getSvgPathFromStroke } from '../types';

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

  // Calculate visible world bounds for culling (reads from camera store)
  const visibleBounds = getVisibleWorldBounds();

  // Use spatial index for efficient querying
  let candidateEntries: IndexEntry[];

  if (viewport.clipRegion?.worldRects) {
    // OPTIMIZATION: Query each dirty rect and union results
    const entrySet = new Map<string, IndexEntry>();

    for (const rect of viewport.clipRegion.worldRects) {
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
        // Translation: use ctx.translate with cached Path2D for all objects
        ctx.save();
        ctx.translate(transform.dx, transform.dy);
        drawObject(ctx, handle);
        ctx.restore();
      } else if (transform.kind === 'scale') {
        // Scale: context-aware rendering based on selectionKind and handleKind
        renderSelectedObjectWithScaleTransform(ctx, handle, transform);
      } else {
        drawObject(ctx, handle);
      }
    } else {
      drawObject(ctx, handle);
    }
  }
}

function drawObject(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
): void {
  switch (handle.kind) {
    case 'stroke':
      drawStroke(ctx, handle);
      break;
    case 'shape':
      drawShape(ctx, handle);
      break;
    case 'text':
      drawTextBox(ctx, handle);
      break;
    case 'connector':
      drawConnector(ctx, handle);
      break;
  }
}

function drawStroke(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
): void {
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

function drawShape(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
): void {
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

  ctx.restore();
}

function drawTextBox(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
): void {
  const { y } = handle;

  // Get frame and text content
  const frame = getFrame(y);
  const textContent = getText(y);
  if (!frame || !textContent) return;

  const [x, y0, w] = frame;

  // Get text styling
  const color = getColor(y);
  const fontSize = getFontSize(y);
  const fontFamily = getFontFamily(y);
  const fontWeight = getFontWeight(y);
  const fontStyle = getFontStyle(y);
  const textAlign = getTextAlignH(y);
  const opacity = getOpacity(y);

  ctx.save();
  ctx.globalAlpha = opacity;

  // Set up text styling
  ctx.fillStyle = color;
  ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
  ctx.textAlign = textAlign as 'left' | 'center' | 'right';
  ctx.textBaseline = 'top';

  // Calculate text position based on alignment
  let textX = x;
  if (textAlign === 'center') {
    textX = x + w / 2;
  } else if (textAlign === 'right') {
    textX = x + w;
  }

  // Simple text wrapping
  const lines = wrapText(ctx, textContent, w);
  const lineHeight = fontSize * 1.2;

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], textX, y0 + i * lineHeight);
  }

  ctx.restore();
}

function drawConnector(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
): void {
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

// Helper function for text wrapping
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const metrics = ctx.measureText(testLine);

    if (metrics.width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

function shouldSkipLOD(
  bbox: [number, number, number, number],
  view: ViewTransform
): boolean {
  const [minX, minY, maxX, maxY] = bbox;
  const diagonal = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2);
  const screenDiagonal = diagonal * view.scale;
  return screenDiagonal < 2;
}

// Note: applySelectionTransform and computeUniformScale removed - replaced by
// context-aware rendering dispatch via renderSelectedObjectWithScaleTransform

/**
 * Apply transform to frame mathematically (no canvas transform)
 */
function applyTransformToFrame(
  frame: [number, number, number, number],
  transform: { kind: string; dx?: number; dy?: number; origin?: [number, number]; scaleX?: number; scaleY?: number }
): [number, number, number, number] {
  const [x, y, w, h] = frame;

  if (transform.kind === 'translate' && transform.dx !== undefined && transform.dy !== undefined) {
    return [x + transform.dx, y + transform.dy, w, h];
  }

  if (transform.kind === 'scale' && transform.origin && transform.scaleX !== undefined && transform.scaleY !== undefined) {
    const [ox, oy] = transform.origin;
    const { scaleX, scaleY } = transform;

    // Scale corners around origin
    const newX1 = ox + (x - ox) * scaleX;
    const newY1 = oy + (y - oy) * scaleY;
    const newX2 = ox + ((x + w) - ox) * scaleX;
    const newY2 = oy + ((y + h) - oy) * scaleY;

    return [
      Math.min(newX1, newX2),
      Math.min(newY1, newY2),
      Math.abs(newX2 - newX1),
      Math.abs(newY2 - newY1),
    ];
  }

  return frame;
}

/**
 * Build shape path from explicit frame (not from cache)
 */
function buildShapePathFromFrame(shapeType: string, frame: [number, number, number, number]): Path2D {
  const [x, y0, w, h] = frame;
  const path = new Path2D();

  switch (shapeType) {
    case 'rect':
      path.rect(x, y0, w, h);
      break;
    case 'ellipse':
      path.ellipse(x + w / 2, y0 + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    case 'diamond': {
      const cx = x + w / 2;
      const cy = y0 + h / 2;
      const radius = Math.min(20, Math.min(w, h) * 0.1);
      path.moveTo(cx + w / 4, y0 + h / 4);
      path.arcTo(x + w, cy, cx, y0 + h, radius);
      path.arcTo(cx, y0 + h, x, cy, radius);
      path.arcTo(x, cy, cx, y0, radius);
      path.arcTo(cx, y0, x + w, cy, radius);
      path.closePath();
      break;
    }
    case 'roundedRect': {
      const radius = Math.min(20, w * 0.1, h * 0.1);
      // Inline roundedRect helper
      path.moveTo(x + radius, y0);
      path.lineTo(x + w - radius, y0);
      path.quadraticCurveTo(x + w, y0, x + w, y0 + radius);
      path.lineTo(x + w, y0 + h - radius);
      path.quadraticCurveTo(x + w, y0 + h, x + w - radius, y0 + h);
      path.lineTo(x + radius, y0 + h);
      path.quadraticCurveTo(x, y0 + h, x, y0 + h - radius);
      path.lineTo(x, y0 + radius);
      path.quadraticCurveTo(x, y0, x + radius, y0);
      break;
    }
    default:
      path.rect(x, y0, w, h);
  }

  return path;
}

/**
 * Draw shape with transform applied to frame (WYSIWYG - stroke width NOT scaled)
 */
function drawShapeWithTransform(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  transform: { kind: string; dx?: number; dy?: number; origin?: [number, number]; scaleX?: number; scaleY?: number }
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
    ctx.lineWidth = width;  // ORIGINAL width - NOT scaled!
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  }

  ctx.restore();
}

/**
 * Draw text with transform applied to frame (WYSIWYG)
 */
function drawTextWithTransform(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  transform: { kind: string; dx?: number; dy?: number; origin?: [number, number]; scaleX?: number; scaleY?: number }
): void {
  const { y } = handle;

  // Get original frame and compute transformed frame
  const frame = getFrame(y);
  const textContent = getText(y);
  if (!frame || !textContent) return;

  const transformedFrame = applyTransformToFrame(frame, transform);
  const [x, y0, w] = transformedFrame;

  // Get text styling
  const color = getColor(y);
  const fontSize = getFontSize(y);
  const fontFamily = getFontFamily(y);
  const fontWeight = getFontWeight(y);
  const fontStyle = getFontStyle(y);
  const textAlign = getTextAlignH(y);
  const opacity = getOpacity(y);

  ctx.save();
  ctx.globalAlpha = opacity;

  // Set up text styling - font size NOT scaled
  ctx.fillStyle = color;
  ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
  ctx.textAlign = textAlign as 'left' | 'center' | 'right';
  ctx.textBaseline = 'top';

  // Calculate text position based on alignment
  let textX = x;
  if (textAlign === 'center') {
    textX = x + w / 2;
  } else if (textAlign === 'right') {
    textX = x + w;
  }

  // Simple text wrapping
  const lines = wrapText(ctx, textContent, w);
  const lineHeight = fontSize * 1.2;

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], textX, y0 + i * lineHeight);
  }

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
  transform: ScaleTransform
): void {
  const { y } = handle;
  const points = getPoints(y);
  const originalWidth = getWidth(y);
  const color = getColor(y);
  const opacity = getOpacity(y);
  const tool = getStrokeTool(y);

  if (!points?.length) return;

  const { origin, scaleX, scaleY, originBounds } = transform;

  // Get stroke center from bbox
  const [minX, minY, maxX, maxY] = handle.bbox;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  // Compute uniform scale with SNAP behavior (no threshold)
  const uniformScale = computeUniformScaleNoThreshold(scaleX, scaleY);
  const absScale = Math.abs(uniformScale);

  // Position preserves relative arrangement (no position swap on flip)
  const [newCx, newCy] = computePreservedPosition(cx, cy, originBounds, origin, uniformScale);

  // Transform points: scale around original center, position at new center
  // Geometry uses absolute scale (NO inversion - copy-paste behavior)
  const scaledPoints: [number, number][] = points.map(([x, yCoord]) => [
    newCx + (x - cx) * absScale,
    newCy + (yCoord - cy) * absScale,
  ]);

  // Scale width for WYSIWYG
  const scaledWidth = originalWidth * absScale;

  // Generate FRESH PF outline (not cached)
  const outline = getStroke(scaledPoints, {
    ...PF_OPTIONS_BASE,
    size: scaledWidth,
    last: true,
  });

  const path = new Path2D(getSvgPathFromStroke(outline, false));

  console.debug(`drawScaledStrokePreview: ${handle.id}`);

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
  transform: ScaleTransform
): void {
  const { y } = handle;
  const frame = getFrame(y);
  if (!frame) return;

  const [x, frameY, w, h] = frame;
  const { scaleX, scaleY, origin, originBounds } = transform;

  // Compute center and uniform scale
  const cx = x + w / 2;
  const cy = frameY + h / 2;
  const uniformScale = computeUniformScaleNoThreshold(scaleX, scaleY);
  const absScale = Math.abs(uniformScale);

  // Position preserves relative arrangement (no position swap on flip)
  const [newCx, newCy] = computePreservedPosition(cx, cy, originBounds, origin, uniformScale);

  // Dimensions use absolute scale (no geometry inversion)
  const newW = w * absScale;
  const newH = h * absScale;

  // Compute transformed frame from center
  const transformedFrame: [number, number, number, number] = [
    newCx - newW / 2,
    newCy - newH / 2,
    newW,
    newH,
  ];

  // Skip render if dimensions collapsed to near-zero
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
    ctx.lineWidth = width;  // ORIGINAL width - NOT scaled!
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  }

  ctx.restore();
}

/**
 * Draw text with uniform scale and position preservation (for mixed + corner selection).
 * Uses center-based scaling with absScale (no geometry inversion) and preserved positions.
 */
function drawTextWithUniformScale(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  transform: ScaleTransform
): void {
  const { y } = handle;
  const frame = getFrame(y);
  const textContent = getText(y);
  if (!frame || !textContent) return;

  const [x, frameY, w, h] = frame;
  const { scaleX, scaleY, origin, originBounds } = transform;

  // Compute center and uniform scale
  const cx = x + w / 2;
  const cy = frameY + h / 2;
  const uniformScale = computeUniformScaleNoThreshold(scaleX, scaleY);
  const absScale = Math.abs(uniformScale);

  // Position preserves relative arrangement (no position swap on flip)
  const [newCx, newCy] = computePreservedPosition(cx, cy, originBounds, origin, uniformScale);

  // Dimensions use absolute scale (no geometry inversion)
  const newW = w * absScale;
  const newH = h * absScale;

  // Compute transformed frame from center
  const transformedX = newCx - newW / 2;
  const transformedY = newCy - newH / 2;

  // Get text styling
  const color = getColor(y);
  const fontSize = getFontSize(y);
  const fontFamily = getFontFamily(y);
  const fontWeight = getFontWeight(y);
  const fontStyle = getFontStyle(y);
  const textAlign = getTextAlignH(y);
  const opacity = getOpacity(y);

  ctx.save();
  ctx.globalAlpha = opacity;

  // Set up text styling - font size NOT scaled
  ctx.fillStyle = color;
  ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
  ctx.textAlign = textAlign as 'left' | 'center' | 'right';
  ctx.textBaseline = 'top';

  // Compute X position based on text alignment
  let textX = transformedX;
  if (textAlign === 'center') {
    textX = transformedX + newW / 2;
  } else if (textAlign === 'right') {
    textX = transformedX + newW;
  }

  ctx.fillText(textContent, textX, transformedY);
  ctx.restore();
}

/**
 * Context-aware scale transform rendering for selected objects.
 * Dispatches to correct rendering strategy based on selectionKind + handleKind.
 */
function renderSelectedObjectWithScaleTransform(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  transform: ScaleTransform
): void {
  const { selectionKind, handleKind, handleId, origin, scaleX, scaleY, originBounds } = transform;
  const isStroke = handle.kind === 'stroke' || handle.kind === 'connector';

  // CASE 1: Mixed + side + stroke = TRANSLATE ONLY
  if (selectionKind === 'mixed' && handleKind === 'side' && isStroke) {
    const { dx, dy } = computeStrokeTranslation(handle, originBounds, scaleX, scaleY, origin, handleId);
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

  // CASE 3: Shape scaling
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

  // CASE 4: Text
  if (handle.kind === 'text') {
    if (selectionKind === 'mixed' && handleKind === 'corner') {
      drawTextWithUniformScale(ctx, handle, transform);
    } else {
      drawTextWithTransform(ctx, handle, transform);
    }
    return;
  }

  // Fallback
  drawObject(ctx, handle);
}