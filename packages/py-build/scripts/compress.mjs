#!/usr/bin/env node
// Pre-compress every servable artifact to a .br sibling (brotli q11 — the
// bytes R2 will store; the py worker negotiates via Accept-Encoding).
// Skips up-to-date siblings (mtime + size match marker) unless --force.
// Artifacts compress concurrently on the libuv threadpool (async brotli);
// UV_THREADPOOL_SIZE bounds the real parallelism.
//
//   node scripts/compress.mjs [--force]
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, constants } from 'node:zlib';

const brotli = promisify(brotliCompress);
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');

function artifactPaths() {
  const list = ['dist/raw/pyodide.asm.mjs', 'dist/raw/pyodide.asm.wasm', 'dist/raw/pyodide.mjs', 'dist/stage/python_stdlib.zip'];
  const bundles = join(pkgRoot, 'dist/stage/bundles');
  if (existsSync(bundles)) {
    for (const f of readdirSync(bundles).sort()) {
      if (f.endsWith('.tar')) list.push(`dist/stage/bundles/${f}`);
    }
  }
  return list;
}

async function compressOne(rel) {
  const p = join(pkgRoot, rel);
  if (!existsSync(p)) {
    console.error(`missing artifact: ${rel} (build it first)`);
    process.exitCode = 1;
    return;
  }
  const br = `${p}.br`;
  if (!force && existsSync(br) && statSync(br).mtimeMs >= statSync(p).mtimeMs) {
    console.log(`up-to-date ${rel}.br`);
    return;
  }
  const raw = readFileSync(p);
  const t0 = performance.now();
  const out = await brotli(raw, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });
  writeFileSync(br, out);
  console.log(
    `${rel}: ${(raw.length / 1e6).toFixed(2)} MB -> ${(out.length / 1e6).toFixed(2)} MB br (${((out.length / raw.length) * 100).toFixed(0)}%, ${((performance.now() - t0) / 1000).toFixed(1)}s)`,
  );
}

await Promise.all(artifactPaths().map(compressOne));
