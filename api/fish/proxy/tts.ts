import type { IncomingMessage, ServerResponse } from 'node:http';

const DEFAULT_FISH_API_BASE = 'https://api.fish.audio';
const DEFAULT_FISH_TTS_MODEL = 's2.1-pro-free';

function normalizeFishBase(raw?: string | null): string {
  const cleaned = (raw || DEFAULT_FISH_API_BASE)
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1$/i, '');
  return cleaned || DEFAULT_FISH_API_BASE;
}

function validateReferenceId(raw?: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (lower === 'default' || lower === 'none' || lower === 'null' || lower === 'undefined') {
    return undefined;
  }
  if (/^https?:\/\//i.test(trimmed) || trimmed.includes('/')) {
    throw new Error(
      'Invalid Fish Audio reference_id: received a URL or path instead of a Fish Audio model ID.'
    );
  }
  if (/\s/.test(trimmed)) {
    throw new Error(
      `Invalid Fish Audio reference_id "${trimmed}": received a voice name with spaces instead of a Fish Audio model ID.`
    );
  }
  if (!/^[a-zA-Z0-9_-]{4,128}$/.test(trimmed)) {
    throw new Error(
      `Invalid Fish Audio reference_id "${trimmed}": expected an alphanumeric Fish Audio model ID.`
    );
  }
  return trimmed;
}

function normalizeApiKey(raw?: unknown): string {
  if (typeof raw !== 'string') return '';
  let cleaned = raw.replace(/[\r\n\t\u200B-\u200D\uFEFF\u00A0]/g, '').trim();
  cleaned = cleaned
    .replace(/^authorization\s*:\s*/i, '')
    .replace(/^fish_api_key\s*=\s*/i, '')
    .trim();
  for (let i = 0; i < 2; i++) {
    if (
      (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith("'") && cleaned.endsWith("'")) ||
      (cleaned.startsWith('`') && cleaned.endsWith('`'))
    ) {
      cleaned = cleaned.slice(1, -1).trim();
    }
  }
  while (/^bearer\s+/i.test(cleaned)) {
    cleaned = cleaned.replace(/^bearer\s+/i, '').trim();
  }
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  if (!cleaned || cleaned === 'MY_FISH_API_KEY') return '';
  return cleaned;
}

function sanitizeText(raw: string, secretToRedact?: string): string {
  let out = (raw || '')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/(x-fish-api-key\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
  if (secretToRedact && secretToRedact.trim().length >= 4) {
    out = out.split(secretToRedact.trim()).join('[REDACTED]');
  }
  return out.trim().slice(0, 400);
}

async function readJsonBody(req: IncomingMessage & { body?: unknown }): Promise<Record<string, unknown>> {
  if (req.body && typeof req.body === 'object') {
    return req.body as Record<string, unknown>;
  }
  if (typeof req.body === 'string' && req.body.trim()) {
    return JSON.parse(req.body) as Record<string, unknown>;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse
): Promise<void> {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Fish-Api-Key, model');
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Type, Content-Length, X-Fish-Proxy, X-Fish-Upstream-Url, X-Fish-Response-Url'
  );

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed. Use POST.' });
    return;
  }

  try {
    const rawHeaderKey = req.headers['x-fish-api-key'];
    const hasHeaderKey = rawHeaderKey !== undefined;
    const headerKey = typeof rawHeaderKey === 'string' ? normalizeApiKey(rawHeaderKey) : '';
    const apiKey = hasHeaderKey ? headerKey : normalizeApiKey(process.env.FISH_API_KEY);
    if (!apiKey) {
      sendJson(res, 401, { error: 'Fish Audio API key is required.' });
      return;
    }

    const reqBody = await readJsonBody(req);
    const text = typeof reqBody.text === 'string' ? reqBody.text.trim() : '';
    if (!text) {
      sendJson(res, 400, { error: 'TTS text is required.' });
      return;
    }

    let validRefId: string | undefined;
    try {
      validRefId = validateReferenceId(reqBody.reference_id);
    } catch (refErr) {
      sendJson(res, 400, {
        error: refErr instanceof Error ? refErr.message : 'Invalid reference_id.',
      });
      return;
    }

    const upstreamPayload: Record<string, unknown> = {
      text,
      format: typeof reqBody.format === 'string' && reqBody.format ? reqBody.format : 'mp3',
    };
    if (validRefId) {
      upstreamPayload.reference_id = validRefId;
    }

    const fishBase = normalizeFishBase(process.env.FISH_API_BASE_URL);
    const ttsEndpoint = `${fishBase}/v1/tts`;
    const rawModel = req.headers.model;
    const modelHeader =
      (typeof rawModel === 'string' ? rawModel.trim() : '') || DEFAULT_FISH_TTS_MODEL;

    console.info(
      `[Fish TTS Proxy:Vercel] POST ${ttsEndpoint} (model=${modelHeader}, hasReferenceId=${Boolean(validRefId)})`
    );

    const upstream = await fetch(ttsEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        model: modelHeader,
      },
      body: JSON.stringify(upstreamPayload),
    });

    res.setHeader('X-Fish-Proxy', 'vercel');
    res.setHeader('X-Fish-Upstream-Url', ttsEndpoint);
    res.setHeader('X-Fish-Response-Url', upstream.url || ttsEndpoint);

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      const cleanBody = sanitizeText(errText, apiKey);
      sendJson(res, upstream.status, {
        error: cleanBody || `Fish Audio TTS error (${upstream.status})`,
        rawBody: cleanBody,
        status: upstream.status,
        errorCode: upstream.headers.get('x-fish-error-code') || undefined,
        errorSource: upstream.headers.get('x-fish-error-source') || undefined,
        endpoint: ttsEndpoint,
        responseUrl: upstream.url || ttsEndpoint,
      });
      return;
    }

    const arrayBuf = await upstream.arrayBuffer();
    res.statusCode = 200;
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
    res.end(Buffer.from(arrayBuf));
  } catch (err) {
    sendJson(res, 502, {
      error: err instanceof Error ? sanitizeText(err.message) : 'Fish Audio TTS proxy failed',
    });
  }
}
