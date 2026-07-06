# self-asserting: parameter types roundtrip, transaction rollback, Row factory
import sqlite3

con = sqlite3.connect(":memory:")
con.row_factory = sqlite3.Row
con.execute("CREATE TABLE v (i INTEGER, f REAL, s TEXT, b BLOB, n TEXT)")
rows = [(1, 1.5, "x", b"\x00\xff", None), (2, -2.25, "y", b"", "z")]
con.executemany("INSERT INTO v VALUES (?, ?, ?, ?, ?)", rows)
con.commit()  # close the implicit tx so the rollback below covers ONLY the with-block
got = con.execute("SELECT * FROM v ORDER BY i").fetchall()
for want, row in zip(rows, got):
    assert (row["i"], row["f"], row["s"], bytes(row["b"]), row["n"]) == want, want
try:
    with con:
        con.execute("INSERT INTO v VALUES (3, 0.0, 'w', X'00', NULL)")
        raise RuntimeError("force rollback")
except RuntimeError:
    pass
assert con.execute("SELECT COUNT(*) FROM v").fetchone()[0] == 2  # rolled back
con.close()
print("s03 ok")
