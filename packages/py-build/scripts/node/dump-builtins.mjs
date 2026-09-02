#!/usr/bin/env node
// Emit builtin-modules.json — the fork's true compiled-in
// sys.builtin_module_names, merged by `avlo-build stage` into the import-gate
// allowlist. Runs INSIDE the fork build (docker/fork.Dockerfile, build stage)
// against the freshly built dist/, so dist/raw ships it alongside the wasm —
// builtins live in the wasm, not in any zip, and the stock stdlib zip is all
// the boot needs.
//
//   node dump-builtins.mjs <distDir> <outFile>
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [distDir, outPath] = process.argv.slice(2).map((p) => resolve(p));
if (!distDir || !outPath) {
  console.error('usage: dump-builtins.mjs <distDir> <outFile>');
  process.exit(2);
}

const { loadPyodide } = await import(pathToFileURL(join(distDir, 'pyodide.mjs')).href);
const py = await loadPyodide({
  indexURL: distDir,
  stdLibURL: pathToFileURL(join(distDir, 'python_stdlib.zip')).href,
  packages: [],
  env: { PYTHONHASHSEED: '0', HOME: '/home/pyodide' },
});
const builtins = JSON.parse(py.runPython('import sys, json; json.dumps(sorted(sys.builtin_module_names))'));
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(builtins, null, 2)}\n`);
console.log(`builtin-modules.json: ${builtins.length} builtins`);
