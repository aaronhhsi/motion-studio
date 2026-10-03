// Scrub bar with draggable in/out trim handles and a motion-energy strip so the
// busy part of a clip is visible at a glance.

export class Timeline {
  /**
   * @param {HTMLElement} root
   * @param {{onScrub:(index:number)=>void, onRangeChange:(range:[number,number])=>void}} handlers
   */
  constructor(root, { onScrub, onRangeChange }) {
    this.root = root;
    this.onScrub = onScrub;
    this.onRangeChange = onRangeChange;
    this.track = null;
    this.playhead = 0;
    this.range = [0, 0];

    this.strip = root.querySelector('.tl-strip');
    this.ctx = this.strip.getContext('2d');
    this.rangeEl = root.querySelector('.tl-range');
    this.inEl = root.querySelector('.tl-in');
    this.outEl = root.querySelector('.tl-out');
    this.headEl = root.querySelector('.tl-playhead');

    this._drag = null;
    /** Index ranges flagged under the strip, e.g. corrected left/right runs. */
    this.marks = [];
    root.addEventListener('pointerdown', (e) => this._onDown(e));
    root.addEventListener('pointermove', (e) => this._onMove(e));
    root.addEventListener('pointerup', (e) => this._onUp(e));
    root.addEventListener('pointercancel', (e) => this._onUp(e));

    this._ro = new ResizeObserver(() => this.redraw());
    this._ro.observe(root);
  }

  setTrack(track) {
    this.track = track;
    this.range = [0, Math.max(0, (track?.length ?? 1) - 1)];
    this.playhead = 0;
    this.root.classList.toggle('is-empty', !track || track.length < 2);
    this.redraw();
    this.onRangeChange(this.range);
  }

  get lastIndex() {
    return Math.max(0, (this.track?.length ?? 1) - 1);
  }

  /**
   * Flag stretches of the clip on the timeline. An automatic data correction
   * should be visible, not silent — you can see exactly which frames changed.
   * @param {Array<{from:number,to:number}>} ranges
   */
  setMarks(ranges) {
    this.marks = ranges ?? [];
    this.redraw();
  }

  setPlayhead(index) {
    this.playhead = clamp(index, 0, this.lastIndex);
    this._layout();
  }

  setRange(a, b) {
    const lo = clamp(Math.min(a, b), 0, this.lastIndex);
    const hi = clamp(Math.max(a, b), 0, this.lastIndex);
    this.range = [lo, hi];
    this._layout();
    this.onRangeChange(this.range);
  }

  markIn() {
    this.setRange(this.playhead, Math.max(this.playhead, this.range[1]));
  }

  markOut() {
    this.setRange(Math.min(this.playhead, this.range[0]), this.playhead);
  }

  resetRange() {
    this.setRange(0, this.lastIndex);
  }

  _indexFromEvent(e) {
    const rect = this.root.getBoundingClientRect();
    const frac = clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    return Math.round(frac * this.lastIndex);
  }

  _onDown(e) {
    if (!this.track || this.track.length < 2) return;
    this.root.setPointerCapture(e.pointerId);
    const target = e.target;
    if (target === this.inEl) this._drag = 'in';
    else if (target === this.outEl) this._drag = 'out';
    else {
      this._drag = 'head';
      this.setPlayhead(this._indexFromEvent(e));
      this.onScrub(this.playhead);
    }
  }

  _onMove(e) {
    if (!this._drag) return;
    const idx = this._indexFromEvent(e);
    if (this._drag === 'head') {
      this.setPlayhead(idx);
      this.onScrub(this.playhead);
    } else if (this._drag === 'in') {
      this.setRange(Math.min(idx, this.range[1] - 1), this.range[1]);
      if (this.playhead < this.range[0]) {
        this.setPlayhead(this.range[0]);
        this.onScrub(this.playhead);
      }
    } else {
      this.setRange(this.range[0], Math.max(idx, this.range[0] + 1));
      if (this.playhead > this.range[1]) {
        this.setPlayhead(this.range[1]);
        this.onScrub(this.playhead);
      }
    }
  }

  _onUp(e) {
    if (!this._drag) return;
    this._drag = null;
    try {
      this.root.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  }

  _layout() {
    const last = Math.max(1, this.lastIndex);
    const pct = (i) => `${(i / last) * 100}%`;
    this.inEl.style.left = pct(this.range[0]);
    this.outEl.style.left = pct(this.range[1]);
    this.rangeEl.style.left = pct(this.range[0]);
    this.rangeEl.style.width = `${((this.range[1] - this.range[0]) / last) * 100}%`;
    this.headEl.style.left = pct(this.playhead);
  }

  redraw() {
    const rect = this.root.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.strip.width !== w || this.strip.height !== h) {
      this.strip.width = w;
      this.strip.height = h;
    }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    this._layout();
    if (!this.track || this.track.length < 2) return;

    const speed = this.track.speedSeries();
    let peak = 0;
    for (const v of speed) peak = Math.max(peak, v);

    if (peak > 0) {
      ctx.fillStyle = 'rgba(125, 211, 252, 0.35)';
      const n = speed.length;
      for (let x = 0; x < w; x++) {
        const i0 = Math.floor((x / w) * n);
        const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / w) * n));
        let v = 0;
        for (let i = i0; i < i1 && i < n; i++) v = Math.max(v, speed[i]);
        const bar = Math.min(1, v / peak) * h;
        ctx.fillRect(x, h - bar, 1, bar);
      }
    }

    const last = Math.max(1, this.lastIndex);
    ctx.fillStyle = 'rgba(252, 211, 77, 0.85)';
    for (const mark of this.marks) {
      const x0 = (mark.from / last) * w;
      const x1 = (mark.to / last) * w;
      ctx.fillRect(x0, 0, Math.max(1.5 * dpr, x1 - x0), 3 * dpr);
    }
  }
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
