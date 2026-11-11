// Site Measure: photos of an object -> you mark the edges -> type the sizes in inches.
// Everything is stored on the phone (IndexedDB); no account, no server, works offline.

import { parseLength, formatLength, formatPlain, applyKey } from './units.js';
import { allEdges, toCsv, makeZip, readZip, makePdf, fileSlug } from './export.js';
import { db, assets, assetUrl, loadAssets, persist } from './store.js';

// ---------------------------------------------------------------- state

// Keep in step with VERSION in sw.js (a test checks it); shown at the bottom of the home screen.
const APP_VERSION = 'v12';

const S = {
  ready: false,
  projects: [],
  photos: [],
  view: 'home', // home | project
  projectId: null,
  tab: 'photos', // photos | table
  prec: 16,
};
try {
  S.prec = +localStorage.getItem('sm.prec') === 8 ? 8 : 16;
} catch {
  /* storage blocked */
}

const app = document.getElementById('app');
const imgCache = new Map(); // assetId -> Promise<HTMLImageElement>

const uid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Date.now().toString(36) + Math.random().toString(36).slice(2));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (v) => (typeof v === 'number' ? formatLength(v, S.prec) : '');
const blobUrl = (id) => assetUrl(id);
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
      await db.doc(path).set(d);
    } catch (e) {
      toast('Не удалось сохранить: на телефоне закончилось место?');
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
    wrap.className = input ? 'sheet-wrap top' : 'sheet-wrap';
    const field = !input
      ? ''
      : input.multiline
        ? `<textarea id="sheet-input" rows="5" placeholder="${esc(input.placeholder || '')}" autocomplete="off">${esc(input.value || '')}</textarea>`
        : `<input type="text" id="sheet-input" value="${esc(input.value || '')}" placeholder="${esc(input.placeholder || '')}" autocomplete="off">`;
    wrap.innerHTML = `<div class="sheet" role="dialog" aria-label="${esc(title)}">
      <h2>${esc(title)}</h2>${text ? `<p>${esc(text)}</p>` : ''}
      ${field}
      ${options.map((o, i) => `<button class="btn block ${o.cls || ''} ${o.sub ? 'opt' : ''}" data-i="${i}">${esc(o.label)}${o.sub ? `<small>${esc(o.sub)}</small>` : ''}</button>`).join('')}
      <button class="btn block" data-i="-1">Отмена</button></div>`;
    const done = (v) => {
      wrap.remove();
      resolve(v);
    };
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) return input ? undefined : done(null); // a stray tap must not lose typed text
      const b = e.target.closest('[data-i]');
      if (!b) return;
      const i = +b.dataset.i;
      if (i < 0) return done(null);
      const o = options[i];
      done(input ? { value: o.value, text: wrap.querySelector('#sheet-input').value.trim() } : o.value);
    });
    document.body.append(wrap);
    if (input)
      setTimeout(() => {
        const f = wrap.querySelector('#sheet-input');
        if (!f) return;
        f.focus();
        f.setSelectionRange?.(f.value.length, f.value.length); // cursor at the end, ready to edit
      }, 50);
  });
}

function loadImage(assetId) {
  if (!imgCache.has(assetId)) {
    imgCache.set(
      assetId,
      (async () => {
        let url = assetUrl(assetId);
        if (!url) url = URL.createObjectURL(await assets.get(assetId));
        return new Promise((resolve, reject) => {
          const im = new Image();
          im.onload = () => resolve(im);
          im.onerror = () => reject(new Error('фото не загрузилось'));
          im.src = url;
        });
      })().catch((e) => {
        imgCache.delete(assetId);
        throw e;
      })
    );
  } else {
    const p = imgCache.get(assetId); // mark as recently used
    imgCache.delete(assetId);
    imgCache.set(assetId, p);
  }
  // full-resolution photos take ~50 MB each once decoded: keep only the last few in memory
  while (imgCache.size > 3) imgCache.delete(imgCache.keys().next().value);
  return imgCache.get(assetId);
}

/** Re-encode a picked photo as JPEG at full camera resolution (long side <= 4032) so the loupe stays sharp. */
async function compress(file) {
  const url = URL.createObjectURL(file);
  try {
    const im = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('формат фото не поддерживается'));
      i.src = url;
    });
    // iPhone limits canvas memory; if the full size does not fit, step down instead of failing.
    for (const long of [4032, 3072, 2048]) {
      const k = Math.min(1, long / Math.max(im.naturalWidth, im.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(im.naturalWidth * k);
      c.height = Math.round(im.naturalHeight * k);
      const ctx = c.getContext('2d');
      let blob = null;
      if (ctx) {
        ctx.drawImage(im, 0, 0, c.width, c.height);
        blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9));
      }
      const size = { w: c.width, h: c.height };
      c.width = c.height = 0; // free the canvas memory right away (iOS keeps it otherwise)
      if (blob && blob.size > 0) return { blob, ...size };
    }
    throw new Error('не хватило памяти телефона, чтобы обработать фото');
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
    if (o.labels === false) continue;
    // label beside the line (above, or left of a vertical line)
    let px = nx, py = ny;
    if (py > 0.01 || (Math.abs(py) <= 0.01 && px > 0)) {
      px = -px;
      py = -py;
    }
    let text = sel && o.liveText != null ? o.liveText || '…' : typeof e.value === 'number' ? formatLength(e.value, o.prec) : '?';
    const no = o.numberOf?.(e);
    if (no) text = `${no} · ${text}`;
    ctx.font = `700 ${o.fontPx}px -apple-system, system-ui, sans-serif`;
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

