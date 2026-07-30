/**
 * FlatRTree — a mutable, flat, Structure-of-Arrays R-tree.
 *
 * Drop-in conceptual replacement for rbush aimed at the gap between rbush
 * (mutable, object-graph, GC-heavy) and flatbush (typed-array, but static):
 * rbush's algorithms (OMT bulk load, R*-ish margin/overlap split, least-
 * enlargement subtree choice) over a fully flat typed-array pool, plus the
 * things owning the layout makes possible — an id→leaf reverse map for O(1)
 * removal, an in-place `update()` that never restructures for small moves,
 * and allocation-free queries.
 *
 * ── Layout ──────────────────────────────────────────────────────────────────
 * A node is a fixed-capacity block of M entries. Entry boxes are stored IN THE
 * PARENT node (B-tree style), not on the child:
 *
 *   _boxes  : Float64Array — per node, M × [minX,minY,maxX,maxY], interleaved.
 *   _refs   : Uint32Array  — per node, M refs: child node index, or item id at leaves.
 *   _meta   : Uint32Array  — per node: count | (level << 8). level 0 ⇔ leaf,
 *                            so `meta < 256` is the leaf test.
 *   _parents: Uint32Array  — per node: parent node index (NONE for root);
 *                            doubles as the free-list `next` chain for freed nodes.
 *   _leafOf : Uint32Array  — per item id: leaf node containing it (NONE = absent).
 *
 * Scanning a node's children is therefore one contiguous read of ≤ 4M doubles
 * + ≤ M uint32s — no pointer chase per child, no toBBox() call, no property
 * walk. This is the structural fix for rbush's scattered `node.children[i]`
 * loads. M is forced to a power of two so every entry address is shift math:
 * box base = (node << boxShift) + (e << 2), ref = (node << refShift) + e.
 *
 * Positions are never stored: an entry's position inside its parent is found
 * by scanning ≤ M contiguous uint32 refs. That removes an entire class of
 * stale-position bookkeeping (swap-remove, split redistribution) for the cost
 * of a tiny linear scan.
 *
 * ── MBR discipline ──────────────────────────────────────────────────────────
 * Invariant (checked by validate()): every internal entry box EQUALS the exact
 * union of its child's entry boxes. Inserts keep it by extending ancestors
 * with the inserted box (old-exact ∪ item = new-exact along the descent path);
 * splits write exact group MBRs. remove/update first try an O(1) proof — a box
 * strictly inside its leaf's MBR (4 doubles read off the parent entry) defines
 * no MBR face, so nothing above can change — and otherwise recompute exact
 * MBRs bottom-up with an early exit on the first unchanged level. Exactness
 * keeps the tree tight under heavy churn (rbush only tightens on condense) and
 * makes validate() a strict-equality audit rather than a slack containment
 * check — it is also what licenses the O(1) tier.
 *
 * ── Ids ─────────────────────────────────────────────────────────────────────
 * Items are dense unsigned ints < 2^30 (MAX_ID; avlo: `handle.slot` — same id
 * space as ZRankTable / lock tables, so the reverse map stays tight).
 * `_leafOf` grows to the max id ever seen. The ceiling is checked at the
 * insert/load boundary and licenses loop-free clz32 growth everywhere.
 *
 * ── Argument channels (no doubles across call boundaries) ───────────────────
 * V8's tagged calling convention heap-allocates a HeapNumber for every
 * non-Smi number crossing a non-inlined call — measured here at ~325 ns and
 * ~250 young-gen GCs per 400k updates through the old scalar chain. Rule:
 * only Smi ints (ids, node refs, levels) are ever passed between methods.
 * Doubles travel through two construction-fixed Float64Array channels:
 * `_argBox` (the entry box: public wrappers write it, `_insertEntry` /
 * `_chooseSubtree` / `_split` / the query bodies read it at entry) and `_mbr`
 * (recalc results: `_recalcInto` writes, `_recalcUpFrom` seeds from it). The
 * public scalar methods are tiny wrappers (4 stores + a Smi call) that V8
 * inlines into hot callers, so caller-side doubles stay unboxed end-to-end.
 * Unlike the SoA pool arrays, these channels are never reallocated — safe to
 * hoist across `_allocNode`.
 *
 * ── Contracts (trusted-boundary, per repo invariants) ───────────────────────
 * - Boxes are finite with min ≤ max. Not re-validated.
 * - `insert` throws on duplicate or out-of-range id (corruption guard — two
 *   compares).
 * - `query()`/`queryWide()` fill `this.results` and return the count; the
 *   buffer is reused/regrown across calls — consume before the next
 *   query/mutation. They differ ONLY in leaf compaction: `query()` is tuned
 *   for narrow probes (hit tests), `queryWide()` for viewport-scale rects
 *   (culls) — the caller picks by construction, see the method docs.
 * - Zero allocation on insert/update/remove/query steady state (argument
 *   boxing included — see above); buffers grow geometrically, loop-free, and
 *   are retained.
 */

const NONE = 0xffffffff;
/** Transient `_leafOf` marker used inside load() to catch intra-batch duplicate
 *  ids. Never observable after load returns (every mark is overwritten by the
 *  build); distinct from NONE and from any real node index (the pool guard
 *  keeps node indices far below it). */
const PENDING = 0xfffffffe;
/** Id ceiling (exclusive): 2^30. Checked where ids enter (insert/load — same
 *  single compare as the previous 2^32−1 bound, tighter constant), which is
 *  what licenses the loop-free clz32 growth math below: every grow target
 *  stays a positive int32 power of two by precondition, with no overflow
 *  handling in the allocators. Far above any real slot count (ids are dense
 *  `handle.slot`s), and keeps NONE/PENDING unreachable by construction. */
const MAX_ID = 0x40000000;

export interface FlatRTreeStats {
  size: number;
  nodes: number;
  freeNodes: number;
  height: number;
  avgLeafFill: number;
  bytes: number;
}

export class FlatRTree {
  /** Max entries per node (power of two). */
  readonly maxEntries: number;
  /** Min entries per node for split distributions (rbush's 40% rule). */
  readonly minEntries: number;

  /** Query results — valid slots are [0, count) after query()/queryAll(). Aliased; regrown on demand. */
  results: Uint32Array;

  private _M: number;
  private _m: number;
  private _refShift: number; // log2(M)
  private _boxShift: number; // log2(M) + 2

