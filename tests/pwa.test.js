import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { backupJson, parseBackup, asCopy, newWall } from '../storage.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('service worker caches every app file and they exist', () => {
  const sw = readFileSync(join(root, 'sw.js'), 'utf8');
  const list = JSON.parse(/const ASSETS = (\[[\s\S]*?\]);/.exec(sw)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
  for (const f of list) if (f !== './') assert.ok(existsSync(join(root, f)), f);
  for (const f of ['index.html', 'styles.css', 'app.js', 'units.js', 'validate.js', 'dxf.js', 'sketch.js', 'storage.js', 'marks.js', 'photo-editor.js']) {
    assert.ok(list.includes('./' + f), `${f} is cached`);
  }
});

test('manifest works from a GitHub Pages subfolder', () => {
  const m = JSON.parse(readFileSync(join(root, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.name, 'Site Measure');
  assert.equal(m.short_name, 'Measure');
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, './');
  assert.equal(m.scope, './');
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  assert.match(html, /rel="apple-touch-icon" href="icons\/icon-180.png"/);
  assert.match(html, /viewport-fit=cover/);
  // PNG sizes from the IHDR chunk
  for (const s of [180, 192, 512]) {
    const b = readFileSync(join(root, `icons/icon-${s}.png`));
    assert.deepEqual([b.readUInt32BE(16), b.readUInt32BE(20)], [s, s]);
  }
});

test('backup round trip and copy with fresh ids', () => {
  const p = { id: 'p1', name: 'Main', address: 'A', date: '2026-11-10', createdAt: 1, updatedAt: 1, walls: [] };
  const w = newWall(p);
  w.photo = 'data:image/jpeg;base64,AAAA';
  w.openings.push({ id: 'o1', type: 'door', x: 1, y: 0, w: 36, h: 80 });
  p.walls.push(w);
  const back = parseBackup(backupJson(p));
  assert.deepEqual(back, p);
  const c = asCopy(back);
  assert.notEqual(c.id, p.id);
  assert.notEqual(c.walls[0].id, w.id);
  assert.equal(c.walls[0].photo, w.photo);
  assert.equal(c.name, 'Main (копия)');
  assert.throws(() => parseBackup('nope'), /JSON/);
  assert.throws(() => parseBackup('{"a":1}'), /резервная копия/);
});

test('default wall names are unique', () => {
  const p = { walls: [{ name: 'Wall-1' }, { name: 'Wall-3' }] };
  assert.equal(newWall(p).name, 'Wall-4');
  assert.equal(newWall({ walls: [] }).name, 'Wall-1');
});
