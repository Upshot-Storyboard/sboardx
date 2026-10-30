// sboardx_export.js — the implementation behind TB_ExportSboardx.js, loaded
// via require() so Storyboard Pro's Scripts Manager lists only the entry
// points. Needs sboardx_common.js in the same folder. See README.md.

var common = require("./sboardx_common.js");

function exportToFile(zipPath, quiet) {
    var log = common.makeLog("[sboardx-export] ", quiet);
    if (!common.requireApi(log)) return false;
    if (!common.ensureProjectSaved(log, quiet, "The export")) {
        log.report("Export cancelled: the project was not saved.\n\nSave it (File > Save) and export again.", true);
        return false;
    }
    var env = makeExportEnv(log, zipPath);
    if (project.getFrameRate() !== env.fps) {
        log.warn("project frame rate " + project.getFrameRate() + " is not a whole number; Upshot will refuse the archive");
    }
    env.progress = common.makeProgress("Exporting .sboardx", quiet);
    try {
        env.idMap = common.loadIdMap(env.sb, log);
        env.progress.begin(common.countPanels(env.sb));
        walkProject(env);
        collectLibraryDrawings(env);
        env.progress.busy("Recording the merge baselines…");
        stampIdMap(env);   // before project.json: it decides the declared bases
        writeProjectJson(env);
        writeSequenceJson(env);
        writePalettesJson(env);
        writeSharedArt(env);
        env.progress.busy("Copying audio…");
        writeAudioClips(env);
        env.progress.busy("Creating the .sboardx archive…");
        var warningsBefore = log.warnings.length;
        if (!zipStagingFolder(env)) {
            env.progress.close();
            log.report("Could not create the .sboardx zip.\n\n" + log.warnings.slice(warningsBefore).join("\n") +
                       "\n\nZipping uses 'tar' (built into Windows 10+ and macOS).\nThe staged files are in:\n" +
                       env.stagingDir, true);
            return false;
        }
        // The merge baselines describe this archive: keep them with the project.
        project.saveAll();
    } catch (err) {
        env.progress.close();
        if (err && err.sboardxCancelled) log.report("Export cancelled. Nothing was written to\n" + zipPath, true);
        else log.report("sboardx export failed: " + err, true);
        return false;
    }
    env.progress.close();
    log.report(log.summary(exportSummary(env)), false);
    return true;
}

// One export run: the staging folder, the project's managers and
// dimensions, the counters. `zipPath` may be empty for a staging-only
// environment (the own-form exports below).
function makeExportEnv(log, zipPath) {
    zipPath = String(zipPath || "").replace(/\\/g, "/");
    if (zipPath && !/\.sboardx$/i.test(zipPath)) zipPath += ".sboardx";
    var stagingDir = common.makeTempDir("export");
    new Dir(stagingDir + "/audio").mkdirs();
    new Dir(stagingDir + "/images").mkdirs();
    new Dir(stagingDir + "/raster").mkdirs();

    var sb = new StoryboardManager(), lm = new LayerManager(), cm = new CaptionManager();
    // sboardx's canvas.fps is a whole number: a near-integer rate is written
    // as that integer (exportToFile warns about anything else).
    var fps = project.getFrameRate();
    if (Math.abs(fps - Math.round(fps)) < 0.05) fps = Math.round(fps);
    var resW = project.currentResolutionX(), resH = project.currentResolutionY();
    var frameH = 540.0, frameW = frameH * resW / resH;
    // layerOpacity() needs a GUI session; in -batch it throws and the saved
    // opacities are read from the project file instead.
    var hasSession = true;
    try { lm.layerOpacity(String(sb.panelInScene(String(sb.sceneInProject(0)), 0)), 0); } catch (e) { hasSession = false; }

    return {
        log: log,
        progress: common.makeProgress("", true),
        zipPath: zipPath,
        stagingDir: stagingDir,
        sb: sb, lm: lm, cm: cm,
        mm: new MotionManager(),
        fm: new FunctionManager(),
        hasSession: hasSession,
        fps: fps,
        resW: resW, resH: resH,
        frameW: frameW, frameH: frameH,
        worldPerDrawing: frameH / 3750.0,
        fields: common.cameraFields(frameH),
        notesCaption: common.findPanelCaption(cm, "notes"),
        dialogueCaption: common.findPanelCaption(cm, "dialogue"),
        nowIso: new Date().toISOString(),
        scenes: [],
        sequences: [],
        exportedPanels: [],   // {native, outId} in archive order
        idMap: { v: 1, panels: {}, scenes: {} },
        usedIds: {},
        shared: { byFile: {}, list: [] },
        sceneFileText: undefined,
        textureImages: {},
        syncBases: {},
        counts: { scenes: 0, panels: 0, layers: 0, rasterLayers: 0, atlasLayers: 0,
                  texturedStrokes: 0, atlasPixels: 0, audioClips: 0, palettes: 0 },
        warnedOnce: {}
    };
}

// A warning written once per key for the whole export (the per-layer,
// per-panel repeats of one cause drown the summary dialog).
function warnOnce(env, key, text) {
    if (env.warnedOnce[key]) return;
    env.warnedOnce[key] = true;
    env.log.warn(text);
}

// Art beyond the default frame is rendered zoomed out, up to this factor.
// The render asks for the frame's pixel density; Storyboard Pro caps a
// render at 4096 px wide, so beyond about two frames out (at 1080p) the
// textures come at a lower density, never cut.
var MAX_RENDER_SCALE = 4;

// ── Merge baselines (SPEC.md "Merging", sboardx_common.js loadIdMap) ────────

// After the panels are staged: every exported panel's archive digest is its
// `digest` and its `local` (the archive carries exactly this form). A panel
// whose form still equals its `local` is unchanged since its last exchange:
// its entry stands and the export declares that exchange's digest as the
// panel's base in project.json `sync.panels` — the receiver, whose baseline
// is that digest, reads the panel as unchanged whatever this writer's bytes.
function stampIdMap(env) {
    var declared = 0;
    env.exportedPanels.forEach(function (e) {
        var digest = common.archivePanelDigest(env.stagingDir, e.outId);
        var prev = env.idMap.panels[e.native];
        if (prev && prev.id === e.outId && prev.local === digest && /^[0-9a-f]{16}$/.test(String(prev.digest))) {
            env.syncBases[e.outId] = String(prev.digest);
            declared++;
        } else {
            env.idMap.panels[e.native] = { id: e.outId, digest: digest, local: digest };
        }
    });
    env.log.trace("merge bases declared for " + declared + " of " + env.exportedPanels.length + " panel(s)");
    common.saveIdMap(env.sb, env.idMap);
}

// one panel staged in the form the real export writes (its archive id, the
// id map): {dir, outId, hex} — the merge's "changed here?" check and the
// `local` baseline. Reads the saved drawings, so callers save first.
function ownForm(xenv, sceneId, panelId) {
    var outId = common.archiveIdOf(xenv.idMap, panelId);
    var firstPanel = String(xenv.sb.panelInScene(sceneId, 0));
    exportPanel(xenv, sceneId, String(xenv.sb.nameOfScene(sceneId)), panelId, outId, readSceneCamera(xenv, sceneId, firstPanel));
    return { dir: xenv.stagingDir, outId: outId, hex: common.archivePanelDigest(xenv.stagingDir, outId) };
}

// The `local` baseline of the panels in `onlyPanels` (every mapped panel
// without one when the list is empty); the number stamped.
function stampOwnForms(xenv, idMap, onlyPanels) {
    var only = null;
    if (onlyPanels && onlyPanels.length) {
        only = {};
        onlyPanels.forEach(function (p) { only[String(p)] = true; });
    }
    var stamped = 0;
    common.forEachPanel(xenv.sb, function (sceneId, pid) {
        var entry = idMap.panels[pid];
        if (!entry || (only ? !only[pid] : !!entry.local)) return;
        try {
            entry.local = ownForm(xenv, sceneId, pid).hex;
            stamped++;
        } catch (e) {
            xenv.log.warn("panel " + pid + ": own form not stamped (" + e + ")");
        }
    });
    return stamped;
}

// The end of an import or update, after its undo accumulation: the map and
// the project saved (the own forms read saved files), the filled panels'
// baselines stamped, saved again.
function finishExchange(log, idMap, onlyPanels) {
    var sb = new StoryboardManager();
    common.saveIdMap(sb, idMap);
    project.saveAll();
    var xenv = makeExportEnv(log, "");
    xenv.idMap = idMap;
    var stamped = stampOwnForms(xenv, idMap, onlyPanels);
    if (stamped > 0) {
        common.saveIdMap(sb, idMap);
        project.saveAll();
    }
    log.trace("own-form baselines stamped: " + stamped);
}

// ── The project walk ────────────────────────────────────────────────────────

// Ids are unique within the archive: the first holder of an id keeps it,
// a later one falls back to a suffixed id.
function uniqueId(env, wanted, fallback) {
    var id = (wanted && /^[A-Za-z0-9_-]+$/.test(wanted)) ? wanted : fallback;
    if (env.usedIds[id]) {
        var n = 2;
        while (env.usedIds[fallback + "-" + n]) n++;
        id = fallback + "-" + n;
    }
    env.usedIds[id] = true;
    return id;
}

