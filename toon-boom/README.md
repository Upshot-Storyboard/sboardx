# sboardx for Toon Boom Storyboard Pro

Three scripts:

- `TB_ImportSboardx` brings a `.sboardx` into the open project as editable
  vector layers, with timing, notes, dialogue, audio and camera moves.
- `TB_ExportSboardx` writes the open project out as a `.sboardx`.
- `TB_MergeSboardx` ("Update from .sboardx") takes a `.sboardx` exported by
  Upshot and applies only what changed, panel by panel, to a project that
  already holds the board.

Together they let a board go back and forth between Upshot and Storyboard
Pro.

Needs **Storyboard Pro 24 or newer** (tested on 27). The scripts write
sboardx 1.2 and read 1.0, 1.1 and 1.2. An archive with the
`x-the-storyboard-app` key is refused, whatever its version. Zipping and
unzipping uses the `tar` that ships with Windows 10+ and macOS. On Windows
it is called by full path (`%SystemRoot%\System32\tar.exe`), so a GNU tar
on your PATH (Git for Windows, say) is never picked up.

## Install

1. Copy all seven `.js` files from this folder into your scripts folder.
   They must stay together.
   - Windows: `%APPDATA%\Toon Boom Animation\Toon Boom Storyboard Pro\<version>-scripts`
   - macOS: `~/Library/Preferences/Toon Boom Animation/Toon Boom Storyboard Pro/<version>-scripts`
2. In Storyboard Pro, open **Manage Scripts** from the Scripts toolbar and
   add `TB_ImportSboardx`, `TB_ExportSboardx` and `TB_MergeSboardx` to the
   toolbar. Only the three `TB_*` files; the other four are helpers.
3. Optional: `icons/` has a 64×64 PNG per button. Copy them next to the
   scripts, then in Manage Scripts select each function under **In
   Toolbar**, click **Customize Icon** and pick the PNG with the same name.

## Import

Open the project that should receive the board, click **TB_ImportSboardx**
and pick the file. Scenes are appended after the existing ones, nothing is
deleted. If the project has unsaved changes you're asked to save first
(Cancel aborts), because the backup is made from the saved files (see
"Backups"). The project is saved at the end. A dialog sums up what came in
and where the backup is. Warnings go to the Message Log.

What comes in:

- **Scenes and panels**, with names and durations. The project frame rate
  is set to the file's. Panel names come from the display code (`10-3`
  gives a panel named `3`). Sequences, if the file has them, group the
  scenes as in the source.
- **Layers**, in order, as vector drawing layers with name, opacity,
  visibility and lock. Image layers become bitmap layers. Blurred layers
  come in as pre-blurred bitmaps (Storyboard Pro has no layer blur), their
  textured strokes painted with their textures.
- **Art** is read the way an SVG renderer reads it: `<path>` and the basic
  shapes (`<rect>`, `<circle>`, `<ellipse>`, `<line>`, `<polyline>`,
  `<polygon>`), with the paint inherited from groups (fill, stroke, their
  opacities, group opacity, `currentColor`, `inherit`), transforms (a
  texture follows its shape's transform) and any attribute quoting. Shapes
  styled by a class in a `<style>` sheet aren't supported: they're drawn
  black and counted in a warning.
- **Textured strokes** become vector shapes filled with a texture colour.
  In a 1.2 file a textured path is a plain flat path whose `id` names its
  entry in the layer's texture file (`art/<layer>.texture.json`, linked
  from `layers.json` `texture`; a shared drawing's is linked from
  `shared/index.json`). The texture is composed from the atlas cells the
  file lists and placed on the entry's rect (for a layer written as one
  image, under the texture's single `rect`). Cells live on pages, PNGs up
  to 2048 x 2048 under `images/`. Each page is decoded once, one at a time,
  and dropped as soon as the cells it holds are cut out, so memory follows
  the textures in progress, never a whole atlas. A 1.1 file's single-image
  pattern is read too. 1.1 files that split pencil layers into `_vector`
  and `_raster` copies import as they are.
