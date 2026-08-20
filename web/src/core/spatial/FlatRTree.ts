/**
 * FlatRTree — a mutable, flat, Structure-of-Arrays R-tree. M = 16, fixed.
 *
 * rbush's algorithms (OMT bulk load, R*-flavored margin/overlap split,
 * least-enlargement subtree choice) plus tiered in-place update/remove, on
 * flat typed-array storage: cell addressing with stored positions, annotated
 * ref words, and a sentinel root entry.
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
 * word fully describes the node about to be scanned — queries never load
 * per-node metadata, and covered-subtree dumps are refs-only.
 *
 * ── Sentinel (node 0, cell 0) ───────────────────────────────────────────────
 * Cell 0 IS the root's parent entry: _refs[0] = annotated root word,
 * _boxes[0..3] = root MBR. Every bottom-up walk terminates by writing cell 0
 * like any other level; the O(1) update/remove tiers apply at the root; and
 * queries open with a 4-compare whole-tree reject. The empty tree keeps
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
 * ×1.4–1.6 while buying ≤ 6% on post-deletion queries — it only defers
 * rebuild(), which avlo runs on WS first-sync anyway. Don't re-add without
 * new numbers.
 *
 * ── Ids ─────────────────────────────────────────────────────────────────────
 * Items are dense unsigned ints < 2^30 (avlo: `handle.slot`). Checked at the
 * insert/load boundary; nothing else validates.
 *
 * ── Argument channels (no doubles across call boundaries) ───────────────────
 * V8 heap-allocates a HeapNumber for every non-Smi number crossing a
 * non-inlined call (measured: 2× call cost, ~2.2k scavenges per 36M calls).
 * Only Smi ints ever pass between methods; doubles travel through two
 * construction-fixed Float64Array channels: `_argBox` (entry box in, written
 * by the public wrappers) and `_mbr` (recalc results out). The channels are
 * never reallocated — safe to hoist across `_allocNode`, unlike the pool
 * arrays, whose identity changes on growth (hot bodies re-read them after any
 * path that can allocate a node).
 *
 * ── Memory policy ───────────────────────────────────────────────────────────
 * No power-of-two anywhere: growth is `cap + (cap >> 1) + 16`, fresh-alloc +
 * copy (NOT ArrayBuffer.transfer — see the growers). Bulk load reserves the
 * pool EXACTLY — a node-count arithmetic dry-run of the OMT recursion — so
 * loads never grow mid-build.
 * `clear()` reallocates everything growable at newborn sizes: a cleared tree
 * retains no high-water memory from the previous room. The traversal stack is
 * a FIXED 1024 words with no growth logic anywhere (SQLite R-tree style):
 * a DFS holds ≤ 15 pending siblings per level of the current path and a
 * covered-subtree dump nests one more walk of the same shape, so the need is
 * < 2·height·15 + 2. Height is structurally bounded: splits create nodes with
 * ≥ 7 of 16 entries, so filling one back to overflow takes ≥ 10 child splits —
 * each root level costs ~10× the inserts of the level below (OMT loads are
 * shallower still: ⌈log₁₆ 2³⁰⌉ = 8). Height 15 ≈ 10¹⁵ inserts; 2·15·15 ≪ 1024.
 *
 * ── Contracts (trusted-boundary) ────────────────────────────────────────────
 * - Boxes are finite with min ≤ max. Not re-validated.
 * - `insert` throws on duplicate or out-of-range id (corruption guard).
 * - Queries fill `this.results[0..n)` and return n. Capacity ≥ size is
 *   maintained at MUTATION time, so query bodies never grow or reallocate —
 *   the buffer's identity only changes on insert/load/clear, never between.
 * - `query()` (wide rects: culls, marquees) and `queryPrecise()` (narrow
 *   probes: hit tests) differ ONLY in leaf compaction — branchless store vs
 *   mask+branch. The caller picks by construction (rect size predicts leaf
 *   hit rate); measured ±5–20% each way on the wrong body.
 * - Zero allocation on insert/update/remove/query steady state.
 */

const MAX_ID = 0x40000000; // id ceiling (exclusive): 2^30
const MAX_NODES = 0x1000000; // 24-bit node field in ref words
const PENDING = 1; // transient _cellOf marker inside load(); real item cells are ≥ 16

const POOL_CAP0 = 8; // nodes — sentinel + root + headroom for ~100 items
const ID_CAP0 = 256; // _cellOf entries
const RESULTS_CAP0 = 256;
const STACK_CAP = 1024; // fixed forever — bound proof in the header

// Growth is fresh-alloc + copy, NOT ArrayBuffer.transfer. Measured (1M/200k
// wide searches): a transfer-grown pool ran 15–30% slower than a fresh one —
// realloc-extended mappings lose huge-page backing, and the per-node TLB miss
// taxes every box scan thereafter. The copy transfer would save is trivial
// here: bulk loads reserve exactly once from a near-empty pool, and organic
// 1.5× growth copies small pools.
const growF64 = (a: Float64Array, len: number): Float64Array => {
  const next = new Float64Array(len);
  next.set(a);
  return next;
};
const growU32 = (a: Uint32Array, len: number): Uint32Array => {
  const next = new Uint32Array(len);
  next.set(a);
  return next;
};

export interface FlatRTreeStats {
  size: number;
  nodes: number;
  freeNodes: number;
  height: number;
  avgLeafFill: number;
  bytes: number;
}

export class FlatRTree {
  /** Max entries per node. Fixed — every stride and mask below is a literal. */
  readonly maxEntries = 16;
  /** Min entries per group in split distributions (rbush's 40% rule). */
  readonly minEntries = 7;

  /** Query results — valid slots are [0, n) after query()/queryPrecise()/queryAll().
   *  Identity changes only at mutation time (capacity ≥ size invariant). */
  results!: Uint32Array;

  private _boxes!: Float64Array; //      per cell: [minX,minY,maxX,maxY] at cell << 2
  private _refs!: Uint32Array; //        per cell: item id (leaf) or annotated child word
  private _parentCell!: Uint32Array; //  per node: parent cell | level << 28 (0xF = freed)
  private _cellOf!: Uint32Array; //      per id: owning cell, 0 = absent

  private _poolCap!: number;
  private _poolLen!: number;
  private _freeHead!: number; // 0 = empty free list (node 0 is the unfreeable sentinel)
  private _freeLen!: number;
  private _size!: number;

  private readonly _stack: Uint32Array;

  // ── split scratch (E = 17 candidate entries), allocated once ──
  private readonly _sBoxes: Float64Array; // 17 × 4 candidate entry boxes
  private readonly _sRefs: Uint32Array; //   17 candidate ref words
  private readonly _sOrderX: Uint32Array; // index permutation sorted by minX
  private readonly _sOrderY: Uint32Array; // index permutation sorted by minY
  private readonly _sPX: Float64Array; //    prefix MBRs along X order: slot 4c = union of first c
  private readonly _sSX: Float64Array; //    suffix MBRs along X order: slot 4i = union of [i, 17)
  private readonly _sPY: Float64Array;
  private readonly _sSY: Float64Array;
  private readonly _splitMBR: Float64Array; // [g1 minX,minY,maxX,maxY, g2 minX,minY,maxX,maxY]
  private _splitLeftCnt = 0; //              left group size chosen by the last _split

  private readonly _mbr: Float64Array; //    recalc channel [minX,minY,maxX,maxY]
  private readonly _argBox: Float64Array; // double-argument channel [minX,minY,maxX,maxY]

  constructor() {
    this._stack = new Uint32Array(STACK_CAP);
    this._sBoxes = new Float64Array(68);
    this._sRefs = new Uint32Array(17);
    this._sOrderX = new Uint32Array(17);
    this._sOrderY = new Uint32Array(17);
    this._sPX = new Float64Array(72);
    this._sSX = new Float64Array(72);
    this._sPY = new Float64Array(72);
    this._sSY = new Float64Array(72);
    this._splitMBR = new Float64Array(8);
    this._mbr = new Float64Array(4);
    this._argBox = new Float64Array(4);
    this.clear();
  }

  get size(): number {
    return this._size;
  }

  has(id: number): boolean {
    return id < this._cellOf.length && this._cellOf[id] !== 0;
  }

