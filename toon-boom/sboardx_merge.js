// sboardx_merge.js: "Update from .sboardx", behind TB_MergeSboardx.js.
// Needs sboardx_common.js, sboardx_import.js and sboardx_export.js beside it.
//
// 3-way, panel-level merge of an .sboardx into the open project, same rules
// as Upshot's. Uses the archive digest (archivePanelDigest) and the id map
// (sboardx-ids metadata, keyed by native ids). Per archive panel, by id:
//   unknown here                            -> added, at its archive position
//   archive digest == map.digest            -> unchanged (the digest is the
//                                              base the archive declares for
//                                              the panel, else its bytes')
//   archive changed, unchanged here         -> updated (replaced whole)
//   both changed, or no baseline            -> conflict: Keep mine / Take theirs
//   native panels absent from the archive   -> removed (kept unless asked)
//   position differs                        -> moved: re-created at the
//                                              archive's slot (no move API)
// "Unchanged here" means the fingerprint now equals map.fp from the last
// exchange. No fp, no baseline, so a panel changed in the file asks.
// Scene cameras use the same table (applyCameras). Audio is replaced whole,
// only when asked. One undo step, saved on success.

var common = require("./sboardx_common.js");
var imp = require("./sboardx_import.js");
var exp = require("./sboardx_export.js");

// An import env plus the merge's own state.
function makeMergeEnv(log, quiet, options) {
    var env = imp.makeImportEnv(log, quiet, options);
    env.mergeCounts = { updated: 0, added: 0, removed: 0, moved: 0, kept: 0, conflicts: 0, unchanged: 0,
                        recreated: 0, scenesAdded: 0, cameras: 0, camerasKept: 0, audio: false };
    env.stampAfter = [];   // panels filled from the archive, stamped at the end
    env.xenv = null;       // export env for own forms and live cameras, made after the save
    return env;
}

// options (batch): { takeTheirs: "all" | [archive panel ids], deleteRemoved: bool,
//                    keepInPlace: [archive panel ids], takeCameras: "all" | [archive scene ids],
//                    takeAudio: bool }
function mergeFromFile(zipPath, quiet, options) {
    var log = common.makeLog("[sboardx-merge] ", quiet);
    if (!common.requireApi(log)) return false;
    var env = makeMergeEnv(log, quiet, options);
    // "Changed here?" reads drawings from the saved files.
    if (!common.ensureProjectSaved(log, quiet, "The update")) {
        log.report("Update cancelled: the project was not saved.\n\nSave it (File > Save) and run the update again.", true);
        return false;
    }
    env.progress = common.makeProgress("Updating from .sboardx", quiet);
    env.progress.busy("Extracting the archive…");
    if (!imp.extractArchive(env, String(zipPath))) { env.progress.close(); return false; }
    env.progress.busy("Reading the archive…");
    if (!imp.loadSboardx(env)) { env.progress.close(); return false; }

    env.progress.busy("Comparing with the project…");
    env.idMap = common.loadIdMap(env.sb, log);
    env.xenv = exp.makeExportEnv(log, "");
    env.xenv.idMap = env.idMap;
    var plan = computePlan(env);
    imp.planSharedDrawings(env);   // before anything changes
    env.progress.close();

    var res = resolvePlan(env, plan);
    if (!res) {
        log.report("Update cancelled. The project was not changed.", true);
        return false;
    }
    if (!plan.hasChanges && !res.takeAudio) {
        log.report("Nothing to update: the file matches this project.", false);
        return true;
    }

    env.progress = common.makeProgress("Updating from .sboardx", quiet);
    // No backup, no merge.
    env.backup = common.backupProject(log, env.progress, "The update");
    if (!env.backup.ok) { env.progress.close(); log.report(env.backup.message, true); return false; }
    // Palette edits move the Colour view, put it back whatever happens.
    var colorView = common.captureColorView();
    env.colorView = colorView;
    project.beginUndoRedoAccum("Update from sboardx");
    try {
        imp.applyProjectSettings(env);
        env.progress.begin(env.sequenceJson.panels.length);
        applyPlan(env, plan, res);
        imp.removeScratchPalette(env);
        project.endUndoRedoAccum();
    } catch (err) {
        project.cancelUndoRedoAccum();
        common.restoreColorView(colorView, log);
        env.progress.close();
        if (err && err.sboardxCancelled) log.report("Update cancelled. The project was not changed.", true);
        else log.report("sboardx update failed: " + err, true);
        return false;
    } finally {
        env.clipboard.restore();
    }
    imp.keepColorView(env);
    env.progress.busy("Recording the merge baselines…");
    exp.finishExchange(log, env.idMap, env.stampAfter, env.cameraStamps, env.sharedStamps);
    common.restoreColorView(colorView, log);
    env.progress.close();
    var c = env.mergeCounts;
    log.trace("MERGE updated=" + c.updated + " added=" + c.added + " removed=" + c.removed + " moved=" + c.moved +
              " conflicts=" + c.conflicts + " kept=" + c.kept + " nativeKept=" + env.counts.nativeKept);
    imp.traceTextureDecodes(env);
    log.report(log.summary(mergeSummary(env, plan) + common.backupNote(env.backup)), false);
    return true;
}

