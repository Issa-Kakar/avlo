#!/usr/bin/env node
// Size-budget gate (G1). Plain mode hard-fails any artifact/composite over
// its committed ceiling; refuses to "pass" while the artifacts table is
// empty. --update measures every artifact, stamps ceiling = measured +5%
// headroom into build.config.json (composite ceilings stay hand-set), and a
// human commits the diff.
//
//   node scripts/check-budgets.mjs [--update]
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(pkgRoot, 'build.config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const update = process.argv.includes('--update');

// artifact name (as budget key) -> repo path
const PATHS = {
  'pyodide.asm.mjs': 'dist/raw/pyodide.asm.mjs',
  'pyodide.asm.wasm': 'dist/raw/pyodide.asm.wasm',
  'pyodide.mjs': 'dist/raw/pyodide.mjs',
  'python_stdlib.zip': 'dist/stage/python_stdlib.zip',
};
for (const b of Object.keys(config.bundles).filter((k) => !k.startsWith('$'))) {
  PATHS[`bundles/${b}.tar`] = `dist/stage/bundles/${b}.tar`;
}

const sizes = {};
let missing = 0;
for (const [name, rel] of Object.entries(PATHS)) {
  const p = join(pkgRoot, rel);
  const br = `${p}.br`;
  if (!existsSync(p) || !existsSync(br)) {
    console.error(`missing ${name} (or its .br) — run the pack + compress steps first`);
    missing++;
    continue;
  }
  sizes[name] = { raw: statSync(p).size, br: statSync(br).size };
}
if (missing) process.exit(1);

if (update) {
  config.budgets.artifacts = Object.fromEntries(
    Object.entries(sizes).map(([name, s]) => [name, { raw: Math.ceil(s.raw * 1.05), br: Math.ceil(s.br * 1.05) }]),
  );
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`stamped ${Object.keys(sizes).length} artifact ceilings (+5%) into build.config.json`);
}

const artifacts = config.budgets.artifacts ?? {};
if (Object.keys(artifacts).length === 0) {
  console.error('budgets.artifacts is empty — run with --update once and commit the numbers');
  process.exit(1);
}

let bad = 0;
const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;
for (const [name, s] of Object.entries(sizes)) {
  const cap = artifacts[name];
  if (!cap) {
    console.error(`OVER ${name}: no committed ceiling — rerun --update deliberately`);
    bad++;
    continue;
  }
  const rawOk = s.raw <= cap.raw;
  const brOk = s.br <= cap.br;
  if (!rawOk || !brOk) {
    console.error(`OVER ${name}: raw ${mb(s.raw)}/${mb(cap.raw)} br ${mb(s.br)}/${mb(cap.br)}`);
    bad++;
  } else {
    console.log(`ok   ${name}: raw ${mb(s.raw)} br ${mb(s.br)}`);
  }
}

for (const [name, comp] of Object.entries(config.budgets.composites)) {
  if (name.startsWith('$')) continue;
  const total = comp.files.reduce((n, f) => {
    if (!sizes[f]) throw new Error(`composite ${name}: unknown artifact ${f}`);
    return n + sizes[f].br;
  }, 0);
  if (total > comp.br) {
    console.error(`OVER composite ${name}: ${mb(total)} br > ceiling ${mb(comp.br)}`);
    bad++;
  } else {
    console.log(`ok   composite ${name}: ${mb(total)} br (ceiling ${mb(comp.br)})`);
  }
}

console.log(bad ? `G1 FAIL: ${bad} over budget` : 'G1 OK: all budgets green');
process.exit(bad ? 1 : 0);
