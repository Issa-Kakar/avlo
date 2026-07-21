#!/usr/bin/env node
// DSO census + grouping audit over the STAGED bundle tars (the shipped truth)
// and the staged main-module wasm. Born as the evidence engine behind
// dso-grouping-analysis.md (67->4 side-module grouping); kept as a standing
// audit to re-run on any restage / wheel bump.
//
//   node scripts/analyze-dsos.mjs           # full report + .cache/dso-report.json
//   node scripts/analyze-dsos.mjs --check   # gate mode, fails loudly on:
//                                           #  (a) PyInit shortname collision
//                                           #      inside a bundle — the one hard
//                                           #      constraint of the grouped-DSO
//                                           #      finder design (PyInit_<last
//                                           #      dotted component> must be
//                                           #      unique per group .so)
//                                           #  (b) a DSO with no PyInit_* export
//                                           #      (a support lib entering the
//                                           #      closure — changes the grouping
//                                           #      story, must be deliberate)
//   node scripts/analyze-dsos.mjs --mint-groups
//                                           # write config/dso-groups/groups.json
//                                           # from the census: per bundle the
//                                           # ordered {pkg, dottedName, pyinit,
//                                           # wheelSoPath} extension list + the
//                                           # DSO-bearing member wheels' sha256
//                                           # pins (the pack-time stale-group
//                                           # gate keys on these). Mint runs
//                                           # against PRE-grouping tars (per-
//                                           # extension .so files) — after a
//                                           # wheel re-pin, regroup via the
//                                           # recipes loop and re-mint from a
//                                           # pre-group restage.
//
// Per DSO: imports (env/GOT.mem/GOT.func; invoke_* trampolines + dylink
// plumbing excluded, matching fetch-wheels' link-sos scan), exports, dylink.0
// (mem/table sizes, NEEDED, weak flags — shipped 314 DSOs carry MEM_INFO only),
// toolchain fingerprint from embedded strings. Derived: import-provider table
// (self counts FIRST — ODR/PIC modules export-and-reimport their own symbols;
// classifying self last invents phantom cross-DSO deps), per-bundle group-link
// simulation (internalized vs residual imports), duplicate-export audit
// (__wasm_call_ctors/__wasm_apply_data_relocs are linker-synthesized per
// module, not collisions).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { censusImports, parseWasm } from './lib/wasm-parse.mjs';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundlesDir = join(pkgRoot, 'dist/stage/bundles');
const mainWasmPath = [join(pkgRoot, '../../web/public/py-dev/fork/pyodide.asm.wasm'), join(pkgRoot, 'dist/raw/pyodide.asm.wasm')].find(
  existsSync,
);
const outPath = join(pkgRoot, '.cache/dso-report.json');
const groupsPath = join(pkgRoot, 'config/dso-groups/groups.json');
const checkMode = process.argv.includes('--check');
const mintMode = process.argv.includes('--mint-groups');

if (!existsSync(bundlesDir)) throw new Error(`no staged bundles at ${bundlesDir} — run bundles + stage first`);
if (!mainWasmPath) throw new Error('no pyodide.asm.wasm found (staged public or dist/raw)');

// ---------- tar walk (pack-package ustar: plain headers, prefix field) ----------
function* tarEntries(buf) {
  let off = 0;
  while (off + 512 <= buf.length) {
    const block = buf.subarray(off, off + 512);
    if (block.every((b) => b === 0)) break;
    const prefix = cstr(block, 345, 155);
    const name = (prefix ? `${prefix}/` : '') + cstr(block, 0, 100);
    const size = parseInt(cstr(block, 124, 12).trim() || '0', 8);
    yield { name, size, typeflag: String.fromCharCode(block[156]), data: buf.subarray(off + 512, off + 512 + size) };
    off += 512 + Math.ceil(size / 512) * 512;
  }
}
function cstr(b, o, n) {
  let end = o;
  while (end < o + n && b[end] !== 0) end++;
  return b.toString('utf8', o, end);
}

