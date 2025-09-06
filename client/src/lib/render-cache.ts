/**
 * Minimal render cache for boot splash
 * Phase 2.4.4: Simple IndexedDB wrapper for cosmetic boot UX
 * NOT for data persistence - purely visual continuity
 */

export interface RenderCacheEntry {
  roomId: string;
  svKey: string; // State vector key to validate freshness
  imageData: string; // Base64 PNG or ImageData
  timestamp: number;
}

const DB_NAME = 'avlo-render-cache';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class RenderCache {
  private db: IDBDatabase | null = null;
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      // Check if IndexedDB is available
      if (typeof indexedDB === 'undefined') {
        console.warn('[RenderCache] IndexedDB not available');
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create object store if it doesn't exist
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'roomId' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };

      // Wait for initialization (only set handlers once in the Promise)
      await new Promise<void>((resolve, reject) => {
        request.onsuccess = () => {
          this.db = request.result;
          this.initialized = true;
          // Clean up old entries on init
          this.cleanupOldEntries();
          resolve();
        };
        request.onerror = () => {
          console.error('[RenderCache] Failed to open database');
          reject(new Error('Failed to initialize render cache'));
        };
      });
    } catch (error) {
      console.warn('[RenderCache] Initialization failed:', error);
    }
  }

  /**
   * Store a render snapshot for boot splash
   * Only updates if svKey has changed
   */
  async store(roomId: string, svKey: string, canvas: HTMLCanvasElement): Promise<void> {
    if (!this.db) return;

    try {
      // Get existing entry to check if update needed
      const existing = await this.get(roomId);
      if (existing?.svKey === svKey) {
        // Same state vector, no need to update
        return;
      }

      // Convert canvas to base64 PNG
      const imageData = canvas.toDataURL('image/png');

      const entry: RenderCacheEntry = {
        roomId,
        svKey,
        imageData,
        timestamp: Date.now(),
      };

      const transaction = this.db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      // Use put to insert or update
      store.put(entry);

      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } catch (error) {
      console.warn('[RenderCache] Failed to store snapshot:', error);
    }
  }

  /**
   * Retrieve a render snapshot for boot splash
   * Returns null if not found or svKey doesn't match
   */
  async get(roomId: string, expectedSvKey?: string): Promise<RenderCacheEntry | null> {
    if (!this.db) return null;

    try {
      const transaction = this.db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(roomId);

      const entry = await new Promise<RenderCacheEntry | null>((resolve) => {
        request.onsuccess = () => {
          const result = request.result as RenderCacheEntry | undefined;
          if (!result) {
            resolve(null);
            return;
          }

          // Check if entry is too old
          const age = Date.now() - result.timestamp;
          if (age > CACHE_TTL_MS) {
            resolve(null);
            return;
          }

          // Check svKey if provided
          if (expectedSvKey && result.svKey !== expectedSvKey) {
            resolve(null);
            return;
          }

          resolve(result);
        };
        request.onerror = () => resolve(null);
      });

      return entry;
    } catch (error) {
      console.warn('[RenderCache] Failed to retrieve snapshot:', error);
      return null;
    }
  }

  /**
   * Display cached image as boot splash
   * Returns true if splash was shown
   * @deprecated MVP: not used by Phase 6. Do not call from app UI.
   */
  async showBootSplash(
    roomId: string,
    targetElement: HTMLElement,
    expectedSvKey?: string,
  ): Promise<boolean> {
    if (process.env.NODE_ENV === 'production') {
      // MVP pivot: splash/render-cache paths are disabled in prod
      return Promise.resolve(false);
    }
    const entry = await this.get(roomId, expectedSvKey);
    if (!entry) return false;

    try {
      // Create an image element for the splash
      const img = new Image();
      img.src = entry.imageData;
      img.style.position = 'absolute';
      img.style.top = '0';
      img.style.left = '0';
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'contain';
      img.style.opacity = '1';
      img.style.transition = 'opacity 300ms ease-out';
      img.style.pointerEvents = 'none';
      img.style.zIndex = '1000';

      // Add to target element
      targetElement.appendChild(img);

      // Fade out after real canvas is ready
      // Caller should trigger this when ready
      const fadeOut = () => {
        img.style.opacity = '0';
        setTimeout(() => {
          if (img.parentNode) {
            img.parentNode.removeChild(img);
          }
        }, 300);
      };

      // Return fadeOut function attached to image
      (img as any).fadeOut = fadeOut;

      return true;
    } catch (error) {
      console.warn('[RenderCache] Failed to show boot splash:', error);
      return false;
    }
  }

  /**
   * Clear cache for a specific room
   */
  async clear(roomId: string): Promise<void> {
    if (!this.db) return;

    try {
      const transaction = this.db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      store.delete(roomId);

      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } catch (error) {
      console.warn('[RenderCache] Failed to clear cache:', error);
    }
  }

  /**
   * Clear all cached renders
   * Useful for testing or complete cache reset
   */
  async clearAll(): Promise<void> {
    if (!this.db) return;

    try {
      const transaction = this.db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      store.clear();

      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } catch (error) {
      console.warn('[RenderCache] Failed to clear all caches:', error);
    }
  }

  /**
   * Clean up old cache entries
   */
  private async cleanupOldEntries(): Promise<void> {
    if (!this.db) return;

    try {
      const transaction = this.db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index('timestamp');

      const cutoff = Date.now() - CACHE_TTL_MS;
      const range = IDBKeyRange.upperBound(cutoff);

      const request = index.openCursor(range);
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
        }
      };
    } catch (error) {
      console.warn('[RenderCache] Failed to cleanup old entries:', error);
    }
  }

  /**
   * Close the database connection
   */
  destroy(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
    }
  }
}

// Singleton instance
export const renderCache = new RenderCache();
