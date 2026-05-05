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

import { getFillColor, getFrame, getPoints, getShapeType, getWidth } from '@/core/accessors';
import { getBookmarkFrame } from '@/core/bookmark/bookmark-render';
import { getCodeFrame } from '@/core/code/code-system';
import { getConnectorRoute } from '@/core/connectors/connector-router';
import {
  bboxesIntersect,
  circleHitsShape,
  circleRectIntersect,
  diamondIntersectsBBox,
  ellipseIntersectsBBox,
  getDiamondVertices,
  polylineIntersectsBBox,
  rectFrameHit,
  shapeHitTest,
  strokeHitTest,
} from '@/core/geometry/hit-primitives';
import { getTextFrame } from '@/core/text/text-system';
import type { BBoxTuple, FrameTuple, Point } from '@/core/types/geometry';
import type { ObjectHandle, ObjectKind } from '@/core/types/objects';

export type Paint = 'ink' | 'fill' | 'seethrough';

export type HandleOf<K extends ObjectKind> = ObjectHandle & { kind: K };

export interface KindCapability<K extends ObjectKind> {
  /** Connector endpoint target? Read once at module init to seed the bindable prefilter. */
  readonly bindable: boolean;

  /** Point-probe: returns the paint class on a hit, or `null` on miss. */
  readonly hitPoint: (h: HandleOf<K>, p: Point, r: number) => Paint | null;

  /**
   * Rect-vs-geometry intersect (marquee tight phase).
   *
   * **`null` opt-out:** when the stored rbush bbox is *tight* to the geometry
   * (no shadow / stroke / overhang padding), the rbush envelope filter that
   * produced the candidate IS already the precision rect check — running this
   * cap would re-do the same `bboxesIntersect` against identical numbers.
   * `queryHandleIds` checks for `null` and trusts the envelope. See
   * `tightFramedCap` for the kinds that opt in (image, code).
   */
  readonly hitRect: ((h: HandleOf<K>, bbox: BBoxTuple) => boolean) | null;

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
    const points = getConnectorRoute(h.id);
    if (!points || points.length === 0) return null;
    return strokeHitTest(p, points, r + getWidth(h.y) / 2) ? 'ink' : null;
  },
  hitRect: (h, bbox) => {
    const points = getConnectorRoute(h.id);
    return !!points && points.length > 0 && polylineIntersectsBBox(points, bbox);
  },
  hitCircle: (h, c, r) => {
    const points = getConnectorRoute(h.id);
    return !!points && points.length > 0 && strokeHitTest(c, points, r);
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

/**
 * Variant of `framedCap` for kinds whose stored rbush bbox is *tight* to the
 * geometry's frame — i.e. `computeBBoxFor(...)` writes `[fx, fy, fx+fw, fy+fh]`
 * with zero padding. Sets `hitRect: null` so `queryHandleIds` skips the
 * precision rect check entirely and trusts the rbush envelope filter (which
 * would otherwise run the same `bboxesIntersect` against identical numbers).
 *
 * Safe ONLY for kinds whose `bbox.ts` entry is exactly the frame:
 *   - image  → `[x, y, x+w, y+h]` from `getFrame(y)`
 *   - code   → `[ox, oy, ox+totalWidth, oy+blockHeight]` from `computeCodeBBox`
 *
 * Do NOT use for kinds whose stored bbox is padded beyond the frame — their
 * cap legitimately filters out marquees touching only the padding zone:
 *   - text:     italic overhang (`getItalicOverhangPad`) + 2px vertical pad
 *   - note:     shadow pad (`getNoteShadowPad`, ~18.8wu @ scale 1)
 *   - bookmark: shadow pad
 *   - shape:    stroke pad + ellipse/diamond need shape-aware precision
 *
 * If a future kind's `bbox.ts` entry stops equaling its frame, switch it back
 * to plain `framedCap` — otherwise marquee will leak hits in the padding zone.
 */
function tightFramedCap<K extends 'image' | 'code'>(resolveFrame: (h: HandleOf<K>) => FrameTuple | null): KindCapability<K> {
  return { ...framedCap(resolveFrame), hitRect: null };
}

export const KIND: { readonly [K in ObjectKind]: KindCapability<K> } = {
  stroke: STROKE_CAP,
  connector: CONNECTOR_CAP,
  shape: SHAPE_CAP,
  text: framedCap<'text'>((h) => getTextFrame(h.id)),
  code: tightFramedCap<'code'>((h) => getCodeFrame(h.id)),
  note: framedCap<'note'>((h) => getTextFrame(h.id)),
  image: tightFramedCap<'image'>((h) => getFrame(h.y)),
  bookmark: framedCap<'bookmark'>((h) => getBookmarkFrame(h.id)),
};

/** One-cast-per-loop dispatch bridge. */
export type AnyCapability = KindCapability<ObjectKind>;
