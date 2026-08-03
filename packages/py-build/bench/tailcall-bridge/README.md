# tailcall-bridge — local cross-verification of PR #16 (remote tail-call sweep)

2026-08-03. Bridge experiments connecting the remote agent's standalone-CPython
sweep (`bench/tailcall/` on branch `claude/codespaces-python-builds-73xnm8`,
PR #16) to the fork's saved builds (`bench/builds/v1-ship`, `v3-tailcall`).
Host: Ryzen 7 4800H (Zen 2), WSL2, boost policy aggressive. Engines: system
node 24.16.0 (V8 13.6.233.17) + scratch node 26.5.1 (V8 14.6.202.34 — the
remote's exact pair). All A/Bs: 3 interleaved fresh-process pairs, median of
9 in-process iterations, the remote's own `bench.py` suite (11 benchmarks).

## Headline: the verdict is a function of the BUILD, then the HOST

tc0/goto **time** ratio (>1 = tail-call variant 0 slower), same suite everywhere:

| | V8 13.6 | V8 14.6 |
|---|--:|--:|
| **fork build, this host** | **1.232** | **1.246** |
| standalone build, this host | 0.933 | **0.828** |
| standalone build, remote Xeon | 1.120 | 1.021 |

- Build flips the sign on the same host+engine (1.246 vs 0.828).
- Host moves standalone by ~20 points on the same build+engine (0.828 vs 1.021).
- The fork numbers are engine-INsensitive; standalone is engine-sensitive.

Mechanism (absolute ms, node26, this host): **tail-call dispatch costs the same
in both builds** — fork-tc0 ≈ sa-tc0 (fib 25.8 vs 26.4, pystone 20.6 vs 20.7,
dispatch_tight 75.9 vs 74.4) — while the **fork's goto baseline is ~2× faster
than stock CPython's emscripten build** (fib 17.4 vs 34.3, pystone 15.4 vs 30.5,
meth_noargs 14.7 vs 33.3). The remote's +20–27% v3–v6 wins are measured against
the weak stock baseline; the fork has already banked a much larger version of
that headroom through build config. Config deltas found (not bisected): fork
compiles with `-fwasm-exceptions -sSUPPORT_LONGJMP=wasm` (stock: JS-based EH),
links `MAIN_MODULE=2` closed-world via the pyodide recipe (stock:
`--enable-wasm-dynamic-linking` ≈ MAIN_MODULE=1), plus patches 0001–0008b.
Fork code section 4.87 MB / 11,969 funcs vs stock 4.06 MB / 12,926.

## Fork per-benchmark (their suite, their engines, this host)

v3-tailcall / v1-ship, medians of 3 interleaved pairs:

| bench | 13.6 | 14.6 | 14.6 `--no-liftoff` |
|---|--:|--:|--:|
| dispatch_tight | 1.085 | 1.389 | 1.26 |
| nbody | 1.442 | 1.356 | 1.40 |
| fannkuch | 1.275 | 1.310 | 1.27 |
| spectralnorm | 1.224 | 1.112 | 1.10 |
| fib | 1.529 | 1.484 | 1.43 |
| binary_trees | 1.376 | 1.352 | 1.35 |
| meth_noargs | 1.234 | 1.243 | 1.19 |
| dict_ops | 1.095 | 1.160 | 1.09 |
| str_ops | 1.035 | 1.055 | 0.99 |
| json_roundtrip | 0.975 | 1.004 | 0.97 |
| pystone | 1.420 | 1.337 | 1.36 |
| **geomean** | **1.232** | **1.246** | ~1.22 |

Flat within-process iteration curves from iteration 1 (boot tiers the
interpreter) + the `--no-liftoff` column ⇒ variant 0 loses **in pure TurboFan
code** on the fork; no tier rescues it. This confirms the `V3-redo-*` ledger
verdict on an independent suite.

## Verification of the remote report itself

- Every headline geomean **recomputes exactly** from their `results.json` — no
  cherry-picking. v1/v2 (centralized-but-still-indirect, worse than baseline)
  are genuinely good controls: they isolate direct-vs-indirect `return_call`
  as the active ingredient of the v3–v6 wins *within their build*.
- Opcode counts reproduce: local rebuild of their exact recipe gives
  goto 0/0/2378 and tc0 1248/302/2377 (theirs: 0/0/2378, 1251/302/2377); the
  fork's v3-tailcall build censuses 1146/300 — same dispatch shape everywhere,
  so NONE of the perf differences are about emitted dispatch instructions.
- Claims that did NOT survive: "AVLO's build uses PGO" (false —
  `--enable-optimizations` is passed but pyodide's Makefile builds `$(PYLIB)`
  directly, never `profile-opt`; `PGO_PROF_USE_FLAG` empty, no profdata);
  `raw-sweep.log` cited but not committed; the bare-startup −54 ms
  "lazy-compile" attribution is unverified (Liftoff compiles the 79 KB
  megafunction in ~2–4 ms — the delta must be something else) and washes out
  anyway; the cold-isolated table is flat once the self-flagged contaminated
  baseline dict_ops cell is excluded; steady cells are single-process,
  sequential, non-interleaved. And the critical one: **"relative deltas
  should transfer" is empirically false** — transfer INVERTS between the
  stock build and the fork.
- Also note: stock 3.14.2 does NOT build variant 0 under emscripten at all
  (`__attribute__((preserve_none))` is a hard error); their tree had PR
  #6122's 0010 patch applied for every tail-call variant, ours needs 0011.

## What this means for variants 3/4/6

The +27% v4 headline is real *against stock-standalone* but says little about
the fork. Two independent projections (fork-tc0 × their v4/tc0 margin; and
host-scaled absolutes) both land v4-in-fork ≈ **wash vs the fork baseline** on
pure-Python dispatch, with the fork's faster C-call machinery untouched either
way. Genuinely open, but the only meaningful experiment is the kit protocol
(`bench/v3-tailcall-patches/README.md`) with `TAIL_CALL_DISPATCH_MODE=4` in the
fork lane, A/B'd against `builds/v1-ship` — plus at least one non-Zen host,
since dispatch style is uarch-sensitive enough to flip signs (0.83 here vs 1.02
on their Xeon for the same binaries' build).

## Reproduce

- `child.mjs` boots a saved fork build and runs the remote suite in-process;
  `bridge.mjs` = 3 interleaved fork pairs (`node bridge.mjs node26`, run under
  the engine you're testing); `bench-remote.py` = the PR's suite, verbatim.
- `build-standalone.sh` rebuilds the remote's standalone goto-O2/tc0-O2 from a
  stock 3.14.2 tarball + their `reference/0010-generated-tail-dispatch.patch`,
  using the in-repo emsdk (~15 min); `sa-bridge.mjs` runs the standalone A/B.
  Paths inside point at the session scratchpad — adjust `TC`/`HERE` first.
