// Tiny IndexedDB key/value store shared by the service worker and the result
// page. Captured frames and finished images are stored here as Blobs because
// they are far too large for extension messaging.
//
// Keys:  "<captureId>:meta"      -> capture metadata (plain object)
//        "<captureId>:frame:<n>" -> raw viewport capture (PNG Blob)
//        "<captureId>:tile:<n>"  -> finished stitched image (PNG Blob)
(function (global) {
  'use strict';

  const DB_NAME = 'full-page-screenshot';
  const STORE = 'kv';
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => {
          const db = req.result;
          db.onclose = () => { dbPromise = null; };
          db.onversionchange = () => { db.close(); dbPromise = null; };
          resolve(db);
        };
        req.onerror = () => { dbPromise = null; reject(req.error); };
        req.onblocked = () => { dbPromise = null; reject(new Error('Storage is blocked.')); };
      });
    }
    return dbPromise;
  }

  async function run(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let result;
      const req = fn(tx.objectStore(STORE));
      if (req) req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted.'));
    });
  }

  const prefixRange = (prefix) => IDBKeyRange.bound(prefix, prefix + '￿');

  global.ShotDB = {
    get: (key) => run('readonly', (s) => s.get(key)),
    put: (key, value) => run('readwrite', (s) => s.put(value, key)),
    del: (key) => run('readwrite', (s) => s.delete(key)),
    delPrefix: (prefix) => run('readwrite', (s) => s.delete(prefixRange(prefix))),
    keys: () => run('readonly', (s) => s.getAllKeys()),
  };
})(globalThis);
