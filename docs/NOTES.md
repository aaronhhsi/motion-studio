# Motion Studio — technical notes

The design decisions, measurements and dead ends behind the app. The
[README](../README.md) covers what it does and how to run it.

## What it does

**Video in, track out.** The app steps the file frame by frame and builds a
complete track; that is slower than sampling during playback but loses nothing.
A fresh clip shows just the skeleton — trails and joint angles stay off until
you pick them.

**Two body models, and they fail differently.** *Model* picks between
MediaPipe's BlazePose (lite / full / heavy) and YOLO (**v8s** / **v8m**). Within
either family the size is a minor axis; between them the architecture is the
whole story.

BlazePose *regresses* landmark coordinates, and a regression model under
uncertainty collapses toward the mean of its training distribution. For a torso
that mean is a narrow one, so when BlazePose is unsure it slides both shoulders
and both hips onto the body's midline and draws the torso as a spine — while
still placing every distal joint correctly, which is what makes it read as a bug
rather than a bad guess. YOLO localises each keypoint spatially, so it has no
mean pose to fall back on.

On the reference serve, through the wind-up where the player is airborne with
both arms overhead. Ground truth is his width read straight off the jersey
pixels — 0.1035 at the shoulder band, so about 0.08 at the joint centres:

| | frames tracked | shoulder separation, wind-up | frames collapsed below 0.01 | L/R exchanges |
| --- | --- | --- | --- | --- |
| BlazePose full | 508/514 | 0.009 – 0.072, oscillating | 21 | 13 |
| BlazePose heavy | 514/514 | collapses on 6 frames of 348 | — | 4 |
| YOLOv8s | 514/514 | 0.072 – 0.083, steady | 0 | 2 |
| **YOLOv8m** | **514/514** | **0.078 – 0.085, steady** | **0** | **0** |

It is not only the torso. Measuring how far each joint lands from the midpoint
of where the frames either side of it put it — real motion is smooth, so this
residual isolates a joint being dropped somewhere wrong — at the 95th
percentile:

| | shoulder | elbow | wrist | knee |
| --- | --- | --- | --- | --- |
| BlazePose full | 0.0126 | 0.0244 | 0.0257 | 0.0179 |
| YOLOv8s | 0.0080 | 0.0174 | 0.0249 | 0.0157 |
| **YOLOv8m** | **0.0050** | **0.0089** | **0.0149** | **0.0112** |

Take care comparing joints *within* a model this way rather than across:
dividing the elbow by the shoulder to normalise out the subject's speed makes
YOLO look worse, because the shoulder it is dividing by is the thing YOLO most
improves. The same trap sits in bone lengths — a model that correctly follows a
foreshortening arm lowers that bone's median length and so scores worse on
"how far does it stretch past its median".

The cost is that COCO has 17 keypoints where BlazePose has 33. Every COCO point
maps exactly onto a BlazePose index, so trails, locks, the angle chart, the CSV
and the track format are unchanged — the 16 ids COCO does not cover simply
arrive with zero visibility and are skipped wherever a visibility threshold
already applies. What you give up is the eye/mouth detail, the four coarse hand
points, the heel and foot-index points (so **ankle angles read nothing**), and
the 3D world landmarks (so *Measured in → 3D world* falls back to the image
plane). Finger tracking is unaffected — the hand model is MediaPipe either way.

Because a COCO model fills only 17 of the 33 slots, the controls re-point
themselves when you change model: groups with no points behind them grey out,
dead trail chips disappear, the ankle angle chips go away, and focus targets
that could only resolve to a single point — *left hand*, *right hand*,
*fingertips only*, which under COCO are one wrist or nothing — are disabled. An
existing lock is pruned to what the new model can see, and dropped entirely if
nothing survives, with the reason in the status line. Without that, scanning
with the default *right hand* target locked the wrist alone and `focus only`
hid the rest of the body: one dot travelling across an empty stage, which looks
exactly like tracking that has failed. Ticking **track fingers** brings the hand
targets back, because the hand model supplies them whichever body model is
selected.

It is also slower and a bigger download: inference runs on WebGPU where
available and falls back to single-threaded wasm. A full pass over the reference
clip takes about 60s on BlazePose, 105s on v8s and 190s on v8m, and picking one
fetches ~65 MB (v8s) or ~120 MB (v8m) the first time. **BlazePose is still the
default**, so a session that never opens the Model dropdown downloads none of
it and behaves exactly as before — which also means switching model is
something you have to do deliberately, per session.

