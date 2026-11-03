"""Generates test floorplans in every supported format, all of the same small apartment.

    python tools/make_samples.py

Writes to samples/. Needs Pillow (pip install pillow).
The apartment is 9 m x 7 m (wall centre to wall centre) with three rooms.
"""

import math
import random
import string
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "samples"

# ---------- the apartment, in cm, x right and y down ----------

# (x1, y1, x2, y2, thickness)
WALLS = [
    (0, 0, 900, 0, 20),
    (900, 0, 900, 700, 20),
    (900, 700, 0, 700, 20),
    (0, 700, 0, 0, 20),
    (500, 0, 500, 700, 10),
    (0, 400, 500, 400, 10),
]

# (wall index, centre along the wall measured from its start, width, kind, sill, height)
OPENINGS = [
    (4, 200, 80, "door", 0, 210),
    (5, 250, 80, "door", 0, 210),
    (2, 200, 90, "door", 0, 210),  # front door
    (0, 250, 120, "window", 90, 120),
    (0, 700, 160, "window", 90, 120),
    (1, 350, 120, "window", 90, 120),
    (3, 150, 80, "window", 90, 120),
]

ROOMS = [
    ("Bedroom", [(0, 0), (500, 0), (500, 400), (0, 400)]),
    ("Bathroom", [(0, 400), (500, 400), (500, 700), (0, 700)]),
    ("Living room", [(500, 0), (900, 0), (900, 700), (500, 700)]),
]


def wall_dir(w):
    x1, y1, x2, y2, _ = w
    length = math.hypot(x2 - x1, y2 - y1)
    return (x2 - x1) / length, (y2 - y1) / length, length


def openings_on(i):
    return sorted((o for o in OPENINGS if o[0] == i), key=lambda o: o[1])


def wall_pieces(i):
    """The solid parts of wall i as axis-aligned rectangles (x0, y0, x1, y1), with openings left out."""
    w = WALLS[i]
    ux, uy, length = wall_dir(w)
    half = w[4] / 2
    cuts = [(c - wd / 2, c + wd / 2) for _, c, wd, *_ in openings_on(i)]
    pieces, t = [], -half if i < 4 else 0  # outer walls overlap at the corners
    end = length + half if i < 4 else length
    for a, b in cuts + [(end, end)]:
        if a > t:
            p = (w[0] + ux * t, w[1] + uy * t)
            q = (w[0] + ux * a, w[1] + uy * a)
            pieces.append((min(p[0], q[0]) - abs(uy) * half, min(p[1], q[1]) - abs(ux) * half,
                           max(p[0], q[0]) + abs(uy) * half, max(p[1], q[1]) + abs(ux) * half))
        t = b
    return pieces


def opening_geom(o):
    """Start point, end point and unit normal of an opening on its wall's centreline."""
    w = WALLS[o[0]]
    ux, uy, _ = wall_dir(w)
    a = (w[0] + ux * (o[1] - o[2] / 2), w[1] + uy * (o[1] - o[2] / 2))
    b = (w[0] + ux * (o[1] + o[2] / 2), w[1] + uy * (o[1] + o[2] / 2))
    return a, b, (-uy, ux), w[4]


# ---------- raster images ----------

def draw_png(px_per_cm=2, margin=80):
    size = (int(900 * px_per_cm + 2 * margin), int(700 * px_per_cm + 2 * margin + 80))
    img = Image.new("RGB", size, "white")
    d = ImageDraw.Draw(img)
    P = lambda x, y: (margin + x * px_per_cm, margin + 80 + y * px_per_cm)
    try:
        font = ImageFont.truetype("arial.ttf", 22)
    except OSError:
        font = ImageFont.load_default()

    for i in range(len(WALLS)):
        for x0, y0, x1, y1 in wall_pieces(i):
            d.rectangle([P(x0, y0), P(x1, y1)], fill="black")
    for o in OPENINGS:
        a, b, n, t = opening_geom(o)
        if o[3] == "window":
            for off in (-t / 2, 0, t / 2):
                d.line([P(a[0] + n[0] * off, a[1] + n[1] * off), P(b[0] + n[0] * off, b[1] + n[1] * off)], fill="black", width=2)
        else:
            # door leaf, opened 90 degrees, plus the swing arc
            leaf = (a[0] + n[0] * o[2], a[1] + n[1] * o[2])
            d.line([P(*a), P(*leaf)], fill="black", width=3)
            r = o[2] * px_per_cm
            cx, cy = P(*a)
            start = math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))
            sweep = math.degrees(math.atan2(n[1], n[0]))
            lo, hi = sorted((start, sweep))
            if hi - lo > 180:
                lo, hi = hi, lo + 360
            d.arc([cx - r, cy - r, cx + r, cy + r], lo, hi, fill="gray", width=1)
    for name, pts in ROOMS:
        cx = sum(p[0] for p in pts) / len(pts)
        cy = sum(p[1] for p in pts) / len(pts)
        d.text(P(cx, cy), name, fill="#444", font=font, anchor="mm")

    # dimension line over the top: outer face to outer face = 920 cm
    y = -50
    d.line([P(-10, y), P(910, y)], fill="black", width=2)
    for x in (-10, 910):
        d.line([P(x, y - 8), P(x, y + 8)], fill="black", width=2)
    d.text(P(450, y - 6), "920 cm", fill="black", font=font, anchor="mb")
    return img


