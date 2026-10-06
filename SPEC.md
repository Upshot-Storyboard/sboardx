# sboardx 1.1

The storyboard package format. A `.sboardx` file is an uncompressed zip
holding JSON for structure and one SVG per layer for art.

Design goals, in order: readable with stock tools (`unzip`, a browser, any
SVG editor), the SVG is the only copy of the art, additive evolution
(readers ignore what they don't know).

**Version 1.1** is 1.0 plus the additions marked *1.1* below (sequences,
pencil strokes and their derived layers, gradient fills) and the
documentation of what 1.0 writers were already emitting. Every addition is
optional with an "as before" default, so a 1.0 file is a valid 1.1 file;
1.1 collects them under one version string so a reader can say what it
supports. A 1.1 reader must accept 1.0 files. The `sboardx` XML namespace
URI stays `https://sboardx.format/ns/1.0`: it names the attribute
vocabulary, not the spec version, and 1.1 only adds attributes to it.
Readers match the prefix and take the version from `project.json`.

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
- A **layer pose** `{tx, ty, s, rot, opacity}` (a `layer_tracks` keyframe in
  `sequence.json`) moves one layer's art before the camera applies. With
  the track's pivot `c = (x, y)`:
  `p' = c + (tx, ty) + S(s) · R(rot) · (p − c)`, `s` a uniform scale
  (`> 0`, 1 = unchanged) and `rot` in degrees, clockwise on screen.
  `opacity` (0–1, 1 = unchanged) multiplies the layer's `opacity / 100`.

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
  "sboardx": "1.1",
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
| `sboardx` | string | Format version: `1.0` or `1.1`. Readers accept exactly the versions they know. |
| `app` | string | Producer name, free text. |
| `name`, `episode` | string | Display metadata. `episode` may be empty. |
| `created_at`, `modified_at` | string | ISO-8601 UTC. |
| `canvas.width`, `canvas.height` | double | Frame size in world units (height is 540 by convention). |
| `canvas.resolution.width/height` | int | Render size in pixels. |
| `canvas.fps` | number | Frame rate. Durations are stored in seconds; this is the grid they were authored on (Upshot uses 24). |
| `x-upshot` | object | Optional vendor block (editor state). See "Extending the format". |

**Upshot's `x-upshot` block in `project.json`** is editor state, written on
every export and read back only for `last_panel_id` / `last_layer_id` (the
panel and layer Upshot reopens on): `theme`, `accent` (strings),
`px_per_sec` (double, timeline zoom), `last_panel_id`, `last_layer_id`
(strings), `brush_size` (double), `brush_color` (`#rrggbb`), `zoom`
(double), `onion_skin` (bool), `playhead` (seconds), `layers_collapsed`,
`timeline_collapsed` (bool). Files written before the app was renamed carry
the same blocks under the key `x-the-storyboard-app`; Upshot still accepts
that key on import. A `project.json` with neither block is treated by
Upshot as another writer's archive (see `code` under `panel.json`).

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
- `layer_tracks` (optional, default none): the scene's **layer
  animation**. Each track animates every layer of the scene's panels that
  matches it by NAME — `kind: "layer"` matches `layers.json` entries whose
  `name` equals the track's `name`, `kind: "group"` matches entries whose
  `group` equals it. Readers skip tracks with an unknown `kind`. A track
  therefore continues across the panels of its scene (a panel that has no
  matching layer is simply unaffected) and ends at the scene boundary.
  `pivot` is a world point (default the origin). `keyframes` are sorted by
  `t`, seconds local to the scene like the camera's; each carries the pose
  fields of "Coordinate system" (`s > 0`, `opacity` 0–1). Between
  keyframes Upshot eases with smoothstep, interpolates `s` geometrically,
  `tx`/`ty`/`opacity` linearly and `rot` along the shortest arc; hold at
  both ends. A layer that matches both its own track and its group's is
  posed by its own track first, then by the group's (the group pose
  applies to the already-posed layer); opacities multiply.
