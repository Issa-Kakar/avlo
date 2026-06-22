#!/usr/bin/env python3
"""Corrected cost model — uses MEASURED cgroup CPU-seconds (single-threaded Python => ~1 core,
not wall*full-vCPU). Pricing verified verbatim from Cloudflare docs 2026-06."""

MEM_RATE  = 2.5e-6      # $/GiB-s  (provisioned, while awake)
CPU_RATE  = 2.0e-5      # $/vCPU-s (ACTIVE core-seconds only)
DISK_RATE = 7.0e-8      # $/GB-s   (provisioned, while awake)
WORKERS_REQ = 0.30/1e6
DO_REQ      = 0.15/1e6
DO_DUR_RATE = 12.50/1e6 # $/GB-s ; DO billed at 128MB
DO_MEM_GB   = 0.128
BASE_MONTHLY = 5.0      # Workers Paid flat fee (NOT per-exec)

# instance: (mem GiB, vCPU_alloc, disk GB)   -- vCPU_alloc only caps; CPU billed on measured core-s
INST = {"basic":(1.0,0.25,4),"standard-1":(4.0,0.5,8),"standard-2":(6.0,1.0,12),
        "standard-3":(8.0,2.0,16),"standard-4":(12.0,4.0,20)}

# MEASURED from bench2.sh (filled from harness). Keys: (image, instance)
# values: dict(ready, first, warm  [seconds];  first_cpu, warm_cpu [core-seconds, cgroup])
M = {}
def put(img, inst, ready, first, warm, first_cpu, warm_cpu):
    M[(img,inst)] = dict(ready=ready, first=first, warm=warm, first_cpu=first_cpu, warm_cpu=warm_cpu)

# ---- PLACEHOLDERS — replaced with measured values after harness ----
# (filled in by fill_measured() below once we have numbers)

def cost_per_exec(img, inst, strategy, keepalive_s=0.0, N=1, gap_s=8.0, egress_kb=60):
    mem, vcpu, disk = INST[inst]
    m = M[(img,inst)]
    if strategy == "destroy":
        awake = m["ready"] + m["first"]
        cpu   = m["first_cpu"]
    elif strategy == "session":           # N execs, container warm across session, trailing keepalive once
        awake = m["ready"] + m["first"] + (N-1)*(gap_s + m["warm"]) + keepalive_s
        cpu   = m["first_cpu"] + (N-1)*m["warm_cpu"]
        awake /= N; cpu /= N
    c_mem  = awake*mem*MEM_RATE
    c_cpu  = cpu*CPU_RATE
    c_disk = awake*disk*DISK_RATE
    c_req  = WORKERS_REQ + DO_REQ + awake*DO_MEM_GB*DO_DUR_RATE
    c_egr  = (egress_kb/1e6)*0.025
    tot = c_mem+c_cpu+c_disk+c_req+c_egr
    return dict(awake=awake, mem=c_mem, cpu=c_cpu, disk=c_disk, req=c_req, total=tot)

def show(img):
    print(f"\n### {img}")
    print(f"  {'instance':11s} {'strategy':22s} {'awake':>7s} {'mem$':>9s} {'cpu$':>9s} {'total/exec':>11s}  {'@1M/mo':>9s} {'@100k/mo':>9s}")
    for inst in [i for i in INST if (img,i) in M]:
        rows = [("destroy now", cost_per_exec(img,inst,"destroy")),
                ("session10 ka=10s", cost_per_exec(img,inst,"session",keepalive_s=10,N=10)),
                ("session10 ka=30s", cost_per_exec(img,inst,"session",keepalive_s=30,N=10)),
                ("one-off ka=30s",   cost_per_exec(img,inst,"session",keepalive_s=30,N=1))]
        for name,d in rows:
            print(f"  {inst:11s} {name:22s} {d['awake']:6.2f}s ${d['mem']*1e6:7.2f}µ ${d['cpu']*1e6:7.2f}µ "
                  f"${d['total']*1e6:9.2f}µ  ${d['total']*1e6:7.2f}  ${d['total']*1e5:7.2f}")

if __name__ == "__main__":
    import sys
    exec(open(sys.argv[1]).read()) if len(sys.argv)>1 else None  # load measured table
    for img in sorted({k[0] for k in M}):
        show(img)
    print(f"\n(+ ${BASE_MONTHLY:.0f}/mo Workers Paid base, flat. @1M and @100k columns are $/month for that volume, compute+requests only.)")
