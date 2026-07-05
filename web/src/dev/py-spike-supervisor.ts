/**
 * P0 spike — SUPERVISOR worker.
 *
 * Proves the production topology: this worker spawns/terminates the NESTED
 * executor worker, owns the interrupt SAB (writable while the executor's event
 * loop is blocked in synchronous Python), holds captured snapshot bytes + the
 * recorded site-packages tree, and relays exec results to main. Wall-clock
 * actions (interrupt-after-N-ms) live here because the executor cannot
 * service timers mid-run.
 *
 * P0-B additions: two snapshot slots (baseline/stacked), avlo-meta parsing at
 * capture time, and stacked-restore boots that hand the executor a COPY of
 * snapshot + tree (originals stay here for repeat restores — G8/G9 reuse).
 */

import { copyTree, type FsTree, parseSnapshotHeader, treeTransferables } from './py-spike-snap';

type Slot = 'baseline' | 'stacked';

interface BootMsg {
  t: 'boot';
  mode: 'fresh' | 'snapshot';
  dist?: 'stock' | 'fork';
  which?: Slot;
  withTree?: boolean;
  rotate?: boolean;
}
interface ExecMsg {
  t: 'exec';
  id: number;
  code: string;
  /** Write SIGINT (2) into the interrupt buffer this many ms after dispatch. */
  interruptAfterMs?: number;
}
type InMsg =
  | { t: 'spawn' }
  | BootMsg
  | ExecMsg
  | { t: 'capture'; slot: Slot }
  | { t: 'numpy-record' }
  | { t: 'blit-test' }
  | { t: 'terminate' };

function post(msg: unknown, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

let executor: Worker | null = null;
const snapshots = new Map<Slot, ArrayBuffer>();
let tree: FsTree | null = null;
/**
 * FRESH SAB PER SPAWN — load-bearing. Worker.terminate() on an executor
 * blocked in a wasm busy loop closes its message port immediately but the
 * thread keeps spinning until its next yield point; until then the zombie's
 * Python signal check keeps CONSUMING SIGINT bytes from a shared buffer,
 * silently stealing the next executor's first interrupt (found empirically:
 * fork suite G5 hang). A per-spawn SAB isolates each generation.
 */
let interruptSab = new SharedArrayBuffer(4);
let interruptView = new Uint8Array(interruptSab);
let interruptWrittenAt = 0;
let interruptRepeat: ReturnType<typeof setInterval> | null = null;

function stopInterruptRepeat(): void {
  if (interruptRepeat !== null) {
    clearInterval(interruptRepeat);
    interruptRepeat = null;
  }
}

function wireExecutor(w: Worker): void {
  w.onmessage = (e: MessageEvent) => {
    const m = e.data;
    if (m.t === 'snapshot') {
      // Snapshot bytes STAY in the supervisor (production design) — main gets
      // stats + the parsed avlo meta for gate asserts.
      const bytes = m.bytes as ArrayBuffer;
      snapshots.set(m.slot as Slot, bytes);
      const parsed = parseSnapshotHeader(new Uint8Array(bytes));
      post({
        t: 'snapshot-held',
        slot: m.slot,
        size: m.size,
        ms: m.ms,
        payloadOffset: parsed.payloadOffset,
        avlo: parsed.avlo && {
          version: parsed.avlo.version,
          snapshotType: parsed.avlo.snapshotType,
          loadOrderLen: parsed.avlo.dso.loadOrder.length,
          dsoHandleCount: Object.keys(parsed.avlo.dsoHandles).length,
          heapSize: parsed.avlo.heapSize,
        },
      });
      return;
    }
    if (m.t === 'numpy-recorded') {
      // Tree custody transfers here; main gets the stats only.
      tree = m.tree as FsTree;
      const { tree: _drop, ...stats } = m;
      post(stats);
      return;
    }
    if (m.t === 'exec-result') {
      stopInterruptRepeat();
      if (interruptWrittenAt > 0) {
        m.msSinceInterrupt = performance.now() - interruptWrittenAt;
        interruptWrittenAt = 0;
      }
    }
    post(m);
  };
  w.onerror = (e: ErrorEvent) => post({ t: 'executor-error', error: e.message });
}

self.onmessage = (e: MessageEvent<InMsg>) => {
  const m = e.data;
  switch (m.t) {
    case 'spawn': {
      executor?.terminate();
      stopInterruptRepeat();
      interruptSab = new SharedArrayBuffer(4); // never reuse across generations
      interruptView = new Uint8Array(interruptSab);
      executor = new Worker(new URL('./py-spike-executor.ts', import.meta.url), {
        type: 'module',
      });
      wireExecutor(executor);
      post({ t: 'spawned' });
      break;
    }
    case 'boot': {
      if (!executor) {
        post({ t: 'fatal', error: 'boot before spawn' });
        break;
      }
      const dist = m.dist ?? 'stock';
      if (m.mode === 'snapshot') {
        const held = snapshots.get(m.which ?? 'baseline');
        if (!held) {
          post({ t: 'fatal', error: `no ${m.which ?? 'baseline'} snapshot held` });
          break;
        }
        // Transfer COPIES so the supervisor keeps originals for reuse.
        const snapCopy = held.slice(0);
        const transfer: Transferable[] = [snapCopy];
        let treeCopy: FsTree | undefined;
        if (m.withTree) {
          if (!tree) {
            post({ t: 'fatal', error: 'no tree held' });
            break;
          }
          treeCopy = copyTree(tree);
          transfer.push(...treeTransferables(treeCopy));
        }
        executor.postMessage(
          {
            t: 'boot',
            mode: 'snapshot',
            dist,
            snapshot: snapCopy,
            tree: treeCopy,
            rotate: m.rotate,
            interruptSab,
          },
          transfer,
        );
      } else {
        executor.postMessage({ t: 'boot', mode: 'fresh', dist, interruptSab });
      }
      break;
    }
    case 'exec': {
      if (!executor) {
        post({ t: 'fatal', error: 'exec before spawn' });
        break;
      }
      interruptWrittenAt = 0;
      stopInterruptRepeat();
      executor.postMessage({ t: 'exec', id: m.id, code: m.code });
      if (m.interruptAfterMs !== undefined) {
        // Repeat-write until acknowledged (production soft-cancel behavior):
        // converts any one-shot signal swallow into ≤50 ms extra latency.
        const view = interruptView;
        setTimeout(() => {
          interruptWrittenAt = performance.now();
          Atomics.store(view as unknown as Uint8Array<SharedArrayBuffer>, 0, 2);
          interruptRepeat = setInterval(() => {
            Atomics.store(view as unknown as Uint8Array<SharedArrayBuffer>, 0, 2);
          }, 50);
        }, m.interruptAfterMs);
      }
      break;
    }
    case 'capture': {
      executor?.postMessage({ t: 'capture', slot: m.slot });
      break;
    }
    case 'numpy-record': {
      executor?.postMessage({ t: 'numpy-record' });
      break;
    }
    case 'blit-test': {
      executor?.postMessage({ t: 'blit-test' });
      break;
    }
    case 'terminate': {
      executor?.terminate();
      executor = null;
      stopInterruptRepeat();
      post({ t: 'terminated' });
      break;
    }
  }
};

post({ t: 'supervisor-ready', nestedWorkerSupported: typeof Worker !== 'undefined' });
