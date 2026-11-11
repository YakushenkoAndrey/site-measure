// IndexedDB storage and JSON backups. Everything stays on the device.

const DB_NAME = 'site-measure';
const DB_VERSION = 1;
const BACKUP_FORMAT = 'site-measure-backup';

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function newProject() {
  const now = Date.now();
  return { id: uid(), name: '', address: '', date: today(), createdAt: now, updatedAt: now, walls: [] };
}

export function newWall(project) {
  const used = new Set(project.walls.map((w) => w.name));
  let n = project.walls.length + 1;
  while (used.has(`Wall-${n}`)) n++;
  return { id: uid(), name: `Wall-${n}`, side: '', width: null, height: null, photo: null, notes: '', openings: [] };
}

export function newOpening() {
  return { id: uid(), type: 'window', x: null, y: null, w: null, h: null };
}

// ---------- IndexedDB ----------

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(store, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req?.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

export const listProjects = () => run('projects', 'readonly', (s) => s.getAll());
export const getProject = (id) => run('projects', 'readonly', (s) => s.get(id));
export const deleteProject = (id) => run('projects', 'readwrite', (s) => s.delete(id));

export function saveProject(project) {
  project.updatedAt = Date.now();
  // structuredClone drops nothing we need and protects against later mutation mid-write
  return run('projects', 'readwrite', (s) => s.put(structuredClone(project)));
}

export async function loadSettings() {
  const s = await run('settings', 'readonly', (st) => st.get('settings'));
  return { precision: 16, ...(s || {}) };
}

export const saveSettings = (settings) =>
  run('settings', 'readwrite', (s) => s.put(settings, 'settings'));

/** Ask the browser not to evict our data (iOS may still do it). */
export async function requestPersist() {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    /* not supported */
  }
  return false;
}

// ---------- Backups (pure, testable) ----------

export function backupJson(project) {
  return JSON.stringify({ format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), project }, null, 1);
}

/** Parse a backup file; throws Error with a Russian message on bad input. */
export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Файл не читается как JSON');
  }
  const p = data?.format === BACKUP_FORMAT ? data.project : null;
  if (!p || typeof p.id !== 'string' || !Array.isArray(p.walls)) {
    throw new Error('Это не резервная копия Site Measure');
  }
  return p;
}

/** Same project with fresh ids, marked as a copy. */
export function asCopy(project) {
  const p = structuredClone(project);
  p.id = uid();
  p.name = `${p.name || ''} (копия)`.trim();
  p.createdAt = p.updatedAt = Date.now();
  for (const w of p.walls) {
    w.id = uid();
    for (const o of w.openings || []) o.id = uid();
  }
  return p;
}
