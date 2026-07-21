#!/usr/bin/env bash
# In-container recipe-rebuild orchestrator (P1.5 DSO grouping). Runs inside
# the digest-pinned pyodide/pyodide-env image with:
#   /rx  = .work/recipes-root (bind mount, HOME) — recipes checkout, venv,
#          xbuildenv, build trees, link records, stash, caches
#   /pb  = packages/py-build (read-only bind mount)
#   /out = packages/py-build/dist (bind mount)
# Env (set by run-recipes.mjs): PYODIDE_XBUILDENV_PATH=/rx/xbuildenv,
# PYODIDE_RECIPE_BUILD_DIR=/rx/build, AVLO_LINK_RECORD_DIR=/rx/record,
# PIP_CACHE_DIR=/rx/pip-cache.
#
# Steps (each stamp/marker-guarded => incremental re-runs):
#   asserts -> venv+pyodide-build (patched) -> xbuildenv (byte-verified) ->
#   serial no-deps builds (numpy contourpy kiwisolver pandas matplotlib) ->
#   harvest-links.py -> link-groups.py --repro -> copy wheels to /out.
set -euo pipefail

LINK_ONLY=0; ONLY_PKG=""; FORCE=0
while [ $# -gt 0 ]; do case "$1" in
  --link-only) LINK_ONLY=1 ;;
  --pkg) ONLY_PKG="$2"; shift ;;
  --force) FORCE=1 ;;
  *) echo "!!! unknown arg $1"; exit 2 ;;
esac; shift; done

CFG=/pb/build.config.json
cfg() { python3 -c "import json;print(json.load(open('$CFG'))$1)"; }
XB_VER="$(cfg "['xbuildenv']['version']")"
XB_URL="$(cfg "['xbuildenv']['url']")"
XB_SHA="$(cfg "['xbuildenv']['sha256']")"
EM_PIN="$(cfg "['toolchain']['emscripten']")"
ABI_PIN="$(cfg "['toolchain']['abi']")"
PY_MM="$(cfg "['toolchain']['python']" | cut -d. -f1-2)"
PB_PIN="$(cfg "['recipes']['pyodideBuildCommit']")"

# --- asserts (fail before any work) -----------------------------------------
# uv: pyodide-build silently PREFERS uv when importable/on PATH, and uv
# ignores PIP_CONSTRAINT — the frozen-constraints model requires pip.
if command -v uv >/dev/null 2>&1; then
  echo "!!! uv on PATH — pyodide-build would use it and bypass PIP_CONSTRAINT"; exit 1
fi
# PYODIDE_ROOT: build_env.init_environment short-circuits on it, bypassing
# the xbuildenv entirely (would build against nothing).
if [ -n "${PYODIDE_ROOT:-}" ]; then
  echo "!!! PYODIDE_ROOT is set — must be unset so init_environment resolves the xbuildenv"; exit 1
fi
python3 --version | grep -q " ${PY_MM}\." || { echo "!!! container python3 is not ${PY_MM}.x"; exit 1; }

# --- venv + patched pyodide-build (stamped on pin + patch-queue digest) -----
VENV=/rx/venv
PB_DIGEST="$( (echo "$PB_PIN"; cat /pb/patches/pyodide-build/*.patch 2>/dev/null) | sha256sum | cut -d' ' -f1)"
if [ ! -x "$VENV/bin/pyodide" ] || [ "$(cat "$VENV/.avlo-stamp" 2>/dev/null || true)" != "$PB_DIGEST" ]; then
  echo "=== venv: installing pyodide-build @ ${PB_PIN:0:8} (+$(ls /pb/patches/pyodide-build/*.patch 2>/dev/null | wc -l) patches)"
  rm -rf "$VENV"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q /rx/recipes/pyodide-build
  echo "$PB_DIGEST" > "$VENV/.avlo-stamp"
fi
export PATH="$VENV/bin:$PATH"
# The record hook must be live in the INSTALLED copy (non-editable install).
grep -q "AVLO_LINK_RECORD_DIR" "$VENV"/lib/python*/site-packages/pyodide_build/pywasmcross.py || {
  echo "!!! AVLO record hook missing from the installed pyodide-build (patch not applied?)"; exit 1; }

