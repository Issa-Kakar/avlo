import time, json, sys

r = range

def bench(fn, n, reps=3):
    best = 1e18
    for _ in range(reps):
        t0 = time.perf_counter(); fn(n); t1 = time.perf_counter()
        best = min(best, t1 - t0)
    return best * 1e9 / n  # ns/op

def pass_loop(n):
    for _ in r(n): pass

def meth_noargs(n):  # bit_length: METH_NOARGS -> trampoline
    q = (12345678901234).bit_length
    for _ in r(n): q()

def meth_o(n):  # len: METH_O -> trampoline
    f = len; s = 'abc'
    for _ in r(n): f(s)

def fastcall(n):  # str.split: METH_FASTCALL|KEYWORDS -> direct (control)
    f = 'a b'.split
    for _ in r(n): f()

def getset(n):  # complex.real: getset descriptor -> trampoline
    c = 3 + 4j
    for _ in r(n): c.real

def tuple_alloc(n):  # allocator-heavy
    for i in r(n): t = (i, i)

def list_grow(n):  # append: METH_O -> trampoline + allocator
    l = []
    ap = l.append
    for i in r(n): ap(i)

def dict_set(n):
    d = {}
    for i in r(n): d[i & 1023] = i

def pycall(n):  # pure-python call, no trampoline
    def f(x): return x
    for i in r(n): f(i)

def cls_inst(n):  # object alloc + tp_new path
    class P:
        __slots__ = ('x', 'y')
        def __init__(self, x, y): self.x = x; self.y = y
    for i in r(n): P(i, i)

def json_round(n):  # macro: C extension calls + alloc mix
    obj = {'a': [1, 2, 3], 'b': 'text', 'c': {'d': 4.5}}
    du = json.dumps; lo = json.loads
    for _ in r(n): lo(du(obj))

def fib_rec(n):  # recursion depth workload, n calls approx
    def F(k):
        return k if k < 2 else F(k - 1) + F(k - 2)
    F(21)

TESTS = [
    ('pass_loop',   pass_loop,   2_000_000),
    ('meth_noargs', meth_noargs, 1_000_000),
    ('meth_o',      meth_o,      1_000_000),
    ('fastcall',    fastcall,      500_000),
    ('getset',      getset,      1_000_000),
    ('tuple_alloc', tuple_alloc, 1_000_000),
    ('list_grow',   list_grow,   1_000_000),
    ('dict_set',    dict_set,    1_000_000),
    ('pycall',      pycall,      1_000_000),
    ('cls_inst',    cls_inst,      300_000),
    ('json_round',  json_round,     20_000),
    ('fib_rec',     fib_rec,        35_421),
]

def run_suite():
    out = {}
    for name, fn, n in TESTS:
        out[name] = round(bench(fn, n), 2)
    return out

result = json.dumps({'suite': run_suite()})
