# Findings — SQLite update-log vs R2 compacted-snapshot for the Yjs room DO

Evidence for: *"if I store Yjs updates in the DO's SQLite instead of a compacted V2
snapshot in R2, what's the extra overhead of applying chunked updates / merging /
vacuuming / writing — vs just GET-ing an already-compacted doc from R2?"*

Numbers are from `RESULTS.md` (Node 22 `node:sqlite`, yjs 13.6.31). **Yjs CPU transfers
1:1 to workerd (same V8). SQLite numbers are a local-engine floor — DO SQLite is
slower in absolute terms (per-write durability), but the ratios hold.** R2 GET/PUT is
network, assumed ~35/60 ms.

---

## TL;DR

The proposed SQLite approach is **net favorable**, but only with the right primitives:

1. **Reconstructing from chunked updates costs ~nothing extra over a compacted R2 GET — *if you keep a rolling checkpoint*.** "Checkpoint + recent tail" load CPU equals R2's `applyUpdateV2` CPU to within noise, and you delete the ~35 ms network GET. The 2 MB chunk split/reassemble is microseconds.
2. **Two anti-patterns make it look terrible — avoid both:** cold-loading by *replaying the whole log from genesis*, or by *`mergeUpdatesV2` over the log*. Merge is 4–8× a single apply and scales superlinearly (2.3 s on a 20 MB doc). Replay is fine for append-only history but explodes on fine-grained edits (46 ms to replay 6 000 keystrokes into a 6 KB doc).
3. **Saving is where SQLite wins big.** R2 `onSave` re-encodes and uploads the *whole doc every debounce* (820 ms + a 60 ms PUT for a 20 MB doc). A SQLite append writes one delta row: tens of µs, hundreds of bytes, no network — **100–9 000× fewer bytes, 10–5 800× less CPU per save.**
4. **The price you take on:** periodic compaction + `VACUUM`, and log-table growth. Both are manageable *off the hot path*, and compaction is just "one R2-onSave's worth of work" on a cadence instead of every debounce.

---

## The four overheads, answered

### 1. Apply chunked updates vs GET a compacted doc — LOAD

| scene | doc head | R2 (apply + ~35 ms GET) | SQLite checkpoint+tail | SQLite replay-all | SQLite merge+apply |
|---|---|---|---|---|---|
| DRAW small | 584 KB | ~44.9 ms | **11.0 ms** | 17.3 ms | 49.1 ms |
| DRAW medium | 4.75 MB | ~161 ms | **128 ms** | 156 ms | 431 ms |
| DRAW large | 20.1 MB | ~514 ms | **492 ms** | 555 ms | 2 791 ms |
| CHURN | 1.64 MB | ~126 ms | **91 ms** | 247 ms | 1 978 ms |
| TYPING | 6.1 KB | ~35 ms | **0.9 ms** | 52 ms | 519 ms |

- **Checkpoint+tail ≈ R2 CPU, minus the network hop** → faster everywhere; dramatically so for small docs (network-bound: 4× / 38×), marginally for huge docs (CPU-bound, similar apply cost).
- The extra work vs R2 is: SQLite read of the snapshot rows (1–11 ms even at 20 MB) + chunk reassemble (≤6 ms at 20 MB) + K tiny tail applies. All negligible next to the unavoidable `applyUpdateV2`.
- **`mergeUpdatesV2` is NOT a load primitive.** It always loses (3–6× R2). Never merge-to-load.

### 2. Merging overhead — `mergeUpdatesV2`

| scene | updates | mergeUpdatesV2 | vs single apply | merged size vs GC'd head |
|---|---|---|---|---|
| DRAW small | 400 | 35 ms | 3.6× | 1.00× |
| DRAW medium | 2 500 | 287 ms | 2.3× | 1.00× |
| DRAW large | 9 000 | 2 260 ms | 4.7× | 1.00× |
| CHURN | 10 000 | 1 830 ms | 20× | **1.67×** |
| TYPING | 6 001 | 509 ms | 1 838× | 1.00× |

- Merge cost scales with **update count and total bytes decoded**, not live doc size — that's why a churny/typing history with thousands of tiny updates is so expensive to merge.
- **`mergeUpdatesV2` keeps tombstones; `encodeStateAsUpdateV2` garbage-collects them.** With deletes/overwrites the merged blob is *bigger* than a re-encode (1.67× here; was 45× in a delete-everything stress) and still carries dead content.
- **Therefore: compact with apply→encode, not merge.** `new Y.Doc()` → apply(prev checkpoint + tail) → `encodeStateAsUpdateV2`. In the churn scene that's 232 ms replay + 29 ms encode = **261 ms and a 1.64 MB GC'd head**, vs `mergeUpdatesV2` at **1 830 ms and a 2.73 MB head**. Apply→encode wins on both axes. (Merge only earns its keep if you must preserve history/tombstones in the artifact itself.)

### 3. Vacuuming overhead

| scene | live DB after compaction | VACUUM time | reclaim |
|---|---|---|---|
| DRAW small | 1.38 MB | 4.9 ms | 4.64 → 1.38 MB |
| DRAW medium | 9.41 MB | 79 ms | 31.2 → 9.4 MB |
| DRAW large | 37.1 MB | 260 ms | 124 → 37 MB |
| CHURN | 6.14 MB | 85 ms | 24.4 → 6.1 MB |
| TYPING | 260 KB | 3 ms | 960 → 260 KB |

