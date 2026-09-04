// sboardx_export.js — implementation module for TB_ExportSboardx.js, loaded
// via require(). NOT a user-facing script: never import it into the Scripts
// Manager. It exists because SBP's script picker lists every global function
// of an imported script (evaluating the file, so no syntax trick at global
// scope hides them) — module scope is the reliable way to keep internals out
// of that list. Needs sboardx_common.js in the same folder.
// Implementation notes and probed SBP behavior: see README.md.

function exportToFile(zipPath, quiet) {
    var common = sboardxCommon(quiet);
    if (!common) return;
    var log = common.makeLog("[sboardx-export] ", quiet);

    if (typeof Drawing == "undefined" ||
        typeof MotionManager == "undefined" ||
        typeof FunctionManager == "undefined") {
        log.report("This script needs the Drawing scripting API " +
            "introduced in Storyboard Pro 24.\n\n" +
            "Please run it in Storyboard Pro 24 or newer.", true);
        return;
    }

    var env = makeExportEnv(common, log, zipPath);
    try {
        walkProject(env);
        writeProjectJson(env);
        writeSequenceJson(env);
        writeAudioClips(env);
    } catch (err) {
        log.report("sboardx export failed: " + err, true);
        return;
    }
    if (!zipStagingFolder(env)) {
        log.report("Could not create the .sboardx zip.\n\n" +
            "Zipping needs 'tar' (Windows 10+ / macOS) on PATH.\n" +
            "The staged files are in:\n" + env.stagingDir, true);
        return;
    }
    log.report(exportSummary(env), false);
}

function sboardxCommon(quiet) {
    try {
        return require("./sboardx_common.js");
    } catch (e) {
        var msg = "sboardx_common.js was not found. Install it in the same " +
                  "folder as this script.";
        if (quiet) MessageLog.error("[sboardx-export] " + msg);
        else MessageBox.critical(msg);
        return null;
    }
}

function makeExportEnv(common, log, zipPath) {
    zipPath = String(zipPath).replace(/\\/g, "/");
    if (!/\.sboardx$/i.test(zipPath)) zipPath += ".sboardx";

    var stagingDir = common.makeTempDir("export");
    new Dir(stagingDir + "/audio").mkdirs();
    new Dir(stagingDir + "/images").mkdirs();
    new Dir(stagingDir + "/raster").mkdirs();

    var fps = project.getFrameRate();
    var resW = project.currentResolutionX();
    var resH = project.currentResolutionY();
    var frameH = 540.0;
    var frameW = frameH * resW / resH;
    var cm = new CaptionManager();

    return {
        common: common,
        log: log,
        zipPath: zipPath,
        stagingDir: stagingDir,
        sb: new StoryboardManager(),
        lm: new LayerManager(),
        cm: cm,
        mm: new MotionManager(),
        fm: new FunctionManager(),
        fps: fps,
        resW: resW,
        resH: resH,
        frameW: frameW,
        frameH: frameH,
        worldPerDrawing: frameH / 3750.0,
        fields: common.cameraFields(frameH),
        notesCaption: common.findPanelCaption(cm, "notes"),
        dialogueCaption: common.findPanelCaption(cm, "dialogue"),
        nowIso: new Date().toISOString(),
        panelIds: [],
        scenes: [],
        counts: { scenes: 0, panels: 0, layers: 0, rasterLayers: 0,
                  camScenes: 0, audioClips: 0, audioTracks: 0 }
    };
}

function walkProject(env) {
    var numScenes = env.sb.numberOfScenesInProject();
    for (var s = 0; s < numScenes; s++) {
        var sceneId = env.sb.sceneInProject(s);
        var sceneName = String(env.sb.nameOfScene(sceneId));
        var numPanels = env.sb.numberOfPanelsInScene(sceneId);
        var camKfs = readSceneCamera(env, sceneId,
            numPanels > 0 ? String(env.sb.panelInScene(sceneId, 0)) : "");

        var scenePanels = [];
        for (var pi = 0; pi < numPanels; pi++) {
            var panelId = String(env.sb.panelInScene(sceneId, pi));
            env.panelIds.push(panelId);
            scenePanels.push(panelId);
            exportPanel(env, sceneId, sceneName, panelId, camKfs);
        }

        if (camKfs.length > 0) env.counts.camScenes++;
        env.scenes.push({
            id: String(sceneId),
            name: sceneName,
            panels: scenePanels,
            camera: { keyframes: camKfs }
        });
        env.counts.scenes++;
    }
}

