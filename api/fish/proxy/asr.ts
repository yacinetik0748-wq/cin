import type { IncomingMessage, ServerResponse } from 'node:http';

const DEFAULT_FISH_API_BASE = 'https://api.fish.audio';

function normalizeFishBase(raw?: string | null): string {
  const cleaned = (raw || DEFAULT_FISH_API_BASE)
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1$/i, '');
  return cleaned || DEFAULT_FISH_API_BASE;
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

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Fish-Api-Key, model');

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

    const contentType = req.headers['content-type'];
    if (typeof contentType !== 'string' || !contentType) {
      sendJson(res, 400, { error: 'Multipart form-data audio payload is required for ASR.' });
      return;
    }

    const bodyBuffer = await readRawBody(req);
    const fishBase = normalizeFishBase(process.env.FISH_API_BASE_URL);
    const asrEndpoint = `${fishBase}/v1/asr`;

    console.info(`[Fish ASR Proxy:Vercel] POST ${asrEndpoint}`);

    const upstream = await fetch(asrEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': contentType,
        model: 'transcribe-1-pro',
      },
      body: new Uint8Array(bodyBuffer),
    });

    const rawText = await upstream.text();
    res.setHeader('X-Fish-Proxy', 'vercel');
    res.setHeader('X-Fish-Upstream-Url', asrEndpoint);

    if (!upstream.ok) {
      sendJson(res, upstream.status, {
        error: sanitizeText(rawText) || `Fish Audio ASR error (${upstream.status})`,
      });
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(rawText);
  } catch (err) {
    sendJson(res, 502, {
      error: err instanceof Error ? sanitizeText(err.message) : 'Fish Audio ASR proxy failed',
    });
  }
}