function walkProject(env) {
    var sceneOutIds = {};
    for (var s = 0; s < env.sb.numberOfScenesInProject(); s++) {
        var sceneId = String(env.sb.sceneInProject(s));
        var sceneName = String(env.sb.nameOfScene(sceneId));
        var numPanels = env.sb.numberOfPanelsInScene(sceneId);
        var firstPanelId = numPanels > 0 ? String(env.sb.panelInScene(sceneId, 0)) : "";
        var camKfs = readSceneCamera(env, sceneId, firstPanelId);
        var sceneOutId = uniqueId(env, env.idMap.scenes[sceneId] || sceneId, sceneId);
        sceneOutIds[sceneId] = sceneOutId;
        env.idMap.scenes[sceneId] = sceneOutId;

        var scenePanels = [], sceneLayerInfo = [];
        for (var pi = 0; pi < numPanels; pi++) {
            var panelId = String(env.sb.panelInScene(sceneId, pi));
            if (env.progress.cancelled()) throw { sboardxCancelled: true };
            env.progress.step("Panel " + env.sb.nameOfPanel(panelId) + " (scene " + sceneName + ")");
            var panelOutId = uniqueId(env, common.archiveIdOf(env.idMap, panelId), panelId);
            env.exportedPanels.push({ native: panelId, outId: panelOutId });
            scenePanels.push(panelOutId);
            sceneLayerInfo.push(exportPanel(env, sceneId, sceneName, panelId, panelOutId, camKfs));
        }
        var sceneObj = { id: sceneOutId, name: sceneName, panels: scenePanels, camera: { keyframes: camKfs } };
        env.progress.busy("Reading layer animation (scene " + sceneName + ")…");
        var tracks = readLayerTracks(env, sceneLayerInfo);
        if (tracks.length > 0) sceneObj.layer_tracks = tracks;
        env.scenes.push(sceneObj);
        env.counts.scenes++;
    }
    walkSequences(env, sceneOutIds);
}

// Storyboard Pro sequences -> sequence.json "sequences" (optional; Upshot
// re-mints the ids).
function walkSequences(env, sceneOutIds) {
    for (var i = 0; i < env.sb.numberOfSequencesInProject(); i++) {
        var seqId = String(env.sb.sequenceInProject(i));
        var name = String(env.sb.nameOfSequence(seqId));
        var scenes = [];
        for (var j = 0; j < env.sb.numberOfScenesInSequence(seqId); j++) {
            var sid = String(env.sb.sceneInSequence(seqId, j));
            if (sceneOutIds.hasOwnProperty(sid)) scenes.push(sceneOutIds[sid]);
        }
        if (scenes.length && name) env.sequences.push({ id: uniqueId(env, seqId, "seq-" + (i + 1)), name: name, scenes: scenes });
    }
}

// panelId is Storyboard Pro's (every API call); outId names the panel in the
// archive (directory, panel.json id, SVG panel-id, image files). Every layer
// is parsed first, then the panel's renders run in one undo accumulation
// (an atlas needs the layer's own render), then every art SVG is written
// once with whatever the renders yielded.
function exportPanel(env, sceneId, sceneName, panelId, outId, camKfs) {
    var panelDir = env.stagingDir + "/panels/" + outId;
    new Dir(panelDir + "/art").mkdirs();
    writePanelJson(env, panelDir, sceneName, panelId, outId);
    common.writeTextFile(panelDir + "/camera.json", JSON.stringify({ keyframes: [] }));

    var layers = [], pending = [], rasterJobs = [], layerIndices = [];
    var groupNames = {};   // SBP index of a group layer -> its name
    var numLayers = env.lm.numberOfLayers(panelId);
    var li;
    for (li = 0; li < numLayers; li++) {
        if (env.lm.isGroupLayer(panelId, li) === true) groupNames[li] = String(env.lm.layerName(panelId, li));
    }
    // SBP index 0 is the top layer; sboardx lists bottom-to-top. Group layers
    // are folders, not art: skipped, their members carry the group's name.
    for (li = numLayers - 1; li >= 0; li--) {
        if (groupNames.hasOwnProperty(li)) continue;
        var layer = exportLayer(env, panelDir, panelId, outId, li, rasterJobs);
        var owner = env.lm.groupOfLayer(panelId, li);
        if (owner >= 0 && groupNames.hasOwnProperty(owner)) layer.entry.group = groupNames[owner];
        layers.push(layer.entry);
        pending.push(layer);
        layerIndices.push(li);
        env.counts.layers++;
    }
    if (rasterJobs.length > 0) rasterizePanel(env, sceneId, panelId, outId, rasterJobs, camKfs);
    pending.forEach(function (p) { writeLayerArt(env, outId, p); });
    common.writeTextFile(panelDir + "/layers.json", JSON.stringify({ layers: layers }));
    env.counts.panels++;
    return { panelId: panelId, entries: layers, indices: layerIndices, groups: groupNames };
}

function writePanelJson(env, panelDir, sceneName, panelId, outId) {
    // `code` is the display code "<scene>-<panel>"; `shot` is the SPEC's
    // shot type, which Storyboard Pro has no field for.
    var panelObj = {
        id: outId,
        code: sceneName + "-" + String(env.sb.nameOfPanel(panelId)),
        shot: "",
        dur: env.sb.getPanelDuration(panelId) / env.fps,
        note: panelCaptionText(env, env.notesCaption, panelId)
    };
    var dialogueText = panelCaptionText(env, env.dialogueCaption, panelId);
    if (dialogueText) panelObj.dialogue = dialogueText;
    common.writeTextFile(panelDir + "/panel.json", JSON.stringify(panelObj));
}

function panelCaptionText(env, captionName, panelId) {
    if (!captionName) return "";
    var text = String(env.cm.textOfPanelCaption(captionName, panelId) || "");
    if (text.indexOf("<") !== -1) {
        text = text.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]*>/g, "")
                   .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
                   .replace(/^\s+|\s+$/g, "");
    }
    return text;
}

// Reads one layer: its layers.json entry plus the pending record exportPanel
// finishes after the renders — the drawing parsed once, the art SVG's path,
// the render job when the layer needs one, the shared drawing it holds.
function exportLayer(env, panelDir, panelId, outId, li, rasterJobs) {
    var layerName = String(env.lm.layerName(panelId, li));
    var layerId = "layer" + li;
    var isBitmap = env.lm.isBitmapLayer(panelId, li) === true;
    // A vector layer nobody has drawn on has no drawing file yet: exported empty.
    var tvgPath = isBitmap ? "" : String(env.lm.getLayerDrawingName(panelId, li, true) || "");
    var shared = tvgPath && env.lm.isShared(panelId, li) === true
        ? sharedDrawingRecord(env, tvgPath, sharedDrawingName(env, panelId, li, tvgPath, layerName)) : null;
    var model = parseDrawing(env, tvgPath, "panel " + panelId + " layer '" + layerName + "'");
    var needsRaster = isBitmap || model.usedTexture;
    var atlasJob = null;
    if (needsRaster && !isBitmap && model.textured.length > 0) {
        // Textured strokes (SPEC.md "Textured strokes"): the layer stays a
        // vector layer; its textured contours get tiles cut from the layer's
        // own render into a per-layer atlas. A failed render leaves the
        // atlas null and the layer is written flat.
        needsRaster = false;
        atlasJob = { kind: "atlas", li: li, layerId: layerId, layerName: layerName, textured: model.textured, atlas: null };
    } else if (needsRaster && !isBitmap) {
        model = emptyModel();   // a texture colour on pencil lines only: the whole layer as an image
    }
    var entry = {
        id: layerId,
        name: layerName,
        color_tag: "#999999",
        opacity: layerOpacityOf(env, panelId, li),
        blend: "normal",
        locked: env.lm.getLayerLock(panelId, li) === true,
        visible: env.lm.layerVisibility(panelId, li) !== false,
        art: "art/" + layerId + ".svg"
    };
    if (shared) entry.shared = shared.id;
    if (needsRaster) rasterJobs.push({ kind: "image", li: li, layerId: layerId, layerName: layerName, entry: entry });
    else if (atlasJob) { atlasJob.entry = entry; rasterJobs.push(atlasJob); }
    return { entry: entry, layerId: layerId, layerName: layerName,
             svgPath: panelDir + "/art/" + layerId + ".svg", model: model, atlasJob: atlasJob, shared: shared };
}

// The one write of a layer's art SVG: with the atlas its job produced, flat
// otherwise. A shared layer also offers its drawing and atlas for the
// shared art: the first holder with an atlas wins (every holder's tiles
// apply one to one — the drawing is the same file).
function writeLayerArt(env, outId, layer) {
    var atlas = layer.atlasJob ? layer.atlasJob.atlas : null;
    common.writeTextFile(layer.svgPath, emitLayerSvg(env, layer.model, layer.layerId, layer.layerName, outId, atlas));
    if (atlas) env.counts.atlasLayers++;
    var rec = layer.shared;
    if (rec && !(rec.model && (rec.atlas || !atlas))) {
        rec.model = layer.model;
        rec.atlas = atlas;
    }
}

