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

    zipPath = String(zipPath);
    if (!extractArchive(env, zipPath)) return false;
    if (!loadSboardx(env)) return false;

    var preExistingScenes = listExistingScenes(env);

    project.beginUndoRedoAccum("Import sboardx");
    try {
        applyProjectSettings(env);
        importScenes(env);
        recordImportMetadata(env, zipPath);
        if (env.replaceExisting) deleteScenes(env, preExistingScenes);
        importAudio(env, globalStartFrameOf(env, env.firstImportedPanel));
        project.endUndoRedoAccum();
    } catch (err) {
        project.cancelUndoRedoAccum();
        log.report("sboardx import failed: " + err, true);
        return false;
    }

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
        counts: { scenes: 0, panels: 0, layers: 0, imageLayers: 0,
                  blurredLayers: 0, failedLayers: 0, camScenes: 0,
                  camApplied: 0 }
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
    if (projectJson.sboardx !== "1.0") {
        env.log.report("This importer reads sboardx 1.0 archives. This file is sboardx " +
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
            groups.push({
                name: raw[si] && raw[si].name ? raw[si].name : ("Scene " + (groups.length + 1)),
                panels: [],
                keyframes: raw[si] && raw[si].camera && raw[si].camera.keyframes
                    ? raw[si].camera.keyframes : []
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

        var firstPanelId = importScenePanels(env, sceneId, group);
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
    for (var p = 0; p < group.panels.length; p++) {
        var srcId = group.panels[p];
        var meta = env.common.readJsonFile(env.extractDir + "/panels/" + srcId + "/panel.json");
        if (!meta) {
            env.log.warn("panel.json missing for " + srcId);
            continue;
        }

        var panelId;
        if (p === 0 && env.sb.numberOfPanelsInScene(sceneId) > 0) {
            panelId = env.sb.panelInScene(sceneId, 0);
        } else {
            panelId = env.sb.insertPanel(true, prevPanelId, String(p + 1));
        }
        if (!panelId || String(panelId).length === 0) {
            env.log.warn("could not create panel for " + srcId);
            continue;
        }
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
            var frame = Math.max(1, Math.round(sorted[i].t * env.fps));
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
        env.selMgr.setCurrentPanel(panelId);
        env.lm.addVectorLayer(panelId, 0, true, String(layerName));
        layerAdded = true;
        var addedName = env.lm.layerName(panelId, 0);
        env.selMgr.setLayerSelection([{ name: addedName, panelId: panelId }]);
        Tools.createDrawing({ allFrames: true });
        drawSvgPage(env, data.pages[0], data.textures);
        return true;
    } catch (e) {
        env.log.trace("vector import failed for " + svgPath + ": " + e);
        if (layerAdded) {
            try { env.lm.deleteLayer(panelId, 0); } catch (e2) {}
        }
        return false;
    }
}

function drawSvgPage(env, page, textures) {
    var palette = scratchPalette(env);
    var snapshotIds = paletteColorIdList(palette);
    var trackedIds = [];
    var xf = pageTransform(page.mediaBox);

    var layers = [];
    var prims = page.primitives || [];
    for (var i = 0; i < prims.length; i++) {
        var layer = buildPrimitiveLayer(prims[i], textures, xf, palette, trackedIds);
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

function buildPrimitiveLayer(p, textures, xf, palette, trackedIds) {
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
        if (texEntry !== null) {
            shaderColorId = resolveTextureColorId(palette, texEntry, trackedIds);
            shaderMatrix = transformedShaderMatrix(p.matrix, xf);
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

    var fills = [];
    var minX = 0, minY = 0, maxX = 0, maxY = 0, haveBox = false;
    for (var i = 0; i < tags.length; i++) {
        var dm = /\bd="([^"]*)"/.exec(tags[i]);
        if (!dm) return null;
        var path = painterPathFromD(env, dm[1]);
        if (!path) return null;
        var color = pathFillColor(tags[i]);
        if (!color) continue;
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
        fills.push({ path: path, color: color });
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
        p.fillPath(fills[f].path, new QBrush(fills[f].color));
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
