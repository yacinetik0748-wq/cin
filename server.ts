import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { v4 as uuidv4 } from 'uuid';
import {
  DEFAULT_FISH_TTS_MODEL,
  normalizeAndValidateFishReferenceId,
  normalizeFishApiBaseUrl,
  normalizeFishApiKey,
  sanitizeFishErrorText,
} from './src/lib/fishReference.ts';
import {
  AUDIO_DIR,
  BACKGROUNDS_DIR,
  EXPORTS_DIR,
  FONTS_DIR,
  LOGOS_DIR,
  MASKS_DIR,
  STORAGE_DIR,
  THUMBS_DIR,
  UPLOADS_DIR,
  checkAssetAvailableByUrl,
  createPreset,
  createProject,
  deleteCustomFont,
  deletePreset,
  deleteProject,
  getAssetByUrl,
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
  registerAsset,
  registerCustomFont,
  saveDefaultStudioPreferences,
  saveSavedFishVoices,
  updatePreset,
  updateProject,
  upsertProjectFromCloud,
} from './server/db.ts';
import {
  CompressionPreset,
  compressProjectVideoForFreeCloud,
  computeLocalStorageUsage,
  hydrateAssetToLocalBucket,
  inspectProjectAssets,
} from './server/services/local_storage_service.ts';
import { isGeminiConfigured } from './server/services/gemini_client.ts';
import { detectOriginalCaptionsInVideo } from './server/services/caption_detector_service.ts';
import {
  analyzeVideoFile,
  checkFfmpegCapabilities,
  createDemoMovieRecapClip,
  extractAudioPeaksCached,
  extractVideoFilmstrip,
  extractWaveformPeaks,
  generateHighResVideoFrame,
  generateVideoThumbnail,
} from './server/services/video_analysis_service.ts';
import {
  UploadValidationError,
  finalizeChunkedUpload,
  getChunkSession,
  getMaxUploadBytes,
  initChunkedUpload,
  saveCanvasBackgroundFile,
  saveDirectVideoFile,
  saveFontFile,
  saveLogoFile,
  saveMusicFile,
  saveSegmentationMaskImage,
  saveSfxFile,
  saveUploadChunk,
} from './server/services/video_upload_service.ts';
import {
  extractAudioTrack,
  transcribeVideoWithGemini,
} from './server/services/transcription_service.ts';
import { translateCaptionsWithGemini } from './server/services/translation_service.ts';
import {
  generateSingleVoicePreview,
  generateSynchronizedVoiceover,
} from './server/services/voice_generation_service.ts';
import {
  generateSrtContent,
  generateVttContent,
  parseSrtOrVtt,
} from './server/services/subtitle_service.ts';
import {
  cleanupTempStorage,
  enqueueRenderJob,
} from './server/services/export_service.ts';
import { ensureFontAvailable } from './server/services/font_service.ts';
import { resolveSourceCropRect } from './server/services/video_render_service.ts';
import { buildVideoEffectsFilters } from './server/services/video_effects_service.ts';
import {
  enqueueFishDubJob,
  generateDubDiagnosticReport,
  generateFishSynchronizedDub,
  generateFishVoicePreview,
  inspectFullDubTrackDiagnostics,
  isFishAudioConfigured,
  listFishVoices,
  rebuildFishDubTrackFromClips,
  regenerateFishSegments,
  resyncExistingFishClips,
  testFishAudioConnection,
  transcribeVideoWithFishAudio,
  validateFishVoiceId,
} from './server/services/fish_audio_service.ts';
import {
  deleteSavedFishApiKey,
  getFishSettingsSummary,
  saveFishApiKey,
} from './server/services/secrets_service.ts';
import {
  clampContinuousPauseMs,
  normalizeSyncMode,
} from './server/services/timeline_sync_service.ts';
import { BUILTIN_FONT_CATALOG } from './src/lib/fontCatalog.ts';
import {
  applySavedStyleToProjectData,
  buildSavedStylePayloadFromProject,
  sanitizeSavedStylePayload,
} from './src/lib/savedStyles.ts';
import { resolveCanvasDimensions } from './src/lib/workflowStages.ts';
import {
  DEFAULT_SUBTITLE_STYLE,
  DEFAULT_VIDEO_CANVAS,
  DEFAULT_VIDEO_EFFECTS,
  GeminiVoiceName,
  PresetCategory,
  Project,
  StyleApplyScope,
  StyleMissingVoiceWarning,
  StudioPreset,
  StudioPresetAssetRef,
  SupportedLanguage,
  SyncMode,
} from './src/types/studio.ts';

const PORT = Number(process.env.PORT) || 3000;
const app = express();

// Enable CORS for cross-origin frontend hosting (e.g. Cloudflare Pages *.pages.dev)
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization, Range, X-Fish-Api-Key, model'
  );
  res.header(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Accept-Ranges, Content-Disposition, X-Fish-Proxy, X-Fish-Upstream-Url, X-Fish-Response-Url'
  );
  res.header('Access-Control-Allow-Credentials', 'true');

  if (!req.path.startsWith('/api') && !req.path.startsWith('/media') && !req.path.startsWith('/storage')) {
    res.header('Cross-Origin-Opener-Policy', 'same-origin');
    res.header('Cross-Origin-Embedder-Policy', 'credentialless');
  }

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json({ limit: '25mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '30mb' }));

const DIRECT_UPLOAD_MAX_BYTES = Math.min(getMaxUploadBytes(), 150 * 1024 * 1024);

const uploadMem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: DIRECT_UPLOAD_MAX_BYTES },
});

function normalizeProjectId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') return null;
  return trimmed;
}

// Serve nested filmstrip thumbnail frames (/media/thumbs/<filmstrip_dir>/<frame_NNN.jpg>)
app.get('/media/thumbs/:subdir/:filename', (req, res) => {
  const safeSubdir = path.basename(req.params.subdir || '');
  const safeName = path.basename(req.params.filename || '');
  if (!safeSubdir || !safeName || safeSubdir === '.' || safeSubdir === '..') {
    res.status(404).json({ error: 'Invalid thumbnail path' });
    return;
  }
  const filePath = path.resolve(THUMBS_DIR, safeSubdir, safeName);
  const thumbsRoot = path.resolve(THUMBS_DIR) + path.sep;
  if (!filePath.startsWith(thumbsRoot) || !fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Thumbnail frame not found' });
    return;
  }
  const stat = fs.statSync(filePath);
  if (stat.size <= 0) {
    res.status(404).json({ error: 'Empty thumbnail frame' });
    return;
  }
  const ext = path.extname(safeName).toLowerCase();
  const contentType =
    ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  res.writeHead(200, {
    'Content-Length': stat.size,
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=86400',
  });
  fs.createReadStream(filePath).pipe(res);
});

// Media streaming route with HTTP Range & HEAD support for video seeking and download disposition
app.get('/media/:bucket/:filename', (req, res) => {
  const { bucket, filename } = req.params;
  const safeName = path.basename(filename);
  const bucketMap: Record<string, string> = {
    uploads: UPLOADS_DIR,
    logos: LOGOS_DIR,
    backgrounds: BACKGROUNDS_DIR,
    fonts: FONTS_DIR,
    audio: AUDIO_DIR,
    masks: MASKS_DIR,
    exports: EXPORTS_DIR,
    thumbs: THUMBS_DIR,
  };
  const baseDir = bucketMap[bucket];
  if (!baseDir) {
    res.status(404).json({ error: 'Invalid media bucket' });
    return;
  }

  const filePath = path.join(baseDir, safeName);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Media file not found' });
    return;
  }

  const stat = fs.statSync(filePath);
  if (stat.size <= 0) {
    res.status(404).json({ error: 'Media file is empty or incomplete' });
    return;
  }

  const ext = path.extname(safeName).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.aac': 'audio/aac',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  const contentType = mimeMap[ext] || 'application/octet-stream';

  if (bucket === 'exports') {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
  }
  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    });
    res.end();
    return;
  }

  const range = req.headers.range;
  if (range && (ext === '.mp4' || ext === '.mov' || ext === '.mkv' || ext === '.wav' || ext === '.mp3')) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parts[0] ? parseInt(parts[0], 10) : 0;
    const rawEnd = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const end = Math.min(stat.size - 1, isNaN(rawEnd) ? stat.size - 1 : rawEnd);

    if (isNaN(start) || start < 0 || start >= stat.size || end < start) {
      res.writeHead(416, {
        'Content-Range': `bytes */${stat.size}`,
      });
      res.end();
      return;
    }

    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    'Content-Length': stat.size,
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
  });
  fs.createReadStream(filePath).pipe(res);
});

// System Diagnostics & Configuration Status
app.get('/api/system/status', async (_req, res) => {
  const caps = await checkFfmpegCapabilities();
  res.json({
    geminiConfigured: isGeminiConfigured(),
    fishConfigured: isFishAudioConfigured(),
    ffmpegAvailable: caps.ffmpegAvailable,
    ffprobeAvailable: caps.ffprobeAvailable,
    ffmpegVersion: caps.ffmpegVersion,
    storageDir: STORAGE_DIR,
    maxUploadSizeMb: Math.round(getMaxUploadBytes() / (1024 * 1024)),
    tempRetentionHours: Number(process.env.TEMP_RETENTION_HOURS || '24'),
    supportedVideoFormats: ['MP4', 'MOV', 'MKV'],
    supportedLogoFormats: ['PNG', 'SVG'],
    runtime: 'express',
    d1Available: false,
    r2Available: false,
    clientProcessingAvailable: true,
  });
});


