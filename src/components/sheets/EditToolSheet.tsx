import React, { useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Crop,
  Download,
  FileAudio,
  Film,
  FlipHorizontal2,
  FlipVertical2,
  Gauge,
  Image as ImageIcon,
  Loader2,
  Maximize,
  RotateCcw,
  RotateCw,
  Scissors,
  Trash2,
  Unlink,
  UploadCloud,
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import {
  CanvasAspectRatio,
  CanvasBackgroundType,
  CanvasCropMode,
  DEFAULT_VIDEO_CANVAS,
  Project,
  ProjectPatchFn,
  StudioElementSelection,
  StudioPreset,
  StudioPresetAssetRef,
  VideoCanvasConfig,
} from '../../types/studio';
import { api, uploadVideoChunked } from '../../lib/api';
import { formatBytes, formatDurationShort, formatTimecode } from '../../lib/formatters';
import {
  createWorkflowUpdate,
  getSyncedCaptionsForPreview,
  resolveCanvasDimensions,
  SyncedPreviewCaption,
  updateCaptionTimingWithSync,
} from '../../lib/workflowStages';
import {
  clampVideoSpeed,
  detectVideoTimelineMismatches,
  findActiveVideoClipAtTime,
  getEffectiveVideoClips,
  getVideoClipTimelineDuration,
  getVideoClipTimelineEnd,
  MAX_VIDEO_SPEED,
  MIN_VIDEO_SPEED,
  unlinkVideoClipAudio,
  updateSingleVideoClipSpeed,
  VIDEO_SPEED_PRESETS,
} from '../../lib/videoTimeline';
import { PresetLibraryPanel } from '../PresetLibraryPanel';
import { CollapsibleSection } from '../ui/CollapsibleSection';
import { StudioToolMemory } from './toolMemory';

interface EditToolSheetProps {
  project: Project;
  onProjectUpdated: (p: Project) => void;
  onPatchProject: ProjectPatchFn;
  currentTime: number;
  selectedElement: StudioElementSelection;
  onSelectElement: (el: StudioElementSelection) => void;
  cropEditMode: boolean;
  onToggleCropEditMode: (val: boolean) => void;
  onDuplicateSelected: () => void;
  onDeleteSelected: () => void;
  onSplitAtPlayhead: () => void;
  memory: StudioToolMemory;
  onUpdateMemory: (patch: Partial<StudioToolMemory>) => void;
}

export function EditToolSheet({
  project,
  onProjectUpdated,
  onPatchProject,
  currentTime,
  selectedElement,
  onSelectElement,
  cropEditMode,
  onToggleCropEditMode,
  onDuplicateSelected,
  onDeleteSelected,
  onSplitAtPlayhead,
  memory,
  onUpdateMemory,
}: EditToolSheetProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const bgFileRef = useRef<HTMLInputElement>(null);

  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [uploadStage, setUploadStage] = useState('');
  const [busyAudio, setBusyAudio] = useState(false);
  const [busyBgUpload, setBusyBgUpload] = useState(false);
  const [extractedAudio, setExtractedAudio] = useState<{
    audioUrl: string;
    downloadUrl: string;
    filename: string;
  } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const canvasConfig: VideoCanvasConfig = {
    ...DEFAULT_VIDEO_CANVAS,
    ...(project.canvas || {}),
  };
  const resolvedCanvasDims = resolveCanvasDimensions(
    canvasConfig,
    project.exportSettings,
    project.metadata
  );
  const duration = Math.max(1, project.metadata?.duration || 12);
  const srcW = Math.max(16, project.metadata?.width || 1280);
  const srcH = Math.max(16, project.metadata?.height || 720);

  const effectiveCropX =
    canvasConfig.cropWidth && canvasConfig.cropHeight
      ? Math.max(0, Math.min(srcW - 16, Math.round(canvasConfig.cropX || 0)))
      : Math.round((srcW * (canvasConfig.cropLeft || 0)) / 100);
  const effectiveCropY =
    canvasConfig.cropWidth && canvasConfig.cropHeight
      ? Math.max(0, Math.min(srcH - 16, Math.round(canvasConfig.cropY || 0)))
      : Math.round((srcH * (canvasConfig.cropTop || 0)) / 100);
  const effectiveCropW =
    canvasConfig.cropWidth && canvasConfig.cropHeight
      ? Math.max(16, Math.min(srcW - effectiveCropX, Math.round(canvasConfig.cropWidth)))
      : Math.max(
          16,
          Math.round(srcW * (1 - ((canvasConfig.cropLeft || 0) + (canvasConfig.cropRight || 0)) / 100))
        );
  const effectiveCropH =
    canvasConfig.cropWidth && canvasConfig.cropHeight
      ? Math.max(16, Math.min(srcH - effectiveCropY, Math.round(canvasConfig.cropHeight)))
      : Math.max(
          16,
          Math.round(srcH * (1 - ((canvasConfig.cropTop || 0) + (canvasConfig.cropBottom || 0)) / 100))
        );

  const updateCanvasConfig = (
    patch: Partial<VideoCanvasConfig>,
    opts?: { immediate?: boolean; syncExportAspect?: CanvasAspectRatio; undoGroupKey?: string }
  ) => {
    onPatchProject(
      project.id,
      (cur) => {
        const curCanvas: VideoCanvasConfig = {
          ...DEFAULT_VIDEO_CANVAS,
          ...(cur.canvas || {}),
        };
        const nextCanvas: VideoCanvasConfig = { ...curCanvas, ...patch };
        const nextExport = opts?.syncExportAspect
          ? { ...cur.exportSettings, aspectRatio: opts.syncExportAspect }
          : cur.exportSettings;
        const nextWorkflow = createWorkflowUpdate(cur.workflow, {
          completeStage: 'editor',
          modifiedStage: 'editor',
          hasExistingExport: Boolean(cur.lastExportUrl),
        });
        return {
          canvas: nextCanvas,
          exportSettings: nextExport,
          workflow: nextWorkflow,
        };
      },
      {
        immediate: opts?.immediate,
        debounceMs: opts?.immediate ? 0 : 220,
        undoGroupKey: opts?.immediate ? undefined : opts?.undoGroupKey ?? 'edit:canvas',
      }
    );
  };

  const applyPixelCrop = (nextX: number, nextY: number, nextW: number, nextH: number) => {
    const cw = Math.max(16, Math.min(srcW, Math.round(nextW)));
    const ch = Math.max(16, Math.min(srcH, Math.round(nextH)));
    const cx = Math.max(0, Math.min(srcW - cw, Math.round(nextX)));
    const cy = Math.max(0, Math.min(srcH - ch, Math.round(nextY)));
    updateCanvasConfig({
      cropMode:
        canvasConfig.cropMode === 'fit' || canvasConfig.cropMode === 'fill'
          ? 'crop'
          : canvasConfig.cropMode || 'crop',
      cropX: cx,
      cropY: cy,
      cropWidth: cw,
      cropHeight: ch,
      cropLeft: Number(((cx / srcW) * 100).toFixed(1)),
      cropTop: Number(((cy / srcH) * 100).toFixed(1)),
      cropRight: Number((((srcW - (cx + cw)) / srcW) * 100).toFixed(1)),
      cropBottom: Number((((srcH - (cy + ch)) / srcH) * 100).toFixed(1)),
    });
  };

  const handleUploadBgImage = async (file: File) => {
    setErrorMsg(null);
    setSuccessMsg(null);
    setBusyBgUpload(true);
    try {
      const res = await api.uploadCanvasBackground(project.id, file);
      onProjectUpdated(res.project);
      setSuccessMsg(`Uploaded background image "${res.filename}".`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyBgUpload(false);
    }
  };

  const handleReplaceVideo = async (file: File) => {
    setErrorMsg(null);
    try {
      setUploadPct(2);
      const updated = await uploadVideoChunked({
        projectId: project.id,
        file,
        onProgress: (pct, stage) => {
          setUploadPct(pct);
          setUploadStage(stage);
        },
      });
      onProjectUpdated(updated);
      setSuccessMsg(`Source video updated to "${file.name}".`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadPct(null);
      setUploadStage('');
    }
  };

  const handleExtractAudio = async () => {
    setErrorMsg(null);
    setBusyAudio(true);
    try {
      const res = await api.extractAudio(project.id);
      setExtractedAudio(res);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAudio(false);
    }
  };

  const videoClips = getEffectiveVideoClips(project);
  const selectedClipId =
    selectedElement?.kind === 'video' ? selectedElement.clipId : undefined;
  const activeVideoClip =
    (selectedClipId ? videoClips.find((c) => c.id === selectedClipId) : null) ||
    findActiveVideoClipAtTime(videoClips, currentTime)?.clip ||
    videoClips[0] ||
    null;
  const timelineMismatches = detectVideoTimelineMismatches(project);

  const updateActiveVideoClipSpeed = (speedVal: number, immediate = false) => {
    if (!activeVideoClip) return;
    const clamped = clampVideoSpeed(speedVal);
    onPatchProject(
      project.id,
      (cur) => {
        const curClips = getEffectiveVideoClips(cur);
        return {
          videoClips: updateSingleVideoClipSpeed(curClips, activeVideoClip.id, clamped),
          workflow: createWorkflowUpdate(cur.workflow, {
            completeStage: 'editor',
            modifiedStage: 'editor',
            hasExistingExport: Boolean(cur.lastExportUrl),
          }),
        };
      },
      {
        immediate,
        debounceMs: immediate ? 0 : 180,
        undoGroupKey: immediate ? undefined : `vspeed:${activeVideoClip.id}`,
      }
    );
  };

  const updateActiveVideoClipPatch = (
    patch: Partial<{ timelineStart: number; sourceStart: number; sourceEnd: number }>,
    immediate = false
  ) => {
    if (!activeVideoClip) return;
    onPatchProject(
      project.id,
      (cur) => {
        const srcDur = Math.max(0.5, cur.metadata?.duration || 12);
        const curClips = getEffectiveVideoClips(cur);
        return {
          videoClips: curClips
            .map((vc) => {
              if (vc.id !== activeVideoClip.id) return vc;
              const nextSrcStart = Math.max(
                0,
                Math.min(srcDur - 0.1, patch.sourceStart ?? vc.sourceStart)
              );
              const nextSrcEnd = Math.max(
                nextSrcStart + 0.1,
                Math.min(srcDur, patch.sourceEnd ?? vc.sourceEnd)
              );
              const nextTlStart = Math.max(0, patch.timelineStart ?? vc.timelineStart);
              return {
                ...vc,
                sourceStart: Number(nextSrcStart.toFixed(3)),
                sourceEnd: Number(nextSrcEnd.toFixed(3)),
                timelineStart: Number(nextTlStart.toFixed(3)),
              };
            })
            .sort((a, b) => a.timelineStart - b.timelineStart),
          workflow: createWorkflowUpdate(cur.workflow, {
            completeStage: 'editor',
            modifiedStage: 'editor',
            hasExistingExport: Boolean(cur.lastExportUrl),
          }),
        };
      },
      {
        immediate,
        debounceMs: immediate ? 0 : 200,
        undoGroupKey: `vtrim:${activeVideoClip.id}`,
      }
    );
  };

  const handleUnlinkSelectedClipAudio = () => {
    if (!activeVideoClip) return;
    onPatchProject(
      project.id,
      (cur) => {
        const res = unlinkVideoClipAudio(cur, activeVideoClip.id, uuidv4);
        return {
          videoClips: res.videoClips,
          originalAudioClips: res.originalAudioClips,
          workflow: createWorkflowUpdate(cur.workflow, {
            completeStage: 'editor',
            modifiedStage: 'editor',
            hasExistingExport: Boolean(cur.lastExportUrl),
          }),
        };
      },
      { immediate: true }
    );
    setSuccessMsg(`Separated original audio from "${activeVideoClip.label || 'Video Clip'}" onto independent 1.0x track.`);
  };

  // Determine currently active timed element (Blur, Logo, Extra Text, or Caption Segment at playhead)
  const activeBlur =
    selectedElement?.kind === 'blur'
      ? project.blurs.find((b) => b.id === selectedElement.id) || null
      : null;
  const activeLogo =
    selectedElement?.kind === 'logo'
      ? project.logos.find((l) => l.id === selectedElement.id) || null
      : null;
  const activeExtraEl =
    selectedElement?.kind === 'caption-element'
      ? (project.subtitleStyle.extraElements || []).find((el) => el.id === selectedElement.id) || null
      : null;
  const syncedCaptions = getSyncedCaptionsForPreview(project);
  const activeCaptionSeg: SyncedPreviewCaption | null =
    syncedCaptions.find((c) => currentTime >= c.syncedStart && currentTime <= c.syncedEnd) || null;

  const updateSelectedTiming = (patch: { start?: number; end?: number }) => {
    if (activeBlur) {
      onPatchProject(
        project.id,
        (cur) => ({
          blurs: cur.blurs.map((b) =>
            b.id === activeBlur.id
              ? {
                  ...b,
                  startTime: patch.start ?? b.startTime,
                  endTime: patch.end ?? b.endTime,
                  keyframes: undefined,
                }
              : b
          ),
          workflow: createWorkflowUpdate(cur.workflow, {
            completeStage: 'editor',
            modifiedStage: 'editor',
            hasExistingExport: Boolean(cur.lastExportUrl),
          }),
        }),
        { undoGroupKey: `timing:blur:${activeBlur.id}`, debounceMs: 220 }
      );
    } else if (activeLogo) {
      onPatchProject(
        project.id,
        (cur) => ({
          logos: cur.logos.map((l) =>
            l.id === activeLogo.id
              ? {
                  ...l,
                  permanent: false,
                  startTime: patch.start ?? l.startTime,
                  endTime: patch.end ?? l.endTime,
                }
              : l
          ),
          workflow: createWorkflowUpdate(cur.workflow, {
            completeStage: 'editor',
            modifiedStage: 'editor',
            hasExistingExport: Boolean(cur.lastExportUrl),
          }),
        }),
        { undoGroupKey: `timing:logo:${activeLogo.id}`, debounceMs: 220 }
      );
    } else if (activeExtraEl) {
      onPatchProject(
        project.id,
        (cur) => ({
          subtitleStyle: {
            ...cur.subtitleStyle,
            extraElements: (cur.subtitleStyle.extraElements || []).map((el) =>
              el.id === activeExtraEl.id
                ? {
                    ...el,
                    startTime: patch.start ?? el.startTime,
                    endTime: patch.end ?? el.endTime,
                  }
                : el
            ),
          },
          workflow: createWorkflowUpdate(cur.workflow, {
            visitStage: 'captions',
            modifiedStage: 'captions',
            hasExistingExport: Boolean(cur.lastExportUrl),
          }),
        }),
        { undoGroupKey: `timing:text:${activeExtraEl.id}`, debounceMs: 220 }
      );
    } else if (activeCaptionSeg) {
      const nextStart = patch.start ?? activeCaptionSeg.syncedStart;
      const nextEnd = patch.end ?? activeCaptionSeg.syncedEnd;
      onPatchProject(
        project.id,
        (cur) => ({
          ...updateCaptionTimingWithSync(cur, activeCaptionSeg.id, nextStart, nextEnd),
          workflow: createWorkflowUpdate(cur.workflow, {
            visitStage: 'captions',
            modifiedStage: 'captions',
            hasExistingExport: Boolean(cur.lastExportUrl),
          }),
        }),
        { undoGroupKey: `timing:cap:${activeCaptionSeg.id}`, debounceMs: 220 }
      );
    }
  };

  return (
    <div className="space-y-3">
      {/* Sub-navigation Pills */}
      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
        {(
          [
            { id: 'transform', label: 'Crop & Framing' },
            { id: 'timing', label: 'Trim, Split & Speed' },
            { id: 'background', label: 'Background Fill' },
            { id: 'media', label: 'Media & Presets' },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => onUpdateMemory({ editTab: tab.id })}
            className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 border transition-colors cursor-pointer ${
              memory.editTab === tab.id
                ? 'bg-violet-600 border-violet-500 text-white'
                : 'bg-[#18181D] border-white/[0.08] text-zinc-300 hover:text-white'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {errorMsg && (
        <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <span>{errorMsg}</span>
        </div>
      )}
      {successMsg && (
        <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-200 flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* TAB 1: CROP, ASPECT RATIO & FRAMING */}
      {memory.editTab === 'transform' && (
        <div className="space-y-3">
          {/* Quick Interactive Actions */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onToggleCropEditMode(!cropEditMode)}
              className={`min-h-[40px] flex-1 min-w-[140px] px-3 py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 border cursor-pointer transition-colors ${
                cropEditMode
                  ? 'bg-emerald-600 border-emerald-500 text-white'
                  : 'bg-[#18181D] border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/15'
              }`}
            >
              <Crop className="w-3.5 h-3.5" />
              {cropEditMode ? 'Done Cropping Video' : 'Interactive Crop Box'}
            </button>
            <button
              type="button"
              onClick={() =>
                updateCanvasConfig(
                  { videoRotation: ((canvasConfig.videoRotation ?? 0) - 90) % 360 },
                  { immediate: true }
                )
              }
              className="min-h-[40px] px-2.5 py-2 rounded-xl bg-[#18181D] border border-white/[0.08] text-xs font-medium text-zinc-200 hover:text-white flex items-center gap-1 cursor-pointer"
              title="Rotate -90°"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              -90°
            </button>
            <button
              type="button"
              onClick={() =>
                updateCanvasConfig(
                  { videoRotation: ((canvasConfig.videoRotation ?? 0) + 90) % 360 },
                  { immediate: true }
                )
              }
              className="min-h-[40px] px-2.5 py-2 rounded-xl bg-[#18181D] border border-white/[0.08] text-xs font-medium text-zinc-200 hover:text-white flex items-center gap-1 cursor-pointer"
              title="Rotate +90°"
            >
              <RotateCw className="w-3.5 h-3.5" />
              +90°
            </button>
            <button
              type="button"
              onClick={() =>
                updateCanvasConfig({ flipH: !canvasConfig.flipH }, { immediate: true })
              }
              className={`min-h-[40px] px-2.5 py-2 rounded-xl border text-xs font-medium flex items-center gap-1 cursor-pointer ${
                canvasConfig.flipH
                  ? 'bg-violet-600 border-violet-500 text-white'
                  : 'bg-[#18181D] border-white/[0.08] text-zinc-200 hover:text-white'
              }`}
              title="Flip Horizontal"
            >
              <FlipHorizontal2 className="w-3.5 h-3.5" />
              Flip H
            </button>
            <button
              type="button"
              onClick={() =>
                updateCanvasConfig({ flipV: !canvasConfig.flipV }, { immediate: true })
              }
              className={`min-h-[40px] px-2.5 py-2 rounded-xl border text-xs font-medium flex items-center gap-1 cursor-pointer ${
                canvasConfig.flipV
                  ? 'bg-violet-600 border-violet-500 text-white'
                  : 'bg-[#18181D] border-white/[0.08] text-zinc-200 hover:text-white'
              }`}
              title="Flip Vertical"
            >
              <FlipVertical2 className="w-3.5 h-3.5" />
              Flip V
            </button>
            <button
              type="button"
              onClick={() =>
                updateCanvasConfig(DEFAULT_VIDEO_CANVAS, {
                  immediate: true,
                  syncExportAspect: 'original',
                })
              }
              className="min-h-[40px] px-2.5 py-2 rounded-xl bg-zinc-900 border border-white/[0.08] text-xs text-zinc-400 hover:text-white cursor-pointer"
            >
              Reset
            </button>
          </div>

          {/* Aspect Ratio Chips */}
          <div className="p-3 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-white flex items-center gap-1.5">
                <Maximize className="w-3.5 h-3.5 text-violet-400" />
                Aspect Ratio
              </span>
              <span className="font-mono text-[11px] text-violet-300 tabular-nums">
                {resolvedCanvasDims.width} × {resolvedCanvasDims.height}
              </span>
            </div>
            <div className="grid grid-cols-4 sm:grid-cols-7 gap-1.5">
              {(
                [
                  { id: 'original', label: 'Original' },
                  { id: '9:16', label: '9:16' },
                  { id: '16:9', label: '16:9' },
                  { id: '1:1', label: '1:1' },
                  { id: '4:5', label: '4:5' },
                  { id: '3:4', label: '3:4' },
                  { id: 'custom', label: 'Custom' },
                ] as Array<{ id: CanvasAspectRatio; label: string }>
              ).map((ratio) => (
                <button
                  key={ratio.id}
                  type="button"
                  onClick={() =>
                    updateCanvasConfig(
                      { aspectRatio: ratio.id },
                      { immediate: true, syncExportAspect: ratio.id }
                    )
                  }
                  className={`min-h-[36px] py-1.5 px-1.5 rounded-lg text-[11px] font-semibold border cursor-pointer ${
                    canvasConfig.aspectRatio === ratio.id
                      ? 'bg-violet-600 border-violet-500 text-white'
                      : 'bg-zinc-900 border-white/[0.06] text-zinc-300 hover:bg-zinc-800'
                  }`}
                >
                  {ratio.label}
                </button>
              ))}
            </div>
            {canvasConfig.aspectRatio === 'custom' && (
              <div className="grid grid-cols-2 gap-2 pt-1.5">
                <div>
                  <label className="text-[10px] text-zinc-400">Width (px)</label>
                  <input
                    type="number"
                    min={240}
                    max={3840}
                    step={2}
                    value={canvasConfig.customWidth}
                    onChange={(e) =>
                      updateCanvasConfig({
                        customWidth: Math.max(240, Math.min(3840, Number(e.target.value) || 1080)),
                      })
                    }
                    className="mt-0.5 w-full bg-zinc-900 border border-white/[0.08] rounded px-2 py-1 text-xs font-mono text-zinc-100"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-zinc-400">Height (px)</label>
                  <input
                    type="number"
                    min={240}
                    max={3840}
                    step={2}
                    value={canvasConfig.customHeight}
                    onChange={(e) =>
                      updateCanvasConfig({
                        customHeight: Math.max(240, Math.min(3840, Number(e.target.value) || 1920)),
                      })
                    }
                    className="mt-0.5 w-full bg-zinc-900 border border-white/[0.08] rounded px-2 py-1 text-xs font-mono text-zinc-100"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Primary Zoom & Rotation Sliders */}
          <div className="p-3 rounded-xl bg-[#18181D] border border-white/[0.08] grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <div className="flex justify-between text-[11px] text-zinc-300">
                <span>Zoom / Scale</span>
                <span className="font-mono tabular-nums text-violet-300">
                  {Math.round(canvasConfig.zoom * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0.25}
                max={3.0}
                step={0.02}
                value={canvasConfig.zoom}
                onChange={(e) => updateCanvasConfig({ zoom: Number(e.target.value) })}
                className="mt-1.5 w-full accent-violet-500"
              />
            </div>

            <div>
              <div className="flex justify-between text-[11px] text-zinc-300">
                <span>Rotation Angle</span>
                <span className="font-mono tabular-nums text-violet-300">
                  {Math.round(canvasConfig.videoRotation ?? 0)}°
                </span>
              </div>
              <input
                type="range"
                min={-180}
                max={180}
                step={1}
                value={canvasConfig.videoRotation ?? 0}
                onChange={(e) => updateCanvasConfig({ videoRotation: Number(e.target.value) })}
                className="mt-1.5 w-full accent-violet-500"
              />
            </div>
          </div>

          {/* 7 Crop Modes */}
          <div className="p-3 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-2">
            <span className="text-xs font-semibold text-white">Framing &amp; Crop Mode</span>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
              {(
                [
                  { id: 'fit', label: 'Fit' },
                  { id: 'fill', label: 'Fill' },
                  { id: 'crop', label: 'Crop' },
                  { id: 'zoom', label: 'Zoom' },
                  { id: 'stretch', label: 'Stretch' },
                  { id: 'smart-center', label: 'Smart Center' },
                  { id: 'custom-region', label: 'Custom Box' },
                ] as Array<{ id: CanvasCropMode; label: string }>
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    const patch: Partial<VideoCanvasConfig> = { cropMode: m.id };
                    if (m.id === 'fit') {
                      patch.zoom = 1;
                      patch.offsetX = 0;
                      patch.offsetY = 0;
                    } else if (m.id === 'zoom' && (canvasConfig.zoom || 1) < 1.2) {
                      patch.zoom = 1.35;
                    }
                    updateCanvasConfig(patch, { immediate: true });
                    if (m.id === 'crop' || m.id === 'custom-region') {
                      onToggleCropEditMode(true);
                    }
                  }}
                  className={`min-h-[34px] py-1.5 px-2 rounded-lg text-[11px] font-medium border cursor-pointer ${
                    (canvasConfig.cropMode || 'fit') === m.id
                      ? 'bg-violet-600 border-violet-500 text-white'
                      : 'bg-zinc-900 border-white/[0.06] text-zinc-300 hover:bg-zinc-800'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* Advanced Framing, Edge Crop, Pixel Box & Opacity */}
          <CollapsibleSection
            title="Advanced Settings"
            subtitle="Offsets, opacity, edge crop percentages & pixel box"
            open={memory.editAdvancedOpen}
            onToggle={(open) => onUpdateMemory({ editAdvancedOpen: open })}
          >
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <div className="flex justify-between text-[11px] text-zinc-300">
                  <span>Offset X</span>
                  <span className="font-mono tabular-nums">{canvasConfig.offsetX}%</span>
                </div>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  value={canvasConfig.offsetX}
                  onChange={(e) => updateCanvasConfig({ offsetX: Number(e.target.value) })}
                  className="mt-1 w-full accent-violet-500"
                />
              </div>
              <div>
                <div className="flex justify-between text-[11px] text-zinc-300">
                  <span>Offset Y</span>
                  <span className="font-mono tabular-nums">{canvasConfig.offsetY}%</span>
                </div>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  value={canvasConfig.offsetY}
                  onChange={(e) => updateCanvasConfig({ offsetY: Number(e.target.value) })}
                  className="mt-1 w-full accent-violet-500"
                />
              </div>
              <div>
                <div className="flex justify-between text-[11px] text-zinc-300">
                  <span>Video Opacity</span>
                  <span className="font-mono tabular-nums">
                    {Math.round((canvasConfig.videoOpacity ?? 1) * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={canvasConfig.videoOpacity ?? 1}
                  onChange={(e) => updateCanvasConfig({ videoOpacity: Number(e.target.value) })}
                  className="mt-1 w-full accent-violet-500"
                />
              </div>
            </div>

            <div className="pt-2 border-t border-white/[0.06] space-y-2">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-zinc-300 font-medium">Edge Crop (%)</span>
                <button
                  type="button"
                  onClick={() =>
                    updateCanvasConfig(
                      {
                        cropMode: 'fit',
                        cropTop: 0,
                        cropRight: 0,
                        cropBottom: 0,
                        cropLeft: 0,
                        cropX: 0,
                        cropY: 0,
                        cropWidth: srcW,
                        cropHeight: srcH,
                      },
                      { immediate: true }
                    )
                  }
                  className="text-zinc-400 hover:text-white cursor-pointer"
                >
                  Clear Crop
                </button>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                {(['cropTop', 'cropBottom', 'cropLeft', 'cropRight'] as const).map((side) => (
                  <div key={side}>
                    <div className="flex justify-between text-[10.5px] text-zinc-400">
                      <span>{side.replace('crop', '')}</span>
                      <span className="font-mono tabular-nums">{canvasConfig[side]}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={45}
                      value={canvasConfig[side]}
                      onChange={(e) =>
                        updateCanvasConfig({
                          [side]: Number(e.target.value),
                          cropWidth: undefined,
                          cropHeight: undefined,
                        })
                      }
                      className="mt-1 w-full accent-violet-500"
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="pt-2 border-t border-white/[0.06]">
              <div className="text-[11px] text-zinc-400 mb-1.5">
                Pixel Crop Box ({srcW}×{srcH}px)
              </div>
              <div className="grid grid-cols-4 gap-2">
                {[
                  { label: 'X', val: effectiveCropX, fn: (v: number) => applyPixelCrop(v, effectiveCropY, effectiveCropW, effectiveCropH) },
                  { label: 'Y', val: effectiveCropY, fn: (v: number) => applyPixelCrop(effectiveCropX, v, effectiveCropW, effectiveCropH) },
                  { label: 'W', val: effectiveCropW, fn: (v: number) => applyPixelCrop(effectiveCropX, effectiveCropY, v, effectiveCropH) },
                  { label: 'H', val: effectiveCropH, fn: (v: number) => applyPixelCrop(effectiveCropX, effectiveCropY, effectiveCropW, v) },
                ].map((f) => (
                  <div key={f.label}>
                    <label className="text-[10px] text-zinc-500">{f.label}</label>
                    <input
                      type="number"
                      value={f.val}
                      onChange={(e) => f.fn(Number(e.target.value) || 0)}
                      className="mt-0.5 w-full bg-zinc-900 border border-white/[0.08] rounded px-2 py-1 text-xs font-mono text-zinc-100"
                    />
                  </div>
                ))}
              </div>
            </div>
          </CollapsibleSection>
        </div>
      )}

      {/* TAB 2: INDEPENDENT VIDEO SPEED, TRIM, SPLIT & UNLINK AUDIO */}
      {memory.editTab === 'timing' && (
        <div className="space-y-3">
          {/* Independent Video Clip Speed Control */}
          <div className="p-3 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-2.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-white flex items-center gap-1.5">
                <Gauge className="w-3.5 h-3.5 text-violet-400 shrink-0" />
                <span>Video Clip Speed (Independent)</span>
              </span>
              {activeVideoClip && (
                <span className="font-mono font-bold text-violet-300 tabular-nums px-2 py-0.5 rounded bg-violet-500/15 border border-violet-500/35">
                  {activeVideoClip.speed.toFixed(2)}x
                </span>
              )}
            </div>

            {videoClips.length > 1 && (
              <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
                {videoClips.map((vc, idx) => (
                  <button
                    key={vc.id}
                    type="button"
                    onClick={() => onSelectElement({ kind: 'video', clipId: vc.id })}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-medium border whitespace-nowrap cursor-pointer ${
                      activeVideoClip?.id === vc.id
                        ? 'bg-violet-600 border-violet-500 text-white'
                        : 'bg-zinc-900 border-white/[0.08] text-zinc-300 hover:text-white'
                    }`}
                  >
                    {vc.label || `Clip ${idx + 1}`} ({vc.speed}x)
                  </button>
                ))}
              </div>
            )}

            {activeVideoClip ? (
              <>
                <div className="grid grid-cols-4 sm:grid-cols-8 gap-1.5">
                  {VIDEO_SPEED_PRESETS.map((rate) => {
                    const isActive = Math.abs(activeVideoClip.speed - rate) < 0.01;
                    return (
                      <button
                        key={rate}
                        type="button"
                        onClick={() => updateActiveVideoClipSpeed(rate, true)}
                        className={`min-h-[34px] rounded-lg text-xs font-mono font-semibold border cursor-pointer ${
                          isActive
                            ? 'bg-violet-600 border-violet-500 text-white'
                            : 'bg-zinc-900 border-white/[0.06] text-zinc-300 hover:bg-zinc-800'
                        }`}
                      >
                        {rate}x
                      </button>
                    );
                  })}
                </div>

                {/* Custom Slider (0.25x - 4.0x) + Numeric Input + Reset */}
                <div className="flex items-center gap-2.5 pt-1">
                  <input
                    type="range"
                    min={MIN_VIDEO_SPEED}
                    max={MAX_VIDEO_SPEED}
                    step={0.05}
                    value={activeVideoClip.speed}
                    onChange={(e) => updateActiveVideoClipSpeed(Number(e.target.value), false)}
                    aria-label="Custom video clip speed"
                    className="flex-1 accent-violet-500"
                  />
                  <div className="flex items-center gap-1 shrink-0">
                    <input
                      type="number"
                      min={MIN_VIDEO_SPEED}
                      max={MAX_VIDEO_SPEED}
                      step={0.05}
                      value={activeVideoClip.speed}
                      onChange={(e) => updateActiveVideoClipSpeed(Number(e.target.value), true)}
                      aria-label="Video speed multiplier"
                      className="w-16 bg-zinc-900 border border-white/[0.08] rounded-md px-2 py-1 text-xs font-mono text-zinc-100 text-right tabular-nums"
                    />
                    <span className="text-[11px] font-mono text-zinc-400">x</span>
                    {Math.abs(activeVideoClip.speed - 1.0) > 0.01 && (
                      <button
                        type="button"
                        onClick={() => updateActiveVideoClipSpeed(1.0, true)}
                        className="px-2 py-1 rounded bg-zinc-900 border border-white/[0.08] text-[10.5px] text-zinc-300 hover:text-white cursor-pointer"
                      >
                        1.0x
                      </button>
                    )}
                  </div>
                </div>

                {/* Duration Readout & Unlink Audio Button */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-white/[0.06] text-[11px]">
                  <span className="text-zinc-400 font-mono tabular-nums">
                    Source {(activeVideoClip.sourceEnd - activeVideoClip.sourceStart).toFixed(2)}s → Timeline{' '}
                    <strong className="text-zinc-100">
                      {getVideoClipTimelineDuration(activeVideoClip).toFixed(2)}s
                    </strong>
                  </span>
                  {activeVideoClip.audioUnlinked ? (
                    <span className="px-2 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/35 text-cyan-300 font-medium flex items-center gap-1">
                      <Unlink className="w-3 h-3" />
                      Original Audio Unlinked (1.0x)
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={handleUnlinkSelectedClipAudio}
                      className="px-2.5 py-1 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-cyan-200 font-semibold flex items-center gap-1.5 cursor-pointer"
                    >
                      <Unlink className="w-3 h-3" />
                      Unlink Audio (Keep 1.0x)
                    </button>
                  )}
                </div>

                <p className="text-[10.5px] text-zinc-500">
                  Affects only the selected video clip. Fish Audio narration, captions, music &amp; SFX always remain at 1.0x.
                </p>
              </>
            ) : (
              <p className="text-[11px] text-zinc-400">Load a video first to adjust clip speed.</p>
            )}
          </div>

          {/* Independent Timeline Mismatch / Gap Warnings */}
          {timelineMismatches.length > 0 && (
            <div className="space-y-1.5">
              {timelineMismatches.map((w, i) => (
                <div
                  key={`${w.kind}-${i}`}
                  className={`p-2.5 rounded-xl border text-[11px] flex items-start gap-2 ${
                    w.severity === 'warning'
                      ? 'bg-amber-500/10 border-amber-500/35 text-amber-200'
                      : 'bg-sky-500/10 border-sky-500/35 text-sky-200'
                  }`}
                >
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{w.message}</span>
                </div>
              ))}
            </div>
          )}

          {/* Active Timed Element Trim & Clip Operations */}
          <div className="p-3 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-white">
                {activeBlur
                  ? `Blur Zone: ${activeBlur.name}`
                  : activeLogo
                  ? `Logo Overlay: ${activeLogo.filename}`
                  : activeExtraEl
                  ? `Text Overlay: ${activeExtraEl.label}`
                  : selectedElement?.kind === 'video' && activeVideoClip
                  ? `Video Clip: ${activeVideoClip.label || 'Clip'} (${activeVideoClip.speed}x)`
                  : activeCaptionSeg
                  ? `Caption at ${formatTimecode(currentTime)}: "${(activeCaptionSeg.translatedText || activeCaptionSeg.text).slice(0, 28)}"`
                  : `Playhead: ${formatTimecode(currentTime)}`}
              </span>
            </div>

            {(activeBlur || activeLogo || activeExtraEl || activeCaptionSeg) ? (
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <div className="flex items-center justify-between text-[10.5px] text-zinc-400 mb-1">
                    <span>Start Time (s)</span>
                    <button
                      type="button"
                      onClick={() => updateSelectedTiming({ start: Number(currentTime.toFixed(2)) })}
                      className="text-violet-300 hover:text-violet-200 font-mono cursor-pointer"
                    >
                      Set Now
                    </button>
                  </div>
                  <input
                    type="number"
                    min={0}
                    max={duration}
                    step={0.1}
                    value={
                      activeBlur
                        ? activeBlur.startTime
                        : activeLogo
                        ? activeLogo.startTime
                        : activeExtraEl
                        ? activeExtraEl.startTime
                        : activeCaptionSeg?.syncedStart || 0
                    }
                    onChange={(e) => updateSelectedTiming({ start: Math.max(0, Number(e.target.value)) })}
                    className="w-full bg-zinc-900 border border-white/[0.08] rounded px-2.5 py-1.5 text-xs font-mono text-zinc-100"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between text-[10.5px] text-zinc-400 mb-1">
                    <span>End Time (s)</span>
                    <button
                      type="button"
                      onClick={() => updateSelectedTiming({ end: Number(currentTime.toFixed(2)) })}
                      className="text-violet-300 hover:text-violet-200 font-mono cursor-pointer"
                    >
                      Set Now
                    </button>
                  </div>
                  <input
                    type="number"
                    min={0}
                    max={duration}
                    step={0.1}
                    value={
                      activeBlur
                        ? activeBlur.endTime
                        : activeLogo
                        ? activeLogo.endTime
                        : activeExtraEl
                        ? activeExtraEl.endTime > activeExtraEl.startTime
                          ? activeExtraEl.endTime
                          : duration
                        : activeCaptionSeg?.syncedEnd || duration
                    }
                    onChange={(e) => updateSelectedTiming({ end: Math.min(duration, Number(e.target.value)) })}
                    className="w-full bg-zinc-900 border border-white/[0.08] rounded px-2.5 py-1.5 text-xs font-mono text-zinc-100"
                  />
                </div>
              </div>
            ) : activeVideoClip ? (
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-[10.5px] text-zinc-400 block mb-1">Timeline Start</label>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={activeVideoClip.timelineStart}
                    onChange={(e) =>
                      updateActiveVideoClipPatch({ timelineStart: Math.max(0, Number(e.target.value) || 0) })
                    }
                    className="w-full bg-zinc-900 border border-white/[0.08] rounded px-2 py-1.5 text-xs font-mono text-zinc-100"
                  />
                </div>
                <div>
                  <label className="text-[10.5px] text-zinc-400 block mb-1">Source In</label>
                  <input
                    type="number"
                    min={0}
                    max={duration}
                    step={0.1}
                    value={activeVideoClip.sourceStart}
                    onChange={(e) =>
                      updateActiveVideoClipPatch({ sourceStart: Math.max(0, Number(e.target.value) || 0) })
                    }
                    className="w-full bg-zinc-900 border border-white/[0.08] rounded px-2 py-1.5 text-xs font-mono text-zinc-100"
                  />
                </div>
                <div>
                  <label className="text-[10.5px] text-zinc-400 block mb-1">Source Out</label>
                  <input
                    type="number"
                    min={0.1}
                    max={duration}
                    step={0.1}
                    value={activeVideoClip.sourceEnd}
                    onChange={(e) =>
                      updateActiveVideoClipPatch({ sourceEnd: Math.max(0.1, Number(e.target.value) || 0.1) })
                    }
                    className="w-full bg-zinc-900 border border-white/[0.08] rounded px-2 py-1.5 text-xs font-mono text-zinc-100"
                  />
                </div>
              </div>
            ) : (
              <p className="text-[11px] text-zinc-400">
                Select any timeline clip (Video, Blur, Overlay, Text, or Caption) to adjust timing.
              </p>
            )}

            <div className="grid grid-cols-3 gap-2 pt-1">
              <button
                type="button"
                onClick={onSplitAtPlayhead}
                className="min-h-[40px] px-2.5 py-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-white/[0.08] text-xs font-medium text-zinc-100 flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Scissors className="w-3.5 h-3.5 text-violet-400" />
                Split Clip
              </button>
              <button
                type="button"
                onClick={onDuplicateSelected}
                className="min-h-[40px] px-2.5 py-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-white/[0.08] text-xs font-medium text-zinc-100 flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Copy className="w-3.5 h-3.5 text-sky-400" />
                Duplicate
              </button>
              <button
                type="button"
                onClick={onDeleteSelected}
                className="min-h-[40px] px-2.5 py-2 rounded-lg bg-zinc-900 hover:bg-red-950/50 border border-white/[0.08] hover:border-red-500/40 text-xs font-medium text-red-300 flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </button>
            </div>
            {activeVideoClip && (
              <div className="text-[10.5px] font-mono text-zinc-500 text-right tabular-nums">
                Active clip ends at {getVideoClipTimelineEnd(activeVideoClip).toFixed(2)}s
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: BACKGROUND FILL */}
      {memory.editTab === 'background' && (
        <div className="p-3 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-3">
          <span className="text-xs font-semibold text-white flex items-center gap-1.5">
            <ImageIcon className="w-3.5 h-3.5 text-violet-400" />
            Canvas Background Fill
          </span>

          <div className="grid grid-cols-3 gap-1.5">
            {(
              [
                { id: 'solid', label: 'Solid Color' },
                { id: 'blur', label: 'Blur Video' },
                { id: 'image', label: 'Image Fill' },
              ] as Array<{ id: CanvasBackgroundType; label: string }>
            ).map((bg) => (
              <button
                key={bg.id}
                type="button"
                onClick={() => updateCanvasConfig({ backgroundType: bg.id }, { immediate: true })}
                className={`min-h-[38px] py-1.5 px-2 rounded-lg text-xs font-medium border cursor-pointer ${
                  canvasConfig.backgroundType === bg.id
                    ? 'bg-violet-600 border-violet-500 text-white'
                    : 'bg-zinc-900 border-white/[0.06] text-zinc-300 hover:bg-zinc-800'
                }`}
              >
                {bg.label}
              </button>
            ))}
          </div>

          {canvasConfig.backgroundType === 'solid' && (
            <div className="space-y-2.5 pt-1">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={/^#[0-9a-fA-F]{6}$/.test(canvasConfig.bgColor) ? canvasConfig.bgColor : '#09090B'}
                  onChange={(e) => updateCanvasConfig({ bgColor: e.target.value })}
                  className="w-9 h-9 rounded bg-transparent cursor-pointer shrink-0"
                />
                <input
                  type="text"
                  value={canvasConfig.bgColor}
                  onChange={(e) => updateCanvasConfig({ bgColor: e.target.value })}
                  className="flex-1 bg-zinc-900 border border-white/[0.08] rounded-md px-2.5 py-1.5 text-xs font-mono text-zinc-100"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                {['#09090B', '#000000', '#18181B', '#1E1B4B', '#312E81', '#FFFFFF'].map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => updateCanvasConfig({ bgColor: c }, { immediate: true })}
                    style={{ backgroundColor: c }}
                    className={`w-7 h-7 rounded-full border cursor-pointer ${
                      canvasConfig.bgColor.toUpperCase() === c
                        ? 'border-violet-400 ring-2 ring-violet-500/40'
                        : 'border-white/20'
                    }`}
                  />
                ))}
              </div>
            </div>
          )}

          {canvasConfig.backgroundType === 'blur' && (
            <div className="space-y-2.5 pt-1">
              <div>
                <div className="flex justify-between text-[11px] text-zinc-300">
                  <span>Background Blur Intensity</span>
                  <span className="font-mono tabular-nums">{canvasConfig.bgBlurIntensity}px</span>
                </div>
                <input
                  type="range"
                  min={4}
                  max={60}
                  value={canvasConfig.bgBlurIntensity}
                  onChange={(e) => updateCanvasConfig({ bgBlurIntensity: Number(e.target.value) })}
                  className="mt-1 w-full accent-violet-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="flex justify-between text-[11px] text-zinc-300">
                    <span>Brightness</span>
                    <span className="font-mono tabular-nums">{canvasConfig.bgBlurBrightness}</span>
                  </div>
                  <input
                    type="range"
                    min={-60}
                    max={60}
                    step={2}
                    value={canvasConfig.bgBlurBrightness}
                    onChange={(e) => updateCanvasConfig({ bgBlurBrightness: Number(e.target.value) })}
                    className="mt-1 w-full accent-violet-500"
                  />
                </div>
                <div>
                  <div className="flex justify-between text-[11px] text-zinc-300">
                    <span>Opacity</span>
                    <span className="font-mono tabular-nums">
                      {Math.round(canvasConfig.bgBlurOpacity * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0.1}
                    max={1}
                    step={0.05}
                    value={canvasConfig.bgBlurOpacity}
                    onChange={(e) => updateCanvasConfig({ bgBlurOpacity: Number(e.target.value) })}
                    className="mt-1 w-full accent-violet-500"
                  />
                </div>
              </div>
            </div>
          )}

          {canvasConfig.backgroundType === 'image' && (
            <div className="space-y-2.5 pt-1">
              <input
                ref={bgFileRef}
                type="file"
                accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleUploadBgImage(f);
                  e.target.value = '';
                }}
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-zinc-400 truncate">
                  {canvasConfig.bgImageFilename || 'No image selected'}
                </span>
                <button
                  type="button"
                  disabled={busyBgUpload}
                  onClick={() => bgFileRef.current?.click()}
                  className="min-h-[36px] px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer"
                >
                  {busyBgUpload ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UploadCloud className="w-3.5 h-3.5" />}
                  {canvasConfig.bgImageUrl ? 'Replace' : 'Upload Image'}
                </button>
              </div>
              <div>
                <div className="flex justify-between text-[11px] text-zinc-300">
                  <span>Scale</span>
                  <span className="font-mono tabular-nums">{Math.round(canvasConfig.bgImageScale * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0.5}
                  max={2.5}
                  step={0.05}
                  value={canvasConfig.bgImageScale}
                  onChange={(e) => updateCanvasConfig({ bgImageScale: Number(e.target.value) })}
                  className="mt-1 w-full accent-violet-500"
                />
              </div>
              <CollapsibleSection title="Advanced Image Background Settings">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="flex justify-between text-[11px] text-zinc-300">
                      <span>Offset X</span>
                      <span className="font-mono">{canvasConfig.bgImageOffsetX}%</span>
                    </div>
                    <input
                      type="range"
                      min={-50}
                      max={50}
                      value={canvasConfig.bgImageOffsetX}
                      onChange={(e) => updateCanvasConfig({ bgImageOffsetX: Number(e.target.value) })}
                      className="mt-1 w-full accent-violet-500"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between text-[11px] text-zinc-300">
                      <span>Offset Y</span>
                      <span className="font-mono">{canvasConfig.bgImageOffsetY}%</span>
                    </div>
                    <input
                      type="range"
                      min={-50}
                      max={50}
                      value={canvasConfig.bgImageOffsetY}
                      onChange={(e) => updateCanvasConfig({ bgImageOffsetY: Number(e.target.value) })}
                      className="mt-1 w-full accent-violet-500"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between text-[11px] text-zinc-300">
                      <span>Rotation</span>
                      <span className="font-mono">{Math.round(canvasConfig.bgImageRotation ?? 0)}°</span>
                    </div>
                    <input
                      type="range"
                      min={-180}
                      max={180}
                      value={canvasConfig.bgImageRotation ?? 0}
                      onChange={(e) => updateCanvasConfig({ bgImageRotation: Number(e.target.value) })}
                      className="mt-1 w-full accent-violet-500"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between text-[11px] text-zinc-300">
                      <span>Opacity</span>
                      <span className="font-mono">{Math.round((canvasConfig.bgImageOpacity ?? 1) * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0.05}
                      max={1}
                      step={0.05}
                      value={canvasConfig.bgImageOpacity ?? 1}
                      onChange={(e) => updateCanvasConfig({ bgImageOpacity: Number(e.target.value) })}
                      className="mt-1 w-full accent-violet-500"
                    />
                  </div>
                </div>
              </CollapsibleSection>
            </div>
          )}
        </div>
      )}

      {/* TAB 4: SOURCE MEDIA & EDITING PRESETS */}
      {memory.editTab === 'media' && (
        <div className="space-y-3">
          <div className="p-3 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-2.5">
            <label className="text-[11px] font-medium text-zinc-400">Project Title</label>
            <input
              type="text"
              value={project.name}
              onChange={(e) =>
                onPatchProject(
                  project.id,
                  { name: e.target.value },
                  { undoGroupKey: 'edit:name', recordUndo: false, debounceMs: 300 }
                )
              }
              onBlur={(e) =>
                onPatchProject(
                  project.id,
                  { name: e.target.value.trim() || 'Untitled Recap' },
                  { immediate: true, recordUndo: false }
                )
              }
              className="w-full bg-zinc-900 border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-violet-500"
            />
          </div>

          <div className="p-3 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                <Film className="w-3.5 h-3.5 text-violet-400" />
                Source Video
              </span>
              <input
                ref={fileRef}
                type="file"
                accept=".mp4,.mov,.mkv,video/mp4,video/quicktime,video/x-matroska"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleReplaceVideo(f);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="min-h-[36px] px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer"
              >
                <UploadCloud className="w-3.5 h-3.5" />
                {project.sourceVideoUrl ? 'Replace Video' : 'Upload Video'}
              </button>
            </div>

            {uploadPct !== null && (
              <div className="space-y-1">
                <div className="flex justify-between text-[11px] text-zinc-400">
                  <span>{uploadStage}</span>
                  <span className="font-mono tabular-nums">{uploadPct}%</span>
                </div>
                <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div className="h-full bg-violet-500" style={{ width: `${uploadPct}%` }} />
                </div>
              </div>
            )}

            {project.metadata && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1.5 border-t border-white/[0.06] text-[11px]">
                <div>
                  <div className="text-zinc-500">Duration</div>
                  <div className="font-mono text-zinc-200">{formatDurationShort(project.metadata.duration)}</div>
                </div>
                <div>
                  <div className="text-zinc-500">Size</div>
                  <div className="font-mono text-zinc-200">{project.metadata.width}×{project.metadata.height}</div>
                </div>
                <div>
                  <div className="text-zinc-500">File</div>
                  <div className="font-mono text-zinc-200">{formatBytes(project.metadata.fileSize)}</div>
                </div>
                <div>
                  <div className="text-zinc-500">FPS / Codec</div>
                  <div className="font-mono text-zinc-200">{project.metadata.fps} · {project.metadata.videoCodec}</div>
                </div>
              </div>
            )}

            <div className="pt-2 border-t border-white/[0.06] flex items-center justify-between gap-2">
              <span className="text-[11px] text-zinc-400 flex items-center gap-1.5">
                <FileAudio className="w-3.5 h-3.5" /> Extract Source Audio (WAV)
              </span>
              <button
                type="button"
                onClick={handleExtractAudio}
                disabled={!project.metadata?.hasAudio || busyAudio}
                className="min-h-[34px] px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-xs font-medium text-zinc-200 flex items-center gap-1 cursor-pointer"
              >
                {busyAudio && <Loader2 className="w-3 h-3 animate-spin" />}
                Extract Audio
              </button>
            </div>
            {extractedAudio && (
              <div className="space-y-1.5 pt-1">
                <audio src={extractedAudio.audioUrl} controls className="w-full h-8" />
                <a
                  href={extractedAudio.downloadUrl}
                  className="inline-flex items-center gap-1.5 text-[11px] text-violet-400 hover:text-violet-300"
                >
                  <Download className="w-3 h-3" />
                  Download {extractedAudio.filename}
                </a>
              </div>
            )}
          </div>

          <CollapsibleSection title="Saved Canvas & Editing Presets">
            <PresetLibraryPanel
              category="editing"
              title="Editing Presets"
              subtitle="Save aspect ratio, zoom, crop, background fill & logos."
              getPayload={() => {
                const assetRefs: StudioPresetAssetRef[] = [];
                if (canvasConfig.backgroundType === 'image' && canvasConfig.bgImageUrl) {
                  assetRefs.push({
                    kind: 'background-image',
                    label: canvasConfig.bgImageFilename || 'Background Image',
                    url: canvasConfig.bgImageUrl,
                    filename: canvasConfig.bgImageFilename,
                  });
                }
                return {
                  payload: { canvas: canvasConfig, logos: project.logos },
                  assetRefs,
                  thumbnailStyle: {
                    bg: canvasConfig.bgColor || '#18181D',
                    fg: '#FFFFFF',
                    sampleText: canvasConfig.aspectRatio === 'original' ? 'RAW' : canvasConfig.aspectRatio,
                    badge: `${canvasConfig.backgroundType} · ${Math.round(canvasConfig.zoom * 100)}% zoom`,
                  },
                };
              }}
              onApplyPreset={async (preset: StudioPreset) => {
                const res = await api.applyPresetsToProject(project.id, { editingPresetId: preset.id });
                onProjectUpdated(res.project);
                setSuccessMsg(`Applied editing template "${preset.name}".`);
              }}
              onReuploadMissingAsset={async (_missing, preset, file) => {
                const uploaded = await api.uploadCanvasBackground(project.id, file);
                onProjectUpdated(uploaded.project);
                await api.updatePreset(preset.id, {
                  payload: {
                    ...(preset.payload || {}),
                    canvas: {
                      ...((preset.payload?.canvas as Record<string, unknown>) || {}),
                      bgImageUrl: uploaded.url,
                      bgImageFilename: uploaded.filename,
                    },
                  },
                  assetRefs: [
                    {
                      kind: 'background-image',
                      label: uploaded.filename,
                      url: uploaded.url,
                      filename: uploaded.filename,
                    },
                  ],
                });
                setSuccessMsg(`Updated asset for "${preset.name}".`);
              }}
            />
          </CollapsibleSection>
        </div>
      )}
    </div>
  );
}
