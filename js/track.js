// The recorded motion of a clip: one sample per analysed frame, plus the
// derived series (smoothing, speed, joint angles) the UI reads off it.

import {
  LANDMARK_NAMES, HAND_LANDMARK_NAMES, HAND_SIDES, angleBetween, pointAt, idsInFrame,
} from './skeleton.js';

/**
 * @typedef {{x:number, y:number, z:number, visibility:number}} Landmark
 * @typedef {{Left?:Landmark[], Right?:Landmark[]}} Hands
 * @typedef {{t:number, pose:Landmark[]|null, world:Landmark[]|null, hands:Hands|null}} Frame
 */

/** Independently smoothed streams within a frame. */
const CHANNELS = ['pose', 'world', 'hands.Left', 'hands.Right'];

function channel(frame, name) {
  if (name === 'pose') return frame.pose;
  if (name === 'world') return frame.world;
  return frame.hands?.[name.slice(6)] ?? null;
}

export class Track {
  constructor(meta = {}) {
    /** @type {Frame[]} */
    this.frames = [];
    this.meta = {
      source: 'unknown',
      width: 0,
      height: 0,
      duration: 0,
      sampleFps: 30,
      model: 'full',
      hands: false,
      createdAt: new Date().toISOString(),
      ...meta,
    };
    this._smoothing = 0;
    /** Smoothed copy the renderer draws from. Identical to `frames` at 0. */
    this.view = this.frames;
    this._speed = null;
  }

  get length() {
    return this.frames.length;
  }

  get duration() {
    return this.meta.duration || (this.frames.length ? this.frames.at(-1).t : 0);
  }

  /**
   * Source width / height. Normalised x is divided by width and y by height, so
   * anything measuring shape rather than position has to undo that first.
   */
  get aspect() {
    const { width, height } = this.meta;
    return width && height ? width / height : 1;
  }

  /** @param {Frame} frame */
  push(frame) {
    this.frames.push(frame);
    this._speed = null;
    if (this._smoothing === 0) this.view = this.frames;
  }

  /**
   * Swap freshly analysed frames into the window they cover, keeping everything
   * outside it. Lets a rescan of a trimmed section replace only that section
   * instead of discarding the rest of the clip.
   * @param {number} startT seconds
   * @param {number} endT seconds
   * @param {Frame[]} frames
   */
  replaceRange(startT, endT, frames) {
    const eps = 1e-6;
    const before = this.frames.filter((f) => f.t < startT - eps);
    const after = this.frames.filter((f) => f.t > endT + eps);
    this.frames = [...before, ...frames, ...after];
    this._speed = null;
    this.setSmoothing(this._smoothing); // rebuild the smoothed view
    return this;
  }

