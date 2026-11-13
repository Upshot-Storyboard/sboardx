# sboardx 1.2

A `.sboardx` file is a storyboard: a zip holding JSON files for the
structure (panels, scenes, timing, camera, audio) and one SVG per layer for
the art. [Upshot](https://www.upshotstoryboard.com/) writes and reads it,
and so do the Storyboard Pro scripts and the browser reader in this repo.
This document explains how to read one.

## Versions

The version is the `sboardx` string in `project.json`: `1.0`, `1.1` or
`1.2`. Current writers write `1.2`. Each version only adds to the previous
one, so a 1.2 reader reads all three. A reader refuses a version it doesn't
know (Upshot says the file was made by a newer app).

- **1.1** added sequences, layer animation and layer groups, pencil
  strokes, gradient fills, textures as SVG pattern fills, palettes, shared
  drawings, the default layer stack and merge bases.
- **1.2** moved textures out of the SVG into one texture file per layer,
  made shared drawings live links, and made the merge digest SHA-256.

Readers ignore JSON keys, SVG attributes and SVG elements they don't know,
so you can skip anything you don't need. App-private data lives under
`x-<vendor>` keys in JSON (Upshot's is `x-upshot`) and is safe to ignore.
A new optional key keeps the version; a change in meaning gets a new
version (see CONTRIBUTING.md).

## The zip

A plain zip with every entry stored uncompressed (method 0). Upshot only
opens stored zips, so write them that way (`zip -0 -r`, or Python's
`zipfile` with `ZIP_STORED`). Entry names are UTF-8 with forward slashes.
Directory entries may be present; ignore them.

```
project.json                                 version, name, frame, resolution, fps
sequence.json                                panel order, scenes, camera, layer animation
panels/<panelID>/panel.json                  code, shot, duration, notes, dialogue
panels/<panelID>/layers.json                 the layer stack
panels/<panelID>/camera.json                 always {"keyframes": []}; ignore it
panels/<panelID>/art/<layerID>.svg           one SVG per layer
panels/<panelID>/art/<layerID>.texture.json  a textured layer's texture (optional, 1.2)
images/<file>                                image layer files and texture pages (optional)
audio/clips.json, audio/<file>               audio clips and their files (optional)
palettes.json                                colour palettes (optional, 1.1)
shared/index.json, shared/<id>/...           shared drawings (optional, 1.1)
```

Ids (panels, layers, scenes, keyframes, clips) are opaque strings of
`[A-Za-z0-9_-]`, unique within the file.

## Coordinates

Everything is in **world units** on an unbounded plane. The origin is the
centre of the frame and y points down.

- The **frame** is what the camera shows at zoom 1 and what a render crops
  to. It is 540 units high, and `540 · resolution.width / resolution.height`
  wide (both stored in `project.json` as `canvas.width`/`canvas.height`).
- The **resolution** (`canvas.resolution`) is the pixel size of a render.
  It doesn't scale the art: a 1920 × 1080 board and a 3840 × 2160 board
  both have a 960 × 540 frame.
- Art can extend past the frame. Clip to the frame, or to the camera's
  view.
- A **camera pose** `{z, cx, cy, rot}` maps a world point `p` into the
  frame as `p' = S(z) · R(−rot) · (p − c)`, with `c = (cx, cy)` the point
  the camera looks at, `z` the zoom (1 = full frame, 2 = twice as close)
  and `rot` the camera rotation in degrees, clockwise on screen (so the
  content appears rotated by `−rot`).
- A **layer pose** `{tx, ty, s, rot, opacity}` (from a layer animation
  track) moves a layer's art before the camera applies. With the track's
  pivot `c`: `p' = c + (tx, ty) + S(s) · R(rot) · (p − c)`, `s` a uniform
  scale (1 = unchanged) and `rot` in degrees, clockwise on screen.
  `opacity` (0 to 1) multiplies the layer's own opacity.

## project.json

```json
{
  "sboardx": "1.2",
  "app": "Upshot",
  "name": "My Board",
  "episode": "EP01",
  "created_at": "2026-07-05T12:00:00Z",
  "modified_at": "2026-07-05T12:00:00Z",
  "canvas": {
    "width": 960.0,
    "height": 540.0,
    "resolution": { "width": 1920, "height": 1080 },
    "fps": 24
  },
  "x-upshot": { "...": "Upshot's editor state" }
}
```

| Key | Type | Meaning |
|---|---|---|
| `sboardx` | string | Format version. |
| `app` | string | The app that wrote the file. |
| `name`, `episode` | string | Board name and episode (may be empty). |
| `created_at`, `modified_at` | string | ISO 8601, UTC. |
| `canvas.width`, `canvas.height` | number | Frame size in world units. |
| `canvas.resolution.width`, `.height` | int | Render size in pixels. |
| `canvas.fps` | int | Frame rate. Durations are in seconds; this is the frame grid they were made on. Default 24. |
| `layer_layout` | array | Optional (1.1). The layer stack a new panel starts with, top to bottom: `{"name", "kind", "visible", "locked", "opacity", "group"}`. `kind` is `"vector"` (default) or `"group"` (a folder record, which Upshot skips: folders come from `group`). Defaults: visible, unlocked, opacity 100, group `""`. Absent means one default layer. |
| `sync` | object | Optional (1.1). Merge bases, see "Merging". |
| `x-upshot` | object | Upshot's editor state (theme, zoom, last open panel and layer, and so on). Ignore it. |

Upshot reads a file without `x-upshot` as one from another app: it works
out panel numbering from `code` and imports every layer as it is. Files
from Upshot's pre-release builds carry `x-the-storyboard-app` instead;
they are not sboardx and readers refuse them.

## sequence.json

```json
{
  "panels": ["p-1", "p-2"],
  "scenes": [
    {
      "id": "sc-1",
      "name": "10",
      "panels": ["p-1", "p-2"],
      "camera": {
        "keyframes": [
          { "id": "k-1", "t": 0.0, "z": 1.0, "cx": 0.0,  "cy": 0.0,   "rot": 0.0 },
          { "id": "k-2", "t": 2.0, "z": 1.5, "cx": 48.0, "cy": -27.0, "rot": 15.0 }
        ]
      },
      "layer_tracks": [
        {
          "name": "Shading",
          "kind": "layer",
          "pivot": { "x": 10.0, "y": -5.0 },
          "keyframes": [
            { "id": "lk-1", "t": 0.0, "tx": 0.0,  "ty": 0.0,   "s": 1.0,  "rot": 0.0,   "opacity": 1.0 },
            { "id": "lk-2", "t": 1.5, "tx": 24.0, "ty": -12.0, "s": 1.25, "rot": -10.0, "opacity": 0.5 }
          ]
        }
      ]
    }
  ],
  "sequences": [
    { "id": "seq-1", "name": "Act 1", "scenes": ["sc-1"] }
  ],
  "transitions": []
}
```

- `panels`: every panel in timeline order. A panel starts at the sum of
  the durations (`dur` in `panel.json`) of the panels before it.
- `scenes`: consecutive runs of `panels`, in order, covering every panel
  once. Each has an `id`, a display `name` and its `panels`.
- `camera.keyframes`: the scene's camera move, sorted by `t`, in seconds
  from the start of the scene. Pose fields as in "Coordinates". Before the
  first keyframe the camera holds the first pose, after the last it holds
  the last, and with no keyframes it shows the full frame. Upshot eases
  between keyframes with smoothstep and interpolates `z` geometrically;
  linear is a fine approximation.
- `layer_tracks` (optional, 1.1): layer animation for the scene. A track
  with `kind: "layer"` animates every layer in the scene's panels whose
  `name` equals the track's `name`; `kind: "group"` animates every layer
  whose `group` equals it. Skip other kinds. `pivot` is a world point
  (default the origin). Keyframes are sorted by `t`, scene-local seconds,
  with the layer pose fields from "Coordinates". Upshot eases with
  smoothstep, interpolates `s` geometrically, `tx`/`ty`/`opacity` linearly
  and `rot` along the shortest arc, and holds at both ends. A layer
  matched by its own track and its group's is posed by its own track
  first, then by the group's; opacities multiply.
- `sequences` (optional, 1.1): groups of consecutive scenes (Toon Boom's
  sequences), each with an `id`, a `name` and its `scenes`. Not every
  scene needs to be in one.
- `transitions`: always `[]`.

## panels/\<panelID\>/panel.json

```json
{
  "id": "p-1",
  "code": "10-1",
  "shot": "WS",
  "dur": 2.5,
  "note": "a note",
  "dialogue": "she said hi"
}
```

| Key | Type | Meaning |
|---|---|---|
| `id` | string | Same as the directory name. |
| `code` | string | The panel's display name. Show it as written. Upshot writes `<scene name>-<number or custom name>` (`10-1`, `CHASE-Crash`). |
| `shot` | string | Shot type, free text (`WS`, `CU`, ...). May be empty. |
| `dur` | number | Duration in seconds, above 0. |
| `note` | string | Notes. May be empty. |
| `dialogue` | string | Optional, default empty. Toon Boom's *Dialogue* caption. |
| `x-upshot` | object | Upshot's own data for exact re-import. Ignore it. |

## panels/\<panelID\>/layers.json

```json
{
  "layers": [
    { "id": "p-1-L2", "name": "Shading", "color_tag": "#9a958c",
      "opacity": 80, "blend": "multiply", "locked": true, "visible": false,
      "blur": 6.5, "art": "art/p-1-L2.svg" },
    { "id": "p-1-L3", "name": "Photo", "color_tag": "#2f6fb0",
      "opacity": 100, "blend": "normal", "locked": false, "visible": true,
      "art": "art/p-1-L3.svg",
      "image": { "file": "images/photo.png", "w": 1280, "h": 720,
                 "transform": [0.5, 0.0, 0.0, 0.5, 12.0, -20.0] } }
  ]
}
```

`layers` is ordered **bottom to top**: paint them in array order.

| Key | Type | Meaning |
|---|---|---|
| `id`, `name` | string | |
| `color_tag` | string | `#rrggbb`, a UI label colour. Not drawn. |
| `opacity` | int | 0 to 100. |
| `blend` | string | `normal`, `multiply`, `screen`, `overlay` or `add` (CSS `plus-lighter`). Read anything else as `normal`. |
| `locked`, `visible` | bool | Don't draw hidden layers. |
| `blur` | number | Optional, default 0. Gaussian blur sigma in world units, applied to the whole layer before opacity and blend. |
| `group` | string | Optional (1.1), default `""`. The layer's folder name. A folder is a run of layers sharing the name. |
| `art` | string | The layer's art SVG, relative to the panel directory. Always present. |
| `image` | object | Optional. Makes this an **image layer**: draw the image instead of art (its SVG has no paths). |
| `image.file` | string | Archive entry, `images/<name>`. PNG or JPEG. |
| `image.w`, `image.h` | int | The image's pixel size. |
| `image.transform` | [a, b, c, d, tx, ty] | Places the image in the world. Image space is the `w × h` pixel rectangle **centred on its own origin**, y down; `x' = a·x + c·y + tx`, `y' = b·x + d·y + ty`. |
| `shared` | string | Optional (1.1). The id of the shared drawing this layer shows (see "Shared drawings"). The layer's own art is a copy of it, so you can ignore the key. |
| `texture` | string | Optional (1.2). The layer's texture file, relative to the panel directory, always `art/<layerID>.texture.json`. Present only when the layer has textured strokes (see "Textured strokes"). |
| `x-upshot` | object | Upshot's data. Ignore it (but see "Derived pencil layers"). |

### Derived pencil layers (1.1 files only)

Some 1.1 files from Upshot store a layer holding pencil strokes as three
layers: the original layer, hidden, plus two visible copies of it,
`<id>-vector` (its non-pencil strokes) and `<id>-raster` (an image layer
with a rendering of its pencil strokes). Drawing the visible layers as
usual gives the right picture, so a reader needs nothing special. Their
`x-upshot` blocks (`split` on the original, `derived_from` and `role` on
the copies) let Upshot fold them back into one layer, and any matching
`layer_tracks` are duplicated for the copies' names. Current writers don't
write these.

## The art SVG

`panels/<panelID>/art/<layerID>.svg` holds one layer's strokes, in world
units:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:sboardx="https://sboardx.format/ns/1.0"
     viewBox="-480 -270 960 540" width="960" height="540"
     sboardx:layer-id="p-1-L1"
     sboardx:layer-name="Layer 1"
     sboardx:panel-id="p-1"
     sboardx:format-version="1.2">
  <rect x="-480" y="-270" width="960" height="540" fill="none"/>
  <g sboardx:blend="normal" sboardx:opacity="100"
     style="mix-blend-mode: normal; opacity: 1.00;">
    <path d="M 0 0 C 1 0 2 1 3 1 C 4 1 5 0 6 0 Z" fill="#1a334d"
          fill-opacity="0.5" fill-rule="nonzero" stroke="none"
          sboardx:z="0" sboardx:stroke-type="boundary"/>
  </g>
</svg>
```

- The `viewBox` is the frame centred on the origin (`-W/2 -H/2 W H`), and
  `width`/`height` equal `W`/`H`, so one SVG unit is one world unit.
- The `<rect fill="none">` marks the frame for editors and draws nothing.
- The `<g>` repeats the layer's blend, opacity and blur
  (`filter: blur(<sigma>px)`) as CSS, so a browser shows the layer right
  on its own. `layers.json` wins if they differ.
- Each stroke is one `<path>`: a closed outline filled with the stroke's
  colour, `fill-rule="nonzero"`, `stroke="none"`. `d` uses the absolute
  commands `M`, `L`, `Q`, `C` and `Z` (Upshot writes `M`, `C` and `Z`).
- `fill` is the colour as `#rrggbb` and `fill-opacity` its alpha (absent
  means 1). When the colour doesn't fit 8 bits exactly, `sboardx:rgba`
  holds the exact value.
- 1.2 art has no `transform` attributes.
- A textured path (1.2) has an `id` that its layer's texture file uses
  (see "Textured strokes"). Other paths may have ids too; they mean
  nothing.
- Paths are drawn in document order.

The `sboardx` namespace URI stays `https://sboardx.format/ns/1.0` in every
version. The `sboardx:` attributes are optional and an SVG renderer can
ignore all of them:

| Attribute | Meaning |
|---|---|
| `sboardx:z` on `<path>` | The stroke's position in the panel's draw order across all layers, so a round trip keeps the order. |
| `sboardx:rgba` on `<path>` or `<stop>` | `"r g b a"`, numbers from 0 to 1: the exact colour, when `fill` (8 bits) can't hold it. |
| `sboardx:stroke-type` on `<path>` | `boundary` (default: a filled outline) or `pencil` (1.1, see below). |
| `sboardx:spine`, `sboardx:pencil`, `sboardx:grain-offset` on `<path>` | Upshot's private pencil data. Ignore it. |
| `sboardx:pencil-rgba` on `<path>` | 1.2. A textured pencil's own colour (`"r g b a"`), for Upshot. Ignore it when drawing. |
| `sboardx:blend`, `sboardx:opacity`, `sboardx:blur` on `<g>` | Copies of the layer's `blend`, `opacity` and `blur`. |
| `sboardx:layer-id`, `layer-name`, `panel-id`, `format-version` on `<svg>` | Say where the SVG came from when you look at it alone. |

### Pencil strokes (1.1)

A path with `sboardx:stroke-type="pencil"` is a pencil stroke. The path is
its outline, a filled shape any renderer can draw. Its grainy look is a
texture: in 1.2 an entry in the layer's texture file, in 1.1 a pattern
fill or a derived layer. Upshot redraws its own pencils from the private
`sboardx:spine` and `sboardx:pencil` data; other readers never need them.
An untextured pencil path is filled with its own colour.

### Gradient fills (1.1)

A path can be filled with a linear or radial gradient, defined in a
`<defs>` that is the first child of the layer's `<g>` and referenced by
`fill="url(#id)"`:

```xml
  <g sboardx:blend="normal" sboardx:opacity="100"
     style="mix-blend-mode: normal; opacity: 1.00;">
    <defs>
      <linearGradient id="g12" gradientUnits="userSpaceOnUse"
                      x1="0" y1="0" x2="1" y2="0"
                      gradientTransform="matrix(180 0 0 180 -90 -40)">
        <stop offset="0" stop-color="#ff5a1f"/>
        <stop offset="1" stop-color="#1f5f8b" stop-opacity="0.5"/>
      </linearGradient>
    </defs>
    <path d="..." fill="url(#g12)" fill-rule="nonzero" stroke="none"
          sboardx:z="12" sboardx:stroke-type="boundary"/>
  </g>
```

These are standard SVG gradients, so a browser draws them as they are.
Upshot writes them in unit space (a linear gradient from (0, 0) to (1, 0),
a radial one on the unit circle) with `gradientTransform` placing them in
the world. Stops are sorted by `offset`; `stop-opacity` carries alpha and
`sboardx:rgba` the exact colour when needed. Spread is always pad. A
gradient path has no `fill-opacity`. Pencil strokes are never gradients.

### Writing SVG for Upshot

Upshot reads `<path>` elements with absolute `M`, `L`, `Q`, `C` and `Z`
commands only (it skips relative commands, arcs and `H`/`V`) and ignores
`transform`. Stroked paths become filled outlines, `fill-opacity` becomes
the stroke's opacity, and ordinary SVG linear and radial gradients work.
Text, images and clip paths in the art are ignored.

## Textured strokes (1.2)

A textured stroke (a pencil, or any stroke with a texture) is two things:

- in the art SVG, a plain flat path with an `id`, whose `fill` and
  `fill-opacity` are the texture's average colour and coverage. Any SVG
  program shows it as a clean flat shape;
- in the layer's **texture file**, an entry saying which texture pixels the
  path shows and where.

A reader that applies textures draws the texture inside the path's
outline instead of its flat fill. A reader that doesn't just draws the
flat fill.

### An example

The art SVG `panels/p-1/art/p-1-L1.svg` has two textured paths, the
second a pencil:

```xml
  <g sboardx:blend="normal" sboardx:opacity="100"
     style="mix-blend-mode: normal; opacity: 1.00;">
    <path id="t3" d="M...Z" fill="#5a4632" fill-opacity="0.35"
          fill-rule="nonzero" stroke="none" sboardx:z="3"
          sboardx:stroke-type="boundary"/>
    <path id="t7" d="M...Z" fill="#1a334d" fill-opacity="0.23"
          fill-rule="nonzero" stroke="none" sboardx:z="7"
          sboardx:stroke-type="pencil" sboardx:spine="..." sboardx:pencil="..."
          sboardx:pencil-rgba="0.1 0.2 0.3 0.8"/>
  </g>
```

The layer in `panels/p-1/layers.json` links its texture file:

```json
{
  "id": "p-1-L1", "name": "Pencil", "color_tag": "#2f6fb0",
  "opacity": 100, "blend": "normal", "locked": false, "visible": true,
  "art": "art/p-1-L1.svg",
  "texture": "art/p-1-L1.texture.json"
}
```

and `panels/p-1/art/p-1-L1.texture.json` is (with 1024-pixel cells to
keep it short; Upshot and the Toon Boom scripts use 256):

```json
{
  "atlas_size": [3000, 1500],
  "cell_size": 1024,
  "pages": ["images/p-1_p-1-L1_p0.png", "images/p-1_p-1-L1_p1.png"],
  "cells": [
    [0, 0, 0, 0, 0],
    [1, 0, 0, 1, 0],
    [2, 0, 0, 0, 1],
    [0, 1, 0, 1, 1],
    [1, 1, 1, 0, 0]
  ],
  "paths": [
    { "id": "t3", "view": [0, 0, 1600, 1100], "rect": [-400, -275, 800, 550] },
    { "id": "t7", "view": [2048, 0, 900, 900], "rect": [120, -180, 450, 450] }
  ]
}
```

### How the texture is stored

- The layer's texture is one big image, the **atlas**, `atlas_size` =
  [W, H] pixels on a transparent background. Nobody stores it whole.
- The atlas is cut into square **cells** of `cell_size` = S pixels. Cell
  (col, row) covers atlas pixels x from col·S to (col+1)·S and y from
  row·S to (row+1)·S. Cells on the right and bottom edges may stick out
  past W and H.
- Only cells with ink are stored. Each entry of `cells` is
  `[col, row, page, slot_col, slot_row]`: the cell's pixels are the S × S
  square at (slot_col·S, slot_row·S) in the PNG `pages[page]`. A cell that
  isn't listed is transparent.
- **Pages** are ordinary PNG files in `images/`, listed by full entry name
  in `pages`. Any PNG works, at most 2048 × 2048 pixels.
- Each entry of `paths` names a path of the art SVG by `id`. Its `view`
  [ax, ay, aw, ah] is the part of the atlas the path shows (pixels x from
  ax to ax+aw, y from ay to ay+ah), and its `rect` [x, y, w, h] is where
  that part is drawn, in world units.

| Key | Type | Meaning |
|---|---|---|
| `atlas_size` | [int, int] | The atlas size W, H in pixels. |
| `cell_size` | int | S: 64, 128, 256, 512 or 1024. |
| `pages` | array of strings | The page PNGs, as archive entry names (`images/<name>.png`). |
| `cells` | array of [col, row, page, slot_col, slot_row] | The stored cells. |
| `paths` | array of objects | One per textured path: `id`, `view`, and `rect` (unless the texture has its own `rect`). |
| `paths[].id` | string | The `id` of a `<path>` in the art SVG. |
| `paths[].view` | [int, int, int, int] | [ax, ay, aw, ah]: the atlas pixels the path shows. |
| `paths[].rect` | [number, number, number, number] | [x, y, w, h]: where the view is drawn, in world units. |
| `rect` | [number, number, number, number] | Optional. Where the whole atlas sits in the world, for path entries without their own `rect` (see "One image per layer"). |

### Drawing a textured path

For each entry in `paths`:

1. Find the `<path>` with that `id` in the art SVG.
2. Make an empty, transparent bitmap of aw × ah pixels.
3. For each stored cell that overlaps the view, copy its S × S square out
   of its page into the bitmap at (col·S − ax, row·S − ay). Copy pixels
   exactly, without scaling; whatever falls outside the bitmap is cut off.
4. Draw the bitmap stretched onto `rect`, clipped to the path's outline
   (with its `fill-rule`), at full opacity, in place of the path's fill.
   Don't also draw the flat fill.
5. The layer's opacity, blend and blur then apply as for any path.

Compose the cells into one bitmap before drawing it: drawing one image per
cell leaves visible seams. Pages are shared by many paths, so decode each
page once and reuse it (or compose all of a layer's paths in one pass over
its pages). If you want a smaller bitmap, shrink each cell by a power of
two with a box filter; other filters blend in the neighbouring cell on the
page, which belongs to another stroke.

**Worked example.** In the file above, W = 3000, H = 1500 and S = 1024, so
the grid is 3 × 2 cells. Five cells are stored; cell (2, 1) is empty.

Path `t3` shows view [0, 0, 1600, 1100]: a 1600 × 1100 bitmap covering
cells (0, 0), (1, 0), (0, 1) and (1, 1).

| Cell | Stored at | Copied from | Lands at |
|---|---|---|---|
| (0, 0) | page 0, slot (0, 0) | page 0, pixels (0, 0) | (0, 0) |
| (1, 0) | page 0, slot (1, 0) | page 0, pixels (1024, 0) | (1024, 0), right part cut off |
| (0, 1) | page 0, slot (1, 1) | page 0, pixels (1024, 1024) | (0, 1024), bottom part cut off |
| (1, 1) | page 1, slot (0, 0) | page 1, pixels (0, 0) | (1024, 1024), right and bottom cut off |

The bitmap is drawn over world x −400 to 400, y −275 to 275 (2 atlas
pixels per world unit), inside `t3`'s outline.

Path `t7` shows view [2048, 0, 900, 900], which lies in cell (2, 0) only.
That cell is on page 0 at slot (0, 1), so pixels (0, 1024) to (900, 1924)
of page 0 become the 900 × 900 bitmap, drawn over world x 120 to 570,
y −180 to 270.

### One image per layer

A writer can also render a whole layer as one image (the Toon Boom scripts
do). It then writes one `rect` for the whole texture, saying where the
full atlas sits in the world, and the path entries have no `rect` of their
own:

```json
{
  "atlas_size": [800, 338],
  "cell_size": 256,
  "rect": [-200, -84.5, 400, 169],
  "pages": ["images/p-2_p-2-L1_p0.png"],
  "cells": [[0, 0, 0, 0, 0], [1, 0, 0, 1, 0], [2, 0, 0, 2, 0], [1, 1, 0, 3, 0]],
  "paths": [
    { "id": "t0", "view": [0, 0, 520, 300] },
    { "id": "t1", "view": [380, 40, 300, 280] }
  ]
}
```

Atlas pixel (u, v) lands at world point (R.x + u·R.w/W, R.y + v·R.h/H),
R being the texture's `rect`. Here that is 2 atlas pixels per world unit
from (−200, −84.5). A path entry's `view` is then just the part of the
atlas its outline can touch, so drawing a path is the same as before with
the view's own rect worked out from R: view [0, 0, 520, 300] maps to world
(−200, −84.5, 260, 150). Paths that overlap show the same pixels, so you
can also compose the image once and draw it through all of them.

### The flat fill of a textured path

A textured path's `fill` and `fill-opacity` (and `sboardx:rgba`) are the
texture's average colour and coverage over the path, so a reader that
doesn't apply textures still shows about the right tone. A textured pencil
also carries its own colour in `sboardx:pencil-rgba`, which Upshot uses to
re-edit it. A faint or near-transparent fill doesn't mean the stroke is
empty: if the path has a texture entry, draw the texture.

### File names

Writers name a layer's texture file `art/<layerID>.texture.json` and its
pages `images/<panelID>_<layerID>_p<k>.png` (k = 0, 1, ...). A shared
drawing's texture file is `shared/<id>/texture.json` and works the same
way; its pages are `images/shared-<id>_<id>_p<k>.png`, or a holder
layer's pages. Readers just follow the `texture` link and `pages`.

### Textures in 1.1 files

1.1 files carry a texture as an SVG pattern fill over one image per
layer. Readers still draw these; 1.2 writers don't write them.

```xml
    <defs>
      <pattern id="tex4" patternUnits="userSpaceOnUse" x="-8" y="32"
               width="68" height="20" viewBox="0 0 136 40"
               preserveAspectRatio="none">
        <image href="../../../images/p-1_p-1-L1_pencil.png" x="0" y="0"
               width="136" height="40" preserveAspectRatio="none"/>
      </pattern>
    </defs>
    <path d="..." fill="url(#tex4)" sboardx:rgba="0.1 0.2 0.3 0.8" .../>
```

A browser draws this as it is. To draw it like a 1.2 texture: the image
(whose `href` is relative to the art SVG and leads into `images/`) is the
layer's atlas, the pattern's `viewBox` (rounded to whole numbers) is the
view, and its `x y width height` is the rect. The view counts in the
`<image>`'s `width` × `height` units, which Upshot writes equal to the
PNG's pixel size. The image can be any size.
The path's flat colour is its `sboardx:rgba` (black if absent). Any other
pattern fill is drawn flat in its `sboardx:rgba` colour, or black.

## Shared drawings (1.1)

```
shared/index.json
shared/<id>/art.svg
shared/<id>/texture.json     (optional, 1.2)
```

```json
{ "drawings": [ { "id": "sd-1", "name": "Prop", "art": "sd-1/art.svg",
                  "texture": "sd-1/texture.json" } ] }
```

A shared drawing is one drawing used by layers in several panels, kept in
step (Storyboard Pro's shared drawings, Upshot's linked layers).

- `art` is an art SVG like a layer's, relative to `shared/`. `texture`
  (optional, 1.2) is its texture file, also relative to `shared/`; its
  `paths` name paths of the drawing's `art.svg`.
- A layer using the drawing names it in its `shared` key, and also carries
  a full copy of the drawing's art in its own art SVG (after the panel's
  other strokes in `sboardx:z` order), with its own texture entries. A
  reader that doesn't care about sharing draws the layer's own art and is
  done.