function exportPanel(env, sceneId, sceneName, panelId, camKfs) {
    env.log.trace("panel " + panelId);
    var panelDir = env.stagingDir + "/panels/" + panelId;
    new Dir(panelDir + "/art").mkdirs();

    writePanelJson(env, panelDir, sceneName, panelId);
    env.common.writeTextFile(panelDir + "/camera.json",
                             JSON.stringify({ keyframes: [] }));

    var layers = [];
    var rasterJobs = [];
    var numLayers = env.lm.numberOfLayers(panelId);
    for (var li = numLayers - 1; li >= 0; li--) {
        var entry = exportLayer(env, panelDir, panelId, li, rasterJobs);
        layers.push(entry);
        env.counts.layers++;
    }
    if (rasterJobs.length > 0) {
        rasterizePanel(env, sceneId, panelId, rasterJobs, camKfs);
    }
    env.common.writeTextFile(panelDir + "/layers.json",
                             JSON.stringify({ layers: layers }));
    env.counts.panels++;
}

function writePanelJson(env, panelDir, sceneName, panelId) {
    var panelObj = {
        id: panelId,
        code: String(env.sb.nameOfPanel(panelId)),
        shot: sceneName,
        dur: env.sb.getPanelDuration(panelId) / env.fps,
        note: panelCaptionText(env, env.notesCaption, panelId)
    };
    var dialogueText = panelCaptionText(env, env.dialogueCaption, panelId);
    if (dialogueText) panelObj.dialogue = dialogueText;
    env.common.writeTextFile(panelDir + "/panel.json", JSON.stringify(panelObj));
}

function exportLayer(env, panelDir, panelId, li, rasterJobs) {
    var layerName = String(env.lm.layerName(panelId, li));
    var layerId = "layer" + li;

    var isBitmap = false;
    try { isBitmap = env.lm.isBitmapLayer(panelId, li) === true; } catch (e) {}

    var tvgPath = "";
    try { tvgPath = String(env.lm.getLayerDrawingName(panelId, li, true)); }
    catch (e2) {}
    if (!tvgPath && !isBitmap) {
        env.log.warn("no drawing file for panel " + panelId + " layer '" +
                     layerName + "' - exported empty");
    }

    var art = layerSvg(env, !isBitmap && tvgPath ? { filename: tvgPath } : null,
                       layerId, layerName, panelId);
    var needsRaster = isBitmap || art.usedTexture;
    if (needsRaster && !isBitmap) {
        art = layerSvg(env, null, layerId, layerName, panelId);
    }
    env.common.writeTextFile(panelDir + "/art/" + layerId + ".svg", art.svg);

    var locked = false;
    try { locked = env.lm.getLayerLock(panelId, li) === true; } catch (e3) {}
    var opacity = 100;
    try { opacity = env.lm.layerOpacity(panelId, li); } catch (e4) {}
    var visible = true;
    try { visible = env.lm.layerVisibility(panelId, li) !== false; } catch (e5) {}

    var entry = {
        id: layerId,
        name: layerName,
        color_tag: "#999999",
        opacity: opacity,
        blend: "normal",
        locked: locked,
        visible: visible,
        art: "art/" + layerId + ".svg"
    };
    if (needsRaster) {
        rasterJobs.push({ li: li, layerId: layerId, layerName: layerName,
                          entry: entry });
    }
    return entry;
}

function fmtNum(v) {
    return String(Math.round(v * 1000) / 1000);
}

