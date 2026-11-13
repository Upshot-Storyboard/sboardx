// sboardx_export.js: the code behind TB_ExportSboardx.js. Loaded with
// require() so the Scripts Manager only lists the entry points.
// Needs sboardx_common.js in the same folder. See README.md.

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
        stampIdMap(env);   // before project.json, it picks the declared bases
        stampSceneCameras(env, env.cameraStamps);
        writeProjectJson(env);
        writeSequenceJson(env);
        writePalettesJson(env);
        writeSharedArt(env);
        stampSharedDrawings(env);
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
        // The baselines now describe this archive, save them with the project.
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

// State for one export run. `zipPath` can be empty for staging only
// (ownForm, finishExchange).
function makeExportEnv(log, zipPath) {
    zipPath = String(zipPath || "").replace(/\\/g, "/");
    if (zipPath && !/\.sboardx$/i.test(zipPath)) zipPath += ".sboardx";
    var stagingDir = common.makeTempDir("export");
    new Dir(stagingDir + "/audio").mkdirs();
    new Dir(stagingDir + "/images").mkdirs();
    new Dir(stagingDir + "/raster").mkdirs();

    var sb = new StoryboardManager(), lm = new LayerManager(), cm = new CaptionManager();
    // canvas.fps is an integer. Round near-integer rates, exportToFile warns
    // about the rest.
    var fps = project.getFrameRate();
    if (Math.abs(fps - Math.round(fps)) < 0.05) fps = Math.round(fps);
    var resW = project.currentResolutionX(), resH = project.currentResolutionY();
    var frameH = 540.0, frameW = frameH * resW / resH;
    var hasSession = common.hasGuiSession(sb, lm);

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
        worldPerDrawing: frameH / common.DRAWING_UNITS_PER_FRAME_H,
        fields: common.cameraFields(frameH),
        notesCaption: common.findPanelCaption(cm, "notes"),
        dialogueCaption: common.findPanelCaption(cm, "dialogue"),
        nowIso: new Date().toISOString(),
        scenes: [],
        sequences: [],
        exportedPanels: [],   // {native, outId} in archive order
        idMap: { v: 1, panels: {}, scenes: {}, drawings: {} },
        cameraStamps: [],   // per scene camera baselines, stamped at the end
        usedIds: {},
        shared: { byFile: {}, list: [], ids: {} },
        sceneFileText: undefined,
        textureImages: {},
        renderCache: {},   // see cachedRender
        pagePrefixes: { byLayer: {}, taken: {} },   // see uniquePagePrefix
        rewritten: {},     // drawing key -> true if this session's import rewrote it
        freshCopies: {},   // drawing key -> fresh copy path (drawingReadPath)
        cameraOutsideWarned: {},   // scene id -> true once warned (readLiveCamera)
        syncBases: {},
        counts: { scenes: 0, panels: 0, layers: 0, rasterLayers: 0, atlasLayers: 0, nativeLayers: 0, libraryAtlases: 0,
                  texturedStrokes: 0, atlasCells: 0, atlasPages: 0, audioClips: 0, palettes: 0 },
        warnedOnce: {}
    };
}

// Warn once per key, so one cause doesn't flood the summary dialog.
function warnOnce(env, key, text) {
    if (env.warnedOnce[key]) return;
    env.warnedOnce[key] = true;
    env.log.warn(text);
}

// Art outside the frame is rendered zoomed out, up to this factor. SBP caps
// renders at 4096 px wide, so past about two frames (at 1080p) textures get
// a lower density, but they are not cut.
var MAX_RENDER_SCALE = 4;

// ── Merge baselines (SPEC.md "Merging", sboardx_common.js loadIdMap) ────────

// Runs after the panels are staged. A changed panel gets a new entry: its
// archive digest plus its local fingerprint as baseline. A panel unchanged
// since the last exchange keeps its entry, and the old digest goes out as
// its base in `sync.panels`, so the other side sees it as unchanged even if
// our bytes differ. No baseline means changed. Only SHA-256 hex is declared.
function stampIdMap(env) {
    var declared = 0;
    env.exportedPanels.forEach(function (e) {
        var digest = common.archivePanelDigest(env.stagingDir, e.outId);
        var prev = env.idMap.panels[e.native];
        var keys = common.panelSharedKeys(env.lm, e.native);
        var unchanged = !!prev && prev.id === e.outId && common.isSha256Hex(String(prev.digest)) &&
                        !common.changedSinceExchange(prev, function () { return e.fp; });
        if (unchanged) {
            env.syncBases[e.outId] = String(prev.digest);
            common.stampBaseline(prev, keys, e.fp);   // unchanged, so now == then
            declared++;
        } else {
            var entry = { id: e.outId, digest: digest };
            common.stampBaseline(entry, keys, e.fp);
            env.idMap.panels[e.native] = entry;
        }
    });
    env.log.trace("merge bases declared for " + declared + " of " + env.exportedPanels.length + " panel(s)");
    common.saveIdMap(env.sb, env.idMap);
}

// Stages one panel exactly like the export does: {dir, outId, hex}. Used by
// the merge to rebuild a kept panel it moves (sboardx_merge.js fillFromOwn).
// Not usable as a baseline, renders differ between sessions. Reads the
// saved drawings, so save first.
function ownForm(xenv, sceneId, panelId) {
    var outId = common.archiveIdOf(xenv.idMap, panelId);
    var firstPanel = String(xenv.sb.panelInScene(sceneId, 0));
    exportPanel(xenv, sceneId, String(xenv.sb.nameOfScene(sceneId)), panelId, outId, readSceneCamera(xenv, sceneId, firstPanel).keyframes);
    return { dir: xenv.stagingDir, outId: outId, hex: common.archivePanelDigest(xenv.stagingDir, outId) };
}

// Stamps baselines on `onlyPanels` (the panels this exchange filled from the
// archive) and returns how many. Leave every other panel alone: stamping a
// panel that has no baseline would make the next export declare its old
// digest as base, and Upshot would then keep its own copy over ours. If the
// fingerprint fails the panel gets no baseline and reads as changed (the
// merge asks instead of overwriting). Expects a saved project.
function stampFingerprints(xenv, idMap, onlyPanels) {
    var only = {};
    (onlyPanels || []).forEach(function (p) { only[String(p)] = true; });
    var stamped = 0;
    common.forEachPanel(xenv.sb, function (sceneId, pid) {
        var entry = idMap.panels[pid];
        if (!entry || !only[pid]) return;
        try {
            common.stampBaseline(entry, common.panelSharedKeys(xenv.lm, pid), panelFingerprint(xenv, sceneId, pid).hex);
            stamped++;
        } catch (e) {
            common.stampBaseline(entry, null, "");
            xenv.log.warn("panel " + pid + ": its merge baseline was not recorded (" + e + ")");
        }
    });
    return stamped;
}

// End of an import or update, after the undo accumulation. Save first: the
// fingerprints read the saved files, and shared drawings only get a key once
// saved. Then stamp shared drawings and filled panels, and save again.
function finishExchange(log, idMap, onlyPanels, cameraStamps, sharedStamps) {
    var xenv = makeExportEnv(log, "");
    xenv.idMap = idMap;
    (sharedStamps || []).forEach(function (st) { if (st.rewritten && st.key) xenv.rewritten[st.key] = true; });
    stampSceneCameras(xenv, cameraStamps);
    common.saveIdMap(xenv.sb, idMap);
    project.saveAll();
    var stamped = stampImportedSharedDrawings(log, idMap, sharedStamps);
    stamped += stampFingerprints(xenv, idMap, onlyPanels);
    if (stamped > 0) {
        common.saveIdMap(xenv.sb, idMap);
        project.saveAll();
    }
    log.trace("merge baselines stamped: " + stamped);
}

// ── The "changed here?" fingerprint (sboardx_common.js FINGERPRINT_FORM) ───

var FP_PARTS = ["strokes", "area", "moments", "tex", "colours", "layers", "files"];

// A panel's fingerprint as it is here: {hex, parts: {<part>: hex}, ms}.
// Built only from what every load of the saved project returns the same way,
// so nothing is rendered. Parts:
//   strokes  each sub-layer's getData `strokes` + `thicknessPaths`, as-is
//   area     per art|colour: net painted area (outer minus holes), quantized.
//            No contour count, getData may split contours differently.
//   moments  same keys, x dA and y dA integrals. Catches colour swaps of
//            equal area.
//   tex      same keys, multiset of shader matrices (texture/gradient
//            placement, and the flat-vs-textured rule)
//   colours  brush texture mark, then the value of each used colour. Never
//            the name (renames are no change) and never the palette .tga
//            (panel layers render the drawing's own copy).
//   layers   panel.json minus `code`, layers.json as the export writes it,
//            each layer's export kind, shared key, groups, resolution
//   files    SHA-256 of each bitmap/text layer's drawing file
// Each part is a SHA-256 (common.FpHash), the result hashes the form plus
// the parts. Drawings are read through drawingReadPath. Save first.
//
// The export builds the same thing inline (exportPanel passes each layer's
// data as it goes, so getData runs once and nothing is kept per panel).
// This version reads everything itself, for the merge and the stamps.
function panelFingerprint(xenv, sceneId, panelId) {
    var fp = beginPanelFingerprint(xenv, panelId, null);
    for (var li = fp.numLayers - 1; li >= 0; li--) {
        if (fp.groupNames.hasOwnProperty(li)) fingerprintGroupLayer(fp, li);
        else fingerprintLayer(fp, li, null);
    }
    return finishPanelFingerprint(fp);
}

function fpNow() { return new Date().getTime(); }

// Starts a fingerprint. `panel` comes from the export ({dur, note, dialogue
// untrimmed, numLayers, groupNames}), or null to read it here. Feed layers
// in exportPanel's order afterwards.
function beginPanelFingerprint(xenv, panelId, panel) {
    var t0 = fpNow();
    var fp = { xenv: xenv, panelId: panelId, outId: common.archiveIdOf(xenv.idMap, panelId), H: {},
               ms: { read: 0, strokes: 0, contours: 0, colours: 0, layers: 0, files: 0, total: 0 },
               numLayers: 0, groupNames: null, panelJson: null, entries: [], extras: [] };
    FP_PARTS.forEach(function (p) { fp.H[p] = new common.FpHash(); });
    var lm = xenv.lm, dur, note, dialogue;
    if (panel) {
        fp.numLayers = panel.numLayers;
        fp.groupNames = panel.groupNames;
        dur = panel.dur;
        note = trimCaption(panel.note);
        dialogue = trimCaption(panel.dialogue);
    } else {
        fp.numLayers = lm.numberOfLayers(panelId);
        fp.groupNames = {};
        for (var li = 0; li < fp.numLayers; li++) {
            if (lm.isGroupLayer(panelId, li) === true) fp.groupNames[li] = String(lm.layerName(panelId, li));
        }
        dur = xenv.sb.getPanelDuration(panelId) / xenv.fps;
        note = fingerprintCaption(xenv, xenv.notesCaption, panelId);
        dialogue = fingerprintCaption(xenv, xenv.dialogueCaption, panelId);
    }
    // panel.json minus `code`.
    fp.panelJson = { id: fp.outId, shot: "", dur: dur, note: note };
    if (dialogue) fp.panelJson.dialogue = dialogue;
    var d = fpNow() - t0;
    fp.ms.layers += d; fp.ms.total += d;
    return fp;
}

