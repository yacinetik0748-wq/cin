import {
  CaptionSegment,
  GeneratedVoiceClip,
  Project,
  RenderJob,
  SyncMode,
} from '../types/studio';
import {
  buildTimelineSyncPlan,
  applySyncPlanToClips,
  clampContinuousPauseMs,
  normalizeSyncMode,
} from '../../server/services/timeline_sync_service';
import { idbGet, idbSet, retrieveProjectVideoBlob, storeBlobAsset } from './browserStorage';
import { resolveMediaBlob } from './clientMediaEngine';
import { localProjectService } from './localProjectService';
import { distributeWordsEvenly } from './workflowStages';
import {
  DEFAULT_FISH_API_BASE,
  DEFAULT_FISH_TTS_MODEL,
  normalizeAndValidateFishReferenceId,
  normalizeFishApiKey,
  sanitizeFishErrorText,
} from './fishReference';
import { recordFishAuthStatus } from './fishAudioKeyManager';

function resolveProxyUrl(path: string): string {
  const base = (
    (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_BASE_URL) ||
    ''
  ).replace(/\/+$/, '');
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return base ? `${base}${cleanPath}` : cleanPath;
}

const SAFE_DIAGNOSTIC_HEADERS = [
  'server',
  'x-vercel-id',
  'cf-ray',
  'x-fish-proxy',
  'x-fish-upstream-url',
  'x-fish-response-url',
  'content-type',
] as const;

function collectSafeHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of SAFE_DIAGNOSTIC_HEADERS) {
    const val = headers.get(name);
    if (val) out[name] = val;
  }
  return out;
}

export async function ensureLocalProject(projectId: string): Promise<Project> {
  const local = await localProjectService.getProject(projectId);
  if (local) return local;
  throw new Error('Project not found in local IndexedDB storage.');
}

async function syncProjectRemoteBestEffort(
  projectId: string,
  patch: Partial<Pick<Project, 'captions' | 'translation' | 'voice' | 'workflow'>>
): Promise<void> {
  try {
    await localProjectService.updateProject(projectId, patch);
  } catch {
    // IndexedDB is the single local source of truth
  }
}

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

function hasSpeakableText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

function mapIsoToLanguageName(code?: string): string | null {
  if (!code) return null;
  const clean = code.toLowerCase().slice(0, 2);
  for (const [name, iso] of Object.entries(LANGUAGE_TO_ISO)) {
    if (iso === clean) return name;
  }
  return code;
}

async function measureAudioBlobDuration(blob: Blob, textFallback: string): Promise<number> {
  let audioCtx: AudioContext | null = null;
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
      const buf = await blob.arrayBuffer();
      const decoded = await audioCtx.decodeAudioData(buf);
      if (decoded.duration > 0.05) {
        return Math.round(decoded.duration * 100) / 100;
      }
    }
  } catch {
    // Fallback to HTMLAudioElement
  } finally {
    if (audioCtx && audioCtx.state !== 'closed') {
      await audioCtx.close().catch(() => {});
    }
  }

  if (typeof Audio === 'undefined' || typeof URL?.createObjectURL !== 'function') {
    const words = textFallback.trim().split(/\s+/).filter(Boolean).length;
    return Math.max(0.5, Number((words / 2.8).toFixed(2)));
  }

  return new Promise<number>((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio();
    const done = (dur: number) => {
      URL.revokeObjectURL(url);
      resolve(dur);
    };
    const timer = setTimeout(() => {
      const words = textFallback.trim().split(/\s+/).filter(Boolean).length;
      done(Math.max(0.5, Number((words / 2.8).toFixed(2))));
    }, 2500);
    audio.onloadedmetadata = () => {
      clearTimeout(timer);
      done(Number.isFinite(audio.duration) && audio.duration > 0.05 ? Math.round(audio.duration * 100) / 100 : 1.5);
    };
    audio.onerror = () => {
      clearTimeout(timer);
      const words = textFallback.trim().split(/\s+/).filter(Boolean).length;
      done(Math.max(0.5, Number((words / 2.8).toFixed(2))));
    };
    audio.src = url;
  });
}

