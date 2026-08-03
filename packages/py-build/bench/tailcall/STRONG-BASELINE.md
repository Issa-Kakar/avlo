# Strong-baseline sweep — does the fork's exception scheme explain the inversion?

Follow-up to the PR #16 review, which showed that "relative deltas transfer" is false:
variant 0 measures ~17% *faster* than computed-goto on a standalone build and ~24% *slower*
on a fork build, because the fork's goto baseline is ~2x faster while tail-call dispatch runs
at the same absolute speed in both.

This sweep adds the fork's exception/longjmp scheme to the standalone build and measures
EH against non-EH **on one host, interleaved**, to test whether that flag pair is the mechanism.

| | |
|---|---|
| CPU | `Intel(R) Xeon(R) Processor @ 2.10GHz` |
| EH flags | `-fwasm-exceptions -sSUPPORT_LONGJMP=wasm` (both CFLAGS and LDFLAGS) |
| V8 | node26 14.6.202.34-node.24 · node24 13.6.233.17-node.50 |
| Sampling | 3 fresh processes per cell, interleaved by repetition; each process reports median of 9 in-process iterations |

> **Host caveat.** The container was restarted between sessions, so this host
> (`Intel(R) Xeon(R) Processor @ 2.10GHz`) is *not* the one that produced `results.json` (Xeon @2.80GHz).
> Every number below is re-measured here, including the non-EH variants, so EH vs non-EH
> is never confounded with the host change. Do not compare these absolutes to `results.json`.

Ranges in <sub>small type</sub> are the spread implied by the best/worst repetition — a crude
error bar, deliberately pessimistic (it pairs the fastest baseline run with the slowest variant run).

## Verdict

**Q(a) — no.** Adding the fork's EH flags to computed-goto changes nothing: geomean
0.972 (node26) / 0.970 (node24) — if anything marginally *slower*, not the ~2× faster
the fork baseline is. **The exception/longjmp scheme is not the mechanism.** Per the review's
own branch condition, the next bisection step is `-O2 -g0` in CFLAGS proper, then link-level
(binaryen/wasm-opt) settings.

**Q(b) — yes, decisively.** Variant 4 against the strong baseline: **1.413** (node26,
worst-case 1.30) and **1.346** (node24, worst-case 1.21). Both clear the ~+10%
rule with the pessimistic bound to spare. Note this is moot until Q(a) is resolved — the strong
baseline here is *not* the fork baseline, because EH turned out not to be what makes the fork fast.

**Ask 3 — the startup claim was wrong and does not survive.** Details in the last section.

## Q(a) — does the EH scheme close the baseline gap?

Absolute steady-state medians, ms. Lower is faster.

**node26** (V8 14.6.202.34)

| benchmark | goto −O2 | goto −O2 **+EH** | EH speedup |
|---|--:|--:|--:|
| dispatch tight | 65.4 | 64.5 | 1.01 |
| nbody | 79.6 | 80.3 | 0.99 |
| fannkuch | 122.3 | 124.7 | 0.98 |
| spectralnorm | 54.3 | 56.9 | 0.95 |
| fib | 29.5 | 30.1 | 0.98 |
| binary trees | 26.8 | 27.2 | 0.99 |
| meth noargs | 25.7 | 30.1 | 0.85 |
| dict ops | 35.5 | 34.0 | 1.04 |
| str ops | 17.0 | 16.8 | 1.01 |
| json roundtrip | 72.0 | 75.4 | 0.95 |
| pystone | 26.8 | 28.6 | 0.94 |
| **geomean** | | | **0.972** <sub>0.90–1.05</sub> |

**node24** (V8 13.6.233.17)

| benchmark | goto −O2 | goto −O2 **+EH** | EH speedup |
|---|--:|--:|--:|
| dispatch tight | 62.8 | 59.6 | 1.05 |
| nbody | 72.3 | 74.2 | 0.97 |
| fannkuch | 115.5 | 117.9 | 0.98 |
| spectralnorm | 50.7 | 51.1 | 0.99 |
| fib | 25.3 | 30.3 | 0.84 |
| binary trees | 23.9 | 24.3 | 0.98 |
| meth noargs | 25.5 | 27.0 | 0.95 |
| dict ops | 34.7 | 33.8 | 1.03 |
| str ops | 17.6 | 17.5 | 1.01 |
| json roundtrip | 76.1 | 80.0 | 0.95 |
| pystone | 24.3 | 25.9 | 0.94 |
| **geomean** | | | **0.970** <sub>0.65–1.07</sub> |

## Q(b) — does variant 4 still clear the ship rule against the strong baseline?

Geomean speedup vs each baseline. Ship rule from the review: **~+10% (1.10) on both engines**.

