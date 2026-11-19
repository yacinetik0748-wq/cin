import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import {
  CaptionSegment,
  FishVoiceModel,
  GeneratedVoiceClip,
  NarrationAuditReport,
  Project,
  RenderJob,
  SegmentGapDiagnostic,
  SyncMode,
  TimelineSyncPlan,
  VoiceConfig,
} from '../../src/types/studio.ts';
import {
  AUDIO_DIR,
  TEMP_DIR,
  createJob,
  getAssetByUrl,
  getJob,
  getProject,
  registerAsset,
  updateJob,
  updateProject,
} from '../db.ts';
import {
  analyzeAudioFileSilence,
  diagnoseFullNarrationTrackSilences,
  trimAudioEdgeSilenceSafely,
} from './audio_silence_service.ts';
import { distributeWordsEvenly } from './transcription_service.ts';
import {
  applySyncPlanToClips,
  auditProjectNarration,
  buildTimelineSyncPlan,
  clampContinuousPauseMs,
  normalizeSyncMode,
} from './timeline_sync_service.ts';
import {
  FishAudioSettingsSummary,
  FishConnectionStatus,
  getFishSettingsSummary,
  resolveFishApiKey,
  setFishConnectionMeta,
} from './secrets_service.ts';
import {
  DEFAULT_FISH_TTS_MODEL,
  normalizeAndValidateFishReferenceId,
  normalizeFishApiBaseUrl,
} from '../../src/lib/fishReference.ts';

const execFileAsync = promisify(execFile);

const FISH_API_BASE = normalizeFishApiBaseUrl(process.env.FISH_API_BASE_URL);

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isFishAudioConfigured(): boolean {
  return Boolean(resolveFishApiKey().apiKey);
}

function getFishApiKey(): string {
  const { apiKey } = resolveFishApiKey();
  if (!apiKey) {
    const err = new Error(
      'Fish Audio API key is not configured. Open Settings → Fish Audio API Settings to add and save your key.'
    );
    (err as Error & { statusCode?: number }).statusCode = 503;
    throw err;
  }
  return apiKey;
}

export async function testFishAudioConnection(candidateKey?: string): Promise<{
  ok: boolean;
  connectionStatus: FishConnectionStatus;
  message: string;
  settings: FishAudioSettingsSummary;
}> {
  const testingUnsavedCandidate = Boolean(candidateKey && candidateKey.trim());
  const keyToUse = testingUnsavedCandidate
    ? candidateKey!.trim()
    : resolveFishApiKey().apiKey;

  if (!keyToUse || keyToUse === 'MY_FISH_API_KEY') {
    if (!testingUnsavedCandidate) {
      setFishConnectionMeta({
        connectionStatus: 'not_connected',
        lastCheckedAt: new Date().toISOString(),
        lastError: 'No Fish Audio API key configured.',
      });
    }
    return {
      ok: false,
      connectionStatus: 'not_connected',
      message: 'No Fish Audio API key is saved yet.',
      settings: getFishSettingsSummary(),
    };
  }

  try {
    const res = await fetchFishWithTimeout(
      '/wallet/self/api-credit',
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${keyToUse}`,
        },
      },
      12000
    );
    const data = (await res.json().catch(() => ({}))) as { credit?: number | string };
    const checkedAt = new Date().toISOString();
    if (!testingUnsavedCandidate) {
      setFishConnectionMeta({
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
      settings: getFishSettingsSummary(),
    };
  } catch (err) {
    const status = (err as { statusCode?: number })?.statusCode;
    const rawMsg = err instanceof Error ? err.message : 'Unable to reach Fish Audio API.';
    const message =
      status === 401 || status === 403
        ? 'Authentication failed: invalid or expired Fish Audio API key.'
        : rawMsg;
    if (!testingUnsavedCandidate) {
      setFishConnectionMeta({
        connectionStatus: 'error',
        lastCheckedAt: new Date().toISOString(),
        lastError: message,
      });
    }
    return {
      ok: false,
      connectionStatus: 'error',
      message,
      settings: getFishSettingsSummary(),
    };
  }
}

async function fetchFishWithTimeout(
  endpointPath: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${FISH_API_BASE}${endpointPath}`, {
      ...init,
      signal: controller.signal,
    });

    if (!res.ok) {
      const rawText = await res.text().catch(() => '');
      let message = `Fish Audio API error (${res.status})`;
      try {
        const parsed = JSON.parse(rawText) as { message?: string; detail?: string; error?: string };
        message = parsed.message || parsed.detail || parsed.error || message;
      } catch {
        if (rawText.trim()) {
          message = `${message}: ${rawText.trim().slice(0, 220)}`;
        }
      }
      const err = new Error(message) as Error & { statusCode?: number; retryAfterMs?: number };
      err.statusCode = res.status >= 400 && res.status < 500 ? res.status : 502;
      const retryAfter = res.headers.get('retry-after');
      if (retryAfter) {
        const sec = Number(retryAfter);
        if (Number.isFinite(sec) && sec > 0) {
          err.retryAfterMs = Math.min(15000, Math.round(sec * 1000));
        }
      }
      throw err;
    }

    return res;
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      const timeoutErr = new Error(
        `Fish Audio API request timed out after ${Math.round(timeoutMs / 1000)}s.`
      ) as Error & { statusCode?: number };
      timeoutErr.statusCode = 504;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function isRetryableFishError(err: unknown): boolean {
  const status = (err as { statusCode?: number })?.statusCode;
  if (status === 401 || status === 403 || status === 400 || status === 404 || status === 422) {
    return false;
  }
  // Retry 429 rate-limits, 5xx, timeouts (504), and network transport errors (no statusCode)
  return !status || status === 408 || status === 429 || status >= 500;
}

async function fetchFishWithRetry(
  endpointPath: string,
  buildInit: () => RequestInit,
  timeoutMs: number,
  maxAttempts = 3,
  baseDelayMs = 900
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchFishWithTimeout(endpointPath, buildInit(), timeoutMs);
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !isRetryableFishError(err)) {
        throw err;
      }
      const retryAfterMs = (err as { retryAfterMs?: number })?.retryAfterMs;
      const status = (err as { statusCode?: number })?.statusCode;
      const backoff =
        retryAfterMs ||
        Math.round(baseDelayMs * Math.pow(1.8, attempt - 1) * (status === 429 ? 2 : 1)) +
          Math.floor(Math.random() * 350);
      await sleep(Math.min(12000, backoff));
    }
  }
  throw lastErr;
}