// ---------- collect (wasm parse shared with verify-groups: lib/wasm-parse.mjs) ----------
const SYNTHETIC = new Set(['__wasm_call_ctors', '__wasm_apply_data_relocs']);
const dsos = [];
const metas = new Map(); // bundle -> parsed meta.json (loadOrder shape checks)
for (const tarName of readdirSync(bundlesDir)
  .filter((f) => f.endsWith('.tar'))
  .sort()) {
  const bundle = basename(tarName, '.tar');
  const buf = readFileSync(join(bundlesDir, tarName));
  for (const e of tarEntries(buf)) {
    if (e.name === 'meta.json' && e.typeflag === '0') {
      metas.set(bundle, JSON.parse(Buffer.from(e.data).toString('utf8')));
      continue;
    }
    if (!e.name.endsWith('.so') || e.typeflag !== '0') continue;
    const bytes = Buffer.from(e.data);
    const w = parseWasm(bytes);
    dsos.push({
      bundle,
      path: e.name,
      soName: e.name.split('/').pop(),
      size: e.size,
      toolchain:
        bytes.includes('__pyx_capi__') || bytes.includes('__Pyx_') ? 'cython' : bytes.includes('pybind11') ? 'pybind11/c++' : 'c/c++',
      hasDylink: !!w.dylink,
      memSize: w.dylink?.memSize ?? 0,
      tableSize: w.dylink?.tableSize ?? 0,
      needed: w.dylink?.needed ?? [],
      weakExports: Object.entries(w.dylink?.exportInfo ?? {})
        .filter(([, f]) => f & 1)
        .map(([n]) => n),
      exports: w.exports,
      exportSet: new Set(w.exports),
      imports: censusImports(w),
    });
  }
}
const mainExports = new Set(parseWasm(readFileSync(mainWasmPath), false).exports);

// ---------- derived ----------
const defs = new Map(); // export name -> dso indices
dsos.forEach((d, i) => {
  for (const n of d.exportSet) (defs.get(n) ?? defs.set(n, []).get(n)).push(i);
});
for (const d of dsos) d.pyinit = d.exports.filter((x) => x.startsWith('PyInit'));

// import-provider classification, SELF FIRST. The self class splits by
// import kind: a self ENV-FUNC import is the permanent-lazy-stub class under
// RTLD_LOCAL (libdylink.js 784-796 — RTLD_LOCAL exports never merge into
// wasmImports, so instantiate binds a closure that resolves at first call
// and stays a wasm→JS→wasm hop forever), while self GOT imports resolve via
// updateGOT(own exports) before reportUndefinedSymbols and cost nothing at
// call time. The stub audit measures the former per DSO: env-func imports
// ∉ mainExports, split self-provided (real stubs) vs glue-bound (satisfied
// by the JS library in wasmImports at instantiate — e.g. `exit`).
const providers = { self: 0, main: 0, 'sibling-same-bundle': 0, 'other-bundle': 0, 'js-glue': 0 };
const selfByKind = { env: 0, 'GOT.mem': 0, 'GOT.func': 0 };
const jsGlue = new Set();
dsos.forEach((d, i) => {
  d.stubSelf = 0; // env-func, self-exported: permanent JS stub trampoline today
  d.stubGlue = 0; // env-func, glue-provided: binds directly at instantiate
  for (const { mod, field, kind } of d.imports) {
    if (mod === 'env' && kind === 'func' && !mainExports.has(field)) {
      if (d.exportSet.has(field)) d.stubSelf++;
      else d.stubGlue++;
    }
    if (d.exportSet.has(field)) {
      providers.self++;
      selfByKind[mod]++;
    } else if (mainExports.has(field)) providers.main++;
    else if ((defs.get(field) ?? []).some((j) => j !== i && dsos[j].bundle === d.bundle)) providers['sibling-same-bundle']++;
    else if ((defs.get(field) ?? []).some((j) => j !== i)) providers['other-bundle']++;
    else {
      providers['js-glue']++;
      jsGlue.add(field);
    }
  }
});