- **Damage** is reported, one warning per layer (SPEC.md "Damage is
  reported"):
  - The layer's paths stay flat when the texture file is missing, isn't
    ASCII JSON with finite numbers and ASCII strings, breaks the link
    grammar, or has a bad atlas size, cell size, rect, pages, cells or
    paths. Same when the art SVG holds `<!`, or a `<?` other than the XML
    declaration at its start (checked on the raw text, BOM included).
  - One path stays flat when its entry is malformed or names an id that is
    listed twice, or that no path tag (or more than one) holds; when its
    tag isn't in the listed form (one self-closing tag of double-quoted
    `name="value"` attributes, no `style`, `transform` or `xmlns`); when
    its `d` isn't in the path dialect; or when its `fill` as written is
    `none` or `url(…)`.
  - A cell is transparent when it's off the grid, names no page, is listed
    twice, or its slot isn't inside its page, and when its page is
    misnamed, missing, not a PNG Qt can read, or larger than 2048 x 2048
    (Qt reads the size before decoding).

  These are SPEC.md's "The art SVG's syntax (1.2)" and "Pages", read the
  way Upshot reads them: every `id="…"` in a path tag counts, quoted values
  included, and a listed path's attributes are its pairs in order.
- **Texture colours** are only lent to the drawing. Each one is made in a
  scratch palette of the drawing's own element (element palettes never take
  over the Colour view) and that palette is removed as soon as the drawing
  is built. The drawing keeps its own copy of the texture, so the stroke
  looks the same in the session, after save and reopen, and in a copy of
  the project folder. No imported stroke ends up as a swatch in a palette.
- **Fill and pencil-line colours** keep their opacity. Gradient fills
  become gradient palette colours placed on the shape. Layer opacity is set
  on the layer only: the CSS `opacity` Upshot puts on the art's layer group
  (so browsers show the layer right) is not multiplied into the fills.
  Solid fills get an identity shader matrix, so the export writes them back
  as flat fills.
- **Layer groups** as group layers, members inside.
- **Layer and group animation** as layer keyframes. Storyboard Pro keys
  live per panel, so a track is split at every cut with boundary keys to
  keep the motion continuous. An opacity fade becomes an eased opacity
  function on the layer, keyed with the motion. A group keeps one opacity
  per panel, the fade's highest.
- **Notes and dialogue** into the `Notes` and `Dialogue` captions.
- **Audio clips** onto sound tracks, one per sboardx track, trimmed and
  placed. Clips already on the sound tracks are replaced.
- **Camera moves** as scene camera keyframes.
- **Palettes** from `palettes.json` become project palettes of the same
  name, or join an existing palette with exactly that name. Colours match
  by name; missing ones are added as solid colours after the palette's own.
  Storyboard Pro assigns its own colour ids. A palette without a name
  becomes `Imported palette <n>`.
- **Your palettes are left alone.** The import only adds the
  `palettes.json` ones, at the end of the list, so the project still opens
  on your first palette. The drawings' colours go into a scratch `sboardx`
  palette of each drawing's element, removed right after. Only if a
  drawing's element can't be found does it fall back to a scene palette
  (`sboardx`, or `sboardx_2` … if taken), removed at the end. Storyboard
  Pro jumps the Colour view to any scene palette a script edits, so the
  import puts it back after every drawing (failed ones included), after the
  palettes and before the final renders. It does that by renaming the
  palette to its own name, which changes nothing else. Your swatches and
  current colour stay as they were. The update does the same.
- If a project has an `Upshot_textures` palette (one texture swatch per
  textured stroke) or an empty `sboardx` palette, the scripts never touch
  them. You can delete them by hand from the palette list; the strokes keep
  their textures since each drawing holds its own copy.
- **Default layer stack** from `project.json` (`layer_layout`). In
  Storyboard Pro this is a user preference (Edit > Preferences > Layers),
  so the import shows it and asks first. Batch imports apply it only with
  `{ applyLayerLayout: true }`.
