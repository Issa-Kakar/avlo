/**
 * Connector rich-text labels — geometry + layout helpers.
 *
 * Connectors carry an optional rich-text label stored directly on the connector
 * Y.Map under the shape-label keys (`content: Y.XmlFragment`, `fontSize`,
 * `fontFamily`, `labelColor`) — no width, no fill. The label block is centred
 * BOTH horizontally and vertically on the route's arc-length midpoint (the
 * origin-follows-anchor model `renderTextLayout` already uses for centred text,
 * extended to the vertical axis). The router/renderer/topology/bbox code each
 * make a single delegated call here so the label-specific complexity stays out
 * of those files — mirroring how attached-connector anchor renormalization is
 * hidden from consumers today.
 *
 * Two cache-access tiers, matching the rest of the codebase:
 *   - Populating (`computeConnectorLabelLayout` → `unionConnectorLabelBBoxInto`):
 *     called from the observer / canonical-bbox path. `textLayoutCache.getLayout`
 *     POPULATES the cache as a side effect, so "handle exists ⇒ label layout
 *     populated" holds for connectors too (mirrors `computeTextBBox`).
 *   - Hot/transient (`getConnectorLabelRect` / `unionConnectorLabelRectInto`):
 *     called from render / hit-test / topology / endpoint-drag. Reads the
 *     populated layout via `getLayoutById` with no stale probe.
 *
 * Zero-alloc, monomorphic hot paths via module scratches (the `render-accessors`
 * pattern). The only allocating sites are cold (editor mount / reposition).
 *
 * @module core/connectors/connector-label
 */

import type * as Y from 'yjs';
import { getContent, getFontFamily, getFontSize } from '../accessors';
import { expandBBox } from '../geometry/bounds';
import { getBaselineToTopRatio } from '../text/text-measure';
import { type TextLayout, textLayoutCache } from '../text/text-system';
import type { BBoxTuple, Point } from '../types/geometry';

// Clip-hole / bbox breathing room around the glyph block, proportional to font
// size so it reads the same at every label size. Horizontal is wider — the auto
// layout's advance width hugs the glyphs, so the route would otherwise kiss the
// first/last character; the line box already carries half-leading vertically.
const LABEL_PAD_X_RATIO = 0.35;
const LABEL_PAD_Y_RATIO = 0.1;

// Module scratches — non-reentrant; every entry is synchronous. `_midScratch` is
// fully consumed inside `connectorLabelRectInto` before return. `_labelRectScratch`
// (observer/bbox union path) is kept distinct from `_labelRectReturn` (render/hit
// return value) so the two paths never alias.
const _midScratch: Point = [0, 0];
const _labelRectScratch: BBoxTuple = [0, 0, 0, 0];
const _labelRectReturn: BBoxTuple = [0, 0, 0, 0];

/**
 * Read `content`/`fontSize`/`fontFamily` and return the populated label layout,
 * or `null` when the connector carries no label. `getLayout` populates
 * `textLayoutCache` keyed by the connector id (mirrors `computeTextBBox`), so
 * the observer/bbox path guarantees the layout is fresh whenever a handle exists.
 */
export function computeConnectorLabelLayout(id: string, yObj: Y.Map<unknown>): TextLayout | null {
  const content = getContent(yObj);
  if (!content) return null;
  return textLayoutCache.getLayout(id, content, getFontSize(yObj), getFontFamily(yObj), 'auto');
}

/**
 * Arc-length midpoint of the cached route into `out` (scalar accumulation, no
 * alloc). Straight = segment midpoint; elbow = walk segments. `count` is the
 * valid prefix of `points` (HWM buffer contract — never `.length`).
 */
export function connectorLabelMidpointInto(points: Point[], count: number, out: Point): void {
  if (count < 2) {
    out[0] = points[0]?.[0] ?? 0;
    out[1] = points[0]?.[1] ?? 0;
    return;
  }

  let total = 0;
  for (let i = 1; i < count; i++) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    total += Math.sqrt(dx * dx + dy * dy);
  }

  const half = total / 2;
  let acc = 0;
  for (let i = 1; i < count; i++) {
    const x0 = points[i - 1][0];
    const y0 = points[i - 1][1];
    const dx = points[i][0] - x0;
    const dy = points[i][1] - y0;
    const segLen = Math.sqrt(dx * dx + dy * dy);
    if (acc + segLen >= half) {
      const t = segLen > 0 ? (half - acc) / segLen : 0;
      out[0] = x0 + dx * t;
      out[1] = y0 + dy * t;
      return;
    }
    acc += segLen;
  }

  // Float drift fallback — land on the last point.
  out[0] = points[count - 1][0];
  out[1] = points[count - 1][1];
}

