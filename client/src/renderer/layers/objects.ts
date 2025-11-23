import type { Snapshot, ViewTransform, ObjectHandle, IndexEntry } from '@avlo/shared';
import type { ViewportInfo } from '../types';
import { getObjectCacheInstance } from '../object-cache';
import { getVisibleWorldBounds } from '@/canvas/internal/transforms';

export function drawObjects(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  viewTransform: ViewTransform,
  viewport: ViewportInfo,
): void {
  const { spatialIndex, objectsById } = snapshot;
  if (!spatialIndex) return;

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
    drawObject(ctx, handle);
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