  /** Nearest sample index for a time in seconds. */
  indexAt(t) {
    const frames = this.frames;
    if (!frames.length) return -1;
    let lo = 0;
    let hi = frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(frames[lo - 1].t - t) <= Math.abs(frames[lo].t - t)) return lo - 1;
    return lo;
  }

  frameAt(t) {
    const i = this.indexAt(t);
    return i < 0 ? null : this.view[i];
  }

  get smoothing() {
    return this._smoothing;
  }

  /**
   * Zero-phase exponential smoothing (forward + backward pass), so joints stop
   * jittering without the whole skeleton lagging behind the video.
   *
   * Deliberately only a low-pass. A median stage was tried here to kill the
   * one-frame torso collapses the pose model produces on a rotating subject,
   * and it made them worse: those collapses are not noise scattered around the
   * truth but a second, wrong fit of the whole torso, and where a run of them
   * is locally in the majority a median votes for it. On the reference serve it
   * took a frame the model had got right (shoulder separation 0.0717 at 5.9s)
   * and rewrote it to 0.0230, pulling both shoulder points onto the sternum.
   * Removing those frames is a rejection problem, not a filtering one â€” see the
   * note in the README.
   *
   * @param {number} amount 0..1
   */
  setSmoothing(amount) {
    this._smoothing = amount;
    if (amount <= 0 || this.frames.length < 3) {
      this.view = this.frames;
      return;
    }
    const alpha = 1 - Math.min(0.95, amount * 0.9);
    const copy = (points) => (points ? points.map((p) => ({ ...p })) : null);
    this.view = this.frames.map((f) => ({
      t: f.t,
      pose: copy(f.pose),
      world: copy(f.world),
      hands: f.hands
        ? Object.fromEntries(HAND_SIDES.filter((s) => f.hands[s]).map((s) => [s, copy(f.hands[s])]))
        : null,
    }));
    for (const name of CHANNELS) {
      smoothPass(this.view, name, alpha, false);
      smoothPass(this.view, name, alpha, true);
    }
  }

  /**
   * Per-frame mean joint speed in normalised units/second â€” drives the motion
   * strip in the timeline so you can spot the interesting part of a clip.
   * @returns {Float32Array}
   */
  speedSeries() {
    if (this._speed) return this._speed;
    const n = this.frames.length;
    const out = new Float32Array(n);
    for (let i = 1; i < n; i++) {
      const a = this.frames[i - 1];
      const b = this.frames[i];
      const dt = b.t - a.t;
      if (dt <= 0) continue;
      let sum = 0;
      let count = 0;
      // Every point present in both frames â€” so a hands-only clip still
      // produces a useful motion strip.
      for (const id of idsInFrame(b)) {
        const p = pointAt(a, id);
        const q = pointAt(b, id);
        if (!p || !q || p.visibility < 0.3 || q.visibility < 0.3) continue;
        sum += Math.hypot(q.x - p.x, q.y - p.y);
        count++;
      }
      out[i] = count ? sum / count / dt : 0;
    }
    if (n > 1) out[0] = out[1];
    this._speed = out;
    return out;
  }

  /**
   * Angle at a joint over the whole clip, in degrees.
   * @param {'image'|'world'} mode see angleAt
   * @returns {Float32Array} NaN where the joint was not tracked.
   */
  angleSeries(def, mode = 'image') {
    const opts = { mode, aspect: this.aspect };
    const out = new Float32Array(this.view.length).fill(NaN);
    for (let i = 0; i < this.view.length; i++) {
      out[i] = angleAt(this.view[i], def, opts) ?? NaN;
    }
    return out;
  }

  /** Path of one point (body or hand) through normalised image space. */
  jointPath(id, fromIdx, toIdx, minVisibility = 0.4) {
    const pts = [];
    for (let i = Math.max(0, fromIdx); i <= Math.min(this.view.length - 1, toIdx); i++) {
      const f = this.view[i];
      const p = pointAt(f, id);
      if (!p || p.visibility < minVisibility) {
        pts.push(null); // a gap, so the trail is not drawn through occlusions
        continue;
      }
      pts.push({ x: p.x, y: p.y, t: f.t, i });
    }
    return pts;
  }

  toJSON(range) {
    const [from, to] = range ?? [0, this.frames.length - 1];
    const xyzv = (p) => [round(p.x), round(p.y), round(p.z), round(p.visibility, 3)];
    return {
      format: 'motion-studio/track@2',
      meta: {
        ...this.meta,
        landmarkNames: LANDMARK_NAMES,
        ...(this.meta.hands ? { handLandmarkNames: HAND_LANDMARK_NAMES } : {}),
      },
      frames: this.frames.slice(from, to + 1).map((f) => ({
        t: round(f.t, 4),
        pose: f.pose?.map(xyzv) ?? null,
        world: f.world?.map((p) => [round(p.x), round(p.y), round(p.z)]) ?? null,
        hands: f.hands
          ? Object.fromEntries(HAND_SIDES.filter((s) => f.hands[s]).map((s) => [s, f.hands[s].map(xyzv)]))
          : null,
      })),
    };
  }

  /** Column names for the wide landmark CSV, in export order. */
  columns() {
    const cols = LANDMARK_NAMES.map((name, id) => ({ name, id }));
    if (!this.meta.hands) return cols;
    for (const side of HAND_SIDES) {
      const prefix = side.toLowerCase();
      HAND_LANDMARK_NAMES.forEach((name, i) => {
        cols.push({ name: `${prefix}hand_${name}`, id: (side === 'Left' ? 100 : 200) + i });
      });
    }
    return cols;
  }

  toCSV(range) {
    const [from, to] = range ?? [0, this.frames.length - 1];
    const cols = this.columns();
    const head = ['frame', 'time_s'];
    for (const { name } of cols) head.push(`${name}_x`, `${name}_y`, `${name}_z`, `${name}_vis`);

    const rows = [head.join(',')];
    for (let i = from; i <= to; i++) {
      const f = this.frames[i];
      const row = [i - from, round(f.t, 4)];
      for (const { id } of cols) {
        const p = pointAt(f, id);
        if (p) row.push(round(p.x), round(p.y), round(p.z), round(p.visibility, 3));
        else row.push('', '', '', '');
      }
      rows.push(row.join(','));
    }
    return rows.join('\n');
  }
}

/**
 * Angle at a joint for a single frame, in degrees, or null if untracked.
 *
 * @param {'image'|'world'} mode
 *   `image` measures the angle you can actually see â€” the two bones exactly as
 *   drawn on the stage. `world` uses MediaPipe's metric 3D estimate, which is
 *   the physically correct joint angle when a limb points toward or away from
 *   the camera, but inherits the model's shaky depth estimates and will not
 *   match the arc on screen.
 * @param {number} aspect
 *   Source width / height. Normalised x and y are divided by different numbers,
 *   so without this a visually-135Â° elbow measures 150Â° on a 16:9 frame.
 */
export function angleAt(frame, def, { mode = 'image', aspect = 1 } = {}) {
  if (!frame?.pose) return null;
  const pose = frame.pose;

  // World landmarks carry no visibility of their own; borrow the 2D scores.
  const vis = [def.a, def.b, def.c].map((i) => pose[i]?.visibility ?? 0);
  if (Math.min(...vis) < 0.3) return null;

  if (mode === 'world' && frame.world) {
    return angleBetween(frame.world[def.a], frame.world[def.b], frame.world[def.c]);
  }

  // Back to pixel proportions, and flat: depth must not leak into a measurement
  // that claims to describe the picture.
  const flat = (i) => ({ x: pose[i].x * aspect, y: pose[i].y, z: 0 });
  return angleBetween(flat(def.a), flat(def.b), flat(def.c));
}

function smoothPass(frames, name, alpha, reverse) {
  const order = reverse ? [...frames.keys()].reverse() : [...frames.keys()];
  let prev = null;
  for (const i of order) {
    const pts = channel(frames[i], name);
    if (!pts) {
      prev = null;
      continue;
    }
    if (!prev) {
      prev = pts;
      continue;
    }
    for (let j = 0; j < pts.length; j++) {
      pts[j].x = alpha * pts[j].x + (1 - alpha) * prev[j].x;
      pts[j].y = alpha * pts[j].y + (1 - alpha) * prev[j].y;
      pts[j].z = alpha * pts[j].z + (1 - alpha) * prev[j].z;
    }
    prev = pts;
  }
}

function round(v, digits = 5) {
  if (v == null || Number.isNaN(v)) return '';
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
