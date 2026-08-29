import { writeFileSync } from 'fs'
import { Box, PageRecordType, TLShapeId, createShapeId } from '@tldraw/editor'
import { describe, it } from 'vitest'
import { TestEditor } from './TestEditor'

/**
 * End-to-end timings for the paths the spatial index actually sits on: the
 * viewport cull that runs whenever the camera moves, the index churn a drag
 * produces, and hit testing.
 *
 * Opt-in — this is a measurement, not an assertion:
 *
 *   SPATIAL_PERF=1 yarn vitest run src/test/spatialIndexPerf.test.ts
 *
 * Set SPATIAL_PERF_N to change the page size and SPATIAL_PERF_OUT to write the
 * table to a file as well as the console.
 *
 * It uses only public `Editor` API, so the same file runs unchanged against any
 * index implementation and the two runs can be compared directly.
 */

const ENABLED = !!process.env.SPATIAL_PERF
const SHAPE_COUNT = Number(process.env.SPATIAL_PERF_N ?? 20000)

function makeRandom(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const rows: {
	label: string
	total: number
	count: number
	note?: string
	bytes?: number
}[] = []

// Bytes allocated during a measured block.
//
// Wall time on a shared machine hides allocation churn behind noise, and
// allocation is what turns into a dropped frame rather than a slower average.
// Run the suite with a young generation big enough that nothing is collected
// mid-measurement and the heap delta is exactly what the block allocated:
//
//   NODE_OPTIONS="--max-semi-space-size=512" SPATIAL_PERF=1 yarn vitest run ...
//
// Without that flag the numbers still compare like for like, they are just
// lower bounds — a scavenge inside the window gives some of the bytes back.
function record(label: string, totalNs: number, count: number, note?: string) {
	rows.push({ label, total: totalNs, count, note })
}

/** Time `fn` and report what it allocated. */
function timeWithAlloc(label: string, count: number, fn: () => void, note?: string) {
	const before = process.memoryUsage().heapUsed
	const total = time(fn)
	const bytes = process.memoryUsage().heapUsed - before
	rows.push({ label, total, count, note, bytes })
}

function report() {
	const lines = [`=== in-app spatial timings, ${SHAPE_COUNT.toLocaleString()} shapes ===`]
	for (const r of rows) {
		const per = r.total / r.count / 1e6
		const alloc =
			r.bytes === undefined ? '' : `  ${(r.bytes / r.count / 1024).toFixed(1).padStart(8)} KB/op`
		lines.push(
			`${r.label.padEnd(42)}${per.toFixed(4).padStart(10)} ms/op${alloc}  ${(r.total / 1e6)
				.toFixed(1)
				.padStart(8)} ms total${r.note ? `   (${r.note})` : ''}`
		)
	}
	const text = lines.join('\n')
	// eslint-disable-next-line no-console
	console.log(`\n${text}\n`)
	const out = process.env.SPATIAL_PERF_OUT
	if (out) writeFileSync(out, `${text}\n`)
}

function time(fn: () => void): number {
	const t0 = process.hrtime.bigint()
	fn()
	return Number(process.hrtime.bigint() - t0)
}

describe.runIf(ENABLED)('spatial index, in the editor', () => {
	it('measures cull, drag and hit test', { timeout: 900_000 }, () => {
		const random = makeRandom(7)
		// The default page cap is 4,000 shapes; these runs deliberately go past it.
		const editor = new TestEditor({ options: { maxShapesPerPage: 1_000_000 } })
		editor.updateViewportScreenBounds(new Box(0, 0, 1600, 1000))

		// A board-shaped page: shapes bunched into working areas rather than
		// sprinkled evenly, which is what culling and hit testing actually meet.
		const side = Math.sqrt(SHAPE_COUNT) * 400
		const clusterCount = Math.max(1, Math.round(SHAPE_COUNT / 400))
		const cx: number[] = []
		const cy: number[] = []
		for (let i = 0; i < clusterCount; i++) {
			cx.push(random() * side)
			cy.push(random() * side)
		}
		const ids: TLShapeId[] = []
		const partials: any[] = []
		for (let i = 0; i < SHAPE_COUNT; i++) {
			const c = (random() * clusterCount) | 0
			const id = createShapeId(`perf${i}`)
			ids.push(id)
			partials.push({
				id,
				type: 'geo',
				x: cx[c] + (random() - 0.5) * 2800,
				y: cy[c] + (random() - 0.5) * 2800,
				props: { w: 60 + random() * 240, h: 50 + random() * 200 },
			})
		}

		const createNs = time(() => {
			editor.run(() => {
				for (let i = 0; i < partials.length; i += 2000) {
					editor.createShapes(partials.slice(i, i + 2000))
				}
			})
		})
		record('setup: createShapes (not the index)', createNs, 1)

		// ── first cull: builds the index from scratch ───────────────────────
		editor.setCamera({ x: 0, y: 0, z: 1 })
		const firstCullNs = time(() => {
			editor.getCulledShapes()
		})
		record('first cull (index built from scratch)', firstCullNs, 1)

		// ── camera moves ────────────────────────────────────────────────────
		// The cull recomputes on every camera change, so this is the per-frame
		// cost of panning around a page this size. Camera positions are drawn
		// from the working areas rather than uniformly over the board, because
		// that is where a user actually parks it.
		const fitZoom = Math.min(1600 / side, 1000 / side)
		for (const [label, zoom] of [
			['cull @ 100% zoom', 1],
			['cull @ 25% zoom', 0.25],
			['cull @ 10% zoom', 0.1],
			['cull @ zoom to fit', fitZoom],
		] as const) {
			const FRAMES = 120
			const place = () => {
				const c = (random() * clusterCount) | 0
				editor.setCamera({
					x: -(cx[c] + (random() - 0.5) * 2000) + 800 / zoom,
					y: -(cy[c] + (random() - 0.5) * 2000) + 500 / zoom,
					z: zoom,
				})
			}
			for (let f = 0; f < 20; f++) {
				place()
				editor.getCulledShapes()
			}
			let sum = 0
			timeWithAlloc(
				label,
				FRAMES,
				() => {
					for (let f = 0; f < FRAMES; f++) {
						place()
						sum += editor.getCulledShapes().size
					}
				},
				`~${SHAPE_COUNT - Math.round(sum / FRAMES)} shapes on screen`
			)
			rows[rows.length - 1].note = `~${SHAPE_COUNT - Math.round(sum / FRAMES)} shapes on screen`
		}

		// ── dragging ────────────────────────────────────────────────────────
		// A drag writes shape records on every pointer move; the index has to
		// take each moved shape (and reads of the cull force it to settle).
		editor.setCamera({ x: 0, y: 0, z: 1 })
		editor.getCulledShapes()
		for (const selection of [1, 20, 200]) {
			if (selection > SHAPE_COUNT) continue
			const FRAMES = 60
			const picks: TLShapeId[] = []
			while (picks.length < selection) {
				const id = ids[(random() * SHAPE_COUNT) | 0]
				if (editor.getShape(id)) picks.push(id)
			}
			const move = (dx: number, dy: number) => {
				editor.run(() => {
					editor.updateShapes(
						picks.map((id) => {
							const s = editor.getShape(id)!
							return { id, type: s.type, x: (s as any).x + dx, y: (s as any).y + dy }
						})
					)
				})
				editor.getCulledShapes()
			}
			for (let f = 0; f < 10; f++) move(1, 1)
			timeWithAlloc(`drag ${selection} shape(s), per frame`, FRAMES, () => {
				for (let f = 0; f < FRAMES; f++) move(2.5, 1.75)
			})
		}

		// ── hit testing ─────────────────────────────────────────────────────
		{
			const PROBES = 2000
			const pts: number[] = []
			for (let i = 0; i < PROBES; i++) {
				const s = editor.getShape(ids[(random() * SHAPE_COUNT) | 0])! as any
				pts.push(s.x + random() * 100, s.y + random() * 80)
			}
			for (let i = 0; i < 200; i++) editor.getShapeAtPoint({ x: pts[i * 2], y: pts[i * 2 + 1] })
			timeWithAlloc('getShapeAtPoint', PROBES, () => {
				for (let i = 0; i < PROBES; i++) {
					editor.getShapeAtPoint({ x: pts[i * 2], y: pts[i * 2 + 1] })
				}
			})
		}

		// ── the public Set-returning API ────────────────────────────────────
		{
			const SEARCHES = 500
			const boxes: Box[] = []
			for (let i = 0; i < SEARCHES; i++) {
				boxes.push(new Box(random() * side, random() * side, 4000, 3000))
			}
			for (let i = 0; i < 50; i++) editor.getShapeIdsInsideBounds(boxes[i])
			let hits = 0
			timeWithAlloc('getShapeIdsInsideBounds (Set)', SEARCHES, () => {
				for (let i = 0; i < SEARCHES; i++) hits += editor.getShapeIdsInsideBounds(boxes[i]).size
			})
			rows[rows.length - 1].note = `${(hits / SEARCHES) | 0} hits avg`
		}

		// ── page switching: a full index rebuild each way ────────────────────
		{
			const page2 = PageRecordType.createId('perf-page-2')
			editor.createPage({ name: 'perf page 2', id: page2 })
			const page1 = editor.getPages()[0].id
			const SWITCHES = 10
			for (let i = 0; i < 2; i++) {
				editor.setCurrentPage(page2)
				editor.getCulledShapes()
				editor.setCurrentPage(page1)
				editor.getCulledShapes()
			}
			const ns = time(() => {
				for (let i = 0; i < SWITCHES; i++) {
					editor.setCurrentPage(page2)
					editor.getCulledShapes()
					editor.setCurrentPage(page1)
					editor.getCulledShapes()
				}
			})
			record('page switch round trip (rebuild x2)', ns, SWITCHES)
		}

		report()
		editor.dispose()
	})
})
