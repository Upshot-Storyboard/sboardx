// sboardx_import.js — implementation module for TB_ImportSboardx.js, loaded
// via require(). NOT a user-facing script: never import it into the Scripts
// Manager. It exists because SBP's script picker lists every global function
// of an imported script (evaluating the file, so no syntax trick at global
// scope hides them) — module scope is the reliable way to keep internals out
// of that list. Needs sboardx_common.js in the same folder.
// Implementation notes and probed SBP behavior: see README.md.

function importReplacing(zipPath, quiet) {
    if (!importFromFile(zipPath, quiet, { replaceExisting: true })) return false;
    try { project.saveAll(); } catch (e) {
        MessageLog.error("[sboardx] project.saveAll failed: " + e);
    }
    return true;
}

function importFromFile(zipPath, quiet, options) {
    var common = sboardxImportCommon(quiet);
    if (!common) return false;
    var log = common.makeLog("[sboardx] ", quiet);

    var env = makeImportEnv(common, log, options);
    if (!checkScriptingSurface(env)) return false;

    // The same window-modal progress dialog as the export (one step per
    // panel, busy phases around it, Cancel honoured between panels).
    env.progress = common.makeProgress("Importing .sboardx", quiet);
    zipPath = String(zipPath);
    env.progress.busy("Extracting the archive…");
    if (!extractArchive(env, zipPath)) { env.progress.close(); return false; }
    env.progress.busy("Reading the archive…");
    if (!loadSboardx(env)) { env.progress.close(); return false; }

    var preExistingScenes = listExistingScenes(env);

    project.beginUndoRedoAccum("Import sboardx");
    try {
        applyProjectSettings(env);
        env.progress.begin(env.sequenceJson.panels.length);
        importScenes(env);
        env.progress.busy("Creating sequences…");
        importSequences(env);
        recordImportMetadata(env, zipPath);
        if (env.replaceExisting) {
            env.progress.busy("Removing the previous scenes…");
            deleteScenes(env, preExistingScenes);
        }
        env.progress.busy("Importing audio…");
        importAudio(env, globalStartFrameOf(env, env.firstImportedPanel));
        project.endUndoRedoAccum();
    } catch (err) {
        // Cancel and failure both roll the whole import back (one undo
        // accumulation), so the project is as it was.
        project.cancelUndoRedoAccum();
        env.progress.close();
        if (err && err.sboardxCancelled) {
            log.report("Import cancelled. The project was not changed.", true);
        } else {
            log.report("sboardx import failed: " + err, true);
        }
        return false;
    }
    env.progress.close();

    if (env.firstImportedPanel) {
        try { env.selMgr.setCurrentPanel(env.firstImportedPanel); } catch (e) {}
    }
    log.report(importSummary(env), false);
    return true;
}

function sboardxImportCommon(quiet) {
    try {
        return require("./sboardx_common.js");
    } catch (e) {
        var msg = "sboardx_common.js was not found. Install it in the same " +
                  "folder as this script.";
        if (quiet) MessageLog.error("[sboardx] " + msg);
        else MessageBox.critical(msg);
        return null;
    }
}

function makeImportEnv(common, log, options) {
    return {
        common: common,
        log: log,
        replaceExisting: !!(options && options.replaceExisting),
        sb: new StoryboardManager(),
        lm: new LayerManager(),
        cm: new CaptionManager(),
        selMgr: new SelectionManager(),
        extractDir: "",
        projectJson: null,
        sequenceJson: null,
        groups: [],
        fps: 24,
        notesCaption: "",
        dialogueCaption: "",
        firstImportedPanel: "",
        scratchPalette: null,
        sceneIdMap: {},   // source scene id -> Storyboard Pro scene id
        counts: { scenes: 0, panels: 0, layers: 0, imageLayers: 0,
                  blurredLayers: 0, failedLayers: 0, camScenes: 0,
                  camApplied: 0, groups: 0, animatedLayers: 0,
                  opacityTracks: 0, sequences: 0, sequencesFailed: 0 }
    };
}

function checkScriptingSurface(env) {
    if (typeof importer == "undefined" ||
        typeof DrawingTools == "undefined" ||
        typeof Tools == "undefined" ||
        typeof PaletteObjectManager == "undefined" ||
        typeof MotionManager == "undefined" ||
        typeof FunctionManager == "undefined" ||
        typeof env.lm.addVectorLayer != "function") {
        env.log.report("This script needs the vector-import and camera " +
            "scripting API (importer.parseSVG, DrawingTools, MotionManager, ...) " +
            "introduced in Storyboard Pro 24.\n\n" +
            "Please run it in Storyboard Pro 24 or newer.", true);
        return false;
    }
    return true;
}

function extractArchive(env, zipPath) {
    env.extractDir = env.common.makeTempDir("import");
    env.log.trace("extracting " + zipPath);
    if (!env.common.extractZip(zipPath, env.extractDir, env.log.warn)) {
        env.log.report("Could not extract the .sboardx archive.\n\n" +
            "Extraction needs 'tar' (Windows 10+ / macOS) or 'unzip' on PATH.", true);
        return false;
    }
    return true;
}

function loadSboardx(env) {
    var projectJson = env.common.readJsonFile(env.extractDir + "/project.json");
    var sequenceJson = env.common.readJsonFile(env.extractDir + "/sequence.json");
    if (!projectJson || !sequenceJson || !sequenceJson.panels ||
        !sequenceJson.scenes || !sequenceJson.scenes.length) {
        env.log.report("Not a valid .sboardx file (project.json / sequence.json missing).", true);
        return false;
    }
    if (projectJson.sboardx !== "1.0" && projectJson.sboardx !== "1.1") {
        env.log.report("This importer reads sboardx 1.0 and 1.1 archives. This file is sboardx " +
            (projectJson.sboardx ? String(projectJson.sboardx) : "unknown") + ".", true);
        return false;
    }
    env.projectJson = projectJson;
    env.sequenceJson = sequenceJson;
    env.fps = (projectJson.canvas && projectJson.canvas.fps) ? projectJson.canvas.fps : 24;
    env.groups = groupScenes(sequenceJson);
    env.log.trace("sboardx " + projectJson.sboardx + " · " +
                  sequenceJson.panels.length + " panels · " + env.groups.length +
                  " scene(s) · " + env.fps + " fps");
    return true;
}

function groupScenes(sequenceJson) {
    var raw = sequenceJson.scenes;
    var panelIds = sequenceJson.panels;
    var byPanel = {};
    var s, i;
    for (s = 0; s < raw.length; s++) {
        var ps = raw[s].panels || [];
        for (i = 0; i < ps.length; i++) byPanel[ps[i]] = s;
    }
    var groups = [];
    var prev = -1;
    for (i = 0; i < panelIds.length; i++) {
        var si = byPanel.hasOwnProperty(panelIds[i]) ? byPanel[panelIds[i]] : prev;
        if (si < 0) si = 0;
        if (!groups.length || si !== prev) {
            // `name` is the archive's scene name (the display-code prefix
            // panels are matched against); the Storyboard Pro scene may be
            // named differently when it collides (see importScenes).
            groups.push({
                srcId: raw[si] && raw[si].id ? String(raw[si].id) : "",
                name: raw[si] && raw[si].name ? raw[si].name : ("Scene " + (groups.length + 1)),
                panels: [],
                keyframes: raw[si] && raw[si].camera && raw[si].camera.keyframes
                    ? raw[si].camera.keyframes : [],
                // Layer animation tracks (SPEC.md "layer_tracks"), applied
                // once the scene's panels exist.
                layerTracks: raw[si] && raw[si].layer_tracks ? raw[si].layer_tracks : []
            });
        }
        groups[groups.length - 1].panels.push(panelIds[i]);
        prev = si;
    }
    return groups;
}

function listExistingScenes(env) {
    var ids = [];
    for (var i = 0; i < env.sb.numberOfScenesInProject(); i++) {
        ids.push(String(env.sb.sceneInProject(i)));
    }
    return ids;
}

function applyProjectSettings(env) {
    if (project.getFrameRate() !== env.fps) project.setFrameRate(env.fps);
    env.notesCaption = env.common.ensurePanelCaption(env.cm, "Notes");
    env.dialogueCaption = env.common.ensurePanelCaption(env.cm, "Dialogue");
}

function importScenes(env) {
    var usedSceneNames = {};
    for (var g = 0; g < env.groups.length; g++) {
        var group = env.groups[g];

        var sceneName = group.name;
        var n = 2;
        while (usedSceneNames[sceneName]) { sceneName = group.name + " " + n; n++; }
        usedSceneNames[sceneName] = true;

        var sceneId = env.sb.appendScene(sceneName);
        if (!sceneId || String(sceneId).length === 0) {
            env.log.warn("could not create scene '" + sceneName + "', skipping its panels");
            continue;
        }
        env.counts.scenes++;
        if (group.srcId) env.sceneIdMap[group.srcId] = String(sceneId);

        var firstPanelId = importScenePanels(env, sceneId, group);
        if (group.layerTracks.length > 0 && firstPanelId) {
            env.progress.busy("Applying layer animation (scene " + group.name + ")…");
            applyLayerTracks(env, sceneId, group);
        }
        if (firstPanelId && group.srcId) {
            // Source scene id, for a re-export under the same id (the
            // sboardx-id metadata on panels; see sboardx_export.js).
            setSourceIdMetadata(env, firstPanelId, "sboardx-scene-id", group.srcId);
        }
        if (group.keyframes.length > 0 && firstPanelId) {
            if (applySceneCamera(env, sceneId, group.keyframes)) {
                env.counts.camApplied++;
            }
            env.sb.setPanelMetadata(firstPanelId, {
                name: "sboardx-camera",
                type: "string",
                creator: "TB_ImportSboardx",
                version: "1.0",
                value: JSON.stringify(group.keyframes)
            });
            env.counts.camScenes++;
        }
    }
}

function importScenePanels(env, sceneId, group) {
    var firstPanelId = "";
    var prevPanelId = "";
    group.sbpPanelIds = [];   // per source panel, "" when it failed
    for (var p = 0; p < group.panels.length; p++) {
        var srcId = group.panels[p];
        var meta = env.common.readJsonFile(env.extractDir + "/panels/" + srcId + "/panel.json");
        if (!meta) {
            env.log.warn("panel.json missing for " + srcId);
            group.sbpPanelIds.push("");
            continue;
        }

        var token = panelToken(meta, group.name) || String(p + 1);
        if (env.progress.cancelled()) throw { sboardxCancelled: true };
        env.progress.step("Panel " + token + " (scene " + group.name + ")");
        var panelId;
        if (p === 0 && env.sb.numberOfPanelsInScene(sceneId) > 0) {
            panelId = env.sb.panelInScene(sceneId, 0);
            var renamed = false;
            try { renamed = env.sb.renamePanel(panelId, token) === true; } catch (eR) {}
            if (!renamed) {
                env.log.warn("panel " + srcId + ": could not name the scene's first " +
                             "panel '" + token + "'");
            }
        } else {
            panelId = env.sb.insertPanel(true, prevPanelId, token);
            if ((!panelId || String(panelId).length === 0) && token !== String(p + 1)) {
                // A name Storyboard Pro refuses: fall back to its numbering.
                env.log.warn("panel " + srcId + ": name '" + token +
                             "' refused, numbered " + (p + 1) + " instead");
                panelId = env.sb.insertPanel(true, prevPanelId, String(p + 1));
            }
        }
        if (!panelId || String(panelId).length === 0) {
            env.log.warn("could not create panel for " + srcId);
            group.sbpPanelIds.push("");
            continue;
        }
        try {
            var got = String(env.sb.nameOfPanel(panelId));
            if (got !== token) {
                env.log.warn("panel " + srcId + ": named '" + got + "' by Storyboard Pro " +
                             "(wanted '" + token + "')");
            }
        } catch (eN) {}
        setSourceIdMetadata(env, panelId, "sboardx-id", srcId);
        group.sbpPanelIds.push(String(panelId));
        prevPanelId = panelId;
        if (p === 0) firstPanelId = panelId;
        if (!env.firstImportedPanel) env.firstImportedPanel = panelId;
        env.counts.panels++;

        env.sb.setPanelDuration(panelId, Math.max(1, Math.round(meta.dur * env.fps)));
        if (meta.note && String(meta.note).length > 0) {
            env.cm.setPanelCaptionText(env.notesCaption, panelId, String(meta.note));
        }
        if (meta.dialogue && String(meta.dialogue).length > 0) {
            env.cm.setPanelCaptionText(env.dialogueCaption, panelId, String(meta.dialogue));
        }

        importPanelLayers(env, panelId, srcId);
    }
    return firstPanelId;
}

