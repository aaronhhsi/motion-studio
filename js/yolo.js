// A YOLO-pose backend, as an alternative to MediaPipe's BlazePose.
//
// Why there are two: BlazePose *regresses* landmark coordinates, and a
// regression model under uncertainty collapses toward the mean of its training
// distribution. For a torso the mean is a narrow one, so when BlazePose is
// unsure it slides both shoulders and both hips onto the body's midline and
// draws the torso as a spine — while still placing every distal joint
// correctly, which is what makes it look like a bug rather than a bad guess.
// On the reference serve that happens often enough to make the shoulder
// separation bimodal: a correct mode near 0.08 and a degenerate one near 0.03,
// with 21 frames collapsed below 0.01. It cannot be filtered out afterwards,
// because where a run of those frames is locally in the majority any smoother
// votes for the wrong mode.
//
// YOLO-pose localises each keypoint spatially instead, so it has no mean pose
// to fall back to. Measured on `darlansouzaserve-crop.webm` against the
// player's width read straight off the jersey pixels (0.1035 at the shoulder
// band, so ~0.08 expected at the joint centres):
//
//                           frames detected   shoulder sep. through the wind-up
//   MediaPipe full          508/514           0.009 - 0.072, oscillating
//   YOLOv8s-pose           336/336            0.078 - 0.083, steady
//
// and no frame anywhere in the clip below 0.01.
//
// The cost is that COCO has 17 keypoints where BlazePose has 33. Every COCO
// point maps exactly onto a BlazePose index, so the rest of the app needs no
// changes at all — the 16 ids COCO does not cover simply arrive with zero
// visibility and are skipped everywhere a visibility threshold is already
// applied. What is missing is the eye/mouth detail, the four coarse hand points
// and the heel/foot-index points; ankle angles therefore read null, and the
// hand model (ticked separately) is the way to get fingers.

import { MODELS, ORT_BUNDLE_URL, ORT_WASM_DIR } from './config.js';

/**
 * COCO-17 -> BlazePose-33. COCO's order is nose, eyes, ears, shoulders,
 * elbows, wrists, hips, knees, ankles — left before right throughout.
 */
export const COCO_TO_POSE = [
  0,          // nose
  2, 5,       // left_eye, right_eye
  7, 8,       // left_ear, right_ear
  11, 12,     // shoulders
  13, 14,     // elbows
  15, 16,     // wrists
  23, 24,     // hips
  25, 26,     // knees
  27, 28,     // ankles
];

/** The BlazePose ids a COCO model can fill in. Everything else stays empty. */
export const PROVIDED_IDS = new Set(COCO_TO_POSE);

const POSE_POINTS = 33;
const KEYPOINTS = 17;
/** Box channels before the keypoints: cx, cy, w, h, score. */
const BOX_CHANNELS = 5;
/** Below this the frame has no person in it worth reporting. */
const MIN_SCORE = 0.3;

let ort = null;
let session = null;
let loaded = { model: null, provider: null };
let canvas = null;
let ctx = null;
let input = null;
let noWebGpu = false;

/** 'webgpu' or 'wasm' — which execution provider the session actually built on. */
export function currentProvider() {
  return loaded.provider;
}

export function isYoloModel(key) {
  return MODELS[key]?.backend === 'yolo';
}

async function loadOrt() {
  if (ort) return ort;
  const mod = await import(/* @vite-ignore */ ORT_BUNDLE_URL);
  ort = mod.default ?? mod;
  ort.env.wasm.wasmPaths = ORT_WASM_DIR;
  // Threaded wasm needs SharedArrayBuffer, which needs the page to be
  // cross-origin isolated. It is not (the model and the runtime come from a
  // CDN), so asking for threads would only produce a console full of failed
  // worker spawns before falling back anyway.
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = 'error';
  return ort;
}

/**
 * Create (or reuse) the YOLO session. Tries WebGPU first and falls back to
 * wasm, which is the same shape of decision MediaPipe's GPU/CPU fallback makes.
 */