  private _boxes: Float64Array;
  private _refs: Uint32Array;
  private _meta: Uint32Array;
  private _parents: Uint32Array;
  private _poolCap: number;
  private _poolLen: number;
  private _freeHead: number;
  private _freeLen: number;

  private _root: number;
  private _size: number;

  private _leafOf: Uint32Array;

  private _stack: Uint32Array;

  // ── split scratches (allocated once for E = M+1 entries) ──
  private _sBoxes: Float64Array; // E × 4 candidate entry boxes
  private _sRefs: Uint32Array; //   E candidate refs
  private _sOrderX: Uint32Array; // index permutation sorted by minX
  private _sOrderY: Uint32Array; // index permutation sorted by minY
  private _sPX: Float64Array; // prefix MBRs along X order: slot 4c = union of first c
  private _sSX: Float64Array; // suffix MBRs along X order: slot 4i = union of [i, E)
  private _sPY: Float64Array;
  private _sSY: Float64Array;
  private _splitMBR: Float64Array; // [g1 minX,minY,maxX,maxY, g2 minX,minY,maxX,maxY]

  private _mbr: Float64Array; // recalc scratch [minX,minY,maxX,maxY]
  private _argBox: Float64Array; // double-argument channel [minX,minY,maxX,maxY]

  constructor(maxEntries = 16) {
    let M = 4;
    while (M < maxEntries && M < 64) M <<= 1; // force power of two in [4, 64]
    this.maxEntries = M;
    this.minEntries = Math.max(2, Math.ceil(M * 0.4));
    this._M = M;
    this._m = this.minEntries;
    this._refShift = 31 - Math.clz32(M);
    this._boxShift = this._refShift + 2;

    const cap = 64;
    this._poolCap = cap;
    this._boxes = new Float64Array(cap << this._boxShift);
    this._refs = new Uint32Array(cap << this._refShift);
    this._meta = new Uint32Array(cap);
    this._parents = new Uint32Array(cap);
    this._poolLen = 0;
    this._freeHead = NONE;
    this._freeLen = 0;

    this._size = 0;
    this._leafOf = new Uint32Array(1024).fill(NONE);
    this.results = new Uint32Array(256);
    this._stack = new Uint32Array(256);

    const E = M + 1;
    this._sBoxes = new Float64Array(E << 2);
    this._sRefs = new Uint32Array(E);
    this._sOrderX = new Uint32Array(E);
    this._sOrderY = new Uint32Array(E);
    this._sPX = new Float64Array((E + 1) << 2);
    this._sSX = new Float64Array((E + 1) << 2);
    this._sPY = new Float64Array((E + 1) << 2);
    this._sSY = new Float64Array((E + 1) << 2);
    this._splitMBR = new Float64Array(8);
    this._mbr = new Float64Array(4);
    this._argBox = new Float64Array(4);

    this._root = this._allocNode(0);
  }

  get size(): number {
    return this._size;
  }

  has(id: number): boolean {
    return id < this._leafOf.length && this._leafOf[id] !== NONE;
  }

  /** Copy the stored box of `id` into out[0..3]. Returns false if absent. */
  readBBox(id: number, out: Float64Array | number[]): boolean {
    if (id >= this._leafOf.length) return false;
    const leaf = this._leafOf[id];
    if (leaf === NONE) return false;
    const pos = this._findPos(leaf, id);
    const b = (leaf << this._boxShift) + (pos << 2);
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
    if (id >= this._leafOf.length) this._growLeafOf(id);
    if (this._leafOf[id] !== NONE) throw new Error(`FlatRTree: duplicate insert: ${id}`);
    this._size++;
    this._insertEntry(id, 0);
  }

  /** Remove `id`. O(depth) via the reverse map — no tree search. */
  remove(id: number): boolean {
    if (id >= this._leafOf.length) return false;
    const leaf = this._leafOf[id];
    if (leaf === NONE) return false;
    this._leafOf[id] = NONE;
    this._size--;
    const pos = this._findPos(leaf, id);
    // O(1) tier: if the removed box sat strictly inside the leaf's MBR (read
    // off the parent entry — exact by invariant), every MBR face is defined by
    // a sibling, so no ancestor changes: swap-remove and stop. The cnt guard
    // keeps the cascade decision structural — never resting on float equality.
    const p = this._parents[leaf];
    if (p !== NONE && (this._meta[leaf] & 0xff) > 1) {
      const boxes = this._boxes;
      const ob = (leaf << this._boxShift) + (pos << 2);
      const pe = (p << this._boxShift) + (this._findPos(p, leaf) << 2);
      if (boxes[ob] > boxes[pe] && boxes[ob + 1] > boxes[pe + 1] && boxes[ob + 2] < boxes[pe + 2] && boxes[ob + 3] < boxes[pe + 3]) {
        this._removeEntryAt(leaf, pos);
        return true;
      }
    }
    this._removeEntryAt(leaf, pos);
    this._afterRemoval(leaf);
    return true;
  }