// Groups have no layers.json entry, so hash name, opacity and owner here.
function fingerprintGroupLayer(fp, li) {
    var t0 = fpNow(), xenv = fp.xenv;
    fp.extras.push({ li: li, kind: "group", name: fp.groupNames[li], opacity: layerOpacityOf(xenv, fp.panelId, li),
                     owner: xenv.lm.groupOfLayer(fp.panelId, li) });
    var d = fpNow() - t0;
    fp.ms.layers += d; fp.ms.total += d;
}

// Same reads exportLayer does for a layer. Bitmap layers also get the
// drawing name here, since the fingerprint hashes their file.
function layerFingerprintFacts(xenv, panelId, li) {
    var lm = xenv.lm;
    var isBitmap = lm.isBitmapLayer(panelId, li) === true;
    var tvg = String(lm.getLayerDrawingName(panelId, li, true) || "");
    var readPath = tvg ? String(drawingReadPath(xenv, tvg)) : "";
    var isText = !isBitmap && common.drawingTexts(readPath).length > 0;
    var varies = opacityAnimation(xenv, panelId, li).varies;
    return { layerName: String(lm.layerName(panelId, li)), isBitmap: isBitmap, tvg: tvg, readPath: readPath, isText: isText,
             isShared: !!tvg && !isText && lm.isShared(panelId, li) === true,
             opacity: varies ? 100 : layerOpacityOf(xenv, panelId, li),
             locked: lm.getLayerLock(panelId, li) === true, visible: lm.layerVisibility(panelId, li) !== false,
             data: null, brushMarked: undefined };
}

// Adds one layer. `facts` is what the export already read (same fields as
// layerFingerprintFacts, plus getData's `data` and `brushMarked`), or null
// to read it here.
function fingerprintLayer(fp, li, facts) {
    var t0 = fpNow(), xenv = fp.xenv, H = fp.H, ms = fp.ms;
    var f = facts || layerFingerprintFacts(xenv, fp.panelId, li);
    var layerId = "layer" + li;
    var entry = { id: layerId, name: f.layerName, color_tag: "#999999", opacity: f.opacity, blend: "normal",
                  locked: f.locked, visible: f.visible, art: "art/" + layerId + ".svg" };
    var sharedKey = f.isShared ? common.sharedDrawingKey(f.tvg) : "";
    if (f.isShared) entry.shared = common.sharedDrawingArchiveId(xenv.idMap, sharedKey);
    var owner = xenv.lm.groupOfLayer(fp.panelId, li);
    if (owner >= 0 && fp.groupNames.hasOwnProperty(owner)) entry.group = fp.groupNames[owner];
    var tl = fpNow();
    ms.layers += tl - t0;

    var kind;
    if (f.isBitmap || f.isText) {
        kind = f.isBitmap ? "bitmap" : "text";
        H.files.val([li, kind, f.tvg ? common.fileSha256(f.tvg) : ""]);
        ms.files += fpNow() - tl;
    } else {
        var data = null, brushMarked;
        if (facts) {
            data = f.data || null;
            brushMarked = f.brushMarked;
        } else if (f.readPath) {
            try { data = readDrawingData(f.readPath); } catch (e) { data = null; }
            ms.read += fpNow() - tl;
        }
        kind = hashDrawingFingerprint(H, li, xenv.worldPerDrawing, data, brushMarked, ms);
    }
    if (kind === "bitmap" || kind === "text" || kind === "image") {
        // Same as stageImageLayer, the render is at export resolution.
        entry.image = { file: "images/" + fp.outId + "_" + layerId + ".png", w: xenv.resW, h: xenv.resH,
                        transform: [xenv.frameW / xenv.resW, 0, 0, xenv.frameH / xenv.resH, 0, 0] };
        if (!xenv.hasSession) entry.opacity = 100;   // -batch bakes opacity into the render
    }
    fp.entries.push(entry);
    fp.extras.push({ li: li, kind: kind, sharedKey: sharedKey });
    ms.total += fpNow() - t0;
}

// Hashes the form and then each part in FP_PARTS order.
function finishPanelFingerprint(fp) {
    var t0 = fpNow(), xenv = fp.xenv, H = fp.H;
    H.layers.val(fp.panelJson);
    H.layers.val({ layers: fp.entries });
    H.layers.val(fp.extras);
    H.layers.val([xenv.resW, xenv.resH]);
    var all = new common.FpHash(), parts = {};
    all.val(common.FINGERPRINT_FORM);
    FP_PARTS.forEach(function (p) {
        parts[p] = H[p].hex();
        all.val([p, parts[p]]);
    });
    var hex = all.hex();
    var d = fpNow() - t0;
    fp.ms.layers += d; fp.ms.total += d;
    return { hex: hex, parts: parts, ms: fp.ms };
}

// Hashes one vector layer's getData answer into the five drawing parts
// (W = world units per drawing unit). Returns the export kind exportLayer
// would pick: "atlas" for textured contours, "image" when only pencil lines
// are textured, else "flat". Every value starts with [li, ...]. No data
// hashes [li, "nodata"] in each part.
function hashDrawingFingerprint(H, li, W, data, brushMarked, ms) {
    if (!data || !data.arts) {
        ["strokes", "area", "moments", "tex", "colours"].forEach(function (p) { H[p].val([li, "nodata"]); });
        return "flat";
    }
    var W2 = W * W, W3 = W2 * W;
    var arts = data.arts.slice().sort(function (a, b) { return a.art - b.art; });
    var colors = data.colors || {};

    // strokes
    var t = fpNow();
    var hs = H.strokes;
    hs.val([li, arts.length]);
    arts.forEach(function (art) {
        var subs = art.layers || [];
        hs.val([art.art, subs.length]);
        for (var vi = 0; vi < subs.length; vi++) {
            hs.val(subs[vi].strokes || []);
            hs.val(subs[vi].thicknessPaths);
        }
    });
    ms.strokes += fpNow() - t;

    // area, moments, tex and the export kind in one walk
    t = fpNow();
    var keys = {}, tex = {}, used = {}, r = [0, 0, 0], rh = [0, 0, 0];
    if (brushMarked === undefined) brushMarked = hasBrushTextureMark(data);
    var usedTexture = false, textured = 0;
    arts.forEach(function (art) {
        (art.layers || []).forEach(function (vl) {
            (vl.strokes || []).forEach(function (s) {
                if (s && s.colorId !== undefined) {
                    used[s.colorId] = true;
                    var sc = colors[s.colorId];
                    if (!s.invisible && sc && sc.isTexture) usedTexture = true;   // a textured pencil line
                }
            });
            (vl.contours || []).forEach(function (c) {
                var cid = String(c.colorId), key = art.art + "|" + cid;
                used[cid] = true;
                var col = colors[cid];
                if (!c.path || !c.path.length) { /* empty, parseDrawables skips it */ }
                else if (col && col.isTexture) { usedTexture = true; textured++; }
                else if (!(col && gradientStopsOf(col)) && contourHasTextureMatrix(c, brushMarked)) { usedTexture = true; textured++; }
                common.loopIntegralsInto(c.path, r);
                var sA = r[0] >= 0 ? 1 : -1, area = Math.abs(r[0]), mx = sA * r[1], my = sA * r[2];
                var holes = c.holes || [];
                for (var hi = 0; hi < holes.length; hi++) {
                    common.loopIntegralsInto(holes[hi], rh);
                    var sH = rh[0] >= 0 ? 1 : -1;
                    area -= Math.abs(rh[0]); mx -= sH * rh[1]; my -= sH * rh[2];
                }
                var e = keys[key] || (keys[key] = [0, 0, 0]);
                e[0] += area * W2; e[1] += mx * W3; e[2] += -my * W3;
                var mk = common.shaderMatrixKey(c.matrix), tk = tex[key] || (tex[key] = {});
                tk[mk] = (tk[mk] || 0) + 1;
            });
        });
    });
    var sorted = Object.keys(keys).sort(), aq = common.FP_AREA_QUANTUM, mq = common.FP_MOMENT_QUANTUM;
    H.area.val([li, sorted.map(function (k) { return [k, common.fpRound(keys[k][0], aq)]; })]);
    H.moments.val([li, sorted.map(function (k) { return [k, common.fpRound(keys[k][1], mq), common.fpRound(keys[k][2], mq)]; })]);
    H.tex.val([li, Object.keys(tex).sort().map(function (k) {
        return [k, Object.keys(tex[k]).sort().map(function (m) { return [m, tex[k][m]]; })];
    })]);
    ms.contours += fpNow() - t;

    // colours
    t = fpNow();
    H.colours.val([li, !!brushMarked, Object.keys(used).sort().map(function (id) { return [id, colourValue(colors[id])]; })]);
    ms.colours += fpNow() - t;
    return textured > 0 ? "atlas" : usedTexture ? "image" : "flat";
}

// Trimmed caption text. SBP returns the plain text it was given in the
// session that set it, but rich text (stripped and trimmed by
// panelCaptionText) after a reload, so trailing newlines would differ.
function fingerprintCaption(env, captionName, panelId) {
    return trimCaption(panelCaptionText(env, captionName, panelId));
}

function trimCaption(text) { return String(text).replace(/^\s+|\s+$/g, ""); }

// A colour's value for the fingerprint, never its name.
function colourValue(c) {
    if (!c || typeof c !== "object") return "nodata";
    if (c.isTexture) {
        return ["texture", typeof c.width === "number" ? c.width : -1, typeof c.height === "number" ? c.height : -1,
                typeof c.image === "string" ? common.sha256OfString(c.image) : c.image];
    }
    if (gradientStopsOf(c)) {
        return ["gradient", c.gradient, c.gradientData.map(function (st) { return [st.r, st.g, st.b, st.a, st.percent]; })];
    }
    return ["solid", c.r, c.g, c.b, c.a];
}

// `readPath` should come from drawingReadPath. Throws like getData.
function readDrawingData(readPath) {
    return Drawing.query.getData({ drawing: { filename: readPath } });
}

// ── The project walk ────────────────────────────────────────────────────────