// The panel's number: panel.json `code` is the display code
// "<scene name>-<token>" (Upshot's convention, and this exporter's); the
// token after the archive's scene name is the Storyboard Pro panel name. A
// code without the prefix is the token itself.
function panelToken(meta, sceneName) {
    var code = meta && meta.code !== undefined ? String(meta.code) : "";
    var prefix = sceneName + "-";
    if (code.length > prefix.length && code.substring(0, prefix.length) === prefix) {
        return code.substring(prefix.length);
    }
    return code;
}

// Source ids ride as panel metadata so TB_ExportSboardx can write the panel
// (and, from the scene's first panel, the scene) under the id it came with —
// an Upshot -> Storyboard Pro -> Upshot trip then keeps Upshot's ids.
function setSourceIdMetadata(env, panelId, name, value) {
    try {
        env.sb.setPanelMetadata(panelId, {
            name: name,
            type: "string",
            creator: "TB_ImportSboardx",
            version: "1.0",
            value: String(value)
        });
    } catch (e) {
        env.log.warn("could not record " + name + " on panel " + panelId + ": " + e);
    }
}

// sequence.json "sequences" (optional; contiguous runs of scene ids) ->
// Storyboard Pro sequences over the scenes just created. Each entry becomes
// one createSequence(first, last) per contiguous run of its created scenes
// (a single run for a well-formed file), renamed to the archive's name (made
// unique the way scene names are). A project that refuses (no sequence
// support, or the API missing) imports flat, as before.
function importSequences(env) {
    var entries = env.sequenceJson.sequences;
    if (!entries || !entries.length) return;
    if (typeof env.sb.createSequence != "function") {
        env.log.warn("sequences skipped: StoryboardManager.createSequence is not available");
        env.counts.sequencesFailed += entries.length;
        return;
    }
    var sceneIndex = {};
    try {
        for (var i = 0; i < env.sb.numberOfScenesInProject(); i++) {
            sceneIndex[String(env.sb.sceneInProject(i))] = i;
        }
    } catch (eI) {}
    // Names already taken, read ONCE up front (never probed per name: a
    // per-name sequenceId() lookup that answers non-empty for unknown names
    // would spin forever — that hung Storyboard Pro on the first run).
    var takenNames = {};
    try {
        var numSeqs = env.sb.numberOfSequencesInProject();
        for (var t = 0; t < numSeqs; t++) {
            var existing = String(env.sb.nameOfSequence(env.sb.sequenceInProject(t)) || "");
            if (existing) takenNames[existing] = true;
        }
        env.log.trace("sequences: project has " + numSeqs + " before the import");
    } catch (eT) {
        env.log.trace("sequences: existing names unavailable (" + eT + ")");
    }

    for (var q = 0; q < entries.length; q++) {
        var entry = entries[q];
        if (!entry || !entry.name || !entry.scenes || !entry.scenes.length) continue;
        var runs = [];
        var run = null;
        for (var s = 0; s < entry.scenes.length; s++) {
            var tbId = env.sceneIdMap[String(entry.scenes[s])];
            if (!tbId || !sceneIndex.hasOwnProperty(tbId)) continue;
            if (run && sceneIndex[tbId] === run.lastIndex + 1) {
                run.last = tbId;
                run.lastIndex = sceneIndex[tbId];
            } else {
                run = { first: tbId, last: tbId, lastIndex: sceneIndex[tbId] };
                runs.push(run);
            }
        }
        if (!runs.length) continue;
        if (runs.length > 1) {
            env.log.warn("sequence '" + entry.name + "' lists non-contiguous scenes; " +
                         "created as " + runs.length + " sequences");
        }
        for (var r = 0; r < runs.length; r++) {
            env.log.trace("sequence '" + entry.name + "': createSequence(" + runs[r].first +
                          ", " + runs[r].last + ")");
            var seqId = "";
            try { seqId = String(env.sb.createSequence(runs[r].first, runs[r].last) || ""); }
            catch (eC) { env.log.warn("createSequence failed for '" + entry.name + "': " + eC); }
            if (!seqId) {
                env.log.warn("sequence '" + entry.name + "' could not be created " +
                             "(does the project have sequences enabled?)");
                env.counts.sequencesFailed++;
                continue;
            }
            var name = uniqueSequenceName(String(entry.name), takenNames);
            env.log.trace("sequence " + seqId + ": renameSequence -> '" + name + "'");
            try {
                if (env.sb.renameSequence(seqId, name) !== true) {
                    env.log.warn("sequence " + seqId + " could not be named '" + name + "'");
                }
            } catch (eR) {
                env.log.warn("renameSequence failed for '" + name + "': " + eR);
            }
            env.counts.sequences++;
        }
    }
}

// Sequence names are unique in Storyboard Pro like scene names: a name
// already taken (by a pre-existing sequence or one made earlier in this
// import) becomes "<name> 2", "<name> 3", ... — the importScenes convention,
// against a set read once (bounded; no API probing per candidate).
function uniqueSequenceName(wanted, takenNames) {
    var name = wanted;
    for (var n = 2; takenNames[name] && n < 1000; n++) name = wanted + " " + n;
    takenNames[name] = true;
    return name;
}

function recordImportMetadata(env, zipPath) {
    env.sb.setProjectMetadata({
        name: "sboardx-source",
        type: "string",
        creator: "TB_ImportSboardx",
        version: "1.0",
        value: JSON.stringify({ file: zipPath, name: env.projectJson.name,
                                episode: env.projectJson.episode,
                                version: env.projectJson.sboardx })
    });
    if (env.counts.camScenes > 0) {
        var camText = "Camera moves from " + (env.projectJson.name || "sboardx") +
                      " (applied to the scene cameras):\n";
        for (var c = 0; c < env.groups.length; c++) {
            if (env.groups[c].keyframes.length === 0) continue;
            camText += "\n" + env.groups[c].name + ": " +
                       cameraSummary(env.groups[c].keyframes) + "\n";
        }
        env.cm.addProjectCaption("sboardx Camera");
        env.cm.setProjectCaptionText("sboardx Camera", camText);
    }
}

function cameraSummary(kfs) {
    if (!kfs || kfs.length === 0) return "no camera move";
    var parts = [];
    for (var i = 0; i < kfs.length; i++) {
        var k = kfs[i];
        parts.push("t=" + k.t + "s zoom=" + Math.round(k.z * 100) + "%" +
                   " center=(" + k.cx + ", " + k.cy + ")" +
                   (k.rot ? " rot=" + k.rot + "°" : ""));
    }
    return kfs.length + " keyframe(s): " + parts.join(" → ");
}

function deleteScenes(env, sceneIds) {
    for (var i = 0; i < sceneIds.length; i++) {
        try {
            if (!env.sb.deleteScene(sceneIds[i])) {
                env.log.warn("could not delete pre-existing scene " + sceneIds[i]);
            }
        } catch (e) {
            env.log.warn("deleting pre-existing scene " + sceneIds[i] + ": " + e);
        }
    }
}

function globalStartFrameOf(env, panelId) {
    var frames = 0;
    try {
        for (var si = 0; si < env.sb.numberOfScenesInProject(); si++) {
            var sid = env.sb.sceneInProject(si);
            var np = env.sb.numberOfPanelsInScene(sid);
            for (var pj = 0; pj < np; pj++) {
                var pid = String(env.sb.panelInScene(sid, pj));
                if (pid === String(panelId)) return frames;
                frames += env.sb.getPanelDuration(pid);
            }
        }
    } catch (e) {}
    return 0;
}

function importSummary(env) {
    var c = env.counts;
    var summary = "Imported " + c.scenes + " scene(s), " + c.panels +
                  " panel(s), " + (c.layers - c.imageLayers) +
                  " vector art layer(s)" +
                  (c.imageLayers > 0
                       ? " and " + c.imageLayers + " image layer(s)" : "") + ".";
    if (c.sequences > 0) {
        summary += "\n\nScenes grouped into " + c.sequences + " sequence(s).";
    }
    if (c.sequencesFailed > 0) {
        summary += "\n\n" + c.sequencesFailed + " sequence(s) could not be created " +
                   "(see the Message Log); their scenes were imported without one.";
    }
    if (c.blurredLayers > 0) {
        summary += "\n\n" + c.blurredLayers + " blurred layer(s) were " +
                   "pre-rendered to bitmap (Storyboard Pro has no per-layer " +
                   "blur; those layers are no longer vector-editable).";
    }
    if (c.camApplied > 0) {
        summary += "\n\nCamera moves applied to " + c.camApplied + " scene(s) " +
                   "(source keyframes also kept as 'sboardx-camera' panel metadata). " +
                   "Note: the app's easing is approximated by Storyboard Pro's default " +
                   "interpolation between the same keyframes.";
    }
    if (c.camScenes > c.camApplied) {
        summary += "\n\nCamera moves on " + (c.camScenes - c.camApplied) +
                   " scene(s) could not be applied (see the Message Log). They are " +
                   "stored as panel metadata ('sboardx-camera') and in the " +
                   "'sboardx Camera' project caption for manual application.";
    }
    if (c.failedLayers > 0) {
        summary += "\n\n" + c.failedLayers + " layer(s) could not be imported " +
                   "(see the Message Log).";
    }
    if (c.groups > 0) {
        summary += "\n\n" + c.groups + " layer group(s) created.";
    }
    if (c.animatedLayers > 0) {
        summary += "\n\nLayer animation applied to " + c.animatedLayers +
                   " layer(s) (keys per panel; the app's easing is approximated " +
                   "by Storyboard Pro's interpolation between the same keyframes).";
    }
    if (c.opacityTracks > 0) {
        summary += "\n\n" + c.opacityTracks + " animated layer(s) had opacity " +
                   "keyframes; Storyboard Pro cannot animate opacity from a " +
                   "script, so they keep a constant opacity.";
    }
    if (env.log.warnings.length > 0) {
        summary += "\n\nWarnings:\n- " + env.log.warnings.join("\n- ");
    }
    return summary;
}

// Camera

