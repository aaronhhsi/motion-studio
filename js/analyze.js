// The offline analysis pass: step a video frame by frame and build a Track
// from it.

import {
  ensureLandmarker, ensureHandLandmarker, releaseHandLandmarker, beginRun,
  detectVideo, detectHandsVideo, isGpuFailure, fallbackToCpu,
} from './landmarker.js';
import { Track } from './track.js';
import { DEFAULTS } from './config.js';
import { createSampler, mapResult, isFullFrame } from './region.js';

/**
 * Run a detection, and if the GPU path dies mid-inference, rebuild on CPU and
 * try once more. Creating the graph can succeed on a machine whose WebGL then
 * falls over on the first real call, so catching this only at creation time is
 * not enough.
 */
export async function detectWithRecovery(run) {
  try {
    // `await`, not a bare return: the ONNX backend rejects asynchronously, and
    // `return run()` would hand that rejection straight past this catch.
    return await run();
  } catch (err) {
    if (!isGpuFailure(err)) throw err;
    console.warn('GPU inference failed, retrying on CPU:', err);
    if (!(await fallbackToCpu())) throw err;
    beginRun();
    return run();
  }
}

/**
 * MediaRecorder-produced WebM files report duration = Infinity until they have
 * been seeked to the end once. Forces the real value out.
 */
export function ensureDuration(video) {
  return new Promise((resolve) => {
    if (Number.isFinite(video.duration) && video.duration > 0) return resolve(video.duration);
    const onUpdate = () => {
      if (!Number.isFinite(video.duration)) return;
      video.removeEventListener('durationchange', onUpdate);
      video.currentTime = 0;
      resolve(video.duration);
    };
    video.addEventListener('durationchange', onUpdate);
    video.currentTime = 1e101;
    setTimeout(() => {
      video.removeEventListener('durationchange', onUpdate);
      resolve(video.duration);
    }, 3000);
  });
}

export function seekTo(video, t) {
  return new Promise((resolve) => {
    const target = Math.max(0, Math.min(t, Math.max(0, video.duration - 1e-3)));
    if (video.readyState >= 2 && Math.abs(video.currentTime - target) < 1e-4) return resolve();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('seeked', done);
      resolve();
    };
    const timer = setTimeout(done, 2000);
    video.addEventListener('seeked', done);
    video.currentTime = target;
  });
}

/**
 * Walk a video at a fixed sample rate and record the pose at every step.
 * Deterministic and lossless (unlike sampling during playback, which drops
 * frames when detection can't keep up).
 *
 * @returns {Promise<Track>}
 */
export async function analyzeVideo(video, {
  sampleFps = DEFAULTS.sampleFps,
  model = DEFAULTS.model,
  numPoses = DEFAULTS.numPoses,
  hands = false,
  region = null,
  boost = 1,
  /** Analyse only this time window — the clip's trim, for a targeted rescan. */
  from = 0,
  to = Infinity,
  sourceLabel = 'video',
  onProgress = () => {},
  signal,
} = {}) {
  await ensureLandmarker({ model, numPoses });
  if (hands) await ensureHandLandmarker();
  else releaseHandLandmarker();
  beginRun();

  const wasPlaying = !video.paused;
  video.pause();
  const duration = await ensureDuration(video);

  const track = new Track({
    source: sourceLabel,
    width: video.videoWidth,
    height: video.videoHeight,
    duration,
    sampleFps,
    model,
    hands,
    region: isFullFrame(region) ? null : region,
    boost: boost === 1 ? undefined : boost,
  });

  const sampler = createSampler(video.videoWidth, video.videoHeight, region, boost);
  const step = 1 / sampleFps;
  const last = Math.max(0, duration - 1e-3);
  const start = Math.max(0, Math.min(from, last));
  const end = Math.max(start, Math.min(to, last));
  track.meta.window = [start, end];
  const total = Math.max(1, Math.ceil((end - start) / step));
  let lastTime = -1;

  for (let n = 0; n <= total; n++) {
    if (signal?.aborted) break;
    const asked = Math.min(start + n * step, end);
    await seekTo(video, asked);

    // Record where the video actually landed, not where we aimed. Browsers
    // decode the frame containing the requested time, so on a 24fps clip
    // sampled at 30 several requests resolve to the same picture — storing the
    // request would make "step one frame" move the overlay without moving the
    // image.
    const t = Number.isFinite(video.currentTime) ? video.currentTime : asked;
    if (t <= lastTime && n > 0) {
      if (n % 3 === 0 || n === total) onProgress((n + 1) / (total + 1), n + 1, total + 1);
      continue; // same decoded frame as the previous sample
    }
    lastTime = t;

    const input = sampler ? sampler.grab(video) : video;
    let result = null;
    let handResult = null;
    try {
      result = mapResult(sampler, await detectWithRecovery(() => detectVideo(input, t * 1000)));
      if (hands) handResult = mapResult(sampler, await detectHandsVideo(input, t * 1000));
    } catch (err) {
      console.warn('detect failed at', t, err);
    }
    track.push(toFrame(t, result, handResult));
    if (n % 3 === 0 || n === total) onProgress((n + 1) / (total + 1), n + 1, total + 1);
  }

  await seekTo(video, 0);
  if (wasPlaying) video.play().catch(() => {});
  return track;
}

/** Normalise MediaPipe results (first person only) into a Track frame. */
export function toFrame(t, result, handResult = null) {
  const pose = result?.landmarks?.[0] ?? null;
  const world = result?.worldLandmarks?.[0] ?? null;
  return {
    t,
    pose: pose ? pose.map(normalisePoint) : null,
    world: world ? world.map(normalisePoint) : null,
    hands: toHands(handResult),
  };
}

const normalisePoint = (p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility ?? 1 });

/**
 * The hand model does not populate `visibility` — it reports a literal 0 on
 * every point, which `?? 1` will not rescue. Left alone, all 21 points per hand
 * fall below every visibility threshold in the app and nothing is ever drawn,
 * trailed or locked onto. Presence in the result is the only signal this model
 * gives, so a returned point counts as visible.
 */
const normaliseHandPoint = (p) => ({ x: p.x, y: p.y, z: p.z, visibility: 1 });

/**
 * Keyed by handedness so a point id maps to the same physical hand across
 * frames — the raw result array order is not stable.
 * @returns {{Left?:object[], Right?:object[]}|null}
 */
function toHands(result) {
  if (!result?.landmarks?.length) return null;
  const out = {};
  const scores = {};
  result.landmarks.forEach((points, i) => {
    const side = result.handedness?.[i]?.[0]?.categoryName;
    if (side !== 'Left' && side !== 'Right') return;
    // Both hands can come back labelled the same when one is ambiguous; keep
    // the confident one rather than letting the later result overwrite it.
    const score = result.handedness[i][0].score ?? 0;
    if (out[side] && scores[side] >= score) return;
    out[side] = points.map(normaliseHandPoint);
    scores[side] = score;
  });
  return Object.keys(out).length ? out : null;
}
