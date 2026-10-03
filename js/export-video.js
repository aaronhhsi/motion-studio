// Export what you are looking at as a video file: the crop region, over the
// trimmed range, optionally with the skeleton drawn on.
//
// Capture is done in real time rather than by stepping frames. MediaRecorder
// timestamps frames by wall clock, so a stepped export would play back at
// whatever rate the export loop happened to run at; playing the clip once at
// 1x keeps the exported timing identical to the source.

import { render } from './renderer.js';

const MAX_WIDTH = 1280;

const MIME_TYPES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
];

export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  return MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

export function extensionFor(mimeType) {
  return mimeType?.startsWith('video/mp4') ? 'mp4' : 'webm';
}

/**
 * @param {import('./clip.js').ClipView} clip
 * @param {object} args
 * @param {boolean} args.overlay draw the skeleton, or export clean footage
 * @param {() => object} args.getOptions shared draw options
 * @param {(fraction:number)=>void} [args.onProgress]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{blob: Blob, mimeType: string, width: number, height: number, seconds: number}>}
 */
export async function exportClipVideo(clip, { overlay, getOptions, onProgress, signal }) {
  if (clip.mediaKind !== 'video') throw new Error('only video clips can be exported');
  const mimeType = pickMimeType();
  if (!mimeType) throw new Error('this browser cannot record video');

  const [t0, t1] = clip.rangeTimes();
  if (!(t1 > t0)) throw new Error('the trimmed range is empty');

  const src = clip.viewSource();
  const { w: sw, h: sh } = clip.sourceSize();
  if (!sw || !sh) throw new Error('the clip has no dimensions yet');

  // Even dimensions keep every encoder happy.
  const cropW = src.w * sw;
  const cropH = src.h * sh;
  const scale = Math.min(1, MAX_WIDTH / cropW);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round((cropW * scale) / 2) * 2);
  canvas.height = Math.max(2, Math.round((cropH * scale) / 2) * 2);
  const ctx = canvas.getContext('2d');

  const video = clip.video;
  const wasPlaying = !video.paused;
  const resumeAt = video.currentTime;
  video.pause();
  video.playbackRate = 1;

  await seek(video, t0);

  const stream = canvas.captureStream(Math.max(1, Math.round(clip.track?.meta.sampleFps || 30)));
  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12_000_000 });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const finished = new Promise((resolve) => { recorder.onstop = resolve; });

  const opts = { ...getOptions(), source: src, selection: null, range: clip.range };
  const drawFrame = () => {
    if (!overlay) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      try {
        ctx.drawImage(video, src.x * sw, src.y * sh, cropW, cropH, 0, 0, canvas.width, canvas.height);
      } catch { /* not ready */ }
      return;
    }
    const index = clip.track ? clip.track.indexAt(video.currentTime) : -1;
    render(ctx, {
      media: video,
      track: clip.track?.length ? clip.track : null,
      frameIndex: index,
      opts: { ...opts, showNoPoseHint: false },
    });
  };

  drawFrame();
  recorder.start(200);

  let stop;
  const done = new Promise((resolve) => { stop = resolve; });
  let raf = 0;

  const tick = () => {
    if (signal?.aborted || video.currentTime >= t1 - 1e-3 || video.ended) {
      return stop();
    }
    drawFrame();
    onProgress?.(Math.min(1, (video.currentTime - t0) / (t1 - t0)));
    raf = requestAnimationFrame(tick);
  };

  await video.play();
  raf = requestAnimationFrame(tick);
  await done;
  cancelAnimationFrame(raf);

  drawFrame();               // make sure the last frame lands in the file
  video.pause();
  recorder.stop();
  await finished;
  stream.getTracks().forEach((t) => t.stop());

  await seek(video, resumeAt);
  if (wasPlaying) video.play().catch(() => {});

  if (signal?.aborted) throw new Error('export cancelled');

  return {
    blob: new Blob(chunks, { type: mimeType }),
    mimeType,
    width: canvas.width,
    height: canvas.height,
    seconds: t1 - t0,
  };
}

function seek(video, t) {
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
    const timer = setTimeout(done, 3000);
    video.addEventListener('seeked', done);
    video.currentTime = target;
  });
}
