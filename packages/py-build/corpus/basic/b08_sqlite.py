# self-asserting: static sqlite3 on the bare stdlib — file-backed persistence
# across close/reopen inside MEMFS (the VFS actually works, not just
# :memory:), all five storage classes round-trip (incl. BLOB/NULL),
# sqlite3.Row name access, and context-manager rollback. (The dedicated
# sqlite corpus group folded in here 2026-08-31: in-memory CRUD via pandas
# rides all/a02_read_sql.py; post-freeze proofs live in the web
# py-integration harden suite.)
import os
import sqlite3

assert len(sqlite3.sqlite_version.split(".")) == 3

path = "/tmp/corpus_b08.db"
con = sqlite3.connect(path)
con.execute("CREATE TABLE kv (k TEXT, v INTEGER)")
con.executemany("INSERT INTO kv VALUES (?, ?)", [("a", 1), ("b", 2)])
con.commit()
con.close()

con = sqlite3.connect(path)  # reopen the SAME MEMFS file — VFS persistence
assert con.execute("SELECT v FROM kv WHERE k='b'").fetchone() == (2,)

con.row_factory = sqlite3.Row
con.execute("CREATE TABLE v (i INTEGER, f REAL, s TEXT, b BLOB, n TEXT)")
want = (7, 2.5, "x", b"\x00\xff", None)
con.execute("INSERT INTO v VALUES (?, ?, ?, ?, ?)", want)
row = con.execute("SELECT i, f, s, b, n FROM v").fetchone()
assert (row["i"], row["f"], row["s"], bytes(row["b"]), row["n"]) == want
con.commit()  # close the implicit tx so the rollback below covers ONLY the with-block
try:
    with con:
        con.execute("INSERT INTO v VALUES (1, 1.0, 'y', X'', NULL)")
        raise RuntimeError("force rollback")
except RuntimeError:
    pass
assert con.execute("SELECT COUNT(*) FROM v").fetchone()[0] == 1  # rolled back
con.close()
os.remove(path)
print("b08 ok")
