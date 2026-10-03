// App wiring. Per-clip concerns — media, canvas, timeline, transport, crop —
// live in ClipView; this file owns the shared sidebar, the models, the focus
// scan, and which clip the sidebar is pointed at.

import { DEFAULTS, MODELS, SCAN } from './config.js';
import { ensureLandmarker, currentDelegate, providedPoseIds } from './landmarker.js';
import { analyzeVideo } from './analyze.js';
import { angleAt } from './track.js';
import { ClipView } from './clip.js';
import { correctSideFlips, undoSideFlips, flipWholeTrack, flipRange } from './sides.js';
import { exportClipVideo, extensionFor } from './export-video.js';
import { AngleChart, seriesColor } from './chart.js';
import * as SK from './skeleton.js';

const $ = (sel) => document.querySelector(sel);

const el = {
  clips: $('#clips'),
  status: $('#status'),
  statusText: $('#statusText'),

  globalTransport: $('#globalTransport'),
  playBoth: $('#playBoth'),
  syncBoth: $('#syncBoth'),

  pickVideo: $('#pickVideo'),
  videoInput: $('#videoInput'),
  pickVideoB: $('#pickVideoB'),
  videoInputB: $('#videoInputB'),
  closeVideoB: $('#closeVideoB'),
  reanalyze: $('#reanalyze'),
  videoNote: $('#videoNote'),

  selectArea: $('#selectArea'),
  clearSelection: $('#clearSelection'),
  applyCrop: $('#applyCrop'),
  clearCrop: $('#clearCrop'),
  boostRange: $('#boostRange'),
  boostVal: $('#boostVal'),
  rescanBtn: $('#rescanBtn'),
  cropNote: $('#cropNote'),
  rescanNote: $('#rescanNote'),
  rescanModelSel: $('#rescanModelSel'),

  modelSel: $('#modelSel'),
  fpsSel: $('#fpsSel'),
  smoothRange: $('#smoothRange'),
  smoothVal: $('#smoothVal'),
  visRange: $('#visRange'),
  visVal: $('#visVal'),
  mirrorChk: $('#mirrorChk'),
  handsChk: $('#handsChk'),
  handsNote: $('#handsNote'),
  fixSidesChk: $('#fixSidesChk'),
  swapSidesBtn: $('#swapSidesBtn'),
  swapFromHereBtn: $('#swapFromHereBtn'),
  sidesNote: $('#sidesNote'),

  focusTarget: $('#focusTarget'),
  scanLenSel: $('#scanLenSel'),
  scanBtn: $('#scanBtn'),
  clearFocus: $('#clearFocus'),
  focusOnlyChk: $('#focusOnlyChk'),
  focusReadout: $('#focusReadout'),

  opacityRange: $('#opacityRange'),
  opacityVal: $('#opacityVal'),
  skelChk: $('#skelChk'),
  pointsChk: $('#pointsChk'),
  labelsChk: $('#labelsChk'),
  anglesChk: $('#anglesChk'),
  strobeRange: $('#strobeRange'),
  strobeVal: $('#strobeVal'),
  groupList: $('#groupList'),
  pointScale: $('#pointScale'),
  lineScale: $('#lineScale'),

  trailLenSel: $('#trailLenSel'),
  trailDotsChk: $('#trailDotsChk'),
  trailChips: $('#trailChips'),

  angleChips: $('#angleChips'),
  angleReadout: $('#angleReadout'),
  angleChart: $('#angleChart'),
  angleModeSel: $('#angleModeSel'),
  angleModeNote: $('#angleModeNote'),

  exportJson: $('#exportJson'),
  exportCsv: $('#exportCsv'),
  exportAngles: $('#exportAngles'),
  exportPng: $('#exportPng'),
  exportVideo: $('#exportVideo'),
  cancelExportVideo: $('#cancelExportVideo'),
  exportOverlayChk: $('#exportOverlayChk'),
  exportVideoNote: $('#exportVideoNote'),
};

const state = {
  groups: new Set(SK.DEFAULT_GROUPS),
  trails: new Set(SK.DEFAULT_TRAILS),
  angles: new Set(SK.DEFAULT_ANGLES),
  /** @type {{ids:Set<number>, label:string, candidates:number, frames:number}|null} */
  focus: null,
  /** @type {object|null} in-flight focus scan */
  scan: null,
};

/** group key -> its checkbox, so a lock can switch the right ones back on */
const groupInputs = new Map();

/** @type {ClipView[]} */
const clips = [];
/** @type {ClipView} the clip the sidebar acts on */
let active = null;

const chart = new AngleChart(el.angleChart);

/* ------------------------------------------------------------------ clips */

function makeClip(tag) {
  const clip = new ClipView({
    tag,
    getOptions: sharedOptions,
    onActivate: setActiveClip,
    onChange: onClipChange,
    onPointClick: trailNearestPoint,
    onClose: tag === 'B' ? closeCompare : null,
  });
  clip.setClosable(tag === 'B');
  el.clips.append(clip.root);
  clips.push(clip);
  attachDrop(clip);
  return clip;
}

const clipA = () => clips[0];
const clipB = () => clips[1] ?? null;

function setActiveClip(clip) {
  if (active === clip) return;
  active = clip;
  for (const c of clips) c.setActive(c === clip);
  syncSidebarToActive();
}

