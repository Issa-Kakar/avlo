// Tier 1b -- gestures, which is what the maintainers actually benchmark.
// Steve Ruiz's perf PRs are quoted in units of "a 2000-shape, 60-tick gesture"
// and "dragging a single shape on a canvas with ~2.5K shapes", so those are the
// shapes measured here.
//
// One tick of a gesture is: upsert every selected shape, then run the one
// viewport query the frame does (measured on shipped tldraw: exactly one index
// query per frame, in every interaction).
//
// The motion is SUSTAINED and directional, reversing every 60 ticks so the
// selection stays on screen. This matters: nudging shapes a few percent of
// their width around a fixed point keeps every update in the tree's O(1) tier
// and produces a speedup several times larger than a real drag ever sees. The
// travel per tick is a parameter here, and the sweep is reported, precisely so
// that the fast-path mix is visible instead of chosen.

import { allocPerOp, timePerOp, gcProfile } from '../lib/measure.mjs'
import { makeBoxes } from '../lib/data.mjs'

const arg = (k, d) => {
	const hit = process.argv.find((a) => a.startsWith('--' + k + '='))
	return hit ? hit.slice(k.length + 3) : d
}

const ENGINE = arg('engine', 'flat')
const DATA = arg('data', 'board')
const N = +arg('n', 2500)
const SEL = +arg('sel', 1)
const PX = +arg('px', 12) // page units of pointer travel per tick
const GESTURE = arg('gesture', 'drag') // drag | resize
const MEASURE = arg('measure', 'alloc')
const TICKS = 60

const ds = makeBoxes(DATA, N, 1)
const { boxes } = ds
const cur = new Float64Array(boxes)

const RBush = ENGINE === 'rbush' ? (await import('rbush')).default : null
const FlatRTree = ENGINE === 'flat' ? (await import('../lib/flatrtree.mjs')).FlatRTree : null

const ids = new Uint32Array(N)
for (let i = 0; i < N; i++) ids[i] = i

// A viewport the size of a screen at zoom 1, placed where the page is densest
// so the selection and the cull both have something to do.
const VW = 1600
const VH = 900
let bestX = 0
let bestY = 0
{
	let best = -1
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
			bestX = x
			bestY = y
		}
	}
}
const vp = [bestX, bestY, bestX + VW, bestY + VH]

// Selection: shapes in (or nearest to) the viewport, which is what a user grabs.
const sel = new Uint32Array(SEL)
{
	const inView = []
	for (let i = 0; i < N; i++) {
		const j = i << 2
		if (boxes[j] < vp[2] && boxes[j + 2] > vp[0] && boxes[j + 1] < vp[3] && boxes[j + 3] > vp[1]) inView.push(i)
	}
	for (let k = 0; k < SEL; k++) sel[k] = inView.length ? inView[k % inView.length] : k % N
	if (SEL > inView.length) for (let k = inView.length; k < SEL; k++) sel[k] = k % N
}

// Selection centroid, for resize
let cX = 0
let cY = 0
for (let k = 0; k < SEL; k++) {
	const j = sel[k] << 2
	cX += (boxes[j] + boxes[j + 2]) / 2
	cY += (boxes[j + 1] + boxes[j + 3]) / 2
}
cX /= SEL
cY /= SEL

let sink = 0

function build() {
	cur.set(boxes)
	if (ENGINE === 'rbush') {
		const els = new Array(N)
		for (let i = 0; i < N; i++) {
			const j = i << 2
			els[i] = { minX: boxes[j], minY: boxes[j + 1], maxX: boxes[j + 2], maxY: boxes[j + 3], id: i }
		}
		const t = new RBush()
		t.load(els.slice())
		return { t, els }
	}
	const t = new FlatRTree()
	t.load(N, ids, cur)
	return { t, els: null }
}

