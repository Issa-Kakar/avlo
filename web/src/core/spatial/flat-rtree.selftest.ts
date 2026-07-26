// biome-ignore-all lint/suspicious/noConsole: standalone test/bench runner — console IS the output surface
/**
 * FlatRTree self-test + A/B benchmark runner.
 *
 * Not part of the app bundle — executed standalone via esbuild+node:
 *   pnpm exec esbuild web/src/core/spatial/flat-rtree.selftest.ts \
 *     --bundle --platform=node --format=esm --outfile=<scratch>/selftest.mjs
 *   node <scratch>/selftest.mjs [--bench]
 *
 * Correctness: differential testing against a brute-force mirror AND against
 * rbush itself, with FlatRTree.validate() (exact-MBR + linkage + pool audit)
 * after every mutation phase. Bench: A/B vs rbush on load / insert / search /
 * update / remove / churn.
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

/** Differential check: FlatRTree vs brute mirror on `qn` random queries. */
function diffQueries(tree: FlatRTree, mirror: Map<number, Box>, rng: () => number, qn: number, ctx: string): void {
  for (let i = 0; i < qn; i++) {
    const q = randBox(rng, 1200, 500, 500);
    const n = tree.query(q[0], q[1], q[2], q[3]);
    const got = sortedIds(tree.results, n);
    const want = bruteQuery(mirror, q);
    check(sameIds(got, want), `${ctx}: query #${i} mismatch (got ${got.length}, want ${want.length})`);
    check(tree.collides(q[0], q[1], q[2], q[3]) === want.length > 0, `${ctx}: collides #${i} mismatch`);
  }
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
  }
  check(t.size === mirror.size, `churn(${seed}): final size`);
  audit(t, `churn(${seed}) final`);
  diffQueries(t, mirror, rng, 100, `churn(${seed}) final`);
}

