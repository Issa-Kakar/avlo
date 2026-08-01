import { generateNZAtBottom, generateNZAtTop, generateNZBetween } from '@avlo/shared';
import { getHandlesBySlot } from '@/core/slots/slot-table';
import { spatialTree } from '@/core/spatial/spatial-tree';
import type { ObjectHandle } from '@/core/types/objects';
import { getObjectsById, getZOrder, transact } from '@/runtime/room-runtime';
import { getVisibleBoundsTuple } from '@/stores/camera-store';
import { useSelectionStore } from '@/stores/selection-store';

// Module-scope scratches. User-initiated actions are not per-frame; reuse keeps the
// monomorphic shape but the alloc cost would not have mattered.
const _selectedScratch: ObjectHandle[] = [];
const _visUnselScratch: ObjectHandle[] = [];

// Rank-ascending comparator over the last-fetched ranks column. Cold keyboard paths
// only — every action stores its `getRanks()` fetch into `_ranks` before sorting.
let _ranks: Uint32Array = new Uint32Array(0);
const rankAsc = (a: ObjectHandle, b: ObjectHandle): number => _ranks[a.slot] - _ranks[b.slot];

function getSelectedIds(): readonly string[] {
  return useSelectionStore.getState().selectedIds;
}

/** Number of handles whose rank is in the top-N positions. Used for bring-to-front idempotency. */
function countAtTop(byId: ReadonlyMap<string, ObjectHandle>, ranks: Uint32Array, n: number): number {
  if (n <= 0) return 0;
  const floor = byId.size - n;
  let count = 0;
  for (const h of _selectedScratch) {
    if (ranks[h.slot] >= floor) count++;
  }
  return count;
}

/** Number of selected handles whose rank is in the bottom-N positions. Used for send-to-back idempotency. */
function countAtBottom(ranks: Uint32Array, n: number): number {
  if (n <= 0) return 0;
  let count = 0;
  for (const h of _selectedScratch) {
    if (ranks[h.slot] < n) count++;
  }
  return count;
}

export function bringSelectedToFront(): void {
  const ids = getSelectedIds();
  if (ids.length === 0) return;
  const byId = getObjectsById();
  const zOrder = getZOrder();
  zOrder.ensureRanksValid();
  const ranks = zOrder.getRanks();
  _ranks = ranks;

  _selectedScratch.length = 0;
  for (const id of ids) {
    const h = byId.get(id);
    if (h) _selectedScratch.push(h);
  }
  if (_selectedScratch.length === 0) return;

  // Idempotent: every selected handle already occupies a top slot.
  if (countAtTop(byId, ranks, _selectedScratch.length) === _selectedScratch.length) return;

  _selectedScratch.sort(rankAsc);
  const keys = generateNZAtTop(zOrder.maxZ(), _selectedScratch.length);
  transact(() => {
    for (let i = 0; i < _selectedScratch.length; i++) {
      _selectedScratch[i].y.set('z', keys[i]);
    }
  });
}

export function sendSelectedToBack(): void {
  const ids = getSelectedIds();
  if (ids.length === 0) return;
  const byId = getObjectsById();
  const zOrder = getZOrder();
  zOrder.ensureRanksValid();
  const ranks = zOrder.getRanks();
  _ranks = ranks;

  _selectedScratch.length = 0;
  for (const id of ids) {
    const h = byId.get(id);
    if (h) _selectedScratch.push(h);
  }
  if (_selectedScratch.length === 0) return;

  if (countAtBottom(ranks, _selectedScratch.length) === _selectedScratch.length) return;

  _selectedScratch.sort(rankAsc);
  const keys = generateNZAtBottom(zOrder.minZ(), _selectedScratch.length);
  transact(() => {
    for (let i = 0; i < _selectedScratch.length; i++) {
      _selectedScratch[i].y.set('z', keys[i]);
    }
  });
}

/**
 * Viewport-bound: bisect between visible neighbors, not global neighbors.
 * Wider gaps → shorter keys → linear growth instead of exponential.
 */
