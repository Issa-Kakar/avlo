#!/usr/bin/env node
// Emit dist/stage/builtin-modules.json — the fork's true compiled-in
// sys.builtin_module_names, merged by `avlo-build stage` into the import-gate
// allowlist (the standing producer since P1; the retired make-baseline.mjs
// once doubled as it).
// Boots on the RAW stdlib zip so it runs straight off a fork build, before
// pack-stdlib — builtins live in the wasm, not the zip. (Folds into the fork
// Dockerfile at the docker replatform phase.)
//
//   node scripts/node/dump-builtins.mjs    (pnpm --filter @avlo/py-build py:builtins)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const indexDir = join(pkgRoot, 'dist/raw');
const outPath = join(pkgRoot, 'dist/stage/builtin-modules.json');

const { loadPyodide } = await import(pathToFileURL(join(indexDir, 'pyodide.mjs')).href);
const py = await loadPyodide({
  indexURL: indexDir,
  stdLibURL: pathToFileURL(join(indexDir, 'python_stdlib.zip')).href,
  packages: [],
  env: { PYTHONHASHSEED: '0', HOME: '/home/pyodide' },
});
const builtins = JSON.parse(py.runPython('import sys, json; json.dumps(sorted(sys.builtin_module_names))'));
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(builtins, null, 2)}\n`);
console.log(`builtin-modules.json: ${builtins.length} builtins`);
