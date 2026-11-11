// Site Measure UI: screens, measurement keypad, photos, export.

import { parseLength, formatLength, formatPlain, applyKey, EIGHTHS, SIXTEENTHS } from './units.js';
import { validateWall, wallHasErrors } from './validate.js';
import { wallDxf, projectDxf, safeFileName } from './dxf.js';
import { wallSvg, esc } from './sketch.js';
import * as db from './storage.js';
import { openPhotoEditor, drawThumb, renderAnnotated } from './photo-editor.js';

const app = document.getElementById('app');
const state = {
  settings: { precision: 16 },
  project: null, // project currently open (single in-memory copy)
  invalid: {}, // field key -> raw text that failed to parse (highlighted, not saved)
};

const SIDES = ['N', 'S', 'E', 'W'];
const TYPES = [
  ['window', 'Окно'],
  ['door', 'Дверь'],
  ['vent', 'Решётка'],
  ['other', 'Другое'],
];
const prec = () => state.settings.precision;
const fmt = (v) => (v === null || v === undefined ? '—' : formatLength(v, prec()));

// ---------- saving ----------

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (state.project) db.saveProject(state.project).catch((e) => toast('Не удалось сохранить: ' + e.message));
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && saveTimer) saveNow();
});

// ---------- small UI helpers ----------

function toast(text, ms = 3500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}

/** Modal with buttons; resolves with the chosen value (null on cancel). */
function ask(message, buttons) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `<div class="modal-box"><p>${esc(message)}</p><div class="modal-btns">${buttons
      .map((b, i) => `<button class="btn ${b.cls || ''}" data-i="${i}">${esc(b.label)}</button>`)
      .join('')}</div></div>`;
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (!b && e.target !== wrap) return;
      wrap.remove();
      resolve(b ? buttons[+b.dataset.i].value : null);
    });
    document.body.append(wrap);
  });
}

/**
 * Hand a file to the iOS share sheet (Files, AirDrop, Mail), or download it.
 * Must be called synchronously from a tap handler: iOS requires user activation.
 */