function layerSvg(env, drawing, layerId, layerName, panelId) {
    var usedTexture = { value: false };
    var data = null;
    try {
        if (drawing) data = Drawing.query.getData({ drawing: drawing });
    } catch (e) {
        env.log.warn("Drawing.query.getData failed for panel " + panelId +
                     " layer '" + layerName + "': " + e);
    }
    var body = "";
    if (data && data.arts) {
        var arts = data.arts.slice().sort(function (a, b) { return a.art - b.art; });
        for (var a = 0; a < arts.length; a++) {
            var layers = arts[a].layers || [];
            for (var l = 0; l < layers.length; l++) {
                body += drawablesSvg(env, layers[l], data.colors, usedTexture);
            }
        }
    }
    var xs = fmtNum(-env.frameW / 2), ys = fmtNum(-env.frameH / 2);
    var ws = fmtNum(env.frameW), hs = fmtNum(env.frameH);
    var xml = env.common.xmlEscape;
    var svg = '<?xml version="1.0" encoding="UTF-8"?>\n' +
              '<svg xmlns="http://www.w3.org/2000/svg"\n' +
              '     xmlns:sboardx="https://sboardx.format/ns/1.0"\n' +
              '     viewBox="' + xs + ' ' + ys + ' ' + ws + ' ' + hs + '"' +
              ' width="' + ws + '" height="' + hs + '"\n' +
              '     sboardx:layer-id="' + xml(layerId) + '"\n' +
              '     sboardx:layer-name="' + xml(layerName) + '"\n' +
              '     sboardx:panel-id="' + xml(panelId) + '">\n' +
              '  <g sboardx:blend="normal" sboardx:opacity="100">\n' +
              body +
              '  </g>\n' +
              '</svg>\n';
    return { svg: svg, usedTexture: usedTexture.value };
}

function drawablesSvg(env, vectorLayer, colors, usedTexture) {
    var body = "";
    var i, col, dAttr;
    var contours = vectorLayer.contours || [];
    for (i = 0; i < contours.length; i++) {
        var contour = contours[i];
        dAttr = svgPathData(env, contour.path, true);
        if (!dAttr) continue;
        if (contour.holes) {
            for (var hi = 0; hi < contour.holes.length; hi++) {
                var hd = svgPathData(env, contour.holes[hi], true);
                if (hd) dAttr += " " + hd;
            }
        }
        col = lookupColor(colors, contour.colorId, usedTexture);
        body += '  <path d="' + dAttr + '" fill="' + col.hex + '"' +
                (col.alpha < 1 ? ' fill-opacity="' + fmtNum(col.alpha) + '"' : '') +
                ' stroke="none"/>\n';
    }
    var strokes = vectorLayer.strokes || [];
    for (i = 0; i < strokes.length; i++) {
        var st = strokes[i];
        if (st.invisible) continue;
        dAttr = svgPathData(env, st.path, st.closed === true);
        if (!dAttr) continue;
        col = lookupColor(colors, st.colorId, usedTexture);
        var w = pencilWidthDrawing(st, vectorLayer.thicknessPaths);
        body += '  <path d="' + dAttr + '" fill="none" stroke="' + col.hex + '"' +
                (col.alpha < 1 ? ' stroke-opacity="' + fmtNum(col.alpha) + '"' : '') +
                ' stroke-width="' + fmtNum(w * env.worldPerDrawing) + '"' +
                ' stroke-linecap="round" stroke-linejoin="round"/>\n';
    }
    return body;
}

function svgPathData(env, path, closed) {
    if (!path || path.length === 0) return "";
    function toWorld(p) {
        return { x: p.x * env.worldPerDrawing, y: -p.y * env.worldPerDrawing };
    }
    var first = toWorld(path[0]);
    var d = "M " + fmtNum(first.x) + " " + fmtNum(first.y);
    var ctrl = [];
    var i, p, c0, c1;
    function emit(anchor) {
        if (ctrl.length === 0) {
            d += " L " + fmtNum(anchor.x) + " " + fmtNum(anchor.y);
        } else if (ctrl.length === 1) {
            c0 = toWorld(ctrl[0]);
            d += " Q " + fmtNum(c0.x) + " " + fmtNum(c0.y) +
                 " " + fmtNum(anchor.x) + " " + fmtNum(anchor.y);
        } else {
            c0 = toWorld(ctrl[0]);
            c1 = toWorld(ctrl[1]);
            d += " C " + fmtNum(c0.x) + " " + fmtNum(c0.y) +
                 " " + fmtNum(c1.x) + " " + fmtNum(c1.y) +
                 " " + fmtNum(anchor.x) + " " + fmtNum(anchor.y);
        }
        ctrl = [];
    }
    for (i = 1; i < path.length; i++) {
        p = path[i];
        if (p.onCurve) emit(toWorld(p));
        else ctrl.push(p);
    }
    if (ctrl.length > 0) {
        if (closed) emit(first);
        else emit(toWorld(ctrl.pop()));
    }
    if (closed) d += " Z";
    return d;
}

