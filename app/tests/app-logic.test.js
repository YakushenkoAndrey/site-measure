import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrompt, normalizeEdges, EDGE_LABELS, aiErrorText } from '../ai.js';
import { translit, fileSlug, allEdges, groupByPlane, planeSizes, toCsv, planesDxf, makeZip, crc32, makePdf } from '../export.js';

let n = 0;
const id = () => 'e' + ++n;

test('prompt lists known planes and the JSON shape', () => {
  const p = buildPrompt(['Фасция козырька', 'Софит']);
  assert.match(p, /"Фасция козырька", "Софит"/);
  assert.match(p, /0-1000 grid/);
  for (const l of EDGE_LABELS) assert.ok(p.includes(l));
  assert.match(buildPrompt([]), /No surfaces are named/);
});

test('normalize: 0-1000 grid, labels, tiny and duplicate edges', () => {
  const edges = normalizeEdges(
    {
      planes: [
        {
          name: ' Фасция ',
          edges: [
            { label: 'ширина', x1: 100, y1: 200, x2: 900, y2: 210 },
            { label: 'ширина', x1: 901, y1: 211, x2: 101, y2: 199 }, // same edge reversed
            { label: 'высота', x1: 100, y1: 200, x2: 105, y2: 205 }, // tiny
            { label: 'странное', x1: '0', y1: '0', x2: '1000', y2: '1200' }, // clamped, label -> другое
            { label: 'высота', x1: null, y1: 1, x2: 2, y2: 3 }, // bad
          ],
        },
        { edges: [{ label: 'длина', x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.1 }] }, // 0..1 coords, unnamed plane
      ],
    },
    id
  );
  assert.equal(edges.length, 3);
  assert.deepEqual(
    edges.map((e) => [e.plane, e.label, e.x1, e.y1, e.x2, e.y2]),
    [
      ['Фасция', 'ширина', 0.1, 0.2, 0.9, 0.21],
      ['Фасция', 'другое', 0, 0, 1, 1],
      ['Поверхность', 'длина', 0.1, 0.1, 0.5, 0.1],
    ]
  );
  assert.ok(edges.every((e) => e.value === null && e.src === 'ai' && e.id));
  assert.deepEqual(normalizeEdges(null, id), []);
  assert.deepEqual(normalizeEdges({ planes: 'x' }, id), []);
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
      { id: 'a', plane: 'Фасция', label: 'длина', note: '', value: 120.5 },
      { id: 'b', plane: 'Фасция', label: 'высота', note: 'по фанере', value: 18 },
      { id: 'c', plane: 'Колонна', label: 'высота', note: '', value: null },
    ],
  },
  { edges: [{ id: 'd', plane: 'Фасция', label: 'длина', note: '', value: 121.25 }, { id: 'e', plane: 'Колонна', label: 'ширина', note: '', value: 24 }] },
];

test('rows, grouping and plane sizes', () => {
  const rows = allEdges(photos);
  assert.deepEqual(rows.map((r) => r.photoNo), [1, 1, 1, 2, 2]);
  assert.deepEqual(groupByPlane(rows).map((g) => [g.plane, g.edges.length]), [['Фасция', 3], ['Колонна', 2]]);
  assert.deepEqual(planeSizes(rows), [
    { plane: 'Фасция', width: 121.25, height: 18 },
    { plane: 'Колонна', width: 24, height: null },
  ]);
});

test('CSV', () => {
  const csv = toCsv(allEdges(photos));
  assert.ok(csv.startsWith('﻿Поверхность,Ребро'));
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 6);
  assert.equal(lines[1], 'Фасция,длина,,1,"120 1/2""",120.5');
  assert.equal(lines[4], 'Колонна,высота,,1,,');
});

test('planes DXF', () => {
  const r = planesDxf(allEdges(photos));
  assert.deepEqual(r.skipped, ['Колонна']);
  assert.match(r.text, /AC1009/);
  assert.match(r.text, /\nFastsiya\n/);
  assert.match(r.text, /\n121\.25\n/);
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
  // every xref entry points at "N 0 obj"
  const start = +/startxref\n(\d+)/.exec(text)[1];
  const xref = text.slice(start).split('\n');
  assert.equal(xref[0], 'xref');
  const count = +xref[1].split(' ')[1];
  for (let i = 1; i < count; i++) {
    const off = +xref[2 + i].slice(0, 10);
    assert.ok(text.startsWith(`${i} 0 obj`, off), `object ${i}`);
  }
});
