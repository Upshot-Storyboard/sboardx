// TB_MergeSboardx.js — "Update from .sboardx": the 3-way, panel-level merge
// of an .sboardx archive into the open Storyboard Pro project (the
// counterpart of Upshot's "Update from .sboardx…"). Entry points only: the
// implementation is sboardx_merge.js (with sboardx_common.js,
// sboardx_import.js and sboardx_export.js), loaded via require() so the
// Scripts Manager lists nothing but these functions. Keep all seven files
// in the same folder. See README.md ("Merge").
// Batch (no dialog; the options decide):
//   StoryboardPro -scene p.sboard -compile TB_MergeSboardx.js
//     -script "TB_MergeSboardxFromFile('C:/in/file.sboardx', true, {takeTheirs: 'all'})"

function TB_MergeSboardx() {
    var zipPath = FileDialog.getOpenFileName("*.sboardx", "Update from .sboardx");
    if (zipPath) TB_MergeSboardxFromFile(String(zipPath), false, null);
}

// options: { takeTheirs: "all" | [archive panel ids], deleteRemoved: bool,
//            keepInPlace: [archive panel ids], takeCameras: "all" | [archive scene ids],
//            takeAudio: bool }
function TB_MergeSboardxFromFile(zipPath, quiet, options) {
    var impl;
    try { impl = require("./sboardx_merge.js"); } catch (e) {
        var msg = "The sboardx helper scripts were not found next to this script (" + e + ").";
        if (quiet) MessageLog.error("[sboardx] " + msg); else MessageBox.critical(msg);
        return false;
    }
    return impl.mergeFromFile(zipPath, quiet, options);
}