- **Shared drawings, linked.** Every layer holding a drawing from the
  file's `shared/` becomes a holder of ONE Storyboard Pro shared drawing
  (the `*` in the Layers view). The first holder is imported and shared;
  the others are pasted from a holder (Copy Layers / Paste Layers is the
  only way a script can link a layer to an existing drawing), then get
  their motion, opacity and name from the file like any layer. The paste
  uses the system clipboard: whatever was on it is put back at the end,
  every format, unless you copied something meanwhile (a warning says so).

  When the project already has the drawing (an update, or an import into
  the project the file came from), its holders are linked to it and nothing
  is duplicated:
  - Unchanged in the file since the last exchange: left as it is.
    "Unchanged" means a panel the file declares unchanged held it at that
    exchange. The project records which drawings each panel held then, so
    a holder you added here since doesn't count.
  - Changed in the file only: its art is replaced in place, so every holder
    in the project shows the new art, including holders in panels the
    update kept.
  - Changed on both sides, or never exchanged: the file's holders come in
    as plain copies, the project's drawing stays as it is, and a warning
    names it.

  Holders are pasted from any layer that still holds the drawing. A panel
  the update re-creates from the project's own form (a kept panel it moves)
  keeps the project's drawing, linked. Shared drawings are always read from
  a fresh copy of the saved file: Storyboard Pro caches a file it read once
  for the whole session, so an export right after an update would
  otherwise write the old art.

  A library drawing that no layer holds can't be pasted from, so a new
  shared drawing is made (with a warning). A blurred holder comes in as a
  picture and isn't linked. A batch import links nothing (Share Drawing and
  Copy/Paste Layers need a session): holders come in as plain copies, with
  a warning.

The panel and scene ids from the file are kept in the project (see
"Merge"), so a later export writes the same ids and a round trip through
Storyboard Pro keeps them.

## Export

Click **TB_ExportSboardx** and choose where to save. With unsaved changes
the script asks to save first (Cancel aborts): drawings are read from the
saved files, so anything since the last save would come out empty or
stale. The project is saved again after the archive is written, to keep
the merge bookkeeping with it.

**Layers** are read back as vectors. Bitmap layers are rendered alone at
the project resolution's pixel density (zoomed out up to four frames when
they reach past the frame, their own and their groups' motion set aside)
and cut to where they have pixels. Panel notes and dialogue,
audio tracks, camera moves and sequences come along. A panel's display
code is `<scene>-<panel>`.

**Textured strokes** go out in the 1.2 texture-file form over a per-layer
atlas:

