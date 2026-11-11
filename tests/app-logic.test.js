import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { translit, fileSlug, allEdges, toCsv, makeZip, readZip, crc32, makePdf } from '../export.js';

test('translit and file names', () => {
  assert.equal(translit('Фасция козырька'), 'Fastsiya kozyrka');
  assert.equal(translit('Щит Ёж'), 'Shchit Ezh');
  assert.equal(fileSlug('Дом №5, вход'), 'Dom_5_vkhod');
  assert.equal(fileSlug('!!!'), 'object');
});

const photos = [
  {
    edges: [
      { id: 'a', note: 'от левого торца до правого', value: 120.5 },
      { id: 'b', note: '', value: null },
      { id: 'c', note: 'по фанере', value: 18 },
    ],
  },
  { edges: [{ id: 'd', note: '', value: 24 }] },
];

test('rows are numbered per photo: only measured edges with a note get a number', () => {
  const rows = allEdges(photos);
  assert.deepEqual(rows.map((r) => [r.photoNo, r.no]), [[1, 1], [1, null], [1, 2], [2, null]]);
});

test('CSV lists measured sizes', () => {
  const csv = toCsv(allEdges(photos));
  assert.ok(csv.startsWith('﻿Фото №,№,Размер'));
  const lines = csv.trim().split('\r\n');
  assert.deepEqual(lines.slice(1), ['1,1,"120 1/2""",120.5,от левого торца до правого', '1,2,"18""",18,по фанере', '2,,"24""",24,']);
});

test('ZIP opens with Python zipfile', (t) => {
  const zip = makeZip([
    { name: 'a.txt', data: 'hello' },
    { name: 'фото/1.jpg', data: new Uint8Array([1, 2, 3]) },
  ]);
  assert.equal(crc32(new TextEncoder().encode('hello')), 0x3610a686);
  const py = spawnSync('python', ['-c', 'import zipfile'], { encoding: 'utf8' });
  if (py.status !== 0) return t.skip('python not found');
  const dir = mkdtempSync(join(tmpdir(), 'sm-zip-'));
  try {
    const f = join(dir, 'x.zip');
    writeFileSync(f, zip);
    const r = spawnSync('python', ['-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print("|".join(z.namelist()), z.read("a.txt").decode())', f], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'a.txt|фото/1.jpg hello');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readZip reads back what makeZip wrote', () => {
  const photo = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const z = readZip(makeZip([{ name: 'backup.json', data: '{"a":"фото"}' }, { name: 'photos/x.jpg', data: photo }]));
  assert.deepEqual([...z.keys()], ['backup.json', 'photos/x.jpg']);
  assert.equal(new TextDecoder().decode(z.get('backup.json')), '{"a":"фото"}');
  assert.deepEqual([...z.get('photos/x.jpg')], [...photo]);
  assert.throws(() => readZip(new Uint8Array([1, 2, 3])), /not a zip/);
});

test('PDF structure and xref offsets', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const pdf = makePdf([{ jpeg, width: 1600, height: 1200 }, { jpeg, width: 1200, height: 1600 }]);
  const text = Buffer.from(pdf).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.match(text, /\/Count 2/);
  assert.equal((text.match(/\/DCTDecode/g) || []).length, 2);
  const start = +/startxref\n(\d+)/.exec(text)[1];
  const xref = text.slice(start).split('\n');
  assert.equal(xref[0], 'xref');
  const count = +xref[1].split(' ')[1];
  for (let i = 1; i < count; i++) {
    const off = +xref[2 + i].slice(0, 10);
    assert.ok(text.startsWith(`${i} 0 obj`, off), `object ${i}`);
  }
});
