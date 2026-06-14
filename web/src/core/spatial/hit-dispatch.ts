/**
 * Hit dispatch — per-kind hit functions + 3 switch dispatchers.
 *
 * Each kind owns three named, monomorphic hit fns: `<kind>HitPoint` /
 * `<kind>HitRect` / `<kind>HitCircle`. The public surface is three
 * switch dispatchers (`hitPointFor` / `hitRectFor` / `hitCircleFor`).
 * V8 compiles the 8-arm string switch to a jump table; each branch inlines
 * the per-kind body. No `KIND` table, no `KindCapability<K>` indirection,
 * no megamorphic factory closures overflowing V8's PIC slot limit.
 *
 * `hitPointFor` returns a Paint class on a hit, or `null` on a geometric miss.
 * `'seethrough'` is the see-through class (only unfilled shape interiors
 * produce this); `'ink'` and `'fill'` are the two paint-blocker classes.
 *
 * Tight-bbox fast path: for kinds whose stored rbush bbox equals their
 * tight frame (image, code), `hitRectFor` returns `true` unconditionally
 * — the envelope filter that produced the candidate IS the precision rect
 * check. Tight-framed `hitPointFor` / `hitCircleFor` read the handle's
 * envelope mirrors (`handle.minX/maxX/minY/maxY`) directly, avoiding a
 * `getFrame` / `getCodeFrame` call and a FrameTuple allocation.
 *
 * Invariant for tight-framed reads: `handle.minX/maxX/minY/maxY` IS the
 * live frame envelope. Safe per `core/geometry/bbox.ts` image/code branches
 * — both populate handles only after the frame/layout is committed.
 */

import { getFillColor, getFrame, getPoints, getShapeType, getWidth } from '@/core/accessors';
import { getBookmarkFrame } from '@/core/bookmark/bookmark-render';
import { getConnectorRoute } from '@/core/connectors/connector-router';
import {
  circleHitsShape,
  circleRectIntersect,
  diamondIntersectsBBox,
  ellipseIntersectsBBox,
  getDiamondVertices,
  getTriangleVertices,
  polylineIntersectsBBox,
  shapeHitTest,
  strokeHitTest,
  triangleIntersectsBBox,
} from '@/core/geometry/hit-primitives';
import { getTextFrame } from '@/core/text/text-system';
import type { BBoxTuple, FrameTuple, Point } from '@/core/types/geometry';
import type { ObjectHandle } from '@/core/types/objects';

export type Paint = 'ink' | 'fill' | 'seethrough';

// ============================================================================
// Stroke
// ============================================================================

function strokeHitPoint(h: ObjectHandle, p: Point, r: number): Paint | null {
  const points = getPoints(h.y);
  if (points.length === 0) return null;
  return strokeHitTest(p, points, r + getWidth(h.y) / 2) ? 'ink' : null;
}
function strokeHitRect(h: ObjectHandle, bbox: BBoxTuple): boolean {
  const points = getPoints(h.y);
  return points.length > 0 && polylineIntersectsBBox(points, bbox);
}
function strokeHitCircle(h: ObjectHandle, c: Point, r: number): boolean {
  const points = getPoints(h.y);
  return points.length > 0 && strokeHitTest(c, points, r);
}

// ============================================================================
// Connector
// ============================================================================

function connectorHitPoint(h: ObjectHandle, p: Point, r: number): Paint | null {
  const points = getConnectorRoute(h.id);
  if (!points || points.length === 0) return null;
  return strokeHitTest(p, points, r + getWidth(h.y) / 2) ? 'ink' : null;
}
function connectorHitRect(h: ObjectHandle, bbox: BBoxTuple): boolean {
  const points = getConnectorRoute(h.id);
  return !!points && points.length > 0 && polylineIntersectsBBox(points, bbox);
}
function connectorHitCircle(h: ObjectHandle, c: Point, r: number): boolean {
  const points = getConnectorRoute(h.id);
  return !!points && points.length > 0 && strokeHitTest(c, points, r);
}

