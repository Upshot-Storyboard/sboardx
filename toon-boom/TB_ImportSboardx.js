// TB_ImportSboardx.js: imports a .sboardx (1.0, 1.1, 1.2) into the open
// project. Entry points only, the code is in sboardx_import.js (require()
// keeps the Scripts Manager list clean). Keep all seven files together.
// See README.md.
// Batch: StoryboardPro -scene p.sboard -batch -compile TB_ImportSboardx.js
//        -script "TB_ImportSboardxFromFile('C:/in/file.sboardx', true)"

function TB_ImportSboardx() {
    var zipPath = FileDialog.getOpenFileName("*.sboardx", "Import .sboardx storyboard");
    if (zipPath) TB_ImportSboardxFromFile(String(zipPath), false);
}

// options: { replaceExisting: bool, applyLayerLayout: bool }
function TB_ImportSboardxFromFile(zipPath, quiet, options) {
    var impl;
    try { impl = require("./sboardx_import.js"); } catch (e) {
        var msg = "The sboardx helper scripts were not found next to this script (" + e + ").";
        if (quiet) MessageLog.error("[sboardx] " + msg); else MessageBox.critical(msg);
        return false;
    }
    return impl.importFromFile(zipPath, quiet, options);
}

// Replaces the project's scenes.
function TB_ImportSboardxReplacing(zipPath, quiet) {
    return TB_ImportSboardxFromFile(zipPath, quiet, { replaceExisting: true });
}
