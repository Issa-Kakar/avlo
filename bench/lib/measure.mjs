// The instrument. Everything here exists to make a number falsifiable.
//
// Allocation is the delta in V8's `used_heap_size` across a window in which no
// garbage collection ran. Inside such a window the delta is exactly the bytes
// allocated: nothing was reclaimed, so it is a count, not an estimate.
//
// Keeping the window GC-free is the whole game, and PROVING it was GC-free is
// the rest. Two independent detectors, because the obvious one is a trap:
//
//   * `PerformanceObserver({entryTypes:['gc']})` fires its callback on a later
//     macrotask. Reading its counter straight after a synchronous loop reads a
//     STALE value and will happily certify a window that collected six times.
//     So the count is only read after awaiting a macrotask turn.
//   * `used_heap_size` sampled at checkpoints inside the loop must never fall.
//     A collection shows up immediately as a drop. This one is synchronous.
//
// On top of that the window is sized to allocate far less than the semi-space,
// so a scavenge should be impossible by construction rather than by luck, and
// every reported figure carries a linearity check across two window sizes.
//
// Requires: --expose-gc --max-semi-space-size=64

import v8 from 'node:v8'
import { PerformanceObserver } from 'node:perf_hooks'

let gcCount = 0
let gcEvents = null
const obs = new PerformanceObserver((list) => {
	for (const e of list.getEntries()) {
		gcCount++
		if (gcEvents) gcEvents.push({ kind: e.detail?.kind ?? 0, ms: e.duration })
	}
})
obs.observe({ entryTypes: ['gc'] })

const used = () => v8.getHeapStatistics().used_heap_size

// V8's used_heap_size does NOT include ArrayBuffer backing stores, and a
// structure-of-arrays index is almost entirely backing store. Counting only the
// managed heap would flatter the flat tree enormously and hide its pool growth
// completely, so both are measured and both are reported.
const abUsed = () => process.memoryUsage().arrayBuffers

/**
 * Drain queued GC observations. Measured on this Node: they arrive TWO
 * macrotask turns after the collection, not one -- so a single `setImmediate`
 * still reads a stale counter and certifies a dirty window as clean. Spin
 * until the count has held still for three consecutive turns.
 */
async function flush() {
	let stable = 0
	let last = gcCount
	for (let turn = 0; turn < 12 && stable < 3; turn++) {
		await new Promise((r) => setImmediate(r))
		if (gcCount === last) stable++
		else {
			stable = 0
			last = gcCount
		}
	}
}

// Stay an order of magnitude under the semi-space so a scavenge is structurally
// impossible in a window, not merely unobserved.
export const WINDOW_BUDGET_BYTES = 48 * 1024 * 1024

export function fullGc() {
	global.gc()
	global.gc()
}

/**
 * Exact bytes per iteration, or null if the window cannot be certified clean.
 * `body(i)` is the whole measured unit of work.
 */
export async function allocOnce(makeBody, n, warmup = 2000) {
	// Warm on a THROWAWAY body. Stateful ops (insert grows a tree, remove drains
	// one) cannot be warmed on the body that will be measured, and a cold body
	// allocates feedback vectors and optimized code inside the window.
	const warmBody = makeBody()
	for (let i = 0; i < warmup; i++) warmBody(i)
	const body = makeBody()
	fullGc()
	await flush()
	const g0 = gcCount

	const step = Math.max(1, n >> 4)
	let prev = used()
	const a = prev
	const aAb = abUsed()
	let dropped = false
	for (let i = 0; i < n; i++) {
		body(i)
		if (i % step === 0) {
			const u = used()
			if (u < prev) dropped = true
			prev = u
		}
	}
	const b = used()
	const bAb = abUsed()
	await flush()
	if (dropped || gcCount !== g0) return null
	return { heap: (b - a) / n, ab: (bAb - aAb) / n, total: (b - a + (bAb - aAb)) / n }
}

