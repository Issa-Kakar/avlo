// run.mjs — orchestrate the overhead measurements and emit RESULTS.md.
//
//   node --expose-gc --no-warnings run.mjs            (or: npm run bench)
//
// Compares two DO persistence strategies for a Yjs whiteboard:
//   R2     : save = encodeStateAsUpdateV2 → 1 blob PUT ; load = 1 GET → applyUpdateV2
//   SQLite : save = append per-tx updateV2 row (≤2MB, chunked) ; load = read rows →
//            replay / mergeUpdatesV2 ; + periodic compaction + VACUUM
//
// Yjs ops run in V8 (identical cost in workerd). node:sqlite is a LOCAL-ENGINE FLOOR
// for the SQLite ops — DO SQLite adds durability/write-amplification on top. R2 GET/PUT
// is network latency, cited not measured.

import * as Y from 'yjs';
import { writeFileSync, readFileSync } from 'node:fs';
import {
  bench, stats, fmtBytes, fmtMs, chunk, reassemble, asBuf, openTempDb, mdTable, MB, CELL_LIMIT,
} from './lib.mjs';
import {
  buildDrawScene, buildChurnScene, buildTypingScene, streamBytes, structCount,
} from './docgen.mjs';

// Typical Cloudflare R2 same-region latencies (public guidance / community measurements),
// used only to annotate the network hop the SQLite path removes. Not measured here.
const R2_GET_MS = 35;
const R2_PUT_MS = 60;

const sv = (doc) => Y.encodeStateVector(doc);
const eqBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// iteration budget shrinks as the doc grows (keeps wall-clock sane)
const itersFor = (bytes) => (bytes > 6 * MB ? 8 : bytes > 1.5 * MB ? 15 : 30);

function validate(doc, snapV2, updates, mergedV2) {
  const want = sv(doc);
  const d1 = new Y.Doc();
  Y.applyUpdateV2(d1, snapV2);
  const d2 = new Y.Doc();
  for (const u of updates) Y.applyUpdateV2(d2, u);
  const d3 = new Y.Doc();
  Y.applyUpdateV2(d3, mergedV2);
  const ok = eqBytes(want, sv(d1)) && eqBytes(want, sv(d2)) && eqBytes(want, sv(d3));
  if (!ok) throw new Error('reconstruction mismatch — a load path does not reproduce the doc');
  return ok;
}

function measureYjs(name, scene, { recent = 25 } = {}) {
  const { doc, updates } = scene;
  const snapV2 = Y.encodeStateAsUpdateV2(doc); // GC'd canonical head (what R2 stores)
  const snapV1 = Y.encodeStateAsUpdate(doc);
  const mergedV2 = Y.mergeUpdatesV2(updates); // compaction-by-merge (keeps tombstones)
  validate(doc, snapV2, updates, mergedV2);

  // checkpoint model: snapshot of state up to N-recent, then `recent` live updates since
  const split = Math.max(1, updates.length - recent);
  const head = new Y.Doc();
  for (let i = 0; i < split; i++) Y.applyUpdateV2(head, updates[i]);
  const checkpoint = Y.encodeStateAsUpdateV2(head);
  const recentUpdates = updates.slice(split);

  const it = itersFor(snapV2.length);
  const chunks = chunk(snapV2);

  const t = {
    encodeV2: bench(() => Y.encodeStateAsUpdateV2(doc).length, { iters: it }),
    applySnapV2: bench((d) => Y.applyUpdateV2(d, snapV2), { setup: () => new Y.Doc(), iters: it }),
    applyAllV2: bench(
      (d) => {
        for (const u of updates) Y.applyUpdateV2(d, u);
      },
      { setup: () => new Y.Doc(), iters: it },
    ),
    mergeV2: bench(() => Y.mergeUpdatesV2(updates).length, { iters: it }),
    applyMergedV2: bench((d) => Y.applyUpdateV2(d, mergedV2), { setup: () => new Y.Doc(), iters: it }),
    checkpointLoad: bench(
      (d) => {
        Y.applyUpdateV2(d, checkpoint);
        for (const u of recentUpdates) Y.applyUpdateV2(d, u);
      },
      { setup: () => new Y.Doc(), iters: it },
    ),
    chunkSplit: bench(() => chunk(snapV2).length, { iters: it }),
    reassemble: bench(() => reassemble(chunks).length, { iters: it }),
  };

  return {
    name,
    objects: scene.doc.getMap('objects').size,
    structs: structCount(doc),
    updateCount: updates.length,
    sizes: {
      snapV2: snapV2.length,
      snapV1: snapV1.length,
      streamSum: streamBytes(updates),
      mergedV2: mergedV2.length,
      checkpoint: checkpoint.length,
      recentBytes: streamBytes(recentUpdates),
      chunks: chunks.length,
    },
    recent: recentUpdates.length,
    t,
    _bytes: { snapV2, mergedV2, updates, chunks },
  };
}

