/**
 * Per-kind capability table — single source of truth for object-kind hit rules.
 *
 * Each cap owns the three hit predicates (`hitPoint`, `hitRect`, `hitCircle`)
 * and the bindable flag (read once at import time by `object-query.ts` to seed
 * the bindable-kind prefilter set). Frame resolution is not a capability —
 * consumers that need a frame use `frameOf` from `core/geometry/frame-of.ts`.
 * Area is not a capability either — only shape interiors participate in the
 * frame-aware tournament, and the two scan loops that need it compute
 * `frame[2] * frame[3]` inline.
 *
 * `hitPoint` returns a Paint class on a hit, or `null` on a geometric miss.
 * `'seethrough'` is the see-through class (only unfilled shape interiors
 * produce this); `'ink'` and `'fill'` are the two paint-blocker classes.
 */

import type { BBoxTuple, FrameTuple, Point } from '@/core/types/geometry';
import type { ObjectHandle, ObjectKind } from '@/core/types/objects';
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
} from '@/core/geometry/hit-primitives';

export type Paint = 'ink' | 'fill' | 'seethrough';

export type HandleOf<K extends ObjectKind> = ObjectHandle & { kind: K };

export interface KindCapability<K extends ObjectKind> {
  /** Connector endpoint target? Read once at module init to seed the bindable prefilter. */
  readonly bindable: boolean;

  /** Point-probe: returns the paint class on a hit, or `null` on miss. */
  readonly hitPoint: (h: HandleOf<K>, p: Point, r: number) => Paint | null;

  /** Rect-vs-geometry intersect (marquee tight phase). */
  readonly hitRect: (h: HandleOf<K>, bbox: BBoxTuple) => boolean;

  /** Fill-aware circle-vs-geometry intersect (eraser). */
  readonly hitCircle: (h: HandleOf<K>, c: Point, r: number) => boolean;
}

const STROKE_CAP: KindCapability<'stroke'> = {
  bindable: false,
  hitPoint: (h, p, r) => {
    const points = getPoints(h.y);
    if (points.length === 0) return null;
    return strokeHitTest(p, points, r + getWidth(h.y) / 2) ? 'ink' : null;
  },
  hitRect: (h, bbox) => {
    const points = getPoints(h.y);
    return points.length > 0 && polylineIntersectsBBox(points, bbox);
  },
  hitCircle: (h, c, r) => {
    const points = getPoints(h.y);
    return points.length > 0 && strokeHitTest(c, points, r);
  },
};

const CONNECTOR_CAP: KindCapability<'connector'> = {
  bindable: false,
  hitPoint: (h, p, r) => {
    const points = getPoints(h.y);
    if (points.length === 0) return null;
    return strokeHitTest(p, points, r + getWidth(h.y) / 2) ? 'ink' : null;
  },
  hitRect: (h, bbox) => {
    const points = getPoints(h.y);
    return points.length > 0 && polylineIntersectsBBox(points, bbox);
  },
  hitCircle: (h, c, r) => {
    const points = getPoints(h.y);
    return points.length > 0 && strokeHitTest(c, points, r);
  },
};

const SHAPE_CAP: KindCapability<'shape'> = {
  bindable: true,
  hitPoint: (h, p, r) => {
    const frame = getFrame(h.y);
    if (!frame) return null;
    const result = shapeHitTest(p, r, frame, getShapeType(h.y), getWidth(h.y, 1));
    if (!result) return null;
    const isFilled = !!getFillColor(h.y);
    return isFilled ? 'fill' : result.insideInterior ? 'seethrough' : 'ink';
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
};

/**
 * Framed-rect cap factory — text/note/code/image/bookmark all share the same
 * point/rect/circle math against a derived FrameTuple. Paint is always `'ink'`
 * (no glyph-level testing, so any hit inside the frame is a paint hit).
 */
function framedCap<K extends 'text' | 'note' | 'code' | 'image' | 'bookmark'>(
  resolveFrame: (h: HandleOf<K>) => FrameTuple | null,
): KindCapability<K> {
  return {
    bindable: true,
    hitPoint: (h, p, r) => {
      const frame = resolveFrame(h);
      if (!frame) return null;
      return rectFrameHit(p, r, frame) ? 'ink' : null;
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
  };
}

export const KIND: { readonly [K in ObjectKind]: KindCapability<K> } = {
  stroke: STROKE_CAP,
  connector: CONNECTOR_CAP,
  shape: SHAPE_CAP,
  text: framedCap<'text'>((h) => getTextFrame(h.id)),
  code: framedCap<'code'>((h) => getCodeFrame(h.id)),
  note: framedCap<'note'>((h) => getTextFrame(h.id)),
  image: framedCap<'image'>((h) => getFrame(h.y)),
  bookmark: framedCap<'bookmark'>((h) => getBookmarkFrame(h.id)),
};

/** One-cast-per-loop dispatch bridge. */
export type AnyCapability = KindCapability<ObjectKind>;
