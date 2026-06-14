#!/usr/bin/env node
// Single-instance Miniflare dev orchestrator.
//
// WHY THIS EXISTS: `sync` (wrangler name `avlo-sync`) PRODUCES to the queues
// `avlo-room-visits`/`avlo-room-meta`; `users` (`avlo-users`) CONSUMES both.
// Cloudflare Queues only deliver when producer and consumer share ONE Miniflare
// instance (cross-process service bindings work since Sept 2025, cross-process
// queues do NOT — workers-sdk #9795). The old `scripts/dev-worker.mjs` spawns a
// SEPARATE `wrangler dev` (hence a separate Miniflare) per worker, so locally the
// queue → D1 projection never ran. This boots all five workers in one
// `new Miniflare({ workers: [...] })` so queues, cross-script DO RPC, and every
// service-binding edge behave like prod — while each worker keeps its EXISTING
// dev port (so `web/vite.config.ts` is untouched).
//
// Topology inside the one instance:
//   • `sync` is workers[0] (the ENTRY worker) on the top-level `port` (8787+offset).
//     This is Miniflare's normal entry path — the same one `wrangler dev` serves
//     partyserver WS on today — so the `/sync/*` upgrade + AvloDO stay on proven ground.
//   • images/unfurl/auth/users each pin `unsafeDirectSockets:[{port}]` to their
//     existing port (a normal HTTP entry to `fetch`, addressable via the Vite proxy).
//
// `unstable_getMiniflareWorkerOptions(cfg)` translates each wrangler.jsonc into
// Miniflare options faithfully (services→entrypoints, cross-script DO, queues,
// D1/KV/R2, rate limits, auto-folds `.dev.vars`) — no config fork, zero drift.
// The ONE thing it does not do is bundle TypeScript; that is esbuild's job here.
//
// Rollback: `npm run dev:legacy` restores the five-process behavior verbatim.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { Log, LogLevel, Miniflare } from 'miniflare';
import { unstable_getMiniflareWorkerOptions } from 'wrangler';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const PORTS = JSON.parse(readFileSync(resolve(here, 'dev-ports.json'), 'utf8'));
const offset = parseInt(process.env.PORT_OFFSET || '0', 10);
// dev-ports.json carries a `_comment` doc key alongside the numbers — keep only
// numeric entries. Order is load-bearing: `sync` is first ⇒ it becomes workers[0].
const workerNames = Object.entries(PORTS)
  .filter(([, v]) => typeof v === 'number')
  .map(([n]) => n);

// The ENTRY worker becomes Miniflare's top-level `port` (the WS /sync/* upgrade + DO stay on
// the proven entry path); every other worker gets an unsafeDirectSocket on its own dev port.
const ENTRY = 'sync';

const HOST = '127.0.0.1';
const INSPECTOR_PORT = 9229 + offset;

// Miniflare's `[mf:*]` log — the per-request lines + lifecycle/reload notices that
// `wrangler dev` shows but the programmatic Miniflare API suppresses by default (no `log`
// option ⇒ a no-op log). INFO restores request lines for the ENTRY worker (main) + reload
// notices; this is the `--verbose` knob (a wrangler-CLI flag, inapplicable to this script):
// `MF_LOG_LEVEL=debug|verbose npm run dev` for binding/options detail or workerd internals.
// Per-worker request lines for the direct-socket workers come from `devRequestLogger` instead.
const LOG_LEVELS = {
  none: LogLevel.NONE,
  error: LogLevel.ERROR,
  warn: LogLevel.WARN,
  info: LogLevel.INFO,
  debug: LogLevel.DEBUG,
  verbose: LogLevel.VERBOSE,
};
const logLevel = LOG_LEVELS[(process.env.MF_LOG_LEVEL ?? 'info').toLowerCase()] ?? LogLevel.INFO;

