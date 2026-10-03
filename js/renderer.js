// All stage drawing: the media, the skeleton and hands, motion trails,
// onion-skin ghosts, joint-angle annotations, and the focus-scan highlight.

import {
  CONNECTIONS, HAND_CONNECTIONS, HAND_SIDES, GROUPS, FINGERTIPS,
  colorOf, shortLabel, sideOf, SIDE_COLORS,
  pointAt, isHandPoint, handIndexOf, handPointId,
} from './skeleton.js';
import { angleAt } from './track.js';

export function visibleIndices(groupKeys) {
  const set = new Set();
  for (const key of groupKeys) {
    for (const i of GROUPS[key]?.indices ?? []) set.add(i);
  }
  return set;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} args
 * @param {HTMLVideoElement|null} args.media
 * @param {import('./track.js').Track|null} args.track
 * @param {number} args.frameIndex
 */
export function render(ctx, { media, track, frameIndex, opts }) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const s = Math.min(W, H) / 640;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0e14';
  ctx.fillRect(0, 0, W, H);

  // The visible window onto the source, normalised. A crop shrinks it; the
  // landmark mapping below has to travel through the same window or the
  // skeleton drifts off the body.
  const src = opts.source ?? { x: 0, y: 0, w: 1, h: 1 };

  if (media && opts.videoOpacity > 0) {
    const mw = media.videoWidth || media.naturalWidth || 0;
    const mh = media.videoHeight || media.naturalHeight || 0;
    ctx.save();
    ctx.globalAlpha = opts.videoOpacity;
    if (opts.mirror) {
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
    }
    try {
      if (mw && mh) {
        ctx.drawImage(media, src.x * mw, src.y * mh, src.w * mw, src.h * mh, 0, 0, W, H);
      } else {
        ctx.drawImage(media, 0, 0, W, H);
      }
    } catch {
      /* video not ready yet */
    }
    ctx.restore();
  }

  const u = (x) => (x - src.x) / src.w;
  const px = (x) => (opts.mirror ? 1 - u(x) : u(x)) * W;
  const py = (y) => ((y - src.y) / src.h) * H;
  const groupShown = opts.visible instanceof Set ? opts.visible : visibleIndices(opts.groups ?? []);
  const minVis = opts.visibilityThreshold ?? 0.4;
  const focus = opts.focus instanceof Set && opts.focus.size ? opts.focus : null;

  // With a lock in place, everything else either disappears or fades back to
  // context, so the eye follows only what was locked on.
  const shown = focus && opts.focusOnly ? new Set([...groupShown].filter((id) => focus.has(id))) : groupShown;
  const alphaFor = (id) => (!focus || focus.has(id) ? 1 : opts.focusDim ?? 0.18);

  const view = { px, py, s, shown, minVis, alphaFor, opts };

  if (track && opts.strobeEvery > 0 && frameIndex >= 0) {
    drawGhosts(ctx, view, track, frameIndex);
  }
  if (track && opts.trails?.size && frameIndex >= 0) {
    drawTrails(ctx, view, track, frameIndex);
  }

  const frame = track && frameIndex >= 0 ? track.view[frameIndex] : null;

  if (frame?.pose || frame?.hands) {
    if (opts.showSkeleton) drawSkeleton(ctx, view, frame, 4 * s * opts.lineScale);
    if (opts.showPoints) drawPoints(ctx, view, frame);
    if (opts.showAngles && opts.angleDefs?.length && frame.pose) {
      // The arc is drawn in canvas pixels, so the number beside it is measured
      // the same way — the canvas ratio is the ratio of what is on screen.
      drawAngles(ctx, frame, opts.angleDefs, {
        px, py, s, minVis, mode: opts.angleMode ?? 'image', aspect: W / H,
      });
    }
    if (opts.showLabels) drawLabels(ctx, view, frame);
  } else if (opts.showNoPoseHint !== false) {
    drawHint(ctx, W, H, s, opts.noPoseHint ?? 'no pose detected in this frame');
  }

  // Selection sits on top of everything, including the no-pose hint — you often
  // draw one precisely because nothing was detected.
  if (opts.selection) drawSelection(ctx, view, opts.selection, W, H);
}

/** Handle positions for a selection rect, in canvas pixels. */
export function selectionHandles(rect, W, H, source = { x: 0, y: 0, w: 1, h: 1 }, mirror = false) {
  const u = (x) => (x - source.x) / source.w;
  const fx = (x) => (mirror ? 1 - u(x) : u(x)) * W;
  const fy = (y) => ((y - source.y) / source.h) * H;
  const x0 = fx(rect.x);
  const x1 = fx(rect.x + rect.w);
  const y0 = fy(rect.y);
  const y1 = fy(rect.y + rect.h);
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const cx = (left + right) / 2;
  const cy = (y0 + y1) / 2;
  return {
    box: { left, top: y0, right, bottom: y1 },
    points: {
      nw: [left, y0], n: [cx, y0], ne: [right, y0],
      w: [left, cy], e: [right, cy],
      sw: [left, y1], s: [cx, y1], se: [right, y1],
    },
  };
}