export function bringSelectedForward(): void {
  const ids = getSelectedIds();
  if (ids.length === 0) return;
  const zOrder = getZOrder();
  zOrder.ensureRanksValid();
  const ranks = zOrder.getRanks();
  _ranks = ranks;
  const selectedSet = new Set(ids);

  const viewport = getVisibleBoundsTuple();
  const n = spatialTree.query(viewport[0], viewport[1], viewport[2], viewport[3]);
  const res = spatialTree.results;
  const bySlot = getHandlesBySlot();

  _visUnselScratch.length = 0;
  _selectedScratch.length = 0;
  for (let i = 0; i < n; i++) {
    const h = bySlot[res[i]]!;
    if (selectedSet.has(h.id)) _selectedScratch.push(h);
    else _visUnselScratch.push(h);
  }
  if (_visUnselScratch.length === 0 || _selectedScratch.length === 0) return;

  _visUnselScratch.sort(rankAsc);
  _selectedScratch.sort(rankAsc);

  // Group selected by "target pair": first visUnsel with rank > sel.rank.
  // next visUnsel becomes the upper bound. Two-pointer walk over sorted arrays.
  const groups = new Map<number, ObjectHandle[]>();
  let ui = 0;
  for (const sel of _selectedScratch) {
    while (ui < _visUnselScratch.length && ranks[_visUnselScratch[ui].slot] <= ranks[sel.slot]) ui++;
    if (ui >= _visUnselScratch.length) break; // no unselected above sel — already top of viewport
    let arr = groups.get(ui);
    if (!arr) groups.set(ui, (arr = []));
    arr.push(sel);
  }
  if (groups.size === 0) return;

  transact(() => {
    for (const [targetIdx, members] of groups) {
      const target = _visUnselScratch[targetIdx];
      const next = _visUnselScratch[targetIdx + 1] ?? null;
      const lower = target.z;
      const upper = next?.z ?? null;
      const keys = generateNZBetween(lower, upper, members.length);
      for (let i = 0; i < members.length; i++) members[i].y.set('z', keys[i]);
    }
  });
}

export function sendSelectedBackward(): void {
  const ids = getSelectedIds();
  if (ids.length === 0) return;
  const zOrder = getZOrder();
  zOrder.ensureRanksValid();
  const ranks = zOrder.getRanks();
  _ranks = ranks;
  const selectedSet = new Set(ids);

  const viewport = getVisibleBoundsTuple();
  const n = spatialTree.query(viewport[0], viewport[1], viewport[2], viewport[3]);
  const res = spatialTree.results;
  const bySlot = getHandlesBySlot();

  _visUnselScratch.length = 0;
  _selectedScratch.length = 0;
  for (let i = 0; i < n; i++) {
    const h = bySlot[res[i]]!;
    if (selectedSet.has(h.id)) _selectedScratch.push(h);
    else _visUnselScratch.push(h);
  }
  if (_visUnselScratch.length === 0 || _selectedScratch.length === 0) return;

  _visUnselScratch.sort(rankAsc);
  _selectedScratch.sort(rankAsc);

  // For each selected, find the last visUnsel with rank < sel.rank.
  // Walk visUnsel descending in parallel with selected descending.
  const groups = new Map<number, ObjectHandle[]>();
  // Process selected in descending rank order — easier two-pointer walk.
  for (let s = _selectedScratch.length - 1; s >= 0; s--) {
    const sel = _selectedScratch[s];
    // Binary-ish: find largest ui with ranks[_visUnselScratch[ui].slot] < ranks[sel.slot].
    // visUnsel is sorted asc by rank — use a single linear walk shared across iterations
    // is harder going-backwards, so a per-call linear walk is fine for user-initiated ops.
    let targetIdx = -1;
    for (let ui = _visUnselScratch.length - 1; ui >= 0; ui--) {
      if (ranks[_visUnselScratch[ui].slot] < ranks[sel.slot]) {
        targetIdx = ui;
        break;
      }
    }
    if (targetIdx < 0) continue; // already bottom of viewport
    let arr = groups.get(targetIdx);
    if (!arr) groups.set(targetIdx, (arr = []));
    arr.push(sel);
  }
  if (groups.size === 0) return;

  transact(() => {
    for (const [targetIdx, members] of groups) {
      // members were pushed in desc rank; sort asc so generateNZBetween outputs map correctly.
      members.sort(rankAsc);
      const target = _visUnselScratch[targetIdx];
      const prev = _visUnselScratch[targetIdx - 1] ?? null;
      const lower = prev?.z ?? null;
      const upper = target.z;
      const keys = generateNZBetween(lower, upper, members.length);
      for (let i = 0; i < members.length; i++) members[i].y.set('z', keys[i]);
    }
  });
}