// Archive ids must be unique: first come keeps it, later ones get a suffix.
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
        var cam = readSceneCamera(env, sceneId, firstPanelId), camKfs = cam.keyframes;
        if (cam.stamp) env.cameraStamps.push(cam.stamp);
        var sceneOutId = uniqueId(env, env.idMap.scenes[sceneId] || sceneId, sceneId);
        sceneOutIds[sceneId] = sceneOutId;
        env.idMap.scenes[sceneId] = sceneOutId;

        var scenePanels = [], sceneLayerInfo = [];
        for (var pi = 0; pi < numPanels; pi++) {
            var panelId = String(env.sb.panelInScene(sceneId, pi));
            if (env.progress.cancelled()) throw { sboardxCancelled: true };
            env.progress.step("Panel " + env.sb.nameOfPanel(panelId) + " (scene " + sceneName + ")");
            var panelOutId = uniqueId(env, common.archiveIdOf(env.idMap, panelId), panelId);
            var exported = { native: panelId, outId: panelOutId, fp: "" };
            env.exportedPanels.push(exported);
            scenePanels.push(panelOutId);
            // Fingerprint is hashed during the export, for stampIdMap.
            var info = exportPanel(env, sceneId, sceneName, panelId, panelOutId, camKfs, true);
            exported.fp = info.fingerprint;
            sceneLayerInfo.push(info);
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

// SBP sequences -> sequence.json "sequences". Optional, Upshot makes its own ids.
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

// panelId is SBP's, outId is the panel's id in the archive. Parse all
// layers, render what needs it in one undo accumulation, then write the art
// SVGs. With `withFingerprint` the fingerprint is hashed along the way
// ("" if it failed, which makes the next merge treat the panel as changed).
function exportPanel(env, sceneId, sceneName, panelId, outId, camKfs, withFingerprint) {
    var panelDir = env.stagingDir + "/panels/" + outId;
    new Dir(panelDir + "/art").mkdirs();
    var panelObj = writePanelJson(env, panelDir, sceneName, panelId, outId);
    common.writeTextFile(panelDir + "/camera.json", JSON.stringify({ keyframes: [] }));

    var layers = [], pending = [], rasterJobs = [], layerIndices = [];
    var groupNames = {};   // SBP index of a group layer -> its name
    var numLayers = env.lm.numberOfLayers(panelId);
    var li;
    for (li = 0; li < numLayers; li++) {
        if (env.lm.isGroupLayer(panelId, li) === true) groupNames[li] = String(env.lm.layerName(panelId, li));
    }
    var fpw = withFingerprint ? { fp: null, error: null } : null;
    function fpStep(fn) {
        if (!fpw || fpw.error) return;
        try { fn(); } catch (e) { fpw.error = e; }
    }
    fpStep(function () {
        fpw.fp = beginPanelFingerprint(env, panelId, { dur: panelObj.dur, note: panelObj.note, dialogue: panelObj.dialogue || "",
                                                       numLayers: numLayers, groupNames: groupNames });
    });
    // SBP index 0 is the top layer, sboardx goes bottom to top. Groups are
    // skipped, members carry the group name.
    for (li = numLayers - 1; li >= 0; li--) {
        if (groupNames.hasOwnProperty(li)) {
            fpStep(function () { fingerprintGroupLayer(fpw.fp, li); });
            continue;
        }
        var layer = exportLayer(env, panelDir, panelId, outId, li, rasterJobs, fpw);
        var owner = env.lm.groupOfLayer(panelId, li);
        if (owner >= 0 && groupNames.hasOwnProperty(owner)) layer.entry.group = groupNames[owner];
        layers.push(layer.entry);
        pending.push(layer);
        layerIndices.push(li);
        env.counts.layers++;
    }
    var fingerprint = "";
    fpStep(function () { fingerprint = finishPanelFingerprint(fpw.fp).hex; });
    if (fpw && fpw.error) env.log.warn("panel " + panelId + ": its merge fingerprint could not be computed (" + fpw.error + ")");
    if (rasterJobs.length > 0) rasterizePanel(env, sceneId, panelId, outId, rasterJobs, camKfs);
    if (env.zipPath) recordNativeLayers(env, panelId, rasterJobs);
    pending.forEach(function (p) { writeLayerArt(env, outId, p); });
    common.writeTextFile(panelDir + "/layers.json", JSON.stringify({ layers: layers }));
    env.counts.panels++;
    return { panelId: panelId, entries: layers, indices: layerIndices, groups: groupNames, fingerprint: fingerprint };
}

function writePanelJson(env, panelDir, sceneName, panelId, outId) {
    // SBP has no shot type field, so `shot` stays empty.
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
    return panelObj;
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

// Reads one layer: its layers.json entry plus what exportPanel needs after
// the renders (parsed drawing, svg path, render job, shared record). Also
// feeds the fingerprint `fpw` if given.
function exportLayer(env, panelDir, panelId, outId, li, rasterJobs, fpw) {
    var layerName = String(env.lm.layerName(panelId, li));
    var layerId = "layer" + li;
    var isBitmap = env.lm.isBitmapLayer(panelId, li) === true;
    // Untouched vector layers have no drawing file yet, they go out empty.
    var tvgPath = isBitmap ? "" : String(env.lm.getLayerDrawingName(panelId, li, true) || "");
    // getData can't read text, so text layers go out as an image and get
    // recorded for the merge. Never exported as a shared drawing.
    var isText = !isBitmap && common.drawingTexts(drawingReadPath(env, tvgPath)).length > 0;
    var shared = tvgPath && !isText && env.lm.isShared(panelId, li) === true
        ? sharedDrawingRecord(env, tvgPath, sharedDrawingName(env, panelId, li, tvgPath, layerName)) : null;
    var raw = { data: null, brushMarked: undefined };
    var model = isText ? emptyModel() : parseDrawing(env, tvgPath, "panel " + panelId + " layer '" + layerName + "'", raw);
    var needsRaster = isBitmap || isText || model.usedTexture;
    var atlasJob = null;
    if (needsRaster && !isBitmap && !isText && model.textured.length > 0) {
        // Stays a vector layer, textured contours get an atlas cut from the
        // layer's render. If the render fails the layer goes out flat.
        needsRaster = false;
        atlasJob = { kind: "atlas", li: li, layerId: layerId, layerName: layerName, textured: model.textured, atlas: null,
                     tvgPath: tvgPath };
    } else if (needsRaster && !isBitmap) {
        model = emptyModel();   // texture only on pencil lines: whole layer as image
    }
    // An opacity fade goes in the layer track, layers.json then says 100.
    var opacityVaries = opacityAnimation(env, panelId, li).varies;
    var entry = {
        id: layerId,
        name: layerName,
        color_tag: "#999999",
        opacity: opacityVaries ? 100 : layerOpacityOf(env, panelId, li),
        blend: "normal",
        locked: env.lm.getLayerLock(panelId, li) === true,
        visible: env.lm.layerVisibility(panelId, li) !== false,
        art: "art/" + layerId + ".svg"
    };
    if (shared) entry.shared = shared.id;
    if (fpw && !fpw.error) {
        try {
            // The export doesn't need a bitmap's drawing name, the fingerprint does.
            var fpTvg = isBitmap ? String(env.lm.getLayerDrawingName(panelId, li, true) || "") : tvgPath;
            fingerprintLayer(fpw.fp, li, {
                layerName: layerName, isBitmap: isBitmap, tvg: fpTvg, isText: isText,
                isShared: isBitmap ? !!fpTvg && env.lm.isShared(panelId, li) === true : !!shared,
                opacity: entry.opacity, locked: entry.locked, visible: entry.visible,
                data: raw.data, brushMarked: raw.brushMarked });
        } catch (eF) { fpw.error = eF; }
    }
    if (needsRaster) rasterJobs.push({ kind: "image", li: li, layerId: layerId, layerName: layerName, entry: entry,
                                       native: isText ? "text" : "", tvgPath: tvgPath, opacityVaries: opacityVaries });
    else if (atlasJob) { atlasJob.entry = entry; rasterJobs.push(atlasJob); }
    return { entry: entry, layerId: layerId, layerName: layerName, panelDir: panelDir,
             svgPath: panelDir + "/art/" + layerId + ".svg", model: model, atlasJob: atlasJob, shared: shared };
}

// Writes the layer's art SVG and, with textured paths, its texture file
// (linked via `texture`, set before layers.json is written). For a shared
// drawing the first holder with an atlas provides the shared art.
function writeLayerArt(env, outId, layer) {
    var atlas = layer.atlasJob ? layer.atlasJob.atlas : null;
    var out = emitLayerSvg(env, layer.model, layer.layerId, layer.layerName, outId, atlas);
    common.writeTextFile(layer.svgPath, out.svg);
    if (out.texture) {
        layer.entry.texture = common.layerTextureLink(layer.layerId);
        common.writeTextFile(layer.panelDir + "/" + layer.entry.texture, out.texture);
    }
    if (atlas) env.counts.atlasLayers++;
    var rec = layer.shared;
    if (rec && !(rec.model && (rec.atlas || !atlas))) {
        rec.model = layer.model;
        rec.atlas = atlas;
    }
}

// Real export only. Records native layers that went out as pictures (text
// layers) with the PNG hash, so the merge can keep the native layer when the
// same picture comes back. Also stores the drawing file hash and opacity, to
// detect local edits. Skips renders with baked opacity (-batch), keeping
// those would lose the real opacity. Replaces any previous record. Must run
// outside rasterizePanel's cancelled accumulation.
function recordNativeLayers(env, panelId, jobs) {
    var list = [];
    jobs.forEach(function (job) {
        if (!job.native || !job.entry.image) return;
        if (job.opacityBaked) {
            env.log.trace("panel " + panelId + ": " + job.native + " layer '" + job.layerName + "' not recorded (rendered with its opacity)");
            return;
        }
        var png = common.fileSha256(env.stagingDir + "/" + job.entry.image.file);
        var drawing = job.tvgPath ? common.fileSha256(job.tvgPath) : "";
        if (!png || !drawing) return;
        list.push({ kind: job.native, name: job.layerName, png: png, drawing: drawing,
                    opacity: Number(job.entry.opacity), varies: job.opacityVaries === true,
                    image: { w: job.entry.image.w, h: job.entry.image.h, transform: job.entry.image.transform } });
        env.counts.nativeLayers++;
        env.log.trace("panel " + panelId + ": " + job.native + " layer '" + job.layerName + "' exported as its render (png " + png + ")");
    });
    try { common.writeNativeLayers(env.sb, panelId, list); }
    catch (e) { env.log.warn("panel " + panelId + ": native layer record not written (" + e + ")"); }
}

// Opacity 0..100 at frame 1. An explicit frame works in -batch too, the
// saved .sboard is the fallback.
function layerOpacityOf(env, panelId, li) {
    try {
        var v = Number(env.lm.layerOpacity(panelId, li, 1));
        if (isFinite(v)) return v;
    } catch (e) {}
    if (env.sceneFileText === undefined) {
        var names = new Dir(common.projectDir()).entryList("*.sboard");
        env.sceneFileText = names && names.length ? common.readTextFile(common.projectDir() + "/" + names[0]) : null;
    }
    return env.sceneFileText ? sceneFileLayerOpacity(env.sceneFileText, panelId, String(env.lm.layerName(panelId, li))) : 100;
}

// <opacity val> of the READ module `layerName` in the panel's <scene>, or 100.
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

// The layer's opacity function, and whether its keys differ (a fade).
function opacityAnimation(env, panelId, li) {
    var col = "";
    try { col = String(env.mm.linkedLayerFunction(panelId, li, "opacity") || ""); } catch (e) {}
    if (!col) return { col: "", varies: false };
    var n = env.fm.numberOfPoints(panelId, col), lo = Infinity, hi = -Infinity;
    for (var i = 0; i < n; i++) {
        var v = Number(env.fm.pointY(panelId, col, i));
        if (v < lo) lo = v;
        if (v > hi) hi = v;
    }
    return { col: col, varies: n > 1 && hi - lo > 1e-6 };
}

// Path to read a drawing through. getData and Drawing.text cache a file per
// session by path, so a drawing rewritten and saved still reads the old art.
// Shared drawings (the only ones we rewrite in place) and anything in
// env.rewritten are read from a fresh copy, since a later run in the same
// session can't know what an earlier one rewrote. Works with export and
// import envs (copies go under `stagingDir` or `extractDir`).
function drawingReadPath(env, tvgPath) {
    var key = common.sharedDrawingKey(tvgPath);
    var shared = /^elements\/Shared\//.test(key);
    if (!shared && !(env.rewritten && env.rewritten[key])) return tvgPath;
    if (env.freshCopies[key]) return env.freshCopies[key];
    var dir = (env.stagingDir || env.extractDir) + "/fresh";
    new Dir(dir).mkdirs();
    var copy = dir + "/" + common.shortHash(key) + "-" + common.fileBasename(tvgPath);
    if (!common.copyFile(tvgPath, copy)) {
        env.log.warn("drawing " + key + " was rewritten here but could not be copied to be read fresh: its old art may be read");
        return tvgPath;
    }
    env.freshCopies[key] = copy;
    return copy;
}

// ── Shared drawings (SPEC.md "shared/") ─────────────────────────────────────

// One record per drawing file (SBP has no other identity for a shared
// drawing). The id comes from the id map so round trips keep Upshot's ids,
// else from the key's hash. Taken ids get a suffixed hash.
function sharedDrawingRecord(env, tvgPath, name) {
    var p = String(tvgPath).replace(/\\/g, "/");
    var rec = env.shared.byFile[p];
    if (rec) return rec;
    var key = common.sharedDrawingKey(p);
    var id = common.sharedDrawingArchiveId(env.idMap, key);
    for (var n = 2; env.shared.ids[id]; n++) id = common.sharedDrawingDefaultId(key + "#" + n);
    env.shared.ids[id] = true;
    rec = { id: id, key: key, tvg: p, name: name, model: null, atlas: null };
    env.shared.byFile[p] = rec;
    env.shared.list.push(rec);
    return rec;
}

// After shared/ is written, store each drawing's baseline in the id map: the
// art just written and the saved file hash. A later import uses it to relink
// unchanged drawings or replace changed ones (common.sharedLinkMode). One
// key per id.
function stampSharedDrawings(env) {
    if (!env.shared.list.length) return;
    var drawings = env.idMap.drawings || (env.idMap.drawings = {});
    env.shared.list.forEach(function (rec) {
        dropSharedId(drawings, rec.id, rec.key);
        drawings[rec.key] = { id: rec.id, art: common.sharedDrawingIdentity(env.stagingDir + "/shared", rec.id, rec.textureLink),
                              file: common.fileSha256(rec.tvg) };
    });
    common.saveIdMap(env.sb, env.idMap);
}

function dropSharedId(drawings, id, keepKey) {
    for (var k in drawings) if (drawings.hasOwnProperty(k) && k !== keepKey && drawings[k] && drawings[k].id === id) delete drawings[k];
}

// Shared-drawing baselines after an import or update. Needs a saved project,
// unsaved drawings have no key. A stamp has `key` when known, else `panel`
// and `drawingName` to find it. `keepFile` keeps the old file hash for a
// linked drawing, only an export may update it.
function stampImportedSharedDrawings(log, idMap, stamps) {
    if (!stamps || !stamps.length) return 0;
    var lm = new LayerManager(), dir = common.projectDir(), drawings = idMap.drawings || (idMap.drawings = {}), n = 0;
    stamps.forEach(function (st) {
        var key = st.key || "";
        if (!key && st.panel) {
            for (var i = 0; i < lm.numberOfLayers(st.panel) && !key; i++) {
                if (lm.isShared(st.panel, i) !== true || String(lm.getLayerDrawingName(st.panel, i, false) || "") !== st.drawingName) continue;
                key = common.sharedDrawingKey(String(lm.getLayerDrawingName(st.panel, i, true) || ""));
            }
        }
        if (!key || !common.fileExists(dir + "/" + key)) {
            log.warn("shared drawing " + st.id + ": its baseline was not recorded (its file was not found after the save)");
            return;
        }
        var prev = drawings[key];
        dropSharedId(drawings, st.id, key);
        drawings[key] = { id: st.id, art: st.art,
                          file: st.keepFile ? (prev && prev.id === st.id ? String(prev.file || "") : "") : common.fileSha256(dir + "/" + key) };
        n++;
    });
    return n;
}

// Every drawing in the "Shared" element goes out, used or not. Unused ones
// can't be rendered by a panel, so we paint their textures ourselves
// (renderTexturedModel).
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
                if (rec.atlas && rec.atlas.cellCount) env.counts.libraryAtlases++;
            }
            if (rec.model.usedTexture && !rec.atlas) env.log.warn("shared drawing '" + rec.name + "' is held by no layer and its textures could not be painted: written flat");
        }
    }
}