# --- xbuildenv: byte-verified bytes, CLI skips its own download -------------
# The CLI does NOT sha-verify its tarball. We pre-download + verify + extract
# to the exact layout install() expects; the versioned install then sees the
# directory, skips downloading, and finishes markers/use_version.
# The hosted releases metadata lags patch releases (314.0.2 absent, checked
# 2026-07-20) and the versioned install unconditionally resolves the version
# there — point PYODIDE_CROSS_BUILD_ENV_METADATA_URL at a local metadata file
# generated from OUR pins (the loader opens non-http values as plain files).
XB_TB="/rx/cache/xbuildenv-$XB_VER.tar.bz2"
[ -f "$XB_TB" ] || curl -fsSL -o "$XB_TB" "$XB_URL"
echo "$XB_SHA  $XB_TB" | sha256sum -c - >/dev/null || { echo "!!! xbuildenv tarball sha mismatch vs config pin"; exit 1; }
python3 - "$XB_VER" "$XB_URL" "$XB_SHA" <<'PYEOF'
import json, sys
ver, url, sha = sys.argv[1:4]
cfg = json.load(open("/pb/build.config.json"))
# No min/max pyodide-build pin: the shallow-git-installed pyodide-build
# reports a setuptools-scm fallback version that PEP440-compares below any
# real floor. Compatibility is OUR pin's responsibility — the post-install
# asserts (emscripten 5.0.3, abi 2026_0) are the real check.
meta = {"releases": {ver: {
    "version": ver, "url": url, "sha256": sha,
    "python_version": cfg["toolchain"]["python"],
    "emscripten_version": cfg["toolchain"]["emscripten"],
}}}
open("/rx/cache/xbuildenv-meta.json", "w").write(json.dumps(meta, indent=1))
PYEOF
export PYODIDE_CROSS_BUILD_ENV_METADATA_URL=/rx/cache/xbuildenv-meta.json
if [ ! -e "$PYODIDE_XBUILDENV_PATH/$XB_VER/.installed" ]; then
  echo "=== installing xbuildenv $XB_VER (pre-verified bytes)"
  mkdir -p "$PYODIDE_XBUILDENV_PATH/$XB_VER"
  tar xjf "$XB_TB" -C "$PYODIDE_XBUILDENV_PATH/$XB_VER"
  pyodide xbuildenv install "$XB_VER" --path "$PYODIDE_XBUILDENV_PATH"
fi

# --- post-install asserts ---------------------------------------------------
EM_GOT="$(pyodide config get emscripten_version)"
[ "$EM_GOT" = "$EM_PIN" ] || { echo "!!! emscripten_version $EM_GOT != pin $EM_PIN"; exit 1; }
ABI_GOT="$(pyodide config get pyodide_abi_version)"
[ "$ABI_GOT" = "$ABI_PIN" ] || { echo "!!! pyodide_abi_version $ABI_GOT != pin $ABI_PIN"; exit 1; }
# Guards search_pyodide_root picking up a stray [tool.pyodide] pyproject from cwd.
PYROOT="$(pyodide config get pyodide_root)"
case "$PYROOT" in
  */pyodide-root) ;;
  *) echo "!!! pyodide_root '$PYROOT' does not end in pyodide-root — xbuildenv not resolved"; exit 1 ;;
esac

# Frozen build-backend constraints — PER PACKAGE (recipes-constraints.d/
# <pkg>.txt, generated by run-recipes.mjs --freeze-constraints from the
# AVLO-PKG-marked pip log). One global file cannot work: legitimate
# cross-package conflicts exist (numpy resolves Cython 3.2.8 while pandas'
# `<4.0.0a0` bound enables the 3.3.0a1 prerelease; matplotlib pins
# meson-python 0.16.x vs 0.20.x elsewhere) and PIP_CONSTRAINT applies to
# every requirement in an env. Until a package's file exists (freeze
# epoch), the seed file (upstream's `cmake < 4` only) applies and that
# build floats — freeze right after such a run. Exported per package in
# the build loop below.
[ -f /pb/config/recipes-constraints.txt ] || { echo "!!! config/recipes-constraints.txt (seed) missing"; exit 1; }

