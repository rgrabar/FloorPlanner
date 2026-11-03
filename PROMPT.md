# Project: Floorplan → 3D room planner with accurate IKEA furniture

## Goal
Build an app where I can load a floorplan of my home in any common format and get
a 3D model of it. Then I can place accurately modelled IKEA furniture in that 3D
space, move it around and rotate it, to see how my rooms will look and whether
everything fits.

## Tech stack
- **The app:** a web app that runs locally in the browser. Use Vite + TypeScript +
  React, and Three.js through @react-three/fiber and @react-three/drei.
- **Helper tools:** small local Python scripts in `tools/` (standard library plus
  Pillow, and more only if a format really needs it). They handle the IKEA data
  and file conversions that a browser can't do.
- **Furniture models:** JSON files in `furniture/` (format below). The app loads them.
- No real backend. Save projects as JSON (download/upload) and autosave them to
  localStorage.
- Use centimetres everywhere internally.

---

## Milestone 1: Import a floorplan in any format
Every import ends up in the same internal model: walls, doors, windows, an
optional background image, and a scale.

| Format | How to handle it |
|---|---|
| PNG, JPG/JPEG, WebP, GIF, BMP, TIFF | Load as a background image |
| HEIC/HEIF (iPhone photos) | Convert in the browser (e.g. heic2any), then treat as an image |
| Photo of a paper plan taken at an angle | Perspective correction: I click the 4 corners of the plan and the image is straightened |
| PDF | Render with pdf.js at high resolution and let me choose the page. If the PDF has vector lines, also extract them as wall suggestions |
| SVG | Show it as the background and extract lines/paths as wall suggestions |
| DXF | Parse it (e.g. dxf-parser). List the layers so I can choose which are walls, doors and windows. Read the units from the header ($INSUNITS) so the scale is known automatically |
| DWG | There is no reliable browser parser. Convert to DXF with a local converter (ODA File Converter or LibreDWG `dwg2dxf`) through `tools/convert.py`, then import as DXF. Tell me exactly what to install |
| IFC (BIM) | Use web-ifc. Take walls, doors, windows, wall heights and thicknesses directly from the file |
| Sweet Home 3D (.sh3d) | It's a zip with `Home.xml` inside. Read walls, doors, windows and rooms from it |

- **Scale calibration** for images, PDFs and photos: I click two points and type
  the real distance (for example "350 cm"). For formats with units (DXF, DWG, IFC,
  .sh3d) the scale is set automatically, but I can still re-calibrate.
- An unsupported or broken file shows a clear message listing the supported formats.
- Show the plan in a 2D top-down editor with pan and zoom.

## Milestone 2: Walls, doors, windows (I trace them myself)
Tracing walls by hand is the main way to do this, and it must always work well.
- Draw walls over the plan by clicking points. Walls snap to 90°/45° and to
  existing wall ends. Each wall has a thickness (default 10 cm, editable).
- Select, move, split and delete walls. Undo/redo.
- Place doors and windows on a wall, with width and height, plus sill height for windows.
- For vector imports (PDF, SVG, DXF, DWG, IFC, .sh3d), pre-fill walls from the file
  as suggestions that I can accept, edit or delete.
- Optional, only after manual tracing works: an "Auto-detect walls" button for
  images (e.g. OpenCV.js line detection) that also only makes suggestions.

## Milestone 3: Generate the 3D model
- Extrude the walls to a room height (default 250 cm, editable), with real
  openings cut out for doors and windows.
- Add a floor (optionally with the plan as a texture) and an optional ceiling.
- Camera modes: orbit view, top-down view, and first-person "walk" mode
  (WASD + mouse) at an eye height of 165 cm.
- Simple, clean lighting. In orbit view, walls between the camera and a room fade
  out so I can see inside.

---

## Milestone 4: IKEA furniture models (tools and method)
Every IKEA item I own or am considering gets an exact 3D model built from simple
shapes. The method matters more than the tools, but a few small tools make it
reliable. Build them first.

### 4A. The method (follow it for every product)
1. **Never use dimensions from memory.** IKEA has many size variants (MALM
   140/160/180, PAX 201/236 high, BESTÅ 60/120/180 wide). Always fetch the live
   product page.
2. **Take only the product measurements.** Product pages also list package
   dimensions; ignore those.
