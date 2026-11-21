import {
  DEFAULT_VIDEO_CANVAS,
  DefaultStudioPreferences,
  FilmstripFrame,
  Project,
  ProjectAudioWaveforms,
  RenderJob,
  SavedFishVoice,
  SavedFontAsset,
  StudioPreset,
} from '../types/studio';
import {
  buildAssetBlobKey,
  deleteBlobAsset,
  deleteProjectLocalAssets,
  getBlobAssetByKey,
  idbDelete,
  idbGet,
  idbList,
  idbListRawEntries,
  idbSet,
  openIndexedDB,
  retrieveProjectVideoBlob,
  storeBlobAsset,
} from './browserStorage';
import {
  ExportRenderResult,
  ExportValidationError,
  renderProjectExportInBrowser,
} from './clientExportRenderer';
import { renderProjectCanvasFallback } from './canvasExportFallback';
import { terminateBrowserFFmpeg } from './clientMediaEngine';
import {
  computeExportTargetFps,
  EXPORT_AUDIO_BITRATE_KBPS,
  resolveExportSpeedPreset,
} from './exportEstimation';
import {
  canProjectUseStreamCopy,
  detectSmartExportCapabilities,
  renderProjectWithWebCodecs,
  WebCodecsExportResult,
} from './webcodecsExportRenderer';
import {
  createDefaultMainVideoClip,
  getEffectiveBgmClips,
  getEffectiveSfxClips,
  getEffectiveVideoClips,
} from './videoTimeline';
import { createWorkflowUpdate, resolveCanvasDimensions } from './workflowStages';

const activeExportControllers = new Map<string, AbortController>();

export interface ProjectMediaItem {
  key: string;
  blob: Blob;
  mimeType: string;
  sizeBytes: number;
}

export interface ProjectMediaCollection {
  sourceVideo: Blob | null;
  sourceVideoKey: string | null;
  exportedVideos: ProjectMediaItem[];
  audioFiles: ProjectMediaItem[];
  images: ProjectMediaItem[];
  allBlobs: ProjectMediaItem[];
}

export interface PresetApplyOptions {
  captionPresetId?: string | null;
  filterPresetId?: string | null;
  editingPresetId?: string | null;
  styleId?: string | null;
  applyDefaults?: boolean;
  applyDefaultStyle?: boolean;
}

const DEFAULT_PREFERENCES: DefaultStudioPreferences = {
  autoApplyDefaultStyleOnImport: true,
  defaultStyleId: null,
  defaultTargetLanguage: 'English',
  defaultSyncMode: 'flexible',
};

function createDefaultProjectObject(id?: string, name?: string): Project {
  const projId = id || crypto.randomUUID();
  const projName = name || `Recap Project ${new Date().toLocaleDateString()}`;
  const now = new Date().toISOString();

  return {
    id: projId,
    name: projName,
    createdAt: now,
    updatedAt: now,
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
    translation: {
      sourceLanguage: 'English',
      targetLanguage: 'English',
      preserveProperNouns: true,
    },
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
      adjustments: {
        brightness: 0,
        contrast: 0,
        saturation: 0,
        exposure: 0,
        temperature: 0,
        tint: 0,
        highlights: 0,
        shadows: 0,
        sharpness: 0,
        vignette: 0,
        fade: 0,
      },
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
      speedProfile: 'balanced',
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
}

let initialized = false;

async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  try {
    await openIndexedDB();

    // Migrate from legacy recap_studio_free_cache if it exists
    if (typeof indexedDB !== 'undefined') {
      try {
        const legacyReq = indexedDB.open('recap_studio_free_cache');
        legacyReq.onsuccess = async () => {
          const legacyDb = legacyReq.result;
          if (legacyDb.objectStoreNames.contains('projects')) {
            try {
              const tx = legacyDb.transaction('projects', 'readonly');
              const store = tx.objectStore('projects');
              const allReq = store.getAll();
              allReq.onsuccess = async () => {
                const legacyProjects = (allReq.result || []) as Project[];
                for (const lp of legacyProjects) {
                  if (lp && lp.id) {
                    const existing = await idbGet<Project>('projects', lp.id);
                    if (!existing) {
                      await idbSet('projects', lp.id, lp).catch(() => {});
                    }
                  }
                }
              };
            } catch {
              // ignore
            }
          }
        };
      } catch {
        // ignore legacy db
      }
    }
    initialized = true;
  } catch (err) {
    console.error('[LocalStorageService] Database initialization failed:', err);
  }
}

