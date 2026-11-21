import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Captions,
  Copy,
  Droplet,
  Eye,
  EyeOff,
  Film,
  Layers,
  Layers3,
  Lock,
  Maximize2,
  Mic,
  Minimize2,
  Music,
  Plus,
  Redo2,
  Scissors,
  Sparkles,
  Trash2,
  Type,
  Undo2,
  Unlink,
  Unlock,
  Volume2,
  VolumeX,
  Wand2,
  Zap,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import {
  DEFAULT_VIDEO_CANVAS,
  DEFAULT_VIDEO_EFFECTS,
  FilmstripFrame,
  NavPage,
  Project,
  ProjectAudioWaveforms,
  ProjectPatchFn,
  StudioElementSelection,
  StudioToolId,
} from '../types/studio';
import { formatTimecode } from '../lib/formatters';
import { api } from '../lib/api';
import {
  createWorkflowUpdate,
  getSyncedCaptionsForPreview,
  updateCaptionTimingWithSync,
} from '../lib/workflowStages';
import {
  detectVideoTimelineMismatches,
  getEffectiveBgmClips,
  getEffectiveOriginalAudioClips,
  getEffectiveSfxClips,
  getEffectiveVideoClips,
  getOriginalAudioClipTimelineEnd,
  getProjectEffectiveDuration,
  getTimelineAudioClipEnd,
  getVideoClipTimelineDuration,
  getVideoClipTimelineEnd,
  getVideoTimelineTotalDuration,
  unlinkVideoClipAudio,
} from '../lib/videoTimeline';
import { getBlurTimelineSpan, resolveBlurIntervals } from '../lib/blurMasks';
import { getEffectCatalogEntry, getFilterPresetMeta } from '../lib/videoFiltersCatalog';
import {
  getSelectedLayerTiming,
  isTrackLocked,
  LOCKED_LAYER_MESSAGE,
  TimelineTrackId,
  toggleSelectionLockPatch,
  toggleTrackLockPatch,
} from '../lib/layerLock';

interface TimelineEditorProps {
  project: Project;
  currentTime: number;
  onSeek: (time: number) => void;
  onNavigate?: (page: NavPage) => void;
  onProjectUpdated?: (p: Project) => void;
  onPatchProject?: ProjectPatchFn;
  selectedElement?: StudioElementSelection;
  onSelectElement?: (el: StudioElementSelection) => void;
  onOpenTool?: (tool: StudioToolId, subTab?: string) => void;
  onRequestAddMedia?: () => void;
  onSplitAtPlayhead?: () => void;
  onDuplicateSelected?: () => void;
  onDeleteSelected?: () => void;
  onUndo?: () => void;
  canUndo?: boolean;
  onRedo?: () => void;
  canRedo?: boolean;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  onNotify?: (msg: string) => void;
}

type TrackDensity = 'compact' | 'standard' | 'tall';

interface ClipDragState {
  kind:
    | 'blur'
    | 'logo'
    | 'caption-element'
    | 'caption'
    | 'dub-clip'
    | 'video-clip'
    | 'orig-clip'
    | 'bgm-clip'
    | 'sfx-clip'
    | 'filter-item'
    | 'effect-item';
  id: string;
  mode: 'move' | 'trim-start' | 'trim-end';
  startClientX: number;
  origStart: number;
  origEnd: number;
  origTrimStart?: number;
  maxAudioDuration?: number;
  origSourceStart?: number;
  origSourceEnd?: number;
  clipSpeed?: number;
  maxSourceDuration?: number;
  locked?: boolean;
  hasMoved: boolean;
}

function computeClipGeometry(start: number, end: number, totalDuration: number) {
  const safeDur = Math.max(0.01, totalDuration);
  const clampedStart = Math.max(0, start);
  const clampedEnd = Math.max(clampedStart, end);
  const left = Math.max(0, Math.min(100, (clampedStart / safeDur) * 100));
  const width = Math.max(0, Math.min(100 - left, ((clampedEnd - clampedStart) / safeDur) * 100));
  return { left, width };
}