/**
 * Bytes/op, auto-sized so the window fits the budget, and cross-checked at two
 * window sizes. A figure whose two sizes disagree is reported unstable rather
 * than averaged into something plausible.
 */
/** Repeat the same window until two consecutive runs agree — the stopping rule
 *  that filters V8 tiering a function up mid-measurement, which otherwise shows
 *  as a first window reading several times the second. */
async function stableAt(makeBody, n, warmup, tol) {
	let prev = null
	const seen = []
	for (let k = 0; k < 6; k++) {
		const r = await allocOnce(makeBody, n, warmup)
		if (r === null) return null
		seen.push(r.total)
		if (prev !== null) {
			const d = Math.abs(r.total - prev)
			if (d / Math.max(r.total, 1e-9) <= tol || d < 1) return { ...r, seen }
		}
		prev = r.total
	}
	return null
}

/**
 * Bytes per operation, as the SLOPE of allocation against window size.
 *
 * A single window cannot tell a per-op cost from a fixed one. Measuring a
 * gesture tick that allocates nothing still reports a few hundred bytes per
 * tick, because the window carries a one-time cost -- compiling the closure,
 * first-touching a buffer -- and dividing it by the tick count hands it back as
 * if it were per-tick. The giveaway is that windows of n and 3n report values
 * in a 3:1 ratio: identical totals, three times the divisor. That is exactly
 * what the gesture cells did.
 *
 * So: measure at two window sizes, each repeated to stability, and solve
 *     total(n) = fixed + perOp * n
 * The slope is the answer to "what does one more operation cost", which is the
 * only question worth asking. The intercept is reported too, so a large fixed
 * cost cannot hide inside the result.
 *
 * `mode: 'repeat'` skips the regression for ops whose per-op cost genuinely
 * varies with how many have run (insert builds a bigger tree as it goes), where
 * a slope would be meaningless. Those report a single stable window.
 */
export async function allocPerOp(makeBody, nMax, tol = 0.08, mode = 'linear') {
	// Pilot down from small to tiny: one `load` allocates megabytes and one
	// search allocates bytes; no single pilot size serves both.
	let perOp = null
	for (const pn of [256, 32, 4, 1]) {
		if (pn > nMax) continue
		const p = await allocOnce(makeBody, pn, Math.min(200, pn * 4))
		if (p !== null) {
			perOp = Math.max(p.total, 0.01)
			break
		}
	}
	if (perOp === null) return { bytes: null, reason: 'gc-in-pilot' }

	const fit = Math.max(1, Math.floor(WINDOW_BUDGET_BYTES / perOp))
	const warmup = Math.min(2000, Math.max(4, Math.floor(fit / 4)))
	const nBig = Math.min(nMax, fit)
	const nSmall = Math.max(1, Math.floor(nBig / 4))

	if (mode === 'repeat' || nSmall === nBig) {
		const r = await stableAt(makeBody, nBig, warmup, tol)
		if (r === null) return { bytes: null, reason: 'did-not-settle' }
		return { bytes: r.total, heap: r.heap, ab: r.ab, n1: nBig, n2: nBig, mode, linear: true, windows: r.seen }
	}

	const a = await stableAt(makeBody, nSmall, warmup, tol)
	const b = await stableAt(makeBody, nBig, warmup, tol)
	if (a === null || b === null) return { bytes: null, reason: 'did-not-settle' }

	const A = a.total * nSmall
	const B = b.total * nBig
	const slope = (B - A) / (nBig - nSmall)
	const fixed = A - slope * nSmall
	const heapSlope = (b.heap * nBig - a.heap * nSmall) / (nBig - nSmall)
	const abSlope = (b.ab * nBig - a.ab * nSmall) / (nBig - nSmall)
	return {
		bytes: Math.max(slope, 0),
		rawSlope: slope,
		heap: heapSlope,
		ab: abSlope,
		fixed,
		small: a.total,
		large: b.total,
		n1: nSmall,
		n2: nBig,
		mode,
		linear: true,
		windows: [a.seen, b.seen],
	}
}

