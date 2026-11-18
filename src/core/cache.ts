// Guest-side cache of fetched files (IndexedDB), keyed by project + path and
// validated by content hash, so reopening an unchanged image or large file
// costs no transfer.

const DB = "duet-cache";
const STORE = "files";

let dbp: Promise<IDBDatabase> | null = null;
function db() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

interface Entry {
  hash: string;
  data: Uint8Array;
}

export async function cacheGet(key: string, hash: string): Promise<Uint8Array | null> {
  try {
    const d = await db();
    return await new Promise((res) => {
      const r = d.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => {
        const e = r.result as Entry | undefined;
        res(e && e.hash === hash ? e.data : null);
      };
      r.onerror = () => res(null);
    });
  } catch {
    return null;
  }
}

export async function cachePut(key: string, hash: string, data: Uint8Array) {
  if (data.length > 64 * 1024 * 1024) return; // keep the cache reasonable
  try {
    const d = await db();
    d.transaction(STORE, "readwrite").objectStore(STORE).put({ hash, data } satisfies Entry, key);
  } catch {
    /* cache is optional */
  }
}
