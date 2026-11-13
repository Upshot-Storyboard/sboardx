# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Zero Eleven Labs Inc.
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=13", "defusedxml>=0.7.1", "svgelements>=1.9.6", "jsonschema>=4.26"]
# ///
"""Check .sboardx archives (1.0 to 1.2) against SPEC.md.

usage: uv run examples/python/validate.py FILE.sboardx [FILE...]

Prints ok or FAIL per file (stops at the first problem), plus a warn line
for things the spec only advises against. Exits 1 if any file failed.

Checks:
- the zip: STORE only, unencrypted, no ZIP64, unique names
- the JSON entries and the references between them
- art SVGs: the 1.2 syntax rules, sboardx:rgba, gradients, patterns
  (1.0/1.1 art only if it parses without a DTD)
- textures: links, the texture file (content rule + schema), listed paths,
  pages, ink never hidden
"""
import functools
import io
import json
import math
import os
import posixpath
import re
import struct
import sys
import zipfile
from collections import Counter

import defusedxml
import defusedxml.ElementTree as SafeET
import jsonschema
import svgelements
from PIL import Image

# svgelements retries `import numpy` per curve point, which is very slow when
# numpy is missing. Mark it missing once.
try:
    import numpy  # noqa: F401
except ImportError:
    sys.modules["numpy"] = None

VERSIONS = {"1.0", "1.1", "1.2"}
PAGE_MAX = 2048                              # max page side
MAX_DEPTH = 64                               # max nesting in a texture file
SCHEMA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, os.pardir,
                           "schema", "texture.schema.json")
TEXTURE_SCHEMA = None                        # set by main()
SVG_PATH = "{http://www.w3.org/2000/svg}path"
XLINK_HREF = "{http://www.w3.org/1999/xlink}href"

URL_RE = re.compile(r"^\s*url\(\s*#([^)\s]+)\s*\)")
# \Z, not $: $ also matches before a trailing newline.
HEX_RE = re.compile(r"^#([0-9a-fA-F]{6})\Z")
DIGEST_RE = re.compile(r"[0-9a-f]{64}\Z")
LINK_SEG_RE = re.compile(r"^[A-Za-z0-9_.-]+\Z")
ASCII_BYTES_RE = re.compile(rb"^[\t\n\r\x20-\x7e]*\Z")
JSON_STRING_RE = re.compile(rb'"(?:[^"\\]|\\.)*"')
TEXTURE_ENTRY_RE = re.compile(r"(\.texture\.json\Z)|(^shared/[^/]+/texture\.json\Z)")
# SPEC "The art SVG's syntax". Whitespace there is space, tab, LF, CR (not \s).
# A path tag runs from `<path ` to the first `>` or EOF. TAG_ID_RE is a
# lookahead so overlapping matches count. LISTED_RE is rule 4.
PATH_TAG_RE = re.compile(rb"<path[ \t\n\r][^>]*>?")
TAG_ID_RE = re.compile(rb'(?=[ \t\n\r]id="([^"]*)")')
NAME = rb"[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?"
LISTED_RE = re.compile(rb'<path(?:[ \t\n\r]+' + NAME + rb'="[^"<>&]*")+[ \t\n\r]*/>')
ATTR_RE = re.compile(rb'[ \t\n\r]+(' + NAME + rb')="[^"<>&]*"')
# Rule 5, the path dialect.
D_TOKEN_RE = re.compile(r"([MLQCZz])|([-+]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][-+]?[0-9]+)?)|[ \t\r\n,]+|(.)",
                        re.S | re.ASCII)
D_ARITY = {"M": 2, "L": 2, "Q": 4, "C": 6, "Z": 0, "z": 0}


def expect(ok, message):
    """Raises ValueError(message) unless ok."""
    if not ok:
        raise ValueError(message)


def numbers(text, n):
    """n finite floats from an attribute's text, or None."""
    try:
        vals = [float(v) for v in (text or "").replace(",", " ").split()]
    except ValueError:
        return None
    return vals if len(vals) == n and all(math.isfinite(v) for v in vals) else None


def is_byte(c):
    """Whether a channel in 0..1 is exactly n/255."""
    return 0.0 <= c <= 1.0 and math.floor(c * 255.0 + 0.5) / 255.0 == c


def hex_of(rgb):
    return "#%02x%02x%02x" % tuple(math.floor(max(0.0, min(1.0, c)) * 255.0 + 0.5) for c in rgb)


def local(el):
    """Tag name without its namespace."""
    return el.tag.rpartition("}")[2]


def is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


# ── Pages (Pillow) ────────────────────────────────────────────────────────

