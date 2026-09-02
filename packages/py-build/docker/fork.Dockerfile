# check=skip=InvalidDefaultArgInFrom
# The AVLO forked-Pyodide build — canonical bytes come from THIS file only.
#
# Driven by `avlo-build fork` (src/avlo_py_build/fork.py): every pin below is a
# build-arg the driver reads out of build.config.json (the single
# reproducibility root — nothing here is hand-edited per release), and the
# `dist` stage is exported straight into dist/raw/. Build context =
# packages/py-build, narrowed by fork.Dockerfile.dockerignore to the three
# patch lanes, the link closure and one node helper — never the monorepo.
#
# Layer model (why the stages are cut where they are): BuildKit keys a
# `COPY --from=<stage> <file>` on the copied BYTES, not on the source stage's
# identity, so an expensive lane that copies only the inputs it actually reads
# stays cached when unrelated inputs change. Concretely:
#
#   src ─────► patched  (the pyodide queue applied as commits; seconds; the
#    │                   lane guard — a patch touching a path no stage below
#    │                   copies out of here fails HERE, not silently)
#    ├──────► jsdeps   (npm ci for src/js; keyed on the package lock)
#    └──────► emsdk    (emscripten install + AVLO emsdk patch; keyed on the tag
#                │       + patches/emsdk — a pyodide-queue edit never re-installs)
#                └───► cpython (libpython + libffi/hiwire/lzma/zstd/sqlite3; reads
#                        │      ONLY Makefile.envs + Setup.local from `patched` and
#                        │      the cpython lane — a JS-only queue edit is a cache HIT)
#                        └─► build (patched src/ + .git + link.rsp; the make
#                              │     targets; builtins dump; liveness gates)
#                              └─► dist (FROM scratch: exactly the exported files)
#
# Compile work is ccache'd across builds via a BuildKit cache mount, so the
# rebuild cost of a lane is dominated by its links/installs, not its compiles.
#
# Determinism: PYTHONHASHSEED=0 for every python invocation (freeze, codegen),
# SOURCE_DATE_EPOCH for clang's __DATE__/__TIME__ (getbuildinfo.c — its time
# string lands in the tail-merged .rodata string table, where a different value
# shifts every address sorted after it: the "cpython nukes are not
# byte-reproducible" finding, rooted 2026-09-02), git dates fixed so the patch
# commits get stable ids, and the raw stdlib zip normalized (sorted entries,
# fixed timestamps) so dist/raw is byte-reproducible as a whole. `avlo-build
# fork --repro` is the standing proof (two cold builds, ccache off, byte-equal).

ARG BASE_IMAGE
FROM ${BASE_IMAGE} AS src
ARG PYODIDE_REPO
ARG PYODIDE_TAG
ARG PYODIDE_COMMIT
ARG SOURCE_DATE_EPOCH
# HOME=/src mirrors upstream's run_docker (paths under /src are what
# --prefix bakes into getpath; keep them identical across the lane split).
ENV HOME=/src \
    PYTHONHASHSEED=0 \
    SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH} \
    GIT_AUTHOR_DATE="${SOURCE_DATE_EPOCH} +0000" \
    GIT_COMMITTER_DATE="${SOURCE_DATE_EPOCH} +0000" \
    GIT_AUTHOR_NAME=avlo-py-build \
    GIT_AUTHOR_EMAIL=py-build@avlo.local \
    GIT_COMMITTER_NAME=avlo-py-build \
    GIT_COMMITTER_EMAIL=py-build@avlo.local
WORKDIR /src
COPY docker/jobs.sh /q/jobs.sh
# Shallow clone at the tag, then hard-assert the pinned commit: a tag is a
# mutable ref, the commit in build.config.json is the pin.
RUN set -e; git clone --depth 1 --branch "${PYODIDE_TAG}" "${PYODIDE_REPO}" /src; \
    head="$(git rev-parse HEAD)"; \
    [ "$head" = "${PYODIDE_COMMIT}" ] || { echo "!!! pyodide ${PYODIDE_TAG} resolved to $head, config pins ${PYODIDE_COMMIT}"; exit 1; }