  /**
   * Upsert with tiered in-place fast paths. Tier 1 (O(1)): old box strictly
   * interior to the leaf's MBR and new box within it ⇒ overwrite, done —
   * no ancestor can change. Tier 2: new box still intersects the union of the
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
    const leafOf = this._leafOf;
    if (id >= leafOf.length || leafOf[id] === NONE) {
      this._insertNew(id);
      return;
    }
    const a = this._argBox;
    const minX = a[0];
    const minY = a[1];
    const maxX = a[2];
    const maxY = a[3];
    const leaf = leafOf[id];
    const pos = this._findPos(leaf, id);
    const boxes = this._boxes;
    const base = leaf << this._boxShift;
    const ob = base + (pos << 2);

    // O(1) fast tier: if the OLD box sits strictly inside the leaf's MBR (all
    // four faces defined by siblings — 4 doubles read off the parent entry,
    // exact by invariant) and the new box stays inside that MBR, the MBR is
    // provably unchanged and still exact: overwrite the entry and stop. Trades
    // the M-entry sibling scan for the _findPos(parent) that _recalcUpFrom
    // would have paid anyway. A sole occupant auto-misses (its box EQUALS the
    // parent entry), and a tier miss costs 8 compares before the full path.
    const p = this._parents[leaf];
    if (p !== NONE) {
      const pe = (p << this._boxShift) + (this._findPos(p, leaf) << 2);
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
    }

    const cnt = this._meta[leaf] & 0xff;
    if (cnt > 1) {
      // MBR of the leaf's OTHER entries (skip ob) — one contiguous scan.
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
        // Left its cluster — relocate structurally. `_argBox` still holds the
        // new box (nothing below writes it).
        this._leafOf[id] = NONE;
        this._removeEntryAt(leaf, pos);
        this._afterRemoval(leaf);
        this._insertEntry(id, 0);
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
      this._recalcUpFrom(leaf);
    } else {
      if (minX > boxes[ob + 2] || maxX < boxes[ob] || minY > boxes[ob + 3] || maxY < boxes[ob + 1]) {
        // Sole occupant teleported clear of its old box — relocate so the old
        // subtree's ancestor MBRs don't stay bloated around a far-away item.
        this._leafOf[id] = NONE;
        this._removeEntryAt(leaf, pos);
        this._afterRemoval(leaf);
        this._insertEntry(id, 0);
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
      this._recalcUpFrom(leaf);
    }
  }

  clear(): void {
    this._reset();
    this._leafOf.fill(NONE);
  }

  /** clear() minus the `_leafOf` fill — for rebuild(), whose builder rewrites
   *  every live id's slot (dead ids are already NONE from their removal). */
  private _reset(): void {
    this._poolLen = 0;
    this._freeHead = NONE;
    this._freeLen = 0;
    this._size = 0;
    this._root = this._allocNode(0);
  }

  // ──────────────────────────────────────────────────────────────── queries ──

  /**
   * NARROW range query — hit-test probes, snap radii, cursor picks. Fills
   * `this.results[0..n)` with item ids, returns n. Allocation-free at steady
   * state (buffers regrow geometrically).
   *
   * Two leaf compactions exist, selected by the CALLER (pickers are narrow by
   * construction, culls are wide by construction — no heuristics here): this
   * one branches once per entry on the AND-combined mask, which near-zero hit
   * rates predict perfectly; `queryWide()` is the wide-rect twin. Measured
   * (Zen 2): mask+branch wins probes by 5–10%, loses viewport-scale rects by
   * 15–20%; a short-circuit `&&` chain loses everywhere (its intermediate
   * branches are data-dependent).
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
    const refs = this._refs;
    const meta = this._meta;
    const boxShift = this._boxShift;
    const refShift = this._refShift;
    let res = this.results;
    let stack = this._stack;
    let n = 0;
    let sp = 0;
    let node = this._root;

    for (;;) {
      const md = meta[node];
      const cnt = md & 0xff;
      const bBase = node << boxShift;
      const rBase = node << refShift;

      if (md < 256) {
        // leaf — mask+branch: 4 unconditional loads, setcc-combined, ONE
        // branch per entry that probes predict near-perfectly (~0% hit rate).
        if (n + cnt > res.length) res = this._growResults(n + cnt);
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
        if (sp + cnt > stack.length) stack = this._growStack(sp + cnt);
        for (let b = bBase, r = rBase, end = rBase + cnt; r < end; b += 4, r++) {
          const x0 = boxes[b];
          const y0 = boxes[b + 1];
          const x1 = boxes[b + 2];
          const y1 = boxes[b + 3];
          if (qMinX <= x1 && qMaxX >= x0 && qMinY <= y1 && qMaxY >= y0) {
            if (qMinX <= x0 && qMinY <= y0 && x1 <= qMaxX && y1 <= qMaxY) {
              // Entry fully covered — dump the subtree without further tests.
              n = this._allInto(refs[r], n, sp);
              res = this.results;
              stack = this._stack;
            } else {
              stack[sp++] = refs[r];
            }
          }
        }
      }
      if (sp === 0) break;
      node = stack[--sp];
    }
    return n;
  }

  /**
   * WIDE range query — viewport culls, marquees, zoom-out windows. Identical
   * result set and contract as `query()`; only the leaf compaction differs:
   * fully branchless (unconditional store, conditional advance), because the
   * partially-covered leaves a wide rect visits run ~50% hit rates (covered
   * leaves bypass via the subtree dump) — the worst case for a branch
   * predictor, where a dead store beats a mispredict. See `query()` for the
   * caller-selection rule and measurements.
   */
  queryWide(qMinX: number, qMinY: number, qMaxX: number, qMaxY: number): number {
    const a = this._argBox;
    a[0] = qMinX;
    a[1] = qMinY;
    a[2] = qMaxX;
    a[3] = qMaxY;
    return this._queryWideArg();
  }

  private _queryWideArg(): number {
    const a = this._argBox;
    const qMinX = a[0];
    const qMinY = a[1];
    const qMaxX = a[2];
    const qMaxY = a[3];
    const boxes = this._boxes;
    const refs = this._refs;
    const meta = this._meta;
    const boxShift = this._boxShift;
    const refShift = this._refShift;
    let res = this.results;
    let stack = this._stack;
    let n = 0;
    let sp = 0;
    let node = this._root;

    for (;;) {
      const md = meta[node];
      const cnt = md & 0xff;
      const bBase = node << boxShift;
      const rBase = node << refShift;

      if (md < 256) {
        // leaf — branchless compaction; capacity for cnt stores pre-ensured.
        if (n + cnt > res.length) res = this._growResults(n + cnt);
        for (let b = bBase, r = rBase, end = rBase + cnt; r < end; b += 4, r++) {
          res[n] = refs[r];
          n +=
            ((qMinX <= boxes[b + 2]) as unknown as number) &
            ((qMaxX >= boxes[b]) as unknown as number) &
            ((qMinY <= boxes[b + 3]) as unknown as number) &
            ((qMaxY >= boxes[b + 1]) as unknown as number);
        }
      } else {
        if (sp + cnt > stack.length) stack = this._growStack(sp + cnt);
        for (let b = bBase, r = rBase, end = rBase + cnt; r < end; b += 4, r++) {
          const x0 = boxes[b];
          const y0 = boxes[b + 1];
          const x1 = boxes[b + 2];
          const y1 = boxes[b + 3];
          if (qMinX <= x1 && qMaxX >= x0 && qMinY <= y1 && qMaxY >= y0) {
            if (qMinX <= x0 && qMinY <= y0 && x1 <= qMaxX && y1 <= qMaxY) {
              // Entry fully covered — dump the subtree without further tests.
              n = this._allInto(refs[r], n, sp);
              res = this.results;
              stack = this._stack;
            } else {
              stack[sp++] = refs[r];
            }
          }
        }
      }
      if (sp === 0) break;
      node = stack[--sp];
    }
    return n;
  }

