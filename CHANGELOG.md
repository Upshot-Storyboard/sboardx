# Changelog

Format versions, not repo releases. The version is the `sboardx` string in
`project.json`.

## 1.1

Additive only: a 1.0 file is a valid 1.1 file with the new keys absent.

- `sequence.json`: optional root `sequences` — contiguous runs of scene
  ids with an id and a display name (Toon Boom's sequences). 
- Art SVG, pencil strokes: `sboardx:stroke-type` may be `pencil`. 
- `layers.json`, derived layers: a layer holding pencil strokes is written
  hidden plus two visible copies.
- Art SVG, gradient fills.
- Documented what 1.0 writers were already emitting: `sboardx:blend` /
  `sboardx:opacity` on the art `<g>`; `fill-opacity` as the stroke's own
  alpha for every stroke kind; Upshot's `x-upshot` keys in `project.json`
  and `panel.json`; the legacy vendor key `x-the-storyboard-app`; `code` is
  shown verbatim by readers.
- `layer_tracks` (scene-scoped layer animation by layer or group name), layer `group`.
- Reader: accepts 1.0 and 1.1.


## 1.0

First public version.
