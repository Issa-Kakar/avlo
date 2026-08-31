import type { ObjectHandle } from '@/core/types/objects';
import { getBBoxColumn } from '../slots/slot-table';

/**
 * Ephemeral lock table — the client half of conflict-resolution grabs.
 *
 * SoA columns keyed by `handle.slot` (the app-wide dense slot from
 * `core/slots/slot-table.ts`). Owner encoding collapses every guard to one load + one
 * unsigned compare on a Uint32:
 *   0 = unlocked · 1 = locked by me · ≥2 = server-assigned peer key
 *   blocked ⇔ lockOwner[slot] > 1
 *
 * Growth doubles in lockstep with slot acquisition (`lockSlotAcquired`); cells are cleared at
 * release time because the slot table recycles slots LIFO without zeroing. Incoming frames
 * carry stable ids interned fresh per frame (`objectsById`), so a reused slot can never be hit
 * by a stale frame — an unknown/deleted id is dropped (a lock on a deleted object is a no-op;
 * Yjs is authority).
 *
 * The durable `locked` object property rides alongside as `_locked: Uint8Array` (0/1) — a
 * pure mirror of each object's Y.Map `locked` field, written only by the room observer
 * (keychange branch + handle-insert/hydrate seeds), grown in `ensureLockCapacity`, cleared
 * in `lockSlotReleased`/`resetLockTable`. Same one-load-one-compare guard idiom, separate
 * column because a peer grab and a durable lock can coexist on one slot.
 *
 * Hot paths never allocate; all allocation lives in the cold acquire/release/apply paths.
 *
 * LEAF MODULE — no runtime imports beyond the fellow leaf `core/slots/slot-table` (itself
 * type-only-importing). Tool singletons and store modules call in at module-eval time
 * (EraserTool's constructor, selection-store's subscriber registration); any runtime import
 * of room-runtime here would re-enter its import cycle and put these consts in TDZ at those
 * call sites. The two external needs (`objectsById` interning, the veil-layer notification)
 * are injected via `bindLockTable`.
 */

const INITIAL_CAP = 256;

let _objectsById: ReadonlyMap<string, ObjectHandle> | null = null;
let _veilNotify: (() => void) | null = null;

/** Called once per RoomDocManager construction. Bindings survive resetLockTable() —
 *  the map identity is stable for the manager's lifetime; destroy clears the map's
 *  CONTENTS (the binding itself is simply replaced by the next manager's bind). */
export function bindLockTable(objectsById: ReadonlyMap<string, ObjectHandle>, veilNotify: () => void): void {
  _objectsById = objectsById;
  _veilNotify = veilNotify;
}

let _cap = INITIAL_CAP;
let _lockOwner = new Uint32Array(_cap);
/** slot → index into the owning peer's dense arrays; -1 when free or locally held. */
let _lockedPos = new Int32Array(_cap).fill(-1);
/** Durable-lock mirror of the Y.Map `locked` field (1 = locked). Observer-written only. */
let _locked = new Uint8Array(_cap);

/** Dense slot list per peer. LIVENESS INVARIANT: `rec.slots ⊆ live slots with owner ≥ 2` —
 *  `lockSlotReleased → removeFromPeer` prunes synchronously in observer Phase A, before the
 *  slot is freed and before the veil microtask can read the record. Load-bearing: the veil's
 *  column reads (`fillRemoteLockedBoxes`) have no analogue of the old id-intern miss-skip —
 *  a stale slot would silently paint a recycled slot's bbox. */
interface PeerLocks {
  slots: number[];
}
const _peers = new Map<number, PeerLocks>();

// Local lock sources. Callers pass pre-deduped ids per source (injectIds is provably unique;
// eraser gates on first-accumulate; editors hold ≤1). Sources CAN co-hold one id across
// sources (shape-label editor + scale gesture on the same shape) — release checks the others.
export const LOCK_SRC_TRANSFORM = 0;
export const LOCK_SRC_TEXT_EDITOR = 1;
export const LOCK_SRC_CODE_EDITOR = 2;
export const LOCK_SRC_ERASER = 3;
export type LockSource = 0 | 1 | 2 | 3;
const _sources: [string[], string[], string[], string[]] = [[], [], [], []];

const _remoteApplied: Array<(ids: readonly string[]) => void> = [];
const _localChanged: Array<(shrank: boolean) => void> = [];

// ── hot-path column ──────────────────────────────────────────────────────────

/**
 * Live column ref — fetch once per frame/query/loop, then `lo[handle.slot] > 1` per candidate.
 * Never cache across a possible grow (growth happens only inside observer fires, which cannot
 * interleave a synchronous frame or query).
 */
export function getLockOwners(): Uint32Array {
  return _lockOwner;
}

