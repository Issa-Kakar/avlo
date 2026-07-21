#!/usr/bin/env node
// Host-side gate over the freshly linked grouped side modules
// (dist/groups/<bundle>.so), runnable BEFORE any packaging touches them:
//
//   node scripts/verify-groups.mjs               # verify every census bundle
//   node scripts/verify-groups.mjs --spike mpl-deps --pkgs kiwisolver
//                                                # verify dist/groups/spike-<b>.so
//                                                # against only the built pkgs'
//                                                # extensions + structural compare
//                                                # vs the upstream wheel .so(s)
//
// Per group .so: dylink.0 present + needed == [] (nothing vendored), PyInit
// export set == the census union for the bundle (exact equality — a missing
// PyInit means a dropped extension, an extra one means a stray input), and
// closed-world vs the CURRENT main module: every census-relevant import
// (env/GOT.mem/GOT.func, invoke_*/plumbing excluded) resolves from
// mainExports ∪ own exports ∪ the js-glue allowlist ({exit} today). The
// grouped imports ⊆ old per-extension union, so this holds against the
// EXISTING main before link.rsp regenerates — the de-risking property the
// packaging swap leans on.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { censusImports, parseWasm } from './lib/wasm-parse.mjs';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const groupsDir = join(pkgRoot, 'dist/groups');
const groups = JSON.parse(readFileSync(join(pkgRoot, 'config/dso-groups/groups.json'), 'utf8'));
const config = JSON.parse(readFileSync(join(pkgRoot, 'build.config.json'), 'utf8'));
const mainWasmPath = [join(pkgRoot, '../../web/public/py-dev/fork/pyodide.asm.wasm'), join(pkgRoot, 'dist/raw/pyodide.asm.wasm')].find(
  existsSync,
);
if (!mainWasmPath) throw new Error('no pyodide.asm.wasm found (staged public or dist/raw)');
const mainExports = new Set(parseWasm(readFileSync(mainWasmPath), false).exports);
const JS_GLUE_ALLOW = new Set(['exit']);

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const spikeBundle = opt('--spike');
const spikePkgs = opt('--pkgs') ? new Set(opt('--pkgs').split(',')) : null;

// Minimal zip central-directory reader for wheels (fetch-wheels' walk).
function* zipEntries(buf) {
  let eocd = buf.length - 22;
  while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let off = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    yield {
      name,
      read() {
        const lhNameLen = buf.readUInt16LE(lho + 26);
        const lhExtraLen = buf.readUInt16LE(lho + 28);
        const dataOff = lho + 30 + lhNameLen + lhExtraLen;
        const raw = buf.subarray(dataOff, dataOff + csize);
        return method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
      },
    };
    off += 46 + nameLen + extraLen + cmtLen;
  }
}

const failures = [];
const verifyOne = (bundle, exts, soPath) => {
  if (!existsSync(soPath)) {
    failures.push(`${bundle}: ${soPath} missing — run the recipes loop`);
    return null;
  }
  const w = parseWasm(readFileSync(soPath));
  const name = soPath.split('/').pop();
  if (!w.dylink) failures.push(`${name}: no dylink.0 section`);
  else if (w.dylink.needed.length) failures.push(`${name}: NEEDED not empty: ${w.dylink.needed.join(', ')}`);
  const wantPyinits = new Set(exts.map((e) => e.pyinit));
  const gotPyinits = new Set(w.exports.filter((x) => x.startsWith('PyInit')));
  for (const p of wantPyinits) if (!gotPyinits.has(p)) failures.push(`${name}: census PyInit missing from exports: ${p}`);
  for (const p of gotPyinits) if (!wantPyinits.has(p)) failures.push(`${name}: stray PyInit export not in census: ${p}`);
  const exportSet = new Set(w.exports);
  const unresolved = new Set();
  for (const { field } of censusImports(w)) {
    if (!mainExports.has(field) && !exportSet.has(field) && !JS_GLUE_ALLOW.has(field)) unresolved.add(field);
  }
  if (unresolved.size)
    failures.push(
      `${name}: ${unresolved.size} imports outside main ∪ self ∪ glue: ${[...unresolved].slice(0, 8).join(', ')}${unresolved.size > 8 ? ' …' : ''}`,
    );
  const imp = censusImports(w);
  console.log(
    `${name}: ${readFileSync(soPath).length.toLocaleString()} B · ${w.exports.length} exports (${gotPyinits.size} PyInit) · ` +
      `${imp.length} census imports · dylink mem ${w.dylink?.memSize ?? '??'} tbl ${w.dylink?.tableSize ?? '??'} · needed [${w.dylink?.needed ?? '?'}]`,
  );
  return w;
};

if (spikeBundle) {
  const g = groups.bundles[spikeBundle];
  if (!g) throw new Error(`unknown bundle ${spikeBundle}`);
  const exts = g.extensions.filter((e) => !spikePkgs || spikePkgs.has(e.pkg));
  const w = verifyOne(spikeBundle, exts, join(groupsDir, `spike-${spikeBundle}.so`));
  if (w) {
    // Structural compare vs the upstream wheel .so(s) — census-level, NOT
    // byte-equality (container paths leak into debug strings by design).
    for (const e of exts) {
      const pin = config.recipes.wheels[e.pkg];
      const wheel = join(pkgRoot, '.cache/wheels', pin.file);
      if (!existsSync(wheel)) {
        console.log(`(no ${pin.file} in .cache/wheels — skipping upstream compare for ${e.dottedName})`);
        continue;
      }
      let up = null;
      for (const entry of zipEntries(readFileSync(wheel))) {
        if (entry.name === e.wheelSoPath) up = parseWasm(entry.read());
      }
      if (!up) throw new Error(`${e.wheelSoPath} not in ${pin.file}`);
      const upImports = new Set(censusImports(up).map((i) => i.field));
      const groupExports = new Set(w.exports);
      const escaped = [...new Set(censusImports(w).map((i) => i.field))].filter((f) => !upImports.has(f) && !groupExports.has(f));
      console.log(
        `vs upstream ${e.dottedName}: upstream ${up.exports.length} exports / ${censusImports(up).length} census imports · ` +
          `dylink mem ${up.dylink?.memSize} tbl ${up.dylink?.tableSize} · group-not-in-upstream imports: ${escaped.length ? escaped.join(', ') : '(none)'}`,
      );
      if (escaped.length) failures.push(`spike ${e.dottedName}: group imports ${escaped.length} symbols upstream never imported`);
    }
  }
} else {
  for (const [bundle, g] of Object.entries(groups.bundles)) {
    verifyOne(bundle, g.extensions, join(groupsDir, `${bundle}.so`));
  }
}

if (failures.length) {
  console.error(`\nverify-groups FAILURES (${failures.length}):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('\nverify-groups OK');
