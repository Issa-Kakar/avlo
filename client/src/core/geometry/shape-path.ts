import type { Point } from '@/core/types/geometry';

/**
 * Diamond corner cut-distance (world units). Each polygon vertex steps back by
 * this amount along its incoming and outgoing edges, with a quadratic Bézier
 * control point at the vertex. Effective arc radius is `r · tan(α/2)` — pointy
 * at acute vertices, gradual at obtuse ones, automatically per aspect ratio.
 */
export const DIAMOND_CORNER_OFFSET_W = 5;

/**
 * Rounded-rect cap on corner radius. Actual radius is `min(MAX, w·0.1, h·0.1)`,
 * so corners scale proportionally for small shapes and plateau for large ones.
 * 90° corners always — no aspect-dependent behavior.
 */
export const ROUNDED_RECT_MAX_RADIUS_W = 20;

/**
 * Build shape path from explicit frame (not from cache).
 * Used by object rendering, object-cache, and transform previews.
 */
export function buildShapePathFromFrame(shapeType: string, frame: [number, number, number, number]): Path2D {
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
      buildRoundedPolygonPath(
        path,
        [
          [cx, y0],
          [x + w, cy],
          [cx, y0 + h],
          [x, cy],
        ],
        DIAMOND_CORNER_OFFSET_W,
      );
      break;
    }
    case 'roundedRect': {
      const radius = Math.min(ROUNDED_RECT_MAX_RADIUS_W, w * 0.1, h * 0.1);
      path.roundRect(x, y0, w, h, radius);
      break;
    }
    default:
      path.rect(x, y0, w, h);
  }

  return path;
}

function buildRoundedPolygonPath(path: Path2D, vertices: readonly Point[], offset: number): void {
  const n = vertices.length;
  if (n < 3) return;

  const dir: { dx: number; dy: number; len: number }[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = vertices[j][0] - vertices[i][0];
    const dy = vertices[j][1] - vertices[i][1];
    const len = Math.hypot(dx, dy);
    dir.push(len < 1e-9 ? { dx: 0, dy: 0, len: 0 } : { dx: dx / len, dy: dy / len, len });
  }

  // Clamp per-vertex offset to half of either adjacent edge so cut points
  // from neighbouring vertices can never overlap.
  const r: number[] = [];
  for (let i = 0; i < n; i++) {
    const inE = dir[(i - 1 + n) % n];
    const outE = dir[i];
    r.push(Math.min(offset, inE.len * 0.5, outE.len * 0.5));
  }

  const startX = vertices[0][0] + r[0] * dir[0].dx;
  const startY = vertices[0][1] + r[0] * dir[0].dy;
  path.moveTo(startX, startY);

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const inCutX = vertices[j][0] - r[j] * dir[i].dx;
    const inCutY = vertices[j][1] - r[j] * dir[i].dy;
    const outCutX = vertices[j][0] + r[j] * dir[j].dx;
    const outCutY = vertices[j][1] + r[j] * dir[j].dy;
    path.lineTo(inCutX, inCutY);
    path.quadraticCurveTo(vertices[j][0], vertices[j][1], outCutX, outCutY);
  }

  path.closePath();
}
