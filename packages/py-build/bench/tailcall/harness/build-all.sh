#!/usr/bin/env bash
# Build the full variant matrix. goto-O2 already built; skip if present.
TC=/tmp/claude-0/-home-user-avlo/80de0d9c-acb2-50c4-9c1a-d238eb42e5f5/scratchpad/tc
cd "$TC"

# id            dispatch  opt
MATRIX="
goto-O2   goto  2
goto-O3   goto  3
tc0-O2    tc0   2
tc0-O3    tc0   3
tc3-O3    tc3   3
tc4-O3    tc4   3
tc6-O3    tc6   3
tc1-O3    tc1   3
tc2-O3    tc2   3
tc5-O3    tc5   3
"

echo "$MATRIX" | while read -r id disp opt; do
  [ -z "$id" ] && continue
  if [ -f "$TC/builds/$id/python.wasm" ]; then
    echo "SKIP $id (already built)"
    continue
  fi
  start=$(date +%s)
  if ./build-variant.sh "$id" "$disp" "$opt"; then
    echo "  ^ $(( $(date +%s) - start ))s"
  else
    echo "BUILD_FAIL $id  (see logs/$id.log)"
    tail -15 "$TC/logs/$id.log" | sed 's/^/    /'
  fi
done
echo "MATRIX_DONE"
