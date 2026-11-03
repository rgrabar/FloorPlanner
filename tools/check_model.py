"""Checks furniture models before they're used.

    python tools/check_model.py                     (all models in furniture/)
    python tools/check_model.py furniture/ikea-billy-80x28x202.json

Checks, for the default parameters and every option of each choice parameter:
  - every part lies inside the model's size box (a part sticking out breaks placement later)
  - furniture with tops or shelves has surfaces to put things on, inside its footprint
  - colours used by parts exist, and IKEA models name their article numbers
"""

import itertools
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from furniture import ExprError, expand_model, load  # noqa: E402

FURNITURE = Path(__file__).resolve().parent.parent / "furniture"
NEEDS_SURFACES = {"storage", "table", "desk", "sideboard", "shelving", "kitchen"}
TOLERANCE = 0.05  # cm


def combinations(spec):
    """Default values plus every option of every choice parameter (capped)."""
    choices = {k: p["options"] for k, p in spec.get("params", {}).items() if p.get("type") == "choice"}
    keys = list(choices)
    combos = [dict(zip(keys, c)) for c in itertools.product(*(choices[k] for k in keys))]
    return combos[:64] or [{}]


def check(path):
    problems = []
    try:
        spec = load(path)
    except Exception as e:
        return [f"can't read: {e}"]
    for key in ("size", "category", "parts"):
        if key not in spec:
            problems.append(f'missing "{key}"')
    if problems:
        return problems

    name = Path(path).stem
    if name.startswith("ikea-") and not (spec.get("ikea") or {}).get("items"):
        problems.append('IKEA model without "ikea.items" (article numbers)')
    colors = spec.get("colors", {})

    for chosen in combinations(spec):
        where = f" (with {chosen})" if chosen else ""
        try:
            m = expand_model(spec, chosen)
        except ExprError as e:
            problems.append(f"{e}{where}")
            continue
        W, D, H = m["size"]
        for i, p in enumerate(m["parts"]):
            x, y, z, w, d, h = p["box"]
            label = p["name"] or f"part {i + 1} ({p['shape']})"
            if min(w, d, h) <= 0:
                problems.append(f"{label} has no size: {p['box']}{where}")
            if x < -TOLERANCE or y < -TOLERANCE or z < -TOLERANCE or x + w > W + TOLERANCE or y + d > D + TOLERANCE or z + h > H + TOLERANCE:
                problems.append(f"{label} sticks out of the {W:g}x{D:g}x{H:g} box: {[round(v, 2) for v in p['box']]}{where}")
            c = p["color"]
            if isinstance(c, str) and c.startswith("$") and c[1:] not in colors and c[1:] not in spec.get("params", {}):
                problems.append(f'{label} uses unknown colour "{c}"')
        if m["category"] in NEEDS_SURFACES and not m["surfaces"]:
            problems.append(f'"{m["category"]}" furniture needs surfaces (tops, shelves) to put things on{where}')
        for s in m["surfaces"]:
            ax, ay, aw, ad = s["area"]
            if not (0 < s["z"] <= H + TOLERANCE):
                problems.append(f'surface "{s["label"]}" at height {s["z"]:g} is outside 0..{H:g}{where}')
            if ax < -TOLERANCE or ay < -TOLERANCE or ax + aw > W + TOLERANCE or ay + ad > D + TOLERANCE:
                problems.append(f'surface "{s["label"]}" area {s["area"]} is outside the footprint{where}')
    # The same problem for several combinations only needs saying once.
    return list(dict.fromkeys(problems))


def main(args):
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    paths = [Path(a) for a in args] or sorted(FURNITURE.glob("*.json"))
    if not paths:
        print("No models found.")
        return 0
    failed = 0
    for path in paths:
        problems = check(path)
        if problems:
            failed += 1
            print(f"FAIL {path.name}")
            for p in problems:
                print(f"     - {p}")
        else:
            m = expand_model(load(path))
            print(f"OK   {path.name}: {len(m['parts'])} parts, {len(m['surfaces'])} surfaces")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
