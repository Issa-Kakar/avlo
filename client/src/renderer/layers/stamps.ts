import type { Snapshot, ViewTransform } from '@avlo/shared';
import type { ViewportInfo } from '../types';

// Stamp atlas - basic shapes
const STAMP_PATHS: Record<string, Path2D> = {};

// Initialize stamp paths
function initStampPaths() {
  if (Object.keys(STAMP_PATHS).length > 0) return;

  // Circle
  const circle = new Path2D();
  circle.arc(0, 0, 16, 0, Math.PI * 2);
  STAMP_PATHS['circle'] = circle;

  // Square
  const square = new Path2D();
  square.rect(-14, -14, 28, 28);
  STAMP_PATHS['square'] = square;

  // Triangle
  const triangle = new Path2D();
  triangle.moveTo(0, -16);
  triangle.lineTo(-14, 12);
  triangle.lineTo(14, 12);
  triangle.closePath();
  STAMP_PATHS['triangle'] = triangle;

  // Star
  const star = new Path2D();
  const spikes = 5;
  for (let i = 0; i < spikes * 2; i++) {
    const angle = (i * Math.PI) / spikes;
    const radius = i % 2 === 0 ? 16 : 8;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) star.moveTo(x, y);
    else star.lineTo(x, y);
  }
  star.closePath();
  STAMP_PATHS['star'] = star;

  // Heart
  const heart = new Path2D();
  heart.moveTo(0, -8);
  heart.bezierCurveTo(-16, -20, -16, -8, 0, 4);
  heart.bezierCurveTo(16, -8, 16, -20, 0, -8);
  STAMP_PATHS['heart'] = heart;
}

export function drawStamps(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  _view: ViewTransform,
  viewport: ViewportInfo,
): void {
  // Filter strokes for stamps - tool is nested in style object
  const stamps = snapshot.strokes.filter((s) => s.style.tool === 'stamp');
  if (stamps.length === 0) return;

  initStampPaths();

  ctx.save();

  const visibleBounds = (viewport as any).visibleWorldBounds;

  for (const stamp of stamps) {
    // Culling
    if (visibleBounds && stamp.bbox) {
      if (
        stamp.bbox[2] < visibleBounds.minX ||
        stamp.bbox[0] > visibleBounds.maxX ||
        stamp.bbox[3] < visibleBounds.minY ||
        stamp.bbox[1] > visibleBounds.maxY
      ) {
        continue;
      }
    }

    // Get stamp properties
    const cx = stamp.points[0];
    const cy = stamp.points[1];
    const stampType = (stamp as any).stampType || 'circle';
    const path = STAMP_PATHS[stampType];
    const color = (stamp as any).color || stamp.style.color;
    const size = (stamp as any).size || stamp.style.size;

    if (!path) continue;

    // Draw stamp
    ctx.save();
    ctx.translate(cx, cy);

    const scale = size / 32; // Base size is 32
    ctx.scale(scale, scale);

    ctx.fillStyle = color;
    ctx.globalAlpha = stamp.style.opacity;
    ctx.fill(path);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.lineWidth = 1 / scale;
    ctx.stroke(path);

    ctx.restore();
  }

  ctx.restore();
}
