# self-asserting: the random subsystem — every BitGenerator DSO loads and
# same-seed streams reproduce (version-pinned exact value for the legacy path)
import numpy as np

rs = np.random.RandomState(42)  # legacy mtrand DSO
v = rs.random_sample(4)
assert v.shape == (4,)
assert abs(float(v[0]) - 0.3745401188473625) < 1e-12, float(v[0])

# Integer-family pins (RandomState streams are contractually frozen; values
# from host numpy 2.5.1): these route through mtrand's long-typed legacy
# copies of the distributions family — renamed __avlo_legacy_* in the
# grouped side module (recipes patch 0004) so they stay disjoint from
# libnpyrandom.a's int64 copies. Exact values prove the legacy binding
# (multinomial/binomial/bounded-int) survived the group link bit-for-bit.
rs = np.random.RandomState(42)
assert rs.randint(0, 100, 5).tolist() == [51, 92, 14, 71, 60]
assert rs.multinomial(20, [0.2] * 5).tolist() == [4, 4, 2, 5, 5]
assert rs.binomial(50, 0.3, 3).tolist() == [14, 12, 16]

g1 = np.random.default_rng(123)  # PCG64 path
g2 = np.random.default_rng(123)
assert (g1.random(8) == g2.random(8)).all()

from numpy.random import MT19937, PCG64, SFC64, Philox

for bg in (MT19937, PCG64, Philox, SFC64):
    assert np.random.Generator(bg(7)).random() < 1.0
print("n02 ok")
