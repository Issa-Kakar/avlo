/**
 * Boot/run tracing (Phase 0 of the runtime redesign) — always-on and
 * dependency-free. Each worker (supervisor, executor) buffers named spans in
 * its own module instance, mirrors them into `performance.measure` (visible
 * in the DevTools Performance lane), and emits ONE
 * `console.info('py:trace', <json>)` line per boot / per run. The ledger in
 * `packages/py-build/NOTES.md` is built from those lines — span names are the
 * cross-phase comparison keys, keep them stable.
 *
 * The wasm shims split "compile+instantiate" out of loadPyodide/DSO-replay
 * without patching the glue: installed for the boot window only, and MUST be
 * uninstalled before scrub/harden (a surviving wrapper on the compile surface
 * would be deleted by hardenRealm anyway, but `WebAssembly.Instance` is not
 * on the delete list and must not stay wrapped in the hardened realm).
 */

type SpanMeta = Record<string, string | number | boolean>;

interface Span {
  n: string;
  /** Start offset from the trace anchor (ms). */
  at: number;
  ms: number;
  [k: string]: string | number | boolean;
}

let spans: Span[] = [];
let anchor = performance.now();
let seq = 0;

const r1 = (x: number): number => Math.round(x * 10) / 10;

/** Re-anchor offsets + drop buffered spans (start of a boot or a run). */
export function traceReset(): void {
  spans = [];
  anchor = performance.now();
}

/** Record an externally-timed span (absolute performance.now() bounds). */
export function traceAdd(n: string, start: number, end: number, meta?: SpanMeta): void {
  try {
    performance.measure(`py:${n}`, { start, end });
  } catch {
    /* engine without options-form measure — the JSON line still carries it */
  }
  spans.push({ n, at: r1(start - anchor), ms: r1(end - start), ...meta });
}

/** Begin a span; the returned closer records it (optionally with meta). */
export function traceBegin(n: string): (meta?: SpanMeta) => void {
  const start = performance.now();
  return (meta) => traceAdd(n, start, performance.now(), meta);
}

export function traceSpan<T>(n: string, fn: () => T): T {
  const end = traceBegin(n);
  try {
    return fn();
  } finally {
    end();
  }
}

export async function traceSpanAsync<T>(n: string, fn: () => Promise<T>): Promise<T> {
  const end = traceBegin(n);
  try {
    return await fn();
  } finally {
    end();
  }
}

let sink: ((line: string) => void) | null = null;

/** Route emitted lines to a relay instead of this realm's console — workers
 * forward up the chain so the main thread owns the single visible
 * `console.info('py:trace', …)` line (worker consoles are invisible to
 * automation and easy to miss in DevTools). Unset → log here. */
export function setTraceSink(fn: (line: string) => void): void {
  sink = fn;
}

/** Emit the buffered spans as ONE parseable JSON line, then reset. */
export function traceEmit(th: 'sup' | 'exec', kind: string, extra?: Record<string, unknown>): void {
  const line = JSON.stringify({ th, kind, seq: seq++, ...extra, spans });
  if (sink) {
    try {
      sink(line);
    } catch {
      // biome-ignore lint/suspicious/noConsole: the always-on trace channel (fallback when the relay breaks)
      console.info('py:trace', line);
    }
  } else {
    // biome-ignore lint/suspicious/noConsole: the always-on trace channel (no relay installed in this realm)
    console.info('py:trace', line);
  }
  traceReset();
}

// ------------------------------------------------------------- wasm timers

interface WasmAgg {
  n: number;
  ms: number;
}

export interface WasmTimers {
  /** Rounded per-entry aggregates for entries that fired (count + total ms). */
  collect(): Record<string, WasmAgg>;
  /** Restore the originals — call before scrubWorkerScope/hardenRealm. */
  uninstall(): void;
}

export function installWasmTimers(): WasmTimers {
  const aggs: Record<string, WasmAgg> = {};
  const restores: Array<() => void> = [];
  // biome-ignore lint/suspicious/noExplicitAny: shimming the live WebAssembly namespace
  const WA = WebAssembly as any;
  const agg = (key: string): WasmAgg => {
    aggs[key] ??= { n: 0, ms: 0 };
    return aggs[key];
  };

  const wrapAsync = (key: 'instantiateStreaming' | 'compileStreaming' | 'instantiate' | 'compile'): void => {
    const orig = WA[key];
    if (typeof orig !== 'function') return;
    const a = agg(key);
    WA[key] = (...args: unknown[]) => {
      const start = performance.now();
      return Promise.resolve(Reflect.apply(orig, WebAssembly, args)).finally(() => {
        a.n++;
        a.ms += performance.now() - start;
      });
    };
    restores.push(() => {
      WA[key] = orig;
    });
  };
  const wrapCtor = (key: 'Module' | 'Instance'): void => {
    const orig = WA[key];
    if (typeof orig !== 'function') return;
    const a = agg(key);
    WA[key] = new Proxy(orig, {
      construct(target, args) {
        const start = performance.now();
        try {
          return Reflect.construct(target, args);
        } finally {
          a.n++;
          a.ms += performance.now() - start;
        }
      },
    });
    restores.push(() => {
      WA[key] = orig;
    });
  };

  wrapAsync('instantiateStreaming');
  wrapAsync('compileStreaming');
  wrapAsync('instantiate');
  wrapAsync('compile');
  wrapCtor('Module');
  wrapCtor('Instance');

  return {
    collect() {
      const out: Record<string, WasmAgg> = {};
      for (const [k, v] of Object.entries(aggs)) {
        if (v.n > 0) out[k] = { n: v.n, ms: r1(v.ms) };
      }
      return out;
    },
    uninstall() {
      for (const restore of restores) restore();
      restores.length = 0;
    },
  };
}
