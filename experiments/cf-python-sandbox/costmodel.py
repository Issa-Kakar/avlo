#!/usr/bin/env python3
"""Parametric cost model for Cloudflare Sandbox SDK Python execution.
Pricing: Cloudflare Containers (post 2025-11-21), Workers Paid, Durable Objects.
All rates USD. Memory+disk bill on PROVISIONED allocation while RUNNING; CPU on ACTIVE usage.
"""

# ---- Pricing constants (sources in report) ----
MEM_RATE  = 2.5e-6     # $/GiB-second   (provisioned, while awake)
CPU_RATE  = 2.0e-5     # $/vCPU-second  (active usage only)
DISK_RATE = 7.0e-8     # $/GB-second    (provisioned, while awake)
WORKERS_REQ = 0.30/1e6 # $/request beyond 10M free
DO_REQ      = 0.15/1e6 # $/request beyond 1M free
DO_DUR_RATE = 12.50/1e6# $/GB-second beyond 400k GB-s free
DO_MEM_GB   = 0.128    # DO billed at 128MB regardless of usage
EGRESS_RATE = 0.025    # $/GB NA/EU beyond 1TB free

# ---- Instance types: (mem GiB, vCPU, disk GB) ----
INSTANCES = {
    "lite":       (0.25,  1/16, 2),
    "basic":      (1.0,   1/4,  4),
    "standard-1": (4.0,   1/2,  8),
    "standard-2": (6.0,   1.0,  12),
    "standard-3": (8.0,   2.0,  16),
    "standard-4": (12.0,  4.0,  20),
}

# ---- Measured cold-start (container-internal, run->python-ready) seconds ----
# From local harness (Docker --cpus throttle). EXCLUDES CF image-pull/placement.
T_COLD = {"standard-4": 1.36, "standard-1": 4.06, "basic": 8.41}
# Representative first-snippet exec (cold import) + warm exec seconds
T_EXEC_COLD = {"standard-4": 0.85, "standard-1": 1.84, "basic": 3.57}  # matplotlib snippet, cold imports
T_EXEC_WARM = {"standard-4": 0.14, "standard-1": 0.32, "basic": 0.59}

# Active CPU-seconds consumed during cold boot + first exec (approx = wall * vcpu_fraction,
# CPU-bound prewarm/imports). Conservative.
def cpu_seconds(inst, wall_active_s):
    _, vcpu, _ = INSTANCES[inst]
    return wall_active_s * vcpu  # throttled CPU-bound work

def per_exec_cost(inst, strategy, keepalive_s=30.0, egress_kb=50,
                  session_execs=1, think_gap_s=8.0):
    """Cost for ONE execution under a strategy.
    strategy: 'destroy' (kill right after), 'keepalive' (sleepAfter=keepalive_s),
              'warm_amortized' handled separately.
    session_execs/think_gap: for amortizing keepalive across a multi-snippet session.
    """
    mem, vcpu, disk = INSTANCES[inst]
    tcold = T_COLD[inst]; tew = T_EXEC_WARM[inst]; tec = T_EXEC_COLD[inst]

    if strategy == "destroy":
        # one cold container per execution, killed immediately after
        awake = tcold + tec
        active_cpu = cpu_seconds(inst, tcold*0.7 + tec)  # ~70% of boot is CPU-bound
    elif strategy == "keepalive":
        # amortize: a session of N execs keeps the container warm; trailing keepalive idle once.
        # awake = cold + first(cold-exec) + (N-1)*(gap + warm-exec) + keepalive_trailing
        N = session_execs
        awake = tcold + tec + (N-1)*(think_gap_s + tew) + keepalive_s
        active_cpu = cpu_seconds(inst, tcold*0.7 + tec + (N-1)*tew)
        awake /= N      # cost attributed per execution
        active_cpu /= N
    else:
        raise ValueError(strategy)

    c_mem  = awake * mem  * MEM_RATE
    c_cpu  = active_cpu   * CPU_RATE
    c_disk = awake * disk * DISK_RATE
    # request layer: 1 Worker req + 1 DO req + DO duration over awake window
    c_wreq = WORKERS_REQ
    c_doreq= DO_REQ
    c_dodur= awake * DO_MEM_GB * DO_DUR_RATE
    c_egr  = (egress_kb/1e6) * EGRESS_RATE
    total = c_mem + c_cpu + c_disk + c_wreq + c_doreq + c_dodur + c_egr
    return dict(inst=inst, strategy=strategy, awake_s=round(awake,2),
                mem=c_mem, cpu=c_cpu, disk=c_disk, wreq=c_wreq, doreq=c_doreq,
                dodur=c_dodur, egress=c_egr, total=total)

