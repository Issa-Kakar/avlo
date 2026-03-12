/**
 * Upload Queue — Persistent upload queue backed by IDB.
 *
 * Survives tab crashes. Content-addressed, so enqueue is idempotent.
 * Processes one upload at a time with exponential backoff.
 */

import {
  getBlob,
  getUploadEntry,
  putUploadEntry,
  removeUploadEntry,
  getAllPendingUploads,
  type UploadEntry,
} from './asset-cache';

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

let processing = false;
let uploadUrl = '/api/assets/upload';
let getUploadToken: (() => Promise<string>) | null = null;

/** Set the upload endpoint and token provider. */
export function configureUploadQueue(
  url: string,
  tokenProvider: () => Promise<string>,
): void {
  uploadUrl = url;
  getUploadToken = tokenProvider;
}

/** Enqueue an asset for upload. Idempotent. */
export async function enqueue(assetId: string): Promise<void> {
  const existing = await getUploadEntry(assetId);
  if (existing) return; // Already queued
  await putUploadEntry(assetId, { status: 'pending', retries: 0, lastAttempt: 0 });
  processQueue();
}

/** Drain pending uploads, one at a time. */
export async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;

  try {
    const ids = await getAllPendingUploads();
    for (const assetId of ids) {
      const entry = await getUploadEntry(assetId);
      if (!entry) continue;

      // Skip if max retries exceeded
      if (entry.retries >= MAX_RETRIES) continue;

      // Exponential backoff
      if (entry.status === 'failed') {
        const delay = BASE_DELAY_MS * Math.pow(2, entry.retries - 1);
        const elapsed = Date.now() - entry.lastAttempt;
        if (elapsed < delay) continue;
      }

      await uploadOne(assetId, entry);
    }
  } finally {
    processing = false;
  }
}

async function uploadOne(assetId: string, entry: UploadEntry): Promise<void> {
  const blob = await getBlob(assetId);
  if (!blob) {
    await removeUploadEntry(assetId);
    return;
  }

  await putUploadEntry(assetId, { ...entry, status: 'uploading', lastAttempt: Date.now() });

  try {
    const token = getUploadToken ? await getUploadToken() : '';
    const form = new FormData();
    form.append('file', blob);
    form.append('token', token);

    const resp = await fetch(uploadUrl, { method: 'POST', body: form });

    if (resp.ok || resp.status === 409) {
      // 409 = already exists (content-addressed dedup)
      await removeUploadEntry(assetId);
    } else {
      throw new Error(`upload ${resp.status}`);
    }
  } catch {
    await putUploadEntry(assetId, {
      status: 'failed',
      retries: entry.retries + 1,
      lastAttempt: Date.now(),
    });
  }
}

// Resume on reconnect
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    processQueue();
  });
}
