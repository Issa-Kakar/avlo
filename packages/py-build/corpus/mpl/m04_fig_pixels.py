# self-asserting + runner-decoded: a full plot lands in /tmp/corpus-out/ and
# the runner (scripts/lib/png.mjs) decodes it — dims, ≥2 pixel values,
# <99% single color
import os

import matplotlib.pyplot as plt
import numpy as np

os.makedirs("/tmp/corpus-out", exist_ok=True)
x = np.linspace(0, 2 * np.pi, 100)
fig, ax = plt.subplots(figsize=(4, 3), dpi=100)
ax.plot(x, np.sin(x), label="sin")
ax.plot(x, np.cos(x), label="cos")
ax.legend()
ax.set_title("waves")
fig.savefig("/tmp/corpus-out/m04_waves.png", dpi=100)
plt.close(fig)
assert os.path.getsize("/tmp/corpus-out/m04_waves.png") > 5000
print("m04 ok")
