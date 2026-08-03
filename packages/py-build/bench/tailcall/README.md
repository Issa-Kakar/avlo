# Tail-call interpreter + `−O3` A/B — remote verification run

Independent second run for **Workstream A3** (V2 `−O3`, V3 tail-call interpreter),
executed on a clean 4-core box with no concurrent load. **Measurement only — nothing here
was integrated into the fork, and no toolchain file outside this directory was touched.**

Start with **[`FINDINGS.md`](./FINDINGS.md)**. The short version:

| | plan's ship rule | measured | |
|---|---|--:|---|
| V2 `−O3` | ≥3% geomean | −0.2% (V8 14.6), −3.8% (V8 13.6) | **fails** |
| V3 tail-call **variant 0** | ≥5% geomean | −1.1%, −7.2% | **fails** |
| V3 tail-call **variants 3/4/5/6** | ≥5% geomean | **+20% … +27%** | **passes** |

The plan sequences "variant 0 first, variants 3/4/6 only if variant 0 is promising."
Variant 0 — what stock CPython ships — is a net loss, so that gate drops the batch before
reaching the variants that actually win. Best is **variant 4 (+27.0%)** on V8 14.6, plain C.

Three results contradict assumptions in the plan; they are argued with data in `FINDINGS.md`:

1. The **Liftoff hypothesis is backwards** — under `--liftoff-only` every tail-call variant
   is 25–32% *slower*; the win only appears after TurboFan tiers up.
2. **Cold start does not improve** (geomean 0.97–1.01, flat).
3. **`−O3` inlines a new 157,736 B function into existence** — larger than the megafunction
   it fails to shrink, and invisible to a brotli-size budget.

## Contents

| path | what |
|---|---|
| `FINDINGS.md` | the report — verdicts, tables, mechanism, caveats |
| `results.json` | raw data: 10 variants × 11 benchmarks × 2 V8 versions × 3 tiers |
| `dispatch-verify.txt` | `return_call` / `return_call_indirect` / `br_table` counts per build |
| `raw-sweep.log` | unedited stderr of the measurement sweep |
| `harness/` | everything needed to reproduce |
| `reference/` | pyodide PR #6122 sources, for provenance — `.patch` and `.py` byte-exact; the `.mjs` had its formatting normalized by repo biome, logic untouched |

## Environment

CPython **3.14.2** and emscripten **5.0.3** — the pins from `build.config.json`, so the
toolchain matches. V8 via Node **26.5.1** (V8 14.6.202.34, ≈ Chrome 145) and Node **24.18.1**
(V8 13.6.233.17).

`reference/0010-generated-tail-dispatch.patch` (Dan Carney, Cloudflare, pyodide PR #6122,
targeting `abi_2026_0` — the same ABI as our pin) **applies verbatim to a stock 3.14.2
tarball**: it touches only `Python/ceval_macros.h`,
`Include/internal/pycore_interpframe_structs.h`, and `Tools/cases_generator/target_generator.py`.
No pyodide coupling.

## Reproducing

Each script has a `TC=` constant near the top pointing at the scratch root used for this
run. **Change that one path**, then:

```bash
# 1. toolchain: emsdk 5.0.3, CPython 3.14.2 source, Node 24 + 26 under $TC/tools/
# 2. apply the patch and regenerate the dispatch table (emits ALL variants, each behind
#    #if TAIL_CALL_DISPATCH_MODE == N, so one regen covers the whole matrix)
patch -p1 < reference/0010-generated-tail-dispatch.patch
./builddir/build/python Tools/cases_generator/target_generator.py

./harness/build-all.sh        # 10 variants, ~4 min each
./harness/drive.mjs           # measurement sweep  -> results.json
./harness/report.mjs          # -> REPORT.md
./harness/verify-dispatch.sh  # opcode counts per build
```

### Two traps worth carrying into the fork build

- **`musttail` is silently ignored without `-mtail-call`** — warning only, build succeeds,
  and you get a non-tail-call interpreter wearing the label. Same silent-failure class as
  the dead wasm-gc trampoline in A1. `verify-dispatch.sh` is the gate: assert
  `return_call_indirect` drops below ~100.
- **`LINKFORSHARED` hard-codes `-O2 -g0`** and is emitted *last* on the emcc link line, so it
  overrides anything in `LDFLAGS`. A naive `−O3` A/B changes compile flags only and leaves
  binaryen at `-O2`. `build-variant.sh` rewrites it per variant.

## What this run is not

A standalone CPython-for-emscripten build, **not** the AVLO fork: no patch queue 0001–0008b,
no `MAIN_MODULE=2` closed world, no grouped DSOs, no snapshot restore, no
`--enable-optimizations` (PGO), and no numpy/pandas/matplotlib (separate DSOs — their
dispatch does not route through the main module's interpreter).

**Relative deltas between dispatch variants should transfer. Absolute figures should not.**
Re-verify on the fork before shipping.
