// Tier 2 -- the integrated layer, measured exactly as tldraw's manager drives it.
//
// This is where the costs the engine comparison deliberately excluded come back:
// the `Set<TLShapeId>` a search has to return, the id-to-payload bookkeeping, and
// on the rbush side the `SpatialElement` object the manager must mint per upsert
// because `applyBatch` takes objects. Those are real costs of the shipped code,
// so they belong here rather than in tier 1 -- but they are the wrapper's, not
// rbush's, which is why the two tiers are reported separately.
//
// Both sides return a real `Set<TLShapeId>`. The public API does not change.

import { allocPerOp, timePerOp, gcProfile } from '../lib/measure.mjs'
import { makeBoxes, makeQueries } from '../lib/data.mjs'

const arg = (k, d) => {
	const hit = process.argv.find((a) => a.startsWith('--' + k + '='))
	return hit ? hit.slice(k.length + 3) : d
}

const ENGINE = arg('engine', 'flat')
const DATA = arg('data', 'board')
const N = +arg('n', 20000)
const SEL = +arg('sel', 200)
const PX = +arg('px', 12)
const OP = arg('op', 'gesture') // gesture | search | load
const FRAC = +arg('frac', 0.01)
const MEASURE = arg('measure', 'alloc')
const TICKS = 60

const ds = makeBoxes(DATA, N, 1)
const { boxes } = ds
const cur = new Float64Array(boxes)

// Real-shaped ids: tldraw's are `shape:${nanoid()}`, and string length and
// interning both matter to a Set and a Map.
const shapeIds = new Array(N)
for (let i = 0; i < N; i++) shapeIds[i] = 'shape:' + i.toString(36).padStart(8, '0')

const RBushIndex = ENGINE === 'rbush' ? (await import('../lib/rbushindex.mjs')).RBushIndex : null
const ShapeSpatialIndex = ENGINE === 'flat' ? (await import('../lib/shapeindex.mjs')).ShapeSpatialIndex : null

const vp = (() => {
	const VW = 1600
	const VH = 900
	let best = -1
	let bx = 0
	let by = 0
	for (let s = 0; s < 400; s++) {
		const x = (s % 20) * (ds.world / 20)
		const y = ((s / 20) | 0) * (ds.world / 20)
		let c = 0
		for (let i = 0; i < N; i++) {
			const j = i << 2
			if (boxes[j] < x + VW && boxes[j + 2] > x && boxes[j + 1] < y + VH && boxes[j + 3] > y) c++
		}
		if (c > best) {
			best = c
			bx = x
			by = y
		}
	}
	return [bx, by, bx + VW, by + VH]
})()

const sel = new Uint32Array(SEL)
{
	const inView = []
	for (let i = 0; i < N; i++) {
		const j = i << 2
		if (boxes[j] < vp[2] && boxes[j + 2] > vp[0] && boxes[j + 1] < vp[3] && boxes[j + 3] > vp[1]) inView.push(i)
	}
	for (let k = 0; k < SEL; k++) sel[k] = inView.length ? inView[k % inView.length] : k % N
}

let sink = 0

function build() {
	cur.set(boxes)
	if (ENGINE === 'rbush') {
		const ix = new RBushIndex()
		const els = new Array(N)
		for (let i = 0; i < N; i++) {
			const j = i << 2
			els[i] = { minX: boxes[j], minY: boxes[j + 1], maxX: boxes[j + 2], maxY: boxes[j + 3], id: shapeIds[i] }
		}
		ix.bulkLoad(els)
		return ix
	}
	const ix = new ShapeSpatialIndex()
	ix.rebuildFrom(N, (add) => {
		for (let i = 0; i < N; i++) {
			const j = i << 2
			add(shapeIds[i], boxes[j], boxes[j + 1], boxes[j + 2], boxes[j + 3])
		}
	})
	return ix
}

