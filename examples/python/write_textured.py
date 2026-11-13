# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Zero Eleven Labs Inc.
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow==13.0.0"]
# ///
"""Write a small sboardx 1.2 board of textured strokes.

usage: uv run examples/python/write_textured.py OUT_DIR [--tile-size S] [--page-size P] [--shared]

Writes OUT_DIR/Textured.sboardx, two panels of 1.2 textured strokes (SPEC.md
"Textured strokes"). Each textured path is a plain flat path in the art SVG,
its fill being the flat fallback. The layer's texture file
(panels/<pid>/art/<layerID>.texture.json, linked from layers.json) holds the
atlas cut into S x S cells (S = 64 by default), the PNG pages, and per path
the texels it shows (`view`) and where (`rect`).

- 10-1: one tile per stroke at cell-aligned spots (Upshot's layout). Every
  entry has its own `rect`, and empty cells (the ring's middle) aren't stored.
- 10-2: the whole layer rendered once (Toon Boom's layout). The texture's
  `rect` places the atlas and each entry only has a `view`, so views share
  cells.

--shared also makes 10-2's layer the holder of a shared drawing, shared/sd-1,
whose texture file lists the holder's pages like the Toon Boom scripts do.
The committed sample is written without it.

Pages follow the writer rule in "Pages" with P = 2048. --page-size picks a
smaller power of two (>= S) to spread a small board over several pages.
Only 2048 matches the writer rule.

Flat fallbacks are the mean colour and coverage over the texels whose
centres are inside the path, colour at 6 decimals.

Pillow is pinned exactly because the PNG bytes depend on its bundled zlib.
samples/Textured_1_1.sboardx is the 1.1 version of this board (single-image
patterns); it's a fixed sample and isn't regenerated.
"""
import io
import json
import math
import os
import sys
import zipfile

from PIL import Image

FRAME_W, FRAME_H = 960.0, 540.0
RES_W, RES_H = 1920, 1080
D = 2                      # atlas texels per world unit
STAMP = (2026, 11, 6, 0, 0, 0)
NS = "https://sboardx.format/ns/1.0"
PAGE_MAX = 2048            # max page side


# ── Shapes (world units, y down; loops are closed polygons) ───────────────

def band(p0, p1, wave, half_w, n=120):
    """Tapered wavy stroke from p0 to p1."""
    (x0, y0), (x1, y1) = p0, p1
    dx, dy = x1 - x0, y1 - y0
    length = math.hypot(dx, dy)
    tx, ty = dx / length, dy / length
    nx, ny = -ty, tx
    left, right = [], []
    for i in range(n + 1):
        t = i / n
        off = wave * math.sin(2 * math.pi * 1.3 * t)
        cx, cy = x0 + dx * t + nx * off, y0 + dy * t + ny * off
        h = half_w * (0.25 + 0.75 * math.sin(math.pi * t))
        left.append((cx + nx * h, cy + ny * h))
        right.append((cx - nx * h, cy - ny * h))
    return [left + right[::-1]]


def ring(cx, cy, r, thick, n=96):
    """Annulus. Inner loop runs the other way so nonzero leaves a hole."""
    outer = [(cx + (r + thick / 2) * math.cos(2 * math.pi * i / n),
              cy + (r + thick / 2) * math.sin(2 * math.pi * i / n)) for i in range(n)]
    inner = [(cx + (r - thick / 2) * math.cos(-2 * math.pi * i / n),
              cy + (r - thick / 2) * math.sin(-2 * math.pi * i / n)) for i in range(n)]
    return [outer, inner]


def blob(cx, cy, rx, ry, rot, n=48):
    c, s = math.cos(rot), math.sin(rot)
    pts = []
    for i in range(n):
        a = 2 * math.pi * i / n
        wob = 1 + 0.12 * math.sin(3 * a)
        x, y = rx * wob * math.cos(a), ry * wob * math.sin(a)
        pts.append((cx + c * x - s * y, cy + s * x + c * y))
    return [pts]


