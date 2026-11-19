import { CaptionSegment, FishVoiceModel } from '../../src/types/studio.ts';
import {
  FishAudioSettingsSummary,
  FishConnectionStatus,
  getFishSettingsSummary,
  resolveFishApiKey,
  setFishConnectionMeta,
} from './crypto.ts';
import { parseMp3DurationSeconds } from './mp3.ts';
import { saveBinaryAsset } from './storage.ts';
import { Env, HttpError } from './types.ts';
import {
  DEFAULT_FISH_TTS_MODEL,
  normalizeAndValidateFishReferenceId,
  normalizeFishApiBaseUrl,
  sanitizeFishErrorText,
} from '../../src/lib/fishReference.ts';

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

function getFishApiBase(env: Env): string {
  return normalizeFishApiBaseUrl(env.FISH_API_BASE_URL);
}

async function fetchFish(
  env: Env,
  endpointPath: string,
  init: RequestInit,
  timeoutMs = 30000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${getFishApiBase(env)}${endpointPath}`, {
      ...init,
      signal: controller.signal,
    });
    if (!res.ok) {
      const rawText = await res.text().catch(() => '');
      const cleanRaw = sanitizeFishErrorText(rawText);
      let msg = `Fish Audio API error (${res.status})`;
      try {
        const parsed = JSON.parse(rawText) as { message?: string; detail?: string; error?: string };
        const extracted = parsed.message || parsed.detail || parsed.error;
        msg = extracted ? `${msg}: ${sanitizeFishErrorText(extracted)}` : msg;
      } catch {
        if (cleanRaw) msg = `${msg}: ${cleanRaw}`;
      }
      if (cleanRaw && !msg.includes(cleanRaw)) {
        msg = `${msg} (${cleanRaw})`;
      }
      throw new HttpError(msg, res.status >= 400 && res.status < 500 ? res.status : 502);
    }
    return res;
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new HttpError(`Fish Audio request timed out after ${Math.round(timeoutMs / 1000)}s.`, 504);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function requireFishKey(env: Env): Promise<string> {
  const { apiKey } = await resolveFishApiKey(env);
  if (!apiKey) {
    throw new HttpError(
      'Fish Audio API key is not configured. Open Settings -> Fish Audio API Settings to add and save your key.',
      503
    );
  }
  return apiKey;
}

export async function testFishAudioConnection(
  env: Env,
  candidateKey?: string
): Promise<{
  ok: boolean;
  connectionStatus: FishConnectionStatus;
  message: string;
  settings: FishAudioSettingsSummary;
}> {
  const testingUnsavedCandidate = Boolean(candidateKey && candidateKey.trim());
  const keyToUse = testingUnsavedCandidate
    ? candidateKey!.trim()
    : (await resolveFishApiKey(env)).apiKey;

  if (!keyToUse || keyToUse === 'MY_FISH_API_KEY') {
    if (!testingUnsavedCandidate) {
      await setFishConnectionMeta(env, {
        connectionStatus: 'not_connected',
        lastCheckedAt: new Date().toISOString(),
        lastError: 'No Fish Audio API key configured.',
      });
    }
    return {
      ok: false,
      connectionStatus: 'not_connected',
      message: 'No Fish Audio API key is saved yet.',
      settings: await getFishSettingsSummary(env),
    };
  }

  try {
    const res = await fetchFish(
      env,
      '/wallet/self/api-credit',
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${keyToUse}` },
      },
      12000
    );
    const data = (await res.json().catch(() => ({}))) as { credit?: number | string };
    const checkedAt = new Date().toISOString();
    if (!testingUnsavedCandidate) {
      await setFishConnectionMeta(env, {
        connectionStatus: 'connected',
        lastCheckedAt: checkedAt,
        lastError: null,
      });
    }
    const creditNote =
      data.credit !== undefined && data.credit !== null ? ` (Credit: ${data.credit})` : '';
    return {
      ok: true,
      connectionStatus: 'connected',
      message: `Connected to Fish Audio API${creditNote}.`,
      settings: await getFishSettingsSummary(env),
    };
  } catch (err) {
    const status = (err as { statusCode?: number })?.statusCode;
    const rawMsg = err instanceof Error ? err.message : 'Unable to reach Fish Audio API.';
    const message =
      status === 401 || status === 403
        ? 'Authentication failed: invalid or expired Fish Audio API key.'
        : rawMsg;
    if (!testingUnsavedCandidate) {
      await setFishConnectionMeta(env, {
        connectionStatus: 'error',
        lastCheckedAt: new Date().toISOString(),
        lastError: message,
      });
    }
    return {
      ok: false,
      connectionStatus: 'error',
      message,
      settings: await getFishSettingsSummary(env),
    };
  }
}

