// Interleaved A/B: remote agent's bench.py suite on the two saved FORK builds.
// 3 pairs, alternating, fresh process each. Reports per-benchmark median-of-medians
// ratio (v3/v1, >1 = tail-call slower) next to the remote's standalone node24 cell.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const HERE = '/tmp/claude-1000/-home-issak-dev-avlo/1fafb689-b850-4b87-81eb-c02996526689/scratchpad/tailcall';
const B = '/home/issak/dev/avlo/packages/py-build/bench/builds';
const BENCH_PY = `${HERE}/bench-remote.py`;

const grab = (out, tag) =>
  JSON.parse(
    out
      .split('\n')
      .find((l) => l.startsWith(tag))
      .slice(tag.length),
  );

const runs = { v1: [], v3: [] };
const boots = { v1: [], v3: [] };
for (let i = 0; i < 3; i++) {
  for (const [k, dir] of [
    ['v1', 'v1-ship'],
    ['v3', 'v3-tailcall'],
  ]) {
    const out = execFileSync(process.execPath, [`${HERE}/child.mjs`, `${B}/${dir}`, BENCH_PY, '9'], {
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      timeout: 300000,
    });
    boots[k].push(
      Number(
        out
          .split('\n')
          .find((l) => l.startsWith('BOOT_MS:'))
          .slice(8),
      ),
    );
    runs[k].push(grab(out, 'BENCH_JSON:'));
    process.stderr.write(`pair${i} ${k} done\n`);
  }
}

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const ENG = process.argv[2] ?? 'node24';
const remote = JSON.parse(readFileSync(`${HERE}/results.json`, 'utf8'));
const rBase = remote.steady[`goto-O2|${ENG}|default`];
const rV0 = remote.steady[`tc0-O2|${ENG}|default`];

const names = Object.keys(runs.v1[0]);
console.log('benchmark          fork-v1ms  fork-v3ms  FORKratio   REMOTEratio(13.6)');
let g = 1,
  rg = 1;
for (const b of names) {
  const m1 = med(runs.v1.map((r) => r[b].median));
  const m3 = med(runs.v3.map((r) => r[b].median));
  const ratio = m3 / m1;
  const rr = rV0[b].median / rBase[b].median;
  g *= ratio;
  rg *= rr;
  console.log(b.padEnd(18), m1.toFixed(1).padStart(8), m3.toFixed(1).padStart(9), ratio.toFixed(3).padStart(9), rr.toFixed(3).padStart(12));
}
console.log(
  'geomean'.padEnd(18),
  ''.padStart(8),
  ''.padStart(9),
  (g ** (1 / names.length)).toFixed(3).padStart(9),
  (rg ** (1 / names.length)).toFixed(3).padStart(12),
);
console.log('boots v1:', boots.v1.join(','), ' v3:', boots.v3.join(','));
console.log('per-run medians v1:', JSON.stringify(Object.fromEntries(names.map((b) => [b, runs.v1.map((r) => +r[b].median.toFixed(1))]))));
console.log('per-run medians v3:', JSON.stringify(Object.fromEntries(names.map((b) => [b, runs.v3.map((r) => +r[b].median.toFixed(1))]))));