- `sequences` (optional, default none; *1.1*): a grouping above scenes
  (Toon Boom's sequences). Each entry is a contiguous run of scene ids, in
  order, mirroring how scenes list panels; the runs need not cover every
  scene, and a scene belongs to at most one sequence. `id` is unique within
  the file, `name` is the display name. Writers emit the key only when at
  least one scene is in a sequence. Upshot stores the sequence *name* on
  each scene and re-mints ids on export (`seq-1`, `seq-2`, …), so a round
  trip keeps names, not ids; the Toon Boom bridge also matches by name.
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
  "x-upshot": { "sketch": "", "stroke_set": true, "layer_counter": 2, "name": "Crash" }
}
```

| Key | Type | Notes |
|---|---|---|
| `id` | string | Same as the directory name. |
| `code` | string | Display code, free text, shown verbatim by readers. Upshot writes `<scene name>-<token>` (`10-1`, `CHASE-Crash`). For an archive without a vendor block Upshot resolves codes on import: a token that is not the panel's automatic number becomes the panel's custom name. |
| `shot` | string | Shot type, free text (`WS`, `CU`, …). May be empty. |
| `dur` | seconds | Panel duration. > 0. |
| `note` | string | Panel notes. May be empty. |
| `dialogue` | string | Optional. Absent means empty. Maps to the *Dialogue* caption in Toon Boom. |
| `x-upshot` | object | Optional vendor block: `sketch` (legacy, always `""`), `stroke_set` (bool: whether the panel had a stroke entry at all, so an empty panel re-imports as empty), `layer_counter` (int, the highest automatic "Layer N" ever minted, only when non-zero), `name` (the user's custom part of `code`, e.g. `Crash` in `CHASE-Crash`). Lets Upshot re-import its own files exactly; other readers ignore it. |

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
| `group` | string | Optional, default `""` (none). The layer's folder: a group is a contiguous run of layers sharing this name, and it continues across panels by name (a `kind: "group"` track in `sequence.json` animates every member). Readers that don't show folders may ignore it. |
| `art` | string | Path relative to the panel directory. Always present, even for image layers. |
| `image` | object | Optional. Makes this an **image layer**: its art SVG has no paths and the layer shows the referenced file instead. |
| `image.file` | string | Archive entry path (`images/<name>`). PNG or JPEG. |
| `image.w`, `image.h` | int | Natural pixel size of the file. |
| `image.transform` | [a,b,c,d,tx,ty] | Affine from image space to world. Image space is the `w × h` pixel rect **centred on its own origin**, y down. `x' = a·x + c·y + tx`, `y' = b·x + d·y + ty`. |
| `x-upshot` | object | Optional vendor block (*1.1*). See "Derived layers" below. |

#### Derived layers (pencil split, 1.1)

Upshot's textured pencil renders a stroke from a centreline and a stamping
recipe that are not public. So that every reader still shows the texture,
a layer that holds pencil strokes is written as **up to three layers**: the
source layer itself, hidden, and two visible copies derived from it.

```json
{ "id": "p-1-L1", "name": "Sketch", "color_tag": "#2f6fb0", "opacity": 100,
  "blend": "normal", "locked": false, "visible": false, "art": "art/p-1-L1.svg",
  "x-upshot": { "split": { "visible": true, "vector": "p-1-L1-vector", "raster": "p-1-L1-raster" } } }

{ "id": "p-1-L1-raster", "name": "Sketch_raster", "color_tag": "#2f6fb0", "opacity": 100,
  "blend": "normal", "locked": false, "visible": true, "art": "art/p-1-L1-raster.svg",
  "image": { "file": "images/p-1_p-1-L1_pencil.png", "w": 1360, "h": 400,
             "transform": [0.5, 0, 0, 0.5, 60.0, 52.0] },
  "x-upshot": { "derived_from": "p-1-L1", "role": "raster" } }

{ "id": "p-1-L1-vector", "name": "Sketch_vector", "color_tag": "#2f6fb0", "opacity": 100,
  "blend": "normal", "locked": false, "visible": true, "art": "art/p-1-L1-vector.svg",
  "x-upshot": { "derived_from": "p-1-L1", "role": "vector" } }