async function deliverFile(content, fileName, types) {
  for (const type of types) {
    const file = new File([content], fileName, { type });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return; // user closed the sheet
        break; // fall back to download
      }
    }
  }
  const url = URL.createObjectURL(new Blob([content], { type: types[0] }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const DXF_TYPES = ['application/dxf', 'application/octet-stream'];

function exportDxf(result) {
  if (!result.text) {
    ask('Нечего экспортировать: у стен не введены ширина и высота.', [{ label: 'OK', value: 1 }]);
    return;
  }
  const p = deliverFile(result.text, result.fileName, DXF_TYPES);
  if (result.skipped.length) {
    p.finally(() => toast('Пропущены стены без ширины/высоты: ' + result.skipped.join(', '), 6000));
  }
}

// ---------- routing ----------

function route() {
  const m = /^#\/p\/([^/]+)(?:\/w\/([^/]+))?$/.exec(location.hash);
  return m ? { pid: decodeURIComponent(m[1]), wid: m[2] && decodeURIComponent(m[2]) } : {};
}
const go = (hash) => {
  if (location.hash === hash) render();
  else location.hash = hash;
};
const projectHash = (p) => `#/p/${encodeURIComponent(p.id)}`;
const wallHash = (p, w) => `${projectHash(p)}/w/${encodeURIComponent(w.id)}`;

window.addEventListener('hashchange', () => {
  closeKeyboard(true);
  render();
});

async function render() {
  if (saveTimer) saveNow();
  const { pid, wid } = route();
  try {
    if (!pid) {
      state.project = null;
      return await renderList();
    }
    if (!state.project || state.project.id !== pid) {
      state.project = await db.getProject(pid);
      state.invalid = {};
    }
    if (!state.project) return go('#/');
    if (!wid) return renderProject(state.project);
    const wall = state.project.walls.find((w) => w.id === wid);
    if (!wall) return go(projectHash(state.project));
    renderWall(state.project, wall);
  } catch (e) {
    app.innerHTML = `<div class="screen"><p class="error">Ошибка: ${esc(e.message)}</p></div>`;
  }
}

// ---------- screen: projects list ----------

async function renderList() {
  const list = (await db.listProjects()).sort((a, b) => b.updatedAt - a.updatedAt);
  app.innerHTML = `
    <header class="bar">
      <h1>Site Measure</h1>
      <button class="icon-btn" data-act="settings" aria-label="Настройки">⚙︎</button>
    </header>
    <main class="screen">
      ${list.length ? '' : '<p class="empty">Пока нет объектов. Нажми «+ Объект».</p>'}
      ${list
        .map(
          (p) => `<button class="card" data-act="open-project" data-id="${esc(p.id)}">
            <span class="card-title">${esc(p.name || 'Без названия')}</span>
            <span class="card-sub">${esc(p.address || '')}</span>
            <span class="card-meta">${esc(p.date || '')} · стен: ${p.walls.length}</span>
          </button>`
        )
        .join('')}
      <button class="btn primary big" data-act="new-project">+ Объект</button>
    </main>`;
}

// ---------- screen: project ----------

function renderProject(p) {
  app.innerHTML = `
    <header class="bar">
      <button class="back" data-act="home">‹ Объекты</button>
      <h1>${esc(p.name || 'Объект')}</h1>
    </header>
    <main class="screen">
      <label class="field">Название <small>латиницей — пойдёт в имя файла DXF</small>
        <input data-pfield="name" value="${esc(p.name)}" autocomplete="off" autocapitalize="words" placeholder="Main St 12"></label>
      <label class="field">Адрес
        <input data-pfield="address" value="${esc(p.address)}" autocomplete="off"></label>
      <label class="field">Дата
        <input data-pfield="date" type="date" value="${esc(p.date)}"></label>

      <h2>Стены</h2>
      ${p.walls.length ? '' : '<p class="empty">Стен пока нет.</p>'}
      ${p.walls
        .map((w) => {
          const svg = wallSvg(w, validateWall(w), { compact: true, precision: prec() });
          const bad = wallHasErrors(w);
          return `<button class="wall-row" data-act="open-wall" data-id="${esc(w.id)}">
            <span class="thumb">${svg || '<span class="thumb-empty">?</span>'}</span>
            <span class="wall-info">
              <span class="card-title">${esc(w.name)}${w.side ? ` <span class="side-tag">${w.side}</span>` : ''}${bad ? ' <span class="warn" title="Есть ошибки">⚠</span>' : ''}</span>
              <span class="card-sub">${esc(fmt(w.width))} × ${esc(fmt(w.height))}</span>
              <span class="card-meta">проёмов: ${w.openings.length}${w.photo ? ' · фото' : ''}</span>
            </span>
          </button>`;
        })
        .join('')}
      <button class="btn primary big" data-act="new-wall">+ Стена</button>
      <button class="btn big" data-act="export-all">Экспорт DXF (все стены)</button>
      <button class="btn big" data-act="backup">Резервная копия</button>
      <button class="btn danger big" data-act="delete-project">Удалить объект</button>
    </main>`;
}

// ---------- screen: wall ----------

function fieldKeys(wall) {
  const keys = ['width', 'height'];
  for (const o of wall.openings) for (const k of ['x', 'y', 'w', 'h']) keys.push(`o:${o.id}:${k}`);
  return keys;
}

function parseKey(key) {
  const wall = kb.wall || currentWall();
  if (!wall || !key) return null;
  if (key === 'width' || key === 'height') return { obj: wall, prop: key, label: key === 'width' ? 'Ширина' : 'Высота' };
  if (key.startsWith('mark:')) {
    const m = (wall.photoMarks || []).find((x) => x.id === key.slice(5));
    return m ? { obj: m, prop: 'value', label: 'Размер на фото' } : null;
  }
  const [, oid, prop] = key.split(':');
  const i = wall.openings.findIndex((o) => o.id === oid);
  if (i < 0) return null;
  return { obj: wall.openings[i], prop, label: `Проём ${i + 1} — ${prop.toUpperCase()}` };
}

function currentWall() {
  const { wid } = route();
  return state.project?.walls.find((w) => w.id === wid) || null;
}

function dimButton(key, label, value) {
  const raw = state.invalid[key];
  const cls = ['dim', raw !== undefined ? 'invalid' : '', value === null || value === undefined ? 'unset' : '', kb.key === key ? 'active' : '']
    .filter(Boolean)
    .join(' ');
  const shown = raw !== undefined ? esc(raw) : value === null || value === undefined ? '—' : esc(formatLength(value, prec()));
  return `<button class="${cls}" data-dim="${esc(key)}"><span class="dim-label">${label}</span><span class="dim-value">${shown}</span></button>`;
}

function renderWall(p, w) {
  app.innerHTML = `
    <header class="bar">
      <button class="back" data-act="to-project">‹ ${esc(p.name || 'Объект')}</button>
      <h1 id="wall-title">${esc(w.name)}</h1>
    </header>
    <main class="screen wall-screen">
      <div class="row-name">
        <label class="field grow">Имя стены
          <input data-wfield="name" value="${esc(w.name)}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
        <div class="sides">${SIDES.map((s) => `<button class="seg ${w.side === s ? 'on' : ''}" data-act="side" data-side="${s}">${s}</button>`).join('')}</div>
      </div>
      <section id="photo"></section>
      <section id="sketch" class="sketch"></section>
      <section id="wall-dims" class="dims2"></section>
      <h2>Проёмы</h2>
      <p class="hint coord-hint"><b>Отсчёт от левого нижнего угла стены.</b> X — от левого края стены до левого края проёма, Y — от низа стены до низа проёма, W — ширина, H — высота.</p>
      <section id="openings"></section>
      <button class="btn primary big" data-act="add-opening">+ Проём</button>
      <label class="field">Заметки
        <textarea data-wfield="notes" rows="3">${esc(w.notes)}</textarea></label>
      <button class="btn big" data-act="export-wall">Экспорт DXF (эта стена)</button>
      <button class="btn danger big" data-act="delete-wall">Удалить стену</button>
    </main>`;
  renderPhoto(w);
  updateWallView();
}

/** Redraw the parts that depend on dimensions: sketch, fields, opening cards. */
function updateWallView() {
  const w = currentWall();
  if (!w) return;
  const errors = validateWall(w);
  const sketch = document.getElementById('sketch');
  const svg = wallSvg(w, errors, { precision: prec() });
  sketch.innerHTML = svg || '<div class="sketch-empty">Введи ширину и высоту</div>';

  document.getElementById('wall-dims').innerHTML = dimButton('width', 'Ширина', w.width) + dimButton('height', 'Высота', w.height);

  document.getElementById('openings').innerHTML = w.openings
    .map((o, i) => {
      const errs = errors[i];
      return `<div class="op-card ${errs.length ? 'bad' : ''}" id="op-${esc(o.id)}">
        <div class="op-head">
          <span class="op-num">${i + 1}</span>
          <div class="types">${TYPES.map(
            ([t, label]) => `<button class="seg ${o.type === t ? 'on' : ''}" data-act="op-type" data-oid="${esc(o.id)}" data-type="${t}">${label}</button>`
          ).join('')}</div>
        </div>
        <div class="dims4">
          ${['x', 'y', 'w', 'h'].map((k) => dimButton(`o:${o.id}:${k}`, k.toUpperCase(), o[k])).join('')}
        </div>
        ${errs.length ? `<p class="op-errors">${errs.map((e) => esc(e.text)).join('<br>')}</p>` : ''}
        <button class="btn danger small" data-act="op-delete" data-oid="${esc(o.id)}">Удалить проём</button>
      </div>`;
    })
    .join('');
}

// ---------- photo ----------

function renderPhoto(w) {
  const el = document.getElementById('photo');
  if (!el) return;
  el.innerHTML = w.photo
    ? `<div class="photo-row">
        <button class="photo-thumb" data-act="photo-view" aria-label="Открыть фото"><canvas></canvas>
          ${w.photoMarks?.length ? `<span class="photo-badge">✎ ${w.photoMarks.length}</span>` : ''}</button>
        <div class="photo-btns">
          <button class="btn primary" data-act="photo-view">✎ Размеры на фото</button>
          <label class="btn">Переснять<input type="file" accept="image/*" capture="environment" data-act="photo-input" hidden></label>
          <button class="btn danger" data-act="photo-delete">Удалить фото</button>
        </div>
      </div>`
    : `<label class="btn big photo-take">📷 Сфотографировать<input type="file" accept="image/*" capture="environment" data-act="photo-input" hidden></label>`;
  const c = el.querySelector('.photo-thumb canvas');
  if (c) drawThumb(c, w.photo, w.photoMarks, prec()).catch(() => {});
}

function dataUrlToBytes(url) {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function openEditor(w) {
  const p = state.project;
  openPhotoEditor({
    wall: w,
    precision: prec(),
    onChange: saveNow,
    keypadOpen: () => !!kb.key,
    keypadHeight: () => (kb.key ? kb.el.offsetHeight : 0),
    editValue: (mark, after) => {
      openKeyboard('mark:' + mark.id);
      kb.onClose = after;
    },
    // synchronous up to navigator.share: iOS needs the tap's user activation
    share: (img) => {
      const bytes = dataUrlToBytes(renderAnnotated(img, w.photoMarks || [], prec()));
      deliverFile(bytes, `${safeFileName(p.name)}_${safeFileName(w.name)}_photo.jpg`, ['image/jpeg']);
    },
    onClose: () => renderPhoto(w),
  }).catch((e) => toast('Не удалось открыть фото: ' + e.message));
}

async function compressPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    // onload rather than img.decode(): decode() can hang for detached images in some browsers
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('формат не поддерживается'));
      im.src = url;
    });
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.75);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- measurement keypad ----------

