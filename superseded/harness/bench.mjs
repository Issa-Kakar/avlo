// rbush's own benchmark shape, plain node, no tsx, no test runner.
// Mirrors https://github.com/mourner/rbush README: 1M random boxes, bulk load,
// then 1000 searches at 1% and 0.01% of the space.
import RBush from '/home/user/tldraw/node_modules/rbush/index.js'

const N = Number(process.argv[2] ?? 1000000)
const rand = (() => { let a = 1 >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } })()

function randBox(size) {
  const x = rand() * (100 - size), y = rand() * (100 - size)
  return { minX: x, minY: y, maxX: x + size * rand(), maxY: y + size * rand() }
}
const data = new Array(N); for (let i = 0; i < N; i++) data[i] = randBox(1)
const bboxes100 = new Array(1000); for (let i = 0; i < 1000; i++) bboxes100[i] = randBox(100 * Math.sqrt(0.1))
const bboxes10  = new Array(1000); for (let i = 0; i < 1000; i++) bboxes10[i]  = randBox(100)
const bboxes1   = new Array(1000); for (let i = 0; i < 1000; i++) bboxes1[i]   = randBox(1)

const t = (label, fn) => { const t0 = process.hrtime.bigint(); const r = fn(); const ms = Number(process.hrtime.bigint() - t0) / 1e6; console.log(`${label.padEnd(34)} ${ms.toFixed(1).padStart(8)} ms${r !== undefined ? `   (${r})` : ''}`); return ms }

console.log(`rbush 3.0.1, N=${N.toLocaleString()}, node ${process.version}`)
const tree = new RBush()
t('bulk load', () => { tree.load(data); return undefined })
let n = 0
t('1000 searches of 10%',  () => { n = 0; for (const b of bboxes100) n += tree.search(b).length; return `${(n/1000)|0} hits/search` })
t('1000 searches of 1%',   () => { n = 0; for (const b of bboxes10)  n += tree.search(b).length; return `${(n/1000)|0} hits/search` })
t('1000 searches of 0.01%',() => { n = 0; for (const b of bboxes1)   n += tree.search(b).length; return `${(n/1000)|0} hits/search` })
// warm then repeat, to separate cold from steady state
t('1000 searches of 1% (warm)',   () => { n = 0; for (const b of bboxes10) n += tree.search(b).length; return `${(n/1000)|0} hits/search` })
t('1000 searches of 0.01% (warm)',() => { n = 0; for (const b of bboxes1)  n += tree.search(b).length; return `${(n/1000)|0} hits/search` })
const tree2 = new RBush()
t('insert 1M one by one', () => { for (let i = 0; i < N; i++) tree2.insert(data[i]); return undefined })
t('remove 1000 one by one', () => { for (let i = 0; i < 1000; i++) tree2.remove(data[i]); return undefined })
