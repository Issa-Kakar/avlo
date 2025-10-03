import type { Snapshot, ViewTransform } from '@avlo/shared';
import type { ViewportInfo } from '../types';

export function drawText(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  _view: ViewTransform,
  viewport: ViewportInfo,
): void {
  const texts = snapshot.texts;
  if (!texts || texts.length === 0) return;

  // Save context state
  ctx.save();

  // Use viewport visible bounds for culling
  const visibleBounds = (viewport as any).visibleWorldBounds;

  for (const t of texts) {
    // Culling check
    if (visibleBounds) {
      if (
        t.x + t.w < visibleBounds.minX ||
        t.x > visibleBounds.maxX ||
        t.y + t.h < visibleBounds.minY ||
        t.y > visibleBounds.maxY
      ) {
        continue;
      }
    }

    ctx.fillStyle = t.color;
    ctx.font = `${t.size}px Inter, system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = 'top';

    const lineHeight = t.size * 1.4;
    const maxW = Math.max(1, t.w); // guard

    const outLines: string[] = [];
    const hardLines = t.content.split('\n');

    for (const hard of hardLines) {
      // preserve spaces like pre-wrap
      // split on spaces but also break long tokens ("overflow-wrap: break-word")
      let cur = '';
      for (const token of hard.split(/(\\s+)/)) {
        const next = cur + token;
        if (ctx.measureText(next).width <= maxW || cur === '') {
          cur = next;
          continue;
        }

        // current line would overflow: push cur, then try token
        if (cur.trim().length || /\\s+/.test(cur)) outLines.push(cur);
        // if single token is too long, break by characters
        if (ctx.measureText(token).width > maxW) {
          let chunk = '';
          for (const ch of token) {
            const tryChunk = chunk + ch;
            if (ctx.measureText(tryChunk).width <= maxW || chunk === '') {
              chunk = tryChunk;
            } else {
              outLines.push(chunk);
              chunk = ch;
            }
          }
          cur = chunk;
        } else {
          cur = token;
        }
      }
      outLines.push(cur);
    }

    for (let i = 0; i < outLines.length; i++) {
      ctx.fillText(outLines[i], t.x, t.y + i * lineHeight);
    }

    // Debug: Draw bounding box in dev
    if (import.meta.env.DEV && import.meta.env.VITE_DEBUG_RENDER_LAYERS) {
      ctx.strokeStyle = 'rgba(255, 0, 255, 0.3)';
      ctx.lineWidth = 1;
      ctx.strokeRect(t.x, t.y, t.w, t.h);
    }
  }

  ctx.restore();
}
