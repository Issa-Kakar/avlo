/*
 * FlatRTree — a mutable, flat, Structure-of-Arrays R-tree. M = 16, fixed.
 *
 * rbush's algorithm skeleton (OMT bulk load, R*-flavored split,
 * least-enlargement subtree choice) with two rebuilt engines — an
 * eight-candidate split that also considers upper-coordinate distributions,
 * and a radix-partition bulk load over box-center keys — plus tiered in-place
 * update/remove, on flat typed-array storage: cell addressing with stored
 * positions, annotated ref words, and a sentinel root entry.
 *
 * This is the storage engine only. It knows nothing about shapes: items are
 * dense unsigned ints ("slots") minted by the layer above (see
 * `ShapeSpatialIndex`, which maps `TLShapeId` <-> slot). Searches fill a
 * reused `Uint32Array` of slots and return a count — no per-result object,
 * array, or Set is ever allocated here.
 *
 * ── Bit model (all literals in code — module consts don't constant-fold) ────
 * A node is a block of 16 entries. Entry boxes live IN THE PARENT (B-tree
 * style). The address of an entry is its CELL:
 *
 *   cell             = (node << 4) | pos          28 bits (node < 2^24)
 *   _refs[cell]      = leaf entry:     item id (< 2^30)
 *                      internal entry: child(0..23) | count<<24 (5b) | leaf<<29
 *                      (bits 30/31 spare — every word is a positive Smi)
 *   _boxes[cell<<2]  = [minX, minY, maxX, maxY] of the entry
 *   _parentCell[n]   = per node: its entry's cell in the parent | level<<28.
 *                      Level nibble 0xF marks FREED nodes (low bits then hold
 *                      the free-list next). Diagnostic only — nothing hot
 *                      reads the nibble.
 *   _cellOf[id]      = per item: the cell holding it; 0 ⇔ absent.
 *
 * Zero-sentinels everywhere (cell 0 is unreachable for items and non-root
 * nodes): fresh arrays need no fill, clear() is allocation of small arrays.
 * A child's count+leafness ride in the parent's ref word, so a popped stack
 * word fully describes the node about to be scanned — searches never load
 * per-node metadata, and covered-subtree dumps are refs-only.
 *
 * ── Sentinel (node 0, cell 0) ───────────────────────────────────────────────
 * Cell 0 IS the root's parent entry: _refs[0] = annotated root word,
 * _boxes[0..3] = root MBR. Every bottom-up walk terminates by writing cell 0
 * like any other level; the O(1) update/remove tiers apply at the root; and
 * searches open with a 4-compare whole-tree reject. The empty tree keeps
 * [+Inf,+Inf,−Inf,−Inf] at cell 0, so the SAME reject answers "empty" and the
 * SAME union-write seeds the first root MBR — no empty-tree branches anywhere.
 * _parentCell[0] stays 0 forever, which makes the insert extension walk
 * self-terminating: after extending cell 0 it revisits cell 0, finds the box
 * contained, and exits through the ordinary early-out — no root check in the
 * loop.
 *
 * ── MBR discipline ──────────────────────────────────────────────────────────
 * Invariant (validate() checks equality, not containment): every internal
 * entry box EQUALS the exact union of its child's entry boxes. Inserts extend
 * ancestors by the inserted box; splits write exact group MBRs; remove/update
 * either prove O(1) that nothing above changes (strictly interior box) or
 * recompute exact MBRs bottom-up with an early exit. Exactness keeps the tree
 * tight under churn and licenses the O(1) tiers.
 *
 * Underfull nodes are tolerated until rebuild(), rbush-style; only EMPTY
 * nodes are freed. Condense-on-delete (dissolve leaves below M >> 2, reinsert
 * survivors) was implemented and MEASURED OUT: it taxed clustered mass-removal
 * ×1.4–1.6 while buying ≤ 6% on post-deletion searches — it only defers
 * rebuild(). Don't re-add without new numbers.
 *
 * ── Ids ─────────────────────────────────────────────────────────────────────
 * Items are dense unsigned ints < 2^30. Checked at the insert/load boundary;
 * nothing else validates. Density is what makes `_cellOf` a flat array rather
 * than a Map — the layer above must recycle freed slots (LIFO) so the id
 * space tracks the live item count.
 *
 * ── Argument channels (no doubles across call boundaries) ───────────────────
 * V8 heap-allocates a HeapNumber for every non-Smi number crossing a
 * non-inlined call (measured: 2× call cost, ~2.2k scavenges per 36M calls).
 * Only Smi ints ever pass between methods; doubles travel through two
 * construction-fixed Float64Array channels: `_argBox` (entry box in, written
 * by the public wrappers) and `_mbr` (recalc results out). The channels are
 * never reallocated — safe to hoist across `_allocNode`, unlike the pool
 * arrays, whose identity changes on growth (hot bodies re-read them after any
 * path that can allocate a node). The load engine honors the same rule: no
 * key value ever crosses a call — only derived Smi SHIFTS do (typical keys
 * exceed Smi range, so passing one would box it).
 *
 * ── Memory policy ───────────────────────────────────────────────────────────
 * No power-of-two anywhere: growth is `cap + (cap >> 1) + 16`, fresh-alloc +
 * copy (NOT ArrayBuffer.transfer — see the growers). Bulk load reserves the
 * pool EXACTLY — a node-count arithmetic dry-run of the OMT recursion — so
 * loads never grow mid-build.
 * `clear()` reallocates everything growable at newborn sizes: a cleared tree
 * retains no high-water memory from the page it just held. Load-engine
 * scratch is BUILD-TRANSIENT (allocated per load, released before load
 * returns — nothing survives at instance or module scope; see the engine
 * section). `dispose()` releases every last buffer for good — a disposed
 * instance is dead. The traversal stack is a FIXED 1024 words with no growth
 * logic anywhere (SQLite R-tree style): a DFS holds ≤ 15 pending siblings per
 * level of the current path and a covered-subtree dump nests one more walk of
 * the same shape, so the need is < 2·height·15 + 2. Height is structurally
 * bounded: splits create nodes with ≥ 7 of 16 entries, so filling one back to
 * overflow takes ≥ 10 child splits — each root level costs ~10× the inserts
 * of the level below (OMT loads are shallower still: ⌈log₁₆ 2³⁰⌉ = 8).
 * Height 15 ≈ 10¹⁵ inserts; 2·15·15 ≪ 1024.
 *
 * ── Split heuristic ─────────────────────────────────────────────────────────
 * rbush sorts split candidates by LOWER coordinate only — an artifact of JS
 * object-sort cost it was tuned around. With typed-array scratch the sorts
 * are cheap enough to afford upper-coordinate distributions too, and on
 * elongated-item boards they matter: a slice by minX pins a long arrow to the
 * group holding its left END; a slice by maxX can place it where its mass
 * is. _split therefore scores EIGHT candidates — k ∈ [7,10] × {min order,
 * max order of the winning axis} — by minimum overlap, tie minimum area
 * (measured: max-order distributions win ~30% of organic splits and cut
 * leaves-touched-per-probe ~20%). Cost stays at rbush levels through three
 * structural moves: the snapshot pass fans each coordinate into CONTIGUOUS
 * per-axis key streams (sorts touch packed f64 keys, not strided boxes);
 * prefix/suffix tables are REDUCED to the k ∈ [7,10] window actually read
 * (20 unions + 32 stores per table, not 34 + 136 — three reduced tables
 * cost less than two full ones); and the max order is SEEDED from the min
 * order, so its insertion sort pays only for inversions — for interval keys
 * those are containment pairs, which are rare. Axis choice stays min-margin
 * only: X vs Y is settled before any max sort exists, and only the winner's
 * max order is built (measured equivalent to full four-table axis choice).
 * R*'s overlap-refined subtree choice at the leaf level was also built and
 * MEASURED OUT: +36–47% insert for ~5% probe/cull even after a provable
 * zero-enlargement skip, branchless clamps, and monotone early exit — and on
 * board-shaped data it herds inserts into big sloppy leaves (their Δoverlap
 * ≈ 0). Don't re-add without new numbers.
 *
 * ── Bulk-load engine ────────────────────────────────────────────────────────
 * OMT needs each recursion level cut into EXACT-COUNT chunks — rank
 * boundaries, not sorted order. rbush's multiSelect quickselects co-swapped
 * (box, id) records: 36-byte moves, data-dependent branches. This engine
 * partitions 8-byte PROXY records — parallel (key, index) Int32Array lanes —
 * with an MSD radix multi-partition that establishes ALL of a level's
 * boundaries in the same histogram+scatter passes and never re-touches a
 * bucket containing no boundary. Payload never moves — leaves gather boxes
 * and ids by ORIGINAL index — which also means `load` never mutates its
 * inputs: typed inputs are read in place (no defensive copy, no 36 B/item
 * transient); untyped inputs are normalized once so every hot read below
 * stays monomorphic.
 *
 * Keys are order-preserving SIGNED-int32 transforms of the f64 high word of
 * min+max (the box CENTER's order — slices elongated items by mass, not left
 * edge; measured −10% fresh leaves-per-probe vs min keys at equal build
 * cost): k = h ^ ((h >> 31) & 0x7fffffff), branchless. 32 bits suffice
 * because ties may be cut ARBITRARILY at exact ranks — OMT consumes counts,
 * not order. SIGNED keys are a cold-start choice: every lane read stays
 * int32-typed in Maglev, where the u32 transform's top-bit-set keys (≥ 2³¹
 * for every positive coordinate) broke int32 speculation and cost a
 * measured deopt-relearn cycle on every fresh context. The radix orders
 * digits unsigned; the sign lives entirely in the TOP digit, folded by
 * XOR 128 on that digit's bucket index only — below it, buckets already
 * share the sign bit and the remaining bits compare unsigned.
 *
 * The load path is shaped for the tiers it actually RUNS in: it is commonly
 * the first call in a fresh context (opening a document, switching pages),
 * i.e. Ignition/Sparkplug/early-Maglev, where cost ≈ element-touches ×
 * (dispatch + boxing), not machine ops:
 *   - per-element passes (seed / re-key / histogram / scatter / small sort)
 *     are separate LEAF FUNCTIONS whose every array arrives as a PARAMETER:
 *     interpreter-register access — a module binding would pay a
 *     context-slot load (plus TDZ hole check) per element in the low tiers,
 *     and a `this._x` read a shape-checked field load — and each function is
 *     a few hundred bytes of bytecode, so a first load OSR-compiles one
 *     small loop at a time instead of a fused hull once per OSR'd loop
 *     (measured: the monolith compiled 4×);
 *   - the key transform, identity permutation, and root min/max FUSE into
 *     one input pass (seedKeys); each phase's re-key pass doubles as the
 *     min/max scan whose clz32 skips every digit that cannot vary
 *     (clustered boards usually resolve a level in one histogram), and the
 *     root X phase reuses the seed pass outright;
 *   - scatter copy-back is TypedArray.copyWithin — native memmove, ZERO
 *     per-element bytecode at any tier — enabled by allocating each lane at
 *     2× count with the scatter half at +count;
 *   - histogram banks are subarray VIEWS taken per partition call (the bank
 *     base add is paid once per range, not once per element; the view alloc
 *     is a ~100-byte young-gen object). 4 banks keyed by shift let a parent
 *     keep reading its bucket ends while children (at shift−8) fill theirs;
 *   - boundary positions step incrementally (nb += g) from bucket to bucket
 *     — no division anywhere in the recursion;
 *   - ranges ≤ 48 insertion-sort: the cutoff is measured not-a-lever
 *     (16..192 within noise) and a quicksort fallback is more code to tier
 *     for the same noise. A range that exhausts its digits holds all-equal
 *     keys (the sort degenerates to a comparing scan), and the buckets of a
 *     shift-0 scatter are already key-equal, so the walk stops there — any
 *     cut of equal keys is an exact rank cut.
 * Engine state is BUILD-TRANSIENT and instance-owned: _buildFrom allocates
 * the lanes (24 B/item), parks them in instance fields for the recursion,
 * and resets those fields to empty sentinels before returning. Nothing
 * outlives a build, nothing is module-scoped — clear() and dispose() owe the
 * engine nothing. Measured vs multiSelect: warm builds −17% (500k) to −28%
 * (10k), fresh-tree search quality ~10% better via the center keys.
 *
 * ── Contracts (trusted-boundary) ────────────────────────────────────────────
 * - Boxes are finite with min ≤ max. Not re-validated — `ShapeSpatialIndex`
 *   filters non-finite bounds before they reach here.
 * - `insert` throws on duplicate or out-of-range id (corruption guard).
 * - Searches fill `this.results[0..n)` and return n. Capacity ≥ size is
 *   maintained at MUTATION time, so search bodies never grow or reallocate —
 *   the buffer's identity only changes on insert/load/clear, never between.
 * - `search()` (wide rects: viewport culls, marquees) and `searchPrecise()`
 *   (narrow probes: hit tests) differ ONLY in leaf compaction — branchless
 *   store vs mask+branch. The caller picks by construction (rect size
 *   predicts leaf hit rate); measured ±5–20% each way on the wrong body.
 * - The results buffer is SHARED and overwritten by the next search: consume
 *   it (or copy out of it) before searching again. Nothing reachable from a
 *   result-consuming loop may search this tree.
 * - Zero allocation on insert/update/remove/search steady state.
 * - `load` reads its inputs, synchronously, and never retains or mutates
 *   them.
 * - `dispose()` is terminal: every buffer is released; any further use of
 *   the instance is undefined.
 */