/** One frame of a gesture, driven the way SpatialIndexManager drives it. */
function makeTick() {
	const ix = build()
	if (ENGINE === 'rbush') {
		const removes = new Set()
		const qbox = { minX: vp[0], minY: vp[1], maxX: vp[2], maxY: vp[3] }
		return (tick) => {
			const dir = ((tick / TICKS) | 0) % 2 ? -PX : PX
			// applyBatch takes objects, so the manager mints one per upsert.
			const upserts = []
			for (let k = 0; k < SEL; k++) {
				const id = sel[k]
				const j = id << 2
				cur[j] += dir
				cur[j + 2] += dir
				upserts.push({ minX: cur[j], minY: cur[j + 1], maxX: cur[j + 2], maxY: cur[j + 3], id: shapeIds[id] })
			}
			ix.applyBatch(removes, upserts)
			sink = (sink + ix.search(qbox).size) | 0
		}
	}
	return (tick) => {
		const dir = ((tick / TICKS) | 0) % 2 ? -PX : PX
		for (let k = 0; k < SEL; k++) {
			const id = sel[k]
			const j = id << 2
			cur[j] += dir
			cur[j + 2] += dir
			ix.upsert(shapeIds[id], cur[j], cur[j + 1], cur[j + 2], cur[j + 3])
		}
		sink = (sink + ix.search(vp[0], vp[1], vp[2], vp[3], false).size) | 0
	}
}

const QCOUNT = 512
const queries = makeQueries(ds, QCOUNT, FRAC, 207)

function makeSearch() {
	const ix = build()
	if (ENGINE === 'rbush') {
		const qbox = { minX: 0, minY: 0, maxX: 0, maxY: 0 }
		return (i) => {
			const j = (i % QCOUNT) << 2
			qbox.minX = queries[j]
			qbox.minY = queries[j + 1]
			qbox.maxX = queries[j + 2]
			qbox.maxY = queries[j + 3]
			sink = (sink + ix.search(qbox).size) | 0
		}
	}
	return (i) => {
		const j = (i % QCOUNT) << 2
		sink = (sink + ix.search(queries[j], queries[j + 1], queries[j + 2], queries[j + 3], false).size) | 0
	}
}

function makeLoad() {
	return () => {
		const ix = build()
		sink = (sink + ix.getSize()) | 0
	}
}

const BODIES = { gesture: makeTick, search: makeSearch, load: makeLoad }
const make = BODIES[OP]
const out = { engine: ENGINE, data: DATA, n: N, sel: SEL, px: PX, op: OP, frac: FRAC, measure: MEASURE, tier: 2 }

// Parity: both wrappers must answer identically before any number is reported.
{
	const ix = build()
	let total = 0
	for (let i = 0; i < QCOUNT; i++) {
		const j = i << 2
		const set =
			ENGINE === 'rbush'
				? ix.search({ minX: queries[j], minY: queries[j + 1], maxX: queries[j + 2], maxY: queries[j + 3] })
				: ix.search(queries[j], queries[j + 1], queries[j + 2], queries[j + 3], false)
		total += set.size
	}
	out.checksum = total
}

if (MEASURE === 'alloc') {
	const r = await allocPerOp(make, OP === 'load' ? 16 : 20000, 0.08, OP === 'load' ? 'repeat' : 'linear')
	out.bytesPerOp = r.bytes
	out.fixedBytes = r.fixed
	out.reason = r.reason
	if (r.bytes !== null && OP === 'gesture') out.mbPerSecAt60fps = (r.bytes * 60) / 1e6
} else if (MEASURE === 'time') {
	const n = OP === 'load' ? 12 : OP === 'gesture' ? 600 : 20000
	const r = timePerOp(make, n, OP === 'load' ? 9 : 7, 2)
	out.nsPerOp = r.ns
	out.msPerOp = r.ns / 1e6
} else if (MEASURE === 'gc') {
	const body = make()
	const TOTAL = +arg('ticks', 6000)
	const g = await gcProfile(() => {
		for (let i = 0; i < TOTAL; i++) body(i)
	})
	out.ticks = TOTAL
	out.gc = g
	out.worstPauseMs = g.maxMs
	out.msPerTick = g.wallMs / TOTAL
}

out.sink = sink
console.log('###JSON###' + JSON.stringify(out))
