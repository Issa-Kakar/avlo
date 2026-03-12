/**
 * IndexedDB Asset Cache
 *
 * Raw IndexedDB wrapper for storing image blobs offline.
 * Single global database shared across rooms.
 * Content-addressed by SHA-256 assetId.
 */

const DB_NAME = 'avlo-assets';
const DB_VERSION = 1;
const BLOBS_STORE = 'blobs';
const UPLOADS_STORE = 'uploads';

export type UploadStatus = 'pending' | 'uploading' | 'failed';

interface BlobEntry {
  blob: Blob;
  mimeType: string;
  size: number;
  storedAt: number;
}

export interface UploadEntry {
  status: UploadStatus;
  retries: number;
  lastAttempt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BLOBS_STORE)) {
        db.createObjectStore(BLOBS_STORE);
      }
      if (!db.objectStoreNames.contains(UPLOADS_STORE)) {
        db.createObjectStore(UPLOADS_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function tx(store: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return openDB().then((db) => db.transaction(store, mode).objectStore(store));
}

function idbGet<T>(store: IDBObjectStore, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(store: IDBObjectStore, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(store: IDBObjectStore, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbGetAllKeys(store: IDBObjectStore): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const req = store.getAllKeys();
    req.onsuccess = () => resolve(req.result as string[]);
    req.onerror = () => reject(req.error);
  });
}

// === Blob Store ===

export async function getBlob(assetId: string): Promise<Blob | null> {
  const store = await tx(BLOBS_STORE, 'readonly');
  const entry = await idbGet<BlobEntry>(store, assetId);
  return entry?.blob ?? null;
}

export async function putBlob(assetId: string, blob: Blob, mimeType: string): Promise<void> {
  const store = await tx(BLOBS_STORE, 'readwrite');
  const entry: BlobEntry = { blob, mimeType, size: blob.size, storedAt: Date.now() };
  await idbPut(store, assetId, entry);
}

export async function hasBlob(assetId: string): Promise<boolean> {
  const store = await tx(BLOBS_STORE, 'readonly');
  const entry = await idbGet<BlobEntry>(store, assetId);
  return entry !== undefined;
}

// === Upload Store ===

export async function getUploadEntry(assetId: string): Promise<UploadEntry | null> {
  const store = await tx(UPLOADS_STORE, 'readonly');
  const entry = await idbGet<UploadEntry>(store, assetId);
  return entry ?? null;
}

export async function putUploadEntry(assetId: string, entry: UploadEntry): Promise<void> {
  const store = await tx(UPLOADS_STORE, 'readwrite');
  await idbPut(store, assetId, entry);
}

export async function removeUploadEntry(assetId: string): Promise<void> {
  const store = await tx(UPLOADS_STORE, 'readwrite');
  await idbDelete(store, assetId);
}

export async function getAllPendingUploads(): Promise<string[]> {
  const store = await tx(UPLOADS_STORE, 'readonly');
  return idbGetAllKeys(store);
}
