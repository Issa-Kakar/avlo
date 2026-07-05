#!/usr/bin/env node
// Host-side wrapper: ensures the pinned pyodide clone + docker image, then runs
// scripts/build.sh inside the container. Usage:
//   node scripts/run-build.mjs [--clone-only] [--targets "<make targets>"] [--allow-undigested]
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cfgPath = join(pkgRoot, 'build.config.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const work = join(pkgRoot, '.work');
const src = join(work, 'pyodide');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};

const run = (cmd, cmdArgs, opts = {}) => execFileSync(cmd, cmdArgs, { stdio: 'inherit', ...opts });

// 1. Clone (shallow, pinned tag, submodules for pyodide-build)
mkdirSync(work, { recursive: true });
if (!existsSync(join(src, '.git'))) {
  console.log(`=== cloning pyodide @ ${cfg.pyodide.tag}`);
  run('git', ['clone', '--depth', '1', '--branch', cfg.pyodide.tag, '--recurse-submodules', '--shallow-submodules', cfg.pyodide.repo, src]);
} else {
  console.log('=== pyodide clone exists');
}
if (flag('--clone-only')) process.exit(0);

// 2. Image: pull if missing, stamp digest into build.config.json on first pull
const inspect = spawnSync('docker', ['image', 'inspect', cfg.image.ref], { stdio: 'pipe' });
if (inspect.status !== 0) {
  console.log(`=== pulling ${cfg.image.ref}`);
  run('docker', ['pull', cfg.image.ref]);
}
const digestOut = execFileSync('docker', ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', cfg.image.ref]).toString().trim();
const digest = digestOut.split('@')[1] ?? '';
if (!cfg.image.digest) {
  cfg.image.digest = digest;
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  console.log(`=== stamped image digest ${digest}`);
} else if (cfg.image.digest !== digest && !flag('--allow-undigested')) {
  console.error(`!!! image digest drift: pinned ${cfg.image.digest} vs local ${digest}`);
  process.exit(1);
}

// 3. Build in container (host uid/gid so .work stays user-owned; HOME=/src)
const targets = opt('--targets', cfg.targets.m0);
const uid = process.getuid();
const gid = process.getgid();
console.log(`=== building targets: ${targets}`);
run('docker', [
  'run',
  '--rm',
  '--user',
  `${uid}:${gid}`,
  '-e',
  'HOME=/src',
  '-e',
  `TARGETS=${targets}`,
  '-e',
  `EMSDK_NUM_CORES=${cfg.jobs.emsdkCores}`,
  '-e',
  `EMCC_CORES=${cfg.jobs.emccCores}`,
  '-e',
  `PYODIDE_JOBS=${cfg.jobs.pyodideJobs}`,
  '-v',
  `${src}:/src`,
  '-v',
  `${pkgRoot}:/pb:ro`,
  '-v',
  `${join(pkgRoot, 'dist')}:/out`,
  '-w',
  '/src',
  cfg.image.ref,
  'bash',
  '/pb/scripts/build.sh',
]);
console.log('=== run-build.mjs done');
