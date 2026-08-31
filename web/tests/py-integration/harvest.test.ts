// The full `all` set (7 tars) under the hardened realm: seaborn plots render,
// the vendored KDE keeps scipy out, tombstone probes are precise, pandas ↔
// sqlite3 roundtrips, and the figure-harvest PROTOCOL holds ([path,w,h]
// triples, unconditional Gcf close, PY_LIMITS caps) — all POST-freeze.
// Pixel-QUALITY asserts (color counts, dominance) live host-side with pillow
// in py-build's pytest corpus lane; here PNGs are checked for dims only.
import { beforeAll, describe, expect, it } from 'vitest';
import { PY_LIMITS } from '../../src/core/py/py-protocol';
import { bootHardened, type HardenedBoot, pngDims } from './helpers';

let boot: HardenedBoot;
const run = (code: string) => boot.run(code);

// Font gates ride matplotlib's logger: 'generated new fontManager' (INFO)
// means the BAKED fontlist.json was not consumed; 'findfont' (WARNING) means
// the subset faces miss a requested family/glyph set.
const FONT_TAP = `import logging
_avlo_mpl_logs = []
class _AvloLogTap(logging.Handler):
    def emit(self, record):
        _avlo_mpl_logs.append(record.getMessage())
_mpl_logger = logging.getLogger('matplotlib')
_mpl_logger.addHandler(_AvloLogTap(level=logging.INFO))
_mpl_logger.setLevel(logging.INFO)`;

beforeAll(async () => {
  boot = await bootHardened('all');
  boot.pyodide.runPython(FONT_TAP);
});

describe('executor-shaped boot gates (all set)', () => {
  it('every mounted tar matches the committed lock', () => {
    expect(boot.tarLockOk).toEqual({
      numpy: true,
      dateutil: true,
      pytz: true,
      'mpl-deps': true,
      pandas: true,
      matplotlib: true,
      seaborn: true,
    });
  });
  it('stdlib MEMFS hash == lock sha', () => {
    expect(boot.stdlibHashOk).toBe(true);
  });
  it('trampoline live: ≤16 table.get crossings per 10k METH_NOARGS calls', () => {
    expect(boot.trampolineCrossings).toBeLessThanOrEqual(16);
  });
  it('assertRealmHardened passes on a clean hardened realm', () => {
    expect(boot.hardenGateError).toBeNull();
  });
});

describe('seaborn under the frozen realm', () => {
  it('import seaborn post-freeze', () => {
    const r = run('import seaborn\nprint(seaborn.__version__)');
    expect(r.ok).toBe(true);
    expect(r.output).toBe('0.13.2\n');
  });
  it('sns.scatterplot renders to a real PNG (dims sane)', () => {
    const r = run(
      "import numpy as np, pandas as pd, seaborn as sns\nimport matplotlib.pyplot as plt\nrng = np.random.default_rng(7)\ndf = pd.DataFrame({'x': rng.normal(size=40), 'y': rng.normal(size=40), 'k': ['a', 'b'] * 20})\nax = sns.scatterplot(data=df, x='x', y='y', hue='k')\nax.get_figure().savefig('/tmp/h_scatter.png', dpi=100)\nplt.close('all')\nprint('saved')",
    );
    expect(r.ok).toBe(true);
    expect(r.output).toBe('saved\n');
    const dims = pngDims(boot.pyodide.FS.readFile('/tmp/h_scatter.png'));
    expect(dims.width).toBeGreaterThan(0);
    expect(dims.height).toBeGreaterThan(0);
  });
  it('kdeplot on the vendored KDE — scipy never enters sys.modules', () => {
    const r = run(
      "import sys, numpy as np, seaborn as sns\nimport matplotlib.pyplot as plt\nsns.kdeplot(x=np.random.default_rng(11).normal(size=200))\nplt.close('all')\nprint('scipy' in sys.modules)",
    );
    expect(r.ok).toBe(true);
    expect(r.output).toBe('False\n');
  });
  it('load_dataset → urllib.request tombstone (lazy urllib patch)', () => {
    const r = run("import seaborn as sns\nsns.load_dataset('penguins')");
    expect(r.ok).toBe(false);
    expect(r.output).toContain("'urllib.request'");
    expect(r.output).toContain('not available');
  });
  it('seaborn.objects → prune tombstone (PIL-dead)', () => {
    const r = run('import seaborn.objects');
    expect(r.ok).toBe(false);
    expect(r.output).toContain('seaborn.objects');
    expect(r.output).toContain('not available');
  });
  it('pandas↔sqlite3 read_sql roundtrip post-freeze', () => {
    const r = run(
      "import sqlite3, pandas as pd\ncon = sqlite3.connect(':memory:')\npd.DataFrame({'g': ['a', 'a', 'b'], 'x': [1.0, 2.0, 3.5]}).to_sql('t', con, index=False)\nprint(pd.read_sql_query('SELECT SUM(x) AS s FROM t', con)['s'].iloc[0])\ncon.close()",
    );
    expect(r.ok).toBe(true);
    expect(r.output).toBe('6.5\n');
  });
});