// ============================================================================
// Shape — bespoke geometry (ellipse/diamond/triangle/rect) + fill awareness
// ============================================================================

function shapeHitPoint(h: ObjectHandle, p: Point, r: number): Paint | null {
  const frame = getFrame(h.y);
  if (!frame) return null;
  const flag = shapeHitTest(p, r, frame, getShapeType(h.y), getWidth(h.y, 1));
  if (flag < 0) return null;
  const isFilled = !!getFillColor(h.y);
  return isFilled ? 'fill' : flag === 0 ? 'seethrough' : 'ink';
}
function shapeHitRect(h: ObjectHandle, bbox: BBoxTuple): boolean {
  const frame = getFrame(h.y);
  if (!frame) return false;
  const shapeType = getShapeType(h.y);
  const fx = frame[0];
  const fy = frame[1];
  const fw = frame[2];
  const fh = frame[3];
  if (shapeType === 'ellipse') return ellipseIntersectsBBox(fx + fw / 2, fy + fh / 2, fw / 2, fh / 2, bbox);
  if (shapeType === 'diamond') return diamondIntersectsBBox(getDiamondVertices(frame), bbox);
  if (shapeType === 'triangle') return triangleIntersectsBBox(getTriangleVertices(frame), bbox);
  // Inline AABB intersection — no `[fx, fy, fx+fw, fy+fh]` allocation.
  return fx <= bbox[2] && fx + fw >= bbox[0] && fy <= bbox[3] && fy + fh >= bbox[1];
}
function shapeHitCircle(h: ObjectHandle, c: Point, r: number): boolean {
  const frame = getFrame(h.y);
  if (!frame) return false;
  return circleHitsShape(c, r, frame, getShapeType(h.y), getWidth(h.y, 1), !!getFillColor(h.y));
}

// ============================================================================
// Tight-framed (image, code) — handle envelope IS the frame
// ============================================================================
//
// Stored bbox === frame (zero padding). Read mirrors directly; no `getFrame` /
// `getCodeFrame` call, no FrameTuple allocation. `hitRectFor` for these kinds
// returns `true` unconditionally because the rbush envelope filter that
// produced the candidate IS the precision rect check.

