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
const proc = spawn(
  'npx',
  ['wrangler', 'dev', '-c', `workers/${name}/wrangler.jsonc`, '--port', String(port), '--inspector-port', String(inspectorPort)],
  { stdio: 'inherit', cwd: repoRoot, shell: true },
);
proc.on('exit', (code) => process.exit(code ?? 0));
