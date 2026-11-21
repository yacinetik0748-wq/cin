import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cloud,
  Download,
  Eye,
  Film,
  Flame,
  Loader2,
  Mic,
  Palette,
  RefreshCw,
  RotateCcw,
  Type,
  XCircle,
} from 'lucide-react';
import {
  DEFAULT_VIDEO_CANVAS,
  ExportSettings,
  ExportSpeedProfile,
  Project,
  ProjectPatchFn,
  RenderJob,
  SavedFontAsset,
} from '../types/studio';
import { api } from '../lib/api';
import { getBlobAssetByKey } from '../lib/browserStorage';
import { localProjectService } from '../lib/localProjectService';
import { estimateExportOutputSize, resolveExportSpeedPreset } from '../lib/exportEstimation';
import { formatBytes, formatDurationShort } from '../lib/formatters';
import { indexedDbStore } from '../lib/indexedDbStore';
import {
  downloadProjectAsset,
  getCloudSession,
  isSupabaseConfigured,
  resolvePlayableAssetUrl,
  uploadSingleProjectAssetToCloud,
} from '../lib/supabaseCloud';
import {
  countMissingTranslations,
  createWorkflowUpdate,
  resolveCanvasDimensions,
} from '../lib/workflowStages';
import { TimelineSyncCard } from '../components/TimelineSyncCard';
import { VideoStudioPlayer } from '../components/VideoStudioPlayer';
import { TikTokThumbnailEditor } from '../components/TikTokThumbnailEditor';
import { CollapsibleSection } from '../components/ui/CollapsibleSection';

interface ExportCenterPageProps {
  project: Project;
  onProjectUpdated: (p: Project) => void;
  onPatchProject?: ProjectPatchFn;
  onFlushSaves?: (projectId?: string) => Promise<boolean>;
  customFonts?: SavedFontAsset[];
}

