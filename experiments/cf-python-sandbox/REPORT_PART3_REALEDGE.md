# Part 3 — Real Cloudflare edge measurements (deployed)

Both workers are **deployed and live** on your account (workers.dev), measured from this environment to colo **ORD**. This converts every "container-internal" number from Parts 1–2 into real end-to-end figures.

## The headline you need

**<2 s cold start is NOT achievable for Python on Cloudflare Containers — not even fully optimized on standard-4.** Real measured cold start (scale-from-zero → first matplotlib result):

| Config (standard-2, colo ORD) | cold **p50** | cold mean | cold min | cold max | warm reuse |
|---|---|---|---|---|---|
| **Raw optimized container** (my build) | **3.08 s** | 3.15 s | 2.39 s | 4.24 s | **~0.40 s** |
| **SDK** (`sandbox:0.12.1-python`, py-pool=1) | **4.70 s** | 5.25 s | 3.47 s | 9.30 s | ~0.45 s |

| Raw optimized, **standard-4** | cold **p50 3.28 s** | mean 4.19 s | min 2.45 s | max 9.11 s | warm ~0.37 s |

n=10–12 sequential scale-from-zero each (fresh container per call, self-destroyed to free capacity). My total test usage was ~50 cold starts × a few seconds on small instances — a few cents at most, well inside the free allotment, as you asked.

### What this means
- **The 2 s target is off the table for cold starts.** The realistic floor for Python+matplotlib here is **~3 s median**, with a **tail to 7–9 s** (placement/image-distribution variance).
- **Warm reuse is a non-issue: ~0.4 s.** The split from Parts 1–2 holds — cold is the whole problem; warm is fast.
- My **local numbers undercounted by ~1.3 s.** Local container-internal cold→first was ~1.7–1.9 s; real edge is ~3.1 s. The gap is **Cloudflare's VM/sandbox boot + placement + worker↔container routing**, which local Docker can't reproduce. (Decomposition per request: CF schedule/route ~0.5 s + container boot incl. eager imports `age_ms` ~2.0 s + exec ~0.6 s.)

## Three things confirmed on real edge

1. **standard-2 ≈ standard-4 — the single-thread finding holds in production.** std-2 p50 3.08 s vs std-4 p50 3.28 s (std-4 was actually *worse* on tail in my sample). **Paying 2× for standard-4 buys zero cold-start improvement.** Use **standard-2**.
2. **The raw optimized container beats the SDK by ~1.6 s p50** (3.08 vs 4.70 s) and has a tighter tail (4.2 s vs 9.3 s max) — the SDK's IPython + Bun control server + 1.47 GB image (vs my 120 MB compressed) cost real latency. The Part-2 optimization work pays off on real edge.
3. **Even the optimized floor can't reach 2 s**, because a near-zero-work container on CF still costs ~1.5 s (base boot ~1 s + routing ~0.5 s), and numpy+matplotlib imports add ~1 s on top. There is no image trick that removes CF's own boot/placement.

## Decision

Your hard requirement ("cold starts guaranteed < 2 s") is **not satisfiable** with per-userID scale-to-zero containers on Cloudflare — the real number is ~3 s median with a heavy tail. Your realistic options:

- **A. Accept ~3 s on the first snippet, ~0.4 s after** (per-user container + `sleepAfter:"30s"`). Honest UX: first run of a session shows a ~3 s spinner; everything after is instant until the 30 s idle window closes. Cheap (~$80/1M execs + $5). **This is the only path that keeps your scale-to-zero, per-user model.**
- **B. Warm pool** to hide cold starts (you ruled this out; it's the only way to get sub-second *first* runs, at the cost of always-on instances).
- **C. If <2 s cold is truly non-negotiable**, Cloudflare Containers is the wrong primitive for this workload — you'd need a platform with faster Python cold start (e.g. a persistent autoscaled Python service, or Firecracker-snapshot platforms like Modal/Fly that restore a pre-imported process). I can benchmark one of those next if you want a comparison point.

My recommendation: **A on standard-2.** It's cheap, keeps your architecture, and the ~3 s first-run is a defensible UX (show a "warming up…" state). Just don't promise <2 s.

## Cost at the real awake-times
Raw std-2, destroy-after (awake ≈ 3.1 s cold): **~$80 / 1M cold execs + $5 base**. Warm execs are ~0.4 s awake → far cheaper. Keeping a per-user container warm bills **$0.057/awake-hour** (std-2). With `sleepAfter:"30s"` and sporadic use, awake time stays small.

## Live — click-test them yourself
- **Raw optimized (recommended):** https://avlo-pyexec-raw.issakakar001.workers.dev/ — buttons: ❄️ Cold start, 🔥 Warm run, 📊 10× cold (p50/p95), plus an editable snippet box that renders the returned plot.
- **SDK:** https://avlo-pyexec-sdk.issakakar001.workers.dev/cold (JSON) and `/warm`.

Both scale to zero (`sleepAfter 30s`), so they cost ~nothing idle. **Tear down when done:**
```
cd /home/user/sandbox-bench/deploy     && wrangler delete
cd /home/user/sandbox-bench/deploy-sdk && wrangler delete
```

## ⚠️ Rotate the token
The API token you pasted is in this chat transcript. **Rotate/delete it** in the Cloudflare dashboard once you're done here. I stored it only in `/home/user/.cf-creds/env` (chmod 600, outside any git repo) and never committed or echoed it.

---
### Artifacts (in `/home/user/sandbox-bench/`)
`deploy/` (raw worker: `src/index.ts`, `Dockerfile`, `server.py`, `wrangler.jsonc`), `deploy-sdk/` (SDK worker), plus the Part 1–2 harnesses/models. The raw build is the deployable reference for your real implementation.
