// sboardx_merge.js — the implementation behind TB_MergeSboardx.js ("Update
// from .sboardx"), loaded via require(). Needs sboardx_common.js,
// sboardx_import.js and sboardx_export.js in the same folder. See README.md.
//
// The 3-way, panel-level merge of an .sboardx into the open project — the
// counterpart of Upshot's Merge/SboardxMerge.hpp, over the same archive
// digest rule (sboardx_common.js archivePanelDigest) and the project's id
// map (sboardx-ids metadata, keyed by native ids). Per archive panel,
// matched by id:
//   unknown here                            -> added, at its archive position
//   archive digest == map.digest            -> unchanged (the digest is the
//                                              base the archive declares for
//                                              the panel, else its bytes')
//   archive changed, own form == map.local  -> updated (replaced whole)
//   both changed, or no baseline            -> conflict: Keep mine / Take theirs
//   native panels absent from the archive   -> removed (kept unless asked)
//   position differs                        -> moved: re-created at the
//                                              archive's slot (no move API)
// Scene cameras follow the same table over the sboardx-camera baseline;
// audio is replaced wholesale only when asked. Everything runs in one undo
// accumulation and the project is saved on success.

var common = require("./sboardx_common.js");
var imp = require("./sboardx_import.js");
var exp = require("./sboardx_export.js");

// options (batch): { takeTheirs: "all" | [archive panel ids], deleteRemoved: bool,
//                    keepInPlace: [archive panel ids], takeCameras: "all" | [archive scene ids],
//                    takeAudio: bool }
function mergeFromFile(zipPath, quiet, options) {
    var log = common.makeLog("[sboardx-merge] ", quiet);
    if (!common.requireApi(log)) return false;
    var env = imp.makeImportEnv(log, quiet, options);
    env.mergeCounts = { updated: 0, added: 0, removed: 0, moved: 0, kept: 0, conflicts: 0, unchanged: 0,
                        recreated: 0, scenesAdded: 0, cameras: 0, camerasKept: 0, audio: false };
    env.stampAfter = [];   // native panels filled from the archive: baselines stamped at the end
    // The plan's "changed here?" digests read each panel's drawings from their saved files.
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
    env.xenv = exp.makeExportEnv(log, "");   // the panels' own exported forms and the live cameras
    env.xenv.idMap = env.idMap;
    var plan = computePlan(env);
    env.progress.close();

    var res = resolvePlan(env, plan);
    if (!res) {
        log.report("Update cancelled. The project was not changed.", true);
        return false;
    }
    if (!plan.hasChanges && !res.takeAudio) {
        log.report("Nothing to update — the file matches this project.", false);
        return true;
    }

    env.progress = common.makeProgress("Updating from .sboardx", quiet);
    project.beginUndoRedoAccum("Update from sboardx");
    try {
        imp.applyProjectSettings(env);
        env.progress.begin(env.sequenceJson.panels.length);
        applyPlan(env, plan, res);
        project.endUndoRedoAccum();
    } catch (err) {
        project.cancelUndoRedoAccum();
        env.progress.close();
        if (err && err.sboardxCancelled) log.report("Update cancelled. The project was not changed.", true);
        else log.report("sboardx update failed: " + err, true);
        return false;
    }
    env.progress.busy("Recording the merge baselines…");
    exp.finishExchange(log, env.idMap, env.stampAfter);
    env.progress.close();
    var c = env.mergeCounts;
    log.trace("MERGE updated=" + c.updated + " added=" + c.added + " removed=" + c.removed + " moved=" + c.moved +
              " conflicts=" + c.conflicts + " kept=" + c.kept);
    log.report(log.summary(mergeSummary(env, plan)), false);
    return true;
}

// ── The plan ────────────────────────────────────────────────────────────────

// The project as it is: scenes and panels by native id, with their archive
// ids from the map (identity when unmapped — a Toon Boom-born entity).
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