// dir name → wrangler `name`. LOAD-BEARING: services + cross-script DO resolve by
// wrangler NAME, not dir. A mismatch silently breaks every cross-worker edge
// (the pre-flight assert below catches it loudly).
const NAME = { sync: 'avlo-sync', images: 'avlo-images', unfurl: 'avlo-unfurl', auth: 'avlo-auth', users: 'avlo-users' };

// CRITICAL: `wrangler dev --persist-to <X>` (and `wrangler d1 migrations apply
// --persist-to <X>`) store under `<X>/v3/{d1,r2,kv,do,cache}` — Miniflare's
// defaultPersistRoot does NOT add that `v3` segment. Omitting it makes the orchestrator
// open a brand-new EMPTY state tree beside the real one: D1 with no tables ("no such
// table: room_visits"), empty R2 buckets, lost KV sessions + DO room data. So we append
// `v3` to match wrangler's exact layout (same DB keys → reads the migrated DB directly).
// Like the legacy dev-worker.mjs, ONE tree regardless of offset: each git checkout /
// worktree has its own `.wrangler/`, so two checkouts never contend. Full continuity,
// zero drift. (A truly fresh tree still needs `wrangler d1 migrations apply` once — see
// the startup hint below; that was always true under the legacy setup too.)
const persistRoot = resolve(repoRoot, '.wrangler/state/v3');

// ─── shared mutable state ────────────────────────────────────────────────────
/** dir → latest esbuild bundle text. Read fresh by buildWorkerEntries on every (re)assemble. */
const bundles = new Map();
/** [{ dir, name, main(abs), workerOptions, define }] — translator output, mutated in place by fix-ups. */
const translated = [];
/** esbuild BuildContexts — retained so the watching contexts aren't GC'd; the shared esbuild service exits with this process. */
const buildContexts = [];
/** Set once Miniflare starts. capturePlugin reads it to know if a rebuild should hot-reload. */
let mf = null;
let reloadTimer = null;

// ─── esbuild bundling ────────────────────────────────────────────────────────
// `node:*` + `cloudflare:*` MUST stay external — workerd supplies them at runtime
// under `nodejs_compat` (+ `cloudflare:workers`); bundling them breaks jose/arctic/
// drizzle. `.sql` → text inlines sync's drizzle migration modules (its generated
// migrations.js does `import m0000 from './0000_*.sql'`), so no Miniflare Text rule
// is needed. `@avlo/*` resolve via each package's `exports` map (default condition).
function esbuildOptions(entryAbs, define, plugins) {
  return {
    entryPoints: [entryAbs],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'esnext',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['module', 'main'],
    external: ['node:*', 'cloudflare:*'],
    loader: { '.sql': 'text', '.json': 'json' },
    define,
    write: false,
    sourcemap: 'inline',
    logLevel: 'warning',
    plugins,
  };
}

// onEnd caches the bundle and, after startup, debounces a hot reload. The first
// build per worker calls `signalFirst` (resolving makeContext's gate); later builds
// (from the watcher) trigger setOptions. Build failures are non-fatal post-startup —
// log and keep the last good bundle so a typo doesn't wedge the instance.
function capturePlugin(dir, signalFirst) {
  let firstDone = false;
  return {
    name: `capture-${dir}`,
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length) {
          console.error(`[mf] ${dir} build failed: ${result.errors.map((e) => e.text).join('; ')}`);
          if (!firstDone) {
            firstDone = true;
            signalFirst(new Error(`${dir} initial build failed`));
          }
          return; // keep the previous bundle; do not reload
        }
        bundles.set(dir, result.outputFiles[0].text);
        if (!firstDone) {
          firstDone = true;
          signalFirst(null);
        } else if (mf) {
          scheduleReload();
        }
      });
    },
  };
}

// Create a watching context. `ctx.watch()` runs ONE initial build (no separate
// rebuild() → no double build) and keeps watching the resolved graph, including
// `packages/*/src` — editing a shared package rebuilds its dependents.
async function makeContext(dir, entryAbs, define) {
  let signalFirst;
  const firstBuild = new Promise((res, rej) => {
    signalFirst = (err) => (err ? rej(err) : res());
  });
  const ctx = await esbuild.context(esbuildOptions(entryAbs, define, [capturePlugin(dir, signalFirst)]));
  buildContexts.push(ctx);
  await ctx.watch();
  await firstBuild;
}

