// TB_ImportSboardx.js — imports a .sboardx (1.0) archive into the open
// Storyboard Pro project. Thin entry points only: the implementation lives in
// sboardx_import.js (which needs sboardx_common.js), loaded via require(), so
// SBP's Scripts Manager lists nothing but these functions. Keep all three
// files in the same folder.
// Implementation notes and probed SBP behavior: see README.md.
// Batch: StoryboardPro -scene p.sboard -batch -compile TB_ImportSboardx.js
//        -script "TB_ImportSboardxFromFile('C:/in/file.sboardx', true)"

function TB_ImportSboardx() {
    var zipPath = FileDialog.getOpenFileName("*.sboardx", "Import .sboardx storyboard");
    if (!zipPath || String(zipPath).length === 0) return;
    TB_ImportSboardxFromFile(String(zipPath), false);
}

function TB_ImportSboardxReplacing(zipPath, quiet) {
    var impl;
    try { impl = require("./sboardx_import.js"); } catch (e) {
        var msg = "sboardx_import.js was not found. Install it in the same " +
                  "folder as this script.";
        if (quiet) MessageLog.error("[sboardx] " + msg);
        else MessageBox.critical(msg);
        return false;
    }
    return impl.importReplacing(zipPath, quiet);
}

function TB_ImportSboardxFromFile(zipPath, quiet, options) {
    var impl;
    try { impl = require("./sboardx_import.js"); } catch (e) {
        var msg = "sboardx_import.js was not found. Install it in the same " +
                  "folder as this script.";
        if (quiet) MessageLog.error("[sboardx] " + msg);
        else MessageBox.critical(msg);
        return false;
    }
    return impl.importFromFile(zipPath, quiet, options);
}
