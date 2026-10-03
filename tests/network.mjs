// Privacy audit: proves that footage never leaves the machine.
//
// Records every network request the page makes, then runs a lot of inference —
// a full frame-by-frame video analysis — and asserts that inference adds no
// traffic at all. The only requests allowed are the app's own files and the
// one-off MediaPipe runtime + model download.
//
//   node tests/network.mjs

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 5208;

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

async function waitFor(fn, { timeout = 60000, interval = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(interval);
  }
}

async function main() {
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

  const profile = mkdtempSync(join(tmpdir(), 'motion-studio-net-'));
  cleanup.push(() => { try { rmSync(profile, { recursive: true, force: true }); } catch {} });

  const chrome = spawn(browser, [
    '--headless=new', '--remote-debugging-port=9360', `--user-data-dir=${profile}`,
    '--no-first-run',
    '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader',
    'about:blank',
  ], { stdio: 'ignore' });
  cleanup.push(() => chrome.kill());

  const target = await waitFor(async () => {
    try {
      const list = await (await fetch('http://localhost:9360/json/list')).json();
      return list.find((t) => t.type === 'page');
    } catch { return null; }
  }, { label: 'devtools target', timeout: 20000 });

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  const requests = [];
  const sockets = [];

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === 'Network.requestWillBeSent') {
      requests.push({
        url: m.params.request.url,
        method: m.params.request.method,
        bytes: m.params.request.postData?.length ?? 0,
        at: Date.now(),
      });
    }
    if (m.method === 'Network.webSocketCreated') sockets.push(m.params.url);
  });
  const send = (method, params = {}) => new Promise((res) => {
    pending.set(++id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Network.enable');
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `http://localhost:${PORT}/index.html` });

  const status = () => evaluate(`document.querySelector('#statusText').textContent`);
  await waitFor(async () => /ready|failed|could not/.test(await status()), { label: 'model load', timeout: 120000 });
  check('app loaded', (await status()).startsWith('ready'), await status());

  // Everything up to here is startup: the app's own files plus the model.
  const startup = requests.length;
  const hosts = [...new Set(requests.map((r) => new URL(r.url).host))].sort();
  console.log('\n  startup traffic:');
  for (const host of hosts) {
    const n = requests.filter((r) => new URL(r.url).host === host).length;
    console.log(`    ${String(n).padStart(3)} × ${host}`);
  }
  console.log();

  check('startup contacts only localhost and the model hosts',
    hosts.every((h) => /^localhost:|^cdn\.jsdelivr\.net$|^storage\.googleapis\.com$/.test(h)),
    hosts.join(', '));
  check('every startup request is a GET (a download, not an upload)',
    requests.every((r) => r.method === 'GET'), requests.filter((r) => r.method !== 'GET').map((r) => r.method).join(','));
  check('nothing is uploaded during startup',
    requests.every((r) => r.bytes === 0), `${requests.reduce((s, r) => s + r.bytes, 0)} bytes of request body`);

  // ---- now do a great deal of inference and watch for new traffic ----
  const mark = requests.length;

  // Build a clip in the page from a reference photo (panned, so every frame
  // differs) and analyse it frame by frame. The photo fetch is the test's own.
  await evaluate(`(async () => {
    const res = await fetch('https://storage.googleapis.com/mediapipe-assets/pose.jpg');
    const img = new Image();
    img.src = URL.createObjectURL(await res.blob());
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 640;
    c.height = Math.round(640 * img.naturalHeight / img.naturalWidth);
    const g = c.getContext('2d');
    const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm' });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => { rec.onstop = r; });
    rec.start(100);
    const t0 = performance.now();
    await new Promise((done) => {
      const frame = () => {
        const t = (performance.now() - t0) / 1000;
        g.fillStyle = '#101010';
        g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, Math.sin(t * 3) * 24, 0, c.width, c.height);
        if (t >= 4) return done();
        requestAnimationFrame(frame);
      };
      frame();
    });
    rec.stop();
    await stopped;
    const file = new File([new Blob(chunks, { type: 'video/webm' })], 'p.webm', { type: 'video/webm' });
    await window.motionStudio.loadVideoFile(file);
    await window.motionStudio.idle();
  })()`);

  const frames = await evaluate(`window.motionStudio.clipA.track?.frames.filter((f) => f.pose).length ?? 0`);

  // Exclude the test's own photo fetch, and blob:/data: URLs — those are
  // in-memory references to local data and never touch the network.
  const during = requests.slice(mark).filter((r) =>
    !r.url.includes('mediapipe-assets/pose.jpg') && !/^(blob|data):/.test(r.url));

  console.log(`  ran ${frames} frame detections\n`);
  if (during.length) {
    console.log('  unexpected requests during inference:');
    for (const r of during.slice(0, 10)) console.log(`    ${r.method} ${r.url.slice(0, 120)}`);
    console.log();
  }

  check('analysing a video sends nothing, frame after frame',
    during.length === 0 && frames > 30, `${frames} frames detected, ${during.length} requests`);
  check('no websocket is ever opened', sockets.length === 0, sockets.join(', '));
  const realAfter = requests.filter((r) => !/^(blob|data):/.test(r.url)).length;
  check('no real request is made past startup', realAfter - startup <= 1,
    `${startup} at startup, ${realAfter} after inference (1 is the test's own photo fetch)`);
}

try {
  await main();
} catch (err) {
  console.error(`\n  ERROR  ${err.message}`);
  failures.push(err.message);
} finally {
  for (const fn of cleanup) { try { fn(); } catch {} }
}

console.log(failures.length ? `\n${failures.length} check(s) failed.` : '\nAll network checks passed.');
process.exit(failures.length ? 1 : 0);
