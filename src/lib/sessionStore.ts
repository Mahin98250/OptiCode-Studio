const DB_NAME = 'or-generator-storage';
const DB_VERSION = 1;

type StoredSession = {
  key: string;
  type: 'transfer' | 'multi-image';
  id: string;
  mime: string;
  name: string;
  size: number;
  hash: string;
  total: number;
  bytesPerFrame?: number;
  createdAt: number;
};

type StoredChunk = {
  key: string;
  sessionKey: string;
  index: number;
  data: string;
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  if (!('indexedDB' in window)) {
    return Promise.reject(new Error('IndexedDB is unavailable in this browser. Transfer storage cannot be started.'));
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('chunks')) {
        const store = db.createObjectStore('chunks', { keyPath: 'key' });
        store.createIndex('sessionKey', 'sessionKey', { unique: false });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error('Unable to open local storage.'));
    };
  });

  return dbPromise;
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Local storage request failed.'));
  });
}

export async function getSession(key: string) {
  const db = await openDb();
  const tx = db.transaction('sessions', 'readonly');
  return requestResult<StoredSession | undefined>(tx.objectStore('sessions').get(key));
}

export async function getSessions(type?: StoredSession['type']) {
  const db = await openDb();
  const tx = db.transaction('sessions', 'readonly');
  const items = await requestResult<StoredSession[]>(tx.objectStore('sessions').getAll());
  return type ? items.filter(item => item.type === type) : items;
}

export async function putSession(session: StoredSession) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('sessions', 'readwrite');
    tx.objectStore('sessions').put(session);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Unable to save the transfer session.'));
    tx.onabort = () => reject(tx.error ?? new Error('Unable to save the transfer session.'));
  });
}

export async function getChunk(sessionKey: string, index: number) {
  const db = await openDb();
  const tx = db.transaction('chunks', 'readonly');
  const key = `${sessionKey}|${index}`;
  return requestResult<StoredChunk | undefined>(tx.objectStore('chunks').get(key));
}

export async function putChunk(sessionKey: string, index: number, data: string) {
  const db = await openDb();
  const key = `${sessionKey}|${index}`;

  return new Promise<{ duplicate: boolean }>((resolve, reject) => {
    const tx = db.transaction('chunks', 'readwrite');
    const store = tx.objectStore('chunks');
    const get = store.get(key);

    let duplicate = false;

    get.onsuccess = () => {
      const existing = get.result as StoredChunk | undefined;
      if (existing) {
        duplicate = true;
        if (existing.data !== data) {
          tx.abort();
          reject(new Error('Conflicting frame data was detected.'));
          return;
        }
      } else {
        store.put({ key, sessionKey, index, data } satisfies StoredChunk);
      }
    };

    get.onerror = () => {
      tx.abort();
      reject(get.error ?? new Error('Unable to read local transfer storage.'));
    };

    tx.oncomplete = () => resolve({ duplicate });
    tx.onerror = () => reject(tx.error ?? new Error('Unable to save the transfer frame.'));
    tx.onabort = () => reject(tx.error ?? new Error('Unable to save the transfer frame.'));
  });
}

export async function putChunkAndCount(sessionKey: string, index: number, data: string) {
  const db = await openDb();
  const key = `${sessionKey}|${index}`;

  return new Promise<{ duplicate: boolean; received: number }>((resolve, reject) => {
    const tx = db.transaction('chunks', 'readwrite');
    const store = tx.objectStore('chunks');
    const sessionIndex = store.index('sessionKey');
    const get = store.get(key);

    let duplicate = false;
    let received = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      try { tx.abort(); } catch { /* transaction may already be closing */ }
      reject(error);
    };

    get.onsuccess = () => {
      const existing = get.result as StoredChunk | undefined;
      if (existing) {
        duplicate = true;
        if (existing.data !== data) {
          fail(new Error('Conflicting frame data was detected.'));
          return;
        }
      } else {
        store.put({ key, sessionKey, index, data } satisfies StoredChunk);
      }

      const count = sessionIndex.count(IDBKeyRange.only(sessionKey));
      count.onsuccess = () => { received = count.result; };
      count.onerror = () => fail(count.error ?? new Error('Unable to count stored transfer frames.'));
    };

    get.onerror = () => fail(get.error ?? new Error('Unable to read local transfer storage.'));
    tx.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve({ duplicate, received });
      }
    };
    tx.onerror = () => fail(tx.error ?? new Error('Unable to save the transfer frame.'));
    tx.onabort = () => {
      if (!settled) {
        settled = true;
        reject(tx.error ?? new Error('Unable to save the transfer frame.'));
      }
    };
  });
}

export async function getChunks(sessionKey: string) {
  const db = await openDb();
  const tx = db.transaction('chunks', 'readonly');
  const index = tx.objectStore('chunks').index('sessionKey');
  return requestResult<StoredChunk[]>(index.getAll(sessionKey));
}

export async function getChunkIndexes(sessionKey: string) {
  const db = await openDb();
  const tx = db.transaction('chunks', 'readonly');
  const index = tx.objectStore('chunks').index('sessionKey');
  const keys = await requestResult<IDBValidKey[]>(index.getAllKeys(sessionKey));
  return keys
    .map((key) => Number(String(key).slice(sessionKey.length + 1)))
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((a, b) => a - b);
}

export async function clearSession(key: string) {
  const db = await openDb();

  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['sessions', 'chunks'], 'readwrite');
    tx.objectStore('sessions').delete(key);

    const index = tx.objectStore('chunks').index('sessionKey');
    const cursorRequest = index.openCursor(IDBKeyRange.only(key));

    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Unable to clear the local session.'));
    tx.onabort = () => reject(tx.error ?? new Error('Unable to clear the local session.'));
  });
}

export async function countChunks(sessionKey: string) {
  const db = await openDb();
  const tx = db.transaction('chunks', 'readonly');
  const index = tx.objectStore('chunks').index('sessionKey');
  return requestResult<number>(index.count(IDBKeyRange.only(sessionKey)));
}