/** Measured edges of a photo. Only edges with a note get a number (1..n), matching the note list in the report. */
function measured(ph) {
  let n = 0;
  return (ph.edges || []).filter((e) => typeof e.value === 'number').map((e) => ({ ...e, no: e.note?.trim() ? ++n : null }));
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

// ---------------------------------------------------------------- adding photos

async function addPhotos(files) {
  const p = project();
  if (!p || !files.length) return;
  let order = Math.max(0, ...projectPhotos().map((x) => x.order || 0));
  let last = null;
  for (const file of files) {
    try {
      toast('Сохраняю фото…', 1200);
      const { blob, w, h } = await compress(file);
      const up = await assets.upload(blob);
      const ph = { id: uid(), projectId: p.id, assetId: up.id, w, h, order: ++order, edges: [], rev: 0, createdAt: Date.now() };
      S.photos.push(ph);
      if (!p.coverAssetId) p.coverAssetId = up.id;
      savePhoto(ph);
      saveProject(p);
      last = ph;
    } catch (e) {
      // full technical text on purpose: it tells what went wrong on this particular phone
      toast(`Не удалось сохранить фото: ${[e?.name, e?.message].filter(Boolean).join(' — ') || String(e)}`, 9000);
    }
  }
  render();
  // one new photo: go straight to marking edges on it
  if (files.length === 1 && last) openEditor(last.id, null, { draw: true });
}

// ---------------------------------------------------------------- screens

function render() {
  if (ed) ed.refreshStatus();
  if (!S.ready) {
    app.innerHTML = `<header class="hero"><div class="hero-in"><div class="brand">${LOGO}<div><h1>Site Measure</h1><p><span class="spin"></span> Загружаю объекты…</p></div></div></div></header>`;
    return;
  }
  if (S.view === 'project' && project()) renderProject();
  else renderHome();
}

// Line icons (stroke = currentColor) for buttons: crisper and more consistent than emoji.
const ICON = {
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/></svg>',
  gallery: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></svg>',
};
const LOGO = '<img class="logo" src="icons/icon-192.png" alt="" width="56" height="56">';

function renderHome() {
  S.view = 'home';
  const list = [...S.projects].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const all = counts(S.photos);
  app.innerHTML = `<header class="hero"><div class="hero-in">
      <div class="brand">${LOGO}<div><h1>Site Measure</h1><p>Замеры на объекте: фото, рёбра, дюймы</p></div></div>
      <div class="stats num">
        <div><b>${S.projects.length}</b><span>объектов</span></div>
        <div><b>${S.photos.length}</b><span>фото</span></div>
        <div><b>${all.done}</b><span>размеров</span></div>
      </div>
    </div></header>
    <main class="page">
      <h2 class="section">Объекты</h2>
      <div class="projects">
        ${list.length ? '' : `<div class="empty"><b>Объектов пока нет</b>Нажмите «Новый объект», сфотографируйте объект с нескольких сторон и отметьте рёбра.</div>`}
        ${list
          .map((p) => {
            const ph = projectPhotos(p.id);
            const c = counts(ph);
            const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
            return `<button class="pcard" data-open="${esc(p.id)}">
              <span class="cover" ${p.coverAssetId ? `style="background-image:url('${blobUrl(p.coverAssetId)}')"` : ''}>${p.coverAssetId ? '' : ICON.camera}</span>
              <span class="pbody">
                <span class="t">${esc(p.name || 'Без названия')}</span>
                ${p.address ? `<span class="s">${esc(p.address)}</span>` : ''}
                <span class="chips num"><span>${ph.length} фото</span><span class="${c.total && c.done === c.total ? 'ok' : ''}">${c.done} / ${c.total} размеров</span>${p.date ? `<span>${esc(p.date)}</span>` : ''}</span>
                <span class="meter"><i style="width:${pct}%"></i></span>
              </span>
            </button>`;
          })
          .join('')}
      </div>
      <label class="restore">Восстановить объект из резервной копии<input type="file" accept=".zip,application/zip" data-restore hidden></label>
      <p class="version">Site Measure · версия ${APP_VERSION.slice(1)}</p>
    </main>
    <div class="dock"><div class="row one"><button class="btn primary block" data-act="new">${ICON.plus}Новый объект</button></div></div>`;
}

function renderProject() {
  const p = project();
  const photos = projectPhotos();
  const c = counts(photos);
  const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
  const scrollY = window.scrollY;
  app.innerHTML = `<header class="hero compact"><div class="hero-in">
      <div class="hero-bar">
        <button class="glass" data-act="home" aria-label="К объектам">${ICON.back}</button>
        <img class="logo sm" src="icons/icon-192.png" alt="" width="34" height="34">
        <span class="spacer"></span>
        <button class="glass" data-act="export" aria-label="Экспорт">${ICON.share}</button>
        <button class="glass" data-act="pmenu" aria-label="Ещё">${ICON.more}</button>
      </div>
      <input class="name" id="p-name" data-pf="name" value="${esc(p.name)}" placeholder="Название объекта" autocomplete="off">
      <input class="addr" id="p-addr" data-pf="address" value="${esc(p.address)}" placeholder="Адрес" autocomplete="off">
      <div class="progress-band num"><span class="bar"><i style="width:${pct}%"></i></span><span>${c.done} из ${c.total} размеров</span></div>
    </div></header>
    <main class="page">
      <div class="seg" role="tablist">
        <button class="${S.tab === 'photos' ? 'on' : ''}" data-tab="photos">Фото <em class="num">${photos.length}</em></button>
        <button class="${S.tab === 'table' ? 'on' : ''}" data-tab="table">Размеры <em class="num">${c.done}/${c.total}</em></button>
      </div>
      ${S.tab === 'photos' ? photosHtml(photos) : tableHtml(photos)}
    </main>
    <div class="dock"><div class="row">
      <label class="btn primary">${ICON.camera}Снять<input type="file" accept="image/*" capture="environment" data-add></label>
      <label class="btn">${ICON.gallery}Из галереи<input type="file" accept="image/*" multiple data-add></label>
    </div></div>`;
  window.scrollTo(0, scrollY);
  drawTileOverlays(photos);
}

function photosHtml(photos) {
  if (!photos.length) return `<div class="empty"><b>Фото пока нет</b>Сделайте несколько фото объекта с разных сторон. На каждом фото отметьте пальцем рёбра и впишите размеры.</div>`;
  return `<div class="grid">${photos
    .map((ph, i) => {
      const c = counts([ph]);
      const badge = c.total ? `<span class="badge ${c.done === c.total ? 'done' : ''} num">${c.done}/${c.total}</span>` : `<span class="badge">нет рёбер</span>`;
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
  if (!rows.length) return `<div class="empty"><b>Размеров пока нет</b>Откройте фото, добавьте рёбра и впишите размеры.</div>`;
  return photos
    .map((ph, i) => {
      const edges = rows.filter((r) => r.photoNo === i + 1);
      if (!edges.length) return '';
      const done = edges.filter((e) => typeof e.value === 'number').length;
      return `<section class="plane"><h3><img class="thumb" src="${blobUrl(ph.assetId)}" alt="">Фото ${i + 1}<small class="num">${done}/${edges.length}</small></h3>
        ${edges
          .map(
            (e) => `<button class="rowbtn" data-photo="${esc(ph.id)}" data-edge="${esc(e.id)}">
              <span class="l"><b class="no num">${e.no ?? ''}</b>${e.note ? esc(e.note) : '<i>без примечания</i>'}</span>
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
  if (e.target.matches('[data-restore]')) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) restoreBackup(f);
    return;
  }
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
      { label: 'Резервная копия', sub: 'Все фото и размеры объекта одним ZIP. Сохраните в Файлы или iCloud.', value: 'backup' },
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
  if (v === 'backup') return backup(p);
  if (v === 'delete') {
    const photos = projectPhotos();
    const ok = await sheet({
      title: 'Удалить объект?',
      text: `«${p.name || 'Без названия'}», ${photos.length} фото и все размеры будут удалены. Это нельзя отменить.`,
      options: [{ label: 'Удалить навсегда', value: true, cls: 'danger' }],
    });
    if (!ok) return;
    for (const ph of photos) {
      await db.doc('photos/' + ph.id).delete().catch(() => {});
      await assets.delete(ph.assetId).catch(() => {});
    }
    await db.doc('projects/' + p.id).delete().catch(() => {});
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
  const v = await sheet({
    title: 'Экспорт',
    text: 'Готовый файл откроется в меню «Поделиться»: в Файлы, на почту или в мессенджер.',
    options: [
      { label: 'PDF-отчёт', sub: 'Каждое фото на своей странице с размерами и примечаниями, формат Letter', value: 'pdf', cls: 'primary' },
      { label: 'Таблица CSV', sub: 'Открывается в Excel и Google Таблицах', value: 'csv' },
      { label: 'Всё одним ZIP', sub: 'PDF, CSV и фото с размерами', value: 'zip' },
    ],
  });
  if (!v) return;
  const base = fileSlug(p.name) + '_' + (p.date || today());
  try {
    if (v === 'csv') return offerFile(base + '.csv', new Blob([toCsv(allEdges(photos), S.prec)], { type: 'text/csv' }));
    toast('Готовлю файлы…', 2500);
    const pdf = await buildReport(p, photos);
    if (v === 'pdf') return offerFile(base + '.pdf', new Blob([pdf], { type: 'application/pdf' }));
    const rows = allEdges(photos);
    const files = [
      { name: 'report.pdf', data: pdf },
      { name: 'sizes.csv', data: toCsv(rows, S.prec) },
    ];
    for (let i = 0; i < photos.length; i++) {
      const j = await annotatedJpeg(photos[i], p.id);
      files.push({ name: `photos/${String(i + 1).padStart(2, '0')}.jpg`, data: j.bytes });
    }
    offerFile(base + '.zip', new Blob([makeZip(files)], { type: 'application/zip' }));
  } catch (e) {
    toast('Экспорт не удался: ' + (e?.message || e?.code || 'ошибка'));
  }
}

/**
 * Hand a ready file to the user. Building a PDF takes a moment, and iOS only opens the share
 * sheet straight from a tap, so the file is offered on a button that calls share() synchronously.
 */
function offerFile(filename, blob) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  const canShare = !!navigator.canShare?.({ files: [file] });
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-label="Файл готов">
    <h2>Файл готов</h2><p>${esc(filename)} · ${(blob.size / 1048576).toFixed(1)} МБ</p>
    <button class="btn block primary" data-go>${canShare ? 'Поделиться / Сохранить в Файлы' : 'Скачать'}</button>
    <button class="btn block" data-x>Закрыть</button></div>`;
  wrap.addEventListener('click', (e) => {
    if (e.target.closest('[data-x]') || e.target === wrap) return wrap.remove();
    if (!e.target.closest('[data-go]')) return;
    if (canShare) {
      navigator.share({ files: [file] }).then(
        () => wrap.remove(),
        (err) => {
          if (err?.name !== 'AbortError') download(file);
        }
      );
    } else {
      download(file);
      wrap.remove();
    }
  });
  document.body.append(wrap);
}

function download(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------------------------------------------------------------- backup & restore

const BACKUP = 'site-measure-backup';

async function backup(p) {
  try {
    toast('Готовлю копию…', 2000);
    const photos = projectPhotos(p.id);
    const files = [{ name: 'backup.json', data: JSON.stringify({ format: BACKUP, version: 2, project: p, photos }) }];
    for (const ph of photos) {
      const b = await assets.get(ph.assetId);
      if (b) files.push({ name: `photos/${ph.assetId}.jpg`, data: new Uint8Array(await b.arrayBuffer()) });
    }
    offerFile(`${fileSlug(p.name)}_backup_${today()}.zip`, new Blob([makeZip(files)], { type: 'application/zip' }));
  } catch (e) {
    toast('Копия не получилась: ' + (e?.message || 'ошибка'));
  }
}

async function restoreBackup(file) {
  let data;
  let entries;
  try {
    entries = readZip(new Uint8Array(await file.arrayBuffer()));
    data = JSON.parse(new TextDecoder().decode(entries.get('backup.json')));
    if (data?.format !== BACKUP || !data.project?.id || !Array.isArray(data.photos)) throw new Error();
  } catch {
    return toast('Это не резервная копия Site Measure.');
  }
  let { project: p, photos } = data;
  if (S.projects.some((x) => x.id === p.id)) {
    const v = await sheet({
      title: 'Такой объект уже есть',
      text: `«${p.name || 'Без названия'}» уже есть на телефоне.`,
      options: [
        { label: 'Сохранить как копию', value: 'copy', cls: 'primary' },
        { label: 'Заменить', value: 'replace', cls: 'danger' },
      ],
    });
    if (!v) return;
    if (v === 'copy') {
      const map = new Map();
      p = { ...p, id: uid(), name: `${p.name || 'Объект'} (копия)` };
      photos = photos.map((ph) => {
        const assetId = uid();
        map.set(ph.assetId, assetId);
        return { ...ph, id: uid(), projectId: p.id, assetId };
      });
      for (const [from, to] of map) entries.set(`photos/${to}.jpg`, entries.get(`photos/${from}.jpg`));
      p.coverAssetId = map.get(p.coverAssetId) || photos[0]?.assetId || null;
    } else {
      for (const ph of projectPhotos(p.id)) {
        await db.doc('photos/' + ph.id).delete();
        await assets.delete(ph.assetId).catch(() => {});
      }
    }
  }
  for (const ph of photos) {
    const bytes = entries.get(`photos/${ph.assetId}.jpg`);
    if (bytes) await assets.put(ph.assetId, new Blob([bytes], { type: 'image/jpeg' }));
    await db.doc('photos/' + ph.id).set(strip(ph));
  }
  await db.doc('projects/' + p.id).set(strip(p));
  S.projectId = p.id;
  S.view = 'project';
  S.tab = 'photos';
  toast('Объект восстановлен');
}

/** PDF: one Letter page per photo, in the app's look: branded header, photo card, numbered notes, footer. */
async function buildReport(p, photos) {
  const pages = [];
  for (let i = 0; i < photos.length; i++) pages.push(await reportPage(photos[i], p, i + 1, photos.length));
  return makePdf(pages);
}

let logoImg = null;
function loadLogo() {
  if (!logoImg)
    logoImg = new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => resolve(null); // the report still works without the logo
      im.src = 'icons/icon-512.png';
    });
  return logoImg;
}

/** Split text into lines that fit maxW with the current ctx.font. */
function wrapText(ctx, text, maxW) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    const t = line ? line + ' ' + word : word;
    if (ctx.measureText(t).width <= maxW || !line) line = t;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function rr(ctx, x, y, w, h, r) {
  roundRect(ctx, x, y, w, h, r);
}

/** One page rendered on a canvas (150 dpi) so Cyrillic needs no PDF fonts. */
async function reportPage(ph, p, pageNo, pageCount) {
  const W = 1275, H = 1650, M = 56;
  const NAVY = '#0b2554', NAVY2 = '#1a4596', TAPE = '#ffc800';
  const FONT = '-apple-system, "Segoe UI", system-ui, sans-serif';
  const COND = '"Avenir Next Condensed", "Arial Narrow", ' + FONT;
  const [img, logo] = await Promise.all([loadImage(ph.assetId), loadLogo()]);
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const edges = measured(ph);
  const notes = edges.filter((e) => e.no);

  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f2f5fa';
  ctx.fillRect(0, 0, W, H);

  // ---- header: navy plate with a blueprint grid and a tape-measure stripe
  const HH = 210;
  const g = ctx.createRadialGradient(W, 0, 0, W, 0, W * 0.9);
  g.addColorStop(0, NAVY2);
  g.addColorStop(1, NAVY);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, HH);
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= W; x += 34) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, HH);
  }
  for (let y = 0; y <= HH; y += 34) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(W, y + 0.5);
  }
  ctx.stroke();
  ctx.fillStyle = TAPE;
  ctx.fillRect(0, HH, W, 14);
  ctx.fillStyle = '#1d1d1d';
  for (let x = 0, i = 0; x < W; x += 12.5, i++) ctx.fillRect(Math.round(x), HH, 2, i % 10 === 0 ? 14 : i % 2 === 0 ? 9 : 5);

  if (logo) {
    ctx.save();
    rr(ctx, M, 46, 118, 118, 26);
    ctx.clip();
    ctx.drawImage(logo, M, 46, 118, 118);
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 3;
    rr(ctx, M, 46, 118, 118, 26);
    ctx.stroke();
  }
  const tx = M + 146;
  const rightW = 230;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = TAPE;
  ctx.font = `700 22px ${FONT}`;
  ctx.fillText('SITE MEASURE  ·  ОТЧЁТ О ЗАМЕРАХ', tx, 72);
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 50px ${COND}`;
  ctx.fillText(p.name || 'Объект без названия', tx, 128, W - tx - M - rightW);
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.font = `500 26px ${FONT}`;
  ctx.fillText(p.address || 'Адрес не указан', tx, 170, W - tx - M - rightW);

  // right side: "Фото N из M" pill and the date
  ctx.textAlign = 'right';
  ctx.font = `700 26px ${FONT}`;
  const pill = `Фото ${pageNo} из ${pageCount}`;
  const pw0 = ctx.measureText(pill).width + 40;
  ctx.fillStyle = TAPE;
  rr(ctx, W - M - pw0, 52, pw0, 48, 24);
  ctx.fill();
  ctx.fillStyle = '#1d1d1d';
  ctx.fillText(pill, W - M - 20, 85);
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.font = `500 24px ${FONT}`;
  ctx.fillText(p.date || today(), W - M, 150);

  // ---- notes block (measured first so the photo gets the rest of the page)
  ctx.font = `500 25px ${FONT}`;
  const noteLines = notes.map((e) => ({ e, lines: wrapText(ctx, e.note, W - 2 * M - 230) }));
  const LH = 34;
  const notesH = notes.length ? 30 + noteLines.reduce((s, n) => s + n.lines.length * LH + 18, 0) : 0;

  // ---- photo card
  const FOOT = 70;
  const top = HH + 14 + 34;
  const boxW = W - 2 * M;
  const boxH = H - top - FOOT - notesH - 20;
  const pad = 14;
  const k = Math.min((boxW - 2 * pad) / iw, (boxH - 2 * pad) / ih);
  const pw = iw * k, phh = ih * k;
  const cw = pw + 2 * pad, ch = phh + 2 * pad;
  const cx = (W - cw) / 2, cy = top;
  ctx.save();
  ctx.shadowColor = 'rgba(11,37,84,0.18)';
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 10;
  ctx.fillStyle = '#ffffff';
  rr(ctx, cx, cy, cw, ch, 24);
  ctx.fill();
  ctx.restore();
  ctx.save();
  rr(ctx, cx + pad, cy + pad, pw, phh, 14);
  ctx.clip();
  ctx.setTransform(k, 0, 0, k, cx + pad, cy + pad);
  ctx.drawImage(img, 0, 0);
  drawEdges(ctx, edges, { iw, ih, lineW: 1.6 / k, fontPx: 15 / k, colorOf: edgeColor, prec: S.prec, numberOf: (e) => e.no });
  ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // ---- notes: yellow numbered circles, size in bold, note text wrapped
  let y = cy + ch + 30;
  if (notes.length) {
    ctx.textAlign = 'left';
    ctx.fillStyle = NAVY;
    ctx.font = `700 26px ${COND}`;
    ctx.fillText('ПРИМЕЧАНИЯ', M, y + 4);
    y += 26;
    for (const { e, lines } of noteLines) {
      const rowH = lines.length * LH + 8;
      ctx.fillStyle = '#ffffff';
      rr(ctx, M, y, W - 2 * M, rowH + 10, 16);
      ctx.fill();
      // number
      ctx.fillStyle = TAPE;
      ctx.beginPath();
      ctx.arc(M + 34, y + 30, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1d1d1d';
      ctx.textAlign = 'center';
      ctx.font = `800 22px ${FONT}`;
      ctx.fillText(String(e.no), M + 34, y + 38);
      // size
      ctx.textAlign = 'left';
      ctx.fillStyle = '#ff3b30';
      ctx.font = `800 28px ${FONT}`;
      ctx.fillText(fmt(e.value), M + 70, y + 40);
      // note
      ctx.fillStyle = '#1f2a3d';
      ctx.font = `500 25px ${FONT}`;
      lines.forEach((l, i) => ctx.fillText(l, M + 210, y + 39 + i * LH));
      y += rowH + 18;
    }
  }

  // ---- footer
  ctx.fillStyle = '#d3dbe8';
  ctx.fillRect(M, H - FOOT, W - 2 * M, 2);
  ctx.fillStyle = '#5d6b82';
  ctx.font = `500 21px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(`Site Measure  ·  ${p.name || ''}`.trim(), M, H - FOOT + 40, W * 0.6);
  ctx.textAlign = 'right';
  ctx.fillText(`Страница ${pageNo} из ${pageCount}`, W - M, H - FOOT + 40);

  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  c.width = c.height = 0;
  return { jpeg: new Uint8Array(await blob.arrayBuffer()), width: W, height: H };
}

