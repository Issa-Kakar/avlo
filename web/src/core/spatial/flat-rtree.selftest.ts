// biome-ignore-all lint/suspicious/noConsole: standalone test/bench runner — console IS the output surface
/**
 * FlatRTree self-test + A/B benchmark runner.
 *
 * Not part of the app bundle — executed standalone via esbuild+node:
 *   pnpm exec esbuild web/src/core/spatial/flat-rtree.selftest.ts \
 *     --bundle --platform=node --format=esm --outfile=<scratch>/selftest.mjs
 *   node <scratch>/selftest.mjs [--bench]        # --expose-gc adds the rbush memory figure
 *
 * Correctness runs three deliberately de-correlated oracles after every
 * mutation phase:
 *   1. differential queries vs a brute-force mirror (and vs rbush itself on
 *      replayed op sequences) — catches result-set divergence; every
 *      differential query runs BOTH query() and queryWide(), so the twin
 *      leaf-compaction bodies can never drift apart;
 *   2. per-item readBBox/has parity vs the mirror — catches stored-box
 *      corruption that random queries can mask, and is independent of
 *      validate(), whose exact-MBR audit flows through the same _recalcInto
 *      being tested;
 *   3. FlatRTree.validate() — structure: linkage bidirectionality, level
 *      ordering, count bounds, EXACT internal MBR equality, pool accounting.
 * Suites cover degenerate/duplicate/adversarial geometry (incl. equal-key
 * bulk load through the Floyd–Rivest selector), trust-boundary guards,
 * load-merge in all three height relations, rebuild mid-churn, and
 * maxEntries ∈ {4, 8, 32, 64}.
 *
 * Bench: A/B vs rbush on load / insert / search / update / remove / churn at
 * 10k / 100k / clustered 100k / 1M, reported as p50 (min) over warmed rounds;
 * stateful benches rebuild their input per round OUTSIDE the timed window.
 * Each structure runs its own configuration: FlatRTree(16) vs rbush(9) —
 * rbush's default and avlo's production ObjectSpatialIndex config (16-vs-16,
 * the algorithm-isolation framing, was the config of record through e5eb38a;
 * measured rbush(9)-vs-(16) differences are ±5-11%, row-dependent, an order
 * of magnitude below the flat-vs-rbush gap).
 */
import RBush from 'rbush';
import { FlatRTree } from './flat-rtree';

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

type Box = [number, number, number, number];

