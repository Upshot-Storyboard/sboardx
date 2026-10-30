// sboardx_common.js — helpers shared by sboardx_import.js, sboardx_export.js
// and sboardx_merge.js, the modules behind the TB_*.js entry points. Keep
// all seven files in the same folder. Needs Storyboard Pro 24 or newer.

// ── Log, prompts, progress ──────────────────────────────────────────────────

// `quiet` (batch): messages go to the Message Log, never to a dialog.
function makeLog(prefix, quiet) {
    var warnings = [];
    return {
        warnings: warnings,
        trace: function (msg) { MessageLog.trace(prefix + msg); },
        // Trace, not error: an error line makes Storyboard Pro pop the Message
        // Log window up, and the summary dialog repeats every warning anyway.
        warn: function (msg) { MessageLog.trace(prefix + "warning: " + msg); warnings.push(msg); },
        report: function (msg, isError) {
            if (quiet) MessageLog[isError ? "error" : "trace"](prefix + msg);
            else if (isError) MessageBox.critical(msg);
            else MessageBox.information(msg);
        },
        // The run's result: the counts, then every warning raised.
        summary: function (counts) {
            return warnings.length ? counts + "\n\nWarnings:\n- " + warnings.join("\n- ") : counts;
        }
    };
}

// An OK/Cancel prompt. Dialogs cannot be created in batch mode: callers
// decide without asking when quiet.
function confirm(title, text) {
    var d = new Dialog();
    d.title = title;
    var l = new Label();
    l.text = text;
    d.add(l);
    return !!d.exec();
}

// The script keeps the UI thread busy: repaint and drain pending events.
function pumpEvents(widget) {
    if (widget) widget.repaint();
    QCoreApplication.processEvents();
}

// A window-modal progress dialog with a Cancel button; every method is a
// no-op when quiet. The binding exposes Qt slots as methods and
// Q_PROPERTYs as plain properties.
function makeProgress(title, quiet) {
    var dlg = null, done = 0, total = 0;
    if (!quiet) {
        dlg = new QProgressDialog(title, "Cancel", 0, 100);
        dlg.setWindowTitle(title);
        dlg.windowModality = Qt.WindowModal;   // modal: setValue() pumps events
        dlg.setMinimumDuration(0);
        dlg.autoClose = false;
        dlg.autoReset = false;
        dlg.minimumWidth = 420;
        dlg.show();
        pumpEvents(dlg);
    }
    return {
        begin: function (n) {
            if (!dlg) return;
            done = 0; total = n;
            dlg.setRange(0, n); dlg.setValue(0); pumpEvents(dlg);
        },
        step: function (label) {
            if (!dlg) return;
            done++;
            dlg.setLabelText(done + " of " + total + " — " + label); dlg.setValue(done); pumpEvents(dlg);
        },
        busy: function (label) {
            if (!dlg) return;
            dlg.setLabelText(label); dlg.setRange(0, 0); pumpEvents(dlg);
        },
        cancelled: function () { return dlg ? dlg.wasCanceled === true : false; },
        close: function () {
            if (!dlg) return;
            var d = dlg;
            dlg = null;
            d.close(); d.deleteLater(); pumpEvents(null);
        }
    };
}

// The scripting API the bridge needs; false (with a message) on an older
// Storyboard Pro. Besides the documented managers (metadata and layer groups
// need 22.0.3, setExpandRenderAreaToArtworks needs 24) the scripts use the
// undocumented drawing API that ships with the "Import Vector File" feature
// of Storyboard Pro 24 and newer.
function requireApi(log) {
    var missing = [];
    function need(name, ok) { if (!ok) missing.push(name); }
    need("MotionManager", typeof MotionManager != "undefined");
    need("ImportManager", typeof ImportManager != "undefined");
    need("StoryboardManager.setPanelMetadata", typeof (new StoryboardManager()).setPanelMetadata == "function");
    need("LayerManager.addGroupLayer", typeof (new LayerManager()).addGroupLayer == "function");
    need("ExportManager.setExpandRenderAreaToArtworks", typeof (new ExportManager()).setExpandRenderAreaToArtworks == "function");
    need("importer.parseSVG", typeof importer != "undefined" && typeof importer.parseSVG == "function");
    need("Drawing.query.getData", typeof Drawing != "undefined" && !!Drawing.query && typeof Drawing.query.getData == "function");
    need("DrawingTools.createLayers", typeof DrawingTools != "undefined" && typeof DrawingTools.createLayers == "function");
    need("Tools.createDrawing", typeof Tools != "undefined" && typeof Tools.createDrawing == "function");
    need("element", typeof element != "undefined");
    need("PaletteObjectManager", typeof PaletteObjectManager != "undefined");
    need("QImage", typeof QImage != "undefined");
    need("QPainter", typeof QPainter != "undefined");
    if (!missing.length) return true;
    log.report("This script needs Storyboard Pro 24 or newer (missing: " + missing.join(", ") + ").", true);
    return false;
}

