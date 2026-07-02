import type * as Y from 'yjs';
import { getBookmarkProps, getEndCap, getFrame, getNoteProps, getPoints, getStartCap, getTextProps, getWidth } from '../accessors';
import { computeBookmarkBBox } from '../bookmark/bookmark-render';
import { computeCodeBBoxInto } from '../code/code-system';
import { unionConnectorLabelBBoxInto } from '../connectors/connector-label';
import { getConnectorRoute } from '../connectors/connector-router';
import type { ConnectorCap } from '../connectors/types';
import { ensureImageMeta } from '../image/image-cache';
import { computeNoteBBox, NOTE_WIDTH } from '../text/sticky-note';
import { computeTextBBox } from '../text/text-system';
import type { BBoxTuple, Point, WorldBounds } from '../types/geometry';
import type { ObjectKind } from '../types/objects';
import { copyBbox } from './bounds';

/**
 * Write the bbox for `(id, kind, yMap)` into `out`. Hot-path entry — callers pass a
 * pooled scratch tuple and pay zero allocation for stroke/shape/image/connector
 * branches. Text/code/note/bookmark branches still allocate one tuple inside the
 * subsystem helper (copied via `copyBbox`); pushing `*Into` into those helpers is
 * a follow-up.
 */
export function computeBBoxForInto(id: string, kind: ObjectKind, yMap: Y.Map<unknown>, out: BBoxTuple): void {
  switch (kind) {
    case 'stroke': {
      const points = getPoints(yMap);
      if (points.length < 1) {
        out[0] = out[1] = out[2] = out[3] = 0;
        return;
      }

      let minX = points[0][0],
        minY = points[0][1];
      let maxX = minX,
        maxY = minY;

      for (let i = 1; i < points.length; i++) {
        const [x, y] = points[i];
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }

      // CRITICAL: Width IS part of bbox!
      // If width changes → bbox changes → geometry eviction
      const width = getWidth(yMap, 1);
      const padding = width * 0.5 + 1;

      out[0] = minX - padding;
      out[1] = minY - padding;
      out[2] = maxX + padding;
      out[3] = maxY + padding;
      return;
    }

    case 'shape': {
      const frame = getFrame(yMap) ?? [0, 0, 0, 0];
      const strokeWidth = getWidth(yMap, 1);
      const padding = strokeWidth * 0.5 + 1;

      out[0] = frame[0] - padding;
      out[1] = frame[1] - padding;
      out[2] = frame[0] + frame[2] + padding;
      out[3] = frame[1] + frame[3] + padding;
      return;
    }

    case 'text': {
      const props = getTextProps(yMap);
      if (!props) {
        const frame = getFrame(yMap) ?? [0, 0, 0, 0];
        out[0] = frame[0];
        out[1] = frame[1];
        out[2] = frame[0] + frame[2];
        out[3] = frame[1] + frame[3];
        return;
      }
      copyBbox(computeTextBBox(id, props), out);
      return;
    }

    case 'note': {
      const props = getNoteProps(yMap);
      if (!props) {
        const origin = (yMap.get('origin') as Point | undefined) ?? [0, 0];
        const scale = (yMap.get('scale') as number) ?? 1;
        const w = NOTE_WIDTH * scale;
        out[0] = origin[0];
        out[1] = origin[1];
        out[2] = origin[0] + w;
        out[3] = origin[1] + w;
        return;
      }
      copyBbox(computeNoteBBox(id, props), out);
      return;
    }

    case 'code':
      computeCodeBBoxInto(id, yMap, out);
      return;

    case 'image': {
      const frame = getFrame(yMap) ?? [0, 0, 0, 0];
      out[0] = frame[0];
      out[1] = frame[1];
      out[2] = frame[0] + frame[2];
      out[3] = frame[1] + frame[3];
      ensureImageMeta(id, yMap);
      return;
    }

    case 'bookmark': {
      const props = getBookmarkProps(yMap);
      if (!props) {
        out[0] = out[1] = out[2] = out[3] = 0;
        return;
      }
      copyBbox(computeBookmarkBBox(id, props), out);
      return;
    }

    case 'connector': {
      // Read from local route cache — connector points no longer live in Y.Map.
      // Parallel to text/code/note/bookmark: each kind delegates to its subsystem cache.
      const points = getConnectorRoute(id);
      if (!points || points.length < 2) {
        out[0] = out[1] = out[2] = out[3] = 0;
        return;
      }
      computeConnectorBBoxFromPointsInto(points, points.length, getWidth(yMap), getStartCap(yMap), getEndCap(yMap), out);
      unionConnectorLabelBBoxInto(id, yMap, points, points.length, out);
      return;
    }

    default:
      out[0] = out[1] = out[2] = out[3] = 0;
      return;
  }
}

/** Cold-path wrapper: allocates a fresh tuple. Hot paths should call `computeBBoxForInto` with a pooled scratch. */
export function computeBBoxFor(id: string, kind: ObjectKind, yMap: Y.Map<unknown>): BBoxTuple {
  const out: BBoxTuple = [0, 0, 0, 0];
  computeBBoxForInto(id, kind, yMap, out);
  return out;
}

/**
 * Allocation-free variant: writes the bbox into `outBbox`. Caller supplies an
 * explicit `count` so a reused points buffer (length may exceed valid prefix)
 * iterates only its valid range. Width + caps are also passed in — callers on
 * the topology hot path read these once from RouteContext at gesture-begin.
 */
export function computeConnectorBBoxFromPointsInto(
  points: Point[],
  count: number,
  strokeWidth: number,
  startCap: ConnectorCap,
  endCap: ConnectorCap,
  outBbox: BBoxTuple,
): void {
  if (count < 2) {
    outBbox[0] = outBbox[1] = outBbox[2] = outBbox[3] = 0;
    return;
  }

  let minX = points[0][0],
    minY = points[0][1];
  let maxX = minX,
    maxY = minY;

  for (let i = 1; i < count; i++) {
    const p = points[i];
    if (p[0] < minX) minX = p[0];
    else if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    else if (p[1] > maxY) maxY = p[1];
  }

  const strokePadding = strokeWidth / 2;
  const hasArrow = startCap === 'arrow' || endCap === 'arrow';

  let padding: number;
  if (hasArrow) {
    const arrowLength = Math.max(6, strokeWidth * 3);
    const arrowHalfWidth = arrowLength / 2;
    const arrowRounding = 2.5;
    padding = Math.max(strokePadding, arrowHalfWidth + arrowRounding) + 1;
  } else {
    padding = strokePadding + 1;
  }

  outBbox[0] = minX - padding;
  outBbox[1] = minY - padding;
  outBbox[2] = maxX + padding;
  outBbox[3] = maxY + padding;
}

export function bboxEquals(a: BBoxTuple, b: BBoxTuple): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

export function bboxToBounds(bbox: BBoxTuple): WorldBounds {
  return {
    minX: bbox[0],
    minY: bbox[1],
    maxX: bbox[2],
    maxY: bbox[3],
  };
}