function normalizeProjectForLoad(proj: Project): Project {
  const hasVideo = Boolean(proj.sourceVideoUrl || proj.sourceVideoBlobKey);
  const needsDefaultClip =
    hasVideo &&
    (!Array.isArray(proj.videoClips) ||
      (proj.videoClips.length === 0 && !proj.workflow?.completedStages?.includes('editor')));

  if (!needsDefaultClip) return proj;

  return {
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
}

export const localProjectService = {
  async init(): Promise<void> {
    await ensureInitialized();
  },

  async createProject(
    nameOrData?: string | Partial<Project>,
    _presetOpts?: PresetApplyOptions
  ): Promise<Project> {
    await ensureInitialized();
    const isString = typeof nameOrData === 'string';
    const name = isString ? nameOrData : nameOrData?.name;
    const providedId = !isString ? nameOrData?.id : undefined;

    const base = createDefaultProjectObject(providedId, name);
    const project: Project = !isString && nameOrData ? { ...base, ...nameOrData, id: base.id } : base;

    await idbSet('projects', project.id, project);
    try {
      window.localStorage.setItem('recap_studio_last_active_project_id', project.id);
    } catch {
      // ignore
    }
    return project;
  },

  async getProject(id: string): Promise<Project | null> {
    if (!id || typeof id !== 'string') return null;
    await ensureInitialized();
    const cleanId = id.trim();

    // 1. Direct fetch from primary projects store
    let project = await idbGet<Project>('projects', cleanId);

    // 2. Fallback scan if id had case or formatting difference
    if (!project) {
      const all = await idbList<Project>('projects');
      project = all.find((p) => p && (p.id === cleanId || p.id?.toLowerCase() === cleanId.toLowerCase()));
    }

    if (!project) return null;

    const normalized = normalizeProjectForLoad(project);
    if (normalized !== project) {
      void idbSet('projects', normalized.id, normalized).catch(() => {});
    }
    return normalized;
  },

  async saveProject(project: Project): Promise<Project> {
    if (!project || !project.id) {
      throw new Error('Cannot save project without a valid id.');
    }
    await ensureInitialized();
    const updated: Project = {
      ...project,
      updatedAt: new Date().toISOString(),
    };
    await idbSet('projects', updated.id, updated);
    try {
      window.localStorage.setItem('recap_studio_last_active_project_id', updated.id);
    } catch {
      // ignore
    }
    return updated;
  },

  async updateProject(id: string, patch: Partial<Project>): Promise<Project> {
    if (!id) throw new Error('Project ID is required for update.');
    await ensureInitialized();
    const existing = await this.getProject(id);
    if (!existing) {
      throw new Error(`Project "${id}" not found in local IndexedDB storage.`);
    }

    const updated: Project = {
      ...existing,
      ...patch,
      id: existing.id, // Immutable ID
      updatedAt: new Date().toISOString(),
    };

    await idbSet('projects', updated.id, updated);
    return updated;
  },

  async deleteProject(id: string): Promise<boolean> {
    if (!id) return false;
    await ensureInitialized();
    await deleteProjectLocalAssets(id);
    return true;
  },

  async getAllProjects(): Promise<Project[]> {
    await ensureInitialized();
    const list = await idbList<Project>('projects');
    const valid = (list || []).filter((p): p is Project => Boolean(p && p.id));
    const normalized = valid.map((p) => normalizeProjectForLoad(p));
    return normalized.sort((a, b) =>
      String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''))
    );
  },

  async getProjectMedia(
    projectId: string,
    mediaType?: 'video' | 'audio' | 'image' | 'all'
  ): Promise<ProjectMediaCollection> {
    if (!projectId) {
      return {
        sourceVideo: null,
        sourceVideoKey: null,
        exportedVideos: [],
        audioFiles: [],
        images: [],
        allBlobs: [],
      };
    }
    await ensureInitialized();
    const project = await this.getProject(projectId);
    const rawBlobs = await idbListRawEntries('blobs');

    const result: ProjectMediaCollection = {
      sourceVideo: null,
      sourceVideoKey: null,
      exportedVideos: [],
      audioFiles: [],
      images: [],
      allBlobs: [],
    };

    if (project) {
      const retrieved = await retrieveProjectVideoBlob(project).catch(() => null);
      if (retrieved?.blob) {
        result.sourceVideo = retrieved.blob;
        result.sourceVideoKey = retrieved.blobKey;
      }
    }

    for (const entry of rawBlobs || []) {
      const k = entry.key || '';
      if (!k || !(entry.value instanceof Blob) || entry.value.size === 0) continue;

      const isForProject =
        k.includes(`_${projectId}_`) ||
        k === `video_project_${projectId}` ||
        k === project?.sourceVideoBlobKey;

      if (!isForProject) continue;

      const blob = entry.value;
      const mimeType = blob.type || (k.endsWith('.mp4') ? 'video/mp4' : k.endsWith('.webm') ? 'video/webm' : 'application/octet-stream');
      const item: ProjectMediaItem = {
        key: k,
        blob,
        mimeType,
        sizeBytes: blob.size,
      };

      result.allBlobs.push(item);
      if (k.startsWith('export_') || k.includes('_final.')) {
        result.exportedVideos.push(item);
      } else if (k.startsWith('audio_') || k.startsWith('fish_') || k.startsWith('bgm_') || k.startsWith('sfx_')) {
        result.audioFiles.push(item);
      } else if (k.startsWith('logo_') || k.startsWith('bg_') || k.startsWith('thumb_')) {
        result.images.push(item);
      }
    }

    return result;
  },

  async saveProjectMedia(
    projectId: string,
    key: string,
    blob: Blob,
    mimeType?: string
  ): Promise<string> {
    if (!blob || !(blob instanceof Blob) || blob.size === 0) {
      throw new Error(`Cannot save empty media blob under key "${key}".`);
    }
    await ensureInitialized();
    const finalBlob = mimeType && blob.type !== mimeType ? new Blob([blob], { type: mimeType }) : blob;
    await storeBlobAsset(key, finalBlob);
    return `idb://blobs/${key}`;
  },

  async diagnoseProjectMedia(project: Project): Promise<{
    valid: boolean;
    missing: string[];
    sourceVideoFound: boolean;
    details: Record<string, boolean>;
  }> {
    const missing: string[] = [];
    const details: Record<string, boolean> = {};

    // 1. Source Video
    const video = await retrieveProjectVideoBlob(project).catch(() => null);
    const sourceVideoFound = Boolean(video?.blob && video.blob.size > 0);
    details['sourceVideo'] = sourceVideoFound;
    if (!sourceVideoFound) {
      missing.push('Source video file (0 bytes or missing from IndexedDB)');
    }

    // 2. Dubbing track (merged fullDubUrl or individual generatedClips)
    if (project.voice.enabled && !project.voice.voiceMuted) {
      if (project.voice.fullDubUrl && project.voice.fullDubUrl.startsWith('idb://blobs/')) {
        const k = project.voice.fullDubUrl.slice('idb://blobs/'.length);
        const dubBlob = await getBlobAssetByKey(k).catch(() => null);
        const dubFound = Boolean(dubBlob && dubBlob.size > 0);
        details['narrationDub'] = dubFound;
        if (!dubFound) missing.push(`Narration dub audio file (${k})`);
      } else if (Array.isArray(project.voice.generatedClips) && project.voice.generatedClips.length > 0) {
        let foundClipCount = 0;
        for (const clip of project.voice.generatedClips) {
          if (clip.audioUrl?.startsWith('idb://blobs/')) {
            const k = clip.audioUrl.slice('idb://blobs/'.length);
            const cBlob = await getBlobAssetByKey(k).catch(() => null);
            if (cBlob && cBlob.size > 0) foundClipCount += 1;
          } else if (clip.audioUrl) {
            foundClipCount += 1;
          }
        }
        const clipsOk = foundClipCount > 0;
        details['narrationDubClips'] = clipsOk;
        if (!clipsOk) {
          missing.push('Generated dubbing clip audio files missing from IndexedDB');
        }
      }
    }

    // 2b. BGM & SFX audio assets
    const bgmVol = Number(project.voice.bgMusicVolume ?? 0);
    const bgmActive =
      !project.voice.bgMusicMuted &&
      bgmVol > 0.005 &&
      (project.voice.bgMusicEnabled !== undefined ? Boolean(project.voice.bgMusicEnabled) : Boolean(project.voice.bgMusicUrl));
    if (bgmActive) {
      for (const bgm of getEffectiveBgmClips(project)) {
        if (!bgm.muted && bgm.audioUrl?.startsWith('idb://blobs/')) {
          const k = bgm.audioUrl.slice('idb://blobs/'.length);
          const blob = await getBlobAssetByKey(k).catch(() => null);
          details[`bgm_${bgm.id}`] = Boolean(blob && blob.size > 0);
          if (!blob || blob.size === 0) missing.push(`Background music file (${bgm.label || k})`);
        }
      }
    }
    const sfxVol = Number(project.voice.sfxVolume ?? 1.0);
    const sfxActive = Boolean(project.voice.sfxEnabled) && !project.voice.sfxMuted && sfxVol > 0.005;
    if (sfxActive) {
      for (const sfx of getEffectiveSfxClips(project)) {
        if (!sfx.muted && sfx.audioUrl?.startsWith('idb://blobs/')) {
          const k = sfx.audioUrl.slice('idb://blobs/'.length);
          const blob = await getBlobAssetByKey(k).catch(() => null);
          details[`sfx_${sfx.id}`] = Boolean(blob && blob.size > 0);
          if (!blob || blob.size === 0) missing.push(`Sound effect file (${sfx.label || k})`);
        }
      }
    }

    // 3. Logos
    for (const logo of project.logos.filter((l) => l.enabled)) {
      if (logo.url.startsWith('idb://blobs/')) {
        const k = logo.url.slice('idb://blobs/'.length);
        const logoBlob = await getBlobAssetByKey(k).catch(() => null);
        details[`logo_${logo.id}`] = Boolean(logoBlob && logoBlob.size > 0);
        if (!logoBlob) missing.push(`Logo overlay (${logo.filename || k})`);
      }
    }

    return {
      valid: missing.length === 0,
      missing,
      sourceVideoFound,
      details,
    };
  },

  cancelLocalExport(projectId: string): boolean {
    const controller = activeExportControllers.get(projectId);
    if (!controller) return false;
    controller.abort();
    terminateBrowserFFmpeg();
    return true;
  },

  async startLocalExport(
    projectId: string,
    exportSettings: Project['exportSettings'],
    onProgress?: (pct: number, stage: string, etaSec?: number | null) => void
  ): Promise<{
    job: RenderJob;
    blob: Blob;
    url: string;
    filename: string;
    mimeType: string;
    engine: 'webcodecs-hardware' | 'webcodecs-software' | 'ffmpeg-wasm' | 'canvas-mediarecorder';
    hardwareAccelerated?: boolean;
    videoCodec?: string | null;
    audioCodec?: string | null;
    bitrateControl?: 'vbr-bitrate' | 'crf' | 'mediarecorder-vbr';
    targetVideoKbps?: number;
    targetAudioKbps?: number;
    framesRendered?: number;
    staticFramesReused?: number;
    peakHeapMb?: number | null;
    streamCopied?: boolean;
    multiThreaded?: boolean;
    renderDurationMs?: number;
    audioBranches?: string[];
    filterGraphSummary?: string;
    ffmpegArgsSummary?: string;
    inspection?: ExportRenderResult['inspection'];
  }> {
    if (activeExportControllers.has(projectId)) {
      throw new Error(
        'An export is already running for this project. Cancel it or wait for it to finish.'
      );
    }

    await ensureInitialized();
    let project = await this.getProject(projectId);
    if (!project) {
      throw new Error(`Project "${projectId}" not found in local IndexedDB storage.`);
    }

    // Update settings on project before rendering
    project = await this.updateProject(projectId, { exportSettings });

    const controller = new AbortController();
    activeExportControllers.set(projectId, controller);

    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();
    const job: RenderJob = {
      id: jobId,
      projectId: project.id,
      type: 'render',
      status: 'processing',
      progress: 5,
      stage: 'Detecting hardware & browser export capabilities...',
      etaSeconds: null,
      outputUrl: null,
      outputSize: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    await idbSet('jobs', jobId, job);

    const reportProgress = (pct: number, stage: string, etaSec?: number | null) => {
      job.progress = pct;
      job.stage = stage;
      if (etaSec !== undefined) {
        job.etaSeconds = etaSec;
      }
      job.updatedAt = new Date().toISOString();
      void idbSet('jobs', jobId, job).catch(() => {});
      if (onProgress) onProgress(pct, stage, etaSec);
    };

    let ffmpegResult: ExportRenderResult | null = null;
    let webCodecsResult: WebCodecsExportResult | null = null;
    let renderResult: { blob: Blob; filename: string; sizeBytes: number } | null = null;
    let usedEngine:
      | 'webcodecs-hardware'
      | 'webcodecs-software'
      | 'ffmpeg-wasm'
      | 'canvas-mediarecorder' = 'ffmpeg-wasm';

    const failJob = async (err: unknown): Promise<never> => {
      const errMessage = err instanceof Error ? err.message : String(err);
      const isAbort =
        controller.signal.aborted || (err instanceof Error && err.name === 'AbortError');
      const isValidationError = err instanceof ExportValidationError;
      job.status = 'failed';
      job.stage = isAbort
        ? 'Export cancelled'
        : isValidationError
        ? 'Export validation failed'
        : 'Export failed';
      job.etaSeconds = null;
      job.error = errMessage;
      job.updatedAt = new Date().toISOString();
      await idbSet('jobs', jobId, job).catch(() => {});
      throw err;
    };

    try {
      const canvasCfg = { ...DEFAULT_VIDEO_CANVAS, ...(project.canvas || {}) };
      const dims = resolveCanvasDimensions(canvasCfg, exportSettings, project.metadata);
      const targetFps = computeExportTargetFps({
        sourceFps: project.metadata?.fps,
        videoVisible: canvasCfg.videoVisible !== false,
        videoClipCount: getEffectiveVideoClips(project).length,
      });

      const streamCopyEligible = canProjectUseStreamCopy(project);
      const caps = await detectSmartExportCapabilities(dims.width, dims.height, targetFps);

      // 1. Try WebCodecs Hardware/Smart encoder first whenever project is NOT pure stream-copy
      if (!streamCopyEligible && caps.webCodecsVideo) {
        try {
          webCodecsResult = await renderProjectWithWebCodecs({
            project,
            capabilities: caps,
            signal: controller.signal,
            onProgress: reportProgress,
          });
          renderResult = webCodecsResult;
          usedEngine = webCodecsResult.engine;
        } catch (wcErr) {
          const isAbort =
            controller.signal.aborted ||
            (wcErr instanceof Error && wcErr.name === 'AbortError');
          if (isAbort || wcErr instanceof ExportValidationError) {
            await failJob(wcErr);
          }
          console.warn(
            '[LocalExport] WebCodecs renderer failed or was rejected by device encoder, falling back to FFmpeg.wasm:',
            wcErr
          );
          reportProgress(8, 'Switching to FFmpeg.wasm software H.264 encoder...', null);
        }
      }

      // 2. FFmpeg.wasm path (for stream-copy projects OR when WebCodecs is unavailable/failed)
      if (!renderResult) {
        try {
          usedEngine = 'ffmpeg-wasm';
          ffmpegResult = await renderProjectExportInBrowser({
            project,
            resolveUrlFn: (u) => u,
            signal: controller.signal,
            onProgress: reportProgress,
          });
          renderResult = ffmpegResult;
        } catch (ffmpegErr) {
          const isAbort =
            controller.signal.aborted ||
            (ffmpegErr instanceof Error && ffmpegErr.name === 'AbortError');
          if (isAbort || ffmpegErr instanceof ExportValidationError) {
            await failJob(ffmpegErr);
          }

          console.warn('[LocalExport] FFmpeg.wasm failed or unavailable, using Canvas fallback:', ffmpegErr);
          usedEngine = 'canvas-mediarecorder';
          reportProgress(12, 'Switching to browser Canvas + MediaRecorder fallback...', null);

          try {
            // 3. Fallback: Canvas + Web Audio + MediaRecorder for Android/low-memory browsers
            renderResult = await renderProjectCanvasFallback({
              project,
              signal: controller.signal,
              onProgress: reportProgress,
            });
          } catch (fallbackErr) {
            await failJob(fallbackErr);
          }
        }
      }

      if (!renderResult) {
        await failJob(new Error('All local video export engines failed to produce an output file.'));
      }

      const finalOut = renderResult!;
      const mimeType =
        finalOut.blob.type ||
        (finalOut.filename.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4');
      const extLabel = finalOut.filename.toLowerCase().endsWith('.webm') ? 'WEBM' : 'MP4';

      const blobKey = buildAssetBlobKey('exports', project.id, finalOut.filename);
      const durableUrl = await this.saveProjectMedia(project.id, blobKey, finalOut.blob, mimeType);

      const speedPreset = resolveExportSpeedPreset(exportSettings.speedProfile);
      const engineBadgeText =
        usedEngine === 'webcodecs-hardware'
          ? `WebCodecs HW H.264 · ${speedPreset.label}`
          : usedEngine === 'webcodecs-software'
          ? `WebCodecs Smart H.264 · ${speedPreset.label}`
          : usedEngine === 'ffmpeg-wasm'
          ? ffmpegResult?.streamCopied
            ? 'FFmpeg Stream Copy'
            : `FFmpeg.wasm CRF ${speedPreset.crf} · ${speedPreset.label}`
          : `Canvas Fallback · ${speedPreset.label}`;

      job.status = 'completed';
      job.progress = 100;
      job.etaSeconds = 0;
      job.stage = `Export completed (${extLabel} · ${engineBadgeText})`;
      job.outputUrl = durableUrl;
      job.outputSize = finalOut.sizeBytes;
      job.updatedAt = new Date().toISOString();
      await idbSet('jobs', jobId, job);

      await this.updateProject(project.id, {
        lastExportUrl: durableUrl,
        lastExportSize: finalOut.sizeBytes,
        lastExportedAt: new Date().toISOString(),
        workflow: createWorkflowUpdate(project.workflow, {
          completeStage: 'export',
          clearAttentionFor: 'export',
        }),
      });

      return {
        job,
        blob: finalOut.blob,
        url: durableUrl,
        filename: finalOut.filename,
        mimeType,
        engine: usedEngine,
        ...(webCodecsResult
          ? {
              hardwareAccelerated: webCodecsResult.hardwareAccelerated,
              videoCodec: webCodecsResult.videoCodec,
              audioCodec: webCodecsResult.audioCodec,
              bitrateControl: webCodecsResult.bitrateControl,
              targetVideoKbps: webCodecsResult.targetVideoKbps,
              targetAudioKbps: webCodecsResult.targetAudioKbps,
              renderDurationMs: webCodecsResult.renderDurationMs,
              audioBranches: webCodecsResult.audioBranches,
              framesRendered: webCodecsResult.framesRendered,
              staticFramesReused: webCodecsResult.staticFramesReused,
              peakHeapMb: webCodecsResult.peakHeapMb,
            }
          : ffmpegResult
          ? {
              hardwareAccelerated: false,
              videoCodec: ffmpegResult.inspection?.videoCodec || 'h264',
              audioCodec: ffmpegResult.inspection?.audioCodec || null,
              bitrateControl: 'crf' as const,
              targetVideoKbps: speedPreset.videoTargetKbps,
              targetAudioKbps: EXPORT_AUDIO_BITRATE_KBPS,
              streamCopied: ffmpegResult.streamCopied,
              multiThreaded: ffmpegResult.multiThreaded,
              renderDurationMs: ffmpegResult.renderDurationMs,
              audioBranches: ffmpegResult.audioBranches,
              filterGraphSummary: ffmpegResult.filterGraphSummary,
              ffmpegArgsSummary: ffmpegResult.ffmpegArgsSummary,
              inspection: ffmpegResult.inspection,
            }
          : {
              hardwareAccelerated: false,
              bitrateControl: 'mediarecorder-vbr' as const,
              targetVideoKbps: speedPreset.videoTargetKbps,
              targetAudioKbps: EXPORT_AUDIO_BITRATE_KBPS,
            }),
      };
    } finally {
      activeExportControllers.delete(projectId);
    }
  },
};
