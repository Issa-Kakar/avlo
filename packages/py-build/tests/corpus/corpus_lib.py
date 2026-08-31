"""Corpus lane internals (phase 2 of the toolchain replatform).

Samples stay DATA: ``corpus/<group>/*.py`` are self-asserting python files
exec'd in a fresh namespace inside a real fork boot — adding coverage is
dropping a file in the right group dir. This module owns everything around
them: the group→set registry, PURE-PYTHON tar mounts (``tarfile.extractall``
— equivalent to the shipped walker by the standing zero-diff parity gate in
web/tests/py-integration/mount-parity.test.ts; DSOs load through the natural
``import`` → sitecustomize group finder → C dlopen chain, zero JS), the
matplotlib font-log gate, and the pillow pixel gate over ``/tmp/corpus-out``.

The runtime is pytest-pyodide's node runner over a tests-owned dist view
(``.cache/pytest-dist`` — raw fork glue + the STAGED pruned stdlib + a
one-line CJS ``pyodide.js`` shim; built by conftest, never the served tree).
"""

import json
from io import BytesIO
from pathlib import Path

from PIL import Image

PKG_ROOT = Path(__file__).resolve().parents[2]
CORPUS_DIR = PKG_ROOT / "corpus"
RAW_DIR = PKG_ROOT / "dist" / "raw"
STAGE_DIR = PKG_ROOT / "dist" / "stage"
BUNDLE_DIR = STAGE_DIR / "bundles"
DIST_VIEW = PKG_ROOT / ".cache" / "pytest-dist"

CONFIG = json.loads((PKG_ROOT / "build.config.json").read_text())
SETS: dict[str, list[str]] = CONFIG["sets"]

# corpus group -> set key ('basic' runs on the bare stdlib — sqlite3 and
# _zstd are static in the 314 main module, so no tars). A corpus dir must
# have a row here AND a tests/corpus/test_<group>.py module — conftest
# hard-fails collection otherwise.
GROUP_SET: dict[str, str | None] = {
    "basic": None,
    "numpy": "numpy+pandas",
    "pandas": "numpy+pandas",
    "mpl": "numpy+matplotlib",
    "all": "all",
    "seaborn": "all",
}


def samples_for(group: str) -> list[Path]:
    return sorted((CORPUS_DIR / group).glob("*.py"))


def set_bundles(group: str) -> list[str]:
    set_key = GROUP_SET[group]
    return SETS[set_key] if set_key else []


# Pure-python mount of one bundle tar staged at /tmp/_avlo_bundle.tar:
# meta.json (always the FIRST tar entry) supplies the prefix, asserted
# against the interpreter's own site-packages before extraction.
_MOUNT_TAR = """\
import json, os, sysconfig, tarfile
_prefix = '/' + sysconfig.get_paths()['purelib'].lstrip('/')
with tarfile.open('/tmp/_avlo_bundle.tar') as _t:
    _meta = json.load(_t.extractfile('meta.json'))
    assert _meta['prefix'] == _prefix, f"meta.prefix {_meta['prefix']} != interpreter site-packages {_prefix}"
    _t.extractall(_prefix, members=[m for m in _t.getmembers() if m.name != 'meta.json'], filter='data')
os.remove('/tmp/_avlo_bundle.tar')
del _t, _meta, _prefix
"""

# Font gates ride matplotlib's logger: 'generated new fontManager' (INFO)
# means the BAKED fontlist.json was not consumed; 'findfont' (WARNING) means
# the subset faces miss a requested family/glyph set.
FONT_TAP = """\
import logging
_avlo_mpl_logs = []
class _AvloLogTap(logging.Handler):
    def emit(self, record):
        _avlo_mpl_logs.append(record.getMessage())
_mpl_logger = logging.getLogger('matplotlib')
_mpl_logger.addHandler(_AvloLogTap(level=logging.INFO))
_mpl_logger.setLevel(logging.INFO)
"""


def mount_set(selenium, set_key: str) -> None:
    """Deps-first bundle order (the canonical cross-bundle DSO order), then
    the tz bridge — pandas 3 rides zoneinfo for every tz op."""
    for bundle in SETS[set_key]:
        tar_path = BUNDLE_DIR / f"{bundle}.tar"
        selenium.run_js(
            f"""
            const fs = require('node:fs');
            const b = fs.readFileSync({json.dumps(str(tar_path))});
            pyodide.FS.writeFile('/tmp/_avlo_bundle.tar', new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
            return 0;
            """
        )
        selenium.run(_MOUNT_TAR)
    selenium.run("import _avlo_runtime; _avlo_runtime.ensure_tzpath()")


def run_sample(selenium, path: Path) -> None:
    """Fresh namespace per sample, mirroring the executor's run contract; the
    sample's own asserts propagate as the test failure."""
    name = f"{path.parent.name}/{path.name}"
    src = path.read_text()
    selenium.run(
        "import builtins\n"
        "_g = {'__name__': '__main__', '__builtins__': builtins}\n"
        f"exec(compile({src!r}, {name!r}, 'exec'), _g)\n"
        "del _g"
    )


def assert_font_gate(selenium) -> None:
    logs: list[str] = selenium.run("_avlo_mpl_logs")
    rebuilt = [line for line in logs if "generated new fontManager" in line]
    assert not rebuilt, "font gate: baked fontlist.json was NOT consumed (fontManager rebuilt)"
    findfont = [line for line in logs if "findfont" in line]
    assert not findfont, f"font gate: {findfont}"


def assert_figure_pixels(selenium) -> None:
    """Decode every PNG the samples produced — real pixels via pillow, not
    just magic bytes: ≥2 colors and no >99%-dominant flood fill."""
    files: list[str] = selenium.run(
        "import os\nsorted(f for f in os.listdir('/tmp/corpus-out') if f.endswith('.png')) if os.path.isdir('/tmp/corpus-out') else []"
    )
    assert files, "no PNGs in /tmp/corpus-out — the group's figure samples did not land their files"
    for f in files:
        # hex, not base64: the driver protocol rewrites the literal substring
        # 'undefined' inside results, and hex's alphabet can never form it.
        data = bytes.fromhex(selenium.run(f"open('/tmp/corpus-out/{f}', 'rb').read().hex()"))
        im = Image.open(BytesIO(data)).convert("RGB")
        w, h = im.size
        colors = im.getcolors(maxcolors=w * h)
        assert colors is not None and w > 0 and h > 0
        dominant = max(count for count, _ in colors) / (w * h)
        ok = len(colors) >= 2 and dominant < 0.99
        assert ok, f"png gate {f}: {w}x{h}, {len(colors)} colors, dominant {dominant:.1%}"
