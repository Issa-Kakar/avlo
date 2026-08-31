"""Corpus lane wiring: dist view, boot script, per-group runtime fixture.

pytest-pyodide (node runtime, its default) drives one node process + one
loadPyodide per test MODULE (`selenium_module_scope`), with no state reset
between tests — one module per corpus group mirrors the old runner's
child-per-group semantics exactly. `--rt host` skips the whole lane (units
stay runnable without artifacts).
"""

import json
import os
import pathlib
import shutil

import corpus_lib as C
import pytest
from pytest_pyodide import get_global_config

# ---- collection-time registry check: an unmapped corpus dir (or a mapped
# group without its test module) is a hard collection error, not a skip.
_dirs = sorted(p.name for p in C.CORPUS_DIR.iterdir() if p.is_dir())
_mapped = sorted(C.GROUP_SET)
if _dirs != _mapped:
    raise pytest.UsageError(
        f"corpus dirs {_dirs} != GROUP_SET registry {_mapped} — map every corpus dir in tests/corpus/corpus_lib.py GROUP_SET"
    )
_missing_modules = [g for g in _mapped if not (C.PKG_ROOT / "tests" / "corpus" / f"test_{g}.py").exists()]
if _missing_modules:
    raise pytest.UsageError(f"corpus groups without a tests/corpus/test_<group>.py module: {_missing_modules}")

# ---- boot: our env over the dist view. The runner globalizes `pyodide` and
# sets _api.inTestHoist itself; the fork has no loadPackage surface and none
# is called (no run_in_pyodide, no packages=).
get_global_config().set_load_pyodide_script(
    "node",
    f"""
let pyodide = await loadPyodide({{
    indexURL: {json.dumps(str(C.DIST_VIEW))},
    packages: [],
    env: {{ PYTHONHASHSEED: '0', HOME: '/home/pyodide' }},
    jsglobals: self,
}});
""",
)

_VIEW_SOURCES = {
    "pyodide.mjs": C.RAW_DIR / "pyodide.mjs",
    "pyodide.asm.mjs": C.RAW_DIR / "pyodide.asm.mjs",
    "pyodide.asm.wasm": C.RAW_DIR / "pyodide.asm.wasm",
    # The STAGED pruned stdlib under the standard name loadPyodide derives.
    "python_stdlib.zip": C.STAGE_DIR / "python_stdlib.zip",
}
# pytest-pyodide's node driver does `require(`${distDir}/pyodide`)` — CJS
# extension probing never tries .mjs, so the view carries a one-line shim
# (Node ≥22.12 require(esm) resolves the rest).
_SHIM = "module.exports = require('./pyodide.mjs');\n"


def _artifacts_missing() -> list[str]:
    bundles = {b for s in C.SETS.values() for b in s}
    required = list(_VIEW_SOURCES.values()) + [C.BUNDLE_DIR / f"{b}.tar" for b in sorted(bundles)]
    return [str(p) for p in required if not p.exists()]


def pytest_configure(config: pytest.Config) -> None:
    config.option.dist_dir = C.DIST_VIEW
    # pytest-pyodide's node_test_driver.js is CJS, but the venv lives under
    # the repo root whose package.json says `"type": "module"` — node's
    # package-scope walk-up would treat the driver as ESM. Pin a commonjs
    # scope marker next to the driver (additive, self-healing on venv
    # recreation; python never reads it).
    import pytest_pyodide

    marker = pathlib.Path(pytest_pyodide.__file__).parent / "package.json"
    if not marker.exists():
        marker.write_text('{ "type": "commonjs" }\n')
    if _artifacts_missing():
        return  # the session fixture below reports it per-test, loudly
    C.DIST_VIEW.mkdir(parents=True, exist_ok=True)
    for name, src in _VIEW_SOURCES.items():
        dst = C.DIST_VIEW / name
        dst.unlink(missing_ok=True)
        try:
            os.link(src, dst)  # refresh unconditionally — a restage mints new inodes
        except OSError:
            shutil.copy2(src, dst)
    (C.DIST_VIEW / "pyodide.js").write_text(_SHIM)
    # Own package scope: without it the shim inherits `"type": "module"`
    # from packages/py-build/package.json and require() refuses it.
    (C.DIST_VIEW / "package.json").write_text('{ "type": "commonjs" }\n')


@pytest.fixture(scope="session", autouse=True)
def _corpus_artifacts_present() -> None:
    missing = _artifacts_missing()
    if missing:
        pytest.fail(
            f"corpus lane needs built artifacts; missing e.g. {missing[0]} — run the docker lanes if dist/raw is empty, then `pnpm py:board` (or `turbo run py:stdlib py:bundles`). Units alone: `uv run pytest --rt host`.",
            pytrace=False,
        )


@pytest.fixture(scope="module")
def group_runtime(request: pytest.FixtureRequest, selenium_module_scope):
    """The group's booted runtime: bare stdlib for set-less groups, else the
    set's bundles mounted pure-python (deps-first) + tz bridge, plus the
    font-log tap on matplotlib-bearing sets."""
    selenium = selenium_module_scope
    selenium.set_script_timeout(240)
    group: str = request.module.GROUP
    set_key = C.GROUP_SET[group]
    if set_key is not None:
        C.mount_set(selenium, set_key)
        if "matplotlib" in C.SETS[set_key]:
            selenium.run(C.FONT_TAP)
    return selenium
