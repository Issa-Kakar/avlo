#!/usr/bin/env bash
# Cold-start + execution benchmark harness for cloudflare/sandbox:0.12.1-python
# Simulates Cloudflare instance types via --cpus / --memory.
# Measures: docker-run -> HTTP ready -> context ready -> snippet latencies (cold & warm).
set -u
IMG=cloudflare/sandbox:0.12.1-python
PORT=3000

now_ms() { date +%s%3N; }

# args: label cpus mem extra_env_flags
bench() {
  local label="$1" cpus="$2" mem="$3" envflags="$4"
  echo "==================================================================="
  echo "PROFILE: $label   (--cpus=$cpus --memory=$mem $envflags)"
  echo "==================================================================="
  # drop host page cache so first reads come from disk (cold container analog)
  sync; echo 3 > /proc/sys/vm/drop_caches

  local t0 cid
  t0=$(now_ms)
  cid=$(docker run -d --cpus="$cpus" --memory="$mem" $envflags -p ${PORT}:3000 "$IMG" 2>/tmp/run.err)
  if [ -z "$cid" ]; then echo "  RUN FAILED: $(cat /tmp/run.err)"; return 1; fi

  # 1) HTTP ready (server listening)
  local http_ready=""
  while :; do
    if curl -sf -o /dev/null "http://localhost:${PORT}/api/ping" 2>/dev/null; then http_ready=$(now_ms); break; fi
    # bail if container died
    if ! docker ps -q --no-trunc | grep -q "$cid"; then echo "  CONTAINER DIED before HTTP ready"; docker logs "$cid" 2>&1 | tail -8; docker rm -f "$cid" >/dev/null 2>&1; return 1; fi
    [ $(( $(now_ms) - t0 )) -gt 60000 ] && { echo "  HTTP ready TIMEOUT (60s)"; docker rm -f "$cid">/dev/null 2>&1; return 1; }
  done
  echo "  T_http_ready (run->/api/ping 200):        $(( http_ready - t0 )) ms"

  # 2) context ready (first POST /api/contexts succeeds == IPython bound)
  local ctx="" ctx_ready=""
  while :; do
    ctx=$(curl -s -X POST "http://localhost:${PORT}/api/contexts" -H 'Content-Type: application/json' -d '{"language":"python"}' 2>/dev/null | jq -r '.contextId // empty' 2>/dev/null)
    if [ -n "$ctx" ]; then ctx_ready=$(now_ms); break; fi
    [ $(( $(now_ms) - t0 )) -gt 90000 ] && { echo "  context ready TIMEOUT (90s)"; docker logs "$cid" 2>&1 | tail -8; docker rm -f "$cid">/dev/null 2>&1; return 1; }
  done
  echo "  T_ctx_ready  (run->context bound):         $(( ctx_ready - t0 )) ms"
  echo "  --- COLD START TOTAL (run -> ready to exec Python): $(( ctx_ready - t0 )) ms ---"

  # helper: run code on a context, return wall-ms (prints latency)
  exec_code() {
    local c="$1" code="$2" body s e
    body=$(jq -n --arg c "$code" --arg ctx "$c" '{context_id:$ctx, code:$c, language:"python"}')
    s=$(now_ms)
    curl -sN -X POST "http://localhost:${PORT}/api/execute/code" -H 'Content-Type: application/json' -d "$body" >/tmp/exec.out 2>/dev/null
    e=$(now_ms)
    echo $(( e - s ))
  }

  # 3) snippet latencies — COLD (first time on this fresh context) then WARM (repeat)
  echo "  snippet latencies (ms)            COLD  WARM"
  for pair in \
    "trivial:::print('hello')" \
    "numpy:::import numpy as np; print(np.arange(1000).sum())" \
    "pandas:::import pandas as pd, numpy as np; print(pd.DataFrame({'a':np.arange(10000)}).a.sum())" \
    "matplotlib_png:::import numpy as np; import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt; plt.plot(np.sin(np.linspace(0,10,200))); plt.title('x')" \
    ; do
    name="${pair%%:::*}"; code="${pair##*:::}"
    # fresh context per snippet to measure true COLD import on an unused IPython
    c2=$(curl -s -X POST "http://localhost:${PORT}/api/contexts" -H 'Content-Type: application/json' -d '{"language":"python"}' | jq -r '.contextId // empty')
    cold=$(exec_code "$c2" "$code")
    warm=$(exec_code "$c2" "$code")
    printf "    %-28s %8s %8s\n" "$name" "$cold" "$warm"
  done

  # 4) peak memory (RSS) of the container under load
  local memuse
  memuse=$(docker stats --no-stream --format '{{.MemUsage}}' "$cid" 2>/dev/null)
  echo "  container mem usage (after run):          $memuse"

  docker rm -f "$cid" >/dev/null 2>&1
  # free the port
  sleep 1
}

# Instance-type simulations (cpus, memory per Cloudflare table).
# Default pool (PYTHON=3,JS=3,TS=3 baked in image) unless overridden.
bench "standard-4 (4 vCPU / 12GiB) DEFAULT pool" 4    12g ""
bench "standard-1 (0.5 vCPU / 4GiB) DEFAULT pool" 0.5  4g ""
bench "basic (0.25 vCPU / 1GiB) DEFAULT pool"     0.25 1g ""
# Optimized: python-only pool of 1 (kill JS/TS prewarm, minimize boot contention)
bench "standard-1 (0.5 vCPU / 4GiB) PY-ONLY pool=1" 0.5 4g "-e PYTHON_POOL_MIN_SIZE=1 -e JAVASCRIPT_POOL_MIN_SIZE=0 -e TYPESCRIPT_POOL_MIN_SIZE=0"
bench "basic (0.25 vCPU / 1GiB) PY-ONLY pool=1"     0.25 1g "-e PYTHON_POOL_MIN_SIZE=1 -e JAVASCRIPT_POOL_MIN_SIZE=0 -e TYPESCRIPT_POOL_MIN_SIZE=0"
echo "ALL DONE"
