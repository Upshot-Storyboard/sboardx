// sboardx_common.js — helpers shared by sboardx_import.js and
// sboardx_export.js (the implementation modules behind TB_ImportSboardx.js /
// TB_ExportSboardx.js). Keep all five files in the same folder.

function makeLog(prefix, quiet) {
    var warnings = [];
    return {
        warnings: warnings,
        report: function (msg, isError) {
            if (quiet) {
                if (isError) MessageLog.error(prefix + msg);
                else MessageLog.trace(prefix + msg);
            } else if (isError) {
                MessageBox.critical(msg);
            } else {
                MessageBox.information(msg);
            }
        },
        trace: function (msg) {
            MessageLog.trace(prefix + msg);
        },
        warn: function (msg) {
            MessageLog.error(prefix + msg);
            warnings.push(msg);
        }
    };
}

// A window-modal progress dialog with a Cancel button. Every method is safe
// to call when the dialog could not be created (batch mode, or a build
// without the QProgressDialog binding): it then does nothing.
//
// Probed on SBP: the binding exposes Qt *slots* as methods (setValue,
// setLabelText, setRange, setMinimumDuration, show, close, repaint) and
// Q_PROPERTYs as plain properties (autoClose, windowModality, wasCanceled,
// minimumWidth). Ordinary methods such as setAutoClose() or setModal() are
// "not a function", so everything non-slot goes through properties, and
// each optional call is isolated so one failure cannot lose the dialog.
function makeProgress(title, quiet) {
    var dlg = null;
    var done = 0, total = 0;
    var reported = {};
    // Problems with the dialog must never break the export, but they should
    // be visible once in the Message Log.
    var note = function (what, e) {
        if (reported[what]) return;
        reported[what] = true;
        try { MessageLog.trace("[sboardx] progress dialog: " + what + " failed: " + e); }
        catch (e2) {}
    };
    // Set a Qt property, trying the setter slot first when one exists.
    var set = function (prop, setter, value) {
        try {
            if (typeof dlg[setter] == "function") { dlg[setter](value); return; }
        } catch (e) { note(setter, e); }
        try { dlg[prop] = value; } catch (e2) { note(prop, e2); }
    };
    // The script keeps the UI thread busy, so the dialog only repaints when
    // we make it: force a paint, then drain a burst of pending events.
    var pump = function () {
        try { if (dlg) dlg.repaint(); } catch (e) { note("repaint", e); }
        try {
            if (typeof QCoreApplication != "undefined" &&
                typeof QCoreApplication.processEvents == "function") {
                QCoreApplication.processEvents();
                return;
            }
        } catch (e3) { note("QCoreApplication.processEvents", e3); }
        try {
            if (typeof QApplication != "undefined" &&
                typeof QApplication.processEvents == "function") {
                QApplication.processEvents();
                return;
            }
        } catch (e7) { note("QApplication.processEvents", e7); }
        try { for (var i = 0; i < 10; i++) System.processOneEvent(); }
        catch (e4) { note("processOneEvent", e4); }
    };
    if (!quiet) {
        try {
            dlg = new QProgressDialog(title, "Cancel", 0, 100);
        } catch (e6) {
            note("create", e6);
            dlg = null;
        }
    }
    if (dlg) {
        set("windowTitle", "setWindowTitle", title);
        // Modal matters: QProgressDialog only pumps events inside
        // setValue() when it is modal.
        set("windowModality", "setWindowModality", enumOr(Qt.WindowModal, 1));
        set("minimumDuration", "setMinimumDuration", 0);
        set("autoClose", "setAutoClose", false);
        set("autoReset", "setAutoReset", false);
        set("minimumWidth", "setMinimumWidth", 420);
        try { dlg.show(); } catch (e9) { note("show", e9); }
        pump();
    }
    return {
        // Total number of steps (0 = busy indicator with no known length).
        begin: function (n) {
            if (!dlg) return;
            done = 0; total = n;
            try { dlg.setRange(0, n); dlg.setValue(0); pump(); }
            catch (e) { note("begin", e); }
        },
        // Advance one step, showing what is being worked on.
        step: function (label) {
            if (!dlg) return;
            done++;
            try {
                dlg.setLabelText(done + " of " + total + " — " + label);
                dlg.setValue(done);
                pump();
            } catch (e) { note("step", e); }
        },
        // Switch to a busy indicator for a phase with no step count.
        busy: function (label) {
            if (!dlg) return;
            try { dlg.setLabelText(label); dlg.setRange(0, 0); pump(); }
            catch (e) { note("busy", e); }
        },
        cancelled: function () {
            if (!dlg) return false;
            try {
                var c = dlg.wasCanceled;
                if (typeof c == "function") c = dlg.wasCanceled();
                return c === true;
            } catch (e) { note("wasCanceled", e); return false; }
        },
        close: function () {
            if (!dlg) return;
            var d = dlg;
            dlg = null;   // pump() must not repaint a dialog being deleted
            try { d.close(); } catch (e) { note("close", e); }
            try { d.hide(); } catch (e2) {}
            try { d.deleteLater(); } catch (e3) {}
            pump();
        }
    };
}

