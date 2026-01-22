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
