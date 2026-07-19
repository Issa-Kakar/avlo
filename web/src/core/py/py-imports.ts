/**
 * Import detection + availability gate — pure functions, run once per click
 * on the snapshotted block source (main thread, sync).
 *
 * A snippet importing something we can't provide must refuse BEFORE any
 * download or boot (one 'unavailable' commit, zero fetches). Docstrings and
 * comments must NOT trigger detection (a docstring mentioning "import
 * tensorflow" is not an import), so the scanner tracks triple-quote state
 * across lines instead of naive regexing. Dynamic __import__ escapes
 * detection and fails naturally at runtime — accepted.
 */

import type { PySetKey } from './py-protocol';
import { AVAILABLE_PACKAGES as GEN_AVAILABLE, PACKAGE_TO_SET, SET_BUNDLES, STDLIB_MODULES } from './py-stdlib-modules.gen';

export const AVAILABLE_PACKAGES: ReadonlySet<string> = GEN_AVAILABLE;

export interface PyImportResolution {
  setKey: PySetKey;
  /** Import names we cannot provide — non-empty means refuse pre-boot. */
  missing: string[];
}

/** Extract top-level imported module names from Python source. */
export function scanPythonImports(source: string): string[] {
  const names = new Set<string>();
  // Join explicit line continuations first: `import a, \` + `    b`.
  const joined = source.replace(/\\\r?\n/g, ' ');
  let tq: '"""' | "'''" | null = null; // triple-quote state across lines
  for (const rawLine of joined.split('\n')) {
    let line = rawLine;
    if (tq) {
      const end = line.indexOf(tq);
      if (end < 0) continue;
      line = line.slice(end + 3);
      tq = null;
    }
    // Strip string literals + comments left-to-right so a trailing docstring
    // opener carries into the next lines.
    let out = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '#') break;
      if (c === '"' || c === "'") {
        const triple = line.slice(i, i + 3);
        if (triple === '"""' || triple === "'''") {
          const end = line.indexOf(triple, i + 3);
          if (end < 0) {
            tq = triple;
            i = line.length;
          } else {
            i = end + 2;
          }
        } else {
          let j = i + 1;
          while (j < line.length && line[j] !== c) {
            if (line[j] === '\\') j++;
            j++;
          }
          i = j;
        }
        continue;
      }
      out += c;
    }
    // Split compound statements (`import os; from x import y`) — safe on the
    // STRIPPED line only: a `;` inside a string literal is already gone.
    for (const stmt of out.split(';')) {
      const m = /^\s*(?:import\s+(.+)|from\s+([A-Za-z_][\w.]*)\s+import\b)/.exec(stmt);
      if (!m) continue;
      if (m[2] !== undefined) {
        names.add(m[2].split('.')[0]);
      } else {
        // `import a.b as x, c` — split on commas, take each root.
        for (const part of m[1].split(',')) {
          const name = /^\s*([A-Za-z_][\w.]*)/.exec(part)?.[1];
          if (name) names.add(name.split('.')[0]);
        }
      }
    }
  }
  return [...names];
}

/** Sets ordered smallest-first for the upward merge below. */
const SET_KEYS_BY_SIZE = Object.freeze(
  (Object.keys(SET_BUNDLES) as (keyof typeof SET_BUNDLES)[]).sort((a, b) => SET_BUNDLES[a].length - SET_BUNDLES[b].length),
);

/**
 * Resolve scanned imports to a bundle set key or a refusal.
 * `availablePackages` is what the current staged artifacts actually provide
 * (generated AVAILABLE_PACKAGES; the parameter stays for unit-testability).
 * Multi-package needs merge upward by bundle union — the smallest configured
 * set covering every required bundle wins (pandas + matplotlib ⇒ 'all').
 */
export function resolveImports(modules: string[], availablePackages: ReadonlySet<string>): PyImportResolution {
  const missing: string[] = [];
  const neededBundles = new Set<string>();
  for (const m of modules) {
    if (STDLIB_MODULES.has(m)) continue;
    const set = PACKAGE_TO_SET[m];
    if (set === undefined || !availablePackages.has(m)) {
      missing.push(m);
      continue;
    }
    for (const b of SET_BUNDLES[set]) neededBundles.add(b);
  }
  let setKey: PySetKey = 'stdlib';
  if (neededBundles.size > 0) {
    const covering = SET_KEYS_BY_SIZE.find((k) => [...neededBundles].every((b) => SET_BUNDLES[k].includes(b)));
    // 'all' covers every bundle by construction — a miss means the generated
    // tables and this resolver diverged; fail loud, never guess a set.
    if (covering === undefined) throw new Error(`resolveImports: no set covers [${[...neededBundles].join(', ')}]`);
    setKey = covering;
  }
  return { setKey, missing };
}

/** The user-facing refusal line (rendered error-tinted in the output panel). */
export function unavailableMessage(missing: string[]): string {
  const list = missing.map((m) => `'${m}'`).join(', ');
  // sqlite3 is stdlib since the 314 toolchain (static _sqlite3) — the marquee
  // check spans both tables so it keeps its billing.
  const marquee = ['numpy', 'pandas', 'matplotlib', 'seaborn', 'sqlite3'].filter((p) => AVAILABLE_PACKAGES.has(p) || STDLIB_MODULES.has(p));
  const avail = marquee.length > 0 ? `${marquee.join(', ')} + the Python standard library` : 'the Python standard library';
  return `ImportError: ${list} ${missing.length === 1 ? 'is' : 'are'} not available in canvas Python. Available: ${avail}.`;
}
