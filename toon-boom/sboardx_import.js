// sboardx_import.js — the implementation behind TB_ImportSboardx.js, loaded
// via require() so Storyboard Pro's Scripts Manager lists only the entry
// points. Needs sboardx_common.js and sboardx_export.js in the same folder.
// See README.md.

var common = require("./sboardx_common.js");
var exp = require("./sboardx_export.js");

// options: { replaceExisting: bool (the previous scenes are deleted),
//            applyLayerLayout: bool (batch: apply the file's default layers) }
function importFromFile(zipPath, quiet, options) {
    var log = common.makeLog("[sboardx] ", quiet);
    if (!common.requireApi(log)) return false;
    var env = makeImportEnv(log, quiet, options);
    env.progress = common.makeProgress("Importing .sboardx", quiet);
    env.progress.busy("Extracting the archive…");
    if (!extractArchive(env, String(zipPath))) { env.progress.close(); return false; }
    env.progress.busy("Reading the archive…");
    if (!loadSboardx(env)) { env.progress.close(); return false; }

    var preExistingScenes = [];
    for (var i = 0; i < env.sb.numberOfScenesInProject(); i++) preExistingScenes.push(String(env.sb.sceneInProject(i)));

    project.beginUndoRedoAccum("Import sboardx");
    try {
        applyProjectSettings(env);
        env.idMap = common.loadIdMap(env.sb, log);
        env.progress.begin(env.sequenceJson.panels.length);
        importScenes(env);
        env.progress.busy("Creating sequences…");
        importSequences(env);
        env.sb.setProjectMetadata(common.metaRecord("sboardx-source", JSON.stringify(
            { file: zipPath, name: env.projectJson.name, episode: env.projectJson.episode, version: env.projectJson.sboardx })));
        env.progress.busy("Importing palettes…");
        importPalettes(env);
        if (env.options.replaceExisting) {
            env.progress.busy("Removing the previous scenes…");
            preExistingScenes.forEach(function (sid) {
                if (!env.sb.deleteScene(sid)) env.log.warn("could not delete pre-existing scene " + sid);
            });
        }
        env.progress.busy("Importing audio…");
        importAudio(env, globalStartFrameOf(env, env.firstImportedPanel));
        project.endUndoRedoAccum();
    } catch (err) {
        // Cancel and failure both roll the whole import back.
        project.cancelUndoRedoAccum();
        env.progress.close();
        if (err && err.sboardxCancelled) log.report("Import cancelled. The project was not changed.", true);
        else log.report("sboardx import failed: " + err, true);
        return false;
    }
    env.progress.busy("Recording the merge baselines…");
    exp.finishExchange(log, env.idMap, null);
    env.progress.close();
    if (env.firstImportedPanel) env.selMgr.setCurrentPanel(env.firstImportedPanel);
    log.report(log.summary(importSummary(env)), false);
    return true;
}

function makeImportEnv(log, quiet, options) {
    return {
        log: log,
        quiet: !!quiet,
        options: options || {},
        progress: common.makeProgress("", true),
        sb: new StoryboardManager(),
        lm: new LayerManager(),
        cm: new CaptionManager(),
        selMgr: new SelectionManager(),
        mm: new MotionManager(),
        fm: new FunctionManager(),
        extractDir: "",
        projectJson: null,
        sequenceJson: null,
        groups: [],
        fps: 24,
        frameW: 960, frameH: 540, resH: 0,
        fields: null,
        layerLayout: [],
        notesCaption: "",
        dialogueCaption: "",
        firstImportedPanel: "",
        idMap: null,
        scratchPalette: null,
        texturePalette: null,
        atlasCache: {},
        sharedHolders: {},   // archive drawing id -> the panel holding its first import
        sharedNames: null,
        counts: { scenes: 0, panels: 0, layers: 0, imageLayers: 0, blurredLayers: 0, failedLayers: 0,
                  camApplied: 0, groups: 0, animatedLayers: 0, sequences: 0,
                  sharedDrawings: 0, sharedCreated: 0, sharedCopies: 0, palettes: 0 }
    };
}

function extractArchive(env, zipPath) {
    env.extractDir = common.makeTempDir("import");
    new Dir(env.extractDir + "/_tiles").mkdirs();
    if (common.extractZip(zipPath, env.extractDir, env.log)) return true;
    env.log.report("Could not extract the .sboardx archive (see the Message Log).", true);
    return false;
}

function loadSboardx(env) {
    var projectJson = common.readJsonFile(env.extractDir + "/project.json");
    var sequenceJson = common.readJsonFile(env.extractDir + "/sequence.json");
    if (!projectJson || !sequenceJson || !sequenceJson.panels || !sequenceJson.scenes || !sequenceJson.scenes.length) {
        env.log.report("Not a valid .sboardx file (project.json / sequence.json missing).", true);
        return false;
    }
    if (projectJson.sboardx !== "1.0" && projectJson.sboardx !== "1.1") {
        env.log.report("This importer reads sboardx 1.0 and 1.1 archives. This file is sboardx " +
                       (projectJson.sboardx || "unknown") + ".", true);
        return false;
    }
    env.projectJson = projectJson;
    env.sequenceJson = sequenceJson;
    var canvas = projectJson.canvas || {};
    env.fps = canvas.fps || 24;
    env.frameH = canvas.height || 540;
    env.frameW = canvas.width || env.frameH * 16 / 9;
    env.resH = canvas.resolution && canvas.resolution.height ? canvas.resolution.height : 0;
    env.fields = common.cameraFields(env.frameH);
    // The default layer stack (SPEC.md project.json `layer_layout`): offered, never applied silently.
    env.layerLayout = (projectJson.layer_layout || []).filter(function (le) {
        return le && typeof le.name === "string" && le.name && (!le.kind || le.kind === "vector");
    }).map(function (le) {
        return { name: le.name, visible: le.visible !== false, opacity: le.opacity === undefined ? 100 : Number(le.opacity) };
    });
    env.groups = groupScenes(sequenceJson);
    env.log.trace("sboardx " + projectJson.sboardx + " · " + sequenceJson.panels.length + " panels · " +
                  env.groups.length + " scene(s) · " + env.fps + " fps");
    return true;
}

// The archive's scenes as contiguous runs of its panel order.
function groupScenes(sequenceJson) {
    var raw = sequenceJson.scenes, byPanel = {};
    raw.forEach(function (sc, s) { (sc.panels || []).forEach(function (pid) { byPanel[pid] = s; }); });
    var groups = [], prev = -1;
    sequenceJson.panels.forEach(function (pid) {
        var si = byPanel.hasOwnProperty(pid) ? byPanel[pid] : Math.max(prev, 0);
        if (!groups.length || si !== prev) {
            var sc = raw[si] || {};
            groups.push({ srcId: sc.id ? String(sc.id) : "",
                          name: sc.name || ("Scene " + (groups.length + 1)),
                          panels: [], sceneId: "", sbpPanelIds: [],
                          keyframes: sc.camera && sc.camera.keyframes ? sc.camera.keyframes : [],
                          layerTracks: sc.layer_tracks || [] });
        }
        groups[groups.length - 1].panels.push(pid);
        prev = si;
    });
    return groups;
}

function applyProjectSettings(env) {
    if (project.getFrameRate() !== env.fps) project.setFrameRate(env.fps);
    offerLayerLayout(env);
    env.notesCaption = common.ensurePanelCaption(env.cm, "Notes");
    env.dialogueCaption = common.ensurePanelCaption(env.cm, "Dialogue");
}

// The file's default layer stack is a user preference here (Edit >
// Preferences > Layers): applied on an explicit Yes, in batch only with
// options.applyLayerLayout.
function offerLayerLayout(env) {
    if (!env.layerLayout.length) return;
    var wanted = common.formatDefaultLayers(env.layerLayout);
    var current = String(preferences.getString("DEFAULT_LAYERS", ""));
    if (current === wanted) return;
    var names = env.layerLayout.map(function (e) { return e.name; }).join(", ");
    var apply = env.quiet ? !!env.options.applyLayerLayout
        : common.confirm("Default layers", "This file says new panels start with these layers:\n    " + names +
                         "\n\nUse them as Storyboard Pro's default layers for new panels?\n(Edit > Preferences > Layers; " +
                         "your current default is " + (current ? "'" + current.split(";")[0] + "…'" : "empty") + ".)");
    if (apply) preferences.setString("DEFAULT_LAYERS", wanted);
}

// "<name>", "<name> 2", "<name> 3" … against a set of taken names.
function uniqueName(wanted, taken) {
    var name = wanted;
    for (var n = 2; taken[name] && n < 1000; n++) name = wanted + " " + n;
    taken[name] = true;
    return name;
}

// ── Scenes and panels ───────────────────────────────────────────────────────

function importScenes(env) {
    var usedSceneNames = {};
    env.groups.forEach(function (group) {
        var sceneName = uniqueName(group.name, usedSceneNames);
        var sceneId = String(env.sb.appendScene(sceneName) || "");
        if (!sceneId) { env.log.warn("could not create scene '" + sceneName + "', skipping its panels"); return; }
        env.counts.scenes++;
        group.sceneId = sceneId;
        if (group.srcId) env.idMap.scenes[sceneId] = group.srcId;
        var firstPanelId = importScenePanels(env, sceneId, group);
        if (!firstPanelId) return;
        if (group.layerTracks.length) {
            env.progress.busy("Applying layer animation (scene " + group.name + ")…");
            applyLayerTracks(env, sceneId, group);
        }
        if (group.keyframes.length) {
            if (applySceneCamera(env, sceneId, group.keyframes)) env.counts.camApplied++;
            // The camera as exchanged: the merge's baseline.
            common.setPanelMeta(env.sb, firstPanelId, "sboardx-camera", JSON.stringify(group.keyframes));
        }
    });
}

