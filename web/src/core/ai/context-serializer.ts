import {
  AI_CONTEXT_VIEWPORT_CAP,
  type AiBlurryObject,
  type AiClusterSummary,
  type AiSimpleObject,
  type CanvasContext,
  type CanvasReadInput,
} from '@avlo/shared';
import type * as Y from 'yjs';
import {
  getConnectorProps,
  getContent,
  getFrame,
  getImageProps,
  getNoteProps,
  getOrigin,
  getShapeProps,
  getTextProps,
} from '@/core/accessors';
import { serializeFragment } from '@/core/clipboard/clipboard-serializer';
import type { ObjectHandle } from '@/core/types/objects';
import { getObjectsById, getSpatialIndex, hasActiveRoom } from '@/runtime/room-runtime';
import { getVisibleBoundsTuple } from '@/stores/camera-store';
import { useRoomSessionStore } from '@/stores/room-session-store';
import { useSelectionStore } from '@/stores/selection-store';
import { shortIdFor, ulidFor, worldToChatX, worldToChatY } from './short-ids';

/**
 * Canvas → `CanvasContext` (the model's eyes). Three-tier fidelity keeps the
 * per-turn token bill flat regardless of board size:
 *   sel      — selection, full detail (AiSimpleObject; kinds outside the
 *              union — stroke/code/bookmark — fall back to the blurry tier)
 *   vis      — viewport objects, blurry {id,k,t?,x,y,w,h}, capped then
 *              overflowed into clusters
 *   clusters — offscreen (and overflow) as grid-bucketed bounds + counts
 * Not a hot path — runs once per user send; clarity over zero-alloc.
 */

const SNIPPET_MAX = 80;
/** Offscreen grid-bucket size (world units) for cluster summaries. */
const CLUSTER_CELL = 1024;
const CLUSTER_CAP = 20;

/** Wire colors are strict #rrggbb — rgba/named values (mixed fills) are omitted. */
function hexOrUndef(color: string | undefined): string | undefined {
  return color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : undefined;
}

function fragmentText(fragment: Y.XmlFragment | null): string | undefined {
  if (!fragment) return undefined;
  const parts: string[] = [];
  for (const para of serializeFragment(fragment).paragraphs) {
    parts.push(para.delta.map((op) => op.insert).join(''));
  }
  const text = parts.join('\n').trim();
  return text ? text : undefined;
}