// ── The plan ────────────────────────────────────────────────────────────────

// Scenes and panels as they are, with archive ids from the map (or their
// native id when unmapped).
function walkNative(env) {
    var nat = { scenes: [], panelsByArchiveId: {}, scenesByArchiveId: {} };
    var g = 0;
    for (var s = 0; s < env.sb.numberOfScenesInProject(); s++) {
        var sid = String(env.sb.sceneInProject(s));
        var scene = { native: sid, archiveId: env.idMap.scenes[sid] || sid, name: String(env.sb.nameOfScene(sid)), panels: [] };
        for (var p = 0; p < env.sb.numberOfPanelsInScene(sid); p++) {
            var pid = String(env.sb.panelInScene(sid, p));
            var panel = { native: pid, archiveId: common.archiveIdOf(env.idMap, pid), entry: env.idMap.panels[pid] || null,
                          scene: sid, index: p, globalIndex: g++ };
            scene.panels.push(panel);
            if (!nat.panelsByArchiveId[panel.archiveId]) nat.panelsByArchiveId[panel.archiveId] = panel;
        }
        nat.scenes.push(scene);
        if (!nat.scenesByArchiveId[scene.archiveId]) nat.scenesByArchiveId[scene.archiveId] = scene;
    }
    return nat;
}

// Longest increasing subsequence, as a set of indices: what stayed put.
function longestIncreasingRun(values) {
    var tails = [], prev = new Array(values.length);
    for (var i = 0; i < values.length; i++) {
        var lo = 0, hi = tails.length;
        while (lo < hi) {
            var mid = (lo + hi) >> 1;
            if (values[tails[mid]] < values[i]) lo = mid + 1; else hi = mid;
        }
        prev[i] = lo > 0 ? tails[lo - 1] : -1;
        if (lo === tails.length) tails.push(i); else tails[lo] = i;
    }
    var stayed = {};
    for (var k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) stayed[k] = true;
    return stayed;
}

// The panel's own exported form, cached. A kept panel that moves is
// re-created from it, so get it before anything changes.
function ownFormOf(env, item, nativePanel) {
    if (item.own === undefined) {
        try { item.own = exp.ownForm(env.xenv, nativePanel.scene, nativePanel.native); }
        catch (err) {
            env.log.warn("panel " + nativePanel.native + ": could not export its current form (" + err + ")");
            item.own = null;
        }
    }
    return item.own;
}

// Cached fingerprint, "" on failure (then it reads as changed here).
function fingerprintOf(env, item, nativePanel) {
    if (item.fpNow === undefined) {
        try { item.fpNow = exp.panelFingerprint(env.xenv, nativePanel.scene, nativePanel.native).hex; }
        catch (err) {
            env.log.warn("panel " + nativePanel.native + ": could not compute its fingerprint (" + err + ")");
            item.fpNow = "";
        }
    }
    return item.fpNow;
}

function changedHere(env, item, nativePanel, entry) {
    return common.changedSinceExchange(entry, function () { return fingerprintOf(env, item, nativePanel); });
}

// Grab what a re-created panel needs before anything changes: its own form,
// and its fingerprint if it has a baseline (see recreatedBaseline).
function prepareRecreate(env, item, nativePanel) {
    ownFormOf(env, item, nativePanel);
    if (common.idEntryFingerprint(nativePanel.entry)) fingerprintOf(env, item, nativePanel);
}

