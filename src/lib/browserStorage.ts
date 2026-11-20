import { Project, StudioPreset, DefaultStudioPreferences, SavedFishVoice, SavedFontAsset, RenderJob, FilmstripFrame } from '../types/studio';
import { indexedDbStore } from './indexedDbStore';

export const DB_NAME = 'recap_studio_local_db';
export const CURRENT_SCHEMA_VERSION = 7;

export const REQUIRED_STORES: Record<string, { keyPath: string }> = {
  projects: { keyPath: 'id' },
  filmstrips: { keyPath: 'id' },
  presets: { keyPath: 'id' },
  settings: { keyPath: 'key' },
  blobs: { keyPath: 'key' },
  jobs: { keyPath: 'id' },
  saved_fish_voices: { keyPath: 'id' },
  fonts: { keyPath: 'id' },
  waveforms: { keyPath: 'id' },
  appSettings: { keyPath: 'key' },
  mediaCache: { keyPath: 'sha256' },
  pendingSync: { keyPath: 'projectId' },
  kv: { keyPath: 'key' },
};

let cachedDb: IDBDatabase | null = null;
let pendingOpenPromise: Promise<IDBDatabase> | null = null;

function performOpen(targetVersion?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not supported or not available in this browser context.'));
      return;
    }

    const versionToOpen = targetVersion || CURRENT_SCHEMA_VERSION;
    const request = indexedDB.open(DB_NAME, versionToOpen);

    request.onblocked = () => {
      console.warn(
        `[IndexedDB] Database upgrade to version ${versionToOpen} is blocked by an unclosed connection. Please close other open tabs of this application.`
      );
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const oldVersion = event.oldVersion;
      const newVersion = event.newVersion;
      console.info(
        `[IndexedDB] Upgrading database "${db.name}" schema from version ${oldVersion} to ${newVersion}...`
      );

      for (const [storeName, config] of Object.entries(REQUIRED_STORES)) {
        if (!db.objectStoreNames.contains(storeName)) {
          console.info(
            `[IndexedDB] Creating missing object store "${storeName}" with keyPath "${config.keyPath}"`
          );
          db.createObjectStore(storeName, { keyPath: config.keyPath });
        }
      }
    };

    request.onsuccess = () => {
      const db = request.result;

      db.onversionchange = () => {
        console.warn(
          `[IndexedDB] Database version change requested by another connection. Closing active connection to allow upgrade.`
        );
        db.close();
        if (cachedDb === db) {
          cachedDb = null;
        }
      };

      db.onclose = () => {
        if (cachedDb === db) {
          cachedDb = null;
        }
      };

      db.onerror = (e) => {
        console.error('[IndexedDB] Database connection error:', (e.target as any)?.error);
      };

      resolve(db);
    };

    request.onerror = () => {
      console.error(
        `[IndexedDB Error] Failed to open database "${DB_NAME}" at version ${versionToOpen}:`,
        request.error
      );
      reject(request.error || new Error(`Failed to open IndexedDB "${DB_NAME}"`));
    };
  });
}

export async function openIndexedDB(): Promise<IDBDatabase> {
  // If we have an existing open connection, check if all required stores exist
  if (cachedDb) {
    const missing = Object.keys(REQUIRED_STORES).filter((s) => !cachedDb!.objectStoreNames.contains(s));
    if (missing.length === 0) {
      return cachedDb;
    }
    console.warn(
      `[IndexedDB] Active connection is missing stores [${missing.join(', ')}]. Closing to trigger automatic upgrade...`
    );
    cachedDb.close();
    cachedDb = null;
  }

  // Prevent multiple parallel conflicting openings
  if (pendingOpenPromise) {
    return pendingOpenPromise;
  }

  pendingOpenPromise = (async () => {
    try {
      let db = await performOpen();
      const missing = Object.keys(REQUIRED_STORES).filter((s) => !db.objectStoreNames.contains(s));
      if (missing.length > 0) {
        console.warn(
          `[IndexedDB] Database "${db.name}" (version ${db.version}) is missing stores [${missing.join(
            ', '
          )}]. Upgrading to version ${db.version + 1}...`
        );
        db.close();
        db = await performOpen(db.version + 1);
      }
      cachedDb = db;
      return db;
    } finally {
      pendingOpenPromise = null;
    }
  })();

  return pendingOpenPromise;
}

