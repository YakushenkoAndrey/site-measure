import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDxf, wallDxf, projectDxf, safeFileName, WALL_GAP } from '../dxf.js';

const wallA = {
  id: 'a', name: 'North-1', side: 'N', width: 240, height: 120, notes: '', photo: null,
  openings: [
    { id: '1', type: 'window', x: 36, y: 30.5, w: 48, h: 60 },
    { id: '2', type: 'door', x: 120, y: 0, w: 36, h: 84 },
    { id: '3', type: 'vent', x: 200, y: null, w: 10, h: 10 }, // incomplete: not drawn
  ],
};
const wallB = { id: 'b', name: 'East-1', side: 'E', width: 100, height: 96, openings: [] };
const wallEmpty = { id: 'c', name: 'Empty', side: '', width: null, height: 96, openings: [] };
const project = { id: 'p', name: 'Main St 12', walls: [wallA, wallEmpty, wallB] };

/** Split DXF text into [code, value] pairs. */
function pairs(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  assert.equal(lines.length % 2, 0, 'even number of lines');
  const out = [];
  for (let i = 0; i < lines.length; i += 2) out.push([Number(lines[i].trim()), lines[i + 1]]);
  return out;
}

/** Entities as objects: {type, layer, codes: {code: value}}. */
function entities(text) {
  const p = pairs(text);
  const start = p.findIndex(([c, v], i) => c === 2 && v === 'ENTITIES' && p[i - 1][1] === 'SECTION');
  const list = [];
  for (let i = start + 1; i < p.length; i++) {
    const [c, v] = p[i];
    if (c === 0) {
      if (v === 'ENDSEC') break;
      list.push({ type: v, codes: {} });
    } else {
      list.at(-1).codes[c] = v;
    }
  }
  return list.map((e) => ({ ...e, layer: e.codes[8] }));
}