function computePlan(env) {
    var nat = walkNative(env);
    var plan = { entries: [], byId: {}, addedScenes: [], movedScenes: [], cameras: [], sceneNative: {}, nat: nat,
                 counts: { updated: 0, added: 0, removed: 0, conflicts: 0, moved: 0, unchanged: 0, noBaseline: 0,
                           camerasUpdated: 0, camerasConflicts: 0 } };
    // Moves: common panels in archive order vs native positions. The LIS
    // stayed, the rest moved.
    var commonIds = [], commonPos = [];
    env.groups.forEach(function (grp) {
        grp.panels.forEach(function (id) {
            var np = nat.panelsByArchiveId[id];
            if (np) { commonIds.push(id); commonPos.push(np.globalIndex); }
        });
    });
    var stayed = longestIncreasingRun(commonPos), movedIds = {};
    commonIds.forEach(function (id, i) { if (!stayed[i]) movedIds[id] = true; });

    var seen = {};
    env.groups.forEach(function (group) {
        var nativeScene = nat.scenesByArchiveId[group.srcId] || null;
        if (!nativeScene) plan.addedScenes.push(group.srcId);
        group.panels.forEach(function (srcId, p) {
            seen[srcId] = true;
            var meta = common.readJsonFile(env.extractDir + "/panels/" + srcId + "/panel.json") || {};
            var item = { id: srcId, kind: "unchanged", moved: false, sceneArchiveId: group.srcId, sceneName: group.name, index: p,
                      code: meta.code ? String(meta.code) : srcId, native: null, nativeScene: null, archiveDigest: "", noBaseline: false };
            var nativePanel = nat.panelsByArchiveId[srcId] || null;
            if (!nativePanel) {
                item.kind = "added";
                plan.counts.added++;
            } else {
                item.native = nativePanel.native;
                item.nativeScene = nativePanel.scene;
                // Compare against the declared base (sync.panels) when
                // there is one, not the archive's bytes.
                item.archiveDigest = imp.panelBaseDigest(env, srcId);
                var entry = nativePanel.entry;
                if (!entry || !entry.digest) {
                    // Never exchanged: ask, don't overwrite.
                    item.noBaseline = true;
                    item.kind = "conflict";
                    plan.counts.conflicts++;
                    plan.counts.noBaseline++;
                } else if (entry.digest !== item.archiveDigest) {
                    var localChanged = changedHere(env, item, nativePanel, entry);
                    item.kind = localChanged ? "conflict" : "updated";
                    plan.counts[localChanged ? "conflicts" : "updated"]++;
                } else {
                    plan.counts.unchanged++;
                }
                // Also moved if its archive scene is new here.
                if (movedIds[srcId] || !nativeScene || nativeScene.native !== nativePanel.scene) {
                    item.moved = true;
                    plan.counts.moved++;
                }
                if (item.moved) prepareRecreate(env, item, nativePanel);
            }
            plan.entries.push(item);
            plan.byId[srcId] = item;
        });
    });
    nat.scenes.forEach(function (scene) {
        scene.panels.forEach(function (lp, pj) {
            if (seen[lp.archiveId]) return;
            var r = { id: lp.archiveId, kind: "removed", moved: false, sceneArchiveId: scene.archiveId, sceneName: scene.name, index: pj,
                      native: lp.native, nativeScene: lp.scene, code: String(env.sb.nameOfPanel(lp.native)), archiveDigest: "", noBaseline: false };
            plan.entries.push(r);
            plan.byId[r.id] = r;
            plan.counts.removed++;
        });
    });
    // Scene moves, same idea.
    var sceneIds = [], scenePos = [];
    env.groups.forEach(function (grp) {
        var ns = nat.scenesByArchiveId[grp.srcId];
        if (ns) { sceneIds.push(grp.srcId); scenePos.push(nat.scenes.indexOf(ns)); }
    });
    var sceneStayed = longestIncreasingRun(scenePos);
    sceneIds.forEach(function (id, i) { if (!sceneStayed[i]) plan.movedScenes.push(id); });
    // A moved scene re-creates all its panels, local-only ones too.
    plan.movedScenes.forEach(function (id) {
        nat.scenesByArchiveId[id].panels.forEach(function (lp) {
            var pe = plan.byId[lp.archiveId];
            if (pe && pe.kind !== "added") prepareRecreate(env, pe, lp);
        });
    });
    // Cameras (common.cameraMergeKind).
    env.groups.forEach(function (grp) {
        var cns = nat.scenesByArchiveId[grp.srcId] || null;
        if (!cns) return;
        var base = common.readCameraBase(env.sb, cns.panels.length ? cns.panels[0].native : "");
        var live = [];
        try { live = exp.readLiveCamera(env.xenv, cns.native); }
        catch (eL) { env.log.warn("scene '" + grp.name + "': live camera not read (" + eL + ")"); }
        var ce = { sceneArchiveId: grp.srcId, sceneName: grp.name, native: cns.native, archiveKfs: grp.keyframes, live: live,
                   base: base, noBaseline: !base,
                   kind: common.cameraMergeKind(grp.keyframes, live, base, env.xenv.fps, common.sceneFrameCount(env.sb, cns.native)) };
        if (ce.kind === "conflict") plan.counts.camerasConflicts++;
        else if (ce.kind === "updated") plan.counts.camerasUpdated++;
        env.log.trace("CAMERA scene '" + grp.name + "' " + ce.kind + (ce.noBaseline ? " (no baseline)" : ""));
        plan.cameras.push(ce);
    });
    var clipsJson = common.readJsonFile(env.extractDir + "/audio/clips.json");
    plan.archiveClips = clipsJson && clipsJson.clips ? clipsJson.clips.length : 0;
    var c = plan.counts;
    plan.hasChanges = c.updated > 0 || c.added > 0 || c.removed > 0 || c.conflicts > 0 || c.moved > 0 ||
                      plan.movedScenes.length > 0 || c.camerasUpdated > 0 || c.camerasConflicts > 0;
    return plan;
}