function readTextFile(path) {
    var f = new File(path);
    if (!f.exists) return null;
    try {
        f.open(FileAccess.ReadOnly);
        var text = f.read();
        f.close();
        return text;
    } catch (e) {
        return null;
    }
}

function writeTextFile(path, text) {
    var f = new File(path);
    f.open(FileAccess.WriteOnly);
    f.write(text);
    f.close();
}

function readJsonFile(path) {
    var text = readTextFile(path);
    if (text === null) return null;
    try {
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}

function fileExists(path) {
    return new File(path).exists;
}

function fileBasename(path) {
    var s = String(path).replace(/\\/g, "/");
    var i = s.lastIndexOf("/");
    return i >= 0 ? s.substring(i + 1) : s;
}

function makeTempDir(kind) {
    var dir = String(specialFolders.temp).replace(/\\/g, "/") +
              "/sboardx-" + kind + "-" + new Date().getTime();
    new Dir(dir).mkdirs();
    return dir;
}

function xmlEscape(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function enumOr(value, fallback) {
    return value === undefined || value === null ? fallback : value;
}

// Runs a command through Process2 and waits for it, pumping the event loop
// so a progress dialog stays live. There is no time limit; an optional
// isCancelled() callback (the dialog's Cancel button) terminates the
// process instead. Returns { code, cancelled, elapsedMs, message }: `code`
// is 0 on a clean exit, the process's error code otherwise, and -1 when it
// could not be started or was cancelled. `message` is Process2's own error
// text when the API provides one.
function runProcess(args, warn, isCancelled) {
    var failed = function (message) {
        return { code: -1, cancelled: false, elapsedMs: 0, message: message };
    };
    if (typeof Process2 == "undefined") {
        if (warn) warn("the Process2 scripting API is unavailable");
        return failed("Process2 unavailable");
    }
    var a = args;
    var p;
    try {
        if (a.length === 3) p = new Process2(a[0], a[1], a[2]);
        else if (a.length === 4) p = new Process2(a[0], a[1], a[2], a[3]);
        else if (a.length === 5) p = new Process2(a[0], a[1], a[2], a[3], a[4]);
        else if (a.length === 6) p = new Process2(a[0], a[1], a[2], a[3], a[4], a[5]);
        else if (a.length === 12) p = new Process2(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9], a[10], a[11]);
        else if (a.length === 13) p = new Process2(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9], a[10], a[11], a[12]);
        else {
            if (warn) warn("runProcess: unsupported arg count " + a.length);
            return failed("unsupported arg count " + a.length);
        }
    } catch (e) {
        if (warn) warn("could not create external process '" + a[0] + "': " + e);
        return failed(String(e));
    }
    var t0 = new Date().getTime();
    var launchCode = p.launch();
    var cancelled = false;
    while (p.isAlive()) {
        System.processOneEvent();
        if (isCancelled && isCancelled()) { cancelled = true; break; }
    }
    var elapsedMs = new Date().getTime() - t0;
    var message = "";
    try {
        if (typeof p.errorMessage == "function") message = String(p.errorMessage() || "");
    } catch (e2) {}
    if (cancelled) {
        p.terminate();
        if (warn) warn("'" + a[0] + "' was cancelled after " +
            Math.round(elapsedMs / 1000) + " s");
        return { code: -1, cancelled: true, elapsedMs: elapsedMs, message: message };
    }
    var err = p.errorCode();
    return { code: err !== 0 ? err : launchCode, cancelled: false,
             elapsedMs: elapsedMs, message: message };
}

function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
function shQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

// Process2 does not expose the child's stderr, so to see what a failing
// command actually said we run it again through a shell that redirects
// stderr and the exit code into logPath. Returns the captured text, or null
// when the wrapper itself produced nothing.
function runCaptured(args, logPath, warn) {
    try { new File(logPath).remove(); } catch (e) {}
    if (about.isWindowsArch()) {
        // Single quotes only, so nothing has to survive Process2's own
        // argument quoting. PowerShell 5.1 wraps each stderr line in an
        // error record, so the log is verbose but complete; a missing 'tar'
        // lands in the catch.
        var out = " | Out-File -Append -Encoding utf8 -LiteralPath " + psQuote(logPath);
        var ps = "try { & " + args.map(psQuote).join(" ") + " 2> " + psQuote(logPath) +
            " } catch { $_.ToString()" + out + " }; " +
            "('exit code ' + $LASTEXITCODE)" + out;
        runProcess(["powershell", "-NoProfile", "-Command", ps], warn);
    } else {
        var cmd = args.map(shQuote).join(" ") + " 2>" + shQuote(logPath) +
                  "; echo \"exit code $?\" >>" + shQuote(logPath);
        runProcess(["sh", "-c", cmd], warn);
    }
    var text = readTextFile(logPath);
    if (text === null) return null;
    text = String(text).replace(/^\s+|\s+$/g, "");
    return text;
}