```

- The **source** keeps its whole art (ink and pencil paths, with the
  pencil attributes of "Pencil strokes") and every presentation key, but
  its `visible` is forced to `false`. `x-upshot.split` records the
  original visibility and the ids of the copies.
- `<id>-vector` / `<name>_vector` holds the source's non-pencil strokes as
  ordinary filled paths. It is omitted when the source has no such
  strokes (then `split` has no `vector` key).
- `<id>-raster` / `<name>_raster` is an image layer whose file
  (`images/<panelID>_<layerID>_pencil.png`, RGBA PNG) is the writer's own
  rendering of the pencil strokes alone, on a transparent ground, placed in
  world by `image.transform` like any image layer.
- Both copies carry the source's `color_tag`, `opacity`, `blend`, `blur`,
  `locked` and `group`, and the source's ORIGINAL visibility. A
  `layer_tracks` entry whose `name` matches the source is duplicated for
  the two derived names so name-matched animation still applies; the
  duplicates carry `x-upshot: { "derived_from": "<name>", "role": … }`.
- **Stacking.** Inside one layer, ink and pencil strokes interleave freely
  in draw order; two whole layers can only stack one above the other. The
  writer places the raster copy above the vector copy when most pencil
  strokes were drawn after the ink, otherwise below. Where a pencil and an
  ink stroke overlap in the opposite order the copies differ from the
  source at that spot. The hidden source keeps the exact interleaving and
  is the layer Upshot edits.
- **Readers need nothing new**: honouring `visible` already shows the two
  copies and hides the source. Upshot's importer recognises
  `derived_from` in a file Upshot wrote, drops the copies and the
  duplicated tracks, and restores the source's visibility from `split`.
  An archive without a vendor block in `project.json` (another writer's,
  or a Toon Boom re-export) imports every layer as it is. Writers other
  than Upshot should not produce derived layers.

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
     sboardx:format-version="1.1">
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
  nonzero rule). `fill-opacity` carries alpha when it isn't 1; it is the
  stroke's own opacity for every stroke kind.
- Coordinates are printed with shortest round-trip precision, so a reader
  parsing them with `strtod` gets the author's doubles back bit-exactly.

The `sboardx:` attributes are optional extras. Renderers ignore them; they
exist so Upshot can re-import its own files exactly:

| Attribute | Meaning |
|---|---|
| `sboardx:z` on `<path>` | The stroke's index in the panel's draw order across all layers. Restores interleaving after a round trip. |
| `sboardx:rgba` on `<path>` (and on a gradient `<stop>`) | `"r g b a"` doubles in 0–1 for colours not representable as 8-bit hex. |
| `sboardx:stroke-type` on `<path>` | `boundary` (the default when absent: the path is a filled outline, not a centreline) or `pencil` (*1.1*, see "Pencil strokes"). |
| `sboardx:spine`, `sboardx:pencil`, `sboardx:grain-offset` on `<path>` | Upshot-private data of a `pencil` path (*1.1*). Opaque: the semantics are unpublished and may change without a version bump. Renderers ignore them and draw the path. |
| `sboardx:blend` / `sboardx:opacity` on `<g>` | Plain copies of the layer's `blend` and `opacity` for a reader looking at one SVG alone. `layers.json` is authoritative. |
| `sboardx:blur` on `<g>` | Same value as `layers.json` `blur`. |
| Root `sboardx:layer-id` / `layer-name` / `panel-id` / `format-version` | Identification when the SVG is viewed alone; `format-version` is the file's version string. |

#### Pencil strokes (1.1)

A `<path>` with `sboardx:stroke-type="pencil"` is a textured pencil stroke.
The path itself is the stroke's **fallback outline**: a closed filled shape
every renderer can draw, whose `fill-opacity` is the stroke's
full-coverage alpha. The attributes `sboardx:spine`, `sboardx:pencil` and
`sboardx:grain-offset` carry the data Upshot needs to re-edit the stroke;
they are private to Upshot and a renderer must not depend on them. Upshot
never relies on another renderer drawing the texture from them either: a
layer holding pencil strokes is written as derived layers (see
`layers.json`), and the derived raster copy is what readers show. A path
whose `sboardx:stroke-type` is `pencil` but whose private attributes are
missing or malformed is an ordinary filled outline.

#### Gradient fills (1.1)

A path may be filled with a linear or radial gradient instead of a flat
colour. The gradient is defined in a `<defs>` element placed as the first
child of the layer's `<g>` and referenced by `fill="url(#id)"`:

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
      <radialGradient id="g13" gradientUnits="userSpaceOnUse"
                      cx="0" cy="0" r="1"
                      gradientTransform="matrix(120 0 0 60 40 20)">
        <stop offset="0" stop-color="#ffffff"/>
        <stop offset="1" stop-color="#1a334d"/>
      </radialGradient>
    </defs>
    <path d="…" fill="url(#g12)" fill-rule="nonzero" stroke="none"
          sboardx:z="12" sboardx:stroke-type="boundary"/>
  </g>
```

