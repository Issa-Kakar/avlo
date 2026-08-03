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
# emsdk patches ride pyodide's own emsdk patch mechanism (applied by make -C
# emsdk). Every AVLO emsdk patch embeds an `AVLO` marker in its added lines —
# the liveness grep keys on the marker, not on any one patch's symbol. The
# 0006 dsoBaseHook patch is MANDATORY (snapshot replay): the marker assert
# below hard-fails if the installed tree ships unpatched dylink glue.
EMSDK_PATCHES=(/pb/patches/emsdk/*.patch)
if [ -e "${EMSDK_PATCHES[0]:-}" ]; then
  for p in "${EMSDK_PATCHES[@]}"; do
    echo "=== staging emsdk patch $(basename "$p")"
    cp "$p" emsdk/patches/
  done
  # The top-level Makefile's `emsdk/emsdk/.complete:` rule has NO prerequisites,
  # so staged emsdk patches are inert on incremental builds (the patch wildcard
  # only fires inside `make -C emsdk`, which full rebuilds run). Direct-apply
  # any patch the installed tree is missing, then hard-assert marker liveness —
  # a silently-unpatched dylink layer fails only at runtime, hours downstream.
  EMSCRIPTEN_DIR=emsdk/emsdk/upstream/emscripten
  if [ -d "$EMSCRIPTEN_DIR" ]; then
    for p in "${EMSDK_PATCHES[@]}"; do
      if patch -p1 -N --dry-run -d "$EMSCRIPTEN_DIR" < "$p" >/dev/null 2>&1; then
        echo "=== direct-applying emsdk patch $(basename "$p") (installed tree predates it)"
        patch -p1 -N -d "$EMSCRIPTEN_DIR" < "$p"
        # dist/pyodide.asm.* make rules do NOT depend on emsdk sources — force
        # the relink so an incremental build can't ship unpatched glue.
        rm -f dist/pyodide.asm.*
      fi
    done
    grep -q AVLO "$EMSCRIPTEN_DIR/src/lib/libdylink.js" || {
      echo "!!! AVLO emsdk marker missing from installed emscripten after patching"; exit 1;
    }
  fi
fi
# AVLO cpython source patches: staged into pyodide's cpython/patches/ (that
# whole dir is applied by cpython/Makefile's `.patched` rule at tarball
# extract, `cat patches/*.patch | patch -p1`). Numbered >= 0010 so they sort
# after upstream's 0009. The `.patched` stamp's only prerequisite is the
# TARBALL — a new/changed lane patch is inert against an existing build tree,
# so any lane change nukes the tree for a clean re-extract + re-patch +
# re-configure (full cpython rebuild, ~20 min — the price of a lane change).
# Same AVLO-marker discipline as the emsdk lane.
CPYTHON_PATCHES=(/pb/patches/cpython/*.patch)
PYBUILD_DIR="cpython/build/Python-$(python3 -c "import json;print(json.load(open('/pb/build.config.json'))['toolchain']['python'])")"
CPY_BUST=0
if [ -e "${CPYTHON_PATCHES[0]:-}" ]; then
  for p in "${CPYTHON_PATCHES[@]}"; do
    grep -q AVLO "$p" || { echo "!!! cpython patch $(basename "$p") lacks the AVLO marker"; exit 1; }
    dest="cpython/patches/$(basename "$p")"
    if [ ! -f "$dest" ] || ! cmp -s "$p" "$dest"; then
      echo "=== staging cpython patch $(basename "$p")"
      cp "$p" "$dest"
      CPY_BUST=1
    fi
  done
fi
# A lane patch deleted host-side must also leave the checkout (and rebuild).
for existing in cpython/patches/*avlo*.patch; do
  [ -e "$existing" ] || continue
  if [ ! -f "/pb/patches/cpython/$(basename "$existing")" ]; then
    echo "=== removing stale cpython patch $(basename "$existing")"
    rm -f "$existing"
    CPY_BUST=1
  fi
done
if [ "$CPY_BUST" = 1 ]; then
  # The build tree alone is not enough: the top-level Makefile links against
  # the INSTALL tree (cpython/installs/…/libpython*.a) and only descends into
  # cpython/ when that path is missing — a stale install silently satisfies it.
  echo "=== cpython patch lane changed — removing build + install trees (full cpython rebuild)"
  rm -rf "$PYBUILD_DIR" cpython/installs
  rm -f dist/pyodide.asm.* dist/python_stdlib.zip
fi
shopt -u nullglob

# link.rsp is @-consumed by the main link via MAIN_MODULE_LDFLAGS (patch 0001)
# but is NOT a make prerequisite — on incremental builds a regenerated rsp
# would silently no-op. Force the relink whenever it is fresher than the
# built glue (incremental main relink is ~19 s).
if [ -f /pb/.cache/link-sos/link.rsp ] && [ -f dist/pyodide.asm.mjs ] && [ /pb/.cache/link-sos/link.rsp -nt dist/pyodide.asm.mjs ]; then
  echo "=== link.rsp newer than built glue — forcing main relink"
  rm -f dist/pyodide.asm.*
fi

# Same staleness class for the pyodide patch queue itself: the replay above
# rewrites Makefile.envs & co. on every run, but no make rule depends on them,
# so a queue edit would silently keep the old glue. Stamp the queue hash.
QUEUE_HASH=$(cat /pb/patches/pyodide/*.patch 2>/dev/null | sha256sum | cut -d' ' -f1)
if [ ! -f .avlo-queue-stamp ] || [ "$(cat .avlo-queue-stamp)" != "$QUEUE_HASH" ]; then
  echo "=== pyodide patch queue changed — forcing main relink"
  rm -f dist/pyodide.asm.*
  echo "$QUEUE_HASH" > .avlo-queue-stamp
fi

# Top-level make runs parallel (libffi/hiwire/lzma/zstd/sqlite3/src-core are
# independent); cpython's inner sub-makes carry their own -j via PYODIDE_JOBS.
echo "=== make -j${PYODIDE_JOBS:-2} ${TARGETS}"
# shellcheck disable=SC2086
make -j"${PYODIDE_JOBS:-2}" ${TARGETS}

mkdir -p /out/raw
for f in dist/pyodide.asm.mjs dist/pyodide.asm.wasm dist/pyodide.mjs dist/python_stdlib.zip dist/pyodide.d.ts; do
  [ -f "$f" ] && cp -f "$f" /out/raw/ && echo "=== copied $f"
done
echo "=== build.sh done"