/** Same op sequence against FlatRTree and rbush; query results must match. */
function tRBushParity(seed: number, ops: number): void {
  const rng = mulberry32(seed);
  const t = new FlatRTree();
  const r = new RBush<RItem>(16);
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

function measure(fn: () => void, rounds: number): number {
  let best = Infinity;
  for (let r = 0; r < rounds; r++) {
    const t0 = performance.now();
    fn();
    const dt = performance.now() - t0;
    if (dt < best) best = dt;
  }
  return best;
}

function row(name: string, flatMs: number, rbushMs: number, unit: string): void {
  const ratio = rbushMs / flatMs;
  console.log(
    `  ${name.padEnd(34)} ${flatMs.toFixed(2).padStart(9)} ms ${rbushMs.toFixed(2).padStart(9)} ms   ${ratio >= 1 ? `${ratio.toFixed(2)}× faster` : `${(1 / ratio).toFixed(2)}× SLOWER`}  ${unit}`,
  );
}

function benchDataset(d: Dataset): void {
  console.log(`\n■ ${d.label}`);
  console.log(`  ${'benchmark'.padEnd(34)} ${'FlatRTree'.padStart(12)} ${'rbush'.padStart(12)}`);

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
  const loadFlat = measure(() => {
    const t = new FlatRTree(16);
    t.load(d.n, d.ids, d.boxes);
    sink += t.size;
  }, 5);
  const itemsForLoad = makeItems(d);
  const loadRbush = measure(() => {
    const r = new RBush<RItem>(16);
    r.load(itemsForLoad);
    sink += r.all().length;
  }, 5);
  row('bulk load', loadFlat, loadRbush, `(${d.n / 1000}k items)`);

  // ── one-by-one insert
  const insFlat = measure(() => {
    const t = new FlatRTree(16);
    for (let i = 0; i < d.n; i++) {
      const j = i << 2;
      t.insert(d.ids[i], d.boxes[j], d.boxes[j + 1], d.boxes[j + 2], d.boxes[j + 3]);
    }
    sink += t.size;
  }, 3);
  const insRbush = measure(() => {
    const r = new RBush<RItem>(16);
    const items = makeItems(d);
    for (let i = 0; i < d.n; i++) r.insert(items[i]);
    sink += r.all().length;
  }, 3);
  row('insert one-by-one', insFlat, insRbush, `(${d.n / 1000}k items)`);

  // steady trees for query/update benches
  const T = new FlatRTree(16);
  T.load(d.n, d.ids, d.boxes);
  const R = new RBush<RItem>(16);
  const rItems = makeItems(d);
  R.load(rItems);

  const searchBench = (label: string, count: number, w: number, h: number) => {
    mkQueries(count, w, h);
    const qs = queries.slice();
    const f = measure(() => {
      for (let i = 0; i < qs.length; i++) {
        const q = qs[i];
        const n = T.query(q[0], q[1], q[2], q[3]);
        sink += n;
      }
    }, 7);
    const rb = measure(() => {
      const s = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
      for (let i = 0; i < qs.length; i++) {
        const q = qs[i];
        s.minX = q[0];
        s.minY = q[1];
        s.maxX = q[2];
        s.maxY = q[3];
        sink += R.search(s).length;
      }
    }, 7);
    row(label, f, rb, `(${count} queries)`);
  };

  searchBench('search: hit-test 10×10', 4000, 10, 10);
  searchBench('search: block 500×500', 2000, 500, 500);
  searchBench('search: viewport 5000×3000', 1000, 5000, 3000);
  searchBench('search: zoom-out 40000×40000', 100, 40000, 40000);

  // ── update: jitter every item (drag-frame pattern)
  const jit = new Float64Array(d.n);
  const jrng = mulberry32(7);
  for (let i = 0; i < d.n; i++) jit[i] = (jrng() - 0.5) * 6;
  let flip = 1;
  const updFlat = measure(() => {
    const s = flip;
    flip = -flip;
    for (let i = 0; i < d.n; i++) {
      const j = i << 2;
      const dx = jit[i] * s;
      T.update(d.ids[i], d.boxes[j] + dx, d.boxes[j + 1] + dx, d.boxes[j + 2] + dx, d.boxes[j + 3] + dx);
    }
    sink += T.size;
  }, 5);
  let rflip = 1;
  const updRbush = measure(() => {
    const s = rflip;
    rflip = -rflip;
    for (let i = 0; i < d.n; i++) {
      const it = rItems[i];
      const dx = jit[i] * s;
      R.remove(it);
      it.minX += dx;
      it.minY += dx;
      it.maxX += dx;
      it.maxY += dx;
      R.insert(it);
    }
    sink += rItems.length;
  }, 5);
  row('update: jitter ALL items', updFlat, updRbush, `(${d.n / 1000}k updates)`);

  // ── remove all (fresh trees so update rounds don't skew structure)
  const T2 = new FlatRTree(16);
  T2.load(d.n, d.ids, d.boxes);
  const remFlat = measure(() => {
    if (T2.size === d.n) {
      for (let i = 0; i < d.n; i++) T2.remove(d.ids[i]);
    }
    sink += T2.size;
  }, 1);
  const R2 = new RBush<RItem>(16);
  const r2Items = makeItems(d);
  R2.load(r2Items);
  const remRbush = measure(() => {
    for (let i = 0; i < d.n; i++) R2.remove(r2Items[i]);
    sink += R2.all().length;
  }, 1);
  row('remove ALL one-by-one', remFlat, remRbush, `(${d.n / 1000}k removes)`);

  const st = new FlatRTree(16);
  st.load(d.n, d.ids, d.boxes);
  const s = st.stats();
  console.log(
    `  memory: FlatRTree ${(s.bytes / 1024).toFixed(0)} KiB in ${s.nodes} nodes (fill ${(s.avgLeafFill * 100).toFixed(0)}%, height ${s.height}) — typed arrays only, zero GC objects`,
  );
}

function benchChurn(): void {
  console.log('\n■ mixed churn (20k live, 200k ops: 30% ins / 30% upd / 25% rem / 15% query)');
  const OPS = 200000;
  const opRng = mulberry32(4242);
  const opRoll = new Float64Array(OPS);
  for (let i = 0; i < OPS; i++) opRoll[i] = opRng();

  const run = (doOp: (kind: number, rng: () => number) => void): number => {
    const rng = mulberry32(31337);
    return measure(() => {
      for (let i = 0; i < OPS; i++) {
        const roll = opRoll[i];
        doOp(roll < 0.3 ? 0 : roll < 0.6 ? 1 : roll < 0.85 ? 2 : 3, rng);
      }
    }, 1);
  };

  {
    const t = new FlatRTree(16);
    let nextId = 0;
    const live: number[] = [];
    const seedRng = mulberry32(1);
    for (let i = 0; i < 20000; i++) {
      const b = randBox(seedRng, 50000, 200, 120);
      t.insert(nextId, b[0], b[1], b[2], b[3]);
      live.push(nextId++);
    }
    const ms = run((kind, rng) => {
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
    });
    console.log(`  FlatRTree: ${ms.toFixed(1)} ms (${(((OPS / ms) * 1000) / 1e6).toFixed(2)}M ops/s)`);
    (globalThis as { __flatChurn?: number }).__flatChurn = ms;
  }
  {
    const r = new RBush<RItem>(16);
    let nextId = 0;
    const items = new Map<number, RItem>();
    const live: number[] = [];
    const seedRng = mulberry32(1);
    for (let i = 0; i < 20000; i++) {
      const b = randBox(seedRng, 50000, 200, 120);
      const it: RItem = { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3], id: nextId };
      r.insert(it);
      items.set(nextId, it);
      live.push(nextId++);
    }
    const s = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    const ms = run((kind, rng) => {
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
    });
    console.log(`  rbush:     ${ms.toFixed(1)} ms (${(((OPS / ms) * 1000) / 1e6).toFixed(2)}M ops/s)`);
    const flat = (globalThis as { __flatChurn?: number }).__flatChurn as number;
    console.log(`  → ${(ms / flat).toFixed(2)}× faster`);
  }
}

// ──────────────────────────────────────────────────────────────────── main ──

console.log('FlatRTree self-tests');
const t0 = performance.now();

tEmpty();
tBasicAndDegenerate();
tDuplicateBoxStress();
for (const seed of [1, 2, 42]) tRandomInsertSearch(seed, 2500);
for (const seed of [3, 77]) tRemove(seed, 2000);
for (const seed of [5, 1234]) tUpdate(seed, 1500);
for (const seed of [8, 9]) tLoad(seed, 4000);
tRebuildAndClear(11);
for (const seed of [21, 22, 23]) tChurn(seed, 8000);
for (const seed of [31, 32]) tRBushParity(seed, 6000);

// maxEntries variants exercise different stride/split configurations
for (const M of [4, 8, 32]) {
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
  console.log('\nA/B benchmark: FlatRTree vs rbush@4 (both maxEntries=16, best-of-N timing)');
  benchDataset(genUniform(10000, 51));
  benchDataset(genUniform(100000, 52));
  benchDataset(genClustered(100000, 53));
  benchChurn();
  console.log(`\n(sink=${sink})`);
}
