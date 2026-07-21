#!/usr/bin/env node
// Host-side driver for the recipe-rebuild loop (P1.5 DSO grouping 67->4):
// ensures the pinned pyodide-recipes checkout (+ its vendored pyodide-build
// submodule), applies the committed patch queues, then runs
// scripts/recipes-build.sh inside the SAME digest-pinned pyodide-env image as
// the fork build. Afterwards syncs the content-addressed link-input stash to
// .cache/link-inputs/ and the generated per-bundle manifests to
// config/dso-groups/ (committed).
//
//   node scripts/run-recipes.mjs                  # full loop: build 5 pkgs, harvest, link
//   node scripts/run-recipes.mjs --clone-only     # checkout + patches, no container
//   node scripts/run-recipes.mjs --pkg kiwisolver # spike: build+harvest+link one package
//   node scripts/run-recipes.mjs --link-only      # skip builds; re-harvest + re-link
//   node scripts/run-recipes.mjs --force          # ignore per-package done stamps
//   node scripts/run-recipes.mjs --freeze-constraints
//                                                 # scrape build.logs' "Successfully
//                                                 # installed" lines into
//                                                 # config/recipes-constraints.txt
//
// Layout under .work/recipes-root/ (gitignored; persists => incremental):
//   recipes/    checkout @ recipes.commit (submodule pyodide-build @ pin)
//   venv/       pip venv with the PATCHED pyodide-build (stamp-guarded)
//   xbuildenv/  PYODIDE_XBUILDENV_PATH (emsdk auto-installs inside at first build)
//   build/      PYODIDE_RECIPE_BUILD_DIR (sdist trees; build-dir=build persists objects)
//   record/     AVLO_LINK_RECORD_DIR (one JSON per .so link, from the pywasmcross patch)
//   stash/      content-addressed .o/.a link inputs (rsynced to .cache/link-inputs/)
//   cache/      xbuildenv tarball (byte-verified vs the config pin)
//   pip-cache/  PIP_CACHE_DIR
//
// Accepted provenance deviation (documented, deliberate): upstream builds
// these wheels in a conda env on ubuntu-latest; we run a pip venv inside the
// digest-pinned pyodide-env image. The TARGET toolchain (xbuildenv 314.0.2 +
// emscripten 5.0.3 + pyodide-build @ the recipes submodule pin) is identical
// to upstream's — verify-pytree.py's .py byte-equality gate is the check.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cfgPath = join(pkgRoot, 'build.config.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const rx = join(pkgRoot, '.work/recipes-root');
const src = join(rx, 'recipes');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};

const run = (cmd, cmdArgs, opts = {}) => execFileSync(cmd, cmdArgs, { stdio: 'inherit', ...opts });
const out = (cmd, cmdArgs, opts = {}) =>
  execFileSync(cmd, cmdArgs, { ...opts })
    .toString()
    .trim();

