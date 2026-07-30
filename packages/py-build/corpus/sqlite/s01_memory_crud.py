# self-asserting: sqlite3 in-memory CRUD over the static _sqlite3 builtin
import sqlite3

assert len(sqlite3.sqlite_version.split(".")) == 3, sqlite3.sqlite_version
con = sqlite3.connect(":memory:")
con.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, score REAL)")
con.execute("INSERT INTO t (name, score) VALUES (?, ?)", ("ada", 99.5))
con.execute("INSERT INTO t (name, score) VALUES (?, ?)", ("alan", 87.25))
rows = con.execute("SELECT name, score FROM t ORDER BY score DESC").fetchall()
assert rows == [("ada", 99.5), ("alan", 87.25)], rows
con.execute("UPDATE t SET score = 100.0 WHERE name = 'ada'")
assert con.execute("SELECT score FROM t WHERE name = 'ada'").fetchone()[0] == 100.0
con.execute("DELETE FROM t WHERE name = 'alan'")
assert con.execute("SELECT COUNT(*) FROM t").fetchone()[0] == 1
con.close()
print("s01 ok")
