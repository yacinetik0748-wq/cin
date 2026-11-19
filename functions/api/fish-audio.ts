import {
  deleteSavedFishApiKey,
  getFishSettingsSummary,
  resolveFishApiKey,
  saveFishApiKey,
} from '../_lib/crypto.ts';
import {
  getSavedFishVoices,
  requireDb,
  saveSavedFishVoices,
} from '../_lib/d1.ts';
import {
  listFishVoices,
  synthesizeFishSpeech,
  testFishAudioConnection,
  validateFishVoiceId,
} from '../_lib/fish.ts';
import {
  corsHeaders,
  errorJson,
  jsonResponse,
  optionsResponse,
  readJsonBody,
} from '../_lib/http.ts';
import type { SavedFishVoice } from '../../src/types/studio.ts';
import type { Env } from '../_lib/types.ts';
import {
  DEFAULT_FISH_TTS_MODEL,
  normalizeAndValidateFishReferenceId,
  normalizeFishApiBaseUrl,
  normalizeFishApiKey,
  sanitizeFishErrorText,
} from '../../src/lib/fishReference.ts';

export const onRequest = async (context: {
  request: Request;
  env: Env;
}): Promise<Response> => {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return optionsResponse(request);
  }

  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, '');
  const method = request.method.toUpperCase();

  try {
    if (pathname.endsWith('/api/settings/fish-audio')) {
      if (method === 'GET') {
        return jsonResponse(await getFishSettingsSummary(env), 200, request);
      }
    }

    if (pathname.endsWith('/api/settings/fish-api-key')) {
      if (method === 'POST') {
        const body = await readJsonBody<{ apiKey?: string }>(request);
        const summary = await saveFishApiKey(
          env,
          typeof body.apiKey === 'string' ? body.apiKey : ''
        );
        return jsonResponse(summary, 200, request);
      }
      if (method === 'DELETE') {
        return jsonResponse(await deleteSavedFishApiKey(env), 200, request);
      }
    }

    if (pathname.endsWith('/api/settings/fish-api-key/test')) {
      if (method === 'POST') {
        const body = await readJsonBody<{ apiKey?: string }>(request).catch(() => ({}));
        const candidateKey =
          typeof (body as { apiKey?: unknown }).apiKey === 'string'
            ? String((body as { apiKey?: string }).apiKey)
            : undefined;
        return jsonResponse(await testFishAudioConnection(env, candidateKey), 200, request);
      }
    }

    if (pathname.endsWith('/api/fish/voices')) {
      if (method === 'GET') {
        const query = url.searchParams.get('q') || undefined;
        const selfOnly = url.searchParams.get('self') === 'true';
        const language = url.searchParams.get('language') || undefined;
        return jsonResponse(await listFishVoices(env, { query, selfOnly, language }), 200, request);
      }
    }

    if (pathname.endsWith('/api/fish/saved-voices')) {
      if (!env.DB) {
        return jsonResponse(
          {
            localOnly: true,
            storageMode: 'local-indexeddb',
            voices: [],
          },
          200,
          request
        );
      }
      const db = requireDb(env);
      if (method === 'GET') {
        return jsonResponse({ voices: await getSavedFishVoices(db) }, 200, request);
      }
      if (method === 'POST') {
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
          .map((v: SavedFishVoice) => (newVoice.isDefault ? { ...v, isDefault: false } : v))
          .concat(newVoice);
        await saveSavedFishVoices(db, next);
        return jsonResponse({ voice: newVoice, voices: next, validationMessage }, 201, request);
      }
    }

    if (pathname.endsWith('/api/fish/saved-voices/validate')) {
      if (method === 'POST') {
        const body = await readJsonBody<{ voiceId?: string }>(request);
        return jsonResponse(await validateFishVoiceId(env, String(body.voiceId || '')), 200, request);
      }
    }

    if (pathname.endsWith('/api/fish/saved-voices/preview')) {
      if (method === 'POST') {
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
    }

    if (pathname.endsWith('/api/fish/proxy/tts') && method === 'POST') {
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

    if (pathname.endsWith('/api/fish/proxy/asr') && method === 'POST') {
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

    return errorJson('Fish Audio API endpoint not found', 404, request);
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    return errorJson(err instanceof Error ? err.message : String(err), status, request);
  }
};
