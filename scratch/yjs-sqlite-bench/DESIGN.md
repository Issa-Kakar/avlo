# Maxed-out design — Yjs room persistence in DO SQLite

Finalized sketch, driven by `RESULTS-OPTIMIZED.md` (honest durable commits on real disk).
Yjs CPU is workerd-accurate; SQLite durable commit (~5 ms small, ~22 ms @1.9 MB) is a
local floor — DO storage replicates on top, so confirm the constant on a real DO.

---

## The one principle everything follows from

**The live `this.document` in RAM is the source of truth. SQLite is a durability +
replay log, not a database you read on the hot path.** Three consequences:

- **Reads (warm): free** — the doc is already in memory. You only reconstruct from
  SQLite on a **cold wake** (hibernation eviction / new isolate). With `hibernate:true`
  that happens often, so cold-load latency is the thing to minimize — and it's exactly
  where killing the R2 network GET pays off (local read beats remote GET *every wake*).
- **Writes (warm): per-edit cost is 0** (accumulate the `updateV2` in a RAM buffer).
  Durability is a *separate, debounced* tier — you never fsync per keystroke.
- **Compaction (warm): no reconstruction** — you encode the doc you already hold
  (`encodeStateAsUpdateV2(this.document)`), 2–9× cheaper than rebuilding from the log.

This reframes the whole "overhead" question: the SQLite path's job is to make the
**cold-wake reconstruction** cheap and the **durability cadence** tunable. It is not in
the read path at all while warm.

---

## The durability ladder (your "different tiers")

| tier | trigger | action | cost (measured) | loss window on crash |
|---|---|---|---|---|
| **T0 RAM** | every `updateV2` | push bytes into an in-memory buffer | ~0 | — |
| **T1 tail commit** | debounce ~1–3 s (maxWait ~10 s) | `mergeUpdatesV2(buffer)` → 1 durable row; clear buffer | ~5–6 ms / commit | ≤ T1 interval of edits |
| **T2 seal** | tail bytes ≈ 1.9 MB **or** onClose | merge tail rows → one sealed ≤1.9 MB segment row | ~22 ms / seal | — (durable already) |
| **T3 compact** | onClose / idle alarm / `Σsegments > ½·checkpoint` | encode **live doc** → new checkpoint; prune; `incremental_vacuum` | ~34–670 ms (encode live) | — |

Why this shape — straight from the numbers:

- **Per-edit durable is fatal.** 2 500 edits × one fsync'd commit = **12.5 s**; 6 000
  keystrokes = **30 s**. Durability cost ∝ *commit count*, not edits.
- **Debounce collapses it.** Batch 64 → **145 µs/edit** (medium), **52 µs/edit**
  (typing). Batch 256 → 101 / 21 µs.
- **Sealing collapses rows.** 2 500 edits → **3** segment rows (39 ms total); 6 000
  keystrokes → **1** row (14.5 ms). DO bills per row — this matters for cost, not just
  latency.

T1 is exactly the knob your current `callbackOptions = { debounceWait: 5000,
debounceMaxWait: 15000 }` already exposes — keep it, point it at SQLite instead of R2.

---

## Storage layout — byte-addressed, packed near 2 MB

```sql
meta(k TEXT PRIMARY KEY, v BLOB)                  -- 'ckpt_seq', 'next_seq', 'schema'
checkpoint(part INTEGER PRIMARY KEY, b BLOB)       -- GC'd snapshot, byte-split ≤1.9 MB
segment(seg INTEGER, part INTEGER, ts INTEGER, b BLOB, PRIMARY KEY(seg, part))
tail(seq INTEGER PRIMARY KEY, ts INTEGER, b BLOB)  -- hot recent deltas (small rows)
```

- A **load unit** (the checkpoint, or one segment) is the concatenation of its `part`
  rows. Rows are *bytes*, never "one update each" — that's what makes >2 MB transparent.
- **Pack segments to ~1.9 MB**, leaving headroom under the 2 MB cell ceiling. Fewer,
  bigger rows = fewer fsyncs, fewer billed rows, faster sequential reads. (A 20 MB doc
  is 11 raw chunks → ~4 if gzipped; see below.)
