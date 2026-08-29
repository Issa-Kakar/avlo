// What a second of interaction costs the collector, at 100k shapes.
// One implementation per process. Two passes:
//   --trace-gc on default heap settings  -> how many collections, how long
//   huge young gen (no scavenge possible) -> exact bytes allocated
import RBush from '/home/user/tldraw/node_modules/rbush/index.js'
import { ShapeSpatialIndex } from './shapeindex.mjs'

const IMPL = process.argv[2]
const FRAMES = Number(process.argv[3] ?? 600)
const N = 100000
const rand = (() => { let a = 7 >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } })()
const side = Math.sqrt(N) * 400, clusters = Math.round(N / 400)
const cx = [], cy = []
for (let i = 0; i < clusters; i++) { cx.push(rand() * side); cy.push(rand() * side) }
const boxes = new Float64Array(N * 4)
for (let i = 0; i < N; i++) { const c = (rand() * clusters) | 0, b = i * 4
  const x = cx[c] + (rand() - .5) * 2800, y = cy[c] + (rand() - .5) * 2800
  boxes[b] = x; boxes[b+1] = y; boxes[b+2] = x + 60 + rand() * 240; boxes[b+3] = y + 50 + rand() * 200 }
const ids = new Array(N); for (let i = 0; i < N; i++) ids[i] = `shape:g${i}`

// a 1600x1000 viewport wandering over the populated area
const cams = new Float64Array(FRAMES * 2)
for (let f = 0; f < FRAMES; f++) { const c = (rand() * clusters) | 0; cams[f*2] = cx[c] + (rand() - .5) * 2000; cams[f*2+1] = cy[c] + (rand() - .5) * 2000 }
const picks = new Int32Array(200); for (let i = 0; i < 200; i++) picks[i] = (rand() * N) | 0
const work = new Float64Array(200 * 4)
for (let i = 0; i < 200; i++) { const s = picks[i] * 4; for (let k = 0; k < 4; k++) work[i*4+k] = boxes[s+k] }

let frame, hits = 0
if (IMPL === 'rbush') {
  const tree = new RBush(); const live = new Map()
  const els = new Array(N); for (let i = 0; i < N; i++) { const b = i*4; els[i] = { minX: boxes[b], minY: boxes[b+1], maxX: boxes[b+2], maxY: boxes[b+3], id: ids[i] } }
  tree.load(els.slice()); for (let i = 0; i < N; i++) live.set(ids[i], els[i])
  frame = (f) => {
    const x = cams[f*2], y = cams[f*2+1]
    const r = tree.search({ minX: x, minY: y, maxX: x + 1600, maxY: y + 1000 })
    hits += new Set(r.map((e) => e.id)).size                     // what RBushIndex.search does
    for (let i = 0; i < 200; i++) { const b = i*4; work[b]+=4.5; work[b+1]+=3; work[b+2]+=4.5; work[b+3]+=3
      const id = ids[picks[i]]; const ex = live.get(id); if (ex) tree.remove(ex)
      const el = { minX: work[b], minY: work[b+1], maxX: work[b+2], maxY: work[b+3], id }; tree.insert(el); live.set(id, el) }
  }
} else {
  const index = new ShapeSpatialIndex()
  const query = IMPL === 'flat-query' ? index.acquireQuery() : null
  index.beginLoad(N); for (let i = 0; i < N; i++) { const b = i*4; index.stage(ids[i], boxes[b], boxes[b+1], boxes[b+2], boxes[b+3]) } index.commitLoad()
  frame = (f) => {
    const x = cams[f*2], y = cams[f*2+1]
    hits += query ? query.searchBounds(x, y, x + 1600, y + 1000).size : index.searchToSet(x, y, x + 1600, y + 1000, false).size
    for (let i = 0; i < 200; i++) { const b = i*4; work[b]+=4.5; work[b+1]+=3; work[b+2]+=4.5; work[b+3]+=3
      index.upsert(ids[picks[i]], work[b], work[b+1], work[b+2], work[b+3]) }
  }
}

for (let f = 0; f < 30; f++) frame(f)          // warm
if (global.gc) { global.gc(); global.gc() }
const before = process.memoryUsage().heapUsed
const t0 = process.hrtime.bigint()
for (let f = 0; f < FRAMES; f++) frame(f)
const ms = Number(process.hrtime.bigint() - t0) / 1e6
const alloc = process.memoryUsage().heapUsed - before
console.log(JSON.stringify({ impl: IMPL, frames: FRAMES, ms: +ms.toFixed(1), msPerFrame: +(ms / FRAMES).toFixed(3), allocBytes: alloc, kbPerFrame: +(alloc / FRAMES / 1024).toFixed(1), avgHits: Math.round(hits / FRAMES) }))
