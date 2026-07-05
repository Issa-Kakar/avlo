# self-asserting: lazy submodule imports AFTER mount (post-mount FS reads +
# pyc loading)
import numpy as np
import numpy.testing as npt

npt.assert_allclose(np.array([1.0, 2.0]), np.array([1.0, 2.0]))

from numpy import ma

assert int(ma.masked_array([1, 2], mask=[0, 1]).sum()) == 1

import numpy.polynomial as P

assert float(P.Polynomial([1, 2])(2.0)) == 5.0
print("n03 ok")