function setEasedKeys(env, shotId, col, frames, values) {
    var fm = new FunctionManager();
    var velo = fm.functionType(shotId, col) == "VeloBased";
    for (var i = 0; i < frames.length; i++) {
        var f = frames[i], v = values[i];
        if (velo) { fm.setVeloBasePoint(shotId, col, f, v); continue; }
        var prevSpan = i > 0 ? (f - frames[i - 1]) : 3;
        var nextSpan = i + 1 < frames.length ? (frames[i + 1] - f) : 3;
        fm.setBezierPoint(shotId, col, f, v,
                          f - prevSpan / 3.0, v, f + nextSpan / 3.0, v,
                          false, "CORNER");
    }
}

function applyPanEase(env, shotId, frames, kfAt, fx, fy) {
    var CAMERA_PEG = "Top/Camera-Peg";
    var mm = new MotionManager();
    var fm = new FunctionManager();
    var xs = [], ys = [];
    for (var i = 0; i < kfAt.length; i++) {
        xs.push(kfAt[i].cx * fx);
        ys.push(-kfAt[i].cy * fy);
    }
    try {
        if (!mm.setTextAttr(shotId, CAMERA_PEG, "position.separate", 1, "On")) {
            env.log.warn("camera pan easing unavailable on shot " + shotId +
                 " (position.separate could not be set) - pan is linear");
            return false;
        }
        var axes = [["position.x", "sbx_cam_x", xs], ["position.y", "sbx_cam_y", ys]];
        for (var a = 0; a < axes.length; a++) {
            var attr = axes[a][0], fname = axes[a][1], vals = axes[a][2];
            var col = mm.getLinkedFunction(shotId, CAMERA_PEG, attr);
            if (!col) {
                mm.addFunction(shotId, fname, "BEZIER");
                mm.setLinkedFunction(shotId, CAMERA_PEG, attr, fname);
                col = mm.getLinkedFunction(shotId, CAMERA_PEG, attr);
            }
            if (!col) throw "no function for " + attr;
            try {
                for (var k = fm.numberOfPoints(shotId, col) - 1; k >= 0; k--) {
                    fm.clearKeyFrame(shotId, col, fm.pointX(shotId, col, k));
                }
            } catch (e) {}
            setEasedKeys(env, shotId, col, frames, vals);
        }
        return true;
    } catch (e2) {
        try { mm.setTextAttr(shotId, CAMERA_PEG, "position.separate", 1, "Off"); } catch (e3) {}
        env.log.warn("camera pan easing failed on shot " + shotId + " (" + e2 + ") - pan is linear");
        return false;
    }
}

function applySceneCamera(env, shotId, kfs) {
    if (kfs.length === 0) return false;
    try {
        var mm = new MotionManager();
        var fm = new FunctionManager();
        var frameH = (env.projectJson.canvas && env.projectJson.canvas.height)
            ? env.projectJson.canvas.height : 540;
        var fields = env.common.cameraFields(frameH);

        var sorted = kfs.slice().sort(function (a, b) { return a.t - b.t; });
        var frames = [];
        var kfAt = [];
        var i;
        for (i = 0; i < sorted.length; i++) {
            // Storyboard Pro frames are 1-based: t = 0 is frame 1.
            var frame = Math.max(1, Math.round(sorted[i].t * env.fps) + 1);
            if (frames.length > 0 && frames[frames.length - 1] === frame) {
                kfAt[kfAt.length - 1] = sorted[i];
            } else {
                frames.push(frame);
                kfAt.push(sorted[i]);
            }
        }

        mm.clearCameraMotion(shotId);

        var sweepCol = mm.linkedCameraFunction(shotId, "position.attr3dpath");
        if (sweepCol) {
            var stray = fm.numberOfPointsPath3d(shotId, sweepCol);
            for (i = stray - 1; i >= 0; i--) {
                fm.removePointPath3d(shotId, sweepCol, i);
            }
        }

        for (i = 0; i < frames.length; i++) {
            mm.addCameraKeyFrame(shotId, frames[i]);
        }

        var posCol = mm.linkedCameraFunction(shotId, "position.attr3dpath");
        var sxCol = mm.linkedCameraFunction(shotId, "scale.x");
        var syCol = mm.linkedCameraFunction(shotId, "scale.y");
        var rotCol = mm.linkedCameraFunction(shotId, "rotation.anglez");

        var nb = fm.numberOfPointsPath3d(shotId, posCol);
        var pointFor = [];
        if (nb === frames.length) {
            for (i = 0; i < frames.length; i++) pointFor.push(i);
        } else {
            env.log.warn("camera path on shot " + shotId + " has " + nb +
                 " points for " + frames.length + " keyframes; matching " +
                 "by locked frame");
            var locked = [];
            for (i = 0; i < nb; i++) {
                locked.push(fm.pointLockedAtFrame(shotId, posCol, i));
            }
            for (i = 0; i < frames.length; i++) {
                var best = -1;
                for (var p = 0; p < nb; p++) {
                    if (locked[p] === frames[i] || locked[p] === frames[i] + 1) {
                        best = p;
                        break;
                    }
                }
                pointFor.push(best);
            }
        }

        var scaleVals = [], rotVals = [];
        for (i = 0; i < frames.length; i++) {
            var k = kfAt[i];
            var x = k.cx * fields.perWorldX;
            var y = -k.cy * fields.perWorldY;
            scaleVals.push(1.0 / (k.z || 1));
            rotVals.push(-(k.rot || 0));

            var pt = pointFor[i];
            if (pt >= 0 && pt < nb) {
                fm.setPointPath3d(shotId, posCol, pt, x, y,
                                  fm.pointZPath3d(shotId, posCol, pt),
                                  0, 0, 0);
            } else {
                env.log.warn("no camera path point for frame " + frames[i] +
                     " on shot " + shotId + "; pan key skipped");
            }
        }
        setEasedKeys(env, shotId, sxCol, frames, scaleVals);
        setEasedKeys(env, shotId, syCol, frames, scaleVals);
        setEasedKeys(env, shotId, rotCol, frames, rotVals);
        applyPanEase(env, shotId, frames, kfAt, fields.perWorldX, fields.perWorldY);
        return true;
    } catch (e) {
        env.log.warn("camera move could not be applied on shot " + shotId + ": " + e);
        return false;
    }
}

// Panel layers

function importPanelLayers(env, panelId, srcId) {
    var layersJson = env.common.readJsonFile(env.extractDir + "/panels/" + srcId + "/layers.json");
    var layers = layersJson && layersJson.layers ? layersJson.layers : [];
    if (layers.length === 0) return;

    var preexisting = env.lm.numberOfLayers(panelId);
    var okIndexAligned = [];
    for (var i = 0; i < layers.length; i++) {
        if (importOneLayer(env, panelId, srcId, layers[i], i)) {
            okIndexAligned.unshift(layers[i]);
            env.counts.layers++;
        } else {
            env.counts.failedLayers++;
            var layer = layers[i];
            env.log.warn("layer failed to import: " + srcId + "/" +
                 (layer.image && layer.image.file ? layer.image.file : layer.art));
        }
    }

    configureImportedLayers(env, panelId, okIndexAligned);
    applyLayerGroups(env, panelId, okIndexAligned);

    if (okIndexAligned.length > 0 && preexisting > 0) {
        for (var d = env.lm.numberOfLayers(panelId) - 1; d >= okIndexAligned.length; d--) {
            if (env.lm.isEmpty(panelId, d)) env.lm.deleteLayer(panelId, d);
        }
    }
}

function importOneLayer(env, panelId, srcId, layer, layerIndex) {
    var blurSigma = typeof layer.blur === "number" && layer.blur > 0
        ? layer.blur : 0;
    var canBlur = blurSigma > 0 && qtBlurToolsAvailable();
    if (blurSigma > 0 && !canBlur) {
        env.log.warn("layer '" + layer.name + "': this Storyboard Pro exposes " +
             "no QImage/QPainter scripting - blur dropped, importing sharp");
    }

    if (layer.image && layer.image.file) {
        var srcLayer = layer;
        if (canBlur) {
            var pre = preBlurredImageLayer(env, srcId, layer, layerIndex);
            if (pre) {
                srcLayer = pre;
                env.counts.blurredLayers++;
            } else {
                env.log.warn("layer '" + layer.name +
                     "': blur failed - importing the image sharp");
            }
        }
        var ok = importImageAsBitmapLayer(env, panelId, srcId, srcLayer, layerIndex);
        if (ok) env.counts.imageLayers++;
        return ok;
    }

    var artPath = env.extractDir + "/panels/" + srcId + "/" + layer.art;
    if (canBlur && env.common.fileExists(artPath) &&
        /<path\b/.test(env.common.readTextFile(artPath) || "")) {
        if (importBlurredVectorAsBitmapLayer(env, panelId, srcId, layer,
                                             layerIndex, artPath)) {
            env.counts.blurredLayers++;
            return true;
        }
        env.log.warn("layer '" + layer.name +
             "': blur rasterization failed - importing sharp vector art");
    }
    return env.common.fileExists(artPath) &&
           importSvgAsVectorLayer(env, panelId, artPath,
               layer.name ? String(layer.name) : ("Layer " + (layerIndex + 1)));
}

function configureImportedLayers(env, panelId, entries) {
    for (var k = 0; k < entries.length; k++) {
        var src = entries[k];
        env.lm.renameLayer(panelId, k, String(src.name));
        try {
            if (src.opacity !== undefined) env.lm.setLayerOpacity(panelId, k, src.opacity);
        } catch (e) {
            env.log.warn("layer '" + src.name + "': opacity not applied (" + e + ")");
        }
        try {
            if (src.visible === false) env.lm.setLayerVisible(panelId, k, false);
        } catch (e2) {
            env.log.warn("layer '" + src.name + "': visibility not applied (" + e2 + ")");
        }
        try {
            if (src.locked === true) env.lm.setLayerLock(panelId, k, true);
        } catch (e3) {
            env.log.warn("layer '" + src.name + "': lock not applied (" + e3 + ")");
        }
    }
}

// Layer groups (layers.json "group": a folder = a contiguous run of layers
// sharing the name). Storyboard Pro group layers are real entries in the
// flat layer index (probed: a group sits directly above its children, which
// report groupOfLayer == the group's index), so every structural call
// shifts indices — members are re-resolved by name after each one.

function applyLayerGroups(env, panelId, entries) {
    // `entries` are top-to-bottom, index-aligned with the panel's stack.
    var i = 0;
    while (i < entries.length) {
        var g = entries[i].group ? String(entries[i].group) : "";
        if (!g) { i++; continue; }
        var run = [];
        while (i < entries.length && String(entries[i].group || "") === g) {
            run.push(String(entries[i].name));
            i++;
        }
        try {
            var firstIdx = env.lm.layerIndexFromName(panelId, env.common.sbpNodeName(run[0]));
            if (firstIdx < 0) { env.log.warn("group '" + g + "': member '" + run[0] + "' not found"); continue; }
            if (!env.lm.addGroupLayer(panelId, firstIdx, true, g)) {
                env.log.warn("group '" + g + "' could not be created");
                continue;
            }
            var groupIdx = env.lm.layerIndexFromName(panelId, env.common.sbpNodeName(g));
            if (groupIdx < 0) { env.log.warn("group '" + g + "' not found after creation"); continue; }
            for (var m = 0; m < run.length; m++) {
                var li = env.lm.layerIndexFromName(panelId, env.common.sbpNodeName(run[m]));
                if (li < 0) { env.log.warn("group '" + g + "': member '" + run[m] + "' not found"); continue; }
                // moveLayerInGroup appends at the END of the group: members
                // are visited top-to-bottom, so the stack order survives.
                env.lm.moveLayerInGroup(panelId, li, groupIdx);
                groupIdx = env.lm.layerIndexFromName(panelId, env.common.sbpNodeName(g));
            }
            env.counts.groups++;
        } catch (e) {
            env.log.warn("group '" + g + "' not applied: " + e);
        }
    }
}

