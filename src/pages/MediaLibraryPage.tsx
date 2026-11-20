import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  FileAudio,
  Film,
  FolderOpen,
  Image as ImageIcon,
  Layers,
  Loader2,
  Minimize2,
  Music2,
  RefreshCw,
  Sparkles,
  Type,
  Upload,
  Volume2,
} from 'lucide-react';
import {
  NavPage,
  Project,
  SavedFontAsset,
  StudioToolId,
} from '../types/studio';
import {
  api,
  ApiHttpError,
  isValidProjectId,
  LocalAssetManifestItem,
  resolveApiUrl,
  uploadVideoChunked,
} from '../lib/api';
import { formatBytes, formatDurationShort } from '../lib/formatters';
import { resolvePlayableAssetUrl } from '../lib/supabaseCloud';
import {
  StudioBanner,
  StudioButton,
  StudioCard,
  StudioEmptyState,
  StudioMetric,
  StudioSectionHeader,
  StudioSegmentedControl,
} from '../components/ui/StudioPrimitives';

interface MediaLibraryPageProps {
  project: Project;
  customFonts: SavedFontAsset[];
  onProjectUpdated: (p: Project) => void;
  onReloadCustomFonts: () => Promise<void>;
  onOpenInEditor: (tool: StudioToolId, subTab?: string) => void;
  onNavigate: (page: NavPage) => void;
  onNotice?: (msg: string) => void;
}

type AssetFilter = 'all' | 'video' | 'audio' | 'visuals' | 'fonts' | 'exports';

