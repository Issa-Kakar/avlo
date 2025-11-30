import type { Snapshot, ViewTransform, ObjectHandle, IndexEntry } from '@avlo/shared';
import type { ViewportInfo } from '../types';
import type { HandleId } from '@/lib/tools/types';
import { getObjectCacheInstance } from '../object-cache';
import { getVisibleWorldBounds } from '@/canvas/internal/transforms';
import { useSelectionStore, type ScaleTransform, type WorldRect } from '@/stores/selection-store';
import { getStroke } from 'perfect-freehand';
import { getSvgPathFromStroke } from '../stroke-builder/pf-svg';
import { PF_OPTIONS_BASE } from '../stroke-builder/pf-config';

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
  const frame = y.get('frame') as [number, number, number, number];
  if (!frame) return;

  const transformedFrame = applyTransformToFrame(frame, transform);

  // Skip render if dimensions collapsed to near-zero
  const [, , w, h] = transformedFrame;
  if (w < 0.001 || h < 0.001) return;

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

// === Scale Transform Rendering Functions ===

/**
 * Compute translation for stroke in mixed + side scenario.
 * Uses edge-pinning logic:
 * - Anchor strokes (those that define the anchor edge) stay pinned
 * - On scale flip (negative), anchor strokes shift to define the opposite edge
 * - Interior strokes translate proportionally based on origin
 */