const MAX_ID = 0x40000000 // id ceiling (exclusive): 2^30
const MAX_NODES = 0x1000000 // 24-bit node field in ref words
const PENDING = 1 // transient _cellOf marker inside load(); real item cells are ≥ 16

const POOL_CAP0 = 8 // nodes — sentinel + root + headroom for ~100 items
const ID_CAP0 = 256 // _cellOf entries
const RESULTS_CAP0 = 256
const STACK_CAP = 1024 // fixed forever — bound proof in the header

// Immutable zero-length sentinels: what the transient engine fields hold
// between builds, and what dispose() leaves behind. Never written.
const EMPTY_U32 = new Uint32Array(0)
const EMPTY_I32 = new Int32Array(0)
const EMPTY_F64 = new Float64Array(0)

// Growth is fresh-alloc + copy, NOT ArrayBuffer.transfer. Measured (1M/200k
// wide searches): a transfer-grown pool ran 15–30% slower than a fresh one —
// realloc-extended mappings lose huge-page backing, and the per-node TLB miss
// taxes every box scan thereafter. The copy transfer would save is trivial
// here: bulk loads reserve exactly once from a near-empty pool, and organic
// 1.5× growth copies small pools.
const growF64 = (a: Float64Array, len: number): Float64Array => {
	const next = new Float64Array(len)
	next.set(a)
	return next
}
const growU32 = (a: Uint32Array, len: number): Uint32Array => {
	const next = new Uint32Array(len)
	next.set(a)
	return next
}

/** @internal */
export interface FlatRTreeStats {
	size: number
	nodes: number
	freeNodes: number
	height: number
	avgLeafFill: number
	bytes: number
}

/**
 * A mutable R-tree over flat typed arrays, keyed by dense integer ids.
 *
 * See the design note at the top of this file for the storage model, the split
 * and bulk-load engines, and the contracts. In short: boxes live in one
 * `Float64Array`, searches fill a reused `Uint32Array` and return a count, and
 * nothing on the insert / update / remove / search paths allocates.
 *
 * @internal
 */
export class FlatRTree {
	/** Query results — valid slots are [0, n) after search() or searchPrecise().
	 *  Identity changes only at mutation time (capacity ≥ size invariant). */
	results!: Uint32Array

	private _boxes!: Float64Array //      per cell: [minX,minY,maxX,maxY] at cell << 2
	private _refs!: Uint32Array //        per cell: item id (leaf) or annotated child word
	private _parentCell!: Uint32Array //  per node: parent cell | level << 28 (0xF = freed)
	private _cellOf!: Uint32Array //      per id: owning cell, 0 = absent

	private _poolCap!: number
	private _poolLen!: number
	private _freeHead!: number // 0 = empty free list (node 0 is the unfreeable sentinel)
	private _freeLen!: number
	private _size!: number

	private _stack: Uint32Array

	// ── split scratch (E = 17 candidate entries) — one f64 + one u32 arena,
	//    ~2.3 KB total, L1-resident, allocated once. _sF layout:
	//      0..67    snapshot of the 16 entry boxes + the extra entry
	//      68..135  per-axis key streams (minX, minY, maxX, maxY — 17 each;
	//               key i belongs to snapshot entry i until a sort co-moves it)
	//      136..152 adaptive key buffer for the max-order sort
	//      153..248 reduced tables (minX, minY, max — 32 slots each); slot
	//               tb + (k-7)*8 = [P minX,minY,maxX,maxY, S minX,minY,maxX,maxY]
	//    _sU layout: 0..16 snapshot ref words | 17..33 X order | 34..50 Y order
	//               | 51..67 max order.
	private _sF: Float64Array
	private _sU: Uint32Array
	private _splitMBR: Float64Array // [g1 minX,minY,maxX,maxY, g2 minX,minY,maxX,maxY]
	private _splitLeftCnt = 0 //      left group size chosen by the last _split

	private _mbr: Float64Array //    recalc channel [minX,minY,maxX,maxY]
	private _argBox: Float64Array // double-argument channel [minX,minY,maxX,maxY]

	// ── build-transient load-engine lanes — EMPTY sentinels between builds.
	//    _buildFrom allocates them (24 B/item), the OMT recursion hoists them
	//    into locals per call, and _buildFrom resets them before returning:
	//    zero retention at any scope, dispose() has nothing extra to do.
	private _lk = EMPTY_I32 //   record key lane [0, count) + scatter half at +count
	private _li = EMPTY_I32 //   record index lane, same shape
	private _tk = EMPTY_I32 //   _lk.subarray(count) — the scatter half
	private _ti = EMPTY_I32 //   _li.subarray(count)
	private _kx = EMPTY_I32 //   sortable center-X key per ORIGINAL item index
	private _ky = EMPTY_I32 //   sortable center-Y key per ORIGINAL item index
	private _hist = EMPTY_I32 // 4 histogram banks × 256, keyed by shift

	constructor() {
		this._stack = new Uint32Array(STACK_CAP)
		this._sF = new Float64Array(249)
		this._sU = new Uint32Array(68)
		this._splitMBR = new Float64Array(8)
		this._mbr = new Float64Array(4)
		this._argBox = new Float64Array(4)
		this.clear()
	}

	getSize(): number {
		return this._size
	}

	has(id: number): boolean {
		const cellOf = this._cellOf
		return id < cellOf.length && cellOf[id] !== 0
	}

	/** True when `id` is present and its stored box equals the given one exactly.
	 *  The incremental-update path uses this to drop no-op upserts without
	 *  materializing the stored box (O(1) — direct cell addressing). */
	matchesBBox(id: number, minX: number, minY: number, maxX: number, maxY: number): boolean {
		const cellOf = this._cellOf
		if (id >= cellOf.length) return false
		const cell = cellOf[id]
		if (cell === 0) return false
		const b = cell << 2
		const boxes = this._boxes
		return (
			boxes[b] === minX && boxes[b + 1] === minY && boxes[b + 2] === maxX && boxes[b + 3] === maxY
		)
	}

	// ─────────────────────────────────────────────────────────────── mutation ──

	insert(id: number, minX: number, minY: number, maxX: number, maxY: number): void {
		const a = this._argBox
		a[0] = minX
		a[1] = minY
		a[2] = maxX
		a[3] = maxY
		this._insertNew(id)
	}

	/** Guarded insert of an id known-or-checked absent; box already in `_argBox`. */
	private _insertNew(id: number): void {
		if (id >>> 0 !== id || id >= MAX_ID) throw new Error(`FlatRTree: invalid id: ${id}`)
		if (id >= this._cellOf.length) this._growCellOf(id)
		if (this._cellOf[id] !== 0) throw new Error(`FlatRTree: duplicate insert: ${id}`)
		const size = ++this._size
		if (size > this.results.length) this._growResults(size) // query bodies rely on capacity ≥ size
		this._insertEntry(id, 0)
	}

	/** Remove `id`. O(1) when its box is strictly interior; O(depth) otherwise. */
	remove(id: number): boolean {
		const cellOf = this._cellOf
		if (id >= cellOf.length) return false
		const cell = cellOf[id]
		if (cell === 0) return false
		cellOf[id] = 0
		this._size--
		const node = cell >>> 4
		const pc = this._parentCell[node] & 0x0fffffff
		const cnt = (this._refs[pc] >>> 24) & 31
		// O(1) tier: a strictly interior box (vs the leaf's MBR, read off the
		// parent entry — exact by invariant, uniform at the root via the
		// sentinel) defines no MBR face, so nothing above can change: swap-remove
		// and stop. The cnt guard keeps the decision structural — a sole occupant
		// EQUALS the MBR and must never rest on float equality.
		if (cnt > 1) {
			const boxes = this._boxes
			const ob = cell << 2
			const pe = pc << 2
			if (
				boxes[ob] > boxes[pe] &&
				boxes[ob + 1] > boxes[pe + 1] &&
				boxes[ob + 2] < boxes[pe + 2] &&
				boxes[ob + 3] < boxes[pe + 3]
			) {
				this._removeEntryAt(node, cell & 15, cnt, 1, pc)
				return true
			}
		}
		this._removeEntryAt(node, cell & 15, cnt, 1, pc)
		this._afterRemoval(node)
		return true
	}