- Bypass the ORM for these blobs — raw `ctx.storage.sql.exec` with prepared statements;
  drizzle is fine for `room_meta`, overkill for the oplog hot path.

---

## Write path

```ts
// T0 — every update (y-partyserver onUpdate / doc.on('updateV2'))
buf.push(update)                          // RAM only, ~0

// T1 — debounced (this is YServer's existing onSave hook, repointed)
onSave() {
  if (!buf.length) return
  const delta = Y.mergeUpdatesV2(buf.splice(0))      // one applyable blob
  const seq = nextSeq()
  sql`INSERT INTO tail(seq, ts, b) VALUES(${seq}, ${now}, ${delta})`   // 1 durable commit
  tailBytes += delta.byteLength
  if (tailBytes >= 1.9*MB) seal()
}

// T2 — seal tail → one packed segment (still applyable on its own)
seal() {
  const rows = sql`SELECT b FROM tail ORDER BY seq`
  const merged = Y.mergeUpdatesV2(rows.map(r => r.b))
  writeParts('segment', nextSegId(), merged)         // byte-split if >1.9 MB
  sql`DELETE FROM tail`
  tailBytes = 0
}

// T3 — compaction (onClose / idle alarm / size-tiered). Encode the LIVE doc — no rebuild.
compact() {
  const head = Y.encodeStateAsUpdateV2(this.document) // 34–670 ms, GC'd & small
  txn(() => {
    writeParts('checkpoint', head, { replace: true })
    sql`DELETE FROM segment WHERE ts < ${retentionHorizon}`  // keep recent for replay
    setMeta('ckpt_seq', currentSeq)
  })
  sql`PRAGMA incremental_vacuum`                      // a few pages, not a full rewrite
}
```

`writeParts` byte-splits any blob into ≤1.9 MB `part` rows in **one** transaction (one
durable commit for the whole unit).

### onClose (your existing last-disconnect flush, upgraded)
You already `renormalizeZ` + flush on the last disconnect. Replace the R2 `onSave` with
`seal()` then `compact()`. Result: the **next cold wake loads a single fresh checkpoint +
empty tail** — minimal reconstruction. (Note: `renormalizeZ` rewrites every z-key in one
transaction → potentially a multi-MB single update; the byte-addressed store handles it.)

---

## Read path (cold wake only)

```ts
onLoad() {
  const ckpt = readParts('checkpoint')               // reassemble ≤N rows
  if (ckpt) Y.applyUpdateV2(this.document, ckpt)
  for (const seg of readSegments())                  // ordered, each one applyV2
    Y.applyUpdateV2(this.document, seg)
  for (const t of sql`SELECT b FROM tail ORDER BY seq`)
    Y.applyUpdateV2(this.document, t.b)
}
```

- **Common wake** (fresh checkpoint from onClose, tiny tail): cost ≈ a single
  `applyUpdateV2` of the checkpoint + a few tiny applies — i.e. **≈ R2's apply cost minus
  the ~35 ms network GET**. Faster on every wake, and no network variance.
- **Worst wake** (checkpoint went stale, many segments accrued): a few big sequential
  applies, **not** thousands of tiny ones. Measured (half-stale): medium **149 ms / 4
  rows** vs tiny-row replay 161 ms / **1 252 rows**; large **494 ms / 12 rows** vs 548 ms
  / **4 506 rows**. Similar CPU, ~100–375× fewer billed row reads.
- **Never `mergeUpdatesV2` on load** — it's a write-time op (2.3 s on a 20 MB doc). Load
  is apply-only.

---

## A single update > 2 MB

Handled by the byte-addressed store, no special case in Yjs. Measured: a **38.26 MB**
single update (20k objects in one transaction) → **20 parts** in 37 µs, stored in **one**
durable commit (255 ms incl. fsync of 38 MB), read+concat 473 ms, `applyUpdateV2` 1.0 s,
reconstructs ✓. The apply/read times are inherent to a 38 MB update — storage adds only
the memcpy. Optional app-layer nicety: chunk bulk pastes/imports into <2 MB transactions
so they arrive as normal updates; the multi-part path is the backstop for the cases you
can't control (`renormalizeZ`, Tiptap/CM bursts, big paste).