# ── Rasterizing (texel lattice: texel (gx, gy) covers world [gx/D, (gx+1)/D)) ──

def texel_bounds(loops):
    """Texel bounds of the outline plus one texel each side. Used as the
    paint tile and as a view that covers the outline."""
    xs = [x for loop in loops for x, _ in loop]
    ys = [y for loop in loops for _, y in loop]
    gx0, gy0 = math.floor(min(xs) * D) - 1, math.floor(min(ys) * D) - 1
    gx1, gy1 = math.ceil(max(xs) * D) + 1, math.ceil(max(ys) * D) + 1
    return gx0, gy0, gx1 - gx0, gy1 - gy0


def edges_of(loops, gx0, gy0):
    out = []
    for loop in loops:
        pts = [(x * D - gx0, y * D - gy0) for x, y in loop]
        for k in range(len(pts)):
            (ua, va), (ub, vb) = pts[k], pts[(k + 1) % len(pts)]
            if va != vb:
                out.append((ua, va, ub, vb))
    return out


def spans(edges, v):
    """Nonzero-filled intervals of the scanline at v."""
    xs = []
    for ua, va, ub, vb in edges:
        if (va <= v < vb) or (vb <= v < va):
            xs.append((ua + (v - va) * (ub - ua) / (vb - va), 1 if vb > va else -1))
    xs.sort()
    out, wind, start = [], 0, 0.0
    for u, dw in xs:
        prev = wind
        wind += dw
        if prev == 0 and wind != 0:
            start = u
        elif prev != 0 and wind == 0:
            out.append((start, u))
    return out


def coverage(loops, gx0, gy0, w, h, sub=4):
    """Area coverage per texel: `sub` scanlines, exact along each."""
    edges = edges_of(loops, gx0, gy0)
    cov = [[0.0] * w for _ in range(h)]
    for j in range(h):
        row = cov[j]
        for s in range(sub):
            for a, b in spans(edges, j + (s + 0.5) / sub):
                a, b = max(a, 0.0), min(b, float(w))
                if b <= a:
                    continue
                ia, ib = int(a), int(b)
                if ia == ib:
                    row[ia] += (b - a) / sub
                    continue
                row[ia] += (ia + 1 - a) / sub
                for k in range(ia + 1, ib):
                    row[k] += 1.0 / sub
                if ib < w:
                    row[ib] += (b - ib) / sub
    return cov


def centres_inside(loops, gx0, gy0, w, h):
    """Texels whose centre is inside the loops (nonzero)."""
    edges = edges_of(loops, gx0, gy0)
    out = []
    for j in range(h):
        for a, b in spans(edges, j + 0.5):
            for i in range(max(0, math.ceil(a - 0.5)), min(w, math.ceil(b - 0.5))):
                out.append((i, j))
    return out


def hash01(x, y, seed):
    n = (x * 374761393 + y * 668265263 + seed * 2147483647) & 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((n ^ (n >> 16)) & 0xFFFF) / 65535.0


def grain(gx, gy):
    """Paper grain in 0.3..1, fixed to the world lattice."""
    cx, cy = gx // 4, gy // 4
    fx, fy = (gx % 4) / 4.0, (gy % 4) / 4.0
    v00, v10 = hash01(cx, cy, 1), hash01(cx + 1, cy, 1)
    v01, v11 = hash01(cx, cy + 1, 1), hash01(cx + 1, cy + 1, 1)
    smooth = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy
    return 0.3 + 0.7 * (0.75 * smooth + 0.25 * hash01(gx, gy, 2))


class Canvas:
    """Straight-alpha RGBA, 8 bits, transparent black where empty."""

    def __init__(self, w, h):
        self.w, self.h = w, h
        self.px = bytearray(w * h * 4)

    def over(self, x, y, rgb, a):
        """Source-over one texel, rgb in 0..255, a in 0..1."""
        if a <= 0:
            return
        k = (y * self.w + x) * 4
        da = self.px[k + 3] / 255.0
        oa = a + da * (1 - a)
        for c in range(3):
            dc = self.px[k + c]
            self.px[k + c] = round((rgb[c] * a + dc * da * (1 - a)) / oa)
        self.px[k + 3] = round(oa * 255)


