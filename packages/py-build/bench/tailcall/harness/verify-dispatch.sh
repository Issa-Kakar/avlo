#!/usr/bin/env bash
# Verify each build actually emits the dispatch shape we think it does.
# Without -mtail-call, clang silently ignores musttail (warning only), so a
# "tail-call" build can be a lie. This is the gate.
TC=/tmp/claude-0/-home-user-avlo/80de0d9c-acb2-50c4-9c1a-d238eb42e5f5/scratchpad/tc
cd "$TC"
WAT=/tmp/verify.wat

printf '%-10s %14s %14s %10s\n' variant return_call return_call_ind br_table
for d in builds/*/; do
  v=$(basename "$d")
  [ -f "$d/python.wasm" ] || continue
  ./emsdk/upstream/bin/wasm-dis --all-features "$d/python.wasm" -o "$WAT" 2>/dev/null || { echo "$v DIS_FAIL"; continue; }
  rc=$(grep -c '(return_call ' "$WAT" || true)
  ri=$(grep -c '(return_call_indirect' "$WAT" || true)
  bt=$(grep -c 'br_table' "$WAT" || true)
  printf '%-10s %14s %14s %10s\n' "$v" "$rc" "$ri" "$bt"
  rm -f "$WAT"
done
