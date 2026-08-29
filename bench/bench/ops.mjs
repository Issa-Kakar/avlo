// Tier 1 -- the raw engine comparison. One engine per process, so every call
// site in the driver stays monomorphic and we measure the tree rather than
// megamorphic dispatch between two trees.
//
// Both engines are handed byte-identical work in the same order, and the driver
// consumes results the same way on both sides. Where rbush needs an object the
// object is minted OUTSIDE the measured window and mutated in place, so nothing
// here charges rbush for the layer above it: this is rbush at its best.

import { allocPerOp, timePerOp, retainedBytes } from '../lib/measure.mjs'
import { makeBoxes, makeQueries, makeElements, permutation } from '../lib/data.mjs'

const arg = (k, d) => {
	const hit = process.argv.find((a) => a.startsWith('--' + k + '='))
	return hit ? hit.slice(k.length + 3) : d
}

const ENGINE = arg('engine', 'flat')
const DATA = arg('data', 'board')
const N = +arg('n', 20000)
const OP = arg('op', 'search')
const FRAC = +arg('frac', 0.01)
const MEASURE = arg('measure', 'alloc')
const SEED = +arg('seed', 1)

const ds = makeBoxes(DATA, N, SEED)
const { boxes } = ds
const perm = permutation(N, SEED + 100)

// ── engine adapters ────────────────────────────────────────────────────────
// Deliberately NOT a shared interface object: each branch builds its own
// closures so the driver's call sites see one receiver shape only.

const RBush = ENGINE === 'rbush' ? (await import('rbush')).default : null
const FlatRTree = ENGINE === 'flat' ? (await import('../lib/flatrtree.mjs')).FlatRTree : null

const els = ENGINE === 'rbush' ? makeElements(ds) : null
// Flat's bulk-load inputs, built once outside every window.
const ids = new Uint32Array(N)
for (let i = 0; i < N; i++) ids[i] = i

function buildFull() {
	if (ENGINE === 'rbush') {
		const t = new RBush()
		// Bulk load wants its own array; rbush mutates the one it is given.
		t.load(els.slice())
		return t
	}
	const t = new FlatRTree()
	t.load(N, ids, boxes)
	return t
}

function buildEmpty() {
	return ENGINE === 'rbush' ? new RBush() : new FlatRTree()
}

// A live copy of every box, so both engines are driven by the same numbers.
const cur = new Float64Array(boxes)
function resetCur() {
	cur.set(boxes)
	if (ENGINE === 'rbush') {
		for (let i = 0; i < N; i++) {
			const j = i << 2
			const e = els[i]
			e.minX = boxes[j]
			e.minY = boxes[j + 1]
			e.maxX = boxes[j + 2]
			e.maxY = boxes[j + 3]
		}
	}
}

// Kept inside int32 on purpose: an accumulator that leaves smi range mints a
// 16-byte HeapNumber per iteration, which shows up as the engine's allocation.
// That artifact alone accounted for the whole of flat's apparent search cost.
let sink = 0

// ── bodies ─────────────────────────────────────────────────────────────────

const QCOUNT = 512
const queries = makeQueries(ds, QCOUNT, FRAC, SEED + 200)

function makeSearchBody() {
	const tree = buildFull()
	if (ENGINE === 'rbush') {
		const qo = { minX: 0, minY: 0, maxX: 0, maxY: 0 }
		return (i) => {
			const j = (i % QCOUNT) << 2
			qo.minX = queries[j]
			qo.minY = queries[j + 1]
			qo.maxX = queries[j + 2]
			qo.maxY = queries[j + 3]
			const r = tree.search(qo)
			let s = 0
			for (let k = 0; k < r.length; k++) s = (s + r[k].id) | 0
			sink = (sink + s) | 0
		}
	}
	return (i) => {
		const j = (i % QCOUNT) << 2
		const cnt = tree.search(queries[j], queries[j + 1], queries[j + 2], queries[j + 3])
		const res = tree.results
		let s = 0
		for (let k = 0; k < cnt; k++) s = (s + res[k]) | 0
		sink = (sink + s) | 0
	}
}

function makeInsertBody() {
	const tree = buildEmpty()
	if (ENGINE === 'rbush') return (i) => tree.insert(els[i % N])
	return (i) => {
		const k = i % N
		const j = k << 2
		tree.insert(k, boxes[j], boxes[j + 1], boxes[j + 2], boxes[j + 3])
	}
}

// Sustained directional travel, the way a real drag moves a shape -- not a
// jitter around a fixed point, which parks every update in the O(1) tier and
// is how the earlier round of this work inflated its own numbers.
const STEP = +arg('step', 8)

// Direction reverses every 60 passes, so a shape travels 60 ticks' worth and
// comes back -- a gesture, not an unbounded drift that would eventually shred
// the tree into a shape no real document has.
const CYCLE = N * 60
const dirAt = (i) => (((i / CYCLE) | 0) % 2 ? -STEP : STEP)

