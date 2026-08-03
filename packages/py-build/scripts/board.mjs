#!/usr/bin/env node
// One-command gate board — the full restage sequence that used to be 14
// manual steps (CLAUDE.md "Gate board"). Serial by design (each gate's inner
// parallelism does the speedup); early-exits on the first failure with a
// timing summary of everything that ran.
//
//   pnpm board                    full board (repro doubles included)
//   pnpm board --fast             skip the byte-identity doubles (iteration)
//   pnpm board --from stage       resume from a step
//   pnpm board --until harness    stop after a step
//   pnpm board --skip corpus,seed comma-separated skips
//   pnpm board --update-budgets   pass --update to the budgets gate
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(pkgRoot, '../..');
const args = process.argv.slice(2);
const FAST = args.includes('--fast');
const UPDATE_BUDGETS = args.includes('--update-budgets');
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const from = opt('--from');
const until = opt('--until');
const skips = new Set((opt('--skip') ?? '').split(',').filter(Boolean));

const sh = (cmd, cwd = pkgRoot) => {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`exit ${r.status}`);
};
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const stdlibZip = join(pkgRoot, 'dist/stage/python_stdlib.zip');
const packStdlibTwice = () => {
  // pack-stdlib.py takes no --repro: the byte-identity gate is two runs + compare.
  sh(['python3.14', 'scripts/pack-stdlib.py']);
  if (FAST) return;
  const first = sha(stdlibZip);
  sh(['python3.14', 'scripts/pack-stdlib.py']);
  if (sha(stdlibZip) !== first) throw new Error('pack:stdlib byte-identity FAIL — zip differs across identical runs');
  console.log('pack:stdlib repro OK (byte-identical)');
};

const STEPS = [
  ['stdlib', packStdlibTwice],
  ['bundles', () => sh(['python3.14', 'scripts/pack-package.py', '--all', ...(FAST ? [] : ['--repro'])])],
  ['builtins', () => sh(['node', 'scripts/dump-builtins.mjs'])],
  ['trace:check', () => sh(['node', 'scripts/trace-imports.mjs', '--check'])],
  ['corpus', () => sh(['node', 'scripts/run-corpus.mjs'])],
  ['dsos:check', () => sh(['node', 'scripts/analyze-dsos.mjs', '--check'])],
  [
    'groups:verify',
    () => {
      sh(['node', 'scripts/verify-groups.mjs']);
      sh(['python3', 'scripts/verify-pytree.py']);
    },
  ],
  ['compress', () => sh(['node', 'scripts/compress.mjs'])],
  ['budgets', () => sh(['node', 'scripts/check-budgets.mjs', ...(UPDATE_BUDGETS ? ['--update'] : [])])],
  ['stage', () => sh(['node', 'scripts/stage.mjs'])],
  ['stage:check', () => sh(['node', 'scripts/stage.mjs', '--check'])],
  ['harness', () => sh(['node', 'scripts/run-harness.mjs'])],
  ['typecheck', () => sh(['pnpm', 'typecheck'], repo)],
  ['test:py', () => sh(['pnpm', 'test:py'], repo)],
  ['test', () => sh(['pnpm', 'test'], repo)],
  ['seed', () => sh(['node', 'scripts/publish.mjs', '--local'])],
];

const names = STEPS.map(([n]) => n);
if (from && !names.includes(from)) throw new Error(`--from ${from}: unknown step (${names.join(', ')})`);
if (until && !names.includes(until)) throw new Error(`--until ${until}: unknown step (${names.join(', ')})`);

const timings = [];
let started = !from;
let failed = null;
for (const [name, run] of STEPS) {
  if (!started && name === from) started = true;
  if (!started || skips.has(name)) {
    timings.push([name, 'skip']);
    if (name === until) break;
    continue;
  }
  console.log(`\n━━━ board: ${name} ━━━`);
  const t0 = performance.now();
  try {
    run();
    timings.push([name, `${((performance.now() - t0) / 1000).toFixed(1)}s`]);
  } catch (e) {
    timings.push([name, `FAIL (${((performance.now() - t0) / 1000).toFixed(1)}s)`]);
    failed = name;
    break;
  }
  if (name === until) break;
}

console.log('\n━━━ board summary ━━━');
for (const [name, t] of timings) console.log(`  ${name.padEnd(14)} ${t}`);
if (failed) {
  console.error(`\nboard: FAILED at ${failed}`);
  process.exit(1);
}
console.log('\nboard: green');