def solve(A, b):
    n = len(b)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(M[r][c]))
        M[c], M[p] = M[p], M[c]
        for r in range(n):
            if r != c:
                f = M[r][c] / M[c][c]
                M[r] = [x - f * y for x, y in zip(M[r], M[c])]
    return [M[i][n] / M[i][i] for i in range(n)]


def perspective_coeffs(dst, src):
    """Coefficients for Image.transform: maps output points dst[i] to input points src[i]."""
    A, b = [], []
    for (x, y), (u, v) in zip(dst, src):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); b.append(v)
    return solve(A, b)


def camera_quad(w, h, out, tilt=38, turn=12, f=1500, distance=3300):
    """Corners of a w x h sheet seen by a pinhole camera looking down at it at an angle."""
    t, r = math.radians(tilt), math.radians(turn)
    corners = []
    for x, y in [(0, 0), (w, 0), (w, h), (0, h)]:
        x, y = x - w / 2, y - h / 2
        x, y = x * math.cos(r) - y * math.sin(r), x * math.sin(r) + y * math.cos(r)  # turn on the table
        y, z = y * math.cos(t), distance + y * math.sin(t)  # tilt away from the camera
        corners.append((out[0] / 2 + f * x / z, out[1] / 2 + f * y / z))
    return corners


def make_photo(plan):
    """The plan as if photographed at an angle, lying on a grey table."""
    w, h = plan.size
    out = (1600, 1200)
    quad = camera_quad(w, h, out)  # where the plan's corners land
    coeffs = perspective_coeffs(quad, [(0, 0), (w, 0), (w, h), (0, h)])
    warped = plan.transform(out, Image.PERSPECTIVE, coeffs, Image.BICUBIC, fillcolor=(120, 115, 108))
    return warped.convert("RGB")


# ---------- PDF ----------

def pdf_page_content(scale_pt_per_cm, ox, oy, walls_only=False):
    s = scale_pt_per_cm
    ops = ["q", f"{s:.5f} 0 0 {-s:.5f} {ox} {oy} cm", "0.25 g", "0 G", f"{1 / s:.3f} w"]
    for i in range(len(WALLS)):
        for x0, y0, x1, y1 in wall_pieces(i):
            ops.append(f"{x0} {y0} {x1 - x0} {y1 - y0} re B")
    if not walls_only:
        for o in OPENINGS:
            a, b, n, t = opening_geom(o)
            if o[3] == "window":
                for off in (-t / 2, t / 2):
                    ops.append(f"{a[0] + n[0] * off:.1f} {a[1] + n[1] * off:.1f} m {b[0] + n[0] * off:.1f} {b[1] + n[1] * off:.1f} l S")
            else:
                leaf = (a[0] + n[0] * o[2], a[1] + n[1] * o[2])
                ops.append(f"{a[0]:.1f} {a[1]:.1f} m {leaf[0]:.1f} {leaf[1]:.1f} l S")
                k = 0.5523 * o[2]  # quarter-circle swing as a Bezier curve
                ux, uy = (b[0] - a[0]) / o[2], (b[1] - a[1]) / o[2]
                ops.append(
                    f"{leaf[0]:.1f} {leaf[1]:.1f} m "
                    f"{leaf[0] + ux * k:.1f} {leaf[1] + uy * k:.1f} {b[0] + n[0] * k:.1f} {b[1] + n[1] * k:.1f} {b[0]:.1f} {b[1]:.1f} c S"
                )
    ops.append("Q")
    ops.append(f"BT /F1 10 Tf {ox + 450 * s - 20:.1f} {oy + 22:.1f} Td (920 cm) Tj ET")
    ops.append(f"q 1 w {ox - 10 * s:.1f} {oy + 15:.1f} m {ox + 910 * s:.1f} {oy + 15:.1f} l S Q")
    return "\n".join(ops)


