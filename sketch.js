// Wall drawing to scale as an SVG string. Origin: bottom-left corner of the wall, Y up.

import { formatLength, formatPlain } from './units.js';

const has = (v) => typeof v === 'number' && Number.isFinite(v);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const n = (v) => Math.round(v * 1000) / 1000;

/**
 * @param wall
 * @param errors result of validateWall(wall)
 * @param opts {precision, compact, active: opening index to highlight}
 * @returns SVG markup, or null when width/height are missing
 */
export function wallSvg(wall, errors = [], opts = {}) {
  const { precision = 16, compact = false } = opts;
  const W = wall.width;
  const H = wall.height;
  if (!has(W) || !has(H) || W <= 0 || H <= 0) return null;

  const f = Math.max(W, H) * (compact ? 0.04 : 0.05); // label font size, inches
  const ml = compact ? f : f * 0.6;
  const mr = compact ? f : f * 2.6;
  const mt = compact ? f : f * 2.6;
  const mb = compact ? f : f * 0.6;
  const vb = [-ml, -mt, W + ml + mr, H + mt + mb].map(n).join(' ');

  const parts = [];
  parts.push(`<rect class="sk-wall" x="0" y="0" width="${n(W)}" height="${n(H)}" vector-effect="non-scaling-stroke"/>`);

  if (!compact) {
    // overall width on top, height on the right
    const yDim = -f * 0.9;
    const xDim = W + f * 0.9;
    const t = f * 0.35;
    parts.push(
      `<path class="sk-dim" d="M0 ${n(yDim)}H${n(W)}M0 ${n(yDim - t)}V${n(yDim + t)}M${n(W)} ${n(yDim - t)}V${n(yDim + t)}` +
        `M${n(xDim)} 0V${n(H)}M${n(xDim - t)} 0H${n(xDim + t)}M${n(xDim - t)} ${n(H)}H${n(xDim + t)}" vector-effect="non-scaling-stroke"/>`,
      `<text class="sk-label" x="${n(W / 2)}" y="${n(yDim - f * 0.45)}" font-size="${n(f)}" text-anchor="middle">${esc(formatLength(W, precision))}</text>`,
      `<text class="sk-label" x="${n(xDim + f * 0.45)}" y="${n(H / 2)}" font-size="${n(f)}" text-anchor="middle" ` +
        `transform="rotate(90 ${n(xDim + f * 0.45)} ${n(H / 2)})">${esc(formatLength(H, precision))}</text>`
    );
  }

  (wall.openings || []).forEach((o, i) => {
    if (!has(o.w) || !has(o.h) || o.w <= 0 || o.h <= 0) return;
    const complete = has(o.x) && has(o.y);
    const x = has(o.x) ? o.x : 0;
    const y = has(o.y) ? o.y : 0;
    const bad = (errors[i] || []).length > 0;
    const cls = !complete ? 'sk-op sk-draft' : bad ? 'sk-op sk-bad' : 'sk-op';
    const top = H - (y + o.h);
    let label = '';
    if (!compact) {
      const fo = Math.min(f * 1.1, o.w / 3.4, o.h / 2.6);
      const cx = x + o.w / 2;
      const cy = top + o.h / 2;
      label =
        `<text class="sk-num" x="${n(cx)}" y="${n(cy - fo * 0.15)}" font-size="${n(fo * 1.2)}" text-anchor="middle">${i + 1}</text>` +
        `<text class="sk-size" x="${n(cx)}" y="${n(cy + fo * 1.1)}" font-size="${n(fo * 0.85)}" text-anchor="middle">` +
        `${esc(formatPlain(o.w, precision))} × ${esc(formatPlain(o.h, precision))}</text>`;
    }
    parts.push(
      `<g class="${cls}" data-op="${i}"><rect x="${n(x)}" y="${n(top)}" width="${n(o.w)}" height="${n(o.h)}" vector-effect="non-scaling-stroke"/>${label}</g>`
    );
  });

  return `<svg class="sketch-svg" viewBox="${vb}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Схема стены">${parts.join('')}</svg>`;
}
