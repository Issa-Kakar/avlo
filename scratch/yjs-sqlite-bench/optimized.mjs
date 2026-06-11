// optimized.mjs — the FAIR + maxed-out measurements.
//
//   node --expose-gc --no-warnings optimized.mjs
//
// Fixes the apples-to-oranges critique of run.mjs:
//   • durable writes use synchronous=FULL on real disk → an honest ~fsync-bound commit
//     (NOT the 74µs logical insert). This is the unit R2's durable PUT compares against.
//   • per-edit cost is 0 (in-memory accumulate); durability is amortized over a debounce
//     batch (tiered) — the write ladder shows the collapse.
//   • near-2MB packed segments (merge a batch → one ≤1.9MB row) → few big sequential
//     applyUpdateV2 on load + few billed rows, instead of thousands of tiny rows.
//   • a single updateV2 > 2MB (bulk paste / renormalizeZ) → byte-split across rows,
//     concat-on-read, applied as one update.
//   • compaction encodes the LIVE in-memory doc (the DO already holds it) — no cold
//     reconstruction on the warm path.
//   • compression (gzip) of rows — storage/row-billing efficiency.
//
// Yjs CPU = workerd-accurate. SQLite durable commit = honest LOCAL floor (DO storage
// replicates on top → higher, but same shape). R2 PUT assumed ~60ms remote-durable.

import * as Y from 'yjs';
import { writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  bench, stats, fmtBytes, fmtMs, chunk, reassemble, asBuf, openDurableDb, mdTable, MB,
} from './lib.mjs';
import {
  buildDrawScene, buildChurnScene, buildTypingScene, buildHugePasteScene, streamBytes,
} from './docgen.mjs';

const BASE = import.meta.dirname;
const SEG_TARGET = 1.9 * MB; // pack rows just under the 2MB cell ceiling
const R2_PUT_MS = 60; // assumed remote-durable PUT
const hr = () => process.hrtime.bigint();
const sinceMs = (t0) => Number(hr() - t0) / 1e6;
const sv = (d) => Y.encodeStateVector(d);
const eqBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Greedily merge the update stream into ≤target sealed segments (each one applyable blob). */
function packSegments(updates, target = SEG_TARGET) {
  const segs = [];
  let batch = [];
  let bytes = 0;
  for (const u of updates) {
    batch.push(u);
    bytes += u.length;
    if (bytes >= target) {
      segs.push(Y.mergeUpdatesV2(batch));
      batch = [];
      bytes = 0;
    }
  }
  if (batch.length) segs.push(Y.mergeUpdatesV2(batch));
  return segs;
}

/** Time one durable (fsync'd) COMMIT of a single `payload`-byte row, on real disk. */
function durableCommitMs(payload, iters = 80) {
  const s = openDurableDb(BASE);
  s.db.exec('CREATE TABLE t (k INTEGER PRIMARY KEY, b BLOB)');
  const ins = s.db.prepare('INSERT INTO t (k, b) VALUES (?, ?)');
  const blob = Buffer.alloc(payload);
  for (let i = 0; i < 8; i++) {
    s.db.exec('BEGIN');
    ins.run(i, blob);
    s.db.exec('COMMIT');
  }
  const samp = new Float64Array(iters);
  for (let i = 0; i < iters; i++) {
    const t0 = hr();
    s.db.exec('BEGIN');
    ins.run(1000 + i, blob);
    s.db.exec('COMMIT');
    samp[i] = sinceMs(t0);
  }
  s.close();
  return stats(samp);
}

/** Actually execute `nCommits` durable commits, each writing one `payload`-byte row. */
function runDurable(nCommits, payload) {
  const s = openDurableDb(BASE);
  s.db.exec('CREATE TABLE t (k INTEGER PRIMARY KEY, b BLOB)');
  const ins = s.db.prepare('INSERT INTO t (k, b) VALUES (?, ?)');
  const blob = Buffer.alloc(payload);
  const t0 = hr();
  for (let i = 0; i < nCommits; i++) {
    s.db.exec('BEGIN');
    ins.run(i, blob);
    s.db.exec('COMMIT');
  }
  const ms = sinceMs(t0);
  s.close();
  return ms;
}