// ── Textures painted in script (a drawing no panel shows) ───────────────────

// Paints a drawing's textured contours into a frame-sized PNG, like SBP
// does: texture mapped by the contour matrix (unit square, rows up) and
// clipped by the outline. Null if nothing painted (brush textures have no
// file).
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

// Full-size texture from palette-library/<palette>_textures/<colourId>.tga,
// in the project or an element. The colour's `image` is only a thumbnail.
function textureImage(env, colorId) {
    var cache = env.textureImages;
    if (cache[colorId] !== undefined) return cache[colorId];
    var root = common.projectDir(), found = null;
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

// Qt here can't read TGA. Handles 32-bit raw or RLE, either row order.
function loadTga(path) {
    var bytes = common.readFileBytes(path);
    if (!bytes) return null;
    var n = bytes.length;
    function u8(i) { return bytes[i] & 255; }   // past the end: 0, like QByteArray.at
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

// The name is in the file name ("Shared-<name>.tvg"), not on the layer.
// Falls back to the layer name.
function sharedDrawingName(env, panelId, li, tvgPath, layerName) {
    var raw = String(env.lm.getLayerDrawingName(panelId, li, false) || tvgPath || "");
    var name = common.fileBasename(raw).replace(/\.tvg$/i, "").replace(/^Shared[-_ ]/i, "");
    return name || layerName;
}

// Writes shared/<id>/art.svg, shared/<id>/texture.json when textured, and
// shared/index.json. stampSharedDrawings reads `rec.textureLink`.
function writeSharedArt(env) {
    if (!env.shared.list.length) return;
    var index = env.shared.list.map(function (rec) {
        var dir = env.stagingDir + "/shared/" + rec.id;
        new Dir(dir).mkdirs();
        var out = emitLayerSvg(env, rec.model || emptyModel(), rec.id, rec.name, "shared-" + rec.id, rec.atlas);
        common.writeTextFile(dir + "/art.svg", out.svg);
        var entry = { id: rec.id, name: rec.name, art: rec.id + "/art.svg" };
        rec.textureLink = undefined;
        if (out.texture) {
            rec.textureLink = entry.texture = common.sharedTextureLink(rec.id);
            common.writeTextFile(env.stagingDir + "/shared/" + rec.textureLink, out.texture);
        }
        return entry;
    });
    common.writeTextFile(env.stagingDir + "/shared/index.json", JSON.stringify({ drawings: index }));
}

// ── Drawings -> SVG ─────────────────────────────────────────────────────────

function fmtNum(v) {
    return String(Math.round(v * 1000) / 1000);
}

// Max error of fmtNum: half of 0.001 plus a hair for float rounding.
var PRINT_HALF_STEP = 0.0005 + 1e-9;

function drawingToWorld(env, p) {
    return { x: p.x * env.worldPerDrawing, y: -p.y * env.worldPerDrawing };
}

function emptyModel() {
    return { items: [], textured: [], usedTexture: false };
}

// Reads the saved drawing into what the SVG needs: `items` in drawing order
// (filled contours and pencil lines), `textured` (textured contours with
// world bounds, tile k is for entry k) and `usedTexture`.
function parseDrawing(env, tvgPath, label, raw) {
    var model = emptyModel();
    if (!tvgPath) return model;
    var data = null;
    try { data = readDrawingData(drawingReadPath(env, tvgPath)); }
    catch (e) { env.log.warn("Drawing.query.getData failed for " + label + ": " + e); }
    if (raw) raw.data = data;
    if (!data || !data.arts) return model;
    var brushMarked = hasBrushTextureMark(data);
    if (raw) raw.brushMarked = brushMarked;
    data.arts.slice().sort(function (a, b) { return a.art - b.art; }).forEach(function (art) {
        (art.layers || []).forEach(function (layer) { parseDrawables(env, layer, data.colors, model, brushMarked); });
    });
    keepMixedDrawingTextured(model, function (contour) { return contourWorldBounds(env, contour); });
    return model;
}

// If a drawing has any textured contour, make all its solid contours
// textured too. The atlas comes from one render of the whole drawing, and
// Upshot merges textured paths at the first one's position, so a flat path
// in between would end up drawn on top of the merged strokes. Gradients and
// pencil lines stay as they are.
function keepMixedDrawingTextured(model, boundsOf) {
    if (!model.textured.length) return;
    var flat = model.items.some(function (it) { return it.flatSolid; });
    if (!flat) return;
    model.textured = [];
    model.items.forEach(function (it) {
        if (it.flatSolid) {
            it.col = { hex: it.col.hex, alpha: it.col.alpha, rgb: it.col.rgb, isTexture: true, brush: true };
            it.flatSolid = false;
            model.usedTexture = true;
        }
        if (!it.line && it.col.isTexture) {
            it.texturedIndex = model.textured.length;
            model.textured.push({ contour: it.contour, bb: boundsOf(it.contour) });
        }
    });
}

// Textured brushes (Rough Pencil, Charcoal, ...) draw a plain solid contour.
// The only trace is an unused texture colour the brush adds to the drawing's
// colour table ("InternalTexture" in English, don't match by name). It
// doesn't say which contour, so contourHasTextureMatrix decides per contour.
function hasBrushTextureMark(data) {
    var colors = data.colors;
    if (!colors) return false;
    var used = {};
    (data.arts || []).forEach(function (art) {
        (art.layers || []).forEach(function (layer) {
            (layer.contours || []).forEach(function (c) { if (c && c.colorId !== undefined) used[c.colorId] = true; });
            (layer.strokes || []).forEach(function (s) { if (s && s.colorId !== undefined) used[s.colorId] = true; });
        });
    });
    for (var id in colors) {
        if (colors.hasOwnProperty(id) && colors[id] && colors[id].isTexture && !used[id]) return true;
    }
    return false;
}

function parseDrawables(env, vectorLayer, colors, model, brushMarked) {
    (vectorLayer.contours || []).forEach(function (contour) {
        var d = svgPathData(env, contour.path, true);
        if (!d) return;
        (contour.holes || []).forEach(function (hole) {
            var hd = svgPathData(env, hole, true);
            if (hd) d += " " + hd;
        });
        var col = lookupColor(colors, contour.colorId, model);
        // Brush strokes are solid colours, spot them by matrix. Skip
        // gradients, their matrix is just the gradient placement.
        if (!col.isTexture && !col.gradient && contourHasTextureMatrix(contour, brushMarked)) {
            model.usedTexture = true;
            col = { hex: col.hex, alpha: col.alpha, rgb: col.rgb, isTexture: true, brush: true };
        }
        // flatSolid: see keepMixedDrawingTextured.
        var item = { d: d, col: col, contour: contour, texturedIndex: -1, flatSolid: !col.isTexture && !col.gradient };
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

// Turns on/off-curve points into move/line/quad/cubic calls on `sink`.
// Trailing control points of a closed path curve back to the start.
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

// Is this solid contour a textured brush stroke? SBP gives every contour a
// shader matrix, so:
// - none or identity: flat (our importer writes identity for its fills)
// - SBP's default fit to the contour box (ox = x0, oy = box middle,
//   xx = yy = width): flat, unless the drawing has the brush texture mark
// - anything else (edited fill, moved/scaled stroke): textured
function contourHasTextureMatrix(contour, brushMarked) {
    var m = contour ? contour.matrix : null;
    if (!m || typeof m.xx !== "number") return false;
    if (isIdentityShaderMatrix(m)) return false;
    if (!brushMarked && isBoxLinearFit(m, contour.box)) return false;
    return true;
}

function isIdentityShaderMatrix(m) {
    var eps = 1e-6;
    return Math.abs(m.xx - 1) < eps && Math.abs(m.yy - 1) < eps && Math.abs(m.xy || 0) < eps &&
           Math.abs(m.yx || 0) < eps && Math.abs(m.ox || 0) < eps && Math.abs(m.oy || 0) < eps;
}

// Matrix matches the default box fit, in drawing units. Real ones are
// within 1e-6.
var LINFIT_TOLERANCE = 1e-4;
function isBoxLinearFit(m, box) {
    if (!box || typeof box.x0 !== "number" || typeof box.x1 !== "number" ||
        typeof box.y0 !== "number" || typeof box.y1 !== "number") return false;
    var w = box.x1 - box.x0, cy = (box.y0 + box.y1) / 2, t = LINFIT_TOLERANCE;
    return Math.abs(m.ox - box.x0) <= t && Math.abs(m.oy - cy) <= t && Math.abs(m.xx - w) <= t &&
           Math.abs(m.yy - w) <= t && Math.abs(m.xy || 0) <= t && Math.abs(m.yx || 0) <= t;
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

// {hex, alpha, rgb}, plus `isTexture` or `gradient` (flat colour = first stop).
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

// Gradient stops as 8-bit {r,g,b,a} + t (0..1), sorted. Null for a solid.
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

// World-unit bounds of a contour, null for an empty path.
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

// Returns {svg, texture} for a parsed drawing (SPEC.md "Textured strokes
// (1.2)"). A textured item becomes a flat path "t<n>" with its fallback
// colour, plus an {id, view} entry in the texture file. `texture` is null
// when nothing is textured. Without a tile the item is a plain flat path.
// Ids restart per SVG, so a single panel export hashes the same.
function emitLayerSvg(env, model, layerId, layerName, panelId, atlas) {
    var body = "";
    var defs = [];   // gradient defs, go first in the <g>
    var ids = { gradients: 0 };
    var texPaths = [];   // texture file path entries
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
            var tid = "t" + texPaths.length;
            texPaths.push({ id: tid, view: [tile.ax, tile.ay, tile.aw, tile.ah] });
            var fallback = textureFallback(col, tile.rgba, tile.inkUnder || storedCellMeetsView(atlas, tile));
            body += '  <path id="' + tid + '" d="' + item.d + '"' + flatFillAttrs(fallback) + ' fill-rule="nonzero" stroke="none"/>\n';
        } else if (col.gradient) {
            // Use the shape's matrix, or fit to its box.
            var m = item.contour.matrix;
            var aff = (m && typeof m.xx === "number") ? affineFromShaderMatrix(env, m)
                                                      : fitGradientAffine(col.gradient.type, contourWorldBounds(env, item.contour));
            var gid = "tbg" + (++ids.gradients);
            defs.push(gradientDefSvg(gid, col.gradient, aff));
            body += '  <path d="' + item.d + '" fill="url(#' + gid + ')" stroke="none"/>\n';
        } else {
            // Same flat rule as textured paths (SPEC.md "Art SVG").
            body += '  <path d="' + item.d + '"' + flatFillAttrs(col.rgb.concat([col.alpha])) + ' stroke="none"/>\n';
        }
    });
    if (defs.length) body = '    <defs>\n' + defs.join("") + '    </defs>\n' + body;
    var xs = fmtNum(-env.frameW / 2), ys = fmtNum(-env.frameH / 2);
    var ws = fmtNum(env.frameW), hs = fmtNum(env.frameH);
    var xml = common.xmlEscape;
    var svg = '<?xml version="1.0" encoding="UTF-8"?>\n' +
              '<svg xmlns="http://www.w3.org/2000/svg"\n' +
              '     xmlns:sboardx="https://sboardx.format/ns/1.0"\n' +
              '     viewBox="' + xs + ' ' + ys + ' ' + ws + ' ' + hs + '"' +
              ' width="' + ws + '" height="' + hs + '"\n' +
              '     sboardx:layer-id="' + xml(layerId) + '"\n' +
              '     sboardx:layer-name="' + xml(layerName) + '"\n' +
              '     sboardx:panel-id="' + xml(panelId) + '"\n' +
              '     sboardx:format-version="1.2">\n' +
              '  <g sboardx:blend="normal" sboardx:opacity="100">\n' +
              body +
              '  </g>\n' +
              '</svg>\n';
    return { svg: svg, texture: texPaths.length ? textureFileText(atlas, texPaths) : null };
}

// Fill attributes for a flat path (SPEC.md "Art SVG"): 8-bit hex `fill`,
// exact `fill-opacity` unless 1, and `sboardx:rgba` only when a channel is
// off the n/255 grid.
function flatFillAttrs(rgba) {
    function onGrid(v) { return Math.round(v * 255) / 255 === v; }
    var s = ' fill="' + common.colorHex({ r: rgba[0] * 255, g: rgba[1] * 255, b: rgba[2] * 255 }) + '"';
    if (rgba[3] !== 1) s += ' fill-opacity="' + String(rgba[3]) + '"';
    if (!(onGrid(rgba[0]) && onGrid(rgba[1]) && onGrid(rgba[2]))) s += ' sboardx:rgba="' + rgba.map(String).join(" ") + '"';
    return s;
}

// Does any stored cell overlap the tile's view? If so the path's alpha
// can't be 0 (SPEC.md "Ink is never hidden").
function storedCellMeetsView(atlas, tile) {
    var S = atlas.size;
    for (var r = Math.floor(tile.ay / S), r1 = Math.floor((tile.ay + tile.ah - 1) / S); r <= r1; r++) {
        for (var c = Math.floor(tile.ax / S), c1 = Math.floor((tile.ax + tile.aw - 1) / S); c <= c1; c++) {
            if (atlas.cells[c + "_" + r]) return true;
        }
    }
    return false;
}

// The layer's texture file (SPEC.md "The texture object"). `rect` is the
// render's mapping, don't rebuild it from the views. Cells are
// [col, row, page, slot col, slot row] in rank order.
function textureFileText(atlas, paths) {
    var S = atlas.size, pages = [], cells = [];
    for (var k = 0; k < atlas.pages.length; k++) pages.push(common.pageEntryName(atlas.prefix, k));
    atlas.order.forEach(function (c) {
        var at = atlas.cells[c.c + "_" + c.r];
        if (at) cells.push([c.c, c.r, at.page, at.sx / S, at.sy / S]);
    });
    return JSON.stringify({ atlas_size: [atlas.w, atlas.h], cell_size: S, rect: atlas.rect, pages: pages, cells: cells, paths: paths });
}

// Gradient def in the spec's unit-space form.
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

// Sorted keyed frames of a 3D path column plus plain columns, and the path
// point at each path key.
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

// Path point at `frame`, or at the nearest key.
function pathPointAt(keys, frame) {
    if (keys.posAt[frame]) return keys.posAt[frame];
    var best = { x: 0, y: 0, z: 0 }, bestDist = -1;
    for (var f in keys.posAt) {
        var d = Math.abs(Number(f) - frame);
        if (bestDist < 0 || d < bestDist) { bestDist = d; best = keys.posAt[f]; }
    }
    return best;
}

// Bezier column value at the key nearest `frame`, or `fallback`.
function nearestKey(env, id, col, frame, fallback) {
    var fm = env.fm, best = fallback, bestDist = -1;
    var n = col ? fm.numberOfPoints(id, col) : 0;
    for (var i = 0; i < n; i++) {
        var d = Math.abs(fm.pointX(id, col, i) - frame);
        if (bestDist < 0 || d < bestDist) { bestDist = d; best = fm.pointY(id, col, i); }
    }
    return best;
}

// Layer animation -> "layer_tracks". One track per animated layer or group
// name per scene. Keys go from 1-based panel frames to scene seconds and
// from SBP fields and CCW angles to sboardx poses (pivot at the origin).
// Opacity is 1 unless the layer fades within the panel.
function readLayerTracks(env, infos) {
    var byKey = {}, order = [], start = 0;   // start: panel start in scene seconds
    infos.forEach(function (info) {
        var panelFrames = env.sb.getPanelDuration(info.panelId);
        var targets = info.indices.map(function (li, i) { return { li: li, name: String(info.entries[i].name), kind: "layer" }; });
        for (var gk in info.groups) if (info.groups.hasOwnProperty(gk)) targets.push({ li: Number(gk), name: info.groups[gk], kind: "group" });
        targets.forEach(function (tg) {
            var keys = readLayerKeys(env, info.panelId, tg.li, panelFrames, tg.kind);
            if (!keys.length) return;
            var key = tg.kind + ":" + tg.name;
            if (!byKey[key]) { byKey[key] = { name: tg.name, kind: tg.kind, kfs: [] }; order.push(key); }
            var kfs = byKey[key].kfs;
            keys.forEach(function (k) {
                var t = start + k.t;
                // First key of a panel lands on the previous panel's last
                // key. Same pose: merge. Different pose: it's a jump, keep
                // both at the same time.
                var prev = kfs.length ? kfs[kfs.length - 1] : null;
                if (prev && Math.abs(prev.t - t) < 0.5 / env.fps) {
                    if (samePose(prev, k)) return;
                    t = prev.t;
                }
                kfs.push({ id: "lk" + (kfs.length + 1), t: t, tx: k.tx, ty: k.ty, s: k.s, rot: k.rot, opacity: k.opacity });
            });
        });
        start += panelFrames / env.fps;
    });
    return order.map(function (key) { return byKey[key]; }).filter(function (tr) {
        return !tr.kfs.every(common.isIdentityPose);
    }).map(function (tr) {
        var kfs = dropRedundantKeys(tr.kfs);
        kfs.forEach(function (k, i) { k.id = "lk" + (i + 1); });
        return { name: tr.name, kind: tr.kind, pivot: { x: 0, y: 0 }, keyframes: kfs };
    });
}

// Equal within what a save keeps (only a few decimals are stored).
function samePose(a, b) {
    return Math.abs(a.tx - b.tx) < 1e-2 && Math.abs(a.ty - b.ty) < 1e-2 &&
           Math.abs(a.s - b.s) <= 1e-4 * Math.max(1, Math.abs(a.s)) &&
           Math.abs(common.wrapDeg(a.rot - b.rot)) < 1e-3 && Math.abs(a.opacity - b.opacity) < 1e-3;
}

// Drops keys that change nothing: end keys equal to their neighbour, and
// keys equal to both neighbours. Poses hold past the ends anyway.
function dropRedundantKeys(kfs) {
    var out = kfs.slice();
    for (var i = out.length - 1; i >= 1; i--) {
        if (samePose(out[i], out[i - 1]) && (i === out.length - 1 || samePose(out[i], out[i + 1]))) out.splice(i, 1);
    }
    while (out.length >= 2 && samePose(out[0], out[1])) out.splice(0, 1);
    return out;
}

// One layer's keys in one panel: every frame keyed by offset, scale,
// rotation or opacity, sampled to a full pose. Empty if not animated.
function readLayerKeys(env, panelId, li, panelFrames, kind) {
    var posCol, sxCol, rotCol, keys;
    var op = kind === "layer" ? opacityAnimation(env, panelId, li) : { col: "", varies: false };
    try {
        posCol = String(env.mm.linkedLayerFunction(panelId, li, "offset.attr3dpath") || "");
        sxCol = String(env.mm.linkedLayerFunction(panelId, li, "scale.x") || "");
        rotCol = String(env.mm.linkedLayerFunction(panelId, li, "rotation.anglez") || "");
        if (!posCol && !sxCol && !rotCol && !op.varies) return [];
        keys = collectKeys(env, panelId, posCol, [sxCol, rotCol, op.varies ? op.col : ""]);
    } catch (e) { return []; }
    var out = [];
    keys.frames.forEach(function (f) {
        if (f > panelFrames) return;
        var pos = pathPointAt(keys, f);
        var pose = common.sbpToPose(pos.x, pos.y, sxCol ? nearestKey(env, panelId, sxCol, f, 1) : 1,
                                    rotCol ? nearestKey(env, panelId, rotCol, f, 0) : 0, env.fields);
        pose.t = common.panelFrameToTime(f, env.fps, panelFrames);
        if (op.varies) {
            try { pose.opacity = common.clamp01(Number(env.lm.layerOpacity(panelId, li, f)) / 100); } catch (e2) {}
        }
        out.push(pose);
    });
    return out;
}

// The scene's live camera (Camera-Peg pan, scale, rotation, Z) as sboardx
// keyframes. Z is folded into the zoom: with the camera D fields from the
// drawing plane (offset.z, default 12) and the peg at pz, scale by
// D / (D + pz). Keys outside the scene's frames are never shown by SBP, so
// they are dropped with a warning.
function readLiveCamera(env, sceneId) {
    var mm = env.mm;
    var posCol = mm.linkedCameraFunction(sceneId, "position.attr3dpath");
    var sxCol = mm.linkedCameraFunction(sceneId, "scale.x");
    var rotCol = mm.linkedCameraFunction(sceneId, "rotation.anglez");
    var camDist = 12, sep = null;   // sep: separate X/Y/Z functions instead of the 3D path
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
    var sceneFrames = common.sceneFrameCount(env.sb, sceneId);
    var outside = keys.frames.filter(function (f) { return f < 1 || f > sceneFrames; });
    if (outside.length) {
        keys.frames = keys.frames.filter(function (f) { return f >= 1 && f <= sceneFrames; });
        if (!env.cameraOutsideWarned[sceneId]) {
            env.cameraOutsideWarned[sceneId] = true;
            env.log.warn("scene '" + env.sb.nameOfScene(sceneId) + "': camera key(s) on frame(s) " + outside.join(", ") + " of its " +
                         sceneFrames + " frames (left by an earlier import) are never shown and are left out of its camera; " +
                         "check the scene's camera");
        }
    }
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
        return { id: "kf" + (i + 1), t: common.cameraFrameToTime(f, env.fps), z: zoom,
                 cx: pos.x / env.fields.perWorldX, cy: -pos.y / env.fields.perWorldY,
                 rot: -nearestKey(env, sceneId, rotCol, f, 0) };
    });
}

// The camera to export, {keyframes, stamp}. If the live camera still matches
// the baseline, send the archive's keyframes back unchanged (SBP snaps keys
// to whole frames, the archive may not). Otherwise send the live camera.
// `stamp` is the new baseline, null if the camera couldn't be read.
function readSceneCamera(env, sceneId, firstPanelId) {
    var live = null;
    try { live = readLiveCamera(env, sceneId); }
    catch (e) { env.log.warn("camera could not be read on scene " + sceneId + ": " + e); }
    var base = common.readCameraBase(env.sb, firstPanelId);
    if (base && (live === null || common.cameraKfsMatch(live, common.cameraBaseLocal(base), env.fps, common.sceneFrameCount(env.sb, sceneId)))) {
        return { keyframes: base.archive,
                 stamp: { sceneId: sceneId, archive: base.archive, local: base.local !== null ? base.local : live } };
    }
    if (base) env.log.trace("camera of scene " + sceneId + " changed here since the last exchange: the live camera goes out");
    return { keyframes: live || [], stamp: live === null ? null : { sceneId: sceneId, archive: live, local: live } };
}

// Writes each scene's camera baseline on its first panel. Import, export and
// update all go through here. Stamp: {sceneId, archive, local, verify}.
// local is keyframes, null, or "live" (read it back now). With `verify`,
// warn if SBP didn't keep the camera exactly (it snaps keys to whole frames
// inside the scene).
function stampSceneCameras(xenv, stamps) {
    var sb = xenv.sb, stamped = 0;
    (stamps || []).forEach(function (st) {
        if (!st || sb.numberOfPanelsInScene(st.sceneId) <= 0) return;
        var name = String(sb.nameOfScene(st.sceneId));
        var local = st.local;
        if (local === "live") {
            try { local = readLiveCamera(xenv, st.sceneId); }
            catch (e) {
                xenv.log.warn("scene '" + name + "': camera not read back (" + e + "); its next merge compares with the file's camera");
                local = null;
            }
            var diff = st.verify && local ? common.cameraKfsDiff(local, st.archive, xenv.fps, common.sceneFrameCount(sb, st.sceneId)) : "";
            if (diff) xenv.log.warn("scene '" + name + "': Storyboard Pro holds the file's camera approximately (" + diff + ")");
        }
        common.writeCameraBase(sb, String(sb.panelInScene(st.sceneId, 0)), st.archive, local);
        stamped++;
    });
    if (stamped) xenv.log.trace("camera baselines stamped: " + stamped);
}

// ── Renders: image layers and textured-stroke atlases ───────────────────────

// Renders each job's layer alone with the camera cleared, inside an undo
// accumulation we cancel afterwards. In -batch there is no undo: visibility
// is restored by hand, and with a camera move the jobs are skipped.
function rasterizePanel(env, sceneId, panelId, outId, jobs, camKfs) {
    var lm = env.lm, n = lm.numberOfLayers(panelId);
    if (!env.hasSession && camKfs.length > 0) {
        env.log.warn("image layer(s) on panel " + panelId + " skipped: the scene has a camera move and -batch " +
                     "has no undo session to neutralize it - run the export in an interactive Storyboard Pro session");
        return;
    }
    // Reuse renders of drawings we already rendered.
    jobs = jobs.filter(function (job) { return !cachedRender(env, outId, job); });
    if (!jobs.length) return;
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
            // Show the parent groups too (a hidden group hides its members)
            // and clear their motion: tiles must be untransformed, the
            // transform goes in layer_tracks. Not possible in -batch.
            var keep = [job.li].concat(ancestorGroups(env, panelId, job.li));
            if (env.hasSession) {
                keep.forEach(function (idx) { try { env.mm.clearLayerMotion(panelId, idx); } catch (e) {} });
                // Renders bake in opacity, which goes out separately, so
                // force 100. clearLayerMotion already did it for animated
                // layers. The undo restores it.
                try { env.lm.setLayerOpacity(panelId, job.li, 100, 1); } catch (e3) {}
                job.opacityBaked = false;
            } else if (keep.some(function (idx) { return readLayerKeys(env, panelId, idx, env.sb.getPanelDuration(panelId)).length > 0; })) {
                warnOnce(env, "batch-motion:" + job.layerName, "layer '" + job.layerName + "' has layer motion that -batch cannot " +
                         "neutralize for the render; its textures may be cut from the wrong place");
            }
            if (!env.hasSession) job.opacityBaked = true;   // can't reset it without undo
            var k = job.renderK;
            var src = renderLayerAlone(env, em, panelId, outId, n, job, keep, k);
            if (src && job.kind === "atlas" && buildAtlas(env, outId, job, src, k) === "retry") {
                // Zoomed render was off, render the plain frame.
                k = 1;
                src = renderLayerAlone(env, em, panelId, outId, n, job, keep, 1);
                if (src) buildAtlas(env, outId, job, src, 1);
            } else if (src && job.kind === "image") stageImageLayer(env, outId, job, src);
            if (src && job.renderKey) {
                env.renderCache[job.renderKey] = { src: src, k: k, atlas: job.atlas,
                                                   sig: job.kind === "atlas" ? texturedSignature(job) : "" };
            }
            if (!src) env.log.warn("layer '" + job.layerName + "' (panel " + panelId + ") did not render; " +
                                   (job.kind === "atlas" ? "kept flat" : "exported empty"));
        });
    } finally {
        if (env.hasSession) project.cancelUndoRedoAccum();
        else for (var r = 0; r < n; r++) lm.setLayerVisible(panelId, r, vis[r]);
    }
}

