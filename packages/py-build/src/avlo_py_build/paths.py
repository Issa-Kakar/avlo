"""Path anchors. Every artifact/config path is addressed from these roots so
`uv run avlo-build …` behaves identically from any cwd in the workspace."""

from pathlib import Path

# src/avlo_py_build/paths.py → packages/py-build (uv installs the workspace
# member editable, so __file__ stays in the real source tree).
PKG_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = PKG_ROOT.parents[1]
CONFIG_PATH = PKG_ROOT / "build.config.json"
assert CONFIG_PATH.is_file(), f"py-build root not found at {PKG_ROOT}"

RAW_DIR = PKG_ROOT / "dist/raw"
STAGE_DIR = PKG_ROOT / "dist/stage"
BUNDLES_OUT = STAGE_DIR / "bundles"
GROUPS_DIR = PKG_ROOT / "dist/groups"
CACHE_DIR = PKG_ROOT / ".cache"
WHEEL_CACHE = CACHE_DIR / "wheels"
FORK_PUBLIC = REPO_ROOT / "web/public/py-dev/fork"
BUILD_LOCK = REPO_ROOT / "packages/py-loader/build-lock.json"
