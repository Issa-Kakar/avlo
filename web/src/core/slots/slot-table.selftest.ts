// biome-ignore-all lint/suspicious/noConsole: standalone test runner — console IS the output surface
/**
 * Slot-table + ZRankTable + sortU32Range self-test runner.
 *
 * Not part of the app bundle — executed standalone via esbuild+node:
 *   pnpm exec esbuild web/src/core/slots/slot-table.selftest.ts \
 *     --bundle --platform=node --format=esm --tsconfig=web/tsconfig.json \
 *     --outfile=<scratch>/selftest.mjs
 *   node <scratch>/selftest.mjs
 *
 * Coverage:
 *   1. Allocator — density [0..N-1], LIFO reuse, growth past INITIAL_CAP
 *      preserving live boxes + handle refs, release nulls the reverse map,
 *      reset restores initial state.
 *   2. Column sync — `registerHandle` seeds the column from `handle.bbox`;
 *      the `copyBbox` + `writeSlotBBox` pair (RoomDocManager upsertHandle's
 *      tripartite write, minus the tree) moves tuple + column together.
 *   3. ZRankTable — randomized add/remove/z-change churn (with slot
 *      recycling) vs a brute (z, id)-sort oracle: ranks match,
 *      `getSlotsByRank()` is the exact inverse over live slots, maxZ/minZ
 *      match INCLUDING immediately after deleting/moving the extreme (the
 *      self-heal path), dirty idempotence, and the capacity half of the
 *      `ensureRanksValid` gate (acquire past the rank arrays without
 *      `noteAdd` still rebuilds in-bounds).
 *   4. sortU32Range vs `Array.sort((a,b)=>a-b)` oracle — random /
 *      already-sorted / reversed / all-equal / sawtooth / duplicate-heavy /
 *      organ-pipe / near-sorted, values ≥ 2^31, sizes 0/1/2, insertion-cutoff
 *      boundaries, ≥100k, and nonzero [from,to) sub-ranges with the outside
 *      verified untouched.
 */
import type { ZKey } from '@avlo/shared';
import type * as Y from 'yjs';
import { sortU32Range } from '../../utils/sort-u32';
import { copyBbox } from '../geometry/bounds';
import type { BBoxTuple } from '../types/geometry';
import { createHandle, KIND_CODE, type ObjectHandle, type ObjectKind } from '../types/objects';
import { ZRankTable } from '../z-order/z-rank-table';
import {
  acquireSlot,
  getBBoxColumn,
  getHandlesBySlot,
  getKindCodes,
  registerHandle,
  releaseSlot,
  resetSlotTable,
  slotCapacity,
  slotHighWater,
  writeSlotBBox,
  writeSlotKind,
} from './slot-table';

// ───────────────────────────────────────────────────────────────── utilities ──

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let failures = 0;
let checks = 0;