// ── The dialog ──────────────────────────────────────────────────────────────

// { takeTheirs, takeTheirsScenes, deleteRemoved, keepInPlace: {id: true},
// takeAudio }, null if cancelled. Batch reads the options instead.
function resolvePlan(env, plan) {
    var conflicts = plan.entries.filter(function (e) { return e.kind === "conflict"; });
    var removed = plan.entries.filter(function (e) { return e.kind === "removed"; });
    var moved = plan.entries.filter(function (e) { return e.moved && e.kind !== "added"; });
    var camConflicts = plan.cameras.filter(function (c) { return c.kind === "conflict"; });
    var res = { takeTheirs: [], takeTheirsScenes: [], deleteRemoved: false, keepInPlace: {}, takeAudio: false };
    if (env.quiet) {
        // "all" or a list of ids, anything else keeps ours.
        var pick = function (opt, all) {
            return opt === "all" ? all : (Object.prototype.toString.call(opt) === "[object Array]" ? opt.slice() : []);
        };
        res.takeTheirs = pick(env.options.takeTheirs, conflicts.map(function (e) { return e.id; }));
        res.takeTheirsScenes = pick(env.options.takeCameras, camConflicts.map(function (c) { return c.sceneArchiveId; }));
        pick(env.options.keepInPlace, []).forEach(function (id) { res.keepInPlace[id] = true; });
        res.deleteRemoved = !!env.options.deleteRemoved;
        res.takeAudio = !!env.options.takeAudio && plan.archiveClips > 0;
        return res;
    }
    var d = new Dialog();
    d.title = "Update from .sboardx";
    var lbl = new Label();
    lbl.text = planSummaryText(env, plan);
    d.add(lbl);
    function keepOrTake(label) {
        var cb = new ComboBox();
        cb.label = label;
        cb.itemList = ["Keep mine", "Take theirs"];
        cb.currentItem = "Keep mine";
        d.add(cb);
        return cb;
    }
    function check(text) {
        var ck = new CheckBox();
        ck.text = text;
        ck.checked = false;
        d.add(ck);
        return ck;
    }
    var combos = conflicts.map(function (e) { return keepOrTake("Changed on both sides: " + e.code + (e.noBaseline ? " (first merge)" : "")); });
    var camCombos = camConflicts.map(function (c) {
        return keepOrTake("Camera of scene " + c.sceneName + " changed on both sides" + (c.noBaseline ? " (first merge)" : ""));
    });
    var audioBox = plan.archiveClips > 0 ? check("Replace the audio tracks with the file's (" + plan.archiveClips + " clip(s))") : null;
    var delBox = removed.length ? check("Delete " + removed.length + " panel(s) missing from the file") : null;
    var keepBoxes = moved.map(function (e) { return check("Keep " + e.code + " where it is (the file moves it; moving re-creates the panel)"); });
    if (!d.exec()) return null;
    combos.forEach(function (cb, i) { if (String(cb.currentItem) === "Take theirs") res.takeTheirs.push(conflicts[i].id); });
    camCombos.forEach(function (cb, i) { if (String(cb.currentItem) === "Take theirs") res.takeTheirsScenes.push(camConflicts[i].sceneArchiveId); });
    res.deleteRemoved = !!(delBox && delBox.checked);
    res.takeAudio = !!(audioBox && audioBox.checked);
    keepBoxes.forEach(function (kb, i) { if (kb.checked) res.keepInPlace[moved[i].id] = true; });
    return res;
}

