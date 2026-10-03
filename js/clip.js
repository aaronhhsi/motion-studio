// One clip on the stage: its media, its canvas, its own timeline and transport,
// its crop and its selection rectangle. Two of these side by side is the
// comparison view.
//
// The rule that keeps the overlay honest: **everything the user sees is driven
// by the frame the video actually presented**, never by the frame we asked for.
// Updating the drawn index at request time paints new landmarks over the old
// picture, because a seek completes long after the call returns.

import { render, selectionHandles } from './renderer.js';
import { Timeline } from './timeline.js';
import { clampRect } from './region.js';

const MAX_CANVAS_WIDTH = 1280;
const HANDLE_GRAB_PX = 11;

const TEMPLATE = `
  <div class="clip-head">
    <span class="clip-tag"></span>
    <span class="clip-name">no clip</span>
    <span class="clip-spacer"></span>
    <span class="clip-meta"></span>
    <button class="btn sm ghost clip-close" hidden title="Close this clip">✕</button>
  </div>

  <div class="clip-stage">
    <canvas class="clip-view" width="16" height="9"></canvas>
    <div class="clip-drop">
      <strong>Drop a video</strong>
      <span>or pick one from the panel</span>
    </div>
    <div class="stage-badge clip-badge" hidden></div>
    <div class="clip-progress" hidden>
      <div class="progress-text"></div>
      <div class="progress-bar"><div class="progress-fill"></div></div>
      <button class="btn sm ghost clip-cancel">Cancel</button>
    </div>
  </div>

  <div class="transport clip-transport">
    <button class="btn icon clip-play" title="Play / pause" disabled>▶</button>
    <button class="btn icon clip-back" title="Previous frame" disabled>‹</button>
    <button class="btn icon clip-fwd" title="Next frame" disabled>›</button>
    <select class="clip-rate" title="Playback speed" disabled>
      <option value="0.1">0.1×</option>
      <option value="0.25">0.25×</option>
      <option value="0.5">0.5×</option>
      <option value="1" selected>1×</option>
      <option value="2">2×</option>
    </select>
    <label class="chk"><input type="checkbox" class="clip-loop" checked> loop</label>
    <span class="clip-spacer"></span>
    <span class="time clip-time">–</span>
  </div>

  <div class="timeline is-empty clip-timeline">
    <canvas class="tl-strip"></canvas>
    <div class="tl-range"></div>
    <div class="tl-handle tl-in" title="Trim start"></div>
    <div class="tl-handle tl-out" title="Trim end"></div>
    <div class="tl-playhead"></div>
  </div>

  <div class="trimbar clip-trimbar">
    <button class="btn sm clip-in" disabled>Set in [</button>
    <button class="btn sm clip-out" disabled>Set out ]</button>
    <button class="btn sm ghost clip-reset" disabled>Reset</button>
    <span class="hint clip-trim">no clip loaded</span>
  </div>
`;