const out = [];
const log = (s = '') => {
  out.push(s);
  console.log(s);
};

log('building scenes…');
const scenes = {
  medium: buildDrawScene({ count: 2500, seed: 21, pointsAvg: 120 }),
  large: buildDrawScene({ count: 9000, seed: 31, pointsAvg: 140 }),
  churn: buildChurnScene({ count: 2000, ops: 8000, seed: 41, deleteProb: 0.1, keepFloor: 0.6 }),
  typing: buildTypingScene({ chars: 6000, seed: 51 }),
};
const heads = {};
for (const [k, s] of Object.entries(scenes)) heads[k] = Y.encodeStateAsUpdateV2(s.doc);

log('\n# Optimized / fair measurements\n');
log(`Node ${process.version} · real ext4 disk · durable = synchronous=FULL (fsync per commit)\n`);

// ── 1. Durable-commit floor ───────────────────────────────────────────────────
log('## 1. Durable commit floor (honest write unit — fsync-bound)\n');
const commitRows = [['1 KB', 1024], ['64 KB', 64 * 1024], ['512 KB', 512 * 1024], ['1.9 MB', Math.round(SEG_TARGET)]].map(
  ([label, b]) => {
    const st = durableCommitMs(b);
    return [label, `${fmtMs(st.p50)} (p90 ${fmtMs(st.p90)})`];
  },
);
log(mdTable(['payload / durable COMMIT', 'time'], commitRows));
const UNIT = durableCommitMs(2048).p50; // ~ one small-update commit
log(`\n→ a durable commit is ~fsync-bound (~${fmtMs(UNIT)}), nearly flat until the payload is large.\n`);

// ── 2. Write-durability ladder (tiered debounce + packing) ────────────────────
log('## 2. Write ladder — N edits → durability (per-edit cost is 0; you pay per COMMIT)\n');
for (const key of ['medium', 'typing']) {
  const { updates } = scenes[key];
  const N = updates.length;
  const segs = packSegments(updates);
  const naiveModel = N * UNIT; // executing this for real ≈ this wall-clock — that's the point
  const rows = [
    ['naïve: durable commit per edit', `${N} commits`, `${N} rows`, `~${fmtMs(naiveModel)} (modeled = N×unit)`],
  ];
  for (const B of [16, 64, 256]) {
    const nc = Math.ceil(N / B);
    // each tick commits one merged batch blob
    const s = openDurableDb(BASE);
    s.db.exec('CREATE TABLE tail (seq INTEGER PRIMARY KEY, b BLOB)');
    const ins = s.db.prepare('INSERT INTO tail (seq, b) VALUES (?, ?)');
    const t0 = hr();
    let seq = 0;
    for (let i = 0; i < N; i += B) {
      const merged = Y.mergeUpdatesV2(updates.slice(i, i + B));
      s.db.exec('BEGIN');
      ins.run(seq++, asBuf(merged));
      s.db.exec('COMMIT');
    }
    const ms = sinceMs(t0);
    s.close();
    rows.push([`debounce batch=${B}`, `${nc} commits`, `${nc} rows`, `${fmtMs(ms)} (${fmtMs(ms / N)}/edit)`]);
  }
  const segMs = runDurable(segs.length, Math.round(SEG_TARGET));
  rows.push([`packed ~1.9MB segments`, `${segs.length} commits`, `${segs.length} rows`, `${fmtMs(segMs)}`]);
  log(`\n**${key}** — ${N} edits, head ${fmtBytes(heads[key].length)}`);
  log(mdTable(['strategy', 'commits', 'rows written', 'total durable time'], rows));
}
log('\n→ durability cost ∝ COMMIT count, not edit count. Batching/packing collapses it; per-edit work is 0 (in-RAM).\n');