def warm_pool_cost(inst, pool_size, execs_per_month):
    """Shared always-on warm pool of N instances. Cost = N instances running 730h/mo
    (memory+disk continuous, CPU only during the execs). Cold start ~0 for users."""
    mem, vcpu, disk = INSTANCES[inst]
    secs_month = 730*3600
    c_mem  = pool_size * secs_month * mem  * MEM_RATE
    c_disk = pool_size * secs_month * disk * DISK_RATE
    # CPU: only during actual executions (warm exec)
    cpu_per = cpu_seconds(inst, T_EXEC_WARM[inst])
    c_cpu  = execs_per_month * cpu_per * CPU_RATE
    # request layer
    c_req  = execs_per_month * (max(0, 1) ) # placeholder
    c_wreq = max(0, execs_per_month-10_000_000) * WORKERS_REQ
    c_doreq= max(0, execs_per_month-1_000_000) * DO_REQ
    total = c_mem + c_disk + c_cpu + c_wreq + c_doreq
    return dict(inst=inst, pool=pool_size, mem=c_mem, disk=c_disk, cpu=c_cpu,
                wreq=c_wreq, doreq=c_doreq, total=total, per_exec=total/execs_per_month)

def fmt(d):
    return (f"  {d['inst']:11s} {d['strategy']:10s} awake={d['awake_s']:6.2f}s  "
            f"mem=${d['mem']*1e6:7.2f}µ cpu=${d['cpu']*1e6:6.2f}µ disk=${d['disk']*1e6:5.2f}µ "
            f"dodur=${d['dodur']*1e6:6.2f}µ  TOTAL=${d['total']*1e6:8.2f}µ  (${d['total']:.6f}/exec)")

if __name__ == "__main__":
    print("="*100)
    print("PER-EXECUTION COST  (µ = millionths of a dollar; 1µ = $0.000001)")
    print("="*100)
    print("\n-- Strategy: DESTROY immediately after each exec (1 cold container / exec) --")
    for inst in ["basic","standard-1","standard-4"]:
        print(fmt(per_exec_cost(inst, "destroy")))
    print("\n-- Strategy: KEEPALIVE 30s, single one-off exec (worst case, N=1) --")
    for inst in ["basic","standard-1","standard-4"]:
        print(fmt(per_exec_cost(inst, "keepalive", keepalive_s=30, session_execs=1)))
    print("\n-- Strategy: KEEPALIVE 30s, amortized over a 10-snippet session (N=10, 8s gaps) --")
    for inst in ["basic","standard-1","standard-4"]:
        print(fmt(per_exec_cost(inst, "keepalive", keepalive_s=30, session_execs=10)))
    print("\n-- Strategy: KEEPALIVE 10s, amortized over a 10-snippet session --")
    for inst in ["basic","standard-1","standard-4"]:
        print(fmt(per_exec_cost(inst, "keepalive", keepalive_s=10, session_execs=10)))

    print("\n"+"="*100)
    print("MONTHLY COST AT SCALE  (compute + request layers; + $5 Workers Paid base)")
    print("="*100)
    for volume in [10_000, 100_000, 1_000_000, 10_000_000]:
        print(f"\n--- {volume:,} executions / month ---")
        for inst in ["basic","standard-1","standard-4"]:
            d = per_exec_cost(inst,"destroy")
            ka = per_exec_cost(inst,"keepalive",keepalive_s=30,session_execs=10)
            print(f"  {inst:11s}  destroy: ${d['total']*volume:9.2f}   "
                  f"keepalive30/session10: ${ka['total']*volume:9.2f}")

    print("\n"+"="*100)
    print("SHARED WARM POOL (zero cold start for users) — monthly")
    print("="*100)
    for volume in [100_000, 1_000_000, 10_000_000]:
        print(f"\n--- {volume:,} execs/month ---")
        for inst in ["basic","standard-1"]:
            for pool in [1,3,10]:
                w = warm_pool_cost(inst, pool, volume)
                print(f"  {inst:11s} pool={pool:2d}: ${w['total']:9.2f}/mo  "
                      f"(${w['per_exec']:.6f}/exec)  [mem ${w['mem']:.0f} + cpu ${w['cpu']:.2f}]")
