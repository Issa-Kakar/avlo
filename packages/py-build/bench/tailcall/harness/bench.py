"""Interpreter-dispatch benchmark suite for the wasm CPython variants.

Reports FIRST-iteration and STEADY-state separately: AVLO's real workload is
cold-to-warm (restore snapshot -> run a user block once), not steady state.
Upstream's pystone-only steady-state measurement is the reason their tail-call
verdict came out inconclusive.
"""
import json
import sys
import time

perf = time.perf_counter


# ---------- dispatch-dominated ------------------------------------------------
def bm_dispatch_tight():
    """Cheapest possible opcodes in a tight loop -> maximal dispatch signal."""
    x = 0
    for _ in range(400000):
        x = x + 1
        x = x + 1
        x = x + 1
        x = x + 1
    return x


def bm_nbody():
    bodies = [
        [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 39.47],
        [4.84, -1.16, -0.10, 0.60, 2.81, -0.02, 0.037],
        [8.34, 4.12, -0.40, -1.01, 1.82, 0.008, 0.011],
    ]
    dt = 0.001
    for _ in range(12000):
        for i, bi in enumerate(bodies):
            for bj in bodies[i + 1:]:
                dx = bi[0] - bj[0]
                dy = bi[1] - bj[1]
                dz = bi[2] - bj[2]
                d2 = dx * dx + dy * dy + dz * dz
                mag = dt / (d2 * (d2 ** 0.5))
                bi[3] -= dx * bj[6] * mag
                bi[4] -= dy * bj[6] * mag
                bi[5] -= dz * bj[6] * mag
                bj[3] += dx * bi[6] * mag
                bj[4] += dy * bi[6] * mag
                bj[5] += dz * bi[6] * mag
        for b in bodies:
            b[0] += dt * b[3]
            b[1] += dt * b[4]
            b[2] += dt * b[5]
    return bodies[0][0]


def bm_fannkuch():
    n = 8
    perm1 = list(range(n))
    count = list(range(n))
    max_flips = 0
    r = n
    perm = perm1[:]
    while True:
        while r != 1:
            count[r - 1] = r
            r -= 1
        perm = perm1[:]
        flips = 0
        k = perm[0]
        while k:
            perm[:k + 1] = perm[k::-1]
            flips += 1
            k = perm[0]
        if flips > max_flips:
            max_flips = flips
        while True:
            if r == n:
                return max_flips
            p0 = perm1[0]
            i = 0
            while i < r:
                perm1[i] = perm1[i + 1]
                i += 1
            perm1[r] = p0
            count[r] -= 1
            if count[r] > 0:
                break
            r += 1


def bm_spectralnorm():
    def a(i, j):
        return 1.0 / ((i + j) * (i + j + 1) // 2 + i + 1)

    n = 130
    u = [1.0] * n
    v = [0.0] * n
    for _ in range(6):
        for i in range(n):
            v[i] = sum(a(i, j) * u[j] for j in range(n))
        for i in range(n):
            u[i] = sum(a(j, i) * v[j] for j in range(n))
    return sum(u)


# ---------- call-dominated ----------------------------------------------------
def bm_fib():
    def fib(k):
        return k if k < 2 else fib(k - 1) + fib(k - 2)
    return fib(25)


def bm_binary_trees():
    def make(d):
        return None if d == 0 else (make(d - 1), make(d - 1))

    def check(t):
        return 1 if t is None else 1 + check(t[0]) + check(t[1])

    total = 0
    for _ in range(12):
        total += check(make(12))
    return total


def bm_meth_noargs():
    """C-method calls (METH_NOARGS) -> the trampoline/C-call path."""
    x = 12345678901234567890
    n = 0
    for _ in range(200000):
        n += x.bit_length()
    return n


# ---------- object / library --------------------------------------------------
def bm_dict_ops():
    d = {}
    for i in range(120000):
        d[i & 8191] = i
    s = 0
    for i in range(120000):
        s += d[i & 8191]
    return s


def bm_str_ops():
    parts = []
    for i in range(60000):
        parts.append("item-%d" % i)
    s = "".join(parts)
    return len(s)


def bm_json_roundtrip():
    import json as _j
    obj = {"a": list(range(200)), "b": {"c": "x" * 200, "d": [1.5] * 200}}
    n = 0
    for _ in range(600):
        n += len(_j.loads(_j.dumps(obj))["a"])
    return n


def bm_pystone():
    """Loop/branch/struct mix, kept for comparability with pyodide PR #6122."""
    class Rec:
        __slots__ = ("ptr", "disc", "en", "num", "s")

        def __init__(self):
            self.ptr = None
            self.disc = 0
            self.en = 0
            self.num = 0
            self.s = ""

    def f(a, b):
        return a + b if a > b else a - b

    total = 0
    r = Rec()
    for i in range(90000):
        r.num = i
        r.disc = i & 3
        if r.disc == 0:
            total += f(i, 7)
        elif r.disc == 1:
            total -= f(i, 3)
        elif r.disc == 2:
            total ^= i & 255
        else:
            total += 1
    return total


BENCHMARKS = [
    ("dispatch_tight", bm_dispatch_tight),
    ("nbody", bm_nbody),
    ("fannkuch", bm_fannkuch),
    ("spectralnorm", bm_spectralnorm),
    ("fib", bm_fib),
    ("binary_trees", bm_binary_trees),
    ("meth_noargs", bm_meth_noargs),
    ("dict_ops", bm_dict_ops),
    ("str_ops", bm_str_ops),
    ("json_roundtrip", bm_json_roundtrip),
    ("pystone", bm_pystone),
]


def main():
    iters = int(sys.argv[1]) if len(sys.argv) > 1 else 7
    only = sys.argv[2] if len(sys.argv) > 2 else None
    out = {}
    for name, fn in BENCHMARKS:
        if only and only != name:
            continue
        times = []
        for _ in range(iters):
            t0 = perf()
            fn()
            times.append((perf() - t0) * 1000.0)
        ordered = sorted(times)
        out[name] = {
            "first": times[0],
            "min": ordered[0],
            "median": ordered[len(ordered) // 2],
            "all": [round(t, 3) for t in times],
        }
    print("BENCH_JSON:" + json.dumps(out))


if __name__ == "__main__":
    main()
