# Cloudflare Sandbox SDK — Python Cold-Start & Cost Benchmark

**For:** avlo canvas code-block execution (short, stateless Python snippets; matplotlib/numpy/pandas).
**Question:** Can the Sandbox SDK give **guaranteed <2s cold start** on a **per-user, scale-to-zero, ≤30s keep-alive** sandbox, and what does it cost?
**Date:** 2026-06-21. **Method:** real `cloudflare/sandbox:0.12.1-python` image, run locally under Docker with `--cpus`/`--memory` throttling to simulate each Cloudflare instance type. Cost model from current (post-2025-11-21) Cloudflare pricing.

---

## TL;DR / Verdict

**Your exact requirement — per-user, scale-to-zero, cheap instance, cold start <2s — is not achievable with the stock SDK, and the three constraints are mutually contradictory.** The reason is specific and measurable:

- A Cloudflare "container cold start" (officially **1–3s**) only gets you to *HTTP-ready*. The **Python code-interpreter then spawns an IPython kernel**, and that warmup is **CPU-bound and dominates cold start** — and CPU is exactly what the cheap instances starve.
- Measured **run → ready-to-execute-Python** (container-internal, *excludes* Cloudflare's image-pull/placement):

| Instance | vCPU | RAM | **Cold start (Python-ready)** | <2s? |
|---|---|---|---|---|
| **standard-4** | 4 | 12 GiB | **1.36 s** | ✅ (before CF overhead) |
| **standard-1** | ½ | 4 GiB | **4.06 s** | ❌ |
| **basic** | ¼ | 1 GiB | **8.41 s** | ❌ |

  Cheap instance ⇒ slow cold start. The only instance near 2s is the **most expensive** one — and even 1.36s is *before* Cloudflare adds placement + (cache-miss) image distribution.

- **The resolution:** your snippets are **stateless** ("no persistence or context between them"), so you don't actually need a *per-user* sandbox — you need *per-execution isolation*. Put a **small shared pool of pre-warmed containers** in front. That makes user-visible cold start **~0** (warm execution is **0.3–0.6 s** even on `basic`) **and** is **cheaper** than per-user cold containers at scale. Cold-start-on-the-critical-path and "<2s guaranteed" cannot coexist on a cheap per-user instance; a warm pool sidesteps both.

**Cost (compute + request layers, at 1M executions/month):** roughly **$60–$375/mo** for per-user strategies, or **$25–$117/mo** for a shared warm pool of 3 — plus the mandatory **$5/mo Workers Paid** base. Per execution that's **$0.00006–$0.0004**.

---

## 1. What "cold start" actually consists of (the key finding)

Cloudflare's published "container cold starts… in the **1–3 second range**" is the *generic* container metric. For Python code execution there are **two** sequential costs, and the second is the one nobody quotes:

```
run → [container boot + Bun server up] → HTTP-ready → [spawn IPython kernel] → Python-ready
        0.6–1.4 s (CF's "1–3s" lives here)             +0.7 s … +7.0 s  ← Python-specific, CPU-bound
```

Measured split (local, cold page cache):

| Instance | HTTP-ready | + IPython warmup | = Python-ready |
|---|---|---|---|
| standard-4 (4 vCPU) | 0.64 s | **+0.72 s** | 1.36 s |
| standard-1 (½ vCPU) | 0.84 s | **+3.23 s** | 4.06 s |
| basic (¼ vCPU) | 1.41 s | **+7.00 s** | 8.41 s |

The IPython `InteractiveShell` init is ~0.7 s of pure CPU work; throttle the CPU to ¼ and it becomes ~7 s. **This is why small instances can't hit the target** — it's not I/O or image size, it's single-threaded CPU.

> Confirmed in source: the pre-warmed pool (`PYTHON_POOL_MIN_SIZE=3`) spawns IPython kernels at boot, *but the kernels do NOT pre-import numpy/pandas/matplotlib* (`ipython_executor.py` only inits the shell + sets `MPLBACKEND=Agg`). So the first snippet that imports the data-science stack pays import cost on top (see §2).

### Image size (Cloudflare edge cache-miss pull)
- `sandbox:0.12.1-python`: **1.47 GB** on disk / **342 MiB compressed**.
- `sandbox:0.12.1` (no Python): 850 MB / 213 MiB compressed.

Cloudflare pre-fetches images across locations, so steady-state this is usually a cache *hit* (~0 added). But a cold/under-used region or a fresh deploy pays a one-time ~342 MiB pull — budget **+1–5 s tail** on those. A slimmer image is the main lever on *this* component (not on the IPython cost).

---

## 2. Execution latency — cold imports vs. warm steady-state

`POST /api/contexts` (bind kernel) → `POST /api/execute/code`. First run on a fresh kernel pays Python imports; the **same kernel keeps modules in `sys.modules`**, so repeats are warm. Latency (ms), **cold / warm**:

| Snippet | standard-4 | standard-1 | basic |
|---|---|---|---|
| `print('hello')` | 22 / 14 | 24 / 66 | 183 / 90 |
| `import numpy` + sum | 148 / 14 | 591 / 16 | 1094 / 85 |
| `import pandas` + groupby | 465 / 15 | 1126 / 15 | 2896 / 17 |
| numpy+matplotlib → PNG | 845 / 144 | 1841 / 315 | 3573 / 594 |

**Warm execution is fine everywhere** (≤0.6 s). The problem is purely the cold path. End-to-end **first matplotlib result on a cold container** (cold start + first snippet):

- standard-4: 1.36 + 0.85 = **~2.2 s** (+ CF overhead)
- standard-1: 4.06 + 1.84 = **~5.9 s**
- basic: 8.41 + 3.57 = **~12 s**

---

## 3. Memory footprint → smallest viable instance

Idle container (pools warm, before user imports): **~320–382 MiB**. A context that imports pandas+matplotlib adds ~150 MiB → **~500 MiB** for one active user.

- **`lite` (256 MiB): ruled out** — won't hold the runtime.
- **`basic` (1 GiB): fits** one active user comfortably; tight if you keep several warm contexts.
- Memory is *not* the constraint that forces a bigger instance — **CPU (cold-start speed) is.**

Optimization that helps a little: set `PYTHON_POOL_MIN_SIZE=1`, `JAVASCRIPT_POOL_MIN_SIZE=0`, `TYPESCRIPT_POOL_MIN_SIZE=0` to stop the image pre-warming 9 processes (3 Python + 3 Node + 3 TS). Measured cold-start improvement: standard-1 **4.06 → 3.33 s**, basic **8.41 → 6.93 s**. Helps, doesn't fix.

---

## 4. Cost model

**Pricing used** (USD, Workers Paid, post 2025-11-21): memory **$2.5e-6/GiB-s** and disk **$7e-8/GB-s** bill on the instance's **full provisioned allocation for the entire time it's awake**; vCPU **$2e-5/vCPU-s** bills on **active usage only**. Durable Object fronting the container adds requests ($0.15/M over 1M free) + duration ($12.50/M GB-s over 400k free, billed at 128 MB). Workers requests $0.30/M over 10M free. Egress $0.025/GB over 1 TB free (NA/EU). **Mandatory $5/mo Workers Paid base.** Full sources in `pricing-notes` below.

**The dominant term is memory × awake-seconds.** Every idle keep-alive second bills full instance memory — which is why your "≤30s, ideally less" instinct is correct, and why **`destroy()` right after the result** (or a warm pool) beats a long `sleepAfter`.

### Per-execution cost

| Strategy | basic | standard-1 | standard-4 |
|---|---|---|---|
| **destroy() immediately** (1 cold container/exec) | $0.000101 | $0.000120 | $0.000219 |
| **sleepAfter 30s, one-off** (worst case) | $0.000233 | $0.000485 | $0.001209 |
| **sleepAfter 30s, amortized / 10-snippet session** | $0.000061 | $0.000144 | $0.000374 |
| **sleepAfter 10s, amortized / 10-snippet session** | $0.000053 | $0.000120 | $0.000308 |

### Monthly at scale (compute + requests; add $5 base)

| Execs/mo | basic destroy | basic keepalive30 (session) | standard-1 destroy | standard-4 destroy |
|---|---|---|---|---|
| 100 k | $10 | $6 | $12 | $22 |
| 1 M | $101 | $61 | $120 | $219 |
| 10 M | $1,015 | $613 | $1,203 | $2,188 |

### Shared warm pool (zero cold start for users)

Always-on pool of N containers (memory+disk billed 730 h/mo continuously; CPU only during executions). **Cheaper than per-user cold containers at scale AND eliminates cold start:**

| Pool | basic @1M execs/mo | standard-1 @1M execs/mo |
|---|---|---|
| pool = 3 | **$25/mo** ($0.000025/exec) | $86/mo |
| pool = 10 | $76/mo | $281/mo |

Size the pool for **peak concurrency**, not average. At 1M execs/mo (~0.4/s average) a pool of 3–10 absorbs typical bursts; overflow falls back to a (slow) cold start or a queue.

---

## 5. The three viable architectures

| | **A. Per-user, scale-to-zero** (what you described) | **B. Per-user, pre-warmed** | **C. Shared warm pool** (recommended) |
|---|---|---|---|
| User-visible cold start | ❌ 4–8 s (cheap) / ~1.4 s+CF (standard-4) | ✅ ~0 | ✅ ~0 (warm exec 0.3–0.6 s) |
| Meets "<2s guaranteed"? | Only on standard-4, and not guaranteed once CF overhead is added | Yes | Yes |
| Cost @1M execs | $60–220/mo | high — ~1 always-on container *per active user* | **$25–117/mo** (pool 3–10) |
| Isolation | Strong (container per user) | Strong | Weaker — co-locates executions; needs per-exec process/container reset |
| Fits "stateless snippets"? | overkill | overkill | **ideal** |

**Why C fits you:** you stated snippets need *no persistence between them*. That removes the only reason to pin a container to a user. A pre-warmed pool gives each execution a fresh IPython **context** (or a fresh **container** popped from the warm pool for stronger isolation of untrusted code), runs it, and recycles — users never wait for a cold start, and 3–10 shared containers serve a large user base.

**Security note for C:** running *untrusted* user Python in a *shared* container relies on in-container isolation between executions. For arbitrary user code, prefer **container-per-execution drawn from a warm pool** (the SDK's `WarmPool` DO consumes a hot container per session and replenishes) over many contexts in one shared container. That keeps cold start hidden while preserving container-level isolation. The SDK ships this pattern (`packages/sandbox/src/bridge/warm-pool.ts`, default `WARM_POOL_TARGET=0` = off).

---

## 6. Recommendations

1. **Don't put a cold start on the user's click path.** Whatever else you choose, hide it behind a warm pool (architecture C) or you will not hit <2s.
2. **If you keep per-user containers** (architecture A/B), then:
   - Use **`basic`** (cheapest that fits) and accept a slow *first* snippet, OR **`standard-4`** if the first snippet must be ~2s — but standard-4 costs ~2× and still isn't *guaranteed* <2s once CF placement/image-pull is included.
   - Set `sleepAfter: "10s"`–`"30s"` **and call `sandbox.destroy()` as soon as you have the result** — idle keep-alive is pure memory billing.
   - Set `PYTHON_POOL_MIN_SIZE=1`, `JAVASCRIPT_POOL_MIN_SIZE=0`, `TYPESCRIPT_POOL_MIN_SIZE=0`.
3. **Two image optimizations** (help the CF image-pull tail + first-snippet, not the IPython-init CPU floor):
   - Build a **slim Python image** (don't ship Node/Bun/cloudflared/s3fs you don't use) to shrink the 342 MiB pull.
   - **Pre-import numpy/pandas/matplotlib in the kernel at warm-up** (patch the executor) so the first snippet skips the 0.6–1.1 s import — only worthwhile combined with a warm pool, since it makes warmup itself longer.
4. **The biggest container-internal cold-start win, if you go custom:** the IPython kernel is 0.7–7 s of the cold start. A **minimal executor** (plain `exec()` + manual `plt.savefig()` capture, no IPython) starts in ~50 ms. You lose IPython's rich-display conveniences but cut the dominant cold-start term. Worth prototyping if you want per-user cold containers to feel instant.
5. **Get the one number I couldn't measure.** Everything here is container-internal. Real Cloudflare **edge cold start = these numbers + placement + (cache-miss) image pull**. Deploy the `code-interpreter` example to a Workers Paid account and run the SDK's own `tests/perf` (`cold-start.test.ts`) against it for the true production figure. I can do this end-to-end if you provide a Cloudflare API token.

---

## Reproduce
- `harness.sh` — cold-start + latency harness (drives the real container HTTP API across simulated instance types).
- `costmodel.py` — parametric cost model (edit measured constants / scenarios at top).
- `pybench.py` — pure Python interpreter/import/plot micro-benchmark.
- Images pulled: `cloudflare/sandbox:0.12.1-python`, `cloudflare/sandbox:0.12.1`.

## Measurement caveats (read before trusting absolute numbers)
- **CPU simulation:** Docker `--cpus` (CFS quota) models fractional-vCPU CPU-bound scaling well; absolute ms depend on core speed. Host = Intel Xeon @2.8 GHz. Cloudflare's per-core speed may differ ±, but the **relative** "cheap instance = multiples slower cold start" result is robust and is the decision-driver.
- **Excludes** Cloudflare image distribution + placement scheduling + Worker↔container network. Add those on top (CF official generic cold start 1–3s ≈ the HTTP-ready row; the IPython row is extra and Python-specific).
- Page cache dropped before each cold run to emulate cold disk.
- Cost model: DO-duration term assumes the fronting DO bills for the awake window at 128 MB; if it hibernates while waiting this is lower. Memory/disk/CPU/request rates are exact per Cloudflare docs.