// --- 0. --freeze-constraints: scrape the build loop's pip log ---------------
// Build-backend deps (Cython, meson-python, ninja, pybind11, ...) resolve
// UNPINNED from each sdist at build time (pypabuild.py) across two pip
// invocations per package; host cross-env installs (numpy for pandas/
// matplotlib) ride the same log. Their output is NOT tee'd into build.log —
// recipes-build.sh exports PIP_LOG=/rx/pip-install.log for the build loop.
// Pins are frozen PER PACKAGE (config/recipes-constraints.d/<pkg>.txt):
// legitimate cross-package conflicts exist (numpy resolves Cython 3.2.8
// while pandas' `<4.0.0a0` bound enables the 3.3.0a1 prerelease; matplotlib
// pins meson-python 0.16.x vs 0.20.x elsewhere) and PIP_CONSTRAINT applies
// to every requirement in an env, so one global file is unsatisfiable.
// recipes-build.sh writes an `AVLO-PKG <name>` marker before each package
// build; rounds attribute to the marker above them, the LAST section per
// package wins (a --pkg rerun appends a fresh section), and a version
// conflict WITHIN one section is a hard error. Only packages present in the
// log get (re)written — absent packages keep their committed files.
if (flag('--freeze-constraints')) {
  const pipLog = join(rx, 'pip-install.log');
  if (!existsSync(pipLog)) throw new Error(`${pipLog} missing — run a build first (PIP_LOG capture)`);
  const sections = new Map(); // pkg -> Map(name -> ver); last section per pkg wins
  let cur = null;
  let curPkg = null;
  for (const line of readFileSync(pipLog, 'utf8').split('\n')) {
    const mk = line.match(/^AVLO-PKG (\S+)$/);
    if (mk) {
      curPkg = mk[1];
      cur = new Map();
      sections.set(curPkg, cur);
      continue;
    }
    const m = line.match(/Successfully installed (.+)$/);
    if (!m) continue;
    if (!cur)
      throw new Error(
        'install round before any AVLO-PKG marker — re-run a full forced build (markers come from the current recipes-build.sh)',
      );
    for (const spec of m[1].trim().split(/\s+/)) {
      const dash = spec.lastIndexOf('-');
      if (dash <= 0) continue;
      const name = spec.slice(0, dash);
      const ver = spec.slice(dash + 1);
      const prev = cur.get(name);
      if (prev && prev !== ver) throw new Error(`${curPkg}: within-build constraint conflict: ${name} ${prev} vs ${ver}`);
      cur.set(name, ver);
    }
  }
  if (sections.size === 0) throw new Error('no AVLO-PKG sections in the pip log — run a full forced build first');
  const consDir = join(pkgRoot, 'config/recipes-constraints.d');
  mkdirSync(consDir, { recursive: true });
  for (const [pkgName, pins] of sections) {
    if (pins.size === 0)
      throw new Error(`${pkgName}: AVLO-PKG marker present but no install rounds after it — truncated/aborted build log?`);
    const body = [
      '# GENERATED by run-recipes.mjs --freeze-constraints — every build-backend dep',
      `# resolved by ${pkgName}'s isolated envs (pypabuild pip rounds + host cross-env`,
      '# installs), attributed via the AVLO-PKG markers recipes-build.sh writes into',
      '# the pip log. Per-package because cross-package conflicts are legitimate',
      '# (Cython 3.2.8 vs 3.3.0a1). Upstream keeps only the cmake guard.',
      'cmake < 4',
      ...[...pins].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, v]) => `${n}==${v}`),
    ].join('\n');
    writeFileSync(join(consDir, `${pkgName}.txt`), `${body}\n`);
    console.log(`froze ${pins.size} pins -> config/recipes-constraints.d/${pkgName}.txt`);
  }
  process.exit(0);
}

// --- 1. checkout at pin + patch queues --------------------------------------
mkdirSync(rx, { recursive: true });
if (!existsSync(join(src, '.git'))) {
  console.log(`=== cloning pyodide-recipes @ ${cfg.recipes.release}`);
  run('git', [
    'clone',
    '--depth',
    '1',
    '--branch',
    cfg.recipes.release,
    '--recurse-submodules',
    '--shallow-submodules',
    cfg.recipes.repo,
    src,
  ]);
} else {
  console.log('=== recipes clone exists');
}
const head = out('git', ['-C', src, 'rev-parse', `${cfg.recipes.release}^{commit}`]);
if (head !== cfg.recipes.commit) {
  console.error(`!!! recipes tag ${cfg.recipes.release} resolves to ${head}, config pins ${cfg.recipes.commit}`);
  process.exit(1);
}
const pbDir = join(src, 'pyodide-build');
// Reset both trees to their pins (drops previous patch commits; build outputs
// under packages/<pkg>/{build.log,dist} are untracked and survive — NO git
// clean here), then re-apply the committed queues, one commit per patch.
run('git', ['-C', src, 'checkout', '-f', cfg.recipes.commit, '--']);
// The clone's recorded submodule rev IS the pin; the fetch is belt-and-braces
// for a stale existing checkout (shallow clones can refuse sha fetches).
spawnSync('git', ['-C', pbDir, 'fetch', '-q', 'origin', cfg.recipes.pyodideBuildCommit], { stdio: 'pipe' });
run('git', ['-C', pbDir, 'checkout', '-f', cfg.recipes.pyodideBuildCommit, '--']);
const pbHead = out('git', ['-C', pbDir, 'rev-parse', 'HEAD']);
if (pbHead !== cfg.recipes.pyodideBuildCommit) {
  console.error(`!!! pyodide-build submodule at ${pbHead}, config pins ${cfg.recipes.pyodideBuildCommit}`);
  process.exit(1);
}
const applyQueue = (repoDir, patchDir) => {
  if (!existsSync(patchDir)) return;
  for (const p of readdirSync(patchDir)
    .filter((f) => f.endsWith('.patch'))
    .sort()) {
    console.log(`=== applying ${p}`);
    run('git', ['-C', repoDir, 'config', 'user.email', 'py-build@avlo.local']);
    run('git', ['-C', repoDir, 'config', 'user.name', 'avlo-py-build']);
    run('git', ['-C', repoDir, 'apply', '--index', join(patchDir, p)]);
    run('git', ['-C', repoDir, 'commit', '-qm', p]);
  }
};
applyQueue(src, join(pkgRoot, 'patches/recipes'));
applyQueue(pbDir, join(pkgRoot, 'patches/pyodide-build'));
if (flag('--clone-only')) process.exit(0);

