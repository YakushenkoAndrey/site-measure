// On-device storage (IndexedDB): projects, photo records and photo files.
// Nothing leaves the phone. The API mirrors what app.js needs: collections with
// change listeners, documents with set/delete, and photo blobs with object URLs.

const DB_NAME = 'site-measure-v2';
const STORES = ['projects', 'photos', 'blobs'];

let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const r = fn(t.objectStore(store));
        t.oncomplete = () => resolve(r?.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

async function readAll(store) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const out = [];
    const req = db.transaction(store).objectStore(store).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve(out);
      out.push({ id: c.key, data: c.value });
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

// ---------------- documents with change listeners

const listeners = { projects: [], photos: [] };
const snapshot = async (col) => {
  const rows = await readAll(col);
  return { docs: rows.map((r) => ({ id: r.id, exists: true, data: () => r.data })) };
};
const notify = async (col) => {
  if (!listeners[col]?.length) return;
  const snap = await snapshot(col);
  for (const cb of listeners[col]) cb(snap);
};

export const db = {
  collection(col) {
    return {
      onSnapshot(cb, onError) {
        listeners[col].push(cb);
        snapshot(col).then(cb, onError);
        return () => listeners[col].splice(listeners[col].indexOf(cb), 1);
      },
    };
  },
  doc(path) {
    const [col, id] = path.split('/');
    return {
      async set(data) {
        await tx(col, 'readwrite', (s) => s.put(structuredClone(data), id));
        notify(col);
      },
      async delete() {
        await tx(col, 'readwrite', (s) => s.delete(id));
        notify(col);
      },
    };
  },
};

// ---------------- photo files

const urls = new Map(); // id -> object URL

// Photos are stored as {type, buf: ArrayBuffer}, not as Blob: Safari on iOS, especially in a
// home-screen app, intermittently fails to put Blobs into IndexedDB ("Error preparing Blob/File
// data to be stored"). Plain bytes always work. Older records may still be Blobs.
const toRecord = async (blob) => ({ type: blob.type || 'image/jpeg', buf: await blob.arrayBuffer() });
const toBlob = (rec) => (rec instanceof Blob ? rec : rec?.buf ? new Blob([rec.buf], { type: rec.type || 'image/jpeg' }) : null);

export const assets = {
  async upload(blob) {
    const id = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random()).replace(/[^a-z0-9]/gi, '');
    await assets.put(id, blob);
    return { id };
  },
  async delete(id) {
    await tx('blobs', 'readwrite', (s) => s.delete(id));
    if (urls.has(id)) URL.revokeObjectURL(urls.get(id));
    urls.delete(id);
  },
  async get(id) {
    return toBlob(await tx('blobs', 'readonly', (s) => s.get(id)));
  },
  /** Store a photo under a known id (new photos, restoring a backup). */
  async put(id, blob) {
    const rec = await toRecord(blob); // read the bytes before the transaction starts
    await tx('blobs', 'readwrite', (s) => s.put(rec, id));
    if (urls.has(id)) URL.revokeObjectURL(urls.get(id));
    urls.set(id, URL.createObjectURL(blob));
  },
};

/** Display URL for a stored photo ('' until loaded). */
export const assetUrl = (id) => urls.get(id) || '';

/** Load object URLs for every stored photo. Call once before the first render. */
export async function loadAssets() {
  for (const { id, data } of await readAll('blobs')) {
    const b = toBlob(data);
    if (b && !urls.has(id)) urls.set(id, URL.createObjectURL(b));
  }
}

/** Ask iOS/Android not to clear our data when space runs low. */
export async function persist() {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) || false;
  } catch {
    return false;
  }
}
