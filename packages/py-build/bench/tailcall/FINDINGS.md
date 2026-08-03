# Tail-call interpreter + `−O3` on wasm — independent benchmark

Independent second run for AVLO Workstream A3 (V2 `−O3`, V3 tail-call interpreter),
plus the dispatcher-variant sweep that pyodide PR #6122 left unmeasured. Nothing here
was integrated; this is measurement only.

## Verdict

| | ship rule from the plan | result | verdict |
|---|---|---|---|
| **V2 `−O3`** | ≥3% geomean, br growth ≤8% | **−0.2%** (V8 14.6), **−3.8%** (V8 13.6); br +0.2% | **fails — do not ship** |
| **V3 tail-call, variant 0** | ≥5% geomean | **−1.1%** (V8 14.6), **−7.2%** (V8 13.6) | **fails** |
| **V3 tail-call, variants 3/4/5/6** | ≥5% geomean | **+20% to +27%** | **passes decisively** |

The plan's V3 route sequences "variant 0 first, variants 3/4/6 only if variant 0 is
promising." **That sequencing kills the winning approach.** Variant 0 — the thing stock
CPython ships — is a small net loss on this suite. The win lives entirely in Cloudflare's
centralised-dispatcher variants, which the plan gates behind a step that fails.

## Method

| | |
|---|---|
| CPython | 3.14.2 — AVLO's exact pin |
| Emscripten | 5.0.3 — AVLO's exact pin |
| V8 | node26 → **14.6.202.34** (≈ Chrome 145) · node24 → **13.6.233.17** |
| Host | 4-core Xeon @2.80 GHz, 15 GB, idle, no concurrent load |
| Suite | 11 benchmarks (dispatch/call/object/library mix), median of 9 in-process iterations |

`0010-generated-tail-dispatch.patch` from PR #6122 **applies verbatim to a stock 3.14.2
tarball** — it touches only `ceval_macros.h`, `pycore_interpframe_structs.h`, and
`target_generator.py`. No pyodide coupling. Your "not the same version, could matter"
concern does not apply.

### Fidelity deltas vs AVLO's real build — read before transferring numbers

- Standalone CPython-for-emscripten, **not** the AVLO fork. No patch queue 0001–0008b,
  no `MAIN_MODULE=2` closed world, no grouped DSOs, no snapshot restore.