// Figure harvest: open pyplot figures come back as [path, w, h] triples in
// the run JSON and are ALWAYS closed across runs. PY_LIMITS drives the cap
// checks so py-harness's local MAX_FIGS/MAX_FIG_PX literals (the file must
// stay import-free) cannot silently drift.
describe('figure harvest protocol', () => {
  it('open figure → one [path,w,h] triple; plt.show() warning filtered; dims match the PNG', () => {
    const r = run("import matplotlib.pyplot as plt\nplt.plot([1, 2, 3])\nplt.show()\nprint('plotted')");
    expect(r.ok).toBe(true);
    expect(r.output).toBe('plotted\n');
    expect(r.figures).toHaveLength(1);
    const [p, w, h] = r.figures[0];
    const dims = pngDims(boot.pyodide.FS.readFile(p));
    expect([dims.width, dims.height]).toEqual([w, h]);
    boot.pyodide.FS.unlink(p); // executor-shaped cleanup
  });
  it('Gcf empty on the NEXT run (unconditional close-all)', () => {
    const r = run('import matplotlib._pylab_helpers as h\nprint(len(h.Gcf.get_all_fig_managers()))');
    expect(r.ok).toBe(true);
    expect(r.output).toBe('0\n');
    expect(r.figures).toHaveLength(0);
  });
  it('6 open figures capped at PY_LIMITS.maxFigures', () => {
    const r = run("import matplotlib.pyplot as plt\nfor i in range(6):\n    plt.figure()\nprint('made 6')");
    expect(r.ok).toBe(true);
    expect(r.figures).toHaveLength(PY_LIMITS.maxFigures);
    for (const [p] of r.figures) boot.pyodide.FS.unlink(p);
  });
  it('oversize figure dpi-scaled to ≤ PY_LIMITS.maxFigurePx long side', () => {
    const r = run("import matplotlib.pyplot as plt\nplt.figure(figsize=(30, 10), dpi=100)\nprint('big')");
    expect(r.ok).toBe(true);
    expect(r.figures).toHaveLength(1);
    const [p, w, h] = r.figures[0];
    expect(Math.max(w, h)).toBeLessThanOrEqual(PY_LIMITS.maxFigurePx);
    expect(w).toBeGreaterThanOrEqual(PY_LIMITS.maxFigurePx - 64);
    boot.pyodide.FS.unlink(p);
  });
  it('font gates: no findfont, no fontManager rebuild across the whole board', () => {
    const logs = JSON.parse(boot.pyodide.runPython('import json; json.dumps(_avlo_mpl_logs)') as string) as string[];
    expect(logs.filter((l) => /findfont|generated new fontManager/.test(l))).toEqual([]);
  });
});