function onClipChange() {
  updateReadout();
  renderChart();
  updateControls();
}

function ensureCompare() {
  if (clipB()) return clipB();
  const clip = makeClip('B');
  el.clips.classList.add('is-compare');
  el.globalTransport.hidden = false;
  el.closeVideoB.disabled = false;
  clipA().setClosable(false);
  return clip;
}

function closeCompare() {
  const b = clipB();
  if (!b) return;
  if (active === b) setActiveClip(clipA());
  b.dispose();
  clips.splice(1, 1);
  el.clips.classList.remove('is-compare');
  el.globalTransport.hidden = true;
  el.closeVideoB.disabled = true;
  updateControls();
}

/* ------------------------------------------------------------------ setup */

function buildControls() {
  for (const [key, model] of Object.entries(MODELS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = model.label;
    opt.selected = key === DEFAULTS.model;
    el.modelSel.append(opt);
  }

  // A rescan covers a short trimmed slice, so the slow accurate model is
  // affordable here even when it is not for a whole pass.
  const same = document.createElement('option');
  same.value = '';
  same.textContent = 'Same as Tracking panel';
  el.rescanModelSel.append(same);
  for (const [key, model] of Object.entries(MODELS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = model.label;
    opt.selected = key === 'heavy';
    el.rescanModelSel.append(opt);
  }

  for (const [key, group] of Object.entries(SK.GROUPS)) {
    const label = document.createElement('label');
    label.className = 'chk';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = state.groups.has(key);
    input.addEventListener('change', () => {
      input.checked ? state.groups.add(key) : state.groups.delete(key);
      markDirty();
    });
    label.append(input, document.createTextNode(' ' + group.label.toLowerCase()));
    el.groupList.append(label);
    groupInputs.set(key, input);
  }

  for (const target of SK.FOCUS_TARGETS) {
    const opt = document.createElement('option');
    opt.value = target.id;
    opt.textContent = target.label;
    opt.selected = target.id === 'right_hand';
    el.focusTarget.append(opt);
  }

  renderTrailChips();
  renderAngleChips();
}

/** Base chips, plus fingertips once the hand model is on, plus anything a
 *  focus lock has started trailing that is not otherwise listed. Points the
 *  selected body model cannot produce are left out — a chip that can only ever
 *  draw nothing is worse than no chip. */
function trailChipIds() {
  const base = el.handsChk.checked
    ? [...SK.TRAIL_CANDIDATES, ...SK.fingertipCandidates()]
    : [...SK.TRAIL_CANDIDATES];
  for (const id of state.trails) if (!base.includes(id)) base.push(id);
  return SK.keepProvided(base, providedPoseIds());
}

/**
 * Re-point the controls at what the selected model can actually deliver.
 *
 * A COCO model fills 17 of the 33 BlazePose slots, so the groups, trail chips,
 * angle chips and focus targets built for BlazePose would otherwise offer
 * points that never arrive. The sharp edge is the focus lock: the default
 * target is "right hand", which under COCO is just the wrist, so a scan locks
 * one point and `focus only` hides the rest of the body — the tracking looks
 * broken when it is working fine. So a lock that the new model cannot honour is
 * pruned, and dropped outright if nothing survives, rather than left drawing a
 * single orphan dot.
 */
function applyModelCapabilities() {
  const provided = providedPoseIds();

  for (const [key, group] of Object.entries(SK.GROUPS)) {
    const input = groupInputs.get(key);
    if (!input) continue;
    // Finger points only count when the hand model is actually running, or the
    // "hands" group looks available on a body model that has no hand points.
    const relevant = group.indices.filter((i) => !SK.isHandPoint(i) || el.handsChk.checked);
    const usable = SK.keepProvided(relevant, provided).length > 0;
    input.disabled = !usable;
    input.parentElement.classList.toggle('is-unavailable', !usable);
    input.parentElement.title = usable ? '' : 'the selected model does not provide these points';
    if (!usable && input.checked) {
      input.checked = false;
      state.groups.delete(key);
    }
  }

  // A focus target has to be able to deliver more than a single point. "Right
  // hand" under a COCO model is one wrist, and locking onto that with `focus
  // only` on leaves a lone dot travelling across an otherwise empty stage —
  // which reads as the tracking having failed. Better to not offer it.
  for (const opt of el.focusTarget.options) {
    if (opt.value === 'custom') { opt.disabled = false; continue; }
    const n = SK.focusCandidates(opt.value, {
      hands: el.handsChk.checked, custom: state.trails, provided,
    }).length;
    opt.disabled = n < 2;
  }
  if (el.focusTarget.selectedOptions[0]?.disabled) {
    const firstUsable = [...el.focusTarget.options].find((o) => !o.disabled);
    if (firstUsable) el.focusTarget.value = firstUsable.value;
  }

  renderAngleChips();

  const keptTrails = new Set(SK.keepProvided(state.trails, provided));
  if (keptTrails.size !== state.trails.size) state.trails = keptTrails;
  renderTrailChips();

  if (state.focus) {
    const kept = new Set(SK.keepProvided(state.focus.ids, provided));
    // Same bar as the focus targets above: a lock on one point is the lone dot.
    // A BlazePose "right hand" lock (wrist + three hand points) prunes to just
    // the wrist under COCO, so "nothing survives" is not the only case to drop.
    if (kept.size < 2) {
      clearFocus();
      setStatus('focus lock cleared — the selected model does not provide those points',
        'ready', 6000);
    } else if (kept.size !== state.focus.ids.size) {
      const lost = state.focus.ids.size - kept.size;
      state.focus = { ...state.focus, ids: kept };
      updateFocusReadout();
      setStatus(`focus lock trimmed to ${kept.size} points — the selected model does not provide the other ${lost}`,
        'ready', 6000);
    }
  }
  markDirty();
}

function renderTrailChips() {
  el.trailChips.replaceChildren();
  for (const index of trailChipIds()) {
    const chip = document.createElement('button');
    chip.className = 'chip' + (state.trails.has(index) ? ' is-on' : '');
    chip.textContent = SK.shortLabel(index);
    if (state.trails.has(index)) chip.style.background = SK.colorOf(index);
    chip.addEventListener('click', () => toggleTrail(index));
    el.trailChips.append(chip);
  }
}

function renderAngleChips() {
  const provided = providedPoseIds();
  el.angleChips.replaceChildren();
  for (const def of SK.ANGLES) {
    // An angle needs all three of its points. The ankle angles need a
    // foot-index point, which a COCO model has no equivalent for.
    if (SK.keepProvided([def.a, def.b, def.c], provided).length < 3) {
      state.angles.delete(def.id);
      continue;
    }
    const on = state.angles.has(def.id);
    const chip = document.createElement('button');
    chip.className = 'chip' + (on ? ' is-on' : '');
    chip.textContent = def.label;
    if (on) chip.style.background = seriesColor(selectedAngleDefs().findIndex((d) => d.id === def.id));
    chip.addEventListener('click', () => {
      state.angles.has(def.id) ? state.angles.delete(def.id) : state.angles.add(def.id);
      renderAngleChips();
      updateReadout();
      renderChart();
      markDirty();
    });
    el.angleChips.append(chip);
  }
}

function toggleTrail(index) {
  state.trails.has(index) ? state.trails.delete(index) : state.trails.add(index);
  renderTrailChips();
  markDirty();
}

function selectedAngleDefs() {
  return SK.ANGLES.filter((d) => state.angles.has(d.id));
}

function angleOpts() {
  // The canvas is sized to what is on screen, so its ratio is the ratio the
  // arcs are drawn at — including after a crop.
  const c = active?.el.canvas;
  return {
    mode: el.angleModeSel.value,
    aspect: c?.height ? c.width / c.height : 1,
  };
}

function markDirty() {
  for (const clip of clips) clip.dirty = true;
}

/**
 * Repair the model's left/right label swaps on a fresh track. Returns a short
 * phrase for the status line — an automatic edit to someone's data should never
 * happen silently.
 */
function fixSides(track) {
  if (!el.fixSidesChk.checked || !track?.length) {
    reportSides(null);
    return '';
  }
  const result = correctSideFlips(track);
  reportSides(result);
  const n = result.events.length;
  if (!n) return '';
  return ` · ${n} L/R exchange${n === 1 ? '' : 's'} fixed`;
}

function reportSides(result) {
  if (!el.fixSidesChk.checked) {
    el.sidesNote.textContent = 'Off — left and right are whatever the model said, exchanges included.';
    return;
  }
  if (!result) {
    el.sidesNote.textContent = 'The model labels limbs anatomically and can exchange left for right partway through a clip. Corrected runs are flagged in amber on the timeline.';
    return;
  }
  const events = result.events?.length ?? 0;
  if (!events) {
    el.sidesNote.textContent = 'Left and right stay consistent through this clip — nothing to fix.';
    return;
  }
  const at = result.events.slice(0, 4).map((e) => `${e.t.toFixed(2)}s`).join(', ');
  el.sidesNote.textContent =
    `Found ${events} left/right exchange${events === 1 ? '' : 's'} (at ${at}${events > 4 ? '…' : ''}) and made the clip consistent — ${result.corrected} frames changed. If the whole clip now has the sides the wrong way round, press Swap L/R.`;
}

/* ------------------------------------------------------------- focus scan */

/**
 * Sample the clip forward from the playhead, then keep only the candidate
 * points that were actually there — a point the model never saw is not
 * something you can track, so locking onto it would just draw a lie.
 */
function startScan() {
  if (state.scan) return cancelScan('scan cancelled');

  const target = el.focusTarget.value;
  const candidates = new Set(SK.focusCandidates(target, {
    hands: el.handsChk.checked,
    custom: state.trails,
    provided: providedPoseIds(),
  }));
  if (!candidates.size) {
    setStatus('nothing to scan for — pick some points first', 'error');
    return;
  }

  state.focus = null;
  state.scan = {
    target,
    candidates,
    scanLen: Number(el.scanLenSel.value),
    seen: new Map(),
    frames: 0,
  };
  scanClip();
}

function cancelScan(message) {
  state.scan = null;
  if (message) setStatus(message, '');
  updateFocusReadout();
  markDirty();
}

function scanAccumulate(frame) {
  const scan = state.scan;
  if (!scan || !frame) return;
  scan.frames++;
  for (const id of scan.candidates) {
    const p = SK.pointAt(frame, id);
    if (!p) continue;
    const entry = scan.seen.get(id) ?? { n: 0, vis: 0 };
    entry.n++;
    entry.vis += p.visibility;
    scan.seen.set(id, entry);
  }
}

function scanClip() {
  const scan = state.scan;
  const track = active?.track;
  if (!scan || !track?.length) return cancelScan('load a clip first');
  const start = active.index;
  const until = track.frames[start].t + scan.scanLen;
  for (let i = start; i < track.length && track.frames[i].t <= until; i++) {
    scanAccumulate(track.view[i]);
  }
  finishScan();
}

function finishScan() {
  const scan = state.scan;
  state.scan = null;
  if (!scan) return;

  if (scan.frames === 0) {
    setStatus('the scan saw no frames', 'error', 5000);
    updateFocusReadout();
    return;
  }

  const ids = new Set();
  for (const [id, entry] of scan.seen) {
    if (entry.n / scan.frames < SCAN.minPresence) continue;
    if (entry.vis / entry.n < SCAN.minVisibility) continue;
    ids.add(id);
  }

  if (!ids.size) {
    setStatus(`scan found none of those ${scan.candidates.size} points — move the playhead to where they are visible`,
      'error', 6000);
    updateFocusReadout();
    markDirty();
    return;
  }

  const label = SK.FOCUS_TARGETS.find((t) => t.id === scan.target)?.label ?? scan.target;
  state.focus = { ids, label, candidates: scan.candidates.size, frames: scan.frames };

  // A lock is useless if the group holding those points is switched off.
  for (const [key, group] of Object.entries(SK.GROUPS)) {
    if (!group.indices.some((i) => ids.has(i))) continue;
    state.groups.add(key);
    const input = groupInputs.get(key);
    if (input) input.checked = true;
  }

  state.trails = SK.trailPickFrom(ids);
  renderTrailChips();
  el.clearFocus.disabled = false;
  active?.setBadge(`locked · ${ids.size} pts`, 'locked');
  setStatus(`locked on ${ids.size} of ${scan.candidates.size} points — ${label}`, 'ready', 4000);
  updateFocusReadout();
  markDirty();
}

function clearFocus() {
  state.focus = null;
  el.clearFocus.disabled = true;
  for (const clip of clips) clip.setBadge(null);
  updateFocusReadout();
  markDirty();
}

function updateFocusReadout() {
  el.focusReadout.replaceChildren();
  const add = (left, right, cls = '') => {
    const line = document.createElement('div');
    line.className = `line ${cls}`.trim();
    const a = document.createElement('span');
    a.textContent = left;
    const b = document.createElement('span');
    b.textContent = right;
    line.append(a, b);
    el.focusReadout.append(line);
  };

  if (state.scan) {
    add('scanning', `${state.scan.candidates.size} candidates`);
    return;
  }
  if (!state.focus) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = 'No lock — tracking everything.';
    el.focusReadout.append(p);
    return;
  }
  add('locked on', state.focus.label, 'locked');
  add('points', `${state.focus.ids.size} of ${state.focus.candidates}`);
  add('trailing', `${state.trails.size}`);
}

/* --------------------------------------------------------------- plumbing */

let statusHoldUntil = 0;

/**
 * @param {string} kind
 * @param {number} holdMs keep this message visible for a while.
 */
function setStatus(text, kind = '', holdMs = 0) {
  el.statusText.textContent = text;
  el.status.className = 'status' + (kind ? ` is-${kind}` : '');
  statusHoldUntil = holdMs ? performance.now() + holdMs : 0;
}

/** Enable/disable everything that depends on the active clip. */
function updateControls() {
  const clip = active;
  const hasTrack = Boolean(clip?.track?.length);
  const isVideo = Boolean(clip?.hasClip);

  el.exportJson.disabled = !hasTrack;
  el.exportCsv.disabled = !hasTrack;
  el.exportAngles.disabled = !hasTrack;
  el.exportPng.disabled = !clip?.mediaEl;
  el.reanalyze.disabled = !isVideo;
  el.scanBtn.disabled = !hasTrack;
  el.swapSidesBtn.disabled = !hasTrack;
  el.swapFromHereBtn.disabled = !hasTrack;
  el.exportVideo.disabled = !clip?.hasClip || Boolean(videoExport);

  const canSelect = Boolean(clip?.mediaEl);
  el.selectArea.disabled = !canSelect;
  el.selectArea.textContent = clip?.selectMode ? 'Done selecting' : 'Select area';
  el.clearSelection.disabled = !clip?.selection;
  el.applyCrop.disabled = !clip?.selection;
  el.clearCrop.disabled = !clip?.crop;
  el.rescanBtn.disabled = !(clip?.selection && canSelect);

  const both = clips.length === 2 && clips.every((c) => c.hasClip);
  el.playBoth.disabled = !both;
  el.syncBoth.disabled = !both;
  el.playBoth.textContent = clips.some((c) => c.playing) ? '❚❚ Pause both' : '▶ Play both';
}

function syncSidebarToActive() {
  updateControls();
  updateReadout();
  renderChart();
}

/* ------------------------------------------------------------- draw state */

/** Options every clip shares; each adds its own crop, selection and range. */
function sharedOptions() {
  return {
    mirror: el.mirrorChk.checked,
    videoOpacity: Number(el.opacityRange.value),
    showSkeleton: el.skelChk.checked,
    showPoints: el.pointsChk.checked,
    showLabels: el.labelsChk.checked,
    showAngles: el.anglesChk.checked,
    angleDefs: selectedAngleDefs(),
    angleMode: el.angleModeSel.value,
    groups: [...state.groups],
    trails: state.trails,
    trailDots: el.trailDotsChk.checked,
    trailSeconds: Number(el.trailLenSel.value),
    strobeEvery: Number(el.strobeRange.value),
    pointScale: Number(el.pointScale.value),
    lineScale: Number(el.lineScale.value),
    visibilityThreshold: Number(el.visRange.value),
    focus: state.focus?.ids ?? null,
    focusOnly: el.focusOnlyChk.checked,
    focusDim: 0.16,
  };
}

function updateReadout() {
  const defs = selectedAngleDefs();
  const frame = active?.currentFrame() ?? null;
  el.angleReadout.replaceChildren();
  if (!defs.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = 'No angles selected.';
    el.angleReadout.append(p);
    return;
  }
  const opts = angleOpts();
  defs.forEach((def, i) => {
    const value = angleAt(frame, def, opts);
    const line = document.createElement('div');
    line.className = 'line';
    const left = document.createElement('span');
    const swatch = document.createElement('i');
    swatch.className = 'swatch';
    swatch.style.background = seriesColor(i);
    left.append(swatch, document.createTextNode(def.label));
    const right = document.createElement('span');
    right.textContent = value == null ? '—' : `${value.toFixed(1)}°`;
    line.append(left, right);
    el.angleReadout.append(line);
  });
}

function renderChart() {
  chart.render({
    track: active?.track ?? null,
    defs: selectedAngleDefs(),
    range: active?.range ?? [0, 0],
    playhead: active?.index ?? 0,
    mode: el.angleModeSel.value,
  });
}

/** Click anywhere on a clip to trail the nearest tracked point. */
function trailNearestPoint(clip, e) {
  const frame = clip.currentFrame();
  if (!frame) return;
  const canvas = clip.el.canvas;
  const rect = canvas.getBoundingClientRect();
  const cx = ((e.clientX - rect.left) / rect.width) * canvas.width;
  const cy = ((e.clientY - rect.top) / rect.height) * canvas.height;
  const src = clip.viewSource();
  const mirror = el.mirrorChk.checked;
  const minVis = Number(el.visRange.value);

  let best = -1;
  let bestDist = Infinity;
  for (const id of SK.idsInFrame(frame)) {
    const p = SK.pointAt(frame, id);
    if (!p || p.visibility < minVis) continue;
    const u = (p.x - src.x) / src.w;
    const x = (mirror ? 1 - u : u) * canvas.width;
    const y = ((p.y - src.y) / src.h) * canvas.height;
    const d = Math.hypot(x - cx, y - cy);
    if (d < bestDist) {
      bestDist = d;
      best = id;
    }
  }
  if (best >= 0 && bestDist < canvas.width * 0.04) toggleTrail(best);
}

/* --------------------------------------------------------- animation loop */

function tick() {
  requestAnimationFrame(tick);
  for (const clip of clips) clip.tick();
}

/* ------------------------------------------------------------ file loading */

// One shared landmarker graph means two clips must not be analysed at once:
// interleaved detectForVideo calls on the same graph confuse its tracker.
let analysisChain = Promise.resolve();
function queueAnalysis(fn) {
  const next = analysisChain.then(fn, fn).catch((err) => {
    console.error('analysis failed', err);
    setStatus(`analysis failed: ${err.message}`, 'error');
  });
  analysisChain = next;
  return next;
}

async function loadVideoFile(file, clip = clipA()) {
  setActiveClip(clip);
  await clip.loadFile(file);
  el.videoNote.textContent = `${file.name} — ${(file.size / 1e6).toFixed(1)} MB`;
  await queueAnalysis(() => runAnalysis(clip, { label: file.name }));
}

/** Second upload: load into clip B and show them side by side. */
async function loadCompare(file) {
  const clip = ensureCompare();
  await loadVideoFile(file, clip);
}

async function runAnalysis(clip, { label, region = null, boost = 1 } = {}) {
  if (!clip?.video?.src) return;
  clip.abort?.abort();
  const controller = new AbortController();
  clip.abort = controller;
  clip.pause();
  clip.onCancel(() => controller.abort());
  clip.showProgress(true, 'Analysing…');
  setStatus(region ? `rescanning ${clip.tag} inside the box…` : `analysing ${clip.tag}…`, 'busy');

  try {
    const track = await analyzeVideo(clip.video, {
      sampleFps: Number(el.fpsSel.value),
      model: el.modelSel.value,
      hands: el.handsChk.checked,
      region,
      boost,
      sourceLabel: label ?? clip.sourceName ?? 'clip',
      signal: controller.signal,
      onProgress: (frac, done, total) => clip.setProgress(frac, `Analysing frame ${done} / ${total}`),
    });
    if (controller.signal.aborted && track.length === 0) return;
    const sides = fixSides(track);
    clip.setTrack(track, { smoothing: Number(el.smoothRange.value) });
    const tracked = track.frames.filter((f) => f.pose).length;
    const pct = Math.round((tracked / Math.max(1, track.length)) * 100);
    const where = region ? ' in box' : '';
    setStatus(
      `${clip.tag}: ${track.length} frames · ${pct}% tracked${where} · ${currentDelegate()}${sides}`,
      pct > 0 ? 'ready' : 'error',
      sides || region ? 8000 : 0,
    );
  } catch (err) {
    console.error(err);
    setStatus(`analysis failed: ${err.message}`, 'error');
  } finally {
    clip.showProgress(false);
    clip.abort = null;
    updateControls();
  }
}

/**
 * Re-run detection using only the selected box as the model's input, and only
 * over the trimmed range in time. A rescan is a targeted second look, so it
 * replaces just that slice of the track and leaves the rest of the clip alone.
 */
function rescanSelection() {
  const clip = active;
  if (!clip?.selection) return;
  const region = { ...clip.selection };
  const boost = Number(el.boostRange.value);
  const model = el.rescanModelSel.value || el.modelSel.value;
  clip.setSelectMode(false);
  const [from, to] = clip.rangeTimes();
  queueAnalysis(() => rescanRange(clip, { region, boost, model, from, to }));
}

async function rescanRange(clip, { region, boost, model, from, to }) {
  const existing = clip.track;
  const wholeClip = !existing
    || (from <= 1e-6 && to >= existing.duration - 1e-6);

  clip.abort?.abort();
  const controller = new AbortController();
  clip.abort = controller;
  clip.pause();
  clip.onCancel(() => controller.abort());
  clip.showProgress(true, 'Rescanning…');
  const span = wholeClip ? 'whole clip' : `${from.toFixed(2)}–${to.toFixed(2)}s`;
  setStatus(`rescanning ${clip.tag} inside the box, ${span}…`, 'busy');

  try {
    const partial = await analyzeVideo(clip.video, {
      sampleFps: Number(el.fpsSel.value),
      model,
      hands: el.handsChk.checked,
      region,
      boost,
      from,
      to,
      sourceLabel: clip.sourceName ?? 'clip',
      signal: controller.signal,
      onProgress: (frac, done, total) => clip.setProgress(frac, `Rescanning frame ${done} / ${total}`),
    });
    if (controller.signal.aborted && partial.length === 0) return;

    const tracked = partial.frames.filter((f) => f.pose).length;
    const pct = Math.round((tracked / Math.max(1, partial.length)) * 100);

    let sides = '';
    if (wholeClip) {
      partial.meta.rescans = [{ from, to, region, boost, model }];
      sides = fixSides(partial);
      clip.setTrack(partial, { smoothing: Number(el.smoothRange.value) });
    } else {
      existing.replaceRange(from, to, partial.frames);
      existing.meta.rescans = [...(existing.meta.rescans ?? []), { from, to, region, boost, model }];
      existing.meta.model = `${existing.meta.model}+${model}`;
      // Run the left/right pass over the whole track, not just the new slice:
      // a swap can appear right at the seam between old and rescanned frames.
      sides = fixSides(existing);
      clip.refreshTrack({ smoothing: Number(el.smoothRange.value) });
    }

    setStatus(
      `${clip.tag}: rescanned ${partial.length} frames of ${span} · ${pct}% tracked in box · ${model} model${sides}`,
      pct > 0 ? 'ready' : 'error',
      8000,
    );
  } catch (err) {
    console.error(err);
    setStatus(`rescan failed: ${err.message}`, 'error');
  } finally {
    clip.showProgress(false);
    clip.abort = null;
    updateControls();
  }
}

/** Re-run whatever the active clip is, with its current settings. */
function reanalyseActive() {
  const clip = active;
  if (!clip?.hasClip) return;
  const region = clip.track?.meta.region ?? null;
  const boost = clip.track?.meta.boost ?? 1;
  queueAnalysis(() => runAnalysis(clip, { label: clip.sourceName, region, boost }));
}

/* ----------------------------------------------------------------- export */

function download(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function baseName() {
  const source = active?.track?.meta.source ?? 'clip';
  return source.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_').slice(0, 48) || 'clip';
}

/** @type {AbortController|null} */
let videoExport = null;

async function runVideoExport() {
  const clip = active;
  if (!clip?.hasClip || videoExport) return;
  videoExport = new AbortController();
  el.exportVideo.disabled = true;
  el.cancelExportVideo.hidden = false;
  const overlay = el.exportOverlayChk.checked;

  try {
    const result = await exportClipVideo(clip, {
      overlay,
      getOptions: sharedOptions,
      signal: videoExport.signal,
      onProgress: (f) => {
        el.exportVideoNote.textContent = `Recording… ${(f * 100).toFixed(0)}%`;
      },
    });
    const name = `${baseName()}-crop.${extensionFor(result.mimeType)}`;
    download(name, result.blob);
    el.exportVideoNote.textContent =
      `Wrote ${name} — ${result.width}×${result.height}, ${result.seconds.toFixed(2)}s, ${(result.blob.size / 1e6).toFixed(1)} MB${overlay ? ', with overlay' : ''}.`;
    setStatus(`exported ${name}`, 'ready', 8000);
  } catch (err) {
    console.error(err);
    el.exportVideoNote.textContent = `Export failed: ${err.message}`;
    setStatus(`video export failed: ${err.message}`, 'error', 8000);
  } finally {
    videoExport = null;
    el.cancelExportVideo.hidden = true;
    updateControls();
  }
}

function anglesCSV() {
  const defs = selectedAngleDefs();
  const track = active.track;
  const [from, to] = active.range;
  const series = defs.map((d) => track.angleSeries(d, el.angleModeSel.value));
  const rows = [['frame', 'time_s', ...defs.map((d) => d.id)].join(',')];
  for (let i = from; i <= to; i++) {
    const values = series.map((s) => (Number.isNaN(s[i]) ? '' : s[i].toFixed(2)));
    rows.push([i - from, track.frames[i].t.toFixed(4), ...values].join(','));
  }
  return rows.join('\n');
}

/* ----------------------------------------------------------------- events */

function wire() {
  const fail = (err) => setStatus(err.message, 'error');

  el.pickVideo.addEventListener('click', () => el.videoInput.click());
  el.pickVideoB.addEventListener('click', () => el.videoInputB.click());
  el.videoInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) loadVideoFile(file).catch(fail);
    e.target.value = '';
  });
  el.videoInputB.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) loadCompare(file).catch(fail);
    e.target.value = '';
  });
  el.closeVideoB.addEventListener('click', closeCompare);
  el.reanalyze.addEventListener('click', reanalyseActive);

  el.playBoth.addEventListener('click', () => {
    const anyPlaying = clips.some((c) => c.playing);
    for (const c of clips) {
      if (anyPlaying) c.pause();
      else c.play();
    }
    updateControls();
  });
  el.syncBoth.addEventListener('click', () => {
    const [a, b] = clips;
    if (!a?.track || !b?.track) return;
    // Match B's position to A's, measured from each clip's own trim start, so
    // two takes of different lengths line up on the action rather than the file.
    const offset = a.track.frames[a.index].t - a.rangeTimes()[0];
    b.setFrame(b.track.indexAt(b.rangeTimes()[0] + offset));
  });

  el.modelSel.addEventListener('change', async () => {
    // The backend has to be built before the controls can be re-pointed at it:
    // what a model provides is a property of the loaded backend, not of the
    // string in the dropdown.
    await ensureLandmarker({ model: el.modelSel.value });
    applyModelCapabilities();
    reanalyseActive();
  });
  el.fpsSel.addEventListener('change', reanalyseActive);

  el.smoothRange.addEventListener('input', () => {
    const value = Number(el.smoothRange.value);
    el.smoothVal.textContent = value.toFixed(2);
    for (const clip of clips) clip.setSmoothing(value);
    updateReadout();
    renderChart();
  });
  el.visRange.addEventListener('input', () => {
    el.visVal.textContent = Number(el.visRange.value).toFixed(2);
    markDirty();
  });
  el.opacityRange.addEventListener('input', () => {
    el.opacityVal.textContent = `${Math.round(Number(el.opacityRange.value) * 100)}%`;
    markDirty();
  });
  el.strobeRange.addEventListener('input', () => {
    const value = Number(el.strobeRange.value);
    el.strobeVal.textContent = value === 0 ? 'off' : `every ${value} frames`;
    markDirty();
  });
  el.boostRange.addEventListener('input', () => {
    el.boostVal.textContent = `${Number(el.boostRange.value).toFixed(1)}×`;
  });
  el.mirrorChk.addEventListener('change', markDirty);

  el.handsChk.addEventListener('change', () => {
    const on = el.handsChk.checked;
    el.handsNote.textContent = on
      ? '21 points per hand. A lock on “fingertips” now means real fingertips.'
      : 'Body tracking gives four coarse points per hand. Finger tracking adds a second model — more detail, roughly half the frame rate.';
    // Turning fingers on or off changes which groups and focus targets have any
    // points behind them, so the controls are re-pointed here too.
    applyModelCapabilities();
    // The track has to be rebuilt: hand points are recorded per frame.
    reanalyseActive();
  });

  el.fixSidesChk.addEventListener('change', () => {
    const on = el.fixSidesChk.checked;
    let total = 0;
    let last = null;
    for (const clip of clips) {
      if (!clip.track?.length) continue;
      if (on) {
        const result = correctSideFlips(clip.track);
        total += result.corrected;
        last = result;
      } else {
        total += undoSideFlips(clip.track);
      }
      clip.refreshTrack({ smoothing: Number(el.smoothRange.value) });
    }
    reportSides(on ? (last ?? null) : null);
    setStatus(
      on
        ? (total ? `fixed left/right on ${total} frames` : 'no left/right swaps found')
        : `left/right correction off — ${total} frames restored to the model's own labels`,
      '', 6000,
    );
    markDirty();
  });

  el.swapSidesBtn.addEventListener('click', () => {
    const clip = active;
    if (!clip?.track?.length) return;
    const changed = flipWholeTrack(clip.track);
    clip.refreshTrack({ smoothing: Number(el.smoothRange.value) });
    setStatus(`${clip.tag}: swapped left and right across ${changed} frames`, 'ready', 5000);
    markDirty();
  });

  el.swapFromHereBtn.addEventListener('click', () => {
    const clip = active;
    if (!clip?.track?.length) return;
    const from = clip.track.frames[clip.index].t;
    const changed = flipRange(clip.track, from, Infinity);
    clip.refreshTrack({ smoothing: Number(el.smoothRange.value) });
    setStatus(
      `${clip.tag}: swapped left and right from ${from.toFixed(2)}s onward (${changed} frames)`,
      'ready', 6000);
    markDirty();
  });

  el.angleModeSel.addEventListener('change', () => {
    el.angleModeNote.textContent = el.angleModeSel.value === 'world'
      ? 'The true joint angle in 3D, so it will differ from the arc on screen — and it inherits the model’s shaky depth estimates.'
      : 'Matches the arc drawn on the stage.';
    markDirty();
    updateReadout();
    renderChart();
  });

  el.scanBtn.addEventListener('click', startScan);
  el.clearFocus.addEventListener('click', clearFocus);
  el.focusOnlyChk.addEventListener('change', markDirty);
  for (const node of [el.focusTarget, el.scanLenSel]) {
    node.addEventListener('change', () => {
      if (state.scan) cancelScan();
    });
  }

  for (const node of [el.skelChk, el.pointsChk, el.labelsChk, el.anglesChk, el.trailDotsChk,
    el.pointScale, el.lineScale, el.trailLenSel]) {
    node.addEventListener('input', markDirty);
  }

  el.selectArea.addEventListener('click', () => {
    if (!active) return;
    active.setSelectMode(!active.selectMode);
    updateControls();
  });
  el.clearSelection.addEventListener('click', () => {
    active?.setSelection(null);
    active?.setSelectMode(false);
    updateControls();
  });
  el.applyCrop.addEventListener('click', () => {
    if (active?.applyCrop()) {
      setStatus(`${active.tag} cropped — landmarks are unchanged; press Rescan to detect inside the crop`, '', 6000);
    }
    updateControls();
  });
  el.clearCrop.addEventListener('click', () => {
    active?.clearCrop();
    updateControls();
  });
  el.rescanBtn.addEventListener('click', rescanSelection);

  el.exportJson.addEventListener('click', () => {
    const data = JSON.stringify(active.track.toJSON(active.range), null, 1);
    download(`${baseName()}-track.json`, new Blob([data], { type: 'application/json' }));
  });
  el.exportCsv.addEventListener('click', () => {
    download(`${baseName()}-landmarks.csv`,
      new Blob([active.track.toCSV(active.range)], { type: 'text/csv' }));
  });
  el.exportAngles.addEventListener('click', () => {
    if (!selectedAngleDefs().length) return setStatus('select at least one joint angle first', 'error');
    download(`${baseName()}-angles-${el.angleModeSel.value}.csv`,
      new Blob([anglesCSV()], { type: 'text/csv' }));
  });
  el.exportVideo.addEventListener('click', () => runVideoExport());
  el.cancelExportVideo.addEventListener('click', () => videoExport?.abort());

  el.exportPng.addEventListener('click', () => {
    active.el.canvas.toBlob(
      (blob) => download(`${baseName()}-frame${active.index + 1}.png`, blob), 'image/png');
  });

  window.addEventListener('keydown', (e) => {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        active?.togglePlay();
        updateControls();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        active?.step(e.shiftKey ? -10 : -1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        active?.step(e.shiftKey ? 10 : 1);
        break;
      case 'i': case 'I':
        active?.timeline.markIn();
        break;
      case 'o': case 'O':
        active?.timeline.markOut();
        break;
      case 'r': case 'R':
        active?.timeline.resetRange();
        break;
      case 's': case 'S':
        if (!el.scanBtn.disabled) startScan();
        break;
      case 'Escape':
        if (state.scan) cancelScan('scan cancelled');
        else if (active?.selectMode) {
          active.setSelectMode(false);
          updateControls();
        }
        break;
      default:
        break;
    }
  });

  window.addEventListener('beforeunload', () => {
    for (const clip of clips) clip.dispose();
  });
}

