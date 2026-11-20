import {
  Project,
  StudioPreset,
  SavedFishVoice,
  SavedFontAsset,
  DefaultStudioPreferences,
  RenderJob,
  FilmstripFrame,
  SyncMode,
  StyleApplyScope,
  VideoMetadata,
} from '../types/studio';
import {
  buildTimelineSyncPlan,
  applySyncPlanToClips,
  clampContinuousPauseMs,
  normalizeSyncMode,
} from '../../server/services/timeline_sync_service';
import { idbGet, idbSet, idbList, idbDelete, buildAssetBlobKey } from './browserStorage';
import { localProjectService } from './localProjectService';
import { createDefaultMainVideoClip } from './videoTimeline';
import { BUILTIN_FONT_CATALOG } from './fontCatalogData';
import { parseSrtOrVtt } from './subtitleAss';
import { applySavedStyleToProjectData, buildSavedStylePayloadFromProject } from './savedStyles';
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
    const projects = await localProjectService.getAllProjects();
    return { projects } as unknown as T;
  }

  if (pathname === '/api/projects' && method === 'POST') {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const newProj = await localProjectService.createProject(body);
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
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const proj = await localProjectService.getProject(projId);
    if (!proj) throw new Error('Project not found');
    const exportResult = await localProjectService.startLocalExport(
      projId,
      body.settings || proj.exportSettings
    );
    return { job: exportResult.job } as unknown as T;
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

  const mediaMatch = /^\/api\/projects\/([^/]+)\/media$/.exec(pathname);
  if (mediaMatch && method === 'GET') {
    const projId = decodeURIComponent(mediaMatch[1] || '').trim();
    const media = await localProjectService.getProjectMedia(projId);
    return media as unknown as T;
  }

  const projMatch = /^\/api\/projects\/([^/]+)$/.exec(pathname);
  if (projMatch) {
    const projId = decodeURIComponent(projMatch[1] || '').trim();
    if (!projId || projId === 'undefined' || projId === 'null') {
      throw new Error('Invalid or missing projectId.');
    }
    if (method === 'GET') {
      const proj = await localProjectService.getProject(projId);
      if (!proj) throw new Error('Project not found');
      return { project: proj } as unknown as T;
    }
    if (method === 'PATCH') {
      const patch = init?.body ? JSON.parse(String(init.body)) : {};
      const updated = await localProjectService.updateProject(projId, patch);
      return { project: updated } as unknown as T;
    }
    if (method === 'DELETE') {
      const success = await localProjectService.deleteProject(projId);
      return { deleted: success } as unknown as T;
    }
  }

  if (pathname === '/api/presets') {
    if (method === 'GET') {
      const category = parsedUrl.searchParams.get('category');
      const all = (await idbList<StudioPreset>('presets')) || [];
      const presets = category ? all.filter((p) => p.category === category) : all;
      return { presets } as unknown as T;
    }
    if (method === 'POST') {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const now = new Date().toISOString();
      const preset: StudioPreset = {
        id: crypto.randomUUID(),
        category: body.category || 'caption',
        name: String(body.name || 'Untitled Preset'),
        description: body.description,
        isDefault: Boolean(body.isDefault),
        thumbnailStyle: body.thumbnailStyle,
        payload: body.payload || {},
        assetRefs: body.assetRefs,
        createdAt: now,
        updatedAt: now,
      };
      await idbSet('presets', preset.id, preset);
      const presets = (await idbList<StudioPreset>('presets')) || [];
      return { preset, presets } as unknown as T;
    }
  }

  const presetIdMatch = /^\/api\/presets\/([^/]+)$/.exec(pathname);
  if (presetIdMatch) {
    const id = presetIdMatch[1];
    if (method === 'PATCH') {
      const patch = init?.body ? JSON.parse(String(init.body)) : {};
      const found = await idbGet<StudioPreset>('presets', id);
      if (!found) throw new Error('Preset not found');
      const updated = { ...found, ...patch, updatedAt: new Date().toISOString() };
      await idbSet('presets', id, updated);
      const presets = (await idbList<StudioPreset>('presets')) || [];
      return { preset: updated, presets } as unknown as T;
    }
    if (method === 'DELETE') {
      await idbDelete('presets', id);
      const presets = (await idbList<StudioPreset>('presets')) || [];
      return { deleted: true, presets } as unknown as T;
    }
  }

  if (pathname === '/api/styles') {
    if (method === 'GET') {
      const presets = (await idbList<StudioPreset>('presets')) || [];
      const styles = presets.filter((p) => p.category === 'style');
      const def = styles.find((s) => s.isDefault);
      return { styles, defaultStyleId: def?.id || null } as unknown as T;
    }
    if (method === 'POST') {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const now = new Date().toISOString();
      let payload = body.payload || {};
      let thumbnailStyle = body.thumbnailStyle;
      let assetRefs = body.assetRefs;

      if (body.projectId && !body.payload) {
        const srcProj = await localProjectService.getProject(String(body.projectId));
        if (srcProj) {
          const savedVoices = (await idbList<SavedFishVoice>('saved_fish_voices')) || [];
          const built = buildSavedStylePayloadFromProject(srcProj, {
            savedVoices,
            thumbnailImageUrl: body.thumbnailImageUrl || body.thumbnailDataUrl,
          });
          payload = built.payload;
          thumbnailStyle = built.thumbnailStyle;
          assetRefs = built.assetRefs;
        }
      }

      const style: StudioPreset = {
        id: crypto.randomUUID(),
        category: 'style',
        name: String(body.name || 'Saved Style'),
        description: body.description,
        isDefault: Boolean(body.isDefault),
        thumbnailStyle,
        payload,
        assetRefs,
        createdAt: now,
        updatedAt: now,
      };
      if (style.isDefault) {
        const all = (await idbList<StudioPreset>('presets')) || [];
        for (const p of all) {
          if (p.category === 'style' && p.isDefault) {
            await idbSet('presets', p.id, { ...p, isDefault: false });
          }
        }
      }
      await idbSet('presets', style.id, style);
      const all = (await idbList<StudioPreset>('presets')) || [];
      const styles = all.filter((p) => p.category === 'style');
      return { style, styles } as unknown as T;
    }
  }

  const dupStyleMatch = /^\/api\/styles\/([^/]+)\/duplicate$/.exec(pathname);
  if (dupStyleMatch && method === 'POST') {
    const id = dupStyleMatch[1];
    const found = await idbGet<StudioPreset>('presets', id);
    if (!found) throw new Error('Style not found');
    const now = new Date().toISOString();
    const copy: StudioPreset = {
      ...found,
      id: crypto.randomUUID(),
      name: `${found.name} (Copy)`,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    };
    await idbSet('presets', copy.id, copy);
    const all = (await idbList<StudioPreset>('presets')) || [];
    return { style: copy, styles: all.filter((p) => p.category === 'style') } as unknown as T;
  }

  const styleIdMatch = /^\/api\/styles\/([^/]+)$/.exec(pathname);
  if (styleIdMatch) {
    const id = styleIdMatch[1];
    if (method === 'PATCH') {
      const patch = init?.body ? JSON.parse(String(init.body)) : {};
      const found = await idbGet<StudioPreset>('presets', id);
      if (!found) throw new Error('Style not found');
      const updated = { ...found, ...patch, updatedAt: new Date().toISOString() };
      if (patch.isDefault) {
        const all = (await idbList<StudioPreset>('presets')) || [];
        for (const p of all) {
          if (p.id !== id && p.category === 'style' && p.isDefault) {
            await idbSet('presets', p.id, { ...p, isDefault: false });
          }
        }
      }
      await idbSet('presets', id, updated);
      const all = (await idbList<StudioPreset>('presets')) || [];
      return { style: updated, styles: all.filter((p) => p.category === 'style') } as unknown as T;
    }
    if (method === 'DELETE') {
      await idbDelete('presets', id);
      const all = (await idbList<StudioPreset>('presets')) || [];
      return { deleted: true, styles: all.filter((p) => p.category === 'style') } as unknown as T;
    }
  }

  const applyStyleMatch = /^\/api\/projects\/([^/]+)\/apply-style$/.exec(pathname);
  if (applyStyleMatch && method === 'POST') {
    const projId = applyStyleMatch[1];
    const proj = await localProjectService.getProject(projId);
    if (!proj) throw new Error('Project not found');
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const style = await idbGet<StudioPreset>('presets', String(body.styleId || ''));
    if (!style) throw new Error('Saved style not found');
    const scope = (body.scope || 'all') as StyleApplyScope;
    const savedVoices = (await idbList<SavedFishVoice>('saved_fish_voices')) || [];
    const customFonts = (await idbList<SavedFontAsset>('fonts')) || [];
    const availUrls = new Set(customFonts.map((f) => f.url));

    const res = applySavedStyleToProjectData({
      project: proj,
      style,
      scope,
      savedVoices,
      checkAssetAvailable: (u) => Boolean(u && (u.startsWith('idb://blobs/') || availUrls.has(u))),
      generateId: () => crypto.randomUUID(),
      preserveCaptionEnabledState: true,
    });
    const updated =
      Object.keys(res.patch).length > 0
        ? await localProjectService.updateProject(projId, res.patch)
        : proj;
    return {
      project: updated,
      warnings: res.warnings,
      voiceMissingWarning: res.voiceMissingWarning,
    } as unknown as T;
  }

  const applyPresetsMatch = /^\/api\/projects\/([^/]+)\/apply-presets$/.exec(pathname);
  if (applyPresetsMatch && method === 'POST') {
    const projId = applyPresetsMatch[1];
    const proj = await localProjectService.getProject(projId);
    if (!proj) throw new Error('Project not found');
    return { project: proj, presetWarnings: [] } as unknown as T;
  }

  const importCaptionsMatch = /^\/api\/projects\/([^/]+)\/captions\/import$/.exec(pathname);
  if (importCaptionsMatch && method === 'POST') {
    const projId = importCaptionsMatch[1];
    const proj = await localProjectService.getProject(projId);
    if (!proj) throw new Error('Project not found');
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const parsed = parseSrtOrVtt(String(body.content || ''));
    const updated = await localProjectService.updateProject(projId, { captions: parsed });
    return { project: updated, count: parsed.length } as unknown as T;
  }

  const saveThumbMatch = /^\/api\/projects\/([^/]+)\/thumbnails\/save$/.exec(pathname);
  if (saveThumbMatch && method === 'POST') {
    const projId = saveThumbMatch[1];
    const proj = await localProjectService.getProject(projId);
    if (!proj) throw new Error('Project not found');
    const fd = init?.body as FormData;
    const file = fd?.get('file') as File | Blob | null;
    if (!file) throw new Error('Missing thumbnail image blob.');
    const label = String(fd.get('label') || 'Cover');
    const width = Number(fd.get('width') || 1080);
    const height = Number(fd.get('height') || 1920);
    const format = String(fd.get('format') || 'png') === 'jpg' ? 'jpg' : 'png';
    const setAsCover = String(fd.get('setAsCover')) === 'true';

    const key = buildAssetBlobKey('thumbs', projId, `thumb_${Date.now()}.${format}`);
    const durableUrl = await localProjectService.saveProjectMedia(
      projId,
      key,
      file,
      format === 'jpg' ? 'image/jpeg' : 'image/png'
    );
    const entry = {
      id: crypto.randomUUID(),
      url: durableUrl,
      label,
      width,
      height,
      format: format as 'png' | 'jpg',
      createdAt: new Date().toISOString(),
    };
    const updated = await localProjectService.updateProject(projId, {
      ...(setAsCover ? { thumbnailUrl: durableUrl } : {}),
      savedThumbnails: [entry, ...(proj.savedThumbnails || [])],
    });
    return { thumbnail: entry, project: updated } as unknown as T;
  }

  const maskMatch = /^\/api\/projects\/([^/]+)\/mask$/.exec(pathname);
  if (maskMatch && method === 'POST') {
    const projId = maskMatch[1];
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const b64 = String(body.maskBase64 || '');
    const resp = await fetch(b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`);
    const blob = await resp.blob();
    const assetId = `mask_${body.blurId || crypto.randomUUID()}`;
    const key = buildAssetBlobKey('masks', projId, `${assetId}.png`);
    const maskUrl = await localProjectService.saveProjectMedia(projId, key, blob, 'image/png');
    return { maskUrl, assetId } as unknown as T;
  }

  const sampleVideoMatch = /^\/api\/projects\/([^/]+)\/sample-video$/.exec(pathname);
  if (sampleVideoMatch && method === 'POST') {
    const projId = sampleVideoMatch[1];
    const proj = await localProjectService.getProject(projId);
    if (!proj) throw new Error('Project not found');
    const canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 1280;
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(24);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    const blob = await new Promise<Blob>((resolve) => {
      rec.onstop = () => resolve(new Blob(chunks, { type: mime }));
      rec.start(100);
      let frame = 0;
      const timer = setInterval(() => {
        if (ctx) {
          ctx.fillStyle = '#0B0B12';
          ctx.fillRect(0, 0, 720, 1280);
          ctx.fillStyle = '#7C3AED';
          ctx.fillRect(60, 420 + Math.sin(frame / 5) * 40, 600, 12);
          ctx.fillStyle = '#FFFFFF';
          ctx.font = 'bold 42px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('LOCAL SAMPLE RECAP', 360, 620);
          ctx.font = '24px monospace';
          ctx.fillStyle = '#A1A1AA';
          ctx.fillText(`00:0${Math.min(5, Math.floor(frame / 24))}`, 360, 680);
        }
        frame += 1;
        if (frame >= 72) {
          clearInterval(timer);
          rec.stop();
        }
      }, 42);
    });
    const key = buildAssetBlobKey('uploads', projId, 'sample_recap.webm');
    const durableUrl = await localProjectService.saveProjectMedia(projId, key, blob, mime);
    const thumbDataUrl = canvas.toDataURL('image/jpeg', 0.8);
    const meta: VideoMetadata = {
      duration: 3,
      width: 720,
      height: 1280,
      fps: 24,
      videoCodec: 'vp8',
      audioCodec: null,
      bitrate: 1500000,
      fileSize: blob.size,
      hasAudio: false,
      formatName: 'webm',
    };
    const updated = await localProjectService.updateProject(projId, {
      sourceVideoUrl: durableUrl,
      sourceVideoBlobKey: key,
      sourceFilename: 'sample_recap.webm',
      thumbnailUrl: thumbDataUrl,
      metadata: meta,
      videoClips: [createDefaultMainVideoClip({ filename: 'sample_recap.webm', duration: 3 })],
    });
    return { project: updated } as unknown as T;
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

  if (pathname === '/api/fonts/catalog' && method === 'GET') {
    const custom = (await idbList<SavedFontAsset>('fonts')) || [];
    return { builtin: BUILTIN_FONT_CATALOG, custom } as unknown as T;
  }

  if (pathname === '/api/fonts/ensure' && method === 'GET') {
    const family = parsedUrl.searchParams.get('family') || '';
    const weight = Number(parsedUrl.searchParams.get('weight') || 700);
    const italic = parsedUrl.searchParams.get('italic') === '1';
    const customFonts = (await idbList<SavedFontAsset>('fonts')) || [];
    const customMatch = customFonts.find((f) => f.family.toLowerCase() === family.toLowerCase());
    if (customMatch) {
      return {
        available: true,
        family: customMatch.family,
        resolvedWeight: weight,
        italic,
        url: customMatch.url,
        source: 'custom',
        exportCompatible: true,
      } as unknown as T;
    }
    return {
      available: true,
      family,
      resolvedWeight: weight,
      italic,
      source: 'builtin',
      exportCompatible: true,
    } as unknown as T;
  }

  if (pathname === '/api/fonts') {
    if (method === 'GET') {
      const fonts = (await idbList<SavedFontAsset>('fonts')) || [];
      return { fonts } as unknown as T;
    }
    if (method === 'POST') {
      const fd = init?.body as FormData;
      const file = fd?.get('file') as File | null;
      if (!file) throw new Error('Font file missing');
      const familyRaw = String(fd.get('family') || file.name.replace(/\.[^.]+$/, ''));
      const id = crypto.randomUUID();
      const key = buildAssetBlobKey('fonts', 'global', `${id}_${file.name}`);
      const durableUrl = await localProjectService.saveProjectMedia('global', key, file, file.type || 'font/ttf');
      const fontAsset: SavedFontAsset = {
        id,
        family: familyRaw,
        filename: file.name,
        url: durableUrl,
        createdAt: new Date().toISOString(),
      };
      await idbSet('fonts', id, fontAsset);
      const fonts = (await idbList<SavedFontAsset>('fonts')) || [];
      return { font: fontAsset, fonts, exportCompatible: true } as unknown as T;
    }
  }

  const fontIdMatch = /^\/api\/fonts\/([^/]+)$/.exec(pathname);
  if (fontIdMatch && method === 'DELETE') {
    await idbDelete('fonts', fontIdMatch[1]);
    const fonts = (await idbList<SavedFontAsset>('fonts')) || [];
    return { deleted: true, fonts } as unknown as T;
  }

  return undefined;
}
