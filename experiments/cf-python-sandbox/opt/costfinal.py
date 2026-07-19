#!/usr/bin/env python3
"""FINAL cost model — measured cgroup CPU core-seconds (not wall*vCPU). Pricing verbatim from CF docs."""
MEM=2.5e-6; CPU=2.0e-5; DISK=7.0e-8           # $/GiB-s, $/vCPU-s(active), $/GB-s
WREQ=0.30/1e6; DOREQ=0.15/1e6; DODUR=12.50/1e6; DOMEM=0.128
INST={"basic":(1,0.25,4),"standard-1":(4,0.5,8),"standard-2":(6,1,12),"standard-3":(8,2,16),"standard-4":(12,4,20)}

# Measured (bench2.sh): ready, first, warm [s]; cpu_cold = boot+first core-s; cpu_warm core-s
# (cold+first result latency = ready+first)
M={
 ("SDK py-only","standard-4"): (0.730,1.898,0.133, 0.28+2.65, 0.119),
 ("SDK py-only","standard-2"): (0.619,2.473,0.155, 0.25+2.39, 0.110),
 ("SDK py-only","basic"):      (1.135,10.893,0.500,0.27+2.71, 0.124),
 ("opt lazy","standard-4"):    (0.561,1.136,0.114, 0.15+1.26, 0.102),
 ("opt lazy","basic"):         (0.838,4.308,0.393, 0.16+1.09, 0.104),
 ("opt EAGER+FORK","standard-4"):(1.707,0.151,0.148,1.37+0.14,0.141),
 ("opt EAGER+FORK","standard-3"):(1.746,0.153,0.150,1.36+0.15,0.146),
 ("opt EAGER+FORK","standard-2"):(1.704,0.149,0.145,1.25+0.14,0.144),
 ("opt EAGER+FORK","standard-1"):(3.127,0.283,0.302,1.39+0.14,0.152),
 ("opt EAGER+FORK","basic"):     (5.135,0.606,0.598,1.24+0.16,0.161),
}

def per_exec(img,inst,strat,ka=0,N=1,gap=8,egress_kb=60):
    mem,vcpu,disk=INST[inst]; ready,first,warm,ccold,cwarm=M[(img,inst)]
    if strat=="destroy": awake=ready+first; cpu=ccold
    else:  # session of N, warm across, trailing keepalive once
        awake=(ready+first+(N-1)*(gap+warm)+ka)/N; cpu=(ccold+(N-1)*cwarm)/N
    c=awake*mem*MEM + cpu*CPU + awake*disk*DISK + WREQ+DOREQ + awake*DOMEM*DODUR + egress_kb/1e6*0.025
    return awake,c

def hourly_idle(inst):  # cost to keep a per-user container AWAKE & idle, $/hour (mem+disk only; CPU~0 idle)
    mem,vcpu,disk=INST[inst]; return (mem*MEM+disk*DISK)*3600

print("COLD-START → FIRST RESULT (measured, container-internal; +CF placement/network on top)")
print(f"  {'config':22s}{'instance':12s}{'ready':>7s}{'first':>7s}{'=total':>8s}{'warm':>7s}{'cpu_cold':>9s}")
order=[("opt EAGER+FORK","basic"),("opt EAGER+FORK","standard-1"),("opt EAGER+FORK","standard-2"),
 ("opt EAGER+FORK","standard-3"),("opt EAGER+FORK","standard-4"),("opt lazy","standard-4"),
 ("SDK py-only","standard-2"),("SDK py-only","standard-4"),("SDK py-only","basic")]
for img,inst in order:
    r,f,w,cc,cw=M[(img,inst)]
    print(f"  {img:22s}{inst:12s}{r*1000:6.0f}m{f*1000:6.0f}m{(r+f)*1000:7.0f}m{w*1000:6.0f}m{cc:8.2f}s")

print("\nPER-EXECUTION COST ($/exec) and MONTHLY at 100k / 1M execs (compute+req; +$5 base flat)")
print(f"  {'config':22s}{'instance':12s}{'strategy':20s}{'awake':>7s}{'$/exec':>11s}{'@100k':>9s}{'@1M':>9s}")
for img,inst in order:
    for name,(strat,ka,N) in {"destroy":("destroy",0,1),"sess10 ka=10s":("s",10,10),"sess10 ka=30s":("s",30,10)}.items():
        aw,c=per_exec(img,inst,"destroy" if strat=="destroy" else "session",ka=ka,N=N)
        print(f"  {img:22s}{inst:12s}{name:20s}{aw:6.2f}s ${c*1e6:8.2f}µ ${c*1e5:7.2f} ${c*1e6:7.2f}")

print("\nPER-USER CONTAINER: cost to keep ONE user's container AWAKE (idle keepalive), by instance:")
for inst in INST: print(f"  {inst:12s} ${hourly_idle(inst)*100:6.3f} /100s   ${hourly_idle(inst):6.3f} /hour   (mem+disk; CPU~0 when idle)")
print("\nScenario: 1000 concurrent users each holding a warm container 1hr/day, 30 days:")
for inst in ["basic","standard-1","standard-2","standard-4"]:
    print(f"  {inst:12s} ${hourly_idle(inst)*1000*30:9.0f}/mo  (1000 users x 1hr/day x 30d, idle mem+disk only)")
print("\nScenario: sporadic — 1M one-off execs/mo, destroy-after (no idle):")
for img,inst in [("opt EAGER+FORK","standard-2"),("opt lazy","standard-4"),("SDK py-only","standard-4")]:
    _,c=per_exec(img,inst,"destroy"); print(f"  {img:22s}{inst:12s} ${c*1e6:9.0f}/mo + $5 base")