  /** Copy the stored box of `id` into out[0..3]. O(1) — direct cell addressing. */
  readBBox(id: number, out: Float64Array): boolean {
    if (id >= this._cellOf.length) return false;
    const cell = this._cellOf[id];
    if (cell === 0) return false;
    const b = cell << 2;
    const boxes = this._boxes;
    out[0] = boxes[b];
    out[1] = boxes[b + 1];
    out[2] = boxes[b + 2];
    out[3] = boxes[b + 3];
    return true;
  }

  // ─────────────────────────────────────────────────────────────── mutation ──

  insert(id: number, minX: number, minY: number, maxX: number, maxY: number): void {
    const a = this._argBox;
    a[0] = minX;
    a[1] = minY;
    a[2] = maxX;
    a[3] = maxY;
    this._insertNew(id);
  }

  /** Guarded insert of an id known-or-checked absent; box already in `_argBox`. */
  private _insertNew(id: number): void {
    if (id >>> 0 !== id || id >= MAX_ID) throw new Error(`FlatRTree: invalid id: ${id}`);
    if (id >= this._cellOf.length) this._growCellOf(id);
    if (this._cellOf[id] !== 0) throw new Error(`FlatRTree: duplicate insert: ${id}`);
    const size = ++this._size;
    if (size > this.results.length) this._growResults(size); // query bodies rely on capacity ≥ size
    this._insertEntry(id, 0);
  }

  /** Remove `id`. O(1) when its box is strictly interior; O(depth) otherwise. */
  remove(id: number): boolean {
    if (id >= this._cellOf.length) return false;
    const cell = this._cellOf[id];
    if (cell === 0) return false;
    this._cellOf[id] = 0;
    this._size--;
    const node = cell >>> 4;
    const pc = this._parentCell[node] & 0x0fffffff;
    const cnt = (this._refs[pc] >>> 24) & 31;
    // O(1) tier: a strictly interior box (vs the leaf's MBR, read off the
    // parent entry — exact by invariant, uniform at the root via the
    // sentinel) defines no MBR face, so nothing above can change: swap-remove
    // and stop. The cnt guard keeps the decision structural — a sole occupant
    // EQUALS the MBR and must never rest on float equality.
    if (cnt > 1) {
      const boxes = this._boxes;
      const ob = cell << 2;
      const pe = pc << 2;
      if (boxes[ob] > boxes[pe] && boxes[ob + 1] > boxes[pe + 1] && boxes[ob + 2] < boxes[pe + 2] && boxes[ob + 3] < boxes[pe + 3]) {
        this._removeEntryAt(node, cell & 15, cnt, 1, pc);
        return true;
      }
    }
    this._removeEntryAt(node, cell & 15, cnt, 1, pc);
    this._afterRemoval(node);
    return true;
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
    const a = this._argBox;
    a[0] = minX;
    a[1] = minY;
    a[2] = maxX;
    a[3] = maxY;
    this._updateArg(id);
  }

  private _updateArg(id: number): void {
    const cellOf = this._cellOf;
    if (id >= cellOf.length || cellOf[id] === 0) {
      this._insertNew(id);
      return;
    }
    const a = this._argBox;
    const minX = a[0];
    const minY = a[1];
    const maxX = a[2];
    const maxY = a[3];
    const cell = cellOf[id];
    const node = cell >>> 4;
    const ob = cell << 2;
    const boxes = this._boxes;
    const pc = this._parentCell[node] & 0x0fffffff;

    // Tier 1 — 8 compares, 4 stores, no ref-line touches at all.
    const pe = pc << 2;
    if (
      boxes[ob] > boxes[pe] &&
      boxes[ob + 1] > boxes[pe + 1] &&
      boxes[ob + 2] < boxes[pe + 2] &&
      boxes[ob + 3] < boxes[pe + 3] &&
      minX >= boxes[pe] &&
      minY >= boxes[pe + 1] &&
      maxX <= boxes[pe + 2] &&
      maxY <= boxes[pe + 3]
    ) {
      boxes[ob] = minX;
      boxes[ob + 1] = minY;
      boxes[ob + 2] = maxX;
      boxes[ob + 3] = maxY;
      return;
    }

    const cnt = (this._refs[pc] >>> 24) & 31;
    if (cnt > 1) {
      // MBR of the leaf's OTHER entries (skip ob) — one contiguous scan.
      const base = node << 6;
      let oMinX = Infinity;
      let oMinY = Infinity;
      let oMaxX = -Infinity;
      let oMaxY = -Infinity;
      for (let b = base, end = base + (cnt << 2); b < end; b += 4) {
        if (b === ob) continue;
        const x0 = boxes[b];
        const y0 = boxes[b + 1];
        const x1 = boxes[b + 2];
        const y1 = boxes[b + 3];
        if (x0 < oMinX) oMinX = x0;
        if (y0 < oMinY) oMinY = y0;
        if (x1 > oMaxX) oMaxX = x1;
        if (y1 > oMaxY) oMaxY = y1;
      }
      if (minX > oMaxX || maxX < oMinX || minY > oMaxY || maxY < oMinY) {
        this._relocate(id, cell, node, cnt, pc);
        return;
      }
      boxes[ob] = minX;
      boxes[ob + 1] = minY;
      boxes[ob + 2] = maxX;
      boxes[ob + 3] = maxY;
      const m = this._mbr;
      m[0] = oMinX < minX ? oMinX : minX;
      m[1] = oMinY < minY ? oMinY : minY;
      m[2] = oMaxX > maxX ? oMaxX : maxX;
      m[3] = oMaxY > maxY ? oMaxY : maxY;
      this._recalcUpFrom(node);
    } else {
      if (minX > boxes[ob + 2] || maxX < boxes[ob] || minY > boxes[ob + 3] || maxY < boxes[ob + 1]) {
        // Sole occupant teleported clear of its old box — relocate so the old
        // subtree's region doesn't keep a far-away resident.
        this._relocate(id, cell, node, cnt, pc);
        return;
      }
      boxes[ob] = minX;
      boxes[ob + 1] = minY;
      boxes[ob + 2] = maxX;
      boxes[ob + 3] = maxY;
      const m = this._mbr;
      m[0] = minX;
      m[1] = minY;
      m[2] = maxX;
      m[3] = maxY;
      this._recalcUpFrom(node);
    }
  }

  /** Structural relocation of `id` out of leaf `node` — detach, then reinsert
   *  through the full descent. `_argBox` still holds the new box (nothing in
   *  the detach path writes it). */
  private _relocate(id: number, cell: number, node: number, cnt: number, pc: number): void {
    this._cellOf[id] = 0;
    this._removeEntryAt(node, cell & 15, cnt, 1, pc);
    this._afterRemoval(node);
    this._insertEntry(id, 0);
  }

  /** Reset to newborn state, RELEASING all growable buffers — a cleared tree
   *  carries no high-water memory into the next room. Construction-fixed
   *  scratches (stack, split tables, channels) are tiny and stay. */
  clear(): void {
    this._boxes = new Float64Array(POOL_CAP0 * 64);
    this._refs = new Uint32Array(POOL_CAP0 * 16);
    this._parentCell = new Uint32Array(POOL_CAP0);
    this._cellOf = new Uint32Array(ID_CAP0);
    this.results = new Uint32Array(RESULTS_CAP0);
    this._poolCap = POOL_CAP0;
    this._reset();
  }

