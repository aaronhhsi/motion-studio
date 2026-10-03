// Fixing left/right label swaps.
//
// BlazePose labels landmarks anatomically — 11 is *the player's* left shoulder,
// not the left of the picture. When a subject rotates, turns away, or the track
// drops for a frame, the model can exchange that assignment for a stretch and
// then exchange it back. Angles, trails and exports for "right elbow" then
// describe the left arm for part of the clip.
//
// The signal that separates a relabelling from real motion is geometric: you
// cannot get from "right shoulder is left of left shoulder" to the reverse
// without passing through profile, where the two coincide. A genuine rotation
// carries the signed shoulder separation smoothly through zero over several
// frames. A relabelling jumps straight across it in one frame. So we look for
// sign changes that skipped the middle.
//
// What this CANNOT decide is which polarity is the correct one. Every cue the
// model gives — including its 3D world landmarks — flips together with the
// labels, so its output is self-consistent even when it is wrong about which
// way the player faces. Making a clip internally consistent is automatic;
// choosing the global polarity needs one human decision, so there is a button
// for it.

/** Landmark index pairs that mirror each other. Centre points are absent. */
export const MIRROR_PAIRS = [
  [1, 4], [2, 5], [3, 6], [7, 8], [9, 10],   // face
  [11, 12], [13, 14], [15, 16],              // shoulder, elbow, wrist
  [17, 18], [19, 20], [21, 22],              // pinky, index, thumb
  [23, 24], [25, 26], [27, 28],              // hip, knee, ankle
  [29, 30], [31, 32],                        // heel, foot
];

/** index -> its mirror, or itself for centre points. */
export const MIRROR = (() => {
  const map = new Int8Array(33).map((_, i) => i);
  for (const [a, b] of MIRROR_PAIRS) {
    map[a] = b;
    map[b] = a;
  }
  return map;
})();

const L_SHOULDER = 11;
const R_SHOULDER = 12;
const L_HIP = 23;
const R_HIP = 24;

export const DEFAULTS = {
  /**
   * Signed shoulder separation, in torso lengths, below which the body is too
   * close to profile for left/right to be distinguishable at all.
   */
  nearProfile: 0.18,
  /** Never compare across a gap longer than this; the body may really have turned. */
  maxGap: 0.12,
  /** Shoulders below this visibility do not get a vote. */
  minVisibility: 0.5,
  /**
   * Shoulder width is well under a torso length on a real person. Anything
   * wider means the pose collapsed that frame (a tiny torso divides into a huge
   * ratio), so the frame is not evidence of anything.
   */
  maxPlausible: 1.0,
  /**
   * Decisions are taken on a median of this many neighbouring frames. A median
   * is edge-preserving: it erases isolated noise spikes without softening the
   * genuine step changes we are looking for. Without it, values hovering just
   * above `nearProfile` oscillate and every wobble reads as an exchange.
   */
  smoothWindow: 5,
  /**
   * At a candidate boundary, how much better swapping must explain the motion
   * before we call it a relabelling. A body that really turned carries its
   * joints with it, so both readings are similar (ratio near 1); a relabelling
   * leaves every joint where it was and only exchanges the names, which scores
   * far lower. Measured on real serves: relabellings land at 0.12–0.37.
   */
  swapRatio: 0.6,
  /** Below this much movement the ratio is dividing noise by noise. */
  minMotion: 0.012,
};

/** Joints used to ask "did the body move, or did only the names change?" */
const LIMBS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

/**
 * Mean movement of the limbs between two poses, optionally pairing each joint
 * with its mirror. Returns null when too few joints are visible to judge.
 */
function limbMotion(prevPose, curPose, swapped, aspect, minVisibility) {
  let sum = 0;
  let n = 0;
  for (const j of LIMBS) {
    const k = swapped ? MIRROR[j] : j;
    const a = prevPose[j];
    const b = curPose[k];
    if (!a || !b) continue;
    if (a.visibility < minVisibility || b.visibility < minVisibility) continue;
    sum += Math.hypot((b.x - a.x) * aspect, b.y - a.y);
    n++;
  }
  return n >= 6 ? sum / n : null;
}

/** Median filter — keeps steps sharp while dropping isolated spikes. */
function medianFilter(values, window) {
  if (window <= 1) return values.slice();
  const half = Math.floor(window / 2);
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length - 1, i + half);
    const slice = values.slice(lo, hi + 1).sort((a, b) => a - b);
    out[i] = slice[(slice.length - 1) >> 1];
  }
  return out;
}