# --- serial no-deps builds --------------------------------------------------
# build-recipes-no-deps is CRITICAL: plain build-recipes pulls RUN-deps
# transitively (graph_builder) and would source-build pillow. No --clean:
# harvest needs the build trees. Order pinned: numpy first (host dep of
# pandas/matplotlib).
if [ "$LINK_ONLY" = 0 ]; then
  PKGS="numpy contourpy kiwisolver pandas matplotlib"
  [ -n "$ONLY_PKG" ] && PKGS="$ONLY_PKG"
  mkdir -p /rx/stamps "$AVLO_LINK_RECORD_DIR"
  # Isolated-env pip output is NOT tee'd into build.log — PIP_LOG is the
  # capture channel for the "Successfully installed" lines the constraints
  # freeze scrapes (run-recipes.mjs --freeze-constraints). Exported only for
  # the build loop so the venv's own install stays out of the freeze set.
  export PIP_LOG=/rx/pip-install.log
  # A forced full rebuild is the freeze epoch — start its log clean.
  [ "$FORCE" = 1 ] && [ -z "$ONLY_PKG" ] && : > "$PIP_LOG"
  for p in $PKGS; do
    if [ -e "/rx/stamps/$p.done" ] && [ "$FORCE" = 0 ]; then
      echo "=== $p: done stamp exists, skipping (--force to rebuild)"
      continue
    fi
    echo "=== building $p"
    PKG_CONS="/pb/config/recipes-constraints.d/$p.txt"
    if [ -f "$PKG_CONS" ]; then
      export PIP_CONSTRAINT="$PKG_CONS"
    else
      echo "--- $p: no frozen constraints yet (freeze epoch) — seed file only"
      export PIP_CONSTRAINT=/pb/config/recipes-constraints.txt
    fi
    # Marker for --freeze-constraints round attribution: every pip round
    # below this line belongs to $p (last section per package wins).
    echo "AVLO-PKG $p" >> "$PIP_LOG"
    # --force propagates to pyodide-build's own up-to-date check too —
    # without --force-rebuild it silently skips unchanged recipes, which
    # would under-capture the PIP_LOG freeze source.
    if [ "$FORCE" = 1 ]; then
      pyodide build-recipes-no-deps "$p" --recipe-dir /rx/recipes/packages --force-rebuild
    else
      pyodide build-recipes-no-deps "$p" --recipe-dir /rx/recipes/packages
    fi
    touch "/rx/stamps/$p.done"
  done
fi

# --- harvest + group link (recorded paths are live in this container) -------
HARVEST_ARGS=(--groups /pb/config/dso-groups/groups.json --records "$AVLO_LINK_RECORD_DIR" \
  --stash /rx/stash --out /out/groups/manifests)
LINK_ARGS=(--manifests /out/groups/manifests --stash /rx/stash --out /out/groups --repro)
if [ -n "$ONLY_PKG" ]; then
  HARVEST_ARGS+=(--pkgs "$ONLY_PKG")
  LINK_ARGS+=(--allow-partial)
fi

# emcc/emar come from the xbuildenv's own emsdk — the exact toolchain that
# built the upstream wheels (auto-installed at first build). Sourced BEFORE
# harvest: thin-archive repacking needs emar.
EMSDK_DIR="$(pyodide config get emsdk_dir)"
[ -f "$EMSDK_DIR/emsdk_env.sh" ] || { echo "!!! no emsdk_env.sh at $EMSDK_DIR — run a build first (emsdk installs on first build)"; exit 1; }
# shellcheck disable=SC1091
source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
command -v emcc >/dev/null || { echo "!!! emcc not on PATH after emsdk_env.sh"; exit 1; }
command -v emar >/dev/null || { echo "!!! emar not on PATH after emsdk_env.sh"; exit 1; }
python3 /pb/scripts/harvest-links.py "${HARVEST_ARGS[@]}"
python3 /pb/scripts/link-groups.py "${LINK_ARGS[@]}"

# --- rebuilt wheels out (verify-pytree.py compares them host-side) ----------
mkdir -p /out/groups/wheels
for w in /rx/recipes/packages/*/dist/*.whl; do
  [ -e "$w" ] && cp -f "$w" /out/groups/wheels/
done
echo "=== recipes-build.sh done"
