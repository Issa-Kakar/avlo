# self-asserting: numpy core — pinned version, ufuncs, linalg + fft DSOs
import numpy as np

assert np.__version__ == "2.4.3", np.__version__
a = np.ones(4)
assert float(a.sum()) == 4.0
b = np.arange(12, dtype=np.float64).reshape(3, 4)
assert (b @ b.T).shape == (3, 3)
assert abs(float(np.linalg.det(np.eye(3))) - 1.0) < 1e-12
f = np.fft.fft(np.array([1.0, 0.0, 0.0, 0.0]))
assert abs(complex(f[0]) - (1 + 0j)) < 1e-12
x = np.array([1, 2, 3], dtype=np.int64)
assert int((x * x).sum()) == 14
print("n01 ok")