// ── One render per shared drawing ──────────────────────────────────────────

// Since camera, motion and opacity are cleared, every holder of a drawing
// renders the same pixels. Later holders reuse the first render: image
// layers copy it, atlas jobs copy the atlas if the textured contours match
// (getData may split contours differently per read), else cut their own.
// Keyed by drawing file, job kind and zoom, lives as long as the env. Never
// in -batch, where motion can't be cleared.

// Sets the job's zoom and cache key, and serves it from the cache on a hit.
// True if no render is needed.
function cachedRender(env, outId, job) {
    job.renderK = job.kind === "atlas" ? renderScale(env, job) : 1;
    job.renderKey = (env.hasSession && job.tvgPath)
        ? String(job.tvgPath).replace(/\\/g, "/") + "|" + job.kind + "|" + job.renderK : "";
    var hit = job.renderKey ? env.renderCache[job.renderKey] : null;
    if (!hit) return false;
    job.opacityBaked = false;   // cached renders always come from a session
    if (job.kind === "image") {
        stageImageLayer(env, outId, job, hit.src);
        return true;
    }
    if (hit.atlas && hit.sig === texturedSignature(job) && copyCachedAtlas(env, outId, job, hit.atlas)) return true;
    // "retry": the zoomed render doesn't work for these contours, render again.
    return buildAtlas(env, outId, job, hit.src, hit.k) !== "retry";
}