// Layer animation (sequence.json "layer_tracks"): per scene, keyed by layer
// or group NAME, scene-local seconds, continuing across panel cuts. SBP
// keys live per (panel, layer) on real panel frames, so each track is split
// at every panel cut with SAMPLED boundary keys (the motion stays
// continuous), and applied to every panel that has a layer of that name.

function applyLayerTracks(env, sceneId, group) {
    var frameH = (env.projectJson.canvas && env.projectJson.canvas.height)
        ? env.projectJson.canvas.height : 540;
    var fields = env.common.cameraFields(frameH);
    var mm = new MotionManager();
    var fm = new FunctionManager();

    // Panel spans in scene-local seconds (from the durations SBP holds).
    var spans = [];
    var acc = 0;
    for (var p = 0; p < group.sbpPanelIds.length; p++) {
        var pid = group.sbpPanelIds[p];
        var frames = pid ? env.sb.getPanelDuration(pid) : 0;
        spans.push({ panelId: pid, frames: frames, start: acc, end: acc + frames / env.fps });
        acc += frames / env.fps;
    }

    for (var t = 0; t < group.layerTracks.length; t++) {
        var track = group.layerTracks[t];
        if (!track || typeof track.name !== "string" || !track.name) continue;
        var isGroup = track.kind === "group";
        if (!isGroup && track.kind !== "layer") continue;
        var kfs = (track.keyframes || []).slice().sort(function (a, b) { return a.t - b.t; });
        if (kfs.length === 0) continue;
        var px = track.pivot && typeof track.pivot.x === "number" ? track.pivot.x : 0;
        var py = track.pivot && typeof track.pivot.y === "number" ? track.pivot.y : 0;
        var nodeName = env.common.sbpNodeName(track.name);
        var applied = 0;
        var opacityAnimated = false;
        for (var k = 1; k < kfs.length; k++) {
            if (Math.abs((kfs[k].opacity === undefined ? 1 : kfs[k].opacity) -
                         (kfs[0].opacity === undefined ? 1 : kfs[0].opacity)) > 1e-6) {
                opacityAnimated = true;
            }
        }

        for (p = 0; p < spans.length; p++) {
            var span = spans[p];
            if (!span.panelId || span.frames <= 0) continue;
            var li = -1;
            try { li = env.lm.layerIndexFromName(span.panelId, nodeName); } catch (e0) {}
            if (li < 0) continue;
            try {
                var wantGroup = env.lm.isGroupLayer(span.panelId, li) === true;
                if (wantGroup !== isGroup) continue;
            } catch (e1) {}
            try {
                if (applyTrackToLayer(env, mm, fm, fields, span, li, kfs, px, py)) {
                    applied++;
                    if (opacityAnimated) env.counts.opacityTracks++;
                }
            } catch (e2) {
                env.log.warn("animation of '" + track.name + "' not applied on panel " +
                             span.panelId + ": " + e2);
            }
        }
        if (applied === 0) {
            env.log.warn("animation track '" + track.name + "' matched no " +
                         (isGroup ? "group" : "layer") + " in scene " + sceneId);
        } else {
            env.counts.animatedLayers += applied;
        }
    }
}

function applyTrackToLayer(env, mm, fm, fields, span, li, kfs, px, py) {
    var panelId = span.panelId;
    // Frames to key: every keyframe strictly inside the panel, plus the
    // panel's first and last frame (sampled) so the pose is continuous
    // across the cut. Coincident frames collapse onto one key.
    var keyTimes = [span.start, span.end];
    for (var k = 0; k < kfs.length; k++) {
        if (kfs[k].t > span.start + 1e-9 && kfs[k].t < span.end - 1e-9) keyTimes.push(kfs[k].t);
    }
    keyTimes.sort(function (a, b) { return a - b; });
    var frames = [], poses = [];
    for (k = 0; k < keyTimes.length; k++) {
        var f = env.common.panelTimeToFrame(keyTimes[k] - span.start, span.frames, env.fps);
        if (frames.length && frames[frames.length - 1] === f) continue;
        frames.push(f);
        poses.push(env.common.layerPoseAt(kfs, keyTimes[k]));
    }
    // A pose that is identity throughout leaves the layer alone.
    var allIdentity = true;
    for (k = 0; k < poses.length; k++) {
        if (!env.common.isIdentityPose(poses[k])) { allIdentity = false; break; }
    }
    if (allIdentity && frames.length <= 2) return false;

    // The camera's probed order: enable, add every key, THEN fetch the
    // function handles (before that they are "" and writes are no-ops).
    try { mm.setLayerAnimated(panelId, li, true); } catch (e0) {}
    try { mm.clearLayerMotion(panelId, li); } catch (e1) {}
    for (k = 0; k < frames.length; k++) mm.addLayerKeyFrame(panelId, li, frames[k]);

    var posCol = String(mm.linkedLayerFunction(panelId, li, "offset.attr3dpath") || "");
    var sxCol = String(mm.linkedLayerFunction(panelId, li, "scale.x") || "");
    var syCol = String(mm.linkedLayerFunction(panelId, li, "scale.y") || "");
    var rotCol = String(mm.linkedLayerFunction(panelId, li, "rotation.anglez") || "");
    if (!posCol || !sxCol || !rotCol) {
        throw "no animation functions on layer " + li;
    }

    var scaleVals = [], rotVals = [];
    var nb = fm.numberOfPointsPath3d(panelId, posCol);
    var locked = [];
    for (k = 0; k < nb; k++) locked.push(fm.pointLockedAtFrame(panelId, posCol, k));
    for (k = 0; k < frames.length; k++) {
        var sbp = env.common.poseToSbp(poses[k], px, py, fields);
        scaleVals.push(sbp.scale);
        rotVals.push(sbp.angle);
        var pt = -1;
        for (var q = 0; q < nb; q++) {
            if (locked[q] === frames[k]) { pt = q; break; }
        }
        if (pt < 0 && nb === frames.length) pt = k;
        if (pt >= 0) {
            fm.setPointPath3d(panelId, posCol, pt, sbp.x, sbp.y,
                              fm.pointZPath3d(panelId, posCol, pt), 0, 0, 0);
        } else {
            env.log.warn("no offset path point for frame " + frames[k] +
                         " on panel " + panelId + " layer " + li + "; move key skipped");
        }
    }
    setEasedKeys(env, panelId, sxCol, frames, scaleVals);
    if (syCol) setEasedKeys(env, panelId, syCol, frames, scaleVals);
    setEasedKeys(env, panelId, rotCol, frames, rotVals);

    // Opacity: no function column in SBP (probed) — the whole layer takes
    // the track's opacity at the panel's first frame, times the layer's own.
    var o0 = poses[0].opacity;
    if (Math.abs(o0 - 1) > 1e-6) {
        try {
            var own = env.lm.layerOpacity(panelId, li);
            env.lm.setLayerOpacity(panelId, li, Math.round(own * o0));
        } catch (e2) {}
    }
    return true;
}

// Vector art

function importSvgAsVectorLayer(env, panelId, svgPath, layerName) {
    var layerAdded = false;
    try {
        var data = importer.parseSVG({ filename: svgPath });
        var pageCount = data && data.pages ? data.pages.length : 0;
        if (pageCount === 0) {
            env.log.trace("importer.parseSVG returned no pages for " + svgPath);
            return false;
        }
        // sboardx 1.1 paints: the SVG text is the contract for fill-opacity /
        // stroke-opacity and gradient fills; parseSVG's own reading of them
        // is unprobed, so the text's hints correct the primitives (see
        // parsePaintHints). A failure here never fails the import.
        var hints = null;
        try { hints = parsePaintHints(env.common.readTextFile(svgPath)); } catch (eh) {}
        env.selMgr.setCurrentPanel(panelId);
        env.lm.addVectorLayer(panelId, 0, true, String(layerName));
        layerAdded = true;
        var addedName = env.lm.layerName(panelId, 0);
        env.selMgr.setLayerSelection([{ name: addedName, panelId: panelId }]);
        Tools.createDrawing({ allFrames: true });
        drawSvgPage(env, data.pages[0], data.textures, hints);
        return true;
    } catch (e) {
        env.log.trace("vector import failed for " + svgPath + ": " + e);
        if (layerAdded) {
            try { env.lm.deleteLayer(panelId, 0); } catch (e2) {}
        }
        return false;
    }
}

function drawSvgPage(env, page, textures, hints) {
    var palette = scratchPalette(env);
    var snapshotIds = paletteColorIdList(palette);
    var trackedIds = [];
    var xf = pageTransform(page.mediaBox);

    var layers = [];
    var prims = page.primitives || [];
    // One primitive per <path> is what every sboardx writer emits; when the
    // counts agree the text's paint hints apply by index, otherwise the
    // parser's paints stand (VECTOR_IMPORT_SPEC §2 keeps document order).
    var applyHints = hints && hints.paths && hints.paths.length === prims.length;
    if (hints && !applyHints && hints.paths && hints.paths.length) {
        env.log.trace("paint hints skipped: " + hints.paths.length + " <path> tags vs " +
                      prims.length + " primitives");
    }
    for (var i = 0; i < prims.length; i++) {
        if (applyHints) applyPaintHint(env, prims[i], hints.paths[i], hints.gradients);
        var layer = buildPrimitiveLayer(env, prims[i], textures, xf, palette, trackedIds);
        if (layer !== null) {
            layers.push(layer);
        }
    }

    if (layers.length > 0) {
        DrawingTools.createLayers({
            label: "sboardx vector import",
            drawing: Tools.getToolSettings().currentDrawing,
            art: 2,
            layers: layers,
            masks: []
        });
    }

    releaseScratchColors(palette, snapshotIds, trackedIds);
    return layers.length;
}

function pageTransform(mediaBox) {
    var SVG_PT_TO_PX = 4 / 3;
    var scale = SVG_PT_TO_PX * 0.75 * 5000 / (mediaBox[3] - mediaBox[1]);
    return {
        scale: scale,
        tx: -scale * (mediaBox[2] + mediaBox[0]) / 2,
        ty: -scale * (mediaBox[3] + mediaBox[1]) / 2
    };
}

function transformPrimitivePoints(prim, xf) {
    var polygon = true;
    var paths = prim.paths || [];
    for (var i = 0; i < paths.length; i++) {
        var sub = paths[i];
        for (var j = 0; j < sub.length; j++) {
            var pt = sub[j];
            pt.x = pt.x * xf.scale + xf.tx;
            pt.y = pt.y * xf.scale + xf.ty;
            if (!pt.onCurve) {
                polygon = false;
            }
        }
    }
    return polygon;
}

function transformedShaderMatrix(m, xf) {
    return {
        ox: m.ox * xf.scale + xf.tx,
        oy: m.oy * xf.scale + xf.ty,
        xx: m.xx * xf.scale,
        xy: m.xy * xf.scale,
        yx: m.yx * xf.scale,
        yy: m.yy * xf.scale
    };
}