function rects(lines) {
  // group 4 consecutive LINEs into bounding boxes
  const out = [];
  for (let i = 0; i < lines.length; i += 4) {
    const xs = [], ys = [];
    for (const l of lines.slice(i, i + 4)) {
      xs.push(+l.codes[10], +l.codes[11]);
      ys.push(+l.codes[20], +l.codes[21]);
    }
    out.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  return out;
}

test('file structure: sections, version, EOF', () => {
  const { text } = wallDxf(project, wallA);
  const p = pairs(text);
  const sections = p.filter(([c, v]) => c === 0 && v === 'SECTION').length;
  const ends = p.filter(([c, v]) => c === 0 && v === 'ENDSEC').length;
  assert.equal(sections, 3);
  assert.equal(ends, 3);
  assert.deepEqual(p.at(-1), [0, 'EOF']);
  const names = p.filter(([c], i) => c === 2 && p[i - 1][1] === 'SECTION').map(([, v]) => v);
  assert.deepEqual(names, ['HEADER', 'TABLES', 'ENTITIES']);
  const ver = p.findIndex(([c, v]) => c === 9 && v === '$ACADVER');
  assert.deepEqual(p[ver + 1], [1, 'AC1009']);
});

test('layers are defined with colors', () => {
  const p = pairs(wallDxf(project, wallA).text);
  const layers = {};
  p.forEach(([c, v], i) => {
    if (c === 0 && v === 'LAYER') {
      const name = p[i + 1][1];
      const color = p.slice(i + 1, i + 6).find(([cc]) => cc === 62)[1];
      layers[name] = Number(color);
    }
  });
  assert.deepEqual(layers, { 0: 7, WALL: 7, OPENINGS: 1, TEXT: 3 });
});

test('single wall: wall and opening rectangles at the right coordinates', () => {
  const ents = entities(wallDxf(project, wallA).text);
  const wallLines = ents.filter((e) => e.type === 'LINE' && e.layer === 'WALL');
  const openLines = ents.filter((e) => e.type === 'LINE' && e.layer === 'OPENINGS');
  assert.equal(wallLines.length, 4);
  assert.deepEqual(rects(wallLines), [[0, 0, 240, 120]]);
  assert.equal(openLines.length, 8); // incomplete vent skipped
  assert.deepEqual(rects(openLines), [[36, 30.5, 84, 90.5], [120, 0, 156, 84]]);
  // the wall outline is closed: each line ends where the next starts
  for (let i = 0; i < 4; i++) {
    const a = wallLines[i].codes, b = wallLines[(i + 1) % 4].codes;
    assert.deepEqual([a[11], a[21]], [b[10], b[20]]);
  }
  const texts = ents.filter((e) => e.type === 'TEXT');
  assert.ok(texts.every((t) => t.layer === 'TEXT'));
  assert.deepEqual(texts.map((t) => t.codes[1]), ['North-1', '1 WINDOW', '2 DOOR']);
  const name = texts[0].codes;
  assert.ok(+name[20] > 120, 'wall name above the wall');
});

test('all walls: row with 24" gap, incomplete walls skipped', () => {
  const r = projectDxf(project);
  assert.equal(r.fileName, 'Main_St_12_all.dxf');
  assert.deepEqual(r.skipped, ['Empty']);
  assert.deepEqual(r.placed, [{ name: 'North-1', x0: 0 }, { name: 'East-1', x0: 240 + WALL_GAP }]);
  const ents = entities(r.text);
  const wallRects = rects(ents.filter((e) => e.type === 'LINE' && e.layer === 'WALL'));
  assert.deepEqual(wallRects, [[0, 0, 240, 120], [264, 0, 364, 96]]);
  const names = ents.filter((e) => e.type === 'TEXT' && !e.codes[72]).map((e) => [e.codes[1], +e.codes[10]]);
  assert.deepEqual(names, [['North-1', 0], ['East-1', 264]]);
});

test('nothing exportable', () => {
  const r = buildDxf([wallEmpty]);
  assert.equal(r.text, null);
  assert.deepEqual(r.skipped, ['Empty']);
});

test('file names', () => {
  assert.equal(wallDxf(project, wallA).fileName, 'Main_St_12_North-1.dxf');
  assert.equal(safeFileName('Дом #5'), '_____5');
  assert.equal(safeFileName('Дом'), 'untitled');
  assert.equal(safeFileName(''), 'untitled');
});

test('non-ASCII text is replaced', () => {
  const ents = entities(buildDxf([{ ...wallB, name: 'Север' }]).text);
  assert.equal(ents.find((e) => e.type === 'TEXT').codes[1], '?????');
});

// Optional: open the file with ezdxf if a Python with ezdxf is available.
// Set EZDXF_PYTHON to the interpreter path; otherwise "python3"/"python" are tried.
function findEzdxfPython() {
  const candidates = [process.env.EZDXF_PYTHON, 'python3', 'python'].filter(Boolean);
  for (const py of candidates) {
    const r = spawnSync(py, ['-c', 'import ezdxf'], { encoding: 'utf8' });
    if (r.status === 0) return py;
  }
  return null;
}

test('ezdxf can read the generated file', (t) => {
  const py = findEzdxfPython();
  if (!py) {
    t.skip('Python with ezdxf not found (set EZDXF_PYTHON)');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'sm-dxf-'));
  try {
    const file = join(dir, 'all.dxf');
    writeFileSync(file, projectDxf(project).text);
    const script = [
      'import sys, ezdxf',
      'from ezdxf import recover',
      'doc, auditor = recover.readfile(sys.argv[1])',
      'assert not auditor.has_errors, [str(e) for e in auditor.errors]',
      'doc = ezdxf.readfile(sys.argv[1])',
      'msp = doc.modelspace()',
      'print(doc.dxfversion, len(msp.query("LINE")), len(msp.query("TEXT")),',
      '      ",".join(sorted(l.dxf.name for l in doc.layers)))',
    ].join('\n');
    const r = spawnSync(py, ['-c', script, file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    // ezdxf adds Defpoints itself. 2 walls * 4 + 2 openings * 4 = 16 lines; 2 names + 2 labels = 4 texts
    assert.equal(r.stdout.trim(), 'AC1009 16 4 0,Defpoints,OPENINGS,TEXT,WALL');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