interface RItem {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  id: number;
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

function audit(tree: FlatRTree, ctx: string): void {
  checks++;
  try {
    tree.validate();
  } catch (e) {
    failures++;
    console.error(`  ✗ validate failed (${ctx}): ${(e as Error).message}`);
  }
}

function sortedIds(arr: ArrayLike<number>, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(arr[i]);
  out.sort((a, b) => a - b);
  return out;
}

function bruteQuery(mirror: Map<number, Box>, q: Box): number[] {
  const out: number[] = [];
  for (const [id, b] of mirror) {
    if (b[0] <= q[2] && b[2] >= q[0] && b[1] <= q[3] && b[3] >= q[1]) out.push(id);
  }
  out.sort((a, b) => a - b);
  return out;
}

function sameIds(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function randBox(rng: () => number, world: number, maxW: number, maxH: number): Box {
  const w = rng() * maxW;
  const h = rng() * maxH;
  const x = (rng() * 2 - 1) * world;
  const y = (rng() * 2 - 1) * world;
  return [x, y, x + w, y + h];
}

const rbOut = new Float64Array(4);

/**
 * Per-item parity: every mirror id present with EXACTLY the stored box, and
 * sizes equal. This is a second oracle deliberately de-correlated from the
 * query path AND from validate() (which audits MBR exactness via the same
 * _recalcInto under test): a corrupted-but-consistently-propagated stored box
 * would pass validate and could dodge random queries; it cannot dodge this.
 */
function diffItems(tree: FlatRTree, mirror: Map<number, Box>, ctx: string): void {
  checks++;
  if (tree.size !== mirror.size) {
    failures++;
    console.error(`  ✗ ${ctx}: size ${tree.size} !== mirror ${mirror.size}`);
  }
  let bad = 0;
  for (const [id, b] of mirror) {
    if (!tree.has(id) || !tree.readBBox(id, rbOut) || rbOut[0] !== b[0] || rbOut[1] !== b[1] || rbOut[2] !== b[2] || rbOut[3] !== b[3])
      bad++;
  }
  checks++;
  if (bad > 0) {
    failures++;
    console.error(`  ✗ ${ctx}: ${bad} items missing or with wrong stored box`);
  }
}

/** Differential check: FlatRTree vs brute mirror on `qn` random queries, then a full per-item parity sweep. */
function diffQueries(
  tree: FlatRTree,
  mirror: Map<number, Box>,
  rng: () => number,
  qn: number,
  ctx: string,
  world = 1200,
  qw = 500,
  qh = 500,
): void {
  for (let i = 0; i < qn; i++) {
    const q = randBox(rng, world, qw, qh);
    const n = tree.query(q[0], q[1], q[2], q[3]);
    const got = sortedIds(tree.results, n);
    const want = bruteQuery(mirror, q);
    check(sameIds(got, want), `${ctx}: query #${i} mismatch (got ${got.length}, want ${want.length})`);
    const nw = tree.queryWide(q[0], q[1], q[2], q[3]);
    check(sameIds(sortedIds(tree.results, nw), want), `${ctx}: queryWide #${i} mismatch (got ${nw}, want ${want.length})`);
    check(tree.collides(q[0], q[1], q[2], q[3]) === want.length > 0, `${ctx}: collides #${i} mismatch`);
  }
  diffItems(tree, mirror, ctx);
}

// ─────────────────────────────────────────────────────────────── test suites ──

function tEmpty(): void {
  const t = new FlatRTree();
  check(t.size === 0, 'empty: size 0');
  check(t.query(-1e9, -1e9, 1e9, 1e9) === 0, 'empty: query 0');
  check(!t.collides(-1e9, -1e9, 1e9, 1e9), 'empty: no collides');
  check(t.queryAll() === 0, 'empty: queryAll 0');
  check(!t.remove(42), 'empty: remove missing false');
  check(!t.has(7), 'empty: has false');
  audit(t, 'empty');
}

function tBasicAndDegenerate(): void {
  const t = new FlatRTree();
  const mirror = new Map<number, Box>();
  const put = (id: number, b: Box) => {
    t.insert(id, b[0], b[1], b[2], b[3]);
    mirror.set(id, b);
  };
  put(0, [0, 0, 10, 10]);
  put(1, [0, 0, 10, 10]); // exact duplicate box
  put(2, [5, 5, 5, 5]); //   zero-area point box
  put(3, [-100, -100, -90, -90]); // negative coords
  put(4, [1e7, 1e7, 1e7 + 1, 1e7 + 1]); // far away
  audit(t, 'basic insert');

  let n = t.query(0, 0, 10, 10);
  check(sameIds(sortedIds(t.results, n), [0, 1, 2]), 'basic: overlap query');
  n = t.query(5, 5, 5, 5);
  check(sameIds(sortedIds(t.results, n), [0, 1, 2]), 'basic: point query');
  n = t.query(-101, -101, -99, -99);
  check(sameIds(sortedIds(t.results, n), [3]), 'basic: negative query');
  check(t.queryAll() === 5, 'basic: queryAll count');

  const out = new Float64Array(4);
  check(t.readBBox(3, out) && out[0] === -100 && out[3] === -90, 'basic: readBBox');
  check(!t.readBBox(99, out), 'basic: readBBox missing');

  const view = t.search(0, 0, 10, 10);
  check(view.length === 3 && view.buffer === t.results.buffer, 'basic: search() subarray view over results');
  check(t.all().length === t.size, 'basic: all() view length');

  let threw = false;
  try {
    t.insert(2, 0, 0, 1, 1);
  } catch {
    threw = true;
  }
  check(threw, 'basic: duplicate insert throws');

  check(t.remove(1), 'basic: remove true');
  check(!t.remove(1), 'basic: re-remove false');
  mirror.delete(1);
  n = t.query(0, 0, 10, 10);
  check(sameIds(sortedIds(t.results, n), [0, 2]), 'basic: query after remove');
  audit(t, 'basic after remove');
}

function tGuards(): void {
  const throws = (fn: () => void, msg: string): void => {
    let ok = false;
    try {
      fn();
    } catch {
      ok = true;
    }
    check(ok, msg);
  };

  const t = new FlatRTree();
  throws(() => t.insert(0xffffffff, 0, 0, 1, 1), 'guards: id === NONE throws');
  throws(() => t.insert(0x40000000, 0, 0, 1, 1), 'guards: id === 2^30 throws');
  throws(() => t.insert(0x40000001, 0, 0, 1, 1), 'guards: id > 2^30 throws');
  throws(() => t.insert(-1, 0, 0, 1, 1), 'guards: negative id throws');
  throws(() => t.insert(1.5, 0, 0, 1, 1), 'guards: fractional id throws');
  t.insert(3, 0, 0, 1, 1);
  throws(() => t.insert(3, 2, 2, 3, 3), 'guards: duplicate insert throws');
  check(t.size === 1, 'guards: rejected inserts left size intact');
  audit(t, 'guards after rejected inserts');
  t.insert((1 << 22) + 5, 7, 7, 8, 8); // sparse-high valid id — clz32 map growth in one hop
  check(t.has((1 << 22) + 5) && t.size === 2, 'guards: large valid id insert');
  audit(t, 'guards large id');
  t.remove((1 << 22) + 5);

  t.load(0, [], []);
  check(t.size === 1, 'guards: load(0) no-op');
  throws(() => t.load(2, [10], [0, 0, 1, 1, 0, 0, 1, 1]), 'guards: load short ids throws');
  throws(() => t.load(2, [10, 11], [0, 0, 1, 1]), 'guards: load short boxes throws');
  {
    const ids = [30, 31, 32, 33, 34, 35, 0x40000000, 36];
    const boxes: number[] = [];
    for (let i = 0; i < 8; i++) boxes.push(i, i, i + 1, i + 1);
    const tg = new FlatRTree();
    throws(() => tg.load(8, ids, boxes), 'guards: load id ≥ 2^30 throws');
  }

  {
    // duplicate WITHIN one batch (count ≥ minEntries so the bulk path runs)
    const ids = [20, 21, 22, 23, 24, 25, 26, 20];
    const boxes: number[] = [];
    for (let i = 0; i < 8; i++) boxes.push(i, i, i + 1, i + 1);
    const t2 = new FlatRTree();
    throws(() => t2.load(8, ids, boxes), 'guards: intra-batch duplicate load throws');
  }
  {
    // duplicate vs an id already in the tree
    const t3 = new FlatRTree();
    t3.insert(5, 0, 0, 1, 1);
    const ids = [1, 2, 3, 4, 5, 6, 7, 8];
    const boxes: number[] = [];
    for (let i = 0; i < 8; i++) boxes.push(i, i, i + 1, i + 1);
    throws(() => t3.load(8, ids, boxes), 'guards: load duplicate-vs-tree throws');
  }
  {
    // oversized backing arrays (reused-scratch pattern) — typed fast path
    const t4 = new FlatRTree();
    const mirror = new Map<number, Box>();
    const ids = new Uint32Array(64);
    const boxes = new Float64Array(256);
    for (let i = 0; i < 10; i++) {
      ids[i] = i;
      const j = i << 2;
      boxes[j] = i * 10;
      boxes[j + 1] = 0;
      boxes[j + 2] = i * 10 + 5;
      boxes[j + 3] = 5;
      mirror.set(i, [i * 10, 0, i * 10 + 5, 5]);
    }
    t4.load(10, ids, boxes);
    check(t4.size === 10, 'guards: load from oversized typed backing');
    audit(t4, 'guards oversized typed load');
    diffItems(t4, mirror, 'guards oversized typed load');
  }
  {
    // oversized plain-array backing — element-copy path
    const t5 = new FlatRTree();
    const mirror = new Map<number, Box>();
    const ids: number[] = [];
    const boxes: number[] = [];
    for (let i = 0; i < 12; i++) {
      ids.push(100 + i);
      boxes.push(i * 3, 1, i * 3 + 2, 4);
      if (i < 8) mirror.set(100 + i, [i * 3, 1, i * 3 + 2, 4]);
    }
    t5.load(8, ids, boxes);
    check(t5.size === 8, 'guards: load from oversized plain backing');
    audit(t5, 'guards oversized plain load');
    diffItems(t5, mirror, 'guards oversized plain load');
  }
  {
    // upsert via update() for an id beyond the reverse map's current length
    const t6 = new FlatRTree();
    t6.update(5000, 1, 1, 2, 2);
    check(t6.has(5000) && t6.size === 1, 'guards: update-upsert beyond map length');
    audit(t6, 'guards upsert');
  }
}

function tAdversarial(): void {
  // Monotone thin slabs — worst case for least-enlargement descent order.
  const t = new FlatRTree();
  const mirror = new Map<number, Box>();
  for (let i = 0; i < 3000; i++) {
    const b: Box = [i * 10, 0, i * 10 + 4, 1000];
    t.insert(i, b[0], b[1], b[2], b[3]);
    mirror.set(i, b);
  }
  audit(t, 'adversarial slabs');
  const rng = mulberry32(66);
  diffQueries(t, mirror, rng, 80, 'adversarial slabs', 31000, 900, 1400);
  for (let i = 0; i < 3000; i += 2) {
    t.remove(i);
    mirror.delete(i);
  }
  audit(t, 'adversarial slabs thinned');
  diffQueries(t, mirror, rng, 80, 'adversarial slabs thinned', 31000, 900, 1400);

  // Nested concentric boxes — every box contains all later ones (tie stress
  // for enlargement, margin, and overlap metrics simultaneously).
  const t2 = new FlatRTree();
  const m2 = new Map<number, Box>();
  for (let i = 0; i < 900; i++) {
    const b: Box = [i, i, 2000 - i, 2000 - i];
    t2.insert(i, b[0], b[1], b[2], b[3]);
    m2.set(i, b);
  }
  audit(t2, 'adversarial nested');
  diffQueries(t2, m2, rng, 60, 'adversarial nested', 1400, 700, 700);
  for (let i = 0; i < 900; i += 3) {
    t2.remove(i);
    m2.delete(i);
  }
  for (let i = 1; i < 900; i += 3) {
    const b: Box = [i - 0.5, i, 2000 - i, 2000 - i + 0.5];
    t2.update(i, b[0], b[1], b[2], b[3]);
    m2.set(i, b);
  }
  audit(t2, 'adversarial nested churned');
  diffQueries(t2, m2, rng, 60, 'adversarial nested churned', 1400, 700, 700);
}

function tRandomInsertSearch(seed: number, count: number): void {
  const rng = mulberry32(seed);
  const t = new FlatRTree();
  const mirror = new Map<number, Box>();
  for (let i = 0; i < count; i++) {
    const b = randBox(rng, 1000, 60, 60);
    t.insert(i, b[0], b[1], b[2], b[3]);
    mirror.set(i, b);
  }
  check(t.size === count, `rand(${seed}): size`);
  audit(t, `rand(${seed}) after inserts`);
  diffQueries(t, mirror, rng, 150, `rand(${seed})`);

  // whole-world query must return everything (exercises the contained-subtree dump)
  const n = t.query(-1e9, -1e9, 1e9, 1e9);
  check(n === count, `rand(${seed}): world query count`);
  check(
    sameIds(
      sortedIds(t.results, n),
      [...mirror.keys()].sort((a, b) => a - b),
    ),
    `rand(${seed}): world ids`,
  );
}

function tRemove(seed: number, count: number): void {
  const rng = mulberry32(seed);
  const t = new FlatRTree();
  const mirror = new Map<number, Box>();
  for (let i = 0; i < count; i++) {
    const b = randBox(rng, 1000, 60, 60);
    t.insert(i, b[0], b[1], b[2], b[3]);
    mirror.set(i, b);
  }
  for (let i = 0; i < count; i += 2) {
    check(t.remove(i), `remove(${seed}): remove ${i}`);
    mirror.delete(i);
  }
  audit(t, `remove(${seed}) after half`);
  diffQueries(t, mirror, rng, 100, `remove(${seed}) half`);

  for (let i = 1; i < count; i += 2) {
    t.remove(i);
    mirror.delete(i);
  }
  check(t.size === 0, `remove(${seed}): emptied`);
  audit(t, `remove(${seed}) emptied`);
  check(t.query(-1e9, -1e9, 1e9, 1e9) === 0, `remove(${seed}): empty query`);

  // tree remains usable after emptying
  t.insert(123456, 1, 2, 3, 4);
  check(t.query(0, 0, 5, 5) === 1 && t.results[0] === 123456, `remove(${seed}): reuse after empty`);
  audit(t, `remove(${seed}) reused`);
}

function tUpdate(seed: number, count: number): void {
  const rng = mulberry32(seed);
  const t = new FlatRTree();
  const mirror = new Map<number, Box>();
  for (let i = 0; i < count; i++) {
    const b = randBox(rng, 1000, 60, 60);
    t.insert(i, b[0], b[1], b[2], b[3]);
    mirror.set(i, b);
  }

  // jitter: small in-place moves (drag-frame pattern)
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < count; i++) {
      const b = mirror.get(i) as Box;
      const dx = (rng() - 0.5) * 8;
      const dy = (rng() - 0.5) * 8;
      const nb: Box = [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy];
      t.update(i, nb[0], nb[1], nb[2], nb[3]);
      mirror.set(i, nb);
    }
    audit(t, `update(${seed}) jitter round ${round}`);
  }
  diffQueries(t, mirror, rng, 100, `update(${seed}) jitter`);