export async function listFishVoices(
  env: Env,
  params: { query?: string; selfOnly?: boolean; language?: string; pageSize?: number }
): Promise<{ voices: FishVoiceModel[]; total: number }> {
  const apiKey = await requireFishKey(env);
  const qs = new URLSearchParams();
  qs.set('page_size', String(params.pageSize || 24));
  qs.set('sort_by', 'task_count');
  if (params.selfOnly) qs.set('self', 'true');
  if (params.query?.trim()) qs.set('title', params.query.trim());
  if (params.language && LANGUAGE_TO_ISO[params.language]) {
    qs.set('language', LANGUAGE_TO_ISO[params.language]);
  }

  const res = await fetchFish(
    env,
    `/model?${qs.toString()}`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    15000
  );

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

export async function validateFishVoiceId(
  env: Env,
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
  if (!cleanId) throw new HttpError('Fish Audio Voice ID cannot be empty.', 400);
  if (/\s/.test(cleanId)) throw new HttpError('Fish Audio Voice ID cannot contain spaces.', 400);
  if (!/^[a-zA-Z0-9_-]{4,128}$/.test(cleanId)) {
    throw new HttpError(
      `Invalid Fish Audio Voice ID format "${cleanId}". Enter the exact alphanumeric model/reference ID from Fish Audio.`,
      400
    );
  }

  const { apiKey } = await resolveFishApiKey(env);
  if (!apiKey) {
    return {
      valid: true,
      checked: false,
      voiceId: cleanId,
      message: 'Fish Audio API key is not configured yet; Voice ID saved unverified.',
    };
  }

  try {
    const res = await fetchFish(
      env,
      `/model/${encodeURIComponent(cleanId)}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      },
      12000
    );
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
      message: data.title
        ? `Verified Fish Audio voice "${data.title}".`
        : 'Verified Fish Audio Voice ID.',
    };
  } catch (err) {
    const status = (err as { statusCode?: number })?.statusCode;
    if (status === 404 || status === 400 || status === 422) {
      throw new HttpError(
        `Invalid Fish Audio Voice ID "${cleanId}": no matching voice model was found on Fish Audio.`,
        400
      );
    }
    if (status === 401 || status === 403) {
      throw new HttpError(
        'Authentication failed while verifying Fish Audio Voice ID. Check your API key in Settings.',
        401
      );
    }
    throw err;
  }
}

export async function synthesizeFishSpeech(
  env: Env,
  params: {
    projectId: string;
    text: string;
    referenceId?: string;
    filenamePrefix?: string;
  }
): Promise<{
  bytes: Uint8Array;
  durationSec: number;
  audioUrl: string;
  storedIn: 'r2' | 'd1' | 'client-only';
}> {
  const apiKey = await requireFishKey(env);
  let refId: string | undefined;
  try {
    refId = normalizeAndValidateFishReferenceId(params.referenceId);
  } catch (err) {
    throw new HttpError(err instanceof Error ? err.message : 'Invalid reference_id.', 400);
  }

  const body: Record<string, unknown> = {
    text: params.text,
    format: 'mp3',
  };
  if (refId) body.reference_id = refId;

  let res: Response;
  try {
    res = await fetchFish(
      env,
      '/v1/tts',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          model: DEFAULT_FISH_TTS_MODEL,
        },
        body: JSON.stringify(body),
      },
      55000
    );
  } catch (err) {
    const status = (err as { statusCode?: number })?.statusCode;
    if (status === 404) {
      const detail = err instanceof Error ? err.message : String(err);
      if (refId) {
        throw new HttpError(
          `Fish Audio TTS failed (HTTP 404 · Invalid or inaccessible reference_id "${refId}" or resource): ${detail}`,
          404
        );
      }
      throw new HttpError(
        `Fish Audio TTS failed (HTTP 404 · Incorrect TTS endpoint or invalid model resource "${DEFAULT_FISH_TTS_MODEL}"): ${detail}`,
        404
      );
    }
    throw err;
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength < 128) {
    throw new HttpError('Fish Audio TTS returned an empty MP3 stream.', 502);
  }
  const durationSec = parseMp3DurationSeconds(bytes);
  const safePrefix = params.filenamePrefix || `fish_${params.projectId.slice(0, 8)}`;
  const filename = `${safePrefix}_${Date.now()}_${crypto.randomUUID().slice(0, 6)}.mp3`;

  const saved = await saveBinaryAsset(env, {
    projectId: params.projectId,
    kind: 'audio',
    bucket: 'audio',
    filename,
    mimeType: 'audio/mpeg',
    bytes,
  });

  return {
    bytes,
    durationSec,
    audioUrl: saved.url,
    storedIn: saved.storedIn,
  };
}

function distributeWordsEvenly(text: string, start: number, end: number) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const total = Math.max(0.2, end - start);
  const step = total / tokens.length;
  return tokens.map((word, idx) => ({
    word,
    start: Number((start + idx * step).toFixed(2)),
    end: Number((start + (idx + 1) * step).toFixed(2)),
  }));
}

function mapIsoToLanguageName(code?: string): string | null {
  if (!code) return null;
  const clean = code.toLowerCase().slice(0, 2);
  for (const [name, iso] of Object.entries(LANGUAGE_TO_ISO)) {
    if (iso === clean) return name;
  }
  return code;
}

export async function transcribeAudioBlobWithFish(
  env: Env,
  params: {
    audioBytes: Uint8Array;
    mimeType: string;
    filename: string;
    durationHint: number;
    sourceLanguage?: string;
  }
): Promise<{ segments: CaptionSegment[]; detectedLanguage: string }> {
  const apiKey = await requireFishKey(env);
  const isoLang =
    params.sourceLanguage && params.sourceLanguage !== 'Auto'
      ? LANGUAGE_TO_ISO[params.sourceLanguage]
      : undefined;

  const formData = new FormData();
  const safeCopy = new Uint8Array(params.audioBytes.byteLength);
  safeCopy.set(params.audioBytes);
  formData.append(
    'audio',
    new Blob([safeCopy.buffer], { type: params.mimeType || 'audio/wav' }),
    params.filename || 'audio.wav'
  );
  formData.append('ignore_timestamps', 'false');
  if (isoLang) formData.append('language', isoLang);

  const res = await fetchFish(
    env,
    '/v1/asr',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        model: 'transcribe-1-pro',
      },
      body: formData,
    },
    120000
  );

  const data = (await res.json()) as {
    text?: string;
    duration?: number;
    language?: string;
    segments?: Array<{
      text?: string;
      start?: number;
      end?: number;
      speaker?: string | number;
      speaker_id?: string | number;
    }>;
    speaker_turns?: Array<{
      text?: string;
      start?: number;
      end?: number;
      speaker?: string | number;
      speaker_id?: string | number;
    }>;
  };

  const totalDur = Math.max(0.5, Number(data.duration) || params.durationHint || 10);
  const rawSegs =
    Array.isArray(data.segments) && data.segments.length > 0
      ? data.segments
      : Array.isArray(data.speaker_turns) && data.speaker_turns.length > 0
      ? data.speaker_turns
      : [];

  let segments: CaptionSegment[] = [];
  if (rawSegs.length > 0) {
    segments = rawSegs
      .filter((s) => s.text && s.text.trim().length > 0)
      .map((s) => {
        const start = Math.max(0, Math.min(totalDur, Number(s.start) || 0));
        const end = Math.max(start + 0.25, Math.min(totalDur, Number(s.end) || start + 2));
        const text = s.text!.trim();
        const rawSpeaker = s.speaker ?? s.speaker_id;
        const speaker =
          rawSpeaker !== undefined && rawSpeaker !== null && String(rawSpeaker).trim() !== ''
            ? String(rawSpeaker).startsWith('Speaker')
              ? String(rawSpeaker)
              : `Speaker ${rawSpeaker}`
            : undefined;
        return {
          id: crypto.randomUUID(),
          start: Math.round(start * 100) / 100,
          end: Math.round(end * 100) / 100,
          text,
          speaker,
          words: distributeWordsEvenly(text, start, end),
        };
      });
  } else if (data.text && data.text.trim().length > 0) {
    const sentences = data.text
      .trim()
      .split(/(?<=[.!?؟])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const count = Math.max(1, sentences.length);
    const step = totalDur / count;
    segments = sentences.map((sentence, idx) => {
      const start = Math.round(idx * step * 100) / 100;
      const end = Math.round(Math.min(totalDur, (idx + 1) * step) * 100) / 100;
      return {
        id: crypto.randomUUID(),
        start,
        end: Math.max(start + 0.3, end),
        text: sentence,
        words: distributeWordsEvenly(sentence, start, end),
      };
    });
  }

  if (segments.length === 0) {
    throw new HttpError('Fish Audio ASR returned no spoken segments for this audio.', 422);
  }

  const detectedLanguage =
    params.sourceLanguage && params.sourceLanguage !== 'Auto'
      ? params.sourceLanguage
      : mapIsoToLanguageName(data.language) || 'Auto';

  return { segments, detectedLanguage };
}