/** Swap left for right within one frame, in place. */
export function swapSides(frame) {
  if (frame.pose) frame.pose = mirrorPoints(frame.pose);
  if (frame.world) frame.world = mirrorPoints(frame.world);
  if (frame.hands) {
    const { Left, Right } = frame.hands;
    const next = {};
    if (Right) next.Left = Right;
    if (Left) next.Right = Left;
    frame.hands = next;
  }
  return frame;
}

function mirrorPoints(points) {
  const out = new Array(points.length);
  for (let i = 0; i < points.length; i++) out[i] = points[MIRROR[i] ?? i];
  return out;
}

/** Swap a frame and keep its parity flag honest, so undo stays exact. */
function toggleFrame(frame) {
  swapSides(frame);
  if (frame.sideFlipped) delete frame.sideFlipped;
  else frame.sideFlipped = true;
}

/**
 * Signed horizontal offset of the right shoulder from the left, in torso
 * lengths so it is independent of how large the subject is in frame.
 * Positive and negative mean opposite facings; near zero means profile.
 * @returns {number|null} null when it cannot be measured
 */
export function separation(pose, aspect, minVisibility = DEFAULTS.minVisibility) {
  if (!pose) return null;
  const ls = pose[L_SHOULDER];
  const rs = pose[R_SHOULDER];
  const lh = pose[L_HIP];
  const rh = pose[R_HIP];
  if (!ls || !rs || !lh || !rh) return null;
  if (Math.min(ls.visibility, rs.visibility) < minVisibility) return null;

  // Mid-points are averages of a mirrored pair, so they do not move when the
  // labels swap — the scale stays stable across a flip.
  const midShoulderX = ((ls.x + rs.x) / 2) * aspect;
  const midShoulderY = (ls.y + rs.y) / 2;
  const midHipX = ((lh.x + rh.x) / 2) * aspect;
  const midHipY = (lh.y + rh.y) / 2;
  const torso = Math.hypot(midShoulderX - midHipX, midShoulderY - midHipY);
  if (torso < 1e-6) return null;

  return ((rs.x - ls.x) * aspect) / torso;
}

/**
 * Find the frames whose sides are exchanged relative to the first tracked
 * frame. Pure: nothing is modified.
 *
 * @param {import('./track.js').Track} track
 * @returns {{flipped: boolean[], events: Array<object>, segments: Array<object>}}
 */
