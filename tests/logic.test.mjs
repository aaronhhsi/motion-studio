// Node-side checks for the DOM-free logic modules.
import assert from 'node:assert/strict';
import { Track, angleAt } from '../js/track.js';
import { toFrame } from '../js/analyze.js';
import * as SK from '../js/skeleton.js';
import * as SIDES from '../js/sides.js';

// --- skeleton topology -----------------------------------------------------
assert.equal(SK.LANDMARK_NAMES.length, 33);
assert.equal(SK.L.RIGHT_WRIST, 16);
assert.equal(SK.L.LEFT_KNEE, 25);
for (const [a, b] of SK.CONNECTIONS) {
  assert.ok(a >= 0 && a < 33 && b >= 0 && b < 33, `bad connection ${a},${b}`);
}
for (const def of SK.ANGLES) {
  for (const i of [def.a, def.b, def.c]) assert.ok(i >= 0 && i < 33, `bad angle ${def.id}`);
}
assert.equal(SK.shortLabel(16), 'R wrist');
assert.equal(SK.sideOf(0), 'center');

// --- angle math ------------------------------------------------------------
const right = SK.angleBetween({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
assert.ok(Math.abs(right - 90) < 1e-6, `expected 90, got ${right}`);
const straight = SK.angleBetween({ x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
assert.ok(Math.abs(straight - 180) < 1e-6, `expected 180, got ${straight}`);
assert.equal(SK.angleBetween(null, { x: 0, y: 0 }, { x: 1, y: 0 }), null);

// --- build a synthetic track: a wrist sweeping a quarter circle -------------
function makePose(theta, jitter = 0) {
  const pts = [];
  for (let i = 0; i < 33; i++) pts.push({ x: 0.5, y: 0.5, z: 0, visibility: 1 });
  // shoulder / elbow / wrist on the right arm
  pts[SK.L.RIGHT_SHOULDER] = { x: 0.5, y: 0.3, z: 0, visibility: 1 };
  pts[SK.L.RIGHT_ELBOW] = { x: 0.5, y: 0.5, z: 0, visibility: 1 };
  pts[SK.L.RIGHT_WRIST] = {
    x: 0.5 + Math.sin(theta) * 0.2 + jitter,
    y: 0.5 + Math.cos(theta) * 0.2,
    z: 0,
    visibility: 1,
  };
  return pts;
}

const N = 31;
function buildTrack(jitter) {
  const t = new Track({ source: 'test', width: 640, height: 480, duration: 1, sampleFps: 30 });
  for (let i = 0; i < N; i++) {
    const theta = (i / (N - 1)) * (Math.PI / 2);
    const pose = makePose(theta, jitter ? (i % 2 ? 1 : -1) * jitter : 0);
    t.push({ t: i / 30, pose, world: pose.map((p) => ({ ...p })) });
  }
  return t;
}

const clean = buildTrack(0);
const track = buildTrack(0.004); // alternating jitter, for the smoothing checks

assert.equal(track.length, N);
assert.equal(track.indexAt(0), 0);
assert.equal(track.indexAt(1 / 30), 1);
assert.equal(track.indexAt(0.49), track.indexAt(0.5)); // clamps to nearest
assert.equal(track.indexAt(99), N - 1);
assert.equal(track.indexAt(-5), 0);

// elbow angle: shoulder is straight up from elbow, wrist sweeps 0 -> 90 degrees
const elbowDef = SK.ANGLES.find((d) => d.id === 'right_elbow');
const series = clean.angleSeries(elbowDef);
assert.ok(Math.abs(series[0] - 180) < 0.01, `start ${series[0]}`);
assert.ok(Math.abs(series[N - 1] - 90) < 0.01, `end ${series[N - 1]}`);
assert.ok(series.every((v, i) => i === 0 || v <= series[i - 1] + 1e-4), 'series should decrease');

// --- smoothing removes jitter without shifting the curve -------------------
const rawX = track.frames.map((f) => f.pose[SK.L.RIGHT_WRIST].x);
track.setSmoothing(0.6);
const smoothX = track.view.map((f) => f.pose[SK.L.RIGHT_WRIST].x);
assert.notEqual(track.view, track.frames, 'smoothing must not mutate raw frames');
assert.deepEqual(track.frames.map((f) => f.pose[SK.L.RIGHT_WRIST].x), rawX, 'raw frames untouched');

const roughness = (arr) => arr.slice(2).reduce((s, v, i) => s + Math.abs(v - 2 * arr[i + 1] + arr[i]), 0);
assert.ok(roughness(smoothX) < roughness(rawX) * 0.5, 'smoothing should cut jitter at least in half');

const meanShift = smoothX.reduce((s, v, i) => s + (v - rawX[i]), 0) / N;
assert.ok(Math.abs(meanShift) < 0.005, `zero-phase filter should not shift the curve (${meanShift})`);

track.setSmoothing(0);
assert.equal(track.view, track.frames);

// --- the filter must not move a frame the model got right -------------------
// A median stage was tried here to remove the one-frame torso collapses the
// pose model produces on a rotating subject. It made them worse: a run of
// collapsed frames outvotes the good ones, so the filter rewrote correct frames
// to match the broken ones. The property that has to hold is the opposite of
// spike rejection — an isolated bad frame may stay bad, but its neighbours must
// not be dragged toward it by more than the low-pass is asked for.
const SPIKE = 15;
const spiked = buildTrack(0);
spiked.frames[SPIKE].pose[SK.L.RIGHT_WRIST].x += 0.25;
spiked.setSmoothing(0.35);

const truth = buildTrack(0);
truth.setSmoothing(0.35);
const wristX = (t, i) => t.view[i].pose[SK.L.RIGHT_WRIST].x;

// Two frames out, a single 0.25 outlier must have almost no influence left.
for (const i of [SPIKE - 2, SPIKE + 2]) {
  const leak = Math.abs(wristX(spiked, i) - wristX(truth, i));
  assert.ok(leak < 0.05, `one bad frame reached too far into frame ${i} (${leak.toFixed(4)})`);
}
// And a frame the model got right keeps its own value, not a vote of its
// neighbours': at 0.35 the filter may pull it a little, never across.
const held = Math.abs(wristX(truth, SPIKE) - buildTrack(0).frames[SPIKE].pose[SK.L.RIGHT_WRIST].x);
assert.ok(held < 0.01, `a correct frame must keep its own value (moved ${held.toFixed(4)})`);

// --- the YOLO backend reuses the BlazePose id space ------------------------
// The whole reason adding a second body model cost almost nothing is that
// every COCO keypoint has an exact BlazePose counterpart, so renderer, trails,
// sides.js, the angle defs and the CSV all keep working untouched. If that
// mapping ever drifts, "left shoulder" starts naming something else.
const { COCO_TO_POSE, PROVIDED_IDS } = await import('../js/yolo.js');
const COCO_NAMES = [
  'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
  'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_hip', 'right_hip',
  'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
];
assert.equal(COCO_TO_POSE.length, 17, 'COCO has 17 keypoints');
COCO_NAMES.forEach((name, i) => {
  assert.equal(SK.LANDMARK_NAMES[COCO_TO_POSE[i]], name,
    `COCO ${i} (${name}) must map to the BlazePose index of the same name`);
});
assert.equal(new Set(COCO_TO_POSE).size, 17, 'no two COCO points may share a BlazePose index');

// The points it cannot fill must be exactly the ones we accepted losing:
// eye/mouth detail, the coarse hand points, and heel/foot_index.
const missing = [...Array(33).keys()].filter((i) => !PROVIDED_IDS.has(i));
assert.deepEqual(missing, [1, 3, 4, 6, 9, 10, 17, 18, 19, 20, 21, 22, 29, 30, 31, 32],
  `unexpected set of unfilled landmarks: ${missing}`);
// Every angle the app offers must still be computable, except the two that
// genuinely need a foot.
const needsFoot = SK.ANGLES.filter((d) => [d.a, d.b, d.c].some((i) => !PROVIDED_IDS.has(i)));
assert.deepEqual(needsFoot.map((d) => d.id), ['right_ankle', 'left_ankle'],
  'only the ankle angles should be lost with a COCO model');

// --- gaps ------------------------------------------------------------------
const gapTrack = new Track({ source: 'gap' });
gapTrack.push({ t: 0, pose: makePose(0), world: null });
gapTrack.push({ t: 0.1, pose: null, world: null });
gapTrack.push({ t: 0.2, pose: makePose(1), world: null });
gapTrack.setSmoothing(0.5);
assert.equal(gapTrack.view[1].pose, null, 'null frames survive smoothing');
assert.equal(angleAt(gapTrack.view[1], elbowDef), null);
const path = gapTrack.jointPath(SK.L.RIGHT_WRIST, 0, 2);
assert.equal(path.length, 3);
assert.equal(path[1], null, 'jointPath keeps a hole where tracking was lost');

// --- speed series ----------------------------------------------------------
const speed = track.speedSeries();
assert.equal(speed.length, N);
assert.ok(speed.every((v) => Number.isFinite(v) && v >= 0));
assert.ok(Math.max(...speed) > 0, 'a moving wrist should register speed');

// --- exports ---------------------------------------------------------------
const csv = track.toCSV([0, 2]);
const lines = csv.split('\n');
assert.equal(lines.length, 4, 'header + 3 rows');
assert.equal(lines[0].split(',').length, 2 + 33 * 4);
assert.ok(lines[0].startsWith('frame,time_s,nose_x,nose_y,nose_z,nose_vis,'));
assert.equal(lines[1].split(',')[0], '0', 'exported frames are renumbered from the trim point');

const gapCsv = gapTrack.toCSV().split('\n')[2].split(',');
assert.equal(gapCsv[2], '', 'untracked frames export as empty cells');

const json = track.toJSON([5, 9]);
assert.equal(json.format, 'motion-studio/track@2');
assert.equal(json.frames.length, 5);
assert.equal(json.frames[0].pose.length, 33);
assert.equal(json.frames[0].pose[0].length, 4);
assert.equal(json.meta.landmarkNames.length, 33);
assert.equal(json.meta.handLandmarkNames, undefined, 'no hand names when hands are off');
JSON.parse(JSON.stringify(json)); // must be serialisable

/* ================== left/right label swaps (the serve bug) =============== */

// A body cannot exchange its sides without turning through profile. So the
// detector looks for the signed shoulder separation jumping across zero in a
// single frame, which is physically impossible and therefore a relabelling.
//
// `facing` runs from +1 (one way) through 0 (profile) to -1 (the other way).
function turnedPose(facing, armUp = 0) {
  // Half the shoulder width, signed. Kept to realistic human proportions:
  // 0.1 of frame width on a 16:9 frame is ~0.68 torso lengths, well inside the
  // plausible range. A wider fixture is rejected as a collapsed pose.
  const half = 0.05 * facing;
  const pose = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  const set = (i, x, y) => { pose[i] = { x, y, z: 0, visibility: 1 }; };
  set(SK.L.NOSE, 0.5, 0.30);
  set(SK.L.LEFT_SHOULDER, 0.5 - half, 0.40);
  set(SK.L.RIGHT_SHOULDER, 0.5 + half, 0.40);
  set(SK.L.LEFT_ELBOW, 0.5 - half * 1.3, 0.52);
  set(SK.L.RIGHT_ELBOW, 0.5 + half * 1.3, 0.52 - 0.20 * armUp);
  set(SK.L.LEFT_WRIST, 0.5 - half * 1.5, 0.64);
  set(SK.L.RIGHT_WRIST, 0.5 + half * 1.5, 0.64 - 0.45 * armUp);
  set(SK.L.LEFT_HIP, 0.5 - half * 0.8, 0.66);
  set(SK.L.RIGHT_HIP, 0.5 + half * 0.8, 0.66);
  set(SK.L.LEFT_KNEE, 0.5 - half * 0.8, 0.80);
  set(SK.L.RIGHT_KNEE, 0.5 + half * 0.8, 0.80);
  set(SK.L.LEFT_ANKLE, 0.5 - half * 0.8, 0.93);
  set(SK.L.RIGHT_ANKLE, 0.5 + half * 0.8, 0.93);
  return pose;
}

const SERVE_N = 40;
function buildServe({ swapFrom = -1, swapTo = -1, facing = () => 1 } = {}) {
  const t = new Track({ source: 'serve', width: 1280, height: 720, duration: SERVE_N / 30, sampleFps: 30 });
  for (let i = 0; i < SERVE_N; i++) {
    const pose = turnedPose(facing(i), i / (SERVE_N - 1));
    const frame = {
      t: i / 30,
      pose,
      world: pose.map((p) => ({ ...p })),
      hands: { Right: Array.from({ length: 21 }, () => ({ x: 0.62, y: 0.1, z: 0, visibility: 1 })) },
    };
    if (i >= swapFrom && i <= swapTo) SIDES.swapSides(frame);
    t.push(frame);
  }
  return t;
}

// mirror mapping is symmetric and covers every paired joint
for (const [a, b] of SIDES.MIRROR_PAIRS) {
  assert.equal(SIDES.MIRROR[a], b);
  assert.equal(SIDES.MIRROR[b], a);
}
assert.equal(SIDES.MIRROR[SK.L.NOSE], SK.L.NOSE, 'centre points mirror to themselves');

// separation is signed, scale-free, and flips with the labels
const facingPose = turnedPose(1);
const sep = SIDES.separation(facingPose, 1280 / 720);
assert.ok(sep > 0.2, `expected a clear positive separation, got ${sep}`);
const profileSep = SIDES.separation(turnedPose(0.02), 1280 / 720);
assert.ok(Math.abs(profileSep) < 0.18, `near-profile should read near zero, got ${profileSep}`);
const mirrored = SIDES.swapSides({ pose: turnedPose(1).map((p) => ({ ...p })) }).pose;
assert.ok(Math.abs(SIDES.separation(mirrored, 1280 / 720) + sep) < 1e-9,
  'swapping the labels negates the separation');

// a clean clip must be left completely alone
const cleanServe = buildServe();
const cleanResult = SIDES.correctSideFlips(cleanServe);
assert.equal(cleanResult.corrected, 0, `clean clip must not be "fixed" (${cleanResult.corrected} frames)`);
assert.equal(cleanResult.events.length, 0);
assert.equal(SIDES.countImpossibleJumps(cleanServe), 0);

// inject a swap partway through, exactly as reported: it switches, then back
const broken = buildServe({ swapFrom: 12, swapTo: 24 });
const detected = SIDES.detectSideFlips(broken);
assert.equal(detected.events.length, 2,
  `expected two exchange events (in and out), got ${detected.events.length}`);
assert.deepEqual(detected.events.map((e) => e.index), [12, 25]);
assert.equal(detected.segments.length, 1);
assert.equal(detected.segments[0].from, 12);
assert.equal(detected.segments[0].to, 24);

// …and correcting it reproduces the original data exactly
const fixed = SIDES.correctSideFlips(broken);
assert.equal(fixed.corrected, 13, `expected 13 corrected frames, got ${fixed.corrected}`);
const reference = buildServe();
for (let i = 0; i < SERVE_N; i++) {
  for (const j of [SK.L.LEFT_WRIST, SK.L.RIGHT_WRIST, SK.L.LEFT_ELBOW, SK.L.RIGHT_ELBOW]) {
    assert.ok(Math.abs(broken.frames[i].pose[j].x - reference.frames[i].pose[j].x) < 1e-9
      && Math.abs(broken.frames[i].pose[j].y - reference.frames[i].pose[j].y) < 1e-9,
      `frame ${i} landmark ${j} not restored`);
  }
  assert.deepEqual(Object.keys(broken.frames[i].hands), ['Right'], `frame ${i} hand side not restored`);
}
// the guarantee the feature exists to provide
assert.equal(SIDES.countImpossibleJumps(broken), 0, 'no impossible jumps may remain after correction');

// the correction is reversible without re-analysing
assert.equal(SIDES.undoSideFlips(broken), 13);
assert.ok(Math.abs(broken.frames[18].pose[SK.L.RIGHT_WRIST].x
  - buildServe({ swapFrom: 12, swapTo: 24 }).frames[18].pose[SK.L.RIGHT_WRIST].x) < 1e-9,
  'undo puts the raw data back');

// A real rotation passes through profile, so it must not be touched. This is
// the case that made the previous detector mangle a real serve.
const turning = buildServe({ facing: (i) => Math.cos((i / (SERVE_N - 1)) * Math.PI) });
const turned = SIDES.correctSideFlips(turning);
assert.equal(turned.corrected, 0,
  `a smooth half-turn must not be "corrected" (${turned.corrected} frames touched)`);

// A swap *during* a turn is still caught, because it skips the profile zone.
const turningBroken = buildServe({
  facing: (i) => Math.cos((i / (SERVE_N - 1)) * Math.PI),
  swapFrom: 4, swapTo: 10,
});
assert.ok(SIDES.detectSideFlips(turningBroken).events.length >= 1,
  'a swap while turning should still be detected');
SIDES.correctSideFlips(turningBroken);
assert.equal(SIDES.countImpossibleJumps(turningBroken), 0);

// Gaps: the body may genuinely have turned while untracked, so no decision is
// made across a long dropout — the state is carried instead of guessed.
const gappy = buildServe({ swapFrom: 12, swapTo: 24 });
for (let i = 8; i < 12; i++) { gappy.frames[i].pose = null; gappy.frames[i].world = null; }
const gapFlips = SIDES.detectSideFlips(gappy);
assert.equal(gapFlips.flipped[9], false, 'an untracked frame inherits the current state');
assert.ok(gapFlips.events.every((e) => e.gap <= SIDES.DEFAULTS.maxGap + 1e-9),
  'no decision may be taken across a gap longer than maxGap');

// Whole-clip polarity is a separate, deliberate action.
const polarity = buildServe();
const beforeX = polarity.frames[5].pose[SK.L.RIGHT_WRIST].x;
const swappedCount = SIDES.flipWholeTrack(polarity);
assert.equal(swappedCount, SERVE_N);
assert.equal(polarity.meta.polarityFlipped, true);
assert.ok(Math.abs(polarity.frames[5].pose[SK.L.LEFT_WRIST].x - beforeX) < 1e-9,
  'a whole-clip swap exchanges the sides');
assert.equal(SIDES.countImpossibleJumps(polarity), 0,
  'a whole-clip swap stays internally consistent');
SIDES.flipWholeTrack(polarity);
assert.ok(Math.abs(polarity.frames[5].pose[SK.L.RIGHT_WRIST].x - beforeX) < 1e-9,
  'swapping twice returns to where it started');

/* =============== replaceRange: a rescan of part of a clip ================ */

// A rescan covers the trimmed slice only, so it must swap those frames in and
// leave the surrounding clip intact — otherwise trimming to a moment and
// rescanning it would throw the rest of the take away.
const spliceTrack = new Track({ source: 'splice', width: 640, height: 480, duration: 1 });
for (let i = 0; i < 10; i++) {
  const pose = makePose(0.1 * i);
  pose[SK.L.NOSE].visibility = 0.11; // a marker for "original" frames
  spliceTrack.push({ t: i / 10, pose, world: null, hands: null });
}

const fresh = [3, 4, 5, 6].map((i) => {
  const pose = makePose(0.1 * i);
  pose[SK.L.NOSE].visibility = 0.99; // a marker for "rescanned" frames
  return { t: i / 10, pose, world: null, hands: null };
});

spliceTrack.replaceRange(0.3, 0.6, fresh);
assert.equal(spliceTrack.length, 10, 'same frame count when counts happen to match');
const marks = spliceTrack.frames.map((f) => (f.pose[SK.L.NOSE].visibility > 0.5 ? 'new' : 'old'));
assert.deepEqual(marks, ['old', 'old', 'old', 'new', 'new', 'new', 'new', 'old', 'old', 'old'],
  'only the window is replaced');
assert.ok(spliceTrack.frames.every((f, i) => Math.abs(f.t - i / 10) < 1e-9),
  'times stay ordered across the splice');

// A rescan at a different sample rate changes the frame count in the window
const denser = new Track({ source: 'dense', width: 640, height: 480, duration: 1 });
for (let i = 0; i < 10; i++) denser.push({ t: i / 10, pose: makePose(0), world: null, hands: null });
const many = [];
for (let k = 0; k <= 6; k++) many.push({ t: 0.3 + k * 0.05, pose: makePose(0), world: null, hands: null });
denser.replaceRange(0.3, 0.6, many);
assert.equal(denser.length, 3 + 7 + 3, `expected 13 frames, got ${denser.length}`);
assert.ok(denser.frames.every((f, i) => i === 0 || f.t >= denser.frames[i - 1].t),
  'a denser rescan keeps the track monotonic in time');

// smoothing and the motion strip are rebuilt, not left stale
denser.setSmoothing(0.5);
denser.replaceRange(0.3, 0.6, many);
assert.equal(denser.view.length, denser.frames.length, 'the smoothed view is rebuilt after a splice');
assert.equal(denser.speedSeries().length, denser.frames.length, 'the speed series is rebuilt too');

// replacing the whole span is just a wholesale swap
const all = new Track({ source: 'all', width: 640, height: 480, duration: 1 });
for (let i = 0; i < 5; i++) all.push({ t: i / 10, pose: makePose(0), world: null, hands: null });
all.replaceRange(0, 1, [{ t: 0, pose: makePose(0), world: null, hands: null }]);
assert.equal(all.length, 1);

/* ===================== angles: image plane vs 3D world ==================== */

// A 16:9 frame, with the right elbow bent to a visually-obvious 135°:
// forearm straight up from the elbow, upper arm down-and-right at exactly 45°
// on screen. Normalised x is divided by 1280 and y by 720, so the raw
// coordinates do NOT describe that shape — only pixel proportions do.
const W = 1280;
const H = 720;
function bentArmPose() {
  const pts = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  pts[SK.L.RIGHT_ELBOW] = { x: 0.5, y: 0.5, z: 0, visibility: 1 };
  pts[SK.L.RIGHT_SHOULDER] = { x: 0.5, y: 0.4, z: 0, visibility: 1 };          // 72px up
  pts[SK.L.RIGHT_WRIST] = { x: 0.5 + 72 / W, y: 0.5 + 72 / H, z: 0, visibility: 1 }; // 72px right+down
  return pts;
}

const bent = { t: 0, pose: bentArmPose(), world: null, hands: null };
const aspect = W / H;

const onScreen = angleAt(bent, elbowDef, { mode: 'image', aspect });
assert.ok(Math.abs(onScreen - 135) < 0.01, `expected 135 on screen, got ${onScreen}`);

// …and without the correction it is wrong by more than 15 degrees, which is
// what made the readout disagree with the arc drawn on the stage.
const uncorrected = angleAt(bent, elbowDef, { mode: 'image', aspect: 1 });
assert.ok(Math.abs(uncorrected - 150.6) < 0.5, `expected ~150.6 uncorrected, got ${uncorrected}`);
assert.ok(Math.abs(uncorrected - onScreen) > 15, 'aspect correction must actually change the answer');

// Depth must not leak into a measurement that claims to describe the picture.
const withDepth = { t: 0, pose: bentArmPose(), world: null, hands: null };
withDepth.pose[SK.L.RIGHT_WRIST].z = 0.8;
withDepth.pose[SK.L.RIGHT_SHOULDER].z = -0.6;
assert.ok(Math.abs(angleAt(withDepth, elbowDef, { mode: 'image', aspect }) - 135) < 0.01,
  'image mode must ignore z');

// World mode reads the metric 3D estimate instead, and is free to disagree.
const withWorld = {
  t: 0,
  pose: bentArmPose(),
  world: Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 })),
  hands: null,
};
withWorld.world[SK.L.RIGHT_ELBOW] = { x: 0, y: 0, z: 0 };
withWorld.world[SK.L.RIGHT_SHOULDER] = { x: 0, y: -0.3, z: 0 };
withWorld.world[SK.L.RIGHT_WRIST] = { x: 0.3, y: 0, z: 0 };   // a true 90° in space
const world = angleAt(withWorld, elbowDef, { mode: 'world', aspect });
assert.ok(Math.abs(world - 90) < 0.01, `expected 90 in world mode, got ${world}`);
assert.ok(Math.abs(angleAt(withWorld, elbowDef, { mode: 'image', aspect }) - 135) < 0.01,
  'the same frame still reads 135 on screen');

// world mode falls back to the image when there are no world landmarks
assert.ok(Math.abs(angleAt(bent, elbowDef, { mode: 'world', aspect }) - 135) < 0.01);

// low-visibility joints are refused rather than guessed at
const dim = { t: 0, pose: bentArmPose(), world: null, hands: null };
dim.pose[SK.L.RIGHT_WRIST].visibility = 0.1;
assert.equal(angleAt(dim, elbowDef, { mode: 'image', aspect }), null);

// Track carries the aspect through to its series
const wide = new Track({ source: 'wide', width: W, height: H });
wide.push(bent);
assert.ok(Math.abs(wide.aspect - aspect) < 1e-9);
assert.ok(Math.abs(wide.angleSeries(elbowDef, 'image')[0] - 135) < 0.01,
  'angleSeries must use the track aspect');
assert.equal(new Track({ source: 'no-size' }).aspect, 1, 'aspect falls back to square');

/* ======================= hands & the unified point ids ==================== */

assert.equal(SK.HAND_LANDMARK_NAMES.length, 21);
for (const [a, b] of SK.HAND_CONNECTIONS) {
  assert.ok(a >= 0 && a < 21 && b >= 0 && b < 21, `bad hand connection ${a},${b}`);
}

// ids partition cleanly: body below 100, left hand 100s, right hand 200s
assert.equal(SK.isHandPoint(32), false);
assert.equal(SK.isHandPoint(100), true);
assert.equal(SK.handPointId('Left', 8), 108);
assert.equal(SK.handPointId('Right', 8), 208);
assert.equal(SK.handSideOf(108), 'Left');
assert.equal(SK.handSideOf(208), 'Right');
assert.equal(SK.handIndexOf(208), 8);
assert.equal(SK.shortLabel(208), 'R index tip');
assert.equal(SK.sideOf(208), 'right');
assert.equal(SK.sideOf(108), 'left');
assert.equal(SK.colorOf(108), SK.colorOf(SK.L.LEFT_WRIST), 'hand points inherit the side colour');
assert.equal(new Set(SK.allHandIds()).size, 42);

function makeHand(side, offset) {
  return Array.from({ length: 21 }, (_, i) => ({
    x: 0.6 + offset + i * 0.002,
    y: 0.4 + i * 0.002,
    z: 0,
    visibility: 1,
  }));
}

const handTrack = new Track({ source: 'hands', hands: true, duration: 0.2, sampleFps: 10 });
for (let i = 0; i < 6; i++) {
  const pose = makePose(0.3);
  handTrack.push({
    t: i / 10,
    pose,
    world: pose.map((p) => ({ ...p })),
    hands: { Right: makeHand('Right', i * 0.01), ...(i > 1 ? { Left: makeHand('Left', -i * 0.01) } : {}) },
  });
}

// pointAt reaches into either model
const f0 = handTrack.frames[0];
assert.equal(SK.pointAt(f0, SK.L.RIGHT_WRIST), f0.pose[16]);
assert.equal(SK.pointAt(f0, 208), f0.hands.Right[8]);
assert.equal(SK.pointAt(f0, 108), null, 'left hand absent in frame 0');
assert.equal(SK.pointAt(null, 208), null);

assert.equal(SK.idsInFrame(f0).length, 33 + 21, 'one hand present');
assert.equal(SK.idsInFrame(handTrack.frames[5]).length, 33 + 42, 'both hands present');

// trails follow hand points, with a hole where the hand was not seen
const handPath = handTrack.jointPath(108, 0, 5);
assert.equal(handPath.length, 6);
assert.equal(handPath[0], null, 'no left hand in frame 0');
assert.ok(handPath[5] && Math.abs(handPath[5].x - handTrack.frames[5].hands.Left[8].x) < 1e-9);

// smoothing covers hand channels and leaves the raw frames alone
const rawHandX = handTrack.frames.map((f) => f.hands.Right[8].x);
handTrack.setSmoothing(0.6);
assert.deepEqual(handTrack.frames.map((f) => f.hands.Right[8].x), rawHandX, 'raw hand frames untouched');
assert.notEqual(handTrack.view[3].hands.Right[8].x, rawHandX[3], 'hand points are smoothed');
assert.equal(handTrack.view[0].hands.Left, undefined, 'missing hands stay missing');

// a hands-only frame still registers motion
const handsOnly = new Track({ source: 'hands-only', hands: true });
handsOnly.push({ t: 0, pose: null, world: null, hands: { Right: makeHand('Right', 0) } });
handsOnly.push({ t: 0.1, pose: null, world: null, hands: { Right: makeHand('Right', 0.05) } });
assert.ok(handsOnly.speedSeries()[1] > 0, 'speed strip works without a body pose');

// exports widen to include hands only when the track has them
const handCsv = handTrack.toCSV().split('\n');
assert.equal(handCsv[0].split(',').length, 2 + (33 + 42) * 4);
assert.ok(handCsv[0].includes('righthand_index_tip_x'));
assert.ok(handCsv[1].split(',')[2 + 33 * 4 + 21 * 4] !== '', 'right-hand columns are populated');
assert.ok(!track.toCSV().includes('righthand_'), 'body-only tracks stay narrow');

const handJson = handTrack.toJSON();
assert.equal(handJson.meta.handLandmarkNames.length, 21);
assert.equal(handJson.frames[0].hands.Right.length, 21);
assert.equal(handJson.frames[0].hands.Left, undefined);
assert.equal(handJson.frames[5].hands.Left.length, 21);

/* ============ normalising what the models actually hand back ============= */

// The hand model does not populate `visibility`: every point comes back with a
// literal 0, which `?? 1` does not rescue. Left as 0, all 21 points per hand
// fall below every visibility threshold and nothing is drawn, trailed or
// locked onto — which is exactly what happened.
const rawHandResult = {
  landmarks: [Array.from({ length: 21 }, (_, i) => ({ x: 0.4 + i * 0.01, y: 0.5, z: 5e-7, visibility: 0 }))],
  worldLandmarks: [[]],
  handedness: [[{ score: 0.96, index: 0, categoryName: 'Right', displayName: 'Right' }]],
};
const rawPoseResult = {
  landmarks: [makePose(0.5)],
  worldLandmarks: [makePose(0.5)],
};

const normalised = toFrame(0, rawPoseResult, rawHandResult);
assert.ok(normalised.hands, 'a detected hand must survive normalisation');
assert.equal(normalised.hands.Right.length, 21);
assert.ok(normalised.hands.Right.every((p) => p.visibility === 1),
  'hand points must be visible: presence is the only signal this model gives');

// …and must therefore survive the filters that consume them
const handVisTrack = new Track({ source: 'raw', width: 640, height: 480, hands: true });
handVisTrack.push(normalised);
const drawnPath = handVisTrack.jointPath(SK.handPointId('Right', 8), 0, 0, 0.4);
assert.ok(drawnPath[0], 'a fingertip must not be filtered out at the default threshold');
assert.equal(SK.idsInFrame(normalised).length, 33 + 21);

// a hand the model did not label is dropped rather than guessed at
assert.equal(toFrame(0, rawPoseResult, {
  landmarks: [[{ x: 0, y: 0, z: 0 }]],
  handedness: [[{ categoryName: 'Unknown', score: 0.1 }]],
}).hands, null);

// no hand result at all is simply no hands
assert.equal(toFrame(0, rawPoseResult, null).hands, null);
assert.equal(toFrame(0, rawPoseResult, { landmarks: [] }).hands, null);

// when two hands claim the same side, the confident one wins
const twoRights = toFrame(0, rawPoseResult, {
  landmarks: [
    Array.from({ length: 21 }, () => ({ x: 0.1, y: 0.1, z: 0, visibility: 0 })),
    Array.from({ length: 21 }, () => ({ x: 0.9, y: 0.9, z: 0, visibility: 0 })),
  ],
  handedness: [
    [{ categoryName: 'Right', score: 0.4 }],
    [{ categoryName: 'Right', score: 0.95 }],
  ],
});
assert.equal(Object.keys(twoRights.hands).length, 1);
assert.ok(Math.abs(twoRights.hands.Right[0].x - 0.9) < 1e-9, 'kept the higher-scoring hand');

// pose landmarks keep their real visibility, including genuinely low values
const dimPose = toFrame(0, {
  landmarks: [makePose(0.5).map((p, i) => ({ ...p, visibility: i === 16 ? 0 : 0.9 }))],
  worldLandmarks: [makePose(0.5)],
}, null);
assert.equal(dimPose.pose[16].visibility, 0, 'a real pose visibility of 0 must not be rewritten');
assert.equal(dimPose.pose[15].visibility, 0.9);

/* ============================ focus targets ============================== */

// without the hand model, "fingertips" can only mean BlazePose's coarse points
const coarseTips = SK.focusCandidates('fingertips', { hands: false });
assert.ok(coarseTips.every((id) => !SK.isHandPoint(id)));
assert.ok(coarseTips.includes(SK.L.RIGHT_INDEX));

const realTips = SK.focusCandidates('fingertips', { hands: true });
assert.equal(realTips.length, 10, 'five tips per hand');
assert.ok(realTips.every((id) => SK.isHandPoint(id)));
assert.ok(realTips.includes(SK.handPointId('Right', 4)));

const rightHand = SK.focusCandidates('right_hand', { hands: true });
assert.ok(rightHand.includes(SK.L.RIGHT_WRIST), 'keeps the body wrist as an anchor');
assert.equal(rightHand.filter(SK.isHandPoint).length, 21);
assert.ok(rightHand.every((id) => SK.sideOf(id) === 'right'));
assert.equal(SK.focusCandidates('right_hand', { hands: false }).length, 4);

assert.equal(SK.focusCandidates('body').length, 33);
assert.deepEqual(SK.focusCandidates('custom', { custom: [1, 2, 3] }), [1, 2, 3]);
for (const target of SK.FOCUS_TARGETS) {
  assert.ok(SK.focusCandidates(target.id, { hands: true, custom: [5] }).length > 0,
    `${target.id} yields no candidates`);
}

// a big lock is thinned to the points the eye can actually follow
const small = SK.trailPickFrom(new Set([1, 2, 3]));
assert.equal(small.size, 3, 'small locks are kept whole');
const big = SK.trailPickFrom(new Set(SK.allHandIds()));
assert.ok(big.size <= 12, `thinned to ${big.size}`);
assert.ok([...big].every((id) => SK.FINGERTIPS.includes(SK.handIndexOf(id))), 'kept the fingertips');
const wholeBody = SK.trailPickFrom(new Set(Array.from({ length: 33 }, (_, i) => i)));
assert.ok(wholeBody.size <= 12 && wholeBody.has(SK.L.RIGHT_WRIST), 'kept the distal joints');

console.log('all logic checks passed');
