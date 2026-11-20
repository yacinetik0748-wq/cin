import {
  CaptionSegment,
  CloudAssetKind,
  DEFAULT_VIDEO_CANVAS,
  DefaultStudioPreferences,
  FilmstripFrame,
  FishAudioSettingsSummary,
  FishConnectionStatus,
  FishVoiceModel,
  GeminiVoiceName,
  LogoOverlay,
  PresetCategory,
  Project,
  ProjectAudioWaveforms,
  RenderJob,
  SavedFishVoice,
  SavedFontAsset,
  StyleApplyScope,
  StyleMissingVoiceWarning,
  StudioPreset,
  StudioPresetAssetRef,
  SupportedLanguage,
  SyncMode,
  SystemStatus,
  VideoCanvasConfig,
  VideoMetadata,
} from '../types/studio';
import type { FontCatalogItem } from './fontCatalog';
import { handleLocalApiFallback } from './localApiFallback';
import { processVideoUploadInBrowser } from './browserVideoProcessor';
import {
  idbGet,
  idbSet,
  idbDelete,
  idbList,
  storeBlobAsset,
  buildAssetBlobKey,
  computeIndexedDbUsage,
} from './browserStorage';
import { indexedDbStore } from './indexedDbStore';
import { localProjectService } from './localProjectService';
import {
  getStoredFishApiKey,
  getFishAudioSettingsSummary,
  saveStoredFishApiKey,
  testFishAudioConnection,
  deleteStoredFishApiKey,
  fetchFishVoicesFromBrowser,
  validateFishVoiceInBrowser,
} from './fishAudioKeyManager';
import {
  previewFishTtsViaProxy,
  startBrowserFishDubJob,
  regenerateFishSegmentsInBrowser,
  transcribeWithFishViaProxy,
} from './browserFishClient';

export interface LocalAssetManifestItem {
  localUrl: string;
  bucket: string;
  filename: string;
  assetKind: CloudAssetKind;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  exists: boolean;
  exceedsFree50MbCap: boolean;
  necessaryForCloudSync: boolean;
}

export const API_BASE_URL = (
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_BASE_URL) ||
  ''
).replace(/\/+$/, '');

export function resolveApiUrl(path: string): string {
  if (!path) return '';
  if (
    path.startsWith('http://') ||
    path.startsWith('https://') ||
    path.startsWith('blob:') ||
    path.startsWith('data:')
  ) {
    return path;
  }
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return API_BASE_URL ? `${API_BASE_URL}${cleanPath}` : cleanPath;
}

export function isValidProjectId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  return Boolean(trimmed && trimmed !== 'undefined' && trimmed !== 'null');
}

export class ApiHttpError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiHttpError';
    this.status = status;
    this.code = code;
  }
}

function isSpaShellHtml(raw: string): boolean {
  const head = raw.trimStart().slice(0, 800).toLowerCase();
  return (
    head.startsWith('<!doctype html') ||
    head.includes('<div id="root"') ||
    head.includes('src="/src/main.tsx"')
  );
}

let cachedLocalOnly = true;

