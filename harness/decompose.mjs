// Decomposes per-frame allocation into: loop overhead, engine search, Set
// materialization, and mutation -- separately for each implementation, so the
// Set (which both sides must build) stops hiding the engine difference.
// One mode per process. Markers bracket the measured window so setup GCs don't count.
import RBush from '/home/user/tldraw/node_modules/rbush/index.js'
import { FlatRTree } from './flatrtree.mjs'
import { ShapeSpatialIndex } from './shapeindex.mjs'

const MODE = process.argv[2]
const FRAMES = Number(process.argv[3] ?? 600)
const N = 100000, UPSERTS = 200

const rand = (() => { let a = 7 >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } })()
const side = Math.sqrt(N) * 400, clusters = Math.round(N / 400)
const cx = [], cy = []
for (let i = 0; i < clusters; i++) { cx.push(rand() * side); cy.push(rand() * side) }
const boxes = new Float64Array(N * 4)
for (let i = 0; i < N; i++) { const c = (rand() * clusters) | 0, b = i * 4
  const x = cx[c] + (rand() - .5) * 2800, y = cy[c] + (rand() - .5) * 2800
  boxes[b] = x; boxes[b+1] = y; boxes[b+2] = x + 60 + rand() * 240; boxes[b+3] = y + 50 + rand() * 200 }
const ids = new Array(N); for (let i = 0; i < N; i++) ids[i] = `shape:g${i}`
const slots = new Uint32Array(N); for (let i = 0; i < N; i++) slots[i] = i

const cams = new Float64Array(FRAMES * 2)
for (let f = 0; f < FRAMES; f++) { const c = (rand() * clusters) | 0; cams[f*2] = cx[c] + (rand() - .5) * 2000; cams[f*2+1] = cy[c] + (rand() - .5) * 2000 }
const picks = new Int32Array(UPSERTS); for (let i = 0; i < UPSERTS; i++) picks[i] = (rand() * N) | 0
const work = new Float64Array(UPSERTS * 4)
for (let i = 0; i < UPSERTS; i++) { const s = picks[i] * 4; for (let k = 0; k < 4; k++) work[i*4+k] = boxes[s+k] }
const step = (i) => { const b = i*4; work[b]+=4.5; work[b+1]+=3; work[b+2]+=4.5; work[b+3]+=3 }

// --- build whichever structures this mode needs -----------------------------
const needsRbush = MODE.startsWith('rbush')
const needsFlatRaw = MODE === 'flat-search' || MODE === 'flat-upsert-raw'
const needsFlatIndex = MODE.startsWith('flat') && !needsFlatRaw

let rb = null, els = null, live = null, flat = null, index = null
if (needsRbush) {
  els = new Array(N); for (let i = 0; i < N; i++) { const b = i*4; els[i] = { minX: boxes[b], minY: boxes[b+1], maxX: boxes[b+2], maxY: boxes[b+3], id: ids[i] } }
  rb = new RBush(); rb.load(els.slice())
  live = new Map(); for (let i = 0; i < N; i++) live.set(ids[i], els[i])
}
if (needsFlatRaw) { flat = new FlatRTree(); flat.load(N, slots, boxes) }
if (needsFlatIndex) { index = new ShapeSpatialIndex(); index.beginLoad(N)
  for (let i = 0; i < N; i++) { const b = i*4; index.stage(ids[i], boxes[b], boxes[b+1], boxes[b+2], boxes[b+3]) } index.commitLoad() }

let sink = 0
const rect = { minX: 0, minY: 0, maxX: 0, maxY: 0 }
const MODES = {
  noop: (f) => { const x = cams[f*2], y = cams[f*2+1]; sink += (x + y + 1600 + 1000) | 0 },

  'rbush-search': (f) => { const x = cams[f*2], y = cams[f*2+1]
    rect.minX = x; rect.minY = y; rect.maxX = x + 1600; rect.maxY = y + 1000
    sink += rb.search(rect).length },
  'flat-search': (f) => { const x = cams[f*2], y = cams[f*2+1]
    sink += flat.search(x, y, x + 1600, y + 1000) },

  // RBushIndex.search as written: search -> map -> new Set
  'rbush-set': (f) => { const x = cams[f*2], y = cams[f*2+1]
    rect.minX = x; rect.minY = y; rect.maxX = x + 1600; rect.maxY = y + 1000
    sink += new Set(rb.search(rect).map((e) => e.id)).size },
  // the same answer without the intermediate id array
  'rbush-set-direct': (f) => { const x = cams[f*2], y = cams[f*2+1]
    rect.minX = x; rect.minY = y; rect.maxX = x + 1600; rect.maxY = y + 1000
    const r = rb.search(rect); const s = new Set()
    for (let i = 0; i < r.length; i++) s.add(r[i].id); sink += s.size },
  'flat-set': (f) => { const x = cams[f*2], y = cams[f*2+1]
    sink += index.searchToSet(x, y, x + 1600, y + 1000, false).size },

  // mutation: what the manager must do per moved shape
  'rbush-upsert': () => { for (let i = 0; i < UPSERTS; i++) { step(i); const b = i*4
    const id = ids[picks[i]]; const ex = live.get(id); if (ex) rb.remove(ex)
    const el = { minX: work[b], minY: work[b+1], maxX: work[b+2], maxY: work[b+3], id }; rb.insert(el); live.set(id, el) } },
  // best case for rbush: remove first, then mutate the same object and reinsert
  'rbush-upsert-reuse': () => { for (let i = 0; i < UPSERTS; i++) { const b = i*4
    const ex = live.get(ids[picks[i]]); rb.remove(ex); step(i)
    ex.minX = work[b]; ex.minY = work[b+1]; ex.maxX = work[b+2]; ex.maxY = work[b+3]; rb.insert(ex) } },
  'flat-upsert': () => { for (let i = 0; i < UPSERTS; i++) { step(i); const b = i*4
    index.upsert(ids[picks[i]], work[b], work[b+1], work[b+2], work[b+3]) } },
  'flat-upsert-raw': () => { for (let i = 0; i < UPSERTS; i++) { step(i); const b = i*4
    flat.update(picks[i], work[b], work[b+1], work[b+2], work[b+3]) } },

  'rbush-full': (f) => { MODES['rbush-set'](f); MODES['rbush-upsert'](f) },
  'flat-full': (f) => { MODES['flat-set'](f); MODES['flat-upsert'](f) },
}
const frame = MODES[MODE]
if (!frame) { console.error('unknown mode ' + MODE); process.exit(1) }

for (let f = 0; f < 40; f++) frame(f)        // warm outside the window
console.log('###LOOP_START')
const t0 = process.hrtime.bigint()
for (let f = 0; f < FRAMES; f++) frame(f)
const ms = Number(process.hrtime.bigint() - t0) / 1e6
console.log('###LOOP_END')
console.log(`###RESULT ${MODE} ${ms.toFixed(2)} ${sink}`)