**Two clips side by side.** *Compare with…* opens a second clip next to the
first. Each has its own timeline, trim, transport and crop; **Play both** runs
them together, and **Match position** moves B to A's position measured from each
clip's own trim start, so two takes of different lengths line up on the action
rather than on the file. Click a clip to make it active — the sidebar, the angle
chart and the exports all follow the active one.

**Trimming.** Drag the in/out handles on the timeline, or hit `I` / `O`. The
strip behind the timeline is per-frame motion energy — the tall part is where
something actually happened. Playback loops the trim, down to 0.1× speed. That
is the time-wise crop: everything downstream — exports, the angle chart, motion
trails — respects it.

**Cropping and rescanning.** *Select area* draws a box on the active clip (drag
the handles or the box itself). Then:

- **Crop to box** narrows the view to it. The landmarks travel with the crop and
  the canvas takes the crop's aspect ratio, so nothing skews. This changes only
  what you see.
- **Rescan inside box** re-runs detection with *only that box* as the model's
  input, over **only the trimmed range** in time, and replaces just those frames
  — the rest of the clip, and your trim markers, survive. Landmarks come back
  mapped to full-frame coordinates, so a rescanned section stays comparable with
  the rest of the track. *Model for rescan* defaults to heavy: a rescan covers a
  short slice, so the slow accurate model is affordable here even when it is not
  for a whole pass.

Crop and rescan are deliberately separate — one is a viewing choice, the other
re-derives the data.

### When cropping before detection actually helps

Measured on a composite with the subject at 282×188 px in a 1280×720 frame,
dimmed to 40%, with a brighter distractor centre-frame. Error is mean landmark
distance in subject-widths against a full-size ground truth:

| Model | Full frame | Cropped to subject |
| --- | --- | --- |
| lite | **not detected at all** | 0.0048 arm error |
| full | **not detected at all** | 0.0042 arm error |
| heavy | **not detected at all** | 0.0023 arm error |

So cropping is the difference between *nothing* and *a good track* when the
subject is small or dim. But if the subject is already being detected, expect
little or no change: MediaPipe's pose pipeline already finds a person, crops to
them, and runs the landmark model on that crop. Cropping again mostly repeats
work it has done. Where it still earns its keep on a detected subject is
**choosing which person** — the app tracks one pose, and a box decides who.

For finer elbows and wrists on a subject that already tracks, the model is the
lever, not the crop: heavy roughly halved the arm error above.

*Exposure for rescan* does change the pixels fed to the model (verified: a
mid-grey 60 becomes 80 at 1.5× and 116 at 2.0×), but made no measurable
difference to accuracy in that test — the model is robust to brightness over
this range. Reach for it only when a subject is dark enough that detection fails
outright.

**Focus scan.** Rather than tracking all 33 points forever, pick what you care
about — *right hand*, *fingertips*, *legs & feet* — and hit `◎ Scan & lock`
(or `S`). It samples the clip forward from the playhead, then locks onto
whichever of those points it could actually see, and tracks only those. Everything else
fades to context or disappears.

The lock is deliberately conservative: a point has to appear in 60% of the scan
frames *and* average 50% visibility to make it in. A point the model never saw
is not something you can track, so locking onto it would only draw a lie — if
nothing qualifies, the scan says so instead of pretending. Thresholds live in
`SCAN` in [js/config.js](../js/config.js).

**Left/right swaps.** BlazePose labels landmarks *anatomically* — index 11 is
the player's left shoulder, not the left of the picture. When a subject rotates,
turns away, or moves fast, the model can swap that assignment for a stretch of
frames and then swap back. A volleyball serve does all three, and the damage is
invisible: "right elbow" silently describes the left arm for part of the clip,
so angles and trails for that stretch are wrong.

**keep left/right consistent** (on by default) repairs it, using a geometric
fact: you cannot get from "right shoulder is left of left shoulder" to the
reverse without passing through profile, where the two coincide. A real
rotation carries the signed shoulder separation smoothly through zero over
several frames. A relabelling jumps straight across it in one frame. So the
pass looks for sign changes that *skipped the middle* and are therefore
physically impossible.

