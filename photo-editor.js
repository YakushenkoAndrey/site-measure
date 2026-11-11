// Full-screen photo editor: zoom/pan, draw dimension lines, rectangles and lines over the photo.
// Marks live in wall.photoMarks (normalized coords); the photo itself is never changed.

import { esc } from './sketch.js';
import { newMark, hitMark, hitHandle, isTiny, clampPoint, drawMarks, MARK_COLORS } from './marks.js';

const TOOLS = [
  ['view', '✋', 'Смотреть'],
  ['dim', '↔', 'Размер'],
  ['rect', '▭', 'Контур'],
  ['line', '╱', 'Линия'],
];
const HINTS = {
  view: 'Двумя пальцами — увеличить. Нажми на пометку, чтобы выбрать её.',
  dim: 'Проведи пальцем от точки до точки, затем введи размер.',
  rect: 'Проведи пальцем из угла в угол.',
  line: 'Проведи пальцем от точки до точки.',
};

/** Load an image element from a data URL. */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('фото не открывается'));
    im.src = src;
  });
}

/** Photo + marks rendered at full photo resolution, as a JPEG data URL (synchronous). */
export function renderAnnotated(img, marks, precision) {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = iw;
  c.height = ih;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const long = Math.max(iw, ih);
  drawMarks(ctx, marks, { iw, ih, lineW: Math.max(3, long * 0.004), fontPx: Math.max(16, long * 0.032), precision });
  return c.toDataURL('image/jpeg', 0.85);
}

/** Small preview (photo fitted inside the canvas, marks on top). */
export async function drawThumb(canvas, src, marks, precision) {
  const img = await loadImage(src);
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth || 132;
  const ch = canvas.clientHeight || 132;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  const ctx = canvas.getContext('2d');
  const k = Math.min(cw / img.naturalWidth, ch / img.naturalHeight);
  const ox = (cw - img.naturalWidth * k) / 2;
  const oy = (ch - img.naturalHeight * k) / 2;
  ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * ox, dpr * oy);
  ctx.drawImage(img, 0, 0);
  drawMarks(ctx, marks || [], { iw: img.naturalWidth, ih: img.naturalHeight, lineW: 2 / k, fontPx: 10 / k, precision });
  return img;
}

/**
 * @param opts {
 *   wall, precision,
 *   onChange(): marks changed — save,
 *   editValue(mark, after): open the inch keypad for a dimension; call after() when it closes,
 *   keypadOpen(): true while the keypad is shown,
 *   keypadHeight(): its height in px,
 *   share(img): share the annotated photo (called directly from the tap),
 *   onClose()
 * }
 */