function buildPrimitiveLayer(env, p, textures, xf, palette, trackedIds) {
    if (!p.fill && !p.stroke) {
        return null;
    }
    var polygon = transformPrimitivePoints(p, xf);

    var shaderColorId = "0000000000000003";
    var shaderMatrix = null;
    if (p.fill) {
        var texEntry = null;
        if (p.textureName && textures && textures[p.textureName]) {
            texEntry = textures[p.textureName];
        }
        var grad = texEntry === null ? gradientSpecOf(p) : null;
        if (texEntry !== null) {
            shaderColorId = resolveTextureColorId(palette, texEntry, trackedIds);
            shaderMatrix = transformedShaderMatrix(p.matrix, xf);
        } else if (grad !== null) {
            // sboardx 1.1 gradient fill: a gradient palette colour plus the
            // shape's shader matrix (the texture mechanism); first stop when
            // this Storyboard Pro has no gradient colour API.
            var gid = resolveGradientColorId(env, palette, grad, trackedIds);
            if (gid !== null) {
                shaderColorId = gid;
                shaderMatrix = gradientShaderMatrix(grad, p, xf);
            } else {
                shaderColorId = resolveSolidColorId(palette, p.fillColor, trackedIds);
            }
        } else {
            shaderColorId = resolveSolidColorId(palette, p.fillColor, trackedIds);
        }
    }

    var strokes = [];
    var paths = p.paths || [];
    var j;
    if (p.fill) {
        for (j = 0; j < paths.length; j++) {
            strokes.push({
                polygon: polygon,
                shaderLeft: 0,
                stroke: true,
                path: paths[j]
            });
        }
    }
    if (p.stroke) {
        var pencilId = resolveSolidColorId(palette, p.strokeColor, trackedIds);
        var thickness = p.thickness * xf.scale;
        for (j = 0; j < paths.length; j++) {
            strokes.push({
                polygon: polygon,
                thickness: { constant: thickness },
                pencilColorId: pencilId,
                path: paths[j]
            });
        }
    }

    if (strokes.length === 0) {
        return null;
    }
    return {
        shaders: [{ colorId: shaderColorId, matrix: shaderMatrix }],
        layerType: 10001,
        strokes: strokes
    };
}

// ── Paint hints from the SVG text (sboardx 1.1) ─────────────────────────────
//
// importer.parseSVG is the geometry source. Whether it carries fill-opacity /
// stroke-opacity into fillColor.a / strokeColor.a, and what it reports for a
// `url(#id)` gradient fill, is unprobed (VECTOR_IMPORT_SPEC §9), while the
// SVG text is the format's contract. So the <path> tags are read in document
// order and each primitive's paint is corrected from its tag:
//   - alpha becomes the SMALLER of the parser's and the text's — idempotent
//     when the parser already honoured the attribute, a fix when it dropped it;
//   - a `url(#id)` fill attaches the text's gradient definition (`sbxGradient`
//     on the primitive) with its stops' alpha, which the parser's `gradient`
//     array lacks.
// Everything here is tolerant: a malformed attribute leaves the parser's
// value in place.

