# sboardx for Toon Boom Storyboard Pro

Three scripts. `TB_ImportSboardx` brings a `.sboardx` into the open project
as editable vector layers, with timing, notes, dialogue, audio and camera
moves. `TB_ExportSboardx` writes the open project out as a `.sboardx`.
`TB_MergeSboardx` ("Update from .sboardx") takes a `.sboardx` that Upshot
exported and applies only what changed to a project that already holds the
board, panel by panel. Together they let a board travel back and forth
between Upshot and Storyboard Pro.

Needs **Storyboard Pro 27 or newer**. The scripts write sboardx 1.1 and read
1.0 and 1.1 archives.

## Install

1. Copy all seven `.js` files from this folder into your scripts folder. They
   must stay together.
   - Windows: `%APPDATA%\Toon Boom Animation\Toon Boom Storyboard Pro\<version>-scripts`
   - macOS: `~/Library/Preferences/Toon Boom Animation/Toon Boom Storyboard Pro/<version>-scripts`
2. In Storyboard Pro, open the Scripts toolbar's **Manage Scripts** and add
   `TB_ImportSboardx`, `TB_ExportSboardx` and `TB_MergeSboardx` to the
   toolbar. Only add the three `TB_*` files; the other four are helpers.
3. Optional: `icons/` has a 64×64 PNG for each button. Copy them next to
   the scripts, then in Manage Scripts select each function under **In
   Toolbar**, click **Customize Icon** and pick the PNG with the same name.

## Import

Open the project that should receive the board, click **TB_ImportSboardx**
and pick the file. Scenes are appended after any existing ones; nothing is
deleted. The project is saved at the end. A dialog summarises what came in
and warnings go to the Message Log.

What you get:

- Scenes and panels with their names and durations. The project frame rate
  is set to the file's. Panel names come from the display code (`10-3`
  names the panel `3`). Sequences, when the file has them, group the scenes
  as in the source.
- Each layer as a vector drawing layer, in order, with name, opacity,
  visibility and lock. Image layers become bitmap layers. Blurred layers
  come in as pre-blurred bitmaps, since Storyboard Pro has no layer blur.
- Textured strokes become vector shapes filled with a texture colour cut
  from the layer's atlas image. Those colours live in a project palette
  called `Upshot_textures`. Older files that split pencil layers into
  `_vector` and `_raster` copies import as they are.
- Fill and pencil-line colours keep their opacity. Gradient fills become
  gradient palette colours placed on the shape.
- Layer groups as Storyboard Pro group layers, with their members inside.
- Layer and group animation as layer keyframes. Storyboard Pro keys live
  per panel, so a track is split at every panel cut with boundary keys to
  keep the motion continuous.
- Notes and dialogue into the `Notes` and `Dialogue` captions.
- Audio clips onto sound tracks, one per sboardx track, trimmed and placed.
  This replaces any clips already on the sound tracks.
- Camera moves as scene camera keyframes.
- Palettes from `palettes.json` become project palettes of the same name,
  or join an existing one. Colours are matched by name and missing ones are
  created as solid colours. Storyboard Pro assigns its own colour ids.
- The default layer stack from `project.json` (`layer_layout`). In
  Storyboard Pro this is a user preference (Edit > Preferences > Layers),
  so the import shows it and asks before applying. Batch imports apply it
  only with `{ applyLayerLayout: true }`.
- Shared drawings. The first layer that holds one imports normally and is
  made a shared drawing. There is no scriptable way to share a second layer
  with an existing drawing, so later holders come in as plain copies of the
  same art. The summary counts them so you can re-share them by hand.

The ids the panels and scenes came with are kept in the project (see
Merge), so a later export writes them under the same ids and a round trip
through Storyboard Pro keeps the source ids.

## Export

Click **TB_ExportSboardx** and choose where to save. If the project has
unsaved changes the script asks to save first, and Cancel aborts the
export. Drawings are read from the saved project files, so anything drawn
or edited since the last save would otherwise come out empty or stale. The
project is saved once more after the archive is written, so the merge
bookkeeping stays with it.

Layers are read back as vectors. Bitmap layers are rendered to images at
the project resolution and cropped to the frame. Textured strokes go out as
pattern fills over a per-layer atlas image. Panel notes and dialogue, audio
tracks, camera moves and sequences come along. A panel's display code is
`<scene>-<panel>`.

The project's palettes go out as `palettes.json`, solid colours only, with
Storyboard Pro's own colour ids. The scripts' own `sboardx` and
`Upshot_textures` palettes are skipped. The default layers preference goes
out as `layer_layout` in `project.json`.

Every shared drawing in the project goes out once under `shared/`, whether
a layer currently holds it or not, and every layer that holds one names it
in `layers.json`. Upshot imports these as shared drawings of its own. A
shared drawing's id is derived from the drawing file's path inside the
project, so a moved or copied project exports the same ids.

Camera moves are read from the scene's live camera: pan, scale, rotation
and a Z dolly (folded into the zoom). Keyframes the importer stored as
`sboardx-camera` panel metadata are echoed back while they still match the
live camera. If the camera was edited in Storyboard Pro, the live move is
exported and the Message Log says so.

