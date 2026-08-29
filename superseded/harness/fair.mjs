// Re-checks the two ratios that look suspiciously large, with a bounded workload
// instead of the "drain the whole tree" / "move the same shapes forever" shapes
// the earlier harness used. Plain node, one implementation per process.
import RBush from '/home/user/tldraw/node_modules/rbush/index.js'
import { FlatRTree } from './flatrtree.mjs'

const IMPL = process.argv[2]
const N = 100000
const rand = (() => { let a = 7 >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } })()

// same board generator as the committed harness
const side = Math.sqrt(N) * 400, clusters = Math.round(N / 400)
const cx = [], cy = []
for (let i = 0; i < clusters; i++) { cx.push(rand() * side); cy.push(rand() * side) }
const boxes = new Float64Array(N * 4)
for (let i = 0; i < N; i++) {
  const roll = rand(), c = (rand() * clusters) | 0, b = i * 4
  let x, y, w, h
  if (roll < 0.68) { x = cx[c] + (rand() - .5) * 2800; y = cy[c] + (rand() - .5) * 2800; w = 60 + rand() * 240; h = 50 + rand() * 200 }
  else if (roll < 0.82) { x = cx[c] + (rand() - .5) * 2800; y = cy[c] + (rand() - .5) * 2800; w = 40 + rand() * 300; h = 18 + rand() * 30 }
  else if (roll < 0.95) { const c2 = (rand() * clusters) | 0, same = rand() < .75
    const x1 = cx[c] + (rand() - .5) * 2800, y1 = cy[c] + (rand() - .5) * 2800
    const x2 = same ? x1 + (rand() - .5) * 1400 : cx[c2] + (rand() - .5) * 2800
    const y2 = same ? y1 + (rand() - .5) * 1400 : cy[c2] + (rand() - .5) * 2800
    x = Math.min(x1, x2); y = Math.min(y1, y2); w = Math.max(2, Math.abs(x2 - x1)); h = Math.max(2, Math.abs(y2 - y1)) }
  else { x = cx[c] - 1400 + (rand() - .5) * 400; y = cy[c] - 1400 + (rand() - .5) * 400; w = 1200 + rand() * 3000; h = 900 + rand() * 2200 }
  boxes[b] = x; boxes[b + 1] = y; boxes[b + 2] = x + w; boxes[b + 3] = y + h
}
const items = new Array(N)
for (let i = 0; i < N; i++) { const b = i * 4; items[i] = { minX: boxes[b], minY: boxes[b+1], maxX: boxes[b+2], maxY: boxes[b+3], id: i } }

const med = (a) => { a.sort((x, y) => x - y); return a[a.length >> 1] }
const time = (reps, fn) => { const t = []; for (let r = 0; r < reps; r++) { const t0 = process.hrtime.bigint(); fn(r); t.push(Number(process.hrtime.bigint() - t0)) } return med(t) }
const out = {}

// pick 2000 shapes to churn; the SAME set for both impls
const picks = new Int32Array(2000); for (let i = 0; i < 2000; i++) picks[i] = (rand() * N) | 0
// travel far enough that a moved shape leaves its neighbourhood, unlike the
// earlier drag which nudged the same shapes by 3% of their width forever
const far = new Float64Array(2000 * 2)
for (let i = 0; i < 2000; i++) { far[i*2] = rand() * side; far[i*2+1] = rand() * side }

if (IMPL === 'rbush') {
  const build = () => { const t = new RBush(); t.load(items.slice()); return t }
  out.load = time(5, () => { const t = new RBush(); t.load(items.slice()) })
  let tree = build()
  // bounded remove: 1000 out of 100k, tree rebuilt outside the timer
  { const t = []; for (let r = 0; r < 5; r++) { tree = build()
      const t0 = process.hrtime.bigint(); for (let i = 0; i < 1000; i++) tree.remove(items[picks[i]])
      t.push(Number(process.hrtime.bigint() - t0)) } out.remove1000 = med(t) / 1000 }
  tree = build()
  // one drag frame: 200 shapes nudged, as remove+insert with a fresh element
  const work = new Float64Array(200 * 4)
  for (let i = 0; i < 200; i++) { const s = picks[i] * 4; work[i*4] = boxes[s]; work[i*4+1] = boxes[s+1]; work[i*4+2] = boxes[s+2]; work[i*4+3] = boxes[s+3] }
  const live = new Array(200); for (let i = 0; i < 200; i++) live[i] = items[picks[i]]
  out.dragFrame200 = time(60, () => {
    for (let i = 0; i < 200; i++) { const b = i*4; work[b]+=4.5; work[b+1]+=3; work[b+2]+=4.5; work[b+3]+=3
      tree.remove(live[i]); const el = { minX: work[b], minY: work[b+1], maxX: work[b+2], maxY: work[b+3], id: live[i].id }; tree.insert(el); live[i] = el }
  })
  // teleport: shapes genuinely leaving their cluster
  out.teleport = time(5, () => { for (let i = 0; i < 2000; i++) { const it = live[i % 200]; tree.remove(it)
      const el = { minX: far[i*2], minY: far[i*2+1], maxX: far[i*2]+150, maxY: far[i*2+1]+120, id: it.id }; tree.insert(el); live[i % 200] = el } }) / 2000
} else {
  const ids = new Uint32Array(N); for (let i = 0; i < N; i++) ids[i] = i
  const build = () => { const t = new FlatRTree(); t.load(N, ids, boxes); return t }
  out.load = time(5, () => { const t = new FlatRTree(); t.load(N, ids, boxes) })
  let tree = build()
  { const t = []; for (let r = 0; r < 5; r++) { tree = build()
      const t0 = process.hrtime.bigint(); for (let i = 0; i < 1000; i++) tree.remove(picks[i])
      t.push(Number(process.hrtime.bigint() - t0)) } out.remove1000 = med(t) / 1000 }
  tree = build()
  const work = new Float64Array(200 * 4)
  for (let i = 0; i < 200; i++) { const s = picks[i] * 4; work[i*4] = boxes[s]; work[i*4+1] = boxes[s+1]; work[i*4+2] = boxes[s+2]; work[i*4+3] = boxes[s+3] }
  out.dragFrame200 = time(60, () => {
    for (let i = 0; i < 200; i++) { const b = i*4; work[b]+=4.5; work[b+1]+=3; work[b+2]+=4.5; work[b+3]+=3
      tree.update(picks[i], work[b], work[b+1], work[b+2], work[b+3]) }
  })
  out.teleport = time(5, () => { for (let i = 0; i < 2000; i++) tree.update(picks[i % 200], far[i*2], far[i*2+1], far[i*2]+150, far[i*2+1]+120) }) / 2000
}
console.log(JSON.stringify({ impl: IMPL, ...out }))