export async function openPhotoEditor(opts) {
  const { wall, precision } = opts;
  wall.photoMarks ||= [];
  const img = await loadImage(wall.photo);
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;

  const ed = document.createElement('div');
  ed.className = 'editor';
  ed.innerHTML = `
    <div class="ed-top">
      <button class="btn ed-done" data-ed="close">Готово</button>
      <span class="ed-title">${esc(wall.name || 'Фото')}</span>
      <button class="btn ed-share" data-ed="share">Поделиться</button>
    </div>
    <canvas class="ed-canvas"></canvas>
    <div class="ed-bottom">
      <div class="ed-hint"></div>
      <div class="ed-tools">${TOOLS.map(([t, icon, label]) => `<button class="ed-tool" data-tool="${t}"><b>${icon}</b>${label}</button>`).join('')}</div>
      <div class="ed-actions">
        <button class="ed-tool" data-ed="color"><span class="ed-dot"></span>Цвет</button>
        <button class="ed-tool" data-ed="undo"><b>↶</b>Отменить</button>
        <button class="ed-tool" data-ed="value" hidden><b>#</b>Размер</button>
        <button class="ed-tool danger" data-ed="delete" hidden><b>✕</b>Удалить</button>
      </div>
    </div>`;
  document.body.append(ed);
  document.body.classList.add('editor-open');
  const canvas = ed.querySelector('canvas');
  const ctx = canvas.getContext('2d');

  let tool = 'view';
  let color = MARK_COLORS[0];
  let selected = null;
  const undo = [];
  let cw = 0, ch = 0, k0 = 1, s = 1, ox = 0, oy = 0; // view: image px at canvas top-left
  const k = () => k0 * s;

  const snapshot = () => JSON.stringify(wall.photoMarks);
  const pushUndo = (snap = snapshot()) => {
    undo.push(snap);
    if (undo.length > 100) undo.shift();
  };

  function fit() {
    const r = canvas.getBoundingClientRect();
    cw = r.width;
    ch = r.height;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    k0 = Math.min(cw / iw, ch / ih);
    s = 1;
    ox = (iw - cw / k0) / 2;
    oy = (ih - ch / k0) / 2;
    draw();
  }

  let raf = 0;
  function draw() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const kk = k();
      ctx.setTransform(dpr * kk, 0, 0, dpr * kk, -ox * dpr * kk, -oy * dpr * kk);
      ctx.drawImage(img, 0, 0);
      const list = temp ? [...wall.photoMarks, temp] : wall.photoMarks;
      drawMarks(ctx, list, { iw, ih, lineW: 3 / kk, fontPx: 18 / kk, precision });
      if (selected) {
        for (const [x, y] of [[selected.x1, selected.y1], [selected.x2, selected.y2]]) {
          ctx.beginPath();
          ctx.arc(x * iw, y * ih, 11 / kk, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.fill();
          ctx.lineWidth = 3 / kk;
          ctx.strokeStyle = '#000';
          ctx.stroke();
        }
      }
    });
  }

  function updateUi() {
    ed.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
    ed.querySelector('.ed-hint').textContent = selected ? 'Тяни белые точки, чтобы подвинуть концы.' : HINTS[tool];
    ed.querySelector('.ed-dot').style.background = color;
    ed.querySelector('[data-ed=undo]').disabled = undo.length === 0;
    ed.querySelector('[data-ed=delete]').hidden = !selected;
    ed.querySelector('[data-ed=value]').hidden = !(selected && selected.type === 'dim');
  }

  const toImg = (clientX, clientY) => {
    const r = canvas.getBoundingClientRect();
    return { x: ox + (clientX - r.left) / k(), y: oy + (clientY - r.top) / k() };
  };

  /** Keep a mark visible above the keypad. */
  function ensureVisible(m) {
    const visibleH = window.innerHeight - opts.keypadHeight() - canvas.getBoundingClientRect().top;
    const my = ((m.y1 + m.y2) / 2) * ih;
    const sy = (my - oy) * k();
    if (sy > visibleH - 40 || sy < 20) oy = my - visibleH / 2 / k();
    draw();
  }

  function editValue(m) {
    const before = snapshot();
    ensureVisible(m);
    opts.editValue(m, () => {
      if (snapshot() !== before) {
        pushUndo(before);
        opts.onChange();
      }
      draw();
      updateUi();
    });
  }

  // ----- gestures -----
  const pts = new Map();
  let g = null; // current gesture
  let temp = null; // mark being drawn
  let lastTap = 0;

  canvas.addEventListener('pointerdown', (e) => {
    if (opts.keypadOpen() || g?.ignore) {
      g = { ignore: true };
      return;
    }
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* not an active pointer */
    }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      const p = toImg(e.clientX, e.clientY);
      g = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false, ox, oy };
      const h = selected && hitHandle(selected, p, 26 / k(), iw, ih);
      if (h) {
        g.mode = 'handle';
        g.which = h;
        g.before = snapshot();
      } else if (tool !== 'view') {
        g.mode = 'draw';
        const q = clampPoint(p.x / iw, p.y / ih);
        temp = newMark(tool, q.x, q.y, color);
      } else g.mode = 'pan';
    } else if (pts.size === 2 && g) {
      if (g.mode === 'handle' && g.moved) wall.photoMarks = JSON.parse(g.before); // cancel the drag
      if (g.mode === 'handle') selected = wall.photoMarks.find((m) => m.id === selected.id) || null;
      temp = null;
      const [a, b] = [...pts.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      g = { mode: 'pinch', moved: true, d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: s, anchor: toImg(mid.x, mid.y) };
      draw();
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !g || g.ignore) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.mode === 'pinch') {
      const [a, b] = [...pts.values()];
      if (!b) return;
      const r = canvas.getBoundingClientRect();
      const mid = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
      s = Math.min(12, Math.max(1, (g.s0 * Math.hypot(a.x - b.x, a.y - b.y)) / g.d0));
      ox = g.anchor.x - mid.x / k();
      oy = g.anchor.y - mid.y / k();
      return draw();
    }
    if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) > 8) g.moved = true;
    if (!g.moved) return;
    const p = toImg(e.clientX, e.clientY);
    const q = clampPoint(p.x / iw, p.y / ih);
    if (g.mode === 'draw' && temp) {
      temp.x2 = q.x;
      temp.y2 = q.y;
    } else if (g.mode === 'handle') {
      selected['x' + g.which] = q.x;
      selected['y' + g.which] = q.y;
    } else if (g.mode === 'pan' && s > 1) {
      ox = g.ox - (e.clientX - g.x) / k();
      oy = g.oy - (e.clientY - g.y) / k();
    }
    draw();
  });

  const up = (e) => {
    if (!pts.delete(e.pointerId)) {
      if (!pts.size && g?.ignore) g = null;
      return;
    }
    if (pts.size || !g) return;
    const done = g;
    g = null;
    if (done.mode === 'pinch') {
      if (s <= 1.02) fit();
      return;
    }
    if (!done.moved) {
      // tap: select a mark; double tap in view mode toggles zoom
      temp = null;
      const p = toImg(e.clientX, e.clientY);
      const hit = hitMark(wall.photoMarks, p, 22 / k(), iw, ih);
      selected = hit;
      if (!hit && tool === 'view' && Date.now() - lastTap < 350) {
        if (s > 1) fit();
        else {
          const r = canvas.getBoundingClientRect();
          s = 2.5;
          ox = p.x - (e.clientX - r.left) / k();
          oy = p.y - (e.clientY - r.top) / k();
        }
        lastTap = 0;
      } else lastTap = Date.now();
      draw();
      return updateUi();
    }
    if (done.mode === 'draw' && temp) {
      const m = temp;
      temp = null;
      if (!isTiny(m, iw * k(), ih * k(), 14)) {
        pushUndo();
        wall.photoMarks.push(m);
        selected = m;
        opts.onChange();
        if (m.type === 'dim') editValue(m);
      }
    } else if (done.mode === 'handle') {
      pushUndo(done.before);
      opts.onChange();
    }
    draw();
    updateUi();
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);

  // ----- buttons -----
  ed.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tool]');
    if (t) {
      tool = t.dataset.tool;
      selected = null;
      draw();
      return updateUi();
    }
    const b = e.target.closest('[data-ed]');
    if (!b) return;
    switch (b.dataset.ed) {
      case 'close':
        return close();
      case 'share':
        return opts.share(img);
      case 'color': {
        color = MARK_COLORS[(MARK_COLORS.indexOf(color) + 1) % MARK_COLORS.length];
        if (selected) {
          pushUndo();
          selected.color = color;
          opts.onChange();
        }
        break;
      }
      case 'undo': {
        if (!undo.length) return;
        wall.photoMarks = JSON.parse(undo.pop());
        selected = null;
        opts.onChange();
        break;
      }
      case 'delete': {
        if (!selected) return;
        pushUndo();
        wall.photoMarks = wall.photoMarks.filter((m) => m.id !== selected.id);
        selected = null;
        opts.onChange();
        break;
      }
      case 'value':
        if (selected?.type === 'dim') editValue(selected);
        return;
    }
    draw();
    updateUi();
  });

  const onResize = () => fit();
  window.addEventListener('resize', onResize);

  function close() {
    window.removeEventListener('resize', onResize);
    ed.remove();
    document.body.classList.remove('editor-open');
    opts.onClose();
  }

  fit();
  updateUi();
  return { close };
}