// ---------------------------------------------------------------- photo editor

let ed = null;

function openEditor(photoId, edgeId, { draw = false } = {}) {
  const ph = S.photos.find((p) => p.id === photoId);
  if (!ph) return;
  ed?.close();
  ed = new Editor(ph, edgeId);
  if (draw) ed.mode = 'draw';
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
      <div class="ed-stage"><canvas></canvas><div class="value-pill" hidden><span class="typed num"></span><span class="res"></span></div></div>
      <canvas class="loupe" hidden></canvas>
      <div class="ed-panel"></div>`;
    document.body.append(el);
    document.body.style.overflow = 'hidden';
    this.canvas = el.querySelector('.ed-stage canvas');
    this.ctx = this.canvas.getContext('2d');
    this.loupe = el.querySelector('.loupe');
    this.panel = el.querySelector('.ed-panel');
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
    this.onKey = (e) => this.keyboard(e);
    document.addEventListener('keydown', this.onKey);
    this.refreshStatus();
  }

  /** iPad with a hardware keyboard: type sizes directly ("48 3/8", "12' 4"), Enter = next, Esc = done. */
  keyboard(e) {
    if (!this.sel || document.querySelector('.sheet-wrap') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName)) return;
    const k = e.key;
    if (/^[0-9'./ ]$/.test(k)) {
      if (k === ' ' && (this.text === '' || this.text.endsWith(' '))) return e.preventDefault();
      this.text += k;
    } else if (k === 'Backspace') this.text = this.text.slice(0, -1); // one character, like any text field
    else if (k === 'Enter') {
      e.preventDefault();
      return this.nextEdge();
    } else if (k === 'Escape') {
      if (!this.commit()) return;
      this.sel = null;
      this.paintPanel();
      return this.draw();
    } else return;
    e.preventDefault();
    this.paintValue();
  }

  close() {
    this.commit();
    document.removeEventListener('keydown', this.onKey);
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
    if (this.mode === 'idle' && !this.sel) this.paintPanel();
  }

  /** The stored doc changed (restored from a backup). */
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
      // the point being moved right now: a big yellow ring so it is obvious on the photo
      if (this.dragPt) {
        const { x, y } = this.dragPt;
        for (const [col, w] of [['rgba(0,0,0,.8)', 6], ['#ffc20e', 3]]) {
          ctx.beginPath();
          ctx.arc(x, y, 18 / k, 0, Math.PI * 2);
          ctx.lineWidth = w / k;
          ctx.strokeStyle = col;
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
  /**
   * Magnifier showing the point being placed (pt, image pixels). It sits in the bottom
   * panel, below the photo, so the finger never covers it (the keypad is not needed while
   * dragging). The photo is drawn at device resolution with crisp pixels when magnified
   * past the photo's own resolution, so edges stay sharp instead of blurry.
   */
  showLoupe(clientX, clientY, pt) {
    if (!this.img) return;
    const L = this.loupe;
    const pr = this.panel.getBoundingClientRect();
    const size = Math.round(Math.max(150, Math.min(pr.height - 16, pr.width - 24, 440)));
    const dpr = window.devicePixelRatio || 1;
    if (L.width !== Math.round(size * dpr)) {
      L.width = L.height = Math.round(size * dpr);
      L.style.width = L.style.height = size + 'px';
    }
    L.style.left = pr.left + (pr.width - size) / 2 + 'px';
    L.style.top = pr.top + Math.max(8, (pr.height - size) / 2) + 'px';
    L.hidden = false;
    this.panel.classList.add('dragging');
    this.dragPt = pt;
    const m = Math.min(Math.max(this.k() * 4, 1), 10); // css px per photo pixel
    const s = m * dpr;
    const c = L.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#000';
    c.fillRect(0, 0, L.width, L.height);
    c.imageSmoothingEnabled = s < 2;
    c.imageSmoothingQuality = 'high';
    c.setTransform(s, 0, 0, s, L.width / 2 - pt.x * s, L.height / 2 - pt.y * s);
    c.drawImage(this.img, 0, 0);
    const list = this.temp ? [...this.edges, this.temp] : this.edges;
    drawEdges(c, list, { iw: this.img.naturalWidth, ih: this.img.naturalHeight, lineW: 1 / m, fontPx: 11 / m, colorOf: edgeColor, selectedId: null, prec: S.prec, labels: false });
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    // crosshair with a gap at the exact point, dark outline so it reads on any background
    const h = size / 2;
    const arm = size * 0.22;
    const gap = 9;
    for (const [col, w] of [['rgba(0,0,0,.75)', 3.5], ['#fff', 1.5]]) {
      c.strokeStyle = col;
      c.lineWidth = w;
      c.beginPath();
      for (const [x1, y1, x2, y2] of [[h, h - arm, h, h - gap], [h, h + gap, h, h + arm], [h - arm, h, h - gap, h], [h + gap, h, h + arm, h]]) {
        c.moveTo(x1, y1);
        c.lineTo(x2, y2);
      }
      c.stroke();
    }
    for (const [col, w] of [['rgba(0,0,0,.75)', 4], ['#ffc20e', 2]]) {
      c.strokeStyle = col;
      c.lineWidth = w;
      c.beginPath();
      c.arc(h, h, 5, 0, Math.PI * 2);
      c.stroke();
    }
  }
  hideLoupe() {
    this.loupe.hidden = true;
    this.panel.classList.remove('dragging');
    if (this.dragPt) {
      this.dragPt = null;
      this.draw();
    }
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
            g.hx = sel['x' + g.which] * iw;
            g.hy = sel['y' + g.which] * ih;
          }
        }
        if (g.mode === 'pan' && this.mode === 'draw' && this.img) {
          g.mode = 'draw';
          const q = this.norm(p);
          this.temp = { id: 'temp', note: '', x1: q.x, y1: q.y, x2: q.x, y2: q.y, value: null, src: 'user' };
          this.showLoupe(e.clientX, e.clientY, p);
        }
      } else if (pts.size === 2) {
        if (g?.mode === 'handle' && g.moved) this.persist();
        this.temp = null;
        this.hideLoupe();
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
      const fp = this.toImg(e.clientX, e.clientY);
      if (g.mode === 'draw' && this.temp) {
        const q = this.norm(fp);
        this.temp.x2 = q.x;
        this.temp.y2 = q.y;
        this.showLoupe(e.clientX, e.clientY, fp);
      } else if (g.mode === 'handle') {
        const sel = this.edges.find((x) => x.id === this.sel);
        const p = { x: g.hx + (e.clientX - g.x) / this.k(), y: g.hy + (e.clientY - g.y) / this.k() };
        const q = this.norm(p);
        if (sel) {
          sel['x' + g.which] = q.x;
          sel['y' + g.which] = q.y;
        }
        this.showLoupe(e.clientX, e.clientY, { x: q.x * this.img.naturalWidth, y: q.y * this.img.naturalHeight });
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
      this.hideLoupe();
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
    if (!this.sel) this.el.querySelector('.value-pill').hidden = true;
    if (this.mode === 'draw') {
      P.innerHTML = `<div class="ed-hint">Проведите пальцем вдоль ребра. Двумя пальцами — увеличить.</div>
        <div class="loupe-slot">Здесь появится лупа, пока вы ведёте пальцем</div>
        <div class="ed-actions" style="grid-template-columns:1fr"><button class="btn" data-e="cancel-draw">Отмена</button></div>`;
      return;
    }
    const e = this.edges.find((x) => x.id === this.sel);
    if (!e) {
      const c = counts([{ edges: this.edges }]);
      const hint = c.total
        ? 'Нажмите на ребро, чтобы вписать размер. Двумя пальцами — увеличить.'
        : 'Нажмите «＋ Ребро» и проведите пальцем вдоль ребра, которое нужно измерить.';
      P.innerHTML = `<div class="ed-hint">${esc(hint)}</div>
        <div class="ed-actions" ${c.total > c.done ? '' : 'style="grid-template-columns:1fr"'}>
          <button class="btn ${c.total > c.done ? '' : 'primary'}" data-e="draw">＋ Ребро</button>
          ${c.total > c.done ? `<button class="btn primary" data-e="start">Вводить размеры</button>` : ''}
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
        <button class="kb-note ${e.note ? '' : 'empty'}" data-e="note"><small>✎ Примечание</small><span class="t">${e.note ? esc(e.note) : 'Нажмите, чтобы написать, от чего до чего'}</span></button>
        <div class="kb-side">
          ${S.prec === 16 ? `<button class="kb-prec ${this.fr16 ? 'on' : ''}" data-e="fr16" aria-label="Шестнадцатые">${this.fr16 ? '← 1/8' : '1/16 →'}</button>` : ''}
          <button class="kb-prec kb-del" data-e="del" aria-label="Удалить ребро">🗑</button>
        </div>
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
    t.textContent = this.text ? this.text + (this.text.endsWith("'") ? '' : '"') : '—';
    const r = parseLength(this.text);
    const res = pill.querySelector('.res');
    res.classList.toggle('err', r.error);
    res.textContent = r.error ? 'не понимаю' : r.value === null ? 'введите размер' : '= ' + formatLength(r.value, S.prec);
    // feet key: lit while feet are in the value; pressing it again converts back to inches
    const ft = this.panel.querySelector(`[data-k="'"]`);
    if (ft) {
      const on = this.text.includes("'");
      ft.classList.toggle('on', on);
      ft.textContent = on ? 'в дюймы' : "' фут";
    }
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
          input: { value: e.note || '', placeholder: 'от … до …', multiline: true },
          options: [
            { label: 'Сохранить', value: 'save', cls: 'primary' },
            ...(e.note ? [{ label: 'Очистить примечание', value: 'clear' }] : []),
          ],
        });
        if (!r) return;
        e.note = r.value === 'clear' ? '' : r.text.replace(/\s+/g, ' ').slice(0, 300);
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
    const v = await sheet({
      title: 'Фото',
      options: [
        ...(this.edges.some((e) => typeof e.value !== 'number')
          ? [{ label: `Удалить рёбра без размеров (${this.edges.filter((e) => typeof e.value !== 'number').length})`, sub: 'Только на этом фото. Рёбра с размерами останутся.', value: 'empty' }]
          : []),
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
    if (v === 'del') {
      const ok = await sheet({ title: 'Удалить фото?', text: 'Фото и все его размеры будут удалены. Это нельзя отменить.', options: [{ label: 'Удалить навсегда', value: true, cls: 'danger' }] });
      if (!ok) return;
      await db.doc('photos/' + doc.id).delete().catch(() => {});
      await assets.delete(doc.assetId).catch(() => {});
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
  try {
    await loadAssets();
  } catch {
    toast('Не удалось открыть хранилище на телефоне.');
  }
  persist();
  let gotP = false, gotPh = false;
  const done = () => {
    if (gotP && gotPh) S.ready = true;
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
      // keep in-memory copies that are newer than what was just read back
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
  registerUpdates();
}

/**
 * Service worker + updates: check for a new version on every launch and when the app comes back
 * to the screen; when it is installed, reload once so the new version is used right away
 * (not while a photo is open: then it reloads after the photo is closed).
 */
function registerUpdates() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return; // first install: nothing old to replace
    reloading = true;
    const go = () => (ed ? setTimeout(go, 1000) : location.reload());
    go();
  });
  navigator.serviceWorker
    .register('./sw.js')
    .then((reg) => {
      reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    })
    .catch(() => {});
}

start();
