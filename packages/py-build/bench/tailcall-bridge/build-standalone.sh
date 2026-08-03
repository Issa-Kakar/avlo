#!/usr/bin/env bash
# Rebuild the remote agent's standalone variants (goto-O2, tc0-O2) locally,
# mirroring harness/build-variant.sh from PR #16, to split host-vs-build
# attribution for the fork-vs-standalone v0 discrepancy.
set -euo pipefail

TC=/tmp/claude-1000/-home-issak-dev-avlo/1fafb689-b850-4b87-81eb-c02996526689/scratchpad/tailcall
SRC="$TC/Python-3.14.2"
EMSDK=/home/issak/dev/avlo/packages/py-build/.work/pyodide/emsdk/emsdk
HOSTPY=/home/issak/.local/bin/python3.14

export PATH="$EMSDK/upstream/emscripten:$EMSDK/upstream/bin:$EMSDK/node/22.16.0_64bit/bin:$PATH"
export EM_CONFIG="$EMSDK/.emscripten"

build_one() {
  local ID="$1" DISPATCH="$2"
  local OUT="$TC/sa-builds/$ID" LOG="$TC/sa-logs/$ID.log"
  mkdir -p "$TC/sa-logs" "$OUT"
  rm -rf "$OUT"; mkdir -p "$OUT"

  local CFG_TAIL="" CF_EXTRA=""
  if [ "$DISPATCH" != "goto" ]; then
    CFG_TAIL="--with-tail-call-interp"
    CF_EXTRA="-mtail-call"
  fi

  cd "$OUT"
  {
    echo "#### CONFIGURE $ID"
    CONFIG_SITE="$SRC/Tools/wasm/emscripten/config.site-wasm32-emscripten" \
    HOSTRUNNER="$(command -v node)" \
    emconfigure "$SRC/configure" -C \
      CFLAGS="-DPY_CALL_TRAMPOLINE $CF_EXTRA" \
      LDFLAGS="$CF_EXTRA" \
      py_cv_module__bz2=n/a \
      py_cv_module__lzma=n/a \
      py_cv_module__ssl=n/a \
      py_cv_module__hashlib=n/a \
      py_cv_module__sqlite3=n/a \
      py_cv_module__decimal=n/a \
      py_cv_module__ctypes=n/a \
      py_cv_module__curses=n/a \
      py_cv_module__curses_panel=n/a \
      py_cv_module_readline=n/a \
      --host=wasm32-unknown-emscripten \
      --build=x86_64-pc-linux-gnu \
      --with-build-python="$HOSTPY" \
      --without-pymalloc \
      --disable-shared \
      --disable-ipv6 \
      --enable-big-digits=30 \
      --enable-wasm-dynamic-linking \
      $CFG_TAIL \
      --prefix="$OUT/install"
    echo "#### MAKE $ID"
    emmake make -j10 OPT="-DNDEBUG -fwrapv -O2 -Wall" python.mjs
  } > "$LOG" 2>&1
  cp "$SRC/Tools/wasm/emscripten/node_entry.mjs" "$OUT/"
  echo "BUILD_OK $ID wasm=$(stat -c%s "$OUT/python.wasm")"
}

# build_one sa-goto goto  # already built pre-patch (patch is tail-call-gated; goto unaffected)
build_one sa-tc0 tc0
echo ALL_DONE
