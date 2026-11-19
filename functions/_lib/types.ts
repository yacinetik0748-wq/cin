export interface Env {
  DB?: D1Database;
  MEDIA_BUCKET?: R2Bucket;
  BACKEND_URL?: string;
  VITE_API_BASE_URL?: string;
  API_URL?: string;
  FISH_API_KEY?: string;
  FISH_API_BASE_URL?: string;
  SECRETS_ENCRYPTION_KEY?: string;
  APP_SECRET?: string;
  GEMINI_API_KEY?: string;
  MAX_UPLOAD_SIZE_MB?: string;
  TEMP_RETENTION_HOURS?: string;
}

export class HttpError extends Error {
  statusCode: number;
  code?: string;

  constructor(message: string, statusCode = 500, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function getErrorStatus(err: unknown, fallback = 500): number {
  if (err && typeof err === 'object' && 'statusCode' in err) {
    const code = Number((err as { statusCode?: unknown }).statusCode);
    if (Number.isFinite(code) && code >= 400 && code < 600) {
      return code;
    }
  }
  return fallback;
}

export function getErrorCode(err: unknown, fallback?: string): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return fallback;
}
