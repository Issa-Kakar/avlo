# Yjs V2 + SQLite-update-log vs R2-snapshot — overhead scratch

Generated 2026-06-11T06:18:03.625Z · Node v22.22.2 · yjs 13.6.31

**Read me first.** Yjs encode/apply/merge run in V8, so these CPU numbers transfer
directly to a Cloudflare Worker/DO (workerd). The SQLite numbers come from Node's
built-in `node:sqlite` and are a **local-engine floor**: real DO SQLite adds
durability + write-amplification per write, so treat insert/VACUUM as *lower bounds*.
R2 GET/PUT is a network hop (assumed ~35/60 ms here) that the
SQLite path removes entirely — that, not CPU, is usually the real win.

2MB cell limit ⇒ a compacted snapshot is chunked across rows; the update-log rows are
naturally small. `mergeUpdatesV2` keeps tombstones (no GC) while `encodeStateAsUpdateV2`
GCs — see how the merge/snapshot sizes diverge in the CHURN scene.

### DRAW small
objects **400**, structs 4,593, updates 400

**Sizes**
| encodeV2 (R2 head) | encodeV1 | Σ update stream | mergeUpdatesV2 | checkpoint (−25) | chunks @2MB |
| --- | --- | --- | --- | --- | --- |
| 583.8 KB | 621.2 KB | 593.2 KB (1.02×) | 583.8 KB (1.00×) | 548.4 KB | 1 |

**Yjs CPU (V8 — transfers to workerd)**
| encodeV2 | apply 1 snapshot | replay all N | mergeUpdatesV2 | apply merged | checkpoint+25 | chunk split | reassemble |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10.61 ms (p90 26.44 ms) | 9.92 ms (p90 14.86 ms) | 16.35 ms (p90 23.54 ms) | 35.43 ms (p90 45.80 ms) | 12.70 ms (p90 16.40 ms) | 10.75 ms (p90 16.11 ms) | 9 µs (p90 11 µs) | 65 µs (p90 94 µs) |

**SQLite stages (node:sqlite — local floor, not DO)**
| insert full log | insert 1 update | insert snap (chunked) | read full log | read snap (chunked) | VACUUM |
| --- | --- | --- | --- | --- | --- |
| 2.17 ms (p90 21.42 ms) | 74 µs (p90 93 µs) | 543 µs (p90 16.50 ms) | 972 µs (p90 1.21 ms) | 202 µs (p90 293 µs) | 4.88 ms |

**LOAD (cold start), CPU only — R2 also pays a network GET**
| path | CPU | network | total est. |
| --- | --- | --- | --- |
| R2: GET + applyV2 | 9.92 ms | ~35 ms GET | ~44.92 ms |
| SQLite replay-all | 17.33 ms | 0 | 17.33 ms |
| SQLite merge+apply | 49.10 ms | 0 | 49.10 ms |
| SQLite checkpoint+recent | 10.95 ms | 0 | **10.95 ms** |

**SAVE — R2 rewrites the whole doc every debounce; SQLite appends the delta**
| path | CPU | bytes written | network |
| --- | --- | --- | --- |
| R2: encodeV2 + PUT | 10.61 ms | 583.8 KB | ~60 ms PUT |
| SQLite append 1 update | 74 µs | 1.5 KB | 0 |

**Storage growth & compaction**
| log table (Σ updates) | snapshot table | log/snap ratio | VACUUM reclaim (4× log, −70%) |
| --- | --- | --- | --- |
| 1.17 MB | 592.0 KB | 2.02× | 4.64 MB → 1.38 MB in 4.88 ms |

---

### DRAW medium
objects **2,500**, structs 28,792, updates 2,500

**Sizes**
| encodeV2 (R2 head) | encodeV1 | Σ update stream | mergeUpdatesV2 | checkpoint (−25) | chunks @2MB |
| --- | --- | --- | --- | --- | --- |
| 4.75 MB | 5.00 MB | 4.82 MB (1.01×) | 4.75 MB (1.00×) | 4.72 MB | 3 |

**Yjs CPU (V8 — transfers to workerd)**
| encodeV2 | apply 1 snapshot | replay all N | mergeUpdatesV2 | apply merged | checkpoint+25 | chunk split | reassemble |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 75.03 ms (p90 79.56 ms) | 126.0 ms (p90 135.8 ms) | 149.1 ms (p90 156.2 ms) | 286.9 ms (p90 313.9 ms) | 137.4 ms (p90 143.3 ms) | 126.1 ms (p90 137.9 ms) | 10 µs (p90 13 µs) | 776 µs (p90 1.02 ms) |

