// Strong-baseline sweep (PR #16 review, ask 1).
//
// The first sweep built stock CPython-for-emscripten, which uses JS-based
// exception/longjmp support. The AVLO fork compiles with native wasm EH
// (`-fwasm-exceptions -sSUPPORT_LONGJMP=wasm`). Local cross-verification showed the
// fork's computed-goto baseline is ~2x faster than the stock one, which would mean
// the v3-v6 headline was measured against headroom the fork already banked.
//
// This sweep measures EH and non-EH builds of the same dispatch variants on ONE host,
// interleaved, with repeats, so the comparison carries error bars and no cross-host
// or cross-session drift.
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TC = '/tmp/claude-0/-home-user-avlo/80de0d9c-acb2-50c4-9c1a-d238eb42e5f5/scratchpad/tc';
const SRC = `${TC}/src/Python-3.14.2`;
const BUILDS = `${TC}/builds`;

const ENGINES = { node26: `${TC}/tools/node26/bin/node`, node24: `${TC}/tools/node24/bin/node` };

// Pairs: each dispatch variant with and without the fork's EH scheme.
const VARIANTS = ['goto-O2', 'goto-O2-eh', 'tc0-O2', 'tc0-O2-eh', 'tc4-O3', 'tc4-O3-eh', 'tc6-O3', 'tc6-O3-eh'];
const present = VARIANTS.filter((v) => existsSync(join(BUILDS, v, 'python.wasm')));

const REPS = 3; // fresh processes per cell
const BENCHES = [
  'dispatch_tight',
  'nbody',
  'fannkuch',
  'spectralnorm',
  'fib',
  'binary_trees',
  'meth_noargs',
  'dict_ops',
  'str_ops',
  'json_roundtrip',
  'pystone',
];

const run = (bin, args, opts = {}) =>
  execFileSync(bin, args, {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    timeout: opts.timeout ?? 900000,
    env: { ...process.env, PYTHONPATH: `${SRC}/Lib` },
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const grab = (out, tag) => {
  const line = out.split('\n').find((l) => l.startsWith(tag));
  if (!line) throw new Error(`no ${tag}`);
  return JSON.parse(line.slice(tag.length));
};
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const R = { meta: {}, steady: {}, startup: {} };
R.meta = {
  purpose: 'strong-baseline: fork EH scheme vs stock, one host, interleaved, 3 fresh processes/cell',
  ehFlags: '-fwasm-exceptions -sSUPPORT_LONGJMP=wasm',
  cpu: run('bash', ['-c', "lscpu | grep 'Model name' | sed 's/.*: *//'"]).trim(),
  engines: Object.fromEntries(Object.entries(ENGINES).map(([k, b]) => [k, run(b, ['-p', 'process.versions.v8']).trim()])),
  variants: present,
  benches: BENCHES,
  reps: REPS,
};
console.error(`cpu: ${R.meta.cpu}`);
console.error(`variants: ${present.join(' ')}`);

// ---- steady state, interleaved by repetition --------------------------------
// Outer loop is the repetition so every variant is sampled once per pass; thermal
// or scheduler drift then hits all variants alike instead of penalising whichever
// happened to run last.
for (let rep = 0; rep < REPS; rep++) {
  for (const [eng, bin] of Object.entries(ENGINES)) {
    for (const v of present) {
      const key = `${v}|${eng}`;
      R.steady[key] ??= {};
      try {
        const r = grab(
          run(bin, ['node_entry.mjs', '--this-program=python', `${TC}/bench.py`, '9'], { cwd: join(BUILDS, v) }),
          'BENCH_JSON:',
        );
        for (const b of BENCHES) (R.steady[key][b] ??= []).push(r[b].median);
      } catch {
        console.error(`  FAIL ${key} rep${rep}`);
      }
    }
  }
  console.error(`rep ${rep + 1}/${REPS} done`);
}

// ---- startup attribution counter-test (ask 3) --------------------------------
// The -54 ms bare-startup delta was attributed to lazy compilation, but Liftoff
// compiles the 79 KB megafunction in single-digit ms, so that attribution is ~10x
// too large. If the gap survives --no-wasm-lazy-compilation, lazy compile is not it.
for (const [tier, flags] of Object.entries({ lazy: [], eager: ['--no-wasm-lazy-compilation'] })) {
  for (const v of present) {
    const s = [];
    for (let i = 0; i < 7; i++) {
      const t0 = Date.now();
      try {
        run(ENGINES.node26, [...flags, 'node_entry.mjs', '--this-program=python', '-c', 'pass'], { cwd: join(BUILDS, v) });
        s.push(Date.now() - t0);
      } catch {
        /* ignore */
      }
    }
    if (s.length) R.startup[`${v}|${tier}`] = { median: med(s), min: Math.min(...s), all: s };
  }
  console.error(`startup ${tier} done`);
}

writeFileSync(`${TC}/strong-baseline.json`, JSON.stringify(R, null, 2));
console.error('wrote strong-baseline.json');
