# Changelog

Format versions, not repo releases. The version is the `sboardx` string in
`project.json`.

## Unreleased

- `sequence.json`: scenes may carry `layer_tracks` — keyframed layer
  animation (move, uniform scale, rotate, opacity about a pivot) applied by
  layer NAME or group name across the scene's panels. Additive; readers
  that ignore it render the layers at rest. Format version unchanged.
- `layers.json`: layers may carry `group`, the name of their folder
  (contiguous run). Additive, default none. Format version unchanged.
- `panel.json`: the `x-upshot` block may carry `name`, the user's custom
  part of the panel `code` (`"Crash"` for `CHASE-Crash`). Vendor-private,
  additive; readers ignore it. Format version unchanged.

## 1.0

First public version.