function planSummaryText(env, plan) {
    var c = plan.counts;
    var lines = [(env.projectJson.name || "sboardx") + " → this project", "",
                 c.updated + " updated, " + c.added + " added" + (plan.addedScenes.length ? " (" + plan.addedScenes.length + " new scene(s))" : "") +
                 ", " + c.removed + " missing from the file, " + c.moved + " moved, " + c.conflicts + " changed on both sides" +
                 (c.noBaseline ? " (" + c.noBaseline + " without a baseline: first merge)" : "") + ", " + c.unchanged + " unchanged."];
    if (plan.movedScenes.length) lines.push(plan.movedScenes.length + " scene(s) reordered.");
    if (c.camerasUpdated || c.camerasConflicts) lines.push("Cameras: " + c.camerasUpdated + " updated in the file, " + c.camerasConflicts + " changed on both sides.");
    if (plan.archiveClips > 0) lines.push("The file carries " + plan.archiveClips + " audio clip(s) (replacing is off unless ticked).");
    if (!plan.hasChanges) lines.push("Nothing to update.");
    return lines.join("\n");
}

function mergeSummary(env, plan) {
    var c = env.mergeCounts;
    return "Updated " + c.updated + " panel(s), added " + c.added + (c.scenesAdded ? " (" + c.scenesAdded + " new scene(s))" : "") +
           ", removed " + c.removed + ", moved " + c.moved + ", kept " + c.kept + " of " + c.conflicts + " changed on both sides" +
           (c.recreated ? "; " + c.recreated + " panel(s) re-created to move them (Toon Boom-only layer kinds came back as images)" : "") +
           (c.cameras || c.camerasKept ? "; cameras: " + c.cameras + " taken from the file, " + c.camerasKept + " kept" : "") +
           (c.audio ? "; audio tracks replaced" : "") +
           imp.sharedDrawingsNote(env.counts) +
           (env.counts.nativeKept ? "; " + env.counts.nativeKept + " text layer(s) kept as text (their pictures came back unchanged)" : "") +
           (plan.counts.noBaseline ? "; " + plan.counts.noBaseline + " panel(s) had no merge baseline (first merge)" : "") + ".";
}

// ── Apply ───────────────────────────────────────────────────────────────────

