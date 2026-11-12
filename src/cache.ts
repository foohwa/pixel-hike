/**
 * A small key/value store in IndexedDB for downloaded map data and terrain tiles. Unlike
 * localStorage (≈5 MB, strings only) it holds tens of MB and stores Blobs as-is, so a route
 * opened before loads with no network at all. Everything stays in this browser.
 */
const DB = 'pixelhike';
const STORE = 'kv';

let open: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  open ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = req.onblocked = () => resolve(null);
    } catch {
      resolve(null); // private mode / storage blocked: just don't cache
    }
  });
  return open;
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  const d = await db();
  if (!d) return undefined;
  return new Promise((resolve) => {
    try {
      const req = d.transaction(STORE).objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export async function cacheSet(key: string, value: unknown): Promise<void> {
  const d = await db();
  if (!d) return;
  return new Promise((resolve) => {
    try {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
    } catch {
      resolve(); // quota full etc.: not cached, still works
    }
  });
}
