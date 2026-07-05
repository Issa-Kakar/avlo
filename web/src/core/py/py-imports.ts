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

/** Top-level stdlib modules present in the pruned build (sys.stdlib_module_
 * names minus the prune list; pruned names get better errors at runtime from
 * the tombstone finder, so they stay ALLOWED here). */
const STDLIB = new Set([
  'abc',
  'antigravity',
  'argparse',
  'array',
  'ast',
  'asyncio',
  'atexit',
  'base64',
  'bdb',
  'binascii',
  'bisect',
  'builtins',
  'cProfile',
  'calendar',
  'cmath',
  'cmd',
  'code',
  'codecs',
  'codeop',
  'collections',
  'colorsys',
  'compileall',
  'concurrent',
  'configparser',
  'contextlib',
  'contextvars',
  'copy',
  'copyreg',
  'csv',
  'dataclasses',
  'datetime',
  'decimal',
  'difflib',
  'dis',
  'doctest',
  'email',
  'encodings',
  'enum',
  'errno',
  'faulthandler',
  'filecmp',
  'fileinput',
  'fnmatch',
  'fractions',
  'functools',
  'gc',
  'getopt',
  'getpass',
  'gettext',
  'glob',
  'graphlib',
  'gzip',
  'hashlib',
  'heapq',
  'hmac',
  'html',
  'importlib',
  'inspect',
  'io',
  'ipaddress',
  'itertools',
  'json',
  'keyword',
  'linecache',
  'locale',
  'logging',
  'mailbox',
  'marshal',
  'math',
  'mimetypes',
  'mmap',
  'modulefinder',
  'multiprocessing',
  'netrc',
  'numbers',
  'opcode',
  'operator',
  'optparse',
  'os',
  'pathlib',
  'pdb',
  'pickle',
  'pickletools',
  'pkgutil',
  'platform',
  'plistlib',
  'posixpath',
  'pprint',
  'profile',
  'pstats',
  'py_compile',
  'pyclbr',
  'pydoc',
  'queue',
  'quopri',
  'random',
  're',
  'reprlib',
  'rlcompleter',
  'runpy',
  'sched',
  'secrets',
  'select',
  'selectors',
  'shelve',
  'shlex',
  'shutil',
  'signal',
  'site',
  'socket',
  'stat',
  'statistics',
  'string',
  'stringprep',
  'struct',
  'subprocess',
  'symtable',
  'sys',
  'sysconfig',
  'tabnanny',
  'tarfile',
  'tempfile',
  'textwrap',
  'this',
  'threading',
  'time',
  'timeit',
  'token',
  'tokenize',
  'tomllib',
  'trace',
  'traceback',
  'tracemalloc',
  'types',
  'typing',
  'unicodedata',
  'unittest',
  'urllib',
  'uuid',
  'warnings',
  'weakref',
  'webbrowser',
  'xml',
  'zipfile',
  'zipimport',
  'zlib',
  'zoneinfo',
  // pruned-but-tombstoned (runtime gives the friendlier, precise error):
  'ctypes',
  'bz2',
  'lzma',
  'http',
  'ftplib',
  'poplib',
  'imaplib',
  'smtplib',
  'socketserver',
  'wsgiref',
  'xmlrpc',
  'wave',
  'tty',
  'pty',
  'dbm',
  'zipapp',
]);

/** Local-package universe (M2 bundles) — top-level import name → set key.
 * Availability is the CALLER's knowledge (P1: nothing; P2: manifest-driven). */
const PACKAGE_SETS: Record<string, PySetKey> = {
  numpy: 'numpy',
  pandas: 'numpy+pandas',
  matplotlib: 'numpy+matplotlib',
  mpl_toolkits: 'numpy+matplotlib',
  dateutil: 'numpy+pandas',
  pytz: 'numpy+pandas',
  PIL: 'numpy+matplotlib',
};

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
    const m = /^\s*(?:import\s+(.+)|from\s+([A-Za-z_][\w.]*)\s+import\b)/.exec(out);
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
  return [...names];
}

/**
 * Resolve scanned imports to a bundle set key or a refusal.
 * `availablePackages` is what the current manifest actually provides
 * (P1: empty set — stdlib only).
 */
export function resolveImports(modules: string[], availablePackages: ReadonlySet<string>): PyImportResolution {
  const missing: string[] = [];
  let needsNumpy = false;
  let needsPandas = false;
  let needsMpl = false;
  for (const m of modules) {
    if (STDLIB.has(m)) continue;
    const set = PACKAGE_SETS[m];
    if (set === undefined || !availablePackages.has(m)) {
      missing.push(m);
      continue;
    }
    if (set === 'numpy') needsNumpy = true;
    else if (set === 'numpy+pandas') needsPandas = true;
    else needsMpl = true;
  }
  const setKey: PySetKey =
    needsPandas && needsMpl ? 'all' : needsPandas ? 'numpy+pandas' : needsMpl ? 'numpy+matplotlib' : needsNumpy ? 'numpy' : 'stdlib';
  return { setKey, missing };
}

/** The user-facing refusal line (rendered error-tinted in the output panel). */
export function unavailableMessage(missing: string[]): string {
  const list = missing.map((m) => `'${m}'`).join(', ');
  return `ImportError: ${list} ${missing.length === 1 ? 'is' : 'are'} not available in canvas Python. Available: the Python standard library.`;
}
