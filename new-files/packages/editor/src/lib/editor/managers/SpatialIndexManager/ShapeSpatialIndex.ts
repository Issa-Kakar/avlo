import type { TLShapeId } from '@tldraw/tlschema'
import { FlatRTree } from './FlatRTree'

/** Results at or below this are kept as a scannable list rather than as stamps.
 *  A linear scan of a handful of ids beats a hash lookup, and the crossover is
 *  broad — anything from about 8 to 32 measures the same. */
const LIST_LIMIT = 16

const EMPTY_U16 = new Uint16Array(0)
const EMPTY_U32 = new Uint32Array(0)
const EMPTY_F64 = new Float64Array(0)

/** A box is indexable when it is finite and not inverted. A shape whose page
 *  bounds are neither is dropped from the index — the same outcome
 *  `Box.isValid()` produced at the manager, enforced here so the tree below
 *  never has to re-check. */
function isIndexableBox(minX: number, minY: number, maxX: number, maxY: number): boolean {
	return (
		Number.isFinite(minX) &&
		Number.isFinite(minY) &&
		Number.isFinite(maxX) &&
		Number.isFinite(maxY) &&
		minX <= maxX &&
		minY <= maxY
	)
}

/**
 * The shape-facing spatial index: a `FlatRTree` plus the `TLShapeId`-to-slot
 * mapping it needs.
 *
 * The tree underneath is keyed by dense unsigned ints ("slots"), not by shape
 * ids, which is what lets it hold every box in one `Float64Array` and answer a
 * search into a reused `Uint32Array` with no allocation at all. This class owns
 * that translation: slots are minted here, recycled here (LIFO, so the id space
 * tracks the live shape count rather than the number of shapes ever seen), and
 * never handed out.
 *
 * Two result shapes are offered, and the difference is the point:
 *
 * - {@link ShapeSpatialIndex.searchToSet} returns a `Set<TLShapeId>` — the
 *   drop-in shape, costing one Set plus one entry per hit.
 * - {@link ShapeSpatialIndex.acquireQuery} returns a reusable
 *   {@link SpatialQuery}: same answers via `size` and `has()`, no allocation.
 *   Every consumer in this repo asks only those two questions of a search
 *   result, so this is the path they take. The public `Editor` methods keep
 *   returning a real `Set`, because SDK users may do anything with theirs.
 *
 * Bounds are validated here — the tree is a trusted-boundary structure that
 * assumes finite, non-inverted boxes and does not re-check.
 *
 * @internal
 */
export class ShapeSpatialIndex {
	private readonly tree = new FlatRTree()

	/** Shape id per slot. Freed slots hold `undefined` and are never read: every
	 *  slot a search returns is live by construction. */
	private readonly idBySlot: (TLShapeId | undefined)[] = []
	private readonly slotOf = new Map<TLShapeId, number>()
	private readonly freeSlots: number[] = []
	private nextSlot = 0

	private readonly queryPool: SpatialQuery[] = []

	/** Queries that have been acquired and not released. Freeing a slot has to
	 *  reach them: a slot recycled onto a different shape would otherwise still
	 *  carry the stamp the previous occupant earned, and that shape would read
	 *  as a hit from a search that never saw it. */
	private readonly liveQueries: SpatialQuery[] = []

	/** Staging for {@link ShapeSpatialIndex.beginLoad} / {@link ShapeSpatialIndex.stage} / {@link ShapeSpatialIndex.commitLoad}.
	 *  Released again at commit: a page's worth of staging is not worth holding
	 *  between rebuilds. */
	private stagedIds: Uint32Array = EMPTY_U32
	private stagedBoxes: Float64Array = EMPTY_F64
	private stagedCount = 0

	getSize(): number {
		return this.slotOf.size
	}

	has(id: TLShapeId): boolean {
		return this.slotOf.has(id)
	}

	// ─────────────────────────────────────────────────────────────── mutation ──

