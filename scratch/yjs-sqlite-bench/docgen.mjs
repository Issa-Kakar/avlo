// docgen.mjs — build representative avlo Y.Docs and capture the realistic
// per-transaction updateV2 stream (what you'd append to SQLite).
//
// Mirrors the schema in CLAUDE.md: top-level Y.Map('objects') of sub-Y.Maps.
// - stroke: { tool, color, width, opacity, points:[[x,y],...] }   ← dominates bytes
// - shape:  { shapeType, color, width, opacity, fillColor, frame:[x,y,w,h] }
// - text:   { origin, fontSize, fontFamily, color, align, width, content:Y.XmlFragment }
//
// One object is created per Y transaction (matches avlo's commit-per-gesture write
// path), so each object emits exactly one updateV2 — a faithful append log.
//
// IMPORTANT (Yjs): integrate the parent map into the doc FIRST, then populate it.
// Building a detached chain of nested Y types and attaching last can leave pending
// content unencodable at transaction cleanup. Integrate-then-fill is the safe path.

import * as Y from 'yjs';
import { mulberry32 } from './lib.mjs';

const COLORS = ['#1a1a1a', '#e03131', '#1971c2', '#2f9e44', '#f08c00', '#ae3ec9'];
const WORDS = 'the quick brown fox jumps over a lazy dog whiteboard sync crdt yjs durable object sqlite replay'.split(' ');

let zCounter = 0;
const zKey = () => `a${(zCounter++).toString(36).padStart(4, '0')}`;

let idc = 0;
const newId = (rnd) => '01HZ' + (idc++).toString(36).padStart(8, '0') + ((rnd() * 1e6) | 0).toString(36);

function setShared(m, id, kind, rnd) {
  m.set('id', id);
  m.set('kind', kind);
  m.set('ownerId', '01HZ' + ((rnd() * 1e9) | 0).toString(36));
  m.set('createdAt', 1700000000000 + ((rnd() * 1e9) | 0));
  m.set('z', zKey());
}