export function MediaLibraryPage({
  project,
  customFonts,
  onProjectUpdated,
  onReloadCustomFonts,
  onOpenInEditor,
  onNavigate,
  onNotice,
}: MediaLibraryPageProps) {
  const videoUploadRef = useRef<HTMLInputElement>(null);
  const logoUploadRef = useRef<HTMLInputElement>(null);
  const bgUploadRef = useRef<HTMLInputElement>(null);
  const musicUploadRef = useRef<HTMLInputElement>(null);
  const sfxUploadRef = useRef<HTMLInputElement>(null);
  const fontUploadRef = useRef<HTMLInputElement>(null);

  const [filter, setFilter] = useState<AssetFilter>('all');
  const [manifest, setManifest] = useState<LocalAssetManifestItem[]>([]);
  const [totalBytes, setTotalBytes] = useState<number>(0);
  const [oversizedCount, setOversizedCount] = useState<number>(0);
  const [loadingManifest, setLoadingManifest] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ pct: number; stage: string } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [resolvedAudioUrls, setResolvedAudioUrls] = useState<{
    dub: string | null;
    bgm: string | null;
    sfx: string | null;
  }>({ dub: null, bgm: null, sfx: null });

  const loadManifest = useCallback(async () => {
    setLoadingManifest(true);
    try {
      const res = await api.getProjectAssetManifest(project.id);
      setManifest(Array.isArray(res.assets) ? res.assets : []);
      setTotalBytes(res.totalBytes || 0);
      setOversizedCount(res.oversizedCount || 0);
    } catch {
      setManifest([]);
    } finally {
      setLoadingManifest(false);
    }
  }, [project.id]);

  useEffect(() => {
    void loadManifest();
  }, [loadManifest, project.updatedAt]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      resolvePlayableAssetUrl(project.voice.fullDubUrl || null, project.cloudAssets),
      resolvePlayableAssetUrl(project.voice.bgMusicUrl || null, project.cloudAssets),
      resolvePlayableAssetUrl(project.voice.sfxUrl || null, project.cloudAssets),
    ]).then(([dub, bgm, sfx]) => {
      if (active) setResolvedAudioUrls({ dub, bgm, sfx });
    });
    return () => {
      active = false;
    };
  }, [project.voice.fullDubUrl, project.voice.bgMusicUrl, project.voice.sfxUrl, project.cloudAssets]);

  const handleCompressSource = async (
    preset: 'under-45mb' | '720p-compact' | '480p-compact'
  ) => {
    setErrorMsg(null);
    setStatusMsg(null);
    setBusyAction(`compress-${preset}`);
    try {
      const res = await api.compressProjectVideo(project.id, preset, 'source');
      onProjectUpdated(res.project);
      const savedMsg = `Compressed source video from ${formatBytes(res.originalBytes)} to ${formatBytes(res.compressedBytes)}.`;
      setStatusMsg(savedMsg);
      onNotice?.(savedMsg);
      await loadManifest();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const [missingProjectError, setMissingProjectError] = useState(false);

  const handleReplaceVideo = async (file: File) => {
    setErrorMsg(null);
    setStatusMsg(null);
    setMissingProjectError(false);
    if (!isValidProjectId(project?.id)) {
      setMissingProjectError(true);
      setErrorMsg('Cannot upload video: no valid project is selected.');
      return;
    }
    setBusyAction('replace-video');
    try {
      const updated = await uploadVideoChunked({
        projectId: project.id,
        file,
        onProgress: (pct, stage) => setUploadProgress({ pct, stage }),
      });
      onProjectUpdated(updated);
      setStatusMsg(`Uploaded "${file.name}" to project.`);
      onNotice?.('Source video replaced.');
      await loadManifest();
    } catch (err) {
      if (err instanceof ApiHttpError && (err.status === 404 || err.code === 'PROJECT_NOT_FOUND')) {
        setMissingProjectError(true);
      }
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadProgress(null);
      setBusyAction(null);
    }
  };

  const handleUploadAsset = async (
    kind: 'logo' | 'bg' | 'music' | 'sfx' | 'font',
    file: File
  ) => {
    setErrorMsg(null);
    setStatusMsg(null);
    setBusyAction(`upload-${kind}`);
    try {
      if (kind === 'logo') {
        const res = await api.uploadLogo(project.id, file);
        onProjectUpdated(res.project);
        setStatusMsg(`Added logo "${file.name}" to project.`);
      } else if (kind === 'bg') {
        const res = await api.uploadCanvasBackground(project.id, file);
        onProjectUpdated(res.project);
        setStatusMsg(`Updated canvas background image "${file.name}".`);
      } else if (kind === 'music') {
        const res = await api.uploadMusic(project.id, file);
        onProjectUpdated(res.project);
        setStatusMsg(`Uploaded background music "${file.name}".`);
      } else if (kind === 'sfx') {
        const res = await api.uploadSfx(project.id, file);
        onProjectUpdated(res.project);
        setStatusMsg(`Uploaded sound effect "${file.name}".`);
      } else if (kind === 'font') {
        await api.uploadCustomFont(file);
        await onReloadCustomFonts();
        setStatusMsg(`Uploaded custom font "${file.name}".`);
      }
      onNotice?.(`Uploaded ${file.name}.`);
      await loadManifest();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const manifestMap = useMemo(() => {
    const m = new Map<string, LocalAssetManifestItem>();
    for (const item of manifest) {
      m.set(item.localUrl, item);
    }
    return m;
  }, [manifest]);

  const showSection = (sec: Exclude<AssetFilter, 'all'>) =>
    filter === 'all' || filter === sec;

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-6">
      {/* Hidden file inputs */}
      <input
        ref={videoUploadRef}
        type="file"
        accept=".mp4,.mov,.mkv,video/mp4,video/quicktime,video/x-matroska"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleReplaceVideo(f);
          e.target.value = '';
        }}
      />
      <input
        ref={logoUploadRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleUploadAsset('logo', f);
          e.target.value = '';
        }}
      />
      <input
        ref={bgUploadRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleUploadAsset('bg', f);
          e.target.value = '';
        }}
      />
      <input
        ref={musicUploadRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleUploadAsset('music', f);
          e.target.value = '';
        }}
      />
      <input
        ref={sfxUploadRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleUploadAsset('sfx', f);
          e.target.value = '';
        }}
      />
      <input
        ref={fontUploadRef}
        type="file"
        accept=".ttf,.otf,.woff,.woff2"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleUploadAsset('font', f);
          e.target.value = '';
        }}
      />

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-display font-bold tracking-tight text-white">
            Media Library
          </h1>
          <p className="text-xs sm:text-sm text-zinc-400 mt-1">
            Inspect, upload, compress, and manage all video, audio, overlay, font, and export assets for{' '}
            <span className="text-zinc-200 font-medium">{project.name}</span>.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <StudioButton
            variant="secondary"
            size="sm"
            onClick={() => void loadManifest()}
            loading={loadingManifest}
            icon={<RefreshCw className="w-3.5 h-3.5" />}
          >
            Refresh Assets
          </StudioButton>
          <StudioButton
            variant="primary"
            size="sm"
            onClick={() => videoUploadRef.current?.click()}
            loading={busyAction === 'replace-video'}
            icon={<Upload className="w-3.5 h-3.5" />}
          >
            {project.sourceVideoUrl ? 'Replace Source Video' : 'Upload Video'}
          </StudioButton>
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StudioMetric
          label="Tracked Assets"
          value={manifest.length}
          subValue={oversizedCount > 0 ? `${oversizedCount} > 50 MB` : 'Ready'}
        />
        <StudioMetric
          label="Total Asset Footprint"
          value={formatBytes(totalBytes)}
          tone="accent"
        />
        <StudioMetric
          label="Overlays & Visuals"
          value={project.logos.length + (project.canvas?.bgImageUrl ? 1 : 0)}
          subValue={`${project.logos.length} logos`}
        />
        <StudioMetric
          label="Audio & Voices"
          value={
            (project.voice.generatedClips?.length || 0) +
            (project.voice.bgMusicUrl ? 1 : 0) +
            (project.voice.sfxUrl ? 1 : 0)
          }
          subValue={`${project.voice.generatedClips.length} AI clips`}
          tone="success"
        />
      </div>

      {uploadProgress && (
        <StudioCard>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-200 font-medium">{uploadProgress.stage}</span>
              <span className="font-mono text-violet-300 tabular-nums">{uploadProgress.pct}%</span>
            </div>
            <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
              <div
                className="h-full bg-violet-500 transition-all"
                style={{ width: `${uploadProgress.pct}%` }}
              />
            </div>
          </div>
        </StudioCard>
      )}

      {errorMsg && (
        <StudioBanner tone="error">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <span>{errorMsg}</span>
            {missingProjectError && (
              <StudioButton
                size="sm"
                variant="secondary"
                onClick={() => onNavigate('dashboard')}
              >
                Go to Projects &amp; Import
              </StudioButton>
            )}
          </div>
        </StudioBanner>
      )}
      {statusMsg && <StudioBanner tone="success">{statusMsg}</StudioBanner>}

      {/* Category Filter */}
      <div className="overflow-x-auto no-scrollbar">
        <StudioSegmentedControl
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All Assets' },
            { value: 'video', label: 'Source Video' },
            { value: 'audio', label: 'Audio & Dubs' },
            { value: 'visuals', label: 'Logos & Backgrounds' },
            { value: 'fonts', label: `Custom Fonts (${customFonts.length})` },
            { value: 'exports', label: 'Exports & Covers' },
          ]}
        />
      </div>

      {/* 1. Source Video */}
      {showSection('video') && (
        <StudioCard padding="lg" className="space-y-4">
          <StudioSectionHeader
            icon={<Film className="w-4 h-4" />}
            title="Source Video"
            subtitle="Primary footage used across translation, dubbing, timeline editing, and export."
            actions={
              <div className="flex flex-wrap items-center gap-2">
                {project.sourceVideoUrl && (
                  <>
                    <StudioButton
                      size="sm"
                      variant="secondary"
                      onClick={() => void handleCompressSource('720p-compact')}
                      loading={busyAction === 'compress-720p-compact'}
                      icon={<Minimize2 className="w-3.5 h-3.5" />}
                    >
                      Compact 720p
                    </StudioButton>
                    <StudioButton
                      size="sm"
                      variant="secondary"
                      onClick={() => void handleCompressSource('under-45mb')}
                      loading={busyAction === 'compress-under-45mb'}
                      icon={<Sparkles className="w-3.5 h-3.5 text-violet-400" />}
                    >
                      Compress &lt;45 MB
                    </StudioButton>
                  </>
                )}
                <StudioButton
                  size="sm"
                  variant="primary"
                  onClick={() => videoUploadRef.current?.click()}
                  loading={busyAction === 'replace-video'}
                  icon={<Upload className="w-3.5 h-3.5" />}
                >
                  {project.sourceVideoUrl ? 'Replace Video' : 'Upload Video'}
                </StudioButton>
              </div>
            }
          />

          {project.sourceVideoUrl && project.metadata ? (
            <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-center p-3.5 rounded-xl bg-[#16161D] border border-white/[0.07]">
              <div className="md:col-span-4 aspect-video rounded-lg bg-black border border-white/[0.08] overflow-hidden flex items-center justify-center">
                {project.thumbnailUrl ? (
                  <img
                    src={resolveApiUrl(project.thumbnailUrl)}
                    alt={project.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <Film className="w-8 h-8 text-zinc-600" />
                )}
              </div>
              <div className="md:col-span-8 space-y-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-white truncate">
                    {project.sourceFilename || `${project.name}.mp4`}
                  </span>
                  <span className="font-mono text-emerald-300 flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Loaded
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] font-mono text-zinc-300 tabular-nums">
                  <div className="p-2 rounded bg-[#101015] border border-white/[0.06]">
                    <div className="text-zinc-500">Resolution</div>
                    <div>{project.metadata.width}×{project.metadata.height}</div>
                  </div>
                  <div className="p-2 rounded bg-[#101015] border border-white/[0.06]">
                    <div className="text-zinc-500">Duration</div>
                    <div>{formatDurationShort(project.metadata.duration)}</div>
                  </div>
                  <div className="p-2 rounded bg-[#101015] border border-white/[0.06]">
                    <div className="text-zinc-500">Size</div>
                    <div>{formatBytes(project.metadata.fileSize)}</div>
                  </div>
                  <div className="p-2 rounded bg-[#101015] border border-white/[0.06]">
                    <div className="text-zinc-500">FPS / Audio</div>
                    <div>
                      {Math.round(project.metadata.fps)} fps ·{' '}
                      {project.metadata.hasAudio ? 'Audio' : 'Silent'}
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <StudioButton
                    size="sm"
                    variant="secondary"
                    onClick={() => onOpenInEditor('edit', 'media')}
                    icon={<ExternalLink className="w-3.5 h-3.5" />}
                  >
                    Open in Video Editor
                  </StudioButton>
                  <a
                    href={`${resolveApiUrl(project.sourceVideoUrl)}?download=1`}
                    className="min-h-[34px] px-2.5 py-1 rounded-lg bg-[#181820] hover:bg-[#22222C] border border-white/[0.09] text-xs font-medium text-zinc-200 inline-flex items-center gap-1.5"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Download Source</span>
                  </a>
                </div>
              </div>
            </div>
          ) : (
            <StudioEmptyState
              icon={<Film className="w-5 h-5" />}
              title="No source video imported yet"
              description="Upload an MP4, MOV, or MKV video to unlock editing, translation, and AI voice dubbing."
              action={
                <StudioButton
                  variant="primary"
                  size="sm"
                  onClick={() => videoUploadRef.current?.click()}
                  icon={<Upload className="w-3.5 h-3.5" />}
                >
                  Upload Source Video
                </StudioButton>
              }
            />
          )}
        </StudioCard>
      )}

      {/* 2. Audio, Music, SFX & Voice Clips */}
      {showSection('audio') && (
        <StudioCard padding="lg" className="space-y-4">
          <StudioSectionHeader
            icon={<Music2 className="w-4 h-4" />}
            title="Audio Tracks & AI Dubbing"
            subtitle="Manage background music, sound effects, and generated narrator tracks."
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <StudioButton
                  size="sm"
                  variant="secondary"
                  onClick={() => musicUploadRef.current?.click()}
                  loading={busyAction === 'upload-music'}
                  icon={<Upload className="w-3.5 h-3.5" />}
                >
                  Upload Music
                </StudioButton>
                <StudioButton
                  size="sm"
                  variant="secondary"
                  onClick={() => sfxUploadRef.current?.click()}
                  loading={busyAction === 'upload-sfx'}
                  icon={<Upload className="w-3.5 h-3.5" />}
                >
                  Upload SFX
                </StudioButton>
                <StudioButton
                  size="sm"
                  variant="primary"
                  onClick={() => onNavigate('voice')}
                  icon={<Volume2 className="w-3.5 h-3.5" />}
                >
                  Open Voice Studio
                </StudioButton>
              </div>
            }
          />

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
            <div className="p-3.5 rounded-xl bg-[#16161D] border border-white/[0.07] space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-white">AI Voice Narration</span>
                <span className="font-mono text-[11px] text-violet-300 tabular-nums">
                  {project.voice.generatedClips.length} clips
                </span>
              </div>
              <p className="text-[11px] text-zinc-400">
                Narrator:{' '}
                <span className="text-zinc-200">
                  {project.voice.fishVoiceTitle || project.voice.voiceName || 'Default'}
                </span>
              </p>
              {project.voice.fullDubUrl ? (
                <audio
                  src={resolvedAudioUrls.dub || resolveApiUrl(project.voice.fullDubUrl)}
                  controls
                  className="w-full h-8"
                />
              ) : (
                <div className="text-[11px] text-zinc-500">No full dub track generated yet.</div>
              )}
            </div>

            <div className="p-3.5 rounded-xl bg-[#16161D] border border-white/[0.07] space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-white">Background Music</span>
                <FileAudio className="w-4 h-4 text-zinc-400" />
              </div>
              {project.voice.bgMusicUrl ? (
                <>
                  <div className="text-[11px] text-zinc-300 truncate">
                    {project.voice.bgMusicFilename || 'Music track'}
                  </div>
                  <audio
                    src={resolvedAudioUrls.bgm || resolveApiUrl(project.voice.bgMusicUrl)}
                    controls
                    className="w-full h-8"
                  />
                </>
              ) : (
                <div className="text-[11px] text-zinc-500">No background music uploaded.</div>
              )}
            </div>

            <div className="p-3.5 rounded-xl bg-[#16161D] border border-white/[0.07] space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-white">Sound Effects (SFX)</span>
                <Volume2 className="w-4 h-4 text-zinc-400" />
              </div>
              {project.voice.sfxUrl ? (
                <>
                  <div className="text-[11px] text-zinc-300 truncate">
                    {project.voice.sfxFilename || 'SFX clip'}
                  </div>
                  <audio
                    src={resolvedAudioUrls.sfx || resolveApiUrl(project.voice.sfxUrl)}
                    controls
                    className="w-full h-8"
                  />
                </>
              ) : (
                <div className="text-[11px] text-zinc-500">No SFX audio uploaded.</div>
              )}
            </div>
          </div>
        </StudioCard>
      )}

      {/* 3. Logos, Watermarks & Backgrounds */}
      {showSection('visuals') && (
        <StudioCard padding="lg" className="space-y-4">
          <StudioSectionHeader
            icon={<Layers className="w-4 h-4" />}
            title="Logos, Watermarks & Background Images"
            subtitle="Manage visual overlays and canvas backdrops."
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <StudioButton
                  size="sm"
                  variant="secondary"
                  onClick={() => bgUploadRef.current?.click()}
                  loading={busyAction === 'upload-bg'}
                  icon={<ImageIcon className="w-3.5 h-3.5" />}
                >
                  Upload Background
                </StudioButton>
                <StudioButton
                  size="sm"
                  variant="primary"
                  onClick={() => logoUploadRef.current?.click()}
                  loading={busyAction === 'upload-logo'}
                  icon={<Upload className="w-3.5 h-3.5" />}
                >
                  Add Logo / Watermark
                </StudioButton>
              </div>
            }
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {project.canvas?.bgImageUrl && (
              <div className="p-3 rounded-xl bg-[#16161D] border border-white/[0.07] space-y-2">
                <div className="aspect-video rounded-lg bg-black overflow-hidden border border-white/[0.06]">
                  <img
                    src={resolveApiUrl(project.canvas.bgImageUrl)}
                    alt="Canvas background"
                    className="w-full h-full object-cover"
                  />
                </div>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <div className="min-w-0">
                    <div className="font-medium text-white truncate">
                      {project.canvas.bgImageFilename || 'Canvas Background'}
                    </div>
                    <div className="text-[11px] text-zinc-500">Background Layer</div>
                  </div>
                  <StudioButton
                    size="sm"
                    variant="secondary"
                    onClick={() => onOpenInEditor('edit', 'background')}
                  >
                    Edit
                  </StudioButton>
                </div>
              </div>
            )}

            {project.logos.map((logo) => {
              const info = manifestMap.get(logo.url);
              return (
                <div
                  key={logo.id}
                  className="p-3 rounded-xl bg-[#16161D] border border-white/[0.07] space-y-2"
                >
                  <div className="aspect-video rounded-lg bg-[#09090C] overflow-hidden border border-white/[0.06] flex items-center justify-center p-3">
                    <img
                      src={resolveApiUrl(logo.url)}
                      alt={logo.filename}
                      className="max-h-full max-w-full object-contain"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <div className="min-w-0">
                      <div className="font-medium text-white truncate">{logo.filename}</div>
                      <div className="text-[11px] text-zinc-500 font-mono tabular-nums">
                        {info ? formatBytes(info.sizeBytes) : 'Logo Overlay'}
                      </div>
                    </div>
                    <StudioButton
                      size="sm"
                      variant="secondary"
                      onClick={() => onOpenInEditor('overlay')}
                    >
                      Edit
                    </StudioButton>
                  </div>
                </div>
              );
            })}
          </div>

          {!project.canvas?.bgImageUrl && project.logos.length === 0 && (
            <StudioEmptyState
              icon={<ImageIcon className="w-5 h-5" />}
              title="No overlays or background images"
              description="Upload a PNG logo watermark or a backdrop image for vertical/horizontal framing."
            />
          )}
        </StudioCard>
      )}

      {/* 4. Custom Fonts */}
      {showSection('fonts') && (
        <StudioCard padding="lg" className="space-y-4">
          <StudioSectionHeader
            icon={<Type className="w-4 h-4" />}
            title="Custom Fonts Library"
            subtitle="Uploaded .TTF, .OTF, and .WOFF font files shared across captions and text layers."
            actions={
              <div className="flex items-center gap-2">
                <StudioButton
                  size="sm"
                  variant="secondary"
                  onClick={() => onOpenInEditor('captions', 'fonts')}
                >
                  Open Font Picker
                </StudioButton>
                <StudioButton
                  size="sm"
                  variant="primary"
                  onClick={() => fontUploadRef.current?.click()}
                  loading={busyAction === 'upload-font'}
                  icon={<Upload className="w-3.5 h-3.5" />}
                >
                  Upload Font
                </StudioButton>
              </div>
            }
          />

          {customFonts.length === 0 ? (
            <StudioEmptyState
              icon={<Type className="w-5 h-5" />}
              title="No custom fonts uploaded"
              description="Built-in studio fonts are ready to use, or upload custom .TTF/.OTF typography files."
            />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {customFonts.map((f) => (
                <div
                  key={f.id}
                  className="p-3 rounded-xl bg-[#16161D] border border-white/[0.07] flex items-center justify-between gap-2 text-xs"
                >
                  <div className="min-w-0">
                    <div className="font-semibold text-white truncate">{f.family}</div>
                    <div className="text-[11px] text-zinc-500 font-mono truncate">{f.filename}</div>
                  </div>
                  <StudioButton
                    size="sm"
                    variant="secondary"
                    onClick={() => onOpenInEditor('captions', 'fonts')}
                  >
                    Use
                  </StudioButton>
                </div>
              ))}
            </div>
          )}
        </StudioCard>
      )}

      {/* 5. Exports & Saved Thumbnails */}
      {showSection('exports') && (
        <StudioCard padding="lg" className="space-y-4">
          <StudioSectionHeader
            icon={<FolderOpen className="w-4 h-4" />}
            title="Rendered Exports & Covers"
            subtitle="Download finished renders or generate TikTok/YouTube covers in the Export Center."
            actions={
              <StudioButton
                size="sm"
                variant="primary"
                onClick={() => onNavigate('export')}
                icon={<ExternalLink className="w-3.5 h-3.5" />}
              >
                Open Export Center
              </StudioButton>
            }
          />

          <div className="space-y-3">
            {project.lastExportUrl ? (
              <div className="p-3.5 rounded-xl bg-[#16161D] border border-emerald-500/30 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="space-y-0.5">
                  <div className="font-semibold text-white flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    Final Exported MP4
                  </div>
                  <div className="text-[11px] text-zinc-400 font-mono tabular-nums">
                    {project.lastExportSize ? formatBytes(project.lastExportSize) : 'Ready'} ·{' '}
                    {project.exportSettings.resolution} · {project.exportSettings.aspectRatio}
                  </div>
                </div>
                <a
                  href={`${resolveApiUrl(project.lastExportUrl)}?download=1`}
                  className="min-h-[36px] px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white inline-flex items-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download MP4
                </a>
              </div>
            ) : (
              <div className="p-4 rounded-xl bg-[#16161D] border border-white/[0.06] text-xs text-zinc-400 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-zinc-500 shrink-0" />
                <span>No final MP4 exported for this project yet.</span>
              </div>
            )}

            {project.savedThumbnails && project.savedThumbnails.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
                {project.savedThumbnails.map((thumb) => (
                  <div
                    key={thumb.id}
                    className="rounded-xl bg-[#16161D] border border-white/[0.07] overflow-hidden"
                  >
                    <img
                      src={resolveApiUrl(thumb.url)}
                      alt={thumb.label}
                      className="w-full aspect-video object-cover bg-black"
                    />
                    <div className="p-2 flex items-center justify-between gap-1 text-[11px]">
                      <span className="truncate text-zinc-300">{thumb.label}</span>
                      <a
                        href={`${resolveApiUrl(thumb.url)}?download=1`}
                        className="text-violet-400 hover:text-violet-300 shrink-0"
                        title="Download cover"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </StudioCard>
      )}
    </div>
  );
}