function isStorageRoute(url: string): boolean {
  const p = url.split('?')[0];
  return (
    p.startsWith('/api/projects') ||
    p.startsWith('/api/presets') ||
    p.startsWith('/api/styles') ||
    p.startsWith('/api/fonts') ||
    p.startsWith('/api/jobs') ||
    p.startsWith('/api/settings') ||
    p.startsWith('/api/uploads') ||
    p.startsWith('/api/system/storage-usage') ||
    p.startsWith('/api/system/status') ||
    p.startsWith('/api/system/cleanup')
  );
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  if (cachedLocalOnly && isStorageRoute(url)) {
    const localResult = await handleLocalApiFallback<T>(url, init);
    if (localResult !== undefined) {
      return localResult;
    }
  }

  const fullUrl = resolveApiUrl(url);
  let res: Response;
  let raw = '';
  let data: Record<string, unknown> | null = null;

  try {
    res = await fetch(fullUrl, init);
    raw = await res.text();
    if (raw) {
      try {
        data = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        data = null;
      }
    }
  } catch (networkErr) {
    // Offline or network failure: use IndexedDB fallback if supported for this route
    const localResult = await handleLocalApiFallback<T>(url, init);
    if (localResult !== undefined) {
      return localResult;
    }
    throw networkErr;
  }

  if (data) {
    if (data.localOnly === true || data.storageMode === 'local-indexeddb') {
      cachedLocalOnly = true;
      const localResult = await handleLocalApiFallback<T>(url, init);
      if (localResult !== undefined) {
        return localResult;
      }
    }
    if (!res.ok) {
      const errMsg = typeof data.error === 'string' ? data.error : `Request failed (${res.status})`;
      const errCode = typeof data.code === 'string' ? data.code : undefined;
      throw new ApiHttpError(errMsg, res.status, errCode);
    }
    return data as T;
  }

  // Non-JSON / HTML response: only fall back to local IndexedDB when hitting static hosting
  // without any backend (e.g., 200 SPA index.html shell or generic 404 without API error body).
  // Never mask genuine server errors (413, 500, 502, 503, 400, etc.) as "Project not found".
  if ((res.status === 200 && isSpaShellHtml(raw)) || res.status === 404) {
    const localResult = await handleLocalApiFallback<T>(url, init);
    if (localResult !== undefined) {
      return localResult;
    }
  }

  if (!res.ok) {
    if (res.status === 413) {
      throw new ApiHttpError(
        'Uploaded file exceeds the server payload limit. Try chunked upload or a smaller video.',
        413,
        'PAYLOAD_TOO_LARGE'
      );
    }
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new ApiHttpError(
        `Backend service is unavailable (${res.status}). Check server/database configuration and try again.`,
        res.status,
        'SERVICE_UNAVAILABLE'
      );
    }
    throw new ApiHttpError(`Request failed (${res.status})`, res.status);
  }
  throw new Error('Server returned an unexpected non-JSON response. Please try again.');
}

export interface PresetApplyOptions {
  captionPresetId?: string | null;
  filterPresetId?: string | null;
  editingPresetId?: string | null;
  styleId?: string | null;
  applyDefaults?: boolean;
  applyDefaultStyle?: boolean;
}

export interface PresetWarning {
  presetName: string;
  missingAssets: StudioPresetAssetRef[];
}