| variant | vs `goto −O2` (weak) | vs `goto −O2 +EH` (strong) |
|---|--:|--:|
| *— node26 —* | | |
| tc0-O2 | **0.936** <sub>0.88–1.01</sub> | **0.963** <sub>0.89–1.06</sub> |
| tc0-O2-eh | **0.942** <sub>0.90–1.01</sub> | **0.969** <sub>0.91–1.06</sub> |
| tc4-O3 | **1.363** <sub>1.30–1.46</sub> | **1.403** <sub>1.31–1.54</sub> |
| tc4-O3-eh | **1.373** <sub>1.28–1.47</sub> | **1.413** <sub>1.30–1.55</sub> |
| tc6-O3 | **1.387** <sub>1.29–1.47</sub> | **1.427** <sub>1.31–1.55</sub> |
| tc6-O3-eh | **1.400** <sub>1.32–1.49</sub> | **1.440** <sub>1.34–1.57</sub> |
| *— node24 —* | | |
| tc0-O2 | **0.816** <sub>0.57–0.89</sub> | **0.842** <sub>0.77–0.94</sub> |
| tc0-O2-eh | **0.821** <sub>0.59–0.88</sub> | **0.847** <sub>0.80–0.94</sub> |
| tc4-O3 | **1.276** <sub>0.90–1.37</sub> | **1.315** <sub>1.22–1.46</sub> |
| tc4-O3-eh | **1.305** <sub>0.89–1.42</sub> | **1.346** <sub>1.21–1.50</sub> |
| tc6-O3 | **1.315** <sub>0.93–1.43</sub> | **1.356** <sub>1.27–1.52</sub> |
| tc6-O3-eh | **1.308** <sub>0.92–1.42</sub> | **1.349** <sub>1.25–1.51</sub> |

## EH effect, per dispatch variant

Speedup of the `+EH` build over its own non-EH twin. If EH only helps computed-goto,
the fork's baseline advantage is an EH artefact and the tail-call win is real but smaller.

| pair | node26 | node24 |
|---|--:|--:|
| goto-O2 → goto-O2-eh | **0.972** <sub>0.90–1.05</sub> | **0.970** <sub>0.65–1.07</sub> |
| tc0-O2 → tc0-O2-eh | **1.006** <sub>0.94–1.08</sub> | **1.006** <sub>0.96–1.07</sub> |
| tc4-O3 → tc4-O3-eh | **1.007** <sub>0.93–1.07</sub> | **1.023** <sub>0.94–1.09</sub> |
| tc6-O3 → tc6-O3-eh | **1.009** <sub>0.95–1.09</sub> | **0.995** <sub>0.94–1.05</sub> |

## Startup attribution counter-test

The first report attributed a −54 ms bare-startup delta to lazy compilation. Liftoff compiles
a 79 KB function in single-digit ms, so that attribution was ~10x too large — the review was
right to reject it.

The direct counter-test could **not** be run: `--no-wasm-lazy-compilation` deadlocks this
module's async startup (`unsettled top-level await` at `node_entry.mjs:51`), so every eager
cell came back empty. Instead the startup wall clock is decomposed in-process:

| phase | span |
|---|---|
| `glue` | parse `python.mjs` |
| `compile+inst` | wasm compile + instantiate (where lazy-vs-eager would show) |
| `rtInit` | emscripten runtime bring-up |
| `pyMain` | `Py_Initialize` + run `pass` |

Median of 7, ms:

| variant | glue | compile+inst | rtInit | pyMain | total |
|---|--:|--:|--:|--:|--:|
| goto-O2 | 13.9 | 101.2 | 7.1 | 99.6 | 223.3 |
| goto-O2-eh | 12.9 | 97.1 | 6.8 | 92.0 | 208.6 |
| tc0-O2 | 13.3 | 97.8 | 6.7 | 89.0 | 207.2 |
| tc4-O3 | 13.0 | 104.1 | 7.2 | 104.9 | 230.3 |
| tc6-O3 | 13.7 | 100.7 | 7.1 | 99.9 | 221.9 |

**The startup claim does not survive.** `compile+inst` is ~97–104 ms for every variant with
heavily overlapping per-run spreads (goto −O2 `[98.8 … 117.3]`, tc4 −O3 `[98.9 … 117.8]`) and
shows no ordering by dispatch shape — exactly what you would *not* see if lazily compiling a
79 KB megafunction were the cost. The in-process ranking also contradicts the subprocess
measurement (there tc4 −O3 looked ~26 ms *faster* than goto −O2; here it is ~7 ms slower), and
the subprocess samples carried 553/586 ms outliers.

So the original "bare startup improves 328 → 274 ms" reading was **process-spawn noise, not a
tail-call effect**. The right correction is that the effect is not real — not that some other
mechanism explains it.
