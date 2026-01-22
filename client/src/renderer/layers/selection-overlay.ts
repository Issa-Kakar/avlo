/**
 * Selection Overlay Rendering
 *
 * Handles all visual elements of the selection preview:
 * 1. Object highlights (blue outlines around selected objects)
 * 2. Marquee rectangle (dashed selection box during drag)
 * 3. Selection box with resize handles
 *
 * CRITICAL: This is called INSIDE world transform scope.
 * The context has the world transform already applied when this is called.
 * Preview coordinates are in world space and will be transformed to canvas automatically.
 *
 * @module renderer/layers/selection-overlay
 */

import type { SelectionPreview, HandleId } from '@/lib/tools/types';
import type { Snapshot } from '@avlo/shared';
import { getFrame } from '@avlo/shared';
import { getObjectCacheInstance } from '../object-cache';

// =============================================================================
// STYLING CONSTANTS
// =============================================================================

const SELECTION_STYLE = {
  // Colors - Blue-700 based palette for deeper, more refined selection
  /** Primary selection color (blue-700) */
  PRIMARY: 'rgba(29, 78, 216, 1)',
  /** Fill for marquee - darker for better visibility */
  PRIMARY_FILL: 'rgba(29, 78, 216, 0.15)',
  /** Muted stroke for marquee */
  PRIMARY_MUTED: 'rgba(29, 78, 216, 0.7)',

  // Stroke widths (screen pixels)
  /** Object highlight stroke width */
  HIGHLIGHT_WIDTH: 2,
  /** Selection box stroke width */
  BOX_WIDTH: 2,
  /** Marquee stroke width */
  MARQUEE_WIDTH: 1.5,

  // Handle config - circular handles with shadow and subtle outline
  /** Handle radius in screen pixels (10px diameter) */
  HANDLE_RADIUS_PX: 6,
  /** Handle fill - subtle off-white (98% white, avoids blending with pure white backgrounds) */
  HANDLE_FILL: 'rgb(250, 250, 250)',
  /** Handle stroke - matches shadow tone for cohesion */
  HANDLE_STROKE: 'rgba(0, 0, 0, 0.25)',
  /** Handle stroke width - thicker for better edge definition */
  HANDLE_STROKE_WIDTH_PX: 2.5,

  // Handle shadow for depth effect
  /** Shadow color for floating handle effect */
  HANDLE_SHADOW_COLOR: 'rgba(0, 0, 0, 0.25)',
  /** Shadow blur radius */
  HANDLE_SHADOW_BLUR_PX: 4,
  /** Vertical shadow offset for subtle depth */
  HANDLE_SHADOW_OFFSET_Y_PX: 1,
} as const;

// =============================================================================
// MAIN EXPORT
// =============================================================================

/**
 * Draw selection overlay on overlay canvas.
 *
 * Renders three phases:
 * 1. Object highlights - blue outlines around selected objects (when not transforming)
 * 2. Marquee rectangle - dashed selection box during drag select
 * 3. Selection box + handles - bounding box with resize handles (when not transforming)
 *
 * @param ctx - Canvas 2D context with world transform applied
 * @param preview - SelectionPreview data from SelectTool
 * @param scale - Current zoom scale (for consistent visual sizing)
 * @param snapshot - Current snapshot for object lookups
 */