// ── Files and processes ─────────────────────────────────────────────────────

function readTextFile(path) {
    var f = new File(path);
    if (!f.exists) return null;
    f.open(FileAccess.ReadOnly);
    var text = f.read();
    f.close();
    return text;
}

function writeTextFile(path, text) {
    var f = new File(path);
    f.open(FileAccess.WriteOnly);
    f.write(text);
    f.close();
}

function readJsonFile(path) {
    var text = readTextFile(path);
    try { return text === null ? null : JSON.parse(text); } catch (e) { return null; }
}

function fileExists(path) { return new File(path).exists; }

function fileBasename(path) {
    var s = String(path).replace(/\\/g, "/");
    return s.substring(s.lastIndexOf("/") + 1);
}

function fileDirname(path) {
    var s = String(path).replace(/\\/g, "/");
    return s.substring(0, s.lastIndexOf("/"));
}

function makeTempDir(kind) {
    var dir = String(specialFolders.temp).replace(/\\/g, "/") + "/sboardx-" + kind + "-" + new Date().getTime();
    new Dir(dir).mkdirs();
    return dir;
}

function copyFile(src, dst) {
    try { new File(dst).remove(); } catch (e) {}
    return QFile.copy(src, dst);
}

function imageSize(path) {
    var im = new QImage(path);
    return im.isNull() ? null : { w: im.width(), h: im.height() };
}

// A file's bytes as an array of 0..255 (null when it cannot be opened).
function readFileBytes(path) {
    var f = new QFile(path);
    if (!f.open(QIODevice.ReadOnly)) return null;
    var ba = f.readAll();
    f.close();
    var n = ba.size(), out = new Array(n);
    for (var i = 0; i < n; i++) out[i] = ba.at(i) & 0xff;
    return out;
}

