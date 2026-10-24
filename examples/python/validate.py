# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Zero Eleven Labs Inc.
"""Structural check of .sboardx archives. Exit 1 on the first problem.

usage: validate.py FILE.sboardx [FILE...]
Checks: STORE-only zip, version, required entries, every art/image/audio
reference resolves, sequences, derived layers, gradient references. Does
not validate SVG geometry.
"""
import json
import posixpath
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
PATTERN_RE = re.compile(r"<pattern\b([^>]*?)>(.*?)</pattern>", re.S)
IMAGE_HREF_RE = re.compile(r'<image\b[^>]*?\b(?:xlink:)?href="([^"]+)"')
RGBA_RE = re.compile(r'\bsboardx:rgba="')


def check_art_svg(text, where, entry_names=None, art_dir=""):
    """Every gradient fill must resolve to a gradient with >= 2 stops (its
    own, or inherited through one level of href); every pattern fill
    ("Textured strokes", 1.1) to a <pattern> whose <image> href resolves to
    an archive entry, and a pattern-filled path carries sboardx:rgba."""
    stops, hrefs = {}, {}
    for _kind, attrs, body in GRADIENT_RE.findall(text):
        m = ID_RE.search(attrs)
        if not m:
            continue
        stops[m.group(1)] = len(STOP_RE.findall(body or ""))
        h = HREF_RE.search(attrs)
        if h:
            hrefs[m.group(1)] = h.group(1)
    patterns = {}
    for attrs, body in PATTERN_RE.findall(text):
        m = ID_RE.search(attrs)
        if not m:
            continue
        patterns[m.group(1)] = body
        for href in IMAGE_HREF_RE.findall(body):
            if href.startswith("data:"):
                continue
            target = posixpath.normpath(posixpath.join(art_dir, href))
            if entry_names is not None and target not in entry_names:
                raise ValueError(f"{where}: pattern {m.group(1)} image {href!r} is not in the archive")
    for tag in re.findall(r"<path\b[^>]*>", text):
        fm = FILL_URL_RE.search(tag)
        if not fm:
            continue
        gid = fm.group(1)
        if gid in patterns:
            if not RGBA_RE.search(tag):
                raise ValueError(f"{where}: pattern-filled path (url(#{gid})) lacks sboardx:rgba")
            continue
        if gid not in stops:
            raise ValueError(f"{where}: fill url(#{gid}) has no gradient or pattern definition")
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
    fps = project["canvas"]["fps"]
    if not isinstance(fps, (int, float)) or isinstance(fps, bool) or fps <= 0 or fps != int(fps):
        raise ValueError(f"project.json canvas.fps must be a positive whole number, got {fps!r}")

    layout = project.get("layer_layout")
    if layout is not None:
        if not isinstance(layout, list):
            raise ValueError("project.json: layer_layout must be an array")
        for i, e in enumerate(layout):
            if not isinstance(e, dict) or not isinstance(e.get("name"), str):
                raise ValueError(f"project.json: layer_layout[{i}] needs a string name")
            if e.get("kind", "vector") not in ("vector", "group"):
                raise ValueError(f"project.json: layer_layout[{i}] kind {e.get('kind')!r}")
            op = e.get("opacity", 100)
            if not isinstance(op, (int, float)) or isinstance(op, bool) or not (0 <= op <= 100):
                raise ValueError(f"project.json: layer_layout[{i}] opacity {op!r}")

    shared_ids = set()
    if "shared/index.json" in names:
        idx = json.loads(z.read("shared/index.json"))
        for d in idx.get("drawings", []):
            did = d.get("id")
            if not isinstance(did, str) or not did or did in shared_ids:
                raise ValueError(f"shared/index.json: drawing id {did!r} missing or duplicate")
            shared_ids.add(did)
            art = d.get("art", f"{did}/art.svg")
            if f"shared/{art}" not in names:
                raise ValueError(f"shared/index.json: {did} art shared/{art} missing")
            check_art_svg(z.read(f"shared/{art}").decode("utf-8"), f"shared/{art}", names, posixpath.dirname(f"shared/{art}"))

    if "palettes.json" in names:
        pals = json.loads(z.read("palettes.json")).get("palettes", [])
        seen_pal = set()
        for pal in pals:
            pid = pal.get("id")
            if not isinstance(pid, str) or not pid or pid in seen_pal:
                raise ValueError(f"palettes.json: palette id {pid!r} missing or duplicate")
            seen_pal.add(pid)
            seen_col = set()
            for col in pal.get("colors", []):
                cid = col.get("id")
                if not isinstance(cid, str) or not cid or cid in seen_col:
                    raise ValueError(f"palettes.json: colour id {cid!r} missing or duplicate in {pid}")
                seen_col.add(cid)
                for k in ("r", "g", "b", "a"):
                    v = col.get(k, 1.0 if k == "a" else 0.0)
                    if not isinstance(v, (int, float)) or isinstance(v, bool) or not (0.0 <= v <= 1.0):
                        raise ValueError(f"palettes.json: colour {cid} {k} out of 0..1 ({v!r})")

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

    sync = project.get("sync")
    if sync is not None:
        if not isinstance(sync, dict) or not isinstance(sync.get("panels", {}), dict):
            raise ValueError("project.json: sync must be an object with a panels object")
        for pid, base in sync.get("panels", {}).items():
            if pid not in seq["panels"]:
                raise ValueError(f"project.json: sync.panels names unknown panel {pid!r}")
            if not isinstance(base, str) or len(base) != 16 or any(c not in "0123456789abcdef" for c in base):
                raise ValueError(f"project.json: sync.panels[{pid!r}] is not a 16-hex digest")

    for pid in seq["panels"]:
        need(f"panels/{pid}/panel.json")
        need(f"panels/{pid}/layers.json")
        layers = json.loads(z.read(f"panels/{pid}/layers.json"))["layers"]
        layer_ids = {layer["id"] for layer in layers}
        for layer in layers:
            sh = layer.get("shared")
            if sh is not None and sh not in shared_ids:
                raise ValueError(f"panels/{pid}/layers.json: layer {layer['id']} shared {sh!r} is not in shared/index.json")
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
            check_art_svg(z.read(art).decode("utf-8", "replace"), art, names, f"panels/{pid}/art")

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
