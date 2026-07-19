#!/usr/bin/env bash
# Part-2 harness v2: address each container by bridge IP (no host-port conflicts).
# Measures cold-start + CPU-seconds (cgroup v1) across optimized images & instance throttles.
set -u
now_ms(){ date +%s%3N; }
cpu_ns(){ cat /sys/fs/cgroup/cpuacct/docker/"$1"/cpuacct.usage 2>/dev/null || echo 0; }
mem_pk(){ cat /sys/fs/cgroup/memory/docker/"$1"/memory.max_usage_in_bytes 2>/dev/null || echo 0; }

MPL='import numpy as np, pandas as pd; import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt; df=pd.DataFrame({"x":np.arange(50),"y":np.random.rand(50).cumsum()}); plt.figure(); plt.plot(df.x,df.y); plt.title("demo"); print("rows",len(df))'

# label driver image entrypoint cpus mem env
run_profile(){
  local label="$1" driver="$2" image="$3" entry="$4" cpus="$5" mem="$6" env="$7"
  sync; echo 3 > /proc/sys/vm/drop_caches
  local eflag=""; [ -n "$entry" ] && eflag="--entrypoint $entry"
  local t0 cid fid ip; t0=$(now_ms)
  cid=$(docker run -d --cpus="$cpus" --memory="$mem" $env $eflag "$image" 2>/tmp/r.err)
  [ -z "$cid" ] && { printf "  %-44s RUN FAIL: %s\n" "$label" "$(cat /tmp/r.err)"; return 1; }
  fid=$(docker inspect -f '{{.Id}}' "$cid")
  ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$cid")
  local base="http://${ip}:3000"
  local rp; [ "$driver" = pyexec ] && rp="/health" || rp="/api/ping"
  local ready=""
  while :; do
    curl -sf -o /dev/null -m 2 "${base}${rp}" 2>/dev/null && { ready=$(now_ms); break; }
    [ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null)" != "true" ] && { printf "  %-44s DIED: %s\n" "$label" "$(docker logs "$cid" 2>&1|tail -1)"; docker rm -f "$cid">/dev/null 2>&1; return 1; }
    [ $(( $(now_ms)-t0 )) -gt 90000 ] && { printf "  %-44s TIMEOUT\n" "$label"; docker rm -f "$cid">/dev/null 2>&1; return 1; }
  done
  local t_ready=$(( ready-t0 )) boot_cpu; boot_cpu=$(cpu_ns "$fid")

  local SDKCTX="" LATV=0 OKV=0
  exec_once(){
    local s e
    if [ "$driver" = pyexec ]; then
      s=$(now_ms)
      curl -s -m 30 -X POST "${base}/exec" -H 'Content-Type: application/json' -d "$(jq -n --arg c "$MPL" '{code:$c}')" >/tmp/e.out 2>/dev/null
      e=$(now_ms); OKV=$(jq -r 'if (.images|length)>0 then 1 else 0 end' /tmp/e.out 2>/dev/null || echo 0)
    else
      s=$(now_ms)
      [ -z "$SDKCTX" ] && SDKCTX=$(curl -s -m 30 -X POST "${base}/api/contexts" -H 'Content-Type: application/json' -d '{"language":"python"}' | jq -r '.contextId // empty')
      curl -sN -m 30 -X POST "${base}/api/execute/code" -H 'Content-Type: application/json' -d "$(jq -n --arg c "$MPL" --arg x "$SDKCTX" '{context_id:$x,code:$c,language:"python"}')" >/tmp/e.out 2>/dev/null
      e=$(now_ms); OKV=$(grep -c '"png"' /tmp/e.out || true)
    fi
    LATV=$(( e-s ))
  }
  exec_once; local first=$LATV ok1=$OKV cpu1; cpu1=$(cpu_ns "$fid")
  exec_once; exec_once; local warm=$LATV; local cpu2; cpu2=$(cpu_ns "$fid")
  local mpk; mpk=$(mem_pk "$fid")
  local bcpu fcpu wcpu mmb
  bcpu=$(awk "BEGIN{printf \"%.2f\",$boot_cpu/1e9}")
  fcpu=$(awk "BEGIN{printf \"%.2f\",($cpu1-$boot_cpu)/1e9}")
  wcpu=$(awk "BEGIN{printf \"%.3f\",($cpu2-$cpu1)/2e9}")
  mmb=$(awk "BEGIN{printf \"%.0f\",$mpk/1048576}")
  printf "  %-44s ready=%5d first=%5d warm=%4d | CPUs boot=%5s first=%5s warm=%6s | mem=%4sMiB png=%s\n" \
    "$label" "$t_ready" "$first" "$warm" "$bcpu" "$fcpu" "$wcpu" "$mmb" "$ok1"
  docker rm -f "$cid" >/dev/null 2>&1
}