function xmlEscape(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function shQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
// For a line in a .cmd script: Windows paths never contain a quote, and %
// is doubled so the script does not expand it.
function cmdQuote(s) { return '"' + String(s).replace(/%/g, "%%") + '"'; }

// Runs a command (program + arguments) through the shell and waits for it,
// pumping events so a progress dialog stays live; stderr goes to logPath.
// isCancelled() (the dialog's Cancel button) terminates the process.
// Returns { code, cancelled, stderr }: code 0 is a clean exit.
// On Windows the command goes in a .cmd script beside logPath: a quoted
// command line handed to `cmd /c` loses its outer quotes (and Process2
// escapes the inner ones), so tar would never start.
function runProcess(args, logPath, isCancelled) {
    var p;
    if (about.isWindowsArch()) {
        var script = String(logPath).replace(/\.log$/, "") + ".cmd";
        writeTextFile(script, "@chcp 65001 >nul\r\n@" + args.map(cmdQuote).join(" ") + " 2>" + cmdQuote(logPath) + "\r\n");
        p = new Process2("cmd", "/c", script.replace(/\//g, "\\"));
    } else {
        p = new Process2("sh", "-c", args.map(shQuote).join(" ") + " 2>" + shQuote(logPath));
    }
    var launched = p.launch();
    while (p.isAlive()) {
        System.processOneEvent();
        if (isCancelled && isCancelled()) {
            p.terminate();
            return { code: -1, cancelled: true, stderr: "" };
        }
    }
    var code = p.errorCode() || launched;
    var stderr = code ? String(readTextFile(logPath) || "").replace(/^\s+|\s+$/g, "") : "";
    return { code: code, cancelled: false, stderr: stderr };
}

function processFailure(name, r) {
    return name + " failed with code " + r.code + (r.stderr ? ": " + r.stderr : "");
}

function extractZip(zipPath, destPath, log) {
    new Dir(destPath).mkdirs();
    var r = runProcess(["tar", "-xf", zipPath, "-C", destPath], destPath + "/tar.log");
    if (fileExists(destPath + "/project.json")) return true;
    log.warn(processFailure("tar", r));
    return false;
}

// A STORE-only zip of `entries` under stagingDir. Throws
// { sboardxCancelled: true } when isCancelled() stops it.
function createStoreZip(stagingDir, entries, zipPath, log, isCancelled) {
    try { new File(zipPath).remove(); } catch (e) {}
    if (fileExists(zipPath)) {
        log.warn("could not delete the existing " + zipPath + " (is it open in another program?)");
        return false;
    }
    var args = ["tar", "--format=zip", "--options", "zip:compression=store", "-cf", zipPath, "-C", stagingDir].concat(entries);
    var r = runProcess(args, stagingDir + "/tar.log", isCancelled);
    if (r.cancelled) {
        try { new File(zipPath).remove(); } catch (e1) {}
        throw { sboardxCancelled: true };
    }
    if (fileExists(zipPath)) return true;
    log.warn(processFailure("tar", r));
    return false;
}

// ── Storyboard Pro project helpers ──────────────────────────────────────────

// fn(sceneId, panelId, sceneIndex, panelIndex) for every panel, in order.
function forEachPanel(sb, fn) {
    for (var s = 0; s < sb.numberOfScenesInProject(); s++) {
        var sceneId = String(sb.sceneInProject(s));
        for (var p = 0; p < sb.numberOfPanelsInScene(sceneId); p++) {
            fn(sceneId, String(sb.panelInScene(sceneId, p)), s, p);
        }
    }
}

function countPanels(sb) {
    var n = 0;
    forEachPanel(sb, function () { n++; });
    return n;
}

function findPanelCaption(cm, wantedName) {
    for (var i = 0; i < cm.numberOfPanelCaptions(); i++) {
        var name = cm.nameOfPanelCaption(i);
        if (String(name).toLowerCase() === wantedName.toLowerCase()) return name;
    }
    return null;
}

function ensurePanelCaption(cm, wantedName) {
    var found = findPanelCaption(cm, wantedName);
    if (found) return found;
    cm.addPanelCaption(wantedName);
    return wantedName;
}

function metaRecord(name, value) {
    return { name: name, type: "string", creator: "sboardx", version: "1.0", value: value };
}

function metaValue(meta) {
    var raw = (meta && meta.value !== undefined) ? meta.value : meta;
    return raw ? String(raw) : "";
}

function panelMetaValue(sb, panelId, name) {
    try { return metaValue(sb.getPanelMetadata(panelId, name)); } catch (e) { return ""; }
}

function setPanelMeta(sb, panelId, name, value) {
    sb.setPanelMetadata(panelId, metaRecord(name, value));
}

// Drawings are read from the project's saved files (Drawing.query.getData by
// file name): the export and the update save first — after asking in a
// session, unconditionally in batch. False when declined or the save failed.
function ensureProjectSaved(log, quiet, what) {
    if (project.isDirty() !== true) return true;
    if (!quiet && !confirm("Unsaved changes",
            "The project has unsaved changes.\n\n" + what + " reads each drawing from the project's " +
            "saved files: drawings drawn, edited or shared since the last save would come out empty " +
            "or out of date.\n\nSave the project now and continue?")) return false;
    if (project.saveAll() === false) {
        log.warn("the project could not be saved");
        return false;
    }
    return true;
}

// Storyboard Pro's default layers for a new panel are the user preference
// DEFAULT_LAYERS: records of 8 ';'-separated fields separated by an empty
// field — "A;1;0;13;0;100;0;0;;;BG;1;1;13;0;100;0;0;". Field 0 is the name,
// 1 the visibility, 5 the opacity; the others are written as a plain layer's.
function parseDefaultLayers(text) {
    var out = [];
    var tokens = String(text || "").split(";");
    var i = 0;
    while (i + 8 <= tokens.length) {
        if (tokens[i] === "") { i++; continue; }
        var rec = tokens.slice(i, i + 8);
        var op = parseInt(rec[5], 10);
        out.push({ name: rec[0], kind: "vector", visible: rec[1] !== "0", locked: false,
                   opacity: isNaN(op) ? 100 : Math.max(0, Math.min(100, op)), group: "" });
        i += 8;
    }
    return out;
}

function formatDefaultLayers(entries) {
    return entries.map(function (e) {
        var op = Math.round(Math.max(0, Math.min(100, Number(e.opacity === undefined ? 100 : e.opacity))));
        return e.name + ";" + (e.visible === false ? "0" : "1") + ";0;13;0;" + op + ";0;0;";
    }).join(";");
}

// Storyboard Pro sanitises layer names to node names: every character
// outside [A-Za-z0-9_-] becomes "_". Layer tracks are keyed by name, so
// both directions match through this.
function sbpNodeName(name) {
    return String(name).replace(/[^A-Za-z0-9_\-]/g, "_");
}

// ── Colours ─────────────────────────────────────────────────────────────────

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function to255(v) { return Math.round(clamp01(Number(v) || 0) * 255); }

function colorHex(c) {
    function h(v) {
        var s = Math.max(0, Math.min(255, Math.round(v))).toString(16);
        return s.length < 2 ? "0" + s : s;
    }
    return "#" + h(c.r) + h(c.g) + h(c.b);
}

// FNV-1a 32-bit hex over the string's code units: the bridge's name/id
// hash (shared drawing ids, texture and gradient colour names).
function fnv32Hex(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h * 16777619) >>> 0;
    }
    return ("00000000" + h.toString(16)).slice(-8);
}

// ── Camera and layer animation ──────────────────────────────────────────────

function cameraFields(frameH) {
    var perWorldY = project.numberOfUnitsY() / frameH;
    var perWorldX = perWorldY * 3 / 4;
    try {
        var ax = project.unitsAspectRatioX(), ay = project.unitsAspectRatioY();
        if (ax > 0 && ay > 0) perWorldX = perWorldY * ay / ax;
    } catch (e) {}
    return { perWorldX: perWorldX, perWorldY: perWorldY };
}

// A layer's animation functions run on real 1-based panel frames (frame 1 =
// the panel's start), like the camera's. The layer node is "Top/<name>";
// its offset is a 3-D path in the camera peg's field units (cameraFields),
// scale and rotation are bezier columns. Opacity has no function column.

// Seconds within a panel <-> the panel's 1-based frame (clamped to its span).
function panelTimeToFrame(tInPanel, panelFrames, fps) {
    return Math.max(1, Math.min(panelFrames, Math.round(tInPanel * fps) + 1));
}
function panelFrameToTime(frame, fps) {
    return (frame - 1) / fps;
}

function wrapDeg(d) {
    return ((d + 180) % 360 + 360) % 360 - 180;
}

// The sboardx pose interpolation (SPEC.md "layer_tracks"): hold at both
// ends, smoothstep, geometric scale, linear tx/ty/opacity, shortest-arc
// rotation. `kfs` sorted by t; scene-local seconds.
function layerPoseAt(kfs, t) {
    function pose(k) {
        return {
            tx: Number(k.tx) || 0, ty: Number(k.ty) || 0,
            s: (typeof k.s === "number" && k.s > 0) ? k.s : 1,
            rot: Number(k.rot) || 0,
            opacity: (typeof k.opacity === "number") ? clamp01(k.opacity) : 1
        };
    }
    if (!kfs || !kfs.length) return { tx: 0, ty: 0, s: 1, rot: 0, opacity: 1 };
    if (t <= kfs[0].t) return pose(kfs[0]);
    if (t >= kfs[kfs.length - 1].t) return pose(kfs[kfs.length - 1]);
    var i = 0;
    while (i + 2 < kfs.length && kfs[i + 1].t <= t) i++;
    var a = pose(kfs[i]), b = pose(kfs[i + 1]);
    var span = kfs[i + 1].t - kfs[i].t;
    var raw = span > 1e-9 ? clamp01((t - kfs[i].t) / span) : 1;
    var f = raw * raw * (3 - 2 * raw);
    return {
        tx: a.tx + (b.tx - a.tx) * f,
        ty: a.ty + (b.ty - a.ty) * f,
        s: Math.exp(Math.log(a.s) + (Math.log(b.s) - Math.log(a.s)) * f),
        rot: wrapDeg(a.rot + wrapDeg(b.rot - a.rot) * f),
        opacity: a.opacity + (b.opacity - a.opacity) * f
    };
}

// sboardx pose about a pivot -> SBP layer offset/scale/rotation with the
// pivot folded in (p' = c + T + S·R(p − c) == a pivot-at-origin pose with
// T' = c + T − S·R·c). World y is down and SBP's is up; a positive sboardx
// rotation is clockwise on screen, SBP's counter-clockwise.
function poseToSbp(pose, px, py, fields) {
    var r = pose.rot * Math.PI / 180;
    var a = pose.s * Math.cos(r), b = pose.s * Math.sin(r);
    var c = -b, d = a;
    var tx = px + pose.tx - (a * px + c * py);
    var ty = py + pose.ty - (b * px + d * py);
    return { x: tx * fields.perWorldX, y: -ty * fields.perWorldY, scale: pose.s, angle: -pose.rot };
}
function sbpToPose(x, y, scale, angle, fields) {
    return { tx: x / fields.perWorldX, ty: -y / fields.perWorldY,
             s: scale > 0 ? scale : 1, rot: wrapDeg(-angle), opacity: 1 };
}

function isIdentityPose(p) {
    return Math.abs(p.tx) < 1e-6 && Math.abs(p.ty) < 1e-6 && Math.abs(p.s - 1) < 1e-6 &&
           Math.abs(wrapDeg(p.rot)) < 1e-6 && Math.abs(p.opacity - 1) < 1e-6;
}

// ── Merge: the panel digest and the id map (SPEC.md "Merging") ──────────────

// FNV-1a 64 in two 32-bit halves (JavaScript has no 64-bit integers): the
// hash Upshot's core and sbp-plugin/tests/panel_digest.py compute, pinned
// by core/tests/fixtures/merge/digest_vectors.json.
function Fnv1a64() {
    this.hi = 0xcbf29ce4;
    this.lo = 0x84222325;
}
Fnv1a64.prototype.byte = function (b) {
    this.lo = (this.lo ^ (b & 0xff)) >>> 0;
    // The prime is 2^40 + 0x1b3; every product below is exact in a double.
    var p = this.lo * 0x1b3;
    var carry = Math.floor(p / 4294967296);
    this.hi = (((this.hi * 0x1b3) % 4294967296) + ((this.lo << 8) >>> 0) + carry) % 4294967296;
    this.lo = p - carry * 4294967296;
};
Fnv1a64.prototype.bytes = function (arr) {
    for (var i = 0; i < arr.length; i++) this.byte(arr[i]);
};
Fnv1a64.prototype.text = function (s) {
    this.bytes(utf8Bytes(s));
};
Fnv1a64.prototype.hex = function () {
    function h8(v) { return ("00000000" + (v >>> 0).toString(16)).slice(-8); }
    return h8(this.hi) + h8(this.lo);
};

function utf8Bytes(s) {
    var out = [];
    s = String(s);
    for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
            var d = s.charCodeAt(i + 1);
            if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
        }
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
}

