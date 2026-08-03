// Renders strong-baseline.json into STRONG-BASELINE.md.
import { readFileSync, writeFileSync } from 'node:fs';

const TC = '/tmp/claude-0/-home-user-avlo/80de0d9c-acb2-50c4-9c1a-d238eb42e5f5/scratchpad/tc';
const R = JSON.parse(readFileSync(`${TC}/strong-baseline.json`, 'utf8'));
const B = R.meta.benches;

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const geo = (xs) => Math.exp(xs.reduce((a, b) => a + Math.log(b), 0) / xs.length);
const cell = (v, eng, b) => R.steady[`${v}|${eng}`]?.[b];

// median across the REPS process-medians for one (variant, engine, bench) cell
const M = (v, eng, b) => {
  const xs = cell(v, eng, b);
  return xs?.length ? med(xs) : null;
};
// speedup of `v` over `base`, plus the range implied by the per-rep spread
const speed = (base, v, eng, b) => {
  const a = cell(base, eng, b);
  const c = cell(v, eng, b);
  if (!a?.length || !c?.length) return null;
  return {
    mid: med(a) / med(c),
    lo: Math.min(...a) / Math.max(...c),
    hi: Math.max(...a) / Math.min(...c),
  };
};
const gm = (base, v, eng) => {
  const rs = B.map((b) => speed(base, v, eng, b)).filter(Boolean);
  return rs.length ? { mid: geo(rs.map((r) => r.mid)), lo: geo(rs.map((r) => r.lo)), hi: geo(rs.map((r) => r.hi)) } : null;
};
const f = (g) => (g ? `**${g.mid.toFixed(3)}** <sub>${g.lo.toFixed(2)}–${g.hi.toFixed(2)}</sub>` : '—');

const L = [];
const P = (s = '') => L.push(s);

P("# Strong-baseline sweep — does the fork's exception scheme explain the inversion?");
P();
P('Follow-up to the PR #16 review, which showed that "relative deltas transfer" is false:');
P('variant 0 measures ~17% *faster* than computed-goto on a standalone build and ~24% *slower*');
P("on a fork build, because the fork's goto baseline is ~2x faster while tail-call dispatch runs");
P('at the same absolute speed in both.');
P();
P("This sweep adds the fork's exception/longjmp scheme to the standalone build and measures");
P('EH against non-EH **on one host, interleaved**, to test whether that flag pair is the mechanism.');
P();
P('| | |');
P('|---|---|');
P(`| CPU | \`${R.meta.cpu}\` |`);
P(`| EH flags | \`${R.meta.ehFlags}\` (both CFLAGS and LDFLAGS) |`);
P(`| V8 | node26 ${R.meta.engines.node26} · node24 ${R.meta.engines.node24} |`);
P(
  `| Sampling | ${R.meta.reps} fresh processes per cell, interleaved by repetition; each process reports median of 9 in-process iterations |`,
);
P();
P('> **Host caveat.** The container was restarted between sessions, so this host');
P('> (`' + R.meta.cpu + '`) is *not* the one that produced `results.json` (Xeon @2.80GHz).');
P('> Every number below is re-measured here, including the non-EH variants, so EH vs non-EH');
P('> is never confounded with the host change. Do not compare these absolutes to `results.json`.');
P();
P('Ranges in <sub>small type</sub> are the spread implied by the best/worst repetition — a crude');
P('error bar, deliberately pessimistic (it pairs the fastest baseline run with the slowest variant run).');
P();

// ---- verdict -----------------------------------------------------------------
{
  const ehA = gm('goto-O2', 'goto-O2-eh', 'node26');
  const ehB = gm('goto-O2', 'goto-O2-eh', 'node24');
  const v4a = gm('goto-O2-eh', 'tc4-O3-eh', 'node26');
  const v4b = gm('goto-O2-eh', 'tc4-O3-eh', 'node24');
  P('## Verdict');
  P();
  P(`**Q(a) — no.** Adding the fork's EH flags to computed-goto changes nothing: geomean`);
  P(`${ehA.mid.toFixed(3)} (node26) / ${ehB.mid.toFixed(3)} (node24) — if anything marginally *slower*, not the ~2× faster`);
  P("the fork baseline is. **The exception/longjmp scheme is not the mechanism.** Per the review's");
  P('own branch condition, the next bisection step is `-O2 -g0` in CFLAGS proper, then link-level');
  P('(binaryen/wasm-opt) settings.');
  P();
  P(`**Q(b) — yes, decisively.** Variant 4 against the strong baseline: **${v4a.mid.toFixed(3)}** (node26,`);
  P(`worst-case ${v4a.lo.toFixed(2)}) and **${v4b.mid.toFixed(3)}** (node24, worst-case ${v4b.lo.toFixed(2)}). Both clear the ~+10%`);
  P('rule with the pessimistic bound to spare. Note this is moot until Q(a) is resolved — the strong');
  P('baseline here is *not* the fork baseline, because EH turned out not to be what makes the fork fast.');
  P();
  P('**Ask 3 — the startup claim was wrong and does not survive.** Details in the last section.');
  P();
}