// ─── assembly ────────────────────────────────────────────────────────────────
// Build the `workers[]` array from translated options + the current bundles.
// Called for both the initial start and every hot reload, so fix-ups live here.
function buildWorkerEntries() {
  return translated.map(({ dir, name, main, workerOptions }) => {
    const code = bundles.get(dir);
    if (code == null) throw new Error(`[mf] no bundle for ${dir}`);
    const entry = {
      ...workerOptions,
      name, // translator returns name: undefined — re-assert AFTER the spread
      modules: [{ type: 'ESModule', path: main, contents: code }],
    };

    // Dev-only logging gate (worker-shared/dev-logs.ts reads it). Merge into a FRESH bindings
    // object — never mutate translated[].workerOptions.bindings (re-read on every hot reload,
    // and ensureAuthDevVars already wrote the auth secrets there). Absent from every
    // wrangler.jsonc ⇒ prod never sets it ⇒ request/RPC/Drizzle/hibernation logs stay dormant.
    entry.bindings = { ...workerOptions.bindings, DEV_LOGS: '1' };

    // users' cross-script `rooms` DO: the translator derives useSQLite from the
    // BINDING worker's own migrations, which `users` lacks (sync owns them). Storage
    // semantics actually come from the defining worker (`avlo-sync`), but set it
    // explicitly so Miniflare doesn't object to the cross-script SQLite class.
    if (dir === 'users') entry.durableObjects.rooms.useSQLite = true;

    // No dev worker has an `assets` binding: `avlo` (the site worker) isn't assembled in dev —
    // Vite serves the SPA, and the realtime worker (`avlo-sync`) is a pure worker. So there is
    // nothing to drop here; the Static-Assets binding is exercised only by preview/prod.

    // Non-entry workers each listen on their existing dev port via an unsafe direct
    // socket (proxy:false = a normal HTTP entry to the worker's default `fetch`),
    // so the Vite proxy reaches them unchanged. ENTRY (sync) is the entry worker on the
    // top-level port instead (the WS path stays on Miniflare's proven entry).
    if (dir !== ENTRY) {
      entry.unsafeDirectSockets = [{ host: HOST, port: PORTS[dir] + offset, entrypoint: 'default', proxy: false }];
    }
    return entry;
  });
}

function miniflareOptions() {
  return {
    log: new Log(logLevel), // [mf:*] request + lifecycle lines (suppressed by default via the API)
    defaultPersistRoot: persistRoot,
    host: HOST,
    port: PORTS[ENTRY] + offset, // entry worker = sync → its existing port (WS /sync/*)
    inspectorPort: INSPECTOR_PORT, // ONE inspector for all isolates
    workers: buildWorkerEntries(),
  };
}

// ─── hot reload ──────────────────────────────────────────────────────────────
// Debounced so a save that touches several files (or a shared package) coalesces
// into one setOptions. setOptions reloads in place — persisted state, DO storage,
// and the listening ports/direct sockets survive, so the Vite proxy never notices.
function scheduleReload() {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    reloadTimer = null;
    try {
      await mf.setOptions(miniflareOptions());
      console.error('[mf] reloaded');
    } catch (err) {
      console.error(`[mf] reload failed (instance kept alive): ${err?.message ?? err}`);
    }
  }, 100);
}