- The layer is rendered alone (zoomed out up to four frames if its strokes
  lie outside the frame, its own and its groups' motion set aside), and
  that render, cropped to the textured strokes, is the atlas. So an atlas
  is never bigger than the render, however many strokes there are.
- In the art SVG each textured stroke is a plain flat path (`id="t<k>"`,
  k counting the SVG's textured paths from 0). Its `fill` and
  `fill-opacity` are the flat fallback any SVG program shows: the stroke's
  mean colour (8 bits) and mean coverage, never below 1/255 where a stored
  cell meets its view.
- The layer's texture file (`art/<layer>.texture.json`, compact ASCII JSON,
  linked from `layers.json` `texture`) holds the atlas size, the cell size,
  ONE `rect` placing the whole atlas in world units (shortest round-trip
  numbers), the pages, the cells, and one entry per textured path. Its
  `view` is the stroke's rectangle in the atlas: the bounds grown by half
  the 0.001 step `d` is printed with, then widened to whole pixels, so it
  covers the printed outline.
- The atlas is cut into 256 x 256 cells (`TILE_SIZE` in
  `sboardx_common.js`). Only cells under a stroke's rectangle that meet the
  stroke (grown by one pixel) and hold ink are kept. They're packed into
  the layer's pages by the spec's writer rule (`pageSlot` / `pageLayout`:
  row by row into 2048 x 2048 pages, the last one cropped), named
  `images/<panel>_<layer>_p<k>.png`. If an earlier layer already took the
  name (ids can contain `_`), a `_2`, `_3` … suffix is added. Readers
  decode at most one page at a time, and the archive carries no empty
  pixels beyond a cell around each stroke (plus the unused slots of a
  layer's last page).
- A shared drawing's `shared/<id>/art.svg` gets its own texture file,
  `shared/<id>/texture.json`, over its first holder's pages.

**Which fills are textured.** Storyboard Pro gives every fill a shader
matrix and reports a textured brush stroke as a plain solid fill, so the
export decides per fill and per drawing:

- No matrix, or the identity (every solid fill the import makes): flat.
- Storyboard Pro's default fit to the fill's own box (a stroke not moved
  since it was drawn): flat, unless the drawing holds a texture colour
  nothing in it uses. That's the mark the brush engine leaves for every
  textured stroke ("Rough Pencil", "Charcoal", "Textured Wash", soft
  pressure brushes). In such a drawing every solid fill goes out textured,
  since nothing says which one is the textured stroke.
- Any other matrix (moved, scaled or rotated since drawn): textured.
- A drawing with any textured fill (a texture colour, an Upshot pencil
  stroke, or one of the cases above) keeps ALL its solid fills textured.
  Its atlas is one render of the whole layer and Upshot joins a layer's
  textured strokes at the first one's place, so a flat fill written after
  them would come back on top of strokes that covered it.
- Gradients and pencil lines are never textured. A layer with only flat
  fills isn't rendered at all, which saves most of the export time on
  boards without textured brushes.

**Text layers** (made with the Text tool) go out as image layers:
scripting has no access to the glyphs, so the layer is rendered alone like
a bitmap layer. A layer with text and drawing together goes out the same
way, as one picture. The export records each one in the panel's
`sboardx-native-layers` metadata: its name, a hash of the picture and of
the layer's drawing file, and its opacity. A later merge can then keep the
text layer as text (see "Merge"). A batch export renders the opacity into
the picture and records nothing, so a merge after it brings the picture.

**Palettes** go out as `palettes.json`, solid colours only, with Storyboard
Pro's colour ids. The scripts' own `sboardx` and `Upshot_textures` palettes
(and `_N` copies of them) are skipped. The default layers preference goes
out as `layer_layout` in `project.json`.

**Shared drawings** go out once each under `shared/`, whether a layer holds
them or not (one no layer holds brings its texture pages along in
`images/`), and every holder names its drawing in `layers.json`. Upshot
imports them as its own shared drawings. A drawing that came from an import
keeps the id the file gave it (so Upshot's ids survive the trip); any other
drawing's id is derived from its file path in the project, so a moved or
copied project exports the same ids. Each export records, per drawing, the
art it wrote and the drawing file's state (in the `drawings` of the
project's `sboardx-ids` metadata), which the next import or update uses to
tell which side changed it. The art is identified by `sharedDrawingIdentity`
in `sboardx_common.js`, the same for export and import: the SHA-256 of
`art.svg`, plus its texture file for a textured drawing (its art doesn't
say where the texture is). The drawing file's state is the SHA-256 of the
saved `.tvg`. Both are computed by Qt (`QCryptographicHash`). A record in
any other form is ignored.

**Camera moves** come from the scene's live camera: pan, scale, rotation
and a Z dolly (folded into the zoom), each key at the time its frame is
shown. Camera keys sit on the scene's own frames. On import a key is
rounded to the nearest frame, and one at or past the scene's end goes on
its last frame (if two keys land on one frame the later wins, with a
warning naming the scene when that changes the camera). Every import,
export and update records the camera as exchanged (the file's keyframes
and the camera Storyboard Pro then holds) as `sboardx-camera` metadata on
the scene's first panel. While the live camera is still the recorded one,
the export writes the file's keyframes back exactly; once you edit it in
Storyboard Pro, the live camera goes out. Two cameras are the same when
they key the same frames with the same poses, so moving a key by one frame
is an edit. A key on a frame the scene doesn't have is never shown by
Storyboard Pro: it's left out, and a warning names the scene and frame so
you can key that pose again.

**Groups and layer animation.** Group layers come out as sboardx groups.
Layer keyframes come out as `layer_tracks` keyed by the layer's or group's
name, one track per scene. A panel's last frame is the panel's end. Where a
layer's pose jumps at a cut (each panel animating it separately), the track
keeps both poses as two keys at the cut, and the import keys the earlier
panel's last frame with the first one. A layer only moved with the Layer
Transform tool exports as a single static keyframe. Storyboard Pro turns
spaces and punctuation in layer names into `_` (`Main BG` becomes
`Main_BG`), and tracks use the sanitised name.

## Merge ("Update from .sboardx")

Open the project that already holds the board, click **TB_MergeSboardx**
and pick the `.sboardx` Upshot exported. With unsaved changes you're asked
to save first (Cancel aborts), since the script needs the saved drawings to
tell what changed on this side. A dialog lists what would change. OK backs
the project up (see "Backups"), applies everything as one undo step and
saves. If there's nothing to update, or you cancel, no backup is made.

Panels are matched by id. The project keeps an id map in its metadata
(`sboardx-ids`), keyed by Storyboard Pro's own panel ids, so a duplicated
panel counts as new. For each panel the map remembers the archive id, the
digest of the file's version at the last exchange (the archive digest,
SPEC.md "Merging") and a fingerprint of the panel as it was here then
(see below). That's enough to tell who changed what:

- Changed in the file, untouched here: **updated**. Layers, duration and
  captions are replaced with the file's.
- Changed only here: kept. Your change goes out with the next export.
- Changed on both sides: you pick **Keep mine** or **Take theirs**, per
  panel.
- Only in the file: **added** where the file has it, new scenes too.
- Only here: listed, deleted only if you tick the box.
- In a different place in the file: **moved**. Storyboard Pro has no move
  command, so the panel is re-created at the file's slot (insert, fill,
  delete the original). It gets a new Storyboard Pro id; metadata and
  colour are copied. A moved panel you keep is re-created from its own
  exported form, which turns Toon Boom-only layer kinds (3D, bitmap) into
  rendered images. Tick "Keep … where it is" to leave such a panel in
  place.

**Text layers.** An updated panel keeps a text layer as text when the file
brings it back as the same picture under the same name (Upshot left the
image alone, even if other layers changed). The text layer then takes the
picture's place in the stack, its opacity, visibility and lock. A layer
whose opacity fades within the panel keeps its fade, and stays text only
while Upshot left its opacity alone. If the picture was edited, moved,
blurred or renamed in Upshot, or the text layer was edited here since the
export, the picture replaces the text layer. A panel re-created to move it
gets the picture.

**The fingerprint** is read from the project's saved drawings without
rendering anything: the strokes, where each colour is painted (area and
centre, rounded), the fills' texture and gradient placements, the colour
values (not names, so renaming a palette colour changes nothing), the
layer settings, the panel's duration and captions, and the bitmap and text
layers' files. It comes out the same every time the project is opened,
even though Storyboard Pro returns a drawing's fills in a different order
each time. It's a SHA-256 (Qt's `QCryptographicHash`) over an exact text of
those values. An import records fingerprints only for the panels it
creates, an update only for the panels it fills, and every export records
one for every panel. A panel that was here before an import or update
keeps its baseline (or lack of one) until an export. A panel with no
baseline reads as changed here, so the merge asks instead of overwriting.

