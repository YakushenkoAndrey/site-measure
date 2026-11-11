// Site Measure on claude.ai: photos of an object -> Claude marks the edges -> you type the sizes.

import { parseLength, formatLength, formatPlain, applyKey } from './units.js';
import { buildPrompt, normalizeEdges, aiErrorText } from './ai.js';
import { allEdges, toCsv, makeZip, makePdf, fileSlug } from './export.js';

// ---------------------------------------------------------------- state

const S = {
  db: null,
  assets: null,
  sample: null,
  downloads: null,
  ready: false,
  noDb: false,
  projects: [],
  photos: [],
  view: 'home', // home | project
  projectId: null,
  tab: 'photos', // photos | table
  analyzing: new Set(),
  prec: 16,
};
try {
  S.prec = +localStorage.getItem('sm.prec') === 8 ? 8 : 16;
} catch {
  /* storage blocked */
}

const app = document.getElementById('app');
const blobCache = new Map(); // assetId -> Blob (fresh uploads, for analysis)
const imgCache = new Map(); // assetId -> Promise<HTMLImageElement>

const uid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Date.now().toString(36) + Math.random().toString(36).slice(2));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (v) => (typeof v === 'number' ? formatLength(v, S.prec) : '');
const blobUrl = (id) => '/_blob/' + id;
const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const project = () => S.projects.find((p) => p.id === S.projectId) || null;
const projectPhotos = (pid = S.projectId) => S.photos.filter((p) => p.projectId === pid).sort((a, b) => a.order - b.order);

const EDGE_COLOR = '#ff3b30';
const edgeColor = () => EDGE_COLOR;
function counts(photos) {
  let total = 0;
  let done = 0;
  for (const p of photos) for (const e of p.edges || []) {
    total++;
    if (typeof e.value === 'number') done++;
  }
  return { total, done };
}

// ---------------------------------------------------------------- db writes (one at a time per doc)

const writers = new Map();
function saveDoc(path, data) {
  let w = writers.get(path);
  if (!w) writers.set(path, (w = { busy: false, next: null }));
  w.next = data;
  if (!w.busy) pump(path, w);
}
async function pump(path, w) {
  w.busy = true;
  while (w.next) {
    const d = w.next;
    w.next = null;
    try {
      await S.db.doc(path).set(d);
    } catch (e) {
      toast(e?.code === 'quota_exceeded' ? 'Хранилище заполнено. Удалите старые объекты.' : 'Не удалось сохранить. Проверьте интернет.');
    }
  }
  w.busy = false;
}
const strip = ({ id, ...rest }) => rest;
function savePhoto(ph) {
  ph.rev = (ph.rev || 0) + 1;
  ph.updatedAt = Date.now();
  saveDoc('photos/' + ph.id, strip(ph));
  const p = S.projects.find((x) => x.id === ph.projectId);
  if (p) {
    p.updatedAt = ph.updatedAt;
    saveDoc('projects/' + p.id, strip(p));
  }
}
const saveProject = (p) => {
  p.updatedAt = Date.now();
  saveDoc('projects/' + p.id, strip(p));
};

// ---------------------------------------------------------------- small UI helpers

function toast(text, ms = 3500) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

/** Bottom sheet with option buttons; resolves with the chosen value or null. */
function sheet({ title, text = '', options, input = null }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-wrap';
    wrap.innerHTML = `<div class="sheet" role="dialog" aria-label="${esc(title)}">
      <h2>${esc(title)}</h2>${text ? `<p>${esc(text)}</p>` : ''}
      ${input ? `<input type="text" id="sheet-input" value="${esc(input.value || '')}" placeholder="${esc(input.placeholder || '')}" autocomplete="off">` : ''}
      ${options.map((o, i) => `<button class="btn block ${o.cls || ''} ${o.sub ? 'opt' : ''}" data-i="${i}">${esc(o.label)}${o.sub ? `<small>${esc(o.sub)}</small>` : ''}</button>`).join('')}
      <button class="btn block" data-i="-1">Отмена</button></div>`;
    const done = (v) => {
      wrap.remove();
      resolve(v);
    };
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) return done(null);
      const b = e.target.closest('[data-i]');
      if (!b) return;
      const i = +b.dataset.i;
      if (i < 0) return done(null);
      const o = options[i];
      done(input ? { value: o.value, text: wrap.querySelector('#sheet-input').value.trim() } : o.value);
    });
    document.body.append(wrap);
    if (input) setTimeout(() => wrap.querySelector('#sheet-input')?.focus(), 50);
  });
}

function loadImage(assetId) {
  if (!imgCache.has(assetId)) {
    imgCache.set(
      assetId,
      new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => {
          imgCache.delete(assetId);
          reject(new Error('фото не загрузилось'));
        };
        const b = blobCache.get(assetId);
        im.src = b ? URL.createObjectURL(b) : blobUrl(assetId);
      })
    );
  }
  return imgCache.get(assetId);
}

async function photoBlob(assetId) {
  if (blobCache.has(assetId)) return blobCache.get(assetId);
  const r = await fetch(blobUrl(assetId));
  if (!r.ok) throw new Error('фото не загрузилось');
  return r.blob();
}

/** Downscale a picked photo to a JPEG (long side <= 2048). Orientation is applied by the browser. */
async function compress(file) {
  const url = URL.createObjectURL(file);
  try {
    const im = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('формат фото не поддерживается'));
      i.src = url;
    });
    const k = Math.min(1, 2048 / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(im.naturalWidth * k);
    c.height = Math.round(im.naturalHeight * k);
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.86));
    return { blob, w: c.width, h: c.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------- drawing edges

function textOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const l = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return l > 150 ? '#111' : '#fff';
}

/**
 * Draw edges over an image already drawn in image-pixel space.
 * opts: {iw, ih, lineW, fontPx, colorOf(edge), selectedId, liveText, prec, numberOf(edge)}
 */
