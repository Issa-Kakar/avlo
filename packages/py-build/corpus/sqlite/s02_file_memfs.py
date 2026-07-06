# self-asserting: file-backed DB persists across close/reopen inside MEMFS
import os
import sqlite3

path = "/tmp/corpus_s02.db"
con = sqlite3.connect(path)
con.execute("CREATE TABLE kv (k TEXT PRIMARY KEY, v INTEGER)")
con.executemany("INSERT INTO kv VALUES (?, ?)", [("a", 1), ("b", 2)])
con.commit()
con.close()
con = sqlite3.connect(path)
assert con.execute("SELECT v FROM kv WHERE k = 'b'").fetchone() == (2,)
con.close()
os.remove(path)
print("s02 ok")