function check(cond: boolean, msg: string): void {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

let idSeq = 0;
/** Fake handle — `y` is never touched by anything under test (type-only stand-in). */
function mkHandle(z: string, bbox: BBoxTuple = [0, 0, 1, 1], kind: ObjectKind = 'shape'): ObjectHandle {
  const id = `id${String(idSeq++).padStart(8, '0')}`;
  const h = createHandle(id, kind, null as unknown as Y.Map<unknown>, bbox, z as ZKey, acquireSlot());
  registerHandle(h);
  return h;
}

function boxEq(col: Float64Array, slot: number, b: Readonly<BBoxTuple>): boolean {
  const o = slot * 4;
  return col[o] === b[0] && col[o + 1] === b[1] && col[o + 2] === b[2] && col[o + 3] === b[3];
}

const zOracleCmp = (a: ObjectHandle, b: ObjectHandle): number => (a.z < b.z ? -1 : a.z > b.z ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// ──────────────────────────────────────────────────────────── 1. allocator ──

function testAllocator(): void {
  console.log('allocator');

  // Density: fresh table hands out [0..N-1] in order.
  resetSlotTable();
  let dense = true;
  for (let i = 0; i < 100; i++) if (acquireSlot() !== i) dense = false;
  check(dense, 'fresh acquires are dense [0..N-1]');
  check(slotHighWater() === 100, 'high water tracks acquires');

  // LIFO reuse: release a, b, c → reacquire c, b, a.
  resetSlotTable();
  idSeq = 0;
  const ha = mkHandle('a');
  const hb = mkHandle('b');
  const hc = mkHandle('c');
  releaseSlot(ha.slot);
  releaseSlot(hb.slot);
  releaseSlot(hc.slot);
  check(acquireSlot() === hc.slot && acquireSlot() === hb.slot && acquireSlot() === ha.slot, 'free list is LIFO');
  check(slotHighWater() === 3, 'recycling does not move the high water');

  // Release nulls the reverse map (GC leak guard).
  resetSlotTable();
  const hd = mkHandle('d');
  check(getHandlesBySlot()[hd.slot] === hd, 'registerHandle seeds the reverse map');
  releaseSlot(hd.slot);
  check(getHandlesBySlot()[hd.slot] === null, 'release nulls the reverse map entry');

  // Growth past INITIAL_CAP preserves live boxes + handle refs + kind codes.
  resetSlotTable();
  const KINDS: readonly ObjectKind[] = ['stroke', 'shape', 'text', 'connector', 'code', 'image', 'note', 'bookmark'];
  const many: ObjectHandle[] = [];
  for (let i = 0; i < 600; i++) many.push(mkHandle(`z${i}`, [i, i + 1, i + 2, i + 3], KINDS[i % KINDS.length]));
  check(slotCapacity() >= 600, 'capacity doubled past 256');
  check(slotHighWater() === 600, 'high water 600');
  {
    const col = getBBoxColumn(); // refetch AFTER growth — live-ref contract
    const bySlot = getHandlesBySlot();
    const kinds = getKindCodes();
    let boxesOk = true;
    let refsOk = true;
    let kindsOk = true;
    for (const h of many) {
      if (!boxEq(col, h.slot, h.bbox)) boxesOk = false;
      if (bySlot[h.slot] !== h) refsOk = false;
      if (kinds[h.slot] !== KIND_CODE[h.kind]) kindsOk = false;
    }
    check(boxesOk, 'growth preserved every live box');
    check(refsOk, 'growth preserved every handle ref');
    check(kindsOk, 'growth preserved every kind code');
  }

  // Reset restores initial state.
  resetSlotTable();
  check(slotHighWater() === 0 && slotCapacity() === 256, 'reset → high water 0, capacity 256');
  check(getHandlesBySlot().length === 256, 'reset → reverse map back to initial length');
  check(
    getHandlesBySlot().every((h) => h === null),
    'reset → reverse map all null',
  );
  check(getBBoxColumn().length === 256 * 4, 'reset → column back to initial length');
  check(getKindCodes().length === 256, 'reset → kind column back to initial length');
  check(
    getKindCodes().every((c) => c === 0),
    'reset → kind column all zero',
  );
  check(acquireSlot() === 0, 'first acquire after reset is 0');
}

// ─────────────────────────────────────────────────────────── 2. column sync ──

function testColumnSync(): void {
  console.log('column sync');
  resetSlotTable();
  idSeq = 0;

  const h = mkHandle('m', [1, 2, 3, 4], 'note');
  check(boxEq(getBBoxColumn(), h.slot, [1, 2, 3, 4]), 'registerHandle seeds column === bbox');
  check(getKindCodes()[h.slot] === KIND_CODE.note, 'registerHandle seeds the kind code');

  // The upsertHandle write pair (minus the tree): copyBbox then writeSlotBBox.
  const next: BBoxTuple = [10, 20, 30, 40];
  copyBbox(next, h.bbox);
  writeSlotBBox(h.slot, next);
  check(h.bbox[0] === 10 && h.bbox[1] === 20 && h.bbox[2] === 30 && h.bbox[3] === 40, 'copyBbox wrote the tuple');
  check(boxEq(getBBoxColumn(), h.slot, next), 'writeSlotBBox wrote the column lane');

  // The kind-keychange write pair (RDM conversion branch): handle.kind mirror + writeSlotKind.
  h.kind = 'shape';
  writeSlotKind(h.slot, KIND_CODE.shape);
  check(getKindCodes()[h.slot] === KIND_CODE.shape, 'writeSlotKind wrote the kind lane');
}

// ─────────────────────────────────────────────────────────── 3. ZRankTable ──

function verifyRanks(table: ZRankTable, live: ReadonlyMap<string, ObjectHandle>, ctx: string): void {
  table.ensureRanksValid();
  const sorted = [...live.values()].sort(zOracleCmp);
  const ranks = table.getRanks();
  const slotsByRank = table.getSlotsByRank();
  check(ranks.length >= slotHighWater(), `${ctx}: rank array covers slot high water`);
  let ranksOk = true;
  let inverseOk = true;
  for (let i = 0; i < sorted.length; i++) {
    if (ranks[sorted[i].slot] !== i) ranksOk = false;
    if (slotsByRank[i] !== sorted[i].slot) inverseOk = false;
  }
  check(ranksOk, `${ctx}: ranks match (z, id)-sort oracle`);
  check(inverseOk, `${ctx}: slotsByRank is the exact inverse over live slots`);
}

function verifyExtremes(table: ZRankTable, live: ReadonlyMap<string, ObjectHandle>, ctx: string): void {
  let max: ZKey | null = null;
  let min: ZKey | null = null;
  for (const h of live.values()) {
    if (max === null || h.z > max) max = h.z;
    if (min === null || h.z < min) min = h.z;
  }
  check(table.maxZ() === max, `${ctx}: maxZ matches oracle`);
  check(table.minZ() === min, `${ctx}: minZ matches oracle`);
}

function randZ(rng: () => number): string {
  const len = 2 + Math.floor(rng() * 6);
  let s = '';
  for (let i = 0; i < len; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rng() * 36)];
  return s;
}

function testZRankTable(): void {
  console.log('ZRankTable churn vs oracle');
  resetSlotTable();
  idSeq = 0;
  const table = new ZRankTable();
  const rng = mulberry32(0xc0ffee);
  const live = new Map<string, ObjectHandle>();

  const add = (z: string): ObjectHandle => {
    const h = mkHandle(z);
    table.noteAdd(h.z);
    live.set(h.id, h);
    return h;
  };
  // Mirrors observer Phase A ordering: noteRemove, then releaseSlot.
  const remove = (h: ObjectHandle): void => {
    table.noteRemove(h.z);
    releaseSlot(h.slot);
    live.delete(h.id);
  };
  const changeZ = (h: ObjectHandle, z: string): void => {
    table.noteZChanged(h.z, z as ZKey);
    h.z = z as ZKey;
  };
  const pickLive = (): ObjectHandle => {
    const arr = [...live.values()];
    return arr[Math.floor(rng() * arr.length)];
  };
  const extremeOf = (which: 'max' | 'min'): ObjectHandle => {
    let best: ObjectHandle | null = null;
    for (const h of live.values()) {
      if (best === null) best = h;
      else if (which === 'max' ? zOracleCmp(h, best) > 0 : zOracleCmp(h, best) < 0) best = h;
    }
    return best!;
  };

  // Batch churn: many ops between verifies (accumulated-dirty rebuild).
  for (let round = 0; round < 30; round++) {
    for (let op = 0; op < 40; op++) {
      const roll = rng();
      if (live.size === 0 || roll < 0.45) {
        // Occasional duplicate z exercises the id tie-break.
        add(live.size > 0 && rng() < 0.15 ? pickLive().z : randZ(rng));
      } else if (roll < 0.75) {
        remove(pickLive());
      } else {
        changeZ(pickLive(), randZ(rng));
      }
    }
    verifyRanks(table, live, `round ${round}`);
    verifyExtremes(table, live, `round ${round}`);
  }

  // Self-heal: delete the extreme, query maxZ/minZ IMMEDIATELY (no manual ensure).
  while (live.size < 10) add(randZ(rng));
  remove(extremeOf('max'));
  verifyExtremes(table, live, 'deleted max');
  remove(extremeOf('min'));
  verifyExtremes(table, live, 'deleted min');
  // Move the extreme downward/upward, query immediately.
  changeZ(extremeOf('max'), '0');
  verifyExtremes(table, live, 'moved max to bottom');
  changeZ(extremeOf('min'), 'zzzzzzzz');
  verifyExtremes(table, live, 'moved min to top');
  verifyRanks(table, live, 'post self-heal');

  // Dirty idempotence: a second ensure is a no-op (same array identity, same content).
  table.ensureRanksValid();
  const ranksBefore = table.getRanks();
  const snapshot = ranksBefore.slice();
  table.ensureRanksValid();
  check(table.getRanks() === ranksBefore, 'idempotent ensure keeps the same rank array');
  check(
    snapshot.every((v, i) => table.getRanks()[i] === v),
    'idempotent ensure keeps rank content',
  );

  // Capacity gate (the finding-9 sequence): fresh state, acquire past the rank
  // arrays WITHOUT noteAdd — ensure must still rebuild (length half of the gate)
  // and every live slot must read an in-bounds, oracle-correct rank.
  resetSlotTable();
  idSeq = 0;
  const t2 = new ZRankTable();
  const live2 = new Map<string, ObjectHandle>();
  t2.ensureRanksValid(); // clean + empty → _dirty false
  for (let i = 0; i < 300; i++) {
    const h = mkHandle(randZ(rng)); // acquire + register, NO noteAdd
    live2.set(h.id, h);
  }
  verifyRanks(t2, live2, 'acquire-without-noteAdd');

  table.clear();
  t2.clear();
  resetSlotTable();
}

// ──────────────────────────────────────────────────────────── 4. sortU32Range ──

function checkSortCase(name: string, values: readonly number[], from = 0, to = values.length): void {
  const arr = Uint32Array.from(values);
  const expected = Uint32Array.from(values);
  const sub = Array.from(expected.subarray(from, to)).sort((a, b) => a - b);
  expected.set(sub, from);
  sortU32Range(arr, from, to);
  let ok = true;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] !== expected[i]) {
      ok = false;
      break;
    }
  }
  check(ok, `sortU32Range ${name}`);
}

