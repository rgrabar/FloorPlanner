"""Generates test floorplans with known answers, for testing wall and furniture detection.

    python tools/make_bench.py [count per style, default 5]

Each plan is a random flat (outer walls, inner walls with T-junctions, doors, windows) drawn in
several styles, the way real plans come: filled walls, outlined walls, hatched walls, app exports
with grids and named furniture, clean pictures and bad scans. Every room is furnished (beds, sofas,
tables with chairs, wardrobes, kitchens, bathrooms) with CAD symbols or coloured named patches.
Next to each file the exact walls, openings and furniture are written to bench/manifest.json, in
the coordinates the app's importer produces.
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


# ---------- furniture ----------

# (model, width along the wall, depth from the wall). Sets per kind of room, biggest first.
PIECES = {
    "bed2": ("generic-bed", 170, 215), "bed1": ("generic-bed", 100, 210), "sofa": ("generic-sofa", 210, 90),
    "armchair": ("generic-armchair", 80, 80), "table": ("generic-dining-table", 140, 80),
    "desk": ("generic-desk", 120, 60), "wardrobe": ("generic-wardrobe", 150, 60), "tv": ("generic-tv-unit", 160, 40),
    "bookcase": ("generic-bookcase", 80, 30), "toilet": ("generic-toilet", 38, 68), "basin": ("generic-washbasin", 60, 45),
    "tub": ("generic-bathtub", 170, 75), "kitchen": ("generic-kitchen-base", 240, 60), "nightstand": ("generic-nightstand", 45, 40),
}
ROOM_SETS = [
    (14, [["sofa", "tv", "armchair", "table"], ["bed2", "wardrobe", "desk"], ["kitchen", "table", "sofa"]]),
    (8, [["bed2", "wardrobe"], ["bed1", "desk", "wardrobe"], ["sofa", "tv", "bookcase"], ["kitchen", "table"]]),
    (0, [["toilet", "basin"], ["tub", "basin", "toilet"], ["bookcase", "wardrobe"]]),
]
LABELS = {
    "generic-bed": ["Bed", "MALM", "Double bed"], "generic-sofa": ["Sofa", "KIVIK 3-seat sofa"], "generic-armchair": ["Armchair", "POANG"],
    "generic-dining-table": ["Dining table", "LISABO table"], "generic-desk": ["Desk", "MICKE"], "generic-wardrobe": ["Wardrobe", "PAX"],
    "generic-tv-unit": ["TV unit", "BESTA"], "generic-bookcase": ["Bookcase", "BILLY"], "generic-toilet": ["Toilet", "WC"],
    "generic-washbasin": ["Washbasin"], "generic-bathtub": ["Bath tub", "Bathtub"], "generic-kitchen-base": ["Kitchen", "Kitchen base"],
    "generic-chair": ["Chair"], "generic-office-chair": ["Chair"], "generic-nightstand": ["Bedside"],
}


def furnish(walls, openings, rooms, rnd):
    """Pieces against the walls of each room, clear of doors and of each other.
    Each piece: (model, centre x, y, rotation, width, depth); rotation as in the app (0 = back up)."""
    doors = []  # door centres, with their width
    for o in openings:
        if o[3] == "door":
            a, b, _, _ = opening_geometry(walls, o)
            doors.append(((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, math.dist(a, b)))
    t_in = max(w[4] for w in walls[4:]) if len(walls) > 4 else 12
    t_out = walls[0][4]
    placed = []

    def free(rect):
        x0, y0, x1, y1 = rect
        for dx, dy, dw in doors:  # a door's swing needs about its width of room
            if x0 - dw - 10 < dx < x1 + dw + 10 and y0 - dw - 10 < dy < y1 + dw + 10:
                return False
        return all(x1 + 15 < q[0] or x0 - 15 > q[2] or y1 + 15 < q[1] or y0 - 15 > q[3] for q in (p[6] for p in placed))

    for (rx0, ry0, rx1, ry1) in rooms:
        # The room's inside: half a wall in from each centreline (outer walls are thicker).
        ix0 = rx0 + (t_out if rx0 == 0 else t_in) / 2
        iy0 = ry0 + (t_out if ry0 == 0 else t_in) / 2
        ix1 = rx1 - (t_out if rx1 == walls[0][2] else t_in) / 2
        iy1 = ry1 - (t_out if ry1 == walls[1][3] else t_in) / 2
        area = (ix1 - ix0) * (iy1 - iy0) / 1e4
        sets = next(options for limit, options in ROOM_SETS if area >= limit)
        for key in rnd.choice(sets):
            model, w, d = PIECES[key]
            if key == "table":  # tables stand in the room, with chairs round them
                cx, cy = (ix0 + ix1) / 2 + rnd.uniform(-30, 30), (iy0 + iy1) / 2 + rnd.uniform(-30, 30)
                along_x = (ix1 - ix0) >= (iy1 - iy0)
                hw, hd = (w / 2, d / 2) if along_x else (d / 2, w / 2)
                rect = (cx - hw - 55, cy - hd - 55, cx + hw + 55, cy + hd + 55)
                if rect[0] < ix0 or rect[2] > ix1 or rect[1] < iy0 or rect[3] > iy1 or not free(rect):
                    continue
                rot = 0 if along_x else 90
                placed.append((model, cx, cy, rot, w, d, rect))
                for side in (-1, 1):  # two chairs on each long side, facing the table
                    for k in (-0.25, 0.25):
                        if along_x:
                            placed.append(("generic-chair", cx + k * w, cy + side * (hd + 25), 0 if side < 0 else 180, 45, 45, (0, 0, 0, 0)))
                        else:
                            placed.append(("generic-chair", cx + side * (hw + 25), cy + k * w, 270 if side < 0 else 90, 45, 45, (0, 0, 0, 0)))
                continue
            for _ in range(25):
                side = rnd.choice(["top", "bottom", "left", "right"])
                if side in ("top", "bottom"):
                    if ix1 - ix0 < w + 10:
                        continue
                    cx = rnd.uniform(ix0 + w / 2, ix1 - w / 2)
                    cy = iy0 + d / 2 if side == "top" else iy1 - d / 2
                    rect = (cx - w / 2, cy - d / 2, cx + w / 2, cy + d / 2)
                else:
                    if iy1 - iy0 < w + 10:
                        continue
                    cy = rnd.uniform(iy0 + w / 2, iy1 - w / 2)
                    cx = ix0 + d / 2 if side == "left" else ix1 - d / 2
                    rect = (cx - d / 2, cy - w / 2, cx + d / 2, cy + w / 2)
                if not free(rect):
                    continue
                rot = {"top": 0, "right": 90, "bottom": 180, "left": 270}[side]
                placed.append((model, cx, cy, rot, w, d, rect))
                if key == "desk":  # its chair, pushed in
                    fx, fy = -math.sin(math.radians(rot)), math.cos(math.radians(rot))
                    placed.append(("generic-office-chair", cx + fx * (d / 2 + 5), cy + fy * (d / 2 + 5), (rot + 180) % 360, 45, 45, (0, 0, 0, 0)))
                break
    return [p[:6] for p in placed]


def footprint(piece):
    model, cx, cy, rot, w, d = piece
    r = math.radians(rot)
    u, v = (math.cos(r), math.sin(r)), (-math.sin(r), math.cos(r))
    return [(cx + u[0] * a + v[0] * b, cy + u[1] * a + v[1] * b) for a, b in ((-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2))]


def piece_outline(piece):
    """Drawing primitives in plan cm for a CAD symbol: ('poly', pts, closed) items."""
    model, cx, cy, rot, w, d = piece
    r = math.radians(rot)
    u = (math.cos(r), math.sin(r))  # along the front, left to right
    v = (-math.sin(r), math.cos(r))  # back to front

    def P(a, b):  # a across (-w/2..w/2), b from the back (0..d)
        return (cx + u[0] * a + v[0] * (b - d / 2), cy + u[1] * a + v[1] * (b - d / 2))

    def rect(a0, b0, a1, b1):
        return ("poly", [P(a0, b0), P(a1, b0), P(a1, b1), P(a0, b1)], True)

    def ellipse(ca, cb, ra, rb, n=20):
        return ("poly", [P(ca + ra * math.cos(2 * math.pi * k / n), cb + rb * math.sin(2 * math.pi * k / n)) for k in range(n)], True)

    def line(a0, b0, a1, b1):
        return ("poly", [P(a0, b0), P(a1, b1)], False)

    h = w / 2
    out = [rect(-h, 0, h, d)]
    if model == "generic-bed":
        pillows = 2 if w >= 140 else 1
        pw = (w - 30) / pillows
        for k in range(pillows):
            out.append(rect(-h + 10 + k * (pw + 10), 8, -h + 10 + k * (pw + 10) + pw, 45))
        out.append(line(-h, 70, h, 70))  # the turned-down cover
        out.append(line(h - 40, 70, h, 110))
    elif model in ("generic-sofa", "generic-armchair"):
        arm = 18 if model == "generic-sofa" else 15
        out += [line(-h, 22, h, 22), line(-h + arm, 22, -h + arm, d), line(h - arm, 22, h - arm, d)]
        if model == "generic-sofa":
            out += [line(-h + arm + (w - 2 * arm) / 3, 22, -h + arm + (w - 2 * arm) / 3, d - 5),
                    line(-h + arm + 2 * (w - 2 * arm) / 3, 22, -h + arm + 2 * (w - 2 * arm) / 3, d - 5)]
    elif model == "generic-wardrobe":
        out += [line(-h, 0, h, d), line(-h, d, h, 0)]
    elif model == "generic-tv-unit":
        out.append(rect(-h + 5, 5, h - 5, d - 5))
    elif model == "generic-bookcase":
        out.append(line(-h, d / 2, h, d / 2))
    elif model == "generic-toilet":
        out = [rect(-19, 0, 19, 18), ellipse(0, 18 + 24, 17, 24)]
    elif model == "generic-washbasin":
        out.append(ellipse(0, d / 2 + 2, w / 2 - 8, d / 2 - 8))
    elif model == "generic-bathtub":
        out += [rect(-h + 6, 6, h - 6, d - 6), ellipse(h - 20, d / 2, 3, 3, 10)]
    elif model == "generic-kitchen-base":
        for k in range(1, int(w // 60)):
            out.append(line(-h + 60 * k, 0, -h + 60 * k, d))
        out += [rect(-h + 68, 8, -h + 112, 50), ellipse(-h + 90, 29, 15, 14)]  # the sink
        for a, b in ((h - 45, 18), (h - 15, 18), (h - 45, 42), (h - 15, 42)):  # the hob
            out.append(ellipse(a, b, 8, 8, 12))
    elif model == "generic-dining-table":
        pass
    elif model == "generic-desk":
        out.append(line(-h + 5, 5, -h + 45, 5))
    elif model in ("generic-chair", "generic-office-chair"):
        out = [rect(-20, 0, 20, 8), rect(-18, 8, 18, 40)]
    elif model == "generic-nightstand":
        out.append(rect(-h + 5, 5, h - 5, d - 5))
    return out


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


def draw_plan(canvas, walls, openings, rooms, furniture, style, to_page, rnd):
    """Draws the flat on a canvas in page units. to_page maps plan cm to page units."""
    rects = solid_pieces(walls, openings)
    tp = lambda p: to_page(p[0], p[1])
    rect_pts = lambda r: [tp((r[0], r[1])), tp((r[2], r[1])), tp((r[2], r[3])), tp((r[0], r[3]))]
    pt_per_cm = math.dist(to_page(0, 0), to_page(100, 0)) / 100

    if style == "app":
        # A grid over the page, coloured rooms and named furniture, like an app export.
        x0, y0 = to_page(-200, -200)
        for k in range(-4, 60):
            canvas.line(to_page(k * 50, -200), to_page(k * 50, 1600), (225, 228, 232), 0.2)
            canvas.line(to_page(-200, k * 50), to_page(1600, k * 50), (225, 228, 232), 0.2)
        palette = [(250, 240, 222), (238, 246, 230), (243, 232, 246), (230, 238, 250), (228, 245, 243)]
        for n, (rx0, ry0, rx1, ry1) in enumerate(rooms):
            canvas.poly(rect_pts((rx0, ry0, rx1, ry1)), fill=palette[n % len(palette)])
        colours = [(184, 160, 130), (160, 180, 200), (150, 200, 160), (170, 150, 190), (150, 190, 200)]
        for piece in furniture:
            model, cx, cy, rot, w, d = piece
            corners = footprint(piece)
            canvas.poly([tp(q) for q in corners], fill=colours[sum(map(ord, model)) % len(colours)], stroke=(60, 60, 60), width=0.3)
            if model not in ("generic-chair", "generic-office-chair", "generic-nightstand"):
                name = rnd.choice(LABELS.get(model, ["Furniture"]))
                canvas.text(tp((cx - len(name) * 4.5, cy + 4)), name, size=7)

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

    # CAD furniture symbols: green on CAD drawings with coloured layers, black otherwise.
    if style != "app":
        ink = (40, 150, 60) if style in ("outline", "hatch") else (0, 0, 0)
        for piece in furniture:
            for _, pts, closed in piece_outline(piece):
                canvas.poly([tp(q) for q in pts], stroke=ink, width=0.2, close=closed)

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
    canvas.line(tp((0, -130)), tp((W, -130)), (0, 0, 0), 0.25)
    for x in (0, W):
        canvas.line(tp((x, -145)), tp((x, -115)), (0, 0, 0), 0.25)
    canvas.text(tp((W / 2 - 30, -140)), f"{W} cm")

    # Dimension chains above and below, like an architect's plan (75 cm out, a usual distance):
    # a tick at each corner and where an inner wall meets the outer wall, and each part's length
    # written in its middle.
    H = walls[1][3]
    for y_wall, y_line in ((0, -75), (H, H + 75)):
        xs = sorted({0, W} | {x1 for x1, y1, x2, y2, _ in walls[4:] if x1 == x2 and min(abs(y1 - y_wall), abs(y2 - y_wall)) < 1})
        canvas.line(tp((0, y_line)), tp((W, y_line)), (0, 0, 0), 0.25)
        for x in xs:
            canvas.line(tp((x, y_line - 8)), tp((x, y_line + 8)), (0, 0, 0), 0.25)
        for a, b in zip(xs, xs[1:]):
            if b - a >= 60:  # room to write the number in
                text = str(round(b - a))
                canvas.text(tp(((a + b) / 2 - len(text) * 4.5, y_line - 20)), text)


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
            furniture = furnish(walls, openings, rooms, random.Random(f"{name}-{seed}-furniture"))
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
                draw_plan(canvas, walls, openings, rooms, furniture, style, to_page, rnd)
                canvas.save(OUT / file)
                # The importer maps 1 pt to CM_PER_PT cm, measured from the top-left corner.
                to_import = lambda x, y: tuple(v * CM_PER_PT for v in to_page(x, y))
            else:
                px_per_cm = rnd.choice([1.5, 2, 2.5])
                to_page = lambda x, y: tuple((v + margin) for v in turn(x, y))  # page unit: 1 cm
                canvas = Raster((W + 2 * margin) * px_per_cm, (H + 2 * margin) * px_per_cm, px_per_cm)
                draw_plan(canvas, walls, openings, rooms, furniture, style, to_page, rnd)
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
            truth_furniture = []
            for model, cx, cy, frot, w, d in furniture:
                c = to_import(cx, cy)
                # The back direction after the page's own rotation, as an app rotation angle.
                back = to_import(cx + math.sin(math.radians(frot)), cy - math.cos(math.radians(frot)))
                angle = math.degrees(math.atan2(back[0] - c[0], -(back[1] - c[1]))) % 360
                truth_furniture.append({"model": model, "center": {"x": c[0], "y": c[1]}, "rotation": angle, "width": w, "depth": d})
            manifest.append({"file": file, "style": name, "rotation": rot, "scale": scale,
                             "walls": truth_walls, "openings": truth_openings, "furniture": truth_furniture})
            print(f"{file:22} {len(walls):3} walls {len(openings):3} openings {len(furniture):3} furniture  rotation {rot}")
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    print(f"{len(manifest)} plans in {OUT}")


if __name__ == "__main__":
    main(sys.argv[1:])