	/**
	 * Upsert with tiered in-place fast paths. Tier 1 (O(1), direct addressing —
	 * no scans): old box strictly interior to the leaf's MBR and new box within
	 * it ⇒ overwrite, done. Tier 2: new box still intersects the union of the
	 * leaf's OTHER entries (the common drag case) ⇒ overwrite in place, then
	 * recompute exact MBRs bottom-up with an early exit. Only a genuine cluster
	 * exit relocates (remove + reinsert). No allocation on any in-place path.
	 */
	update(id: number, minX: number, minY: number, maxX: number, maxY: number): void {
		const a = this._argBox
		a[0] = minX
		a[1] = minY
		a[2] = maxX
		a[3] = maxY
		this._updateArg(id)
	}

	private _updateArg(id: number): void {
		const cellOf = this._cellOf
		const cell = id < cellOf.length ? cellOf[id] : 0
		if (cell === 0) {
			this._insertNew(id)
			return
		}
		const a = this._argBox
		const minX = a[0]
		const minY = a[1]
		const maxX = a[2]
		const maxY = a[3]
		const node = cell >>> 4
		const ob = cell << 2
		const boxes = this._boxes
		const pc = this._parentCell[node] & 0x0fffffff

		// Tier 1 — 8 compares over 8 loads, 4 stores, no ref-line touches at all.
		const pe = pc << 2
		const p0 = boxes[pe]
		const p1 = boxes[pe + 1]
		const p2 = boxes[pe + 2]
		const p3 = boxes[pe + 3]
		if (
			boxes[ob] > p0 &&
			boxes[ob + 1] > p1 &&
			boxes[ob + 2] < p2 &&
			boxes[ob + 3] < p3 &&
			minX >= p0 &&
			minY >= p1 &&
			maxX <= p2 &&
			maxY <= p3
		) {
			boxes[ob] = minX
			boxes[ob + 1] = minY
			boxes[ob + 2] = maxX
			boxes[ob + 3] = maxY
			return
		}

		const cnt = (this._refs[pc] >>> 24) & 31
		if (cnt > 1) {
			// MBR of the leaf's OTHER entries (skip ob) — one contiguous scan.
			const base = node << 6
			let oMinX = Infinity
			let oMinY = Infinity
			let oMaxX = -Infinity
			let oMaxY = -Infinity
			for (let b = base, end = base + (cnt << 2); b < end; b += 4) {
				if (b === ob) continue
				const x0 = boxes[b]
				const y0 = boxes[b + 1]
				const x1 = boxes[b + 2]
				const y1 = boxes[b + 3]
				if (x0 < oMinX) oMinX = x0
				if (y0 < oMinY) oMinY = y0
				if (x1 > oMaxX) oMaxX = x1
				if (y1 > oMaxY) oMaxY = y1
			}
			if (minX > oMaxX || maxX < oMinX || minY > oMaxY || maxY < oMinY) {
				this._relocate(id, cell, node, cnt, pc)
				return
			}
			boxes[ob] = minX
			boxes[ob + 1] = minY
			boxes[ob + 2] = maxX
			boxes[ob + 3] = maxY
			const m = this._mbr
			m[0] = oMinX < minX ? oMinX : minX
			m[1] = oMinY < minY ? oMinY : minY
			m[2] = oMaxX > maxX ? oMaxX : maxX
			m[3] = oMaxY > maxY ? oMaxY : maxY
			this._recalcUpFrom(node)
		} else {
			if (
				minX > boxes[ob + 2] ||
				maxX < boxes[ob] ||
				minY > boxes[ob + 3] ||
				maxY < boxes[ob + 1]
			) {
				// Sole occupant teleported clear of its old box — relocate so the old
				// subtree's region doesn't keep a far-away resident.
				this._relocate(id, cell, node, cnt, pc)
				return
			}
			boxes[ob] = minX
			boxes[ob + 1] = minY
			boxes[ob + 2] = maxX
			boxes[ob + 3] = maxY
			const m = this._mbr
			m[0] = minX
			m[1] = minY
			m[2] = maxX
			m[3] = maxY
			this._recalcUpFrom(node)
		}
	}

	/** Structural relocation of `id` out of leaf `node` — detach, then reinsert
	 *  through the full descent. `_argBox` still holds the new box (nothing in
	 *  the detach path writes it). */
	private _relocate(id: number, cell: number, node: number, cnt: number, pc: number): void {
		this._cellOf[id] = 0
		this._removeEntryAt(node, cell & 15, cnt, 1, pc)
		this._afterRemoval(node)
		this._insertEntry(id, 0)
	}

	/** Reset to newborn state, RELEASING all growable buffers — a cleared tree
	 *  carries no high-water memory into the next room. Construction-fixed
	 *  scratches (stack, split arena, channels) are tiny and stay. */
	clear(): void {
		this._boxes = new Float64Array(POOL_CAP0 * 64)
		this._refs = new Uint32Array(POOL_CAP0 * 16)
		this._parentCell = new Uint32Array(POOL_CAP0)
		this._cellOf = new Uint32Array(ID_CAP0)
		this.results = new Uint32Array(RESULTS_CAP0)
		this._poolCap = POOL_CAP0
		this._reset()
	}

	/** Terminal teardown for library consumers: release EVERY buffer — pool,
	 *  id map, results, stack, split arena, channels — so a disposed index
	 *  pins nothing even while the instance object itself is still referenced.
	 *  Any further use of the instance is undefined; construct a new one (or
	 *  call clear() instead of dispose() to keep a reusable tree). Idempotent. */
	dispose(): void {
		this._boxes = EMPTY_F64
		this._refs = EMPTY_U32
		this._parentCell = EMPTY_U32
		this._cellOf = EMPTY_U32
		this.results = EMPTY_U32
		this._stack = EMPTY_U32
		this._sF = EMPTY_F64
		this._sU = EMPTY_U32
		this._splitMBR = EMPTY_F64
		this._mbr = EMPTY_F64
		this._argBox = EMPTY_F64
		this._lk = EMPTY_I32
		this._li = EMPTY_I32
		this._tk = EMPTY_I32
		this._ti = EMPTY_I32
		this._kx = EMPTY_I32
		this._ky = EMPTY_I32
		this._hist = EMPTY_I32
		this._poolCap = 0
		this._poolLen = 0
		this._freeHead = 0
		this._freeLen = 0
		this._size = 0
		this._splitLeftCnt = 0
	}

	/** clear() minus the reallocation — also the rebuild() entry, which reuses
	 *  capacity (the same data is about to reload). */
	private _reset(): void {
		this._poolLen = 1 // node 0 = sentinel
		this._freeHead = 0
		this._freeLen = 0
		this._size = 0
		const root = this._allocNode(0) // = 1; _parentCell[root] = 0 ⇒ parent cell 0 ⇒ root
		this._refs[0] = root | 0x20000000 // annotated root word: cnt 0, leaf
		const boxes = this._boxes
		boxes[0] = Infinity // never-intersect MBR: the root reject answers "empty"
		boxes[1] = Infinity //  and the first insert's union-write seeds it — no
		boxes[2] = -Infinity // empty-tree branch anywhere
		boxes[3] = -Infinity
	}

	// ──────────────────────────────────────────────────────────────── queries ──

	/**
	 * NARROW range query — hit-test probes, snap radii, cursor picks. Fills
	 * `this.results[0..n)` with item ids, returns n. Growth-free: results
	 * capacity ≥ size (mutation-time invariant), stack statically bounded.
	 *
	 * Two leaf compactions exist, selected by the CALLER (pickers are narrow by
	 * construction, culls are wide by construction — no heuristics here): this
	 * one branches once per entry on the AND-combined mask, which near-zero hit
	 * rates predict perfectly; `search()` is the wide-rect twin. Measured:
	 * mask+branch wins probes by 5–10%, loses viewport-scale rects by 15–20%.
	 */
	searchPrecise(qMinX: number, qMinY: number, qMaxX: number, qMaxY: number): number {
		const a = this._argBox
		a[0] = qMinX
		a[1] = qMinY
		a[2] = qMaxX
		a[3] = qMaxY
		return this._searchPreciseArg()
	}

	private _searchPreciseArg(): number {
		const a = this._argBox
		const qMinX = a[0]
		const qMinY = a[1]
		const qMaxX = a[2]
		const qMaxY = a[3]
		const boxes = this._boxes
		// Whole-tree reject off the sentinel root MBR (empty tree included).
		if (qMinX > boxes[2] || qMaxX < boxes[0] || qMinY > boxes[3] || qMaxY < boxes[1]) return 0
		const refs = this._refs
		const res = this.results
		const stack = this._stack
		let n = 0
		let sp = 0
		let w = refs[0] // annotated word: child | cnt<<24 | leaf<<29

		for (;;) {
			const ni = w & 0xffffff
			const cnt = (w >>> 24) & 31
			const bBase = ni << 6
			const rBase = ni << 4

			if ((w & 0x20000000) !== 0) {
				// leaf — mask+branch: 4 unconditional loads, setcc-combined, ONE
				// branch per entry that probes predict near-perfectly (~0% hit rate).
				for (let b = bBase, r = rBase, end = rBase + cnt; r < end; b += 4, r++) {
					if (
						((qMinX <= boxes[b + 2]) as unknown as number) &
						((qMaxX >= boxes[b]) as unknown as number) &
						((qMinY <= boxes[b + 3]) as unknown as number) &
						((qMaxY >= boxes[b + 1]) as unknown as number)
					) {
						res[n++] = refs[r]
					}
				}
			} else {
				for (let b = bBase, r = rBase, end = rBase + cnt; r < end; b += 4, r++) {
					const x0 = boxes[b]
					const y0 = boxes[b + 1]
					const x1 = boxes[b + 2]
					const y1 = boxes[b + 3]
					if (qMinX <= x1 && qMaxX >= x0 && qMinY <= y1 && qMaxY >= y0) {
						if (qMinX <= x0 && qMinY <= y0 && x1 <= qMaxX && y1 <= qMaxY) {
							// Entry fully covered — dump the subtree without further tests.
							n = this._allInto(refs[r], n, sp)
						} else {
							stack[sp++] = refs[r]
						}
					}
				}
			}
			if (sp === 0) break
			w = stack[--sp]
		}
		return n
	}

	/**
	 * WIDE range query — viewport culls, marquees, zoom-out windows. Identical
	 * result set and contract as `searchPrecise()`; only the leaf compaction
	 * differs: fully branchless (unconditional store, conditional advance),
	 * because the partially-covered leaves a wide rect visits run ~50% hit rates
	 * (covered leaves bypass via the subtree dump) — the worst case for a branch
	 * predictor, where a dead store beats a mispredict.
	 */
	search(qMinX: number, qMinY: number, qMaxX: number, qMaxY: number): number {
		const a = this._argBox
		a[0] = qMinX
		a[1] = qMinY
		a[2] = qMaxX
		a[3] = qMaxY
		return this._searchArg()
	}