function drawSelection(ctx, view, rect, W, H) {
  const { s, opts } = view;
  const { box, points } = selectionHandles(rect, W, H, opts.source, opts.mirror);
  const w = box.right - box.left;
  const h = box.bottom - box.top;

  ctx.save();
  // Dim everything outside the selection so the region reads immediately.
  ctx.fillStyle = 'rgba(7,9,16,0.55)';
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.rect(box.left, box.top, w, h);
  ctx.fill('evenodd');

  ctx.strokeStyle = '#a7f3d0';
  ctx.lineWidth = 1.6 * s;
  ctx.setLineDash([6 * s, 4 * s]);
  ctx.strokeRect(box.left, box.top, w, h);
  ctx.setLineDash([]);

  if (opts.selectionEditable !== false) {
    const r = 4.5 * s;
    ctx.fillStyle = '#a7f3d0';
    ctx.strokeStyle = 'rgba(7,9,16,0.85)';
    ctx.lineWidth = 1.5 * s;
    for (const [hx, hy] of Object.values(points)) {
      ctx.beginPath();
      ctx.rect(hx - r, hy - r, r * 2, r * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  const label = `${Math.round(rect.w * 100)}% × ${Math.round(rect.h * 100)}%`;
  ctx.font = `600 ${Math.round(11 * s)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(7,9,16,0.85)';
  roundRect(ctx, box.left, box.top - 20 * s, tw + 12 * s, 16 * s, 4 * s);
  ctx.fill();
  ctx.fillStyle = '#a7f3d0';
  ctx.fillText(label, box.left + 6 * s, box.top - 12 * s);
  ctx.restore();
}

/** Every connection to draw for a frame, as unified point-id pairs. */
function connectionsFor(frame) {
  const pairs = frame.pose ? [...CONNECTIONS] : [];
  for (const side of HAND_SIDES) {
    if (!frame.hands?.[side]) continue;
    for (const [a, b] of HAND_CONNECTIONS) {
      pairs.push([handPointId(side, a), handPointId(side, b)]);
    }
  }
  return pairs;
}

function drawSkeleton(ctx, view, frame, width, alphaScale = 1) {
  const { px, py, shown, minVis, alphaFor } = view;
  ctx.save();
  ctx.lineCap = 'round';
  for (const [a, b] of connectionsFor(frame)) {
    if (!shown.has(a) || !shown.has(b)) continue;
    const p = pointAt(frame, a);
    const q = pointAt(frame, b);
    if (!p || !q || p.visibility < minVis || q.visibility < minVis) continue;

    // Hand bones are much shorter than body bones; scale them down or the
    // fingers turn into one blob.
    ctx.lineWidth = isHandPoint(a) ? width * 0.45 : width;
    ctx.globalAlpha = Math.min(alphaFor(a), alphaFor(b)) * alphaScale;

    const grad = ctx.createLinearGradient(px(p.x), py(p.y), px(q.x), py(q.y));
    grad.addColorStop(0, colorOf(a));
    grad.addColorStop(1, colorOf(b));
    ctx.strokeStyle = grad;
    ctx.beginPath();
    ctx.moveTo(px(p.x), py(p.y));
    ctx.lineTo(px(q.x), py(q.y));
    ctx.stroke();
  }
  ctx.restore();
}

function drawPoints(ctx, view, frame) {
  const { px, py, shown, minVis, alphaFor, opts } = view;
  const radius = 4.5 * view.s * opts.pointScale;
  ctx.save();
  for (const id of shown) {
    const p = pointAt(frame, id);
    if (!p || p.visibility < minVis) continue;
    const marked = opts.trails?.has(id);
    const hand = isHandPoint(id);
    const tip = hand && FINGERTIPS.includes(handIndexOf(id));
    let r = radius;
    if (hand) r *= tip ? 0.7 : 0.45;
    if (marked) r *= 1.5;

    const alpha = alphaFor(id);
    ctx.beginPath();
    ctx.arc(px(p.x), py(p.y), r, 0, Math.PI * 2);
    ctx.fillStyle = colorOf(id);
    ctx.globalAlpha = (0.35 + 0.65 * p.visibility) * alpha;
    ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.lineWidth = marked ? r * 0.45 : r * 0.3;
    ctx.strokeStyle = marked ? '#ffffff' : 'rgba(11,14,20,0.8)';
    ctx.stroke();
  }
  ctx.restore();
}

function drawLabels(ctx, view, frame) {
  const { px, py, s, shown, minVis, alphaFor } = view;
  ctx.save();
  ctx.font = `600 ${Math.round(11 * s)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  for (const id of shown) {
    const p = pointAt(frame, id);
    if (!p || p.visibility < minVis) continue;
    // Labelling all 21 joints of a hand is unreadable; tips carry the meaning.
    if (isHandPoint(id) && !FINGERTIPS.includes(handIndexOf(id))) continue;
    ctx.globalAlpha = alphaFor(id);
    const text = shortLabel(id);
    const x = px(p.x) + 9 * s;
    const y = py(p.y) - 9 * s;
    const w = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(11,14,20,0.72)';
    roundRect(ctx, x - 3 * s, y - 8 * s, w + 6 * s, 16 * s, 4 * s);
    ctx.fill();
    ctx.fillStyle = colorOf(id);
    ctx.fillText(text, x, y);
  }
  ctx.restore();
}

/** Faded copies of the skeleton at earlier frames — a stroboscopic photo. */
function drawGhosts(ctx, view, track, frameIndex) {
  const startIdx = trailStartIndex(track, frameIndex, view.opts);
  const step = Math.max(1, Math.round(view.opts.strobeEvery));
  for (let i = startIdx; i < frameIndex; i += step) {
    const f = track.view[i];
    if (!f?.pose && !f?.hands) continue;
    const age = (frameIndex - i) / Math.max(1, frameIndex - startIdx);
    drawSkeleton(ctx, view, f, 2.5 * view.s * view.opts.lineScale, 0.06 + 0.34 * (1 - age));
  }
}

function drawTrails(ctx, view, track, frameIndex) {
  const { px, py, s, minVis, opts } = view;
  const startIdx = trailStartIndex(track, frameIndex, opts);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const id of opts.trails) {
    const path = track.jointPath(id, startIdx, frameIndex, minVis);
    const color = colorOf(id);
    const span = Math.max(1, path.length - 1);

    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1];
      const b = path[k];
      if (!a || !b) continue;
      const age = 1 - k / span;
      ctx.globalAlpha = 0.12 + 0.88 * (1 - age) ** 1.4;
      ctx.lineWidth = (1.5 + 3.5 * (1 - age)) * s * opts.lineScale;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(px(a.x), py(a.y));
      ctx.lineTo(px(b.x), py(b.y));
      ctx.stroke();
    }

    // One dot per sample: tight clusters mean slow, wide gaps mean fast.
    if (opts.trailDots) {
      for (let k = 0; k < path.length; k++) {
        const p = path[k];
        if (!p) continue;
        const age = 1 - k / span;
        ctx.globalAlpha = 0.15 + 0.6 * (1 - age);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(px(p.x), py(p.y), 1.6 * s * opts.pointScale, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

function trailStartIndex(track, frameIndex, opts) {
  const rangeStart = opts.range ? opts.range[0] : 0;
  if (!Number.isFinite(opts.trailSeconds)) return rangeStart;
  const cutoff = track.view[frameIndex].t - opts.trailSeconds;
  return Math.max(rangeStart, track.indexAt(cutoff));
}

function drawAngles(ctx, frame, defs, { px, py, s, minVis, mode, aspect }) {
  const pose = frame.pose;
  ctx.save();
  ctx.font = `700 ${Math.round(13 * s)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  for (const def of defs) {
    const a = pose[def.a];
    const b = pose[def.b];
    const c = pose[def.c];
    if (!a || !b || !c) continue;
    if (Math.min(a.visibility, b.visibility, c.visibility) < minVis) continue;
    const value = angleAt(frame, def, { mode, aspect });
    if (value == null) continue;

    const bx = px(b.x);
    const by = py(b.y);
    const a1 = Math.atan2(py(a.y) - by, px(a.x) - bx);
    const a2 = Math.atan2(py(c.y) - by, px(c.x) - bx);
    const r = 26 * s;

    ctx.strokeStyle = SIDE_COLORS[sideOf(def.b)];
    ctx.lineWidth = 2.5 * s;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(bx, by, r, a1, a2, shorterWay(a1, a2));
    ctx.stroke();

    const mid = midAngle(a1, a2);
    const tx = bx + Math.cos(mid) * (r + 16 * s);
    const ty = by + Math.sin(mid) * (r + 16 * s);
    const text = `${Math.round(value)}°`;
    const w = ctx.measureText(text).width;
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(11,14,20,0.82)';
    roundRect(ctx, tx - w / 2 - 5 * s, ty - 10 * s, w + 10 * s, 20 * s, 5 * s);
    ctx.fill();
    ctx.fillStyle = '#e8edf7';
    ctx.textAlign = 'center';
    ctx.fillText(text, tx, ty);
    ctx.textAlign = 'start';
  }
  ctx.restore();
}

function shorterWay(a1, a2) {
  let d = a2 - a1;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d < 0;
}

function midAngle(a1, a2) {
  let d = a2 - a1;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a1 + d / 2;
}

function drawHint(ctx, W, H, s, text) {
  ctx.save();
  ctx.font = `500 ${Math.round(14 * s)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  const w = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(11,14,20,0.7)';
  roundRect(ctx, W / 2 - w / 2 - 10 * s, H - 34 * s, w + 20 * s, 22 * s, 6 * s);
  ctx.fill();
  ctx.fillStyle = 'rgba(232,237,247,0.7)';
  ctx.fillText(text, W / 2, H - 23 * s);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
