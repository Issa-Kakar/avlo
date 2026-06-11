// lib.mjs — timing, stats, formatting, chunking, and node:sqlite helpers.
// Throwaway scratch. Node 22 built-in node:sqlite is used as a *local-engine floor*
// for the SQLite ops — it is NOT Cloudflare DO SQLite (which adds durability /
// write-amplification on top). Yjs ops run in V8, identical to workerd.

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MB = 1024 * 1024;
export const CELL_LIMIT = 2 * MB; // DO SQLite per-value ceiling the user cited

// --- deterministic PRNG so runs are reproducible -------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- stats ---------------------------------------------------------------------
export function stats(samplesMs) {
  const a = Float64Array.from(samplesMs).sort();
  const n = a.length;
  const q = (p) => a[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  const mean = a.reduce((s, x) => s + x, 0) / n;
  return { n, min: a[0], p50: q(0.5), p90: q(0.9), max: a[n - 1], mean };
}

/**
 * Time `op`. `setup()` (untimed) runs before every iteration and returns the input
 * passed to `op` — use it to hand `op` fresh mutable state (a new Y.Doc, a clean
 * table) so we measure the op, not accumulated state. `op` may return a value used
 * only to defeat dead-code elimination.
 */
export function bench(op, { setup = () => undefined, iters = 25, warmup = 5, gc = true } = {}) {
  for (let i = 0; i < warmup; i++) op(setup());
  const samples = new Float64Array(iters);
  let sink = 0;
  for (let i = 0; i < iters; i++) {
    const input = setup();
    if (gc && global.gc) global.gc();
    const t0 = process.hrtime.bigint();
    const r = op(input);
    const t1 = process.hrtime.bigint();
    samples[i] = Number(t1 - t0) / 1e6;
    if (typeof r === 'number') sink += r;
  }
  const s = stats(samples);
  s.sink = sink;
  return s;
}

// --- byte / chunk helpers ------------------------------------------------------
export function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < MB) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / MB).toFixed(2)} MB`;
}
export function fmtMs(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
  if (ms < 100) return `${ms.toFixed(2)} ms`;
  return `${ms.toFixed(1)} ms`;
}

/** Split a Uint8Array into ≤size chunks (subarrays — zero copy). */
export function chunk(u8, size = CELL_LIMIT) {
  const out = [];
  for (let i = 0; i < u8.length; i += size) out.push(u8.subarray(i, Math.min(i + size, u8.length)));
  return out;
}
/** Reassemble chunks into one contiguous Uint8Array (one alloc + memcpy per chunk). */
export function reassemble(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// node:sqlite wants a Buffer/Uint8Array for BLOB params; normalize to Buffer view.
export const asBuf = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);

// --- node:sqlite helpers -------------------------------------------------------
export function openTempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'yjsbench-'));
  const path = join(dir, 'do.sqlite');
  const db = new DatabaseSync(path);
  // WAL ≈ the journaling DO SQLite uses; still a local floor, not DO durability cost.
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');
  return {
    db,
    path,
    dir,
    fileBytes() {
      let b = 0;
      for (const f of ['do.sqlite', 'do.sqlite-wal', 'do.sqlite-shm']) {
        try {
          b += statSync(join(dir, f)).size;
        } catch {}
      }
      return b;
    },
    pageBytes() {
      const pc = db.prepare('PRAGMA page_count').get();
      const ps = db.prepare('PRAGMA page_size').get();
      return Object.values(pc)[0] * Object.values(ps)[0];
    },
    close() {
      try {
        db.close();
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

/**
 * Durable DB on real disk: rollback journal + synchronous=FULL ⇒ each COMMIT fsyncs.
 * This is the honest "durable commit" floor (still NOT DO storage, which replicates on
 * top). `baseDir` must be on a real filesystem (not tmpfs) for the fsync to be real.
 */
export function openDurableDb(baseDir) {
  const dir = mkdtempSync(join(baseDir, 'dur-'));
  const db = new DatabaseSync(join(dir, 'do.db'));
  db.exec('PRAGMA journal_mode=DELETE'); // rollback journal → fsync per COMMIT
  db.exec('PRAGMA synchronous=FULL');
  return {
    db,
    dir,
    pageBytes() {
      const pc = db.prepare('PRAGMA page_count').get();
      const ps = db.prepare('PRAGMA page_size').get();
      return Object.values(pc)[0] * Object.values(ps)[0];
    },
    close() {
      try {
        db.close();
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

// --- tiny markdown table builder ----------------------------------------------
export function mdTable(headers, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map((r) => line(r))].join('\n');
}