function drawEdges(ctx, edges, o) {
  for (const e of edges) {
    const sel = e.id === o.selectedId;
    const ax = e.x1 * o.iw, ay = e.y1 * o.ih, bx = e.x2 * o.iw, by = e.y2 * o.ih;
    const col = o.colorOf(e);
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const nx = -(by - ay) / len, ny = (bx - ax) / len;
    const t = o.lineW * 3.5;
    ctx.lineCap = 'round';
    for (const pass of [0, 1]) {
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.moveTo(ax - nx * t, ay - ny * t);
      ctx.lineTo(ax + nx * t, ay + ny * t);
      ctx.moveTo(bx - nx * t, by - ny * t);
      ctx.lineTo(bx + nx * t, by + ny * t);
      ctx.strokeStyle = pass ? col : 'rgba(0,0,0,0.7)';
      ctx.lineWidth = (pass ? 1 : 2.4) * o.lineW * (sel ? 1.5 : 1);
      ctx.stroke();
    }
    // label beside the line (above, or left of a vertical line)
    let px = nx, py = ny;
    if (py > 0.01 || (Math.abs(py) <= 0.01 && px > 0)) {
      px = -px;
      py = -py;
    }
    let text = sel && o.liveText != null ? o.liveText || '…' : typeof e.value === 'number' ? formatLength(e.value, o.prec) : '?';
    const no = o.numberOf?.(e);
    if (no) text = `${no} · ${text}`;
    ctx.font = `700 ${o.fontPx}px Barlow, system-ui, sans-serif`;
    const w = ctx.measureText(text).width + o.fontPx * 0.7;
    const h = o.fontPx * 1.3;
    const off = o.fontPx * 0.9 + o.lineW * 2;
    const cx = (ax + bx) / 2 + px * off, cy = (ay + by) / 2 + py * off;
    ctx.fillStyle = typeof e.value === 'number' || sel ? col : 'rgba(10,13,17,0.85)';
    ctx.strokeStyle = sel ? '#fff' : col;
    ctx.lineWidth = o.lineW * (sel ? 1.2 : 0.8);
    roundRect(ctx, cx - w / 2, cy - h / 2, w, h, h * 0.3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = typeof e.value === 'number' || sel ? textOn(col) : col;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, cy + o.fontPx * 0.04);
  }
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Measured edges of a photo, numbered 1..n in their order. */
function measured(ph) {
  return (ph.edges || []).filter((e) => typeof e.value === 'number').map((e, i) => ({ ...e, no: i + 1 }));
}

/** Full-resolution JPEG of a photo with its measured sizes; small labels keep the photo readable. */
async function annotatedJpeg(ph, pid) {
  const img = await loadImage(ph.assetId);
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = iw;
  c.height = ih;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const long = Math.max(iw, ih);
  drawEdges(ctx, measured(ph), { iw, ih, lineW: Math.max(2, long * 0.0012), fontPx: Math.max(14, long * 0.011), colorOf: edgeColor, prec: S.prec, numberOf: (e) => e.no });
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: iw, height: ih };
}

// ---------------------------------------------------------------- Claude: find edges

const queue = [];
let queueBusy = false;
function analyze(photoId) {
  if (S.analyzing.has(photoId) || queue.includes(photoId)) return;
  queue.push(photoId);
  const ph = S.photos.find((p) => p.id === photoId);
  if (ph) {
    ph.status = 'queued';
    ph.error = '';
    savePhoto(ph);
  }
  render();
  if (!queueBusy) runQueue();
}
async function runQueue() {
  queueBusy = true;
  while (queue.length) {
    const id = queue.shift();
    S.analyzing.add(id);
    let ph = S.photos.find((p) => p.id === id);
    if (!ph) {
      S.analyzing.delete(id);
      continue;
    }
    ph.status = 'analyzing';
    savePhoto(ph);
    render();
    try {
      if (!S.sample) throw { code: 'sampling_disabled' };
      const blob = await photoBlob(ph.assetId);
      const answer = await S.sample.json(buildPrompt(), { images: [blob], modelTier: 'complex', cache: false });
      ph = S.photos.find((p) => p.id === id);
      if (!ph) continue;
      const fresh = normalizeEdges(answer, uid);
      // keep edges the user typed a size for or drew by hand; replace the rest
      const kept = (ph.edges || []).filter((e) => e.src === 'user' || typeof e.value === 'number');
      ph.edges = [...kept, ...fresh];
      ph.status = fresh.length ? 'done' : 'error';
      ph.error = fresh.length ? '' : 'Claude не нашёл рёбер на этом фото. Добавьте их вручную.';
    } catch (e) {
      ph = S.photos.find((p) => p.id === id);
      if (!ph) continue;
      ph.status = 'error';
      ph.error = aiErrorText(e?.code);
    } finally {
      S.analyzing.delete(id);
    }
    savePhoto(ph);
    render();
    if (ed && ed.photo.id === id) ed.reload();
  }
  queueBusy = false;
}

// ---------------------------------------------------------------- adding photos

async function addPhotos(files) {
  const p = project();
  if (!p || !files.length) return;
  if (!S.assets) return toast('Добавлять фото может только владелец страницы.');
  let order = Math.max(0, ...projectPhotos().map((x) => x.order || 0));
  for (const file of files) {
    try {
      toast('Загружаю фото…', 1500);
      const { blob, w, h } = await compress(file);
      const up = await S.assets.upload(blob, { type: 'image/jpeg' });
      blobCache.set(up.id, blob);
      const ph = { id: uid(), projectId: p.id, assetId: up.id, w, h, order: ++order, status: 'queued', error: '', edges: [], rev: 0, createdAt: Date.now() };
      S.photos.push(ph);
      if (!p.coverAssetId) p.coverAssetId = up.id;
      savePhoto(ph);
      saveProject(p);
      render();
      analyze(ph.id);
    } catch (e) {
      toast(e?.code === 'quota_or_state' ? 'Место для фото закончилось.' : 'Не удалось добавить фото: ' + (e?.message || e?.code || 'ошибка'));
    }
  }
}

// ---------------------------------------------------------------- screens

function render() {
  if (ed) ed.refreshStatus();
  if (!S.ready) {
    app.innerHTML = `<div class="page"><div class="top"><h1>Site Measure</h1></div><p class="hero-note"><span class="spin"></span> Загружаю объекты…</p></div>`;
    return;
  }
  if (S.noDb) {
    app.innerHTML = `<div class="page"><div class="top"><h1>Site Measure</h1></div>
      <div class="empty">Откройте эту страницу в claude.ai под своим аккаунтом: там хранятся объекты и фото, и там работает Claude.</div></div>`;
    return;
  }
  if (S.view === 'project' && project()) renderProject();
  else renderHome();
}

function renderHome() {
  S.view = 'home';
  const list = [...S.projects].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  app.innerHTML = `<div class="page">
    <div class="top"><h1>Site Measure</h1></div>
    <p class="hero-note">Снимите объект с нескольких сторон. Claude разметит рёбра, а вы впишете размеры в дюймах.</p>
    <div class="projects">
      ${list.length ? '' : `<div class="empty">Объектов пока нет. Нажмите «Новый объект» и сделайте первое фото.</div>`}
      ${list
        .map((p) => {
          const ph = projectPhotos(p.id);
          const c = counts(ph);
          const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
          return `<button class="pcard" data-open="${esc(p.id)}">
            <span class="cover" ${p.coverAssetId ? `style="background-image:url('${blobUrl(p.coverAssetId)}')"` : ''}>${p.coverAssetId ? '' : '▢'}</span>
            <span><span class="t">${esc(p.name || 'Без названия')}</span>
              <span class="s num">${esc(p.address ? p.address + ' · ' : '')}${ph.length} фото · ${c.done} из ${c.total} размеров</span>
              <span class="meter"><i style="width:${pct}%"></i></span></span>
          </button>`;
        })
        .join('')}
    </div></div>
    <div class="dock"><div class="row one"><button class="btn primary block" data-act="new">＋ Новый объект</button></div></div>`;
}

