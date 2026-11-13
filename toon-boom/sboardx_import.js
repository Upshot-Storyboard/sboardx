// sboardx_import.js: the code behind TB_ImportSboardx.js. Loaded with
// require() so the Scripts Manager only lists the entry points. Needs
// sboardx_common.js and sboardx_export.js next to it. See README.md.

var common = require("./sboardx_common.js");
var exp = require("./sboardx_export.js");

// options: { replaceExisting: delete the scenes that were there,
//            applyLayerLayout: in batch, apply the file's default layers }
function importFromFile(zipPath, quiet, options) {
    var log = common.makeLog("[sboardx] ", quiet);
    if (!common.requireApi(log)) return false;
    // The backup copies the saved files, so save first.
    if (!common.ensureProjectSaved(log, quiet, "The import",
            "The import first backs the project up, from its saved files: changes made since the last save " +
            "would be missing from the backup.")) {
        log.report("Import cancelled: the project was not saved.\n\nSave it (File > Save) and run the import again.", true);
        return false;
    }
    var env = makeImportEnv(log, quiet, options);
    env.progress = common.makeProgress("Importing .sboardx", quiet);
    env.progress.busy("Extracting the archive…");
    if (!extractArchive(env, String(zipPath))) { env.progress.close(); return false; }
    env.progress.busy("Reading the archive…");
    if (!loadSboardx(env)) { env.progress.close(); return false; }

    var preExistingScenes = [];
    for (var i = 0; i < env.sb.numberOfScenesInProject(); i++) preExistingScenes.push(String(env.sb.sceneInProject(i)));

    // Nothing has changed yet: back the project up, or stop.
    env.backup = common.backupProject(log, env.progress, "The import");
    if (!env.backup.ok) { env.progress.close(); log.report(env.backup.message, true); return false; }

    // Palette edits grab the Colour view. Give it back at the end no matter what.
    var colorView = common.captureColorView();
    env.colorView = colorView;
    project.beginUndoRedoAccum("Import sboardx");
    try {
        applyProjectSettings(env);
        env.idMap = common.loadIdMap(env.sb, log);
        planSharedDrawings(env);
        env.progress.begin(env.sequenceJson.panels.length);
        importScenes(env);
        env.progress.busy("Creating sequences…");
        importSequences(env);
        env.sb.setProjectMetadata(common.metaRecord("sboardx-source", JSON.stringify(
            { file: zipPath, name: env.projectJson.name, episode: env.projectJson.episode, version: env.projectJson.sboardx })));
        env.progress.busy("Importing palettes…");
        importPalettes(env);
        keepColorView(env);
        if (env.options.replaceExisting) {
            env.progress.busy("Removing the previous scenes…");
            preExistingScenes.forEach(function (sid) {
                if (!env.sb.deleteScene(sid)) env.log.warn("could not delete pre-existing scene " + sid);
            });
        }
        env.progress.busy("Importing audio…");
        importAudio(env, globalStartFrameOf(env, env.firstImportedPanel));
        removeScratchPalette(env);
        project.endUndoRedoAccum();
    } catch (err) {
        // Cancel or failure: roll everything back.
        project.cancelUndoRedoAccum();
        common.restoreColorView(colorView, log);
        env.progress.close();
        if (err && err.sboardxCancelled) log.report("Import cancelled. The project was not changed.", true);
        else log.report("sboardx import failed: " + err, true);
        return false;
    } finally {
        env.clipboard.restore();
    }
    // Before the final renders repaint the window.
    keepColorView(env);
    env.progress.busy("Recording the merge baselines…");
    // Only stamp panels we created. Older panels keep whatever baseline they had.
    exp.finishExchange(log, env.idMap, env.importedPanels, env.cameraStamps, env.sharedStamps);
    common.restoreColorView(colorView, log);
    env.progress.close();
    if (env.firstImportedPanel) env.selMgr.setCurrentPanel(env.firstImportedPanel);
    traceTextureDecodes(env);
    log.report(log.summary(importSummary(env) + common.backupNote(env.backup)), false);
    return true;
}

// One trace line of texture stats: images decoded (pages and 1.1 atlases)
// and the largest, textures composed and the largest, peak pages/atlases
// held at once, peak slots held, distinct pages.
function traceTextureDecodes(env) {
    var st = env.cellStats;
    env.log.trace("TEXTURES decoded=" + st.decoded + " largest=" + st.largestW + "x" + st.largestH + " composed=" + st.composed +
                  " composedLargest=" + st.composedW + "x" + st.composedH + " held=" + st.held + " cells=" + st.cells +
                  " pages=" + st.pages);
}

function makeImportEnv(log, quiet, options) {
    var sb = new StoryboardManager(), lm = new LayerManager();
    return {
        log: log,
        quiet: !!quiet,
        options: options || {},
        progress: common.makeProgress("", true),
        sb: sb,
        lm: lm,
        hasSession: common.hasGuiSession(sb, lm),
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
        importedPanels: [],      // panels we created; exp.finishExchange stamps them
        cameraStamps: [],        // scene camera baselines for exp.finishExchange
        scratchPalette: null,    // scene scratch palette, only when a drawing's element is unknown
        tileSeq: 0,              // numbers the atlas tile files
        elementScratch: 0,       // drawings painted from their element's scratch palette
        sceneScratch: 0,         // drawings that fell back to the scene scratch palette
        colorView: null,         // Colour view on entry, see keepColorView
        colorViewLost: false,    // a restore failed once, stop trying
        atlasCache: {},          // current art's decoded 1.1 atlases (withArtCache)
        pageImage: null,         // the single decoded page, pages are decoded one at a time
        sharedIndex: null,       // {dir, byId} from shared/index.json
        cellStats: { decoded: 0, largest: 0, largestW: 0, largestH: 0, composed: 0, composedLargest: 0, composedW: 0,
                     composedH: 0, held: 0, livePages: 0, cells: 0, pages: 0, pageSeen: {} },   // texture stats for the trace
        sharedPlan: {},      // archive drawing id -> plan (planSharedDrawings)
        projectShared: null, // project's shared drawings as saved
        sharedStamps: [],    // shared drawing baselines for exp.finishExchange
        ownFormFill: false,  // merge is filling a panel from its own exported form
        ownSharedPlan: {},   // archive drawing id -> plan while ownFormFill
        unchangedHolders: null,   // drawing key -> true (holderDeclaredUnchanged)
        clipboard: common.makeLayerClipboard(log),   // saves the user's clipboard around Copy/Paste Layers
        freshCopies: {},     // drawing key -> fresh copy (exp.drawingReadPath)
        backup: null,        // project backup taken before any change
        layerOpacityBase: {},   // panel id + "\n" + node name -> archive layer opacity
        counts: { scenes: 0, panels: 0, layers: 0, imageLayers: 0, blurredLayers: 0, failedLayers: 0,
                  camApplied: 0, groups: 0, animatedLayers: 0, sequences: 0,
                  sharedDrawings: 0, sharedLinked: 0, sharedCreated: 0, sharedRedrawn: 0, sharedCopies: 0,
                  palettes: 0, nativeKept: 0 }
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
    // We read 1.0, 1.1 and 1.2. This vendor key means it's not sboardx at all.
    if (projectJson.hasOwnProperty("x-the-storyboard-app")) {
        env.log.report("This file was written by a pre-release build of Upshot and is not a valid .sboardx archive. " +
                       "Export it again from a current Upshot.", true);
        return false;
    }
    var version = String(projectJson.sboardx || "");
    if (version !== "1.0" && version !== "1.1" && version !== "1.2") {
        var parts = /^(\d+)\.(\d+)$/.exec(version);
        var newer = parts && (Number(parts[1]) > 1 || (Number(parts[1]) === 1 && Number(parts[2]) > 2));
        env.log.report(newer ? "This file is sboardx " + version + ", made by a newer app: update the Toon Boom scripts to import it."
                             : "This importer reads sboardx 1.0, 1.1 and 1.2 archives. This file is sboardx " + (version || "unknown") + ".", true);
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
    // layer_layout is offered to the user, never applied silently.
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

// Scenes as contiguous runs of the panel order.
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

// Default layers are a user preference in SBP (Edit > Preferences > Layers).
// Only set on an explicit yes, or in batch with options.applyLayerLayout.
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

// "<name>", "<name> 2", "<name> 3"...
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
        var applied = group.keyframes.length > 0 && applySceneCamera(env, sceneId, group.keyframes);
        if (applied) env.counts.camApplied++;
        // Every scene gets a camera baseline, even without a camera, so a
        // camera added later on one side reads as a one-sided change.
        env.cameraStamps.push({ sceneId: sceneId, archive: group.keyframes, local: "live", verify: applied });
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
        env.importedPanels.push(panelId);
    });
    return firstPanelId;
}

// Insert after prevPanel (or first). reuseBlank renames a new scene's
// default panel instead. If SBP refuses the name, let it number the panel.
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

// Fill a panel from panels/<srcId>/. With `replace` its layers go first.
// A missing caption clears the field.
function fillPanelFromArchive(env, panelId, srcId, meta, replace) {
    env.sb.setPanelDuration(panelId, Math.max(1, Math.round(meta.dur * env.fps)));
    env.cm.setPanelCaptionText(env.notesCaption, panelId, meta.note ? String(meta.note) : "");
    env.cm.setPanelCaptionText(env.dialogueCaption, panelId, meta.dialogue ? String(meta.dialogue) : "");
    importPanelLayers(env, panelId, srcId, replace);
}

// Archive id and digest go in now. The local fingerprint is stamped later by
// exp.finishExchange, after the save.
function recordPanelInIdMap(env, panelId, srcId) {
    var entry = common.newIdEntry(srcId);
    entry.digest = panelBaseDigest(env, srcId);
    env.idMap.panels[panelId] = entry;
}

// The declared base if there is one, else the panel's own digest.
function panelBaseDigest(env, srcId) {
    var base = archiveBaseOf(env, srcId);
    if (base) return base;
    return common.archivePanelDigest(env.extractDir, srcId);
}

// sync.panels[srcId] if it's a valid SHA-256 hex digest, else "".
function archiveBaseOf(env, srcId) {
    var sync = env.projectJson.sync;
    var v = sync && sync.panels && typeof sync.panels === "object" ? sync.panels[String(srcId)] : null;
    return common.isSha256Hex(v) ? v : "";
}

// `code` is "<scene>-<token>"; without the prefix it's the token itself.
function panelToken(meta, sceneName) {
    var code = meta && meta.code !== undefined ? String(meta.code) : "";
    var prefix = sceneName + "-";
    return code.length > prefix.length && code.substring(0, prefix.length) === prefix ? code.substring(prefix.length) : code;
}

// One SBP sequence per contiguous run of an entry's scenes.
function importSequences(env) {
    var entries = env.sequenceJson.sequences || [];
    if (!entries.length) return;
    var sceneIndex = {}, nativeOf = {};
    for (var i = 0; i < env.sb.numberOfScenesInProject(); i++) sceneIndex[String(env.sb.sceneInProject(i))] = i;
    env.groups.forEach(function (g) { if (g.srcId && g.sceneId) nativeOf[g.srcId] = g.sceneId; });
    // Read the taken names once. Looking them up per name hangs SBP.
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

// Each palette joins the project palette of the same name, missing colours
// added as solids. SBP picks its own ids, so the way back matches by name.
function importPalettes(env) {
    var pj = common.readJsonFile(env.extractDir + "/palettes.json");
    if (!pj || !pj.palettes || !pj.palettes.length) return;
    pj.palettes.forEach(function (src, i) {
        // Not "sboardx <n>": that becomes node "sboardx_<n>", which
        // common.isBridgePalette takes for a scratch palette.
        var name = src.name ? String(src.name) : ("Imported palette " + (i + 1));
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
    if (!c.sharedDrawings) return "";
    return ", " + c.sharedDrawings + " shared drawing(s): " + c.sharedLinked + " holder(s) linked" +
           (c.sharedCreated ? ", " + c.sharedCreated + " drawing(s) made" : "") +
           (c.sharedRedrawn ? ", " + c.sharedRedrawn + " updated from the file" : "") +
           (c.sharedCopies ? ", " + c.sharedCopies + " holder(s) as plain copies" : "");
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

// Path points matched by locked frame (or by index when the counts agree),
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

// Separate eased X/Y functions, since the 3D path is linear.
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

// Keys at or past the scene end land on its last frame (common.cameraKeyFrames).
function applySceneCamera(env, shotId, kfs) {
    if (!kfs.length) return false;
    try {
        var mm = env.mm, fm = env.fm, fields = env.fields;
        var keyed = common.cameraKeyFrames(kfs, common.sceneFrameCount(env.sb, shotId), env.fps);
        var frames = keyed.frames, kfAt = keyed.keys;
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

// layer_tracks run in scene time across cuts, but SBP keys are per panel and
// layer. Split each track at every cut, sample the boundaries, and apply it
// to every panel with a layer of that name.
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
                if (applyTrackToLayer(env, span, li, kfs, px, py, nodeName, isGroup)) applied++;
            } catch (e) {
                env.log.warn("animation of '" + track.name + "' not applied on panel " + span.panelId + ": " + e);
            }
        });
        if (!applied) env.log.warn("animation track '" + track.name + "' matched no " + (isGroup ? "group" : "layer") + " in scene " + sceneId);
        env.counts.animatedLayers += applied;
    });
}

function applyTrackToLayer(env, span, li, kfs, px, py, nodeName, isGroup) {
    var panelId = span.panelId, mm = env.mm;
    // Keys inside the panel plus sampled first and last frames. The last
    // frame takes the left limit: the pose exactly at a cut belongs to the
    // next panel.
    var keyTimes = [span.start, span.end].concat(kfs.filter(function (k) {
        return k.t > span.start + 1e-9 && k.t < span.end - 1e-9;
    }).map(function (k) { return k.t; })).sort(function (a, b) { return a - b; });
    var frames = [], poses = [], peak = 0;
    keyTimes.forEach(function (t) {
        var pose = common.layerPoseAt(kfs, t, t === span.end && span.end > span.start);
        if (pose.opacity > peak) peak = pose.opacity;   // before collapsing
        var f = common.panelTimeToFrame(t - span.start, span.frames, env.fps);
        if (frames.length && frames[frames.length - 1] === f) return;
        frames.push(f);
        poses.push(pose);
    });
    if (poses.every(common.isIdentityPose) && frames.length <= 2) return false;
    // Read before clearLayerMotion resets opacity to 100.
    var base = baseLayerOpacity(env, panelId, li, nodeName);

    // Enable, add keys, then get the functions. Before that they're "" and
    // writes do nothing.
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
    applyTrackOpacity(env, panelId, li, nodeName, isGroup, frames, poses, base, peak);
    return true;
}

// Layer opacity 0..100: what configureImportedLayers set, else read at
// frame 1 (-batch has no current frame), else 100.
function baseLayerOpacity(env, panelId, li, nodeName) {
    var key = panelId + "\n" + nodeName;
    if (env.layerOpacityBase.hasOwnProperty(key)) return env.layerOpacityBase[key];
    try {
        var v = Number(env.lm.layerOpacity(panelId, li, 1));
        if (isFinite(v)) return v;
    } catch (e) {}
    return 100;
}

