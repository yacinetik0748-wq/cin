import { BUILTIN_FONT_CATALOG } from '../../src/lib/fontCatalogData.ts';
import {
  applySavedStyleToProjectData,
  buildSavedStylePayloadFromProject,
} from '../../src/lib/savedStyles.ts';
import {
  buildAssContent,
  generateSrtContent,
  generateVttContent,
  parseSrtOrVtt,
} from '../../src/lib/subtitleAss.ts';
import {
  applySyncPlanToClips,
  auditProjectNarration,
  buildTimelineSyncPlan,
  clampContinuousPauseMs,
  normalizeSyncMode,
} from '../../server/services/timeline_sync_service.ts';
import {
  DEFAULT_FISH_TTS_MODEL,
  normalizeAndValidateFishReferenceId,
  normalizeFishApiBaseUrl,
  normalizeFishApiKey,
  sanitizeFishErrorText,
} from '../../src/lib/fishReference.ts';
import type {
  CaptionSegment,
  GeneratedVoiceClip,
  PresetCategory,
  Project,
  StyleApplyScope,
  StyleMissingVoiceWarning,
  StudioPreset,
  StudioPresetAssetRef,
  SupportedLanguage,
  SyncMode,
} from '../../src/types/studio.ts';
import {
  deleteSavedFishApiKey,
  getFishSettingsSummary,
  resolveFishApiKey,
  saveFishApiKey,
} from '../_lib/crypto.ts';
import {
  applyPresetIdsToProject,
  checkAssetAvailableByUrl,
  createJob,
  createPreset,
  createProject,
  deleteCustomFont,
  deletePreset,
  deleteProject,
  ensureSchema,
  getDefaultStudioPreferences,
  getJob,
  getPreset,
  getProject,
  getSavedFishVoices,
  listAllJobs,
  listCustomFonts,
  listPresets,
  listProjectJobs,
  listProjects,
  registerCustomFont,
  requireDb,
  sanitizeSavedStylePayload,
  saveDefaultStudioPreferences,
  saveSavedFishVoices,
  saveStyleThumbnailDataUrl,
  updateJob,
  updatePreset,
  updateProject,
  upsertProjectFromCloud,
} from '../_lib/d1.ts';
import {
  listFishVoices,
  synthesizeFishSpeech,
  testFishAudioConnection,
  transcribeAudioBlobWithFish,
  validateFishVoiceId,
} from '../_lib/fish.ts';
import { ensureFontAvailableEdge } from '../_lib/fonts.ts';
import {
  corsHeaders,
  errorJson,
  getMimeType,
  jsonResponse,
  optionsResponse,
  readJsonBody,
  sanitizeFilename,
} from '../_lib/http.ts';
import {
  computeCloudStorageUsage,
  readBinaryAssetBytes,
  saveBinaryAsset,
} from '../_lib/storage.ts';
import { Env, HttpError, getErrorCode, getErrorStatus } from '../_lib/types.ts';

const ALLOWED_VIDEO_EXTS_EDGE = new Set(['.mp4', '.mov', '.mkv']);

function normalizeProjectIdEdge(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') return null;
  return trimmed;
}

function getMaxUploadBytesEdge(env: Env): number {
  const mb = Number(env.MAX_UPLOAD_SIZE_MB || '1500');
  return Math.max(50, Number.isFinite(mb) ? mb : 1500) * 1024 * 1024;
}

function validateVideoUploadEdge(env: Env, filename: string, sizeBytes: number): string {
  const cleanName = sanitizeFilename(filename, 'video.mp4');
  const dot = cleanName.lastIndexOf('.');
  const ext = dot >= 0 ? cleanName.slice(dot).toLowerCase() : '';
  if (!ALLOWED_VIDEO_EXTS_EDGE.has(ext)) {
    throw new HttpError(
      `Unsupported video format "${ext || 'unknown'}". Allowed formats: MP4, MOV, MKV.`,
      400,
      'UNSUPPORTED_VIDEO_FORMAT'
    );
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new HttpError('Video file cannot be empty.', 400, 'EMPTY_FILE');
  }
  const maxBytes = getMaxUploadBytesEdge(env);
  if (sizeBytes > maxBytes) {
    throw new HttpError(
      `File exceeds maximum allowed size (${Math.round(maxBytes / (1024 * 1024))} MB).`,
      413,
      'FILE_TOO_LARGE'
    );
  }
  return cleanName;
}

function isGeminiConfiguredEdge(env: Env): boolean {
  const key = env.GEMINI_API_KEY?.trim() || '';
  return Boolean(key && key !== 'MY_GEMINI_API_KEY');
}

