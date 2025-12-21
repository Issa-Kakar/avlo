import type { PerfectShapePreview } from '@/lib/tools/types';

// Inline helper for color tinting (to avoid client utils import)
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

/**
 * Draws a perfect shape preview (line, circle, or box) on the canvas
 * The preview shows the shape based on frozen anchors and live cursor position
 * All coordinates are in world space - the canvas context should already have world transforms applied
 */
export function drawPerfectShapePreview(
  ctx: CanvasRenderingContext2D,
  preview: PerfectShapePreview,
): void {
  // Apply tool styling
  ctx.globalAlpha = preview.opacity;
  ctx.strokeStyle = preview.color;
  ctx.lineWidth = preview.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);

  // Set fill style if fill is enabled
  const fillEnabled = preview.fill ?? false;
  if (fillEnabled) {
    const rgb = hexToRgb(preview.color);
    if (rgb) {
      const tinted = {
        r: Math.round(rgb.r * 0.15 + 255 * 0.85),
        g: Math.round(rgb.g * 0.15 + 255 * 0.85),
        b: Math.round(rgb.b * 0.15 + 255 * 0.85),
      };
      ctx.fillStyle = `rgb(${tinted.r}, ${tinted.g}, ${tinted.b})`;
    }
  }

  const { anchors, cursor } = preview;

  if (anchors.kind === 'line') {
    // Line: draw from fixed point A to live cursor
    const { A } = anchors;
    const B = cursor;
    ctx.beginPath();
    ctx.moveTo(A[0], A[1]);
    ctx.lineTo(B[0], B[1]);
    ctx.stroke();
    return;
  }

  if (anchors.kind === 'rect') {
    // Corner-anchored ROUNDED rectangle (A = fixed corner, C = cursor/opposite)
    const { A } = anchors;
    const C = cursor;
    const minX = Math.min(A[0], C[0]);
    const minY = Math.min(A[1], C[1]);
    const width = Math.abs(C[0] - A[0]);
    const height = Math.abs(C[1] - A[1]);
    if (width === 0 || height === 0) return;
    // Calculate corner radius (same logic as object-cache)
    const radius = Math.min(20, width * 0.1, height * 0.1);

    // Draw rounded rectangle
    ctx.beginPath();
    ctx.moveTo(minX + radius, minY);
    ctx.lineTo(minX + width - radius, minY);
    ctx.quadraticCurveTo(minX + width, minY, minX + width, minY + radius);
    ctx.lineTo(minX + width, minY + height - radius);
    ctx.quadraticCurveTo(minX + width, minY + height, minX + width - radius, minY + height);
    ctx.lineTo(minX + radius, minY + height);
    ctx.quadraticCurveTo(minX, minY + height, minX, minY + height - radius);
    ctx.lineTo(minX, minY + radius);
    ctx.quadraticCurveTo(minX, minY, minX + radius, minY);
    ctx.closePath();
    if (fillEnabled) ctx.fill();
    ctx.stroke();
    return;
  }

  if (anchors.kind === 'ellipseRect') {
    // Corner-anchored ellipse inscribed in AABB
    const { A } = anchors;
    const C = cursor;
    const minX = Math.min(A[0], C[0]),
      maxX = Math.max(A[0], C[0]);
    const minY = Math.min(A[1], C[1]),
      maxY = Math.max(A[1], C[1]);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const rx = Math.max(0.0001, (maxX - minX) / 2);
    const ry = Math.max(0.0001, (maxY - minY) / 2);

    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    if (fillEnabled) ctx.fill();
    ctx.stroke();
    return;
  }

  if (anchors.kind === 'diamond') {
    const { A } = anchors;
    const C = cursor;
    const minX = Math.min(A[0], C[0]);
    const maxX = Math.max(A[0], C[0]);
    const minY = Math.min(A[1], C[1]);
    const maxY = Math.max(A[1], C[1]);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const width = maxX - minX;
    const height = maxY - minY;

    // Safety check to prevent drawing if size is 0
    if (width === 0 || height === 0) return;

    // Calculate corner radius
    const radius = Math.min(20, Math.min(width, height) * 0.1);

    ctx.beginPath();

    // 1. Start somewhere safe on the Top-Right edge (midpoint)
    // This ensures the first line drawn connects smoothly to the last curve
    ctx.moveTo(cx + width / 4, minY + height / 4);

    // 2. Round the Right Corner
    // arcTo(CornerX, CornerY, DestinationX, DestinationY, Radius)
    ctx.arcTo(maxX, cy, cx, maxY, radius);

    // 3. Round the Bottom Corner
    ctx.arcTo(cx, maxY, minX, cy, radius);

    // 4. Round the Left Corner
    ctx.arcTo(minX, cy, cx, minY, radius);

    // 5. Round the Top Corner
    // (This curves around the top tip and connects back to the start)
    ctx.arcTo(cx, minY, maxX, cy, radius);

    ctx.closePath();
    if (fillEnabled) ctx.fill();
    ctx.stroke();
    return;
  }

  if (anchors.kind === 'circle') {
    // Circle: draw with fixed center and radius based on cursor distance
    const { center } = anchors;
    const r = Math.hypot(cursor[0] - center[0], cursor[1] - center[1]);
    ctx.beginPath();
    ctx.arc(center[0], center[1], r, 0, Math.PI * 2);
    if (fillEnabled) ctx.fill();
    ctx.stroke();
    return;
  }

  if (anchors.kind === 'box') {
    // Box: scale from frozen half-extents based on cursor position
    const { cx, cy, angle, hx0, hy0 } = anchors;

    // Compute scale factors from cursor position
    const dx = cursor[0] - cx;
    const dy = cursor[1] - cy;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    // Project live vector into box's local axes
    const localX = dx * cos + dy * sin;
    const localY = -dx * sin + dy * cos;

    // Calculate scale factors (prevent division by zero)
    const sx = Math.max(0.0001, Math.abs(localX) / Math.max(1e-6, hx0));
    const sy = Math.max(0.0001, Math.abs(localY) / Math.max(1e-6, hy0));

    // Apply scale to get final half-extents
    const hx = hx0 * sx;
    const hy = hy0 * sy;

    // Draw rotated rectangle from (cx,cy), angle, half-extents (hx,hy)
    const corners = [
      [-hx, -hy],
      [hx, -hy],
      [hx, hy],
      [-hx, hy],
    ];
    ctx.beginPath();
    for (let i = 0; i < corners.length; i++) {
      const [lx, ly] = corners[i];
      const wx = cx + lx * cos - ly * sin;
      const wy = cy + lx * sin + ly * cos;
      if (i === 0) {
        ctx.moveTo(wx, wy);
      } else {
        ctx.lineTo(wx, wy);
      }
    }
    ctx.closePath();
    if (fillEnabled) ctx.fill();
    ctx.stroke();
  }
}