function testSortU32(): void {
  console.log('sortU32Range vs Array.sort oracle');
  const rng = mulberry32(0xbadc0de);
  const rnd = (n: number, domain: number): number[] => Array.from({ length: n }, () => Math.floor(rng() * domain));

  // Sizes 0/1/2 + insertion-cutoff boundaries (cutoff 16; 31/32/33 for margin).
  for (const n of [0, 1, 2, 15, 16, 17, 31, 32, 33]) {
    checkSortCase(`random n=${n}`, rnd(n, 1000));
    checkSortCase(
      `reversed n=${n}`,
      Array.from({ length: n }, (_, i) => n - i),
    );
  }

  // Patterns at quicksort scale.
  const N = 5000;
  checkSortCase('random', rnd(N, 1 << 30));
  checkSortCase(
    'already sorted',
    Array.from({ length: N }, (_, i) => i),
  );
  checkSortCase(
    'reversed',
    Array.from({ length: N }, (_, i) => N - i),
  );
  checkSortCase('all equal', new Array(N).fill(7));
  checkSortCase(
    'sawtooth',
    Array.from({ length: N }, (_, i) => i % 7),
  );
  checkSortCase('duplicate-heavy', rnd(N, 8));
  checkSortCase(
    'organ pipe',
    Array.from({ length: N }, (_, i) => (i < N / 2 ? i : N - i)),
  );
  {
    // Near-sorted (frame-coherent renderer input — the naive-pivot O(n²) trap).
    const near = Array.from({ length: 120000 }, (_, i) => i);
    for (let k = 0; k < 200; k++) {
      const a = Math.floor(rng() * near.length);
      const b = Math.floor(rng() * near.length);
      const t = near[a];
      near[a] = near[b];
      near[b] = t;
    }
    checkSortCase('near-sorted 120k', near);
  }

  // Full u32 range: keys ≥ 2^31 must order correctly (plain `<` on JS numbers).
  checkSortCase('values ≥ 2^31', [0xffffffff, 0, 0x80000000, 1, 0x7fffffff, 0xfffffffe, 2, 0x80000001]);
  checkSortCase(
    'random full-range',
    Array.from({ length: N }, () => Math.floor(rng() * 4294967296)),
  );

  // ≥100k random.
  checkSortCase('random 150k', rnd(150000, 4294967296));

  // Nonzero [from, to) sub-ranges — outside must stay untouched (checkSortCase's
  // oracle only sorts the sub-range, so any outside disturbance fails the compare).
  const base = rnd(1000, 100000);
  checkSortCase('subrange [100, 900)', base, 100, 900);
  checkSortCase('subrange [0, 500)', base, 0, 500);
  checkSortCase('subrange [500, 1000)', base, 500, 1000);
  checkSortCase('subrange empty [400, 400)', base, 400, 400);
  checkSortCase('subrange single [400, 401)', base, 400, 401);
}

// ───────────────────────────────────────────────────────────────── run ──

const t0 = performance.now();
testAllocator();
testColumnSync();
testZRankTable();
testSortU32();

const elapsed = performance.now() - t0;
console.log(`\n${checks} checks, ${failures} failures (${elapsed.toFixed(0)} ms)`);
if (failures > 0) process.exit(1);