But shoulder geometry alone cannot see a swap that happens *near* profile —
and that is where the model does it most. So at every candidate boundary the
decisive question is asked of the joints instead: **did the body move, or did
only the names change?** A body that really turned brings its limbs with it, so
keeping the labels continues the motion best. A relabelling leaves every joint
exactly where it was, so pairing each with its mirror continues it far better.
Measured on real serves, relabellings score 0.12–0.42 on that ratio while a
real continuation scores above 2 — the two cases are nowhere near each other.

The comparison is made against the previous frame *as already corrected*, and
it yields this frame's absolute orientation rather than a toggle. That matters:
when the model alternates its labels every frame, the correction must alternate
with it, and a toggle-based version chases its own tail instead of settling.
Frames whose shoulder span exceeds a torso length are discarded as collapsed
poses, ambiguous stretches are decided by their ends rather than per-frame noise
(on a median-filtered copy, so one spike cannot start a cascade), and the whole
pass repeats until it finds nothing — repairing an early exchange can reveal a
later one it was masking.

Measured on the reference serve in two encodings — the original portrait MP4
(76% tracked) and a cropped WebM export of the same action (99% tracked):

| | side changes before → after | flicker before → after |
| --- | --- | --- |
| `darlansouzaserve.mp4` | 18 → **1** | 11 → **0** |
| `darlansouzaserve-crop.webm` | 19 → **0** | 12 → **0** |

Both end flicker-free with no impossible jumps left. The MP4's single remaining
boundary is genuinely ambiguous — the limb comparison scores it 0.99, meaning
both readings explain the motion equally well — and no threshold settles that
honestly. For those, **…from here on** swaps left and right from the playhead
to the end: scrub to where it goes wrong, click once. `npm run test:clip`
asserts all of the above against both files.

Nothing happens silently: corrected runs are flagged in amber on the timeline,
the panel names the times, and the status line counts the exchanges. Unticking
the box restores the model's own labels exactly — the correction is stored as
per-frame parity, so it round-trips without re-analysing.

**Fingers.** Body tracking gives four coarse points per hand. Tick **track
fingers** for a second model with 21 points per hand — then "fingertips" means
real fingertips. It roughly halves the frame rate, so it is off by default.

**Seeing the movement.**

| Control | What it gives you |
| --- | --- |
| Footage opacity | Drag to 0 for points-only on black — pure motion, no distractions |
| Motion trails | The path a joint took. Sample dots are evenly spaced in *time*, so wide gaps = fast |
| Trail length | Last 0.25 s … or the whole trimmed range |
| Onion skin | Faded skeletons from earlier frames — a stroboscopic photo of the whole action |
| Joint angles | Degrees on the stage plus a plot across the trim — pick joints from the chips |

Click any point on the stage to start trailing it. A lock that covers more than
12 points trails only the fingertips and extremities — 42 hand trails at once is
soup, and the tips are what the eye follows anyway.

**Export** (trimmed range only): full track JSON, a wide landmarks CSV
(one row per frame, `x/y/z/visibility` per joint), an angles CSV, a PNG of the
current frame, and **the clip itself as video** — the crop region over the
trimmed range, with or without the skeleton drawn on. The video is captured by
playing the clip through once at 1x rather than by stepping frames, because
MediaRecorder timestamps by wall clock: a stepped export would play back at
whatever rate the export loop happened to run at. So it takes as long as the
trimmed clip, and the result keeps the source timing.

## What touches the network, and what does not

**No video frame ever leaves your machine.** Detection runs
on-device: MediaPipe ships as WebAssembly plus a weights file, and the browser
runs the model itself. There is no inference service and no API call — nothing
is streamed anywhere for analysis.

The internet is needed exactly once, on first load, to download the runtime and
the weights:

| What | From | Size |
| --- | --- | --- |
| `vision_bundle.mjs` | cdn.jsdelivr.net | 155 KB |
| `vision_wasm_internal.js` + `.wasm` | cdn.jsdelivr.net | ~12.1 MB |
| `pose_landmarker_full.task` | storage.googleapis.com | 9.4 MB |
| `hand_landmarker.task` | storage.googleapis.com | 7.8 MB, only with finger tracking |
| `ort.webgpu.bundle.min.mjs` | cdn.jsdelivr.net | 369 KB, only with the YOLO model |
| `ort-wasm-simd-threaded.jsep.wasm` | cdn.jsdelivr.net | 21 MB, only with the YOLO model |
| `yolov8s-pose` weights | huggingface.co | 44.6 MB, only with YOLOv8s |
| `yolov8m-pose` weights | huggingface.co | 101 MB, only with YOLOv8m |

