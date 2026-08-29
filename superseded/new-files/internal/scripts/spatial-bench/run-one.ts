/**
 * Runs the whole suite for ONE implementation and prints a JSON line.
 *
 * One implementation per process, on purpose. Loading both behind a shared
 * interface would make every call site in here polymorphic and turn the
 * measurement into a study of V8's inline caches. It also keeps each side's
 * heap and JIT state to itself, so a cold bulk load is genuinely cold.
 *
 * Usage: tsx run-one.ts --impl rbush|flat --dataset uniform|board --n 100000 --seed 1
 */
import type { TLShapeId } from '@tldraw/tlschema'
import { makeAdapter } from './adapters'
import { makeDataset, makeProbePoints, makeRandom, makeSearchRects } from './data'

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`)
	return i === -1 ? fallback : process.argv[i + 1]
}

const impl = arg('impl', 'flat')
const datasetKind = arg('dataset', 'board')
const n = Number(arg('n', '100000'))
const seed = Number(arg('seed', '1'))

/** Median and best of `reps` timed runs of `fn`, in nanoseconds. */
function measure(reps: number, fn: () => void): { median: number; best: number } {
	const times: number[] = []
	for (let r = 0; r < reps; r++) {
		const t0 = process.hrtime.bigint()
		fn()
		times.push(Number(process.hrtime.bigint() - t0))
	}
	times.sort((a, b) => a - b)
	return { median: times[times.length >> 1], best: times[0] }
}

function heapUsed(): number {
	if (typeof global.gc === 'function') {
		for (let i = 0; i < 4; i++) global.gc!()
	}
	return process.memoryUsage().heapUsed
}

async function main() {
	const data = makeDataset(datasetKind, n, seed)
	const ids: TLShapeId[] = new Array(n)
	for (let i = 0; i < n; i++) ids[i] = `shape:bench_${i}` as TLShapeId

	const results: Record<string, any> = { impl, dataset: datasetKind, n, seed }
	const adapter = await makeAdapter(impl)

	// ── bulk load ───────────────────────────────────────────────────────────
	// The first one is the only genuinely cold measurement this process can
	// make: nothing in the loader has been compiled above the interpreter yet,
	// which is exactly the state a page load hits it in.
	const baselineHeap = heapUsed()
	{
		const t0 = process.hrtime.bigint()
		adapter.bulkLoad(n, ids, data.boxes)
		results.loadCold = Number(process.hrtime.bigint() - t0)
	}
	results.heapAfterLoad = heapUsed() - baselineHeap
	results.sizeAfterLoad = adapter.getSize()

	{
		// Enough repetitions that a small page is not measured entirely inside
		// JIT warm-up: at n=1000 a single load is barely a millisecond.
		const reps = Math.max(5, Math.min(200, Math.round(2_000_000 / n)))
		const m = measure(reps, () => {
			adapter.clear()
			adapter.bulkLoad(n, ids, data.boxes)
		})
		results.loadWarm = m.median
		results.loadWarmBest = m.best
		results.loadWarmReps = reps
	}

	// ── searches ────────────────────────────────────────────────────────────
	// Three rect sizes standing in for three camera positions: a normal 100%
	// viewport, one zoomed out about 10x, and a fit-to-page. Reported per
	// search along with how many shapes each returned, because a search that
	// returns nothing and a search that returns 20k are different questions.
	const SEARCHES = 2000
	for (const [label, fraction] of [
		['searchViewport', 0.0001],
		['searchZoomedOut', 0.01],
		['searchWide', 0.1],
	] as const) {
		const rects = makeSearchRects(data, SEARCHES, fraction, seed + 7)
		let hits = 0
		// warm up
		for (let i = 0; i < 200; i++) {
			const b = (i % SEARCHES) * 4
			adapter.searchCount(rects[b], rects[b + 1], rects[b + 2], rects[b + 3])
		}
		const m = measure(5, () => {
			hits = 0
			for (let i = 0; i < SEARCHES; i++) {
				const b = i * 4
				hits += adapter.searchCount(rects[b], rects[b + 1], rects[b + 2], rects[b + 3])
			}
		})
		results[label] = m.median / SEARCHES
		results[`${label}Hits`] = hits / SEARCHES

		// The same searches, materialized as the `Set<TLShapeId>` that
		// `Editor.getShapeIdsInsideBounds` returns.
		const ms = measure(5, () => {
			for (let i = 0; i < SEARCHES; i++) {
				const b = i * 4
				adapter.searchToSet(rects[b], rects[b + 1], rects[b + 2], rects[b + 3])
			}
		})
		results[`${label}ToSet`] = ms.median / SEARCHES
	}

	// ── point probes (hit testing) ──────────────────────────────────────────
	{
		const PROBES = 20000
		const points = makeProbePoints(data, PROBES, seed + 11)
		const margin = datasetKind === 'uniform' ? 0.05 : 8
		let hits = 0
		for (let i = 0; i < 500; i++) {
			const b = (i % PROBES) * 2
			adapter.probePoint(points[b], points[b + 1], margin)
		}
		const m = measure(5, () => {
			hits = 0
			for (let i = 0; i < PROBES; i++) {
				const b = i * 2
				hits += adapter.probePoint(points[b], points[b + 1], margin)
			}
		})
		results.searchPoint = m.median / PROBES
		results.searchPointHits = hits / PROBES
	}

	// ── the shape a cull actually has ───────────────────────────────────────
	// Search a viewport, then ask membership for a page's worth of ids — what
	// notVisibleShapes and the brush/eraser hit tests do with the result.
	{
		const PROBE_IDS = Math.min(n, 20000)
		const probes = ids.slice(0, PROBE_IDS)
		const rects = makeSearchRects(data, 200, 0.01, seed + 13)
		for (let i = 0; i < 20; i++) {
			const b = (i % 200) * 4
			adapter.searchThenProbe(rects[b], rects[b + 1], rects[b + 2], rects[b + 3], probes)
		}
		let hits = 0
		const m = measure(5, () => {
			hits = 0
			for (let i = 0; i < 200; i++) {
				const b = i * 4
				hits += adapter.searchThenProbe(rects[b], rects[b + 1], rects[b + 2], rects[b + 3], probes)
			}
		})
		results.cullShaped = m.median / 200
		results.cullShapedProbes = PROBE_IDS
		results.cullShapedHits = hits / 200
	}

	// ── incremental mutation ────────────────────────────────────────────────
	// Dragging. tldraw writes shape records on every pointer move and the index
	// re-upserts each moved shape, so a 2 second drag of a selection is
	// ~120 frames x |selection| upserts, each a small delta.
	// A pointer move of about 3% of a shape's own width, which is what a drag
	// looks like frame to frame. Scaled to the dataset: the same absolute delta
	// would be a drag on a whiteboard and a teleport across rbush's 100x100
	// uniform world.
	let meanW = 0
	let meanH = 0
	for (let i = 0; i < n; i++) {
		meanW += data.boxes[i * 4 + 2] - data.boxes[i * 4]
		meanH += data.boxes[i * 4 + 3] - data.boxes[i * 4 + 1]
	}
	meanW = (meanW / n) * 0.03
	meanH = (meanH / n) * 0.03
	results.dragStepX = meanW
	for (const dragged of [1, 20, 200]) {
		if (dragged > n) continue
		const FRAMES = 120
		const random = makeRandom(seed + 17)
		const picks = new Int32Array(dragged)
		for (let i = 0; i < dragged; i++) picks[i] = (random() * n) | 0
		const work = new Float64Array(dragged * 4)
		for (let i = 0; i < dragged; i++) {
			const s = picks[i] * 4
			work[i * 4] = data.boxes[s]
			work[i * 4 + 1] = data.boxes[s + 1]
			work[i * 4 + 2] = data.boxes[s + 2]
			work[i * 4 + 3] = data.boxes[s + 3]
		}
		// warm up outside the timer
		for (let f = 0; f < 20; f++) {
			for (let i = 0; i < dragged; i++) {
				const b = i * 4
				adapter.upsert(ids[picks[i]], work[b], work[b + 1], work[b + 2], work[b + 3])
			}
		}
		const m = measure(5, () => {
			for (let f = 0; f < FRAMES; f++) {
				for (let i = 0; i < dragged; i++) {
					const b = i * 4
					work[b] += meanW
					work[b + 1] += meanH
					work[b + 2] += meanW
					work[b + 3] += meanH
					adapter.upsert(ids[picks[i]], work[b], work[b + 1], work[b + 2], work[b + 3])
				}
			}
			// walk back so repeated reps start from the same neighbourhood
			for (let i = 0; i < dragged; i++) {
				const b = i * 4
				work[b] -= meanW * FRAMES
				work[b + 1] -= meanH * FRAMES
				work[b + 2] -= meanW * FRAMES
				work[b + 3] -= meanH * FRAMES
			}
		})
		results[`drag${dragged}`] = m.median / (FRAMES * dragged)
		results[`drag${dragged}PerFrame`] = m.median / FRAMES
	}

	// Teleports: a shape jumping clear of its cluster, which is the case that
	// has to relocate in the tree rather than settle in place.
	{
		const COUNT = 2000
		const random = makeRandom(seed + 19)
		const picks = new Int32Array(COUNT)
		const dest = new Float64Array(COUNT * 2)
		const { world } = data
		for (let i = 0; i < COUNT; i++) {
			picks[i] = (random() * n) | 0
			dest[i * 2] = world.minX + random() * (world.maxX - world.minX)
			dest[i * 2 + 1] = world.minY + random() * (world.maxY - world.minY)
		}
		const m = measure(3, () => {
			for (let i = 0; i < COUNT; i++) {
				const s = picks[i] * 4
				const w = data.boxes[s + 2] - data.boxes[s]
				const h = data.boxes[s + 3] - data.boxes[s + 1]
				adapter.upsert(
					ids[picks[i]],
					dest[i * 2],
					dest[i * 2 + 1],
					dest[i * 2] + w,
					dest[i * 2 + 1] + h
				)
			}
		})
		results.teleport = m.median / COUNT
	}

	// ── build by insertion, then tear down ──────────────────────────────────
	{
		const INS = Math.min(n, 100000)
		const insertReps = Math.max(3, Math.min(60, Math.round(600_000 / INS)))
		const insertTimes: number[] = []
		for (let r = 0; r < insertReps; r++) {
			adapter.clear()
			const t0 = process.hrtime.bigint()
			for (let i = 0; i < INS; i++) {
				const b = i * 4
				adapter.upsert(
					ids[i],
					data.boxes[b],
					data.boxes[b + 1],
					data.boxes[b + 2],
					data.boxes[b + 3]
				)
			}
			insertTimes.push(Number(process.hrtime.bigint() - t0))
		}
		insertTimes.sort((a, b) => a - b)
		results.insert = insertTimes[insertTimes.length >> 1] / INS

		const random = makeRandom(seed + 23)
		const order = new Int32Array(INS)
		for (let i = 0; i < INS; i++) order[i] = i
		for (let i = INS - 1; i > 0; i--) {
			const j = (random() * (i + 1)) | 0
			const t = order[i]
			order[i] = order[j]
			order[j] = t
		}
		const removeTimes: number[] = []
		for (let r = 0; r < insertReps; r++) {
			// rebuilt outside the timer so every pass removes a full, packed tree
			adapter.clear()
			adapter.bulkLoad(INS, ids, data.boxes)
			const t0 = process.hrtime.bigint()
			for (let i = 0; i < INS; i++) adapter.remove(ids[order[i]])
			removeTimes.push(Number(process.hrtime.bigint() - t0))
		}
		removeTimes.sort((a, b) => a - b)
		results.remove = removeTimes[removeTimes.length >> 1] / INS
	}

	results.ok = true
	process.stdout.write(JSON.stringify(results) + '\n')
}

main().catch((err) => {
	process.stdout.write(
		JSON.stringify({ impl, dataset: datasetKind, n, error: String(err && err.stack) }) + '\n'
	)
	process.exit(1)
})
