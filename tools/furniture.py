"""Furniture model expansion, the Python twin of src/furniture/expr.ts and model.ts.

Keep the rules identical to the TypeScript version. See the comment at the top of expr.ts
for the expression language. Never uses eval.
"""

import json
import re
from pathlib import Path


class ExprError(Exception):
    pass


TWO_CHAR_OPS = ("==", "!=", "<=", ">=", "&&", "||")
ONE_CHAR_OPS = "+-*/()<>!"


def tokenize(src):
    tokens, i = [], 0
    while i < len(src):
        c = src[i]
        if c.isspace():
            i += 1
            continue
        rest = src[i:]
        m = re.match(r"(\d+\.?\d*|\.\d+)", rest)
        if m:
            tokens.append(("num", float(m.group(0))))
            i += len(m.group(0))
            continue
        m = re.match(r"\$([A-Za-z_][A-Za-z0-9_]*)", rest)
        if m:
            tokens.append(("var", m.group(1)))
            i += len(m.group(0))
            continue
        if c in "'\"":
            end = src.find(c, i + 1)
            if end < 0:
                raise ExprError(f'Unclosed string in "{src}"')
            tokens.append(("str", src[i + 1:end]))
            i = end + 1
            continue
        if src[i:i + 2] in TWO_CHAR_OPS:
            tokens.append(("op", src[i:i + 2]))
            i += 2
            continue
        if c in ONE_CHAR_OPS:
            tokens.append(("op", c))
            i += 1
            continue
        raise ExprError(f'Unexpected "{c}" in "{src}"')
    return tokens


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def evaluate(src, variables):
    tokens = tokenize(src)
    pos = 0

    def peek_op(*ops):
        return pos < len(tokens) and tokens[pos][0] == "op" and tokens[pos][1] in ops

    def num(v, op):
        if not is_num(v):
            raise ExprError(f'"{op}" needs numbers in "{src}"')
        return v

    def p_or():
        nonlocal pos
        left = p_and()
        while peek_op("||"):
            pos += 1
            right = p_and()
            left = bool(left) or bool(right)
        return left

    def p_and():
        nonlocal pos
        left = p_compare()
        while peek_op("&&"):
            pos += 1
            right = p_compare()
            left = bool(left) and bool(right)
        return left

    def p_compare():
        nonlocal pos
        left = p_add()
        if not peek_op("==", "!=", "<", ">", "<=", ">="):
            return left
        op = tokens[pos][1]
        pos += 1
        right = p_add()
        # Like JavaScript's ===: 3 equals 3.0, but True never equals 1.
        same = left == right if is_num(left) and is_num(right) else (left == right and type(left) is type(right))
        if op == "==":
            return same
        if op == "!=":
            return not same
        l, r = num(left, op), num(right, op)
        return {"<": l < r, ">": l > r, "<=": l <= r, ">=": l >= r}[op]

    def p_add():
        nonlocal pos
        left = p_mul()
        while peek_op("+", "-"):
            op = tokens[pos][1]
            pos += 1
            right = p_mul()
            left = num(left, op) + num(right, op) if op == "+" else num(left, op) - num(right, op)
        return left

    def p_mul():
        nonlocal pos
        left = p_unary()
        while peek_op("*", "/"):
            op = tokens[pos][1]
            pos += 1
            right = num(p_unary(), op)
            if op == "/" and right == 0:
                raise ExprError(f'Division by zero in "{src}"')
            left = num(left, op) * right if op == "*" else num(left, op) / right
        return left

    def p_unary():
        nonlocal pos
        if peek_op("-"):
            pos += 1
            return -num(p_unary(), "-")
        if peek_op("!"):
            pos += 1
            return not p_unary()
        return p_atom()

    def p_atom():
        nonlocal pos
        if pos >= len(tokens):
            raise ExprError(f'Unexpected end of "{src}"')
        kind, value = tokens[pos]
        pos += 1
        if kind in ("num", "str"):
            return value
        if kind == "var":
            if value not in variables:
                raise ExprError(f'Unknown variable ${value} in "{src}"')
            return variables[value]
        if value == "(":
            v = p_or()
            if not peek_op(")"):
                raise ExprError(f'Missing ")" in "{src}"')
            pos += 1
            return v
        raise ExprError(f'Unexpected "{value}" in "{src}"')

    result = p_or()
    if pos < len(tokens):
        raise ExprError(f'Unexpected "{tokens[pos][1]}" in "{src}"')
    return result


def number_of(field, variables):
    if is_num(field):
        return float(field)
    v = evaluate(field, variables)
    if not is_num(v):
        raise ExprError(f'"{field}" is not a number')
    return float(v)


def default_values(spec):
    return {k: p["default"] for k, p in spec.get("params", {}).items()}


def repeat(item, variables, values):
    """The variable scopes an item is drawn with: once, or once per list value, if `when` holds."""
    each = item.get("each")
    items = [None] if each is None else values.get(each)
    if not isinstance(items, list):
        raise ExprError(f'"each": "{each}" is not a list parameter')
    for i, v in enumerate(items):
        scope = variables if v is None else {**variables, "v": v, "i": i, "n": i + 1}
        if "when" in item and not evaluate(item["when"], scope):
            continue
        yield scope


def expand_model(spec, chosen=None):
    values = {**default_values(spec), **(chosen or {})}
    variables = {k: v for k, v in values.items() if not isinstance(v, list)}
    W, D, H = (number_of(s, variables) for s in spec["size"])
    variables.update(W=W, D=D, H=H)

    parts = []
    for p in spec["parts"]:
        for scope in repeat(p, variables, values):
            def nums(key, count):
                f = p.get(key)
                if not isinstance(f, list) or len(f) != count:
                    raise ExprError(f"A part needs {count} numbers in {key}: {json.dumps(p)}")
                return [number_of(x, scope) for x in f]

            axis = p.get("axis", "z")
            if "box" in p:
                shape, box = "box", nums("box", 6)
            elif "prism" in p:
                shape, box = "prism", nums("prism", 6)
            elif "cyl" in p:
                shape = "cyl"
                x, y, z, r, length = nums("cyl", 5)
                box = {
                    "z": [x - r, y - r, z, 2 * r, 2 * r, length],
                    "x": [x, y - r, z - r, length, 2 * r, 2 * r],
                    "y": [x - r, y, z - r, 2 * r, length, 2 * r],
                }[axis]
            elif "sphere" in p:
                shape = "sphere"
                x, y, z, r = nums("sphere", 4)
                box = [x - r, y - r, z - r, 2 * r, 2 * r, 2 * r]
            else:
                raise ExprError(f"A part needs box, cyl, sphere or prism: {json.dumps(p)}")
            parts.append({"shape": shape, "box": box, "name": p.get("name"), "color": p.get("color")})

    surfaces = []
    for s in spec.get("surfaces", []):
        for scope in repeat(s, variables, values):
            area = [number_of(x, scope) for x in s.get("area", [0, 0, W, D])]
            label = re.sub(r"\$(n|i|v)\b", lambda m: str(scope[m.group(1)]), s.get("label", "top"))
            surfaces.append({"z": number_of(s["z"], scope), "area": area, "label": label})

    return {"size": [W, D, H], "category": spec.get("category"), "parts": parts, "surfaces": surfaces, "values": values}


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))
