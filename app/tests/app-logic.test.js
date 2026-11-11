import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrompt, normalizeEdges, aiErrorText } from '../ai.js';
import { translit, fileSlug, allEdges, toCsv, makeZip, crc32, makePdf } from '../export.js';

let n = 0;
const id = () => 'e' + ++n;

test('prompt asks for edges with from-to notes', () => {
  const p = buildPrompt();
  assert.match(p, /0-1000 grid/);
  assert.match(p, /"edges":\[/);
  assert.match(p, /от верха фанеры до низа фасции/);
  assert.doesNotMatch(p, /planes/);
});

test('normalize: 0-1000 grid, tiny and duplicate edges, old planes shape', () => {
  const edges = normalizeEdges(
    {
      edges: [
        { note: ' от угла до угла ', x1: 100, y1: 200, x2: 900, y2: 210 },
        { x1: 901, y1: 211, x2: 101, y2: 199 }, // same edge reversed
        { x1: 100, y1: 200, x2: 105, y2: 205 }, // tiny
        { x1: '0', y1: '0', x2: '1000', y2: '1200' }, // clamped
        { x1: null, y1: 1, x2: 2, y2: 3 }, // bad
      ],
    },
    id
  );
  assert.deepEqual(
    edges.map((e) => [e.note, e.x1, e.y1, e.x2, e.y2]),
    [
      ['от угла до угла', 0.1, 0.2, 0.9, 0.21],
      ['', 0, 0, 1, 1],
    ]
  );
  assert.ok(edges.every((e) => e.value === null && e.src === 'ai' && e.id && !('plane' in e)));
  const old = normalizeEdges({ planes: [{ name: 'X', edges: [{ x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.1 }] }] }, id);
  assert.equal(old.length, 1);
  assert.deepEqual(normalizeEdges(null, id), []);
  assert.deepEqual(normalizeEdges({ edges: 'x' }, id), []);
});

test('error copy', () => {
  assert.match(aiErrorText('rate_limited'), /Подождите/);
  assert.match(aiErrorText('whatever'), /Разметить снова/);
});

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

test('rows are numbered per photo, measured only', () => {
  const rows = allEdges(photos);
  assert.deepEqual(rows.map((r) => [r.photoNo, r.no]), [[1, 1], [1, null], [1, 2], [2, 1]]);
});

test('CSV lists measured sizes', () => {
  const csv = toCsv(allEdges(photos));
  assert.ok(csv.startsWith('﻿Фото №,№,Размер'));
  const lines = csv.trim().split('\r\n');
  assert.deepEqual(lines.slice(1), ['1,1,"120 1/2""",120.5,от левого торца до правого', '1,2,"18""",18,по фанере', '2,1,"24""",24,']);
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