  // teleports: guaranteed relocation path
  for (let i = 0; i < count; i += 3) {
    const nb = randBox(rng, 1000, 60, 60);
    t.update(i, nb[0], nb[1], nb[2], nb[3]);
    mirror.set(i, nb);
  }
  audit(t, `update(${seed}) teleports`);
  diffQueries(t, mirror, rng, 100, `update(${seed}) teleports`);

  // resize in place (grow + shrink, same origin)
  for (let i = 0; i < count; i += 5) {
    const b = mirror.get(i) as Box;
    const nb: Box = [b[0], b[1], b[0] + rng() * 200, b[1] + rng() * 200];
    t.update(i, nb[0], nb[1], nb[2], nb[3]);
    mirror.set(i, nb);
  }
  audit(t, `update(${seed}) resize`);
  diffQueries(t, mirror, rng, 100, `update(${seed}) resize`);

  // upsert on absent id
  const nb = randBox(rng, 1000, 60, 60);
  t.update(count + 7, nb[0], nb[1], nb[2], nb[3]);
  mirror.set(count + 7, nb);
  check(t.has(count + 7), `update(${seed}): upsert inserted`);
  check(t.size === mirror.size, `update(${seed}): size after upsert`);
  audit(t, `update(${seed}) upsert`);
}

