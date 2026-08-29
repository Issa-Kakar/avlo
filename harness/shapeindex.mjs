// packages/editor/src/lib/editor/managers/SpatialIndexManager/FlatRTree.ts
var MAX_ID = 1073741824;
var MAX_NODES = 16777216;
var PENDING = 1;
var POOL_CAP0 = 8;
var ID_CAP0 = 256;
var RESULTS_CAP0 = 256;
var STACK_CAP = 1024;
var EMPTY_U32 = new Uint32Array(0);
var EMPTY_I32 = new Int32Array(0);
var EMPTY_F64 = new Float64Array(0);
var growF64 = (a, len) => {
  const next = new Float64Array(len);
  next.set(a);
  return next;
};
var growU32 = (a, len) => {
  const next = new Uint32Array(len);
  next.set(a);
  return next;
};
var FlatRTree = class {
  /** Query results — valid slots are [0, n) after search() or searchPrecise().
   *  Identity changes only at mutation time (capacity ≥ size invariant). */
  results;
  _boxes;
  //      per cell: [minX,minY,maxX,maxY] at cell << 2
  _refs;
  //        per cell: item id (leaf) or annotated child word
  _parentCell;
  //  per node: parent cell | level << 28 (0xF = freed)
  _cellOf;
  //      per id: owning cell, 0 = absent
  _poolCap;
  _poolLen;
  _freeHead;
  // 0 = empty free list (node 0 is the unfreeable sentinel)
  _freeLen;
  _size;
  _stack;
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
  _sF;
  _sU;
  _splitMBR;
  // [g1 minX,minY,maxX,maxY, g2 minX,minY,maxX,maxY]
  _splitLeftCnt = 0;
  //      left group size chosen by the last _split
  _mbr;
  //    recalc channel [minX,minY,maxX,maxY]
  _argBox;
  // double-argument channel [minX,minY,maxX,maxY]
  // ── build-transient load-engine lanes — EMPTY sentinels between builds.
  //    _buildFrom allocates them (24 B/item), the OMT recursion hoists them
  //    into locals per call, and _buildFrom resets them before returning:
  //    zero retention at any scope.
  _lk = EMPTY_I32;
  //   record key lane [0, count) + scatter half at +count
  _li = EMPTY_I32;
  //   record index lane, same shape
  _tk = EMPTY_I32;
  //   _lk.subarray(count) — the scatter half
  _ti = EMPTY_I32;
  //   _li.subarray(count)
  _kx = EMPTY_I32;
  //   sortable center-X key per ORIGINAL item index
  _ky = EMPTY_I32;
  //   sortable center-Y key per ORIGINAL item index
  _hist = EMPTY_I32;
  // 4 histogram banks × 256, keyed by shift
  constructor() {
    this._stack = new Uint32Array(STACK_CAP);
    this._sF = new Float64Array(249);
    this._sU = new Uint32Array(68);
    this._splitMBR = new Float64Array(8);
    this._mbr = new Float64Array(4);
    this._argBox = new Float64Array(4);
    this.clear();
  }
  getSize() {
    return this._size;
  }
  has(id) {
    const cellOf = this._cellOf;
    return id < cellOf.length && cellOf[id] !== 0;
  }
  /** True when `id` is present and its stored box equals the given one exactly.
   *  The incremental-update path uses this to drop no-op upserts without
   *  materializing the stored box (O(1) — direct cell addressing). */
  matchesBBox(id, minX, minY, maxX, maxY) {
    const cellOf = this._cellOf;
    if (id >= cellOf.length) return false;
    const cell = cellOf[id];
    if (cell === 0) return false;
    const b = cell << 2;
    const boxes = this._boxes;
    return boxes[b] === minX && boxes[b + 1] === minY && boxes[b + 2] === maxX && boxes[b + 3] === maxY;
  }
  // ─────────────────────────────────────────────────────────────── mutation ──
  insert(id, minX, minY, maxX, maxY) {
    const a = this._argBox;
    a[0] = minX;
    a[1] = minY;
    a[2] = maxX;
    a[3] = maxY;
    this._insertNew(id);
  }
  /** Guarded insert of an id known-or-checked absent; box already in `_argBox`. */
  _insertNew(id) {
    if (id >>> 0 !== id || id >= MAX_ID) throw new Error(`FlatRTree: invalid id: ${id}`);
    if (id >= this._cellOf.length) this._growCellOf(id);
    if (this._cellOf[id] !== 0) throw new Error(`FlatRTree: duplicate insert: ${id}`);
    const size = ++this._size;
    if (size > this.results.length) this._growResults(size);
    this._insertEntry(id, 0);
  }
  /** Remove `id`. O(1) when its box is strictly interior; O(depth) otherwise. */
  remove(id) {
    const cellOf = this._cellOf;
    if (id >= cellOf.length) return false;
    const cell = cellOf[id];
    if (cell === 0) return false;
    cellOf[id] = 0;
    this._size--;
    const node = cell >>> 4;
    const pc = this._parentCell[node] & 268435455;
    const cnt = this._refs[pc] >>> 24 & 31;
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
  update(id, minX, minY, maxX, maxY) {
    const a = this._argBox;
    a[0] = minX;
    a[1] = minY;
    a[2] = maxX;
    a[3] = maxY;
    this._updateArg(id);
  }
  _updateArg(id) {
    const cellOf = this._cellOf;
    const cell = id < cellOf.length ? cellOf[id] : 0;
    if (cell === 0) {
      this._insertNew(id);
      return;
    }
    const a = this._argBox;
    const minX = a[0];
    const minY = a[1];
    const maxX = a[2];
    const maxY = a[3];
    const node = cell >>> 4;
    const ob = cell << 2;
    const boxes = this._boxes;
    const pc = this._parentCell[node] & 268435455;
    const pe = pc << 2;
    const p0 = boxes[pe];
    const p1 = boxes[pe + 1];
    const p2 = boxes[pe + 2];
    const p3 = boxes[pe + 3];
    if (boxes[ob] > p0 && boxes[ob + 1] > p1 && boxes[ob + 2] < p2 && boxes[ob + 3] < p3 && minX >= p0 && minY >= p1 && maxX <= p2 && maxY <= p3) {
      boxes[ob] = minX;
      boxes[ob + 1] = minY;
      boxes[ob + 2] = maxX;
      boxes[ob + 3] = maxY;
      return;
    }
    const cnt = this._refs[pc] >>> 24 & 31;
    if (cnt > 1) {
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
  _relocate(id, cell, node, cnt, pc) {
    this._cellOf[id] = 0;
    this._removeEntryAt(node, cell & 15, cnt, 1, pc);
    this._afterRemoval(node);
    this._insertEntry(id, 0);
  }
  /** Reset to newborn state, RELEASING all growable buffers — a cleared tree
   *  carries no high-water memory into the next room. Construction-fixed
   *  scratches (stack, split arena, channels) are tiny and stay. */
  clear() {
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
  _reset() {
    this._poolLen = 1;
    this._freeHead = 0;
    this._freeLen = 0;
    this._size = 0;
    const root = this._allocNode(0);
    this._refs[0] = root | 536870912;
    const boxes = this._boxes;
    boxes[0] = Infinity;
    boxes[1] = Infinity;
    boxes[2] = -Infinity;
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
   * rates predict perfectly; `search()` is the wide-rect twin. Measured:
   * mask+branch wins probes by 5–10%, loses viewport-scale rects by 15–20%.
   */
  searchPrecise(qMinX, qMinY, qMaxX, qMaxY) {
    const a = this._argBox;
    a[0] = qMinX;
    a[1] = qMinY;
    a[2] = qMaxX;
    a[3] = qMaxY;
    return this._searchPreciseArg();
  }
  _searchPreciseArg() {
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
    for (; ; ) {
      const ni = w & 16777215;
      const cnt = w >>> 24 & 31;
      const bBase = ni << 6;
      const rBase = ni << 4;
      if ((w & 536870912) !== 0) {
        for (let b = bBase, r = rBase, end = rBase + cnt; r < end; b += 4, r++) {
          if (qMinX <= boxes[b + 2] & qMaxX >= boxes[b] & qMinY <= boxes[b + 3] & qMaxY >= boxes[b + 1]) {
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
   * result set and contract as `searchPrecise()`; only the leaf compaction
   * differs: fully branchless (unconditional store, conditional advance),
   * because the partially-covered leaves a wide rect visits run ~50% hit rates
   * (covered leaves bypass via the subtree dump) — the worst case for a branch
   * predictor, where a dead store beats a mispredict.
   */
  search(qMinX, qMinY, qMaxX, qMaxY) {
    const a = this._argBox;
    a[0] = qMinX;
    a[1] = qMinY;
    a[2] = qMaxX;
    a[3] = qMaxY;
    return this._searchArg();
  }
  _searchArg() {
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
    for (; ; ) {
      const ni = w & 16777215;
      const cnt = w >>> 24 & 31;
      const bBase = ni << 6;
      const rBase = ni << 4;
      if ((w & 536870912) !== 0) {
        for (let b = bBase, r = rBase, end = rBase + cnt; r < end; b += 4, r++) {
          res[n] = refs[r];
          n += qMinX <= boxes[b + 2] & qMaxX >= boxes[b] & qMinY <= boxes[b + 3] & qMaxY >= boxes[b + 1];
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
  load(count, ids, boxes) {
    if (count === 0) return;
    if (ids.length < count || boxes.length < count << 2)
      throw new Error("FlatRTree: load inputs shorter than count");
    if (count < 7) {
      for (let i = 0; i < count; i++) {
        const j = i << 2;
        this.insert(ids[i], boxes[j], boxes[j + 1], boxes[j + 2], boxes[j + 3]);
      }
      return;
    }
    const own = ids instanceof Uint32Array;
    const bIds = own ? ids : new Uint32Array(count);
    let cellOf = this._cellOf;
    for (let i = 0; i < count; i++) {
      const id = ids[i];
      if (id >>> 0 !== id || id >= MAX_ID) throw new Error(`FlatRTree: invalid id: ${id}`);
      if (id >= cellOf.length) {
        this._growCellOf(id);
        cellOf = this._cellOf;
      }
      if (cellOf[id] !== 0) throw new Error(`FlatRTree: duplicate insert: ${id}`);
      cellOf[id] = PENDING;
      if (!own) bIds[i] = id;
    }
    let bBoxes;
    if (boxes instanceof Float64Array)
      bBoxes = boxes;
    else {
      const need = count << 2;
      bBoxes = new Float64Array(need);
      for (let i = 0; i < need; i++) bBoxes[i] = boxes[i];
    }
    this._buildFrom(count, bIds, bBoxes);
  }
  /** load()'s tail — OMT-build `count` pre-validated items and join the
   *  subtree in. Inputs are READ-ONLY (gathers go by original index). Also
   *  the rebuild() entry, which skips load()'s id validation. */
  _buildFrom(count, bIds, bBoxes) {
    let height = Math.ceil(Math.log(count) / Math.log(16));
    if (height < 1) height = 1;
    const rootFanout = Math.ceil(count / 16 ** (height - 1));
    const need = this._poolLen - this._freeLen + omtNodeCount(count, rootFanout) + 16;
    if (need > this._poolCap) this._growPoolTo(need);
    const lk = new Int32Array(count << 1);
    const li = new Int32Array(count << 1);
    const kx = new Int32Array(count);
    const ky = new Int32Array(count);
    this._lk = lk;
    this._li = li;
    this._tk = lk.subarray(count);
    this._ti = li.subarray(count);
    this._kx = kx;
    this._ky = ky;
    this._hist = new Int32Array(1024);
    const rootShift = seedKeys(bBoxes, count, kx, ky, lk, li);
    const subAnn = this._buildNode(
      bIds,
      bBoxes,
      0,
      count - 1,
      count <= 16 ? 0 : height,
      rootFanout,
      rootShift
    );
    this._lk = EMPTY_I32;
    this._li = EMPTY_I32;
    this._tk = EMPTY_I32;
    this._ti = EMPTY_I32;
    this._kx = EMPTY_I32;
    this._ky = EMPTY_I32;
    this._hist = EMPTY_I32;
    this._size += count;
    if (this._size > this.results.length) this._growResults(this._size);
    const sub = subAnn & 16777215;
    const rootW = this._refs[0];
    const rootIdx = rootW & 16777215;
    if ((rootW >>> 24 & 31) === 0) {
      this._freeNode(rootIdx);
      this._refs[0] = subAnn;
      this._parentCell[sub] &= 4026531840;
      this._recalcInto(sub, subAnn >>> 24 & 31);
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
    this._recalcInto(sub, subAnn >>> 24 & 31);
    if (hS === hT) {
      const nr = this._allocNode(hT + 1);
      const m = this._mbr;
      const boxes = this._boxes;
      const refs = this._refs;
      const parentCell = this._parentCell;
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
      parentCell[rootIdx] = hT << 28 | cell1;
      parentCell[sub] = hS << 28 | cell1 + 1;
      refs[0] = nr | 2 << 24;
      boxes[0] = boxes[b] < m[0] ? boxes[b] : m[0];
      boxes[1] = boxes[b + 1] < m[1] ? boxes[b + 1] : m[1];
      boxes[2] = boxes[b + 2] > m[2] ? boxes[b + 2] : m[2];
      boxes[3] = boxes[b + 3] > m[3] ? boxes[b + 3] : m[3];
    } else if (hS < hT) {
      this._argBox.set(this._mbr);
      this._insertEntry(subAnn, hS + 1);
    } else {
      const boxes = this._boxes;
      const oMinX = boxes[0];
      const oMinY = boxes[1];
      const oMaxX = boxes[2];
      const oMaxY = boxes[3];
      const m = this._mbr;
      this._refs[0] = subAnn;
      this._parentCell[sub] &= 4026531840;
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
   *  capacity — the same data reloads. Call after a period of heavy churn. */
  rebuild() {
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
    for (; ; ) {
      const ni = w & 16777215;
      const cnt = w >>> 24 & 31;
      const bBase = ni << 6;
      const rBase = ni << 4;
      if ((w & 536870912) !== 0) {
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
  _insertEntry(word, targetLevel) {
    const arg = this._argBox;
    const iMinX = arg[0];
    const iMinY = arg[1];
    const iMaxX = arg[2];
    const iMaxY = arg[3];
    const ann = this._chooseSubtree(targetLevel);
    let node = ann & 16777215;
    let cnt = ann >>> 24 & 31;
    let intoLeaf = ann & 536870912;
    let eMinX = iMinX;
    let eMinY = iMinY;
    let eMaxX = iMaxX;
    let eMaxY = iMaxY;
    let eWord = word;
    for (; ; ) {
      if (cnt < 16) {
        const cell = node << 4 | cnt;
        const b = cell << 2;
        const boxes3 = this._boxes;
        const refs2 = this._refs;
        const parentCell2 = this._parentCell;
        boxes3[b] = eMinX;
        boxes3[b + 1] = eMinY;
        boxes3[b + 2] = eMaxX;
        boxes3[b + 3] = eMaxY;
        refs2[cell] = eWord;
        refs2[parentCell2[node] & 268435455] += 1 << 24;
        if (intoLeaf !== 0) this._cellOf[eWord] = cell;
        else {
          const c = eWord & 16777215;
          parentCell2[c] = parentCell2[c] & 4026531840 | cell;
        }
        break;
      }
      arg[0] = eMinX;
      arg[1] = eMinY;
      arg[2] = eMaxX;
      arg[3] = eMaxY;
      const newNode = this._split(node, eWord);
      const g = this._splitMBR;
      const k = this._splitLeftCnt;
      const pcw = this._parentCell[node];
      const lvl = pcw >>> 28;
      const leafFlag = lvl === 0 ? 536870912 : 0;
      const pc = pcw & 268435455;
      if (pc === 0) {
        const nr = this._allocNode(lvl + 1);
        const boxes3 = this._boxes;
        const refs2 = this._refs;
        const parentCell2 = this._parentCell;
        const cell1 = nr << 4;
        const b = cell1 << 2;
        boxes3[b] = g[0];
        boxes3[b + 1] = g[1];
        boxes3[b + 2] = g[2];
        boxes3[b + 3] = g[3];
        boxes3[b + 4] = g[4];
        boxes3[b + 5] = g[5];
        boxes3[b + 6] = g[6];
        boxes3[b + 7] = g[7];
        refs2[cell1] = node | k << 24 | leafFlag;
        refs2[cell1 + 1] = newNode | 17 - k << 24 | leafFlag;
        parentCell2[node] = lvl << 28 | cell1;
        parentCell2[newNode] = lvl << 28 | cell1 + 1;
        refs2[0] = nr | 2 << 24;
        boxes3[0] = g[0] < g[4] ? g[0] : g[4];
        boxes3[1] = g[1] < g[5] ? g[1] : g[5];
        boxes3[2] = g[2] > g[6] ? g[2] : g[6];
        boxes3[3] = g[3] > g[7] ? g[3] : g[7];
        return;
      }
      const boxes2 = this._boxes;
      const refs = this._refs;
      const wb = pc << 2;
      boxes2[wb] = g[0];
      boxes2[wb + 1] = g[1];
      boxes2[wb + 2] = g[2];
      boxes2[wb + 3] = g[3];
      refs[pc] = node | k << 24 | leafFlag;
      eMinX = g[4];
      eMinY = g[5];
      eMaxX = g[6];
      eMaxY = g[7];
      eWord = newNode | 17 - k << 24 | leafFlag;
      node = pc >>> 4;
      cnt = refs[this._parentCell[node] & 268435455] >>> 24 & 31;
      intoLeaf = 0;
    }
    const boxes = this._boxes;
    const parentCell = this._parentCell;
    let cur = node;
    for (; ; ) {
      const s = parentCell[cur] & 268435455;
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
   * inserts (`targetLevel > 0`) the descent also stops early if the chosen
   * child sits below the target level — legal in an OMT-mixed-level tree; the
   * entry then lands in the current node. Returns the annotated word of the
   * landing node.
   */
  _chooseSubtree(targetLevel) {
    const a = this._argBox;
    const minX = a[0];
    const minY = a[1];
    const maxX = a[2];
    const maxY = a[3];
    const boxes = this._boxes;
    const refs = this._refs;
    const parentCell = this._parentCell;
    let ann = refs[0];
    for (; ; ) {
      if ((ann & 536870912) !== 0) return ann;
      const node = ann & 16777215;
      if (targetLevel > 0 && parentCell[node] >>> 28 <= targetLevel) return ann;
      const cnt = ann >>> 24 & 31;
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
        if (enl < bestEnl || enl === bestEnl && area < bestArea) {
          bestEnl = enl;
          bestArea = area;
          bestE = e;
        }
      }
      const childW = refs[(node << 4) + bestE];
      if (targetLevel > 0 && parentCell[childW & 16777215] >>> 28 < targetLevel) return ann;
      ann = childW;
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
  _split(node, exWord) {
    const sF = this._sF;
    const sU = this._sU;
    const boxes = this._boxes;
    const refs = this._refs;
    const arg = this._argBox;
    const nb = node << 6;
    const nr = node << 4;
    for (let e = 0, b = nb, r = nr, d = 0; e < 16; e++, b += 4, r++, d += 4) {
      const x0 = boxes[b];
      const y0 = boxes[b + 1];
      const x1 = boxes[b + 2];
      const y1 = boxes[b + 3];
      sF[d] = x0;
      sF[d + 1] = y0;
      sF[d + 2] = x1;
      sF[d + 3] = y1;
      sF[68 + e] = x0;
      sF[85 + e] = y0;
      sF[102 + e] = x1;
      sF[119 + e] = y1;
      sU[e] = refs[r];
      sU[17 + e] = e;
      sU[34 + e] = e;
    }
    sF[64] = arg[0];
    sF[65] = arg[1];
    sF[66] = arg[2];
    sF[67] = arg[3];
    sF[84] = arg[0];
    sF[101] = arg[1];
    sF[118] = arg[2];
    sF[135] = arg[3];
    sU[16] = exWord;
    sU[33] = 16;
    sU[50] = 16;
    sortPairs17(sF, 68, sU, 17);
    sortPairs17(sF, 85, sU, 34);
    const mx = fillReducedTable17(sF, sU, 17, 153);
    const my = fillReducedTable17(sF, sU, 34, 185);
    let ordMin;
    let kMaxBase;
    let tMin;
    if (mx < my) {
      ordMin = 17;
      kMaxBase = 102;
      tMin = 153;
    } else {
      ordMin = 34;
      kMaxBase = 119;
      tMin = 185;
    }
    for (let i = 0; i < 17; i++) {
      const v = sU[ordMin + i];
      sU[51 + i] = v;
      sF[136 + i] = sF[kMaxBase + v];
    }
    sortPairs17(sF, 136, sU, 51);
    fillReducedTable17(sF, sU, 51, 217);
    let bestK = 7;
    let bestT = tMin;
    let bestOrd = ordMin;
    let bestOverlap = Infinity;
    let bestArea = Infinity;
    for (let t = 0; t < 2; t++) {
      const tb = t === 0 ? tMin : 217;
      const ob = t === 0 ? ordMin : 51;
      for (let k = 7; k <= 10; k++) {
        const s = tb + (k - 7 << 3);
        const p0 = sF[s];
        const p1 = sF[s + 1];
        const p2 = sF[s + 2];
        const p3 = sF[s + 3];
        const s0 = sF[s + 4];
        const s1 = sF[s + 5];
        const s2 = sF[s + 6];
        const s3 = sF[s + 7];
        const ix0 = p0 > s0 ? p0 : s0;
        const iy0 = p1 > s1 ? p1 : s1;
        const ix1 = p2 < s2 ? p2 : s2;
        const iy1 = p3 < s3 ? p3 : s3;
        const ow = ix1 - ix0;
        const oh = iy1 - iy0;
        const overlap = (ow > 0 ? ow : 0) * (oh > 0 ? oh : 0);
        const area = (p2 - p0) * (p3 - p1) + (s2 - s0) * (s3 - s1);
        if (overlap < bestOverlap || overlap === bestOverlap && area < bestArea) {
          bestOverlap = overlap;
          bestArea = area;
          bestK = k;
          bestT = tb;
          bestOrd = ob;
        }
      }
    }
    const lvl = this._parentCell[node] >>> 28;
    const newNode = this._allocNode(lvl);
    const boxesW = this._boxes;
    const refsW = this._refs;
    const parentCellW = this._parentCell;
    const cellOf = this._cellOf;
    const mb = newNode << 6;
    const mr = newNode << 4;
    for (let j = 0; j < bestK; j++) {
      const src = sU[bestOrd + j];
      const sb = src << 2;
      const db = nb + (j << 2);
      boxesW[db] = sF[sb];
      boxesW[db + 1] = sF[sb + 1];
      boxesW[db + 2] = sF[sb + 2];
      boxesW[db + 3] = sF[sb + 3];
      const wv = sU[src];
      const cell = nr + j;
      refsW[cell] = wv;
      if (lvl === 0) cellOf[wv] = cell;
      else {
        const ci = wv & 16777215;
        parentCellW[ci] = parentCellW[ci] & 4026531840 | cell;
      }
    }
    const n2 = 17 - bestK;
    const obk = bestOrd + bestK;
    for (let j = 0; j < n2; j++) {
      const src = sU[obk + j];
      const sb = src << 2;
      const db = mb + (j << 2);
      boxesW[db] = sF[sb];
      boxesW[db + 1] = sF[sb + 1];
      boxesW[db + 2] = sF[sb + 2];
      boxesW[db + 3] = sF[sb + 3];
      const wv = sU[src];
      const cell = mr + j;
      refsW[cell] = wv;
      if (lvl === 0) cellOf[wv] = cell;
      else {
        const ci = wv & 16777215;
        parentCellW[ci] = parentCellW[ci] & 4026531840 | cell;
      }
    }
    const g = this._splitMBR;
    const gs = bestT + (bestK - 7 << 3);
    g[0] = sF[gs];
    g[1] = sF[gs + 1];
    g[2] = sF[gs + 2];
    g[3] = sF[gs + 3];
    g[4] = sF[gs + 4];
    g[5] = sF[gs + 5];
    g[6] = sF[gs + 6];
    g[7] = sF[gs + 7];
    this._splitLeftCnt = bestK;
    return newNode;
  }
  // ─────────────────────────────────────────────────────────── removal core ──
  /** Swap-last removal of entry `pos` from `node` (whose parent entry is at
   *  `pc`, holding `cnt`). Positions are stored, so the moved entry's
   *  back-link is fixed in place: cellOf for leaf entries (`leafEntries` 1),
   *  parentCell for child entries. */
  _removeEntryAt(node, pos, cnt, leafEntries, pc) {
    const refs = this._refs;
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
      const moved = refs[rBase + last];
      const cell = rBase + pos;
      refs[cell] = moved;
      if (leafEntries !== 0) this._cellOf[moved] = cell;
      else {
        const parentCell = this._parentCell;
        const mi = moved & 16777215;
        parentCell[mi] = parentCell[mi] & 4026531840 | cell;
      }
    }
    refs[pc] -= 1 << 24;
  }
  /**
   * Post-removal maintenance from `node` upward: free emptied nodes
   * (cascading their parent entries out), collapse single-child internal
   * roots, then recompute exact MBRs bottom-up with an early exit — the walk
   * writes the root MBR at the sentinel like any other level.
   */
  _afterRemoval(node) {
    const parentCell = this._parentCell;
    const refs = this._refs;
    let pc = parentCell[node] & 268435455;
    let w = refs[pc];
    let cnt = w >>> 24 & 31;
    while (cnt === 0 && pc !== 0) {
      const p = pc >>> 4;
      const ppc = parentCell[p] & 268435455;
      this._removeEntryAt(p, pc & 15, refs[ppc] >>> 24 & 31, 0, ppc);
      this._freeNode(node);
      node = p;
      pc = ppc;
      w = refs[pc];
      cnt = w >>> 24 & 31;
    }
    if (pc === 0) {
      while ((w & 536870912) === 0 && cnt === 1) {
        const childW = refs[node << 4];
        const c = childW & 16777215;
        refs[0] = childW;
        parentCell[c] &= 4026531840;
        const boxes = this._boxes;
        const src = node << 6;
        boxes[0] = boxes[src];
        boxes[1] = boxes[src + 1];
        boxes[2] = boxes[src + 2];
        boxes[3] = boxes[src + 3];
        this._freeNode(node);
        node = c;
        w = childW;
        cnt = w >>> 24 & 31;
      }
      if (cnt === 0) {
        refs[0] = node | 536870912;
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
  _recalcInto(node, cnt) {
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
  _recalcUpFrom(node) {
    const seed = this._mbr;
    let x0 = seed[0];
    let y0 = seed[1];
    let x1 = seed[2];
    let y1 = seed[3];
    const boxes = this._boxes;
    const parentCell = this._parentCell;
    const refs = this._refs;
    for (; ; ) {
      const pc = parentCell[node] & 268435455;
      const b = pc << 2;
      if (boxes[b] === x0 && boxes[b + 1] === y0 && boxes[b + 2] === x1 && boxes[b + 3] === y1)
        return;
      boxes[b] = x0;
      boxes[b + 1] = y0;
      boxes[b + 2] = x1;
      boxes[b + 3] = y1;
      if (pc === 0) return;
      const p = pc >>> 4;
      this._recalcInto(p, refs[parentCell[p] & 268435455] >>> 24 & 31);
      const m = this._mbr;
      x0 = m[0];
      y0 = m[1];
      x1 = m[2];
      y1 = m[3];
      node = p;
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
  _buildNode(bIds, bBoxes, lo, hi, height, fanout, xShift) {
    const N = hi - lo + 1;
    const li = this._li;
    if (N <= 16) {
      const node2 = this._allocNode(0);
      const boxes2 = this._boxes;
      const refs2 = this._refs;
      const cellOf = this._cellOf;
      const bBase = node2 << 6;
      const rBase = node2 << 4;
      for (let i = 0; i < N; i++) {
        const idx = li[lo + i];
        const s = idx << 2;
        const d = bBase + (i << 2);
        boxes2[d] = bBoxes[s];
        boxes2[d + 1] = bBoxes[s + 1];
        boxes2[d + 2] = bBoxes[s + 2];
        boxes2[d + 3] = bBoxes[s + 3];
        const id = bIds[idx];
        refs2[rBase + i] = id;
        cellOf[id] = rBase + i;
      }
      return node2 | N << 24 | 536870912;
    }
    const node = this._allocNode(height);
    const N2 = Math.ceil(N / fanout);
    const N1 = N2 * Math.ceil(Math.sqrt(fanout));
    const lk = this._lk;
    const tk = this._tk;
    const ti = this._ti;
    const hist = this._hist;
    if (N1 < N) {
      const sh = xShift === -2 ? refillKeys(this._kx, lk, li, lo, hi + 1) : xShift;
      if (sh >= 0) radixPart(lk, li, tk, ti, hist, lo, hi + 1, lo + N1, N1, sh);
    }
    const ky = this._ky;
    const parentCell = this._parentCell;
    const refs = this._refs;
    const boxes = this._boxes;
    const m = this._mbr;
    let cnt = 0;
    for (let i = lo; i <= hi; i += N1) {
      const e1 = i + N1 - 1;
      const hi2 = e1 < hi ? e1 : hi;
      if (N2 < hi2 - i + 1) {
        const sh = refillKeys(ky, lk, li, i, hi2 + 1);
        if (sh >= 0) radixPart(lk, li, tk, ti, hist, i, hi2 + 1, i + N2, N2, sh);
      }
      for (let j = i; j <= hi2; j += N2) {
        const e2 = j + N2 - 1;
        const hi3 = e2 < hi2 ? e2 : hi2;
        const childAnn = this._buildNode(bIds, bBoxes, j, hi3, height - 1, 16, -2);
        const child = childAnn & 16777215;
        const cell = (node << 4) + cnt;
        parentCell[child] = parentCell[child] & 4026531840 | cell;
        refs[cell] = childAnn;
        this._recalcInto(child, childAnn >>> 24 & 31);
        const d = cell << 2;
        boxes[d] = m[0];
        boxes[d + 1] = m[1];
        boxes[d + 2] = m[2];
        boxes[d + 3] = m[3];
        cnt++;
      }
    }
    return node | cnt << 24;
  }
  // ──────────────────────────────────────────────────────── pool + growth ──
  _allocNode(level) {
    let n;
    if (this._freeHead !== 0) {
      n = this._freeHead;
      this._freeHead = this._parentCell[n] & 16777215;
      this._freeLen--;
    } else {
      if (this._poolLen === this._poolCap)
        this._growPoolTo(this._poolCap + (this._poolCap >> 1) + 16);
      n = this._poolLen++;
    }
    this._parentCell[n] = level << 28;
    return n;
  }
  _freeNode(n) {
    this._parentCell[n] = 4026531840 | this._freeHead;
    this._freeHead = n;
    this._freeLen++;
  }
  /** Grow the pool to EXACTLY `cap` nodes (no rounding — capacity needs no
   *  power of two, only strides do, and those are literals). */
  _growPoolTo(cap) {
    if (cap > MAX_NODES) throw new Error("FlatRTree: pool exceeds 2^24 nodes");
    this._boxes = growF64(this._boxes, cap * 64);
    this._refs = growU32(this._refs, cap * 16);
    this._parentCell = growU32(this._parentCell, cap);
    this._poolCap = cap;
  }
  /** Cold path — callers inline the `id >= _cellOf.length` check. New space
   *  is zero = absent: no fill. */
  _growCellOf(id) {
    this._cellOf = growU32(this._cellOf, id + (id >> 1) + 16);
  }
  /** Called at MUTATION time only (capacity ≥ size invariant) — query bodies
   *  never grow, so `results`' identity is stable across queries. */
  _growResults(need) {
    const next = growU32(this.results, need + (need >> 1) + 16);
    this.results = next;
    return next;
  }
  /** Dump every item under annotated word `w` into results from `n`; returns
   *  the new count. Refs-only — covered subtrees never touch box lines. */
  _allInto(w, n, sp) {
    const refs = this._refs;
    const res = this.results;
    const stack = this._stack;
    const bot = sp;
    stack[sp++] = w;
    while (sp > bot) {
      const v = stack[--sp];
      const cnt = v >>> 24 & 31;
      const rBase = (v & 16777215) << 4;
      if ((v & 536870912) !== 0) {
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
  validate() {
    const refs = this._refs;
    const boxes = this._boxes;
    const parentCell = this._parentCell;
    const visited = /* @__PURE__ */ new Set();
    const seenIds = /* @__PURE__ */ new Set();
    const fail = (msg) => {
      throw new Error(`FlatRTree.validate: ${msg}`);
    };
    if ((parentCell[0] & 268435455) !== 0) fail("sentinel parent cell not 0");
    if (this.results.length < this._size)
      fail(`results capacity ${this.results.length} < size ${this._size}`);
    const rootW = refs[0];
    const rootIdx = rootW & 16777215;
    if ((parentCell[rootIdx] & 268435455) !== 0) fail("root parent cell not 0");
    const rootCnt = rootW >>> 24 & 31;
    if (rootCnt > 0) {
      this._recalcInto(rootIdx, rootCnt);
      const m = this._mbr;
      if (boxes[0] !== m[0] || boxes[1] !== m[1] || boxes[2] !== m[2] || boxes[3] !== m[3])
        fail("root MBR not exact");
    } else if (boxes[0] !== Infinity || boxes[1] !== Infinity || boxes[2] !== -Infinity || boxes[3] !== -Infinity) {
      fail("empty root MBR not the never-intersect sentinel");
    }
    const stack = [rootW];
    while (stack.length) {
      const w = stack.pop();
      const node = w & 16777215;
      if (visited.has(node)) fail(`node ${node} reachable twice`);
      visited.add(node);
      const cnt = w >>> 24 & 31;
      const isLeaf = (w & 536870912) !== 0;
      const lvl = parentCell[node] >>> 28;
      if (isLeaf !== (lvl === 0)) fail(`node ${node} leaf bit ${isLeaf} vs level ${lvl}`);
      if (cnt > 16) fail(`node ${node} count ${cnt} > 16`);
      if (node !== rootIdx && cnt < 1) fail(`non-root node ${node} empty`);
      if (node === rootIdx && !isLeaf && cnt < 2) fail(`internal root has ${cnt} entries`);
      const bBase = node << 6;
      for (let e = 0; e < cnt; e++) {
        const cell = (node << 4) + e;
        const b = bBase + (e << 2);
        if (!(boxes[b] <= boxes[b + 2]) || !(boxes[b + 1] <= boxes[b + 3]))
          fail(`node ${node} entry ${e} degenerate box`);
        const v = refs[cell];
        if (isLeaf) {
          if (this._cellOf[v] !== cell) fail(`cellOf[${v}] !== cell ${cell}`);
          if (seenIds.has(v)) fail(`id ${v} present twice`);
          seenIds.add(v);
        } else {
          const c = v & 16777215;
          if ((parentCell[c] & 268435455) !== cell) fail(`parentCell[${c}] cell !== ${cell}`);
          const clv = parentCell[c] >>> 28;
          if (clv >= lvl) fail(`child ${c} level ${clv} >= parent level ${lvl}`);
          if ((v & 536870912) !== 0 !== (clv === 0))
            fail(`child ${c} annotated leaf bit vs level ${clv}`);
          this._recalcInto(c, v >>> 24 & 31);
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
    for (let f = this._freeHead; f !== 0; f = parentCell[f] & 16777215) {
      if (parentCell[f] >>> 28 !== 15) fail(`free node ${f} lacks the FREE tag`);
      if (visited.has(f)) fail(`free node ${f} is reachable`);
      if (++free > this._poolLen) fail("free list cycle");
    }
    if (free !== this._freeLen) fail(`free list length ${free} !== ${this._freeLen}`);
    if (visited.size + free + 1 !== this._poolLen)
      fail(`pool leak: reachable ${visited.size} + free ${free} + sentinel !== ${this._poolLen}`);
  }
  stats() {
    const refs = this._refs;
    let leaves = 0;
    let leafFill = 0;
    let nodes = 0;
    const rootW = refs[0];
    const stack = [rootW];
    while (stack.length) {
      const w = stack.pop();
      nodes++;
      const cnt = w >>> 24 & 31;
      if ((w & 536870912) !== 0) {
        leaves++;
        leafFill += cnt;
      } else {
        const rBase = (w & 16777215) << 4;
        for (let e = 0; e < cnt; e++) stack.push(refs[rBase + e]);
      }
    }
    return {
      size: this._size,
      nodes,
      freeNodes: this._freeLen,
      height: (this._parentCell[rootW & 16777215] >>> 28) + 1,
      avgLeafFill: leaves ? leafFill / (leaves * 16) : 0,
      bytes: this._boxes.byteLength + this._refs.byteLength + this._parentCell.byteLength + this._cellOf.byteLength + this.results.byteLength + this._stack.byteLength
    };
  }
};
function omtNodeCount(n, fanout) {
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
function sortPairs17(sF, kb, sU, ob) {
  for (let i = 1; i < 17; i++) {
    const kv = sF[kb + i];
    const ov = sU[ob + i];
    let j = i - 1;
    while (j >= 0 && sF[kb + j] > kv) {
      sF[kb + j + 1] = sF[kb + j];
      sU[ob + j + 1] = sU[ob + j];
      j--;
    }
    sF[kb + j + 1] = kv;
    sU[ob + j + 1] = ov;
  }
}
function fillReducedTable17(sF, sU, ob, tb) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < 10; i++) {
    const b = sU[ob + i] << 2;
    const a0 = sF[b];
    const a1 = sF[b + 1];
    const a2 = sF[b + 2];
    const a3 = sF[b + 3];
    if (a0 < x0) x0 = a0;
    if (a1 < y0) y0 = a1;
    if (a2 > x1) x1 = a2;
    if (a3 > y1) y1 = a3;
    if (i >= 6) {
      const w = tb + (i - 6 << 3);
      sF[w] = x0;
      sF[w + 1] = y0;
      sF[w + 2] = x1;
      sF[w + 3] = y1;
    }
  }
  x0 = Infinity;
  y0 = Infinity;
  x1 = -Infinity;
  y1 = -Infinity;
  for (let i = 16; i >= 7; i--) {
    const b = sU[ob + i] << 2;
    const a0 = sF[b];
    const a1 = sF[b + 1];
    const a2 = sF[b + 2];
    const a3 = sF[b + 3];
    if (a0 < x0) x0 = a0;
    if (a1 < y0) y0 = a1;
    if (a2 > x1) x1 = a2;
    if (a3 > y1) y1 = a3;
    if (i <= 10) {
      const w = tb + (i - 7 << 3) + 4;
      sF[w] = x0;
      sF[w + 1] = y0;
      sF[w + 2] = x1;
      sF[w + 3] = y1;
    }
  }
  let tot = 0;
  for (let k = 0; k < 4; k++) {
    const s = tb + (k << 3);
    tot += sF[s + 2] - sF[s] + (sF[s + 3] - sF[s + 1]);
    tot += sF[s + 6] - sF[s + 4] + (sF[s + 7] - sF[s + 5]);
  }
  return tot;
}
function seedKeys(bBoxes, count, kx, ky, lk, li) {
  const sc = new Float64Array(2);
  const sv = new Int32Array(sc.buffer);
  sc[0] = 1;
  const hx = sv[1] === 1072693248 ? 1 : 0;
  const hy = 2 + hx;
  let mn = 2147483647;
  let mx = -2147483648;
  for (let j = 0; j < count; j++) {
    const b = j << 2;
    sc[0] = bBoxes[b] + bBoxes[b + 2];
    sc[1] = bBoxes[b + 1] + bBoxes[b + 3];
    const wx = sv[hx];
    const wy = sv[hy];
    const kxv = wx ^ wx >> 31 & 2147483647;
    const kyv = wy ^ wy >> 31 & 2147483647;
    kx[j] = kxv;
    ky[j] = kyv;
    lk[j] = kxv;
    li[j] = j;
    if (kxv < mn) mn = kxv;
    if (kxv > mx) mx = kxv;
  }
  const x = mn ^ mx;
  return x === 0 ? -1 : 31 - Math.clz32(x) & ~7;
}
function refillKeys(keySrc, lk, li, lo, hiEx) {
  let mn = 2147483647;
  let mx = -2147483648;
  for (let p = lo; p < hiEx; p++) {
    const k = keySrc[li[p]];
    lk[p] = k;
    if (k < mn) mn = k;
    if (k > mx) mx = k;
  }
  const x = mn ^ mx;
  return x === 0 ? -1 : 31 - Math.clz32(x) & ~7;
}
function histPass(lk, h, lo, hiEx, shift, bx) {
  for (let p = lo; p < hiEx; p++) h[lk[p] >> shift & 255 ^ bx]++;
}
function prefixPass(h, lo) {
  let acc = lo;
  for (let d = 0; d < 256; d++) {
    const c = h[d];
    h[d] = acc;
    acc += c;
  }
}
function scatterPass(lk, li, tk, ti, h, lo, hiEx, shift, bx) {
  for (let p = lo; p < hiEx; p++) {
    const k = lk[p];
    const d = k >> shift & 255 ^ bx;
    const pos = h[d];
    h[d] = pos + 1;
    tk[pos] = k;
    ti[pos] = li[p];
  }
}
function insSort2(lk, li, lo, hiEx) {
  for (let i = lo + 1; i < hiEx; i++) {
    const k = lk[i];
    const v = li[i];
    let j = i - 1;
    while (j >= lo && lk[j] > k) {
      lk[j + 1] = lk[j];
      li[j + 1] = li[j];
      j--;
    }
    lk[j + 1] = k;
    li[j + 1] = v;
  }
}
function radixPart(lk, li, tk, ti, hist, lo, hiEx, nb, g, shift) {
  for (; ; ) {
    if (hiEx - lo <= 48 || shift < 0) {
      insSort2(lk, li, lo, hiEx);
      return;
    }
    const hb = shift << 5;
    const h = hist.subarray(hb, hb + 256);
    h.fill(0);
    const bx = shift === 24 ? 128 : 0;
    histPass(lk, h, lo, hiEx, shift, bx);
    if (h[lk[lo] >> shift & 255 ^ bx] === hiEx - lo) {
      shift -= 8;
      continue;
    }
    prefixPass(h, lo);
    scatterPass(lk, li, tk, ti, h, lo, hiEx, shift, bx);
    const n0 = tk.length;
    lk.copyWithin(lo, n0 + lo, n0 + hiEx);
    li.copyWithin(lo, n0 + lo, n0 + hiEx);
    if (shift === 0) return;
    const s8 = shift - 8;
    let start = lo;
    for (let d = 0; d < 256 && start < hiEx; d++) {
      const end = h[d];
      if (end - start > 1) {
        while (nb <= start) nb += g;
        if (nb < end) radixPart(lk, li, tk, ti, hist, start, end, nb, g, s8);
      }
      start = end;
    }
    return;
  }
}

// packages/editor/src/lib/editor/managers/SpatialIndexManager/ShapeSpatialIndex.ts
var LIST_LIMIT = 16;
var EMPTY_U16 = new Uint16Array(0);
var EMPTY_U322 = new Uint32Array(0);
var EMPTY_F642 = new Float64Array(0);
function isIndexableBox(minX, minY, maxX, maxY) {
  return Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY) && minX <= maxX && minY <= maxY;
}
var ShapeSpatialIndex = class {
  tree = new FlatRTree();
  /** Shape id per slot. Freed slots hold `undefined` and are never read: every
   *  slot a search returns is live by construction. */
  idBySlot = [];
  slotOf = /* @__PURE__ */ new Map();
  freeSlots = [];
  nextSlot = 0;
  queryPool = [];
  /** Queries that have been acquired and not released. Freeing a slot has to
   *  reach them: a slot recycled onto a different shape would otherwise still
   *  carry the stamp the previous occupant earned, and that shape would read
   *  as a hit from a search that never saw it. */
  liveQueries = [];
  /** Staging for {@link ShapeSpatialIndex.beginLoad} / {@link ShapeSpatialIndex.stage} / {@link ShapeSpatialIndex.commitLoad}.
   *  Released again at commit: a page's worth of staging is not worth holding
   *  between rebuilds. */
  stagedIds = EMPTY_U322;
  stagedBoxes = EMPTY_F642;
  stagedCount = 0;
  getSize() {
    return this.slotOf.size;
  }
  has(id) {
    return this.slotOf.has(id);
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
  upsert(id, minX, minY, maxX, maxY) {
    if (!isIndexableBox(minX, minY, maxX, maxY)) return this.remove(id);
    const slot = this.slotOf.get(id);
    if (slot === void 0) {
      this.tree.insert(this.acquireSlot(id), minX, minY, maxX, maxY);
    } else {
      this.tree.update(slot, minX, minY, maxX, maxY);
    }
    return true;
  }
  /** Remove `id` if present. Returns whether anything was removed. */
  remove(id) {
    const slot = this.slotOf.get(id);
    if (slot === void 0) return false;
    this.tree.remove(slot);
    this.slotOf.delete(id);
    this.idBySlot[slot] = void 0;
    const live = this.liveQueries;
    for (let i = 0; i < live.length; i++) live[i].forgetSlot(slot);
    this.freeSlots.push(slot);
    return true;
  }
  /**
   * True when `id` is indexed with exactly these bounds. Lets the incremental
   * update path drop no-op upserts without materializing the stored box.
   */
  matchesBounds(id, minX, minY, maxX, maxY) {
    const slot = this.slotOf.get(id);
    if (slot === void 0) return false;
    return this.tree.matchesBBox(slot, minX, minY, maxX, maxY);
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
  beginLoad(sizeHint) {
    this.clear();
    this.stagedCount = 0;
    if (sizeHint > 0) this.growStaging(sizeHint);
  }
  /** Stage one shape for the in-progress {@link ShapeSpatialIndex.beginLoad}. Shapes with
   *  non-indexable bounds are skipped, as are repeats of an already-staged id. */
  stage(id, minX, minY, maxX, maxY) {
    if (!isIndexableBox(minX, minY, maxX, maxY)) return;
    if (this.slotOf.has(id)) return;
    const n = this.stagedCount;
    if (n === this.stagedIds.length) this.growStaging(n + 1);
    this.stagedIds[n] = this.acquireSlot(id);
    const b = n * 4;
    this.stagedBoxes[b] = minX;
    this.stagedBoxes[b + 1] = minY;
    this.stagedBoxes[b + 2] = maxX;
    this.stagedBoxes[b + 3] = maxY;
    this.stagedCount = n + 1;
  }
  /** Build the tree from everything staged since {@link ShapeSpatialIndex.beginLoad}. */
  commitLoad() {
    const n = this.stagedCount;
    this.stagedCount = 0;
    if (n > 0) this.tree.load(n, this.stagedIds, this.stagedBoxes);
    this.stagedIds = EMPTY_U322;
    this.stagedBoxes = EMPTY_F642;
  }
  /** Repack the tree for search quality after heavy churn. Contents unchanged. */
  rebuild() {
    this.tree.rebuild();
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
  searchToSet(minX, minY, maxX, maxY, precise) {
    const n = precise ? this.tree.searchPrecise(minX, minY, maxX, maxY) : this.tree.search(minX, minY, maxX, maxY);
    const results = this.tree.results;
    const idBySlot = this.idBySlot;
    const out = /* @__PURE__ */ new Set();
    for (let i = 0; i < n; i++) out.add(idBySlot[results[i]]);
    return out;
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
  acquireQuery() {
    const query = this.queryPool.pop() ?? new SpatialQuery(this, this.tree, this.slotOf, this.idBySlot);
    this.liveQueries.push(query);
    return query;
  }
  // ────────────────────────────────────────────────────────────── lifecycle ──
  /** Drop every shape and release the tree's buffers back to newborn sizes. */
  clear() {
    this.tree.clear();
    this.slotOf.clear();
    this.idBySlot.length = 0;
    this.freeSlots.length = 0;
    this.nextSlot = 0;
    for (const query of this.liveQueries) query.reset();
    for (const query of this.queryPool) query.reset();
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
  dispose() {
    this.clear();
    this.stagedIds = EMPTY_U322;
    this.stagedBoxes = EMPTY_F642;
    this.stagedCount = 0;
    this.queryPool.length = 0;
    this.liveQueries.length = 0;
  }
  // ─────────────────────────────────────────────────────── query internals ──
  /** Slot ids stay below this. @internal */
  slotCapacity() {
    return this.nextSlot;
  }
  /** @internal */
  recycleQuery(query) {
    const live = this.liveQueries;
    const i = live.indexOf(query);
    if (i !== -1) {
      const last = live.pop();
      if (last !== query) live[i] = last;
    }
    if (this.queryPool.length < 4) this.queryPool.push(query);
  }
  /** Structural audit of the tree plus the slot back-links. Tests only.
   *  @internal */
  validate() {
    this.tree.validate();
    for (const [id, slot] of this.slotOf) {
      if (this.idBySlot[slot] !== id) {
        throw new Error(`ShapeSpatialIndex: slot ${slot} back-link broken`);
      }
      if (!this.tree.has(slot)) {
        throw new Error(`ShapeSpatialIndex: slot ${slot} missing from tree`);
      }
    }
    if (this.tree.getSize() !== this.slotOf.size) {
      throw new Error(`ShapeSpatialIndex: tree size ${this.tree.getSize()} !== ${this.slotOf.size}`);
    }
  }
  /** Tests and benchmarks only. @internal */
  stats() {
    return this.tree.stats();
  }
  acquireSlot(id) {
    const slot = this.freeSlots.length > 0 ? this.freeSlots.pop() : this.nextSlot++;
    this.idBySlot[slot] = id;
    this.slotOf.set(id, slot);
    return slot;
  }
  growStaging(need) {
    const cap = need + (need >> 1) + 16;
    const ids = new Uint32Array(cap);
    ids.set(this.stagedIds);
    const boxes = new Float64Array(cap * 4);
    boxes.set(this.stagedBoxes);
    this.stagedIds = ids;
    this.stagedBoxes = boxes;
  }
};
var SpatialQuery = class {
  constructor(index, tree, slotOf, idBySlot) {
    this.index = index;
    this.tree = tree;
    this.slotOf = slotOf;
    this.idBySlot = idBySlot;
  }
  index;
  tree;
  slotOf;
  idBySlot;
  /** How many shapes the last search matched. Read only — the index writes it. */
  size = 0;
  /** Matched ids, when the result was small enough to scan. `-1` means the
   *  stamps below hold the membership instead. */
  listed = -1;
  list = [];
  stamp = EMPTY_U16;
  slots = EMPTY_U322;
  generation = 0;
  /** Search a rect. For viewport-scale rects — culls, marquees, brushes — where
   *  the tree's branchless leaf compaction wins at the ~50% hit rates a wide
   *  rect produces. */
  searchBounds(minX, minY, maxX, maxY) {
    return this.run(this.tree.search(minX, minY, maxX, maxY));
  }
  /** Search a small box around a point. For hit tests, where the tree's narrow
   *  body branches once per leaf entry — a near-zero hit rate the branch
   *  predictor gets right every time. */
  searchPoint(x, y, margin) {
    return this.run(this.tree.searchPrecise(x - margin, y - margin, x + margin, y + margin));
  }
  /** Whether the last search matched `id`.
   *
   *  Valid until this query's next search. Shapes added or moved since the
   *  search are not reflected — the same as a `Set` taken at that moment —
   *  and shapes removed since read as absent. */
  has(id) {
    const listed = this.listed;
    if (listed >= 0) {
      const list = this.list;
      for (let i = 0; i < listed; i++) if (list[i] === id) return true;
      return false;
    }
    const slot = this.slotOf.get(id);
    if (slot === void 0) return false;
    return this.stamp[slot] === this.generation;
  }
  /** Visit every matched shape id. Allocation-free. Shapes removed since the
   *  search are skipped, matching {@link SpatialQuery.has}. */
  forEach(visit) {
    const listed = this.listed;
    if (listed >= 0) {
      const list = this.list;
      for (let i = 0; i < listed; i++) {
        const id = list[i];
        if (id !== void 0) visit(id);
      }
      return;
    }
    const slots = this.slots;
    const stamp = this.stamp;
    const idBySlot = this.idBySlot;
    const generation = this.generation;
    for (let i = 0, n = this.size; i < n; i++) {
      const slot = slots[i];
      if (stamp[slot] === generation) visit(idBySlot[slot]);
    }
  }
  /** Return this query to its index's pool. Optional — see
   *  {@link ShapeSpatialIndex.acquireQuery}. */
  release() {
    this.size = 0;
    this.listed = 0;
    this.index.recycleQuery(this);
  }
  /** Drop a slot's membership, because the shape holding it was removed and
   *  the slot is about to be handed to a different shape. @internal */
  forgetSlot(slot) {
    const listed = this.listed;
    if (listed >= 0) {
      const slots = this.slots;
      for (let i = 0; i < listed; i++) {
        if (slots[i] === slot) {
          this.list[i] = void 0;
          return;
        }
      }
      return;
    }
    if (slot < this.stamp.length) this.stamp[slot] = 0;
  }
  /** Forget everything, because the whole index was rebuilt. @internal */
  reset() {
    this.stamp.fill(0);
    this.generation = 0;
    this.size = 0;
    this.listed = 0;
  }
  /** Membership is a generation stamp per slot: this many bytes are held for
   *  the page's shapes. Tests and benchmarks only. @internal */
  stampBytes() {
    return this.stamp.byteLength + this.slots.byteLength;
  }
  /** Take the count the tree just produced and turn it into membership.
   *
   *  Stamps are 16 bit and the generation simply counts up, so a search touches
   *  only the slots it actually hit — no clearing pass over the page, and two
   *  bytes per shape held rather than four. The counter wraps by refilling,
   *  which lands once every 65,535 searches: one memset of a few hundred KB,
   *  amortised to nothing. */
  run(n) {
    this.size = n;
    if (n <= LIST_LIMIT) {
      const results2 = this.tree.results;
      const slots2 = this.slots.length >= LIST_LIMIT ? this.slots : this.slots = new Uint32Array(LIST_LIMIT);
      const list = this.list;
      const idBySlot = this.idBySlot;
      for (let i = 0; i < n; i++) {
        const slot = results2[i];
        slots2[i] = slot;
        list[i] = idBySlot[slot];
      }
      this.listed = n;
      return this;
    }
    this.listed = -1;
    let generation = this.generation + 1;
    if (generation === 65536) {
      this.stamp.fill(0);
      generation = 1;
    }
    this.generation = generation;
    if (n === 0) return this;
    if (n > this.slots.length) this.slots = new Uint32Array(n + (n >> 1) + 16);
    const capacity = this.index.slotCapacity();
    if (capacity > this.stamp.length) {
      const next = new Uint16Array(capacity + (capacity >> 1) + 16);
      next.set(this.stamp);
      this.stamp = next;
    }
    const results = this.tree.results;
    const slots = this.slots;
    const stamp = this.stamp;
    for (let i = 0; i < n; i++) {
      const slot = results[i];
      slots[i] = slot;
      stamp[slot] = generation;
    }
    return this;
  }
};
export {
  ShapeSpatialIndex,
  SpatialQuery
};
