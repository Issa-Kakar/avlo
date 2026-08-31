import { FlatRTree } from './FlatRTree';

/**
 * `spatialTree` — THE live spatial index, a module-level FlatRTree singleton
 * keyed by `handle.slot`. No wrapper class, no tuple-first shims: consumers
 * call `spatialTree.query(...)` / `queryPrecise(...)` directly with 4 scalars
 * (the public scalar methods are inline-designed wrappers over an internal
 * Float64Array channel — 4 doubles at the call site is the intended pattern).
 *
 * CONTRACTS (load-bearing — violating any of these corrupts queries):
 *
 * 1. RESULTS LIFETIME. Queries fill `spatialTree.results` and return the
 *    count; fetch `results` AFTER each call, valid `[0, n)`, consume fully
 *    before the next query/mutation. The buffer's identity changes only at
 *    MUTATION time (capacity ≥ size is a tree invariant; queries never grow
 *    it), so refs are hoistable across back-to-back queries — multi-query
 *    loops (connector-flow slideClear, clipboard probe) keep the
 *    refetch-inside-the-loop idiom anyway: free, and mutation-proof.
 *    `getBBoxColumn()` /
 *    `getHandlesBySlot()` refs ARE hoistable across queries (they only swap
 *    on `acquireSlot` growth, and queries never mutate) — but never across
 *    anything that can create objects.
 *
 * 2. NO NESTED QUERIES (transitive). Nothing reachable from the hit fns
 *    (`hitPointFor`/`hitRectFor`/`hitCircleFor`), the frame resolvers
 *    (`getTextFrame`/`getCodeFrame`/`getBookmarkFrame`/`getFrame`), or a
 *    picker `accept` callback may query or mutate `spatialTree` — a nested
 *    query clobbers `results` mid-consume. rbush's fresh-array-per-call
 *    accidentally allowed this; the shared buffer does not. Verified clean
 *    (all bottom out in caches / Y reads / pure geometry).
 *
 * 3. MUTATION = RoomDocManager ONLY. Grep contract (slot-table idiom):
 *    `spatialTree.(insert|remove|update|load|rebuild|clear)` must match only
 *    in `runtime/room-doc-manager.ts`.
 *
 * 4. `remove(slot)` BEFORE `releaseSlot(slot)`. Phase B of the same observer
 *    fire can recycle the slot (LIFO) — a late remove would delete the
 *    RECYCLED entry. The tree is just another slot-keyed consumer under the
 *    existing "finalize all slot consumers before releaseSlot" invariant.
 *
 * 5. TWIN RULE (caller picks by construction, by RECT SIZE): `query()` for
 *    viewport-scale / unbounded rects (renderer cull, image-manager padded
 *    viewport, z-actions, context-serializer, marquee rects via
 *    queryHandleIds, clipboard's selection-sized probe); `queryPrecise()`
 *    for bounded-small probes (radius picks, eraser circles via
 *    queryHandleIds' point branch, connector-flow slideClear). The wide
 *    twin's branchless leaf compaction wins at ~50% hit rates; the precise
 *    twin's mask+branch wins at near-zero hit rates — rect size predicts
 *    the hit rate, site category doesn't.
 *
 * 6. LIVE SLOTS ONLY. Query results are always live ⇒ `bySlot[res[i]]!` is
 *    non-null by contract. Column lanes of freed slots are stale — never
 *    index them (existing slot-table contract).
 *
 * 7. `slot * 4`, never `slot << 2`, for column offsets (slot-table rule).
 *
 * 8. NO-ROOM SEMANTICS. The old `getSpatialIndex()` threw with no room; the
 *    singleton silently answers 0 over a cleared tree. Safe because of the
 *    double clear (RDM destroy + hydrate top): silent-empty, never
 *    silent-stale.
 *
 * 9. The singleton survives room switches; `clear()` RELEASES every growable
 *    buffer to newborn sizes — no high-water retention across rooms. Release
 *    is free here: RDM clears at destroy + hydrate top, and the hydrate
 *    `load()` exact-reserves the pool in a single grow.
 *
 * `search()` / `all()` are OFF-LIMITS for avlo consumers — hardwire one twin
 * and alias `results` instead.
 *
 * maxEntries is FIXED at 16 inside FlatRTree (source-literal strides — the
 * documented sweep showed 8 edges probes ~5–10% while 32 wins drag-storm
 * updates 25–30%; 16 is the compromise). Chasing another M means
 * regenerating the literals in `FlatRTree.ts`, not passing a ctor arg.
 */
export const spatialTree = new FlatRTree();
