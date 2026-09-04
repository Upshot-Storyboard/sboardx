# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Zero Eleven Labs Inc.
"""Write every layer SVG (and embedded image) out of a .sboardx.

usage: extract_art.py FILE.sboardx OUT_DIR
Files land as OUT_DIR/<panel code>/<layer name>.svg, bottom layer first.
"""
import json
import os
import re
import sys
import zipfile

z = zipfile.ZipFile(sys.argv[1])
out = sys.argv[2]
seq = json.loads(z.read("sequence.json"))
safe = lambda s: re.sub(r"[^\w.-]+", "_", s) or "_"

for pid in seq["panels"]:
    panel = json.loads(z.read(f"panels/{pid}/panel.json"))
    layers = json.loads(z.read(f"panels/{pid}/layers.json"))["layers"]
    d = os.path.join(out, safe(panel["code"]))
    os.makedirs(d, exist_ok=True)
    for i, layer in enumerate(layers):
        name = f"{i:02d} {safe(layer['name'])}"
        with open(os.path.join(d, name + ".svg"), "wb") as f:
            f.write(z.read(f"panels/{pid}/{layer['art']}"))
        if "image" in layer:
            img = layer["image"]["file"]
            with open(os.path.join(d, name + os.path.splitext(img)[1]), "wb") as f:
                f.write(z.read(img))
print("wrote", out)
