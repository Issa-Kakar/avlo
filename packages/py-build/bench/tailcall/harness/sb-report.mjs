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
P('a 79 KB function in single-digit ms, so that attribution was ~10x too large. If the gap survives');
P('`--no-wasm-lazy-compilation`, lazy compile is not the cause.');
P();
P('| variant | lazy (default) | eager `--no-wasm-lazy-compilation` | Δ eager−lazy |');
P('|---|--:|--:|--:|');
for (const v of R.meta.variants) {
  const l = R.startup[`${v}|lazy`]?.median;
  const e = R.startup[`${v}|eager`]?.median;
  P(`| ${v} | ${l ?? '—'} | ${e ?? '—'} | ${l && e ? (e - l >= 0 ? '+' : '') + (e - l) : '—'} |`);
}
P();

writeFileSync('/home/user/avlo/packages/py-build/bench/tailcall/STRONG-BASELINE.md', L.join('\n'));
console.log(L.join('\n'));
