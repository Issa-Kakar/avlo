# self-asserting + runner-decoded: set_theme restyles rc and plots cleanly
# under the subset fonts (the group's font gates assert no findfont fallout)
import os

import matplotlib.pyplot as plt
import numpy as np
import seaborn as sns

os.makedirs("/tmp/corpus-out", exist_ok=True)
sns.set_theme()
x = np.linspace(0, 4, 50)
ax = sns.lineplot(x=x, y=np.sin(x))
ax.set_title("themed")
fig = ax.get_figure()
fig.savefig("/tmp/corpus-out/sb04_theme.png", dpi=100)
plt.close(fig)
sns.reset_defaults()
print("sb04 ok")