	private _searchArg(): number {
		const a = this._argBox
		const qMinX = a[0]
		const qMinY = a[1]
		const qMaxX = a[2]
		const qMaxY = a[3]
		const boxes = this._boxes
		if (qMinX > boxes[2] || qMaxX < boxes[0] || qMinY > boxes[3] || qMaxY < boxes[1]) return 0
		const refs = this._refs
		const res = this.results
		const stack = this._stack
		let n = 0
		let sp = 0
		let w = refs[0]

		for (;;) {
			const ni = w & 0xffffff
			const cnt = (w >>> 24) & 31
			const bBase = ni << 6
			const rBase = ni << 4

			if ((w & 0x20000000) !== 0) {
				// leaf — branchless compaction; capacity ≥ size covers every store.
				for (let b = bBase, r = rBase, end = rBase + cnt; r < end; b += 4, r++) {
					res[n] = refs[r]
					n +=
						((qMinX <= boxes[b + 2]) as unknown as number) &
						((qMaxX >= boxes[b]) as unknown as number) &
						((qMinY <= boxes[b + 3]) as unknown as number) &
						((qMaxY >= boxes[b + 1]) as unknown as number)
				}
			} else {
				for (let b = bBase, r = rBase, end = rBase + cnt; r < end; b += 4, r++) {
					const x0 = boxes[b]
					const y0 = boxes[b + 1]
					const x1 = boxes[b + 2]
					const y1 = boxes[b + 3]
					if (qMinX <= x1 && qMaxX >= x0 && qMinY <= y1 && qMaxY >= y0) {
						if (qMinX <= x0 && qMinY <= y0 && x1 <= qMaxX && y1 <= qMaxY) {
							n = this._allInto(refs[r], n, sp)
						} else {
							stack[sp++] = refs[r]
						}
					}
				}
			}
			if (sp === 0) break
			w = stack[--sp]
		}
		return n
	}

	// ────────────────────────────────────────────────────────────── bulk load ──

	/**
	 * OMT bulk load (rbush's algorithm) of `count` items given as parallel
	 * inputs: `ids[i]`, boxes[4i..4i+3] = [minX,minY,maxX,maxY]. Loading into a
	 * non-empty tree builds a packed subtree and joins it at the proper level.
	 * The build never moves item payload — records are (key, index) proxies —
	 * so TYPED inputs are read in place (no defensive copy) and are neither
	 * mutated nor retained; untyped inputs are normalized once so every hot
	 * read below stays monomorphic.
	 */
	load(count: number, ids: ArrayLike<number>, boxes: ArrayLike<number>): void {
		if (count === 0) return
		if (ids.length < count || boxes.length < count << 2)
			throw new Error('FlatRTree: load inputs shorter than count')
		if (count < 7) {
			for (let i = 0; i < count; i++) {
				const j = i << 2
				this.insert(ids[i], boxes[j], boxes[j + 1], boxes[j + 2], boxes[j + 3])
			}
			return
		}

		// A throw below (bad/duplicate id) is a corruption tripwire, not a
		// transaction — tree state after it is undefined.
		const own = ids instanceof Uint32Array
		const bIds = own ? (ids as Uint32Array) : new Uint32Array(count)
		let cellOf = this._cellOf
		for (let i = 0; i < count; i++) {
			const id = ids[i]
			if (id >>> 0 !== id || id >= MAX_ID) throw new Error(`FlatRTree: invalid id: ${id}`)
			if (id >= cellOf.length) {
				this._growCellOf(id)
				cellOf = this._cellOf
			}
			if (cellOf[id] !== 0) throw new Error(`FlatRTree: duplicate insert: ${id}`)
			cellOf[id] = PENDING // also trips on a duplicate later in THIS batch
			if (!own) bIds[i] = id
		}
		let bBoxes: Float64Array
		if (boxes instanceof Float64Array)
			bBoxes = boxes // read-only from here — see the doc comment
		else {
			const need = count << 2
			bBoxes = new Float64Array(need)
			for (let i = 0; i < need; i++) bBoxes[i] = boxes[i]
		}
		this._buildFrom(count, bIds, bBoxes)
	}

	/** load()'s tail — OMT-build `count` pre-validated items and join the
	 *  subtree in. Inputs are READ-ONLY (gathers go by original index). Also
	 *  the rebuild() entry, which skips load()'s id validation. */
	private _buildFrom(count: number, bIds: Uint32Array, bBoxes: Float64Array): void {
		// Exact-fit pool reserve: the OMT recursion is deterministic, so an
		// arithmetic dry-run gives the node count exactly — no estimate, no
		// mid-build growth (which also licenses _buildNode's hoisted array refs
		// across its own _allocNode calls). +16 covers the join path
		// (≤ height splits + 1 root).
		let height = Math.ceil(Math.log(count) / Math.log(16))
		if (height < 1) height = 1
		const rootFanout = Math.ceil(count / 16 ** (height - 1))
		const need = this._poolLen - this._freeLen + omtNodeCount(count, rootFanout) + 16
		if (need > this._poolCap) this._growPoolTo(need)

		// ── engine lanes: build-transient instance state (24 B/item), parked in
		//    fields for the recursion, RELEASED before this method returns. The
		//    scatter halves live at +count in the same allocations so copy-back
		//    is one native copyWithin per pass.
		const lk = new Int32Array(count << 1)
		const li = new Int32Array(count << 1)
		const kx = new Int32Array(count)
		const ky = new Int32Array(count)
		this._lk = lk
		this._li = li
		this._tk = lk.subarray(count)
		this._ti = li.subarray(count)
		this._kx = kx
		this._ky = ky
		this._hist = new Int32Array(1024)
		// Fused pass: center-key transform for both axes + identity permutation +
		// root X range — the root's X phase needs no re-key of its own.
		const rootShift = seedKeys(bBoxes, count, kx, ky, lk, li)

		const subAnn = this._buildNode(
			bIds,
			bBoxes,
			0,
			count - 1,
			count <= 16 ? 0 : height,
			rootFanout,
			rootShift
		)
		this._lk = EMPTY_I32
		this._li = EMPTY_I32
		this._tk = EMPTY_I32
		this._ti = EMPTY_I32
		this._kx = EMPTY_I32
		this._ky = EMPTY_I32
		this._hist = EMPTY_I32
		this._size += count
		if (this._size > this.results.length) this._growResults(this._size)
		const sub = subAnn & 0xffffff

		const rootW = this._refs[0]
		const rootIdx = rootW & 0xffffff
		if (((rootW >>> 24) & 31) === 0) {
			// Empty tree — the built subtree becomes the root.
			this._freeNode(rootIdx)
			this._refs[0] = subAnn
			this._parentCell[sub] &= 0xf0000000 // parent cell → 0 (root)
			this._recalcInto(sub, (subAnn >>> 24) & 31)
			const m = this._mbr
			const boxes = this._boxes
			boxes[0] = m[0]
			boxes[1] = m[1]
			boxes[2] = m[2]
			boxes[3] = m[3]
			return
		}

		const hT = this._parentCell[rootIdx] >>> 28
		const hS = this._parentCell[sub] >>> 28
		this._recalcInto(sub, (subAnn >>> 24) & 31) // sub's MBR — needed in every case
		if (hS === hT) {
			// Same height — a new root holds both. The old root's MBR is cell 0
			// (exact by invariant) — no rescan.
			const nr = this._allocNode(hT + 1)
			const m = this._mbr
			const boxes = this._boxes // re-read: _allocNode may have grown the pool
			const refs = this._refs
			const parentCell = this._parentCell
			const cell1 = nr << 4
			const b = cell1 << 2
			boxes[b] = boxes[0]
			boxes[b + 1] = boxes[1]
			boxes[b + 2] = boxes[2]
			boxes[b + 3] = boxes[3]
			boxes[b + 4] = m[0]
			boxes[b + 5] = m[1]
			boxes[b + 6] = m[2]
			boxes[b + 7] = m[3]
			refs[cell1] = rootW
			refs[cell1 + 1] = subAnn
			parentCell[rootIdx] = (hT << 28) | cell1
			parentCell[sub] = (hS << 28) | (cell1 + 1)
			refs[0] = nr | (2 << 24) // internal, cnt 2
			boxes[0] = boxes[b] < m[0] ? boxes[b] : m[0]
			boxes[1] = boxes[b + 1] < m[1] ? boxes[b + 1] : m[1]
			boxes[2] = boxes[b + 2] > m[2] ? boxes[b + 2] : m[2]
			boxes[3] = boxes[b + 3] > m[3] ? boxes[b + 3] : m[3]
		} else if (hS < hT) {
			this._argBox.set(this._mbr)
			this._insertEntry(subAnn, hS + 1)
		} else {
			// Built subtree is taller — it becomes the root; the old root joins it.
			const boxes = this._boxes
			const oMinX = boxes[0] // old root MBR, exact by invariant — no rescan
			const oMinY = boxes[1]
			const oMaxX = boxes[2]
			const oMaxY = boxes[3]
			const m = this._mbr
			this._refs[0] = subAnn
			this._parentCell[sub] &= 0xf0000000
			boxes[0] = m[0]
			boxes[1] = m[1]
			boxes[2] = m[2]
			boxes[3] = m[3]
			const a = this._argBox
			a[0] = oMinX
			a[1] = oMinY
			a[2] = oMaxX
			a[3] = oMaxY
			this._insertEntry(rootW, hT + 1)
		}
	}

	/** Repack in place: gather all live entries, rebuild via OMT. Keeps buffer
	 *  capacity — the same data reloads. Call after a period of heavy churn. */
	rebuild(): void {
		const n = this._size
		if (n === 0) return
		const ids = new Uint32Array(n)
		const gBoxes = new Float64Array(n << 2)
		const refs = this._refs
		const boxes = this._boxes
		const stack = this._stack
		let sp = 0
		let out = 0
		let w = refs[0]
		for (;;) {
			const ni = w & 0xffffff
			const cnt = (w >>> 24) & 31
			const bBase = ni << 6
			const rBase = ni << 4
			if ((w & 0x20000000) !== 0) {
				for (let e = 0; e < cnt; e++) {
					ids[out] = refs[rBase + e]
					const b = bBase + (e << 2)
					const o = out << 2
					gBoxes[o] = boxes[b]
					gBoxes[o + 1] = boxes[b + 1]
					gBoxes[o + 2] = boxes[b + 2]
					gBoxes[o + 3] = boxes[b + 3]
					out++
				}
			} else {
				for (let e = 0; e < cnt; e++) stack[sp++] = refs[rBase + e]
			}
			if (sp === 0) break
			w = stack[--sp]
		}
		this._reset()
		this._buildFrom(n, ids, gBoxes)
	}

	// ──────────────────────────────────────────────────────── insertion core ──

