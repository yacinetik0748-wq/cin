import {
  Project,
  StudioPreset,
  SavedFishVoice,
  SavedFontAsset,
  DefaultStudioPreferences,
  RenderJob,
  FilmstripFrame,
  SyncMode,
} from '../types/studio';
import {
  buildTimelineSyncPlan,
  applySyncPlanToClips,
  clampContinuousPauseMs,
  normalizeSyncMode,
} from '../../server/services/timeline_sync_service';
import { idbGet, idbSet, idbList, idbDelete } from './browserStorage';
import { createDefaultMainVideoClip } from './videoTimeline';
import {
  getStoredFishApiKey,
  getFishAudioSettingsSummary,
  saveStoredFishApiKey,
  deleteStoredFishApiKey,
  testFishAudioConnection,
  fetchFishVoicesFromBrowser,
  validateFishVoiceInBrowser,
} from './fishAudioKeyManager';
import {
  previewFishTtsViaProxy,
  startBrowserFishDubJob,
  regenerateFishSegmentsInBrowser,
  transcribeWithFishViaProxy,
  buildMergedDubBlobUrl,
  ensureLocalProject,
} from './browserFishClient';

const DEFAULT_PREFERENCES: DefaultStudioPreferences = {
  autoApplyDefaultStyleOnImport: true,
  defaultStyleId: null,
  defaultTargetLanguage: 'English',
  defaultSyncMode: 'flexible',
};

async function normalizeLocalProjectForLoad(proj: Project): Promise<Project> {
  const hasVideo = Boolean(proj.sourceVideoUrl || proj.sourceVideoBlobKey);
  const needsDefaultClip =
    hasVideo &&
    (!Array.isArray(proj.videoClips) ||
      (proj.videoClips.length === 0 && !proj.workflow?.completedStages?.includes('editor')));

  if (!needsDefaultClip) return proj;

  const repaired: Project = {
    ...proj,
    videoClips: [
      createDefaultMainVideoClip({
        filename: proj.sourceFilename,
        name: proj.name,
        duration: proj.metadata?.duration,
        audioUnlinked: Boolean(proj.originalAudioClips && proj.originalAudioClips.length > 0),
      }),
    ],
  };
  await idbSet('projects', repaired.id, repaired).catch(() => {});
  return repaired;
}

