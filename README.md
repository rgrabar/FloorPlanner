# FloorPlanner

Load a floorplan, turn it into a 3D model and place accurately modelled IKEA furniture in it.
See [PROMPT.md](PROMPT.md) for the full plan. Built one milestone at a time.

**Status:** Milestones 1 (import any floorplan, set its scale), 2 (walls, doors, windows), 3 (3D model) and
4 (IKEA furniture models: tools and method) are done.

## Run it

Needs [Node.js](https://nodejs.org) (LTS) and Python 3 with Pillow for the helper tools.

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

## Using it

1. **Open** a floorplan with the Open button, or drag a file onto the window.
2. **Straighten photo** (S): for a photo taken at an angle, click the 4 corners of the plan.
   It's straightened with its real proportions.
3. **Calibrate** (C): click both ends of a line whose real length you know (a dimension line
   is ideal; hold Shift to keep it straight), then type its length (`350`, `350 cm`, `3.5 m`, `3500 mm`).
4. **Walls from the file:** walls, doors and windows are found automatically when a plan is opened
   (see *How walls are found* below). They show dashed: check them, click one to accept or delete
   it, or click **Accept all**. For pictures (and PDFs not drawn at 1:100) the scale is estimated
   from the wall thickness, so calibrate for exact sizes. You can still set layers to *Walls* by hand
   and click **Find walls in wall layers**.
5. **Wall** (W): click along the middle of a wall, point by point. It snaps to wall ends, onto walls and to
   45°/90° (hold Alt to not snap). Click the first point to close a room; double-click or Esc to stop.
   The thickness for new walls is set top left.
6. **Door** (D) / **Window** (N): click on a wall. Sizes for new ones are set top left.
7. **Select** (V): click a wall, door or window to edit its sizes in the side panel. Drag a wall to move it,
   its square ends to reshape it (joined walls follow), and doors/windows to slide them. Double-click a wall to
   split it. Delete removes the selection.
8. **Furniture:** furniture drawn on the plan is found when it's opened and shown in purple (see
   *How furniture is found* below). Click a piece to check it, change its model or sizes, or delete
   it; Enter or **Accept all furniture** accepts. Accepted furniture shows in 3D.
   **Add furniture** in the side panel lists every model, with a search box and a category filter
   (name, variant and W×D×H). Drag one onto the plan or into the 3D view, or click it to add it in
   the middle. **Something else** adds a plain box with typed sizes, for anything not modelled yet;
   swap it for a real model later with the Model list. Click a piece to edit its options (sizes,
   BILLY's shelf heights…), which update the model straight away.
9. **Positioning furniture** (in the plan and in 3D):
   - Drag a piece to move it. It snaps against walls and other pieces, back to the wall and square
     to it (hold Alt not to snap). In 3D, click a piece and drag it along the floor the same way.
   - Turn it with the round handle in front of it (15° steps, Alt for any angle), or R / Shift+R
     for 90°. The thick edge is its front.
   - Red: it overlaps another piece or goes through a wall (chairs pushed in under a table or desk
     are fine). The side panel says what it hits.
   - The faint green areas are the space a piece needs (in front of a wardrobe, at a bed's sides):
     orange when something's in the way. One free side of a bed is enough.
   - While a piece is selected, its distance to the nearest wall is shown on each side.
   - Drop a piece on something with a top or shelves (a sideboard, BILLY) and it stands on top;
     choose another shelf with **Stands on** in the side panel. It moves and turns with what it
     stands on, and comes down to the floor when that's deleted.
   - Ctrl+D duplicates the selected piece, L locks it in place (and unlocks it), Delete removes it.
     These keys work in the plan and in 3D. Everything can be undone.
10. **Undo/Redo:** Ctrl+Z and Ctrl+Y (or Ctrl+Shift+Z).

11. **3D:** switch between **Plan** and **3D** at the top left. In 3D:
   - **Orbit:** drag to turn around the model, right-drag to move, wheel to zoom. Walls between you and the
     middle of the view fade out so you can see inside.
   - **Top:** straight down, without perspective.
   - **Walk:** click *Start walking*, then W A S D (or arrows) to move, Shift to run, mouse to look, Esc to
     stop. You walk through doorways but not through walls.
   - **Room height** (for walls without their own height), **Ceiling** and **Plan on floor** (the floorplan
     picture as the floor) are in the bar at the top.

12. **Floors:** choose the floor you're working on in the toolbar, or add one there. Each floor has
    its own floorplan file, walls and furniture: open a file while a floor is chosen to fill it.
    In the side panel's **Floors** section you can rename floors, delete them, or **Copy this
    floor** (walls, doors and windows, without the furniture) as a start for the next one.
13. **Shopping list** (toolbar): every IKEA article placed, on all floors, with its article number,
    how many, and on which floors. A model made of several articles (a PAX frame with doors) lists
    each one. Article numbers link to IKEA Ireland; **Download CSV** saves it for a spreadsheet.
14. **Export PNG** (toolbar) saves the plan or the 3D view as you see it.

Drag empty space (or hold Space, or use the right mouse button) to pan. The mouse wheel zooms. **Fit** (F) shows everything.

Your work is saved automatically in the browser. **Save project** downloads a
`.floorplan.json` file with all floors, which you can open again with Open (projects saved before
floors existed open as one floor).

## Supported formats

| Format | Notes |
|---|---|
| PNG, JPG, WebP, GIF, BMP, TIFF, HEIC | Shown as the background. Calibrate the scale. Multi-page TIFFs get a page picker |
| Photo of a paper plan | Use Straighten photo, then Calibrate |
| PDF | Page picker. Vector lines are extracted, with one layer per colour and pen width. The scale is first assumed to be 1:100 |
| SVG | Lines are extracted per group (`<g id="walls">` etc.) |
| DXF | Layers listed with a type each. Units read from the file |
| DWG | Convert to DXF first (see below) |
| IFC | Walls, doors and windows with real thicknesses and heights. Level picker |
| Sweet Home 3D (.sh3d) | Walls, doors, windows and rooms. Level picker. Needs version 5.3 or newer |

Walls, doors and windows found in a file are shown dashed. Accepting and editing them comes in milestone 2.

### DWG files

Browsers can't read DWG, so convert it to DXF first:

1. Install the free [ODA File Converter](https://www.opendesign.com/guestfiles/oda_file_converter)
   (or LibreDWG's `dwg2dxf`).
2. Run:

   ```bash
   python tools/convert.py "My flat.dwg"
   ```

3. Open the `My flat.dxf` file it creates.

## IKEA furniture models

Each piece of furniture is a JSON file in `furniture/`, built from simple shapes with the real
product measurements. The method and format are in [PROMPT.md](PROMPT.md) (4A–4F). The tools:

```bash
python tools/ikea.py search "billy bookcase"
```

```bash
python tools/ikea.py show 00263850
```

```bash
python tools/ikea.py photos 00263850
```

```bash
python tools/check_model.py
```

- `search` lists products on IKEA Ireland (item number, size, price, link).
- `show` prints the product's own measurements (not the package's) and caches them in `cache/`.
- `photos` downloads the product's photos (not the recommended products') and makes one
  contact sheet, `cache/<item>/sheet.jpg`, which usually includes IKEA's dimension drawing.
- `check_model.py` checks every model: all parts inside the size box (for every option), surfaces
  for anything with tops or shelves, known colours, article numbers.

Preview a model at http://localhost:5173/?preview=ikea-billy-80x28x202. It has a 3/4 view like
IKEA's photos, front/side/top views to compare with IKEA's drawings, the model's options, and its
surfaces shown in green.

Format details beyond PROMPT.md 4C:
- Parts: `box` [x, y, z, w, d, h] (optional `radius` for rounded edges); `cyl` [x, y, z, r, length]
  with `axis` z (centre x, y; bottom z), x or y (starting at x or y); `sphere` [cx, cy, cz, r];
  `prism` [x, y, z, w, d, h] with `slope` front/back/left/right (the low side).
- `mat`: wood, metal, fabric, plastic, stone or glass. `color`: "#rrggbb" or "$name" from `colors`.
- Parameters: `list` (used with `each`), `choice` (options) and `number`; each can have a `label`.
- In `each`: `$v` is the value, `$i` the index from 0, `$n` from 1 (labels can use them too).
- Expressions: numbers, 'strings', `$vars` (`$W`, `$D`, `$H` and parameters), `+ - * /`, `( )`,
  `== != < > <= >=`, `&& || !`. The same rules are in `src/furniture/expr.ts` and `tools/furniture.py`.

## Everyday furniture models

Besides the IKEA models, `furniture/generic-*.json` has the furniture every flat has, in standard
sizes: bed, sofa, armchair, wardrobe, nightstand, dining table, chair, desk, office chair,
coffee table, TV unit, bookcase, kitchen units, kitchen sink, stove, fridge, washing machine,
toilet, washbasin, bathtub, shower and a plain box. Their widths and depths (and a bed's mattress
size) are options, so a found piece takes the size it's drawn at. See them all at
http://localhost:5173/?gallery=generic.

## How furniture is found

When a plan is opened, every drawn object becomes a shape: a group of touching lines on a layer
that isn't walls (in PDFs, DXF, SVG), a solid coloured patch (app exports), or a group of thin
lines (pictures). Details drawn inside a piece without touching it (a pillow, a sink) belong to it.

- **Named pieces:** words written on or in the shape name it: the PDF's own text, or for pictures
  the patch's name read with OCR (Tesseract, loaded only when needed). English, Croatian, German,
  Dutch and French words and IKEA product names are known; an IKEA name with its own model
  (BILLY, KALLAX…) gets that model.
- **Unnamed symbols:** by real size and what's drawn inside: a wardrobe's X, a sofa's back and
  arms, a bed's pillow end, a bathtub's inner outline, a toilet's tank, a basin's bowl, kitchen
  units divided into cabinets. A desk with its chair pushed in is split into both, and small
  shapes beside a table or desk become its chairs.
- Each piece is turned so its back is against the nearest wall (a bed's head, a toilet's tank),
  and sized to the drawing. Text, room-number circles, dimension marks and door swings are left
  out: layers where few shapes look like furniture aren't used.

## How walls are found

Two detectors run on every plan, and the better result is kept:

- **From the picture** (filled walls, scans, photos, app exports, and outlined drawings saved as
  pictures): dark ink thicker than the drawing's lines is traced into straight bands of constant
  thickness. Outlined walls (two thin lines) are filled in first. Text, grids, furniture and door
  swings are left out because they're thin, curved, light or not wall-shaped.
- **From the drawing's lines** (CAD-style PDFs, DXF, SVG): pairs of parallel outlines a wall-thickness
  apart. The layer holding the walls is worked out by trying each one.

Gaps between wall pieces, and gaps between a wall's end and another wall, are judged from the
picture: a quarter-circle swing or leaf from a jamb makes a door, a line running along inside the
wall makes a window, wall drawn in pieces is joined, and an empty gap is left open.

For pictures without a scale, the scale is read from the numbers printed around the plan: a ruler
(0, 100, 200 … along the edges) or chains of dimensions (each part's length written in its middle).
Along a row of such numbers the distances on the picture follow their values, so several numbers
agreeing give the exact scale; the unit (cm or mm) is the one that fits the plan. The numbers are
read with OCR in the margins round the building, also turned for vertical dimensions, and the
plan's tilt is allowed for. When there are no readable numbers, the scale is estimated from the
doors (nearly every inner door is 70–90 cm wide), or from the wall thickness when there are too
few doors. The side panel says which was used.

In outlined pictures, short "walls" of an odd thickness or hanging off a wall by one end are
dropped: they're usually furniture outlines. A dimension line drawn closer to a wall than about
1.3 times the wall's thickness can hide that wall there (it looks like a window's glazing).

### Testing wall and furniture detection

```bash
npm run bench
```

That draws 40 random furnished flats in 8 styles (filled, merged, outlined and hatched PDFs, app
exports with grids and named furniture, clean pictures, outlined pictures, tilted noisy scans) into
`bench/`, with the exact walls, openings and furniture of each. Then open http://localhost:5173/?bench (with `npm run dev`
running): it scores the detection against them and also runs the real plans in `samples/`. An
overlay of each result is saved to `bench/out/`: true walls in green, found walls in blue,
doors orange, windows cyan, true furniture as green rings, found furniture as purple dots with an
arrow to its back. Filter with `?bench=pdf-app`, or force one detector with `&use=picture`
or `&use=lines`.

## Test files

`samples/` has the same small apartment (9 × 7 m, 920 cm outside) in every format.
Regenerate them with `npm run samples`. There is no HEIC sample, because Pillow can't write HEIC.

Real plans: `apartment-rijeka.pdf` (an architect's CAD plan, 1:100 but shrunk about 3.5 %:
calibrate on the 1106 cm line), `20x45-Model.pdf` (filled walls, in feet) and `matija-doma.pdf`
(an app export with a 50 cm grid, coloured rooms and furniture).

## Folders

```
src/model/     plan data types, geometry helpers
src/import/    one importer per format; all return the same ImportResult (in cm)
src/editor/    2D canvas, calibrate dialog
src/store/     app state and autosave
src/ui/        toolbar and side panel
src/project/   save/load project files
src/detect/    wall detection: from pictures (raster.ts), choosing the best result (planFromImport.ts);
               furniture: recognition (furniture.ts), shapes in pictures (furniturePicture.ts), OCR (labels.ts)
src/bench/     the ?bench test page and its scoring
src/three/     3D view of the plan
src/furniture/ furniture model format, 3D rendering, placing in the plan, model preview and gallery pages
furniture/     furniture models (JSON)
tools/         convert.py (DWG → DXF), make_samples.py, make_bench.py, ikea.py, furniture.py, check_model.py
bench/         generated test plans and bench results (not in git)
cache/         downloaded IKEA pages and photos (not in git)
samples/       test floorplans
```