// `m` is already integrated into the doc before these run.
function fillStroke(m, id, rnd, points) {
  setShared(m, id, 'stroke', rnd);
  m.set('tool', rnd() < 0.85 ? 'pen' : 'highlighter');
  m.set('color', COLORS[(rnd() * COLORS.length) | 0]);
  m.set('width', 1 + ((rnd() * 6) | 0));
  m.set('opacity', rnd() < 0.85 ? 1 : 0.6);
  const pts = new Array(points);
  let x = rnd() * 2000;
  let y = rnd() * 2000;
  for (let i = 0; i < points; i++) {
    x += (rnd() - 0.5) * 24; // random-walk like a real pen stroke
    y += (rnd() - 0.5) * 24;
    pts[i] = [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
  }
  m.set('points', pts);
}

function fillShape(m, id, rnd) {
  setShared(m, id, 'shape', rnd);
  m.set('shapeType', ['rect', 'ellipse', 'diamond', 'roundedRect'][(rnd() * 4) | 0]);
  m.set('color', COLORS[(rnd() * COLORS.length) | 0]);
  m.set('width', 1 + ((rnd() * 4) | 0));
  m.set('opacity', 1);
  m.set('fillColor', rnd() < 0.6 ? COLORS[(rnd() * COLORS.length) | 0] : null);
  m.set('frame', [rnd() * 3000, rnd() * 3000, 80 + rnd() * 400, 60 + rnd() * 300]);
}

function fillText(m, id, rnd) {
  setShared(m, id, 'text', rnd);
  m.set('origin', [rnd() * 3000, rnd() * 3000]);
  m.set('fontSize', [16, 20, 28, 40][(rnd() * 4) | 0]);
  m.set('fontFamily', 'sans');
  m.set('color', COLORS[(rnd() * COLORS.length) | 0]);
  m.set('align', 'left');
  m.set('width', 'auto');
  const n = 4 + ((rnd() * 16) | 0);
  let s = '';
  for (let i = 0; i < n; i++) s += (i ? ' ' : '') + WORDS[(rnd() * WORDS.length) | 0];
  const frag = new Y.XmlFragment();
  m.set('content', frag); // integrate frag (m is already integrated)
  const p = new Y.XmlElement('paragraph');
  frag.insert(0, [p]); // integrate p
  p.insert(0, [new Y.XmlText(s)]); // integrate XmlText with its initial string
}

/**
 * Draw session: `count` objects, mix of stroke/shape/text. Returns the live doc
 * plus the captured V2 update stream (one update per object-create transaction).
 */
export function buildDrawScene({ count, seed = 1, pointsAvg = 120 }) {
  const doc = new Y.Doc();
  const updates = [];
  doc.on('updateV2', (u) => updates.push(u));
  const objects = doc.getMap('objects');
  const rnd = mulberry32(seed);
  for (let i = 0; i < count; i++) {
    const r = rnd();
    const oid = newId(rnd);
    doc.transact(() => {
      const m = new Y.Map();
      objects.set(oid, m); // integrate FIRST, then fill
      if (r < 0.7) {
        const pts = Math.max(6, Math.round(pointsAvg * (0.3 + rnd() * 1.6)));
        fillStroke(m, oid, rnd, pts);
      } else if (r < 0.95) fillShape(m, oid, rnd);
      else fillText(m, oid, rnd);
    });
  }
  return { doc, updates };
}

/**
 * Churn session: build `count` objects, then apply `ops` mutations — moving frames
 * and deleting objects. Deletes create tombstones, which is where mergeUpdatesV2
 * (keeps tombstones) and encodeStateAsUpdateV2 (GCs them) diverge in size.
 */
export function buildChurnScene({ count, ops, seed = 7, pointsAvg = 80, deleteProb = 0.1, keepFloor = 0.6 }) {
  const { doc, updates } = buildDrawScene({ count, seed, pointsAvg });
  const objects = doc.getMap('objects');
  const rnd = mulberry32(seed ^ 0x9e3779b9);
  const floor = Math.floor(count * keepFloor); // don't churn the doc down to nothing
  let deletes = 0;
  for (let i = 0; i < ops; i++) {
    const keys = [...objects.keys()];
    if (keys.length === 0) break;
    const k = keys[(rnd() * keys.length) | 0];
    doc.transact(() => {
      if (rnd() < deleteProb && objects.size > floor) {
        objects.delete(k);
        deletes++;
      } else {
        const m = objects.get(k);
        const f = m.get('frame');
        if (f) m.set('frame', [f[0] + (rnd() - 0.5) * 40, f[1] + (rnd() - 0.5) * 40, f[2], f[3]]);
        else m.set('z', zKey()); // reorder strokes/text
      }
    });
  }
  return { doc, updates, deletes };
}

/**
 * Typing session: one text object, `chars` keystrokes each in their own transaction.
 * Models CodeMirror/Tiptap fine-grained edits → a flood of tiny updates (the case
 * that makes the append-log balloon and forces compaction).
 */
export function buildTypingScene({ chars, seed = 3 }) {
  const doc = new Y.Doc();
  const updates = [];
  doc.on('updateV2', (u) => updates.push(u));
  const objects = doc.getMap('objects');
  const rnd = mulberry32(seed);
  const oid = newId(rnd);
  let text;
  doc.transact(() => {
    const m = new Y.Map();
    objects.set(oid, m); // integrate first
    setShared(m, oid, 'code', rnd);
    m.set('origin', [rnd() * 1000, rnd() * 1000]);
    m.set('fontSize', 16);
    m.set('width', 600);
    m.set('language', 'typescript');
    text = new Y.Text();
    m.set('content', text); // integrate the Y.Text
  });
  const sample = 'const x = compute(a, b); // sync via yjs\n';
  for (let i = 0; i < chars; i++) {
    const ch = sample[i % sample.length];
    doc.transact(() => text.insert(text.length, ch));
  }
  return { doc, updates };
}

/**
 * Bulk-paste / mass-edit: create `count` objects in ONE transaction so a single
 * updateV2 exceeds the 2 MB cell limit. Models a big clipboard paste, an import, or
 * renormalizeZ rewriting every z-key at once. Returns the doc and that single update.
 */
export function buildHugePasteScene({ count, seed = 9, pointsAvg = 120 }) {
  const doc = new Y.Doc();
  const updates = [];
  doc.on('updateV2', (u) => updates.push(u));
  const objects = doc.getMap('objects');
  const rnd = mulberry32(seed);
  doc.transact(() => {
    for (let i = 0; i < count; i++) {
      const r = rnd();
      const oid = newId(rnd);
      const m = new Y.Map();
      objects.set(oid, m);
      if (r < 0.7) fillStroke(m, oid, rnd, Math.max(6, Math.round(pointsAvg * (0.3 + rnd() * 1.6))));
      else if (r < 0.95) fillShape(m, oid, rnd);
      else fillText(m, oid, rnd);
    }
  });
  return { doc, update: updates[updates.length - 1] }; // the single big update
}

/** Sum of all update byte lengths in a stream. */
export function streamBytes(updates) {
  let b = 0;
  for (const u of updates) b += u.length;
  return b;
}

/** Internal struct count (sum of per-client struct list lengths). Best-effort. */
export function structCount(doc) {
  try {
    let n = 0;
    doc.store.clients.forEach((list) => {
      n += list.length;
    });
    return n;
  } catch {
    return -1;
  }
}
