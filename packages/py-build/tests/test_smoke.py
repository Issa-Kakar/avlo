from avlo_py_build import packlib


def test_canonical_json_sorts_and_compacts():
    assert packlib.canonical_json({"b": 1, "a": 2}) == b'{"a":2,"b":1}'


def test_canonical_json_is_key_order_independent():
    a = packlib.canonical_json({"x": [3, 2, 1], "y": {"k": "v"}})
    b = packlib.canonical_json({"y": {"k": "v"}, "x": [3, 2, 1]})
    assert a == b


def test_prune_rules_and_tombstone_keys(tmp_path):
    f = tmp_path / "prune.txt"
    f.write_text("# reason: because\nxml/sax/\nfoo.py\n# comment\nmpl-data/\n")
    rules = packlib.load_prune_rules(f)
    assert rules == ["xml/sax/", "foo.py", "mpl-data/"]
    assert packlib.dotted_key("xml/sax/") == "xml.sax"
    assert packlib.is_module_rule("xml/sax/") and packlib.is_module_rule("foo.py")
    assert not packlib.is_module_rule("mpl-data/")  # not an importable name
    assert packlib.parse_reasons(f, "dflt") == {"xml.sax": "because", "foo": "because", "mpl-data": "because"}
    assert packlib.is_pruned("xml/sax/handler.py", rules) and not packlib.is_pruned("xml/dom/x.py", rules)


def test_tar_roundtrip_and_meta_contract():
    meta = packlib.canonical_json({"schema": 1, "bundle": "b"})
    data = packlib.tar_bytes([("meta.json", meta), ("pkg/mod.pyc", b"\x00\x01")])
    assert packlib.parse_tar_meta(data) == {"schema": 1, "bundle": "b"}
    # determinism: same entries -> same bytes
    assert data == packlib.tar_bytes([("meta.json", meta), ("pkg/mod.pyc", b"\x00\x01")])


def test_zip_deterministic():
    entries = {"b.txt": b"bbb", "a.txt": b"aaa"}
    assert packlib.zip_bytes(entries) == packlib.zip_bytes(dict(reversed(entries.items())))
