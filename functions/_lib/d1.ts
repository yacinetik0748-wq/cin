import {
  DEFAULT_EXPORT_SETTINGS,
  DEFAULT_SUBTITLE_STYLE,
  DEFAULT_VIDEO_CANVAS,
  DEFAULT_VIDEO_EFFECTS,
  DEFAULT_VOICE_CONFIG,
  DefaultStudioPreferences,
  PresetCategory,
  Project,
  RenderJob,
  SavedFishVoice,
  SavedFontAsset,
  StudioPreset,
  StudioPresetAssetRef,
} from '../../src/types/studio.ts';
import { sanitizeSavedStylePayload } from '../../src/lib/savedStyles.ts';
import { checkBinaryAssetExists, saveBinaryAsset } from './storage.ts';
import { Env, HttpError } from './types.ts';

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_video_url TEXT,
    source_filename TEXT,
    thumbnail_url TEXT,
    metadata_json TEXT,
    waveform_json TEXT NOT NULL DEFAULT '[]',
    captions_json TEXT NOT NULL DEFAULT '[]',
    subtitle_style_json TEXT NOT NULL,
    translation_json TEXT NOT NULL,
    voice_json TEXT NOT NULL,
    blurs_json TEXT NOT NULL DEFAULT '[]',
    logos_json TEXT NOT NULL DEFAULT '[]',
    video_effects_json TEXT NOT NULL DEFAULT '{}',
    canvas_json TEXT NOT NULL DEFAULT '{}',
    workflow_json TEXT NOT NULL DEFAULT '{}',
    export_settings_json TEXT NOT NULL,
    cloud_meta_json TEXT NOT NULL DEFAULT '{}',
    video_clips_json TEXT NOT NULL DEFAULT '[]',
    original_audio_clips_json TEXT NOT NULL DEFAULT '[]',
    subtitle_removal_json TEXT,
    last_export_url TEXT,
    last_export_size INTEGER,
    last_exported_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0,
    stage TEXT NOT NULL DEFAULT 'Queued',
    eta_seconds INTEGER,
    output_url TEXT,
    output_size INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    kind TEXT NOT NULL,
    filename TEXT NOT NULL,
    file_path TEXT NOT NULL,
    url TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS presets (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_default INTEGER NOT NULL DEFAULT 0,
    thumbnail_json TEXT NOT NULL DEFAULT '{}',
    payload_json TEXT NOT NULL DEFAULT '{}',
    asset_refs_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS custom_fonts (
    id TEXT PRIMARY KEY,
    family TEXT NOT NULL,
    filename TEXT NOT NULL,
    file_path TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS upload_sessions (
    upload_id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    total_size INTEGER NOT NULL,
    total_chunks INTEGER NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'video/mp4',
    r2_upload_id TEXT,
    r2_key TEXT,
    parts_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS media_blobs (
    key TEXT PRIMARY KEY,
    mime_type TEXT NOT NULL,
    data BLOB NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_project_id ON jobs(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_assets_project_id ON assets(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_assets_url ON assets(url)`,
  `CREATE INDEX IF NOT EXISTS idx_presets_category ON presets(category)`,
];

const initializedDbs = new WeakSet<D1Database>();

export function hasDb(env: Env): env is Env & { DB: D1Database } {
  return Boolean(env.DB);
}

export function requireDb(env: Env): D1Database {
  if (env.DB) return env.DB;
  throw new HttpError(
    'D1 database binding is optional; local IndexedDB storage mode is active.',
    503,
    'DATABASE_NOT_CONFIGURED'
  );
}

export async function ensureSchema(db: D1Database): Promise<void> {
  if (!db) return;
  if (initializedDbs.has(db)) return;
  for (const sql of SCHEMA_STATEMENTS) {
    await db.prepare(sql).run();
  }
  // Safe additive column checks for pre-existing D1 databases
  const addCols = [
    "ALTER TABLE projects ADD COLUMN video_effects_json TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE projects ADD COLUMN canvas_json TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE projects ADD COLUMN workflow_json TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE projects ADD COLUMN cloud_meta_json TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE projects ADD COLUMN video_clips_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE projects ADD COLUMN original_audio_clips_json TEXT NOT NULL DEFAULT '[]'",
    'ALTER TABLE projects ADD COLUMN subtitle_removal_json TEXT',
    'ALTER TABLE upload_sessions ADD COLUMN project_id TEXT',
  ];
  for (const stmt of addCols) {
    try {
      await db.prepare(stmt).run();
    } catch {
      // column already exists
    }
  }
  initializedDbs.add(db);
}

interface ProjectRow {
  id: string;
  name: string;
  source_video_url: string | null;
  source_filename: string | null;
  thumbnail_url: string | null;
  metadata_json: string | null;
  waveform_json: string;
  captions_json: string;
  subtitle_style_json: string;
  translation_json: string;
  voice_json: string;
  blurs_json: string;
  subtitle_removal_json?: string | null;
  logos_json: string;
  video_clips_json?: string;
  original_audio_clips_json?: string;
  video_effects_json?: string;
  canvas_json?: string;
  workflow_json?: string;
  cloud_meta_json?: string;
  export_settings_json: string;
  last_export_url: string | null;
  last_export_size: number | null;
  last_exported_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToProject(row: ProjectRow): Project {
  const parsedWorkflow = row.workflow_json ? JSON.parse(row.workflow_json) : undefined;
  const rawVoice = JSON.parse(row.voice_json || '{}') as Partial<Project['voice']>;
  const originalAudioMuted =
    rawVoice.originalAudioMuted !== undefined
      ? Boolean(rawVoice.originalAudioMuted)
      : rawVoice.preserveOriginalAudio !== undefined
      ? !Boolean(rawVoice.preserveOriginalAudio)
      : true;
  const originalAudioEnabled =
    rawVoice.originalAudioEnabled !== undefined
      ? Boolean(rawVoice.originalAudioEnabled)
      : Boolean(rawVoice.preserveOriginalAudio);
  const bgMusicEnabled =
    rawVoice.bgMusicEnabled !== undefined
      ? Boolean(rawVoice.bgMusicEnabled)
      : Boolean(rawVoice.bgMusicUrl && (rawVoice.bgMusicVolume ?? 0) > 0.005);

  const normalizedVoice: Project['voice'] = {
    ...DEFAULT_VOICE_CONFIG,
    ...rawVoice,
    voiceMuted: Boolean(rawVoice.voiceMuted),
    originalAudioMuted,
    originalAudioEnabled,
    preserveOriginalAudio: !originalAudioMuted && originalAudioEnabled,
    bgMusicEnabled,
    bgMusicMuted: Boolean(rawVoice.bgMusicMuted),
    sfxEnabled: Boolean(rawVoice.sfxEnabled),
    sfxMuted: Boolean(rawVoice.sfxMuted),
  };

  const parsedSubStyle = {
    ...DEFAULT_SUBTITLE_STYLE,
    ...JSON.parse(row.subtitle_style_json || '{}'),
    useTranslated: true,
  };

  const parsedCloudMeta = row.cloud_meta_json
    ? (JSON.parse(row.cloud_meta_json) as {
        cloudSync?: Project['cloudSync'];
        cloudAssets?: Project['cloudAssets'];
        savedThumbnails?: Project['savedThumbnails'];
        sourceVideoBlobKey?: string | null;
      })
    : {};

  return {
    id: row.id,
    name: row.name,
    sourceVideoUrl: row.source_video_url,
    sourceVideoBlobKey: parsedCloudMeta.sourceVideoBlobKey ?? null,
    sourceFilename: row.source_filename,
    thumbnailUrl: row.thumbnail_url,
    savedThumbnails: parsedCloudMeta.savedThumbnails || [],
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
    waveformPeaks: JSON.parse(row.waveform_json || '[]'),
    captions: JSON.parse(row.captions_json || '[]'),
    subtitleStyle: parsedSubStyle,
    translation: JSON.parse(
      row.translation_json || '{"sourceLanguage":"Auto","targetLanguage":"Spanish","preserveProperNouns":true}'
    ),
    voice: normalizedVoice,
    blurs: JSON.parse(row.blurs_json || '[]'),
    subtitleRemoval: row.subtitle_removal_json ? JSON.parse(row.subtitle_removal_json) : undefined,
    logos: JSON.parse(row.logos_json || '[]'),
    videoClips: JSON.parse(row.video_clips_json || '[]'),
    originalAudioClips: JSON.parse(row.original_audio_clips_json || '[]'),
    videoEffects: { ...DEFAULT_VIDEO_EFFECTS, ...JSON.parse(row.video_effects_json || '{}') },
    canvas: { ...DEFAULT_VIDEO_CANVAS, ...JSON.parse(row.canvas_json || '{}') },
    workflow:
      parsedWorkflow && Array.isArray(parsedWorkflow.visitedStages)
        ? parsedWorkflow
        : {
            visitedStages: ['dashboard'],
            completedStages: [],
            needsAttentionStages: [],
          },
    exportSettings: { ...DEFAULT_EXPORT_SETTINGS, ...JSON.parse(row.export_settings_json || '{}') },
    lastExportUrl: row.last_export_url,
    lastExportSize: row.last_export_size,
    lastExportedAt: row.last_exported_at,
    cloudSync: parsedCloudMeta.cloudSync,
    cloudAssets: parsedCloudMeta.cloudAssets,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getAppSetting(db: D1Database, key: string, fallback: string): Promise<string> {
  await ensureSchema(db);
  const row = await db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row ? row.value : fallback;
}

export async function setAppSetting(db: D1Database, key: string, value: string): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(key, value, new Date().toISOString())
    .run();
}

const SAVED_VOICES_KEY = 'saved_fish_voices';
const DEFAULT_PREFERENCES_KEY = 'default_studio_preferences';

export const DEFAULT_STUDIO_PREFERENCES: DefaultStudioPreferences = {
  autoApplyDefaultStyleOnImport: false,
  defaultStyleId: null,
  defaultTargetLanguage: 'French',
  defaultSyncMode: 'flexible',
};

export async function getSavedFishVoices(db: D1Database): Promise<SavedFishVoice[]> {
  try {
    const raw = await getAppSetting(db, SAVED_VOICES_KEY, '[]');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedFishVoice[]) : [];
  } catch {
    return [];
  }
}

export async function saveSavedFishVoices(db: D1Database, voices: SavedFishVoice[]): Promise<void> {
  await setAppSetting(db, SAVED_VOICES_KEY, JSON.stringify(voices));
}

export async function getDefaultStudioPreferences(
  db: D1Database
): Promise<DefaultStudioPreferences> {
  try {
    const raw = await getAppSetting(db, DEFAULT_PREFERENCES_KEY, '{}');
    const parsed = JSON.parse(raw) as Partial<DefaultStudioPreferences>;
    return {
      ...DEFAULT_STUDIO_PREFERENCES,
      ...parsed,
      autoApplyDefaultStyleOnImport: Boolean(parsed.autoApplyDefaultStyleOnImport),
      defaultStyleId:
        typeof parsed.defaultStyleId === 'string' && parsed.defaultStyleId.trim()
          ? parsed.defaultStyleId.trim()
          : null,
    };
  } catch {
    return { ...DEFAULT_STUDIO_PREFERENCES };
  }
}

export async function saveDefaultStudioPreferences(
  db: D1Database,
  patch: Partial<DefaultStudioPreferences>
): Promise<DefaultStudioPreferences> {
  const current = await getDefaultStudioPreferences(db);
  const next: DefaultStudioPreferences = {
    ...current,
    ...patch,
    autoApplyDefaultStyleOnImport:
      patch.autoApplyDefaultStyleOnImport !== undefined
        ? Boolean(patch.autoApplyDefaultStyleOnImport)
        : current.autoApplyDefaultStyleOnImport,
    defaultStyleId:
      patch.defaultStyleId !== undefined
        ? patch.defaultStyleId && patch.defaultStyleId.trim()
          ? patch.defaultStyleId.trim()
          : null
        : current.defaultStyleId,
  };
  await setAppSetting(db, DEFAULT_PREFERENCES_KEY, JSON.stringify(next));
  return next;
}

export async function listProjects(db: D1Database): Promise<Project[]> {
  await ensureSchema(db);
  const rows = await db
    .prepare('SELECT * FROM projects ORDER BY updated_at DESC')
    .all<ProjectRow>();
  return (rows.results || []).map(rowToProject);
}

export async function getProject(db: D1Database, id: string): Promise<Project | null> {
  const cleanId = typeof id === 'string' ? id.trim() : '';
  if (!cleanId || cleanId === 'undefined' || cleanId === 'null') return null;
  await ensureSchema(db);
  const row = await db.prepare('SELECT * FROM projects WHERE id = ?').bind(cleanId).first<ProjectRow>();
  return row ? rowToProject(row) : null;
}

export async function createProject(db: D1Database, id: string, name: string): Promise<Project> {
  await ensureSchema(db);
  const now = new Date().toISOString();
  const prefs = await getDefaultStudioPreferences(db);
  const translation = {
    sourceLanguage: 'Auto',
    targetLanguage: prefs.defaultTargetLanguage || 'French',
    preserveProperNouns: true,
  };
  const savedVoices = await getSavedFishVoices(db);
  const defaultVoice = savedVoices.find((v) => v.isDefault);
  const initialVoice = defaultVoice
    ? {
        ...DEFAULT_VOICE_CONFIG,
        targetLanguage: prefs.defaultTargetLanguage || DEFAULT_VOICE_CONFIG.targetLanguage,
        syncMode: prefs.defaultSyncMode || DEFAULT_VOICE_CONFIG.syncMode,
        fishReferenceId: defaultVoice.voiceId,
        fishVoiceTitle: defaultVoice.name,
      }
    : {
        ...DEFAULT_VOICE_CONFIG,
        targetLanguage: prefs.defaultTargetLanguage || DEFAULT_VOICE_CONFIG.targetLanguage,
        syncMode: prefs.defaultSyncMode || DEFAULT_VOICE_CONFIG.syncMode,
      };
  const initialWorkflow = {
    visitedStages: ['dashboard'],
    completedStages: [],
    needsAttentionStages: [],
  };

  await db
    .prepare(
      `INSERT INTO projects (
        id, name, subtitle_style_json, translation_json, voice_json, video_effects_json, canvas_json, workflow_json, export_settings_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      name,
      JSON.stringify(DEFAULT_SUBTITLE_STYLE),
      JSON.stringify(translation),
      JSON.stringify(initialVoice),
      JSON.stringify(DEFAULT_VIDEO_EFFECTS),
      JSON.stringify(DEFAULT_VIDEO_CANVAS),
      JSON.stringify(initialWorkflow),
      JSON.stringify(DEFAULT_EXPORT_SETTINGS),
      now,
      now
    )
    .run();
  return (await getProject(db, id))!;
}

export async function updateProject(
  db: D1Database,
  id: string,
  patch: Partial<Project>
): Promise<Project | null> {
  const existing = await getProject(db, id);
  if (!existing) return null;
  const merged: Project = {
    ...existing,
    ...patch,
    id: existing.id,
    updatedAt: new Date().toISOString(),
  };

  await db
    .prepare(
      `UPDATE projects SET
        name = ?,
        source_video_url = ?,
        source_filename = ?,
        thumbnail_url = ?,
        metadata_json = ?,
        waveform_json = ?,
        captions_json = ?,
        subtitle_style_json = ?,
        translation_json = ?,
        voice_json = ?,
        blurs_json = ?,
        subtitle_removal_json = ?,
        logos_json = ?,
        video_clips_json = ?,
        original_audio_clips_json = ?,
        video_effects_json = ?,
        canvas_json = ?,
        workflow_json = ?,
        cloud_meta_json = ?,
        export_settings_json = ?,
        last_export_url = ?,
        last_export_size = ?,
        last_exported_at = ?,
        updated_at = ?
      WHERE id = ?`
    )
    .bind(
      merged.name,
      merged.sourceVideoUrl ?? null,
      merged.sourceFilename ?? null,
      merged.thumbnailUrl ?? null,
      merged.metadata ? JSON.stringify(merged.metadata) : null,
      JSON.stringify(merged.waveformPeaks || []),
      JSON.stringify(merged.captions || []),
      JSON.stringify(merged.subtitleStyle),
      JSON.stringify(merged.translation),
      JSON.stringify(merged.voice),
      JSON.stringify(merged.blurs || []),
      merged.subtitleRemoval ? JSON.stringify(merged.subtitleRemoval) : null,
      JSON.stringify(merged.logos || []),
      JSON.stringify(merged.videoClips || []),
      JSON.stringify(merged.originalAudioClips || []),
      JSON.stringify(merged.videoEffects || DEFAULT_VIDEO_EFFECTS),
      JSON.stringify(merged.canvas || DEFAULT_VIDEO_CANVAS),
      JSON.stringify(
        merged.workflow || {
          visitedStages: ['dashboard'],
          completedStages: [],
          needsAttentionStages: [],
        }
      ),
      JSON.stringify({
        cloudSync: merged.cloudSync,
        cloudAssets: merged.cloudAssets,
        savedThumbnails: merged.savedThumbnails || [],
        sourceVideoBlobKey: merged.sourceVideoBlobKey ?? null,
      }),
      JSON.stringify(merged.exportSettings),
      merged.lastExportUrl ?? null,
      merged.lastExportSize ?? null,
      merged.lastExportedAt ?? null,
      merged.updatedAt,
      id
    )
    .run();
  return getProject(db, id);
}

export async function upsertProjectFromCloud(
  db: D1Database,
  cloudProject: Project
): Promise<Project> {
  const existing = await getProject(db, cloudProject.id);
  const now = new Date().toISOString();
  const safeWorkflow =
    cloudProject.workflow && Array.isArray(cloudProject.workflow.visitedStages)
      ? cloudProject.workflow
      : {
          visitedStages: ['dashboard'],
          completedStages: [],
          needsAttentionStages: [],
        };

  if (!existing) {
    await db
      .prepare(
        `INSERT INTO projects (
          id, name, source_video_url, source_filename, thumbnail_url, metadata_json,
          waveform_json, captions_json, subtitle_style_json, translation_json, voice_json,
          blurs_json, subtitle_removal_json, logos_json, video_clips_json, original_audio_clips_json,
          video_effects_json, canvas_json, workflow_json, cloud_meta_json, export_settings_json,
          last_export_url, last_export_size, last_exported_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        cloudProject.id,
        cloudProject.name || 'Cloud Project',
        cloudProject.sourceVideoUrl ?? null,
        cloudProject.sourceFilename ?? null,
        cloudProject.thumbnailUrl ?? null,
        cloudProject.metadata ? JSON.stringify(cloudProject.metadata) : null,
        JSON.stringify(cloudProject.waveformPeaks || []),
        JSON.stringify(cloudProject.captions || []),
        JSON.stringify({
          ...DEFAULT_SUBTITLE_STYLE,
          ...(cloudProject.subtitleStyle || {}),
          useTranslated: true,
        }),
        JSON.stringify(
          cloudProject.translation || {
            sourceLanguage: 'Auto',
            targetLanguage: 'Spanish',
            preserveProperNouns: true,
          }
        ),
        JSON.stringify({ ...DEFAULT_VOICE_CONFIG, ...(cloudProject.voice || {}) }),
        JSON.stringify(cloudProject.blurs || []),
        cloudProject.subtitleRemoval ? JSON.stringify(cloudProject.subtitleRemoval) : null,
        JSON.stringify(cloudProject.logos || []),
        JSON.stringify(cloudProject.videoClips || []),
        JSON.stringify(cloudProject.originalAudioClips || []),
        JSON.stringify({ ...DEFAULT_VIDEO_EFFECTS, ...(cloudProject.videoEffects || {}) }),
        JSON.stringify({ ...DEFAULT_VIDEO_CANVAS, ...(cloudProject.canvas || {}) }),
        JSON.stringify(safeWorkflow),
        JSON.stringify({
          cloudSync: cloudProject.cloudSync || { syncStatus: 'cloud-synced' },
          cloudAssets: cloudProject.cloudAssets || {},
          savedThumbnails: cloudProject.savedThumbnails || [],
          sourceVideoBlobKey: cloudProject.sourceVideoBlobKey ?? null,
        }),
        JSON.stringify({ ...DEFAULT_EXPORT_SETTINGS, ...(cloudProject.exportSettings || {}) }),
        cloudProject.lastExportUrl ?? null,
        cloudProject.lastExportSize ?? null,
        cloudProject.lastExportedAt ?? null,
        cloudProject.createdAt || now,
        cloudProject.updatedAt || now
      )
      .run();
    return (await getProject(db, cloudProject.id))!;
  }

  return (await updateProject(db, cloudProject.id, {
    ...cloudProject,
    cloudSync: cloudProject.cloudSync || { syncStatus: 'cloud-synced' },
    cloudAssets: cloudProject.cloudAssets || existing.cloudAssets,
    savedThumbnails: cloudProject.savedThumbnails || existing.savedThumbnails,
  }))!;
}

export async function deleteProject(db: D1Database, id: string): Promise<boolean> {
  await ensureSchema(db);
  const res = await db.prepare('DELETE FROM projects WHERE id = ?').bind(id).run();
  return (res.meta?.changes || 0) > 0;
}

interface JobRow {
  id: string;
  project_id: string;
  type: RenderJob['type'];
  status: RenderJob['status'];
  progress: number;
  stage: string;
  eta_seconds: number | null;
  output_url: string | null;
  output_size: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToJob(row: JobRow): RenderJob {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    status: row.status,
    progress: row.progress,
    stage: row.stage,
    etaSeconds: row.eta_seconds,
    outputUrl: row.output_url,
    outputSize: row.output_size,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createJob(
  db: D1Database,
  job: Omit<RenderJob, 'createdAt' | 'updatedAt'>
): Promise<RenderJob> {
  await ensureSchema(db);
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO jobs (id, project_id, type, status, progress, stage, eta_seconds, output_url, output_size, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      job.id,
      job.projectId,
      job.type,
      job.status,
      job.progress,
      job.stage,
      job.etaSeconds ?? null,
      job.outputUrl ?? null,
      job.outputSize ?? null,
      job.error ?? null,
      now,
      now
    )
    .run();
  return (await getJob(db, job.id))!;
}

export async function getJob(db: D1Database, id: string): Promise<RenderJob | null> {
  await ensureSchema(db);
  const row = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRow>();
  return row ? rowToJob(row) : null;
}

export async function listProjectJobs(db: D1Database, projectId: string): Promise<RenderJob[]> {
  await ensureSchema(db);
  const rows = await db
    .prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 30')
    .bind(projectId)
    .all<JobRow>();
  return (rows.results || []).map(rowToJob);
}

export async function listAllJobs(db: D1Database): Promise<RenderJob[]> {
  await ensureSchema(db);
  const rows = await db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50').all<JobRow>();
  return (rows.results || []).map(rowToJob);
}

export async function updateJob(
  db: D1Database,
  id: string,
  patch: Partial<RenderJob>
): Promise<RenderJob | null> {
  const existing = await getJob(db, id);
  if (!existing) return null;
  const merged = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  await db
    .prepare(
      `UPDATE jobs SET status = ?, progress = ?, stage = ?, eta_seconds = ?, output_url = ?, output_size = ?, error = ?, updated_at = ?
       WHERE id = ?`
    )
    .bind(
      merged.status,
      merged.progress,
      merged.stage,
      merged.etaSeconds ?? null,
      merged.outputUrl ?? null,
      merged.outputSize ?? null,
      merged.error ?? null,
      merged.updatedAt,
      id
    )
    .run();
  return getJob(db, id);
}

export async function checkAssetAvailableByUrl(env: Env, url: string): Promise<boolean> {
  if (!url) return false;
  if (await checkBinaryAssetExists(env, url)) return true;
  if (env.DB) {
    const assetRow = await env.DB
      .prepare('SELECT id FROM assets WHERE url = ?')
      .bind(url)
      .first<{ id: string }>();
    if (assetRow) return true;
    const fontRow = await env.DB
      .prepare('SELECT id FROM custom_fonts WHERE url = ?')
      .bind(url)
      .first<{ id: string }>();
    if (fontRow) return true;
  }
  return false;
}

interface PresetRow {
  id: string;
  category: PresetCategory;
  name: string;
  description: string;
  is_default: number;
  thumbnail_json: string;
  payload_json: string;
  asset_refs_json: string;
  created_at: string;
  updated_at: string;
}

async function rowToPreset(env: Env, row: PresetRow): Promise<StudioPreset> {
  const assetRefs: StudioPresetAssetRef[] = JSON.parse(row.asset_refs_json || '[]');
  const missingAssets: StudioPresetAssetRef[] = [];
  for (const ref of assetRefs) {
    const ok = await checkAssetAvailableByUrl(env, ref.url);
    if (!ok) missingAssets.push(ref);
  }
  return {
    id: row.id,
    category: row.category,
    name: row.name,
    description: row.description || undefined,
    isDefault: Boolean(row.is_default),
    thumbnailStyle: JSON.parse(row.thumbnail_json || '{}'),
    payload: JSON.parse(row.payload_json || '{}'),
    assetRefs,
    missingAssets,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listPresets(env: Env, category?: PresetCategory): Promise<StudioPreset[]> {
  const db = requireDb(env);
  await ensureSchema(db);
  const rows = category
    ? await db
        .prepare('SELECT * FROM presets WHERE category = ? ORDER BY is_default DESC, updated_at DESC')
        .bind(category)
        .all<PresetRow>()
    : await db
        .prepare('SELECT * FROM presets ORDER BY category ASC, is_default DESC, updated_at DESC')
        .all<PresetRow>();
  return Promise.all((rows.results || []).map((r) => rowToPreset(env, r)));
}

export async function getPreset(env: Env, id: string): Promise<StudioPreset | null> {
  const db = requireDb(env);
  await ensureSchema(db);
  const row = await db.prepare('SELECT * FROM presets WHERE id = ?').bind(id).first<PresetRow>();
  return row ? rowToPreset(env, row) : null;
}

export async function createPreset(
  env: Env,
  preset: {
    id: string;
    category: PresetCategory;
    name: string;
    description?: string;
    isDefault?: boolean;
    thumbnailStyle?: StudioPreset['thumbnailStyle'];
    payload: Record<string, unknown>;
    assetRefs?: StudioPresetAssetRef[];
  }
): Promise<StudioPreset> {
  const db = requireDb(env);
  await ensureSchema(db);
  const now = new Date().toISOString();
  if (preset.isDefault) {
    await db
      .prepare('UPDATE presets SET is_default = 0 WHERE category = ?')
      .bind(preset.category)
      .run();
  }
  await db
    .prepare(
      `INSERT INTO presets (id, category, name, description, is_default, thumbnail_json, payload_json, asset_refs_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      preset.id,
      preset.category,
      preset.name.trim(),
      preset.description || '',
      preset.isDefault ? 1 : 0,
      JSON.stringify(preset.thumbnailStyle || {}),
      JSON.stringify(preset.payload || {}),
      JSON.stringify(preset.assetRefs || []),
      now,
      now
    )
    .run();
  return (await getPreset(env, preset.id))!;
}

export async function updatePreset(
  env: Env,
  id: string,
  patch: Partial<{
    name: string;
    description: string;
    isDefault: boolean;
    thumbnailStyle: StudioPreset['thumbnailStyle'];
    payload: Record<string, unknown>;
    assetRefs: StudioPresetAssetRef[];
  }>
): Promise<StudioPreset | null> {
  const db = requireDb(env);
  const existing = await getPreset(env, id);
  if (!existing) return null;
  if (patch.isDefault) {
    await db
      .prepare('UPDATE presets SET is_default = 0 WHERE category = ?')
      .bind(existing.category)
      .run();
  }
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE presets SET
        name = ?,
        description = ?,
        is_default = ?,
        thumbnail_json = ?,
        payload_json = ?,
        asset_refs_json = ?,
        updated_at = ?
      WHERE id = ?`
    )
    .bind(
      patch.name !== undefined ? patch.name.trim() : existing.name,
      patch.description !== undefined ? patch.description : existing.description || '',
      patch.isDefault !== undefined ? (patch.isDefault ? 1 : 0) : existing.isDefault ? 1 : 0,
      JSON.stringify(patch.thumbnailStyle ?? existing.thumbnailStyle ?? {}),
      JSON.stringify(patch.payload ?? existing.payload ?? {}),
      JSON.stringify(patch.assetRefs ?? existing.assetRefs ?? []),
      now,
      id
    )
    .run();
  return getPreset(env, id);
}

export async function deletePreset(db: D1Database, id: string): Promise<boolean> {
  await ensureSchema(db);
  const res = await db.prepare('DELETE FROM presets WHERE id = ?').bind(id).run();
  return (res.meta?.changes || 0) > 0;
}

export async function listCustomFonts(db: D1Database): Promise<SavedFontAsset[]> {
  await ensureSchema(db);
  const rows = await db
    .prepare('SELECT id, family, filename, url, created_at FROM custom_fonts ORDER BY created_at DESC')
    .all<{
      id: string;
      family: string;
      filename: string;
      url: string;
      created_at: string;
    }>();
  return (rows.results || []).map((r) => ({
    id: r.id,
    family: r.family,
    filename: r.filename,
    url: r.url,
    createdAt: r.created_at,
  }));
}

export async function registerCustomFont(
  db: D1Database,
  font: {
    id: string;
    family: string;
    filename: string;
    filePath: string;
    url: string;
  }
): Promise<SavedFontAsset> {
  await ensureSchema(db);
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO custom_fonts (id, family, filename, file_path, url, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(font.id, font.family, font.filename, font.filePath, font.url, now)
    .run();
  return {
    id: font.id,
    family: font.family,
    filename: font.filename,
    url: font.url,
    createdAt: now,
  };
}

export async function deleteCustomFont(env: Env, id: string): Promise<boolean> {
  const db = requireDb(env);
  await ensureSchema(db);
  const row = await db
    .prepare('SELECT url FROM custom_fonts WHERE id = ?')
    .bind(id)
    .first<{ url: string }>();
  if (!row) return false;
  const res = await db.prepare('DELETE FROM custom_fonts WHERE id = ?').bind(id).run();
  if ((res.meta?.changes || 0) > 0) {
    if (env.MEDIA_BUCKET) {
      const key = row.url.replace(/^\/media\//, '');
      await env.MEDIA_BUCKET.delete(key).catch(() => undefined);
    }
    const key = row.url.replace(/^\/media\//, '');
    await db.prepare('DELETE FROM media_blobs WHERE key = ?').bind(key).run();
    return true;
  }
  return false;
}

export async function saveStyleThumbnailDataUrl(
  env: Env,
  dataUrl?: string
): Promise<string | undefined> {
  if (!dataUrl || typeof dataUrl !== 'string') return undefined;
  const trimmed = dataUrl.trim();
  if (!trimmed.startsWith('data:image/')) {
    return trimmed.startsWith('/media/') ? trimmed : undefined;
  }
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i.exec(trimmed);
  if (!match) return undefined;
  const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
  const bin = atob(match[2]);
  if (bin.length === 0 || bin.length > 6 * 1024 * 1024) return undefined;
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  const filename = `style_thumb_${crypto.randomUUID().slice(0, 12)}.${ext}`;
  const saved = await saveBinaryAsset(env, {
    projectId: null,
    kind: 'thumbnail',
    bucket: 'thumbs',
    filename,
    mimeType: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg',
    bytes,
  });
  return saved.storedIn === 'client-only' ? trimmed : saved.url;
}

export async function applyPresetIdsToProject(
  env: Env,
  project: Project,
  opts: {
    captionPresetId?: string | null;
    filterPresetId?: string | null;
    editingPresetId?: string | null;
    applyDefaults?: boolean;
    preserveCaptionEnabledState?: boolean;
  }
): Promise<{
  patch: Partial<Project>;
  warnings: Array<{ presetName: string; missingAssets: StudioPresetAssetRef[] }>;
}> {
  const allPresets = await listPresets(env);
  const resolvePreset = async (
    cat: PresetCategory,
    explicitId?: string | null
  ): Promise<StudioPreset | undefined> => {
    if (explicitId === 'none') return undefined;
    if (explicitId) return (await getPreset(env, explicitId)) || undefined;
    if (opts.applyDefaults) {
      return allPresets.find((p) => p.category === cat && p.isDefault);
    }
    return undefined;
  };

  const capPreset = await resolvePreset('caption', opts.captionPresetId);
  const filPreset = await resolvePreset('filter', opts.filterPresetId);
  const edtPreset = await resolvePreset('editing', opts.editingPresetId);

  const patch: Partial<Project> = {};
  const warnings: Array<{ presetName: string; missingAssets: StudioPresetAssetRef[] }> = [];

  if (capPreset) {
    const pStyle = (capPreset.payload?.subtitleStyle || capPreset.payload || {}) as Record<
      string,
      unknown
    >;
    const missingFont = (capPreset.missingAssets || []).filter((a) => a.kind === 'font');
    if (missingFont.length > 0) {
      warnings.push({ presetName: capPreset.name, missingAssets: missingFont });
    }
    const fontUrlOk =
      typeof pStyle.customFontUrl === 'string'
        ? await checkAssetAvailableByUrl(env, pStyle.customFontUrl)
        : true;
    const nextFontUrl = fontUrlOk ? (pStyle.customFontUrl as string | undefined) : undefined;
    patch.subtitleStyle = {
      ...DEFAULT_SUBTITLE_STYLE,
      ...project.subtitleStyle,
      ...(pStyle as Partial<Project['subtitleStyle']>),
      customFontUrl: nextFontUrl,
      enabled: opts.preserveCaptionEnabledState
        ? Boolean(project.subtitleStyle.enabled)
        : Boolean(project.captions.length > 0 && (pStyle.enabled ?? project.subtitleStyle.enabled)),
    };
  }

  if (filPreset) {
    const pFx = (filPreset.payload?.videoEffects || filPreset.payload || {}) as Partial<
      Project['videoEffects']
    >;
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
      if (nextCanvas.bgImageUrl && !(await checkAssetAvailableByUrl(env, nextCanvas.bgImageUrl))) {
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
      const validLogos: Project['logos'] = [];
      for (const l of pEdt.logos) {
        if (l && l.url && (await checkAssetAvailableByUrl(env, l.url))) {
          validLogos.push({ ...l, id: crypto.randomUUID() });
        }
      }
      if (validLogos.length > 0) {
        patch.logos = [...project.logos, ...validLogos];
      }
    }
  }

  return { patch, warnings };
}

export { sanitizeSavedStylePayload };