	/**
	 * Insert the entry whose box is in `_argBox`. `word` is a raw item id
	 * (targetLevel 0) or an annotated child word (subtree join, targetLevel =
	 * subtree level + 1). Overflow splits bubble through the sentinel's cell;
	 * the original box then extends ancestors — every new region a split
	 * introduced is ⊆ old ∪ box, so one walk restores exactness at every level.
	 */
	private _insertEntry(word: number, targetLevel: number): void {
		const arg = this._argBox
		const iMinX = arg[0]
		const iMinY = arg[1]
		const iMaxX = arg[2]
		const iMaxY = arg[3]

		const ann = this._chooseSubtree(targetLevel)
		let node = ann & 0xffffff
		let cnt = (ann >>> 24) & 31
		let intoLeaf = ann & 0x20000000

		let eMinX = iMinX
		let eMinY = iMinY
		let eMaxX = iMaxX
		let eMaxY = iMaxY
		let eWord = word

		for (;;) {
			if (cnt < 16) {
				const cell = (node << 4) | cnt
				const b = cell << 2
				const boxes = this._boxes // fresh reads — a prior split may have grown the pool
				const refs = this._refs
				const parentCell = this._parentCell
				boxes[b] = eMinX
				boxes[b + 1] = eMinY
				boxes[b + 2] = eMaxX
				boxes[b + 3] = eMaxY
				refs[cell] = eWord
				refs[parentCell[node] & 0x0fffffff] += 1 << 24 // count RMW in the parent word
				if (intoLeaf !== 0) this._cellOf[eWord] = cell
				else {
					const c = eWord & 0xffffff
					parentCell[c] = (parentCell[c] & 0xf0000000) | cell
				}
				break
			}

			// Overflow — split. The propagated entry travels through `_argBox`
			// (Smi/ref args only); redundant on the first hop, where it holds i*.
			arg[0] = eMinX
			arg[1] = eMinY
			arg[2] = eMaxX
			arg[3] = eMaxY
			const newNode = this._split(node, eWord)
			const g = this._splitMBR
			const k = this._splitLeftCnt
			const pcw = this._parentCell[node] // ONE fresh read — _split may have grown the pool
			const lvl = pcw >>> 28
			const leafFlag = lvl === 0 ? 0x20000000 : 0
			const pc = pcw & 0x0fffffff

			if (pc === 0) {
				// Root split — a new root above both groups, written through cell 0.
				const nr = this._allocNode(lvl + 1)
				const boxes = this._boxes
				const refs = this._refs
				const parentCell = this._parentCell
				const cell1 = nr << 4
				const b = cell1 << 2
				boxes[b] = g[0]
				boxes[b + 1] = g[1]
				boxes[b + 2] = g[2]
				boxes[b + 3] = g[3]
				boxes[b + 4] = g[4]
				boxes[b + 5] = g[5]
				boxes[b + 6] = g[6]
				boxes[b + 7] = g[7]
				refs[cell1] = node | (k << 24) | leafFlag
				refs[cell1 + 1] = newNode | ((17 - k) << 24) | leafFlag
				parentCell[node] = (lvl << 28) | cell1
				parentCell[newNode] = (lvl << 28) | (cell1 + 1)
				refs[0] = nr | (2 << 24)
				boxes[0] = g[0] < g[4] ? g[0] : g[4]
				boxes[1] = g[1] < g[5] ? g[1] : g[5]
				boxes[2] = g[2] > g[6] ? g[2] : g[6]
				boxes[3] = g[3] > g[7] ? g[3] : g[7]
				return // exact everywhere, root MBR included — nothing to extend
			}

			// Exact overwrite of the kept group's parent entry (splits may tighten).
			const boxes = this._boxes
			const refs = this._refs
			const wb = pc << 2
			boxes[wb] = g[0]
			boxes[wb + 1] = g[1]
			boxes[wb + 2] = g[2]
			boxes[wb + 3] = g[3]
			refs[pc] = node | (k << 24) | leafFlag

			eMinX = g[4]
			eMinY = g[5]
			eMaxX = g[6]
			eMaxY = g[7]
			eWord = newNode | ((17 - k) << 24) | leafFlag
			node = pc >>> 4
			cnt = (refs[this._parentCell[node] & 0x0fffffff] >>> 24) & 31
			intoLeaf = 0
		}

		// Extend ancestors by the ORIGINAL inserted box, early-exit on
		// containment. No root check: after cell 0 is extended, the walk lands on
		// the sentinel (whose parent cell is itself 0), finds the box contained,
		// and exits through the same early-out.
		const boxes = this._boxes
		const parentCell = this._parentCell
		let cur = node
		for (;;) {
			const s = parentCell[cur] & 0x0fffffff
			const b = s << 2
			const x0 = boxes[b]
			const y0 = boxes[b + 1]
			const x1 = boxes[b + 2]
			const y1 = boxes[b + 3]
			if (x0 <= iMinX && y0 <= iMinY && x1 >= iMaxX && y1 >= iMaxY) return
			boxes[b] = x0 < iMinX ? x0 : iMinX
			boxes[b + 1] = y0 < iMinY ? y0 : iMinY
			boxes[b + 2] = x1 > iMaxX ? x1 : iMaxX
			boxes[b + 3] = y1 > iMaxY ? y1 : iMaxY
			cur = s >>> 4
		}
	}

	/**
	 * Descend by least area enlargement (tie: least area) until reaching
	 * `targetLevel`; the entry box is read from `_argBox`. For node-entry
	 * inserts (`targetLevel > 0`) the descent also stops early if the chosen
	 * child sits below the target level — legal in an OMT-mixed-level tree; the
	 * entry then lands in the current node. Returns the annotated word of the
	 * landing node.
	 */
	private _chooseSubtree(targetLevel: number): number {
		const a = this._argBox
		const minX = a[0]
		const minY = a[1]
		const maxX = a[2]
		const maxY = a[3]
		const boxes = this._boxes
		const refs = this._refs
		const parentCell = this._parentCell
		let ann = refs[0]

		for (;;) {
			if ((ann & 0x20000000) !== 0) return ann
			const node = ann & 0xffffff
			if (targetLevel > 0 && parentCell[node] >>> 28 <= targetLevel) return ann
			const cnt = (ann >>> 24) & 31
			const bBase = node << 6
			let bestEnl = Infinity
			let bestArea = Infinity
			let bestE = 0
			for (let e = 0, b = bBase; e < cnt; e++, b += 4) {
				const x0 = boxes[b]
				const y0 = boxes[b + 1]
				const x1 = boxes[b + 2]
				const y1 = boxes[b + 3]
				const area = (x1 - x0) * (y1 - y0)
				const ex0 = minX < x0 ? minX : x0
				const ey0 = minY < y0 ? minY : y0
				const ex1 = maxX > x1 ? maxX : x1
				const ey1 = maxY > y1 ? maxY : y1
				const enl = (ex1 - ex0) * (ey1 - ey0) - area
				// Single combined winner test: a strict-enlargement win RESETS the
				// tie-break area (rbush conditionally kept a losing entry's smaller
				// area here, making later legitimate ties lose against a stale value).
				if (enl < bestEnl || (enl === bestEnl && area < bestArea)) {
					bestEnl = enl
					bestArea = area
					bestE = e
				}
			}
			const childW = refs[(node << 4) + bestE]
			if (targetLevel > 0 && parentCell[childW & 0xffffff] >>> 28 < targetLevel) return ann
			ann = childW
		}
	}

	/**
	 * Split `node` (full, 16 entries) plus one extra entry (box in `_argBox`,
	 * word `exWord`) into two groups. Axis by minimum total distribution margin
	 * of the min-coordinate orders (rbush's metric over the reduced tables);
	 * index over EIGHT candidates — `k` in [7,10] times the min and max orders
	 * of the winning axis — by minimum overlap, tie minimum combined area. The
	 * snapshot pass fans coordinates into contiguous key streams; the max
	 * order is seeded from the min order so its sort pays only for inversions
	 * (containment pairs). Group 1 rewrites `node`, group 2 fills a fresh
	 * node; back-links (cellOf / parentCell) are rewritten per distributed
	 * entry. Exact group MBRs land in `_splitMBR` (straight from the winning
	 * table slot), the left group size in `_splitLeftCnt`. Returns the new
	 * node.
	 */
	private _split(node: number, exWord: number): number {
		const sF = this._sF
		const sU = this._sU
		const boxes = this._boxes
		const refs = this._refs
		const arg = this._argBox
		const nb = node << 6
		const nr = node << 4

		// Fused snapshot + key extraction: each coordinate is loaded ONCE and
		// fanned out to its box-copy slot and its contiguous key-stream slot,
		// with both sort orders seeded in the same pass.
		for (let e = 0, b = nb, r = nr, d = 0; e < 16; e++, b += 4, r++, d += 4) {
			const x0 = boxes[b]
			const y0 = boxes[b + 1]
			const x1 = boxes[b + 2]
			const y1 = boxes[b + 3]
			sF[d] = x0
			sF[d + 1] = y0
			sF[d + 2] = x1
			sF[d + 3] = y1
			sF[68 + e] = x0 //  minX keys
			sF[85 + e] = y0 //  minY keys
			sF[102 + e] = x1 // maxX keys
			sF[119 + e] = y1 // maxY keys
			sU[e] = refs[r]
			sU[17 + e] = e
			sU[34 + e] = e
		}
		sF[64] = arg[0]
		sF[65] = arg[1]
		sF[66] = arg[2]
		sF[67] = arg[3]
		sF[84] = arg[0]
		sF[101] = arg[1]
		sF[118] = arg[2]
		sF[135] = arg[3]
		sU[16] = exWord
		sU[33] = 16
		sU[50] = 16

		sortPairs17(sF, 68, sU, 17) // by minX (contiguous keys, co-moved order)
		sortPairs17(sF, 85, sU, 34) // by minY
		const mx = fillReducedTable17(sF, sU, 17, 153)
		const my = fillReducedTable17(sF, sU, 34, 185)

		let ordMin: number
		let kMaxBase: number
		let tMin: number
		if (mx < my) {
			ordMin = 17
			kMaxBase = 102
			tMin = 153
		} else {
			ordMin = 34
			kMaxBase = 119
			tMin = 185
		}

		// Max order of the winning axis, seeded from the min order (adaptive:
		// inversions = interval-containment pairs only), then its table.
		for (let i = 0; i < 17; i++) {
			const v = sU[ordMin + i]
			sU[51 + i] = v
			sF[136 + i] = sF[kMaxBase + v]
		}
		sortPairs17(sF, 136, sU, 51)
		fillReducedTable17(sF, sU, 51, 217)

		// Index choice over EIGHT candidates: k ∈ [7,10] × {min order, max order}.
		let bestK = 7
		let bestT = tMin
		let bestOrd = ordMin
		let bestOverlap = Infinity
		let bestArea = Infinity
		for (let t = 0; t < 2; t++) {
			const tb = t === 0 ? tMin : 217
			const ob = t === 0 ? ordMin : 51
			for (let k = 7; k <= 10; k++) {
				const s = tb + ((k - 7) << 3)
				const p0 = sF[s]
				const p1 = sF[s + 1]
				const p2 = sF[s + 2]
				const p3 = sF[s + 3]
				const s0 = sF[s + 4]
				const s1 = sF[s + 5]
				const s2 = sF[s + 6]
				const s3 = sF[s + 7]
				const ix0 = p0 > s0 ? p0 : s0
				const iy0 = p1 > s1 ? p1 : s1
				const ix1 = p2 < s2 ? p2 : s2
				const iy1 = p3 < s3 ? p3 : s3
				const ow = ix1 - ix0
				const oh = iy1 - iy0
				const overlap = (ow > 0 ? ow : 0) * (oh > 0 ? oh : 0)
				const area = (p2 - p0) * (p3 - p1) + (s2 - s0) * (s3 - s1)
				if (overlap < bestOverlap || (overlap === bestOverlap && area < bestArea)) {
					bestOverlap = overlap
					bestArea = area
					bestK = k
					bestT = tb
					bestOrd = ob
				}
			}
		}

		const lvl = this._parentCell[node] >>> 28
		const newNode = this._allocNode(lvl)
		// _allocNode may grow the pool and detach the old arrays — re-read. The
		// hoists above were only for the scratch copy.
		const boxesW = this._boxes
		const refsW = this._refs
		const parentCellW = this._parentCell
		const cellOf = this._cellOf
		const mb = newNode << 6
		const mr = newNode << 4

		// Distribute: order[0..k) → node (rewritten), order[k..17) → newNode.
		for (let j = 0; j < bestK; j++) {
			const src = sU[bestOrd + j]
			const sb = src << 2
			const db = nb + (j << 2)
			boxesW[db] = sF[sb]
			boxesW[db + 1] = sF[sb + 1]
			boxesW[db + 2] = sF[sb + 2]
			boxesW[db + 3] = sF[sb + 3]
			const wv = sU[src]
			const cell = nr + j
			refsW[cell] = wv
			if (lvl === 0) cellOf[wv] = cell
			else {
				const ci = wv & 0xffffff
				parentCellW[ci] = (parentCellW[ci] & 0xf0000000) | cell
			}
		}
		const n2 = 17 - bestK
		const obk = bestOrd + bestK
		for (let j = 0; j < n2; j++) {
			const src = sU[obk + j]
			const sb = src << 2
			const db = mb + (j << 2)
			boxesW[db] = sF[sb]
			boxesW[db + 1] = sF[sb + 1]
			boxesW[db + 2] = sF[sb + 2]
			boxesW[db + 3] = sF[sb + 3]
			const wv = sU[src]
			const cell = mr + j
			refsW[cell] = wv
			if (lvl === 0) cellOf[wv] = cell
			else {
				const ci = wv & 0xffffff
				parentCellW[ci] = (parentCellW[ci] & 0xf0000000) | cell
			}
		}

		const g = this._splitMBR
		const gs = bestT + ((bestK - 7) << 3)
		g[0] = sF[gs]
		g[1] = sF[gs + 1]
		g[2] = sF[gs + 2]
		g[3] = sF[gs + 3]
		g[4] = sF[gs + 4]
		g[5] = sF[gs + 5]
		g[6] = sF[gs + 6]
		g[7] = sF[gs + 7]
		this._splitLeftCnt = bestK
		return newNode
	}