function parsePaintHints(svgText) {
    var text = String(svgText || "");
    var tags = text.match(/<path\b[^>]*>/g);
    var hints = { paths: [], gradients: parseSvgGradients(text) };
    if (!tags) return hints;
    for (var i = 0; i < tags.length; i++) {
        var tag = tags[i];
        var fill = attrOf(tag, "fill");
        var h = { fillAlpha: null, strokeAlpha: null, gradientId: null, bbox: null };
        if (fill && fill !== "none") {
            var url = /^url\(#([^)]+)\)/.exec(fill);
            if (url) {
                h.gradientId = url[1];
                var dm = attrOf(tag, "d");
                if (dm) h.bbox = bboxOfPathData(dm);
                var fo = parseFloat(attrOf(tag, "fill-opacity"));
                if (isFinite(fo)) h.fillAlpha = clamp01(fo);   // third-party: scales the stops
            } else {
                h.fillAlpha = tagAlpha(tag, "fill-opacity");
            }
        }
        var stroke = attrOf(tag, "stroke");
        if (stroke && stroke !== "none") h.strokeAlpha = tagAlpha(tag, "stroke-opacity");
        hints.paths.push(h);
    }
    return hints;
}

function attrOf(tag, name) {
    var m = new RegExp("(?:^|\\s)" + name.replace(/[.:-]/g, "\\$&") + "=\"([^\"]*)\"").exec(tag);
    return m ? m[1] : null;
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// A path's paint alpha from its tag: sboardx:rgba's 4th number wins, then the
// opacity attribute; null when the tag says nothing.
function tagAlpha(tag, opacityAttr) {
    var rgba = attrOf(tag, "sboardx:rgba");
    if (rgba) {
        var parts = rgba.replace(/^\s+|\s+$/g, "").split(/\s+/);
        if (parts.length === 4) {
            var a = parseFloat(parts[3]);
            if (isFinite(a)) return clamp01(a);
        }
    }
    var o = parseFloat(attrOf(tag, opacityAttr));
    return isFinite(o) ? clamp01(o) : null;
}

function bboxOfPathData(d) {
    var nums = String(d).match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
    if (!nums || nums.length < 2) return null;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i + 1 < nums.length; i += 2) {
        var x = parseFloat(nums[i]), y = parseFloat(nums[i + 1]);
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return isFinite(minX) ? { minX: minX, minY: minY, maxX: maxX, maxY: maxY } : null;
}

// <linearGradient>/<radialGradient> definitions anywhere in the file, keyed
// by id: SPEC.md "Gradient fills" (Upshot's unit space + gradientTransform)
// and the common third-party forms (objectBoundingBox, explicit coordinates,
// transform lists, style stops, one level of href stop inheritance).
function parseSvgGradients(text) {
    var out = {};
    // Both the open form (with <stop> children) and the self-closing form
    // (a stops-only template referenced through href).
    var re = /<(linearGradient|radialGradient)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
    var m;
    while ((m = re.exec(text)) !== null) {
        var attrs = m[2], body = m[3] || "";
        var id = attrOf(attrs, "id");
        if (!id) continue;
        var g = {
            type: m[1] === "radialGradient" ? "radial" : "linear",
            units: attrOf(attrs, "gradientUnits") || "objectBoundingBox",
            transform: parseTransformList(attrOf(attrs, "gradientTransform")),
            x1: attrOf(attrs, "x1"), y1: attrOf(attrs, "y1"),
            x2: attrOf(attrs, "x2"), y2: attrOf(attrs, "y2"),
            cx: attrOf(attrs, "cx"), cy: attrOf(attrs, "cy"), r: attrOf(attrs, "r"),
            href: (attrOf(attrs, "href") || attrOf(attrs, "xlink:href") || "").replace(/^#/, ""),
            stops: []
        };
        var stopTags = body.match(/<stop\b[^>]*>/g) || [];
        for (var s = 0; s < stopTags.length; s++) {
            var st = parseStop(stopTags[s]);
            if (st) g.stops.push(st);
        }
        out[id] = g;
    }
    // One level of stop inheritance.
    for (var k in out) {
        if (out.hasOwnProperty(k) && out[k].stops.length === 0 && out[k].href && out[out[k].href]) {
            out[k].stops = out[out[k].href].stops.slice();
        }
    }
    return out;
}

// A stop as {r,g,b,a} in 0..1 plus t (offset 0..1).
function parseStop(tag) {
    var offset = attrOf(tag, "offset") || "0";
    var t = /%$/.test(offset) ? parseFloat(offset) / 100 : parseFloat(offset);
    if (!isFinite(t)) t = 0;
    var color = attrOf(tag, "stop-color");
    var opacity = attrOf(tag, "stop-opacity");
    var style = attrOf(tag, "style");
    if (style) {
        var sc = /stop-color\s*:\s*([^;]+)/.exec(style);
        var so = /stop-opacity\s*:\s*([^;]+)/.exec(style);
        if (sc && !color) color = sc[1].replace(/^\s+|\s+$/g, "");
        if (so && opacity === null) opacity = so[1].replace(/^\s+|\s+$/g, "");
    }
    var rgba = attrOf(tag, "sboardx:rgba");
    var r = 0, g = 0, b = 0, a = 1;
    if (rgba) {
        var parts = rgba.replace(/^\s+|\s+$/g, "").split(/\s+/);
        if (parts.length === 4) {
            r = parseFloat(parts[0]); g = parseFloat(parts[1]);
            b = parseFloat(parts[2]); a = parseFloat(parts[3]);
        }
    } else if (color) {
        var hex = /^#([0-9a-fA-F]{6})$/.exec(color);
        var hex3 = /^#([0-9a-fA-F]{3})$/.exec(color);
        if (hex) {
            r = parseInt(hex[1].substring(0, 2), 16) / 255;
            g = parseInt(hex[1].substring(2, 4), 16) / 255;
            b = parseInt(hex[1].substring(4, 6), 16) / 255;
        } else if (hex3) {
            r = parseInt(hex3[1].charAt(0) + hex3[1].charAt(0), 16) / 255;
            g = parseInt(hex3[1].charAt(1) + hex3[1].charAt(1), 16) / 255;
            b = parseInt(hex3[1].charAt(2) + hex3[1].charAt(2), 16) / 255;
        }
        var op = parseFloat(opacity);
        if (isFinite(op)) a = op;
    }
    if (![r, g, b, a].every(isFinite)) return null;
    return { r: clamp01(r), g: clamp01(g), b: clamp01(b), a: clamp01(a), t: clamp01(t) };
}

// matrix(a b c d e f) | translate(tx[,ty]) | scale(sx[,sy]) | rotate(deg[,cx,cy])
// lists, composed left to right as SVG does; null when absent or unreadable.
function parseTransformList(text) {
    if (!text) return null;
    var re = /(matrix|translate|scale|rotate)\s*\(([^)]*)\)/g;
    var acc = [1, 0, 0, 1, 0, 0];
    var any = false, m;
    while ((m = re.exec(text)) !== null) {
        var v = m[2].split(/[\s,]+/).filter(function (s) { return s.length; }).map(parseFloat);
        if (v.some(function (x) { return !isFinite(x); })) return null;
        var t;
        if (m[1] === "matrix" && v.length === 6) t = v;
        else if (m[1] === "translate") t = [1, 0, 0, 1, v[0] || 0, v.length > 1 ? v[1] : 0];
        else if (m[1] === "scale") t = [v[0], 0, 0, v.length > 1 ? v[1] : v[0], 0, 0];
        else if (m[1] === "rotate") {
            var rad = (v[0] || 0) * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
            t = [c, s, -s, c, 0, 0];
            if (v.length === 3) {
                t = composeAffine(composeAffine([1, 0, 0, 1, -v[1], -v[2]], t), [1, 0, 0, 1, v[1], v[2]]);
            }
        } else return null;
        acc = composeAffine(t, acc);   // SVG: the rightmost transform applies first
        any = true;
    }
    return any ? acc : null;
}

// "first then second": the point goes through `first`, then `second`.
function composeAffine(first, second) {
    return [
        first[0] * second[0] + first[1] * second[2],
        first[0] * second[1] + first[1] * second[3],
        first[2] * second[0] + first[3] * second[2],
        first[2] * second[1] + first[3] * second[3],
        first[4] * second[0] + first[5] * second[2] + second[4],
        first[4] * second[1] + first[5] * second[3] + second[5]
    ];
}

// A length attribute of a gradient: number, or a percentage of `extent`.
function gradLen(v, fallback, extent) {
    if (v === null || v === undefined) return fallback;
    var s = String(v);
    var n = parseFloat(s);
    if (!isFinite(n)) return fallback;
    return /%$/.test(s) ? n / 100 * extent : n;
}

// Unit gradient space -> the SVG's user space (SPEC.md "Gradient fills"):
// linear = the (0,0)->(1,0) segment, radial = the unit circle. Composes the
// canonical frame, gradientTransform and the objectBoundingBox frame.
function gradientUnitAffine(g, bbox, viewW, viewH) {
    var obb = g.units !== "userSpaceOnUse";
    var ew = obb ? 1 : viewW, eh = obb ? 1 : viewH;
    var L;
    if (g.type === "linear") {
        var x1 = gradLen(g.x1, 0, ew), y1 = gradLen(g.y1, 0, eh);
        var x2 = gradLen(g.x2, ew, ew), y2 = gradLen(g.y2, 0, eh);
        var dx = x2 - x1, dy = y2 - y1;
        L = [dx, dy, -dy, dx, x1, y1];
    } else {
        var cx = gradLen(g.cx, 0.5 * ew, ew), cy = gradLen(g.cy, 0.5 * eh, eh);
        var r = gradLen(g.r, 0.5 * ew, ew);
        L = [r, 0, 0, r, cx, cy];
    }
    var M = g.transform ? composeAffine(L, g.transform) : L;
    if (obb) {
        if (!bbox) return null;
        var B = [bbox.maxX - bbox.minX, 0, 0, bbox.maxY - bbox.minY, bbox.minX, bbox.minY];
        M = composeAffine(M, B);
    }
    return M;
}

function applyPaintHint(env, p, h, gradients) {
    if (!p || !h) return;
    if (p.fill && h.gradientId && gradients && gradients[h.gradientId]) {
        var g = gradients[h.gradientId];
        if (g.stops.length >= 2) {
            var stops = g.stops.map(function (s) {
                var a = h.fillAlpha !== null ? s.a * h.fillAlpha : s.a;
                return { r: s.r, g: s.g, b: s.b, a: a, t: s.t };
            });
            p.sbxGradient = {
                type: g.type, stops: stops,
                affine: gradientUnitAffine(g, h.bbox, env.frameW || 960, env.frameH || 540)
            };
            if (!p.fillColor) p.fillColor = {};
            p.fillColor.r = stops[0].r; p.fillColor.g = stops[0].g;
            p.fillColor.b = stops[0].b; p.fillColor.a = stops[0].a;
            return;
        } else if (g.stops.length === 1) {
            p.fillColor = { r: g.stops[0].r, g: g.stops[0].g, b: g.stops[0].b, a: g.stops[0].a };
            return;
        }
    }
    if (p.fill && p.fillColor && h.fillAlpha !== null && !p.fillColor.hasOwnProperty("gradient")) {
        var fa = (typeof p.fillColor.a === "number") ? p.fillColor.a : 1;
        p.fillColor.a = Math.min(fa, h.fillAlpha);
    }
    if (p.stroke && p.strokeColor && h.strokeAlpha !== null) {
        var sa = (typeof p.strokeColor.a === "number") ? p.strokeColor.a : 1;
        p.strokeColor.a = Math.min(sa, h.strokeAlpha);
    }
}

// The gradient a primitive should be filled with: the text's definition
// first (it carries stop alpha and the unit affine), else the parser's
// `gradient` array (stops without alpha; its `gradientType`/`gradientMatrix`
// ride along for the shader matrix). null for a flat fill.
function gradientSpecOf(p) {
    if (p.sbxGradient && p.sbxGradient.stops && p.sbxGradient.stops.length >= 2) return p.sbxGradient;
    var c = p.fillColor;
    if (c && c.hasOwnProperty("gradient") && c.gradient && c.gradient.length >= 2) {
        var stops = [];
        for (var i = 0; i < c.gradient.length; i++) {
            var s = c.gradient[i];
            stops.push({ r: s.r, g: s.g, b: s.b, a: (typeof s.a === "number") ? s.a : 1,
                         t: (typeof s.t === "number") ? s.t : i / (c.gradient.length - 1) });
        }
        var radial = String(c.gradientType || "").toLowerCase().indexOf("radial") >= 0;
        return { type: radial ? "radial" : "linear", stops: stops, affine: null,
                 parserMatrix: c.gradientMatrix || p.matrix || null };
    }
    return null;
}

// The shape's shader matrix for a gradient colour, in page space (the
// texture convention: `transformedShaderMatrix` on the parser's matrix). When
// only the text's unit affine is known, the gradient is FITTED to the
// primitive's page-space bounds at the affine's angle — the rule Upshot
// itself used to place it — because the parser's page space (y-up, see
// pageTransform) and the SVG's user space differ by a flip the probe on the
// Windows machine has not pinned yet. PROBE ITEM (VECTOR_IMPORT_SPEC §9):
// Storyboard Pro's gradient unit space; this assumes the texture matrix's.
function gradientShaderMatrix(grad, p, xf) {
    if (grad.parserMatrix) return transformedShaderMatrix(grad.parserMatrix, xf);
    var bb = primitiveBounds(p);
    if (!bb) return null;
    var w = bb.maxX - bb.minX, h = bb.maxY - bb.minY;
    var cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
    if (grad.type === "radial") {
        return { ox: cx, oy: cy, xx: w / 2, xy: 0, yx: 0, yy: h / 2 };
    }
    var angle = grad.affine ? -Math.atan2(grad.affine[1], grad.affine[0]) : 0;   // y flipped page space
    var c = Math.cos(angle), s = Math.sin(angle);
    var e = (Math.abs(w * c) + Math.abs(h * s)) / 2;
    var len = Math.max(2 * e, 1e-6);
    return { ox: cx - e * c, oy: cy - e * s, xx: len * c, xy: len * s, yx: -len * s, yy: len * c };
}

function primitiveBounds(p) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    var paths = p.paths || [];
    for (var i = 0; i < paths.length; i++) {
        for (var j = 0; j < paths[i].length; j++) {
            var pt = paths[i][j];
            if (pt.x < minX) minX = pt.x; if (pt.x > maxX) maxX = pt.x;
            if (pt.y < minY) minY = pt.y; if (pt.y > maxY) maxY = pt.y;
        }
    }
    return isFinite(minX) ? { minX: minX, minY: minY, maxX: maxX, maxY: maxY } : null;
}

// Gradient palette colours (sboardx 1.1). PROBE ITEM: the creation calls
// are Harmony's names (`createNewLinearGradientColor` /
// `createNewRadialGradientColor`, colorData = [{r,g,b,a,t}] 8-bit ints with
// t 0..1); when this Storyboard Pro lacks them the caller falls back to the
// first stop as a solid colour, so an import never fails on a gradient.
function resolveGradientColorId(env, palette, grad, trackedIds) {
    var fn = grad.type === "radial" ? "createNewRadialGradientColor" : "createNewLinearGradientColor";
    if (typeof palette[fn] !== "function") {
        if (!env.gradientApiWarned) {
            env.gradientApiWarned = true;
            env.log.warn("This Storyboard Pro has no " + fn + "; gradient fills import as their first stop.");
        }
        return null;
    }
    var data = [], key = grad.type;
    for (var i = 0; i < grad.stops.length; i++) {
        var s = grad.stops[i];
        var st = { r: Math.floor(s.r * 255), g: Math.floor(s.g * 255), b: Math.floor(s.b * 255),
                   a: Math.floor(s.a * 255), t: Math.round(s.t * 1000) / 1000 };
        data.push(st);
        key += "_" + st.r + "_" + st.g + "_" + st.b + "_" + st.a + "_" + st.t;
    }
    var name = "Gradient_" + hashString(key);
    var id = findColorIdByName(palette, name);
    if (id === null) {
        try {
            id = palette[fn](name, data).id;
        } catch (e) {
            env.log.warn("gradient colour creation failed (" + e + "); using the first stop");
            return null;
        }
    }
    trackColorId(trackedIds, id);
    return id;
}

function findColorIdByName(palette, name) {
    for (var i = 0; i < palette.nColors; i++) {
        var c = palette.getColorByIndex(i);
        if (c && c.isValid && !c.isTexture && c.name === name) return c.id;
    }
    return null;
}

function hashString(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h * 16777619) >>> 0;
    }
    return ("00000000" + h.toString(16)).slice(-8);
}

// Scratch palette

function scratchPalette(env) {
    if (env.scratchPalette && env.scratchPalette.isValid()) {
        return env.scratchPalette;
    }
    var list = PaletteObjectManager.getScenePaletteList();
    var n = list.numPalettes;
    for (var i = 0; i < n; i++) {
        var pal = list.getPaletteByIndex(i);
        if (pal.isValid() && pal.getName() === "sboardx") {
            env.scratchPalette = pal;
            return pal;
        }
    }
    env.scratchPalette = list.createPalette("palette-library/sboardx", 0);
    return env.scratchPalette;
}

function paletteColorIdList(palette) {
    var ids = [];
    for (var i = 0; i < palette.nColors; i++) {
        var c = palette.getColorByIndex(i);
        if (!c || !c.isValid) {
            continue;
        }
        ids.push(c.id);
    }
    return ids;
}

function releaseScratchColors(palette, snapshotIds, trackedIds) {
    for (var i = 0; i < trackedIds.length; i++) {
        if (!idListContains(snapshotIds, trackedIds[i])) {
            palette.removeColor(trackedIds[i]);
        }
    }
}

function idListContains(list, id) {
    for (var i = 0; i < list.length; i++) {
        if (list[i] === id) {
            return true;
        }
    }
    return false;
}

function trackColorId(trackedIds, id) {
    if (!idListContains(trackedIds, id)) {
        trackedIds.push(id);
    }
}

function resolveSolidColorId(palette, color, trackedIds) {
    var r, g, b, a;
    if (color.hasOwnProperty("gradient")) {
        var stop = color.gradient[0];
        r = Math.floor(stop.r * 255);
        g = Math.floor(stop.g * 255);
        b = Math.floor(stop.b * 255);
        a = 255;
    } else {
        r = Math.floor(color.r * 255);
        g = Math.floor(color.g * 255);
        b = Math.floor(color.b * 255);
        a = Math.floor(color.a * 255);
    }
    var id = findSolidColorId(palette, r, g, b, a);
    if (id === null) {
        var name = "Color_r_" + r + "_g_" + g + "_b_" + b + "_a_" + a;
        id = palette.createNewSolidColor(name, { r: r, g: g, b: b, a: a }).id;
    }
    trackColorId(trackedIds, id);
    return id;
}

function findSolidColorId(palette, r, g, b, a) {
    var solidType = PaletteObjectManager.Constants.ColorType.SOLID_COLOR;
    for (var i = 0; i < palette.nColors; i++) {
        var c = palette.getColorByIndex(i);
        if (!c || !c.isValid) {
            continue;
        }
        if (!c.isTexture && c.colorType === solidType && c.colorData &&
            c.colorData.r === r && c.colorData.g === g &&
            c.colorData.b === b && c.colorData.a === a) {
            return c.id;
        }
    }
    return null;
}