// per-bundle group simulation + audits
const bundles = [...new Set(dsos.map((d) => d.bundle))];
const groups = {};
const failures = [];
for (const b of bundles) {
  const members = dsos.filter((d) => d.bundle === b);
  const E = new Set(),
    I = new Set(),
    G = new Set(),
    shortnames = new Map();
  let size = 0,
    memSize = 0,
    tableSize = 0,
    exportEntries = 0,
    gotEntries = 0,
    envEntries = 0;
  for (const d of members) {
    size += d.size;
    memSize += d.memSize;
    tableSize += d.tableSize;
    exportEntries += d.exports.length;
    for (const x of d.exportSet) E.add(x);
    for (const { mod, field } of d.imports) {
      if (mod === 'env') {
        I.add(field);
        envEntries++;
      } else {
        G.add(field);
        gotEntries++;
      }
    }
    for (const p of d.pyinit) {
      const short = p.replace(/^PyInitU?_/, '');
      shortnames.set(short, (shortnames.get(short) ?? 0) + 1);
    }
    if (!d.pyinit.length) failures.push(`tier-1 DSO (no PyInit_*): ${b}/${d.soName}`);
  }
  const collisions = [...shortnames].filter(([, c]) => c > 1);
  for (const [short, c] of collisions) failures.push(`PyInit shortname collision in ${b}: ${short} ×${c}`);
  const dupes = {};
  for (const [name, idxs] of defs) {
    const inGroup = idxs.filter((i) => dsos[i].bundle === b);
    if (inGroup.length >= 2 && !SYNTHETIC.has(name)) {
      dupes[name] = {
        count: inGroup.length,
        allWeakFlagged: inGroup.every((i) => dsos[i].weakExports.includes(name)),
        members: inGroup.map((i) => dsos[i].soName),
      };
    }
  }
  groups[b] = {
    members: members.length,
    size,
    memSize,
    tableSize,
    exportEntries,
    envImports: I.size,
    gotImports: G.size,
    envEntries,
    gotEntries,
    internalizedEnv: [...I].filter((s) => E.has(s)).length,
    internalizedGot: [...G].filter((s) => E.has(s)).length,
    pyinits: members.reduce((a, d) => a + d.pyinit.length, 0),
    shortnameCollisions: collisions,
    dupes,
  };
}

// ---------- grouped-world gate (dsos:check v2, post-P1.5) ----------
// Once the tars ship grouped side modules (.avlo/<bundle>.so) the gate
// hardens: exact PyInit equality vs the committed groups.json census,
// finder-derivable init names (PyInit_<last dotted component>), loadOrder
// shape, closed-world at N=4 vs the staged main module, dylink sanity.
// Pre-grouping tars keep the legacy checks only; a mix is a broken restage.
const groupedDsos = dsos.filter((d) => d.path.startsWith('.avlo/'));
if (groupedDsos.length && groupedDsos.length !== dsos.length) {
  failures.push(`mixed grouped (${groupedDsos.length}) + per-extension (${dsos.length - groupedDsos.length}) DSOs across the staged tars`);
}
const groupedWorld = dsos.length > 0 && groupedDsos.length === dsos.length;
if (groupedWorld) {
  const groupsJson = JSON.parse(readFileSync(groupsPath, 'utf8'));
  const JS_GLUE_ALLOW = new Set(['exit']);
  const byBundle = new Map(dsos.map((d) => [d.bundle, d]));
  const censusBundles = Object.keys(groupsJson.bundles).sort();
  const tarBundles = [...byBundle.keys()].sort();
  if (censusBundles.join() !== tarBundles.join()) {
    failures.push(`DSO-bearing bundle set mismatch: census [${censusBundles}] vs tars [${tarBundles}]`);
  }
  for (const b of censusBundles) {
    const d = byBundle.get(b);
    if (!d) continue;
    if (d.path !== `.avlo/${b}.so`) failures.push(`${b}: group DSO at ${d.path}, want .avlo/${b}.so`);
    const want = new Set(groupsJson.bundles[b].extensions.map((e) => e.pyinit));
    const got = new Set(d.pyinit);
    for (const p of want) if (!got.has(p)) failures.push(`${b}: census PyInit missing from group exports: ${p}`);
    for (const p of got) if (!want.has(p)) failures.push(`${b}: stray PyInit export not in census: ${p}`);
    for (const e of groupsJson.bundles[b].extensions) {
      const short = e.dottedName.split('.').pop();
      if (e.pyinit !== `PyInit_${short}`)
        failures.push(
          `${b}: ${e.dottedName} pyinit ${e.pyinit} != PyInit_${short} (create_dynamic derives from the LAST dotted component)`,
        );
    }
    if (!d.hasDylink) failures.push(`${b}: group DSO has no dylink.0 section`);
    if (d.needed.length) failures.push(`${b}: group NEEDED not empty: ${d.needed.join(', ')}`);
    const unresolved = [
      ...new Set(
        d.imports
          .filter(({ field }) => !mainExports.has(field) && !d.exportSet.has(field) && !JS_GLUE_ALLOW.has(field))
          .map((i) => i.field),
      ),
    ];
    if (unresolved.length)
      failures.push(
        `${b}: ${unresolved.length} imports outside main ∪ self ∪ glue: ${unresolved.slice(0, 6).join(', ')}${unresolved.length > 6 ? ' …' : ''}`,
      );
  }
  for (const [bundle, meta] of metas) {
    const lo = meta.loadOrder ?? [];
    if (lo.length > 1) failures.push(`${bundle}: loadOrder has ${lo.length} entries (grouped world allows ≤1)`);
    for (const p of lo) if (!p.startsWith('.avlo/')) failures.push(`${bundle}: loadOrder entry ${p} not under .avlo/`);
  }
}