	/**
	 * Insert `id`, or move it if it is already indexed. A box that is not
	 * indexable removes the shape instead, which is what invalid page bounds
	 * have always meant here.
	 *
	 * Returns whether the index changed, which is what drives the manager's
	 * epoch. Callers that might be re-upserting identical bounds should gate on
	 * {@link ShapeSpatialIndex.matchesBounds} first — this reports a change either way.
	 *
	 * The move path is the one that matters: dragging a shape re-upserts it on
	 * every store update, and the tree resolves that in place. An O(1) overwrite
	 * when the new box stays strictly inside its leaf's envelope; an exact
	 * bottom-up MBR fix with an early exit when it does not; a real
	 * remove-and-reinsert only when the shape has genuinely left its cluster.
	 */
	upsert(id: TLShapeId, minX: number, minY: number, maxX: number, maxY: number): boolean {
		if (!isIndexableBox(minX, minY, maxX, maxY)) return this.remove(id)
		const slot = this.slotOf.get(id)
		if (slot === undefined) {
			this.tree.insert(this.acquireSlot(id), minX, minY, maxX, maxY)
		} else {
			this.tree.update(slot, minX, minY, maxX, maxY)
		}
		return true
	}

	/** Remove `id` if present. Returns whether anything was removed. */
	remove(id: TLShapeId): boolean {
		const slot = this.slotOf.get(id)
		if (slot === undefined) return false
		// Order is load-bearing: the tree entry has to go before the slot can be
		// recycled, or a later insert reusing the slot would be removed instead.
		this.tree.remove(slot)
		this.slotOf.delete(id)
		this.idBySlot[slot] = undefined
		const live = this.liveQueries
		for (let i = 0; i < live.length; i++) live[i].forgetSlot(slot)
		this.freeSlots.push(slot)
		return true
	}

	/**
	 * True when `id` is indexed with exactly these bounds. Lets the incremental
	 * update path drop no-op upserts without materializing the stored box.
	 */
	matchesBounds(id: TLShapeId, minX: number, minY: number, maxX: number, maxY: number): boolean {
		const slot = this.slotOf.get(id)
		if (slot === undefined) return false
		return this.tree.matchesBBox(slot, minX, minY, maxX, maxY)
	}

	// ────────────────────────────────────────────────────────────── bulk load ──

	/**
	 * Start a packed rebuild. Drops the current contents; stage every shape with
	 * {@link ShapeSpatialIndex.stage}, then {@link ShapeSpatialIndex.commitLoad}.
	 *
	 * The three-call shape exists so the caller never builds an array of
	 * per-shape objects: staged boxes go straight into a `Float64Array` that the
	 * tree's bulk loader reads in place.
	 */
	beginLoad(sizeHint: number): void {
		this.clear()
		this.stagedCount = 0
		if (sizeHint > 0) this.growStaging(sizeHint)
	}

	/** Stage one shape for the in-progress {@link ShapeSpatialIndex.beginLoad}. Shapes with
	 *  non-indexable bounds are skipped, as are repeats of an already-staged id. */
	stage(id: TLShapeId, minX: number, minY: number, maxX: number, maxY: number): void {
		if (!isIndexableBox(minX, minY, maxX, maxY)) return
		if (this.slotOf.has(id)) return
		const n = this.stagedCount
		if (n === this.stagedIds.length) this.growStaging(n + 1)
		this.stagedIds[n] = this.acquireSlot(id)
		const b = n * 4
		this.stagedBoxes[b] = minX
		this.stagedBoxes[b + 1] = minY
		this.stagedBoxes[b + 2] = maxX
		this.stagedBoxes[b + 3] = maxY
		this.stagedCount = n + 1
	}

	/** Build the tree from everything staged since {@link ShapeSpatialIndex.beginLoad}. */
	commitLoad(): void {
		const n = this.stagedCount
		this.stagedCount = 0
		if (n > 0) this.tree.load(n, this.stagedIds, this.stagedBoxes)
		this.stagedIds = EMPTY_U32
		this.stagedBoxes = EMPTY_F64
	}