- `--enable-wasm-dynamic-linking` (CPython's own emscripten default). AVLO's `MAIN_MODULE=2`
  is a narrower export surface, so absolute module sizes differ.
- No `--enable-optimizations` (PGO). AVLO's build uses it; PGO could interact with dispatch
  shape, and this run cannot see that.
- `--without-pymalloc`, matching AVLO.
- **Relative deltas between dispatch variants should transfer; absolute figures should not.**

## 1. Structural — the megafunction is real, and it dissolves

| variant | wasm | brotli | Δbr | funcs | `_PyEval_EvalFrameDefault` | handlers | median handler | dispatcher |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| goto −O2 **(AVLO today)** | 7.55 MB | 2.15 MB | — | 12926 | **78,942 B** | — | — | — |
| goto −O3 | 7.80 MB | 2.16 MB | +0.2% | 12754 | 78,485 B | — | — | — |
| tail v0 −O2 | 7.57 MB | 2.16 MB | +0.1% | 13158 | **726 B** | 231 | 250 B | — |
| tail v0 −O3 | 7.82 MB | 2.16 MB | +0.3% | 12985 | 700 B | 231 | 248 B | — |
| tail v1 −O3 | 7.82 MB | 2.16 MB | +0.4% | 12986 | 700 B | 231 | 255 B | 32 B |
| tail v2 −O3 | 7.82 MB | 2.16 MB | +0.3% | 12986 | 700 B | 231 | 261 B | 36 B |
| tail v3 −O3 | 7.82 MB | 2.16 MB | +0.3% | 12986 | 700 B | 231 | 237 B | 4016 B |
| tail v4 −O3 | 7.82 MB | 2.16 MB | +0.3% | 12986 | 700 B | 231 | 237 B | 4011 B |
| tail v5 −O3 | 7.82 MB | 2.16 MB | +0.2% | 12986 | 700 B | 231 | 237 B | 6561 B |
| tail v6 −O3 | 7.82 MB | 2.16 MB | +0.3% | 12986 | 700 B | 231 | 237 B | 4023 B |

`_PyEval_EvalFrameDefault` is **78,942 B — the single largest function in a 12,926-function
module.** The tail-call interpreter reduces it to a ~700 B entry stub and redistributes the
work across 231 handlers with a median of ~240 B. **Brotli cost of the whole change: +0.3%.**
Size is a non-issue; `check-budgets.mjs` will not notice.

### `−O3` has a hazard your budget gate cannot see

`−O3` barely touches the eval loop (78,942 → 78,485 B) but inlines a **new 157,736 B
function** into existence — twice the size of the megafunction it failed to shrink. Function
count falls 12,926 → 12,754; code section grows 4.06 → 4.32 MB. Brotli only moves +0.2%, so
a size-based budget passes it while a compile-time hazard doubles. (Identity unknown — `−g0`
strips names; an `--emit-symbol-map` relink would name it.)

## 2. Dispatch verification — the mechanism

Counted on the emitted wasm. Without `-mtail-call`, clang silently ignores `musttail`
(warning only), so this gate is not optional.

| variant | direct `return_call` | `return_call_indirect` | steady geomean (V8 14.6) |
|---|--:|--:|--:|
| goto −O2 / −O3 | 0 | 0 | 1.000 / 0.998 |
| tail v0 | 1119–1251 | **328** | 0.979 / 0.989 |
| tail v1, v2 | 1118 | **328** | 0.908 / 0.861 |
| **tail v3, v4, v6** | **1586** | **85** | **1.202 / 1.270 / 1.231** |
| **tail v5** | **1617** | **85** | **1.234** |

Performance tracks the indirect-call count exactly. The winning variants cut
`return_call_indirect` by 74% (328 → 85) by replacing per-opcode indirect dispatch with one
centralised `br_table` into 256 *direct* `return_call`s. V8 must type-check and bounds-check
every `return_call_indirect`; a direct `return_call` is a static jump.

Variants 1 and 2 are instructive failures: they centralise the dispatcher but keep the
indirect call, adding a hop without removing the check — **worse than doing nothing.**

## 3. Steady state — the headline

Geomean speedup vs `goto −O2`. >1.00 = faster.

| variant | V8 14.6 (≈Chrome 145) | V8 13.6 | `--liftoff-only` |
|---|--:|--:|--:|
| goto −O2 **(AVLO today)** | 1.000 | 1.000 | 1.000 |
| goto −O3 | 0.998 | 0.962 | 1.049 |
| tail v0 −O2 | 0.979 | 0.893 | 0.729 |
| tail v0 −O3 | 0.989 | 0.928 | 0.754 |
| tail v1 −O3 central indirect | 0.908 | 0.816 | 0.750 |
| tail v2 −O3 switch→fnptr | 0.861 | 0.804 | 0.750 |
| **tail v3 −O3 switch direct** | **1.202** | **1.238** | 0.721 |
| **tail v4 −O3 switch+default** | **1.270** | **1.202** | 0.722 |
| **tail v5 −O3 br_table multivalue** | **1.234** | **1.189** | 0.681 |
| **tail v6 −O3 br_table asm** | **1.231** | **1.239** | 0.730 |

Best on V8 14.6: **variant 4 (+27.0%)**. Best on V8 13.6: **variant 6 (+23.9%)**. The four
winners are within ~4 points of each other on both engines — the choice among 3/4/5/6 is
close to arbitrary, so pick on maintenance cost, not speed.

Per-benchmark, variant 4 on V8 14.6: fib **1.61×**, pystone **1.65×**, fannkuch 1.36×,
binary_trees 1.35×, dict_ops 1.39×, nbody 1.27×, meth_noargs 1.16×, str_ops 1.14×,
json_roundtrip 1.03×, spectralnorm 0.97×, dispatch_tight 1.22×. Only spectralnorm regresses,
and marginally.

Stability is not in question — raw pystone iterations, V8 14.6:
`goto−O2 [31.2, 28.4, 29.0, 28.7, 30.7, 31.8, 28.3, 28.5, 28.5]` vs
`tc4−O3 [17.9, 17.4, 17.3, 17.5, 17.0, 16.8, 17.1, 17.7, 17.6]`.

## 4. Null results — reported because they were hypotheses

**Cold start does not improve.** Fresh process, one benchmark, one iteration, 3 repeats:
geomean **0.970–1.007** across every variant. Flat. Process spawn plus Python init dominates
(~350 ms); the interpreter's share is too small to move.

> The baseline's `dict_ops` cold sample is contaminated — `[382, 600, 672]` against ~350–410
> for every other variant. The auto-generated table's cold geomeans are inflated ~4–5% by it.
> The 0.970–1.007 figures above exclude it and are the honest ones.

Bare startup (`-c pass`) *does* improve, 328 ms → 274–302 ms (−8% to −16%), consistent with
lazy compilation touching fewer handlers. It washes out as soon as real work runs.

**The Liftoff hypothesis is wrong — backwards, in fact.** The plan (line 61) expects
"megafunction vs ~250 small functions for Liftoff + first-run OSR" to favour tail calls.
Measured: under `--liftoff-only`, **every** tail-call variant is 25–32% *slower*, and
`goto −O3` is 4.9% *faster*. Tail-call dispatch only wins after TurboFan tiers up. During
the baseline-compiler phase the megafunction is the better shape.

**V8 compiles wasm lazily**, which is why the compile-time axis is empty:
`WebAssembly.compile()` costs ~17 ms for every one of these 7.8 MB modules regardless of
tier, because it only decodes and validates — function bodies compile on first call.
Verified under `--single-threaded`, `--liftoff-only`, `--no-liftoff`, and
`--wasm-lazy-compilation`.

## 5. pystone alone is actively misleading

| variant | pystone only | full 11-benchmark suite |
|---|--:|--:|
| tail v0 −O2 | **1.15** | 0.979 |
| tail v0 −O3 | **1.21** | 0.989 |
| tail v1 −O3 | 1.02 | 0.908 |
| tail v2 −O3 | 0.99 | 0.861 |
| tail v4 −O3 | **1.65** | 1.270 |
| tail v6 −O3 | **1.67** | 1.231 |

pystone overstates every tail-call variant, and inverts the sign for variant 0: it reads
+21% where the suite reads −1%. PR #6122's harness (`bench-pystone.mjs`) and upstream issue
#6102 both measure pystone only. Any verdict from that instrument is unreliable in either
direction.

## 6. Recommendations

1. **Drop V2 (`−O3`).** No steady-state gain on either engine, a regression on V8 13.6, and
   it manufactures a 157 KB function. Its only win is `--liftoff-only`, a transient phase.
2. **Restructure V3.** Do not gate variants 3/4/6 behind variant 0 — variant 0 fails and the
   plan drops the batch there. Go straight to the centralised-dispatcher variants.
3. **Prefer variant 4 or 6.** Variant 4 is plain C (a 256-case switch the compiler lowers to
   `br_table` + direct `return_call`s) and is fastest on V8 14.6. Variant 6 is hand-written
   inline wasm asm, fastest on V8 13.6, and carries real maintenance cost. **Variant 4 gets
   ~99% of variant 6's benefit in portable C** — take variant 4.
4. **Variant 5 needs no binary patching.** It built and ran correctly here without
   `patch_wasm.py`. Note the plan's line 60 mis-describes the split: variants 5 *and* 6 are
   both inline-asm `br_table` (5 with multivalue blocks, 6 without); the binary patch is a
   post-link fixup applied only to 5. Variant 5 is still not worth it — slowest of the four
   winners and the largest dispatcher (6561 B).
5. **Re-verify on the real fork before shipping.** These deltas come from a standalone build.
   `MAIN_MODULE=2` + the AVLO patch queue + PGO could all interact with dispatch shape.
6. **Add a `-mtail-call` gate.** `musttail` is silently ignored without it — same silent-failure
   class as the dead trampoline in A1. Assert `return_call_indirect` count drops below ~100
   in the built wasm.

## 7. Caveats

- 4-core host; V8's background compilation has less parallelism than an 8-core dev box.
- Steady state is median of 9 in-process iterations; cold is median of 3 process spawns.
  Cold has visibly higher variance (see the `dict_ops` contamination).
- Suite is pure-Python plus stdlib C extensions. **No numpy/pandas/matplotlib** — those ship
  as separate DSOs whose dispatch does not route through the main module's interpreter.
- One host, one session. Absolute ms are not comparable to your local board.