function applyPlan(env, plan, res) {
    var takeTheirs = {}, takeCam = {};
    res.takeTheirs.forEach(function (id) { takeTheirs[id] = true; });
    res.takeTheirsScenes.forEach(function (id) { takeCam[id] = true; });
    var nat = plan.nat, map = env.idMap;
    var deleteOld = [], deleteScenes = [];   // moved originals, deleted at the end

    // Scenes in archive order (new, re-created or kept), then their panels.
    var prevNativeScene = "";
    env.groups.forEach(function (group) {
        var nativeScene = nat.scenesByArchiveId[group.srcId] || null;
        var freshScene = !nativeScene || plan.movedScenes.indexOf(group.srcId) >= 0;
        var sceneId;
        if (freshScene) {
            sceneId = createSceneAt(env, group.name, prevNativeScene);
            if (!sceneId) { env.log.warn("scene '" + group.name + "' could not be created"); return; }
            map.scenes[sceneId] = group.srcId;
            if (nativeScene) deleteScenes.push(nativeScene.native);
            else env.mergeCounts.scenesAdded++;
        } else {
            sceneId = nativeScene.native;
            if (nativeScene.name !== group.name) env.sb.renameScene(sceneId, group.name);
        }
        prevNativeScene = sceneId;
        plan.sceneNative[group.srcId] = sceneId;
        var prevNativePanel = "";
        group.panels.forEach(function (srcId, p) {
            var e = plan.byId[srcId];
            if (env.progress.cancelled()) throw { sboardxCancelled: true };
            env.progress.step("Panel " + e.code + " (scene " + group.name + ")");
            var meta = common.readJsonFile(env.extractDir + "/panels/" + srcId + "/panel.json") || {};
            var token = imp.panelToken(meta, group.name) || String(p + 1);
            var panelId = e.native;
            var replace = e.kind === "updated" || (e.kind === "conflict" && takeTheirs[srcId]);

            if (e.kind === "added") {
                panelId = imp.createPanelAt(env, sceneId, prevNativePanel, token, p === 0 && freshScene);
                if (!panelId) { env.log.warn("panel " + srcId + " could not be created"); return; }
                imp.fillPanelFromArchive(env, panelId, srcId, meta, false);
                imp.recordPanelInIdMap(env, panelId, srcId);
                env.stampAfter.push(panelId);
                env.mergeCounts.added++;
            } else if ((e.moved && !res.keepInPlace[srcId]) || freshScene) {
                // No move API: re-create at the archive's slot, from the
                // archive if taken, else from its own form.
                var newId = imp.createPanelAt(env, sceneId, prevNativePanel, token, p === 0 && freshScene);
                if (!newId) { env.log.warn("panel " + e.code + " could not be re-created; left in place"); }
                else {
                    var fromOwn = !replace && !!e.own;
                    if (!replace && !e.own) env.log.warn("panel " + e.code + ": its current form could not be exported; re-created from the file instead");
                    if (fromOwn) fillFromOwn(env, newId, e.own, meta);
                    else imp.fillPanelFromArchive(env, newId, srcId, meta, false);
                    copyPanelExtras(env, panelId, newId);
                    if (!map.panels[panelId]) map.panels[panelId] = common.newIdEntry(srcId);
                    rekeyPanel(map, panelId, newId);
                    if (fromOwn) {
                        recreatedBaseline(env, newId, e);
                    } else {
                        imp.recordPanelInIdMap(env, newId, srcId);
                        env.stampAfter.push(newId);
                    }
                    deleteOld.push(panelId);
                    panelId = newId;
                    env.mergeCounts.moved++;
                    env.mergeCounts.recreated++;
                    if (replace) env.mergeCounts.updated++; else env.mergeCounts.kept++;
                }
            } else if (replace) {
                imp.fillPanelFromArchive(env, panelId, srcId, meta, true);
                imp.recordPanelInIdMap(env, panelId, srcId);
                env.stampAfter.push(panelId);
                env.mergeCounts.updated++;
                if (e.kind === "conflict") env.mergeCounts.conflicts++;
            } else {
                // Kept: this file version stops asking, but don't stamp a
                // baseline. After a "keep mine" with none, a stamp would make
                // the next export declare the file's version as the base and
                // Upshot would keep its own over ours.
                if (!map.panels[panelId]) map.panels[panelId] = common.newIdEntry(srcId);
                map.panels[panelId].digest = e.archiveDigest;
                if (e.kind === "conflict") { env.mergeCounts.kept++; env.mergeCounts.conflicts++; }
                else env.mergeCounts.unchanged++;
            }
            prevNativePanel = panelId;
        });
        // Carry local-only panels into the re-created scene before the old
        // one goes.
        if (freshScene && nativeScene) {
            nativeScene.panels.forEach(function (lp) {
                var le = plan.byId[lp.archiveId];
                if (!le || le.kind !== "removed" || res.deleteRemoved) return;
                var nid = le.own ? imp.createPanelAt(env, sceneId, prevNativePanel, String(env.sb.nameOfPanel(lp.native)), false) : "";
                if (!nid) {
                    env.log.warn("panel " + env.sb.nameOfPanel(lp.native) + " could not be carried into the re-created scene; the old scene is kept");
                    var di = deleteScenes.indexOf(nativeScene.native);
                    if (di >= 0) deleteScenes.splice(di, 1);
                    return;
                }
                fillFromOwn(env, nid, le.own, {});
                copyPanelExtras(env, lp.native, nid);
                rekeyPanel(map, lp.native, nid);
                deleteOld.push(lp.native);
                prevNativePanel = nid;
                env.mergeCounts.recreated++;
            });
        }
    });

    // Audio: whole tracks, only when asked.
    if (res.takeAudio && env.groups.length) {
        var firstScene = plan.sceneNative[env.groups[0].srcId];
        var firstPanel = firstScene && env.sb.numberOfPanelsInScene(firstScene) > 0 ? String(env.sb.panelInScene(firstScene, 0)) : "";
        try {
            imp.importAudio(env, imp.globalStartFrameOf(env, firstPanel));
            env.mergeCounts.audio = true;
        } catch (eAu) {
            env.log.warn("audio not replaced (" + eAu + ")");
        }
    }

    // Deletions: removed panels (if asked), then moved originals and old scenes.
    if (res.deleteRemoved) {
        plan.entries.forEach(function (re) {
            if (re.kind !== "removed" || !re.native) return;
            if (common.countPanels(env.sb) <= 1) { env.log.warn("the last panel is never deleted"); return; }
            if (env.sb.deletePanel(re.native)) {
                delete map.panels[re.native];
                env.mergeCounts.removed++;
            } else env.log.warn("panel " + re.code + " could not be deleted");
        });
    }
    deleteOld.forEach(function (pid) {
        if (!env.sb.deletePanel(pid)) env.log.warn("moved panel's original " + pid + " could not be deleted");
        delete map.panels[pid];
    });
    deleteScenes.forEach(function (sid) {
        if (env.sb.numberOfPanelsInScene(sid) > 0) { env.log.warn("re-created scene's original still holds panels; kept"); return; }
        env.sb.deleteScene(sid);
        delete map.scenes[sid];
    });
    // SBP suffixes a scene name that's taken ("20" -> "20_A"), which happens
    // while originals still exist. Rename now that they're gone.
    env.groups.forEach(function (group) {
        var sid = plan.sceneNative[group.srcId];
        if (!sid || String(env.sb.nameOfScene(sid)) === group.name) return;
        env.sb.renameScene(sid, group.name);
        if (String(env.sb.nameOfScene(sid)) !== group.name) {
            env.log.warn("scene '" + group.name + "' is named '" + env.sb.nameOfScene(sid) + "' (the name is taken in this project)");
        }
    });

    // Cameras last: they clamp onto scene frames, final only now.
    applyCameras(env, plan, takeCam);
}