// Everything buildAtlas uses from the job apart from the render.
function texturedSignature(job) {
    return JSON.stringify(job.textured.map(function (t) { return [t.bb, t.contour.path, t.contour.holes || []]; }));
}

// Copies the first holder's pages under this holder's names.
function copyCachedAtlas(env, outId, job, atlas) {
    var prefix = uniquePagePrefix(env, outId, job.layerId);
    for (var k = 0; k < atlas.pages.length; k++) {
        var from = env.stagingDir + "/" + common.pageEntryName(atlas.prefix, k);
        var to = env.stagingDir + "/" + common.pageEntryName(prefix, k);
        if (from !== to && !common.copyFile(from, to)) return false;
    }
    job.atlas = { prefix: prefix, w: atlas.w, h: atlas.h, size: atlas.size, rect: atlas.rect, cells: atlas.cells, order: atlas.order,
                  cellCount: atlas.cellCount, pages: atlas.pages, tiles: atlas.tiles.slice() };
    var count = 0;
    atlas.tiles.forEach(function (t) { if (t) count++; });
    env.counts.texturedStrokes += count;
    env.counts.atlasCells += atlas.cellCount;
    env.counts.atlasPages += atlas.pages.length;
    return true;
}

// Page name prefix for a layer (SPEC.md "Pages"). Ids can contain "_", so
// "a_b"+"c" and "a"+"b_c" collide: add "_2", "_3"... Stable per layer.
function uniquePagePrefix(env, owner, layer) {
    var key = owner + "\n" + layer, pp = env.pagePrefixes;
    if (pp.byLayer.hasOwnProperty(key)) return pp.byLayer[key];
    var base = common.pagePrefixOf(owner, layer), name = base;
    for (var n = 2; pp.taken.hasOwnProperty(name); n++) name = base + "_" + n;
    pp.taken[name] = true;
    pp.byLayer[key] = name;
    return name;
}

