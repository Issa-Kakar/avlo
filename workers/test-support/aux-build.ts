/**
 * Node-side esbuild bundler for REAL workers used as miniflare auxiliary workers in
 * pool-workers suites (auxiliary workers must be pre-built JS — the pool only compiles
 * the worker under test). Runs at vitest-config load; output lands in
 * `workers/test-support/.build/` (gitignored). A metafile-driven freshness check skips
 * the rebuild when no input is newer than the bundle, so config reloads (watch mode,
 * the root aggregator evaluating every project) don't pay the bundle cost.
 *
 * Which suites build what: sync builds `auth` (real identity chain at the WS seam);
 * users builds `sync` (real cross-script AvloDO). Everything else uses the stubs.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT_DIR = path.join(HERE, '.build');

/**
 * Compat date for every aux/stub/inline test worker — read from a real wrangler.jsonc
 * (all seven are bumped in lockstep; sync is the arbitrary source) so a compat bump can
 * never silently leave the test workers on an older date.
 */
const compatMatch = /"compatibility_date":\s*"([^"]+)"/.exec(readFileSync(path.join(ROOT, 'workers/sync/wrangler.jsonc'), 'utf8'));
if (!compatMatch) throw new Error('compatibility_date not found in workers/sync/wrangler.jsonc');
export const TEST_COMPAT_DATE = compatMatch[1];

export const STUB_AUTH = path.join(HERE, 'stub-auth.mjs');
export const STUB_USERS_IMAGES = path.join(HERE, 'stub-users-images.mjs');

/**
 * The auth worker's full secret/var set with test-only values — needed wherever the
 * REAL auth code runs (auth's own suite; sync's aux auth worker). Pinning every var the
 * tests observe also neutralizes the pool folding a developer's `.dev.vars` over
 * wrangler `vars`.
 */
export const TEST_AUTH_BINDINGS = {
  ANON_SECRET: 'test-anon-secret',
  OAUTH_PKCE_SECRET: 'test-pkce-secret',
  GOOGLE_CLIENT_SECRET: 'test-google-secret',
  GOOGLE_CLIENT_ID: 'test-client-id',
  APP_ORIGIN: 'https://avlo.io',
  OAUTH_REDIRECT_URI: 'https://auth.avlo.io/callback',
} as const;

/**
 * Miniflare worker-options fragment for an auxiliary worker (stub or real pre-built).
 * Explicit `modules` + `modulesRoot`: skips miniflare's scanner (it trips on hono's
 * dynamic `import(cfWorkers)`) and keeps the workerd module NAME a clean basename —
 * a cwd-relative "../…" name is rejected opaquely. Extras spread last so a caller can
 * add bindings/flags (or override the compat date if it ever must diverge).
 */
export function auxWorker<E extends object>(name: string, script: string, extras?: E) {
  return {
    name,
    modulesRoot: path.dirname(script),
    modules: [{ type: 'ESModule' as const, path: script }],
    compatibilityDate: TEST_COMPAT_DATE,
    ...extras,
  };
}

/** Every metafile input is at least as old as the bundle → skip the rebuild. */
function isFresh(outfile: string, metafile: string): boolean {
  if (!existsSync(outfile) || !existsSync(metafile)) return false;
  try {
    const outMtime = statSync(outfile).mtimeMs;
    const meta = JSON.parse(readFileSync(metafile, 'utf8')) as { inputs: Record<string, unknown> };
    return Object.keys(meta.inputs).every((p) => statSync(path.join(ROOT, p)).mtimeMs <= outMtime);
  } catch {
    return false; // deleted/renamed input, corrupt metafile — rebuild
  }
}

/** Bundle `workers/<dir>/src/index.ts` → single ESM file; returns the absolute path. */
export function buildAuxWorker(dir: 'auth' | 'sync'): string {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const outfile = path.join(OUT_DIR, `avlo-${dir}.mjs`);
  const metafile = `${outfile}.meta.json`;
  if (isFresh(outfile, metafile)) return outfile;
  const result = buildSync({
    entryPoints: [path.join(ROOT, `workers/${dir}/src/index.ts`)],
    outfile,
    absWorkingDir: ROOT, // metafile inputs stay ROOT-relative regardless of caller cwd
    bundle: true,
    format: 'esm',
    target: 'esnext',
    conditions: ['workerd', 'worker'],
    external: ['cloudflare:*', 'node:*'],
    loader: { '.sql': 'text' }, // sync's drizzle migrations ride the wrangler Text rule; mirror it
    logLevel: 'silent',
    metafile: true,
  });
  writeFileSync(metafile, JSON.stringify(result.metafile));
  return outfile;
}
