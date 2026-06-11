// do-bench/src/worker.mjs — a SQLite-backed Durable Object that runs the persistence
// scheme inside REAL workerd. Timed from the node runner via fetch round-trips (workerd
// freezes internal timers during sync execution, so we measure wall-clock from outside;
// the DO output-gate makes the fetch wait until writes are durable).
//
// What this uniquely verifies vs node:sqlite:
//   • the real 2MB cell limit (and that byte-chunking satisfies it)
//   • the tiered checkpoint+segment+tail scheme reconstructs correctly in the real runtime
//   • DO-SQLite insert/read throughput (to validate node:sqlite as a proxy)
// Durability here is local miniflare disk — production DO replicates on top.

import { DurableObject } from 'cloudflare:workers';
import * as Y from 'yjs';

const SEG = Math.round(1.9 * 1024 * 1024); // pack just under the 2MB cell ceiling
const TAIL = 25;

// Uint8Array → ArrayBuffer for a BLOB bind (slice when it's a view into a larger buffer).
const ab = (u8) =>
  u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.slice().buffer;

function chunkBytes(u8, size = SEG) {
  const out = [];
  for (let i = 0; i < u8.length; i += size) out.push(u8.subarray(i, Math.min(i + size, u8.length)));
  return out;
}
function reassemble(chunks) {
  let t = 0;
  for (const c of chunks) t += c.length;
  const o = new Uint8Array(t);
  let off = 0;
  for (const c of chunks) {
    o.set(c, off);
    off += c.length;
  }
  return o;
}
function packSegments(updates, target = SEG) {
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
const eqBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// compact avlo-shaped scene: strokes + shapes, one update per object-create transaction
function buildScene(count, seed, pointsAvg = 120) {
  const doc = new Y.Doc();
  const updates = [];
  doc.on('updateV2', (u) => updates.push(u));
  const objects = doc.getMap('objects');
  const rnd = mulberry32(seed);
  for (let i = 0; i < count; i++) {
    const r = rnd();
    const oid = 'o' + i.toString(36) + '_' + ((rnd() * 1e6) | 0).toString(36);
    doc.transact(() => {
      const m = new Y.Map();
      objects.set(oid, m);
      m.set('id', oid);
      m.set('z', 'a' + i.toString(36).padStart(5, '0'));
      m.set('ownerId', 'u' + ((rnd() * 1e6) | 0).toString(36));
      m.set('createdAt', 1700000000000 + i);
      if (r < 0.75) {
        m.set('kind', 'stroke');
        m.set('tool', 'pen');
        m.set('color', '#1971c2');
        m.set('width', 2 + ((rnd() * 4) | 0));
        m.set('opacity', 1);
        const n = Math.max(6, Math.round(pointsAvg * (0.3 + rnd() * 1.6)));
        const pts = new Array(n);
        let x = rnd() * 2000;
        let y = rnd() * 2000;
        for (let j = 0; j < n; j++) {
          x += (rnd() - 0.5) * 24;
          y += (rnd() - 0.5) * 24;
          pts[j] = [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
        }
        m.set('points', pts);
      } else {
        m.set('kind', 'shape');
        m.set('shapeType', 'rect');
        m.set('color', '#e03131');
        m.set('width', 2);
        m.set('opacity', 1);
        m.set('fillColor', '#ffd43b');
        m.set('frame', [rnd() * 3000, rnd() * 3000, 80 + rnd() * 400, 60 + rnd() * 300]);
      }
    });
  }
  return { doc, updates };
}

export class BenchDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }
  json(o) {
    return new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
  }
  async fetch(req) {
    const url = new URL(req.url);
    const q = url.searchParams;
    try {
      switch (url.pathname) {
        case '/ping':
          return this.json({ ok: true });
        case '/cell-limit':
          return this.json(this.cellLimit());
        case '/reset-t':
          this.sql.exec('DROP TABLE IF EXISTS t');
          this.sql.exec('CREATE TABLE t (b BLOB)');
          return this.json({ ok: true });
        case '/insert':
          return this.json(this.insert(+q.get('rows'), +q.get('size')));
        case '/insert-one':
          this.sql.exec('INSERT INTO t (b) VALUES (?)', ab(new Uint8Array(+q.get('size') || 2048)));
          return this.json({ ok: true });
        case '/read':
          return this.json(this.readAll());
        case '/persist':
          return this.json(this.persist(+q.get('count') || 2500, +q.get('seed') || 21));
        case '/reload':
          return this.json(this.reload());
        default:
          return new Response('not found', { status: 404 });
      }
    } catch (e) {
      return this.json({ error: String(e && e.message ? e.message : e) });
    }
  }

  // Probe the real cell limit: single-cell writes at increasing sizes, then chunked.
  cellLimit() {
    const res = {};
    this.sql.exec('DROP TABLE IF EXISTS cl');
    this.sql.exec('CREATE TABLE cl (k INTEGER PRIMARY KEY, b BLOB)');
    for (const mb of [1, 1.9, 2.1, 3]) {
      try {
        this.sql.exec('INSERT OR REPLACE INTO cl (k, b) VALUES (?, ?)', 0, ab(new Uint8Array(Math.round(mb * 1024 * 1024))));
        res[mb + 'MB single cell'] = 'ok';
      } catch (e) {
        res[mb + 'MB single cell'] = 'REJECTED: ' + String(e.message || e).slice(0, 70);
      }
    }
    try {
      this.sql.exec('DROP TABLE IF EXISTS clc');
      this.sql.exec('CREATE TABLE clc (part INTEGER PRIMARY KEY, b BLOB)');
      const cs = chunkBytes(new Uint8Array(5 * 1024 * 1024));
      for (let i = 0; i < cs.length; i++) this.sql.exec('INSERT INTO clc (part, b) VALUES (?, ?)', i, ab(cs[i]));
      const back = this.sql.exec('SELECT b FROM clc ORDER BY part').toArray();
      const total = back.reduce((s, r) => s + r.b.byteLength, 0);
      res['5MB chunked'] = `ok (${cs.length} parts, read back ${total} bytes)`;
    } catch (e) {
      res['5MB chunked'] = 'ERR: ' + String(e.message || e).slice(0, 70);
    }
    return res;
  }

  insert(rows, size) {
    this.sql.exec('DROP TABLE IF EXISTS t');
    this.sql.exec('CREATE TABLE t (b BLOB)');
    const u = new Uint8Array(size);
    for (let i = 0; i < rows; i++) this.sql.exec('INSERT INTO t (b) VALUES (?)', ab(u));
    return { rows, size };
  }
  readAll() {
    const rows = this.sql.exec('SELECT b FROM t').toArray();
    let bytes = 0;
    for (const r of rows) bytes += r.b.byteLength;
    return { rows: rows.length, bytes };
  }

  // Build a doc, persist as checkpoint(½) + packed segments(¼..) + raw tail — exercising
  // the full byte-addressed tiered layout in real DO SQLite.
  persist(count, seed) {
    for (const t of ['ck', 'sg', 'tl', 'mt']) this.sql.exec('DROP TABLE IF EXISTS ' + t);
    this.sql.exec('CREATE TABLE ck (part INTEGER PRIMARY KEY, b BLOB)');
    this.sql.exec('CREATE TABLE sg (seg INTEGER, part INTEGER, b BLOB, PRIMARY KEY (seg, part))');
    this.sql.exec('CREATE TABLE tl (seq INTEGER PRIMARY KEY, b BLOB)');
    this.sql.exec('CREATE TABLE mt (k TEXT PRIMARY KEY, b BLOB)');

    const { doc, updates } = buildScene(count, seed);
    const C = Math.floor(count / 2);
    const base = new Y.Doc();
    for (let i = 0; i < C; i++) Y.applyUpdateV2(base, updates[i]);
    const ckpt = Y.encodeStateAsUpdateV2(base);
    const ckParts = chunkBytes(ckpt);
    for (let i = 0; i < ckParts.length; i++) this.sql.exec('INSERT INTO ck (part, b) VALUES (?, ?)', i, ab(ckParts[i]));

    const delta = updates.slice(C, count - TAIL);
    const segs = packSegments(delta);
    let segRows = 0;
    for (let s = 0; s < segs.length; s++) {
      const ps = chunkBytes(segs[s]);
      for (let p = 0; p < ps.length; p++) {
        this.sql.exec('INSERT INTO sg (seg, part, b) VALUES (?, ?, ?)', s, p, ab(ps[p]));
        segRows++;
      }
    }
    const tail = updates.slice(count - TAIL);
    for (let i = 0; i < tail.length; i++) this.sql.exec('INSERT INTO tl (seq, b) VALUES (?, ?)', i, ab(tail[i]));

    const fullHead = Y.encodeStateAsUpdateV2(doc);
    this.sql.exec('INSERT INTO mt (k, b) VALUES (?, ?)', 'sv', ab(Y.encodeStateVector(doc)));

    const stored =
      ckParts.reduce((s, c) => s + c.length, 0) + segs.reduce((s, c) => s + c.length, 0) + tail.reduce((s, c) => s + c.length, 0);
    return {
      count,
      fullHeadBytes: fullHead.length,
      checkpointBytes: ckpt.length,
      checkpointParts: ckParts.length,
      segments: segs.length,
      segmentRows: segRows,
      tailRows: tail.length,
      totalRows: ckParts.length + segRows + tail.length + 1,
      storedBytes: stored,
    };
  }

  // Cold reconstruct from storage only (fresh doc), verify against stored state vector.
  reload() {
    const expect = new Uint8Array(this.sql.exec('SELECT b FROM mt WHERE k = ?', 'sv').one().b);
    const doc = new Y.Doc();
    const ck = this.sql.exec('SELECT b FROM ck ORDER BY part').toArray();
    Y.applyUpdateV2(doc, reassemble(ck.map((r) => new Uint8Array(r.b))));
    const sg = this.sql.exec('SELECT seg, part, b FROM sg ORDER BY seg, part').toArray();
    const bySeg = new Map();
    for (const r of sg) {
      if (!bySeg.has(r.seg)) bySeg.set(r.seg, []);
      bySeg.get(r.seg).push(new Uint8Array(r.b));
    }
    for (const seg of [...bySeg.keys()].sort((a, b) => a - b)) Y.applyUpdateV2(doc, reassemble(bySeg.get(seg)));
    const tl = this.sql.exec('SELECT b FROM tl ORDER BY seq').toArray();
    for (const r of tl) Y.applyUpdateV2(doc, new Uint8Array(r.b));
    const ok = eqBytes(Y.encodeStateVector(doc), expect);
    return { ok, objects: doc.getMap('objects').size, ckRows: ck.length, segRows: sg.length, tailRows: tl.length };
  }
}

export default {
  async fetch(req, env) {
    const stub = env.BENCH.get(env.BENCH.idFromName('bench'));
    return stub.fetch(req);
  },
};