export async function handleLocalApiFallback<T>(url: string, init?: RequestInit): Promise<T | undefined> {
  const method = (init?.method || 'GET').toUpperCase();
  const parsedUrl = new URL(url, 'http://localhost');
  const pathname = parsedUrl.pathname;

  if (pathname === '/api/system/status' && method === 'GET') {
    const hasFishKey = Boolean(await getStoredFishApiKey());
    return {
      geminiConfigured: false,
      fishConfigured: hasFishKey,
      ffmpegAvailable: true,
      ffprobeAvailable: true,
      ffmpegVersion: 'wasm-browser',
      storageDir: 'indexeddb',
      maxUploadSizeMb: 2048,
      tempRetentionHours: 24,
      supportedVideoFormats: ['MP4', 'MOV', 'MKV'],
      supportedLogoFormats: ['PNG', 'SVG'],
    } as unknown as T;
  }

  if (pathname === '/api/projects' && method === 'GET') {
    const rawProjects = await idbList<Project>('projects');
    const projects = await Promise.all((rawProjects || []).map((p) => normalizeLocalProjectForLoad(p)));
    return { projects } as unknown as T;
  }

  if (pathname === '/api/projects' && method === 'POST') {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const id = crypto.randomUUID();
    const name = body.name || `Recap Project ${new Date().toLocaleDateString()}`;
    const newProj: Project = {
      id,
      name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sourceVideoUrl: null,
      sourceFilename: null,
      thumbnailUrl: null,
      metadata: null,
      waveformPeaks: [],
      captions: [],
      subtitleStyle: {
        enabled: false,
        mode: 'word-by-word',
        chunkSize: 3,
        wordsPerDisplay: 3,
        highlightBehavior: 'color',
        transitionDurationMs: 180,
        timingOffsetSec: 0,
        template: 'tiktok',
        fontFamily: 'Montserrat',
        fontSize: 42,
        fontWeight: 'bold',
        fontWeightNum: 700,
        italic: false,
        underline: false,
        primaryColor: '#FFFFFF',
        highlightColor: '#FFD700',
        outlineColor: '#000000',
        outlineWidth: 2,
        backgroundColor: '#00000088',
        backgroundOpacity: 60,
        borderRadius: 0,
        paddingH: 12,
        paddingV: 8,
        shadowEnabled: true,
        shadowColor: '#000000',
        shadowBlur: 8,
        letterSpacing: 0,
        lineSpacing: 1.2,
        textAlign: 'center',
        position: 'bottom',
        posX: 50,
        posY: 85,
        marginV: 40,
        uppercase: false,
        useTranslated: false,
        animationPreset: 'none',
      },
      translation: { sourceLanguage: 'English', targetLanguage: 'English', preserveProperNouns: true },
      voice: {
        enabled: false,
        provider: 'fish',
        syncMode: 'flexible',
        targetLanguage: 'English',
        gender: 'female',
        voiceName: 'Puck',
        style: 'narrative',
        narrationStyle: 'cinematic',
        speakingSpeed: 1.0,
        voiceVolume: 1.0,
        timingOffsetSec: 0,
        preserveOriginalAudio: true,
        originalAudioVolume: 0.3,
        fadeInSec: 0.5,
        fadeOutSec: 0.5,
        bgMusicVolume: 0.2,
        generatedClips: [],
      },
      blurs: [],
      logos: [],
      videoEffects: {
        filterPreset: 'cinematic',
        filterIntensity: 100,
        filterStack: [],
        adjustments: { brightness: 0, contrast: 0, saturation: 0, exposure: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0, sharpness: 0, vignette: 0, fade: 0 },
        effects: [],
        compareMode: false,
      },
      canvas: {
        aspectRatio: '9:16',
        customWidth: 1080,
        customHeight: 1920,
        zoom: 1.0,
        offsetX: 0,
        offsetY: 0,
        cropTop: 0,
        cropRight: 0,
        cropBottom: 0,
        cropLeft: 0,
        backgroundType: 'solid',
        bgColor: '#0B0B0F',
        bgImageScale: 1.0,
        bgImageOffsetX: 0,
        bgImageOffsetY: 0,
        bgBlurIntensity: 20,
        bgBlurBrightness: 100,
        bgBlurOpacity: 100,
      },
      exportSettings: {
        aspectRatio: '9:16',
        resolution: '1080p',
        fitMode: 'blur-pad',
        format: 'mp4',
        videoCodec: 'h264',
        audioCodec: 'aac',
        applyBlur: true,
        applyLogo: true,
        applyVideoEffects: true,
        applyCaptions: false,
        applyDubbing: true,
        applyAudioMix: true,
      },
      lastExportUrl: null,
      lastExportSize: null,
      lastExportedAt: null,
      videoClips: [],
      originalAudioClips: [],
    };
    await idbSet('projects', id, newProj);
    return { project: newProj, presetWarnings: [] } as unknown as T;
  }

  // Filmstrip
  const filmstripMatch = /^\/api\/projects\/([^/]+)\/timeline-filmstrip$/.exec(pathname);
  if (filmstripMatch && method === 'GET') {
    const projId = filmstripMatch[1];
    const cached = await idbGet<{ id: string; frames: FilmstripFrame[]; duration: number }>('filmstrips', projId);
    if (cached && cached.frames) {
      return { frames: cached.frames, duration: cached.duration || 10 } as unknown as T;
    }
    const proj = await idbGet<Project>('projects', projId);
    return { frames: [], duration: proj?.metadata?.duration || 10 } as unknown as T;
  }

  // Audio waveforms
  const waveformMatch = /^\/api\/projects\/([^/]+)\/audio-waveforms$/.exec(pathname);
  if (waveformMatch && method === 'GET') {
    const projId = waveformMatch[1];
    const cached = await idbGet<{ id: string; waveforms: any }>('waveforms', projId);
    if (cached && cached.waveforms) {
      return cached.waveforms as unknown as T;
    }
    const proj = await idbGet<Project>('projects', projId);
    const peaks = proj?.waveformPeaks || [];
    return {
      orig: peaks,
      dub: [],
      dubClips: {},
      bgm: [],
      sfx: [],
    } as unknown as T;
  }

  // Export
  const exportMatch = /^\/api\/projects\/([^/]+)\/export$/.exec(pathname);
  if (exportMatch && method === 'POST') {
    const projId = exportMatch[1];
    const proj = await idbGet<Project>('projects', projId);
    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();
    const job: RenderJob = {
      id: jobId,
      projectId: projId,
      type: 'render',
      status: 'completed',
      progress: 100,
      stage: 'Render complete (Browser export)',
      etaSeconds: 0,
      outputUrl: proj?.sourceVideoUrl || null,
      outputSize: proj?.metadata?.fileSize || null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    await idbSet('jobs', jobId, job);
    if (proj) {
      proj.lastExportUrl = proj.sourceVideoUrl;
      proj.lastExportSize = proj.metadata?.fileSize || null;
      proj.lastExportedAt = now;
      await idbSet('projects', projId, proj);
    }
    return { job } as unknown as T;
  }

  // Jobs
  const jobListMatch = /^\/api\/projects\/([^/]+)\/jobs$/.exec(pathname);
  if (jobListMatch && method === 'GET') {
    const projId = jobListMatch[1];
    const allJobs = await idbList<RenderJob>('jobs');
    const jobs = (allJobs || []).filter(j => j.projectId === projId);
    return { jobs } as unknown as T;
  }

  const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(pathname);
  if (jobMatch && method === 'GET') {
    const jobId = jobMatch[1];
    const job = await idbGet<RenderJob>('jobs', jobId);
    if (job) return { job } as unknown as T;
    return {
      job: {
        id: jobId,
        projectId: '',
        type: 'render',
        status: 'completed',
        progress: 100,
        stage: 'Completed',
        etaSeconds: 0,
        outputUrl: null,
        outputSize: null,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    } as unknown as T;
  }

  // Offline upload init/complete fallback when static-only / no backend exists
  if (pathname === '/api/uploads/init' && method === 'POST') {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const projId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
    if (!projId || projId === 'undefined' || projId === 'null') {
      throw new Error('Invalid or missing projectId.');
    }
    const proj = await idbGet<Project>('projects', projId);
    if (!proj) throw new Error('Project not found');
    const totalChunks = Math.max(1, Number(body.totalChunks) || 1);
    return {
      uploadId: `offline_${crypto.randomUUID()}`,
      totalChunks,
      projectId: proj.id,
      storageMode: 'indexeddb-local',
      offlineLocal: true,
    } as unknown as T;
  }

  const offlineUploadCompleteMatch = /^\/api\/uploads\/([^/]+)\/complete$/.exec(pathname);
  if (offlineUploadCompleteMatch && method === 'POST') {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const projId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
    if (!projId || projId === 'undefined' || projId === 'null') {
      throw new Error('Invalid or missing projectId.');
    }
    const proj = await idbGet<Project>('projects', projId);
    if (!proj) throw new Error('Project not found');
    const updated: Project = {
      ...proj,
      ...(body.sourceVideoUrl ? { sourceVideoUrl: body.sourceVideoUrl } : {}),
      ...(body.sourceVideoBlobKey ? { sourceVideoBlobKey: body.sourceVideoBlobKey } : {}),
      ...(body.sourceFilename ? { sourceFilename: body.sourceFilename } : {}),
      ...(body.thumbnailDataUrl && !proj.thumbnailUrl ? { thumbnailUrl: body.thumbnailDataUrl } : {}),
      ...(body.metadata ? { metadata: body.metadata } : {}),
      ...(Array.isArray(body.waveformPeaks) ? { waveformPeaks: body.waveformPeaks } : {}),
      updatedAt: new Date().toISOString(),
    };
    await idbSet('projects', projId, updated);
    return { project: updated, metadata: updated.metadata } as unknown as T;
  }

  const projMatch = /^\/api\/projects\/([^/]+)$/.exec(pathname);
  if (projMatch) {
    const projId = decodeURIComponent(projMatch[1] || '').trim();
    if (!projId || projId === 'undefined' || projId === 'null') {
      throw new Error('Invalid or missing projectId.');
    }
    if (method === 'GET') {
      const proj = await idbGet<Project>('projects', projId);
      if (!proj) throw new Error('Project not found');
      const normalized = await normalizeLocalProjectForLoad(proj);
      return { project: normalized } as unknown as T;
    }
    if (method === 'PATCH') {
      const patch = init?.body ? JSON.parse(String(init.body)) : {};
      const proj = await idbGet<Project>('projects', projId);
      if (!proj) throw new Error('Project not found');
      const updated = { ...proj, ...patch, updatedAt: new Date().toISOString() };
      await idbSet('projects', projId, updated);
      return { project: updated } as unknown as T;
    }
    if (method === 'DELETE') {
      await idbDelete('projects', projId);
      return { deleted: true } as unknown as T;
    }
  }

  if (pathname === '/api/presets' && method === 'GET') {
    const presets = await idbList<StudioPreset>('presets');
    return { presets: presets || [] } as unknown as T;
  }

  if (pathname === '/api/styles' && method === 'GET') {
    const presets = await idbList<StudioPreset>('presets');
    const styles = (presets || []).filter(p => p.category === 'style');
    return { styles, defaultStyleId: null } as unknown as T;
  }

  if (pathname === '/api/settings/preferences' && method === 'GET') {
    const prefs = (await idbGet<DefaultStudioPreferences>('settings', 'preferences')) || DEFAULT_PREFERENCES;
    return { preferences: prefs, defaultStyle: null } as unknown as T;
  }

  if (pathname === '/api/settings/preferences' && method === 'PATCH') {
    const patch = init?.body ? JSON.parse(String(init.body)) : {};
    const prefs = ((await idbGet<DefaultStudioPreferences>('settings', 'preferences')) || DEFAULT_PREFERENCES);
    const updated = { ...prefs, ...patch };
    await idbSet('settings', 'preferences', updated);
    return { preferences: updated, defaultStyle: null } as unknown as T;
  }

  if (pathname === '/api/settings/fish-audio' && method === 'GET') {
    return (await getFishAudioSettingsSummary()) as unknown as T;
  }

  if (pathname === '/api/settings/fish-api-key') {
    if (method === 'POST') {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      return (await saveStoredFishApiKey(typeof body.apiKey === 'string' ? body.apiKey : '')) as unknown as T;
    }
    if (method === 'DELETE') {
      return (await deleteStoredFishApiKey()) as unknown as T;
    }
  }

  if (pathname === '/api/settings/fish-api-key/test' && method === 'POST') {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const candidateKey = typeof body.apiKey === 'string' ? body.apiKey : undefined;
    return (await testFishAudioConnection(candidateKey)) as unknown as T;
  }

  if (pathname === '/api/fish/voices' && method === 'GET') {
    const key = await getStoredFishApiKey();
    if (!key) return { voices: [], total: 0 } as unknown as T;
    const query = parsedUrl.searchParams.get('q') || undefined;
    const selfOnly = parsedUrl.searchParams.get('self') === 'true';
    const language = parsedUrl.searchParams.get('language') || undefined;
    return (await fetchFishVoicesFromBrowser(key, { query, selfOnly, language })) as unknown as T;
  }

  if (pathname === '/api/fish/saved-voices/validate' && method === 'POST') {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const key = await getStoredFishApiKey();
    return (await validateFishVoiceInBrowser(key, String(body.voiceId || ''))) as unknown as T;
  }

  if (pathname === '/api/fish/saved-voices/preview' && method === 'POST') {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const key = await getStoredFishApiKey();
    const text =
      String(body.text || '').trim() ||
      'Everything changed the moment the vault door swung open in silence.';
    return (await previewFishTtsViaProxy(key, {
      text,
      referenceId: typeof body.voiceId === 'string' ? body.voiceId.trim() : undefined,
    })) as unknown as T;
  }

  if (pathname === '/api/fish/saved-voices') {
    if (method === 'GET') {
      const voices = (await idbList<SavedFishVoice>('saved_fish_voices')) || [];
      return { voices } as unknown as T;
    }
    if (method === 'POST') {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const name = String(body.name || '').trim();
      const voiceId = String(body.voiceId || '').trim();
      if (!name) throw new Error('Narrator name is required.');
      if (!voiceId) throw new Error('Fish Audio Voice ID is required.');

      let validated = Boolean(body.validated);
      let validationMessage = validated ? 'Verified Fish Audio Voice ID.' : 'Saved without remote verification.';
      if (!body.skipRemoteValidation) {
        const key = await getStoredFishApiKey();
        const check = await validateFishVoiceInBrowser(key, voiceId);
        validated = check.checked && check.valid;
        validationMessage = check.message;
      }

      const existing = (await idbList<SavedFishVoice>('saved_fish_voices')) || [];
      const setDefault = Boolean(body.isDefault) || existing.length === 0;
      const now = new Date().toISOString();
      const newVoice: SavedFishVoice = {
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
        isDefault: setDefault,
        createdAt: now,
        updatedAt: now,
      };

      if (setDefault) {
        for (const v of existing) {
          if (v.isDefault) {
            await idbSet('saved_fish_voices', v.id, { ...v, isDefault: false });
          }
        }
      }
      await idbSet('saved_fish_voices', newVoice.id, newVoice);
      const voices = await idbList<SavedFishVoice>('saved_fish_voices');
      return { voice: newVoice, voices, validationMessage } as unknown as T;
    }
  }

  const dupSavedVoiceMatch = /^\/api\/fish\/saved-voices\/([^/]+)\/duplicate$/.exec(pathname);
  if (dupSavedVoiceMatch && method === 'POST') {
    const id = dupSavedVoiceMatch[1];
    const found = await idbGet<SavedFishVoice>('saved_fish_voices', id);
    if (!found) throw new Error('Saved voice not found.');
    const now = new Date().toISOString();
    const copy: SavedFishVoice = {
      ...found,
      id: crypto.randomUUID(),
      name: `${found.name} (Copy)`,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    };
    await idbSet('saved_fish_voices', copy.id, copy);
    const voices = await idbList<SavedFishVoice>('saved_fish_voices');
    return { voice: copy, voices } as unknown as T;
  }

  const savedVoiceIdMatch = /^\/api\/fish\/saved-voices\/([^/]+)$/.exec(pathname);
  if (savedVoiceIdMatch) {
    const id = savedVoiceIdMatch[1];
    if (method === 'PATCH') {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const found = await idbGet<SavedFishVoice>('saved_fish_voices', id);
      if (!found) throw new Error('Saved voice not found.');
      const name = body.name !== undefined ? String(body.name).trim() : found.name;
      const voiceId = body.voiceId !== undefined ? String(body.voiceId).trim() : found.voiceId;
      if (!name || !voiceId) throw new Error('Both narrator name and Fish Audio Voice ID are required.');

      let validated = body.validated !== undefined ? Boolean(body.validated) : found.validated;
      if (voiceId !== found.voiceId && !body.skipRemoteValidation) {
        const key = await getStoredFishApiKey();
        const check = await validateFishVoiceInBrowser(key, voiceId);
        validated = check.checked && check.valid;
      }

      const isDefault = body.isDefault !== undefined ? Boolean(body.isDefault) : found.isDefault;
      if (isDefault) {
        const all = await idbList<SavedFishVoice>('saved_fish_voices');
        for (const v of all) {
          if (v.id !== id && v.isDefault) {
            await idbSet('saved_fish_voices', v.id, { ...v, isDefault: false });
          }
        }
      }

      const updated: SavedFishVoice = {
        ...found,
        name,
        voiceId,
        description:
          body.description !== undefined ? String(body.description || '').trim() || undefined : found.description,
        language:
          body.language !== undefined ? String(body.language || '').trim() || undefined : found.language,
        sampleUrl:
          body.sampleUrl !== undefined ? String(body.sampleUrl || '').trim() || undefined : found.sampleUrl,
        previewText:
          body.previewText !== undefined ? String(body.previewText || '').trim() || undefined : found.previewText,
        validated,
        isDefault,
        updatedAt: new Date().toISOString(),
      };
      await idbSet('saved_fish_voices', id, updated);
      const voices = await idbList<SavedFishVoice>('saved_fish_voices');
      return { voice: updated, voices } as unknown as T;
    }
    if (method === 'DELETE') {
      await idbDelete('saved_fish_voices', id);
      const remaining = await idbList<SavedFishVoice>('saved_fish_voices');
      if (remaining.length > 0 && !remaining.some((v) => v.isDefault)) {
        await idbSet('saved_fish_voices', remaining[0].id, { ...remaining[0], isDefault: true });
      }
      const voices = await idbList<SavedFishVoice>('saved_fish_voices');
      return { deleted: true, voices } as unknown as T;
    }
  }

  // Dubbing preview / generate / regenerate / resync / rebuild / transcribe
  const dubPreviewMatch = /^\/api\/projects\/([^/]+)\/dubbing\/preview$/.exec(pathname);
  if (dubPreviewMatch && method === 'POST') {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const key = await getStoredFishApiKey();
    return (await previewFishTtsViaProxy(key, {
      text: String(body.text || ''),
      referenceId: typeof body.referenceId === 'string' ? body.referenceId : undefined,
    })) as unknown as T;
  }

  const dubGenerateMatch = /^\/api\/projects\/([^/]+)\/dubbing\/generate$/.exec(pathname);
  if (dubGenerateMatch && method === 'POST') {
    const projId = dubGenerateMatch[1];
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const key = await getStoredFishApiKey();
    return (await startBrowserFishDubJob(key, projId, body)) as unknown as T;
  }

  const dubRegenMatch = /^\/api\/projects\/([^/]+)\/dubbing\/regenerate-segments$/.exec(pathname);
  if (dubRegenMatch && method === 'POST') {
    const projId = dubRegenMatch[1];
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const key = await getStoredFishApiKey();
    return (await regenerateFishSegmentsInBrowser(key, projId, body)) as unknown as T;
  }

  const dubTranscribeMatch =
    /^\/api\/projects\/([^/]+)\/dubbing\/transcribe$/.exec(pathname) ||
    /^\/api\/projects\/([^/]+)\/transcribe$/.exec(pathname);
  if (dubTranscribeMatch && method === 'POST') {
    const projId = dubTranscribeMatch[1];
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const key = await getStoredFishApiKey();
    return (await transcribeWithFishViaProxy(
      key,
      projId,
      typeof body.sourceLanguage === 'string' ? body.sourceLanguage : undefined
    )) as unknown as T;
  }

  const dubResyncMatch = /^\/api\/projects\/([^/]+)\/dubbing\/resync$/.exec(pathname);
  if (dubResyncMatch && method === 'POST') {
    const projId = dubResyncMatch[1];
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const proj = await ensureLocalProject(projId);
    const syncMode: SyncMode = normalizeSyncMode(body.syncMode ?? proj.voice.syncMode);
    const continuousPauseMs = clampContinuousPauseMs(
      body.continuousPauseMs ?? proj.voice.continuousPauseMs
    );
    const inputClips = proj.voice.generatedClips || [];
    if (inputClips.length > 0) {
      const plan = buildTimelineSyncPlan({
        captions: proj.captions,
        measuredClips: inputClips.map((c) => ({
          segmentId: c.segmentId,
          start: c.start,
          end: c.end,
          duration: c.duration,
          speechDuration: c.speechDuration,
          leadingSilence: c.leadingSilence,
          trailingSilence: c.trailingSilence,
        })),
        originalVideoDuration: proj.metadata?.duration || 10,
        syncMode,
        continuousPauseMs,
      });
      const syncedClips = applySyncPlanToClips(inputClips, plan);
      const fullDubUrl =
        (await buildMergedDubBlobUrl(
          syncedClips.map((c) => ({ audioUrl: c.audioUrl, startSec: c.start })),
          plan.estimatedFinalDuration
        )) || proj.voice.fullDubUrl;
      const updated: Project = {
        ...proj,
        voice: {
          ...proj.voice,
          syncMode,
          continuousPauseMs,
          generatedClips: syncedClips,
          fullDubUrl,
          syncPlan: plan,
        },
        updatedAt: new Date().toISOString(),
      };
      await idbSet('projects', projId, updated);
      return { project: updated } as unknown as T;
    }
    const updated: Project = {
      ...proj,
      voice: { ...proj.voice, syncMode, continuousPauseMs },
      updatedAt: new Date().toISOString(),
    };
    await idbSet('projects', projId, updated);
    return { project: updated } as unknown as T;
  }

  const dubRebuildMatch = /^\/api\/projects\/([^/]+)\/dubbing\/rebuild-track$/.exec(pathname);
  if (dubRebuildMatch && method === 'POST') {
    const projId = dubRebuildMatch[1];
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const proj = await ensureLocalProject(projId);
    const clips = Array.isArray(body.generatedClips) ? body.generatedClips : proj.voice.generatedClips || [];
    const maxEnd = clips.reduce((m: number, c: any) => Math.max(m, Number(c.end || 0)), proj.metadata?.duration || 10);
    const fullDubUrl =
      (await buildMergedDubBlobUrl(
        clips.map((c: any) => ({ audioUrl: c.audioUrl, startSec: Number(c.start || 0) })),
        maxEnd
      )) || '';
    const updated: Project = {
      ...proj,
      voice: { ...proj.voice, generatedClips: clips, fullDubUrl: fullDubUrl || proj.voice.fullDubUrl },
      updatedAt: new Date().toISOString(),
    };
    await idbSet('projects', projId, updated);
    return { project: updated, fullDubUrl: updated.voice.fullDubUrl || '', clips } as unknown as T;
  }

  if (pathname === '/api/fonts' && method === 'GET') {
    const fonts = (await idbList<SavedFontAsset>('fonts')) || [];
    return { fonts } as unknown as T;
  }

  return undefined;
}