function importScenePanels(env, sceneId, group) {
    var firstPanelId = "", prevPanelId = "";
    group.panels.forEach(function (srcId, p) {
        var meta = common.readJsonFile(env.extractDir + "/panels/" + srcId + "/panel.json");
        if (!meta) { env.log.warn("panel.json missing for " + srcId); group.sbpPanelIds.push(""); return; }
        var token = panelToken(meta, group.name) || String(p + 1);
        if (env.progress.cancelled()) throw { sboardxCancelled: true };
        env.progress.step("Panel " + token + " (scene " + group.name + ")");
        var panelId = createPanelAt(env, sceneId, prevPanelId, token, p === 0);
        if (!panelId) { env.log.warn("could not create panel for " + srcId); group.sbpPanelIds.push(""); return; }
        group.sbpPanelIds.push(panelId);
        prevPanelId = panelId;
        if (!firstPanelId) firstPanelId = panelId;
        if (!env.firstImportedPanel) env.firstImportedPanel = panelId;
        env.counts.panels++;
        fillPanelFromArchive(env, panelId, srcId, meta, false);
        recordPanelInIdMap(env, panelId, srcId);
    });
    return firstPanelId;
}

// A panel after `prevPanel` in `sceneId` (before the scene's first panel
// when none). `reuseBlank`: a fresh scene's default panel is renamed instead
// of inserting beside it. A name Storyboard Pro refuses gets its numbering.
function createPanelAt(env, sceneId, prevPanel, token, reuseBlank) {
    var sb = env.sb;
    if (reuseBlank && sb.numberOfPanelsInScene(sceneId) > 0) {
        var id = String(sb.panelInScene(sceneId, 0));
        if (sb.renamePanel(id, token) !== true) env.log.warn("panel '" + token + "': the scene's first panel could not be renamed");
        return id;
    }
    function insert(name) {
        return String((prevPanel ? sb.insertPanel(true, prevPanel, name)
                                 : sb.insertPanel(false, String(sb.panelInScene(sceneId, 0)), name)) || "");
    }
    var created = insert(token);
    if (!created && token) {
        env.log.warn("panel name '" + token + "' refused by Storyboard Pro; numbered instead");
        created = insert("");
    }
    return created;
}

// Duration, captions and layers of a panel from the (extracted) archive's
// panels/<srcId>/ — a new panel, or (`replace`) one whose layers are dropped
// first. An absent caption clears the field.
function fillPanelFromArchive(env, panelId, srcId, meta, replace) {
    env.sb.setPanelDuration(panelId, Math.max(1, Math.round(meta.dur * env.fps)));
    env.cm.setPanelCaptionText(env.notesCaption, panelId, meta.note ? String(meta.note) : "");
    env.cm.setPanelCaptionText(env.dialogueCaption, panelId, meta.dialogue ? String(meta.dialogue) : "");
    importPanelLayers(env, panelId, srcId, replace);
}

// This import is the exchange: the panel's archive id and digest now (the
// base the archive declares for it when it has one — SPEC.md Merging);
// `local` is stamped by finishExchange.
function recordPanelInIdMap(env, panelId, srcId) {
    var entry = common.newIdEntry(srcId);
    entry.digest = archiveBaseOf(env, srcId) || common.archivePanelDigest(env.extractDir, srcId);
    env.idMap.panels[panelId] = entry;
}

// The base the archive declares for a panel (project.json sync.panels), or "".
function archiveBaseOf(env, srcId) {
    var sync = env.projectJson.sync;
    var v = sync && sync.panels && typeof sync.panels === "object" ? sync.panels[String(srcId)] : null;
    return typeof v == "string" && /^[0-9a-f]{16}$/.test(v) ? v : "";
}

// The panel's number: panel.json `code` is the display code "<scene>-<token>";
// a code without the prefix is the token itself.
function panelToken(meta, sceneName) {
    var code = meta && meta.code !== undefined ? String(meta.code) : "";
    var prefix = sceneName + "-";
    return code.length > prefix.length && code.substring(0, prefix.length) === prefix ? code.substring(prefix.length) : code;
}

// sequence.json "sequences" -> Storyboard Pro sequences: one
// createSequence(first, last) per contiguous run of an entry's scenes,
// renamed to the archive's name (made unique like scene names).
function importSequences(env) {
    var entries = env.sequenceJson.sequences || [];
    if (!entries.length) return;
    var sceneIndex = {}, nativeOf = {};
    for (var i = 0; i < env.sb.numberOfScenesInProject(); i++) sceneIndex[String(env.sb.sceneInProject(i))] = i;
    env.groups.forEach(function (g) { if (g.srcId && g.sceneId) nativeOf[g.srcId] = g.sceneId; });
    // Names already taken, read once (a per-name lookup hung Storyboard Pro).
    var taken = {};
    for (var t = 0; t < env.sb.numberOfSequencesInProject(); t++) {
        taken[String(env.sb.nameOfSequence(env.sb.sequenceInProject(t)) || "")] = true;
    }
    entries.forEach(function (entry) {
        if (!entry || !entry.name || !entry.scenes || !entry.scenes.length) return;
        var runs = [], run = null;
        entry.scenes.forEach(function (srcId) {
            var tbId = nativeOf[String(srcId)];
            if (!tbId || !sceneIndex.hasOwnProperty(tbId)) return;
            if (run && sceneIndex[tbId] === run.lastIndex + 1) { run.last = tbId; run.lastIndex = sceneIndex[tbId]; }
            else { run = { first: tbId, last: tbId, lastIndex: sceneIndex[tbId] }; runs.push(run); }
        });
        if (runs.length > 1) env.log.warn("sequence '" + entry.name + "' lists non-contiguous scenes; created as " + runs.length + " sequences");
        runs.forEach(function (r) {
            try {
                var seqId = String(env.sb.createSequence(r.first, r.last) || "");
                if (!seqId) throw "createSequence refused";
                var name = uniqueName(String(entry.name), taken);
                if (env.sb.renameSequence(seqId, name) !== true) env.log.warn("sequence " + seqId + " could not be named '" + name + "'");
                env.counts.sequences++;
            } catch (e) {
                env.log.warn("sequence '" + entry.name + "' could not be created (" + e + ")");
            }
        });
    });
}

// palettes.json (SPEC.md, optional): each palette becomes (or joins) the
// project palette of the same name; colours missing by name are created as
// solid colours (Storyboard Pro mints its own ids; the bridge matches by
// name on the way back).
function importPalettes(env) {
    var pj = common.readJsonFile(env.extractDir + "/palettes.json");
    if (!pj || !pj.palettes || !pj.palettes.length) return;
    pj.palettes.forEach(function (src, i) {
        var name = src.name ? String(src.name) : ("sboardx " + (i + 1));
        var pal = findOrCreatePalette(name);
        if (!pal) { env.log.warn("palette '" + name + "' could not be created"); return; }
        (src.colors || []).forEach(function (sc, j) {
            var cname = sc.name ? String(sc.name) : ("Color " + (j + 1));
            if (findColor(pal, function (c) { return c.name === cname; })) return;
            try {
                pal.createNewSolidColor(cname, { r: common.to255(sc.r), g: common.to255(sc.g), b: common.to255(sc.b),
                                                 a: common.to255(sc.a === undefined ? 1 : sc.a) });
            } catch (e) {
                env.log.warn("palette '" + name + "': colour '" + cname + "' not created (" + e + ")");
            }
        });
        env.counts.palettes++;
    });
}

function globalStartFrameOf(env, panelId) {
    var frames = 0, found = false;
    common.forEachPanel(env.sb, function (sceneId, pid) {
        if (found) return;
        if (pid === String(panelId)) found = true;
        else frames += env.sb.getPanelDuration(pid);
    });
    return found ? frames : 0;
}

function importSummary(env) {
    var c = env.counts;
    return "Imported " + c.scenes + " scene(s), " + c.panels + " panel(s), " + (c.layers - c.imageLayers) + " vector layer(s)" +
           (c.imageLayers ? " and " + c.imageLayers + " image layer(s)" : "") +
           (c.blurredLayers ? ", " + c.blurredLayers + " blurred layer(s) as bitmaps" : "") +
           (c.failedLayers ? ", " + c.failedLayers + " layer(s) failed" : "") +
           (c.sequences ? ", " + c.sequences + " sequence(s)" : "") +
           sharedDrawingsNote(c) +
           (c.camApplied ? ", " + c.camApplied + " camera move(s)" : "") +
           (c.animatedLayers ? ", " + c.animatedLayers + " animated layer(s)" : "") + ".";
}

function sharedDrawingsNote(c) {
    if (!c.sharedDrawings && !c.sharedCopies) return "";
    return ", " + c.sharedDrawings + " shared drawing(s)" + (c.sharedCreated < c.sharedDrawings ? " (" + (c.sharedDrawings - c.sharedCreated) + " as ordinary layers)" : "") +
           (c.sharedCopies ? ", " + c.sharedCopies + " further holder(s) as plain copies" : "");
}

// ── Cameras and layer animation ─────────────────────────────────────────────

function setEasedKeys(env, id, col, frames, values) {
    var fm = env.fm;
    var velo = fm.functionType(id, col) == "VeloBased";
    frames.forEach(function (f, i) {
        var v = values[i];
        if (velo) { fm.setVeloBasePoint(id, col, f, v); return; }
        var prevSpan = i > 0 ? (f - frames[i - 1]) : 3;
        var nextSpan = i + 1 < frames.length ? (frames[i + 1] - f) : 3;
        fm.setBezierPoint(id, col, f, v, f - prevSpan / 3.0, v, f + nextSpan / 3.0, v, false, "CORNER");
    });
}

// The keys of a camera or a layer: the offset path's points at the keyed
// frames (matched by locked frame, else by index when the counts agree),
// then eased scale and rotation keys.
function writePoseKeys(env, id, cols, frames, xs, ys, scales, rots) {
    var fm = env.fm;
    var nb = fm.numberOfPointsPath3d(id, cols.pos), locked = [];
    for (var q = 0; q < nb; q++) locked.push(fm.pointLockedAtFrame(id, cols.pos, q));
    frames.forEach(function (f, k) {
        var pt = locked.indexOf(f);
        if (pt < 0) pt = locked.indexOf(f + 1);
        if (pt < 0 && nb === frames.length) pt = k;
        if (pt >= 0) fm.setPointPath3d(id, cols.pos, pt, xs[k], ys[k], fm.pointZPath3d(id, cols.pos, pt), 0, 0, 0);
        else env.log.warn("no path point for frame " + f + " on " + id + "; move key skipped");
    });
    setEasedKeys(env, id, cols.sx, frames, scales);
    if (cols.sy) setEasedKeys(env, id, cols.sy, frames, scales);
    setEasedKeys(env, id, cols.rot, frames, rots);
}

