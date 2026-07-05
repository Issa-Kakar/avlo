# self-asserting: csv + json round-trips (the KEPT pandas.io surface)
import io

import pandas as pd

csv = "a,b\n1,x\n2,y\n"
df = pd.read_csv(io.StringIO(csv))
assert df.shape == (2, 2) and int(df["a"].sum()) == 3
out = df.to_csv(index=False)
assert out.replace("\r\n", "\n") == csv
j = df.to_json(orient="records")
assert j == '[{"a":1,"b":"x"},{"a":2,"b":"y"}]', j
print("p03 ok")
