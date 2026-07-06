# self-asserting + runner-decoded: seaborn scatterplot with hue -> PNG
import os

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns

os.makedirs("/tmp/corpus-out", exist_ok=True)
assert sns.__version__ == "0.13.2", sns.__version__
rng = np.random.default_rng(7)
df = pd.DataFrame({"x": rng.normal(size=60), "y": rng.normal(size=60), "k": ["a", "b"] * 30})
ax = sns.scatterplot(data=df, x="x", y="y", hue="k")
fig = ax.get_figure()
fig.savefig("/tmp/corpus-out/sb01_scatter.png", dpi=100)
plt.close(fig)
assert os.path.getsize("/tmp/corpus-out/sb01_scatter.png") > 5000
print("sb01 ok")
