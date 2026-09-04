# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Zero Eleven Labs Inc.
"""Print every panel of a .sboardx, grouped by scene.

usage: list_panels.py FILE.sboardx
"""
import json
import sys
import zipfile

z = zipfile.ZipFile(sys.argv[1])
seq = json.loads(z.read("sequence.json"))
for scene in seq["scenes"]:
    print(scene["name"])
    for pid in scene["panels"]:
        p = json.loads(z.read(f"panels/{pid}/panel.json"))
        line = f"  {p['code']:<8} {p['shot']:<6} {p['dur']:>5.2f}s"
        if p.get("dialogue"):
            line += f"  \"{p['dialogue']}\""
        print(line)
