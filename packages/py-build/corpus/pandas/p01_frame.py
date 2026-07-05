# self-asserting: DataFrame core — construct, aggregate, groupby, merge
import numpy as np
import pandas as pd

assert pd.__version__ == "2.3.3", pd.__version__
df = pd.DataFrame({"a": [1, 2, 3, 4], "b": list("xyxy")})
assert int(df["a"].sum()) == 10
g = df.groupby("b")["a"].sum()
assert int(g["x"]) == 4 and int(g["y"]) == 6
m = df.merge(pd.DataFrame({"b": ["x", "y"], "c": [10, 20]}), on="b")
assert int(m["c"].sum()) == 60
assert float(df.describe().loc["mean", "a"]) == 2.5
s = pd.Series([1.0, np.nan, 3.0])
assert int(s.isna().sum()) == 1
print("p01 ok")