def write_pdf(path):
    s = 72 / 2.54 / 100  # 1:100
    pages = [
        pdf_page_content(s, 80, 470),
        pdf_page_content(s * 0.5, 150, 400, walls_only=True),  # page 2: a smaller overview at 1:200
    ]
    objs = ["<< /Type /Catalog /Pages 2 0 R >>", None, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for content in pages:
        stream_id = len(objs) + 2
        kids.append(len(objs) + 1)
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 3 0 R >> >> /Contents {stream_id} 0 R >>")
        objs.append(f"<< /Length {len(content.encode())} >>\nstream\n{content}\nendstream")
    objs[1] = f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] /Count {len(kids)} >>"

    out = b"%PDF-1.4\n"
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{body}\nendobj\n".encode()
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    path.write_bytes(out)


# ---------- SVG ----------

def write_svg(path):
    walls = "\n".join(
        f'    <rect x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}" fill="#222"/>'
        for i in range(len(WALLS)) for x0, y0, x1, y1 in wall_pieces(i)
    )
    doors, windows = [], []
    for o in OPENINGS:
        a, b, n, t = opening_geom(o)
        if o[3] == "window":
            for off in (-t / 2, t / 2):
                windows.append(f'    <line x1="{a[0] + n[0] * off}" y1="{a[1] + n[1] * off}" x2="{b[0] + n[0] * off}" y2="{b[1] + n[1] * off}" stroke="#06c" stroke-width="2"/>')
        else:
            leaf = (a[0] + n[0] * o[2], a[1] + n[1] * o[2])
            doors.append(f'    <path d="M{a[0]},{a[1]} L{leaf[0]},{leaf[1]} A{o[2]},{o[2]} 0 0 0 {b[0]},{b[1]}" fill="none" stroke="#c60" stroke-width="2"/>')
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1060 860" width="1060" height="860">
  <rect width="1060" height="860" fill="white"/>
  <g transform="translate(80 100)">
  <g id="walls">
{walls}
  </g>
  <g id="doors">
{chr(10).join(doors)}
  </g>
  <g id="windows">
{chr(10).join(windows)}
  </g>
  <g id="dimensions">
    <line x1="-10" y1="-50" x2="910" y2="-50" stroke="black" stroke-width="2"/>
    <text x="450" y="-58" font-size="22" text-anchor="middle" font-family="sans-serif">920 cm</text>
  </g>
  </g>