export function isRemoteLocked(handle: ObjectHandle): boolean {
  return _lockOwner[handle.slot] > 1;
}

export function isRemoteLockedId(id: string): boolean {
  const handle = _objectsById?.get(id);
  return handle !== undefined && _lockOwner[handle.slot] > 1;
}

// ── durable lock column (persistent `locked` object property) ───────────────

/** Live column ref — same fetch-per-loop contract as `getLockOwners`. */
export function getLockedFlags(): Uint8Array {
  return _locked;
}

export function isLockedObject(handle: ObjectHandle): boolean {
  return _locked[handle.slot] === 1;
}

export function isLockedId(id: string): boolean {
  const handle = _objectsById?.get(id);
  return handle !== undefined && _locked[handle.slot] === 1;
}

/** Observer-only writer (locked keychange branch + handle-insert/hydrate seeds). */
export function setLockedFlag(slot: number, v: 0 | 1): void {
  _locked[slot] = v;
}

// ── local locks ──────────────────────────────────────────────────────────────

export function acquireLocalLock(src: LockSource, id: string): void {
  const handle = _objectsById?.get(id);
  if (handle === undefined || _lockOwner[handle.slot] > 1) return; // never claim over a peer
  _lockOwner[handle.slot] = 1;
  _sources[src].push(id);
  fireLocalChanged(false);
}

export function acquireLocalLocks(src: LockSource, ids: readonly string[]): void {
  const byId = _objectsById;
  if (byId === null) return;
  const list = _sources[src];
  let changed = false;
  for (const id of ids) {
    const handle = byId.get(id);
    if (handle === undefined || _lockOwner[handle.slot] > 1) continue;
    _lockOwner[handle.slot] = 1;
    list.push(id);
    changed = true;
  }
  if (changed) fireLocalChanged(false);
}

export function releaseLocalLocks(src: LockSource): void {
  const list = _sources[src];
  if (list.length === 0) return;
  const byId = _objectsById;
  if (byId !== null) {
    for (const id of list) {
      if (heldByOtherSource(src, id)) continue;
      const handle = byId.get(id);
      // === 1 is load-bearing, not defensive: a peer key that won first-wins arbitration
      // mid-gesture overwrote our optimistic 1 — never clobber it. Deleted ids intern to
      // nothing (their slot was already cleared by lockSlotReleased; a recycled slot
      // belongs to someone else's id).
      if (handle !== undefined && _lockOwner[handle.slot] === 1) _lockOwner[handle.slot] = 0;
    }
  }
  list.length = 0;
  fireLocalChanged(true);
}

/** Dedup union across sources — serialized by the wire layer on change. */
export function getLocalLockedIdSet(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const list of _sources) for (const id of list) out.add(id);
  return out;
}

// Overlap is rare and tiny: transform and eraser never coexist (single pointer), editor lists ≤1.
function heldByOtherSource(src: LockSource, id: string): boolean {
  for (let s = 0; s < 4; s++) {
    if (s !== src && _sources[s].includes(id)) return true;
  }
  return false;
}

// ── remote locks (wire layer) ────────────────────────────────────────────────

/**
 * Full replace of one peer's granted set. Release-then-add, O(old+new). An id we hold as `1`
 * means we lost first-wins arbitration — the peer key overwrites; our source lists keep the id
 * as an inert claim (release's `=== 1` check skips it, the server ignores the wire claim).
 * Fires the reaction hooks (selection prune / editor force-close / eraser purge) AFTER the
 * table is fresh so callbacks read the final column.
 */
export function applyPeerSet(ownerKey: number, ids: readonly string[]): void {
  const rec = _peers.get(ownerKey);
  let changed = false;

  if (rec !== undefined && rec.slots.length > 0) {
    for (const slot of rec.slots) {
      _lockOwner[slot] = 0;
      _lockedPos[slot] = -1;
    }
    rec.slots.length = 0;
    changed = true;
  }

  const byId = _objectsById;
  if (ids.length > 0 && byId !== null) {
    let target = rec;
    for (const id of ids) {
      const handle = byId.get(id);
      if (handle === undefined) continue; // unknown/deleted → drop the entry
      const slot = handle.slot;
      ensureLockCapacity(slot + 1);
      const cur = _lockOwner[slot];
      // Owned by another peer (ordering race between two peers' frames): last write wins —
      // evict the entry from that peer's dense list so structure stays consistent.
      if (cur > 1 && cur !== ownerKey) removeFromPeer(cur, slot);
      if (target === undefined) {
        target = { slots: [] };
        _peers.set(ownerKey, target);
      }
      _lockOwner[slot] = ownerKey;
      _lockedPos[slot] = target.slots.length;
      target.slots.push(slot);
      changed = true;
    }
  }

  if (rec !== undefined && rec.slots.length === 0) _peers.delete(ownerKey);
  if (!changed) return;

  markLockVeilDirty();
  if (ids.length > 0) for (const cb of _remoteApplied) cb(ids);
}