export function ExportCenterPage({
  project,
  onProjectUpdated,
  onPatchProject,
  onFlushSaves,
  customFonts = [],
}: ExportCenterPageProps) {
  const draftVideoRef = useRef<HTMLVideoElement | null>(null);
  const finalVideoRef = useRef<HTMLVideoElement | null>(null);
  const cloudUploadAbortRef = useRef<AbortController | null>(null);
  const lastExportMarkerRef = useRef<string | null>(
    `${project.id}:${project.lastExportUrl || ''}:${project.lastExportedAt || ''}`
  );

  const [jobs, setJobs] = useState<RenderJob[]>([]);
  const [activeJob, setActiveJob] = useState<RenderJob | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [previewMode, setPreviewMode] = useState<'rendered' | 'draft'>(() =>
    project.lastExportUrl ? 'rendered' : 'draft'
  );
  const [draftTime, setDraftTime] = useState(0);
  const [draftEffects, setDraftEffects] = useState(true);

  const [exportValidation, setExportValidation] = useState<
    'idle' | 'checking' | 'valid' | 'error'
  >('idle');
  const [exportValidationMsg, setExportValidationMsg] = useState<string | null>(null);
  const [resolvedExportUrl, setResolvedExportUrl] = useState<string | null>(
    project.lastExportUrl
  );
  const [videoMetaInfo, setVideoMetaInfo] = useState<{
    w: number;
    h: number;
    dur: number;
  } | null>(null);

  const [cloudUploading, setCloudUploading] = useState(false);
  const [cloudUploadPct, setCloudUploadPct] = useState<number | null>(null);
  const [cloudUploadStage, setCloudUploadStage] = useState<string | null>(null);
  const [cloudUploadError, setCloudUploadError] = useState<string | null>(null);
  const [downloadingTarget, setDownloadingTarget] = useState<'final' | 'original' | null>(null);
  const [missingMediaList, setMissingMediaList] = useState<string[]>([]);
  const [detectedFormatLabel, setDetectedFormatLabel] = useState<string>(() => {
    if (project.lastExportUrl?.toLowerCase().endsWith('.webm')) {
      return 'WebM · VP9/VP8 (Browser Canvas Fallback)';
    }
    return 'MP4 · H.264 / AAC (Local Browser)';
  });
  const [renderSummary, setRenderSummary] = useState<{
    engine: 'webcodecs-hardware' | 'webcodecs-software' | 'ffmpeg-wasm' | 'canvas-mediarecorder';
    hardwareAccelerated?: boolean;
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
    hasAudio?: boolean;
    maxVolumeDb?: number | null;
    videoCodec?: string | null;
    audioCodec?: string | null;
  } | null>(null);

  const [diagnosticSteps, setDiagnosticSteps] = useState<
    Array<{
      id: string;
      label: string;
      status: 'pending' | 'running' | 'success' | 'error';
      time?: string;
      error?: string;
      stack?: string;
    }>
  >([
    { id: 'EXPORT_BUTTON_CLICKED', label: 'EXPORT_BUTTON_CLICKED', status: 'pending' },
    { id: 'EXPORT_HANDLER_STARTED', label: 'EXPORT_HANDLER_STARTED', status: 'pending' },
    { id: 'PROJECT_DATA_LOADED', label: 'PROJECT_DATA_LOADED', status: 'pending' },
    { id: 'TIMELINE_VALIDATED', label: 'TIMELINE_VALIDATED', status: 'pending' },
    { id: 'EXPORT_ENGINE_DETECTED', label: 'EXPORT_ENGINE_DETECTED', status: 'pending' },
    { id: 'EXPORT_INITIALIZATION_STARTED', label: 'EXPORT_INITIALIZATION_STARTED', status: 'pending' },
    { id: 'EXPORT_INITIALIZATION_COMPLETED', label: 'EXPORT_INITIALIZATION_COMPLETED', status: 'pending' },
    { id: 'VIDEO_RENDERING_STARTED', label: 'VIDEO_RENDERING_STARTED', status: 'pending' },
    { id: 'VIDEO_BLOB_CREATED', label: 'VIDEO_BLOB_CREATED', status: 'pending' },
    { id: 'DOWNLOAD_STARTED', label: 'DOWNLOAD_STARTED', status: 'pending' },
    { id: 'EXPORT_COMPLETED', label: 'EXPORT_COMPLETED', status: 'pending' },
  ]);

  const updateDiagnosticStep = (
    id: string,
    status: 'pending' | 'running' | 'success' | 'error',
    error?: string,
    stack?: string
  ) => {
    setDiagnosticSteps((prev) =>
      prev.map((step) =>
        step.id === id
          ? {
              ...step,
              status,
              time: new Date().toLocaleTimeString(),
              error: error || step.error,
              stack: stack || step.stack,
            }
          : step
      )
    );
  };

  const settings = project.exportSettings;
  const resolvedDims = resolveCanvasDimensions(
    project.canvas,
    settings,
    project.metadata
  );
  const sizeEstimate = useMemo(() => estimateExportOutputSize(project), [project]);

  const verifyExportedFile = useCallback(
    async (url: string | null) => {
      if (!url) {
        setExportValidation('idle');
        setExportValidationMsg(null);
        setResolvedExportUrl(null);
        setVideoMetaInfo(null);
        return;
      }
      setExportValidation('checking');
      setExportValidationMsg(null);
      setVideoMetaInfo(null);
      try {
        if (url.startsWith('idb://blobs/')) {
          const blobKey = url.slice('idb://blobs/'.length);
          const localBlob = await getBlobAssetByKey(blobKey).catch(() => null);
          if (localBlob && localBlob.size >= 1024) {
            const playUrl = await resolvePlayableAssetUrl(url, project.cloudAssets);
            if (playUrl) {
              setResolvedExportUrl(playUrl);
              setExportValidation('valid');
              return;
            }
          }
          setExportValidation('error');
          setExportValidationMsg(
            'Exported video file not found in local IndexedDB storage. Re-render Final MP4.'
          );
          return;
        }
        const cached = await indexedDbStore.getCachedMediaByUrl(url);
        if (cached && cached.blob && cached.blob.size >= 1024) {
          const playUrl = await resolvePlayableAssetUrl(url, project.cloudAssets);
          if (playUrl) {
            setResolvedExportUrl(playUrl);
            setExportValidation('valid');
            return;
          }
        }
        const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
        const size = Number(res.headers.get('content-length') || 0);
        if (res.ok && size >= 1024) {
          setResolvedExportUrl(`${url}?v=${encodeURIComponent(project.lastExportedAt || '1')}`);
          setExportValidation('valid');
          return;
        }
        setExportValidation('error');
        setExportValidationMsg(
          !res.ok
            ? `Exported video file not found locally or in cloud storage (HTTP ${res.status}). Re-render Final MP4.`
            : 'Exported MP4 is empty or incomplete (0 bytes). Re-render Final MP4.'
        );
      } catch (err) {
        setExportValidation('error');
        setExportValidationMsg(
          err instanceof Error ? err.message : 'Unable to verify exported MP4.'
        );
      }
    },
    [project.cloudAssets, project.lastExportedAt]
  );

  const uploadFinalMp4ToCloud = useCallback(
    async (targetProject: Project) => {
      if (!targetProject.lastExportUrl) return;
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        setCloudUploadError('Offline: Final MP4 saved locally. Connect online to upload to cloud.');
        return;
      }
      if (!isSupabaseConfigured()) return;
      const { user } = await getCloudSession();
      if (!user) return;

      const controller = new AbortController();
      cloudUploadAbortRef.current = controller;
      setCloudUploading(true);
      setCloudUploadPct(0);
      setCloudUploadStage('Preparing Final MP4 for Supabase Cloud upload...');
      setCloudUploadError(null);

      try {
        const res = await uploadSingleProjectAssetToCloud(
          targetProject,
          targetProject.lastExportUrl,
          {
            signal: controller.signal,
            onProgress: (pct, stage) => {
              setCloudUploadPct(pct);
              setCloudUploadStage(stage);
            },
          }
        );
        onProjectUpdated(res.project);
        if (res.failedUploads.length > 0) {
          setCloudUploadError(res.failedUploads[0].reason);
        } else if (res.skippedLargeAssets.length > 0) {
          setCloudUploadError(res.skippedLargeAssets[0].reason);
        } else if (res.cancelled) {
          setCloudUploadError('Cloud upload cancelled by user. Local MP4 preserved.');
        } else {
          setCloudUploadStage(res.message);
        }
      } catch (err) {
        setCloudUploadError(err instanceof Error ? err.message : String(err));
      } finally {
        cloudUploadAbortRef.current = null;
        setCloudUploading(false);
      }
    },
    [onProjectUpdated]
  );

  useEffect(() => {
    void verifyExportedFile(project.lastExportUrl);
    if (project.lastExportUrl) {
      const isWebm = project.lastExportUrl.toLowerCase().endsWith('.webm');
      setDetectedFormatLabel(
        isWebm
          ? 'WebM · VP9/VP8 (Android/Browser Canvas Fallback)'
          : 'MP4 · H.264 / AAC (Local Browser)'
      );
    }
    const nextMarker = `${project.id}:${project.lastExportUrl || ''}:${project.lastExportedAt || ''}`;
    if (lastExportMarkerRef.current !== nextMarker) {
      lastExportMarkerRef.current = nextMarker;
      setPreviewMode(project.lastExportUrl ? 'rendered' : 'draft');
    }
  }, [project.id, project.lastExportUrl, project.lastExportedAt, verifyExportedFile]);

  useEffect(() => {
    let cancelled = false;
    void localProjectService.diagnoseProjectMedia(project).then((diag) => {
      if (!cancelled) {
        setMissingMediaList(diag.missing);
      }
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project]);

  useEffect(() => {
    void api.listProjectJobs(project.id).then((res) => {
      setJobs(res.jobs);
      const running = res.jobs.find((j) => j.status === 'queued' || j.status === 'processing');
      setActiveJob(running || res.jobs[0] || null);
    });
  }, [project.id]);

  // Poll active background render job every 900ms
  useEffect(() => {
    if (!activeJob || (activeJob.status !== 'queued' && activeJob.status !== 'processing')) {
      return;
    }

    const timer = setInterval(async () => {
      try {
        const res = await api.getJob(activeJob.id);
        setActiveJob(res.job);
        setJobs((prev) => prev.map((j) => (j.id === res.job.id ? res.job : j)));

        if (res.job.status === 'completed') {
          updateDiagnosticStep('EXPORT_INITIALIZATION_COMPLETED', 'success');
          updateDiagnosticStep('VIDEO_RENDERING_STARTED', 'success');
          updateDiagnosticStep('VIDEO_BLOB_CREATED', 'success');
          updateDiagnosticStep('EXPORT_COMPLETED', 'success');
          const pRes = await api.getProject(project.id);
          const nextWorkflow = createWorkflowUpdate(pRes.project.workflow, {
            completeStage: 'export',
            clearAttentionFor: 'export',
          });
          const { project: synced } = await api.updateProject(project.id, {
            workflow: nextWorkflow,
          });
          onProjectUpdated(synced);
          setPreviewMode('rendered');
          void verifyExportedFile(synced.lastExportUrl);
          // Automatically upload & verify rendered MP4 to Supabase Free Cloud if signed in
          void uploadFinalMp4ToCloud(synced);
        } else if (res.job.status === 'failed') {
          const errMsg = res.job.error || 'Video render failed. Your project edits are preserved.';
          const errStack = new Error(errMsg).stack;
          updateDiagnosticStep('VIDEO_RENDERING_STARTED', 'error', errMsg, errStack);
          setErrorMsg(errMsg);
        }
      } catch {
        // ignore transient poll errors
      }
    }, 900);

    return () => clearInterval(timer);
  }, [activeJob, project.id, onProjectUpdated, verifyExportedFile, uploadFinalMp4ToCloud]);

  const updateSettings = async (patch: Partial<ExportSettings>) => {
    const next = { ...settings, ...patch };
    const nextCanvas =
      patch.aspectRatio !== undefined
        ? { ...DEFAULT_VIDEO_CANVAS, ...(project.canvas || {}), aspectRatio: patch.aspectRatio }
        : project.canvas;
    if (onPatchProject) {
      onPatchProject(
        project.id,
        { exportSettings: next, canvas: nextCanvas },
        { immediate: true }
      );
      return;
    }
    onProjectUpdated({ ...project, exportSettings: next, canvas: nextCanvas });
    const { project: saved } = await api.updateProject(project.id, {
      exportSettings: next,
      canvas: nextCanvas,
    });
    onProjectUpdated(saved);
  };

  // Requirement 2 & 3: 100% Local-First Prominent GENERATE FINAL VIDEO Handler
  const handleGenerateFinalVideo = async () => {
    setErrorMsg(null);
    updateDiagnosticStep('EXPORT_BUTTON_CLICKED', 'success');
    updateDiagnosticStep('EXPORT_HANDLER_STARTED', 'running');

    if (!project.sourceVideoUrl && !project.sourceVideoBlobKey) {
      const err = new Error('No source video uploaded. Please import a video before generating final output.');
      updateDiagnosticStep('EXPORT_HANDLER_STARTED', 'error', err.message, err.stack);
      setErrorMsg(err.message);
      return;
    }

    setStarting(true);
    try {
      updateDiagnosticStep('EXPORT_HANDLER_STARTED', 'success');
      updateDiagnosticStep('PROJECT_DATA_LOADED', 'running');

      // 1. Read the current project ID from the active editor
      const targetProjectId = project.id;

      // 2. Retrieve that project from IndexedDB (persisting pending edits first)
      if (onFlushSaves) {
        await onFlushSaves(targetProjectId);
      }
      let targetProj = await localProjectService.getProject(targetProjectId);
      if (!targetProj) {
        targetProj = await localProjectService.saveProject(project);
      }
      updateDiagnosticStep('PROJECT_DATA_LOADED', 'success');

      // 3. Retrieve its timeline and associated media & 4. Validate that all required files exist
      updateDiagnosticStep('TIMELINE_VALIDATED', 'running');
      const mediaDiag = await localProjectService.diagnoseProjectMedia(targetProj);
      if (!mediaDiag.sourceVideoFound) {
        const err = new Error(
          'Project source video is missing or 0 bytes in local IndexedDB storage. Please re-import your video file.'
        );
        updateDiagnosticStep('TIMELINE_VALIDATED', 'error', err.message, err.stack);
        setErrorMsg(err.message);
        return;
      }
      updateDiagnosticStep('TIMELINE_VALIDATED', 'success');

      // 5. Detect engine
      updateDiagnosticStep('EXPORT_ENGINE_DETECTED', 'running');
      updateDiagnosticStep('EXPORT_ENGINE_DETECTED', 'success');
      updateDiagnosticStep('EXPORT_INITIALIZATION_STARTED', 'running');

      const initialJob: RenderJob = {
        id: crypto.randomUUID(),
        projectId: targetProj.id,
        type: 'render',
        status: 'processing',
        progress: 5,
        stage: 'Preparing media',
        etaSeconds: null,
        outputUrl: null,
        outputSize: null,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setActiveJob(initialJob);
      setJobs((prev) => [initialJob, ...prev]);

      updateDiagnosticStep('EXPORT_INITIALIZATION_STARTED', 'success');
      updateDiagnosticStep('EXPORT_INITIALIZATION_COMPLETED', 'success');
      updateDiagnosticStep('VIDEO_RENDERING_STARTED', 'running');

      const renderRes = await localProjectService.startLocalExport(
        targetProj.id,
        settings,
        (pct, stage, etaSec) => {
          setActiveJob((prev) =>
            prev
              ? {
                  ...prev,
                  progress: pct,
                  stage,
                  ...(etaSec !== undefined ? { etaSeconds: etaSec } : {}),
                }
              : null
          );
        }
      );

      setActiveJob(renderRes.job);
      setJobs((prev) => [renderRes.job, ...prev.filter((j) => j.id !== renderRes.job.id)]);
      const isWebm = renderRes.filename.toLowerCase().endsWith('.webm') || renderRes.mimeType.includes('webm');
      setDetectedFormatLabel(
        isWebm
          ? 'WebM · VP9/VP8 (Android/Browser Canvas Fallback)'
          : renderRes.engine === 'webcodecs-hardware'
          ? 'MP4 · WebCodecs Hardware H.264 / AAC 96k'
          : renderRes.engine === 'webcodecs-software'
          ? 'MP4 · WebCodecs H.264 / AAC 96k'
          : 'MP4 · H.264 / AAC 96k (Local Browser FFmpeg)'
      );
      setRenderSummary({
        engine: renderRes.engine,
        hardwareAccelerated: renderRes.hardwareAccelerated,
        bitrateControl: renderRes.bitrateControl,
        targetVideoKbps: renderRes.targetVideoKbps,
        targetAudioKbps: renderRes.targetAudioKbps,
        framesRendered: renderRes.framesRendered,
        staticFramesReused: renderRes.staticFramesReused,
        peakHeapMb: renderRes.peakHeapMb,
        streamCopied: renderRes.streamCopied,
        multiThreaded: renderRes.multiThreaded,
        renderDurationMs: renderRes.renderDurationMs,
        audioBranches: renderRes.audioBranches,
        hasAudio: renderRes.inspection?.hasAudio ?? Boolean(renderRes.audioCodec || (renderRes.audioBranches && renderRes.audioBranches.length > 0)),
        maxVolumeDb: renderRes.inspection?.maxVolumeDb ?? null,
        videoCodec: renderRes.videoCodec ?? renderRes.inspection?.videoCodec ?? null,
        audioCodec: renderRes.audioCodec ?? renderRes.inspection?.audioCodec ?? null,
      });

      updateDiagnosticStep('VIDEO_RENDERING_STARTED', 'success');
      updateDiagnosticStep('VIDEO_BLOB_CREATED', 'success');
      updateDiagnosticStep('EXPORT_COMPLETED', 'success');

      const reloaded = await localProjectService.getProject(targetProj.id);
      if (reloaded) {
        onProjectUpdated(reloaded);
        setPreviewMode('rendered');
        void verifyExportedFile(renderRes.url);
      }
    } catch (err) {
      const errObj = err instanceof Error ? err : new Error(String(err));
      updateDiagnosticStep('VIDEO_RENDERING_STARTED', 'error', errObj.message, errObj.stack);
      setErrorMsg(errObj.message);
    } finally {
      setStarting(false);
    }
  };

  const handleCancelExport = () => {
    const cancelled = localProjectService.cancelLocalExport(project.id);
    if (cancelled) {
      setActiveJob((prev) =>
        prev
          ? {
              ...prev,
              status: 'failed',
              stage: 'Cancelling export...',
              etaSeconds: null,
            }
          : null
      );
    }
  };

  const isRendering =
    activeJob && (activeJob.status === 'queued' || activeJob.status === 'processing');

  // Validation Checks summary
  const hasVideo = Boolean(project.sourceVideoUrl && project.metadata);
  const dubbingReady = Boolean(
    project.voice.enabled &&
      (project.voice.fullDubUrl ||
        (Array.isArray(project.voice.generatedClips) &&
          project.voice.generatedClips.some((c) => Boolean(c.audioUrl))))
  );
  const narrationAudit = project.voice.syncPlan?.narrationAudit;
  const incompleteNarration = Boolean(
    settings.applyDubbing && dubbingReady && narrationAudit && !narrationAudit.isComplete
  );
  const activeFxCount = (project.videoEffects?.effects || []).filter((e) => e.enabled).length;
  const filterPreset = project.videoEffects?.filterPreset || 'none';
  const hasCaptions = project.captions.length > 0;
  const captionsWillBurn = settings.applyCaptions && hasCaptions;
  const missingTranslatedCount = countMissingTranslations(project.captions);
  const missingTranslatedWarning = Boolean(
    captionsWillBurn && project.subtitleStyle.enabled && missingTranslatedCount > 0
  );

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header & Prominent Generation Button */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <h1 className="text-2xl font-display font-bold tracking-tight text-white">
            Export Video
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            Preview, choose resolution &amp; aspect ratio, and render your MP4.
          </p>
        </div>

        {/* Prominent Export & Cancel Buttons */}
        <div className="flex items-center gap-2.5 shrink-0">
          {(isRendering || starting) && (
            <button
              type="button"
              onClick={handleCancelExport}
              className="px-4 py-3 rounded-xl bg-red-500/15 hover:bg-red-500/25 border border-red-500/40 text-sm font-semibold text-red-200 flex items-center gap-2 whitespace-nowrap cursor-pointer transition-colors"
            >
              <XCircle className="w-4 h-4 text-red-400" />
              Cancel Export
            </button>
          )}
          <button
            type="button"
            onClick={handleGenerateFinalVideo}
            disabled={!hasVideo || Boolean(isRendering) || starting}
            className="px-6 py-3 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-sm font-bold text-white flex items-center gap-2.5 whitespace-nowrap shrink-0 shadow-lg shadow-violet-600/30 cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98]"
          >
            {isRendering || starting ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Flame className="w-5 h-5 text-amber-300" />
            )}
            {isRendering
              ? `Rendering (${Math.round(activeJob?.progress || 0)}%)...`
              : 'Export Final MP4'}
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="p-3.5 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-200 flex items-center gap-2.5">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {missingMediaList.length > 0 && (
        <div className="p-3.5 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-200 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold text-red-100">Missing Local Media Diagnostics</div>
            <ul className="list-disc pl-4 mt-1 space-y-0.5 text-red-200/90">
              {missingMediaList.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {incompleteNarration && narrationAudit && (
        <div className="p-3.5 rounded-lg bg-amber-500/10 border border-amber-500/35 text-xs text-amber-200 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold">Incomplete narration:</span>{' '}
            {narrationAudit.summary} Review Voice settings before exporting.
          </div>
        </div>
      )}

      {missingTranslatedWarning && (
        <div className="p-3.5 rounded-lg bg-amber-500/10 border border-amber-500/35 text-xs text-amber-200 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold">
              {missingTranslatedCount} segment(s) are missing translations.
            </span>{' '}
            Add translated lines in Audio → Script before burning captions.
          </div>
        </div>
      )}

      {/* Slim Summary Strip */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="px-2.5 py-1 rounded-lg bg-[#111115] border border-white/[0.08] text-zinc-300 flex items-center gap-1.5">
          <Film className="w-3.5 h-3.5 text-zinc-400" />
          {project.metadata
            ? `${project.metadata.width}×${project.metadata.height} · ${formatDurationShort(project.metadata.duration)}`
            : 'No source video'}
        </span>
        <span className="px-2.5 py-1 rounded-lg bg-[#111115] border border-white/[0.08] text-zinc-300 flex items-center gap-1.5">
          <Mic className="w-3.5 h-3.5 text-zinc-400" />
          {settings.applyDubbing && dubbingReady
            ? `Dubbed (${project.voice.targetLanguage})`
            : 'Original Audio'}
        </span>
        <span className="px-2.5 py-1 rounded-lg bg-[#111115] border border-white/[0.08] text-zinc-300 flex items-center gap-1.5">
          <Palette className="w-3.5 h-3.5 text-zinc-400" />
          {`${resolvedDims.width}×${resolvedDims.height} · ${filterPreset !== 'none' ? filterPreset : 'Natural'}${activeFxCount > 0 ? ` +${activeFxCount} FX` : ''}`}
        </span>
        <span className="px-2.5 py-1 rounded-lg bg-[#111115] border border-white/[0.08] text-zinc-300 flex items-center gap-1.5">
          <Type className="w-3.5 h-3.5 text-zinc-400" />
          {captionsWillBurn ? `Captions: ${project.captions.length}` : 'Captions Off'}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Output & Pipeline Operations */}
        <div className="lg:col-span-5 space-y-4">
          <div className="p-5 rounded-xl bg-[#111115] border border-white/[0.08] space-y-4">
            <h2 className="text-sm font-display font-semibold text-white">Format & Dimensions</h2>

            <div className="space-y-1.5">
              <label className="text-xs text-zinc-400">Aspect Ratio</label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                {(
                  [
                    ['original', 'Original'],
                    ['16:9', '16:9'],
                    ['9:16', '9:16'],
                    ['1:1', '1:1'],
                    ['4:5', '4:5 IG'],
                    ['3:4', '3:4'],
                    ['custom', 'Custom'],
                  ] as const
                ).map(([ratio, label]) => (
                  <button
                    key={ratio}
                    type="button"
                    onClick={() => void updateSettings({ aspectRatio: ratio })}
                    className={`py-2 px-2 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                      settings.aspectRatio === ratio
                        ? 'bg-violet-600 text-white'
                        : 'bg-[#18181D] text-zinc-300 hover:bg-zinc-800 border border-white/[0.06]'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-zinc-400">Resolution</label>
              <div className="grid grid-cols-3 gap-2">
                {(['480p', '720p', '1080p'] as const).map((res) => (
                  <button
                    key={res}
                    type="button"
                    onClick={() => void updateSettings({ resolution: res })}
                    className={`py-2 px-2 rounded-lg text-xs font-mono font-medium transition-colors cursor-pointer ${
                      settings.resolution === res
                        ? 'bg-violet-600 text-white'
                        : 'bg-[#18181D] text-zinc-300 hover:bg-zinc-800 border border-white/[0.06]'
                    }`}
                  >
                    {res}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs text-zinc-400">Export Speed</label>
                <span className="text-[11px] font-mono text-zinc-500">
                  {resolveExportSpeedPreset(settings.speedProfile).ffmpegPreset} · CRF{' '}
                  {resolveExportSpeedPreset(settings.speedProfile).crf}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ['fast', 'Fast', 'Max speed'],
                    ['balanced', 'Balanced', 'Default'],
                    ['high-quality', 'High Quality', 'Best detail'],
                  ] as Array<[ExportSpeedProfile, string, string]>
                ).map(([profile, label, hint]) => {
                  const active = (settings.speedProfile || 'balanced') === profile;
                  return (
                    <button
                      key={profile}
                      type="button"
                      onClick={() => void updateSettings({ speedProfile: profile })}
                      className={`py-1.5 px-2 rounded-lg text-left transition-colors cursor-pointer ${
                        active
                          ? 'bg-violet-600 text-white'
                          : 'bg-[#18181D] text-zinc-300 hover:bg-zinc-800 border border-white/[0.06]'
                      }`}
                    >
                      <div className="text-xs font-medium leading-tight">{label}</div>
                      <div
                        className={`text-[10px] leading-tight mt-0.5 ${
                          active ? 'text-violet-100/90' : 'text-zinc-500'
                        }`}
                      >
                        {hint}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-zinc-400">Framing Fit</label>
                <select
                  value={settings.fitMode}
                  onChange={(e) =>
                    void updateSettings({
                      fitMode: e.target.value as ExportSettings['fitMode'],
                    })
                  }
                  className="mt-1 w-full bg-[#18181D] border border-white/[0.08] rounded-lg px-2.5 py-2 text-xs text-zinc-100"
                >
                  <option value="crop">Smart Center Crop</option>
                  <option value="blur-pad">Blurred Fill</option>
                  <option value="letterbox">Letterbox Fit</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-zinc-400">Codec &amp; Container</label>
                <div className="mt-1 bg-[#18181D] border border-white/[0.08] rounded-lg px-2.5 py-2 text-xs font-mono text-zinc-300 truncate" title={detectedFormatLabel}>
                  {detectedFormatLabel}
                </div>
              </div>
            </div>

            {/* Estimated & Actual Size + Target Encoding Profile */}
            <div className="p-3 rounded-lg bg-[#09090B] border border-white/[0.08] space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-zinc-400">Estimated Output Size</span>
                <span className="font-mono font-semibold text-violet-300 tabular-nums">
                  ~{formatBytes(sizeEstimate.estimatedBytes)}{' '}
                  <span className="text-[11px] font-normal text-zinc-500">
                    ({formatBytes(sizeEstimate.minBytes)}–{formatBytes(sizeEstimate.maxBytes)})
                  </span>
                </span>
              </div>
              {project.lastExportSize ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-zinc-400">Actual Export Size</span>
                  <span className="font-mono font-semibold text-emerald-300 tabular-nums">
                    {formatBytes(project.lastExportSize)}
                    {sizeEstimate.durationSec > 0 && (
                      <span className="text-[11px] font-normal text-zinc-400">
                        {' '}·{' '}
                        {(
                          (project.lastExportSize * 8) /
                          Math.max(0.5, videoMetaInfo?.dur || sizeEstimate.durationSec) /
                          1_000_000
                        ).toFixed(2)}{' '}
                        Mbps avg
                      </span>
                    )}
                  </span>
                </div>
              ) : null}
              <div className="pt-1.5 border-t border-white/[0.06] text-[11px] font-mono text-zinc-400 flex flex-wrap items-center justify-between gap-1">
                <span>
                  {sizeEstimate.width}×{sizeEstimate.height} · {sizeEstimate.targetFps} FPS · H.264 CRF {sizeEstimate.crf} (≤{(sizeEstimate.targetVideoMaxrateKbps / 1000).toFixed(1)} Mbps)
                </span>
                <span>
                  {sizeEstimate.hasAnyAudio
                    ? `AAC ${sizeEstimate.targetAudioBitrateKbps} kbps · 44.1 kHz`
                    : 'Video only'}
                </span>
              </div>
              {sizeEstimate.isStaticVisualMode && (
                <div className="text-[11px] text-emerald-300/90">
                  Static background detected — CRF {sizeEstimate.crf} skips unchanged frames for minimal size without lowering {sizeEstimate.height}p sharpness.
                </div>
              )}
            </div>
          </div>

          {/* Export Layers & Options (Collapsed by default) */}
          <CollapsibleSection
            title="Included Layers & Audio"
            subtitle="Choose which edits, overlays & audio tracks to render"
            badge={`${[
              settings.applyVideoEffects,
              settings.applyBlur,
              settings.applyLogo,
              settings.applyCaptions,
              settings.applyDubbing,
              settings.applyAudioMix,
            ].filter(Boolean).length}/6`}
            defaultOpen={false}
          >
            <div className="space-y-2 text-xs">
              {[
                {
                  key: 'applyVideoEffects' as const,
                  label: 'Filters & Visual Effects',
                  count: `${filterPreset !== 'none' ? filterPreset : 'Natural'}${activeFxCount > 0 ? ` +${activeFxCount} FX` : ''}`,
                },
                {
                  key: 'applyBlur' as const,
                  label: 'Blur Zones',
                  count: `${project.blurs.filter((b) => b.enabled).length} active`,
                },
                {
                  key: 'applyLogo' as const,
                  label: 'Logo & Watermark Overlays',
                  count: `${project.logos.filter((l) => l.enabled).length} active`,
                },
                {
                  key: 'applyCaptions' as const,
                  label: 'Burn Styled Captions',
                  count: `${project.captions.length} lines`,
                },
                {
                  key: 'applyDubbing' as const,
                  label: 'AI Narration Dub Track',
                  count: dubbingReady ? 'Ready' : 'Off',
                },
                {
                  key: 'applyAudioMix' as const,
                  label: 'Audio Fades & Music Mix',
                  count: project.voice.bgMusicFilename || 'Balance',
                },
              ].map((op) => (
                <label
                  key={op.key}
                  className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-[#18181D] border border-white/[0.06] cursor-pointer hover:border-white/[0.12] transition-colors"
                >
                  <div className="flex items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={Boolean(settings[op.key])}
                      onChange={(e) => void updateSettings({ [op.key]: e.target.checked })}
                      className="accent-violet-500 rounded"
                    />
                    <span className="text-zinc-200">{op.label}</span>
                  </div>
                  <span className="text-[11px] font-mono text-zinc-500">{op.count}</span>
                </label>
              ))}
            </div>
          </CollapsibleSection>
        </div>

        {/* Right: Active Progress + Final Functional Preview & Download */}
        <div className="lg:col-span-7 space-y-4">
          {activeJob && (
            <div className="p-5 rounded-xl bg-[#111115] border border-white/[0.08] space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-medium text-white">
                  {activeJob.status === 'completed' ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  ) : activeJob.status === 'failed' ? (
                    <AlertCircle className="w-4 h-4 text-red-400" />
                  ) : (
                    <Loader2 className="w-4 h-4 text-violet-400 animate-spin" />
                  )}
                  <span>{activeJob.stage}</span>
                </div>
                <span className="font-mono text-sm text-violet-300 tabular-nums">
                  {Math.round(activeJob.progress)}%
                </span>
              </div>

              <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-300 ${
                    activeJob.status === 'failed'
                      ? 'bg-red-500'
                      : activeJob.status === 'completed'
                      ? 'bg-emerald-500'
                      : 'bg-violet-500'
                  }`}
                  style={{ width: `${activeJob.progress}%` }}
                />
              </div>

              <div className="flex items-center justify-between text-xs text-zinc-400 font-mono tabular-nums">
                <span>Job {activeJob.id.slice(0, 8)}</span>
                <span>
                  {activeJob.etaSeconds !== null && activeJob.status === 'processing'
                    ? `Estimated remaining: ${formatDurationShort(activeJob.etaSeconds)}`
                    : activeJob.status === 'completed' && activeJob.outputSize
                    ? `Finished size: ${formatBytes(activeJob.outputSize)}`
                    : ''}
                </span>
              </div>

              {activeJob.error && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-200">
                  {activeJob.error}
                </div>
              )}
            </div>
          )}

          {/* Final Video & Draft Preview First */}
          <div className="p-5 rounded-xl bg-[#111115] border border-white/[0.08] space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-display font-semibold text-white">
                  {previewMode === 'rendered'
                    ? 'Final Rendered Video Output'
                    : 'Draft Editing Preview'}
                </h2>
                <p className="text-xs text-zinc-400">
                  {previewMode === 'rendered' && project.lastExportUrl
                    ? `Verified ${project.lastExportUrl.toLowerCase().endsWith('.webm') ? 'WebM (Canvas Fallback)' : 'MP4 (H.264 / AAC)'} output encoded locally in your browser.`
                    : 'Real-time workspace preview — click Export Final MP4 to encode locally in browser.'}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center bg-zinc-900 border border-white/[0.08] rounded-lg p-0.5 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setPreviewMode('rendered')}
                    className={`px-2.5 py-1 rounded-md font-medium transition-colors cursor-pointer ${
                      previewMode === 'rendered'
                        ? 'bg-violet-600 text-white'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {project.lastExportUrl?.toLowerCase().endsWith('.webm')
                      ? 'Final Exported WebM'
                      : 'Final Exported MP4'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewMode('draft')}
                    className={`px-2.5 py-1 rounded-md font-medium transition-colors cursor-pointer flex items-center gap-1 ${
                      previewMode === 'draft'
                        ? 'bg-amber-500/25 text-amber-200'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <Eye className="w-3 h-3" />
                    Draft Preview
                  </button>
                </div>

                {project.sourceVideoUrl && (
                  <button
                    type="button"
                    disabled={downloadingTarget !== null}
                    onClick={() => {
                      if (!project.sourceVideoUrl) return;
                      setDownloadingTarget('original');
                      setErrorMsg(null);
                      void downloadProjectAsset({
                        url: project.sourceVideoUrl,
                        cloudAssets: project.cloudAssets,
                        filename:
                          project.sourceFilename ||
                          `${project.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_original.mp4`,
                      })
                        .catch((err) =>
                          setErrorMsg(err instanceof Error ? err.message : String(err))
                        )
                        .finally(() => setDownloadingTarget(null));
                    }}
                    className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-xs font-medium text-zinc-100 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {downloadingTarget === 'original' ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Download className="w-3.5 h-3.5" />
                    )}
                    Download Original
                  </button>
                )}

                {project.lastExportUrl && (
                  <button
                    type="button"
                    disabled={exportValidation !== 'valid' || downloadingTarget !== null}
                    onClick={() => {
                      if (!project.lastExportUrl) return;
                      setDownloadingTarget('final');
                      setErrorMsg(null);
                      updateDiagnosticStep('DOWNLOAD_STARTED', 'running');
                      const ext = project.lastExportUrl.endsWith('.webm') ? 'webm' : 'mp4';
                      void downloadProjectAsset({
                        url: project.lastExportUrl,
                        cloudAssets: project.cloudAssets,
                        filename: `${project.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_final.${ext}`,
                      })
                        .then(() => {
                          updateDiagnosticStep('DOWNLOAD_STARTED', 'success');
                        })
                        .catch((err) => {
                          const errObj = err instanceof Error ? err : new Error(String(err));
                          updateDiagnosticStep('DOWNLOAD_STARTED', 'error', errObj.message, errObj.stack);
                          setErrorMsg(errObj.message);
                        })
                        .finally(() => setDownloadingTarget(null));
                    }}
                    className={`px-4 py-2 rounded-lg text-xs font-bold text-white flex items-center gap-2 whitespace-nowrap shadow-sm ${
                      exportValidation === 'valid'
                        ? 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-600/30 cursor-pointer'
                        : 'bg-zinc-800 text-zinc-500 cursor-not-allowed opacity-60'
                    }`}
                  >
                    {downloadingTarget === 'final' ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Download className="w-4 h-4" />
                    )}
                    {exportValidation === 'valid'
                      ? `Download Final Video (${formatBytes(project.lastExportSize)})`
                      : exportValidation === 'checking'
                      ? 'Verifying Video...'
                      : 'Video Unavailable'}
                  </button>
                )}
              </div>
            </div>

            {/* Post-Render Cloud Storage Verification & Upload Bar */}
            {project.lastExportUrl && (
              <div className="p-3 rounded-lg bg-[#09090B] border border-white/[0.08] space-y-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Cloud
                      className={`w-4 h-4 shrink-0 ${
                        project.cloudAssets?.[project.lastExportUrl.split('?')[0]]?.verified
                          ? 'text-emerald-400'
                          : 'text-amber-400'
                      }`}
                    />
                    <span className="font-medium text-zinc-200">
                      {cloudUploading
                        ? cloudUploadStage || 'Uploading Final MP4 to Supabase Free Cloud...'
                        : project.cloudAssets?.[project.lastExportUrl.split('?')[0]]?.verified
                        ? `Final MP4 Cloud Verified (${formatBytes(
                            project.cloudAssets[project.lastExportUrl.split('?')[0]]
                              .verifiedSizeBytes || project.lastExportSize
                          )}) · Accessible on all devices`
                        : 'Final MP4 not yet verified in cloud storage'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {cloudUploading ? (
                      <button
                        type="button"
                        onClick={() => cloudUploadAbortRef.current?.abort()}
                        className="px-2.5 py-1 rounded bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 text-red-200 text-[11px] font-medium flex items-center gap-1 cursor-pointer"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        Cancel Upload
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void uploadFinalMp4ToCloud(project)}
                        className="px-2.5 py-1 rounded bg-violet-600/80 hover:bg-violet-500 text-white text-[11px] font-medium flex items-center gap-1 cursor-pointer"
                      >
                        {cloudUploadError ? (
                          <RotateCcw className="w-3 h-3" />
                        ) : (
                          <Cloud className="w-3 h-3" />
                        )}
                        {cloudUploadError ? 'Retry Cloud Upload' : 'Upload Final MP4 to Cloud'}
                      </button>
                    )}
                  </div>
                </div>
                {cloudUploading && cloudUploadPct !== null && (
                  <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                    <div
                      className="h-full bg-violet-500 transition-all"
                      style={{ width: `${cloudUploadPct}%` }}
                    />
                  </div>
                )}
                {cloudUploadError && (
                  <div className="text-[11px] text-amber-300">{cloudUploadError}</div>
                )}
              </div>
            )}

            {previewMode === 'draft' ? (
              <div className="space-y-2.5">
                <div className="px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 flex items-center justify-between gap-2">
                  <span className="font-semibold">
                    DRAFT PREVIEW — NOT FINAL EXPORT
                  </span>
                  <span className="text-[11px] text-amber-200/80 font-mono">
                    Interactive live layers preview
                  </span>
                </div>
                <VideoStudioPlayer
                  project={project}
                  currentTime={draftTime}
                  onTimeUpdate={setDraftTime}
                  videoRef={draftVideoRef}
                  previewEffects={draftEffects}
                  onTogglePreviewEffects={setDraftEffects}
                  drawMode="none"
                  customFonts={customFonts}
                  readOnlyPreview={true}
                />
              </div>
            ) : project.lastExportUrl ? (
              <div className="space-y-2.5">
                {exportValidation === 'checking' && (
                  <div className="py-12 flex flex-col items-center justify-center gap-2 rounded-xl bg-[#09090B] border border-white/[0.06] text-xs text-zinc-400">
                    <Loader2 className="w-5 h-5 text-violet-400 animate-spin" />
                    <span>Verifying rendered MP4 stream (local or cloud)...</span>
                  </div>
                )}

                {exportValidation === 'error' && (
                  <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                      <div>
                        <div className="font-semibold">Final Video Preview Error</div>
                        <div className="text-red-200/80 mt-0.5">{exportValidationMsg}</div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void verifyExportedFile(project.lastExportUrl)}
                      className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-100 font-medium flex items-center gap-1.5 shrink-0 cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Retry Check
                    </button>
                  </div>
                )}

                {exportValidation === 'valid' && resolvedExportUrl && (
                  <>
                    <div
                      className="rounded-xl overflow-hidden bg-black border border-white/[0.08] shadow-2xl mx-auto flex items-center justify-center"
                      style={{
                        aspectRatio: `${resolvedDims.width} / ${resolvedDims.height}`,
                        maxHeight: '460px',
                        maxWidth: '100%',
                      }}
                    >
                      <video
                        ref={finalVideoRef}
                        key={`${resolvedExportUrl}_${project.lastExportedAt || ''}`}
                        src={resolvedExportUrl}
                        controls
                        playsInline
                        preload="metadata"
                        onLoadedMetadata={(e) => {
                          const v = e.currentTarget;
                          setVideoMetaInfo({
                            w: v.videoWidth,
                            h: v.videoHeight,
                            dur: v.duration,
                          });
                        }}
                        onError={() => {
                          setExportValidation('error');
                          setExportValidationMsg(
                            'Browser could not decode the rendered MP4 stream. Please click Export Final MP4 to re-encode.'
                          );
                        }}
                        className="w-full h-full object-contain bg-black"
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-zinc-400 px-1 tabular-nums">
                      <span>
                        {videoMetaInfo
                          ? `${videoMetaInfo.w}×${videoMetaInfo.h} · ${formatDurationShort(
                              videoMetaInfo.dur
                            )} · ${sizeEstimate.targetFps} FPS`
                          : `${resolvedDims.width}×${resolvedDims.height} · ${sizeEstimate.targetFps} FPS`}
                      </span>
                      <span>
                        {project.lastExportSize
                          ? `Actual: ${formatBytes(project.lastExportSize)} (${(
                              (project.lastExportSize * 8) /
                              Math.max(0.5, videoMetaInfo?.dur || sizeEstimate.durationSec) /
                              1_000_000
                            ).toFixed(2)} Mbps) · Est: ~${formatBytes(sizeEstimate.estimatedBytes)}`
                          : `Est: ~${formatBytes(sizeEstimate.estimatedBytes)}`}{' '}
                        ·{' '}
                        {project.lastExportUrl?.toLowerCase().endsWith('.webm')
                          ? 'WebM'
                          : sizeEstimate.hasAnyAudio
                          ? `H.264 / AAC ${sizeEstimate.targetAudioBitrateKbps}k`
                          : 'H.264'}
                      </span>
                    </div>
                    {renderSummary && (
                      <div className="flex flex-wrap items-center gap-2 px-2.5 py-2 rounded-lg bg-[#09090B] border border-white/[0.06] text-[11px] font-mono text-zinc-300">
                        <span className="text-emerald-400">
                          {renderSummary.streamCopied
                            ? 'Stream Copy (-c:v copy)'
                            : renderSummary.engine === 'webcodecs-hardware'
                            ? 'WebCodecs Hardware H.264'
                            : renderSummary.engine === 'webcodecs-software'
                            ? 'WebCodecs Software H.264'
                            : renderSummary.multiThreaded
                            ? 'FFmpeg WASM (Multi-thread)'
                            : renderSummary.engine === 'canvas-mediarecorder'
                            ? 'Canvas Fallback'
                            : 'FFmpeg WASM'}
                        </span>
                        {renderSummary.bitrateControl === 'vbr-bitrate' && (
                          <span className="text-zinc-400">
                            · {(renderSummary.targetVideoKbps || sizeEstimate.targetVideoKbps) / 1000} Mbps VBR
                          </span>
                        )}
                        {renderSummary.bitrateControl === 'crf' && !renderSummary.streamCopied && (
                          <span className="text-zinc-400">· CRF {sizeEstimate.crf}</span>
                        )}
                        {typeof renderSummary.renderDurationMs === 'number' && (
                          <span className="text-zinc-500">· {(renderSummary.renderDurationMs / 1000).toFixed(1)}s</span>
                        )}
                        {typeof renderSummary.staticFramesReused === 'number' && renderSummary.staticFramesReused > 0 && (
                          <span className="text-sky-300">· {renderSummary.staticFramesReused} static reused</span>
                        )}
                        {typeof renderSummary.peakHeapMb === 'number' && (
                          <span className="text-zinc-500">· {renderSummary.peakHeapMb} MB heap</span>
                        )}
                        {renderSummary.hasAudio !== undefined && (
                          <span className={renderSummary.hasAudio ? 'text-emerald-300' : 'text-zinc-400'}>
                            · Audio: {renderSummary.hasAudio ? `${renderSummary.audioCodec || 'aac'}${renderSummary.maxVolumeDb !== null && renderSummary.maxVolumeDb !== undefined ? ` (peak ${renderSummary.maxVolumeDb.toFixed(1)} dB)` : ''}` : 'None'}
                          </span>
                        )}
                        {renderSummary.audioBranches && renderSummary.audioBranches.length > 0 && (
                          <span className="text-violet-300">
                            · Tracks: {renderSummary.audioBranches.join(', ')}
                          </span>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : (
              <div className="py-12 text-center space-y-3 rounded-xl bg-[#09090B] border border-white/[0.06]">
                <Film className="w-8 h-8 text-zinc-700 mx-auto" />
                <div className="text-sm font-semibold text-zinc-200">
                  No Export Rendered Yet
                </div>
                <p className="text-xs text-zinc-500 max-w-md mx-auto leading-relaxed">
                  Click <strong>Export Final MP4</strong> above to render your video, or use{' '}
                  <strong>Draft Preview</strong> to check your edits.
                </p>
              </div>
            )}
          </div>

          <CollapsibleSection
            title="Narration & Timeline Sync"
            subtitle="Choose continuous, balanced, or original pacing"
            badge={project.voice.syncMode || 'flexible'}
            defaultOpen={false}
          >
            <TimelineSyncCard project={project} onProjectUpdated={onProjectUpdated} compact />
          </CollapsibleSection>

          <CollapsibleSection
            title="TikTok Thumbnail Studio"
            subtitle="Generate & download 5 cover designs"
            defaultOpen={false}
          >
            <TikTokThumbnailEditor
              project={project}
              customFonts={customFonts}
              onProjectUpdated={onProjectUpdated}
            />
          </CollapsibleSection>

          {jobs.length > 0 && (
            <CollapsibleSection
              title="Render History"
              badge={String(jobs.length)}
              defaultOpen={false}
            >
              <div className="divide-y divide-white/[0.06] text-xs">
                {jobs.slice(0, 6).map((j) => (
                  <div key={j.id} className="py-2.5 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      {j.status === 'completed' ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      ) : j.status === 'failed' ? (
                        <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                      ) : (
                        <Clock className="w-3.5 h-3.5 text-violet-400 shrink-0" />
                      )}
                      <span className="truncate text-zinc-200">{j.stage}</span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 font-mono tabular-nums">
                      <span className="text-zinc-400">{Math.round(j.progress)}%</span>
                      {j.outputUrl && (
                        <button
                          type="button"
                          onClick={() => {
                            const ext = j.outputUrl!.toLowerCase().endsWith('.webm') ? 'webm' : 'mp4';
                            void downloadProjectAsset({
                              url: j.outputUrl!,
                              cloudAssets: project.cloudAssets,
                              filename: `${project.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_final.${ext}`,
                            }).catch((err) => setErrorMsg(err instanceof Error ? err.message : String(err)));
                          }}
                          className="text-violet-400 hover:text-violet-300 font-medium cursor-pointer"
                        >
                          Download {j.outputUrl.toLowerCase().endsWith('.webm') ? 'WebM' : 'MP4'}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CollapsibleSection>
          )}

          <CollapsibleSection
            title="Export Diagnostics & Step Audit"
            subtitle="Live audit trail of all 11 export pipeline steps & stack traces"
            badge={`${diagnosticSteps.filter((s) => s.status === 'success').length}/11`}
            defaultOpen={true}
          >
            <div className="space-y-3 text-xs">
              <div className="flex items-center justify-between text-zinc-400 pb-2 border-b border-white/[0.06]">
                <span>Pipeline Step Name</span>
                <span>Status &amp; Timestamp</span>
              </div>
              <div className="space-y-2">
                {diagnosticSteps.map((step) => (
                  <div
                    key={step.id}
                    className={`p-3 rounded-lg border flex flex-col gap-1.5 ${
                      step.status === 'success'
                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
                        : step.status === 'error'
                        ? 'bg-red-500/10 border-red-500/30 text-red-200'
                        : step.status === 'running'
                        ? 'bg-violet-500/10 border-violet-500/30 text-violet-200 animate-pulse'
                        : 'bg-[#18181D] border-white/[0.06] text-zinc-400'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 font-mono font-medium">
                        {step.status === 'success' && <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />}
                        {step.status === 'error' && <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />}
                        {step.status === 'running' && <Loader2 className="w-4 h-4 text-violet-400 animate-spin shrink-0" />}
                        {step.status === 'pending' && <Clock className="w-4 h-4 text-zinc-600 shrink-0" />}
                        <span>{step.label}</span>
                      </div>
                      <span className="font-mono text-[11px] opacity-80">
                        {step.time ? `${step.status.toUpperCase()} @ ${step.time}` : step.status.toUpperCase()}
                      </span>
                    </div>
                    {step.error && (
                      <div className="mt-1 p-2 rounded bg-red-950/40 border border-red-500/40 text-[11px] font-mono text-red-200 space-y-1">
                        <div><strong className="text-red-400">Error:</strong> {step.error}</div>
                        {step.stack && (
                          <div className="text-[10px] text-red-300/80 whitespace-pre-wrap overflow-x-auto max-h-32">
                            {step.stack}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </CollapsibleSection>
        </div>
      </div>
    </div>
  );
}