</svg>
"""
    path.write_text(svg, encoding="utf-8")


# ---------- DXF (millimetres, y up) ----------

def write_dxf(path):
    mm = lambda x, y: (x * 10, -y * 10)
    out = ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", "4", "0", "ENDSEC"]

    def g(*pairs):
        for code, value in pairs:
            out.extend([str(code), str(value)])

    # A window symbol 1000 mm long, inserted and scaled per window. Its lines are on layer 0,
    # so they take the layer of each insert.
    g((0, "SECTION"), (2, "BLOCKS"), (0, "BLOCK"), (8, "0"), (2, "WINDOW"), (70, 0), (10, 0), (20, 0), (30, 0), (3, "WINDOW"))
    for y in (-60, 0, 60):
        g((0, "LINE"), (8, "0"), (10, 0), (20, y), (30, 0), (11, 1000), (21, y), (31, 0))
    g((0, "ENDBLK"), (8, "0"), (0, "ENDSEC"))

    g((0, "SECTION"), (2, "ENTITIES"))
    for i in range(len(WALLS)):
        for x0, y0, x1, y1 in wall_pieces(i):
            pts = [mm(x0, y0), mm(x1, y0), mm(x1, y1), mm(x0, y1)]
            g((0, "LWPOLYLINE"), (8, "A-WALL"), (90, 4), (70, 1))
            for x, y in pts:
                g((10, x), (20, y))
    for o in OPENINGS:
        a, b, n, t = opening_geom(o)
        if o[3] == "window":
            ax, ay = mm(*a)
            bx, by = mm(*b)
            angle = math.degrees(math.atan2(by - ay, bx - ax))
            g((0, "INSERT"), (8, "A-GLAZ"), (2, "WINDOW"), (10, ax), (20, ay), (30, 0), (41, o[2] / 100), (42, 1), (50, angle))
        else:
            leaf = (a[0] + n[0] * o[2], a[1] + n[1] * o[2])
            (ax, ay), (lx, ly) = mm(*a), mm(*leaf)
            g((0, "LINE"), (8, "A-DOOR"), (10, ax), (20, ay), (30, 0), (11, lx), (21, ly), (31, 0))
            g((0, "ARC"), (8, "A-DOOR"), (10, ax), (20, ay), (30, 0), (40, o[2] * 10), (50, 0), (51, 90))
    g((0, "TEXT"), (8, "A-ANNO-TEXT"), (10, 4300), (20, 600), (30, 0), (40, 200), (1, "9200 mm"))
    g((0, "ENDSEC"), (0, "EOF"))
    path.write_text("\n".join(out) + "\n", encoding="ascii")


# ---------- IFC (IFC4, millimetres, z up, y = north) ----------

def write_ifc(path):
    lines, n = [], [0]
    guid_chars = string.digits + string.ascii_letters + "_$"
    rnd = random.Random(42)
    guid = lambda: "'" + "".join(rnd.choice(guid_chars) for _ in range(22)) + "'"

    def add(text):
        n[0] += 1
        lines.append(f"#{n[0]}={text};")
        return f"#{n[0]}"

    f = lambda v: f"{float(v):.1f}"
    unit = add("IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)")
    units = add(f"IFCUNITASSIGNMENT(({unit}))")
    origin = add("IFCCARTESIANPOINT((0.,0.,0.))")
    world = add(f"IFCAXIS2PLACEMENT3D({origin},$,$)")
    context = add(f"IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,{world},$)")
    zdir = add("IFCDIRECTION((0.,0.,1.))")
    project = add(f"IFCPROJECT({guid()},$,'Sample apartment',$,$,$,$,({context}),{units})")
    site = add(f"IFCSITE({guid()},$,'Site',$,$,{add(f'IFCLOCALPLACEMENT($,{world})')},$,$,.ELEMENT.,$,$,$,$,$)")
    building = add(f"IFCBUILDING({guid()},$,'Building',$,$,{add(f'IFCLOCALPLACEMENT($,{world})')},$,$,.ELEMENT.,$,$,$)")
    add(f"IFCRELAGGREGATES({guid()},$,$,$,{project},({site}))")
    add(f"IFCRELAGGREGATES({guid()},$,$,$,{site},({building}))")

    def box(entity, x, y, z, dx, dy, length, width, height, name):
        """An element extruded upwards from a rectangle starting at (x, y, z), running along (dx, dy)."""
        pt = add(f"IFCCARTESIANPOINT(({f(x)},{f(y)},{f(z)}))")
        ref = add(f"IFCDIRECTION(({dx:.6f},{dy:.6f},0.))")
        placement = add(f"IFCLOCALPLACEMENT($,{add(f'IFCAXIS2PLACEMENT3D({pt},{zdir},{ref})')})")
        centre = add(f"IFCAXIS2PLACEMENT2D({add(f'IFCCARTESIANPOINT(({f(length / 2)},0.))')},$)")
        profile = add(f"IFCRECTANGLEPROFILEDEF(.AREA.,$,{centre},{f(length)},{f(width)})")
        solid = add(f"IFCEXTRUDEDAREASOLID({profile},{world},{zdir},{f(height)})")
        shape = add(f"IFCSHAPEREPRESENTATION({context},'Body','SweptSolid',({solid}))")
        rep = add(f"IFCPRODUCTDEFINITIONSHAPE($,$,({shape}))")
        extra = {"IFCWALL": ",$,.STANDARD.", "IFCDOOR": ",$,2100.,900.,.DOOR.,.SINGLE_SWING_LEFT.,$", "IFCWINDOW": ",$,1200.,1200.,.WINDOW.,.SINGLE_PANEL.,$"}[entity]
        return add(f"{entity}({guid()},$,'{name}',$,$,{placement},{rep}{extra})")

    def storey(name, elevation, wall_ids, with_openings):
        st = add(f"IFCBUILDINGSTOREY({guid()},$,'{name}',$,$,{add(f'IFCLOCALPLACEMENT($,{world})')},$,$,.ELEMENT.,{f(elevation)})")
        add(f"IFCRELAGGREGATES({guid()},$,$,$,{building},({st}))")
        elements = []
        for i in wall_ids:
            x1, y1, x2, y2, t = WALLS[i]
            ux, uy, length = wall_dir(WALLS[i])
            # plan cm (y down) -> IFC mm (y up)
            elements.append(box("IFCWALL", x1 * 10, -y1 * 10, elevation, ux, -uy, length * 10, t * 10, 2500, f"Wall {i + 1}"))
            if with_openings:
                for o in openings_on(i):
                    a, _, _, _ = opening_geom(o)
                    entity = "IFCDOOR" if o[3] == "door" else "IFCWINDOW"
                    elements.append(box(entity, a[0] * 10, -a[1] * 10, elevation + o[4] * 10, ux, -uy, o[2] * 10, t * 5, o[5] * 10, o[3]))
        add(f"IFCRELCONTAINEDINSPATIALSTRUCTURE({guid()},$,$,$,({','.join(elements)}),{st})")

    storey("Ground floor", 0, range(len(WALLS)), True)
    storey("First floor", 2800, range(4), False)

    header = (
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');\n"
        "FILE_NAME('plan.ifc','2026-01-01T00:00:00',(''),(''),'make_samples.py','','');\n"
        "FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n"
    )
    path.write_text(header + "\n".join(lines) + "\nENDSEC;\nEND-ISO-10303-21;\n", encoding="ascii")


# ---------- Sweet Home 3D ----------

def write_sh3d(path):
    parts = ["<?xml version='1.0'?>", "<home version='7200' name='plan.sh3d' wallHeight='250'>",
             "  <level id='level0' name='Ground floor' elevation='0' floorThickness='12' height='250' elevationIndex='0'/>",
             "  <level id='level1' name='First floor' elevation='262' floorThickness='12' height='250' elevationIndex='1'/>"]
    for name, pts in ROOMS:
        parts.append(f"  <room level='level0' name='{name}' areaVisible='true'>")
        parts += [f"    <point x='{x}' y='{y}'/>" for x, y in pts]
        parts.append("  </room>")
    for i, (x1, y1, x2, y2, t) in enumerate(WALLS):
        parts.append(f"  <wall id='wall{i}' level='level0' xStart='{x1}' yStart='{y1}' xEnd='{x2}' yEnd='{y2}' height='250' thickness='{t}'/>")
    for i, (x1, y1, x2, y2, t) in enumerate(WALLS[:4]):
        parts.append(f"  <wall id='upper{i}' level='level1' xStart='{x1}' yStart='{y1}' xEnd='{x2}' yEnd='{y2}' height='250' thickness='{t}'/>")
    for o in OPENINGS:
        a, b, _, t = opening_geom(o)
        cx, cy = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
        angle = math.atan2(b[1] - a[1], b[0] - a[0])
        name = "Door" if o[3] == "door" else "Window"
        parts.append(
            f"  <doorOrWindow level='level0' catalogId='eTeks#{name.lower()}' name='{name}' x='{cx}' y='{cy}' "
            f"elevation='{o[4]}' angle='{angle:.4f}' width='{o[2]}' depth='{t}' height='{o[5]}' model='/0' icon='/1'/>"
        )
    parts.append("</home>")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("Home.xml", "\n".join(parts) + "\n")


def main():
    OUT.mkdir(exist_ok=True)
    plan = draw_png()
    plan.save(OUT / "plan.png")
    plan.save(OUT / "plan.jpg", quality=90)
    plan.save(OUT / "plan.webp", quality=90)
    # Two-page TIFF: the plan, and a mirrored copy, to test page selection.
    plan.save(OUT / "plan.tiff", save_all=True, append_images=[plan.transpose(Image.FLIP_LEFT_RIGHT)], compression="tiff_lzw")
    make_photo(plan).save(OUT / "plan-photo.jpg", quality=88)
    write_pdf(OUT / "plan.pdf")
    write_svg(OUT / "plan.svg")
    write_dxf(OUT / "plan.dxf")
    write_ifc(OUT / "plan.ifc")
    write_sh3d(OUT / "plan.sh3d")
    for p in sorted(OUT.iterdir()):
        print(f"{p.name:16} {p.stat().st_size // 1024:6} KB")


if __name__ == "__main__":
    main()
