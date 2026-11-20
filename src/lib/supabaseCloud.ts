/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Project, CloudAssetManifestEntry } from '../types/studio';
import { resolveApiUrl } from './api';
import { getBlobAssetByKey, getBlobAssetUrl } from './browserStorage';
import { indexedDbStore, normalizeMediaUrlCacheKey } from './indexedDbStore';

const memoizedObjectUrls = new Map<
  string,
  { cachedAt: string; sizeBytes: number; objectUrl: string }
>();

export function revokeCachedObjectUrl(url: string): void {
  const key = normalizeMediaUrlCacheKey(url);
  const existing = memoizedObjectUrls.get(key);
  if (existing) {
    try {
      URL.revokeObjectURL(existing.objectUrl);
    } catch {
      // ignore
    }
    memoizedObjectUrls.delete(key);
  }
}

export function isSupabaseConfigured(): boolean {
  return false;
}

export function getSupabaseClient() {
  return {
    auth: {
      onAuthStateChange: (
        _callback: (
          evt: string,
          session: { user?: { id: string; email?: string } | null } | null
        ) => void
      ) => {
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
    },
  };
}

export async function getCloudSession(): Promise<{ user: { id: string; email: string } | null }> {
  return { user: null };
}

export async function resolvePlayableAssetUrl(
  url: string | null,
  _cloudAssets?: Record<string, CloudAssetManifestEntry>
): Promise<string | null> {
  if (!url) return null;
  if (
    url.startsWith('blob:') ||
    url.startsWith('data:') ||
    url.startsWith('http://') ||
    url.startsWith('https://')
  ) {
    return url;
  }

  const cached = await indexedDbStore.getCachedMediaByUrl(url);
  if (cached && cached.blob && cached.blob.size > 0) {
    const key = normalizeMediaUrlCacheKey(url);
    const existing = memoizedObjectUrls.get(key);
    if (
      existing &&
      existing.cachedAt === cached.cachedAt &&
      existing.sizeBytes === cached.sizeBytes
    ) {
      return existing.objectUrl;
    }
    if (existing) {
      try {
        URL.revokeObjectURL(existing.objectUrl);
      } catch {
        // ignore
      }
    }
    const objectUrl = URL.createObjectURL(cached.blob);
    memoizedObjectUrls.set(key, {
      cachedAt: cached.cachedAt,
      sizeBytes: cached.sizeBytes,
      objectUrl,
    });
    return objectUrl;
  }

  if (url.startsWith('idb://blobs/')) {
    const key = url.slice('idb://blobs/'.length);
    const localObjUrl = await getBlobAssetUrl(key).catch(() => null);
    if (localObjUrl) return localObjUrl;
  }

  if (url.startsWith('idb://')) {
    return null;
  }

  return resolveApiUrl(url);
}

export async function downloadProjectAsset(opts: {
  url?: string | null;
  localUrl?: string | null;
  filename: string;
  cloudAssets?: Record<string, CloudAssetManifestEntry>;
}): Promise<void> {
  const rawTarget = opts.url || opts.localUrl;
  if (!rawTarget) return;

  let blob: Blob | null = null;
  if (rawTarget.startsWith('idb://blobs/')) {
    const key = rawTarget.slice('idb://blobs/'.length);
    blob = await getBlobAssetByKey(key).catch(() => null);
  }
  if (!blob) {
    const cached = await indexedDbStore.getCachedMediaByUrl(rawTarget);
    if (cached && cached.blob && cached.blob.size > 0) {
      blob = cached.blob;
    }
  }
  if (!blob) {
    const targetUrl = resolveApiUrl(rawTarget);
    const fetchUrl =
      targetUrl.startsWith('blob:') || targetUrl.startsWith('data:')
        ? targetUrl
        : `${targetUrl}${targetUrl.includes('?') ? '&' : '?'}download=1`;
    const res = await fetch(fetchUrl);
    if (!res.ok) {
      throw new Error(`Download failed (HTTP ${res.status}): Asset is unavailable.`);
    }
    blob = await res.blob();
  }

  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = opts.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Keep blob URL alive for 60 seconds so Android download manager doesn't cancel
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
}

export async function hydrateProjectAssetsFromCloud(_project: Project): Promise<Project> {
  return _project;
}

export function queueDebouncedMetadataSync(
  project: Project,
  callback?: (synced: Project) => void
): void {
  if (callback) callback(project);
}

export function subscribeToCloudProjectsRealtime(
  _userId: string,
  _onEvent: (evt: { eventType: string; projectId?: string; project?: Project }) => void
): () => void {
  return () => {};
}

export async function uploadSingleProjectAssetToCloud(
  project: Project,
  _localUrl: string,
  _opts?: { signal?: AbortSignal; onProgress?: (pct: number, stage: string) => void }
): Promise<{
  project: Project;
  message: string;
  failedUploads: Array<{ filename: string; sizeBytes: number; reason: string }>;
  skippedLargeAssets: Array<{ filename: string; sizeBytes: number; reason: string }>;
  cancelled: boolean;
}> {
  return {
    project,
    message: 'Saved locally (100% local mode).',
    failedUploads: [],
    skippedLargeAssets: [],
    cancelled: false,
  };
}