export async function getEnsureStoreDb(storeName: string): Promise<IDBDatabase> {
  let db = await openIndexedDB();
  if (!db.objectStoreNames.contains(storeName)) {
    console.error(
      `[IndexedDB Error] Object store "${storeName}" was NOT found in database "${db.name}" (version ${db.version})! ` +
      `Available stores: [${Array.from(db.objectStoreNames).join(', ')}]. Initiating immediate schema upgrade...`
    );

    if (cachedDb) {
      cachedDb.close();
      cachedDb = null;
    }

    if (!REQUIRED_STORES[storeName]) {
      REQUIRED_STORES[storeName] = { keyPath: 'id' };
    }

    db = await performOpen(db.version + 1);
    cachedDb = db;

    if (!db.objectStoreNames.contains(storeName)) {
      const err = new Error(
        `Failed to execute 'transaction' on 'IDBDatabase': Object store "${storeName}" was not found in database "${db.name}" (version ${db.version}). Available stores: [${Array.from(
          db.objectStoreNames
        ).join(', ')}]`
      );
      console.error(err);
      throw err;
    }
  }
  return db;
}

export function formatIndexedDbError(err: unknown, context?: string): Error {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name?: unknown }).name) : '';
  const rawMsg = err instanceof Error ? err.message : String(err || 'Unknown IndexedDB error');
  if (name === 'QuotaExceededError' || /quota|storage.*full/i.test(rawMsg)) {
    return new Error(
      `Browser IndexedDB storage quota exceeded${context ? ` (${context})` : ''}. Free up space or delete old exports/projects and try again.`
    );
  }
  if (name === 'SecurityError' || /security|denied|private/i.test(rawMsg)) {
    return new Error(
      'Browser IndexedDB access is blocked in this browsing context (private mode or disabled site storage).'
    );
  }
  return err instanceof Error ? err : new Error(rawMsg);
}

export async function idbGet<T>(storeName: string, key: string): Promise<T | undefined> {
  const db = await getEnsureStoreDb(storeName);
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onerror = () => {
        console.error(`[IndexedDB Error] idbGet failed on store "${storeName}" for key "${key}":`, req.error);
        reject(formatIndexedDbError(req.error, `read ${storeName}/${key}`));
      };
      req.onsuccess = () => {
        const res = req.result;
        if (!res) return resolve(undefined);
        if (typeof res === 'object' && res !== null && 'value' in res && Object.keys(res).length <= 3) {
          return resolve(res.value as T);
        }
        return resolve(res as T);
      };
    } catch (err) {
      console.error(
        `[IndexedDB Error] Failed to create readonly transaction on store "${storeName}" (DB version ${db.version}):`,
        err
      );
      reject(formatIndexedDbError(err, `read ${storeName}`));
    }
  });
}

export async function idbSet<T>(storeName: string, key: string, value: T): Promise<void> {
  const db = await getEnsureStoreDb(storeName);
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);

      // Provide both id and key so this record works on stores configured with keyPath 'id' or 'key'
      let record: any;
      if (value && typeof value === 'object' && !(value instanceof Blob)) {
        record = { ...(value as any) };
        if (!('id' in record)) record.id = key;
        if (!('key' in record)) record.key = key;
      } else {
        record = { key, id: key, value };
      }

      const req = store.put(record);
      req.onerror = () => {
        console.error(`[IndexedDB Error] idbSet failed on store "${storeName}" for key "${key}":`, req.error);
        reject(formatIndexedDbError(req.error, `write ${storeName}/${key}`));
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        console.error(`[IndexedDB Error] Transaction error on store "${storeName}":`, tx.error);
        reject(formatIndexedDbError(tx.error, `write ${storeName}/${key}`));
      };
      tx.onabort = () => {
        reject(formatIndexedDbError(tx.error || new Error('IndexedDB write transaction aborted.'), `write ${storeName}/${key}`));
      };
    } catch (err) {
      console.error(
        `[IndexedDB Error] Failed to create readwrite transaction on store "${storeName}" (DB version ${db.version}):`,
        err
      );
      reject(formatIndexedDbError(err, `write ${storeName}`));
    }
  });
}

export async function idbDelete(storeName: string, key: string): Promise<void> {
  const db = await getEnsureStoreDb(storeName);
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.delete(key);
      req.onerror = () => {
        console.error(`[IndexedDB Error] idbDelete failed on store "${storeName}" for key "${key}":`, req.error);
        reject(req.error);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        console.error(`[IndexedDB Error] Transaction error on store "${storeName}":`, tx.error);
        reject(tx.error);
      };
    } catch (err) {
      console.error(
        `[IndexedDB Error] Failed to create readwrite transaction on store "${storeName}" (DB version ${db.version}):`,
        err
      );
      reject(err);
    }
  });
}