function WaveformSvg({
  peaks,
  color,
  mutedColor = 'rgba(161, 161, 170, 0.35)',
  muted = false,
  bars = 72,
  className = '',
}: {
  peaks: number[];
  color: string;
  mutedColor?: string;
  muted?: boolean;
  bars?: number;
  className?: string;
}) {
  const sampled = useMemo(() => {
    if (!peaks || peaks.length === 0) return [];
    const out: number[] = [];
    for (let i = 0; i < bars; i++) {
      const startIdx = Math.floor((i / bars) * peaks.length);
      const endIdx = Math.max(startIdx + 1, Math.floor(((i + 1) / bars) * peaks.length));
      let peak = 0;
      for (let j = startIdx; j < endIdx && j < peaks.length; j++) {
        if (peaks[j] > peak) peak = peaks[j];
      }
      out.push(Math.max(0.08, Math.min(1, peak)));
    }
    return out;
  }, [peaks, bars]);

  if (sampled.length === 0) return null;

  const fill = muted ? mutedColor : color;
  const viewWidth = bars * 4;
  const viewHeight = 32;

  return (
    <svg
      viewBox={`0 0 ${viewWidth} ${viewHeight}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      className={`w-full h-full pointer-events-none select-none ${className}`}
    >
      {sampled.map((v, i) => {
        const barH = Math.max(3, Math.round(v * (viewHeight - 4)));
        const y = Math.round((viewHeight - barH) / 2);
        return (
          <rect
            key={i}
            x={i * 4 + 0.75}
            y={y}
            width={2.5}
            height={barH}
            rx={1}
            fill={fill}
          />
        );
      })}
    </svg>
  );
}

function slicePeaksByRatio(
  peaks: number[],
  startRatio: number,
  endRatio: number
): number[] {
  if (!peaks || peaks.length === 0) return [];
  const s = Math.max(0, Math.min(peaks.length - 1, Math.floor(startRatio * peaks.length)));
  const e = Math.max(s + 1, Math.min(peaks.length, Math.ceil(endRatio * peaks.length)));
  return peaks.slice(s, e);
}

export function TimelineEditor({
  project,
  currentTime,
  onSeek,
  onNavigate,
  onProjectUpdated,
  onPatchProject,
  selectedElement,
  onSelectElement,
  onOpenTool,
  onRequestAddMedia,
  onSplitAtPlayhead,
  onDuplicateSelected,
  onDeleteSelected,
  onUndo,
  canUndo = false,
  onRedo,
  canRedo = false,
  expanded = false,
  onToggleExpanded,
  onNotify,
}: TimelineEditorProps) {
  const [zoom, setZoom] = useState(1);
  const [density, setDensity] = useState<TrackDensity>('standard');
  const [mobileShowAllTracks, setMobileShowAllTracks] = useState(false);
  const [filmstripFrames, setFilmstripFrames] = useState<FilmstripFrame[]>([]);
  const [audioWaveforms, setAudioWaveforms] = useState<ProjectAudioWaveforms | null>(null);
  const [dragTooltip, setDragTooltip] = useState<{ xPct: number; label: string } | null>(null);

  const leftColRef = useRef<HTMLDivElement>(null);
  const rightColRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const trackAreaRef = useRef<HTMLDivElement>(null);
  const lastSyncedTopRef = useRef(0);
  const [centerHScrollbarPx, setCenterHScrollbarPx] = useState(0);
  const scrubbingRef = useRef(false);
  const clipDragRef = useRef<ClipDragState | null>(null);
  const suppressClickRef = useRef(false);
  const projectRef = useRef(project);
  projectRef.current = project;

  useEffect(() => {
    const centerEl = scrollContainerRef.current;
    if (!centerEl) return;
    const measureScrollbar = () => {
      const hBar = Math.max(0, centerEl.offsetHeight - centerEl.clientHeight);
      setCenterHScrollbarPx(hBar);
    };
    measureScrollbar();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measureScrollbar);
      ro.observe(centerEl);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', measureScrollbar);
    return () => window.removeEventListener('resize', measureScrollbar);
  }, [zoom, density, expanded]);

  const syncVerticalFromCenter = useCallback(() => {
    const center = scrollContainerRef.current;
    if (!center) return;
    const top = center.scrollTop;
    if (Math.abs(top - lastSyncedTopRef.current) <= 0.5) return;
    lastSyncedTopRef.current = top;
    if (leftColRef.current && Math.abs(leftColRef.current.scrollTop - top) > 0.5) {
      leftColRef.current.scrollTop = top;
    }
    if (rightColRef.current && Math.abs(rightColRef.current.scrollTop - top) > 0.5) {
      rightColRef.current.scrollTop = top;
    }
  }, []);

  const syncVerticalFromSide = useCallback((source: HTMLDivElement | null) => {
    if (!source) return;
    const top = source.scrollTop;
    if (Math.abs(top - lastSyncedTopRef.current) <= 0.5) return;
    lastSyncedTopRef.current = top;
    if (scrollContainerRef.current && Math.abs(scrollContainerRef.current.scrollTop - top) > 0.5) {
      scrollContainerRef.current.scrollTop = top;
    }
    if (
      leftColRef.current &&
      leftColRef.current !== source &&
      Math.abs(leftColRef.current.scrollTop - top) > 0.5
    ) {
      leftColRef.current.scrollTop = top;
    }
    if (
      rightColRef.current &&
      rightColRef.current !== source &&
      Math.abs(rightColRef.current.scrollTop - top) > 0.5
    ) {
      rightColRef.current.scrollTop = top;
    }
  }, []);

  // Fetch real FFmpeg-extracted video filmstrip thumbnails
  useEffect(() => {
    let cancelled = false;
    if (!project.id || !project.sourceVideoUrl) {
      setFilmstripFrames([]);
      return;
    }
    void api
      .getTimelineFilmstrip(project.id, 32)
      .then((res) => {
        if (!cancelled) {
          setFilmstripFrames(res.frames || []);
        }
      })
      .catch(() => {
        if (!cancelled) setFilmstripFrames([]);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, project.sourceVideoUrl]);

  // Fetch real PCM audio waveforms (narration, original, music, sfx)
  useEffect(() => {
    let cancelled = false;
    if (!project.id) {
      setAudioWaveforms(null);
      return;
    }
    void api
      .getAudioWaveforms(project.id)
      .then((res) => {
        if (!cancelled) {
          setAudioWaveforms(res);
        }
      })
      .catch(() => {
        if (!cancelled) setAudioWaveforms(null);
      });
    return () => {
      cancelled = true;
    };
  }, [
    project.id,
    project.sourceVideoUrl,
    project.voice.fullDubUrl,
    project.voice.generatedClips.length,
    project.voice.bgMusicUrl,
    project.voice.bgMusicClips?.length,
    project.voice.sfxUrl,
    project.voice.sfxClips?.length,
  ]);

  const syncedCaptions = useMemo(() => getSyncedCaptionsForPreview(project), [project]);
  const videoClips = useMemo(() => getEffectiveVideoClips(project), [project]);
  const originalAudioClips = useMemo(() => getEffectiveOriginalAudioClips(project), [project]);
  const hasUnlinkedAudio = originalAudioClips.length > 0;
  const mismatches = useMemo(() => detectVideoTimelineMismatches(project), [project]);
  const srcDuration = Math.max(0.5, project.metadata?.duration || 12);
  const duration = useMemo(() => getProjectEffectiveDuration(project), [project]);
  const bgmClips = useMemo(() => getEffectiveBgmClips(project, duration), [project, duration]);
  const sfxClips = useMemo(() => getEffectiveSfxClips(project, duration), [project, duration]);
  const playheadPct = Math.max(0, Math.min(100, (currentTime / Math.max(0.01, duration)) * 100));

  const fxConfig = project.videoEffects || DEFAULT_VIDEO_EFFECTS;
  const allVisualEffects = fxConfig.effects || [];
  const activeVisualEffects = useMemo(
    () => allVisualEffects.filter((e) => e.enabled),
    [allVisualEffects]
  );
  const filterStack = fxConfig.filterStack || [];
  const activeFilterLayers = useMemo(
    () => filterStack.filter((f) => f.enabled),
    [filterStack]
  );

  const canvasConfig = { ...DEFAULT_VIDEO_CANVAS, ...(project.canvas || {}) };
  const videoVisible = canvasConfig.videoVisible !== false;
  const overlaysVisible =
    project.logos.some((l) => l.enabled) ||
    (project.subtitleStyle.extraElements || []).some((el) => el.visible);
  const captionsVisible = project.subtitleStyle.visible !== false && project.subtitleStyle.enabled;
  const blursVisible = project.blurs.some((b) => b.enabled);
  const filtersVisible =
    fxConfig.filterPreset !== 'none' || activeFilterLayers.length > 0;
  const effectsVisible = activeVisualEffects.length > 0;

  const hasDubAudio = Boolean(project.voice.fullDubUrl || project.voice.generatedClips.length > 0);
  const dubMuted = Boolean(
    !hasDubAudio ||
      project.voice.voiceMuted ||
      !project.voice.enabled ||
      (project.voice.voiceVolume ?? 1) <= 0.01
  );
  const origAudioEnabled =
    project.voice.originalAudioEnabled !== undefined
      ? Boolean(project.voice.originalAudioEnabled)
      : Boolean(project.voice.preserveOriginalAudio);
  const origAudioMuted =
    project.voice.originalAudioMuted !== undefined
      ? Boolean(project.voice.originalAudioMuted)
      : !Boolean(project.voice.preserveOriginalAudio);
  const origTrackMuted = Boolean(
    !project.sourceVideoUrl ||
      !origAudioEnabled ||
      origAudioMuted ||
      (project.voice.originalAudioVolume ?? 1) <= 0.01
  );
  const bgMusicMuted = Boolean(
    !project.voice.bgMusicUrl ||
      project.voice.bgMusicEnabled === false ||
      project.voice.bgMusicMuted ||
      (project.voice.bgMusicVolume ?? 0) <= 0.01
  );
  const sfxMuted = Boolean(
    !project.voice.sfxUrl ||
      project.voice.sfxEnabled === false ||
      project.voice.sfxMuted ||
      (project.voice.sfxVolume ?? 0) <= 0.01
  );

  const origPeaks = useMemo(() => {
    if (audioWaveforms?.orig && audioWaveforms.orig.length > 0) return audioWaveforms.orig;
    return project.waveformPeaks || [];
  }, [audioWaveforms?.orig, project.waveformPeaks]);

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const el = trackAreaRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      onSeek(Number((ratio * duration).toFixed(2)));
    },
    [duration, onSeek]
  );

  const handleRulerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    scrubbingRef.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    seekFromClientX(e.clientX);
  };

  const handleTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (e.pointerType === 'touch') {
      // Allow native touch scrolling across track lanes; ruler scrubbing handles touch dragging
      return;
    }
    scrubbingRef.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    seekFromClientX(e.clientX);
  };

  const handleTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current || clipDragRef.current) return;
    seekFromClientX(e.clientX);
  };

  const handleTrackPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return;
    seekFromClientX(e.clientX);
  };

  const handleTrackPointerUp = () => {
    scrubbingRef.current = false;
  };

  const patchProjectImmediate = (
    updater: Partial<Project> | ((cur: Project) => Partial<Project>)
  ) => {
    const curProj = projectRef.current;
    if (onPatchProject) {
      onPatchProject(
        curProj.id,
        (cur) => {
          const patch = typeof updater === 'function' ? updater(cur) : updater;
          return {
            ...patch,
            workflow: createWorkflowUpdate(cur.workflow, {
              modifiedStage: 'editor',
              hasExistingExport: Boolean(cur.lastExportUrl),
            }),
          };
        },
        { immediate: true }
      );
      return;
    }
    if (!onProjectUpdated) return;
    const patch = typeof updater === 'function' ? updater(curProj) : updater;
    const nextWorkflow = createWorkflowUpdate(curProj.workflow, {
      modifiedStage: 'editor',
      hasExistingExport: Boolean(curProj.lastExportUrl),
    });
    const optimistic = { ...curProj, ...patch, workflow: nextWorkflow };
    onProjectUpdated(optimistic);
    void api
      .updateProject(curProj.id, { ...patch, workflow: nextWorkflow })
      .then(({ project: saved }) => onProjectUpdated(saved))
      .catch(() => {});
  };

  const selectedTiming = useMemo(
    () => getSelectedLayerTiming(project, selectedElement ?? null, currentTime),
    [project, selectedElement, currentTime]
  );

  const handleToggleTrackLock = useCallback(
    (trackId: TimelineTrackId) => {
      const res = toggleTrackLockPatch(projectRef.current, trackId);
      patchProjectImmediate(() => res.patch);
      onNotify?.(res.locked ? `Locked ${res.label}.` : `Unlocked ${res.label}.`);
    },
    [onNotify]
  );

  const handleToggleSelectedLock = useCallback(() => {
    const res = toggleSelectionLockPatch(projectRef.current, selectedElement ?? null, currentTime);
    if (!res) return;
    patchProjectImmediate(() => res.patch);
    onNotify?.(res.locked ? `Locked ${res.label}.` : `Unlocked ${res.label}.`);
  }, [currentTime, onNotify, selectedElement]);

  const startClipDrag = (
    e: React.PointerEvent<HTMLElement>,
    params: {
      kind: ClipDragState['kind'];
      id: string;
      mode: ClipDragState['mode'];
      origStart: number;
      origEnd: number;
      origTrimStart?: number;
      maxAudioDuration?: number;
      origSourceStart?: number;
      origSourceEnd?: number;
      clipSpeed?: number;
      maxSourceDuration?: number;
      locked?: boolean;
    }
  ) => {
    e.stopPropagation();
    if (params.locked && params.mode !== 'move') {
      onNotify?.(LOCKED_LAYER_MESSAGE);
      return;
    }
    const area = trackAreaRef.current;
    if (!area || (!onPatchProject && !onProjectUpdated)) return;

    const drag: ClipDragState = {
      ...params,
      startClientX: e.clientX,
      hasMoved: false,
    };
    clipDragRef.current = drag;
    let notifiedLocked = false;

    const minDur = 0.25;
    const buildClipPatch = (
      curProj: Project,
      nextStart: number,
      nextEnd: number,
      nextTrimStart?: number,
      nextSourceStart?: number,
      nextSourceEnd?: number
    ): Partial<Project> | null => {
      if (drag.kind === 'video-clip') {
        const baseClips = getEffectiveVideoClips(curProj);
        return {
          videoClips: baseClips
            .map((vc) =>
              vc.id === drag.id
                ? {
                    ...vc,
                    timelineStart: nextStart,
                    sourceStart: nextSourceStart ?? vc.sourceStart,
                    sourceEnd: nextSourceEnd ?? vc.sourceEnd,
                  }
                : vc
            )
            .sort((a, b) => a.timelineStart - b.timelineStart),
        };
      }
      if (drag.kind === 'orig-clip') {
        const baseOrig = getEffectiveOriginalAudioClips(curProj);
        return {
          originalAudioClips: baseOrig
            .map((oa) =>
              oa.id === drag.id
                ? {
                    ...oa,
                    timelineStart: nextStart,
                    sourceStart: nextSourceStart ?? oa.sourceStart,
                    sourceEnd: nextSourceEnd ?? oa.sourceEnd,
                  }
                : oa
            )
            .sort((a, b) => a.timelineStart - b.timelineStart),
        };
      }
      if (drag.kind === 'bgm-clip') {
        const effDur = getProjectEffectiveDuration(curProj);
        const baseBgm = getEffectiveBgmClips(curProj, effDur);
        return {
          voice: {
            ...curProj.voice,
            bgMusicClips: baseBgm
              .map((bc) =>
                bc.id === drag.id
                  ? {
                      ...bc,
                      timelineStart: nextStart,
                      sourceStart: nextSourceStart ?? bc.sourceStart,
                      sourceEnd: nextSourceEnd ?? bc.sourceEnd,
                    }
                  : bc
              )
              .sort((a, b) => a.timelineStart - b.timelineStart),
          },
        };
      }
      if (drag.kind === 'sfx-clip') {
        const effDur = getProjectEffectiveDuration(curProj);
        const baseSfx = getEffectiveSfxClips(curProj, effDur);
        return {
          voice: {
            ...curProj.voice,
            sfxClips: baseSfx
              .map((sc) =>
                sc.id === drag.id
                  ? {
                      ...sc,
                      timelineStart: nextStart,
                      sourceStart: nextSourceStart ?? sc.sourceStart,
                      sourceEnd: nextSourceEnd ?? sc.sourceEnd,
                    }
                  : sc
              )
              .sort((a, b) => a.timelineStart - b.timelineStart),
          },
        };
      }
      if (drag.kind === 'blur') {
        return {
          blurs: curProj.blurs.map((b) =>
            b.id === drag.id
              ? {
                  ...b,
                  startTime: nextStart,
                  endTime: nextEnd,
                  subtitleLink: { mode: 'manual' },
                  keyframes: undefined,
                }
              : b
          ),
        };
      }
      if (drag.kind === 'logo') {
        return {
          logos: curProj.logos.map((l) =>
            l.id === drag.id
              ? { ...l, permanent: false, startTime: nextStart, endTime: nextEnd }
              : l
          ),
        };
      }
      if (drag.kind === 'caption-element') {
        return {
          subtitleStyle: {
            ...curProj.subtitleStyle,
            extraElements: (curProj.subtitleStyle.extraElements || []).map((el) =>
              el.id === drag.id ? { ...el, startTime: nextStart, endTime: nextEnd } : el
            ),
          },
        };
      }
      if (drag.kind === 'filter-item') {
        const curFx = curProj.videoEffects || DEFAULT_VIDEO_EFFECTS;
        return {
          videoEffects: {
            ...curFx,
            filterStack: (curFx.filterStack || []).map((f) =>
              f.id === drag.id ? { ...f, startTime: nextStart, endTime: nextEnd } : f
            ),
          },
        };
      }
      if (drag.kind === 'effect-item') {
        const curFx = curProj.videoEffects || DEFAULT_VIDEO_EFFECTS;
        return {
          videoEffects: {
            ...curFx,
            effects: (curFx.effects || []).map((fx) =>
              fx.id === drag.id ? { ...fx, startTime: nextStart, endTime: nextEnd } : fx
            ),
          },
        };
      }
      if (drag.kind === 'caption') {
        return updateCaptionTimingWithSync(curProj, drag.id, nextStart, nextEnd);
      }
      if (drag.kind === 'dub-clip') {
        const nextClips = (curProj.voice.generatedClips || []).map((c) => {
          if (c.segmentId !== drag.id) return c;
          const trimStart =
            nextTrimStart !== undefined ? Number(nextTrimStart.toFixed(3)) : c.trimStartSec;
          const span = Math.max(0.2, nextEnd - nextStart);
          const maxAudioDur = Math.max(0.2, c.duration || span);
          const computedTrimEnd = (trimStart || 0) + span;
          return {
            ...c,
            start: nextStart,
            end: nextEnd,
            trimStartSec: trimStart && trimStart > 0.005 ? trimStart : undefined,
            trimEndSec:
              computedTrimEnd < maxAudioDur - 0.01
                ? Number(computedTrimEnd.toFixed(3))
                : undefined,
          };
        });
        const nextSyncPlan = curProj.voice.syncPlan
          ? {
              ...curProj.voice.syncPlan,
              segments: curProj.voice.syncPlan.segments.map((s) =>
                s.segmentId === drag.id
                  ? { ...s, syncedStart: nextStart, syncedEnd: nextEnd }
                  : s
              ),
            }
          : undefined;
        return {
          voice: {
            ...curProj.voice,
            generatedClips: nextClips,
            ...(nextSyncPlan ? { syncPlan: nextSyncPlan } : {}),
          },
        };
      }
      return null;
    };

    const applyTimes = (
      nextStart: number,
      nextEnd: number,
      nextTrimStart: number | undefined,
      commit: boolean,
      nextSourceStart?: number,
      nextSourceEnd?: number
    ) => {
      const curProj = projectRef.current;
      let builtClipsForRebuild: Project['voice']['generatedClips'] | null = null;
      if (drag.kind === 'dub-clip' && commit) {
        const previewPatch = buildClipPatch(curProj, nextStart, nextEnd, nextTrimStart);
        builtClipsForRebuild = previewPatch?.voice?.generatedClips || null;
      }

      if (onPatchProject) {
        onPatchProject(
          curProj.id,
          (cur) => {
            const patch = buildClipPatch(
              cur,
              nextStart,
              nextEnd,
              nextTrimStart,
              nextSourceStart,
              nextSourceEnd
            );
            if (!patch) return {};
            return {
              ...patch,
              workflow: createWorkflowUpdate(cur.workflow, {
                modifiedStage:
                  drag.kind === 'caption' || drag.kind === 'caption-element'
                    ? 'captions'
                    : drag.kind === 'dub-clip'
                    ? 'voice'
                    : 'editor',
                hasExistingExport: Boolean(cur.lastExportUrl),
              }),
            };
          },
          {
            undoGroupKey: `tl:${drag.kind}:${drag.id}`,
            immediate: commit,
            debounceMs: commit ? 0 : 250,
          }
        );
      } else if (onProjectUpdated) {
        const patch = buildClipPatch(
          curProj,
          nextStart,
          nextEnd,
          nextTrimStart,
          nextSourceStart,
          nextSourceEnd
        );
        if (!patch) return;
        const nextWorkflow = createWorkflowUpdate(curProj.workflow, {
          modifiedStage:
            drag.kind === 'caption' || drag.kind === 'caption-element'
              ? 'captions'
              : drag.kind === 'dub-clip'
              ? 'voice'
              : 'editor',
          hasExistingExport: Boolean(curProj.lastExportUrl),
        });
        onProjectUpdated({ ...curProj, ...patch, workflow: nextWorkflow });
        if (commit) {
          void api
            .updateProject(curProj.id, { ...patch, workflow: nextWorkflow })
            .then(({ project: saved }) => onProjectUpdated(saved))
            .catch(() => {});
        }
      }

      if (commit && drag.kind === 'dub-clip' && builtClipsForRebuild && onProjectUpdated) {
        const clipsToRebuild = builtClipsForRebuild;
        const projId = curProj.id;
        window.setTimeout(() => {
          void api
            .rebuildFishDubTrack(projId, { generatedClips: clipsToRebuild })
            .then(({ project: rebuilt }) => {
              onProjectUpdated(rebuilt);
            })
            .catch(() => {});
        }, 80);
      }
    };

    const computeBounds = (clientX: number) => {
      const widthPx = Math.max(1, area.getBoundingClientRect().width);
      const deltaSec = ((clientX - drag.startClientX) / widthPx) * duration;
      let nextStart = drag.origStart;
      let nextEnd = drag.origEnd;
      let nextTrimStart: number | undefined = drag.origTrimStart;
      let nextSourceStart: number | undefined = drag.origSourceStart;
      let nextSourceEnd: number | undefined = drag.origSourceEnd;

      if (
        drag.kind === 'video-clip' ||
        drag.kind === 'orig-clip' ||
        drag.kind === 'bgm-clip' ||
        drag.kind === 'sfx-clip'
      ) {
        const speed =
          drag.kind === 'video-clip'
            ? Math.max(0.25, Math.min(4.0, drag.clipSpeed ?? 1.0))
            : 1.0;
        const oSrcStart = Math.max(0, drag.origSourceStart ?? 0);
        const oSrcEnd = Math.max(oSrcStart + 0.1, drag.origSourceEnd ?? srcDuration);
        const maxSrc = Math.max(oSrcEnd, drag.maxSourceDuration ?? srcDuration);
        const tlSpan = Math.max(0.15, (oSrcEnd - oSrcStart) / speed);

        if (drag.mode === 'move') {
          nextStart = Math.max(0, drag.origStart + deltaSec);
          nextEnd = nextStart + tlSpan;
          nextSourceStart = oSrcStart;
          nextSourceEnd = oSrcEnd;
        } else if (drag.mode === 'trim-start') {
          const earliestStart = Math.max(0, drag.origStart - oSrcStart / speed);
          const latestStart = drag.origEnd - 0.2;
          nextStart = Math.max(earliestStart, Math.min(latestStart, drag.origStart + deltaSec));
          nextSourceStart = Math.max(
            0,
            Math.min(oSrcEnd - 0.1, oSrcStart + (nextStart - drag.origStart) * speed)
          );
          nextSourceEnd = oSrcEnd;
          nextEnd = drag.origEnd;
        } else if (drag.mode === 'trim-end') {
          const maxPossibleEnd = drag.origStart + (maxSrc - oSrcStart) / speed;
          nextEnd = Math.max(drag.origStart + 0.2, Math.min(maxPossibleEnd, drag.origEnd + deltaSec));
          nextSourceStart = oSrcStart;
          nextSourceEnd = Math.min(
            maxSrc,
            Math.max(oSrcStart + 0.1, oSrcStart + (nextEnd - drag.origStart) * speed)
          );
          nextStart = drag.origStart;
        }

        return {
          nextStart: Number(nextStart.toFixed(3)),
          nextEnd: Number(nextEnd.toFixed(3)),
          nextTrimStart: undefined,
          nextSourceStart: nextSourceStart !== undefined ? Number(nextSourceStart.toFixed(3)) : undefined,
          nextSourceEnd: nextSourceEnd !== undefined ? Number(nextSourceEnd.toFixed(3)) : undefined,
        };
      }

      if (drag.kind === 'dub-clip') {
        const origTrimStart = Math.max(0, drag.origTrimStart ?? 0);
        const maxDur = Math.max(minDur, drag.maxAudioDuration ?? drag.origEnd - drag.origStart);
        if (drag.mode === 'move') {
          const span = Math.max(minDur, drag.origEnd - drag.origStart);
          nextStart = Math.max(0, Math.min(duration - span, drag.origStart + deltaSec));
          nextEnd = nextStart + span;
        } else if (drag.mode === 'trim-start') {
          const earliestStart = Math.max(0, drag.origStart - origTrimStart);
          const latestStart = drag.origEnd - minDur;
          nextStart = Math.max(earliestStart, Math.min(latestStart, drag.origStart + deltaSec));
          nextTrimStart = Math.max(0, origTrimStart + (nextStart - drag.origStart));
        } else if (drag.mode === 'trim-end') {
          const maxPossibleEnd = Math.min(duration, drag.origStart + (maxDur - origTrimStart));
          nextEnd = Math.max(
            drag.origStart + minDur,
            Math.min(maxPossibleEnd, drag.origEnd + deltaSec)
          );
        }
        return {
          nextStart: Number(nextStart.toFixed(2)),
          nextEnd: Number(nextEnd.toFixed(2)),
          nextTrimStart:
            nextTrimStart !== undefined ? Number(nextTrimStart.toFixed(2)) : undefined,
          nextSourceStart: undefined,
          nextSourceEnd: undefined,
        };
      }

      if (drag.mode === 'move') {
        const span = Math.max(minDur, drag.origEnd - drag.origStart);
        nextStart = Math.max(0, Math.min(duration - span, drag.origStart + deltaSec));
        nextEnd = Math.min(duration, nextStart + span);
      } else if (drag.mode === 'trim-start') {
        nextStart = Math.max(0, Math.min(drag.origEnd - minDur, drag.origStart + deltaSec));
      } else if (drag.mode === 'trim-end') {
        nextEnd = Math.min(duration, Math.max(drag.origStart + minDur, drag.origEnd + deltaSec));
      }
      return {
        nextStart: Number(nextStart.toFixed(2)),
        nextEnd: Number(nextEnd.toFixed(2)),
        nextTrimStart: undefined,
        nextSourceStart: undefined,
        nextSourceEnd: undefined,
      };
    };

    const handleMove = (moveEvt: PointerEvent) => {
      if (!clipDragRef.current) return;
      if (Math.abs(moveEvt.clientX - drag.startClientX) > 3) {
        drag.hasMoved = true;
      }
      if (!drag.hasMoved) return;
      if (drag.locked) {
        if (!notifiedLocked) {
          notifiedLocked = true;
          onNotify?.(LOCKED_LAYER_MESSAGE);
        }
        return;
      }
      const res = computeBounds(moveEvt.clientX);
      const durSec = Math.max(0.1, res.nextEnd - res.nextStart);
      const xPct = Math.max(8, Math.min(92, (((res.nextStart + res.nextEnd) / 2) / Math.max(0.1, duration)) * 100));
      setDragTooltip({
        xPct,
        label: `${durSec.toFixed(2)}s (${res.nextStart.toFixed(2)}s → ${res.nextEnd.toFixed(2)}s)`,
      });
      applyTimes(
        res.nextStart,
        res.nextEnd,
        res.nextTrimStart,
        false,
        res.nextSourceStart,
        res.nextSourceEnd
      );
    };

    const handleEnd = (endEvt: PointerEvent) => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleEnd);
      window.removeEventListener('pointercancel', handleEnd);
      setDragTooltip(null);
      if (drag.hasMoved) {
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 60);
        if (!drag.locked) {
          const res = computeBounds(endEvt.clientX);
          applyTimes(
            res.nextStart,
            res.nextEnd,
            res.nextTrimStart,
            true,
            res.nextSourceStart,
            res.nextSourceEnd
          );
        }
      }
      clipDragRef.current = null;
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleEnd);
    window.addEventListener('pointercancel', handleEnd);
  };

  const openTool = (tool: StudioToolId, subTab?: string) => {
    if (onOpenTool) {
      onOpenTool(tool, subTab);
      return;
    }
    if (onNavigate) {
      if (tool === 'captions') onNavigate('captions');
      else if (tool === 'audio') onNavigate('voice');
      else if (tool === 'blur') onNavigate('blur');
      else if (tool === 'overlay') onNavigate('branding');
      else onNavigate('editor');
    }
  };

  // Ctrl/Cmd + Wheel horizontal zoom
  const handleWheelZoom = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.25 : -0.25;
    setZoom((z) => Math.max(1, Math.min(8, Number((z + delta).toFixed(2)))));
  };

  // Zoom-adaptive time markers with major + minor subticks
  const timeMarkers = useMemo(() => {
    const pxBudget = 900 * zoom;
    const rawStep = duration / Math.max(4, Math.floor(pxBudget / 92));
    const niceSteps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
    const majorStep = niceSteps.find((s) => s >= rawStep) || 120;
    const minorStep = majorStep / 4;
    const majors: number[] = [];
    for (let t = 0; t <= duration - 0.05; t += majorStep) {
      majors.push(Number(t.toFixed(2)));
    }
    if (majors.length === 0 || Math.abs(majors[majors.length - 1] - duration) > 0.05) {
      majors.push(Number(duration.toFixed(2)));
    }
    const minors: number[] = [];
    for (let t = 0; t <= duration + 0.001; t += minorStep) {
      const nearestMajor = Math.round(t / majorStep) * majorStep;
      if (Math.abs(t - nearestMajor) > 0.01 && t <= duration) {
        minors.push(Number(t.toFixed(2)));
      }
    }
    return { majors, minors };
  }, [duration, zoom]);

  const effectiveDensity: TrackDensity = expanded && density === 'compact' ? 'tall' : density;
  const videoRowHeightPx =
    effectiveDensity === 'compact' ? 40 : effectiveDensity === 'tall' ? 68 : 52;
  const trackRowHeightPx =
    effectiveDensity === 'compact' ? 32 : effectiveDensity === 'tall' ? 54 : 40;

  // Helpers to slice filmstrip thumbnails for any VideoClip [sourceStart, sourceEnd]
  const getClipThumbnails = useCallback(
    (clipSourceStart: number, clipSourceEnd: number, tileCount: number) => {
      if (filmstripFrames.length === 0) return [];
      const out: FilmstripFrame[] = [];
      const span = Math.max(0.1, clipSourceEnd - clipSourceStart);
      for (let i = 0; i < tileCount; i++) {
        const targetTime = clipSourceStart + ((i + 0.5) / tileCount) * span;
        let closest = filmstripFrames[0];
        let bestDiff = Math.abs(closest.time - targetTime);
        for (let k = 1; k < filmstripFrames.length; k++) {
          const diff = Math.abs(filmstripFrames[k].time - targetTime);
          if (diff < bestDiff) {
            bestDiff = diff;
            closest = filmstripFrames[k];
          }
        }
        out.push(closest);
      }
      return out;
    },
    [filmstripFrames]
  );

  // Selected element checks for strict single-element highlighting
  const isVideoClipSelected = (clipId: string) =>
    selectedElement?.kind === 'video' &&
    (!selectedElement.clipId || selectedElement.clipId === clipId);

  const isCaptionSegmentSelected = (capId: string) =>
    selectedElement?.kind === 'captions' && selectedElement.segmentId === capId;

  const isCaptionTrackSelected = selectedElement?.kind === 'captions';

  const canSplit = Boolean(
    project.sourceVideoUrl ||
      bgmClips.length > 0 ||
      sfxClips.length > 0 ||
      project.voice.generatedClips.length > 0 ||
      allVisualEffects.length > 0 ||
      filterStack.length > 0
  );
  const canDelete = Boolean(
    selectedElement &&
      ((selectedElement.kind === 'video' && videoClips.length >= 1) ||
        selectedElement.kind === 'blur' ||
        selectedElement.kind === 'logo' ||
        selectedElement.kind === 'caption-element' ||
        (selectedElement.kind === 'captions' && project.captions.length > 0) ||
        (selectedElement.kind === 'audio' &&
          ((selectedElement.track === 'orig' &&
            (hasUnlinkedAudio || Boolean(project.metadata?.hasAudio))) ||
            (selectedElement.track === 'dub' &&
              (hasDubAudio || project.voice.generatedClips.length > 0)) ||
            (selectedElement.track === 'bgm' && bgmClips.length > 0) ||
            (selectedElement.track === 'sfx' && sfxClips.length > 0))) ||
        (selectedElement.kind === 'filter' &&
          (Boolean(selectedElement.filterId) || fxConfig.filterPreset !== 'none')) ||
        (selectedElement.kind === 'effect' && Boolean(selectedElement.effectId)))
  );
  const canDuplicate = Boolean(
    selectedElement &&
      (selectedElement.kind === 'video' ||
        selectedElement.kind === 'blur' ||
        selectedElement.kind === 'logo' ||
        selectedElement.kind === 'caption-element' ||
        selectedElement.kind === 'captions' ||
        (selectedElement.kind === 'filter' && Boolean(selectedElement.filterId)) ||
        (selectedElement.kind === 'effect' && Boolean(selectedElement.effectId)))
  );

  const showCaptionsLane =
    mobileShowAllTracks ||
    syncedCaptions.length > 0 ||
    project.subtitleStyle.enabled ||
    selectedElement?.kind === 'captions';
  const showNarrationLane =
    mobileShowAllTracks ||
    hasDubAudio ||
    (selectedElement?.kind === 'audio' && (!selectedElement.track || selectedElement.track === 'dub'));
  const showOrigAudioLane =
    mobileShowAllTracks ||
    hasUnlinkedAudio ||
    !origTrackMuted ||
    (selectedElement?.kind === 'audio' && selectedElement.track === 'orig');
  const showMusicLane =
    mobileShowAllTracks ||
    bgmClips.length > 0 ||
    Boolean(project.voice.bgMusicUrl) ||
    (selectedElement?.kind === 'audio' && selectedElement.track === 'bgm');
  const showSfxLane =
    mobileShowAllTracks ||
    sfxClips.length > 0 ||
    Boolean(project.voice.sfxUrl) ||
    (selectedElement?.kind === 'audio' && selectedElement.track === 'sfx');
  const showOverlaysLane =
    mobileShowAllTracks ||
    project.logos.length > 0 ||
    (project.subtitleStyle.extraElements || []).length > 0 ||
    selectedElement?.kind === 'logo' ||
    selectedElement?.kind === 'caption-element';
  const showBlurLane =
    mobileShowAllTracks || project.blurs.length > 0 || selectedElement?.kind === 'blur';
  const showFiltersLane =
    mobileShowAllTracks ||
    filterStack.length > 0 ||
    fxConfig.filterPreset !== 'none' ||
    selectedElement?.kind === 'filter';
  const showEffectsLane =
    mobileShowAllTracks ||
    allVisualEffects.length > 0 ||
    selectedElement?.kind === 'effect';

  const activeMobileTrackCount =
    1 +
    (showCaptionsLane ? 1 : 0) +
    (showNarrationLane ? 1 : 0) +
    (showOrigAudioLane ? 1 : 0) +
    (showMusicLane ? 1 : 0) +
    (showSfxLane ? 1 : 0) +
    (showOverlaysLane ? 1 : 0) +
    (showBlurLane ? 1 : 0) +
    (showFiltersLane ? 1 : 0) +
    (showEffectsLane ? 1 : 0);

  return (
    <div
      onWheel={handleWheelZoom}
      className="h-full bg-[#0C0C11] border-t border-white/[0.08] flex flex-col select-none overflow-hidden"
    >
      {/* Timeline Utility Toolbar */}
      <div className="h-11 lg:h-10 px-2 sm:px-3 border-b border-white/[0.08] bg-[#121218] flex items-center justify-between gap-1.5 sm:gap-2 shrink-0 overflow-x-auto no-scrollbar">
        {/* Left: Direct Clip Actions + Mobile Track Drawer + Playhead Readout */}
        <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
          <div className="hidden sm:flex items-center gap-1.5 pr-2 mr-1 border-r border-white/[0.08] font-mono text-[11px] text-zinc-200 tabular-nums shrink-0">
            <span>{formatTimecode(currentTime)}</span>
            <span className="text-zinc-600">/</span>
            <span className="text-zinc-400">{formatTimecode(duration)}</span>
          </div>

          <button
            type="button"
            onClick={() => openTool('layers')}
            title="Manage Tracks & Layers"
            className="lg:hidden min-h-[34px] px-2 py-1 rounded-md bg-[#1A1A24] hover:bg-violet-600/25 border border-white/[0.1] text-[11px] font-medium text-zinc-100 flex items-center gap-1 cursor-pointer shrink-0 whitespace-nowrap"
          >
            <Layers3 className="w-3.5 h-3.5 text-violet-400 shrink-0" />
            <span>Tracks</span>
          </button>

          <button
            type="button"
            onClick={() => setMobileShowAllTracks((v) => !v)}
            title={mobileShowAllTracks ? 'Show active tracks only' : 'Show all 10 tracks'}
            className={`lg:hidden min-h-[34px] px-2 py-1 rounded-md border text-[11px] font-mono font-medium flex items-center gap-1 cursor-pointer shrink-0 whitespace-nowrap ${
              mobileShowAllTracks
                ? 'bg-violet-600/25 border-violet-500/50 text-violet-200'
                : 'bg-[#17171F] border-white/[0.08] text-zinc-300'
            }`}
          >
            <span>{mobileShowAllTracks ? '10/10' : `${activeMobileTrackCount}/10`}</span>
          </button>

          {onUndo && (
            <button
              type="button"
              onClick={onUndo}
              disabled={!canUndo}
              title="Undo"
              aria-label="Undo"
              className="lg:hidden min-w-[34px] min-h-[34px] p-1 rounded-md bg-[#1A1A22] hover:bg-[#24242F] disabled:opacity-30 border border-white/[0.08] text-zinc-200 flex items-center justify-center cursor-pointer shrink-0"
            >
              <Undo2 className="w-3.5 h-3.5" />
            </button>
          )}

          {onRedo && (
            <button
              type="button"
              onClick={onRedo}
              disabled={!canRedo}
              title="Redo"
              aria-label="Redo"
              className="lg:hidden min-w-[34px] min-h-[34px] p-1 rounded-md bg-[#1A1A22] hover:bg-[#24242F] disabled:opacity-30 border border-white/[0.08] text-zinc-200 flex items-center justify-center cursor-pointer shrink-0"
            >
              <Redo2 className="w-3.5 h-3.5" />
            </button>
          )}

          {onSplitAtPlayhead && (
            <button
              type="button"
              onClick={onSplitAtPlayhead}
              disabled={!canSplit}
              title="Split selected clip at playhead"
              className="min-h-[34px] lg:min-h-[30px] px-2 py-1 rounded-md bg-[#1A1A22] hover:bg-[#24242F] disabled:opacity-35 border border-white/[0.08] text-[11px] font-medium text-zinc-200 flex items-center gap-1 cursor-pointer shrink-0 whitespace-nowrap"
            >
              <Scissors className="w-3.5 h-3.5 text-zinc-300" />
              <span className="hidden sm:inline">Split</span>
            </button>
          )}

          {onDuplicateSelected && (
            <button
              type="button"
              onClick={onDuplicateSelected}
              disabled={!canDuplicate}
              title="Duplicate selected clip"
              className="min-h-[34px] lg:min-h-[30px] px-2 py-1 rounded-md bg-[#1A1A22] hover:bg-[#24242F] disabled:opacity-35 border border-white/[0.08] text-[11px] font-medium text-zinc-200 flex items-center gap-1 cursor-pointer shrink-0 whitespace-nowrap"
            >
              <Copy className="w-3.5 h-3.5 text-zinc-300" />
              <span className="hidden md:inline">Duplicate</span>
            </button>
          )}

          {onDeleteSelected && (
            <button
              type="button"
              onClick={onDeleteSelected}
              disabled={!canDelete}
              title="Delete selected item"
              className="min-h-[34px] lg:min-h-[30px] px-2 py-1 rounded-md bg-[#1A1A22] hover:bg-red-500/20 disabled:opacity-35 border border-white/[0.08] text-[11px] font-medium text-red-300 flex items-center gap-1 cursor-pointer shrink-0 whitespace-nowrap"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span className="hidden md:inline">Delete</span>
            </button>
          )}

          {mismatches.length > 0 && (
            <button
              type="button"
              onClick={() => {
                onSeek(mismatches[0].atTime);
                openTool('edit', 'timing');
              }}
              title={mismatches[0].message}
              className={`min-w-0 max-w-[160px] sm:max-w-[220px] truncate px-2 py-1 rounded-md text-[10.5px] font-medium flex items-center gap-1 cursor-pointer shrink-0 ${
                mismatches[0].severity === 'warning'
                  ? 'bg-amber-500/15 border border-amber-500/35 text-amber-200'
                  : 'bg-sky-500/15 border border-sky-500/35 text-sky-200'
              }`}
            >
              <AlertTriangle className="w-3 h-3 shrink-0" />
              <span className="truncate">{mismatches[0].message}</span>
            </button>
          )}
        </div>

        {/* Right: Track Height & Smooth Zoom Controls */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          {/* Track Height Segmented Control */}
          <div
            className="hidden sm:flex items-center bg-[#181820] border border-white/[0.08] rounded-md p-0.5"
            role="group"
            aria-label="Track height"
          >
            {(
              [
                ['compact', 'S'],
                ['standard', 'M'],
                ['tall', 'L'],
              ] as Array<[TrackDensity, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setDensity(key)}
                title={`${key[0].toUpperCase()}${key.slice(1)} track height`}
                className={`min-w-[24px] h-6 px-1.5 rounded text-[10px] font-mono font-semibold cursor-pointer transition-colors ${
                  density === key
                    ? 'bg-violet-600 text-white'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-0.5 sm:gap-1 bg-[#181820] border border-white/[0.08] rounded-md px-1 sm:px-1.5 py-0.5">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(1, Number((z - 0.5).toFixed(2))))}
              disabled={zoom <= 1}
              className="w-7 h-7 lg:w-6 lg:h-6 rounded text-zinc-400 hover:text-white disabled:opacity-30 flex items-center justify-center cursor-pointer"
              title="Zoom out timeline"
              aria-label="Zoom out timeline"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <input
              type="range"
              min={1}
              max={8}
              step={0.25}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              aria-label="Timeline zoom"
              className="hidden md:block w-20 accent-violet-500 cursor-pointer"
            />
            <span className="text-[10.5px] font-mono text-zinc-300 tabular-nums w-7 sm:w-8 text-center">
              {zoom}x
            </span>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(8, Number((z + 0.5).toFixed(2))))}
              disabled={zoom >= 8}
              className="w-7 h-7 lg:w-6 lg:h-6 rounded text-zinc-400 hover:text-white disabled:opacity-30 flex items-center justify-center cursor-pointer"
              title="Zoom in timeline"
              aria-label="Zoom in timeline"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            {zoom > 1 && (
              <button
                type="button"
                onClick={() => setZoom(1)}
                className="px-1.5 h-6 rounded bg-white/[0.06] hover:bg-white/[0.12] text-[10px] font-medium text-zinc-200 cursor-pointer whitespace-nowrap"
                title="Fit timeline to window"
              >
                Fit
              </button>
            )}
          </div>

          {onToggleExpanded && (
            <button
              type="button"
              onClick={onToggleExpanded}
              className="min-w-[34px] min-h-[34px] lg:min-w-[30px] lg:min-h-[30px] p-1 rounded-md bg-[#1A1A22] hover:bg-[#24242F] border border-white/[0.08] text-zinc-300 hover:text-white flex items-center justify-center cursor-pointer shrink-0"
              title={expanded ? 'Collapse timeline' : 'Expand timeline'}
              aria-label={expanded ? 'Collapse timeline' : 'Expand timeline'}
            >
              {expanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </div>

      {/* Selected Layer Duration & End Timing Bar (Desktop & Mobile) */}
      {selectedTiming && (
        <div
          data-testid="selected-layer-timing-bar"
          className="h-8 lg:h-7 px-2.5 sm:px-3 border-b border-white/[0.07] bg-[#101016] flex items-center justify-between gap-2 text-[11px] shrink-0 overflow-x-auto no-scrollbar"
        >
          <div className="flex items-center gap-2 min-w-0 shrink-0">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-violet-300 shrink-0">
              {selectedTiming.category}
            </span>
            <span className="text-zinc-200 font-medium truncate max-w-[140px] sm:max-w-[210px]">
              {selectedTiming.label}
            </span>
            {selectedTiming.locked && (
              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-300 shrink-0">
                <Lock className="w-2.5 h-2.5" />
                Locked
              </span>
            )}
          </div>

          <div className="flex items-center gap-2.5 sm:gap-3.5 shrink-0 font-mono tabular-nums text-[10.5px]">
            <span className="text-zinc-400 whitespace-nowrap">
              Start <span className="text-zinc-100">{formatTimecode(selectedTiming.start)}</span>
            </span>
            <span className="text-zinc-400 whitespace-nowrap">
              End <span className="text-emerald-300">{formatTimecode(selectedTiming.end)}</span>
            </span>
            <span className="text-zinc-400 whitespace-nowrap">
              Dur <span className="text-violet-200 font-semibold">{formatTimecode(selectedTiming.duration)}</span>
            </span>
            {selectedTiming.fps !== undefined && selectedTiming.durationFrames !== undefined && (
              <span className="hidden md:inline text-zinc-500 whitespace-nowrap">
                {selectedTiming.durationFrames}f @ {selectedTiming.fps}fps
              </span>
            )}
            <button
              type="button"
              onClick={handleToggleSelectedLock}
              title={selectedTiming.locked ? 'Unlock selected layer' : 'Lock selected layer'}
              aria-label={selectedTiming.locked ? 'Unlock selected layer' : 'Lock selected layer'}
              className={`min-h-[24px] px-1.5 py-0.5 rounded border text-[10px] font-sans font-medium flex items-center gap-1 cursor-pointer shrink-0 transition-colors ${
                selectedTiming.locked
                  ? 'bg-amber-500/20 border-amber-400/50 text-amber-200 hover:bg-amber-500/30'
                  : 'bg-[#181822] border-white/[0.08] text-zinc-300 hover:text-white'
              }`}
            >
              {selectedTiming.locked ? (
                <Lock className="w-2.5 h-2.5" />
              ) : (
                <Unlock className="w-2.5 h-2.5" />
              )}
              <span>{selectedTiming.locked ? 'Unlock' : 'Lock'}</span>
            </button>
          </div>
        </div>
      )}

      {/* 3-Column Timeline Shell on Desktop (>= lg) | Full-Width Track Canvas on Mobile (< lg) */}
      <div className="flex-1 min-h-0 flex overflow-hidden relative">
        {/* LEFT: FIXED TRACK LABELS COLUMN (Desktop only >= lg) */}
        <div
          ref={leftColRef}
          onScroll={(e) => syncVerticalFromSide(e.currentTarget)}
          style={centerHScrollbarPx > 0 ? { paddingBottom: `${centerHScrollbarPx}px` } : undefined}
          className="hidden lg:flex w-[172px] shrink-0 bg-[#121218] border-r border-white/[0.09] overflow-y-auto overflow-x-hidden no-scrollbar flex-col"
        >
          {/* Corner Sticky Header aligned with Time Ruler (h-7) */}
          <div className="sticky top-0 z-40 h-7 shrink-0 bg-[#14141B] border-b border-white/[0.08] px-2.5 flex items-center justify-between">
            <span className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-400">
              Tracks
            </span>
            <span className="text-[10px] font-mono text-zinc-500 tabular-nums">
              10
            </span>
          </div>

          <div className="p-1.5 space-y-1.5">
              {/* 1. Video */}
              <TrackHeader
                heightPx={videoRowHeightPx}
                active={selectedElement?.kind === 'video'}
                locked={isTrackLocked(project, 'video')}
                onToggleLock={() => handleToggleTrackLock('video')}
                accentClass="border-l-violet-500"
                icon={<Film className="w-3.5 h-3.5 text-violet-400 shrink-0" />}
                label="Video"
                onClick={() => {
                  onSelectElement?.({ kind: 'video', clipId: videoClips[0]?.id });
                  openTool('edit');
                }}
                actionButton={
                  <button
                    type="button"
                    onClick={() =>
                      patchProjectImmediate({
                        canvas: { ...canvasConfig, videoVisible: !videoVisible },
                      })
                    }
                    className="w-6 h-6 rounded hover:bg-white/[0.08] flex items-center justify-center text-zinc-400 hover:text-white cursor-pointer shrink-0"
                    title={videoVisible ? 'Hide Video Layer' : 'Show Video Layer'}
                  >
                    {videoVisible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5 text-zinc-600" />}
                  </button>
                }
              />

              {/* 2. Captions */}
              <TrackHeader
                heightPx={trackRowHeightPx}
                active={isCaptionTrackSelected}
                locked={isTrackLocked(project, 'captions')}
                onToggleLock={() => handleToggleTrackLock('captions')}
                accentClass="border-l-amber-400"
                icon={<Captions className="w-3.5 h-3.5 text-amber-400 shrink-0" />}
                label="Captions"
                onClick={() => {
                  onSelectElement?.({
                    kind: 'captions',
                    segmentId: syncedCaptions[0]?.id,
                  });
                  openTool('captions');
                }}
                actionButton={
                  <button
                    type="button"
                    onClick={() => {
                      const next = !captionsVisible;
                      patchProjectImmediate({
                        subtitleStyle: {
                          ...project.subtitleStyle,
                          enabled: next ? true : project.subtitleStyle.enabled,
                          visible: next,
                        },
                      });
                    }}
                    className="w-6 h-6 rounded hover:bg-white/[0.08] flex items-center justify-center text-zinc-400 hover:text-white cursor-pointer shrink-0"
                    title={captionsVisible ? 'Hide Captions' : 'Show Captions'}
                  >
                    {captionsVisible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5 text-zinc-600" />}
                  </button>
                }
              />

              {/* 3. Narration */}
              <TrackHeader
                heightPx={trackRowHeightPx}
                active={selectedElement?.kind === 'audio' && (!selectedElement.track || selectedElement.track === 'dub')}
                locked={isTrackLocked(project, 'dub')}
                onToggleLock={() => handleToggleTrackLock('dub')}
                accentClass="border-l-teal-400"
                icon={<Mic className="w-3.5 h-3.5 text-teal-400 shrink-0" />}
                label="Narration"
                onClick={() => {
                  onSelectElement?.({ kind: 'audio', track: 'dub' });
                  openTool('audio', 'mixer');
                }}
                actionButton={
                  <button
                    type="button"
                    onClick={() => {
                      if (!hasDubAudio) {
                        onSelectElement?.({ kind: 'audio', track: 'dub' });
                        openTool('audio', 'voice');
                        return;
                      }
                      patchProjectImmediate((cur) => {
                        const unmuting = dubMuted;
                        return {
                          voice: {
                            ...cur.voice,
                            voiceMuted: !unmuting,
                            enabled: unmuting ? true : cur.voice.enabled,
                            voiceVolume:
                              unmuting && (cur.voice.voiceVolume ?? 0) <= 0.01
                                ? 1.0
                                : cur.voice.voiceVolume,
                          },
                        };
                      });
                    }}
                    className="w-6 h-6 rounded hover:bg-white/[0.08] flex items-center justify-center text-zinc-400 hover:text-white cursor-pointer shrink-0"
                    title={dubMuted ? 'Unmute Narration' : 'Mute Narration'}
                  >
                    {dubMuted ? <VolumeX className="w-3.5 h-3.5 text-red-400" /> : <Volume2 className="w-3.5 h-3.5 text-teal-300" />}
                  </button>
                }
              />

              {/* 4. Original Audio */}
              <TrackHeader
                heightPx={trackRowHeightPx}
                active={selectedElement?.kind === 'audio' && selectedElement.track === 'orig'}
                locked={isTrackLocked(project, 'orig')}
                onToggleLock={() => handleToggleTrackLock('orig')}
                accentClass="border-l-cyan-400"
                icon={<Volume2 className="w-3.5 h-3.5 text-cyan-400 shrink-0" />}
                label="Original Audio"
                onClick={() => {
                  onSelectElement?.({ kind: 'audio', track: 'orig' });
                  openTool('audio', 'mixer');
                }}
                actionButton={
                  <button
                    type="button"
                    onClick={() => {
                      patchProjectImmediate((cur) => {
                        const unmuting = origTrackMuted;
                        return {
                          voice: {
                            ...cur.voice,
                            originalAudioMuted: !unmuting,
                            originalAudioEnabled: unmuting,
                            preserveOriginalAudio: unmuting,
                            originalAudioVolume:
                              unmuting && (cur.voice.originalAudioVolume ?? 0) <= 0.01
                                ? 1.0
                                : cur.voice.originalAudioVolume,
                          },
                        };
                      });
                    }}
                    className="w-6 h-6 rounded hover:bg-white/[0.08] flex items-center justify-center text-zinc-400 hover:text-white cursor-pointer shrink-0"
                    title={origTrackMuted ? 'Unmute Original Audio' : 'Mute Original Audio'}
                  >
                    {origTrackMuted ? <VolumeX className="w-3.5 h-3.5 text-zinc-500" /> : <Volume2 className="w-3.5 h-3.5 text-cyan-300" />}
                  </button>
                }
              />

              {/* 5. Music */}
              <TrackHeader
                heightPx={trackRowHeightPx}
                active={selectedElement?.kind === 'audio' && selectedElement.track === 'bgm'}
                locked={isTrackLocked(project, 'bgm')}
                onToggleLock={() => handleToggleTrackLock('bgm')}
                accentClass="border-l-indigo-400"
                icon={<Music className="w-3.5 h-3.5 text-indigo-400 shrink-0" />}
                label="Music"
                onClick={() => {
                  onSelectElement?.({ kind: 'audio', track: 'bgm' });
                  openTool('audio', 'mixer');
                }}
                actionButton={
                  <button
                    type="button"
                    onClick={() => {
                      if (!project.voice.bgMusicUrl) {
                        onSelectElement?.({ kind: 'audio', track: 'bgm' });
                        openTool('audio', 'mixer');
                        return;
                      }
                      patchProjectImmediate((cur) => {
                        const unmuting = bgMusicMuted;
                        return {
                          voice: {
                            ...cur.voice,
                            bgMusicMuted: !unmuting,
                            bgMusicEnabled: unmuting ? true : cur.voice.bgMusicEnabled,
                            bgMusicVolume:
                              unmuting && (cur.voice.bgMusicVolume ?? 0) <= 0.01
                                ? 0.25
                                : cur.voice.bgMusicVolume,
                          },
                        };
                      });
                    }}
                    className="w-6 h-6 rounded hover:bg-white/[0.08] flex items-center justify-center text-zinc-400 hover:text-white cursor-pointer shrink-0"
                    title={bgMusicMuted ? 'Unmute Music' : 'Mute Music'}
                  >
                    {bgMusicMuted ? <VolumeX className="w-3.5 h-3.5 text-zinc-500" /> : <Volume2 className="w-3.5 h-3.5 text-indigo-300" />}
                  </button>
                }
              />

              {/* 6. SFX */}
              <TrackHeader
                heightPx={trackRowHeightPx}
                active={selectedElement?.kind === 'audio' && selectedElement.track === 'sfx'}
                locked={isTrackLocked(project, 'sfx')}
                onToggleLock={() => handleToggleTrackLock('sfx')}
                accentClass="border-l-emerald-400"
                icon={<Zap className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
                label="SFX"
                onClick={() => {
                  onSelectElement?.({ kind: 'audio', track: 'sfx' });
                  openTool('audio', 'mixer');
                }}
                actionButton={
                  <button
                    type="button"
                    onClick={() => {
                      if (!project.voice.sfxUrl) {
                        onSelectElement?.({ kind: 'audio', track: 'sfx' });
                        openTool('audio', 'mixer');
                        return;
                      }
                      patchProjectImmediate((cur) => {
                        const unmuting = sfxMuted;
                        return {
                          voice: {
                            ...cur.voice,
                            sfxMuted: !unmuting,
                            sfxEnabled: unmuting ? true : cur.voice.sfxEnabled,
                            sfxVolume:
                              unmuting && (cur.voice.sfxVolume ?? 0) <= 0.01
                                ? 1.0
                                : cur.voice.sfxVolume,
                          },
                        };
                      });
                    }}
                    className="w-6 h-6 rounded hover:bg-white/[0.08] flex items-center justify-center text-zinc-400 hover:text-white cursor-pointer shrink-0"
                    title={sfxMuted ? 'Unmute SFX' : 'Mute SFX'}
                  >
                    {sfxMuted ? <VolumeX className="w-3.5 h-3.5 text-zinc-500" /> : <Volume2 className="w-3.5 h-3.5 text-emerald-300" />}
                  </button>
                }
              />

              {/* 7. Overlays & Text */}
              <TrackHeader
                heightPx={trackRowHeightPx}
                active={selectedElement?.kind === 'logo' || selectedElement?.kind === 'caption-element'}
                locked={isTrackLocked(project, 'overlays')}
                onToggleLock={() => handleToggleTrackLock('overlays')}
                accentClass="border-l-purple-400"
                icon={<Layers className="w-3.5 h-3.5 text-purple-400 shrink-0" />}
                label="Overlays & Text"
                onClick={() => {
                  if (project.logos[0]) {
                    onSelectElement?.({ kind: 'logo', id: project.logos[0].id });
                    openTool('overlay');
                  } else if ((project.subtitleStyle.extraElements || [])[0]) {
                    onSelectElement?.({
                      kind: 'caption-element',
                      id: project.subtitleStyle.extraElements![0].id,
                    });
                    openTool('text');
                  } else {
                    openTool('overlay');
                  }
                }}
                actionButton={
                  <button
                    type="button"
                    onClick={() => {
                      const nextVis = !overlaysVisible;
                      patchProjectImmediate({
                        logos: project.logos.map((l) => ({ ...l, enabled: nextVis })),
                        subtitleStyle: {
                          ...project.subtitleStyle,
                          extraElements: (project.subtitleStyle.extraElements || []).map((el) => ({
                            ...el,
                            visible: nextVis,
                          })),
                        },
                      });
                    }}
                    className="w-6 h-6 rounded hover:bg-white/[0.08] flex items-center justify-center text-zinc-400 hover:text-white cursor-pointer shrink-0"
                    title={overlaysVisible ? 'Hide Overlays' : 'Show Overlays'}
                  >
                    {overlaysVisible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5 text-zinc-600" />}
                  </button>
                }
              />

              {/* 8. Blur */}
              <TrackHeader
                heightPx={trackRowHeightPx}
                active={selectedElement?.kind === 'blur'}
                locked={isTrackLocked(project, 'blur')}
                onToggleLock={() => handleToggleTrackLock('blur')}
                accentClass="border-l-sky-400"
                icon={<Droplet className="w-3.5 h-3.5 text-sky-400 shrink-0" />}
                label="Blur"
                onClick={() => {
                  if (project.blurs[0]) onSelectElement?.({ kind: 'blur', id: project.blurs[0].id });
                  openTool('blur');
                }}
                actionButton={
                  <button
                    type="button"
                    onClick={() => {
                      if (project.blurs.length === 0) {
                        openTool('blur');
                        return;
                      }
                      const next = !blursVisible;
                      patchProjectImmediate({
                        blurs: project.blurs.map((b) => ({ ...b, enabled: next })),
                      });
                    }}
                    className="w-6 h-6 rounded hover:bg-white/[0.08] flex items-center justify-center text-zinc-400 hover:text-white cursor-pointer shrink-0"
                    title={blursVisible ? 'Disable Blurs' : 'Enable Blurs'}
                  >
                    {blursVisible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5 text-zinc-600" />}
                  </button>
                }
              />

              {/* 9. Filters */}
              <TrackHeader
                heightPx={trackRowHeightPx}
                active={selectedElement?.kind === 'filter'}
                locked={isTrackLocked(project, 'filters')}
                onToggleLock={() => handleToggleTrackLock('filters')}
                accentClass="border-l-pink-400"
                icon={<Wand2 className="w-3.5 h-3.5 text-pink-400 shrink-0" />}
                label="Filters"
                onClick={() => {
                  onSelectElement?.({
                    kind: 'filter',
                    filterId: filterStack[0]?.id,
                  });
                  openTool('filters');
                }}
                actionButton={
                  <button
                    type="button"
                    onClick={() => {
                      if (filterStack.length === 0) {
                        openTool('filters');
                        return;
                      }
                      const next = !activeFilterLayers.length;
                      patchProjectImmediate((cur) => {
                        const curFx = cur.videoEffects || DEFAULT_VIDEO_EFFECTS;
                        return {
                          videoEffects: {
                            ...curFx,
                            filterStack: (curFx.filterStack || []).map((f) => ({
                              ...f,
                              enabled: next,
                            })),
                          },
                        };
                      });
                    }}
                    className="w-6 h-6 rounded hover:bg-white/[0.08] flex items-center justify-center text-zinc-400 hover:text-white cursor-pointer shrink-0"
                    title={filtersVisible ? 'Toggle stacked filters' : 'Open Filters'}
                  >
                    {filtersVisible ? (
                      <Eye className="w-3.5 h-3.5 text-pink-300" />
                    ) : (
                      <EyeOff className="w-3.5 h-3.5 text-zinc-600" />
                    )}
                  </button>
                }
              />

              {/* 10. Effects */}
              <TrackHeader
                heightPx={trackRowHeightPx}
                active={selectedElement?.kind === 'effect'}
                locked={isTrackLocked(project, 'effects')}
                onToggleLock={() => handleToggleTrackLock('effects')}
                accentClass="border-l-fuchsia-400"
                icon={<Sparkles className="w-3.5 h-3.5 text-fuchsia-400 shrink-0" />}
                label="Effects"
                onClick={() => {
                  onSelectElement?.({
                    kind: 'effect',
                    effectId: allVisualEffects[0]?.id,
                  });
                  openTool('effects');
                }}
                actionButton={
                  <button
                    type="button"
                    onClick={() => {
                      if (allVisualEffects.length === 0) {
                        openTool('effects');
                        return;
                      }
                      const next = !effectsVisible;
                      patchProjectImmediate((cur) => {
                        const curFx = cur.videoEffects || DEFAULT_VIDEO_EFFECTS;
                        return {
                          videoEffects: {
                            ...curFx,
                            effects: (curFx.effects || []).map((e) => ({
                              ...e,
                              enabled: next,
                            })),
                          },
                        };
                      });
                    }}
                    className="w-6 h-6 rounded hover:bg-white/[0.08] flex items-center justify-center text-zinc-400 hover:text-white cursor-pointer shrink-0"
                    title={effectsVisible ? 'Disable Effects' : 'Enable Effects'}
                  >
                    {effectsVisible ? (
                      <Eye className="w-3.5 h-3.5 text-fuchsia-300" />
                    ) : (
                      <EyeOff className="w-3.5 h-3.5 text-zinc-600" />
                    )}
                  </button>
                }
              />
          </div>
        </div>

        {/* CENTER: SCROLLABLE TIMELINE RULER & CLIP CONTENT */}
        <div
          ref={scrollContainerRef}
          onScroll={syncVerticalFromCenter}
          className="flex-1 min-w-0 overflow-auto overscroll-contain relative bg-[#0C0C11]"
        >
          <div
            className="flex min-h-full"
            style={{ width: zoom > 1 ? `${zoom * 100}%` : '100%' }}
          >
            {/* Left edge gutter inside scrollable canvas */}
            <div className="w-1.5 shrink-0 flex flex-col">
              <div className="sticky top-0 z-20 h-8 lg:h-7 shrink-0 bg-[#14141B] border-b border-white/[0.08]" />
            </div>

            {/* Unified 0%..100% Coordinate Box for Time Ruler, Playhead & All Track Lanes */}
            <div ref={trackAreaRef} className="flex-1 min-w-0 relative flex flex-col">
              {/* Sticky Interactive Time Ruler */}
              <div
                onPointerDown={handleRulerPointerDown}
                onPointerMove={handleTrackPointerMove}
                onPointerUp={handleTrackPointerUp}
                onPointerCancel={handleTrackPointerUp}
                className="sticky top-0 z-20 h-8 lg:h-7 shrink-0 border-b border-white/[0.08] bg-[#14141B] cursor-ew-resize touch-none overflow-hidden"
              >
                {timeMarkers.minors.map((t) => {
                  const leftPct = (t / Math.max(0.01, duration)) * 100;
                  return (
                    <div
                      key={`min-${t}`}
                      style={{ left: `${leftPct}%` }}
                      className="absolute bottom-0 h-1.5 w-[1px] bg-zinc-700 pointer-events-none"
                    />
                  );
                })}
                {timeMarkers.majors.map((t, idx) => {
                  const leftPct = (t / Math.max(0.01, duration)) * 100;
                  return (
                    <div
                      key={`maj-${t}`}
                      style={{ left: `${leftPct}%` }}
                      className={`absolute top-0 bottom-0 flex flex-col justify-end pointer-events-none ${
                        idx === timeMarkers.majors.length - 1 ? '-translate-x-full items-end' : ''
                      }`}
                    >
                      <span className="px-1 text-[10px] font-mono text-zinc-400 tabular-nums leading-none mb-1">
                        {formatTimecode(t).slice(0, 5)}
                      </span>
                      <div className="h-2 w-[1px] bg-zinc-400/70" />
                    </div>
                  );
                })}
              </div>

              {/* White Playhead Needle + Line across Ruler & All Lanes */}
              <div
                className="absolute top-0 bottom-0 -ml-[1px] w-[2px] bg-white z-30 pointer-events-none shadow-[0_0_8px_rgba(255,255,255,0.65)]"
                style={{ left: `${playheadPct}%` }}
              >
                <div className="sticky top-0 w-4 h-4 -ml-[7px] lg:w-3 lg:h-3.5 lg:-ml-[5px] bg-white [clip-path:polygon(0_0,100%_0,100%_60%,50%_100%,0_60%)]" />
              </div>

              {/* Live Duration & Timing Tooltip while Trimming or Moving */}
              {dragTooltip && (
                <div className="sticky top-1 z-50 h-0 overflow-visible pointer-events-none">
                  <div
                    style={{ left: `${dragTooltip.xPct}%` }}
                    className="relative -translate-x-1/2 w-fit px-2 py-0.5 rounded-md bg-violet-600 text-white text-[10.5px] font-mono font-semibold shadow-xl border border-white/25 whitespace-nowrap"
                  >
                    {dragTooltip.label}
                  </div>
                </div>
              )}

              {/* 10 Track Lanes — All sharing exact 0%..100% bounds */}
              <div className="py-1.5 space-y-1.5">
                {/* Lane 1: Video Track with Real FFmpeg Filmstrip Thumbnails */}
                <div
                  style={{ height: `${videoRowHeightPx}px` }}
                  onPointerDown={handleTrackPointerDown}
                  onPointerMove={handleTrackPointerMove}
                  onPointerUp={handleTrackPointerUp}
                  onClick={handleTrackClick}
                  className="relative rounded-lg overflow-clip bg-[#13131A] border border-white/[0.06] touch-pan-x touch-pan-y"
                >
                  <MobileTrackMicroBadge label="Video" dotClass="bg-violet-400" />
                  {videoClips.map((clip, idx) => {
                    const clipEnd = getVideoClipTimelineEnd(clip);
                    const clipDur = getVideoClipTimelineDuration(clip);
                    const { left, width } = computeClipGeometry(
                      clip.timelineStart,
                      clipEnd,
                      duration
                    );
                    const isSel = isVideoClipSelected(clip.id);
                    const isLocked = Boolean(project.canvas?.videoLocked || clip.locked);
                    const hasCustomSpeed = Math.abs(clip.speed - 1.0) > 0.01;
                    const thumbCount = Math.max(3, Math.min(18, Math.round((width / 100) * 16 * zoom)));
                    const thumbs = getClipThumbnails(clip.sourceStart, clip.sourceEnd, thumbCount);
                    const clipOrigPeaks = !clip.audioUnlinked
                      ? slicePeaksByRatio(
                          origPeaks,
                          clip.sourceStart / srcDuration,
                          clip.sourceEnd / srcDuration
                        )
                      : [];

                    return (
                      <div
                        key={clip.id}
                        data-testid={`timeline-video-clip-${clip.id}`}
                        onPointerDown={(e) =>
                          startClipDrag(e, {
                            kind: 'video-clip',
                            id: clip.id,
                            mode: 'move',
                            origStart: clip.timelineStart,
                            origEnd: clipEnd,
                            origSourceStart: clip.sourceStart,
                            origSourceEnd: clip.sourceEnd,
                            clipSpeed: clip.speed,
                            maxSourceDuration: srcDuration,
                            locked: isLocked,
                          })
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          if (suppressClickRef.current) return;
                          onSelectElement?.({ kind: 'video', clipId: clip.id });
                        }}
                        style={{ left: `${left}%`, width: `${width}%`, minWidth: '4px' }}
                        title={`${clip.label || `Clip ${idx + 1}`} · ${clip.speed}x (${clip.timelineStart.toFixed(
                          2
                        )}s → ${clipEnd.toFixed(2)}s · ${clipDur.toFixed(2)}s)${isLocked ? ' · Locked' : ''}`}
                        className={`group absolute inset-y-0.5 rounded-md flex items-center justify-between overflow-hidden border touch-none bg-zinc-900 ${
                          isLocked ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'
                        } ${
                          isSel
                            ? isLocked
                              ? 'border-amber-400 ring-2 ring-amber-400/60 z-10'
                              : 'border-white ring-2 ring-violet-500/70 z-10'
                            : isLocked
                            ? 'border-amber-400/55 border-dashed'
                            : 'border-white/20 hover:border-white/45'
                        } ${videoVisible ? 'opacity-100' : 'opacity-40'}`}
                      >
                        {!isLocked && (
                          <div
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              startClipDrag(e, {
                                kind: 'video-clip',
                                id: clip.id,
                                mode: 'trim-start',
                                origStart: clip.timelineStart,
                                origEnd: clipEnd,
                                origSourceStart: clip.sourceStart,
                                origSourceEnd: clip.sourceEnd,
                                clipSpeed: clip.speed,
                                maxSourceDuration: srcDuration,
                                locked: isLocked,
                              });
                            }}
                            className={`w-2.5 h-full bg-white hover:bg-violet-100 cursor-ew-resize shrink-0 touch-none flex items-center justify-center z-20 transition-opacity ${
                              isSel ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                            }`}
                            title="Trim clip start"
                          >
                            <div className="w-[2px] h-3 bg-zinc-800 rounded-full" />
                          </div>
                        )}

                        <div className="flex-1 h-full relative overflow-hidden pointer-events-none">
                          {/* Real extracted filmstrip frames */}
                          {thumbs.length > 0 ? (
                            <div className="absolute inset-0 flex">
                              {thumbs.map((frame, fIdx) => (
                                <img
                                  key={`${clip.id}-f-${fIdx}`}
                                  src={frame.url}
                                  alt=""
                                  draggable={false}
                                  loading="lazy"
                                  className="h-full flex-1 min-w-0 object-cover border-r border-black/30 last:border-r-0"
                                />
                              ))}
                            </div>
                          ) : (
                            <div className="absolute inset-0 bg-gradient-to-r from-zinc-800 via-zinc-700/70 to-zinc-800" />
                          )}

                          {/* Subtle top scrim for crisp label legibility */}
                          <div className="absolute inset-x-0 top-0 h-5 bg-gradient-to-b from-black/75 to-transparent" />

                          {/* Linked Original Audio waveform strip along bottom edge */}
                          {clipOrigPeaks.length > 0 && !origTrackMuted && (
                            <div className="absolute inset-x-0 bottom-0 h-3.5 bg-black/45 px-0.5">
                              <WaveformSvg
                                peaks={clipOrigPeaks}
                                color="rgba(165, 243, 252, 0.85)"
                                bars={36}
                              />
                            </div>
                          )}

                          <div className="relative z-10 px-1.5 pt-0.5 flex items-center gap-1 text-[10px] font-semibold text-white drop-shadow">
                            {isLocked && <Lock className="w-2.5 h-2.5 text-amber-300 shrink-0" />}
                            <span className="truncate">
                              {clip.label || project.sourceFilename || `Clip ${idx + 1}`}
                            </span>
                            {hasCustomSpeed && (
                              <span className="px-1 rounded bg-violet-600/95 text-[9px] font-mono tabular-nums shrink-0">
                                {clip.speed}x
                              </span>
                            )}
                            {clip.audioUnlinked && (
                              <Unlink className="w-2.5 h-2.5 text-cyan-300 shrink-0" />
                            )}
                          </div>
                        </div>

                        {!isLocked && (
                          <div
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              startClipDrag(e, {
                                kind: 'video-clip',
                                id: clip.id,
                                mode: 'trim-end',
                                origStart: clip.timelineStart,
                                origEnd: clipEnd,
                                origSourceStart: clip.sourceStart,
                                origSourceEnd: clip.sourceEnd,
                                clipSpeed: clip.speed,
                                maxSourceDuration: srcDuration,
                                locked: isLocked,
                              });
                            }}
                            className={`w-2.5 h-full bg-white hover:bg-violet-100 cursor-ew-resize shrink-0 touch-none flex items-center justify-center z-20 transition-opacity ${
                              isSel ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                            }`}
                            title="Trim clip end"
                          >
                            <div className="w-[2px] h-3 bg-zinc-800 rounded-full" />
                          </div>
                        )}

                        <ClipEndBoundaryMarker locked={isLocked} selected={isSel} endTime={clipEnd} />
                      </div>
                    );
                  })}
                  {videoClips.length === 0 && (
                    <button
                      type="button"
                      onClick={() => (onRequestAddMedia ? onRequestAddMedia() : openTool('edit', 'media'))}
                      className="px-3 h-full w-full flex items-center text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer"
                    >
                      + Upload or import source video
                    </button>
                  )}
                </div>

              {/* Lane 2: Captions Track (Single-segment selection isolated) */}
              <div
                style={{ height: `${trackRowHeightPx}px` }}
                onPointerDown={handleTrackPointerDown}
                onPointerMove={handleTrackPointerMove}
                onPointerUp={handleTrackPointerUp}
                onClick={handleTrackClick}
                className={`relative rounded-lg bg-[#13131A] border overflow-clip cursor-pointer touch-pan-x touch-pan-y ${
                  showCaptionsLane ? 'block' : 'hidden lg:block'
                } ${isCaptionTrackSelected ? 'border-amber-400/50' : 'border-white/[0.05]'}`}
              >
                <MobileTrackMicroBadge label="Captions" dotClass="bg-amber-400" />
                {syncedCaptions.map((cap, idx) => {
                  const { left, width } = computeClipGeometry(
                    cap.syncedStart,
                    cap.syncedEnd,
                    duration
                  );
                  const rawCap = project.captions.find((c) => c.id === cap.id);
                  const isLocked = Boolean(project.subtitleStyle.locked || rawCap?.locked);
                  const displayText =
                    (cap.translatedText || '').trim() || (cap.text || '').trim();
                  const hasTranslated = Boolean((cap.translatedText || '').trim());
                  const isSel = isCaptionSegmentSelected(cap.id);
                  const isAtPlayhead =
                    currentTime >= cap.syncedStart && currentTime <= cap.syncedEnd;

                  return (
                    <div
                      key={cap.id}
                      onPointerDown={(e) =>
                        startClipDrag(e, {
                          kind: 'caption',
                          id: cap.id,
                          mode: 'move',
                          origStart: cap.syncedStart,
                          origEnd: cap.syncedEnd,
                          locked: isLocked,
                        })
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        if (suppressClickRef.current) return;
                        onSeek(cap.syncedStart);
                        onSelectElement?.({ kind: 'captions', segmentId: cap.id });
                      }}
                      title={`${displayText || `Caption ${idx + 1}`} (${cap.syncedStart.toFixed(
                        2
                      )}s → ${cap.syncedEnd.toFixed(2)}s)${isLocked ? ' · Locked' : ''}`}
                      className={`absolute inset-y-0.5 rounded flex items-center justify-between text-[10.5px] font-medium overflow-hidden border touch-none ${
                        isLocked ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'
                      } ${
                        !hasTranslated
                          ? isLocked
                            ? 'bg-red-500/25 border-amber-400/70 border-dashed text-red-100'
                            : 'bg-red-500/30 border-red-400/60 text-red-100'
                          : isSel
                          ? isLocked
                            ? 'bg-amber-400 border-amber-200 text-zinc-950 ring-2 ring-amber-300/70 z-10 font-semibold'
                            : 'bg-amber-400 border-white text-zinc-950 ring-1 ring-white/60 z-10 font-semibold'
                          : isAtPlayhead
                          ? 'bg-amber-500/95 border-amber-200 text-zinc-950'
                          : isLocked
                          ? 'bg-amber-500/65 border-amber-300/70 border-dashed text-zinc-950'
                          : 'bg-amber-500/75 hover:bg-amber-500/90 border-amber-300/40 text-zinc-950'
                      }`}
                      style={{ left: `${left}%`, width: `${width}%`, minWidth: '4px' }}
                    >
                      {isSel && !isLocked && (
                        <div
                          onPointerDown={(e) =>
                            startClipDrag(e, {
                              kind: 'caption',
                              id: cap.id,
                              mode: 'trim-start',
                              origStart: cap.syncedStart,
                              origEnd: cap.syncedEnd,
                              locked: isLocked,
                            })
                          }
                          className="w-2 h-full bg-white cursor-ew-resize shrink-0 touch-none z-20"
                          title="Trim caption start"
                        />
                      )}
                      <div className="flex items-center gap-1 px-1.5 min-w-0 flex-1 truncate pointer-events-none">
                        {isLocked && <Lock className="w-2.5 h-2.5 text-zinc-950 shrink-0" />}
                        <span className="truncate">{displayText || `[Caption ${idx + 1}]`}</span>
                      </div>
                      {isSel && !isLocked && (
                        <div
                          onPointerDown={(e) =>
                            startClipDrag(e, {
                              kind: 'caption',
                              id: cap.id,
                              mode: 'trim-end',
                              origStart: cap.syncedStart,
                              origEnd: cap.syncedEnd,
                              locked: isLocked,
                            })
                          }
                          className="w-2 h-full bg-white cursor-ew-resize shrink-0 touch-none z-20"
                          title="Trim caption end"
                        />
                      )}
                      <ClipEndBoundaryMarker locked={isLocked} selected={isSel} endTime={cap.syncedEnd} />
                    </div>
                  );
                })}
                {syncedCaptions.length === 0 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectElement?.({ kind: 'captions' });
                      openTool('captions');
                    }}
                    className="px-2.5 h-full w-full flex items-center text-[10.5px] text-zinc-500 hover:text-zinc-300 cursor-pointer"
                  >
                    + Add or generate subtitles
                  </button>
                )}
              </div>

              {/* Lane 3: Narration Track (Real per-clip or full-dub waveform) */}
              <div
                style={{ height: `${trackRowHeightPx}px` }}
                onPointerDown={handleTrackPointerDown}
                onPointerMove={handleTrackPointerMove}
                onPointerUp={handleTrackPointerUp}
                onClick={handleTrackClick}
                className={`relative rounded-lg bg-[#13131A] border overflow-clip cursor-pointer touch-pan-x touch-pan-y ${
                  showNarrationLane ? 'block' : 'hidden lg:block'
                } ${
                  selectedElement?.kind === 'audio' &&
                  (!selectedElement.track || selectedElement.track === 'dub')
                    ? 'border-teal-400/60'
                    : 'border-white/[0.05]'
                }`}
              >
                <MobileTrackMicroBadge label="Narration" dotClass="bg-teal-400" />
                {project.voice.generatedClips.length > 0 ? (
                  project.voice.generatedClips.map((clip) => {
                    const { left, width } = computeClipGeometry(clip.start, clip.end, duration);
                    const isSel =
                      selectedElement?.kind === 'audio' &&
                      selectedElement.track === 'dub' &&
                      selectedElement.clipId === clip.segmentId;
                    const isLocked = Boolean(project.voice.dubLocked || clip.locked);
                    const clipPeaks = audioWaveforms?.dubClips?.[clip.segmentId] || [];

                    return (
                      <div
                        key={clip.segmentId}
                        onPointerDown={(e) =>
                          startClipDrag(e, {
                            kind: 'dub-clip',
                            id: clip.segmentId,
                            mode: 'move',
                            origStart: clip.start,
                            origEnd: clip.end,
                            origTrimStart: clip.trimStartSec ?? 0,
                            maxAudioDuration: clip.duration,
                            locked: isLocked,
                          })
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          if (suppressClickRef.current) return;
                          onSeek(clip.start);
                          onSelectElement?.({
                            kind: 'audio',
                            track: 'dub',
                            clipId: clip.segmentId,
                          });
                        }}
                        className={`group absolute inset-y-0.5 rounded flex items-center justify-between overflow-hidden border touch-none ${
                          isLocked ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'
                        } ${
                          isSel
                            ? isLocked
                              ? 'bg-teal-700/90 border-amber-400 ring-1 ring-amber-300/60 text-white z-10'
                              : 'bg-teal-600/90 border-white ring-1 ring-white/50 text-white z-10'
                            : dubMuted
                            ? 'bg-zinc-800/90 border-zinc-700 text-zinc-400'
                            : isLocked
                            ? 'bg-teal-800/75 border-amber-400/55 border-dashed text-white'
                            : 'bg-teal-700/80 hover:bg-teal-600/85 border-teal-300/45 text-white'
                        }`}
                        style={{ left: `${left}%`, width: `${width}%`, minWidth: '4px' }}
                        title={`${clip.text} (${clip.start.toFixed(2)}s → ${clip.end.toFixed(2)}s)${isLocked ? ' · Locked' : ''}`}
                      >
                        {!isLocked && (
                          <div
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              startClipDrag(e, {
                                kind: 'dub-clip',
                                id: clip.segmentId,
                                mode: 'trim-start',
                                origStart: clip.start,
                                origEnd: clip.end,
                                origTrimStart: clip.trimStartSec ?? 0,
                                maxAudioDuration: clip.duration,
                                locked: isLocked,
                              });
                            }}
                            className={`w-2.5 h-full bg-white cursor-ew-resize shrink-0 touch-none flex items-center justify-center z-20 transition-opacity ${
                              isSel ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                            }`}
                            title="Trim clip start"
                          >
                            <div className="w-[2px] h-3 bg-zinc-800 rounded-full" />
                          </div>
                        )}

                        <div className="relative flex-1 h-full flex items-center gap-1 px-1.5 overflow-hidden pointer-events-none">
                          {clipPeaks.length > 0 && (
                            <div className="absolute inset-0 opacity-75">
                              <WaveformSvg
                                peaks={clipPeaks}
                                color="rgba(153, 246, 228, 0.9)"
                                muted={dubMuted}
                                bars={44}
                              />
                            </div>
                          )}
                          {isLocked && <Lock className="relative z-10 w-2.5 h-2.5 text-amber-300 shrink-0" />}
                          <span className="relative z-10 text-[10px] font-medium truncate drop-shadow">
                            {clip.text}
                          </span>
                        </div>

                        {!isLocked && (
                          <div
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              startClipDrag(e, {
                                kind: 'dub-clip',
                                id: clip.segmentId,
                                mode: 'trim-end',
                                origStart: clip.start,
                                origEnd: clip.end,
                                origTrimStart: clip.trimStartSec ?? 0,
                                maxAudioDuration: clip.duration,
                                locked: isLocked,
                              });
                            }}
                            className={`w-2.5 h-full bg-white cursor-ew-resize shrink-0 touch-none flex items-center justify-center z-20 transition-opacity ${
                              isSel ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                            }`}
                            title="Trim clip end"
                          >
                            <div className="w-[2px] h-3 bg-zinc-800 rounded-full" />
                          </div>
                        )}
                        <ClipEndBoundaryMarker locked={isLocked} selected={isSel} endTime={clip.end} />
                      </div>
                    );
                  })
                ) : project.voice.fullDubUrl ? (
                  (() => {
                    const dubStart = Math.max(0, project.voice.timingOffsetSec || 0);
                    const dubEnd = Math.min(
                      duration,
                      Math.max(
                        dubStart + 0.2,
                        project.voice.syncPlan?.estimatedFinalDuration || srcDuration
                      )
                    );
                    const { left, width } = computeClipGeometry(dubStart, dubEnd, duration);
                    const dubLocked = Boolean(project.voice.dubLocked);
                    const isSel =
                      selectedElement?.kind === 'audio' &&
                      (!selectedElement.track || selectedElement.track === 'dub');
                    return (
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectElement?.({ kind: 'audio', track: 'dub' });
                        }}
                        style={{ left: `${left}%`, width: `${width}%`, minWidth: '4px' }}
                        title={`${project.voice.fishVoiceTitle || 'Narration Track'} (${dubStart.toFixed(
                          2
                        )}s → ${dubEnd.toFixed(2)}s)${dubLocked ? ' · Locked' : ''}`}
                        className={`absolute inset-y-0.5 rounded px-2 flex items-center gap-1.5 border overflow-hidden ${
                          isSel
                            ? dubLocked
                              ? 'bg-teal-700/85 border-amber-400 text-white'
                              : 'bg-teal-600/85 border-white text-white'
                            : dubMuted
                            ? 'bg-zinc-900 border-white/[0.06] text-zinc-500'
                            : dubLocked
                            ? 'bg-teal-800/70 border-amber-400/55 border-dashed text-white'
                            : 'bg-teal-700/75 border-teal-300/45 text-white'
                        }`}
                      >
                        {audioWaveforms?.dub && audioWaveforms.dub.length > 0 && (
                          <div className="absolute inset-0 opacity-75">
                            <WaveformSvg
                              peaks={audioWaveforms.dub}
                              color="rgba(153, 246, 228, 0.9)"
                              muted={dubMuted}
                              bars={96}
                            />
                          </div>
                        )}
                        {dubLocked && <Lock className="relative z-10 w-2.5 h-2.5 text-amber-300 shrink-0" />}
                        <span className="relative z-10 text-[10.5px] font-medium truncate drop-shadow">
                          {project.voice.fishVoiceTitle || 'Narration Track'}
                        </span>
                        <ClipEndBoundaryMarker locked={dubLocked} selected={isSel} endTime={dubEnd} />
                      </div>
                    );
                  })()
                ) : (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectElement?.({ kind: 'audio', track: 'dub' });
                      openTool('audio', 'voice');
                    }}
                    className="px-2.5 h-full w-full flex items-center text-[10.5px] text-zinc-500 hover:text-zinc-300 cursor-pointer"
                  >
                    + Generate AI Voice narration
                  </button>
                )}
              </div>

              {/* Lane 4: Original Video Audio (Real waveform, independent 1.0x unlinked clips) */}
              <div
                style={{ height: `${trackRowHeightPx}px` }}
                onPointerDown={handleTrackPointerDown}
                onPointerMove={handleTrackPointerMove}
                onPointerUp={handleTrackPointerUp}
                onClick={handleTrackClick}
                className={`relative rounded-lg bg-[#13131A] border overflow-clip cursor-pointer touch-pan-x touch-pan-y ${
                  showOrigAudioLane ? 'block' : 'hidden lg:block'
                } ${
                  selectedElement?.kind === 'audio' && selectedElement.track === 'orig'
                    ? 'border-cyan-400/60'
                    : 'border-white/[0.05]'
                }`}
              >
                <MobileTrackMicroBadge label="Orig Audio" dotClass="bg-cyan-400" />
                {project.sourceVideoUrl ? (
                  hasUnlinkedAudio ? (
                    originalAudioClips.map((oa, idx) => {
                      const oaEnd = getOriginalAudioClipTimelineEnd(oa);
                      const { left, width } = computeClipGeometry(
                        oa.timelineStart,
                        oaEnd,
                        duration
                      );
                      const isSel =
                        selectedElement?.kind === 'audio' &&
                        selectedElement.track === 'orig' &&
                        (!selectedElement.clipId || selectedElement.clipId === oa.id);
                      const isLocked = Boolean(project.voice.origLocked || oa.locked);
                      const isClipMuted = origTrackMuted || Boolean(oa.muted);
                      const oaPeaks = slicePeaksByRatio(
                        origPeaks,
                        oa.sourceStart / srcDuration,
                        oa.sourceEnd / srcDuration
                      );

                      return (
                        <div
                          key={oa.id}
                          onPointerDown={(e) =>
                            startClipDrag(e, {
                              kind: 'orig-clip',
                              id: oa.id,
                              mode: 'move',
                              origStart: oa.timelineStart,
                              origEnd: oaEnd,
                              origSourceStart: oa.sourceStart,
                              origSourceEnd: oa.sourceEnd,
                              maxSourceDuration: srcDuration,
                              locked: isLocked,
                            })
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            if (suppressClickRef.current) return;
                            onSelectElement?.({ kind: 'audio', track: 'orig', clipId: oa.id });
                          }}
                          style={{ left: `${left}%`, width: `${width}%`, minWidth: '4px' }}
                          title={`${oa.label || `Original Audio ${idx + 1}`} · 1.0x (${oa.timelineStart.toFixed(
                            2
                          )}s → ${oaEnd.toFixed(2)}s)${isLocked ? ' · Locked' : ''}`}
                          className={`group absolute inset-y-0.5 rounded flex items-center justify-between text-[10px] font-medium overflow-hidden border touch-none ${
                            isLocked ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'
                          } ${
                            isSel
                              ? isLocked
                                ? 'bg-cyan-700/90 border-amber-400 ring-1 ring-amber-300/60 text-white z-10'
                                : 'bg-cyan-600/90 border-white ring-1 ring-white/50 text-white z-10'
                              : isClipMuted
                              ? 'bg-zinc-900 border-zinc-700 text-zinc-500'
                              : isLocked
                              ? 'bg-cyan-800/70 border-amber-400/55 border-dashed text-white'
                              : 'bg-cyan-700/75 hover:bg-cyan-600/85 border-cyan-300/45 text-white'
                          }`}
                        >
                          {!isLocked && (
                            <div
                              onPointerDown={(e) => {
                                e.stopPropagation();
                                startClipDrag(e, {
                                  kind: 'orig-clip',
                                  id: oa.id,
                                  mode: 'trim-start',
                                  origStart: oa.timelineStart,
                                  origEnd: oaEnd,
                                  origSourceStart: oa.sourceStart,
                                  origSourceEnd: oa.sourceEnd,
                                  maxSourceDuration: srcDuration,
                                  locked: isLocked,
                                });
                              }}
                              className={`w-2.5 h-full bg-white cursor-ew-resize shrink-0 touch-none flex items-center justify-center z-20 transition-opacity ${
                                isSel ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                              }`}
                              title="Trim start"
                            >
                              <div className="w-[2px] h-3 bg-zinc-800 rounded-full" />
                            </div>
                          )}

                          <div className="relative flex-1 h-full flex items-center gap-1 px-1.5 overflow-hidden pointer-events-none">
                            {oaPeaks.length > 0 && (
                              <div className="absolute inset-0 opacity-80">
                                <WaveformSvg
                                  peaks={oaPeaks}
                                  color="rgba(165, 243, 252, 0.9)"
                                  muted={isClipMuted}
                                  bars={48}
                                />
                              </div>
                            )}
                            {isLocked && <Lock className="relative z-10 w-2.5 h-2.5 text-amber-300 shrink-0" />}
                            <span className="relative z-10 truncate drop-shadow">
                              {oa.label || 'Original Audio'} · 1.0x
                            </span>
                          </div>

                          {!isLocked && (
                            <div
                              onPointerDown={(e) => {
                                e.stopPropagation();
                                startClipDrag(e, {
                                  kind: 'orig-clip',
                                  id: oa.id,
                                  mode: 'trim-end',
                                  origStart: oa.timelineStart,
                                  origEnd: oaEnd,
                                  origSourceStart: oa.sourceStart,
                                  origSourceEnd: oa.sourceEnd,
                                  maxSourceDuration: srcDuration,
                                  locked: isLocked,
                                });
                              }}
                              className={`w-2.5 h-full bg-white cursor-ew-resize shrink-0 touch-none flex items-center justify-center z-20 transition-opacity ${
                                isSel ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                              }`}
                              title="Trim end"
                            >
                              <div className="w-[2px] h-3 bg-zinc-800 rounded-full" />
                            </div>
                          )}
                          <ClipEndBoundaryMarker locked={isLocked} selected={isSel} endTime={oaEnd} />
                        </div>
                      );
                    })
                  ) : (
                    (() => {
                      const linkedStart = videoClips[0]?.timelineStart || 0;
                      const linkedEnd =
                        videoClips.length > 0
                          ? getVideoClipTimelineEnd(videoClips[videoClips.length - 1])
                          : srcDuration;
                      const { left, width } = computeClipGeometry(linkedStart, linkedEnd, duration);
                      const origLocked = Boolean(project.voice.origLocked);
                      const isSel =
                        selectedElement?.kind === 'audio' && selectedElement.track === 'orig';
                      return (
                        <div
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectElement?.({ kind: 'audio', track: 'orig' });
                          }}
                          style={{ left: `${left}%`, width: `${width}%`, minWidth: '4px' }}
                          title={`Original Audio (${linkedStart.toFixed(2)}s → ${linkedEnd.toFixed(
                            2
                          )}s)${origLocked ? ' · Locked' : ''}`}
                          className={`absolute inset-y-0.5 rounded px-2 flex items-center justify-between gap-2 border overflow-hidden ${
                            isSel
                              ? origLocked
                                ? 'bg-cyan-700/80 border-amber-400 text-white'
                                : 'bg-cyan-600/80 border-white text-white'
                              : origTrackMuted
                              ? 'bg-zinc-900 border-white/[0.06] text-zinc-500'
                              : origLocked
                              ? 'bg-cyan-800/65 border-amber-400/55 border-dashed text-white'
                              : 'bg-cyan-700/70 border-cyan-300/45 text-white'
                          }`}
                        >
                          {origPeaks.length > 0 && (
                            <div className="absolute inset-0 opacity-75">
                              <WaveformSvg
                                peaks={origPeaks}
                                color="rgba(165, 243, 252, 0.85)"
                                muted={origTrackMuted}
                                bars={88}
                              />
                            </div>
                          )}
                          <div className="relative z-10 flex items-center gap-1 min-w-0 truncate">
                            {origLocked && <Lock className="w-2.5 h-2.5 text-amber-300 shrink-0" />}
                            <span className="text-[10.5px] font-medium truncate drop-shadow">
                              Original Audio {origTrackMuted ? '(Muted)' : '(Linked)'}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (
                                isTrackLocked(projectRef.current, 'orig') ||
                                isTrackLocked(projectRef.current, 'video')
                              ) {
                                onNotify?.(LOCKED_LAYER_MESSAGE);
                                return;
                              }
                              patchProjectImmediate((cur) => {
                                const res = unlinkVideoClipAudio(cur, undefined, uuidv4);
                                return {
                                  videoClips: res.videoClips,
                                  originalAudioClips: res.originalAudioClips,
                                };
                              });
                              onSelectElement?.({ kind: 'audio', track: 'orig' });
                            }}
                            className="relative z-10 px-1.5 py-0.5 rounded bg-zinc-950/75 hover:bg-zinc-950 border border-cyan-400/50 text-[10px] font-semibold text-cyan-200 flex items-center gap-1 shrink-0 cursor-pointer"
                            title="Separate original audio onto independent 1.0x track"
                          >
                            <Unlink className="w-2.5 h-2.5" />
                            Unlink
                          </button>
                          <ClipEndBoundaryMarker locked={origLocked} selected={isSel} endTime={linkedEnd} />
                        </div>
                      );
                    })()
                  )
                ) : (
                  <span className="px-2.5 h-full flex items-center text-[10.5px] text-zinc-600">
                    No source audio
                  </span>
                )}
              </div>

              {/* Lane 5: Background Music Clips (Draggable, Left/Right Trimmable, Real Waveform) */}
              <div
                style={{ height: `${trackRowHeightPx}px` }}
                onPointerDown={handleTrackPointerDown}
                onPointerMove={handleTrackPointerMove}
                onPointerUp={handleTrackPointerUp}
                onClick={handleTrackClick}
                className={`relative rounded-lg bg-[#13131A] border overflow-clip cursor-pointer touch-pan-x touch-pan-y ${
                  showMusicLane ? 'block' : 'hidden lg:block'
                } ${
                  selectedElement?.kind === 'audio' && selectedElement.track === 'bgm'
                    ? 'border-indigo-400/60'
                    : 'border-white/[0.05]'
                }`}
              >
                <MobileTrackMicroBadge label="Music" dotClass="bg-indigo-400" />
                {bgmClips.length > 0 ? (
                  bgmClips.map((bc, idx) => {
                    const bcEnd = getTimelineAudioClipEnd(bc);
                    const { left, width } = computeClipGeometry(
                      bc.timelineStart,
                      bcEnd,
                      duration
                    );
                    const isSel =
                      selectedElement?.kind === 'audio' &&
                      selectedElement.track === 'bgm' &&
                      (!selectedElement.clipId || selectedElement.clipId === bc.id);
                    const isLocked = Boolean(project.voice.bgmLocked || bc.locked);
                    const isClipMuted = bgMusicMuted || Boolean(bc.muted);
                    const maxBgmSrc = Math.max(bc.sourceEnd, bc.sourceDuration ?? duration);
                    const bcPeaks = slicePeaksByRatio(
                      audioWaveforms?.bgm || [],
                      bc.sourceStart / Math.max(0.5, maxBgmSrc),
                      bc.sourceEnd / Math.max(0.5, maxBgmSrc)
                    );

                    return (
                      <div
                        key={bc.id}
                        onPointerDown={(e) =>
                          startClipDrag(e, {
                            kind: 'bgm-clip',
                            id: bc.id,
                            mode: 'move',
                            origStart: bc.timelineStart,
                            origEnd: bcEnd,
                            origSourceStart: bc.sourceStart,
                            origSourceEnd: bc.sourceEnd,
                            maxSourceDuration: maxBgmSrc,
                            locked: isLocked,
                          })
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          if (suppressClickRef.current) return;
                          onSelectElement?.({ kind: 'audio', track: 'bgm', clipId: bc.id });
                        }}
                        style={{ left: `${left}%`, width: `${width}%`, minWidth: '4px' }}
                        title={`${bc.label || `Music ${idx + 1}`} (${bc.timelineStart.toFixed(
                          2
                        )}s → ${bcEnd.toFixed(2)}s)${isLocked ? ' · Locked' : ''}`}
                        className={`group absolute inset-y-0.5 rounded flex items-center justify-between text-[10px] font-medium overflow-hidden border touch-none ${
                          isLocked ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'
                        } ${
                          isSel
                            ? isLocked
                              ? 'bg-indigo-700/90 border-amber-400 ring-1 ring-amber-300/60 text-white z-10'
                              : 'bg-indigo-600/90 border-white ring-1 ring-white/50 text-white z-10'
                            : isClipMuted
                            ? 'bg-zinc-900 border-zinc-700 text-zinc-500'
                            : isLocked
                            ? 'bg-indigo-800/70 border-amber-400/55 border-dashed text-white'
                            : 'bg-indigo-700/75 hover:bg-indigo-600/85 border-indigo-300/45 text-white'
                        }`}
                      >
                        {!isLocked && (
                          <div
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              startClipDrag(e, {
                                kind: 'bgm-clip',
                                id: bc.id,
                                mode: 'trim-start',
                                origStart: bc.timelineStart,
                                origEnd: bcEnd,
                                origSourceStart: bc.sourceStart,
                                origSourceEnd: bc.sourceEnd,
                                maxSourceDuration: maxBgmSrc,
                                locked: isLocked,
                              });
                            }}
                            className={`w-2.5 h-full bg-white cursor-ew-resize shrink-0 touch-none flex items-center justify-center z-20 transition-opacity ${
                              isSel ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                            }`}
                            title="Trim music start"
                          >
                            <div className="w-[2px] h-3 bg-zinc-800 rounded-full" />
                          </div>
                        )}

                        <div className="relative flex-1 h-full flex items-center gap-1 px-1.5 overflow-hidden pointer-events-none">
                          {bcPeaks.length > 0 && (
                            <div className="absolute inset-0 opacity-75">
                              <WaveformSvg
                                peaks={bcPeaks}
                                color="rgba(199, 210, 254, 0.9)"
                                muted={isClipMuted}
                                bars={72}
                              />
                            </div>
                          )}
                          {isLocked && <Lock className="relative z-10 w-2.5 h-2.5 text-amber-300 shrink-0" />}
                          <Music className="relative z-10 w-3 h-3 shrink-0" />
                          <span className="relative z-10 truncate drop-shadow">
                            {bc.label || project.voice.bgMusicFilename || 'Background Music'}
                          </span>
                        </div>

                        {!isLocked && (
                          <div
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              startClipDrag(e, {
                                kind: 'bgm-clip',
                                id: bc.id,
                                mode: 'trim-end',
                                origStart: bc.timelineStart,
                                origEnd: bcEnd,
                                origSourceStart: bc.sourceStart,
                                origSourceEnd: bc.sourceEnd,
                                maxSourceDuration: maxBgmSrc,
                                locked: isLocked,
                              });
                            }}
                            className={`w-2.5 h-full bg-white cursor-ew-resize shrink-0 touch-none flex items-center justify-center z-20 transition-opacity ${
                              isSel ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                            }`}
                            title="Trim music end"
                          >
                            <div className="w-[2px] h-3 bg-zinc-800 rounded-full" />
                          </div>
                        )}
                        <ClipEndBoundaryMarker locked={isLocked} selected={isSel} endTime={bcEnd} />
                      </div>
                    );
                  })
                ) : (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectElement?.({ kind: 'audio', track: 'bgm' });
                      openTool('audio', 'mixer');
                    }}
                    className="px-2.5 h-full w-full flex items-center text-[10.5px] text-zinc-500 hover:text-zinc-300 cursor-pointer"
                  >
                    + Add background music
                  </button>
                )}
              </div>

              {/* Lane 6: SFX Clips (Draggable, Left/Right Trimmable, Real Waveform) */}
              <div
                style={{ height: `${trackRowHeightPx}px` }}
                onPointerDown={handleTrackPointerDown}
                onPointerMove={handleTrackPointerMove}
                onPointerUp={handleTrackPointerUp}
                onClick={handleTrackClick}
                className={`relative rounded-lg bg-[#13131A] border overflow-clip cursor-pointer touch-pan-x touch-pan-y ${
                  showSfxLane ? 'block' : 'hidden lg:block'
                } ${
                  selectedElement?.kind === 'audio' && selectedElement.track === 'sfx'
                    ? 'border-emerald-400/60'
                    : 'border-white/[0.05]'
                }`}
              >
                <MobileTrackMicroBadge label="SFX" dotClass="bg-emerald-400" />
                {sfxClips.length > 0 ? (
                  sfxClips.map((sc, idx) => {
                    const scEnd = getTimelineAudioClipEnd(sc);
                    const { left, width } = computeClipGeometry(
                      sc.timelineStart,
                      scEnd,
                      duration
                    );
                    const isSel =
                      selectedElement?.kind === 'audio' &&
                      selectedElement.track === 'sfx' &&
                      (!selectedElement.clipId || selectedElement.clipId === sc.id);
                    const isLocked = Boolean(project.voice.sfxLocked || sc.locked);
                    const isClipMuted = sfxMuted || Boolean(sc.muted);
                    const maxSfxSrc = Math.max(sc.sourceEnd, sc.sourceDuration ?? duration);
                    const scPeaks = slicePeaksByRatio(
                      audioWaveforms?.sfx || [],
                      sc.sourceStart / Math.max(0.5, maxSfxSrc),
                      sc.sourceEnd / Math.max(0.5, maxSfxSrc)
                    );

                    return (
                      <div
                        key={sc.id}
                        onPointerDown={(e) =>
                          startClipDrag(e, {
                            kind: 'sfx-clip',
                            id: sc.id,
                            mode: 'move',
                            origStart: sc.timelineStart,
                            origEnd: scEnd,
                            origSourceStart: sc.sourceStart,
                            origSourceEnd: sc.sourceEnd,
                            maxSourceDuration: maxSfxSrc,
                            locked: isLocked,
                          })
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          if (suppressClickRef.current) return;
                          onSelectElement?.({ kind: 'audio', track: 'sfx', clipId: sc.id });
                        }}
                        style={{ left: `${left}%`, width: `${width}%`, minWidth: '4px' }}
                        title={`${sc.label || `SFX ${idx + 1}`} (${sc.timelineStart.toFixed(
                          2
                        )}s → ${scEnd.toFixed(2)}s)${isLocked ? ' · Locked' : ''}`}
                        className={`group absolute inset-y-0.5 rounded flex items-center justify-between text-[10px] font-medium overflow-hidden border touch-none ${
                          isLocked ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'
                        } ${
                          isSel
                            ? isLocked
                              ? 'bg-emerald-700/90 border-amber-400 ring-1 ring-amber-300/60 text-white z-10'
                              : 'bg-emerald-600/90 border-white ring-1 ring-white/50 text-white z-10'
                            : isClipMuted
                            ? 'bg-zinc-900 border-zinc-700 text-zinc-500'
                            : isLocked
                            ? 'bg-emerald-800/70 border-amber-400/55 border-dashed text-white'
                            : 'bg-emerald-700/75 hover:bg-emerald-600/85 border-emerald-300/45 text-white'
                        }`}
                      >
                        {!isLocked && (
                          <div
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              startClipDrag(e, {
                                kind: 'sfx-clip',
                                id: sc.id,
                                mode: 'trim-start',
                                origStart: sc.timelineStart,
                                origEnd: scEnd,
                                origSourceStart: sc.sourceStart,
                                origSourceEnd: sc.sourceEnd,
                                maxSourceDuration: maxSfxSrc,
                                locked: isLocked,
                              });
                            }}
                            className={`w-2.5 h-full bg-white cursor-ew-resize shrink-0 touch-none flex items-center justify-center z-20 transition-opacity ${
                              isSel ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                            }`}
                            title="Trim SFX start"
                          >
                            <div className="w-[2px] h-3 bg-zinc-800 rounded-full" />
                          </div>
                        )}

                        <div className="relative flex-1 h-full flex items-center gap-1 px-1.5 overflow-hidden pointer-events-none">
                          {scPeaks.length > 0 && (
                            <div className="absolute inset-0 opacity-75">
                              <WaveformSvg
                                peaks={scPeaks}
                                color="rgba(167, 243, 208, 0.9)"
                                muted={isClipMuted}
                                bars={72}
                              />
                            </div>
                          )}
                          {isLocked && <Lock className="relative z-10 w-2.5 h-2.5 text-amber-300 shrink-0" />}
                          <Zap className="relative z-10 w-3 h-3 shrink-0" />
                          <span className="relative z-10 truncate drop-shadow">
                            {sc.label || project.voice.sfxFilename || 'SFX Track'}
                          </span>
                        </div>

                        {!isLocked && (
                          <div
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              startClipDrag(e, {
                                kind: 'sfx-clip',
                                id: sc.id,
                                mode: 'trim-end',
                                origStart: sc.timelineStart,
                                origEnd: scEnd,
                                origSourceStart: sc.sourceStart,
                                origSourceEnd: sc.sourceEnd,
                                maxSourceDuration: maxSfxSrc,
                                locked: isLocked,
                              });
                            }}
                            className={`w-2.5 h-full bg-white cursor-ew-resize shrink-0 touch-none flex items-center justify-center z-20 transition-opacity ${
                              isSel ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                            }`}
                            title="Trim SFX end"
                          >
                            <div className="w-[2px] h-3 bg-zinc-800 rounded-full" />
                          </div>
                        )}
                        <ClipEndBoundaryMarker locked={isLocked} selected={isSel} endTime={scEnd} />
                      </div>
                    );
                  })
                ) : (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectElement?.({ kind: 'audio', track: 'sfx' });
                      openTool('audio', 'mixer');
                    }}
                    className="px-2.5 h-full w-full flex items-center text-[10.5px] text-zinc-500 hover:text-zinc-300 cursor-pointer"
                  >
                    + Add sound effect (SFX)
                  </button>
                )}
              </div>

              {/* Lane 7: Overlays & Text (Logos + Custom Text Elements) */}
              <div
                style={{ height: `${trackRowHeightPx}px` }}
                onPointerDown={handleTrackPointerDown}
                onPointerMove={handleTrackPointerMove}
                onPointerUp={handleTrackPointerUp}
                onClick={handleTrackClick}
                className={`relative rounded-lg bg-[#13131A] border overflow-clip cursor-pointer touch-pan-x touch-pan-y ${
                  showOverlaysLane ? 'block' : 'hidden lg:block'
                } ${
                  selectedElement?.kind === 'logo' || selectedElement?.kind === 'caption-element'
                    ? 'border-purple-400/60'
                    : 'border-white/[0.05]'
                }`}
              >
                <MobileTrackMicroBadge label="Overlays" dotClass="bg-purple-400" />
                {project.logos.map((logo) => {
                  const start = logo.permanent ? 0 : logo.startTime;
                  const end = logo.permanent ? duration : logo.endTime;
                  const { left, width } = computeClipGeometry(start, end, duration);
                  const isSel = selectedElement?.kind === 'logo' && selectedElement.id === logo.id;
                  const isLocked = Boolean(logo.locked);
                  return (
                    <div
                      key={logo.id}
                      onPointerDown={(e) =>
                        startClipDrag(e, {
                          kind: 'logo',
                          id: logo.id,
                          mode: 'move',
                          origStart: start,
                          origEnd: end,
                          locked: isLocked,
                        })
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        if (suppressClickRef.current) return;
                        onSelectElement?.({ kind: 'logo', id: logo.id });
                      }}
                      title={`${logo.filename} (${start.toFixed(2)}s → ${end.toFixed(2)}s)${isLocked ? ' · Locked' : ''}`}
                      className={`absolute inset-y-0.5 rounded flex items-center justify-between text-[10.5px] font-medium overflow-hidden border touch-none ${
                        isLocked ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'
                      } ${
                        isSel
                          ? isLocked
                            ? 'bg-violet-700 border-amber-400 ring-1 ring-amber-300/60 text-white z-10'
                            : 'bg-violet-600 border-white ring-1 ring-white/50 text-white z-10'
                          : logo.enabled
                          ? isLocked
                            ? 'bg-violet-700/75 border-amber-400/55 border-dashed text-white'
                            : 'bg-violet-600/80 border-violet-300/45 text-white hover:bg-violet-600'
                          : 'bg-zinc-800 border-zinc-700 text-zinc-400'
                      }`}
                      style={{ left: `${left}%`, width: `${width}%`, minWidth: '4px' }}
                    >
                      {isSel && !isLocked && (
                        <div
                          onPointerDown={(e) =>
                            startClipDrag(e, {
                              kind: 'logo',
                              id: logo.id,
                              mode: 'trim-start',
                              origStart: start,
                              origEnd: end,
                              locked: isLocked,
                            })
                          }
                          className="w-2.5 h-full bg-white hover:bg-violet-100 cursor-ew-resize shrink-0 touch-none flex items-center justify-center z-20"
                          title="Trim overlay start"
                        >
                          <div className="w-[2px] h-3 bg-zinc-800 rounded-full" />
                        </div>
                      )}
                      <div className="flex items-center gap-1 px-1.5 min-w-0 flex-1 truncate pointer-events-none">
                        {isLocked && <Lock className="w-2.5 h-2.5 text-amber-300 shrink-0" />}
                        <Layers className="w-3 h-3 shrink-0" />
                        <span className="truncate">{logo.filename}</span>
                      </div>
                      {isSel && !isLocked && (
                        <div
                          onPointerDown={(e) =>
                            startClipDrag(e, {
                              kind: 'logo',
                              id: logo.id,
                              mode: 'trim-end',
                              origStart: start,
                              origEnd: end,
                              locked: isLocked,
                            })
                          }
                          className="w-2.5 h-full bg-white hover:bg-violet-100 cursor-ew-resize shrink-0 touch-none flex items-center justify-center z-20"
                          title="Trim overlay end"
                        >
                          <div className="w-[2px] h-3 bg-zinc-800 rounded-full" />
                        </div>
                      )}
                      <ClipEndBoundaryMarker locked={isLocked} selected={isSel} endTime={end} />
                    </div>
                  );
                })}

                {(project.subtitleStyle.extraElements || []).map((el) => {
                  const start = el.startTime || 0;
                  const end = el.endTime > start ? el.endTime : duration;
                  const { left, width } = computeClipGeometry(start, end, duration);
                  const isSel =
                    selectedElement?.kind === 'caption-element' && selectedElement.id === el.id;
                  const isLocked = Boolean(el.locked);
                  return (
                    <div
                      key={el.id}
                      onPointerDown={(e) =>
                        startClipDrag(e, {
                          kind: 'caption-element',
                          id: el.id,
                          mode: 'move',
                          origStart: start,
                          origEnd: end,
                          locked: isLocked,
                        })
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        if (suppressClickRef.current) return;
                        onSelectElement?.({ kind: 'caption-element', id: el.id });
                      }}
                      title={`${el.text || el.label} (${start.toFixed(2)}s → ${end.toFixed(2)}s)${isLocked ? ' · Locked' : ''}`}
                      className={`absolute inset-y-0.5 rounded flex items-center justify-between text-[10.5px] font-medium overflow-hidden border touch-none ${
                        isLocked ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'
                      } ${
                        isSel
                          ? isLocked
                            ? 'bg-fuchsia-700 border-amber-400 ring-1 ring-amber-300/60 text-white z-10'
                            : 'bg-fuchsia-600 border-white ring-1 ring-white/50 text-white z-10'
                          : el.visible
                          ? isLocked
                            ? 'bg-purple-700/75 border-amber-400/55 border-dashed text-white'
                            : 'bg-purple-600/80 border-purple-300/45 text-white hover:bg-purple-600'
                          : 'bg-zinc-800 border-zinc-700 text-zinc-400'
                      }`}
                      style={{ left: `${left}%`, width: `${width}%`, minWidth: '4px' }}
                    >
                      {isSel && !isLocked && (
                        <div
                          onPointerDown={(e) =>
                            startClipDrag(e, {
                              kind: 'caption-element',
                              id: el.id,
                              mode: 'trim-start',
                              origStart: start,
                              origEnd: end,
                              locked: isLocked,
                            })
                          }
                          className="w-2.5 h-full bg-white cursor-ew-resize shrink-0 touch-none flex items-center justify-center z-20"
                          title="Trim start"
                        >
                          <div className="w-[2px] h-3 bg-zinc-800 rounded-full" />
                        </div>
                      )}
                      <div className="flex items-center gap-1 px-1.5 min-w-0 flex-1 truncate pointer-events-none">
                        {isLocked && <Lock className="w-2.5 h-2.5 text-amber-300 shrink-0" />}
                        <Type className="w-3 h-3 shrink-0" />
                        <span className="truncate">{el.text || el.label}</span>
                      </div>
                      {isSel && !isLocked && (
                        <div
                          onPointerDown={(e) =>
                            startClipDrag(e, {
                              kind: 'caption-element',
                              id: el.id,
                              mode: 'trim-end',
                              origStart: start,
                              origEnd: end,
                              locked: isLocked,
                            })
                          }
                          className="w-2.5 h-full bg-white cursor-ew-resize shrink-0 touch-none flex items-center justify-center z-20"
                          title="Trim end"
                        >
                          <div className="w-[2px] h-3 bg-zinc-800 rounded-full" />
                        </div>
                      )}
                      <ClipEndBoundaryMarker locked={isLocked} selected={isSel} endTime={end} />
                    </div>
                  );
                })}

                {project.logos.length === 0 &&
                  (project.subtitleStyle.extraElements || []).length === 0 && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openTool('overlay');
                      }}
                      className="px-2.5 h-full w-full flex items-center text-[10.5px] text-zinc-500 hover:text-zinc-300 cursor-pointer"
                    >
                      + Add logo or text overlay
                    </button>
                  )}
              </div>

              {/* Lane 8: Blur Zones */}
              <div
                style={{ height: `${trackRowHeightPx}px` }}
                onPointerDown={handleTrackPointerDown}
                onPointerMove={handleTrackPointerMove}
                onPointerUp={handleTrackPointerUp}
                onClick={handleTrackClick}
                className={`relative rounded-lg bg-[#13131A] border overflow-clip cursor-pointer touch-pan-x touch-pan-y ${
                  showBlurLane ? 'block' : 'hidden lg:block'
                } ${
                  selectedElement?.kind === 'blur' ? 'border-sky-400/60' : 'border-white/[0.05]'
                }`}
              >
                <MobileTrackMicroBadge label="Blur" dotClass="bg-sky-400" />
                {project.blurs.map((blur) => {
                  const isLinked = Boolean(blur.subtitleLink && blur.subtitleLink.mode !== 'manual');
                  const intervals = resolveBlurIntervals(blur, project, {
                    syncedCaptionsOverride: syncedCaptions.map((c) => ({
                      id: c.id,
                      syncedStart: c.syncedStart,
                      syncedEnd: c.syncedEnd,
                    })),
                  });
                  const span = getBlurTimelineSpan(blur, project, syncedCaptions.map((c) => ({
                    id: c.id,
                    syncedStart: c.syncedStart,
                    syncedEnd: c.syncedEnd,
                  })));
                  const isSel = selectedElement?.kind === 'blur' && selectedElement.id === blur.id;
                  const isLocked = Boolean(blur.locked);

                  // Render each active interval for multi-interval linked masks, or single editable block
                  const blocks = intervals.length > 0 ? intervals : [{ start: span.startTime, end: span.endTime }];
                  return blocks.map((iv, ivIdx) => {
                    const { left, width } = computeClipGeometry(iv.start, iv.end, duration);
                    return (
                      <div
                        key={`${blur.id}_${ivIdx}`}
                        onPointerDown={(e) =>
                          startClipDrag(e, {
                            kind: 'blur',
                            id: blur.id,
                            mode: 'move',
                            origStart: iv.start,
                            origEnd: iv.end,
                            locked: isLocked,
                          })
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          if (suppressClickRef.current) return;
                          onSeek(iv.start);
                          onSelectElement?.({ kind: 'blur', id: blur.id });
                        }}
                        title={`${
                          isLinked
                            ? `${blur.name} (Linked to ${blur.subtitleLink?.mode} captions · ${iv.start.toFixed(2)}s–${iv.end.toFixed(2)}s)`
                            : `${blur.name} (${iv.start.toFixed(2)}s–${iv.end.toFixed(2)}s)`
                        }${isLocked ? ' · Locked' : ''}`}
                        className={`absolute inset-y-0.5 rounded flex items-center justify-between text-[10.5px] font-medium overflow-hidden border touch-none ${
                          isLocked ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'
                        } ${
                          isSel
                            ? isLocked
                              ? 'bg-sky-700 border-amber-400 ring-1 ring-amber-300/60 text-white z-10'
                              : 'bg-sky-600 border-white ring-1 ring-white/50 text-white z-10'
                            : blur.enabled
                            ? isLocked
                              ? 'bg-sky-800/75 border-amber-400/55 border-dashed text-white'
                              : blur.isSubtitleMask
                              ? 'bg-cyan-700/80 hover:bg-cyan-600/85 border-cyan-300/50 text-white'
                              : 'bg-sky-700/80 hover:bg-sky-600/85 border-sky-300/45 text-white'
                            : 'bg-zinc-800 border-zinc-700 text-zinc-400'
                        }`}
                        style={{ left: `${left}%`, width: `${width}%`, minWidth: '4px' }}
                      >
                        {isSel && !isLocked && blocks.length === 1 && (
                          <div
                            onPointerDown={(e) =>
                              startClipDrag(e, {
                                kind: 'blur',
                                id: blur.id,
                                mode: 'trim-start',
                                origStart: iv.start,
                                origEnd: iv.end,
                                locked: isLocked,
                              })
                            }
                            className="w-2.5 h-full bg-white cursor-ew-resize shrink-0 touch-none flex items-center justify-center z-20"
                            title="Trim blur start"
                          >
                            <div className="w-[2px] h-3 bg-zinc-800 rounded-full" />
                          </div>
                        )}
                        <div className="flex items-center gap-1 px-1.5 min-w-0 flex-1 truncate pointer-events-none">
                          {isLocked && <Lock className="w-2.5 h-2.5 text-amber-300 shrink-0" />}
                          <Droplet className="w-3 h-3 shrink-0" />
                          <span className="truncate">{blur.name}</span>
                          {isLinked && (
                            <span className="text-[9px] font-mono px-1 py-0.2 rounded bg-black/30 text-cyan-200 shrink-0">
                              {blur.subtitleLink?.mode === 'translated' ? 'TR' : 'ORIG'}
                            </span>
                          )}
                        </div>
                        {isSel && !isLocked && blocks.length === 1 && (
                          <div
                            onPointerDown={(e) =>
                              startClipDrag(e, {
                                kind: 'blur',
                                id: blur.id,
                                mode: 'trim-end',
                                origStart: iv.start,
                                origEnd: iv.end,
                                locked: isLocked,
                              })
                            }
                            className="w-2.5 h-full bg-white cursor-ew-resize shrink-0 touch-none flex items-center justify-center z-20"
                            title="Trim blur end"
                          >
                            <div className="w-[2px] h-3 bg-zinc-800 rounded-full" />
                          </div>
                        )}
                        <ClipEndBoundaryMarker locked={isLocked} selected={isSel} endTime={iv.end} />
                      </div>
                    );
                  });
                })}
                {project.blurs.length === 0 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openTool('blur');
                    }}
                    className="px-2.5 h-full w-full flex items-center text-[10.5px] text-zinc-500 hover:text-zinc-300 cursor-pointer"
                  >
                    + Add blur or object tracking zone
                  </button>
                )}
              </div>

              {/* Lane 9: Color Filters & Stacked Timed Filter Layers */}
              <div
                style={{ height: `${trackRowHeightPx}px` }}
                onPointerDown={handleTrackPointerDown}
                onPointerMove={handleTrackPointerMove}
                onPointerUp={handleTrackPointerUp}
                onClick={handleTrackClick}
                className={`relative rounded-lg bg-[#13131A] border overflow-clip cursor-pointer touch-pan-x touch-pan-y ${
                  showFiltersLane ? 'block' : 'hidden lg:block'
                } ${
                  selectedElement?.kind === 'filter' ? 'border-pink-400/60' : 'border-white/[0.05]'
                }`}
              >
                <MobileTrackMicroBadge label="Filters" dotClass="bg-pink-400" />
                {filterStack.map((fl) => {
                  const start = Math.max(0, fl.startTime || 0);
                  const end = fl.endTime > start ? fl.endTime : duration;
                  const { left, width } = computeClipGeometry(start, end, duration);
                  const isSel =
                    selectedElement?.kind === 'filter' && selectedElement.filterId === fl.id;
                  const isLocked = Boolean(fl.locked);
                  const meta = getFilterPresetMeta(fl.preset);

                  return (
                    <div
                      key={fl.id}
                      onPointerDown={(e) =>
                        startClipDrag(e, {
                          kind: 'filter-item',
                          id: fl.id,
                          mode: 'move',
                          origStart: start,
                          origEnd: end,
                          locked: isLocked,
                        })
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        if (suppressClickRef.current) return;
                        onSelectElement?.({ kind: 'filter', filterId: fl.id });
                      }}
                      className={`absolute inset-y-0.5 rounded flex items-center justify-between text-[10.5px] font-medium overflow-hidden border touch-none ${
                        isLocked ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'
                      } ${
                        isSel
                          ? isLocked
                            ? 'bg-pink-700 border-amber-400 ring-1 ring-amber-300/60 text-white z-10'
                            : 'bg-pink-600 border-white ring-1 ring-white/50 text-white z-10'
                          : fl.enabled
                          ? isLocked
                            ? 'bg-pink-800/75 border-amber-400/55 border-dashed text-white'
                            : 'bg-pink-700/80 hover:bg-pink-600/85 border-pink-300/45 text-white'
                          : 'bg-zinc-800/80 border-zinc-700 text-zinc-400 opacity-65'
                      }`}
                      style={{ left: `${left}%`, width: `${width}%`, minWidth: '4px' }}
                      title={`${fl.name || meta.label} (${fl.intensity}%) · ${start.toFixed(1)}s → ${end.toFixed(1)}s${isLocked ? ' · Locked' : ''}`}
                    >
                      {isSel && !isLocked && (
                        <div
                          onPointerDown={(e) =>
                            startClipDrag(e, {
                              kind: 'filter-item',
                              id: fl.id,
                              mode: 'trim-start',
                              origStart: start,
                              origEnd: end,
                              locked: isLocked,
                            })
                          }
                          className="w-2.5 h-full bg-white cursor-ew-resize shrink-0 touch-none flex items-center justify-center z-20"
                          title="Trim filter start"
                        >
                          <div className="w-[2px] h-3 bg-zinc-800 rounded-full" />
                        </div>
                      )}
                      <div className="flex items-center gap-1 px-1.5 min-w-0 flex-1 truncate pointer-events-none">
                        {isLocked && <Lock className="w-2.5 h-2.5 text-amber-300 shrink-0" />}
                        <Wand2 className="w-3 h-3 shrink-0" />
                        <span className="truncate">
                          {fl.name || meta.label} ({fl.intensity}%)
                        </span>
                      </div>
                      {isSel && !isLocked && (
                        <div
                          onPointerDown={(e) =>
                            startClipDrag(e, {
                              kind: 'filter-item',
                              id: fl.id,
                              mode: 'trim-end',
                              origStart: start,
                              origEnd: end,
                              locked: isLocked,
                            })
                          }
                          className="w-2.5 h-full bg-white cursor-ew-resize shrink-0 touch-none flex items-center justify-center z-20"
                          title="Trim filter end"
                        >
                          <div className="w-[2px] h-3 bg-zinc-800 rounded-full" />
                        </div>
                      )}
                      <ClipEndBoundaryMarker locked={isLocked} selected={isSel} endTime={end} />
                    </div>
                  );
                })}

                {filterStack.length === 0 && fxConfig.filterPreset !== 'none' && (
                  (() => {
                    const gfEnd =
                      videoClips.length > 0 ? getVideoTimelineTotalDuration(videoClips) : srcDuration;
                    const { left, width } = computeClipGeometry(0, gfEnd, duration);
                    const gfLocked = Boolean(fxConfig.globalFilterLocked);
                    const isSel = selectedElement?.kind === 'filter' && !selectedElement.filterId;
                    return (
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectElement?.({ kind: 'filter' });
                          openTool('filters');
                        }}
                        style={{ left: `${left}%`, width: `${width}%`, minWidth: '4px' }}
                        title={`Global Filter: ${getFilterPresetMeta(fxConfig.filterPreset).label} (0.00s → ${gfEnd.toFixed(
                          2
                        )}s)${gfLocked ? ' · Locked' : ''}`}
                        className={`absolute inset-y-0.5 rounded px-2 flex items-center gap-1.5 border text-[10.5px] font-medium overflow-hidden ${
                          isSel
                            ? gfLocked
                              ? 'bg-pink-700/85 border-amber-400 text-white'
                              : 'bg-pink-600/80 border-white text-white'
                            : gfLocked
                            ? 'bg-pink-900/50 border-amber-400/55 border-dashed text-pink-100'
                            : 'bg-pink-900/50 border-pink-400/40 text-pink-100'
                        }`}
                      >
                        {gfLocked && <Lock className="w-2.5 h-2.5 text-amber-300 shrink-0" />}
                        <Wand2 className="w-3 h-3 shrink-0" />
                        <span className="truncate">
                          Global Filter: {getFilterPresetMeta(fxConfig.filterPreset).label} (
                          {fxConfig.filterIntensity ?? 100}%)
                        </span>
                        <ClipEndBoundaryMarker locked={gfLocked} selected={isSel} endTime={gfEnd} />
                      </div>
                    );
                  })()
                )}

                {filterStack.length === 0 && fxConfig.filterPreset === 'none' && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openTool('filters');
                    }}
                    className="px-2.5 h-full w-full flex items-center text-[10.5px] text-zinc-500 hover:text-zinc-300 cursor-pointer"
                  >
                    + Add color filter or stacked LUT layer
                  </button>
                )}
              </div>

              {/* Lane 10: Video Effects & Transitions */}
              <div
                style={{ height: `${trackRowHeightPx}px` }}
                onPointerDown={handleTrackPointerDown}
                onPointerMove={handleTrackPointerMove}
                onPointerUp={handleTrackPointerUp}
                onClick={handleTrackClick}
                className={`relative rounded-lg bg-[#13131A] border overflow-clip cursor-pointer touch-pan-x touch-pan-y ${
                  showEffectsLane ? 'block' : 'hidden lg:block'
                } ${
                  selectedElement?.kind === 'effect' ? 'border-fuchsia-400/60' : 'border-white/[0.05]'
                }`}
              >
                <MobileTrackMicroBadge label="Effects" dotClass="bg-fuchsia-400" />
                {allVisualEffects.map((fx) => {
                  const start = Math.max(0, fx.startTime || 0);
                  const end = fx.endTime > start ? fx.endTime : duration;
                  const { left, width } = computeClipGeometry(start, end, duration);
                  const isSel =
                    selectedElement?.kind === 'effect' && selectedElement.effectId === fx.id;
                  const isLocked = Boolean(fx.locked);
                  const cat = getEffectCatalogEntry(fx.type);

                  return (
                    <div
                      key={fx.id}
                      onPointerDown={(e) =>
                        startClipDrag(e, {
                          kind: 'effect-item',
                          id: fx.id,
                          mode: 'move',
                          origStart: start,
                          origEnd: end,
                          locked: isLocked,
                        })
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        if (suppressClickRef.current) return;
                        onSelectElement?.({ kind: 'effect', effectId: fx.id });
                      }}
                      className={`absolute inset-y-0.5 rounded flex items-center justify-between text-[10.5px] font-medium overflow-hidden border touch-none ${
                        isLocked ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'
                      } ${
                        isSel
                          ? isLocked
                            ? 'bg-fuchsia-700 border-amber-400 ring-1 ring-amber-300/60 text-white z-10'
                            : 'bg-fuchsia-600 border-white ring-1 ring-white/50 text-white z-10'
                          : fx.enabled
                          ? isLocked
                            ? 'bg-fuchsia-800/75 border-amber-400/55 border-dashed text-white'
                            : 'bg-fuchsia-700/80 hover:bg-fuchsia-600/85 border-fuchsia-300/45 text-white'
                          : 'bg-zinc-800/80 border-zinc-700 text-zinc-400 opacity-65'
                      }`}
                      style={{ left: `${left}%`, width: `${width}%`, minWidth: '4px' }}
                      title={`${fx.name || cat.label} (${fx.intensity}%) · ${start.toFixed(1)}s → ${end.toFixed(1)}s${isLocked ? ' · Locked' : ''}`}
                    >
                      {isSel && !isLocked && (
                        <div
                          onPointerDown={(e) =>
                            startClipDrag(e, {
                              kind: 'effect-item',
                              id: fx.id,
                              mode: 'trim-start',
                              origStart: start,
                              origEnd: end,
                              locked: isLocked,
                            })
                          }
                          className="w-2.5 h-full bg-white cursor-ew-resize shrink-0 touch-none flex items-center justify-center z-20"
                          title="Trim effect start"
                        >
                          <div className="w-[2px] h-3 bg-zinc-800 rounded-full" />
                        </div>
                      )}
                      <div className="flex items-center gap-1 px-1.5 min-w-0 flex-1 truncate pointer-events-none">
                        {isLocked && <Lock className="w-2.5 h-2.5 text-amber-300 shrink-0" />}
                        <Sparkles className="w-3 h-3 shrink-0" />
                        <span className="truncate">
                          {fx.name || cat.label} ({fx.intensity}%)
                        </span>
                      </div>
                      {isSel && !isLocked && (
                        <div
                          onPointerDown={(e) =>
                            startClipDrag(e, {
                              kind: 'effect-item',
                              id: fx.id,
                              mode: 'trim-end',
                              origStart: start,
                              origEnd: end,
                              locked: isLocked,
                            })
                          }
                          className="w-2.5 h-full bg-white cursor-ew-resize shrink-0 touch-none flex items-center justify-center z-20"
                          title="Trim effect end"
                        >
                          <div className="w-[2px] h-3 bg-zinc-800 rounded-full" />
                        </div>
                      )}
                      <ClipEndBoundaryMarker locked={isLocked} selected={isSel} endTime={end} />
                    </div>
                  );
                })}

                {allVisualEffects.length === 0 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openTool('effects');
                    }}
                    className="px-2.5 h-full w-full flex items-center text-[10.5px] text-zinc-500 hover:text-zinc-300 cursor-pointer"
                  >
                    + Add visual effect or transition
                  </button>
                )}
              </div>
            </div>
            </div>

            {/* Right-side padding inside scrollable timeline so final clip endpoints remain completely visible */}
            <div className="w-4 sm:w-5 shrink-0 flex flex-col">
              <div className="sticky top-0 z-20 h-8 lg:h-7 shrink-0 bg-[#14141B] border-b border-white/[0.08]" />
            </div>
          </div>
        </div>

        {/* RIGHT: DEDICATED ADD TRACK BUTTON COLUMN (Desktop only >= lg) */}
        <div
          ref={rightColRef}
          onScroll={(e) => syncVerticalFromSide(e.currentTarget)}
          style={centerHScrollbarPx > 0 ? { paddingBottom: `${centerHScrollbarPx}px` } : undefined}
          className="hidden lg:flex w-12 shrink-0 bg-[#121218] border-l border-white/[0.09] overflow-y-auto overflow-x-hidden no-scrollbar flex-col"
        >
          {/* Sticky Header aligned with Time Ruler (h-7) */}
          <div className="sticky top-0 z-40 h-7 shrink-0 bg-[#14141B] border-b border-white/[0.08] flex items-center justify-center">
            <span className="text-[9.5px] font-semibold uppercase tracking-wider text-zinc-500">
              Add
            </span>
          </div>

          <div className="p-1.5 space-y-1.5">
            {/* Row 1: Dedicated Add Media / Track button aligned with Video track */}
            <div style={{ height: `${videoRowHeightPx}px` }} className="flex items-center justify-center">
              <button
                type="button"
                onClick={() => (onRequestAddMedia ? onRequestAddMedia() : openTool('edit', 'media'))}
                title="Replace or upload media"
                aria-label="Add media or track"
                className="w-full h-full rounded-lg bg-[#20202A] hover:bg-violet-600 border border-white/[0.1] text-zinc-200 hover:text-white flex items-center justify-center cursor-pointer transition-colors"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>

            {/* Rows 2-10: Reserved track-aligned slots preventing any overlap */}
            {Array.from({ length: 9 }).map((_, slotIdx) => (
              <div
                key={slotIdx}
                style={{ height: `${trackRowHeightPx}px` }}
                aria-hidden="true"
                className="rounded-lg border border-white/[0.03] bg-[#14141B]/35"
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function MobileTrackMicroBadge({
  label,
  dotClass,
}: {
  label: string;
  dotClass: string;
}) {
  return (
    <div className="lg:hidden sticky left-1.5 top-0 h-0 w-0 overflow-visible z-20 pointer-events-none">
      <div className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#09090B]/85 backdrop-blur-xs border border-white/10 text-[9px] font-medium text-zinc-200 whitespace-nowrap shadow">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
        <span>{label}</span>
      </div>
    </div>
  );
}

function ClipEndBoundaryMarker({
  locked,
  selected,
  endTime,
}: {
  locked?: boolean;
  selected?: boolean;
  endTime: number;
}) {
  return (
    <div
      data-testid="clip-end-marker"
      data-end-time={endTime.toFixed(2)}
      aria-hidden="true"
      className="pointer-events-none absolute right-0 top-0 bottom-0 z-10 flex flex-col justify-between items-end"
    >
      <div
        className={`w-[3px] h-full shadow-[-1px_0_3px_rgba(0,0,0,0.65)] ${
          locked
            ? 'bg-amber-300/95'
            : selected
            ? 'bg-white'
            : 'bg-white/85'
        }`}
      />
    </div>
  );
}

function TrackHeader({
  heightPx,
  active,
  locked = false,
  onToggleLock,
  accentClass,
  icon,
  label,
  onClick,
  actionButton,
}: {
  heightPx: number;
  active: boolean;
  locked?: boolean;
  onToggleLock?: () => void;
  accentClass: string;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  actionButton?: React.ReactNode;
}) {
  return (
    <div
      style={{ height: `${heightPx}px` }}
      className={`px-1.5 rounded-md border border-l-2 ${accentClass} flex items-center justify-between gap-0.5 transition-colors ${
        active
          ? locked
            ? 'bg-amber-950/35 border-amber-400/55'
            : 'bg-[#22222E] border-white/25'
          : locked
          ? 'bg-amber-950/20 border-amber-500/35 hover:border-amber-400/55'
          : 'bg-[#17171F] border-white/[0.06] hover:border-white/[0.14]'
      }`}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex items-center gap-1.5 min-w-0 flex-1 text-left text-[11px] font-medium text-zinc-200 hover:text-white cursor-pointer"
      >
        {icon}
        <span className="whitespace-nowrap truncate">{label}</span>
      </button>
      {onToggleLock && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleLock();
          }}
          className={`w-6 h-6 rounded flex items-center justify-center cursor-pointer shrink-0 transition-colors ${
            locked
              ? 'bg-amber-500/20 text-amber-300 hover:bg-amber-500/30'
              : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.08]'
          }`}
          title={locked ? `Unlock ${label}` : `Lock ${label}`}
          aria-label={locked ? `Unlock ${label}` : `Lock ${label}`}
          aria-pressed={locked}
        >
          {locked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
        </button>
      )}
      {actionButton}
    </div>
  );
}
