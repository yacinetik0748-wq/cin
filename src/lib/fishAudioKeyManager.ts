import {
  FishAudioSettingsSummary,
  FishConnectionStatus,
  FishVoiceModel,
} from '../types/studio';
import { idbGet, idbSet, idbDelete } from './browserStorage';
import {
  DEFAULT_FISH_API_BASE,
  DEFAULT_FISH_TTS_MODEL,
  normalizeFishApiKey,
  sanitizeFishErrorText,
} from './fishReference';

const FISH_API_BASE = DEFAULT_FISH_API_BASE;
const STORE_NAME = 'appSettings';
const KEY_NAME = 'fishAudioApiKey';
const META_KEY_NAME = 'fishAudioConnectionMeta';

const LANGUAGE_TO_ISO: Record<string, string> = {
  English: 'en',
  French: 'fr',
  Arabic: 'ar',
  Spanish: 'es',
  German: 'de',
  Portuguese: 'pt',
  Italian: 'it',
  Turkish: 'tr',
  Hindi: 'hi',
};

export interface LocalConnectionMeta {
  connectionStatus: FishConnectionStatus;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export function maskApiKey(rawKey: string): string {
  const trimmed = (rawKey || '').trim();
  if (!trimmed) return '';
  if (trimmed.length <= 4) return '••••••••';
  const cleanTail = trimmed.slice(-4);
  return `••••••••••••${cleanTail}`;
}

async function isIndexedDbReady(): Promise<boolean> {
  try {
    if (typeof indexedDB === 'undefined') return false;
    await idbGet(STORE_NAME, META_KEY_NAME);
    return true;
  } catch {
    return false;
  }
}

export async function getStoredFishApiKey(): Promise<string> {
  try {
    const entry = await idbGet<string | { key?: string; value?: string; apiKey?: string }>(
      STORE_NAME,
      KEY_NAME
    );
    if (!entry) return '';
    if (typeof entry === 'string') return normalizeFishApiKey(entry);
    if (typeof entry === 'object') {
      if (typeof entry.value === 'string') return normalizeFishApiKey(entry.value);
      if (typeof entry.apiKey === 'string') return normalizeFishApiKey(entry.apiKey);
    }
    return '';
  } catch {
    return '';
  }
}

export async function recordFishAuthStatus(
  connectionStatus: FishConnectionStatus,
  lastError: string | null = null
): Promise<void> {
  try {
    await idbSet(STORE_NAME, META_KEY_NAME, {
      connectionStatus,
      lastCheckedAt: new Date().toISOString(),
      lastError,
    } satisfies LocalConnectionMeta);
  } catch {
    // Ignore IDB metadata update failures
  }
}

export async function getFishAudioSettingsSummary(): Promise<FishAudioSettingsSummary> {
  const idbAvailable = await isIndexedDbReady();
  const key = idbAvailable ? await getStoredFishApiKey() : '';
  let meta: LocalConnectionMeta | null = null;
  if (idbAvailable) {
    try {
      const rawMeta = await idbGet<LocalConnectionMeta>(STORE_NAME, META_KEY_NAME);
      if (rawMeta && typeof rawMeta === 'object') {
        meta = rawMeta;
      }
    } catch {
      meta = null;
    }
  }

  const isConfigured = Boolean(key);
  let connectionStatus: FishConnectionStatus = meta?.connectionStatus || 'not_connected';
  if (!isConfigured) {
    connectionStatus = 'not_connected';
  }

  return {
    configured: isConfigured,
    source: isConfigured ? 'local_storage' : 'none',
    maskedKey: isConfigured ? maskApiKey(key) : null,
    secureStorageAvailable: idbAvailable,
    secureStorageMode: 'local_indexeddb',
    secureStorageDetail: idbAvailable
      ? 'Stored locally in your browser (IndexedDB). Local IndexedDB storage is unencrypted and is not equivalent to encrypted server-side secret storage. Your key remains on this device and is never sent to any database, analytics service, or third-party storage.'
      : 'Browser IndexedDB storage is unavailable or blocked in this browsing context.',
    connectionStatus,
    lastCheckedAt: isConfigured ? meta?.lastCheckedAt || null : null,
    lastError: isConfigured ? meta?.lastError || null : null,
  };
}

export async function saveStoredFishApiKey(rawKey: string): Promise<FishAudioSettingsSummary> {
  const normalized = normalizeFishApiKey(rawKey);
  if (!normalized) {
    throw new Error('Please enter a valid Fish Audio API key.');
  }
  if (/\s/.test(normalized)) {
    throw new Error(
      'Invalid Fish Audio API key format: contains internal spaces. Paste only the API key string.'
    );
  }

  await idbSet(STORE_NAME, KEY_NAME, normalized);
  const persisted = await getStoredFishApiKey();
  if (persisted !== normalized) {
    throw new Error('Failed to verify saved Fish Audio API key in browser IndexedDB.');
  }

  // Never claim the key is valid until Fish Audio returns a successful response
  const meta: LocalConnectionMeta = {
    connectionStatus: 'not_connected',
    lastCheckedAt: null,
    lastError: null,
  };
  await idbSet(STORE_NAME, META_KEY_NAME, meta);

  return getFishAudioSettingsSummary();
}

export async function deleteStoredFishApiKey(): Promise<FishAudioSettingsSummary> {
  await idbDelete(STORE_NAME, KEY_NAME);
  await idbDelete(STORE_NAME, META_KEY_NAME);
  return getFishAudioSettingsSummary();
}

function resolveTtsProxyTestUrl(): string {
  const base = (
    (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_BASE_URL) ||
    ''
  ).replace(/\/+$/, '');
  return base ? `${base}/api/fish/proxy/tts` : '/api/fish/proxy/tts';
}

export async function testFishAudioConnection(candidateKey?: string): Promise<{
  ok: boolean;
  connectionStatus: FishConnectionStatus;
  message: string;
  settings: FishAudioSettingsSummary;
}> {
  const testingUnsaved = candidateKey !== undefined && normalizeFishApiKey(candidateKey).length > 0;
  const keyToUse = testingUnsaved
    ? normalizeFishApiKey(candidateKey)
    : await getStoredFishApiKey();

  if (!keyToUse) {
    if (!testingUnsaved) {
      await recordFishAuthStatus('not_connected', 'No Fish Audio API key configured.');
    }
    const settings = await getFishAudioSettingsSummary();
    return {
      ok: false,
      connectionStatus: 'not_connected',
      message: 'No Fish Audio API key is saved yet. Paste your key above and click Save API Key.',
      settings,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  const authFailureMsg =
    'Fish Audio authentication failed (HTTP 401 Invalid Token): Fish Audio rejected this API key. Please generate a new API key in your Fish Audio dashboard, then click "Clear & Re-enter API Key".';

  try {
    const ttsUrl = resolveTtsProxyTestUrl();
    // Perform minimal TTS test: POST https://api.fish.audio/v1/tts (via CORS proxy),
    // header model: s2.1-pro-free, body {"text":"Hello from Recap Movies.","format":"mp3"}, no reference_id
    let res = await fetch(ttsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Fish-Api-Key': keyToUse,
        model: DEFAULT_FISH_TTS_MODEL,
      },
      body: JSON.stringify({
        text: 'Hello from Recap Movies.',
        format: 'mp3',
      }),
      signal: controller.signal,
    });

    if (res.status === 404 && ttsUrl !== '/api/fish/proxy/tts' && !res.headers.get('x-fish-proxy')) {
      res = await fetch('/api/fish/proxy/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Fish-Api-Key': keyToUse,
          model: DEFAULT_FISH_TTS_MODEL,
        },
        body: JSON.stringify({
          text: 'Hello from Recap Movies.',
          format: 'mp3',
        }),
        signal: controller.signal,
      });
    }

