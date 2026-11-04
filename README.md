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
8. **Undo/Redo:** Ctrl+Z and Ctrl+Y (or Ctrl+Shift+Z).

9. **3D:** switch between **Plan** and **3D** at the top left. In 3D:
   - **Orbit:** drag to turn around the model, right-drag to move, wheel to zoom. Walls between you and the
     middle of the view fade out so you can see inside.
   - **Top:** straight down, without perspective.
   - **Walk:** click *Start walking*, then W A S D (or arrows) to move, Shift to run, mouse to look, Esc to
     stop. You walk through doorways but not through walls.
   - **Room height** (for walls without their own height), **Ceiling** and **Plan on floor** (the floorplan
     picture as the floor) are in the bar at the top.

Drag empty space (or hold Space, or use the right mouse button) to pan. The mouse wheel zooms. **Fit** (F) shows everything.

Your work is saved automatically in the browser. **Save project** downloads a
`.floorplan.json` file, which you can open again with Open.

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

### Testing wall detection

```bash
npm run bench
```

That draws 40 random flats in 8 styles (filled, merged, outlined and hatched PDFs, app exports with
grids and furniture, clean pictures, outlined pictures, tilted noisy scans) into `bench/`, with the
exact walls and openings of each. Then open http://localhost:5173/?bench (with `npm run dev`
running): it scores the detection against them and also runs the real plans in `samples/`. An
overlay of each result is saved to `bench/out/`: true walls in green, found walls in blue,
doors orange, windows cyan. Filter with `?bench=pdf-app`, or force one detector with `&use=picture`
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
src/detect/    wall detection: from pictures (raster.ts), choosing the best result (planFromImport.ts)
src/bench/     the ?bench test page and its scoring
src/three/     3D view of the plan
src/furniture/ furniture model format, 3D rendering, model preview page
furniture/     furniture models (JSON)
tools/         convert.py (DWG → DXF), make_samples.py, make_bench.py, ikea.py, furniture.py, check_model.py
bench/         generated test plans and bench results (not in git)
cache/         downloaded IKEA pages and photos (not in git)
samples/       test floorplans
```