export class ClipView {
  /**
   * @param {object} args
   * @param {string} args.tag short label, e.g. "A"
   * @param {() => object} args.getOptions shared draw options from the sidebar
   * @param {(clip: ClipView) => void} args.onActivate
   * @param {(clip: ClipView) => void} args.onChange  frame/trim/track changed
   * @param {(clip: ClipView, id: number) => void} args.onPointClick
   * @param {(clip: ClipView) => void} [args.onClose]
   */
  constructor({ tag, getOptions, onActivate, onChange, onPointClick, onClose }) {
    this.tag = tag;
    this.getOptions = getOptions;
    this.onActivate = onActivate;
    this.onChange = onChange;
    this.onPointClick = onPointClick;
    this.onClose = onClose;

    this.root = document.createElement('section');
    this.root.className = 'clip';
    this.root.innerHTML = TEMPLATE;

    const q = (sel) => this.root.querySelector(sel);
    this.el = {
      head: q('.clip-head'),
      tag: q('.clip-tag'),
      name: q('.clip-name'),
      meta: q('.clip-meta'),
      close: q('.clip-close'),
      stage: q('.clip-stage'),
      canvas: q('.clip-view'),
      drop: q('.clip-drop'),
      badge: q('.clip-badge'),
      progress: q('.clip-progress'),
      progressText: q('.clip-progress .progress-text'),
      progressFill: q('.clip-progress .progress-fill'),
      cancel: q('.clip-cancel'),
      play: q('.clip-play'),
      back: q('.clip-back'),
      fwd: q('.clip-fwd'),
      rate: q('.clip-rate'),
      loop: q('.clip-loop'),
      time: q('.clip-time'),
      timeline: q('.clip-timeline'),
      markIn: q('.clip-in'),
      markOut: q('.clip-out'),
      resetTrim: q('.clip-reset'),
      trim: q('.clip-trim'),
    };
    this.el.tag.textContent = tag;
    this.ctx = this.el.canvas.getContext('2d');

    // Media lives off-stage and is drawn into the canvas; kept renderable so
    // the browser keeps decoding frames we can read.
    this.video = document.createElement('video');
    this.video.className = 'offscreen';
    this.video.playsInline = true;
    this.video.muted = true;
    document.body.append(this.video);

    /** @type {Track|null} */
    this.track = null;
    this.mediaEl = null;
    this.mediaKind = null; // 'video' once a file has loaded
    this.index = 0;
    this.range = [0, 0];
    this.playing = false;
    this.dirty = true;
    this.disposed = false;
    this.objectUrl = null;
    this.sourceName = '';
    /** @type {AbortController|null} set while an analysis pass is running */
    this.abort = null;

    /** Visible window onto the source. */
    this.crop = null;
    /** Region rectangle for cropping / rescanning. */
    this.selection = null;
    this.selectMode = false;
    this._drag = null;

    this.timeline = new Timeline(this.el.timeline, {
      onScrub: (i) => this.setFrame(i),
      onRangeChange: (range) => {
        this.range = range;
        this._updateTrimLabel();
        this.dirty = true;
        this.onChange?.(this);
      },
    });

    this._wire();
    this._watchPresentedFrames();
  }

  /* ------------------------------------------------------------- plumbing */