// Layer opacity (0..100): live in a session, from the saved .sboard in batch.
function layerOpacityOf(env, panelId, li) {
    if (env.hasSession) return env.lm.layerOpacity(panelId, li);
    if (env.sceneFileText === undefined) {
        var names = new Dir(projectDir()).entryList("*.sboard");
        env.sceneFileText = names && names.length ? common.readTextFile(projectDir() + "/" + names[0]) : null;
    }
    return env.sceneFileText ? sceneFileLayerOpacity(env.sceneFileText, panelId, String(env.lm.layerName(panelId, li))) : 100;
}

// The <opacity val> of the READ module named `layerName` inside the panel's
// <scene id=…> element; 100 if absent.
function sceneFileLayerOpacity(text, panelId, layerName) {
    var start = -1, from = 0;
    while (start < 0) {
        var hit = text.indexOf(' id="' + panelId + '"', from);
        if (hit < 0) return 100;
        var open = text.lastIndexOf("<", hit);
        if (open >= 0 && text.substring(open, open + 7) === "<scene " && text.indexOf(">", open) > hit) start = open;
        from = hit + 1;
    }
    var end = text.indexOf("</scene>", start);
    var block = text.substring(start, end < 0 ? text.length : end);
    var m = block.indexOf('<module type="READ" name="' + layerName + '"');
    if (m < 0) return 100;
    var next = block.indexOf("<module ", m + 8);
    var r = /<opacity val="([0-9.]+)"/.exec(block.substring(m, next < 0 ? block.length : next));
    var v = r ? parseFloat(r[1]) : NaN;
    return isFinite(v) ? Math.max(0, Math.min(100, v)) : 100;
}

function projectDir() {
    return String(project.currentProjectPath()).replace(/\\/g, "/").replace(/\/+$/, "");
}

// ── Shared drawings (SPEC.md "shared/") ─────────────────────────────────────

// One record per drawing file, the one identity Storyboard Pro gives a
// shared drawing. The id hashes the file's path inside the project
// ("elements/Shared/Shared-A.tvg"), so a moved or copied project keeps it.
function sharedDrawingRecord(env, tvgPath, name) {
    var p = String(tvgPath).replace(/\\/g, "/");
    var rec = env.shared.byFile[p];
    if (rec) return rec;
    var at = p.lastIndexOf("/elements/");
    rec = { id: "sd-" + common.fnv32Hex(at >= 0 ? p.substring(at + 1) : p), name: name, model: null, atlas: null };
    env.shared.byFile[p] = rec;
    env.shared.list.push(rec);
    return rec;
}

// The project's shared drawings are a library of their own (the "Shared"
// element): every one goes out, held by a layer or not. A drawing no layer
// holds is read from its file here and, as no panel can render it, its
// textures are painted by the script (renderTexturedModel) for the atlas.
function collectLibraryDrawings(env) {
    for (var i = 0; i < element.numberOf(); i++) {
        var eid = element.id(i);
        if (String(element.getNameById(eid)) !== "Shared") continue;
        for (var d = 0; d < Drawing.numberOf(eid); d++) {
            var name = String(Drawing.name(eid, d));
            var path = String(Drawing.filename(eid, name) || "").replace(/\\/g, "/");
            if (!path || env.shared.byFile[path]) continue;
            var rec = sharedDrawingRecord(env, path, name.replace(/^Shared[-_ ]/i, ""));
            rec.model = parseDrawing(env, path, "shared drawing '" + rec.name + "'");
            if (rec.model.textured.length) {
                var outId = "shared-" + rec.id;
                var job = { kind: "atlas", layerId: rec.id, layerName: rec.name, textured: rec.model.textured, atlas: null };
                var src = renderTexturedModel(env, rec.model, outId);
                if (src) buildAtlas(env, outId, job, src, 1);
                rec.atlas = job.atlas;
            }
            if (rec.model.usedTexture && !rec.atlas) env.log.warn("shared drawing '" + rec.name + "' is held by no layer and its textures could not be painted: written flat");
        }
    }
}

// ── Textures painted in script (a drawing no panel shows) ───────────────────

// The textured contours of a drawing as the frame at the project resolution,
// painted the way Storyboard Pro paints a texture colour: the texture image
// mapped by the contour's matrix (the unit square onto its box, rows
// upward) through the outline. The atlas job cuts its tiles from it. Null
// when nothing could be painted (a textured brush stroke has no file).
function renderTexturedModel(env, model, outId) {
    var s = env.worldPerDrawing, sx = env.resW / env.frameW, sy = env.resH / env.frameH;
    var img = new QImage(env.resW, env.resH, QImage.Format_ARGB32_Premultiplied);
    img.fill(0);
    var painter = new QPainter(), painted = 0;
    painter.begin(img);
    painter.setRenderHint(QPainter.Antialiasing, true);
    painter.setRenderHint(QPainter.SmoothPixmapTransform, true);
    model.textured.forEach(function (t) {
        var c = t.contour, m = c.matrix, tex = m ? textureImage(env, c.colorId) : null;
        if (!tex) return;
        var tw = tex.width(), th = tex.height();
        var brush = new QBrush(tex);
        brush.setTransform(new QTransform(m.xx * s * sx / tw, -m.xy * s * sy / tw, -m.yx * s * sx / th, m.yy * s * sy / th,
                                          (m.ox + m.yx) * s * sx + env.frameW / 2 * sx, -(m.oy + m.yy) * s * sy + env.frameH / 2 * sy));
        painter.fillPath(contourPainterPath(env, c, 0, 0, sx, sy, env.frameW / 2, env.frameH / 2), brush);
        painted++;
    });
    painter.end();
    if (!painted) return null;
    var path = env.stagingDir + "/raster/" + outId + ".png";
    return img.save(path, "PNG") ? path : null;
}

// A texture colour's full-size image, `palette-library/<palette>_textures/
// <colourId>.tga` beside the project or under an element (the colour's own
// `image` is a thumbnail); cached per colour, null when there is none.
function textureImage(env, colorId) {
    var cache = env.textureImages;
    if (cache[colorId] !== undefined) return cache[colorId];
    var root = projectDir(), found = null;
    function look(base) {
        if (found || !new File(base).exists) return;
        (new Dir(base).entryList("*", DirSpec.Dirs) || []).forEach(function (d) {
            var cand = base + "/" + d + "/" + colorId + ".tga";
            if (!found && d !== "." && d !== ".." && new File(cand).exists) found = cand;
        });
    }
    look(root + "/palette-library");
    (new Dir(root + "/elements").entryList("*", DirSpec.Dirs) || []).forEach(function (e) {
        if (e !== "." && e !== "..") look(root + "/elements/" + e + "/palette-library");
    });
    cache[colorId] = found ? loadTga(found) : null;
    return cache[colorId];
}

// A Targa file as a QImage (Qt reads no TGA): 32-bit, raw or run-length,
// either row order; null for anything else.
function loadTga(path) {
    var f = new QFile(path);
    if (!f.open(QIODevice.ReadOnly)) return null;
    var ba = f.readAll();
    f.close();
    var n = ba.size();
    function u8(i) { return ba.at(i) & 255; }
    if (n < 18) return null;
    var idLen = u8(0), type = u8(2), w = u8(12) | (u8(13) << 8), h = u8(14) | (u8(15) << 8), topDown = (u8(17) & 32) !== 0;
    if ((type !== 2 && type !== 10) || u8(16) !== 32 || w <= 0 || h <= 0) return null;
    var img = new QImage(w, h, QImage.Format_ARGB32);
    var i = 18 + idLen, total = w * h, k = 0;
    function put(b, g, r, a) {
        var row = Math.floor(k / w);
        img.setPixel(k % w, topDown ? row : h - 1 - row, a * 16777216 + (r << 16) + (g << 8) + b);
        k++;
    }
    while (k < total && i + 4 <= n) {
        if (type === 2) { put(u8(i), u8(i + 1), u8(i + 2), u8(i + 3)); i += 4; continue; }
        var head = u8(i++), count = (head & 127) + 1;
        if (head & 128) {
            var b = u8(i), g = u8(i + 1), r = u8(i + 2), a = u8(i + 3);
            i += 4;
            for (var c = 0; c < count && k < total; c++) put(b, g, r, a);
        } else {
            for (var c2 = 0; c2 < count && k < total && i + 4 <= n; c2++) { put(u8(i), u8(i + 1), u8(i + 2), u8(i + 3)); i += 4; }
        }
    }
    return k === total ? img : null;
}

// The drawing's name lives in its file ("Shared-<name>.tvg"), not on the
// layer: the short drawing name first, the path's basename next, the
// holder's layer name last.
function sharedDrawingName(env, panelId, li, tvgPath, layerName) {
    var raw = String(env.lm.getLayerDrawingName(panelId, li, false) || tvgPath || "");
    var name = common.fileBasename(raw).replace(/\.tvg$/i, "").replace(/^Shared[-_ ]/i, "");
    return name || layerName;
}

// shared/<id>/art.svg from the best holder's drawing and atlas, plus
// shared/index.json, at the end of the export.
function writeSharedArt(env) {
    if (!env.shared.list.length) return;
    var index = env.shared.list.map(function (rec) {
        var dir = env.stagingDir + "/shared/" + rec.id;
        new Dir(dir).mkdirs();
        // The pattern hrefs climb from shared/<id>/ (two levels), not from panels/<pid>/art/ (three).
        var atlas = rec.atlas ? { file: rec.atlas.file, w: rec.atlas.w, h: rec.atlas.h, tiles: rec.atlas.tiles, up: "../../images/" } : null;
        common.writeTextFile(dir + "/art.svg", emitLayerSvg(env, rec.model || emptyModel(), rec.id, rec.name, "shared-" + rec.id, atlas));
        return { id: rec.id, name: rec.name, art: rec.id + "/art.svg" };
    });
    common.writeTextFile(env.stagingDir + "/shared/index.json", JSON.stringify({ drawings: index }));
}

