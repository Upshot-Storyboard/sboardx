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

function runProcess(args, warn) {
    if (typeof Process2 == "undefined") {
        if (warn) warn("the Process2 scripting API is unavailable");
        return -1;
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
            return -1;
        }
    } catch (e) {
        if (warn) warn("could not create external process '" + a[0] + "': " + e);
        return -1;
    }
    var launchCode = p.launch();
    var t0 = new Date().getTime();
    while (p.isAlive() && new Date().getTime() - t0 < 120000) {
        System.processOneEvent();
    }
    if (p.isAlive()) {
        p.terminate();
        return -1;
    }
    var err = p.errorCode();
    return err !== 0 ? err : launchCode;
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

function createStoreZip(stagingDir, entries, zipPath, warn) {
    try { new File(zipPath).remove(); } catch (e) {}
    var tarArgs = ["tar", "--format=zip", "--options", "zip:compression=store",
                   "-cf", zipPath, "-C", stagingDir].concat(entries);
    runProcess(tarArgs, warn);
    if (!fileExists(zipPath) && about.isMacArch()) {
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