function computeStrokeTranslationForRender(
  handle: ObjectHandle,
  originBounds: WorldRect,
  scaleX: number,
  scaleY: number,
  origin: [number, number],
  handleId: HandleId
): { dx: number; dy: number } {
  // Get stroke geometry (not bbox with width inflation)
  const points = handle.y.get('points') as [number, number][] | undefined;
  if (!points || points.length === 0) return { dx: 0, dy: 0 };

  // Compute geometry bounds
  let minX = points[0][0], maxX = points[0][0];
  let minY = points[0][1], maxY = points[0][1];
  for (const [px, py] of points) {
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const [ox, oy] = origin;

  const EPS = 1e-3;
  const isHorizontal = handleId === 'e' || handleId === 'w';
  const isVertical = handleId === 'n' || handleId === 's';

  let dx = 0;
  let dy = 0;

  if (isHorizontal) {
    // E handle: anchor at minX (west edge), W handle: anchor at maxX (east edge)
    const anchorX = handleId === 'e' ? originBounds.minX : originBounds.maxX;

    const touchesLeft = Math.abs(minX - anchorX) < EPS;
    const touchesRight = Math.abs(maxX - anchorX) < EPS;
    const isAnchor = touchesLeft || touchesRight;

    if (isAnchor) {
      if (scaleX >= 0) {
        // Pre-flip: pin original touching edge
        const edgeX = touchesLeft ? minX : maxX;
        dx = anchorX - edgeX; // ≈ 0 since edge ≈ anchor
      } else {
        // Post-flip: pin opposite edge (shift by stroke width)
        const edgeX = touchesLeft ? maxX : minX;
        dx = anchorX - edgeX;
      }
      dy = 0;
    } else {
      // Interior stroke → origin-based translation
      const newCx = ox + (cx - ox) * scaleX;
      dx = newCx - cx;
      dy = 0;
    }
  } else if (isVertical) {
    // S handle: anchor at minY (top edge), N handle: anchor at maxY (bottom edge)
    const anchorY = handleId === 's' ? originBounds.minY : originBounds.maxY;

    const touchesTop = Math.abs(minY - anchorY) < EPS;
    const touchesBottom = Math.abs(maxY - anchorY) < EPS;
    const isAnchor = touchesTop || touchesBottom;

    if (isAnchor) {
      if (scaleY >= 0) {
        const edgeY = touchesTop ? minY : maxY;
        dy = anchorY - edgeY;
      } else {
        const edgeY = touchesTop ? maxY : minY;
        dy = anchorY - edgeY;
      }
      dx = 0;
    } else {
      const newCy = oy + (cy - oy) * scaleY;
      dx = 0;
      dy = newCy - cy;
    }
  } else {
    // Corner handle (shouldn't reach here for mixed+side, but fallback)
    const newCx = ox + (cx - ox) * scaleX;
    const newCy = oy + (cy - oy) * scaleY;
    dx = newCx - cx;
    dy = newCy - cy;
  }

  return { dx, dy };
}

/**
 * Compute uniform scale for strokes with context-aware flip logic.
 *
 * FLIP RULES:
 * 1. CORNER + DIAGONAL (both axes negative): Immediate flip - user is dragging past origin
 * 2. CORNER + SIDEWAYS (one axis negative, dragging perpendicular): Use -1.0 threshold
 * 3. SIDE HANDLES: Immediate flip when active axis < 0 (direct axis drag)
 */
function _computeUniformScaleForRender(scaleX: number, scaleY: number): number {
  const absX = Math.abs(scaleX);
  const absY = Math.abs(scaleY);
  const STROKE_MIN = 0.001;

  // ============================================
  // CORNER HANDLES: Check "both negative" FIRST
  // ============================================
  // If BOTH axes are negative, user is dragging diagonally past origin
  // → Flip IMMEDIATELY, no threshold needed
  if (scaleX < 0 && scaleY < 0) {
    const magnitude = Math.max(absX, absY, STROKE_MIN);
    return -magnitude;
  }

  // ============================================
  // SIDE HANDLES: Immediate flip when < 0
  // ============================================
  // Side handles are DIRECT axis drags, not sideways - flip immediately
  if (scaleY === 1 && scaleX !== 1) {
    // Horizontal side handle (E/W) - X axis is active
    const magnitude = Math.max(absX, STROKE_MIN);
    return scaleX < 0 ? -magnitude : magnitude;
  }
  if (scaleX === 1 && scaleY !== 1) {
    // Vertical side handle (N/S) - Y axis is active
    const magnitude = Math.max(absY, STROKE_MIN);
    return scaleY < 0 ? -magnitude : magnitude;
  }

  // ============================================
  // CORNER HANDLES: Sideways drag (one axis negative, one positive)
  // ============================================
  // User is dragging perpendicular to resize direction
  // Use -1.0 threshold to prevent accidental flips
  const magnitude = Math.max(absX, absY, STROKE_MIN);
  const dominantScale = absX >= absY ? scaleX : scaleY;

  if (dominantScale <= -1.0) {
    return -magnitude;
  }

  return magnitude;
}

/**
 * Compute uniform scale with NO threshold - immediate flip when dominant < 0.
 * Used for stroke "copy-paste" behavior where we want snap positioning.
 */
function computeUniformScaleNoThreshold(scaleX: number, scaleY: number): number {
  const absX = Math.abs(scaleX);
  const absY = Math.abs(scaleY);
  const STROKE_MIN = 0.001;
  const magnitude = Math.max(absX, absY, STROKE_MIN);

  // Both negative → immediate flip
  if (scaleX < 0 && scaleY < 0) {
    return -magnitude;
  }

  // Side handles → immediate flip when < 0
  if (scaleY === 1 && scaleX !== 1) {
    return scaleX < 0 ? -magnitude : magnitude;
  }
  if (scaleX === 1 && scaleY !== 1) {
    return scaleY < 0 ? -magnitude : magnitude;
  }

  // Corner drag → immediate flip when dominant < 0 (NO threshold)
  const dominantScale = absX >= absY ? scaleX : scaleY;
  return dominantScale < 0 ? -magnitude : magnitude;
}

/**
 * Compute position that preserves relative arrangement in selection box.
 * When flipping, objects maintain their relative position (0-1) within the box
 * instead of inverting (close-to-origin becomes far-from-origin).
 */
function computePreservedPosition(
  cx: number,
  cy: number,
  originBounds: WorldRect,
  origin: [number, number],
  uniformScale: number
): [number, number] {
  const [ox, oy] = origin;
  const { minX, minY, maxX, maxY } = originBounds;
  const boxWidth = maxX - minX;
  const boxHeight = maxY - minY;

  // Relative position in original box (0-1)
  const tx = boxWidth > 0 ? (cx - minX) / boxWidth : 0.5;
  const ty = boxHeight > 0 ? (cy - minY) / boxHeight : 0.5;

  // Compute new box corners (both transform around origin)
  const newCorner1X = ox + (minX - ox) * uniformScale;
  const newCorner1Y = oy + (minY - oy) * uniformScale;
  const newCorner2X = ox + (maxX - ox) * uniformScale;
  const newCorner2Y = oy + (maxY - oy) * uniformScale;

  // Get actual min/max (handles flip)
  const newMinX = Math.min(newCorner1X, newCorner2X);
  const newMinY = Math.min(newCorner1Y, newCorner2Y);
  const newBoxWidth = Math.abs(newCorner2X - newCorner1X);
  const newBoxHeight = Math.abs(newCorner2Y - newCorner1Y);

  // Apply same relative position in new box
  return [newMinX + tx * newBoxWidth, newMinY + ty * newBoxHeight];
}

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
  const points = y.get('points') as [number, number][];
  const originalWidth = (y.get('width') as number) ?? 2;
  const color = (y.get('color') as string) ?? '#000';
  const opacity = (y.get('opacity') as number) ?? 1;
  const tool = (y.get('tool') as string) ?? 'pen';

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
  const frame = y.get('frame') as [number, number, number, number];
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
 * Draw text with uniform scale and position preservation (for mixed + corner selection).
 * Uses center-based scaling with absScale (no geometry inversion) and preserved positions.
 */
function drawTextWithUniformScale(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  transform: ScaleTransform
): void {
  const { y } = handle;
  const frame = y.get('frame') as [number, number, number, number];
  const textContent = y.get('text');
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
  ctx.textAlign = textAlign as 'left' | 'center' | 'right';
  ctx.textBaseline = 'top';

  // Compute X position based on text alignment
  let textX = transformedX;
  if (textAlign === 'center') {
    textX = transformedX + newW / 2;
  } else if (textAlign === 'right') {
    textX = transformedX + newW;
  }

  ctx.fillText(text, textX, transformedY);
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
    const { dx, dy } = computeStrokeTranslationForRender(handle, originBounds, scaleX, scaleY, origin, handleId);
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