function pencilWidthDrawing(st, thicknessPaths) {
    var t = st.thickness;
    if (!t) return 2;
    if (t.hasOwnProperty("constant")) return 2 * t.constant;
    var tp = (thicknessPaths && t.thicknessPath !== undefined)
        ? thicknessPaths[t.thicknessPath] : null;
    if (tp) return tp.minThickness + tp.maxThickness;
    if (t.minThickness !== undefined) return t.minThickness + t.maxThickness;
    return 2;
}

function colorHex(c) {
    function h(v) {
        var s = Math.max(0, Math.min(255, Math.round(v))).toString(16);
        return s.length < 2 ? "0" + s : s;
    }
    return "#" + h(c.r) + h(c.g) + h(c.b);
}

function lookupColor(colors, colorId, usedTexture) {
    var c = colors && colors[colorId] ? colors[colorId] : null;
    if (!c) return { hex: "#000000", alpha: 1 };
    if (c.isTexture) usedTexture.value = true;
    return { hex: colorHex(c), alpha: (c.a === undefined ? 255 : c.a) / 255.0 };
}

function panelCaptionText(env, captionName, panelId) {
    if (!captionName) return "";
    var text = env.cm.textOfPanelCaption(captionName, panelId);
    if (!text) return "";
    text = String(text);
    if (text.indexOf("<") !== -1) {
        text = text.replace(/<style[\s\S]*?<\/style>/gi, "")
                   .replace(/<[^>]*>/g, "")
                   .replace(/&amp;/g, "&").replace(/&lt;/g, "<")
                   .replace(/&gt;/g, ">").replace(/&quot;/g, '"')
                   .replace(/^\s+|\s+$/g, "");
    }
    return text;
}

function functionValueAt(env, shotId, col, frame, fallback) {
    try {
        var nb = env.fm.numberOfPoints(shotId, col);
        var bestVal = fallback;
        var bestDist = -1;
        for (var i = 0; i < nb; i++) {
            var f = env.fm.pointX(shotId, col, i);
            var dist = Math.abs(f - frame);
            if (bestDist < 0 || dist < bestDist) {
                bestDist = dist;
                bestVal = env.fm.pointY(shotId, col, i);
            }
        }
        return bestVal;
    } catch (e) {
        return fallback;
    }
}