function tightFramedHitPoint(h: ObjectHandle, p: Point, r: number): Paint | null {
  const px = p[0];
  const py = p[1];
  const xL = h.minX;
  const xR = h.maxX;
  const yT = h.minY;
  const yB = h.maxY;
  if (px >= xL && px <= xR && py >= yT && py <= yB) return 'ink';
  const cx = px < xL ? xL : px > xR ? xR : px;
  const cy = py < yT ? yT : py > yB ? yB : py;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r ? 'ink' : null;
}
function tightFramedHitCircle(h: ObjectHandle, c: Point, r: number): boolean {
  const px = c[0];
  const py = c[1];
  const cx = px < h.minX ? h.minX : px > h.maxX ? h.maxX : px;
  const cy = py < h.minY ? h.minY : py > h.maxY ? h.maxY : py;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

// ============================================================================
// Padded-framed (text, note, bookmark) — frame derived from subsystem layout
// ============================================================================
//
// Bbox carries padding (italic overhang / shadow / etc) so the rbush envelope
// is coarser than the frame — the precision pass against the subsystem-derived
// FrameTuple matters here. Inline-rect math, no `rectFrameHit` call, no
// `bboxesIntersect([x,y,x+w,y+h], bbox)` array allocation.

function paddedHitPointFromFrame(p: Point, r: number, frame: FrameTuple | null): Paint | null {
  if (!frame) return null;
  const fx = frame[0];
  const fy = frame[1];
  const xR = fx + frame[2];
  const yB = fy + frame[3];
  const px = p[0];
  const py = p[1];
  if (px >= fx && px <= xR && py >= fy && py <= yB) return 'ink';
  const cx = px < fx ? fx : px > xR ? xR : px;
  const cy = py < fy ? fy : py > yB ? yB : py;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r ? 'ink' : null;
}
function paddedHitRectFromFrame(bbox: BBoxTuple, frame: FrameTuple | null): boolean {
  if (!frame) return false;
  const fx = frame[0];
  const fy = frame[1];
  return fx <= bbox[2] && fx + frame[2] >= bbox[0] && fy <= bbox[3] && fy + frame[3] >= bbox[1];
}
function paddedHitCircleFromFrame(c: Point, r: number, frame: FrameTuple | null): boolean {
  return frame !== null && circleRectIntersect(c, r, frame);
}

const textHitPoint = (h: ObjectHandle, p: Point, r: number): Paint | null => paddedHitPointFromFrame(p, r, getTextFrame(h.id));
const textHitRect = (h: ObjectHandle, bbox: BBoxTuple): boolean => paddedHitRectFromFrame(bbox, getTextFrame(h.id));
const textHitCircle = (h: ObjectHandle, c: Point, r: number): boolean => paddedHitCircleFromFrame(c, r, getTextFrame(h.id));

// Notes share the text layout cache → same `getTextFrame` resolver.
const noteHitPoint = (h: ObjectHandle, p: Point, r: number): Paint | null => paddedHitPointFromFrame(p, r, getTextFrame(h.id));
const noteHitRect = (h: ObjectHandle, bbox: BBoxTuple): boolean => paddedHitRectFromFrame(bbox, getTextFrame(h.id));
const noteHitCircle = (h: ObjectHandle, c: Point, r: number): boolean => paddedHitCircleFromFrame(c, r, getTextFrame(h.id));

const bookmarkHitPoint = (h: ObjectHandle, p: Point, r: number): Paint | null => paddedHitPointFromFrame(p, r, getBookmarkFrame(h.id));
const bookmarkHitRect = (h: ObjectHandle, bbox: BBoxTuple): boolean => paddedHitRectFromFrame(bbox, getBookmarkFrame(h.id));
const bookmarkHitCircle = (h: ObjectHandle, c: Point, r: number): boolean => paddedHitCircleFromFrame(c, r, getBookmarkFrame(h.id));

// ============================================================================
// Switch dispatchers — the public surface
// ============================================================================

export function hitPointFor(h: ObjectHandle, p: Point, r: number): Paint | null {
  switch (h.kind) {
    case 'stroke':
      return strokeHitPoint(h, p, r);
    case 'shape':
      return shapeHitPoint(h, p, r);
    case 'connector':
      return connectorHitPoint(h, p, r);
    case 'text':
      return textHitPoint(h, p, r);
    case 'note':
      return noteHitPoint(h, p, r);
    case 'code':
    case 'image':
      return tightFramedHitPoint(h, p, r);
    case 'bookmark':
      return bookmarkHitPoint(h, p, r);
  }
}

export function hitRectFor(h: ObjectHandle, bbox: BBoxTuple): boolean {
  switch (h.kind) {
    case 'stroke':
      return strokeHitRect(h, bbox);
    case 'shape':
      return shapeHitRect(h, bbox);
    case 'connector':
      return connectorHitRect(h, bbox);
    case 'text':
      return textHitRect(h, bbox);
    case 'note':
      return noteHitRect(h, bbox);
    case 'bookmark':
      return bookmarkHitRect(h, bbox);
    case 'code':
    case 'image':
      // Tight bbox: rbush envelope filter IS the precision rect check.
      return true;
  }
}

export function hitCircleFor(h: ObjectHandle, c: Point, r: number): boolean {
  switch (h.kind) {
    case 'stroke':
      return strokeHitCircle(h, c, r);
    case 'shape':
      return shapeHitCircle(h, c, r);
    case 'connector':
      return connectorHitCircle(h, c, r);
    case 'text':
      return textHitCircle(h, c, r);
    case 'note':
      return noteHitCircle(h, c, r);
    case 'bookmark':
      return bookmarkHitCircle(h, c, r);
    case 'code':
    case 'image':
      // Envelope-square is coarser than a true circle, so the precision math still matters.
      return tightFramedHitCircle(h, c, r);
  }
}