// ── 3. SAVE per debounce tick (fair: both durable) ────────────────────────────
log('## 3. SAVE per debounce tick — R2 re-encodes the whole doc; SQLite commits the delta\n');
{
  const rows = [];
  for (const key of ['medium', 'large', 'churn']) {
    const { updates, doc } = scenes[key];
    const B = 64; // edits since last tick
    const batch = updates.slice(-B);
    const delta = Y.mergeUpdatesV2(batch);
    const encode = bench(() => Y.encodeStateAsUpdateV2(doc).length, { iters: key === 'large' ? 8 : 20 });
    const r2 = encode.p50 + R2_PUT_MS;
    const sqlite = bench(() => Y.mergeUpdatesV2(batch).length, { iters: 30 }).p50 + UNIT;
    rows.push([
      key,
      fmtBytes(heads[key].length),
      `${fmtMs(encode.p50)} enc + ~${R2_PUT_MS}ms PUT = **${fmtMs(r2)}**, ${fmtBytes(heads[key].length)} remote`,
      `merge + 1 commit = **${fmtMs(sqlite)}**, ${fmtBytes(delta.length)} local`,
    ]);
  }
  log(mdTable(['scene', 'doc', 'R2 per tick (whole doc, remote-durable)', 'SQLite per tick (delta, local-durable)'], rows));
  log('\n→ same cadence, both durable — but R2 re-encodes + ships the entire doc every tick; SQLite commits the delta.\n');
}

// ── 4. Packed-segment LOAD vs tiny-row replay (worst-case wake, stale checkpoint) ─
log('## 4. Cold-load with a STALE checkpoint — packed segments vs tiny rows\n');
{
  const rows = [];
  for (const key of ['medium', 'large', 'churn']) {
    const { updates, doc } = scenes[key];
    const N = updates.length;
    const C = Math.floor(N / 2); // checkpoint covers first half; delta = second half
    const base = new Y.Doc();
    for (let i = 0; i < C; i++) Y.applyUpdateV2(base, updates[i]);
    const checkpoint = Y.encodeStateAsUpdateV2(base);
    const ckptParts = chunk(checkpoint);
    const deltaUpdates = updates.slice(C);
    const segs = packSegments(deltaUpdates);

    const it = key === 'large' ? 8 : 20;
    // packed load: apply checkpoint chunks (reassembled) + apply each segment
    const packed = bench(
      (d) => {
        Y.applyUpdateV2(d, reassemble(ckptParts));
        for (const sgmt of segs) Y.applyUpdateV2(d, sgmt);
      },
      { setup: () => new Y.Doc(), iters: it },
    );
    // tiny-row replay: apply checkpoint + every delta update individually
    const tiny = bench(
      (d) => {
        Y.applyUpdateV2(d, checkpoint);
        for (const u of deltaUpdates) Y.applyUpdateV2(d, u);
      },
      { setup: () => new Y.Doc(), iters: it },
    );
    // correctness
    const chk = new Y.Doc();
    Y.applyUpdateV2(chk, reassemble(ckptParts));
    for (const sgmt of segs) Y.applyUpdateV2(chk, sgmt);
    if (!eqBytes(sv(chk), sv(doc))) throw new Error(`packed load mismatch (${key})`);

    rows.push([
      key,
      `${fmtMs(packed.p50)} · ${ckptParts.length + segs.length} rows`,
      `${fmtMs(tiny.p50)} · ${ckptParts.length + deltaUpdates.length} rows`,
      `${deltaUpdates.length} → ${segs.length} segs`,
    ]);
  }
  log(mdTable(['scene', 'packed segments (rows read)', 'tiny-row replay (rows read)', 'delta updates → segs'], rows));
  log('\n→ packing turns a many-tiny-apply replay into a few big sequential applies + a handful of billed row reads.\n');
}