---

## Compaction & vacuum strategy

- **Compact from the live doc** (T3) — `encodeStateAsUpdateV2(this.document)` is 2–9×
  cheaper than reconstructing (churn: 34 ms vs 319 ms). Same cost as one R2 `onSave`
  encode, but done on a cadence and written **locally** (no PUT).
- **Size-tiered trigger**: re-checkpoint when `Σsegment_bytes > ½ · checkpoint_bytes`, so
  you amortize the full encode instead of paying it every tick.
- **Never full-`VACUUM` on the hot path** — it rewrites the whole file under a write lock
  (cost ∝ DB size: 79 ms @31 MB, 260 ms @124 MB in `RESULTS.md`). Set
  `PRAGMA auto_vacuum=INCREMENTAL` at creation and drain a bounded number of pages per
  alarm. Deleting rows reclaims logical space immediately; vacuum only reclaims the file.

---

## Compression (optional, storage/row efficiency)

gzip on the V2 head: **~2.9×** smaller (medium 4.75 → 1.64 MB), at ~255 ms encode /
15 ms decode (level 6). Worth it for **sealed segments + checkpoint** (cold, infrequent,
fewer billed rows: 20 MB head = 11 chunks → 4 gzipped). **Not** for the hot tail
(latency-sensitive). Use a low level or `CompressionStream` if encode time bites; decode
is cheap. DO storage is billed by size, so this is a direct cost lever.

---

## Time-travel replay

The `ts` on every `tail`/`segment` row gives it for free: to reconstruct state at time T,
load the checkpoint whose base ≤ T, then apply segments/tail with `ts ≤ T`. Granularity =
your T1 debounce (each tail commit is a labeled delta). To replay *before* the current
checkpoint horizon, retain pre-checkpoint segments (don't fold them into the checkpoint at
T3) — the **retention window** is the knob that trades replay depth for storage. This is
strictly more than R2 gives you today (one head, no history), and is the actual motivation
for the change.

*(Aside: DO SQLite also has storage-level PITR — ~30-day bookmarks via
`getCurrentBookmark` / `onNextSessionRestoreBookmark`. That's disaster recovery of the
whole DB, not semantic per-edit Yjs replay. Keep them separate in your head: the oplog is
for replay; PITR is a recovery backstop.)*

---

## Where R2 still fits (optional hybrid)

Keep R2 as a **disaster-recovery mirror**: on T3 compaction, also PUT the (gzipped)
checkpoint to R2. That's the low-frequency, large-object write R2 is actually good at —
not the per-edit hot path. Cold wake stays all-local (SQLite checkpoint); R2 is only
touched if the DO's storage is lost. Pure-SQLite is simpler and wins wake latency; the
hybrid trades a rare PUT for off-box durability. Your call per how much you trust single
-region DO storage.

---

## Honest cost model (per operation)

| operation | cost | notes |
|---|---|---|
| per edit (T0) | ~0 | RAM buffer push |
| durable tail commit (T1) | ~5–6 ms + delta bytes | fsync-bound; amortized µs/edit after debounce |
| seal (T2) | ~22 ms | merge + one ~1.9 MB durable commit; infrequent |
| compaction encode (T3) | 34–670 ms | encode live doc; size-tiered cadence |
| `incremental_vacuum` | bounded | per-alarm page drain, not a file rewrite |
| cold wake, fresh ckpt | ≈ R2 apply − ~35 ms GET | the common case; faster every wake |
| cold wake, stale ckpt | a few big applies, few rows | vs thousands of tiny row reads |
| >2 MB update | byte-split memcpy + inherent apply | transparent |

### What to confirm on a real DO before committing
1. The durable-commit constant under DO storage replication (here ~5 ms local; expect
   higher). Port `durableCommitMs` + the write ladder into a `RoomDurableObject` bench
   endpoint under `wrangler dev`.
2. DO row read/write **billing** for your seal/compaction cadence (rows, not just bytes).
3. Hibernation wake frequency in practice → how fresh the checkpoint must be kept.

Everything Yjs (apply/encode/merge/pack) already transfers 1:1 — it's the same V8.
