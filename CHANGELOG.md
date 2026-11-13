# Changelog

Format versions, not repo releases. The version is the `sboardx` string in
`project.json`.

## 1.2

Every 1.0 and 1.1 file is a valid 1.2 file.

- **Textures live outside the SVG.** A textured path is now a plain flat
  path with an `id`, whose `fill` and `fill-opacity` are the texture's
  average colour and coverage. The texture is in the layer's texture file,
  `panels/<panelID>/art/<layerID>.texture.json`, linked by the new
  `layers.json` key `texture` (a shared drawing's is
  `shared/<id>/texture.json`, linked from `shared/index.json`). The file
  cuts the layer's texture into square cells, stores the cells that hold
  ink in PNG pages of at most 2048 × 2048, and says which part of the
  texture each path shows and where.
- A textured pencil keeps its own colour in `sboardx:pencil-rgba`.
- 1.1 pattern-fill textures and derived pencil layers are still read.
  Writers don't write them any more.
- 1.2 art has no `transform` attributes.
- `layers.json` `shared` is a live link: editing a shared drawing edits
  every layer that names it. Each layer still carries a copy of the art.
- The merge panel digest is SHA-256, and covers texture files and their
  pages. `sync.panels` bases are 64 hex digits.
- Reader, `validate.py` and Toon Boom scripts read 1.2. New samples
  `Textured.sboardx` and its 1.1 twin `Textured_1_1.sboardx`, written by
  `examples/python/write_textured.py`. New `schema/texture.schema.json`.

Toon Boom scripts and Upshot builds older than 1.2 refuse 1.2 files, so
update the Storyboard Pro scripts before exchanging files with an Upshot
that writes 1.2.

## 1.1

Additive only: a 1.0 file is a valid 1.1 file with the new keys absent.

- `sequence.json`: optional root `sequences`, contiguous runs of scene ids
  with an id and a display name (Toon Boom's sequences).
- `layer_tracks` (scene-scoped layer animation by layer or group name) and
  the layer `group` key.
- Art SVG: pencil strokes (`sboardx:stroke-type="pencil"`) and gradient
  fills.
- Art SVG: textured strokes. A stroke's rendered texture travels as a
  `<pattern>` fill over a per-layer atlas PNG. A textured path always
  carries `sboardx:rgba`, the flat colour a reader without pattern support
  falls back to.
- `layers.json`: derived layers. An earlier 1.1 writer split a layer
  holding pencil strokes into a hidden source plus two visible copies.
  Textured strokes replace that. Such files are still valid input, but
  writers must not produce them any more.
- `canvas.fps` is a whole number. Upshot writes the project's rate, reads
  it on import and refuses fractional rates.
- `project.json` `sync.panels`: for each panel a writer has not touched
  since the last exchange, the digest of that exchange. Lets a merge across
  two writers, whose bytes never match, tell a passed-through panel from a
  changed one. See "Merging".
- `project.json` `layer_layout`: optional default layer stack for new
  panels (name, kind, visible, locked, opacity, group).
- `palettes.json`: optional document palettes, named colours with stable
  ids.
- `shared/`: optional shared drawings (`index.json` plus one art SVG each),
  and the `shared` key on a layer that carries one unchanged.
- "Merging" section: the panel digest rule and the id-stability rule that
  merging readers rely on. Not a format change.
- Documented what 1.0 writers were already emitting: `sboardx:blend` and
  `sboardx:opacity` on the art `<g>`; `fill-opacity` as the stroke's own
  alpha for every stroke kind; Upshot's `x-upshot` keys in `project.json`
  and `panel.json`; the legacy vendor key `x-the-storyboard-app`; `code` is
  shown verbatim by readers.
- Reader: accepts 1.0 and 1.1.
- Toon Boom scripts: `TB_MergeSboardx` ("Update from .sboardx"), toolbar
  icons, and support for everything above. Storyboard Pro 27 or newer is
  now required.


## 1.0

First public version.
