# self-asserting + runner-decoded: heatmap with annotations (text + colormap)
import os

import matplotlib.pyplot as plt
import numpy as np
import seaborn as sns

os.makedirs("/tmp/corpus-out", exist_ok=True)
rng = np.random.default_rng(3)
ax = sns.heatmap(rng.uniform(size=(6, 6)), annot=True, fmt=".1f")
fig = ax.get_figure()
fig.savefig("/tmp/corpus-out/sb02_heatmap.png", dpi=100)
plt.close(fig)
assert os.path.getsize("/tmp/corpus-out/sb02_heatmap.png") > 5000
print("sb02 ok")