The digest rule is shared by every app that merges sboardx files (SPEC.md
"Merging"). `sboardx_common.js` implements it with Qt's
`QCryptographicHash`, fed whole files natively. The fingerprint is these
scripts' own and stays in the project; it never goes into an `.sboardx`.
Upshot and Storyboard Pro never write byte-identical panels, so a file can
also declare a panel unchanged: for every panel untouched since the last
exchange, the export writes that exchange's digest into `project.json`
under `sync.panels`, and the merge reads the same declaration from
Upshot's files. A panel that just went to Upshot and back is left alone.

**Cameras** follow the same rules: changed only in the file is applied,
changed only here is kept, changed differently on both sides gets a Keep
mine / Take theirs row. Keeping yours stops the same file from asking
again. A scene the file adds gets its camera; a scene re-created to follow
the file's scene order keeps its own.

**Audio**: "Replace the audio tracks with the file's" is off unless ticked,
and replaces whole tracks.

## Backups

Before the import or the update changes anything, the project folder is
copied, as saved, to a folder beside it named
`<project folder>_sboardx-backup-<yyyyMMdd-HHmmss>` (`-2`, `-3` … if two
start in the same second). If that folder can't be created there, the
backup goes to `Documents/sboardx-backups/` in your home folder. Windows
copies with `robocopy`, macOS with `ditto`. Every file is copied, no size
limit, except:

