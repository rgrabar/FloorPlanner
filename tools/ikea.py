"""Looks up IKEA products: search, real product measurements, and photos.

    python tools/ikea.py search "billy bookcase"
    python tools/ikea.py show 00263850            (or a product page URL)
    python tools/ikea.py photos 00263850 [n=8]

Uses IKEA Ireland in English (change COUNTRY/LANGUAGE below). Everything is cached under
cache/, so each product page is only fetched once. Only fetch products you're modelling.
Needs Pillow for photos (pip install pillow).
"""

import io
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

COUNTRY = "ie"
LANGUAGE = "en"
CACHE = Path(__file__).resolve().parent.parent / "cache"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Language": f"{LANGUAGE}-{COUNTRY.upper()}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def cached(name, url):
    """Fetches a URL once and keeps it in cache/."""
    path = CACHE / name
    if path.exists():
        return path.read_bytes()
    data = fetch(url)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


# ---------- search ----------

def find_products(node):
    """All product records in the search response, wherever they're nested."""
    if isinstance(node, dict):
        if "itemNo" in node and "name" in node and ("pipUrl" in node or "url" in node):
            yield node
            return
        for v in node.values():
            yield from find_products(v)
    elif isinstance(node, list):
        for v in node:
            yield from find_products(v)


def price_of(p):
    sp = p.get("salesPrice") or {}
    if isinstance(sp, dict):
        cur = sp.get("currencyCode", "")
        num = sp.get("numeral") or (sp.get("current") or {}).get("wholeNumber")
        if num is not None:
            return f"{num} {cur}".strip()
    return ""


def search(query, raw=False):
    url = (
        f"https://sik.search.blue.cdtapps.com/{COUNTRY}/{LANGUAGE}/search-result-page"
        f"?q={urllib.parse.quote(query)}&types=PRODUCT&size=24"
    )
    data = json.loads(fetch(url))
    if raw:
        print(json.dumps(data, indent=1)[:6000])
        return []
    seen, hits = set(), []
    for p in find_products(data):
        if p["itemNo"] in seen:
            continue
        seen.add(p["itemNo"])
        hits.append({
            "itemNo": p["itemNo"],
            "name": p.get("name", ""),
            "type": p.get("typeName", ""),
            "measure": p.get("itemMeasureReferenceText", ""),
            "price": price_of(p),
            "url": p.get("pipUrl") or p.get("url", ""),
            "image": p.get("mainImageUrl", ""),
        })
    return hits


def cmd_search(args):
    if not args:
        print("usage: ikea.py search QUERY [--raw]")
        return 1
    raw = "--raw" in args
    query = " ".join(a for a in args if a != "--raw")
    hits = search(query, raw)
    for h in hits:
        print(f"{h['itemNo']}  {h['name']} - {h['type']}  {h['measure']}  {h['price']}")
        print(f"          {h['url']}")
        if h["image"]:
            print(f"          {h['image']}")
    if not raw and not hits:
        print("No products found.")
    return 0


# ---------- product page ----------

def item_no_from(arg):
    m = re.search(r"(\d{8})/?$", arg.strip()) or re.search(r"([sS]?\d{8})", arg)
    return m.group(1).lower().lstrip("s") if m else None


def product_url(arg):
    """A product page URL for an item number (found via search) or a URL."""
    if arg.startswith("http"):
        return arg
    for h in search(arg):
        if h["itemNo"].lstrip("sS") == arg.lstrip("sS"):
            return h["url"]
    raise SystemExit(f"Item {arg} not found on IKEA {COUNTRY}/{LANGUAGE}.")


NUMBER = re.compile(r"(\d+(?:[.,]\d+)?)")


def parse_cm(text):
    """'80 cm' -> 80.0, '31 1/2 "' -> None (only metric is used)."""
    if "cm" not in text and "mm" not in text:
        return None
    m = NUMBER.search(text)
    if not m:
        return None
    v = float(m.group(1).replace(",", "."))
    return v / 10 if "mm" in text and "cm" not in text else v