  /** Convenience wrapper: returns a subarray view over `results` (valid until the next query). */
  search(minX: number, minY: number, maxX: number, maxY: number): Uint32Array {
    const n = this.query(minX, minY, maxX, maxY);
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
    const refs = this._refs;
    const meta = this._meta;
    const boxShift = this._boxShift;
    const refShift = this._refShift;
    let stack = this._stack;
    let sp = 0;
    let node = this._root;

    for (;;) {
      const md = meta[node];
      const cnt = md & 0xff;
      const bBase = node << boxShift;
      const rBase = node << refShift;
      const leaf = md < 256;
      if (!leaf && sp + cnt > stack.length) stack = this._growStack(sp + cnt);
      for (let b = bBase, r = rBase, end = rBase + cnt; r < end; b += 4, r++) {
        const x0 = boxes[b];
        const y0 = boxes[b + 1];
        const x1 = boxes[b + 2];
        const y1 = boxes[b + 3];
        if (qMinX <= x1 && qMaxX >= x0 && qMinY <= y1 && qMaxY >= y0) {
          // Non-root nodes are never empty, so a covered entry ⇒ some item exists.
          if (leaf || (qMinX <= x0 && qMinY <= y0 && x1 <= qMaxX && y1 <= qMaxY)) return true;
          stack[sp++] = refs[r];
        }
      }
      if (sp === 0) return false;
      node = stack[--sp];
    }
  }

