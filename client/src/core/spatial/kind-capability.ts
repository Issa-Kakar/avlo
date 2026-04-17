/**
 * Per-kind capability registry — single source of truth for object-kind rules.
 *
 * Collapses what was previously scattered across `HIT_BY_KIND` (hit-testing.ts),
 * `FRAME_BY_KIND` (frame-of.ts), `INTERIOR_PAINT` / `BINDABLE_KINDS`
 * (types/objects.ts), the `objectIntersectsRect` switch (hit-testing.ts),
 * `classifyPaint`'s inline branches (object-pick.ts), and EraserTool's ad-hoc
 * per-kind dispatch loop.
 *
 * Adding a new ObjectKind = one entry here. The exhaustive mapped type
 * `{ [K in ObjectKind]: KindCapability<K> }` makes it a compile error until the
 * cap is added.
 */

import type { BBoxTuple, FrameTuple, Point } from '@/core/types/geometry';
import type { ObjectKind } from '@/core/types/objects';
import { getFrame, getPoints, getShapeType, getWidth, getFillColor } from '@/core/accessors';
import { getTextFrame } from '@/core/text/text-system';
import { getCodeFrame } from '@/core/code/code-system';
import { getBookmarkFrame } from '@/core/bookmark/bookmark-render';
import {
  strokeHitTest,
  shapeHitTest,
  rectFrameHit,
  circleRectIntersect,
  circleHitsShape,
  bboxesIntersect,
  polylineIntersectsBBox,
  ellipseIntersectsBBox,
  diamondIntersectsBBox,
  getDiamondVertices,
  computePolylineArea,
} from '@/core/geometry/hit-primitives';
import type { HitCandidate } from '@/core/geometry/hit-testing';
import type { HandleOf, Paint } from './atoms';

// ============================================================================
// Capability interface
// ============================================================================

/**
 * `hitPoint` returns the per-kind classification fields ONLY — the scanner
 * composes the final `HitCandidate<K>` by adding the `handle`. Lets each cap
 * stay tight: no boilerplate spread of `handle` in every return.
 */
export type HitFields<K extends ObjectKind> = Omit<HitCandidate<K>, 'handle'>;

export interface KindCapability<K extends ObjectKind> {
  /** Connector endpoint target? Replaces `BINDABLE_KINDS` membership. */
  readonly bindable: boolean;

  /** Resolve the frame. Null for stroke/connector (frameless) or unhydrated. */
  readonly frame: (h: HandleOf<K>) => FrameTuple | null;

  /** Point-probe hit: returns classification fields, or null on miss. */
  readonly hitPoint: (h: HandleOf<K>, p: Point, r: number) => HitFields<K> | null;

  /** Rect-vs-geometry test (marquee tight phase). */
  readonly hitRect: (h: HandleOf<K>, bbox: BBoxTuple) => boolean;

  /** Fill-aware circle-vs-geometry test (eraser). */
  readonly hitCircle: (h: HandleOf<K>, c: Point, r: number) => boolean;

  /** Lazy area getter — called by pickers only when the tournament needs it. */
  readonly area: (h: HandleOf<K>) => number;
}

// ============================================================================
// Per-kind entries
// ============================================================================

const STROKE_CAP: KindCapability<'stroke'> = {
  bindable: false,
  frame: () => null,
  hitPoint: (h, p, r) => {
    const points = getPoints(h.y);
    if (points.length === 0) return null;
    if (!strokeHitTest(p, points, r + getWidth(h.y) / 2)) return null;
    return { distance: 0, paint: 'ink' };
  },
  hitRect: (h, bbox) => {
    const points = getPoints(h.y);
    return points.length > 0 && polylineIntersectsBBox(points, bbox);
  },
  hitCircle: (h, c, r) => {
    const points = getPoints(h.y);
    return points.length > 0 && strokeHitTest(c, points, r);
  },
  area: (h) => computePolylineArea(getPoints(h.y)),
};

const CONNECTOR_CAP: KindCapability<'connector'> = {
  bindable: false,
  frame: () => null,
  hitPoint: (h, p, r) => {
    const points = getPoints(h.y);
    if (points.length === 0) return null;
    if (!strokeHitTest(p, points, r + getWidth(h.y) / 2)) return null;
    return { distance: 0, paint: 'ink' };
  },
  hitRect: (h, bbox) => {
    const points = getPoints(h.y);
    return points.length > 0 && polylineIntersectsBBox(points, bbox);
  },
  hitCircle: (h, c, r) => {
    const points = getPoints(h.y);
    return points.length > 0 && strokeHitTest(c, points, r);
  },
  area: (h) => computePolylineArea(getPoints(h.y)),
};

