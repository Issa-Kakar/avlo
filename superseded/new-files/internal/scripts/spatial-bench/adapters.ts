/**
 * The two implementations under test, behind one shape.
 *
 * Both wrappers are tldraw's real code — `RBushIndex` is the incumbent as
 * committed, `ShapeSpatialIndex` is the replacement — driven exactly the way
 * `SpatialIndexManager` drives them. That means the rbush side pays for the
 * `SpatialElement` object it has to mint per upsert (rbush removes by
 * reference, so the object cannot be reused in place without invalidating the
 * tree's MBRs), and both sides pay for turning a result into `Set<TLShapeId>`
 * when the suite asks for that.
 *
 * Only one of these modules is ever imported per process — see run-one.ts. Two
 * implementations behind one interface in one process would make every call
 * site polymorphic and measure the dispatch, not the index.
 */
import type { TLShapeId } from '@tldraw/tlschema'

export interface IndexAdapter {
	readonly name: string
	/** Build from scratch, the way a page load or page switch does. */
	bulkLoad(n: number, ids: TLShapeId[], boxes: Float64Array): void
	/** The result shape tldraw's public API returns. */
	searchToSet(minX: number, minY: number, maxX: number, maxY: number): Set<TLShapeId>
	/** The cheapest each implementation can answer "how many are in here". */
	searchCount(minX: number, minY: number, maxX: number, maxY: number): number
	/** A hit-test probe: a small box around a point. */
	probePoint(x: number, y: number, margin: number): number
	/** Search, then ask membership for a page's worth of ids — the shape a cull
	 *  and every brush/eraser hit test actually has. */
	searchThenProbe(
		minX: number,
		minY: number,
		maxX: number,
		maxY: number,
		probes: TLShapeId[]
	): number
	upsert(id: TLShapeId, minX: number, minY: number, maxX: number, maxY: number): void
	remove(id: TLShapeId): void
	getSize(): number
	clear(): void
}

export async function makeAdapter(impl: string): Promise<IndexAdapter> {
	if (impl === 'rbush') {
		const { RBushIndex } =
			await import('../../../packages/editor/src/lib/editor/managers/SpatialIndexManager/RBushIndex')
		return new RbushAdapter(new RBushIndex())
	}
	if (impl === 'flat') {
		const { ShapeSpatialIndex } =
			await import('../../../packages/editor/src/lib/editor/managers/SpatialIndexManager/ShapeSpatialIndex')
		return new FlatAdapter(new ShapeSpatialIndex())
	}
	throw new Error(`unknown impl: ${impl}`)
}

const RECT = { minX: 0, minY: 0, maxX: 0, maxY: 0 }
const NO_REMOVES = new Set<TLShapeId>()

class RbushAdapter implements IndexAdapter {
	readonly name = 'rbush'
	private upsertBatch: any[] = [null]

	constructor(private readonly index: any) {}

	getSize() {
		return this.index.getSize()
	}

	bulkLoad(n: number, ids: TLShapeId[], boxes: Float64Array) {
		// What SpatialIndexManager.buildFromScratch does: one object per shape.
		const elements = new Array(n)
		for (let i = 0; i < n; i++) {
			const b = i * 4
			elements[i] = {
				minX: boxes[b],
				minY: boxes[b + 1],
				maxX: boxes[b + 2],
				maxY: boxes[b + 3],
				id: ids[i],
			}
		}
		this.index.bulkLoad(elements)
	}

	searchToSet(minX: number, minY: number, maxX: number, maxY: number) {
		RECT.minX = minX
		RECT.minY = minY
		RECT.maxX = maxX
		RECT.maxY = maxY
		return this.index.search(RECT as any) as Set<TLShapeId>
	}

	searchCount(minX: number, minY: number, maxX: number, maxY: number) {
		// rbush has no count-only path: answering at all means materializing the
		// array of matched elements.
		RECT.minX = minX
		RECT.minY = minY
		RECT.maxX = maxX
		RECT.maxY = maxY
		return (this.index as any).rBush.search(RECT).length
	}

	probePoint(x: number, y: number, margin: number) {
		RECT.minX = x - margin
		RECT.minY = y - margin
		RECT.maxX = x + margin
		RECT.maxY = y + margin
		return (this.index as any).rBush.search(RECT).length
	}

	searchThenProbe(minX: number, minY: number, maxX: number, maxY: number, probes: TLShapeId[]) {
		const set = this.searchToSet(minX, minY, maxX, maxY)
		let hits = 0
		for (let i = 0; i < probes.length; i++) if (set.has(probes[i])) hits++
		return hits
	}

	upsert(id: TLShapeId, minX: number, minY: number, maxX: number, maxY: number) {
		this.upsertBatch[0] = { minX, minY, maxX, maxY, id }
		this.index.applyBatch(NO_REMOVES, this.upsertBatch)
	}

	remove(id: TLShapeId) {
		this.index.remove(id)
	}

	clear() {
		this.index.clear()
	}
}

class FlatAdapter implements IndexAdapter {
	readonly name = 'flat'
	private query: any

	constructor(private readonly index: any) {
		this.query = index.acquireQuery()
	}

	getSize() {
		return this.index.getSize()
	}

	bulkLoad(n: number, ids: TLShapeId[], boxes: Float64Array) {
		this.index.beginLoad(n)
		for (let i = 0; i < n; i++) {
			const b = i * 4
			this.index.stage(ids[i], boxes[b], boxes[b + 1], boxes[b + 2], boxes[b + 3])
		}
		this.index.commitLoad()
	}

	searchToSet(minX: number, minY: number, maxX: number, maxY: number) {
		return this.index.searchToSet(minX, minY, maxX, maxY, false) as Set<TLShapeId>
	}

	searchCount(minX: number, minY: number, maxX: number, maxY: number) {
		return this.query.searchBounds(minX, minY, maxX, maxY).size
	}

	probePoint(x: number, y: number, margin: number) {
		return this.query.searchPoint(x, y, margin).size
	}

	searchThenProbe(minX: number, minY: number, maxX: number, maxY: number, probes: TLShapeId[]) {
		const q = this.query.searchBounds(minX, minY, maxX, maxY)
		let hits = 0
		for (let i = 0; i < probes.length; i++) if (q.has(probes[i])) hits++
		return hits
	}

	upsert(id: TLShapeId, minX: number, minY: number, maxX: number, maxY: number) {
		this.index.upsert(id, minX, minY, maxX, maxY)
	}

	remove(id: TLShapeId) {
		this.index.remove(id)
	}

	clear() {
		this.index.clear()
	}
}