// ── 5. Single update > 2MB (bulk paste / renormalizeZ) ────────────────────────
log('## 5. A single updateV2 > 2MB — byte-split, concat-on-read, apply as one\n');
{
  const { doc, update } = buildHugePasteScene({ count: 20000, seed: 9, pointsAvg: 120 });
  const parts = chunk(update); // byte-level split ≤2MB
  const s = openDurableDb(BASE);
  s.db.exec('CREATE TABLE blob (id INTEGER, part INTEGER, b BLOB, PRIMARY KEY (id, part))');
  const ins = s.db.prepare('INSERT INTO blob (id, part, b) VALUES (?, ?, ?)');
  const splitMs = (() => {
    const t0 = hr();
    chunk(update);
    return sinceMs(t0);
  })();
  const storeMs = (() => {
    const t0 = hr();
    s.db.exec('BEGIN'); // all parts in ONE durable commit
    for (let i = 0; i < parts.length; i++) ins.run(0, i, asBuf(parts[i]));
    s.db.exec('COMMIT');
    return sinceMs(t0);
  })();
  const sel = s.db.prepare('SELECT b FROM blob WHERE id = 0 ORDER BY part');
  const readMs = (() => {
    const t0 = hr();
    reassemble(sel.all().map((r) => r.b));
    return sinceMs(t0);
  })();
  const blob = reassemble(sel.all().map((r) => r.b));
  const applyMs = bench((d) => Y.applyUpdateV2(d, blob), { setup: () => new Y.Doc(), iters: 10 }).p50;
  const ok = (() => {
    const d = new Y.Doc();
    Y.applyUpdateV2(d, blob);
    return eqBytes(sv(d), sv(doc));
  })();
  s.close();
  log(
    `single update **${fmtBytes(update.length)}** (20k objects, one transaction) → ${parts.length} parts @≤2MB`,
  );
  log(
    mdTable(
      ['byte-split', 'store (1 durable commit, all parts)', 'read + concat', 'applyUpdateV2', 'reconstruct ok'],
      [[fmtMs(splitMs), fmtMs(storeMs), fmtMs(readMs), fmtMs(applyMs), ok ? '✓' : '✗']],
    ),
  );
  log('\n→ >2MB is a non-issue: the store is byte-addressed; split/concat is memcpy, applied as one update.\n');
}

// ── 6. Compaction from the LIVE doc (warm) vs cold reconstruct ────────────────
log('## 6. Compaction cost — encode the live in-memory doc (DO already holds it)\n');
{
  const rows = [];
  for (const key of ['medium', 'large', 'churn']) {
    const { doc, updates } = scenes[key];
    const it = key === 'large' ? 8 : 20;
    const warm = bench(() => Y.encodeStateAsUpdateV2(doc).length, { iters: it });
    const cold = bench(
      (d) => {
        for (const u of updates) Y.applyUpdateV2(d, u);
        Y.encodeStateAsUpdateV2(d);
      },
      { setup: () => new Y.Doc(), iters: it },
    );
    rows.push([key, `${fmtMs(warm.p50)}`, `${fmtMs(cold.p50)}`, `${(cold.p50 / warm.p50).toFixed(0)}×`]);
  }
  log(mdTable(['scene', 'warm compaction (encode live doc)', 'cold reconstruct + encode', 'cold/warm'], rows));
  log('\n→ a warm DO compacts by encoding the doc it already has in RAM — reconstruction only happens on a cold wake.\n');
}

// ── 7. Compression (row / storage efficiency) ─────────────────────────────────
log('## 7. gzip the checkpoint — fewer bytes per row, less DO storage billed\n');
{
  const rows = [];
  for (const key of ['medium', 'large', 'churn']) {
    const head = heads[key];
    const gz = (() => {
      const t0 = hr();
      const z = gzipSync(head, { level: 6 });
      return { z, ms: sinceMs(t0) };
    })();
    const unz = (() => {
      const t0 = hr();
      gunzipSync(gz.z);
      return sinceMs(t0);
    })();
    rows.push([
      key,
      fmtBytes(head.length),
      `${fmtBytes(gz.z.length)} (${(head.length / gz.z.length).toFixed(2)}×)`,
      `${fmtMs(gz.ms)} / ${fmtMs(unz)}`,
      `${Math.ceil(head.length / (2 * MB))} → ${Math.ceil(gz.z.length / (2 * MB))} rows`,
    ]);
  }
  log(mdTable(['scene', 'V2 head', 'gzip', 'gzip / gunzip', 'chunks @2MB'], rows));
  log('\n→ optional: trade a few ms of CPU for ~2× smaller rows (less storage billed, fewer chunks).\n');
}

writeFileSync(new URL('./RESULTS-OPTIMIZED.md', import.meta.url), out.join('\n'));
console.log('\n✓ wrote RESULTS-OPTIMIZED.md');
