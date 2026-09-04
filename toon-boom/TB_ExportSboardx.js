// TB_ExportSboardx.js — writes the open Storyboard Pro project as a .sboardx
// (1.0) archive. Thin entry points only: the implementation lives in
// sboardx_export.js (which needs sboardx_common.js), loaded via require(), so
// SBP's Scripts Manager lists nothing but these functions. Keep all three
// files in the same folder.
// Implementation notes and probed SBP behavior: see README.md.
// Batch: StoryboardPro -scene p.sboard -batch -compile TB_ExportSboardx.js
//        -script "TB_ExportSboardxToFile('C:/out/file.sboardx', true)"

function TB_ExportSboardx() {
    var zipPath = FileDialog.getSaveFileName("*.sboardx", "Export .sboardx storyboard");
    if (!zipPath || String(zipPath).length === 0) return;
    TB_ExportSboardxToFile(String(zipPath), false);
}

function TB_ExportSboardxToFile(zipPath, quiet) {
    var impl;
    try { impl = require("./sboardx_export.js"); } catch (e) {
        var msg = "sboardx_export.js was not found. Install it in the same " +
                  "folder as this script.";
        if (quiet) MessageLog.error("[sboardx-export] " + msg);
        else MessageBox.critical(msg);
        return;
    }
    impl.exportToFile(zipPath, quiet);
}