// ── Drawings -> SVG ─────────────────────────────────────────────────────────

function fmtNum(v) {
    return String(Math.round(v * 1000) / 1000);
}

function drawingToWorld(env, p) {
    return { x: p.x * env.worldPerDrawing, y: -p.y * env.worldPerDrawing };
}

function emptyModel() {
    return { items: [], textured: [], usedTexture: false };
}

// The drawing read once (Drawing.query.getData reads the saved file) and
// reduced to what its SVG needs: `items` in drawing order — a filled contour
// {d, col, contour, texturedIndex} or a pencil line {d, col, line, width} —
// and `textured`, the textured contours in item order with their world
// bounds (the atlas job cuts tile k for entry k). `usedTexture` says the
// drawing paints with a texture colour at all.
function parseDrawing(env, tvgPath, label) {
    var model = emptyModel();
    if (!tvgPath) return model;
    var data = null;
    try { data = Drawing.query.getData({ drawing: { filename: tvgPath } }); }
    catch (e) { env.log.warn("Drawing.query.getData failed for " + label + ": " + e); }
    if (!data || !data.arts) return model;
    data.arts.slice().sort(function (a, b) { return a.art - b.art; }).forEach(function (art) {
        (art.layers || []).forEach(function (layer) { parseDrawables(env, layer, data.colors, model); });
    });
    return model;
}

function parseDrawables(env, vectorLayer, colors, model) {
    (vectorLayer.contours || []).forEach(function (contour) {
        var d = svgPathData(env, contour.path, true);
        if (!d) return;
        (contour.holes || []).forEach(function (hole) {
            var hd = svgPathData(env, hole, true);
            if (hd) d += " " + hd;
        });
        var col = lookupColor(colors, contour.colorId, model);
        // A textured brush stroke keeps a solid colour; what marks it is its
        // texture matrix (the unit square mapped onto the contour's box). A
        // plain contour has no matrix or the identity.
        if (!col.isTexture && contourHasTextureMatrix(contour)) {
            model.usedTexture = true;
            col = { hex: col.hex, alpha: col.alpha, rgb: col.rgb, isTexture: true, brush: true };
        }
        var item = { d: d, col: col, contour: contour, texturedIndex: -1 };
        if (col.isTexture) {
            item.texturedIndex = model.textured.length;
            model.textured.push({ contour: contour, bb: contourWorldBounds(env, contour) });
        }
        model.items.push(item);
    });
    (vectorLayer.strokes || []).forEach(function (st) {
        if (st.invisible) return;
        var d = svgPathData(env, st.path, st.closed === true);
        if (!d) return;
        // A gradient on a pencil line flattens to its first stop.
        model.items.push({ d: d, col: lookupColor(colors, st.colorId, model), line: true,
                           width: pencilWidthDrawing(st, vectorLayer.thicknessPaths) * env.worldPerDrawing });
    });
}

// Walks a drawing path's on/off-curve points as line, quadratic and cubic
// segments: sink.move/line/quad/cubic with points mapped by `map`; a closed
// path's trailing control points bend back to the first point. False for
// an empty path.
function tracePath(pts, closed, map, sink) {
    if (!pts || !pts.length) return false;
    var first = map(pts[0]);
    sink.move(first);
    var ctrl = [];
    function emit(anchor) {
        if (ctrl.length === 0) sink.line(anchor);
        else if (ctrl.length === 1) sink.quad(map(ctrl[0]), anchor);
        else sink.cubic(map(ctrl[0]), map(ctrl[1]), anchor);
        ctrl = [];
    }
    for (var i = 1; i < pts.length; i++) {
        if (pts[i].onCurve) emit(map(pts[i]));
        else ctrl.push(pts[i]);
    }
    if (ctrl.length) emit(closed ? first : map(ctrl.pop()));
    return true;
}

function svgPathData(env, path, closed) {
    var d = "";
    function pt(p) { return fmtNum(p.x) + " " + fmtNum(p.y); }
    var ok = tracePath(path, closed, function (p) { return drawingToWorld(env, p); }, {
        move: function (p) { d = "M " + pt(p); },
        line: function (p) { d += " L " + pt(p); },
        quad: function (c, p) { d += " Q " + pt(c) + " " + pt(p); },
        cubic: function (c0, c1, p) { d += " C " + pt(c0) + " " + pt(c1) + " " + pt(p); }
    });
    return ok ? (closed ? d + " Z" : d) : "";
}

function contourHasTextureMatrix(contour) {
    var m = contour ? contour.matrix : null;
    if (!m || typeof m.xx !== "number") return false;
    var eps = 1e-6;
    return !(Math.abs(m.xx - 1) < eps && Math.abs(m.yy - 1) < eps && Math.abs(m.xy || 0) < eps &&
             Math.abs(m.yx || 0) < eps && Math.abs(m.ox || 0) < eps && Math.abs(m.oy || 0) < eps);
}

function pencilWidthDrawing(st, thicknessPaths) {
    var t = st.thickness;
    if (!t) return 2;
    if (t.hasOwnProperty("constant")) return 2 * t.constant;
    var tp = (thicknessPaths && t.thicknessPath !== undefined) ? thicknessPaths[t.thicknessPath] : null;
    if (tp) return tp.minThickness + tp.maxThickness;
    if (t.minThickness !== undefined) return t.minThickness + t.maxThickness;
    return 2;
}

// A drawable's paint from the drawing's colour table: {hex, alpha, rgb}, plus
// `isTexture` for a texture colour or `gradient: {type, stops}` for a
// gradient colour (its first stop is the flat colour).
function lookupColor(colors, colorId, model) {
    var c = colors && colors[colorId];
    if (c && c.isTexture) {
        model.usedTexture = true;
        return { hex: "#000000", alpha: 1, rgb: [0, 0, 0], isTexture: true };
    }
    var stops = c ? gradientStopsOf(c) : null;
    if (stops) {
        return { hex: common.colorHex(stops[0]), alpha: stops[0].a / 255.0, rgb: rgb01(stops[0]),
                 gradient: { type: c.gradient === "radial" ? "radial" : "linear", stops: stops } };
    }
    if (!c || typeof c.r !== "number") return { hex: "#000000", alpha: 1, rgb: [0, 0, 0] };
    return { hex: common.colorHex(c), alpha: common.clamp01(((typeof c.a === "number") ? c.a : 255) / 255.0), rgb: rgb01(c) };
}

function rgb01(c) {
    return [c.r / 255, c.g / 255, c.b / 255];
}

// Gradient stops as 8-bit {r,g,b,a} + t (0..1), sorted; null for a solid.
function gradientStopsOf(c) {
    var raw = c.gradientData;
    if (!raw || typeof raw.length !== "number" || raw.length < 2) return null;
    var stops = [];
    for (var i = 0; i < raw.length; i++) {
        var st = raw[i];
        if (!st || typeof st.r !== "number") return null;
        var t = (typeof st.percent === "number") ? st.percent : i / (raw.length - 1);
        stops.push({ r: st.r, g: st.g, b: st.b, a: (typeof st.a === "number") ? st.a : 255, t: common.clamp01(t) });
    }
    stops.sort(function (x, y) { return x.t - y.t; });
    return stops;
}

// Shader matrix (drawing units, y up) -> unit->world affine.
function affineFromShaderMatrix(env, m) {
    var s = env.worldPerDrawing;
    return [m.xx * s, -m.xy * s, m.yx * s, -m.yy * s, m.ox * s, -m.oy * s];
}

// World-unit bounds of a contour; null for an empty path.
function contourWorldBounds(env, contour) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    [contour.path].concat(contour.holes || []).forEach(function (pts) {
        (pts || []).forEach(function (p) {
            var w = drawingToWorld(env, p);
            if (w.x < minX) minX = w.x; if (w.x > maxX) maxX = w.x;
            if (w.y < minY) minY = w.y; if (w.y > maxY) maxY = w.y;
        });
    });
    return isFinite(minX) ? { minX: minX, minY: minY, maxX: maxX, maxY: maxY } : null;
}

// Upshot's auto-fit rule at 0°: linear left -> right across the box, radial
// on the inscribed ellipse.
function fitGradientAffine(type, bb) {
    if (!bb) return [1, 0, 0, 1, 0, 0];
    var w = Math.max(bb.maxX - bb.minX, 1e-6), h = Math.max(bb.maxY - bb.minY, 1e-6);
    var cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
    if (type === "radial") return [w / 2, 0, 0, h / 2, cx, cy];
    return [w, 0, 0, w, bb.minX, cy];
}

