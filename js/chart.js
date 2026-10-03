// Joint-angle plot over the trimmed range, with a playhead tied to the stage.

const SERIES_COLORS = ['#7dd3fc', '#fda4af', '#a7f3d0', '#fcd34d', '#c4b5fd', '#f9a8d4'];

export class AngleChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._ro = new ResizeObserver(() => this.render());
    this._ro.observe(canvas);
    this._state = null;
  }

  /** @param {{track, defs, range:[number,number], playhead:number, mode:'image'|'world'}} state */
  render(state) {
    if (state) this._state = state;
    const s = this._state;
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);

    const pad = { l: 30 * dpr, r: 6 * dpr, t: 8 * dpr, b: 4 * dpr };
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;

    ctx.font = `${10 * dpr}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    for (const deg of [0, 45, 90, 135, 180]) {
      const y = pad.t + plotH * (1 - deg / 180);
      ctx.strokeStyle = 'rgba(148,163,184,0.16)';
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(w - pad.r, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(148,163,184,0.6)';
      ctx.fillText(`${deg}`, 4 * dpr, y);
    }

    if (!s?.track || !s.defs?.length || s.track.length < 2) {
      ctx.fillStyle = 'rgba(148,163,184,0.55)';
      ctx.fillText('pick a joint angle to plot', pad.l + 8 * dpr, h / 2);
      return;
    }

    const [from, to] = s.range;
    const span = Math.max(1, to - from);
    const xAt = (i) => pad.l + ((i - from) / span) * plotW;
    const yAt = (deg) => pad.t + plotH * (1 - deg / 180);

    s.defs.forEach((def, di) => {
      const series = s.track.angleSeries(def, s.mode);
      ctx.strokeStyle = SERIES_COLORS[di % SERIES_COLORS.length];
      ctx.lineWidth = 1.8 * dpr;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let drawing = false;
      for (let i = from; i <= to; i++) {
        const v = series[i];
        if (Number.isNaN(v)) {
          drawing = false;
          continue;
        }
        if (!drawing) {
          ctx.moveTo(xAt(i), yAt(v));
          drawing = true;
        } else {
          ctx.lineTo(xAt(i), yAt(v));
        }
      }
      ctx.stroke();
    });

    if (s.playhead >= from && s.playhead <= to) {
      const x = xAt(s.playhead);
      ctx.strokeStyle = 'rgba(248,250,252,0.85)';
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + plotH);
      ctx.stroke();
    }
  }
}

export function seriesColor(i) {
  return SERIES_COLORS[i % SERIES_COLORS.length];
}
