#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PORTS = JSON.parse(readFileSync(resolve(here, 'dev-ports.json'), 'utf8'));

// dev-ports.json holds doc keys (`_comment`) alongside port numbers — filter
// to numeric entries so the usage hint stays clean and `_comment` isn't a
// "valid" worker name.
const knownWorkers = Object.entries(PORTS)
  .filter(([, v]) => typeof v === 'number')
  .map(([k]) => k);

const name = process.argv[2];
if (!knownWorkers.includes(name)) {
  console.error(`Usage: dev-worker.mjs <${knownWorkers.join('|')}>`);
  process.exit(1);
}

const offset = parseInt(process.env.PORT_OFFSET || '0', 10);
const port = PORTS[name] + offset;
// Wrangler defaults every worker to inspector port 9229, then auto-increments
// on conflict — but three workers racing the default causes intermittent EADDRINUSE
// at startup, and any parallel checkout running its own wrangler already holds 9229.
// Derive a deterministic per-worker inspector port from the dev port (offset by 1000)
// so workers within a session don't fight, and parallel sessions get distinct ports
// via PORT_OFFSET.
const inspectorPort = PORTS[name] + 1000 + offset;
const repoRoot = resolve(here, '..');
// Force every worker onto a single repo-level Miniflare state tree. Without this,
// wrangler v4 resolves the default `.wrangler/` relative to the *config file's*
// directory — so each `workers/<name>/.wrangler/state/v3/r2/avlo-assets/` ends up
// a *separate* physical bucket. Bug surface: unfurl writes an OG image to its
// own R2, the images worker's R2 stays empty, and the browser's GET on that
// `<sha>` 404s. The path must be absolute — a relative `--persist-to` is itself
// resolved against the config dir in some wrangler versions, silently un-sharing
// the state. The matching `bucket_name` (`avlo-assets`) in both wrangler.jsoncs
// is the second half of the contract: same persist root + same bucket name =
// one shared subdirectory across workers.
const persistTo = resolve(repoRoot, '.wrangler/state');

// Workerd startup on the shared persist root can race sibling workers CREATING the
// same metadata.sqlite (cache/r2/do subdirs) — the loser dies with a fatal
// `database is locked: SQLITE_BUSY` (observed on the first six-way boot after wiping
// `.wrangler/state`; once the files exist, concurrent opens are fine). An early
// nonzero exit IS that race in practice — retry with jitter so one loser doesn't
// take down the whole `concurrently -k` session. A real config error still surfaces:
// it keeps crashing past MAX_RETRIES. Signal kills (`code === null`, concurrently's
// SIGTERM) never retry.
const STARTUP_WINDOW_MS = 15_000;
const MAX_RETRIES = 2;
let attempts = 0;

function run() {
  const startedAt = Date.now();
  const proc = spawn(
    'npx',
    [
      'wrangler',
      'dev',
      '-c',
      `workers/${name}/wrangler.jsonc`,
      '--port',
      String(port),
      '--inspector-port',
      String(inspectorPort),
      '--persist-to',
      persistTo,
    ],
    { stdio: 'inherit', cwd: repoRoot, shell: true },
  );
  proc.on('exit', (code) => {
    if (code !== null && code !== 0 && Date.now() - startedAt < STARTUP_WINDOW_MS && attempts < MAX_RETRIES) {
      attempts += 1;
      const delay = 500 + Math.floor(Math.random() * 1000);
      console.error(`[dev-worker] ${name} crashed during startup (exit ${code}) — retrying ${attempts}/${MAX_RETRIES} in ${delay}ms`);
      setTimeout(run, delay);
      return;
    }
    process.exit(code ?? 0);
  });
}
run();