3. **Look at the photos before modelling.** Each product's image set usually
   includes IKEA's dimension drawing. Use it and the photos for proportions: leg
   height and inset, plinth, top overhang, door and drawer split, frame thickness,
   shelf positions, handle placement.
4. **Ask me what the website can't tell you:** which size variant, which colour,
   any hacks or custom tops, shelf heights, doors or drawers, which inserts. Every
   real-world model needs at least one of these answers.
5. **Model in the item's own coordinate box:** W×D×H in cm, x left→right seen from
   the front, y back (0)→front (D), z up. Every part must stay inside the box. One
   part sticking out silently breaks collision and placement logic later.
6. **Use primitives only:** box (optionally with rounded edges), cylinder, sphere,
   prism. Include the details that define the look: real leg and frame
   thicknesses, door gaps, handles, shelf edges, top overhang. Skip anything
   under about 1 cm.
7. **Combinations are several articles.** PAX with HASVIK doors, or a BESTÅ frame
   with a top and doors: look up each article and combine them into one model.
8. **Make configurable things parametric:** shelf heights as a list, shelf
   material as a choice. My BROR has *my* shelf arrangement, not the catalogue one.
9. **Define surfaces where things can stand:** shelves, a sideboard top plus a
   hutch, an L-shaped desk. Mark sofas and sinks as having none. Without this,
   "put the record player on the cabinet" ends up floating on top of the
   bounding box.
10. **Verify by looking.** Render the model, compare it with the IKEA photos, fix
    it and repeat. Never hand over a model you haven't seen rendered.

### 4B. The IKEA tool: `tools/ikea.py`
Python standard library plus Pillow. Cache everything under `cache/`. Send a normal
browser User-Agent. Only fetch the products I ask about, and use the cache instead
of fetching the same page twice. My country/language is: **`ie/en`** (Ireland, English, prices in EUR).

**`python tools/ikea.py search QUERY`**
- GET `https://sik.search.blue.cdtapps.com/<cc>/<lang>/search-result-page?q=QUERY&types=PRODUCT`.
  It returns JSON.
- Print the item number, name, type, price, product page URL and main image URL
  for each hit.
- Inspect the response once to find the right field names. They're nested under a
  product-search results list and may differ from what you expect.

**`python tools/ikea.py show ITEMNO|URL`**
- Fetch the product page HTML.
- Extract the measurements with the regex `\[\{"measure":"[^\]]*\]`, then
  `json.loads` each match.
- Keep only entries whose `"measure"` value is a string. The package-dimension
  blocks have a different shape, and this filter drops them.
- Print every measurement: width, depth, height, plus shelf, leg, bed-base and
  drawer heights where given. Then print the derived W×D×H.
- Also collect the image URLs from the page. They look like
  `https://www.ikea.com/<cc>/<lang>/images/products/<slug>__<id>_pe..._s5.jpg`.
- Cache the parsed result as `cache/<itemNo>.json`.

**`python tools/ikea.py photos ITEMNO [n=8]`**
- Download up to n of those images to `cache/<itemNo>/NN.jpg`, resized to at most 900 px.
- Only keep images whose filename contains the product-name slug (e.g. `bror-`).
  Pages also embed images of *recommended* products, and you'd model the wrong
  thing otherwise.
- Make a contact sheet, `cache/<itemNo>/sheet.jpg`, a grid of all the photos made
  with Pillow, and print its path so you can look at one image instead of eight.

Tell me which commands to pre-approve so you don't stall on permission prompts
(e.g. `Bash(python tools/ikea.py:*)`). Use the tool instead of ad-hoc `curl` calls.

### 4C. The furniture model format (JSON)
```json
{
  "size": [85, 40, 190],
  "category": "storage",
  "colors": {"main": "#3a3a3a", "shelf": "#b98b5a"},
  "clearance": {"front": 70},
  "ikea": {"name": "BROR", "type": "Shelving unit", "items": ["ITEMNO"]},
  "params": {
    "shelves": {"type": "list", "default": [23, 64, 106, 147, 190]},
    "shelfMat": {"type": "choice", "options": ["wood", "metal"], "default": "wood"}
  },
  "parts": [
    {"box": [0, 0, 0, 4, 4, 190], "color": "$main", "mat": "metal"},
    {"box": [81, 0, 0, 4, 4, 190], "color": "$main", "mat": "metal"},
    {"box": [0, 36, 0, 4, 4, 190], "color": "$main", "mat": "metal"},
    {"box": [81, 36, 0, 4, 4, 190], "color": "$main", "mat": "metal"},
    {"each": "shelves", "when": "$shelfMat == 'wood'",
     "box": [0, 0, "$v-2", 85, 40, 2], "color": "$shelf", "mat": "wood"}
  ],
  "surfaces": [{"each": "shelves", "z": "$v", "label": "shelf $i"}]
}
```
- `box` is `[x, y, z, w, d, h]` in model coordinates. A `cyl` takes a centre, a
  radius and a height.