/**
 * Write the label rect — a box of size `(boxWidth, lineCount*lineHeight)` + pad —
 * centred (H + V) on the route's arc-length midpoint into `out`. `boxWidth` is
 * the auto-layout's max line advance, which is exactly the horizontal extent
 * `renderTextLayout` paints with `align='center'`. Symmetric about the anchor,
 * matching the render + editor anchor model.
 */
function connectorLabelRectInto(layout: TextLayout, points: Point[], count: number, out: BBoxTuple): void {
  connectorLabelMidpointInto(points, count, _midScratch);
  const ax = _midScratch[0];
  const ay = _midScratch[1];
  const halfW = layout.boxWidth / 2 + layout.fontSize * LABEL_PAD_X_RATIO;
  const halfH = (layout.lineCount * layout.lineHeight) / 2 + layout.fontSize * LABEL_PAD_Y_RATIO;
  out[0] = ax - halfW;
  out[1] = ay - halfH;
  out[2] = ax + halfW;
  out[3] = ay + halfH;
}

/**
 * Observer/bbox entry: populate the layout, resolve the label rect, and union it
 * into `outBbox` in place (zero alloc). No-op when the connector has no label or
 * the route is degenerate. The connector's published bbox must cover every
 * painted pixel — the label text is painted, so this union is mandatory for the
 * dirty-rect ↔ WYSIWYG invariant.
 */
export function unionConnectorLabelBBoxInto(id: string, yObj: Y.Map<unknown>, points: Point[], count: number, outBbox: BBoxTuple): void {
  if (count < 2) return;
  const layout = computeConnectorLabelLayout(id, yObj);
  if (!layout) return;
  connectorLabelRectInto(layout, points, count, _labelRectScratch);
  expandBBox(outBbox, _labelRectScratch[0], _labelRectScratch[1], _labelRectScratch[2], _labelRectScratch[3]);
}

/**
 * Hot/transient entry for render + hit-test + topology: resolve the label rect
 * from the already-populated layout (`getLayoutById`, no stale probe). Returns a
 * shared module scratch under the consumed-before-next-call contract (exactly
 * like the per-kind scratches in `render-accessors.ts`). `null` when the
 * connector has no label or the route is degenerate (`count < 2`).
 */
export function getConnectorLabelRect(id: string, points: Point[], count: number): BBoxTuple | null {
  if (count < 2) return null;
  const layout = textLayoutCache.getLayoutById(id);
  if (!layout) return null;
  connectorLabelRectInto(layout, points, count, _labelRectReturn);
  return _labelRectReturn;
}

/**
 * Hot-path bbox union (topology reroute + endpoint drag): resolve the label rect
 * from the cached layout and union it into `outBbox` in place. Layout dims are
 * unchanged during a drag — only the midpoint moves — so this tracks the route
 * live with zero alloc.
 */
export function unionConnectorLabelRectInto(id: string, points: Point[], count: number, outBbox: BBoxTuple): void {
  const rect = getConnectorLabelRect(id, points, count);
  if (rect) expandBBox(outBbox, rect[0], rect[1], rect[2], rect[3]);
}

/**
 * First-baseline Y that vertically centres the glyph block on `anchorY`:
 * `anchorY + getBaselineToTopRatio(fontFamily)*fontSize - (lineCount*lineHeight)/2`.
 * `originX` for the render is the anchor X; `renderTextLayout` with `align='center'`
 * centres each line on it.
 */
export function labelOriginYFor(layout: TextLayout, anchorY: number): number {
  return anchorY + getBaselineToTopRatio(layout.fontFamily) * layout.fontSize - (layout.lineCount * layout.lineHeight) / 2;
}
