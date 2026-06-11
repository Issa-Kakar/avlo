# yjs-sqlite-bench (throwaway scratch)

Evidence for a design decision: persist a Yjs whiteboard room as a **SQLite update-log
inside the Durable Object** (time-travel + no R2 round trips) vs the current **R2
compacted-V2-snapshot**. Measures the overhead of applying chunked updates, merging,
vacuuming, durable writes, the 2 MB cell limit, and >2 MB single updates.

```bash
npm install
npm run bench                                   # v1 per-stage tables          → RESULTS.md
node --expose-gc --no-warnings optimized.mjs    # fair durable + maxed-out      → RESULTS-OPTIMIZED.md
node --no-warnings do-bench/run-workerd.mjs     # real workerd DO (unstable_dev) → RESULTS-WORKERD.md
```

## Read order
1. **`DESIGN.md`** — the finalized maxed-out architecture (tiered durability ladder,
   byte-addressed packed segments, compaction-from-live-doc, vacuum/compression/time-travel).
2. **`FINDINGS.md`** — v1 synthesis: the four overheads answered, the two anti-patterns.
3. `RESULTS.md` / `RESULTS-OPTIMIZED.md` / `RESULTS-WORKERD.md` — raw measured tables.

## Files
- `docgen.mjs` — representative avlo Y.Docs (strokes/shapes/text per the schema) + the
  captured per-transaction `updateV2` stream. Scenes: DRAW small/med/large, CHURN
  (tombstones), TYPING (fine-grained), HUGE-PASTE (one >2 MB update).
- `lib.mjs` — timing (hrtime p50/p90), chunking, `node:sqlite` temp + **durable** (real
  fsync, `synchronous=FULL`) DB helpers.
- `run.mjs` — v1: each Yjs + SQLite stage in isolation, LOAD/SAVE head-to-head.
- `optimized.mjs` — fair: real durable commits, the tiered-debounce write ladder, near-2 MB
  segment packing, the >2 MB single-update path, compaction-from-live-doc, gzip.
- `do-bench/` — real workerd: a SQLite-backed `BenchDO` driven over fetch via
  `unstable_dev`. Verifies the 2 MB limit, validates node:sqlite as a proxy, and proves
  the tiered persist→cold-reload reconstructs byte-identical state in the real runtime.

## Fidelity
- **Yjs CPU** runs in V8 → transfers 1:1 to workerd.
- **node:sqlite** = local-engine floor; **`synchronous=FULL` on ext4** gives an honest
  ~fsync-bound durable commit. The workerd run shows real DO-SQLite is ~2–8× slower
  (same order), and uses the *real* 2 MB cell limit.
- **Durability**: local disk / miniflare — production DO replicates on top (latency higher).
- **R2** GET/PUT is network, assumed ~35/60 ms (not measured). DO per-row billing not
  measured. Both are in `DESIGN.md`'s "confirm on real DO" checklist.

Not for merge — a scratch to gather metrics. Tweak knobs in `run.mjs`/`optimized.mjs`
(scenes, batch sizes) and `lib.mjs` (`CELL_LIMIT`).
