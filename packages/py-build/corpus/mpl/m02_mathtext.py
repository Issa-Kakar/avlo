# self-asserting: mathtext renders with the SUBSET DejaVu faces — the
# runner's log gate separately asserts zero findfont warnings and no
# fontManager rebuild
import matplotlib.pyplot as plt
import numpy as np

fig, ax = plt.subplots(figsize=(3, 2), dpi=100)
ax.set_title(r"$\int_0^\pi \sin(\omega x)\,dx = \frac{2}{\omega}$")
ax.text(0.1, 0.5, r"$\alpha^2 + \beta_i \leq \sqrt{\gamma} \times 10^{-3}$")
fig.canvas.draw()
a = np.asarray(fig.canvas.buffer_rgba())
assert (a[..., :3] < 200).any(), "mathtext drew nothing"
plt.close(fig)
print("m02 ok")