// ---------- report ----------
const kb = (n) => `${(n / 1024).toFixed(0)}K`;
console.log(
  `\n=== DSO census: ${dsos.length} DSOs, ${kb(dsos.reduce((a, d) => a + d.size, 0))} total (main: ${mainWasmPath.includes('dist/raw') ? 'dist/raw' : 'staged public'}) ===\n`,
);
console.log('bundle       n   size     memSz  tblSz  expEntries  envImp  GOT   pyinit  toolchains');
for (const b of bundles) {
  const g = groups[b];
  const tc = {};
  for (const d of dsos.filter((d) => d.bundle === b)) tc[d.toolchain] = (tc[d.toolchain] ?? 0) + 1;
  console.log(
    `${b.padEnd(12)} ${String(g.members).padStart(2)}  ${kb(g.size).padStart(7)} ${kb(g.memSize).padStart(6)} ${String(g.tableSize).padStart(6)}  ${String(g.exportEntries).padStart(9)} ${String(g.envImports).padStart(7)} ${String(g.gotImports).padStart(5)} ${String(g.pyinits).padStart(6)}   ${Object.entries(
      tc,
    )
      .map(([k, v]) => `${k}:${v}`)
      .join(' ')}`,
  );
}
console.log('\n=== import providers (all env/GOT entries, self-inclusive) ===');
console.log(providers, '· js-glue names:', [...jsGlue].join(', ') || '(none)');
console.log('self split by import kind:', selfByKind);

const stubTotals = { stubSelf: 0, stubGlue: 0 };
for (const d of dsos) {
  stubTotals.stubSelf += d.stubSelf;
  stubTotals.stubGlue += d.stubGlue;
}
console.log('\n=== lazy-stub audit (env-func ∉ mainExports; self-provided = permanent JS stub closures under RTLD_LOCAL) ===');
console.log('bundle       stubSelf  glueBound');
for (const b of bundles) {
  const members = dsos.filter((d) => d.bundle === b);
  console.log(
    `${b.padEnd(12)} ${String(members.reduce((a, d) => a + d.stubSelf, 0)).padStart(8)}  ${String(members.reduce((a, d) => a + d.stubGlue, 0)).padStart(9)}`,
  );
}
console.log(`total: ${stubTotals.stubSelf} self-stub / ${stubTotals.stubGlue} glue-bound`);
const topStubs = [...dsos]
  .sort((a, b) => b.stubSelf - a.stubSelf)
  .slice(0, 5)
  .filter((d) => d.stubSelf > 0);
if (topStubs.length) console.log('top DSOs:', topStubs.map((d) => `${d.bundle}/${d.soName}:${d.stubSelf}`).join('  '));
console.log('\n=== group simulation (per-bundle grouped link) ===');
console.log('bundle       env uniq→resid   GOT uniq→resid');
for (const b of bundles) {
  const g = groups[b];
  console.log(
    `${b.padEnd(12)} ${String(g.envImports).padStart(6)}→${String(g.envImports - g.internalizedEnv).padEnd(6)}  ${String(g.gotImports).padStart(5)}→${g.gotImports - g.internalizedGot}`,
  );
}
console.log('\n=== duplicate exports inside a group (non-synthetic; ODR-weak class expected for C++) ===');
for (const b of bundles) {
  const d = Object.entries(groups[b].dupes);
  if (d.length)
    console.log(
      `${b}: ${d.length} names — ${d
        .slice(0, 6)
        .map(([n, i]) => `${n} ×${i.count}`)
        .join(', ')}${d.length > 6 ? ` …(+${d.length - 6})` : ''}`,
    );
}
const needed = dsos.filter((d) => d.needed.length);
if (needed.length) {
  console.log('\n=== NEEDED ===');
  for (const d of needed) console.log(`${d.bundle}/${d.soName}: ${d.needed.join(', ')}`);
}

