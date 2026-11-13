// TB_ExportSboardx.js: exports the open project as a .sboardx (1.2).
// Entry points only, the code is in sboardx_export.js (require() keeps the
// Scripts Manager list clean). Keep all seven files together. See README.md.
// Batch: StoryboardPro -scene p.sboard -batch -compile TB_ExportSboardx.js
//        -script "TB_ExportSboardxToFile('C:/out/file.sboardx', true)"

function TB_ExportSboardx() {
    var zipPath = FileDialog.getSaveFileName("*.sboardx", "Export .sboardx storyboard");
    if (zipPath) TB_ExportSboardxToFile(String(zipPath), false);
}

function TB_ExportSboardxToFile(zipPath, quiet) {
    var impl;
    try { impl = require("./sboardx_export.js"); } catch (e) {
        var msg = "The sboardx helper scripts were not found next to this script (" + e + ").";
        if (quiet) MessageLog.error("[sboardx-export] " + msg); else MessageBox.critical(msg);
        return false;
    }
    return impl.exportToFile(zipPath, quiet);
}