// --- SQLite stage timings (node:sqlite local floor) ----------------------------
function measureSqlite(updates, snapV2) {
  const store = openTempDb();
  const { db } = store;
  db.exec('CREATE TABLE log (seq INTEGER PRIMARY KEY, data BLOB) WITHOUT ROWID');
  db.exec('CREATE TABLE snap (idx INTEGER PRIMARY KEY, data BLOB) WITHOUT ROWID');
  const insLog = db.prepare('INSERT INTO log (seq, data) VALUES (?, ?)');
  const insSnap = db.prepare('INSERT INTO snap (idx, data) VALUES (?, ?)');
  const selLog = db.prepare('SELECT data FROM log ORDER BY seq');
  const selSnap = db.prepare('SELECT data FROM snap ORDER BY idx');
  const snapChunks = chunk(snapV2);

  const insertAllLog = () => {
    db.exec('BEGIN');
    for (let i = 0; i < updates.length; i++) insLog.run(i, asBuf(updates[i]));
    db.exec('COMMIT');
  };
  const insertSnap = () => {
    db.exec('BEGIN');
    for (let i = 0; i < snapChunks.length; i++) insSnap.run(i, asBuf(snapChunks[i]));
    db.exec('COMMIT');
  };

  const it = itersFor(snapV2.length);
  const t = {
    // append the WHOLE log (worst case write burst). Per-edit append ≈ this / updateCount.
    insertLog: bench(insertAllLog, { setup: () => db.exec('DELETE FROM log'), iters: it }),
    // append a single recent update (the steady-state per-edit save). Monotonic key
    // (far above the log range) so repeated inserts never collide on the PK.
    insertOne: (() => {
      let k = 1e9;
      const last = updates[updates.length - 1];
      return bench(() => insLog.run(k++, asBuf(last)), { iters: Math.max(it, 50) });
    })(),
    insertSnapChunked: bench(insertSnap, { setup: () => db.exec('DELETE FROM snap'), iters: it }),
    readLog: bench(() => {
      const rows = selLog.all();
      let n = 0;
      for (const r of rows) n += r.data.length;
      return n;
    }, { setup: () => {}, iters: it }),
    readSnapChunked: bench(() => {
      const rows = selSnap.all();
      return reassemble(rows.map((r) => r.data)).length;
    }, { iters: it }),
  };

  // --- storage growth: fresh DBs so whole-db page count isolates each table -----
  const growLog = openTempDb();
  growLog.db.exec('CREATE TABLE log (seq INTEGER PRIMARY KEY, data BLOB) WITHOUT ROWID');
  const gi = growLog.db.prepare('INSERT INTO log (seq, data) VALUES (?, ?)');
  growLog.db.exec('BEGIN');
  for (let i = 0; i < updates.length; i++) gi.run(i, asBuf(updates[i]));
  growLog.db.exec('COMMIT');
  growLog.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const logStoreBytes = growLog.pageBytes();

  const growSnap = openTempDb();
  growSnap.db.exec('CREATE TABLE snap (idx INTEGER PRIMARY KEY, data BLOB) WITHOUT ROWID');
  const gs = growSnap.db.prepare('INSERT INTO snap (idx, data) VALUES (?, ?)');
  growSnap.db.exec('BEGIN');
  for (let i = 0; i < snapChunks.length; i++) gs.run(i, asBuf(snapChunks[i]));
  growSnap.db.exec('COMMIT');
  growSnap.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const snapStoreBytes = growSnap.pageBytes();

  // --- VACUUM: simulate compaction deleting ~70% of an accumulated log ----------
  const vac = openTempDb();
  vac.db.exec('CREATE TABLE log (seq INTEGER PRIMARY KEY, data BLOB) WITHOUT ROWID');
  const vi = vac.db.prepare('INSERT INTO log (seq, data) VALUES (?, ?)');
  // accumulate ~4x the log to model many edits between compactions
  vac.db.exec('BEGIN');
  let seq = 0;
  for (let rep = 0; rep < 4; rep++) for (let i = 0; i < updates.length; i++) vi.run(seq++, asBuf(updates[i]));
  vac.db.exec('COMMIT');
  vac.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const beforeDelete = vac.pageBytes();
  vac.db.exec(`DELETE FROM log WHERE seq < ${Math.floor(seq * 0.7)}`); // compaction removes old rows
  vac.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const beforeVacuum = vac.pageBytes();
  const vt0 = process.hrtime.bigint();
  vac.db.exec('VACUUM');
  const vt1 = process.hrtime.bigint();
  vac.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const afterVacuum = vac.pageBytes();
  const vacuumMs = Number(vt1 - vt0) / 1e6;

  store.close();
  growLog.close();
  growSnap.close();
  vac.close();

  return {
    t,
    snapChunks: snapChunks.length,
    logStoreBytes,
    snapStoreBytes,
    vacuum: { beforeDelete, beforeVacuum, afterVacuum, vacuumMs },
  };
}