The ONNX runtime and the YOLO weights are fetched the first time you pick a YOLO
model and not before, so nothing changes for a session that stays on BlazePose.
`huggingface.co` is static file hosting here, the same role the others play.

`storage.googleapis.com` is static file hosting here, not an API — the same role
a CDN plays. Every URL lives in [js/config.js](../js/config.js); there is nothing
else, no fonts, no analytics.

The browser caches all four, so after one successful load the app usually keeps
working with the network off. `npm run vendor` downloads them into `./vendor` so
it always does — then set `USE_VENDORED = true` in config.js.

This is enforced, not just asserted: `npm run test:network` records every
request the page makes, analyses a clip frame by frame (100+ detections), then
waits out a further 70 seconds and fails if anything produced a single request.
Current result: 22 requests at startup, all GET, zero bytes of request body, and
**zero** requests thereafter.

The wait is there because of what the test caught. MediaPipe Tasks 1.0 added a
usage logger to every task: it counts which task ran and how fast, and POSTs
that to `odml.pa.googleapis.com/v1/log` every 60 seconds. No image data — but a
request nobody asked for, and the library has no switch to turn it off. The
first version of this test never saw it on a fast GPU, because the analysis
finished inside the minute; on CI's CPU-only runner it did not, and the test
failed. [js/no-telemetry.js](../js/no-telemetry.js) now refuses that endpoint
before it reaches the network, and the logger, treating the failure as fatal,
stops itself.

## Notes on the numbers

- Landmark `x`/`y` are normalised to the frame (0–1), so they survive resizing.
  `z` is depth relative to the hips, in the same scale as `x`.
- Body and hand points share one id space — `0..32` body, `100..120` left hand,
  `200..220` right hand — so trails, locks, chips and exports never need to know
  which model a point came from. See [js/skeleton.js](../js/skeleton.js).
- The landmarks CSV widens from 33 to 75 points when finger tracking is on.
  Hand columns are prefixed `lefthand_` / `righthand_`.
- Joint angles are measured **in the image plane by default** — the angle
  between the two bones exactly as drawn, so the number always agrees with the
  arc beside it. Switch *Measured in* to **3D world** for MediaPipe's metric
  estimate, which is the physically correct joint angle when a limb points
  toward or away from the camera, but inherits the model's shaky depth and will
  not match the picture. On the reference photo a visually straight arm reads
  178.7° on screen and 150.0° in world space — the 3D depth estimate is simply
  wrong there, which is why the image plane is the default.
- Image-plane angles are computed in **pixel** proportions, not normalised ones.
  Normalised x is divided by width and y by height, so on a 16:9 frame a
  visually-135° elbow measures 150.6° if you skip that correction.
- **Everything you see is driven by the frame the video actually presented**, via
  `requestVideoFrameCallback`'s `mediaTime` — never by the frame we asked for.
  Updating the drawn index at request time paints new landmarks over the old
  picture, because a seek finishes long after the call returns. `currentTime` is
  no good either: right after a seek it sits a whole frame away from what is on
  screen. That combination was a visible skeleton-ahead-of-video lag when
  stepping frame by frame.
- Analysis records where the video *landed* after each seek, not where it was
  aimed, and skips repeats. Sampling a 24fps clip at 30fps otherwise stores
  several entries per real frame, and "step one frame" then moves the overlay
  without moving the picture. Stepping also keeps going until the image really
  changes, so a step is always a visible step.
- The landmarker is built once in MediaPipe's `VIDEO` running mode and never
  switched. `setOptions({runningMode})` tears down the WebGL context and builds
  a new one, which fails outright on some machines (`GLctx is undefined`) and
  creeps towards the browser's ~16-context cap on the rest.
- If the GPU delegate dies mid-inference the app rebuilds on CPU and retries.
  Creation succeeding is no guarantee the first real call will work.
- Smoothing is a zero-phase filter (forward + backward exponential pass), so it
  removes jitter without dragging the skeleton behind the video. The raw frames
  are kept untouched and are what gets exported.