async function translateWithGeminiRest(
  env: Env,
  params: {
    captions: CaptionSegment[];
    sourceLanguage: string;
    targetLanguage: SupportedLanguage;
    preserveProperNouns: boolean;
  }
): Promise<CaptionSegment[]> {
  const apiKey = env.GEMINI_API_KEY?.trim() || '';
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new HttpError(
      'GEMINI_API_KEY is not set in Cloudflare environment variables. You can use the built-in External Gemini workflow (Copy Prompt -> Paste JSON) without an API key.',
      400
    );
  }
  if (!params.captions || params.captions.length === 0) {
    throw new HttpError('No caption segments available to translate.', 400);
  }

  const payload = params.captions.map((c) => ({
    id: c.id,
    start: c.start,
    end: c.end,
    text: c.text,
  }));

  const prompt = `Translate the following movie recap subtitle segments from ${params.sourceLanguage} into ${params.targetLanguage}.
Rules:
1. Preserve the complete meaning, story facts, chronology, and dramatic tone. Improve wording naturally in ${params.targetLanguage}, without omitting essential details.
2. ${
    params.preserveProperNouns
      ? 'Do NOT translate character names, actor names, movie titles, key locations, or iconic terminology; transliterate only if the target script requires it while keeping the name recognizable.'
      : 'Preserve key character names and major locations accurately while translating naturally.'
  }
3. Keep each segment aligned to its exact id and timing; return one translated entry per input segment.
Input segments JSON:
${JSON.stringify(payload)}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
      apiKey
    )}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              translations: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    id: { type: 'STRING' },
                    translatedText: { type: 'STRING' },
                  },
                  required: ['id', 'translatedText'],
                },
              },
            },
            required: ['translations'],
          },
        },
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new HttpError(
      `Gemini API error (${res.status}): ${errText.slice(0, 220) || res.statusText}`,
      res.status >= 400 && res.status < 500 ? res.status : 502
    );
  }

  const body = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const rawText = body.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  const parsed = JSON.parse(rawText) as {
    translations?: Array<{ id: string; translatedText: string }>;
  };

  const map = new Map<string, string>();
  for (const item of parsed.translations || []) {
    map.set(item.id, (item.translatedText || '').trim());
  }

  return params.captions.map((seg) => {
    const translatedText = map.get(seg.id) || seg.translatedText || seg.text;
    const tokens = translatedText.trim().split(/\s+/).filter(Boolean);
    const total = Math.max(0.2, seg.end - seg.start);
    const step = tokens.length > 0 ? total / tokens.length : total;
    const words = tokens.map((word, idx) => ({
      word,
      start: Number((seg.start + idx * step).toFixed(2)),
      end: Number((seg.start + (idx + 1) * step).toFixed(2)),
    }));
    return { ...seg, translatedText, words };
  });
}

async function proxyToExternalBackend(
  env: Env,
  request: Request,
  url: URL
): Promise<Response | null> {
  const backendBase = (env.BACKEND_URL || env.VITE_API_BASE_URL || env.API_URL || '').replace(
    /\/+$/,
    ''
  );
  if (!backendBase) return null;

  const targetUrl = `${backendBase}${url.pathname}${url.search}`;
  const forwardHeaders = new Headers(request.headers);
  forwardHeaders.delete('host');
  forwardHeaders.set('x-forwarded-host', url.host);
  forwardHeaders.set('x-forwarded-proto', url.protocol.replace(':', ''));

  const hasBody = !['GET', 'HEAD'].includes(request.method) && request.body !== null;
  let upstream: Response;
  try {
    const fetchInit: RequestInit & { duplex?: 'half' } = {
      method: request.method,
      headers: forwardHeaders,
      redirect: 'follow',
      ...(hasBody ? { body: request.body, duplex: 'half' as const } : {}),
    };
    upstream = await fetch(targetUrl, fetchInit);
  } catch (err) {
    throw new HttpError(
      `Failed to reach configured backend server (${err instanceof Error ? err.message : 'network error'}).`,
      502,
      'BACKEND_UNREACHABLE'
    );
  }

  const headers = new Headers(upstream.headers);
  const cors = new Headers(corsHeaders(request));
  cors.forEach((v, k) => headers.set(k, v));

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const pSegs = pattern.split('/').filter(Boolean);
  const uSegs = pathname.split('/').filter(Boolean);
  if (pSegs.length !== uSegs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pSegs.length; i++) {
    if (pSegs[i].startsWith(':')) {
      params[pSegs[i].slice(1)] = decodeURIComponent(uSegs[i]);
    } else if (pSegs[i] !== uSegs[i]) {
      return null;
    }
  }
  return params;
}

export const onRequest = async (context: {
  request: Request;
  env: Env;
  params: { catchall?: string[] | string };
}): Promise<Response> => {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return optionsResponse(request);
  }

  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, '') || '/api';
  const method = request.method.toUpperCase();

  try {
    // Forward all API traffic consistently when an external Node/Express backend is configured
    const proxied = await proxyToExternalBackend(env, request, url);
    if (proxied) return proxied;

    // 1. System Diagnostics & Storage Usage
    if (method === 'GET' && pathname === '/api/system/status') {
      const fishResolved = await resolveFishApiKey(env);
      const hasD1 = Boolean(env.DB);
      const storageDir = !hasD1
        ? 'Browser IndexedDB (Local Only)'
        : env.MEDIA_BUCKET
        ? 'Cloudflare D1 + R2'
        : 'Cloudflare D1 + IndexedDB';
      return jsonResponse(
        {
          geminiConfigured: isGeminiConfiguredEdge(env),
          fishConfigured: Boolean(fishResolved.apiKey),
          ffmpegAvailable: false,
          ffprobeAvailable: false,
          ffmpegVersion: 'ffmpeg.wasm (browser)',
          storageDir,
          storageMode: !hasD1 ? 'local-indexeddb' : 'cloudflare-d1',
          localOnly: !hasD1,
          maxUploadSizeMb: Math.round(getMaxUploadBytesEdge(env) / (1024 * 1024)),
          tempRetentionHours: Number(env.TEMP_RETENTION_HOURS || '24'),
          supportedVideoFormats: ['MP4', 'MOV', 'MKV'],
          supportedLogoFormats: ['PNG', 'SVG', 'JPG', 'WEBP'],
          runtime: 'cloudflare-pages',
          databaseConfigured: hasD1,
          d1Available: hasD1,
          r2Available: Boolean(env.MEDIA_BUCKET),
          clientProcessingAvailable: true,
        },
        200,
        request
      );
    }

    if (method === 'GET' && pathname === '/api/system/storage-usage') {
      const usage = await computeCloudStorageUsage(env);
      return jsonResponse(usage, 200, request);
    }

    if (method === 'POST' && pathname === '/api/system/cleanup') {
      let cleanedFiles = 0;
      const freedBytes = 0;
      if (env.DB) {
        await ensureSchema(env.DB);
        const hours = Math.max(1, Number(env.TEMP_RETENTION_HOURS || '24'));
        const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
        const delSessions = await env.DB
          .prepare('DELETE FROM upload_sessions WHERE created_at < ?')
          .bind(cutoff)
          .run();
        cleanedFiles += delSessions.meta?.changes || 0;
      }
      return jsonResponse({ cleanedFiles, freedBytes }, 200, request);
    }

    // 2. Fish Audio API Key Settings & Voice Library
    if (method === 'GET' && pathname === '/api/settings/fish-audio') {
      return jsonResponse(await getFishSettingsSummary(env), 200, request);
    }

    if (method === 'POST' && pathname === '/api/settings/fish-api-key') {
      const body = await readJsonBody<{ apiKey?: string }>(request);
      const summary = await saveFishApiKey(env, typeof body.apiKey === 'string' ? body.apiKey : '');
      return jsonResponse(summary, 200, request);
    }

    if (method === 'POST' && pathname === '/api/settings/fish-api-key/test') {
      const body = await readJsonBody<{ apiKey?: string }>(request).catch(() => ({}));
      const candidateKey =
        typeof (body as { apiKey?: unknown }).apiKey === 'string'
          ? String((body as { apiKey?: string }).apiKey)
          : undefined;
      return jsonResponse(await testFishAudioConnection(env, candidateKey), 200, request);
    }

    if (method === 'DELETE' && pathname === '/api/settings/fish-api-key') {
      return jsonResponse(await deleteSavedFishApiKey(env), 200, request);
    }

    if (method === 'GET' && pathname === '/api/fish/voices') {
      const query = url.searchParams.get('q') || undefined;
      const selfOnly = url.searchParams.get('self') === 'true';
      const language = url.searchParams.get('language') || undefined;
      return jsonResponse(await listFishVoices(env, { query, selfOnly, language }), 200, request);
    }

    if (method === 'POST' && pathname === '/api/fish/proxy/tts') {
      const hasHeaderKey = request.headers.has('X-Fish-Api-Key');
      const headerKey = normalizeFishApiKey(request.headers.get('X-Fish-Api-Key'));
      const apiKey = hasHeaderKey
        ? headerKey
        : normalizeFishApiKey((await resolveFishApiKey(env)).apiKey);
      if (!apiKey) {
        return errorJson('Fish Audio API key is required.', 401, request);
      }
      const reqBody = await readJsonBody<Record<string, unknown>>(request).catch(() => null);
      if (!reqBody || typeof reqBody !== 'object') {
        return errorJson('Invalid JSON request body for Fish Audio TTS.', 400, request);
      }
      const text = typeof reqBody.text === 'string' ? reqBody.text.trim() : '';
      if (!text) {
        return errorJson('TTS text is required.', 400, request);
      }

      let validRefId: string | undefined;
      try {
        validRefId = normalizeAndValidateFishReferenceId(
          typeof reqBody.reference_id === 'string' ? reqBody.reference_id : undefined
        );
      } catch (refErr) {
        return errorJson(
          refErr instanceof Error ? refErr.message : 'Invalid reference_id.',
          400,
          request
        );
      }

      const upstreamPayload: Record<string, unknown> = {
        ...reqBody,
        text,
        format: typeof reqBody.format === 'string' && reqBody.format ? reqBody.format : 'mp3',
      };
      if (validRefId) {
        upstreamPayload.reference_id = validRefId;
      } else {
        delete upstreamPayload.reference_id;
      }

      const fishBase = normalizeFishApiBaseUrl(env.FISH_API_BASE_URL);
      const ttsEndpoint = `${fishBase}/v1/tts`;
      const modelHeader = request.headers.get('model')?.trim() || DEFAULT_FISH_TTS_MODEL;
      console.info(
        `[Fish TTS Proxy:CF] POST ${ttsEndpoint} (model=${modelHeader}, hasReferenceId=${Boolean(validRefId)})`
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
      const responseUrl = upstream.url || ttsEndpoint;
      const proxyHeaders = {
        'X-Fish-Proxy': 'cloudflare-pages',
        'X-Fish-Upstream-Url': ttsEndpoint,
        'X-Fish-Response-Url': responseUrl,
      };
      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => '');
        const cleanBody = sanitizeFishErrorText(errText, apiKey);
        console.warn(
          `[Fish TTS Proxy:CF] Upstream HTTP ${upstream.status} from ${responseUrl}: ${cleanBody}`
        );
        return jsonResponse(
          {
            error: cleanBody || `Fish Audio TTS error (${upstream.status})`,
            rawBody: cleanBody,
            status: upstream.status,
            errorCode: upstream.headers.get('x-fish-error-code') || undefined,
            errorSource: upstream.headers.get('x-fish-error-source') || undefined,
            endpoint: ttsEndpoint,
            responseUrl,
          },
          upstream.status,
          request,
          proxyHeaders
        );
      }
      const audioBytes = await upstream.arrayBuffer();
      return new Response(audioBytes, {
        status: 200,
        headers: {
          ...corsHeaders(request),
          ...proxyHeaders,
          'Content-Type': upstream.headers.get('Content-Type') || 'audio/mpeg',
        },
      });
    }

    if (method === 'POST' && pathname === '/api/fish/proxy/asr') {
      const hasHeaderKey = request.headers.has('X-Fish-Api-Key');
      const headerKey = normalizeFishApiKey(request.headers.get('X-Fish-Api-Key'));
      const apiKey = hasHeaderKey
        ? headerKey
        : normalizeFishApiKey((await resolveFishApiKey(env)).apiKey);
      if (!apiKey) {
        return errorJson('Fish Audio API key is required.', 401, request);
      }
      const formData = await request.formData();
      const fishBase = normalizeFishApiBaseUrl(env.FISH_API_BASE_URL);
      const upstream = await fetch(`${fishBase}/v1/asr`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          model: 'transcribe-1-pro',
        },
        body: formData,
      });
      const rawText = await upstream.text();
      if (!upstream.ok) {
        return errorJson(
          rawText.slice(0, 220) || `Fish Audio ASR error (${upstream.status})`,
          upstream.status,
          request
        );
      }
      return new Response(rawText, {
        status: 200,
        headers: {
          ...corsHeaders(request),
          'Content-Type': 'application/json; charset=utf-8',
        },
      });
    }

    if (method === 'POST' && pathname === '/api/fish/saved-voices/validate') {
      const body = await readJsonBody<{ voiceId?: string }>(request);
      return jsonResponse(await validateFishVoiceId(env, String(body.voiceId || '')), 200, request);
    }

    if (method === 'POST' && pathname === '/api/fish/saved-voices/preview') {
      const body = await readJsonBody<{ voiceId?: string; text?: string }>(request);
      const text =
        String(body.text || '').trim() ||
        'Everything changed the moment the vault door swung open in silence.';
      const synth = await synthesizeFishSpeech(env, {
        projectId: 'global-voice-preview',
        text,
        referenceId: typeof body.voiceId === 'string' ? body.voiceId.trim() : undefined,
        filenamePrefix: 'fish_preview_global',
      });
      if (synth.storedIn === 'client-only') {
        const b64 = btoa(String.fromCharCode(...synth.bytes));
        return jsonResponse({ audioUrl: `data:audio/mpeg;base64,${b64}` }, 200, request);
      }
      return jsonResponse({ audioUrl: synth.audioUrl }, 200, request);
    }

    if (method === 'GET' && pathname === '/api/fonts/ensure') {
      const family = url.searchParams.get('family') || '';
      const weight = Number(url.searchParams.get('weight') || 700);
      const italic = url.searchParams.get('italic') === '1' || url.searchParams.get('italic') === 'true';
      return jsonResponse(
        await ensureFontAvailableEdge(env, { family, weight, italic }),
        200,
        request
      );
    }

    // Direct binary asset read helper check (works with R2 or D1 without failing when D1 is absent)
    if (method === 'GET' && pathname === '/api/assets/read') {
      const targetUrl = url.searchParams.get('url') || '';
      const asset = targetUrl ? await readBinaryAssetBytes(env, targetUrl) : null;
      if (!asset) return errorJson('Asset not found', 404, request);
      return new Response(asset.bytes, {
        status: 200,
        headers: {
          ...corsHeaders(request),
          'Content-Type': asset.mimeType,
        },
      });
    }

    // Stateless translation helper if client sends captions directly and GEMINI_API_KEY is configured
    const translateMatchEdge = matchPath('/api/projects/:id/translate', pathname);
    if (!env.DB && method === 'POST' && translateMatchEdge) {
      const body = await readJsonBody<{
        captions?: CaptionSegment[];
        sourceLanguage?: string;
        targetLanguage?: SupportedLanguage;
        preserveProperNouns?: boolean;
      }>(request);
      if (Array.isArray(body.captions) && body.captions.length > 0 && body.targetLanguage) {
        const translatedSegments = await translateWithGeminiRest(env, {
          captions: body.captions,
          sourceLanguage: body.sourceLanguage || 'Auto',
          targetLanguage: body.targetLanguage,
          preserveProperNouns: Boolean(body.preserveProperNouns),
        });
        return jsonResponse({ localOnly: true, captions: translatedSegments }, 200, request);
      }
      return jsonResponse(
        { localOnly: true, storageMode: 'local-indexeddb', databaseConfigured: false },
        200,
        request
      );
    }

    // Local-only IndexedDB mode: when Cloudflare D1 (DB) is not bound, do not block the application.
    // All persistent project/editor CRUD executes in the browser's IndexedDB local-first storage.
    if (!env.DB) {
      return jsonResponse(
        {
          localOnly: true,
          storageMode: 'local-indexeddb',
          databaseConfigured: false,
          ...(pathname === '/api/projects' && method === 'GET' ? { projects: [] } : {}),
          ...(pathname === '/api/presets' && method === 'GET' ? { presets: [] } : {}),
          ...(pathname === '/api/styles' && method === 'GET' ? { styles: [], defaultStyleId: null } : {}),
          ...(pathname === '/api/fish/saved-voices' && method === 'GET' ? { voices: [] } : {}),
          ...(pathname === '/api/fonts' && method === 'GET' ? { fonts: [] } : {}),
          ...(pathname === '/api/fonts/catalog' && method === 'GET'
            ? { builtin: BUILTIN_FONT_CATALOG, custom: [] }
            : {}),
          ...(pathname === '/api/jobs' && method === 'GET' ? { jobs: [] } : {}),
        },
        200,
        request
      );
    }

    // Saved Voices CRUD
    if (method === 'GET' && pathname === '/api/fish/saved-voices') {
      const db = requireDb(env);
      return jsonResponse({ voices: await getSavedFishVoices(db) }, 200, request);
    }

    if (method === 'POST' && pathname === '/api/fish/saved-voices') {
      const db = requireDb(env);
      const body = await readJsonBody<Record<string, unknown>>(request);
      const name = String(body.name || '').trim();
      const voiceId = String(body.voiceId || '').trim();
      if (!name) return errorJson('Narrator name is required.', 400, request);
      if (!voiceId) return errorJson('Fish Audio Voice ID is required.', 400, request);

      let validated = Boolean(body.validated);
      let validationMessage = validated
        ? 'Verified Fish Audio Voice ID.'
        : 'Saved without remote verification.';
      if (!body.skipRemoteValidation) {
        const check = await validateFishVoiceId(env, voiceId);
        validated = check.checked && check.valid;
        validationMessage = check.message;
      }

      const now = new Date().toISOString();
      const existing = await getSavedFishVoices(db);
      const setDefault = Boolean(body.isDefault);
      const newVoice = {
        id: crypto.randomUUID(),
        name,
        voiceId,
        ...(typeof body.description === 'string' && body.description.trim()
          ? { description: body.description.trim() }
          : {}),
        ...(typeof body.language === 'string' && body.language.trim()
          ? { language: body.language.trim() }
          : {}),
        ...(typeof body.sampleUrl === 'string' && body.sampleUrl.trim()
          ? { sampleUrl: body.sampleUrl.trim() }
          : {}),
        ...(typeof body.previewText === 'string' && body.previewText.trim()
          ? { previewText: body.previewText.trim() }
          : {}),
        validated,
        isDefault: setDefault || existing.length === 0,
        createdAt: now,
        updatedAt: now,
      };
      const next = existing
        .map((v) => (newVoice.isDefault ? { ...v, isDefault: false } : v))
        .concat(newVoice);
      await saveSavedFishVoices(db, next);
      return jsonResponse({ voice: newVoice, voices: next, validationMessage }, 201, request);
    }

    let params = matchPath('/api/fish/saved-voices/:id/duplicate', pathname);
    if (method === 'POST' && params) {
      const db = requireDb(env);
      const existing = await getSavedFishVoices(db);
      const found = existing.find((v) => v.id === params!.id);
      if (!found) return errorJson('Saved voice not found.', 404, request);
      const now = new Date().toISOString();
      const copy = {
        ...found,
        id: crypto.randomUUID(),
        name: `${found.name} (Copy)`,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      };
      const next = [...existing, copy];
      await saveSavedFishVoices(db, next);
      return jsonResponse({ voice: copy, voices: next }, 201, request);
    }

    params = matchPath('/api/fish/saved-voices/:id', pathname);
    if (method === 'PATCH' && params) {
      const db = requireDb(env);
      const body = await readJsonBody<Record<string, unknown>>(request);
      const existing = await getSavedFishVoices(db);
      const found = existing.find((v) => v.id === params!.id);
      if (!found) return errorJson('Saved voice not found.', 404, request);

      const name = body.name !== undefined ? String(body.name).trim() : found.name;
      const voiceId = body.voiceId !== undefined ? String(body.voiceId).trim() : found.voiceId;
      const isDefault =
        body.isDefault !== undefined ? Boolean(body.isDefault) : found.isDefault;
      if (!name || !voiceId) {
        return errorJson('Both narrator name and Fish Audio Voice ID are required.', 400, request);
      }
      let validated =
        body.validated !== undefined ? Boolean(body.validated) : found.validated;
      if (voiceId !== found.voiceId && !body.skipRemoteValidation) {
        const check = await validateFishVoiceId(env, voiceId);
        validated = check.checked && check.valid;
      }
      const now = new Date().toISOString();
      const next = existing.map((v) => {
        if (v.id === params!.id) {
          return {
            ...v,
            name,
            voiceId,
            description:
              body.description !== undefined
                ? String(body.description || '').trim() || undefined
                : v.description,
            language:
              body.language !== undefined
                ? String(body.language || '').trim() || undefined
                : v.language,
            sampleUrl:
              body.sampleUrl !== undefined
                ? String(body.sampleUrl || '').trim() || undefined
                : v.sampleUrl,
            previewText:
              body.previewText !== undefined
                ? String(body.previewText || '').trim() || undefined
                : v.previewText,
            validated,
            isDefault,
            updatedAt: now,
          };
        }
        return isDefault ? { ...v, isDefault: false } : v;
      });
      await saveSavedFishVoices(db, next);
      return jsonResponse({ voice: next.find((v) => v.id === params!.id)!, voices: next }, 200, request);
    }

    if (method === 'DELETE' && params) {
      const db = requireDb(env);
      const existing = await getSavedFishVoices(db);
      const next = existing.filter((v) => v.id !== params!.id);
      if (next.length === existing.length) return errorJson('Saved voice not found.', 404, request);
      if (next.length > 0 && !next.some((v) => v.isDefault)) {
        next[0] = { ...next[0], isDefault: true };
      }
      await saveSavedFishVoices(db, next);
      return jsonResponse({ deleted: true, voices: next }, 200, request);
    }

    // 3. Studio Preferences
    if (method === 'GET' && pathname === '/api/settings/preferences') {
      const db = requireDb(env);
      const preferences = await getDefaultStudioPreferences(db);
      const defaultStyle = preferences.defaultStyleId
        ? await getPreset(env, preferences.defaultStyleId)
        : null;
      return jsonResponse({ preferences, defaultStyle }, 200, request);
    }

    if (method === 'PATCH' && pathname === '/api/settings/preferences') {
      const db = requireDb(env);
      const body = await readJsonBody<Record<string, unknown>>(request);
      const nextPrefs = await saveDefaultStudioPreferences(db, body);
      if (body.defaultStyleId !== undefined) {
        const allStyles = await listPresets(env, 'style');
        for (const st of allStyles) {
          const shouldBeDefault = Boolean(nextPrefs.defaultStyleId && st.id === nextPrefs.defaultStyleId);
          if (Boolean(st.isDefault) !== shouldBeDefault) {
            await updatePreset(env, st.id, { isDefault: shouldBeDefault });
          }
        }
      }
      const defaultStyle = nextPrefs.defaultStyleId
        ? await getPreset(env, nextPrefs.defaultStyleId)
        : null;
      return jsonResponse({ preferences: nextPrefs, defaultStyle }, 200, request);
    }

    // 4. Custom Fonts & Catalog
    if (method === 'GET' && pathname === '/api/fonts') {
      const db = requireDb(env);
      return jsonResponse({ fonts: await listCustomFonts(db) }, 200, request);
    }

    if (method === 'GET' && pathname === '/api/fonts/catalog') {
      const db = requireDb(env);
      return jsonResponse(
        { builtin: BUILTIN_FONT_CATALOG, custom: await listCustomFonts(db) },
        200,
        request
      );
    }

    if (method === 'GET' && pathname === '/api/fonts/ensure') {
      const family = url.searchParams.get('family') || '';
      const weight = Number(url.searchParams.get('weight') || 700);
      const italic = url.searchParams.get('italic') === '1' || url.searchParams.get('italic') === 'true';
      return jsonResponse(
        await ensureFontAvailableEdge(env, { family, weight, italic }),
        200,
        request
      );
    }

    if (method === 'POST' && pathname === '/api/fonts') {
      const db = requireDb(env);
      const form = await request.formData();
      const file = form.get('file');
      if (!file || !(file instanceof File)) {
        return errorJson('No font file uploaded.', 400, request);
      }
      const origName = file.name || 'custom_font.ttf';
      const customFamily = String(form.get('family') || '').trim();
      const family =
        customFamily || origName.replace(/\.(ttf|otf|woff2?)$/i, '').replace(/[_-]+/g, ' ').trim() || 'Custom Font';
      const safeName = `${Date.now()}_${sanitizeFilename(origName, 'font.ttf')}`;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const saved = await saveBinaryAsset(env, {
        projectId: null,
        kind: 'font',
        bucket: 'fonts',
        filename: safeName,
        mimeType: getMimeType(safeName),
        bytes,
      });
      const font = await registerCustomFont(db, {
        id: crypto.randomUUID(),
        family,
        filename: safeName,
        filePath: saved.key,
        url: saved.url,
      });
      return jsonResponse(
        {
          font,
          fonts: await listCustomFonts(db),
          exportCompatible: !/\.woff2?$/i.test(safeName),
          storedIn: saved.storedIn,
        },
        201,
        request
      );
    }

    params = matchPath('/api/fonts/:id', pathname);
    if (method === 'DELETE' && params) {
      const deleted = await deleteCustomFont(env, params.id);
      if (!deleted) return errorJson('Custom font not found.', 404, request);
      const db = requireDb(env);
      return jsonResponse({ deleted: true, fonts: await listCustomFonts(db) }, 200, request);
    }

    // 5. Presets & Saved Styles
    if (method === 'GET' && pathname === '/api/presets/export') {
      const presets = await listPresets(env);
      const headers = new Headers(corsHeaders(request));
      headers.set('Content-Type', 'application/json');
      headers.set('Content-Disposition', 'attachment; filename="recap_studio_presets.json"');
      return new Response(
        JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), presets }, null, 2),
        { status: 200, headers }
      );
    }

    if (method === 'POST' && pathname === '/api/presets/import') {
      const body = await readJsonBody<{ presets?: unknown } | unknown[]>(request);
      const incoming = Array.isArray((body as { presets?: unknown }).presets)
        ? ((body as { presets: unknown[] }).presets)
        : Array.isArray(body)
        ? body
        : [];
      if (incoming.length === 0) {
        return errorJson('Provide a valid presets array in the JSON payload.', 400, request);
      }
      const imported: StudioPreset[] = [];
      for (const rawItem of incoming) {
        const raw = rawItem as Partial<StudioPreset> | null;
        if (!raw || !raw.name || !['caption', 'filter', 'editing', 'style'].includes(String(raw.category))) {
          continue;
        }
        const cleanPayload =
          raw.category === 'style'
            ? (sanitizeSavedStylePayload(raw.payload) as unknown as Record<string, unknown>)
            : raw.payload && typeof raw.payload === 'object'
            ? raw.payload
            : {};
        const created = await createPreset(env, {
          id: crypto.randomUUID(),
          category: raw.category as PresetCategory,
          name: String(raw.name),
          description: typeof raw.description === 'string' ? raw.description : '',
          isDefault: Boolean(raw.isDefault),
          thumbnailStyle: raw.thumbnailStyle && typeof raw.thumbnailStyle === 'object' ? raw.thumbnailStyle : {},
          payload: cleanPayload,
          assetRefs: Array.isArray(raw.assetRefs) ? raw.assetRefs : [],
        });
        imported.push(created);
      }
      return jsonResponse(
        { importedCount: imported.length, imported, presets: await listPresets(env) },
        201,
        request
      );
    }

    if (method === 'GET' && pathname === '/api/presets') {
      const cat = url.searchParams.get('category') as PresetCategory | null;
      const validCat =
        cat && ['caption', 'filter', 'editing', 'style'].includes(cat) ? cat : undefined;
      return jsonResponse({ presets: await listPresets(env, validCat) }, 200, request);
    }

    if (method === 'POST' && pathname === '/api/presets') {
      const body = await readJsonBody<Record<string, unknown>>(request);
      const category = body.category as PresetCategory;
      const name = String(body.name || '').trim();
      if (!['caption', 'filter', 'editing', 'style'].includes(category)) {
        return errorJson(
          'Valid preset category required (caption | filter | editing | style).',
          400,
          request
        );
      }
      if (!name) return errorJson('Preset name is required.', 400, request);
      const cleanPayload =
        category === 'style'
          ? (sanitizeSavedStylePayload(body.payload) as unknown as Record<string, unknown>)
          : ((body.payload as Record<string, unknown>) || {});
      const preset = await createPreset(env, {
        id: crypto.randomUUID(),
        category,
        name,
        description: typeof body.description === 'string' ? body.description : '',
        isDefault: Boolean(body.isDefault),
        thumbnailStyle: (body.thumbnailStyle as StudioPreset['thumbnailStyle']) || {},
        payload: cleanPayload,
        assetRefs: Array.isArray(body.assetRefs) ? (body.assetRefs as StudioPresetAssetRef[]) : [],
      });
      return jsonResponse({ preset, presets: await listPresets(env) }, 201, request);
    }

    params = matchPath('/api/presets/:id', pathname);
    if (method === 'PATCH' && params) {
      const body = await readJsonBody<Record<string, unknown>>(request);
      const existing = await getPreset(env, params.id);
      if (!existing) return errorJson('Preset not found.', 404, request);
      const cleanPayload =
        existing.category === 'style' && body.payload !== undefined
          ? (sanitizeSavedStylePayload(body.payload) as unknown as Record<string, unknown>)
          : (body.payload as Record<string, unknown> | undefined);
      const updated = await updatePreset(env, params.id, {
        name: body.name as string | undefined,
        description: body.description as string | undefined,
        isDefault: body.isDefault as boolean | undefined,
        thumbnailStyle: body.thumbnailStyle as StudioPreset['thumbnailStyle'] | undefined,
        payload: cleanPayload,
        assetRefs: body.assetRefs as StudioPresetAssetRef[] | undefined,
      });
      return jsonResponse({ preset: updated, presets: await listPresets(env) }, 200, request);
    }

    if (method === 'DELETE' && params) {
      const db = requireDb(env);
      const existing = await getPreset(env, params.id);
      const ok = await deletePreset(db, params.id);
      if (!ok) return errorJson('Preset not found.', 404, request);
      if (existing?.category === 'style') {
        const prefs = await getDefaultStudioPreferences(db);
        if (prefs.defaultStyleId === existing.id) {
          await saveDefaultStudioPreferences(db, { defaultStyleId: null });
        }
      }
      return jsonResponse({ deleted: true, presets: await listPresets(env) }, 200, request);
    }

    if (method === 'GET' && pathname === '/api/styles') {
      const db = requireDb(env);
      const styles = await listPresets(env, 'style');
      const prefs = await getDefaultStudioPreferences(db);
      return jsonResponse(
        {
          styles,
          defaultStyleId:
            prefs.defaultStyleId && styles.some((s) => s.id === prefs.defaultStyleId)
              ? prefs.defaultStyleId
              : styles.find((s) => s.isDefault)?.id || null,
        },
        200,
        request
      );
    }

    if (method === 'POST' && pathname === '/api/styles') {
      const db = requireDb(env);
      const body = await readJsonBody<Record<string, unknown>>(request);
      const name = String(body.name || '').trim();
      if (!name) return errorJson('Style name is required.', 400, request);
      const description = typeof body.description === 'string' ? body.description.trim() : '';
      const isDefault = Boolean(body.isDefault);
      const savedThumbUrl = await saveStyleThumbnailDataUrl(
        env,
        typeof body.thumbnailDataUrl === 'string' ? body.thumbnailDataUrl : undefined
      );

      let payloadObj: Record<string, unknown>;
      let thumbnailStyle = (body.thumbnailStyle as StudioPreset['thumbnailStyle']) || {};
      let assetRefs: StudioPresetAssetRef[] = Array.isArray(body.assetRefs)
        ? (body.assetRefs as StudioPresetAssetRef[])
        : [];

      if (typeof body.projectId === 'string' && body.projectId.trim()) {
        const sourceProject = await getProject(db, body.projectId.trim());
        if (!sourceProject) return errorJson('Source project not found.', 404, request);
        const built = buildSavedStylePayloadFromProject(sourceProject, {
          savedVoices: await getSavedFishVoices(db),
          thumbnailImageUrl:
            savedThumbUrl ||
            (typeof body.thumbnailImageUrl === 'string' ? body.thumbnailImageUrl : undefined),
        });
        payloadObj = built.payload as unknown as Record<string, unknown>;
        thumbnailStyle = {
          ...built.thumbnailStyle,
          ...thumbnailStyle,
          ...(savedThumbUrl ? { imageUrl: savedThumbUrl } : {}),
        };
        assetRefs = built.assetRefs;
      } else {
        const sanitized = sanitizeSavedStylePayload({
          ...((body.payload as Record<string, unknown>) || {}),
          ...(savedThumbUrl ? { thumbnailImageUrl: savedThumbUrl } : {}),
        });
        payloadObj = sanitized as unknown as Record<string, unknown>;
        if (savedThumbUrl) thumbnailStyle = { ...thumbnailStyle, imageUrl: savedThumbUrl };
      }

      const style = await createPreset(env, {
        id: crypto.randomUUID(),
        category: 'style',
        name,
        description,
        isDefault,
        thumbnailStyle,
        payload: payloadObj,
        assetRefs,
      });
      if (isDefault) await saveDefaultStudioPreferences(db, { defaultStyleId: style.id });
      return jsonResponse({ style, styles: await listPresets(env, 'style') }, 201, request);
    }

    params = matchPath('/api/styles/:id/duplicate', pathname);
    if (method === 'POST' && params) {
      const existing = await getPreset(env, params.id);
      if (!existing || existing.category !== 'style') {
        return errorJson('Saved style not found.', 404, request);
      }
      const style = await createPreset(env, {
        id: crypto.randomUUID(),
        category: 'style',
        name: `${existing.name} (Copy)`,
        description: existing.description,
        isDefault: false,
        thumbnailStyle: existing.thumbnailStyle,
        payload: sanitizeSavedStylePayload(existing.payload) as unknown as Record<string, unknown>,
        assetRefs: existing.assetRefs,
      });
      return jsonResponse({ style, styles: await listPresets(env, 'style') }, 201, request);
    }

    params = matchPath('/api/styles/:id', pathname);
    if (method === 'PATCH' && params) {
      const db = requireDb(env);
      const existing = await getPreset(env, params.id);
      if (!existing || existing.category !== 'style') {
        return errorJson('Saved style not found.', 404, request);
      }
      const body = await readJsonBody<Record<string, unknown>>(request);
      const savedThumbUrl = await saveStyleThumbnailDataUrl(
        env,
        typeof body.thumbnailDataUrl === 'string' ? body.thumbnailDataUrl : undefined
      );
      let nextPayload = existing.payload;
      let nextThumbnailStyle = existing.thumbnailStyle || {};
      const nextAssetRefs = existing.assetRefs || [];

      if (typeof body.fromProjectId === 'string' && body.fromProjectId.trim()) {
        const srcProj = await getProject(db, body.fromProjectId.trim());
        if (!srcProj) return errorJson('Source project not found.', 404, request);
        const built = buildSavedStylePayloadFromProject(srcProj, {
          savedVoices: await getSavedFishVoices(db),
          thumbnailImageUrl:
            savedThumbUrl ||
            (typeof body.thumbnailImageUrl === 'string' ? body.thumbnailImageUrl : undefined) ||
            (existing.payload as { thumbnailImageUrl?: string })?.thumbnailImageUrl,
        });
        nextPayload = built.payload as unknown as Record<string, unknown>;
        nextThumbnailStyle = built.thumbnailStyle;
      } else if (body.payload !== undefined) {
        nextPayload = sanitizeSavedStylePayload({
          ...(body.payload as Record<string, unknown>),
          ...(savedThumbUrl ? { thumbnailImageUrl: savedThumbUrl } : {}),
        }) as unknown as Record<string, unknown>;
      } else if (savedThumbUrl) {
        nextPayload = sanitizeSavedStylePayload({
          ...existing.payload,
          thumbnailImageUrl: savedThumbUrl,
        }) as unknown as Record<string, unknown>;
      }

      if (body.thumbnailStyle && typeof body.thumbnailStyle === 'object') {
        nextThumbnailStyle = {
          ...nextThumbnailStyle,
          ...(body.thumbnailStyle as StudioPreset['thumbnailStyle']),
        };
      }
      if (savedThumbUrl) {
        nextThumbnailStyle = { ...nextThumbnailStyle, imageUrl: savedThumbUrl };
      }

      const updated = (await updatePreset(env, existing.id, {
        name: typeof body.name === 'string' ? body.name : existing.name,
        description:
          typeof body.description === 'string' ? body.description : existing.description || '',
        isDefault: body.isDefault !== undefined ? Boolean(body.isDefault) : existing.isDefault,
        thumbnailStyle: nextThumbnailStyle,
        payload: nextPayload,
        assetRefs: Array.isArray(body.assetRefs)
          ? (body.assetRefs as StudioPresetAssetRef[])
          : nextAssetRefs,
      }))!;

      if (body.isDefault !== undefined) {
        const prefs = await getDefaultStudioPreferences(db);
        if (Boolean(body.isDefault)) {
          await saveDefaultStudioPreferences(db, { defaultStyleId: updated.id });
        } else if (prefs.defaultStyleId === updated.id) {
          await saveDefaultStudioPreferences(db, { defaultStyleId: null });
        }
      }
      return jsonResponse({ style: updated, styles: await listPresets(env, 'style') }, 200, request);
    }

    if (method === 'DELETE' && params) {
      const db = requireDb(env);
      const existing = await getPreset(env, params.id);
      if (!existing || existing.category !== 'style') {
        return errorJson('Saved style not found.', 404, request);
      }
      await deletePreset(db, existing.id);
      const prefs = await getDefaultStudioPreferences(db);
      if (prefs.defaultStyleId === existing.id) {
        await saveDefaultStudioPreferences(db, { defaultStyleId: null });
      }
      return jsonResponse({ deleted: true, styles: await listPresets(env, 'style') }, 200, request);
    }

    // 6. Projects CRUD & Cloud Sync
    if (method === 'GET' && pathname === '/api/projects') {
      const db = requireDb(env);
      return jsonResponse({ projects: await listProjects(db) }, 200, request);
    }

    if (method === 'POST' && pathname === '/api/projects') {
      const db = requireDb(env);
      const body = await readJsonBody<Record<string, unknown>>(request);
      const name =
        String(body.name || '').trim() || `Recap Project ${new Date().toLocaleDateString()}`;
      const created = await createProject(db, crypto.randomUUID(), name);
      const { patch, warnings } = await applyPresetIdsToProject(env, created, {
        captionPresetId: body.captionPresetId as string | undefined,
        filterPresetId: body.filterPresetId as string | undefined,
        editingPresetId: body.editingPresetId as string | undefined,
        applyDefaults: Boolean(body.applyDefaults),
        preserveCaptionEnabledState: false,
      });
      let finalProject =
        Object.keys(patch).length > 0 ? (await updateProject(db, created.id, patch))! : created;
      let voiceMissingWarning: StyleMissingVoiceWarning | null = null;

      const requestedStyleId = typeof body.styleId === 'string' ? body.styleId.trim() : '';
      const prefs = await getDefaultStudioPreferences(db);
      const autoDefaultId =
        body.applyDefaultStyle !== false &&
        requestedStyleId !== 'none' &&
        prefs.autoApplyDefaultStyleOnImport &&
        prefs.defaultStyleId
          ? prefs.defaultStyleId
          : '';
      const effectiveStyleId =
        requestedStyleId && requestedStyleId !== 'none' ? requestedStyleId : autoDefaultId;

      if (effectiveStyleId) {
        const style = await getPreset(env, effectiveStyleId);
        if (style && style.category === 'style') {
          const allCustomFonts = await listCustomFonts(db);
          const styleRes = applySavedStyleToProjectData({
            project: finalProject,
            style,
            scope: 'all',
            savedVoices: await getSavedFishVoices(db),
            checkAssetAvailable: (assetUrl) =>
              Boolean(
                assetUrl &&
                  (assetUrl.startsWith('data:') ||
                    allCustomFonts.some((f) => f.url === assetUrl) ||
                    assetUrl.startsWith('/media/'))
              ),
            generateId: () => crypto.randomUUID(),
            preserveCaptionEnabledState: false,
          });
          if (Object.keys(styleRes.patch).length > 0) {
            finalProject = (await updateProject(db, finalProject.id, styleRes.patch))!;
          }
          warnings.push(...styleRes.warnings);
          voiceMissingWarning = styleRes.voiceMissingWarning;
        }
      }

      return jsonResponse(
        {
          project: finalProject,
          presetWarnings: warnings,
          voiceMissingWarning,
        },
        201,
        request
      );
    }

    if (method === 'POST' && pathname === '/api/projects/upsert-from-cloud') {
      const db = requireDb(env);
      const body = await readJsonBody<{ project?: Project }>(request);
      if (!body.project?.id) return errorJson('Valid project payload is required.', 400, request);
      const saved = await upsertProjectFromCloud(db, body.project);
      return jsonResponse({ project: saved }, 200, request);
    }

    params = matchPath('/api/projects/:id/apply-style', pathname);
    if (method === 'POST' && params) {
      const db = requireDb(env);
      const project = await getProject(db, params.id);
      if (!project) return errorJson('Project not found', 404, request);
      const body = await readJsonBody<{ styleId?: string; scope?: string }>(request);
      const styleId = String(body.styleId || '').trim();
      const style = await getPreset(env, styleId);
      if (!style || style.category !== 'style') {
        return errorJson('Saved style not found', 404, request);
      }
      const rawScope = String(body.scope || 'all');
      const scope: StyleApplyScope =
        rawScope === 'filters' ||
        rawScope === 'effects' ||
        rawScope === 'captions' ||
        rawScope === 'narration'
          ? rawScope
          : 'all';

      const customFonts = await listCustomFonts(db);
      const availCache = new Map<string, boolean>();
      for (const f of customFonts) availCache.set(f.url, true);

      const result = applySavedStyleToProjectData({
        project,
        style,
        scope,
        savedVoices: await getSavedFishVoices(db),
        checkAssetAvailable: (u) => Boolean(u && (availCache.get(u) || u.startsWith('/media/'))),
        generateId: () => crypto.randomUUID(),
        preserveCaptionEnabledState: true,
      });

      const updated =
        Object.keys(result.patch).length > 0
          ? (await updateProject(db, project.id, result.patch))!
          : project;
      return jsonResponse(
        {
          project: updated,
          warnings: result.warnings,
          voiceMissingWarning: result.voiceMissingWarning,
        },
        200,
        request
      );
    }

    params = matchPath('/api/projects/:id/apply-presets', pathname);
    if (method === 'POST' && params) {
      const db = requireDb(env);
      const project = await getProject(db, params.id);
      if (!project) return errorJson('Project not found', 404, request);
      const body = await readJsonBody<Record<string, unknown>>(request);
      const { patch, warnings } = await applyPresetIdsToProject(env, project, {
        captionPresetId: body.captionPresetId as string | undefined,
        filterPresetId: body.filterPresetId as string | undefined,
        editingPresetId: body.editingPresetId as string | undefined,
        applyDefaults: false,
        preserveCaptionEnabledState: true,
      });
      const updated =
        Object.keys(patch).length > 0 ? (await updateProject(db, project.id, patch))! : project;
      return jsonResponse({ project: updated, presetWarnings: warnings }, 200, request);
    }

    params = matchPath('/api/projects/:id/asset-manifest', pathname);
    if (method === 'GET' && params) {
      const db = requireDb(env);
      const project = await getProject(db, params.id);
      if (!project) return errorJson('Project not found', 404, request);
      const candidates: Array<{ url: string | null; bucket: string; kind: string }> = [
        { url: project.sourceVideoUrl, bucket: 'uploads', kind: 'video' },
        { url: project.lastExportUrl, bucket: 'exports', kind: 'video' },
        { url: project.thumbnailUrl, bucket: 'thumbs', kind: 'image' },
      ];
      const assets = [];
      let totalBytes = 0;
      for (const c of candidates) {
        if (!c.url || c.url.startsWith('blob:') || c.url.startsWith('data:')) continue;
        const exists = await checkAssetAvailableByUrl(env, c.url);
        const row = await db
          .prepare('SELECT size_bytes, filename, mime_type FROM assets WHERE url = ?')
          .bind(c.url)
          .first<{ size_bytes: number; filename: string; mime_type: string }>();
        const sizeBytes = row?.size_bytes || 0;
        totalBytes += sizeBytes;
        assets.push({
          localUrl: c.url,
          bucket: c.bucket,
          filename: row?.filename || c.url.split('/').pop() || 'asset',
          assetKind: c.kind,
          mimeType: row?.mime_type || getMimeType(c.url),
          sizeBytes,
          sha256: 'edge_asset',
          exists,
          exceedsFree50MbCap: sizeBytes > 50 * 1024 * 1024,
          necessaryForCloudSync: true,
        });
      }
      return jsonResponse(
        {
          assets,
          totalBytes,
          necessaryBytes: totalBytes,
          oversizedCount: assets.filter((a) => a.exceedsFree50MbCap).length,
        },
        200,
        request
      );
    }

    params = matchPath('/api/projects/:id', pathname);
    if (method === 'GET' && params) {
      const db = requireDb(env);
      const project = await getProject(db, params.id);
      if (!project) return errorJson('Project not found', 404, request);
      return jsonResponse({ project }, 200, request);
    }

    if (method === 'PATCH' && params) {
      const db = requireDb(env);
      const body = await readJsonBody<Partial<Project>>(request);
      const updated = await updateProject(db, params.id, body || {});
      if (!updated) return errorJson('Project not found', 404, request);
      return jsonResponse({ project: updated }, 200, request);
    }

    if (method === 'DELETE' && params) {
      const db = requireDb(env);
      const ok = await deleteProject(db, params.id);
      if (!ok) return errorJson('Project not found', 404, request);
      return jsonResponse({ deleted: true }, 200, request);
    }

    // 7. Chunked & Direct Video Uploads (R2 Multipart when R2 bound; D1 + IndexedDB local mode otherwise)
    if (method === 'POST' && pathname === '/api/uploads/init') {
      const db = requireDb(env);
      const body = await readJsonBody<{
        projectId?: string;
        filename?: string;
        totalSize?: number;
        totalChunks?: number;
      }>(request);
      const projectId = normalizeProjectIdEdge(body.projectId);
      if (!projectId) {
        return errorJson('Invalid or missing projectId.', 400, request, 'INVALID_PROJECT_ID');
      }
      if (!body.filename || !body.totalSize || !body.totalChunks) {
        return errorJson(
          'Missing required chunk initialization parameters.',
          400,
          request,
          'INVALID_PARAMS'
        );
      }

      const cleanFilename = validateVideoUploadEdge(env, body.filename, Number(body.totalSize));
      const project = await getProject(db, projectId);
      if (!project) {
        return errorJson('Project not found.', 404, request, 'PROJECT_NOT_FOUND');
      }

      const uploadId = crypto.randomUUID();
      const safeName = `${project.id.slice(0, 8)}_${Date.now()}_${cleanFilename}`;
      const r2Key = `uploads/${safeName}`;
      const mimeType = getMimeType(safeName);

      if (env.MEDIA_BUCKET) {
        const multipart = await env.MEDIA_BUCKET.createMultipartUpload(r2Key, {
          httpMetadata: { contentType: mimeType },
        });
        await db
          .prepare(
            `INSERT INTO upload_sessions (upload_id, project_id, filename, total_size, total_chunks, mime_type, r2_upload_id, r2_key, parts_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`
          )
          .bind(
            uploadId,
            project.id,
            safeName,
            Number(body.totalSize),
            Number(body.totalChunks),
            mimeType,
            multipart.uploadId,
            r2Key,
            new Date().toISOString()
          )
          .run();
        return jsonResponse(
          {
            uploadId,
            totalChunks: Number(body.totalChunks),
            projectId: project.id,
            storageMode: 'r2',
          },
          200,
          request
        );
      }

      await db
        .prepare(
          `INSERT INTO upload_sessions (upload_id, project_id, filename, total_size, total_chunks, mime_type, r2_upload_id, r2_key, parts_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'indexeddb-local', ?, '[]', ?)`
        )
        .bind(
          uploadId,
          project.id,
          cleanFilename,
          Number(body.totalSize),
          Number(body.totalChunks),
          mimeType,
          r2Key,
          new Date().toISOString()
        )
        .run();

      return jsonResponse(
        {
          uploadId,
          totalChunks: Number(body.totalChunks),
          projectId: project.id,
          storageMode: 'indexeddb-local',
          suggestedUrl: `/media/${r2Key}`,
        },
        200,
        request
      );
    }

    params = matchPath('/api/uploads/:uploadId/chunk', pathname);
    if (method === 'POST' && params) {
      const db = requireDb(env);
      const chunkIndex = Number(url.searchParams.get('index'));
      if (!Number.isFinite(chunkIndex) || chunkIndex < 0) {
        return errorJson('Invalid chunk index.', 400, request, 'INVALID_CHUNK_INDEX');
      }
      const session = await db
        .prepare('SELECT * FROM upload_sessions WHERE upload_id = ?')
        .bind(params.uploadId)
        .first<{
          upload_id: string;
          total_chunks: number;
          r2_upload_id: string | null;
          r2_key: string | null;
          parts_json: string;
        }>();
      if (!session) {
        return errorJson('Upload session expired or not found.', 404, request, 'UPLOAD_SESSION_NOT_FOUND');
      }
      if (!env.MEDIA_BUCKET || !session.r2_upload_id || session.r2_upload_id === 'indexeddb-local' || !session.r2_key) {
        return errorJson(
          'Server chunk upload requires R2 binding (MEDIA_BUCKET). Use client-side IndexedDB flow when R2 is disabled.',
          400,
          request,
          'R2_NOT_CONFIGURED'
        );
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      const multipart = env.MEDIA_BUCKET.resumeMultipartUpload(
        session.r2_key,
        session.r2_upload_id
      );
      const partNumber = chunkIndex + 1; // R2 parts are 1-indexed
      const uploadedPart = await multipart.uploadPart(partNumber, bytes);

      const parts = JSON.parse(session.parts_json || '[]') as Array<{
        partNumber: number;
        etag: string;
      }>;
      const filtered = parts.filter((p) => p.partNumber !== partNumber);
      filtered.push({ partNumber, etag: uploadedPart.etag });
      filtered.sort((a, b) => a.partNumber - b.partNumber);

      await db
        .prepare('UPDATE upload_sessions SET parts_json = ? WHERE upload_id = ?')
        .bind(JSON.stringify(filtered), params.uploadId)
        .run();

      return jsonResponse(
        { received: filtered.length, totalChunks: session.total_chunks },
        200,
        request
      );
    }

    params = matchPath('/api/uploads/:uploadId/complete', pathname);
    if (method === 'POST' && params) {
      const db = requireDb(env);
      const body = await readJsonBody<{
        projectId?: string;
        storageMode?: string;
        sourceVideoUrl?: string;
        sourceVideoBlobKey?: string | null;
        sourceFilename?: string;
        metadata?: Project['metadata'];
        thumbnailDataUrl?: string;
        waveformPeaks?: number[];
      }>(request);

      const session = await db
        .prepare('SELECT * FROM upload_sessions WHERE upload_id = ?')
        .bind(params.uploadId)
        .first<{
          upload_id: string;
          project_id?: string | null;
          filename: string;
          total_size: number;
          mime_type: string;
          r2_upload_id: string | null;
          r2_key: string | null;
          parts_json: string;
        }>();

      if (!session) {
        return errorJson('Upload session not found.', 404, request, 'UPLOAD_SESSION_NOT_FOUND');
      }

      const requestedProjectId = normalizeProjectIdEdge(body.projectId);
      const projectId = requestedProjectId || session.project_id || null;
      if (!projectId) {
        return errorJson('Invalid or missing projectId.', 400, request, 'INVALID_PROJECT_ID');
      }
      if (session.project_id && session.project_id !== projectId) {
        return errorJson(
          'Upload session does not belong to the specified project.',
          400,
          request,
          'PROJECT_ID_MISMATCH'
        );
      }

      const existing = await getProject(db, projectId);
      if (!existing) {
        return errorJson('Project not found.', 404, request, 'PROJECT_NOT_FOUND');
      }

      if (session.r2_upload_id === 'indexeddb-local' || body.storageMode === 'indexeddb-local' || !env.MEDIA_BUCKET) {
        const finalFilename = body.sourceFilename || session.filename;
        const sourceVideoUrl =
          body.sourceVideoUrl ||
          (body.sourceVideoBlobKey ? `idb://blobs/${body.sourceVideoBlobKey}` : existing.sourceVideoUrl);
        let thumbnailUrl = existing.thumbnailUrl;
        if (body.thumbnailDataUrl) {
          thumbnailUrl = (await saveStyleThumbnailDataUrl(env, body.thumbnailDataUrl)) || body.thumbnailDataUrl || thumbnailUrl;
        }
        const dur = Math.max(0.5, body.metadata?.duration || existing.metadata?.duration || 12);
        const updated = await updateProject(db, existing.id, {
          ...(sourceVideoUrl ? { sourceVideoUrl } : {}),
          ...(body.sourceVideoBlobKey ? { sourceVideoBlobKey: body.sourceVideoBlobKey } : {}),
          sourceFilename: finalFilename,
          thumbnailUrl,
          ...(body.metadata ? { metadata: body.metadata } : {}),
          ...(Array.isArray(body.waveformPeaks) ? { waveformPeaks: body.waveformPeaks } : {}),
          videoClips: [
            {
              id: 'vclip_main',
              label: finalFilename,
              sourceStart: 0,
              sourceEnd: dur,
              timelineStart: 0,
              speed: 1.0,
              audioUnlinked: false,
            },
          ],
          originalAudioClips: [],
          exportSettings: {
            ...existing.exportSettings,
            aspectRatio: existing.exportSettings.aspectRatio || 'original',
          },
        });
        await db
          .prepare('DELETE FROM upload_sessions WHERE upload_id = ?')
          .bind(params.uploadId)
          .run();
        return jsonResponse({ project: updated, metadata: updated?.metadata }, 200, request);
      }

      if (!session.r2_upload_id || !session.r2_key) {
        return errorJson('Upload session is missing R2 multipart metadata.', 404, request, 'UPLOAD_SESSION_INVALID');
      }

      const multipart = env.MEDIA_BUCKET.resumeMultipartUpload(
        session.r2_key,
        session.r2_upload_id
      );
      const parts = JSON.parse(session.parts_json || '[]') as R2UploadedPart[];
      await multipart.complete(parts);
      await db
        .prepare('DELETE FROM upload_sessions WHERE upload_id = ?')
        .bind(params.uploadId)
        .run();

      const sourceVideoUrl = `/media/${session.r2_key}`;
      await db
        .prepare(
          `INSERT OR REPLACE INTO assets (id, project_id, kind, filename, file_path, url, mime_type, size_bytes, created_at)
           VALUES (?, ?, 'video', ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          existing.id,
          session.filename,
          `r2://${session.r2_key}`,
          sourceVideoUrl,
          session.mime_type,
          session.total_size,
          new Date().toISOString()
        )
        .run();

      let thumbnailUrl = existing.thumbnailUrl;
      if (body.thumbnailDataUrl) {
        thumbnailUrl = (await saveStyleThumbnailDataUrl(env, body.thumbnailDataUrl)) || thumbnailUrl;
      }

      const dur = Math.max(0.5, body.metadata?.duration || existing.metadata?.duration || 12);
      const updated = await updateProject(db, existing.id, {
        sourceVideoUrl,
        sourceFilename: session.filename,
        thumbnailUrl,
        ...(body.metadata ? { metadata: body.metadata } : {}),
        ...(Array.isArray(body.waveformPeaks) ? { waveformPeaks: body.waveformPeaks } : {}),
        videoClips: [
          {
            id: 'vclip_main',
            label: session.filename,
            sourceStart: 0,
            sourceEnd: dur,
            timelineStart: 0,
            speed: 1.0,
            audioUnlinked: false,
          },
        ],
        originalAudioClips: [],
        exportSettings: {
          ...existing.exportSettings,
          aspectRatio: existing.exportSettings.aspectRatio || 'original',
        },
      });

      return jsonResponse({ project: updated, metadata: updated?.metadata }, 200, request);
    }

    // Direct Video Upload (Single-request multipart upload)
    const directVideoMatch = matchPath('/api/projects/:id/video', pathname);
    if (method === 'POST' && (directVideoMatch || pathname === '/api/upload')) {
      const db = requireDb(env);
      const form = await request.formData();
      const rawProjectId =
        directVideoMatch?.id ??
        (typeof form.get('projectId') === 'string' ? form.get('projectId') : null) ??
        url.searchParams.get('projectId');
      const projectId = normalizeProjectIdEdge(rawProjectId);
      if (!projectId) {
        return errorJson('Invalid or missing projectId.', 400, request, 'INVALID_PROJECT_ID');
      }

      const project = await getProject(db, projectId);
      if (!project) {
        return errorJson('Project not found.', 404, request, 'PROJECT_NOT_FOUND');
      }

      const file = form.get('file');
      if (!file || !(file instanceof File)) {
        return errorJson('No video file provided.', 400, request, 'NO_FILE_PROVIDED');
      }

      const cleanFilename = validateVideoUploadEdge(env, file.name || 'video.mp4', file.size);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const stored = await saveBinaryAsset(env, {
        projectId: project.id,
        kind: 'video',
        bucket: 'uploads',
        filename: `${project.id.slice(0, 8)}_${Date.now()}_${cleanFilename}`,
        mimeType: file.type || getMimeType(cleanFilename),
        bytes,
      });

      if (stored.storedIn === 'client-only') {
        return errorJson(
          'Direct multipart uploads over 700 KB require an R2 bucket (MEDIA_BUCKET) or chunked IndexedDB upload.',
          413,
          request,
          'R2_REQUIRED_FOR_LARGE_DIRECT_UPLOAD'
        );
      }

      const dur = Math.max(0.5, project.metadata?.duration || 12);
      const updated = await updateProject(db, project.id, {
        sourceVideoUrl: stored.url,
        sourceFilename: cleanFilename,
        videoClips: [
          {
            id: 'vclip_main',
            label: cleanFilename,
            sourceStart: 0,
            sourceEnd: dur,
            timelineStart: 0,
            speed: 1.0,
            audioUnlinked: false,
          },
        ],
        originalAudioClips: [],
        exportSettings: {
          ...project.exportSettings,
          aspectRatio: project.exportSettings.aspectRatio || 'original',
        },
      });
      return jsonResponse({ project: updated, metadata: updated?.metadata }, 200, request);
    }

    // Generic small binary upload endpoint for browser-generated dub/export/thumbnail when R2 is bound
    if (method === 'POST' && pathname === '/api/assets/upload') {
      const form = await request.formData();
      const file = form.get('file');
      if (!file || !(file instanceof File)) {
        return errorJson('Missing file payload.', 400, request);
      }
      const projectId = String(form.get('projectId') || '').trim() || null;
      const bucket = String(form.get('bucket') || 'audio').replace(/[^a-z0-9_-]/gi, '');
      const kind = String(form.get('kind') || bucket);
      const filename = String(form.get('filename') || file.name || `asset_${Date.now()}.bin`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const saved = await saveBinaryAsset(env, {
        projectId,
        kind,
        bucket,
        filename,
        mimeType: file.type || getMimeType(filename),
        bytes,
      });
      return jsonResponse(saved, 200, request);
    }

    // 8. Project Media Asset Uploads (Logo, Canvas Background, Music, SFX, Mask, Thumbnails)
    params = matchPath('/api/projects/:id/logo', pathname);
    if (method === 'POST' && params) {
      const db = requireDb(env);
      const project = await getProject(db, params.id);
      if (!project) return errorJson('Project not found', 404, request);
      const form = await request.formData();
      const file = form.get('file');
      if (!file || !(file instanceof File)) return errorJson('No logo file uploaded', 400, request);
      const safeName = `${project.id.slice(0, 8)}_${Date.now()}_${sanitizeFilename(
        file.name,
        'logo.png'
      )}`;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const saved = await saveBinaryAsset(env, {
        projectId: project.id,
        kind: 'logo',
        bucket: 'logos',
        filename: safeName,
        mimeType: file.type || getMimeType(safeName),
        bytes,
      });

      let logoUrl = saved.url;
      if (saved.storedIn === 'client-only' && bytes.byteLength <= 1_800_000) {
        // Inline data URL fallback when no R2 and >700 KB D1 limit
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        logoUrl = `data:${file.type || getMimeType(safeName)};base64,${btoa(bin)}`;
      }

      const newLogo = {
        id: crypto.randomUUID(),
        filename: safeName,
        url: logoUrl,
        enabled: true,
        x: 0.78,
        y: 0.05,
        widthPct: 16,
        opacity: 0.9,
        permanent: true,
        startTime: 0,
        endTime: project.metadata?.duration || 30,
        presetPosition: 'top-right' as const,
        motion: {
          enabled: false,
          pattern: 'static' as const,
          speed: 1.0,
          endX: 0.78,
          endY: 0.8,
        },
      };
      const updated = await updateProject(db, project.id, { logos: [...project.logos, newLogo] });
      return jsonResponse({ project: updated, logo: newLogo, storedIn: saved.storedIn }, 200, request);
    }

    params = matchPath('/api/projects/:id/canvas-bg', pathname);
    if (method === 'POST' && params) {
      const db = requireDb(env);
      const project = await getProject(db, params.id);
      if (!project) return errorJson('Project not found', 404, request);
      const form = await request.formData();
      const file = form.get('file');
      if (!file || !(file instanceof File)) {
        return errorJson('No background image file uploaded', 400, request);
      }
      const safeName = `${project.id.slice(0, 8)}_${Date.now()}_${sanitizeFilename(
        file.name,
        'bg.png'
      )}`;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const saved = await saveBinaryAsset(env, {
        projectId: project.id,
        kind: 'background',
        bucket: 'backgrounds',
        filename: safeName,
        mimeType: file.type || getMimeType(safeName),
        bytes,
      });
      let bgUrl = saved.url;
      if (saved.storedIn === 'client-only' && bytes.byteLength <= 1_800_000) {
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        bgUrl = `data:${file.type || getMimeType(safeName)};base64,${btoa(bin)}`;
      }
      const updated = await updateProject(db, project.id, {
        canvas: {
          ...(project.canvas || {
            aspectRatio: 'original',
            customWidth: 1080,
            customHeight: 1920,
            zoom: 1,
            offsetX: 0,
            offsetY: 0,
            cropTop: 0,
            cropRight: 0,
            cropBottom: 0,
            cropLeft: 0,
            bgColor: '#09090B',
            bgImageScale: 1,
            bgImageOffsetX: 0,
            bgImageOffsetY: 0,
            bgBlurIntensity: 24,
            bgBlurBrightness: -15,
            bgBlurOpacity: 0.9,
          }),
          backgroundType: 'image',
          bgImageUrl: bgUrl,
          bgImageFilename: safeName,
        },
      });
      return jsonResponse(
        { project: updated, url: bgUrl, filename: safeName, storedIn: saved.storedIn },
        200,
        request
      );
    }

    params = matchPath('/api/projects/:id/music', pathname);
    if (method === 'POST' && params) {
      const db = requireDb(env);
      const project = await getProject(db, params.id);
      if (!project) return errorJson('Project not found', 404, request);
      const form = await request.formData();
      const file = form.get('file');
      if (!file || !(file instanceof File)) return errorJson('No audio file uploaded', 400, request);
      const safeName = `${project.id.slice(0, 8)}_bgm_${Date.now()}_${sanitizeFilename(
        file.name,
        'music.mp3'
      )}`;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const saved = await saveBinaryAsset(env, {
        projectId: project.id,
        kind: 'music',
        bucket: 'audio',
        filename: safeName,
        mimeType: file.type || getMimeType(safeName),
        bytes,
      });
      const updated = await updateProject(db, project.id, {
        voice: {
          ...project.voice,
          bgMusicFilename: safeName,
          bgMusicUrl: saved.url,
          bgMusicEnabled: true,
          bgMusicMuted: false,
          bgMusicVolume: project.voice.bgMusicVolume > 0.01 ? project.voice.bgMusicVolume : 0.25,
        },
      });
      return jsonResponse({ project: updated, storedIn: saved.storedIn }, 200, request);
    }

    params = matchPath('/api/projects/:id/sfx', pathname);
    if (method === 'POST' && params) {
      const db = requireDb(env);
      const project = await getProject(db, params.id);
      if (!project) return errorJson('Project not found', 404, request);
      const form = await request.formData();
      const file = form.get('file');
      if (!file || !(file instanceof File)) {
        return errorJson('No SFX audio file uploaded', 400, request);
      }
      const safeName = `${project.id.slice(0, 8)}_sfx_${Date.now()}_${sanitizeFilename(
        file.name,
        'sfx.mp3'
      )}`;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const saved = await saveBinaryAsset(env, {
        projectId: project.id,
        kind: 'audio',
        bucket: 'audio',
        filename: safeName,
        mimeType: file.type || getMimeType(safeName),
        bytes,
      });
      const updated = await updateProject(db, project.id, {
        voice: {
          ...project.voice,
          sfxFilename: safeName,
          sfxUrl: saved.url,
          sfxEnabled: true,
          sfxMuted: false,
          sfxVolume: project.voice.sfxVolume ?? 1.0,
        },
      });
      return jsonResponse({ project: updated, storedIn: saved.storedIn }, 200, request);
    }

    params = matchPath('/api/projects/:id/mask', pathname);
    if (method === 'POST' && params) {
      const db = requireDb(env);
      const project = await getProject(db, params.id);
      if (!project) return errorJson('Project not found', 404, request);
      const body = await readJsonBody<{ blurId?: string; maskBase64?: string }>(request);
      if (!body.blurId || !body.maskBase64) {
        return errorJson('blurId and maskBase64 are required', 400, request);
      }
      const cleaned = body.maskBase64.replace(/^data:image\/\w+;base64,/, '');
      const bin = atob(cleaned);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const filename = `mask_${project.id.slice(0, 8)}_${sanitizeFilename(body.blurId)}.png`;
      const saved = await saveBinaryAsset(env, {
        projectId: project.id,
        kind: 'mask',
        bucket: 'masks',
        filename,
        mimeType: 'image/png',
        bytes,
      });
      return jsonResponse(
        {
          maskUrl: saved.storedIn === 'client-only' ? body.maskBase64 : saved.url,
          assetId: filename,
          storedIn: saved.storedIn,
        },
        200,
        request
      );
    }

    params = matchPath('/api/projects/:id/thumbnails/save', pathname);
    if (method === 'POST' && params) {
      const db = requireDb(env);
      const project = await getProject(db, params.id);
      if (!project) return errorJson('Project not found.', 404, request);
      const form = await request.formData();
      const file = form.get('file');
      if (!file || !(file instanceof File)) {
        return errorJson('Thumbnail image file is required.', 400, request);
      }
      const format = form.get('format') === 'jpg' ? 'jpg' : 'png';
      const label = String(form.get('label') || 'TikTok Thumbnail').slice(0, 80);
      const width = Number(form.get('width')) || 1080;
      const height = Number(form.get('height')) || 1920;
      const thumbId = crypto.randomUUID();
      const safeFilename = `tiktok_thumb_${project.id.slice(0, 8)}_${thumbId.slice(0, 8)}.${format}`;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const saved = await saveBinaryAsset(env, {
        projectId: project.id,
        kind: 'thumbnail',
        bucket: 'thumbs',
        filename: safeFilename,
        mimeType: format === 'jpg' ? 'image/jpeg' : 'image/png',
        bytes,
      });

      const newThumb = {
        id: thumbId,
        url: saved.url,
        label,
        width,
        height,
        format: format as 'png' | 'jpg',
        createdAt: new Date().toISOString(),
      };
      const nextSaved = [newThumb, ...(project.savedThumbnails || [])].slice(0, 20);
      const updated = await updateProject(db, project.id, {
        savedThumbnails: nextSaved,
        thumbnailUrl: form.get('setAsCover') === 'true' ? saved.url : project.thumbnailUrl,
      });
      return jsonResponse(
        { thumbnail: newThumb, project: updated, storedIn: saved.storedIn },
        200,
        request
      );
    }

    // 9. Subtitles Import / Export & Translation
    params = matchPath('/api/projects/:id/subtitles/:format', pathname);
    if (method === 'GET' && params) {
      const db = requireDb(env);
      const project = await getProject(db, params.id);
      if (!project) return errorJson('Project not found', 404, request);
      const format = params.format.toLowerCase();
      const safeTitle = project.name.replace(/\s+/g, '_');
      const headers = new Headers(corsHeaders(request));

      if (format === 'srt') {
        headers.set('Content-Type', 'text/plain; charset=utf-8');
        headers.set('Content-Disposition', `attachment; filename="${safeTitle}.srt"`);
        return new Response(generateSrtContent(project.captions, project.subtitleStyle), {
          status: 200,
          headers,
        });
      }
      if (format === 'vtt') {
        headers.set('Content-Type', 'text/vtt; charset=utf-8');
        headers.set('Content-Disposition', `attachment; filename="${safeTitle}.vtt"`);
        return new Response(generateVttContent(project.captions, project.subtitleStyle), {
          status: 200,
          headers,
        });
      }
      if (format === 'ass') {
        headers.set('Content-Type', 'text/plain; charset=utf-8');
        headers.set('Content-Disposition', `attachment; filename="${safeTitle}.ass"`);
        return new Response(
          buildAssContent({
            captions: project.captions,
            style: project.subtitleStyle,
            videoWidth: project.metadata?.width || 1280,
            videoHeight: project.metadata?.height || 720,
            totalDuration: project.metadata?.duration || 30,
          }),
          { status: 200, headers }
        );
      }
      return errorJson('Supported formats: srt, vtt, ass', 400, request);
    }

    params = matchPath('/api/projects/:id/captions/import', pathname);
    if (method === 'POST' && params) {
      const db = requireDb(env);
      const project = await getProject(db, params.id);
      if (!project) return errorJson('Project not found', 404, request);
      const body = await readJsonBody<{ content?: string }>(request);
      const rawContent = String(body.content || '').trim();
      if (!rawContent) {
        return errorJson('No subtitle content provided in request body', 400, request);
      }
      const parsed = parseSrtOrVtt(rawContent);
      if (parsed.length === 0) {
        return errorJson('Could not parse any valid subtitle segments from file', 400, request);
      }
      const updated = await updateProject(db, project.id, { captions: parsed });
      return jsonResponse({ project: updated, count: parsed.length }, 200, request);
    }

    params = matchPath('/api/projects/:id/translate', pathname);
    if (method === 'POST' && params) {
      const db = requireDb(env);
      const project = await getProject(db, params.id);
      if (!project) return errorJson('Project not found', 404, request);
      const body = await readJsonBody<{
        targetLanguage?: SupportedLanguage;
        preserveProperNouns?: boolean;
      }>(request);
      const targetLanguage = (body.targetLanguage ||
        project.translation.targetLanguage) as SupportedLanguage;
      const preserveProperNouns =
        body.preserveProperNouns !== undefined
          ? Boolean(body.preserveProperNouns)
          : project.translation.preserveProperNouns;

      const translatedSegments = await translateWithGeminiRest(env, {
        captions: project.captions,
        sourceLanguage: project.translation.sourceLanguage || 'Auto',
        targetLanguage,
        preserveProperNouns,
      });

      const updated = await updateProject(db, project.id, {
        captions: translatedSegments,
        translation: {
          ...project.translation,
          targetLanguage,
          preserveProperNouns,
          lastTranslatedAt: new Date().toISOString(),
        },
        subtitleStyle: {
          ...project.subtitleStyle,
          useTranslated: true,
        },
      });
      return jsonResponse({ project: updated }, 200, request);
    }

    // 10. Fish Audio Preview, Single-Segment TTS Synthesis, ASR Transcribe, Resync, Diagnostic
    params = matchPath('/api/projects/:id/dubbing/preview', pathname);
    if (method === 'POST' && params) {
      const db = requireDb(env);
      const project = await getProject(db, params.id);
      if (!project) return errorJson('Project not found', 404, request);
      const body = await readJsonBody<{ text?: string; referenceId?: string }>(request);
      const text = String(body.text || '').trim();
      if (!text) return errorJson('Preview text is required', 400, request);
      const referenceId =
        typeof body.referenceId === 'string' ? body.referenceId : project.voice.fishReferenceId;

      const synth = await synthesizeFishSpeech(env, {
        projectId: project.id,
        text,
        referenceId,
        filenamePrefix: `fish_preview_${project.id.slice(0, 8)}`,
      });
      if (synth.storedIn === 'client-only') {
        const b64 = btoa(String.fromCharCode(...synth.bytes));
        return jsonResponse({ audioUrl: `data:audio/mpeg;base64,${b64}` }, 200, request);
      }
      return jsonResponse({ audioUrl: synth.audioUrl }, 200, request);
    }

    params = matchPath('/api/projects/:id/dubbing/synthesize-segment', pathname);
    if (method === 'POST' && params) {
      const db = requireDb(env);
      const project = await getProject(db, params.id);
      if (!project) return errorJson('Project not found', 404, request);
      const body = await readJsonBody<{
        segmentId?: string;
        text?: string;
        referenceId?: string;
        returnBase64?: boolean;
      }>(request);
      const text = String(body.text || '').trim();
      if (!text) return errorJson('Segment text is required', 400, request);
      const referenceId =
        typeof body.referenceId === 'string' ? body.referenceId : project.voice.fishReferenceId;
      const segSlug = sanitizeFilename(String(body.segmentId || 'seg')).slice(0, 16);

      const synth = await synthesizeFishSpeech(env, {
        projectId: project.id,
        text,
        referenceId,
        filenamePrefix: `fish_seg_${project.id.slice(0, 8)}_${segSlug}`,
      });

      const shouldIncludeBase64 = Boolean(body.returnBase64) || synth.storedIn === 'client-only';
      let audioBase64: string | undefined;
      if (shouldIncludeBase64) {
        let bin = '';
        for (let i = 0; i < synth.bytes.length; i++) bin += String.fromCharCode(synth.bytes[i]);
        audioBase64 = btoa(bin);
      }

      return jsonResponse(
        {
          segmentId: body.segmentId,
          audioUrl: synth.audioUrl,
          durationSec: synth.durationSec,
          storedIn: synth.storedIn,
          ...(audioBase64 ? { audioBase64 } : {}),
        },
        200,
        request
      );
    }

    params = matchPath('/api/projects/:id/dubbing/transcribe', pathname);
    const transcribeParams = params || matchPath('/api/projects/:id/transcribe', pathname);
    if (method === 'POST' && transcribeParams) {
      const proxied = await proxyToExternalBackend(env, request, url);
      if (proxied) return proxied;

      const db = requireDb(env);
      const project = await getProject(db, transcribeParams.id);
      if (!project) return errorJson('Project not found.', 404, request);

      const contentType = request.headers.get('Content-Type') || '';
      if (contentType.includes('multipart/form-data')) {
        const form = await request.formData();
        const audioFile = form.get('audio') || form.get('file');
        if (!audioFile || !(audioFile instanceof File)) {
          return errorJson('Extracted audio track file is required for edge ASR transcription.', 400, request);
        }
        const sourceLanguage =
          String(form.get('sourceLanguage') || project.translation.sourceLanguage || 'Auto');
        const durationHint =
          Number(form.get('duration')) || project.metadata?.duration || 15;
        const audioBytes = new Uint8Array(await audioFile.arrayBuffer());
        const result = await transcribeAudioBlobWithFish(env, {
          audioBytes,
          mimeType: audioFile.type || 'audio/wav',
          filename: audioFile.name || 'audio.wav',
          durationHint,
          sourceLanguage,
        });
        const updated = await updateProject(db, project.id, {
          captions: result.segments,
          translation: {
            ...project.translation,
            sourceLanguage: result.detectedLanguage,
          },
        });
        return jsonResponse(
          {
            project: updated,
            detectedLanguage: result.detectedLanguage,
            segmentCount: result.segments.length,
          },
          200,
          request
        );
      }

      return errorJson(
        'Edge transcription requires browser-extracted audio uploaded via multipart form-data (use updated client workflow or attach BACKEND_URL).',
        400,
        request
      );
    }

    params = matchPath('/api/projects/:id/dubbing/resync', pathname);
    if (method === 'POST' && params) {
      const db = requireDb(env);
      const project = await getProject(db, params.id);
      if (!project || !project.metadata) {
        return errorJson('Project video not found.', 404, request);
      }
      const body = await readJsonBody<{
        syncMode?: SyncMode;
        continuousPauseMs?: number;
        generatedClips?: GeneratedVoiceClip[];
        fullDubUrl?: string;
      }>(request);

      const syncMode = normalizeSyncMode(body.syncMode ?? project.voice.syncMode);
      const continuousPauseMs = clampContinuousPauseMs(
        body.continuousPauseMs ?? project.voice.continuousPauseMs
      );
      const inputClips = Array.isArray(body.generatedClips)
        ? body.generatedClips
        : project.voice.generatedClips || [];

      if (inputClips.length > 0) {
        const plan = buildTimelineSyncPlan({
          captions: project.captions,
          measuredClips: inputClips.map((c) => ({
            segmentId: c.segmentId,
            start: c.start,
            end: c.end,
            duration: c.duration || Math.max(0.2, c.end - c.start),
            speechDuration: c.speechDuration,
            leadingSilence: c.leadingSilence,
            trailingSilence: c.trailingSilence,
          })),
          originalVideoDuration: project.metadata.duration,
          syncMode,
          continuousPauseMs,
        });
        const syncedClips = applySyncPlanToClips(inputClips, plan);
        const updated = await updateProject(db, project.id, {
          voice: {
            ...project.voice,
            syncMode,
            continuousPauseMs,
            speakingSpeed: 1.0,
            generatedClips: syncedClips,
            ...(body.fullDubUrl ? { fullDubUrl: body.fullDubUrl } : {}),
            syncPlan: plan,
          },
        });
        return jsonResponse({ project: updated, syncPlan: plan }, 200, request);
      }

      const updated = await updateProject(db, project.id, {
        voice: {
          ...project.voice,
          syncMode,
          continuousPauseMs,
          syncPlan: project.voice.syncPlan
            ? { ...project.voice.syncPlan, syncMode, pauseDurationMs: continuousPauseMs }
            : undefined,
        },
      });
      return jsonResponse({ project: updated }, 200, request);
    }

    params = matchPath('/api/projects/:id/dubbing/diagnostic', pathname);
    if (method === 'GET' && params) {
      const db = requireDb(env);
      const project = await getProject(db, params.id);
      if (!project) return errorJson('Project not found', 404, request);
      const measuredClips = (project.voice.generatedClips || []).map((c) => ({
        segmentId: c.segmentId,
        start: c.start,
        end: c.end,
        duration: c.duration || Math.max(0.2, c.end - c.start),
        speechDuration: c.speechDuration,
        leadingSilence: c.leadingSilence,
        trailingSilence: c.trailingSilence,
      }));
      const report = auditProjectNarration(project.captions, measuredClips);
      return jsonResponse({ report, fullTrackAudit: null }, 200, request);
    }

    params = matchPath('/api/projects/:id/dubbing/rebuild-track', pathname);
    if (method === 'POST' && params) {
      const db = requireDb(env);
      const project = await getProject(db, params.id);
      if (!project) return errorJson('Project not found', 404, request);
      const body = await readJsonBody<{
        generatedClips?: GeneratedVoiceClip[];
        fullDubUrl?: string;
        syncPlan?: Project['voice']['syncPlan'];
      }>(request);
      const clips = Array.isArray(body.generatedClips)
        ? body.generatedClips
        : project.voice.generatedClips || [];
      const updated = await updateProject(db, project.id, {
        voice: {
          ...project.voice,
          generatedClips: clips,
          ...(body.fullDubUrl ? { fullDubUrl: body.fullDubUrl } : {}),
          ...(body.syncPlan ? { syncPlan: body.syncPlan } : {}),
        },
      });
      return jsonResponse(
        {
          project: updated,
          fullDubUrl: updated?.voice.fullDubUrl || body.fullDubUrl || '',
          clips: updated?.voice.generatedClips || clips,
        },
        200,
        request
      );
    }

    // 11. Jobs CRUD (persisted in D1; supports browser-side job mirroring as well)
    params = matchPath('/api/projects/:id/jobs', pathname);
    if (method === 'GET' && params) {
      const db = requireDb(env);
      return jsonResponse({ jobs: await listProjectJobs(db, params.id) }, 200, request);
    }

    if (method === 'GET' && pathname === '/api/jobs') {
      const db = requireDb(env);
      return jsonResponse({ jobs: await listAllJobs(db) }, 200, request);
    }

    if (method === 'POST' && pathname === '/api/jobs') {
      const db = requireDb(env);
      const body = await readJsonBody<Record<string, unknown>>(request);
      if (!body.projectId || !body.type) {
        return errorJson('projectId and type are required.', 400, request);
      }
      const rawType = String(body.type || 'render');
      const jobType = (
        ['analysis', 'render', 'transcribe', 'translate', 'voice'].includes(rawType)
          ? rawType
          : rawType === 'dubbing'
          ? 'voice'
          : rawType === 'export'
          ? 'render'
          : 'render'
      ) as 'analysis' | 'render' | 'transcribe' | 'translate' | 'voice';
      const job = await createJob(db, {
        id: typeof body.id === 'string' && body.id ? body.id : crypto.randomUUID(),
        projectId: String(body.projectId),
        type: jobType,
        status: (body.status as 'queued' | 'processing' | 'completed' | 'failed') || 'processing',
        progress: Number(body.progress ?? 0),
        stage: String(body.stage || 'Starting'),
        etaSeconds: typeof body.etaSeconds === 'number' ? body.etaSeconds : null,
        outputUrl: typeof body.outputUrl === 'string' ? body.outputUrl : null,
        outputSize: typeof body.outputSize === 'number' ? body.outputSize : null,
        error: typeof body.error === 'string' ? body.error : null,
      });
      return jsonResponse({ job }, 201, request);
    }

    params = matchPath('/api/jobs/:jobId', pathname);
    if (method === 'GET' && params) {
      const db = requireDb(env);
      const job = await getJob(db, params.jobId);
      if (!job) return errorJson('Job not found', 404, request);
      return jsonResponse({ job }, 200, request);
    }

    if (method === 'PATCH' && params) {
      const db = requireDb(env);
      const body = await readJsonBody<Record<string, unknown>>(request);
      const job = await updateJob(db, params.jobId, body);
      if (!job) return errorJson('Job not found', 404, request);
      return jsonResponse({ job }, 200, request);
    }

    // Direct binary asset read helper check
    if (method === 'GET' && pathname === '/api/assets/read') {
      const targetUrl = url.searchParams.get('url') || '';
      const asset = targetUrl ? await readBinaryAssetBytes(env, targetUrl) : null;
      if (!asset) return errorJson('Asset not found', 404, request);
      return new Response(asset.bytes, {
        status: 200,
        headers: {
          ...corsHeaders(request),
          'Content-Type': asset.mimeType,
        },
      });
    }

    return errorJson(
      `API route ${method} ${pathname} is not available in Cloudflare Edge runtime. Heavy FFmpeg video operations execute directly in the browser.`,
      404,
      request,
      'ROUTE_NOT_FOUND'
    );
  } catch (err) {
    const status = getErrorStatus(err, 500);
    const code = getErrorCode(err, status === 503 ? 'SERVICE_UNAVAILABLE' : undefined);
    return errorJson(
      err instanceof Error ? err.message : String(err),
      status,
      request,
      code
    );
  }
};