function resolveTextureColorId(palette, texEntry, trackedIds) {
    var name = "Texture_uid_" + texEntry.textureHash;
    var id = findTextureColorId(palette, name);
    if (id === null) {
        id = palette.createNewTexture(name, texEntry.textureFile, false).id;
    }
    try {
        new File(texEntry.textureFile).remove();
    } catch (e) {}
    trackColorId(trackedIds, id);
    return id;
}

function findTextureColorId(palette, name) {
    for (var i = 0; i < palette.nColors; i++) {
        var c = palette.getColorByIndex(i);
        if (!c || !c.isValid) {
            continue;
        }
        if (c.isTexture && c.name === name) {
            return c.id;
        }
    }
    return null;
}

// Raster layers

function imageWrapperSvg(env, layer, imageBasename) {
    var canvas = env.projectJson.canvas || {};
    var frameH = canvas.height ? canvas.height : 540;
    var frameW = canvas.width ? canvas.width : frameH * 16 / 9;
    var im = layer.image;
    var t = im.transform && im.transform.length === 6
        ? im.transform : [1, 0, 0, 1, 0, 0];
    var w = im.w || 0, h = im.h || 0;
    var tx = t[4] + t[0] * (-w / 2) + t[2] * (-h / 2);
    var ty = t[5] + t[1] * (-w / 2) + t[3] * (-h / 2);
    var m = [t[0], t[1], t[2], t[3], tx, ty];
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
           '<svg xmlns="http://www.w3.org/2000/svg" ' +
           'xmlns:xlink="http://www.w3.org/1999/xlink"\n' +
           '     viewBox="' + (-frameW / 2) + ' ' + (-frameH / 2) + ' ' +
           frameW + ' ' + frameH + '" width="' + frameW + '" height="' +
           frameH + '">\n' +
           '  <g>\n' +
           '    <image x="0" y="0" width="' + w +
           '" height="' + h + '" preserveAspectRatio="none" transform="matrix(' +
           m.join(" ") + ')" xlink:href="' + env.common.xmlEscape(imageBasename) + '"/>\n' +
           '  </g>\n' +
           '</svg>\n';
}

function importImageAsBitmapLayer(env, panelId, srcId, layer, layerIndex) {
    var imgRel = String(layer.image.file);
    var imgPath = env.extractDir + "/" + imgRel;
    if (!env.common.fileExists(imgPath)) {
        env.log.warn("raster layer '" + layer.name + "': embedded image missing (" +
             imgRel + ")");
        return false;
    }
    if (!layer.image.w || !layer.image.h) {
        env.log.warn("raster layer '" + layer.name + "': image size missing in layers.json");
        return false;
    }
    var slash = imgRel.lastIndexOf("/");
    var imgDir = slash >= 0 ? env.extractDir + "/" + imgRel.substring(0, slash) : env.extractDir;
    var imgBase = slash >= 0 ? imgRel.substring(slash + 1) : imgRel;
    var wrapperPath = imgDir + "/" + imgBase + "." + srcId + "_" + layerIndex + ".wrapper.svg";
    env.common.writeTextFile(wrapperPath, imageWrapperSvg(env, layer, imgBase));

    var name = layer.name ? String(layer.name) : ("Image " + (layerIndex + 1));
    if (!importSvgAsVectorLayer(env, panelId, wrapperPath, name)) return false;

    try {
        var lm = env.lm;
        var before = lm.numberOfLayers(panelId);
        if (!lm.addBitmapLayer(panelId, 0, true, name)) {
            env.log.warn("raster layer '" + name + "' kept as a textured vector layer " +
                 "(addBitmapLayer failed)");
            return true;
        }
        lm.mergeLayers(panelId, [0, 1], name);
        if (lm.numberOfLayers(panelId) !== before) {
            try { lm.deleteLayer(panelId, 0); } catch (e) {}
            env.log.warn("raster layer '" + name + "' kept as a textured vector layer " +
                 "(mergeLayers failed)");
            return true;
        }
        if (!lm.isBitmapLayer(panelId, 0)) {
            env.log.warn("raster layer '" + name + "': merged layer is not a bitmap layer " +
                 "on this Storyboard Pro version (art is intact)");
        }
        return true;
    } catch (e2) {
        env.log.warn("raster layer '" + name + "': bitmap conversion failed (" + e2 +
             "); kept as a textured vector layer");
        return true;
    }
}

// Blurred layers

function qtBlurToolsAvailable() {
    return typeof QImage != "undefined" && typeof QPainter != "undefined" &&
           typeof QPainterPath != "undefined" && typeof QColor != "undefined" &&
           typeof QBrush != "undefined";
}

function rasterPixelsPerUnit(env) {
    var canvas = env.projectJson.canvas || {};
    var frameH = canvas.height ? canvas.height : 540;
    var resH = (canvas.resolution && canvas.resolution.height)
        ? canvas.resolution.height : 0;
    var ppu = resH > 0 && frameH > 0 ? resH / frameH : 2;
    return ppu > 0 ? ppu : 2;
}

function painterPathFromD(env, d) {
    var tokens = String(d).match(/[A-Za-z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g);
    if (!tokens) return null;
    var path = new QPainterPath();
    try { path.setFillRule(env.common.enumOr(Qt.WindingFill, 1)); } catch (e) {}
    var i = 0;
    function num() { return parseFloat(tokens[i++]); }
    function isCommand(tok) {
        return tok.length === 1 && /[A-Za-z]/.test(tok);
    }
    function moreNumbers() {
        return i < tokens.length && !isCommand(tokens[i]);
    }
    while (i < tokens.length) {
        var cmd = tokens[i++];
        if (cmd === "M") {
            var x = num(), y = num();
            if (isNaN(x) || isNaN(y)) return null;
            path.moveTo(x, y);
        } else if (cmd === "C") {
            var got = false;
            while (moreNumbers()) {
                var x1 = num(), y1 = num(), x2 = num(), y2 = num();
                var x3 = num(), y3 = num();
                if (isNaN(y3)) return null;
                path.cubicTo(x1, y1, x2, y2, x3, y3);
                got = true;
            }
            if (!got) return null;
        } else if (cmd === "Z" || cmd === "z") {
            path.closeSubpath();
        } else {
            return null;
        }
    }
    return path;
}

// The brush for a <path> in the blur raster: a gradient brush for a
// `url(#id)` fill when the definition is known (QLinearGradient /
// QRadialGradient in unit space under a QTransform of the unit->user affine),
// else the flat colour. Degrades to the first stop when a Qt call is not
// scriptable here.
function pathFillBrush(env, tagText, gradients) {
    var fill = /\bfill="([^"]*)"/.exec(tagText);
    var url = fill ? /^url\(#([^)]+)\)/.exec(fill[1]) : null;
    if (url && gradients && gradients[url[1]]) {
        var g = gradients[url[1]];
        if (g.stops.length === 0) return null;
        var first = g.stops[0];
        var firstColor = new QColor(Math.round(first.r * 255), Math.round(first.g * 255),
                                    Math.round(first.b * 255), Math.round(first.a * 255));
        if (g.stops.length === 1) return new QBrush(firstColor);
        try {
            var dm = /\bd="([^"]*)"/.exec(tagText);
            var M = gradientUnitAffine(g, dm ? bboxOfPathData(dm[1]) : null,
                                       env.frameW || 960, env.frameH || 540);
            if (!M) return new QBrush(firstColor);
            var qg = g.type === "radial" ? new QRadialGradient(0, 0, 1) : new QLinearGradient(0, 0, 1, 0);
            for (var i = 0; i < g.stops.length; i++) {
                var s = g.stops[i];
                qg.setColorAt(s.t, new QColor(Math.round(s.r * 255), Math.round(s.g * 255),
                                              Math.round(s.b * 255), Math.round(s.a * 255)));
            }
            var brush = new QBrush(qg);
            // QTransform(m11, m12, m21, m22, dx, dy): x' = m11 x + m21 y + dx — the
            // [a b c d tx ty] layout verbatim.
            brush.setTransform(new QTransform(M[0], M[1], M[2], M[3], M[4], M[5]));
            return brush;
        } catch (e) {
            return new QBrush(firstColor);
        }
    }
    var color = pathFillColor(tagText);
    return color ? new QBrush(color) : null;
}

function pathFillColor(tagText) {
    var a = 1.0;
    var fo = /\bfill-opacity="([^"]*)"/.exec(tagText);
    if (fo) a = parseFloat(fo[1]);
    var rgba = /\bsboardx:rgba="([^"]*)"/.exec(tagText);
    if (rgba) {
        var parts = rgba[1].replace(/^\s+|\s+$/g, "").split(/\s+/);
        if (parts.length === 4) {
            return new QColor(Math.round(parseFloat(parts[0]) * 255),
                              Math.round(parseFloat(parts[1]) * 255),
                              Math.round(parseFloat(parts[2]) * 255),
                              Math.round(parseFloat(parts[3]) * 255));
        }
    }
    var fill = /\bfill="([^"]*)"/.exec(tagText);
    if (!fill || fill[1] === "none") return null;
    var hex = /^#([0-9a-fA-F]{6})$/.exec(fill[1]);
    if (!hex) return null;
    return new QColor(parseInt(hex[1].substring(0, 2), 16),
                      parseInt(hex[1].substring(2, 4), 16),
                      parseInt(hex[1].substring(4, 6), 16),
                      Math.round(Math.max(0, Math.min(1, a)) * 255));
}

function gaussianBlurAxis(env, input, sigmaPx, horizontal) {
    var enumOr = env.common.enumOr;
    var R = Math.max(1, Math.ceil(3 * sigmaPx));
    var stride = Math.max(1, Math.ceil(R / 32));
    var offs = [], ws = [], sum = 0, i;
    for (i = -R; i <= R; i += stride) {
        var w = Math.exp(-(i * i) / (2 * sigmaPx * sigmaPx));
        offs.push(i); ws.push(w); sum += w;
    }
    var out = new QImage(input.width(), input.height(),
                         enumOr(QImage.Format_ARGB32_Premultiplied, 6));
    out.fill(0);
    var p = new QPainter();
    p.begin(out);
    p.setCompositionMode(enumOr(QPainter.CompositionMode_Plus, 12));
    for (i = 0; i < offs.length; i++) {
        p.setOpacity(ws[i] / sum);
        p.drawImage(horizontal ? offs[i] : 0, horizontal ? 0 : offs[i],
                    input);
    }
    p.end();
    return out;
}

function gaussianBlurImage(env, img, sigmaPx) {
    var enumOr = env.common.enumOr;
    var w = img.width(), h = img.height();
    if (sigmaPx <= 0) return img;
    try {
        return gaussianBlurAxis(env, gaussianBlurAxis(env, img, sigmaPx, true),
                                sigmaPx, false);
    } catch (e) {
        env.log.trace("separable blur unavailable (" + e +
              "); using the rescale approximation");
    }
    try {
        var k = Math.max(1, 2 * sigmaPx);
        var dw = Math.max(1, Math.round(w / k));
        var dh = Math.max(1, Math.round(h / k));
        var down = img.scaled(dw, dh, enumOr(Qt.IgnoreAspectRatio, 0),
                              enumOr(Qt.SmoothTransformation, 1));
        return down.scaled(w, h, enumOr(Qt.IgnoreAspectRatio, 0),
                           enumOr(Qt.SmoothTransformation, 1));
    } catch (e2) {
        return null;
    }
}