// --- 2. image digest gate (same image as the fork build) --------------------
const inspect = spawnSync('docker', ['image', 'inspect', cfg.image.ref], { stdio: 'pipe' });
if (inspect.status !== 0) {
  console.log(`=== pulling ${cfg.image.ref}`);
  run('docker', ['pull', cfg.image.ref]);
}
const digest = out('docker', ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', cfg.image.ref]).split('@')[1] ?? '';
if (cfg.image.digest && cfg.image.digest !== digest && !flag('--allow-undigested')) {
  console.error(`!!! image digest drift: pinned ${cfg.image.digest} vs local ${digest}`);
  process.exit(1);
}

// --- 3. build + harvest + link in the container -----------------------------
for (const d of ['xbuildenv', 'build', 'record', 'stash', 'cache', 'pip-cache']) mkdirSync(join(rx, d), { recursive: true });
const passThrough = [];
if (flag('--link-only')) passThrough.push('--link-only');
if (flag('--force')) passThrough.push('--force');
const pkg = opt('--pkg', null);
if (pkg) passThrough.push('--pkg', pkg);
run('docker', [
  'run',
  '--rm',
  '--user',
  `${process.getuid()}:${process.getgid()}`,
  '-e',
  'HOME=/rx',
  '-e',
  'PYODIDE_XBUILDENV_PATH=/rx/xbuildenv',
  '-e',
  'PYODIDE_RECIPE_BUILD_DIR=/rx/build',
  '-e',
  'AVLO_LINK_RECORD_DIR=/rx/record',
  '-e',
  'PIP_CACHE_DIR=/rx/pip-cache',
  '-v',
  `${rx}:/rx`,
  '-v',
  `${pkgRoot}:/pb:ro`,
  '-v',
  `${join(pkgRoot, 'dist')}:/out`,
  '-w',
  '/rx',
  cfg.image.ref,
  'bash',
  '/pb/scripts/recipes-build.sh',
  ...passThrough,
]);

// --- 4. sync stash -> .cache/link-inputs, manifests -> config/dso-groups ----
run('rsync', ['-a', '--delete', `${join(rx, 'stash')}/`, `${join(pkgRoot, '.cache/link-inputs')}/`]);
const manDir = join(pkgRoot, 'dist/groups/manifests');
if (existsSync(manDir)) {
  for (const f of readdirSync(manDir).filter((f) => f.endsWith('.json'))) {
    const gen = readFileSync(join(manDir, f), 'utf8');
    if (JSON.parse(gen).partial) {
      console.log(`=== ${f} is PARTIAL (spike) — not copied to config/dso-groups/`);
      continue;
    }
    const dest = join(pkgRoot, 'config/dso-groups', f);
    if (existsSync(dest) && readFileSync(dest, 'utf8') !== gen) {
      console.log(
        `!! ${f}: committed manifest differs from this harvest (recipe/toolchain change?) — overwriting; review the diff before committing`,
      );
    }
    writeFileSync(dest, gen);
  }
}
console.log('=== run-recipes.mjs done');