  /** clear() minus the reallocation — also the rebuild() entry, which reuses
   *  capacity (the same data is about to reload). */
  private _reset(): void {
    this._poolLen = 1; // node 0 = sentinel
    this._freeHead = 0;
    this._freeLen = 0;
    this._size = 0;
    const root = this._allocNode(0); // = 1; _parentCell[root] = 0 ⇒ parent cell 0 ⇒ root
    this._refs[0] = root | 0x20000000; // annotated root word: cnt 0, leaf
    const boxes = this._boxes;
    boxes[0] = Infinity; // never-intersect MBR: the root reject answers "empty"
    boxes[1] = Infinity; //  and the first insert's union-write seeds it — no
    boxes[2] = -Infinity; // empty-tree branch anywhere
    boxes[3] = -Infinity;
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
   * rates predict perfectly; `query()` is the wide-rect twin. Measured:
   * mask+branch wins probes by 5–10%, loses viewport-scale rects by 15–20%.
   */
  queryPrecise(qMinX: number, qMinY: number, qMaxX: number, qMaxY: number): number {
    const a = this._argBox;
    a[0] = qMinX;
    a[1] = qMinY;
    a[2] = qMaxX;
    a[3] = qMaxY;
    return this._queryPreciseArg();
  }

  private _queryPreciseArg(): number {
    const a = this._argBox;
    const qMinX = a[0];
    const qMinY = a[1];
    const qMaxX = a[2];
    const qMaxY = a[3];
    const boxes = this._boxes;
    // Whole-tree reject off the sentinel root MBR (empty tree included).
    if (qMinX > boxes[2] || qMaxX < boxes[0] || qMinY > boxes[3] || qMaxY < boxes[1]) return 0;
    const refs = this._refs;
    const res = this.results;
    const stack = this._stack;
    let n = 0;
    let sp = 0;
    let w = refs[0]; // annotated word: child | cnt<<24 | leaf<<29

    for (;;) {
      const cnt = (w >>> 24) & 31;
      const bBase = (w & 0xffffff) << 6;
      const rBase = (w & 0xffffff) << 4;

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
            res[n++] = refs[r];
          }
        }
      } else {
        for (let b = bBase, r = rBase, end = rBase + cnt; r < end; b += 4, r++) {
          const x0 = boxes[b];
          const y0 = boxes[b + 1];
          const x1 = boxes[b + 2];
          const y1 = boxes[b + 3];
          if (qMinX <= x1 && qMaxX >= x0 && qMinY <= y1 && qMaxY >= y0) {
            if (qMinX <= x0 && qMinY <= y0 && x1 <= qMaxX && y1 <= qMaxY) {
              // Entry fully covered — dump the subtree without further tests.
              n = this._allInto(refs[r], n, sp);
            } else {
              stack[sp++] = refs[r];
            }
          }
        }
      }
      if (sp === 0) break;
      w = stack[--sp];
    }
    return n;
  }

  /**
   * WIDE range query — viewport culls, marquees, zoom-out windows. Identical
   * result set and contract as `queryPrecise()`; only the leaf compaction
   * differs: fully branchless (unconditional store, conditional advance),
   * because the partially-covered leaves a wide rect visits run ~50% hit rates
   * (covered leaves bypass via the subtree dump) — the worst case for a branch
   * predictor, where a dead store beats a mispredict.
   */
  query(qMinX: number, qMinY: number, qMaxX: number, qMaxY: number): number {
    const a = this._argBox;
    a[0] = qMinX;
    a[1] = qMinY;
    a[2] = qMaxX;
    a[3] = qMaxY;
    return this._queryArg();
  }

  private _queryArg(): number {
    const a = this._argBox;
    const qMinX = a[0];
    const qMinY = a[1];
    const qMaxX = a[2];
    const qMaxY = a[3];
    const boxes = this._boxes;
    if (qMinX > boxes[2] || qMaxX < boxes[0] || qMinY > boxes[3] || qMaxY < boxes[1]) return 0;
    const refs = this._refs;
    const res = this.results;
    const stack = this._stack;
    let n = 0;
    let sp = 0;
    let w = refs[0];

    for (;;) {
      const cnt = (w >>> 24) & 31;
      const bBase = (w & 0xffffff) << 6;
      const rBase = (w & 0xffffff) << 4;

      if ((w & 0x20000000) !== 0) {
        // leaf — branchless compaction; capacity ≥ size covers every store.
        for (let b = bBase, r = rBase, end = rBase + cnt; r < end; b += 4, r++) {
          res[n] = refs[r];
          n +=
            ((qMinX <= boxes[b + 2]) as unknown as number) &
            ((qMaxX >= boxes[b]) as unknown as number) &
            ((qMinY <= boxes[b + 3]) as unknown as number) &
            ((qMaxY >= boxes[b + 1]) as unknown as number);
        }
      } else {
        for (let b = bBase, r = rBase, end = rBase + cnt; r < end; b += 4, r++) {
          const x0 = boxes[b];
          const y0 = boxes[b + 1];
          const x1 = boxes[b + 2];
          const y1 = boxes[b + 3];
          if (qMinX <= x1 && qMaxX >= x0 && qMinY <= y1 && qMaxY >= y0) {
            if (qMinX <= x0 && qMinY <= y0 && x1 <= qMaxX && y1 <= qMaxY) {
              n = this._allInto(refs[r], n, sp);
            } else {
              stack[sp++] = refs[r];
            }
          }
        }
      }
      if (sp === 0) break;
      w = stack[--sp];
    }
    return n;
  }

  /** Convenience wrapper: subarray view over `results` (valid until the next query). */
  search(minX: number, minY: number, maxX: number, maxY: number): Uint32Array {
    const n = this.queryPrecise(minX, minY, maxX, maxY);
    return this.results.subarray(0, n);
  }

  collides(qMinX: number, qMinY: number, qMaxX: number, qMaxY: number): boolean {
    const a = this._argBox;
    a[0] = qMinX;
    a[1] = qMinY;
    a[2] = qMaxX;
    a[3] = qMaxY;
    return this._collidesArg();
  }

  private _collidesArg(): boolean {
    const a = this._argBox;
    const qMinX = a[0];
    const qMinY = a[1];
    const qMaxX = a[2];
    const qMaxY = a[3];
    const boxes = this._boxes;
    if (qMinX > boxes[2] || qMaxX < boxes[0] || qMinY > boxes[3] || qMaxY < boxes[1]) return false;
    const refs = this._refs;
    const stack = this._stack;
    let sp = 0;
    let w = refs[0];

    for (;;) {
      const cnt = (w >>> 24) & 31;
      const bBase = (w & 0xffffff) << 6;
      const rBase = (w & 0xffffff) << 4;
      const isLeaf = (w & 0x20000000) !== 0;
      for (let b = bBase, r = rBase, end = rBase + cnt; r < end; b += 4, r++) {
        const x0 = boxes[b];
        const y0 = boxes[b + 1];
        const x1 = boxes[b + 2];
        const y1 = boxes[b + 3];
        if (qMinX <= x1 && qMaxX >= x0 && qMinY <= y1 && qMaxY >= y0) {
          // Non-root nodes are never empty, so a covered entry ⇒ some item exists.
          if (isLeaf || (qMinX <= x0 && qMinY <= y0 && x1 <= qMaxX && y1 <= qMaxY)) return true;
          stack[sp++] = refs[r];
        }
      }
      if (sp === 0) return false;
      w = stack[--sp];
    }
  }

  /** Fill `results` with every item id; returns the count (=== size). */
  queryAll(): number {
    if (this._size === 0) return 0;
    return this._allInto(this._refs[0], 0, 0);
  }

  all(): Uint32Array {
    const n = this.queryAll();
    return this.results.subarray(0, n);
  }

  // ────────────────────────────────────────────────────────────── bulk load ──

  /**
   * OMT bulk load (rbush's algorithm) of `count` items given as parallel
   * inputs: `ids[i]`, boxes[4i..4i+3] = [minX,minY,maxX,maxY]. Loading into a
   * non-empty tree builds a packed subtree and joins it at the proper level.
   * Cold path — allocates owned build scratch (OMT co-sorts its input).
   */
  load(count: number, ids: ArrayLike<number>, boxes: ArrayLike<number>): void {
    if (count === 0) return;
    if (ids.length < count || boxes.length < count << 2) throw new Error('FlatRTree: load inputs shorter than count');
    if (count < 7) {
      for (let i = 0; i < count; i++) {
        const j = i << 2;
        this.insert(ids[i], boxes[j], boxes[j + 1], boxes[j + 2], boxes[j + 3]);
      }
      return;
    }

    // A throw below (bad/duplicate id) is a corruption tripwire, not a
    // transaction — tree state after it is undefined.
    const bIds = new Uint32Array(count);
    const bBoxes = new Float64Array(count << 2);
    for (let i = 0; i < count; i++) {
      const id = ids[i];
      if (id >>> 0 !== id || id >= MAX_ID) throw new Error(`FlatRTree: invalid id: ${id}`);
      if (id >= this._cellOf.length) this._growCellOf(id);
      if (this._cellOf[id] !== 0) throw new Error(`FlatRTree: duplicate insert: ${id}`);
      this._cellOf[id] = PENDING; // also trips on a duplicate later in THIS batch
      bIds[i] = id;
    }
    const need = count << 2;
    if (boxes instanceof Float64Array) bBoxes.set(boxes.length === need ? boxes : boxes.subarray(0, need));
    else for (let i = 0; i < need; i++) bBoxes[i] = boxes[i];
    this._buildFrom(count, bIds, bBoxes);
  }

  /** load()'s tail — OMT-build `count` pre-validated items from OWNED
   *  co-sortable scratch (mutated in place) and join the subtree in. Also the
   *  rebuild() entry, which skips load()'s id validation + defensive copy. */
  private _buildFrom(count: number, bIds: Uint32Array, bBoxes: Float64Array): void {
    // Exact-fit pool reserve: the OMT recursion is deterministic, so an
    // arithmetic dry-run gives the node count exactly — no estimate, no
    // mid-build growth (which also licenses _buildNode's array reads to stay
    // valid across its own _allocNode calls). +16 covers the join path
    // (≤ height splits + 1 root).
    let height = Math.ceil(Math.log(count) / Math.log(16));
    if (height < 1) height = 1;
    const rootFanout = Math.ceil(count / 16 ** (height - 1));
    const need = this._poolLen - this._freeLen + omtNodeCount(count, rootFanout) + 16;
    if (need > this._poolCap) this._growPoolTo(need);

    const subAnn = this._buildNode(bIds, bBoxes, 0, count - 1, count <= 16 ? 0 : height, rootFanout);
    this._size += count;
    if (this._size > this.results.length) this._growResults(this._size);
    const sub = subAnn & 0xffffff;

    const rootW = this._refs[0];
    const rootIdx = rootW & 0xffffff;
    if (((rootW >>> 24) & 31) === 0) {
      // Empty tree — the built subtree becomes the root.
      this._freeNode(rootIdx);
      this._refs[0] = subAnn;
      this._parentCell[sub] &= 0xf0000000; // parent cell → 0 (root)
      this._recalcInto(sub, (subAnn >>> 24) & 31);
      const m = this._mbr;
      const boxes = this._boxes;
      boxes[0] = m[0];
      boxes[1] = m[1];
      boxes[2] = m[2];
      boxes[3] = m[3];
      return;
    }

    const hT = this._parentCell[rootIdx] >>> 28;
    const hS = this._parentCell[sub] >>> 28;
    this._recalcInto(sub, (subAnn >>> 24) & 31); // sub's MBR — needed in every case
    if (hS === hT) {
      // Same height — a new root holds both. The old root's MBR is cell 0
      // (exact by invariant) — no rescan.
      const nr = this._allocNode(hT + 1);
      const m = this._mbr;
      const boxes = this._boxes; // re-read: _allocNode may have grown the pool
      const refs = this._refs;
      const cell1 = nr << 4;
      const b = cell1 << 2;
      boxes[b] = boxes[0];
      boxes[b + 1] = boxes[1];
      boxes[b + 2] = boxes[2];
      boxes[b + 3] = boxes[3];
      boxes[b + 4] = m[0];
      boxes[b + 5] = m[1];
      boxes[b + 6] = m[2];
      boxes[b + 7] = m[3];
      refs[cell1] = rootW;
      refs[cell1 + 1] = subAnn;
      this._parentCell[rootIdx] = (hT << 28) | cell1;
      this._parentCell[sub] = (hS << 28) | (cell1 + 1);
      refs[0] = nr | (2 << 24); // internal, cnt 2
      boxes[0] = boxes[b] < m[0] ? boxes[b] : m[0];
      boxes[1] = boxes[b + 1] < m[1] ? boxes[b + 1] : m[1];
      boxes[2] = boxes[b + 2] > m[2] ? boxes[b + 2] : m[2];
      boxes[3] = boxes[b + 3] > m[3] ? boxes[b + 3] : m[3];
    } else if (hS < hT) {
      this._argBox.set(this._mbr);
      this._insertEntry(subAnn, hS + 1);
    } else {
      // Built subtree is taller — it becomes the root; the old root joins it.
      const boxes = this._boxes;
      const oMinX = boxes[0]; // old root MBR, exact by invariant — no rescan
      const oMinY = boxes[1];
      const oMaxX = boxes[2];
      const oMaxY = boxes[3];
      const m = this._mbr;
      this._refs[0] = subAnn;
      this._parentCell[sub] &= 0xf0000000;
      boxes[0] = m[0];
      boxes[1] = m[1];
      boxes[2] = m[2];
      boxes[3] = m[3];
      const a = this._argBox;
      a[0] = oMinX;
      a[1] = oMinY;
      a[2] = oMaxX;
      a[3] = oMaxY;
      this._insertEntry(rootW, hT + 1);
    }
  }

  /** Repack in place: gather all live entries, rebuild via OMT. Keeps buffer
   *  capacity — the same data reloads. (avlo: repackSpatialIndex.) */
  rebuild(): void {
    const n = this._size;
    if (n === 0) return;
    const ids = new Uint32Array(n);
    const gBoxes = new Float64Array(n << 2);
    const refs = this._refs;
    const boxes = this._boxes;
    const stack = this._stack;
    let sp = 0;
    let out = 0;
    let w = refs[0];
    for (;;) {
      const cnt = (w >>> 24) & 31;
      const bBase = (w & 0xffffff) << 6;
      const rBase = (w & 0xffffff) << 4;
      if ((w & 0x20000000) !== 0) {
        for (let e = 0; e < cnt; e++) {
          ids[out] = refs[rBase + e];
          const b = bBase + (e << 2);
          const o = out << 2;
          gBoxes[o] = boxes[b];
          gBoxes[o + 1] = boxes[b + 1];
          gBoxes[o + 2] = boxes[b + 2];
          gBoxes[o + 3] = boxes[b + 3];
          out++;
        }
      } else {
        for (let e = 0; e < cnt; e++) stack[sp++] = refs[rBase + e];
      }
      if (sp === 0) break;
      w = stack[--sp];
    }
    this._reset();
    this._buildFrom(n, ids, gBoxes);
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
    const arg = this._argBox;
    const iMinX = arg[0];
    const iMinY = arg[1];
    const iMaxX = arg[2];
    const iMaxY = arg[3];

    const ann = this._chooseSubtree(targetLevel);
    let node = ann & 0xffffff;
    let cnt = (ann >>> 24) & 31;
    let intoLeaf = ann & 0x20000000;

    let eMinX = iMinX;
    let eMinY = iMinY;
    let eMaxX = iMaxX;
    let eMaxY = iMaxY;
    let eWord = word;

    for (;;) {
      if (cnt < 16) {
        const cell = (node << 4) | cnt;
        const b = cell << 2;
        const boxes = this._boxes; // fresh read — a prior split may have grown the pool
        boxes[b] = eMinX;
        boxes[b + 1] = eMinY;
        boxes[b + 2] = eMaxX;
        boxes[b + 3] = eMaxY;
        this._refs[cell] = eWord;
        this._refs[this._parentCell[node] & 0x0fffffff] += 1 << 24; // count RMW in the parent word
        if (intoLeaf !== 0) this._cellOf[eWord] = cell;
        else {
          const c = eWord & 0xffffff;
          this._parentCell[c] = (this._parentCell[c] & 0xf0000000) | cell;
        }
        break;
      }

      // Overflow — split. The propagated entry travels through `_argBox`
      // (Smi/ref args only); redundant on the first hop, where it holds i*.
      arg[0] = eMinX;
      arg[1] = eMinY;
      arg[2] = eMaxX;
      arg[3] = eMaxY;
      const newNode = this._split(node, eWord);
      const g = this._splitMBR;
      const k = this._splitLeftCnt;
      const lvl = this._parentCell[node] >>> 28;
      const leafFlag = lvl === 0 ? 0x20000000 : 0;
      const pc = this._parentCell[node] & 0x0fffffff;

      if (pc === 0) {
        // Root split — a new root above both groups, written through cell 0.
        const nr = this._allocNode(lvl + 1);
        const boxes = this._boxes;
        const refs = this._refs;
        const cell1 = nr << 4;
        const b = cell1 << 2;
        boxes[b] = g[0];
        boxes[b + 1] = g[1];
        boxes[b + 2] = g[2];
        boxes[b + 3] = g[3];
        boxes[b + 4] = g[4];
        boxes[b + 5] = g[5];
        boxes[b + 6] = g[6];
        boxes[b + 7] = g[7];
        refs[cell1] = node | (k << 24) | leafFlag;
        refs[cell1 + 1] = newNode | ((17 - k) << 24) | leafFlag;
        this._parentCell[node] = (lvl << 28) | cell1;
        this._parentCell[newNode] = (lvl << 28) | (cell1 + 1);
        refs[0] = nr | (2 << 24);
        boxes[0] = g[0] < g[4] ? g[0] : g[4];
        boxes[1] = g[1] < g[5] ? g[1] : g[5];
        boxes[2] = g[2] > g[6] ? g[2] : g[6];
        boxes[3] = g[3] > g[7] ? g[3] : g[7];
        return; // exact everywhere, root MBR included — nothing to extend
      }

      // Exact overwrite of the kept group's parent entry (splits may tighten).
      const boxes = this._boxes;
      const wb = pc << 2;
      boxes[wb] = g[0];
      boxes[wb + 1] = g[1];
      boxes[wb + 2] = g[2];
      boxes[wb + 3] = g[3];
      this._refs[pc] = node | (k << 24) | leafFlag;

      eMinX = g[4];
      eMinY = g[5];
      eMaxX = g[6];
      eMaxY = g[7];
      eWord = newNode | ((17 - k) << 24) | leafFlag;
      node = pc >>> 4;
      cnt = (this._refs[this._parentCell[node] & 0x0fffffff] >>> 24) & 31;
      intoLeaf = 0;
    }

    // Extend ancestors by the ORIGINAL inserted box, early-exit on
    // containment. No root check: after cell 0 is extended, the walk lands on
    // the sentinel (whose parent cell is itself 0), finds the box contained,
    // and exits through the same early-out.
    const boxes = this._boxes;
    const parentCell = this._parentCell;
    let cur = node;
    for (;;) {
      const s = parentCell[cur] & 0x0fffffff;
      const b = s << 2;
      const x0 = boxes[b];
      const y0 = boxes[b + 1];
      const x1 = boxes[b + 2];
      const y1 = boxes[b + 3];
      if (x0 <= iMinX && y0 <= iMinY && x1 >= iMaxX && y1 >= iMaxY) return;
      boxes[b] = x0 < iMinX ? x0 : iMinX;
      boxes[b + 1] = y0 < iMinY ? y0 : iMinY;
      boxes[b + 2] = x1 > iMaxX ? x1 : iMaxX;
      boxes[b + 3] = y1 > iMaxY ? y1 : iMaxY;
      cur = s >>> 4;
    }
  }

  /**
   * Descend by least area enlargement (tie: least area) until reaching
   * `targetLevel`; the entry box is read from `_argBox`. For node-entry
   * inserts (targetLevel > 0) the descent also stops early if the chosen
   * child sits below the target level — legal in an OMT-mixed-level tree; the
   * entry then lands in the current node. Returns the annotated word of the
   * landing node.
   */
  private _chooseSubtree(targetLevel: number): number {
    const a = this._argBox;
    const minX = a[0];
    const minY = a[1];
    const maxX = a[2];
    const maxY = a[3];
    const boxes = this._boxes;
    const refs = this._refs;
    const parentCell = this._parentCell;
    let ann = refs[0];

    for (;;) {
      if ((ann & 0x20000000) !== 0) return ann;
      const node = ann & 0xffffff;
      if (targetLevel > 0 && parentCell[node] >>> 28 <= targetLevel) return ann;
      const cnt = (ann >>> 24) & 31;
      const bBase = node << 6;
      let bestEnl = Infinity;
      let bestArea = Infinity;
      let bestE = 0;
      for (let e = 0, b = bBase; e < cnt; e++, b += 4) {
        const x0 = boxes[b];
        const y0 = boxes[b + 1];
        const x1 = boxes[b + 2];
        const y1 = boxes[b + 3];
        const area = (x1 - x0) * (y1 - y0);
        const ex0 = minX < x0 ? minX : x0;
        const ey0 = minY < y0 ? minY : y0;
        const ex1 = maxX > x1 ? maxX : x1;
        const ey1 = maxY > y1 ? maxY : y1;
        const enl = (ex1 - ex0) * (ey1 - ey0) - area;
        // Single combined winner test: a strict-enlargement win RESETS the
        // tie-break area (rbush conditionally kept a losing entry's smaller
        // area here, making later legitimate ties lose against a stale value).
        if (enl < bestEnl || (enl === bestEnl && area < bestArea)) {
          bestEnl = enl;
          bestArea = area;
          bestE = e;
        }
      }
      const childW = refs[(node << 4) + bestE];
      if (targetLevel > 0 && parentCell[childW & 0xffffff] >>> 28 < targetLevel) return ann;
      ann = childW;
    }
  }

  /**
   * Split `node` (full, 16 entries) plus one extra entry (box in `_argBox`,
   * word `exWord`) into two groups using rbush's R*-flavored heuristic:
   * choose axis by total distribution margin, choose index by minimum overlap
   * (tie: minimum combined area). Prefix/suffix MBR tables make margins,
   * overlap, area, and both final group MBRs O(1) lookups. Group 1 rewrites
   * `node`, group 2 fills a fresh node; back-links (cellOf / parentCell) are
   * rewritten per distributed entry. Exact group MBRs land in `_splitMBR`,
   * the left group size in `_splitLeftCnt`. Returns the new node.
   */
  private _split(node: number, exWord: number): number {
    const sB = this._sBoxes;
    const sR = this._sRefs;
    const boxes = this._boxes;
    const refs = this._refs;
    const arg = this._argBox;
    const nb = node << 6;
    const nr = node << 4;

    for (let i = 0; i < 64; i++) sB[i] = boxes[nb + i];
    for (let e = 0; e < 16; e++) sR[e] = refs[nr + e];
    sB[64] = arg[0];
    sB[65] = arg[1];
    sB[66] = arg[2];
    sB[67] = arg[3];
    sR[16] = exWord;

    const oX = this._sOrderX;
    const oY = this._sOrderY;
    for (let i = 0; i < 17; i++) {
      oX[i] = i;
      oY[i] = i;
    }
    insertionSortByKey(oX, 17, sB, 0);
    insertionSortByKey(oY, 17, sB, 1);

    const xTot = this._fillPrefixSuffix(oX, this._sPX, this._sSX);
    const yTot = this._fillPrefixSuffix(oY, this._sPY, this._sSY);

    let order: Uint32Array;
    let P: Float64Array;
    let S: Float64Array;
    if (xTot < yTot) {
      order = oX;
      P = this._sPX;
      S = this._sSX;
    } else {
      order = oY;
      P = this._sPY;
      S = this._sSY;
    }

    // Choose split index k (left group size) in [7, 10]: min overlap, tie min area.
    let bestK = 7;
    let bestOverlap = Infinity;
    let bestArea = Infinity;
    for (let k = 7; k <= 10; k++) {
      const pk = k << 2;
      const p0 = P[pk];
      const p1 = P[pk + 1];
      const p2 = P[pk + 2];
      const p3 = P[pk + 3];
      const s0 = S[pk];
      const s1 = S[pk + 1];
      const s2 = S[pk + 2];
      const s3 = S[pk + 3];
      const ix0 = p0 > s0 ? p0 : s0;
      const iy0 = p1 > s1 ? p1 : s1;
      const ix1 = p2 < s2 ? p2 : s2;
      const iy1 = p3 < s3 ? p3 : s3;
      const ow = ix1 - ix0;
      const oh = iy1 - iy0;
      const overlap = (ow > 0 ? ow : 0) * (oh > 0 ? oh : 0);
      const area = (p2 - p0) * (p3 - p1) + (s2 - s0) * (s3 - s1);
      if (overlap < bestOverlap || (overlap === bestOverlap && area < bestArea)) {
        bestOverlap = overlap;
        bestArea = area;
        bestK = k;
      }
    }

    const lvl = this._parentCell[node] >>> 28;
    const newNode = this._allocNode(lvl);
    // _allocNode may grow the pool and detach the old arrays — re-read. The
    // hoists above were only for the scratch copy.
    const boxesW = this._boxes;
    const refsW = this._refs;
    const parentCellW = this._parentCell;
    const cellOf = this._cellOf;
    const mb = newNode << 6;
    const mr = newNode << 4;

    // Distribute: order[0..k) → node (rewritten), order[k..17) → newNode.
    for (let j = 0; j < bestK; j++) {
      const src = order[j];
      const sb = src << 2;
      const db = nb + (j << 2);
      boxesW[db] = sB[sb];
      boxesW[db + 1] = sB[sb + 1];
      boxesW[db + 2] = sB[sb + 2];
      boxesW[db + 3] = sB[sb + 3];
      const wv = sR[src];
      refsW[nr + j] = wv;
      if (lvl === 0) cellOf[wv] = nr + j;
      else parentCellW[wv & 0xffffff] = (parentCellW[wv & 0xffffff] & 0xf0000000) | (nr + j);
    }
    const n2 = 17 - bestK;
    for (let j = 0; j < n2; j++) {
      const src = order[bestK + j];
      const sb = src << 2;
      const db = mb + (j << 2);
      boxesW[db] = sB[sb];
      boxesW[db + 1] = sB[sb + 1];
      boxesW[db + 2] = sB[sb + 2];
      boxesW[db + 3] = sB[sb + 3];
      const wv = sR[src];
      refsW[mr + j] = wv;
      if (lvl === 0) cellOf[wv] = mr + j;
      else parentCellW[wv & 0xffffff] = (parentCellW[wv & 0xffffff] & 0xf0000000) | (mr + j);
    }

    const g = this._splitMBR;
    const pk = bestK << 2;
    g[0] = P[pk];
    g[1] = P[pk + 1];
    g[2] = P[pk + 2];
    g[3] = P[pk + 3];
    g[4] = S[pk];
    g[5] = S[pk + 1];
    g[6] = S[pk + 2];
    g[7] = S[pk + 3];
    this._splitLeftCnt = bestK;
    return newNode;
  }

  /**
   * Fill prefix MBRs (P[4c] = union of the first c entries in `order`) and
   * suffix MBRs (S[4i] = union of entries [i, 17)), then return the rbush
   * axis-goodness metric: Σ margin(P[k]) + margin(S[k]) for k in [7, 10].
   */
  private _fillPrefixSuffix(order: Uint32Array, P: Float64Array, S: Float64Array): number {
    const sB = this._sBoxes;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < 17; i++) {
      const b = order[i] << 2;
      const a0 = sB[b];
      const a1 = sB[b + 1];
      const a2 = sB[b + 2];
      const a3 = sB[b + 3];
      if (a0 < x0) x0 = a0;
      if (a1 < y0) y0 = a1;
      if (a2 > x1) x1 = a2;
      if (a3 > y1) y1 = a3;
      const w = (i + 1) << 2;
      P[w] = x0;
      P[w + 1] = y0;
      P[w + 2] = x1;
      P[w + 3] = y1;
    }
    x0 = Infinity;
    y0 = Infinity;
    x1 = -Infinity;
    y1 = -Infinity;
    for (let i = 16; i >= 0; i--) {
      const b = order[i] << 2;
      const a0 = sB[b];
      const a1 = sB[b + 1];
      const a2 = sB[b + 2];
      const a3 = sB[b + 3];
      if (a0 < x0) x0 = a0;
      if (a1 < y0) y0 = a1;
      if (a2 > x1) x1 = a2;
      if (a3 > y1) y1 = a3;
      const w = i << 2;
      S[w] = x0;
      S[w + 1] = y0;
      S[w + 2] = x1;
      S[w + 3] = y1;
    }
    let tot = 0;
    for (let k = 7; k <= 10; k++) {
      const pk = k << 2;
      tot += P[pk + 2] - P[pk] + (P[pk + 3] - P[pk + 1]);
      tot += S[pk + 2] - S[pk] + (S[pk + 3] - S[pk + 1]);
    }
    return tot;
  }

  // ─────────────────────────────────────────────────────────── removal core ──

  /** Swap-last removal of entry `pos` from `node` (whose parent entry is at
   *  `pc`, holding `cnt`). Positions are stored, so the moved entry's
   *  back-link is fixed in place: cellOf for leaf entries (`leafEntries` 1),
   *  parentCell for child entries. */
  private _removeEntryAt(node: number, pos: number, cnt: number, leafEntries: number, pc: number): void {
    const last = cnt - 1;
    if (pos !== last) {
      const boxes = this._boxes;
      const base = node << 6;
      const d = base + (pos << 2);
      const s = base + (last << 2);
      boxes[d] = boxes[s];
      boxes[d + 1] = boxes[s + 1];
      boxes[d + 2] = boxes[s + 2];
      boxes[d + 3] = boxes[s + 3];
      const rBase = node << 4;
      const moved = this._refs[rBase + last];
      this._refs[rBase + pos] = moved;
      const cell = rBase + pos;
      if (leafEntries !== 0) this._cellOf[moved] = cell;
      else this._parentCell[moved & 0xffffff] = (this._parentCell[moved & 0xffffff] & 0xf0000000) | cell;
    }
    this._refs[pc] -= 1 << 24;
  }

  /**
   * Post-removal maintenance from `node` upward: free emptied nodes
   * (cascading their parent entries out), collapse single-child internal
   * roots, then recompute exact MBRs bottom-up with an early exit — the walk
   * writes the root MBR at the sentinel like any other level.
   */
  private _afterRemoval(node: number): void {
    const parentCell = this._parentCell;
    const refs = this._refs;
    let pc = parentCell[node] & 0x0fffffff;
    let w = refs[pc];
    let cnt = (w >>> 24) & 31;

    while (cnt === 0 && pc !== 0) {
      const p = pc >>> 4;
      const ppc = parentCell[p] & 0x0fffffff;
      this._removeEntryAt(p, pc & 15, (refs[ppc] >>> 24) & 31, 0, ppc);
      this._freeNode(node);
      node = p;
      pc = ppc;
      w = refs[pc];
      cnt = (w >>> 24) & 31;
    }

    if (pc === 0) {
      // At the root — collapse chains of single-child internal roots.
      while ((w & 0x20000000) === 0 && cnt === 1) {
        const childW = refs[node << 4];
        const c = childW & 0xffffff;
        refs[0] = childW;
        parentCell[c] &= 0xf0000000; // parent cell → 0 (root)
        const boxes = this._boxes;
        const src = node << 6;
        boxes[0] = boxes[src]; // root MBR = the collapsed entry's box (exact)
        boxes[1] = boxes[src + 1];
        boxes[2] = boxes[src + 2];
        boxes[3] = boxes[src + 3];
        this._freeNode(node);
        node = c;
        w = childW;
        cnt = (w >>> 24) & 31;
      }
      if (cnt === 0) {
        // Tree emptied — root reverts to an empty leaf, MBR to never-intersect.
        refs[0] = node | 0x20000000;
        parentCell[node] = 0;
        const boxes = this._boxes;
        boxes[0] = Infinity;
        boxes[1] = Infinity;
        boxes[2] = -Infinity;
        boxes[3] = -Infinity;
        return;
      }
    }

    this._recalcInto(node, cnt);
    this._recalcUpFrom(node);
  }

  // ─────────────────────────────────────────────────────── MBR maintenance ──

  /** Exact MBR of `node`'s first `cnt` entries into `_mbr`. One contiguous scan. */
  private _recalcInto(node: number, cnt: number): void {
    const boxes = this._boxes;
    const base = node << 6;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let b = base, end = base + (cnt << 2); b < end; b += 4) {
      const a0 = boxes[b];
      const a1 = boxes[b + 1];
      const a2 = boxes[b + 2];
      const a3 = boxes[b + 3];
      if (a0 < x0) x0 = a0;
      if (a1 < y0) y0 = a1;
      if (a2 > x1) x1 = a2;
      if (a3 > y1) y1 = a3;
    }
    const m = this._mbr;
    m[0] = x0;
    m[1] = y0;
    m[2] = x1;
    m[3] = y1;
  }

  /** Write `node`'s exact MBR (seeded in `_mbr` by the caller) into its
   *  parent entry; while a level actually changed, recompute the parent's
   *  exact MBR and continue upward — cell 0 is the final level. The early
   *  exit fires on the first unchanged level, usually immediately. */
  private _recalcUpFrom(node: number): void {
    const seed = this._mbr;
    let x0 = seed[0];
    let y0 = seed[1];
    let x1 = seed[2];
    let y1 = seed[3];
    const boxes = this._boxes;
    const parentCell = this._parentCell;
    const refs = this._refs;
    for (;;) {
      const pc = parentCell[node] & 0x0fffffff;
      const b = pc << 2;
      if (boxes[b] === x0 && boxes[b + 1] === y0 && boxes[b + 2] === x1 && boxes[b + 3] === y1) return;
      boxes[b] = x0;
      boxes[b + 1] = y0;
      boxes[b + 2] = x1;
      boxes[b + 3] = y1;
      if (pc === 0) return; // just wrote the root MBR
      const p = pc >>> 4;
      this._recalcInto(p, (refs[parentCell[p] & 0x0fffffff] >>> 24) & 31);
      const m = this._mbr;
      x0 = m[0];
      y0 = m[1];
      x1 = m[2];
      y1 = m[3];
      node = p;
    }
  }

  // ─────────────────────────────────────────────────────────── OMT builder ──

  /** rbush's OMT recursion over the co-sorted (bIds, bBoxes) scratch.
   *  `fanout` is 16 except at the root call, where it is chosen to maximize
   *  utilization. Returns the built node's ANNOTATED word; parent linkage of
   *  the returned node is the caller's job. The pool was exact-reserved by
   *  _buildFrom, so no _allocNode below can grow it. */
  private _buildNode(bIds: Uint32Array, bBoxes: Float64Array, lo: number, hi: number, height: number, fanout: number): number {
    const N = hi - lo + 1;

    if (N <= 16) {
      const node = this._allocNode(0);
      const boxes = this._boxes;
      const refs = this._refs;
      const cellOf = this._cellOf;
      const bBase = node << 6;
      const rBase = node << 4;
      for (let i = 0; i < N; i++) {
        const s = (lo + i) << 2;
        const d = bBase + (i << 2);
        boxes[d] = bBoxes[s];
        boxes[d + 1] = bBoxes[s + 1];
        boxes[d + 2] = bBoxes[s + 2];
        boxes[d + 3] = bBoxes[s + 3];
        const id = bIds[lo + i];
        refs[rBase + i] = id;
        cellOf[id] = rBase + i;
      }
      return node | (N << 24) | 0x20000000;
    }

    const node = this._allocNode(height);
    const N2 = Math.ceil(N / fanout);
    const N1 = N2 * Math.ceil(Math.sqrt(fanout));

    multiSelect(bBoxes, bIds, lo, hi, N1, 0);
    let cnt = 0;
    for (let i = lo; i <= hi; i += N1) {
      const hi2 = Math.min(i + N1 - 1, hi);
      multiSelect(bBoxes, bIds, i, hi2, N2, 1);
      for (let j = i; j <= hi2; j += N2) {
        const hi3 = Math.min(j + N2 - 1, hi2);
        const childAnn = this._buildNode(bIds, bBoxes, j, hi3, height - 1, 16);
        const child = childAnn & 0xffffff;
        const cell = (node << 4) + cnt;
        this._parentCell[child] = (this._parentCell[child] & 0xf0000000) | cell;
        this._refs[cell] = childAnn;
        this._recalcInto(child, (childAnn >>> 24) & 31);
        const m = this._mbr;
        const d = cell << 2;
        const boxes = this._boxes;
        boxes[d] = m[0];
        boxes[d + 1] = m[1];
        boxes[d + 2] = m[2];
        boxes[d + 3] = m[3];
        cnt++;
      }
    }
    return node | (cnt << 24);
  }

  // ──────────────────────────────────────────────────────── pool + growth ──

  private _allocNode(level: number): number {
    let n: number;
    if (this._freeHead !== 0) {
      n = this._freeHead;
      this._freeHead = this._parentCell[n] & 0xffffff;
      this._freeLen--;
    } else {
      if (this._poolLen === this._poolCap) this._growPoolTo(this._poolCap + (this._poolCap >> 1) + 16);
      n = this._poolLen++;
    }
    this._parentCell[n] = level << 28;
    return n;
  }

  private _freeNode(n: number): void {
    this._parentCell[n] = 0xf0000000 | this._freeHead; // FREE tag; low bits = next
    this._freeHead = n;
    this._freeLen++;
  }

  /** Grow the pool to EXACTLY `cap` nodes (no rounding — capacity needs no
   *  power of two, only strides do, and those are literals). */
  private _growPoolTo(cap: number): void {
    if (cap > MAX_NODES) throw new Error('FlatRTree: pool exceeds 2^24 nodes');
    this._boxes = growF64(this._boxes, cap * 64);
    this._refs = growU32(this._refs, cap * 16);
    this._parentCell = growU32(this._parentCell, cap);
    this._poolCap = cap;
  }

  /** Cold path — callers inline the `id >= _cellOf.length` check. New space
   *  is zero = absent: no fill. */
  private _growCellOf(id: number): void {
    this._cellOf = growU32(this._cellOf, id + (id >> 1) + 16);
  }

  /** Called at MUTATION time only (capacity ≥ size invariant) — query bodies
   *  never grow, so `results`' identity is stable across queries. */
  private _growResults(need: number): Uint32Array {
    const next = growU32(this.results, need + (need >> 1) + 16);
    this.results = next;
    return next;
  }

  /** Dump every item under annotated word `w` into results from `n`; returns
   *  the new count. Refs-only — covered subtrees never touch box lines. */
  private _allInto(w: number, n: number, sp: number): number {
    const refs = this._refs;
    const res = this.results;
    const stack = this._stack;
    const bot = sp;
    stack[sp++] = w;
    while (sp > bot) {
      const v = stack[--sp];
      const cnt = (v >>> 24) & 31;
      const rBase = (v & 0xffffff) << 4;
      if ((v & 0x20000000) !== 0) {
        for (let e = 0; e < cnt; e++) res[n++] = refs[rBase + e];
      } else {
        for (let e = 0; e < cnt; e++) stack[sp++] = refs[rBase + e];
      }
    }
    return n;
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
    const refs = this._refs;
    const boxes = this._boxes;
    const parentCell = this._parentCell;
    const visited = new Set<number>();
    const seenIds = new Set<number>();
    const fail = (msg: string): never => {
      throw new Error(`FlatRTree.validate: ${msg}`);
    };

    if ((parentCell[0] & 0x0fffffff) !== 0) fail('sentinel parent cell not 0');
    if (this.results.length < this._size) fail(`results capacity ${this.results.length} < size ${this._size}`);

    const rootW = refs[0];
    const rootIdx = rootW & 0xffffff;
    if ((parentCell[rootIdx] & 0x0fffffff) !== 0) fail('root parent cell not 0');
    const rootCnt = (rootW >>> 24) & 31;
    if (rootCnt > 0) {
      this._recalcInto(rootIdx, rootCnt);
      const m = this._mbr;
      if (boxes[0] !== m[0] || boxes[1] !== m[1] || boxes[2] !== m[2] || boxes[3] !== m[3]) fail('root MBR not exact');
    } else if (boxes[0] !== Infinity || boxes[1] !== Infinity || boxes[2] !== -Infinity || boxes[3] !== -Infinity) {
      fail('empty root MBR not the never-intersect sentinel');
    }

    const stack: number[] = [rootW];
    while (stack.length) {
      const w = stack.pop() as number;
      const node = w & 0xffffff;
      if (visited.has(node)) fail(`node ${node} reachable twice`);
      visited.add(node);
      const cnt = (w >>> 24) & 31;
      const isLeaf = (w & 0x20000000) !== 0;
      const lvl = parentCell[node] >>> 28;
      if (isLeaf !== (lvl === 0)) fail(`node ${node} leaf bit ${isLeaf} vs level ${lvl}`);
      if (cnt > 16) fail(`node ${node} count ${cnt} > 16`);
      if (node !== rootIdx && cnt < 1) fail(`non-root node ${node} empty`);
      if (node === rootIdx && !isLeaf && cnt < 2) fail(`internal root has ${cnt} entries`);
      const bBase = node << 6;
      for (let e = 0; e < cnt; e++) {
        const cell = (node << 4) + e;
        const b = bBase + (e << 2);
        if (!(boxes[b] <= boxes[b + 2]) || !(boxes[b + 1] <= boxes[b + 3])) fail(`node ${node} entry ${e} degenerate box`);
        const v = refs[cell];
        if (isLeaf) {
          if (this._cellOf[v] !== cell) fail(`cellOf[${v}] !== cell ${cell}`);
          if (seenIds.has(v)) fail(`id ${v} present twice`);
          seenIds.add(v);
        } else {
          const c = v & 0xffffff;
          if ((parentCell[c] & 0x0fffffff) !== cell) fail(`parentCell[${c}] cell !== ${cell}`);
          const clv = parentCell[c] >>> 28;
          if (clv >= lvl) fail(`child ${c} level ${clv} >= parent level ${lvl}`);
          if (((v & 0x20000000) !== 0) !== (clv === 0)) fail(`child ${c} annotated leaf bit vs level ${clv}`);
          this._recalcInto(c, (v >>> 24) & 31);
          const m = this._mbr;
          if (boxes[b] !== m[0] || boxes[b + 1] !== m[1] || boxes[b + 2] !== m[2] || boxes[b + 3] !== m[3])
            fail(`node ${node} entry ${e} MBR not exact for child ${c}`);
          stack.push(v);
        }
      }
    }

    if (seenIds.size !== this._size) fail(`leaf entries ${seenIds.size} !== size ${this._size}`);
    for (let id = 0; id < this._cellOf.length; id++) {
      if (this._cellOf[id] !== 0 && !seenIds.has(id)) fail(`cellOf[${id}] set but id unreachable`);
    }

    let free = 0;
    for (let f = this._freeHead; f !== 0; f = parentCell[f] & 0xffffff) {
      if (parentCell[f] >>> 28 !== 0xf) fail(`free node ${f} lacks the FREE tag`);
      if (visited.has(f)) fail(`free node ${f} is reachable`);
      if (++free > this._poolLen) fail('free list cycle');
    }
    if (free !== this._freeLen) fail(`free list length ${free} !== ${this._freeLen}`);
    if (visited.size + free + 1 !== this._poolLen)
      fail(`pool leak: reachable ${visited.size} + free ${free} + sentinel !== ${this._poolLen}`);
  }

  stats(): FlatRTreeStats {
    const refs = this._refs;
    let leaves = 0;
    let leafFill = 0;
    let nodes = 0;
    const rootW = refs[0];
    const stack: number[] = [rootW];
    while (stack.length) {
      const w = stack.pop() as number;
      nodes++;
      const cnt = (w >>> 24) & 31;
      if ((w & 0x20000000) !== 0) {
        leaves++;
        leafFill += cnt;
      } else {
        const rBase = (w & 0xffffff) << 4;
        for (let e = 0; e < cnt; e++) stack.push(refs[rBase + e]);
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
    };
  }
}