**SQLite stages (node:sqlite — local floor, not DO)**
| insert full log | insert 1 update | insert snap (chunked) | read full log | read snap (chunked) | VACUUM |
| --- | --- | --- | --- | --- | --- |
| 50.89 ms (p90 63.99 ms) | 75 µs (p90 96 µs) | 32.44 ms (p90 49.34 ms) | 6.86 ms (p90 8.63 ms) | 2.34 ms (p90 4.33 ms) | 78.79 ms |

**LOAD (cold start), CPU only — R2 also pays a network GET**
| path | CPU | network | total est. |
| --- | --- | --- | --- |
| R2: GET + applyV2 | 126.0 ms | ~35 ms GET | ~161.0 ms |
| SQLite replay-all | 156.0 ms | 0 | 156.0 ms |
| SQLite merge+apply | 431.1 ms | 0 | 431.1 ms |
| SQLite checkpoint+recent | 128.4 ms | 0 | **128.4 ms** |

**SAVE — R2 rewrites the whole doc every debounce; SQLite appends the delta**
| path | CPU | bytes written | network |
| --- | --- | --- | --- |
| R2: encodeV2 + PUT | 75.03 ms | 4.75 MB | ~60 ms PUT |
| SQLite append 1 update | 75 µs | 2.0 KB | 0 |

**Storage growth & compaction**
| log table (Σ updates) | snapshot table | log/snap ratio | VACUUM reclaim (4× log, −70%) |
| --- | --- | --- | --- |
| 7.81 MB | 4.77 MB | 1.64× | 31.19 MB → 9.41 MB in 78.79 ms |

---

### DRAW large
objects **9,000**, structs 103,383, updates 9,000

**Sizes**
| encodeV2 (R2 head) | encodeV1 | Σ update stream | mergeUpdatesV2 | checkpoint (−25) | chunks @2MB |
| --- | --- | --- | --- | --- | --- |
| 20.13 MB | 21.03 MB | 20.35 MB (1.01×) | 20.13 MB (1.00×) | 20.07 MB | 11 |

**Yjs CPU (V8 — transfers to workerd)**
| encodeV2 | apply 1 snapshot | replay all N | mergeUpdatesV2 | apply merged | checkpoint+25 | chunk split | reassemble |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 820.6 ms (p90 852.7 ms) | 478.5 ms (p90 493.9 ms) | 523.1 ms (p90 535.1 ms) | 2259.7 ms (p90 2564.0 ms) | 499.6 ms (p90 528.0 ms) | 481.2 ms (p90 486.3 ms) | 15 µs (p90 17 µs) | 6.05 ms (p90 9.16 ms) |

**SQLite stages (node:sqlite — local floor, not DO)**
| insert full log | insert 1 update | insert snap (chunked) | read full log | read snap (chunked) | VACUUM |
| --- | --- | --- | --- | --- | --- |
| 200.7 ms (p90 205.3 ms) | 141 µs (p90 180 µs) | 112.2 ms (p90 125.6 ms) | 32.03 ms (p90 33.78 ms) | 11.13 ms (p90 11.91 ms) | 260.3 ms |

**LOAD (cold start), CPU only — R2 also pays a network GET**
| path | CPU | network | total est. |
| --- | --- | --- | --- |
| R2: GET + applyV2 | 478.5 ms | ~35 ms GET | ~513.5 ms |
| SQLite replay-all | 555.2 ms | 0 | 555.2 ms |
| SQLite merge+apply | 2791.4 ms | 0 | 2791.4 ms |
| SQLite checkpoint+recent | 492.3 ms | 0 | **492.3 ms** |

**SAVE — R2 rewrites the whole doc every debounce; SQLite appends the delta**
| path | CPU | bytes written | network |
| --- | --- | --- | --- |
| R2: encodeV2 + PUT | 820.6 ms | 20.13 MB | ~60 ms PUT |
| SQLite append 1 update | 141 µs | 2.3 KB | 0 |

**Storage growth & compaction**
| log table (Σ updates) | snapshot table | log/snap ratio | VACUUM reclaim (4× log, −70%) |
| --- | --- | --- | --- |
| 31.00 MB | 20.18 MB | 1.54× | 123.93 MB → 37.11 MB in 260.3 ms |

---

### CHURN (move/restyle + some deletes)
objects **1,200**, structs 22,521, updates 10,000

**Sizes**
| encodeV2 (R2 head) | encodeV1 | Σ update stream | mergeUpdatesV2 | checkpoint (−50) | chunks @2MB |
| --- | --- | --- | --- | --- | --- |
| 1.64 MB | 1.79 MB | 3.04 MB (1.86×) | 2.73 MB (1.67×) | 1.64 MB | 1 |

