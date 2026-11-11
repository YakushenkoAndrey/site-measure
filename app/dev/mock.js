// Mock of the claude.ai artifact runtime for local testing (not published).
// db: in-memory + localStorage; assets: POST to the dev server; sample: canned answer in window.MOCK_ANSWER.
(function () {
  const KEY = 'sm.mockdb';
  let store = {};
  try {
    store = JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {}
  const listeners = [];
  const persist = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(store));
    } catch {}
  };
  const snapOf = (col) => {
    const docs = Object.entries(store)
      .filter(([p]) => p.startsWith(col + '/') && p.split('/').length === 2)
      .map(([p, d]) => ({ id: p.split('/')[1], exists: true, data: () => JSON.parse(JSON.stringify(d)) }));
    return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false } };
  };
  const notify = (path) => {
    const col = path.split('/')[0];
    for (const l of listeners) if (l.col === col) setTimeout(() => l.cb(snapOf(col)), 30);
  };
  const db = {
    collection(col) {
      return {
        onSnapshot(cb) {
          const l = { col, cb };
          listeners.push(l);
          setTimeout(() => cb(snapOf(col)), 50);
          return () => listeners.splice(listeners.indexOf(l), 1);
        },
        doc: (id) => db.doc(col + '/' + id),
      };
    },
    doc(path) {
      return {
        async set(d) {
          await new Promise((r) => setTimeout(r, 40));
          store[path] = JSON.parse(JSON.stringify(d));
          persist();
          notify(path);
        },
        async delete() {
          delete store[path];
          persist();
          notify(path);
        },
        async get() {
          return { exists: path in store, data: () => store[path] };
        },
      };
    },
  };
  const assets = {
    async upload(blob) {
      const id = Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32);
      await fetch('/_blob/' + id, { method: 'POST', body: blob });
      return { id, url: '/_blob/' + id, sizeBytes: blob.size, contentType: 'image/jpeg' };
    },
    async delete() {
      return { deleted: true };
    },
  };
  const sample = async () => ({ text: '' });
  sample.json = async (prompt, opts) => {
    window.MOCK_LAST = { prompt, opts };
    await new Promise((r) => setTimeout(r, window.MOCK_DELAY ?? 1500));
    if (window.MOCK_FAIL) throw { code: window.MOCK_FAIL };
    return window.MOCK_ANSWER || { planes: [] };
  };
  sample.limits = async () => ({ images: { maxCount: 5 } });
  window.MOCK_SAVED = [];
  const downloads = {
    async save({ filename, data }) {
      window.MOCK_SAVED.push({ filename, data });
      return { status: 'saved' };
    },
  };
  const caps = { db, assets, sample, downloads };
  window.claude = { use: (n) => Promise.resolve(caps[n] || null) };
})();