// The art SVG of a parsed drawing. `atlas` ({file, w, h, tiles[k], up}):
// tile k fills the item whose texturedIndex is k with a <pattern> over the
// atlas (SPEC.md "Textured strokes"); without an atlas, or with a null tile,
// the item is a flat outline in its own colour. Pattern and gradient ids are
// per SVG, so a panel exported alone hashes like one inside a full export.
function emitLayerSvg(env, model, layerId, layerName, panelId, atlas) {
    var body = "";
    var defs = [];   // gradient and pattern definitions, first inside the <g>
    var ids = { patterns: 0, gradients: 0 };
    model.items.forEach(function (item) {
        var col = item.col;
        if (item.line) {
            body += '  <path d="' + item.d + '" fill="none" stroke="' + col.hex + '"' +
                    (col.alpha < 1 ? ' stroke-opacity="' + fmtNum(col.alpha) + '"' : '') +
                    ' stroke-width="' + fmtNum(item.width) + '" stroke-linecap="round" stroke-linejoin="round"/>\n';
            return;
        }
        var tile = item.texturedIndex >= 0 && atlas && atlas.tiles ? atlas.tiles[item.texturedIndex] : null;
        if (tile) {
            var tid = "tex" + (++ids.patterns);
            defs.push(patternDefSvg(tid, atlas, tile));
            // The flat fallback: a textured brush stroke keeps its real colour
            // at the tile's mean coverage, a texture fill the tile's mean colour.
            var fallback = col.brush ? col.rgb.concat([common.clamp01(tile.rgba[3] * col.alpha)]) : tile.rgba;
            body += '  <path d="' + item.d + '" fill="url(#' + tid + ')" sboardx:rgba="' +
                    fallback.map(fmtNum).join(" ") + '" fill-rule="nonzero" stroke="none"/>\n';
        } else if (col.gradient) {
            // Placed by the shape's matrix; fitted to its box when absent.
            var m = item.contour.matrix;
            var aff = (m && typeof m.xx === "number") ? affineFromShaderMatrix(env, m)
                                                      : fitGradientAffine(col.gradient.type, contourWorldBounds(env, item.contour));
            var gid = "tbg" + (++ids.gradients);
            defs.push(gradientDefSvg(gid, col.gradient, aff));
            body += '  <path d="' + item.d + '" fill="url(#' + gid + ')" stroke="none"/>\n';
        } else {
            body += '  <path d="' + item.d + '" fill="' + col.hex + '"' +
                    (col.alpha < 1 ? ' fill-opacity="' + fmtNum(col.alpha) + '"' : '') + ' stroke="none"/>\n';
        }
    });
    if (defs.length) body = '    <defs>\n' + defs.join("") + '    </defs>\n' + body;
    var xs = fmtNum(-env.frameW / 2), ys = fmtNum(-env.frameH / 2);
    var ws = fmtNum(env.frameW), hs = fmtNum(env.frameH);
    var xml = common.xmlEscape;
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
           '<svg xmlns="http://www.w3.org/2000/svg"\n' +
           '     xmlns:sboardx="https://sboardx.format/ns/1.0"\n' +
           '     viewBox="' + xs + ' ' + ys + ' ' + ws + ' ' + hs + '"' +
           ' width="' + ws + '" height="' + hs + '"\n' +
           '     sboardx:layer-id="' + xml(layerId) + '"\n' +
           '     sboardx:layer-name="' + xml(layerName) + '"\n' +
           '     sboardx:panel-id="' + xml(panelId) + '"\n' +
           '     sboardx:format-version="1.1">\n' +
           '  <g sboardx:blend="normal" sboardx:opacity="100">\n' +
           body +
           '  </g>\n' +
           '</svg>\n';
}

// A <pattern> over the layer's atlas tile: the tile covers the contour's
// world rect; the href is relative to the art SVG (`atlas.up`).
function patternDefSvg(id, atlas, tile) {
    return '      <pattern id="' + id + '" patternUnits="userSpaceOnUse" x="' + fmtNum(tile.world.x) +
           '" y="' + fmtNum(tile.world.y) + '" width="' + fmtNum(tile.world.w) + '" height="' +
           fmtNum(tile.world.h) + '" viewBox="' + tile.ax + ' ' + tile.ay + ' ' + tile.aw + ' ' +
           tile.ah + '" preserveAspectRatio="none">\n' +
           '        <image href="' + (atlas.up || "../../../images/") + atlas.file + '" x="0" y="0" width="' + atlas.w +
           '" height="' + atlas.h + '" preserveAspectRatio="none"/>\n' +
           '      </pattern>\n';
}

// A <linearGradient>/<radialGradient> in SPEC.md's unit-space form.
function gradientDefSvg(id, gradient, aff) {
    var tag = gradient.type === "radial" ? "radialGradient" : "linearGradient";
    var geom = gradient.type === "radial" ? ' cx="0" cy="0" r="1"' : ' x1="0" y1="0" x2="1" y2="0"';
    var xml = '      <' + tag + ' id="' + id + '" gradientUnits="userSpaceOnUse"' + geom +
              ' gradientTransform="matrix(' + aff.map(fmtNum).join(" ") + ')">\n';
    gradient.stops.forEach(function (st) {
        xml += '        <stop offset="' + fmtNum(st.t) + '" stop-color="' + common.colorHex(st) + '"' +
               (st.a < 255 ? ' stop-opacity="' + fmtNum(st.a / 255) + '"' : '') + '/>\n';
    });
    return xml + '      </' + tag + '>\n';
}

// ── Cameras and layer animation ─────────────────────────────────────────────

// The frames keyed by a 3-D path column and by plain columns, sorted, with
// the path's point at each of its own keys.
function collectKeys(env, id, pathCol, cols) {
    var fm = env.fm, frames = [], seen = {}, posAt = {};
    function add(f) { if (!seen[f]) { seen[f] = true; frames.push(f); } }
    var nb = pathCol ? fm.numberOfPointsPath3d(id, pathCol) : 0;
    for (var i = 0; i < nb; i++) {
        var f = fm.pointLockedAtFrame(id, pathCol, i);
        posAt[f] = { x: fm.pointXPath3d(id, pathCol, i), y: fm.pointYPath3d(id, pathCol, i), z: fm.pointZPath3d(id, pathCol, i) };
        add(f);
    }
    cols.forEach(function (col) {
        var n = col ? fm.numberOfPoints(id, col) : 0;
        for (var j = 0; j < n; j++) add(fm.pointX(id, col, j));
    });
    frames.sort(function (a, b) { return a - b; });
    return { frames: frames, posAt: posAt };
}

// The path's point at `frame`: its key there, else the nearest key's.
function pathPointAt(keys, frame) {
    if (keys.posAt[frame]) return keys.posAt[frame];
    var best = { x: 0, y: 0, z: 0 }, bestDist = -1;
    for (var f in keys.posAt) {
        var d = Math.abs(Number(f) - frame);
        if (bestDist < 0 || d < bestDist) { bestDist = d; best = keys.posAt[f]; }
    }
    return best;
}

// A bezier column's value at its key nearest to `frame` (fallback when empty).
function nearestKey(env, id, col, frame, fallback) {
    var fm = env.fm, best = fallback, bestDist = -1;
    var n = col ? fm.numberOfPoints(id, col) : 0;
    for (var i = 0; i < n; i++) {
        var d = Math.abs(fm.pointX(id, col, i) - frame);
        if (bestDist < 0 || d < bestDist) { bestDist = d; best = fm.pointY(id, col, i); }
    }
    return best;
}

// Layer animation -> sequence.json "layer_tracks": per scene, one track per
// animated layer name (kind "layer") or group name (kind "group"), every
// panel's keys converted from the panel's 1-based frames to scene-local
// seconds and from SBP's field units and counter-clockwise angle to the
// sboardx pose (pivot at the origin). Opacity is the layer's constant value.
function readLayerTracks(env, infos) {
    var byKey = {}, order = [], start = 0;   // start: scene-local start of the panel, seconds
    infos.forEach(function (info) {
        var panelFrames = env.sb.getPanelDuration(info.panelId);
        var targets = info.indices.map(function (li, i) { return { li: li, name: String(info.entries[i].name), kind: "layer" }; });
        for (var gk in info.groups) if (info.groups.hasOwnProperty(gk)) targets.push({ li: Number(gk), name: info.groups[gk], kind: "group" });
        targets.forEach(function (tg) {
            var keys = readLayerKeys(env, info.panelId, tg.li, panelFrames);
            if (!keys.length) return;
            var key = tg.kind + ":" + tg.name;
            if (!byKey[key]) { byKey[key] = { name: tg.name, kind: tg.kind, kfs: [] }; order.push(key); }
            var kfs = byKey[key].kfs;
            keys.forEach(function (k) {
                var t = start + k.t;
                // A key on the cut coincides with the previous panel's last key: keep one.
                if (kfs.length && Math.abs(kfs[kfs.length - 1].t - t) < 0.5 / env.fps) return;
                kfs.push({ id: "lk" + (kfs.length + 1), t: t, tx: k.tx, ty: k.ty, s: k.s, rot: k.rot, opacity: k.opacity });
            });
        });
        start += panelFrames / env.fps;
    });
    return order.map(function (key) { return byKey[key]; }).filter(function (tr) {
        return !tr.kfs.every(common.isIdentityPose);
    }).map(function (tr) {
        return { name: tr.name, kind: tr.kind, pivot: { x: 0, y: 0 }, keyframes: tr.kfs };
    });
}

