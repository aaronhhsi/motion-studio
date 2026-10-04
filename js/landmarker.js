// Thin wrapper around MediaPipe's landmarkers: loading, delegate selection and
// the monotonic timestamp bookkeeping the VIDEO running mode insists on.
//
// The graph is created once in VIDEO mode and never switched. Calling
// setOptions({runningMode}) tears down the WebGL context and builds a new one,
// which fails outright on some machines ("GLctx is undefined") and leaks
// contexts towards the browser's ~16-context cap on the rest.

import { VISION_BUNDLE_URL, WASM_BASE_URL, MODELS, HAND_MODEL, DEFAULTS } from './config.js';
import { blockTelemetry } from './no-telemetry.js';
import {
  ensureYolo, detectYolo, releaseYolo, isYoloModel, currentProvider, yoloFallbackToWasm, hasYolo,
  PROVIDED_IDS,
} from './yolo.js';

/**
 * Which backend the body model runs on. The hand model is always MediaPipe, so
 * finger tracking works under either — this only decides where a *pose* comes
 * from. Null until a model has been chosen.
 */
let backend = null;

let vision = null;
let visionModule = null;
let landmarker = null;
let state = { model: null, numPoses: null, delegate: null };

let handLandmarker = null;
let handState = { delegate: null };

// detectForVideo() throws if timestamps ever go backwards, and the counter is
// shared across every clip a session analyses. Each run gets an offset past the
// previous high-water mark so relative timing inside a run is still honest.
let lastTimestamp = -1;
let lastHandTimestamp = -1;
let runOffset = 0;

export function getModule() {
  return visionModule;
}

async function loadVision() {
  if (vision) return vision;
  blockTelemetry(); // MediaPipe 1.x phones home with usage stats; see no-telemetry.js
  visionModule = await import(/* @vite-ignore */ VISION_BUNDLE_URL);
  vision = await visionModule.FilesetResolver.forVisionTasks(WASM_BASE_URL);
  return vision;
}

/* --------------------------------------------------------------- delegate */

let cpuOnly = false;
let delegatePreference = null;

/** Cheap up-front probe: no WebGL2 means the GPU delegate cannot possibly work. */
function webglUsable() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function preferredDelegate() {
  if (cpuOnly) return 'CPU';
  if (delegatePreference === null) delegatePreference = webglUsable() ? 'GPU' : 'CPU';
  return delegatePreference;
}

const GL_FAILURE = /GLctx|activeTexture|WebGL|gl_context|OpenGL|framebuffer|shader/i;

/** Does this look like the GPU path dying rather than a real modelling error? */
export function isGpuFailure(err) {
  return GL_FAILURE.test(String(err?.message ?? err ?? ''));
}

/**
 * Give up on the GPU for the rest of the session and rebuild everything on CPU.
 * @returns {Promise<boolean>} false if we were already on CPU, i.e. no way out.
 */
export async function fallbackToCpu() {
  if (backend === 'yolo') return yoloFallbackToWasm();
  if (cpuOnly) return false;
  const { model, numPoses } = state;
  const hadHands = Boolean(handLandmarker);
  cpuOnly = true;
  delegatePreference = 'CPU';
  dispose();
  if (model) await ensureLandmarker({ model, numPoses, delegate: 'CPU' });
  if (hadHands) await ensureHandLandmarker({ delegate: 'CPU' });
  return true;
}

/* ------------------------------------------------------------ landmarkers */

/**
 * Create (or reconfigure) the pose landmarker. Cheap to call repeatedly: it
 * only rebuilds when something that matters actually changed.
 */
