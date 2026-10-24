// TB_ExportSboardx.js — writes the open Storyboard Pro project as a .sboardx
// (1.1) archive. Entry points only: the implementation is sboardx_export.js
// (with sboardx_common.js), loaded via require() so the Scripts Manager
// lists nothing but these functions. Keep all seven files in the same
// folder. See README.md.
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