	/** Repack the tree for search quality after heavy churn. Contents unchanged. */
	rebuild(): void {
		this.tree.rebuild()
	}

	// ───────────────────────────────────────────────────────────────── search ──

	/**
	 * Shape ids whose bounds intersect the rect, as a `Set`.
	 *
	 * Allocates the Set and one entry per hit. Prefer {@link ShapeSpatialIndex.acquireQuery}
	 * wherever the caller only needs `size` and `has()`; this exists for the
	 * public `Editor` methods, whose `Set<TLShapeId>` return type is SDK surface.
	 *
	 * `precise` picks the tree's narrow search body — see
	 * {@link SpatialQuery.searchPoint}.
	 */
	searchToSet(
		minX: number,
		minY: number,
		maxX: number,
		maxY: number,
		precise: boolean
	): Set<TLShapeId> {
		const n = precise
			? this.tree.searchPrecise(minX, minY, maxX, maxY)
			: this.tree.search(minX, minY, maxX, maxY)
		const results = this.tree.results
		const idBySlot = this.idBySlot
		const out = new Set<TLShapeId>()
		for (let i = 0; i < n; i++) out.add(idBySlot[results[i]]!)
		return out
	}

	/**
	 * Take a reusable query object. Run it with {@link SpatialQuery.searchBounds}
	 * or {@link SpatialQuery.searchPoint}, read `size` / `has()`, then
	 * {@link SpatialQuery.release} it.
	 *
	 * Each acquired query owns its own membership stamps, so running a search
	 * while another query's results are still being consumed — a custom shape's
	 * geometry hit-testing against the index, say — cannot corrupt the outer
	 * one. Releasing is an optimization, not a correctness requirement: an
	 * unreleased query simply is not pooled.
	 */
	acquireQuery(): SpatialQuery {
		const query =
			this.queryPool.pop() ?? new SpatialQuery(this, this.tree, this.slotOf, this.idBySlot)
		this.liveQueries.push(query)
		return query
	}

	// ────────────────────────────────────────────────────────────── lifecycle ──

	/** Drop every shape and release the tree's buffers back to newborn sizes. */
	clear(): void {
		this.tree.clear()
		this.slotOf.clear()
		this.idBySlot.length = 0
		this.freeSlots.length = 0
		this.nextSlot = 0
		for (const query of this.liveQueries) query.reset()
		for (const query of this.queryPool) query.reset()
	}

	/**
	 * Release everything this index holds. Equivalent to {@link ShapeSpatialIndex.clear} plus
	 * dropping the pooled queries and the staging buffers.
	 *
	 * Deliberately NOT terminal: the editor registers this as a disposable, and
	 * a read can still land afterwards — the index computed is not torn down
	 * with it, so anything that pulls it schedules a rebuild against an index
	 * that has just been disposed. That has to produce an empty index, not a
	 * broken one.
	 */
	dispose(): void {
		this.clear()
		this.stagedIds = EMPTY_U32
		this.stagedBoxes = EMPTY_F64
		this.stagedCount = 0
		this.queryPool.length = 0
		this.liveQueries.length = 0
	}

	// ─────────────────────────────────────────────────────── query internals ──

	/** Slot ids stay below this. @internal */
	slotCapacity(): number {
		return this.nextSlot
	}

	/** @internal */
	recycleQuery(query: SpatialQuery): void {
		const live = this.liveQueries
		const i = live.indexOf(query)
		if (i !== -1) {
			const last = live.pop()!
			if (last !== query) live[i] = last
		}
		// A pooled query keeps its stamp buffer, which is the point of pooling it.
		// A handful is plenty: the SDK's searches never overlap more than one deep.
		if (this.queryPool.length < 4) this.queryPool.push(query)
	}