function readSceneCamera(env, sceneId, firstPanelId) {
    if (firstPanelId) {
        try {
            var meta = env.sb.getPanelMetadata(firstPanelId, "sboardx-camera");
            var raw = (meta && meta.value !== undefined) ? meta.value : meta;
            if (raw && String(raw).length > 0) {
                var kfs = JSON.parse(String(raw));
                if (kfs && kfs.length) {
                    env.log.trace("scene " + sceneId +
                                  ": camera from sboardx-camera metadata");
                    return kfs;
                }
            }
        } catch (e) {}
    }
    try {
        var fm = env.fm, mm = env.mm;
        var posCol = mm.linkedCameraFunction(sceneId, "position.attr3dpath");
        var sxCol = mm.linkedCameraFunction(sceneId, "scale.x");
        var rotCol = mm.linkedCameraFunction(sceneId, "rotation.anglez");

        var frames = [];
        var posAt = {};
        var seen = {};
        var i, f;
        var sepX = "", sepY = "";
        try {
            if (mm.getTextAttr(sceneId, "Top/Camera-Peg", "position.separate", 1) == "On") {
                sepX = mm.getLinkedFunction(sceneId, "Top/Camera-Peg", "position.x");
                sepY = mm.getLinkedFunction(sceneId, "Top/Camera-Peg", "position.y");
            }
        } catch (e2) {}
        if (sepX || sepY) {
            var xAt = {}, yAt = {};
            var nx = sepX ? fm.numberOfPoints(sceneId, sepX) : 0;
            for (i = 0; i < nx; i++) {
                f = fm.pointX(sceneId, sepX, i); xAt[f] = fm.pointY(sceneId, sepX, i);
                if (!seen[f]) { seen[f] = true; frames.push(f); }
            }
            var ny = sepY ? fm.numberOfPoints(sceneId, sepY) : 0;
            for (i = 0; i < ny; i++) {
                f = fm.pointX(sceneId, sepY, i); yAt[f] = fm.pointY(sceneId, sepY, i);
                if (!seen[f]) { seen[f] = true; frames.push(f); }
            }
            for (i = 0; i < frames.length; i++) {
                f = frames[i];
                posAt[f] = { x: xAt[f] !== undefined ? xAt[f] : functionValueAt(env, sceneId, sepX, f, 0),
                             y: yAt[f] !== undefined ? yAt[f] : functionValueAt(env, sceneId, sepY, f, 0) };
            }
        } else {
            var nb = fm.numberOfPointsPath3d(sceneId, posCol);
            for (i = 0; i < nb; i++) {
                f = fm.pointLockedAtFrame(sceneId, posCol, i);
                posAt[f] = { x: fm.pointXPath3d(sceneId, posCol, i),
                             y: fm.pointYPath3d(sceneId, posCol, i) };
                if (!seen[f]) { seen[f] = true; frames.push(f); }
            }
        }
        var extraCols = [sxCol, rotCol];
        for (var c = 0; c < extraCols.length; c++) {
            var n2 = fm.numberOfPoints(sceneId, extraCols[c]);
            for (i = 0; i < n2; i++) {
                f = fm.pointX(sceneId, extraCols[c], i);
                if (!seen[f]) { seen[f] = true; frames.push(f); }
            }
        }
        if (frames.length < 2) return [];
        frames.sort(function (a, b) { return a - b; });

        var out = [];
        for (i = 0; i < frames.length; i++) {
            f = frames[i];
            var pos = posAt[f] ? posAt[f] : { x: 0, y: 0 };
            var s = functionValueAt(env, sceneId, sxCol, f, 1);
            var ang = functionValueAt(env, sceneId, rotCol, f, 0);
            out.push({
                id: "kf" + (i + 1),
                t: f / env.fps,
                z: 1.0 / (s || 1),
                cx: pos.x / env.fields.perWorldX,
                cy: -pos.y / env.fields.perWorldY,
                rot: -ang
            });
        }
        return out;
    } catch (e3) {
        env.log.warn("camera could not be read on scene " + sceneId + ": " + e3);
        return [];
    }
}

function rasterTransform(env, w, h) {
    return [env.frameW / w, 0, 0, env.frameH / h, 0, 0];
}

function rasterizePanel(env, sceneId, panelId, jobs, camKfs) {
    var lm = env.lm;
    var n = lm.numberOfLayers(panelId);
    var hasSession = true;
    try { lm.layerOpacity(panelId, 0); } catch (e) { hasSession = false; }
    if (!hasSession && camKfs && camKfs.length > 0) {
        env.log.warn("image layer(s) on panel " + panelId + " skipped: the scene has a " +
             "camera move and -batch has no undo session to neutralize it - " +
             "run the export in an interactive Storyboard Pro session");
        return;
    }
    var vis = [];
    for (var v = 0; v < n; v++) {
        var on = true;
        try { on = lm.layerVisibility(panelId, v) !== false; } catch (e2) {}
        vis.push(on);
    }
    var em = new ExportManager();
    em.setSelectedPanels([panelId]);
    em.setExportResolution(env.resW, env.resH);
    em.setExportOneImagePerLayer(false);
    em.setTransparentBG(true);
    em.setCameraScaling(false);
    em.setBitmapFitCameraPath(false);
    em.setBitmapRectifyStatic(false);
    em.setMaintainSize(false);
    em.setExpandRenderAreaToArtworks(false);
    em.setExpandRenderAreaToCamera(false);
    em.setZoomFactor(1.0);
    em.setShowCamera(false);
    em.setShowCaptionOverlay(false);
    em.setShowScenePanelNamesOverlay(false);
    em.setShowTimeCode(false);
    em.setShowReference(false);
    em.setShow43SafetyOverlay(false);
    em.setShowActionSafeAreaOverlay(false);
    em.setShowTitleSafeAreaOverlay(false);

    if (hasSession) project.beginUndoRedoAccum("sboardx raster render");
    try {
        try {
            if (hasSession) env.mm.clearCameraMotion(sceneId);
        } catch (e3) {
            env.log.warn("camera could not be neutralized for the raster render of panel " +
                 panelId + " (" + e3 + ") - image layers exported empty");
            return;
        }
        for (var k = 0; k < jobs.length; k++) {
            renderRasterJob(env, em, panelId, n, jobs[k]);
        }
    } finally {
        if (hasSession) {
            project.cancelUndoRedoAccum();
        } else {
            for (var r = 0; r < n; r++) {
                try { lm.setLayerVisible(panelId, r, vis[r]); } catch (e4) {}
            }
        }
    }
}

