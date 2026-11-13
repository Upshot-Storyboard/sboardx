// sboardx_common.js: helpers shared by the import, export and merge modules.
// Keep all seven files in the same folder. Needs Storyboard Pro 24+.

// ── Log, prompts, progress ──────────────────────────────────────────────────

// quiet (batch): everything goes to the Message Log, no dialogs.
function makeLog(prefix, quiet) {
    var warnings = [];
    return {
        warnings: warnings,
        trace: function (msg) { MessageLog.trace(prefix + msg); },
        // trace, not error: error pops up the Message Log window, and the
        // summary repeats the warnings anyway.
        warn: function (msg) { MessageLog.trace(prefix + "warning: " + msg); warnings.push(msg); },
        report: function (msg, isError) {
            if (quiet) MessageLog[isError ? "error" : "trace"](prefix + msg);
            else if (isError) MessageBox.critical(msg);
            else MessageBox.information(msg);
        },
        summary: function (counts) {
            return warnings.length ? counts + "\n\nWarnings:\n- " + warnings.join("\n- ") : counts;
        }
    };
}

// OK/Cancel prompt. Not available in batch, callers skip it when quiet.
function confirm(title, text) {
    var d = new Dialog();
    d.title = title;
    var l = new Label();
    l.text = text;
    d.add(l);
    return !!d.exec();
}

// We hog the UI thread, so repaint and drain events now and then.
function pumpEvents(widget) {
    if (widget) widget.repaint();
    QCoreApplication.processEvents();
}

// Window-modal progress dialog with Cancel. No-op when quiet. Qt slots are
// methods here, Q_PROPERTYs plain properties.
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
            dlg.setLabelText(done + " of " + total + ": " + label); dlg.setValue(done); pumpEvents(dlg);
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

// False (with a message) when the Storyboard Pro is too old. Metadata and
// layer groups need 22.0.3, setExpandRenderAreaToArtworks needs 24, and the
// undocumented drawing API comes with 24's "Import Vector File".
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