// ────────────────────────────────────────────────────── module-level helpers ──

/** Exact node count of the OMT build for `n` items — the same control flow as
 *  _buildNode with the box work stripped to span arithmetic. Drives the
 *  exact-fit pool reserve; any drift from _buildNode's chunking breaks it. */
function omtNodeCount(n: number, fanout: number): number {
  if (n <= 16) return 1;
  const N2 = Math.ceil(n / fanout);
  const N1 = N2 * Math.ceil(Math.sqrt(fanout));
  let nodes = 1;
  for (let off = 0; off < n; off += N1) {
    const span = Math.min(N1, n - off);
    for (let o2 = 0; o2 < span; o2 += N2) nodes += omtNodeCount(Math.min(N2, span - o2), 16);
  }
  return nodes;
}

/** Insertion sort of the first `n` slots of `order` by sB[(order[i] << 2) + axisOff]. n = 17. */
function insertionSortByKey(order: Uint32Array, n: number, sB: Float64Array, axisOff: number): void {
  for (let i = 1; i < n; i++) {
    const v = order[i];
    const key = sB[(v << 2) + axisOff];
    let j = i - 1;
    while (j >= 0 && sB[(order[j] << 2) + axisOff] > key) {
      order[j + 1] = order[j];
      j--;
    }
    order[j + 1] = v;
  }
}

