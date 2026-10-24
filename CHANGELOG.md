# Changelog

Format versions, not repo releases. The version is the `sboardx` string in
`project.json`.

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
