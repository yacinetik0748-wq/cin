import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  Captions,
  Check,
  CheckSquare,
  Copy,
  Crosshair,
  Eye,
  EyeOff,
  Link2,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  RotateCcw,
  ScanText,
  Square,
  SquareDashed,
  Trash2,
  Unlock,
  Unlink,
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import {
  BlurEffect,
  BlurMode,
  BlurSubtitleLink,
  BlurType,
  DetectedSubtitleRegion,
  Project,
  ProjectPatchFn,
  ProjectPatchOptions,
} from '../../types/studio';
import { api } from '../../lib/api';
import { createWorkflowUpdate } from '../../lib/workflowStages';
import {
  clampNormBox,
  createSubtitleBlurMask,
  detectedRegionToBlurMask,
  resolveBlurIntervals,
} from '../../lib/blurMasks';
import { generateForegroundMaskPng, trackObjectAcrossVideo } from '../../lib/visionEngine';
import { LOCKED_LAYER_MESSAGE } from '../../lib/layerLock';
import { CollapsibleSection } from '../ui/CollapsibleSection';
import { StudioToolMemory } from './toolMemory';

interface BlurToolSheetProps {
  project: Project;
  onProjectUpdated: (p: Project) => void;
  onPatchProject: ProjectPatchFn;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  currentTime?: number;
  drawMode: 'none' | 'selective' | 'motion';
  onSetDrawMode: (mode: 'none' | 'selective' | 'motion') => void;
  selectedBlurId: string | null;
  onSelectBlur: (id: string | null) => void;
  onShowNotice?: (msg: string) => void;
  memory: StudioToolMemory;
  onUpdateMemory: (patch: Partial<StudioToolMemory>) => void;
}

const BAND_LABELS: Record<'bottom' | 'top' | 'middle', string> = {
  bottom: 'Bottom',
  top: 'Top',
  middle: 'Middle',
};

function formatSpan(start: number, end: number): string {
  return `${start.toFixed(1)}s–${end.toFixed(1)}s`;
}

