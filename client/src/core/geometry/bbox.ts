import type * as Y from 'yjs';
import { getBookmarkProps, getEndCap, getFrame, getNoteProps, getPoints, getStartCap, getTextProps, getWidth } from '../accessors';
import { BOOKMARK_WIDTH, computeBookmarkBBox } from '../bookmark/bookmark-render';
import { computeCodeBBox } from '../code/code-system';
import { getConnectorRoute } from '../connectors/connector-router';
import type { ConnectorCap } from '../connectors/types';
import { computeNoteBBox, NOTE_SHADOW_BOTTOM_RATIO, NOTE_SHADOW_SIDE_RATIO, NOTE_SHADOW_TOP_RATIO, NOTE_WIDTH } from '../text/sticky-note';
import { computeTextBBox } from '../text/text-system';
import type { BBoxTuple, Point, WorldBounds } from '../types/geometry';
import type { ObjectKind } from '../types/objects';

export function computeBBoxFor(id: string, kind: ObjectKind, yMap: Y.Map<unknown>): BBoxTuple {
  switch (kind) {
    case 'stroke': {
      const points = getPoints(yMap);
      if (points.length < 1) return [0, 0, 0, 0];

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

      return [minX - padding, minY - padding, maxX + padding, maxY + padding];
    }

    case 'shape': {
      const frame = getFrame(yMap) ?? [0, 0, 0, 0];
      const strokeWidth = getWidth(yMap, 1);
      const padding = strokeWidth * 0.5 + 1;

      return [frame[0] - padding, frame[1] - padding, frame[0] + frame[2] + padding, frame[1] + frame[3] + padding];
    }

    case 'text': {
      const props = getTextProps(yMap);
      if (!props) {
        const frame = getFrame(yMap) ?? [0, 0, 0, 0];
        return [frame[0], frame[1], frame[0] + frame[2], frame[1] + frame[3]];
      }
      return computeTextBBox(id, props);
    }

    case 'note': {
      const props = getNoteProps(yMap);
      if (!props) {
        const origin = (yMap.get('origin') as Point | undefined) ?? [0, 0];
        const scale = (yMap.get('scale') as number) ?? 1;
        const w = NOTE_WIDTH * scale;
        return [origin[0], origin[1], origin[0] + w, origin[1] + w];
      }
      return computeNoteBBox(id, props);
    }

    case 'code':
      return computeCodeBBox(id, yMap);

    case 'image': {
      const frame = getFrame(yMap) ?? [0, 0, 0, 0];
      return [frame[0], frame[1], frame[0] + frame[2], frame[1] + frame[3]];
    }

    case 'bookmark': {
      const props = getBookmarkProps(yMap);
      if (props) return computeBookmarkBBox(id, props);
      // Inline fallback when props incomplete
      const origin = (yMap.get('origin') as Point | undefined) ?? [0, 0];
      const scale = (yMap.get('scale') as number) ?? 1;
      const height = (yMap.get('height') as number) ?? 60;
      const w = BOOKMARK_WIDTH * scale;
      const h = height * scale;
      const padTop = w * NOTE_SHADOW_TOP_RATIO;
      const padSide = w * NOTE_SHADOW_SIDE_RATIO;
      const padBottom = w * NOTE_SHADOW_BOTTOM_RATIO;
      return [origin[0] - padSide, origin[1] - padTop, origin[0] + w + padSide, origin[1] + h + padBottom];
    }

    case 'connector': {
      // Read from local route cache — connector points no longer live in Y.Map.
      // Parallel to text/code/note/bookmark: each kind delegates to its subsystem cache.
      const points = getConnectorRoute(id);
      if (!points || points.length < 2) return [0, 0, 0, 0];
      return computeConnectorBBoxFromPoints(points, yMap);
    }

    default:
      return [0, 0, 0, 0];
  }
}

/**
 * Compute connector bbox from externally-provided points.
 * Reads width and cap info from the Y.Map (which is never stale for style props).
 * Use this when you have rerouted points that haven't been committed yet.
 */
export function computeConnectorBBoxFromPoints(points: Point[], yMap: Y.Map<unknown>): BBoxTuple {
  if (points.length < 2) return [0, 0, 0, 0];
  const out: BBoxTuple = [0, 0, 0, 0];
  computeConnectorBBoxFromPointsInto(points, points.length, getWidth(yMap), getStartCap(yMap), getEndCap(yMap), out);
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