function renderBlurredVectorPng(env, artPath, sigmaWorld, outPath) {
    var enumOr = env.common.enumOr;
    var svgText = env.common.readTextFile(artPath);
    if (!svgText) return null;
    var tags = String(svgText).match(/<path\b[^>]*>/g);
    if (!tags || tags.length === 0) return null;
    var gradients = null;
    try { gradients = parseSvgGradients(String(svgText)); } catch (eg) {}

    var fills = [];
    var minX = 0, minY = 0, maxX = 0, maxY = 0, haveBox = false;
    for (var i = 0; i < tags.length; i++) {
        var dm = /\bd="([^"]*)"/.exec(tags[i]);
        if (!dm) return null;
        var path = painterPathFromD(env, dm[1]);
        if (!path) return null;
        var brush = pathFillBrush(env, tags[i], gradients);
        if (!brush) continue;
        var r = path.boundingRect();
        if (!haveBox) {
            minX = r.x(); minY = r.y();
            maxX = r.x() + r.width(); maxY = r.y() + r.height();
            haveBox = true;
        } else {
            minX = Math.min(minX, r.x());
            minY = Math.min(minY, r.y());
            maxX = Math.max(maxX, r.x() + r.width());
            maxY = Math.max(maxY, r.y() + r.height());
        }
        fills.push({ path: path, brush: brush });
    }
    if (!haveBox || fills.length === 0) return null;
    if (!(maxX > minX) && !(maxY > minY)) return null;

    var pad = 3 * sigmaWorld;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;

    var ppu = rasterPixelsPerUnit(env);
    var maxSide = Math.max(maxX - minX, maxY - minY) * ppu;
    if (maxSide > 4096) ppu *= 4096 / maxSide;
    var pxW = Math.max(1, Math.ceil((maxX - minX) * ppu));
    var pxH = Math.max(1, Math.ceil((maxY - minY) * ppu));

    var img = new QImage(pxW, pxH, enumOr(QImage.Format_ARGB32_Premultiplied, 6));
    img.fill(0);
    var p = new QPainter();
    p.begin(img);
    try { p.setRenderHint(enumOr(QPainter.Antialiasing, 1), true); } catch (e) {}
    p.scale(ppu, ppu);
    p.translate(-minX, -minY);
    for (var f = 0; f < fills.length; f++) {
        p.fillPath(fills[f].path, fills[f].brush);
    }
    p.end();

    var blurred = gaussianBlurImage(env, img, sigmaWorld * ppu);
    if (!blurred || !blurred.save(outPath, "PNG")) return null;
    return { w: pxW, h: pxH,
             transform: [1 / ppu, 0, 0, 1 / ppu,
                         minX + pxW / (2 * ppu), minY + pxH / (2 * ppu)] };
}

function importBlurredVectorAsBitmapLayer(env, panelId, srcId, layer, layerIndex, artPath) {
    var outRel = "panels/" + srcId + "/" + String(layer.art) + "." +
                 layerIndex + ".blurred.png";
    var placed = null;
    try {
        placed = renderBlurredVectorPng(env, artPath, layer.blur,
                                        env.extractDir + "/" + outRel);
    } catch (e) {
        env.log.trace("blur rasterization threw for " + artPath + ": " + e);
    }
    if (!placed) return false;
    return importImageAsBitmapLayer(env, panelId, srcId, {
        name: layer.name,
        image: { file: outRel, w: placed.w, h: placed.h,
                 transform: placed.transform }
    }, layerIndex);
}

function preBlurredImageLayer(env, srcId, layer, layerIndex) {
    try {
        var imgPath = env.extractDir + "/" + String(layer.image.file);
        if (!env.common.fileExists(imgPath)) return null;
        var src = new QImage(imgPath);
        if (src.isNull()) return null;
        var t = layer.image.transform && layer.image.transform.length === 6
            ? layer.image.transform : [1, 0, 0, 1, 0, 0];
        var unitsPerPx = Math.sqrt(Math.abs(t[0] * t[3] - t[1] * t[2]));
        if (!(unitsPerPx > 0)) unitsPerPx = 1;
        var sigmaPx = layer.blur / unitsPerPx;
        var padPx = Math.ceil(3 * sigmaPx);
        var w = src.width() + 2 * padPx, h = src.height() + 2 * padPx;
        var canvasImg = new QImage(w, h,
                                   env.common.enumOr(QImage.Format_ARGB32_Premultiplied, 6));
        canvasImg.fill(0);
        var p = new QPainter();
        p.begin(canvasImg);
        p.drawImage(padPx, padPx, src);
        p.end();
        var blurred = gaussianBlurImage(env, canvasImg, sigmaPx);
        var outRel = String(layer.image.file) + "." + srcId + "_" +
                     layerIndex + ".blurred.png";
        if (!blurred || !blurred.save(env.extractDir + "/" + outRel, "PNG")) return null;
        return { name: layer.name,
                 image: { file: outRel, w: w, h: h,
                          transform: layer.image.transform } };
    } catch (e) {
        env.log.trace("image pre-blur threw for '" + layer.name + "': " + e);
        return null;
    }
}

// Audio

function pathUrl(path) {
    var p = String(path).replace(/\\/g, "/");
    if (p.charAt(0) !== "/") p = "/" + p;
    return "file://localhost" + encodeURI(p);
}

function buildAudioXml(env, clips, tracks, frameOffset) {
    var xmlEscape = env.common.xmlEscape;
    var fps = env.fps;
    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n' +
              '<xmeml version="4">\n <sequence id="sboardx-audio">\n' +
              '  <name>sboardx audio</name>\n' +
              '  <rate><timebase>' + fps + '</timebase><ntsc>FALSE</ntsc></rate>\n' +
              '  <media>\n   <video/>\n   <audio>\n';
    var maxEnd = 0;
    var used = 0;
    var byTrack = {};
    var maxTrack = 0;
    for (var i = 0; i < clips.length; i++) {
        var ti = clips[i].track > 0 ? clips[i].track : 0;
        if (!byTrack[ti]) byTrack[ti] = [];
        byTrack[ti].push(clips[i]);
        if (ti > maxTrack) maxTrack = ti;
    }
    for (var t = 0; t <= maxTrack; t++) {
        var group = byTrack[t];
        if (!group || group.length === 0) continue;
        var muted = tracks && tracks[t] && tracks[t].muted;
        xml += '    <track>\n';
        if (muted) xml += '     <enabled>FALSE</enabled>\n';
        for (var j = 0; j < group.length; j++) {
            var clip = group[j];
            if (!clip.file) continue;
            var srcPath = env.extractDir + "/audio/" + clip.file;
            if (!env.common.fileExists(srcPath)) {
                env.log.warn("audio file missing in archive: " + clip.file);
                continue;
            }
            var inF = Math.round((clip.trim_in || 0) * fps);
            var lenF = Math.max(1, Math.round(clip.dur * fps));
            var startF = Math.round(clip.start * fps) + (frameOffset || 0);
            if (startF + lenF > maxEnd) maxEnd = startF + lenF;
            used++;
            xml += '     <clipitem id="clip-' + used + '">\n' +
                   '      <name>' + xmlEscape(clip.name || clip.file) + '</name>\n' +
                   '      <rate><timebase>' + fps + '</timebase><ntsc>FALSE</ntsc></rate>\n' +
                   '      <start>' + startF + '</start>\n' +
                   '      <end>' + (startF + lenF) + '</end>\n' +
                   '      <in>' + inF + '</in>\n' +
                   '      <out>' + (inF + lenF) + '</out>\n' +
                   '      <file id="file-' + used + '">\n' +
                   '       <name>' + xmlEscape(clip.file) + '</name>\n' +
                   '       <pathurl>' + xmlEscape(pathUrl(srcPath)) + '</pathurl>\n' +
                   '       <rate><timebase>' + fps + '</timebase><ntsc>FALSE</ntsc></rate>\n' +
                   '       <media><audio><samplecharacteristics>' +
                   '<depth>16</depth><samplerate>48000</samplerate>' +
                   '</samplecharacteristics></audio></media>\n' +
                   '      </file>\n' +
                   '      <sourcetrack><mediatype>audio</mediatype>' +
                   '<trackindex>1</trackindex></sourcetrack>\n' +
                   '     </clipitem>\n';
        }
        xml += '    </track>\n';
    }
    xml += '   </audio>\n  </media>\n' +
           '  <duration>' + Math.max(1, maxEnd) + '</duration>\n' +
           ' </sequence>\n</xmeml>\n';
    return used > 0 ? xml : null;
}

function importAudio(env, frameOffset) {
    var clipsJson = env.common.readJsonFile(env.extractDir + "/audio/clips.json");
    var clips = clipsJson && clipsJson.clips ? clipsJson.clips : [];
    if (clips.length === 0) return;
    var tracks = clipsJson && clipsJson.tracks ? clipsJson.tracks : [];

    var xml = buildAudioXml(env, clips, tracks, frameOffset || 0);
    if (!xml) {
        env.log.warn("audio clips listed but no audio files found in the archive");
        return;
    }
    var xmlPath = env.extractDir + "/sboardx-audio.xml";
    env.common.writeTextFile(xmlPath, xml);

    var result = null;
    try {
        var im = new ImportManager();
        result = im.importAnimatic(xmlPath, { doAudio: true });
    } catch (e) {
        env.log.trace("importAnimatic threw: " + e);
    }
    if (result && result.log) {
        for (var i = 0; i < result.log.length; i++) {
            env.log.trace("importAnimatic: " + result.log[i]);
        }
    }
    if (result && result.result) {
        env.log.trace("audio conform ok (" + clips.length + " clip(s))");
        return;
    }
    importAudioFallback(env, clips, frameOffset);
}

function importAudioFallback(env, clips, frameOffset) {
    if (typeof SoundTrackManager == "undefined") {
        env.log.warn("audio conform did not complete and SoundTrackManager is " +
             "unavailable - audio not imported");
        return;
    }
    var placed = 0, trimmed = 0;
    try {
        var stm = new SoundTrackManager();
        for (var c = 0; c < clips.length; c++) {
            var clip = clips[c];
            var src = env.extractDir + "/audio/" + clip.file;
            if (!env.common.fileExists(src)) continue;
            var ti = clip.track > 0 ? Math.floor(clip.track) : 0;
            while (stm.numberOfSoundTracks() <= ti) stm.addSoundTrack();
            var col = stm.nameOfSoundTrack(ti);
            var frame = Math.max(1, Math.round((clip.start || 0) * env.fps) + 1 +
                                    (frameOffset || 0));
            if (stm.importSoundBuffer(col, src, frame)) {
                placed++;
                if (clip.trim_in > 0) trimmed++;
            }
        }
    } catch (e) {
        env.log.warn("audio fallback failed: " + e);
    }
    if (placed > 0) {
        env.log.warn("audio placed with SoundTrackManager (" + placed + " of " +
             clips.length + " clip(s)): whole files at their start frames - " +
             "clip trims/durations" + (trimmed ? " (" + trimmed + " trimmed clip(s))" : "") +
             ", gain and track mutes are not applied");
    } else {
        env.log.warn("audio conform did not complete - check the Message Log " +
             "(clip gain is not conformed either way)");
    }
}

exports.importFromFile = importFromFile;
exports.importReplacing = importReplacing;