**Yjs CPU (V8 — transfers to workerd)**
| encodeV2 | apply 1 snapshot | replay all N | mergeUpdatesV2 | apply merged | checkpoint+50 | chunk split | reassemble |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 29.32 ms (p90 38.25 ms) | 90.67 ms (p90 113.0 ms) | 232.0 ms (p90 254.9 ms) | 1830.4 ms (p90 1921.2 ms) | 132.8 ms (p90 142.5 ms) | 90.64 ms (p90 106.8 ms) | 7 µs (p90 11 µs) | 199 µs (p90 246 µs) |

**SQLite stages (node:sqlite — local floor, not DO)**
| insert full log | insert 1 update | insert snap (chunked) | read full log | read snap (chunked) | VACUUM |
| --- | --- | --- | --- | --- | --- |
| 55.05 ms (p90 83.87 ms) | 62 µs (p90 80 µs) | 1.61 ms (p90 23.14 ms) | 14.58 ms (p90 16.57 ms) | 635 µs (p90 711 µs) | 85.06 ms |

**LOAD (cold start), CPU only — R2 also pays a network GET**
| path | CPU | network | total est. |
| --- | --- | --- | --- |
| R2: GET + applyV2 | 90.67 ms | ~35 ms GET | ~125.7 ms |
| SQLite replay-all | 246.6 ms | 0 | 246.6 ms |
| SQLite merge+apply | 1977.8 ms | 0 | 1977.8 ms |
| SQLite checkpoint+recent | 91.28 ms | 0 | **91.28 ms** |

**SAVE — R2 rewrites the whole doc every debounce; SQLite appends the delta**
| path | CPU | bytes written | network |
| --- | --- | --- | --- |
| R2: encodeV2 + PUT | 29.32 ms | 1.64 MB | ~60 ms PUT |
| SQLite append 1 update | 62 µs | 319 B | 0 |

**Storage growth & compaction**
| log table (Σ updates) | snapshot table | log/snap ratio | VACUUM reclaim (4× log, −70%) |
| --- | --- | --- | --- |
| 6.09 MB | 1.65 MB | 3.69× | 24.38 MB → 6.14 MB in 85.06 ms |

---

### TYPING (fine-grained)
objects **1**, structs 12, updates 6,001

**Sizes**
| encodeV2 (R2 head) | encodeV1 | Σ update stream | mergeUpdatesV2 | checkpoint (−50) | chunks @2MB |
| --- | --- | --- | --- | --- | --- |
| 6.1 KB | 6.1 KB | 160.1 KB (26.35×) | 6.1 KB (1.00×) | 6.0 KB | 1 |

**Yjs CPU (V8 — transfers to workerd)**
| encodeV2 | apply 1 snapshot | replay all N | mergeUpdatesV2 | apply merged | checkpoint+50 | chunk split | reassemble |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 464 µs (p90 1.02 ms) | 277 µs (p90 306 µs) | 45.90 ms (p90 50.08 ms) | 509.4 ms (p90 562.9 ms) | 3.49 ms (p90 5.89 ms) | 877 µs (p90 1.14 ms) | 7 µs (p90 7 µs) | 18 µs (p90 22 µs) |

**SQLite stages (node:sqlite — local floor, not DO)**
| insert full log | insert 1 update | insert snap (chunked) | read full log | read snap (chunked) | VACUUM |
| --- | --- | --- | --- | --- | --- |
| 6.67 ms (p90 7.09 ms) | 43 µs (p90 69 µs) | 78 µs (p90 92 µs) | 6.19 ms (p90 6.63 ms) | 56 µs (p90 77 µs) | 3.09 ms |

**LOAD (cold start), CPU only — R2 also pays a network GET**
| path | CPU | network | total est. |
| --- | --- | --- | --- |
| R2: GET + applyV2 | 277 µs | ~35 ms GET | ~35.28 ms |
| SQLite replay-all | 52.09 ms | 0 | 52.09 ms |
| SQLite merge+apply | 519.1 ms | 0 | 519.1 ms |
| SQLite checkpoint+recent | 933 µs | 0 | **933 µs** |

**SAVE — R2 rewrites the whole doc every debounce; SQLite appends the delta**
| path | CPU | bytes written | network |
| --- | --- | --- | --- |
| R2: encodeV2 + PUT | 464 µs | 6.1 KB | ~60 ms PUT |
| SQLite append 1 update | 43 µs | 27 B | 0 |

**Storage growth & compaction**
| log table (Σ updates) | snapshot table | log/snap ratio | VACUUM reclaim (4× log, −70%) |
| --- | --- | --- | --- |
| 244.0 KB | 16.0 KB | 15.25× | 960.0 KB → 260.0 KB in 3.09 ms |