def page_problem(data):
    """(width, height, problem) of a page, per SPEC "Pages": a PNG Pillow
    reads, each side from 1 to PAGE_MAX (read before the pixels are)."""
    try:
        with Image.open(io.BytesIO(data), formats=["PNG"]) as im:
            w, h = im.size
            if not (1 <= w <= PAGE_MAX and 1 <= h <= PAGE_MAX):
                return w, h, f"is {w}x{h}: a side is not from 1 to {PAGE_MAX}"
            im.load()
    except Image.UnidentifiedImageError:
        return None, None, "is not a PNG"
    except Exception as e:  # Pillow raises SyntaxError, OSError, ValueError, zlib.error
        return None, None, f"is not a PNG Pillow can read ({type(e).__name__}: {e})"
    return w, h, None


def alpha_of(data):
    """(width, height, alpha as mode L or None if opaque) of a page."""
    with Image.open(io.BytesIO(data)) as im:
        if "transparency" in im.info or im.mode in ("P", "PA"):
            im = im.convert("RGBA")
        return im.width, im.height, im.getchannel("A") if "A" in im.getbands() else None


class Archive:
    """An open archive, cached page/image reads, and state gathered by the checks."""

    def __init__(self, z):
        self.z, self.names, self.version, self.warnings = z, set(z.namelist()), None, []
        self.referenced = set()             # referenced images/ entries
        self.links = {}                     # texture file entry -> who links it
        self.listed_slots = {}              # (page, S) -> slots some cell names
        self.page = functools.cache(lambda e: page_problem(z.read(e)))        # -> (w, h, problem)
        self.slot_ink = functools.cache(self._slot_ink)

    def warn(self, msg):
        self.warnings.append(msg)

    def _slot_ink(self, entry, S):
        """Slots (slot_col, slot_row) of a page with any non-transparent texel."""
        w, h, a = alpha_of(self.z.read(entry))
        slots = [(c, r) for r in range(h // S) for c in range(w // S)]
        return set(slots) if a is None else {
            (c, r) for c, r in slots if a.crop((c * S, r * S, c * S + S, r * S + S)).getbbox()}


# ── Art SVG (defusedxml) and paths (svgelements) ─────────────────────────

def syntax_problem(data):
    """Rules 1 (UTF-8, no BOM) and 2 (the art check) of "The art SVG's syntax"."""
    if data.startswith(b"\xef\xbb\xbf"):
        return "starts with a byte order mark"
    try:
        data.decode("utf-8")
    except UnicodeDecodeError as e:
        return f"is not UTF-8 (byte {e.start})"
    if b"<!" in data:
        return "holds '<!' (a document type declaration, comment or CDATA section)"
    declaration = data.startswith(b"<?xml") and data[5:6] in (b" ", b"\t", b"\n", b"\r")
    if b"<?" in data[1 if declaration else 0:]:
        return "holds '<?' other than in an XML declaration opening the file"
    return None


class Art:
    """One art SVG: its bytes and its XML tree."""

    def __init__(self, data):
        events = SafeET.iterparse(io.BytesIO(data), events=("start-ns",), forbid_dtd=True)
        prefixes = {}
        for _, (prefix, uri) in events:
            prefixes.setdefault(prefix, uri)
        self.root, self.data = events.root, data
        # Readers match the sboardx: prefix, not the URI.
        self.sbx = "{%s}" % prefixes["sboardx"] if "sboardx" in prefixes else None
        self.paths = [e for e in self.root.iter() if local(e) == "path"]
        self.svg_paths = {e.get("id"): e for e in self.root.iter(SVG_PATH)}     # by id (1.2 ids are unique)
        self._tags = None

    def sb(self, el, name):
        """sboardx:<name>, or None."""
        return el.get(self.sbx + name) if self.sbx else None

    def listed_path(self, pid, at, svg_entry):
        """The <path> of a listed id. Exactly one path tag may hold id="<pid>",
        and it must be in the listed form."""
        if self._tags is None:
            self._tags = {}                 # id -> path tags holding id="<id>"
            for m in PATH_TAG_RE.finditer(self.data):
                for v in set(TAG_ID_RE.findall(m.group())):
                    self._tags.setdefault(v, []).append(m.group())
        tags = self._tags.get(pid.encode("ascii"), [])
        expect(len(tags) == 1, f"{at}: {len(tags) or 'no'} path tag{'s' * (len(tags) != 1)} in {svg_entry} "
                               f"hold{'s' * (len(tags) == 1)} id=\"{pid}\"")
        # Walk name="value" pairs from `<path`, since a value may contain ` d="`.
        # Duplicate names and transforms already failed earlier.
        names, pos = [], 5
        while m := ATTR_RE.match(tags[0], pos):
            names.append(m[1])
            pos = m.end()
        bad = [n.decode() for n in names if n in (b"style", b"xmlns") or n.startswith(b"xmlns:")]
        why = ("not one self-closing <path .../> of name=\"value\" attributes without '<', '>' or '&'"
               if not LISTED_RE.fullmatch(tags[0]) else f"it carries {bad[0]}" if bad
               else None if b"d" in names else "no d")
        expect(why is None, f"{at}: its tag is not in the listed form ({why})")
        el = self.svg_paths.get(pid)
        expect(el is not None, f"{at}: the path tag holding id=\"{pid}\" is not an SVG <path> (its namespace)")
        return el


def readable_d(d):
    """Rule 5, the path dialect: M L Q C Z starting with M, whole argument
    groups of finite numbers, and at least one drawn segment."""
    cmds = []
    for cmd, num, other in D_TOKEN_RE.findall(d or ""):
        if other or (num and not cmds) or (num and not math.isfinite(float(num))):
            return False
        if cmd:
            cmds.append([cmd, 0])
        elif num:
            cmds[-1][1] += 1
    if not (cmds and cmds[0][0] == "M" and all(
            n == 0 if D_ARITY[c] == 0 else n > 0 and n % D_ARITY[c] == 0 for c, n in cmds)):
        return False
    is_open = False
    for c, n in cmds:
        if (c == "M" and n > 2) or (c in "LQC" and is_open):
            return True
        is_open = c == "M" or (is_open and c not in "Zz")
    return False


def outline_box(d):
    """The exact box of a readable d's drawn segments."""
    is_open, boxes = False, []
    for seg in svgelements.Path(d):
        if isinstance(seg, (svgelements.Move, svgelements.Close)):
            is_open = isinstance(seg, svgelements.Move)
        elif is_open:
            boxes.append(seg.bbox())
    return (min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes))


# ── Texture files (1.2) ───────────────────────────────────────────────────

def _refuse_constant(name):
    raise ValueError(f"{name} is not JSON")


def parse_texture(raw):
    """The content rule of "The texture file": (obj, None) or (None, why).
    ASCII bytes, nesting <= 64, strict JSON, finite numbers, ASCII strings
    after unescaping."""
    if not ASCII_BYTES_RE.match(raw):
        bad = next(i for i, b in enumerate(raw) if not (b in (9, 10, 13) or 0x20 <= b <= 0x7E))
        return None, f"byte {bad} is 0x{raw[bad]:02x}: not ASCII (a BOM, or UTF-8 beyond ASCII)"
    depth = 0
    for b in re.findall(rb"[\[\]{}]", JSON_STRING_RE.sub(b"", raw)):
        depth += 1 if b in b"[{" else -1
        if depth > MAX_DEPTH:
            return None, f"is nested deeper than {MAX_DEPTH} (arrays and objects)"
    try:
        # Huge ints become inf so the allow_nan=False dump below catches them.
        obj = json.loads(raw.decode("ascii"), parse_constant=_refuse_constant,
                         parse_int=lambda s: int(s) if math.isfinite(float(s)) else math.inf)
    except (ValueError, RecursionError) as e:
        return None, f"is not JSON ({e})"
    try:
        text = json.dumps(obj, ensure_ascii=False, allow_nan=False)
    except ValueError:
        return None, "holds a number that is not finite as a double"
    return (obj, None) if text.isascii() else (None, "holds a string that is not ASCII after unescaping "
                                                     "(a key or a value)")


def load_schema():
    """Validator for schema/texture.schema.json. Exits if it's missing or broken."""
    path = os.path.normpath(SCHEMA_PATH)
    try:
        with open(path, encoding="utf-8") as f:
            schema = json.load(f)
        jsonschema.Draft202012Validator.check_schema(schema)
    except OSError as e:
        sys.exit(f"validate.py: cannot read the texture schema {path} ({e.strerror}); it ships with "
                 "the sboardx repo as schema/texture.schema.json, two levels above this script")
    except (ValueError, jsonschema.SchemaError) as e:
        what = "is not JSON" if isinstance(e, ValueError) else "is not a valid JSON Schema"
        sys.exit(f"validate.py: cannot use the texture schema {path}: it {what} "
                 f"({type(e).__name__}: {str(e).splitlines()[0]})")
    return jsonschema.Draft202012Validator(schema)


def packed(order, stored, sizes, S):
    """Whether the cells follow the writer rule in "Pages": row-major, cell r
    on page r // P² at slot (r % P, r // P % P), all pages full except the
    last, which is cropped."""
    P, n = PAGE_MAX // S, len(order)
    want = [(min(m, P) * S, -(-m // P) * S) for m in (min(n - k, P * P) for k in range(0, n, P * P))]
    return order == sorted(order, key=lambda cr: (cr[1], cr[0])) and sizes == want and all(
        stored[cr] == (r // (P * P), r % P, r // P % P) for r, cr in enumerate(order))


def check_texture(arc, where, value, base_dir, name_rule, art, svg_entry):
    """One `texture` link and its texture file, against the art it describes.
    `where` is the entry holding the link."""
    expect(isinstance(value, str), f"{where}: texture {repr(value)[:80]} is not a string")
    expect(value.endswith(".json") and all(LINK_SEG_RE.match(s) and s not in (".", "..") for s in value.split("/")),
           f"{where}: texture {value!r} breaks the link grammar")
    expect(value == name_rule, f"{where}: texture {value!r} is off the name rule (writers write {name_rule!r})")
    entry = base_dir + "/" + value
    expect(entry in arc.names, f"{where}: texture {value!r} names no entry ({entry})")
    tex, why = parse_texture(arc.z.read(entry))
    expect(not why, f"{entry}: {why}")
    err = jsonschema.exceptions.best_match(TEXTURE_SCHEMA.iter_errors(tex))
    if err is not None:
        at = "".join(f"[{p}]" if isinstance(p, int) else f".{p}" for p in err.absolute_path).lstrip(".")
        raise ValueError(f"{entry}: {at or 'the top level'} breaks the schema: {err.message}")
    (W, H), S, R = tex["atlas_size"], tex["cell_size"], tex.get("rect")
    pages, cells, paths = tex["pages"], tex["cells"], tex["paths"]
    literal = all(type(v) is int for v in (W, H, S))   # 64 parses as int, 64.0 and 6.4e1 as float
    W, H, S = int(W), int(H), int(S)
    cols, rows = -(-W // S), -(-H // S)
    sizes = []
    for p in pages:
        expect(p in arc.names, f"{entry}: page {p} is not in the archive")
        w, h, problem = arc.page(p)
        expect(not problem, f"{entry}: page {p} {problem}")
        sizes.append((w, h))
        arc.referenced.add(p)
    stored, order = {}, []          # (col, row) -> (page, slot_col, slot_row), and listing order
    for c in cells:
        literal = literal and all(type(v) is int for v in c)
        col, row, k, sc, sr = (int(v) for v in c)
        if col >= cols or row >= rows:
            raise ValueError(f"{entry}: cell {c} lies outside the {cols}x{rows} grid")
        if k >= len(pages):
            raise ValueError(f"{entry}: cell {c} names page {k} of {len(pages)}")
        if (col, row) in stored:
            raise ValueError(f"{entry}: cell ({col}, {row}) is listed twice")
        if (sc + 1) * S > sizes[k][0] or (sr + 1) * S > sizes[k][1]:
            raise ValueError(f"{entry}: cell {c}: its slot is not inside its {sizes[k][0]}x{sizes[k][1]} "
                             f"page {pages[k]}")
        stored[(col, row)] = (k, sc, sr)
        order.append((col, row))
    ids = Counter(e["id"] for e in paths)
    met = set()
    for e in paths:
        pid, v = e["id"], e["view"]
        if ids[pid] > 1:
            raise ValueError(f"{entry}: path {pid} is listed by {ids[pid]} entries")
        literal = literal and all(type(x) is int for x in v)
        ax, ay, aw, ah = (int(x) for x in v)
        if not (ax + aw <= W and ay + ah <= H):
            raise ValueError(f"{entry}: path {pid}: view {v} does not lie inside the {W}x{H} atlas")
        if "rect" not in e and R is None:
            raise ValueError(f"{entry}: path {pid} has no rect and the texture has none")
        el = art.listed_path(pid, f"{entry}: path {pid}", svg_entry)
        fill = el.get("fill")
        if fill is not None and not HEX_RE.match(fill):
            raise ValueError(f"{entry}: path {pid}: its fill is {fill!r}, not a colour's #rrggbb")
        if not readable_d(el.get("d")):
            raise ValueError(f"{entry}: path {pid}: its d is not absolute M L Q C Z in ASCII with finite "
                             "numbers and a drawn segment (the path dialect)")
        if "rect" not in e:
            # No rect: the texture rect maps the whole atlas, and the view
            # must cover the outline ("The mapping").
            px, py, pw, ph = (float(x) for x in R)
            bx0, by0, bx1, by1 = outline_box(el.get("d"))
            u0, v0 = max(0, math.floor((bx0 - px) * W / pw)), max(0, math.floor((by0 - py) * H / ph))
            u1, v1 = min(W, math.ceil((bx1 - px) * W / pw)), min(H, math.ceil((by1 - py) * H / ph))
            if u0 < u1 and v0 < v1 and not (ax <= u0 and ay <= v0 and u1 <= ax + aw and v1 <= ay + ah):
                raise ValueError(f"{entry}: path {pid}: its view {v} does not cover its outline "
                                 f"(texels [{u0}, {u1}) x [{v0}, {v1}))")
        meets = [cr for cr in stored if cr[0] * S < ax + aw and (cr[0] + 1) * S > ax
                 and cr[1] * S < ay + ah and (cr[1] + 1) * S > ay]
        met.update(meets)
        fo = numbers(el.get("fill-opacity") or "1", 1)
        if fo is not None and fo[0] == 0.0 and meets:
            raise ValueError(f"{svg_entry}: textured path {pid} has fill-opacity 0 but {len(meets)} stored "
                             "cell(s) meet its view (\"ink is never hidden\")")
        if art.sb(el, "pencil-rgba") is not None and art.sb(el, "stroke-type") != "pencil":
            arc.warn(f"{svg_entry}: path {pid} carries sboardx:pencil-rgba but is not a pencil path")
    # Warnings (advice only).
    if not literal:
        arc.warn(f"{entry}: an integer is written with a fraction or an exponent (writers write plain literals)")
    unmet = sorted(set(stored) - met, key=lambda cr: (cr[1], cr[0]))
    if unmet:
        arc.warn(f"{entry}: {len(unmet)} stored cell(s) no view meets, e.g. {unmet[0]}")
    if not packed(order, stored, sizes, S):
        arc.warn(f"{entry}: the cells are not packed by the writer rule (SPEC \"Pages\")")
    for cr in order:
        k, sc, sr = stored[cr]
        arc.listed_slots.setdefault((pages[k], S), set()).add((sc, sr))
        if (sc, sr) not in arc.slot_ink(pages[k], S):
            arc.warn(f"{entry}: cell {cr} (slot {sc},{sr} of {pages[k]}) holds no ink; writers should omit it")


# ── Art SVG checks ───────────────────────────────────────────────────────

def check_art_svg(arc, data, where, art_dir, version):
    """Check one art SVG and return it parsed, or None for skipped 1.0/1.1 art.
    Gradients need >= 2 stops, their own or via one href."""
    why = syntax_problem(data) if version == "1.2" else None
    expect(not why, f"{where} {why}: 1.2 art has none (\"The art SVG's syntax\")")
    try:
        art = Art(data)
    except (SafeET.ParseError, defusedxml.DefusedXmlException) as e:
        expect(version != "1.2", f"{where} is not well-formed XML ({e})")
        arc.warn(f"{where} was not checked: it does not parse as XML without a document type declaration "
                 f"({type(e).__name__})")
        return None
    if version == "1.2":
        el = next((e for e in art.root.iter() if "transform" in e.attrib), None)
        expect(el is None, f"{where}: a <{local(el) if el is not None else ''}> carries a transform (1.2 art has none)")
    stops, hrefs, patterns = {}, {}, {}
    for g in art.root.iter():
        gid = g.get("id")
        if local(g) in ("linearGradient", "radialGradient") and gid is not None:
            stops[gid] = sum(1 for e in g.iter() if local(e) == "stop")
            h = g.get("href") or g.get(XLINK_HREF) or ""
            if h.startswith("#") and len(h) > 1:
                hrefs[gid] = h[1:]
        elif local(g) == "pattern" and gid is not None:
            patterns[gid] = check_pattern(arc, where, art, g, art_dir, version)
    seen_ids = set()
    for el in art.paths:
        pid = el.get("id")
        if pid is not None and version == "1.2":
            expect(pid not in seen_ids, f"{where}: two <path>s carry id=\"{pid}\" (ids are unique)")
            seen_ids.add(pid)
        prgba, v = art.sb(el, "pencil-rgba"), numbers(art.sb(el, "pencil-rgba"), 4)
        if prgba is not None and (v is None or not all(0.0 <= x <= 1.0 for x in v)):
            raise ValueError(f"{where}: sboardx:pencil-rgba {prgba!r} is not four numbers in 0..1")
        fill = (el.get("fill") or "").strip()
        gid = (m := URL_RE.match(fill)) and m.group(1)
        if gid is None:
            check_flat_paint(arc, where, art, el, fill, version)
        elif gid in patterns:
            if patterns[gid]:
                check_single_textured_path(where, art, el, gid)
        elif gid not in stops:
            raise ValueError(f"{where}: fill url(#{gid}) has no gradient or pattern definition")
        elif (stops[gid] or stops.get(hrefs.get(gid, ""), 0)) < 2:
            raise ValueError(f"{where}: gradient {gid} has fewer than 2 stops")
    return art


def check_pattern(arc, where, art, pat, art_dir, version):
    """A <pattern>. Tiled texture markers fail. The 1.1 single-image form
    ("Textured strokes in 1.1 files") fails in 1.2 art, else returns True.
    Anything else warns and returns False."""
    pid = pat.get("id")
    expect(art.sb(pat, "atlas-size") is None and art.sb(pat, "tile-size") is None and
           all(art.sb(e, "cell") is None for e in pat.iter() if e is not pat),
           f"{where}: pattern {pid} uses an unsupported tiled texture pattern (a 1.2 texture lives in the "
           "layer's texture file)")
    box = [numbers(pat.get(k), 1) for k in ("x", "y", "width", "height")]
    vb = numbers(pat.get("viewBox"), 4)
    img = next((e for e in pat.iter() if local(e) == "image"), None)
    if None in box or vb is None or box[2][0] <= 0 or box[3][0] <= 0 or img is None:
        arc.warn(f"{where}: pattern {pid} is no texture form; readers draw its paths flat")
        return False
    expect(version != "1.2", f"{where}: pattern {pid} is a 1.1 single-image texture: a 1.2 writer writes "
                             "the layer's texture file instead")
    href = img.get("href") or img.get(XLINK_HREF)
    expect(href is not None and not href.startswith("data:"), f"{where}: pattern {pid} has no image in the archive")
    target = posixpath.normpath(posixpath.join(art_dir, href))
    expect(target in arc.names, f"{where}: pattern {pid} image {href!r} is not in the archive")
    arc.referenced.add(target)
    return True


def check_flat_paint(arc, where, art, el, fill, version):
    """SPEC "Art SVG": fill is the 8-bit hex, fill-opacity the exact alpha,
    sboardx:rgba only when R, G or B isn't n/255. Just a warning before 1.2."""
    t = art.sb(el, "rgba")
    if t is None or not HEX_RE.match(fill):
        return
    v = numbers(t, 4)
    expect(v is not None and all(0.0 <= x <= 1.0 for x in v),
           f"{where}: sboardx:rgba {t!r} is not four numbers in 0..1")
    fo = numbers(el.get("fill-opacity") or "1", 1)
    problem = None
    if all(is_byte(c) for c in v[:3]):
        problem = f"sboardx:rgba {t!r} on an exact 8-bit colour (written only when R, G or B is not n/255)"
    elif hex_of(v[:3]).lower() != fill.lower():
        problem = f"fill {fill} is not the 8-bit hex of sboardx:rgba {t!r}"
    elif fo is None or fo[0] != v[3]:
        problem = f"fill-opacity {el.get('fill-opacity')!r} is not the alpha of sboardx:rgba {t!r}"
    expect(not problem or version != "1.2", f"{where}: {problem}")
    if problem:
        arc.warn(f"{where}: {problem}")


def check_single_textured_path(where, art, el, gid):
    """Path filled with a 1.1 single-image pattern: needs a valid sboardx:rgba
    (the flat fallback)."""
    rm = art.sb(el, "rgba")
    rgba = numbers(rm, 4)
    expect(rgba is not None and all(0.0 <= v <= 1.0 for v in rgba), f"{where}: pattern-filled path (url(#{gid})) " +
           ("lacks sboardx:rgba" if rm is None else f"sboardx:rgba {rm!r} is not four numbers in 0..1"))


# ── The archive ──────────────────────────────────────────────────────────

def zip64_problem(path):
    """Why the archive counts as ZIP64, or None. Looks for the end record's
    0xFFFF/0xFFFFFFFF markers and for a ZIP64 locator, which zipfile follows
    even without a marker."""
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        f.seek(max(0, f.tell() - 22 - 65535))
        tail = f.read()
    e = tail.rfind(b"PK\x05\x06", 0, len(tail) - 18)
    if e < 0:
        return None                  # zipfile reports it
    count, = struct.unpack_from("<H", tail, e + 10)
    cd_offset, = struct.unpack_from("<I", tail, e + 16)
    if count == 0xFFFF or cd_offset == 0xFFFFFFFF:
        return "its end record holds a ZIP64 marker"
    return "a ZIP64 locator precedes its end record" if tail[max(0, e - 20):e].startswith(b"PK\x06\x07") else None


def has_zip64_field(extra):
    """Whether a central-directory extra field has a ZIP64 record (id 1)."""
    i = 0
    while i + 4 <= len(extra):
        hid, size = struct.unpack_from("<HH", extra, i)
        if hid == 0x0001:
            return True
        i += 4 + size
    return False


def unique_ids(items, what):
    """The items' ids. Each must be a non-empty string, used once."""
    seen = set()
    for item in items:
        i = item.get("id")
        expect(isinstance(i, str) and i and i not in seen, f"{what} id {i!r} missing or duplicate")
        seen.add(i)
    return seen


def check(path):
    """Raises ValueError on the first problem; returns the warnings."""
    z = zipfile.ZipFile(path)
    arc = Archive(z)
    names = arc.names

    def need(name):
        expect(name in names, f"missing {name}")

    why = zip64_problem(path)
    expect(not why, f"the archive is ZIP64 ({why}); sboardx is a classic zip")
    for info in z.infolist():
        expect(not info.flag_bits & 1, f"{info.filename} is encrypted; sboardx is never encrypted")
        expect(info.compress_type == zipfile.ZIP_STORED, f"{info.filename} is compressed; sboardx is STORE-only")
        expect(not has_zip64_field(info.extra), f"{info.filename} carries a ZIP64 extra field in the central "
                                                "directory; sboardx is a classic zip")
    all_names = z.namelist()
    if len(all_names) != len(names):
        dup = next(n for n in all_names if all_names.count(n) > 1)
        raise ValueError(f"the archive holds {all_names.count(dup)} entries named {dup} (entry names are unique)")

    need("project.json")
    project = json.loads(z.read("project.json"))
    expect("x-the-storyboard-app" not in project,
           "pre-release archive: project.json carries x-the-storyboard-app (not sboardx at any version)")
    version = arc.version = project.get("sboardx")
    if version not in VERSIONS:
        m = re.match(r"^(\d+)\.(\d+)$", version if isinstance(version, str) else "")
        expect(not (m and (int(m.group(1)), int(m.group(2))) > (1, 2)),
               f"sboardx {version} is newer than this validator (1.0 to 1.2)")
        raise ValueError(f"unsupported version {version!r}")
    for k in ("width", "height", "fps"):
        expect(k in project["canvas"], f"project.json canvas.{k} missing")
    fps = project["canvas"]["fps"]
    expect(is_number(fps) and fps > 0 and fps == int(fps),
           f"project.json canvas.fps must be a positive whole number, got {fps!r}")
    layout = project["layer_layout"] if project.get("layer_layout") is not None else []
    expect(isinstance(layout, list), "project.json: layer_layout must be an array")
    for i, e in enumerate(layout):
        expect(isinstance(e, dict) and isinstance(e.get("name"), str),
               f"project.json: layer_layout[{i}] needs a string name")
        expect(e.get("kind", "vector") in ("vector", "group"),
               f"project.json: layer_layout[{i}] kind {e.get('kind')!r}")
        op = e.get("opacity", 100)
        expect(is_number(op) and 0 <= op <= 100, f"project.json: layer_layout[{i}] opacity {op!r}")

    need("sequence.json")
    seq = json.loads(z.read("sequence.json"))
    drawings = json.loads(z.read("shared/index.json")).get("drawings", []) if "shared/index.json" in names else []
    panel_layers = {}
    for pid in seq["panels"]:
        need(f"panels/{pid}/panel.json")
        need(f"panels/{pid}/layers.json")
        panel_layers[pid] = json.loads(z.read(f"panels/{pid}/layers.json"))["layers"]

    # Texture links first, so a file linked twice is caught up front.
    for d in drawings:
        if isinstance(d, dict) and "texture" in d:
            arc_link(arc, "shared/index.json", f"drawing {d.get('id')!r}", "shared", d["texture"])
    for pid, layers in panel_layers.items():
        for layer in layers:
            if "texture" in layer:
                arc_link(arc, f"panels/{pid}/layers.json", f"layer {layer.get('id')!r}", f"panels/{pid}",
                         layer["texture"])

    shared_ids = unique_ids(drawings, "shared/index.json: drawing")
    for d in drawings:
        did = d["id"]
        art = f"shared/{d.get('art', f'{did}/art.svg')}"
        expect(art in names, f"shared/index.json: {did} art {art} missing")
        svg = check_art_svg(arc, z.read(art), art, posixpath.dirname(art), version)
        if "texture" in d:
            check_texture(arc, f"shared/index.json: drawing {did}", d["texture"], "shared",
                          f"{did}/texture.json", svg, art)

    if "palettes.json" in names:
        pals = json.loads(z.read("palettes.json")).get("palettes", [])
        unique_ids(pals, "palettes.json: palette")
        for pal in pals:
            unique_ids(pal.get("colors", []), f"palettes.json: {pal['id']}: colour")
            for col in pal.get("colors", []):
                for k in ("r", "g", "b", "a"):
                    v = col.get(k, 1.0 if k == "a" else 0.0)
                    expect(is_number(v) and 0.0 <= v <= 1.0,
                           f"palettes.json: colour {col['id']} {k} out of 0..1 ({v!r})")

    expect(sorted(pid for s in seq["scenes"] for pid in s["panels"]) == sorted(seq["panels"]),
           "sequence.json: scenes do not partition panels")
    for s in seq["scenes"]:
        for track in s.get("layer_tracks", []):
            name = track.get("name")
            expect(isinstance(name, str) and name, f"scene {s['id']}: layer track without a name")
            expect(track.get("kind") in ("layer", "group"),
                   f"scene {s['id']}: layer track {name} has kind {track.get('kind')!r}")
            expect(all(isinstance(track.get("pivot", {}).get(k, 0.0), (int, float)) for k in ("x", "y")),
                   f"scene {s['id']}: layer track {name} pivot is not numeric")
            times = [k["t"] for k in track["keyframes"]]
            expect(times == sorted(times), f"scene {s['id']}: layer track {name} keyframes not sorted by t")
            for k in track["keyframes"]:
                expect(k.get("s", 1.0) > 0, f"layer keyframe {k.get('id')}: s must be > 0")
                expect(0 <= k.get("opacity", 1.0) <= 1, f"layer keyframe {k.get('id')}: opacity must be 0..1")

    # sequences (1.1): contiguous runs of scene ids, each scene in at most one.
    scene_ids = [s["id"] for s in seq["scenes"]]
    expect(len(set(scene_ids)) == len(scene_ids), "sequence.json: duplicate scene id")
    claimed = set()
    unique_ids(seq.get("sequences", []), "sequence.json: sequence")
    for q in seq.get("sequences", []):
        expect(q.get("scenes"), f"sequence {q['id']}: no scenes")
        for sid in q["scenes"]:
            expect(sid in scene_ids, f"sequence {q['id']}: unknown scene {sid!r}")
            expect(sid not in claimed, f"sequence {q['id']}: scene {sid!r} is in two sequences")
            claimed.add(sid)
        idx = [scene_ids.index(sid) for sid in q["scenes"]]
        expect(idx == list(range(idx[0], idx[0] + len(idx))),
               f"sequence {q['id']}: scenes are not a contiguous run in order")

    # sync (1.1). 1.2 bases are SHA-256 hex; in older files anything else
    # just isn't a base.
    sync = project["sync"] if project.get("sync") is not None else {}
    expect(isinstance(sync, dict) and isinstance(sync.get("panels", {}), dict),
           "project.json: sync must be an object with a panels object")
    for pid, base in sync.get("panels", {}).items():
        expect(pid in seq["panels"], f"project.json: sync.panels names unknown panel {pid!r}")
        expect(isinstance(base, str) and (version != "1.2" or DIGEST_RE.match(base)),
               f"project.json: sync.panels[{pid!r}] is not a 64-hex digest")

    for pid in seq["panels"]:
        layers = panel_layers[pid]
        layer_ids = {layer["id"] for layer in layers}
        for layer in layers:
            lid, sh, x = layer["id"], layer.get("shared"), layer.get("x-upshot", {})
            expect(sh is None or sh in shared_ids,
                   f"panels/{pid}/layers.json: layer {lid} shared {sh!r} is not in shared/index.json")
            art = f"panels/{pid}/{layer['art']}"
            need(art)
            if "image" in layer:
                need(layer["image"]["file"])
                arc.referenced.add(layer["image"]["file"])
                expect("texture" not in layer, f"panels/{pid}/layers.json: image layer {lid} has a texture "
                                               "(writers never write one on an image layer)")
            expect(isinstance(layer.get("group", ""), str), f"panel {pid}: layer {lid} group is not a string")
            # Derived layers (1.1) must point at layers of this panel.
            if isinstance(x, dict) and x.get("derived_from") is not None:
                expect(x["derived_from"] in layer_ids,
                       f"panel {pid}: layer {lid} derived from unknown layer {x['derived_from']!r}")
                expect(x.get("role") != "raster" or "image" in layer, f"panel {pid}: raster copy {lid} has no image")
            if isinstance(x, dict) and isinstance(x.get("split"), dict):
                expect(not layer.get("visible", True), f"panel {pid}: split source {lid} must be hidden")
                for role, copy in x["split"].items():
                    expect(role not in ("vector", "raster") or copy in layer_ids,
                           f"panel {pid}: split source {lid} names unknown {role} copy {copy!r}")
            svg = check_art_svg(arc, z.read(art), art, f"panels/{pid}/art", version)
            if "texture" in layer:
                check_texture(arc, f"panels/{pid}/layers.json: layer {lid}", layer["texture"],
                              f"panels/{pid}", f"art/{lid}.texture.json", svg, art)

    if "audio/clips.json" in names:
        clips = json.loads(z.read("audio/clips.json"))
        tracks = len(clips.get("tracks", [{}]))
        for c in clips["clips"]:
            if c.get("file"):
                need(f"audio/{c['file']}")
            expect(0 <= c.get("track", 0) < tracks, f"clip {c.get('id')} on track {c.get('track')} of {tracks}")

    # Archive-wide warnings.
    for n in sorted(names):
        if TEXTURE_ENTRY_RE.search(n) and n not in arc.links:
            arc.warn(f"{n} looks like a texture file but no layer or drawing links it (readers ignore it)")
    for (page, S), listed in sorted(arc.listed_slots.items()):
        extra = sorted(arc.slot_ink(page, S) - listed, key=lambda cr: (cr[1], cr[0]))
        if extra:
            arc.warn(f"page {page} has ink in {len(extra)} slot(s) no cell lists, e.g. slot {extra[0]}")
    for n in sorted(names):
        if n.startswith("images/") and not n.endswith("/") and n not in arc.referenced:
            arc.warn(f"{n} is referenced by nothing")
    return arc.warnings


def arc_link(arc, where, owner, base_dir, value):
    """Record one texture link. 1.2 only, and each file is linked once (a
    holder layer never links its drawing's file)."""
    expect(arc.version == "1.2", f"{where}: {owner} has a texture link, a 1.2 key, in an sboardx {arc.version} archive")
    entry = base_dir + "/" + value if isinstance(value, str) else None     # check_texture reports non-strings
    expect(entry not in arc.links, f"{entry} is linked twice: by {arc.links.get(entry)} and by {where} {owner} "
                                   "(one texture file per layer or drawing)")
    if entry is not None:
        arc.links[entry] = f"{where} {owner}"


def main(argv):
    global TEXTURE_SCHEMA
    if len(argv) < 2:
        sys.exit(__doc__)
    TEXTURE_SCHEMA = load_schema()
    failed = False
    for path in argv[1:]:
        try:
            warnings = check(path)
            print("ok  ", path)
            for w in warnings:
                print("warn", path, "-", w)
        except Exception as e:  # fail this file, keep going
            known = isinstance(e, (ValueError, KeyError, TypeError, AttributeError, IndexError, RecursionError,
                                  zipfile.BadZipFile))
            print("FAIL", path, "-", e if known and str(e) else f"{type(e).__name__}: {e}")
            failed = True
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main(sys.argv)
