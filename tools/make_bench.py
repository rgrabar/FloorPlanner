"""Generates test floorplans with known answers, for testing wall detection.

    python tools/make_bench.py [count per style, default 5]

Each plan is a random flat (outer walls, inner walls with T-junctions, doors, windows) drawn in
several styles, the way real plans come: filled walls, outlined walls, hatched walls, app exports
with grids and furniture, clean pictures and bad scans. Next to each file the exact walls and
openings are written to bench/manifest.json, in the coordinates the app's importer produces.
Open http://localhost:5173/?bench to score detection against them.
"""

import io
import json
import math
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "bench"
PT_PER_CM = 72 / 2.54 / 100  # drawn at 1:100, which the PDF importer assumes
CM_PER_PT = 1 / PT_PER_CM

# ---------- random flats ----------


def make_flat(rnd):
    """Walls as centrelines (x1, y1, x2, y2, thickness) in cm, axis-aligned, and openings."""
    W = rnd.randrange(700, 1400, 10)
    H = rnd.randrange(600, 1200, 10)
    ext = rnd.choice([20, 25, 30, 35])
    inner = rnd.choice([10, 12, 15])
    walls = [(0, 0, W, 0, ext), (W, 0, W, H, ext), (W, H, 0, H, ext), (0, H, 0, 0, ext)]

    rooms = [(0, 0, W, H)]
    done = []
    while rooms:
        x0, y0, x1, y1 = rooms.pop()
        w, h = x1 - x0, y1 - y0
        limit = rnd.randrange(380, 560, 10)
        if max(w, h) < limit or min(w, h) < 220:
            done.append((x0, y0, x1, y1))
            continue
        if w >= h:
            x = x0 + round(w * rnd.uniform(0.35, 0.65) / 5) * 5
            walls.append((x, y0, x, y1, inner))
            rooms += [(x0, y0, x, y1), (x, y0, x1, y1)]
        else:
            y = y0 + round(h * rnd.uniform(0.35, 0.65) / 5) * 5
            walls.append((x0, y, x1, y, inner))
            rooms += [(x0, y0, x1, y), (x0, y, x1, y1)]

    openings = []  # (wall index, start along wall, end along wall, kind)

    def junctions(i):
        """Distances along wall i where other walls meet it."""
        x1, y1, x2, y2, _ = walls[i]
        L = math.hypot(x2 - x1, y2 - y1)
        ux, uy = (x2 - x1) / L, (y2 - y1) / L
        ts = []
        for j, (a1, b1, a2, b2, t) in enumerate(walls):
            if j == i:
                continue
            for px, py in ((a1, b1), (a2, b2)):
                d = abs(-(px - x1) * uy + (py - y1) * ux)
                s = (px - x1) * ux + (py - y1) * uy
                if d < 1 and -1 <= s <= L + 1:
                    ts.append((s, t))
        return L, ts

    def place(i, width, kind):
        L, ts = junctions(i)
        for _ in range(30):
            c = rnd.uniform(width / 2 + 25, L - width / 2 - 25)
            s, e = c - width / 2, c + width / 2
            if all(e + t / 2 + 20 < j or s - t / 2 - 20 > j for j, t in ts) and all(
                e + 20 < os or s - 20 > oe for wi, os, oe, _ in openings if wi == i
            ):
                openings.append((i, round(s, 1), round(e, 1), kind))
                return True
        return False

    for i in range(4, len(walls)):
        place(i, rnd.randrange(70, 95, 5), "door")
    for i in range(4):
        L, _ = junctions(i)
        for _ in range(max(1, int(L // 350))):
            place(i, rnd.randrange(80, 185, 5), "window")
    place(rnd.randrange(4), rnd.randrange(90, 105, 5), "door")
    return walls, openings, done


def solid_pieces(walls, openings):
    """Wall rectangles (x0, y0, x1, y1) with openings left out. Outer walls run on past the
    corners so corners are filled; inner walls stop at the other wall's centreline."""
    rects = []
    for i, (x1, y1, x2, y2, t) in enumerate(walls):
        L = math.hypot(x2 - x1, y2 - y1)
        ux, uy = (x2 - x1) / L, (y2 - y1) / L
        ext = t / 2 if i < 4 else 0
        cuts = sorted((s, e) for wi, s, e, _ in openings if wi == i)
        pos = -ext
        for s, e in cuts + [(L + ext, L + ext)]:
            if s > pos:
                ax, ay = x1 + ux * pos, y1 + uy * pos
                bx, by = x1 + ux * s, y1 + uy * s
                rects.append((min(ax, bx) - abs(uy) * t / 2, min(ay, by) - abs(ux) * t / 2,
                              max(ax, bx) + abs(uy) * t / 2, max(ay, by) + abs(ux) * t / 2))
            pos = e
    return rects


def union_outline(rects):
    """The outline of a union of axis-aligned rectangles: closed rings of points."""
    xs = sorted({v for r in rects for v in (r[0], r[2])})
    ys = sorted({v for r in rects for v in (r[1], r[3])})
    filled = set()
    for i in range(len(xs) - 1):
        cx = (xs[i] + xs[i + 1]) / 2
        for j in range(len(ys) - 1):
            cy = (ys[j] + ys[j + 1]) / 2
            if any(r[0] < cx < r[2] and r[1] < cy < r[3] for r in rects):
                filled.add((i, j))
    # Directed boundary edges with the filled side on the left (screen coordinates).
    edges = {}
    for i, j in filled:
        if (i, j - 1) not in filled:
            edges[(xs[i + 1], ys[j])] = (xs[i], ys[j])
        if (i, j + 1) not in filled:
            edges[(xs[i], ys[j + 1])] = (xs[i + 1], ys[j + 1])
        if (i - 1, j) not in filled:
            edges[(xs[i], ys[j])] = (xs[i], ys[j + 1])
        if (i + 1, j) not in filled:
            edges[(xs[i + 1], ys[j + 1])] = (xs[i + 1], ys[j])
    rings = []
    while edges:
        start, p = edges.popitem()
        ring = [start, p]
        while p in edges and p != start:
            p = edges.pop(p)
            ring.append(p)
        # Drop points in the middle of straight runs.
        pts = ring[:-1] if ring[-1] == ring[0] else ring
        simple = []
        for k, q in enumerate(pts):
            a, b = pts[k - 1], pts[(k + 1) % len(pts)]
            if (q[0] - a[0]) * (b[1] - q[1]) - (q[1] - a[1]) * (b[0] - q[0]) != 0:
                simple.append(q)
        if len(simple) >= 3:
            rings.append(simple)
    return rings


def opening_geometry(walls, o):
    i, s, e, kind = o
    x1, y1, x2, y2, t = walls[i]
    L = math.hypot(x2 - x1, y2 - y1)
    ux, uy = (x2 - x1) / L, (y2 - y1) / L
    return (x1 + ux * s, y1 + uy * s), (x1 + ux * e, y1 + uy * e), (-uy, ux), t


# ---------- drawing (one interface for PDF and pictures) ----------


class Pdf:
    def __init__(self, w_pt, h_pt):
        self.w, self.h, self.ops = w_pt, h_pt, []

    def P(self, p):
        return f"{p[0]:.2f} {self.h - p[1]:.2f}"

    def poly(self, pts, fill=None, stroke=None, width=0.5, close=True):
        if fill:
            self.ops.append(f"{fill[0]/255:.3f} {fill[1]/255:.3f} {fill[2]/255:.3f} rg")
        if stroke:
            self.ops.append(f"{stroke[0]/255:.3f} {stroke[1]/255:.3f} {stroke[2]/255:.3f} RG {width:.2f} w")
        path = f"{self.P(pts[0])} m " + " ".join(f"{self.P(q)} l" for q in pts[1:])
        op = ("b" if close else "B") if fill and stroke else ("f" if fill else ("s" if close else "S"))
        self.ops.append(f"{path} {op}")

    def line(self, a, b, color=(0, 0, 0), width=0.4):
        self.poly([a, b], stroke=color, width=width, close=False)

    def rings(self, rings, fill):
        self.ops.append(f"{fill[0]/255:.3f} {fill[1]/255:.3f} {fill[2]/255:.3f} rg")
        self.ops.append(" ".join(f"{self.P(r[0])} m " + " ".join(f"{self.P(q)} l" for q in r[1:]) + " h" for r in rings) + " f*")

    def arc(self, c, r, a0, a1, color=(0, 0, 0), width=0.3):
        """A quarter-circle (or less) as one Bezier curve."""
        k = 4 / 3 * math.tan((a1 - a0) / 4)
        p0 = (c[0] + r * math.cos(a0), c[1] + r * math.sin(a0))
        p3 = (c[0] + r * math.cos(a1), c[1] + r * math.sin(a1))
        p1 = (p0[0] - k * r * math.sin(a0), p0[1] + k * r * math.cos(a0))
        p2 = (p3[0] + k * r * math.sin(a1), p3[1] - k * r * math.cos(a1))
        self.ops.append(f"{color[0]/255:.3f} {color[1]/255:.3f} {color[2]/255:.3f} RG {width:.2f} w "
                        f"{self.P(p0)} m {self.P(p1)} {self.P(p2)} {self.P(p3)} c S")

    def text(self, p, s, size=9):
        self.ops.append(f"0 0 0 rg BT /F1 {size} Tf {self.P(p)} Td ({s}) Tj ET")

    def save(self, path):
        content = "\n".join(self.ops).encode()
        objs = [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            f"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".encode(),
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {self.w:.0f} {self.h:.0f}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".encode(),
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
            f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"\nendstream",
        ]
        out, offsets = b"%PDF-1.4\n", []
        for n, body in enumerate(objs, 1):
            offsets.append(len(out))
            out += f"{n} 0 obj\n".encode() + body + b"\nendobj\n"
        xref = len(out)
        out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
        out += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
        out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
        path.write_bytes(out)


class Raster:
    def __init__(self, w, h, scale):
        self.img = Image.new("RGB", (int(w), int(h)), "white")
        self.d = ImageDraw.Draw(self.img)
        self.k = scale  # pixels per drawing unit (the drawing units are points here)
        try:
            self.font = ImageFont.truetype("arial.ttf", 14)
        except OSError:
            self.font = ImageFont.load_default()

    def P(self, p):
        return (p[0] * self.k, p[1] * self.k)

    def poly(self, pts, fill=None, stroke=None, width=0.5, close=True):
        q = [self.P(p) for p in pts]
        if fill:
            self.d.polygon(q, fill=fill)
        if stroke:
            self.d.line(q + ([q[0]] if close else []), fill=stroke, width=max(1, round(width * self.k)))

    def line(self, a, b, color=(0, 0, 0), width=0.4):
        self.poly([a, b], stroke=color, width=width, close=False)

    def rings(self, rings, fill):
        for r in rings:  # outer rings only matter for axis-aligned unions drawn on white
            self.d.polygon([self.P(p) for p in r], fill=fill)

    def arc(self, c, r, a0, a1, color=(0, 0, 0), width=0.3):
        cx, cy = self.P(c)
        R = r * self.k
        self.d.arc([cx - R, cy - R, cx + R, cy + R], math.degrees(a0), math.degrees(a1), fill=color, width=max(1, round(width * self.k)))

    def text(self, p, s, size=9):
        self.d.text(self.P(p), s, fill="black", font=self.font)


# ---------- styles ----------


def draw_plan(canvas, walls, openings, rooms, style, to_page, rnd):
    """Draws the flat on a canvas in page units. to_page maps plan cm to page units."""
    rects = solid_pieces(walls, openings)
    tp = lambda p: to_page(p[0], p[1])
    rect_pts = lambda r: [tp((r[0], r[1])), tp((r[2], r[1])), tp((r[2], r[3])), tp((r[0], r[3]))]
    pt_per_cm = math.dist(to_page(0, 0), to_page(100, 0)) / 100

    if style == "app":
        # A grid over the page, coloured rooms and furniture, like an app export.
        x0, y0 = to_page(-200, -200)
        for k in range(-4, 60):
            canvas.line(to_page(k * 50, -200), to_page(k * 50, 1600), (225, 228, 232), 0.2)
            canvas.line(to_page(-200, k * 50), to_page(1600, k * 50), (225, 228, 232), 0.2)
        palette = [(250, 240, 222), (238, 246, 230), (243, 232, 246), (230, 238, 250), (228, 245, 243)]
        for n, (rx0, ry0, rx1, ry1) in enumerate(rooms):
            canvas.poly(rect_pts((rx0, ry0, rx1, ry1)), fill=palette[n % len(palette)])
            for _ in range(rnd.randrange(1, 3)):
                fw, fd = rnd.randrange(40, 160), rnd.randrange(40, 90)
                fx = rnd.uniform(rx0 + 30, max(rx0 + 31, rx1 - 30 - fw))
                fy = rnd.uniform(ry0 + 30, max(ry0 + 31, ry1 - 30 - fd))
                canvas.poly(rect_pts((fx, fy, fx + fw, fy + fd)), fill=rnd.choice([(184, 160, 130), (160, 180, 200), (150, 200, 160), (140, 140, 150)]), stroke=(60, 60, 60), width=0.3)

    if style in ("poche", "app", "scan"):
        color = (45, 45, 48) if style == "app" else (0, 0, 0)
        for r in rects:
            canvas.poly(rect_pts(r), fill=color)
    elif style == "union":
        canvas.rings([[tp(q) for q in ring] for ring in union_outline(rects)], (0, 0, 0))
    elif style in ("outline", "hatch"):
        for ring in union_outline(rects):
            canvas.poly([tp(q) for q in ring], stroke=(0, 0, 0), width=0.7)
        if style == "hatch":
            for r in rects:
                # 45° hatching clipped to each wall rectangle.
                w, h = r[2] - r[0], r[3] - r[1]
                for k in range(-int(h), int(w), 8):
                    a = (r[0] + max(k, 0), r[1] + max(-k, 0))
                    s = min(w - max(k, 0), h - max(-k, 0))
                    if s > 0:
                        canvas.line(tp(a), tp((a[0] + s, a[1] + s)), (0, 0, 0), 0.25)

    blue = (40, 90, 200) if style in ("outline", "hatch") else (0, 0, 0)
    for o in openings:
        a, b, n, t = opening_geometry(walls, o)
        if o[3] == "window":
            if style == "app":
                ring = [(a[0] + n[0] * t / 2, a[1] + n[1] * t / 2), (b[0] + n[0] * t / 2, b[1] + n[1] * t / 2),
                        (b[0] - n[0] * t / 2, b[1] - n[1] * t / 2), (a[0] - n[0] * t / 2, a[1] - n[1] * t / 2)]
                canvas.poly([tp(q) for q in ring], fill=(190, 220, 245))
            for off in (-t / 2, 0, t / 2):
                canvas.line(tp((a[0] + n[0] * off, a[1] + n[1] * off)), tp((b[0] + n[0] * off, b[1] + n[1] * off)), blue, 0.3)
        else:
            width = math.dist(a, b)
            side = rnd.choice([1, -1])
            hinge = (a[0] + n[0] * t / 2 * side, a[1] + n[1] * t / 2 * side)
            leaf = (hinge[0] + n[0] * width * side, hinge[1] + n[1] * width * side)
            canvas.line(tp(hinge), tp(leaf), blue, 0.35)
            a0 = math.atan2(leaf[1] - hinge[1], leaf[0] - hinge[0])
            a1 = math.atan2(b[1] + n[1] * t / 2 * side - hinge[1], b[0] + n[0] * t / 2 * side - hinge[0])
            diff = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
            lo, hi = (a0, a0 + diff) if diff > 0 else (a0 + diff, a0)
            canvas.arc(tp(hinge), width * pt_per_cm, *sorted(_screen_angles(to_page, hinge, lo, hi, width)), color=blue, width=0.25)

    # Labels, and a dimension line along the top (the sort of clutter real plans have).
    for n, (rx0, ry0, rx1, ry1) in enumerate(rooms):
        canvas.text(tp(((rx0 + rx1) / 2 - 40, (ry0 + ry1) / 2)), f"Room {n + 1}")
    W = walls[0][2]
    canvas.line(tp((0, -90)), tp((W, -90)), (0, 0, 0), 0.25)
    for x in (0, W):
        canvas.line(tp((x, -105)), tp((x, -75)), (0, 0, 0), 0.25)
    canvas.text(tp((W / 2 - 30, -100)), f"{W} cm")


def _screen_angles(to_page, c, lo, hi, r):
    """Arc angles after mapping to the page (rotation changes them)."""
    pc = to_page(*c)
    out = []
    for a in (lo, hi):
        p = to_page(c[0] + r * math.cos(a), c[1] + r * math.sin(a))
        out.append(math.atan2(p[1] - pc[1], p[0] - pc[0]))
    if out[1] < out[0]:
        out[1] += 2 * math.pi
    if out[1] - out[0] > math.pi:
        out = [out[1] - 2 * math.pi, out[0]]
    return out


def rotate_about(cx, cy, deg):
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return lambda x, y: (cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c)


STYLES = {
    # name: (format, style, rotation choices in degrees)
    "pdf-poche": ("pdf", "poche", [0]),
    "pdf-union": ("pdf", "union", [0]),
    "pdf-outline": ("pdf", "outline", [0]),
    "pdf-hatch": ("pdf", "hatch", [0]),
    "pdf-app": ("pdf", "app", [0]),
    "png-clean": ("png", "poche", [0]),
    "png-outline": ("png", "outline", [0]),
    "jpg-scan": ("jpg", "scan", [-2.5, -1.2, 1.5, 2.8]),
}


def main(args):
    per_style = int(args[0]) if args else 5
    OUT.mkdir(exist_ok=True)
    for old in OUT.glob("*.*"):
        if old.suffix in (".pdf", ".png", ".jpg") or old.name == "manifest.json":
            old.unlink()
    manifest = []
    for name, (fmt, style, rotations) in STYLES.items():
        for seed in range(1, per_style + 1):
            rnd = random.Random(f"{name}-{seed}")
            walls, openings, rooms = make_flat(rnd)
            W, H = walls[0][2], walls[1][3]
            rot = rnd.choice(rotations)
            turn = rotate_about(W / 2, H / 2, rot)
            margin = 250  # cm around the flat, for dimension lines and labels
            file = f"{name}-{seed}.{fmt}"

            if fmt == "pdf":
                page_w = (W + 2 * margin) * PT_PER_CM
                page_h = (H + 2 * margin) * PT_PER_CM
                to_page = lambda x, y: tuple((v + margin) * PT_PER_CM for v in turn(x, y))
                canvas = Pdf(page_w, page_h)
                draw_plan(canvas, walls, openings, rooms, style, to_page, rnd)
                canvas.save(OUT / file)
                # The importer maps 1 pt to CM_PER_PT cm, measured from the top-left corner.
                to_import = lambda x, y: tuple(v * CM_PER_PT for v in to_page(x, y))
            else:
                px_per_cm = rnd.choice([1.5, 2, 2.5])
                to_page = lambda x, y: tuple((v + margin) for v in turn(x, y))  # page unit: 1 cm
                canvas = Raster((W + 2 * margin) * px_per_cm, (H + 2 * margin) * px_per_cm, px_per_cm)
                draw_plan(canvas, walls, openings, rooms, style, to_page, rnd)
                img = canvas.img
                if style == "scan":
                    img = img.filter(ImageFilter.GaussianBlur(0.9))
                    noise = Image.effect_noise(img.size, 18).convert("RGB")
                    img = Image.blend(img, noise, 0.12)
                    img = Image.eval(img, lambda v: int(60 + v * 0.72))  # grey paper, faded ink
                if fmt == "jpg":
                    img.save(OUT / file, quality=55)
                else:
                    img.save(OUT / file)
                # Pictures import at 1 px = 1 cm until calibrated.
                to_import = lambda x, y: tuple(v * px_per_cm for v in to_page(x, y))

            scale = math.dist(to_import(0, 0), to_import(100, 0)) / 100  # import units per cm
            truth_walls = []
            for x1, y1, x2, y2, t in walls:
                a, b = to_import(x1, y1), to_import(x2, y2)
                truth_walls.append({"a": {"x": a[0], "y": a[1]}, "b": {"x": b[0], "y": b[1]}, "thickness": t * scale})
            truth_openings = []
            for o in openings:
                a, b, _, _ = opening_geometry(walls, o)
                ca = to_import((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
                truth_openings.append({"kind": o[3], "center": {"x": ca[0], "y": ca[1]}, "width": math.dist(a, b) * scale})
            manifest.append({"file": file, "style": name, "rotation": rot, "scale": scale,
                             "walls": truth_walls, "openings": truth_openings})
            print(f"{file:22} {len(walls):3} walls {len(openings):3} openings  rotation {rot}")
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    print(f"{len(manifest)} plans in {OUT}")


if __name__ == "__main__":
    main(sys.argv[1:])
