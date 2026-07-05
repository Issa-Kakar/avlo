/**
 * P0 spike — main-thread gate runner. Loads at /py-spike.html (dev only).
 *
 * P0-A gates (stock or fork dist):
 *   G1 nested spawn + boot + exec        — supervisor→executor topology works
 *   G2 snapshot capture                  — _makeSnapshot boot + makeMemorySnapshot()
 *   G3 snapshot restore in FRESH worker  — _loadSnapshot boots faster, python works
 *   G4 terminate mid-run + respawn       — hard-kill path + cheap respawn-from-snapshot
 *   G5 interrupt buffer                  — SIGINT breaks `while True` < 200 ms
 *
 * P0-B gates (fork only — THE design-freezing unknown):
 *   G6   fork boot + baseline avlo meta (+ ctypes probe: EXPECTED-FAIL pre-Step3)
 *   G6.5 dsoBaseHook liveness (1 .so → loadOrder length 1)
 *   G7   numpy record — every wheel .so loadDynlib'd, import works, meta stacked
 *   G8   numpy replay — _preRestoreHook(avlo, Module) restore, baked pointers live
 *   G8R  RNG determinism — identical legacy state across restores; reseed differs
 *   G9   negative — rotated DSO replay order throws table drift
 *   BLIT in-place heap reset — globals gone, numpy still works
 */

const logEl = document.getElementById('log') as HTMLPreElement;
const log = (s: string) => {
  logEl.textContent += `${s}\n`;
  // eslint-disable-next-line no-console
  console.log(`[py-spike] ${s}`);
};

interface SupMsg {
  t: string;
  // biome-ignore lint/suspicious/noExplicitAny: spike-only loose message bag
  [k: string]: any;
}

type Dist = 'stock' | 'fork';

let sup: Worker | null = null;
let waiters: Array<{ match: (m: SupMsg) => boolean; resolve: (m: SupMsg) => void }> = [];

function send(msg: unknown): void {
  sup?.postMessage(msg);
}
function waitFor(match: (m: SupMsg) => boolean, timeoutMs = 180_000): Promise<SupMsg> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting (${timeoutMs}ms)`)), timeoutMs);
    waiters.push({
      match,
      resolve: (m) => {
        clearTimeout(timer);
        resolve(m);
      },
    });
  });
}

let execId = 0;
async function exec(code: string, interruptAfterMs?: number): Promise<SupMsg> {
  const id = ++execId;
  send({ t: 'exec', id, code, interruptAfterMs });
  return waitFor((m) => m.t === 'exec-result' && m.id === id);
}
async function execJson<T>(code: string): Promise<T> {
  const r = await exec(code);
  if (!r.ok) throw new Error(`exec failed: ${r.error}`);
  return JSON.parse(r.repr) as T;
}

async function spawn(): Promise<void> {
  send({ t: 'spawn' });
  await waitFor((m) => m.t === 'spawned');
}
async function bootFresh(dist: Dist): Promise<SupMsg> {
  await spawn();
  send({ t: 'boot', mode: 'fresh', dist });
  return waitFor((m) => m.t === 'ready' || m.t === 'boot-error');
}
async function bootSnapshot(
  dist: Dist,
  which: 'baseline' | 'stacked',
  opts: { withTree?: boolean; rotate?: boolean } = {},
): Promise<SupMsg> {
  await spawn();
  send({ t: 'boot', mode: 'snapshot', dist, which, ...opts });
  return waitFor((m) => m.t === 'ready' || m.t === 'boot-error');
}

function freshSupervisor(): void {
  waiters = [];
  sup?.terminate();
  sup = new Worker(new URL('./py-spike-supervisor.ts', import.meta.url), { type: 'module' });
  sup.onmessage = (e: MessageEvent<SupMsg>) => {
    const m = e.data;
    const i = waiters.findIndex((w) => w.match(m));
    if (i >= 0) {
      const [w] = waiters.splice(i, 1);
      w.resolve(m);
    } else if (m.t === 'fatal' || m.t === 'executor-error' || m.t === 'boot-error') {
      log(`!! unmatched error: ${JSON.stringify(m)}`);
    }
  };
}

const results: Record<string, string> = {};

function finish(): void {
  log('');
  log(
    `RESULT ${Object.entries(results)
      .map(([k, v]) => `${k}=${v.split(' ')[0]}`)
      .join(' ')}`,
  );
  (document.getElementById('summary') as HTMLElement).textContent = JSON.stringify(results);
}

// ---------------------------------------------------------------- P0-A gates

async function runP0A(dist: Dist): Promise<void> {
  logEl.textContent = '';
  for (const k of Object.keys(results)) delete results[k];
  freshSupervisor();
  try {
    await waitFor((m) => m.t === 'supervisor-ready');
    log(`supervisor up; dist=${dist}`);

    const ready1 = await bootFresh(dist);
    log(`G1 fresh boot: import ${ready1.importMs.toFixed(0)}ms, boot ${ready1.bootMs.toFixed(0)}ms`);
    const r1 = await exec('1 + 1');
    results.G1 = r1.ok && r1.repr === '2' ? 'PASS' : `FAIL (${JSON.stringify(r1)})`;
    log(`G1 nested-spawn+exec: ${results.G1}`);

    await exec('x = 41');
    send({ t: 'capture', slot: 'baseline' });
    const snap = await waitFor((m) => m.t === 'snapshot-held');
    results.G2 = snap.size > 1_000_000 ? 'PASS' : `FAIL (size=${snap.size})`;
    log(`G2 capture: ${results.G2} — ${(snap.size / 1e6).toFixed(1)} MB in ${snap.ms.toFixed(0)}ms, meta=${JSON.stringify(snap.avlo)}`);

    const ready3 = await bootSnapshot(dist, 'baseline');
    const r3a = await exec('import sys; sys.version.split()[0]');
    const r3b = await exec('x');
    const r3c = await exec('1 + 1');
    const restoreOk = r3a.ok && r3b.ok && r3b.repr === '41' && r3c.repr === '2';
    results.G3 = restoreOk ? 'PASS' : `FAIL (${JSON.stringify([r3a, r3b, r3c])})`;
    log(`G3 restore: ${results.G3} — boot ${ready3.bootMs.toFixed(0)}ms (fresh was ${ready1.bootMs.toFixed(0)}ms), python ${r3a.repr}`);

    send({ t: 'exec', id: ++execId, code: 'while True: pass' });
    await new Promise((r) => setTimeout(r, 300));
    send({ t: 'terminate' });
    await waitFor((m) => m.t === 'terminated');
    const t4 = performance.now();
    await bootSnapshot(dist, 'baseline');
    const r4 = await exec('1 + 1');
    const respawnMs = performance.now() - t4;
    results.G4 = r4.ok && r4.repr === '2' ? 'PASS' : `FAIL (${JSON.stringify(r4)})`;
    log(`G4 kill+respawn: ${results.G4} — respawn-from-snapshot ${respawnMs.toFixed(0)}ms`);

    const r5 = await exec('while True: pass', 100);
    const interrupted = !r5.ok && /KeyboardInterrupt/.test(r5.error);
    const fast = r5.msSinceInterrupt !== undefined && r5.msSinceInterrupt < 200;
    results.G5 = interrupted && fast ? 'PASS' : `FAIL (${JSON.stringify(r5)})`;
    log(`G5 interrupt: ${results.G5} — KeyboardInterrupt ${r5.msSinceInterrupt?.toFixed(0)}ms after SIGINT write`);
  } catch (err) {
    log(`!! aborted: ${String(err)}`);
  }
  finish();
}

// ---------------------------------------------------------------- P0-B gates

const CTYPES_PROBE = `
import json
try:
    import _ctypes
    r = 'importable'
