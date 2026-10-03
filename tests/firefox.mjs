// Firefox check. Firefox's WebGL handling differs enough from Chromium's that
// it is where the "GLctx is undefined" failure showed up, so the browser smoke
// test alone is not enough cover.
//
// Firefox's remote-debugging story is awkward, so instead of driving it the
// page reports back to a collector served alongside the app.
//
//   node tests/firefox.mjs            headless
//   node tests/firefox.mjs --headed   watch it happen

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 5207;
const HEADED = process.argv.includes('--headed');

const FIREFOX = [
  join(process.env['ProgramFiles'] ?? '', 'Mozilla Firefox/firefox.exe'),
  join(process.env['ProgramFiles(x86)'] ?? '', 'Mozilla Firefox/firefox.exe'),
  '/usr/bin/firefox',
  '/Applications/Firefox.app/Contents/MacOS/firefox',
].find((p) => p && existsSync(p));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
};

const failures = [];
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

// Runs inside Firefox and posts its findings back.
const PROBE = `<!doctype html><meta charset="utf-8"><title>firefox probe</title><body><script type="module">
const log = [];
for (const level of ['log', 'warn', 'error']) {
  const real = console[level].bind(console);
  console[level] = (...a) => { log.push(level + ': ' + a.map(String).join(' ')); real(...a); };
}
window.onerror = (m) => log.push('onerror: ' + String(m));
const send = (d) => fetch('/__report', { method: 'POST', body: JSON.stringify(d) });

try {
  const lm = await import('/js/landmarker.js');
  const an = await import('/js/analyze.js');
  const out = { webgl2: !!document.createElement('canvas').getContext('webgl2') };

  // Two analyses back to back on one landmarker. Rebuilding the graph between
  // runs is what used to recreate the GL context and fail with GLctx undefined.
  await lm.ensureLandmarker({ model: 'lite' });
  out.delegate = lm.currentDelegate();

  const blob = await (await fetch('https://storage.googleapis.com/mediapipe-assets/pose.jpg')).blob();
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  await img.decode();

  // a short clip of the reference photo, panned so every frame differs
  const c = document.createElement('canvas');
  c.width = 320; c.height = Math.round(320 * img.naturalHeight / img.naturalWidth);
  const g = c.getContext('2d');
  const rec = new MediaRecorder(c.captureStream(20), { mimeType: 'video/webm' });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => { rec.onstop = r; });
  rec.start(100);
  const t0 = performance.now();
  await new Promise((res) => {
    const f = () => {
      const t = (performance.now() - t0) / 1000;
      g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, Math.sin(t * 3) * 12, 0, c.width, c.height);
      if (t >= 1) return res();
      requestAnimationFrame(f);
    };
    f();
  });
  rec.stop(); await stopped;
  const url = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));

  const run = async () => {
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true;
    video.src = url;
    await new Promise((r) => { video.onloadedmetadata = r; });
    return an.analyzeVideo(video, { sampleFps: 10, model: 'lite' });
  };
  const first = await run();
  out.clipFrames = first.length;
  out.clipTracked = first.frames.filter((f) => f.pose).length;
  out.landmarks = first.frames.find((f) => f.pose)?.pose.length ?? 0;

  const second = await run();
  out.secondTracked = second.frames.filter((f) => f.pose).length;
  out.delegateAfter = lm.currentDelegate();

  out.glCreated = log.filter((l) => /GL version:/i.test(l)).length;
  out.glDestroyed = log.filter((l) => /destroyed WebGL context/i.test(l)).length;
  out.errors = log.filter((l) => l.startsWith('error:') || l.startsWith('onerror:'));
  await send(out);
} catch (e) {
  await send({ fatal: (e && (e.message || String(e))) || String(e), log: log.slice(-15) });
}
</script>`;

if (!FIREFOX) {
  console.log('Firefox not installed — skipping.');
  process.exit(0);
}
console.log(`browser: ${FIREFOX}\n`);

let resolveReport;
const reported = new Promise((r) => { resolveReport = r; });

const server = createServer((req, res) => {
  if (req.url === '/__report' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(204).end();
      try { resolveReport(JSON.parse(body)); } catch { resolveReport({ fatal: 'unparseable report' }); }
    });
    return;
  }
  if (req.url === '/' || req.url.startsWith('/probe')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PROBE);
    return;
  }
  const file = join(ROOT, req.url.split('?')[0]);
  if (!file.startsWith(ROOT)) return void res.writeHead(403).end();
  try {
    statSync(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end('not found');
  }
});
server.listen(PORT);

const profile = mkdtempSync(join(tmpdir(), 'motion-studio-ff-'));
writeFileSync(join(profile, 'user.js'), 'user_pref("browser.shell.checkDefaultBrowser", false);\n');
const ff = spawn(FIREFOX, [
  ...(HEADED ? [] : ['-headless']),
  '-profile', profile, '-no-remote',
  `http://localhost:${PORT}/probe.html`,
], { stdio: 'ignore' });

const r = await Promise.race([
  reported,
  new Promise((res) => setTimeout(() => res({ timeout: true }), 240000)),
]);

if (r.timeout) {
  check('Firefox completed the probe', false, 'timed out after 240s');
} else if (r.fatal) {
  check('Firefox completed the probe', false, r.fatal);
  console.log((r.log ?? []).join('\n'));
} else {
  check('pose model loads in Firefox', Boolean(r.delegate), `delegate ${r.delegate}`);
  check('video pass runs', r.clipFrames > 3, `${r.clipTracked}/${r.clipFrames} frames tracked`);
  check('video pass detects the person', r.clipTracked > 0 && r.landmarks === 33,
    `${r.clipTracked} frames, ${r.landmarks} landmarks`);
  check('a second pass works after the first', r.secondTracked > 0, `${r.secondTracked} frames`);
  // The reported bug: a second run died with "GLctx is undefined" because
  // switching the running mode destroyed and rebuilt the WebGL context.
  check('no WebGL context is destroyed mid-session', r.glDestroyed === 0,
    `${r.glCreated} created, ${r.glDestroyed} destroyed`);
  check('at most one WebGL context is created', r.glCreated <= 1, `${r.glCreated} created`);
  check('delegate stays stable', r.delegate === r.delegateAfter, `${r.delegate} -> ${r.delegateAfter}`);
  check('no console errors', (r.errors ?? []).length === 0, (r.errors ?? []).slice(0, 2).join(' | '));
}

ff.kill();
server.close();
try {
  // Firefox may still be letting go of the profile; the OS reaps temp anyway.
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch { /* best effort */ }
console.log(failures.length ? `\n${failures.length} check(s) failed.` : '\nAll Firefox checks passed.');
process.exit(failures.length ? 1 : 0);