// Layer opacity times track opacity. Must run after clearLayerMotion, which
// resets opacity to 100 and empties the opacity function. A fade is an eased
// bezier on the node's "opacity" attribute (same column setLayerOpacity
// keys, and the easing matches the sboardx smoothstep). Groups, or layers
// we can't link, get the track's peak opacity for the whole panel so a
// fade-in from 0 doesn't hide it.
function applyTrackOpacity(env, panelId, li, nodeName, isGroup, frames, poses, base, peak) {
    var values = poses.map(function (p) { return base * p.opacity; });
    var varies = values.some(function (v) { return Math.abs(v - values[0]) > 1e-6; });
    if (varies && !isGroup) {
        try {
            linkOpacityKeys(env, panelId, li, nodeName, frames, values);
            return;
        } catch (e) {
            env.log.warn("opacity fade of layer '" + nodeName + "' on panel " + panelId + " kept at its peak (" + e + ")");
        }
    }
    try {
        if (!isGroup) unlinkOpacity(env, panelId, li, nodeName);
        env.lm.setLayerOpacity(panelId, li, varies ? base * peak : values[0], 1);   // frame 1: -batch has no current frame
    } catch (e2) {
        env.log.warn("opacity of '" + nodeName + "' not applied on panel " + panelId + " (" + e2 + ")");
    }
}

function linkOpacityKeys(env, panelId, li, nodeName, frames, values) {
    var mm = env.mm, fm = env.fm;
    var fn = String(mm.linkedLayerFunction(panelId, li, "opacity") || "");
    if (fn) {
        for (var k = fm.numberOfPoints(panelId, fn) - 1; k >= 0; k--) fm.clearKeyFrame(panelId, fn, fm.pointX(panelId, fn, k));
    } else {
        // addFunction refuses a name the panel already has.
        var stem = "sbx_opacity_" + nodeName.replace(/[^A-Za-z0-9_]/g, "_");
        fn = stem;
        for (var n = 2; !mm.addFunction(panelId, fn, "BEZIER"); n++) {
            if (n > 99) throw "no free function name";
            fn = stem + "_" + n;
        }
        mm.setLinkedFunction(panelId, "Top/" + nodeName, "opacity", fn);
        if (String(mm.linkedLayerFunction(panelId, li, "opacity") || "") !== fn) throw "the opacity function did not link to Top/" + nodeName;
    }
    setEasedKeys(env, panelId, fn, frames, values);
}

function unlinkOpacity(env, panelId, li, nodeName) {
    if (String(env.mm.linkedLayerFunction(panelId, li, "opacity") || "")) env.mm.setLinkedFunction(panelId, "Top/" + nodeName, "opacity", "");
}

// ── Panel layers ────────────────────────────────────────────────────────────

function importPanelLayers(env, panelId, srcId, replace) {
    var layersJson = common.readJsonFile(env.extractDir + "/panels/" + srcId + "/layers.json");
    var layers = layersJson && layersJson.layers ? layersJson.layers : [];
    if (!layers.length && !replace) return 0;

    // Park existing layers under temp names first. SBP uniquifies layer names
    // per panel, so an imported "A" next to a default "A" would become "A_1".
    // Survivors get their names back at the end.
    var preexisting = env.lm.numberOfLayers(panelId), parked = [], parkedAs = [];
    // On replace, keep native layers that came back unchanged.
    var keep = replace ? keptNativeLayers(env, panelId, srcId, layers) : {};
    for (var p = 0; p < preexisting; p++) {
        parked.push(String(env.lm.layerName(panelId, p)));
        env.lm.renameLayer(panelId, p, "~sboardx parked " + (p + 1));
        parkedAs.push(String(env.lm.layerName(panelId, p)));   // sanitized, "_sboardx_parked_1"
    }
    var imported = [], keptParked = {};   // imported: top to bottom, matches the panel's stack
    layers.forEach(function (layer, i) {
        // A kept layer goes on top, where its picture would have gone.
        // Use moveLayerBeforeLayer(.., 0): moveLayerInGroup(-1) sends it to
        // the bottom.
        if (keep.hasOwnProperty(i)) {
            var parkedName = parkedAs[keep[i].li];
            var at = env.lm.layerIndexFromName(panelId, parkedName);
            if (at >= 0 && (at === 0 || env.lm.moveLayerBeforeLayer(panelId, at, 0)) &&
                String(env.lm.layerName(panelId, 0)) === parkedName) {
                keptParked[keep[i].li] = true;
                imported.unshift(keep[i].applyOpacity ? layer : withoutOpacity(layer));
                env.counts.layers++;
                env.counts.nativeKept++;
                env.log.trace("panel " + panelId + ": native text layer '" + layer.name + "' kept (its picture came back unchanged)");
                return;
            }
            env.log.warn("panel " + panelId + ": native text layer '" + layer.name + "' could not be kept in place; replaced by its picture");
        }
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

    // Old layers are below the imported ones. Import drops the empty ones,
    // replace drops all. SBP won't delete a panel's last layer, so stop at
    // the first refusal.
    if (imported.length && preexisting) {
        for (var d = env.lm.numberOfLayers(panelId) - 1; d >= imported.length; d--) {
            if (!replace && !env.lm.isEmpty(panelId, d)) continue;
            if (env.lm.deleteLayer(panelId, d) === false) {
                env.log.warn("panel " + panelId + ": old layer " + d + " could not be removed");
                break;
            }
        }
    }
    // Rename survivors back, skipping the kept ones that moved up.
    var survivors = parked.filter(function (name, k) { return !keptParked[k]; });
    var total = env.lm.numberOfLayers(panelId);
    for (var s = imported.length; s < total; s++) {
        var old = survivors[s - imported.length];
        if (old) env.lm.renameLayer(panelId, s, old);
    }
    return imported.length;
}

// archive layer index -> { li, applyOpacity } for native layers (text layers
// today) that stay instead of their exported picture. Kept only when the
// picture came back byte-identical (same PNG hash, size, placement, no blur)
// AND the local text layer's drawing still matches its record. Otherwise a
// local edit would survive a "take theirs".
// A layer whose fade lives in its opacity function (`varies`) is kept only
// while the archive still says the same opacity, and then its opacity is not
// touched: writing it at frame 1 would key the function.
function keptNativeLayers(env, panelId, srcId, layers) {
    var keep = {}, records = common.readNativeLayers(env.sb, panelId);
    if (!records.length) return keep;
    var byName = {}, n = env.lm.numberOfLayers(panelId), li;
    for (li = 0; li < n; li++) byName[String(env.lm.layerName(panelId, li))] = li;
    function sameNumbers(a, b) {
        if (!a || !b || a.length !== b.length) return false;
        for (var k = 0; k < a.length; k++) {
            if (Math.abs(Number(a[k]) - Number(b[k])) > 1e-9 * Math.max(1, Math.abs(Number(b[k])))) return false;
        }
        return true;
    }
    layers.forEach(function (layer, i) {
        var img = layer.image;
        if (!img || !img.file || (typeof layer.blur === "number" && layer.blur > 0)) return;
        var name = String(layer.name || "");
        var rec = null;
        records.forEach(function (r) { if (r && r.kind === "text" && String(r.name) === name) rec = r; });
        if (!rec || !byName.hasOwnProperty(name) || keepsIndex(keep, byName[name])) return;
        var ri = rec.image || {};
        if (Number(img.w) !== Number(ri.w) || Number(img.h) !== Number(ri.h) || !sameNumbers(img.transform, ri.transform)) return;
        if (!common.recordedFileUnchanged(rec.png, env.extractDir + "/" + String(img.file))) return;
        if (!rec.drawing || typeof rec.opacity !== "number") return;
        var archiveOpacity = typeof layer.opacity === "number" ? layer.opacity : 100;
        if (rec.varies === true && Math.abs(archiveOpacity - rec.opacity) > 1e-9) return;
        li = byName[name];
        var tvg = String(env.lm.getLayerDrawingName(panelId, li, true) || "");
        if (env.lm.isVectorLayer(panelId, li) !== true || !common.drawingTexts(tvg).length) return;
        if (!common.recordedFileUnchanged(rec.drawing, tvg)) {
            env.log.trace("panel " + panelId + ": text layer '" + name + "' changed here since the export; its picture replaces it");
            return;
        }
        keep[i] = { li: li, applyOpacity: rec.varies !== true };
    });
    return keep;
}

function keepsIndex(keep, li) {
    for (var k in keep) if (keep.hasOwnProperty(k) && keep[k].li === li) return true;
    return false;
}

// So configureImportedLayers leaves the opacity alone.
function withoutOpacity(layer) {
    var out = {};
    for (var k in layer) if (layer.hasOwnProperty(k) && k !== "opacity") out[k] = layer[k];
    return out;
}

// Image layer (pre-blurred if needed), blurred vector rendered to a bitmap
// (SBP has no layer blur), or vector art. Shared holders get linked.
// `texture` is relative to the panel folder; image layers don't have one.
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
    var texRef = textureRefOf(layer, env.extractDir + "/panels/" + srcId);
    if (blur) {
        var placed = null;
        try { placed = renderBlurredVectorPng(env, layer, artPath, srcId, layerIndex, texRef); }
        catch (eB) { env.log.trace("blur rasterization of layer '" + name + "' threw: " + eB); }
        if (placed && importImageAsBitmapLayer(env, panelId, srcId, placed, layerIndex)) {
            env.counts.blurredLayers++;
            if (layer.shared) sharedCopy(env, sharedLinkFor(env, String(layer.shared)), name, "blurred");
            return true;
        }
        env.log.warn("layer '" + name + "': blur rasterization failed - importing sharp vector art");
    }
    if (layer.shared) return importSharedHolder(env, panelId, layer, name, artPath, texRef);
    return importSvgAsVectorLayer(env, panelId, artPath, name, texRef);
}

// {dir, link} for an entry's `texture`, or null when there is no such key.
// `link` is kept raw: a non-string is Link damage in readTextureFile.
function textureRefOf(entry, dir) {
    return entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "texture") ? { dir: dir, link: entry.texture } : null;
}

// Cached per extraction folder, since the merge reads from more than one.
function sharedIndexEntry(env, id) {
    if (!env.sharedIndex || env.sharedIndex.dir !== env.extractDir) {
        var byId = {}, idx = common.readJsonFile(env.extractDir + "/shared/index.json");
        ((idx && idx.drawings) || []).forEach(function (d) { if (d && d.id && !byId.hasOwnProperty("#" + d.id)) byId["#" + d.id] = d; });
        env.sharedIndex = { dir: env.extractDir, byId: byId };
    }
    return env.sharedIndex.byId.hasOwnProperty("#" + id) ? env.sharedIndex.byId["#" + id] : null;
}

// ── Shared drawings (SPEC.md "shared/") ─────────────────────────────────────
//
// All holders of an archive shared drawing end up holding one SBP shared
// drawing. There's no API to assign a shared drawing to a layer, so we Copy
// Layers from an existing holder and Paste Layers into the panel (the paste
// keeps the link, even across scenes), then reset what the paste carried
// over. The user's clipboard is restored at the end. What to do with each
// drawing is planned up front (common.sharedLinkMode). Archive ids go into
// the id map so a round trip keeps Upshot's ids.

// Plan every drawing in shared/index.json against the saved project.
function planSharedDrawings(env) {
    env.sharedPlan = {};
    var idx = common.readJsonFile(env.extractDir + "/shared/index.json");
    ((idx && idx.drawings) || []).forEach(function (d) {
        if (d && d.id) env.sharedPlan[String(d.id)] = planSharedDrawing(env, String(d.id), String(d.name || ""), false);
    });
}

// {id, name, artPath, art, key, mode, why, source: {panel, drawingName},
// redrawn, stamped, noted}. `source` is the holder we paste from.
// ownForm: the panel comes from the project's own export, so its drawings
// are the project's and count as unchanged.
function planSharedDrawing(env, id, name, ownForm) {
    var ps = projectSharedDrawings(env);
    var key = common.sharedDrawingKeyOf(env.idMap, id, ps.keys);
    var sharedDir = env.extractDir + "/shared", artPath = sharedDir + "/" + id + "/art.svg";
    var entry = sharedIndexEntry(env, id), textureLink = entry ? entry.texture : undefined;
    var art = common.sharedDrawingIdentity(sharedDir, id, textureLink);
    var source = key ? ps.holders[key] || null : null;
    var rec = key && env.idMap.drawings ? env.idMap.drawings[key] || null : null;
    var m = common.sharedLinkMode({
        hasSession: env.hasSession, key: key, hasHolder: !!source, rec: rec,
        artUnchanged: common.sharedArtUnchanged(rec, art),
        holderDeclaredUnchanged: ownForm || (key ? holderDeclaredUnchanged(env, key) : false),
        fileUnchanged: !!rec && common.recordedFileUnchanged(rec.file, common.projectDir() + "/" + key) });
    var plan = { id: id, name: name || (key ? common.fileBasename(key).replace(/\.tvg$/i, "").replace(/^Shared[-_ ]/i, "") : ""),
                 artPath: artPath, art: art, key: key, mode: m.mode, why: m.why, source: source, ownForm: !!ownForm,
                 redrawn: false, stamped: false, noted: false };
    env.log.trace("SHARED " + id + " '" + plan.name + "' " + plan.mode + (plan.why ? " (" + plan.why + ")" : "") +
                  (key ? " = " + key : "") + (ownForm ? " (own form)" : ""));
    return plan;
}

// While the merge refills a panel from the project's own export (to move
// it), use a separate plan that always links. Otherwise a "both changed"
// drawing would turn the project's own holders into unlinked copies.
function sharedLinkFor(env, id) {
    if (env.ownFormFill) {
        return env.ownSharedPlan[id] || (env.ownSharedPlan[id] = planSharedDrawing(env, id, "", true));
    }
    return env.sharedPlan[id] || (env.sharedPlan[id] = planSharedDrawing(env, id, "", false));
}

// All shared drawing keys (from layers and the "Shared" element) and the
// first holder of each. Read once per run.
function projectSharedDrawings(env) {
    if (env.projectShared) return env.projectShared;
    var ps = { keys: [], holders: {} }, seen = {};
    function add(key) { if (key && !seen[key]) { seen[key] = true; ps.keys.push(key); } }
    common.forEachPanel(env.sb, function (sceneId, pid) {
        for (var i = 0; i < env.lm.numberOfLayers(pid); i++) {
            if (env.lm.isShared(pid, i) !== true) continue;
            var key = common.sharedDrawingKey(String(env.lm.getLayerDrawingName(pid, i, true) || ""));
            add(key);
            if (key && !ps.holders[key]) ps.holders[key] = { panel: pid, drawingName: String(env.lm.getLayerDrawingName(pid, i, false) || "") };
        }
    });
    for (var e = 0; e < element.numberOf(); e++) {
        var eid = element.id(e);
        if (String(element.getNameById(eid)) !== "Shared") continue;
        for (var d = 0; d < Drawing.numberOf(eid); d++) add(common.sharedDrawingKey(String(Drawing.filename(eid, String(Drawing.name(eid, d))) || "")));
    }
    env.projectShared = ps;
    return ps;
}

