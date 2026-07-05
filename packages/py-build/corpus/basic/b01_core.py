# self-asserting: interpreter arithmetic, strings, comprehensions
assert 1 + 1 == 2
assert sum(x * x for x in range(10)) == 285
assert "".join(sorted("avlo")) == "alov"
assert {k: v for k, v in zip("ab", [1, 2])} == {"a": 1, "b": 2}
assert f"{3.14159:.2f}" == "3.14"
print("b01 ok")