Group layers come out as sboardx groups. Layer keyframes come out as
`layer_tracks` keyed by the layer's or group's name, one track per scene. A
layer that was only moved with the Layer Transform tool exports as a single
static keyframe. Storyboard Pro turns spaces and punctuation in layer names
into `_` (`Main BG` becomes `Main_BG`) and tracks follow the sanitised
name.

## Merge ("Update from .sboardx")

Open the project that already holds the board, click **TB_MergeSboardx**
and pick the `.sboardx` Upshot exported. An unsaved project is saved first
(after a prompt; Cancel aborts), because the script needs the saved
drawings to tell what changed on this side. A dialog lists what would
change. OK applies it as one undo step and saves the project.

Panels are matched by id. The project keeps an id map in its metadata
(`sboardx-ids`), keyed by Storyboard Pro's own panel ids, so a duplicated
panel counts as a new panel. For each panel the map remembers the archive
id, a fingerprint of the file's version at the last exchange and a
fingerprint of the panel's own exported form at that time. From those the
merge can tell who changed what:

- Changed in the file, untouched here: **updated**. The panel's layers,
  duration and captions are replaced with the file's.
- Changed only here: kept. Your change goes out with the next export.
- Changed on both sides: you choose **Keep mine** or **Take theirs**, per
  panel.
- Only in the file: **added** where the file has it. New scenes too.
- Only here: listed, and deleted only if you tick the box.
- In a different place in the file: **moved**. Storyboard Pro has no move
  command, so the panel is re-created at the file's slot (insert, fill,
  delete the original). It gets a new Storyboard Pro id; metadata and
  colour are copied. A moved panel you keep is re-created from its own
  exported form, which turns Toon Boom-only layer kinds (3D, bitmap) into
  rendered images. Untick "Keep … where it is" to leave such a panel in
  place.

Panels imported by an older version of these scripts have no fingerprints
yet. The first merge treats them as changed on both sides, so it asks
rather than overwriting, and records fingerprints for next time.

The fingerprint rule is shared by every app that merges sboardx files (see
"Merging" in SPEC.md); `sboardx_common.js` implements it here. Since
Upshot and Storyboard Pro never write byte-identical panels, a file can
also declare a panel unchanged: for every panel untouched since the last
exchange, the export writes that exchange's fingerprint into
`project.json` under `sync.panels`, and the merge reads the same
declaration from Upshot's files. A panel that only went to Upshot and back
is left alone.

Cameras: a scene whose camera changed in the file is applied when this
project's camera still matches the one from the last exchange (kept as
`sboardx-camera` metadata on the scene's first panel). If both sides
changed it, a Keep mine / Take theirs row asks. Audio: "Replace the audio
tracks with the file's" is off unless ticked, and replaces whole tracks.

## Batch

```
StoryboardPro -scene p.sboard -batch -compile TB_ImportSboardx.js -script "TB_ImportSboardxFromFile('C:/in/file.sboardx', true)"
StoryboardPro -scene p.sboard -batch -compile TB_ExportSboardx.js -script "TB_ExportSboardxToFile('C:/out/file.sboardx', true)"
StoryboardPro -scene p.sboard -compile TB_MergeSboardx.js -script "TB_MergeSboardxFromFile('C:/in/file.sboardx', true, {takeTheirs: 'all', deleteRemoved: false})"
```

`TB_ImportSboardxFromFile(file, quiet, options)` takes `{ replaceExisting,
applyLayerLayout }`. `TB_ImportSboardxReplacing(file, quiet)` is a shortcut
for the replacing form.

The merge options are `takeTheirs` (`"all"` or a list of archive panel
ids), `takeCameras` (`"all"` or a list of archive scene ids),
`deleteRemoved`, `keepInPlace` (a list of archive panel ids) and
`takeAudio`. Anything not named keeps this project's version. Run the merge
without `-batch`: applying changes in a batch session crashes Storyboard
Pro. A run that finds nothing to update is fine either way.

## Limitations

- Audio import needs a Storyboard Pro session with a UI. In batch the clips
  are not placed and the Message Log says so. Audio gain and track mutes
  are not exported.
- Opacity keyframes cannot be scripted in Storyboard Pro. An animated layer
  keeps a constant opacity, and layers export with their constant opacity.
- Image layers are rendered at the project resolution and cropped to the
  frame. In batch, image layers on a scene with a camera move are skipped,
  and layer opacity is read from the saved `.sboard` file.
- Layer blur is baked into pixels on import and lost on export.
- A brush stroke drawn with the brush's Opacity below 100 % is a textured
  stroke in Storyboard Pro and exports opaque.
- Nested layer groups flatten to the innermost group.
- A gradient on a pencil line flattens to its first stop.
- A shared drawing that no layer holds cannot be rendered by Storyboard
  Pro, so the script paints it itself. Texture colours come out as they
  render; a textured brush stroke in such a drawing stays flat.