// True if, at the last exchange, the drawing was held by a panel the archive
// now declares unchanged (its base matches our stamped digest). A writer
// marks every holder of a drawing it changes, so that means the drawing is
// unchanged too. Go by the id map's recorded `shared` list, not the archive's
// labels (a writer may drop `shared`) and not what the panel holds now (a
// holder pasted here later would hide the file's change). Built once, before
// the id map changes.
function holderDeclaredUnchanged(env, key) {
    if (!env.unchangedHolders) {
        var entryOf = {}, held = {};
        for (var pid in env.idMap.panels) if (env.idMap.panels.hasOwnProperty(pid)) {
            var e = env.idMap.panels[pid];
            if (e && e.id && common.isSha256Hex(e.digest) && common.idEntryRecordsShared(e)) entryOf[e.id + "\n" + e.digest] = e;
        }
        (env.sequenceJson.panels || []).forEach(function (srcId) {
            var base = archiveBaseOf(env, srcId);
            var entry = base ? entryOf[srcId + "\n" + base] : null;
            ((entry && entry.shared) || []).forEach(function (k) { held[String(k)] = true; });
        });
        env.unchangedHolders = held;
    }
    return env.unchangedHolders[key] === true;
}

// Paste from an existing holder if we can. Otherwise import the art, and
// share it if it's the first holder of a new drawing. Failing that it's a
// plain copy with a warning. texRef is the holder's own texture file.
function importSharedHolder(env, panelId, layer, name, artPath, texRef) {
    var link = sharedLinkFor(env, String(layer.shared));
    if (!link.noted) { link.noted = true; env.counts.sharedDrawings++; }
    if (link.mode === "redraw" && !link.redrawn) {
        try {
            redrawSharedDrawing(env, link);
        } catch (e) {
            link.mode = "copy";
            link.why = "its art could not be replaced (" + e + ")";
        }
    }
    var pasteFailed = false;
    if ((link.mode === "link" || link.mode === "redraw" || link.mode === "new") && link.source) {
        if (pasteSharedHolder(env, panelId, link)) return true;
        pasteFailed = true;
    }
    if (!importSvgAsVectorLayer(env, panelId, artPath, name, texRef)) return false;
    if (link.mode === "new" && !link.source) {
        if (link.why === "holderless") env.log.warn("shared drawing '" + (link.name || name) + "' is in the project's library but no layer holds it: a new shared drawing was made for its holders");
        if (shareDrawing(env, panelId, 0, link.name || name)) {
            link.source = { panel: String(panelId), drawingName: String(env.lm.getLayerDrawingName(panelId, 0, false) || "") };
            env.counts.sharedCreated++;
            env.counts.sharedLinked++;
            env.sharedStamps.push({ id: link.id, art: link.art, panel: link.source.panel, drawingName: link.source.drawingName });
            return true;
        }
        link.mode = "copy";
        link.why = "the Share Drawing action failed";
    }
    sharedCopy(env, link, name, pasteFailed ? "a holder could not be pasted (see the warning above)" : link.why);
    return true;
}

// One warning per drawing and reason.
function sharedCopy(env, link, name, why) {
    env.counts.sharedCopies++;
    var key = "w:" + why;
    if (link[key]) return;
    link[key] = true;
    var what = "shared drawing '" + (link.name || name) + "'";
    var text = {
        batch: what + ": -batch cannot run Copy/Paste Layers, so its holders come in as plain copies (unlinked)",
        blurred: what + ": a blurred holder comes in as a picture (Storyboard Pro has no layer blur), not linked",
        "both changed": what + " changed both here and in the file: its holders from the file come in as plain copies of the file's drawing (unlinked); the project's drawing stays as it is for its other holders",
        "no baseline": what + " differs from the file's and was never exchanged with it (no baseline to tell which side changed): its holders from the file come in as plain copies (unlinked); the project's drawing stays as it is"
    }[why] || (what + ": " + why + "; its holders come in as plain copies (unlinked)");
    env.log.warn(text);
}

// Copy/Paste Layers into index 0, then check we got exactly one shared layer
// on the same drawing. On failure, remove what was pasted and warn.
function pasteSharedHolder(env, panelId, link) {
    var src = liveSharedHolder(env, link), lm = env.lm;
    var si = src ? sharedHolderIndex(env, src.panel, src.drawingName) : -1;
    var before = lm.numberOfLayers(panelId);
    var why = "";
    if (si < 0) why = "no layer of the project holds it any more";
    else {
        try {
            env.clipboard.copy(env.selMgr, src.panel, String(lm.layerName(src.panel, si)));
            env.clipboard.paste(env.selMgr, panelId);
        } catch (e) { why = String(e); }
    }
    var added = lm.numberOfLayers(panelId) - before;
    if (!why && (added !== 1 || lm.isShared(panelId, 0) !== true || String(lm.getLayerDrawingName(panelId, 0, false) || "") !== src.drawingName))
        why = "the paste added " + added + " layer(s), not one holder of the drawing";
    if (why) {
        for (var k = 0; k < added; k++) { try { lm.deleteLayer(panelId, 0); } catch (eD) {} }
        env.log.warn("shared drawing '" + link.name + "': a holder could not be linked on panel " + panelId + " (" + why + ")");
        return false;
    }
    resetPastedLayer(env, panelId, 0);
    if (!link.stamped && link.mode === "link" && !link.ownForm) {
        link.stamped = true;
        env.sharedStamps.push({ id: link.id, art: link.art, key: link.key, keepFile: true });
    }
    env.counts.sharedLinked++;
    return true;
}

// link.source if it still exists, else any other holder (link.source moves
// to it). A merge may delete the original holder mid-run. null if none.
function liveSharedHolder(env, link) {
    var src = link.source;
    if (!src) return null;
    if (sharedHolderIndex(env, src.panel, src.drawingName) >= 0) return src;
    var found = null;
    common.forEachPanel(env.sb, function (sceneId, pid) {
        if (!found && sharedHolderIndex(env, pid, src.drawingName) >= 0) found = { panel: String(pid), drawingName: src.drawingName };
    });
    if (found) link.source = found;
    return found;
}

// drawingName is the short name, unique within the Shared element.
function sharedHolderIndex(env, panelId, drawingName) {
    for (var i = 0; i < env.lm.numberOfLayers(panelId); i++) {
        if (env.lm.isShared(panelId, i) === true && String(env.lm.getLayerDrawingName(panelId, i, false) || "") === drawingName) return i;
    }
    return -1;
}

// A paste carries the source's opacity and motion. Reset them; the archive's
// values are applied later.
function resetPastedLayer(env, panelId, li) {
    try { env.mm.clearLayerMotion(panelId, li); } catch (e1) {}
    try { env.mm.setLayerAnimated(panelId, li, false); } catch (e2) {}
    try { unlinkOpacity(env, panelId, li, common.sbpNodeName(String(env.lm.layerName(panelId, li)))); } catch (e3) {}
    try { env.lm.setLayerOpacity(panelId, li, 100, 1); } catch (e4) {}   // frame 1: -batch has no current frame
}

// Replace the drawing's art in place so every holder shows the new one.
// Selecting the layer doesn't change the current drawing (it stays whatever
// Tools.createDrawing made last), so use setCurrentDrawingFromNodeName and
// verify it's really the holder's drawing before deleting anything. Read
// saved files through a fresh copy: SBP caches a file read by name for the
// whole session.
function redrawSharedDrawing(env, link) {
    link.redrawn = true;
    var src = liveSharedHolder(env, link), si = src ? sharedHolderIndex(env, src.panel, src.drawingName) : -1;
    if (si < 0) throw "no layer of the project holds it any more";
    var art = parseArtSvg(env, link.artPath, link.name, textureRefOf(sharedIndexEntry(env, link.id), env.extractDir + "/shared"));
    if (!art) throw "the file's shared/" + link.id + "/art.svg could not be read";
    env.selMgr.setCurrentPanel(src.panel);
    DrawingTools.setCurrentDrawingFromNodeName("Top/" + String(env.lm.layerName(src.panel, si)), 1);
    var cd = Tools.getToolSettings().currentDrawing;
    if (!cd || cd.isValid === false) throw "its drawing could not be made current";
    if (Number(cd.elementId) !== Number(env.lm.getLayerElementId(src.panel, si)) ||
        artSignature(Drawing.query.getData({ drawing: cd })) !==
        artSignature(Drawing.query.getData({ drawing: { filename: exp.drawingReadPath(env, String(env.lm.getLayerDrawingName(src.panel, si, true) || "")) } })))
        throw "the drawing made current is not the holder's (nothing was changed)";
    var data = Drawing.query.getData({ drawing: cd });
    ((data && data.arts) || []).forEach(function (a) {
        var n = (a.layers || []).length, idx = [];
        for (var i = 0; i < n; i++) idx.push(i);
        if (n) DrawingTools.deleteLayers({ label: "sboardx shared drawing", drawing: cd, art: a.art, layers: idx });
    });
    var left = 0;
    data = Drawing.query.getData({ drawing: cd });
    ((data && data.arts) || []).forEach(function (a) { left += (a.layers || []).length; });
    if (left) throw left + " layer(s) of its art could not be deleted";
    if (!drawSvgPage(env, art, cd.elementId) && art.items.length) throw "its new art drew nothing";
    link.stamped = true;
    env.sharedStamps.push({ id: link.id, art: link.art, key: link.key, rewritten: true });
    env.counts.sharedRedrawn++;
    env.log.trace("SHARED " + link.id + " '" + link.name + "' redrawn from the file");
}

// Enough to tell two drawings apart: colours and point counts per layer.
function artSignature(data) {
    return JSON.stringify(((data && data.arts) || []).map(function (a) {
        return [a.art, (a.layers || []).map(function (l) {
            return [(l.contours || []).map(function (c) { return [String(c.colorId), (c.path || []).length]; }),
                    (l.strokes || []).map(function (s) { return (s.path || []).length; })];
        })];
    }));
}

// No scripting call for this, so run the onActionShareDrawing action. The
// drawing takes the layer's name, so rename the layer around it.
function shareDrawing(env, panelId, layerIndex, drawingName) {
    // In -batch, Action.validate crashes SBP and the selection needs a
    // session ("MISSING SESSION").
    if (!env.hasSession) {
        env.log.warn("share drawing '" + drawingName + "' skipped: -batch cannot run the Share Drawing action; left as a plain layer");
        return false;
    }
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

// Names, visibility, lock, opacity. Duplicate names get " copy" bottom-up
// (Upshot's rule), so the lower layer keeps the plain name.
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
            // Set both ways: a kept native layer has its own state.
            var visible = src.visible !== false, locked = src.locked === true;
            if ((env.lm.layerVisibility(panelId, k) !== false) !== visible) env.lm.setLayerVisible(panelId, k, visible);
            if ((env.lm.getLayerLock(panelId, k) === true) !== locked) env.lm.setLayerLock(panelId, k, locked);
            if (src.opacity !== undefined) {
                // Frame 1: -batch has no current frame. Layer tracks set it
                // again later.
                env.lm.setLayerOpacity(panelId, k, src.opacity, 1);
                env.layerOpacityBase[panelId + "\n" + common.sbpNodeName(names[k])] = Number(src.opacity);
            }
        } catch (e) {
            env.log.warn("layer '" + src.name + "': visibility/lock/opacity not applied (" + e + ")");
        }
    });
}

// A group is a contiguous run of layers with the same "group". SBP groups
// sit in the flat layer index and every move shifts indices, so look
// members up by name each time.
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
                lm.moveLayerInGroup(panelId, li, groupIdx);   // appends, so order is kept
            });
            env.counts.groups++;
        } catch (e) {
            env.log.warn("group '" + g + "' not applied: " + e);
        }
    }
}

// ── Vector art ──────────────────────────────────────────────────────────────

// Geometry comes from SBP's importer.parseSVG, paint from our own read of the
// SVG text (parsePaintHints). The parser drops some paths (a fill at opacity
// 0, for one), so we can't match by position. Instead we parse a copy where
// each path is filled with its index as an opaque 24-bit colour (the parser
// returns it exactly) and map primitives back by colour. Missing paths get a warning.
// Pattern fills are placed by math (patternPageMatrix), the copy carries no
// image. All vector layers go through here. texRef may be null.
function importSvgAsVectorLayer(env, panelId, svgPath, layerName, texRef) {
    var layerAdded = false;
    try {
        var art = parseArtSvg(env, svgPath, layerName, texRef);
        if (!art) return false;
        env.selMgr.setCurrentPanel(panelId);
        env.lm.addVectorLayer(panelId, 0, true, String(layerName));
        layerAdded = true;
        env.selMgr.setLayerSelection([{ name: env.lm.layerName(panelId, 0), panelId: panelId }]);
        Tools.createDrawing({ allFrames: true });
        drawSvgPage(env, art, currentElementId(env));
        return true;
    } catch (e) {
        env.log.trace("vector import failed for " + svgPath + ": " + e);
        if (layerAdded) { try { env.lm.deleteLayer(panelId, 0); } catch (e2) {} }
        return false;
    }
}

// {page, textures, hints, items, pageMap}, or null if the parser gave no
// page. items: {prim, hint} in paint order, hint null for primitives with
// no drawable (an <image> outside a pattern). pageMap: SVG user space to
// page units, measured on a marker rect at the end of the copy (null if
// that failed). The copy goes next to the original so relative hrefs still
// resolve. Decoded atlases and cells only live for this one art: a texture
// file only lists its own layer's cells.
function parseArtSvg(env, svgPath, layerName, texRef) {
    var art = readArt(svgPath), svgText = art.text;
    var hints = parsePaintHints(svgText), tiles = 0, damage = { count: 0, first: "" };
    bindTextureEntries(env, hints, texRef, damage, art);
    withArtCache(env, function () {
        tiles = artTextures(env, common.fileDirname(svgPath), hints, damage);
    });
    reportTextureDamage(env, layerName, damage);
    var marker = artMarkerRect(svgText);
    var parsePath = svgPath + ".sbx-parse.svg";
    common.writeTextFile(parsePath, identityParseCopy(svgText, hints, marker));
    var data = importer.parseSVG({ filename: parsePath });
    if (!data || !data.pages || !data.pages.length) {
        env.log.trace("importer.parseSVG returned no pages for " + parsePath);
        return null;
    }
    var page = data.pages[0];
    var paired = pairPrimitives(page.primitives || [], hints);
    var pageMap = artPageMap(paired.marker, marker);
    reportUnpaired(env, layerName, hints, paired);
    if (!pageMap && tiles) env.log.warn("layer '" + layerName + "': its textured strokes are drawn flat (the texture placement could not be measured)");
    return { page: page, textures: data.textures, hints: hints, items: paired.items, pageMap: pageMap };
}

// Runs fn with a fresh atlas cache, then restores the old one. Tracks the
// peak number of decoded images held.
function withArtCache(env, fn) {
    var saved = env.atlasCache;
    env.atlasCache = {};
    try {
        fn();
    } finally {
        var held = 0;
        for (var k in env.atlasCache) {
            var v = env.atlasCache.hasOwnProperty(k) ? env.atlasCache[k] : null;
            if (v && typeof v.width === "function") held++;
        }
        if (held > env.cellStats.held) env.cellStats.held = held;
        env.atlasCache = saved;
    }
}

