# FloorPlanner

Load a floorplan, turn it into a 3D model and place accurately modelled IKEA furniture in it.
See [PROMPT.md](PROMPT.md) for the full plan. Built one milestone at a time.

**Status:** Milestones 1 (import any floorplan, set its scale) and 2 (walls, doors, windows) are done.

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
4. **Walls from the file:** for vector files, set the layer that holds the walls to *Walls* (point at a layer to
   see its lines) and click **Find walls in wall layers**. Walls are found from their two outlines, and gaps
   become doors or windows. They show dashed: click one to accept or delete it, or click **Accept all**.
   IFC and Sweet Home 3D files come with their walls already.
5. **Wall** (W): click along the middle of a wall, point by point. It snaps to wall ends, onto walls and to
   45°/90° (hold Alt to not snap). Click the first point to close a room; double-click or Esc to stop.
   The thickness for new walls is set top left.
6. **Door** (D) / **Window** (N): click on a wall. Sizes for new ones are set top left.
7. **Select** (V): click a wall, door or window to edit its sizes in the side panel. Drag a wall to move it,
   its square ends to reshape it (joined walls follow), and doors/windows to slide them. Double-click a wall to
   split it. Delete removes the selection.
8. **Undo/Redo:** Ctrl+Z and Ctrl+Y (or Ctrl+Shift+Z).

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

## Test files

`samples/` has the same small apartment (9 × 7 m, 920 cm outside) in every format.
Regenerate them with `npm run samples`. There is no HEIC sample, because Pillow can't write HEIC.

`samples/apartment-rijeka.pdf` is a real architect's plan (1:100, but the PDF is shrunk about 3.5 %).
On it, set "Black lines 0.25 mm" to Walls and "Blue lines 0.10 mm" to Windows, then Find walls.
Calibrate on the 1106 cm dimension line.

## Folders

```
src/model/     plan data types, geometry helpers
src/import/    one importer per format; all return the same ImportResult (in cm)
src/editor/    2D canvas, calibrate dialog
src/store/     app state and autosave
src/ui/        toolbar and side panel
src/project/   save/load project files
tools/         convert.py (DWG → DXF), make_samples.py
samples/       test floorplans
```