	// ─────────────────────────────────────────────────────────── removal core ──

	/** Swap-last removal of entry `pos` from `node` (whose parent entry is at
	 *  `pc`, holding `cnt`). Positions are stored, so the moved entry's
	 *  back-link is fixed in place: cellOf for leaf entries (`leafEntries` 1),
	 *  parentCell for child entries. */
	private _removeEntryAt(
		node: number,
		pos: number,
		cnt: number,
		leafEntries: number,
		pc: number
	): void {
		const refs = this._refs
		const last = cnt - 1
		if (pos !== last) {
			const boxes = this._boxes
			const base = node << 6
			const d = base + (pos << 2)
			const s = base + (last << 2)
			boxes[d] = boxes[s]
			boxes[d + 1] = boxes[s + 1]
			boxes[d + 2] = boxes[s + 2]
			boxes[d + 3] = boxes[s + 3]
			const rBase = node << 4
			const moved = refs[rBase + last]
			const cell = rBase + pos
			refs[cell] = moved
			if (leafEntries !== 0) this._cellOf[moved] = cell
			else {
				const parentCell = this._parentCell
				const mi = moved & 0xffffff
				parentCell[mi] = (parentCell[mi] & 0xf0000000) | cell
			}
		}
		refs[pc] -= 1 << 24
	}

	/**
	 * Post-removal maintenance from `node` upward: free emptied nodes
	 * (cascading their parent entries out), collapse single-child internal
	 * roots, then recompute exact MBRs bottom-up with an early exit — the walk
	 * writes the root MBR at the sentinel like any other level.
	 */
	private _afterRemoval(node: number): void {
		const parentCell = this._parentCell
		const refs = this._refs
		let pc = parentCell[node] & 0x0fffffff
		let w = refs[pc]
		let cnt = (w >>> 24) & 31

		while (cnt === 0 && pc !== 0) {
			const p = pc >>> 4
			const ppc = parentCell[p] & 0x0fffffff
			this._removeEntryAt(p, pc & 15, (refs[ppc] >>> 24) & 31, 0, ppc)
			this._freeNode(node)
			node = p
			pc = ppc
			w = refs[pc]
			cnt = (w >>> 24) & 31
		}

		if (pc === 0) {
			// At the root — collapse chains of single-child internal roots.
			while ((w & 0x20000000) === 0 && cnt === 1) {
				const childW = refs[node << 4]
				const c = childW & 0xffffff
				refs[0] = childW
				parentCell[c] &= 0xf0000000 // parent cell → 0 (root)
				const boxes = this._boxes
				const src = node << 6
				boxes[0] = boxes[src] // root MBR = the collapsed entry's box (exact)
				boxes[1] = boxes[src + 1]
				boxes[2] = boxes[src + 2]
				boxes[3] = boxes[src + 3]
				this._freeNode(node)
				node = c
				w = childW
				cnt = (w >>> 24) & 31
			}
			if (cnt === 0) {
				// Tree emptied — root reverts to an empty leaf, MBR to never-intersect.
				refs[0] = node | 0x20000000
				parentCell[node] = 0
				const boxes = this._boxes
				boxes[0] = Infinity
				boxes[1] = Infinity
				boxes[2] = -Infinity
				boxes[3] = -Infinity
				return
			}
		}

		this._recalcInto(node, cnt)
		this._recalcUpFrom(node)
	}

	// ─────────────────────────────────────────────────────── MBR maintenance ──

	/** Exact MBR of `node`'s first `cnt` entries into `_mbr`. One contiguous scan. */
	private _recalcInto(node: number, cnt: number): void {
		const boxes = this._boxes
		const base = node << 6
		let x0 = Infinity
		let y0 = Infinity
		let x1 = -Infinity
		let y1 = -Infinity
		for (let b = base, end = base + (cnt << 2); b < end; b += 4) {
			const a0 = boxes[b]
			const a1 = boxes[b + 1]
			const a2 = boxes[b + 2]
			const a3 = boxes[b + 3]
			if (a0 < x0) x0 = a0
			if (a1 < y0) y0 = a1
			if (a2 > x1) x1 = a2
			if (a3 > y1) y1 = a3
		}
		const m = this._mbr
		m[0] = x0
		m[1] = y0
		m[2] = x1
		m[3] = y1
	}

	/** Write `node`'s exact MBR (seeded in `_mbr` by the caller) into its
	 *  parent entry; while a level actually changed, recompute the parent's
	 *  exact MBR and continue upward — cell 0 is the final level. The early
	 *  exit fires on the first unchanged level, usually immediately. */
	private _recalcUpFrom(node: number): void {
		const seed = this._mbr
		let x0 = seed[0]
		let y0 = seed[1]
		let x1 = seed[2]
		let y1 = seed[3]
		const boxes = this._boxes
		const parentCell = this._parentCell
		const refs = this._refs
		for (;;) {
			const pc = parentCell[node] & 0x0fffffff
			const b = pc << 2
			if (boxes[b] === x0 && boxes[b + 1] === y0 && boxes[b + 2] === x1 && boxes[b + 3] === y1)
				return
			boxes[b] = x0
			boxes[b + 1] = y0
			boxes[b + 2] = x1
			boxes[b + 3] = y1
			if (pc === 0) return // just wrote the root MBR
			const p = pc >>> 4
			this._recalcInto(p, (refs[parentCell[p] & 0x0fffffff] >>> 24) & 31)
			const m = this._mbr
			x0 = m[0]
			y0 = m[1]
			x1 = m[2]
			y1 = m[3]
			node = p
		}
	}

	// ─────────────────────────────────────────────────────────── OMT builder ──

	/** OMT recursion over the record lanes. `fanout` is 16 except at the root
	 *  call, where it is chosen to maximize utilization. Item PAYLOAD never
	 *  moves: each phase re-keys its (permuted) records from _kx/_ky — the
	 *  re-key pass doubling as the min/max scan that starts the radix at the
	 *  highest digit that actually varies — and partitions those; leaves
	 *  gather boxes/ids by ORIGINAL index. `xShift` carries the root's
	 *  pre-seeded X phase (seedKeys already keyed the lanes): ≥ 0 = partition
	 *  at that shift, -1 = X keys all equal (skip), -2 = not seeded (recursive
	 *  calls re-key here). Returns the built node's ANNOTATED word; parent
	 *  linkage of the returned node is the caller's job. The pool was
	 *  exact-reserved by _buildFrom, so no _allocNode below can grow it —
	 *  which licenses every pool-array ref hoisted across the recursion. */
	private _buildNode(
		bIds: Uint32Array,
		bBoxes: Float64Array,
		lo: number,
		hi: number,
		height: number,
		fanout: number,
		xShift: number
	): number {
		const N = hi - lo + 1
		const li = this._li

		if (N <= 16) {
			const node = this._allocNode(0)
			const boxes = this._boxes
			const refs = this._refs
			const cellOf = this._cellOf
			const bBase = node << 6
			const rBase = node << 4
			for (let i = 0; i < N; i++) {
				const idx = li[lo + i] // original position — payload never moved
				const s = idx << 2
				const d = bBase + (i << 2)
				boxes[d] = bBoxes[s]
				boxes[d + 1] = bBoxes[s + 1]
				boxes[d + 2] = bBoxes[s + 2]
				boxes[d + 3] = bBoxes[s + 3]
				const id = bIds[idx]
				refs[rBase + i] = id
				cellOf[id] = rBase + i
			}
			return node | (N << 24) | 0x20000000
		}

		const node = this._allocNode(height)
		const N2 = Math.ceil(N / fanout)
		const N1 = N2 * Math.ceil(Math.sqrt(fanout))
		const lk = this._lk
		const tk = this._tk
		const ti = this._ti
		const hist = this._hist

		// X phase: partition into vertical slices of N1 by the X keys.
		if (N1 < N) {
			const sh = xShift === -2 ? refillKeys(this._kx, lk, li, lo, hi + 1) : xShift
			if (sh >= 0) radixPart(lk, li, tk, ti, hist, lo, hi + 1, lo + N1, N1, sh)
		}
		const ky = this._ky
		const parentCell = this._parentCell
		const refs = this._refs
		const boxes = this._boxes
		const m = this._mbr
		let cnt = 0
		for (let i = lo; i <= hi; i += N1) {
			const e1 = i + N1 - 1
			const hi2 = e1 < hi ? e1 : hi
			// Y phase: partition the slice into runs of N2 by the Y keys.
			if (N2 < hi2 - i + 1) {
				const sh = refillKeys(ky, lk, li, i, hi2 + 1)
				if (sh >= 0) radixPart(lk, li, tk, ti, hist, i, hi2 + 1, i + N2, N2, sh)
			}
			for (let j = i; j <= hi2; j += N2) {
				const e2 = j + N2 - 1
				const hi3 = e2 < hi2 ? e2 : hi2
				const childAnn = this._buildNode(bIds, bBoxes, j, hi3, height - 1, 16, -2)
				const child = childAnn & 0xffffff
				const cell = (node << 4) + cnt
				parentCell[child] = (parentCell[child] & 0xf0000000) | cell
				refs[cell] = childAnn
				this._recalcInto(child, (childAnn >>> 24) & 31)
				const d = cell << 2
				boxes[d] = m[0]
				boxes[d + 1] = m[1]
				boxes[d + 2] = m[2]
				boxes[d + 3] = m[3]
				cnt++
			}
		}
		return node | (cnt << 24)
	}