// One panel's keys for one layer: the union of the frames its offset path,
// scale and rotation functions key, each sampled to a full pose (seconds
// within the panel). Empty when the layer is not animated.
function readLayerKeys(env, panelId, li, panelFrames) {
    var posCol, sxCol, rotCol, keys;
    try {
        posCol = String(env.mm.linkedLayerFunction(panelId, li, "offset.attr3dpath") || "");
        sxCol = String(env.mm.linkedLayerFunction(panelId, li, "scale.x") || "");
        rotCol = String(env.mm.linkedLayerFunction(panelId, li, "rotation.anglez") || "");
        if (!posCol && !sxCol && !rotCol) return [];
        keys = collectKeys(env, panelId, posCol, [sxCol, rotCol]);
    } catch (e) { return []; }
    var out = [];
    keys.frames.forEach(function (f) {
        if (f > panelFrames) return;
        var pos = pathPointAt(keys, f);
        var pose = common.sbpToPose(pos.x, pos.y, sxCol ? nearestKey(env, panelId, sxCol, f, 1) : 1,
                                    rotCol ? nearestKey(env, panelId, rotCol, f, 0) : 0, env.fields);
        pose.t = common.panelFrameToTime(f, env.fps);
        out.push(pose);
    });
    return out;
}

function readCameraMeta(env, firstPanelId) {
    var raw = firstPanelId ? common.panelMetaValue(env.sb, firstPanelId, "sboardx-camera") : "";
    var kfs = null;
    try { kfs = raw ? JSON.parse(raw) : null; } catch (e) {}
    return kfs && kfs.length ? kfs.slice().sort(function (a, b) { return a.t - b.t; }) : null;
}

// True when two keyframe lists describe the same camera (same keys, within
// a frame in time and 1e-3 in value).
function cameraKfsMatch(env, live, meta) {
    if (!live || !meta || live.length !== meta.length) return false;
    var tolT = 1.0 / env.fps + 1e-6;
    var keys = ["z", "cx", "cy", "rot"];
    for (var i = 0; i < live.length; i++) {
        var a = live[i], b = meta[i];
        if (Math.abs(a.t - (Number(b.t) || 0)) > tolT) return false;
        for (var k = 0; k < keys.length; k++) {
            var av = a[keys[k]], bv = Number(b[keys[k]]);
            if (keys[k] === "z" && !(bv > 0)) bv = 1;
            if (!isFinite(bv)) bv = 0;
            if (Math.abs(av - bv) > 1e-3 * Math.max(1, Math.abs(av))) return false;
        }
    }
    return true;
}

// The scene's live camera (Camera-Peg pan, scale, rotation and Z dolly) as
// sboardx keyframes; frame 1 is t = 0. A Z dolly is folded into the zoom:
// with the Camera node D fields from the drawing plane (offset.z, 12 by
// default) and the peg at pz, the frame scales by D / (D + pz).
function readLiveCamera(env, sceneId) {
    var mm = env.mm;
    var posCol = mm.linkedCameraFunction(sceneId, "position.attr3dpath");
    var sxCol = mm.linkedCameraFunction(sceneId, "scale.x");
    var rotCol = mm.linkedCameraFunction(sceneId, "rotation.anglez");
    var camDist = 12, sep = null;   // sep: separate X/Y/Z position functions instead of the 3-D path
    try {
        var d = Number(mm.getTextAttr(sceneId, "Top/Camera", "offset.z", 1));
        if (isFinite(d) && d > 0) camDist = d;
        if (mm.getTextAttr(sceneId, "Top/Camera-Peg", "position.separate", 1) == "On") {
            sep = { x: mm.getLinkedFunction(sceneId, "Top/Camera-Peg", "position.x"),
                    y: mm.getLinkedFunction(sceneId, "Top/Camera-Peg", "position.y"),
                    z: mm.getLinkedFunction(sceneId, "Top/Camera-Peg", "position.z") };
            if (!sep.x && !sep.y && !sep.z) sep = null;
        }
    } catch (e) {}
    var keys = collectKeys(env, sceneId, sep ? "" : posCol, (sep ? [sep.x, sep.y, sep.z] : []).concat([sxCol, rotCol]));
    function staticZ(f) {
        try { var v = Number(mm.getTextAttr(sceneId, "Top/Camera-Peg", "position.z", f)); return isFinite(v) ? v : 0; }
        catch (e1) { return 0; }
    }
    var warnedZ = false;
    return keys.frames.map(function (f, i) {
        var pos = sep ? { x: nearestKey(env, sceneId, sep.x, f, 0), y: nearestKey(env, sceneId, sep.y, f, 0),
                          z: sep.z ? nearestKey(env, sceneId, sep.z, f, 0) : staticZ(f) }
                      : pathPointAt(keys, f);
        var zoom = 1.0 / (nearestKey(env, sceneId, sxCol, f, 1) || 1);
        var pz = Number(pos.z) || 0;
        if (camDist + pz > 1e-6) {
            zoom *= camDist / (camDist + pz);
        } else if (!warnedZ) {
            warnedZ = true;
            env.log.warn("camera on scene " + sceneId + " sits on or behind the drawing plane at frame " + f + "; Z dolly ignored");
        }
        return { id: "kf" + (i + 1), t: (f - 1) / env.fps, z: zoom,
                 cx: pos.x / env.fields.perWorldX, cy: -pos.y / env.fields.perWorldY,
                 rot: -nearestKey(env, sceneId, rotCol, f, 0) };
    });
}

// The scene's camera for the archive: the keyframes kept as sboardx-camera
// metadata on import (a lossless round trip) while they still match the
// live camera, else the live camera.
function readSceneCamera(env, sceneId, firstPanelId) {
    var live = [];
    try { live = readLiveCamera(env, sceneId); }
    catch (e) { env.log.warn("camera could not be read on scene " + sceneId + ": " + e); }
    var meta = readCameraMeta(env, firstPanelId);
    if (meta && (!live.length || cameraKfsMatch(env, live, meta))) return meta;
    if (meta) {
        env.log.warn("sboardx-camera metadata on panel " + firstPanelId + " is stale (camera edited in " +
                     "Storyboard Pro); exporting the live camera on scene " + sceneId);
    }
    return live;
}

// ── Renders: image layers and textured-stroke atlases ───────────────────────

// Runs the panel's render jobs with the camera neutralized, each layer
// rendered alone, inside one undo accumulation that is cancelled afterwards
// (in batch, visibility is restored by hand and a camera move cannot be
// neutralized: the jobs are skipped with a warning).
function rasterizePanel(env, sceneId, panelId, outId, jobs, camKfs) {
    var lm = env.lm, n = lm.numberOfLayers(panelId);
    if (!env.hasSession && camKfs.length > 0) {
        env.log.warn("image layer(s) on panel " + panelId + " skipped: the scene has a camera move and -batch " +
                     "has no undo session to neutralize it - run the export in an interactive Storyboard Pro session");
        return;
    }
    var vis = [];
    if (!env.hasSession) for (var v = 0; v < n; v++) vis.push(lm.layerVisibility(panelId, v) !== false);
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

    if (env.hasSession) project.beginUndoRedoAccum("sboardx raster render");
    try {
        if (env.hasSession) env.mm.clearCameraMotion(sceneId);
        jobs.forEach(function (job) {
            // The layer renders with its parent groups visible (a hidden group
            // hides its members) and with its own and its groups' motion
            // cleared: tiles are cut at the drawing's untransformed place, the
            // layer's transform travels in layer_tracks. Clearing is part of
            // the cancelled undo accumulation; -batch has none, so there the
            // motion stays and the tiles of an animated layer may miss.
            var keep = [job.li].concat(ancestorGroups(env, panelId, job.li));
            if (env.hasSession) {
                keep.forEach(function (idx) { try { env.mm.clearLayerMotion(panelId, idx); } catch (e) {} });
            } else if (keep.some(function (idx) { return readLayerKeys(env, panelId, idx, env.sb.getPanelDuration(panelId)).length > 0; })) {
                warnOnce(env, "batch-motion:" + job.layerName, "layer '" + job.layerName + "' has layer motion that -batch cannot " +
                         "neutralize for the render; its textures may be cut from the wrong place");
            }
            var k = job.kind === "atlas" ? renderScale(env, job) : 1;
            var src = renderLayerAlone(env, em, panelId, outId, n, job, keep, k);
            if (src && job.kind === "atlas" && buildAtlas(env, outId, job, src, k) === "retry") {
                // The zoomed render did not come out as assumed: plain render of the frame.
                src = renderLayerAlone(env, em, panelId, outId, n, job, keep, 1);
                if (src) buildAtlas(env, outId, job, src, 1);
            } else if (src && job.kind === "image") stageImageLayer(env, outId, job, src);
            if (!src) env.log.warn("layer '" + job.layerName + "' (panel " + panelId + ") did not render; " +
                                   (job.kind === "atlas" ? "kept flat" : "exported empty"));
        });
    } finally {
        if (env.hasSession) project.cancelUndoRedoAccum();
        else for (var r = 0; r < n; r++) lm.setLayerVisible(panelId, r, vis[r]);
    }
}

// The group layers above a layer, innermost first ([] for a top-level layer).
function ancestorGroups(env, panelId, li) {
    var out = [], seen = {};
    var g = env.lm.groupOfLayer(panelId, li);
    while (typeof g === "number" && g >= 0 && !seen[g]) {
        seen[g] = true;
        out.push(g);
        g = env.lm.groupOfLayer(panelId, g);
    }
    return out;
}