// One warning per art. Damage is reported, never hidden.
function reportTextureDamage(env, layerName, damage) {
    if (!damage.count) return;
    env.log.warn("layer '" + layerName + "': the file is damaged: " + damage.count + " texture fact(s); strokes drawn flat or " +
                 "cells left transparent (first: " + damage.first + ")");
}

// {raw, bom, text, shifts}. The spec's syntax checks run on `raw`, since
// normalizing would hide a single-quoted attribute. `bom` is checked on the
// bytes because File.read may drop it. Everything else reads `text`;
// `shifts` maps offsets back (artTextOffset).
function readArt(path) {
    var raw = common.readTextFile(path) || "", shifts = [];
    return { raw: raw, bom: fileStartsWithBom(path), text: normalizeSvgAttrs(raw, shifts), shifts: shifts };
}

// Reads only the first three bytes.
function fileStartsWithBom(path) {
    var f = new QFile(path);
    if (!f.open(QIODevice.ReadOnly)) return false;
    var head = f.read(3);
    f.close();
    return String(head.toHex().toString()).toLowerCase() === "efbbbf";
}

// Rewrite every attribute as name="value". attrOf and the paint code only
// understand that form, so a single-quoted fill would be missed and the
// parse copy would end up with two fills. SBP's parser doesn't care.
// `shifts` (optional) gets {at, end, delta} per rewritten tag.
function normalizeSvgAttrs(text, shifts) {
    return String(text).replace(/<[A-Za-z][^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/g, function (tag, at) {
        var out = tag.replace(/(\s[A-Za-z_:][-\w:.]*)\s*=\s*("[^"]*"|'[^']*')/g, function (all, name, quoted) {
            var v = quoted.substring(1, quoted.length - 1);
            return name + '="' + (quoted.charAt(0) === "'" ? v.replace(/"/g, "&quot;") : v) + '"';
        });
        if (shifts && out !== tag) shifts.push({ at: at, end: at + tag.length, delta: out.length - tag.length });
        return out;
    });
}

// Walks <path> and the basic shapes in document order (each is one parser
// primitive) and replaces each tag with fn(tag, i, drawn, inherited, name, at).
// `drawn` is false inside defs/clipPath/mask/pattern/symbol/marker.
// `inherited` is the paint from enclosing <svg>/<g>, since the parser
// inherits it too. parsePaintHints and identityParseCopy both use this, so
// their indices line up.
function mapPathTags(text, fn) {
    var depth = 0, i = 0, stack = [rootPresentation()];
    var re = /<(\/?)(defs|clipPath|mask|pattern|symbol|marker|g|svg)\b[^>]*>|<(path|rect|circle|ellipse|line|polyline|polygon)\b[^>]*>/g;
    return String(text).replace(re, function (tag, close, container, shape, at) {
        if (container) {
            var selfClosing = /\/>$/.test(tag);
            if (container === "g" || container === "svg") {
                if (close) { if (stack.length > 1) stack.pop(); }
                else if (!selfClosing) stack.push(presentationOf(tag, stack[stack.length - 1]));
            } else if (close) depth = Math.max(0, depth - 1);
            else if (!selfClosing) depth++;
            return tag;
        }
        return fn(tag, i++, depth === 0, stack[stack.length - 1], shape, at);
    });
}

// SVG defaults. A null fill means black.
function rootPresentation() {
    return { fill: null, stroke: null, fillOpacity: 1, strokeOpacity: 1, color: null, alpha: 1, ctm: null, classed: false };
}

// Merge an element's paint over its parent's. Group opacity is multiplied
// into its paths (only approximate where they overlap). The layer group's
// opacity (sboardx:opacity) is skipped, it goes on the layer instead.
// `classed` flags paint a stylesheet might set, which we don't read.
function presentationOf(tag, parent) {
    var c = {};
    for (var k in parent) if (parent.hasOwnProperty(k)) c[k] = parent[k];
    var color = paintValue(tag, "color");
    if (color !== null && color !== "inherit") c.color = color;
    ["fill", "stroke"].forEach(function (name) {
        var v = paintValue(tag, name);
        if (v === null || v === "inherit") return;
        c[name] = /^currentcolor$/i.test(v) ? (c.color !== null ? c.color : "#000000") : v;
    });
    var fo = paintNumber(tag, "fill-opacity"), so = paintNumber(tag, "stroke-opacity");
    if (fo !== null) c.fillOpacity = fo;
    if (so !== null) c.strokeOpacity = so;
    if (attrOf(tag, "sboardx:opacity") === null) {
        var o = paintNumber(tag, "opacity");
        if (o !== null) c.alpha = c.alpha * o;
    }
    var t = parseTransformList(attrOf(tag, "transform"));
    if (t) c.ctm = c.ctm ? composeAffine(t, c.ctm) : t;
    if (attrOf(tag, "class") !== null) c.classed = true;
    return c;
}

// 0..1, or null.
function paintNumber(tag, name) {
    var v = parseFloat(paintValue(tag, name));
    return isFinite(v) ? common.clamp01(v) : null;
}

// Basic shape to absolute M/C/Z path data (lines as degenerate cubics,
// ellipses as four cubics). null if it draws nothing.
function shapePathData(name, tag) {
    function n(a, d) { var v = parseFloat(attrOf(tag, a)); return isFinite(v) ? v : d; }
    var K = 0.5522847498307936;
    function pt(p) { return p[0] + " " + p[1]; }
    function line(a, b) { return " C " + pt(a) + " " + pt(b) + " " + pt(b); }
    function poly(pts, close) {
        if (pts.length < 2) return null;
        var s = "M " + pt(pts[0]);
        for (var k = 1; k < pts.length; k++) s += line(pts[k - 1], pts[k]);
        return close ? s + line(pts[pts.length - 1], pts[0]) + " Z" : s;
    }
    function ellipse(cx, cy, rx, ry) {
        if (!(rx > 0 && ry > 0)) return null;
        var q = [[cx + rx, cy], [cx, cy + ry], [cx - rx, cy], [cx, cy - ry]];
        var c = [[[cx + rx, cy + K * ry], [cx + K * rx, cy + ry]], [[cx - K * rx, cy + ry], [cx - rx, cy + K * ry]],
                 [[cx - rx, cy - K * ry], [cx - K * rx, cy - ry]], [[cx + K * rx, cy - ry], [cx + rx, cy - K * ry]]];
        var s = "M " + pt(q[0]);
        for (var k = 0; k < 4; k++) s += " C " + pt(c[k][0]) + " " + pt(c[k][1]) + " " + pt(q[(k + 1) % 4]);
        return s + " Z";
    }
    if (name === "rect") {
        var x = n("x", 0), y = n("y", 0), w = n("width", 0), h = n("height", 0);
        if (!(w > 0 && h > 0)) return null;
        var rx = n("rx", NaN), ry = n("ry", NaN);
        if (!isFinite(rx)) rx = ry;
        if (!isFinite(ry)) ry = rx;
        rx = isFinite(rx) ? Math.max(0, Math.min(rx, w / 2)) : 0;
        ry = isFinite(ry) ? Math.max(0, Math.min(ry, h / 2)) : 0;
        if (!(rx > 0 && ry > 0)) return poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true);
        var kx = K * rx, ky = K * ry;
        return "M " + pt([x + rx, y]) + line([x + rx, y], [x + w - rx, y]) +
               " C " + pt([x + w - rx + kx, y]) + " " + pt([x + w, y + ry - ky]) + " " + pt([x + w, y + ry]) +
               line([x + w, y + ry], [x + w, y + h - ry]) +
               " C " + pt([x + w, y + h - ry + ky]) + " " + pt([x + w - rx + kx, y + h]) + " " + pt([x + w - rx, y + h]) +
               line([x + w - rx, y + h], [x + rx, y + h]) +
               " C " + pt([x + rx - kx, y + h]) + " " + pt([x, y + h - ry + ky]) + " " + pt([x, y + h - ry]) +
               line([x, y + h - ry], [x, y + ry]) +
               " C " + pt([x, y + ry - ky]) + " " + pt([x + rx - kx, y]) + " " + pt([x + rx, y]) + " Z";
    }
    if (name === "circle") return ellipse(n("cx", 0), n("cy", 0), n("r", 0), n("r", 0));
    if (name === "ellipse") return ellipse(n("cx", 0), n("cy", 0), n("rx", 0), n("ry", 0));
    if (name === "line") return poly([[n("x1", 0), n("y1", 0)], [n("x2", 0), n("y2", 0)]], false);
    var nums = String(attrOf(tag, "points") || "").match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [], pts = [];
    for (var i = 0; i + 1 < nums.length; i += 2) pts.push([parseFloat(nums[i]), parseFloat(nums[i + 1])]);
    return poly(pts, name === "polygon");
}

// The copy we feed the parser: identity colours at opacity 1 (stroke-only
// paths get it as stroke), patterns and group opacity stripped (a group at
// 0 would make the parser drop its paths), and the marker rect at the end.
function identityParseCopy(text, hints, marker) {
    var out = mapPathTags(text, function (tag, i, drawn, inherited, name) {
        var h = hints.paths[i];
        if (!h.expected) return tag;
        var channel = h.fill !== "none" ? "fill" : "stroke";
        return withoutPaintAttrs(tag, channel).replace(new RegExp("^<" + name + "\\b"),
                                                       "<" + name + " " + channel + '="' + identityHex(i) + '" ' + channel + '-opacity="1"');
    });
    out = withoutGroupOpacity(out.replace(/<pattern\b[^>]*>[\s\S]*?<\/pattern>/g, ""));
    var rect = '<path d="M ' + marker.x0 + " " + marker.y0 + " L " + marker.x1 + " " + marker.y0 + " L " + marker.x1 + " " + marker.y1 +
               " L " + marker.x0 + " " + marker.y1 + ' Z" fill="' + identityHex(hints.paths.length) + '" fill-opacity="1" stroke="none"/>\n';
    var close = out.lastIndexOf("</svg>");
    return close >= 0 ? out.substring(0, close) + rect + out.substring(close) : out + rect;
}

// Strip channel, channel-opacity and opacity, as attributes and in style.
function withoutPaintAttrs(tag, channel) {
    var names = [channel, channel + "-opacity", "opacity"], t = String(tag);
    names.forEach(function (n) { t = t.replace(new RegExp("\\s" + n.replace(/-/g, "\\-") + '="[^"]*"', "g"), ""); });
    return t.replace(/\sstyle="([^"]*)"/, function (all, style) {
        var kept = style.split(";").filter(function (decl) {
            return /\S/.test(decl) && names.indexOf(decl.split(":")[0].replace(/^\s+|\s+$/g, "").toLowerCase()) < 0;
        });
        return kept.length ? ' style="' + kept.join(";") + '"' : "";
    });
}

// i + 1 as "#rrggbb", so black is never used.
function identityHex(i) {
    var v = i + 1;
    return common.colorHex({ r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 });
}

// Path index from the fill (or stroke) colour, or null.
function identityOf(p) {
    var c = p ? (p.fill ? p.fillColor : (p.stroke ? p.strokeColor : null)) : null;
    if (!c || typeof c.r !== "number") return null;
    var parts = [c.r, c.g, c.b], v = 0;
    for (var k = 0; k < 3; k++) {
        var x = parts[k] * 255, q = Math.round(x);
        if (!(Math.abs(x - q) < 0.01) || q < 0 || q > 255) return null;
        v = v * 256 + q;
    }
    return v - 1;
}

// {items, marker, missing, unknown}. `unknown` counts primitives we can't
// map: <use>, <text>, colours we didn't set, and a second primitive with an
// index already taken (don't trust it).
function pairPrimitives(prims, hints) {
    var n = hints.paths.length, items = [], seen = [], marker = null, unknown = 0;
    prims.forEach(function (p) {
        if (p && p.textureName) { items.push({ prim: p, hint: null }); return; }
        var k = identityOf(p);
        if (k === n && !marker) { marker = p; return; }
        if (k !== null && k >= 0 && k < n && hints.paths[k].expected && !seen[k]) {
            seen[k] = true;
            items.push({ prim: p, hint: hints.paths[k] });
            return;
        }
        unknown++;
    });
    var missing = [];
    hints.paths.forEach(function (h, i) { if (h.expected && !seen[i]) missing.push(i); });
    return { items: items, marker: marker, missing: missing, unknown: unknown };
}

// One warning per layer per kind of loss.
function reportUnpaired(env, layerName, hints, paired) {
    var expected = 0;
    hints.paths.forEach(function (h) { if (h.expected) expected++; });
    if (paired.missing.length) {
        env.log.warn("layer '" + layerName + "': " + paired.missing.length + " of " + expected +
                     " path(s) did not come back from Storyboard Pro's SVG parser and are missing (path " +
                     paired.missing.slice(0, 5).map(function (i) { return i + 1; }).join(", ") +
                     (paired.missing.length > 5 ? ", ..." : "") + " in document order)");
    }
    if (paired.unknown) env.log.warn("layer '" + layerName + "': " + paired.unknown + " shape(s) from Storyboard Pro's SVG parser match no path of the file and are left out");
    if (hints.unreadable) env.log.warn("layer '" + layerName + "': " + hints.unreadable + " path colour(s) in a form the import cannot read, drawn black");
}

// The root viewBox, else 1000 x 1000.
function artMarkerRect(svgText) {
    var root = /<svg\b[^>]*>/.exec(String(svgText || ""));
    var vb = String((root && attrOf(root[0], "viewBox")) || "").replace(/^\s+|\s+$/g, "").split(/[\s,]+/).map(parseFloat);
    if (vb.length === 4 && vb.every(isFinite) && vb[2] > 0 && vb[3] > 0) return { x0: vb[0], y0: vb[1], x1: vb[0] + vb[2], y1: vb[1] + vb[3] };
    return { x0: 0, y0: 0, x1: 1000, y1: 1000 };
}

// X = ax x + bx, Y = ay y + by, from the marker's first and third points.
// null if the marker is missing or flat.
function artPageMap(p, rect) {
    var pts = p && p.paths && p.paths[0];
    if (!pts || pts.length < 3) return null;
    var a = pts[0], b = pts[2];
    var ax = (b.x - a.x) / (rect.x1 - rect.x0), ay = (b.y - a.y) / (rect.y1 - rect.y0);
    if (!isFinite(ax) || !isFinite(ay) || ax === 0 || ay === 0) return null;
    return { ax: ax, bx: a.x - ax * rect.x0, ay: ay, by: a.y - ay * rect.y0 };
}

// Same matrix the parser gives an <image> at the pattern rect: origin at the
// rect's bottom-left, axes its width and height, whatever the pixel size.
// The rect is in the drawable's user space, so apply its ctm first.
function patternPageMatrix(pat, map, ctm) {
    function P(x, y) {
        var ux = ctm ? ctm[0] * x + ctm[2] * y + ctm[4] : x, uy = ctm ? ctm[1] * x + ctm[3] * y + ctm[5] : y;
        return { x: map.ax * ux + map.bx, y: map.ay * uy + map.by };
    }
    var o = P(pat.x, pat.y + pat.h), ex = P(pat.x + pat.w, pat.y + pat.h), ey = P(pat.x, pat.y);
    return { ox: o.x, oy: o.y, xx: ex.x - o.x, xy: ex.y - o.y, yx: ey.x - o.x, yy: ey.y - o.y };
}

