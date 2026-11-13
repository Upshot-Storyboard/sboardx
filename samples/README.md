# Samples

- `Demo.sboardx`: a short board exported from Upshot. Three scenes, five
  panels, camera moves, an image layer and a music track. Drop it on the
  [reader](../reader/index.html) or unzip it.
- `Textured.sboardx`: textured strokes, 1.2 style. Each textured layer
  has a texture file (`panels/<panel>/art/<layer>.texture.json`) and a PNG
  page in `images/`. Panel 10-1 gives each stroke its own piece of the
  texture (how Upshot writes); panel 10-2 renders the layer as one image
  shared by its strokes (how the Toon Boom scripts write).
- `Textured_1_1.sboardx`: the same board in the 1.1 form (one image per
  layer, shown through SVG pattern fills). A reader that handles both
  draws them the same.

`Textured.sboardx` is written by
[`examples/python/write_textured.py`](../examples/python/write_textured.py):
`uv run examples/python/write_textured.py samples` from the repo root.
`--page-size 256` spreads each layer over several smaller pages, handy
for testing readers.

## Credits

The audio in `Demo.sboardx` is *Peer Gynt Suite No. 1, Op. 46 – I. Morning
Mood* (Edvard Grieg), performed by the Musopen Symphony, from
<https://musopen.org/music/777-peer-gynt-suite-no-1-op-46/>.