const kb = { key: null, wall: null, text: '', initial: '', el: null, onClose: null };

function buildKeyboard() {
  const el = document.createElement('div');
  el.className = 'kb';
  el.hidden = true;
  document.body.append(el);
  kb.el = el;
  el.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('button');
    if (b) b.classList.add('pressed');
  });
  const unpress = () => el.querySelectorAll('.pressed').forEach((b) => b.classList.remove('pressed'));
  el.addEventListener('pointerup', unpress);
  el.addEventListener('pointercancel', unpress);
  el.addEventListener('pointerleave', unpress);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]');
    if (!b) return;
    const k = b.dataset.k;
    if (k === 'next') return kbNext();
    if (k === 'done') return closeKeyboard(true);
    kb.text = applyKey(kb.text, k);
    updateKbHead();
  });
}

function renderKeyboardKeys() {
  const key = (k, label = k, cls = '') => `<button data-k="${esc(k)}" class="key ${cls}">${esc(label)}</button>`;
  const fr = (list) => list.map((f) => key(f, f, 'frac')).join('');
  kb.el.innerHTML = `
    <div class="kb-head">
      <div class="kb-info">
        <div class="kb-label"></div>
        <div class="kb-line"><span class="kb-text"></span><span class="kb-result"></span></div>
      </div>
      <button data-k="done" class="key done">Готово</button>
    </div>
    <div class="kb-grid">
      ${fr(EIGHTHS)}${key('clear', 'Очистить', 'fn')}
      ${prec() === 16 ? fr(SIXTEENTHS) : ''}
      ${key('7')}${key('8')}${key('9')}${key('back', '⌫', 'fn')}
      ${key('4')}${key('5')}${key('6')}${key("'", "' фут", 'fn')}
      ${key('1')}${key('2')}${key('3')}${key('.', '.', 'fn')}
      ${key('0', '0', 'wide')}${key('next', 'Далее ›', 'next wide')}
    </div>`;
}