- `VACUUM` **rewrites the whole DB file under a write lock** → cost ∝ DB size, and it's a stop-the-world latency spike. DO SQLite will be slower than these floors.
- **Don't full-VACUUM on the hot path.** Use `PRAGMA auto_vacuum=INCREMENTAL` and drain a few pages with `incremental_vacuum(N)` per alarm tick, or full-VACUUM rarely during idle. Deleting compacted log rows reclaims *logical* space immediately; vacuum only reclaims *file* space.

### 4. Write overhead — SAVE

| scene | R2: encode + PUT | bytes (R2) | SQLite: append 1 | bytes (SQLite) | byte ratio |
|---|---|---|---|---|---|
| DRAW small | 10.6 ms + 60 ms PUT | 584 KB | 74 µs | 1.5 KB | **389×** |
| DRAW medium | 75 ms + PUT | 4.75 MB | 75 µs | 2.0 KB | **2 375×** |
| DRAW large | 821 ms + PUT | 20.1 MB | 141 µs | 2.3 KB | **8 750×** |
| CHURN | 29 ms + PUT | 1.64 MB | 62 µs | 319 B | **5 150×** |
| TYPING | 0.46 ms + PUT | 6.1 KB | 43 µs | 27 B | **226×** |

- Today every debounced `onSave` **re-encodes the entire document** and ships it over the network. That's `encodeStateAsUpdateV2` cost (up to ~820 ms of DO CPU at 20 MB) **plus** a full-doc PUT, repeated every 5–15 s of activity.
- SQLite append is the delta only — effectively free and offline. This is the single strongest argument for the change.
- Caveat: each append is a DO row write (billed + durably persisted). A 6 000-keystroke session = 6 000 writes. **Coalesce bursty `updateV2`s** (batch within a tick / short debounce) to keep row count and write-amplification sane — see growth below.

### Bonus — storage growth (why compaction is mandatory)

| scene | log table (Σ updates) | snapshot table | ratio |
|---|---|---|---|
| DRAW (append-only) | 1.2–31 MB | ≈ head | 1.5–2.0× |
| CHURN | 6.09 MB | 1.65 MB | 3.7× |
| TYPING | 244 KB | 16 KB | **15×** |

The append log grows unboundedly and faster than the doc (every move/keystroke is retained). With time-travel you *want* some retention, so this is a retention-policy knob — but it forces a compaction + vacuum cadence.

---

## Recommended design (from the evidence)

```
TABLE oplog (seq INTEGER PRIMARY KEY, ts INTEGER, data BLOB)   -- append the updateV2 stream
TABLE ckpt  (idx INTEGER PRIMARY KEY, seq INTEGER, data BLOB)  -- compacted head, chunked ≤ ~1 MB
```

- **Save** (on `doc.on('updateV2')`): `INSERT` one `oplog` row. Coalesce updates within a tick into one row to cap write count. No R2, no full re-encode.
- **Cold load:** read latest `ckpt` chunks → `applyUpdateV2`; read `oplog WHERE seq > ckpt.seq` → `applyUpdateV2` each. ≈ R2 CPU, zero network.
- **Compaction** (alarm-driven: every N updates / M minutes / when `log/head` ratio crosses a threshold): apply checkpoint+tail into a fresh `Y.Doc` → `encodeStateAsUpdateV2` → write new `ckpt` chunks → delete consumed `oplog` rows beyond your retention window → `incremental_vacuum`. This is one "R2-onSave's worth" of CPU on a cadence, not per-edit.
- **Chunk at ~1 MB, not 2 MB** — leave headroom under the cell limit and keep individual row writes comfortable. Snapshots need ⌈head/1 MB⌉ rows (≤ ~21 at 20 MB); split/reassemble is free.
- **Time-travel:** `ts` per `oplog` row → replay = nearest `ckpt` ≤ T, then apply tail up to T. Retention window bounds both history depth and storage.
- **Keep R2?** Optional belt-and-suspenders: mirror the compacted `ckpt` to R2 on each compaction for cheap cold-DO-eviction restore / disaster recovery. That's the *low-frequency* write R2 is good at — not the per-edit hot path.

---

## Caveats — what this scratch does and does not measure

- ✅ **Yjs encode/apply/merge CPU** — real and transferable to workerd (same V8).
- ⚠️ **SQLite insert/read/vacuum** — `node:sqlite` local floor. DO SQLite adds per-write durability/replication and bills rows read/written; absolute insert + VACUUM times will be higher. Relative conclusions (append ≪ re-encode; vacuum ∝ DB size; reads cheap) hold.
- ❌ **R2 latency** — not measured; ~35/60 ms GET/PUT assumed. Real p99 is worse and is exactly the variance the SQLite path removes.
- ❌ **DO point-in-time recovery** — DO SQLite already offers storage-level PITR (~30-day bookmarks via `getCurrentBookmark` / `onNextSessionRestoreBookmark`). That covers *disaster recovery* but not *semantic per-edit replay* — if replay is the goal, the `oplog` is the right tool; if recovery is the goal, PITR may already suffice.
- Single-client capture: updates come from one logical writer. Multi-client interleaving changes struct fragmentation slightly but not the order-of-magnitude story.
- V2 vs V1: V2 is ~5–8 % smaller on these structured docs (e.g. 584 vs 621 KB) — "V2 everywhere" confirmed reasonable; apply/merge cost delta is minor.

To upgrade SQLite fidelity, port `measureSqlite` into a tiny `RoomDurableObject` benchmark
endpoint and run under `wrangler dev` (workerd) — the Yjs half won't move.
