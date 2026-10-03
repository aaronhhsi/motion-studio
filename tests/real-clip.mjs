// Regression test against real footage: a volleyball jump serve where the pose
// model exchanges left for right several times. Synthetic fixtures cannot
// reproduce this — the first attempt at a fix passed every synthetic test and
// still mangled this clip — so the real file is the test.
//
// Skips cleanly if the clip is not present.
//
//   node tests/real-clip.mjs

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLIPS = ['darlansouzaserve.mp4', 'darlansouzaserve-crop.webm'];
const PORT = 5232;

const BROWSERS = [
  join(process.env['ProgramFiles'] ?? '', 'Google/Chrome/Application/chrome.exe'),
  join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft/Edge/Application/msedge.exe'),
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const failures = [];
const cleanup = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

async function waitFor(fn, { timeout = 60000, interval = 500, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(interval);
  }
}

async function main() {
  const present = CLIPS.filter((c) => existsSync(join(ROOT, c)));
  if (!present.length) {
    console.log(`none of ${CLIPS.join(', ')} present — skipping the real-footage test.`);
    return;
  }
  const browser = BROWSERS.find((p) => p && existsSync(p));
  if (!browser) {
    console.log('No Chrome/Edge found — skipping.');
    return;
  }

  const server = spawn(process.execPath, [join(ROOT, 'scripts/serve.mjs')], {
    env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore',
  });
  cleanup.push(() => server.kill());
  await waitFor(() => fetch(`http://localhost:${PORT}/index.html`).then((r) => r.ok).catch(() => false),
    { label: 'server', timeout: 10000 });

  const profile = mkdtempSync(join(tmpdir(), 'motion-studio-clip-'));
  cleanup.push(() => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* held */ } });

  const chrome = spawn(browser, [
    '--headless=new', '--remote-debugging-port=9392', `--user-data-dir=${profile}`,
    '--no-first-run', '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-swiftshader', `http://localhost:${PORT}/index.html`,
  ], { stdio: 'ignore' });
  cleanup.push(() => chrome.kill());

  const target = await waitFor(async () => {
    try {
      const list = await (await fetch('http://localhost:9392/json/list')).json();
      return list.find((t) => t.type === 'page' && t.url.includes(String(PORT)));
    } catch { return null; }
  }, { label: 'devtools target', timeout: 20000 });

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(String(m.params.exceptionDetails.exception?.description).slice(0, 200));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.description ?? a.value).join(' ').slice(0, 200));
    }
  });
  const send = (method, params = {}) => new Promise((res) => {
    pending.set(++id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) {
      throw new Error(String(r.result.exceptionDetails.exception?.description).slice(0, 400));
    }
    return r.result.result.value;
  };
  await send('Runtime.enable');

  const status = () => evaluate(`document.querySelector('#statusText').textContent`);
  await waitFor(async () => /ready|failed|could not/.test(await status()), { label: 'model load', timeout: 120000 });

  const perClip = [];
  for (const clip of present) {
    console.log(`
analysing ${clip} (this takes a couple of minutes)…`);
    await evaluate(`(async () => {
      const blob = await (await fetch('/${clip}')).blob();
      await window.motionStudio.loadVideoFile(new File([blob], '${clip}', { type: blob.type || 'video/mp4' }));
    })()`);
    await evaluate(`window.motionStudio.idle()`);
    console.log(`  ${await status()}`);

    const r = await evaluate(`(async () => {
      const S = await import('/js/sides.js');
      const t = window.motionStudio.clipA.track;
      const a = t.aspect;
      // The side the labelled-right shoulder sits on, per measurable frame.
      const sides = () => {
        const out = [];
        for (const f of t.frames) {
          if (!f.pose) continue;
          const s = S.separation(f.pose, a);
          if (s === null || Math.abs(s) > S.DEFAULTS.maxPlausible) continue;
          out.push(Math.sign(s));
        }
        return out;
      };
      // Flicker = a side change that reverses again within five frames.
      const count = (xs) => {
        let flips = 0, changes = 0;
        for (let k = 1; k < xs.length; k++) {
          if (xs[k] === xs[k - 1]) continue;
          changes++;
          for (let m = k + 1; m < Math.min(xs.length, k + 6); m++) {
            if (xs[m] === xs[k - 1]) { flips++; break; }
          }
        }
        return { flips, changes };
      };
      const fixed = count(sides());
      S.undoSideFlips(t);
      const raw = count(sides());
      S.correctSideFlips(t);
      return {
        frames: t.length,
        tracked: t.frames.filter((f) => f.pose).length,
        size: t.meta.width + 'x' + t.meta.height,
        events: (t.meta.sideFlipEvents ?? []).map((e) => ({
          t: Number(e.t.toFixed(2)), gap: e.gap, before: e.before, after: e.after,
          reason: e.reason, ratio: e.ratio,
        })),
        passes: t.meta.sidePasses,
        swapRatio: S.DEFAULTS.swapRatio,
        nearProfile: S.DEFAULTS.nearProfile,
        runs: (t.meta.sideFlips ?? []).length,
        remaining: S.countImpossibleJumps(t),
        marks: window.motionStudio.clipA.timeline.marks.length,
        note: document.querySelector('#sidesNote').textContent,
        raw, fixed,
        maxGap: S.DEFAULTS.maxGap,
      };
    })()`);
    perClip.push({ clip, ...r });

    check(`${clip}: analyses`, r.frames > 400 && r.tracked > 300,
      `${r.tracked}/${r.frames} tracked at ${r.size}`);
    check(`${clip}: finds the left/right exchanges`, r.events.length >= 1,
      `${r.events.length} at ${r.events.map((e) => e.t + 's').join(', ')}`);
    // Not "one frame" — the contract is that it happened faster than a body
    // could rotate through profile, which is what `maxGap` encodes.
    check(`${clip}: every exchange is too fast to be a real turn`,
      r.events.every((e) => e.gap <= r.maxGap),
      `largest gap ${Math.max(...r.events.map((e) => e.gap), 0)}s, limit ${r.maxGap}s`);
    // Each exchange must be justified by one of the two rules, not by a
    // threshold that happens to fit this clip: either the joints demonstrably
    // did not move, or (when too few were visible to tell) the separation
    // jumped clear across profile, which no body can do.
    // Events fire in both directions — starting a correction and ending one —
    // so the test is that the limb comparison was *decisive* either way, not
    // that it always favoured swapping.
    check(`${clip}: every exchange is justified`, r.events.every((e) => (
      e.reason === 'joints did not move'
        ? e.ratio !== null && (e.ratio < r.swapRatio || e.ratio > 1 / r.swapRatio)
        : Math.abs(e.before) >= r.nearProfile && Math.abs(e.after) >= r.nearProfile
          && Math.sign(e.before) !== Math.sign(e.after)
    )), r.events.map((e) => (e.ratio === null ? 'geometry' : e.ratio)).join(', '));
    check(`${clip}: no exchanges remain`, r.remaining === 0, `${r.remaining} left`);
    check(`${clip}: the raw footage really does flicker`, r.raw.flips >= 5,
      `${r.raw.flips} flickers in ${r.raw.changes} side changes`);
    // The symptom people actually report.
    check(`${clip}: flicker is gone`, r.fixed.flips === 0,
      `${r.raw.flips} -> ${r.fixed.flips}`);
    // An earlier version asserted "genuine turns survive" here. That was an
    // assumption, not a measurement: comparing limb motion across each boundary
    // showed every remaining change was a relabelling, not a turn. The real
    // property is that almost nothing is left to see.
    check(`${clip}: side changes reduced to at most one`, r.fixed.changes <= 1,
      `${r.raw.changes} -> ${r.fixed.changes}`);
    check(`${clip}: corrected runs are flagged on the timeline`,
      r.marks === r.runs, `${r.marks} marks for ${r.runs} runs`);
  }

  // The strongest check available without hand-labelling every frame: the same
  // serve in two very different encodings must agree on how many times the
  // player genuinely turns. Over-correcting flattens real turns; under-
  // correcting adds spurious ones. Either way the two would disagree.
  if (perClip.length === 2) {
    const [a, b] = perClip;
    // Two very different encodings of one action must land in the same place.
    // Exact equality is too strict — a marginal boundary can fall either way —
    // but they must not disagree by more than one.
    check('both encodings end up in the same place',
      Math.abs(a.fixed.changes - b.fixed.changes) <= 1
        && a.fixed.changes <= 1 && b.fixed.changes <= 1,
      `${a.clip}: ${a.fixed.changes}, ${b.clip}: ${b.fixed.changes}`);
    check('both encodings end up flicker-free',
      a.fixed.flips === 0 && b.fixed.flips === 0);
  }

  // ---- the YOLO backend, on the pose that breaks BlazePose ------------------
  // Through the wind-up (5.6-6.9s) the player is airborne with both arms
  // overhead, and every BlazePose size slides his shoulders onto his sternum
  // for part of it: separation swings 0.009-0.072 frame to frame, with 21
  // frames of the clip collapsed below 0.01. His real width, measured straight
  // off the jersey pixels, is 0.1035 at the shoulder band and 0.0913 at the
  // waist, which puts the joint centres near 0.08. These numbers are the
  // reason the model exists as an option, so they are what gets asserted.
  const yoloClip = 'darlansouzaserve-crop.webm';
  if (present.includes(yoloClip)) {
    console.log(`\nanalysing ${yoloClip} with YOLO (downloads ~65 MB the first time)…`);
    await evaluate(`(async () => {
      const { ensureLandmarker } = await import('/js/landmarker.js');
      window.motionStudio.el.modelSel.value = 'yolo';
      await ensureLandmarker({ model: 'yolo' });
    })()`);
    await evaluate(`(async () => {
      const blob = await (await fetch('/${yoloClip}')).blob();
      await window.motionStudio.loadVideoFile(new File([blob], '${yoloClip}', { type: blob.type || 'video/webm' }));
    })()`);
    await evaluate(`window.motionStudio.idle()`);
    console.log(`  ${await status()}`);

    const y = await evaluate(`(async () => {
      const { PROVIDED_IDS } = await import('/js/yolo.js');
      const { currentDelegate } = await import('/js/landmarker.js');
      const t = window.motionStudio.clipA.track;
      const A = t.aspect;
      const W = (f, a, b) => (f.pose && f.pose[a].visibility > 0.4 && f.pose[b].visibility > 0.4
        ? Math.hypot((f.pose[a].x - f.pose[b].x) * A, f.pose[a].y - f.pose[b].y) : null);
      const win = t.frames.filter((f) => f.t >= 5.6 && f.t <= 6.9).map((f) => W(f, 11, 12));
      const all = t.frames.map((f) => W(f, 11, 12)).filter((v) => v != null);
      return {
        provider: currentDelegate(),
        frames: t.length,
        tracked: t.frames.filter((f) => f.pose).length,
        windupMin: Math.min(...win.filter((v) => v != null)),
        windupN: win.filter((v) => v != null).length,
        collapsed: all.filter((v) => v < 0.01).length,
        providedCount: PROVIDED_IDS.size,
        // every COCO point must arrive, every other id must stay empty
        filled: t.frames.find((f) => f.pose).pose
          .map((p, i) => (p.visibility > 0 ? i : -1)).filter((i) => i >= 0).join(','),
      };
    })()`);

    check(`${yoloClip} / yolo: runs and tracks every frame`,
      y.tracked === y.frames && y.frames > 400, `${y.tracked}/${y.frames} on ${y.provider}`);
    check(`${yoloClip} / yolo: the torso never collapses`, y.collapsed === 0,
      `${y.collapsed} frames under 0.01 (BlazePose: 21)`);
    // The property that matters: through the wind-up the shoulders stay near
    // the measured 0.08 rather than dipping toward the midline.
    check(`${yoloClip} / yolo: shoulders hold through the wind-up`,
      y.windupMin > 0.05, `narrowest of ${y.windupN} frames was ${y.windupMin.toFixed(4)}, want > 0.05`);
    check(`${yoloClip} / yolo: fills exactly the 17 COCO ids`,
      y.filled === '0,2,5,7,8,11,12,13,14,15,16,23,24,25,26,27,28' && y.providedCount === 17,
      y.filled);
  }

  check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
}

try {
  await main();
} catch (err) {
  console.error(`\n  ERROR  ${err.message}`);
  failures.push(err.message);
} finally {
  for (const fn of cleanup) { try { fn(); } catch { /* best effort */ } }
}

console.log(failures.length ? `\n${failures.length} check(s) failed.` : '\nAll real-footage checks passed.');
process.exit(failures.length ? 1 : 0);