function updateKbHead() {
  const f = parseKey(kb.key);
  kb.el.querySelector('.kb-label').textContent = f ? f.label : '';
  kb.el.querySelector('.kb-text').textContent = kb.text || ' ';
  const r = parseLength(kb.text);
  const res = kb.el.querySelector('.kb-result');
  res.textContent = r.error ? 'ошибка' : r.value === null ? 'пусто' : '= ' + formatLength(r.value, prec());
  res.classList.toggle('err', r.error);
}

function markActiveField() {
  document.querySelectorAll('.dim.active').forEach((b) => b.classList.remove('active'));
  if (!kb.key) return null;
  const b = document.querySelector(`[data-dim="${CSS.escape(kb.key)}"]`);
  b?.classList.add('active');
  return b;
}

function openKeyboard(key) {
  if (kb.key && kb.key !== key) {
    commitField();
    const cb = kb.onClose;
    kb.onClose = null;
    cb?.();
  }
  kb.wall = currentWall();
  const f = parseKey(key);
  if (!f) return;
  kb.key = key;
  kb.text = state.invalid[key] ?? formatPlain(f.obj[f.prop], prec());
  kb.initial = kb.text;
  renderKeyboardKeys();
  kb.el.hidden = false;
  document.body.classList.add('kb-open');
  document.body.style.paddingBottom = kb.el.offsetHeight + 'px';
  updateKbHead();
  const b = markActiveField();
  if (b) {
    const r = b.getBoundingClientRect();
    const limit = window.innerHeight - kb.el.offsetHeight - 12;
    if (r.bottom > limit) window.scrollBy({ top: r.bottom - limit, behavior: 'smooth' });
    else if (r.top < 70) window.scrollBy({ top: r.top - 80, behavior: 'smooth' });
  }
}

