# sboardx for Toon Boom Storyboard Pro

Two scripts: `TB_ImportSboardx` brings a `.sboardx` into the open project as
editable vector layers, with timing, notes, dialogue, audio and camera moves.
`TB_ExportSboardx` writes the open project out as a `.sboardx`.

Needs **Storyboard Pro 24 or newer** (tested on 27). The scripts write
sboardx 1.1 and read 1.0 and 1.1 archives; update them before importing a
1.1 file, an older copy refuses it.

## Install

1. Copy all five `.js` files from this folder into your scripts folder. They
   must stay together.
   - Windows: `%APPDATA%\Toon Boom Animation\Toon Boom Storyboard Pro\<version>-scripts`
   - macOS: `~/Library/Preferences/Toon Boom Animation/Toon Boom Storyboard Pro/<version>-scripts`
2. In Storyboard Pro, open the Scripts toolbar's **Manage Scripts** and add
   `TB_ImportSboardx` and `TB_ExportSboardx` to the toolbar. Only add the two
   `TB_*` files; the other three are helpers.

## Import

Open the project that should receive the board, click **TB_ImportSboardx**,
pick the file. Scenes are appended after any existing ones; nothing is
deleted. A dialog summarises what came in; warnings go to the Message Log.

What you get:

- Scenes and panels with their names and durations (the project frame rate
  is set to the file's fps). Panel names come from the archive's display
  code (`10-3` names the panel `3`); sequences, when the file carries them,
  group the scenes as in the source (`createSequence`, names kept).
- Each panel remembers the id it came with (`sboardx-id` panel metadata;
  the scene's on its first panel), so a later export writes it under the
  same id and a round trip through Storyboard Pro keeps the source ids.
- Each layer as a vector drawing layer, in order, with name, opacity,
  visibility and lock. Image layers become bitmap layers. Blurred layers are
  imported as pre-blurred bitmaps, since Storyboard Pro has no layer blur.
  A file written by Upshot with textured pencil art arrives as a hidden
  source layer plus visible `_vector` and `_raster` copies (sboardx 1.1
  derived layers); they import as they are.
- Fill and pencil-line colours keep their opacity (`fill-opacity`,
  `stroke-opacity`). Gradient fills become gradient palette colours placed
  on the shape; on a Storyboard Pro without the gradient colour API they
  import as their first stop and the Message Log says so.
- Layer groups as Storyboard Pro group layers, members inside.
- Layer and group animation as layer keyframes: a track is split at every
  panel cut (Storyboard Pro keys live per panel) with boundary keys so the
  motion stays continuous. Opacity keyframes cannot be scripted in
  Storyboard Pro, so an animated layer keeps a constant opacity.
- Notes and dialogue into the `Notes` and `Dialogue` captions.
- Audio clips onto sound tracks, one per sboardx track, trimmed and placed.
  This replaces any clips already on the sound tracks.
- Camera moves as scene camera keyframes.

## Export

Click **TB_ExportSboardx** and choose where to save. Layers are read back as
vectors; bitmap layers and textured fills are rendered to images at the
project resolution and cropped to the frame. Panel notes and dialogue,
audio tracks, camera moves and sequences come along; a panel's display
code is `<scene>-<panel>`. Camera moves are read from the
scene's live camera: pan, scale, rotation and a Z dolly (folded into the
zoom). Keyframes kept as `sboardx-camera` panel metadata by the importer are
only echoed back when they still match the live camera; if the camera was
edited in Storyboard Pro the live move is exported and the Message Log says
so. Group layers come out as sboardx groups (nested groups flatten to the
innermost); layer keyframes come out as `layer_tracks` keyed by the layer's
or group's name, one track per scene — a layer merely moved with the Layer
Transform tool exports as a one-keyframe (static) pose. Storyboard Pro
turns spaces and punctuation in layer names into `_` (`Main BG` becomes
`Main_BG`); tracks follow the sanitised name. A translucent colour exports
as `fill-opacity` / `stroke-opacity`; a gradient colour as an SVG gradient
placed by the shape's matrix (a gradient on a pencil line flattens to its
first stop). A brush stroke drawn with the brush's Opacity below 100 % is
a textured stroke in Storyboard Pro and exports opaque (see the app
repo's TECH_DEBT.md). Blur is lost
(already baked into pixels on import), audio gain and opacity keyframes
aren't available from Storyboard Pro so clips export at the app's default
and layers at their constant opacity.

## Batch

```
StoryboardPro -scene p.sboard -batch -compile TB_ImportSboardx.js -script "TB_ImportSboardxFromFile('C:/in/file.sboardx', true)"
StoryboardPro -scene p.sboard -batch -compile TB_ExportSboardx.js -script "TB_ExportSboardxToFile('C:/out/file.sboardx', true)"
```

Audio import needs a GUI session (Toon Boom limitation); in batch it falls
back to placing whole files without trims. In batch, layer opacity is read
from the saved `.sboard` file, and image layers on scenes with a camera
move skip.