function renderRasterJob(env, em, panelId, layerCount, job) {
    var dir = env.stagingDir + "/raster/" + panelId + "_" + job.li;
    new Dir(dir).mkdirs();
    try {
        for (var j = 0; j < layerCount; j++) {
            env.lm.setLayerVisible(panelId, j, j === job.li);
        }
    } catch (e) {
        env.log.warn("raster layer '" + job.layerName + "' (panel " + panelId +
             "): layer visibility could not be set (" + e + ") - exported empty");
        return;
    }
    var ok = false;
    try { ok = em.exportToBitmap(dir, "layer", "png"); } catch (e2) {
        env.log.warn("exportToBitmap failed for layer '" + job.layerName + "': " + e2);
    }
    var files = [];
    try { files = new Dir(dir).entryList("*.png"); } catch (e3) {}
    if (!ok || !files || files.length === 0) {
        env.log.warn("raster layer '" + job.layerName + "' (panel " + panelId +
             ") did not render - exported empty");
        return;
    }
    var src = dir + "/" + files[0];
    var fileName = panelId + "_" + job.layerId + ".png";
    if (!env.common.copyFile(src, env.stagingDir + "/images/" + fileName, env.log.warn)) {
        env.log.warn("could not stage the render of layer '" + job.layerName + "'");
        return;
    }
    var size = env.common.imageSize(src) || { w: env.resW, h: env.resH };
    job.entry.image = {
        file: "images/" + fileName,
        w: size.w,
        h: size.h,
        transform: rasterTransform(env, size.w, size.h)
    };
    job.entry.opacity = 100;
    env.counts.rasterLayers++;
}

function writeAudioClips(env) {
    var clips = [];
    var tracksOut = [];
    var stm = null;
    var nTracks = 0;
    try {
        stm = new SoundTrackManager();
        nTracks = stm.numberOfSoundTracks();
    } catch (e) {
        env.log.warn("audio not exported (SoundTrackManager unavailable: " + e + ")");
        env.common.writeTextFile(env.stagingDir + "/audio/clips.json",
                                 JSON.stringify({ clips: [] }));
        return;
    }
    var usedNames = {};
    var nameForSource = {};
    for (var t = 0; t < nTracks; t++) {
        tracksOut.push({ muted: false });
        var col, seqs;
        try {
            col = stm.nameOfSoundTrack(t);
            seqs = stm.soundColumn(col).sequences();
        } catch (e2) {
            env.log.warn("audio track " + t + " could not be read: " + e2);
            continue;
        }
        for (var i = 0; i < seqs.length; i++) {
            var clip = exportAudioClip(env, seqs[i], t, i, usedNames, nameForSource);
            if (clip) clips.push(clip);
        }
    }
    env.counts.audioClips = clips.length;
    env.counts.audioTracks = nTracks;
    var out = { clips: clips };
    if (tracksOut.length > 1) out.tracks = tracksOut;
    env.common.writeTextFile(env.stagingDir + "/audio/clips.json",
                             JSON.stringify(out));
}