app.get('/api/system/storage-usage', (_req, res) => {
  try {
    res.json(computeLocalStorageUsage());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Fish Audio API Settings (Encrypted backend storage; plaintext keys are NEVER returned)
app.get('/api/settings/fish-audio', (_req, res) => {
  res.json(getFishSettingsSummary());
});

app.post('/api/settings/fish-api-key', async (req, res) => {
  try {
    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey : '';
    const summary = saveFishApiKey(apiKey);
    res.json(summary);
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/settings/fish-api-key/test', async (req, res) => {
  try {
    const candidateKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey : undefined;
    const result = await testFishAudioConnection(candidateKey);
    res.json(result);
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete('/api/settings/fish-api-key', (_req, res) => {
  try {
    res.json(deleteSavedFishApiKey());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Fish Audio Voice Library & Authorized Cloned Voices
app.get('/api/fish/voices', async (req, res) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q : undefined;
    const selfOnly = req.query.self === 'true';
    const language = typeof req.query.language === 'string' ? req.query.language : undefined;
    const result = await listFishVoices({ query, selfOnly, language });
    res.json(result);
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Stateless Fish Audio TTS/ASR proxies (read X-Fish-Api-Key in-memory only; never log or persist)
app.post('/api/fish/proxy/tts', async (req, res) => {
  try {
    const hasHeaderKey = req.headers['x-fish-api-key'] !== undefined;
    const headerKey =
      typeof req.headers['x-fish-api-key'] === 'string'
        ? normalizeFishApiKey(req.headers['x-fish-api-key'])
        : '';
    const apiKey = hasHeaderKey ? headerKey : normalizeFishApiKey(process.env.FISH_API_KEY);
    if (!apiKey) {
      res.status(401).json({ error: 'Fish Audio API key is required.' });
      return;
    }

    const reqBody = req.body && typeof req.body === 'object' ? { ...req.body } : {};
    const text = typeof reqBody.text === 'string' ? reqBody.text.trim() : '';
    if (!text) {
      res.status(400).json({ error: 'TTS text is required.' });
      return;
    }

    let validRefId: string | undefined;
    try {
      validRefId = normalizeAndValidateFishReferenceId(
        typeof reqBody.reference_id === 'string' ? reqBody.reference_id : undefined
      );
    } catch (refErr) {
      res.status(400).json({
        error: refErr instanceof Error ? refErr.message : 'Invalid reference_id.',
      });
      return;
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

    const fishBase = normalizeFishApiBaseUrl(process.env.FISH_API_BASE_URL);
    const ttsEndpoint = `${fishBase}/v1/tts`;
    const modelHeader =
      (typeof req.headers.model === 'string' ? req.headers.model.trim() : '') ||
      DEFAULT_FISH_TTS_MODEL;

    console.info(
      `[Fish TTS Proxy:Express] POST ${ttsEndpoint} (model=${modelHeader}, hasReferenceId=${Boolean(validRefId)})`
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
    res.setHeader('X-Fish-Proxy', 'express');
    res.setHeader('X-Fish-Upstream-Url', ttsEndpoint);
    res.setHeader('X-Fish-Response-Url', responseUrl);

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      const cleanBody = sanitizeFishErrorText(errText, apiKey);
      const errorCode = upstream.headers.get('x-fish-error-code') || undefined;
      const errorSource = upstream.headers.get('x-fish-error-source') || undefined;
      console.warn(
        `[Fish TTS Proxy:Express] Upstream HTTP ${upstream.status} from ${responseUrl}: ${cleanBody}`
      );
      res.status(upstream.status).json({
        error: cleanBody || `Fish Audio TTS error (${upstream.status})`,
        rawBody: cleanBody,
        status: upstream.status,
        errorCode,
        errorSource,
        endpoint: ttsEndpoint,
        responseUrl,
      });
      return;
    }

    const arrayBuf = await upstream.arrayBuffer();
    res.setHeader('Content-Type', upstream.headers.get('Content-Type') || 'audio/mpeg');
    res.send(Buffer.from(arrayBuf));
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Fish Audio TTS proxy failed' });
  }
});

app.post('/api/fish/proxy/asr', uploadMem.single('audio'), async (req, res) => {
  try {
    const hasHeaderKey = req.headers['x-fish-api-key'] !== undefined;
    const headerKey =
      typeof req.headers['x-fish-api-key'] === 'string'
        ? normalizeFishApiKey(req.headers['x-fish-api-key'])
        : '';
    const apiKey = hasHeaderKey ? headerKey : normalizeFishApiKey(process.env.FISH_API_KEY);
    if (!apiKey) {
      res.status(401).json({ error: 'Fish Audio API key is required.' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'Audio file is required for Fish Audio ASR.' });
      return;
    }
    const fishBase = normalizeFishApiBaseUrl(process.env.FISH_API_BASE_URL);
    const formData = new FormData();
    const audioCopy = new Uint8Array(req.file.buffer);
    formData.append(
      'audio',
      new Blob([audioCopy], { type: req.file.mimetype || 'audio/mpeg' }),
      req.file.originalname || 'audio.mp3'
    );
    formData.append('ignore_timestamps', String(req.body?.ignore_timestamps ?? 'false'));
    if (typeof req.body?.language === 'string' && req.body.language.trim()) {
      formData.append('language', req.body.language.trim());
    }

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
      res.status(upstream.status).json({
        error: rawText.slice(0, 220) || `Fish Audio ASR error (${upstream.status})`,
      });
      return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(rawText);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Fish Audio ASR proxy failed' });
  }
});

// Rebuild merged dub track after manual timeline clip move/trim (uses existing on-disk MP3s, zero TTS calls)
app.post('/api/projects/:id/dubbing/rebuild-track', async (req, res) => {
  try {
    const generatedClips = Array.isArray(req.body?.generatedClips)
      ? req.body.generatedClips
      : undefined;
    const result = await rebuildFishDubTrackFromClips({
      projectId: req.params.id,
      generatedClips,
    });
    res.json(result);
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Saved Custom Fish Audio Voices CRUD (persisted globally in SQLite app_settings)
app.get('/api/fish/saved-voices', (_req, res) => {
  res.json({ voices: getSavedFishVoices() });
});

app.post('/api/fish/saved-voices/validate', async (req, res) => {
  try {
    const voiceId = String(req.body?.voiceId || '').trim();
    const result = await validateFishVoiceId(voiceId);
    res.json(result);
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/fish/saved-voices/preview', async (req, res) => {
  try {
    const voiceId = typeof req.body?.voiceId === 'string' ? req.body.voiceId.trim() : undefined;
    const text =
      String(req.body?.text || '').trim() ||
      'Everything changed the moment the vault door swung open in silence.';
    const preview = await generateFishVoicePreview({
      projectId: 'global-voice-preview',
      text,
      referenceId: voiceId || undefined,
      speakingSpeed: 1.0,
    });
    res.json({ audioUrl: preview.audioUrl });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/fish/saved-voices', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const voiceId = String(req.body?.voiceId || '').trim();
    const description =
      typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    const language =
      typeof req.body?.language === 'string' ? req.body.language.trim() : '';
    const sampleUrl =
      typeof req.body?.sampleUrl === 'string' ? req.body.sampleUrl.trim() : '';
    const previewText =
      typeof req.body?.previewText === 'string' ? req.body.previewText.trim() : '';
    const setDefault = Boolean(req.body?.isDefault);
    const skipRemoteValidation = Boolean(req.body?.skipRemoteValidation);

    if (!name) {
      res.status(400).json({ error: 'Narrator name is required.' });
      return;
    }
    if (!voiceId) {
      res.status(400).json({ error: 'Fish Audio Voice ID is required.' });
      return;
    }

    let validated = Boolean(req.body?.validated);
    let validationMessage = validated
      ? 'Verified Fish Audio Voice ID.'
      : 'Saved without remote verification.';
    if (!skipRemoteValidation) {
      const check = await validateFishVoiceId(voiceId);
      validated = check.checked && check.valid;
      validationMessage = check.message;
    }

    const now = new Date().toISOString();
    const existing = getSavedFishVoices();
    const newVoice = {
      id: uuidv4(),
      name,
      voiceId,
      ...(description ? { description } : {}),
      ...(language ? { language } : {}),
      ...(sampleUrl ? { sampleUrl } : {}),
      ...(previewText ? { previewText } : {}),
      validated,
      isDefault: setDefault || existing.length === 0,
      createdAt: now,
      updatedAt: now,
    };

    const next = existing
      .map((v) => (newVoice.isDefault ? { ...v, isDefault: false } : v))
      .concat(newVoice);

    saveSavedFishVoices(next);
    res.status(201).json({ voice: newVoice, voices: next, validationMessage });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.patch('/api/fish/saved-voices/:id', async (req, res) => {
  try {
    const existing = getSavedFishVoices();
    const found = existing.find((v) => v.id === req.params.id);
    if (!found) {
      res.status(404).json({ error: 'Saved voice not found.' });
      return;
    }

    const name =
      req.body?.name !== undefined ? String(req.body.name).trim() : found.name;
    const voiceId =
      req.body?.voiceId !== undefined ? String(req.body.voiceId).trim() : found.voiceId;
    const isDefault =
      req.body?.isDefault !== undefined ? Boolean(req.body.isDefault) : found.isDefault;
    const description =
      req.body?.description !== undefined
        ? String(req.body.description || '').trim()
        : found.description;
    const language =
      req.body?.language !== undefined ? String(req.body.language || '').trim() : found.language;
    const sampleUrl =
      req.body?.sampleUrl !== undefined
        ? String(req.body.sampleUrl || '').trim()
        : found.sampleUrl;
    const previewText =
      req.body?.previewText !== undefined
        ? String(req.body.previewText || '').trim()
        : found.previewText;

    if (!name || !voiceId) {
      res.status(400).json({ error: 'Both narrator name and Fish Audio Voice ID are required.' });
      return;
    }

    let validated =
      req.body?.validated !== undefined ? Boolean(req.body.validated) : found.validated;
    if (voiceId !== found.voiceId && !req.body?.skipRemoteValidation) {
      const check = await validateFishVoiceId(voiceId);
      validated = check.checked && check.valid;
    }

    const now = new Date().toISOString();
    const next = existing.map((v) => {
      if (v.id === req.params.id) {
        return {
          ...v,
          name,
          voiceId,
          description: description || undefined,
          language: language || undefined,
          sampleUrl: sampleUrl || undefined,
          previewText: previewText || undefined,
          validated,
          isDefault,
          updatedAt: now,
        };
      }
      return isDefault ? { ...v, isDefault: false } : v;
    });

    saveSavedFishVoices(next);
    const updated = next.find((v) => v.id === req.params.id)!;
    res.json({ voice: updated, voices: next });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/fish/saved-voices/:id/duplicate', (req, res) => {
  const existing = getSavedFishVoices();
  const found = existing.find((v) => v.id === req.params.id);
  if (!found) {
    res.status(404).json({ error: 'Saved voice not found.' });
    return;
  }
  const now = new Date().toISOString();
  const copy = {
    ...found,
    id: uuidv4(),
    name: `${found.name} (Copy)`,
    isDefault: false,
    createdAt: now,
    updatedAt: now,
  };
  const next = [...existing, copy];
  saveSavedFishVoices(next);
  res.status(201).json({ voice: copy, voices: next });
});

app.delete('/api/fish/saved-voices/:id', (req, res) => {
  const existing = getSavedFishVoices();
  const next = existing.filter((v) => v.id !== req.params.id);
  if (next.length === existing.length) {
    res.status(404).json({ error: 'Saved voice not found.' });
    return;
  }
  if (next.length > 0 && !next.some((v) => v.isDefault)) {
    next[0] = { ...next[0], isDefault: true };
  }
  saveSavedFishVoices(next);
  res.json({ deleted: true, voices: next });
});

// Default Studio Preferences (Style Auto-Apply & Narration Defaults)
app.get('/api/settings/preferences', (_req, res) => {
  const preferences = getDefaultStudioPreferences();
  const defaultStyle = preferences.defaultStyleId ? getPreset(preferences.defaultStyleId) : null;
  res.json({ preferences, defaultStyle });
});

app.patch('/api/settings/preferences', (req, res) => {
  const nextPrefs = saveDefaultStudioPreferences(req.body || {});
  if (req.body?.defaultStyleId !== undefined) {
    const allStyles = listPresets('style');
    for (const st of allStyles) {
      const shouldBeDefault = Boolean(nextPrefs.defaultStyleId && st.id === nextPrefs.defaultStyleId);
      if (Boolean(st.isDefault) !== shouldBeDefault) {
        updatePreset(st.id, { isDefault: shouldBeDefault });
      }
    }
  }
  const defaultStyle = nextPrefs.defaultStyleId ? getPreset(nextPrefs.defaultStyleId) : null;
  res.json({ preferences: nextPrefs, defaultStyle });
});

app.post('/api/system/cleanup', (_req, res) => {
  const hours = Number(process.env.TEMP_RETENTION_HOURS || '24');
  const result = cleanupTempStorage(hours);
  res.json(result);
});

// Custom Fonts & Built-in Font Catalog / Resolution
app.get('/api/fonts', (_req, res) => {
  res.json({ fonts: listCustomFonts() });
});

app.get('/api/fonts/catalog', (_req, res) => {
  res.json({ builtin: BUILTIN_FONT_CATALOG, custom: listCustomFonts() });
});

app.get('/api/fonts/ensure', async (req, res) => {
  const family = typeof req.query.family === 'string' ? req.query.family : '';
  const weight = Number(req.query.weight || 700);
  const italic = req.query.italic === '1' || req.query.italic === 'true';
  try {
    const result = await ensureFontAvailable({ family, weight, italic });
    res.json(result);
  } catch (err) {
    res.json({
      available: false,
      family,
      resolvedWeight: weight,
      italic,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post('/api/fonts', uploadMem.single('file'), (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No font file uploaded.' });
      return;
    }
    const customFamily = typeof req.body?.family === 'string' ? req.body.family : undefined;
    const saved = saveFontFile(req.file.originalname, req.file.buffer, customFamily);
    const font = registerCustomFont({
      id: uuidv4(),
      family: saved.family,
      filename: saved.filename,
      filePath: saved.filePath,
      url: saved.url,
    });
    res.status(201).json({
      font,
      fonts: listCustomFonts(),
      exportCompatible: !/\.woff2?$/i.test(saved.filename),
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete('/api/fonts/:id', (req, res) => {
  const deleted = deleteCustomFont(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Custom font not found.' });
    return;
  }
  res.json({ deleted: true, fonts: listCustomFonts() });
});

function saveStyleThumbnailDataUrl(dataUrl?: string): string | undefined {
  if (!dataUrl || typeof dataUrl !== 'string') return undefined;
  const trimmed = dataUrl.trim();
  if (!trimmed.startsWith('data:image/')) {
    return trimmed.startsWith('/media/') ? trimmed : undefined;
  }
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i.exec(trimmed);
  if (!match) return undefined;
  const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length === 0 || buf.length > 6 * 1024 * 1024) return undefined;
  const filename = `style_thumb_${uuidv4().slice(0, 12)}.${ext}`;
  const filePath = path.join(THUMBS_DIR, filename);
  fs.writeFileSync(filePath, buf);
  const url = `/media/thumbs/${filename}`;
  registerAsset({
    id: uuidv4(),
    projectId: null,
    kind: 'thumbnail',
    filename,
    filePath,
    url,
    mimeType: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg',
    sizeBytes: buf.length,
  });
  return url;
}

// Unified Persistent Preset Library CRUD + Import/Export
app.get('/api/presets', (req, res) => {
  const cat = req.query.category as PresetCategory | undefined;
  const presets = listPresets(
    cat && ['caption', 'filter', 'editing', 'style'].includes(cat) ? cat : undefined
  );
  res.json({ presets });
});

app.get('/api/presets/export', (_req, res) => {
  const presets = listPresets();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="recap_studio_presets.json"');
  res.send(JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), presets }, null, 2));
});

app.post('/api/presets/import', (req, res) => {
  try {
    const incoming = Array.isArray(req.body?.presets)
      ? req.body.presets
      : Array.isArray(req.body)
      ? req.body
      : [];
    if (incoming.length === 0) {
      res.status(400).json({ error: 'Provide a valid presets array in the JSON payload.' });
      return;
    }
    const imported: StudioPreset[] = [];
    for (const raw of incoming) {
      if (!raw || !raw.name || !['caption', 'filter', 'editing', 'style'].includes(raw.category)) {
        continue;
      }
      const cleanPayload =
        raw.category === 'style'
          ? (sanitizeSavedStylePayload(raw.payload) as unknown as Record<string, unknown>)
          : raw.payload && typeof raw.payload === 'object'
          ? raw.payload
          : {};
      const created = createPreset({
        id: uuidv4(),
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
    res.status(201).json({ importedCount: imported.length, imported, presets: listPresets() });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/presets', (req, res) => {
  try {
    const category = req.body?.category as PresetCategory;
    const name = String(req.body?.name || '').trim();
    if (!['caption', 'filter', 'editing', 'style'].includes(category)) {
      res.status(400).json({ error: 'Valid preset category required (caption | filter | editing | style).' });
      return;
    }
    if (!name) {
      res.status(400).json({ error: 'Preset name is required.' });
      return;
    }
    const cleanPayload =
      category === 'style'
        ? (sanitizeSavedStylePayload(req.body?.payload) as unknown as Record<string, unknown>)
        : req.body?.payload || {};
    const preset = createPreset({
      id: uuidv4(),
      category,
      name,
      description: typeof req.body?.description === 'string' ? req.body.description : '',
      isDefault: Boolean(req.body?.isDefault),
      thumbnailStyle: req.body?.thumbnailStyle || {},
      payload: cleanPayload,
      assetRefs: Array.isArray(req.body?.assetRefs) ? req.body.assetRefs : [],
    });
    res.status(201).json({ preset, presets: listPresets() });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.patch('/api/presets/:id', (req, res) => {
  const existing = getPreset(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Preset not found.' });
    return;
  }
  const cleanPayload =
    existing.category === 'style' && req.body?.payload !== undefined
      ? (sanitizeSavedStylePayload(req.body.payload) as unknown as Record<string, unknown>)
      : req.body?.payload;
  const updated = updatePreset(req.params.id, {
    name: req.body?.name,
    description: req.body?.description,
    isDefault: req.body?.isDefault,
    thumbnailStyle: req.body?.thumbnailStyle,
    payload: cleanPayload,
    assetRefs: req.body?.assetRefs,
  });
  res.json({ preset: updated, presets: listPresets() });
});

app.delete('/api/presets/:id', (req, res) => {
  const existing = getPreset(req.params.id);
  const ok = deletePreset(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'Preset not found.' });
    return;
  }
  if (existing?.category === 'style') {
    const prefs = getDefaultStudioPreferences();
    if (prefs.defaultStyleId === existing.id) {
      saveDefaultStudioPreferences({ defaultStyleId: null });
    }
  }
  res.json({ deleted: true, presets: listPresets() });
});

// Complete Saved Styles ("MY STYLES") CRUD + Non-destructive Application
app.get('/api/styles', (_req, res) => {
  const styles = listPresets('style');
  const prefs = getDefaultStudioPreferences();
  res.json({
    styles,
    defaultStyleId:
      prefs.defaultStyleId && styles.some((s) => s.id === prefs.defaultStyleId)
        ? prefs.defaultStyleId
        : styles.find((s) => s.isDefault)?.id || null,
  });
});

app.post('/api/styles', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) {
      res.status(400).json({ error: 'Style name is required.' });
      return;
    }
    const description =
      typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    const isDefault = Boolean(req.body?.isDefault);
    const savedThumbUrl = saveStyleThumbnailDataUrl(req.body?.thumbnailDataUrl);

    let payloadObj: Record<string, unknown>;
    let thumbnailStyle = req.body?.thumbnailStyle || {};
    let assetRefs: StudioPresetAssetRef[] = Array.isArray(req.body?.assetRefs)
      ? req.body.assetRefs
      : [];

    if (typeof req.body?.projectId === 'string' && req.body.projectId.trim()) {
      const sourceProject = getProject(req.body.projectId.trim());
      if (!sourceProject) {
        res.status(404).json({ error: 'Source project not found.' });
        return;
      }
      const built = buildSavedStylePayloadFromProject(sourceProject, {
        savedVoices: getSavedFishVoices(),
        thumbnailImageUrl: savedThumbUrl || req.body?.thumbnailImageUrl,
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
        ...(req.body?.payload || {}),
        ...(savedThumbUrl ? { thumbnailImageUrl: savedThumbUrl } : {}),
      });
      payloadObj = sanitized as unknown as Record<string, unknown>;
      if (savedThumbUrl) {
        thumbnailStyle = { ...thumbnailStyle, imageUrl: savedThumbUrl };
      }
    }

    const style = createPreset({
      id: uuidv4(),
      category: 'style',
      name,
      description,
      isDefault,
      thumbnailStyle,
      payload: payloadObj,
      assetRefs,
    });

    if (isDefault) {
      saveDefaultStudioPreferences({ defaultStyleId: style.id });
    }

    res.status(201).json({ style, styles: listPresets('style') });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.patch('/api/styles/:id', (req, res) => {
  const existing = getPreset(req.params.id);
  if (!existing || existing.category !== 'style') {
    res.status(404).json({ error: 'Saved style not found.' });
    return;
  }

  const savedThumbUrl = saveStyleThumbnailDataUrl(req.body?.thumbnailDataUrl);
  let nextPayload = existing.payload;
  let nextThumbnailStyle = existing.thumbnailStyle || {};
  let nextAssetRefs = existing.assetRefs || [];

  if (typeof req.body?.fromProjectId === 'string' && req.body.fromProjectId.trim()) {
    const srcProj = getProject(req.body.fromProjectId.trim());
    if (!srcProj) {
      res.status(404).json({ error: 'Source project not found.' });
      return;
    }
    const built = buildSavedStylePayloadFromProject(srcProj, {
      savedVoices: getSavedFishVoices(),
      thumbnailImageUrl:
        savedThumbUrl ||
        req.body?.thumbnailImageUrl ||
        (existing.payload as { thumbnailImageUrl?: string })?.thumbnailImageUrl,
    });
    nextPayload = built.payload as unknown as Record<string, unknown>;
    nextThumbnailStyle = built.thumbnailStyle;
    nextAssetRefs = built.assetRefs;
  } else if (req.body?.payload !== undefined) {
    nextPayload = sanitizeSavedStylePayload({
      ...req.body.payload,
      ...(savedThumbUrl ? { thumbnailImageUrl: savedThumbUrl } : {}),
    }) as unknown as Record<string, unknown>;
  } else if (savedThumbUrl) {
    nextPayload = sanitizeSavedStylePayload({
      ...existing.payload,
      thumbnailImageUrl: savedThumbUrl,
    }) as unknown as Record<string, unknown>;
  }

  if (req.body?.thumbnailStyle && typeof req.body.thumbnailStyle === 'object') {
    nextThumbnailStyle = { ...nextThumbnailStyle, ...req.body.thumbnailStyle };
  }
  if (savedThumbUrl) {
    nextThumbnailStyle = { ...nextThumbnailStyle, imageUrl: savedThumbUrl };
  }

  const updated = updatePreset(existing.id, {
    name: typeof req.body?.name === 'string' ? req.body.name : existing.name,
    description:
      typeof req.body?.description === 'string'
        ? req.body.description
        : existing.description || '',
    isDefault:
      req.body?.isDefault !== undefined ? Boolean(req.body.isDefault) : existing.isDefault,
    thumbnailStyle: nextThumbnailStyle,
    payload: nextPayload,
    assetRefs: Array.isArray(req.body?.assetRefs) ? req.body.assetRefs : nextAssetRefs,
  })!;

  if (req.body?.isDefault !== undefined) {
    const prefs = getDefaultStudioPreferences();
    if (Boolean(req.body.isDefault)) {
      saveDefaultStudioPreferences({ defaultStyleId: updated.id });
    } else if (prefs.defaultStyleId === updated.id) {
      saveDefaultStudioPreferences({ defaultStyleId: null });
    }
  }

  res.json({ style: updated, styles: listPresets('style') });
});

app.post('/api/styles/:id/duplicate', (req, res) => {
  const existing = getPreset(req.params.id);
  if (!existing || existing.category !== 'style') {
    res.status(404).json({ error: 'Saved style not found.' });
    return;
  }
  const style = createPreset({
    id: uuidv4(),
    category: 'style',
    name: `${existing.name} (Copy)`,
    description: existing.description,
    isDefault: false,
    thumbnailStyle: existing.thumbnailStyle,
    payload: sanitizeSavedStylePayload(existing.payload) as unknown as Record<string, unknown>,
    assetRefs: existing.assetRefs,
  });
  res.status(201).json({ style, styles: listPresets('style') });
});

app.delete('/api/styles/:id', (req, res) => {
  const existing = getPreset(req.params.id);
  if (!existing || existing.category !== 'style') {
    res.status(404).json({ error: 'Saved style not found.' });
    return;
  }
  deletePreset(existing.id);
  const prefs = getDefaultStudioPreferences();
  if (prefs.defaultStyleId === existing.id) {
    saveDefaultStudioPreferences({ defaultStyleId: null });
  }
  res.json({ deleted: true, styles: listPresets('style') });
});

app.post('/api/projects/:id/apply-style', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const styleId = String(req.body?.styleId || '').trim();
  const style = getPreset(styleId);
  if (!style || style.category !== 'style') {
    res.status(404).json({ error: 'Saved style not found' });
    return;
  }
  const rawScope = String(req.body?.scope || 'all');
  const scope: StyleApplyScope =
    rawScope === 'filters' ||
    rawScope === 'effects' ||
    rawScope === 'captions' ||
    rawScope === 'narration'
      ? rawScope
      : 'all';

  const result = applySavedStyleToProjectData({
    project,
    style,
    scope,
    savedVoices: getSavedFishVoices(),
    checkAssetAvailable: checkAssetAvailableByUrl,
    generateId: uuidv4,
    preserveCaptionEnabledState: true,
  });

  const updated =
    Object.keys(result.patch).length > 0 ? updateProject(project.id, result.patch)! : project;
  res.json({
    project: updated,
    warnings: result.warnings,
    voiceMissingWarning: result.voiceMissingWarning,
  });
});

function applyPresetIdsToProject(
  project: Project,
  opts: {
    captionPresetId?: string | null;
    filterPresetId?: string | null;
    editingPresetId?: string | null;
    applyDefaults?: boolean;
    preserveCaptionEnabledState?: boolean;
  }
): { patch: Partial<Project>; warnings: Array<{ presetName: string; missingAssets: StudioPresetAssetRef[] }> } {
  const allPresets = listPresets();
  const resolvePreset = (cat: PresetCategory, explicitId?: string | null): StudioPreset | undefined => {
    if (explicitId === 'none') return undefined;
    if (explicitId) return getPreset(explicitId) || undefined;
    if (opts.applyDefaults) {
      return allPresets.find((p) => p.category === cat && p.isDefault);
    }
    return undefined;
  };

  const capPreset = resolvePreset('caption', opts.captionPresetId);
  const filPreset = resolvePreset('filter', opts.filterPresetId);
  const edtPreset = resolvePreset('editing', opts.editingPresetId);

  const patch: Partial<Project> = {};
  const warnings: Array<{ presetName: string; missingAssets: StudioPresetAssetRef[] }> = [];

  if (capPreset) {
    const pStyle = (capPreset.payload?.subtitleStyle || capPreset.payload || {}) as Record<string, unknown>;
    const missingFont = (capPreset.missingAssets || []).filter((a) => a.kind === 'font');
    if (missingFont.length > 0) {
      warnings.push({ presetName: capPreset.name, missingAssets: missingFont });
    }
    const nextFontUrl =
      typeof pStyle.customFontUrl === 'string' && !checkAssetAvailableByUrl(pStyle.customFontUrl)
        ? undefined
        : (pStyle.customFontUrl as string | undefined);
    patch.subtitleStyle = {
      ...DEFAULT_SUBTITLE_STYLE,
      ...project.subtitleStyle,
      ...(pStyle as Partial<Project['subtitleStyle']>),
      customFontUrl: nextFontUrl,
      // Strict rule: never auto-enable captions when applying preset to a brand new video with 0 segments
      enabled: opts.preserveCaptionEnabledState
        ? Boolean(project.subtitleStyle.enabled)
        : Boolean(project.captions.length > 0 && (pStyle.enabled ?? project.subtitleStyle.enabled)),
    };
  }

  if (filPreset) {
    const pFx = (filPreset.payload?.videoEffects || filPreset.payload || {}) as Partial<Project['videoEffects']>;
    patch.videoEffects = {
      ...DEFAULT_VIDEO_EFFECTS,
      ...project.videoEffects,
      ...pFx,
    };
  }

  if (edtPreset) {
    const pEdt = edtPreset.payload as {
      canvas?: Partial<Project['canvas']>;
      exportSettings?: Partial<Project['exportSettings']>;
      logos?: Project['logos'];
    };
    const missing = edtPreset.missingAssets || [];
    if (missing.length > 0) {
      warnings.push({ presetName: edtPreset.name, missingAssets: missing });
    }
    if (pEdt.canvas) {
      const nextCanvas = {
        ...DEFAULT_VIDEO_CANVAS,
        ...(project.canvas || {}),
        ...pEdt.canvas,
      };
      if (nextCanvas.bgImageUrl && !checkAssetAvailableByUrl(nextCanvas.bgImageUrl)) {
        nextCanvas.bgImageUrl = undefined;
      }
      patch.canvas = nextCanvas;
    }
    if (pEdt.exportSettings) {
      patch.exportSettings = {
        ...project.exportSettings,
        ...pEdt.exportSettings,
      };
    }
    if (Array.isArray(pEdt.logos)) {
      const validLogos = pEdt.logos
        .filter((l) => l && l.url && checkAssetAvailableByUrl(l.url))
        .map((l) => ({ ...l, id: uuidv4() }));
      if (validLogos.length > 0) {
        patch.logos = [...project.logos, ...validLogos];
      }
    }
  }

  return { patch, warnings };
}

// Projects CRUD
app.get('/api/projects', (_req, res) => {
  res.json({ projects: listProjects() });
});

app.post('/api/projects', (req, res) => {
  const name = String(req.body?.name || '').trim() || `Recap Project ${new Date().toLocaleDateString()}`;
  const created = createProject(uuidv4(), name);
  const { patch, warnings } = applyPresetIdsToProject(created, {
    captionPresetId: req.body?.captionPresetId,
    filterPresetId: req.body?.filterPresetId,
    editingPresetId: req.body?.editingPresetId,
    applyDefaults: Boolean(req.body?.applyDefaults),
    preserveCaptionEnabledState: false,
  });
  let finalProject = Object.keys(patch).length > 0 ? updateProject(created.id, patch)! : created;
  let voiceMissingWarning: StyleMissingVoiceWarning | null = null;

  const requestedStyleId =
    typeof req.body?.styleId === 'string' ? req.body.styleId.trim() : '';
  const prefs = getDefaultStudioPreferences();
  const autoDefaultId =
    req.body?.applyDefaultStyle !== false &&
    requestedStyleId !== 'none' &&
    prefs.autoApplyDefaultStyleOnImport &&
    prefs.defaultStyleId
      ? prefs.defaultStyleId
      : '';
  const effectiveStyleId =
    requestedStyleId && requestedStyleId !== 'none' ? requestedStyleId : autoDefaultId;

  if (effectiveStyleId) {
    const style = getPreset(effectiveStyleId);
    if (style && style.category === 'style') {
      const styleRes = applySavedStyleToProjectData({
        project: finalProject,
        style,
        scope: 'all',
        savedVoices: getSavedFishVoices(),
        checkAssetAvailable: checkAssetAvailableByUrl,
        generateId: uuidv4,
        preserveCaptionEnabledState: false,
      });
      if (Object.keys(styleRes.patch).length > 0) {
        finalProject = updateProject(finalProject.id, styleRes.patch)!;
      }
      warnings.push(...styleRes.warnings);
      voiceMissingWarning = styleRes.voiceMissingWarning;
    }
  }

  res.status(201).json({
    project: finalProject,
    presetWarnings: warnings,
    voiceMissingWarning,
  });
});

app.post('/api/projects/:id/apply-presets', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const { patch, warnings } = applyPresetIdsToProject(project, {
    captionPresetId: req.body?.captionPresetId,
    filterPresetId: req.body?.filterPresetId,
    editingPresetId: req.body?.editingPresetId,
    applyDefaults: false,
    preserveCaptionEnabledState: true,
  });
  const updated = Object.keys(patch).length > 0 ? updateProject(project.id, patch)! : project;
  res.json({ project: updated, presetWarnings: warnings });
});

app.get('/api/projects/:id', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  res.json({ project });
});

app.patch('/api/projects/:id', (req, res) => {
  const updated = updateProject(req.params.id, req.body || {});
  if (!updated) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  res.json({ project: updated });
});

app.delete('/api/projects/:id', (req, res) => {
  const ok = deleteProject(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  res.json({ deleted: true });
});


// Inspect Project Assets (SHA-256 + Size + Free 50 MB single-file cap check)
app.get('/api/projects/:id/asset-manifest', (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json(inspectProjectAssets(project));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// User-Requested Local FFmpeg Compression (ONLY when user clicks compress; preserves original file)
app.post('/api/projects/:id/compress-video', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const rawPreset = String(req.body?.preset || 'under-45mb');
    const preset: CompressionPreset =
      rawPreset === '720p-compact' || rawPreset === '480p-compact'
        ? rawPreset
        : 'under-45mb';
    const target = req.body?.target === 'final-export' ? 'final-export' : 'source';

    const { project: _p, ...result } = await compressProjectVideoForFreeCloud({ project, preset, target });
    const updated =
      target === 'final-export'
        ? updateProject(project.id, {
            lastExportUrl: result.compressedUrl,
            lastExportSize: result.compressedBytes,
            lastExportedAt: new Date().toISOString(),
          })
        : updateProject(project.id, {
            sourceVideoUrl: result.compressedUrl,
            sourceFilename: result.filename,
            metadata: result.metadata,
          });
    res.json({
      project: updated,
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});


// Generate a real FFmpeg-synthesized sample movie recap video for immediate pipeline testing
app.post('/api/projects/:id/sample-video', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const clip = await createDemoMovieRecapClip(project.id);
    const metadata = await analyzeVideoFile(clip.filePath);
    const thumbnailUrl = await generateVideoThumbnail(clip.filePath, project.id, 2);
    const waveformPeaks = await extractWaveformPeaks(clip.filePath, metadata.hasAudio);

    const updated = updateProject(project.id, {
      sourceVideoUrl: clip.url,
      sourceFilename: clip.filename,
      thumbnailUrl,
      metadata,
      waveformPeaks,
      videoClips: [
        {
          id: 'vclip_main',
          label: clip.filename,
          sourceStart: 0,
          sourceEnd: Math.max(0.5, metadata.duration || 12),
          timelineStart: 0,
          speed: 1.0,
          audioUnlinked: false,
        },
      ],
      originalAudioClips: [],
    });
    if (!updated) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    res.json({ project: updated });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Chunked Video Upload Flow
app.post('/api/uploads/init', (req, res) => {
  try {
    const { projectId: rawProjectId, filename, totalSize, totalChunks } = req.body || {};
    const projectId = normalizeProjectId(rawProjectId);
    if (!projectId) {
      res.status(400).json({ error: 'Invalid or missing projectId.', code: 'INVALID_PROJECT_ID' });
      return;
    }
    if (!filename || !totalSize || !totalChunks) {
      res.status(400).json({ error: 'Missing required chunk initialization parameters.', code: 'INVALID_PARAMS' });
      return;
    }

    let project: Project | null = null;
    try {
      project = getProject(projectId);
    } catch (dbErr) {
      res.status(500).json({
        error: `Database lookup failed: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
        code: 'DATABASE_ERROR',
      });
      return;
    }
    if (!project) {
      res.status(404).json({ error: 'Project not found.', code: 'PROJECT_NOT_FOUND' });
      return;
    }

    const session = initChunkedUpload({
      projectId: project.id,
      filename: String(filename),
      totalSize: Number(totalSize),
      totalChunks: Number(totalChunks),
    });

    res.json({ uploadId: session.uploadId, totalChunks: session.totalChunks, projectId: project.id });
  } catch (err) {
    const status = err instanceof UploadValidationError ? err.statusCode : 400;
    const code = err instanceof UploadValidationError ? err.code : 'UPLOAD_INIT_FAILED';
    res.status(status).json({ error: err instanceof Error ? err.message : String(err), code });
  }
});

app.post('/api/uploads/:uploadId/chunk', (req, res) => {
  try {
    const chunkIndex = Number(req.query.index);
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({
        error: 'Expected binary application/octet-stream chunk payload.',
        code: 'INVALID_CHUNK_PAYLOAD',
      });
      return;
    }
    const progress = saveUploadChunk(req.params.uploadId, chunkIndex, req.body);
    res.json(progress);
  } catch (err) {
    const status = err instanceof UploadValidationError ? err.statusCode : 400;
    const code = err instanceof UploadValidationError ? err.code : 'CHUNK_UPLOAD_FAILED';
    res.status(status).json({ error: err instanceof Error ? err.message : String(err), code });
  }
});

app.post('/api/uploads/:uploadId/complete', async (req, res) => {
  try {
    const session = getChunkSession(req.params.uploadId);
    if (!session) {
      res.status(404).json({ error: 'Upload session not found.', code: 'UPLOAD_SESSION_NOT_FOUND' });
      return;
    }

    const requestedProjectId = normalizeProjectId(req.body?.projectId);
    const projectId = requestedProjectId || session.projectId;
    if (!projectId) {
      res.status(400).json({ error: 'Invalid or missing projectId.', code: 'INVALID_PROJECT_ID' });
      return;
    }
    if (session.projectId !== projectId) {
      res.status(400).json({
        error: 'Upload session does not belong to the specified project.',
        code: 'PROJECT_ID_MISMATCH',
      });
      return;
    }

    let existingProj: Project | null = null;
    try {
      existingProj = getProject(projectId);
    } catch (dbErr) {
      res.status(500).json({
        error: `Database lookup failed: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
        code: 'DATABASE_ERROR',
      });
      return;
    }
    if (!existingProj) {
      res.status(404).json({ error: 'Project not found.', code: 'PROJECT_NOT_FOUND' });
      return;
    }

    const uploaded = await finalizeChunkedUpload(req.params.uploadId);
    const metadata = await analyzeVideoFile(uploaded.filePath);
    const thumbnailUrl = await generateVideoThumbnail(
      uploaded.filePath,
      projectId,
      Math.min(2, Math.max(0.2, metadata.duration * 0.15))
    );
    const waveformPeaks = await extractWaveformPeaks(uploaded.filePath, metadata.hasAudio);

    const updated = updateProject(projectId, {
      sourceVideoUrl: uploaded.url,
      sourceFilename: uploaded.filename,
      thumbnailUrl,
      metadata,
      waveformPeaks,
      videoClips: [
        {
          id: 'vclip_main',
          label: uploaded.filename,
          sourceStart: 0,
          sourceEnd: Math.max(0.5, metadata.duration || 12),
          timelineStart: 0,
          speed: 1.0,
          audioUnlinked: false,
        },
      ],
      originalAudioClips: [],
      exportSettings: {
        ...existingProj.exportSettings,
        aspectRatio: existingProj.exportSettings.aspectRatio || 'original',
      },
    });
    if (!updated) {
      res.status(404).json({ error: 'Project not found.', code: 'PROJECT_NOT_FOUND' });
      return;
    }

    res.json({ project: updated, metadata });
  } catch (err) {
    const status = err instanceof UploadValidationError ? err.statusCode : 400;
    const code = err instanceof UploadValidationError ? err.code : 'UPLOAD_FINALIZE_FAILED';
    res.status(status).json({ error: err instanceof Error ? err.message : String(err), code });
  }
});

// Direct Video Upload (Single-request multipart upload with Multer)
app.post('/api/projects/:id/video', uploadMem.single('file'), async (req, res) => {
  try {
    const projectId = normalizeProjectId(req.params.id);
    if (!projectId) {
      res.status(400).json({ error: 'Invalid or missing projectId.', code: 'INVALID_PROJECT_ID' });
      return;
    }

    let project: Project | null = null;
    try {
      project = getProject(projectId);
    } catch (dbErr) {
      res.status(500).json({
        error: `Database lookup failed: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
        code: 'DATABASE_ERROR',
      });
      return;
    }
    if (!project) {
      res.status(404).json({ error: 'Project not found.', code: 'PROJECT_NOT_FOUND' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No video file provided.', code: 'NO_FILE_PROVIDED' });
      return;
    }
    const uploaded = saveDirectVideoFile(project.id, req.file.originalname, req.file.buffer);
    const metadata = await analyzeVideoFile(uploaded.filePath);
    const thumbnailUrl = await generateVideoThumbnail(
      uploaded.filePath,
      project.id,
      Math.min(2, Math.max(0.2, metadata.duration * 0.15))
    );
    const waveformPeaks = await extractWaveformPeaks(uploaded.filePath, metadata.hasAudio);

    const updated = updateProject(project.id, {
      sourceVideoUrl: uploaded.url,
      sourceFilename: uploaded.filename,
      thumbnailUrl,
      metadata,
      waveformPeaks,
      videoClips: [
        {
          id: 'vclip_main',
          label: uploaded.filename,
          sourceStart: 0,
          sourceEnd: Math.max(0.5, metadata.duration || 12),
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
    if (!updated) {
      res.status(404).json({ error: 'Project not found.', code: 'PROJECT_NOT_FOUND' });
      return;
    }

    res.json({ project: updated, metadata });
  } catch (err) {
    const status = err instanceof UploadValidationError ? err.statusCode : 400;
    const code = err instanceof UploadValidationError ? err.code : 'DIRECT_UPLOAD_FAILED';
    res.status(status).json({ error: err instanceof Error ? err.message : String(err), code });
  }
});

app.post('/api/upload', uploadMem.single('file'), async (req, res) => {
  try {
    const projectId = normalizeProjectId(req.body?.projectId || req.query?.projectId);
    if (!projectId) {
      res.status(400).json({ error: 'Invalid or missing projectId.', code: 'INVALID_PROJECT_ID' });
      return;
    }

    let project: Project | null = null;
    try {
      project = getProject(projectId);
    } catch (dbErr) {
      res.status(500).json({
        error: `Database lookup failed: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
        code: 'DATABASE_ERROR',
      });
      return;
    }
    if (!project) {
      res.status(404).json({ error: 'Project not found.', code: 'PROJECT_NOT_FOUND' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No video file provided.', code: 'NO_FILE_PROVIDED' });
      return;
    }
    const uploaded = saveDirectVideoFile(project.id, req.file.originalname, req.file.buffer);
    const metadata = await analyzeVideoFile(uploaded.filePath);
    const thumbnailUrl = await generateVideoThumbnail(
      uploaded.filePath,
      project.id,
      Math.min(2, Math.max(0.2, metadata.duration * 0.15))
    );
    const waveformPeaks = await extractWaveformPeaks(uploaded.filePath, metadata.hasAudio);

    const updated = updateProject(project.id, {
      sourceVideoUrl: uploaded.url,
      sourceFilename: uploaded.filename,
      thumbnailUrl,
      metadata,
      waveformPeaks,
      videoClips: [
        {
          id: 'vclip_main',
          label: uploaded.filename,
          sourceStart: 0,
          sourceEnd: Math.max(0.5, metadata.duration || 12),
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
    if (!updated) {
      res.status(404).json({ error: 'Project not found.', code: 'PROJECT_NOT_FOUND' });
      return;
    }

    res.json({ project: updated, metadata });
  } catch (err) {
    const status = err instanceof UploadValidationError ? err.statusCode : 400;
    const code = err instanceof UploadValidationError ? err.code : 'DIRECT_UPLOAD_FAILED';
    res.status(status).json({ error: err instanceof Error ? err.message : String(err), code });
  }
});

// Logo PNG/SVG Upload
app.post('/api/projects/:id/logo', uploadMem.single('file'), (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No logo file uploaded' });
      return;
    }
    const saved = saveLogoFile(project.id, req.file.originalname, req.file.buffer);
    const newLogo = {
      id: uuidv4(),
      filename: saved.filename,
      url: saved.url,
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
    const updated = updateProject(project.id, {
      logos: [...project.logos, newLogo],
    });
    res.json({ project: updated, logo: newLogo });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Canvas Background Image Upload (PNG/JPG/JPEG/WEBP)
app.post('/api/projects/:id/canvas-bg', uploadMem.single('file'), (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No background image file uploaded' });
      return;
    }
    const saved = saveCanvasBackgroundFile(
      project.id,
      req.file.originalname,
      req.file.buffer
    );
    const updated = updateProject(project.id, {
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
        bgImageUrl: saved.url,
        bgImageFilename: saved.filename,
      },
    });
    res.json({ project: updated, url: saved.url, filename: saved.filename });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Background Music Upload
app.post('/api/projects/:id/music', uploadMem.single('file'), (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No audio file uploaded' });
      return;
    }
    const saved = saveMusicFile(project.id, req.file.originalname, req.file.buffer);
    const updated = updateProject(project.id, {
      voice: {
        ...project.voice,
        bgMusicFilename: saved.filename,
        bgMusicUrl: saved.url,
        bgMusicEnabled: true,
        bgMusicMuted: false,
        bgMusicVolume: project.voice.bgMusicVolume > 0.01 ? project.voice.bgMusicVolume : 0.25,
      },
    });
    res.json({ project: updated });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Sound Effects (SFX) Upload
app.post('/api/projects/:id/sfx', uploadMem.single('file'), (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No SFX audio file uploaded' });
      return;
    }
    const saved = saveSfxFile(project.id, req.file.originalname, req.file.buffer);
    const updated = updateProject(project.id, {
      voice: {
        ...project.voice,
        sfxFilename: saved.filename,
        sfxUrl: saved.url,
        sfxEnabled: true,
        sfxMuted: false,
        sfxVolume: project.voice.sfxVolume ?? 1.0,
      },
    });
    res.json({ project: updated });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Background Segmentation Mask PNG Upload
app.post('/api/projects/:id/mask', (req, res) => {
  try {
    const { blurId, maskBase64 } = req.body || {};
    if (!blurId || !maskBase64) {
      res.status(400).json({ error: 'blurId and maskBase64 are required' });
      return;
    }
    const saved = saveSegmentationMaskImage(req.params.id, blurId, maskBase64);
    res.json({ maskUrl: saved.url, assetId: saved.assetId });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Original Burned-in Caption Region Detection (multi-frame visual + optional Gemini OCR)
app.post('/api/projects/:id/blurs/detect-captions', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project || !project.sourceVideoUrl || !project.metadata) {
      res.status(404).json({ error: 'Upload a video before detecting original captions.' });
      return;
    }
    const asset = getAssetByUrl(project.sourceVideoUrl);
    if (!asset || !fs.existsSync(asset.file_path)) {
      res.status(404).json({ error: 'Source video file is missing on disk.' });
      return;
    }

    const result = await detectOriginalCaptionsInVideo({
      projectId: project.id,
      videoPath: asset.file_path,
      duration: project.metadata.duration,
      videoWidth: project.metadata.width,
      videoHeight: project.metadata.height,
    });

    const subtitleRemoval = {
      lastAnalyzedAt: new Date().toISOString(),
      ocrAvailable: result.ocrAvailable,
      method: result.method,
      analysisMessage: result.analysisMessage,
      framesAnalyzed: result.framesAnalyzed,
      detections: result.detections,
    };

    const updated = updateProject(project.id, { subtitleRemoval });
    res.json({
      project: updated,
      ...result,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// Audio Extraction
app.post('/api/projects/:id/audio/extract', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project || !project.sourceVideoUrl) {
      res.status(404).json({ error: 'Project video not found' });
      return;
    }
    if (!project.metadata?.hasAudio) {
      res.status(400).json({ error: 'Source video has no audio track' });
      return;
    }
    const asset = getAssetByUrl(project.sourceVideoUrl);
    if (!asset) {
      res.status(404).json({ error: 'Video asset missing on disk' });
      return;
    }
    const extractedPath = await extractAudioTrack(asset.file_path, project.id, 'wav');
    const filename = path.basename(extractedPath);
    res.json({
      audioUrl: `/media/audio/${filename}`,
      downloadUrl: `/media/audio/${filename}?download=1`,
      filename,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// AI Transcription (supports Fish Audio ASR or Gemini ASR)
app.post('/api/projects/:id/transcribe', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project || !project.sourceVideoUrl || !project.metadata) {
      res.status(404).json({ error: 'Upload a video before running AI transcription.' });
      return;
    }
    const asset = getAssetByUrl(project.sourceVideoUrl);
    if (!asset) {
      res.status(404).json({ error: 'Source video file not found.' });
      return;
    }

    const requestedProvider = req.body?.provider as 'fish' | 'gemini' | undefined;
    const useFish = requestedProvider === 'fish' || (!requestedProvider && isFishAudioConfigured());
    const sourceLanguage =
      typeof req.body?.sourceLanguage === 'string'
        ? req.body.sourceLanguage
        : project.translation.sourceLanguage;

    const result = useFish
      ? await transcribeVideoWithFishAudio({
          videoPath: asset.file_path,
          projectId: project.id,
          duration: project.metadata.duration,
          hasAudio: project.metadata.hasAudio,
          sourceLanguage,
        })
      : await transcribeVideoWithGemini({
          videoPath: asset.file_path,
          projectId: project.id,
          duration: project.metadata.duration,
          hasAudio: project.metadata.hasAudio,
        });

    const updated = updateProject(project.id, {
      captions: result.segments,
      translation: {
        ...project.translation,
        sourceLanguage: result.detectedLanguage,
      },
    });

    res.json({
      project: updated,
      detectedLanguage: result.detectedLanguage,
      segmentCount: result.segments.length,
    });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Dedicated Fish Audio ASR Transcription Route
app.post('/api/projects/:id/dubbing/transcribe', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project || !project.sourceVideoUrl || !project.metadata) {
      res.status(404).json({ error: 'Upload a video before running Fish Audio transcription.' });
      return;
    }
    const asset = getAssetByUrl(project.sourceVideoUrl);
    if (!asset) {
      res.status(404).json({ error: 'Source video file not found.' });
      return;
    }

    const sourceLanguage =
      typeof req.body?.sourceLanguage === 'string'
        ? req.body.sourceLanguage
        : project.translation.sourceLanguage;

    const result = await transcribeVideoWithFishAudio({
      videoPath: asset.file_path,
      projectId: project.id,
      duration: project.metadata.duration,
      hasAudio: project.metadata.hasAudio,
      sourceLanguage,
    });

    const updated = updateProject(project.id, {
      captions: result.segments,
      translation: {
        ...project.translation,
        sourceLanguage: result.detectedLanguage,
      },
    });

    res.json({
      project: updated,
      detectedLanguage: result.detectedLanguage,
      segmentCount: result.segments.length,
    });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Dedicated Fish Audio Voice Preview Route (s2.1-pro-free -> MP3)
app.post('/api/projects/:id/dubbing/preview', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const text = String(req.body?.text || '').trim();
    if (!text) {
      res.status(400).json({ error: 'Preview text is required' });
      return;
    }
    const referenceId =
      typeof req.body?.referenceId === 'string'
        ? req.body.referenceId
        : project.voice.fishReferenceId;
    const preview = await generateFishVoicePreview({
      projectId: project.id,
      text,
      referenceId,
      speakingSpeed: 1.0,
    });

    res.json({ audioUrl: preview.audioUrl });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Dedicated Fish Audio Full Synchronized Dubbing Route (Background Job: s2.1-pro-free -> segmented MP3s -> merged MP3)
app.post('/api/projects/:id/dubbing/generate', (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project || !project.metadata) {
      res.status(404).json({ error: 'Project video not found' });
      return;
    }

    const voiceConfig = {
      ...project.voice,
      ...(req.body?.voice || {}),
      provider: 'fish' as const,
      syncMode: normalizeSyncMode(req.body?.voice?.syncMode ?? project.voice.syncMode),
      continuousPauseMs: clampContinuousPauseMs(
        req.body?.voice?.continuousPauseMs ?? project.voice.continuousPauseMs
      ),
      speakingSpeed: 1.0,
      enabled: true,
    };

    const captions = Array.isArray(req.body?.captions) ? req.body.captions : project.captions;
    const useTranslated =
      req.body?.useTranslated !== undefined
        ? Boolean(req.body.useTranslated)
        : true;

    updateProject(project.id, {
      captions,
      voice: voiceConfig,
    });

    const job = enqueueFishDubJob({
      projectId: project.id,
      voiceConfig,
      captions,
      useTranslated,
    });

    res.status(202).json({ job });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Re-synchronize existing 1.0x MP3 clips under Continuous, Smart Gap Removal (Flexible), or Original duration mode
app.post('/api/projects/:id/dubbing/resync', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project || !project.metadata) {
      res.status(404).json({ error: 'Project video not found.' });
      return;
    }

    const syncMode: SyncMode = normalizeSyncMode(req.body?.syncMode ?? project.voice.syncMode);
    const continuousPauseMs = clampContinuousPauseMs(
      req.body?.continuousPauseMs ?? project.voice.continuousPauseMs
    );

    if (project.voice.generatedClips && project.voice.generatedClips.length > 0) {
      const resynced = await resyncExistingFishClips({
        projectId: project.id,
        captions: project.captions,
        voiceConfig: project.voice,
        originalDuration: project.metadata.duration,
        syncMode,
        continuousPauseMs,
      });

      const updated = updateProject(project.id, {
        voice: {
          ...project.voice,
          syncMode,
          continuousPauseMs,
          speakingSpeed: 1.0,
          generatedClips: resynced.clips,
          fullDubUrl: resynced.fullDubUrl,
          syncPlan: resynced.syncPlan,
        },
      });
      res.json({ project: updated });
      return;
    }

    const updated = updateProject(project.id, {
      voice: {
        ...project.voice,
        syncMode,
        continuousPauseMs,
        syncPlan: project.voice.syncPlan
          ? { ...project.voice.syncPlan, syncMode, pauseDurationMs: continuousPauseMs }
          : undefined,
      },
    });
    res.json({ project: updated });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Dubbing Diagnostic Report Route
app.get('/api/projects/:id/dubbing/diagnostic', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const report = generateDubDiagnosticReport(project);
    const fullTrackAudit = await inspectFullDubTrackDiagnostics(project).catch(() => null);
    res.json({ report, fullTrackAudit });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Selective Fish Audio Regeneration (Only regenerates specified corrected segment IDs, preserving passing clips & 1.0x speed)
app.post('/api/projects/:id/dubbing/regenerate-segments', async (req, res) => {
  try {
    const segmentIds = Array.isArray(req.body?.segmentIds) ? req.body.segmentIds : [];
    const result = await regenerateFishSegments({
      projectId: req.params.id,
      segmentIds,
      captions: Array.isArray(req.body?.captions) ? req.body.captions : undefined,
      voiceConfig: req.body?.voice,
      useTranslated:
        req.body?.useTranslated !== undefined ? Boolean(req.body.useTranslated) : undefined,
    });
    res.json(result);
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// AI Language Translation
app.post('/api/projects/:id/translate', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const targetLanguage = (req.body?.targetLanguage || project.translation.targetLanguage) as SupportedLanguage;
    const preserveProperNouns =
      req.body?.preserveProperNouns !== undefined
        ? Boolean(req.body.preserveProperNouns)
        : project.translation.preserveProperNouns;

    const translatedSegments = await translateCaptionsWithGemini({
      captions: project.captions,
      sourceLanguage: project.translation.sourceLanguage || 'Auto',
      targetLanguage,
      preserveProperNouns,
    });

    const updated = updateProject(project.id, {
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

    res.json({ project: updated });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// SRT / VTT Subtitle Export
app.get('/api/projects/:id/subtitles/:format', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const format = req.params.format.toLowerCase();
  if (format === 'srt') {
    const srt = generateSrtContent(project.captions, project.subtitleStyle);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${project.name.replace(/\s+/g, '_')}.srt"`);
    res.send(srt);
    return;
  }
  if (format === 'vtt') {
    const vtt = generateVttContent(project.captions, project.subtitleStyle);
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${project.name.replace(/\s+/g, '_')}.vtt"`);
    res.send(vtt);
    return;
  }
  res.status(400).json({ error: 'Supported formats: srt, vtt' });
});

// Import SRT / VTT Subtitle File
app.post('/api/projects/:id/captions/import', (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const rawContent = String(req.body?.content || '').trim();
    if (!rawContent) {
      res.status(400).json({ error: 'No subtitle content provided in request body' });
      return;
    }
    const parsed = parseSrtOrVtt(rawContent);
    if (parsed.length === 0) {
      res.status(400).json({ error: 'Could not parse any valid subtitle segments from file' });
      return;
    }
    const updated = updateProject(project.id, { captions: parsed });
    res.json({ project: updated, count: parsed.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// AI Voice Preview
app.post('/api/projects/:id/voice/preview', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const text = String(req.body?.text || '').trim();
    if (!text) {
      res.status(400).json({ error: 'Preview text is required' });
      return;
    }

    const preview = await generateSingleVoicePreview({
      projectId: project.id,
      text,
      voiceName: (req.body?.voiceName || project.voice.voiceName) as GeminiVoiceName,
      style: String(req.body?.style || project.voice.style),
      targetLanguage: (req.body?.targetLanguage || project.voice.targetLanguage) as SupportedLanguage,
      speakingSpeed: 1.0,
    });

    res.json({ audioUrl: preview.audioUrl });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// AI Voice Full Synchronized Dubbing
app.post('/api/projects/:id/voice/generate', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project || !project.metadata) {
      res.status(404).json({ error: 'Project video not found' });
      return;
    }

    const voiceConfig = {
      ...project.voice,
      ...(req.body?.voice || {}),
      enabled: true,
    };

    const useTranslated =
      req.body?.useTranslated !== undefined
        ? Boolean(req.body.useTranslated)
        : project.subtitleStyle.useTranslated;

    const generated = await generateSynchronizedVoiceover({
      projectId: project.id,
      captions: project.captions,
      voiceConfig,
      useTranslated,
      totalDuration: project.metadata.duration,
    });

    const updated = updateProject(project.id, {
      voice: {
        ...voiceConfig,
        generatedClips: generated.clips,
        fullDubUrl: generated.fullDubUrl,
      },
    });

    res.json({ project: updated, fullDubUrl: generated.fullDubUrl });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// One-Click Video Audio Language Change (Auto-Transcribe -> Translate -> Synchronized AI Dubbing)
app.post('/api/projects/:id/voice/auto-dub', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project || !project.sourceVideoUrl || !project.metadata) {
      res.status(404).json({ error: 'Upload a video before dubbing its audio.' });
      return;
    }

    const asset = getAssetByUrl(project.sourceVideoUrl);
    if (!asset) {
      res.status(404).json({ error: 'Source video file not found.' });
      return;
    }

    const voiceConfig = {
      ...project.voice,
      ...(req.body?.voice || {}),
      syncMode: normalizeSyncMode(req.body?.voice?.syncMode ?? project.voice.syncMode),
      continuousPauseMs: clampContinuousPauseMs(
        req.body?.voice?.continuousPauseMs ?? project.voice.continuousPauseMs
      ),
      speakingSpeed: 1.0,
      enabled: true,
    };
    const useFish = voiceConfig.provider === 'fish' || isFishAudioConfigured();
    const targetLanguage = voiceConfig.targetLanguage as SupportedLanguage;
    const preserveProperNouns =
      req.body?.preserveProperNouns !== undefined
        ? Boolean(req.body.preserveProperNouns)
        : project.translation.preserveProperNouns;

    let captions = project.captions;
    let sourceLanguage = project.translation.sourceLanguage || 'Auto';

    // Step 1: Transcribe original video audio if captions do not yet exist
    if (!captions || captions.length === 0) {
      const transcribed = useFish
        ? await transcribeVideoWithFishAudio({
            videoPath: asset.file_path,
            projectId: project.id,
            duration: project.metadata.duration,
            hasAudio: project.metadata.hasAudio,
            sourceLanguage,
          })
        : await transcribeVideoWithGemini({
            videoPath: asset.file_path,
            projectId: project.id,
            duration: project.metadata.duration,
            hasAudio: project.metadata.hasAudio,
          });
      captions = transcribed.segments;
      sourceLanguage = transcribed.detectedLanguage;
    }

    // Step 2: Translate segments into target language
    const translatedCaptions = await translateCaptionsWithGemini({
      captions,
      sourceLanguage,
      targetLanguage,
      preserveProperNouns,
    });

    // Step 3: Generate synchronized TTS voiceover in target language
    const generated = useFish
      ? await generateFishSynchronizedDub({
          projectId: project.id,
          captions: translatedCaptions,
          voiceConfig,
          useTranslated: true,
          totalDuration: project.metadata.duration,
        })
      : await generateSynchronizedVoiceover({
          projectId: project.id,
          captions: translatedCaptions,
          voiceConfig,
          useTranslated: true,
          totalDuration: project.metadata.duration,
        });

    const generatedSyncPlan = 'syncPlan' in generated ? generated.syncPlan : undefined;

    const updated = updateProject(project.id, {
      captions: translatedCaptions,
      translation: {
        sourceLanguage,
        targetLanguage,
        preserveProperNouns,
        lastTranslatedAt: new Date().toISOString(),
      },
      subtitleStyle: {
        ...project.subtitleStyle,
        useTranslated: true,
      },
      voice: {
        ...voiceConfig,
        generatedClips: generated.clips,
        fullDubUrl: generated.fullDubUrl,
        ...(generatedSyncPlan ? { syncPlan: generatedSyncPlan } : {}),
      },
    });

    res.json({
      project: updated,
      sourceLanguage,
      targetLanguage,
      fullDubUrl: generated.fullDubUrl,
    });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Professional 5-Option High-Res Thumbnail Frame Extraction (from final export or cropped/graded source)
app.post('/api/projects/:id/thumbnails/generate', async (req, res) => {
  const project = getProject(req.params.id);
  if (!project || !project.sourceVideoUrl) {
    res.status(404).json({ error: 'Project or source video not found.' });
    return;
  }
  try {
    let targetVideoPath: string | null = null;
    let sourceMode: 'final-export' | 'edited-source' = 'edited-source';
    let duration = project.metadata?.duration || 10;

    // Prefer final rendered MP4 if it exists on disk and export isn't marked outdated
    const exportIsOutdated = Boolean(project.workflow?.needsAttentionStages?.includes('export'));
    if (project.lastExportUrl && !exportIsOutdated) {
      const exportAsset = getAssetByUrl(project.lastExportUrl);
      if (exportAsset && fs.existsSync(exportAsset.file_path)) {
        targetVideoPath = exportAsset.file_path;
        sourceMode = 'final-export';
        const meta = await analyzeVideoFile(targetVideoPath).catch(() => null);
        if (meta?.duration) duration = meta.duration;
      }
    }

    let vfFilter: string | undefined;
    if (!targetVideoPath) {
      const asset = getAssetByUrl(project.sourceVideoUrl);
      if (!asset || !fs.existsSync(asset.file_path)) {
        res.status(404).json({ error: 'Source video file not found on disk.' });
        return;
      }
      targetVideoPath = asset.file_path;

      // Apply user's current Stage 5 crop & color filter so source frames reflect editing choices
      const canvas = { ...DEFAULT_VIDEO_CANVAS, ...(project.canvas || {}) };
      const srcW = project.metadata?.width || 1280;
      const srcH = project.metadata?.height || 720;
      const rect = resolveSourceCropRect(srcW, srcH, canvas);
      const dims = resolveCanvasDimensions(canvas, project.exportSettings, project.metadata);
      const filterParts: string[] = [];
      if (rect.cw < srcW || rect.ch < srcH) {
        filterParts.push(`crop=${rect.cw}:${rect.ch}:${rect.cx}:${rect.cy}`);
      }
      filterParts.push(
        `scale=${dims.width}:${dims.height}:force_original_aspect_ratio=increase,crop=${dims.width}:${dims.height}`
      );
      if (project.videoEffects) {
        const fxRes = buildVideoEffectsFilters({
          config: project.videoEffects,
          startLabel: 'v_base',
          outputLabel: 'v_fx_out',
        });
        for (const step of fxRes.filterSteps) {
          if (step.includes('split') || step.includes('][')) continue;
          const cleanFilter = step
            .replace(/^\[[^\]]+\]/, '')
            .replace(/\[[^\]]+\]$/, '')
            .trim();
          if (cleanFilter && cleanFilter !== 'null' && !cleanFilter.includes('vignette=')) {
            filterParts.push(cleanFilter);
          }
        }
      }
      vfFilter = filterParts.join(',');
    }

    const timestamps = [
      Math.max(0.25, Number((duration * 0.1).toFixed(2))),
      Math.max(0.5, Number((duration * 0.28).toFixed(2))),
      Math.max(0.75, Number((duration * 0.48).toFixed(2))),
      Math.max(1.0, Number((duration * 0.68).toFixed(2))),
      Math.max(1.25, Number((duration * 0.88).toFixed(2))),
    ];
    const urls: string[] = [];
    for (const t of timestamps) {
      const thumbUrl = await generateHighResVideoFrame(targetVideoPath, project.id, t, vfFilter);
      urls.push(thumbUrl);
    }

    // Strict rule: derive suggested titles/subtitles ONLY from project.name and segment.translatedText (NEVER seg.text)
    const translatedLines = project.captions
      .map((c) => (c.translatedText || '').trim())
      .filter(Boolean);
    const shortHooks = translatedLines
      .map((line) => {
        const words = line.split(/\s+/).filter(Boolean);
        return words.slice(0, 6).join(' ');
      })
      .filter(Boolean);

    const suggestedTitles = [
      project.name || shortHooks[0] || 'Movie Recap',
      shortHooks[0] || project.name || 'Full Recap',
      shortHooks[1] || shortHooks[0] || project.name || 'Hidden Twist',
      shortHooks[2] || shortHooks[0] || project.name || 'The Ending',
      shortHooks[shortHooks.length - 1] || project.name || 'Watch Until End',
    ];

    res.json({
      thumbnails: urls,
      sourceMode,
      suggestedTitle: suggestedTitles[0],
      suggestedSubtitle: translatedLines[0] || '',
      suggestedTitles,
      translationMissingWarning: translatedLines.length === 0,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Save a rendered composite thumbnail (TikTok PNG/JPG) onto project storage so it syncs across devices
app.post('/api/projects/:id/thumbnails/save', uploadMem.single('file'), (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'Thumbnail image file is required.' });
      return;
    }
    const format = req.body?.format === 'jpg' ? 'jpg' : 'png';
    const label = String(req.body?.label || 'TikTok Thumbnail').slice(0, 80);
    const width = Number(req.body?.width) || 1080;
    const height = Number(req.body?.height) || 1920;
    const thumbId = uuidv4();
    const safeFilename = `tiktok_thumb_${project.id.slice(0, 8)}_${thumbId.slice(0, 8)}.${format}`;
    const thumbUrl = `/media/thumbs/${safeFilename}`;
    const saved = hydrateAssetToLocalBucket({
      projectId: project.id,
      targetLocalUrl: thumbUrl,
      bucket: 'thumbs',
      filename: safeFilename,
      assetKind: 'thumbnail',
      mimeType: format === 'jpg' ? 'image/jpeg' : 'image/png',
      buffer: req.file.buffer,
    });

    const newThumb = {
      id: thumbId,
      url: saved.localUrl,
      label,
      width,
      height,
      format: format as 'png' | 'jpg',
      createdAt: new Date().toISOString(),
    };
    const nextSaved = [newThumb, ...(project.savedThumbnails || [])].slice(0, 20);
    const updated = updateProject(project.id, {
      savedThumbnails: nextSaved,
      thumbnailUrl: req.body?.setAsCover === 'true' ? saved.localUrl : project.thumbnailUrl,
    });
    res.json({ thumbnail: newThumb, project: updated });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function resolveMediaUrlToFilePath(url: string | undefined | null): string | null {
  if (!url) return null;
  const asset = getAssetByUrl(url);
  if (asset && fs.existsSync(asset.file_path)) {
    return asset.file_path;
  }
  const cleanUrl = url.split('?')[0];
  const mapping: Array<[string, string]> = [
    ['/media/uploads/', UPLOADS_DIR],
    ['/media/audio/', AUDIO_DIR],
    ['/media/thumbs/', THUMBS_DIR],
    ['/media/exports/', EXPORTS_DIR],
    ['/media/logos/', LOGOS_DIR],
    ['/media/backgrounds/', BACKGROUNDS_DIR],
  ];
  for (const [prefix, dir] of mapping) {
    if (cleanUrl.startsWith(prefix)) {
      const rel = path.basename(cleanUrl.slice(prefix.length));
      const candidate = path.join(dir, rel);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

// Extract real timeline filmstrip frames for the project's source video (cached per video asset)
app.get('/api/projects/:id/timeline-filmstrip', async (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }
  if (!project.sourceVideoUrl) {
    res.json({ frames: [], duration: project.metadata?.duration || 0 });
    return;
  }
  const videoPath = resolveMediaUrlToFilePath(project.sourceVideoUrl);
  if (!videoPath) {
    res.json({ frames: [], duration: project.metadata?.duration || 0 });
    return;
  }
  try {
    const duration = Math.max(0.5, project.metadata?.duration || 12);
    const requested = req.query.frames ? Number(req.query.frames) : undefined;
    const frames = await extractVideoFilmstrip(videoPath, project.id, duration, requested);
    res.json({ frames, duration });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Extract genuine PCM audio waveforms for original audio, narration dub/clips, music, and SFX
app.get('/api/projects/:id/audio-waveforms', async (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }
  try {
    let orig: number[] = Array.isArray(project.waveformPeaks) ? project.waveformPeaks : [];
    if (orig.length === 0 && project.sourceVideoUrl && project.metadata?.hasAudio) {
      const vp = resolveMediaUrlToFilePath(project.sourceVideoUrl);
      if (vp) {
        orig = await extractAudioPeaksCached(vp, 120);
      }
    }

    const dubPath = resolveMediaUrlToFilePath(project.voice.fullDubUrl);
    const bgmPath = resolveMediaUrlToFilePath(project.voice.bgMusicUrl);
    const sfxPath = resolveMediaUrlToFilePath(project.voice.sfxUrl);

    const [dub, bgm, sfx] = await Promise.all([
      dubPath ? extractAudioPeaksCached(dubPath, 120) : Promise.resolve([]),
      bgmPath ? extractAudioPeaksCached(bgmPath, 120) : Promise.resolve([]),
      sfxPath ? extractAudioPeaksCached(sfxPath, 96) : Promise.resolve([]),
    ]);

    const dubClips: Record<string, number[]> = {};
    const clips = project.voice.generatedClips || [];
    await Promise.all(
      clips.slice(0, 60).map(async (clip) => {
        const cp = resolveMediaUrlToFilePath(clip.audioUrl);
        if (cp) {
          const peaks = await extractAudioPeaksCached(cp, 36);
          if (peaks.length > 0) {
            dubClips[clip.segmentId] = peaks;
          }
        }
      })
    );

    res.json({ orig, dub, dubClips, bgm, sfx });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Background Render / Export Jobs
app.post('/api/projects/:id/export', (req, res) => {
  try {
    if (req.body?.exportSettings) {
      updateProject(req.params.id, { exportSettings: req.body.exportSettings });
    }
    const job = enqueueRenderJob(req.params.id);
    res.status(202).json({ job });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/projects/:id/jobs', (req, res) => {
  res.json({ jobs: listProjectJobs(req.params.id) });
});

app.get('/api/jobs/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json({ job });
});

app.get('/api/jobs', (_req, res) => {
  res.json({ jobs: listAllJobs() });
});

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  app.use(['/api', '/media', '/storage'], (req, res) => {
    res.status(404).json({ error: `Endpoint not found: ${req.originalUrl}`, code: 'ENDPOINT_NOT_FOUND' });
  });

  // Always return structured JSON errors for API / upload errors (Multer, JSON syntax, payload limits, etc.)
  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const limitMb = Math.round(DIRECT_UPLOAD_MAX_BYTES / (1024 * 1024));
        res.status(413).json({
          error: `File exceeds direct upload limit (${limitMb} MB). Use chunked upload for larger videos up to ${Math.round(getMaxUploadBytes() / (1024 * 1024))} MB.`,
          code: 'LIMIT_FILE_SIZE',
        });
        return;
      }
      res.status(400).json({ error: err.message || 'Multipart upload failed.', code: err.code || 'MULTER_ERROR' });
      return;
    }
    const errObj = err as { status?: number; statusCode?: number; type?: string; message?: string; code?: string } | null;
    if (errObj?.type === 'entity.too.large') {
      res.status(413).json({
        error: 'Request payload exceeds server body size limit.',
        code: 'PAYLOAD_TOO_LARGE',
      });
      return;
    }
    if (err instanceof SyntaxError && errObj?.status === 400) {
      res.status(400).json({ error: 'Malformed JSON request body.', code: 'INVALID_JSON' });
      return;
    }
    const status =
      typeof errObj?.statusCode === 'number' && errObj.statusCode >= 400
        ? errObj.statusCode
        : typeof errObj?.status === 'number' && errObj.status >= 400
        ? errObj.status
        : 500;
    if (req.path.startsWith('/api') || req.path.startsWith('/media') || req.path.startsWith('/storage')) {
      res.status(status).json({
        error: errObj?.message || 'Internal server error.',
        code: errObj?.code || 'INTERNAL_ERROR',
      });
      return;
    }
    res.status(status).json({ error: errObj?.message || 'Unexpected error.' });
  });

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve('./dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Schedule periodic temp file cleanup every 6 hours
  setInterval(() => {
    cleanupTempStorage(Number(process.env.TEMP_RETENTION_HOURS || '24'));
  }, 6 * 3600 * 1000);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Recap Studio AI server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