// --- reporting -----------------------------------------------------------------
const row = (s) => `${fmtMs(s.p50)} (p90 ${fmtMs(s.p90)})`;

function sceneReport(y, s) {
  const out = [];
  out.push(`\n### ${y.name}`);
  out.push(
    `objects **${y.objects.toLocaleString()}**, structs ${y.structs.toLocaleString()}, updates ${y.updateCount.toLocaleString()}`,
  );

  out.push('\n**Sizes**');
  out.push(
    mdTable(
      ['encodeV2 (R2 head)', 'encodeV1', 'Σ update stream', 'mergeUpdatesV2', `checkpoint (−${y.recent})`, 'chunks @2MB'],
      [[
        fmtBytes(y.sizes.snapV2),
        fmtBytes(y.sizes.snapV1),
        `${fmtBytes(y.sizes.streamSum)} (${(y.sizes.streamSum / y.sizes.snapV2).toFixed(2)}×)`,
        `${fmtBytes(y.sizes.mergedV2)} (${(y.sizes.mergedV2 / y.sizes.snapV2).toFixed(2)}×)`,
        fmtBytes(y.sizes.checkpoint),
        String(y.sizes.chunks),
      ]],
    ),
  );

  out.push('\n**Yjs CPU (V8 — transfers to workerd)**');
  out.push(
    mdTable(
      ['encodeV2', 'apply 1 snapshot', 'replay all N', 'mergeUpdatesV2', 'apply merged', `checkpoint+${y.recent}`, 'chunk split', 'reassemble'],
      [[
        row(y.t.encodeV2), row(y.t.applySnapV2), row(y.t.applyAllV2), row(y.t.mergeV2),
        row(y.t.applyMergedV2), row(y.t.checkpointLoad), row(y.t.chunkSplit), row(y.t.reassemble),
      ]],
    ),
  );

  out.push('\n**SQLite stages (node:sqlite — local floor, not DO)**');
  out.push(
    mdTable(
      ['insert full log', 'insert 1 update', 'insert snap (chunked)', 'read full log', 'read snap (chunked)', 'VACUUM'],
      [[
        row(s.t.insertLog), row(s.t.insertOne), row(s.t.insertSnapChunked), row(s.t.readLog),
        row(s.t.readSnapChunked), fmtMs(s.vacuum.vacuumMs),
      ]],
    ),
  );

  // head-to-head derived numbers
  const r2Load = y.t.applySnapV2.p50;
  const sqliteReplay = s.t.readLog.p50 + y.t.applyAllV2.p50;
  const sqliteMerge = s.t.readLog.p50 + y.t.mergeV2.p50 + y.t.applyMergedV2.p50;
  const sqliteCkpt = s.t.readSnapChunked.p50 + y.t.checkpointLoad.p50;
  out.push('\n**LOAD (cold start), CPU only — R2 also pays a network GET**');
  out.push(
    mdTable(
      ['path', 'CPU', 'network', 'total est.'],
      [
        ['R2: GET + applyV2', fmtMs(r2Load), `~${R2_GET_MS} ms GET`, `~${fmtMs(r2Load + R2_GET_MS)}`],
        ['SQLite replay-all', fmtMs(sqliteReplay), '0', fmtMs(sqliteReplay)],
        ['SQLite merge+apply', fmtMs(sqliteMerge), '0', fmtMs(sqliteMerge)],
        ['SQLite checkpoint+recent', fmtMs(sqliteCkpt), '0', `**${fmtMs(sqliteCkpt)}**`],
      ],
    ),
  );

  const r2Save = y.t.encodeV2.p50;
  out.push('\n**SAVE — R2 rewrites the whole doc every debounce; SQLite appends the delta**');
  out.push(
    mdTable(
      ['path', 'CPU', 'bytes written', 'network'],
      [
        ['R2: encodeV2 + PUT', fmtMs(r2Save), fmtBytes(y.sizes.snapV2), `~${R2_PUT_MS} ms PUT`],
        ['SQLite append 1 update', fmtMs(s.t.insertOne.p50), fmtBytes(Math.round(y.sizes.streamSum / Math.max(1, y.updateCount))), '0'],
      ],
    ),
  );

  out.push('\n**Storage growth & compaction**');
  out.push(
    mdTable(
      ['log table (Σ updates)', 'snapshot table', 'log/snap ratio', 'VACUUM reclaim (4× log, −70%)'],
      [[
        fmtBytes(s.logStoreBytes),
        fmtBytes(s.snapStoreBytes),
        `${(s.logStoreBytes / s.snapStoreBytes).toFixed(2)}×`,
        `${fmtBytes(s.vacuum.beforeVacuum)} → ${fmtBytes(s.vacuum.afterVacuum)} in ${fmtMs(s.vacuum.vacuumMs)}`,
      ]],
    ),
  );
  return out.join('\n');
}