function attachDrop(clip) {
  clip.el.stage.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('video/')) {
      setStatus(`${file.name} is not a video`, 'error', 5000);
      return;
    }
    loadVideoFile(file, clip).catch((err) => setStatus(err.message, 'error'));
  });
}

/* ------------------------------------------------------------------- boot */

async function boot() {
  const first = makeClip('A');
  setActiveClip(first);
  buildControls();
  wire();
  updateControls();
  updateReadout();
  updateFocusReadout();
  renderChart();
  requestAnimationFrame(tick);

  setStatus('loading pose model…', 'busy');
  try {
    await ensureLandmarker({ model: el.modelSel.value });
    applyModelCapabilities();
    setStatus(`ready · ${MODELS[el.modelSel.value].label.split(' —')[0]} model · ${currentDelegate()}`, 'ready');
  } catch (err) {
    console.error(err);
    setStatus(`could not load model: ${err.message}`, 'error');
  }
}

// Handy from the devtools console, and what the smoke test drives.
window.motionStudio = {
  state, el, clips,
  get active() { return active; },
  get clipA() { return clips[0]; },
  get clipB() { return clips[1] ?? null; },
  get track() { return active?.track ?? null; },
  get timeline() { return active?.timeline ?? null; },
  setActiveClip,
  setFrame: (i) => active?.setFrame(i),
  step: (d) => active?.step(d),
  /** Resolves when the analysis queue has drained — analyses are serialised,
   *  so "the status no longer says detecting" can mean "not started yet". */
  idle: () => analysisChain,
  runAnalysis, reanalyseActive, rescanSelection,
  loadVideoFile, loadCompare, closeCompare,
  startScan, cancelScan, clearFocus,
};

boot();