// panel.json without its `code` member (PanelDigest.hpp's byte rule: the
// first "code" key with a string value, with the comma after it, else the
// comma before it).
function stripCodeMember(bytes) {
    var s = String.fromCharCode.apply(null, bytes);
    var m = /"code"[ \t\n\r]*:[ \t\n\r]*"(?:[^"\\]|\\.)*"/.exec(s);
    if (!m) return bytes;
    var start = m.index, end = start + m[0].length;
    var after = /^[ \t\n\r]*,/.exec(s.substring(end));
    if (after) end += after[0].length;
    else {
        var before = /,[ \t\n\r]*$/.exec(s.substring(0, start));
        if (before) start = before.index;
    }
    return bytes.slice(0, start).concat(bytes.slice(end));
}

// The archive digest of one panel over an extracted archive (or a staging
// folder with the same layout): entry name, 0x00, bytes, 0x00 — an absent
// entry hashes as name, 0x00, 0xFF.
function archivePanelDigest(rootDir, pid) {
    var f = new Fnv1a64();
    function entry(name, transform) {
        f.text(name);
        f.byte(0);
        var bytes = fileExists(rootDir + "/" + name) ? readFileBytes(rootDir + "/" + name) : null;
        if (!bytes) { f.byte(0xff); return; }
        f.bytes(transform ? transform(bytes) : bytes);
        f.byte(0);
    }
    var base = "panels/" + pid + "/";
    entry(base + "panel.json", stripCodeMember);
    entry(base + "layers.json");
    var lj = readJsonFile(rootDir + "/" + base + "layers.json");
    var layers = (lj && lj.layers) || [];
    for (var i = 0; i < layers.length; i++) {
        var l = layers[i];
        if (!l || typeof l !== "object") continue;
        if (l.art) entry(base + l.art);
        if (l.image && l.image.file) entry(String(l.image.file));
        var atlas = "images/" + pid + "_" + l.id + "_pencil.png";
        if (l.id && fileExists(rootDir + "/" + atlas)) entry(atlas);
    }
    return f.hex();
}

