# self-asserting: the random subsystem — every BitGenerator DSO loads and
# same-seed streams reproduce (version-pinned exact value for the legacy path)
import numpy as np

rs = np.random.RandomState(42)  # legacy mtrand DSO
v = rs.random_sample(4)
assert v.shape == (4,)
assert abs(float(v[0]) - 0.3745401188473625) < 1e-12, float(v[0])

g1 = np.random.default_rng(123)  # PCG64 path
g2 = np.random.default_rng(123)
assert (g1.random(8) == g2.random(8)).all()

from numpy.random import MT19937, PCG64, SFC64, Philox

for bg in (MT19937, PCG64, Philox, SFC64):
    assert np.random.Generator(bg(7)).random() < 1.0
print("n02 ok")
