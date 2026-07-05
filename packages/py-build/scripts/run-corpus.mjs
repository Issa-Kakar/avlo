#!/usr/bin/env node
// Corpus runner: boot the fork (pruned stdlib if staged) in Node and execute
// every corpus sample. Samples are self-asserting; any exception fails.
//
//   node scripts/run-corpus.mjs [--index dist/raw] [--stdlib dist/stage/python_stdlib.zip]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const indexDir = resolve(pkgRoot, opt('--index', 'dist/raw'));
const stdlibZip = resolve(pkgRoot, opt('--stdlib', 'dist/stage/python_stdlib.zip'));

const { loadPyodide } = await import(pathToFileURL(join(indexDir, 'pyodide.mjs')).href);
const py = await loadPyodide({
  indexURL: indexDir,
  ...(existsSync(stdlibZip) ? { stdLibURL: pathToFileURL(stdlibZip).href } : {}),
  packages: [],
  env: { PYTHONHASHSEED: '0', HOME: '/home/pyodide' },
});

const corpusDir = join(pkgRoot, 'corpus');
const samples = [];
for (const group of readdirSync(corpusDir)) {
  const dir = join(corpusDir, group);
  for (const f of readdirSync(dir)
    .filter((f) => f.endsWith('.py'))
    .sort()) {
    samples.push({ name: `${group}/${f}`, source: readFileSync(join(dir, f), 'utf8') });
  }
}

let failed = 0;
for (const s of samples) {
  try {
    // Fresh namespace per sample, mirroring the run harness contract.
    py.runPython(
      `import builtins\n_g = {'__name__': '__main__', '__builtins__': builtins}\nexec(compile(${JSON.stringify(s.source)}, ${JSON.stringify(s.name)}, 'exec'), _g)`,
    );
    console.log(`PASS ${s.name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${s.name}\n${String(err?.message ?? err).slice(0, 2000)}`);
  }
}
console.log(`corpus: ${samples.length - failed}/${samples.length} pass`);
process.exit(failed ? 1 : 0);