    // If proxy route itself returned 404 (not Fish Audio upstream), still verify token via CORS-enabled wallet endpoint
    if (res.status === 404 && !res.headers.get('x-fish-proxy')) {
      const walletRes = await fetch(`${FISH_API_BASE}/wallet/self/api-credit`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${keyToUse}`,
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (walletRes.status === 401 || walletRes.status === 403) {
        if (!testingUnsaved) await recordFishAuthStatus('error', authFailureMsg);
        const settings = await getFishAudioSettingsSummary();
        return { ok: false, connectionStatus: 'error', message: authFailureMsg, settings };
      }

      const proxyMissingMsg =
        'TTS proxy route (/api/fish/proxy/tts) returned HTTP 404 on this host, so the /v1/tts test could not reach Fish Audio.';
      if (!testingUnsaved) await recordFishAuthStatus('error', proxyMissingMsg);
      const settings = await getFishAudioSettingsSummary();
      return { ok: false, connectionStatus: 'error', message: proxyMissingMsg, settings };
    }

    if (res.ok) {
      const ct = (res.headers.get('content-type') || 'audio/mpeg').toLowerCase();
      const buf = await res.arrayBuffer();
      clearTimeout(timer);

      if (ct.includes('text/html') || ct.includes('application/json') || buf.byteLength < 128) {
        const msg = 'Fish Audio TTS test returned an unexpected non-audio response.';
        if (!testingUnsaved) await recordFishAuthStatus('error', msg);
        const settings = await getFishAudioSettingsSummary();
        return { ok: false, connectionStatus: 'error', message: msg, settings };
      }

      if (!testingUnsaved) await recordFishAuthStatus('connected', null);
      const settings = await getFishAudioSettingsSummary();
      return {
        ok: true,
        connectionStatus: 'connected',
        message: 'Connected & verified with Fish Audio TTS (POST /v1/tts · s2.1-pro-free).',
        settings,
      };
    }

    clearTimeout(timer);

    if (res.status === 401 || res.status === 403) {
      if (!testingUnsaved) await recordFishAuthStatus('error', authFailureMsg);
      const settings = await getFishAudioSettingsSummary();
      return { ok: false, connectionStatus: 'error', message: authFailureMsg, settings };
    }

    const rawText = await res.text().catch(() => '');
    const safeDetail = sanitizeFishErrorText(rawText, keyToUse);
    const message = `Fish Audio TTS test failed (HTTP ${res.status}): ${safeDetail || 'Unknown error'}`;
    if (!testingUnsaved) await recordFishAuthStatus('error', message);
    const settings = await getFishAudioSettingsSummary();
    return { ok: false, connectionStatus: 'error', message, settings };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = (err as Error)?.name === 'AbortError';
    const message = isTimeout
      ? 'Connection timed out while verifying Fish Audio TTS (https://api.fish.audio/v1/tts).'
      : err instanceof Error
      ? sanitizeFishErrorText(err.message, keyToUse)
      : 'Network error connecting to Fish Audio API.';

    if (!testingUnsaved) await recordFishAuthStatus('error', message);
    const settings = await getFishAudioSettingsSummary();
    return { ok: false, connectionStatus: 'error', message, settings };
  }
}

export async function fetchFishVoicesFromBrowser(
  apiKey: string,
  params?: { query?: string; selfOnly?: boolean; language?: string; pageSize?: number }
): Promise<{ voices: FishVoiceModel[]; total: number }> {
  const qs = new URLSearchParams();
  qs.set('page_size', String(params?.pageSize || 24));
  qs.set('sort_by', 'task_count');
  if (params?.selfOnly) qs.set('self', 'true');
  if (params?.query?.trim()) qs.set('title', params.query.trim());
  if (params?.language && LANGUAGE_TO_ISO[params.language]) {
    qs.set('language', LANGUAGE_TO_ISO[params.language]);
  }

  const cleanKey = normalizeFishApiKey(apiKey);
  const res = await fetch(`${FISH_API_BASE}/model?${qs.toString()}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${cleanKey}`,
    },
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let msg = `Fish Audio API error (${res.status})`;
    try {
      const parsed = JSON.parse(raw) as { message?: string; detail?: string; error?: string };
      msg = parsed.message || parsed.detail || parsed.error || msg;
    } catch {
      if (raw.trim()) msg = `${msg}: ${raw.trim().slice(0, 180)}`;
    }
    throw new Error(msg);
  }

  const payload = (await res.json()) as {
    total?: number;
    items?: Array<{
      _id?: string;
      id?: string;
      title?: string;
      description?: string;
      languages?: string[];
      tags?: string[];
      visibility?: string;
      cover_image?: string;
      author?: { nickname?: string; name?: string };
    }>;
  };

  const voices: FishVoiceModel[] = (payload.items || [])
    .map((item) => ({
      id: item._id || item.id || '',
      title: item.title || 'Untitled Voice',
      description: item.description || '',
      languages: Array.isArray(item.languages) ? item.languages : [],
      author: item.author?.nickname || item.author?.name || 'Fish Audio',
      tags: Array.isArray(item.tags) ? item.tags : [],
      visibility: item.visibility,
      coverImage: item.cover_image,
    }))
    .filter((v) => Boolean(v.id));

  return {
    voices,
    total: Number(payload.total || voices.length),
  };
}

export async function validateFishVoiceInBrowser(
  apiKey: string | null | undefined,
  voiceId: string
): Promise<{
  valid: boolean;
  checked: boolean;
  voiceId: string;
  title?: string;
  description?: string;
  languages?: string[];
  message: string;
}> {
  const cleanId = voiceId.trim();
  if (!cleanId) throw new Error('Fish Audio Voice ID cannot be empty.');
  if (/\s/.test(cleanId)) throw new Error('Fish Audio Voice ID cannot contain spaces.');
  if (!/^[a-zA-Z0-9_-]{4,128}$/.test(cleanId)) {
    throw new Error(
      `Invalid Fish Audio Voice ID format "${cleanId}". Enter the exact alphanumeric model/reference ID from Fish Audio.`
    );
  }

  const key = normalizeFishApiKey(apiKey);
  if (!key) {
    return {
      valid: true,
      checked: false,
      voiceId: cleanId,
      message: 'Fish Audio API key is not configured yet; Voice ID saved unverified.',
    };
  }

  const res = await fetch(`${FISH_API_BASE}/model/${encodeURIComponent(cleanId)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${key}`,
    },
  });

  if (res.status === 404 || res.status === 400 || res.status === 422) {
    throw new Error(
      `Invalid Fish Audio Voice ID "${cleanId}": no matching voice model was found on Fish Audio.`
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      'Authentication failed while verifying Fish Audio Voice ID. Check your API key in Settings.'
    );
  }
  if (!res.ok) {
    throw new Error(`Fish Audio voice validation failed (HTTP ${res.status}).`);
  }

  const data = (await res.json().catch(() => ({}))) as {
    _id?: string;
    id?: string;
    title?: string;
    description?: string;
    languages?: string[];
  };

  return {
    valid: true,
    checked: true,
    voiceId: data._id || data.id || cleanId,
    title: data.title,
    description: data.description,
    languages: Array.isArray(data.languages) ? data.languages : undefined,
    message: data.title ? `Verified Fish Audio voice "${data.title}".` : 'Verified Fish Audio Voice ID.',
  };
}
