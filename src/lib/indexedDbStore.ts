import { PendingSyncOp, Project, SupabaseFreeConfig } from '../types/studio';

const DB_NAME = 'recap_studio_local_db';
const DB_VERSION = 7;

export interface CachedMediaEntry {
  sha256: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  blob: Blob;
  cachedAt: string;
}

interface KvEntry {
  key: string;
  value: unknown;
}

const LOCAL_CONFIG_LS_KEY = 'recap_studio_supabase_free_config';
const DEVICE_ID_LS_KEY = 'recap_studio_device_id';

export function getDeviceId(): string {
  try {
    let existing = window.localStorage.getItem(DEVICE_ID_LS_KEY);
    if (!existing) {
      existing =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `dev_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      window.localStorage.setItem(DEVICE_ID_LS_KEY, existing);
    }
    return existing;
  } catch {
    return 'dev_local_session';
  }
}

export function getStoredSupabaseConfig(): SupabaseFreeConfig | null {
  try {
    const raw = window.localStorage.getItem(LOCAL_CONFIG_LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SupabaseFreeConfig>;
      if (parsed.url && parsed.anonKey) {
        return { url: parsed.url.trim(), anonKey: parsed.anonKey.trim() };
      }
    }
  } catch {
    // ignore storage errors
  }
  const envUrl = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_SUPABASE_URL;
  const envKey = (import.meta as unknown as { env?: Record<string, string> }).env
    ?.VITE_SUPABASE_ANON_KEY;
  if (envUrl && envKey && !envUrl.includes('YOUR_')) {
    return { url: envUrl.trim(), anonKey: envKey.trim() };
  }
  return null;
}

export function saveStoredSupabaseConfig(config: SupabaseFreeConfig | null): void {
  try {
    if (!config || !config.url.trim() || !config.anonKey.trim()) {
      window.localStorage.removeItem(LOCAL_CONFIG_LS_KEY);
    } else {
      window.localStorage.setItem(
        LOCAL_CONFIG_LS_KEY,
        JSON.stringify({
          url: config.url.trim().replace(/\/+$/, ''),
          anonKey: config.anonKey.trim(),
        })
      );
    }
  } catch {
    // ignore storage errors
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable in this browser context.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('pendingSync')) {
        db.createObjectStore('pendingSync', { keyPath: 'projectId' });
      }
      if (!db.objectStoreNames.contains('mediaCache')) {
        db.createObjectStore('mediaCache', { keyPath: 'sha256' });
      }
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
  });
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDb();
  if (!db.objectStoreNames.contains(storeName)) {
    console.warn(
      `[IndexedDB Warning] Store "${storeName}" not found in database "${db.name}" (version ${db.version}). Available stores: [${Array.from(db.objectStoreNames).join(', ')}]`
    );
    return undefined as unknown as T;
  }
  return new Promise<T>((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const req = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error(`IndexedDB operation failed on ${storeName}`));
    } catch (err) {
      reject(err);
    }
  });
}

export const indexedDbStore = {
  async saveProjectSnapshot(project: Project): Promise<void> {
    try {
      await withStore('projects', 'readwrite', (s) => s.put(project));
    } catch {
      // ignore fallback errors in constrained private windows
    }
  },

  async saveAllProjectSnapshots(projects: Project[]): Promise<void> {
    try {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('projects', 'readwrite');
        const store = tx.objectStore('projects');
        for (const p of projects) {
          store.put(p);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // ignore
    }
  },

  async listProjectSnapshots(): Promise<Project[]> {
    try {
      const rows = await withStore<Project[]>('projects', 'readonly', (s) => s.getAll());
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  },

  async deleteProjectSnapshot(projectId: string): Promise<void> {
    try {
      await withStore('projects', 'readwrite', (s) => s.delete(projectId));
      await withStore('pendingSync', 'readwrite', (s) => s.delete(projectId));
    } catch {
      // ignore
    }
  },

  async queuePendingSync(op: PendingSyncOp): Promise<void> {
    try {
      await withStore('pendingSync', 'readwrite', (s) => s.put(op));
    } catch {
      // ignore
    }
  },

  async clearPendingSync(projectId: string): Promise<void> {
    try {
      await withStore('pendingSync', 'readwrite', (s) => s.delete(projectId));
    } catch {
      // ignore
    }
  },

  async listPendingSyncOps(): Promise<PendingSyncOp[]> {
    try {
      const rows = await withStore<PendingSyncOp[]>('pendingSync', 'readonly', (s) => s.getAll());
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  },

  async getCachedMedia(sha256: string): Promise<CachedMediaEntry | null> {
    if (!sha256) return null;
    try {
      const entry = await withStore<CachedMediaEntry | undefined>('mediaCache', 'readonly', (s) =>
        s.get(sha256)
      );
      return entry || null;
    } catch {
      return null;
    }
  },

  async putCachedMedia(entry: CachedMediaEntry): Promise<void> {
    if (!entry.sha256) return;
    try {
      await withStore('mediaCache', 'readwrite', (s) => s.put(entry));
    } catch {
      // ignore quota overflow in IndexedDB silently
    }
  },

  async clearCachedMedia(): Promise<void> {
    try {
      await withStore('mediaCache', 'readwrite', (s) => s.clear());
    } catch {
      // ignore
    }
  },

  async getUsageSummary(): Promise<{
    cachedProjects: number;
    pendingSyncCount: number;
    cachedMediaFiles: number;
    cachedMediaBytes: number;
  }> {
    try {
      const [projects, pending, media] = await Promise.all([
        withStore<Project[]>('projects', 'readonly', (s) => s.getAll()),
        withStore<PendingSyncOp[]>('pendingSync', 'readonly', (s) => s.getAll()),
        withStore<CachedMediaEntry[]>('mediaCache', 'readonly', (s) => s.getAll()),
      ]);
      const cachedMediaBytes = (media || []).reduce((acc, m) => acc + (m.sizeBytes || 0), 0);
      return {
        cachedProjects: (projects || []).length,
        pendingSyncCount: (pending || []).length,
        cachedMediaFiles: (media || []).length,
        cachedMediaBytes,
      };
    } catch {
      return {
        cachedProjects: 0,
        pendingSyncCount: 0,
        cachedMediaFiles: 0,
        cachedMediaBytes: 0,
      };
    }
  },

  async setKv(key: string, value: unknown): Promise<void> {
    try {
      const entry: KvEntry = { key, value };
      await withStore('kv', 'readwrite', (s) => s.put(entry));
    } catch {
      // ignore
    }
  },

  async getKv<T = unknown>(key: string): Promise<T | null> {
    try {
      const row = await withStore<KvEntry | undefined>('kv', 'readonly', (s) => s.get(key));
      return row ? (row.value as T) : null;
    } catch {
      return null;
    }
  },

  async cacheMediaByUrl(
    url: string,
    blob: Blob,
    filename?: string,
    mimeType?: string
  ): Promise<void> {
    const key = normalizeMediaUrlCacheKey(url);
    if (!key) return;
    try {
      await withStore('mediaCache', 'readwrite', (s) =>
        s.put({
          sha256: key,
          filename: filename || url.split('/').pop()?.split('?')[0] || 'asset.bin',
          mimeType: mimeType || blob.type || 'application/octet-stream',
          sizeBytes: blob.size,
          blob,
          cachedAt: new Date().toISOString(),
        } satisfies CachedMediaEntry)
      );
    } catch {
      // ignore IDB quota overflow silently
    }
  },

  async getCachedMediaByUrl(url: string): Promise<CachedMediaEntry | null> {
    const key = normalizeMediaUrlCacheKey(url);
    if (!key) return null;
    try {
      const entry = await withStore<CachedMediaEntry | undefined>('mediaCache', 'readonly', (s) =>
        s.get(key)
      );
      return entry || null;
    } catch {
      return null;
    }
  },

  async deleteCachedMediaByUrl(url: string): Promise<void> {
    const key = normalizeMediaUrlCacheKey(url);
    if (!key) return;
    try {
      await withStore('mediaCache', 'readwrite', (s) => s.delete(key));
    } catch {
      // ignore
    }
  },

  async getCachedMediaUsage(): Promise<{
    totalBytes: number;
    buckets: Record<string, { bytes: number; files: number }>;
  }> {
    try {
      const entries = await withStore<CachedMediaEntry[]>('mediaCache', 'readonly', (s) =>
        s.getAll()
      );
      const buckets: Record<string, { bytes: number; files: number }> = {};
      let totalBytes = 0;
      for (const entry of entries || []) {
        const size = entry.sizeBytes || entry.blob?.size || 0;
        totalBytes += size;
        const match = /^url:\/(?:media|storage)\/([^/]+)/.exec(entry.sha256);
        const bucket = match ? match[1] : 'cached';
        if (!buckets[bucket]) buckets[bucket] = { bytes: 0, files: 0 };
        buckets[bucket].bytes += size;
        buckets[bucket].files += 1;
      }
      return { totalBytes, buckets };
    } catch {
      return { totalBytes: 0, buckets: {} };
    }
  },
};

export function normalizeMediaUrlCacheKey(url: string): string {
  if (!url) return '';
  const noHash = url.split('#')[0];
  const noQuery = noHash.split('?')[0];
  if (noQuery.startsWith('http://') || noQuery.startsWith('https://')) {
    try {
      const u = new URL(noQuery);
      return `url:${u.pathname}`;
    } catch {
      return `url:${noQuery}`;
    }
  }
  return `url:${noQuery}`;
}
