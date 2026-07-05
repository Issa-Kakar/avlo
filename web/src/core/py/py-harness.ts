/**
 * Python run harness — executed once per executor boot into a private module
 * namespace; invoked per run. The executor passes user code by VALUE
 * (pyodide.globals.set with a string → no proxy) and gets back a compact JSON
 * string (primitive) — the primitive-only rule keeps hiwire clean for
 * snapshot capture (a live PyProxy aborts serializeHiwireState).
 *
 * Contract (master plan §Execution semantics):
 * - whole block source, FRESH `__main__` namespace per run;
 * - compiled as '<block>' with linecache seeded so user frames keep source;
 * - Jupyter-style last-expression echo (ast split; `df.head()` must print);
 * - tracebacks drop harness frames; user frames show source lines; stdlib
 *   frames are file+line only (pyc-only stdlib — gate-pinned contract);
 * - print/stderr flow through pyodide's stdout/stderr hooks (executor-side,
 *   batched) — the harness never buffers output itself.
 */

export const HARNESS_FILE = '<avlo-harness>';
export const BLOCK_FILE = '<block>';

/** Boot-time: define the harness module. Executor runs this once. */
export const HARNESS_SOURCE = `
import ast, builtins, linecache, sys, traceback, json

_BLOCK = ${JSON.stringify(BLOCK_FILE)}
_HARNESS = ${JSON.stringify(HARNESS_FILE)}


def _trim_tb(tb):
    """Drop leading harness frames so the user's frame is the traceback root."""
    while tb is not None and tb.tb_frame.f_code.co_filename == _HARNESS:
        tb = tb.tb_next
    return tb


def run(code):
    # Fresh namespace per run — stateless, reproducible runs.
    g = {"__name__": "__main__", "__builtins__": builtins}
    lines = code.splitlines(keepends=True)
    linecache.cache[_BLOCK] = (len(code), None, lines, _BLOCK)
    interrupted = False
    ok = True
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
        sys.stdout.flush()
        sys.stderr.flush()
    return json.dumps({"ok": ok, "interrupted": interrupted})
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
