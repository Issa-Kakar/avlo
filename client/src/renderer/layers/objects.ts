import type { Snapshot, ViewTransform, ObjectHandle, IndexEntry } from '@avlo/shared';
import type { ViewportInfo } from '../types';
import type { HandleId } from '@/lib/tools/types';
import { getObjectCacheInstance } from '../object-cache';
import { getVisibleWorldBounds } from '@/canvas/internal/transforms';
import { useSelectionStore } from '@/stores/selection-store';

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

  // Calculate visible world bounds for culling
  const visibleBounds = getVisibleWorldBounds(viewport.cssWidth, viewport.cssHeight, viewTransform.scale, viewTransform.pan);

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

  let renderedCount = 0;
  let culledCount = 0;

  // Draw in ULID order (oldest first -> newest on top)
  for (const entry of sortedCandidates) {
    const handle = objectsById.get(entry.id);
    if (!handle) continue;

    // LOD check still needed (spatial query is coarse)
    if (shouldSkipLOD(handle.bbox, viewTransform)) {
      culledCount++;
      continue;
    }

    // === TRANSFORM SELECTED OBJECTS DURING ACTIVE TRANSFORM ===
    const isSelected = selectedSet.has(entry.id);
    const needsTransform = isTransforming && isSelected;

    if (needsTransform) {
      if (handle.kind === 'stroke' || handle.kind === 'connector') {
        // Strokes/Connectors: use canvas transform (uniform scale for strokes)
        // TODO: Strokes should eventually also be WYSIWYG, but that's more complex
        ctx.save();
        applySelectionTransform(ctx, transform, handle.kind);
        drawObject(ctx, handle);
        ctx.restore();
      } else if (handle.kind === 'shape') {
        // Shapes: WYSIWYG - compute transformed frame, draw with original stroke width
        drawShapeWithTransform(ctx, handle, transform);
      } else if (handle.kind === 'text') {
        // Text: WYSIWYG - compute transformed frame
        drawTextWithTransform(ctx, handle, transform);
      }
    } else {
      drawObject(ctx, handle);
    }
    renderedCount++;
  }

  // Development logging
  // Uncomment for debugging render layer performance
  console.log(
    `[Objects] Rendered ${renderedCount}/${sortedCandidates.length} candidates (${culledCount} LOD culled)`,
  );
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

  // Read style directly from Y.Map
  const color = (y.get('color') as string) ?? '#000';
  const opacity = (y.get('opacity') as number) ?? 1;
  const tool = (y.get('tool') as string) ?? 'pen';

  // Get cached geometry by ID
  const cache = getObjectCacheInstance();
  const path = cache.getOrBuild(id, handle);

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

  // Try new field names first, fall back to old for backward compatibility
  const fillColor = y.get('fillColor') as string | undefined;
  const color = (y.get('color') ?? y.get('strokeColor')) as string | undefined;
  const width = ((y.get('width') ?? y.get('strokeWidth')) as number) ?? 1;
  const opacity = (y.get('opacity') as number) ?? 1;

  const cache = getObjectCacheInstance();
  const path = cache.getOrBuild(id, handle);

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
  const frame = y.get('frame') as [number, number, number, number];
  const textContent = y.get('text');
  if (!frame || !textContent) return;

  const [x, y0, w] = frame;

  // Get text styling
  const color = (y.get('color') as string) ?? '#000';
  const fontSize = (y.get('fontSize') as number) ?? 16;
  const fontFamily = (y.get('fontFamily') as string) ?? 'sans-serif';
  const fontWeight = (y.get('fontWeight') as string) ?? 'normal';
  const fontStyle = (y.get('fontStyle') as string) ?? 'normal';
  const textAlign = (y.get('textAlign') as string) ?? 'left';
  const opacity = (y.get('opacity') as number) ?? 1;

  // Get text content - handle Y.Text
  let text = '';
  if (typeof textContent === 'string') {
    text = textContent;
  } else if (textContent && typeof textContent.toString === 'function') {
    text = textContent.toString();
  }

  if (!text) return;

  ctx.save();
  ctx.globalAlpha = opacity;

  // Set up text styling
  ctx.fillStyle = color;
  ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
  ctx.textAlign = textAlign as unknown as 'left' | 'center' | 'right';
  ctx.textBaseline = 'top';

  // Calculate text position based on alignment
  let textX = x;
  if (textAlign === 'center') {
    textX = x + w / 2;
  } else if (textAlign === 'right') {
    textX = x + w;
  }

  // Simple text wrapping
  const lines = wrapText(ctx, text, w);
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

  const color = (y.get('color') as string) ?? '#000';
  const width = (y.get('width') as number) ?? 2;
  const opacity = (y.get('opacity') as number) ?? 1;

  const cache = getObjectCacheInstance();
  const path = cache.getOrBuild(id, handle);

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(path);
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

