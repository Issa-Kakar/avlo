"""Make the raw stdlib zip byte-reproducible: upstream's create_zipfile.py
stamps every entry with its extraction-time mtime and walks the tree in
directory (filesystem) order. Rewrite in place with sorted entries and a
fixed timestamp, same codec and level — content untouched. pack-stdlib
recompiles from the .py bytes anyway; this only keeps dist/raw as a whole
byte-stable across builds (the `fork --repro` double + turbo input hashing).

  python3 normalize-zip.py dist/python_stdlib.zip
"""

import os
import sys
import zipfile

src = sys.argv[1]
tmp = src + ".tmp"
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(tmp, "w") as zout:
    for info in sorted(zin.infolist(), key=lambda i: i.filename):
        zi = zipfile.ZipInfo(info.filename, date_time=(1980, 1, 1, 0, 0, 0))
        zi.compress_type = info.compress_type
        zi.external_attr = info.external_attr
        zi.create_system = 3
        zout.writestr(zi, zin.read(info), compresslevel=6)
os.replace(tmp, src)
print(f"normalized {src}: {len(zipfile.ZipFile(src).namelist())} entries")