/** Save the typed value. Returns false if it does not parse (field gets highlighted). */
function commitField() {
  const key = kb.key;
  const f = key && parseKey(key);
  if (!f) return true;
  if (kb.text === kb.initial && state.invalid[key] === undefined) return true; // untouched: keep exact value
  const r = parseLength(kb.text);
  if (r.error) {
    state.invalid[key] = kb.text;
    updateWallView();
    markActiveField();
    return false;
  }
  delete state.invalid[key];
  f.obj[f.prop] = r.value;
  kb.initial = kb.text;
  saveNow();
  updateWallView();
  markActiveField();
  return true;
}

function kbNext() {
  if (!commitField()) {
    kb.el.querySelector('.kb-head').classList.remove('shake');
    void kb.el.offsetWidth;
    kb.el.querySelector('.kb-head').classList.add('shake');
    return;
  }
  const keys = fieldKeys(currentWall());
  const i = keys.indexOf(kb.key);
  const next = i >= 0 ? keys[i + 1] : null; // photo dimensions have no "next" field
  if (next) openKeyboard(next);
  else closeKeyboard(false);
}

function closeKeyboard(commit) {
  if (!kb.key) return;
  if (commit) commitField();
  kb.key = null;
  kb.wall = null;
  const cb = kb.onClose;
  kb.onClose = null;
  kb.el.hidden = true;
  document.body.classList.remove('kb-open');
  document.body.style.paddingBottom = '';
  markActiveField();
  cb?.();
}