function exportAudioClip(env, q, trackIndex, clipIndex, usedNames, nameForSource) {
    var src = String(q.filename || "").replace(/\\/g, "/");
    if (!src || !env.common.fileExists(src)) {
        env.log.warn("audio clip '" + (q.displayName || q.name) + "' on track " +
             trackIndex + ": source file missing (" + src + ")");
        return null;
    }
    var fileName = nameForSource[src];
    if (!fileName) {
        var base = env.common.fileBasename(src);
        var dot = base.lastIndexOf(".");
        var stem = dot > 0 ? base.substring(0, dot) : base;
        var ext = dot > 0 ? base.substring(dot) : "";
        fileName = base;
        for (var k = 2; usedNames[fileName]; k++) fileName = stem + "_" + k + ext;
        if (!env.common.copyFile(src, env.stagingDir + "/audio/" + fileName,
                                 env.log.warn)) {
            env.log.warn("audio file could not be copied: " + src);
            return null;
        }
        usedNames[fileName] = true;
        nameForSource[src] = fileName;
        if (/\.(aif|aiff|caf)$/i.test(fileName)) {
            env.log.warn("audio file " + fileName + " is not a browser format " +
                 "(the app plays it, the web reader will not)");
        }
    }
    var startF = Number(q.startFrame), stopF = Number(q.stopFrame);
    var tIn = Number(q.startTime) || 0, tOut = Number(q.stopTime) || 0;
    var dur = (stopF - startF + 1) / env.fps;
    if (tOut > tIn && tOut - tIn < dur) dur = tOut - tIn;
    var clip = {
        id: "clip-" + trackIndex + "-" + clipIndex,
        kind: "music",
        name: String(q.displayName || q.name || fileName),
        start: (startF - 1) / env.fps,
        dur: dur,
        trim_in: tIn,
        gain: 80,
        file: fileName
    };
    if (trackIndex > 0) clip.track = trackIndex;
    return clip;
}

function projectDisplayName() {
    var projName = "Storyboard";
    try {
        var pp = String(project.currentProjectPath()).replace(/\\/g, "/");
        var base = pp.replace(/\/+$/, "");
        base = base.substring(base.lastIndexOf("/") + 1);
        if (base) projName = base;
    } catch (e) {}
    return projName;
}

function writeProjectJson(env) {
    env.common.writeTextFile(env.stagingDir + "/project.json", JSON.stringify({
        sboardx: "1.0",
        app: "Toon Boom Storyboard Pro (TB_ExportSboardx)",
        created_at: env.nowIso,
        modified_at: env.nowIso,
        name: projectDisplayName(),
        episode: "",
        canvas: {
            width: env.frameW,
            height: env.frameH,
            resolution: { width: env.resW, height: env.resH },
            fps: env.fps
        }
    }));
}

function writeSequenceJson(env) {
    env.common.writeTextFile(env.stagingDir + "/sequence.json", JSON.stringify({
        panels: env.panelIds,
        scenes: env.scenes
    }));
}

function zipStagingFolder(env) {
    var entries = ["project.json", "sequence.json", "panels", "audio"];
    if (env.counts.rasterLayers > 0) entries.push("images");
    return env.common.createStoreZip(env.stagingDir, entries, env.zipPath,
                                     env.log.warn);
}

function exportSummary(env) {
    var c = env.counts;
    var summary = "Exported " + c.scenes + " scene(s), " + c.panels +
                  " panel(s), " + (c.layers - c.rasterLayers) +
                  " vector art layer(s)" +
                  (c.rasterLayers > 0
                       ? " and " + c.rasterLayers + " image layer(s)" : "") +
                  " to\n" + env.zipPath + ".";
    if (c.camScenes > 0) {
        summary += "\n\nCamera moves exported for " + c.camScenes + " scene(s).";
    }
    if (c.audioClips > 0) {
        summary += "\n\nAudio: " + c.audioClips + " clip(s) on " +
                   c.audioTracks + " track(s) (gain and mutes are not exported).";
    }
    if (c.rasterLayers > 0) {
        summary += "\n\nImage layers are rendered at the project resolution " +
                   "and cropped to the frame.";
    }
    summary += "\n\nGradients are approximated by their solid base color.";
    if (env.log.warnings.length > 0) {
        summary += "\n\nWarnings:\n- " + env.log.warnings.join("\n- ");
    }
    return summary;
}

exports.exportToFile = exportToFile;
