import { Env } from './types.ts';
import { getMimeType, parseByteRange, sanitizeFilename } from './http.ts';

// D1 individual row limit is ~2 MB; keep media_blobs safely under 700 KB per asset
export const D1_BLOB_MAX_BYTES = 700 * 1024;

export interface SavedBinaryResult {
  url: string;
  key: string;
  sizeBytes: number;
  storedIn: 'r2' | 'd1' | 'client-only';
}

export function mediaUrlToKey(url: string): string {
  const clean = (url || '').split('?')[0].trim();
  if (clean.startsWith('/media/')) return clean.slice('/media/'.length);
  if (clean.startsWith('/storage/')) return clean.slice('/storage/'.length);
  return clean.replace(/^\/+/, '');
}

export async function registerD1Asset(
  db: D1Database,
  asset: {
    id: string;
    projectId: string | null;
    kind: string;
    filename: string;
    filePath: string;
    url: string;
    mimeType: string;
    sizeBytes: number;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO assets (id, project_id, kind, filename, file_path, url, mime_type, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      asset.id,
      asset.projectId,
      asset.kind,
      asset.filename,
      asset.filePath,
      asset.url,
      asset.mimeType,
      asset.sizeBytes,
      new Date().toISOString()
    )
    .run();
}

export async function saveBinaryAsset(
  env: Env,
  params: {
    projectId: string | null;
    kind: string;
    bucket: string;
    filename: string;
    mimeType?: string;
    bytes: Uint8Array;
  }
): Promise<SavedBinaryResult> {
  const safeName = sanitizeFilename(params.filename);
  const key = `${params.bucket}/${safeName}`;
  const url = `/media/${key}`;
  const mimeType = params.mimeType || getMimeType(safeName);
  const sizeBytes = params.bytes.byteLength;

  if (env.MEDIA_BUCKET) {
    await env.MEDIA_BUCKET.put(key, params.bytes, {
      httpMetadata: { contentType: mimeType },
    });
    if (env.DB) {
      await registerD1Asset(env.DB, {
        id: crypto.randomUUID(),
        projectId: params.projectId,
        kind: params.kind,
        filename: safeName,
        filePath: `r2://${key}`,
        url,
        mimeType,
        sizeBytes,
      });
    }
    return { url, key, sizeBytes, storedIn: 'r2' };
  }

  if (env.DB && sizeBytes <= D1_BLOB_MAX_BYTES) {
    const now = new Date().toISOString();
    await env.DB
      .prepare(
        `INSERT OR REPLACE INTO media_blobs (key, mime_type, data, size_bytes, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(key, mimeType, params.bytes, sizeBytes, now)
      .run();

    await registerD1Asset(env.DB, {
      id: crypto.randomUUID(),
      projectId: params.projectId,
      kind: params.kind,
      filename: safeName,
      filePath: `d1://${key}`,
      url,
      mimeType,
      sizeBytes,
    });
    return { url, key, sizeBytes, storedIn: 'd1' };
  }

  // Without R2 and > D1_BLOB_MAX_BYTES: register metadata pointing to client IndexedDB storage
  if (env.DB) {
    await registerD1Asset(env.DB, {
      id: crypto.randomUUID(),
      projectId: params.projectId,
      kind: params.kind,
      filename: safeName,
      filePath: `idb://${key}`,
      url,
      mimeType,
      sizeBytes,
    });
  }
  return { url, key, sizeBytes, storedIn: 'client-only' };
}

export async function checkBinaryAssetExists(env: Env, url: string): Promise<boolean> {
  if (!url) return false;
  if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('idb:')) {
    return true;
  }
  const key = mediaUrlToKey(url);
  if (!key) return false;

  if (env.MEDIA_BUCKET) {
    const head = await env.MEDIA_BUCKET.head(key);
    if (head && head.size > 0) return true;
  }

  if (env.DB) {
    const blob = await env.DB
      .prepare('SELECT size_bytes FROM media_blobs WHERE key = ?')
      .bind(key)
      .first<{ size_bytes: number }>();
    if (blob && blob.size_bytes > 0) return true;
  }

  return false;
}