const SHAPE_CAP: KindCapability<'shape'> = {
  bindable: true,
  frame: (h) => getFrame(h.y),
  hitPoint: (h, p, r) => {
    const frame = getFrame(h.y);
    if (!frame) return null;
    const result = shapeHitTest(p, r, frame, getShapeType(h.y), getWidth(h.y, 1));
    if (!result) return null;
    const isFilled = !!getFillColor(h.y);
    const paint: Paint = isFilled ? 'fill' : result.insideInterior ? null : 'ink';
    return { distance: result.distance, paint };
  },
  hitRect: (h, bbox) => {
    const frame = getFrame(h.y);
    if (!frame) return false;
    const shapeType = getShapeType(h.y);
    const [x, y, w, hh] = frame;
    if (shapeType === 'ellipse') return ellipseIntersectsBBox(x + w / 2, y + hh / 2, w / 2, hh / 2, bbox);
    if (shapeType === 'diamond') return diamondIntersectsBBox(getDiamondVertices(frame), bbox);
    return bboxesIntersect([x, y, x + w, y + hh], bbox);
  },
  hitCircle: (h, c, r) => {
    const frame = getFrame(h.y);
    if (!frame) return false;
    return circleHitsShape(c, r, frame, getShapeType(h.y), getWidth(h.y, 1), !!getFillColor(h.y));
  },
  area: (h) => {
    const f = getFrame(h.y);
    return f ? f[2] * f[3] : 0;
  },
};

/**
 * Framed-rect cap factory — text/note/code/image/bookmark all share the same
 * point/rect/circle math against a derived FrameTuple. Paint is always `'ink'`
 * (no glyph-level hit testing, so any hit inside the frame is a paint hit).
 * Only the frame getter differs per kind.
 */
function framedCap<K extends 'text' | 'note' | 'code' | 'image' | 'bookmark'>(
  resolveFrame: (h: HandleOf<K>) => FrameTuple | null,
): KindCapability<K> {
  return {
    bindable: true,
    frame: resolveFrame,
    hitPoint: (h, p, r) => {
      const frame = resolveFrame(h);
      if (!frame) return null;
      const result = rectFrameHit(p, r, frame);
      if (!result) return null;
      return { distance: result.distance, paint: 'ink' };
    },
    hitRect: (h, bbox) => {
      const frame = resolveFrame(h);
      if (!frame) return false;
      const [x, y, w, hh] = frame;
      return bboxesIntersect([x, y, x + w, y + hh], bbox);
    },
    hitCircle: (h, c, r) => {
      const frame = resolveFrame(h);
      return frame !== null && circleRectIntersect(c, r, frame);
    },
    area: (h) => {
      const f = resolveFrame(h);
      return f ? f[2] * f[3] : 0;
    },
  };
}

const TEXT_CAP = framedCap<'text'>((h) => getTextFrame(h.id));
const NOTE_CAP = framedCap<'note'>((h) => getTextFrame(h.id));
const CODE_CAP = framedCap<'code'>((h) => getCodeFrame(h.id));
const IMAGE_CAP = framedCap<'image'>((h) => getFrame(h.y));
const BOOKMARK_CAP = framedCap<'bookmark'>((h) => getBookmarkFrame(h.id));

// ============================================================================
// The exhaustive table
// ============================================================================

/**
 * Per-kind capability table — exhaustive mapped type. Adding a new
 * `ObjectKind` is a compile error until a `KindCapability<K>` is added here.
 */
export const KIND: { readonly [K in ObjectKind]: KindCapability<K> } = {
  stroke: STROKE_CAP,
  connector: CONNECTOR_CAP,
  shape: SHAPE_CAP,
  text: TEXT_CAP,
  code: CODE_CAP,
  note: NOTE_CAP,
  image: IMAGE_CAP,
  bookmark: BOOKMARK_CAP,
};

/** Convenience untyped handle — used by dispatchers that do one cast per loop. */
export type AnyCapability = KindCapability<ObjectKind>;