export async function idbList<T>(storeName: string): Promise<T[]> {
  const db = await getEnsureStoreDb(storeName);
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onerror = () => {
        console.error(`[IndexedDB Error] idbList failed on store "${storeName}":`, req.error);
        reject(req.error);
      };
      req.onsuccess = () => {
        const results = req.result || [];
        resolve(
          results.map((r: any) =>
            r && typeof r === 'object' && 'value' in r && Object.keys(r).length <= 3 ? r.value : r
          )
        );
      };
    } catch (err) {
      console.error(
        `[IndexedDB Error] Failed to create readonly transaction on store "${storeName}" (DB version ${db.version}):`,
        err
      );
      reject(err);
    }
  });
}

export async function idbListRawEntries(
  storeName: string
): Promise<Array<{ key: string; id: string; value: unknown }>> {
  const db = await getEnsureStoreDb(storeName);
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onerror = () => {
        console.error(`[IndexedDB Error] idbListRawEntries failed on store "${storeName}":`, req.error);
        reject(req.error);
      };
      req.onsuccess = () => {
        const results = (req.result || []) as any[];
        resolve(
          results.map((r) => ({
            key: typeof r?.key === 'string' ? r.key : typeof r?.id === 'string' ? r.id : '',
            id: typeof r?.id === 'string' ? r.id : typeof r?.key === 'string' ? r.key : '',
            value: r && typeof r === 'object' && 'value' in r && Object.keys(r).length <= 3 ? r.value : r,
          }))
        );
      };
    } catch (err) {
      console.error(
        `[IndexedDB Error] Failed to create readonly transaction on store "${storeName}" (DB version ${db.version}):`,
        err
      );
      reject(err);
    }
  });
}

// Blob asset storage for local media
const blobUrls = new Map<string, string>();

export function buildProjectVideoBlobKey(projectId: string | undefined, filename: string): string {
  const safeName = filename || 'video.mp4';
  return projectId ? `video_${projectId}_${Date.now()}_${safeName}` : `video_${Date.now()}_${safeName}`;
}

export function inferVideoMimeType(filename?: string | null, existingType?: string | null): string {
  const trimmed = (existingType || '').trim().toLowerCase();
  if (trimmed.startsWith('video/')) return trimmed;
  const lower = (filename || '').toLowerCase();
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mkv')) return 'video/x-matroska';
  if (lower.endsWith('.m4v') || lower.endsWith('.mp4')) return 'video/mp4';
  return 'video/mp4';
}

export function normalizeVideoBlobMime(blob: Blob, filename?: string | null): Blob {
  if (blob.type && blob.type.toLowerCase().startsWith('video/')) {
    return blob;
  }
  const inferred = inferVideoMimeType(filename, blob.type);
  return new Blob([blob], { type: inferred });
}

export async function storeBlobAsset(key: string, blob: Blob): Promise<string> {
  if (!(blob instanceof Blob) || blob.size === 0) {
    throw new Error(`Cannot store empty or invalid Blob under key "${key}".`);
  }
  await idbSet('blobs', key, blob);
  if (blobUrls.has(key)) {
    try {
      URL.revokeObjectURL(blobUrls.get(key)!);
    } catch {
      // ignore
    }
  }
  const url = URL.createObjectURL(blob);
  blobUrls.set(key, url);
  return url;
}

export async function getBlobAssetByKey(key: string): Promise<Blob | null> {
  if (!key) return null;
  const item = await idbGet<unknown>('blobs', key);
  if (item instanceof Blob && item.size > 0) {
    return item;
  }
  return null;
}

export async function getBlobAssetUrl(key: string): Promise<string | null> {
  if (blobUrls.has(key)) return blobUrls.get(key)!;
  const blob = await getBlobAssetByKey(key);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  blobUrls.set(key, url);
  return url;
}

export interface RetrievedProjectVideoBlob {
  blob: Blob;
  blobKey: string | null;
  lookupSource:
    | 'sourceVideoBlobKey'
    | 'idb-url'
    | 'project-key'
    | 'blobs-scan'
    | 'media-cache'
    | 'live-blob-url';
}

function parseBlobKeyTimestamp(key: string): number | null {
  const match = /^video_(?:[0-9a-f-]{8,}_)?(\d{10,14})_/.exec(key);
  if (!match) return null;
  const ts = Number(match[1]);
  return Number.isFinite(ts) ? ts : null;
}