// --- main ----------------------------------------------------------------------
console.log('building scenes + measuring (this takes ~1–2 min)…\n');

const scenes = [
  ['DRAW small', () => buildDrawScene({ count: 400, seed: 11, pointsAvg: 90 }), { recent: 25 }],
  ['DRAW medium', () => buildDrawScene({ count: 2500, seed: 21, pointsAvg: 120 }), { recent: 25 }],
  ['DRAW large', () => buildDrawScene({ count: 9000, seed: 31, pointsAvg: 140 }), { recent: 25 }],
  ['CHURN (move/restyle + some deletes)', () => buildChurnScene({ count: 2000, ops: 8000, seed: 41, deleteProb: 0.1, keepFloor: 0.6 }), { recent: 50 }],
  ['TYPING (fine-grained)', () => buildTypingScene({ chars: 6000, seed: 51 }), { recent: 50 }],
];

const reports = [];
for (const [name, build, opts] of scenes) {
  process.stdout.write(`  • ${name} … `);
  const scene = build();
  const y = measureYjs(name, scene, opts);
  const s = measureSqlite(y._bytes.updates, y._bytes.snapV2);
  reports.push(sceneReport(y, s));
  console.log(
    `done  (head ${fmtBytes(y.sizes.snapV2)}, replay ${fmtMs(y.t.applyAllV2.p50)} vs apply-1 ${fmtMs(y.t.applySnapV2.p50)})`,
  );
}

const yjsVersion = JSON.parse(
  readFileSync(new URL('./node_modules/yjs/package.json', import.meta.url), 'utf8'),
).version;

const header = `# Yjs V2 + SQLite-update-log vs R2-snapshot — overhead scratch

Generated ${new Date().toISOString()} · Node ${process.version} · yjs ${yjsVersion}

**Read me first.** Yjs encode/apply/merge run in V8, so these CPU numbers transfer
directly to a Cloudflare Worker/DO (workerd). The SQLite numbers come from Node's
built-in \`node:sqlite\` and are a **local-engine floor**: real DO SQLite adds
durability + write-amplification per write, so treat insert/VACUUM as *lower bounds*.
R2 GET/PUT is a network hop (assumed ~${R2_GET_MS}/${R2_PUT_MS} ms here) that the
SQLite path removes entirely — that, not CPU, is usually the real win.

2MB cell limit ⇒ a compacted snapshot is chunked across rows; the update-log rows are
naturally small. \`mergeUpdatesV2\` keeps tombstones (no GC) while \`encodeStateAsUpdateV2\`
GCs — see how the merge/snapshot sizes diverge in the CHURN scene.
`;

const md = header + reports.join('\n\n---\n');
writeFileSync(new URL('./RESULTS.md', import.meta.url), md);
console.log('\n✓ wrote RESULTS.md');