function renderProject() {
  const p = project();
  const photos = projectPhotos();
  const c = counts(photos);
  const scrollY = window.scrollY;
  app.innerHTML = `<div class="page">
    <div class="top">
      <button class="icon-btn" data-act="home" aria-label="К объектам">‹</button>
      <span class="spacer"></span>
      <button class="icon-btn" data-act="export" aria-label="Экспорт">⇪</button>
      <button class="icon-btn" data-act="pmenu" aria-label="Ещё">⋯</button>
    </div>
    <div class="fields">
      <input class="name" id="p-name" data-pf="name" value="${esc(p.name)}" placeholder="Название объекта" autocomplete="off">
      <input id="p-addr" data-pf="address" value="${esc(p.address)}" placeholder="Адрес" autocomplete="off">
    </div>
    <div class="seg" role="tablist">
      <button class="${S.tab === 'photos' ? 'on' : ''}" data-tab="photos">Фото · ${photos.length}</button>
      <button class="${S.tab === 'table' ? 'on' : ''}" data-tab="table">Размеры · ${c.done}/${c.total}</button>
    </div>
    ${S.tab === 'photos' ? photosHtml(photos) : tableHtml(photos)}
  </div>
  <div class="dock"><div class="row">
    <label class="btn primary">📷 Снять<input type="file" accept="image/*" capture="environment" data-add></label>
    <label class="btn">🖼 Из галереи<input type="file" accept="image/*" multiple data-add></label>
  </div></div>`;
  window.scrollTo(0, scrollY);
  drawTileOverlays(photos);
}

function photosHtml(photos) {
  if (!photos.length) return `<div class="empty">Сделайте несколько фото объекта с разных сторон. Каждое фото Claude разметит сам — обычно это занимает до минуты.</div>`;
  return `<div class="grid">${photos
    .map((ph, i) => {
      const c = counts([ph]);
      let badge;
      if (ph.status === 'analyzing' || ph.status === 'queued') {
        badge = S.analyzing.has(ph.id) || queue.includes(ph.id) ? `<span class="badge"><span class="spin"></span> ${ph.status === 'queued' ? 'В очереди' : 'Claude размечает'}</span>` : `<span class="badge err">Разметка прервана</span>`;
      } else if (ph.status === 'error' && !c.total) badge = `<span class="badge err">Ошибка</span>`;
      else badge = `<span class="badge ${c.total && c.done === c.total ? 'done' : ''} num">${c.done}/${c.total}</span>`;
      return `<button class="tile" data-photo="${esc(ph.id)}" aria-label="Фото ${i + 1}">
        <img src="${blobUrl(ph.assetId)}" alt="" loading="lazy">
        <svg data-ov="${esc(ph.id)}" viewBox="0 0 ${ph.w} ${ph.h}" preserveAspectRatio="xMidYMid slice"></svg>
        <span class="no">${i + 1}</span>${badge}</button>`;
    })
    .join('')}</div>`;
}

function drawTileOverlays(photos) {
  for (const ph of photos) {
    const svg = app.querySelector(`svg[data-ov="${CSS.escape(ph.id)}"]`);
    if (!svg) continue;
    const sw = Math.max(ph.w, ph.h) * 0.006;
    svg.innerHTML = (ph.edges || [])
      .map((e) => `<line x1="${e.x1 * ph.w}" y1="${e.y1 * ph.h}" x2="${e.x2 * ph.w}" y2="${e.y2 * ph.h}" stroke="${EDGE_COLOR}" stroke-width="${sw}" stroke-linecap="round" ${typeof e.value === 'number' ? '' : `stroke-dasharray="${sw * 2.5} ${sw * 1.5}"`}/>`)
      .join('');
  }
}

function tableHtml(photos) {
  const rows = allEdges(photos);
  if (!rows.length) return `<div class="empty">Размеров пока нет. Они появятся, когда Claude разметит фото.</div>`;
  return photos
    .map((ph, i) => {
      const edges = rows.filter((r) => r.photoNo === i + 1);
      if (!edges.length) return '';
      const done = edges.filter((e) => typeof e.value === 'number').length;
      return `<section class="plane"><h3><img class="thumb" src="${blobUrl(ph.assetId)}" alt="">Фото ${i + 1}<small class="num">${done}/${edges.length}</small></h3>
        ${edges
          .map(
            (e) => `<button class="rowbtn" data-photo="${esc(ph.id)}" data-edge="${esc(e.id)}">
              <span class="l"><b class="no num">${e.no ?? '·'}</b>${e.note ? esc(e.note) : '<i>без примечания</i>'}</span>
              <span class="v num ${typeof e.value === 'number' ? '' : 'miss'}">${typeof e.value === 'number' ? esc(fmt(e.value)) : '—'}</span>
              <span class="p">›</span></button>`
          )
          .join('')}</section>`;
    })
    .join('');
}

// ---------------------------------------------------------------- events (list screens)

app.addEventListener('click', async (e) => {
  const t = e.target;
  const open = t.closest('[data-open]');
  if (open) {
    S.projectId = open.dataset.open;
    S.view = 'project';
    S.tab = 'photos';
    window.scrollTo(0, 0);
    return render();
  }
  const ph = t.closest('[data-photo]');
  if (ph) return openEditor(ph.dataset.photo, ph.dataset.edge || null);
  const tab = t.closest('[data-tab]');
  if (tab) {
    S.tab = tab.dataset.tab;
    return render();
  }
  const act = t.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'home') {
    S.view = 'home';
    window.scrollTo(0, 0);
    return render();
  }
  if (act === 'new') {
    const p = { id: uid(), name: '', address: '', date: today(), createdAt: Date.now(), updatedAt: Date.now(), coverAssetId: null };
    S.projects.push(p);
    saveProject(p);
    S.projectId = p.id;
    S.view = 'project';
    S.tab = 'photos';
    render();
    app.querySelector('#p-name')?.focus();
    return;
  }
  if (act === 'export') return exportSheet();
  if (act === 'pmenu') return projectMenu();
});

app.addEventListener('change', (e) => {
  if (e.target.matches('[data-add]')) {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    addPhotos(files);
  }
});

