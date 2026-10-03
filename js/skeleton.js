// Landmark topology for both models, and the point-id scheme that lets the rest
// of the app treat them as one set.
//
//   0..32     BlazePose body landmarks
//   100..120  left hand  (21 points, hand model only)
//   200..220  right hand
//
// Everything downstream — trails, focus locks, chips, exports — keys off these
// ids, so nothing else needs to know which model a point came from.

export const LANDMARK_NAMES = [
  'nose',
  'left_eye_inner', 'left_eye', 'left_eye_outer',
  'right_eye_inner', 'right_eye', 'right_eye_outer',
  'left_ear', 'right_ear',
  'mouth_left', 'mouth_right',
  'left_shoulder', 'right_shoulder',
  'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist',
  'left_pinky', 'right_pinky',
  'left_index', 'right_index',
  'left_thumb', 'right_thumb',
  'left_hip', 'right_hip',
  'left_knee', 'right_knee',
  'left_ankle', 'right_ankle',
  'left_heel', 'right_heel',
  'left_foot_index', 'right_foot_index',
];

export const L = Object.fromEntries(LANDMARK_NAMES.map((n, i) => [n.toUpperCase(), i]));

export const CONNECTIONS = [
  // face
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  // shoulders + arms
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  // hands
  [15, 17], [15, 19], [15, 21], [17, 19], [16, 18], [16, 20], [16, 22], [18, 20],
  // torso
  [11, 23], [12, 24], [23, 24],
  // legs
  [23, 25], [25, 27], [24, 26], [26, 28],
  // feet
  [27, 29], [27, 31], [29, 31], [28, 30], [28, 32], [30, 32],
];

/* ------------------------------------------------------------------ hands */

export const HAND_SIDES = ['Left', 'Right'];
export const HAND_BASE = { Left: 100, Right: 200 };

export const HAND_LANDMARK_NAMES = [
  'wrist',
  'thumb_cmc', 'thumb_mcp', 'thumb_ip', 'thumb_tip',
  'index_mcp', 'index_pip', 'index_dip', 'index_tip',
  'middle_mcp', 'middle_pip', 'middle_dip', 'middle_tip',
  'ring_mcp', 'ring_pip', 'ring_dip', 'ring_tip',
  'pinky_mcp', 'pinky_pip', 'pinky_dip', 'pinky_tip',
];

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export const FINGERTIPS = [4, 8, 12, 16, 20];

export const isHandPoint = (id) => id >= 100;
export const handSideOf = (id) => (id >= 200 ? 'Right' : id >= 100 ? 'Left' : null);
export const handIndexOf = (id) => id % 100;
export const handPointId = (side, index) => HAND_BASE[side] + index;

export function handIds(side) {
  return HAND_LANDMARK_NAMES.map((_, i) => handPointId(side, i));
}

export function allHandIds() {
  return [...handIds('Left'), ...handIds('Right')];
}

/* ----------------------------------------------------------- point access */

/** One landmark from a frame, whichever model it came from. */
export function pointAt(frame, id) {
  if (!frame) return null;
  if (!isHandPoint(id)) return frame.pose?.[id] ?? null;
  return frame.hands?.[handSideOf(id)]?.[handIndexOf(id)] ?? null;
}

/** Every point id present in a frame. */
export function idsInFrame(frame) {
  const ids = [];
  if (frame?.pose) for (let i = 0; i < frame.pose.length; i++) ids.push(i);
  for (const side of HAND_SIDES) {
    if (frame?.hands?.[side]) for (let i = 0; i < 21; i++) ids.push(handPointId(side, i));
  }
  return ids;
}

/* ---------------------------------------------------------------- grouping */