// How far the render of a textured layer zooms out so that all of its
// textured contours fit: 1 when they sit inside the default frame, else the
// factor by which the frame must grow, up to MAX_RENDER_SCALE.
function renderScale(env, job) {
    var halfW = env.frameW / 2, halfH = env.frameH / 2, need = 1;
    job.textured.forEach(function (item) {
        var bb = item.bb;
        if (!bb) return;
        need = Math.max(need, -bb.minX / halfW, bb.maxX / halfW, -bb.minY / halfH, bb.maxY / halfH);
    });
    if (need <= 1.001) return 1;
    var k = Math.min(need, MAX_RENDER_SCALE);
    return k > 1.001 ? Math.ceil(k * 100) / 100 : 1;
}

// One layer of the panel rendered alone (every layer but `keep` hidden) to a
// PNG, zoomed out by `k` (the image then covers k times the frame, at the
// frame's pixel density up to Storyboard Pro's 4096 px cap); its path, or
// null.
function renderLayerAlone(env, em, panelId, outId, layerCount, job, keep, k) {
    var dir = env.stagingDir + "/raster/" + outId + "_" + job.li + (k > 1 ? "_x" + k : "");
    new Dir(dir).mkdirs();
    var ok = false;
    try {
        for (var j = 0; j < layerCount; j++) env.lm.setLayerVisible(panelId, j, keep.indexOf(j) >= 0);
        em.setZoomFactor(1 / k);
        em.setExportResolution(Math.round(env.resW * k), Math.round(env.resH * k));
        ok = em.exportToBitmap(dir, "layer", "png");
    } catch (e) {
        env.log.warn("render of layer '" + job.layerName + "' failed: " + e);
    }
    var files = new Dir(dir).entryList("*.png");
    return ok && files && files.length ? dir + "/" + files[0] : null;
}

function stageImageLayer(env, outId, job, src) {
    var fileName = outId + "_" + job.layerId + ".png";
    if (!common.copyFile(src, env.stagingDir + "/images/" + fileName)) {
        env.log.warn("could not stage the render of layer '" + job.layerName + "'");
        return;
    }
    var size = common.imageSize(src) || { w: env.resW, h: env.resH };
    job.entry.image = { file: "images/" + fileName, w: size.w, h: size.h,
                        transform: [env.frameW / size.w, 0, 0, env.frameH / size.h, 0, 0] };
    job.entry.opacity = 100;
    env.counts.rasterLayers++;
}

// Textured strokes (SPEC.md "Textured strokes"): the layer's render, cropped
// to the area its textured contours cover, is the layer's atlas PNG; each
// textured contour's <pattern> views its own rect of it (the path outline
// clips the fill). The render covers `k` times the default frame
// (renderLayerAlone). `job.atlas` becomes {file, w, h, tiles[k]} (tile k for
// textured contour k, null where it lies outside the render); any failure
// leaves it null. Returns "retry" when a zoomed render did not come out as
// expected (the caller renders the plain frame instead), else undefined.
function buildAtlas(env, outId, job, src, k) {
    var render = new QImage(src);
    if (render.isNull()) {
        env.log.warn("textured layer '" + job.layerName + "' kept flat (render unreadable)");
        return;
    }
    var W = render.width(), H = render.height();
    if (k > 1) {
        // Storyboard Pro caps the output at 4096 px wide, keeping the shape:
        // the image still spans k frames, at a lower density. Another shape
        // means the zoom did not do what is assumed: plain frame instead.
        if (Math.abs(W / H - env.resW / env.resH) > 0.02 * env.resW / env.resH) {
            warnOnce(env, "zoom-size", "Storyboard Pro rendered " + W + "x" + H + " instead of " + Math.round(env.resW * k) + "x" +
                     Math.round(env.resH * k) + " for a zoomed-out render; art beyond the frame is cut at the frame");
            return "retry";
        }
        if (W < env.resW * k - 2) {
            warnOnce(env, "zoom-clamp", "Storyboard Pro renders at most " + W + " px wide: layers with strokes more than " +
                     (W / env.resW).toFixed(1) + " frames out get their textures at a lower pixel density (first: '" + job.layerName + "')");
        }
    }
    var coverW = env.frameW * k, coverH = env.frameH * k;   // world units the render spans
    var sx = W / coverW, sy = H / coverH;                    // world -> render pixels
    var halfW = coverW / 2, halfH = coverH / 2;
    var ux0 = W, uy0 = H, ux1 = 0, uy1 = 0, inked = 0;      // union of the contour rects, render pixels
    var tiles = job.textured.map(function (item, idx) {
        var bb = item.bb;
        if (!bb) return null;
        var minX = Math.max(bb.minX, -halfW), maxX = Math.min(bb.maxX, halfW);
        var minY = Math.max(bb.minY, -halfH), maxY = Math.min(bb.maxY, halfH);
        if (!(maxX > minX) || !(maxY > minY)) return null;   // entirely outside the render
        var px0 = Math.max(0, Math.floor((minX + halfW) * sx)), py0 = Math.max(0, Math.floor((minY + halfH) * sy));
        var pw = Math.min(W, Math.ceil((maxX + halfW) * sx)) - px0, ph = Math.min(H, Math.ceil((maxY + halfH) * sy)) - py0;
        if (pw <= 0 || ph <= 0) return null;
        // The flat fallback colour: the contour's own pixels (its rect masked
        // by its outline) averaged; the masked copy is not kept.
        var rgba;
        try {
            var probe = render.copy(px0, py0, pw, ph);
            var painter = new QPainter();
            painter.begin(probe);
            painter.setCompositionMode(QPainter.CompositionMode_DestinationIn);
            painter.setRenderHint(QPainter.Antialiasing, true);
            painter.fillPath(contourPainterPath(env, item.contour, px0, py0, sx, sy, halfW, halfH), new QBrush(new QColor(0, 0, 0, 255)));
            painter.end();
            rgba = tileMeanColor(probe, contourAreaPixels(env, item.contour, sx, sy));
        } catch (e) {
            env.log.warn("textured layer '" + job.layerName + "': tile " + idx + " failed (" + e + ")");
            return null;
        }
        if (rgba[3] > 0) inked++;
        if (px0 < ux0) ux0 = px0; if (py0 < uy0) uy0 = py0;
        if (px0 + pw > ux1) ux1 = px0 + pw; if (py0 + ph > uy1) uy1 = py0 + ph;
        return { ax: px0, ay: py0, aw: pw, ah: ph, world: { x: px0 / sx - halfW, y: py0 / sy - halfH, w: pw / sx, h: ph / sy },
                 rgba: rgba };
    });
    var count = 0;
    tiles.forEach(function (t) { if (t) count++; });
    if (k > 1 && count && inked === 0) {
        // Every contour came out empty: the zoom did not scale the art about
        // the frame's centre as assumed. Fall back to the plain frame.
        warnOnce(env, "zoom-blank", "zoomed-out renders come out blank in this Storyboard Pro; art beyond the frame is cut at the frame");
        return "retry";
    }
    if (!count) {
        warnOnce(env, "flat:" + job.layerName, "textured layer '" + job.layerName + "' kept flat (no stroke inside the rendered area" +
                 (k > 1 ? ", " + k + " frames" : "") + ")");
        return;
    }
    var atlasW = ux1 - ux0, atlasH = uy1 - uy0;
    tiles.forEach(function (t) { if (t) { t.ax -= ux0; t.ay -= uy0; } });
    var fileName = outId + "_" + job.layerId + "_pencil.png";
    var atlasImg = render.copy(ux0, uy0, atlasW, atlasH);
    if (atlasImg.isNull() || !atlasImg.save(env.stagingDir + "/images/" + fileName, "PNG")) {
        env.log.warn("textured layer '" + job.layerName + "' kept flat (atlas not saved)");
        return;
    }
    job.atlas = { file: fileName, w: atlasW, h: atlasH, tiles: tiles };
    env.counts.texturedStrokes += count;
    env.counts.atlasPixels += atlasW * atlasH;
}

// The contour (drawing units, y up) as a QPainterPath in tile-local render
// pixels (holes as further subpaths, odd-even fill). `halfW`/`halfH`: half
// the world extent the render covers.
function contourPainterPath(env, contour, px0, py0, sx, sy, halfW, halfH) {
    var path = new QPainterPath();
    path.setFillRule(Qt.OddEvenFill);
    function pix(p) {
        var w = drawingToWorld(env, p);
        return { x: (w.x + halfW) * sx - px0, y: (w.y + halfH) * sy - py0 };
    }
    var sink = { move: function (p) { path.moveTo(p.x, p.y); },
                 line: function (p) { path.lineTo(p.x, p.y); },
                 quad: function (c, p) { path.quadTo(c.x, c.y, p.x, p.y); },
                 cubic: function (a, b, p) { path.cubicTo(a.x, a.y, b.x, b.y, p.x, p.y); } };
    [contour.path].concat(contour.holes || []).forEach(function (pts) {
        if (tracePath(pts, true, pix, sink)) path.closeSubpath();
    });
    return path;
}