- the open session's `<name>.sboard.lock`, or the backup would ask whether
  the project is in use every time you open it;
- on Windows, links inside the project (junctions, symbolic links):
  robocopy doesn't follow them, because a link to a shared server folder
  would copy that whole folder. The summary and the Message Log say how
  many were left out. On macOS `ditto` copies them as links.

The palette links in the backup's `PALETTE_LIST` files are re-pointed at
the backup's own palettes, so opening a backup never touches the live
project's palettes. The new backup and the 4 newest older ones are kept in
that folder and older ones are deleted, except a backup that's open in
Storyboard Pro or was saved in since it was made. Each backup has a small
`sboardx-backup.json` at its root recording its scene files as they were;
a backup without it is never deleted. The Message Log line
`BACKUP <folder> bytes=… files=… ms=… pruned=… inUse=… linksLeftOut=…`
gives the size, the time taken and what the clean-up did.

To restore, first rename (or copy) the backup folder to a name of your
own, then open the `.sboard` inside: it's a complete project with its own
palettes. A folder still named `…_sboardx-backup-<date>` is a backup, and
backups get deleted as newer ones are made (an open or saved-in one is
spared, but don't rely on that).

If the backup fails (a file another program holds open without sharing, a
full disk), the import or update stops before changing anything and says
which file couldn't be copied. The incomplete copy is deleted. In batch the
message goes to the Message Log and the function returns false.

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
`takeAudio`. Anything not named keeps this project's version. Run the
merge without `-batch`: applying changes in a batch session crashes
Storyboard Pro. A run that finds nothing to update is fine either way.

## Limitations

- Audio import needs a session with a UI. In batch the clips aren't placed
  and the Message Log says so. Audio gain and track mutes aren't exported.
- Storyboard Pro has one opacity per layer and frame. A layer whose
  opacity animates exports at 100 % with the animation in its layer track,
  so a fade on a layer whose own opacity is below 100 % comes back as a
  100 % layer whose track carries the product. A group's fade imports as
  its highest opacity, constant over the panel.
- Bitmap and text layers are cut more than four frames out of the frame,
  and past about two frames (at 1080p) they get a lower pixel density.
  In batch, image layers in a scene with a camera move are skipped,
  layer motion can't be set aside for a textured layer's render (its tiles
  may miss), and renders keep the layer's opacity in their pixels (the
  image layer is then written at 100 %).
- Layer blur is baked into pixels on import and lost on export.
- A brush stroke drawn with the brush's Opacity below 100 % is a textured
  stroke in Storyboard Pro and exports opaque.
- Storyboard Pro renders at most 4096 px wide. A textured layer with
  strokes more than about two frames out (at 1080p) is rendered zoomed out
  beyond that, so its textures get a lower pixel density; strokes more
  than four frames out stay flat.
- Nested layer groups flatten to the innermost group.
- A gradient on a pencil line flattens to its first stop.
- A shared drawing that no layer holds can't be rendered by Storyboard
  Pro, so the script paints it itself from the texture colours' image
  files in the project's palette library. A texture colour that lives in a
  palette comes out as it renders. Textured strokes from an Upshot import
  don't: their colours were lent and removed during the import (see
  "Import"), so no palette keeps their image files. Such a drawing, once
  no layer holds it, goes out flat (the Message Log says so). While any
  layer holds it, it renders as usual. A textured brush stroke in such a
  drawing stays flat too.