def paint(img, loops, rgb, ox, oy):
    """Paint a stroke into img, whose texel (0, 0) is lattice (ox, oy)."""
    gx0, gy0, w, h = texel_bounds(loops)
    cov = coverage(loops, gx0, gy0, w, h)
    for j in range(h):
        for i in range(w):
            c = cov[j][i]
            if c > 0:
                img.over(gx0 - ox + i, gy0 - oy + j, rgb, min(1.0, c) * grain(gx0 + i, gy0 + j))


def fallback(img, loops, ox, oy):
    """Flat fallback (r, g, b, a) over the texels whose centres are inside
    the path."""
    gx0, gy0, w, h = texel_bounds(loops)
    # A sliver thinner than a texel has no centres inside; use its bbox.
    texels = centres_inside(loops, gx0, gy0, w, h) or [(i, j) for j in range(h) for i in range(w)]
    n, sa, sr, sg, sb = 0, 0.0, 0.0, 0.0, 0.0
    for i, j in texels:
        x, y = gx0 - ox + i, gy0 - oy + j
        if not (0 <= x < img.w and 0 <= y < img.h):
            continue
        k = (y * img.w + x) * 4
        a = img.px[k + 3] / 255.0
        n += 1
        sa += a
        sr += img.px[k] / 255.0 * a
        sg += img.px[k + 1] / 255.0 * a
        sb += img.px[k + 2] / 255.0 * a
    if n == 0 or sa == 0:
        return (0.0, 0.0, 0.0, 0.0)
    return (round(sr / sa, 6), round(sg / sa, 6), round(sb / sa, 6), round(sa / n, 6))


# ── Files ─────────────────────────────────────────────────────────────────

def png(w, h, px):
    """8-bit RGBA PNG."""
    buf = io.BytesIO()
    Image.frombytes("RGBA", (w, h), bytes(px)).save(buf, "PNG", compress_level=9)
    return buf.getvalue()


def num(v):
    v = round(v, 3)
    return "0" if v == 0 else f"{v:g}"


def json_num(v):
    """Whole values as int literals, the rest as floats."""
    return int(v) if float(v).is_integer() else float(v)


def path_d(loops):
    out = []
    for loop in loops:
        out.append("M " + " L ".join(f"{num(x)} {num(y)}" for x, y in loop) + " Z")
    return " ".join(out)


def is_byte(c):
    """Whether a channel in 0..1 is exactly n/255."""
    return math.floor(c * 255.0 + 0.5) / 255.0 == c


def hex_of(rgb):
    return "#%02x%02x%02x" % tuple(math.floor(max(0.0, min(1.0, c)) * 255.0 + 0.5) for c in rgb)