export async function readBinaryAssetBytes(
  env: Env,
  url: string
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  const key = mediaUrlToKey(url);
  if (!key) return null;

  if (env.MEDIA_BUCKET) {
    const obj = await env.MEDIA_BUCKET.get(key);
    if (obj) {
      const ab = await obj.arrayBuffer();
      return {
        bytes: new Uint8Array(ab),
        mimeType: obj.httpMetadata?.contentType || getMimeType(key),
      };
    }
  }

  if (env.DB) {
    const row = await env.DB
      .prepare('SELECT mime_type, data FROM media_blobs WHERE key = ?')
      .bind(key)
      .first<{ mime_type: string; data: ArrayBuffer | number[] | Uint8Array }>();
    if (row && row.data) {
      const bytes =
        row.data instanceof Uint8Array
          ? row.data
          : row.data instanceof ArrayBuffer
          ? new Uint8Array(row.data)
          : new Uint8Array(row.data);
      return {
        bytes,
        mimeType: row.mime_type || getMimeType(key),
      };
    }
  }

  return null;
}

export async function deleteBinaryAssetByUrl(env: Env, url: string): Promise<void> {
  const key = mediaUrlToKey(url);
  if (!key) return;
  if (env.MEDIA_BUCKET) {
    await env.MEDIA_BUCKET.delete(key).catch(() => undefined);
  }
  if (env.DB) {
    await env.DB.prepare('DELETE FROM media_blobs WHERE key = ?').bind(key).run();
    await env.DB.prepare('DELETE FROM assets WHERE url = ?').bind(url).run();
  }
}

export async function serveMediaKey(
  env: Env,
  request: Request,
  key: string
): Promise<Response | null> {
  const urlObj = new URL(request.url);
  const filename = key.split('/').pop() || 'asset.bin';
  const isExport = key.startsWith('exports/');
  const isDownload = urlObj.searchParams.get('download') === '1';

  const baseHeaders = new Headers({
    'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Expose-Headers':
      'Content-Length, Content-Range, Accept-Ranges, Content-Disposition',
    'Accept-Ranges': 'bytes',
  });
  if (isExport) {
    baseHeaders.set('Cache-Control', 'no-store, must-revalidate');
  } else {
    baseHeaders.set('Cache-Control', 'public, max-age=86400');
  }
  if (isDownload) {
    baseHeaders.set('Content-Disposition', `attachment; filename="${sanitizeFilename(filename)}"`);
  }

  // 1. Cloudflare R2 bucket (supports zero-copy range reads!)
  if (env.MEDIA_BUCKET) {
    if (request.method === 'HEAD') {
      const head = await env.MEDIA_BUCKET.head(key);
      if (head && head.size > 0) {
        baseHeaders.set('Content-Type', head.httpMetadata?.contentType || getMimeType(filename));
        baseHeaders.set('Content-Length', String(head.size));
        return new Response(null, { status: 200, headers: baseHeaders });
      }
    } else {
      const rangeHeader = request.headers.get('Range');
      if (rangeHeader) {
        const head = await env.MEDIA_BUCKET.head(key);
        if (head && head.size > 0) {
          const parsed = parseByteRange(rangeHeader, head.size);
          if (parsed === 'invalid') {
            baseHeaders.set('Content-Range', `bytes */${head.size}`);
            return new Response(null, { status: 416, headers: baseHeaders });
          }
          const obj = await env.MEDIA_BUCKET.get(key, {
            range: { offset: parsed.start, length: parsed.length },
          });
          if (obj) {
            baseHeaders.set(
              'Content-Type',
              obj.httpMetadata?.contentType || getMimeType(filename)
            );
            baseHeaders.set('Content-Length', String(parsed.length));
            baseHeaders.set(
              'Content-Range',
              `bytes ${parsed.start}-${parsed.end}/${head.size}`
            );
            return new Response(obj.body, { status: 206, headers: baseHeaders });
          }
        }
      } else {
        const obj = await env.MEDIA_BUCKET.get(key);
        if (obj && obj.size > 0) {
          baseHeaders.set(
            'Content-Type',
            obj.httpMetadata?.contentType || getMimeType(filename)
          );
          baseHeaders.set('Content-Length', String(obj.size));
          return new Response(obj.body, { status: 200, headers: baseHeaders });
        }
      }
    }
  }

  // 2. Fallback: Cloudflare D1 media_blobs table (zero-card storage for small assets)
  if (env.DB) {
    const row = await env.DB
      .prepare('SELECT mime_type, data, size_bytes FROM media_blobs WHERE key = ?')
      .bind(key)
      .first<{ mime_type: string; data: ArrayBuffer | number[] | Uint8Array; size_bytes: number }>();

    if (row && row.size_bytes > 0) {
      const mimeType = row.mime_type || getMimeType(filename);
      baseHeaders.set('Content-Type', mimeType);

      if (request.method === 'HEAD') {
        baseHeaders.set('Content-Length', String(row.size_bytes));
        return new Response(null, { status: 200, headers: baseHeaders });
      }

      const bytes =
        row.data instanceof Uint8Array
          ? row.data
          : row.data instanceof ArrayBuffer
          ? new Uint8Array(row.data)
          : new Uint8Array(row.data);

      const rangeHeader = request.headers.get('Range');
      if (rangeHeader) {
        const parsed = parseByteRange(rangeHeader, bytes.byteLength);
        if (parsed === 'invalid') {
          baseHeaders.set('Content-Range', `bytes */${bytes.byteLength}`);
          return new Response(null, { status: 416, headers: baseHeaders });
        }
        const slice = bytes.subarray(parsed.start, parsed.end + 1);
        baseHeaders.set('Content-Length', String(parsed.length));
        baseHeaders.set(
          'Content-Range',
          `bytes ${parsed.start}-${parsed.end}/${bytes.byteLength}`
        );
        return new Response(slice, { status: 206, headers: baseHeaders });
      }

      baseHeaders.set('Content-Length', String(bytes.byteLength));
      return new Response(bytes, { status: 200, headers: baseHeaders });
    }
  }

  return null;
}

