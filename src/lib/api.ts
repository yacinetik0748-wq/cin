import {
  CaptionSegment,
  CloudAssetKind,
  DefaultStudioPreferences,
  FilmstripFrame,
  FishAudioSettingsSummary,
  FishConnectionStatus,
  FishVoiceModel,
  GeminiVoiceName,
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
  VideoMetadata,
} from '../types/studio';
import type { FontCatalogItem } from './fontCatalog';
import { handleLocalApiFallback } from './localApiFallback';
import { processVideoUploadInBrowser } from './browserVideoProcessor';
import { idbGet, idbSet } from './browserStorage';
import { indexedDbStore } from './indexedDbStore';
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

async function request<T>(url: string, init?: RequestInit): Promise<T> {
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
    const [res, localKey] = await Promise.all([
      request<SystemStatus>('/api/system/status'),
      getStoredFishApiKey(),
    ]);
    return {
      ...res,
      fishConfigured: Boolean(res.fishConfigured || localKey),
    };
  },

  getFishAudioSettings: () => getFishAudioSettingsSummary(),

  saveFishApiKey: (apiKey: string) => saveStoredFishApiKey(apiKey),

  testFishAudioConnection: (apiKey?: string) => testFishAudioConnection(apiKey),

  deleteFishApiKey: () => deleteStoredFishApiKey(),

  getDefaultPreferences: () =>
    request<{ preferences: DefaultStudioPreferences; defaultStyle: StudioPreset | null }>(
      '/api/settings/preferences'
    ),

  updateDefaultPreferences: (patch: Partial<DefaultStudioPreferences>) =>
    request<{ preferences: DefaultStudioPreferences; defaultStyle: StudioPreset | null }>(
      '/api/settings/preferences',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }
    ),

  getSupabaseSchema: () => request<{ sql: string }>('/api/system/supabase-schema'),

  getLocalStorageUsage: () =>
    request<{
      totalBytes: number;
      buckets: Record<string, { bytes: number; files: number }>;
    }>('/api/system/storage-usage'),

  runCleanup: () => request<{ removedFiles: number }>('/api/system/cleanup', { method: 'POST' }),

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

  listProjects: () => request<{ projects: Project[] }>('/api/projects'),

  createProject: async (name: string, presetOpts?: PresetApplyOptions) => {
    const res = await request<{
      project: Project;
      presetWarnings?: PresetWarning[];
      voiceMissingWarning?: StyleMissingVoiceWarning | null;
    }>('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ...(presetOpts || {}) }),
    });
    if (res.project?.id) {
      void indexedDbStore.saveProjectSnapshot(res.project);
      void idbSet('projects', res.project.id, res.project).catch(() => undefined);
    }
    return res;
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

  getProject: (id: string) => {
    if (!isValidProjectId(id)) {
      return Promise.reject(
        new ApiHttpError('Invalid or missing project ID.', 400, 'INVALID_PROJECT_ID')
      );
    }
    return request<{ project: Project }>(`/api/projects/${encodeURIComponent(id.trim())}`);
  },

  updateProject: async (id: string, patch: Partial<Project>) => {
    if (!isValidProjectId(id)) {
      throw new ApiHttpError('Invalid or missing project ID.', 400, 'INVALID_PROJECT_ID');
    }
    const res = await request<{ project: Project }>(
      `/api/projects/${encodeURIComponent(id.trim())}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }
    );
    if (res.project?.id) {
      void indexedDbStore.saveProjectSnapshot(res.project);
      void idbSet('projects', res.project.id, res.project).catch(() => undefined);
    }
    return res;
  },

  deleteProject: (id: string) =>
    request<{ deleted: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),

  createSampleVideo: (projectId: string) =>
    request<{ project: Project }>(`/api/projects/${projectId}/sample-video`, {
      method: 'POST',
    }),

  uploadLogo: async (projectId: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<{ project: Project }>(`/api/projects/${projectId}/logo`, {
      method: 'POST',
      body: fd,
    });
  },

  uploadCanvasBackground: async (projectId: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<{ project: Project; url: string; filename: string }>(
      `/api/projects/${projectId}/canvas-bg`,
      {
        method: 'POST',
        body: fd,
      }
    );
  },

  uploadMusic: async (projectId: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<{ project: Project }>(`/api/projects/${projectId}/music`, {
      method: 'POST',
      body: fd,
    });
  },

  uploadSfx: async (projectId: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<{ project: Project }>(`/api/projects/${projectId}/sfx`, {
      method: 'POST',
      body: fd,
    });
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

  generateThumbnails: (projectId: string) =>
    request<{
      thumbnails: string[];
      sourceMode?: 'final-export' | 'edited-source';
      suggestedTitle: string;
      suggestedSubtitle: string;
      suggestedTitles?: string[];
      translationMissingWarning?: boolean;
    }>(`/api/projects/${projectId}/thumbnails/generate`, { method: 'POST' }),

  startExport: (projectId: string, exportSettings: Project['exportSettings']) =>
    request<{ job: RenderJob }>(`/api/projects/${projectId}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exportSettings }),
    }),

  listProjectJobs: (projectId: string) =>
    request<{ jobs: RenderJob[] }>(`/api/projects/${projectId}/jobs`),

  getJob: async (jobId: string) => {
    const localJob = await idbGet<RenderJob>('jobs', jobId).catch(() => undefined);
    if (localJob) return { job: localJob };
    return request<{ job: RenderJob }>(`/api/jobs/${jobId}`);
  },

  listAllJobs: () => request<{ jobs: RenderJob[] }>('/api/jobs'),

  uploadVideoDirect: async (projectId: string, file: File) => {
    if (!isValidProjectId(projectId)) {
      throw new ApiHttpError(
        'Invalid or missing project ID. Please select or create a project before uploading.',
        400,
        'INVALID_PROJECT_ID'
      );
    }
    const cleanId = projectId.trim();
    // Verify project exists on backend before transmitting binary video payload
    await api.getProject(cleanId);
    const fd = new FormData();
    fd.append('file', file);
    const res = await request<{ project: Project; metadata: VideoMetadata }>(
      `/api/projects/${encodeURIComponent(cleanId)}/video`,
      {
        method: 'POST',
        body: fd,
      }
    );
    if (res.project?.id) {
      void indexedDbStore.saveProjectSnapshot(res.project);
      void idbSet('projects', res.project.id, res.project).catch(() => undefined);
    }
    return res;
  },

  getTimelineFilmstrip: (projectId: string, frames?: number) =>
    request<{ frames: FilmstripFrame[]; duration: number }>(
      frames
        ? `/api/projects/${projectId}/timeline-filmstrip?frames=${frames}`
        : `/api/projects/${projectId}/timeline-filmstrip`
    ),

  getAudioWaveforms: (projectId: string) =>
    request<ProjectAudioWaveforms>(`/api/projects/${projectId}/audio-waveforms`),
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
  if (!['.mp4', '.mov', '.mkv'].includes(ext)) {
    throw new ApiHttpError(
      `Unsupported video format "${ext || 'unknown'}". Allowed formats: MP4, MOV, MKV.`,
      400,
      'UNSUPPORTED_VIDEO_FORMAT'
    );
  }
  if (file.size <= 0) {
    throw new ApiHttpError('Selected video file is empty.', 400, 'EMPTY_FILE');
  }

  // Confirm project exists in persistent storage before uploading chunks
  onProgress(1, 'Verifying project...');
  await api.getProject(projectId);

  const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB chunks
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));

  onProgress(2, 'Initializing upload...');
  const initRes = await request<{
    uploadId: string;
    totalChunks: number;
    projectId?: string;
    storageMode?: 'r2' | 'indexeddb-local';
    suggestedUrl?: string;
    offlineLocal?: boolean;
  }>('/api/uploads/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId,
      filename: file.name,
      totalSize: file.size,
      totalChunks,
    }),
  });

  // When running on Cloudflare Pages without R2 bucket (or offline static mode),
  // store the large video binary in browser IndexedDB and persist metadata/blob key on the D1 project.
  if (initRes.storageMode === 'indexeddb-local') {
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

    onProgress(95, 'Saving video association to project...');
    const completeRes = await request<{ project: Project }>(
      `/api/uploads/${encodeURIComponent(initRes.uploadId)}/complete`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          storageMode: 'indexeddb-local',
          sourceVideoUrl: durableIdbUrl,
          sourceVideoBlobKey: result.sourceVideoBlobKey,
          sourceFilename: file.name,
          thumbnailDataUrl: firstThumbUrl || undefined,
          metadata: result.metadata,
          waveformPeaks: result.waveforms.orig,
        }),
      }
    );

    const savedProject: Project = {
      ...completeRes.project,
      sourceVideoUrl: result.sourceVideoUrl || completeRes.project.sourceVideoUrl,
      sourceVideoBlobKey: result.sourceVideoBlobKey,
    };
    await idbSet('projects', savedProject.id, savedProject).catch(() => undefined);
    await indexedDbStore.saveProjectSnapshot(savedProject).catch(() => undefined);
    onProgress(100, 'Upload complete');
    return savedProject;
  }

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(file.size, start + CHUNK_SIZE);
    const slice = file.slice(start, end);
    const buffer = await slice.arrayBuffer();

    const chunkUrl = resolveApiUrl(
      `/api/uploads/${encodeURIComponent(initRes.uploadId)}/chunk?index=${i}`
    );
    const chunkRes = await fetch(chunkUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buffer,
    });
    if (!chunkRes.ok) {
      let chunkErrMsg = `Chunk ${i + 1} of ${totalChunks} upload failed (${chunkRes.status})`;
      let chunkErrCode: string | undefined;
      try {
        const errJson = (await chunkRes.json()) as { error?: string; code?: string };
        if (typeof errJson?.error === 'string' && errJson.error.trim()) {
          chunkErrMsg = errJson.error;
        }
        if (typeof errJson?.code === 'string') {
          chunkErrCode = errJson.code;
        }
      } catch {
        // ignore non-JSON chunk response body
      }
      throw new ApiHttpError(chunkErrMsg, chunkRes.status, chunkErrCode);
    }

    const pct = Math.round(5 + ((i + 1) / totalChunks) * 80);
    onProgress(pct, `Uploading chunk ${i + 1} of ${totalChunks}...`);
  }

  onProgress(90, 'Analyzing video streams & extracting audio waveform...');
  const completeRes = await request<{ project: Project }>(
    `/api/uploads/${encodeURIComponent(initRes.uploadId)}/complete`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    }
  );

  await idbSet('projects', completeRes.project.id, completeRes.project).catch(() => undefined);
  await indexedDbStore.saveProjectSnapshot(completeRes.project).catch(() => undefined);
  onProgress(100, 'Upload complete');
  return completeRes.project;
}
