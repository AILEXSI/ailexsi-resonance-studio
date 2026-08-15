/**
 * Persistent media blobs in IndexedDB — survives page reload.
 * Project JSON keeps asset ids; blobs are restored to object URLs on boot.
 */

const DB_NAME = "ailexsi-resonance-media-v1";
const STORE = "blobs";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putMediaBlob(
  id: string,
  blob: Blob,
  name: string,
  type: string
): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ id, blob, name, type, savedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function getMediaBlob(
  id: string
): Promise<{ blob: Blob; name: string; type: string } | null> {
  const db = await openDb();
  const row = await new Promise<{ blob: Blob; name: string; type: string } | null>(
    (resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    }
  );
  db.close();
  return row;
}

export async function deleteMediaBlob(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function clearAllMediaBlobs(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** Restore object URLs for all assets that have IDB blobs */
export async function hydrateMediaAssets<
  T extends { id: string; localPathOrUrl: string; name: string; type: string },
>(assets: T[]): Promise<T[]> {
  const out: T[] = [];
  for (const a of assets) {
    if (a.localPathOrUrl.startsWith("blob:") && a.localPathOrUrl.length > 10) {
      out.push(a);
      continue;
    }
    try {
      const row = await getMediaBlob(a.id);
      if (row?.blob) {
        const url = URL.createObjectURL(row.blob);
        out.push({ ...a, localPathOrUrl: url, name: row.name || a.name });
      } else {
        out.push({
          ...a,
          localPathOrUrl: a.localPathOrUrl.startsWith("missing:")
            ? a.localPathOrUrl
            : `missing:${a.name}`,
        });
      }
    } catch {
      out.push({
        ...a,
        localPathOrUrl: `missing:${a.name}`,
      });
    }
  }
  return out;
}