/**
 * Apply selection transform to canvas context for WYSIWYG preview
 * Strokes ALWAYS scale uniformly, shapes can scale non-uniformly
 */
function applySelectionTransform(
  ctx: CanvasRenderingContext2D,
  transform: { kind: string; dx?: number; dy?: number; origin?: [number, number]; scaleX?: number; scaleY?: number; handleId?: HandleId },
  objectKind: 'stroke' | 'shape' | 'text' | 'connector'
): void {
  if (transform.kind === 'translate' && transform.dx !== undefined && transform.dy !== undefined) {
    ctx.translate(transform.dx, transform.dy);
  } else if (transform.kind === 'scale' && transform.origin && transform.scaleX !== undefined && transform.scaleY !== undefined) {
    const [ox, oy] = transform.origin;
    let sx = transform.scaleX;
    let sy = transform.scaleY;

    // Strokes and connectors ALWAYS scale uniformly
    if (objectKind === 'stroke' || objectKind === 'connector') {
      const uniformScale = computeUniformScale(sx, sy, transform.handleId);
      sx = uniformScale;
      sy = uniformScale;
    }

    ctx.translate(ox, oy);
    ctx.scale(sx, sy);
    ctx.translate(-ox, -oy);
  }
}

/**
 * Compute uniform scale for strokes/connectors
 * Side handles use primary axis, corners use max
 */
function computeUniformScale(scaleX: number, scaleY: number, handleId?: HandleId): number {
  if (!handleId) {
    // Default: use max scale (preserves sign from scaleX)
    return Math.sign(scaleX || 1) * Math.max(Math.abs(scaleX), Math.abs(scaleY));
  }

  switch (handleId) {
    case 'e': case 'w': return scaleX;  // Horizontal: X is primary
    case 'n': case 's': return scaleY;  // Vertical: Y is primary
    default:
      // Corners: use max scale
      return Math.sign(scaleX || 1) * Math.max(Math.abs(scaleX), Math.abs(scaleY));
  }
}

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
  const frame = y.get('frame') as [number, number, number, number];
  if (!frame) return;

  const transformedFrame = applyTransformToFrame(frame, transform);

  // Get styling from Y.Map
  const shapeType = (y.get('shapeType') as string) || 'rect';
  const fillColor = y.get('fillColor') as string | undefined;
  const color = (y.get('color') ?? y.get('strokeColor')) as string | undefined;
  const width = ((y.get('width') ?? y.get('strokeWidth')) as number) ?? 1;
  const opacity = (y.get('opacity') as number) ?? 1;

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
  const frame = y.get('frame') as [number, number, number, number];
  const textContent = y.get('text');
  if (!frame || !textContent) return;

  const transformedFrame = applyTransformToFrame(frame, transform);
  const [x, y0, w] = transformedFrame;

  // Get text styling
  const color = (y.get('color') as string) ?? '#000';
  const fontSize = (y.get('fontSize') as number) ?? 16;
  const fontFamily = (y.get('fontFamily') as string) ?? 'sans-serif';
  const fontWeight = (y.get('fontWeight') as string) ?? 'normal';
  const fontStyle = (y.get('fontStyle') as string) ?? 'normal';
  const textAlign = (y.get('textAlign') as string) ?? 'left';
  const opacity = (y.get('opacity') as number) ?? 1;

  // Get text content
  let text = '';
  if (typeof textContent === 'string') {
    text = textContent;
  } else if (textContent && typeof textContent.toString === 'function') {
    text = textContent.toString();
  }

  if (!text) return;

  ctx.save();
  ctx.globalAlpha = opacity;

  // Set up text styling - font size NOT scaled
  ctx.fillStyle = color;
  ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
  ctx.textAlign = textAlign as unknown as 'left' | 'center' | 'right';
  ctx.textBaseline = 'top';

  // Calculate text position based on alignment
  let textX = x;
  if (textAlign === 'center') {
    textX = x + w / 2;
  } else if (textAlign === 'right') {
    textX = x + w;
  }

  // Simple text wrapping
  const lines = wrapText(ctx, text, w);
  const lineHeight = fontSize * 1.2;

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], textX, y0 + i * lineHeight);
  }

  ctx.restore();
}