import { FlatRTree } from './flat-rtree';

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
 *    count; fetch `results` AFTER each call (growth swaps the buffer), valid
 *    `[0, n)`, consume fully before the next query/mutation. In multi-query
 *    loops (connector-flow slideClear, clipboard probe) REFETCH inside the
 *    loop — a hoisted ref goes stale on growth. `getBBoxColumn()` /
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
 * 5. TWIN RULE (caller picks by construction): `query()` for viewport-derived
 *    envelopes (renderer cull, image-manager padded viewport, z-actions,
 *    context-serializer); `queryPrecise()` for everything else (radius
 *    probes, marquee + eraser via queryHandleIds, clipboard probe,
 *    connector-flow). Marquee is the boundary case — precise chosen because
 *    marquees are usually small.
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
 * 9. The singleton survives room switches; buffers are retained at
 *    high-water (deliberate — no realloc on room switch; memory bounded by
 *    the largest room seen this session).
 *
 * `search()` / `all()` are OFF-LIMITS for avlo consumers — hardwire one twin
 * and alias `results` instead.
 *
 * maxEntries stays the FlatRTree default 16 — the documented sweep vs
 * rbush(9) showed 8 edges probes ~5–10% while 32 wins drag-storm updates
 * 25–30%; 16 is the compromise, and this ctor arg is the knob.
 */
export const spatialTree = new FlatRTree();