  _wire() {
    this.root.addEventListener('pointerdown', () => this.onActivate?.(this), true);
    this.el.close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onClose?.(this);
    });

    this.el.play.addEventListener('click', () => this.togglePlay());
    this.el.back.addEventListener('click', () => this.step(-1));
    this.el.fwd.addEventListener('click', () => this.step(1));
    this.el.rate.addEventListener('change', () => {
      this.video.playbackRate = Number(this.el.rate.value);
    });
    this.el.markIn.addEventListener('click', () => this.timeline.markIn());
    this.el.markOut.addEventListener('click', () => this.timeline.markOut());
    this.el.resetTrim.addEventListener('click', () => this.timeline.resetRange());

    const c = this.el.canvas;
    c.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    c.addEventListener('pointermove', (e) => this._onPointerMove(e));
    c.addEventListener('pointerup', (e) => this._onPointerUp(e));
    c.addEventListener('pointercancel', (e) => this._onPointerUp(e));

    for (const type of ['dragenter', 'dragover']) {
      this.el.stage.addEventListener(type, (e) => {
        e.preventDefault();
        this.el.stage.classList.add('is-dragover');
      });
    }
    for (const type of ['dragleave', 'drop']) {
      this.el.stage.addEventListener(type, () => this.el.stage.classList.remove('is-dragover'));
    }
  }

  setActive(on) {
    this.root.classList.toggle('is-active', on);
  }

  setClosable(on) {
    this.el.close.hidden = !on;
  }

  setBadge(text, kind = '') {
    this.el.badge.hidden = !text;
    this.el.badge.textContent = text ?? '';
    this.el.badge.classList.toggle('is-locked', kind === 'locked');
  }

  showProgress(on, text) {
    this.el.progress.hidden = !on;
    if (text) this.el.progressText.textContent = text;
    if (!on) this.el.progressFill.style.width = '0%';
  }

  setProgress(fraction, text) {
    this.el.progressFill.style.width = `${(fraction * 100).toFixed(1)}%`;
    if (text) this.el.progressText.textContent = text;
  }

  onCancel(fn) {
    this.el.cancel.onclick = fn;
  }

  get hasClip() {
    return Boolean(this.track && this.track.length > 1 && this.mediaKind === 'video');
  }

  /* ---------------------------------------------------------------- media */

  _releaseUrl() {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  async loadFile(file) {
    this._releaseUrl();
    this.objectUrl = URL.createObjectURL(file);
    this.sourceName = file.name;
    this.crop = null;
    this.selection = null;

    this.video.src = this.objectUrl;
    await new Promise((resolve, reject) => {
      this.video.onloadedmetadata = () => resolve();
      this.video.onerror = () => reject(new Error(`${file.name} could not be decoded`));
    });
    this.mediaEl = this.video;
    this.mediaKind = 'video';
    this._afterMedia(this.video.videoWidth, this.video.videoHeight);
  }

  _afterMedia(w, h) {
    this.el.name.textContent = this.sourceName || 'clip';
    this.el.stage.classList.add('has-media');
    this.el.meta.textContent = w && h ? `${w}×${h}` : '';
    this.fitCanvas();
    this.dirty = true;
    this._updateTransport();
  }

  sourceSize() {
    return { w: this.video.videoWidth, h: this.video.videoHeight };
  }

  /** The visible window onto the source, normalised. */
  viewSource() {
    return this.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  }

  fitCanvas() {
    const { w, h } = this.sourceSize();
    if (!w || !h) return;
    const src = this.viewSource();
    const pw = Math.max(16, w * src.w);
    const ph = Math.max(16, h * src.h);
    const scale = Math.min(1, MAX_CANVAS_WIDTH / pw);
    this.el.canvas.width = Math.round(pw * scale);
    this.el.canvas.height = Math.round(ph * scale);
    this.dirty = true;
  }

  /* ---------------------------------------------------------------- track */

  setTrack(track, { smoothing = 0 } = {}) {
    this.track = track;
    track.setSmoothing(smoothing);
    this.timeline.setTrack(track);
    this.timeline.setMarks(track.meta.sideFlips ?? []);
    this.index = 0;
    this.dirty = true;
    this._updateTransport();
    this.setFrame(0);
    this.onChange?.(this);
  }

  setSmoothing(amount) {
    this.track?.setSmoothing(amount);
    this.dirty = true;
  }

  /**
   * The track was edited in place (a partial rescan). Rebuild the timeline but
   * hold the trim and playhead by *time*, since a splice changes frame counts
   * and therefore every index after it.
   */
  refreshTrack({ smoothing = 0 } = {}) {
    if (!this.track?.length) return;
    const [t0, t1] = this.rangeTimes();
    const atT = this.track.frames[this.index]?.t ?? 0;
    this.track.setSmoothing(smoothing);
    this.timeline.setTrack(this.track);
    this.timeline.setMarks(this.track.meta.sideFlips ?? []);
    this.timeline.setRange(this.track.indexAt(t0), this.track.indexAt(t1));
    this._updateTransport();
    this.setFrame(this.track.indexAt(atT));
    this.dirty = true;
    this.onChange?.(this);
  }

  rangeTimes() {
    const frames = this.track?.frames;
    if (!frames?.length) return [0, 0];
    return [frames[this.range[0]].t, frames[this.range[1]].t];
  }

  currentFrame() {
    return this.track?.view[this.index] ?? null;
  }

  /* ------------------------------------------------------------- playback */

  /**
   * Redraw and re-label from the frame the video has actually put on screen.
   * `requestVideoFrameCallback` reports the presentation timestamp of that very
   * frame, which is the only value that cannot disagree with the picture.
   */
  _watchPresentedFrames() {
    const v = this.video;
    // `seeked` and `timeupdate` fire only once the decoder has moved: late,
    // but never early. Always on, as a floor under rVFC.
    const sync = () => this._present(v.currentTime);
    v.addEventListener('seeked', sync);
    v.addEventListener('timeupdate', sync);

    if (typeof v.requestVideoFrameCallback === 'function') {
      const cb = (_now, meta) => {
        if (this.disposed) return;
        this._present(meta.mediaTime);
        v.requestVideoFrameCallback(cb);
      };
      v.requestVideoFrameCallback(cb);
    }
  }

  _present(mediaTime) {
    if (!this.track?.length || this.mediaKind !== 'video') return;
    // Kept for diagnostics: this, not currentTime, is what the viewer sees.
    // The two can differ by a frame right after a seek.
    this.presentedTime = mediaTime;
    const idx = this.track.indexAt(mediaTime);
    if (idx === this.index) return;
    this.index = idx;
    this.timeline.setPlayhead(idx);
    this._updateTimeLabel();
    this.dirty = true;
    this.onChange?.(this);
  }

  /** Scrub: ask for a frame and let the presentation callback confirm it. */
  setFrame(index, { seek = true } = {}) {
    if (!this.track?.length) return;
    const target = Math.max(0, Math.min(index, this.track.length - 1));
    if (!seek || this.mediaKind !== 'video') {
      this.index = target;
      this.timeline.setPlayhead(target);
      this._updateTimeLabel();
      this.dirty = true;
      this.onChange?.(this);
      return;
    }
    this.timeline.setPlayhead(target);
    this._seekToIndex(target);
  }

  _seekToIndex(index) {
    const t = this.track.frames[index].t;
    return new Promise((resolve) => {
      const v = this.video;
      if (v.readyState >= 2 && Math.abs(v.currentTime - t) < 1e-4) {
        this._present(t);
        return resolve();
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        v.removeEventListener('seeked', onSeeked);
        resolve();
      };
      const onSeeked = () => {
        this._present(v.currentTime);
        finish();
      };
      const timer = setTimeout(finish, 1500);
      v.addEventListener('seeked', onSeeked);
      v.currentTime = t;
    });
  }

  /**
   * Move exactly one visible frame. If the sample grid is finer than the
   * video's real frame rate, one step can land on the same picture — so keep
   * going until the image actually changes.
   */
  async step(delta) {
    if (!this.track?.length || this.mediaKind !== 'video') return;
    if (this.playing) this.pause();
    const from = this.index;
    const last = this.track.length - 1;
    let target = Math.max(0, Math.min(from + delta, last));

    for (let attempt = 0; attempt < 4; attempt++) {
      await this._seekToIndex(target);
      if (this.index !== from) break;
      const next = target + Math.sign(delta);
      if (next < 0 || next > last) break;
      target = next;
    }
    this.onChange?.(this);
  }

  play() {
    if (!this.hasClip) return false;
    const [t0, t1] = this.rangeTimes();
    if (this.video.currentTime < t0 || this.video.currentTime >= t1 - 1e-3) {
      this.video.currentTime = t0;
    }
    this.video.playbackRate = Number(this.el.rate.value);
    this.video.play().then(() => {
      this.playing = true;
      this.el.play.textContent = '❚❚';
    }).catch(() => {});
    return true;
  }

  pause() {
    this.video.pause();
    this.playing = false;
    this.el.play.textContent = '▶';
  }

  togglePlay() {
    this.playing ? this.pause() : this.play();
  }

  /** Called from the app's single animation loop. */
  tick() {
    if (this.playing && this.track && this.mediaKind === 'video') {
      const [t0, t1] = this.rangeTimes();
      if (this.video.ended || this.video.currentTime >= t1 - 1e-4) {
        if (this.el.loop.checked) {
          this.video.currentTime = t0;
          if (this.video.paused) this.video.play().catch(() => {});
        } else {
          this.pause();
        }
      }
      this.dirty = true; // keep trails and ghosts moving between presentations
    }
    if (this.dirty) {
      this.dirty = false;
      this.draw();
    }
  }

  /* ------------------------------------------------------- crop & select */

  setSelection(rect) {
    this.selection = rect ? clampRect(rect) : null;
    this.dirty = true;
    this.onChange?.(this);
  }

  setSelectMode(on) {
    this.selectMode = on;
    this.el.canvas.classList.toggle('is-selecting', on);
    if (on && !this.selection) {
      // A sensible starting rectangle beats making the user draw from nothing.
      this.selection = { x: 0.25, y: 0.1, w: 0.5, h: 0.8 };
    }
    this.dirty = true;
    this.onChange?.(this);
  }

  applyCrop() {
    if (!this.selection) return false;
    this.crop = clampRect(this.selection);
    this.setSelectMode(false);
    this.fitCanvas();
    this._updateTrimLabel();
    this.onChange?.(this);
    return true;
  }

  clearCrop() {
    this.crop = null;
    this.fitCanvas();
    this._updateTrimLabel();
    this.onChange?.(this);
  }

  _toSource(e) {
    const rect = this.el.canvas.getBoundingClientRect();
    const src = this.viewSource();
    let u = (e.clientX - rect.left) / Math.max(1, rect.width);
    const v = (e.clientY - rect.top) / Math.max(1, rect.height);
    if (this.getOptions().mirror) u = 1 - u;
    return { x: src.x + u * src.w, y: src.y + v * src.h };
  }

  _hitHandle(e) {
    if (!this.selection) return null;
    const rect = this.el.canvas.getBoundingClientRect();
    const scale = this.el.canvas.width / Math.max(1, rect.width);
    const cx = (e.clientX - rect.left) * scale;
    const cy = (e.clientY - rect.top) * scale;
    const { box, points } = selectionHandles(
      this.selection, this.el.canvas.width, this.el.canvas.height,
      this.viewSource(), this.getOptions().mirror,
    );
    const grab = HANDLE_GRAB_PX * scale;
    for (const [name, [hx, hy]] of Object.entries(points)) {
      if (Math.abs(hx - cx) <= grab && Math.abs(hy - cy) <= grab) return name;
    }
    if (cx > box.left && cx < box.right && cy > box.top && cy < box.bottom) return 'move';
    return null;
  }

  _onPointerDown(e) {
    if (!this.selectMode) return;
    e.preventDefault();
    this.el.canvas.setPointerCapture(e.pointerId);
    const handle = this._hitHandle(e);
    const at = this._toSource(e);
    if (handle) {
      this._drag = { handle, start: at, rect: { ...this.selection } };
    } else {
      // Drawing a fresh rectangle from this corner.
      this._drag = { handle: 'se', start: at, rect: { x: at.x, y: at.y, w: 0.02, h: 0.02 }, fresh: true };
      this.selection = { ...this._drag.rect };
    }
  }

  _onPointerMove(e) {
    if (!this._drag) {
      if (this.selectMode) {
        const hit = this._hitHandle(e);
        this.el.canvas.style.cursor = hit
          ? (hit === 'move' ? 'move' : `${hit}-resize`)
          : 'crosshair';
      }
      return;
    }
    const at = this._toSource(e);
    const { handle, start, rect } = this._drag;
    const dx = at.x - start.x;
    const dy = at.y - start.y;
    let next = { ...rect };

    if (handle === 'move') {
      next.x = rect.x + dx;
      next.y = rect.y + dy;
    } else {
      let { x, y, w, h } = rect;
      let x1 = x + w;
      let y1 = y + h;
      if (handle.includes('w')) x = at.x;
      if (handle.includes('e')) x1 = at.x;
      if (handle.includes('n')) y = at.y;
      if (handle.includes('s')) y1 = at.y;
      next = {
        x: Math.min(x, x1),
        y: Math.min(y, y1),
        w: Math.abs(x1 - x),
        h: Math.abs(y1 - y),
      };
    }
    this.selection = clampRect(next);
    this.dirty = true;
    this.onChange?.(this);
  }

  _onPointerUp(e) {
    if (this._drag) {
      this._drag = null;
      try { this.el.canvas.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
      return;
    }
    // Not selecting: a plain click marks the nearest point for trailing.
    if (!this.selectMode && this.onPointClick) this.onPointClick(this, e);
  }

  /* ---------------------------------------------------------------- paint */

  draw() {
    const shared = this.getOptions();
    render(this.ctx, {
      media: this.mediaEl,
      track: this.track?.length ? this.track : null,
      frameIndex: this.index,
      opts: {
        ...shared,
        source: this.viewSource(),
        selection: this.selectMode ? this.selection : null,
        selectionEditable: this.selectMode,
        range: this.range,
        showNoPoseHint: true,
      },
    });
  }

  _updateTransport() {
    const ready = this.hasClip;
    for (const node of [this.el.play, this.el.back, this.el.fwd, this.el.rate,
      this.el.markIn, this.el.markOut, this.el.resetTrim]) {
      node.disabled = !ready;
    }
    this._updateTimeLabel();
    this._updateTrimLabel();
  }

  _updateTimeLabel() {
    if (!this.track?.length) {
      this.el.time.textContent = '–';
      return;
    }
    const t = this.track.frames[this.index]?.t ?? 0;
    this.el.time.textContent =
      `${t.toFixed(2)} / ${this.track.duration.toFixed(2)} s · frame ${this.index + 1}/${this.track.length}`;
  }

  _updateTrimLabel() {
    if (!this.track?.length) {
      this.el.trim.textContent = 'no clip loaded';
      return;
    }
    const [a, b] = this.rangeTimes();
    const count = this.range[1] - this.range[0] + 1;
    const crop = this.crop
      ? ` · crop ${Math.round(this.crop.w * 100)}×${Math.round(this.crop.h * 100)}%`
      : '';
    this.el.trim.textContent =
      `${a.toFixed(2)}s → ${b.toFixed(2)}s (${(b - a).toFixed(2)}s, ${count} frames)${crop}`;
  }

  dispose() {
    this.disposed = true;
    this.pause();
    this._releaseUrl();
    this.video.remove();
    this.root.remove();
  }
}