// Drop opacity (attribute and style) from every <g>. The layer group's
// opacity goes on the layer, the others are already folded into the paint.
// Left in, a group at 0 makes the parser drop its paths.
function withoutGroupOpacity(text) {
    return String(text).replace(/<g\b[^>]*>/g, function (tag) {
        return tag.replace(/\sopacity="[^"]*"/, "").replace(/(\sstyle=")([^"]*)"/, function (all, head, style) {
            if (!/(^|;)\s*opacity\s*:/i.test(style)) return all;
            var kept = style.split(";").filter(function (decl) {
                return !/^\s*opacity\s*:/i.test(decl) && /\S/.test(decl);
            });
            return head + kept.map(function (decl) { return decl.replace(/^\s+|\s+$/g, ""); }).join("; ") +
                   (kept.length ? ";" : "") + '"';
        });
    });
}

// Colours go into a scratch palette on the drawing's own element, removed
// right after. The drawing keeps its own copy of each colour it uses, and
// editing an element palette doesn't move the Colour view (a scene palette
// edit does, and would flash every imported colour as a swatch). Scene
// scratch palette only when the element is unknown.
function drawSvgPage(env, art, elementId) {
    var dp = drawingPalette(env, elementId);
    var palette = dp ? dp.palette : scratchPalette(env), tracked = {};
    if (dp) env.elementScratch++;
    else env.sceneScratch++;
    try {
        var xf = pageTransform(art.page.mediaBox);
        var layers = [];
        art.items.forEach(function (item) {
            if (item.hint) applyPaintHint(env, item.prim, item.hint, art.hints, art.pageMap);
            var layer = buildPrimitiveLayer(env, item.prim, art.textures, xf, palette, tracked);
            if (layer) layers.push(layer);
        });
        if (layers.length) {
            DrawingTools.createLayers({ label: "sboardx vector import", drawing: Tools.getToolSettings().currentDrawing,
                                        art: 2, layers: layers, masks: [] });
        }
        return layers.length;
    } finally {
        if (dp) releaseDrawingPalette(env, dp);
        keepColorView(env);
    }
}

// Element of the drawing Tools.createDrawing just made current, or -1.
function currentElementId(env) {
    try {
        var cd = Tools.getToolSettings().currentDrawing;
        if (cd && cd.isValid !== false && typeof cd.elementId === "number" && cd.elementId >= 0) return cd.elementId;
        env.log.trace("the new drawing's element is unknown: " + JSON.stringify(cd));
    } catch (e) {
        env.log.trace("the new drawing's element is unknown: " + e);
    }
    return -1;
}

// {list, palette} with a free name, or null.
function drawingPalette(env, elementId) {
    if (elementId === undefined || elementId < 0) return null;
    try {
        var list = PaletteObjectManager.getPaletteListByElementId(elementId);
        if (!list) return null;
        var taken = {};
        for (var i = 0; i < list.numPalettes; i++) {
            var pal = list.getPaletteByIndex(i);
            if (pal && pal.isValid()) taken[common.fileBasename(String(pal.getName())).toLowerCase()] = true;
        }
        var name = "sboardx";
        for (var n = 2; taken[name]; n++) name = "sboardx_" + n;
        var made = list.createPalette("palette-library/" + name, list.numPalettes);
        return made && made.isValid() ? { list: list, palette: made } : null;
    } catch (e) {
        env.log.trace("element scratch palette not created: " + e);
        return null;
    }
}

// The drawing keeps its paint. The next save deletes the palette files.
function releaseDrawingPalette(env, dp) {
    try {
        if (!dp.list.removePaletteById(String(dp.palette.id))) env.log.warn("a drawing's scratch palette could not be removed (" + String(dp.palette.getName()) + ")");
    } catch (e) {
        env.log.warn("a drawing's scratch palette could not be removed (" + e + ")");
    }
}