export function clearAllRemote(): void {
  if (_peers.size === 0) return;
  for (const rec of _peers.values()) {
    for (const slot of rec.slots) {
      _lockOwner[slot] = 0;
      _lockedPos[slot] = -1;
    }
  }
  _peers.clear();
  markLockVeilDirty();
}

function removeFromPeer(ownerKey: number, slot: number): void {
  const rec = _peers.get(ownerKey)!;
  const pos = _lockedPos[slot];
  const last = rec.slots.length - 1;
  const lastSlot = rec.slots[last];
  rec.slots[pos] = lastSlot;
  _lockedPos[lastSlot] = pos;
  rec.slots.pop();
  _lockedPos[slot] = -1;
  if (rec.slots.length === 0) _peers.delete(ownerKey);
}

// ── reactions ────────────────────────────────────────────────────────────────

/** Registered once by module singletons (selection-store, EraserTool); never unregistered. */
export function onRemoteLocksApplied(cb: (ids: readonly string[]) => void): void {
  _remoteApplied.push(cb);
}

/** `shrank` hints the wire layer: releases flush immediately (peers unblock fast), growth coalesces. */
export function onLocalLocksChanged(cb: (shrank: boolean) => void): void {
  _localChanged.push(cb);
}

function fireLocalChanged(shrank: boolean): void {
  for (const cb of _localChanged) cb(shrank);
}

// ── veil bridge (renderer/lock-veil/) ────────────────────────────────────────

/** Remote lock state or a locked object's geometry changed — poke the veil layer
 *  (injected via bindLockTable; the veil module coalesces + re-gathers bboxes). */
export function markLockVeilDirty(): void {
  _veilNotify?.();
}

export function hasRemoteLocks(): boolean {
  return _peers.size > 0;
}

export function remoteLockedCount(): number {
  let n = 0;
  for (const rec of _peers.values()) n += rec.slots.length;
  return n;
}

/**
 * Copy every remote-locked bbox out of the global slot column into `out`
 * (stride 4; caller sizes via `remoteLockedCount() * 4`). Returns the box
 * count. Safe by the PeerLocks liveness invariant — every slot here is live
 * with owner ≥ 2, so its column lane is fresh. No per-slot closure, no intern.
 */
export function fillRemoteLockedBoxes(out: Float64Array): number {
  const col = getBBoxColumn();
  let n = 0;
  for (const rec of _peers.values()) {
    for (const slot of rec.slots) {
      const src = slot * 4;
      const dst = n * 4;
      out[dst] = col[src];
      out[dst + 1] = col[src + 1];
      out[dst + 2] = col[src + 2];
      out[dst + 3] = col[src + 3];
      n++;
    }
  }
  return n;
}

// ── slot lifecycle (room-doc-manager) ────────────────────────────────────────

export function lockSlotAcquired(slot: number): void {
  ensureLockCapacity(slot + 1);
}

/**
 * Object deleted (observer Phase A) — must run before the freed slot can be reacquired in
 * Phase B. Common case is one load + compare (almost everything is 0).
 */
export function lockSlotReleased(slot: number): void {
  _locked[slot] = 0; // unconditional — a durable lock has no ephemeral owner to key off
  const owner = _lockOwner[slot];
  if (owner === 0) return;
  if (owner === 1) {
    // Locally-held object deleted by us mid-hold (e.g. empty-label cleanup). The id stays
    // in its source list as an inert entry — release re-interns by id and misses.
    _lockOwner[slot] = 0;
    return;
  }
  removeFromPeer(owner, slot);
  _lockOwner[slot] = 0;
  markLockVeilDirty();
}

export function ensureLockCapacity(n: number): void {
  if (n <= _cap) return;
  let cap = _cap;
  while (cap < n) cap *= 2;
  const owners = new Uint32Array(cap);
  owners.set(_lockOwner);
  _lockOwner = owners;
  const pos = new Int32Array(cap).fill(-1);
  pos.set(_lockedPos);
  _lockedPos = pos;
  const locked = new Uint8Array(cap);
  locked.set(_locked);
  _locked = locked;
  _cap = cap;
}

/** Room teardown + hydrate (slots renumber densely on hydrate — all prior state is void). */
export function resetLockTable(): void {
  _cap = INITIAL_CAP;
  _lockOwner = new Uint32Array(_cap);
  _lockedPos = new Int32Array(_cap).fill(-1);
  _locked = new Uint8Array(_cap);
  _peers.clear();
  for (const list of _sources) list.length = 0;
}