export async function listFishVoices(params: {
  query?: string;
  selfOnly?: boolean;
  language?: string;
  pageSize?: number;
}): Promise<{ voices: FishVoiceModel[]; total: number }> {
  const apiKey = getFishApiKey();
  const qs = new URLSearchParams();
  qs.set('page_size', String(params.pageSize || 24));
  qs.set('sort_by', 'task_count');
  if (params.selfOnly) {
    qs.set('self', 'true');
  }
  if (params.query && params.query.trim()) {
    qs.set('title', params.query.trim());
  }
  if (params.language && LANGUAGE_TO_ISO[params.language]) {
    qs.set('language', LANGUAGE_TO_ISO[params.language]);
  }

  const res = await fetchFishWithRetry(
    `/model?${qs.toString()}`,
    () => ({
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    }),
    15000,
    2
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

export interface FishVoiceValidationResult {
  valid: boolean;
  checked: boolean;
  voiceId: string;
  title?: string;
  description?: string;
  languages?: string[];
  message: string;
}

export async function validateFishVoiceId(voiceId: string): Promise<FishVoiceValidationResult> {
  const cleanId = voiceId.trim();
  if (!cleanId) {
    const err = new Error('Fish Audio Voice ID cannot be empty.') as Error & { statusCode?: number };
    err.statusCode = 400;
    throw err;
  }
  if (/\s/.test(cleanId)) {
    const err = new Error('Fish Audio Voice ID cannot contain spaces.') as Error & { statusCode?: number };
    err.statusCode = 400;
    throw err;
  }
  if (!/^[a-zA-Z0-9_-]{4,128}$/.test(cleanId)) {
    const err = new Error(
      `Invalid Fish Audio Voice ID format "${cleanId}". Enter the exact alphanumeric model/reference ID from Fish Audio.`
    ) as Error & { statusCode?: number };
    err.statusCode = 400;
    throw err;
  }

  const { apiKey } = resolveFishApiKey();
  if (!apiKey) {
    return {
      valid: true,
      checked: false,
      voiceId: cleanId,
      message: 'Fish Audio API key is not configured yet; Voice ID saved unverified.',
    };
  }

  try {
    const res = await fetchFishWithTimeout(
      `/model/${encodeURIComponent(cleanId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
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
      const notFoundErr = new Error(
        `Invalid Fish Audio Voice ID "${cleanId}": no matching voice model was found on Fish Audio.`
      ) as Error & { statusCode?: number };
      notFoundErr.statusCode = 400;
      throw notFoundErr;
    }
    if (status === 401 || status === 403) {
      const authErr = new Error(
        'Authentication failed while verifying Fish Audio Voice ID. Check your API key in Settings.'
      ) as Error & { statusCode?: number };
      authErr.statusCode = 401;
      throw authErr;
    }
    throw err;
  }
}

export async function transcribeVideoWithFishAudio(params: {
  videoPath: string;
  projectId: string;
  duration: number;
  hasAudio: boolean;
  sourceLanguage?: string;
}): Promise<{ segments: CaptionSegment[]; detectedLanguage: string }> {
  if (!params.hasAudio) {
    throw new Error('The uploaded video does not contain an audio track to transcribe.');
  }

  const apiKey = getFishApiKey();
  const tempAudio = path.join(TEMP_DIR, `fish_asr_${params.projectId}_${Date.now()}.mp3`);

  try {
    // Extract compact 16kHz mono 32kbps MP3 so long videos upload fast
    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      params.videoPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '32k',
      tempAudio,
    ]);

    const audioBuffer = fs.readFileSync(tempAudio);
    const isoLang =
      params.sourceLanguage && params.sourceLanguage !== 'Auto'
        ? LANGUAGE_TO_ISO[params.sourceLanguage]
        : undefined;

    const res = await fetchFishWithRetry(
      '/v1/asr',
      () => {
        const formData = new FormData();
        formData.append('audio', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'audio.mp3');
        formData.append('ignore_timestamps', 'false');
        if (isoLang) {
          formData.append('language', isoLang);
        }
        return {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            model: 'transcribe-1-pro',
          },
          body: formData,
        };
      },
      180000,
      2
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

    const totalDur = Math.max(0.5, Number(data.duration) || params.duration || 10);
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
            id: uuidv4(),
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
          id: uuidv4(),
          start,
          end: Math.max(start + 0.3, end),
          text: sentence,
          words: distributeWordsEvenly(sentence, start, end),
        };
      });
    }

    if (segments.length === 0) {
      throw new Error('Fish Audio ASR returned no spoken segments for this video.');
    }

    const detectedLanguage =
      params.sourceLanguage && params.sourceLanguage !== 'Auto'
        ? params.sourceLanguage
        : mapIsoToLanguageName(data.language) || 'Auto';

    return {
      segments,
      detectedLanguage,
    };
  } finally {
    if (fs.existsSync(tempAudio)) {
      fs.unlinkSync(tempAudio);
    }
  }
}

function mapIsoToLanguageName(code?: string): string | null {
  if (!code) return null;
  const clean = code.toLowerCase().slice(0, 2);
  for (const [name, iso] of Object.entries(LANGUAGE_TO_ISO)) {
    if (iso === clean) return name;
  }
  return code;
}

async function synthesizeFishMp3Buffer(params: {
  text: string;
  referenceId?: string;
  maxAttempts?: number;
}): Promise<Buffer> {
  const apiKey = getFishApiKey();
  let refId: string | undefined;
  try {
    refId = normalizeAndValidateFishReferenceId(params.referenceId);
  } catch (err) {
    const valErr = new Error(err instanceof Error ? err.message : 'Invalid reference_id.') as Error & {
      statusCode?: number;
    };
    valErr.statusCode = 400;
    throw valErr;
  }

  const body: Record<string, unknown> = {
    text: params.text,
    format: 'mp3',
  };
  if (refId) {
    body.reference_id = refId;
  }
  const payloadStr = JSON.stringify(body);

  let res: Response;
  try {
    res = await fetchFishWithRetry(
      '/v1/tts',
      () => ({
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          model: DEFAULT_FISH_TTS_MODEL,
        },
        body: payloadStr,
      }),
      60000,
      params.maxAttempts ?? 3
    );
  } catch (err) {
    const status = (err as { statusCode?: number })?.statusCode;
    if (status === 404) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const err404 = new Error(
        refId
          ? `Fish Audio TTS failed (HTTP 404 · Invalid or inaccessible reference_id "${refId}" or resource): ${rawMsg}`
          : `Fish Audio TTS failed (HTTP 404 · Incorrect TTS endpoint or invalid model resource "${DEFAULT_FISH_TTS_MODEL}"): ${rawMsg}`
      ) as Error & { statusCode?: number };
      err404.statusCode = 404;
      throw err404;
    }
    if (refId && (status === 400 || status === 422)) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const refErr = new Error(
        `Selected Fish Audio Voice ID "${refId}" is invalid or unavailable (${rawMsg}). Please pick a valid narrator in Settings → My Voices.`
      ) as Error & { statusCode?: number };
      refErr.statusCode = status;
      throw refErr;
    }
    throw err;
  }

  const arrayBuf = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  if (buffer.length < 128) {
    const emptyErr = new Error('Fish Audio TTS returned an empty MP3 audio stream.') as Error & {
      statusCode?: number;
    };
    emptyErr.statusCode = 502;
    throw emptyErr;
  }
  return buffer;
}

export async function generateFishVoicePreview(params: {
  projectId: string;
  text: string;
  referenceId?: string;
  speakingSpeed?: number;
}): Promise<{ audioUrl: string; filePath: string }> {
  const finalName = `fish_preview_${params.projectId.slice(0, 8)}_${Date.now()}.mp3`;
  const finalMp3 = path.join(AUDIO_DIR, finalName);

  // Constant 1.0x speed preview (never time-stretched)
  const mp3Buffer = await synthesizeFishMp3Buffer({
    text: params.text,
    referenceId: params.referenceId,
  });

  fs.writeFileSync(finalMp3, mp3Buffer);

  const stat = fs.statSync(finalMp3);
  const audioUrl = `/media/audio/${finalName}`;
  registerAsset({
    id: uuidv4(),
    projectId: params.projectId,
    kind: 'audio',
    filename: finalName,
    filePath: finalMp3,
    url: audioUrl,
    mimeType: 'audio/mpeg',
    sizeBytes: stat.size,
  });

  return { audioUrl, filePath: finalMp3 };
}

function hasSpeakableText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

async function probeAudioDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'quiet',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  return Math.max(0.1, Number(stdout.trim()) || 1);
}

interface SynthesizedSegmentOutput {
  index: number;
  clip: GeneratedVoiceClip;
  filePath: string;
  startMs: number;
}

async function synthesizeOneSegment(params: {
  projectId: string;
  seg: CaptionSegment;
  index: number;
  spokenText: string;
  referenceId?: string;
  maxAttempts: number;
}): Promise<SynthesizedSegmentOutput> {
  const { projectId, seg, index, spokenText, referenceId, maxAttempts } = params;
  const uid = `${index}_${uuidv4().slice(0, 6)}`;
  const rawMp3 = path.join(TEMP_DIR, `fish_seg_raw_${uid}.mp3`);
  const clipFilename = `fish_dub_seg_${projectId.slice(0, 8)}_${uid}.mp3`;
  const clipPath = path.join(AUDIO_DIR, clipFilename);

  const mp3Buffer = await synthesizeFishMp3Buffer({
    text: spokenText,
    referenceId,
    maxAttempts,
  });

  fs.writeFileSync(rawMp3, mp3Buffer);
  const trimmedMp3 = path.join(TEMP_DIR, `fish_seg_trim_${uid}.mp3`);

  try {
    // Intelligent volume-aware silence analysis + safe edge-only trimming (preserves internal pauses & consonants)
    const rawAnalysis = await analyzeAudioFileSilence(rawMp3, {
      minSilenceDurationSec: 0.06,
      safetyMarginSec: 0.06,
    });

    const { analysisAfterTrim } = await trimAudioEdgeSilenceSafely({
      inputPath: rawMp3,
      outputPath: trimmedMp3,
      analysis: rawAnalysis,
    });

    // Constant 1.0x speech speed: never apply atempo or automatic time-stretching
    const clipDur = Math.max(0.08, analysisAfterTrim.duration);
    const speechDur = Math.min(clipDur, Math.max(0.05, analysisAfterTrim.speechDuration));
    const slotDur = Math.max(0.2, seg.end - seg.start);
    const overflowSec = clipDur > slotDur + 0.15 ? Math.round((clipDur - slotDur) * 100) / 100 : 0;

    fs.renameSync(trimmedMp3, clipPath);
    if (fs.existsSync(rawMp3)) fs.unlinkSync(rawMp3);

    const stat = fs.statSync(clipPath);
    const clipUrl = `/media/audio/${clipFilename}`;
    registerAsset({
      id: uuidv4(),
      projectId,
      kind: 'audio',
      filename: clipFilename,
      filePath: clipPath,
      url: clipUrl,
      mimeType: 'audio/mpeg',
      sizeBytes: stat.size,
    });

    return {
      index,
      clip: {
        segmentId: seg.id,
        audioUrl: clipUrl,
        start: seg.start,
        end: seg.end,
        duration: Math.round(clipDur * 100) / 100,
        speechDuration: Math.round(speechDur * 100) / 100,
        leadingSilence: Math.round(analysisAfterTrim.leadingSilence * 100) / 100,
        trailingSilence: Math.round(analysisAfterTrim.trailingSilence * 100) / 100,
        speechStartOffset: Math.round(rawAnalysis.speechStartOffset * 100) / 100,
        speechEndOffset: Math.round(rawAnalysis.speechEndOffset * 100) / 100,
        slotDuration: Math.round(slotDur * 100) / 100,
        overflowSeconds: overflowSec,
        text: spokenText,
        speaker: seg.speaker,
      },
      filePath: clipPath,
      startMs: Math.max(0, Math.round(seg.start * 1000)),
    };
  } catch (err) {
    if (fs.existsSync(rawMp3)) fs.unlinkSync(rawMp3);
    if (fs.existsSync(trimmedMp3)) fs.unlinkSync(trimmedMp3);
    throw err;
  }
}

export async function mergeClipsToFullDub(params: {
  projectId: string;
  items: Array<{
    filePath: string;
    startMs: number;
    trimStartSec?: number;
    trimEndSec?: number;
  }>;
  totalDuration: number;
  outPath: string;
}): Promise<void> {
  const { items, totalDuration, outPath } = params;
  const BATCH_SIZE = 16;

  const buildClipTrimFilter = (item: { trimStartSec?: number; trimEndSec?: number }) => {
    const startSec = Math.max(0, Number(item.trimStartSec || 0));
    const hasEnd = item.trimEndSec !== undefined && Number(item.trimEndSec) > startSec + 0.05;
    if (startSec <= 0.005 && !hasEnd) return '';
    const args: string[] = [];
    if (startSec > 0.005) args.push(`start=${startSec.toFixed(3)}`);
    if (hasEnd) args.push(`end=${Number(item.trimEndSec).toFixed(3)}`);
    return `,atrim=${args.join(':')},asetpts=PTS-STARTPTS`;
  };

  if (items.length <= BATCH_SIZE) {
    const inputs: string[] = ['-y'];
    const filters: string[] = [];
    const mixInputs: string[] = [];

    items.forEach((c, idx) => {
      inputs.push('-i', c.filePath);
      const trimPart = buildClipTrimFilter(c);
      const delayPart = c.startMs > 0 ? `,adelay=${c.startMs}|${c.startMs}` : '';
      filters.push(
        `[${idx}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo${trimPart}${delayPart}[d${idx}]`
      );
      mixInputs.push(`[d${idx}]`);
    });

    if (items.length === 1) {
      filters[0] = `${filters[0].replace('[d0]', '')},apad=whole_dur=${totalDuration.toFixed(2)},atrim=0:${totalDuration.toFixed(2)}[outa]`;
    } else {
      filters.push(
        `${mixInputs.join('')}amix=inputs=${items.length}:duration=longest:normalize=0,apad=whole_dur=${totalDuration.toFixed(2)},atrim=0:${totalDuration.toFixed(2)}[outa]`
      );
    }

    await execFileAsync('ffmpeg', [
      ...inputs,
      '-filter_complex',
      filters.join(';'),
      '-map',
      '[outa]',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-codec:a',
      'libmp3lame',
      '-b:a',
      '192k',
      outPath,
    ]);
    return;
  }

  // Hierarchical batch merge for large segment counts (prevents FFmpeg memory/fd exhaustion)
  const sorted = [...items].sort((a, b) => a.startMs - b.startMs);
  const batchWavs: Array<{ path: string; baseMs: number }> = [];

  try {
    for (let i = 0; i < sorted.length; i += BATCH_SIZE) {
      const batch = sorted.slice(i, i + BATCH_SIZE);
      const baseMs = batch[0].startMs;
      const batchWav = path.join(TEMP_DIR, `fish_batch_${params.projectId.slice(0, 8)}_${i}_${Date.now()}.wav`);

      const inputs: string[] = ['-y'];
      const filters: string[] = [];
      const mixInputs: string[] = [];

      batch.forEach((c, idx) => {
        inputs.push('-i', c.filePath);
        const relMs = Math.max(0, c.startMs - baseMs);
        const trimPart = buildClipTrimFilter(c);
        const delayPart = relMs > 0 ? `,adelay=${relMs}|${relMs}` : '';
        filters.push(
          `[${idx}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo${trimPart}${delayPart}[d${idx}]`
        );
        mixInputs.push(`[d${idx}]`);
      });

      if (batch.length === 1) {
        filters[0] = filters[0].replace('[d0]', '[bout]');
      } else {
        filters.push(`${mixInputs.join('')}amix=inputs=${batch.length}:duration=longest:normalize=0[bout]`);
      }

      await execFileAsync('ffmpeg', [
        ...inputs,
        '-filter_complex',
        filters.join(';'),
        '-map',
        '[bout]',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-codec:a',
        'pcm_s16le',
        batchWav,
      ]);
      batchWavs.push({ path: batchWav, baseMs });
    }

    const finalInputs: string[] = ['-y'];
    const finalFilters: string[] = [];
    const finalMix: string[] = [];

    batchWavs.forEach((b, idx) => {
      finalInputs.push('-i', b.path);
      const delayPart = b.baseMs > 0 ? `adelay=${b.baseMs}|${b.baseMs}` : 'anull';
      finalFilters.push(`[${idx}:a]${delayPart}[b${idx}]`);
      finalMix.push(`[b${idx}]`);
    });

    finalFilters.push(
      `${finalMix.join('')}amix=inputs=${batchWavs.length}:duration=longest:normalize=0,apad=whole_dur=${totalDuration.toFixed(2)},atrim=0:${totalDuration.toFixed(2)}[outa]`
    );

    await execFileAsync('ffmpeg', [
      ...finalInputs,
      '-filter_complex',
      finalFilters.join(';'),
      '-map',
      '[outa]',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-codec:a',
      'libmp3lame',
      '-b:a',
      '192k',
      outPath,
    ]);
  } finally {
    for (const b of batchWavs) {
      if (fs.existsSync(b.path)) {
        try {
          fs.unlinkSync(b.path);
        } catch {
          // ignore cleanup error
        }
      }
    }
  }
}

export async function generateFishSynchronizedDub(params: {
  projectId: string;
  captions: CaptionSegment[];
  voiceConfig: VoiceConfig;
  useTranslated: boolean;
  totalDuration: number;
  onProgress?: (progress: number, stage: string, etaSeconds: number | null) => void;
}): Promise<{
  clips: GeneratedVoiceClip[];
  fullDubUrl: string;
  fullDubPath: string;
  syncPlan: TimelineSyncPlan;
}> {
  if (!params.captions || params.captions.length === 0) {
    throw new Error('No transcript segments found. Transcribe or add segments first.');
  }

  getFishApiKey();

  const workItems = params.captions
    .map((seg, idx) => {
      const spokenText = (
        params.useTranslated && seg.translatedText ? seg.translatedText : seg.text
      ).trim();
      return { seg, index: idx, spokenText };
    })
    .filter((item) => item.spokenText.length > 0 && hasSpeakableText(item.spokenText));

  if (workItems.length === 0) {
    throw new Error('No valid spoken text found in transcript segments.');
  }

  const origDur = params.totalDuration || 112;
  const totalWords = workItems.reduce(
    (sum, item) => sum + item.spokenText.split(/\s+/).filter(Boolean).length,
    0
  );
  const estSec = totalWords / 3.0;
  if (estSec > origDur * 1.35) {
    throw new Error(
      `Audio Generation Blocked (Timeline Overflow): Translated narration word count (~${totalWords} words, estimated ~${estSec.toFixed(
        0
      )}s spoken at 1.0x) significantly exceeds original video duration (${origDur.toFixed(
        0
      )}s). Please use 'Shorten Script for Timeline' in the Gemini Translation panel to condense the script before generating audio.`
    );
  }

  const totalCount = workItems.length;
  const startedAt = Date.now();
  const results = new Array<SynthesizedSegmentOutput | null>(workItems.length).fill(null);
  const failedItems: Array<{ workIdx: number; item: (typeof workItems)[number]; error: Error }> = [];

  let completedCount = 0;
  const reportProgress = (stagePrefix: string) => {
    if (!params.onProgress) return;
    const ratio = completedCount / totalCount;
    const progress = Math.min(88, Math.max(4, Math.round(4 + ratio * 84)));
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const eta =
      completedCount >= 2 && ratio > 0
        ? Math.max(1, Math.round((elapsedSec / ratio) * (1 - ratio) + 2))
        : null;
    params.onProgress(progress, `${stagePrefix} (${completedCount}/${totalCount})`, eta);
  };

  reportProgress('Synthesizing segments via Fish Audio s2.1-pro-free');

  // Lock one consistent selected voice across every segment
  const lockedReferenceId = params.voiceConfig.fishReferenceId?.trim() || undefined;

  // Pass 1: Bounded concurrency (3 workers) with automatic retries per request
  const CONCURRENCY = Math.min(3, workItems.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const myIdx = cursor++;
      if (myIdx >= workItems.length) break;
      const item = workItems[myIdx];
      try {
        const out = await synthesizeOneSegment({
          projectId: params.projectId,
          seg: item.seg,
          index: item.index,
          spokenText: item.spokenText,
          referenceId: lockedReferenceId,
          maxAttempts: 3,
        });
        results[myIdx] = out;
        completedCount += 1;
        reportProgress('Synthesizing voice via s2.1-pro-free (1.0x)');
      } catch (err) {
        failedItems.push({
          workIdx: myIdx,
          item,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // Pass 2: Slow sequential recovery for any segments that hit transient Fish Audio rate limits
  if (failedItems.length > 0) {
    const remainingFailures: Array<{ index: number; message: string }> = [];
    for (const failed of failedItems) {
      await sleep(1200);
      try {
        const out = await synthesizeOneSegment({
          projectId: params.projectId,
          seg: failed.item.seg,
          index: failed.item.index,
          spokenText: failed.item.spokenText,
          referenceId: lockedReferenceId,
          maxAttempts: 2,
        });
        results[failed.workIdx] = out;
        completedCount += 1;
        reportProgress('Recovering rate-limited segments (1.0x)');
      } catch (err) {
        remainingFailures.push({
          index: failed.item.index + 1,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (remainingFailures.length > 0) {
      const sample = remainingFailures
        .slice(0, 3)
        .map((f) => `#${f.index}: ${f.message}`)
        .join('; ');
      throw new Error(
        `Fish Audio failed on ${remainingFailures.length} of ${totalCount} segments after retries (${sample}).`
      );
    }
  }

  const ordered = results.filter((r): r is SynthesizedSegmentOutput => Boolean(r));
  const rawClips = ordered.map((o) => o.clip);

  const syncMode: SyncMode = normalizeSyncMode(params.voiceConfig.syncMode);
  const continuousPauseMs = clampContinuousPauseMs(params.voiceConfig.continuousPauseMs);
  const syncPlan = buildTimelineSyncPlan({
    captions: params.captions,
    measuredClips: rawClips.map((c) => ({
      segmentId: c.segmentId,
      start: c.start,
      end: c.end,
      duration: c.duration,
      speechDuration: c.speechDuration,
      leadingSilence: c.leadingSilence,
      trailingSilence: c.trailingSilence,
    })),
    originalVideoDuration: params.totalDuration,
    syncMode,
    continuousPauseMs,
  });

  const clips = applySyncPlanToClips(rawClips, syncPlan);
  const clipBySegId = new Map(clips.map((c) => [c.segmentId, c]));
  const clipPaths = ordered
    .map((o) => {
      const synced = clipBySegId.get(o.clip.segmentId);
      const startSec = synced ? synced.start : o.clip.start;
      return {
        filePath: o.filePath,
        startMs: Math.max(0, Math.round(startSec * 1000)),
      };
    })
    .sort((a, b) => a.startMs - b.startMs);

  params.onProgress?.(90, `Merging ${clips.length} synchronized segments into MP3 track...`, 2);

  const finalDur = Math.max(0.5, syncPlan.estimatedFinalDuration);

  const fullDubName = `fish_full_dub_${params.projectId.slice(0, 8)}_${Date.now()}.mp3`;
  const fullDubPath = path.join(AUDIO_DIR, fullDubName);

  await mergeClipsToFullDub({
    projectId: params.projectId,
    items: clipPaths,
    totalDuration: finalDur,
    outPath: fullDubPath,
  });

  const dubStat = fs.statSync(fullDubPath);
  const fullDubUrl = `/media/audio/${fullDubName}`;
  registerAsset({
    id: uuidv4(),
    projectId: params.projectId,
    kind: 'audio',
    filename: fullDubName,
    filePath: fullDubPath,
    url: fullDubUrl,
    mimeType: 'audio/mpeg',
    sizeBytes: dubStat.size,
  });

  return { clips, fullDubUrl, fullDubPath, syncPlan };
}

export async function resyncExistingFishClips(params: {
  projectId: string;
  captions: CaptionSegment[];
  voiceConfig: VoiceConfig;
  originalDuration: number;
  syncMode: SyncMode;
  continuousPauseMs?: number;
}): Promise<{
  clips: GeneratedVoiceClip[];
  fullDubUrl: string;
  syncPlan: TimelineSyncPlan;
}> {
  const existingClips = params.voiceConfig.generatedClips || [];
  if (existingClips.length === 0) {
    throw new Error('Generate voice clips first before re-synchronizing the timeline.');
  }

  const normalizedMode = normalizeSyncMode(params.syncMode);
  const pauseMs = clampContinuousPauseMs(
    params.continuousPauseMs ?? params.voiceConfig.continuousPauseMs
  );
  const captionById = new Map(params.captions.map((c) => [c.id, c]));

  // Re-analyze each clip on disk and safely edge-trim if excessive outer silence exists (preserves internal speech & pauses)
  const refreshedClips: GeneratedVoiceClip[] = [];
  const assetPathBySegId = new Map<string, string>();

  for (const clip of existingClips) {
    const asset = getAssetByUrl(clip.audioUrl);
    if (!asset || !fs.existsSync(asset.file_path)) {
      throw new Error(`Audio clip missing on disk for segment ${clip.segmentId}. Regenerate voice.`);
    }

    const analysis = await analyzeAudioFileSilence(asset.file_path, {
      minSilenceDurationSec: 0.06,
      safetyMarginSec: 0.06,
    });

    let activeFilePath = asset.file_path;
    let activeAudioUrl = clip.audioUrl;
    let finalAnalysis = analysis;

    if (analysis.leadingSilence > 0.14 || analysis.trailingSilence > 0.14) {
      const trimName = `fish_dub_seg_trim_${params.projectId.slice(0, 8)}_${uuidv4().slice(0, 6)}.mp3`;
      const trimPath = path.join(AUDIO_DIR, trimName);
      const { analysisAfterTrim, trimmedSec } = await trimAudioEdgeSilenceSafely({
        inputPath: asset.file_path,
        outputPath: trimPath,
        analysis,
      });

      if (trimmedSec > 0.05 && fs.existsSync(trimPath)) {
        const stat = fs.statSync(trimPath);
        activeAudioUrl = `/media/audio/${trimName}`;
        activeFilePath = trimPath;
        finalAnalysis = analysisAfterTrim;
        registerAsset({
          id: uuidv4(),
          projectId: params.projectId,
          kind: 'audio',
          filename: trimName,
          filePath: trimPath,
          url: activeAudioUrl,
          mimeType: 'audio/mpeg',
          sizeBytes: stat.size,
        });
      } else if (fs.existsSync(trimPath)) {
        fs.unlinkSync(trimPath);
      }
    }

    assetPathBySegId.set(clip.segmentId, activeFilePath);
    refreshedClips.push({
      ...clip,
      audioUrl: activeAudioUrl,
      duration: Math.round(finalAnalysis.duration * 100) / 100,
      speechDuration: Math.round(finalAnalysis.speechDuration * 100) / 100,
      leadingSilence: Math.round(finalAnalysis.leadingSilence * 100) / 100,
      trailingSilence: Math.round(finalAnalysis.trailingSilence * 100) / 100,
      speechStartOffset: Math.round(analysis.speechStartOffset * 100) / 100,
      speechEndOffset: Math.round(analysis.speechEndOffset * 100) / 100,
    });
  }

  const syncPlan = buildTimelineSyncPlan({
    captions: params.captions,
    measuredClips: refreshedClips.map((c) => {
      const orig = captionById.get(c.segmentId);
      return {
        segmentId: c.segmentId,
        start: orig ? orig.start : c.start,
        end: orig ? orig.end : c.end,
        duration: c.duration,
        speechDuration: c.speechDuration,
        leadingSilence: c.leadingSilence,
        trailingSilence: c.trailingSilence,
      };
    }),
    originalVideoDuration: params.originalDuration,
    syncMode: normalizedMode,
    continuousPauseMs: pauseMs,
  });

  const clips = applySyncPlanToClips(refreshedClips, syncPlan);
  const clipPaths: Array<{ filePath: string; startMs: number }> = [];

  for (const clip of clips) {
    const filePath = assetPathBySegId.get(clip.segmentId);
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`Audio clip missing on disk for segment ${clip.segmentId}. Regenerate voice.`);
    }
    clipPaths.push({
      filePath,
      startMs: Math.max(0, Math.round(clip.start * 1000)),
    });
  }
  clipPaths.sort((a, b) => a.startMs - b.startMs);

  const fullDubName = `fish_full_dub_${params.projectId.slice(0, 8)}_${Date.now()}.mp3`;
  const fullDubPath = path.join(AUDIO_DIR, fullDubName);
  const finalDur = Math.max(0.5, syncPlan.estimatedFinalDuration);

  await mergeClipsToFullDub({
    projectId: params.projectId,
    items: clipPaths,
    totalDuration: finalDur,
    outPath: fullDubPath,
  });

  const dubStat = fs.statSync(fullDubPath);
  const fullDubUrl = `/media/audio/${fullDubName}`;
  registerAsset({
    id: uuidv4(),
    projectId: params.projectId,
    kind: 'audio',
    filename: fullDubName,
    filePath: fullDubPath,
    url: fullDubUrl,
    mimeType: 'audio/mpeg',
    sizeBytes: dubStat.size,
  });

  return { clips, fullDubUrl, syncPlan };
}

const dubQueue: Array<{
  jobId: string;
  projectId: string;
  voiceConfig: VoiceConfig;
  captions: CaptionSegment[];
  useTranslated: boolean;
}> = [];
let dubWorkerRunning = false;

export function enqueueFishDubJob(params: {
  projectId: string;
  voiceConfig: VoiceConfig;
  captions: CaptionSegment[];
  useTranslated: boolean;
}): RenderJob {
  getFishApiKey();
  const project = getProject(params.projectId);
  if (!project || !project.metadata) {
    throw new Error('Project video not found.');
  }
  const hasSpeakable = params.captions.some((seg) => {
    const txt = (params.useTranslated && seg.translatedText ? seg.translatedText : seg.text).trim();
    return txt.length > 0 && hasSpeakableText(txt);
  });
  if (!hasSpeakable) {
    throw new Error('No speakable transcript or translation segments found.');
  }

  const job = createJob({
    id: uuidv4(),
    projectId: params.projectId,
    type: 'voice',
    status: 'queued',
    progress: 0,
    stage: `Queued ${params.captions.length} segments for Fish Audio s2.1-pro-free`,
    etaSeconds: null,
    outputUrl: null,
    outputSize: null,
    error: null,
  });

  dubQueue.push({
    jobId: job.id,
    projectId: params.projectId,
    voiceConfig: params.voiceConfig,
    captions: params.captions,
    useTranslated: params.useTranslated,
  });
  void processDubQueue();
  return job;
}

async function processDubQueue() {
  if (dubWorkerRunning) return;
  dubWorkerRunning = true;

  try {
    while (dubQueue.length > 0) {
      const task = dubQueue.shift()!;
      const job = getJob(task.jobId);
      if (!job) continue;

      const project = getProject(task.projectId);
      if (!project || !project.metadata) {
        updateJob(task.jobId, { status: 'failed', error: 'Project or video metadata missing.' });
        continue;
      }

      updateJob(task.jobId, {
        status: 'processing',
        progress: 2,
        stage: 'Connecting to Fish Audio s2.1-pro-free...',
      });

      try {
        const generated = await generateFishSynchronizedDub({
          projectId: task.projectId,
          captions: task.captions,
          voiceConfig: task.voiceConfig,
          useTranslated: task.useTranslated,
          totalDuration: project.metadata.duration,
          onProgress: (progress, stage, etaSeconds) => {
            updateJob(task.jobId, { progress, stage, etaSeconds });
          },
        });

        const latestProject = getProject(task.projectId) || project;
        updateProject(task.projectId, {
          captions: task.captions,
          voice: {
            ...latestProject.voice,
            ...task.voiceConfig,
            provider: 'fish',
            syncMode: generated.syncPlan.syncMode,
            continuousPauseMs: generated.syncPlan.pauseDurationMs ?? latestProject.voice.continuousPauseMs,
            speakingSpeed: 1.0,
            enabled: true,
            generatedClips: generated.clips,
            fullDubUrl: generated.fullDubUrl,
            syncPlan: generated.syncPlan,
          },
        });

        const dubSize = fs.existsSync(generated.fullDubPath)
          ? fs.statSync(generated.fullDubPath).size
          : null;

        updateJob(task.jobId, {
          status: 'completed',
          progress: 100,
          stage: `Generated all ${generated.clips.length} synchronized MP3 segments`,
          etaSeconds: 0,
          outputUrl: generated.fullDubUrl,
          outputSize: dubSize,
        });
      } catch (err) {
        updateJob(task.jobId, {
          status: 'failed',
          stage: 'Fish Audio dubbing failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    dubWorkerRunning = false;
  }
}

export interface SegmentAudioDiagnostic {
  segmentId: string;
  originalStart: number;
  originalEnd: number;
  charCount: number;
  wordCount: number;
  allocatedDuration: number;
  actualDuration: number | null;
  speechDuration: number | null;
  leadingSilence: number;
  trailingSilence: number;
  finalStart: number | null;
  gapBeforeNext: number | null;
  durationDifference: number | null;
  status: 'generated' | 'pending' | 'overflow';
}

export function generateDubDiagnosticReport(project: Project): {
  originalVideoDuration: number;
  totalEstimatedDuration: number;
  totalActualDuration: number;
  totalSpeechDuration: number;
  totalAudioTrackDuration: number;
  syncMode: SyncMode;
  pauseDurationMs: number;
  narrationAudit: NarrationAuditReport;
  gapDiagnostics: SegmentGapDiagnostic[];
  segments: SegmentAudioDiagnostic[];
} {
  const origDur = project.metadata?.duration || 112;
  const generatedClips = project.voice.generatedClips || [];
  const clipsBySeg = new Map(generatedClips.map((c) => [c.segmentId, c]));
  const gapBySeg = new Map(
    (project.voice.syncPlan?.gapDiagnostics || []).map((g) => [g.segmentId, g])
  );
  const narrationAudit =
    project.voice.syncPlan?.narrationAudit ||
    auditProjectNarration(project.captions || [], generatedClips);

  let totalActual = 0;
  let totalSpeech = 0;
  let totalEst = 0;

  const segments: SegmentAudioDiagnostic[] = (project.captions || []).map((seg) => {
    const text =
      (project.subtitleStyle.useTranslated && seg.translatedText
        ? seg.translatedText
        : seg.text) || '';
    const charCount = text.length;
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const allocatedDuration = Math.max(0.2, Number((seg.end - seg.start).toFixed(2)));
    totalEst += wordCount / 3.0;

    const clip = clipsBySeg.get(seg.id);
    const diag = gapBySeg.get(seg.id);
    const actualDuration = clip ? clip.duration : null;
    const speechDuration = clip ? clip.speechDuration ?? clip.duration : null;
    if (actualDuration !== null) totalActual += actualDuration;
    if (speechDuration !== null) totalSpeech += speechDuration;

    const durationDifference =
      actualDuration !== null ? Number((actualDuration - allocatedDuration).toFixed(2)) : null;
    const status: SegmentAudioDiagnostic['status'] = !clip
      ? 'pending'
      : durationDifference !== null && durationDifference > 0.15
      ? 'overflow'
      : 'generated';

    return {
      segmentId: seg.id,
      originalStart: Number(seg.start.toFixed(2)),
      originalEnd: Number(seg.end.toFixed(2)),
      charCount,
      wordCount,
      allocatedDuration,
      actualDuration,
      speechDuration,
      leadingSilence: clip?.leadingSilence ?? diag?.leadingSilence ?? 0,
      trailingSilence: clip?.trailingSilence ?? diag?.trailingSilence ?? 0,
      finalStart: diag ? diag.finalStart : clip ? Number(clip.start.toFixed(2)) : null,
      gapBeforeNext: diag ? diag.gapBeforeNext : null,
      durationDifference,
      status,
    };
  });

  const totalAudioTrackDuration =
    project.voice.syncPlan?.totalAudioTrackDuration ??
    project.voice.syncPlan?.estimatedFinalDuration ??
    generatedClips.reduce((m, c) => Math.max(m, c.end), 0);

  return {
    originalVideoDuration: origDur,
    totalEstimatedDuration: Number(totalEst.toFixed(2)),
    totalActualDuration: Number(totalActual.toFixed(2)),
    totalSpeechDuration: Number((project.voice.syncPlan?.totalSpeechDuration ?? totalSpeech).toFixed(2)),
    totalAudioTrackDuration: Number(totalAudioTrackDuration.toFixed(2)),
    syncMode: normalizeSyncMode(project.voice.syncMode),
    pauseDurationMs: clampContinuousPauseMs(project.voice.continuousPauseMs),
    narrationAudit,
    gapDiagnostics: project.voice.syncPlan?.gapDiagnostics || [],
    segments,
  };
}

export async function inspectFullDubTrackDiagnostics(project: Project): Promise<
  | {
      totalTrackDuration: number;
      totalSilenceDuration: number;
      estimatedSpeechDuration: number;
      longGaps: Array<{ start: number; end: number; duration: number }>;
    }
  | null
> {
  if (!project.voice.fullDubUrl) return null;
  const asset = getAssetByUrl(project.voice.fullDubUrl);
  if (!asset || !fs.existsSync(asset.file_path)) return null;
  return diagnoseFullNarrationTrackSilences(asset.file_path, 0.6);
}

export async function regenerateFishSegments(params: {
  projectId: string;
  segmentIds: string[];
  captions?: CaptionSegment[];
  voiceConfig?: Partial<VoiceConfig>;
  useTranslated?: boolean;
}): Promise<{
  project: Project;
  regeneratedIds: string[];
  clips: GeneratedVoiceClip[];
  fullDubUrl: string;
  syncPlan: TimelineSyncPlan;
  report: ReturnType<typeof generateDubDiagnosticReport>;
}> {
  getFishApiKey();

  const existingProject = getProject(params.projectId);
  if (!existingProject || !existingProject.metadata) {
    throw new Error('Project video not found.');
  }

  const targetIds = new Set(
    (params.segmentIds || []).map((id) => String(id).trim()).filter(Boolean)
  );
  if (targetIds.size === 0) {
    throw new Error('Specify at least one segment ID to regenerate.');
  }

  const captions =
    Array.isArray(params.captions) && params.captions.length > 0
      ? params.captions
      : existingProject.captions;

  const missingRequested = Array.from(targetIds).filter(
    (id) => !captions.some((c) => c.id === id)
  );
  if (missingRequested.length > 0) {
    throw new Error(`Unknown segment ID(s): ${missingRequested.join(', ')}`);
  }

  const mergedVoice: VoiceConfig = {
    ...existingProject.voice,
    ...(params.voiceConfig || {}),
    provider: 'fish',
    speakingSpeed: 1.0,
    enabled: true,
  };

  const useTranslated =
    params.useTranslated !== undefined
      ? Boolean(params.useTranslated)
      : captions.some((c) => Boolean(c.translatedText?.trim()));

  const lockedReferenceId = mergedVoice.fishReferenceId?.trim() || undefined;
  const existingClipsById = new Map(
    (mergedVoice.generatedClips || []).map((c) => [c.segmentId, c])
  );

  const outputs: SynthesizedSegmentOutput[] = [];
  const regeneratedIds: string[] = [];

  for (let idx = 0; idx < captions.length; idx++) {
    const seg = captions[idx];
    const spokenText = (
      useTranslated && seg.translatedText ? seg.translatedText : seg.text
    ).trim();

    if (!spokenText || !hasSpeakableText(spokenText)) {
      continue;
    }

    const existingClip = existingClipsById.get(seg.id);
    const existingAsset = existingClip ? getAssetByUrl(existingClip.audioUrl) : null;
    const hasExistingFile = Boolean(existingAsset && fs.existsSync(existingAsset.file_path));

    if (targetIds.has(seg.id) || !existingClip || !hasExistingFile) {
      const synthesized = await synthesizeOneSegment({
        projectId: params.projectId,
        seg,
        index: idx,
        spokenText,
        referenceId: lockedReferenceId,
        maxAttempts: 3,
      });
      outputs.push(synthesized);
      if (targetIds.has(seg.id)) {
        regeneratedIds.push(seg.id);
      }
    } else {
      const slotDur = Math.max(0.2, seg.end - seg.start);
      const measuredDur = existingClip.duration;
      const overflowSec =
        measuredDur > slotDur + 0.15
          ? Math.round((measuredDur - slotDur) * 100) / 100
          : 0;
      outputs.push({
        index: idx,
        clip: {
          ...existingClip,
          start: seg.start,
          end: seg.end,
          slotDuration: Math.round(slotDur * 100) / 100,
          overflowSeconds: overflowSec,
          text: spokenText,
          speaker: seg.speaker,
        },
        filePath: existingAsset!.file_path,
        startMs: Math.max(0, Math.round(seg.start * 1000)),
      });
    }
  }

  if (outputs.length === 0) {
    throw new Error('No speakable segments available to merge into the dubbing track.');
  }

  const rawClips = outputs.map((o) => o.clip);
  const syncMode: SyncMode = normalizeSyncMode(mergedVoice.syncMode);
  const continuousPauseMs = clampContinuousPauseMs(mergedVoice.continuousPauseMs);
  const syncPlan = buildTimelineSyncPlan({
    captions,
    measuredClips: rawClips.map((c) => ({
      segmentId: c.segmentId,
      start: c.start,
      end: c.end,
      duration: c.duration,
      speechDuration: c.speechDuration,
      leadingSilence: c.leadingSilence,
      trailingSilence: c.trailingSilence,
    })),
    originalVideoDuration: existingProject.metadata.duration,
    syncMode,
    continuousPauseMs,
  });

  const clips = applySyncPlanToClips(rawClips, syncPlan);
  const clipBySegId = new Map(clips.map((c) => [c.segmentId, c]));
  const clipPaths = outputs
    .map((o) => {
      const synced = clipBySegId.get(o.clip.segmentId);
      const startSec = synced ? synced.start : o.clip.start;
      return {
        filePath: o.filePath,
        startMs: Math.max(0, Math.round(startSec * 1000)),
      };
    })
    .sort((a, b) => a.startMs - b.startMs);

  const finalDur = Math.max(0.5, syncPlan.estimatedFinalDuration);
  const fullDubName = `fish_full_dub_${params.projectId.slice(0, 8)}_${Date.now()}.mp3`;
  const fullDubPath = path.join(AUDIO_DIR, fullDubName);

  await mergeClipsToFullDub({
    projectId: params.projectId,
    items: clipPaths,
    totalDuration: finalDur,
    outPath: fullDubPath,
  });

  const dubStat = fs.statSync(fullDubPath);
  const fullDubUrl = `/media/audio/${fullDubName}`;
  registerAsset({
    id: uuidv4(),
    projectId: params.projectId,
    kind: 'audio',
    filename: fullDubName,
    filePath: fullDubPath,
    url: fullDubUrl,
    mimeType: 'audio/mpeg',
    sizeBytes: dubStat.size,
  });

  const remainingPending = (existingProject.translation.pendingRegenerateSegmentIds || []).filter(
    (id) => !targetIds.has(id)
  );

  const updatedProject =
    updateProject(params.projectId, {
      captions,
      translation: {
        ...existingProject.translation,
        pendingRegenerateSegmentIds: remainingPending,
      },
      voice: {
        ...mergedVoice,
        syncMode,
        continuousPauseMs,
        speakingSpeed: 1.0,
        enabled: true,
        generatedClips: clips,
        fullDubUrl,
        syncPlan,
      },
    }) || existingProject;

  return {
    project: updatedProject,
    regeneratedIds,
    clips,
    fullDubUrl,
    syncPlan,
    report: generateDubDiagnosticReport(updatedProject),
  };
}

// Re-merges existing on-disk MP3 segment clips after manual timeline move/trim edits in the Editor
// Zero TTS API calls and strictly 1.0x speed (never alters pitch or speech tempo).
export async function rebuildFishDubTrackFromClips(params: {
  projectId: string;
  generatedClips?: GeneratedVoiceClip[];
}): Promise<{
  project: Project;
  fullDubUrl: string;
  clips: GeneratedVoiceClip[];
  syncPlan?: TimelineSyncPlan;
}> {
  const existingProject = getProject(params.projectId);
  if (!existingProject || !existingProject.metadata) {
    throw new Error('Project video not found.');
  }

  const inputClips =
    Array.isArray(params.generatedClips)
      ? params.generatedClips
      : existingProject.voice.generatedClips || [];

  const sanitizedClips: GeneratedVoiceClip[] = [];
  const mergeItems: Array<{
    filePath: string;
    startMs: number;
    trimStartSec?: number;
    trimEndSec?: number;
  }> = [];

  for (const clip of inputClips) {
    const asset = clip.audioUrl ? getAssetByUrl(clip.audioUrl) : null;
    if (!asset || !fs.existsSync(asset.file_path)) {
      continue;
    }
    const maxAudioDur = Math.max(0.2, Number(clip.duration || 0.2));
    const trimStartSec = Math.max(
      0,
      Math.min(maxAudioDur - 0.15, Number(clip.trimStartSec || 0))
    );
    const clipStart = Math.max(0, Number(clip.start || 0));
    const requestedSpan = Math.max(0.2, Number(clip.end || clipStart + maxAudioDur) - clipStart);
    const clampedSpan = Math.min(maxAudioDur - trimStartSec, requestedSpan);
    const trimEndSec = Math.min(maxAudioDur, trimStartSec + clampedSpan);
    const clipEnd = Number((clipStart + clampedSpan).toFixed(3));

    sanitizedClips.push({
      ...clip,
      start: Number(clipStart.toFixed(3)),
      end: clipEnd,
      trimStartSec: trimStartSec > 0.005 ? Number(trimStartSec.toFixed(3)) : undefined,
      trimEndSec:
        trimEndSec < maxAudioDur - 0.01 ? Number(trimEndSec.toFixed(3)) : undefined,
    });

    mergeItems.push({
      filePath: asset.file_path,
      startMs: Math.max(0, Math.round(clipStart * 1000)),
      trimStartSec: trimStartSec > 0.005 ? trimStartSec : undefined,
      trimEndSec: trimEndSec < maxAudioDur - 0.01 ? trimEndSec : undefined,
    });
  }

  const sortedClips = [...sanitizedClips].sort((a, b) => a.start - b.start);
  const sortedMergeItems = [...mergeItems].sort((a, b) => a.startMs - b.startMs);

  const origDuration = Math.max(0.5, existingProject.metadata.duration || 0.5);
  const maxClipEnd = sortedClips.reduce((m, c) => Math.max(m, c.end), 0);
  const totalDuration = Math.max(origDuration, maxClipEnd, 0.5);

  let fullDubUrl: string | undefined = existingProject.voice.fullDubUrl;

  if (sortedMergeItems.length > 0) {
    const fullDubName = `fish_full_dub_${params.projectId.slice(0, 8)}_${Date.now()}.mp3`;
    const fullDubPath = path.join(AUDIO_DIR, fullDubName);
    await mergeClipsToFullDub({
      projectId: params.projectId,
      items: sortedMergeItems,
      totalDuration,
      outPath: fullDubPath,
    });
    const dubStat = fs.statSync(fullDubPath);
    fullDubUrl = `/media/audio/${fullDubName}`;
    registerAsset({
      id: uuidv4(),
      projectId: params.projectId,
      kind: 'audio',
      filename: fullDubName,
      filePath: fullDubPath,
      url: fullDubUrl,
      mimeType: 'audio/mpeg',
      sizeBytes: dubStat.size,
    });
  } else {
    fullDubUrl = undefined;
  }

  const clipMap = new Map(sortedClips.map((c) => [c.segmentId, c]));
  const existingSyncPlan = existingProject.voice.syncPlan;
  const nextSyncPlan: TimelineSyncPlan | undefined = existingSyncPlan
    ? {
        ...existingSyncPlan,
        estimatedFinalDuration: Number(totalDuration.toFixed(2)),
        totalAudioTrackDuration: Number(totalDuration.toFixed(2)),
        additionalDuration: Number(Math.max(0, totalDuration - origDuration).toFixed(2)),
        segments: existingSyncPlan.segments
          .filter((s) => clipMap.has(s.segmentId))
          .map((s) => {
            const c = clipMap.get(s.segmentId)!;
            return {
              ...s,
              syncedStart: c.start,
              syncedEnd: c.end,
            };
          }),
        narrationAudit: auditProjectNarration(existingProject.captions || [], sortedClips),
        computedAt: new Date().toISOString(),
      }
    : undefined;

  const updatedProject =
    updateProject(params.projectId, {
      voice: {
        ...existingProject.voice,
        provider: 'fish',
        speakingSpeed: 1.0,
        generatedClips: sortedClips,
        fullDubUrl,
        ...(nextSyncPlan ? { syncPlan: nextSyncPlan } : {}),
      },
    }) || existingProject;

  return {
    project: updatedProject,
    fullDubUrl: fullDubUrl || '',
    clips: sortedClips,
    syncPlan: nextSyncPlan,
  };
}

