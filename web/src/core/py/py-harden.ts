/**
 * Executor realm hardening — the AUTHORITATIVE isolation layer (A1). The
 * executor is a SAME-ORIGIN dedicated worker: no iframe, no origin boundary,
 * so its realm is born with the origin's full ambient authority (network,
 * IndexedDB room docs, SW caches, OPFS via navigator.storage, nested-worker
 * spawning). Everything here runs ONCE, after boot + bundle mounts and before
 * the harness installs, and removes that authority outright: an API deleted
 * from the realm — own properties AND prototype-chain definitions — reads as
 * `undefined` through the fork's `js` proxy and stays unreachable even if the
 * Python-side meta_path guard (defense-in-depth) is stripped by user code.
 *
 * Posture: remove AUTHORITY, not code execution. eval/Function stay — they
 * are unblockable in-language (any function's `.constructor` chain reaches
 * Function) and dynamically-evaluated JS with no I/O surface has nothing to
 * exfiltrate with; prod CSP additionally pins script/wasm sources.
 *
 * Fail-closed: same-origin execution (no iframe) makes this scrub THE authority
 * boundary, not defense-in-depth — so an enumeration that silently no-ops (a
 * non-configurable accessor on some engine, or a name we never listed) must
 * abort the boot rather than run unconfined. `assertRealmHardened()` re-reads
 * the realm after scrub+freeze and THROWS on any survivor; the executor calls
 * it inside its boot try, so a breach becomes `exec-fatal` (no harness, no
 * runs). This file is dependency-free and worker-agnostic so the Node
 * verification harness can exercise the exact shipped code against a real fork
 * boot.
 */

/** Globals stripped from the executor realm after boot. Grouped by the
 * authority they carry; names absent in a given engine are skipped, so
 * speculative/near-future entries are free insurance. */
export const SCRUBBED_GLOBALS: readonly string[] = Object.freeze([
  // Network egress — every request-capable API exposed to dedicated workers.
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'WebSocketStream',
  'EventSource',
  'WebTransport',
  // WebRTC — a peer connection / data channel is raw egress that connect-src
  // CSP does NOT govern, so the scrub is the only thing that can stop it.
  // Window-only in today's engines (absent in a dedicated worker ⇒ skipped),
  // listed as free insurance the day an engine exposes it to workers.
  'RTCPeerConnection',
  'RTCDataChannel',
  // Fresh-realm escapes: a nested Worker/SharedWorker (or importScripts pull)
  // would boot a NEW realm with all of the above restored.
  'Worker',
  'SharedWorker',
  'importScripts',
  // Origin-scoped storage + device authority: indexedDB holds the y-indexeddb
  // room docs, caches is the SW shell/asset cache (poisonable), navigator
  // carries OPFS (.storage), locks, and GPU in one accessor.
  'indexedDB',
  'caches',
  'cookieStore',
  'navigator',
  // Cross-context signalling to any same-origin listener.
  'BroadcastChannel',
]);

/** Remove a binding wherever it lives on the prototype chain. Strict-mode
 * safe: `delete` on a non-configurable own property throws, so fall back to
 * overwriting with undefined when an engine pins the descriptor. */
function removeBinding(name: string): void {
  for (let o: object | null = globalThis; o !== null; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, name);
    if (!d) continue;
    if (d.configurable) delete (o as Record<string, unknown>)[name];
    else if (d.writable) (o as Record<string, unknown>)[name] = undefined;
  }
}

export function scrubWorkerScope(): void {
  for (const name of SCRUBBED_GLOBALS) removeBinding(name);
}

/**
 * Post-boot wasm + intrinsic hygiene. All wasm compilation is done by the
 * time this runs — bundle DSOs load during mount, snapshot restore (P3)
 * happens inside bootPyodide, blit reset never recompiles, and a different
 * bundle set means a brand-new worker — so the compile surface goes away
 * entirely: user code can never compile or instantiate NEW wasm in this
 * realm, even where CSP allows wasm-unsafe-eval. Memory/Table/Global/Tag/
 * Exception and the error types stay: the live instance and Emscripten's
 * wasm-EH paths use them at runtime.
 *
 * Then the intrinsics the run protocol flows through are frozen, so no run
 * can poison them for the runs that follow in the same generation (the
 * interpreter is shared until P3's blit reset): JSON.parse authenticates
 * harness results, Atomics carries PY_SAB state, and every message crosses
 * the frozen prototypes. Pyodide only ever READS these post-boot — verified
 * by the py-build Node harness against a real fork boot + numpy mount.
 */
export function hardenRealm(): void {
  for (const name of ['compile', 'compileStreaming', 'instantiate', 'instantiateStreaming', 'Module']) {
    const d = Object.getOwnPropertyDescriptor(WebAssembly, name);
    if (d?.configurable) delete (WebAssembly as unknown as Record<string, unknown>)[name];
  }
  const intrinsics: object[] = [
    Object,
    Object.prototype,
    Array,
    Array.prototype,
    Function.prototype,
    String.prototype,
    Number.prototype,
    Boolean.prototype,
    RegExp.prototype,
    Date,
    Date.prototype,
    Error.prototype,
    Promise,
    Promise.prototype,
    ArrayBuffer.prototype,
    SharedArrayBuffer.prototype,
    Uint8Array.prototype,
    Object.getPrototypeOf(Uint8Array), // %TypedArray%
    Object.getPrototypeOf(Uint8Array.prototype), // %TypedArray%.prototype
    TextDecoder.prototype,
    TextEncoder.prototype,
    JSON,
    Math,
    Reflect,
    Atomics,
    WebAssembly,
  ];
  for (const o of intrinsics) Object.freeze(o);
}

/** WebAssembly names hardenRealm() removes — re-checked absent by the gate. */
const WASM_COMPILE_SURFACE: readonly string[] = ['compile', 'compileStreaming', 'instantiate', 'instantiateStreaming', 'Module'];

/**
 * Fail-closed verification of the two functions above. Runs once, after both,
 * before the harness installs and before any user code — over frozen intrinsics
 * that nothing has had a chance to tamper with. Throws (⇒ executor exec-fatal ⇒
 * no runs) if ANY scrubbed global is still reachable, the wasm compile surface
 * survived, or the protocol intrinsics aren't frozen. The whole SCRUBBED_GLOBALS
 * list is asserted: names absent in the engine read undefined and pass for free,
 * so a survivor is always a real breach — a `delete` that no-op'd on a
 * non-configurable accessor, or (once) a name the list forgot.
 */
export function assertRealmHardened(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const survivors = SCRUBBED_GLOBALS.filter((name) => g[name] !== undefined);
  if (survivors.length > 0) {
    throw new Error(`realm hardening incomplete — still reachable after scrub: ${survivors.join(', ')}`);
  }
  const wasm = WebAssembly as unknown as Record<string, unknown>;
  const compileSurvivors = WASM_COMPILE_SURFACE.filter((name) => wasm[name] !== undefined);
  if (compileSurvivors.length > 0) {
    throw new Error(`realm hardening incomplete — WebAssembly compile surface present: ${compileSurvivors.join(', ')}`);
  }
  // Sample the freeze: hardenRealm freezes in one straight-line loop, so any one
  // still mutable means it never ran (or was reverted before this gate).
  if (!(Object.isFrozen(JSON) && Object.isFrozen(Atomics) && Object.isFrozen(Object.prototype) && Object.isFrozen(Array.prototype))) {
    throw new Error('realm hardening incomplete — protocol intrinsics not frozen');
  }
}
