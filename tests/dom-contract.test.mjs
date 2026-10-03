// Catches the failure mode a syntax check cannot: a selector in the JS that no
// longer matches anything in index.html (or an element nobody reads).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const html = await readFile(resolve(ROOT, 'index.html'), 'utf8');
const main = await readFile(resolve(ROOT, 'js/main.js'), 'utf8');
const timeline = await readFile(resolve(ROOT, 'js/timeline.js'), 'utf8');
// Per-clip markup is a template inside ClipView, not in index.html.
const clip = await readFile(resolve(ROOT, 'js/clip.js'), 'utf8');
const markup = html + clip;

const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const classes = new Set([...markup.matchAll(/\bclass="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));

// every $('#id') in main.js must exist
const missing = [];
for (const m of main.matchAll(/\$\('#([\w-]+)'\)/g)) {
  if (!ids.has(m[1])) missing.push(m[1]);
}
assert.deepEqual(missing, [], `main.js queries ids that index.html does not define: ${missing}`);

// every id in the markup should be read by the JS, or it is dead weight
const unread = [...ids].filter((id) => !main.includes(`#${id}'`) && !main.includes(`'${id}'`));
assert.deepEqual(unread, [], `index.html defines unused ids: ${unread}`);

// Timeline's internal parts, and everything ClipView reaches for in its own
// template — a renamed class there fails silently at runtime otherwise.
for (const m of timeline.matchAll(/querySelector\('\.([\w-]+)'\)/g)) {
  assert.ok(classes.has(m[1]), `timeline.js expects .${m[1]} in the timeline markup`);
}
for (const m of clip.matchAll(/q\('\.([\w-]+)(?: [^']*)?'\)/g)) {
  assert.ok(classes.has(m[1]), `clip.js expects .${m[1]} in its template`);
}

// Video is the only source. Mode tabs and per-mode panels were removed along
// with the still-image and live-camera paths; none may linger half-wired.
for (const attr of ['data-mode', 'data-for', 'data-hide-for']) {
  assert.ok(!html.includes(`${attr}=`), `index.html still has ${attr} — there are no source modes`);
}

// every module main.js imports must exist and export what is asked of it
const imports = [...main.matchAll(/import\s+(?:\*\s+as\s+\w+|\{([^}]+)\}|\w+)\s+from\s+'(\.[^']+)'/g)];
for (const [, named, spec] of imports) {
  const source = await readFile(resolve(ROOT, 'js', spec), 'utf8');
  for (const name of (named ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const exported =
      new RegExp(`export\\s+(async\\s+)?(function|class|const|let)\\s+${name}\\b`).test(source) ||
      new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(source);
    assert.ok(exported, `${spec} does not export ${name}`);
  }
}

console.log('all DOM-contract checks passed');