// Turns a runProcess result into a warning line naming the command.
function describeProcessResult(name, r, warn) {
    var secs = (r.elapsedMs / 1000).toFixed(1) + " s";
    warn("'" + name + "' " + (r.code === 0 ? "exited cleanly" : "failed with code " + r.code) +
         " after " + secs + " but produced no output file" +
         (r.message ? " (" + r.message + ")" : ""));
}

function extractZip(zipPath, destPath, warn) {
    new Dir(destPath).mkdirs();
    runProcess(["tar", "-xf", zipPath, "-C", destPath], warn);
    if (fileExists(destPath + "/project.json")) return true;
    if (about.isMacArch()) {
        runProcess(["/usr/bin/unzip", "-o", zipPath, "-d", destPath], warn);
    } else if (about.isWindowsArch()) {
        var cmd = "Copy-Item -LiteralPath '" + zipPath + "' -Destination '" +
            destPath + "/archive.zip'; " +
            "Expand-Archive -LiteralPath '" + destPath + "/archive.zip' " +
            "-DestinationPath '" + destPath + "' -Force";
        runProcess(["powershell", "-NoProfile", "-Command", cmd], warn);
    } else {
        runProcess(["unzip", "-o", zipPath, "-d", destPath], warn);
    }
    return fileExists(destPath + "/project.json");
}

// Throws { sboardxCancelled: true } when isCancelled() stops the zip.
function createStoreZip(stagingDir, entries, zipPath, warn, isCancelled) {
    try { new File(zipPath).remove(); } catch (e) {}
    if (fileExists(zipPath)) {
        warn("could not delete the existing " + zipPath +
             " (is it open in another program?)");
    }
    var tarArgs = ["tar", "--format=zip", "--options", "zip:compression=store",
                   "-cf", zipPath, "-C", stagingDir].concat(entries);
    var r = runProcess(tarArgs, warn, isCancelled);
    if (r.cancelled) {
        try { new File(zipPath).remove(); } catch (e1) {}
        throw { sboardxCancelled: true };
    }
    if (fileExists(zipPath)) return true;
    describeProcessResult("tar", r, warn);
    // Diagnostic re-run with tar's own stderr and exit code captured.
    var logPath = stagingDir + "/tar-stderr.txt";
    var said = runCaptured(tarArgs, logPath, warn);
    if (said === null) {
        warn("no output could be captured from 'tar' (the shell wrapper itself " +
             "produced nothing)");
    } else {
        warn("'tar' said (" + logPath + "):\n" + (said || "(nothing)"));
    }
    if (fileExists(zipPath)) {
        warn("the re-run through the shell produced the zip; only the direct " +
             "launch of 'tar' from Storyboard Pro failed");
        return true;
    }
    if (about.isMacArch()) {
        runProcess(["sh", "-c",
                    "cd '" + stagingDir + "' && /usr/bin/zip -r -X -0 '" +
                    zipPath + "' " + entries.join(" ")], warn);
    }
    return fileExists(zipPath);
}

function copyFile(src, dst, warn) {
    try {
        if (typeof QFile != "undefined" && typeof QFile.copy == "function") {
            try { new File(dst).remove(); } catch (e) {}
            if (QFile.copy(src, dst)) return true;
        }
    } catch (e2) {}
    if (about.isWindowsArch()) {
        runProcess(["cmd", "/c", "copy", "/Y", src.replace(/\//g, "\\"),
                    dst.replace(/\//g, "\\")], warn);
    } else {
        runProcess(["cp", src, dst], warn);
    }
    return fileExists(dst);
}

function imageSize(path) {
    try {
        if (typeof QImage == "undefined") return null;
        var im = new QImage(path);
        if (im.isNull()) return null;
        return { w: im.width(), h: im.height() };
    } catch (e) {
        return null;
    }
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

function cameraFields(frameH) {
    var perWorldY = project.numberOfUnitsY() / frameH;
    var perWorldX = perWorldY * 3 / 4;
    try {
        var ax = project.unitsAspectRatioX(), ay = project.unitsAspectRatioY();
        if (ax > 0 && ay > 0) perWorldX = perWorldY * ay / ax;
    } catch (e) {}
    return { perWorldX: perWorldX, perWorldY: perWorldY };
}

exports.makeLog = makeLog;
exports.makeProgress = makeProgress;
exports.readTextFile = readTextFile;
exports.writeTextFile = writeTextFile;
exports.readJsonFile = readJsonFile;
exports.fileExists = fileExists;
exports.fileBasename = fileBasename;
exports.makeTempDir = makeTempDir;
exports.xmlEscape = xmlEscape;
exports.enumOr = enumOr;
exports.runProcess = runProcess;
exports.extractZip = extractZip;
exports.createStoreZip = createStoreZip;
exports.copyFile = copyFile;
exports.imageSize = imageSize;
exports.findPanelCaption = findPanelCaption;
exports.ensurePanelCaption = ensurePanelCaption;
exports.cameraFields = cameraFields;
