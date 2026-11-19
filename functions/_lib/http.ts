export function corsHeaders(request?: Request): HeadersInit {
  const origin = request?.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
    'Access-Control-Allow-Headers':
      'Origin, X-Requested-With, Content-Type, Accept, Authorization, Range, X-Fish-Api-Key, model',
    'Access-Control-Expose-Headers':
      'Content-Length, Content-Range, Accept-Ranges, Content-Disposition, X-Fish-Proxy, X-Fish-Upstream-Url, X-Fish-Response-Url',
    'Access-Control-Max-Age': '86400',
    ...(origin !== '*' ? { 'Access-Control-Allow-Credentials': 'true' } : {}),
  };
}

export function optionsResponse(request?: Request): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request),
  });
}

export function jsonResponse(
  data: unknown,
  status = 200,
  request?: Request,
  extraHeaders?: HeadersInit
): Response {
  const headers = new Headers(corsHeaders(request));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  if (extraHeaders) {
    const extra = new Headers(extraHeaders);
    extra.forEach((v, k) => headers.set(k, v));
  }
  return new Response(JSON.stringify(data), { status, headers });
}

export function errorJson(
  error: string,
  status = 500,
  request?: Request,
  code?: string
): Response {
  return jsonResponse(code ? { error, code } : { error }, status, request);
}

export async function readJsonBody<T = Record<string, unknown>>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text.trim()) return {} as T;
  return JSON.parse(text) as T;
}

export function getMimeType(filename: string): string {
  const clean = filename.split('?')[0].toLowerCase();
  const dot = clean.lastIndexOf('.');
  const ext = dot >= 0 ? clean.slice(dot) : '';
  const map: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.aac': 'audio/aac',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.json': 'application/json; charset=utf-8',
    '.srt': 'text/plain; charset=utf-8',
    '.vtt': 'text/vtt; charset=utf-8',
  };
  return map[ext] || 'application/octet-stream';
}

export function sanitizeFilename(name: string, fallback = 'file.bin'): string {
  const base = (name || fallback).split('/').pop()?.split('\\').pop() || fallback;
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned || fallback;
}

export function parseByteRange(
  rangeHeader: string,
  totalSize: number
): { start: number; end: number; length: number } | 'invalid' {
  const m = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!m) return 'invalid';
  const startStr = m[1];
  const endStr = m[2];
  let start = 0;
  let end = totalSize - 1;

  if (startStr === '' && endStr !== '') {
    const suffix = parseInt(endStr, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, totalSize - suffix);
  } else {
    start = startStr ? parseInt(startStr, 10) : 0;
    end = endStr ? parseInt(endStr, 10) : totalSize - 1;
  }

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    start >= totalSize ||
    end < start
  ) {
    return 'invalid';
  }

  const clampedEnd = Math.min(totalSize - 1, end);
  return {
    start,
    end: clampedEnd,
    length: clampedEnd - start + 1,
  };
}