// The pan on separate, eased X/Y functions (the 3-D path is linear).
function applyPanEase(env, shotId, frames, xs, ys) {
    var PEG = "Top/Camera-Peg", mm = env.mm, fm = env.fm;
    try {
        if (!mm.setTextAttr(shotId, PEG, "position.separate", 1, "On")) throw "position.separate could not be set";
        [["position.x", "sbx_cam_x", xs], ["position.y", "sbx_cam_y", ys]].forEach(function (axis) {
            var col = mm.getLinkedFunction(shotId, PEG, axis[0]);
            if (!col) {
                mm.addFunction(shotId, axis[1], "BEZIER");
                mm.setLinkedFunction(shotId, PEG, axis[0], axis[1]);
                col = mm.getLinkedFunction(shotId, PEG, axis[0]);
            }
            if (!col) throw "no function for " + axis[0];
            for (var k = fm.numberOfPoints(shotId, col) - 1; k >= 0; k--) fm.clearKeyFrame(shotId, col, fm.pointX(shotId, col, k));
            setEasedKeys(env, shotId, col, frames, axis[2]);
        });
    } catch (e) {
        try { mm.setTextAttr(shotId, PEG, "position.separate", 1, "Off"); } catch (e2) {}
        env.log.warn("camera pan easing failed on shot " + shotId + " (" + e + ") - pan is linear");
    }
}

function applySceneCamera(env, shotId, kfs) {
    if (!kfs.length) return false;
    try {
        var mm = env.mm, fm = env.fm, fields = env.fields;
        var frames = [], kfAt = [];
        kfs.slice().sort(function (a, b) { return a.t - b.t; }).forEach(function (k) {
            var frame = Math.max(1, Math.round(k.t * env.fps) + 1);   // frame 1 is t = 0
            if (frames.length && frames[frames.length - 1] === frame) kfAt[kfAt.length - 1] = k;
            else { frames.push(frame); kfAt.push(k); }
        });
        mm.clearCameraMotion(shotId);
        var sweepCol = mm.linkedCameraFunction(shotId, "position.attr3dpath");
        if (sweepCol) for (var i = fm.numberOfPointsPath3d(shotId, sweepCol) - 1; i >= 0; i--) fm.removePointPath3d(shotId, sweepCol, i);
        frames.forEach(function (f) { mm.addCameraKeyFrame(shotId, f); });
        var cols = { pos: mm.linkedCameraFunction(shotId, "position.attr3dpath"), sx: mm.linkedCameraFunction(shotId, "scale.x"),
                     sy: mm.linkedCameraFunction(shotId, "scale.y"), rot: mm.linkedCameraFunction(shotId, "rotation.anglez") };
        var xs = kfAt.map(function (k) { return k.cx * fields.perWorldX; });
        var ys = kfAt.map(function (k) { return -k.cy * fields.perWorldY; });
        writePoseKeys(env, shotId, cols, frames, xs, ys,
                      kfAt.map(function (k) { return 1.0 / (k.z || 1); }), kfAt.map(function (k) { return -(k.rot || 0); }));
        applyPanEase(env, shotId, frames, xs, ys);
        return true;
    } catch (e) {
        env.log.warn("camera move could not be applied on shot " + shotId + ": " + e);
        return false;
    }
}

// Layer animation (sequence.json "layer_tracks"): per scene, keyed by layer
// or group name, scene-local seconds, continuing across panel cuts. SBP keys
// live per (panel, layer) on real panel frames, so each track is split at
// every cut with sampled boundary keys and applied to every panel holding a
// layer of that name.
function applyLayerTracks(env, sceneId, group) {
    var spans = [], acc = 0;   // panel spans in scene-local seconds
    group.sbpPanelIds.forEach(function (pid) {
        var frames = pid ? env.sb.getPanelDuration(pid) : 0;
        spans.push({ panelId: pid, frames: frames, start: acc, end: acc + frames / env.fps });
        acc += frames / env.fps;
    });
    group.layerTracks.forEach(function (track) {
        if (!track || typeof track.name !== "string" || !track.name) return;
        var isGroup = track.kind === "group";
        if (!isGroup && track.kind !== "layer") return;
        var kfs = (track.keyframes || []).slice().sort(function (a, b) { return a.t - b.t; });
        if (!kfs.length) return;
        var px = track.pivot && typeof track.pivot.x === "number" ? track.pivot.x : 0;
        var py = track.pivot && typeof track.pivot.y === "number" ? track.pivot.y : 0;
        var nodeName = common.sbpNodeName(track.name);
        var applied = 0;
        spans.forEach(function (span) {
            if (!span.panelId || span.frames <= 0) return;
            var li = env.lm.layerIndexFromName(span.panelId, nodeName);
            if (li < 0 || (env.lm.isGroupLayer(span.panelId, li) === true) !== isGroup) return;
            try {
                if (applyTrackToLayer(env, span, li, kfs, px, py)) applied++;
            } catch (e) {
                env.log.warn("animation of '" + track.name + "' not applied on panel " + span.panelId + ": " + e);
            }
        });
        if (!applied) env.log.warn("animation track '" + track.name + "' matched no " + (isGroup ? "group" : "layer") + " in scene " + sceneId);
        env.counts.animatedLayers += applied;
    });
}

function applyTrackToLayer(env, span, li, kfs, px, py) {
    var panelId = span.panelId, mm = env.mm;
    // Frames to key: every keyframe strictly inside the panel plus the
    // panel's first and last frame (sampled), coincident frames collapsed.
    var keyTimes = [span.start, span.end].concat(kfs.filter(function (k) {
        return k.t > span.start + 1e-9 && k.t < span.end - 1e-9;
    }).map(function (k) { return k.t; })).sort(function (a, b) { return a - b; });
    var frames = [], poses = [];
    keyTimes.forEach(function (t) {
        var f = common.panelTimeToFrame(t - span.start, span.frames, env.fps);
        if (frames.length && frames[frames.length - 1] === f) return;
        frames.push(f);
        poses.push(common.layerPoseAt(kfs, t));
    });
    if (poses.every(common.isIdentityPose) && frames.length <= 2) return false;   // identity throughout: left alone

    // The camera's order: enable, add every key, then fetch the function
    // handles (before that they are "" and writes are no-ops).
    try { mm.setLayerAnimated(panelId, li, true); } catch (e0) {}
    try { mm.clearLayerMotion(panelId, li); } catch (e1) {}
    frames.forEach(function (f) { mm.addLayerKeyFrame(panelId, li, f); });
    var cols = { pos: String(mm.linkedLayerFunction(panelId, li, "offset.attr3dpath") || ""),
                 sx: String(mm.linkedLayerFunction(panelId, li, "scale.x") || ""),
                 sy: String(mm.linkedLayerFunction(panelId, li, "scale.y") || ""),
                 rot: String(mm.linkedLayerFunction(panelId, li, "rotation.anglez") || "") };
    if (!cols.pos || !cols.sx || !cols.rot) throw "no animation functions on layer " + li;
    var sbp = poses.map(function (pose) { return common.poseToSbp(pose, px, py, env.fields); });
    writePoseKeys(env, panelId, cols, frames,
                  sbp.map(function (s) { return s.x; }), sbp.map(function (s) { return s.y; }),
                  sbp.map(function (s) { return s.scale; }), sbp.map(function (s) { return s.angle; }));
    // Opacity has no function column: the layer takes the track's opacity at
    // the panel's first frame, times its own.
    var o0 = poses[0].opacity;
    if (Math.abs(o0 - 1) > 1e-6) {
        try { env.lm.setLayerOpacity(panelId, li, Math.round(env.lm.layerOpacity(panelId, li) * o0)); } catch (e2) {}
    }
    return true;
}

// ── Panel layers ────────────────────────────────────────────────────────────

function importPanelLayers(env, panelId, srcId, replace) {
    var layersJson = common.readJsonFile(env.extractDir + "/panels/" + srcId + "/layers.json");
    var layers = layersJson && layersJson.layers ? layersJson.layers : [];
    if (!layers.length && !replace) return 0;

    // The panel's existing layers (a new panel's default stack, or the stack
    // a replacement drops) are parked under temporary names first: Storyboard
    // Pro uniquifies layer names within a panel, so an imported "A" added
    // beside the default "A" came out as "A_1". Survivors get their names back.
    var preexisting = env.lm.numberOfLayers(panelId), parked = [];
    for (var p = 0; p < preexisting; p++) {
        parked.push(String(env.lm.layerName(panelId, p)));
        env.lm.renameLayer(panelId, p, "~sboardx parked " + (p + 1));
    }
    var imported = [];   // top-to-bottom, index-aligned with the panel's stack
    layers.forEach(function (layer, i) {
        if (importOneLayer(env, panelId, srcId, layer, i)) {
            imported.unshift(layer);
            env.counts.layers++;
        } else {
            env.counts.failedLayers++;
            env.log.warn("layer failed to import: " + srcId + "/" + (layer.image && layer.image.file ? layer.image.file : layer.art));
        }
    });
    configureImportedLayers(env, panelId, imported);
    applyLayerGroups(env, panelId, imported);

    // The pre-existing layers sit below the imported stack (imports land at
    // index 0): a plain import drops the empty ones, a replacement all of
    // them. Storyboard Pro keeps a panel's last layer: the loop stops at the
    // first refusal.
    if (imported.length && preexisting) {
        for (var d = env.lm.numberOfLayers(panelId) - 1; d >= imported.length; d--) {
            if (!replace && !env.lm.isEmpty(panelId, d)) continue;
            if (env.lm.deleteLayer(panelId, d) === false) {
                env.log.warn("panel " + panelId + ": old layer " + d + " could not be removed");
                break;
            }
        }
    }
    var total = env.lm.numberOfLayers(panelId);
    for (var s = imported.length; s < total; s++) {
        var old = parked[s - imported.length];
        if (old) env.lm.renameLayer(panelId, s, old);
    }
    return imported.length;
}