// Parser page (y up) to drawing units, centred. With the parser's 0.75
// content scale a frame height lands on common.DRAWING_UNITS_PER_FRAME_H.
function pageTransform(mediaBox) {
    var scale = common.PARSER_PAGE_DRAWING_UNITS / (mediaBox[3] - mediaBox[1]);
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

// Identity marks a solid fill as flat for the export. With matrix: null SBP
// stores a box fit instead, same as native brush strokes. An explicit
// identity survives a save.
function flatShaderMatrix() {
    return { ox: 0, oy: 0, xx: 1, yy: 1, xy: 0, yx: 0 };
}

// Shader colour id for layers with no fill (SBP's default vectorization
// colour; unused but required), and the layer type SBP's own importers use
// for imported vector art (10000+ is app-defined).
var DEFAULT_SHADER_COLOR_ID = "0000000000000003";
var VECTOR_LAYER_TYPE = 10001;

function buildPrimitiveLayer(env, p, textures, xf, palette, tracked) {
    if (!p.fill && !p.stroke) return null;
    var polygon = transformPrimitivePoints(p, xf);
    var shaderColorId = DEFAULT_SHADER_COLOR_ID, shaderMatrix = null;
    if (p.fill) {
        var texEntry = p.textureName && textures && textures[p.textureName] ? textures[p.textureName] : null;
        var tex = p.sbxTexture || null;
        var grad = texEntry || tex ? null : gradientSpecOf(p);
        if (tex) {
            // Textured stroke: the tile becomes a texture colour placed at
            // the pattern rect. The drawing keeps its own copy.
            shaderColorId = resolveTextureColorId(palette, tex.tile, tracked, true);
            shaderMatrix = transformedShaderMatrix(tex.matrix, xf);
        } else if (texEntry) {
            shaderColorId = resolveTextureColorId(palette, texEntry, tracked, false);
            shaderMatrix = transformedShaderMatrix(p.matrix, xf);
        } else if (grad) {
            // Falls back to the first stop if the gradient colour fails.
            var gid = resolveGradientColorId(env, palette, grad, tracked);
            if (gid !== null) { shaderColorId = gid; shaderMatrix = gradientShaderMatrix(grad, p, xf); }
            else { shaderColorId = resolveSolidColorId(palette, p.fillColor, tracked); shaderMatrix = flatShaderMatrix(); }
        } else {
            shaderColorId = resolveSolidColorId(palette, p.fillColor, tracked);
            shaderMatrix = flatShaderMatrix();
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
    return strokes.length ? { shaders: [{ colorId: shaderColorId, matrix: shaderMatrix }], layerType: VECTOR_LAYER_TYPE, strokes: strokes } : null;
}

// ── Paint hints from the SVG text (sboardx 1.1) ─────────────────────────────

// Paint per drawable, read from the SVG text, inherited paint included:
//   fillRgba / strokeRgba  0..1. sboardx:rgba wins over fill/stroke. Alpha
//       includes the opacities. Pattern and gradient fills fall back to
//       sboardx:rgba, else black. Colours we can't parse are black and
//       counted in `unreadable` (so is a missing fill on a classed element
//       when there's a <style> sheet). strokeRgba is null with no stroke.
//   gradientId / patternId  from url(#id)
//   id         <path> id, null for basic shapes
//   texture    texture-file entry, filled in later by bindTextureEntries
//   fillAlpha  scales the gradient stops
//   bbox, d    path data and bounds (for objectBoundingBox gradients)
//   ctm        user space to root, or null
//   expected   it draws, so the parser has to return it
//   at         tag offset in svgText
function parsePaintHints(svgText) {
    var text = String(svgText || "");
    var hints = { paths: [], gradients: parseSvgGradients(text), patterns: parseSvgPatterns(text), textures: [], unreadable: 0 };
    var styleSheet = /<style\b/i.test(text);
    mapPathTags(text, function (tag, i, drawn, inherited, name, at) {
        function color(value, alpha) {
            var c = parseSvgColor(value);
            if (!c) { if (drawn) hints.unreadable++; c = [0, 0, 0, 1]; }
            return [c[0], c[1], c[2], c[3] * alpha];
        }
        var pres = presentationOf(tag, inherited), rgba = tagRgba(tag);
        var d = name === "path" ? attrOf(tag, "d") : shapePathData(name, tag);
        var h = { tag: name, id: name === "path" ? attrOf(tag, "id") : null, fill: pres.fill === null ? "#000000" : pres.fill,
                  fillRgba: null, strokeRgba: null, fillAlpha: null, gradientId: null, patternId: null, texture: null,
                  rgba: rgba, bbox: null, d: d, ctm: pres.ctm, expected: false, at: at };
        if (h.fill !== "none") {
            h.fillAlpha = pres.fillOpacity * pres.alpha;
            var url = /^url\(\s*#([^)\s]+)\s*\)/.exec(h.fill);
            if (url && hints.patterns[url[1]]) h.patternId = url[1];
            else if (url && hints.gradients[url[1]]) {
                h.gradientId = url[1];
                if (h.d) h.bbox = bboxOfPathData(h.d);
            }
            if (rgba) h.fillRgba = [rgba[0], rgba[1], rgba[2], rgba[3] * pres.alpha];
            else h.fillRgba = url ? [0, 0, 0, h.fillAlpha] : color(h.fill, h.fillAlpha);
            if (pres.fill === null && pres.classed && styleSheet && drawn) hints.unreadable++;
        }
        if (pres.stroke !== null && pres.stroke !== "none") h.strokeRgba = color(pres.stroke, pres.strokeOpacity * pres.alpha);
        h.expected = drawn && (name === "path" || d !== null) && (h.fill !== "none" || h.strokeRgba !== null);
        hints.paths.push(h);
        return tag;
    });
    return hints;
}

// style wins over the attribute. null if neither.
function paintValue(tag, name) {
    var style = attrOf(tag, "style");
    var m = style ? new RegExp("(?:^|;)\\s*" + name + "\\s*:\\s*([^;]+)").exec(style) : null;
    var v = m ? m[1] : attrOf(tag, name);
    return v === null ? null : String(v).replace(/^\s+|\s+$/g, "");
}

// #rgb, #rrggbb, rgb(), rgba() to [r, g, b, a] in 0..1. null otherwise.
function parseSvgColor(value) {
    var v = String(value || "").replace(/^\s+|\s+$/g, "").toLowerCase();
    var rgb = parseHexColor(v);
    if (rgb) return rgb.concat([1]);
    var m = /^rgba?\(([^)]*)\)$/.exec(v);
    if (!m) return null;
    var parts = m[1].split(/[\s,\/]+/).filter(function (x) { return x.length; });
    if (parts.length < 3 || parts.length > 4) return null;
    var out = [];
    for (var k = 0; k < parts.length; k++) {
        var n = parseFloat(parts[k]), pct = /%$/.test(parts[k]);
        if (!isFinite(n)) return null;
        out.push(common.clamp01(pct ? n / 100 : (k < 3 ? n / 255 : n)));
    }
    if (out.length === 3) out.push(1);
    return out;
}

// <pattern>s by id, in the 1.1 single-image form (read in any version):
// tile rect in user space, viewBox as the pixel rect in the atlas, and the
// href of the first <image>. A pattern with sboardx:atlas-size,
// sboardx:tile-size or an sboardx:cell element is not a valid texture: its
// paths draw flat and a drawn use is reported as damage. Any other pattern
// is skipped and its paths silently draw flat (sboardx:rgba, else black).
function parseSvgPatterns(text) {
    var out = {};
    var re = /<pattern\b([^>]*)>([\s\S]*?)<\/pattern>/g, m;
    while ((m = re.exec(text)) !== null) {
        var attrs = m[1], id = attrOf(attrs, "id");
        if (!id) continue;
        var pat = { x: parseFloat(attrOf(attrs, "x")), y: parseFloat(attrOf(attrs, "y")),
                    w: parseFloat(attrOf(attrs, "width")), h: parseFloat(attrOf(attrs, "height")) };
        if (attrOf(attrs, "sboardx:atlas-size") !== null || attrOf(attrs, "sboardx:tile-size") !== null || /\ssboardx:cell\s*=/.test(m[2])) {
            out[id] = { prerelease: true };
            continue;
        }
        var vb = String(attrOf(attrs, "viewBox") || "").replace(/^\s+|\s+$/g, "").split(/[\s,]+/);
        var img = /<image\b([^>]*)\/?>/.exec(m[2]);
        var href = img ? imageHref(img[1]) : null;
        if (!href || vb.length !== 4) continue;
        pat.ax = parseFloat(vb[0]); pat.ay = parseFloat(vb[1]); pat.aw = parseFloat(vb[2]); pat.ah = parseFloat(vb[3]);
        pat.href = href;
        var ok = pat.w > 0 && pat.h > 0 && pat.aw > 0 && pat.ah > 0;
        for (var k in pat) if (pat.hasOwnProperty(k) && k !== "href" && !isFinite(pat[k])) ok = false;
        if (ok) out[id] = pat;
    }
    return out;
}

function imageHref(attrs) {
    return attrOf(attrs, "href") || attrOf(attrs, "xlink:href");
}

// Walks the attributes in order so a value containing ` d="` can't be
// mistaken for an attribute (a regex scan would). Whitespace is space, tab,
// LF, CR only, not \s. Stops at the first thing that isn't an attribute.
// `tag` is either a whole tag or the attribute text.
function attrOf(tag, name) {
    var t = String(tag), i = 0, n = t.length;
    function space(c) { return c === " " || c === "\t" || c === "\n" || c === "\r"; }
    function skip() { while (i < n && space(t.charAt(i))) i++; }
    if (t.charAt(0) === "<") {
        i = 1;
        while (i < n && !space(t.charAt(i)) && t.charAt(i) !== "/" && t.charAt(i) !== ">") i++;
    }
    for (;;) {
        skip();
        var ns = i;
        while (i < n && "=/>\"'< \t\n\r".indexOf(t.charAt(i)) < 0) i++;
        if (i === ns) return null;
        var key = t.substring(ns, i);
        skip();
        if (t.charAt(i) !== "=") return null;
        i++;
        skip();
        var q = t.charAt(i);
        if (q !== "\"" && q !== "'") return null;
        var end = t.indexOf(q, i + 1);
        if (end < 0) return null;
        if (key === name) return t.substring(i + 1, end);
        i = end + 1;
    }
}

// Every whitespace-preceded id="X" in the tag, inside values too, as the
// spec says ("How a reader finds a listed path"). Same as the core's idsHeld.
function idsHeld(tag) {
    var out = [], p = 0;
    for (;;) {
        p = tag.indexOf("id=\"", p);
        if (p < 0) return out;
        var start = p + 4;
        if (p > 0 && isArtSpace(tag.charAt(p - 1))) {
            var end = tag.indexOf("\"", start);
            if (end < 0) return out;
            var id = tag.substring(start, end);
            if (out.indexOf(id) < 0) out.push(id);
        }
        p = start;
    }
}

// sboardx:rgba as [r, g, b, a] in 0..1, or null.
function tagRgba(tag) {
    var parts = String(attrOf(tag, "sboardx:rgba") || "").replace(/^\s+|\s+$/g, "").split(/\s+/).map(parseFloat);
    return parts.length === 4 && parts.every(isFinite) ? parts.map(common.clamp01) : null;
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

// Gradients by id. Handles the spec's form and the usual third-party ones
// (objectBoundingBox, user space, style stops, one level of href).
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

// SVG transform list to an affine. null if absent or unreadable.
function parseTransformList(text) {
    if (!text) return null;
    var re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
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
        } else if (m[1] === "skewX" && v.length === 1) t = [1, 0, Math.tan(v[0] * Math.PI / 180), 1, 0, 0];
        else if (m[1] === "skewY" && v.length === 1) t = [1, Math.tan(v[0] * Math.PI / 180), 0, 1, 0, 0];
        else return null;
        acc = composeAffine(t, acc);   // rightmost applies first
        any = true;
    }
    return any ? acc : null;
}

// Applies `first`, then `second`.
function composeAffine(first, second) {
    return [first[0] * second[0] + first[1] * second[2], first[0] * second[1] + first[1] * second[3],
            first[2] * second[0] + first[3] * second[2], first[2] * second[1] + first[3] * second[3],
            first[4] * second[0] + first[5] * second[2] + second[4], first[4] * second[1] + first[5] * second[3] + second[5]];
}

// Number, or percentage of `extent`.
function gradLen(v, fallback, extent) {
    if (v === null || v === undefined) return fallback;
    var n = parseFloat(String(v));
    if (!isFinite(n)) return fallback;
    return /%$/.test(String(v)) ? n / 100 * extent : n;
}

// Unit gradient space to user space. Linear is (0,0)->(1,0), radial the
// unit circle.
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

// Puts the real paint back on a primitive (the parser only saw the identity
// colour). A texture that resolved becomes p.sbxTexture and draws at full
// opacity, otherwise the flat fill is used. Gradients with 2+ stops become
// p.sbxGradient, a single stop is a flat colour.
function applyPaintHint(env, p, h, hints, pageMap) {
    if (p.fill) {
        p.fillColor = { r: h.fillRgba[0], g: h.fillRgba[1], b: h.fillRgba[2], a: h.fillRgba[3] };
        var pat = h.texture || (h.patternId ? hints.patterns[h.patternId] : null);
        if (pat && pat.tile && pageMap) p.sbxTexture = { tile: pat.tile, matrix: patternPageMatrix(pat, pageMap, h.ctm) };
        var g = h.gradientId ? hints.gradients[h.gradientId] : null;
        if (g && g.stops.length >= 2) {
            var stops = g.stops.map(function (s) { return { r: s.r, g: s.g, b: s.b, a: s.a * h.fillAlpha, t: s.t }; });
            p.sbxGradient = { type: g.type, stops: stops, affine: gradientUnitAffine(g, h.bbox, env.frameW, env.frameH) };
            p.fillColor = { r: stops[0].r, g: stops[0].g, b: stops[0].b, a: stops[0].a };
        } else if (g && g.stops.length === 1) {
            p.fillColor = { r: g.stops[0].r, g: g.stops[0].g, b: g.stops[0].b, a: g.stops[0].a };
        }
    }
    if (p.stroke && h.strokeRgba) p.strokeColor = { r: h.strokeRgba[0], g: h.strokeRgba[1], b: h.strokeRgba[2], a: h.strokeRgba[3] };
}

// null for a flat fill.
function gradientSpecOf(p) {
    return p.sbxGradient && p.sbxGradient.stops.length >= 2 ? p.sbxGradient : null;
}

// Fit the gradient to the primitive's bounds at the gradient's angle, like
// Upshot does.
function gradientShaderMatrix(grad, p, xf) {
    var bb = primitiveBounds(p);
    if (!bb) return null;
    var w = bb.maxX - bb.minX, h = bb.maxY - bb.minY;
    var cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
    if (grad.type === "radial") return { ox: cx, oy: cy, xx: w / 2, xy: 0, yx: 0, yy: h / 2 };
    var angle = grad.affine ? -Math.atan2(grad.affine[1], grad.affine[0]) : 0;   // page space is y-up
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

// Bridge palettes also match "<baseName>_N" (SBP numbers re-created
// palettes). Other names match exactly, never a user's "<name>_N". New
// palettes go at the end: a project opens on its first palette, which should
// stay the user's.
function findOrCreatePalette(baseName) {
    var list = PaletteObjectManager.getScenePaletteList();
    var node = common.sbpNodeName(baseName), bridge = common.isBridgePalette(baseName);
    for (var i = 0; i < list.numPalettes; i++) {
        var pal = list.getPaletteByIndex(i);
        if (!pal || !pal.isValid()) continue;
        var name = common.fileBasename(String(pal.getName()));
        if (bridge ? common.isBridgePalette(name) && name.replace(/_\d+$/, "") === baseName : name === baseName || name === node) return pal;
    }
    return list.createPalette("palette-library/" + node, list.numPalettes) || null;
}

// Fallback palette for drawings with an unknown element. One per run, under
// a fresh name ("sboardx", "sboardx_2", ...) so a palette some other run
// left behind is never touched. Removed at the end; drawings keep their
// own copies of the colours.
function scratchPalette(env) {
    if (env.scratchPalette && env.scratchPalette.isValid()) return env.scratchPalette;
    var list = PaletteObjectManager.getScenePaletteList(), taken = {};
    for (var i = 0; i < list.numPalettes; i++) {
        var pal = list.getPaletteByIndex(i);
        if (pal && pal.isValid()) taken[common.fileBasename(String(pal.getName())).toLowerCase()] = true;
    }
    var dir = common.projectDir() + "/palette-library/";
    for (var n = 1; ; n++) {
        var name = n === 1 ? "sboardx" : "sboardx_" + n;
        if (taken[name] || common.fileExists(dir + name + ".plt") || new File(dir + name + "_textures").exists) continue;
        env.scratchPalette = list.createPalette("palette-library/" + name, list.numPalettes) || null;
        break;
    }
    return env.scratchPalette;
}

// Inside the undo accumulation, so undo brings it back with the rest. The
// next save deletes the palette files.
function removeScratchPalette(env) {
    env.log.trace("drawings painted from their element's scratch palette: " + env.elementScratch + ", from the scene scratch palette: " + env.sceneScratch);
    var pal = env.scratchPalette;
    env.scratchPalette = null;
    if (!pal || !pal.isValid()) return;
    var list = PaletteObjectManager.getScenePaletteList(), id = String(pal.id);
    if (!list.removePaletteById(id)) env.log.warn("the import's scratch palette could not be removed (" + String(pal.getName()) + ")");
    keepColorView(env);
}

// Put the Colour view back after anything that may have moved it, so it
// never shows our scratch colours. Gives up after one failed restore.
function keepColorView(env) {
    if (!env.colorView || env.colorViewLost) return;
    if (!common.restoreColorView(env.colorView, env.log)) env.colorViewLost = true;
}

function findColor(palette, test) {
    for (var i = 0; i < palette.nColors; i++) {
        var c = palette.getColorByIndex(i);
        if (c && c.isValid && test(c)) return c;
    }
    return null;
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

// `unique`: an atlas tile, never matched by name since two tiles can share
// the 32-bit hash.
function resolveTextureColorId(palette, tex, tracked, unique) {
    var name = "Texture_uid_" + tex.textureHash;
    var found = unique ? null : findColor(palette, function (c) { return c.isTexture && c.name === name; });
    var id = found ? found.id : palette.createNewTexture(name, tex.textureFile, false).id;
    if (tracked) tracked[id] = true;
    return id;
}

// colorData is [{r,g,b,a,t}], 8-bit ints and t in 0..1. Named after its
// stops so it's reused. null on failure.
function resolveGradientColorId(env, palette, grad, tracked) {
    var fn = grad.type === "radial" ? "createNewRadialGradientColor" : "createNewLinearGradientColor";
    var data = grad.stops.map(function (s) {
        return { r: common.to255(s.r), g: common.to255(s.g), b: common.to255(s.b), a: common.to255(s.a), t: Math.round(s.t * 1000) / 1000 };
    });
    var name = "Gradient_" + common.shortHash(grad.type + data.map(function (st) { return "_" + st.r + "_" + st.g + "_" + st.b + "_" + st.a + "_" + st.t; }).join(""));
    var found = findColor(palette, function (c) { return !c.isTexture && c.name === name; });
    var id = found ? found.id : null;
    if (id === null) {
        try { id = palette[fn](name, data).id; }
        catch (e) { env.log.warn("gradient colour creation failed (" + e + "); using the first stop"); return null; }
    }
    tracked[id] = true;
    return id;
}

// Sets pat.tile ({textureHash, textureFile}, or null to draw flat) on every
// 1.1 pattern (cut from its atlas) and every texture-file entry (composed
// from its pages). Used by the import and the blur raster. An invalid
// texture pattern (see parseSvgPatterns) gets no tile, and drawing with it
// is damage. Returns the number
// of tiles made.
function artTextures(env, svgDir, hints, damage) {
    var patterns = hints.patterns, made = 0, id, used = {};
    hints.paths.forEach(function (h) { if (h.expected && h.patternId && !h.texture) used["#" + h.patternId] = true; });
    for (id in patterns) {
        if (!patterns.hasOwnProperty(id)) continue;
        var pat = patterns[id];
        if (!pat.prerelease) pat.tile = atlasTileTexture(env, svgDir, pat);
        else {
            pat.tile = null;
            if (used["#" + id]) textureDamage(damage, "pattern " + id + " uses an unsupported tiled texture pattern; drawn flat");
        }
    }
    var entries = hints.textures || [];
    if (entries.length) composeTiledTextures(env, entries, damage);
    for (id in patterns) if (patterns.hasOwnProperty(id) && patterns[id].tile) made++;
    entries.forEach(function (p) { if (p.tile) made++; });
    return made;
}

// {tex, link} or {why} (the spec's Link damage). The link is used as is,
// relative to ref.dir, never rebuilt.
function readTextureFile(ref) {
    var link = ref.link;
    if (typeof link !== "string") return { why: "the texture link is not a string" };
    if (!common.isTextureLink(link)) return { why: "the texture link '" + link + "' breaks the link grammar" };
    var path = ref.dir + "/" + link;
    if (!common.fileExists(path)) return { why: "the texture file " + link + " is missing" };
    var tex = common.parseTextureFileBytes(common.readFileBytes(path));
    if (tex === null) return { why: "the texture file " + link + " does not parse (ASCII JSON with finite numbers and ASCII strings)" };
    return { tex: tex, link: link };
}

// Validates a texture object against the spec. Returns {why} for Texture
// damage, else {entries, cells}. Page names are relative to rootDir.
//   cells   [{why, x, y, S, path, sx, sy, slot}]. A bad cell (not five ints,
//           off the grid, bad page, listed twice) has `why` and stays
//           transparent.
//   entries [{id, why, pat}] in `paths` order. A bad entry (bad id, view or
//           rect, no rect anywhere, duplicate id) has `why`. Otherwise `pat`
//           has the same shape as a 1.1 pattern: {S, W, H, ax ay aw ah,
//           x y w h, cells}. Without its own rect, the rect is the view's
//           share of the texture rect R.
function textureRecords(tex, rootDir) {
    var MAX = common.TEXTURE_INT_MAX, isArray = common.isArray;
    function isInt(v, lo, hi) { return typeof v === "number" && Math.floor(v) === v && v >= lo && v <= hi; }
    function ints(a, n) {
        if (!isArray(a) || a.length !== n) return null;
        for (var k = 0; k < n; k++) if (!isInt(a[k], 0, MAX)) return null;
        return a;
    }
    function rect(a) {
        if (!isArray(a) || a.length !== 4) return null;
        for (var k = 0; k < 4; k++) if (typeof a[k] !== "number" || !isFinite(a[k])) return null;
        return a[2] > 0 && a[3] > 0 ? a : null;
    }
    if (!tex || typeof tex !== "object" || isArray(tex)) return { why: "its top level is not an object" };
    var size = ints(tex.atlas_size, 2);
    if (!size || size[0] < 1 || size[1] < 1) return { why: "atlas_size is not two integers from 1 to " + MAX };
    if (!common.isValidTileSize(tex.cell_size)) return { why: "cell_size is not a power of two from 64 to 1024" };
    var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };   // JSON may have a "hasOwnProperty" key
    var R = has(tex, "rect") ? rect(tex.rect) : null;
    if (has(tex, "rect") && !R) return { why: "the texture's rect is not four numbers with a positive size" };
    if (!isArray(tex.pages) || tex.pages.some(function (n) { return typeof n !== "string"; })) return { why: "pages is not an array of strings" };
    if (!isArray(tex.cells)) return { why: "cells is not an array" };
    if (!isArray(tex.paths)) return { why: "paths is not an array" };
    var W = size[0], H = size[1], S = tex.cell_size, cols = Math.ceil(W / S), rows = Math.ceil(H / S);
    var pages = tex.pages.map(function (name) {
        return { path: rootDir + "/" + name, why: common.isPageName(name) ? "" : "page name '" + name + "' (not images/ + [A-Za-z0-9_-] + .png)" };
    });
    var cells = [], at = {};
    tex.cells.forEach(function (c, i) {
        var v = ints(c, 5), rec = { why: "", S: S };
        if (!v) rec.why = "cell " + i + " is not five integers from 0 to " + MAX;
        else if (v[0] >= cols || v[1] >= rows) rec.why = "cell " + v[0] + " " + v[1] + " is outside the " + cols + " x " + rows + " grid";
        else if (v[2] >= pages.length) rec.why = "cell " + v[0] + " " + v[1] + " names page " + v[2] + " of " + pages.length;
        else {
            rec.x = v[0] * S; rec.y = v[1] * S; rec.sx = v[3] * S; rec.sy = v[4] * S;
            rec.path = pages[v[2]].path;
            rec.slot = rec.path + "@" + rec.sx + "," + rec.sy;
            rec.why = pages[v[2]].why;
            var key = "#" + v[0] + "_" + v[1];
            (at[key] = at[key] || []).push(rec);
        }
        cells.push(rec);
    });
    for (var key in at) {
        if (!at.hasOwnProperty(key) || at[key].length < 2) continue;
        at[key].forEach(function (rec) { rec.why = "cell " + rec.x / S + " " + rec.y / S + " is listed " + at[key].length + " times"; });
    }
    var entries = [], byId = {};
    tex.paths.forEach(function (e, i) {
        var obj = !!e && typeof e === "object" && !isArray(e), id = obj ? e.id : undefined, rec = { id: null, why: "", pat: null };
        if (!obj) { rec.why = "path entry " + i + " is not an object"; entries.push(rec); return; }
        if (typeof id !== "string" || !common.TEXTURE_PATH_ID_RE.test(id)) { rec.why = "path entry " + i + " has no id of the grammar"; entries.push(rec); return; }
        rec.id = id;
        (byId["#" + id] = byId["#" + id] || []).push(rec);
        entries.push(rec);
        var view = ints(e.view, 4), own = has(e, "rect") ? rect(e.rect) : null;
        if (!view || view[2] < 1 || view[3] < 1 || view[0] + view[2] > W || view[1] + view[3] > H) {
            rec.why = "path " + id + ": its view is not four integers inside the " + W + "x" + H + " atlas";
            return;
        }
        if (has(e, "rect") && !own) { rec.why = "path " + id + ": its rect is not four numbers with a positive size"; return; }
        if (!own && !R) { rec.why = "path " + id + " has no rect and the texture none"; return; }
        var ax = view[0], ay = view[1], aw = view[2], ah = view[3];
        var pat = { S: S, W: W, H: H, ax: ax, ay: ay, aw: aw, ah: ah, cells: [] };
        if (own) { pat.x = own[0]; pat.y = own[1]; pat.w = own[2]; pat.h = own[3]; }
        else { pat.x = R[0] + ax * R[2] / W; pat.y = R[1] + ay * R[3] / H; pat.w = aw * R[2] / W; pat.h = ah * R[3] / H; }
        cells.forEach(function (c) {
            if (!c.why && c.x < ax + aw && c.x + S > ax && c.y < ay + ah && c.y + S > ay) pat.cells.push(c);
        });
        rec.pat = pat;
    });
    for (var k in byId) {
        if (!byId.hasOwnProperty(k) || byId[k].length < 2) continue;
        byId[k].forEach(function (rec) { rec.why = "the id " + rec.id + " is listed by " + byId[k].length + " path entries"; rec.pat = null; });
    }
    return { entries: entries, cells: cells };
}

// Binds texture entries to paths, per the spec. Works on the raw art text.
// If the art check fails, no texture applies. Each good entry textures the
// one path tag holding its id, unless the tag breaks a Path-entry rule (no
// match, several, not in the listed form, bad d, fill none or url()). Then
// the path draws plain. The tag is mapped to its hint by offset. Page damage
// is found later, in composeTiledTextures. A broken link is always reported,
// whatever the paths.
function bindTextureEntries(env, hints, ref, damage, art) {
    hints.textures = [];
    if (!ref) return;
    var file = readTextureFile(ref);
    if (file.why) { textureDamage(damage, file.why); return; }
    var raw = art ? String(art.raw || "") : "";
    var artWhy = art ? artSyntaxProblem(raw, !!art.bom) : "";
    if (artWhy) { textureDamage(damage, "the art " + artWhy + ", so its texture file is not applied"); return; }
    var recs = textureRecords(file.tex, normalizePath(env.extractDir));
    if (recs.why) { textureDamage(damage, "the texture file " + file.link + ": " + recs.why); return; }
    // Count each fact once, like other readers do. One bad page can hit
    // several cells.
    var told = {};
    function tell(why) {
        if (told.hasOwnProperty("#" + why)) return;
        told["#" + why] = true;
        textureDamage(damage, why);
    }
    recs.cells.forEach(function (c) { if (c.why) tell(c.why); });
    var byId = {};
    artPathTags(raw).forEach(function (t) {
        idsHeld(t.text).forEach(function (id) { (byId["#" + id] = byId["#" + id] || []).push(t); });
    });
    var hintAt = {};
    hints.paths.forEach(function (h) { if (h.tag === "path" && typeof h.at === "number") hintAt["#" + h.at] = h; });
    recs.entries.forEach(function (e) {
        if (e.why) { tell(e.why); return; }
        var ts = byId.hasOwnProperty("#" + e.id) ? byId["#" + e.id] : [], why = "", h = null;
        if (!ts.length) why = "no <path> carries the listed id " + e.id;
        else if (ts.length > 1) why = ts.length + " <path>s carry the id " + e.id;
        else why = listedPathProblem(ts[0].text, e.id);
        if (!why) {
            var at = artTextOffset(art, ts[0].at);
            h = hintAt.hasOwnProperty("#" + at) ? hintAt["#" + at] : null;
            if (!h) why = "the path " + e.id + " lies inside another tag of the art";
        }
        if (why) { textureDamage(damage, why); return; }
        h.texture = e.pat;
        hints.textures.push(e.pat);
    });
}

// The spec's art check: no `<!`, and no `<?` except an XML declaration at
// byte 0. A BOM counts as a byte before it. File.read may drop or keep the
// BOM, hence the `bom` flag. "" if fine, else why. Same as the core's
// artSyntaxProblem.
function artSyntaxProblem(raw, bom) {
    var text = String(raw);
    if (text.charCodeAt(0) === 0xfeff) { text = text.substring(1); bom = true; }
    if (text.indexOf("<!") >= 0) return "holds '<!' (a document type declaration, comment or CDATA section)";
    var q = text.indexOf("<?");
    if (q < 0) return "";
    var declaration = !bom && q === 0 && text.length > 5 && text.substring(0, 5) === "<?xml" && isArtSpace(text.charAt(5));
    if (!declaration || text.indexOf("<?", 1) >= 0) return "holds '<?' other than in an XML declaration opening the file";
    return "";
}

// Space, tab, LF, CR. Not \s, which matches more.
function isArtSpace(c) { return c === " " || c === "\t" || c === "\n" || c === "\r"; }

// Path tags per the spec: `<path` + whitespace up to the next `>` (or end
// of text). [{at, text}]. Same as the core's nextPathTag.
function artPathTags(raw) {
    var out = [], from = 0, n = raw.length;
    for (;;) {
        var p = raw.indexOf("<path", from);
        if (p < 0) return out;
        if (p + 5 < n && isArtSpace(raw.charAt(p + 5))) {
            var gt = raw.indexOf(">", p + 5), end = gt < 0 ? n : gt + 1;
            out.push({ at: p, text: raw.substring(p, end) });
            from = end;
        } else from = p + 5;
    }
}

// Spec checks on a listed path, in the core's order: form, d, fill.
// "" if it passes.
function listedPathProblem(tag, id) {
    var attrs = {};
    var form = listedFormProblem(tag, attrs);
    if (form) return "listed path " + id + ": its tag is not in the listed form (" + form + ")";
    // Use the parsed pairs, a value may contain ` d="`.
    var d = attrs.hasOwnProperty("#d") ? attrs["#d"] : null;
    if (d === null || !pathDialectOk(d)) return "the d of listed path " + id + " is not in the path dialect";
    var fill = attrs.hasOwnProperty("#fill") ? attrs["#fill"] : null;
    if (!fill) fill = "#000000";
    if (fill === "none" || fill.indexOf("url(") === 0) return "listed path " + id + " has no plain colour fill (" + fill + ")";
    return "";
}

// The spec's listed form (art SVG syntax, rule 4): one self-closing <path>,
// attributes name="value" each after whitespace, no space around `=`, no
// `"` `<` `>` `&` in values, names ([A-Za-z_][A-Za-z0-9_.-]*:)?[A-Za-z_][A-Za-z0-9_.-]*,
// no duplicates, id and d present, no style/transform/xmlns/xmlns:*.
// "" if it conforms, and then `attrs` gets the values under "#" + name.
// Same as the core's listedFormProblem.
function listedFormProblem(tag, attrs) {
    var notForm = "not one self-closing tag of name=\"value\" attributes";
    var n = tag.length;
    if (n < 7 || tag.charAt(n - 1) !== ">" || tag.charAt(n - 2) !== "/") return notForm;
    function nameStart(c) { return (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_"; }
    function nameChar(c) { return nameStart(c) || (c >= "0" && c <= "9") || c === "." || c === "-"; }
    var stop = n - 2, i = 5, names = {};
    for (;;) {
        var sep = i;
        while (i < stop && isArtSpace(tag.charAt(i))) i++;
        if (i === stop) break;
        if (i === sep) return notForm;   // needs whitespace before
        var ns = i;
        if (!nameStart(tag.charAt(i))) return notForm;
        i++;
        while (i < stop && nameChar(tag.charAt(i))) i++;
        if (i < stop && tag.charAt(i) === ":") {
            i++;
            if (i >= stop || !nameStart(tag.charAt(i))) return notForm;
            i++;
            while (i < stop && nameChar(tag.charAt(i))) i++;
        }
        var name = tag.substring(ns, i);
        if (i + 1 >= stop || tag.charAt(i) !== "=" || tag.charAt(i + 1) !== "\"") return notForm;
        i += 2;
        var vs = i;
        while (i < stop && tag.charAt(i) !== "\"") {
            var c = tag.charAt(i);
            if (c === "<" || c === ">" || c === "&") return notForm;
            i++;
        }
        if (i >= stop) return notForm;   // unclosed value
        if (names.hasOwnProperty("#" + name)) return "it carries " + name + " twice";
        names["#" + name] = tag.substring(vs, i);
        i++;
        if (name === "style" || name === "transform" || name === "xmlns" || name.indexOf("xmlns:") === 0) return "it carries " + name;
    }
    if (!names.hasOwnProperty("#id") || !names.hasOwnProperty("#d")) return "it lacks id or d";
    if (attrs) for (var k in names) if (names.hasOwnProperty(k)) attrs[k] = names[k];
    return "";
}

// The spec's path dialect (art SVG syntax, rule 5): absolute M L Q C Z/z,
// starting with M, full number groups per command. Numbers are SVG decimals
// (sign, digits, optional fraction, optional exponent) and must be finite
// doubles, so 1e400, hex, inf and nan fail. A number ends where the grammar
// stops: "1-2" is two numbers, "0.5.5" is 0.5 and .5. Separators are space,
// tab, LF, CR and comma. At least one segment must be drawn. Same as the
// core's parsePathD.
function pathDialectOk(d) {
    var i = 0, n = d.length;
    function skip() {
        while (i < n && (isArtSpace(d.charAt(i)) || d.charAt(i) === ",")) i++;
    }
    function digit(k) { return k < n && d.charAt(k) >= "0" && d.charAt(k) <= "9"; }
    function num() {
        skip();
        var k = i, digits = 0;
        if (k < n && (d.charAt(k) === "+" || d.charAt(k) === "-")) k++;
        while (digit(k)) { k++; digits++; }
        if (k < n && d.charAt(k) === ".") {
            k++;
            while (digit(k)) { k++; digits++; }
        }
        if (!digits) return false;
        if (k < n && (d.charAt(k) === "e" || d.charAt(k) === "E")) {
            var x = k + 1;
            if (x < n && (d.charAt(x) === "+" || d.charAt(x) === "-")) x++;
            if (digit(x)) {
                while (digit(x)) x++;
                k = x;
            }
        }
        if (!isFinite(Number(d.substring(i, k)))) return false;
        i = k;
        return true;
    }
    function pair() { return num() && num(); }
    function nextIsNumber() {
        skip();
        if (i >= n) return false;
        var c = d.charAt(i);
        return (c >= "0" && c <= "9") || c === "-" || c === "+" || c === ".";
    }
    // segs: segments in this subpath, open: started by M, drawn: subpaths
    // with at least one segment.
    var segs = 0, open = false, drawn = 0, first = true;
    function flush() {
        if (open && segs) drawn++;
        segs = 0;
        open = false;
    }
    for (;;) {
        skip();
        if (i >= n) break;
        var cmd = d.charAt(i++);
        if (first && cmd !== "M") return false;
        first = false;
        if (cmd === "M") {
            flush();
            if (!pair()) return false;
            open = true;
            while (nextIsNumber()) {   // extra pairs after M are lines
                if (!pair()) return false;
                segs++;
            }
        } else if (cmd === "L") {
            do { if (!pair()) return false; segs++; } while (nextIsNumber());
        } else if (cmd === "Q") {
            do { if (!pair() || !pair()) return false; segs++; } while (nextIsNumber());
        } else if (cmd === "C") {
            do { if (!pair() || !pair() || !pair()) return false; segs++; } while (nextIsNumber());
        } else if (cmd === "Z" || cmd === "z") {
            if (open) flush();
        } else return false;
    }
    flush();
    return drawn > 0;
}

// Raw offset to normalized offset. -1 if it falls inside a rewritten tag.
function artTextOffset(art, rawAt) {
    var at = rawAt, shifts = (art && art.shifts) || [];
    for (var k = 0; k < shifts.length; k++) {
        var s = shifts[k];
        if (s.end <= rawAt) at += s.delta;
        else if (s.at <= rawAt) return -1;
    }
    return at;
}

function textureDamage(damage, why) {
    damage.count++;
    if (!damage.first) damage.first = why;
}

// Cuts a 1.1 pattern's tile out of its atlas into a PNG. null if the atlas
// is unusable, and the path draws flat.
function atlasTileTexture(env, svgDir, pat) {
    var atlasPath = normalizePath(svgDir + "/" + pat.href);
    var img = env.atlasCache[atlasPath];
    if (img === undefined) {
        img = common.fileExists(atlasPath) ? new QImage(atlasPath) : null;
        if (img && img.isNull()) img = null;
        if (!img) env.log.warn("atlas missing or unreadable for a textured stroke: " + atlasPath);
        else noteDecode(env, img);
        env.atlasCache[atlasPath] = img;
    }
    if (!img) return null;
    var ax = Math.round(pat.ax), ay = Math.round(pat.ay), aw = Math.round(pat.aw), ah = Math.round(pat.ah);
    if (aw <= 0 || ah <= 0 || ax < 0 || ay < 0 || ax + aw > img.width() || ay + ah > img.height()) {
        env.log.warn("atlas tile outside the image (" + atlasPath + ": " + ax + "," + ay + " " + aw + "x" + ah + ")");
        return null;
    }
    var key = common.shortHash(atlasPath + "#" + ax + "," + ay + "," + aw + "," + ah);
    var tilePath = env.extractDir + "/_tiles/tile_" + key + "_" + (++env.tileSeq) + ".png";
    noteComposed(env, aw, ah);
    return img.copy(ax, ay, aw, ah).save(tilePath, "PNG") ? { textureHash: key, textureFile: tilePath } : null;
}

// Gives every entry its `tile`. Each page is decoded once, one at a time, in
// byte order of its path. We cut the slots we need (QImage.copy is exact),
// drop the page, compose every entry whose last page that was, and release
// slots nobody still needs. Peak memory is one page plus the slots of the
// entries spanning it. A bad page (missing, not a PNG Qt reads, side
// outside 1..2048) or a slot outside its page leaves its cells
// transparent, counted once per slot.
function composeTiledTextures(env, pats, damage) {
    var pages = {}, names = [], order = {}, cut = {}, live = 0, last = [];
    pats.forEach(function (p) {
        p.cells.forEach(function (c) {
            if (!pages.hasOwnProperty(c.path)) { pages[c.path] = { path: c.path, slots: [] }; names.push(c.path); }
            if (!cut.hasOwnProperty(c.slot)) { cut[c.slot] = { img: null, refs: 0, why: "", counted: false }; pages[c.path].slots.push(c); }
        });
    });
    names.sort(common.byteOrder);
    names.forEach(function (path, k) { order[path] = k; });
    // Last page per entry, and refcounts per slot.
    pats.forEach(function (p, i) {
        last[i] = -1;
        p.cells.forEach(function (c) {
            if (order[c.path] > last[i]) last[i] = order[c.path];
            cut[c.slot].refs++;
        });
    });
    function finish(i) {
        var p = pats[i];
        p.tile = tiledTileTexture(env, p, cut, damage);
        p.cells.forEach(function (c) {
            var e = cut[c.slot];
            if (--e.refs > 0 || !e.img) return;
            releaseImage(env, e.img);
            e.img = null;
            live--;
        });
    }
    for (var i = 0; i < pats.length; i++) if (last[i] < 0) finish(i);   // no pages
    names.forEach(function (path, k) {
        var pg = pages[path], page = decodePage(env, path), name = common.fileBasename(path);
        pg.slots.forEach(function (c) {
            var e = cut[c.slot], S = c.S;
            if (!page.img) { e.why = page.why; return; }
            var w = page.img.width(), h = page.img.height();
            if (c.sx + S > w || c.sy + S > h) {
                e.why = "the slot " + c.sx / S + " " + c.sy / S + " is not inside the " + w + "x" + h + " page " + name;
                return;
            }
            e.img = page.img.copy(c.sx, c.sy, S, S);
            if (++live > env.cellStats.cells) env.cellStats.cells = live;
        });
        releasePage(env);
        for (var j = 0; j < pats.length; j++) if (last[j] === k) finish(j);
    });
}

// Frees the current page's pixels now.
function releasePage(env) {
    if (!env.pageImage || env.pageImage.isNull()) return;
    releaseImage(env, env.pageImage);
    env.cellStats.livePages--;
}

// A failed load nulls the image and frees its pixels right away. Dropping
// the reference would leave them to the script GC.
function releaseImage(env, img) {
    if (img && !img.isNull()) img.load(env.extractDir + "/_tiles/no-page.png", "PNG");
}

// Decodes into env.pageImage. {img} or {img: null, why}. Release the old page
// first: QImage::load decodes into a temporary while still holding the old
// pixels, so we'd have two pages in memory. The header is checked before
// decoding (common.pngPageProblem), so a decode is never bigger than a page.
// The decode itself catches pixels Qt cannot read. Either way the cells go
// transparent and get reported. Page sides don't have to be multiples of S.
function decodePage(env, path) {
    var name = common.fileBasename(path), broken = common.pngPageProblem(path);
    if (broken) return { img: null, why: "page " + name + " " + broken };
    releasePage(env);
    if (!env.pageImage) env.pageImage = new QImage();
    if (!env.pageImage.load(path, "PNG") || env.pageImage.isNull()) {
        return { img: null, why: "page " + name + " is not a PNG Qt can read (its pixels do not decode)" };
    }
    if (++env.cellStats.livePages > env.cellStats.held) env.cellStats.held = env.cellStats.livePages;
    noteDecode(env, env.pageImage);
    if (!env.cellStats.pageSeen[path]) { env.cellStats.pageSeen[path] = true; env.cellStats.pages++; }
    return { img: env.pageImage };
}

// Composes an entry's cells into one transparent image the size of its view
// and saves it as the texture PNG. CompositionMode_Source onto ARGB32
// copies pixels exactly. Missing slots stay transparent, counted once.
function tiledTileTexture(env, pat, cut, damage) {
    var ax = pat.ax, ay = pat.ay, aw = pat.aw, ah = pat.ah;
    var img = new QImage(aw, ah, QImage.Format_ARGB32);
    img.fill(0);
    var painter = new QPainter(), parts = [];
    painter.begin(img);
    painter.setCompositionMode(QPainter.CompositionMode_Source);
    pat.cells.forEach(function (c) {
        var e = cut[c.slot];
        if (!e.img) {
            if (!e.counted) { e.counted = true; textureDamage(damage, e.why || "the cell at " + c.x + "," + c.y + " was not read"); }
            return;
        }
        painter.drawImage(c.x - ax, c.y - ay, e.img);
        parts.push(c.slot + "@" + c.x + "," + c.y);
    });
    painter.end();
    env.cellStats.composed++;
    noteComposed(env, aw, ah);
    var key = common.shortHash(parts.join("|") + "#" + ax + "," + ay + "," + aw + "," + ah);
    var tilePath = env.extractDir + "/_tiles/tile_" + key + "_" + (++env.tileSeq) + ".png";
    return img.save(tilePath, "PNG") ? { textureHash: key, textureFile: tilePath } : null;
}

function noteComposed(env, w, h) {
    var st = env.cellStats;
    if (w * h > st.composedLargest) { st.composedLargest = w * h; st.composedW = w; st.composedH = h; }
}

function noteDecode(env, img) {
    var st = env.cellStats, px = img.width() * img.height();
    st.decoded++;
    if (px > st.largest) { st.largest = px; st.largestW = img.width(); st.largestH = img.height(); }
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

// A one-<image> SVG placing the image by its transform (pixel rect centred
// on the origin). The vector importer turns it into a textured primitive.
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

// Import through a wrapper SVG as a textured vector layer, then merge with
// an empty bitmap layer to get a real bitmap layer.
function importImageAsBitmapLayer(env, panelId, srcId, layer, layerIndex) {
    var imgRel = String(layer.image.file), imgPath = env.extractDir + "/" + imgRel;
    if (!common.fileExists(imgPath)) { env.log.warn("raster layer '" + layer.name + "': embedded image missing (" + imgRel + ")"); return false; }
    if (!layer.image.w || !layer.image.h) { env.log.warn("raster layer '" + layer.name + "': image size missing in layers.json"); return false; }
    var imgBase = common.fileBasename(imgRel);
    var wrapperPath = common.fileDirname(imgPath) + "/" + imgBase + "." + srcId + "_" + layerIndex + ".wrapper.svg";
    common.writeTextFile(wrapperPath, imageWrapperSvg(env, layer, imgBase));
    var name = layer.name ? String(layer.name) : ("Image " + (layerIndex + 1));
    if (!importSvgAsVectorLayer(env, panelId, wrapperPath, name)) return false;
    // mergeLayers with a taken name bumps the last character ("Matte" ->
    // "Mattg"). configureImportedLayers fixes the name later.
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

// QImage::Format_RGBA64_Premultiplied. The script engine doesn't expose the
// name, the number works.
var FORMAT_RGBA64_PREMULTIPLIED = 27;

// Separable Gaussian blur on ARGB32 premultiplied. Each tap scales a 16-bit
// copy with DestinationIn, then Plus-adds it at opacity 1. Don't use painter
// opacity with Plus: Qt blends the sum back toward the destination instead
// of adding. Integer weights sum to exactly 65535, so flat areas stay exact.
function gaussianBlur(img, sigmaPx) {
    if (!(sigmaPx > 0)) return img;
    var w = img.width(), h = img.height();
    var R = Math.max(1, Math.ceil(3 * sigmaPx)), stride = Math.max(1, Math.ceil(R / 32));
    var offs = [], ws = [];
    for (var i = 0; i <= R; i += stride) {
        offs.push(i);
        ws.push(Math.exp(-(i * i) / (2 * sigmaPx * sigmaPx)));
    }
    var k = blurTapWeights(ws, 65535);
    function copyInto(dst, src) {
        dst.fill(0);
        var q = new QPainter();
        q.begin(dst);
        q.setCompositionMode(QPainter.CompositionMode_Source);
        q.drawImage(0, 0, src);
        q.end();
        return dst;
    }
    var scaled = new QImage(w, h, FORMAT_RGBA64_PREMULTIPLIED);
    function axis(input, horizontal) {
        var acc = new QImage(w, h, FORMAT_RGBA64_PREMULTIPLIED);
        acc.fill(0);
        var p = new QPainter();
        p.begin(acc);
        p.setCompositionMode(QPainter.CompositionMode_Plus);
        for (var t = 0; t < offs.length; t++) {
            if (k[t] <= 0) continue;
            copyInto(scaled, input);
            var weight = new QColor(0, 0, 0);
            weight.setAlphaF(k[t] / 65535);
            var q = new QPainter();
            q.begin(scaled);
            q.setCompositionMode(QPainter.CompositionMode_DestinationIn);
            q.fillRect(0, 0, w, h, weight);
            q.end();
            var o = offs[t];
            p.drawImage(horizontal ? o : 0, horizontal ? 0 : o, scaled);
            if (o !== 0) p.drawImage(horizontal ? -o : 0, horizontal ? 0 : -o, scaled);
        }
        p.end();
        return acc;
    }
    var blurred = axis(axis(copyInto(new QImage(w, h, FORMAT_RGBA64_PREMULTIPLIED), img), true), false);
    return copyInto(new QImage(w, h, QImage.Format_ARGB32_Premultiplied), blurred);
}

// Integer weights summing to `total` over the symmetric kernel (offset 0
// once, others twice), by largest remainder.
function blurTapWeights(ws, total) {
    var sum = ws[0], i;
    for (i = 1; i < ws.length; i++) sum += 2 * ws[i];
    var k = [], rem = [], used = 0;
    for (i = 0; i < ws.length; i++) {
        var x = total * ws[i] / sum;
        k.push(Math.floor(x));
        rem.push(x - Math.floor(x));
        used += (i === 0 ? 1 : 2) * k[i];
    }
    var left = total - used;
    if (left % 2 === 1) { k[0]++; left--; }
    while (left >= 2) {
        var best = -1;
        for (i = 1; i < ws.length; i++) if (best < 0 || rem[i] > rem[best]) best = i;
        if (best < 0 || rem[best] < 0) { k[0] += left; break; }
        k[best]++;
        rem[best] = -1;
        left -= 2;
    }
    return k;
}

// Max side of the blur raster in pixels. Unrelated to SBP's render cap,
// even if it's the same number.
var BLUR_RASTER_MAX_SIDE = 4096;

// SBP has no layer blur, so render the layer with Qt (same paint as the
// vector import, textures included) and blur the result.
function renderBlurredVectorPng(env, layer, artPath, srcId, layerIndex, texRef) {
    var art = readArt(artPath), svgText = art.text;
    if (!svgText) return null;
    var hints = parsePaintHints(svgText), damage = { count: 0, first: "" }, svgDir = common.fileDirname(artPath);
    var fills = [], box = null, unreadable = false;
    bindTextureEntries(env, hints, texRef, damage, art);
    withArtCache(env, function () {
        artTextures(env, svgDir, hints, damage);
        for (var i = 0; i < hints.paths.length && !unreadable; i++) {
            var h = hints.paths[i];
            if (!h.expected) continue;
            var path = h.d ? painterPathFromD(h.d) : null;
            if (!path) { unreadable = true; break; }
            var brush = hintBrush(env, h, hints);
            if (!brush) continue;
            var r = path.boundingRect(), m = h.ctm || [1, 0, 0, 1, 0, 0];
            [[r.x(), r.y()], [r.x() + r.width(), r.y()], [r.x(), r.y() + r.height()], [r.x() + r.width(), r.y() + r.height()]].forEach(function (q) {
                var x = m[0] * q[0] + m[2] * q[1] + m[4], y = m[1] * q[0] + m[3] * q[1] + m[5];
                box = box ? { minX: Math.min(box.minX, x), minY: Math.min(box.minY, y), maxX: Math.max(box.maxX, x), maxY: Math.max(box.maxY, y) }
                          : { minX: x, minY: y, maxX: x, maxY: y };
            });
            fills.push({ path: path, brush: brush, ctm: h.ctm });
        }
    });
    reportTextureDamage(env, layer.name ? String(layer.name) : "Layer " + (layerIndex + 1), damage);
    if (unreadable) return null;
    if (!box || (!(box.maxX > box.minX) && !(box.maxY > box.minY))) return null;
    var pad = 3 * layer.blur;
    var minX = box.minX - pad, minY = box.minY - pad, maxX = box.maxX + pad, maxY = box.maxY + pad;
    var ppu = env.resH > 0 ? env.resH / env.frameH : 2;
    var maxSide = Math.max(maxX - minX, maxY - minY) * ppu;
    if (maxSide > BLUR_RASTER_MAX_SIDE) ppu *= BLUR_RASTER_MAX_SIDE / maxSide;
    var pxW = Math.max(1, Math.ceil((maxX - minX) * ppu)), pxH = Math.max(1, Math.ceil((maxY - minY) * ppu));
    var img = new QImage(pxW, pxH, QImage.Format_ARGB32_Premultiplied);
    img.fill(0);
    var p = new QPainter();
    p.begin(img);
    p.setRenderHint(QPainter.Antialiasing, true);
    p.setRenderHint(QPainter.SmoothPixmapTransform, true);
    p.scale(ppu, ppu);
    p.translate(-minX, -minY);
    fills.forEach(function (f) {
        if (!f.ctm) { p.fillPath(f.path, f.brush); return; }
        p.save();
        p.setTransform(new QTransform(f.ctm[0], f.ctm[1], f.ctm[2], f.ctm[3], f.ctm[4], f.ctm[5]), true);
        p.fillPath(f.path, f.brush);
        p.restore();
    });
    p.end();
    var outRel = "panels/" + srcId + "/" + String(layer.art) + "." + layerIndex + ".blurred.png";
    if (!gaussianBlur(img, layer.blur * ppu).save(env.extractDir + "/" + outRel, "PNG")) return null;
    return { name: layer.name, image: { file: outRel, w: pxW, h: pxH,
             transform: [1 / ppu, 0, 0, 1 / ppu, minX + pxW / (2 * ppu), minY + pxH / (2 * ppu)] } };
}

// Padded for the blur's reach.
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

// Absolute M/C/Z only, which is what sboardx writers emit.
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

// Texture brush (same tile as the vector import), else gradient, else flat
// colour. null for no fill.
function hintBrush(env, h, hints) {
    var pat = h.texture || (h.patternId ? hints.patterns[h.patternId] : null);
    if (pat) {
        var tex = pat.tile ? new QImage(pat.tile.textureFile) : null;
        if (tex && !tex.isNull() && tex.width() > 0 && tex.height() > 0) {
            var tb = new QBrush(tex);
            tb.setTransform(new QTransform(pat.w / tex.width(), 0, 0, pat.h / tex.height(), pat.x, pat.y));
            return tb;
        }
    }
    var g = h.gradientId ? hints.gradients[h.gradientId] : null;
    if (g && g.stops.length) {
        var M = gradientUnitAffine(g, h.bbox, env.frameW, env.frameH);
        if (g.stops.length === 1 || !M) return new QBrush(qColor([g.stops[0].r, g.stops[0].g, g.stops[0].b, g.stops[0].a]));
        var qg = g.type === "radial" ? new QRadialGradient(0, 0, 1) : new QLinearGradient(0, 0, 1, 0);
        g.stops.forEach(function (s) { qg.setColorAt(s.t, qColor([s.r, s.g, s.b, s.a])); });
        var brush = new QBrush(qg);
        brush.setTransform(new QTransform(M[0], M[1], M[2], M[3], M[4], M[5]));   // x' = m11 x + m21 y + dx
        return brush;
    }
    return h.fillRgba ? new QBrush(qColor(h.fillRgba)) : null;
}

// ── Audio ───────────────────────────────────────────────────────────────────

function pathUrl(path) {
    var p = String(path).replace(/\\/g, "/");
    return "file://localhost" + encodeURI(p.charAt(0) === "/" ? p : "/" + p);
}

// audio/clips.json as Final Cut XML for the animatic import. One track per
// sboardx track, muted ones disabled.
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

// Goes through the animatic import, which needs a session. In batch it
// just logs a warning.
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
exports.panelBaseDigest = panelBaseDigest;
exports.traceTextureDecodes = traceTextureDecodes;
exports.panelToken = panelToken;
exports.applySceneCamera = applySceneCamera;
exports.importAudio = importAudio;
exports.removeScratchPalette = removeScratchPalette;
exports.keepColorView = keepColorView;
exports.globalStartFrameOf = globalStartFrameOf;
exports.sharedDrawingsNote = sharedDrawingsNote;
exports.planSharedDrawings = planSharedDrawings;