// The project-level id map ("sboardx-ids" project metadata, JSON):
//   { v: 1,
//     panels: { <native panel id>: { id: <archive id>,
//                                    digest: <archive digest of the panel at the last exchange>,
//                                    local: <digest of the panel's own exported form then> } },
//     scenes: { <native scene id>: <archive scene id> } }
// Keyed by native ids, so a duplicated panel is a new panel. Projects
// imported by older scripts carry the ids as "sboardx-id" panel metadata
// ("sboardx-scene-id" on a scene's first panel): lifted into the map here,
// with no baseline (a question on the first merge).
function loadIdMap(sb, log) {
    var map = { v: 1, panels: {}, scenes: {} };
    var raw = "";
    try { raw = metaValue(sb.getProjectMetadata("sboardx-ids")); } catch (e) {}
    if (raw) {
        try {
            var parsed = JSON.parse(raw);
            map.panels = parsed.panels || {};
            map.scenes = parsed.scenes || {};
        } catch (e2) {
            log.warn("the project's sboardx-ids metadata is not JSON; the merge baselines start over");
        }
    }
    var seen = {}, live = { panels: {}, scenes: {} };
    for (var k in map.panels) if (map.panels.hasOwnProperty(k)) seen[map.panels[k].id] = true;
    forEachPanel(sb, function (sceneId, pid, s, p) {
        live.scenes[sceneId] = live.panels[pid] = true;
        if (p === 0 && !map.scenes.hasOwnProperty(sceneId)) {
            var sid = panelMetaValue(sb, pid, "sboardx-scene-id");
            if (sid) map.scenes[sceneId] = sid;
        }
        if (map.panels.hasOwnProperty(pid)) return;
        var src = panelMetaValue(sb, pid, "sboardx-id");
        if (src && !seen[src]) {   // the first holder keeps a copied id
            map.panels[pid] = newIdEntry(src);
            seen[src] = true;
        }
    });
    // Entries of deleted panels and scenes are dropped.
    ["panels", "scenes"].forEach(function (kind) {
        for (var id in map[kind]) if (map[kind].hasOwnProperty(id) && !live[kind][id]) delete map[kind][id];
    });
    return map;
}

