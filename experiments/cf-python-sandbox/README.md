# CF Containers — Python execution cold-start & cost investigation

Benchmark/spike for running short Python snippets (numpy/pandas/matplotlib) for avlo code blocks on
Cloudflare Containers. **Not wired into avlo** — standalone reference. Reports tell the story in order:

- `REPORT.md` — Part 1: SDK architecture, local cold-start, first cost model.
- `REPORT_PART2.md` — Part 2: optimization levers (drop IPython/Bun/Node, slim base, fork-per-exec), corrected cost model (measured CPU), the standard-2 = standard-4 finding.
- `REPORT_PART3_REALEDGE.md` — Part 3: **real Cloudflare edge** measurements (deployed). Cold p50 ≈ 3.1 s (raw) / 4.7 s (SDK); warm ≈ 0.4 s; <2 s not achievable.
- `REPORT_PART4_PLACEMENT.md` — Part 4: log/placement investigation — containers land at far CF hubs (IAD/ATL/MIA), not near the request; why latency is geographically unpredictable.

## Headline
Real cold start for Python+matplotlib on CF Containers is **~3 s median (not <2 s)**, dominated by Firecracker boot + numpy/matplotlib import (~2 s, network-free) plus a **capacity-driven placement hop** to a far hub. Warm reuse is ~0.4 s. Optimized raw container beats the Sandbox SDK by ~1.6 s and runs fine on **standard-2** (1 vCPU) — more vCPUs don't help (single-threaded imports).

## Layout
- `deploy/` — **recommended raw build**: `python:3.11-slim` + numpy/pandas/matplotlib, `server.py` (fork-per-exec, eager numpy+matplotlib, lazy pandas), `src/index.ts` (raw `@cloudflare/containers` Worker + click-to-test frontend), `wrangler.jsonc` (standard-2, sleepAfter 30s).
- `deploy-sdk/` — Sandbox SDK comparison (`cloudflare/sandbox:0.12.1-python`, py-only pool).
- `opt/` — local optimization harness (`bench2.sh`, cgroup CPU), corrected cost model (`costfinal.py`), server variants.
- `harness.sh`, `costmodel.py` — Part 1 local harness + first model.

## Live test endpoints (delete when done)
- Raw: https://avlo-pyexec-raw.issakakar001.workers.dev/  (buttons: cold / warm / 10× cold + editable snippet)
- SDK: https://avlo-pyexec-sdk.issakakar001.workers.dev/cold
- Teardown: `cd deploy && wrangler delete` and `cd deploy-sdk && wrangler delete`

## Build note
The `host-ca.crt` COPY + `PIP_CERT` lines in the Dockerfiles exist only to build behind this dev session's
TLS-intercepting proxy. **Remove them for a normal build** (`pip install` works directly).

## Deploy
`cd deploy && npm install && CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npx wrangler deploy`
(requires Workers Paid; a local Docker daemon builds + pushes the image).