const totals = {
  dsoCount: dsos.length,
  totalBytes: dsos.reduce((a, d) => a + d.size, 0),
  totalExportEntries: dsos.reduce((a, d) => a + d.exports.length, 0),
  totalImportEntries: dsos.reduce((a, d) => a + d.imports.length, 0),
  totalGotEntries: bundles.reduce((a, b) => a + groups[b].gotEntries, 0),
  totalMemSize: dsos.reduce((a, d) => a + d.memSize, 0),
  totalTableSize: dsos.reduce((a, d) => a + d.tableSize, 0),
  mainExports: mainExports.size,
  groupCount: bundles.length,
};
console.log('\n=== totals ===');
console.log(totals);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  `${JSON.stringify({ totals, providers, selfByKind, stubTotals, jsGlue: [...jsGlue], groups, dsos: dsos.map(({ exportSet, exports, imports, weakExports, ...rest }) => ({ ...rest, nExports: exports.length, nImports: imports.length })) }, null, 1)}\n`,
);
console.log(`\nfull report -> ${outPath}`);

// ---------- --mint-groups: commit the census as config/dso-groups/groups.json ----------
if (mintMode) {
  const config = JSON.parse(readFileSync(join(pkgRoot, 'build.config.json'), 'utf8'));
  const wheelPins = config.recipes.wheels;
  const bundleMembers = Object.fromEntries(Object.entries(config.bundles).filter(([k]) => !k.startsWith('$')));
  // dotted name = tar-relative .so path through the trace-imports regex
  const dottedOf = (p) => (p.match(/^(.*)\.cpython-[^/]*\.so$/) ?? p.match(/^(.*)\.so$/))[1].replaceAll('/', '.');
  const out = {
    $comment:
      'GENERATED by analyze-dsos.mjs --mint-groups from the pre-grouping staged tars — the grouping source of truth. Per DSO-bearing bundle: the ordered extension census (lexicographic wheelSoPath order = the committed group-link input order) + the contributing wheels’ sha256 pins (pack-package’s stale-group gate asserts these == build.config pins; a wheel re-pin ⇒ regroup + re-mint).',
    schema: 1,
    bundles: {},
  };
  for (const b of bundles) {
    const members = dsos.filter((d) => d.bundle === b).sort((x, y) => (x.path < y.path ? -1 : 1));
    const pkgs = {};
    const extensions = members.map((d) => {
      const top = d.path.split('/')[0];
      const pkg = (bundleMembers[b] ?? []).find((m) => m === top || m.replace(/-/g, '_') === top);
      if (!pkg) throw new Error(`mint: no member wheel of bundle ${b} owns ${d.path}`);
      if (d.pyinit.length !== 1) throw new Error(`mint: ${b}/${d.soName} has ${d.pyinit.length} PyInit exports`);
      pkgs[pkg] = wheelPins[pkg].sha256;
      return { pkg, dottedName: dottedOf(d.path), pyinit: d.pyinit[0], wheelSoPath: d.path };
    });
    out.bundles[b] = { packages: pkgs, extensions };
  }
  mkdirSync(dirname(groupsPath), { recursive: true });
  writeFileSync(groupsPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(
    `minted ${groupsPath}: ${Object.entries(out.bundles)
      .map(([b, g]) => `${b}=${g.extensions.length}`)
      .join(' ')}`,
  );
}

if (failures.length) {
  console.error(`\nAUDIT FAILURES (${failures.length}):`);
  for (const f of failures) console.error(`  ${f}`);
  if (checkMode) process.exit(1);
} else if (checkMode) {
  console.log('\ncheck OK: PyInit shortnames unique per bundle, no PyInit-less DSO');
}