// ─── pre-flight: cross-worker edges resolve ──────────────────────────────────
// The worst bug class is a service/DO edge pointing at a name not in the instance
// (typo in NAME, a renamed worker). Collect every services[].name + DO scriptName
// and assert each is an assembled worker name. Fail loudly before boot.
function preflight() {
  const names = new Set(translated.map((t) => t.name));
  const problems = [];
  for (const { dir, workerOptions } of translated) {
    for (const [binding, val] of Object.entries(workerOptions.serviceBindings ?? {})) {
      if (val && typeof val === 'object' && typeof val.name === 'string' && !names.has(val.name)) {
        problems.push(`${dir}: service binding ${binding} → unknown worker "${val.name}"`);
      }
    }
    for (const [binding, val] of Object.entries(workerOptions.durableObjects ?? {})) {
      const scriptName = val && typeof val === 'object' ? val.scriptName : undefined;
      if (scriptName && !names.has(scriptName)) {
        problems.push(`${dir}: durable object ${binding} → unknown script "${scriptName}"`);
      }
    }
  }
  if (problems.length) {
    console.error('[mf] pre-flight FAILED — cross-worker edges unresolved:');
    for (const p of problems) console.error(`   ✗ ${p}`);
    throw new Error('pre-flight assert failed');
  }
}

// ─── .dev.vars defensive guard + dev:p OAuth offset ──────────────────────────
// The translator already folds workers/auth/.dev.vars (via getVarsForDev) — verified.
// Keep a guard anyway: if the three secrets or the localhost APP_ORIGIN override are
// absent, parse + merge the file ourselves (.dev.vars wins). NEVER log values.
// Then, under dev:p (offset > 0), overwrite APP_ORIGIN/OAUTH_REDIRECT_URI with the
// offset-derived ports (Vite :5180 / auth :8802) so Google's second registered
// redirect URI completes sign-in — makeGoogle reads them from env (never from the
// request, a security invariant), so the orchestrator is the only injection point.
function parseDotEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function ensureAuthDevVars() {
  const auth = translated.find((t) => t.dir === 'auth');
  if (!auth) return;
  const required = ['ANON_SECRET', 'GOOGLE_CLIENT_SECRET', 'OAUTH_PKCE_SECRET'];
  const b = auth.workerOptions.bindings ?? {};
  const folded = required.every((k) => b[k]) && typeof b.APP_ORIGIN === 'string' && b.APP_ORIGIN.includes('localhost');

  // Defensive merge — only when the translator DIDN'T fold .dev.vars. The offset
  // block below runs unconditionally (it must override even a clean fold).
  if (!folded) {
    const devVarsPath = resolve(repoRoot, 'workers/auth/.dev.vars');
    if (existsSync(devVarsPath)) {
      auth.workerOptions.bindings = { ...b, ...parseDotEnv(readFileSync(devVarsPath, 'utf8')) }; // .dev.vars wins
    }
    const missing = required.filter((k) => !auth.workerOptions.bindings?.[k]);
    if (missing.length) {
      console.warn(
        `[mf] auth secrets missing after .dev.vars merge: ${missing.join(', ')} — Google sign-in will 500. Create workers/auth/.dev.vars.`,
      );
    }
  }

  // dev:p (PORT_OFFSET): base .dev.vars APP_ORIGIN/OAUTH_REDIRECT_URI are locked to
  // :3000/:8792. Rewrite to the offset ports so Google's registered :8802 redirect +
  // Vite :5180 complete the round-trip. Same Google client id — both redirect URIs
  // are registered. makeGoogle stays env-only (no request-derivation). Mutates
  // bindings in place, which buildWorkerEntries() re-reads on every hot reload — so
  // this survives reloads exactly like the secret merge above.
  if (offset > 0) {
    const bindings = (auth.workerOptions.bindings ??= {});
    bindings.OAUTH_REDIRECT_URI = `http://localhost:${PORTS.auth + offset}/callback`;
    bindings.APP_ORIGIN = `http://localhost:${parseInt(process.env.VITE_PORT || '3000', 10)}`;
  }
}