function snippet(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX - 1)}…` : text;
}

/** Best-effort object text for the blurry tier (labels/notes/text). */
function objectText(handle: ObjectHandle): string | undefined {
  switch (handle.kind) {
    case 'text':
    case 'note':
    case 'shape':
      return snippet(fragmentText(getContent(handle.y)));
    default:
      return undefined;
  }
}

function toBlurry(handle: ObjectHandle): AiBlurryObject {
  const [minX, minY, maxX, maxY] = handle.bbox;
  return {
    id: shortIdFor(handle.id),
    k: handle.kind,
    t: objectText(handle),
    x: worldToChatX(minX),
    y: worldToChatY(minY),
    w: Math.round(maxX - minX),
    h: Math.round(maxY - minY),
  };
}

/** Full-detail conversion — null for kinds outside the AiSimpleObject union. */
function toSimple(handle: ObjectHandle): AiSimpleObject | null {
  const id = shortIdFor(handle.id);
  switch (handle.kind) {
    case 'shape': {
      const p = getShapeProps(handle.y);
      const frame = getFrame(handle.y);
      if (!p || !frame) return null;
      const shape = p.shapeType === 'line' ? null : (p.shapeType as Exclude<typeof p.shapeType, 'line'>);
      if (!shape) return null;
      return {
        id,
        kind: 'shape',
        shape: shape as 'rect' | 'ellipse' | 'diamond' | 'roundedRect' | 'triangle',
        x: worldToChatX(frame[0]),
        y: worldToChatY(frame[1]),
        w: Math.round(frame[2]),
        h: Math.round(frame[3]),
        color: hexOrUndef(p.color),
        fill: hexOrUndef(p.fillColor),
        text: snippet(fragmentText(getContent(handle.y))),
      };
    }
    case 'text': {
      const p = getTextProps(handle.y);
      const origin = getOrigin(handle.y);
      if (!p || !origin) return null;
      return {
        id,
        kind: 'text',
        x: worldToChatX(origin[0]),
        y: worldToChatY(origin[1]),
        text: fragmentText(p.content) ?? '',
        size: Math.round(p.fontSize),
        color: hexOrUndef((handle.y.get('color') as string | undefined) ?? undefined),
      };
    }
    case 'note': {
      const p = getNoteProps(handle.y);
      const origin = getOrigin(handle.y);
      if (!p || !origin) return null;
      return {
        id,
        kind: 'note',
        x: worldToChatX(origin[0]),
        y: worldToChatY(origin[1]),
        text: fragmentText(p.content) ?? '',
        fill: hexOrUndef(p.fillColor),
      };
    }
    case 'connector': {
      const p = getConnectorProps(handle.y);
      if (!p) return null;
      const end = (e: typeof p.start) =>
        Array.isArray(e)
          ? { x: worldToChatX(e[0]), y: worldToChatY(e[1]) }
          : { id: getObjectsById().has(e.id) ? shortIdFor(e.id) : undefined };
      const s = end(p.start);
      const t = end(p.end);
      return {
        id,
        kind: 'connector',
        fromId: 'id' in s ? s.id : undefined,
        toId: 'id' in t ? t.id : undefined,
        x1: 'x' in s ? s.x : undefined,
        y1: 'y' in s ? s.y : undefined,
        x2: 'x' in t ? t.x : undefined,
        y2: 'y' in t ? t.y : undefined,
        startCap: p.startCap,
        endCap: p.endCap,
      };
    }
    case 'image': {
      const p = getImageProps(handle.y);
      if (!p) return null;
      return {
        id,
        kind: 'image',
        x: worldToChatX(p.frame[0]),
        y: worldToChatY(p.frame[1]),
        w: Math.round(p.frame[2]),
        h: Math.round(p.frame[3]),
        assetId: p.assetId,
      };
    }
    default:
      return null; // stroke/code/bookmark — blurry tier only in v1
  }
}

/** Grid-bucket offscreen handles into ≤CLUSTER_CAP bounds+counts summaries. */
function clusterize(handles: ObjectHandle[]): AiClusterSummary[] {
  const buckets = new Map<string, { minX: number; minY: number; maxX: number; maxY: number; n: number; k: Record<string, number> }>();
  for (const h of handles) {
    const cx = Math.floor((h.bbox[0] + h.bbox[2]) / 2 / CLUSTER_CELL);
    const cy = Math.floor((h.bbox[1] + h.bbox[3]) / 2 / CLUSTER_CELL);
    const key = `${cx},${cy}`;
    let b = buckets.get(key);
    if (!b) {
      b = { minX: h.bbox[0], minY: h.bbox[1], maxX: h.bbox[2], maxY: h.bbox[3], n: 0, k: {} };
      buckets.set(key, b);
    }
    b.minX = Math.min(b.minX, h.bbox[0]);
    b.minY = Math.min(b.minY, h.bbox[1]);
    b.maxX = Math.max(b.maxX, h.bbox[2]);
    b.maxY = Math.max(b.maxY, h.bbox[3]);
    b.n++;
    b.k[h.kind] = (b.k[h.kind] ?? 0) + 1;
  }
  const all = [...buckets.values()].sort((a, b) => b.n - a.n);
  const kept = all.slice(0, CLUSTER_CAP - 1);
  const rest = all.slice(CLUSTER_CAP - 1);
  if (rest.length) {
    const merged = rest.reduce((acc, b) => {
      acc.minX = Math.min(acc.minX, b.minX);
      acc.minY = Math.min(acc.minY, b.minY);
      acc.maxX = Math.max(acc.maxX, b.maxX);
      acc.maxY = Math.max(acc.maxY, b.maxY);
      acc.n += b.n;
      for (const [k, n] of Object.entries(b.k)) acc.k[k] = (acc.k[k] ?? 0) + n;
      return acc;
    });
    kept.push(merged);
  }
  return kept.map((b) => ({
    n: b.n,
    k: b.k,
    x: worldToChatX(b.minX),
    y: worldToChatY(b.minY),
    w: Math.round(b.maxX - b.minX),
    h: Math.round(b.maxY - b.minY),
  }));
}

/** The per-turn context payload. Null when no room is connected. */
export function buildCanvasContext(): CanvasContext | null {
  if (!hasActiveRoom()) return null;
  const vp = getVisibleBoundsTuple();
  const selectedIdSet = useSelectionStore.getState().selectedIdSet;

  const sel: AiSimpleObject[] = [];
  const vis: AiBlurryObject[] = [];
  const offscreen: ObjectHandle[] = [];
  const counts: Record<string, number> = {};

  const visible = new Set(getSpatialIndex().queryBBox(vp));
  for (const handle of getObjectsById().values()) {
    counts[handle.kind] = (counts[handle.kind] ?? 0) + 1;
    if (selectedIdSet.has(handle.id) && sel.length < 50) {
      const simple = toSimple(handle);
      if (simple) {
        sel.push(simple);
        continue;
      }
    }
    if (visible.has(handle)) {
      if (vis.length < AI_CONTEXT_VIEWPORT_CAP) vis.push(toBlurry(handle));
      else offscreen.push(handle); // viewport overflow joins the cluster tier
    } else {
      offscreen.push(handle);
    }
  }

  const title = useRoomSessionStore.getState().title || undefined;
  return {
    v: 1,
    vp: [worldToChatX(vp[0]), worldToChatY(vp[1]), Math.round(vp[2] - vp[0]), Math.round(vp[3] - vp[1])],
    sel,
    vis,
    clusters: clusterize(offscreen),
    counts,
    title: title?.slice(0, 120),
  };
}

/** The `canvas_read` tool — the agent's on-demand eyes. */
export function readCanvas(input: CanvasReadInput): Record<string, unknown> {
  if (!hasActiveRoom()) return { error: 'no active room' };
  const full = input.detail === 'full';
  const convert = (h: ObjectHandle) => (full ? (toSimple(h) ?? toBlurry(h)) : toBlurry(h));

  let handles: ObjectHandle[];
  if (input.ids?.length) {
    const byId = getObjectsById();
    handles = [];
    for (const sid of input.ids) {
      const ulid = ulidFor(sid);
      const h = ulid ? byId.get(ulid) : undefined;
      if (h) handles.push(h);
    }
  } else if (input.area === 'selection') {
    const set = useSelectionStore.getState().selectedIdSet;
    handles = [...getObjectsById().values()].filter((h) => set.has(h.id));
  } else if (input.area === 'all') {
    handles = [...getObjectsById().values()];
  } else {
    handles = getSpatialIndex().queryBBox(getVisibleBoundsTuple());
  }

  const capped = handles.slice(0, AI_CONTEXT_VIEWPORT_CAP);
  return {
    objects: capped.map(convert),
    truncated: handles.length > capped.length ? handles.length - capped.length : undefined,
  };
}