except ImportError:
    r = 'blocked'
json.dumps(r)
`;
const NUMPY_SUM = 'import numpy; float(numpy.ones(4).sum())';
const LAZY_SUBMODULE = `
import json, sys
cands = ['numpy.testing', 'numpy.f2py', 'numpy.matlib', 'numpy.ma']
target = next((c for c in cands if c not in sys.modules), None)
ok = False
if target is not None:
    __import__(target)
    ok = target in sys.modules
json.dumps({'target': target, 'ok': ok})
`;
const RNG_STATE = 'import json, numpy; json.dumps(numpy.random.get_state()[1][:8].tolist())';
const RNG_RESEED = `
import json, os, numpy
numpy.random.seed(int.from_bytes(os.urandom(4), 'little'))
json.dumps(numpy.random.get_state()[1][:8].tolist())
`;

async function runP0B(): Promise<void> {
  logEl.textContent = '';
  for (const k of Object.keys(results)) delete results[k];
  freshSupervisor();
  try {
    await waitFor((m) => m.t === 'supervisor-ready');
    log('supervisor up; P0-B fork gates');

    // ---- Session A: fresh fork boot → record numpy → capture stacked
    const readyA = await bootFresh('fork');
    if (readyA.t === 'boot-error') throw new Error(`fork boot failed: ${readyA.error}`);
    const zipHash = readyA.zipHash as string;
    log(`A fork fresh boot ${readyA.bootMs.toFixed(0)}ms, stdlib.zip ${zipHash.slice(0, 12)}…`);

    const ctypes = await execJson<string>(CTYPES_PROBE);
    results.G6ctypes = ctypes === 'blocked' ? 'PASS' : 'EXPECTED-FAIL(pre-Step3-rebuild)';
    log(`G6 ctypes probe: ${ctypes} → ${results.G6ctypes}`);

    send({ t: 'capture', slot: 'baseline' });
    const base = await waitFor((m) => m.t === 'snapshot-held' && m.slot === 'baseline');
    const baseOk = base.avlo?.version === 1 && base.avlo?.snapshotType === 'baseline' && base.avlo?.loadOrderLen === 0;
    results.G6 = baseOk ? 'PASS' : `FAIL (${JSON.stringify(base.avlo)})`;
    log(`G6 baseline meta: ${results.G6} — ${(base.size / 1e6).toFixed(1)} MB, meta=${JSON.stringify(base.avlo)}`);

    send({ t: 'numpy-record' });
    const rec = await waitFor((m) => m.t === 'numpy-recorded');
    results['G6.5'] = rec.g65LoadOrderLen === 1 ? 'PASS' : `FAIL (loadOrder=${rec.g65LoadOrderLen})`;
    log(`G6.5 hook liveness: ${results['G6.5']}`);
    const recOk = rec.sum === 4 && rec.loadOrderLen === rec.soCount;
    results.G7 = recOk ? 'PASS' : `FAIL (sum=${rec.sum} loadOrder=${rec.loadOrderLen}/${rec.soCount})`;
    log(`G7 numpy record: ${results.G7} — ${rec.soCount} .so, tree ${rec.treeFiles} files ${(rec.treeBytes / 1e6).toFixed(1)} MB`);

    await exec('x = 41');
    send({ t: 'capture', slot: 'stacked' });
    const stk = await waitFor((m) => m.t === 'snapshot-held' && m.slot === 'stacked');
    const stkOk = stk.avlo?.snapshotType === 'stacked' && stk.avlo?.loadOrderLen === rec.soCount && stk.avlo?.dsoHandleCount > 0;
    results.G7meta = stkOk ? 'PASS' : `FAIL (${JSON.stringify(stk.avlo)})`;
    log(
      `G7 stacked capture: ${results.G7meta} — ${(stk.size / 1e6).toFixed(1)} MB in ${stk.ms.toFixed(0)}ms, meta=${JSON.stringify(stk.avlo)}`,
    );

    // ---- Session B: restore stacked in a fresh worker
    const readyB = await bootSnapshot('fork', 'stacked', { withTree: true });
    if (readyB.t === 'boot-error') throw new Error(`G8 restore failed: ${readyB.error}`);
    if (readyB.zipHash !== zipHash) throw new Error('stdlib.zip drifted mid-spike — recapture required');
    // RNG state read FIRST — later execs (numpy.testing import) consume draws.
    const s1 = (await exec(RNG_STATE)).repr as string;
    const rSum = await exec(NUMPY_SUM);
    const lazy = await execJson<{ target: string | null; ok: boolean }>(LAZY_SUBMODULE);
    const rX = await exec('x');
    const g8Ok = rSum.ok && rSum.repr === '4' && rX.repr === '41' && (lazy.target === null || lazy.ok);
    results.G8 = g8Ok ? 'PASS' : `FAIL (sum=${JSON.stringify(rSum)} x=${rX.repr} lazy=${JSON.stringify(lazy)})`;
    log(`G8 replay: ${results.G8} — restore-boot ${readyB.bootMs.toFixed(0)}ms, lazy import ${lazy.target ?? 'n/a(all eager)'}`);

    // ---- Session C: second restore — RNG determinism, reseed, blit reset
    const readyC = await bootSnapshot('fork', 'stacked', { withTree: true });
    if (readyC.t === 'boot-error') throw new Error(`G8R restore failed: ${readyC.error}`);
    const s2 = (await exec(RNG_STATE)).repr as string;
    const s3 = (await exec(RNG_RESEED)).repr as string;
    results.G8R = s1 === s2 && s3 !== s1 ? 'PASS' : `FAIL (det=${s1 === s2} reseed=${s3 !== s1})`;
    log(`G8R rng: ${results.G8R} — legacy state identical across restores, explicit reseed differs`);
    if (s1 !== s2) log(`G8R debug: s1=${s1.slice(0, 100)} s2=${s2.slice(0, 100)}`);

    send({ t: 'blit-test' });
    const blit = await waitFor((m) => m.t === 'blit-result');
    results.BLIT = blit.ok ? 'PASS' : `FAIL (${JSON.stringify(blit)})`;
    log(`BLIT reset: ${results.BLIT} — ${blit.blitMs?.toFixed(1)}ms for ${(blit.imageLen / 1e6).toFixed(1)} MB image`);

    // ---- Session D: negative — rotated replay order must throw table drift
    const readyD = await bootSnapshot('fork', 'stacked', { withTree: true, rotate: true });
    const drifted = readyD.t === 'boot-error' && /table drift|no recorded bases/.test(readyD.error);
    results.G9 = drifted ? 'PASS' : `FAIL (${readyD.t}: ${String(readyD.error).slice(0, 200)})`;
    log(`G9 rotated replay: ${results.G9}`);

    send({ t: 'terminate' });
    await waitFor((m) => m.t === 'terminated');
  } catch (err) {
    log(`!! aborted: ${String(err)}`);
  }
  finish();
}

document.getElementById('run')?.addEventListener('click', () => void runP0A('stock'));
document.getElementById('run-fork')?.addEventListener('click', () => void runP0A('fork'));
document.getElementById('run-p0b')?.addEventListener('click', () => void runP0B());
log(`crossOriginIsolated: ${crossOriginIsolated}`);