  /** Fill `results` with every item id; returns the count (=== size). */
  queryAll(): number {
    if (this._size === 0) return 0;
    if (this._size > this.results.length) this._growResults(this._size);
    return this._allInto(this._root, 0, 0);
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
   * Cold path — allocates build scratch.
   */
  load(count: number, ids: ArrayLike<number>, boxes: ArrayLike<number>): void {
    if (count === 0) return;
    if (ids.length < count || boxes.length < count << 2) throw new Error('FlatRTree: load inputs shorter than count');
    if (count < this._m) {
      for (let i = 0; i < count; i++) {
        const j = i << 2;
        this.insert(ids[i], boxes[j], boxes[j + 1], boxes[j + 2], boxes[j + 3]);
      }
      return;
    }

    // Owned, co-sorted build scratch. A throw below (bad/duplicate id) is a
    // corruption tripwire, not a transaction — tree state after it is undefined.
    const bIds = new Uint32Array(count);
    const bBoxes = new Float64Array(count << 2);
    for (let i = 0; i < count; i++) {
      const id = ids[i];
      if (id >>> 0 !== id || id >= MAX_ID) throw new Error(`FlatRTree: invalid id: ${id}`);
      if (id >= this._leafOf.length) this._growLeafOf(id);
      if (this._leafOf[id] !== NONE) throw new Error(`FlatRTree: duplicate insert: ${id}`);
      this._leafOf[id] = PENDING; // also trips on a duplicate later in THIS batch
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
    const M = this._M;
    // Pre-reserve the node pool: the OMT build needs ~count/(fill·M) leaves
    // (fill ≥ 0.7 in practice) plus ~1/(M−1) internals — reserving once
    // replaces the _growPoolTo doubling ladder, whose cumulative memcpy was
    // ~11% of a cold 1M load. Estimate-only: _allocNode still grows on miss.
    const est = this._poolLen + Math.ceil((count / (M - 1)) * 1.25) + 8;
    if (est > this._poolCap) {
      const target = 1 << (32 - Math.clz32(est - 1));
      // Reserve only when addressable — an over-estimate must never reject a
      // load that organic doubling (which throws only when truly needed) fits.
      if (target * (1 << this._boxShift) <= 0x7fffffff) this._growPoolTo(target);
    }
    let height = Math.ceil(Math.log(count) / Math.log(M));
    if (height < 1) height = 1;
    const rootFanout = Math.ceil(count / M ** (height - 1));
    const sub = this._buildNode(bIds, bBoxes, 0, count - 1, count <= M ? 0 : height, rootFanout);
    this._size += count;

    const rootMeta = this._meta[this._root];
    if ((rootMeta & 0xff) === 0 && rootMeta < 256) {
      // Empty tree — the built subtree becomes the root.
      this._freeNode(this._root);
      this._root = sub;
      this._parents[sub] = NONE;
      return;
    }

    const hT = this._meta[this._root] >>> 8;
    const hS = this._meta[sub] >>> 8;
    if (hS === hT) {
      const oldRoot = this._root;
      const nr = this._allocNode(hT + 1);
      const bBase = nr << this._boxShift;
      const rBase = nr << this._refShift;
      const bx = this._boxes;
      const mbr = this._mbr;
      this._recalcInto(oldRoot);
      bx[bBase] = mbr[0];
      bx[bBase + 1] = mbr[1];
      bx[bBase + 2] = mbr[2];
      bx[bBase + 3] = mbr[3];
      this._refs[rBase] = oldRoot;
      this._recalcInto(sub);
      bx[bBase + 4] = mbr[0];
      bx[bBase + 5] = mbr[1];
      bx[bBase + 6] = mbr[2];
      bx[bBase + 7] = mbr[3];
      this._refs[rBase + 1] = sub;
      this._meta[nr] = 2 | ((hT + 1) << 8);
      this._parents[oldRoot] = nr;
      this._parents[sub] = nr;
      this._root = nr;
    } else if (hS < hT) {
      this._recalcInto(sub);
      this._argBox.set(this._mbr);
      this._insertEntry(sub, hS + 1);
    } else {
      const oldRoot = this._root;
      this._root = sub;
      this._parents[sub] = NONE;
      this._recalcInto(oldRoot);
      this._argBox.set(this._mbr);
      this._insertEntry(oldRoot, hT + 1);
    }
  }

  /** Repack in place: gather all live entries, rebuild via OMT. (avlo: repackSpatialIndex.) */
  rebuild(): void {
    const n = this._size;
    if (n === 0) return;
    const ids = new Uint32Array(n);
    const boxes = new Float64Array(n << 2);
    const meta = this._meta;
    const refs = this._refs;
    const bx = this._boxes;
    const refShift = this._refShift;
    const boxShift = this._boxShift;
    let stack = this._stack;
    let sp = 0;
    let out = 0;
    let node = this._root;
    for (;;) {
      const md = meta[node];
      const cnt = md & 0xff;
      if (md < 256) {
        const bBase = node << boxShift;
        const rBase = node << refShift;
        for (let e = 0; e < cnt; e++) {
          ids[out] = refs[rBase + e];
          const b = bBase + (e << 2);
          const o = out << 2;
          boxes[o] = bx[b];
          boxes[o + 1] = bx[b + 1];
          boxes[o + 2] = bx[b + 2];
          boxes[o + 3] = bx[b + 3];
          out++;
        }
      } else {
        if (sp + cnt > stack.length) stack = this._growStack(sp + cnt);
        const rBase = node << refShift;
        for (let e = 0; e < cnt; e++) stack[sp++] = refs[rBase + e];
      }
      if (sp === 0) break;
      node = stack[--sp];
    }
    this._reset();
    this._buildFrom(n, ids, boxes);
  }

  // ──────────────────────────────────────────────────────── insertion core ──

  /**
   * Insert the entry whose box is in `_argBox` (item id at targetLevel 0, or a
   * subtree node ref at targetLevel = subtree level + 1). Handles overflow
   * splits bubbling to the root, then extends ancestor MBRs by the ORIGINAL
   * inserted box — every new region any split introduced is ⊆ old ∪ box, so
   * this single walk restores exactness at every level (see header).
   */
  private _insertEntry(ref: number, targetLevel: number): void {
    const M = this._M;
    const arg = this._argBox;
    const iMinX = arg[0];
    const iMinY = arg[1];
    const iMaxX = arg[2];
    const iMaxY = arg[3];
    let node = this._chooseSubtree(targetLevel);

    let eMinX = iMinX;
    let eMinY = iMinY;
    let eMaxX = iMaxX;
    let eMaxY = iMaxY;
    let eRef = ref;

    for (;;) {
      // _meta re-read each level, never hoisted across the loop: _split →
      // _allocNode may grow the pool and reallocate the SoA arrays.
      const md = this._meta[node];
      const cnt = md & 0xff;
      if (cnt < M) {
        const b = (node << this._boxShift) + (cnt << 2);
        const boxes = this._boxes;
        boxes[b] = eMinX;
        boxes[b + 1] = eMinY;
        boxes[b + 2] = eMaxX;
        boxes[b + 3] = eMaxY;
        this._refs[(node << this._refShift) + cnt] = eRef;
        this._meta[node] = md + 1;
        if (md < 256) this._leafOf[eRef] = node;
        else this._parents[eRef] = node;
        break;
      }

      // Propagated entry travels through `_argBox` (Smi/ref args only — see
      // header). Redundant on the first iteration, where it already holds i*.
      arg[0] = eMinX;
      arg[1] = eMinY;
      arg[2] = eMaxX;
      arg[3] = eMaxY;
      const newNode = this._split(node, eRef);
      const g = this._splitMBR;

      if (node === this._root) {
        const lv = (md >>> 8) + 1;
        const nr = this._allocNode(lv);
        const bBase = nr << this._boxShift;
        const rBase = nr << this._refShift;
        const boxes = this._boxes;
        boxes[bBase] = g[0];
        boxes[bBase + 1] = g[1];
        boxes[bBase + 2] = g[2];
        boxes[bBase + 3] = g[3];
        boxes[bBase + 4] = g[4];
        boxes[bBase + 5] = g[5];
        boxes[bBase + 6] = g[6];
        boxes[bBase + 7] = g[7];
        const refs = this._refs;
        refs[rBase] = node;
        refs[rBase + 1] = newNode;
        this._meta[nr] = 2 | (lv << 8);
        this._parents[node] = nr;
        this._parents[newNode] = nr;
        this._parents[nr] = NONE;
        this._root = nr;
        return; // both root entries written exact — nothing left to extend
      }

      const p = this._parents[node];
      const pos = this._findPos(p, node);
      const wb = (p << this._boxShift) + (pos << 2);
      const boxes = this._boxes;
      // Exact overwrite of the kept group's MBR (splits may tighten).
      boxes[wb] = g[0];
      boxes[wb + 1] = g[1];
      boxes[wb + 2] = g[2];
      boxes[wb + 3] = g[3];
      eMinX = g[4];
      eMinY = g[5];
      eMaxX = g[6];
      eMaxY = g[7];
      eRef = newNode;
      node = p;
    }

    // Extend ancestors by the original inserted box, early-exit on containment.
    const boxes = this._boxes;
    const parents = this._parents;
    for (;;) {
      const p = parents[node];
      if (p === NONE) return;
      const pos = this._findPos(p, node);
      const wb = (p << this._boxShift) + (pos << 2);
      const a = boxes[wb];
      const b = boxes[wb + 1];
      const c = boxes[wb + 2];
      const d = boxes[wb + 3];
      if (a <= iMinX && b <= iMinY && c >= iMaxX && d >= iMaxY) return;
      boxes[wb] = a < iMinX ? a : iMinX;
      boxes[wb + 1] = b < iMinY ? b : iMinY;
      boxes[wb + 2] = c > iMaxX ? c : iMaxX;
      boxes[wb + 3] = d > iMaxY ? d : iMaxY;
      node = p;
    }
  }

  /**
   * Descend by least area enlargement (tie: least area) until reaching
   * `targetLevel`; the entry box is read from `_argBox`. For node-entry
   * inserts (targetLevel > 0) the descent also stops early if the chosen
   * child sits below the target level — legal in an OMT-mixed-level tree; the
   * entry then lands in the current node.
   */
  private _chooseSubtree(targetLevel: number): number {
    const a = this._argBox;
    const minX = a[0];
    const minY = a[1];
    const maxX = a[2];
    const maxY = a[3];
    const boxes = this._boxes;
    const refs = this._refs;
    const meta = this._meta;
    const boxShift = this._boxShift;
    const refShift = this._refShift;
    let node = this._root;

    for (;;) {
      const md = meta[node];
      if (md >>> 8 <= targetLevel) break;
      const cnt = md & 0xff;
      const bBase = node << boxShift;
      let bestEnl = Infinity;
      let bestArea = Infinity;
      let best = 0;
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
        if (enl < bestEnl) {
          bestEnl = enl;
          if (area < bestArea) bestArea = area;
          best = e;
        } else if (enl === bestEnl && area < bestArea) {
          bestArea = area;
          best = e;
        }
      }
      const child = refs[(node << refShift) + best];
      if (targetLevel > 0 && meta[child] >>> 8 < targetLevel) break;
      node = child;
    }
    return node;
  }

  /**
   * Split `node` (full, M entries) plus one extra entry (box in `_argBox`)
   * into two groups using rbush's R*-flavored heuristic: choose axis by total
   * distribution margin, choose index by minimum overlap (tie: minimum
   * combined area). Prefix and suffix MBR tables make margins, overlap, area,
   * and both final group MBRs O(1) lookups. Writes group1 back into `node`,
   * group2 into a fresh node; re-links leafOf/parents for every distributed
   * entry; exact group MBRs land in `_splitMBR[0..7]`. Returns the new node.
   */
  private _split(node: number, exRef: number): number {
    const M = this._M;
    const E = M + 1;
    const m = this._m;
    const sB = this._sBoxes;
    const sR = this._sRefs;
    const boxes = this._boxes;
    const refs = this._refs;
    const arg = this._argBox;
    const nb = node << this._boxShift;
    const nr = node << this._refShift;

    for (let i = 0, lim = M << 2; i < lim; i++) sB[i] = boxes[nb + i];
    for (let e = 0; e < M; e++) sR[e] = refs[nr + e];
    const xb = M << 2;
    sB[xb] = arg[0];
    sB[xb + 1] = arg[1];
    sB[xb + 2] = arg[2];
    sB[xb + 3] = arg[3];
    sR[M] = exRef;

    const oX = this._sOrderX;
    const oY = this._sOrderY;
    for (let i = 0; i < E; i++) {
      oX[i] = i;
      oY[i] = i;
    }
    insertionSortByKey(oX, E, sB, 0);
    insertionSortByKey(oY, E, sB, 1);

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

    // Choose split index k (left group size) in [m, E-m]: min overlap, tie min area.
    let bestK = m;
    let bestOverlap = Infinity;
    let bestArea = Infinity;
    for (let k = m; k <= E - m; k++) {
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

    const lv = this._meta[node] >>> 8;
    const newNode = this._allocNode(lv);
    // _allocNode may grow the pool and reallocate the SoA arrays — the
    // pre-alloc `boxes`/`refs` hoists above are only safe for the scratch copy.
    const boxesW = this._boxes;
    const refsW = this._refs;
    const mb = newNode << this._boxShift;
    const mr = newNode << this._refShift;

    // Distribute: order[0..k) → node (rewritten), order[k..E) → newNode.
    for (let j = 0; j < bestK; j++) {
      const src = order[j];
      const sb = src << 2;
      const db = nb + (j << 2);
      boxesW[db] = sB[sb];
      boxesW[db + 1] = sB[sb + 1];
      boxesW[db + 2] = sB[sb + 2];
      boxesW[db + 3] = sB[sb + 3];
      refsW[nr + j] = sR[src];
    }
    const n2 = E - bestK;
    for (let j = 0; j < n2; j++) {
      const src = order[bestK + j];
      const sb = src << 2;
      const db = mb + (j << 2);
      boxesW[db] = sB[sb];
      boxesW[db + 1] = sB[sb + 1];
      boxesW[db + 2] = sB[sb + 2];
      boxesW[db + 3] = sB[sb + 3];
      refsW[mr + j] = sR[src];
    }
    this._meta[node] = bestK | (lv << 8);
    this._meta[newNode] = n2 | (lv << 8);

    if (lv === 0) {
      const leafOf = this._leafOf;
      for (let j = 0; j < bestK; j++) leafOf[refsW[nr + j]] = node;
      for (let j = 0; j < n2; j++) leafOf[refsW[mr + j]] = newNode;
    } else {
      const parents = this._parents;
      for (let j = 0; j < bestK; j++) parents[refsW[nr + j]] = node;
      for (let j = 0; j < n2; j++) parents[refsW[mr + j]] = newNode;
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
    return newNode;
  }

  /**
   * Fill prefix MBRs (P[4c] = union of the first c entries in `order`) and
   * suffix MBRs (S[4i] = union of entries [i, E)), then return the rbush
   * axis-goodness metric: Σ margin(P[k]) + margin(S[k]) for k in [m, E-m].
   */
  private _fillPrefixSuffix(order: Uint32Array, P: Float64Array, S: Float64Array): number {
    const E = this._M + 1;
    const m = this._m;
    const sB = this._sBoxes;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < E; i++) {
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
    for (let i = E - 1; i >= 0; i--) {
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
    for (let k = m; k <= E - m; k++) {
      const pk = k << 2;
      tot += P[pk + 2] - P[pk] + (P[pk + 3] - P[pk + 1]);
      tot += S[pk + 2] - S[pk] + (S[pk + 3] - S[pk + 1]);
    }
    return tot;
  }

  // ────────────────────────────────────────────────────────── removal core ──

  /** Swap-last removal of entry `pos` from `node`. Positions are never stored, so no fixups. */
  private _removeEntryAt(node: number, pos: number): void {
    const md = this._meta[node];
    const last = (md & 0xff) - 1;
    if (pos !== last) {
      const boxes = this._boxes;
      const bBase = node << this._boxShift;
      const d = bBase + (pos << 2);
      const s = bBase + (last << 2);
      boxes[d] = boxes[s];
      boxes[d + 1] = boxes[s + 1];
      boxes[d + 2] = boxes[s + 2];
      boxes[d + 3] = boxes[s + 3];
      const rBase = node << this._refShift;
      this._refs[rBase + pos] = this._refs[rBase + last];
    }
    this._meta[node] = md - 1;
  }

  /**
   * Post-removal maintenance from `node` upward: free emptied nodes (cascading
   * their parent entries out), collapse a single-child internal root, then
   * recompute exact MBRs bottom-up with an early exit. rbush-style: underfull
   * (< m) nodes are tolerated; only EMPTY nodes are removed. Heavy deletion
   * workloads can call rebuild() to repack.
   */
  private _afterRemoval(node: number): void {
    const meta = this._meta;
    const parents = this._parents;

    while (node !== this._root && (meta[node] & 0xff) === 0) {
      const p = parents[node];
      this._removeEntryAt(p, this._findPos(p, node));
      this._freeNode(node);
      node = p;
    }

    if (node === this._root) {
      // Collapse single-child internal roots. `node === _root` stays true
      // across iterations (both advance to the child together) — checked once.
      for (;;) {
        const md = meta[node];
        if (md < 256 || (md & 0xff) !== 1) break;
        const child = this._refs[node << this._refShift];
        parents[child] = NONE;
        this._freeNode(node);
        this._root = child;
        node = child;
      }
    }

    if (parents[node] !== NONE && (meta[node] & 0xff) > 0) {
      this._recalcInto(node);
      this._recalcUpFrom(node);
    }
  }

  // ─────────────────────────────────────────────────────── MBR maintenance ──

  /** Exact MBR of `node`'s entries into `_mbr`. One contiguous scan. */
  private _recalcInto(node: number): void {
    const boxes = this._boxes;
    const bBase = node << this._boxShift;
    const cnt = this._meta[node] & 0xff;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let b = bBase, end = bBase + (cnt << 2); b < end; b += 4) {
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

  /**
   * Write `node`'s exact MBR (seeded in `_mbr` by the caller) into its parent
   * entry; while a level actually changed, recompute the parent's exact MBR
   * and continue upward. The early exit fires on the first unchanged level —
   * for small updates that's usually immediately.
   */
  private _recalcUpFrom(node: number): void {
    const seed = this._mbr;
    let x0 = seed[0];
    let y0 = seed[1];
    let x1 = seed[2];
    let y1 = seed[3];
    const boxes = this._boxes;
    const parents = this._parents;
    for (;;) {
      const p = parents[node];
      if (p === NONE) return;
      const pos = this._findPos(p, node);
      const wb = (p << this._boxShift) + (pos << 2);
      if (boxes[wb] === x0 && boxes[wb + 1] === y0 && boxes[wb + 2] === x1 && boxes[wb + 3] === y1) return;
      boxes[wb] = x0;
      boxes[wb + 1] = y0;
      boxes[wb + 2] = x1;
      boxes[wb + 3] = y1;
      this._recalcInto(p);
      const m = this._mbr;
      x0 = m[0];
      y0 = m[1];
      x1 = m[2];
      y1 = m[3];
      node = p;
    }
  }

  // ─────────────────────────────────────────────────────────── OMT builder ──

  /**
   * rbush's OMT recursion over the co-sorted (bIds, bBoxes) scratch. `height`
   * 0 or N ≤ M ⇒ leaf. `fanout` is M except at the root call, where it is
   * chosen to maximize utilization. Returns the built node; parent linkage of
   * the returned node is the caller's job.
   */
  private _buildNode(bIds: Uint32Array, bBoxes: Float64Array, lo: number, hi: number, height: number, fanout: number): number {
    const N = hi - lo + 1;
    const M = this._M;

    if (N <= M) {
      const node = this._allocNode(0);
      const boxes = this._boxes;
      const refs = this._refs;
      const leafOf = this._leafOf;
      const bBase = node << this._boxShift;
      const rBase = node << this._refShift;
      for (let i = 0; i < N; i++) {
        const s = (lo + i) << 2;
        const d = bBase + (i << 2);
        boxes[d] = bBoxes[s];
        boxes[d + 1] = bBoxes[s + 1];
        boxes[d + 2] = bBoxes[s + 2];
        boxes[d + 3] = bBoxes[s + 3];
        const id = bIds[lo + i];
        refs[rBase + i] = id;
        leafOf[id] = node;
      }
      this._meta[node] = N; // level 0
      return node;
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
        const child = this._buildNode(bIds, bBoxes, j, hi3, height - 1, M);
        this._parents[child] = node;
        this._refs[(node << this._refShift) + cnt] = child;
        this._recalcInto(child);
        const m = this._mbr;
        const d = (node << this._boxShift) + (cnt << 2);
        const boxes = this._boxes;
        boxes[d] = m[0];
        boxes[d + 1] = m[1];
        boxes[d + 2] = m[2];
        boxes[d + 3] = m[3];
        cnt++;
      }
    }
    this._meta[node] = cnt | (height << 8);
    return node;
  }

  // ─────────────────────────────────────────────────────── pool + scratches ──

  private _allocNode(level: number): number {
    let n: number;
    if (this._freeHead !== NONE) {
      n = this._freeHead;
      this._freeHead = this._parents[n];
      this._freeLen--;
    } else {
      if (this._poolLen === this._poolCap) this._growPoolTo(this._poolCap * 2);
      n = this._poolLen++;
    }
    this._meta[n] = level << 8;
    this._parents[n] = NONE;
    return n;
  }

  private _freeNode(n: number): void {
    this._parents[n] = this._freeHead;
    this._meta[n] = 0;
    this._freeHead = n;
    this._freeLen++;
  }

  private _growPoolTo(cap: number): void {
    // Entry addressing is int32 shift math — refuse growth past the point
    // where `node << boxShift` would overflow (float compare, no wrap).
    if (cap * (1 << this._boxShift) > 0x7fffffff) throw new Error('FlatRTree: pool exceeds addressable size');
    const boxes = new Float64Array(cap << this._boxShift);
    boxes.set(this._boxes);
    this._boxes = boxes;
    const refs = new Uint32Array(cap << this._refShift);
    refs.set(this._refs);
    this._refs = refs;
    const meta = new Uint32Array(cap);
    meta.set(this._meta);
    this._meta = meta;
    const parents = new Uint32Array(cap);
    parents.set(this._parents);
    this._parents = parents;
    this._poolCap = cap;
  }

  // Loop-free growth: `1 << (32 − clz32(x))` is the smallest power of two
  // > x, and with ids < MAX_ID (checked at the insert/load boundary) plus
  // `need` bounded by size/pool structure, every target is a positive int32 —
  // overflow-free by precondition, ≥ 2× the current (power-of-two) length,
  // so amortized-O(1) growth is preserved with no loop to hang.

  /** Cold path — callers inline the `id >= _leafOf.length` check. */
  private _growLeafOf(id: number): void {
    const cur = this._leafOf.length;
    const next = new Uint32Array(1 << (32 - Math.clz32(id)));
    next.set(this._leafOf);
    next.fill(NONE, cur);
    this._leafOf = next;
  }

  private _growResults(need: number): Uint32Array {
    const next = new Uint32Array(1 << (32 - Math.clz32(need - 1)));
    next.set(this.results);
    this.results = next;
    return next;
  }

  private _growStack(need: number): Uint32Array {
    const next = new Uint32Array(1 << (32 - Math.clz32(need - 1)));
    next.set(this._stack);
    this._stack = next;
    return next;
  }

  /** Position of `ref` among `node`'s entries — ≤ M contiguous u32 compares. */
  private _findPos(node: number, ref: number): number {
    const refs = this._refs;
    const rBase = node << this._refShift;
    const end = rBase + (this._meta[node] & 0xff);
    for (let r = rBase; r < end; r++) if (refs[r] === ref) return r - rBase;
    throw new Error(`FlatRTree: ref ${ref} not found in node ${node}`);
  }

  /** Dump every item under `node` into results starting at `n`; returns the new count. */
  private _allInto(node: number, n: number, sp: number): number {
    const meta = this._meta;
    const refs = this._refs;
    const refShift = this._refShift;
    let res = this.results;
    let stack = this._stack;
    const base = sp;
    if (sp + 1 > stack.length) stack = this._growStack(sp + 1);
    stack[sp++] = node;
    while (sp > base) {
      const nd = stack[--sp];
      const md = meta[nd];
      const cnt = md & 0xff;
      const rBase = nd << refShift;
      if (md < 256) {
        if (n + cnt > res.length) res = this._growResults(n + cnt);
        for (let e = 0; e < cnt; e++) res[n++] = refs[rBase + e];
      } else {
        if (sp + cnt > stack.length) stack = this._growStack(sp + cnt);
        for (let e = 0; e < cnt; e++) stack[sp++] = refs[rBase + e];
      }
    }
    return n;
  }

  // ──────────────────────────────────────────────────── audit + diagnostics ──

  /**
   * Full structural audit — throws on the first violation. Checks tree
   * linkage (parents/leafOf bidirectionality), meta sanity, EXACT MBR
   * equality at every internal entry, reverse-map completeness, and pool
   * accounting (reachable + free = allocated). Test/debug use; allocates.
   */
  validate(): void {
    const meta = this._meta;
    const refs = this._refs;
    const boxes = this._boxes;
    const parents = this._parents;
    const M = this._M;
    const visited = new Set<number>();
    const seenIds = new Set<number>();
    const fail = (msg: string): never => {
      throw new Error(`FlatRTree.validate: ${msg}`);
    };

    if (parents[this._root] !== NONE) fail('root has a parent');
    const stack: number[] = [this._root];
    while (stack.length) {
      const node = stack.pop() as number;
      if (visited.has(node)) fail(`node ${node} reachable twice`);
      visited.add(node);
      const md = meta[node];
      const cnt = md & 0xff;
      const lv = md >>> 8;
      if (cnt > M) fail(`node ${node} count ${cnt} > M`);
      if (node !== this._root && cnt < 1) fail(`non-root node ${node} empty`);
      if (node === this._root && lv > 0 && cnt < 2) fail(`internal root has ${cnt} entries`);
      const bBase = node << this._boxShift;
      const rBase = node << this._refShift;
      for (let e = 0; e < cnt; e++) {
        const b = bBase + (e << 2);
        if (!(boxes[b] <= boxes[b + 2]) || !(boxes[b + 1] <= boxes[b + 3])) fail(`node ${node} entry ${e} degenerate box`);
        const ref = refs[rBase + e];
        if (lv === 0) {
          if (this._leafOf[ref] !== node) fail(`leafOf[${ref}] !== leaf ${node}`);
          if (seenIds.has(ref)) fail(`id ${ref} present twice`);
          seenIds.add(ref);
        } else {
          if (parents[ref] !== node) fail(`parents[${ref}] !== ${node}`);
          const clv = meta[ref] >>> 8;
          if (clv >= lv) fail(`child ${ref} level ${clv} >= parent level ${lv}`);
          this._recalcInto(ref);
          const m = this._mbr;
          if (boxes[b] !== m[0] || boxes[b + 1] !== m[1] || boxes[b + 2] !== m[2] || boxes[b + 3] !== m[3])
            fail(`node ${node} entry ${e} MBR not exact for child ${ref}`);
          stack.push(ref);
        }
      }
    }

    if (seenIds.size !== this._size) fail(`leaf entries ${seenIds.size} !== size ${this._size}`);
    for (let id = 0; id < this._leafOf.length; id++) {
      const leaf = this._leafOf[id];
      if (leaf !== NONE && !seenIds.has(id)) fail(`leafOf[${id}] set but id unreachable`);
    }

    let free = 0;
    for (let f = this._freeHead; f !== NONE; f = parents[f]) {
      if (visited.has(f)) fail(`free node ${f} is reachable`);
      if (++free > this._poolLen) fail('free list cycle');
    }
    if (free !== this._freeLen) fail(`free list length ${free} !== ${this._freeLen}`);
    if (visited.size + free !== this._poolLen) fail(`pool leak: reachable ${visited.size} + free ${free} !== allocated ${this._poolLen}`);
  }

  stats(): FlatRTreeStats {
    const meta = this._meta;
    let leaves = 0;
    let leafFill = 0;
    const stack: number[] = [this._root];
    let nodes = 0;
    while (stack.length) {
      const node = stack.pop() as number;
      nodes++;
      const md = meta[node];
      const cnt = md & 0xff;
      if (md < 256) {
        leaves++;
        leafFill += cnt;
      } else {
        const rBase = node << this._refShift;
        for (let e = 0; e < cnt; e++) stack.push(this._refs[rBase + e]);
      }
    }
    return {
      size: this._size,
      nodes,
      freeNodes: this._freeLen,
      height: (meta[this._root] >>> 8) + 1,
      avgLeafFill: leaves ? leafFill / (leaves * this._M) : 0,
      bytes:
        this._boxes.byteLength +
        this._refs.byteLength +
        this._meta.byteLength +
        this._parents.byteLength +
        this._leafOf.byteLength +
        this.results.byteLength +
        this._stack.byteLength,
    };
  }
}

// ────────────────────────────────────────────────────── module-level helpers ──

/** Insertion sort of the first `n` slots of `order` by sB[(order[i] << 2) + axisOff]. n ≤ M+1. */
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