// A tap outside the keypad saves and closes it. The tap itself is swallowed so it does
// not also press whatever button was under the finger; scrolling still works.
let outside = null;
let swallowUntil = 0;
document.addEventListener(
  'pointerdown',
  (e) => {
    outside = kb.key && !kb.el.contains(e.target) && !e.target.closest('.modal') ? { x: e.clientX, y: e.clientY } : null;
  },
  true
);
document.addEventListener(
  'pointerup',
  (e) => {
    if (!outside || !kb.key) return;
    const moved = Math.hypot(e.clientX - outside.x, e.clientY - outside.y) > 10;
    outside = null;
    if (moved || e.target.closest('[data-dim]')) return; // another field: its click switches
    closeKeyboard(true);
    swallowUntil = Date.now() + 600;
  },
  true
);
document.addEventListener(
  'click',
  (e) => {
    if (Date.now() < swallowUntil) {
      swallowUntil = 0;
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true
);

// ---------- events ----------

app.addEventListener('click', async (e) => {
  const dim = e.target.closest('[data-dim]');
  if (dim) return openKeyboard(dim.dataset.dim);

  const op = e.target.closest('[data-op]');
  if (op) {
    const w = currentWall();
    const o = w?.openings[+op.dataset.op];
    const card = o && document.getElementById('op-' + o.id);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.remove('flash');
      void card.offsetWidth;
      card.classList.add('flash');
    }
    return;
  }

  const t = e.target.closest('[data-act]');
  if (!t) return;
  const p = state.project;
  const w = currentWall();
  switch (t.dataset.act) {
    case 'settings':
      return openSettings();
    case 'home':
      return go('#/');
    case 'new-project': {
      const np = db.newProject();
      await db.saveProject(np);
      state.project = np;
      return go(projectHash(np));
    }
    case 'open-project':
      return go(`#/p/${encodeURIComponent(t.dataset.id)}`);
    case 'new-wall': {
      const nw = db.newWall(p);
      p.walls.push(nw);
      saveNow();
      return go(wallHash(p, nw));
    }
    case 'open-wall':
      return go(`${projectHash(p)}/w/${encodeURIComponent(t.dataset.id)}`);
    case 'to-project':
      return go(projectHash(p));
    case 'export-all':
      return exportDxf(projectDxf(p));
    case 'export-wall':
      return exportDxf(wallDxf(p, w));
    case 'backup': {
      const name = `${safeFileName(p.name)}_backup_${db.today()}.json`;
      deliverFile(db.backupJson(p), name, ['application/json']);
      return;
    }
    case 'delete-project': {
      const ok = await ask(`Удалить объект «${p.name || 'Без названия'}» со всеми стенами и фото? Это нельзя отменить.`, [
        { label: 'Удалить', value: true, cls: 'danger' },
        { label: 'Отмена', value: false },
      ]);
      if (!ok) return;
      await db.deleteProject(p.id);
      state.project = null;
      return go('#/');
    }
    case 'delete-wall': {
      const ok = await ask(`Удалить стену ${w.name}?`, [
        { label: 'Удалить', value: true, cls: 'danger' },
        { label: 'Отмена', value: false },
      ]);
      if (!ok) return;
      p.walls = p.walls.filter((x) => x !== w);
      saveNow();
      return go(projectHash(p));
    }
    case 'side':
      w.side = w.side === t.dataset.side ? '' : t.dataset.side;
      saveNow();
      document.querySelectorAll('.sides .seg').forEach((b) => b.classList.toggle('on', b.dataset.side === w.side));
      return;
    case 'add-opening': {
      const o = db.newOpening();
      w.openings.push(o);
      saveNow();
      updateWallView();
      return openKeyboard(`o:${o.id}:x`);
    }
    case 'op-type': {
      const o = w.openings.find((x) => x.id === t.dataset.oid);
      o.type = t.dataset.type;
      saveNow();
      return updateWallView();
    }
    case 'op-delete': {
      const i = w.openings.findIndex((x) => x.id === t.dataset.oid);
      const ok = await ask(`Удалить проём ${i + 1}?`, [
        { label: 'Удалить', value: true, cls: 'danger' },
        { label: 'Отмена', value: false },
      ]);
      if (!ok) return;
      w.openings.splice(i, 1);
      saveNow();
      return updateWallView();
    }
    case 'photo-view':
      return openEditor(w);
    case 'photo-delete': {
      const ok = await ask('Удалить фото стены?', [
        { label: 'Удалить', value: true, cls: 'danger' },
        { label: 'Отмена', value: false },
      ]);
      if (!ok) return;
      w.photo = null;
      w.photoMarks = [];
      saveNow();
      return renderPhoto(w);
    }
  }
});

app.addEventListener('change', async (e) => {
  if (e.target.dataset.act !== 'photo-input') return;
  const file = e.target.files?.[0];
  if (!file) return;
  const w = currentWall();
  if (w.photo && w.photoMarks?.length) {
    const ok = await ask(`Заменить фото? Пометки на старом фото (${w.photoMarks.length}) будут удалены.`, [
      { label: 'Заменить', value: true, cls: 'danger' },
      { label: 'Отмена', value: false },
    ]);
    e.target.value = '';
    if (!ok) return;
  }
  try {
    w.photo = await compressPhoto(file);
    w.photoMarks = [];
    saveNow();
    renderPhoto(w);
  } catch (err) {
    toast('Не удалось обработать фото: ' + err.message);
  }
});

app.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.pfield && state.project) {
    state.project[t.dataset.pfield] = t.value;
    if (t.dataset.pfield === 'name') document.querySelector('.bar h1').textContent = t.value || 'Объект';
    saveSoon();
  } else if (t.dataset.wfield) {
    const w = currentWall();
    if (!w) return;
    w[t.dataset.wfield] = t.value;
    if (t.dataset.wfield === 'name') document.getElementById('wall-title').textContent = t.value;
    saveSoon();
  }
});
app.addEventListener('focusout', () => saveTimer && saveNow());

