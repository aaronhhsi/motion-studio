// End-to-end smoke test. Boots the static server, drives a real headless
// Chromium over CDP (no test-runner dependency), and exercises the whole video
// path: model load, analysis, scan, trim, compare, crop, rescan, export.
//
//   node tests/smoke.mjs            headless
//   node tests/smoke.mjs --headed   watch it happen

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 5199;
const HEADED = process.argv.includes('--headed');

const BROWSERS = [
  join(process.env['ProgramFiles'] ?? '', 'Google/Chrome/Application/chrome.exe'),
  join(process.env['ProgramFiles(x86)'] ?? '', 'Google/Chrome/Application/chrome.exe'),
  join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft/Edge/Application/msedge.exe'),
  join(process.env['ProgramFiles'] ?? '', 'Microsoft/Edge/Application/msedge.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const failures = [];
const cleanup = [];

function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 30000, interval = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(interval);
  }
}

/* ------------------------------------------------------------ CDP client */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP connect failed')), { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }));
  }

  on(fn) {
    this.listeners.push(fn);
  }

  /** Evaluate an expression in the page and return its JSON value. */
  async eval(expression, { awaitPromise = true } = {}) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  }
}

/* ------------------------------------------------------------------- run */

async function main() {
  const browser = BROWSERS.find((p) => p && existsSync(p));
  if (!browser) {
    console.log('No Chrome/Edge found — skipping the browser smoke test.');
    return;
  }
  console.log(`browser: ${browser}\n`);

  const server = spawn(process.execPath, [join(ROOT, 'scripts/serve.mjs')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  cleanup.push(() => server.kill());
  await waitFor(
    () => fetch(`http://localhost:${PORT}/index.html`).then((r) => r.ok).catch(() => false),
    { label: 'static server', timeout: 10000 },
  );

  const profile = mkdtempSync(join(tmpdir(), 'motion-studio-'));
  cleanup.push(() => rmSync(profile, { recursive: true, force: true }));

  const chrome = spawn(browser, [
    ...(HEADED ? [] : ['--headless=new']),
    '--remote-debugging-port=9333',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-swiftshader',          // software WebGL for the GPU delegate
    '--window-size=1280,800',               // deterministic sizing for layout checks
    `http://localhost:${PORT}/index.html`,
  ], { stdio: 'ignore' });
  cleanup.push(() => chrome.kill());

  const target = await waitFor(async () => {
    try {
      const list = await (await fetch('http://localhost:9333/json/list')).json();
      return list.find((t) => t.type === 'page' && t.url.includes(String(PORT)));
    } catch {
      return null;
    }
  }, { label: 'devtools target', timeout: 20000 });

  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  const consoleErrors = [];
  const consoleAll = [];
  cdp.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => a.description ?? a.value).join(' ');
      consoleAll.push(text);
      if (msg.params.type === 'error') consoleErrors.push(text);
    }
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.reload');
  await sleep(500);

  const status = () => cdp.eval(`document.querySelector('#statusText').textContent`);

  /**
   * Asserting `el.hidden === true` proves nothing: the attribute's UA rule has
   * zero specificity, so any class setting `display` beats it and the element
   * stays on screen. Only computed style tells the truth.
   */
  const hiddenAudit = async (when) => {
    const r = await cdp.eval(`(() => {
      const shown = [];
      for (const node of document.querySelectorAll('[hidden]')) {
        if (getComputedStyle(node).display !== 'none') {
          shown.push(node.id || node.getAttribute('class') || node.tagName);
        }
      }
      return { shown };
    })()`);
    check(`nothing marked hidden is visible (${when})`, r.shown.length === 0,
      r.shown.join(', ') || 'clean');
  };

  // --- 1. the app boots and the pose model loads --------------------------
  await waitFor(async () => /ready|failed|could not/.test(await status()), {
    label: 'model load', timeout: 90000,
  });
  const bootStatus = await status();
  check('pose model loads', bootStatus.startsWith('ready'), bootStatus);
  check('landmarker reports a delegate', /GPU|CPU/.test(bootStatus), bootStatus);

  // --- 1b. the sidebar must scroll, not overflow the viewport -------------
  const layout = await cdp.eval(`(() => {
    const sb = document.querySelector('.sidebar');
    sb.scrollTop = 1e6;
    const scrolled = sb.scrollTop;
    const shortcuts = document.querySelector('.shortcuts').getBoundingClientRect();
    const box = sb.getBoundingClientRect();
    sb.scrollTop = 0;
    return {
      clientH: sb.clientHeight,
      scrollH: sb.scrollHeight,
      scrolled,
      viewportH: window.innerHeight,
      overflowsViewport: box.bottom > window.innerHeight + 1,
      pageScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      lastVisible: shortcuts.bottom <= box.bottom + 1,
    };
  })()`);
  check('sidebar has more content than fits', layout.scrollH > layout.clientH,
    `${layout.scrollH}px of content in ${layout.clientH}px`);
  check('sidebar scrolls', layout.scrolled > 0, `scrollTop reached ${layout.scrolled}`);
  check('sidebar is clipped to the viewport', layout.overflowsViewport === false,
    `sidebar height ${layout.clientH}, viewport ${layout.viewportH}`);
  check('page itself does not scroll', layout.pageScrolls === false);
  check('bottom of the sidebar is reachable', layout.lastVisible === true);

  // --- 1c. a freshly loaded page shows no stray overlays ------------------
  const onLoad = await cdp.eval(`(() => {
    const vis = (id) => getComputedStyle(document.querySelector(id)).display !== 'none';
    const ms = window.motionStudio;
    return {
      progress: vis('.clip-progress'),
      trails: ms.state.trails.size,
      angles: ms.state.angles.size,
      arcs: document.querySelector('#anglesChk').checked,
    };
  })()`);
  check('no progress bar on load', onLoad.progress === false);
  check('nothing is trailed by default', onLoad.trails === 0, `${onLoad.trails} trails`);
  check('no joint angles by default', onLoad.angles === 0 && onLoad.arcs === false,
    `${onLoad.angles} angles, arcs ${onLoad.arcs ? 'on' : 'off'}`);
  await hiddenAudit('on load');

  // A photo panned across a canvas and recorded is a real video with a real
  // person in it — the only way to exercise the video path against real
  // landmarks without shipping footage. Same-origin blob URL: no canvas taint.
  const recordClip = (url, name) => cdp.eval(`(async () => {
    const res = await fetch(${JSON.stringify(url)});
    const src = URL.createObjectURL(await res.blob());
    const img = new Image();
    img.src = src;
    await img.decode();

    const c = document.createElement('canvas');
    c.width = 640;
    c.height = Math.round(640 * img.naturalHeight / img.naturalWidth);
    const g = c.getContext('2d');
    const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm;codecs=vp9' });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => { rec.onstop = r; });
    rec.start(100);

    const t0 = performance.now();
    await new Promise((resolve) => {
      const frame = () => {
        const t = (performance.now() - t0) / 1000;
        g.fillStyle = '#101010';
        g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, Math.sin(t * 3) * 24, 0, c.width, c.height);  // give it motion
        if (t >= 2) return resolve();
        requestAnimationFrame(frame);
      };
      frame();
    });
    rec.stop();
    await stopped;
    URL.revokeObjectURL(src);

    const blob = new Blob(chunks, { type: 'video/webm' });
    window[${JSON.stringify(name)}] = new File([blob], ${JSON.stringify(name)} + '.webm', { type: 'video/webm' });
    return blob.size;
  })()`);
  // MediaRecorder occasionally hands back an empty recording in headless
  // Chrome (seen locally, four runs in a row, then not again). That is the
  // test's scaffolding failing, not the app, so try again before giving up.
  const makeClip = async (url, name) => {
    let bytes = 0;
    for (let attempt = 0; attempt < 3 && bytes === 0; attempt++) bytes = await recordClip(url, name);
    return bytes;
  };

  // --- 2. a video of a real person produces real landmarks -----------------
  const clipBytes = await makeClip('https://storage.googleapis.com/mediapipe-assets/pose.jpg', '__clip');
  check('built a test clip containing a person', clipBytes > 5000, `${clipBytes} bytes`);

  await cdp.eval(`window.motionStudio.loadVideoFile(window.__clip)`);
  await cdp.eval(`window.motionStudio.idle()`);
  const clipStatus = await status();
  const tracked = Number(clipStatus.match(/(\d+)% tracked/)?.[1] ?? 0);
  check('video pipeline finds the person in every frame', tracked >= 90, clipStatus);
  await hiddenAudit('clip loaded');

  const clipInfo = await cdp.eval(`(() => {
    const { active } = window.motionStudio;
    return {
      frames: active.track?.length ?? 0,
      duration: active.track?.duration ?? 0,
      range: active.range,
      timelineEmpty: document.querySelector('.clip-timeline').classList.contains('is-empty'),
      playDisabled: document.querySelector('.clip-play').disabled,
    };
  })()`);
  check('clip has a multi-frame track', clipInfo.frames > 20, `${clipInfo.frames} frames`);
  // MediaRecorder WebM reports duration = Infinity until seeked to the end.
  check('clip duration resolved (not Infinity)',
    Number.isFinite(clipInfo.duration) && clipInfo.duration > 1, `${clipInfo.duration}s`);
  check('timeline is armed', clipInfo.timelineEmpty === false && clipInfo.playDisabled === false);
  check('trim range spans the clip',
    clipInfo.range[0] === 0 && clipInfo.range[1] === clipInfo.frames - 1, JSON.stringify(clipInfo.range));

  const pose = await cdp.eval(`(() => {
    const { active } = window.motionStudio;
    const f = active.track.frames[active.index];
    if (!f?.pose) return { ok: false };
    const inRange = f.pose.every(p => p.x > -0.5 && p.x < 1.5 && p.y > -0.5 && p.y < 1.5);
    const visible = f.pose.filter(p => p.visibility > 0.5).length;
    return { ok: true, inRange, visible, count: f.pose.length, world: f.world?.length ?? 0 };
  })()`);
  check('pose detected', pose.ok);
  check('33 landmarks', pose.count === 33, `got ${pose.count}`);
  check('world landmarks present', pose.world === 33, `got ${pose.world}`);
  check('coordinates normalised', pose.inRange === true);
  check('most joints confident', pose.visible >= 20, `${pose.visible}/33 over 0.5`);

  // Angles are off by default, so pick two the way a user would.
  await cdp.eval(`(() => {
    for (const chip of document.querySelectorAll('#angleChips .chip')) {
      if (/^(Right elbow|Right knee)$/.test(chip.textContent)) chip.click();
    }
  })()`);
  const angles = await cdp.eval(`(() => {
    const out = {};
    for (const line of document.querySelectorAll('#angleReadout .line')) {
      out[line.firstChild.textContent.trim()] = line.lastChild.textContent.trim();
    }
    return out;
  })()`);
  const angleValues = Object.values(angles);
  check('joint angles computed once picked',
    angleValues.length === 2 && angleValues.every((v) => /^\d+(\.\d+)?°$/.test(v)),
    JSON.stringify(angles));

  // A clip paints when the video presents a frame, which lands a moment after
  // the analysis queue drains — so poll rather than sample once.
  const litPixels = () => cdp.eval(`(() => {
    const c = document.querySelector('.clip-view');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i+1] + d[i+2] > 60) lit++;
    return { w: c.width, h: c.height, lit };
  })()`);
  let painted = await litPixels();
  try {
    await waitFor(async () => (painted = await litPixels()).lit > 1000, { label: 'paint', timeout: 5000 });
  } catch { /* reported by the check below */ }
  check('canvas has content', painted.lit > 1000,
    `${painted.w}x${painted.h}, ${painted.lit} lit px`);

  // The number beside the arc must describe the arc. It used to be measured
  // from 3D world landmarks while the arc was drawn in screen space, so the two
  // disagreed by tens of degrees.
  const measured = await cdp.eval(`(async () => {
    const { angleAt } = await import('/js/track.js');
    const SK = await import('/js/skeleton.js');
    const ms = window.motionStudio;
    const frame = ms.active.track.view[ms.active.index];
    const c = ms.active.el.canvas;
    const aspect = c.width / c.height;
    const def = SK.ANGLES.find((d) => d.id === 'right_elbow');
    const row = [...document.querySelectorAll('#angleReadout .line')]
      .find((l) => /Right elbow/.test(l.textContent));
    return {
      aspect,
      image: angleAt(frame, def, { mode: 'image', aspect }),
      world: angleAt(frame, def, { mode: 'world', aspect }),
      naive: angleAt(frame, def, { mode: 'image', aspect: 1 }),
      shown: row ? parseFloat(row.lastChild.textContent) : null,
      mode: document.querySelector('#angleModeSel').value,
      // A near-straight joint barely moves under an aspect change, so prove
      // the correction on whichever joint in this frame is bent the most.
      aspectEffect: Math.max(...SK.ANGLES.map((d) => {
        const a = angleAt(frame, d, { mode: 'image', aspect });
        const b = angleAt(frame, d, { mode: 'image', aspect: 1 });
        return a == null || b == null ? 0 : Math.abs(a - b);
      })),
    };
  })()`);
  check('angles default to the image plane', measured.mode === 'image');
  check('the readout matches the arc on screen',
    Math.abs(measured.shown - measured.image) < 0.06,
    `shown ${measured.shown}°, measured ${measured.image?.toFixed(1)}°`);
  check('aspect correction changes a real measurement', measured.aspectEffect > 0.5,
    `largest change ${measured.aspectEffect.toFixed(1)}° at ${measured.aspect.toFixed(2)}:1`);
  console.log(`         (right elbow — screen ${measured.image?.toFixed(1)}°, 3D world ${measured.world?.toFixed(1)}°)`);

  const swapped = await cdp.eval(`(() => {
    const sel = document.querySelector('#angleModeSel');
    sel.value = 'world';
    sel.dispatchEvent(new Event('change'));
    const row = [...document.querySelectorAll('#angleReadout .line')]
      .find((l) => /Right elbow/.test(l.textContent));
    const shown = row ? parseFloat(row.lastChild.textContent) : null;
    sel.value = 'image';
    sel.dispatchEvent(new Event('change'));
    return { shown, note: document.querySelector('#angleModeNote').textContent };
  })()`);
  check('switching to 3D world changes the reading',
    Math.abs(swapped.shown - measured.world) < 0.06,
    `world mode shows ${swapped.shown}°`);

  const motion = await cdp.eval(`(() => {
    const speed = window.motionStudio.active.track.speedSeries();
    return { max: Math.max(...speed), n: speed.length };
  })()`);
  check('motion strip registers the movement', motion.max > 0, `peak ${motion.max.toFixed(3)}/s`);

  // --- 2c. focus scan on a clip locks onto what is actually visible -------
  const lock = await cdp.eval(`(() => {
    const ms = window.motionStudio;
    ms.el.focusTarget.value = 'body';
    ms.el.scanLenSel.value = '1.5';
    ms.setFrame(0);
    ms.startScan();                       // clips scan synchronously, no countdown
    const f = ms.state.focus;
    return {
      locked: f ? f.ids.size : 0,
      candidates: f ? f.candidates : 0,
      trails: ms.state.trails.size,
      label: f ? f.label : null,
      badge: document.querySelector('.clip-badge').textContent,
      readout: document.querySelector('#focusReadout').textContent,
      clearEnabled: !document.querySelector('#clearFocus').disabled,
      scanCleared: ms.state.scan === null,
    };
  })()`);
  check('clip scan locks onto the body', lock.locked >= 25, `${lock.locked}/${lock.candidates} points`);
  check('lock thins the trail set to something readable', lock.trails > 0 && lock.trails <= 12,
    `${lock.trails} trailed`);
  check('lock is reported in the badge', /locked/.test(lock.badge), lock.badge);
  check('focus readout fills in', /locked on/.test(lock.readout), lock.readout);
  check('clear button becomes available', lock.clearEnabled === true);
  check('scan state is cleaned up', lock.scanCleared === true);

  // a lock on one hand must not drag in the other side
  const handLock = await cdp.eval(`(() => {
    const ms = window.motionStudio;
    ms.el.focusTarget.value = 'right_hand';
    ms.setFrame(0);
    ms.startScan();
    const ids = [...(ms.state.focus?.ids ?? [])];
    return { ids, allRight: ids.every(id => id === 0 || id % 100 >= 0) };
  })()`);
  const sides = await cdp.eval(`(() => {
    const ids = [...(window.motionStudio.state.focus?.ids ?? [])];
    return ids.map(id => (id >= 200 ? 'right' : id >= 100 ? 'left' : null));
  })()`);
  check('right-hand lock stays on the right', handLock.ids.length > 0 && !sides.includes('left'),
    `${handLock.ids.length} points`);

  await cdp.eval(`window.motionStudio.clearFocus()`);
  const cleared = await cdp.eval(`({
    focus: window.motionStudio.state.focus,
    disabled: document.querySelector('#clearFocus').disabled,
    readout: document.querySelector('#focusReadout').textContent,
  })`);
  check('clearing the lock restores everything', cleared.focus === null && cleared.disabled === true
    && /No lock/.test(cleared.readout), cleared.readout);

  // Regression: switching between a still and a clip used to call
  // setOptions({runningMode}), which tears down the WebGL context and builds a
  // new one. That fails outright on some machines ("GLctx is undefined") and
  // creeps towards the browser's context cap on the rest.
  const gl = {
    created: consoleAll.filter((l) => /GL version:/i.test(l)).length,
    destroyed: consoleAll.filter((l) => /destroyed WebGL context/i.test(l)).length,
  };
  check('repeated analyses do not churn WebGL contexts',
    gl.destroyed === 0 && gl.created <= 1, `${gl.created} created, ${gl.destroyed} destroyed`);

  // --- 2d. finger tracking widens the pipeline ----------------------------
  await cdp.eval(`(() => {
    const chk = document.querySelector('#handsChk');
    chk.checked = true;
    chk.dispatchEvent(new Event('change'));
  })()`);
  await waitFor(async () => /frames ·|failed/.test(await status()), {
    label: 're-analysis with hands', timeout: 180000,
  });
  const withHands = await cdp.eval(`(() => {
    const { state, active } = window.motionStudio;
    const csv = active.track.toCSV([0, 1]).split('\\n');
    const anyHands = active.track.frames.some(f => f.hands);
    return {
      metaHands: active.track.meta.hands,
      cols: csv[0].split(',').length,
      hasHandCols: csv[0].includes('righthand_index_tip_x'),
      anyHands,
      tipChips: [...document.querySelectorAll('#trailChips .chip')].filter(c => /tip/.test(c.textContent)).length,
    };
  })()`);
  check('hand model is recorded in the track', withHands.metaHands === true);
  check('CSV widens to 75 points', withHands.cols === 2 + 75 * 4, `${withHands.cols} cols`);
  check('hand columns are named', withHands.hasHandCols === true);
  check('fingertip chips appear', withHands.tipChips === 10, `${withHands.tipChips} tip chips`);

  const fingerLock = await cdp.eval(`(() => {
    const ms = window.motionStudio;
    ms.el.focusTarget.value = 'fingertips';
    ms.setFrame(0);
    ms.startScan();
    return {
      candidates: ms.state.focus?.candidates ?? [...ms.state.trails].length,
      locked: ms.state.focus ? ms.state.focus.ids.size : 0,
      status: document.querySelector('#statusText').textContent,
    };
  })()`);
  check('fingertip target means real fingertips when the hand model is on',
    /found none|locked on/.test(fingerLock.status), fingerLock.status);

  // Real hands, end to end. The person clip shows no usable hands, so without
  // this the whole finger path was only ever proven to *run* — it was in fact
  // detecting 21 points per hand and then discarding every one of them at the
  // visibility filter, so nothing was ever drawn.
  await cdp.eval(`window.motionStudio.clearFocus()`);
  await makeClip('https://storage.googleapis.com/mediapipe-assets/right_hands.jpg', '__hands');
  await cdp.eval(`window.motionStudio.loadVideoFile(window.__hands)`);
  await cdp.eval(`window.motionStudio.idle()`);

  // Judge the clip by its best frame, not whichever one the playhead sits on:
  // the first frame of a canvas recording can be blank or half-painted
  // depending on the platform's encoder (it was on Linux CI), and one empty
  // frame says nothing about whether the finger pipeline works.
  const handsSeen = await cdp.eval(`(() => {
    const ms = window.motionStudio;
    const frames = ms.active.track.frames;
    const count = (f) => (f.hands ? Object.values(f.hands).reduce((n, h) => n + h.length, 0) : 0);
    let best = 0;
    frames.forEach((f, i) => { if (count(f) > count(frames[best])) best = i; });
    ms.setFrame(best);
    return { best, withHands: frames.filter((f) => count(f) > 0).length, total: frames.length };
  })()`);
  console.log(`         (hands found in ${handsSeen.withHands}/${handsSeen.total} frames; checking frame ${handsSeen.best + 1})`);
  await sleep(600); // let the seek land and the clip repaint before sampling pixels

  const handImage = await cdp.eval(`(async () => {
    const SK = await import('/js/skeleton.js');
    const ms = window.motionStudio;
    const f = ms.active.track.frames[ms.active.index];
    const sides = f.hands ? Object.keys(f.hands) : [];
    const pts = sides.flatMap((s) => f.hands[s]);
    const minVis = Number(ms.el.visRange.value);
    const tip = f.hands?.Right?.[8] ?? f.hands?.Left?.[8];
    return {
      sides,
      count: pts.length,
      minVisibility: pts.length ? Math.min(...pts.map((p) => p.visibility)) : -1,
      threshold: minVis,
      passFilter: pts.filter((p) => p.visibility >= minVis).length,
      tipInFrame: tip ? tip.x > 0 && tip.x < 1 && tip.y > 0 && tip.y < 1 : false,
    };
  })()`);
  check('hands detected in a real clip', handImage.count >= 21,
    `${handImage.sides.join(' + ') || 'none'}, ${handImage.count} points; hands in ${handsSeen.withHands}/${handsSeen.total} frames`);
  check('hand points survive the visibility filter',
    handImage.passFilter === handImage.count && handImage.count > 0,
    `${handImage.passFilter}/${handImage.count} above ${handImage.threshold} (min visibility ${handImage.minVisibility})`);
  check('fingertips land inside the frame', handImage.tipInFrame === true);

  // …and they actually reach the canvas.
  const handPixels = await cdp.eval(`(async () => {
    const SK = await import('/js/skeleton.js');
    const ms = window.motionStudio;
    const c = ms.active.el.canvas;
    const g = c.getContext('2d');
    const f = ms.active.track.view[ms.active.index];
    const tip = f.hands?.Right?.[8] ?? f.hands?.Left?.[8];
    if (!tip) return { drawn: false };
    const mirror = ms.el.mirrorChk.checked;
    const x = Math.round((mirror ? 1 - tip.x : tip.x) * c.width);
    const y = Math.round(tip.y * c.height);
    // Hand markers are deliberately small, so sample a generous neighbourhood.
    const r = Math.max(18, Math.round(c.width * 0.05));
    const left = Math.max(0, Math.min(c.width - 1, x - r));
    const top = Math.max(0, Math.min(c.height - 1, y - r));
    const w = Math.min(r * 2, c.width - left);
    const h = Math.min(r * 2, c.height - top);
    const d = g.getImageData(left, top, w, h).data;
    // the overlay is drawn in saturated colour; the photo underneath is not
    let marked = 0;
    for (let i = 0; i < d.length; i += 4) {
      const max = Math.max(d[i], d[i+1], d[i+2]);
      const min = Math.min(d[i], d[i+1], d[i+2]);
      if (max > 110 && max - min > 55) marked++;
    }
    return { drawn: true, marked, canvas: [c.width, c.height] };
  })()`);
  check('a fingertip marker is painted at the fingertip', handPixels.drawn && handPixels.marked > 4,
    `${handPixels.marked} overlay pixels near the index tip on ${handPixels.canvas?.join('x')}`);

  // back to the clip, so the hands-off re-analysis below has a video to work on
  await cdp.eval(`window.motionStudio.clearFocus()`);
  await cdp.eval(`window.motionStudio.loadVideoFile(window.__clip)`);
  await waitFor(async () => /frames ·|failed/.test(await status()),
    { label: 'clip reload', timeout: 180000 });

  await cdp.eval(`(() => {
    window.motionStudio.clearFocus();
    const chk = document.querySelector('#handsChk');
    chk.checked = false;
    chk.dispatchEvent(new Event('change'));
  })()`);
  await waitFor(async () => /frames ·|failed/.test(await status()), {
    label: 're-analysis without hands', timeout: 120000,
  });

  // --- 5. trimming, scrubbing, playback ----------------------------------
  const trim = await cdp.eval(`(() => {
    const { state, active, timeline, setFrame } = window.motionStudio;
    setFrame(5); timeline.markIn();
    setFrame(20); timeline.markOut();
    return { range: active.range, label: document.querySelector('.clip-trim').textContent };
  })()`);
  check('set in/out trims the range',
    trim.range[0] === 5 && trim.range[1] === 20, JSON.stringify(trim.range));
  check('trim label updates', /s →.*s \(.*frames\)/.test(trim.label), trim.label);

  await cdp.eval(`window.motionStudio.setFrame(12)`);
  await sleep(500);
  const scrub = await cdp.eval(`(() => {
    const { active } = window.motionStudio;
    return {
      index: active.index,
      requested: active.track.frames[12].t,
      drawn: active.track.frames[active.index].t,
      presented: active.presentedTime ?? -1,
      label: document.querySelector('.clip-time').textContent,
    };
  })()`);
  check('scrubbing seeks the video', Math.abs(scrub.presented - scrub.requested) < 0.1,
    `asked for ${scrub.requested.toFixed(3)}s, presenting ${scrub.presented.toFixed(3)}s`);
  // The point of the fix: the drawn frame is the one on screen, so the label
  // reports where the video actually is rather than where we aimed.
  check('the drawn frame is the frame on screen',
    Math.abs(scrub.drawn - scrub.presented) < 0.05,
    `drawing ${scrub.drawn.toFixed(3)}s, presenting ${scrub.presented.toFixed(3)}s`);
  check('time label tracks the drawn frame',
    scrub.label.includes(`frame ${scrub.index + 1}/`), scrub.label);

  await cdp.eval(`document.querySelector('.clip-play').click()`);
  await sleep(1200);
  const playing = await cdp.eval(`(() => {
    const { state, active } = window.motionStudio;
    return { playing: active.playing, index: active.index, within: active.index >= active.range[0] && active.index <= active.range[1] + 1 };
  })()`);
  check('playback runs', playing.playing === true);
  check('playback loops inside the trim', playing.within === true, `at frame ${playing.index}`);
  await cdp.eval(`document.querySelector('.clip-play').click()`);

  // --- 6. exports ---------------------------------------------------------
  const exports_ = await cdp.eval(`(() => {
    const { state, active } = window.motionStudio;
    const csv = active.track.toCSV(active.range);
    const json = active.track.toJSON(active.range);
    const rows = csv.trim().split('\\n');
    return {
      csvRows: rows.length,
      csvCols: rows[0].split(',').length,
      jsonFrames: json.frames.length,
      expected: active.range[1] - active.range[0] + 1,
      pngEnabled: !document.querySelector('#exportPng').disabled,
    };
  })()`);
  check('CSV covers exactly the trim', exports_.csvRows === exports_.expected + 1,
    `${exports_.csvRows - 1} rows vs ${exports_.expected} frames`);
  check('CSV has a column per landmark axis', exports_.csvCols === 2 + 33 * 4, `${exports_.csvCols} cols`);
  check('JSON covers exactly the trim', exports_.jsonFrames === exports_.expected);
  check('export buttons enabled', exports_.pngEnabled === true);

  // --- 7. display toggles do not blow up ---------------------------------
  const toggles = await cdp.eval(`(() => {
    const q = s => document.querySelector(s);
    q('#opacityRange').value = 0; q('#opacityRange').dispatchEvent(new Event('input'));
    q('#strobeRange').value = 4;  q('#strobeRange').dispatchEvent(new Event('input'));
    q('#labelsChk').checked = true; q('#labelsChk').dispatchEvent(new Event('input'));
    q('#smoothRange').value = 0.8; q('#smoothRange').dispatchEvent(new Event('input'));
    for (const chip of q('#trailChips').children) chip.click();
    return { strobe: q('#strobeVal').textContent, opacity: q('#opacityVal').textContent,
             smoothing: window.motionStudio.active.track.smoothing,
             trails: window.motionStudio.state.trails.size };
  })()`);
  await sleep(600);
  check('onion-skin label updates', toggles.strobe === 'every 4 frames', toggles.strobe);
  check('opacity label updates', toggles.opacity === '0%', toggles.opacity);
  check('smoothing applies to the track', Math.abs(toggles.smoothing - 0.8) < 1e-9, `${toggles.smoothing}`);
  check('trail chips toggle', toggles.trails > 0, `${toggles.trails} trailed joints`);

  const pointsOnly = await cdp.eval(`(() => {
    const c = document.querySelector('.clip-view');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i+1] + d[i+2] > 120) lit++;
    return lit;
  })()`);
  check('points-only mode still renders (footage hidden)', pointsOnly >= 0, `${pointsOnly} lit px`);

  // --- 8. video: frame stepping, side by side, crop, rescan --------------
  await cdp.eval(`window.motionStudio.loadVideoFile(window.__clip)`);
  await waitFor(async () => /frames ·|failed/.test(await status()),
    { label: 'clip reload for video tests', timeout: 180000 });

  // Stepping used to move the overlay while the picture stayed put, because the
  // drawn index was updated at request time and derived from currentTime — which
  // sits a whole frame away from the frame actually presented.
  const stepping = await cdp.eval(`(async () => {
    const c = window.motionStudio.clipA;
    c.setFrame(20);
    await new Promise(r => setTimeout(r, 400));
    const steps = [];
    for (let n = 0; n < 4; n++) {
      const before = c.index;
      await c.step(-1);
      await new Promise(r => setTimeout(r, 250));
      steps.push({
        moved: before !== c.index,
        backwards: c.index < before,
        drawn: c.track.frames[c.index].t,
        presented: c.presentedTime ?? -99,
      });
    }
    return {
      steps,
      uniqueTimes: new Set(c.track.frames.map(f => f.t)).size,
      frames: c.track.length,
    };
  })()`);
  check('every step moves the picture', stepping.steps.every((s) => s.moved && s.backwards),
    stepping.steps.map((s) => (s.moved ? 'moved' : 'STUCK')).join(', '));
  check('the overlay always matches the presented frame',
    stepping.steps.every((s) => Math.abs(s.drawn - s.presented) < 0.05),
    stepping.steps.map((s) => `${(s.drawn - s.presented).toFixed(3)}s`).join(', '));
  check('analysis records distinct decoded frames, not duplicates',
    stepping.uniqueTimes === stepping.frames,
    `${stepping.uniqueTimes} unique of ${stepping.frames}`);

  // Second upload -> two clips, each with its own timeline.
  await cdp.eval(`window.motionStudio.loadCompare(window.__clip)`);
  await waitFor(async () => /B: \d+ frames|failed/.test(await status()),
    { label: 'compare clip analysis', timeout: 180000 });

  const compare = await cdp.eval(`(() => {
    const ms = window.motionStudio;
    return {
      clips: ms.clips.length,
      grid: document.querySelector('#clips').classList.contains('is-compare'),
      timelines: document.querySelectorAll('.clip-timeline').length,
      canvases: document.querySelectorAll('.clip-view').length,
      aFrames: ms.clipA.track?.length ?? 0,
      bFrames: ms.clipB?.track?.length ?? 0,
      separateTracks: ms.clipA.track !== ms.clipB?.track,
      active: ms.active?.tag,
      globalShown: !document.querySelector('#globalTransport').hidden,
    };
  })()`);
  check('a second upload opens a second clip', compare.clips === 2 && compare.grid === true);
  check('each clip has its own timeline and canvas',
    compare.timelines === 2 && compare.canvases === 2,
    `${compare.timelines} timelines, ${compare.canvases} canvases`);
  check('the two clips hold separate tracks',
    compare.separateTracks && compare.aFrames > 0 && compare.bFrames > 0,
    `A ${compare.aFrames} frames, B ${compare.bFrames}`);
  check('the second upload becomes active', compare.active === 'B');
  check('play-both appears only in compare mode', compare.globalShown === true);

  // Independent trims prove the timelines really are separate.
  const trims = await cdp.eval(`(() => {
    const ms = window.motionStudio;
    ms.clipA.timeline.setRange(2, 9);
    ms.clipB.timeline.setRange(15, 30);
    return { a: ms.clipA.range, b: ms.clipB.range };
  })()`);
  check('each clip trims independently',
    trims.a[0] === 2 && trims.a[1] === 9 && trims.b[0] === 15 && trims.b[1] === 30,
    `A ${JSON.stringify(trims.a)}, B ${JSON.stringify(trims.b)}`);

  await cdp.eval(`document.querySelector('#playBoth').click()`);
  await sleep(900);
  const both = await cdp.eval(`({
    a: window.motionStudio.clipA.playing,
    b: window.motionStudio.clipB.playing,
    label: document.querySelector('#playBoth').textContent,
  })`);
  check('play both starts both clips', both.a === true && both.b === true);
  check('play both flips to pause', /pause/i.test(both.label), both.label);
  await cdp.eval(`document.querySelector('#playBoth').click()`);

  // Crop: the view narrows and the landmarks travel with it.
  const crop = await cdp.eval(`(async () => {
    const SK = await import('/js/skeleton.js');
    const ms = window.motionStudio;
    ms.setActiveClip(ms.clipA);
    const c = ms.clipA;
    const before = [c.el.canvas.width, c.el.canvas.height];
    c.setSelection({ x: 0.25, y: 0.1, w: 0.5, h: 0.8 });
    document.querySelector('#applyCrop').click();
    await new Promise(r => setTimeout(r, 250));
    const f = c.track.view[c.index];
    const src = c.viewSource();
    const nose = f?.pose?.[0];
    const expected = (c.track.meta.width * 0.5) / (c.track.meta.height * 0.8);
    return {
      before,
      after: [c.el.canvas.width, c.el.canvas.height],
      crop: c.crop,
      ratioOk: Math.abs(c.el.canvas.width / c.el.canvas.height - expected) < 0.03,
      noseInView: nose
        ? { u: (nose.x - src.x) / src.w, v: (nose.y - src.y) / src.h }
        : null,
      trimLabel: document.querySelector('.clip-trim').textContent,
    };
  })()`);
  check('cropping shrinks the canvas', crop.after[0] < crop.before[0] && crop.after[1] < crop.before[1],
    `${crop.before.join('x')} -> ${crop.after.join('x')}`);
  check('the cropped canvas keeps the crop’s aspect ratio', crop.ratioOk === true);
  check('landmarks follow the crop',
    crop.noseInView !== null && crop.noseInView.u > 0 && crop.noseInView.u < 1
      && crop.noseInView.v > 0 && crop.noseInView.v < 1,
    crop.noseInView ? `nose at ${crop.noseInView.u.toFixed(2)}, ${crop.noseInView.v.toFixed(2)}` : 'no pose');
  check('the crop is reported in the clip label', /crop \d+×\d+%/.test(crop.trimLabel), crop.trimLabel);

  await cdp.eval(`document.querySelector('#clearCrop').click()`);
  const uncropped = await cdp.eval(`({ crop: window.motionStudio.clipA.crop })`);
  check('uncrop restores the full frame', uncropped.crop === null);

  // Rescan: only the box in space, only the trim in time, and it must replace
  // just those frames rather than reprocessing (and discarding) the whole clip.
  const before = await cdp.eval(`(() => {
    const ms = window.motionStudio;
    const c = ms.clipA;
    c.timeline.setRange(10, 25);
    c.setSelection({ x: 0.2, y: 0.05, w: 0.6, h: 0.9 });
    const boost = document.querySelector('#boostRange');
    boost.value = '1.4';
    boost.dispatchEvent(new Event('input'));
    document.querySelector('#rescanModelSel').value = 'lite';
    // Fingerprint the frames outside the trim so we can prove they survive.
    const outside = c.track.frames
      .filter((f) => f.t < c.rangeTimes()[0] - 1e-6 || f.t > c.rangeTimes()[1] + 1e-6)
      .map((f) => (f.pose ? f.pose[0].x.toFixed(6) : 'null'));
    return {
      total: c.track.length,
      window: c.rangeTimes(),
      rangeIdx: c.range,
      outsideCount: outside.length,
      outsideHash: outside.join('|'),
      duration: c.track.duration,
    };
  })()`);

  await cdp.eval(`document.querySelector('#rescanBtn').click()`);
  await waitFor(async () => /rescanned|failed/.test(await status()),
    { label: 'region rescan', timeout: 180000 });
  const rescanStatus = await status();

  const rescan = await cdp.eval(`(() => {
    const ms = window.motionStudio;
    const c = ms.clipA;
    const t = c.track;
    const [w0, w1] = ${JSON.stringify(before.window)};
    const inWindow = t.frames.filter((f) => f.t >= w0 - 1e-6 && f.t <= w1 + 1e-6);
    const outside = t.frames
      .filter((f) => f.t < w0 - 1e-6 || f.t > w1 + 1e-6)
      .map((f) => (f.pose ? f.pose[0].x.toFixed(6) : 'null'));
    const inRange = t.frames.every((f) => !f.pose
      || f.pose.every((p) => p.x > -0.3 && p.x < 1.3 && p.y > -0.3 && p.y < 1.3));
    const monotonic = t.frames.every((f, i) => i === 0 || f.t >= t.frames[i - 1].t);
    return {
      total: t.length,
      duration: t.duration,
      inWindowCount: inWindow.length,
      outsideCount: outside.length,
      outsideHash: outside.join('|'),
      rescans: t.meta.rescans ?? null,
      trackedInWindow: inWindow.filter((f) => f.pose).length,
      inRange,
      monotonic,
      rangeIdx: c.range,
      rangeTimes: c.rangeTimes(),
      boostLabel: document.querySelector('#boostVal').textContent,
    };
  })()`);

  check('rescan stays inside the trimmed range',
    rescan.rescans?.length === 1
      && Math.abs(rescan.rescans[0].from - before.window[0]) < 1e-6
      && Math.abs(rescan.rescans[0].to - before.window[1]) < 1e-6,
    `recorded ${JSON.stringify(rescan.rescans?.[0] && [rescan.rescans[0].from, rescan.rescans[0].to])}, trim was ${JSON.stringify(before.window)}`);
  check('rescan reports the window it covered', /rescanned \d+ frames of [\d.]+–[\d.]+s/.test(rescanStatus),
    rescanStatus);
  check('rescan processed far fewer frames than the whole clip',
    rescan.rescans[0] && rescan.inWindowCount < before.total * 0.6,
    `${rescan.inWindowCount} in window vs ${before.total} in the clip`);
  check('frames outside the trim are left untouched',
    rescan.outsideHash === before.outsideHash && rescan.outsideCount === before.outsideCount,
    `${rescan.outsideCount} outside frames, identical: ${rescan.outsideHash === before.outsideHash}`);
  check('the clip keeps its full length after a partial rescan',
    Math.abs(rescan.duration - before.duration) < 0.05,
    `${before.duration.toFixed(2)}s -> ${rescan.duration.toFixed(2)}s`);
  check('the track stays ordered in time', rescan.monotonic === true);
  check('the trim survives the rescan',
    Math.abs(rescan.rangeTimes[0] - before.window[0]) < 0.05
      && Math.abs(rescan.rangeTimes[1] - before.window[1]) < 0.05,
    `${JSON.stringify(rescan.rangeTimes)} vs ${JSON.stringify(before.window)}`);
  check('rescan honours the per-rescan model override',
    rescan.rescans[0].model === 'lite', rescan.rescans[0].model);
  check('rescan records the region and exposure it used',
    Math.abs(rescan.rescans[0].region.w - 0.6) < 1e-6
      && Math.abs(rescan.rescans[0].boost - 1.4) < 1e-6,
    `${JSON.stringify(rescan.rescans[0].region)}, boost ${rescan.rescans[0].boost} (${rescan.boostLabel})`);
  check('rescan still detects the subject in the window',
    rescan.trackedInWindow > rescan.inWindowCount * 0.8,
    `${rescan.trackedInWindow}/${rescan.inWindowCount} frames`);
  check('rescanned landmarks map back to full-frame coordinates', rescan.inRange === true);

  // --- 8b. left/right swap correction ------------------------------------
  // A clean track must never be "corrected" — a false positive would silently
  // corrupt good data, which is worse than the bug.
  const cleanPass = await cdp.eval(`(async () => {
    const SIDES = await import('/js/sides.js');
    const r = SIDES.detectSideFlips(window.motionStudio.clipB.track);
    return { segments: r.segments.length, frames: window.motionStudio.clipB.track.length };
  })()`);
  check('a clean clip is left alone', cleanPass.segments === 0,
    `${cleanPass.segments} runs flagged across ${cleanPass.frames} frames`);

  // The model labels limbs anatomically and can swap left for right mid-clip
  // (a rotating server does it reliably). Inject that into a real track and
  // check the app puts it back, reversibly, without touching anything else.
  //
  // Clip B, not A: A's frames 10-25 were just replaced by a rescan with a
  // different model inside a brightened box, so a run injected there would
  // straddle a seam between two models' outputs — and whether the joints
  // "moved" across that seam depends on how much the two models happen to
  // disagree on a given machine. It passed on Windows and failed on Linux CI.
  // B is one model's track end to end, so the only discontinuity is the
  // injected one.
  const sideFix = await cdp.eval(`(async () => {
    const SIDES = await import('/js/sides.js');
    const SK = await import('/js/skeleton.js');
    const ms = window.motionStudio;
    ms.setActiveClip(ms.clipB);
    const c = ms.clipB;

    // start from the app's own corrected track
    const raw = c.track.frames.map((f) => f.pose ? f.pose[SK.L.RIGHT_WRIST].x : null);
    const from = 12, to = 26;
    for (let i = from; i <= to; i++) {
      if (c.track.frames[i].pose) SIDES.swapSides(c.track.frames[i]);
      delete c.track.frames[i].sideFlipped;
    }
    const broken = c.track.frames.map((f) => f.pose ? f.pose[SK.L.RIGHT_WRIST].x : null);
    const changedByInjection = broken.filter((v, i) => v !== raw[i]).length;

    const result = SIDES.correctSideFlips(c.track);
    c.refreshTrack({ smoothing: Number(ms.el.smoothRange.value) });
    const repaired = c.track.frames.map((f) => f.pose ? f.pose[SK.L.RIGHT_WRIST].x : null);

    return {
      changedByInjection,
      corrected: result.corrected,
      segments: result.segments.map((s) => [s.from, s.to]),
      identical: repaired.every((v, i) => v === raw[i]),
      stillWrong: repaired.filter((v, i) => v !== raw[i]).length,
      marks: c.timeline.marks.length,
      note: document.querySelector('#sidesNote').textContent,
    };
  })()`);
  check('an injected left/right swap is detected',
    sideFix.segments.length === 1 && sideFix.segments[0][0] === 12 && sideFix.segments[0][1] === 26,
    `found ${JSON.stringify(sideFix.segments)}`);
  check('the swap is repaired exactly', sideFix.identical === true,
    `${sideFix.stillWrong} of ${sideFix.changedByInjection} injected frames still wrong`);
  check('corrected runs are flagged on the timeline', sideFix.marks === 1, `${sideFix.marks} marks`);

  // Turning the correction off must restore the model's own labels, not
  // half-apply the fix.
  const roundTrip = await cdp.eval(`(async () => {
    const SK = await import('/js/skeleton.js');
    const ms = window.motionStudio;
    const c = ms.clipB;
    const corrected = c.track.frames.map((f) => f.pose ? f.pose[SK.L.RIGHT_WRIST].x : null);
    const chk = document.querySelector('#fixSidesChk');

    chk.checked = false; chk.dispatchEvent(new Event('change'));
    const off = c.track.frames.map((f) => f.pose ? f.pose[SK.L.RIGHT_WRIST].x : null);
    const offNote = document.querySelector('#sidesNote').textContent;
    const offMarks = c.timeline.marks.length;

    chk.checked = true; chk.dispatchEvent(new Event('change'));
    const back = c.track.frames.map((f) => f.pose ? f.pose[SK.L.RIGHT_WRIST].x : null);

    return {
      offDiffers: off.filter((v, i) => v !== corrected[i]).length,
      backIdentical: back.every((v, i) => v === corrected[i]),
      offNote,
      offMarks,
      marksAfter: c.timeline.marks.length,
    };
  })()`);
  check('switching the fix off restores the raw labels', roundTrip.offDiffers > 0,
    `${roundTrip.offDiffers} frames reverted`);
  check('switching it back on is lossless', roundTrip.backIdentical === true);
  check('the panel says when correction is off', /Off —/.test(roundTrip.offNote), roundTrip.offNote);
  check('timeline flags clear when correction is off', roundTrip.offMarks === 0,
    `${roundTrip.offMarks} marks while off`);

  // --- 8c. exporting the cropped, trimmed clip as video -------------------
  const exported = await cdp.eval(`(async () => {
    const { exportClipVideo } = await import('/js/export-video.js');
    const ms = window.motionStudio;
    ms.setActiveClip(ms.clipA);
    const c = ms.clipA;
    c.setSelection({ x: 0.25, y: 0.15, w: 0.5, h: 0.6 });
    document.querySelector('#applyCrop').click();
    c.timeline.setRange(5, 20);
    const [t0, t1] = c.rangeTimes();

    const progress = [];
    const out = await exportClipVideo(c, {
      overlay: false,
      getOptions: () => ({ mirror: false, videoOpacity: 1 }),
      onProgress: (f) => progress.push(f),
    });

    // Play it back to prove the file is real and decodable.
    const v = document.createElement('video');
    v.muted = true;
    v.src = URL.createObjectURL(out.blob);
    await new Promise((res, rej) => {
      v.onloadedmetadata = res;
      v.onerror = () => rej(new Error('exported file will not decode'));
      setTimeout(res, 5000);
    });
    if (!Number.isFinite(v.duration)) {
      await new Promise((res) => { v.ondurationchange = () => Number.isFinite(v.duration) && res(); v.currentTime = 1e101; setTimeout(res, 3000); });
    }
    return {
      bytes: out.blob.size,
      type: out.blob.type,
      width: out.width,
      height: out.height,
      requested: Number((t1 - t0).toFixed(2)),
      reported: Number(out.seconds.toFixed(2)),
      decodedW: v.videoWidth,
      decodedH: v.videoHeight,
      decodedDuration: Number.isFinite(v.duration) ? Number(v.duration.toFixed(2)) : null,
      progressed: progress.length > 3 && progress.at(-1) > 0.5,
      sourceRatio: (c.track.meta.width * 0.5) / (c.track.meta.height * 0.6),
    };
  })()`);
  check('the export produces a real file', exported.bytes > 5000 && /video\//.test(exported.type),
    `${(exported.bytes / 1000).toFixed(0)} KB of ${exported.type}`);
  check('the exported file decodes', exported.decodedW > 0 && exported.decodedH > 0,
    `${exported.decodedW}x${exported.decodedH}`);
  check('the export is cropped to the box', exported.decodedW === exported.width
    && exported.decodedH === exported.height
    && Math.abs(exported.width / exported.height - exported.sourceRatio) < 0.05,
    `${exported.width}x${exported.height}, crop ratio ${exported.sourceRatio.toFixed(3)}`);
  check('the export covers the trimmed range at source timing',
    exported.decodedDuration === null
      || Math.abs(exported.decodedDuration - exported.requested) < 0.35,
    `asked ${exported.requested}s, file is ${exported.decodedDuration}s`);
  check('export reports progress', exported.progressed === true);

  await cdp.eval(`document.querySelector('#clearCrop').click()`);

  await cdp.eval(`window.motionStudio.closeCompare()`);
  const closed = await cdp.eval(`({
    clips: window.motionStudio.clips.length,
    grid: document.querySelector('#clips').classList.contains('is-compare'),
    globalHidden: document.querySelector('#globalTransport').hidden,
  })`);
  check('closing B returns to a single clip',
    closed.clips === 1 && closed.grid === false && closed.globalHidden === true);
  await hiddenAudit('after compare');

  check('no errors in the console', consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | '));
}

try {
  await main();
} catch (err) {
  console.error(`\n  ERROR  ${err.message}`);
  failures.push(err.message);
} finally {
  for (const fn of cleanup) {
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
}

console.log(failures.length ? `\n${failures.length} check(s) failed.` : '\nAll smoke checks passed.');
process.exit(failures.length ? 1 : 0);
