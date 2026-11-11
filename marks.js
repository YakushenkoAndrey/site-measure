// Annotations drawn over a wall photo. Coordinates are normalized to the image (0..1),
// so they do not depend on screen size or zoom. The original photo is never modified.
//
// Mark { id, type: 'dim' | 'rect' | 'line', x1, y1, x2, y2, value (inches|null, dim only), color }

import { formatLength } from './units.js';

export const MARK_COLORS = ['#ff2020', '#ffd400', '#00e5ff'];

export function newMark(type, x, y, color = MARK_COLORS[0], id = markId()) {
  const m = { id, type, x1: x, y1: y, x2: x, y2: y, color };
  if (type === 'dim') m.value = null;
  return m;
}

function markId() {
  return globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Label text of a dimension mark. */
export function markLabel(m, precision = 16) {
  if (m.type !== 'dim') return '';
  return m.value === null || m.value === undefined ? '?' : formatLength(m.value, precision);
}

/** Distance from point p to segment ab (all in the same units). */
export function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Segments of a mark in pixel space (image size iw x ih). */
export function markSegments(m, iw, ih) {
  const a = { x: m.x1 * iw, y: m.y1 * ih };
  const b = { x: m.x2 * iw, y: m.y2 * ih };
  if (m.type !== 'rect') return [[a, b]];
  const c = { x: b.x, y: a.y };
  const d = { x: a.x, y: b.y };
  return [[a, c], [c, b], [b, d], [d, a]];
}

/**
 * Topmost mark within `tol` of point p (pixels of the image), or null.
 * Later marks are drawn on top, so they win.
 */
export function hitMark(marks, p, tol, iw, ih) {
  let best = null;
  let bestD = tol + 1e-9;
  for (let i = marks.length - 1; i >= 0; i--) {
    const m = marks[i];
    for (const [a, b] of markSegments(m, iw, ih)) {
      const d = distToSegment(p, a, b);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
  }
  return best;
}

/** Which endpoint handle ('1' or '2') of a mark is within tol of p, or null. */
export function hitHandle(m, p, tol, iw, ih) {
  const d1 = Math.hypot(p.x - m.x1 * iw, p.y - m.y1 * ih);
  const d2 = Math.hypot(p.x - m.x2 * iw, p.y - m.y2 * ih);
  if (Math.min(d1, d2) > tol) return null;
  return d1 <= d2 ? '1' : '2';
}

/** Mark length on screen is too small to be intentional. */
export function isTiny(m, iw, ih, minPx) {
  return Math.hypot((m.x2 - m.x1) * iw, (m.y2 - m.y1) * ih) < minPx;
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
export function clampPoint(x, y) {
  return { x: clamp01(x), y: clamp01(y) };
}

/**
 * Draw marks with a 2D canvas context (used for the annotated JPEG and the editor).
 * @param ctx CanvasRenderingContext2D-like
 * @param opts {iw, ih, scale: pixels per image pixel, lineW, fontPx, precision, selectedId}
 */
export function drawMarks(ctx, marks, opts) {
  const { iw, ih, scale = 1, lineW, fontPx, precision = 16 } = opts;
  const P = (x, y) => [x * iw * scale, y * ih * scale];
  for (const m of marks) {
    const [ax, ay] = P(m.x1, m.y1);
    const [bx, by] = P(m.x2, m.y2);
    ctx.strokeStyle = m.color;
    ctx.fillStyle = m.color;
    ctx.lineWidth = lineW;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // dark outline under every stroke so it reads on any background
    for (const pass of ['shadow', 'main']) {
      ctx.save();
      if (pass === 'shadow') {
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = lineW * 2.2;
      }
      ctx.beginPath();
      if (m.type === 'rect') {
        ctx.rect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      } else {
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        if (m.type === 'dim') {
          for (const [x, y] of [[ax, ay], [bx, by]]) {
            const len = Math.hypot(bx - ax, by - ay) || 1;
            const nx = (-(by - ay) / len) * lineW * 4;
            const ny = ((bx - ax) / len) * lineW * 4;
            ctx.moveTo(x - nx, y - ny);
            ctx.lineTo(x + nx, y + ny);
          }
        }
      }
      ctx.stroke();
      ctx.restore();
    }
    if (m.type === 'dim') {
      const text = markLabel(m, precision);
      ctx.font = `bold ${fontPx}px -apple-system, "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // label sits beside the line (above it, or left of a vertical one) so the line stays visible
      const len = Math.hypot(bx - ax, by - ay) || 1;
      let nx = -(by - ay) / len;
      let ny = (bx - ax) / len;
      if (ny > 0.01 || (Math.abs(ny) <= 0.01 && nx > 0)) {
        nx = -nx;
        ny = -ny;
      }
      const off = fontPx * 0.9 + lineW;
      const cx = (ax + bx) / 2 + nx * off;
      const cy = (ay + by) / 2 + ny * off;
      const w = ctx.measureText(text).width + fontPx * 0.6;
      const h = fontPx * 1.35;
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
      ctx.fillStyle = m.color;
      ctx.fillText(text, cx, cy);
    }
  }
}