export function detectSideFlips(track, options = {}) {
  const { nearProfile, maxGap, minVisibility, maxPlausible, smoothWindow,
    swapRatio, minMotion } = { ...DEFAULTS, ...options };
  const aspect = track.aspect;
  const frames = track.frames;
  const flipped = new Array(frames.length).fill(false);
  const events = [];

  // ---- pass 1: every frame we can actually measure --------------------------
  const pts = [];
  for (let i = 0; i < frames.length; i++) {
    if (!frames[i].pose) continue;
    const sep = separation(frames[i].pose, aspect, minVisibility);
    if (sep === null || Math.abs(sep) > maxPlausible) continue;
    pts.push({ i, t: frames[i].t, sep, smooth: sep, pose: frames[i].pose, clear: false, flip: false });
  }

  // The ambiguous-zone reasoning runs on a median-filtered copy, so that a
  // single noisy frame cannot start a cascade near the threshold. Each frame's
  // own raw sign is still what gets corrected, at the end.
  const smoothed = medianFilter(pts.map((p) => p.sep), smoothWindow);
  pts.forEach((p, k) => { p.smooth = smoothed[k]; });

  // ---- pass 2: at every candidate boundary, did the body move or not? -------
  let state = false;
  let prev = null; // the previous *measurable* frame
  for (const p of pts) {
    const effective = state ? -p.smooth : p.smooth;
    const rawEffective = state ? -p.sep : p.sep;
    p.clear = Math.abs(effective) >= nearProfile;
    const recent = prev && p.t - prev.t <= maxGap;

    if (recent && Math.sign(rawEffective) !== Math.sign(prev.rawEffective)) {
      // The side changed. Ask the joints which it was: a body that really
      // turned brings its limbs along, so keeping the labels continues the
      // motion best. A relabelling leaves every joint where it was, so pairing
      // each with its mirror continues it far better. This is the decisive
      // test — shoulder geometry alone cannot see a swap that happens near
      // profile, which is where the model does it most.
      //
      // The comparison is against the previous frame *as corrected*, and the
      // outcome is this frame's absolute orientation, not a toggle. Toggling
      // makes alternating labels chase each other instead of settling.
      const correctedPrev = prev.flip ? mirrorPoints(prev.pose) : prev.pose;
      const asIs = limbMotion(correctedPrev, p.pose, false, aspect, minVisibility);
      const mirrored = limbMotion(correctedPrev, p.pose, true, aspect, minVisibility);
      const measurable = asIs !== null && mirrored !== null
        && Math.max(asIs, mirrored) >= minMotion;

      let decided = null;
      if (measurable) {
        if (mirrored < asIs * swapRatio) decided = true;
        else if (asIs < mirrored * swapRatio) decided = false;
      }

      if (decided !== null) {
        if (decided !== state) {
          events.push({
            index: p.i,
            t: p.t,
            gap: Number((p.t - prev.t).toFixed(4)),
            before: Number(prev.rawEffective.toFixed(3)),
            after: Number(rawEffective.toFixed(3)),
            keep: Number(asIs.toFixed(4)),
            swap: Number(mirrored.toFixed(4)),
            ratio: Number((mirrored / asIs).toFixed(3)),
            reason: 'joints did not move',
          });
        }
        state = decided;
      } else if (p.clear && prev.clear
        && Math.sign(effective) !== Math.sign(prev.effective)) {
        // Too few joints visible to compare. Fall back on geometry: a sign
        // change that skipped the near-profile zone is impossible for a body.
        events.push({
          index: p.i,
          t: p.t,
          gap: Number((p.t - prev.t).toFixed(4)),
          before: Number(prev.effective.toFixed(3)),
          after: Number(effective.toFixed(3)),
          keep: null,
          swap: null,
          ratio: null,
          reason: 'jumped across profile',
        });
        state = !state;
      }
    }

    p.flip = state;
    // The believed facing, from this frame's own corrected sign. It must come
    // from the raw value: when the model alternates its labels every frame,
    // `state` alternates with it — correctly — and pairing that with a smoothed
    // (non-alternating) sign would put the alternation straight back into the
    // output. Ambiguous stretches get their facing rewritten below.
    p.facing = Math.sign(state ? -p.sep : p.sep);
    prev = {
      t: p.t,
      pose: p.pose,
      flip: state,
      clear: p.clear,
      effective: state ? -p.smooth : p.smooth,
      rawEffective: state ? -p.sep : p.sep,
    };
  }

  // ---- pass 3: fill the ambiguous stretches ---------------------------------
  // Near profile the shoulders overlap and the model's left/right is close to a
  // coin toss, so its labels oscillate frame to frame — the "switching around"
  // that is actually visible. Neither assignment is more plausible there, so
  // the stretch is decided by its ends instead of by per-frame noise: same sign
  // either side means the body wobbled and came back (hold it steady), opposite
  // signs mean it genuinely turned through (let it cross exactly once).
  for (let k = 0; k < pts.length; k++) {
    if (pts[k].clear) continue;
    let end = k;
    while (end + 1 < pts.length && !pts[end + 1].clear) end++;

    const before = k > 0 ? pts[k - 1] : null;
    const after = end + 1 < pts.length ? pts[end + 1] : null;
    const sA = before ? before.facing : (after ? after.facing : 0);
    const sB = after ? after.facing : sA;

    // Where the body is closest to edge-on is the most plausible crossing point.
    let cross = end + 1;
    if (sA !== sB) {
      let best = Infinity;
      for (let m = k; m <= end; m++) {
        if (Math.abs(pts[m].smooth) < best) {
          best = Math.abs(pts[m].smooth);
          cross = m;
        }
      }
    }

    for (let m = k; m <= end; m++) {
      pts[m].facing = m < cross ? sA : sB;
    }
    k = end;
  }

  // ---- pass 4: correct each frame to the believed facing --------------------
  // Comparing each frame's *own* raw sign against the smoothed belief also
  // straightens isolated noisy frames, not just whole exchanged runs.
  let steadied = 0;
  for (const p of pts) {
    if (p.facing === 0) continue;
    const want = Math.sign(p.sep) !== p.facing;
    if (want !== p.flip) steadied++;
    p.flip = want;
  }

  // ---- spread the decisions back over every frame, gaps included ------------
  let carried = false;
  let next = 0;
  for (let i = 0; i < frames.length; i++) {
    if (next < pts.length && pts[next].i === i) {
      carried = pts[next].flip;
      next++;
    }
    flipped[i] = carried;
  }

  return { flipped, events, steadied, segments: toSegments(flipped, frames) };
}