export async function computeCloudStorageUsage(env: Env): Promise<{
  totalBytes: number;
  fileCount: number;
  buckets: Record<string, { bytes: number; files: number }>;
  storageDir: string;
  uploadsBytes: number;
  exportsBytes: number;
  audioBytes: number;
  thumbsBytes: number;
  otherBytes: number;
}> {
  const buckets: Record<string, { bytes: number; files: number }> = {
    uploads: { bytes: 0, files: 0 },
    exports: { bytes: 0, files: 0 },
    audio: { bytes: 0, files: 0 },
    music: { bytes: 0, files: 0 },
    logos: { bytes: 0, files: 0 },
    backgrounds: { bytes: 0, files: 0 },
    fonts: { bytes: 0, files: 0 },
    masks: { bytes: 0, files: 0 },
    thumbs: { bytes: 0, files: 0 },
    other: { bytes: 0, files: 0 },
  };

  let totalBytes = 0;
  let fileCount = 0;

  if (env.DB) {
    const rows = await env.DB
      .prepare('SELECT url, size_bytes FROM assets')
      .all<{ url: string; size_bytes: number }>();

    for (const r of rows.results || []) {
      const sz = Math.max(0, Number(r.size_bytes) || 0);
      totalBytes += sz;
      fileCount += 1;
      const key = mediaUrlToKey(r.url);
      const bucket = key.split('/')[0] || 'other';
      const target = buckets[bucket] ? bucket : 'other';
      buckets[target].bytes += sz;
      buckets[target].files += 1;
    }
  }

  const uploadsBytes = buckets.uploads.bytes;
  const exportsBytes = buckets.exports.bytes;
  const audioBytes = buckets.audio.bytes + buckets.music.bytes;
  const thumbsBytes = buckets.thumbs.bytes;
  const otherBytes = Math.max(0, totalBytes - uploadsBytes - exportsBytes - audioBytes - thumbsBytes);

  return {
    totalBytes,
    fileCount,
    buckets,
    storageDir: !env.DB
      ? 'Browser IndexedDB (Local Only)'
      : env.MEDIA_BUCKET
      ? 'Cloudflare D1 + R2'
      : 'Cloudflare D1 + IndexedDB (Browser)',
    uploadsBytes,
    exportsBytes,
    audioBytes,
    thumbsBytes,
    otherBytes,
  };
}