// Cameras and their new baselines (stamped by finishExchange):
//   updated / conflict taken  -> file's camera; baseline file keys + read-back
//   unchanged                 -> as is, baseline re-read
//   conflict kept             -> as is; archive side takes the file's (stops
//                                asking), local side stays
//   changed here only         -> as is, baseline as it was
//   added scene               -> file's camera, full baseline
// A re-created scene has no camera: it gets the file's, or if changed here
// its own keys re-applied the importer's way (with a warning).
function applyCameras(env, plan, takeCam) {
    var fps = env.xenv.fps;
    function setCamera(sceneId, ce, kfs) {
        try {
            if (!kfs.length) { env.mm.clearCameraMotion(sceneId); return true; }
            return imp.applySceneCamera(env, sceneId, kfs);
        } catch (e) {
            env.log.warn("scene '" + ce.sceneName + "': camera not applied (" + e + ")");
            return false;
        }
    }
    plan.cameras.forEach(function (ce) {
        var sceneNow = plan.sceneNative[ce.sceneArchiveId] || ce.native;
        var fresh = sceneNow !== ce.native;
        var take = ce.kind === "updated" || (ce.kind === "conflict" && !!takeCam[ce.sceneArchiveId]);
        if (take || ce.kind === "unchanged") {
            var applied = false;
            if (fresh || (take && !common.cameraKfsMatch(ce.live, ce.archiveKfs, fps, common.sceneFrameCount(env.sb, sceneNow)))) {
                applied = setCamera(sceneNow, ce, ce.archiveKfs) && ce.archiveKfs.length > 0;
            }
            if (take) env.mergeCounts.cameras++;
            env.cameraStamps.push({ sceneId: sceneNow, archive: ce.archiveKfs, local: "live", verify: applied });
            return;
        }
        if (ce.kind === "conflict") env.mergeCounts.camerasKept++;
        if (fresh && ce.live.length && setCamera(sceneNow, ce, ce.live)) {
            env.log.warn("scene '" + ce.sceneName + "' was re-created to move it: its camera, changed here, was re-keyed " +
                         "from its keys (the easing between them is the importer's)");
        }
        var local = ce.base ? ce.base.local : null;
        env.cameraStamps.push({ sceneId: sceneNow, archive: ce.kind === "conflict" || !ce.base ? ce.archiveKfs : ce.base.archive,
                                local: local });
    });
    env.groups.forEach(function (grp) {
        if (plan.addedScenes.indexOf(grp.srcId) < 0 || !plan.sceneNative[grp.srcId]) return;
        var sceneId = plan.sceneNative[grp.srcId];
        var applied = grp.keyframes.length > 0 && setCamera(sceneId, { sceneName: grp.name }, grp.keyframes);
        env.cameraStamps.push({ sceneId: sceneId, archive: grp.keyframes, local: "live", verify: applied });
    });
}