function toSegments(flipped, frames) {
  const segments = [];
  let start = -1;
  for (let i = 0; i <= flipped.length; i++) {
    if (i < flipped.length && flipped[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      segments.push({
        from: start,
        to: i - 1,
        fromT: frames[start].t,
        toT: frames[i - 1].t,
      });
      start = -1;
    }
  }
  return segments;
}

/**
 * Make a clip internally consistent: after this, left and right no longer
 * exchange partway through. Marks every frame it changed so the correction can
 * be undone without re-analysing.
 * @returns {{corrected:number, events:Array<object>, segments:Array<object>}}
 */
export function correctSideFlips(track, options = {}) {
  // Correcting changes the data the next decision reads, so one pass is not
  // always a fixed point: repairing an early exchange can reveal a later one it
  // was masking. Repeat until nothing is found, with a hard bound so a
  // pathological clip cannot spin.
  const MAX_PASSES = 4;
  let corrected = 0;
  let steadied = 0;
  let events = [];
  let passes = 0;

  for (; passes < MAX_PASSES; passes++) {
    const pass = detectSideFlips(track, options);
    steadied += pass.steadied;
    let changed = 0;
    for (let i = 0; i < track.frames.length; i++) {
      if (!pass.flipped[i] || !track.frames[i].pose) continue;
      toggleFrame(track.frames[i]);
      changed++;
    }
    corrected += changed;
    events = events.concat(pass.events);
    track.setSmoothing(track.smoothing); // the next pass reads the rebuilt view
    if (!pass.events.length || !changed) break;
  }

  // Flag where the data now differs from the model's raw labels, which after
  // several passes is the parity flags rather than any single pass's segments.
  const finalFlipped = track.frames.map((f) => Boolean(f.sideFlipped));
  const segments = toSegments(finalFlipped, track.frames);
  track.meta.sideFlips = segments;
  track.meta.sideFlipEvents = events;
  track.meta.sideSteadied = steadied;
  track.meta.sidePasses = passes + 1;
  return { corrected, events, steadied, segments };
}

/**
 * Exchange left and right across the whole clip. The one judgement automation
 * cannot make — the model's own output is self-consistent either way — so it
 * is a single deliberate action instead of a guess.
 * @returns {number} frames changed
 */
export function flipWholeTrack(track) {
  const changed = flipRange(track, -Infinity, Infinity);
  track.meta.polarityFlipped = !track.meta.polarityFlipped;
  return changed;
}

/**
 * Exchange left and right over a time window. The manual counterpart to the
 * automatic pass: when one boundary is genuinely ambiguous — the joints are as
 * consistent one way as the other — no amount of thresholding settles it, but
 * a person watching the clip can see it in a moment. Scrub to where it goes
 * wrong and swap from there.
 * @returns {number} frames changed
 */
export function flipRange(track, fromT, toT) {
  let changed = 0;
  for (const frame of track.frames) {
    if (!frame.pose) continue;
    if (frame.t < fromT - 1e-9 || frame.t > toT + 1e-9) continue;
    toggleFrame(frame);
    changed++;
  }
  track.setSmoothing(track.smoothing);
  return changed;
}

/** Put back whatever the corrections changed. */
export function undoSideFlips(track) {
  let restored = 0;
  for (const frame of track.frames) {
    if (!frame.sideFlipped) continue;
    swapSides(frame);
    delete frame.sideFlipped;
    restored++;
  }
  track.meta.sideFlips = [];
  track.meta.sideFlipEvents = [];
  track.meta.polarityFlipped = false;
  track.setSmoothing(track.smoothing);
  return restored;
}

/**
 * How many physically impossible sign jumps remain. Zero means the clip no
 * longer exchanges sides partway through — the property the correction exists
 * to guarantee, and what the tests assert.
 */
export function countImpossibleJumps(track, options = {}) {
  return detectSideFlips(track, options).events.length;
}
