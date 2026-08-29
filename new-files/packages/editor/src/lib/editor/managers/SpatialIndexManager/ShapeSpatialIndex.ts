import type { TLShapeId } from '@tldraw/tlschema'
import { FlatRTree } from './FlatRTree'

/** Empty slot in `idBySlot`. A string sentinel rather than `undefined` keeps
 *  the array a packed array of strings instead of a mixed one. */
const NO_ID = '' as TLShapeId

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
 * mapping it needs. A drop-in replacement for the rbush-backed index it
 * supersedes — same questions, same answers, same `Set<TLShapeId>` out of a
 * search — with no allocation on the search or update paths.
 *
 * The tree underneath is keyed by dense unsigned ints ("slots") rather than by
 * shape ids, which is what lets it keep every box in one `Float64Array` and
 * answer a search into a reused `Uint32Array` without allocating. This class
 * owns that translation and nothing outside it ever sees a slot: they are
 * minted here, recycled here (LIFO, so the slot space tracks the live shape
 * count rather than the number of shapes ever seen), and never handed out.
 *
 * Bounds are validated here. The tree is a trusted-boundary structure that
 * assumes finite, non-inverted boxes and does not re-check them.
 *
 * @internal
 */
export class ShapeSpatialIndex {
	private readonly tree = new FlatRTree()

	/** slot -> shape id. Holes hold `NO_ID`, never `undefined`. */
	private readonly idBySlot: TLShapeId[] = []
	/** shape id -> slot. The mirror of the id-to-element map the rbush-backed
	 *  index had to keep anyway, holding an int instead of an object. */
	private readonly slotOf = new Map<TLShapeId, number>()

	/** Recycled slots, newest first. A typed stack, not a `number[]`. */
	private freeSlots = new Uint32Array(64)
	private freeCount = 0
	private nextSlot = 0

	/** Staging for a full repopulate. Owned here so callers never see it. */
	private stagedIds = new Uint32Array(0)
	private stagedBoxes = new Float64Array(0)
	private stagedCount = 0

	getSize(): number {
		return this.slotOf.size
	}

	has(id: TLShapeId): boolean {
		return this.slotOf.has(id)
	}

	/**
	 * Insert or move `id`. Returns true when the index changed, so the caller
	 * can tell whether anything downstream needs to know.
	 */
	upsert(id: TLShapeId, minX: number, minY: number, maxX: number, maxY: number): boolean {
		if (!isIndexableBox(minX, minY, maxX, maxY)) return this.remove(id)
		const existing = this.slotOf.get(id)
		if (existing === undefined) {
			const slot = this.acquireSlot(id)
			this.tree.insert(slot, minX, minY, maxX, maxY)
			return true
		}
		// A no-op upsert is common: `getShapePageBounds` has no result-equality
		// check, so a colour change hands us a fresh but numerically identical
		// box. Dropping those here costs four compares and saves a tree write.
		if (this.tree.matchesBBox(existing, minX, minY, maxX, maxY)) return false
		this.tree.update(existing, minX, minY, maxX, maxY)
		return true
	}

	remove(id: TLShapeId): boolean {
		const slot = this.slotOf.get(id)
		if (slot === undefined) return false
		this.tree.remove(slot)
		this.slotOf.delete(id)
		this.idBySlot[slot] = NO_ID
		this.releaseSlot(slot)
		return true
	}

	/** True when `id` is indexed at exactly this box. Reads the stored box in
	 *  place, so the manager's "did the bounds actually change" check costs no
	 *  allocation — this is what the old `getElement` accessor existed for. */
	matchesBounds(id: TLShapeId, minX: number, minY: number, maxX: number, maxY: number): boolean {
		const slot = this.slotOf.get(id)
		if (slot === undefined) return false
		return this.tree.matchesBBox(slot, minX, minY, maxX, maxY)
	}

	/**
	 * Search, as a `Set<TLShapeId>`.
	 *
	 * Slots come back unique by construction, so this fills the Set directly
	 * from the tree's result buffer: no intermediate array of elements and no
	 * `.map()` to ids, which is what the rbush path had to do.
	 *
	 * `narrow` selects the tree's probe-shaped scan over its wide-rect one —
	 * point hit-tests take the first, viewport culls the second.
	 */
	search(minX: number, minY: number, maxX: number, maxY: number, narrow: boolean): Set<TLShapeId> {
		const out = new Set<TLShapeId>()
		if (!isIndexableBox(minX, minY, maxX, maxY)) return out
		const n = narrow
			? this.tree.searchPrecise(minX, minY, maxX, maxY)
			: this.tree.search(minX, minY, maxX, maxY)
		const results = this.tree.results
		const idBySlot = this.idBySlot
		for (let i = 0; i < n; i++) out.add(idBySlot[results[i]])
		return out
	}