function encodeWavFromAudioBuffer(buffer: AudioBuffer): Blob {
  const numChannels = Math.min(2, buffer.numberOfChannels || 1);
  const sampleRate = buffer.sampleRate;
  const length = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = length * blockAlign;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) {
    channels.push(buffer.getChannelData(c));
  }

  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([ab], { type: 'audio/wav' });
}

export async function buildMergedDubBlobUrl(
  items: Array<{ audioUrl: string; startSec: number }>,
  totalDurationSec: number
): Promise<string | null> {
  if (items.length === 0) return null;
  if (items.length === 1 && items[0].startSec <= 0.1) {
    if (items[0].audioUrl.startsWith('idb://blobs/')) {
      return items[0].audioUrl;
    }
    try {
      const singleBlob = await resolveMediaBlob(items[0].audioUrl);
      const singleKey = `fish_full_dub_${Date.now()}.mp3`;
      await storeBlobAsset(singleKey, singleBlob);
      return `idb://blobs/${singleKey}`;
    } catch {
      return items[0].audioUrl;
    }
  }

  const OfflineCtx =
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

  if (!OfflineCtx || !AudioCtx) {
    return items[0].audioUrl;
  }

  const sampleRate = 44100;
  const totalFrames = Math.max(sampleRate, Math.ceil(Math.max(1, totalDurationSec) * sampleRate));
  const offline = new OfflineCtx(2, totalFrames, sampleRate);
  const decodeCtx = new AudioCtx();
  let decodedCount = 0;

  try {
    for (const item of items) {
      try {
        const blob = await resolveMediaBlob(item.audioUrl);
        const ab = await blob.arrayBuffer();
        const decoded = await decodeCtx.decodeAudioData(ab.slice(0));
        const src = offline.createBufferSource();
        src.buffer = decoded;
        src.connect(offline.destination);
        src.start(Math.max(0, item.startSec));
        decodedCount += 1;
      } catch {
        // skip undecodable segment clip
      }
    }
    if (decodedCount === 0) {
      throw new Error('None of the generated voiceover clips could be decoded to build the narration track.');
    }
    const rendered = await offline.startRendering();
    const wavBlob = encodeWavFromAudioBuffer(rendered);
    const fullKey = `fish_full_dub_${Date.now()}.wav`;
    await storeBlobAsset(fullKey, wavBlob);
    return `idb://blobs/${fullKey}`;
  } catch (err) {
    if (decodedCount === 0) throw err;
    return items[0].audioUrl;
  } finally {
    await decodeCtx.close().catch(() => {});
  }
}

