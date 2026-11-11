// Exports: dimension table (CSV), planes as DXF, PDF from JPEG pages, ZIP container.
// Pure functions (no DOM) so they run under node --test.

import { formatLength } from './units.js';
import { buildDxf } from './dxf.js';

const WIDTH_LABELS = ['ширина', 'длина'];
const HEIGHT_LABELS = ['высота', 'глубина'];

const TR = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Russian -> Latin for DXF text and file names. */
export function translit(s) {
  return String(s ?? '')
    .split('')
    .map((ch) => {
      const lower = ch.toLowerCase();
      if (!(lower in TR)) return ch;
      const t = TR[lower];
      return ch !== lower && t ? t[0].toUpperCase() + t.slice(1) : t;
    })
    .join('');
}

/** Safe file name part: Latin letters, digits, '-' and '_'. */
export function fileSlug(s, fallback = 'object') {
  const out = translit(s).trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return out || fallback;
}

/**
 * All edges of a project, in photo order, with the photo number (1-based).
 * @param photos photo docs sorted in display order: {edges: [...]}
 */
export function allEdges(photos) {
  const rows = [];
  photos.forEach((p, i) => {
    for (const e of p.edges || []) rows.push({ ...e, photoNo: i + 1 });
  });
  return rows;
}

/** Edges grouped by plane name, planes in first-seen order. */
export function groupByPlane(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.plane)) map.set(r.plane, []);
    map.get(r.plane).push(r);
  }
  return [...map.entries()].map(([plane, edges]) => ({ plane, edges }));
}

/** Width/height of each plane taken from its measured edges (largest value per role). */
export function planeSizes(rows) {
  return groupByPlane(rows).map(({ plane, edges }) => {
    const pick = (labels) => {
      const vals = edges.filter((e) => labels.includes(e.label) && typeof e.value === 'number' && e.value > 0).map((e) => e.value);
      return vals.length ? Math.max(...vals) : null;
    };
    return { plane, width: pick(WIDTH_LABELS), height: pick(HEIGHT_LABELS) };
  });
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV table (UTF-8 with BOM so Excel shows Cyrillic). */
export function toCsv(rows, precision = 16) {
  const head = ['Поверхность', 'Ребро', 'Примечание', 'Фото №', 'Размер', 'Дюймы'];
  const lines = [head.join(',')];
  for (const { plane, edges } of groupByPlane(rows)) {
    for (const e of edges) {
      const has = typeof e.value === 'number';
      lines.push(
        [plane, e.label, e.note || '', e.photoNo, has ? formatLength(e.value, precision) : '', has ? String(Math.round(e.value * 10000) / 10000) : '']
          .map(csvCell)
          .join(',')
      );
    }
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** DXF with one rectangle per plane that has both width and height. */
export function planesDxf(rows) {
  const walls = planeSizes(rows).map((p) => ({ name: translit(p.plane), width: p.width, height: p.height, openings: [] }));
  const r = buildDxf(walls);
  // report skipped planes by their original (Russian) names
  const skipped = planeSizes(rows).filter((p) => !(p.width > 0 && p.height > 0)).map((p) => p.plane);
  return { text: r.text, skipped };
}

// ---------------- ZIP (stored, no compression) ----------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();
const toBytes = (d) => (typeof d === 'string' ? enc.encode(d) : d instanceof Uint8Array ? d : new Uint8Array(d));

/**
 * @param files [{name, data: string|Uint8Array}]
 * @returns Uint8Array of a .zip file
 */
export function makeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = toBytes(f.data);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 0x0800, true); // UTF-8 names
    v.setUint16(8, 0, true); // stored
    v.setUint32(14, crc, true);
    v.setUint32(18, data.length, true);
    v.setUint32(22, data.length, true);
    v.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, data);

    const cd = new Uint8Array(46 + name.length);
    const w = new DataView(cd.buffer);
    w.setUint32(0, 0x02014b50, true);
    w.setUint16(4, 20, true);
    w.setUint16(6, 20, true);
    w.setUint16(8, 0x0800, true);
    w.setUint16(10, 0, true);
    w.setUint32(16, crc, true);
    w.setUint32(20, data.length, true);
    w.setUint32(24, data.length, true);
    w.setUint16(28, name.length, true);
    w.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, cdSize, true);
  e.setUint32(16, offset, true);
  return concat([...parts, ...central, end]);
}

function concat(chunks) {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// ---------------- PDF from JPEG pages ----------------

export const LETTER = { w: 612, h: 792 }; // points, 8.5 x 11 in

/**
 * Build a PDF where each page shows one JPEG fitted inside a US Letter page with margins.
 * @param pages [{jpeg: Uint8Array, width, height}] pixel size of each JPEG
 */
export function makePdf(pages, { margin = 24 } = {}) {
  const chunks = [];
  const offsets = [];
  let pos = 0;
  const push = (b) => {
    const bytes = toBytes(b);
    chunks.push(bytes);
    pos += bytes.length;
  };
  const obj = (n, body) => {
    offsets[n] = pos;
    push(`${n} 0 obj\n`);
    for (const b of [].concat(body)) push(b);
    push('\nendobj\n');
  };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const n = pages.length;
  // objects: 1 catalog, 2 pages, then per page: page, content, image
  const pageIds = pages.map((_, i) => 3 + i * 3);
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${n} >>`);
  pages.forEach((p, i) => {
    const pid = pageIds[i];
    const cid = pid + 1;
    const iid = pid + 2;
    const k = Math.min((LETTER.w - 2 * margin) / p.width, (LETTER.h - 2 * margin) / p.height);
    const w = +(p.width * k).toFixed(2);
    const h = +(p.height * k).toFixed(2);
    const x = +((LETTER.w - w) / 2).toFixed(2);
    const y = +((LETTER.h - h) / 2).toFixed(2);
    const content = `q ${w} 0 0 ${h} ${x} ${y} cm /Im0 Do Q`;
    obj(pid, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${LETTER.w} ${LETTER.h}] /Resources << /XObject << /Im0 ${iid} 0 R >> >> /Contents ${cid} 0 R >>`);
    obj(cid, [`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']);
    obj(iid, [
      `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`,
      p.jpeg,
      '\nendstream',
    ]);
  });
  const total = 3 + n * 3;
  const xref = pos;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return concat(chunks);
}
