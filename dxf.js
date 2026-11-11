// ASCII DXF, AutoCAD R12 (AC1009), LINE + TEXT entities. 1 unit = 1 inch.
// R12 is the most widely accepted flavour (Fusion "Insert DXF" reads it); it has no
// $INSUNITS header variable (that appeared in R2000), so inches are chosen in the
// Fusion insert dialog.

import { isComplete } from './validate.js';

export const WALL_GAP = 24;
export const LAYERS = [
  { name: 'WALL', color: 7 },
  { name: 'OPENINGS', color: 1 },
  { name: 'TEXT', color: 3 },
];

const TYPE_LABEL = { window: 'WINDOW', door: 'DOOR', vent: 'VENT', other: 'OTHER' };

const has = (v) => typeof v === 'number' && Number.isFinite(v);

/** A wall can be exported only with positive width and height. */
export function isExportable(wall) {
  return has(wall.width) && has(wall.height) && wall.width > 0 && wall.height > 0;
}

/** Latin letters, digits, '-' and '_' only. */
export function safeFileName(s) {
  const out = String(s ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '_');
  return /^[_-]*$/.test(out) ? 'untitled' : out;
}

/** DXF text must be plain ASCII. */
function asciiText(s) {
  return String(s ?? '').replace(/[^\x20-\x7E]/g, '?');
}

function num(v) {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

class Writer {
  constructor() {
    this.out = [];
  }
  pair(code, value) {
    this.out.push(String(code), String(value));
  }
  line(layer, x1, y1, x2, y2) {
    this.pair(0, 'LINE');
    this.pair(8, layer);
    this.pair(10, num(x1));
    this.pair(20, num(y1));
    this.pair(30, 0);
    this.pair(11, num(x2));
    this.pair(21, num(y2));
    this.pair(31, 0);
  }
  rect(layer, x, y, w, h) {
    this.line(layer, x, y, x + w, y);
    this.line(layer, x + w, y, x + w, y + h);
    this.line(layer, x + w, y + h, x, y + h);
    this.line(layer, x, y + h, x, y);
  }
  // centered = middle-center alignment around (x, y); otherwise left baseline at (x, y)
  text(layer, x, y, height, value, centered = false) {
    this.pair(0, 'TEXT');
    this.pair(8, layer);
    this.pair(10, num(x));
    this.pair(20, num(y));
    this.pair(30, 0);
    this.pair(40, num(height));
    this.pair(1, asciiText(value));
    if (centered) {
      this.pair(72, 1);
      this.pair(11, num(x));
      this.pair(21, num(y));
      this.pair(31, 0);
      this.pair(73, 2);
    }
  }
  toString() {
    return this.out.join('\n') + '\n';
  }
}

/** Openings that are drawn: all values present and positive size. */
function drawableOpenings(wall) {
  return (wall.openings || [])
    .map((o, i) => ({ o, n: i + 1 }))
    .filter(({ o }) => isComplete(o) && o.w > 0 && o.h > 0);
}

/**
 * Build a DXF with the given walls placed left to right with WALL_GAP between them.
 * Walls without width/height are skipped.
 * @returns {{text: string|null, skipped: string[], placed: Array<{name, x0}>}}
 */
export function buildDxf(walls) {
  const placed = [];
  const skipped = [];
  let x0 = 0;
  for (const wall of walls) {
    if (!isExportable(wall)) {
      skipped.push(wall.name || '(без имени)');
      continue;
    }
    placed.push({ wall, x0 });
    x0 += wall.width + WALL_GAP;
  }
  if (placed.length === 0) return { text: null, skipped, placed: [] };

  const maxH = Math.max(...placed.map((p) => p.wall.height));
  const maxX = x0 - WALL_GAP;
  const nameH = clamp(maxH * 0.05, 2, 8);

  const w = new Writer();
  // HEADER
  w.pair(0, 'SECTION');
  w.pair(2, 'HEADER');
  w.pair(9, '$ACADVER');
  w.pair(1, 'AC1009');
  w.pair(9, '$EXTMIN');
  w.pair(10, 0);
  w.pair(20, 0);
  w.pair(30, 0);
  w.pair(9, '$EXTMAX');
  w.pair(10, num(maxX));
  w.pair(20, num(maxH + nameH * 3));
  w.pair(30, 0);
  w.pair(0, 'ENDSEC');

  // TABLES: line type + layers
  w.pair(0, 'SECTION');
  w.pair(2, 'TABLES');
  w.pair(0, 'TABLE');
  w.pair(2, 'LTYPE');
  w.pair(70, 1);
  w.pair(0, 'LTYPE');
  w.pair(2, 'CONTINUOUS');
  w.pair(70, 0);
  w.pair(3, 'Solid line');
  w.pair(72, 65);
  w.pair(73, 0);
  w.pair(40, 0);
  w.pair(0, 'ENDTAB');
  w.pair(0, 'TABLE');
  w.pair(2, 'LAYER');
  w.pair(70, LAYERS.length + 1);
  for (const l of [{ name: '0', color: 7 }, ...LAYERS]) {
    w.pair(0, 'LAYER');
    w.pair(2, l.name);
    w.pair(70, 0);
    w.pair(62, l.color);
    w.pair(6, 'CONTINUOUS');
  }
  w.pair(0, 'ENDTAB');
  w.pair(0, 'ENDSEC');

  // ENTITIES
  w.pair(0, 'SECTION');
  w.pair(2, 'ENTITIES');
  for (const { wall, x0: ox } of placed) {
    w.rect('WALL', ox, 0, wall.width, wall.height);
    w.text('TEXT', ox, wall.height + nameH, nameH, wall.name || 'Wall');
    for (const { o, n } of drawableOpenings(wall)) {
      w.rect('OPENINGS', ox + o.x, o.y, o.w, o.h);
      const th = clamp(Math.min(o.w, o.h) * 0.12, 1, 4);
      w.text('TEXT', ox + o.x + o.w / 2, o.y + o.h / 2, th,
        `${n} ${TYPE_LABEL[o.type] || 'OTHER'}`, true);
    }
  }
  w.pair(0, 'ENDSEC');
  w.pair(0, 'EOF');

  return {
    text: w.toString(),
    skipped,
    placed: placed.map((p) => ({ name: p.wall.name, x0: p.x0 })),
  };
}

/** One wall -> file `<Project>_<Wall>.dxf`. */
export function wallDxf(project, wall) {
  const r = buildDxf([wall]);
  return { ...r, fileName: `${safeFileName(project.name)}_${safeFileName(wall.name)}.dxf` };
}

/** All walls of a project -> file `<Project>_all.dxf`. */
export function projectDxf(project) {
  const r = buildDxf(project.walls || []);
  return { ...r, fileName: `${safeFileName(project.name)}_all.dxf` };
}