// False in -batch. layerOpacity without a frame needs a current frame, which
// batch lacks ("MISSING SESSION, ABORT!"). about.isInteractiveApp() is true
// even in -batch, so it's useless here.
function hasGuiSession(sb, lm) {
    try {
        lm.layerOpacity(String(sb.panelInScene(String(sb.sceneInProject(0)), 0)), 0);
        return true;
    } catch (e) {
        return false;
    }
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

// Parsed JSON or null. Drops a leading BOM like the other readers do, or the
// digest would miss that layers.json's layers.
function readJsonFile(path) {
    var text = readTextFile(path);
    if (text !== null && String(text).charCodeAt(0) === 0xfeff) text = String(text).substring(1);
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

// The file as a QByteArray (null if it can't be opened), for hashing natively.
function readFileByteArray(path) {
    var f = new QFile(path);
    if (!f.open(QIODevice.ReadOnly)) return null;
    var ba = f.readAll();
    f.close();
    return ba;
}

// The file as an array of 0..255, or null. Goes through one toBase64() and a
// table decode: much faster than QByteArray.at() per byte.
var BASE64_VALUE = (function () {
    var t = [], a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (var i = 0; i < 128; i++) t[i] = 0;
    for (var j = 0; j < 64; j++) t[a.charCodeAt(j)] = j;
    return t;
})();
function readFileBytes(path) {
    return byteArrayBytes(readFileByteArray(path));
}

function byteArrayBytes(ba) {
    if (!ba) return null;
    var n = ba.size();
    return n ? base64Bytes(String(ba.toBase64().toString()), n) : new Array(0);
}

// First n bytes of base64 s (no line breaks, "=" padded).
function base64Bytes(s, n) {
    var out = new Array(n);
    if (!n) return out;
    var T = BASE64_VALUE, o = 0, i = 0, v;
    for (var whole = n - n % 3; o < whole; i += 4) {
        v = (T[s.charCodeAt(i)] << 18) | (T[s.charCodeAt(i + 1)] << 12) | (T[s.charCodeAt(i + 2)] << 6) | T[s.charCodeAt(i + 3)];
        out[o++] = v >>> 16;
        out[o++] = (v >>> 8) & 255;
        out[o++] = v & 255;
    }
    if (o < n) {   // the last one or two bytes: "xx==" / "xxx="
        v = (T[s.charCodeAt(i)] << 18) | (T[s.charCodeAt(i + 1)] << 12) | (T[s.charCodeAt(i + 2)] << 6);
        out[o++] = v >>> 16;
        if (o < n) out[o++] = (v >>> 8) & 255;
    }
    return out;
}

// Text for XML: & < > " escaped, tab, LF and CR as character references,
// the other C0 controls dropped (XML 1.0 allows them in no form).
function xmlEscape(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
        .replace(/\t/g, "&#9;").replace(/\n/g, "&#10;").replace(/\r/g, "&#13;").replace(/[\x00-\x1f]/g, "");
}

function shQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
// .cmd quoting: paths never hold a quote, % is doubled.
function cmdQuote(s) { return '"' + String(s).replace(/%/g, "%%") + '"'; }

// Runs args through the shell, pumping events, stderr to logPath. Returns
// { code, cancelled, stderr }. On Windows it goes through a .cmd file:
// `cmd /c` drops the outer quotes and Process2 escapes the inner ones.
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

// Windows: System32\tar.exe (bsdtar) by full path. A GNU tar on PATH (Git
// for Windows, MSYS2, Cygwin) can't write zip and reads "C:\..." as a
// remote host. macOS: plain "tar".
function tarProgram() {
    if (!about.isWindowsArch()) return "tar";
    var root = "";
    try { root = String(System.getenv("SystemRoot") || System.getenv("windir") || ""); } catch (e) {}
    if (root) {
        var exe = root.replace(/\//g, "\\").replace(/\\+$/, "") + "\\System32\\tar.exe";
        if (fileExists(exe)) return exe;
    }
    return "tar";
}

function extractZip(zipPath, destPath, log) {
    new Dir(destPath).mkdirs();
    var r = runProcess([tarProgram(), "-xf", zipPath, "-C", destPath], destPath + "/tar.log");
    if (fileExists(destPath + "/project.json")) return true;
    log.warn(processFailure("tar", r));
    return false;
}

// STORE-only zip. Throws { sboardxCancelled: true } on cancel.
function createStoreZip(stagingDir, entries, zipPath, log, isCancelled) {
    try { new File(zipPath).remove(); } catch (e) {}
    if (fileExists(zipPath)) {
        log.warn("could not delete the existing " + zipPath + " (is it open in another program?)");
        return false;
    }
    var args = [tarProgram(), "--format=zip", "--options", "zip:compression=store", "-cf", zipPath, "-C", stagingDir].concat(entries);
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

// getData reads drawings from the saved files, and the backup copies them,
// so save first (asks in a session, just saves in batch). `why` overrides
// the prompt's reason. False if declined or the save failed.
function ensureProjectSaved(log, quiet, what, why) {
    if (project.isDirty() !== true) return true;
    if (!quiet && !confirm("Unsaved changes",
            "The project has unsaved changes.\n\n" + (why || (what + " reads each drawing from the project's " +
            "saved files: drawings drawn, edited or shared since the last save would come out empty " +
            "or out of date.")) + "\n\nSave the project now and continue?")) return false;
    if (project.saveAll() === false) {
        log.warn("the project could not be saved");
        return false;
    }
    return true;
}

// ── Project backup (before an import or an update changes anything) ─────────
//
// Copies the saved project folder to <folder>_sboardx-backup-<stamp> beside
// it (fallback: ~/Documents/sboardx-backups/), robocopy on Windows, ditto on
// macOS. Left out: the session's .sboard.lock (else opening the backup asks
// whether the project is in use) and, on Windows, junctions and symlinks
// (/XJ, counted). PALETTE_LIST links are absolute paths, so the copy's are
// re-pointed at its own palettes. Keeps BACKUP_KEEP backups, never pruning
// one that's open or was saved in (backupInUse). The project itself is only
// read. Returns { ok: true, dir, bytes, files, ms, pruned, inUse, leftOut }
// or { ok: false, message } (partial copy deleted).

var BACKUP_INFIX = "_sboardx-backup-";
var BACKUP_KEEP = 5;
var BACKUP_TIMEOUT_MS = 2 * 3600 * 1000;

function pad2(n) { return (n < 10 ? "0" : "") + n; }

function backupStamp(d) {
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + "-" +
           pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}

function regexEscape(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// New empty <folder>/<base>, or <base>-2, -3... if taken. null on failure.
function newBackupFolder(folder, base) {
    for (var i = 1; i <= 50; i++) {
        var p = folder + "/" + base + (i > 1 ? "-" + i : "");
        if (new Dir(p).exists || new File(p).exists) continue;
        new Dir(p).mkdirs();
        return new Dir(p).exists ? p : null;
    }
    return null;
}

// QProcess because Process2 can't read output. Pumps events, cancellable.
function runQProcess(program, args, isCancelled, timeoutMs) {
    var q = new QProcess(), t0 = new Date().getTime();
    var r = { started: false, code: -1, normal: false, cancelled: false, timedOut: false, out: "", err: "", ms: 0 };
    q.start(program, args);
    r.started = q.waitForStarted(30000) === true;
    if (!r.started) {
        r.err = String(q.errorString ? q.errorString() : q.error());
        r.ms = new Date().getTime() - t0;
        return r;
    }
    while (!q.waitForFinished(200)) {
        var st = String(q.state());
        if (st === "NotRunning" || st === "0") break;   // finished between two waits
        QCoreApplication.processEvents();
        if (isCancelled && isCancelled()) { r.cancelled = true; q.kill(); q.waitForFinished(5000); break; }
        if (new Date().getTime() - t0 > timeoutMs) { r.timedOut = true; q.kill(); q.waitForFinished(5000); break; }
    }
    var out = q.readAllStandardOutput(), err = q.readAllStandardError();
    r.out = String(out.toString ? out.toString() : out);
    r.err = String(err.toString ? err.toString() : err);
    r.code = q.exitCode();
    r.normal = String(q.exitStatus()) === "NormalExit" || String(q.exitStatus()) === "0";
    r.ms = new Date().getTime() - t0;
    return r;
}

// robocopy's summary, read by position since the labels are localized.
// The rows with six integers are Dirs, Files, Bytes (with /BYTES).
function robocopySummary(lines) {
    var rows = [];
    lines.forEach(function (l) {
        var m = /^\s*[^\s\d:][^:]*:\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(l);
        if (m) rows.push(m.slice(1).map(Number));
    });
    if (rows.length < 3) return null;
    function row(r) { return { total: r[0], copied: r[1], skipped: r[2], failed: r[4] }; }
    return { dirs: row(rows[0]), files: row(rows[1]), bytes: row(rows[2]) };
}

// Up to 6 robocopy error lines plus the message after each. "ERROR" is
// localized, so match the "32 (0x00000020)" part.
function robocopyErrors(lines) {
    var errs = [];
    lines.forEach(function (l, i) {
        if (/\s\d+ \(0x[0-9A-Fa-f]{8}\)\s/.test(l) && errs.length < 6) {
            errs.push(l.replace(/^\s+|\s+$/g, "") + (lines[i + 1] ? ": " + lines[i + 1].replace(/^\s+|\s+$/g, "") : ""));
        }
    });
    return errs;
}

// Copies src into the existing, empty dst.
function copyProjectTree(src, dst, isCancelled) {
    var res = { ok: false, bytes: -1, files: -1, leftOut: 0, detail: "", cancelled: false };
    var r;
    if (about.isWindowsArch()) {
        // Exit codes 0-7 are success, 8+ means something wasn't copied.
        // /XJ skips links: following one could copy a whole server share
        // (or loop), and copying links needs admin. Into an empty dst every
        // skip is a link (minus the root itself).
        r = runQProcess("robocopy", [src.replace(/\//g, "\\"), dst.replace(/\//g, "\\"),
                        "/E", "/R:0", "/W:0", "/XJ", "/NP", "/NFL", "/NDL", "/BYTES"], isCancelled, BACKUP_TIMEOUT_MS);
        var lines = r.out.split(/\r?\n/);
        var sum = robocopySummary(lines);
        if (sum) {
            res.bytes = sum.bytes.total;
            res.files = sum.files.total;
            res.leftOut = Math.max(0, sum.dirs.skipped - 1) + sum.files.skipped;
        }
        res.ok = r.started && r.normal && !r.cancelled && !r.timedOut && r.code >= 0 && r.code < 8;
        if (!res.ok) {
            var errs = robocopyErrors(lines);
            res.detail = !r.started ? "robocopy could not be started (" + r.err + ")" :
                         r.timedOut ? "robocopy did not finish within " + Math.round(BACKUP_TIMEOUT_MS / 60000) + " minutes" :
                         "robocopy exit code " + r.code + (errs.length ? ":\n" + errs.join("\n") : "");
        }
    } else {
        r = runQProcess("ditto", [src, dst], isCancelled, BACKUP_TIMEOUT_MS);
        res.ok = r.started && r.normal && !r.cancelled && !r.timedOut && r.code === 0;
        if (res.ok) {
            var du = runQProcess("du", ["-sk", dst], null, 600000);
            var k = /^\s*(\d+)/.exec(du.out);
            if (k) res.bytes = Number(k[1]) * 1024;
        } else {
            res.detail = !r.started ? "ditto could not be started (" + r.err + ")" :
                         r.timedOut ? "ditto did not finish within " + Math.round(BACKUP_TIMEOUT_MS / 60000) + " minutes" :
                         "ditto exit code " + r.code + (r.err ? ": " + r.err.replace(/^\s+|\s+$/g, "").substring(0, 600) : "");
        }
    }
    res.cancelled = r.cancelled;
    res.ms = r.ms;
    return res;
}

function subfolders(dir) {
    return [].concat(new Dir(dir).entryList("*", DirSpec.Dirs) || []).map(String)
             .filter(function (d) { return d !== "." && d !== ".."; });
}

// PALETTE_LIST links under dst that point into src now point into dst.
// Returns how many were rewritten.
function repointPaletteLinks(src, dst) {
    var win = about.isWindowsArch();
    function norm(p) { var s = String(p).replace(/\\/g, "/"); return win ? s.toLowerCase() : s; }
    var prefix = norm(src) + "/", n = 0;
    function walk(dir) {
        if (new File(dir + "/PALETTE_LIST").exists) {
            var path = dir + "/PALETTE_LIST", text = readTextFile(path);
            var out = String(text).replace(/^(.+?) LINK "([^"\r\n]*)"/mg, function (all, key, p) {
                var q = String(p).replace(/\\/g, "/");
                if (norm(q).indexOf(prefix) !== 0) return all;
                n++;
                return key + " LINK \"" + dst + q.substring(prefix.length - 1) + "\"";
            });
            if (out !== String(text)) writeTextFile(path, out);
        }
        subfolders(dir).forEach(function (d) { walk(dir + "/" + d); });
    }
    walk(dst);
    return n;
}

// mtime in ms, or NaN. The bindings have no birthTime/created.
function fileTimeMs(path) {
    try {
        var d = new QFileInfo(path).lastModified();
        var ms = d && typeof d.getTime === "function" ? d.getTime() : NaN;
        return isFinite(ms) ? ms : NaN;
    } catch (e) {
        return NaN;
    }
}

// Each *.sboard's mtime as copied, read from the copy (no clock involved).
// backupInUse compares against it.
var BACKUP_RECORD = "sboardx-backup.json";

function writeBackupRecord(dst) {
    var rec = { kind: "sboardx-backup", made: new Date().toISOString(), scenes: {} };
    (new Dir(dst).entryList("*.sboard") || []).forEach(function (f) { rec.scenes[String(f)] = fileTimeMs(dst + "/" + f); });
    writeTextFile(dst + "/" + BACKUP_RECORD, JSON.stringify(rec));
}

// True if the backup may have become someone's working copy: it's open
// (a .sboard.lock), its scene files differ from the record, or there's no
// readable record. When in doubt, keep it.
function backupInUse(dir) {
    if ((new Dir(dir).entryList("*.sboard.lock") || []).length) return true;
    var rec = readJsonFile(dir + "/" + BACKUP_RECORD);
    if (!rec || !rec.scenes || typeof rec.scenes !== "object") return true;
    var scenes = [].concat(new Dir(dir).entryList("*.sboard") || []).map(String);
    var recorded = 0;
    for (var k in rec.scenes) if (rec.scenes.hasOwnProperty(k)) recorded++;
    if (scenes.length !== recorded) return true;
    for (var i = 0; i < scenes.length; i++) {
        var m = fileTimeMs(dir + "/" + scenes[i]);
        if (!isFinite(m) || rec.scenes[scenes[i]] !== m) return true;
    }
    return false;
}

// Deletes the oldest backups beyond BACKUP_KEEP, by stamped name. `keep`
// (the new one) always counts as newest, since the clock may have moved
// back. Backups in use are skipped and not counted.
function pruneBackups(folder, name, keep, log) {
    var rx = new RegExp("^" + regexEscape(name + BACKUP_INFIX) + "\\d{8}-\\d{6}(-\\d+)?$");
    var keepName = fileBasename(keep);
    var out = { pruned: 0, inUse: 0 };
    var all = subfolders(folder).filter(function (d) {
        if (!rx.test(d) || d === keepName) return false;
        if (backupInUse(folder + "/" + d)) { out.inUse++; return false; }
        return true;
    }).sort();
    all.slice(0, Math.max(0, all.length - (BACKUP_KEEP - 1))).forEach(function (d) {
        var p = folder + "/" + d;
        new Dir(p).rmdirs();
        if (new Dir(p).exists) log.warn("could not delete the old backup " + p);
        else out.pruned++;
    });
    if (out.inUse) log.trace("BACKUP kept " + out.inUse + " older backup(s) of " + name + " that are open or were saved in since they were made");
    return out;
}

function backupProject(log, progress, what) {
    var src = projectDir();
    var name = fileBasename(src), parent = fileDirname(src);
    var base = name + BACKUP_INFIX + backupStamp(new Date());
    var folder = parent, dst = newBackupFolder(folder, base);
    if (!dst) {
        var beside = parent;
        folder = String(QDir.homePath()).replace(/\\/g, "/").replace(/\/+$/, "") + "/Documents/sboardx-backups";
        dst = newBackupFolder(folder, base);
        if (dst) log.warn("the folder beside the project (" + beside + ") is not writable: the backup went to " + folder);
    }
    function fail(detail) {
        log.trace("BACKUP failed: " + detail);
        return { ok: false, message: what + " was stopped before changing anything: the project could not be backed up.\n\n" +
                 detail + "\n\nThe project was not changed." };
    }
    if (!dst) return fail("No backup folder could be created beside the project (" + parent + ") or in " + folder + ".");
    if (progress) progress.busy("Backing up the project…");
    var c = copyProjectTree(src, dst, progress ? progress.cancelled : null);
    if (!c.ok) {
        new Dir(dst).rmdirs();
        if (new Dir(dst).exists) log.warn("could not delete the incomplete backup " + dst);
        if (c.cancelled) return { ok: false, cancelled: true, message: what + " was cancelled during the backup. The project was not changed." };
        return fail("Copying " + src + " to " + dst + " failed (" + c.detail + ").\n\nClose any program that holds a file " +
                    "of the project open (a sync client, an antivirus, another Storyboard Pro), check the free disk space, and run it again.");
    }
    (new Dir(dst).entryList("*.sboard.lock") || []).forEach(function (f) {
        try { new File(dst + "/" + f).remove(); } catch (e) {}
        if (fileExists(dst + "/" + f)) log.warn("could not remove " + f + " from the backup: opening the backup will ask about it");
    });
    var links = repointPaletteLinks(src, dst);
    try { writeBackupRecord(dst); }
    catch (eRec) { log.warn("the backup's record was not written (" + eRec + "): it will never be cleaned up automatically"); }
    var pr = pruneBackups(folder, name, dst, log);
    if (!new Dir(dst).exists) return fail("The backup " + dst + " disappeared right after it was made.");
    if (c.leftOut > 0) log.warn(c.leftOut + " linked folder(s) or file(s) inside the project were not backed up (links are not followed)");
    var mb = c.bytes >= 0 ? (c.bytes / 1048576).toFixed(1) + " MB" : "size unknown";
    log.trace("BACKUP " + dst + " bytes=" + c.bytes + " files=" + c.files + " ms=" + c.ms + " links=" + links +
              " pruned=" + pr.pruned + " inUse=" + pr.inUse + " linksLeftOut=" + c.leftOut + " (" + mb + ")");
    return { ok: true, dir: dst, bytes: c.bytes, files: c.files, ms: c.ms, pruned: pr.pruned, inUse: pr.inUse, leftOut: c.leftOut };
}

function backupNote(bk) {
    if (!bk || !bk.ok) return "";
    return "\n\nThe project as it was before is backed up in:\n" + bk.dir +
           (bk.leftOut > 0 ? "\n(" + bk.leftOut + " linked folder(s) or file(s) inside the project are not in the backup: links are not followed.)" : "");
}

// The DEFAULT_LAYERS preference: 8-field records split by an empty field,
// "A;1;0;13;0;100;0;0;;;BG;1;1;13;0;100;0;0;". 0 name, 1 visible, 5 opacity.
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

// SBP turns layer names into node names with [^A-Za-z0-9_-] -> "_".
// Layer tracks match on this.
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

// ── Palettes and the Colour view ────────────────────────────────────────────

// Palettes that are ours, not the user's, so the export skips them:
// "sboardx" (scratch palette of a run), "Upshot_textures" (some projects
// still carry it) and SBP's "<name>_N" copies of either.
var BRIDGE_PALETTES = ["sboardx", "Upshot_textures"];
function isBridgePalette(name) {
    return BRIDGE_PALETTES.indexOf(fileBasename(String(name)).replace(/_\d+$/, "")) >= 0;
}

// Snapshot of the Colour view (palette colour ids + current rgba). Any
// palette edit from script jumps the view to that palette, so we put it
// back at the end (restoreColorView). null if there's nothing to restore.
// COLOR_VIEW_SCAN_MAX is just a loop bound.
var COLOR_VIEW_SCAN_MAX = 4096;
function captureColorView() {
    try {
        var cm = new ColorManager(), ids = [];
        for (var i = 0; i < COLOR_VIEW_SCAN_MAX; i++) {
            var id = String(cm.getColorIdFromPosition(i) || "");
            if (!id) break;
            ids.push(id);
        }
        if (!ids.length) return null;
        var cur = cm.getCurrentColorData();
        return { ids: ids, rgba: cur && typeof cur.r === "number" ? [cur.r, cur.g, cur.b, cur.a] : null };
    } catch (e) {
        return null;
    }
}

// Prefix match: an import may append colours to that palette.
function colorViewShows(cm, ids) {
    for (var i = 0; i < ids.length; i++) {
        if (String(cm.getColorIdFromPosition(i) || "") !== ids[i]) return false;
    }
    return true;
}

function currentColorIs(cm, rgba) {
    var c = cm.getCurrentColorData();
    return !rgba || (c && c.r === rgba[0] && c.g === rgba[1] && c.b === rgba[2] && c.a === rgba[3]);
}

function paletteHoldingIds(ids) {
    var list = PaletteObjectManager.getScenePaletteList();
    for (var i = 0; i < list.numPalettes; i++) {
        var pal = list.getPaletteByIndex(i);
        if (!pal || !pal.isValid() || pal.nColors < ids.length) continue;
        var k = 0;
        while (k < ids.length && String(pal.getColorByIndex(k).id) === ids[k]) k++;
        if (k === ids.length) return pal;
    }
    return null;
}

// Renaming a palette to its own name counts as an edit, so the view jumps
// to it and nothing else changes. Fallback: setActiveColor, which also
// changes the current colour (so try colours with the old rgba first) and
// ignores the template palette's automatic "Default".
function restoreColorView(state, log) {
    if (!state) return false;
    try {
        var cm = new ColorManager();
        if (colorViewShows(cm, state.ids)) return true;
        var pal = paletteHoldingIds(state.ids);
        if (pal) {
            pal.setName(String(pal.getName()));
            if (colorViewShows(cm, state.ids)) return true;
        }
        var same = [], other = [];
        for (var k = 0; k < state.ids.length; k++) {
            var d = pal ? pal.getColorByIndex(k) : null, cd = d && d.colorData;
            var match = state.rgba && cd && cd.r === state.rgba[0] && cd.g === state.rgba[1] && cd.b === state.rgba[2] && cd.a === state.rgba[3];
            (match ? same : other).push(state.ids[k]);
        }
        var order = same.concat(other);
        for (var i = 0; i < order.length; i++) {
            cm.setActiveColor(order[i]);
            if (!colorViewShows(cm, state.ids)) continue;
            if (!currentColorIs(cm, state.rgba)) log.warn("the Colour view is back on its palette, but the current colour changed (" + order[i] + ")");
            return true;
        }
        log.warn("could not put the Colour view back on the palette it showed before the import (" + state.ids.length + " colours)");
    } catch (e) {
        log.warn("could not restore the Colour view (" + e + ")");
    }
    return false;
}

// 8 hex digits of SHA-256, for short ids and colour names.
function shortHash(s) {
    return shortSha256Hex(String(s));
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

// Layer animation runs on 1-based panel frames. Node is "Top/<name>",
// offset is a 3-D path in camera field units, scale and rotation are bezier
// columns. Opacity only animates if a function is linked to "opacity";
// otherwise setLayerOpacity sets one value for the whole panel whatever the
// frame. clearLayerMotion empties that function and resets opacity to 100.

// Panel seconds <-> 1-based panel frame. The last frame stands for the
// panel end, so an end key round-trips (a key on a boundary ends the
// earlier panel). A one-frame panel's only frame is its start.
function panelTimeToFrame(tInPanel, panelFrames, fps) {
    return Math.max(1, Math.min(panelFrames, Math.round(tInPanel * fps) + 1));
}
function panelFrameToTime(frame, fps, panelFrames) {
    if (panelFrames > 1 && frame >= panelFrames) return panelFrames / fps;
    return (frame - 1) / fps;
}

// ── Scene cameras: the time mapping, the matching rule, the baseline ───────

// Scene camera keys sit on 1-based scene frames. A key at or past the end
// clamps onto the last frame: SBP would hold a key past it on two frames
// and read it back as an extra key. Frame -> seconds is when the frame is
// shown, (frame - 1) / fps, unlike panelFrameToTime: a key on the last
// frame is one the user placed there.
function cameraTimeToFrame(t, sceneFrames, fps) {
    return panelTimeToFrame(t, sceneFrames, fps);
}
function cameraFrameToTime(frame, fps) {
    return (frame - 1) / fps;
}

function sceneFrameCount(sb, sceneId) {
    var n = 0;
    for (var p = 0; p < sb.numberOfPanelsInScene(sceneId); p++) n += Number(sb.getPanelDuration(String(sb.panelInScene(sceneId, p)))) || 0;
    return n;
}

// Keys mapped to frames. Keys landing on the same frame collapse, the later
// one wins.
function cameraKeyFrames(kfs, sceneFrames, fps) {
    var frames = [], keys = [];
    (kfs || []).slice().sort(function (a, b) { return a.t - b.t; }).forEach(function (k) {
        var f = cameraTimeToFrame(Number(k.t) || 0, sceneFrames, fps);
        if (frames.length && frames[frames.length - 1] === f) keys[keys.length - 1] = k;
        else { frames.push(f); keys.push(k); }
    });
    return { frames: frames, keys: keys };
}

// Same camera? Compared on scene frames (cameraKeyFrames on both sides),
// then z/cx/cy/rot within 1e-3 (relative above 1). No slack on time: both
// apps key whole frames, so a one-frame move is an edit. sceneFrames 0 means
// no clamp. cameraKfsDiff returns "" on a match, else the worst difference.
function cameraKey(k) {
    var z = Number(k.z);
    return { t: Number(k.t) || 0, z: z > 0 ? z : 1, cx: Number(k.cx) || 0, cy: Number(k.cy) || 0, rot: Number(k.rot) || 0 };
}
function cameraKfsDiff(a, b, fps, sceneFrames) {
    if (!a || !b) return "no camera to compare";
    var frames = Number(sceneFrames) > 0 ? Number(sceneFrames) : Infinity;
    var ka = cameraKeyFrames(a.map(cameraKey), frames, fps), kb = cameraKeyFrames(b.map(cameraKey), frames, fps);
    if (ka.frames.length !== kb.frames.length) {
        return ka.frames.length + " key(s) against " + kb.frames.length + " (frames " + JSON.stringify(ka.frames) +
               " against " + JSON.stringify(kb.frames) + ")";
    }
    for (var i = 0; i < ka.frames.length; i++) {
        if (ka.frames[i] !== kb.frames[i]) return "key " + (i + 1) + " on frame " + kb.frames[i] + " held on frame " + ka.frames[i];
    }
    var worst = 0, what = "";
    for (var j = 0; j < ka.keys.length; j++) {
        var x = ka.keys[j], y = kb.keys[j];
        ["z", "cx", "cy", "rot"].forEach(function (f) {
            var d = Math.abs(x[f] - y[f]) / (1e-3 * Math.max(1, Math.abs(x[f])));
            if (d > worst) { worst = d; what = "key " + (j + 1) + " on frame " + kb.frames[j] + ": " + f + " " + y[f] + " held as " + x[f]; }
        });
    }
    return worst > 1 ? what : "";
}
function cameraKfsMatch(a, b, fps, sceneFrames) {
    return cameraKfsDiff(a, b, fps, sceneFrames) === "";
}

// Camera baseline, "sboardx-camera" metadata on the scene's first panel:
// {v: 2, archive: <keys as the file had them>, local: <live camera read back
// after the exchange, or null if it could not be read>}. null = no
// baseline.
function readCameraBase(sb, firstPanelId) {
    var raw = firstPanelId ? panelMetaValue(sb, firstPanelId, "sboardx-camera") : "";
    var v = null;
    try { v = raw ? JSON.parse(raw) : null; } catch (e) { v = null; }
    function isList(x) { return Object.prototype.toString.call(x) === "[object Array]"; }
    function sorted(kfs) { return kfs.slice().sort(function (a, b) { return a.t - b.t; }); }
    if (v && v.v === 2 && isList(v.archive)) return { archive: sorted(v.archive), local: isList(v.local) ? sorted(v.local) : null };
    return null;
}
function writeCameraBase(sb, firstPanelId, archive, local) {
    setPanelMeta(sb, firstPanelId, "sboardx-camera", JSON.stringify({ v: 2, archive: archive || [], local: local || null }));
}
function cameraBaseLocal(base) {
    return base.local !== null ? base.local : base.archive;
}

// 3-way verdict for one scene camera: "unchanged", "updated", "localOnly"
// or "conflict". Both sides changed the same way counts as unchanged. With
// no baseline: equal is unchanged, no live camera takes the file's, else
// conflict.
function cameraMergeKind(archiveKfs, live, base, fps, sceneFrames) {
    var archiveChanged, localChanged;
    if (!base) {
        var same = cameraKfsMatch(live, archiveKfs, fps, sceneFrames);
        archiveChanged = !same;
        localChanged = !same && live.length > 0;
    } else {
        archiveChanged = !cameraKfsMatch(archiveKfs, base.archive, fps, sceneFrames);
        localChanged = !cameraKfsMatch(live, cameraBaseLocal(base), fps, sceneFrames);
        if (archiveChanged && localChanged && cameraKfsMatch(live, archiveKfs, fps, sceneFrames)) archiveChanged = localChanged = false;
    }
    return archiveChanged && localChanged ? "conflict" : archiveChanged ? "updated" : localChanged ? "localOnly" : "unchanged";
}

function wrapDeg(d) {
    return ((d + 180) % 360 + 360) % 360 - 180;
}

// SPEC.md "layer_tracks" interpolation: hold at the ends, smoothstep,
// geometric scale, shortest-arc rotation. Two keys at the same t are a cut,
// the later key wins at t. leftLimit gives the pose just before t (what a
// panel ending at t shows). 1e-6 s of slack for summed-up frame times.
function layerPoseAt(kfs, t, leftLimit) {
    function pose(k) {
        return {
            tx: Number(k.tx) || 0, ty: Number(k.ty) || 0,
            s: (typeof k.s === "number" && k.s > 0) ? k.s : 1,
            rot: Number(k.rot) || 0,
            opacity: (typeof k.opacity === "number") ? clamp01(k.opacity) : 1
        };
    }
    if (!kfs || !kfs.length) return { tx: 0, ty: 0, s: 1, rot: 0, opacity: 1 };
    var EPS = 1e-6, last = kfs[kfs.length - 1].t;
    if (t <= kfs[0].t + (leftLimit ? EPS : 0)) return pose(kfs[0]);
    if (leftLimit ? t > last + EPS : t >= last - EPS) return pose(kfs[kfs.length - 1]);
    var i = 0;
    if (leftLimit) while (i + 2 < kfs.length && kfs[i + 1].t < t - EPS) i++;
    else while (i + 2 < kfs.length && kfs[i + 1].t <= t + EPS) i++;
    var a = pose(kfs[i]), b = pose(kfs[i + 1]);
    var span = kfs[i + 1].t - kfs[i].t;
    var raw = span > 1e-9 ? clamp01((t - kfs[i].t) / span) : 1;
    if (leftLimit && Math.abs(kfs[i + 1].t - t) <= EPS) raw = 1;   // ends exactly on b
    else if (!leftLimit && Math.abs(t - kfs[i].t) <= EPS) raw = 0; // starts exactly on a
    var f = raw * raw * (3 - 2 * raw);
    return {
        tx: a.tx + (b.tx - a.tx) * f,
        ty: a.ty + (b.ty - a.ty) * f,
        s: Math.exp(Math.log(a.s) + (Math.log(b.s) - Math.log(a.s)) * f),
        rot: wrapDeg(a.rot + wrapDeg(b.rot - a.rot) * f),
        opacity: a.opacity + (b.opacity - a.opacity) * f
    };
}

// Pose about a pivot -> SBP offset/scale/angle, pivot folded into the
// offset: T' = c + T - S·R·c. World y is down, SBP's is up, so angles flip.
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

// SHA-256 via Qt's QCryptographicHash, fed whole QByteArrays (hashing in
// script is far slower). Single bytes: new QByteArray("\u0000") and
// QByteArray.fromHex("00") come out EMPTY, hence shaByte.
function newSha256() {
    return new QCryptographicHash(QCryptographicHash.Sha256);
}
function sha256Hex(h) {
    return String(h.result().toHex().toString()).toLowerCase();
}
function shaByte(v) {
    return v === 0 ? new QByteArray(1, 0) : QByteArray.fromHex(new QByteArray("ff"));
}

// SHA-256 hex of a file, "" if unreadable.
function fileSha256(path) {
    var ba = readFileByteArray(path);
    if (!ba) return "";
    var h = newSha256();
    h.addData(ba);
    return sha256Hex(h);
}

// A QByteArray from a string stops at U+0000, so feed around them.
function shaAddString(h, s) {
    var parts = String(s).split("\u0000");
    for (var k = 0; k < parts.length; k++) {
        if (k) h.addData(shaByte(0));
        h.addData(new QByteArray(parts[k]));
    }
}

function shortSha256Hex(s) {
    var h = newSha256();
    shaAddString(h, s);
    return sha256Hex(h).substring(0, 8);
}

// Any stored hash not in this form is ignored.
function isSha256Hex(s) { return typeof s === "string" && /^[0-9a-f]{64}$/.test(s); }

// Byte range of panel.json's "code" member, which the digest skips (SPEC.md
// "Merging"): first "code" with a string value plus the comma after it, or
// else the one before. null if absent.
function codeMemberRange(bytes) {
    var s = String.fromCharCode.apply(null, bytes);
    var m = /"code"[ \t\n\r]*:[ \t\n\r]*"(?:[^"\\]|\\.)*"/.exec(s);
    if (!m) return null;
    var start = m.index, end = start + m[0].length;
    var after = /^[ \t\n\r]*,/.exec(s.substring(end));
    if (after) end += after[0].length;
    else {
        var before = /,[ \t\n\r]*$/.exec(s.substring(0, start));
        if (before) start = before.index;
    }
    return { start: start, end: end };
}

// ── sboardx 1.2 textures (SPEC.md "Textured strokes (1.2)") ────────────────

// Atlas cell size the export uses (Upshot uses the same). SPEC.md allows
// a power of two from 64 to 1024 (isValidTileSize).
var TILE_SIZE = 256;
function isValidTileSize(s) {
    return typeof s === "number" && s >= 64 && s <= 1024 && Math.floor(s) === s && (s & (s - 1)) === 0;
}

// Import and export must agree on this or round trips drift. SBP's SVG
// parser maps the page to 5000 drawing units high and scales content by
// 0.75 (points on a 96-dpi page), so a frame is 3750 units high.
var PARSER_PAGE_DRAWING_UNITS = 5000;
var DRAWING_UNITS_PER_FRAME_H = 0.75 * PARSER_PAGE_DRAWING_UNITS;

// Max page side (SPEC.md "Pages"): one decoded page is at most 16 MiB.
var PAGE_MAX = 2048;

// 2^20, cap on every integer in a texture file. Check before using it as
// an index or size.
var TEXTURE_INT_MAX = 1048576;

// k in decimal, no leading zeros (SPEC.md "Pages").
function pageEntryName(prefix, k) {
    return "images/" + prefix + "_p" + k + ".png";
}

// "<owner>_<layer>" with anything outside [A-Za-z0-9_-] turned into "_".
// Can collide (ids may hold "_"), the export dedupes (uniquePagePrefix).
function pagePrefixOf(owner, layer) {
    return String(owner + "_" + layer).replace(/[^A-Za-z0-9_-]/g, "_");
}

// A valid `pages` entry. Readers just follow names, never rebuild them.
function isPageName(s) {
    return typeof s === "string" && /^images\/[A-Za-z0-9_-]+\.png$/.test(s);
}

// Texture links as written: relative to the panel folder, or to shared/.
function layerTextureLink(layerId) { return "art/" + layerId + ".texture.json"; }
function sharedTextureLink(id) { return id + "/texture.json"; }

// SPEC.md link grammar: [A-Za-z0-9_.-] segments, no "." or "..", ends .json.
function isTextureLink(s) {
    if (typeof s !== "string" || !/\.json$/.test(s)) return false;
    var segs = s.split("/");
    for (var i = 0; i < segs.length; i++) {
        if (!/^[A-Za-z0-9_.-]+$/.test(segs[i]) || segs[i] === "." || segs[i] === "..") return false;
    }
    return true;
}

// Textured path id (SPEC.md "Art SVG").
var TEXTURE_PATH_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

// SPEC.md "The texture file", Content. Used by the import and the digest.
// null if: a byte outside tab/LF/CR/0x20-0x7E (BOM too), nesting deeper
// than 64 (top level is 1), invalid JSON, a non-finite number (1e400), or
// a string/key that isn't ASCII once unescaped. Duplicate keys: last wins.
var TEXTURE_MAX_DEPTH = 64;
function parseTextureFileBytes(bytes) {
    if (!bytes) return null;
    var chars = [];
    var depth = 0, inString = false, escaped = false;
    for (var i = 0; i < bytes.length; i++) {
        var b = bytes[i] & 0xff;
        if (!(b === 9 || b === 10 || b === 13 || (b >= 0x20 && b <= 0x7e))) return null;
        if (inString) {
            if (escaped) escaped = false;
            else if (b === 0x5c) escaped = true;
            else if (b === 0x22) inString = false;
        } else if (b === 0x22) {
            inString = true;
        } else if (b === 0x5b || b === 0x7b) {
            if (++depth > TEXTURE_MAX_DEPTH) return null;
        } else if (b === 0x5d || b === 0x7d) {
            --depth;
        }
        chars.push(String.fromCharCode(b));
    }
    var v;
    try { v = JSON.parse(chars.join("")); } catch (e) { return null; }
    var todo = [v];
    while (todo.length) {
        var x = todo.pop();
        if (typeof x === "number") { if (!isFinite(x)) return null; }
        else if (typeof x === "string") { if (!/^[\x00-\x7f]*$/.test(x)) return null; }
        else if (x && typeof x === "object") {
            if (isArray(x)) {
                for (var k = 0; k < x.length; k++) todo.push(x[k]);
            } else {
                for (var key in x) {
                    if (!Object.prototype.hasOwnProperty.call(x, key)) continue;
                    if (!/^[\x00-\x7f]*$/.test(key)) return null;
                    todo.push(x[key]);
                }
            }
        }
    }
    return v;
}

function isArray(v) { return Object.prototype.toString.call(v) === "[object Array]"; }

// SPEC.md "Packing": cell i (row-major) goes on page floor(i / P^2) at
// ((j mod P) S, floor(j / P) S), j = i mod P^2, P = PAGE_MAX / S.
function pageSlot(i, S) {
    var P = PAGE_MAX / S, j = i % (P * P);
    return { page: Math.floor(i / (P * P)), sx: (j % P) * S, sy: Math.floor(j / P) * S };
}

// Page sizes for n cells: full pages, then the last one cropped to
// min(m, P) S by ceil(m / P) S.
function pageLayout(n, S) {
    var P = PAGE_MAX / S, out = [];
    for (var left = n; left > 0; left -= P * P) {
        var m = Math.min(left, P * P);
        out.push({ w: Math.min(m, P) * S, h: Math.ceil(m / P) * S });
    }
    return out;
}

// Byte order. Don't rely on Dir.entryList's order.
function byteOrder(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

// Checks a page's header before decoding (SPEC.md "Pages": a PNG Qt can
// read, each side at most 2048). null if fine, else why. Qt decodes huge
// PNGs, so the size is read here; decodePage catches the rest.
function pngPageProblem(path) {
    if (!fileExists(path)) return "is missing";
    var r = new QImageReader(path);
    try {
        var png = r.canRead() && String(r.format().toString()).toLowerCase() === "png";
        var s = r.size(), w = Number(s.width()), h = Number(s.height());
        if (!png || !(w >= 1) || !(h >= 1)) return "is not a PNG Qt can read";
        if (w > PAGE_MAX || h > PAGE_MAX) return "is " + w + "x" + h + ", a side above " + PAGE_MAX;
        return null;
    } finally {
        // The reader holds the file open until GC.
        try { if (typeof r.setFileName === "function") r.setFileName(""); } catch (e) {}
    }
}

// Entry name -> path, or null for an empty, "." or ".." segment or a
// backslash: on disk those resolve to some other entry, but the digest
// takes names literally.
function entryPathOf(rootDir, name) {
    var segs = String(name).split("/");
    for (var i = 0; i < segs.length; i++) if (segs[i] === "" || segs[i] === "." || segs[i] === ".." || /\\/.test(segs[i])) return null;
    return rootDir + "/" + name;
}

// Panel digest over an extracted archive or a staging folder (SPEC.md
// "Merging"): SHA-256 of name, 0x00, bytes, 0x00 per entry (absent: name,
// 0x00, 0xFF). Per layer: art, image, the 1.1 pencil atlas if present,
// then for a string `texture` the texture file and, if it parses with an
// array `pages`, every string in it in order (duplicates too). No
// directory scanning.
function archivePanelDigest(rootDir, pid) {
    var h = newSha256(), zero = shaByte(0), absent = shaByte(0xff);
    function name(s) { shaAddString(h, s); }
    // `feed` overrides how the bytes are hashed (panel.json).
    function entry(n, feed) {
        name(n);
        h.addData(zero);
        var p = entryPathOf(rootDir, n);
        var ba = p && fileExists(p) ? readFileByteArray(p) : null;
        if (!ba) { h.addData(absent); return null; }
        if (feed) feed(ba); else h.addData(ba);
        h.addData(zero);
        return ba;
    }
    var base = "panels/" + pid + "/";
    entry(base + "panel.json", function (ba) {
        var cut = codeMemberRange(byteArrayBytes(ba));
        if (!cut) { h.addData(ba); return; }
        h.addData(ba.mid(0, cut.start));
        h.addData(ba.mid(cut.end, ba.size() - cut.end));
    });
    entry(base + "layers.json");
    var lj = readJsonFile(rootDir + "/" + base + "layers.json");
    var layers = (lj && lj.layers) || [];
    for (var i = 0; i < layers.length; i++) {
        var l = layers[i];
        if (!l || typeof l !== "object") continue;
        // Non-string names count as absent.
        if (typeof l.art === "string" && l.art) entry(base + l.art);
        if (l.image && typeof l.image === "object" && typeof l.image.file === "string" && l.image.file) entry(l.image.file);
        var atlas = "images/" + pid + "_" + l.id + "_pencil.png";
        if (typeof l.id === "string" && l.id && fileExists(rootDir + "/" + atlas)) entry(atlas);
        if (typeof l.texture !== "string") continue;
        var t = parseTextureFileBytes(byteArrayBytes(entry(base + l.texture)));
        var pages = t && typeof t === "object" ? t.pages : null;
        if (!isArray(pages)) continue;
        for (var k = 0; k < pages.length; k++) if (typeof pages[k] === "string") entry(pages[k]);
    }
    return sha256Hex(h);
}

// The project-level id map ("sboardx-ids" project metadata, JSON):
//   { v: 1,
//     panels: { <native panel id>: { id: <archive id>,
//                                    digest: <archive digest of the panel at the last exchange>,
//                                    fp: "<FINGERPRINT_FORM>:<the panel's fingerprint here then>",
//                                    shared: stampBaseline } },
//     scenes: { <native scene id>: <archive scene id> },
//     drawings: { <shared drawing key>: { id, art, file } } }   (only if any)
// Keyed by native ids, so a duplicated panel is a new panel.
function loadIdMap(sb, log) {
    var map = { v: 1, panels: {}, scenes: {}, drawings: {} };
    var raw = "";
    try { raw = metaValue(sb.getProjectMetadata("sboardx-ids")); } catch (e) {}
    if (raw) {
        try {
            var parsed = JSON.parse(raw);
            map.panels = parsed.panels || {};
            map.scenes = parsed.scenes || {};
            map.drawings = parsed.drawings || {};
        } catch (e2) {
            log.warn("the project's sboardx-ids metadata is not JSON; the merge baselines start over");
        }
    }
    var live = { panels: {}, scenes: {} };
    forEachPanel(sb, function (sceneId, pid) {
        live.scenes[sceneId] = live.panels[pid] = true;
    });
    // Drop deleted panels, scenes and drawings.
    ["panels", "scenes"].forEach(function (kind) {
        for (var id in map[kind]) if (map[kind].hasOwnProperty(id) && !live[kind][id]) delete map[kind][id];
    });
    if (typeof project != "undefined") {
        var dir = projectDir();
        for (var key in map.drawings) if (map.drawings.hasOwnProperty(key) && !fileExists(dir + "/" + key)) delete map.drawings[key];
    }
    return map;
}

function saveIdMap(sb, map) {
    var rec = { v: 1, panels: map.panels, scenes: map.scenes };
    for (var k in (map.drawings || {})) if (map.drawings.hasOwnProperty(k)) { rec.drawings = map.drawings; break; }
    sb.setProjectMetadata(metaRecord("sboardx-ids", JSON.stringify(rec)));
}

// ── Shared drawings: identity, baselines, links ─────────────────────────────

// Forward slashes, no trailing slash.
function projectDir() {
    return String(project.currentProjectPath()).replace(/\\/g, "/").replace(/\/+$/, "");
}

// A shared drawing's key is its path in the project
// ("elements/Shared/Shared-Prop.tvg"). Only valid once saved: before that
// the path points into the session's temp folder.
function sharedDrawingKey(path) {
    var p = String(path || "").replace(/\\/g, "/");
    var at = p.lastIndexOf("/elements/");
    return at >= 0 ? p.substring(at + 1) : p;
}

// Hash of the key, so a moved or copied project keeps it.
function sharedDrawingDefaultId(key) {
    return "sd-" + shortHash(String(key));
}

// The id map's `drawings`:
//   { <key>: { id: <archive id>, art: <sharedDrawingIdentity at the last
//              exchange>, file: <fileSha256 of the .tvg then> } }
// `id` is the one the import got (so Upshot's ids survive a round trip) or
// the default. `art` says unchanged in the file, `file` unchanged here.
function sharedDrawingArchiveId(map, key) {
    var e = map && map.drawings ? map.drawings[key] : null;
    return e && e.id ? String(e.id) : sharedDrawingDefaultId(key);
}

// Project key for archive drawing `id`: via the map, else by default id.
// "" if none.
function sharedDrawingKeyOf(map, id, keys) {
    var byDefault = "";
    for (var i = 0; i < keys.length; i++) {
        var e = map && map.drawings ? map.drawings[keys[i]] : null;
        if (e && e.id) { if (String(e.id) === String(id)) return keys[i]; continue; }
        if (!byDefault && sharedDrawingDefaultId(keys[i]) === String(id)) byDefault = keys[i];
    }
    return byDefault;
}

// Identity of an archive shared drawing, stamped by the export and compared
// by the import. Untextured: fileSha256 of art.svg. Textured (the art alone
// doesn't name its texture): SHA-256 of art, 0x00, then the texture file
// or 0xFF if absent. "" if the art can't be read.
function sharedDrawingIdentity(sharedDir, id, textureLink) {
    var art = sharedDir + "/" + id + "/art.svg";
    if (typeof textureLink !== "string") return fileSha256(art);
    var ba = readFileByteArray(art);
    if (!ba) return "";
    var h = newSha256();
    h.addData(ba);
    h.addData(shaByte(0));
    var p = entryPathOf(sharedDir, textureLink);
    var tex = p && fileExists(p) ? readFileByteArray(p) : null;
    h.addData(tex ? tex : shaByte(0xff));
    return sha256Hex(h);
}

function sharedArtUnchanged(rec, artNow) {
    return !!rec && isSha256Hex(rec.art) && rec.art === artNow;
}

// Only hashes the file when the record is a valid SHA-256.
function recordedFileUnchanged(record, path) {
    return isSha256Hex(record) && record === fileSha256(path);
}

// How to bring in the holders of one archive shared drawing.
//   "new"    not here yet: import the first holder, paste the rest from it
//   "link"   unchanged in the file: paste holders from one here
//   "redraw" changed in the file only: replace the art in place, then paste
//   "copy"   plain copies plus a warning: "batch" (no Paste in -batch),
//            "both changed", or "no baseline" (never overwrite silently)
// A library drawing no layer holds can't be pasted from, so it's "new"
// ("holderless").
function sharedLinkMode(s) {
    if (!s.hasSession) return { mode: "copy", why: "batch" };
    if (!s.key) return { mode: "new", why: "" };
    if (!s.hasHolder) return { mode: "new", why: "holderless" };
    var rec = s.rec || null;
    if ((rec && s.artUnchanged) || s.holderDeclaredUnchanged) return { mode: "link", why: "" };
    if (!rec || !rec.file) return { mode: "copy", why: "no baseline" };
    if (!s.fileUnchanged) return { mode: "copy", why: "both changed" };
    return { mode: "redraw", why: "" };
}

// Copy Layers overwrites the system clipboard, so save every format first
// and put it back in restore(), unless the user copied something meanwhile.
// Plain text goes back via setText: a script-made QMimeData after a Paste
// Layers breaks every later Copy Layers in the session. Logs sizes and
// hashes only, never the text.
function makeLayerClipboard(log) {
    var saved = null, copies = 0, pastes = 0;
    function cb() { return QApplication.clipboard(); }
    function formatsNow() {
        var md = cb().mimeData(), out = [], fs = md ? md.formats() : [];
        for (var i = 0; i < fs.length; i++) out.push(String(fs[i]));
        return out;
    }
    function holdsLayers() {
        return formatsNow().some(function (f) { return /^SB__COPY_PASTE__LAYERS/.test(f); });
    }
    function describe(text, n) { return n + " format(s), text " + text.length + " chars hash " + shortHash(text); }
    return {
        copy: function (selMgr, panelId, layerName) {
            if (!saved) {
                var md = cb().mimeData(), fs = md ? md.formats() : [], formats = [];
                for (var i = 0; i < fs.length; i++) formats.push({ f: String(fs[i]), b: new QByteArray(md.data(String(fs[i]))) });
                saved = { formats: formats, text: String(cb().text()) };
                log.trace("CLIPBOARD saved " + describe(saved.text, formats.length));
            }
            selMgr.setCurrentPanel(String(panelId));
            selMgr.setLayerSelection([{ name: String(layerName), panelId: String(panelId) }]);
            Action.perform("onActionCopyLayers");
            copies++;
            if (!holdsLayers()) throw "Copy Layers put nothing on the clipboard";
        },
        // With nothing selected the layer lands at index 0.
        paste: function (selMgr, panelId) {
            selMgr.setCurrentPanel(String(panelId));
            try { selMgr.setLayerSelection([]); } catch (e) {}
            Action.perform("onActionPasteLayers");
            pastes++;
        },
        restore: function () {
            if (!saved) return;
            var s = saved;
            saved = null;
            if (!holdsLayers()) {
                log.warn("the clipboard changed while layers were being linked: left as it is");
                log.trace("CLIPBOARD left " + describe(String(cb().text()), formatsNow().length) + " copies=" + copies + " pastes=" + pastes);
                return;
            }
            var textOnly = s.formats.length > 0 && s.formats.every(function (x) { return /^text\/plain(;|$)/.test(x.f); });
            if (!s.formats.length) cb().clear();
            else if (textOnly) cb().setText(s.text);
            else {
                var m = new QMimeData();
                s.formats.forEach(function (x) { m.setData(x.f, x.b); });
                cb().setMimeData(m);
            }
            var text = String(cb().text()), n = formatsNow().length;
            var ok = text === s.text && n === s.formats.length;
            log.trace("CLIPBOARD restored " + describe(text, n) + " copies=" + copies + " pastes=" + pastes + (ok ? " verified" : " MISMATCH"));
            if (!ok) log.warn("the clipboard could not be put back as it was (" + n + " of " + s.formats.length + " formats)");
        }
    };
}

function newIdEntry(id) {
    return { id: id, digest: "" };
}

// An entry's baseline is `fp` (the panel's fingerprint at the exchange) plus
// `shared` (the shared drawings it held then), both from stampBaseline. No
// valid fp means no baseline: always "changed here", no holders recorded.
// `digest` still counts, so a panel the file declares unchanged stays so.
function idEntryRecordsShared(entry) {
    return idEntryFingerprint(entry) !== "";
}

// `shared` is what decides which drawings an unchanged panel holds, not the
// panel now: a holder added here since isn't the file's. fp "" (couldn't
// compute) clears the baseline.
function stampBaseline(entry, sharedKeys, fp) {
    if (fp) entry.fp = fingerprintTag(fp);
    else delete entry.fp;
    if (fp && sharedKeys && sharedKeys.length) entry.shared = sharedKeys.slice().sort(byteOrder);
    else delete entry.shared;
}

// The entry's fingerprint hex, "" if missing or in another form.
function idEntryFingerprint(entry) {
    var v = entry && typeof entry.fp === "string" ? entry.fp : "";
    var pre = FINGERPRINT_FORM + ":";
    return v.indexOf(pre) === 0 && isSha256Hex(v.substring(pre.length)) ? v.substring(pre.length) : "";
}

// "<FINGERPRINT_FORM>:<64 hex>"
function fingerprintTag(hex) {
    return FINGERPRINT_FORM + ":" + String(hex);
}

// Changed here since the last exchange? Used by the export (may it declare
// the base?) and the merge (must it ask?). fpNowOf() is lazy since it reads
// the panel. No baseline or no fingerprint now counts as changed.
function changedSinceExchange(entry, fpNowOf) {
    var fp = idEntryFingerprint(entry);
    if (!fp) return true;
    var now = fpNowOf();
    return !now || now !== fp;
}

// Sorted unique shared drawing keys of a panel. Needs a saved project.
function panelSharedKeys(lm, pid) {
    var seen = {}, out = [];
    for (var i = 0; i < lm.numberOfLayers(pid); i++) {
        if (lm.isShared(pid, i) !== true) continue;
        var key = sharedDrawingKey(String(lm.getLayerDrawingName(pid, i, true) || ""));
        if (key && !seen[key]) { seen[key] = true; out.push(key); }
    }
    return out.sort(byteOrder);
}

// The map's id, else the native one (panel made in Storyboard Pro).
function archiveIdOf(map, pid) {
    var e = map.panels[pid];
    return e && e.id ? String(e.id) : String(pid);
}

// ── Native layers: Storyboard Pro layer kinds the format has no form for ────

// getData gives nothing for text, so text layers export as their render and
// get recorded in "sboardx-native-layers". A merge that gets the same picture
// back keeps the text layer. Returns the texts over arts 0..3 (scripted text
// sits on art 2). Text plus drawing still counts as a text layer.
function drawingTexts(tvgPath) {
    var out = [];
    if (!tvgPath) return out;
    for (var art = 0; art <= 3; art++) {
        var t = null;
        try { t = Drawing.text.getTextLayers({ drawing: { filename: String(tvgPath) }, art: art }); } catch (e) {}
        if (t && t.length) for (var i = 0; i < t.length; i++) out.push(String(t[i].text));
    }
    return out;
}

var NATIVE_LAYERS_META = "sboardx-native-layers";

// [{kind: "text", name, png: <fileSha256 of the PNG>, drawing: <fileSha256
//   of the .tvg>, opacity, varies, image: {w, h, transform}}], or [].
function readNativeLayers(sb, panelId) {
    var raw = panelMetaValue(sb, panelId, NATIVE_LAYERS_META);
    if (!raw) return [];
    try {
        var v = JSON.parse(raw);
        return v && v.layers && v.layers.length ? v.layers : [];
    } catch (e) {
        return [];
    }
}

// An empty list removes the record.
function writeNativeLayers(sb, panelId, layers) {
    var had = !!panelMetaValue(sb, panelId, NATIVE_LAYERS_META);
    if (layers.length) setPanelMeta(sb, panelId, NATIVE_LAYERS_META, JSON.stringify({ v: 1, layers: layers }));
    else if (had) {
        try { sb.removePanelMetadata(panelId, NATIVE_LAYERS_META); }
        catch (e) { setPanelMeta(sb, panelId, NATIVE_LAYERS_META, ""); }
    }
}

// ── The "changed here?" fingerprint (export.js panelFingerprint uses it) ────

// getData returns contours in a different order and from different start
// points on every load, so the exported SVG can't tell "changed here". The
// fingerprint only uses what's stable across loads, no render: strokes, per
// colour the painted area and first moments (rounded), shader matrices,
// colour values, layer settings, bitmap/text layer files. Private to these
// scripts, stored in the id map, never in an archive. Change what it hashes
// and you must bump FINGERPRINT_FORM (old entries then have no baseline).
var FINGERPRINT_FORM = "fpsha1";
// Rounding: area in world units^2, moments in world units^3. Coarse enough
// to absorb load-to-load noise. Swapping two equal-area regions of two
// colours can hide below ~100 units^3.
var FP_AREA_QUANTUM = 0.01;
var FP_MOMENT_QUANTUM = 100;

// SHA-256 over one token per value: its text plus "\n", buffered in a
// QByteArray and flushed every FP_FLUSH_BYTES. The text is JSON.stringify
// when it holds no "null" (getData's member order is stable), else "~" +
// fpExact, which keeps null, NaN, the infinities and undefined apart. JSON
// never starts with "~" or holds a raw "\n", so the stream is unambiguous.
// -0 is 0. Lone surrogates wouldn't round-trip, SBP data has none.
var FP_FLUSH_BYTES = 1048576;

function FpHash() { this.h = newSha256(); this.ba = new QByteArray(); }
FpHash.prototype.val = function (v) {
    this.ba.append(fpToken(v));
    if (this.ba.size() >= FP_FLUSH_BYTES) {
        this.h.addData(this.ba);
        this.ba = new QByteArray();
    }
};
// Finishes the hash.
FpHash.prototype.hex = function () {
    this.h.addData(this.ba);
    this.ba = new QByteArray();
    return sha256Hex(this.h);
};

function fpToken(v) {
    var s = JSON.stringify(v);
    return (typeof s === "string" && s.indexOf("null") < 0 ? s : "~" + fpExact(v)) + "\n";
}

// Prefix-free exact text: n t f u, N I J (NaN, +-Infinity), "d<num>;",
// JSON strings, "[<len>;" + items, "{" + name/value pairs + "}" (undefined
// and functions skipped), else "o" + JSON of String(v).
function fpExact(v) {
    var t = typeof v;
    if (t === "number") {
        if (v !== v) return "N";
        if (v === Infinity) return "I";
        if (v === -Infinity) return "J";
        return "d" + String(v) + ";";
    }
    if (t === "string") return JSON.stringify(v);
    if (t === "boolean") return v ? "t" : "f";
    if (v === undefined) return "u";
    if (v === null) return "n";
    var out, i;
    if (v instanceof Array) {
        out = ["[", String(v.length), ";"];
        for (i = 0; i < v.length; i++) out.push(fpExact(v[i]));
        return out.join("");
    }
    if (t === "object") {
        out = ["{"];
        for (var k in v) {
            if (!v.hasOwnProperty(k)) continue;
            var x = v[k];
            if (x === undefined || typeof x === "function") continue;
            out.push(JSON.stringify(k), fpExact(x));
        }
        out.push("}");
        return out.join("");
    }
    return "o" + JSON.stringify(String(v));
}

function sha256OfString(s) {
    var h = newSha256();
    shaAddString(h, s);
    return sha256Hex(h);
}

// 5-point Gauss-Legendre on [0, 1], exact to degree 9: enough for x^2 y'
// of a cubic (degree 8).
var GL5_T = (function () {
    var a = Math.sqrt(5 - 2 * Math.sqrt(10 / 7)) / 3, b = Math.sqrt(5 + 2 * Math.sqrt(10 / 7)) / 3;
    return [(1 - b) / 2, (1 - a) / 2, 0.5, (1 + a) / 2, (1 + b) / 2];
})();
var GL5_W = (function () {
    var wa = (322 + 13 * Math.sqrt(70)) / 900, wb = (322 - 13 * Math.sqrt(70)) / 900;
    return [wb / 2, wa / 2, 64 / 225, wa / 2, wb / 2];
})();

// Bezier basis per node: quadratic Q (x, y) and D (x', y'), cubic K and E.
// Computed left to right ((u * u) * t) on purpose: stored fingerprints
// depend on the exact doubles, so don't reassociate.
var GL5_Q = [], GL5_D = [], GL5_K = [], GL5_E = [];
(function () {
    for (var g = 0; g < 5; g++) {
        var t = GL5_T[g], u = 1 - t;
        GL5_Q.push(u * u, 2 * u * t, t * t);
        GL5_D.push(2 * u, 2 * t);
        GL5_K.push(u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t);
        GL5_E.push(3 * u * u, 6 * u * t, 3 * t * t);
    }
})();

// Signed area and first moments of a closed path, segmented like the
// export's tracePath, drawing units (y up), positive counter-clockwise:
// [A, MX, MY] = [1/2 closed integral of (x dy - y dx), integral of x^2/2 dy,
// -integral of y^2/2 dx]. Lines in closed form, curves by GL5. Writes into
// `out` so the hot loop doesn't allocate. Keep the operation order: the
// fingerprint depends on the exact doubles.
function loopIntegralsInto(pts, out) {
    var A = 0, MX = 0, MY = 0, n = pts ? pts.length : 0;
    if (!n) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
    var fx = pts[0].x, fy = pts[0].y, cx = fx, cy = fy, nc = 0, c0x = 0, c0y = 0, c1x = 0, c1y = 0, p, i, ex, ey, x, y, dx, dy;
    // Cubics (nearly all segments) are unrolled over locals. Quadratics
    // are rare in SBP contours and just loop.
    var W = GL5_W, K = GL5_K, E = GL5_E, Q, D;
    var w0 = W[0], w1 = W[1], w2 = W[2], w3 = W[3], w4 = W[4];
    var k00 = K[0], k01 = K[1], k02 = K[2], k03 = K[3], k10 = K[4], k11 = K[5], k12 = K[6], k13 = K[7], k20 = K[8], k21 = K[9], k22 = K[10], k23 = K[11], k30 = K[12], k31 = K[13], k32 = K[14], k33 = K[15], k40 = K[16], k41 = K[17], k42 = K[18], k43 = K[19];
    var e00 = E[0], e01 = E[1], e02 = E[2], e10 = E[3], e11 = E[4], e12 = E[5], e20 = E[6], e21 = E[7], e22 = E[8], e30 = E[9], e31 = E[10], e32 = E[11], e40 = E[12], e41 = E[13], e42 = E[14];
    for (i = 1; i <= n; i++) {
        if (i < n) {
            p = pts[i];
            if (!p.onCurve) {
                if (nc === 0) { c0x = p.x; c0y = p.y; } else if (nc === 1) { c1x = p.x; c1y = p.y; }
                nc++;
                continue;
            }
            ex = p.x; ey = p.y;
        } else {
            // Close: trailing controls curve back to the start, else a line.
            if (!nc && cx === fx && cy === fy) break;
            ex = fx; ey = fy;
        }
        if (nc === 0) {
            A += (cx * ey - ex * cy) / 2;
            MX += (ey - cy) * (cx * cx + cx * ex + ex * ex) / 6;
            MY -= (ex - cx) * (cy * cy + cy * ey + ey * ey) / 6;
        } else if (nc === 1) {
            Q = GL5_Q; D = GL5_D;
            for (var g = 0; g < 5; g++) {
                var q = 3 * g, d = 2 * g, w = W[g];
                x = Q[q] * cx + Q[q + 1] * c0x + Q[q + 2] * ex;
                y = Q[q] * cy + Q[q + 1] * c0y + Q[q + 2] * ey;
                dx = D[d] * (c0x - cx) + D[d + 1] * (ex - c0x);
                dy = D[d] * (c0y - cy) + D[d + 1] * (ey - c0y);
                A += w * (x * dy - y * dx) / 2;
                MX += w * x * x * dy / 2;
                MY -= w * y * y * dx / 2;
            }
        } else {
            x = k00 * cx + k01 * c0x + k02 * c1x + k03 * ex;
            y = k00 * cy + k01 * c0y + k02 * c1y + k03 * ey;
            dx = e00 * (c0x - cx) + e01 * (c1x - c0x) + e02 * (ex - c1x);
            dy = e00 * (c0y - cy) + e01 * (c1y - c0y) + e02 * (ey - c1y);
            A += w0 * (x * dy - y * dx) / 2;
            MX += w0 * x * x * dy / 2;
            MY -= w0 * y * y * dx / 2;
            x = k10 * cx + k11 * c0x + k12 * c1x + k13 * ex;
            y = k10 * cy + k11 * c0y + k12 * c1y + k13 * ey;
            dx = e10 * (c0x - cx) + e11 * (c1x - c0x) + e12 * (ex - c1x);
            dy = e10 * (c0y - cy) + e11 * (c1y - c0y) + e12 * (ey - c1y);
            A += w1 * (x * dy - y * dx) / 2;
            MX += w1 * x * x * dy / 2;
            MY -= w1 * y * y * dx / 2;
            x = k20 * cx + k21 * c0x + k22 * c1x + k23 * ex;
            y = k20 * cy + k21 * c0y + k22 * c1y + k23 * ey;
            dx = e20 * (c0x - cx) + e21 * (c1x - c0x) + e22 * (ex - c1x);
            dy = e20 * (c0y - cy) + e21 * (c1y - c0y) + e22 * (ey - c1y);
            A += w2 * (x * dy - y * dx) / 2;
            MX += w2 * x * x * dy / 2;
            MY -= w2 * y * y * dx / 2;
            x = k30 * cx + k31 * c0x + k32 * c1x + k33 * ex;
            y = k30 * cy + k31 * c0y + k32 * c1y + k33 * ey;
            dx = e30 * (c0x - cx) + e31 * (c1x - c0x) + e32 * (ex - c1x);
            dy = e30 * (c0y - cy) + e31 * (c1y - c0y) + e32 * (ey - c1y);
            A += w3 * (x * dy - y * dx) / 2;
            MX += w3 * x * x * dy / 2;
            MY -= w3 * y * y * dx / 2;
            x = k40 * cx + k41 * c0x + k42 * c1x + k43 * ex;
            y = k40 * cy + k41 * c0y + k42 * c1y + k43 * ey;
            dx = e40 * (c0x - cx) + e41 * (c1x - c0x) + e42 * (ex - c1x);
            dy = e40 * (c0y - cy) + e41 * (c1y - c0y) + e42 * (ey - c1y);
            A += w4 * (x * dy - y * dx) / 2;
            MX += w4 * x * x * dy / 2;
            MY -= w4 * y * y * dx / 2;
        }
        cx = ex; cy = ey; nc = 0;
    }
    out[0] = A; out[1] = MX; out[2] = MY;
    return out;
}

function loopIntegrals(pts) { return loopIntegralsInto(pts, [0, 0, 0]); }

// Bin number, round half up.
function fpRound(v, q) { return Math.floor(v / q + 0.5); }

// Six terms at 9 significant digits, or "none".
function shaderMatrixKey(m) {
    if (!m || typeof m !== "object") return "none";
    var f = ["xx", "xy", "yx", "yy", "ox", "oy"], out = [];
    for (var i = 0; i < f.length; i++) {
        var v = m[f[i]];
        out.push(typeof v === "number" ? Number(v.toPrecision(9)).toString() : String(v));
    }
    return out.join(",");
}

exports.makeLog = makeLog;
exports.confirm = confirm;
exports.pumpEvents = pumpEvents;
exports.makeProgress = makeProgress;
exports.requireApi = requireApi;
exports.hasGuiSession = hasGuiSession;
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
exports.readFileByteArray = readFileByteArray;
exports.byteArrayBytes = byteArrayBytes;
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
exports.backupProject = backupProject;
exports.backupNote = backupNote;
exports.robocopySummary = robocopySummary;
exports.robocopyErrors = robocopyErrors;
exports.fileTimeMs = fileTimeMs;
exports.backupInUse = backupInUse;
exports.parseDefaultLayers = parseDefaultLayers;
exports.formatDefaultLayers = formatDefaultLayers;
exports.sbpNodeName = sbpNodeName;
exports.clamp01 = clamp01;
exports.to255 = to255;
exports.colorHex = colorHex;
exports.shortHash = shortHash;
exports.isBridgePalette = isBridgePalette;
exports.captureColorView = captureColorView;
exports.restoreColorView = restoreColorView;
exports.cameraFields = cameraFields;
exports.panelTimeToFrame = panelTimeToFrame;
exports.panelFrameToTime = panelFrameToTime;
exports.cameraTimeToFrame = cameraTimeToFrame;
exports.cameraFrameToTime = cameraFrameToTime;
exports.sceneFrameCount = sceneFrameCount;
exports.cameraKeyFrames = cameraKeyFrames;
exports.cameraKfsDiff = cameraKfsDiff;
exports.cameraKfsMatch = cameraKfsMatch;
exports.readCameraBase = readCameraBase;
exports.writeCameraBase = writeCameraBase;
exports.cameraBaseLocal = cameraBaseLocal;
exports.cameraMergeKind = cameraMergeKind;
exports.wrapDeg = wrapDeg;
exports.layerPoseAt = layerPoseAt;
exports.poseToSbp = poseToSbp;
exports.sbpToPose = sbpToPose;
exports.isIdentityPose = isIdentityPose;
exports.newSha256 = newSha256;
exports.sha256Hex = sha256Hex;
exports.shaByte = shaByte;
exports.fileSha256 = fileSha256;
exports.isSha256Hex = isSha256Hex;
exports.shaAddString = shaAddString;
exports.shortSha256Hex = shortSha256Hex;
exports.codeMemberRange = codeMemberRange;
exports.archivePanelDigest = archivePanelDigest;
exports.TILE_SIZE = TILE_SIZE;
exports.isValidTileSize = isValidTileSize;
exports.TEXTURE_INT_MAX = TEXTURE_INT_MAX;
exports.pageEntryName = pageEntryName;
exports.pagePrefixOf = pagePrefixOf;
exports.isPageName = isPageName;
exports.layerTextureLink = layerTextureLink;
exports.sharedTextureLink = sharedTextureLink;
exports.isTextureLink = isTextureLink;
exports.TEXTURE_PATH_ID_RE = TEXTURE_PATH_ID_RE;
exports.parseTextureFileBytes = parseTextureFileBytes;
exports.isArray = isArray;
exports.PAGE_MAX = PAGE_MAX;
exports.PARSER_PAGE_DRAWING_UNITS = PARSER_PAGE_DRAWING_UNITS;
exports.DRAWING_UNITS_PER_FRAME_H = DRAWING_UNITS_PER_FRAME_H;
exports.pageSlot = pageSlot;
exports.pageLayout = pageLayout;
exports.pngPageProblem = pngPageProblem;
exports.byteOrder = byteOrder;
exports.loadIdMap = loadIdMap;
exports.saveIdMap = saveIdMap;
exports.newIdEntry = newIdEntry;
exports.idEntryRecordsShared = idEntryRecordsShared;
exports.stampBaseline = stampBaseline;
exports.idEntryFingerprint = idEntryFingerprint;
exports.changedSinceExchange = changedSinceExchange;
exports.FINGERPRINT_FORM = FINGERPRINT_FORM;
exports.FP_AREA_QUANTUM = FP_AREA_QUANTUM;
exports.FP_MOMENT_QUANTUM = FP_MOMENT_QUANTUM;
exports.FpHash = FpHash;
exports.fpToken = fpToken;
exports.fpExact = fpExact;
exports.sha256OfString = sha256OfString;
exports.loopIntegrals = loopIntegrals;
exports.loopIntegralsInto = loopIntegralsInto;
exports.fpRound = fpRound;
exports.shaderMatrixKey = shaderMatrixKey;
exports.panelSharedKeys = panelSharedKeys;
exports.archiveIdOf = archiveIdOf;
exports.drawingTexts = drawingTexts;
exports.readNativeLayers = readNativeLayers;
exports.writeNativeLayers = writeNativeLayers;
exports.projectDir = projectDir;
exports.sharedDrawingKey = sharedDrawingKey;
exports.sharedDrawingDefaultId = sharedDrawingDefaultId;
exports.sharedDrawingArchiveId = sharedDrawingArchiveId;
exports.sharedDrawingKeyOf = sharedDrawingKeyOf;
exports.sharedDrawingIdentity = sharedDrawingIdentity;
exports.sharedArtUnchanged = sharedArtUnchanged;
exports.recordedFileUnchanged = recordedFileUnchanged;
exports.sharedLinkMode = sharedLinkMode;
exports.makeLayerClipboard = makeLayerClipboard;
