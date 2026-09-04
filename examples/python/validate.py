# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Zero Eleven Labs Inc.
"""Structural check of .sboardx archives. Exit 1 on the first problem.

usage: validate.py FILE.sboardx [FILE...]
Checks: STORE-only zip, version, required entries, every art/image/audio
reference resolves. Does not validate SVG content.
"""
import json
import sys
import zipfile

VERSIONS = {"1.0"}


def check(path):
    z = zipfile.ZipFile(path)
    names = set(z.namelist())

    def need(name):
        if name not in names:
            raise ValueError(f"missing {name}")

    for info in z.infolist():
        if info.compress_type != zipfile.ZIP_STORED:
            raise ValueError(f"{info.filename} is compressed; sboardx is STORE-only")

    need("project.json")
    project = json.loads(z.read("project.json"))
    if project.get("sboardx") not in VERSIONS:
        raise ValueError(f"unsupported version {project.get('sboardx')!r}")
    for k in ("width", "height", "fps"):
        if k not in project["canvas"]:
            raise ValueError(f"project.json canvas.{k} missing")

    need("sequence.json")
    seq = json.loads(z.read("sequence.json"))
    in_scenes = [pid for s in seq["scenes"] for pid in s["panels"]]
    if sorted(in_scenes) != sorted(seq["panels"]):
        raise ValueError("sequence.json: scenes do not partition panels")

    for pid in seq["panels"]:
        need(f"panels/{pid}/panel.json")
        need(f"panels/{pid}/layers.json")
        for layer in json.loads(z.read(f"panels/{pid}/layers.json"))["layers"]:
            need(f"panels/{pid}/{layer['art']}")
            if "image" in layer:
                need(layer["image"]["file"])

    if "audio/clips.json" in names:
        clips = json.loads(z.read("audio/clips.json"))
        tracks = len(clips.get("tracks", [{}]))
        for c in clips["clips"]:
            if c.get("file"):
                need(f"audio/{c['file']}")
            if not 0 <= c.get("track", 0) < tracks:
                raise ValueError(f"clip {c['id']} on track {c['track']} of {tracks}")


for path in sys.argv[1:]:
    try:
        check(path)
        print("ok  ", path)
    except (ValueError, KeyError, zipfile.BadZipFile) as e:
        print("FAIL", path, "-", e)
        sys.exit(1)