// The longest increasing run of `values` (indices into it): what "stayed".
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

// The entry's own exported form ({dir, outId, hex}, exp.ownForm), computed
// once, before the undo accumulation.
function ownFormOf(env, e, local) {
    if (e.own === undefined) {
        try { e.own = exp.ownForm(env.xenv, local.scene, local.native); }
        catch (err) {
            env.log.warn("panel " + local.native + ": could not export its current form (" + err + ")");
            e.own = null;
        }
    }
    return e.own;
}

function computePlan(env) {
    var nat = walkNative(env);
    var plan = { entries: [], byId: {}, addedScenes: [], movedScenes: [], cameras: [], sceneNative: {}, nat: nat,
                 counts: { updated: 0, added: 0, removed: 0, conflicts: 0, moved: 0, unchanged: 0, noBaseline: 0,
                           camerasUpdated: 0, camerasConflicts: 0 } };
    // Moves: the common panels in archive order against their native
    // positions — the longest increasing run stayed, the rest moved.
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
            var e = { id: srcId, kind: "unchanged", moved: false, sceneArchiveId: group.srcId, sceneName: group.name, index: p,
                      code: meta.code ? String(meta.code) : srcId, native: null, nativeScene: null, archiveDigest: "", noBaseline: false };
            var local = nat.panelsByArchiveId[srcId] || null;
            if (!local) {
                e.kind = "added";
                plan.counts.added++;
            } else {
                e.native = local.native;
                e.nativeScene = local.scene;
                // The declared base (project.json sync.panels) names the
                // exchange the writer's panel is unchanged since: the
                // comparison is against it, never the archive's bytes.
                e.archiveDigest = imp.archiveBaseOf(env, srcId) || common.archivePanelDigest(env.extractDir, srcId);
                var entry = local.entry;
                if (!entry || !entry.digest) {
                    // No baseline (an older import): a question, never a silent overwrite.
                    e.noBaseline = true;
                    e.kind = "conflict";
                    plan.counts.conflicts++;
                    plan.counts.noBaseline++;
                } else if (entry.digest !== e.archiveDigest) {
                    var mine = ownFormOf(env, e, local);
                    var localChanged = !mine || !entry.local || mine.hex !== entry.local;
                    e.kind = localChanged ? "conflict" : "updated";
                    plan.counts[localChanged ? "conflicts" : "updated"]++;
                } else {
                    plan.counts.unchanged++;
                }
                // Moved within/between scenes; a panel whose archive scene is new here moves into it.
                if (movedIds[srcId] || !nativeScene || nativeScene.native !== local.scene) {
                    e.moved = true;
                    plan.counts.moved++;
                }
                // What a kept panel is re-created from when it moves, and its `local` baseline.
                if (e.moved || !entry || !entry.local) ownFormOf(env, e, local);
            }
            plan.entries.push(e);
            plan.byId[srcId] = e;
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
    // Scene moves: archive scene order vs native order of the common scenes.
    var sceneIds = [], scenePos = [];
    env.groups.forEach(function (grp) {
        var ns = nat.scenesByArchiveId[grp.srcId];
        if (ns) { sceneIds.push(grp.srcId); scenePos.push(nat.scenes.indexOf(ns)); }
    });
    var sceneStayed = longestIncreasingRun(scenePos);
    sceneIds.forEach(function (id, i) { if (!sceneStayed[i]) plan.movedScenes.push(id); });
    // Every panel of a re-created (moved) scene is re-created too: its own
    // form is needed, local-only (removed) panels included.
    plan.movedScenes.forEach(function (id) {
        nat.scenesByArchiveId[id].panels.forEach(function (lp) {
            var pe = plan.byId[lp.archiveId];
            if (pe && pe.kind !== "added") ownFormOf(env, pe, lp);
        });
    });
    // Cameras: the sboardx-camera metadata on the scene's first panel is the
    // camera as last exchanged; the archive's keyframes against it say
    // "archive changed", the live camera against it "local changed". No
    // metadata = no baseline: unchanged only when the archive equals the live
    // camera; with no live camera the file's move is simply taken.
    env.groups.forEach(function (grp) {
        var cns = nat.scenesByArchiveId[grp.srcId] || null;
        if (!cns) return;
        var meta = exp.readCameraMeta(env, cns.panels.length ? cns.panels[0].native : "");
        var live = [];
        try { live = exp.readLiveCamera(env.xenv, cns.native); }
        catch (eL) { env.log.warn("scene '" + grp.name + "': live camera not read (" + eL + ")"); }
        var archiveKfs = grp.keyframes;
        var ce = { sceneArchiveId: grp.srcId, sceneName: grp.name, native: cns.native, archiveKfs: archiveKfs, live: live,
                   kind: "unchanged", noBaseline: !meta };
        var archiveChanged, localChanged;
        if (!meta) {
            var same = exp.cameraKfsMatch(env, live, archiveKfs);
            archiveChanged = !same;
            localChanged = !same && live.length > 0;
        } else {
            archiveChanged = !exp.cameraKfsMatch(env, archiveKfs, meta);
            localChanged = !exp.cameraKfsMatch(env, live, meta);
        }
        if (archiveChanged && localChanged) { ce.kind = "conflict"; plan.counts.camerasConflicts++; }
        else if (archiveChanged) { ce.kind = "updated"; plan.counts.camerasUpdated++; }
        else if (localChanged) ce.kind = "localOnly";
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

// The answers: { takeTheirs: [archive panel ids], takeTheirsScenes: [archive
// scene ids], deleteRemoved, keepInPlace: {id: true}, takeAudio }; null =
// cancelled. Batch takes them from the options.
function resolvePlan(env, plan) {
    var conflicts = plan.entries.filter(function (e) { return e.kind === "conflict"; });
    var removed = plan.entries.filter(function (e) { return e.kind === "removed"; });
    var moved = plan.entries.filter(function (e) { return e.moved && e.kind !== "added"; });
    var camConflicts = plan.cameras.filter(function (c) { return c.kind === "conflict"; });
    var res = { takeTheirs: [], takeTheirsScenes: [], deleteRemoved: false, keepInPlace: {}, takeAudio: false };
    if (env.quiet) {
        // "all", or a list of archive ids; anything else keeps this project's version.
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
           (plan.counts.noBaseline ? "; " + plan.counts.noBaseline + " panel(s) had no merge baseline (first merge)" : "") + ".";
}

// ── Apply ───────────────────────────────────────────────────────────────────

function applyPlan(env, plan, res) {
    var takeTheirs = {}, takeCam = {};
    res.takeTheirs.forEach(function (id) { takeTheirs[id] = true; });
    res.takeTheirsScenes.forEach(function (id) { takeCam[id] = true; });
    var nat = plan.nat, map = env.idMap;
    var deleteOld = [], deleteScenes = [];   // moved originals, deleted at the end

    // Scenes in archive order — created (new), re-created (moved) or kept —
    // then their panels in archive order.
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
                // Re-created at the archive's slot: from the archive when its
                // content is taken, else from its own exported form.
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
                        stampLocal(env, newId, e);
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
                // Kept (unchanged, or keep mine): this archive version stops asking.
                if (!map.panels[panelId]) map.panels[panelId] = common.newIdEntry(srcId);
                map.panels[panelId].digest = e.archiveDigest;
                if (!map.panels[panelId].local) stampLocal(env, panelId, e);
                if (e.kind === "conflict") { env.mergeCounts.kept++; env.mergeCounts.conflicts++; }
                else env.mergeCounts.unchanged++;
            }
            prevNativePanel = panelId;
        });
        // Local-only panels of a re-created scene are carried over by their
        // own exported form, so nothing is lost when the old scene goes.
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

    // Cameras: an updated or taken scene gets the archive's keyframes; the
    // sboardx-camera baseline is re-stamped for taken and kept conflicts,
    // so a kept one stops asking.
    plan.cameras.forEach(function (ce) {
        var take = ce.kind === "updated" || (ce.kind === "conflict" && takeCam[ce.sceneArchiveId]);
        if (!take && ce.kind !== "conflict") return;
        var sceneNow = plan.sceneNative[ce.sceneArchiveId] || ce.native;
        var stale = take && exp.cameraKfsMatch(env, ce.live, ce.archiveKfs);   // the live camera already is the file's
        if (take && !stale) {
            try {
                if (!ce.archiveKfs.length) env.mm.clearCameraMotion(sceneNow);
                else if (!imp.applySceneCamera(env, sceneNow, ce.archiveKfs)) env.log.warn("scene '" + ce.sceneName + "': the camera move did not apply");
                env.mergeCounts.cameras++;
            } catch (eC) {
                env.log.warn("scene '" + ce.sceneName + "': camera not applied (" + eC + ")");
                return;
            }
        } else if (!take) {
            env.mergeCounts.camerasKept++;
        }
        if (env.sb.numberOfPanelsInScene(sceneNow) > 0) {
            common.setPanelMeta(env.sb, String(env.sb.panelInScene(sceneNow, 0)), "sboardx-camera", JSON.stringify(ce.archiveKfs));
        }
    });
    // Audio: whole tracks from the file, only when asked.
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

    // Removed panels (with the user's leave), the moved originals, the re-created scenes' originals.
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
}

// A scene after `prevNativeScene` (before the first scene when none).
function createSceneAt(env, name, prevNativeScene) {
    var id = prevNativeScene ? env.sb.insertScene(true, prevNativeScene, name)
           : env.sb.numberOfScenesInProject() > 0 ? env.sb.insertScene(false, String(env.sb.sceneInProject(0)), name)
           : env.sb.appendScene(name);
    return id ? String(id) : "";
}

// Fills a re-created panel from a panel's own exported form (a staging
// folder laid out like an archive).
function fillFromOwn(env, panelId, own, fallbackMeta) {
    var saved = env.extractDir;
    env.extractDir = own.dir;
    new Dir(own.dir + "/_tiles").mkdirs();
    try {
        imp.fillPanelFromArchive(env, panelId, own.outId,
                                 common.readJsonFile(own.dir + "/panels/" + own.outId + "/panel.json") || fallbackMeta, false);
    } finally {
        env.extractDir = saved;
    }
}

// What a re-created panel keeps from its original besides its content: the
// metadata (the camera baseline of a scene's first panel among it) and the
// panel colour.
function copyPanelExtras(env, fromId, toId) {
    try {
        var metas = env.sb.getPanelMetadatas(fromId) || [];
        for (var i = 0; i < metas.length; i++) {
            var m = metas[i];
            if (!m || !m.name || m.name === "sboardx-id") continue;
            env.sb.setPanelMetadata(toId, { name: String(m.name), type: String(m.type || "string"),
                                            creator: String(m.creator || "sboardx"), version: String(m.version || "1.0"), value: m.value });
        }
        var color = env.sb.getPanelColor(fromId);
        if (color) env.sb.setPanelColor(toId, color);
    } catch (e) {
        env.log.warn("panel " + toId + ": metadata and colour not copied from its original (" + e + ")");
    }
}

// A re-created panel takes its original's id-map entry.
function rekeyPanel(map, oldId, newId) {
    if (!map.panels[oldId]) return;
    map.panels[newId] = map.panels[oldId];
    delete map.panels[oldId];
}

// A kept panel's baselines: its own form (computed by the plan) and, when
// it had none, the archive digest.
function stampLocal(env, panelId, e) {
    var entry = env.idMap.panels[panelId];
    if (e.own) entry.local = e.own.hex;
    if (!entry.digest) entry.digest = e.archiveDigest;
}

exports.mergeFromFile = mergeFromFile;