function isLikelyVideoBlobEntry(key: string, blob: Blob): boolean {
  if (key.startsWith('fish_')) return false;
  if (blob.type.toLowerCase().startsWith('audio/') || blob.type.toLowerCase().startsWith('image/')) {
    return false;
  }
  if (key.startsWith('video_') || blob.type.toLowerCase().startsWith('video/')) return true;
  return /\.(mp4|mov|mkv|webm|m4v)$/i.test(key);
}

export async function retrieveProjectVideoBlob(
  project: Pick<
    Project,
    'id' | 'sourceVideoUrl' | 'sourceVideoBlobKey' | 'sourceFilename' | 'metadata' | 'createdAt' | 'updatedAt'
  >
): Promise<RetrievedProjectVideoBlob | null> {
  const filename = project.sourceFilename || null;

  // 1. Direct lookup using persisted sourceVideoBlobKey
  if (project.sourceVideoBlobKey) {
    const direct = await getBlobAssetByKey(project.sourceVideoBlobKey).catch(() => null);
    if (direct && direct.size > 0) {
      const normalized = normalizeVideoBlobMime(direct, filename || project.sourceVideoBlobKey);
      console.info('[VideoStorage] Retrieved original video Blob via sourceVideoBlobKey:', {
        projectId: project.id,
        blobFound: true,
        blobKey: project.sourceVideoBlobKey,
        size: normalized.size,
        mimeType: normalized.type,
      });
      return {
        blob: normalized,
        blobKey: project.sourceVideoBlobKey,
        lookupSource: 'sourceVideoBlobKey',
      };
    }
  }

  // 2. Direct idb://blobs/<key> scheme if present
  if (project.sourceVideoUrl && project.sourceVideoUrl.startsWith('idb://blobs/')) {
    const key = project.sourceVideoUrl.slice('idb://blobs/'.length);
    const byIdbUrl = await getBlobAssetByKey(key).catch(() => null);
    if (byIdbUrl && byIdbUrl.size > 0) {
      const normalized = normalizeVideoBlobMime(byIdbUrl, filename || key);
      console.info('[VideoStorage] Retrieved original video Blob via idb:// URL:', {
        projectId: project.id,
        blobFound: true,
        blobKey: key,
        size: normalized.size,
        mimeType: normalized.type,
      });
      return { blob: normalized, blobKey: key, lookupSource: 'idb-url' };
    }
  }

  // 3. Deterministic fallback key for recovered project blobs
  const deterministicKey = `video_project_${project.id}`;
  const deterministicBlob = await getBlobAssetByKey(deterministicKey).catch(() => null);
  if (deterministicBlob && deterministicBlob.size > 0) {
    const normalized = normalizeVideoBlobMime(deterministicBlob, filename);
    console.info('[VideoStorage] Retrieved original video Blob via deterministic project key:', {
      projectId: project.id,
      blobFound: true,
      blobKey: deterministicKey,
      size: normalized.size,
      mimeType: normalized.type,
    });
    return { blob: normalized, blobKey: deterministicKey, lookupSource: 'project-key' };
  }

  // 4. Scan "blobs" store to recover legacy uploaded projects whose sourceVideoUrl was an ephemeral blob: URL
  try {
    const entries = await idbListRawEntries('blobs');
    const targetSize = project.metadata?.fileSize || 0;
    const refTime =
      Date.parse(project.updatedAt || project.createdAt || '') ||
      Date.parse(project.createdAt || '') ||
      0;

    let bestEntry: { key: string; blob: Blob; score: number } | null = null;
    for (const entry of entries) {
      if (!entry.key || !(entry.value instanceof Blob) || entry.value.size <= 0) continue;
      if (!isLikelyVideoBlobEntry(entry.key, entry.value)) continue;

      let score = 0;
      const matchesProjectId = entry.key.includes(`_${project.id}_`);
      const matchesFilename = Boolean(
        filename &&
          (entry.key === filename ||
            entry.key.endsWith(`_${filename}`) ||
            entry.key.toLowerCase().endsWith(`_${filename.toLowerCase()}`))
      );
      const matchesSize = targetSize > 0 && entry.value.size === targetSize;

      if (matchesProjectId) score += 150;
      if (matchesFilename) score += 100;
      if (matchesSize) score += 80;
      if (entry.key.startsWith('video_')) score += 15;

      // Require at least filename, project ID, or exact file size match (or single video blob when project expects a local blob)
      if (!matchesProjectId && !matchesFilename && !matchesSize) continue;

      if (refTime > 0) {
        const keyTs = parseBlobKeyTimestamp(entry.key);
        if (keyTs) {
          const diffHours = Math.abs(refTime - keyTs) / (1000 * 60 * 60);
          score += Math.max(0, 30 - Math.min(30, diffHours));
        }
      }

      if (!bestEntry || score > bestEntry.score) {
        bestEntry = { key: entry.key, blob: entry.value, score };
      }
    }

    if (bestEntry) {
      const normalized = normalizeVideoBlobMime(bestEntry.blob, filename || bestEntry.key);
      // Non-destructively backfill sourceVideoBlobKey on stored project record so future loads are O(1)
      try {
        const storedProj = await idbGet<Project>('projects', project.id);
        if (storedProj && !storedProj.sourceVideoBlobKey) {
          await idbSet('projects', project.id, {
            ...storedProj,
            sourceVideoBlobKey: bestEntry.key,
          });
        }
      } catch {
        // Non-fatal; keep returning retrieved Blob
      }

      console.info('[VideoStorage] Recovered original video Blob from blobs store scan:', {
        projectId: project.id,
        blobFound: true,
        blobKey: bestEntry.key,
        size: normalized.size,
        mimeType: normalized.type,
      });
      return {
        blob: normalized,
        blobKey: bestEntry.key,
        lookupSource: 'blobs-scan',
      };
    }
  } catch (err) {
    console.warn('[VideoStorage] Blobs store scan failed:', err);
  }

  // 5. Check indexedDbStore mediaCache (used for synced/cached URLs)
  if (project.sourceVideoUrl) {
    const cached = await indexedDbStore.getCachedMediaByUrl(project.sourceVideoUrl).catch(() => null);
    if (cached && cached.blob && cached.blob.size > 0) {
      const normalized = normalizeVideoBlobMime(cached.blob, filename || cached.filename);
      console.info('[VideoStorage] Retrieved original video Blob from mediaCache:', {
        projectId: project.id,
        blobFound: true,
        blobKey: null,
        size: normalized.size,
        mimeType: normalized.type,
      });
      return { blob: normalized, blobKey: null, lookupSource: 'media-cache' };
    }
  }

  // 6. Last-resort fallback for same-session live blob: URLs not yet persisted under blobs store
  if (project.sourceVideoUrl && project.sourceVideoUrl.startsWith('blob:')) {
    try {
      const res = await fetch(project.sourceVideoUrl);
      if (res.ok) {
        const rawBlob = await res.blob();
        if (rawBlob.size > 0) {
          const normalized = normalizeVideoBlobMime(rawBlob, filename);
          try {
            await idbSet('blobs', deterministicKey, normalized);
            const storedProj = await idbGet<Project>('projects', project.id);
            if (storedProj && !storedProj.sourceVideoBlobKey) {
              await idbSet('projects', project.id, {
                ...storedProj,
                sourceVideoBlobKey: deterministicKey,
              });
            }
          } catch {
            // ignore persistence failure
          }
          console.info('[VideoStorage] Retrieved original video Blob from live blob URL:', {
            projectId: project.id,
            blobFound: true,
            blobKey: deterministicKey,
            size: normalized.size,
            mimeType: normalized.type,
          });
          return { blob: normalized, blobKey: deterministicKey, lookupSource: 'live-blob-url' };
        }
      }
    } catch {
      // Stale blob URL from an older browser session; return null below
    }
  }

  console.warn('[VideoStorage] Video Blob not found in IndexedDB for project:', {
    projectId: project.id,
    blobFound: false,
    sourceVideoBlobKey: project.sourceVideoBlobKey || null,
    sourceFilename: filename,
    sourceVideoUrlKind: project.sourceVideoUrl ? project.sourceVideoUrl.split(':')[0] : null,
  });
  return null;
}

