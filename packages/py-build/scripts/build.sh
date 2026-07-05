#!/usr/bin/env bash
# In-container build orchestrator. Runs inside pyodide/pyodide-env with:
#   /src  = pyodide checkout (bind mount, HOME)
#   /pb   = packages/py-build (read-only bind mount)
#   /out  = packages/py-build/dist (bind mount)
# Env: TARGETS (make targets), EMSDK_NUM_CORES/EMCC_CORES/PYODIDE_JOBS.
set -euo pipefail
cd /src

TAG="$(python3 -c "import json;print(json.load(open('/pb/build.config.json'))['pyodide']['tag'])")"

# Reset to the pinned tag, drop any previous patch commits, keep build outputs
# (emsdk/, cpython/build/, node_modules/ are gitignored in the pyodide tree, so
# `git checkout -f` + targeted clean leaves the expensive caches intact).
git checkout -f "$TAG" --
git clean -fd src/js src/core src/py 2>/dev/null || true

# Apply the patch queue (one commit per patch: conflicts on future rebases bisect).
git config user.email "py-build@avlo.local" && git config user.name "avlo-py-build"
shopt -s nullglob
for p in /pb/patches/pyodide/*.patch; do
  echo "=== applying $(basename "$p")"
  git apply --index "$p"
  git commit -qm "$(basename "$p")"
done
# emsdk patches ride pyodide's own emsdk patch mechanism (applied by make -C emsdk).
for p in /pb/patches/emsdk/*.patch; do
  echo "=== staging emsdk patch $(basename "$p")"
  cp "$p" emsdk/patches/
done

# The top-level Makefile's `emsdk/emsdk/.complete:` rule has NO prerequisites,
# so staged emsdk patches are inert on incremental builds (the patch wildcard
# only fires inside `make -C emsdk`, which full rebuilds run). Direct-apply
# any patch the installed tree is missing, then hard-assert hook liveness —
# a silently-unpatched dylink layer produces snapshots that fail only at
# numpy-replay time, hours downstream.
EMSCRIPTEN_DIR=emsdk/emsdk/upstream/emscripten
if [ -d "$EMSCRIPTEN_DIR" ]; then
  for p in /pb/patches/emsdk/*.patch; do
    if patch -p1 -N --dry-run -d "$EMSCRIPTEN_DIR" < "$p" >/dev/null 2>&1; then
      echo "=== direct-applying emsdk patch $(basename "$p") (installed tree predates it)"
      patch -p1 -N -d "$EMSCRIPTEN_DIR" < "$p"
    fi
  done
  grep -q dsoBaseHook "$EMSCRIPTEN_DIR/src/lib/libdylink.js" || {
    echo "!!! emsdk dsoBaseHook missing from installed emscripten after patching"; exit 1;
  }
fi
shopt -u nullglob

echo "=== make ${TARGETS}"
# shellcheck disable=SC2086
make ${TARGETS}

mkdir -p /out/raw
for f in dist/pyodide.asm.js dist/pyodide.asm.wasm dist/pyodide.js dist/pyodide.mjs dist/python_stdlib.zip dist/snapshot.bin dist/package.json; do
  [ -f "$f" ] && cp -f "$f" /out/raw/ && echo "=== copied $f"
done
echo "=== build.sh done"