	/** Structural audit of the tree plus the slot back-links. Tests only.
	 *  @internal */
	validate(): void {
		this.tree.validate()
		for (const [id, slot] of this.slotOf) {
			if (this.idBySlot[slot] !== id) {
				throw new Error(`ShapeSpatialIndex: slot ${slot} back-link broken`)
			}
			if (!this.tree.has(slot)) {
				throw new Error(`ShapeSpatialIndex: slot ${slot} missing from tree`)
			}
		}
		if (this.tree.getSize() !== this.slotOf.size) {
			throw new Error(`ShapeSpatialIndex: tree size ${this.tree.getSize()} !== ${this.slotOf.size}`)
		}
	}

	/** Tests and benchmarks only. @internal */
	stats() {
		return this.tree.stats()
	}

	private acquireSlot(id: TLShapeId): number {
		const slot = this.freeSlots.length > 0 ? this.freeSlots.pop()! : this.nextSlot++
		this.idBySlot[slot] = id
		this.slotOf.set(id, slot)
		return slot
	}

	private growStaging(need: number): void {
		const cap = need + (need >> 1) + 16
		const ids = new Uint32Array(cap)
		ids.set(this.stagedIds)
		const boxes = new Float64Array(cap * 4)
		boxes.set(this.stagedBoxes)
		this.stagedIds = ids
		this.stagedBoxes = boxes
	}
}

/**
 * One search's results, held without allocating.
 *
 * Every consumer walks the page's sorted shapes and asks `has()` for each one,
 * so the probe count is always about the page size and the only variable is how
 * many shapes the search matched. That decides the representation, and the
 * query picks it per search:
 *
 * - A handful of matches — a hit test, an eraser's line segment — is kept as a
 *   list and scanned. At two or three entries that is a couple of pointer
 *   compares, cheaper than any hash lookup, and a miss on an empty result costs
 *   nothing at all.
 * - A large result — a viewport cull — is kept as a generation stamp per slot.
 *   Nothing is built per hit, and a search only touches the slots it matched.
 *
 * Either way nothing is allocated, and the matched slots are copied out of the
 * tree's shared results buffer during the search, so a search run while these
 * results are still being read cannot disturb them.
 *
 * @internal
 */
export class SpatialQuery {
	/** How many shapes the last search matched. Read only — the index writes it. */
	size = 0

	/** Matched ids, when the result was small enough to scan. `-1` means the
	 *  stamps below hold the membership instead. */
	private listed = -1
	private list: (TLShapeId | undefined)[] = []
	private stamp: Uint16Array = EMPTY_U16
	private slots: Uint32Array = EMPTY_U32
	private generation = 0

	constructor(
		private readonly index: ShapeSpatialIndex,
		private readonly tree: FlatRTree,
		private readonly slotOf: Map<TLShapeId, number>,
		private readonly idBySlot: (TLShapeId | undefined)[]
	) {}

	/** Search a rect. For viewport-scale rects — culls, marquees, brushes — where
	 *  the tree's branchless leaf compaction wins at the ~50% hit rates a wide
	 *  rect produces. */
	searchBounds(minX: number, minY: number, maxX: number, maxY: number): this {
		return this.run(this.tree.search(minX, minY, maxX, maxY))
	}

	/** Search a small box around a point. For hit tests, where the tree's narrow
	 *  body branches once per leaf entry — a near-zero hit rate the branch
	 *  predictor gets right every time. */
	searchPoint(x: number, y: number, margin: number): this {
		return this.run(this.tree.searchPrecise(x - margin, y - margin, x + margin, y + margin))
	}

	/** Whether the last search matched `id`.
	 *
	 *  Valid until this query's next search. Shapes added or moved since the
	 *  search are not reflected — the same as a `Set` taken at that moment —
	 *  and shapes removed since read as absent. */
	has(id: TLShapeId): boolean {
		const listed = this.listed
		if (listed >= 0) {
			const list = this.list
			for (let i = 0; i < listed; i++) if (list[i] === id) return true
			return false
		}
		const slot = this.slotOf.get(id)
		if (slot === undefined) return false
		return this.stamp[slot] === this.generation
	}