- **The torso collapses are a rejection problem, not a filtering one.** On this
  footage the pose model does not jitter around the right torso — it returns one
  of two different fits. The shoulder separation is bimodal, with a clear gap at
  0.06-0.07: a correct mode around 0.08 and a degenerate one around 0.03 where
  both shoulder points sit on the sternum and both hip points at the pelvis
  centre, while every distal joint stays right. Measuring the jersey straight
  off the pixels puts his real shoulder band at 0.1035 and his waist at 0.0913,
  so the wide mode is the true one.

  Nothing downstream fixes this, and several things were tried. A median stage
  in the smoother made it *worse*: where a run of degenerate frames is locally
  in the majority a median votes for it, so at 5.9s — where the model had the
  shoulders right at 0.0717 — the filter rewrote them to 0.0230. Averaging only
  helps when the error is scattered around the truth, and this error is not.
  Cropping tightly to the player and rescanning with heavy halves the
  instability (wind-up wobble 0.029 to 0.011) but leaves the median width at
  0.069. Rejecting the bad frames needs a per-frame test and bone length does
  not give one: the upper arm reads 40% longer in the degenerate mode on
  average, but the spread inside each mode swamps that, and a 1.2x threshold
  misses the worst frames outright.

  The fault is in the architecture, so the fix is the architecture — which is
  why **YOLOv8s** is in the model list. See *Two body models* above.
- Trails break where tracking was lost rather than drawing a straight line
  through an occlusion.

## Keyboard

`space` play/pause · `←`/`→` step a frame (`shift` for 10) · `I`/`O` set trim in/out · `R` reset trim · `S` scan · `esc` cancel scan or selection

Keys act on the **active** clip — the one you last clicked.

## Layout

```
index.html          markup + control ids
css/styles.css
js/
  config.js         model URLs, thresholds, vendored-asset switch
  skeleton.js       landmark topology (body + hands), point ids, focus targets
  clip.js           one clip: media, canvas, timeline, transport, crop, stepping
  region.js         feeding a sub-rectangle to the model, and mapping back
  sides.js          detecting and repairing left/right label swaps
  export-video.js   writing the crop + trim back out as a video file
  landmarker.js     model wrapper: picks a backend, GPU→CPU fallback, timestamps
  no-telemetry.js   refuses MediaPipe's built-in usage logging
  yolo.js           the YOLO backend — ONNX Runtime, letterboxing, COCO→BlazePose
  analyze.js        seek-stepping video pass
  track.js          the recorded motion + derived series (smoothing, speed, angles)
  renderer.js       all stage drawing
  timeline.js       scrub bar, trim handles, motion strip
  chart.js          angle-over-time plot
  main.js           wiring
scripts/
  serve.mjs         zero-dependency static server
  vendor.mjs        download runtime + models for offline use
tests/
  logic.test.mjs        angle math, smoothing, export shapes (Node)
  dom-contract.test.mjs selectors in js/ vs ids in index.html
  smoke.mjs             drives real headless Chrome over CDP, end to end
  firefox.mjs           same pipeline in Firefox; the page reports back
  network.mjs           privacy audit: inference must generate zero traffic
  real-clip.mjs         the real serve: left/right exchanges, measured
```

## Tests

```bash
npm test             # fast, no browser
npm run test:smoke   # headless Chrome, the whole video path end to end
npm run test:firefox # headless Firefox — where the WebGL differences bite
npm run test:network # proves no footage leaves the machine
npm run test:clip    # the real serve clip, if it is present
npm run test:all     # everything
```

The smoke test needs Chrome or Edge installed (it finds them itself) and network
access. It builds its test clips in the page by panning reference photos (a
person, a pair of hands) across a canvas and recording them — real videos with
real landmarks, without shipping footage in the repo. That is what proves the
pipeline finds people and fingers rather than merely running.
`node tests/smoke.mjs --headed` to watch it.

## Next up

The volleyball layer sits on top of this, not inside it:

- Named phases (approach / plant / swing / contact) as markers on the timeline.
- Skill templates — for a spike, the angles worth watching are elbow at contact,
  shoulder abduction, knee flexion at plant.
- Two clips side by side, or one overlaid on a reference, time-aligned on a
  chosen event.
- Derived metrics: approach speed, jump height from hip displacement, arm-swing
  angular velocity, contact point height relative to standing reach.
- Pulling clips from `volleyball-clips-db` instead of the file picker.

The track format (`motion-studio/track@1`) is the seam: anything above consumes
exported tracks, so none of it needs to touch the tracking code.