let typingTimer = null;
app.addEventListener('input', (e) => {
  const f = e.target.dataset.pf;
  const p = project();
  if (!f || !p) return;
  p[f] = e.target.value;
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => saveProject(p), 600);
});

async function projectMenu() {
  const p = project();
  const precLabel = S.prec === 16 ? 'Точность: 1/16" → 1/8"' : 'Точность: 1/8" → 1/16"';
  const empty = projectPhotos().reduce((n, ph) => n + (ph.edges || []).filter((e) => typeof e.value !== 'number').length, 0);
  const v = await sheet({
    title: p.name || 'Объект',
    options: [
      { label: precLabel, value: 'prec' },
      ...(empty ? [{ label: `Удалить рёбра без размеров (${empty})`, sub: 'Со всех фото объекта. Рёбра с размерами останутся.', value: 'empty' }] : []),
      { label: 'Удалить объект', value: 'delete', cls: 'danger' },
    ],
  });
  if (v === 'empty') {
    const ok = await sheet({ title: `Удалить рёбра без размеров (${empty})?`, text: 'Со всех фото этого объекта. Рёбра с введёнными размерами останутся.', options: [{ label: 'Удалить', value: true, cls: 'danger' }] });
    if (!ok) return;
    for (const ph of projectPhotos()) {
      const keep = (ph.edges || []).filter((e) => typeof e.value === 'number');
      if (keep.length !== (ph.edges || []).length) {
        ph.edges = keep;
        savePhoto(ph);
      }
    }
    render();
    return toast('Рёбра без размеров удалены');
  }
  if (v === 'prec') {
    setPrec(S.prec === 16 ? 8 : 16);
    render();
  }
  if (v === 'delete') {
    const photos = projectPhotos();
    const ok = await sheet({
      title: 'Удалить объект?',
      text: `«${p.name || 'Без названия'}», ${photos.length} фото и все размеры будут удалены. Это нельзя отменить.`,
      options: [{ label: 'Удалить навсегда', value: true, cls: 'danger' }],
    });
    if (!ok) return;
    for (const ph of photos) {
      await S.db.doc('photos/' + ph.id).delete().catch(() => {});
      await S.assets?.delete(ph.assetId).catch(() => {});
    }
    await S.db.doc('projects/' + p.id).delete().catch(() => {});
    S.photos = S.photos.filter((x) => x.projectId !== p.id);
    S.projects = S.projects.filter((x) => x.id !== p.id);
    S.view = 'home';
    render();
    toast('Объект удалён');
  }
}

