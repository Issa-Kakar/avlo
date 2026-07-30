/**
 * Python run harness — executed once per executor boot into a private module
 * namespace; invoked per run. The executor passes user code by VALUE
 * (pyodide.globals.set with a string → no proxy) and gets back a compact JSON
 * string (primitive) — the primitive-only rule keeps hiwire clean for
 * snapshot capture (a live PyProxy aborts serializeHiwireState).
 *
 * Contract (master plan §Execution semantics):
 * - whole block source, FRESH `__main__` namespace per run — and since the
 *   blit reset landed, the WHOLE interpreter (sys.modules, module-level
 *   state) rewinds to the boot ready-point after every run: runs are
 *   stateless and reproducible (the fresh-`__main__` here is belt-and-braces);
 * - compiled as '<block>' with linecache seeded so user frames keep source;
 * - Jupyter-style last-expression echo (ast split; `df.head()` must print);
 * - tracebacks drop harness frames; user frames show source lines; stdlib
 *   frames are file+line only (pyc-only stdlib — gate-pinned contract);
 * - print/stderr flow through pyodide's stdout/stderr hooks (executor-side,
 *   batched) — the harness never buffers output itself.
 */

const HARNESS_FILE = '<avlo-harness>';
const BLOCK_FILE = '<block>';

/** Figure caps — MUST mirror PY_LIMITS.maxFigures/maxFigurePx (py-protocol).
 * Local literals because this file stays IMPORT-FREE (the py-build Node
 * harness type-strips it directly; Node ESM rejects extensionless relative
 * specifiers). Drift is pinned by the harness board's PY_LIMITS-driven
 * cap checks (run-harness.mjs seaborn section). */
const MAX_FIGS = 4;
const MAX_FIG_PX = 2_048;

/** Boot-time: define the harness module. Executor runs this once. */
const HARNESS_SOURCE = `
import ast, builtins, linecache, sys, traceback, json

_BLOCK = ${JSON.stringify(BLOCK_FILE)}
_HARNESS = ${JSON.stringify(HARNESS_FILE)}

# Captured at definition — user code monkeypatching json.dumps must not be
# able to break the run protocol (the JSON result string below).
_dumps = json.dumps

# Defense-in-depth import guard. The AUTHORITATIVE isolation layer is
# py-harden.ts (scrubWorkerScope + hardenRealm + assertRealmHardened), and
# fork patch 0008 already removes the js bridge at the finder level — this
# guard is the third net. Here: drop the JS
# bridge from the import cache (internals hold direct refs — popping only
# clears the cache) and report the whole pyodide/js surface as absent to any
# future import. pyodide/_pyodide stay cached (internals may re-import them),
# so the hook mainly covers js/pyodide_js and uncached submodules.
sys.modules.pop("js", None)
sys.modules.pop("pyodide_js", None)

_BLOCKED_ROOTS = frozenset({"js", "pyodide_js", "pyodide", "_pyodide"})


class _AvloImportGuard:
    def find_spec(self, name, path=None, target=None):
        if name.partition(".")[0] in _BLOCKED_ROOTS:
            raise ModuleNotFoundError(f"No module named {name!r}")
        return None


sys.meta_path.insert(0, _AvloImportGuard())


def _trim_tb(tb):
    """Drop leading harness frames so the user's frame is the traceback root."""
    while tb is not None and tb.tb_frame.f_code.co_filename == _HARNESS:
        tb = tb.tb_next
    return tb


# ---- matplotlib figure harvest (caps templated from MAX_FIGS/MAX_FIG_PX) ---
_MAX_FIGS = ${MAX_FIGS}
_MAX_FIG_PX = ${MAX_FIG_PX}

# plt.show() under Agg warns "FigureCanvasAgg is non-interactive, and thus
# cannot be shown" — a habitual line in real plot code; keep it out of the
# output panel. warnings filters are interpreter state, so this persists
# across runs within a generation (like the import guard above).
import warnings

warnings.filterwarnings("ignore", message=".*non-interactive.*cannot be shown")


def _close_all_figures():
    helpers = sys.modules.get("matplotlib._pylab_helpers")
    if helpers is not None:
        try:
            helpers.Gcf.destroy_all()
        except BaseException:
            pass


def _harvest_figures(interrupted):
    """PNG-dump open pyplot figures to MEMFS, ALWAYS closing them — the
    interpreter is shared across runs, so a leaked figure would reappear in
    the next run's harvest. Detection never imports matplotlib itself:
    _pylab_helpers (Gcf's home) is in sys.modules iff pyplot ran. Skips the
    dump when interrupted (cancel/timeout must not fight the kill grace with
    savefig work) but still closes. SIGINT repeats until the run resolves, so
    every step is BaseException-guarded."""
    helpers = sys.modules.get("matplotlib._pylab_helpers")
    if helpers is None:
        return []
    figs = []
    try:
        if not interrupted:
            for i, mgr in enumerate(helpers.Gcf.get_all_fig_managers()[:_MAX_FIGS]):
                try:
                    fig = mgr.canvas.figure
                    dpi = fig.dpi
                    m = max(fig.get_figwidth(), fig.get_figheight()) * dpi
                    if m > _MAX_FIG_PX:
                        dpi = dpi * _MAX_FIG_PX / m
                    path = "/tmp/_avlo_fig%d.png" % i
                    fig.savefig(path, format="png", dpi=dpi)
                    figs.append([path, round(fig.get_figwidth() * dpi), round(fig.get_figheight() * dpi)])
                except BaseException:
                    pass
    finally:
        _close_all_figures()
    return figs


def run(code):
    # Fresh namespace per run; the executor's post-run blit reset rewinds the
    # rest of the interpreter (sys.modules, module state) to the ready-point.
    g = {"__name__": "__main__", "__builtins__": builtins}
    lines = code.splitlines(keepends=True)
    linecache.cache[_BLOCK] = (len(code), None, lines, _BLOCK)
    interrupted = False
    ok = True
    figures = []
    # Second-chance sweep: a hard-interrupted prior cleanup can leak figures
    # past its own guarded destroy_all.
    _close_all_figures()
    try:
        tree = ast.parse(code, _BLOCK)
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body[-1].value)
            tree.body = tree.body[:-1]
        exec(compile(tree, _BLOCK, "exec"), g)
        if last is not None:
            v = eval(compile(last, _BLOCK, "eval"), g)
            if v is not None:
                print(repr(v))
    except KeyboardInterrupt:
        ok = False
        interrupted = True
    except SystemExit:
        ok = True  # exit() in a canvas block ends the run, not the runtime
    except BaseException:
        ok = False
        et, ev, tb = sys.exc_info()
        traceback.print_exception(et, ev, _trim_tb(tb), file=sys.stderr)
    finally:
        linecache.cache.pop(_BLOCK, None)
        try:
            figures = _harvest_figures(interrupted)
        except BaseException:
            pass
        sys.stdout.flush()
        sys.stderr.flush()
    return _dumps({"ok": ok, "interrupted": interrupted, "figures": figures})
`;

/** Per-run: executor sets `_avlo_code` (string, by value) then evals this. */
export const RUN_INVOKE = '_avlo_harness.run(_avlo_code)';

/** Boot-time namespace setup: put the harness behind one module-like global. */
export const HARNESS_INSTALL = `
import types as _t
_avlo_harness = _t.ModuleType("_avlo_harness")
exec(compile(${JSON.stringify(HARNESS_SOURCE)}, ${JSON.stringify(HARNESS_FILE)}, "exec"), _avlo_harness.__dict__)
del _t
`;
