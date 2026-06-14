import type { BBoxTuple, Point } from './geometry';

// ---- Handle ID taxonomy ----

export type CornerHandle = 'nw' | 'ne' | 'se' | 'sw';
export type HorzSide = 'e' | 'w';
export type VertSide = 'n' | 's';
export type SideHandle = HorzSide | VertSide;
export type HandleId = CornerHandle | SideHandle;

// ---- Type guards ----

export function isCorner(h: HandleId): h is CornerHandle {
  return h === 'nw' || h === 'ne' || h === 'se' || h === 'sw';
}

export function isSide(h: HandleId): h is SideHandle {
  return h === 'n' || h === 's' || h === 'e' || h === 'w';
}

export function isHorzSide(h: HandleId): h is HorzSide {
  return h === 'e' || h === 'w';
}

export function isVertSide(h: HandleId): h is VertSide {
  return h === 'n' || h === 's';
}

// ---- Lookup tables ----

const OPPOSITE: Record<HandleId, HandleId> = {
  nw: 'se',
  ne: 'sw',
  se: 'nw',
  sw: 'ne',
  n: 's',
  s: 'n',
  e: 'w',
  w: 'e',
};

const HANDLE_TX: Record<HandleId, 0 | 0.5 | 1> = {
  nw: 0,
  w: 0,
  sw: 0,
  n: 0.5,
  s: 0.5,
  ne: 1,
  e: 1,
  se: 1,
};

const HANDLE_TY: Record<HandleId, 0 | 0.5 | 1> = {
  nw: 0,
  n: 0,
  ne: 0,
  w: 0.5,
  e: 0.5,
  sw: 1,
  s: 1,
  se: 1,
};

const CURSOR: Record<HandleId, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
};

// ---- Opposite handle (mapped type → compile-time precision) ----

type OppositeMap = {
  nw: 'se';
  ne: 'sw';
  se: 'nw';
  sw: 'ne';
  n: 's';
  s: 'n';
  e: 'w';
  w: 'e';
};

export function oppositeHandle<H extends HandleId>(h: H): OppositeMap[H] {
  return OPPOSITE[h] as OppositeMap[H];
}

// ---- Handle position + derived utilities ----

/** Position of a handle on the given bounds (reusable for rendering + scale origin) */
export function handlePosition(h: HandleId, bounds: BBoxTuple): Point {
  return [bounds[0] + (bounds[2] - bounds[0]) * HANDLE_TX[h], bounds[1] + (bounds[3] - bounds[1]) * HANDLE_TY[h]];
}

/** Scale origin = position of the opposite handle */
export const scaleOrigin = (h: HandleId, bounds: BBoxTuple): Point => handlePosition(OPPOSITE[h], bounds);

/** Cursor CSS string for a handle */
export const handleCursor = (h: HandleId): string => CURSOR[h];

// ---- Resize-handle corner positions (renderer + hit testing) ----

interface Corner {
  id: HandleId;
  x: number;
  y: number;
}

// `id` set once at module load, only `x`/`y` mutate per call — stable hidden classes.
// Module-scope scratch: consumers MUST consume immediately (don't retain across calls).
const _cornerScratch: readonly Corner[] = [
  { id: 'nw', x: 0, y: 0 },
  { id: 'ne', x: 0, y: 0 },
  { id: 'se', x: 0, y: 0 },
  { id: 'sw', x: 0, y: 0 },
];

export function computeHandles(bbox: BBoxTuple): readonly Corner[] {
  const a = _cornerScratch as Corner[];
  a[0].x = bbox[0];
  a[0].y = bbox[1];
  a[1].x = bbox[2];
  a[1].y = bbox[1];
  a[2].x = bbox[2];
  a[2].y = bbox[3];
  a[3].x = bbox[0];
  a[3].y = bbox[3];
  return a;
}