function saveIdMap(sb, map) {
    sb.setProjectMetadata(metaRecord("sboardx-ids", JSON.stringify({ v: 1, panels: map.panels, scenes: map.scenes })));
}

function newIdEntry(id) {
    return { id: id, digest: "", local: "" };
}

// A native panel's archive id: the map's, else its own (a Toon Boom-born panel).
function archiveIdOf(map, pid) {
    var e = map.panels[pid];
    return e && e.id ? String(e.id) : String(pid);
}

exports.makeLog = makeLog;
exports.confirm = confirm;
exports.pumpEvents = pumpEvents;
exports.makeProgress = makeProgress;
exports.requireApi = requireApi;
exports.readTextFile = readTextFile;
exports.writeTextFile = writeTextFile;
exports.readJsonFile = readJsonFile;
exports.fileExists = fileExists;
exports.fileBasename = fileBasename;
exports.fileDirname = fileDirname;
exports.makeTempDir = makeTempDir;
exports.copyFile = copyFile;
exports.imageSize = imageSize;
exports.readFileBytes = readFileBytes;
exports.xmlEscape = xmlEscape;
exports.runProcess = runProcess;
exports.extractZip = extractZip;
exports.createStoreZip = createStoreZip;
exports.forEachPanel = forEachPanel;
exports.countPanels = countPanels;
exports.findPanelCaption = findPanelCaption;
exports.ensurePanelCaption = ensurePanelCaption;
exports.metaRecord = metaRecord;
exports.panelMetaValue = panelMetaValue;
exports.setPanelMeta = setPanelMeta;
exports.ensureProjectSaved = ensureProjectSaved;
exports.parseDefaultLayers = parseDefaultLayers;
exports.formatDefaultLayers = formatDefaultLayers;
exports.sbpNodeName = sbpNodeName;
exports.clamp01 = clamp01;
exports.to255 = to255;
exports.colorHex = colorHex;
exports.fnv32Hex = fnv32Hex;
exports.cameraFields = cameraFields;
exports.panelTimeToFrame = panelTimeToFrame;
exports.panelFrameToTime = panelFrameToTime;
exports.wrapDeg = wrapDeg;
exports.layerPoseAt = layerPoseAt;
exports.poseToSbp = poseToSbp;
exports.sbpToPose = sbpToPose;
exports.isIdentityPose = isIdentityPose;
exports.Fnv1a64 = Fnv1a64;
exports.archivePanelDigest = archivePanelDigest;
exports.loadIdMap = loadIdMap;
exports.saveIdMap = saveIdMap;
exports.newIdEntry = newIdEntry;
exports.archiveIdOf = archiveIdOf;