/** Groups a user can switch on/off. Indices may overlap between groups. */
export const GROUPS = {
  face: { label: 'Head & face', indices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
  arms: { label: 'Arms', indices: [11, 12, 13, 14, 15, 16] },
  hands: { label: 'Hands', indices: [17, 18, 19, 20, 21, 22, ...allHandIds()] },
  torso: { label: 'Torso', indices: [11, 12, 23, 24] },
  legs: { label: 'Legs', indices: [23, 24, 25, 26, 27, 28] },
  feet: { label: 'Feet', indices: [29, 30, 31, 32] },
};

export const DEFAULT_GROUPS = ['arms', 'hands', 'torso', 'legs', 'feet'];

/** Joints worth offering as trail targets, in a sensible reading order. */
export const TRAIL_CANDIDATES = [
  L.LEFT_WRIST, L.RIGHT_WRIST,
  L.LEFT_ELBOW, L.RIGHT_ELBOW,
  L.LEFT_SHOULDER, L.RIGHT_SHOULDER,
  L.LEFT_INDEX, L.RIGHT_INDEX,
  L.LEFT_HIP, L.RIGHT_HIP,
  L.LEFT_KNEE, L.RIGHT_KNEE,
  L.LEFT_ANKLE, L.RIGHT_ANKLE,
  L.LEFT_FOOT_INDEX, L.RIGHT_FOOT_INDEX,
  L.NOSE,
];

/** Fingertip chips, offered once the hand model is on. */
export function fingertipCandidates() {
  return HAND_SIDES.flatMap((side) => FINGERTIPS.map((i) => handPointId(side, i)));
}

/** Nothing is trailed until asked for: click a point, a chip, or lock a scan. */
export const DEFAULT_TRAILS = [];

/**
 * What a focus scan is allowed to lock onto. `hands` says whether the hand
 * model is running — without it, "fingers" can only mean BlazePose's four
 * coarse hand points.
 */
export const FOCUS_TARGETS = [
  { id: 'body', label: 'Whole body' },
  { id: 'upper', label: 'Upper body' },
  { id: 'arms', label: 'Arms & hands' },
  { id: 'hands', label: 'Both hands' },
  { id: 'left_hand', label: 'Left hand' },
  { id: 'right_hand', label: 'Right hand' },
  { id: 'fingertips', label: 'Fingertips only' },
  { id: 'legs', label: 'Legs & feet' },
  { id: 'custom', label: 'Currently trailed points' },
];

const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);

/**
 * Drop body points the active model cannot produce.
 *
 * A COCO model fills 17 of the 33 BlazePose slots, so offering a lock, a trail
 * or a group built on one of the other 16 would be offering to track something
 * that is never there — and a focus lock built that way collapses to whichever
 * one or two points happen to survive, which looks like the tracking has
 * broken. `provided` of null means every slot, which is BlazePose.
 *
 * Hand-model ids are never filtered here: they come from a second model that
 * runs regardless of which body model is selected, and the `hands` flag
 * already governs them.
 *
 * @param {Iterable<number>} ids
 * @param {Set<number>|null} provided
 */
export function keepProvided(ids, provided) {
  const list = [...ids];
  if (!provided) return list;
  return list.filter((id) => isHandPoint(id) || provided.has(id));
}

export function focusCandidates(targetId, { hands = false, custom = [], provided = null } = {}) {
  return keepProvided(focusCandidatesRaw(targetId, { hands, custom }), provided);
}

function focusCandidatesRaw(targetId, { hands = false, custom = [] } = {}) {
  const poseHand = { Left: [15, 17, 19, 21], Right: [16, 18, 20, 22] };
  switch (targetId) {
    case 'body':
      return range(0, 33);
    case 'upper':
      return range(0, 25);
    case 'arms':
      return [...range(11, 23), ...(hands ? allHandIds() : [])];
    case 'hands':
      return [...poseHand.Left, ...poseHand.Right, ...(hands ? allHandIds() : [])];
    case 'left_hand':
      return [...poseHand.Left, ...(hands ? handIds('Left') : [])];
    case 'right_hand':
      return [...poseHand.Right, ...(hands ? handIds('Right') : [])];
    case 'fingertips':
      return hands
        ? fingertipCandidates()
        : [L.LEFT_INDEX, L.RIGHT_INDEX, L.LEFT_THUMB, L.RIGHT_THUMB, L.LEFT_PINKY, L.RIGHT_PINKY];
    case 'legs':
      return range(23, 33);
    case 'custom':
      return [...custom];
    default:
      return range(0, 33);
  }
}

/** Distal, fast-moving joints — the ones worth trailing when a lock is large. */
const DISTAL = new Set([L.LEFT_WRIST, L.RIGHT_WRIST, L.LEFT_INDEX, L.RIGHT_INDEX,
  L.LEFT_ANKLE, L.RIGHT_ANKLE, L.LEFT_FOOT_INDEX, L.RIGHT_FOOT_INDEX, L.NOSE]);

