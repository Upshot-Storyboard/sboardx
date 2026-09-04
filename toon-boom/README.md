# sboardx for Toon Boom Storyboard Pro

Two scripts: `TB_ImportSboardx` brings a `.sboardx` into the open project as
editable vector layers, with timing, notes, dialogue, audio and camera moves.
`TB_ExportSboardx` writes the open project out as a `.sboardx`.

Needs **Storyboard Pro 24 or newer** (tested on 27).

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
  is set to the file's fps).
- Each layer as a vector drawing layer, in order, with name, opacity,
  visibility and lock. Image layers become bitmap layers. Blurred layers are
  imported as pre-blurred bitmaps, since Storyboard Pro has no layer blur.
- Notes and dialogue into the `Notes` and `Dialogue` captions.
- Audio clips onto sound tracks, one per sboardx track, trimmed and placed.
  This replaces any clips already on the sound tracks.
- Camera moves as scene camera keyframes.

## Export

Click **TB_ExportSboardx** and choose where to save. Layers are read back as
vectors; bitmap layers and textured fills are rendered to images at the
project resolution and cropped to the frame. Panel notes and dialogue,
audio tracks and camera moves come along. Gradients flatten to their base
colour, blur is lost (already baked into pixels on import), audio gain isn't
available from Storyboard Pro so clips export at the app's default.

## Batch

```
StoryboardPro -scene p.sboard -batch -compile TB_ImportSboardx.js -script "TB_ImportSboardxFromFile('C:/in/file.sboardx', true)"
StoryboardPro -scene p.sboard -batch -compile TB_ExportSboardx.js -script "TB_ExportSboardxToFile('C:/out/file.sboardx', true)"
```

Audio import needs a GUI session (Toon Boom limitation); in batch it falls
back to placing whole files without trims. Image layers on scenes with a
camera move also skip in batch.