export async function ensureLandmarker({
  model = DEFAULTS.model,
  numPoses = DEFAULTS.numPoses,
  delegate = preferredDelegate(),
} = {}) {
  // A different backend entirely, so the MediaPipe graph is torn down rather
  // than left holding a WebGL context nobody is going to use.
  if (isYoloModel(model)) {
    if (landmarker) {
      landmarker.close();
      landmarker = null;
      state = { model: null, numPoses: null, delegate: null };
    }
    backend = 'yolo';
    return ensureYolo({ model });
  }

  if (backend === 'yolo') {
    releaseYolo();
    backend = null;
  }
  backend = 'mediapipe';

  const fileset = await loadVision();
  const { PoseLandmarker } = visionModule;

  if (landmarker && state.model === model && state.numPoses === numPoses && state.delegate === delegate) {
    return landmarker;
  }

  if (landmarker) {
    landmarker.close();
    landmarker = null;
  }

  try {
    landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODELS[model].url, delegate },
      runningMode: 'VIDEO',
      numPoses,
      minPoseDetectionConfidence: DEFAULTS.minPoseDetectionConfidence,
      minPosePresenceConfidence: DEFAULTS.minPosePresenceConfidence,
      minTrackingConfidence: DEFAULTS.minTrackingConfidence,
      outputSegmentationMasks: false,
    });
    state = { model, numPoses, delegate };
  } catch (err) {
    if (delegate === 'GPU') {
      // Headless GPUs, remote desktop and old drivers all land here.
      console.warn('GPU delegate unavailable, falling back to CPU:', err);
      cpuOnly = true;
      delegatePreference = 'CPU';
      return ensureLandmarker({ model, numPoses, delegate: 'CPU' });
    }
    throw err;
  }

  return landmarker;
}

/**
 * The 21-point-per-hand model, loaded only when the user asks for fingers.
 * Kept separate from the pose landmarker so the default path stays fast.
 */
export async function ensureHandLandmarker({ delegate = preferredDelegate() } = {}) {
  const fileset = await loadVision();
  const { HandLandmarker } = visionModule;

  if (handLandmarker && handState.delegate === delegate) return handLandmarker;
  if (handLandmarker) {
    handLandmarker.close();
    handLandmarker = null;
  }

  try {
    handLandmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: HAND_MODEL.url, delegate },
      runningMode: 'VIDEO',
      numHands: HAND_MODEL.numHands,
    });
    handState = { delegate };
  } catch (err) {
    if (delegate === 'GPU') {
      console.warn('GPU delegate unavailable for hands, falling back to CPU:', err);
      cpuOnly = true;
      delegatePreference = 'CPU';
      return ensureHandLandmarker({ delegate: 'CPU' });
    }
    throw err;
  }
  return handLandmarker;
}

export function releaseHandLandmarker() {
  if (handLandmarker) {
    handLandmarker.close();
    handLandmarker = null;
  }
  handState = { delegate: null };
}

export function hasHandLandmarker() {
  return Boolean(handLandmarker);
}

export function isReady() {
  return backend === 'yolo' ? hasYolo() : Boolean(landmarker);
}

export function currentDelegate() {
  return backend === 'yolo' ? currentProvider() : state.delegate;
}

/**
 * Which of the 33 body landmark slots the selected model actually fills, or
 * null for "all of them". The UI needs this so it does not offer a focus lock
 * or a trail on a point that will never arrive.
 * @returns {Set<number>|null}
 */
export function providedPoseIds() {
  return backend === 'yolo' ? PROVIDED_IDS : null;
}

/* ------------------------------------------------------------- inference */

/** Call before each analysis pass. */
export function beginRun() {
  runOffset = Math.max(lastTimestamp, lastHandTimestamp) + 1;
}

/**
 * One detection. MediaPipe answers synchronously; ONNX Runtime answers with a
 * promise, so every caller awaits this — `await` on a plain value costs a
 * microtask and nothing else.
 *
 * @returns {object|Promise<object>} MediaPipe's result shape either way
 */
export function detectVideo(source, timeMs) {
  if (backend === 'yolo') return detectYolo(source);
  let ts = Math.round(timeMs) + runOffset;
  if (ts <= lastTimestamp) ts = lastTimestamp + 1;
  lastTimestamp = ts;
  return landmarker.detectForVideo(source, ts);
}

/**
 * Hands share the pose timestamp counter, so both graphs stay in step and
 * neither can be fed a stale timestamp.
 */
export function detectHandsVideo(source, timeMs) {
  if (!handLandmarker) return null;
  let ts = Math.round(timeMs) + runOffset;
  if (ts <= lastHandTimestamp) ts = lastHandTimestamp + 1;
  lastHandTimestamp = ts;
  return handLandmarker.detectForVideo(source, ts);
}

export function dispose() {
  if (landmarker) {
    landmarker.close();
    landmarker = null;
  }
  releaseYolo();
  releaseHandLandmarker();
  backend = null;
  state = { model: null, numPoses: null, delegate: null };
}