// One layer of the archive: an image layer (pre-blurred when it has a blur),
// a blurred vector layer rendered to a bitmap (Storyboard Pro has no layer
// blur), else the vector art. Shared drawings (SPEC.md "shared/"): the
// first holder of an Upshot-born drawing is shared through the Share
// Drawing action after its import; there is no "share with that drawing"
// call, so every later holder is a plain copy.
function importOneLayer(env, panelId, srcId, layer, layerIndex) {
    var name = layer.name ? String(layer.name) : ("Layer " + (layerIndex + 1));
    var blur = typeof layer.blur === "number" && layer.blur > 0 ? layer.blur : 0;
    if (layer.image && layer.image.file) {
        var src = blur ? preBlurredImageLayer(env, srcId, layer, layerIndex) : layer;
        if (!src) { env.log.warn("layer '" + name + "': blur failed - importing the image sharp"); src = layer; }
        if (!importImageAsBitmapLayer(env, panelId, srcId, src, layerIndex)) return false;
        env.counts.imageLayers++;
        if (src !== layer) env.counts.blurredLayers++;
        return true;
    }
    var artPath = env.extractDir + "/panels/" + srcId + "/" + layer.art;
    if (!common.fileExists(artPath)) return false;
    if (blur) {
        var placed = renderBlurredVectorPng(env, layer, artPath, srcId, layerIndex);
        if (placed && importImageAsBitmapLayer(env, panelId, srcId, placed, layerIndex)) {
            env.counts.blurredLayers++;
            return true;
        }
        env.log.warn("layer '" + name + "': blur rasterization failed - importing sharp vector art");
    }
    if (!importSvgAsVectorLayer(env, panelId, artPath, name)) return false;
    if (layer.shared) {
        var holder = env.sharedHolders[layer.shared];
        if (holder) {
            env.counts.sharedCopies++;
            env.log.warn("layer '" + name + "' shares drawing " + layer.shared + " with panel " + holder + " — imported as a copy (share it by hand)");
        } else {
            env.sharedHolders[layer.shared] = String(panelId);
            env.counts.sharedDrawings++;
            // A Toon Boom-born drawing (lowercase id) already exists in this project.
            if (/^sd-[0-9A-F]{8}$/.test(String(layer.shared)) &&
                shareDrawing(env, panelId, 0, sharedDrawingNameFor(env, layer.shared) || name)) env.counts.sharedCreated++;
        }
    }
    return true;
}

function sharedDrawingNameFor(env, id) {
    if (!env.sharedNames) {
        env.sharedNames = {};
        var idx = common.readJsonFile(env.extractDir + "/shared/index.json");
        ((idx && idx.drawings) || []).forEach(function (d) { if (d && d.id) env.sharedNames[String(d.id)] = String(d.name || ""); });
    }
    return env.sharedNames[String(id)] || "";
}

// Shares a layer's drawing through the application action
// (`onActionShareDrawing`; the scripting classes have no call for it). The
// shared drawing takes the layer's name, so the layer wears the drawing's
// name while it is shared.
function shareDrawing(env, panelId, layerIndex, drawingName) {
    var layerName = String(env.lm.layerName(panelId, layerIndex));
    try {
        env.selMgr.setCurrentPanel(panelId);
        if (drawingName !== layerName) env.lm.renameLayer(panelId, layerIndex, drawingName);
        env.selMgr.setLayerSelection([{ name: String(env.lm.layerName(panelId, layerIndex)), panelId: String(panelId) }]);
        var v = Action.validate("onActionShareDrawing");
        if (v && typeof v == "object" && v.enabled === false) throw "the Share Drawing action is disabled here";
        Action.perform("onActionShareDrawing");
        return env.lm.isShared(panelId, layerIndex) === true;
    } catch (e) {
        env.log.warn("share drawing '" + drawingName + "' failed: " + e + "; left as a plain layer");
        return false;
    } finally {
        if (drawingName !== layerName) env.lm.renameLayer(panelId, layerIndex, layerName);
    }
}

// Names (Upshot's " copy" rule for a duplicate within one panel, bottom-up
// so the lower layer keeps its name), opacity, visibility and lock.
function configureImportedLayers(env, panelId, entries) {
    var used = {}, names = [];
    for (var b = entries.length - 1; b >= 0; b--) {
        var want = String(entries[b].name);
        while (used[want]) want += " copy";
        used[want] = true;
        names[b] = want;
    }
    entries.forEach(function (src, k) {
        env.lm.renameLayer(panelId, k, names[k]);
        try {
            if (src.visible === false) env.lm.setLayerVisible(panelId, k, false);
            if (src.locked === true) env.lm.setLayerLock(panelId, k, true);
            if (src.opacity !== undefined) env.lm.setLayerOpacity(panelId, k, src.opacity);   // needs a session
        } catch (e) {
            env.log.warn("layer '" + src.name + "': visibility/lock/opacity not applied (" + e + ")");
        }
    });
}

// Layer groups (layers.json "group": a folder = a contiguous run of layers
// sharing the name). Storyboard Pro group layers are entries in the flat
// layer index, so every structural call shifts indices — members are
// re-resolved by name after each one.
function applyLayerGroups(env, panelId, entries) {
    var i = 0;
    while (i < entries.length) {
        var g = entries[i].group ? String(entries[i].group) : "";
        if (!g) { i++; continue; }
        var run = [];
        while (i < entries.length && String(entries[i].group || "") === g) run.push(String(entries[i++].name));
        try {
            var lm = env.lm;
            var index = function (name) { return lm.layerIndexFromName(panelId, common.sbpNodeName(name)); };
            var firstIdx = index(run[0]);
            if (firstIdx < 0) throw "member '" + run[0] + "' not found";
            if (!lm.addGroupLayer(panelId, firstIdx, true, g)) throw "could not be created";
            run.forEach(function (member) {
                var li = index(member), groupIdx = index(g);
                if (li < 0 || groupIdx < 0) throw "member '" + member + "' not found";
                lm.moveLayerInGroup(panelId, li, groupIdx);   // appends at the end: top-to-bottom keeps the order
            });
            env.counts.groups++;
        } catch (e) {
            env.log.warn("group '" + g + "' not applied: " + e);
        }
    }
}

// ── Vector art ──────────────────────────────────────────────────────────────

// The SVG text is the format's contract for fill-opacity / stroke-opacity,
// gradient and pattern fills, so its <path> tags (parsePaintHints) correct
// the parser's primitives by index. Storyboard Pro's parseSVG drops every
// pattern-filled path: it gets a flattened copy where each such path is
// filled with its sboardx:rgba colour and followed by its atlas tile as an
// <image> — the parser reports the image as a texture primitive whose matrix
// is the placement the shader needs (adoptImageTwins moves it onto the path).
function importSvgAsVectorLayer(env, panelId, svgPath, layerName) {
    var layerAdded = false;
    try {
        var svgText = common.readTextFile(svgPath) || "";
        var hints = parsePaintHints(svgText);
        var parsePath = svgPath, hasPatterns = false;
        for (var pid in hints.patterns) {
            if (!hints.patterns.hasOwnProperty(pid)) continue;
            hasPatterns = true;
            hints.patterns[pid].tile = atlasTileTexture(env, common.fileDirname(svgPath), hints.patterns[pid]);
        }
        if (hasPatterns) {
            var flat = flattenPatternFills(svgText, hints);
            if (flat) {
                parsePath = env.extractDir + "/_tiles/" + common.fileBasename(svgPath) + ".flat.svg";
                common.writeTextFile(parsePath, flat);
            }
        }
        var data = importer.parseSVG({ filename: parsePath });
        if (!data || !data.pages || !data.pages.length) {
            env.log.trace("importer.parseSVG returned no pages for " + parsePath);
            return false;
        }
        if (hasPatterns) adoptImageTwins(data);
        env.selMgr.setCurrentPanel(panelId);
        env.lm.addVectorLayer(panelId, 0, true, String(layerName));
        layerAdded = true;
        env.selMgr.setLayerSelection([{ name: env.lm.layerName(panelId, 0), panelId: panelId }]);
        Tools.createDrawing({ allFrames: true });
        drawSvgPage(env, data.pages[0], data.textures, hints);
        return true;
    } catch (e) {
        env.log.trace("vector import failed for " + svgPath + ": " + e);
        if (layerAdded) { try { env.lm.deleteLayer(panelId, 0); } catch (e2) {} }
        return false;
    }
}

// Every texture primitive (an <image> twin) hands its matrix to the path
// primitive before it and is dropped, so the primitive count equals the
// <path> count again.
function adoptImageTwins(data) {
    var page = data.pages[0], kept = [];
    (page.primitives || []).forEach(function (p) {
        var prev = kept.length ? kept[kept.length - 1] : null;
        if (p && p.textureName && data.textures && data.textures[p.textureName] && prev && !prev.sbxTwin) {
            prev.sbxTwin = { matrix: p.matrix };
            return;
        }
        kept.push(p);
    });
    page.primitives = kept;
}