// Parent groups, innermost first.
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

// Zoom-out needed to fit all textured contours, capped at MAX_RENDER_SCALE.
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

// Renders only the `keep` layers to a PNG, zoomed out by `k`. Returns the
// path or null.
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
    // Opacity already in the pixels (-batch).
    if (job.opacityBaked) job.entry.opacity = 100;
    env.counts.rasterLayers++;
}

// The layer's render cropped to its textured contours is the atlas, one
// image placed by one `rect` (SPEC.md "One image per layer"). Each contour
// views its own pixel rect of it, rounded outward. Sets `job.atlas`
// (tiles[k] is null outside the render), left null on failure. Returns
// "retry" when a zoomed render came out wrong.
function buildAtlas(env, outId, job, src, k) {
    var render = new QImage(src);
    if (render.isNull()) {
        env.log.warn("textured layer '" + job.layerName + "' kept flat (render unreadable)");
        return;
    }
    var W = render.width(), H = render.height();
    if (k > 1) {
        // SBP caps width at 4096 px but keeps the aspect. A different
        // aspect means the zoom misbehaved.
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
    var ux0 = W, uy0 = H, ux1 = 0, uy1 = 0, inked = 0;      // union of contour rects, pixels
    var tiles = job.textured.map(function (item, idx) {
        var bb = item.bb;
        if (!bb) return null;
        // The view must cover the printed outline (SPEC.md "The mapping"),
        // which fmtNum rounding can push out by PRINT_HALF_STEP.
        var minX = Math.max(bb.minX - PRINT_HALF_STEP, -halfW), maxX = Math.min(bb.maxX + PRINT_HALF_STEP, halfW);
        var minY = Math.max(bb.minY - PRINT_HALF_STEP, -halfH), maxY = Math.min(bb.maxY + PRINT_HALF_STEP, halfH);
        if (!(maxX > minX) || !(maxY > minY)) return null;   // outside the render
        var px0 = Math.max(0, Math.floor((minX + halfW) * sx)), py0 = Math.max(0, Math.floor((minY + halfH) * sy));
        var pw = Math.min(W, Math.ceil((maxX + halfW) * sx)) - px0, ph = Math.min(H, Math.ceil((maxY + halfH) * sy)) - py0;
        if (pw <= 0 || ph <= 0) return null;
        // Fallback colour: mean of the pixels inside the outline.
        var rgba, inkUnder = false;
        try {
            // tileMeanColor wants premultiplied pixels.
            var probe = new QImage(pw, ph, QImage.Format_ARGB32_Premultiplied);
            probe.fill(0);
            var painter = new QPainter();
            painter.begin(probe);
            painter.setCompositionMode(QPainter.CompositionMode_Source);
            painter.drawImage(-px0, -py0, render);
            painter.setCompositionMode(QPainter.CompositionMode_DestinationIn);
            painter.setRenderHint(QPainter.Antialiasing, true);
            painter.fillPath(contourPainterPath(env, item.contour, px0, py0, sx, sy, halfW, halfH), new QBrush(new QColor(0, 0, 0, 255)));
            painter.end();
            // imageHasInk skips the full pixel scan for empty tiles. With
            // no ink inside the outline (a zero-area sliver), the rect can
            // still hold ink, and the validator counts it, so alpha can't
            // be 0 then either (inkUnder).
            rgba = tileMeanColor(probe, contourAreaPixels(env, item.contour, sx, sy), function (img) { return imageHasInk(env, img); });
            if (!(rgba[3] > 0)) inkUnder = regionHasInk(env, render, px0, py0, pw, ph);
        } catch (e) {
            env.log.warn("textured layer '" + job.layerName + "': tile " + idx + " failed (" + e + ")");
            return null;
        }
        if (rgba[3] > 0) inked++;
        if (px0 < ux0) ux0 = px0; if (py0 < uy0) uy0 = py0;
        if (px0 + pw > ux1) ux1 = px0 + pw; if (py0 + ph > uy1) uy1 = py0 + ph;
        return { ax: px0, ay: py0, aw: pw, ah: ph, rgba: rgba, inkUnder: inkUnder };
    });
    var count = 0;
    tiles.forEach(function (t) { if (t) count++; });
    if (k > 1 && count && inked === 0) {
        // All empty: the zoom didn't scale around the centre. Use the plain frame.
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
    // Draw into a fresh image instead of render.copy(): a copy keeps the
    // render's colour space and every PNG saved from it gets a 2.6 KB ICC
    // profile. CompositionMode_Source copies the pixels exactly.
    var atlasImg = new QImage(atlasW, atlasH, QImage.Format_ARGB32);
    atlasImg.fill(0);
    var cropper = new QPainter();
    cropper.begin(atlasImg);
    cropper.setCompositionMode(QPainter.CompositionMode_Source);
    cropper.drawImage(-ux0, -uy0, render);
    cropper.end();
    var paths = job.textured.map(function (item, idx) {
        return tiles[idx] ? contourPainterPath(env, item.contour, ux0, uy0, sx, sy, halfW, halfH, Qt.WindingFill) : null;
    });
    var prefix = uniquePagePrefix(env, outId, job.layerId);
    var kept = atlasImg.isNull() ? null : keptAtlasCells(env, atlasImg, tiles, paths);
    var packed = kept ? writeAtlasPages(env, atlasImg, prefix, kept) : null;
    if (!packed) {
        env.log.warn("textured layer '" + job.layerName + "' kept flat (atlas pages not saved)");
        return;
    }
    // `rect` places the atlas in world units, once per layer.
    job.atlas = { prefix: prefix, w: atlasW, h: atlasH, size: common.TILE_SIZE,
                  rect: [ux0 / sx - halfW, uy0 / sy - halfH, atlasW / sx, atlasH / sy],
                  cells: packed.cells, order: kept, cellCount: kept.length, pages: packed.pages, tiles: tiles };
    env.counts.texturedStrokes += count;
    env.counts.atlasCells += kept.length;
    env.counts.atlasPages += packed.pages.length;
}

// Splits the atlas into S x S cells (SPEC.md "The model"), edges padded
// transparent (QImage.copy past the edge does that). Keeps a cell if it
// overlaps a tile rect, its rect grown by 1 px touches that contour's
// outline, and it isn't empty. Empty is checked by comparing the PNG bytes
// with an all-padding cell's. Returns [{c, r}] row-major, or null if a save
// failed.
function keptAtlasCells(env, atlas, tiles, paths) {
    var S = common.TILE_SIZE, W = atlas.width(), H = atlas.height();
    var cols = Math.ceil(W / S), rows = Math.ceil(H / S);
    var emptyPath = env.stagingDir + "/raster/empty_cell_" + S + ".png", probe = env.stagingDir + "/raster/cell_probe.png";
    if (!atlas.copy(-2 * S, -2 * S, S, S).save(emptyPath, "PNG")) return null;
    var empty = common.readFileBytes(emptyPath) || [];
    var kept = [], tried = {}, ok = true;
    tiles.forEach(function (t, k) {
        if (!ok || !t || !paths[k]) return;
        var c0 = Math.max(0, Math.floor(t.ax / S)), c1 = Math.min(cols - 1, Math.floor((t.ax + t.aw - 1) / S));
        var r0 = Math.max(0, Math.floor(t.ay / S)), r1 = Math.min(rows - 1, Math.floor((t.ay + t.ah - 1) / S));
        for (var r = r0; r <= r1 && ok; r++) {
            for (var c = c0; c <= c1; c++) {
                var key = c + "_" + r;
                if (tried[key] || !paths[k].intersects(new QRectF(c * S - 1, r * S - 1, S + 2, S + 2))) continue;
                tried[key] = true;
                if (!atlas.copy(c * S, r * S, S, S).save(probe, "PNG")) { ok = false; break; }
                if (new File(probe).size === empty.length && sameBytes(common.readFileBytes(probe), empty)) continue;
                kept.push({ c: c, r: r });
            }
        }
    });
    if (!ok) return null;
    kept.sort(function (a, b) { return a.r - b.r || a.c - b.c; });
    return kept;
}

// Packs the kept cells into pages (SPEC.md "Pages", "Packing") and writes
// images/<prefix>_p<k>.png, one page in memory at a time. Fresh ARGB32
// images so no colour chunks get saved. Returns {cells, pages} or null.
function writeAtlasPages(env, atlas, prefix, kept) {
    var S = common.TILE_SIZE, sizes = common.pageLayout(kept.length, S), cells = {}, i = 0;
    for (var k = 0; k < sizes.length; k++) {
        var page = new QImage(sizes[k].w, sizes[k].h, QImage.Format_ARGB32);
        page.fill(0);
        var p = new QPainter();
        p.begin(page);
        p.setCompositionMode(QPainter.CompositionMode_Source);
        for (; i < kept.length; i++) {
            var at = common.pageSlot(i, S);
            if (at.page !== k) break;
            p.drawImage(at.sx, at.sy, atlas, kept[i].c * S, kept[i].r * S, S, S);
            cells[kept[i].c + "_" + kept[i].r] = at;
        }
        p.end();
        if (!page.save(env.stagingDir + "/" + common.pageEntryName(prefix, k), "PNG")) return null;
    }
    return { cells: cells, pages: sizes };
}

// Any non-zero pixel? Compares the PNG with an all-zero one, much faster
// than reading pixels. `img` must have no colour space or the profile
// differs. True when unsure, so ink is never hidden.
function imageHasInk(env, img) {
    var w = img.width(), h = img.height();
    if (w <= 0 || h <= 0) return false;
    var empty = new QImage(w, h, img.format());
    empty.fill(0);
    var pa = env.stagingDir + "/raster/ink_probe.png", pe = env.stagingDir + "/raster/ink_empty.png";
    if (!img.save(pa, "PNG") || !empty.save(pe, "PNG")) return true;
    return !(new File(pa).size === new File(pe).size && sameBytes(common.readFileBytes(pa), common.readFileBytes(pe)));
}

// imageHasInk on a rect of `src`, copied into a fresh image.
function regionHasInk(env, src, x, y, w, h) {
    var img = new QImage(w, h, QImage.Format_ARGB32);
    img.fill(0);
    var p = new QPainter();
    p.begin(img);
    p.setCompositionMode(QPainter.CompositionMode_Source);
    p.drawImage(-x, -y, src);
    p.end();
    return imageHasInk(env, img);
}

function sameBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

// Contour as a QPainterPath in tile-local render pixels. Default fill rule
// is odd-even. halfW/halfH are half the world size the render covers.
function contourPainterPath(env, contour, px0, py0, sx, sy, halfW, halfH, fillRule) {
    var path = new QPainterPath();
    path.setFillRule(fillRule === undefined ? Qt.OddEvenFill : fillRule);
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

// Rough area in render pixels (shoelace, control points as vertices).
// Good enough for a mean.
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

// Flat fallback [r, g, b, a] of a textured path (SPEC.md "The flat
// fallback"). Brush strokes keep their colour, texture fills take the
// tile's mean colour rounded to 8 bits (so no sboardx:rgba). Alpha is the
// mean coverage. If any ink may show (tile alpha or `inkUnder`), alpha is
// at least 1/255 so 8-bit renderers still draw it (SPEC.md "Ink is never
// hidden").
function textureFallback(col, tileRgba, inkUnder) {
    var out = col.brush ? col.rgb.concat([common.clamp01(tileRgba[3] * col.alpha)])
                        : [0, 1, 2].map(function (i) { return common.to255(tileRgba[i]) / 255; }).concat([tileRgba[3]]);
    if ((tileRgba[3] > 0 || inkUnder) && out[3] < 1 / 255) out[3] = 1 / 255;
    return out;
}

// Mean tile colour [r, g, b, a] in 0..1: alpha-weighted colour, alpha
// averaged over `areaPx`. `img` must be premultiplied ARGB32. Samples a
// 16x16 grid first and reads every pixel only if that finds nothing, since
// thin strokes can slip between samples. `hasInk` (optional) lets an empty
// tile skip the full scan. No ink gives [0, 0, 0, 0].
function tileMeanColor(img, areaPx, hasInk) {
    var w = img.width(), h = img.height();
    var stepX = Math.max(1, Math.floor(w / 16)), stepY = Math.max(1, Math.floor(h / 16));
    var grid = sampledMeanColor(img, areaPx, stepX, stepY);
    if (grid[3] > 0 || (stepX === 1 && stepY === 1)) return grid;
    if (hasInk && !hasInk(img)) return [0, 0, 0, 0];
    return sampledMeanColor(img, areaPx, 1, 1);
}

// tileMeanColor over the pixels every stepX-th column and stepY-th row.
function sampledMeanColor(img, areaPx, stepX, stepY) {
    var w = img.width(), h = img.height();
    var n = 0, r = 0, g = 0, b = 0, a = 0;
    for (var y = 0; y < h; y += stepY) {
        for (var x = 0; x < w; x += stepX) {
            var px = img.pixel(x, y) >>> 0;
            n++;
            r += (px >>> 16) & 255;
            g += (px >>> 8) & 255;
            b += px & 255;
            a += (px >>> 24) & 255;
        }
    }
    if (n === 0 || a <= 0) return [0, 0, 0, 0];
    var sampled = n * stepX * stepY;   // pixels the grid stands for
    var cover = (a * stepX * stepY) / (areaPx > 0 ? Math.min(areaPx, sampled) : sampled);
    return [common.clamp01(r / a), common.clamp01(g / a), common.clamp01(b / a), common.clamp01(cover / 255)];
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
        sboardx: "1.2",
        app: "Toon Boom Storyboard Pro (TB_ExportSboardx)",
        created_at: env.nowIso,
        modified_at: env.nowIso,
        name: common.fileBasename(common.projectDir()) || "Storyboard",
        episode: "",
        canvas: { width: env.frameW, height: env.frameH, resolution: { width: env.resW, height: env.resH }, fps: env.fps }
    };
    // `layer_layout` from the DEFAULT_LAYERS preference.
    var layout = common.parseDefaultLayers(preferences.getString("DEFAULT_LAYERS", ""));
    if (layout.length) projectJson.layer_layout = layout;
    // Bases of unchanged panels (stampIdMap).
    for (var k in env.syncBases) if (env.syncBases.hasOwnProperty(k)) { projectJson.sync = { panels: env.syncBases }; break; }
    common.writeTextFile(env.stagingDir + "/project.json", JSON.stringify(projectJson));
}

// palettes.json (optional): solid colours only, skips the bridge's own palettes.
function writePalettesJson(env) {
    var list = PaletteObjectManager.getScenePaletteList();
    var solid = PaletteObjectManager.Constants.ColorType.SOLID_COLOR;
    var out = [];
    for (var i = 0; i < list.numPalettes; i++) {
        var pal = list.getPaletteByIndex(i);
        if (!pal || !pal.isValid()) continue;
        var name = String(pal.getName());
        if (common.isBridgePalette(name)) continue;
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

// Include images/ whenever anything was staged there, unused shared
// drawings' pages included.
function zipStagingFolder(env) {
    var entries = ["project.json", "sequence.json", "panels", "audio"];
    if (env.counts.rasterLayers > 0 || env.counts.atlasLayers > 0 || env.counts.libraryAtlases > 0) entries.push("images");
    if (env.counts.palettes > 0) entries.push("palettes.json");
    if (env.shared.list.length) entries.push("shared");
    return common.createStoreZip(env.stagingDir, entries, env.zipPath, env.log, env.progress.cancelled);
}

function exportSummary(env) {
    var c = env.counts;
    return "Exported " + c.scenes + " scene(s), " + c.panels + " panel(s), " + (c.layers - c.rasterLayers) + " vector layer(s)" +
           (c.rasterLayers ? " and " + c.rasterLayers + " image layer(s)" : "") +
           (c.nativeLayers ? " (" + c.nativeLayers + " text layer(s) as pictures; an update from this file keeps them as text " +
                             "while Upshot leaves the picture untouched)" : "") +
           (env.shared.list.length ? ", " + env.shared.list.length + " shared drawing(s)" : "") +
           (c.atlasLayers ? ", " + c.texturedStrokes + " textured stroke(s) in " + c.atlasLayers + " atlas(es) of " +
                            c.atlasCells + " " + common.TILE_SIZE + " px cell(s) on " + c.atlasPages + " page(s)" : "") +
           (c.audioClips ? ", " + c.audioClips + " audio clip(s)" : "") +
           " to\n" + env.zipPath + ".";
}

exports.exportToFile = exportToFile;
// Reused by sboardx_import.js and sboardx_merge.js.
exports.makeExportEnv = makeExportEnv;
exports.ownForm = ownForm;
exports.panelFingerprint = panelFingerprint;
exports.finishExchange = finishExchange;
exports.readSceneCamera = readSceneCamera;
exports.readLiveCamera = readLiveCamera;
exports.stampSceneCameras = stampSceneCameras;
exports.tileMeanColor = tileMeanColor;   // for unit tests
exports.textureFallback = textureFallback;   // for unit tests
exports.flatFillAttrs = flatFillAttrs;   // for unit tests
exports.emitLayerSvg = emitLayerSvg;   // for unit tests
exports.drawingReadPath = drawingReadPath;   // used by the import's redraw check