/** multiSelect's range stack — module scratch (single-threaded; multiSelect
 *  runs to completion before its caller continues, so it never nests). Live
 *  depth is O(log(range/n)) pairs; doubling covers any input regardless. */
let msStack = new Uint32Array(64);

/**
 * rbush's multiSelect: partially sort [lo, hi] so items fall into groups of
 * `n` with groups mutually ordered by bBoxes[(i<<2)+axisOff]. Build-time only.
 */
function multiSelect(bBoxes: Float64Array, bIds: Uint32Array, lo: number, hi: number, n: number, axisOff: number): void {
  let stack = msStack;
  let sp = 0;
  stack[sp++] = lo;
  stack[sp++] = hi;
  while (sp > 0) {
    hi = stack[--sp];
    lo = stack[--sp];
    if (hi - lo <= n) continue;
    const mid = lo + Math.ceil((hi - lo) / n / 2) * n;
    quickselectCo(bBoxes, bIds, mid, lo, hi, axisOff);
    if (sp + 4 > stack.length) {
      const next = new Uint32Array(stack.length * 2);
      next.set(stack);
      msStack = stack = next;
    }
    stack[sp++] = lo;
    stack[sp++] = mid;
    stack[sp++] = mid;
    stack[sp++] = hi;
  }
}

