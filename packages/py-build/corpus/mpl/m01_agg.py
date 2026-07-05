# self-asserting: Agg backend renders a figure into a correctly-sized RGBA buffer
import matplotlib

assert matplotlib.__version__ == "3.8.4", matplotlib.__version__
assert matplotlib.get_backend().lower() == "agg", matplotlib.get_backend()

import matplotlib.pyplot as plt
import numpy as np

fig, ax = plt.subplots(figsize=(4, 3), dpi=100)
ax.plot([0, 1, 2], [0, 1, 0], "r-", linewidth=3)
fig.canvas.draw()
a = np.asarray(fig.canvas.buffer_rgba())
assert a.shape == (300, 400, 4), a.shape
assert (a[..., :3] < 250).any(), "nothing drawn"
plt.close(fig)
print("m01 ok")
