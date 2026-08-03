#!/usr/bin/env bash
# Build one CPython-3.14.2-for-wasm variant.
#   build-variant.sh <id> <dispatch> <optlevel>
#     dispatch: goto | tc0 | tc1 | tc2 | tc3 | tc4 | tc6
#     optlevel: 2 | 3
set -euo pipefail

ID="$1"; DISPATCH="$2"; OPT_LEVEL="$3"

TC=/tmp/claude-0/-home-user-avlo/80de0d9c-acb2-50c4-9c1a-d238eb42e5f5/scratchpad/tc
SRC="$TC/src/Python-3.14.2"
HOSTPY="$SRC/builddir/build/python"
OUT="$TC/builds/$ID"
LOG="$TC/logs/$ID.log"

mkdir -p "$TC/logs" "$TC/builds"
rm -rf "$OUT"; mkdir -p "$OUT"

source "$TC/emsdk/emsdk_env.sh" >/dev/null 2>&1

# ---- variant flags -----------------------------------------------------------
CFG_TAIL=""
CF_EXTRA=""
if [ "$DISPATCH" != "goto" ]; then
  CFG_TAIL="--with-tail-call-interp"
  CF_EXTRA="-mtail-call"
  MODE="${DISPATCH#tc}"
  if [ "$MODE" != "0" ]; then
    CF_EXTRA="$CF_EXTRA -DTAIL_CALL_DISPATCH_MODE=$MODE"
  fi
fi

OPTV="-DNDEBUG -fwrapv -O${OPT_LEVEL} -Wall"

cd "$OUT"

{
echo "############ CONFIGURE $ID (dispatch=$DISPATCH O$OPT_LEVEL) ############"
CONFIG_SITE="$SRC/Tools/wasm/emscripten/config.site-wasm32-emscripten" \
HOSTRUNNER="$TC/tools/node26/bin/node" \
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

# LINKFORSHARED is emitted by configure with a hard-coded `-O2 -g0` and is the
# LAST thing on the link line, so it wins over any LDFLAGS we pass. Rewrite it
# so the link-time (wasm-opt/binaryen) level tracks the compile-time level.
LFS="$(sed -n 's/^LINKFORSHARED=[[:space:]]*//p' Makefile | head -1)"
LFS_NEW="$(printf '%s' "$LFS" | sed "s/-O2 -g0/-O${OPT_LEVEL} -g0/")"
echo "### LINKFORSHARED -> $LFS_NEW"

echo "############ MAKE $ID ############"
emmake make -j4 OPT="$OPTV" LINKFORSHARED="$LFS_NEW" python.mjs
cp "$SRC/Tools/wasm/emscripten/node_entry.mjs" "$OUT/"
} > "$LOG" 2>&1

echo "BUILD_OK $ID  wasm=$(stat -c%s "$OUT/python.wasm") mjs=$(stat -c%s "$OUT/python.mjs")"
