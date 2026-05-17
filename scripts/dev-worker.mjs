#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PORTS = JSON.parse(readFileSync(resolve(here, 'dev-ports.json'), 'utf8'));

const name = process.argv[2];
if (!PORTS[name] || name.startsWith('_')) {
  const valid = Object.keys(PORTS).filter((k) => !k.startsWith('_'));
  console.error(`Usage: dev-worker.mjs <${valid.join('|')}>`);
  process.exit(1);
}

const port = PORTS[name] + parseInt(process.env.PORT_OFFSET || '0', 10);
const repoRoot = resolve(here, '..');
const proc = spawn(
  'npx',
  ['wrangler', 'dev', '-c', `workers/${name}/wrangler.jsonc`, '--port', String(port)],
  { stdio: 'inherit', cwd: repoRoot, shell: true },
);
proc.on('exit', (code) => process.exit(code ?? 0));