- Numeric fields may be expression strings (`"$v-2"`, `"$W/2"`).
- `each` repeats a part once per list value, with `$v` the value and `$i` the index.
- `when` includes the part only if its condition holds.
- **Evaluate expressions with a tiny whitelist parser** that allows numbers,
  `$vars`, `+ - * /`, comparisons and string literals. Never use `eval`. The app
  needs the same parser in TypeScript, so keep the rules identical in both.
- File name: `furniture/ikea-<name>-<variant>.json`.

### 4D. Checking a model by looking at it
- Make a model preview page (a route in the app, or a standalone `view.html` that
  loads three.js and OrbitControls from cdnjs). It loads one model JSON, expands
  the params and adds one mesh per part.
- Map model x→three.x, model z (up)→three.y and model y→three.z, and centre the
  model at the origin. Use flat material colours and a ground plane.
- Take a screenshot so you can see it: use a browser tool if you have one,
  otherwise headless Chrome or Playwright, e.g.
  `chrome --headless --use-angle=swiftshader --screenshot=out.png --window-size=1200,900 "http://localhost:8000/view.html?model=ikea-bror-85"`.
  Read the PNG and compare it with the IKEA contact sheet.

### 4E. Workflow per product
1. Run `search`, then `show ITEMNO` for the measurements and `photos ITEMNO` for
   the contact sheet, and look at the sheet.
2. Ask me about size variant, colour, configuration and hacks.
3. Write the model JSON with the exact size and the parts you saw in the photos.
4. Run a self-check script (`tools/check_model.py`) that confirms all parts lie
   within the size box and that surfaces exist for anything with shelves or tops.
5. Take a screenshot, compare it with the photos, fix and repeat.

### 4F. Lessons learned
- Package dimensions are the most common mistake. Filter them out.
- Photos of recommended products get mixed in. Filter by name slug.
- A part sticking out of the model box, e.g. a hutch deeper than the base, causes
  silent bugs. Check every time.
- A sideboard with a hutch, or any top that isn't flat, needs explicit surfaces,
  otherwise items float at the top of the bounding box.
- Never guess between variants; ask me.
- Discontinued products may have no page left. Use a measured box plus my tape
  measure.

---

## Milestone 5: Furniture in the app
- A sidebar catalogue listing every model in `furniture/`, with search and a
  category filter, showing name, size variant and W×D×H.
- Drag an item from the sidebar into the 3D scene (or the 2D plan).
- Each placed item keeps its own parameter values (e.g. my shelf heights, wood or
  metal), editable in a side panel, and the model updates live.
- Quick placeholder: I can add a plain box with typed dimensions for things that
  aren't modelled yet (or aren't from IKEA), and replace it with a real model later.

## Milestone 6: Positioning furniture
- Drag furniture along the floor. Rotate by 90° with a key (R) and freely with a
  handle (snapping to 15°).
- Snap furniture to walls (back against the wall) and to other furniture.
- Highlight in red when items overlap each other or go through a wall.
- Show each item's `clearance` zone (e.g. 70 cm in front of a wardrobe for the
  doors) as a faint area on the floor, and warn when it's blocked.
- While an item is selected, show its distances to the nearest walls in cm.
- Items can be placed on the `surfaces` of other items (e.g. a lamp on a specific
  shelf), and they snap to the right height.
- Duplicate, delete, lock in place. Undo/redo for everything.

## Milestone 7: Nice-to-haves
- A shopping list of all placed IKEA items with article numbers (from the `ikea`
  field), exportable as CSV.
- Export the current view as a PNG.
- Multiple floors.

---

## How I want you to work
- Before writing code, give me a short plan and the folder structure.
- Build one milestone at a time. At the end of each, tell me how to run it and
  what to test, then wait for my feedback.
- Keep the code simple and readable. I'd rather have something working early than
  everything at once.
- If something I asked for is hard or unreliable (like DWG import or automatic
  wall detection), say so and suggest the simplest version that works.