/** One frame: SEL upserts, then the frame's single viewport query. */
function makeTick() {
	const { t, els } = build()
	if (ENGINE === 'rbush') {
		const qo = { minX: vp[0], minY: vp[1], maxX: vp[2], maxY: vp[3] }
		return (tick) => {
			const dir = ((tick / TICKS) | 0) % 2 ? -1 : 1
			const f = GESTURE === 'resize' ? 1 + (dir * PX) / 1000 : 0
			for (let k = 0; k < SEL; k++) {
				const id = sel[k]
				const j = id << 2
				const e = els[id]
				t.remove(e)
				if (GESTURE === 'resize') {
					cur[j] = cX + (cur[j] - cX) * f
					cur[j + 1] = cY + (cur[j + 1] - cY) * f
					cur[j + 2] = cX + (cur[j + 2] - cX) * f
					cur[j + 3] = cY + (cur[j + 3] - cY) * f
				} else {
					cur[j] += dir * PX
					cur[j + 2] += dir * PX
				}
				e.minX = cur[j]
				e.minY = cur[j + 1]
				e.maxX = cur[j + 2]
				e.maxY = cur[j + 3]
				t.insert(e)
			}
			const r = t.search(qo)
			let s = 0
			for (let i = 0; i < r.length; i++) s = (s + r[i].id) | 0
			sink = (sink + s) | 0
		}
	}
	return (tick) => {
		const dir = ((tick / TICKS) | 0) % 2 ? -1 : 1
		const f = GESTURE === 'resize' ? 1 + (dir * PX) / 1000 : 0
		for (let k = 0; k < SEL; k++) {
			const id = sel[k]
			const j = id << 2
			if (GESTURE === 'resize') {
				cur[j] = cX + (cur[j] - cX) * f
				cur[j + 1] = cY + (cur[j + 1] - cY) * f
				cur[j + 2] = cX + (cur[j + 2] - cX) * f
				cur[j + 3] = cY + (cur[j + 3] - cY) * f
			} else {
				cur[j] += dir * PX
				cur[j + 2] += dir * PX
			}
			t.update(id, cur[j], cur[j + 1], cur[j + 2], cur[j + 3])
		}
		const cnt = t.search(vp[0], vp[1], vp[2], vp[3])
		const res = t.results
		let s = 0
		for (let i = 0; i < cnt; i++) s = (s + res[i]) | 0
		sink = (sink + s) | 0
	}
}

const out = { engine: ENGINE, data: DATA, n: N, sel: SEL, px: PX, gesture: GESTURE, measure: MEASURE }

if (MEASURE === 'alloc') {
	const r = await allocPerOp(makeTick, 20000, 0.08)
	out.bytesPerTick = r.bytes
	out.linear = r.linear
	out.windows = r.windows
	out.fixedBytes = r.fixed
	out.bytesHeap = r.heap
	out.bytesArrayBuffer = r.ab
	out.mbPerSecAt60fps = r.bytes === null ? null : (r.bytes * 60) / 1e6
	out.reason = r.reason
} else if (MEASURE === 'time') {
	const r = timePerOp(makeTick, 600, 9, 3)
	out.msPerTick = r.ns / 1e6
	out.msMedian = r.median / 1e6
	out.budgetPct = (r.ns / 1e6 / 16.67) * 100
} else if (MEASURE === 'gc') {
	// Production heap settings on purpose -- this cell is about what the user
	// feels, so it must run with the young generation a real app would have.
	const tick = makeTick()
	const TOTAL = +arg('ticks', 6000)
	const g = await gcProfile(() => {
		for (let i = 0; i < TOTAL; i++) tick(i)
	})
	out.ticks = TOTAL
	out.gc = g
	out.scavengesPerTick = g.scavenges / TOTAL
	out.gcMsPerTick = g.totalMs / TOTAL
	out.worstPauseMs = g.maxMs
	out.msPerTick = g.wallMs / TOTAL
}

out.sink = sink
console.log('###JSON###' + JSON.stringify(out))