	/** Visit every matched shape id. Allocation-free. Shapes removed since the
	 *  search are skipped, matching {@link SpatialQuery.has}. */
	forEach(visit: (id: TLShapeId) => void): void {
		const listed = this.listed
		if (listed >= 0) {
			const list = this.list
			for (let i = 0; i < listed; i++) {
				const id = list[i]
				if (id !== undefined) visit(id)
			}
			return
		}
		const slots = this.slots
		const stamp = this.stamp
		const idBySlot = this.idBySlot
		const generation = this.generation
		for (let i = 0, n = this.size; i < n; i++) {
			const slot = slots[i]
			if (stamp[slot] === generation) visit(idBySlot[slot]!)
		}
	}

	/** Return this query to its index's pool. Optional — see
	 *  {@link ShapeSpatialIndex.acquireQuery}. */
	release(): void {
		this.size = 0
		// Answer nothing until the next search. A pooled query goes to a
		// different caller, and it must not answer that caller from this one's
		// result if they read it before searching.
		this.listed = 0
		this.index.recycleQuery(this)
	}

	/** Drop a slot's membership, because the shape holding it was removed and
	 *  the slot is about to be handed to a different shape. @internal */
	forgetSlot(slot: number): void {
		const listed = this.listed
		if (listed >= 0) {
			const slots = this.slots
			for (let i = 0; i < listed; i++) {
				if (slots[i] === slot) {
					this.list[i] = undefined
					return
				}
			}
			return
		}
		if (slot < this.stamp.length) this.stamp[slot] = 0
	}

	/** Forget everything, because the whole index was rebuilt. @internal */
	reset(): void {
		this.stamp.fill(0)
		this.generation = 0
		this.size = 0
		this.listed = 0
	}

	/** Membership is a generation stamp per slot: this many bytes are held for
	 *  the page's shapes. Tests and benchmarks only. @internal */
	stampBytes(): number {
		return this.stamp.byteLength + this.slots.byteLength
	}

	/** Take the count the tree just produced and turn it into membership.
	 *
	 *  Stamps are 16 bit and the generation simply counts up, so a search touches
	 *  only the slots it actually hit — no clearing pass over the page, and two
	 *  bytes per shape held rather than four. The counter wraps by refilling,
	 *  which lands once every 65,535 searches: one memset of a few hundred KB,
	 *  amortised to nothing. */
	private run(n: number): this {
		this.size = n
		if (n <= LIST_LIMIT) {
			// Small result: keep the ids and scan them. `listed = 0` on an empty
			// result answers every `has()` with no work whatsoever.
			const results = this.tree.results
			const slots =
				this.slots.length >= LIST_LIMIT ? this.slots : (this.slots = new Uint32Array(LIST_LIMIT))
			const list = this.list
			const idBySlot = this.idBySlot
			for (let i = 0; i < n; i++) {
				const slot = results[i]
				slots[i] = slot
				list[i] = idBySlot[slot]
			}
			this.listed = n
			return this
		}
		this.listed = -1
		// A generation is taken even for an empty result: a stamp left from this
		// query's previous search must never read as a hit.
		let generation = this.generation + 1
		if (generation === 0x10000) {
			this.stamp.fill(0)
			generation = 1
		}
		this.generation = generation
		if (n === 0) return this
		if (n > this.slots.length) this.slots = new Uint32Array(n + (n >> 1) + 16)
		const capacity = this.index.slotCapacity()
		if (capacity > this.stamp.length) {
			const next = new Uint16Array(capacity + (capacity >> 1) + 16)
			next.set(this.stamp)
			this.stamp = next
		}
		const results = this.tree.results
		const slots = this.slots
		const stamp = this.stamp
		for (let i = 0; i < n; i++) {
			const slot = results[i]
			slots[i] = slot
			stamp[slot] = generation
		}
		return this
	}
}