- Upshot writes every gradient in **unit space**: a linear gradient runs
  from `(0,0)` to `(1,0)`, a radial gradient is the unit circle centred on
  `(0,0)`, and `gradientTransform` (a `matrix(a b c d tx ty)` in the
  `image.transform` scalar layout) maps that space onto the world. One
  affine therefore holds position, length, direction, ellipticity and
  skew, and transforms with the stroke by a matrix product. Readers that
  resolve SVG gradients natively (browsers) need nothing else.
- Stops are sorted by `offset` (0–1). `stop-color` is `#rrggbb`;
  `stop-opacity` carries the stop's alpha when it isn't 1; a
  `sboardx:rgba` attribute on the stop carries the exact colour when it is
  not representable in 8 bits. A gradient path carries no `fill-opacity`:
  the stops carry the alpha. Spread is always pad (the SVG default;
  `spreadMethod` is not written).
- Ids are unique within the file (`g<z>` in Upshot's output). The `<defs>`
  sits inside the `<g>` so a consumer that extracts only the layer group
  keeps the definitions.
- Upshot treats the first stop's colour as the stroke's flat fallback
  colour (used for onion skinning and when a consumer cannot draw the
  gradient). Pencil strokes are never gradient-filled.

**Writing SVG for Upshot to read.** Upshot's importer is not a general SVG
parser. It reads `<path>` elements anywhere in the file with absolute
`M L Q C Z` commands (relative commands, arcs, `H`/`V` and transforms are
not supported; such a path is skipped). Filled paths import as-is;
`fill-opacity` (and `stroke-opacity` on a stroked path) is honoured and
becomes the stroke's own opacity, which Upshot keeps through recolouring
and writes back as `fill-opacity`. A *stroked* path (`fill="none"`,
`stroke`, `stroke-width`, round caps/joins) is outlined into a filled
shape on import, so pencil-style centrelines are fine. Gradient fills
(*1.1*) are read in these forms: `linearGradient` and `radialGradient`
elements anywhere in the file, `gradientUnits` `objectBoundingBox` (the
SVG default) or `userSpaceOnUse`, `gradientTransform` as a list of
`matrix`, `translate`, `scale` and `rotate`, `x1 y1 x2 y2` / `cx cy r` as
numbers or percentages, stops given as attributes or as
`style="stop-color:…; stop-opacity:…"`, and one level of `href` /
`xlink:href` stop inheritance. A gradient with a single stop imports as
that flat colour; a `url(#…)` that resolves to nothing imports black.
Focal points (`fx`, `fy`), `spreadMethod` other than pad, pattern fills,
text, images and clip masks inside the art SVG are ignored.

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
| `layers.json` layer | `group` | `""` |
| `sequence.json` scene | `layer_tracks` | `[]` |
| `clips.json` clip | `track` | `0` |
| `clips.json` | `tracks` | one unmuted track |
| `sequence.json` | `sequences` | none |
| `sequence.json` | `transitions` | `[]` |
| art SVG `<path>` | `sboardx:stroke-type` | `boundary` |
| art SVG `<path>` | `fill="url(#…)"` | a flat `fill` colour |
| `project.json`, `panel.json` | `x-the-storyboard-app` | legacy alias of `x-upshot`, read by Upshot |
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

**Minimum reader**: STORE-only zip; `project.json` version check (`1.0`
or `1.1`; a 1.1 reader accepts 1.0 files); `sequence.json` panel order and
scenes; per panel `panel.json` (show `code` verbatim), `layers.json` and
the art SVGs (render bottom to top, honour `visible`, `opacity`, `blend`,
`blur`, `image` layers, and `fill-opacity` / gradient fills on paths).
Audio, camera and sequences are optional to support.

**Minimum writer**: everything in "Entries" that isn't marked optional,
STORE-only, `sboardx: "1.1"`, art as filled `M C Z` (or `M L Q C Z`) paths
in world coordinates. Skip the `sboardx:` attributes unless you carry stroke
order across a round trip. Never write derived layers.

**Upshot's guarantee**: for a file Upshot wrote, import is bit-exact
(export → import → export yields identical bytes). Files from other writers
import render-faithfully.

## Implementations

- [`reader/`](reader/) — browser reader (JavaScript, single file).
- [`toon-boom/`](toon-boom/) — Storyboard Pro import and export scripts.
- Upshot for iPad — reference writer and strict-round-trip reader (C++,
  not in this repo).