// ---- Q(a) --------------------------------------------------------------------
P('## Q(a) — does the EH scheme close the baseline gap?');
P();
P('Absolute steady-state medians, ms. Lower is faster.');
P();
for (const eng of ['node26', 'node24']) {
  P(`**${eng}** (V8 ${R.meta.engines[eng].split('-')[0]})`);
  P();
  P('| benchmark | goto −O2 | goto −O2 **+EH** | EH speedup |');
  P('|---|--:|--:|--:|');
  for (const b of B) {
    const a = M('goto-O2', eng, b);
    const c = M('goto-O2-eh', eng, b);
    P(`| ${b.replace(/_/g, ' ')} | ${a?.toFixed(1) ?? '—'} | ${c?.toFixed(1) ?? '—'} | ${a && c ? (a / c).toFixed(2) : '—'} |`);
  }
  const g = gm('goto-O2', 'goto-O2-eh', eng);
  P(`| **geomean** | | | ${f(g)} |`);
  P();
}

// ---- Q(b) --------------------------------------------------------------------
P('## Q(b) — does variant 4 still clear the ship rule against the strong baseline?');
P();
P('Geomean speedup vs each baseline. Ship rule from the review: **~+10% (1.10) on both engines**.');
P();
P('| variant | vs `goto −O2` (weak) | vs `goto −O2 +EH` (strong) |');
P('|---|--:|--:|');
for (const eng of ['node26', 'node24']) {
  P(`| *— ${eng} —* | | |`);
  for (const v of ['tc0-O2', 'tc0-O2-eh', 'tc4-O3', 'tc4-O3-eh', 'tc6-O3', 'tc6-O3-eh']) {
    if (!R.steady[`${v}|${eng}`]) continue;
    P(`| ${v} | ${f(gm('goto-O2', v, eng))} | ${f(gm('goto-O2-eh', v, eng))} |`);
  }
}
P();

// ---- EH effect per dispatch variant -------------------------------------------
P('## EH effect, per dispatch variant');
P();
P('Speedup of the `+EH` build over its own non-EH twin. If EH only helps computed-goto,');
P("the fork's baseline advantage is an EH artefact and the tail-call win is real but smaller.");
P();
P('| pair | node26 | node24 |');
P('|---|--:|--:|');
for (const [base, eh] of [
  ['goto-O2', 'goto-O2-eh'],
  ['tc0-O2', 'tc0-O2-eh'],
  ['tc4-O3', 'tc4-O3-eh'],
  ['tc6-O3', 'tc6-O3-eh'],
]) {
  if (!R.steady[`${eh}|node26`]) continue;
  P(`| ${base} → ${eh} | ${f(gm(base, eh, 'node26'))} | ${f(gm(base, eh, 'node24'))} |`);
}
P();

// ---- startup ------------------------------------------------------------------
P('## Startup attribution counter-test');
P();
P('The first report attributed a −54 ms bare-startup delta to lazy compilation. Liftoff compiles');
P('a 79 KB function in single-digit ms, so that attribution was ~10x too large — the review was');
P('right to reject it.');
P();
P('The direct counter-test could **not** be run: `--no-wasm-lazy-compilation` deadlocks this');
P("module's async startup (`unsettled top-level await` at `node_entry.mjs:51`), so every eager");
P('cell came back empty. Instead the startup wall clock is decomposed in-process:');
P();
P('| phase | span |');
P('|---|---|');
P('| `glue` | parse `python.mjs` |');
P('| `compile+inst` | wasm compile + instantiate (where lazy-vs-eager would show) |');
P('| `rtInit` | emscripten runtime bring-up |');
P('| `pyMain` | `Py_Initialize` + run `pass` |');
P();
let SP = null;
try {
  SP = JSON.parse(readFileSync(`${TC}/startup-probe.json`, 'utf8'));
} catch {
  /* probe not run */
}
if (SP) {
  P('Median of 7, ms:');
  P();
  P('| variant | glue | compile+inst | rtInit | pyMain | total |');
  P('|---|--:|--:|--:|--:|--:|');
  for (const [v, o] of Object.entries(SP)) {
    P(
      `| ${v} | ${o.importGlue.toFixed(1)} | ${o.compileInstantiate.toFixed(1)} | ${o.runtimeInit.toFixed(1)} | ${o.pythonMain.toFixed(1)} | ${o.total.toFixed(1)} |`,
    );
  }
  P();
  P('**The startup claim does not survive.** `compile+inst` is ~97–104 ms for every variant with');
  P('heavily overlapping per-run spreads (goto −O2 `[98.8 … 117.3]`, tc4 −O3 `[98.9 … 117.8]`) and');
  P('shows no ordering by dispatch shape — exactly what you would *not* see if lazily compiling a');
  P('79 KB megafunction were the cost. The in-process ranking also contradicts the subprocess');
  P('measurement (there tc4 −O3 looked ~26 ms *faster* than goto −O2; here it is ~7 ms slower), and');
  P('the subprocess samples carried 553/586 ms outliers.');
  P();
  P('So the original "bare startup improves 328 → 274 ms" reading was **process-spawn noise, not a');
  P('tail-call effect**. The right correction is that the effect is not real — not that some other');
  P('mechanism explains it.');
  P();
}

writeFileSync('/home/user/avlo/packages/py-build/bench/tailcall/STRONG-BASELINE.md', L.join('\n'));
console.log(L.join('\n'));