// Pool growth in a structure-of-arrays tree is bursty and one-time: the arrays
// double once and then never again for that document. Measured over a short
// window from a cold tree it looks like a large per-op cost; measured over a
// long one it vanishes. Neither is the number an app sees, so the tree is
// settled first and the window reports STEADY STATE. The one-time growth is
// reported separately, as retained size.
const SETTLE = Math.min(N * 4, 120000)

function makeUpdateBody() {
	const tree = buildFull()
	resetCur()
	if (ENGINE === 'rbush') {
		const step = (i) => {
			const id = perm[i % N]
			const e = els[id]
			tree.remove(e)
			const j = id << 2
			const d = dirAt(i)
			cur[j] += d
			cur[j + 1] += d
			cur[j + 2] += d
			cur[j + 3] += d
			e.minX = cur[j]
			e.minY = cur[j + 1]
			e.maxX = cur[j + 2]
			e.maxY = cur[j + 3]
			tree.insert(e)
		}
		for (let i = 0; i < SETTLE; i++) step(i)
		return (i) => step(i + SETTLE)
	}
	const step = (i) => {
		const id = perm[i % N]
		const j = id << 2
		const d = dirAt(i)
		cur[j] += d
		cur[j + 1] += d
		cur[j + 2] += d
		cur[j + 3] += d
		tree.update(id, cur[j], cur[j + 1], cur[j + 2], cur[j + 3])
	}
	for (let i = 0; i < SETTLE; i++) step(i)
	return (i) => step(i + SETTLE)
}

function makeRemoveBody() {
	const tree = buildFull()
	if (ENGINE === 'rbush') return (i) => tree.remove(els[perm[i % N]])
	return (i) => tree.remove(perm[i % N])
}

function makeLoadBody() {
	if (ENGINE === 'rbush') {
		return () => {
			const t = new RBush()
			t.load(els.slice())
			sink = (sink + t.data.height) | 0
		}
	}
	return () => {
		const t = new FlatRTree()
		t.load(N, ids, boxes)
		sink = (sink + t.getSize()) | 0
	}
}

const BODIES = {
	search: makeSearchBody,
	insert: makeInsertBody,
	update: makeUpdateBody,
	remove: makeRemoveBody,
	load: makeLoadBody,
}

// ── run ────────────────────────────────────────────────────────────────────

const out = { engine: ENGINE, data: DATA, n: N, op: OP, frac: FRAC, step: STEP, measure: MEASURE }

if (OP === 'search') {
	// Report the actual hit count so a reader can see what the query cost bought.
	const t = buildFull()
	let hits = 0
	for (let i = 0; i < QCOUNT; i++) {
		const j = i << 2
		hits +=
			ENGINE === 'rbush'
				? t.search({ minX: queries[j], minY: queries[j + 1], maxX: queries[j + 2], maxY: queries[j + 3] }).length
				: t.search(queries[j], queries[j + 1], queries[j + 2], queries[j + 3])
	}
	out.avgHits = hits / QCOUNT
}

const make = BODIES[OP]
// Stateful ops must not run past the data they own: insert would duplicate ids
// and remove would drain the tree and start removing absentees.
const nMax = OP === 'search' ? 400000 : OP === 'load' ? 64 : OP === 'remove' ? Math.max(1, N >> 3) : N
const CHECK = OP === 'search' || OP === 'load' ? 'linear' : 'repeat'

if (MEASURE === 'alloc') {
	const r = await allocPerOp(make, nMax, 0.08, CHECK)
	out.bytesPerOp = r.bytes
	out.bytesHeap = r.heap
	out.bytesArrayBuffer = r.ab
	out.allocSmall = r.small
	out.allocLarge = r.large
	out.linear = r.linear
	out.checkMode = r.mode
	out.n1 = r.n1
	out.n2 = r.n2
	out.windows = r.windows
	out.fixedBytes = r.fixed
	out.reason = r.reason
} else if (MEASURE === 'time') {
	const n = OP === 'load' ? 20 : Math.min(nMax, OP === 'search' ? 20000 : N)
	const r = timePerOp(make, n, OP === 'load' ? 9 : 7, 2)
	out.nsPerOp = r.ns
	out.nsMedian = r.median
	out.timeN = n
} else if (MEASURE === 'retained') {
	// Everything the engine needs in order to answer, built inside the window.
	// For rbush that includes the element objects: it stores references, not
	// boxes, so the caller must keep one live object per item for the tree to
	// mean anything. Leaving them out of the window (they are normally minted
	// during setup) would charge rbush for its internal nodes only and hide
	// two thirds of what it actually costs to have the index in memory.
	const buildWithPayload =
		ENGINE === 'rbush'
			? () => {
					const e2 = makeElements(ds)
					const t = new RBush()
					t.load(e2.slice())
					return { t, e2 }
				}
			: () => {
					const t = new FlatRTree()
					t.load(N, ids, boxes)
					return t
				}
	const r = await retainedBytes(buildWithPayload)
	out.retainedBytes = r.retained
	out.retainedPerItem = r.retained / N
	out.retainedNote = ENGINE === 'rbush' ? 'nodes + element objects' : 'typed arrays'
	out.released = r.released
}

out.sink = sink
console.log('###JSON###' + JSON.stringify(out))