export function drawSelectionOverlay(
  ctx: CanvasRenderingContext2D,
  preview: SelectionPreview,
  scale: number,
  snapshot: Snapshot
): void {
  // Phase 1: Object highlights (only when not transforming)
  if (!preview.isTransforming && preview.selectedIds.length > 0) {
    drawObjectHighlights(ctx, preview.selectedIds, snapshot, scale);
  }

  // Phase 2: Marquee rectangle
  if (preview.marqueeRect) {
    drawMarqueeRect(ctx, preview.marqueeRect, scale);
  }

  // Phase 3: Selection box + handles (only when not transforming)
  if (preview.selectionBounds && !preview.isTransforming) {
    drawSelectionBoxAndHandles(ctx, preview.selectionBounds, preview.handles, scale);
  }
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/**
 * Draw blue highlight outlines around selected objects.
 *
 * Different rendering per object kind:
 * - text: stroke the frame rect
 * - stroke/connector: stroke bbox rect (avoids PerfectFreehand artifact)
 * - shape: stroke the cached Path2D (follows actual geometry)
 */
function drawObjectHighlights(
  ctx: CanvasRenderingContext2D,
  selectedIds: string[],
  snapshot: Snapshot,
  scale: number
): void {
  const cache = getObjectCacheInstance();

  ctx.strokeStyle = SELECTION_STYLE.PRIMARY;
  ctx.lineWidth = SELECTION_STYLE.HIGHLIGHT_WIDTH / scale;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  for (const id of selectedIds) {
    const handle = snapshot.objectsById.get(id);
    if (!handle) continue;

    // Text: stroke the frame rect
    if (handle.kind === 'text') {
      const frame = getFrame(handle.y);
      if (frame) {
        const [x, y, w, h] = frame;
        ctx.strokeRect(x, y, w, h);
      }
      continue;
    }

    // Strokes/Connectors: use bbox rectangle (avoids PF "ball" end cap artifact)
    if (handle.kind === 'stroke' || handle.kind === 'connector') {
      const [minX, minY, maxX, maxY] = handle.bbox;
      ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
      continue;
    }

    // Shapes: stroke the cached Path2D (follows actual geometry)
    const path = cache.getPath(id, handle);
    ctx.stroke(path);
  }
}

/**
 * Draw marquee selection rectangle.
 *
 * Darker blue fill with solid blue stroke.
 */
function drawMarqueeRect(
  ctx: CanvasRenderingContext2D,
  marqueeRect: { minX: number; minY: number; maxX: number; maxY: number },
  scale: number
): void {
  const { minX, minY, maxX, maxY } = marqueeRect;

  // Darker fill - visible tint
  ctx.fillStyle = SELECTION_STYLE.PRIMARY_FILL;
  ctx.fillRect(minX, minY, maxX - minX, maxY - minY);

  // Solid stroke (no dashes)
  ctx.strokeStyle = SELECTION_STYLE.PRIMARY_MUTED;
  ctx.lineWidth = SELECTION_STYLE.MARQUEE_WIDTH / scale;
  ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
}

/**
 * Draw selection bounding box with resize handles.
 *
 * Selection box: solid blue stroke
 * Handles: off-white circles with subtle dark outline and drop shadow
 */
function drawSelectionBoxAndHandles(
  ctx: CanvasRenderingContext2D,
  selectionBounds: { minX: number; minY: number; maxX: number; maxY: number },
  handles: { id: HandleId; x: number; y: number }[] | null,
  scale: number
): void {
  const { minX, minY, maxX, maxY } = selectionBounds;

  // Selection box stroke
  ctx.strokeStyle = SELECTION_STYLE.PRIMARY;
  ctx.lineWidth = SELECTION_STYLE.BOX_WIDTH / scale;
  ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);

  // Circular handles with drop shadow and subtle outline
  if (handles) {
    const radius = SELECTION_STYLE.HANDLE_RADIUS_PX / scale;

    // Setup shadow for floating handle effect (only applies to fill)
    ctx.shadowColor = SELECTION_STYLE.HANDLE_SHADOW_COLOR;
    ctx.shadowBlur = SELECTION_STYLE.HANDLE_SHADOW_BLUR_PX / scale;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = SELECTION_STYLE.HANDLE_SHADOW_OFFSET_Y_PX / scale;

    ctx.fillStyle = SELECTION_STYLE.HANDLE_FILL;

    // Draw all fills first (with shadow)
    for (const h of handles) {
      ctx.beginPath();
      ctx.arc(h.x, h.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    // Clear shadow before drawing strokes (shadow on strokes looks bad)
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // Draw subtle outline for edge definition
    ctx.strokeStyle = SELECTION_STYLE.HANDLE_STROKE;
    ctx.lineWidth = SELECTION_STYLE.HANDLE_STROKE_WIDTH_PX / scale;

    for (const h of handles) {
      ctx.beginPath();
      ctx.arc(h.x, h.y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
