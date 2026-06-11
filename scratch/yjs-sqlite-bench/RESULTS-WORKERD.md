# Real-workerd Durable Object run

Node v22.22.2 · local workerd via unstable_dev · ping baseline 6.87 ms (HTTP+dispatch overhead)

> Engine/API/cell-limit are the real workerd SQLite. Durability is local miniflare disk — production DO replicates on top, so treat write latencies as a faithful-engine *floor*, not production.

## 1. Real 2MB cell-limit enforcement

| write | result |
| --- | --- |
| 1MB single cell | ok |
| 1.9MB single cell | ok |
| 2.1MB single cell | REJECTED: string or blob too big: SQLITE_TOOBIG |
| 3MB single cell | REJECTED: string or blob too big: SQLITE_TOOBIG |
| 5MB chunked | ok (3 parts, read back 5242880 bytes) |

## 2. DO-SQLite throughput (one event = one durable commit) vs node:sqlite

| workload | insert (1 commit) | read all | read back |
| --- | --- | --- | --- |
| 2500 × 2.0 KB | 61.93 ms | 21.65 ms | 2500 rows / 4.77 MB |
| 40 × 48.8 KB | 22.17 ms | 7.88 ms | 40 rows / 1.91 MB |
| 3 × 1.81 MB | 50.69 ms | 14.48 ms | 3 rows / 5.44 MB |

## 3. Per-event round-trip (each fetch = one event = one commit)

120 single-row events → **7.42 ms / event** (round-trip-bound; ping baseline 6.87 ms).
→ the commit itself is sub-ms here; local HTTP dominates, so the clean durability floor is the node `synchronous=FULL` number (~5 ms). The lesson is unchanged: one event per edit = one round-trip + commit each — batch within a debounce so a single event commits the whole batch (the 2500-rows-in-one-commit row above is that batched case).

## 4. End-to-end: persist → cold reload from storage, state-vector verified

persist 2500 objects: full head 5.10 MB, checkpoint 2.56 MB (2 parts), 2 segments / 2 rows, 25 tail rows → 30 rows, 5.10 MB stored

| op | time | result |
| --- | --- | --- |
| persist (build + store) | 1230.0 ms | 30 rows written |
| **cold reload** (fresh doc ← storage) | **234.7 ms** | reconstruct ✓, 2500 objects, read 29 rows |

→ the tiered checkpoint+segment+tail scheme reconstructs byte-identical state in the real runtime; cold reload reads a handful of rows.