// The art SVG with every pattern fill made flat (fill + fill-opacity from
// sboardx:rgba) followed by its tile as an <image> at the pattern rect, and
// the <pattern> definitions removed; null when nothing had to change.
function flattenPatternFills(text, hints) {
    var changed = false;
    var out = String(text).replace(/<path\b[^>]*>/g, function (tag) {
        var url = /^url\(#([^)]+)\)/.exec(attrOf(tag, "fill") || "");
        var pat = url ? hints.patterns[url[1]] : null;
        if (!pat) return tag;
        var rgba = tagRgba(tag) || [0, 0, 0, 1];
        changed = true;
        var flatTag = tag.replace(/\sfill="[^"]*"/, ' fill="' + common.colorHex({ r: rgba[0] * 255, g: rgba[1] * 255, b: rgba[2] * 255 }) +
                                                     '" fill-opacity="' + rgba[3] + '"')
                         .replace(/\sfill-opacity="[^"]*"(?=.*fill-opacity=)/, "");
        if (pat.tile) {
            flatTag += '<image x="' + pat.x + '" y="' + pat.y + '" width="' + pat.w + '" height="' + pat.h +
                       '" preserveAspectRatio="none" sboardx:twin="' + url[1] + '" xlink:href="' + common.fileBasename(pat.tile.textureFile) + '"/>';
        }
        return flatTag;
    });
    if (!changed) return null;
    out = out.replace(/<pattern\b[^>]*>[\s\S]*?<\/pattern>/g, "");
    if (out.indexOf("xmlns:xlink=") < 0) out = out.replace(/<svg\b/, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
    return out;
}

function drawSvgPage(env, page, textures, hints) {
    var palette = scratchPalette(env);
    var before = colorIdSet(palette), tracked = {};
    var xf = pageTransform(page.mediaBox);
    var prims = page.primitives || [];
    // One primitive per <path> is what every sboardx writer emits: when the
    // counts agree the text's paint hints apply by index, else the parser's
    // paints stand.
    var applyHints = hints.paths.length === prims.length;
    if (!applyHints && hints.paths.length) env.log.trace("paint hints skipped: " + hints.paths.length + " <path> tags vs " + prims.length + " primitives");
    var layers = [];
    prims.forEach(function (p, i) {
        if (applyHints) applyPaintHint(env, p, hints.paths[i], hints.gradients, hints.patterns);
        var layer = buildPrimitiveLayer(env, p, textures, xf, palette, tracked);
        if (layer) layers.push(layer);
    });
    if (layers.length) {
        DrawingTools.createLayers({ label: "sboardx vector import", drawing: Tools.getToolSettings().currentDrawing,
                                    art: 2, layers: layers, masks: [] });
    }
    // The scratch colours this drawing created are released: the drawing keeps its own copy of the paint.
    for (var id in tracked) if (tracked.hasOwnProperty(id) && !before[id]) palette.removeColor(id);
    return layers.length;
}

// The parser's page (y up over its mediaBox) -> drawing units: 5000 units
// over the page height, centred.
function pageTransform(mediaBox) {
    var scale = 5000 / (mediaBox[3] - mediaBox[1]);
    return { scale: scale, tx: -scale * (mediaBox[2] + mediaBox[0]) / 2, ty: -scale * (mediaBox[3] + mediaBox[1]) / 2 };
}

function transformPrimitivePoints(prim, xf) {
    var polygon = true;
    (prim.paths || []).forEach(function (sub) {
        sub.forEach(function (pt) {
            pt.x = pt.x * xf.scale + xf.tx;
            pt.y = pt.y * xf.scale + xf.ty;
            if (!pt.onCurve) polygon = false;
        });
    });
    return polygon;
}

function transformedShaderMatrix(m, xf) {
    return { ox: m.ox * xf.scale + xf.tx, oy: m.oy * xf.scale + xf.ty,
             xx: m.xx * xf.scale, xy: m.xy * xf.scale, yx: m.yx * xf.scale, yy: m.yy * xf.scale };
}

function buildPrimitiveLayer(env, p, textures, xf, palette, tracked) {
    if (!p.fill && !p.stroke) return null;
    var polygon = transformPrimitivePoints(p, xf);
    var shaderColorId = "0000000000000003", shaderMatrix = null;
    if (p.fill) {
        var texEntry = p.textureName && textures && textures[p.textureName] ? textures[p.textureName] : null;
        var tile = p.sbxTexture ? p.sbxTexture.pattern.tile : null;
        var grad = texEntry ? null : gradientSpecOf(p);
        if (tile && p.sbxTwin) {
            // Textured stroke: the atlas tile as a texture colour of the
            // persistent Upshot_textures palette (the drawing references it,
            // so it is never released), placed by the parser's own matrix
            // for the tile's <image> twin.
            shaderColorId = resolveTextureColorId(texturePalette(env), tile, null);
            shaderMatrix = transformedShaderMatrix(p.sbxTwin.matrix, xf);
        } else if (texEntry) {
            shaderColorId = resolveTextureColorId(palette, texEntry, tracked);
            shaderMatrix = transformedShaderMatrix(p.matrix, xf);
        } else if (grad) {
            // A gradient palette colour plus the shape's shader matrix; the
            // first stop when the colour could not be created.
            var gid = resolveGradientColorId(env, palette, grad, tracked);
            if (gid !== null) { shaderColorId = gid; shaderMatrix = gradientShaderMatrix(grad, p, xf); }
            else shaderColorId = resolveSolidColorId(palette, p.fillColor, tracked);
        } else {
            shaderColorId = resolveSolidColorId(palette, p.fillColor, tracked);
        }
    }
    var strokes = [];
    (p.paths || []).forEach(function (path) {
        if (p.fill) strokes.push({ polygon: polygon, shaderLeft: 0, stroke: true, path: path });
    });
    if (p.stroke) {
        var pencilId = resolveSolidColorId(palette, p.strokeColor, tracked);
        (p.paths || []).forEach(function (path) {
            strokes.push({ polygon: polygon, thickness: { constant: p.thickness * xf.scale }, pencilColorId: pencilId, path: path });
        });
    }
    return strokes.length ? { shaders: [{ colorId: shaderColorId, matrix: shaderMatrix }], layerType: 10001, strokes: strokes } : null;
}

// ── Paint hints from the SVG text (sboardx 1.1) ─────────────────────────────

// Per <path> tag in document order: the fill attribute, the alphas (the
// smaller of the parser's and the text's wins — idempotent when the parser
// honoured the attribute), a `url(#id)` gradient or pattern reference, the
// sboardx:rgba fallback, the path data. Tolerant: a malformed attribute
// leaves the parser's value in place.
function parsePaintHints(svgText) {
    var text = String(svgText || "");
    var hints = { paths: [], gradients: parseSvgGradients(text), patterns: parseSvgPatterns(text) };
    (text.match(/<path\b[^>]*>/g) || []).forEach(function (tag) {
        var fill = attrOf(tag, "fill");
        var h = { fill: fill, fillAlpha: null, strokeAlpha: null, gradientId: null, patternId: null,
                  rgba: tagRgba(tag), bbox: null, d: attrOf(tag, "d") };
        if (fill && fill !== "none") {
            var url = /^url\(#([^)]+)\)/.exec(fill);
            if (url && hints.patterns[url[1]]) {
                h.patternId = url[1];
                h.fillAlpha = h.rgba ? h.rgba[3] : null;
            } else if (url) {
                h.gradientId = url[1];
                if (h.d) h.bbox = bboxOfPathData(h.d);
                var fo = parseFloat(attrOf(tag, "fill-opacity"));
                if (isFinite(fo)) h.fillAlpha = common.clamp01(fo);   // third-party: scales the stops
            } else {
                h.fillAlpha = tagAlpha(tag, "fill-opacity");
            }
        }
        var stroke = attrOf(tag, "stroke");
        if (stroke && stroke !== "none") h.strokeAlpha = tagAlpha(tag, "stroke-opacity");
        hints.paths.push(h);
    });
    return hints;
}

// <pattern> definitions keyed by id (SPEC.md "Textured strokes"): the tile in
// user space (x y width height), the viewBox (the tile's pixel rect in the
// atlas) and the atlas image's href. Other pattern forms are not recognised
// (the path then imports in its sboardx:rgba colour).
function parseSvgPatterns(text) {
    var out = {};
    var re = /<pattern\b([^>]*)>([\s\S]*?)<\/pattern>/g, m;
    while ((m = re.exec(text)) !== null) {
        var attrs = m[1], id = attrOf(attrs, "id");
        var vb = String(attrOf(attrs, "viewBox") || "").replace(/^\s+|\s+$/g, "").split(/[\s,]+/);
        var img = /<image\b([^>]*)\/?>/.exec(m[2]);
        var href = img ? (attrOf(img[1], "href") || attrOf(img[1], "xlink:href")) : null;
        if (!id || !href || vb.length !== 4) continue;
        var pat = { x: parseFloat(attrOf(attrs, "x")), y: parseFloat(attrOf(attrs, "y")),
                    w: parseFloat(attrOf(attrs, "width")), h: parseFloat(attrOf(attrs, "height")),
                    ax: parseFloat(vb[0]), ay: parseFloat(vb[1]), aw: parseFloat(vb[2]), ah: parseFloat(vb[3]), href: href };
        var ok = pat.w > 0 && pat.h > 0 && pat.aw > 0 && pat.ah > 0;
        for (var k in pat) if (pat.hasOwnProperty(k) && k !== "href" && !isFinite(pat[k])) ok = false;
        if (ok) out[id] = pat;
    }
    return out;
}

function attrOf(tag, name) {
    var m = new RegExp("(?:^|\\s)" + name.replace(/[.:-]/g, "\\$&") + "=\"([^\"]*)\"").exec(tag);
    return m ? m[1] : null;
}

// sboardx:rgba as [r, g, b, a] in 0..1, or null.
function tagRgba(tag) {
    var parts = String(attrOf(tag, "sboardx:rgba") || "").replace(/^\s+|\s+$/g, "").split(/\s+/).map(parseFloat);
    return parts.length === 4 && parts.every(isFinite) ? parts.map(common.clamp01) : null;
}

// A path's paint alpha: sboardx:rgba's 4th number, else the opacity attribute, else null.
function tagAlpha(tag, opacityAttr) {
    var rgba = tagRgba(tag);
    if (rgba) return rgba[3];
    var o = parseFloat(attrOf(tag, opacityAttr));
    return isFinite(o) ? common.clamp01(o) : null;
}

// "#rrggbb" / "#rgb" as [r, g, b] in 0..1, or null.
function parseHexColor(s) {
    var m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(String(s || ""));
    if (!m) return null;
    var h = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
    return [parseInt(h.substring(0, 2), 16) / 255, parseInt(h.substring(2, 4), 16) / 255, parseInt(h.substring(4, 6), 16) / 255];
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

// <linearGradient>/<radialGradient> definitions keyed by id: SPEC.md
// "Gradient fills" (Upshot's unit space + gradientTransform) and the common
// third-party forms (objectBoundingBox, explicit coordinates, transform
// lists, style stops, one level of href stop inheritance).
function parseSvgGradients(text) {
    var out = {};
    var re = /<(linearGradient|radialGradient)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g, m;
    while ((m = re.exec(text)) !== null) {
        var attrs = m[2], id = attrOf(attrs, "id");
        if (!id) continue;
        out[id] = {
            type: m[1] === "radialGradient" ? "radial" : "linear",
            units: attrOf(attrs, "gradientUnits") || "objectBoundingBox",
            transform: parseTransformList(attrOf(attrs, "gradientTransform")),
            x1: attrOf(attrs, "x1"), y1: attrOf(attrs, "y1"), x2: attrOf(attrs, "x2"), y2: attrOf(attrs, "y2"),
            cx: attrOf(attrs, "cx"), cy: attrOf(attrs, "cy"), r: attrOf(attrs, "r"),
            href: (attrOf(attrs, "href") || attrOf(attrs, "xlink:href") || "").replace(/^#/, ""),
            stops: ((m[3] || "").match(/<stop\b[^>]*>/g) || []).map(parseStop).filter(Boolean)
        };
    }
    for (var k in out) {
        if (out.hasOwnProperty(k) && !out[k].stops.length && out[k].href && out[out[k].href]) out[k].stops = out[out[k].href].stops.slice();
    }
    return out;
}

// A stop as {r,g,b,a} in 0..1 plus t (offset 0..1).
function parseStop(tag) {
    var offset = attrOf(tag, "offset") || "0";
    var t = /%$/.test(offset) ? parseFloat(offset) / 100 : parseFloat(offset);
    var color = attrOf(tag, "stop-color"), opacity = attrOf(tag, "stop-opacity");
    var style = attrOf(tag, "style");
    if (style) {
        var sc = /stop-color\s*:\s*([^;]+)/.exec(style), so = /stop-opacity\s*:\s*([^;]+)/.exec(style);
        if (sc && !color) color = sc[1].replace(/^\s+|\s+$/g, "");
        if (so && opacity === null) opacity = so[1].replace(/^\s+|\s+$/g, "");
    }
    var rgba = tagRgba(tag);
    if (!rgba) {
        var rgb = parseHexColor(color) || [0, 0, 0];
        var op = parseFloat(opacity);
        rgba = rgb.concat([isFinite(op) ? common.clamp01(op) : 1]);
    }
    return { r: rgba[0], g: rgba[1], b: rgba[2], a: rgba[3], t: isFinite(t) ? common.clamp01(t) : 0 };
}

// matrix | translate | scale | rotate lists, composed left to right as SVG
// does; null when absent or unreadable.
function parseTransformList(text) {
    if (!text) return null;
    var re = /(matrix|translate|scale|rotate)\s*\(([^)]*)\)/g;
    var acc = [1, 0, 0, 1, 0, 0], any = false, m;
    while ((m = re.exec(text)) !== null) {
        var v = m[2].split(/[\s,]+/).filter(function (s) { return s.length; }).map(parseFloat);
        if (!v.every(isFinite)) return null;
        var t;
        if (m[1] === "matrix" && v.length === 6) t = v;
        else if (m[1] === "translate") t = [1, 0, 0, 1, v[0] || 0, v.length > 1 ? v[1] : 0];
        else if (m[1] === "scale") t = [v[0], 0, 0, v.length > 1 ? v[1] : v[0], 0, 0];
        else if (m[1] === "rotate") {
            var rad = (v[0] || 0) * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
            t = [c, s, -s, c, 0, 0];
            if (v.length === 3) t = composeAffine(composeAffine([1, 0, 0, 1, -v[1], -v[2]], t), [1, 0, 0, 1, v[1], v[2]]);
        } else return null;
        acc = composeAffine(t, acc);   // SVG: the rightmost transform applies first
        any = true;
    }
    return any ? acc : null;
}

// "first then second": the point goes through `first`, then `second`.
function composeAffine(first, second) {
    return [first[0] * second[0] + first[1] * second[2], first[0] * second[1] + first[1] * second[3],
            first[2] * second[0] + first[3] * second[2], first[2] * second[1] + first[3] * second[3],
            first[4] * second[0] + first[5] * second[2] + second[4], first[4] * second[1] + first[5] * second[3] + second[5]];
}

// A length attribute of a gradient: number, or a percentage of `extent`.
function gradLen(v, fallback, extent) {
    if (v === null || v === undefined) return fallback;
    var n = parseFloat(String(v));
    if (!isFinite(n)) return fallback;
    return /%$/.test(String(v)) ? n / 100 * extent : n;
}

// Unit gradient space -> the SVG's user space (SPEC.md "Gradient fills"):
// linear = the (0,0)->(1,0) segment, radial = the unit circle. Composes the
// canonical frame, gradientTransform and the objectBoundingBox frame.
function gradientUnitAffine(g, bbox, viewW, viewH) {
    var obb = g.units !== "userSpaceOnUse";
    var ew = obb ? 1 : viewW, eh = obb ? 1 : viewH, L;
    if (g.type === "linear") {
        var x1 = gradLen(g.x1, 0, ew), y1 = gradLen(g.y1, 0, eh), x2 = gradLen(g.x2, ew, ew), y2 = gradLen(g.y2, 0, eh);
        L = [x2 - x1, y2 - y1, -(y2 - y1), x2 - x1, x1, y1];
    } else {
        var cx = gradLen(g.cx, 0.5 * ew, ew), cy = gradLen(g.cy, 0.5 * eh, eh), r = gradLen(g.r, 0.5 * ew, ew);
        L = [r, 0, 0, r, cx, cy];
    }
    var M = g.transform ? composeAffine(L, g.transform) : L;
    if (!obb) return M;
    return bbox ? composeAffine(M, [bbox.maxX - bbox.minX, 0, 0, bbox.maxY - bbox.minY, bbox.minX, bbox.minY]) : null;
}

function applyPaintHint(env, p, h, gradients, patterns) {
    if (!p || !h) return;
    if (h.patternId && patterns[h.patternId]) {
        // Textured stroke: the text is the contract — the atlas tile
        // (buildPrimitiveLayer), flat sboardx:rgba otherwise.
        p.fill = true;
        p.sbxTexture = { pattern: patterns[h.patternId], rgba: h.rgba };
        if (h.rgba) p.fillColor = { r: h.rgba[0], g: h.rgba[1], b: h.rgba[2], a: h.rgba[3] };
        else if (!p.fillColor || typeof p.fillColor.r !== "number") p.fillColor = { r: 0, g: 0, b: 0, a: 1 };
        return;
    }
    var g = p.fill && h.gradientId ? gradients[h.gradientId] : null;
    if (g && g.stops.length >= 2) {
        var stops = g.stops.map(function (s) { return { r: s.r, g: s.g, b: s.b, a: h.fillAlpha !== null ? s.a * h.fillAlpha : s.a, t: s.t }; });
        p.sbxGradient = { type: g.type, stops: stops, affine: gradientUnitAffine(g, h.bbox, env.frameW, env.frameH) };
        p.fillColor = { r: stops[0].r, g: stops[0].g, b: stops[0].b, a: stops[0].a };
        return;
    }
    if (g && g.stops.length === 1) {
        p.fillColor = { r: g.stops[0].r, g: g.stops[0].g, b: g.stops[0].b, a: g.stops[0].a };
        return;
    }
    if (p.fill && p.fillColor && h.fillAlpha !== null && !p.fillColor.hasOwnProperty("gradient")) {
        p.fillColor.a = Math.min(typeof p.fillColor.a === "number" ? p.fillColor.a : 1, h.fillAlpha);
    }
    if (p.stroke && p.strokeColor && h.strokeAlpha !== null) {
        p.strokeColor.a = Math.min(typeof p.strokeColor.a === "number" ? p.strokeColor.a : 1, h.strokeAlpha);
    }
}

// The gradient a primitive is filled with: the text's definition first (it
// carries stop alpha and the unit affine), else the parser's `gradient`
// array. null for a flat fill.
function gradientSpecOf(p) {
    if (p.sbxGradient && p.sbxGradient.stops.length >= 2) return p.sbxGradient;
    var c = p.fillColor;
    if (!c || !c.hasOwnProperty("gradient") || !c.gradient || c.gradient.length < 2) return null;
    var stops = c.gradient.map(function (s, i) {
        return { r: s.r, g: s.g, b: s.b, a: typeof s.a === "number" ? s.a : 1, t: typeof s.t === "number" ? s.t : i / (c.gradient.length - 1) };
    });
    return { type: String(c.gradientType || "").toLowerCase().indexOf("radial") >= 0 ? "radial" : "linear",
             stops: stops, affine: null, parserMatrix: c.gradientMatrix || p.matrix || null };
}

// The shape's shader matrix for a gradient colour, in page space: the
// parser's own matrix when it gave one, else the gradient fitted to the
// primitive's page-space bounds at the text affine's angle (Upshot's own
// placement rule).
function gradientShaderMatrix(grad, p, xf) {
    if (grad.parserMatrix) return transformedShaderMatrix(grad.parserMatrix, xf);
    var bb = primitiveBounds(p);
    if (!bb) return null;
    var w = bb.maxX - bb.minX, h = bb.maxY - bb.minY;
    var cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
    if (grad.type === "radial") return { ox: cx, oy: cy, xx: w / 2, xy: 0, yx: 0, yy: h / 2 };
    var angle = grad.affine ? -Math.atan2(grad.affine[1], grad.affine[0]) : 0;   // y flipped page space
    var c = Math.cos(angle), s = Math.sin(angle);
    var e = (Math.abs(w * c) + Math.abs(h * s)) / 2, len = Math.max(2 * e, 1e-6);
    return { ox: cx - e * c, oy: cy - e * s, xx: len * c, xy: len * s, yx: -len * s, yy: len * c };
}

function primitiveBounds(p) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    (p.paths || []).forEach(function (sub) {
        sub.forEach(function (pt) {
            if (pt.x < minX) minX = pt.x; if (pt.x > maxX) maxX = pt.x;
            if (pt.y < minY) minY = pt.y; if (pt.y > maxY) maxY = pt.y;
        });
    });
    return isFinite(minX) ? { minX: minX, minY: minY, maxX: maxX, maxY: maxY } : null;
}

// ── Palettes and colours ────────────────────────────────────────────────────

// The project palette named `baseName`, or an earlier run's "<baseName>_N"
// copy (Storyboard Pro numbers a re-created palette), created when absent.
function findOrCreatePalette(baseName) {
    var list = PaletteObjectManager.getScenePaletteList();
    var re = new RegExp("^" + baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(_\\d+)?$");
    for (var i = 0; i < list.numPalettes; i++) {
        var pal = list.getPaletteByIndex(i);
        if (pal && pal.isValid() && re.test(common.fileBasename(String(pal.getName())))) return pal;
    }
    return list.createPalette("palette-library/" + common.sbpNodeName(baseName), 0) || null;
}

// The scratch palette: solid and gradient colours created per drawing and
// released after it.
function scratchPalette(env) {
    if (!env.scratchPalette || !env.scratchPalette.isValid()) env.scratchPalette = findOrCreatePalette("sboardx");
    return env.scratchPalette;
}

// The persistent palette textured strokes land in.
function texturePalette(env) {
    if (!env.texturePalette || !env.texturePalette.isValid()) env.texturePalette = findOrCreatePalette("Upshot_textures");
    return env.texturePalette;
}

// The first colour of the palette that `test` accepts, or null.
function findColor(palette, test) {
    for (var i = 0; i < palette.nColors; i++) {
        var c = palette.getColorByIndex(i);
        if (c && c.isValid && test(c)) return c;
    }
    return null;
}

function colorIdSet(palette) {
    var ids = {};
    findColor(palette, function (c) { ids[c.id] = true; return false; });
    return ids;
}

function resolveSolidColorId(palette, color, tracked) {
    var stop = color.hasOwnProperty("gradient") ? color.gradient[0] : color;
    var r = common.to255(stop.r), g = common.to255(stop.g), b = common.to255(stop.b);
    var a = color.hasOwnProperty("gradient") ? 255 : common.to255(color.a === undefined ? 1 : color.a);
    var solid = PaletteObjectManager.Constants.ColorType.SOLID_COLOR;
    var found = findColor(palette, function (c) {
        return !c.isTexture && c.colorType === solid && c.colorData &&
               c.colorData.r === r && c.colorData.g === g && c.colorData.b === b && c.colorData.a === a;
    });
    var id = found ? found.id : palette.createNewSolidColor("Color_r_" + r + "_g_" + g + "_b_" + b + "_a_" + a, { r: r, g: g, b: b, a: a }).id;
    tracked[id] = true;
    return id;
}

function resolveTextureColorId(palette, tex, tracked) {
    var name = "Texture_uid_" + tex.textureHash;
    var found = findColor(palette, function (c) { return c.isTexture && c.name === name; });
    var id = found ? found.id : palette.createNewTexture(name, tex.textureFile, false).id;
    if (tracked) tracked[id] = true;
    return id;
}

// A gradient palette colour (colorData = [{r,g,b,a,t}], 8-bit ints with t
// 0..1), named after its stops; null when it could not be created.
function resolveGradientColorId(env, palette, grad, tracked) {
    var fn = grad.type === "radial" ? "createNewRadialGradientColor" : "createNewLinearGradientColor";
    var data = grad.stops.map(function (s) {
        return { r: common.to255(s.r), g: common.to255(s.g), b: common.to255(s.b), a: common.to255(s.a), t: Math.round(s.t * 1000) / 1000 };
    });
    var name = "Gradient_" + common.fnv32Hex(grad.type + data.map(function (st) { return "_" + st.r + "_" + st.g + "_" + st.b + "_" + st.a + "_" + st.t; }).join(""));
    var found = findColor(palette, function (c) { return !c.isTexture && c.name === name; });
    var id = found ? found.id : null;
    if (id === null) {
        try { id = palette[fn](name, data).id; }
        catch (e) { env.log.warn("gradient colour creation failed (" + e + "); using the first stop"); return null; }
    }
    tracked[id] = true;
    return id;
}

// The atlas tile of a pattern as a PNG a texture colour is created from
// ({textureHash, textureFile}); null when the atlas is unusable (the path
// then imports in its flat sboardx:rgba colour).
function atlasTileTexture(env, svgDir, pat) {
    var atlasPath = normalizePath(svgDir + "/" + pat.href);
    var img = env.atlasCache[atlasPath];
    if (img === undefined) {
        img = common.fileExists(atlasPath) ? new QImage(atlasPath) : null;
        if (img && img.isNull()) img = null;
        if (!img) env.log.warn("atlas missing or unreadable for a textured stroke: " + atlasPath);
        env.atlasCache[atlasPath] = img;
    }
    if (!img) return null;
    var ax = Math.round(pat.ax), ay = Math.round(pat.ay), aw = Math.round(pat.aw), ah = Math.round(pat.ah);
    if (aw <= 0 || ah <= 0 || ax < 0 || ay < 0 || ax + aw > img.width() || ay + ah > img.height()) {
        env.log.warn("atlas tile outside the image (" + atlasPath + ": " + ax + "," + ay + " " + aw + "x" + ah + ")");
        return null;
    }
    var key = common.fnv32Hex(atlasPath + "#" + ax + "," + ay + "," + aw + "," + ah);
    var tilePath = env.extractDir + "/_tiles/tile_" + key + ".png";
    return img.copy(ax, ay, aw, ah).save(tilePath, "PNG") ? { textureHash: key, textureFile: tilePath } : null;
}

function normalizePath(path) {
    var out = [];
    String(path).replace(/\\/g, "/").split("/").forEach(function (seg, i) {
        if (seg === "." || (seg === "" && i > 0)) return;
        if (seg === "..") { if (out.length > 1 || (out.length === 1 && out[0] !== "")) out.pop(); return; }
        out.push(seg);
    });
    return out.join("/");
}

// ── Raster and blurred layers ───────────────────────────────────────────────

// The image placed by layers.json's transform (natural-pixel rect centred on
// its origin -> world), as a one-<image> SVG the vector importer turns into
// a textured primitive.
function imageWrapperSvg(env, layer, imageBasename) {
    var im = layer.image;
    var t = im.transform && im.transform.length === 6 ? im.transform : [1, 0, 0, 1, 0, 0];
    var w = im.w || 0, h = im.h || 0;
    var m = [t[0], t[1], t[2], t[3], t[4] + t[0] * (-w / 2) + t[2] * (-h / 2), t[5] + t[1] * (-w / 2) + t[3] * (-h / 2)];
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
           '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"\n' +
           '     viewBox="' + (-env.frameW / 2) + ' ' + (-env.frameH / 2) + ' ' + env.frameW + ' ' + env.frameH +
           '" width="' + env.frameW + '" height="' + env.frameH + '">\n' +
           '  <g>\n' +
           '    <image x="0" y="0" width="' + w + '" height="' + h + '" preserveAspectRatio="none" transform="matrix(' +
           m.join(" ") + ')" xlink:href="' + common.xmlEscape(imageBasename) + '"/>\n' +
           '  </g>\n' +
           '</svg>\n';
}

// An image layer: imported as a textured vector layer through a wrapper
// SVG, then turned into a real bitmap layer by merging it with an empty one.
function importImageAsBitmapLayer(env, panelId, srcId, layer, layerIndex) {
    var imgRel = String(layer.image.file), imgPath = env.extractDir + "/" + imgRel;
    if (!common.fileExists(imgPath)) { env.log.warn("raster layer '" + layer.name + "': embedded image missing (" + imgRel + ")"); return false; }
    if (!layer.image.w || !layer.image.h) { env.log.warn("raster layer '" + layer.name + "': image size missing in layers.json"); return false; }
    var imgBase = common.fileBasename(imgRel);
    var wrapperPath = common.fileDirname(imgPath) + "/" + imgBase + "." + srcId + "_" + layerIndex + ".wrapper.svg";
    common.writeTextFile(wrapperPath, imageWrapperSvg(env, layer, imgBase));
    var name = layer.name ? String(layer.name) : ("Image " + (layerIndex + 1));
    if (!importSvgAsVectorLayer(env, panelId, wrapperPath, name)) return false;
    try {
        var lm = env.lm, before = lm.numberOfLayers(panelId);
        if (!lm.addBitmapLayer(panelId, 0, true, name)) throw "addBitmapLayer failed";
        lm.mergeLayers(panelId, [0, 1], name);
        if (lm.numberOfLayers(panelId) !== before) {
            try { lm.deleteLayer(panelId, 0); } catch (e) {}
            throw "mergeLayers failed";
        }
    } catch (e2) {
        env.log.warn("raster layer '" + name + "' kept as a textured vector layer (" + e2 + ")");
    }
    return true;
}

// A separable Gaussian blur (additive passes at Gaussian weights).
function gaussianBlur(img, sigmaPx) {
    if (sigmaPx <= 0) return img;
    function axis(input, horizontal) {
        var R = Math.max(1, Math.ceil(3 * sigmaPx)), stride = Math.max(1, Math.ceil(R / 32));
        var offs = [], ws = [], sum = 0, i;
        for (i = -R; i <= R; i += stride) {
            var w = Math.exp(-(i * i) / (2 * sigmaPx * sigmaPx));
            offs.push(i); ws.push(w); sum += w;
        }
        var out = new QImage(input.width(), input.height(), QImage.Format_ARGB32_Premultiplied);
        out.fill(0);
        var p = new QPainter();
        p.begin(out);
        p.setCompositionMode(QPainter.CompositionMode_Plus);
        for (i = 0; i < offs.length; i++) {
            p.setOpacity(ws[i] / sum);
            p.drawImage(horizontal ? offs[i] : 0, horizontal ? 0 : offs[i], input);
        }
        p.end();
        return out;
    }
    return axis(axis(img, true), false);
}

// A blurred vector layer rendered to a PNG at the project's pixel density
// (capped at 4096 px a side); the layer descriptor importImageAsBitmapLayer
// takes, or null.
function renderBlurredVectorPng(env, layer, artPath, srcId, layerIndex) {
    var svgText = common.readTextFile(artPath);
    if (!svgText) return null;
    var hints = parsePaintHints(svgText);
    var fills = [], box = null;
    for (var i = 0; i < hints.paths.length; i++) {
        var h = hints.paths[i];
        var path = h.d ? painterPathFromD(h.d) : null;
        if (!path) return null;
        var brush = hintBrush(env, h, hints.gradients);
        if (!brush) continue;
        var r = path.boundingRect();
        box = box ? { minX: Math.min(box.minX, r.x()), minY: Math.min(box.minY, r.y()),
                      maxX: Math.max(box.maxX, r.x() + r.width()), maxY: Math.max(box.maxY, r.y() + r.height()) }
                  : { minX: r.x(), minY: r.y(), maxX: r.x() + r.width(), maxY: r.y() + r.height() };
        fills.push({ path: path, brush: brush });
    }
    if (!box || (!(box.maxX > box.minX) && !(box.maxY > box.minY))) return null;
    var pad = 3 * layer.blur;
    var minX = box.minX - pad, minY = box.minY - pad, maxX = box.maxX + pad, maxY = box.maxY + pad;
    var ppu = env.resH > 0 ? env.resH / env.frameH : 2;
    var maxSide = Math.max(maxX - minX, maxY - minY) * ppu;
    if (maxSide > 4096) ppu *= 4096 / maxSide;
    var pxW = Math.max(1, Math.ceil((maxX - minX) * ppu)), pxH = Math.max(1, Math.ceil((maxY - minY) * ppu));
    var img = new QImage(pxW, pxH, QImage.Format_ARGB32_Premultiplied);
    img.fill(0);
    var p = new QPainter();
    p.begin(img);
    p.setRenderHint(QPainter.Antialiasing, true);
    p.scale(ppu, ppu);
    p.translate(-minX, -minY);
    fills.forEach(function (f) { p.fillPath(f.path, f.brush); });
    p.end();
    var outRel = "panels/" + srcId + "/" + String(layer.art) + "." + layerIndex + ".blurred.png";
    if (!gaussianBlur(img, layer.blur * ppu).save(env.extractDir + "/" + outRel, "PNG")) return null;
    return { name: layer.name, image: { file: outRel, w: pxW, h: pxH,
             transform: [1 / ppu, 0, 0, 1 / ppu, minX + pxW / (2 * ppu), minY + pxH / (2 * ppu)] } };
}

// An image layer pre-blurred in its own pixels (padded for the blur's reach).
function preBlurredImageLayer(env, srcId, layer, layerIndex) {
    var imgPath = env.extractDir + "/" + String(layer.image.file);
    if (!common.fileExists(imgPath)) return null;
    var src = new QImage(imgPath);
    if (src.isNull()) return null;
    var t = layer.image.transform && layer.image.transform.length === 6 ? layer.image.transform : [1, 0, 0, 1, 0, 0];
    var unitsPerPx = Math.sqrt(Math.abs(t[0] * t[3] - t[1] * t[2])) || 1;
    var sigmaPx = layer.blur / unitsPerPx, padPx = Math.ceil(3 * sigmaPx);
    var w = src.width() + 2 * padPx, h = src.height() + 2 * padPx;
    var canvasImg = new QImage(w, h, QImage.Format_ARGB32_Premultiplied);
    canvasImg.fill(0);
    var p = new QPainter();
    p.begin(canvasImg);
    p.drawImage(padPx, padPx, src);
    p.end();
    var outRel = String(layer.image.file) + "." + srcId + "_" + layerIndex + ".blurred.png";
    if (!gaussianBlur(canvasImg, sigmaPx).save(env.extractDir + "/" + outRel, "PNG")) return null;
    return { name: layer.name, image: { file: outRel, w: w, h: h, transform: layer.image.transform } };
}

// The art SVG's path data (absolute M/C/Z, what every sboardx writer emits) as a QPainterPath.
function painterPathFromD(d) {
    var tokens = String(d).match(/[A-Za-z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g);
    if (!tokens) return null;
    var path = new QPainterPath();
    path.setFillRule(Qt.WindingFill);
    var i = 0;
    function num() { return parseFloat(tokens[i++]); }
    function moreNumbers() { return i < tokens.length && !/^[A-Za-z]$/.test(tokens[i]); }
    while (i < tokens.length) {
        var cmd = tokens[i++];
        if (cmd === "M") {
            var x = num(), y = num();
            if (isNaN(x) || isNaN(y)) return null;
            path.moveTo(x, y);
        } else if (cmd === "C") {
            var got = false;
            while (moreNumbers()) {
                var x1 = num(), y1 = num(), x2 = num(), y2 = num(), x3 = num(), y3 = num();
                if (isNaN(y3)) return null;
                path.cubicTo(x1, y1, x2, y2, x3, y3);
                got = true;
            }
            if (!got) return null;
        } else if (cmd === "Z" || cmd === "z") {
            path.closeSubpath();
        } else return null;
    }
    return path;
}

function qColor(rgba) {
    return new QColor(common.to255(rgba[0]), common.to255(rgba[1]), common.to255(rgba[2]), common.to255(rgba[3]));
}

// The brush for a <path> in the blur raster: a gradient brush for a known
// `url(#id)` fill (unit space under the unit->user affine), else the flat
// colour (sboardx:rgba, or the hex fill at its opacity); null for no fill.
function hintBrush(env, h, gradients) {
    var g = h.gradientId ? gradients[h.gradientId] : null;
    if (g && g.stops.length) {
        var M = gradientUnitAffine(g, h.bbox, env.frameW, env.frameH);
        if (g.stops.length === 1 || !M) return new QBrush(qColor([g.stops[0].r, g.stops[0].g, g.stops[0].b, g.stops[0].a]));
        var qg = g.type === "radial" ? new QRadialGradient(0, 0, 1) : new QLinearGradient(0, 0, 1, 0);
        g.stops.forEach(function (s) { qg.setColorAt(s.t, qColor([s.r, s.g, s.b, s.a])); });
        var brush = new QBrush(qg);
        brush.setTransform(new QTransform(M[0], M[1], M[2], M[3], M[4], M[5]));   // x' = m11 x + m21 y + dx
        return brush;
    }
    if (h.rgba) return new QBrush(qColor(h.rgba));
    var rgb = parseHexColor(h.fill);
    return rgb ? new QBrush(qColor(rgb.concat([h.fillAlpha === null ? 1 : h.fillAlpha]))) : null;
}

// ── Audio ───────────────────────────────────────────────────────────────────

function pathUrl(path) {
    var p = String(path).replace(/\\/g, "/");
    return "file://localhost" + encodeURI(p.charAt(0) === "/" ? p : "/" + p);
}

// audio/clips.json as a Final Cut XML the animatic import conforms: one
// track per sboardx track (muted tracks disabled), clips trimmed and placed.
function buildAudioXml(env, clips, tracks, frameOffset) {
    var xmlEscape = common.xmlEscape, fps = env.fps;
    var rate = '<rate><timebase>' + fps + '</timebase><ntsc>FALSE</ntsc></rate>\n';
    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4">\n <sequence id="sboardx-audio">\n' +
              '  <name>sboardx audio</name>\n  ' + rate + '  <media>\n   <video/>\n   <audio>\n';
    var maxEnd = 0, used = 0, byTrack = {}, maxTrack = 0;
    clips.forEach(function (clip) {
        var ti = clip.track > 0 ? clip.track : 0;
        (byTrack[ti] = byTrack[ti] || []).push(clip);
        if (ti > maxTrack) maxTrack = ti;
    });
    for (var t = 0; t <= maxTrack; t++) {
        if (!byTrack[t]) continue;
        xml += '    <track>\n' + (tracks && tracks[t] && tracks[t].muted ? '     <enabled>FALSE</enabled>\n' : '');
        byTrack[t].forEach(function (clip) {
            if (!clip.file) return;
            var srcPath = env.extractDir + "/audio/" + clip.file;
            if (!common.fileExists(srcPath)) { env.log.warn("audio file missing in archive: " + clip.file); return; }
            var inF = Math.round((clip.trim_in || 0) * fps), lenF = Math.max(1, Math.round(clip.dur * fps));
            var startF = Math.round(clip.start * fps) + frameOffset;
            if (startF + lenF > maxEnd) maxEnd = startF + lenF;
            used++;
            xml += '     <clipitem id="clip-' + used + '">\n' +
                   '      <name>' + xmlEscape(clip.name || clip.file) + '</name>\n      ' + rate +
                   '      <start>' + startF + '</start>\n      <end>' + (startF + lenF) + '</end>\n' +
                   '      <in>' + inF + '</in>\n      <out>' + (inF + lenF) + '</out>\n' +
                   '      <file id="file-' + used + '">\n       <name>' + xmlEscape(clip.file) + '</name>\n' +
                   '       <pathurl>' + xmlEscape(pathUrl(srcPath)) + '</pathurl>\n       ' + rate +
                   '       <media><audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate>' +
                   '</samplecharacteristics></audio></media>\n      </file>\n' +
                   '      <sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>\n     </clipitem>\n';
        });
        xml += '    </track>\n';
    }
    xml += '   </audio>\n  </media>\n  <duration>' + Math.max(1, maxEnd) + '</duration>\n </sequence>\n</xmeml>\n';
    return used > 0 ? xml : null;
}

// Audio clips onto sound tracks through the animatic import (a session
// feature: in batch nothing is placed and the Message Log says so).
function importAudio(env, frameOffset) {
    var clipsJson = common.readJsonFile(env.extractDir + "/audio/clips.json");
    var clips = clipsJson && clipsJson.clips ? clipsJson.clips : [];
    if (!clips.length) return;
    var xml = buildAudioXml(env, clips, clipsJson.tracks || [], frameOffset || 0);
    if (!xml) { env.log.warn("audio clips listed but no audio files found in the archive"); return; }
    var xmlPath = env.extractDir + "/sboardx-audio.xml";
    common.writeTextFile(xmlPath, xml);
    var result = null;
    try { result = new ImportManager().importAnimatic(xmlPath, { doAudio: true }); }
    catch (e) { env.log.warn("audio import threw: " + e); }
    if (result && result.result) return;
    env.log.warn("audio not imported: the animatic import did not complete" +
                 (env.quiet ? " (audio import needs a Storyboard Pro session)" : "") +
                 (result && result.log && result.log.length ? ": " + result.log.join(" | ") : ""));
}

exports.importFromFile = importFromFile;
// Reused by sboardx_merge.js.
exports.makeImportEnv = makeImportEnv;
exports.extractArchive = extractArchive;
exports.loadSboardx = loadSboardx;
exports.applyProjectSettings = applyProjectSettings;
exports.createPanelAt = createPanelAt;
exports.fillPanelFromArchive = fillPanelFromArchive;
exports.recordPanelInIdMap = recordPanelInIdMap;
exports.archiveBaseOf = archiveBaseOf;
exports.panelToken = panelToken;
exports.applySceneCamera = applySceneCamera;
exports.importAudio = importAudio;
exports.globalStartFrameOf = globalStartFrameOf;
exports.sharedDrawingsNote = sharedDrawingsNote;