export function buildAssetBlobKey(
  bucket: string,
  projectId: string | undefined,
  filename: string
): string {
  const safeName = (filename || 'asset.bin').replace(/[^a-zA-Z0-9._-]+/g, '_');
  const prefixMap: Record<string, string> = {
    uploads: 'video',
    exports: 'export',
    music: 'bgm',
    sfx: 'sfx',
    logos: 'logo',
    backgrounds: 'bg',
    thumbs: 'thumb',
    fonts: 'font',
    masks: 'mask',
    audio: 'audio',
  };
  const prefix = prefixMap[bucket] || bucket || 'asset';
  return projectId
    ? `${prefix}_${projectId}_${Date.now()}_${safeName}`
    : `${prefix}_${Date.now()}_${safeName}`;
}

export async function deleteBlobAsset(key: string): Promise<void> {
  if (!key) return;
  const cleanKey = key.startsWith('idb://blobs/') ? key.slice('idb://blobs/'.length) : key;
  if (blobUrls.has(cleanKey)) {
    try {
      URL.revokeObjectURL(blobUrls.get(cleanKey)!);
    } catch {
      // ignore
    }
    blobUrls.delete(cleanKey);
  }
  await idbDelete('blobs', cleanKey);
}

export async function listMergedLocalProjects(): Promise<Project[]> {
  const [primary, snapshots] = await Promise.all([
    idbList<Project>('projects'),
    indexedDbStore.listProjectSnapshots().catch(() => [] as Project[]),
  ]);

  const byId = new Map<string, Project>();
  for (const p of primary || []) {
    if (p && p.id) byId.set(p.id, p);
  }

  for (const snap of snapshots || []) {
    if (!snap || !snap.id) continue;
    const existing = byId.get(snap.id);
    if (!existing) {
      byId.set(snap.id, snap);
      await idbSet('projects', snap.id, snap).catch(() => undefined);
    } else {
      const existingTime = Date.parse(existing.updatedAt || existing.createdAt || '') || 0;
      const snapTime = Date.parse(snap.updatedAt || snap.createdAt || '') || 0;
      if (snapTime > existingTime) {
        byId.set(snap.id, snap);
        await idbSet('projects', snap.id, snap).catch(() => undefined);
      }
    }
  }

  return Array.from(byId.values()).sort((a, b) =>
    String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''))
  );
}

