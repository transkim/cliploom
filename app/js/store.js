/* IndexedDB storage: media files (video, image, audio) and projects. Everything stays on the device. */
(function (root) {
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open('cliploom', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('media', { keyPath: 'id' });
        d.createObjectStore('projects', { keyPath: 'id' });
        d.createObjectStore('kv');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      const r = fn(s);
      if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Storage full?'));
    });
  }
  const Store = {
    put: (store, v) => tx(store, 'readwrite', (s) => s.put(v)),
    get: (store, id) => tx(store, 'readonly', (s) => s.get(id)),
    del: (store, id) => tx(store, 'readwrite', (s) => s.delete(id)),
    all: (store) => tx(store, 'readonly', (s) => s.getAll()),
    getKV: (k) => tx('kv', 'readonly', (s) => s.get(k)),
    setKV: (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k)),
  };
  root.Store = Store;
})(window);
