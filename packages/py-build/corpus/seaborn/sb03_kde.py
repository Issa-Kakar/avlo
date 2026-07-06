# self-asserting + runner-decoded: kdeplot runs on the VENDORED gaussian_kde
# (seaborn/external/kde.py) — scipy must never enter sys.modules
import os
import sys

import matplotlib.pyplot as plt
import numpy as np
import seaborn as sns

os.makedirs("/tmp/corpus-out", exist_ok=True)
rng = np.random.default_rng(11)
ax = sns.kdeplot(x=rng.normal(size=200))
assert "scipy" not in sys.modules
fig = ax.get_figure()
fig.savefig("/tmp/corpus-out/sb03_kde.png", dpi=100)
plt.close(fig)
print("sb03 ok")