// The contour's area in render pixels (shoelace over its points, holes
// subtracted; control points count as vertices — close enough for a mean).
function contourAreaPixels(env, contour, sx, sy) {
    function polyArea(pts) {
        var a = 0;
        for (var i = 0, n = pts.length; i < n; i++) {
            var p = pts[i], q = pts[(i + 1) % n];
            a += p.x * q.y - q.x * p.y;
        }
        return Math.abs(a) / 2;
    }
    var area = polyArea(contour.path || []);
    (contour.holes || []).forEach(function (h) { area -= polyArea(h || []); });
    return Math.max(0, area) * env.worldPerDrawing * env.worldPerDrawing * sx * sy;
}

// The tile's mean colour over a sample grid, as [r, g, b, a] in 0..1 — the
// flat fallback a reader without pattern support draws: the ink's mean
// colour at the mean alpha over the contour's area (`areaPx`). A tile
// without any ink is [0, 0, 0, 0] (invisible, like the tile itself).
function tileMeanColor(img, areaPx) {
    var w = img.width(), h = img.height();
    var n = 0, r = 0, g = 0, b = 0, a = 0;
    var stepX = Math.max(1, Math.floor(w / 16)), stepY = Math.max(1, Math.floor(h / 16));
    for (var y = 0; y < h; y += stepY) {
        for (var x = 0; x < w; x += stepX) {
            var px = img.pixel(x, y);   // ARGB32, premultiplied in the render
            var pa = (px >>> 24) & 255;
            n++;
            if (pa === 0) continue;
            r += ((px >>> 16) & 255) * 255 / pa;
            g += ((px >>> 8) & 255) * 255 / pa;
            b += (px & 255) * 255 / pa;
            a += pa;
        }
    }
    if (n === 0 || a <= 0) return [0, 0, 0, 0];
    var sampled = n * stepX * stepY;   // tile pixels the grid stands for
    var cover = (a * stepX * stepY) / (areaPx > 0 ? Math.min(areaPx, sampled) : sampled);
    var opaque = a / 255;   // sum of alphas / 255 = "opaque pixel count"
    return [common.clamp01(r / 255 / opaque), common.clamp01(g / 255 / opaque), common.clamp01(b / 255 / opaque), common.clamp01(cover / 255)];
}

// ── Audio, palettes, project files ──────────────────────────────────────────

function writeAudioClips(env) {
    var stm = new SoundTrackManager();
    var nTracks = stm.numberOfSoundTracks();
    var clips = [], usedNames = {}, nameForSource = {};
    for (var t = 0; t < nTracks; t++) {
        var seqs;
        try { seqs = stm.soundColumn(stm.nameOfSoundTrack(t)).sequences(); }
        catch (e) { env.log.warn("audio track " + t + " could not be read: " + e); continue; }
        for (var i = 0; i < seqs.length; i++) {
            var clip = exportAudioClip(env, seqs[i], t, i, usedNames, nameForSource);
            if (clip) clips.push(clip);
        }
    }
    env.counts.audioClips = clips.length;
    var out = { clips: clips };
    if (nTracks > 1) {
        out.tracks = [];
        for (var k = 0; k < nTracks; k++) out.tracks.push({ muted: false });
    }
    common.writeTextFile(env.stagingDir + "/audio/clips.json", JSON.stringify(out));
}

function exportAudioClip(env, q, trackIndex, clipIndex, usedNames, nameForSource) {
    var src = String(q.filename || "").replace(/\\/g, "/");
    if (!src || !common.fileExists(src)) {
        env.log.warn("audio clip '" + (q.displayName || q.name) + "' on track " + trackIndex + ": source file missing (" + src + ")");
        return null;
    }
    var fileName = nameForSource[src];
    if (!fileName) {
        var base = common.fileBasename(src);
        var dot = base.lastIndexOf(".");
        var stem = dot > 0 ? base.substring(0, dot) : base, ext = dot > 0 ? base.substring(dot) : "";
        fileName = base;
        for (var k = 2; usedNames[fileName]; k++) fileName = stem + "_" + k + ext;
        if (!common.copyFile(src, env.stagingDir + "/audio/" + fileName)) {
            env.log.warn("audio file could not be copied: " + src);
            return null;
        }
        usedNames[fileName] = true;
        nameForSource[src] = fileName;
        if (/\.(aif|aiff|caf)$/i.test(fileName)) {
            env.log.warn("audio file " + fileName + " is not a browser format (the app plays it, the web reader will not)");
        }
    }
    var startF = Number(q.startFrame), stopF = Number(q.stopFrame);
    var tIn = Number(q.startTime) || 0, tOut = Number(q.stopTime) || 0;
    var dur = (stopF - startF + 1) / env.fps;
    if (tOut > tIn && tOut - tIn < dur) dur = tOut - tIn;
    var clip = { id: "clip-" + trackIndex + "-" + clipIndex, kind: "music", name: String(q.displayName || q.name || fileName),
                 start: (startF - 1) / env.fps, dur: dur, trim_in: tIn, gain: 80, file: fileName };
    if (trackIndex > 0) clip.track = trackIndex;
    return clip;
}

function writeProjectJson(env) {
    var projectJson = {
        sboardx: "1.1",
        app: "Toon Boom Storyboard Pro (TB_ExportSboardx)",
        created_at: env.nowIso,
        modified_at: env.nowIso,
        name: common.fileBasename(projectDir()) || "Storyboard",
        episode: "",
        canvas: { width: env.frameW, height: env.frameH, resolution: { width: env.resW, height: env.resH }, fps: env.fps }
    };
    // The default layer stack (SPEC.md project.json `layer_layout`), from the DEFAULT_LAYERS preference.
    var layout = common.parseDefaultLayers(preferences.getString("DEFAULT_LAYERS", ""));
    if (layout.length) projectJson.layer_layout = layout;
    // The bases of the panels unchanged since their last exchange (stampIdMap).
    for (var k in env.syncBases) if (env.syncBases.hasOwnProperty(k)) { projectJson.sync = { panels: env.syncBases }; break; }
    common.writeTextFile(env.stagingDir + "/project.json", JSON.stringify(projectJson));
}

// palettes.json (SPEC.md, optional): the project's palettes as solid
// colours, ids and names verbatim; the bridge's own palettes are skipped.
function writePalettesJson(env) {
    var list = PaletteObjectManager.getScenePaletteList();
    var solid = PaletteObjectManager.Constants.ColorType.SOLID_COLOR;
    var out = [];
    for (var i = 0; i < list.numPalettes; i++) {
        var pal = list.getPaletteByIndex(i);
        if (!pal || !pal.isValid()) continue;
        var name = String(pal.getName());
        if (name === "sboardx" || name === "Upshot_textures") continue;
        var colors = [];
        for (var c = 0; c < pal.nColors; c++) {
            var col = pal.getColorByIndex(c);
            if (!col || col.isTexture || col.colorType !== solid || !col.colorData || typeof col.colorData.r !== "number") continue;
            var cd = col.colorData;
            colors.push({ id: String(col.id), name: String(col.name || ""), r: cd.r / 255, g: cd.g / 255, b: cd.b / 255,
                          a: (typeof cd.a === "number" ? cd.a : 255) / 255 });
        }
        out.push({ id: String(pal.id || name), name: name, colors: colors });
    }
    if (!out.length) return;
    common.writeTextFile(env.stagingDir + "/palettes.json", JSON.stringify({ palettes: out }));
    env.counts.palettes = out.length;
}

function writeSequenceJson(env) {
    var seq = { panels: env.exportedPanels.map(function (e) { return e.outId; }), scenes: env.scenes, transitions: [] };
    if (env.sequences.length) seq.sequences = env.sequences;
    common.writeTextFile(env.stagingDir + "/sequence.json", JSON.stringify(seq));
}

function zipStagingFolder(env) {
    var entries = ["project.json", "sequence.json", "panels", "audio"];
    if (env.counts.rasterLayers > 0 || env.counts.atlasLayers > 0) entries.push("images");
    if (env.counts.palettes > 0) entries.push("palettes.json");
    if (env.shared.list.length) entries.push("shared");
    return common.createStoreZip(env.stagingDir, entries, env.zipPath, env.log, env.progress.cancelled);
}

function exportSummary(env) {
    var c = env.counts;
    return "Exported " + c.scenes + " scene(s), " + c.panels + " panel(s), " + (c.layers - c.rasterLayers) + " vector layer(s)" +
           (c.rasterLayers ? " and " + c.rasterLayers + " image layer(s)" : "") +
           (env.shared.list.length ? ", " + env.shared.list.length + " shared drawing(s)" : "") +
           (c.atlasLayers ? ", " + c.texturedStrokes + " textured stroke(s) in " + c.atlasLayers + " atlas(es) totalling " +
                            (c.atlasPixels / 1048576).toFixed(1) + " megapixel(s)" : "") +
           (c.audioClips ? ", " + c.audioClips + " audio clip(s)" : "") +
           " to\n" + env.zipPath + ".";
}

exports.exportToFile = exportToFile;
// Reused by sboardx_import.js and sboardx_merge.js.
exports.makeExportEnv = makeExportEnv;
exports.ownForm = ownForm;
exports.finishExchange = finishExchange;
exports.readSceneCamera = readSceneCamera;
exports.readCameraMeta = readCameraMeta;
exports.cameraKfsMatch = cameraKfsMatch;
exports.readLiveCamera = readLiveCamera;