// ---------- settings & restore ----------

function openSettings() {
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.innerHTML = `<div class="modal-box">
      <h2>Настройки</h2>
      <p>Точность размеров</p>
      <div class="segs">
        <button class="seg big ${prec() === 16 ? 'on' : ''}" data-prec="16">1/16"</button>
        <button class="seg big ${prec() === 8 ? 'on' : ''}" data-prec="8">1/8"</button>
      </div>
      <label class="btn big">Восстановить из резервной копии<input type="file" hidden data-restore></label>
      <p class="hint">Данные хранятся только на этом телефоне. Делай резервные копии объектов — iOS может удалить данные веб-приложения.</p>
      <button class="btn primary big" data-close>Закрыть</button>
    </div>`;
  document.body.append(wrap);
  wrap.addEventListener('click', async (e) => {
    const pb = e.target.closest('[data-prec]');
    if (pb) {
      state.settings.precision = +pb.dataset.prec;
      await db.saveSettings(state.settings);
      wrap.querySelectorAll('[data-prec]').forEach((b) => b.classList.toggle('on', b === pb));
      return;
    }
    if (e.target.closest('[data-close]') || e.target === wrap) {
      wrap.remove();
      render();
    }
  });
  wrap.querySelector('[data-restore]').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    wrap.remove();
    await restoreBackup(file);
  });
}

async function restoreBackup(file) {
  let p;
  try {
    p = db.parseBackup(await file.text());
  } catch (err) {
    await ask(err.message, [{ label: 'OK', value: 1 }]);
    return render();
  }
  const existing = await db.getProject(p.id);
  if (existing) {
    const choice = await ask(`Объект «${existing.name || 'Без названия'}» уже есть на телефоне.`, [
      { label: 'Заменить', value: 'replace', cls: 'danger' },
      { label: 'Сохранить как копию', value: 'copy', cls: 'primary' },
      { label: 'Отмена', value: null },
    ]);
    if (!choice) return render();
    if (choice === 'copy') p = db.asCopy(p);
  }
  await db.saveProject(p);
  state.project = p;
  state.invalid = {};
  toast('Объект восстановлен');
  go(projectHash(p));
}

// ---------- start ----------

async function start() {
  document.addEventListener('touchstart', () => {}, { passive: true }); // enables :active on iOS
  buildKeyboard();
  try {
    state.settings = await db.loadSettings();
  } catch {
    /* defaults */
  }
  db.requestPersist();
  render();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

start();