function tLoad(seed: number, count: number): void {
  const rng = mulberry32(seed);
  const ids = new Uint32Array(count);
  const boxes = new Float64Array(count << 2);
  const mirror = new Map<number, Box>();
  for (let i = 0; i < count; i++) {
    const b = randBox(rng, 1000, 60, 60);
    ids[i] = i;
    boxes.set(b, i << 2);
    mirror.set(i, b);
  }
  const t = new FlatRTree();
  t.load(count, ids, boxes);
  check(t.size === count, `load(${seed}): size`);
  audit(t, `load(${seed})`);
  diffQueries(t, mirror, rng, 150, `load(${seed})`);
  const st = t.stats();
  check(st.height <= Math.ceil(Math.log(count) / Math.log(t.maxEntries)) + 1, `load(${seed}): height sane (${st.height})`);
  check(st.avgLeafFill > 0.3, `load(${seed}): fill ${st.avgLeafFill.toFixed(2)}`);

  // merge a second batch into the non-empty tree (join path)
  const extra = Math.max(64, count >> 2);
  const ids2 = new Uint32Array(extra);
  const boxes2 = new Float64Array(extra << 2);
  for (let i = 0; i < extra; i++) {
    const b = randBox(rng, 1000, 60, 60);
    ids2[i] = count + i;
    boxes2.set(b, i << 2);
    mirror.set(count + i, b);
  }
  t.load(extra, ids2, boxes2);
  check(t.size === count + extra, `load(${seed}): merged size`);
  audit(t, `load(${seed}) merged`);
  diffQueries(t, mirror, rng, 150, `load(${seed}) merged`);

  // tiny load (< minEntries) takes the insert path
  const t2 = new FlatRTree();
  t2.load(3, [900001, 900002, 900003], [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  check(t2.size === 3, 'load tiny: size');
  audit(t2, 'load tiny');

  // small tree + big load (swap-roles join path)
  const t3 = new FlatRTree();
  t3.insert(0, 0, 0, 1, 1);
  const m3 = new Map<number, Box>([[0, [0, 0, 1, 1]]]);
  const n3 = 2000;
  const ids3 = new Uint32Array(n3);
  const boxes3 = new Float64Array(n3 << 2);
  for (let i = 0; i < n3; i++) {
    const b = randBox(rng, 1000, 60, 60);
    ids3[i] = i + 1;
    boxes3.set(b, i << 2);
    m3.set(i + 1, b);
  }
  t3.load(n3, ids3, boxes3);
  check(t3.size === n3 + 1, 'load swap: size');
  audit(t3, 'load swap');
  diffQueries(t3, m3, rng, 100, 'load swap');
}

function tRebuildAndClear(seed: number): void {
  const rng = mulberry32(seed);
  const t = new FlatRTree();
  const mirror = new Map<number, Box>();
  for (let i = 0; i < 3000; i++) {
    const b = randBox(rng, 1000, 60, 60);
    t.insert(i, b[0], b[1], b[2], b[3]);
    mirror.set(i, b);
  }
  for (let i = 0; i < 3000; i += 2) {
    t.remove(i);
    mirror.delete(i);
  }
  const before = t.stats();
  t.rebuild();
  const after = t.stats();
  check(t.size === mirror.size, 'rebuild: size preserved');
  check(after.avgLeafFill >= before.avgLeafFill, `rebuild: fill ${before.avgLeafFill.toFixed(2)} → ${after.avgLeafFill.toFixed(2)}`);
  audit(t, 'rebuild');
  diffQueries(t, mirror, rng, 100, 'rebuild');

  t.clear();
  check(t.size === 0 && t.query(-1e9, -1e9, 1e9, 1e9) === 0, 'clear: emptied');
  audit(t, 'clear');
  t.insert(5, 0, 0, 1, 1);
  check(t.size === 1, 'clear: reusable');
  audit(t, 'clear reused');
}

function tDuplicateBoxStress(): void {
  const t = new FlatRTree();
  const mirror = new Map<number, Box>();
  for (let i = 0; i < 500; i++) {
    t.insert(i, 10, 10, 20, 20); // 500 identical boxes — split tie-break stress
    mirror.set(i, [10, 10, 20, 20]);
  }
  audit(t, 'dup boxes');
  const n = t.query(15, 15, 15, 15);
  check(n === 500, `dup boxes: all found (${n})`);
  const rng = mulberry32(1);
  diffQueries(t, mirror, rng, 30, 'dup boxes');
  for (let i = 0; i < 500; i++) t.remove(i);
  check(t.size === 0, 'dup boxes: emptied');
  audit(t, 'dup boxes emptied');

  // bulk load of identical boxes — equal-key partition edge in the
  // Floyd–Rivest selector (range > its 600-element sampling threshold)
  const t2 = new FlatRTree();
  const n2 = 2000;
  const ids2 = new Uint32Array(n2);
  const boxes2 = new Float64Array(n2 << 2);
  for (let i = 0; i < n2; i++) {
    ids2[i] = i;
    const j = i << 2;
    boxes2[j] = 10;
    boxes2[j + 1] = 10;
    boxes2[j + 2] = 20;
    boxes2[j + 3] = 20;
  }
  t2.load(n2, ids2, boxes2);
  check(t2.size === n2, 'dup boxes: bulk load size');
  audit(t2, 'dup boxes bulk load');
  check(t2.query(15, 15, 15, 15) === n2, 'dup boxes: bulk load all found');
}

function tChurn(seed: number, ops: number): void {
  const rng = mulberry32(seed);
  const t = new FlatRTree();
  const mirror = new Map<number, Box>();
  let nextId = 0;
  const live: number[] = [];

  for (let op = 0; op < ops; op++) {
    const r = rng();
    if (r < 0.4 || live.length === 0) {
      const id = nextId++;
      const b = randBox(rng, 1000, 60, 60);
      t.insert(id, b[0], b[1], b[2], b[3]);
      mirror.set(id, b);
      live.push(id);
    } else if (r < 0.65) {
      const id = live[(rng() * live.length) | 0];
      const big = rng() < 0.2;
      const b = mirror.get(id) as Box;
      const nb: Box = big
        ? randBox(rng, 1000, 60, 60)
        : [b[0] + rng() * 10 - 5, b[1] + rng() * 10 - 5, b[2] + rng() * 10 - 5, b[3] + rng() * 10 - 5];
      if (nb[2] < nb[0]) [nb[0], nb[2]] = [nb[2], nb[0]];
      if (nb[3] < nb[1]) [nb[1], nb[3]] = [nb[3], nb[1]];
      t.update(id, nb[0], nb[1], nb[2], nb[3]);
      mirror.set(id, nb);
    } else if (r < 0.85) {
      const k = (rng() * live.length) | 0;
      const id = live[k];
      live[k] = live[live.length - 1];
      live.pop();
      check(t.remove(id), `churn(${seed}): remove ${id} @op ${op}`);
      mirror.delete(id);
    } else {
      const q = randBox(rng, 1200, 400, 400);
      const n = t.query(q[0], q[1], q[2], q[3]);
      const got = sortedIds(t.results, n);
      const want = bruteQuery(mirror, q);
      check(sameIds(got, want), `churn(${seed}): query mismatch @op ${op}`);
    }
    if (op % 1000 === 999) audit(t, `churn(${seed}) @op ${op}`);
    if (op % 3500 === 3499) {
      t.rebuild(); // repack mid-churn, then keep churning on the repacked tree
      audit(t, `churn(${seed}) rebuilt @op ${op}`);
    }
  }
  check(t.size === mirror.size, `churn(${seed}): final size`);
  audit(t, `churn(${seed}) final`);
  diffQueries(t, mirror, rng, 100, `churn(${seed}) final`);
}

/** Same op sequence against FlatRTree and rbush; query results must match. */
function tRBushParity(seed: number, ops: number): void {
  const rng = mulberry32(seed);
  const t = new FlatRTree();
  const r = new RBush<RItem>(9);
  const items = new Map<number, RItem>();
  let nextId = 0;

  for (let op = 0; op < ops; op++) {
    const roll = rng();
    if (roll < 0.45 || items.size === 0) {
      const b = randBox(rng, 1000, 60, 60);
      const id = nextId++;
      const it: RItem = { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3], id };
      t.insert(id, b[0], b[1], b[2], b[3]);
      r.insert(it);
      items.set(id, it);
    } else if (roll < 0.7) {
      const keys = [...items.keys()];
      const id = keys[(rng() * keys.length) | 0];
      const it = items.get(id) as RItem;
      const b = randBox(rng, 1000, 60, 60);
      r.remove(it);
      it.minX = b[0];
      it.minY = b[1];
      it.maxX = b[2];
      it.maxY = b[3];
      r.insert(it);
      t.update(id, b[0], b[1], b[2], b[3]);
    } else if (roll < 0.85) {
      const keys = [...items.keys()];
      const id = keys[(rng() * keys.length) | 0];
      r.remove(items.get(id) as RItem);
      items.delete(id);
      t.remove(id);
    } else {
      const q = randBox(rng, 1200, 400, 400);
      const n = t.query(q[0], q[1], q[2], q[3]);
      const got = sortedIds(t.results, n);
      const want = r
        .search({ minX: q[0], minY: q[1], maxX: q[2], maxY: q[3] })
        .map((x) => x.id)
        .sort((a, b) => a - b);
      check(sameIds(got, want), `parity(${seed}): mismatch @op ${op} (${got.length} vs ${want.length})`);
    }
  }
  audit(t, `parity(${seed}) final`);
}

// ─────────────────────────────────────────────────────────────────── bench ──

interface Dataset {
  n: number;
  ids: Uint32Array;
  boxes: Float64Array;
  label: string;
}

function genUniform(n: number, seed: number): Dataset {
  const rng = mulberry32(seed);
  const ids = new Uint32Array(n);
  const boxes = new Float64Array(n << 2);
  for (let i = 0; i < n; i++) {
    ids[i] = i;
    const j = i << 2;
    const x = rng() * 100000;
    const y = rng() * 100000;
    boxes[j] = x;
    boxes[j + 1] = y;
    boxes[j + 2] = x + rng() * 200 + 1;
    boxes[j + 3] = y + rng() * 120 + 1;
  }
  return { n, ids, boxes, label: `uniform ${n / 1000}k` };
}

function genClustered(n: number, seed: number): Dataset {
  const rng = mulberry32(seed);
  const ids = new Uint32Array(n);
  const boxes = new Float64Array(n << 2);
  const clusters = 200;
  const cx = new Float64Array(clusters);
  const cy = new Float64Array(clusters);
  for (let c = 0; c < clusters; c++) {
    cx[c] = rng() * 100000;
    cy[c] = rng() * 100000;
  }
  for (let i = 0; i < n; i++) {
    ids[i] = i;
    const c = (rng() * clusters) | 0;
    const x = cx[c] + (rng() - 0.5) * 3000;
    const y = cy[c] + (rng() - 0.5) * 3000;
    const j = i << 2;
    boxes[j] = x;
    boxes[j + 1] = y;
    boxes[j + 2] = x + rng() * 200 + 1;
    boxes[j + 3] = y + rng() * 120 + 1;
  }
  return { n, ids, boxes, label: `clustered ${n / 1000}k` };
}

function makeItems(d: Dataset): RItem[] {
  const items: RItem[] = new Array(d.n);
  for (let i = 0; i < d.n; i++) {
    const j = i << 2;
    items[i] = { minX: d.boxes[j], minY: d.boxes[j + 1], maxX: d.boxes[j + 2], maxY: d.boxes[j + 3], id: d.ids[i] };
  }
  return items;
}

let sink = 0; // defeats dead-code elimination

/**
 * Timed rounds of `fn`, returning SORTED per-round ms samples. `setup` (when
 * given) runs before every round — warmups included — outside the timed
 * window, so stateful benches (remove-all, churn) get identical starting
 * state per round instead of a best-of over divergent states. Warmup rounds
 * absorb JIT tiering so the median isn't polluted by compile time.
 */
function measureS(fn: () => void, rounds: number, warmup = 1, setup?: () => void): number[] {
  for (let w = 0; w < warmup; w++) {
    setup?.();
    fn();
  }
  const s: number[] = [];
  for (let r = 0; r < rounds; r++) {
    setup?.();
    const t0 = performance.now();
    fn();
    s.push(performance.now() - t0);
  }
  return s.sort((a, b) => a - b);
}

/** Percentile over sorted samples (nearest-rank on the sorted array). */
const pctl = (s: number[], q: number): number => s[Math.min(s.length - 1, Math.round((s.length - 1) * q))];

function fmtSamples(s: number[]): string {
  return `${pctl(s, 0.5).toFixed(2).padStart(9)} (${s[0].toFixed(2)})`.padStart(20);
}

/** Ratio is computed on p50 — the honest central estimate; min shown in parens. */
function row(name: string, flat: number[], rbush: number[], unit: string): void {
  const ratio = pctl(rbush, 0.5) / pctl(flat, 0.5);
  console.log(
    `  ${name.padEnd(30)}${fmtSamples(flat)}${fmtSamples(rbush)}   ${ratio >= 1 ? `${ratio.toFixed(2)}× faster` : `${(1 / ratio).toFixed(2)}× SLOWER`}  ${unit}`,
  );
}

/** rbush retained-heap estimate (includes the item objects rbush requires). Needs --expose-gc. */
function rbushRetainedKiB(d: Dataset): number | null {
  const g = (globalThis as { gc?: () => void }).gc;
  if (!g) return null;
  g();
  g();
  const before = process.memoryUsage().heapUsed;
  // Items allocated INSIDE the window: they are rbush's only box storage, the
  // counterpart of FlatRTree's _boxes (which its bytes figure includes).
  const r = new RBush<RItem>(9);
  r.load(makeItems(d));
  g();
  g();
  const after = process.memoryUsage().heapUsed;
  sink += r.all().length;
  return (after - before) / 1024;
}

function benchDataset(d: Dataset, perOp = true): void {
  console.log(`\n■ ${d.label}`);
  console.log(`  ${'benchmark'.padEnd(30)}${'Flat p50 (min)'.padStart(20)}${'rbush p50 (min)'.padStart(20)}`);

  const big = d.n >= 500000;
  const queries: Box[] = [];
  const rng = mulberry32(999);
  const mkQueries = (count: number, w: number, h: number) => {
    queries.length = 0;
    for (let i = 0; i < count; i++) {
      const x = rng() * 100000;
      const y = rng() * 100000;
      queries.push([x, y, x + w, y + h]);
    }
  };

  // ── bulk load
  const loadFlat = measureS(
    () => {
      const t = new FlatRTree(16);
      t.load(d.n, d.ids, d.boxes);
      sink += t.size;
    },
    big ? 4 : 7,
  );
  const itemsForLoad = makeItems(d);
  const loadRbush = measureS(
    () => {
      const r = new RBush<RItem>(9);
      r.load(itemsForLoad);
      sink += r.all().length;
    },
    big ? 4 : 7,
  );
  row('bulk load', loadFlat, loadRbush, `(${d.n / 1000}k items)`);

  if (perOp) {
    // ── one-by-one insert
    const insFlat = measureS(() => {
      const t = new FlatRTree(16);
      for (let i = 0; i < d.n; i++) {
        const j = i << 2;
        t.insert(d.ids[i], d.boxes[j], d.boxes[j + 1], d.boxes[j + 2], d.boxes[j + 3]);
      }
      sink += t.size;
    }, 5);
    const insRbush = measureS(() => {
      const r = new RBush<RItem>(9);
      const items = makeItems(d);
      for (let i = 0; i < d.n; i++) r.insert(items[i]);
      sink += r.all().length;
    }, 5);
    row('insert one-by-one', insFlat, insRbush, `(${d.n / 1000}k items)`);
  }

  // steady trees for query/update benches
  const T = new FlatRTree(16);
  T.load(d.n, d.ids, d.boxes);
  const R = new RBush<RItem>(9);
  const rItems = makeItems(d);
  R.load(rItems);

  const searchBench = (label: string, count: number, w: number, h: number, wide: boolean) => {
    mkQueries(count, w, h);
    const qs = queries.slice();
    const f = measureS(
      wide
        ? () => {
            for (let i = 0; i < qs.length; i++) {
              const q = qs[i];
              sink += T.queryWide(q[0], q[1], q[2], q[3]);
            }
          }
        : () => {
            for (let i = 0; i < qs.length; i++) {
              const q = qs[i];
              sink += T.query(q[0], q[1], q[2], q[3]);
            }
          },
      15,
      2,
    );
    const rb = measureS(
      () => {
        const s = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
        for (let i = 0; i < qs.length; i++) {
          const q = qs[i];
          s.minX = q[0];
          s.minY = q[1];
          s.maxX = q[2];
          s.maxY = q[3];
          sink += R.search(s).length;
        }
      },
      15,
      2,
    );
    row(label, f, rb, `(${count} queries)`);
  };

  // narrow shape → query(); wide shapes → queryWide() — the caller-selection
  // rule integration will follow (pickers narrow, culls wide).
  searchBench('search: hit-test 10×10', 4000, 10, 10, false);
  searchBench('search: block 500×500 (wide)', 2000, 500, 500, true);
  searchBench('search: viewport 5k×3k (wide)', 1000, 5000, 3000, true);
  searchBench('search: zoom-out 40k² (wide)', 100, 40000, 40000, true);

  if (perOp) {
    // ── update: jitter every item +δ then −δ — state-neutral per round, so
    // every sample starts from identical box values (structure converges
    // after warmup) and percentiles compare like with like.
    const jit = new Float64Array(d.n);
    const jrng = mulberry32(7);
    for (let i = 0; i < d.n; i++) jit[i] = (jrng() - 0.5) * 6;
    const updFlat = measureS(() => {
      for (let i = 0; i < d.n; i++) {
        const j = i << 2;
        const dx = jit[i];
        T.update(d.ids[i], d.boxes[j] + dx, d.boxes[j + 1] + dx, d.boxes[j + 2] + dx, d.boxes[j + 3] + dx);
      }
      for (let i = 0; i < d.n; i++) {
        const j = i << 2;
        T.update(d.ids[i], d.boxes[j], d.boxes[j + 1], d.boxes[j + 2], d.boxes[j + 3]);
      }
      sink += T.size;
    }, 7);
    const updRbush = measureS(() => {
      for (let i = 0; i < d.n; i++) {
        const it = rItems[i];
        const dx = jit[i];
        R.remove(it);
        it.minX += dx;
        it.minY += dx;
        it.maxX += dx;
        it.maxY += dx;
        R.insert(it);
      }
      for (let i = 0; i < d.n; i++) {
        const it = rItems[i];
        const dx = jit[i];
        R.remove(it);
        it.minX -= dx;
        it.minY -= dx;
        it.maxX -= dx;
        it.maxY -= dx;
        R.insert(it);
      }
      sink += rItems.length;
    }, 7);
    row('update: jitter ALL ±δ', updFlat, updRbush, `(${(2 * d.n) / 1000}k updates)`);

    // ── remove all — fresh tree per round via setup (outside the timed window)
    let T2 = new FlatRTree(16);
    const remFlat = measureS(
      () => {
        for (let i = 0; i < d.n; i++) T2.remove(d.ids[i]);
        sink += T2.size;
      },
      3,
      1,
      () => {
        T2 = new FlatRTree(16);
        T2.load(d.n, d.ids, d.boxes);
      },
    );
    let R2 = new RBush<RItem>(9);
    let r2Items: RItem[] = [];
    const remRbush = measureS(
      () => {
        for (let i = 0; i < d.n; i++) R2.remove(r2Items[i]);
        sink += R2.all().length;
      },
      3,
      1,
      () => {
        R2 = new RBush<RItem>(9);
        r2Items = makeItems(d);
        R2.load(r2Items);
      },
    );
    row('remove ALL one-by-one', remFlat, remRbush, `(${d.n / 1000}k removes)`);
  }

  const st = new FlatRTree(16);
  st.load(d.n, d.ids, d.boxes);
  const s = st.stats();
  const rbKiB = rbushRetainedKiB(d);
  console.log(
    `  memory: FlatRTree ${(s.bytes / 1024).toFixed(0)} KiB in ${s.nodes} nodes (fill ${(s.avgLeafFill * 100).toFixed(0)}%, height ${s.height}), zero GC objects${
      rbKiB !== null
        ? ` | rbush ~${rbKiB.toFixed(0)} KiB retained heap (nodes + its required item objects)`
        : ' | rbush: run with --expose-gc for retained-heap figure'
    }`,
  );
}

function benchChurn(): void {
  console.log('\n■ mixed churn (20k live, 200k ops: 30% ins / 30% upd / 25% rem / 15% query)');
  const OPS = 200000;
  const opRng = mulberry32(4242);
  const opRoll = new Float64Array(OPS);
  for (let i = 0; i < OPS; i++) opRoll[i] = opRng();

  const churnLine = (name: string, s: number[]): void => {
    const p50 = pctl(s, 0.5);
    console.log(`  ${name} p50 ${p50.toFixed(1)} ms (min ${s[0].toFixed(1)}) — ${(((OPS / p50) * 1000) / 1e6).toFixed(2)}M ops/s`);
  };

  let flatSamples: number[];
  {
    let t = new FlatRTree(16);
    let nextId = 0;
    let live: number[] = [];
    let rng: () => number = mulberry32(31337);
    const setup = () => {
      t = new FlatRTree(16);
      nextId = 0;
      live = [];
      rng = mulberry32(31337);
      const seedRng = mulberry32(1);
      for (let i = 0; i < 20000; i++) {
        const b = randBox(seedRng, 50000, 200, 120);
        t.insert(nextId, b[0], b[1], b[2], b[3]);
        live.push(nextId++);
      }
    };
    flatSamples = measureS(
      () => {
        for (let i = 0; i < OPS; i++) {
          const roll = opRoll[i];
          const kind = roll < 0.3 ? 0 : roll < 0.6 ? 1 : roll < 0.85 ? 2 : 3;
          if (kind === 0 || live.length === 0) {
            const b = randBox(rng, 50000, 200, 120);
            t.insert(nextId, b[0], b[1], b[2], b[3]);
            live.push(nextId++);
          } else if (kind === 1) {
            const id = live[(rng() * live.length) | 0];
            const b = randBox(rng, 50000, 200, 120);
            t.update(id, b[0], b[1], b[2], b[3]);
          } else if (kind === 2) {
            const k = (rng() * live.length) | 0;
            const id = live[k];
            live[k] = live[live.length - 1];
            live.pop();
            t.remove(id);
          } else {
            const b = randBox(rng, 50000, 3000, 3000);
            sink += t.query(b[0], b[1], b[2], b[3]);
          }
        }
      },
      3,
      1,
      setup,
    );
    churnLine('FlatRTree:', flatSamples);
  }
  {
    let r = new RBush<RItem>(9);
    let nextId = 0;
    let items = new Map<number, RItem>();
    let live: number[] = [];
    let rng: () => number = mulberry32(31337);
    const setup = () => {
      r = new RBush<RItem>(9);
      nextId = 0;
      items = new Map();
      live = [];
      rng = mulberry32(31337);
      const seedRng = mulberry32(1);
      for (let i = 0; i < 20000; i++) {
        const b = randBox(seedRng, 50000, 200, 120);
        const it: RItem = { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3], id: nextId };
        r.insert(it);
        items.set(nextId, it);
        live.push(nextId++);
      }
    };
    const s = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    const rbushSamples = measureS(
      () => {
        for (let i = 0; i < OPS; i++) {
          const roll = opRoll[i];
          const kind = roll < 0.3 ? 0 : roll < 0.6 ? 1 : roll < 0.85 ? 2 : 3;
          if (kind === 0 || live.length === 0) {
            const b = randBox(rng, 50000, 200, 120);
            const it: RItem = { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3], id: nextId };
            r.insert(it);
            items.set(nextId, it);
            live.push(nextId++);
          } else if (kind === 1) {
            const id = live[(rng() * live.length) | 0];
            const it = items.get(id) as RItem;
            const b = randBox(rng, 50000, 200, 120);
            r.remove(it);
            it.minX = b[0];
            it.minY = b[1];
            it.maxX = b[2];
            it.maxY = b[3];
            r.insert(it);
          } else if (kind === 2) {
            const k = (rng() * live.length) | 0;
            const id = live[k];
            live[k] = live[live.length - 1];
            live.pop();
            r.remove(items.get(id) as RItem);
            items.delete(id);
          } else {
            const b = randBox(rng, 50000, 3000, 3000);
            s.minX = b[0];
            s.minY = b[1];
            s.maxX = b[2];
            s.maxY = b[3];
            sink += r.search(s).length;
          }
        }
      },
      3,
      1,
      setup,
    );
    churnLine('rbush:    ', rbushSamples);
    console.log(`  → ${(pctl(rbushSamples, 0.5) / pctl(flatSamples, 0.5)).toFixed(2)}× faster (p50)`);
  }
}