// ─── lifecycle ───────────────────────────────────────────────────────────────
// Miniflare registers its own exitHook (SIGINT/SIGTERM/exit) when `miniflare` is
// imported — i.e. BEFORE this module's body runs — and that hook disposes every
// workerd child and exits 0 (verified: clean exit, no orphans), so `concurrently -k`
// tears the session down cleanly. esbuild's shared watch service exits with this
// process too (buildContexts is retained only to keep the contexts from being GC'd
// mid-watch). We just PREPEND a synchronous handler (runs before Miniflare's) to
// surface the shutdown and cancel any pending reload so it can't race the teardown.
function onSignal(signal) {
  console.error(`\n[mf] ${signal} — shutting down (Miniflare disposing workerd)`);
  if (reloadTimer) clearTimeout(reloadTimer);
}
process.prependListener('SIGINT', () => onSignal('SIGINT'));
process.prependListener('SIGTERM', () => onSignal('SIGTERM'));

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
  // 1. Translate every wrangler.jsonc (absolute path so assets/migrations/.dev.vars
  //    resolve against the config dir). externalWorkers is expected empty (all five
  //    co-located here); flatten + warn if a future wrangler bump changes that.
  for (const dir of workerNames) {
    const cfg = resolve(repoRoot, `workers/${dir}/wrangler.jsonc`);
    const { workerOptions, main: entryMain, externalWorkers, define } = unstable_getMiniflareWorkerOptions(cfg);
    if (externalWorkers?.length) {
      console.warn(`[mf] ${dir}: unexpected externalWorkers (${externalWorkers.length}) — wrangler surface may have shifted`);
    }
    translated.push({ dir, name: NAME[dir], main: resolve(repoRoot, entryMain), workerOptions, define: define ?? {} });
  }

  // 2. Fix-ups that must happen before assembly/preflight read the options.
  ensureAuthDevVars();
  preflight();

  // 3. Initial bundles (watch's first build populates `bundles`; mf is still null so
  //    no reload fires). A failed initial build rejects → fatal, surfaced immediately.
  for (const { dir, main: entryMain, define } of translated) {
    await makeContext(dir, entryMain, define);
  }

  // 4. Start ONE instance (main = workers[0] = entry on the top-level port).
  //    No SQLITE_BUSY retry: one process opens the state tree serially, so the
  //    cross-process create race dev-worker.mjs guarded against is gone — a real
  //    error now surfaces immediately.
  mf = new Miniflare(miniflareOptions());
  await mf.ready;

  console.error(`[mf] ${ENTRY.padEnd(7)} -> http://${HOST}:${PORTS[ENTRY] + offset}  (entry worker; WS /sync/*)`);
  for (const { dir, name } of translated) {
    if (dir === ENTRY) continue;
    console.error(`[mf] ${dir.padEnd(7)} -> ${await mf.unsafeGetDirectURL(name)}`);
  }
  console.error(`[mf] inspector -> http://${HOST}:${INSPECTOR_PORT}`);
  console.error('[mf] ready — one instance, all five workers (queues + cross-script DO + service RPC live)');
  console.error('[mf] watching src + packages/*/src for changes (wrangler.jsonc edits need a restart)');
  console.error(
    `[mf] dev logs ON (DEV_LOGS=1): request lines + RPC + Drizzle + DO hibernation · mf log level=${(process.env.MF_LOG_LEVEL ?? 'info').toLowerCase()} (MF_LOG_LEVEL=verbose for more)`,
  );

  // D1 migrations are NOT auto-applied (not by us, not by `wrangler dev`). On a fresh
  // state tree the users D1 has no tables and GET /rooms 500s with "no such table:
  // room_visits". Detect that at startup and print the one-time fix instead of letting
  // it fail cryptically at request time. Non-fatal — wrapped so a probe hiccup can't
  // take the instance down.
  try {
    const db = await mf.getD1Database('DB', NAME.users);
    const hasTable = await db.prepare("select 1 from sqlite_master where type='table' and name='room_visits'").first();
    if (!hasTable) {
      console.warn('[mf] ⚠ users D1 has no tables — dashboard reads will 500 until you run migrations once:');
      console.warn('[mf]   npx wrangler d1 migrations apply avlo-db --local --persist-to .wrangler/state -c workers/users/wrangler.jsonc');
    }
  } catch {
    /* probe is best-effort */
  }
}

main().catch((err) => {
  console.error('[mf] fatal:', err);
  process.exit(1);
});
