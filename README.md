# sboardx

The storyboard file format of [Upshot Storyboard](https://www.upshotstoryboard.com/).
A `.sboardx` file is an uncompressed zip of JSON (panels, timing, camera,
audio) plus one plain SVG per layer of art, so anything that can unzip a
file can read it and the SVGs open in any vector tool.

This repo holds the spec, a browser reader, Toon Boom Storyboard Pro
scripts, sample files, a few Python scripts and a JSON Schema of the
texture file (`schema/`).

## Open a .sboardx

- **In the browser**: open [`reader/index.html`](reader/index.html) and drop
  the file on it.
- **With any zip tool**: `unzip board.sboardx`, then open
  `panels/*/art/*.svg` in Illustrator, Inkscape, Figma or a browser.
- **In Toon Boom Storyboard Pro**: install the scripts in
  [`toon-boom/`](toon-boom/README.md) and run `TB_ImportSboardx`.
- **From code**: it's `zipfile` + `json`. See
  [`examples/python/`](examples/python/) (run the scripts with `uv run`).

## Layout at a glance

```
project.json                 format version, name, frame, resolution, fps
sequence.json                panel order, scenes, camera keyframes
panels/<id>/panel.json       code, shot, duration, note, dialogue
panels/<id>/layers.json      layer stack (bottom to top)
panels/<id>/art/<layer>.svg  the art, one SVG per layer
panels/<id>/art/<layer>.texture.json
                             a textured layer's texture
audio/clips.json + audio/*   audio clips and files
images/*                     image layers and texture pages
```

Details: [SPEC.md](SPEC.md). Current version: **1.2** (1.0 and 1.1 files
still read). Changes: [CHANGELOG.md](CHANGELOG.md).

## Contributing

Bugs and proposals go through GitHub issues; format changes are pull
requests against `SPEC.md`. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](LICENSE). "Upshot" and "sboardx" are names of Zero
Eleven Labs Inc.; the license does not grant trademark rights.