# ── patched: the pyodide queue, one commit per patch (bisectable in --dev) ──
# Lane guard: cpython/build copy ONLY src/, Makefile, Makefile.envs and
# cpython/Setup.local out of this stage (content-addressed — that is what
# keeps the expensive lanes cached), so a patch touching any other path
# would be silently absent from the canonical build. Extend the COPY set
# below (and the cpython stage if the path feeds libpython) when it fires.
FROM src AS patched
COPY patches/pyodide/ /q/pyodide/
RUN set -e; base="$(git rev-parse HEAD)"; \
    for p in /q/pyodide/*.patch; do \
      echo "=== applying $(basename "$p")"; git apply --index "$p"; git commit -qm "$(basename "$p")"; \
    done; \
    stray="$(git diff --name-only "$base" HEAD | grep -vE '^(src/|Makefile$|Makefile\.envs$|cpython/Setup\.local$)' || true)"; \
    [ -z "$stray" ] || { echo "!!! the pyodide queue touches paths no downstream stage copies from the patched stage:"; echo "$stray"; exit 1; }

# ── jsdeps: src/js node_modules via the Makefile's own rule ────────────────
FROM src AS jsdeps
RUN --mount=type=cache,target=/src/.npm,id=avlo-py-fork-npm \
    make node_modules/.installed

# ── emsdk: emscripten @ Makefile.envs' pin + pyodide's patches + ours ───────
# emsdk/Makefile cat|patches everything in emsdk/patches/ over the installed
# tree; the AVLO marker grep hard-fails if the dylink layer came out
# unpatched (a silently-unpatched dsoBaseHook fails only at runtime, hours
# downstream). The .emscripten touch is upstream CI's: ccache hashes its mtime.
FROM src AS emsdk
COPY patches/emsdk/ /src/emsdk/patches/
RUN set -e; EMSDK_NUM_CORES="$(nproc)" make -C emsdk; \
    grep -q AVLO emsdk/emsdk/upstream/emscripten/src/lib/libdylink.js \
      || { echo "!!! AVLO emsdk marker missing from the installed emscripten after patching"; exit 1; }; \
    touch -m -d '1 Jan 2021 12:00' emsdk/emsdk/.emscripten

# ── cpython: the interpreter + static deps, on the patched flag line ───────
# Inputs beyond the tag: Makefile.envs (patch 0001 owns it — CFLAGS_BASE feeds
# configure AND make), cpython/Setup.local (patch 0003's module list), and the
# cpython source lane (patches/cpython/, applied by cpython/Makefile's
# .patched rule at tarball extract, numbered ≥0010 to sort after upstream's).
FROM emsdk AS cpython
ARG CCACHE=1
ARG JOBS_MAKE
ARG JOBS_EMCC
COPY --from=patched /src/Makefile.envs /src/Makefile.envs
COPY --from=patched /src/cpython/Setup.local /src/cpython/Setup.local
COPY patches/cpython/ /q/cpython/
RUN --mount=type=cache,target=/ccache,id=avlo-py-fork-ccache \
    set -e; \
    for p in /q/cpython/*.patch; do \
      grep -q AVLO "$p" || { echo "!!! cpython patch $(basename "$p") lacks the AVLO marker"; exit 1; }; \
      case "$(basename "$p")" in 000[0-9]-*) echo "!!! cpython patch $(basename "$p") collides with upstream's 0001-0009 range"; exit 1;; esac; \
      cp "$p" cpython/patches/; \
    done; \
    export CCACHE_DIR=/ccache; [ "$CCACHE" = 1 ] || export CCACHE_DISABLE=1; \
    export PYODIDE_JOBS="${JOBS_MAKE:-$(sh /q/jobs.sh)}" EMCC_CORES="${JOBS_EMCC:-$(nproc)}"; \
    echo "=== make -C cpython (PYODIDE_JOBS=$PYODIDE_JOBS EMCC_CORES=$EMCC_CORES ccache=$CCACHE)"; \
    make -C cpython

# ── build: the pyodide core on top — glue, wasm, loader, stdlib zip, types ──
FROM cpython AS build
ARG CCACHE=1
ARG JOBS_MAKE
ARG JOBS_EMCC
ARG TARGETS
# src/, the top-level Makefile and .git come wholesale from the patched tree
# (rm first so a queue-deleted file cannot survive from the pristine clone).
# .git (1.7 MB, shallow) is byte-inert for make and is what gives a `--dev`
# volume seeded from this stage the one-commit-per-patch history the
# git-native patch workflow (NOTES learnings) edits.
RUN rm -rf /src/src /src/Makefile /src/.git
COPY --from=patched /src/.git /src/.git
COPY --from=patched /src/Makefile /src/Makefile
COPY --from=patched /src/src /src/src
COPY --from=jsdeps /src/src/js/node_modules /src/src/js/node_modules
# The Loop-B link closure — @-consumed by MAIN_MODULE_LDFLAGS (patch 0001) at
# exactly this path; regenerated host-side by `avlo-build link-rsp`.
COPY .cache/link-sos/link.rsp /pb/.cache/link-sos/link.rsp
COPY scripts/node/dump-builtins.mjs /q/dump-builtins.mjs
COPY docker/normalize-zip.py /q/normalize-zip.py
RUN --mount=type=cache,target=/ccache,id=avlo-py-fork-ccache \
    set -e; \
    ln -sfn src/js/node_modules/ node_modules && touch node_modules/.installed; \
    export CCACHE_DIR=/ccache; [ "$CCACHE" = 1 ] || export CCACHE_DISABLE=1; \
    export PYODIDE_JOBS="${JOBS_MAKE:-$(sh /q/jobs.sh)}" EMCC_CORES="${JOBS_EMCC:-$(nproc)}"; \
    echo "=== make -j$PYODIDE_JOBS $TARGETS"; \
    make -j"$PYODIDE_JOBS" $TARGETS; \
    echo "=== builtin-modules.json"; \
    node /q/dump-builtins.mjs dist dist/builtin-modules.json; \
    echo "=== normalize python_stdlib.zip"; \
    python3 /q/normalize-zip.py dist/python_stdlib.zip; \
    echo "=== glue liveness"; \
    for m in "snapshot DSO table drift" "loadDynlib"; do \
      grep -q "$m" dist/pyodide.asm.mjs || { echo "!!! built glue is missing \"$m\" — the emsdk/queue patches did not land"; exit 1; }; \
    done; \
    n="$(grep -o getWasmTrampolineModule dist/pyodide.asm.mjs | wc -l)"; \
    [ "$n" -ge 2 ] || { echo "!!! $n occurrence(s) of getWasmTrampolineModule (need call site + definition): the wasm-gc trampoline is dead"; exit 1; }; \
    ls -la dist

# ── dist: exactly what dist/raw holds ───────────────────────────────────────
FROM scratch AS dist
COPY --from=build /src/dist/pyodide.asm.mjs /src/dist/pyodide.asm.wasm /src/dist/pyodide.mjs \
                  /src/dist/python_stdlib.zip /src/dist/pyodide.d.ts /src/dist/builtin-modules.json /