def show(arg):
    item = item_no_from(arg) if not arg.startswith("http") else None
    cache_file = CACHE / f"{item}.json" if item else None
    if cache_file and cache_file.exists():
        return json.loads(cache_file.read_text(encoding="utf-8"))

    url = product_url(arg)
    item = item or item_no_from(url)
    html = cached(f"{item}.html", url).decode("utf-8", "replace")

    # Product measurements. Package dimension blocks have a different shape ("measure" isn't a
    # string there), so only plain string measures are kept. A page can hold blocks of other
    # products too, so each block is kept apart and numbered.
    measures, seen = [], set()
    for number, block in enumerate(re.findall(r'\[\{"measure":"[^\]]*\]', html), 1):
        try:
            entries = json.loads(block)
        except json.JSONDecodeError:
            continue
        for e in entries:
            if not isinstance(e.get("measure"), str):
                continue
            # "name" is the readable label (Width, Depth, ...); "type" is only a numeric code.
            name = e.get("name") or e.get("typeName") or e.get("type", "")
            if (number, name, e["measure"]) in seen:
                continue
            seen.add((number, name, e["measure"]))
            measures.append({
                "block": number,
                "name": name,
                "measure": e["measure"],
                "cm": parse_cm(e["measure"]),
            })

    slug = urllib.parse.urlparse(url).path.rstrip("/").split("/")[-1]
    name_slug = slug.split("-")[0]
    # The product's own photo prefix: name, type and colour, without the article number.
    product_slug = re.sub(r"-s?\d{8}$", "", slug)

    # A combination lists the separate articles it's made of.
    parts = []
    at = html.find('"subProducts":')
    if at >= 0:
        try:
            subs, _ = json.JSONDecoder().raw_decode(html, at + len('"subProducts":'))
            parts = [
                {"itemNo": sp.get("itemNo"), "name": sp.get("name"), "type": sp.get("typeName"),
                 "quantity": sp.get("quantity", 1), "url": sp.get("pipUrl")}
                for sp in subs if isinstance(sp, dict)
            ]
        except json.JSONDecodeError:
            pass
    images = []
    for m in re.finditer(r"https://www\.ikea\.com/[a-z]{2}/[a-z]{2}/images/products/([a-z0-9-]+)__(\d+)_([a-z]{2}\d+)_s\d\.(?:jpg|png|webp|avif)", html):
        base = m.group(0)
        big = re.sub(r"_s\d\.", "_s5.", base)
        if big not in images:
            images.append(big)

    # The product's size comes from the first block with both a width (or length) and a height.
    def find(block, *names):
        return next((m["cm"] for m in measures if m["block"] == block and m["name"].lower() in names and m["cm"]), None)

    main_block = next((b for b in dict.fromkeys(m["block"] for m in measures)
                       if find(b, "width", "length") and find(b, "height", "max. height")), None)
    result = {
        "itemNo": item,
        "url": url,
        "slug": slug,
        "nameSlug": name_slug,
        "productSlug": product_slug,
        "measures": measures,
        "mainBlock": main_block,
        "size": {
            "width": find(main_block, "width", "length"),
            "depth": find(main_block, "depth"),
            "height": find(main_block, "height", "max. height"),
        },
        "parts": parts,
        "images": images,
    }
    if cache_file:
        cache_file.write_text(json.dumps(result, indent=1, ensure_ascii=False), encoding="utf-8")
    return result


def cmd_show(args):
    if not args:
        print("usage: ikea.py show ITEMNO|URL")
        return 1
    r = show(args[0])
    print(f"{r['itemNo']}  {r['url']}")
    if not r["measures"]:
        print("No product measurements found on the page.")
    block = None
    for m in r["measures"]:
        if m["block"] != block:
            block = m["block"]
            mark = "  <- this product" if block == r["mainBlock"] else "  (probably another product on the page)"
            print(f" block {block}{mark}")
        print(f"   {m['name']:<28} {m['measure']}")
    s = r["size"]
    fmt = lambda v: f"{v:g}" if v else "?"
    print(f"Product W x D x H: {fmt(s['width'])} x {fmt(s['depth'])} x {fmt(s['height'])} cm")
    if r["parts"]:
        print("This is a combination of:")
        for part in r["parts"]:
            print(f"   {part['quantity']} x {part['itemNo']}  {part['name']} - {part['type']}  {part['url']}")
        print("   Look each one up with: python tools/ikea.py show ITEMNO")
    print(f"{len(r['images'])} images on the page, {len(own_photos(r))} of this product")
    return 0


def own_photos(r):
    """This product's photos: matched on name, type and colour, so neither recommended products
    nor other colours get in. Falls back to the name alone when that finds too few."""
    exact = [u for u in r["images"] if f"/products/{r['productSlug']}__" in u]
    return exact if len(exact) >= 2 else [u for u in r["images"] if f"/products/{r['nameSlug']}-" in u]


# ---------- photos ----------

def cmd_photos(args):
    if not args:
        print("usage: ikea.py photos ITEMNO [n=8]")
        return 1
    from PIL import Image, ImageDraw

    n = int(args[1]) if len(args) > 1 else 8
    r = show(args[0])
    own = own_photos(r)[:n]
    if not own:
        print("No photos of this product found on the page.")
        return 1
    folder = CACHE / r["itemNo"]
    folder.mkdir(parents=True, exist_ok=True)
    thumbs = []
    for i, url in enumerate(own, 1):
        path = folder / f"{i:02d}.jpg"
        if not path.exists():
            img = Image.open(io.BytesIO(fetch(url))).convert("RGB")
            img.thumbnail((900, 900))
            img.save(path, quality=88)
        thumbs.append(Image.open(path))
        print(path)

    # One contact sheet to look at instead of many separate photos.
    cell, cols = 300, 4
    rows = (len(thumbs) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell, rows * cell), "white")
    draw = ImageDraw.Draw(sheet)
    for i, img in enumerate(thumbs):
        t = img.copy()
        t.thumbnail((cell - 8, cell - 8))
        x, y = (i % cols) * cell, (i // cols) * cell
        sheet.paste(t, (x + (cell - t.width) // 2, y + (cell - t.height) // 2))
        draw.text((x + 6, y + 4), f"{i + 1:02d}", fill="red")
    sheet_path = folder / "sheet.jpg"
    sheet.save(sheet_path, quality=85)
    print(f"Contact sheet: {sheet_path}")
    return 0


def main(argv):
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    commands = {"search": cmd_search, "show": cmd_show, "photos": cmd_photos}
    if not argv or argv[0] not in commands:
        print(__doc__)
        return 1
    return commands[argv[0]](argv[1:])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