/**
 * Trailing 42 hand points at once is soup. Above `max`, fall back to the tips
 * and extremities, which is what the eye actually follows.
 */
export function trailPickFrom(ids, max = 12) {
  const list = [...ids];
  if (list.length <= max) return new Set(list);
  const priority = list.filter((id) =>
    isHandPoint(id) ? FINGERTIPS.includes(handIndexOf(id)) : DISTAL.has(id));
  return new Set((priority.length ? priority : list).slice(0, max));
}

/* ----------------------------------------------------------------- labels */

export const SIDE_COLORS = {
  left: '#38bdf8',
  right: '#fb7185',
  center: '#c4b5fd',
};

export function sideOf(id) {
  if (isHandPoint(id)) return handSideOf(id).toLowerCase();
  const name = LANDMARK_NAMES[id] || '';
  if (name.startsWith('left_')) return 'left';
  if (name.startsWith('right_')) return 'right';
  return 'center';
}

export function colorOf(id) {
  return SIDE_COLORS[sideOf(id)];
}

/** Human-readable label, e.g. 15 -> "L wrist", 208 -> "R index tip". */
export function shortLabel(id) {
  if (isHandPoint(id)) {
    const prefix = handSideOf(id) === 'Left' ? 'L' : 'R';
    return `${prefix} ${HAND_LANDMARK_NAMES[handIndexOf(id)].replace(/_/g, ' ')}`;
  }
  const name = LANDMARK_NAMES[id] || `#${id}`;
  return name
    .replace(/^left_/, 'L ')
    .replace(/^right_/, 'R ')
    .replace(/_/g, ' ');
}

/* ------------------------------------------------------------------ angles */

/**
 * Joint angles, each defined by three landmarks: the angle is measured at `b`,
 * between the segments b->a and b->c.
 */
export const ANGLES = [
  { id: 'right_elbow', label: 'Right elbow', a: L.RIGHT_SHOULDER, b: L.RIGHT_ELBOW, c: L.RIGHT_WRIST },
  { id: 'left_elbow', label: 'Left elbow', a: L.LEFT_SHOULDER, b: L.LEFT_ELBOW, c: L.LEFT_WRIST },
  { id: 'right_shoulder', label: 'Right shoulder', a: L.RIGHT_ELBOW, b: L.RIGHT_SHOULDER, c: L.RIGHT_HIP },
  { id: 'left_shoulder', label: 'Left shoulder', a: L.LEFT_ELBOW, b: L.LEFT_SHOULDER, c: L.LEFT_HIP },
  { id: 'right_hip', label: 'Right hip', a: L.RIGHT_SHOULDER, b: L.RIGHT_HIP, c: L.RIGHT_KNEE },
  { id: 'left_hip', label: 'Left hip', a: L.LEFT_SHOULDER, b: L.LEFT_HIP, c: L.LEFT_KNEE },
  { id: 'right_knee', label: 'Right knee', a: L.RIGHT_HIP, b: L.RIGHT_KNEE, c: L.RIGHT_ANKLE },
  { id: 'left_knee', label: 'Left knee', a: L.LEFT_HIP, b: L.LEFT_KNEE, c: L.LEFT_ANKLE },
  { id: 'right_ankle', label: 'Right ankle', a: L.RIGHT_KNEE, b: L.RIGHT_ANKLE, c: L.RIGHT_FOOT_INDEX },
  { id: 'left_ankle', label: 'Left ankle', a: L.LEFT_KNEE, b: L.LEFT_ANKLE, c: L.LEFT_FOOT_INDEX },
];

/** No angles until a chip is picked, so a fresh clip shows just the skeleton. */
export const DEFAULT_ANGLES = [];

/** Angle at `b` in degrees, for 2D or 3D points. Returns null if any point is missing. */
export function angleBetween(a, b, c) {
  if (!a || !b || !c) return null;
  const v1 = { x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) };
  const v2 = { x: c.x - b.x, y: c.y - b.y, z: (c.z ?? 0) - (b.z ?? 0) };
  const n1 = Math.hypot(v1.x, v1.y, v1.z);
  const n2 = Math.hypot(v2.x, v2.y, v2.z);
  if (n1 < 1e-9 || n2 < 1e-9) return null;
  const dot = (v1.x * v2.x + v1.y * v2.y + v1.z * v2.z) / (n1 * n2);
  return (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
}