async function buildFishTts404Error(params: {
  requestUrl: string;
  responseUrl: string;
  headers: Record<string, string>;
  resText: string;
  parsed: Record<string, unknown> | null;
  apiKey: string;
  referenceId?: string;
}): Promise<Error> {
  const { requestUrl, responseUrl, headers, resText, parsed, apiKey, referenceId } = params;
  const rawBody = sanitizeFishErrorText(
    (typeof parsed?.rawBody === 'string' && parsed.rawBody) ||
      (typeof parsed?.message === 'string' && parsed.message) ||
      (typeof parsed?.error === 'string' && parsed.error) ||
      resText ||
      'No response body returned.'
  );
  const code = typeof parsed?.code === 'string' ? parsed.code : '';
  const errorCode = typeof parsed?.errorCode === 'string' ? parsed.errorCode : '';
  const upstreamEndpoint =
    (typeof parsed?.endpoint === 'string' && parsed.endpoint) ||
    headers['x-fish-upstream-url'] ||
    `${DEFAULT_FISH_API_BASE}/v1/tts`;
  const upstreamResponseUrl =
    (typeof parsed?.responseUrl === 'string' && parsed.responseUrl) ||
    headers['x-fish-response-url'] ||
    upstreamEndpoint;
  const lower = `${code} ${errorCode} ${rawBody}`.toLowerCase();

  const hasFishProxyHeader = Boolean(headers['x-fish-proxy']);
  const reachedFishUpstream =
    hasFishProxyHeader ||
    (typeof parsed?.endpoint === 'string' && parsed.endpoint.includes('api.fish.audio'));

  const isVercelEdge404 =
    !reachedFishUpstream &&
    (Boolean(headers['x-vercel-id']) ||
      lower.includes('the page could not be found') ||
      lower.includes('not_found') ||
      /\b[a-z]{3}[0-9]::[a-z0-9-]+/i.test(rawBody));

  if (isVercelEdge404) {
    const vercelHint = headers['x-vercel-id'] || 'Vercel Edge';
    return new Error(
      `Fish Audio TTS failed (HTTP 404 · Vercel Edge / Proxy Route Not Found): Request to "${requestUrl}" (response URL: "${responseUrl}") returned a ${vercelHint} 404 and did NOT reach ${DEFAULT_FISH_API_BASE}/v1/tts. Deploy /api/fish/proxy/tts on Vercel or deploy the Cloudflare Pages Functions /functions directory. Response body: ${rawBody}`
    );
  }

  if (
    !reachedFishUpstream ||
    code === 'ROUTE_NOT_FOUND' ||
    lower.includes('is not available in cloudflare edge runtime') ||
    lower.includes('<!doctype html') ||
    lower.includes('<html')
  ) {
    return new Error(
      `Fish Audio TTS failed (HTTP 404 · Proxy / Hosting Route Not Found): Request to "${requestUrl}" (response URL: "${responseUrl}") did NOT reach ${DEFAULT_FISH_API_BASE}/v1/tts. Verify that /api/fish/proxy/tts is served by your hosting runtime. Response body: ${rawBody}`
    );
  }

  // Request reached Fish Audio upstream (https://api.fish.audio/v1/tts)
  if (errorCode === 'no_route' || lower.includes('no route serves this path')) {
    return new Error(
      `Fish Audio TTS failed (HTTP 404 · Incorrect TTS endpoint): Upstream ${upstreamEndpoint} (response URL: ${upstreamResponseUrl}) returned no_route. Response body: ${rawBody}`
    );
  }

  // Distinguish invalid/inaccessible reference_id vs Fish Audio resource 404
  if (referenceId) {
    try {
      const modelCheck = await fetch(
        `${DEFAULT_FISH_API_BASE}/model/${encodeURIComponent(referenceId)}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
        }
      );
      if (modelCheck.status === 404 || modelCheck.status === 400 || modelCheck.status === 422) {
        return new Error(
          `Fish Audio TTS failed (HTTP 404 · Invalid or inaccessible reference_id "${referenceId}"): No accessible voice model exists for this ID. Response body: ${rawBody}`
        );
      }
      if (modelCheck.status === 403) {
        return new Error(
          `Fish Audio TTS failed (HTTP 404 · Inaccessible reference_id "${referenceId}"): This private voice model cannot be accessed by your account. Response body: ${rawBody}`
        );
      }
    } catch {
      // Fall back to response body inspection below
    }

    if (
      lower.includes('reference') ||
      lower.includes('voice') ||
      lower.includes('speaker') ||
      lower.includes('not found')
    ) {
      return new Error(
        `Fish Audio TTS failed (HTTP 404 · Invalid or inaccessible reference_id "${referenceId}"): Upstream ${upstreamEndpoint} returned 404. Response body: ${rawBody}`
      );
    }
  }

  return new Error(
    `Fish Audio TTS failed (HTTP 404 · Fish Audio resource not found): Upstream ${upstreamEndpoint} (response URL: ${upstreamResponseUrl}) with model "${DEFAULT_FISH_TTS_MODEL}" returned HTTP 404. Response body: ${rawBody}`
  );
}

export async function synthesizeFishTtsViaProxy(
  apiKey: string,
  params: { text: string; referenceId?: string }
): Promise<{ blob: Blob; durationSec: number }> {
  const cleanKey = normalizeFishApiKey(apiKey);
  if (!cleanKey) {
    throw new Error('Fish Audio API key is not configured. Add your key in Settings first.');
  }
  const text = params.text.trim();
  if (!text) {
    throw new Error('Preview text cannot be empty.');
  }

  const validReferenceId = normalizeAndValidateFishReferenceId(params.referenceId);

  const body: Record<string, unknown> = {
    text,
    format: 'mp3',
  };
  if (validReferenceId) {
    body.reference_id = validReferenceId;
  }

  const sameOriginPath = '/api/fish/proxy/tts';
  const primaryRequestUrl = resolveProxyUrl(sameOriginPath);
  const expectedUpstreamUrl = `${DEFAULT_FISH_API_BASE}/v1/tts`;

  const doTtsFetch = (url: string) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Fish-Api-Key': cleanKey,
        model: DEFAULT_FISH_TTS_MODEL,
      },
      body: JSON.stringify(body),
    });

  console.info('[Fish TTS] Sending request', {
    requestUrl: primaryRequestUrl,
    upstreamEndpoint: expectedUpstreamUrl,
    model: DEFAULT_FISH_TTS_MODEL,
    hasReferenceId: Boolean(validReferenceId),
  });

  let activeRequestUrl = primaryRequestUrl;
  let res = await doTtsFetch(primaryRequestUrl);

  // If VITE_API_BASE_URL redirected to another domain and that domain returned a host 404 (no X-Fish-Proxy),
  // retry same-origin /api/fish/proxy/tts once.
  if (res.status === 404 && primaryRequestUrl !== sameOriginPath && !res.headers.get('x-fish-proxy')) {
    console.warn('[Fish TTS] Configured API base returned 404 without Fish proxy header; retrying same-origin proxy', {
      failedUrl: primaryRequestUrl,
      fallbackUrl: sameOriginPath,
    });
    activeRequestUrl = sameOriginPath;
    res = await doTtsFetch(sameOriginPath);
  }

  const safeHeaders = collectSafeHeaders(res.headers);
  const responseUrl = res.url || activeRequestUrl;

  if (!res.ok) {
    const resText = await res.text().catch(() => '');
    const sanitizedBody = sanitizeFishErrorText(resText, cleanKey);
    console.warn('[Fish TTS] Error response', {
      requestUrl: activeRequestUrl,
      responseUrl,
      status: res.status,
      headers: safeHeaders,
      body: sanitizedBody,
    });

    let parsed: Record<string, unknown> | null = null;
    if (resText) {
      try {
        parsed = JSON.parse(resText) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }

    if (res.status === 404) {
      throw await buildFishTts404Error({
        requestUrl: activeRequestUrl,
        responseUrl,
        headers: safeHeaders,
        resText,
        parsed,
        apiKey: cleanKey,
        referenceId: validReferenceId,
      });
    }

    if (res.status === 401 || res.status === 403) {
      const detail = sanitizeFishErrorText(
        (typeof parsed?.error === 'string' && parsed.error) ||
          (typeof parsed?.message === 'string' && parsed.message) ||
          resText,
        cleanKey
      );
      const authErrMsg = `Fish Audio authentication failed (HTTP ${res.status}): ${
        detail || 'Invalid Token'
      }. Please generate a new API key from Fish Audio, then open Settings and click Clear & Re-enter API Key.`;
      await recordFishAuthStatus('error', authErrMsg);
      throw new Error(authErrMsg);
    }

    const rawErr = sanitizeFishErrorText(
      (typeof parsed?.error === 'string' && parsed.error) ||
        (typeof parsed?.message === 'string' && parsed.message) ||
        resText ||
        `Fish Audio TTS request failed (HTTP ${res.status}).`,
      cleanKey
    );
    throw new Error(rawErr || `Fish Audio TTS request failed (HTTP ${res.status}).`);
  }

  console.info('[Fish TTS] Response OK', {
    requestUrl: activeRequestUrl,
    responseUrl,
    status: res.status,
    headers: safeHeaders,
  });

  const contentType = (res.headers.get('content-type') || 'audio/mpeg').toLowerCase();
  const audioBuffer = await res.arrayBuffer();
  if (contentType.includes('text/html') || contentType.includes('application/json')) {
    const snippet = sanitizeFishErrorText(
      new TextDecoder().decode(audioBuffer.slice(0, 400)),
      cleanKey
    );
    throw new Error(
      `Fish Audio TTS proxy returned non-audio content (${contentType}): ${snippet || 'Unexpected response'}`
    );
  }
  const blob = new Blob([audioBuffer], {
    type: contentType.startsWith('audio/') ? contentType : 'audio/mpeg',
  });
  if (blob.size < 128) {
    throw new Error('Fish Audio TTS returned an empty audio stream.');
  }

  await recordFishAuthStatus('connected', null);
  const durationSec = await measureAudioBlobDuration(blob, text);
  return { blob, durationSec };
}

export async function previewFishTtsViaProxy(
  apiKey: string,
  params: { text: string; referenceId?: string }
): Promise<{ audioUrl: string }> {
  const { blob } = await synthesizeFishTtsViaProxy(apiKey, params);
  const audioUrl = URL.createObjectURL(blob);
  return { audioUrl };
}

export async function transcribeWithFishViaProxy(
  apiKey: string,
  projectId: string,
  sourceLanguage?: string
): Promise<{ project: Project; detectedLanguage: string; segmentCount: number }> {
  const project = await ensureLocalProject(projectId);
  if (!project.sourceVideoUrl && !project.sourceVideoBlobKey) {
    throw new Error('Upload a video before running Fish Audio transcription.');
  }

  let mediaBlob: Blob | null = null;
  const retrieved = await retrieveProjectVideoBlob(project).catch(() => null);
  if (retrieved?.blob && retrieved.blob.size > 0) {
    mediaBlob = retrieved.blob;
  } else if (project.sourceVideoUrl) {
    const mediaRes = await fetch(project.sourceVideoUrl);
    if (mediaRes.ok) {
      mediaBlob = await mediaRes.blob();
    }
  }
  if (!mediaBlob || mediaBlob.size === 0) {
    throw new Error('Unable to read project video media for transcription.');
  }
  if (mediaBlob.size > 50 * 1024 * 1024) {
    throw new Error(
      'Video exceeds 50 MB for direct browser ASR proxy upload. Compress the video or import an SRT/VTT transcript.'
    );
  }

  const isoLang =
    sourceLanguage && sourceLanguage !== 'Auto' ? LANGUAGE_TO_ISO[sourceLanguage] : undefined;

  const formData = new FormData();
  formData.append('audio', mediaBlob, project.sourceFilename || 'media.mp4');
  formData.append('ignore_timestamps', 'false');
  if (isoLang) formData.append('language', isoLang);

  const cleanAsrKey = normalizeFishApiKey(apiKey);
  if (!cleanAsrKey) {
    throw new Error('Fish Audio API key is not configured. Add your key in Settings first.');
  }

  const res = await fetch(resolveProxyUrl('/api/fish/proxy/asr'), {
    method: 'POST',
    headers: {
      'X-Fish-Api-Key': cleanAsrKey,
    },
    body: formData,
  });

  if (!res.ok) {
    const errPayload = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(errPayload?.error || `Fish Audio ASR failed (HTTP ${res.status}).`);
  }

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

  const totalDur = Math.max(0.5, Number(data.duration) || project.metadata?.duration || 10);
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
    throw new Error('Fish Audio ASR returned no spoken segments for this media.');
  }

  const detectedLanguage =
    sourceLanguage && sourceLanguage !== 'Auto'
      ? sourceLanguage
      : mapIsoToLanguageName(data.language) || 'Auto';

  const updated: Project = {
    ...project,
    captions: segments,
    translation: {
      ...project.translation,
      sourceLanguage: detectedLanguage,
    },
    updatedAt: new Date().toISOString(),
  };
  await idbSet('projects', project.id, updated);
  await syncProjectRemoteBestEffort(project.id, {
    captions: updated.captions,
    translation: updated.translation,
  });

  return {
    project: updated,
    detectedLanguage,
    segmentCount: segments.length,
  };
}

export async function startBrowserFishDubJob(
  apiKey: string,
  projectId: string,
  params: { voice: Project['voice']; captions?: CaptionSegment[]; useTranslated?: boolean }
): Promise<{ job: RenderJob }> {
  const project = await ensureLocalProject(projectId);

  const captions = params.captions && params.captions.length > 0 ? params.captions : project.captions;
  const useTranslated = params.useTranslated ?? true;

  const workItems = captions
    .map((seg) => {
      const spokenText = (useTranslated && seg.translatedText ? seg.translatedText : seg.text).trim();
      return { seg, spokenText };
    })
    .filter((item) => item.spokenText.length > 0 && hasSpeakableText(item.spokenText));

  if (workItems.length === 0) {
    throw new Error('No speakable transcript or translation segments found.');
  }

  const now = new Date().toISOString();
  const job: RenderJob = {
    id: crypto.randomUUID(),
    projectId,
    type: 'voice',
    status: 'processing',
    progress: 4,
    stage: `Synthesizing 0/${workItems.length} segments via Fish Audio...`,
    etaSeconds: null,
    outputUrl: null,
    outputSize: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  await idbSet('jobs', job.id, job);

  void (async () => {
    try {
      const clips: GeneratedVoiceClip[] = [];
      const refId = params.voice.fishReferenceId?.trim() || undefined;

      for (let i = 0; i < workItems.length; i++) {
        const { seg, spokenText } = workItems[i];
        const { blob, durationSec } = await synthesizeFishTtsViaProxy(apiKey, {
          text: spokenText,
          referenceId: refId,
        });
        const segKey = `fish_seg_${projectId}_${seg.id}_${Date.now()}.mp3`;
        await storeBlobAsset(segKey, blob);
        const clipUrl = `idb://blobs/${segKey}`;
        const slotDur = Math.max(0.2, seg.end - seg.start);
        clips.push({
          segmentId: seg.id,
          audioUrl: clipUrl,
          start: seg.start,
          end: seg.end,
          duration: durationSec,
          speechDuration: durationSec,
          leadingSilence: 0,
          trailingSilence: 0,
          slotDuration: Math.round(slotDur * 100) / 100,
          overflowSeconds:
            durationSec > slotDur + 0.15 ? Math.round((durationSec - slotDur) * 100) / 100 : 0,
          text: spokenText,
          speaker: seg.speaker,
        });

        await idbSet('jobs', job.id, {
          ...job,
          progress: Math.min(88, Math.round(5 + ((i + 1) / workItems.length) * 80)),
          stage: `Synthesizing voiceover (${i + 1}/${workItems.length})...`,
          updatedAt: new Date().toISOString(),
        });
      }

      const syncMode: SyncMode = normalizeSyncMode(params.voice.syncMode);
      const continuousPauseMs = clampContinuousPauseMs(params.voice.continuousPauseMs);
      const origDur = project.metadata?.duration || 10;
      const syncPlan = buildTimelineSyncPlan({
        captions,
        measuredClips: clips.map((c) => ({
          segmentId: c.segmentId,
          start: c.start,
          end: c.end,
          duration: c.duration,
          speechDuration: c.speechDuration,
          leadingSilence: c.leadingSilence,
          trailingSilence: c.trailingSilence,
        })),
        originalVideoDuration: origDur,
        syncMode,
        continuousPauseMs,
      });

      const syncedClips = applySyncPlanToClips(clips, syncPlan);

      await idbSet('jobs', job.id, {
        ...job,
        progress: 92,
        stage: 'Building synchronized narration track...',
        updatedAt: new Date().toISOString(),
      });

      const fullDubUrl = await buildMergedDubBlobUrl(
        syncedClips.map((c) => ({ audioUrl: c.audioUrl, startSec: c.start })),
        syncPlan.estimatedFinalDuration
      );

      const latestProject = (await idbGet<Project>('projects', projectId)) || project;
      const updatedProject: Project = {
        ...latestProject,
        captions,
        voice: {
          ...latestProject.voice,
          ...params.voice,
          provider: 'fish',
          enabled: true,
          speakingSpeed: Number(params.voice.speakingSpeed || 1.0),
          syncMode,
          continuousPauseMs,
          generatedClips: syncedClips,
          fullDubUrl: fullDubUrl || undefined,
          syncPlan,
        },
        translation: {
          ...latestProject.translation,
          pendingRegenerateSegmentIds: [],
        },
        updatedAt: new Date().toISOString(),
      };
      await idbSet('projects', projectId, updatedProject);
      await syncProjectRemoteBestEffort(projectId, {
        captions: updatedProject.captions,
        voice: updatedProject.voice,
        translation: updatedProject.translation,
      });

      await idbSet('jobs', job.id, {
        ...job,
        status: 'completed',
        progress: 100,
        stage: `Generated ${syncedClips.length} narration clip(s).`,
        outputUrl: fullDubUrl,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      await idbSet('jobs', job.id, {
        ...job,
        status: 'failed',
        progress: 0,
        stage: 'Failed',
        error: err instanceof Error ? err.message : String(err),
        updatedAt: new Date().toISOString(),
      });
    }
  })();

  return { job };
}

export async function regenerateFishSegmentsInBrowser(
  apiKey: string,
  projectId: string,
  params: {
    segmentIds: string[];
    captions?: CaptionSegment[];
    voice?: Partial<Project['voice']>;
    useTranslated?: boolean;
  }
): Promise<{ project: Project; regeneratedIds: string[]; fullDubUrl: string }> {
  const project = await ensureLocalProject(projectId);

  const captions = params.captions && params.captions.length > 0 ? params.captions : project.captions;
  const mergedVoice = { ...project.voice, ...(params.voice || {}), provider: 'fish' as const };
  const useTranslated = params.useTranslated ?? true;
  const refId = mergedVoice.fishReferenceId?.trim() || undefined;

  const existingClips = new Map((mergedVoice.generatedClips || []).map((c) => [c.segmentId, c]));
  const regeneratedIds: string[] = [];

  for (const segId of params.segmentIds) {
    const seg = captions.find((c) => c.id === segId);
    if (!seg) continue;
    const spokenText = (useTranslated && seg.translatedText ? seg.translatedText : seg.text).trim();
    if (!spokenText || !hasSpeakableText(spokenText)) continue;

    const { blob, durationSec } = await synthesizeFishTtsViaProxy(apiKey, {
      text: spokenText,
      referenceId: refId,
    });
    const segKey = `fish_seg_${projectId}_${seg.id}_${Date.now()}.mp3`;
    await storeBlobAsset(segKey, blob);
    const clipUrl = `idb://blobs/${segKey}`;
    const slotDur = Math.max(0.2, seg.end - seg.start);
    existingClips.set(seg.id, {
      segmentId: seg.id,
      audioUrl: clipUrl,
      start: seg.start,
      end: seg.end,
      duration: durationSec,
      speechDuration: durationSec,
      leadingSilence: 0,
      trailingSilence: 0,
      slotDuration: Math.round(slotDur * 100) / 100,
      overflowSeconds:
        durationSec > slotDur + 0.15 ? Math.round((durationSec - slotDur) * 100) / 100 : 0,
      text: spokenText,
      speaker: seg.speaker,
    });
    regeneratedIds.push(seg.id);
  }

  const orderedRawClips = captions
    .map((c) => existingClips.get(c.id))
    .filter((c): c is GeneratedVoiceClip => Boolean(c));

  const syncMode: SyncMode = normalizeSyncMode(mergedVoice.syncMode);
  const continuousPauseMs = clampContinuousPauseMs(mergedVoice.continuousPauseMs);
  const origDur = project.metadata?.duration || 10;
  const syncPlan = buildTimelineSyncPlan({
    captions,
    measuredClips: orderedRawClips.map((c) => ({
      segmentId: c.segmentId,
      start: c.start,
      end: c.end,
      duration: c.duration,
      speechDuration: c.speechDuration,
      leadingSilence: c.leadingSilence,
      trailingSilence: c.trailingSilence,
    })),
    originalVideoDuration: origDur,
    syncMode,
    continuousPauseMs,
  });

  const syncedClips = applySyncPlanToClips(orderedRawClips, syncPlan);
  const fullDubUrl =
    (await buildMergedDubBlobUrl(
      syncedClips.map((c) => ({ audioUrl: c.audioUrl, startSec: c.start })),
      syncPlan.estimatedFinalDuration
    )) || '';

  const pending = (project.translation.pendingRegenerateSegmentIds || []).filter(
    (id) => !regeneratedIds.includes(id)
  );

  const updatedProject: Project = {
    ...project,
    captions,
    voice: {
      ...mergedVoice,
      enabled: true,
      syncMode,
      continuousPauseMs,
      generatedClips: syncedClips,
      fullDubUrl: fullDubUrl || mergedVoice.fullDubUrl,
      syncPlan,
    },
    translation: {
      ...project.translation,
      pendingRegenerateSegmentIds: pending,
    },
    updatedAt: new Date().toISOString(),
  };
  await idbSet('projects', projectId, updatedProject);
  await syncProjectRemoteBestEffort(projectId, {
    captions: updatedProject.captions,
    voice: updatedProject.voice,
    translation: updatedProject.translation,
  });

  return {
    project: updatedProject,
    regeneratedIds,
    fullDubUrl: updatedProject.voice.fullDubUrl || '',
  };
}