	// ──────────────────────────────────────────────────────── pool + growth ──

	private _allocNode(level: number): number {
		let n: number
		if (this._freeHead !== 0) {
			n = this._freeHead
			this._freeHead = this._parentCell[n] & 0xffffff
			this._freeLen--
		} else {
			if (this._poolLen === this._poolCap)
				this._growPoolTo(this._poolCap + (this._poolCap >> 1) + 16)
			n = this._poolLen++
		}
		this._parentCell[n] = level << 28
		return n
	}

	private _freeNode(n: number): void {
		this._parentCell[n] = 0xf0000000 | this._freeHead // FREE tag; low bits = next
		this._freeHead = n
		this._freeLen++
	}

	/** Grow the pool to EXACTLY `cap` nodes (no rounding — capacity needs no
	 *  power of two, only strides do, and those are literals). */
	private _growPoolTo(cap: number): void {
		if (cap > MAX_NODES) throw new Error('FlatRTree: pool exceeds 2^24 nodes')
		this._boxes = growF64(this._boxes, cap * 64)
		this._refs = growU32(this._refs, cap * 16)
		this._parentCell = growU32(this._parentCell, cap)
		this._poolCap = cap
	}

	/** Cold path — callers inline the `id >= _cellOf.length` check. New space
	 *  is zero = absent: no fill. */
	private _growCellOf(id: number): void {
		this._cellOf = growU32(this._cellOf, id + (id >> 1) + 16)
	}

	/** Called at MUTATION time only (capacity ≥ size invariant) — query bodies
	 *  never grow, so `results`' identity is stable across queries. */
	private _growResults(need: number): Uint32Array {
		const next = growU32(this.results, need + (need >> 1) + 16)
		this.results = next
		return next
	}

	/** Dump every item under annotated word `w` into results from `n`; returns
	 *  the new count. Refs-only — covered subtrees never touch box lines. */
	private _allInto(w: number, n: number, sp: number): number {
		const refs = this._refs
		const res = this.results
		const stack = this._stack
		const bot = sp
		stack[sp++] = w
		while (sp > bot) {
			const v = stack[--sp]
			const cnt = (v >>> 24) & 31
			const rBase = (v & 0xffffff) << 4
			if ((v & 0x20000000) !== 0) {
				for (let e = 0; e < cnt; e++) res[n++] = refs[rBase + e]
			} else {
				for (let e = 0; e < cnt; e++) stack[sp++] = refs[rBase + e]
			}
		}
		return n
	}

	// ──────────────────────────────────────────────────── audit + diagnostics ──

	/**
	 * Full structural audit — throws on the first violation. Checks linkage
	 * (parentCell/cellOf bidirectionality), annotation coherence (count + leaf
	 * bit vs level), EXACT MBR equality at every entry incl. the sentinel,
	 * free-list tagging, pool accounting, and the query-side invariants
	 * (results capacity ≥ size, sentinel parent cell 0). Test/debug; allocates.
	 */
	validate(): void {
		const refs = this._refs
		const boxes = this._boxes
		const parentCell = this._parentCell
		const visited = new Set<number>()
		const seenIds = new Set<number>()
		const fail = (msg: string): never => {
			throw new Error(`FlatRTree.validate: ${msg}`)
		}

		if ((parentCell[0] & 0x0fffffff) !== 0) fail('sentinel parent cell not 0')
		if (this.results.length < this._size)
			fail(`results capacity ${this.results.length} < size ${this._size}`)

		const rootW = refs[0]
		const rootIdx = rootW & 0xffffff
		if ((parentCell[rootIdx] & 0x0fffffff) !== 0) fail('root parent cell not 0')
		const rootCnt = (rootW >>> 24) & 31
		if (rootCnt > 0) {
			this._recalcInto(rootIdx, rootCnt)
			const m = this._mbr
			if (boxes[0] !== m[0] || boxes[1] !== m[1] || boxes[2] !== m[2] || boxes[3] !== m[3])
				fail('root MBR not exact')
		} else if (
			boxes[0] !== Infinity ||
			boxes[1] !== Infinity ||
			boxes[2] !== -Infinity ||
			boxes[3] !== -Infinity
		) {
			fail('empty root MBR not the never-intersect sentinel')
		}

		const stack: number[] = [rootW]
		while (stack.length) {
			const w = stack.pop() as number
			const node = w & 0xffffff
			if (visited.has(node)) fail(`node ${node} reachable twice`)
			visited.add(node)
			const cnt = (w >>> 24) & 31
			const isLeaf = (w & 0x20000000) !== 0
			const lvl = parentCell[node] >>> 28
			if (isLeaf !== (lvl === 0)) fail(`node ${node} leaf bit ${isLeaf} vs level ${lvl}`)
			if (cnt > 16) fail(`node ${node} count ${cnt} > 16`)
			if (node !== rootIdx && cnt < 1) fail(`non-root node ${node} empty`)
			if (node === rootIdx && !isLeaf && cnt < 2) fail(`internal root has ${cnt} entries`)
			const bBase = node << 6
			for (let e = 0; e < cnt; e++) {
				const cell = (node << 4) + e
				const b = bBase + (e << 2)
				if (!(boxes[b] <= boxes[b + 2]) || !(boxes[b + 1] <= boxes[b + 3]))
					fail(`node ${node} entry ${e} degenerate box`)
				const v = refs[cell]
				if (isLeaf) {
					if (this._cellOf[v] !== cell) fail(`cellOf[${v}] !== cell ${cell}`)
					if (seenIds.has(v)) fail(`id ${v} present twice`)
					seenIds.add(v)
				} else {
					const c = v & 0xffffff
					if ((parentCell[c] & 0x0fffffff) !== cell) fail(`parentCell[${c}] cell !== ${cell}`)
					const clv = parentCell[c] >>> 28
					if (clv >= lvl) fail(`child ${c} level ${clv} >= parent level ${lvl}`)
					if (((v & 0x20000000) !== 0) !== (clv === 0))
						fail(`child ${c} annotated leaf bit vs level ${clv}`)
					this._recalcInto(c, (v >>> 24) & 31)
					const m = this._mbr
					if (
						boxes[b] !== m[0] ||
						boxes[b + 1] !== m[1] ||
						boxes[b + 2] !== m[2] ||
						boxes[b + 3] !== m[3]
					)
						fail(`node ${node} entry ${e} MBR not exact for child ${c}`)
					stack.push(v)
				}
			}
		}

		if (seenIds.size !== this._size) fail(`leaf entries ${seenIds.size} !== size ${this._size}`)
		for (let id = 0; id < this._cellOf.length; id++) {
			if (this._cellOf[id] !== 0 && !seenIds.has(id)) fail(`cellOf[${id}] set but id unreachable`)
		}

		let free = 0
		for (let f = this._freeHead; f !== 0; f = parentCell[f] & 0xffffff) {
			if (parentCell[f] >>> 28 !== 0xf) fail(`free node ${f} lacks the FREE tag`)
			if (visited.has(f)) fail(`free node ${f} is reachable`)
			if (++free > this._poolLen) fail('free list cycle')
		}
		if (free !== this._freeLen) fail(`free list length ${free} !== ${this._freeLen}`)
		if (visited.size + free + 1 !== this._poolLen)
			fail(`pool leak: reachable ${visited.size} + free ${free} + sentinel !== ${this._poolLen}`)
	}

	stats(): FlatRTreeStats {
		const refs = this._refs
		let leaves = 0
		let leafFill = 0
		let nodes = 0
		const rootW = refs[0]
		const stack: number[] = [rootW]
		while (stack.length) {
			const w = stack.pop() as number
			nodes++
			const cnt = (w >>> 24) & 31
			if ((w & 0x20000000) !== 0) {
				leaves++
				leafFill += cnt
			} else {
				const rBase = (w & 0xffffff) << 4
				for (let e = 0; e < cnt; e++) stack.push(refs[rBase + e])
			}
		}
		return {
			size: this._size,
			nodes,
			freeNodes: this._freeLen,
			height: (this._parentCell[rootW & 0xffffff] >>> 28) + 1,
			avgLeafFill: leaves ? leafFill / (leaves * 16) : 0,
			bytes:
				this._boxes.byteLength +
				this._refs.byteLength +
				this._parentCell.byteLength +
				this._cellOf.byteLength +
				this.results.byteLength +
				this._stack.byteLength,
		}
	}
}

// ────────────────────────────────────────────────────── module-level helpers ──
// All stateless. Every array a helper touches arrives as a PARAMETER — an
// interpreter register in the low tiers, where a module binding would cost a
// context-slot load (plus TDZ hole check) per access and a field a
// shape-checked load. No mutable module state exists in this file.

/** Exact node count of the OMT build for `n` items — the same control flow as
 *  _buildNode with the box work stripped to span arithmetic. Drives the
 *  exact-fit pool reserve; any drift from _buildNode's chunking breaks it. */
function omtNodeCount(n: number, fanout: number): number {
	if (n <= 16) return 1
	const N2 = Math.ceil(n / fanout)
	const N1 = N2 * Math.ceil(Math.sqrt(fanout))
	let nodes = 1
	for (let off = 0; off < n; off += N1) {
		const span = Math.min(N1, n - off)
		for (let o2 = 0; o2 < span; o2 += N2) nodes += omtNodeCount(Math.min(N2, span - o2), 16)
	}
	return nodes
}

