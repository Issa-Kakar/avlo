building scenes…

# Optimized / fair measurements

Node v22.22.2 · real ext4 disk · durable = synchronous=FULL (fsync per commit)

## 1. Durable commit floor (honest write unit — fsync-bound)

| payload / durable COMMIT | time |
| --- | --- |
| 1 KB | 4.13 ms (p90 5.14 ms) |
| 64 KB | 5.48 ms (p90 6.07 ms) |
| 512 KB | 9.87 ms (p90 11.96 ms) |
| 1.9 MB | 21.58 ms (p90 23.33 ms) |

→ a durable commit is ~fsync-bound (~5.02 ms), nearly flat until the payload is large.

## 2. Write ladder — N edits → durability (per-edit cost is 0; you pay per COMMIT)


**medium** — 2500 edits, head 4.75 MB
| strategy | commits | rows written | total durable time |
| --- | --- | --- | --- |
| naïve: durable commit per edit | 2500 commits | 2500 rows | ~12554.8 ms (modeled = N×unit) |
| debounce batch=16 | 157 commits | 157 rows | 1146.0 ms (458 µs/edit) |
| debounce batch=64 | 40 commits | 40 rows | 361.5 ms (145 µs/edit) |
| debounce batch=256 | 10 commits | 10 rows | 253.0 ms (101 µs/edit) |
| packed ~1.9MB segments | 3 commits | 3 rows | 39.14 ms |

**typing** — 6001 edits, head 6.1 KB
| strategy | commits | rows written | total durable time |
| --- | --- | --- | --- |
| naïve: durable commit per edit | 6001 commits | 6001 rows | ~30136.6 ms (modeled = N×unit) |
| debounce batch=16 | 376 commits | 376 rows | 1284.5 ms (214 µs/edit) |
| debounce batch=64 | 94 commits | 94 rows | 311.9 ms (52 µs/edit) |
| debounce batch=256 | 24 commits | 24 rows | 126.2 ms (21 µs/edit) |
| packed ~1.9MB segments | 1 commits | 1 rows | 14.53 ms |

→ durability cost ∝ COMMIT count, not edit count. Batching/packing collapses it; per-edit work is 0 (in-RAM).

## 3. SAVE per debounce tick — R2 re-encodes the whole doc; SQLite commits the delta

| scene | doc | R2 per tick (whole doc, remote-durable) | SQLite per tick (delta, local-durable) |
| --- | --- | --- | --- |
| medium | 4.75 MB | 93.75 ms enc + ~60ms PUT = **153.7 ms**, 4.75 MB remote | merge + 1 commit = **10.17 ms**, 112.4 KB local |
| large | 20.13 MB | 570.1 ms enc + ~60ms PUT = **630.1 ms**, 20.13 MB remote | merge + 1 commit = **11.59 ms**, 152.1 KB local |
| churn | 1.64 MB | 61.91 ms enc + ~60ms PUT = **121.9 ms**, 1.64 MB remote | merge + 1 commit = **6.17 ms**, 807 B local |

→ same cadence, both durable — but R2 re-encodes + ships the entire doc every tick; SQLite commits the delta.

## 4. Cold-load with a STALE checkpoint — packed segments vs tiny rows

| scene | packed segments (rows read) | tiny-row replay (rows read) | delta updates → segs |
| --- | --- | --- | --- |
| medium | 148.6 ms · 4 rows | 161.3 ms · 1252 rows | 1250 → 2 segs |
| large | 493.8 ms · 12 rows | 548.1 ms · 4506 rows | 4500 → 6 segs |
| churn | 219.8 ms · 3 rows | 286.7 ms · 5002 rows | 5000 → 1 segs |

→ packing turns a many-tiny-apply replay into a few big sequential applies + a handful of billed row reads.

## 5. A single updateV2 > 2MB — byte-split, concat-on-read, apply as one

single update **38.26 MB** (20k objects, one transaction) → 20 parts @≤2MB
| byte-split | store (1 durable commit, all parts) | read + concat | applyUpdateV2 | reconstruct ok |
| --- | --- | --- | --- | --- |
| 37 µs | 255.3 ms | 472.6 ms | 1008.5 ms | ✓ |

→ >2MB is a non-issue: the store is byte-addressed; split/concat is memcpy, applied as one update.

## 6. Compaction cost — encode the live in-memory doc (DO already holds it)

| scene | warm compaction (encode live doc) | cold reconstruct + encode | cold/warm |
| --- | --- | --- | --- |
| medium | 99.68 ms | 265.7 ms | 3× |
| large | 669.8 ms | 1468.6 ms | 2× |
| churn | 33.72 ms | 318.6 ms | 9× |

→ a warm DO compacts by encoding the doc it already has in RAM — reconstruction only happens on a cold wake.

## 7. gzip the checkpoint — fewer bytes per row, less DO storage billed

| scene | V2 head | gzip | gzip / gunzip | chunks @2MB |
| --- | --- | --- | --- | --- |
| medium | 4.75 MB | 1.64 MB (2.89×) | 255.2 ms / 14.81 ms | 3 → 1 rows |
| large | 20.13 MB | 6.96 MB (2.89×) | 1075.4 ms / 69.66 ms | 11 → 4 rows |
| churn | 1.64 MB | 584.0 KB (2.87×) | 85.40 ms / 5.08 ms | 1 → 1 rows |

→ optional: trade a few ms of CPU for ~2× smaller rows (less storage billed, fewer chunks).