/**
 * Floyd–Rivest select (the algorithm behind rbush's `quickselect` dep),
 * co-swapping (4-double box, id) pairs. For ranges > 600 it first recurses on
 * a sampled subrange around k so the k-th element itself becomes a
 * near-optimal pivot, then Hoare-partitions — far fewer elements touched than
 * median-of-three at bulk-load scale.
 */
function quickselectCo(bBoxes: Float64Array, bIds: Uint32Array, k: number, lo: number, hi: number, axisOff: number): void {
  while (hi > lo) {
    if (hi - lo > 600) {
      const n = hi - lo + 1;
      const m = k - lo + 1;
      const z = Math.log(n);
      const s = 0.5 * Math.exp((2 * z) / 3);
      const sd = 0.5 * Math.sqrt((z * s * (n - s)) / n) * (m - n / 2 < 0 ? -1 : 1);
      const newLo = Math.max(lo, Math.floor(k - (m * s) / n + sd));
      const newHi = Math.min(hi, Math.floor(k + ((n - m) * s) / n + sd));
      quickselectCo(bBoxes, bIds, k, newLo, newHi, axisOff);
    }

    const t = bBoxes[(k << 2) + axisOff];
    let i = lo;
    let j = hi;

    swapCo(bBoxes, bIds, lo, k);
    if (bBoxes[(hi << 2) + axisOff] > t) swapCo(bBoxes, bIds, lo, hi);

    while (i < j) {
      swapCo(bBoxes, bIds, i, j);
      i++;
      j--;
      while (bBoxes[(i << 2) + axisOff] < t) i++;
      while (bBoxes[(j << 2) + axisOff] > t) j--;
    }

    if (bBoxes[(lo << 2) + axisOff] === t) swapCo(bBoxes, bIds, lo, j);
    else {
      j++;
      swapCo(bBoxes, bIds, j, hi);
    }

    if (j <= k) lo = j + 1;
    if (k <= j) hi = j - 1;
  }
}

function swapCo(bBoxes: Float64Array, bIds: Uint32Array, i: number, j: number): void {
  const bi = i << 2;
  const bj = j << 2;
  let t = bBoxes[bi];
  bBoxes[bi] = bBoxes[bj];
  bBoxes[bj] = t;
  t = bBoxes[bi + 1];
  bBoxes[bi + 1] = bBoxes[bj + 1];
  bBoxes[bj + 1] = t;
  t = bBoxes[bi + 2];
  bBoxes[bi + 2] = bBoxes[bj + 2];
  bBoxes[bj + 2] = t;
  t = bBoxes[bi + 3];
  bBoxes[bi + 3] = bBoxes[bj + 3];
  bBoxes[bj + 3] = t;
  const ti = bIds[i];
  bIds[i] = bIds[j];
  bIds[j] = ti;
}