/** Insertion sort of 17 (key, order) pairs: contiguous f64 keys at sF[kb..kb+17)
 *  co-moved with their u32 order slots at sU[ob..ob+17). Contiguous keys are
 *  the point — the classic order-array indirection loads a strided box
 *  coordinate per compare; this loads packed doubles. Adaptive: a presorted
 *  (seeded) input pays one compare per element. */
function sortPairs17(sF: Float64Array, kb: number, sU: Uint32Array, ob: number): void {
	for (let i = 1; i < 17; i++) {
		const kv = sF[kb + i]
		const ov = sU[ob + i]
		let j = i - 1
		while (j >= 0 && sF[kb + j] > kv) {
			sF[kb + j + 1] = sF[kb + j]
			sU[ob + j + 1] = sU[ob + j]
			j--
		}
		sF[kb + j + 1] = kv
		sU[ob + j + 1] = ov
	}
}

/** Reduced prefix/suffix tables for one order: only k ∈ [7,10] is ever read
 *  (metric, index choice, group MBRs), so the prefix scan stops at entry 10
 *  and the suffix scan at entry 7 — 20 unions + 32 stores, not 34 + 136.
 *  Slot layout: tb + (k-7)*8 = [P minX,minY,maxX,maxY, S minX,minY,maxX,maxY]
 *  (P = union of the first k entries in the order, S = union of the rest).
 *  Returns the axis-goodness metric: Σ margin(P[k]) + margin(S[k]), k ∈ [7,10]. */
function fillReducedTable17(sF: Float64Array, sU: Uint32Array, ob: number, tb: number): number {
	let x0 = Infinity
	let y0 = Infinity
	let x1 = -Infinity
	let y1 = -Infinity
	for (let i = 0; i < 10; i++) {
		const b = sU[ob + i] << 2
		const a0 = sF[b]
		const a1 = sF[b + 1]
		const a2 = sF[b + 2]
		const a3 = sF[b + 3]
		if (a0 < x0) x0 = a0
		if (a1 < y0) y0 = a1
		if (a2 > x1) x1 = a2
		if (a3 > y1) y1 = a3
		if (i >= 6) {
			const w = tb + ((i - 6) << 3)
			sF[w] = x0
			sF[w + 1] = y0
			sF[w + 2] = x1
			sF[w + 3] = y1
		}
	}
	x0 = Infinity
	y0 = Infinity
	x1 = -Infinity
	y1 = -Infinity
	for (let i = 16; i >= 7; i--) {
		const b = sU[ob + i] << 2
		const a0 = sF[b]
		const a1 = sF[b + 1]
		const a2 = sF[b + 2]
		const a3 = sF[b + 3]
		if (a0 < x0) x0 = a0
		if (a1 < y0) y0 = a1
		if (a2 > x1) x1 = a2
		if (a3 > y1) y1 = a3
		if (i <= 10) {
			const w = tb + ((i - 7) << 3) + 4
			sF[w] = x0
			sF[w + 1] = y0
			sF[w + 2] = x1
			sF[w + 3] = y1
		}
	}
	let tot = 0
	for (let k = 0; k < 4; k++) {
		const s = tb + (k << 3)
		tot += sF[s + 2] - sF[s] + (sF[s + 3] - sF[s + 1])
		tot += sF[s + 6] - sF[s + 4] + (sF[s + 7] - sF[s + 5])
	}
	return tot
}

// ── radix load engine — stateless leaf passes ────────────────────────────────
// The per-element loops of the loader, one tiny function each: they tier up
// independently (a first load OSR-compiles a few hundred bytes per loop —
// the fused-body alternative measurably compiled its whole hull once per
// OSR'd inner loop), and every array is a parameter. Keys are SIGNED int32
// (see the header's engine section): digit extraction is bit-pattern
// arithmetic, so it works on negatives as-is; only the TOP digit orders
// wrong under two's complement, fixed by `bx` = XOR 128 at shift 24 (below
// that, a bucket's keys share the sign bit and remaining bits compare
// unsigned).

/** Fused seed pass: center-key transform for BOTH axes + identity permutation
 *  + root X range, one read of each input coordinate. The key is the signed
 *  high word of min+max (same order as the center), sign-folded branchlessly:
 *  `h ^ ((h >> 31) & 0x7fffffff)` reverses the magnitude order of negatives
 *  while keeping them below positives. Returns the root X phase's start
 *  shift, or -1 when every X key is equal (nothing to partition). */
function seedKeys(
	bBoxes: Float64Array,
	count: number,
	kx: Int32Array,
	ky: Int32Array,
	lk: Int32Array,
	li: Int32Array
): number {
	const sc = new Float64Array(2)
	const sv = new Int32Array(sc.buffer)
	sc[0] = 1
	const hx = sv[1] === 0x3ff00000 ? 1 : 0 // byte-order probe — 2 loads, once per build
	const hy = 2 + hx
	let mn = 2147483647
	let mx = -2147483648
	for (let j = 0; j < count; j++) {
		const b = j << 2
		sc[0] = bBoxes[b] + bBoxes[b + 2]
		sc[1] = bBoxes[b + 1] + bBoxes[b + 3]
		const wx = sv[hx]
		const wy = sv[hy]
		const kxv = wx ^ ((wx >> 31) & 0x7fffffff)
		const kyv = wy ^ ((wy >> 31) & 0x7fffffff)
		kx[j] = kxv
		ky[j] = kyv
		lk[j] = kxv
		li[j] = j
		if (kxv < mn) mn = kxv
		if (kxv > mx) mx = kxv
	}
	const x = mn ^ mx
	return x === 0 ? -1 : (31 - Math.clz32(x)) & ~7
}

/** Re-key the records [lo, hiEx) for the next phase: gather keySrc by each
 *  record's original index, tracking min/max so the radix starts at the
 *  highest digit that actually varies — clustered boards usually resolve a
 *  level in one histogram. Returns the start shift, or -1 when the range's
 *  keys are all equal (any order already satisfies every boundary). */
function refillKeys(
	keySrc: Int32Array,
	lk: Int32Array,
	li: Int32Array,
	lo: number,
	hiEx: number
): number {
	let mn = 2147483647
	let mx = -2147483648
	for (let p = lo; p < hiEx; p++) {
		const k = keySrc[li[p]]
		lk[p] = k
		if (k < mn) mn = k
		if (k > mx) mx = k
	}
	const x = mn ^ mx
	return x === 0 ? -1 : (31 - Math.clz32(x)) & ~7
}

/** Count digit occurrences of [lo, hiEx) into the 256-slot bank view `h`. */
function histPass(
	lk: Int32Array,
	h: Int32Array,
	lo: number,
	hiEx: number,
	shift: number,
	bx: number
): void {
	for (let p = lo; p < hiEx; p++) h[((lk[p] >> shift) & 255) ^ bx]++
}

/** Counts → absolute start cursors (the scatter advances them into ends). */
function prefixPass(h: Int32Array, lo: number): void {
	let acc = lo
	for (let d = 0; d < 256; d++) {
		const c = h[d]
		h[d] = acc
		acc += c
	}
}

/** Scatter records [lo, hiEx) into the scratch halves by digit; afterwards
 *  h[d] is the exclusive END of bucket d. */
function scatterPass(
	lk: Int32Array,
	li: Int32Array,
	tk: Int32Array,
	ti: Int32Array,
	h: Int32Array,
	lo: number,
	hiEx: number,
	shift: number,
	bx: number
): void {
	for (let p = lo; p < hiEx; p++) {
		const k = lk[p]
		const d = ((k >> shift) & 255) ^ bx
		const pos = h[d]
		h[d] = pos + 1
		tk[pos] = k
		ti[pos] = li[p]
	}
}

/** Insertion sort of records [lo, hiEx) by key, co-moving both lanes. Small
 *  ranges only (≤ 48 — the cutoff is measured not-a-lever anywhere in
 *  16..192, and a quicksort fallback is more code to tier for the same
 *  noise) plus the digits-exhausted terminal, where keys are all equal and
 *  this degenerates to one comparing scan. */
function insSort2(lk: Int32Array, li: Int32Array, lo: number, hiEx: number): void {
	for (let i = lo + 1; i < hiEx; i++) {
		const k = lk[i]
		const v = li[i]
		let j = i - 1
		while (j >= lo && lk[j] > k) {
			lk[j + 1] = lk[j]
			li[j + 1] = li[j]
			j--
		}
		lk[j + 1] = k
		li[j + 1] = v
	}
}

/**
 * MSD-radix multi-partition of records [lo, hiEx): afterwards every position
 * nb + m·g inside the range is an exact rank boundary — ALL of a node's OMT
 * slice boundaries resolve in the same histogram+scatter passes, and buckets
 * containing no boundary are never touched again (the entire point of
 * multi-select). `nb` is the first boundary STRICTLY above lo — the caller
 * guarantees `nb < hiEx` (both call sites test it) — and steps bucket to
 * bucket by g, so no boundary is ever derived by division. `hist` is 4 banks
 * of 256 keyed by shift: a parent keeps reading its own bank's bucket ends
 * while children (at shift−8) fill theirs. Equal keys make any cut a valid
 * rank cut, so a shift-0 scatter ends the recursion (its buckets are
 * key-equal) and a digit-exhausted range falls to the small sort.
 */
function radixPart(
	lk: Int32Array,
	li: Int32Array,
	tk: Int32Array,
	ti: Int32Array,
	hist: Int32Array,
	lo: number,
	hiEx: number,
	nb: number,
	g: number,
	shift: number
): void {
	for (;;) {
		if (hiEx - lo <= 48 || shift < 0) {
			insSort2(lk, li, lo, hiEx) // a full sort satisfies every boundary
			return
		}
		const hb = shift << 5 // bank base = (shift >> 3) * 256
		const h = hist.subarray(hb, hb + 256) // view: the base add leaves every per-element pass
		h.fill(0)
		const bx = shift === 24 ? 128 : 0 // sign fold — top digit only
		histPass(lk, h, lo, hiEx, shift, bx)
		if (h[((lk[lo] >> shift) & 255) ^ bx] === hiEx - lo) {
			// Single-digit range (clustered coords share high bytes): next digit,
			// no scatter pass.
			shift -= 8
			continue
		}
		prefixPass(h, lo)
		scatterPass(lk, li, tk, ti, h, lo, hiEx, shift, bx)
		const n0 = tk.length // the scratch halves sit at +n0 in the parent lanes
		lk.copyWithin(lo, n0 + lo, n0 + hiEx) // native memmove — zero per-element
		li.copyWithin(lo, n0 + lo, n0 + hiEx) // bytecode at any tier
		if (shift === 0) return // last digit: buckets are key-equal — every cut is already exact
		const s8 = shift - 8
		let start = lo
		for (let d = 0; d < 256 && start < hiEx; d++) {
			const end = h[d]
			if (end - start > 1) {
				while (nb <= start) nb += g
				if (nb < end) radixPart(lk, li, tk, ti, hist, start, end, nb, g, s8)
			}
			start = end
		}
		return
	}
}