	/**
	 * Repopulate from scratch. `fill` is called once and should hand every
	 * shape to `add`; the staging buffers behind it are internal, and the tree
	 * is bulk-loaded in one pass rather than built by repeated insertion.
	 */
	rebuildFrom(
		sizeHint: number,
		fill: (
			add: (id: TLShapeId, minX: number, minY: number, maxX: number, maxY: number) => void
		) => void
	): void {
		this.clear()
		this.growStaging(sizeHint)
		const add = (id: TLShapeId, minX: number, minY: number, maxX: number, maxY: number) => {
			if (!isIndexableBox(minX, minY, maxX, maxY)) return
			if (this.slotOf.has(id)) return
			if (this.stagedCount === this.stagedIds.length) this.growStaging(this.stagedCount * 2 + 8)
			const slot = this.acquireSlot(id)
			const i = this.stagedCount++
			this.stagedIds[i] = slot
			const b = i << 2
			this.stagedBoxes[b] = minX
			this.stagedBoxes[b + 1] = minY
			this.stagedBoxes[b + 2] = maxX
			this.stagedBoxes[b + 3] = maxY
		}
		fill(add)
		if (this.stagedCount > 0) this.tree.load(this.stagedCount, this.stagedIds, this.stagedBoxes)
		this.stagedCount = 0
	}

	clear(): void {
		this.tree.clear()
		this.slotOf.clear()
		this.idBySlot.length = 0
		this.freeCount = 0
		this.nextSlot = 0
		this.stagedCount = 0
	}

	/**
	 * Release what the index holds. Deliberately the same thing as `clear()`
	 * and NOT a terminal teardown: the editor registers this as a disposable
	 * but does not tear down the computed that rebuilds the index, so a read
	 * after disposal repopulates a disposed index. A structure that can be made
	 * permanently unusable while something still holds a reference to it turns
	 * that into a hang; a cleared one just refills.
	 */
	dispose(): void {
		this.clear()
	}

	/** Rebuild the tree in place over the same contents. */
	rebuild(): void {
		this.tree.rebuild()
	}

	/** Structural audit. Tests only. */
	validate(): void {
		this.tree.validate()
		let live = 0
		for (let slot = 0; slot < this.idBySlot.length; slot++) {
			const id = this.idBySlot[slot]
			if (id === NO_ID) continue
			live++
			if (this.slotOf.get(id) !== slot) throw new Error(`slot map disagrees at ${slot}`)
			if (!this.tree.has(slot)) throw new Error(`slot ${slot} mapped but not in tree`)
		}
		if (live !== this.slotOf.size) throw new Error('slot table and id map disagree on size')
		if (this.tree.getSize() !== live) throw new Error('tree and slot table disagree on size')
	}

	stats() {
		return this.tree.stats()
	}

	private acquireSlot(id: TLShapeId): number {
		const slot = this.freeCount > 0 ? this.freeSlots[--this.freeCount] : this.nextSlot++
		this.slotOf.set(id, slot)
		if (slot === this.idBySlot.length) this.idBySlot.push(id)
		else this.idBySlot[slot] = id
		return slot
	}

	private releaseSlot(slot: number): void {
		if (this.freeCount === this.freeSlots.length) {
			const grown = new Uint32Array(this.freeSlots.length * 2)
			grown.set(this.freeSlots)
			this.freeSlots = grown
		}
		this.freeSlots[this.freeCount++] = slot
	}

	private growStaging(need: number): void {
		if (need <= this.stagedIds.length) return
		const cap = Math.max(need, 16)
		const ids = new Uint32Array(cap)
		const boxes = new Float64Array(cap << 2)
		if (this.stagedCount > 0) {
			ids.set(this.stagedIds.subarray(0, this.stagedCount))
			boxes.set(this.stagedBoxes.subarray(0, this.stagedCount << 2))
		}
		this.stagedIds = ids
		this.stagedBoxes = boxes
	}
}
