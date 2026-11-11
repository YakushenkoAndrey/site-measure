import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('service worker caches every app file and they exist', () => {
  const sw = readFileSync(join(root, 'sw.js'), 'utf8');
  const list = JSON.parse(/const ASSETS = (\[[\s\S]*?\]);/.exec(sw)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
  for (const f of list) if (f !== './') assert.ok(existsSync(join(root, f)), f);
  for (const f of ['index.html', 'app.js', 'export.js', 'store.js', 'units.js']) assert.ok(list.includes('./' + f), `${f} is cached`);
  // every module the app imports is cached too
  for (const src of ['app.js', 'export.js']) {
    for (const [, dep] of readFileSync(join(root, src), 'utf8').matchAll(/from '\.\/([\w.-]+)'/g)) {
      assert.ok(list.includes('./' + dep), `${dep} (imported by ${src}) is cached`);
    }
  }
});

test('page is a standalone site: no claude.ai runtime, no external hosts', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const app = readFileSync(join(root, 'app.js'), 'utf8');
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /rel="apple-touch-icon" href="icons\/icon-180.png"/);
  assert.match(html, /viewport-fit=cover/);
  assert.doesNotMatch(html + app, /https?:\/\//);
  assert.doesNotMatch(app, /claude\.use|window\.claude|sample\(/);
});

test('version shown in the app matches the service worker cache', () => {
  const sw = /const VERSION = '(v\d+)'/.exec(readFileSync(join(root, 'sw.js'), 'utf8'))[1];
  const app = /const APP_VERSION = '(v\d+)'/.exec(readFileSync(join(root, 'app.js'), 'utf8'))[1];
  assert.equal(app, sw);
});

test('manifest works from a GitHub Pages subfolder', () => {
  const m = JSON.parse(readFileSync(join(root, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.name, 'Site Measure');
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, './');
  assert.equal(m.scope, './');
  for (const s of [180, 192, 512]) {
    const b = readFileSync(join(root, `icons/icon-${s}.png`));
    assert.deepEqual([b.readUInt32BE(16), b.readUInt32BE(20)], [s, s]);
  }
});
