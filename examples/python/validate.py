# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Zero Eleven Labs Inc.
"""Structural check of .sboardx archives. Exit 1 on the first problem.

usage: validate.py FILE.sboardx [FILE...]
Checks: STORE-only zip, version, required entries, every art/image/audio
reference resolves, sequences, derived layers, gradient references. Does
not validate SVG geometry.
"""
import json
import re
import sys
import zipfile

VERSIONS = {"1.0", "1.1"}

GRADIENT_RE = re.compile(
    r"<(linearGradient|radialGradient)\b([^>]*?)(?:/>|>(.*?)</\1>)", re.S)
ID_RE = re.compile(r'\bid="([^"]+)"')
HREF_RE = re.compile(r'\b(?:xlink:)?href="#([^"]+)"')
STOP_RE = re.compile(r"<stop\b")
FILL_URL_RE = re.compile(r'\bfill="url\(#([^)]+)\)[^"]*"')


def check_art_svg(text, where):
    """Every gradient fill must resolve to a gradient with >= 2 stops (its
    own, or inherited through one level of href)."""
    stops, hrefs = {}, {}
    for _kind, attrs, body in GRADIENT_RE.findall(text):
        m = ID_RE.search(attrs)
        if not m:
            continue
        stops[m.group(1)] = len(STOP_RE.findall(body or ""))
        h = HREF_RE.search(attrs)
        if h:
            hrefs[m.group(1)] = h.group(1)
    for gid in FILL_URL_RE.findall(text):
        if gid not in stops:
            raise ValueError(f"{where}: fill url(#{gid}) has no gradient definition")
        n = stops[gid] or stops.get(hrefs.get(gid, ""), 0)
        if n < 2:
            raise ValueError(f"{where}: gradient {gid} has fewer than 2 stops")


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
    for s in seq["scenes"]:
        for track in s.get("layer_tracks", []):
            if not isinstance(track.get("name"), str) or not track["name"]:
                raise ValueError(f"scene {s['id']}: layer track without a name")
            if track.get("kind") not in ("layer", "group"):
                raise ValueError(f"scene {s['id']}: layer track {track['name']} has kind {track.get('kind')!r}")
            pivot = track.get("pivot", {})
            if not all(isinstance(pivot.get(k, 0.0), (int, float)) for k in ("x", "y")):
                raise ValueError(f"scene {s['id']}: layer track {track['name']} pivot is not numeric")
            times = [k["t"] for k in track["keyframes"]]
            if times != sorted(times):
                raise ValueError(f"scene {s['id']}: layer track {track['name']} keyframes not sorted by t")
            for k in track["keyframes"]:
                if not k.get("s", 1.0) > 0:
                    raise ValueError(f"layer keyframe {k['id']}: s must be > 0")
                if not 0 <= k.get("opacity", 1.0) <= 1:
                    raise ValueError(f"layer keyframe {k['id']}: opacity must be 0..1")

    # sequences (1.1): contiguous runs of scene ids, each scene in at most one.
    scene_ids = [s["id"] for s in seq["scenes"]]
    if len(set(scene_ids)) != len(scene_ids):
        raise ValueError("sequence.json: duplicate scene id")
    seen, claimed = set(), set()
    for q in seq.get("sequences", []):
        qid = q.get("id")
        if not isinstance(qid, str) or not qid or qid in seen:
            raise ValueError(f"sequence.json: sequence id {qid!r} missing or duplicate")
        seen.add(qid)
        members = q.get("scenes", [])
        if not members:
            raise ValueError(f"sequence {qid}: no scenes")
        idx = []
        for sid in members:
            if sid not in scene_ids:
                raise ValueError(f"sequence {qid}: unknown scene {sid!r}")
            if sid in claimed:
                raise ValueError(f"sequence {qid}: scene {sid!r} is in two sequences")
            claimed.add(sid)
            idx.append(scene_ids.index(sid))
        if idx != list(range(idx[0], idx[0] + len(idx))):
            raise ValueError(f"sequence {qid}: scenes are not a contiguous run in order")

    for pid in seq["panels"]:
        need(f"panels/{pid}/panel.json")
        need(f"panels/{pid}/layers.json")
        layers = json.loads(z.read(f"panels/{pid}/layers.json"))["layers"]
        layer_ids = {layer["id"] for layer in layers}
        for layer in layers:
            art = f"panels/{pid}/{layer['art']}"
            need(art)
            if "image" in layer:
                need(layer["image"]["file"])
            if not isinstance(layer.get("group", ""), str):
                raise ValueError(f"panel {pid}: layer {layer['id']} group is not a string")
            # Derived layers (1.1): the markers must point at layers of this panel.
            x = layer.get("x-upshot", {})
            if isinstance(x, dict):
                src = x.get("derived_from")
                if src is not None:
                    if src not in layer_ids:
                        raise ValueError(f"panel {pid}: layer {layer['id']} derived from unknown layer {src!r}")
                    if x.get("role") == "raster" and "image" not in layer:
                        raise ValueError(f"panel {pid}: raster copy {layer['id']} has no image")
                split = x.get("split")
                if isinstance(split, dict):
                    if layer.get("visible", True):
                        raise ValueError(f"panel {pid}: split source {layer['id']} must be hidden")
                    for role in ("vector", "raster"):
                        if role in split and split[role] not in layer_ids:
                            raise ValueError(f"panel {pid}: split source {layer['id']} names unknown {role} copy {split[role]!r}")
            check_art_svg(z.read(art).decode("utf-8", "replace"), art)

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
