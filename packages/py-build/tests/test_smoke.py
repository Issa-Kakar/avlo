import packlib


def test_canonical_json_sorts_and_compacts():
    assert packlib.canonical_json({"b": 1, "a": 2}) == b'{"a":2,"b":1}'


def test_canonical_json_is_key_order_independent():
    a = packlib.canonical_json({"x": [3, 2, 1], "y": {"k": "v"}})
    b = packlib.canonical_json({"y": {"k": "v"}, "x": [3, 2, 1]})
    assert a == b
