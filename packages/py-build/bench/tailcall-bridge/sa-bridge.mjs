// Standalone goto-O2 vs tc0-O2 (rebuilt locally, remote's exact recipe) on THIS
// host, both V8s, 3 interleaved fresh-process pairs — their run protocol
// (node_entry.mjs, PYTHONPATH=Lib, bench.py 9).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const HERE = '/tmp/claude-1000/-home-issak-dev-avlo/1fafb689-b850-4b87-81eb-c02996526689/scratchpad/tailcall';
const SRC = `${HERE}/Python-3.14.2`;
const ENGINES = { node24: process.execPath, node26: `${HERE}/node-v26.5.1-linux-x64/bin/node` };

const grab = (out) =>
  JSON.parse(
    out
      .split('\n')
      .find((l) => l.startsWith('BENCH_JSON:'))
      .slice('BENCH_JSON:'.length),
  );
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const remote = JSON.parse(readFileSync(`${HERE}/results.json`, 'utf8'));

for (const [eng, bin] of Object.entries(ENGINES)) {
  const runs = { goto: [], tc0: [] };
  for (let i = 0; i < 3; i++) {
    for (const [k, dir] of [
      ['goto', 'sa-goto'],
      ['tc0', 'sa-tc0'],
    ]) {
      const out = execFileSync(bin, ['node_entry.mjs', '--this-program=python', `${HERE}/bench-remote.py`, '9'], {
        encoding: 'utf8',
        maxBuffer: 1 << 26,
        timeout: 600000,
        cwd: `${HERE}/sa-builds/${dir}`,
        env: { ...process.env, PYTHONPATH: `${SRC}/Lib` },
      });
      runs[k].push(grab(out));
      process.stderr.write(`${eng} pair${i} ${k} done\n`);
    }
  }
  const rBase = remote.steady[`goto-O2|${eng}|default`];
  const rV0 = remote.steady[`tc0-O2|${eng}|default`];
  const names = Object.keys(runs.goto[0]);
  console.log(`\n== STANDALONE on THIS host, ${eng} (ratio tc0/goto; remote same-build same-engine ratio right) ==`);
  let g = 1,
    rg = 1;
  for (const b of names) {
    const m1 = med(runs.goto.map((r) => r[b].median));
    const m3 = med(runs.tc0.map((r) => r[b].median));
    const ratio = m3 / m1,
      rr = rV0[b].median / rBase[b].median;
    g *= ratio;
    rg *= rr;
    console.log(
      b.padEnd(18),
      m1.toFixed(1).padStart(8),
      m3.toFixed(1).padStart(8),
      ratio.toFixed(3).padStart(8),
      rr.toFixed(3).padStart(10),
    );
  }
  console.log(
    'geomean'.padEnd(18),
    ''.padStart(8),
    ''.padStart(8),
    (g ** (1 / names.length)).toFixed(3).padStart(8),
    (rg ** (1 / names.length)).toFixed(3).padStart(10),
  );
}
