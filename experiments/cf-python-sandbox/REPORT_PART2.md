# Part 2 — Low-level optimization, corrected costs, and the raw-container path

Answers your four asks: (1) corrected math, (2) re-verified pricing, (3) the pre-fetch/"behind-the-scenes warming" question, (4) every cold-start lever I could turn — **measured**, not asserted. All numbers from the real images run locally under Docker `--cpus`/`--memory` throttles (host: Xeon @2.8 GHz), CPU now measured via **cgroup core-seconds**, not estimated.

---

## 0. Corrections you were right to demand

**(a) My CPU cost was overstated.** Part 1 estimated CPU as `wall × full-vCPU-allocation`. That's wrong: Python import / IPython init is **single-threaded** and uses ~1 core regardless of allocation. Measured via cgroup, cold-start+first-result actually consumes:
- SDK (default pool): **4.1 core-s** (it prewarms 3 Python + 3 JS + 3 TS kernels in parallel — that's where the multi-core CPU went)
- SDK (py-only pool=1): **2.9 core-s**
- **Optimized minimal container: 1.4 core-s**

So real CPU cost is **~3× lower** than my Part 1 figure for the optimized path. Corrected per-execution and monthly numbers are in §4 — and yes, they're low.

**(b) "There's no way 100k/month" — you're right, it's cheap, and the $5 base is separate.** Corrected: **100k sporadic one-off executions ≈ $11/month** (standard-2, optimized, destroy-after) = ~$6 compute + **$5 Workers Paid base (flat, not per-exec)**. 1M ≈ $67/month. The earlier inflated CPU made it look pricier. The $5 is the Workers Paid floor and is *not* baked into the per-exec figures — add it once.

**(c) Pricing re-verified verbatim** (developers.cloudflare.com/containers/pricing + the 2025-11-21 changelog): memory **$0.0000025/GiB-s** (provisioned), CPU **$0.00002/vCPU-s** (active only — exactly your worked example: `1 vCPU × 3600 × $0.00002 × 20% = $0.0144`), disk **$0.00000007/GB-s** (provisioned), billed per 10 ms. Instance table unchanged. My rates were correct; only my CPU *quantity* was wrong.

---

## 1. Pre-fetch ≠ pre-warm (your warming question)

Your quote describes Cloudflare pre-positioning **images** and prepping **host machines** — **not** pre-booting *your* container. The doc is explicit: a novel ID "will start the container image from its entrypoint for the first time… variable amount of time to start." So:

- ✅ What background warming gives you: the **image is already on the chosen edge host** → the ~120–342 MiB image pull is usually hidden. This is why **image size matters less than I implied in Part 1** for steady-state (it still matters for rarely-hit regions / fresh deploys / cache eviction).
- ❌ What it does **not** give you: skipping **VM/sandbox boot + your entrypoint + the Python import/IPython warmup**. That is paid cold, every time a stopped instance starts. Their "1–3 s" figure *already assumes the pre-fetched image* and is essentially the boot+entrypoint cost — which is exactly what my container-internal numbers measure.

"If there's another instance running and I start a new one, isn't it warm?" — No. Each instance is independent; a second novel ID is its own cold boot. Other running instances only help in that the **host already has the image** (no pull). The entrypoint/import cost is per-instance and unavoidable without a warm pool — which you've ruled out.

**Net:** optimization must target **boot + entrypoint + imports**, not image pull. That's where the SDK is bloated and where the wins are.

---

## 2. Is it a pure-Python container? No — the SDK ships real bloat

The `cloudflare/sandbox:*-python` image (1.47 GB) carries, for a "run Python" workload you don't need:
- **Bun (99 MB) + Node 24** — for the JS/TS executors (it prewarms 3 of each!).
- **cloudflared (40 MB)** — Tunnel daemon (`sandbox.tunnels.*`).
- **s3fs / fuse3 / squashfs / fuse-overlayfs** — bucket mounting + snapshot tooling.
- **The Bun "sandbox" control server (99 MB)** + DI container + process-pool manager.
- **IPython** + the interpreter-pool machinery.

For Python snippets you need: CPython + numpy/pandas/matplotlib + a ~60-line HTTP exec server. That's the raw path. I built it (`opt/server_exec.py`, `opt/Dockerfile`) and measured every lever.

---

## 3. The levers — measured (cold-start → first matplotlib result)

All on the same throttled host. "Total" = ready + first-result (container-internal; CF placement/network is extra).

### 3a. Image / runtime levers (standard-4, 4 vCPU)

| Config | ready | first | **total** | warm | CPU core-s | RSS | image |
|---|---|---|---|---|---|---|---|
| SDK python, default pool | 718 | 2115 | **2833** | 128 | 4.1 | 624 MiB | 1.47 GB |
| SDK python, py-only pool=1 | 730 | 1898 | **2628** | 133 | 2.9 | 480 MiB | 1.47 GB |
| raw minimal (slim+exec, lazy) | 517 | 1378 | **1895** | 120 | 1.5 | 211 MiB | 533 MB |
| **opt minimal (lazy)** | 561 | 1136 | **1697** | 114 | 1.4 | 203 MiB | 543 MB |
| opt minimal, EAGER preimport | 1650 | 124 | **1774** | 121 | 1.5 | 205 MiB | 543 MB |
| opt minimal, **EAGER + FORK** | 1707 | 151 | **1858** | 148 | 1.5 | 217 MiB | 543 MB |
| opt minimal, IPython | 1236 | 1173 | **2409** | 126 | 1.3 | 244 MiB | 619 MB |

**What each lever buys (standard-4, total cold→first):**
| Lever | Δ | Notes |
|---|---|---|
| SDK → minimal optimized | **−931 ms (−35%)** | + CPU −52%, RSS −58%, image 1.47 GB→543 MB (compressed 342→**120 MiB**) |
| └ of which, dropping **IPython** | **−712 ms** | IPython `InteractiveShell` init is the single biggest removable chunk |
| └ of which, **bytecode precompile + font-cache prebake** | **−198 ms** | free; also removes the one-off matplotlib font-cache build |
| **EAGER preimport** | ~0 to total | moves imports into "ready"; first-exec → 124 ms. Same first-result total, but… |
| **+ FORK (ForkingHTTPServer)** | enables it | every exec runs in a forked child: **warm imports via COW + per-process isolation** (your "sandbox with processes" — for free, ~150 ms warm) |
| drop **pandas** from critical path (lazy-import) | **−309 ms** | numpy+matplotlib import = 742 ms vs +pandas = 1051 ms (1 vCPU). Most plots don't need pandas |

### 3b. Instance sizing — the single-thread finding (your standard-4 choice)

Imports are single-threaded, so **more vCPUs past 1 don't help cold start.** opt EAGER+FORK, cold→ready:

| instance | vCPU | RAM | ready (import-bound) | total cold→first | idle $/hr |
|---|---|---|---|---|---|
| basic | ¼ | 1 GiB | 5135 | 5741 | $0.010 |
| standard-1 | ½ | 4 GiB | 3127 | 3410 | $0.038 |
| **standard-2** | **1** | **6 GiB** | **1704** | **1853** | **$0.057** |
| standard-3 | 2 | 8 GiB | 1746 | 1899 | $0.076 |
| standard-4 | 4 | 12 GiB | 1707 | 1858 | $0.113 |

**standard-2 (1 vCPU) is the sweet spot: identical cold start to standard-4, at half the memory cost.** standard-4 is wasted money for this single-threaded, import-bound workload — its 4 cores only help if a *snippet itself* does heavy multi-threaded numpy (large matmuls/BLAS). For typical "compute a bit + plot," **use standard-2 and save ~50% on the dominant memory term.** Below 1 vCPU (std-1/basic) cold start degrades roughly inversely with the vCPU fraction.

---

## 4. Corrected costs (measured CPU)

Per-execution and monthly (compute + Workers/DO requests; **+ $5/mo flat base**):

| Config | instance | strategy | awake | $/exec | @100k/mo | @1M/mo |
|---|---|---|---|---|---|---|
| opt EAGER+FORK | **standard-2** | destroy-after | 1.85 s | $0.000062 | **$6** | **$62** |
| opt lazy | standard-4 | destroy-after | 1.70 s | $0.000086 | $9 | $86 |
| SDK py-only | standard-4 | destroy-after | 2.63 s | $0.000147 | $15 | $147 |
| opt EAGER+FORK | standard-2 | session-of-10, ka=30s | (amortized) | $0.000191 | $19 | $191 |

**Two cost regimes for per-userID containers (pick the mental model that fits your traffic):**
1. **Sporadic / one-off** (destroy after result, or snippets >keepalive apart → each cold-starts): cost scales with **execution count**. Optimized std-2 ≈ **$62 / 1M execs + $5**. Cheap.
2. **Active sessions** (snippets <keepalive apart → container stays warm): cost scales with **user-hours-awake**. Idle keepalive on std-2 = **$0.057/awake-hour**. Example: 1000 users each holding a warm std-2 container 1 hr/day × 30 d ≈ **$1,711/mo** (mem+disk; CPU ~0 while idle). On std-4 that's **$3,391/mo** — another reason std-2 wins.

Formula to plug your own numbers: `monthly ≈ Σ(container-awake-seconds) × (mem_GiB×$2.5e-6 + disk_GB×$7e-8) + Σ(active-core-seconds)×$2e-5 + requests + $5`. Awake-seconds is the lever you control via `sleepAfter`/`destroy()`; with ≤30 s keepalive and sporadic use, it stays small.

---

## 5. Snapshot techniques — the one floor-breaker you can't have

The irreducible cold-start floor for a matplotlib plot is **~1.3 core-seconds of single-threaded import** (numpy+pandas+matplotlib) + ~0.4 s boot/server. On ≥1 vCPU that's **~1.2–1.5 s container-internal**, and you can't import your way below it.

The only thing that beats it is **starting from a process snapshot that already has the libraries imported** (à la AWS Lambda SnapStart / CRIU restore). **Cloudflare Containers do not expose snapshot/restore** — a cold start always re-runs your entrypoint from scratch. The in-container equivalent is the **forkserver** I tested (parent imports once, forks per exec) — but the parent still pays the import once per *container* cold start; fork only helps the 2nd+ executions. So on this platform the ~1.2–1.5 s import floor stands. (If CF ever ships container snapshots, that floor collapses to boot-only ~0.4 s. Worth watching; not available today.)

Other micro-levers I did **not** find worth the complexity: `-OO` optimized bytecode (marginal, risks docstring-dependent libs), jemalloc/mimalloc LD_PRELOAD (~5–10% on import/alloc — measurable but small), `-X frozen_modules` (already default in 3.11). The big four are: **drop IPython, drop Bun/Node, slim base + prebaked bytecode/fontcache, lazy-import pandas.**

---

## 6. Recommended optimal build (raw CF Containers, per-userID)

- **Image:** `python:3.11-slim` + numpy/pandas/matplotlib + ~60-line exec server; `compileall` site-packages; prebaked matplotlib font cache; `MPLBACKEND=Agg`. **No IPython, no Bun/Node, no cloudflared.** ~543 MB / **~120 MiB compressed**.
- **Execution model:** `ForkingHTTPServer`, **EAGER preimport numpy+matplotlib** (lazy-import pandas), fork-per-exec → **warm imports + per-process isolation** (your sandboxing intent, built in).
- **Instance:** **standard-2** (1 vCPU / 6 GiB) — same cold start as standard-4, half the memory bill. Go standard-4 only if individual snippets do heavy multi-threaded numpy.
- **Lifecycle:** per-userID DO via `@cloudflare/containers` `Container` class (handles start/stop/sleep/routing); `sleepAfter:"20s"–"30s"` for warm session reuse, or `destroy()` right after result for pure sporadic.
- **Expected:** **~1.5–1.85 s container-internal** cold→first-result; warm execs ~150 ms; **$62/1M execs + $5** sporadic, or ~$0.057/awake-hour/user.
- **Trade-off vs SDK:** you write the exec server + DO routing yourself (~100 lines total; I've prototyped the server). You lose the SDK's sessions/preview-URLs/file-API — none of which you need for snippet execution.

---

## 7. The one thing still unmeasured — and your token

Everything above is **container-internal**. Real Cloudflare cold start = these numbers **+ placement scheduling + Worker↔container network** (and, on a cache miss, image pull). My host CPU (Xeon 2.8 GHz) may also differ ±20–40% from CF's cores. The two could roughly offset, or not — **only a real deploy settles whether optimized-std-2 lands under 2 s end-to-end.**

You've created an API token. The decisive next step: deploy **two** workers — (a) the SDK code-interpreter example, (b) the optimized raw container above — to your account, and run the SDK's own `tests/perf/cold-start.test.ts` + a matplotlib-result probe against both, from multiple regions. That converts every "container-internal" number here into a real end-to-end figure. I'm ready to do this on your go-ahead.

---
### Artifacts (in `/home/user/sandbox-bench/opt/`)
`Dockerfile` (raw/opt/opt-ipython targets), `server_exec.py` (exec+fork server), `server_ipython.py`, `bench2.sh` (IP-addressed harness, cgroup CPU), `costfinal.py` (corrected model), `/tmp/bench2.out` (raw results).
