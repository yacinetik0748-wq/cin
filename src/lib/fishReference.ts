export const DEFAULT_FISH_API_BASE = 'https://api.fish.audio';
export const DEFAULT_FISH_TTS_MODEL = 's2.1-pro-free';

export function normalizeFishApiBaseUrl(raw?: string | null): string {
  const cleaned = (raw || DEFAULT_FISH_API_BASE)
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1$/i, '');
  return cleaned || DEFAULT_FISH_API_BASE;
}

export function normalizeAndValidateFishReferenceId(raw?: string | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed) return undefined;

  const lower = trimmed.toLowerCase();
  if (lower === 'default' || lower === 'none' || lower === 'null' || lower === 'undefined') {
    return undefined;
  }

  if (/^https?:\/\//i.test(trimmed) || trimmed.includes('/')) {
    throw new Error(
      'Invalid Fish Audio reference_id: received a URL or path instead of a Fish Audio model ID. Paste only the model ID (for example, 8ef4a238714b45718ce04243307c57a7) or leave it blank for the default voice.'
    );
  }

  if (/\s/.test(trimmed)) {
    throw new Error(
      `Invalid Fish Audio reference_id "${trimmed}": received a voice name with spaces instead of a Fish Audio model ID.`
    );
  }

  if (!/^[a-zA-Z0-9_-]{4,128}$/.test(trimmed)) {
    throw new Error(
      `Invalid Fish Audio reference_id "${trimmed}": expected an alphanumeric Fish Audio model ID (4-128 characters).`
    );
  }

  return trimmed;
}

export function normalizeFishApiKey(raw?: unknown): string {
  if (typeof raw !== 'string') return '';
  // Remove invisible control/zero-width/NBSP/newline characters from copy-paste
  let cleaned = raw
    .replace(/[\r\n\t\u200B-\u200D\uFEFF\u00A0]/g, '')
    .trim();

  // Strip accidental "Authorization:" or "FISH_API_KEY=" env/header prefixes
  cleaned = cleaned
    .replace(/^authorization\s*:\s*/i, '')
    .replace(/^fish_api_key\s*=\s*/i, '')
    .trim();

  // Strip matching surrounding quotes ('...', "...", `...`)
  for (let i = 0; i < 2; i++) {
    if (
      (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith("'") && cleaned.endsWith("'")) ||
      (cleaned.startsWith('`') && cleaned.endsWith('`'))
    ) {
      cleaned = cleaned.slice(1, -1).trim();
    }
  }

  // Strip one or more accidental "Bearer " prefixes so only a single Bearer prefix is ever sent
  while (/^bearer\s+/i.test(cleaned)) {
    cleaned = cleaned.replace(/^bearer\s+/i, '').trim();
  }

  // Strip surrounding quotes again in case user pasted Bearer "token"
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  if (!cleaned || cleaned === 'MY_FISH_API_KEY') return '';
  return cleaned;
}

export function sanitizeFishErrorText(raw: string, secretToRedact?: string): string {
  let out = (raw || '')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/(x-fish-api-key\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
  if (secretToRedact && secretToRedact.trim().length >= 4) {
    out = out.split(secretToRedact.trim()).join('[REDACTED]');
  }
  return out.trim().slice(0, 400);
}
