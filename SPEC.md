# sboardx 1.0

The storyboard package format. A `.sboardx` file is an uncompressed zip
holding JSON for structure and one SVG per layer for art.

Design goals, in order: readable with stock tools (`unzip`, a browser, any
SVG editor), the SVG is the only copy of the art, additive evolution
(readers ignore what they don't know).

## Container

- A zip archive. Every entry uses method 0 (STORE). Compressed, encrypted
  and ZIP64 archives are not valid sboardx: Upshot's importer and
  `validate.py` reject them (the web reader happens to be lenient because
  it uses a general zip library; don't rely on that).
- Entry names are UTF-8, forward slashes, no leading `./`. Directory
  entries may be present and are ignored.
- Readers take sizes and offsets from the central directory, so output of
  `zip -0 -r`, bsdtar (`tar -a -cf x.sboardx --options zip:compression=store`)
  and Python's `zipfile` with `ZIP_STORED` all work.

Why STORE-only: readers stay a few dozen lines in any language, and the
payloads (SVG text, audio, images) are already compressed or tiny.

## Coordinate system

All geometry, camera centres and image transforms are **world units** on an
unbounded plane. The origin is the centre of the frame, y points down.

- The **frame** is the rectangle the camera shows at zoom 1 and what a
  render crops to. Its height is 540 world units by convention; its width is
  `540 · resolution.width / resolution.height`. Both are stored in
  `project.json` as `canvas.width` / `canvas.height`.
- **Resolution** (`canvas.resolution`) is the pixel size of a render. Changing
  it re-frames about the origin; it never rescales content.
- Art may extend beyond the frame. Readers clip to the frame (or to the
  camera's view).
- A **camera pose** `{z, cx, cy, rot}` maps world point `p` to frame
  space as `p' = S(z) · R(−rot) · (p − c)`, with `c = (cx, cy)`, `z` a zoom
  factor (1 = full frame, 2 = twice as close) and `rot` the camera's
  rotation in degrees, clockwise on screen (content appears rotated by
  `−rot`).

## Entries

Required unless marked optional. All JSON is UTF-8; key order is free.
Numbers marked *seconds* are doubles; *int* fields are integers.

```
project.json
sequence.json
panels/<panelID>/panel.json
panels/<panelID>/layers.json
panels/<panelID>/camera.json      (placeholder, see below)
panels/<panelID>/art/<layerID>.svg
audio/clips.json                  (optional)
audio/<file>                      (optional, referenced from clips.json)
images/<file>                     (optional, referenced from layers.json)
```

IDs (`<panelID>`, `<layerID>`, scene, keyframe and clip ids) are opaque
strings, unique within the file, safe as file names (`[A-Za-z0-9_-]`).

### project.json

```json
{
  "sboardx": "1.0",
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
  "x-upshot": { "...": "app state, ignore" }
}
```

| Key | Type | Notes |
|---|---|---|
| `sboardx` | string | Format version. Readers accept exactly the versions they know. |
| `app` | string | Producer name, free text. |
| `name`, `episode` | string | Display metadata. `episode` may be empty. |
| `created_at`, `modified_at` | string | ISO-8601 UTC. |
| `canvas.width`, `canvas.height` | double | Frame size in world units (height is 540 by convention). |
| `canvas.resolution.width/height` | int | Render size in pixels. |
| `canvas.fps` | number | Frame rate. Durations are stored in seconds; this is the grid they were authored on (Upshot uses 24). |
| `x-upshot` | object | Optional vendor block (editor state). See "Extending the format". |

### sequence.json

```json
{
  "panels": ["p-1", "p-2"],
  "scenes": [
    {
      "id": "sc-1",
      "name": "Scene 1",
      "panels": ["p-1", "p-2"],
      "camera": {
        "keyframes": [
          { "id": "k-1", "t": 0.0, "z": 1.0, "cx": 0.0,  "cy": 0.0,   "rot": 0.0 },
          { "id": "k-2", "t": 2.0, "z": 1.5, "cx": 48.0, "cy": -27.0, "rot": 15.0 }
        ]
      }
    }
  ],
  "transitions": []
}
```

- `panels`: every panel in timeline order. A panel's start time is the sum of
  the `dur` of the panels before it.
- `scenes`: contiguous runs of `panels`, in order; together they cover the
  whole `panels` list exactly once. Camera moves are per scene, not per
  panel.
- `camera.keyframes`: sorted by `t`, **seconds local to the scene** (0 = the
  start of the scene's first panel). Pose fields as in "Coordinate system".
  Between keyframes, Upshot eases each component with smoothstep and
  interpolates `z` geometrically; other readers may interpolate linearly.
  Before the first keyframe hold the first pose; after the last hold the
  last. No keyframes = static full frame.
- `transitions`: reserved, always `[]`. Writers should emit it; readers
  must not require it.

### panels/\<id\>/panel.json

```json
{
  "id": "p-1",
  "code": "01-A",
  "shot": "WS",
  "dur": 2.5,
  "note": "a note",
  "dialogue": "she said hi",
  "x-upshot": { "sketch": "", "stroke_set": true, "layer_counter": 2 }
}
```

| Key | Type | Notes |
|---|---|---|
| `id` | string | Same as the directory name. |
| `code` | string | Display code, e.g. `01-A`. Free text. |
| `shot` | string | Shot type, free text (`WS`, `CU`, …). May be empty. |
| `dur` | seconds | Panel duration. > 0. |
| `note` | string | Panel notes. May be empty. |
| `dialogue` | string | Optional. Absent means empty. Maps to the *Dialogue* caption in Toon Boom. |
| `x-upshot` | object | Optional vendor block. `stroke_set`/`layer_counter` let Upshot re-import its own files exactly; other readers ignore it. |

### panels/\<id\>/layers.json

```json
{
  "layers": [
    {
      "id": "p-1-L2",
      "name": "Shading",
      "color_tag": "#9a958c",
      "opacity": 80,
      "blend": "multiply",
      "locked": true,
      "visible": false,
      "blur": 6.5,
      "art": "art/p-1-L2.svg"
    },
    {
      "id": "p-2-L1",
      "name": "Photo",
      "color_tag": "#2f6fb0",
      "opacity": 100,
      "blend": "normal",
      "locked": false,
      "visible": true,
      "art": "art/p-2-L1.svg",
      "image": {
        "file": "images/photo.png",
        "w": 1280,
        "h": 720,
        "transform": [0.5, 0.0, 0.0, 0.5, 12.0, -20.0]
      }
    }
  ]
}
```

`layers` is ordered **bottom to top** (paint in array order).

| Key | Type | Notes |
|---|---|---|
| `id`, `name` | string | |
| `color_tag` | string | `#rrggbb`, UI label colour only. |
| `opacity` | int | 0–100. |
| `blend` | string | `normal`, `multiply`, `screen`, `overlay`, `add`. Unknown values read as `normal`. |
| `locked`, `visible` | bool | Hidden layers are not rendered. |
| `blur` | double | Optional, default 0. Gaussian sigma in world units, applied to the whole layer before opacity/blend. Upshot clamps to 0–20. |
| `art` | string | Path relative to the panel directory. Always present, even for image layers. |
| `image` | object | Optional. Makes this an **image layer**: its art SVG has no paths and the layer shows the referenced file instead. |
| `image.file` | string | Archive entry path (`images/<name>`). PNG or JPEG. |
| `image.w`, `image.h` | int | Natural pixel size of the file. |
| `image.transform` | [a,b,c,d,tx,ty] | Affine from image space to world. Image space is the `w × h` pixel rect **centred on its own origin**, y down. `x' = a·x + c·y + tx`, `y' = b·x + d·y + ty`. |

### panels/\<id\>/camera.json

Always `{"keyframes": []}`. Reserved from an earlier per-panel camera
design; camera moves live in `sequence.json`. Readers ignore it.

### panels/\<id\>/art/\<layerID\>.svg

One SVG per layer, in world units. Upshot writes exactly this:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:sboardx="https://sboardx.format/ns/1.0"
     viewBox="-480 -270 960 540" width="960" height="540"
     sboardx:layer-id="p-1-L1"
     sboardx:layer-name="Layer 1"
     sboardx:panel-id="p-1"
     sboardx:format-version="1.0">
  <rect x="-480" y="-270" width="960" height="540" fill="none"/>
  <g sboardx:blend="normal" sboardx:opacity="100"
     style="mix-blend-mode: normal; opacity: 1.00;">
    <path d="M 0 0 C 1 0 2 1 3 1 C 4 1 5 0 6 0 Z" fill="#1a334d"
          fill-opacity="0.5" fill-rule="nonzero" stroke="none"
          sboardx:z="0" sboardx:stroke-type="boundary"/>
  </g>
</svg>
```

- `viewBox` is the frame centred on the origin: `-W/2 -H/2 W H`. `width`
  and `height` equal `W` and `H`, so the user unit is one world unit.
- The `<rect fill="none">` marks the frame for editors; it draws nothing.
- The `<g>` carries the layer's blend and opacity (and `filter: blur(<sigma>px)`
  when `blur` is set) in plain CSS so a browser renders the layer right
  without reading `layers.json`. `layers.json` is authoritative if they
  disagree. The `add` blend maps to CSS `plus-lighter`.
- Each stroke is one `<path>`: a closed outline filled with the stroke
  colour, `fill-rule="nonzero"`, `stroke="none"`. `d` uses absolute `M`, `C`
  and `Z` only (one subpath per outline loop; holes are carved by the
  nonzero rule). `fill-opacity` carries alpha when it isn't 1.
- Coordinates are printed with shortest round-trip precision, so a reader
  parsing them with `strtod` gets the author's doubles back bit-exactly.

The `sboardx:` attributes are optional extras. Renderers ignore them; they
exist so Upshot can re-import its own files exactly:

| Attribute | Meaning |
|---|---|
| `sboardx:z` on `<path>` | The stroke's index in the panel's draw order across all layers. Restores interleaving after a round trip. |
| `sboardx:rgba` on `<path>` | `"r g b a"` doubles in 0–1 for colours not representable as 8-bit hex. |
| `sboardx:stroke-type` | Always `boundary` (the path is an outline, not a centreline). |
| `sboardx:blur` on `<g>` | Same value as `layers.json` `blur`. |
| Root `sboardx:layer-id` / `layer-name` / `panel-id` / `format-version` | Identification when the SVG is viewed alone. |

**Writing SVG for Upshot to read.** Upshot's importer is not a general SVG
parser. It reads `<path>` elements anywhere in the file with absolute
`M L Q C Z` commands (relative commands, arcs, `H`/`V` and transforms are
not supported; such a path is skipped). Filled paths import as-is. A
*stroked* path (`fill="none"`, `stroke`, `stroke-width`, round caps/joins)
is outlined into a filled shape on import, so pencil-style centrelines are
fine. Gradients, text, images and clip masks inside the art SVG are ignored.

### audio/clips.json

```json
{
  "clips": [
    {
      "id": "a-1",
      "kind": "dialogue",
      "name": "line01.wav",
      "start": 0.5,
      "dur": 3.25,
      "trim_in": 0.1,
      "gain": 80,
      "file": "line01.wav",
      "track": 1
    }
  ],
  "tracks": [ { "muted": false }, { "muted": true } ]
}
```

| Key | Type | Notes |
|---|---|---|
| `id`, `name` | string | |
| `kind` | string | `music`, `dialogue`, `sfx`. Unknown reads as `music`. |
| `start` | seconds | Position on the timeline (global, not scene-local). |
| `dur` | seconds | Length on the timeline. |
| `trim_in` | seconds | Offset into the source file where playback begins. |
| `gain` | int | Playback volume in percent; 100 = unity. |
| `file` | string | Basename of an `audio/<file>` entry. Any common format (WAV, MP3, M4A, AIFF). Empty when the source is missing. |
| `track` | int | Optional, default 0. Index into `tracks`. |
| `tracks` | array | Optional, default `[{"muted": false}]`. One entry per track. |

Clips on the same track don't overlap; clips on different tracks may, and
play together. Muted tracks are silent and excluded from renders.

### images/\<file\>

Raw image bytes referenced by an image layer. Use browser-safe formats
(PNG, JPEG; the reader also takes GIF and WebP). Never HEIC. One entry may
be shared by several layers.

## Optional keys: the full list

Every key below defaults to "as if absent" so a file that omits them all is
still complete. Writers should omit them at their default value.

| Where | Key | Default |
|---|---|---|
| `panel.json` | `dialogue` | `""` |
| `layers.json` layer | `blur` | `0` |
| `layers.json` layer | `image` | not an image layer |
| `clips.json` clip | `track` | `0` |
| `clips.json` | `tracks` | one unmuted track |
| `sequence.json` | `transitions` | `[]` |
| any | `x-*` | ignored |
| art SVG | `sboardx:*` | ignored |

## Extending the format

- Readers **must ignore** unknown JSON keys and unknown SVG attributes and
  elements. Don't fail on them, don't strip them if you rewrite the file
  (best effort).
- App-private data goes under a vendor key: `x-<vendor>` objects in JSON
  (Upshot's is `x-upshot`) and a namespaced attribute prefix in SVG. Never
  reuse another vendor's key.
- A new **optional** key with a default keeps the version string. A change
  that alters the meaning of existing data bumps the minor version, and
  readers refuse versions they don't know. Propose either as a pull request
  on this repo (see CONTRIBUTING.md).

## Conformance

**Minimum reader**: STORE-only zip; `project.json` version check;
`sequence.json` panel order and scenes; per panel `panel.json`,
`layers.json` and the art SVGs (render bottom to top, honour `visible`,
`opacity`, `blend`, `blur`, and `image` layers). Audio and camera are
optional to support.

**Minimum writer**: everything in "Entries" that isn't marked optional,
STORE-only, `sboardx: "1.0"`, art as filled `M C Z` (or `M L Q C Z`) paths
in world coordinates. Skip the `sboardx:` attributes unless you carry stroke
order across a round trip.

**Upshot's guarantee**: for a file Upshot wrote, import is bit-exact
(export → import → export yields identical bytes). Files from other writers
import render-faithfully.

## Implementations

- [`reader/`](reader/) — browser reader (JavaScript, single file).
- [`toon-boom/`](toon-boom/) — Storyboard Pro import and export scripts.
- Upshot for iPad — reference writer and strict-round-trip reader (C++,
  not in this repo).
