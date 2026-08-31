"""wasmmeta parser units over a hand-assembled minimal module — the LEB
walker's contract (imports by kind, exports, dylink.0 MEM_INFO/NEEDED) without
touching real artifacts."""

from avlo_py_build.wasmmeta import census_imports, parse_wasm


def _name(s: bytes) -> bytes:
    return bytes([len(s)]) + s


def _section(sec_id: int, body: bytes) -> bytes:
    return bytes([sec_id, len(body)]) + body


def _tiny_module() -> bytes:
    header = b"\0asm\x01\x00\x00\x00"
    # import section: env.used_func (func), env.__stack_pointer (global),
    # env.invoke_vi (func), GOT.mem.some_sym (global), env.a_table (table),
    # env.mem (memory)
    imports = b"".join(
        [
            b"\x06",  # count
            _name(b"env") + _name(b"used_func") + b"\x00\x00",  # func, typeidx 0
            _name(b"env") + _name(b"__stack_pointer") + b"\x03\x7f\x01",  # global i32 mut
            _name(b"env") + _name(b"invoke_vi") + b"\x00\x00",
            _name(b"GOT.mem") + _name(b"some_sym") + b"\x03\x7f\x01",
            _name(b"env") + _name(b"a_table") + b"\x01\x70\x00\x00",  # table funcref, limits {min 0}
            _name(b"env") + _name(b"mem") + b"\x02\x00\x00",  # memory, limits {min 0}
        ]
    )
    # dylink.0: MEM_INFO {memSize 16, memAlign 2, tableSize 3, tblAlign 0} + NEEDED ["libfoo.so"]
    mem_info = b"\x01\x04" + bytes([16, 2, 3, 0])
    needed = b"\x02" + bytes([1 + 1 + len(b"libfoo.so")]) + b"\x01" + _name(b"libfoo.so")
    dylink = _section(0, _name(b"dylink.0") + mem_info + needed)
    # export section: PyInit_x (func 0), __heap_base (global 0)
    exports = _section(7, b"\x02" + _name(b"PyInit_x") + b"\x00\x00" + _name(b"__heap_base") + b"\x03\x00")
    return header + dylink + _section(2, imports) + exports


def test_parse_and_census():
    w = parse_wasm(_tiny_module())
    assert w.exports == ["PyInit_x", "__heap_base"]
    assert ("env", "used_func", "func") in w.imports
    assert ("env", "__stack_pointer", "global") in w.imports
    assert ("GOT.mem", "some_sym", "global") in w.imports
    # table/memory kinds carry no symbol identity — never collected
    assert not any(f == "a_table" or f == "mem" for _m, f, _k in w.imports)
    assert w.dylink is not None
    assert (w.dylink.memSize, w.dylink.tableSize, w.dylink.needed) == (16, 3, ["libfoo.so"])
    # census: invoke_* and plumbing excluded
    census = census_imports(w)
    assert ("env", "used_func", "func") in census
    assert not any(f in ("invoke_vi", "__stack_pointer") for _m, f, _k in census)
