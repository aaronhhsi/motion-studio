// Where the MediaPipe runtime and pose models are loaded from.
//
// By default everything streams from jsDelivr / Google's model host. Run
// `npm run vendor` to download the runtime + models into ./vendor and then
// flip USE_VENDORED to true for a fully offline app.

export const USE_VENDORED = false;

const MP_VERSION = '1.0.1';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_HOST = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker';
const HAND_HOST = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker';

export const VISION_BUNDLE_URL = USE_VENDORED
  ? '../vendor/vision_bundle.mjs'
  : `${CDN}/vision_bundle.mjs`;

export const WASM_BASE_URL = USE_VENDORED ? 'vendor/wasm' : `${CDN}/wasm`;

/**
 * ONNX Runtime Web, for the YOLO backend. The `webgpu` bundle also carries the
 * wasm fallback (both live in the one `.jsep.wasm` file), so this is a single
 * choice rather than two.
 */
const ORT_VERSION = '1.20.1';
const ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist`;
const yoloHost = (size) => `https://huggingface.co/Xenova/yolov8${size}-pose/resolve/main/onnx`;

// The `.mjs` build, because this is loaded with a dynamic `import()` — the
// plain `.js` files are UMD bundles and come back with no usable export. The
// `bundle` variant additionally inlines the runtime's own JS glue, so the only
// thing still fetched from `ORT_WASM_DIR` is the `.wasm` binary itself.
export const ORT_BUNDLE_URL = USE_VENDORED
  ? '../vendor/ort.webgpu.bundle.min.mjs'
  : `${ORT_CDN}/ort.webgpu.bundle.min.mjs`;

/** Directory the runtime resolves its own `.wasm` out of; the trailing slash matters. */
export const ORT_WASM_DIR = USE_VENDORED ? 'vendor/ort/' : `${ORT_CDN}/`;

export const MODELS = {
  lite: {
    label: 'Lite — fastest',
    url: USE_VENDORED
      ? 'vendor/pose_landmarker_lite.task'
      : `${MODEL_HOST}/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
  },
  full: {
    label: 'Full — balanced',
    url: USE_VENDORED
      ? 'vendor/pose_landmarker_full.task'
      : `${MODEL_HOST}/pose_landmarker_full/float16/1/pose_landmarker_full.task`,
  },
  heavy: {
    label: 'Heavy — most accurate',
    url: USE_VENDORED
      ? 'vendor/pose_landmarker_heavy.task'
      : `${MODEL_HOST}/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task`,
  },
  /**
   * A different architecture, not just a bigger one — see the header of
   * js/yolo.js. Worth reaching for whenever the torso misbehaves: on the
   * reference serve these hold the shoulders steady through the wind-up where
   * every BlazePose size collapses them, and they are steadier at every other
   * joint too. 17 COCO keypoints instead of 33, so no heel/foot-index, no
   * coarse hand points and no 3D world landmarks.
   *
   * Residual from the midpoint of a joint's own neighbours in time, 95th
   * percentile — how far a joint lands from where the frames either side of it
   * say it should be, so lower is a joint being placed more consistently:
   *
   *                    shoulder   elbow    wrist    knee
   *   BlazePose full    0.0126    0.0244   0.0257   0.0179
   *   YOLOv8s           0.0080    0.0174   0.0249   0.0157
   *   YOLOv8m           0.0050    0.0089   0.0149   0.0112
   */
  yolo: {
    label: 'YOLOv8s — steady torso, fast',
    backend: 'yolo',
    inputSize: 640,
    url: USE_VENDORED ? 'vendor/yolov8s-pose.onnx' : `${yoloHost('s')}/model.onnx`,
  },
  yolom: {
    label: 'YOLOv8m — steadiest joints',
    backend: 'yolo',
    inputSize: 640,
    url: USE_VENDORED ? 'vendor/yolov8m-pose.onnx' : `${yoloHost('m')}/model.onnx`,
  },
};

/**
 * BlazePose only gives four coarse points per hand (wrist, thumb, index,
 * pinky). Real finger tracking needs this second model — 21 points per hand.
 */
export const HAND_MODEL = {
  url: USE_VENDORED
    ? 'vendor/hand_landmarker.task'
    : `${HAND_HOST}/hand_landmarker/float16/1/hand_landmarker.task`,
  numHands: 2,
};

export const DEFAULTS = {
  model: 'full',
  numPoses: 1,
  sampleFps: 30,
  minPoseDetectionConfidence: 0.5,
  minPosePresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
  /** Landmarks below this visibility are not drawn. */
  visibilityThreshold: 0.4,
};

/** Focus scan: how long to count down, and how long to sample for. */
export const SCAN = {
  countdownSeconds: 3,
  scanSeconds: 1.5,
  /** A point must appear in this share of scan frames to be locked on. */
  minPresence: 0.6,
  /** …and average at least this visibility while it was there. */
  minVisibility: 0.5,
};
