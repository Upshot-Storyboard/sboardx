# sboardx

The open storyboard package format. A `.sboardx` file is an uncompressed zip
of JSON (structure, timing, audio, camera) plus one plain SVG per layer of
art. Anything that can unzip a file can read it, and the SVGs open in any
vector tool.

Upshot Storyboard writes and reads it; This repro provides experimental Toon Boom 
Storyboard Pro scripts in [`toon-boom/`](toon-boom/). This repo is the format's
home: the spec, a browser reader, the Toon Boom bridge, sample files and a few
scripts.

## Open a .sboardx

- **In the browser**: open [`reader/index.html`](reader/index.html) and drop
  the file on it. Panels, layers, audio and camera moves play back.
- **With any zip tool**: `unzip board.sboardx`, then open `panels/*/art/*.svg`
  in Illustrator, Inkscape, Figma, or a browser.
- **In Toon Boom Storyboard Pro 24+**: install the scripts in
  [`toon-boom/`](toon-boom/README.md) and run `TB_ImportSboardx`.
- **From code**: it's `zipfile` + `json`. See [`examples/python/`](examples/python/).

## Layout at a glance

```
project.json                 format version, name, frame + resolution, fps
sequence.json                panel order, scenes, camera keyframes
panels/<id>/panel.json       code, shot, duration, note, dialogue
panels/<id>/layers.json      layer stack (bottom to top), image layers, blur
panels/<id>/art/<layer>.svg  the art, one SVG per layer, world coordinates
audio/clips.json + audio/*   clips, tracks, embedded audio files
images/*                     embedded images for image layers
```

Full details: [SPEC.md](SPEC.md). Current version: **1.0**.

## Repo contents

| Path | What |
|---|---|
| `SPEC.md` | The format specification |
| `reader/` | Single-file web reader (no build step) |
| `toon-boom/` | Storyboard Pro import/export scripts + round-trip test harness |
| `samples/` | Sample archives |
| `examples/python/` | `list_panels.py`, `extract_art.py`, `validate.py` (stdlib only) |

## Contributing

Bugs and proposals go through GitHub issues; format changes are pull
requests against `SPEC.md`. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](LICENSE). "Upshot" and "sboardx" are names of Zero
Eleven Labs Inc.; the license does not grant trademark rights.
