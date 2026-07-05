/**
 * Fork boot wrapper — the one place that touches the pyodide loader API.
 * P3 extends this with snapshot restore (`_loadSnapshot` + `_preRestoreHook`)
 * and lazy bundle mounting; P1 is a cold boot of glue+wasm+stdlib from
 * `artifactBase` (dev: /py-dev/fork/ via the pyDevStatic middleware).
 */

// biome-ignore lint/suspicious/noExplicitAny: fork loader has no bundled types in-app
export type Pyodide = any;

export interface PyBootOptions {
  artifactBase: string;
  /** P3: restore payload (container bytes). */
  snapshot?: ArrayBuffer;
}

export async function bootPyodide(opts: PyBootOptions): Promise<Pyodide> {
  // Non-literal specifier: opaque to the typechecker AND to Vite's bundler —
  // resolved at runtime against the served artifact dir.
  const mod = await import(/* @vite-ignore */ `${opts.artifactBase}pyodide.mjs`);
  return mod.loadPyodide({
    indexURL: opts.artifactBase,
    packages: [],
    // Hash determinism parity with make-baseline (heap-behavior consistency;
    // also keeps fresh-boot fallback runs deterministic modulo entropy).
    env: { PYTHONHASHSEED: '0', HOME: '/home/pyodide' },
    ...(opts.snapshot ? { _loadSnapshot: opts.snapshot } : {}),
  });
}