export async function deleteProjectLocalAssets(projectId: string): Promise<void> {
  if (!projectId) return;
  await Promise.all([
    idbDelete('projects', projectId).catch(() => undefined),
    idbDelete('filmstrips', projectId).catch(() => undefined),
    idbDelete('waveforms', projectId).catch(() => undefined),
    indexedDbStore.deleteProjectSnapshot(projectId).catch(() => undefined),
  ]);

  try {
    const jobs = await idbList<RenderJob>('jobs');
    for (const job of jobs || []) {
      if (job?.projectId === projectId && job.id) {
        await idbDelete('jobs', job.id).catch(() => undefined);
      }
    }
  } catch {
    // ignore cleanup errors
  }

  try {
    const entries = await idbListRawEntries('blobs');
    for (const entry of entries || []) {
      if (entry.key && (entry.key.includes(`_${projectId}_`) || entry.key === `video_project_${projectId}`)) {
        await deleteBlobAsset(entry.key).catch(() => undefined);
      }
    }
  } catch {
    // ignore cleanup errors
  }
}

export async function computeIndexedDbUsage(): Promise<{
  totalBytes: number;
  buckets: Record<string, { bytes: number; files: number }>;
}> {
  const buckets: Record<string, { bytes: number; files: number }> = {
    uploads: { bytes: 0, files: 0 },
    exports: { bytes: 0, files: 0 },
    audio: { bytes: 0, files: 0 },
    music: { bytes: 0, files: 0 },
    logos: { bytes: 0, files: 0 },
    backgrounds: { bytes: 0, files: 0 },
    fonts: { bytes: 0, files: 0 },
    thumbs: { bytes: 0, files: 0 },
    other: { bytes: 0, files: 0 },
  };
  let totalBytes = 0;

  try {
    const entries = await idbListRawEntries('blobs');
    for (const entry of entries || []) {
      const sz = entry.value instanceof Blob ? entry.value.size : 0;
      if (sz <= 0) continue;
      totalBytes += sz;
      const k = entry.key || '';
      const bucket = k.startsWith('video_')
        ? 'uploads'
        : k.startsWith('export_')
        ? 'exports'
        : k.startsWith('fish_') || k.startsWith('audio_')
        ? 'audio'
        : k.startsWith('bgm_') || k.startsWith('sfx_')
        ? 'music'
        : k.startsWith('logo_')
        ? 'logos'
        : k.startsWith('bg_')
        ? 'backgrounds'
        : k.startsWith('font_')
        ? 'fonts'
        : k.startsWith('thumb_')
        ? 'thumbs'
        : 'other';
      buckets[bucket].bytes += sz;
      buckets[bucket].files += 1;
    }
  } catch {
    // ignore
  }

  return { totalBytes, buckets };
}

