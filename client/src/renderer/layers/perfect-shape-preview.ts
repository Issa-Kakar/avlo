import type { PerfectShapePreview } from '@/lib/tools/types';

/**
 * Draws a perfect shape preview (line, circle, or box) on the canvas
 * The preview shows the shape based on frozen anchors and live cursor position
 * All coordinates are in world space - the canvas context should already have world transforms applied
 */
export function drawPerfectShapePreview(
  ctx: CanvasRenderingContext2D,
  preview: PerfectShapePreview
): void {
  // Apply tool styling
  ctx.globalAlpha = preview.opacity;
  ctx.strokeStyle = preview.color;
  ctx.lineWidth = preview.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);

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

  if (anchors.kind === 'arrow') {
    // Arrow: shaft from A to cursor plus dynamic arrowhead
    const { A } = anchors;
    const B = cursor;

    // Draw shaft
    ctx.beginPath();
    ctx.moveTo(A[0], A[1]);
    ctx.lineTo(B[0], B[1]);
    ctx.stroke();

    // Draw arrowhead
    const vx = B[0] - A[0], vy = B[1] - A[1];
    const len = Math.hypot(vx, vy) || 1;
    const headSize = Math.min(40, len * 0.25);
    const spread = Math.PI / 7;
    const theta = Math.atan2(vy, vx);

    ctx.beginPath();
    ctx.moveTo(B[0], B[1]);
    ctx.lineTo(
      B[0] - headSize * Math.cos(theta + spread),
      B[1] - headSize * Math.sin(theta + spread)
    );
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(B[0], B[1]);
    ctx.lineTo(
      B[0] - headSize * Math.cos(theta - spread),
      B[1] - headSize * Math.sin(theta - spread)
    );
    ctx.stroke();

    return;
  }

  if (anchors.kind === 'rect') {
    // Corner-anchored AABB rectangle
    const { A } = anchors;
    const C = cursor;
    const minX = Math.min(A[0], C[0]), maxX = Math.max(A[0], C[0]);
    const minY = Math.min(A[1], C[1]), maxY = Math.max(A[1], C[1]);

    ctx.beginPath();
    ctx.moveTo(A[0], A[1]);
    ctx.lineTo(maxX, minY);
    ctx.lineTo(maxX, maxY);
    ctx.lineTo(minX, maxY);
    ctx.closePath();
    ctx.stroke();
    return;
  }

  if (anchors.kind === 'ellipseRect') {
    // Corner-anchored ellipse inscribed in AABB
    const { A } = anchors;
    const C = cursor;
    const minX = Math.min(A[0], C[0]), maxX = Math.max(A[0], C[0]);
    const minY = Math.min(A[1], C[1]), maxY = Math.max(A[1], C[1]);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const rx = Math.max(0.0001, (maxX - minX) / 2);
    const ry = Math.max(0.0001, (maxY - minY) / 2);

    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }

  if (anchors.kind === 'circle') {
    // Circle: draw with fixed center and radius based on cursor distance
    const { center } = anchors;
    const r = Math.hypot(cursor[0] - center[0], cursor[1] - center[1]);
    ctx.beginPath();
    ctx.arc(center[0], center[1], r, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }

  // Box: scale from frozen half-extents based on cursor position
  const { cx, cy, angle, hx0, hy0 } = anchors;

  // Compute scale factors from cursor position
  const dx = cursor[0] - cx;
  const dy = cursor[1] - cy;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  // Project live vector into box's local axes
  const localX =  dx *  cos + dy *  sin;
  const localY = -dx *  sin + dy *  cos;

  // Calculate scale factors (prevent division by zero)
  const sx = Math.max(0.0001, Math.abs(localX) / Math.max(1e-6, hx0));
  const sy = Math.max(0.0001, Math.abs(localY) / Math.max(1e-6, hy0));

  // Apply scale to get final half-extents
  const hx = hx0 * sx;
  const hy = hy0 * sy;

  // Draw rotated rectangle from (cx,cy), angle, half-extents (hx,hy)
  const corners = [[-hx,-hy],[hx,-hy],[hx,hy],[-hx,hy]];
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
  ctx.stroke();
}