// ──────────────────────────────────────────────────────────────────── main ──

console.log('FlatRTree self-tests');
const t0 = performance.now();

tEmpty();
tBasicAndDegenerate();
tGuards();
tDuplicateBoxStress();
tAdversarial();
for (const seed of [1, 2, 42]) tRandomInsertSearch(seed, 2500);
for (const seed of [3, 77]) tRemove(seed, 2000);
for (const seed of [5, 1234]) tUpdate(seed, 1500);
for (const seed of [8, 9]) tLoad(seed, 4000);
tRebuildAndClear(11);
for (const seed of [21, 22, 23]) tChurn(seed, 8000);
for (const seed of [31, 32]) tRBushParity(seed, 6000);

// maxEntries variants exercise different stride/split configurations (incl. the 64 cap)
for (const M of [4, 8, 32, 64]) {
  const rng = mulberry32(100 + M);
  const t = new FlatRTree(M);
  const mirror = new Map<number, Box>();
  for (let i = 0; i < 1200; i++) {
    const b = randBox(rng, 1000, 60, 60);
    t.insert(i, b[0], b[1], b[2], b[3]);
    mirror.set(i, b);
  }
  for (let i = 0; i < 1200; i += 3) {
    t.remove(i);
    mirror.delete(i);
  }
  audit(t, `M=${M}`);
  diffQueries(t, mirror, rng, 60, `M=${M}`);
}

const elapsed = performance.now() - t0;
console.log(`\n${checks} checks, ${failures} failures (${elapsed.toFixed(0)} ms)`);
if (failures > 0) process.exit(1);

if (process.argv.includes('--bench')) {
  console.log(
    `\nA/B benchmark: FlatRTree(16) vs rbush@4(9 — its default; avlo production config) — p50 (min) over warmed rounds, ${process.version}`,
  );
  benchDataset(genUniform(10000, 51));
  benchDataset(genUniform(100000, 52));
  benchDataset(genClustered(100000, 53));
  benchDataset(genUniform(1000000, 54), false); // scaling probe: bulk load + search only (per-op rows would be rbush-bound noise)
  benchChurn();
  console.log(`\n(sink=${sink})`);
}
