-- Migration 0001: Recap Studio AI Cloudflare D1 Schema

CREATE TABLE IF NOT EXISTS projects (
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
);

CREATE TABLE IF NOT EXISTS jobs (
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
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  file_path TEXT NOT NULL,
  url TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS presets (
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
);

CREATE TABLE IF NOT EXISTS custom_fonts (
  id TEXT PRIMARY KEY,
  family TEXT NOT NULL,
  filename TEXT NOT NULL,
  file_path TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS upload_sessions (
  upload_id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  total_size INTEGER NOT NULL,
  total_chunks INTEGER NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'video/mp4',
  r2_upload_id TEXT,
  r2_key TEXT,
  parts_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media_blobs (
  key TEXT PRIMARY KEY,
  mime_type TEXT NOT NULL,
  data BLOB NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_project_id ON jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_assets_project_id ON assets(project_id);
CREATE INDEX IF NOT EXISTS idx_assets_url ON assets(url);
CREATE INDEX IF NOT EXISTS idx_presets_category ON presets(category);