function setPrec(v) {
  S.prec = v;
  try {
    localStorage.setItem('sm.prec', String(v));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- export

async function exportSheet() {
  const p = project();
  const photos = projectPhotos();
  if (!photos.length) return toast('Сначала добавьте фото.');
  if (!S.downloads) return toast('Скачивание файлов здесь недоступно.');
  const v = await sheet({
    title: 'Экспорт',
    text: 'Файлы сохраняются через окно подтверждения claude.ai.',
    options: [
      { label: 'PDF-отчёт', sub: 'Каждое фото на своей странице с размерами и примечаниями, формат Letter', value: 'pdf', cls: 'primary' },
      { label: 'Таблица CSV', sub: 'Открывается в Excel и Google Таблицах', value: 'csv' },
      { label: 'Всё одним ZIP', sub: 'PDF, CSV и фото с размерами', value: 'zip' },
    ],
  });
  if (!v) return;
  const base = fileSlug(p.name) + '_' + (p.date || today());
  try {
    if (v === 'csv') return await save(base + '.csv', toCsv(allEdges(photos), S.prec));
    toast('Готовлю файлы…', 2500);
    const pdf = await buildReport(p, photos);
    if (v === 'pdf') return await save(base + '.pdf', new Blob([pdf], { type: 'application/pdf' }));
    const rows = allEdges(photos);
    const files = [
      { name: 'report.pdf', data: pdf },
      { name: 'sizes.csv', data: toCsv(rows, S.prec) },
    ];
    for (let i = 0; i < photos.length; i++) {
      const j = await annotatedJpeg(photos[i], p.id);
      files.push({ name: `photos/${String(i + 1).padStart(2, '0')}.jpg`, data: j.bytes });
    }
    await save(base + '.zip', new Blob([makeZip(files)], { type: 'application/zip' }));
  } catch (e) {
    if (e?.code === 'declined') return;
    toast('Экспорт не удался: ' + (e?.message || e?.code || 'ошибка'));
  }
}

async function save(filename, data) {
  const r = await S.downloads.save({ filename, data });
  if (r?.status === 'saved') toast('Файл сохранён');
}

/** PDF: one Letter page per photo with its measured sizes; notes listed under the photo. */
async function buildReport(p, photos) {
  const pages = [];
  for (const ph of photos) pages.push(await reportPage(ph, p.id));
  return makePdf(pages);
}

/** One page rendered on a canvas (150 dpi) so Cyrillic needs no PDF fonts. */
async function reportPage(ph, pid) {
  const W = 1275, H = 1650, M = 50, LH = 32;
  const img = await loadImage(ph.assetId);
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const edges = measured(ph);
  const notes = edges.filter((e) => e.note);
  const notesH = notes.length ? notes.length * LH + 24 : 0;
  const k = Math.min((W - 2 * M) / iw, (H - 2 * M - notesH) / ih);
  const pw = iw * k, phh = ih * k;
  const x0 = (W - pw) / 2, y0 = M;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.setTransform(k, 0, 0, k, x0, y0);
  ctx.drawImage(img, 0, 0);
  drawEdges(ctx, edges, { iw, ih, lineW: 1.6 / k, fontPx: 15 / k, colorOf: edgeColor, prec: S.prec, numberOf: (e) => e.no });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  let y = y0 + phh + 24 + LH * 0.7;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  for (const e of notes) {
    ctx.fillStyle = EDGE_COLOR;
    ctx.fillRect(x0, y - 16, 12, 12);
    ctx.fillStyle = '#111';
    ctx.font = '700 22px Barlow, Arial, sans-serif';
    const head = `${e.no} · ${fmt(e.value)}`;
    ctx.fillText(head, x0 + 20, y);
    const hw = ctx.measureText(head).width;
    ctx.font = '500 22px Barlow, Arial, sans-serif';
    ctx.fillStyle = '#333';
    ctx.fillText('— ' + e.note, x0 + 30 + hw, y, pw - 40 - hw);
    y += LH;
  }
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  return { jpeg: new Uint8Array(await blob.arrayBuffer()), width: W, height: H };
}

// ---------------------------------------------------------------- photo editor

let ed = null;

function openEditor(photoId, edgeId) {
  const ph = S.photos.find((p) => p.id === photoId);
  if (!ph) return;
  ed?.close();
  ed = new Editor(ph, edgeId);
}

class Editor {
  constructor(photo, edgeId) {
    this.photo = photo;
    this.edges = structuredClone(photo.edges || []);
    this.rev = photo.rev || 0;
    this.sel = null; // selected edge id
    this.mode = 'idle'; // idle | draw
    this.text = ''; // keypad text for the selected edge
    this.initial = '';
    this.view = { k0: 1, s: 1, ox: 0, oy: 0 };
    this.img = null;
    this.build();
    loadImage(photo.assetId)
      .then((img) => {
        this.img = img;
        this.fit();
        if (edgeId) this.select(edgeId);
        else this.paintPanel();
      })
      .catch(() => toast('Фото не загрузилось.'));
  }

  // ---------- layout
  build() {
    const el = (this.el = document.createElement('div'));
    el.className = 'ed';
    el.innerHTML = `
      <div class="ed-top">
        <button class="icon-btn" data-e="close" aria-label="Назад">‹</button>
        <div class="ttl"><b></b><span class="num"></span></div>
        <button class="icon-btn" data-e="menu" aria-label="Ещё">⋯</button>
      </div>
      <div class="ed-stage"><canvas></canvas><canvas class="loupe" hidden width="264" height="264"></canvas><div class="status-pill" hidden></div><div class="value-pill" hidden><span class="typed num"></span><span class="res"></span></div></div>
      <div class="ed-panel"></div>`;
    document.body.append(el);
    document.body.style.overflow = 'hidden';
    this.canvas = el.querySelector('.ed-stage canvas');
    this.ctx = this.canvas.getContext('2d');
    this.loupe = el.querySelector('.loupe');
    this.panel = el.querySelector('.ed-panel');
    this.pill = el.querySelector('.status-pill');
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.canvas);
    this.bindPointer();
    // hold the erase key to clear the whole value
    this.panel.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('[data-k="back"]')) return;
      clearTimeout(this.holdTimer);
      this.holdTimer = setTimeout(() => {
        this.text = '';
        this.skipClick = true;
        this.paintValue();
      }, 550);
    });
    const stopHold = () => clearTimeout(this.holdTimer);
    this.panel.addEventListener('pointerup', stopHold);
    this.panel.addEventListener('pointercancel', stopHold);
    this.panel.addEventListener('pointerleave', stopHold);
    el.addEventListener('click', (e) => this.onClick(e));
    this.refreshStatus();
  }

  close() {
    this.commit();
    this.ro.disconnect();
    this.el.remove();
    document.body.style.overflow = '';
    ed = null;
    render();
  }

  photos() {
    return projectPhotos(this.photo.projectId);
  }

  refreshStatus() {
    const list = this.photos();
    const i = list.findIndex((p) => p.id === this.photo.id);
    const c = counts([{ edges: this.edges }]);
    this.el.querySelector('.ttl b').textContent = `Фото ${i + 1} из ${list.length}`;
    this.el.querySelector('.ttl span').textContent = c.total ? `${c.done} из ${c.total} размеров` : '';
    const doc = S.photos.find((p) => p.id === this.photo.id) || this.photo;
    const busy = S.analyzing.has(doc.id) || queue.includes(doc.id);
    this.pill.hidden = !busy;
    if (busy) this.pill.innerHTML = `<span class="spin"></span> Claude ищет рёбра…`;
    if (this.mode === 'idle' && !this.sel) this.paintPanel();
  }

  /** The stored doc changed (Claude finished, another device edited). */
  reload() {
    const doc = S.photos.find((p) => p.id === this.photo.id);
    if (!doc || (doc.rev || 0) <= this.rev) return this.refreshStatus();
    if (this.sel && this.text !== this.initial) return; // typing: keep local work
    this.photo = doc;
    this.rev = doc.rev || 0;
    this.edges = structuredClone(doc.edges || []);
    if (this.sel && !this.edges.some((e) => e.id === this.sel)) this.sel = null;
    this.draw();
    this.refreshStatus();
    if (!this.sel) this.paintPanel();
  }

  persist() {
    const doc = S.photos.find((p) => p.id === this.photo.id);
    if (!doc) return;
    doc.edges = structuredClone(this.edges);
    savePhoto(doc);
    this.rev = doc.rev;
    this.photo = doc;
    this.refreshStatus();
  }

  // ---------- view transform
  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cx = this.cw ? this.view.ox + this.cw / 2 / this.k() : null;
    const cy = this.ch ? this.view.oy + this.ch / 2 / this.k() : null;
    this.cw = r.width;
    this.ch = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    if (!this.img) return;
    const s = this.view.s;
    this.view.k0 = Math.min(this.cw / this.img.naturalWidth, this.ch / this.img.naturalHeight);
    if (cx == null || s <= 1.001) this.fit();
    else {
      this.view.ox = cx - this.cw / 2 / this.k();
      this.view.oy = cy - this.ch / 2 / this.k();
      this.draw();
    }
  }
  k() {
    return this.view.k0 * this.view.s;
  }
  fit() {
    if (!this.img || !this.cw) return;
    const iw = this.img.naturalWidth, ih = this.img.naturalHeight;
    this.view.k0 = Math.min(this.cw / iw, this.ch / ih);
    this.view.s = 1;
    this.view.ox = (iw - this.cw / this.view.k0) / 2;
    this.view.oy = (ih - this.ch / this.view.k0) / 2;
    this.draw();
  }
  toImg(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return { x: this.view.ox + (clientX - r.left) / this.k(), y: this.view.oy + (clientY - r.top) / this.k() };
  }
  /** Zoom and pan so the edge sits in the middle of the visible photo. */
  focusEdge(e) {
    if (!this.img || !this.cw) return;
    const iw = this.img.naturalWidth, ih = this.img.naturalHeight;
    const ax = e.x1 * iw, ay = e.y1 * ih, bx = e.x2 * iw, by = e.y2 * ih;
    const span = Math.max(Math.abs(bx - ax) / this.cw, Math.abs(by - ay) / this.ch, 1e-6);
    let k = 0.62 / span;
    k = Math.min(Math.max(k, this.view.k0), this.view.k0 * 5);
    const target = { s: k / this.view.k0, ox: (ax + bx) / 2 - this.cw / 2 / k, oy: (ay + by) / 2 - this.ch / 2 / k };
    this.animateTo(target);
  }
  animateTo(t) {
    const from = { ...this.view };
    const t0 = performance.now();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const step = (now) => {
      const p = reduce ? 1 : Math.min(1, (now - t0) / 220);
      const q = 1 - Math.pow(1 - p, 3);
      this.view.s = from.s + (t.s - from.s) * q;
      this.view.ox = from.ox + (t.ox - from.ox) * q;
      this.view.oy = from.oy + (t.oy - from.oy) * q;
      this.draw();
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------- drawing
  draw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const { ctx, img } = this;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#0b0d10';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      if (!img) return;
      const k = this.k();
      ctx.setTransform(dpr * k, 0, 0, dpr * k, -this.view.ox * dpr * k, -this.view.oy * dpr * k);
      ctx.drawImage(img, 0, 0);
      const list = this.temp ? [...this.edges, this.temp] : this.edges;
      const live = this.sel ? this.liveLabel() : null;
      drawEdges(ctx, list, {
        iw: img.naturalWidth,
        ih: img.naturalHeight,
        lineW: 2.5 / k,
        fontPx: 17 / k,
        colorOf: edgeColor,
        selectedId: this.sel,
        liveText: live,
        prec: S.prec,
      });
      const e = this.edges.find((x) => x.id === this.sel);
      if (e) {
        for (const [x, y] of [[e.x1, e.y1], [e.x2, e.y2]]) {
          ctx.beginPath();
          ctx.arc(x * img.naturalWidth, y * img.naturalHeight, 9 / k, 0, Math.PI * 2);
          ctx.fillStyle = '#fff';
          ctx.fill();
          ctx.lineWidth = 3 / k;
          ctx.strokeStyle = '#111';
          ctx.stroke();
        }
      }
    });
  }
  liveLabel() {
    if (this.text === this.initial) return null;
    const r = parseLength(this.text);
    return r.error ? this.text : r.value === null ? '' : formatLength(r.value, S.prec);
  }
  showLoupe(clientX, clientY) {
    if (!this.img) return;
    const r = this.canvas.getBoundingClientRect();
    const L = this.loupe;
    L.hidden = false;
    const left = clientX - r.left < r.width / 2;
    L.style.left = left ? '' : '10px';
    L.style.right = left ? '10px' : '';
    const c = L.getContext('2d');
    const p = this.toImg(clientX, clientY);
    const z = Math.max(this.k() * 3, 0.6); // loupe pixels per image pixel (canvas is 2x css)
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#000';
    c.fillRect(0, 0, 264, 264);
    c.setTransform(z * 2, 0, 0, z * 2, 132 - p.x * z * 2, 132 - p.y * z * 2);
    c.drawImage(this.img, 0, 0);
    const list = this.temp ? [...this.edges, this.temp] : this.edges;
    drawEdges(c, list, { iw: this.img.naturalWidth, ih: this.img.naturalHeight, lineW: 1.5 / z, fontPx: 11 / z, colorOf: edgeColor, selectedId: this.sel, prec: S.prec });
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.strokeStyle = '#fff';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(132, 104);
    c.lineTo(132, 160);
    c.moveTo(104, 132);
    c.lineTo(160, 132);
    c.stroke();
  }

  // ---------- pointer: pan, pinch, tap to select, drag handles, draw
  bindPointer() {
    const cv = this.canvas;
    const pts = new Map();
    let g = null;
    cv.addEventListener('pointerdown', (e) => {
      try {
        cv.setPointerCapture(e.pointerId);
      } catch {
        /* inactive pointer */
      }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) {
        const p = this.toImg(e.clientX, e.clientY);
        g = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false, ox: this.view.ox, oy: this.view.oy, mode: 'pan' };
        const sel = this.edges.find((x) => x.id === this.sel);
        const tol = 28 / this.k();
        if (sel && this.img) {
          const iw = this.img.naturalWidth, ih = this.img.naturalHeight;
          const d1 = Math.hypot(p.x - sel.x1 * iw, p.y - sel.y1 * ih);
          const d2 = Math.hypot(p.x - sel.x2 * iw, p.y - sel.y2 * ih);
          if (Math.min(d1, d2) <= tol) {
            g.mode = 'handle';
            g.which = d1 <= d2 ? '1' : '2';
          }
        }
        if (g.mode === 'pan' && this.mode === 'draw' && this.img) {
          g.mode = 'draw';
          const q = this.norm(p);
          this.temp = { id: 'temp', note: '', x1: q.x, y1: q.y, x2: q.x, y2: q.y, value: null, src: 'user' };
          this.showLoupe(e.clientX, e.clientY);
        }
      } else if (pts.size === 2) {
        if (g?.mode === 'handle' && g.moved) this.persist();
        this.temp = null;
        this.loupe.hidden = true;
        const [a, b] = [...pts.values()];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        g = { mode: 'pinch', moved: true, d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: this.view.s, anchor: this.toImg(mid.x, mid.y) };
        this.draw();
      }
    });
    cv.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId) || !g) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (g.mode === 'pinch') {
        const [a, b] = [...pts.values()];
        if (!b) return;
        const r = this.canvas.getBoundingClientRect();
        const mid = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
        this.view.s = Math.min(12, Math.max(1, (g.s0 * Math.hypot(a.x - b.x, a.y - b.y)) / g.d0));
        this.view.ox = g.anchor.x - mid.x / this.k();
        this.view.oy = g.anchor.y - mid.y / this.k();
        return this.draw();
      }
      if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) > 8) g.moved = true;
      if (!g.moved) return;
      const q = this.norm(this.toImg(e.clientX, e.clientY));
      if (g.mode === 'draw' && this.temp) {
        this.temp.x2 = q.x;
        this.temp.y2 = q.y;
        this.showLoupe(e.clientX, e.clientY);
      } else if (g.mode === 'handle') {
        const sel = this.edges.find((x) => x.id === this.sel);
        if (sel) {
          sel['x' + g.which] = q.x;
          sel['y' + g.which] = q.y;
        }
        this.showLoupe(e.clientX, e.clientY);
      } else if (g.mode === 'pan') {
        this.view.ox = g.ox - (e.clientX - g.x) / this.k();
        this.view.oy = g.oy - (e.clientY - g.y) / this.k();
      }
      this.draw();
    });
    const up = (e) => {
      if (!pts.delete(e.pointerId)) return;
      if (pts.size || !g) return;
      const done = g;
      g = null;
      this.loupe.hidden = true;
      if (done.mode === 'pinch') {
        if (this.view.s <= 1.02) this.fit();
        return;
      }
      if (done.mode === 'draw') {
        const t = this.temp;
        this.temp = null;
        if (t && done.moved && this.img && Math.hypot((t.x2 - t.x1) * this.img.naturalWidth, (t.y2 - t.y1) * this.img.naturalHeight) * this.k() > 16) {
          t.id = uid();
          this.edges.push(t);
          this.mode = 'idle';
          this.persist();
          this.select(t.id);
        } else this.draw();
        return;
      }
      if (done.mode === 'handle') {
        if (done.moved) this.persist();
        return this.draw();
      }
      if (!done.moved && this.img) {
        // tap: select the nearest edge or its label
        const p = this.toImg(e.clientX, e.clientY);
        const hit = this.hit(p);
        if (hit) this.select(hit.id, { focus: false });
        else if (this.sel) this.deselect();
      }
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
  }
  norm(p) {
    const c = (v) => Math.min(1, Math.max(0, v));
    return { x: c(p.x / this.img.naturalWidth), y: c(p.y / this.img.naturalHeight) };
  }
  hit(p) {
    const iw = this.img.naturalWidth, ih = this.img.naturalHeight;
    const tol = 24 / this.k();
    let best = null;
    let bd = tol;
    for (let i = this.edges.length - 1; i >= 0; i--) {
      const e = this.edges[i];
      const a = { x: e.x1 * iw, y: e.y1 * ih }, b = { x: e.x2 * iw, y: e.y2 * ih };
      const dx = b.x - a.x, dy = b.y - a.y;
      const L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
      let d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
      // the label sits ~1 font height beside the middle of the line
      const lx = (a.x + b.x) / 2, ly = (a.y + b.y) / 2;
      d = Math.min(d, Math.hypot(p.x - lx, p.y - ly) - 22 / this.k());
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  // ---------- selection & keypad
  select(id, { focus = true } = {}) {
    if (this.sel && this.sel !== id) this.commit();
    const e = this.edges.find((x) => x.id === id);
    if (!e) return;
    this.sel = id;
    this.mode = 'idle';
    this.text = typeof e.value === 'number' ? formatPlain(e.value, S.prec) : '';
    this.initial = this.text;
    this.paintPanel();
    this.resize(); // the keypad changed the photo area: measure it now
    if (focus) this.focusEdge(e);
    else this.draw();
  }
  deselect() {
    this.commit();
    this.sel = null;
    this.paintPanel();
    this.draw();
  }
  /** Save the typed value of the selected edge. Returns false when it does not parse. */
  commit() {
    const e = this.edges.find((x) => x.id === this.sel);
    if (!e || this.text === this.initial) return true;
    const r = parseLength(this.text);
    if (r.error) {
      toast('Размер не понят: ' + this.text);
      return false;
    }
    e.value = r.value;
    this.initial = this.text;
    this.persist();
    return true;
  }
  nextEdge() {
    if (!this.commit()) return;
    const i = this.edges.findIndex((x) => x.id === this.sel);
    const order = [...this.edges.slice(i + 1), ...this.edges.slice(0, Math.max(0, i))];
    const next = order.find((x) => typeof x.value !== 'number');
    if (next) return this.select(next.id);
    // this photo is done: offer the next photo with missing sizes
    const list = this.photos();
    const j = list.findIndex((p) => p.id === this.photo.id);
    const rest = [...list.slice(j + 1), ...list.slice(0, j)];
    const other = rest.find((p) => (p.edges || []).some((e) => typeof e.value !== 'number'));
    this.sel = null;
    this.fit();
    if (other) {
      toast('На этом фото всё. Открываю следующее.');
      const firstMissing = other.edges.find((e) => typeof e.value !== 'number');
      openEditor(other.id, firstMissing?.id);
    } else {
      toast('Все размеры введены 👍');
      this.paintPanel();
    }
  }

  paintPanel() {
    const P = this.panel;
    const doc = S.photos.find((p) => p.id === this.photo.id) || this.photo;
    if (!this.sel) this.el.querySelector('.value-pill').hidden = true;
    if (this.mode === 'draw') {
      P.innerHTML = `<div class="ed-hint">Проведите пальцем вдоль ребра. Двумя пальцами — увеличить.</div>
        <div class="ed-actions" style="grid-template-columns:1fr"><button class="btn" data-e="cancel-draw">Отмена</button></div>`;
      return;
    }
    const e = this.edges.find((x) => x.id === this.sel);
    if (!e) {
      const c = counts([{ edges: this.edges }]);
      const busy = S.analyzing.has(doc.id) || queue.includes(doc.id);
      const hint = busy
        ? 'Claude ищет рёбра на фото. Можно пока добавить своё ребро.'
        : doc.status === 'error' && doc.error
          ? doc.error
          : c.total
            ? 'Нажмите на ребро или «Вводить размеры». Двумя пальцами — увеличить.'
            : 'Рёбер пока нет. Добавьте своё или запустите разметку.';
      P.innerHTML = `<div class="ed-hint">${esc(hint)}</div>
        <div class="ed-actions">
          <button class="btn" data-e="draw">＋ Ребро</button>
          ${c.total > c.done ? `<button class="btn primary" data-e="start">Вводить размеры</button>` : `<button class="btn" data-e="reanalyze" ${busy ? 'disabled' : ''}>Разметить снова</button>`}
        </div>`;
      return;
    }
    const fr = this.fr16 && S.prec === 16 ? ['1/16', '3/16', '5/16', '7/16', '9/16', '11/16', '13/16', '15/16'] : ['1/8', '1/4', '3/8', '1/2', '5/8', '3/4', '7/8', 'nofrac'];
    const key = (k, label = k, cls = '') => `<button class="key ${cls}" data-k="${esc(k)}">${esc(label)}</button>`;
    const digits = [['7', '8', '9'], ['4', '5', '6'], ['1', '2', '3'], ["'", '0', '.']];
    const rows = digits
      .map((r, i) => r.map((d) => key(d, d === "'" ? "' фут" : d, d === "'" ? 'fn' : '')).join('') + '<span class="gap"></span>' + key(fr[i * 2], fr[i * 2], 'fr') + key(fr[i * 2 + 1], fr[i * 2 + 1] === 'nofrac' ? '—' : fr[i * 2 + 1], 'fr'))
      .join('');
    P.innerHTML = `
      <div class="kb-head">
        <button class="kb-note ${e.note ? '' : 'empty'}" data-e="note">✎ ${e.note ? esc(e.note) : 'Примечание: от чего до чего'}</button>
        ${S.prec === 16 ? `<button class="kb-prec ${this.fr16 ? 'on' : ''}" data-e="fr16" aria-label="Шестнадцатые">${this.fr16 ? '← 1/8' : '1/16 →'}</button>` : '<span></span>'}
        <button class="kb-prec kb-del" data-e="del" aria-label="Удалить ребро">🗑</button>
      </div>
      <div class="keys">${rows}</div>
      <div class="kb-foot">
        <button class="key fn back" data-k="back" aria-label="Стереть (удерживать — стереть всё)">⌫ Стереть</button>
        <button class="btn" data-e="done">Готово</button>
        <button class="btn primary" data-e="next">Далее ›</button>
      </div>`;
    this.paintValue();
  }
  paintValue() {
    const pill = this.el.querySelector('.value-pill');
    const e = this.edges.find((x) => x.id === this.sel);
    pill.hidden = !e;
    if (!e) return this.draw();
    const t = pill.querySelector('.typed');
    t.textContent = this.text ? this.text + '"' : '—';
    const r = parseLength(this.text);
    const res = pill.querySelector('.res');
    res.classList.toggle('err', r.error);
    res.textContent = r.error ? 'не понимаю' : r.value === null ? 'введите размер' : '= ' + formatLength(r.value, S.prec);
    this.draw();
  }

  async onClick(ev) {
    const k = ev.target.closest('[data-k]')?.dataset.k;
    if (k && this.skipClick) {
      this.skipClick = false;
      return;
    }
    if (k) {
      const b = ev.target.closest('[data-k]');
      b.classList.add('pressed');
      setTimeout(() => b.classList.remove('pressed'), 120);
      if (k === 'nofrac') this.text = this.text.replace(/\s*\d+\/\d+$/, '');
      else this.text = applyKey(this.text, k);
      if (this.fr16 && /\/16$/.test(k)) {
        this.fr16 = false;
        this.paintPanel();
      }
      return this.paintValue();
    }
    const a = ev.target.closest('[data-e]')?.dataset.e;
    if (!a) return;
    switch (a) {
      case 'close':
        return this.close();
      case 'menu':
        return this.menu();
      case 'draw':
        this.commit();
        this.sel = null;
        this.mode = 'draw';
        this.paintPanel();
        return this.draw();
      case 'cancel-draw':
        this.mode = 'idle';
        this.temp = null;
        this.paintPanel();
        return this.draw();
      case 'start': {
        const first = this.edges.find((x) => typeof x.value !== 'number');
        if (first) this.select(first.id);
        return;
      }
      case 'reanalyze':
        return analyze(this.photo.id);
      case 'fr16':
        this.fr16 = !this.fr16;
        return this.paintPanel();
      case 'done':
        if (!this.commit()) return;
        this.sel = null;
        this.paintPanel();
        return this.draw();
      case 'next':
        return this.nextEdge();
      case 'note': {
        const e = this.edges.find((x) => x.id === this.sel);
        if (!e) return;
        const r = await sheet({
          title: 'Примечание к ребру',
          text: 'Откуда и докуда идёт размер, например: от верха фанеры до низа фасции.',
          input: { value: e.note || '', placeholder: 'от … до …' },
          options: [{ label: 'Сохранить', value: true, cls: 'primary' }],
        });
        if (!r) return;
        e.note = r.text.slice(0, 160);
        this.persist();
        return this.paintPanel();
      }
      case 'del': {
        const e = this.edges.find((x) => x.id === this.sel);
        if (!e) return;
        const ok = await sheet({ title: 'Удалить ребро?', text: [e.note, typeof e.value === 'number' ? fmt(e.value) : ''].filter(Boolean).join(' · ') || 'Ребро без размера', options: [{ label: 'Удалить', value: true, cls: 'danger' }] });
        if (!ok) return;
        this.edges = this.edges.filter((x) => x.id !== e.id);
        this.sel = null;
        this.persist();
        this.paintPanel();
        return this.draw();
      }
    }
  }

  async menu() {
    const doc = S.photos.find((p) => p.id === this.photo.id) || this.photo;
    const busy = S.analyzing.has(doc.id) || queue.includes(doc.id);
    const v = await sheet({
      title: 'Фото',
      options: [
        ...(this.edges.some((e) => typeof e.value !== 'number')
          ? [{ label: `Удалить рёбра без размеров (${this.edges.filter((e) => typeof e.value !== 'number').length})`, sub: 'Только на этом фото. Рёбра с размерами останутся.', value: 'empty' }]
          : []),
        { label: 'Разметить снова', sub: 'Claude заново найдёт рёбра. Введённые размеры и ваши рёбра останутся.', value: 're' },
        { label: 'Удалить фото', value: 'del', cls: 'danger' },
      ],
    });
    if (v === 'empty') {
      this.commit();
      this.edges = this.edges.filter((e) => typeof e.value === 'number');
      this.sel = null;
      this.persist();
      this.paintPanel();
      this.draw();
      return toast('Рёбра без размеров удалены');
    }
    if (v === 're') {
      if (busy) return toast('Claude уже размечает это фото.');
      return analyze(doc.id);
    }
    if (v === 'del') {
      const ok = await sheet({ title: 'Удалить фото?', text: 'Фото и все его размеры будут удалены. Это нельзя отменить.', options: [{ label: 'Удалить навсегда', value: true, cls: 'danger' }] });
      if (!ok) return;
      await S.db.doc('photos/' + doc.id).delete().catch(() => {});
      await S.assets?.delete(doc.assetId).catch(() => {});
      S.photos = S.photos.filter((p) => p.id !== doc.id);
      const p = S.projects.find((x) => x.id === doc.projectId);
      if (p && p.coverAssetId === doc.assetId) {
        p.coverAssetId = projectPhotos(p.id)[0]?.assetId || null;
        saveProject(p);
      }
      this.sel = null;
      this.initial = this.text;
      this.close();
      toast('Фото удалено');
    }
  }
}

// ---------------------------------------------------------------- start

async function start() {
  render();
  const [db, assets, sample, downloads] = await Promise.all(['db', 'assets', 'sample', 'downloads'].map((n) => window.claude?.use?.(n).catch(() => null) ?? Promise.resolve(null)));
  Object.assign(S, { db, assets, sample, downloads });
  if (!db) {
    S.ready = true;
    S.noDb = true;
    return render();
  }
  const timer = setTimeout(() => {
    if (!S.ready) toast('Данные пока недоступны. Проверьте интернет.', 5000);
  }, 10000);
  let gotP = false, gotPh = false;
  const done = () => {
    if (gotP && gotPh && !S.ready) {
      S.ready = true;
      clearTimeout(timer);
    }
    render();
    if (ed) ed.reload();
  };
  db.collection('projects').onSnapshot(
    (snap) => {
      S.projects = snap.docs.map((d) => ({ id: d.id, ...structuredClone(d.data()) }));
      gotP = true;
      done();
    },
    () => {
      gotP = true;
      done();
    }
  );
  db.collection('photos').onSnapshot(
    (snap) => {
      const fresh = snap.docs.map((d) => ({ id: d.id, ...structuredClone(d.data()) }));
      // keep local copies that have newer revisions than the server echo
      S.photos = fresh.map((f) => {
        const local = S.photos.find((p) => p.id === f.id);
        return local && (local.rev || 0) > (f.rev || 0) ? local : f;
      });
      gotPh = true;
      done();
    },
    () => {
      gotPh = true;
      done();
    }
  );
}

start();