def cells_of(atlas, S):
    """{(col, row): S*S*4 RGBA bytes} for each cell with ink."""
    out = {}
    for row in range(-(-atlas.h // S)):
        for col in range(-(-atlas.w // S)):
            px = bytearray(S * S * 4)
            ink = False
            for y in range(S):
                ay = row * S + y
                if ay >= atlas.h:
                    break
                x0, x1 = col * S, min(col * S + S, atlas.w)
                seg = atlas.px[(ay * atlas.w + x0) * 4:(ay * atlas.w + x1) * 4]
                px[y * S * 4:y * S * 4 + len(seg)] = seg
                ink = ink or any(seg[3::4])
            if ink:
                out[(col, row)] = px
    return out


def pack_pages(cells, S, page_max):
    """Pack cells by the writer rule in "Pages".
    Returns ([PNG bytes], [[col, row, page, slot_col, slot_row]])."""
    per = page_max // S
    order = sorted(cells, key=lambda cr: (cr[1], cr[0]))
    pages, rows = [], []
    for k in range(0, len(order), per * per):
        run = order[k:k + per * per]
        pw, ph = min(len(run), per) * S, -(-len(run) // per) * S
        px = bytearray(pw * ph * 4)
        for i, (col, row) in enumerate(run):
            sc, sr = i % per, i // per
            rows.append([col, row, len(pages), sc, sr])
            src = cells[(col, row)]
            for y in range(S):
                at = ((sr * S + y) * pw + sc * S) * 4
                px[at:at + S * 4] = src[y * S * 4:(y + 1) * S * 4]
        pages.append(png(pw, ph, px))
    return pages, rows


def dump_texture(tex):
    """Texture file text: ASCII JSON, one cell or path entry per line."""
    def one(v):
        return json.dumps(v, ensure_ascii=True)
    out = ["{"]
    keys = list(tex)
    for i, k in enumerate(keys):
        v, comma = tex[k], "," if i + 1 < len(keys) else ""
        if k in ("cells", "paths") and v:
            out.append(f"  {one(k)}: [")
            out += [f"    {one(x)}" + ("," if j + 1 < len(v) else "") for j, x in enumerate(v)]
            out.append(f"  ]{comma}")
        else:
            out.append(f"  {one(k)}: {one(v)}{comma}")
    return "\n".join(out + ["}"]) + "\n"


def art_svg(pid, lid, name, paths, g_id=None):
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<svg xmlns="http://www.w3.org/2000/svg"\n     xmlns:sboardx="{NS}"\n'
            f'     viewBox="{num(-FRAME_W / 2)} {num(-FRAME_H / 2)} {num(FRAME_W)} {num(FRAME_H)}" '
            f'width="{num(FRAME_W)}" height="{num(FRAME_H)}"\n'
            f'     sboardx:layer-id="{lid}"\n     sboardx:layer-name="{name}"\n'
            f'     sboardx:panel-id="{pid}"\n     sboardx:format-version="1.2">\n'
            f'  <rect x="{num(-FRAME_W / 2)}" y="{num(-FRAME_H / 2)}" width="{num(FRAME_W)}" '
            f'height="{num(FRAME_H)}" fill="none"/>\n'
            '  <g' + (f' id="{g_id}"' if g_id else '') +
            ' sboardx:blend="normal" sboardx:opacity="100" style="mix-blend-mode: normal; opacity: 1.00;">\n'
            + paths + '  </g>\n</svg>\n')


def textured_path(loops, pid, rgba):
    """Flat path with an id. fill-opacity only when a != 1, sboardx:rgba
    only when R, G or B isn't n/255."""
    r, g, b, a = rgba
    paint_ = f' fill="{hex_of((r, g, b))}"'
    if a != 1.0:
        paint_ += f' fill-opacity="{a!r}"'
    if not all(is_byte(c) for c in (r, g, b)):
        paint_ += f' sboardx:rgba="{r!r} {g!r} {b!r} {a!r}"'
    return f'    <path id="{pid}" d="{path_d(loops)}"{paint_} fill-rule="nonzero" stroke="none"/>\n'


def textured_layer(strokes, layout, S, page_max):
    """strokes = [(loops, rgb)], layout "packed" (10-1) or "whole" (10-2).
    Returns (paths SVG text, texture object without pages, [page PNG bytes])."""
    boxes = [texel_bounds(loops) for loops, _ in strokes]
    entries = []
    rect = None
    if layout == "packed":
        places, yoff = [], 0
        for gx0, gy0, w, h in boxes:
            places.append(yoff)
            yoff += -(-h // S) * S
        atlas = Canvas(max(b[2] for b in boxes), places[-1] + boxes[-1][3])
        origins = []
        for (loops, rgb), (gx0, gy0, w, h), ay in zip(strokes, boxes, places):
            paint(atlas, loops, rgb, gx0, gy0 - ay)
            origins.append((gx0, gy0 - ay))
            entries.append({"view": [0, ay, w, h], "rect": [json_num(v / D) for v in (gx0, gy0, w, h)]})
    else:
        ox, oy = min(b[0] for b in boxes), min(b[1] for b in boxes)
        atlas = Canvas(max(b[0] + b[2] for b in boxes) - ox, max(b[1] + b[3] for b in boxes) - oy)
        for loops, rgb in strokes:
            paint(atlas, loops, rgb, ox, oy)
        origins = [(ox, oy)] * len(strokes)
        # The atlas spans all the bounds, so views stay inside it.
        entries = [{"view": [gx0 - ox, gy0 - oy, w, h]} for gx0, gy0, w, h in boxes]
        rect = [json_num(v / D) for v in (ox, oy, atlas.w, atlas.h)]
    pages, cell_rows = pack_pages(cells_of(atlas, S), S, page_max)
    stored = {(c[0], c[1]) for c in cell_rows}
    paths = ""
    for i, ((loops, _), entry, (ox, oy)) in enumerate(zip(strokes, entries, origins)):
        entry["id"] = f"t{i}"
        rgba = fallback(atlas, loops, ox, oy)
        ax, ay, aw, ah = entry["view"]
        meets = any(c * S < ax + aw and (c + 1) * S > ax and r * S < ay + ah and (r + 1) * S > ay
                    for c, r in stored)
        if rgba[3] == 0.0 and meets:
            # Ink is never hidden: no alpha 0 over a stored cell.
            rgba = rgba[:3] + (1.0 / 255.0,)
        paths += textured_path(loops, entry["id"], rgba)
    texture = {"atlas_size": [atlas.w, atlas.h], "cell_size": S, "pages": None, "cells": cell_rows}
    if rect is not None:
        texture["rect"] = rect
    texture["paths"] = [{k: e[k] for k in ("id", "view", "rect") if k in e} for e in entries]
    return paths, texture, pages


def build(S, page_max=PAGE_MAX, shared=False):
    files = []
    graphite, blue, rust = (41, 43, 51), (38, 76, 153), (140, 64, 38)

    def layer(lid, name, textured=False):
        out = {"id": lid, "name": name, "color_tag": "#2f6fb0", "opacity": 100, "blend": "normal",
               "locked": False, "visible": True, "art": f"art/{lid}.svg"}
        if textured:
            out["texture"] = f"art/{lid}.texture.json"
        return out

    def texture_bytes(texture, page_prefix, pages):
        names = [f"images/{page_prefix}_p{k}.png" for k in range(len(pages))]
        texture = dict(texture, pages=names)
        return dump_texture(texture).encode("ascii"), list(zip(names, pages))

    panels = []
    # 10-1: a tile per stroke, plus a plain ink layer underneath.
    p1 = "p-1"
    ink = [[(-470.0, 150.0), (470.0, 150.0), (470.0, 156.0), (-470.0, 156.0)]]
    ink_svg = art_svg(p1, "p-1-L1", "Ink",
                      f'    <path d="{path_d(ink)}" fill="#30343c" fill-rule="nonzero" stroke="none"/>\n')
    paths, tex, pages = textured_layer([
        (band((-380.0, -150.0), (380.0, -120.0), 40.0, 16.0), graphite),
        (ring(-200.0, 40.0, 110.0, 16.0), blue),
        (blob(230.0, 60.0, 46.0, 30.0, 0.4), rust),
    ], "packed", S, page_max)
    tex_json, page_files = texture_bytes(tex, f"{p1}_p-1-L2", pages)
    files += page_files
    panels.append((p1, "10-1", "A tile per stroke at cell-aligned places; the ring's empty middle "
                   "stores no cells.", [(layer("p-1-L1", "Ink"), ink_svg, None),
                                        (layer("p-1-L2", "Pencil", True), art_svg(p1, "p-1-L2", "Pencil", paths),
                                         tex_json)]))
    # 10-2: one render of the layer, placed by the texture's rect.
    p2 = "p-2"
    paths, tex, pages = textured_layer([
        (band((-200.0, -60.0), (200.0, 80.0), 18.0, 24.0), graphite),
        (band((-180.0, 90.0), (190.0, -70.0), 12.0, 20.0), rust),
    ], "whole", S, page_max)
    tex_json, page_files = texture_bytes(tex, f"{p2}_p-2-L1", pages)
    files += page_files
    holder = layer("p-2-L1", "Textured", True)
    shared_entries = []
    if shared:
        # The drawing's texture file reuses the holder's pages, like Toon Boom.
        holder["shared"] = "sd-1"
        shared_entries = [
            ("shared/index.json", json.dumps({"drawings": [{"id": "sd-1", "name": "Prop", "art": "sd-1/art.svg",
                                                            "texture": "sd-1/texture.json"}]},
                                             indent=2, sort_keys=True).encode("utf-8")),
            ("shared/sd-1/art.svg", art_svg("shared-sd-1", "sd-1", "Prop", paths, g_id="sd-1").encode("utf-8")),
            ("shared/sd-1/texture.json", tex_json),
        ]
    panels.append((p2, "10-2", "One render of the layer, placed once by the texture's rect; each path's "
                   "view covers its own outline, so the two views share cells.",
                   [(holder, art_svg(p2, "p-2-L1", "Textured", paths), tex_json)]))

    entries = [
        ("project.json", {"sboardx": "1.2", "app": "write_textured.py", "name": "Textured strokes",
                          "episode": "", "created_at": "2026-11-06T00:00:00Z", "modified_at": "2026-11-06T00:00:00Z",
                          "canvas": {"width": FRAME_W, "height": FRAME_H,
                                     "resolution": {"width": RES_W, "height": RES_H}, "fps": 24}}),
        ("sequence.json", {"panels": [p[0] for p in panels],
                           "scenes": [{"id": "sc-1", "name": "10", "panels": [p[0] for p in panels],
                                       "camera": {"keyframes": []}}],
                           "transitions": []}),
    ]
    out = [(n, json.dumps(v, indent=2, sort_keys=True).encode("utf-8")) for n, v in entries]
    for pid, code, note, layers in panels:
        out.append((f"panels/{pid}/panel.json", json.dumps(
            {"id": pid, "code": code, "shot": "", "dur": 3.0, "note": note}, indent=2, sort_keys=True).encode("utf-8")))
        out.append((f"panels/{pid}/layers.json", json.dumps(
            {"layers": [lj for lj, _, _ in layers]}, indent=2, sort_keys=True).encode("utf-8")))
        out.append((f"panels/{pid}/camera.json", b'{"keyframes": []}'))
        for lj, svg, tex_json in layers:
            out.append((f"panels/{pid}/{lj['art']}", svg.encode("utf-8")))
            if tex_json is not None:
                # texture file right after its art SVG
                out.append((f"panels/{pid}/{lj['texture']}", tex_json))
    return out + shared_entries + files


def write_zip(path, entries):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as z:
        for name, data in entries:
            info = zipfile.ZipInfo(name, date_time=STAMP)
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 3
            info.external_attr = 0o644 << 16
            z.writestr(info, data)


def main(argv):
    args = argv[1:]
    S, page_max, shared = 64, PAGE_MAX, False
    if "--tile-size" in args:
        k = args.index("--tile-size")
        S = int(args[k + 1])
        del args[k:k + 2]
    if "--page-size" in args:
        k = args.index("--page-size")
        page_max = int(args[k + 1])
        del args[k:k + 2]
    if "--shared" in args:
        args.remove("--shared")
        shared = True
    if (len(args) != 1 or S < 64 or S > 1024 or S & (S - 1) or page_max < S or page_max > PAGE_MAX
            or page_max & (page_max - 1)):
        sys.exit(__doc__)
    os.makedirs(args[0], exist_ok=True)
    path = os.path.join(args[0], "Textured.sboardx")
    write_zip(path, build(S, page_max, shared))
    print("wrote", path)


if __name__ == "__main__":
    main(sys.argv)