- Since 1.2 the link is live: editing the drawing edits every layer that
  names it. A reader that keeps links checks that a layer's art is the
  same as the drawing's, and keeps a layer whose art differs as an
  unlinked copy. "The same" means the same paths in the same order with
  equal `d`, `fill-rule`, paint (colour, gradient, a textured path's rect)
  and stroke type. Ids, `sboardx:z` values and how the textures are stored
  don't count.
- Upshot also writes a private `x-upshot.shared_ref` on its layers. Ignore
  it.

## palettes.json (optional, 1.1)

```json
{
  "palettes": [
    { "id": "pal-1", "name": "Project",
      "colors": [
        { "id": "c-1", "name": "Sky",  "r": 0.2, "g": 0.5, "b": 0.9, "a": 1.0 },
        { "id": "c-2", "name": "Wash", "r": 0.1, "g": 0.2, "b": 0.3, "a": 0.5 }
      ] }
  ]
}
```

The board's colour palettes. Ids are stable and unique in the file, names
may be empty, and `r`, `g`, `b`, `a` go from 0 to 1. Solid colours only.

## audio/clips.json

```json
{
  "clips": [
    { "id": "a-1", "kind": "dialogue", "name": "line01.wav",
      "start": 0.5, "dur": 3.25, "trim_in": 0.1, "gain": 80,
      "file": "line01.wav", "track": 1 }
  ],
  "tracks": [ { "muted": false }, { "muted": true } ]
}
```

| Key | Type | Meaning |
|---|---|---|
| `id`, `name` | string | |
| `kind` | string | `music`, `dialogue` or `sfx`. Read anything else as `music`. |
| `start` | number | Position on the timeline in seconds (from the start of the board, not the scene). |
| `dur` | number | Length on the timeline in seconds. |
| `trim_in` | number | Where playback starts in the source file, in seconds. |
| `gain` | int | Volume in percent; 100 is unchanged. |
| `file` | string | The file name of an `audio/<file>` entry (WAV, MP3, M4A, AIFF, ...). Empty when the source is missing. |
| `track` | int | Optional, default 0. Index into `tracks`. |
| `tracks` | array | Optional, default one unmuted track. |

Clips on one track don't overlap; clips on different tracks play together.
Muted tracks are silent.

## images/

Image files: image layers (PNG or JPEG; the browser reader also takes GIF
and WebP), texture pages, 1.1 texture images and the images of 1.1
derived pencil layers. Several layers can use one file.

## If something is broken

Draw what you can and skip the rest. A broken or missing texture file,
page or entry just means the affected strokes draw with their flat fill
(a missing page or a page you can't decode leaves its cells transparent).
Upshot warns the user that the file is damaged and imports the rest of the
board.

## Merging

Upshot and its Storyboard Pro scripts can send the same board back and
forth and merge the changes ("Update from .sboardx"). Readers that don't
merge can skip this section.

Scenes and panels are matched **by id**, so a writer keeps the ids it was
given. A copied panel is a new panel with a new id.

**Panel digest.** To see which panels changed since the last exchange,
each panel gets a SHA-256 digest, written as 64 lowercase hex digits. It
hashes these archive entries, in this order:

1. `panels/<id>/panel.json`, with its `code` member cut out (reordering
   renumbers codes). Cut it as text: `"code"`, the colon, the string value
   and any whitespace between them, plus the comma after it (or the comma
   before it, if it is the last member).
2. `panels/<id>/layers.json`.
3. For each layer, in `layers.json` order:
   - its `art` file;
   - its `image.file`, if it has one;
   - `images/<id>_<layerID>_pencil.png`, if that entry exists (1.1 files);
   - if the layer has a `texture` string: the texture file
     (`panels/<id>/` + the string), then, if that file is a JSON object
     with a `pages` array, each string in `pages` in order (a name listed
     twice counts twice). A texture file that isn't valid JSON adds only
     its own bytes.

Each entry adds its name in UTF-8, a 0x00 byte, its raw bytes and another
0x00. An entry that doesn't exist adds its name, 0x00 and 0xFF. Files are
hashed as raw bytes, never re-serialised.

**Bases.** Two apps never write the same bytes for a panel, so a panel
one side only passed through would look changed every time. So
`project.json` can carry `"sync": {"panels": {"<panelID>": "<digest>"}}`:
for each panel the writer hasn't changed since it last exchanged it, the
digest from that exchange (its **base**). A merging reader whose own record
for the panel matches that digest treats the panel as unchanged, whatever
its bytes. Panels without a base are compared by their bytes. After a
merge, the reader records the base (or, without one, the archive's
digest), and a writer keeps declaring the same base until the panel
changes.

**Scene cameras** merge per scene the same way, each app comparing its own
digest of the scene's camera keyframes and layer tracks (that digest never
goes in the file). A taken camera replaces the scene's keyframes and
tracks as a whole. **Audio** has no base: a merge replaces all clips and
tracks with the file's, and only when the user asks.
