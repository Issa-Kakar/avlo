# self-asserting: pandas <-> sqlite3 roundtrip over a raw DBAPI2 connection
# (pandas.io.sql supports sqlite3 connections natively — no sqlalchemy)
import sqlite3

import pandas as pd

con = sqlite3.connect(":memory:")
df = pd.DataFrame({"g": ["a", "a", "b"], "x": [1.0, 2.0, 3.5]})
df.to_sql("t", con, index=False)
back = pd.read_sql_query("SELECT g, x FROM t ORDER BY x", con)
assert back["g"].tolist() == ["a", "a", "b"], back["g"].tolist()
assert back["x"].tolist() == [1.0, 2.0, 3.5], back["x"].tolist()
agg = pd.read_sql_query("SELECT g, SUM(x) AS s FROM t GROUP BY g ORDER BY g", con)
assert agg["s"].tolist() == [3.0, 3.5], agg["s"].tolist()
con.close()
print("a02 ok")