export async function ensureYolo({ model }) {
  const spec = MODELS[model];
  if (!spec || spec.backend !== 'yolo') throw new Error(`not a YOLO model: ${model}`);
  await loadOrt();

  const want = noWebGpu ? 'wasm' : 'webgpu';
  if (session && loaded.model === model && loaded.provider === want) return session;
  if (session) {
    await session.release?.();
    session = null;
  }

  // Firefox's WebGPU builds the session and runs without complaint, but the
  // numbers that come back are wrong: on the reference serve every keypoint
  // lands on one diagonal line at ~0.55 confidence, where wasm in the same
  // browser — and WebGPU in Chrome and Edge on the same GPU — finds the player
  // at ~0.95. Nothing throws, so the fallback below can never catch it; the
  // stage just shows one dot zigzagging across the frame.
  const firefox = /firefox/i.test(navigator.userAgent);
  const providers = noWebGpu || !navigator.gpu || firefox ? ['wasm'] : ['webgpu', 'wasm'];
  for (const provider of providers) {
    try {
      session = await ort.InferenceSession.create(spec.url, {
        executionProviders: [provider],
        graphOptimizationLevel: 'all',
      });
      loaded = { model, provider };
      break;
    } catch (err) {
      if (provider === providers.at(-1)) throw err;
      console.warn(`ONNX ${provider} unavailable, falling back:`, err);
    }
  }

  const size = spec.inputSize;
  if (!canvas || canvas.width !== size) {
    canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    ctx = canvas.getContext('2d', { willReadFrequently: true });
    input = new Float32Array(3 * size * size);
  }
  return session;
}

/** Give up on WebGPU for the rest of the session. @returns {boolean} moved */
export async function yoloFallbackToWasm() {
  if (noWebGpu) return false;
  noWebGpu = true;
  if (loaded.model) await ensureYolo({ model: loaded.model });
  return true;
}

export function releaseYolo() {
  session?.release?.();
  session = null;
  loaded = { model: null, provider: null };
}

export function hasYolo() {
  return Boolean(session);
}

/**
 * Letterbox the source into the square the model wants, preserving aspect.
 * Squashing the frame to a square instead would stretch the person, and the
 * model would faithfully report the stretched body.
 */
function fit(source) {
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  const size = canvas.width;
  const scale = Math.min(size / sw, size / sh);
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);
  const dx = Math.floor((size - w) / 2);
  const dy = Math.floor((size - h) / 2);

  // Mid grey for the bars: the letterbox is not part of the picture, and a
  // neutral fill is what the model was trained to ignore.
  ctx.fillStyle = '#727272';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(source, 0, 0, sw, sh, dx, dy, w, h);
  return { scale, dx, dy, sw, sh, size };
}

/**
 * Run the model on one frame.
 *
 * Returns MediaPipe's result shape — `{ landmarks: [points], worldLandmarks }`
 * with 33 points normalised to the *source* (0..1), so `region.js` can map a
 * crop home and `analyze.js` needs no special case. `worldLandmarks` is null:
 * this model has no depth estimate, which `angleAt` already handles by falling
 * back to the image plane.
 *
 * @param {HTMLVideoElement|HTMLCanvasElement|HTMLImageElement} source
 * @returns {Promise<{landmarks: Array, worldLandmarks: null}|null>}
 */
export async function detectYolo(source) {
  if (!session) throw new Error('YOLO session not created');
  const box = fit(source);
  const { size } = box;

  const pixels = ctx.getImageData(0, 0, size, size).data;
  const plane = size * size;
  for (let i = 0; i < plane; i++) {
    input[i] = pixels[i * 4] / 255;
    input[plane + i] = pixels[i * 4 + 1] / 255;
    input[2 * plane + i] = pixels[i * 4 + 2] / 255;
  }

  const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, size, size]) };
  const out = await session.run(feeds);
  const tensor = out[session.outputNames[0]];
  const anchors = tensor.dims[2];
  const d = tensor.data;

  // One class (person), so the best anchor is simply the highest score. No NMS:
  // the app tracks a single pose, and a box is how you choose which person.
  let best = -1;
  let bestScore = MIN_SCORE;
  for (let a = 0; a < anchors; a++) {
    const score = d[4 * anchors + a];
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  if (best < 0) return { landmarks: [], worldLandmarks: null };

  const points = new Array(POSE_POINTS);
  for (let i = 0; i < POSE_POINTS; i++) points[i] = { x: 0, y: 0, z: 0, visibility: 0 };
  for (let k = 0; k < KEYPOINTS; k++) {
    const x = d[(BOX_CHANNELS + k * 3) * anchors + best];
    const y = d[(BOX_CHANNELS + k * 3 + 1) * anchors + best];
    const score = d[(BOX_CHANNELS + k * 3 + 2) * anchors + best];
    points[COCO_TO_POSE[k]] = {
      // Undo the letterbox, then normalise the way BlazePose does: x by the
      // source width and y by its height.
      x: (x - box.dx) / box.scale / box.sw,
      y: (y - box.dy) / box.scale / box.sh,
      z: 0,
      visibility: score,
    };
  }
  return { landmarks: [points], worldLandmarks: null };
}