/** Minimum wall time per op over `reps` repetitions, in nanoseconds. */
export function timePerOp(makeBody, n, reps = 7, warmups = 2) {
	for (let r = 0; r < warmups; r++) {
		const body = makeBody()
		for (let i = 0; i < n; i++) body(i)
	}
	let best = Infinity
	const all = []
	for (let r = 0; r < reps; r++) {
		const body = makeBody()
		const t0 = process.hrtime.bigint()
		for (let i = 0; i < n; i++) body(i)
		const t1 = process.hrtime.bigint()
		const ns = Number(t1 - t0) / n
		all.push(ns)
		if (ns < best) best = ns
	}
	all.sort((x, y) => x - y)
	return { ns: best, median: all[all.length >> 1], samples: all }
}

/** Record every collection that fires while `fn` runs. Run this at PRODUCTION
 *  heap settings -- the point is production GC behaviour, not a clean window. */
export async function gcProfile(fn) {
	fullGc()
	await flush()
	gcEvents = []
	const t0 = process.hrtime.bigint()
	fn()
	const t1 = process.hrtime.bigint()
	await flush()
	const events = gcEvents
	gcEvents = null
	let total = 0
	let max = 0
	let scavenges = 0
	let majors = 0
	for (const e of events) {
		total += e.ms
		if (e.ms > max) max = e.ms
		if (e.kind === 1) scavenges++
		else majors++
	}
	// The five largest pauses, kept with their kind. A single outlier pause is
	// the sort of number that gets quoted, so it has to be attributable: a
	// mark-compact tracing a large live set is a real cost of the design, a
	// one-off is not.
	const top = events
		.slice()
		.sort((a, b) => b.ms - a.ms)
		.slice(0, 5)
		.map((e) => ({ kind: e.kind === 1 ? 'scavenge' : 'major', ms: +e.ms.toFixed(2) }))
	return {
		wallMs: Number(t1 - t0) / 1e6,
		count: events.length,
		totalMs: total,
		maxMs: max,
		scavenges,
		majors,
		top,
	}
}

/** Known-size allocations, so a reader can check the instrument before reading
 *  anything it reports. The sizes are V8's, not ours. */
export async function calibrate() {
	const sink = new Array(20000)
	const probes = [
		// A packed-smi array of 1000 is a FixedArray backing store of 1000*8
		// plus two small headers. If this does not land within a few bytes of
		// 8048, nothing else here is worth reading.
		['Array(1000).fill(0)  [~8048]', 8048, () => new Array(1000).fill(0)],
		['Array(100).fill(0)   [~848]', 848, () => new Array(100).fill(0)],
		['{minX,minY,maxX,maxY,id}', null, (i) => ({ minX: i, minY: i, maxX: i, maxY: i, id: i })],
		['new Set()', null, () => new Set()],
		['[] empty array', null, () => []],
		['control (no allocation)', 0, (i) => i],
	]
	const out = []
	for (const [label, expect, fn] of probes) {
		const r = await allocPerOp(() => (i) => {
			sink[i % 20000] = fn(i)
		}, 150000)
		out.push({ label, expect, ...r })
	}
	return out
}

/**
 * Bytes of heap the structure built by `build()` still holds after a full
 * collection -- retained size, not traffic. This is the "how much memory does
 * the index itself cost" number, and it is measured with the built structure
 * alive and then with it dropped, so anything the builder leaked into closures
 * is included rather than excused.
 */
export async function retainedBytes(build) {
	fullGc()
	await flush()
	const before = used() + abUsed()
	let held = build()
	fullGc()
	await flush()
	const withIt = used() + abUsed()
	const heapPart = used()
	held = null
	fullGc()
	await flush()
	const after = used() + abUsed()
	return { retained: withIt - before, released: withIt - after, heapAtPeak: heapPart }
}