export function BlurToolSheet({
  project,
  onProjectUpdated,
  onPatchProject,
  videoRef,
  currentTime = 0,
  drawMode,
  onSetDrawMode,
  selectedBlurId,
  onSelectBlur,
  onShowNotice,
  memory,
  onUpdateMemory,
}: BlurToolSheetProps) {
  const [detectBusy, setDetectBusy] = useState(false);
  const [trackingPct, setTrackingPct] = useState<number | null>(null);
  const [segmentBusy, setSegmentBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  const notifyLocked = () => {
    setErrorMsg(LOCKED_LAYER_MESSAGE);
    onShowNotice?.(LOCKED_LAYER_MESSAGE);
  };

  const duration = Math.max(1, project.metadata?.duration || 12);
  const selectedBlur = project.blurs.find((b) => b.id === selectedBlurId) || project.blurs[0] || null;
  const subtitleRemoval = project.subtitleRemoval;
  const detections = subtitleRemoval?.detections || [];
  const blurIdSet = useMemo(() => new Set(project.blurs.map((b) => b.id)), [project.blurs]);

  const unappliedDetections = useMemo(
    () => detections.filter((d) => !d.appliedMaskId || !blurIdSet.has(d.appliedMaskId)),
    [detections, blurIdSet]
  );
  const selectedUnappliedCount = useMemo(
    () => unappliedDetections.filter((d) => d.selected).length,
    [unappliedDetections]
  );

  const selectedIntervals = useMemo(() => {
    if (!selectedBlur) return [];
    return resolveBlurIntervals(selectedBlur, project);
  }, [selectedBlur, project]);

  const seekVideoTo = (time: number) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(time)) return;
    try {
      v.currentTime = Math.max(0, Math.min(duration, time));
    } catch {
      // ignore seek failures before metadata load
    }
  };

  const handleAutoDetectCaptions = async () => {
    if (!project.sourceVideoUrl) {
      setErrorMsg('Upload or import a video first before running subtitle detection.');
      return;
    }
    setErrorMsg(null);
    setStatusNotice(null);
    setDetectBusy(true);
    try {
      const res = await api.detectOriginalCaptions(project.id);
      onProjectUpdated(res.project);
      if (res.detections.length > 0) {
        setStatusNotice(
          `Detected ${res.detections.length} burned-in subtitle ${
            res.detections.length === 1 ? 'region' : 'regions'
          } across ${res.framesAnalyzed} analyzed frames.`
        );
      } else {
        setStatusNotice(res.analysisMessage);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Caption detection failed.');
    } finally {
      setDetectBusy(false);
    }
  };

  const toggleDetectionSelected = (detId: string) => {
    onPatchProject(
      project.id,
      (cur) => {
        const curRemoval = cur.subtitleRemoval;
        if (!curRemoval) return {};
        return {
          subtitleRemoval: {
            ...curRemoval,
            detections: curRemoval.detections.map((d) =>
              d.id === detId ? { ...d, selected: !d.selected } : d
            ),
          },
        };
      },
      { immediate: true }
    );
  };

  const deleteDetection = (detId: string) => {
    onPatchProject(
      project.id,
      (cur) => {
        const curRemoval = cur.subtitleRemoval;
        if (!curRemoval) return {};
        return {
          subtitleRemoval: {
            ...curRemoval,
            detections: curRemoval.detections.filter((d) => d.id !== detId),
          },
        };
      },
      { immediate: true }
    );
  };

  const applyDetectionList = (targets: DetectedSubtitleRegion[]) => {
    if (targets.length === 0) return;
    setErrorMsg(null);
    const createdMasks: BlurEffect[] = [];
    const targetToMaskId = new Map<string, string>();
    const existingCount = project.blurs.filter((b) => b.isSubtitleMask).length;

    targets.forEach((det, idx) => {
      if (det.appliedMaskId && blurIdSet.has(det.appliedMaskId)) return;
      const maskId = uuidv4();
      const mask = detectedRegionToBlurMask(det, maskId, existingCount + idx + 1, {
        mode: 'manual',
      });
      createdMasks.push(mask);
      targetToMaskId.set(det.id, maskId);
    });

    if (createdMasks.length === 0) return;

    onPatchProject(
      project.id,
      (cur) => ({
        blurs: [...cur.blurs, ...createdMasks],
        subtitleRemoval: cur.subtitleRemoval
          ? {
              ...cur.subtitleRemoval,
              detections: cur.subtitleRemoval.detections.map((d) =>
                targetToMaskId.has(d.id) ? { ...d, appliedMaskId: targetToMaskId.get(d.id) } : d
              ),
            }
          : cur.subtitleRemoval,
        workflow: createWorkflowUpdate(cur.workflow, {
          completeStage: 'editor',
          modifiedStage: 'editor',
          hasExistingExport: Boolean(cur.lastExportUrl),
        }),
      }),
      { immediate: true }
    );
    onSelectBlur(createdMasks[0].id);
    seekVideoTo(createdMasks[0].startTime + 0.05);
    setStatusNotice(
      `Applied ${createdMasks.length} subtitle blur ${
        createdMasks.length === 1 ? 'mask' : 'masks'
      } to timeline and preview.`
    );
  };

  const addSubtitleMask = (band: 'bottom' | 'top' | 'middle', startDraw = false) => {
    setErrorMsg(null);
    const id = uuidv4();
    const maskIndex = project.blurs.filter((b) => b.isSubtitleMask).length + 1;
    const newBlur = createSubtitleBlurMask({
      id,
      name: `Caption Mask · ${BAND_LABELS[band]} #${maskIndex}`,
      band,
      blurType: 'strong',
      intensity: 28,
      opacity: 1,
      feather: 10,
      borderRadius: 8,
      startTime: 0,
      endTime: Number(duration.toFixed(2)),
    });

    onPatchProject(
      project.id,
      (cur) => ({
        blurs: [...cur.blurs, newBlur],
        workflow: createWorkflowUpdate(cur.workflow, {
          completeStage: 'editor',
          modifiedStage: 'editor',
          hasExistingExport: Boolean(cur.lastExportUrl),
        }),
      }),
      { immediate: true }
    );
    onSelectBlur(id);
    if (startDraw) {
      onSetDrawMode('selective');
    }
  };

  const addBlurEffect = (mode: BlurMode) => {
    setErrorMsg(null);
    const id = uuidv4();
    const newBlur: BlurEffect = {
      id,
      name:
        mode === 'full'
          ? 'Full Video Blur'
          : mode === 'background'
          ? 'Background AI Blur'
          : mode === 'selective'
          ? 'Selective Blur Zone'
          : 'Motion Tracked Blur',
      mode,
      type: 'gaussian',
      enabled: true,
      intensity: 18,
      radius: 18,
      opacity: 1.0,
      feather: 10,
      borderRadius: 8,
      rotation: 0,
      locked: false,
      startTime: 0,
      endTime: Number(duration.toFixed(2)),
      x: 0.3,
      y: 0.25,
      width: 0.28,
      height: 0.32,
      shape: 'rect',
      coordSpace: mode === 'selective' || mode === 'motion' ? 'video' : 'stage',
      subtitleLink: { mode: 'manual' },
    };

    onPatchProject(
      project.id,
      (cur) => ({
        blurs: [...cur.blurs, newBlur],
        workflow: createWorkflowUpdate(cur.workflow, {
          completeStage: 'editor',
          modifiedStage: 'editor',
          hasExistingExport: Boolean(cur.lastExportUrl),
        }),
      }),
      { immediate: true }
    );
    onSelectBlur(id);
    if (mode === 'selective') onSetDrawMode('selective');
    if (mode === 'motion') onSetDrawMode('motion');
  };

  const updateBlur = (id: string, patch: Partial<BlurEffect>, opts?: ProjectPatchOptions) => {
    const keys = Object.keys(patch);
    const isLockOrVisOnly = keys.length > 0 && keys.every((k) => k === 'locked' || k === 'enabled');
    if (!isLockOrVisOnly) {
      const target = project.blurs.find((b) => b.id === id);
      if (target?.locked) {
        notifyLocked();
        return;
      }
    }
    if (errorMsg === LOCKED_LAYER_MESSAGE) setErrorMsg(null);
    onPatchProject(
      project.id,
      (cur) => ({
        blurs: cur.blurs.map((b) => (b.id === id ? { ...b, ...patch } : b)),
        workflow: createWorkflowUpdate(cur.workflow, {
          completeStage: 'editor',
          modifiedStage: 'editor',
          hasExistingExport: Boolean(cur.lastExportUrl),
        }),
      }),
      opts ?? { immediate: true }
    );
  };

  const duplicateBlur = (orig: BlurEffect) => {
    if (orig.locked) {
      notifyLocked();
      return;
    }
    const copyId = uuidv4();
    const offset = clampNormBox({
      x: orig.x + 0.03,
      y: Math.min(0.95 - orig.height, orig.y + 0.03),
      width: orig.width,
      height: orig.height,
    });
    const copy: BlurEffect = {
      ...orig,
      ...offset,
      id: copyId,
      name: `${orig.name} Copy`,
      locked: false,
    };
    onPatchProject(
      project.id,
      (cur) => ({
        blurs: [...cur.blurs, copy],
        workflow: createWorkflowUpdate(cur.workflow, {
          completeStage: 'editor',
          modifiedStage: 'editor',
          hasExistingExport: Boolean(cur.lastExportUrl),
        }),
      }),
      { immediate: true }
    );
    onSelectBlur(copyId);
  };

  const removeBlur = (id: string) => {
    const target = project.blurs.find((b) => b.id === id);
    if (target?.locked) {
      notifyLocked();
      return;
    }
    const remaining = project.blurs.filter((b) => b.id !== id);
    onPatchProject(
      project.id,
      (cur) => ({
        blurs: cur.blurs.filter((b) => b.id !== id),
        subtitleRemoval: cur.subtitleRemoval
          ? {
              ...cur.subtitleRemoval,
              detections: cur.subtitleRemoval.detections.map((d) =>
                d.appliedMaskId === id ? { ...d, appliedMaskId: undefined } : d
              ),
            }
          : cur.subtitleRemoval,
        workflow: createWorkflowUpdate(cur.workflow, {
          completeStage: 'editor',
          modifiedStage: 'editor',
          hasExistingExport: Boolean(cur.lastExportUrl),
        }),
      }),
      { immediate: true }
    );
    if (selectedBlurId === id) {
      onSelectBlur(remaining[0]?.id || null);
    }
  };

  const handleSetSubtitleLink = (blur: BlurEffect, nextLink: BlurSubtitleLink) => {
    if (blur.locked) {
      notifyLocked();
      return;
    }
    if (nextLink.mode === 'manual') {
      const span = resolveBlurIntervals(blur, project);
      const startTime = span[0]?.start ?? blur.startTime;
      const endTime = span[span.length - 1]?.end ?? blur.endTime;
      updateBlur(blur.id, {
        subtitleLink: { mode: 'manual' },
        startTime: Number(Math.max(0, startTime).toFixed(2)),
        endTime: Number(Math.max(startTime + 0.15, endTime).toFixed(2)),
      });
      return;
    }

    const previewIntervals = resolveBlurIntervals(
      { ...blur, subtitleLink: nextLink },
      project
    );
    const startTime = previewIntervals[0]?.start ?? blur.startTime;
    const endTime =
      previewIntervals[previewIntervals.length - 1]?.end ?? Math.max(startTime + 0.15, blur.endTime);

    updateBlur(blur.id, {
      subtitleLink: nextLink,
      startTime: Number(Math.max(0, startTime).toFixed(2)),
      endTime: Number(Math.max(startTime + 0.15, endTime).toFixed(2)),
    });
  };

  const handleRunMotionTracking = async (blur: BlurEffect) => {
    if (blur.locked) {
      notifyLocked();
      return;
    }
    if (!videoRef.current || !project.sourceVideoUrl) {
      setErrorMsg('Load a video before running motion tracking.');
      return;
    }
    setErrorMsg(null);
    setTrackingPct(1);
    try {
      const keyframes = await trackObjectAcrossVideo({
        video: videoRef.current,
        initialBox: { x: blur.x, y: blur.y, width: blur.width, height: blur.height },
        startTime: blur.startTime,
        endTime: blur.endTime,
        onProgress: (pct) => setTrackingPct(pct),
      });
      updateBlur(blur.id, { keyframes });
      onSetDrawMode('none');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setTrackingPct(null);
    }
  };

  const handleCaptureForegroundMatte = async (blur: BlurEffect) => {
    if (blur.locked) {
      notifyLocked();
      return;
    }
    if (!videoRef.current || !project.sourceVideoUrl) {
      setErrorMsg('Load a video before running foreground segmentation.');
      return;
    }
    setErrorMsg(null);
    setSegmentBusy(true);
    try {
      const maskBase64 = generateForegroundMaskPng(videoRef.current);
      const res = await api.uploadMask(project.id, blur.id, maskBase64);
      updateBlur(blur.id, { maskAssetId: res.maskUrl });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSegmentBusy(false);
    }
  };

  const currentLinkMode = selectedBlur?.subtitleLink?.mode || 'manual';

  return (
    <div className="space-y-3.5">
      {errorMsg && (
        <div className="p-2.5 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <span>{errorMsg}</span>
        </div>
      )}

      {statusNotice && !errorMsg && (
        <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-xs text-emerald-200 flex items-start gap-2">
          <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <span>{statusNotice}</span>
        </div>
      )}

      {/* SECTION 1: Original Caption Remover Auto-Detection */}
      <div className="p-3 rounded-xl bg-[#18181D] border border-sky-500/25 space-y-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <Captions className="w-3.5 h-3.5 text-sky-400 shrink-0" />
              <h3 className="text-xs font-semibold text-white">Original Caption Remover</h3>
            </div>
            <p className="text-[11px] text-zinc-400 mt-0.5 leading-snug">
              Detect and hide burned-in subtitles across the original video without cropping or resizing frames.
            </p>
          </div>
          {subtitleRemoval?.method && (
            <span className="shrink-0 px-2 py-0.5 rounded bg-zinc-900 border border-white/[0.08] text-[10px] font-mono text-zinc-300 uppercase">
              {subtitleRemoval.ocrAvailable ? 'OCR + Visual' : 'Visual Scan'}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void handleAutoDetectCaptions()}
            disabled={detectBusy || !project.sourceVideoUrl}
            className="flex-1 min-h-[40px] px-3 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-45 text-xs font-semibold text-white flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
          >
            {detectBusy ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
            ) : detections.length > 0 ? (
              <RefreshCw className="w-3.5 h-3.5 shrink-0" />
            ) : (
              <ScanText className="w-3.5 h-3.5 shrink-0" />
            )}
            <span>
              {detectBusy
                ? 'Analyzing Video Frames...'
                : detections.length > 0
                ? 'Run Detection Again'
                : 'Auto Detect Original Captions'}
            </span>
          </button>
        </div>

        {/* Honest Analysis / OCR Availability Banner */}
        {subtitleRemoval?.analysisMessage && (
          <div
            className={`p-2 rounded-lg border text-[11px] leading-relaxed flex items-start gap-2 ${
              subtitleRemoval.ocrAvailable === false
                ? 'bg-amber-500/10 border-amber-500/25 text-amber-200'
                : 'bg-zinc-900/90 border-white/[0.07] text-zinc-300'
            }`}
          >
            <AlertCircle
              className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${
                subtitleRemoval.ocrAvailable === false ? 'text-amber-400' : 'text-sky-400'
              }`}
            />
            <div className="min-w-0">
              <p>{subtitleRemoval.analysisMessage}</p>
              {typeof subtitleRemoval.framesAnalyzed === 'number' &&
                subtitleRemoval.framesAnalyzed > 0 && (
                  <p className="text-[10px] text-zinc-400 font-mono mt-0.5">
                    Analyzed {subtitleRemoval.framesAnalyzed} video frames
                    {subtitleRemoval.ocrAvailable === false
                      ? ' • Use manual masks below or review visual regions'
                      : ''}
                  </p>
                )}
            </div>
          </div>
        )}

        {/* Detected Subtitle Regions Pre-Apply Review List */}
        {detections.length > 0 && (
          <div className="space-y-2 pt-1 border-t border-white/[0.07]">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-zinc-300 font-medium">
                Detected Subtitle Regions ({detections.length})
              </span>
              <span className="text-zinc-500 font-mono">
                {unappliedDetections.length} unapplied
              </span>
            </div>

            <div className="space-y-1.5 max-h-56 overflow-y-auto pr-0.5">
              {detections.map((det) => {
                const applied = Boolean(det.appliedMaskId && blurIdSet.has(det.appliedMaskId));
                return (
                  <div
                    key={det.id}
                    className={`p-2 rounded-lg border text-xs space-y-1.5 ${
                      applied
                        ? 'bg-emerald-500/8 border-emerald-500/30'
                        : det.selected
                        ? 'bg-sky-500/10 border-sky-500/35'
                        : 'bg-zinc-900/80 border-white/[0.06]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => !applied && toggleDetectionSelected(det.id)}
                        disabled={applied}
                        className="flex items-start gap-2 text-left min-w-0 flex-1 cursor-pointer disabled:cursor-default"
                      >
                        {applied ? (
                          <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                        ) : det.selected ? (
                          <CheckSquare className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
                        ) : (
                          <Square className="w-4 h-4 text-zinc-500 shrink-0 mt-0.5" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-[10px] font-semibold text-zinc-200 uppercase">
                              {BAND_LABELS[det.band]}
                            </span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                seekVideoTo(det.startTime + 0.05);
                              }}
                              className="text-[11px] font-mono text-sky-300 hover:underline cursor-pointer"
                              title="Jump playhead to detection"
                            >
                              {formatSpan(det.startTime, det.endTime)}
                            </button>
                            <span className="text-[10px] font-mono text-zinc-400">
                              {Math.round(det.confidence * 100)}% • {det.framesMatched}f
                            </span>
                          </div>
                          {det.detectedText ? (
                            <p className="text-[11px] text-zinc-200 mt-1 truncate">
                              "{det.detectedText}"
                            </p>
                          ) : (
                            <p className="text-[10.5px] text-zinc-400 mt-0.5 font-mono">
                              Region X:{Math.round(det.x * 100)}% Y:{Math.round(det.y * 100)}% W:
                              {Math.round(det.width * 100)}% H:{Math.round(det.height * 100)}%
                            </p>
                          )}
                        </div>
                      </button>

                      <div className="flex items-center gap-1 shrink-0">
                        {applied && det.appliedMaskId ? (
                          <button
                            type="button"
                            onClick={() => onSelectBlur(det.appliedMaskId!)}
                            className="px-2 py-1 rounded bg-emerald-500/15 text-emerald-300 text-[10px] font-medium hover:bg-emerald-500/25 cursor-pointer"
                          >
                            Edit Mask
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => applyDetectionList([det])}
                            className="px-2 py-1 rounded bg-sky-600/25 text-sky-200 text-[10px] font-medium hover:bg-sky-600/40 cursor-pointer"
                          >
                            Apply
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => deleteDetection(det.id)}
                          className="p-1 rounded text-zinc-500 hover:text-red-400 hover:bg-white/[0.06] cursor-pointer"
                          title="Delete detection"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {unappliedDetections.length > 0 && (
              <div className="grid grid-cols-2 gap-1.5 pt-1">
                <button
                  type="button"
                  disabled={selectedUnappliedCount === 0}
                  onClick={() =>
                    applyDetectionList(unappliedDetections.filter((d) => d.selected))
                  }
                  className="min-h-[36px] px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 border border-white/[0.08] text-[11px] font-medium text-zinc-100 cursor-pointer"
                >
                  Apply Selected ({selectedUnappliedCount})
                </button>
                <button
                  type="button"
                  onClick={() => applyDetectionList(unappliedDetections)}
                  className="min-h-[36px] px-2.5 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-[11px] font-semibold text-white cursor-pointer"
                >
                  Apply All ({unappliedDetections.length})
                </button>
              </div>
            )}
          </div>
        )}

        {/* Quick Manual Subtitle Mask Presets */}
        <div className="pt-1.5 border-t border-white/[0.06] space-y-1.5">
          <span className="text-[10.5px] text-zinc-400 block">
            Manual Subtitle Mask Presets
          </span>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            {(
              [
                { band: 'bottom', label: 'Bottom Mask' },
                { band: 'top', label: 'Top Mask' },
                { band: 'middle', label: 'Middle Mask' },
              ] as const
            ).map((preset) => (
              <button
                key={preset.band}
                type="button"
                onClick={() => addSubtitleMask(preset.band, false)}
                className="min-h-[36px] px-2 py-1.5 rounded-lg bg-zinc-900 hover:bg-sky-600/20 border border-white/[0.08] hover:border-sky-500/40 text-[11px] font-medium text-zinc-100 flex items-center justify-center gap-1 cursor-pointer"
              >
                <Plus className="w-3 h-3 text-sky-400 shrink-0" />
                <span className="truncate">{preset.label}</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => addSubtitleMask('bottom', true)}
              className="min-h-[36px] px-2 py-1.5 rounded-lg bg-zinc-900 hover:bg-violet-600/20 border border-white/[0.08] hover:border-violet-500/40 text-[11px] font-medium text-zinc-100 flex items-center justify-center gap-1 cursor-pointer"
            >
              <SquareDashed className="w-3 h-3 text-violet-400 shrink-0" />
              <span className="truncate">Draw Box</span>
            </button>
          </div>
        </div>
      </div>

      {/* SECTION 2: General Blur Modes */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
        {(
          [
            { mode: 'selective', label: 'Region' },
            { mode: 'motion', label: 'Track Object' },
            { mode: 'background', label: 'Background' },
            { mode: 'full', label: 'Full Screen' },
          ] as Array<{ mode: BlurMode; label: string }>
        ).map((item) => (
          <button
            key={item.mode}
            type="button"
            onClick={() => addBlurEffect(item.mode)}
            className="min-h-[38px] px-2.5 py-1.5 rounded-xl bg-[#18181D] hover:bg-violet-600/20 border border-white/[0.08] hover:border-violet-500/50 text-xs font-medium text-zinc-100 flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5 text-violet-400 shrink-0" />
            <span className="truncate">{item.label}</span>
          </button>
        ))}
      </div>

      {/* SECTION 3: Independent Blur Masks List */}
      {project.blurs.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] text-zinc-400 px-0.5">
            <span>Active Blur Masks ({project.blurs.length})</span>
            <span className="font-mono text-zinc-500">Independent Layers</span>
          </div>
          {project.blurs.map((b) => {
            const active = selectedBlur?.id === b.id;
            const linkMode = b.subtitleLink?.mode || 'manual';
            const intervals = resolveBlurIntervals(b, project);
            const spanStart = intervals[0]?.start ?? b.startTime;
            const spanEnd = intervals[intervals.length - 1]?.end ?? b.endTime;

            return (
              <div
                key={b.id}
                onClick={() => onSelectBlur(b.id)}
                className={`px-3 py-2 rounded-xl border flex items-center justify-between gap-2 cursor-pointer text-xs ${
                  active
                    ? b.isSubtitleMask
                      ? 'bg-sky-600/15 border-sky-500/60 text-white'
                      : 'bg-violet-600/15 border-violet-500/60 text-white'
                    : 'bg-[#18181D] border-white/[0.06] text-zinc-300'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-medium truncate">{b.name}</span>
                    {linkMode !== 'manual' && (
                      <span className="px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 text-[9.5px] font-mono uppercase shrink-0">
                        {linkMode === 'translated' ? 'Trans Sync' : 'Orig Sync'}
                      </span>
                    )}
                  </div>
                  <div className="text-[10.5px] text-zinc-500 font-mono truncate mt-0.5">
                    {intervals.length > 1
                      ? `${intervals.length} intervals (${formatSpan(spanStart, spanEnd)})`
                      : formatSpan(spanStart, spanEnd)}
                    {' • '}
                    {b.type}
                  </div>
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      duplicateBlur(b);
                    }}
                    className="min-w-[30px] min-h-[30px] flex items-center justify-center rounded-lg hover:bg-white/[0.06] text-zinc-400 hover:text-white cursor-pointer"
                    title="Duplicate mask"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      updateBlur(b.id, { locked: !b.locked });
                    }}
                    className={`min-w-[30px] min-h-[30px] flex items-center justify-center rounded-lg hover:bg-white/[0.06] cursor-pointer ${
                      b.locked ? 'text-amber-400' : 'text-zinc-500 hover:text-zinc-200'
                    }`}
                    title={b.locked ? 'Unlock' : 'Lock'}
                  >
                    {b.locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      updateBlur(b.id, { enabled: !b.enabled });
                    }}
                    className="min-w-[30px] min-h-[30px] flex items-center justify-center rounded-lg hover:bg-white/[0.06] text-zinc-400 hover:text-white cursor-pointer"
                    title={b.enabled ? 'Hide mask' : 'Show mask'}
                  >
                    {b.enabled ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeBlur(b.id);
                    }}
                    className="min-w-[30px] min-h-[30px] flex items-center justify-center rounded-lg hover:bg-white/[0.06] text-zinc-500 hover:text-red-400 cursor-pointer"
                    title="Delete mask"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* SECTION 4: Selected Mask Editor */}
      {selectedBlur && (
        <div className="space-y-3">
          {selectedBlur.locked && (
            <div className="px-3 py-2 rounded-xl bg-amber-500/12 border border-amber-500/35 text-xs text-amber-200 flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 min-w-0">
                <Lock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span className="truncate">Layer locked — editing blocked</span>
              </span>
              <button
                type="button"
                onClick={() => updateBlur(selectedBlur.id, { locked: false })}
                className="min-h-[28px] px-2.5 py-0.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 text-[11px] font-semibold text-amber-100 shrink-0 cursor-pointer"
              >
                Unlock
              </button>
            </div>
          )}
          <div className="p-3 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-3">
            {/* Mask Name + Reset */}
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={selectedBlur.name}
                onChange={(e) =>
                  updateBlur(
                    selectedBlur.id,
                    { name: e.target.value },
                    { undoGroupKey: `blur:${selectedBlur.id}:name`, debounceMs: 250 }
                  )
                }
                aria-label="Blur mask name"
                className="flex-1 min-w-0 bg-zinc-900 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs font-medium text-white"
              />
              <button
                type="button"
                onClick={() =>
                  updateBlur(selectedBlur.id, {
                    type: selectedBlur.isSubtitleMask ? 'strong' : 'gaussian',
                    radius: selectedBlur.isSubtitleMask ? 28 : 16,
                    intensity: selectedBlur.isSubtitleMask ? 28 : 16,
                    opacity: 1,
                    feather: 10,
                    borderRadius: selectedBlur.isSubtitleMask ? 8 : 0,
                    rotation: 0,
                  })
                }
                title="Reset blur settings"
                className="min-h-[34px] px-2.5 rounded-lg bg-zinc-900 border border-white/[0.08] text-[11px] text-zinc-300 hover:text-white flex items-center gap-1 cursor-pointer shrink-0"
              >
                <RotateCcw className="w-3 h-3" />
                Reset
              </button>
            </div>

            {/* Blur Type Selector (Gaussian, Strong, Pixelation/Mosaic, Box) */}
            <div>
              <span className="text-[10.5px] text-zinc-400 block mb-1">Blur Method</span>
              <div className="grid grid-cols-4 gap-1 bg-zinc-900 p-0.5 rounded-lg border border-white/[0.06]">
                {(
                  [
                    { id: 'gaussian', label: 'Gaussian' },
                    { id: 'strong', label: 'Strong' },
                    { id: 'pixelate', label: 'Mosaic' },
                    { id: 'box', label: 'Box' },
                  ] as Array<{ id: BlurType; label: string }>
                ).map((bt) => (
                  <button
                    key={bt.id}
                    type="button"
                    onClick={() => updateBlur(selectedBlur.id, { type: bt.id })}
                    className={`min-h-[32px] py-1 rounded text-[11px] font-medium cursor-pointer ${
                      selectedBlur.type === bt.id
                        ? 'bg-violet-600 text-white'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {bt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Intensity, Opacity, Feather, Border Radius */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <div className="flex justify-between text-[11px] text-zinc-300 mb-1">
                  <span>Intensity</span>
                  <span className="font-mono text-violet-300 tabular-nums">
                    {selectedBlur.radius}
                  </span>
                </div>
                <input
                  type="range"
                  min={3}
                  max={45}
                  value={selectedBlur.radius}
                  onChange={(e) =>
                    updateBlur(
                      selectedBlur.id,
                      {
                        radius: Number(e.target.value),
                        intensity: Number(e.target.value),
                      },
                      { undoGroupKey: `blur:${selectedBlur.id}:radius`, debounceMs: 220 }
                    )
                  }
                  className="w-full accent-violet-500"
                />
              </div>

              <div>
                <div className="flex justify-between text-[11px] text-zinc-300 mb-1">
                  <span>Opacity</span>
                  <span className="font-mono text-violet-300 tabular-nums">
                    {Math.round((selectedBlur.opacity ?? 1) * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={selectedBlur.opacity ?? 1}
                  onChange={(e) =>
                    updateBlur(
                      selectedBlur.id,
                      { opacity: Number(e.target.value) },
                      { undoGroupKey: `blur:${selectedBlur.id}:opacity`, debounceMs: 220 }
                    )
                  }
                  className="w-full accent-violet-500"
                />
              </div>

              <div>
                <div className="flex justify-between text-[11px] text-zinc-300 mb-1">
                  <span>Feather</span>
                  <span className="font-mono text-violet-300 tabular-nums">
                    {selectedBlur.feather ?? 10}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={30}
                  value={selectedBlur.feather ?? 10}
                  onChange={(e) =>
                    updateBlur(
                      selectedBlur.id,
                      { feather: Number(e.target.value) },
                      { undoGroupKey: `blur:${selectedBlur.id}:feather`, debounceMs: 220 }
                    )
                  }
                  className="w-full accent-violet-500"
                />
              </div>

              <div>
                <div className="flex justify-between text-[11px] text-zinc-300 mb-1">
                  <span>Border Radius</span>
                  <span className="font-mono text-violet-300 tabular-nums">
                    {Math.round(selectedBlur.borderRadius ?? 0)}px
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={48}
                  value={selectedBlur.borderRadius ?? 0}
                  disabled={selectedBlur.shape === 'ellipse'}
                  onChange={(e) =>
                    updateBlur(
                      selectedBlur.id,
                      { borderRadius: Number(e.target.value) },
                      { undoGroupKey: `blur:${selectedBlur.id}:borderRadius`, debounceMs: 220 }
                    )
                  }
                  className="w-full accent-violet-500 disabled:opacity-40"
                />
              </div>
            </div>

            {/* Region Draw, Shape & Position/Size */}
            {(selectedBlur.mode === 'selective' || selectedBlur.mode === 'motion') && (
              <>
                <div className="flex flex-wrap gap-2 pt-1 border-t border-white/[0.06]">
                  <button
                    type="button"
                    onClick={() => {
                      if (selectedBlur.locked) {
                        notifyLocked();
                        return;
                      }
                      onSetDrawMode(
                        drawMode === selectedBlur.mode
                          ? 'none'
                          : (selectedBlur.mode as 'selective' | 'motion')
                      );
                    }}
                    className={`min-h-[38px] flex-1 px-3 py-1.5 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 cursor-pointer ${
                      drawMode === selectedBlur.mode
                        ? 'bg-violet-600 text-white'
                        : 'bg-zinc-900 hover:bg-zinc-800 border border-white/[0.08] text-zinc-200'
                    }`}
                  >
                    <SquareDashed className="w-3.5 h-3.5" />
                    {drawMode === selectedBlur.mode ? 'Drag on Video...' : 'Draw Region on Video'}
                  </button>

                  <select
                    value={selectedBlur.shape}
                    onChange={(e) =>
                      updateBlur(selectedBlur.id, {
                        shape: e.target.value as 'rect' | 'ellipse',
                      })
                    }
                    aria-label="Blur shape"
                    className="min-h-[38px] bg-zinc-900 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-zinc-100"
                  >
                    <option value="rect">Rectangle</option>
                    <option value="ellipse">Ellipse</option>
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div>
                    <div className="flex justify-between text-[11px] text-zinc-300">
                      <span>Position X</span>
                      <span className="font-mono">{Math.round(selectedBlur.x * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(5, Math.round((1 - selectedBlur.width) * 100))}
                      value={Math.round(selectedBlur.x * 100)}
                      onChange={(e) => {
                        const clamped = clampNormBox({
                          x: Number(e.target.value) / 100,
                          y: selectedBlur.y,
                          width: selectedBlur.width,
                          height: selectedBlur.height,
                        });
                        updateBlur(
                          selectedBlur.id,
                          { ...clamped, keyframes: undefined },
                          { undoGroupKey: `blur:${selectedBlur.id}:pos`, debounceMs: 220 }
                        );
                      }}
                      className="mt-1 w-full accent-violet-500"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between text-[11px] text-zinc-300">
                      <span>Position Y</span>
                      <span className="font-mono">{Math.round(selectedBlur.y * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(5, Math.round((1 - selectedBlur.height) * 100))}
                      value={Math.round(selectedBlur.y * 100)}
                      onChange={(e) => {
                        const clamped = clampNormBox({
                          x: selectedBlur.x,
                          y: Number(e.target.value) / 100,
                          width: selectedBlur.width,
                          height: selectedBlur.height,
                        });
                        updateBlur(
                          selectedBlur.id,
                          { ...clamped, keyframes: undefined },
                          { undoGroupKey: `blur:${selectedBlur.id}:pos`, debounceMs: 220 }
                        );
                      }}
                      className="mt-1 w-full accent-violet-500"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between text-[11px] text-zinc-300">
                      <span>Width</span>
                      <span className="font-mono">{Math.round(selectedBlur.width * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={3}
                      max={100}
                      value={Math.round(selectedBlur.width * 100)}
                      onChange={(e) => {
                        const clamped = clampNormBox({
                          x: selectedBlur.x,
                          y: selectedBlur.y,
                          width: Number(e.target.value) / 100,
                          height: selectedBlur.height,
                        });
                        updateBlur(
                          selectedBlur.id,
                          { ...clamped, keyframes: undefined },
                          { undoGroupKey: `blur:${selectedBlur.id}:size`, debounceMs: 220 }
                        );
                      }}
                      className="mt-1 w-full accent-violet-500"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between text-[11px] text-zinc-300">
                      <span>Height</span>
                      <span className="font-mono">{Math.round(selectedBlur.height * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={3}
                      max={100}
                      value={Math.round(selectedBlur.height * 100)}
                      onChange={(e) => {
                        const clamped = clampNormBox({
                          x: selectedBlur.x,
                          y: selectedBlur.y,
                          width: selectedBlur.width,
                          height: Number(e.target.value) / 100,
                        });
                        updateBlur(
                          selectedBlur.id,
                          { ...clamped, keyframes: undefined },
                          { undoGroupKey: `blur:${selectedBlur.id}:size`, debounceMs: 220 }
                        );
                      }}
                      className="mt-1 w-full accent-violet-500"
                    />
                  </div>
                </div>
              </>
            )}

            {/* Caption Synchronization & Timing */}
            <div className="pt-2 border-t border-white/[0.06] space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <Link2 className="w-3.5 h-3.5 text-sky-400" />
                  <span className="text-[11px] font-medium text-zinc-200">
                    Caption Synchronization
                  </span>
                </div>
                {currentLinkMode !== 'manual' && (
                  <button
                    type="button"
                    onClick={() => handleSetSubtitleLink(selectedBlur, { mode: 'manual' })}
                    className="text-[10.5px] text-zinc-300 hover:text-white flex items-center gap-1 cursor-pointer"
                  >
                    <Unlink className="w-3 h-3" />
                    Unlink
                  </button>
                )}
              </div>

              <div className="grid grid-cols-3 gap-1 bg-zinc-900 p-0.5 rounded-lg border border-white/[0.06]">
                {(
                  [
                    { id: 'manual', label: 'Manual' },
                    { id: 'original', label: 'Original Subs' },
                    { id: 'translated', label: 'Translated' },
                  ] as const
                ).map((modeOpt) => (
                  <button
                    key={modeOpt.id}
                    type="button"
                    onClick={() =>
                      handleSetSubtitleLink(
                        selectedBlur,
                        modeOpt.id === 'manual'
                          ? { mode: 'manual' }
                          : {
                              mode: modeOpt.id,
                              followAllCaptions:
                                selectedBlur.subtitleLink?.followAllCaptions ?? true,
                              segmentId: selectedBlur.subtitleLink?.segmentId,
                            }
                      )
                    }
                    className={`min-h-[32px] py-1 px-1.5 rounded text-[11px] font-medium cursor-pointer ${
                      currentLinkMode === modeOpt.id
                        ? 'bg-sky-600 text-white'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {modeOpt.label}
                  </button>
                ))}
              </div>

              {currentLinkMode === 'manual' ? (
                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <div className="flex items-center justify-between">
                      <label className="text-[10.5px] text-zinc-400">Start Time (s)</label>
                      <button
                        type="button"
                        onClick={() =>
                          updateBlur(selectedBlur.id, {
                            startTime: Math.min(
                              Math.max(0, Number(currentTime.toFixed(2))),
                              Math.max(0, selectedBlur.endTime - 0.2)
                            ),
                          })
                        }
                        className="text-[10px] text-violet-400 hover:text-violet-300 font-medium cursor-pointer"
                      >
                        Set Now
                      </button>
                    </div>
                    <input
                      type="number"
                      min={0}
                      max={duration}
                      step={0.1}
                      value={selectedBlur.startTime}
                      onChange={(e) => {
                        const nextStart = Math.max(0, Number(e.target.value) || 0);
                        updateBlur(selectedBlur.id, {
                          startTime: nextStart,
                          endTime: Math.max(nextStart + 0.15, selectedBlur.endTime),
                        });
                      }}
                      className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded px-2.5 py-1.5 text-xs font-mono text-zinc-100"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between">
                      <label className="text-[10.5px] text-zinc-400">End Time (s)</label>
                      <button
                        type="button"
                        onClick={() =>
                          updateBlur(selectedBlur.id, {
                            endTime: Math.max(
                              Math.min(duration, Number(currentTime.toFixed(2))),
                              selectedBlur.startTime + 0.2
                            ),
                          })
                        }
                        className="text-[10px] text-violet-400 hover:text-violet-300 font-medium cursor-pointer"
                      >
                        Set Now
                      </button>
                    </div>
                    <input
                      type="number"
                      min={0}
                      max={duration}
                      step={0.1}
                      value={selectedBlur.endTime}
                      onChange={(e) => {
                        const nextEnd = Math.max(
                          selectedBlur.startTime + 0.15,
                          Number(e.target.value) || 0.2
                        );
                        updateBlur(selectedBlur.id, { endTime: nextEnd });
                      }}
                      className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded px-2.5 py-1.5 text-xs font-mono text-zinc-100"
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <select
                    value={
                      selectedBlur.subtitleLink?.followAllCaptions ||
                      !selectedBlur.subtitleLink?.segmentId
                        ? '__all__'
                        : selectedBlur.subtitleLink.segmentId
                    }
                    onChange={(e) => {
                      const val = e.target.value;
                      handleSetSubtitleLink(selectedBlur, {
                        mode: currentLinkMode,
                        followAllCaptions: val === '__all__',
                        segmentId: val === '__all__' ? undefined : val,
                      });
                    }}
                    aria-label="Linked caption target"
                    className="w-full min-h-[36px] bg-zinc-900 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-zinc-100"
                  >
                    <option value="__all__">
                      Follow All Captions ({project.captions.length} segments)
                    </option>
                    {project.captions.map((cap, i) => {
                      const snippet = (
                        currentLinkMode === 'translated'
                          ? cap.translatedText || cap.text
                          : cap.text
                      ).slice(0, 34);
                      return (
                        <option key={cap.id} value={cap.id}>
                          #{i + 1} ({formatSpan(cap.start, cap.end)}) {snippet || '(Empty)'}
                        </option>
                      );
                    })}
                  </select>

                  <div className="p-2 rounded-lg bg-zinc-900/90 border border-white/[0.06] text-[10.5px] text-zinc-400 space-y-1">
                    {selectedIntervals.length > 0 ? (
                      <div className="font-mono text-sky-300">
                        Active ({selectedIntervals.length}):{' '}
                        {selectedIntervals
                          .slice(0, 4)
                          .map((iv) => formatSpan(iv.start, iv.end))
                          .join(', ')}
                        {selectedIntervals.length > 4
                          ? ` +${selectedIntervals.length - 4} more`
                          : ''}
                      </div>
                    ) : (
                      <div className="text-amber-300">
                        No caption segments exist yet. Add captions or switch back to Manual timing.
                      </div>
                    )}
                    <p>
                      Linked timing updates automatically without altering caption text, caption duration, audio sync, or video length.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          <CollapsibleSection
            title="More, Exact Bounds & Tracking"
            subtitle="Numeric X/Y/W/H, coordinate space, rotation & motion tracking"
            badge={
              selectedBlur.keyframes?.length
                ? `${selectedBlur.keyframes.length} keys`
                : selectedBlur.maskAssetId
                ? 'Matte'
                : selectedBlur.coordSpace === 'video'
                ? 'Video Coords'
                : undefined
            }
            open={memory.blurAdvancedOpen}
            onToggle={(open) => onUpdateMemory({ blurAdvancedOpen: open })}
          >
            {selectedBlur.mode === 'motion' && (
              <button
                type="button"
                onClick={() => void handleRunMotionTracking(selectedBlur)}
                disabled={trackingPct !== null}
                className="min-h-[40px] w-full py-2 px-3 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center justify-center gap-1.5 cursor-pointer"
              >
                {trackingPct !== null ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Crosshair className="w-3.5 h-3.5" />
                )}
                {trackingPct !== null
                  ? `Tracking (${trackingPct}%)...`
                  : `Track Moving Object${
                      selectedBlur.keyframes?.length ? ` (${selectedBlur.keyframes.length} keys)` : ''
                    }`}
              </button>
            )}

            {selectedBlur.mode === 'background' && (
              <button
                type="button"
                onClick={() => void handleCaptureForegroundMatte(selectedBlur)}
                disabled={segmentBusy}
                className="min-h-[40px] w-full py-2 px-3 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center justify-center gap-1.5 cursor-pointer"
              >
                {segmentBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {segmentBusy
                  ? 'Segmenting Foreground...'
                  : selectedBlur.maskAssetId
                  ? 'Re-Capture Subject Sharpness Matte'
                  : 'Generate Subject Sharpness Matte'}
              </button>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <div className="flex justify-between text-[11px] text-zinc-400">
                  <span>Rotation</span>
                  <span className="font-mono tabular-nums">
                    {Math.round(selectedBlur.rotation ?? 0)}°
                  </span>
                </div>
                <input
                  type="range"
                  min={-180}
                  max={180}
                  value={selectedBlur.rotation ?? 0}
                  onChange={(e) =>
                    updateBlur(
                      selectedBlur.id,
                      { rotation: Number(e.target.value) },
                      { undoGroupKey: `blur:${selectedBlur.id}:rot`, debounceMs: 220 }
                    )
                  }
                  className="mt-1 w-full accent-violet-500"
                />
              </div>

              {(selectedBlur.mode === 'selective' || selectedBlur.mode === 'motion') && (
                <div>
                  <span className="text-[11px] text-zinc-400 block mb-1">Coordinate Anchor</span>
                  <select
                    value={selectedBlur.coordSpace || 'stage'}
                    onChange={(e) =>
                      updateBlur(selectedBlur.id, {
                        coordSpace: e.target.value as 'video' | 'stage',
                      })
                    }
                    aria-label="Coordinate space"
                    className="w-full bg-zinc-900 border border-white/[0.08] rounded px-2 py-1 text-xs text-zinc-200"
                  >
                    <option value="video">Original Video Frame (Recommended)</option>
                    <option value="stage">Export Stage Canvas</option>
                  </select>
                </div>
              )}
            </div>

            {(selectedBlur.mode === 'selective' || selectedBlur.mode === 'motion') && (
              <div className="grid grid-cols-4 gap-2 pt-2 border-t border-white/[0.06] text-[11px] font-mono">
                {(
                  [
                    { label: 'X', val: selectedBlur.x, key: 'x' },
                    { label: 'Y', val: selectedBlur.y, key: 'y' },
                    { label: 'W', val: selectedBlur.width, key: 'width' },
                    { label: 'H', val: selectedBlur.height, key: 'height' },
                  ] as const
                ).map((c) => (
                  <div key={c.label}>
                    <span className="text-zinc-500">{c.label}</span>
                    <input
                      type="number"
                      step={0.01}
                      min={0}
                      max={1}
                      value={Number(c.val.toFixed(3))}
                      onChange={(e) => {
                        const rawVal = Number(e.target.value);
                        if (!Number.isFinite(rawVal)) return;
                        const clamped = clampNormBox({
                          x: selectedBlur.x,
                          y: selectedBlur.y,
                          width: selectedBlur.width,
                          height: selectedBlur.height,
                          [c.key]: rawVal,
                        });
                        updateBlur(
                          selectedBlur.id,
                          { ...clamped, keyframes: undefined },
                          { undoGroupKey: `blur:${selectedBlur.id}:num`, debounceMs: 220 }
                        );
                      }}
                      className="mt-0.5 w-full bg-zinc-900 border border-white/[0.08] rounded px-1.5 py-1 text-zinc-200"
                    />
                  </div>
                ))}
              </div>
            )}
          </CollapsibleSection>
        </div>
      )}
    </div>
  );
}