export const api = {
  getSystemStatus: async () => {
    const localKey = await getStoredFishApiKey();
    return {
      geminiConfigured: false,
      fishConfigured: Boolean(localKey),
      ffmpegAvailable: true,
      ffprobeAvailable: true,
      ffmpegVersion: 'wasm-browser',
      storageDir: 'indexeddb',
      maxUploadSizeMb: 4096,
      tempRetentionHours: 72,
      supportedVideoFormats: ['MP4', 'MOV', 'MKV', 'WEBM'],
      supportedLogoFormats: ['PNG', 'SVG', 'JPG', 'WEBP'],
      runtime: 'cloudflare-pages' as const,
      localOnly: true,
      storageMode: 'local-indexeddb',
      d1Available: false,
      databaseConfigured: false,
    };
  },

  getFishAudioSettings: () => getFishAudioSettingsSummary(),

  saveFishApiKey: (apiKey: string) => saveStoredFishApiKey(apiKey),

  testFishAudioConnection: (apiKey?: string) => testFishAudioConnection(apiKey),

  deleteFishApiKey: () => deleteStoredFishApiKey(),

  getDefaultPreferences: async () => {
    const prefs =
      (await idbGet<DefaultStudioPreferences>('settings', 'preferences')) || {
        autoApplyDefaultStyleOnImport: true,
        defaultStyleId: null,
        defaultTargetLanguage: 'English',
        defaultSyncMode: 'flexible' as const,
      };
    return { preferences: prefs, defaultStyle: null };
  },

  updateDefaultPreferences: async (patch: Partial<DefaultStudioPreferences>) => {
    const prefs =
      (await idbGet<DefaultStudioPreferences>('settings', 'preferences')) || {
        autoApplyDefaultStyleOnImport: true,
        defaultStyleId: null,
        defaultTargetLanguage: 'English',
        defaultSyncMode: 'flexible' as const,
      };
    const updated = { ...prefs, ...patch };
    await idbSet('settings', 'preferences', updated);
    return { preferences: updated, defaultStyle: null };
  },

  getSupabaseSchema: () => request<{ sql: string }>('/api/system/supabase-schema'),

  getLocalStorageUsage: async () => {
    return computeIndexedDbUsage();
  },

  runCleanup: async () => {
    return { removedFiles: 0 };
  },

  getProjectAssetManifest: (projectId: string) =>
    request<{
      assets: LocalAssetManifestItem[];
      totalBytes: number;
      necessaryBytes: number;
      oversizedCount: number;
    }>(`/api/projects/${projectId}/asset-manifest`),

  compressProjectVideo: (
    projectId: string,
    preset: 'under-45mb' | '720p-compact' | '480p-compact',
    target: 'source' | 'final-export' = 'source'
  ) =>
    request<{
      project: Project;
      compressedUrl: string;
      filename: string;
      originalSourceUrl: string;
      originalBytes: number;
      compressedBytes: number;
      metadata: VideoMetadata;
      target: 'source' | 'final-export';
    }>(`/api/projects/${projectId}/compress-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset, target }),
    }),

  saveProjectThumbnail: async (
    projectId: string,
    params: {
      blob: Blob;
      label: string;
      width: number;
      height: number;
      format: 'png' | 'jpg';
      setAsCover?: boolean;
    }
  ) => {
    const fd = new FormData();
    fd.append('file', params.blob, `thumb.${params.format}`);
    fd.append('label', params.label);
    fd.append('width', String(params.width));
    fd.append('height', String(params.height));
    fd.append('format', params.format);
    fd.append('setAsCover', params.setAsCover ? 'true' : 'false');
    return request<{
      thumbnail: {
        id: string;
        url: string;
        label: string;
        width: number;
        height: number;
        format: 'png' | 'jpg';
        createdAt: string;
      };
      project: Project;
    }>(`/api/projects/${projectId}/thumbnails/save`, {
      method: 'POST',
      body: fd,
    });
  },

  upsertProjectFromCloud: (project: Project) =>
    request<{ project: Project }>('/api/projects/upsert-from-cloud', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project }),
    }),

  detectOriginalCaptions: (projectId: string) =>
    request<{
      project: Project;
      detections: NonNullable<Project['subtitleRemoval']>['detections'];
      ocrAvailable: boolean;
      method: 'hybrid' | 'ocr' | 'visual' | 'unavailable';
      analysisMessage: string;
      framesAnalyzed: number;
    }>(`/api/projects/${projectId}/blurs/detect-captions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),

  hydrateAssetFromBlob: async (
    projectId: string,
    params: {
      blob: Blob;
      bucket: string;
      filename: string;
      assetKind: CloudAssetKind;
      mimeType: string;
      targetLocalUrl?: string;
    }
  ) => {
    const fd = new FormData();
    fd.append('file', params.blob, params.filename);
    fd.append('bucket', params.bucket);
    fd.append('filename', params.filename);
    fd.append('assetKind', params.assetKind);
    fd.append('mimeType', params.mimeType);
    if (params.targetLocalUrl) fd.append('targetLocalUrl', params.targetLocalUrl);
    return request<{ localUrl: string; filePath: string; sizeBytes: number }>(
      `/api/projects/${projectId}/hydrate-asset`,
      {
        method: 'POST',
        body: fd,
      }
    );
  },

  listFishVoices: async (params?: { query?: string; selfOnly?: boolean; language?: string }) => {
    const localKey = await getStoredFishApiKey();
    if (localKey) {
      return fetchFishVoicesFromBrowser(localKey, params);
    }
    const qs = new URLSearchParams();
    if (params?.query) qs.set('q', params.query);
    if (params?.selfOnly) qs.set('self', 'true');
    if (params?.language) qs.set('language', params.language);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ voices: FishVoiceModel[]; total: number }>(`/api/fish/voices${suffix}`);
  },

  listSavedFishVoices: () =>
    request<{ voices: SavedFishVoice[] }>('/api/fish/saved-voices'),

  validateSavedFishVoice: async (voiceId: string) => {
    const localKey = await getStoredFishApiKey();
    if (localKey) {
      return validateFishVoiceInBrowser(localKey, voiceId);
    }
    return request<{
      valid: boolean;
      checked: boolean;
      voiceId: string;
      title?: string;
      description?: string;
      languages?: string[];
      message: string;
    }>('/api/fish/saved-voices/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voiceId }),
    });
  },

  previewSavedFishVoice: async (params: { voiceId?: string; text?: string }) => {
    const localKey = await getStoredFishApiKey();
    if (localKey) {
      const text =
        String(params.text || '').trim() ||
        'Everything changed the moment the vault door swung open in silence.';
      return previewFishTtsViaProxy(localKey, {
        text,
        referenceId: params.voiceId,
      });
    }
    return request<{ audioUrl: string }>('/api/fish/saved-voices/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  },

  createSavedFishVoice: async (params: {
    name: string;
    voiceId: string;
    description?: string;
    language?: string;
    sampleUrl?: string;
    previewText?: string;
    isDefault?: boolean;
    skipRemoteValidation?: boolean;
  }) => {
    const localKey = await getStoredFishApiKey();
    let payload: Record<string, unknown> = { ...params };
    let localValidationMsg: string | undefined;
    if (localKey && !params.skipRemoteValidation) {
      const check = await validateFishVoiceInBrowser(localKey, params.voiceId);
      localValidationMsg = check.message;
      payload = { ...params, skipRemoteValidation: true, validated: check.checked && check.valid };
    }
    const res = await request<{ voice: SavedFishVoice; voices: SavedFishVoice[]; validationMessage?: string }>(
      '/api/fish/saved-voices',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    return {
      ...res,
      validationMessage: res.validationMessage || localValidationMsg,
    };
  },

  rebuildFishDubTrack: (
    projectId: string,
    params?: { generatedClips?: Project['voice']['generatedClips'] }
  ) =>
    request<{
      project: Project;
      fullDubUrl: string;
      clips: Project['voice']['generatedClips'];
    }>(`/api/projects/${projectId}/dubbing/rebuild-track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
    }),

  updateSavedFishVoice: async (
    id: string,
    params: {
      name?: string;
      voiceId?: string;
      description?: string;
      language?: string;
      sampleUrl?: string;
      previewText?: string;
      isDefault?: boolean;
      skipRemoteValidation?: boolean;
    }
  ) => {
    const localKey = await getStoredFishApiKey();
    let payload: Record<string, unknown> = { ...params };
    if (localKey && params.voiceId && !params.skipRemoteValidation) {
      const check = await validateFishVoiceInBrowser(localKey, params.voiceId);
      payload = { ...params, skipRemoteValidation: true, validated: check.checked && check.valid };
    }
    return request<{ voice: SavedFishVoice; voices: SavedFishVoice[] }>(`/api/fish/saved-voices/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  duplicateSavedFishVoice: (id: string) =>
    request<{ voice: SavedFishVoice; voices: SavedFishVoice[] }>(
      `/api/fish/saved-voices/${id}/duplicate`,
      { method: 'POST' }
    ),

  deleteSavedFishVoice: (id: string) =>
    request<{ deleted: boolean; voices: SavedFishVoice[] }>(`/api/fish/saved-voices/${id}`, {
      method: 'DELETE',
    }),

  listCustomFonts: () => request<{ fonts: SavedFontAsset[] }>('/api/fonts'),

  getFontCatalog: () =>
    request<{ builtin: FontCatalogItem[]; custom: SavedFontAsset[] }>('/api/fonts/catalog'),

  ensureFont: (family: string, weight = 700, italic = false) =>
    request<{
      available: boolean;
      family: string;
      resolvedWeight: number;
      italic: boolean;
      url?: string;
      source?: 'builtin' | 'custom' | 'system';
      exportCompatible?: boolean;
      error?: string;
    }>(
      `/api/fonts/ensure?family=${encodeURIComponent(family)}&weight=${weight}&italic=${italic ? '1' : '0'}`
    ),

  uploadCustomFont: async (file: File, family?: string) => {
    const fd = new FormData();
    fd.append('file', file);
    if (family) fd.append('family', family);
    return request<{ font: SavedFontAsset; fonts: SavedFontAsset[]; exportCompatible?: boolean }>(
      '/api/fonts',
      {
        method: 'POST',
        body: fd,
      }
    );
  },

  deleteCustomFont: (id: string) =>
    request<{ deleted: boolean; fonts: SavedFontAsset[] }>(`/api/fonts/${id}`, {
      method: 'DELETE',
    }),

  listPresets: (category?: PresetCategory) =>
    request<{ presets: StudioPreset[] }>(
      category ? `/api/presets?category=${encodeURIComponent(category)}` : '/api/presets'
    ),

  createPreset: (params: {
    category: PresetCategory;
    name: string;
    description?: string;
    isDefault?: boolean;
    thumbnailStyle?: StudioPreset['thumbnailStyle'];
    payload: Record<string, unknown>;
    assetRefs?: StudioPresetAssetRef[];
  }) =>
    request<{ preset: StudioPreset; presets: StudioPreset[] }>('/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),

  updatePreset: (
    id: string,
    patch: Partial<{
      name: string;
      description: string;
      isDefault: boolean;
      thumbnailStyle: StudioPreset['thumbnailStyle'];
      payload: Record<string, unknown>;
      assetRefs: StudioPresetAssetRef[];
    }>
  ) =>
    request<{ preset: StudioPreset; presets: StudioPreset[] }>(`/api/presets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  deletePreset: (id: string) =>
    request<{ deleted: boolean; presets: StudioPreset[] }>(`/api/presets/${id}`, {
      method: 'DELETE',
    }),

  importPresets: (bundle: unknown) =>
    request<{ importedCount: number; imported: StudioPreset[]; presets: StudioPreset[] }>(
      '/api/presets/import',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bundle),
      }
    ),

  exportPresetsUrl: '/api/presets/export',

  listStyles: () =>
    request<{ styles: StudioPreset[]; defaultStyleId: string | null }>('/api/styles'),

  createStyle: (params: {
    name: string;
    description?: string;
    isDefault?: boolean;
    projectId?: string;
    thumbnailDataUrl?: string;
    thumbnailImageUrl?: string;
    thumbnailStyle?: StudioPreset['thumbnailStyle'];
    payload?: Record<string, unknown>;
    assetRefs?: StudioPresetAssetRef[];
  }) =>
    request<{ style: StudioPreset; styles: StudioPreset[] }>('/api/styles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),

  updateStyle: (
    id: string,
    patch: Partial<{
      name: string;
      description: string;
      isDefault: boolean;
      fromProjectId: string;
      thumbnailDataUrl: string;
      thumbnailImageUrl: string;
      thumbnailStyle: StudioPreset['thumbnailStyle'];
      payload: Record<string, unknown>;
      assetRefs: StudioPresetAssetRef[];
    }>
  ) =>
    request<{ style: StudioPreset; styles: StudioPreset[] }>(`/api/styles/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  duplicateStyle: (id: string) =>
    request<{ style: StudioPreset; styles: StudioPreset[] }>(`/api/styles/${id}/duplicate`, {
      method: 'POST',
    }),

  deleteStyle: (id: string) =>
    request<{ deleted: boolean; styles: StudioPreset[] }>(`/api/styles/${id}`, {
      method: 'DELETE',
    }),

  applyStyleToProject: (projectId: string, styleId: string, scope: StyleApplyScope = 'all') =>
    request<{
      project: Project;
      warnings: PresetWarning[];
      voiceMissingWarning: StyleMissingVoiceWarning | null;
    }>(`/api/projects/${projectId}/apply-style`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ styleId, scope }),
    }),

  listProjects: async () => {
    const projects = await localProjectService.getAllProjects();
    return { projects };
  },

  createProject: async (name: string, presetOpts?: PresetApplyOptions) => {
    const project = await localProjectService.createProject(name, presetOpts);
    return {
      project,
      presetWarnings: [] as PresetWarning[],
      voiceMissingWarning: null as StyleMissingVoiceWarning | null,
    };
  },

  applyPresetsToProject: (projectId: string, presetOpts: PresetApplyOptions) =>
    request<{ project: Project; presetWarnings?: PresetWarning[] }>(
      `/api/projects/${projectId}/apply-presets`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(presetOpts),
      }
    ),

  getProject: async (id: string) => {
    if (!isValidProjectId(id)) {
      throw new ApiHttpError('Invalid or missing project ID.', 400, 'INVALID_PROJECT_ID');
    }
    const project = await localProjectService.getProject(id);
    if (!project) {
      throw new ApiHttpError('Project not found in local storage.', 404, 'PROJECT_NOT_FOUND');
    }
    return { project };
  },

  updateProject: async (id: string, patch: Partial<Project>) => {
    if (!isValidProjectId(id)) {
      throw new ApiHttpError('Invalid or missing project ID.', 400, 'INVALID_PROJECT_ID');
    }
    const project = await localProjectService.updateProject(id.trim(), patch);
    return { project };
  },

  deleteProject: async (id: string) => {
    const deleted = await localProjectService.deleteProject(id);
    return { deleted };
  },

  createSampleVideo: (projectId: string) =>
    request<{ project: Project }>(`/api/projects/${projectId}/sample-video`, {
      method: 'POST',
    }),

  uploadLogo: async (projectId: string, file: File) => {
    const key = buildAssetBlobKey('logos', projectId, file.name);
    const durableUrl = await localProjectService.saveProjectMedia(projectId, key, file, file.type);
    const project = await localProjectService.getProject(projectId);
    if (!project) throw new Error('Project not found in local storage.');
    const duration = Math.max(1, project.metadata?.duration || 30);
    const logoEntry: LogoOverlay = {
      id: crypto.randomUUID(),
      filename: file.name,
      url: durableUrl,
      enabled: true,
      x: 0.8,
      y: 0.08,
      widthPct: 16,
      opacity: 1,
      permanent: true,
      startTime: 0,
      endTime: duration,
      presetPosition: 'top-right',
    };
    const updated = await localProjectService.updateProject(projectId, {
      logos: [...(project.logos || []), logoEntry],
    });
    return { project: updated };
  },

  uploadCanvasBackground: async (projectId: string, file: File) => {
    const key = buildAssetBlobKey('backgrounds', projectId, file.name);
    const durableUrl = await localProjectService.saveProjectMedia(projectId, key, file, file.type);
    const project = await localProjectService.getProject(projectId);
    if (!project) throw new Error('Project not found in local storage.');
    const updated = await localProjectService.updateProject(projectId, {
      canvas: {
        ...DEFAULT_VIDEO_CANVAS,
        ...(project.canvas || {}),
        backgroundType: 'image',
        bgImageUrl: durableUrl,
      },
    });
    return { project: updated, url: durableUrl, filename: file.name };
  },

  uploadMusic: async (projectId: string, file: File) => {
    const key = buildAssetBlobKey('music', projectId, file.name);
    const durableUrl = await localProjectService.saveProjectMedia(projectId, key, file, file.type);
    const project = await localProjectService.getProject(projectId);
    if (!project) throw new Error('Project not found in local storage.');
    const updated = await localProjectService.updateProject(projectId, {
      voice: {
        ...(project.voice || {}),
        bgMusicUrl: durableUrl,
        bgMusicFilename: file.name,
      },
    });
    return { project: updated };
  },

  uploadSfx: async (projectId: string, file: File) => {
    const key = buildAssetBlobKey('sfx', projectId, file.name);
    const durableUrl = await localProjectService.saveProjectMedia(projectId, key, file, file.type);
    const project = await localProjectService.getProject(projectId);
    if (!project) throw new Error('Project not found in local storage.');
    const updated = await localProjectService.updateProject(projectId, {
      voice: {
        ...(project.voice || {}),
        sfxUrl: durableUrl,
        sfxFilename: file.name,
      },
    });
    return { project: updated };
  },

  uploadMask: (projectId: string, blurId: string, maskBase64: string) =>
    request<{ maskUrl: string; assetId: string }>(`/api/projects/${projectId}/mask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blurId, maskBase64 }),
    }),

  extractAudio: (projectId: string) =>
    request<{ audioUrl: string; downloadUrl: string; filename: string }>(
      `/api/projects/${projectId}/audio/extract`,
      { method: 'POST' }
    ),

  transcribe: (projectId: string, params?: { provider?: 'fish' | 'gemini'; sourceLanguage?: string }) =>
    request<{ project: Project; detectedLanguage: string; segmentCount: number }>(
      `/api/projects/${projectId}/transcribe`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params || {}),
      }
    ),

  transcribeWithFish: async (projectId: string, sourceLanguage?: string) => {
    const localKey = await getStoredFishApiKey();
    if (localKey) {
      return transcribeWithFishViaProxy(localKey, projectId, sourceLanguage);
    }
    return request<{ project: Project; detectedLanguage: string; segmentCount: number }>(
      `/api/projects/${projectId}/dubbing/transcribe`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceLanguage }),
      }
    );
  },

  importCaptions: (projectId: string, content: string) =>
    request<{ project: Project; count: number }>(`/api/projects/${projectId}/captions/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }),

  translate: (
    projectId: string,
    targetLanguage: SupportedLanguage,
    preserveProperNouns: boolean
  ) =>
    request<{ project: Project }>(`/api/projects/${projectId}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetLanguage, preserveProperNouns }),
    }),

  previewFishDub: async (
    projectId: string,
    params: { text: string; referenceId?: string; speakingSpeed: number }
  ) => {
    const localKey = await getStoredFishApiKey();
    if (localKey) {
      return previewFishTtsViaProxy(localKey, {
        text: params.text,
        referenceId: params.referenceId,
      });
    }
    return request<{ audioUrl: string }>(`/api/projects/${projectId}/dubbing/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  },

  generateFishDub: async (
    projectId: string,
    params: { voice: Project['voice']; captions?: CaptionSegment[]; useTranslated?: boolean }
  ) => {
    const localKey = await getStoredFishApiKey();
    if (localKey) {
      return startBrowserFishDubJob(localKey, projectId, params);
    }
    return request<{ job: RenderJob }>(
      `/api/projects/${projectId}/dubbing/generate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      }
    );
  },

  resyncFishDub: (projectId: string, syncMode: SyncMode, continuousPauseMs?: number) =>
    request<{ project: Project }>(`/api/projects/${projectId}/dubbing/resync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ syncMode, continuousPauseMs }),
    }),

  regenerateFishSegments: async (
    projectId: string,
    params: {
      segmentIds: string[];
      captions?: CaptionSegment[];
      voice?: Partial<Project['voice']>;
      useTranslated?: boolean;
    }
  ) => {
    const localKey = await getStoredFishApiKey();
    if (localKey) {
      return regenerateFishSegmentsInBrowser(localKey, projectId, params);
    }
    return request<{
      project: Project;
      regeneratedIds: string[];
      fullDubUrl: string;
    }>(`/api/projects/${projectId}/dubbing/regenerate-segments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  },

  previewVoice: (
    projectId: string,
    params: {
      text: string;
      voiceName: GeminiVoiceName;
      style: string;
      targetLanguage: SupportedLanguage;
      speakingSpeed: number;
    }
  ) =>
    request<{ audioUrl: string }>(`/api/projects/${projectId}/voice/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),

  generateVoiceover: (
    projectId: string,
    params: { voice: Project['voice']; useTranslated: boolean }
  ) =>
    request<{ project: Project; fullDubUrl: string }>(
      `/api/projects/${projectId}/voice/generate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      }
    ),

  autoDubVideo: (
    projectId: string,
    params: { voice: Project['voice']; preserveProperNouns?: boolean }
  ) =>
    request<{
      project: Project;
      sourceLanguage: string;
      targetLanguage: SupportedLanguage;
      fullDubUrl: string;
    }>(`/api/projects/${projectId}/voice/auto-dub`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),

  generateThumbnails: async (projectId: string) => {
    const project = await localProjectService.getProject(projectId);
    const filmstrip = await idbGet<{ frames: FilmstripFrame[] }>('filmstrips', projectId);
    const existingFrames = (filmstrip?.frames || []).map((f) => f.url).filter(Boolean);
    const thumbs =
      existingFrames.length >= 5
        ? existingFrames.slice(0, 5)
        : existingFrames.length > 0
        ? Array.from({ length: 5 }, (_, i) => existingFrames[i % existingFrames.length])
        : [project?.thumbnailUrl || ''];
    const sourceMode: 'edited-source' | 'final-export' = project?.lastExportUrl
      ? 'final-export'
      : 'edited-source';
    return {
      thumbnails: thumbs.filter(Boolean),
      sourceMode,
      suggestedTitle: project?.name || 'Epic Movie Recap',
      suggestedSubtitle: 'Watch until the shocking end!',
      suggestedTitles: [
        project?.name || 'Epic Movie Recap',
        'Top 10 Moments You Missed',
        'The Truth Behind The Ending',
        'Full Story Explained',
        'Ending Explained in 5 Minutes',
      ],
      translationMissingWarning: false,
    };
  },

  startExport: async (projectId: string, exportSettings: Project['exportSettings']) => {
    const res = await localProjectService.startLocalExport(projectId, exportSettings);
    return { job: res.job };
  },

  listProjectJobs: async (projectId: string) => {
    const all = await idbList<RenderJob>('jobs');
    const jobs = (all || []).filter((j) => j && j.projectId === projectId);
    return { jobs };
  },

  getJob: async (jobId: string): Promise<{ job: RenderJob }> => {
    const localJob = await idbGet<RenderJob>('jobs', jobId).catch(() => undefined);
    if (localJob) return { job: localJob };
    const fallbackJob: RenderJob = {
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
    };
    return { job: fallbackJob };
  },

  listAllJobs: async () => {
    const jobs = await idbList<RenderJob>('jobs');
    return { jobs: jobs || [] };
  },

  uploadVideoDirect: async (projectId: string, file: File) => {
    const updated = await uploadVideoChunked({
      projectId,
      file,
      onProgress: () => {},
    });
    return { project: updated, metadata: updated.metadata! };
  },

  getTimelineFilmstrip: async (projectId: string, _frames?: number) => {
    const cached = await idbGet<{ id: string; frames: FilmstripFrame[]; duration: number }>('filmstrips', projectId);
    if (cached && cached.frames) {
      return { frames: cached.frames, duration: cached.duration || 10 };
    }
    const project = await localProjectService.getProject(projectId);
    return { frames: [], duration: project?.metadata?.duration || 10 };
  },

  getAudioWaveforms: async (projectId: string) => {
    const cached = await idbGet<{ id: string; waveforms: ProjectAudioWaveforms }>('waveforms', projectId);
    if (cached && cached.waveforms) {
      return cached.waveforms;
    }
    const project = await localProjectService.getProject(projectId);
    const peaks = project?.waveformPeaks || [];
    return {
      orig: peaks,
      dub: [],
      dubClips: {},
      bgm: [],
      sfx: [],
    };
  },
};

export async function uploadVideoChunked(params: {
  projectId: string;
  file: File;
  onProgress: (pct: number, stage: string) => void;
}): Promise<Project> {
  const { file, onProgress } = params;
  if (!isValidProjectId(params.projectId)) {
    throw new ApiHttpError(
      'Invalid or missing project ID. Please select or create a project first.',
      400,
      'INVALID_PROJECT_ID'
    );
  }
  const projectId = params.projectId.trim();

  const dotIdx = file.name.lastIndexOf('.');
  const ext = dotIdx >= 0 ? file.name.slice(dotIdx).toLowerCase() : '';
  if (!['.mp4', '.mov', '.mkv', '.webm', '.m4v'].includes(ext)) {
    throw new ApiHttpError(
      `Unsupported video format "${ext || 'unknown'}". Allowed formats: MP4, MOV, MKV, WEBM.`,
      400,
      'UNSUPPORTED_VIDEO_FORMAT'
    );
  }
  if (file.size <= 0) {
    throw new ApiHttpError('Selected video file is empty.', 400, 'EMPTY_FILE');
  }

  onProgress(2, 'Verifying local project storage...');
  let project = await localProjectService.getProject(projectId);
  if (!project) {
    project = await localProjectService.createProject({
      id: projectId,
      name: file.name.replace(/\.[^.]+$/, ''),
    });
  }

  const result = await processVideoUploadInBrowser(file, onProgress, projectId);
  const firstThumbUrl = result.filmstrip.find((f) => Boolean(f.url))?.url || null;
  const durableIdbUrl = `idb://blobs/${result.sourceVideoBlobKey}`;

  await idbSet('filmstrips', projectId, {
    id: projectId,
    frames: result.filmstrip,
    duration: result.duration,
  });
  await idbSet('waveforms', projectId, {
    id: projectId,
    waveforms: result.waveforms,
  });

  onProgress(95, 'Saving video association to local project...');
  const updated = await localProjectService.updateProject(projectId, {
    sourceVideoUrl: durableIdbUrl,
    sourceVideoBlobKey: result.sourceVideoBlobKey,
    sourceFilename: file.name,
    thumbnailUrl: firstThumbUrl || project.thumbnailUrl,
    metadata: result.metadata,
    waveformPeaks: result.waveforms.orig,
  });

  onProgress(100, 'Upload complete');
  return updated;
}