// After prevNativeScene, or first if none.
function createSceneAt(env, name, prevNativeScene) {
    var id = prevNativeScene ? env.sb.insertScene(true, prevNativeScene, name)
           : env.sb.numberOfScenesInProject() > 0 ? env.sb.insertScene(false, String(env.sb.sceneInProject(0)), name)
           : env.sb.appendScene(name);
    return id ? String(id) : "";
}

// own.dir is laid out like an archive, so just point the importer at it.
function fillFromOwn(env, panelId, own, fallbackMeta) {
    var saved = env.extractDir;
    env.extractDir = own.dir;
    env.ownFormFill = true;   // shared drawings are already ours (imp.sharedLinkFor)
    new Dir(own.dir + "/_tiles").mkdirs();
    try {
        imp.fillPanelFromArchive(env, panelId, own.outId,
                                 common.readJsonFile(own.dir + "/panels/" + own.outId + "/panel.json") || fallbackMeta, false);
    } finally {
        env.extractDir = saved;
        env.ownFormFill = false;
    }
}

// Metadata and panel colour. Skips the camera baseline, applyCameras
// re-stamps it.
function copyPanelExtras(env, fromId, toId) {
    try {
        var metas = env.sb.getPanelMetadatas(fromId) || [];
        for (var i = 0; i < metas.length; i++) {
            var m = metas[i];
            if (!m || !m.name || m.name === "sboardx-camera") continue;
            env.sb.setPanelMetadata(toId, { name: String(m.name), type: String(m.type || "string"),
                                            creator: String(m.creator || "sboardx"), version: String(m.version || "1.0"), value: m.value });
        }
        var color = env.sb.getPanelColor(fromId);
        if (color) env.sb.setPanelColor(toId, color);
    } catch (e) {
        env.log.warn("panel " + toId + ": metadata and colour not copied from its original (" + e + ")");
    }
}

function rekeyPanel(map, oldId, newId) {
    if (!map.panels[oldId]) return;
    map.panels[newId] = map.panels[oldId];
    delete map.panels[oldId];
}

// Baseline for a kept panel re-created from its own form. If it was
// unchanged here, re-stamp its fingerprint at the end. If changed, keep the
// old fp so it still reads "changed here". No baseline stays none. Fills
// in a missing digest.
function recreatedBaseline(env, panelId, e) {
    var entry = env.idMap.panels[panelId];
    var fp = common.idEntryFingerprint(entry);
    if (fp && e.fpNow && e.fpNow === fp) env.stampAfter.push(panelId);
    if (!entry.digest) entry.digest = e.archiveDigest;
}

exports.mergeFromFile = mergeFromFile;