echo "(times ms; CPUs = core-seconds via cgroup; first=cold incl imports; warm=steady)"
echo "IMAGE / CONFIG                                 READY  FIRST  WARM | core-seconds        | MEM   PNG"
echo "============ standard-4 (cpus=4 / 12g) ============"
run_profile "SDK python (default pool)"        sdk    cloudflare/sandbox:0.12.1-python "" 4 12g ""
run_profile "SDK python (py-only pool=1)"      sdk    cloudflare/sandbox:0.12.1-python "" 4 12g "-e PYTHON_POOL_MIN_SIZE=1 -e JAVASCRIPT_POOL_MIN_SIZE=0 -e TYPESCRIPT_POOL_MIN_SIZE=0"
run_profile "pyexec raw  exec lazy"            pyexec pyexec:raw "" 4 12g ""
run_profile "pyexec opt  exec lazy"            pyexec pyexec:opt "" 4 12g ""
run_profile "pyexec opt  exec EAGER preimport" pyexec pyexec:opt "" 4 12g "-e PREIMPORT=1"
run_profile "pyexec opt  exec EAGER+FORK"      pyexec pyexec:opt "" 4 12g "-e PREIMPORT=1 -e FORK=1"
run_profile "pyexec opt  IPython"              pyexec pyexec:opt-ipython "" 4 12g ""
echo "============ basic (cpus=0.25 / 1g) ============"
run_profile "SDK python (py-only pool=1)"      sdk    cloudflare/sandbox:0.12.1-python "" 0.25 1g "-e PYTHON_POOL_MIN_SIZE=1 -e JAVASCRIPT_POOL_MIN_SIZE=0 -e TYPESCRIPT_POOL_MIN_SIZE=0"
run_profile "pyexec opt  exec lazy"            pyexec pyexec:opt "" 0.25 1g ""
run_profile "pyexec opt  exec EAGER preimport" pyexec pyexec:opt "" 0.25 1g "-e PREIMPORT=1"
run_profile "pyexec opt  exec EAGER+FORK"      pyexec pyexec:opt "" 0.25 1g "-e PREIMPORT=1 -e FORK=1"
run_profile "pyexec opt  IPython"              pyexec pyexec:opt-ipython "" 0.25 1g ""
echo "============ single-thread test: 1 vCPU (std-2) & 2 vCPU (std-3) ============"
run_profile "std-2 pyexec opt EAGER+FORK"      pyexec pyexec:opt "" 1 6g "-e PREIMPORT=1 -e FORK=1"
run_profile "std-2 SDK py-only pool=1"         sdk    cloudflare/sandbox:0.12.1-python "" 1 6g "-e PYTHON_POOL_MIN_SIZE=1 -e JAVASCRIPT_POOL_MIN_SIZE=0 -e TYPESCRIPT_POOL_MIN_SIZE=0"
run_profile "std-1 pyexec opt EAGER+FORK"      pyexec pyexec:opt "" 0.5 4g "-e PREIMPORT=1 -e FORK=1"
run_profile "std-3 pyexec opt EAGER+FORK"      pyexec pyexec:opt "" 2 8g "-e PREIMPORT=1 -e FORK=1"
echo "ALL DONE"
