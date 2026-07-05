# self-asserting + runner-decoded: pandas plotting drives matplotlib
# end-to-end (pandas.plotting._matplotlib backend) and lands a decodable PNG
import os

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

os.makedirs("/tmp/corpus-out", exist_ok=True)
df = pd.DataFrame({"x": np.arange(10), "y": np.arange(10) ** 2})
ax = df.plot(x="x", y="y")
fig = ax.get_figure()
fig.savefig("/tmp/corpus-out/a01_pandas_plot.png", dpi=100)
plt.close(fig)
assert os.path.getsize("/tmp/corpus-out/a01_pandas_plot.png") > 3000
print("a01 ok")
