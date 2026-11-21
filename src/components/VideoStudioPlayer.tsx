import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Crop,
  Grid,
  Loader2,
  Lock,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  BlurEffect,
  CanvasAspectRatio,
  CaptionElementLayer,
  DEFAULT_VIDEO_CANVAS,
  LogoOverlay,
  Project,
  SavedFontAsset,
  StudioElementSelection,
  SubtitleStyle,
  VideoCanvasConfig,
} from '../types/studio';
import { formatTimecode } from '../lib/formatters';
import { interpolateTrackingBox } from '../lib/visionEngine';
import {
  getActiveCaptionSourceText,
  getSyncedCaptionsForPreview,
  resolveCanvasDimensions,
} from '../lib/workflowStages';
import {
  applyTextTransform,
  buildCaptionDisplaySlice,
  normalizeCanonicalMode,
} from '../lib/captionModes';
import {
  ensureFontLoaded,
  getFontStatus,
  resolveClosestSupportedWeight,
  subscribeFontStatus,
} from '../lib/fontCatalog';
import { resolvePlayableAssetUrl } from '../lib/supabaseCloud';
import { retrieveProjectVideoBlob } from '../lib/browserStorage';
import {
  findActiveOriginalAudioAtTime,
  findActiveTimelineAudioAtTime,
  findActiveVideoClipAtTime,
  getEffectiveBgmClips,
  getEffectiveOriginalAudioClips,
  getEffectiveSfxClips,
  getEffectiveVideoClips,
  getProjectEffectiveDuration,
} from '../lib/videoTimeline';
import { resolveCombinedVideoFilter } from '../lib/videoFiltersCatalog';
import {
  getVideoFrameStageGeometry,
  isBlurActiveAtTime,
  stageBoxToVideoBox,
  videoBoxToStageBox,
} from '../lib/blurMasks';
import { buildOrderedLayerTokens } from './LayerPanel';
import { LOCKED_LAYER_MESSAGE } from '../lib/layerLock';

interface VideoStudioPlayerProps {
  project: Project;
  currentTime: number;
  onTimeUpdate: (time: number) => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  previewEffects: boolean;
  onTogglePreviewEffects: (val: boolean) => void;
  drawMode: 'none' | 'selective' | 'motion';
  onFinishDrawBox?: (box: { x: number; y: number; width: number; height: number }) => void;
  selectedLogoId?: string | null;
  onUpdateLogo?: (logoId: string, patch: Partial<LogoOverlay>) => void;
  selectedBlurId?: string | null;
  onUpdateBlur?: (blurId: string, patch: Partial<BlurEffect>) => void;
  onUpdateSubtitleStyle?: (patch: Partial<SubtitleStyle>) => void;
  selectedElement?: StudioElementSelection;
  onSelectElement?: (el: StudioElementSelection) => void;
  onUpdateCanvas?: (patch: Partial<VideoCanvasConfig>, opts?: { immediate?: boolean }) => void;
  customFonts?: SavedFontAsset[];
  readOnlyPreview?: boolean;
  cropEditMode?: boolean;
  onToggleCropEditMode?: (val: boolean) => void;
  variant?: 'classic' | 'capcut';
  timelineExpanded?: boolean;
  onToggleTimelineExpanded?: () => void;
  onAspectRatioChange?: (ratio: CanvasAspectRatio) => void;
  onOpenSpeedEditor?: () => void;
  mobileCollapsed?: boolean;
  onToggleMobileCollapsed?: () => void;
  onNotify?: (msg: string) => void;
}

type ResizeHandleDir = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

type ActiveInteraction = (
  | {
      kind: 'blur';
      id: string;
      action: 'move' | 'resize' | 'rotate';
      dir?: ResizeHandleDir;
      startClientX: number;
      startClientY: number;
      origX: number;
      origY: number;
      origW: number;
      origH: number;
      origRot: number;
      centerClientX?: number;
      centerClientY?: number;
    }
  | {
      kind: 'logo';
      id: string;
      action: 'move' | 'resize' | 'rotate';
      dir?: ResizeHandleDir;
      startClientX: number;
      startClientY: number;
      origX: number;
      origY: number;
      origW: number;
      origRot: number;
      centerClientX?: number;
      centerClientY?: number;
    }
  | {
      kind: 'captions';
      action: 'move' | 'resize' | 'rotate';
      dir?: ResizeHandleDir;
      startClientX: number;
      startClientY: number;
      origX: number;
      origY: number;
      origScale: number;
      origRot: number;
      centerClientX?: number;
      centerClientY?: number;
    }
  | {
      kind: 'caption-element';
      id: string;
      action: 'move' | 'resize' | 'rotate';
      dir?: ResizeHandleDir;
      startClientX: number;
      startClientY: number;
      origX: number;
      origY: number;
      origScale: number;
      origRot: number;
      centerClientX?: number;
      centerClientY?: number;
    }
  | {
      kind: 'video';
      action: 'move' | 'resize' | 'rotate';
      dir?: ResizeHandleDir;
      startClientX: number;
      startClientY: number;
      origOffsetX: number;
      origOffsetY: number;
      origZoom: number;
      origRot: number;
      centerClientX?: number;
      centerClientY?: number;
      moved: boolean;
    }
  | {
      kind: 'bg-image';
      action: 'move' | 'resize' | 'rotate';
      dir?: ResizeHandleDir;
      startClientX: number;
      startClientY: number;
      origOffsetX: number;
      origOffsetY: number;
      origScale: number;
      origRot: number;
      centerClientX?: number;
      centerClientY?: number;
    }
  | {
      kind: 'crop-box';
      action: 'move' | 'resize';
      dir?: ResizeHandleDir;
      startClientX: number;
      startClientY: number;
      origLeft: number; // % 0..100
      origTop: number; // % 0..100
      origRight: number; // % 0..100
      origBottom: number; // % 0..100
    }
) & { locked?: boolean };

const SNAP_TARGETS = [10, 50, 90];
const SNAP_THRESHOLD_PCT = 1.6;

// Shared WebAudio graph so gain ranges 0%..200% (0..2.0) work reliably without double-binding
let sharedAudioCtx: AudioContext | null = null;
const mediaGainNodes = new WeakMap<HTMLMediaElement, GainNode>();

function applyMediaGain(el: HTMLMediaElement | null, gainVal: number, isMuted: boolean) {
  if (!el) return;
  const targetGain = isMuted ? 0 : Math.max(0, Math.min(2.0, gainVal));

  if (typeof window !== 'undefined' && typeof AudioContext !== 'undefined') {
    try {
      if (!sharedAudioCtx) {
        sharedAudioCtx = new AudioContext();
      }
      let gainNode = mediaGainNodes.get(el);
      if (!gainNode) {
        const source = sharedAudioCtx.createMediaElementSource(el);
        gainNode = sharedAudioCtx.createGain();
        source.connect(gainNode);
        gainNode.connect(sharedAudioCtx.destination);
        mediaGainNodes.set(el, gainNode);
      }
      el.muted = isMuted;
      el.volume = 1;
      gainNode.gain.setTargetAtTime(targetGain, sharedAudioCtx.currentTime, 0.015);
      return;
    } catch {
      // Fallback to native element volume when WebAudio cannot attach
    }
  }

  el.muted = isMuted || targetGain <= 0.005;
  el.volume = Math.min(1, targetGain);
}

function resumeSharedAudioContext() {
  if (sharedAudioCtx && sharedAudioCtx.state === 'suspended') {
    void sharedAudioCtx.resume().catch(() => {});
  }
}

function snapPercent(val: number): { snapped: number; line: number | null } {
  for (const target of SNAP_TARGETS) {
    if (Math.abs(val - target) <= SNAP_THRESHOLD_PCT) {
      return { snapped: target, line: target };
    }
  }
  return { snapped: val, line: null };
}

function hexToRgba(hex: string, opacity: number): string {
  const clean = (hex || '#09090B').replace('#', '');
  const r = parseInt(clean.slice(0, 2) || '09', 16) || 0;
  const g = parseInt(clean.slice(2, 4) || '09', 16) || 0;
  const b = parseInt(clean.slice(4, 6) || '0B', 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

const HANDLE_CURSORS: Record<ResizeHandleDir, string> = {
  nw: 'cursor-nwse-resize',
  se: 'cursor-nwse-resize',
  ne: 'cursor-nesw-resize',
  sw: 'cursor-nesw-resize',
  n: 'cursor-ns-resize',
  s: 'cursor-ns-resize',
  e: 'cursor-ew-resize',
  w: 'cursor-ew-resize',
};

const HANDLE_POSITIONS: Record<ResizeHandleDir, string> = {
  nw: '-top-1.5 -left-1.5',
  n: '-top-1.5 left-1/2 -translate-x-1/2',
  ne: '-top-1.5 -right-1.5',
  e: 'top-1/2 -translate-y-1/2 -right-1.5',
  se: '-bottom-1.5 -right-1.5',
  s: '-bottom-1.5 left-1/2 -translate-x-1/2',
  sw: '-bottom-1.5 -left-1.5',
  w: 'top-1/2 -translate-y-1/2 -left-1.5',
};

function resolveCanvasCropPct(
  canvas: VideoCanvasConfig,
  srcW: number,
  srcH: number
): { left: number; right: number; top: number; bottom: number; cx: number; cy: number; cw: number; ch: number } {
  if (
    canvas.cropWidth &&
    canvas.cropHeight &&
    canvas.cropWidth >= 16 &&
    canvas.cropHeight >= 16 &&
    srcW > 0 &&
    srcH > 0
  ) {
    const cw = Math.max(16, Math.min(srcW, Math.round(canvas.cropWidth)));
    const ch = Math.max(16, Math.min(srcH, Math.round(canvas.cropHeight)));
    const cx = Math.max(0, Math.min(srcW - cw, Math.round(canvas.cropX || 0)));
    const cy = Math.max(0, Math.min(srcH - ch, Math.round(canvas.cropY || 0)));
    return {
      left: (cx / srcW) * 100,
      top: (cy / srcH) * 100,
      right: ((srcW - (cx + cw)) / srcW) * 100,
      bottom: ((srcH - (cy + ch)) / srcH) * 100,
      cx,
      cy,
      cw,
      ch,
    };
  }
  const left = Math.max(0, Math.min(45, canvas.cropLeft || 0));
  const right = Math.max(0, Math.min(45, canvas.cropRight || 0));
  const top = Math.max(0, Math.min(45, canvas.cropTop || 0));
  const bottom = Math.max(0, Math.min(45, canvas.cropBottom || 0));
  const cw = Math.max(16, Math.round(srcW * (1 - (left + right) / 100)));
  const ch = Math.max(16, Math.round(srcH * (1 - (top + bottom) / 100)));
  const cx = Math.max(0, Math.min(srcW - cw, Math.round((srcW * left) / 100)));
  const cy = Math.max(0, Math.min(srcH - ch, Math.round((srcH * top) / 100)));
  return { left, right, top, bottom, cx, cy, cw, ch };
}

export function VideoStudioPlayer({
  project,
  currentTime,
  onTimeUpdate,
  videoRef,
  previewEffects,
  onTogglePreviewEffects,
  drawMode,
  onFinishDrawBox,
  selectedLogoId,
  onUpdateLogo,
  selectedBlurId,
  onUpdateBlur,
  onUpdateSubtitleStyle,
  selectedElement,
  onSelectElement,
  onUpdateCanvas,
  customFonts = [],
  readOnlyPreview = false,
  cropEditMode,
  onToggleCropEditMode,
  variant = 'classic',
  timelineExpanded = false,
  onToggleTimelineExpanded,
  onAspectRatioChange,
  onOpenSpeedEditor,
  mobileCollapsed = false,
  onToggleMobileCollapsed,
  onNotify,
}: VideoStudioPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageViewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const cropBoxContainerRef = useRef<HTMLDivElement>(null);
  const bgVideoRef = useRef<HTMLVideoElement>(null);
  const origAudioRef = useRef<HTMLAudioElement>(null);
  const dubAudioRef = useRef<HTMLAudioElement>(null);
  const musicAudioRef = useRef<HTMLAudioElement>(null);
  const sfxAudioRef = useRef<HTMLAudioElement>(null);
  const playClockRef = useRef<{ startedAtPerf: number; startedAtTimeline: number } | null>(null);
  const lockedNotifySentRef = useRef(false);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [aspectMenuOpen, setAspectMenuOpen] = useState(false);
  const [localCropEditMode, setLocalCropEditMode] = useState(false);
  const isCropEditActive =
    !readOnlyPreview &&
    Boolean(onUpdateCanvas) &&
    !project.canvas?.videoLocked &&
    (cropEditMode !== undefined ? cropEditMode : localCropEditMode);

  const setCropEditActive = (next: boolean) => {
    if (next && project.canvas?.videoLocked) {
      onNotify?.(LOCKED_LAYER_MESSAGE);
      return;
    }
    if (onToggleCropEditMode) onToggleCropEditMode(next);
    setLocalCropEditMode(next);
  };

  const [aspectPreviewMode, setAspectPreviewMode] = useState<'original' | 'export'>(() => {
    const c = project.canvas || DEFAULT_VIDEO_CANVAS;
    return (c.aspectRatio && c.aspectRatio !== 'original') ||
      project.exportSettings.aspectRatio !== 'original'
      ? 'export'
      : 'original';
  });
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  const [stageSize, setStageSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  const [, setFontTick] = useState(0);

  const canvas: VideoCanvasConfig = { ...DEFAULT_VIDEO_CANVAS, ...(project.canvas || {}) };
  const effectiveAspect =
    canvas.aspectRatio && canvas.aspectRatio !== 'original'
      ? canvas.aspectRatio
      : project.exportSettings.aspectRatio;

  const editingGuidesOn = !readOnlyPreview && canvas.showEditingGuides !== false;

  useEffect(() => {
    if (effectiveAspect !== 'original') {
      setAspectPreviewMode('export');
    }
  }, [effectiveAspect]);

  // Measure available viewport around the stage so the video scales maximally inside resizable panes
  useEffect(() => {
    const vp = stageViewportRef.current;
    if (!vp || typeof ResizeObserver === 'undefined') return;
    const measureVp = () => {
      const rect = vp.getBoundingClientRect();
      setViewportSize((prev) =>
        Math.abs(prev.width - rect.width) > 1 || Math.abs(prev.height - rect.height) > 1
          ? { width: rect.width, height: rect.height }
          : prev
      );
    };
    measureVp();
    const ro = new ResizeObserver(() => measureVp());
    ro.observe(vp);
    return () => ro.disconnect();
  }, [variant, isFullscreen]);

  // Track fullscreen status cleanly
  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement && document.fullscreenElement === containerRef.current));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const hasVideoSource = Boolean(project.sourceVideoUrl || project.sourceVideoBlobKey);

  // Measure actual preview stage pixel size so typography renders strictly proportional to export resolution
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setStageSize((prev) =>
        Math.abs(prev.width - rect.width) > 1 || Math.abs(prev.height - rect.height) > 1
          ? { width: rect.width, height: rect.height }
          : prev
      );
    };
    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasVideoSource, project.id, aspectPreviewMode, effectiveAspect, viewportSize.width, viewportSize.height]);

  // Load and monitor primary caption font & extra element fonts via real FontFace loader
  useEffect(() => {
    const unsub = subscribeFontStatus(() => setFontTick((t) => t + 1));
    const st = project.subtitleStyle;
    const primaryWeight =
      st.fontWeightNum ||
      (st.fontWeight === '900' ? 900 : st.fontWeight === 'bold' ? 700 : 400);
    const customMatch = customFonts.find(
      (cf) => cf.family.toLowerCase() === (st.fontFamily || '').toLowerCase()
    );
    void ensureFontLoaded({
      family: st.fontFamily || 'Montserrat',
      weight: primaryWeight,
      italic: Boolean(st.italic),
      customUrl: customMatch?.url || st.customFontUrl,
    });

    for (const seg of project.captions || []) {
      const ov = seg.styleOverride;
      if (!ov?.fontFamily) continue;
      const ovW = ov.fontWeightNum || (ov.fontWeight === '900' ? 900 : ov.fontWeight === 'bold' ? 700 : primaryWeight);
      const ovMatch = customFonts.find((cf) => cf.family.toLowerCase() === ov.fontFamily!.toLowerCase());
      void ensureFontLoaded({
        family: ov.fontFamily,
        weight: ovW,
        italic: Boolean(ov.italic ?? st.italic),
        customUrl: ovMatch?.url || ov.customFontUrl,
      });
    }

    for (const el of st.extraElements || []) {
      if (!el.visible) continue;
      const fam = el.style?.fontFamily || st.fontFamily || 'Montserrat';
      const w = el.style?.fontWeightNum || primaryWeight;
      const cMatch = customFonts.find((cf) => cf.family.toLowerCase() === fam.toLowerCase());
      void ensureFontLoaded({
        family: fam,
        weight: w,
        italic: Boolean(el.style?.italic),
        customUrl: cMatch?.url || el.style?.customFontUrl,
      });
    }
    return unsub;
  }, [
    project.subtitleStyle.fontFamily,
    project.subtitleStyle.fontWeight,
    project.subtitleStyle.fontWeightNum,
    project.subtitleStyle.italic,
    project.subtitleStyle.customFontUrl,
    project.subtitleStyle.extraElements,
    project.captions,
    customFonts,
  ]);

  const primaryWeight =
    project.subtitleStyle.fontWeightNum ||
    (project.subtitleStyle.fontWeight === '900'
      ? 900
      : project.subtitleStyle.fontWeight === 'bold'
      ? 700
      : 400);
  const primaryFontStatus = getFontStatus(
    project.subtitleStyle.fontFamily || 'Montserrat',
    resolveClosestSupportedWeight(project.subtitleStyle.fontFamily || 'Montserrat', primaryWeight)
  );

  // Interactive box drawing state (for Selective / Motion Blur)
  const [dragDraw, setDragDraw] = useState<{
    startX: number;
    startY: number;
    curX: number;
    curY: number;
  } | null>(null);

  const [interaction, setInteraction] = useState<ActiveInteraction | null>(null);
  const [snapGuides, setSnapGuides] = useState<{ x: number | null; y: number | null }>({
    x: null,
    y: null,
  });

  // Video Filters & Effects Preview Controls
  const [compareModeActive, setCompareModeActive] = useState(false);
  const [showSafeGuides, setShowSafeGuides] = useState(
    Boolean(project.subtitleStyle.showSafeGuides)
  );

  useEffect(() => {
    setShowSafeGuides(Boolean(project.subtitleStyle.showSafeGuides));
  }, [project.subtitleStyle.showSafeGuides]);

  const srcDuration = project.metadata?.duration || 0;
  const videoClips = useMemo(() => getEffectiveVideoClips(project), [project]);
  const originalAudioClips = useMemo(() => getEffectiveOriginalAudioClips(project), [project]);
  const hasUnlinkedAudio = originalAudioClips.length > 0;
  const activeVideoMatch = useMemo(
    () => findActiveVideoClipAtTime(videoClips, currentTime),
    [videoClips, currentTime]
  );
  const activeOrigAudioMatch = useMemo(
    () => (hasUnlinkedAudio ? findActiveOriginalAudioAtTime(originalAudioClips, currentTime) : null),
    [hasUnlinkedAudio, originalAudioClips, currentTime]
  );
  const activeVideoSpeed = activeVideoMatch?.clip.speed ?? 1.0;

  const useDubAudio = Boolean(project.voice.enabled && project.voice.fullDubUrl);
  const dubTotalDuration = useDubAudio
    ? Math.max(
        project.voice.syncPlan?.estimatedFinalDuration || 0,
        (dubAudioRef.current?.duration || 0) + (project.voice.timingOffsetSec || 0)
      )
    : 0;
  const effectiveDuration = hasVideoSource
    ? Math.max(getProjectEffectiveDuration(project), dubTotalDuration)
    : 0;

  const isVideoLayerVisible = Boolean(
    canvas.videoVisible !== false &&
      (activeVideoMatch ||
        (videoClips.length === 0 &&
          hasVideoSource &&
          !project.workflow?.completedStages?.includes('editor')))
  );

  const bgmClips = useMemo(
    () => getEffectiveBgmClips(project, effectiveDuration || project.metadata?.duration || 12),
    [project, effectiveDuration]
  );
  const sfxClips = useMemo(
    () => getEffectiveSfxClips(project, effectiveDuration || project.metadata?.duration || 12),
    [project, effectiveDuration]
  );
  const activeBgmMatch = useMemo(
    () => findActiveTimelineAudioAtTime(bgmClips, currentTime),
    [bgmClips, currentTime]
  );
  const activeSfxMatch = useMemo(
    () => findActiveTimelineAudioAtTime(sfxClips, currentTime),
    [sfxClips, currentTime]
  );

  const [previewVideoUrl, setPreviewVideoUrl] = useState<string | null>(null);
  const [previewVideoStatus, setPreviewVideoStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [previewVideoError, setPreviewVideoError] = useState<string | null>(null);
  const [videoReloadNonce, setVideoReloadNonce] = useState(0);
  const ownedObjectUrlRef = useRef<string | null>(null);

  const [resolvedUrls, setResolvedUrls] = useState<{
    dub: string | null;
    music: string | null;
    sfx: string | null;
    bgImage: string | null;
    logos: Record<string, string>;
  }>({
    dub: project.voice.fullDubUrl || null,
    music: project.voice.bgMusicUrl || null,
    sfx: project.voice.sfxUrl || null,
    bgImage: project.canvas?.bgImageUrl || null,
    logos: {},
  });

  const latestCloudAssetsRef = useRef(project.cloudAssets);
  latestCloudAssetsRef.current = project.cloudAssets;
  const latestLogosRef = useRef(project.logos);
  latestLogosRef.current = project.logos;

  const logosUrlSignature = useMemo(
    () => (project.logos || []).map((l) => `${l.id}:${l.url}`).join('|'),
    [project.logos]
  );

  // Resolve auxiliary audio, background image, and logo overlays asynchronously without resetting on X/Y drag or metadata save
  useEffect(() => {
    let active = true;
    const bgUrl = project.canvas?.bgImageUrl || null;
    const logoList = latestLogosRef.current || [];
    const cloudAssets = latestCloudAssetsRef.current;
    setResolvedUrls((prev) => ({
      ...prev,
      dub: project.voice.fullDubUrl || null,
      music: project.voice.bgMusicUrl || null,
      sfx: project.voice.sfxUrl || null,
      bgImage: bgUrl,
    }));
    void Promise.all([
      resolvePlayableAssetUrl(project.voice.fullDubUrl || null, cloudAssets),
      resolvePlayableAssetUrl(project.voice.bgMusicUrl || null, cloudAssets),
      resolvePlayableAssetUrl(project.voice.sfxUrl || null, cloudAssets),
      resolvePlayableAssetUrl(bgUrl, cloudAssets),
      Promise.all(
        logoList.map(async (l) => [
          l.id,
          (await resolvePlayableAssetUrl(l.url, cloudAssets)) || l.url,
        ] as const)
      ),
    ]).then(([dub, music, sfx, bgImage, logoEntries]) => {
      if (!active) return;
      setResolvedUrls({
        dub: dub || project.voice.fullDubUrl || null,
        music: music || project.voice.bgMusicUrl || null,
        sfx: sfx || project.voice.sfxUrl || null,
        bgImage: bgImage || bgUrl,
        logos: Object.fromEntries(logoEntries),
      });
    });
    return () => {
      active = false;
    };
  }, [
    project.id,
    project.voice.fullDubUrl,
    project.voice.bgMusicUrl,
    project.voice.sfxUrl,
    project.canvas?.bgImageUrl,
    logosUrlSignature,
  ]);

  // Reset playback state when switching projects
  useEffect(() => {
    setNaturalSize(null);
    setIsPlaying(false);
    playClockRef.current = null;
    videoRef.current?.pause();
    bgVideoRef.current?.pause();
    origAudioRef.current?.pause();
    dubAudioRef.current?.pause();
    musicAudioRef.current?.pause();
    sfxAudioRef.current?.pause();
  }, [project.id, project.sourceVideoUrl, project.sourceVideoBlobKey, videoRef]);

  // Retrieve original project video Blob from IndexedDB (or remote URL) before rendering <video>
  useEffect(() => {
    let cancelled = false;
    let createdObjectUrl: string | null = null;

    if (!project.sourceVideoUrl && !project.sourceVideoBlobKey) {
      setPreviewVideoUrl(null);
      setPreviewVideoStatus('idle');
      setPreviewVideoError(null);
      if (ownedObjectUrlRef.current) {
        try {
          URL.revokeObjectURL(ownedObjectUrlRef.current);
        } catch {
          // ignore
        }
        ownedObjectUrlRef.current = null;
      }
      return;
    }

    setPreviewVideoUrl(null);
    setPreviewVideoStatus('loading');
    setPreviewVideoError(null);

    const resolveVideoSource = async () => {
      const rawUrl = project.sourceVideoUrl || '';
      const isIndexedDbBacked =
        Boolean(project.sourceVideoBlobKey) ||
        !rawUrl ||
        rawUrl.startsWith('blob:') ||
        rawUrl.startsWith('idb://');

      if (!isIndexedDbBacked) {
        const remoteUrl = await resolvePlayableAssetUrl(rawUrl, latestCloudAssetsRef.current);
        if (cancelled) return;
        if (remoteUrl) {
          console.info('[VideoPreview] Resolved remote/cached video source:', {
            projectId: project.id,
            blobFound: true,
            sourceType: remoteUrl.startsWith('blob:') ? 'media-cache-blob' : 'remote-url',
            objectUrlExists: remoteUrl.startsWith('blob:'),
          });
          setPreviewVideoUrl(remoteUrl);
          return;
        }
      }

      const retrieved = await retrieveProjectVideoBlob(project);
      if (cancelled) return;

      if (!retrieved || !(retrieved.blob instanceof Blob) || retrieved.blob.size === 0) {
        console.error('[VideoPreview] Video Blob missing or empty in IndexedDB:', {
          projectId: project.id,
          blobFound: false,
          blobSize: retrieved?.blob?.size ?? 0,
          mimeType: retrieved?.blob?.type ?? '',
          objectUrlExists: false,
        });
        setPreviewVideoUrl(null);
        setPreviewVideoStatus('error');
        setPreviewVideoError(
          'Original video file was not found in IndexedDB local storage. Re-upload the source video to restore preview.'
        );
        return;
      }

      createdObjectUrl = URL.createObjectURL(retrieved.blob);
      ownedObjectUrlRef.current = createdObjectUrl;

      console.info('[VideoPreview] Original video Blob ready for playback:', {
        projectId: project.id,
        blobFound: true,
        blobKey: retrieved.blobKey,
        lookupSource: retrieved.lookupSource,
        blobSize: retrieved.blob.size,
        mimeType: retrieved.blob.type || '(empty)',
        objectUrlExists: Boolean(createdObjectUrl),
      });

      setPreviewVideoUrl(createdObjectUrl);
    };

    void resolveVideoSource().catch((err) => {
      if (cancelled) return;
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[VideoPreview] Failed resolving project video source:', {
        projectId: project.id,
        error: msg,
      });
      setPreviewVideoUrl(null);
      setPreviewVideoStatus('error');
      setPreviewVideoError(`Failed to load project video from local storage: ${msg}`);
    });

    return () => {
      cancelled = true;
      if (createdObjectUrl) {
        try {
          URL.revokeObjectURL(createdObjectUrl);
        } catch {
          // ignore
        }
        if (ownedObjectUrlRef.current === createdObjectUrl) {
          ownedObjectUrlRef.current = null;
        }
      }
    };
  }, [
    project.id,
    project.sourceVideoUrl,
    project.sourceVideoBlobKey,
    project.sourceFilename,
    videoReloadNonce,
  ]);

  // Safety cleanup of any owned Object URL on component unmount
  useEffect(() => {
    return () => {
      if (ownedObjectUrlRef.current) {
        try {
          URL.revokeObjectURL(ownedObjectUrlRef.current);
        } catch {
          // ignore
        }
        ownedObjectUrlRef.current = null;
      }
    };
  }, []);

  // Synchronize 4-channel audio mixer & independent clip speed (all narration/music/SFX/unlinked orig locked at 1.0x)
  useEffect(() => {
    const vid = videoRef.current;
    const origMuted =
      project.voice.originalAudioMuted !== undefined
        ? Boolean(project.voice.originalAudioMuted)
        : !Boolean(project.voice.preserveOriginalAudio);
    const origEnabled =
      project.voice.originalAudioEnabled !== undefined
        ? Boolean(project.voice.originalAudioEnabled)
        : Boolean(project.voice.preserveOriginalAudio);
    const origVol = Math.max(0, Math.min(2.0, Number(project.voice.originalAudioVolume ?? 1.0)));

    if (vid) {
      // Mute embedded <video> audio whenever original audio is unlinked or playhead is outside linked clip
      const clipAudioUnlinked = hasUnlinkedAudio || Boolean(activeVideoMatch?.clip.audioUnlinked);
      const effectiveOrigMuted =
        muted ||
        !origEnabled ||
        origMuted ||
        origVol <= 0.005 ||
        clipAudioUnlinked ||
        !activeVideoMatch;
      applyMediaGain(vid, origVol * volume, effectiveOrigMuted);
      vid.playbackRate = activeVideoSpeed;
    }

    if (bgVideoRef.current) {
      bgVideoRef.current.playbackRate = activeVideoSpeed;
    }

    const origAudio = origAudioRef.current;
    if (origAudio) {
      const clipVol = activeOrigAudioMatch ? (activeOrigAudioMatch.clip.volume ?? 1.0) : 0;
      const clipMuted =
        muted ||
        !hasUnlinkedAudio ||
        !origEnabled ||
        origMuted ||
        !activeOrigAudioMatch ||
        Boolean(activeOrigAudioMatch.clip.muted) ||
        origVol * clipVol <= 0.005;
      applyMediaGain(origAudio, origVol * clipVol * volume, clipMuted);
      origAudio.playbackRate = 1.0;
    }

    const dub = dubAudioRef.current;
    if (dub) {
      const voiceMuted = Boolean(project.voice.voiceMuted) || !useDubAudio;
      const voiceVol = Math.max(0, Math.min(2.0, Number(project.voice.voiceVolume ?? 1.0)));
      applyMediaGain(dub, voiceVol * volume, muted || voiceMuted || voiceVol <= 0.005);
      dub.playbackRate = 1.0;
    }

    const bgm = musicAudioRef.current;
    if (bgm) {
      const bgmEnabled =
        project.voice.bgMusicEnabled !== undefined
          ? Boolean(project.voice.bgMusicEnabled)
          : Number(project.voice.bgMusicVolume ?? 0) > 0.005;
      const bgmVol = Math.max(0, Math.min(2.0, Number(project.voice.bgMusicVolume ?? 0)));
      const clipVol = activeBgmMatch ? (activeBgmMatch.clip.volume ?? 1.0) : 0;
      const clipMuted =
        muted ||
        !bgmEnabled ||
        Boolean(project.voice.bgMusicMuted) ||
        !activeBgmMatch ||
        Boolean(activeBgmMatch.clip.muted) ||
        bgmVol * clipVol <= 0.005;
      applyMediaGain(bgm, bgmVol * clipVol * volume, clipMuted);
      bgm.playbackRate = 1.0;
    }

    const sfx = sfxAudioRef.current;
    if (sfx) {
      const sfxEnabled = Boolean(project.voice.sfxEnabled);
      const sfxVol = Math.max(0, Math.min(2.0, Number(project.voice.sfxVolume ?? 1.0)));
      const clipVol = activeSfxMatch ? (activeSfxMatch.clip.volume ?? 1.0) : 0;
      const clipMuted =
        muted ||
        !sfxEnabled ||
        Boolean(project.voice.sfxMuted) ||
        !activeSfxMatch ||
        Boolean(activeSfxMatch.clip.muted) ||
        sfxVol * clipVol <= 0.005;
      applyMediaGain(sfx, sfxVol * clipVol * volume, clipMuted);
      sfx.playbackRate = 1.0;
    }
  }, [
    videoRef,
    useDubAudio,
    muted,
    volume,
    activeVideoSpeed,
    activeVideoMatch,
    activeOrigAudioMatch,
    activeBgmMatch,
    activeSfxMatch,
    hasUnlinkedAudio,
    project.voice.preserveOriginalAudio,
    project.voice.originalAudioEnabled,
    project.voice.originalAudioMuted,
    project.voice.originalAudioVolume,
    project.voice.voiceMuted,
    project.voice.voiceVolume,
    project.voice.bgMusicEnabled,
    project.voice.bgMusicMuted,
    project.voice.bgMusicVolume,
    project.voice.sfxEnabled,
    project.voice.sfxMuted,
    project.voice.sfxVolume,
    previewVideoUrl,
  ]);

  // Master 1.0x rAF timeline clock:
  // Drives video clips at each clip's independent speed & source offset,
  // while Fish Audio narration, captions, BGM, SFX & unlinked original audio stay strictly at 1.0x.
  useEffect(() => {
    if (!isPlaying) return;
    let rafId = 0;

    const tick = () => {
      const clock = playClockRef.current;
      if (!clock) return;

      const vid = videoRef.current;
      const bgVid = bgVideoRef.current;
      const dub = dubAudioRef.current;
      const origAudio = origAudioRef.current;
      const voiceOffset = Number(project.voice.timingOffsetSec || 0);

      let nextTime = clock.startedAtTimeline + (performance.now() - clock.startedAtPerf) / 1000;

      // Lightly lock 1.0x clock to live dub audio element so narration speech never drifts
      if (useDubAudio && dub && !dub.paused && !dub.ended && dub.readyState >= 2) {
        const dubTl = Math.max(0, dub.currentTime + voiceOffset);
        if (Math.abs(dubTl - nextTime) < 0.6) {
          nextTime = dubTl;
        }
        if (Math.abs(dub.playbackRate - 1.0) > 0.005) {
          dub.playbackRate = 1.0;
        }
      }

      // Sync video stream purely to active VideoClip (independent speed & source time)
      const clipMatch = findActiveVideoClipAtTime(videoClips, nextTime);
      if (vid) {
        if (clipMatch && nextTime < clipMatch.tlEnd - 0.015) {
          const targetSpd = clipMatch.clip.speed;
          if (Math.abs(vid.playbackRate - targetSpd) > 0.005) {
            vid.playbackRate = targetSpd;
          }
          const driftTol = Math.max(0.18, 0.14 * targetSpd);
          if (Math.abs(vid.currentTime - clipMatch.sourceTime) > driftTol) {
            vid.currentTime = clipMatch.sourceTime;
          }
          if (vid.paused) {
            void vid.play().catch(() => {});
          }
          if (bgVid) {
            if (Math.abs(bgVid.playbackRate - targetSpd) > 0.005) {
              bgVid.playbackRate = targetSpd;
            }
            if (Math.abs(bgVid.currentTime - clipMatch.sourceTime) > driftTol) {
              bgVid.currentTime = clipMatch.sourceTime;
            }
            if (bgVid.paused) {
              void bgVid.play().catch(() => {});
            }
          }
        } else {
          if (!vid.paused) vid.pause();
          if (bgVid && !bgVid.paused) bgVid.pause();
          if (vid.duration && vid.duration > 0.1) {
            vid.currentTime = Math.max(0, vid.duration - 0.05);
            if (bgVid) bgVid.currentTime = vid.currentTime;
          }
        }
      }

      // Start dub audio if timeline reaches voiceOffset
      if (useDubAudio && dub && !dub.ended) {
        const dubLocal = nextTime - voiceOffset;
        const dubEnd = dub.duration && Number.isFinite(dub.duration) ? dub.duration : 99999;
        if (dubLocal >= 0 && dubLocal < dubEnd - 0.04) {
          if (dub.paused) {
            dub.playbackRate = 1.0;
            dub.currentTime = dubLocal;
            void dub.play().catch(() => {});
          }
        } else if (!dub.paused && dubLocal < -0.05) {
          dub.pause();
        }
      }

      // Sync unlinked original audio strictly at 1.0x
      if (hasUnlinkedAudio && origAudio) {
        const oaMatch = findActiveOriginalAudioAtTime(originalAudioClips, nextTime);
        if (oaMatch && nextTime < oaMatch.tlEnd - 0.015 && !oaMatch.clip.muted) {
          if (Math.abs(origAudio.playbackRate - 1.0) > 0.005) {
            origAudio.playbackRate = 1.0;
          }
          if (Math.abs(origAudio.currentTime - oaMatch.sourceTime) > 0.18) {
            origAudio.currentTime = oaMatch.sourceTime;
          }
          if (origAudio.paused) {
            void origAudio.play().catch(() => {});
          }
        } else if (!origAudio.paused) {
          origAudio.pause();
        }
      }

      // Sync background music clips strictly at 1.0x
      const musicAudio = musicAudioRef.current;
      if (musicAudio && project.voice.bgMusicUrl) {
        const bgmEnabled =
          project.voice.bgMusicEnabled !== undefined
            ? Boolean(project.voice.bgMusicEnabled)
            : Number(project.voice.bgMusicVolume ?? 0) > 0.005;
        const bgmMatch = findActiveTimelineAudioAtTime(bgmClips, nextTime);
        if (
          bgmMatch &&
          bgmEnabled &&
          !project.voice.bgMusicMuted &&
          !bgmMatch.clip.muted &&
          nextTime < bgmMatch.tlEnd - 0.015
        ) {
          const rawDur =
            musicAudio.duration && Number.isFinite(musicAudio.duration) && musicAudio.duration > 0.2
              ? musicAudio.duration
              : 0;
          const targetSrcTime =
            bgmMatch.clip.loop && rawDur > 0 ? bgmMatch.sourceTime % rawDur : bgmMatch.sourceTime;
          if (Math.abs(musicAudio.playbackRate - 1.0) > 0.005) {
            musicAudio.playbackRate = 1.0;
          }
          if (Math.abs(musicAudio.currentTime - targetSrcTime) > 0.22) {
            musicAudio.currentTime = targetSrcTime;
          }
          if (musicAudio.paused) {
            void musicAudio.play().catch(() => {});
          }
        } else if (!musicAudio.paused) {
          musicAudio.pause();
        }
      }

      // Sync sound effects clips strictly at 1.0x
      const sfxAudio = sfxAudioRef.current;
      if (sfxAudio && project.voice.sfxUrl) {
        const sfxMatch = findActiveTimelineAudioAtTime(sfxClips, nextTime);
        if (
          sfxMatch &&
          Boolean(project.voice.sfxEnabled) &&
          !project.voice.sfxMuted &&
          !sfxMatch.clip.muted &&
          nextTime < sfxMatch.tlEnd - 0.015
        ) {
          const rawDur =
            sfxAudio.duration && Number.isFinite(sfxAudio.duration) && sfxAudio.duration > 0.2
              ? sfxAudio.duration
              : 0;
          const targetSrcTime =
            sfxMatch.clip.loop && rawDur > 0 ? sfxMatch.sourceTime % rawDur : sfxMatch.sourceTime;
          if (sfxMatch.clip.loop || rawDur === 0 || targetSrcTime < rawDur - 0.04) {
            if (Math.abs(sfxAudio.playbackRate - 1.0) > 0.005) {
              sfxAudio.playbackRate = 1.0;
            }
            if (Math.abs(sfxAudio.currentTime - targetSrcTime) > 0.22) {
              sfxAudio.currentTime = targetSrcTime;
            }
            if (sfxAudio.paused) {
              void sfxAudio.play().catch(() => {});
            }
          } else if (!sfxAudio.paused) {
            sfxAudio.pause();
          }
        } else if (!sfxAudio.paused) {
          sfxAudio.pause();
        }
      }

      if (effectiveDuration > 0 && nextTime >= effectiveDuration) {
        onTimeUpdate(effectiveDuration);
        playClockRef.current = null;
        setIsPlaying(false);
        videoRef.current?.pause();
        bgVideoRef.current?.pause();
        origAudioRef.current?.pause();
        dubAudioRef.current?.pause();
        musicAudioRef.current?.pause();
        sfxAudioRef.current?.pause();
        return;
      }

      onTimeUpdate(nextTime);
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [
    isPlaying,
    useDubAudio,
    hasUnlinkedAudio,
    videoClips,
    originalAudioClips,
    bgmClips,
    sfxClips,
    effectiveDuration,
    project.voice.timingOffsetSec,
    project.voice.bgMusicUrl,
    project.voice.bgMusicEnabled,
    project.voice.bgMusicMuted,
    project.voice.bgMusicVolume,
    project.voice.sfxUrl,
    project.voice.sfxEnabled,
    project.voice.sfxMuted,
    videoRef,
    onTimeUpdate,
  ]);

  const pauseAllMedia = () => {
    playClockRef.current = null;
    videoRef.current?.pause();
    bgVideoRef.current?.pause();
    origAudioRef.current?.pause();
    dubAudioRef.current?.pause();
    musicAudioRef.current?.pause();
    sfxAudioRef.current?.pause();
    setIsPlaying(false);
  };

  const togglePlay = async () => {
    const vid = videoRef.current;
    if (!vid || !previewVideoUrl) return;
    resumeSharedAudioContext();

    if (!isPlaying) {
      const voiceOffset = Number(project.voice.timingOffsetSec || 0);
      const startAt =
        effectiveDuration > 0 && currentTime >= effectiveDuration - 0.08
          ? 0
          : Math.max(0, currentTime);
      if (startAt !== currentTime) {
        onTimeUpdate(startAt);
      }

      playClockRef.current = {
        startedAtPerf: performance.now(),
        startedAtTimeline: startAt,
      };

      const clipMatch = findActiveVideoClipAtTime(videoClips, startAt);
      if (clipMatch && startAt < clipMatch.tlEnd - 0.02) {
        vid.playbackRate = clipMatch.clip.speed;
        vid.currentTime = clipMatch.sourceTime;
        await vid.play().catch(() => {});
        if (bgVideoRef.current) {
          bgVideoRef.current.playbackRate = clipMatch.clip.speed;
          bgVideoRef.current.currentTime = clipMatch.sourceTime;
          void bgVideoRef.current.play().catch(() => {});
        }
      } else {
        vid.pause();
        bgVideoRef.current?.pause();
      }

      if (hasUnlinkedAudio && origAudioRef.current) {
        const oaMatch = findActiveOriginalAudioAtTime(originalAudioClips, startAt);
        if (oaMatch && startAt < oaMatch.tlEnd - 0.02 && !oaMatch.clip.muted) {
          origAudioRef.current.playbackRate = 1.0;
          origAudioRef.current.currentTime = oaMatch.sourceTime;
          void origAudioRef.current.play().catch(() => {});
        } else {
          origAudioRef.current.pause();
        }
      }

      if (dubAudioRef.current && useDubAudio) {
        const dubTarget = startAt - voiceOffset;
        dubAudioRef.current.playbackRate = 1.0;
        if (dubTarget >= 0 && dubTarget < (dubAudioRef.current.duration || 99999) - 0.04) {
          dubAudioRef.current.currentTime = dubTarget;
          void dubAudioRef.current.play().catch(() => {});
        } else {
          dubAudioRef.current.pause();
        }
      }

      if (musicAudioRef.current && project.voice.bgMusicUrl) {
        const bgmEnabled =
          project.voice.bgMusicEnabled !== undefined
            ? Boolean(project.voice.bgMusicEnabled)
            : Number(project.voice.bgMusicVolume ?? 0) > 0.005;
        const bgmMatch = findActiveTimelineAudioAtTime(bgmClips, startAt);
        musicAudioRef.current.playbackRate = 1.0;
        if (
          bgmMatch &&
          bgmEnabled &&
          !project.voice.bgMusicMuted &&
          !bgmMatch.clip.muted &&
          startAt < bgmMatch.tlEnd - 0.02
        ) {
          const rawDur = musicAudioRef.current.duration || 0;
          musicAudioRef.current.currentTime =
            bgmMatch.clip.loop && rawDur > 0.2 ? bgmMatch.sourceTime % rawDur : bgmMatch.sourceTime;
          void musicAudioRef.current.play().catch(() => {});
        } else {
          musicAudioRef.current.pause();
        }
      }

      if (sfxAudioRef.current && project.voice.sfxUrl && project.voice.sfxEnabled) {
        const sfxMatch = findActiveTimelineAudioAtTime(sfxClips, startAt);
        sfxAudioRef.current.playbackRate = 1.0;
        if (
          sfxMatch &&
          !project.voice.sfxMuted &&
          !sfxMatch.clip.muted &&
          startAt < sfxMatch.tlEnd - 0.02
        ) {
          const rawDur = sfxAudioRef.current.duration || 0;
          const targetSfxTime =
            sfxMatch.clip.loop && rawDur > 0.2 ? sfxMatch.sourceTime % rawDur : sfxMatch.sourceTime;
          if (sfxMatch.clip.loop || rawDur === 0 || targetSfxTime < rawDur - 0.04) {
            sfxAudioRef.current.currentTime = targetSfxTime;
            void sfxAudioRef.current.play().catch(() => {});
          } else {
            sfxAudioRef.current.pause();
          }
        } else {
          sfxAudioRef.current.pause();
        }
      }
      setIsPlaying(true);
    } else {
      pauseAllMedia();
    }
  };

  const seekTo = (t: number) => {
    const vid = videoRef.current;
    if (!vid) return;
    const maxTime = Math.max(effectiveDuration, vid.duration || 0);
    const clamped = Math.max(0, Math.min(maxTime, t));
    if (playClockRef.current) {
      playClockRef.current = {
        startedAtPerf: performance.now(),
        startedAtTimeline: clamped,
      };
    }

    const clipMatch = findActiveVideoClipAtTime(videoClips, clamped);
    if (clipMatch) {
      vid.playbackRate = clipMatch.clip.speed;
      vid.currentTime = Math.min(clipMatch.sourceTime, Math.max(0, (vid.duration || srcDuration) - 0.02));
      if (bgVideoRef.current) {
        bgVideoRef.current.playbackRate = clipMatch.clip.speed;
        bgVideoRef.current.currentTime = vid.currentTime;
      }
    } else {
      if (vid.duration && vid.duration > 0.1) {
        vid.currentTime = Math.max(0, vid.duration - 0.05);
        if (bgVideoRef.current) bgVideoRef.current.currentTime = vid.currentTime;
      }
      if (isPlaying) {
        vid.pause();
        bgVideoRef.current?.pause();
      }
    }

    if (hasUnlinkedAudio && origAudioRef.current) {
      origAudioRef.current.playbackRate = 1.0;
      const oaMatch = findActiveOriginalAudioAtTime(originalAudioClips, clamped);
      if (oaMatch) {
        origAudioRef.current.currentTime = oaMatch.sourceTime;
      } else if (isPlaying) {
        origAudioRef.current.pause();
      }
    }

    if (dubAudioRef.current && useDubAudio) {
      dubAudioRef.current.playbackRate = 1.0;
      const offset = project.voice.timingOffsetSec || 0;
      dubAudioRef.current.currentTime = Math.max(0, clamped - offset);
    }
    if (musicAudioRef.current && project.voice.bgMusicUrl) {
      musicAudioRef.current.playbackRate = 1.0;
      const bgmMatch = findActiveTimelineAudioAtTime(bgmClips, clamped);
      if (bgmMatch && !bgmMatch.clip.muted) {
        const rawDur = musicAudioRef.current.duration || 0;
        musicAudioRef.current.currentTime =
          bgmMatch.clip.loop && rawDur > 0.2 ? bgmMatch.sourceTime % rawDur : bgmMatch.sourceTime;
      } else if (isPlaying) {
        musicAudioRef.current.pause();
      }
    }
    if (sfxAudioRef.current && project.voice.sfxUrl) {
      sfxAudioRef.current.playbackRate = 1.0;
      const sfxMatch = findActiveTimelineAudioAtTime(sfxClips, clamped);
      if (sfxMatch && !sfxMatch.clip.muted) {
        const rawDur = sfxAudioRef.current.duration || 0;
        sfxAudioRef.current.currentTime =
          sfxMatch.clip.loop && rawDur > 0.2 ? sfxMatch.sourceTime % rawDur : sfxMatch.sourceTime;
      } else if (isPlaying) {
        sfxAudioRef.current.pause();
      }
    }
    onTimeUpdate(clamped);
  };

  const stepFrame = (dir: -1 | 1) => {
    const fps = project.metadata?.fps || 30;
    if (isPlaying) {
      pauseAllMedia();
    }
    seekTo(currentTime + dir * (1 / fps));
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void containerRef.current.requestFullscreen();
    }
  };

  // Layer z-index map aligned with backend video_render_service layerOrder
  const layerZIndexMap = useMemo(() => {
    const tokens = buildOrderedLayerTokens(project);
    const map = new Map<string, number>();
    tokens.forEach((tok, idx) => {
      map.set(tok, 10 + idx);
    });
    return map;
  }, [project]);

  const isSelectedEl = (check: Exclude<StudioElementSelection, null>): boolean => {
    if (readOnlyPreview) return false;
    if (selectedElement) {
      if (selectedElement.kind !== check.kind) return false;
      if (check.kind === 'blur' && selectedElement.kind === 'blur') {
        return check.id === selectedElement.id;
      }
      if (check.kind === 'logo' && selectedElement.kind === 'logo') {
        return check.id === selectedElement.id;
      }
      if (check.kind === 'caption-element' && selectedElement.kind === 'caption-element') {
        return check.id === selectedElement.id;
      }
      return true;
    }
    if (check.kind === 'blur') return check.id === selectedBlurId;
    if (check.kind === 'logo') return check.id === selectedLogoId;
    return false;
  };

  // Dynamic @font-face declarations for custom uploaded fonts
  const customFontCss = useMemo(() => {
    if (!customFonts || customFonts.length === 0) return '';
    return customFonts
      .map(
        (f) =>
          `@font-face { font-family: '${f.family.replace(/'/g, '')}'; src: url('${f.url}'); font-display: block; }`
      )
      .join('\n');
  }, [customFonts]);

  // Synchronized preview captions strictly from segment.translatedText & voiceover timeline
  const syncedCaptions = useMemo(() => getSyncedCaptionsForPreview(project), [project]);

  const currentCaptionSegment = useMemo(
    () =>
      syncedCaptions.find((c) => currentTime >= c.syncedStart && currentTime <= c.syncedEnd) ||
      null,
    [syncedCaptions, currentTime]
  );

  const activeCaption = useMemo(() => {
    if (
      !previewEffects ||
      !project.subtitleStyle.enabled ||
      project.subtitleStyle.visible === false
    ) {
      return null;
    }
    return currentCaptionSegment;
  }, [
    previewEffects,
    project.subtitleStyle.enabled,
    project.subtitleStyle.visible,
    currentCaptionSegment,
  ]);

  // Active extra caption elements
  const activeExtraElements = useMemo(() => {
    if (!previewEffects) return [];
    return (project.subtitleStyle.extraElements || []).filter((el) => {
      const start = el.startTime || 0;
      const end = el.endTime || 0;
      return (
        el.visible &&
        currentTime >= start &&
        (end > start ? currentTime <= end : true)
      );
    });
  }, [previewEffects, project.subtitleStyle.extraElements, currentTime]);

  // Active blur effects at currentTime (respecting manual & caption-linked intervals)
  const activeBlurs = useMemo(() => {
    if (!previewEffects) return [];
    return project.blurs.filter((b) => isBlurActiveAtTime(b, currentTime, project, syncedCaptions));
  }, [previewEffects, project, currentTime, syncedCaptions]);

  const fullBlurEffect = activeBlurs.find((b) => b.mode === 'full');
  const bgBlurEffect = activeBlurs.find((b) => b.mode === 'background');
  const boxBlurs = activeBlurs.filter((b) => b.mode === 'selective' || b.mode === 'motion');

  // Active logos at currentTime
  const activeLogos = useMemo(() => {
    if (!previewEffects) return [];
    return project.logos.filter(
      (l) =>
        l.enabled && (l.permanent || (currentTime >= l.startTime && currentTime <= l.endTime))
    );
  }, [previewEffects, project.logos, currentTime]);

  // Computed Real-time CSS Video Filter (supports all 50 filters, filterStack, grain & per-clip overrides)
  const resolvedFilter = useMemo(() => {
    if (!previewEffects || compareModeActive) {
      return {
        filterCss: '',
        vignetteAlpha: 0,
        tintOverlay: undefined as string | undefined,
        tintOverlays: [] as string[],
        grainAlpha: 0,
        fadeAlpha: 0,
      };
    }
    return resolveCombinedVideoFilter({
      effectsConfig: project.videoEffects,
      clipFilterPreset: activeVideoMatch?.clip.filterPreset,
      clipFilterIntensity: activeVideoMatch?.clip.filterIntensity,
      currentTime,
      activeClipId: activeVideoMatch?.clip.id,
    });
  }, [
    previewEffects,
    compareModeActive,
    project.videoEffects,
    activeVideoMatch?.clip.filterPreset,
    activeVideoMatch?.clip.filterIntensity,
    activeVideoMatch?.clip.id,
    currentTime,
  ]);

  // Active visual effects at currentTime (respecting optional clipId binding)
  const activeFx = useMemo(() => {
    if (!previewEffects || compareModeActive) return [];
    return (project.videoEffects?.effects || []).filter((e) => {
      if (!e.enabled) return false;
      if (e.clipId && activeVideoMatch?.clip.id !== e.clipId) return false;
      const start = e.startTime || 0;
      const end = e.endTime || 0;
      return currentTime >= start && (end > start ? currentTime <= end : true);
    });
  }, [previewEffects, compareModeActive, project.videoEffects, currentTime, activeVideoMatch?.clip.id]);

  // Aggregate parameters across all active effect instances for accurate stacking
  const fxEval = useMemo(() => {
    const getProgress = (fxStart: number, fxEnd: number) => {
      const s = Math.max(0, fxStart || 0);
      const e = fxEnd > s ? fxEnd : effectiveDuration;
      const span = Math.max(0.1, e - s);
      return Math.max(0, Math.min(1, (currentTime - s) / span));
    };

    let blurPx = 0;
    let extraBright = 0;
    let extraContrast = 0;
    let extraSat = 0;
    let hueShiftDeg = 0;
    let zoomScale = 1;
    let originXSum = 0;
    let originYSum = 0;
    let originWeight = 0;
    let shakeDx = 0;
    let shakeDy = 0;
    let needsEdgeScale = false;
    let slideTxPct = 0;
    let slideTyPct = 0;
    let wipeClipPath: string | undefined;
    let lensDistortAmt = 0;
    let waveDistortAmt = 0;
    let pixelateBlockSize = 0;
    let pixelateOpacity = 0;
    let vignetteFxAlpha = 0;
    let vignetteOrigin = '50% 50%';
    let bgBlurPx = 0;
    let bgBlurOrigin = '50% 48%';
    let fxGrainAlpha = 0;
    let dustAmt = 0;
    let dustSpeed = 1;
    let scratchAmt = 0;
    let scratchSpeed = 1;
    let glowAmt = 0;
    let neonAmt = 0;
    let neonHue = 0;
    let rgbSplitAmt = 0;
    let vhsAmt = 0;
    let glitchAmt = 0;
    let glitchSpeed = 1;
    let glitchBlock = 16;
    let flashWhiteAlpha = 0;
    let flashWarmAlpha = 0;
    let fadeBlackAlpha = 0;
    const flares: Array<{
      kind: 'flare' | 'leak' | 'burn';
      xPct: number;
      yPct: number;
      alpha: number;
    }> = [];

    for (const fx of activeFx) {
      const rawInt = Math.max(0, Math.min(1, fx.intensity / 100));
      const op = Math.max(0.05, Math.min(1, fx.opacity ?? 1));
      const k = rawInt * op;
      const spd = Math.max(0.2, Math.min(3, fx.speed ?? 1));
      const p = getProgress(fx.startTime, fx.endTime);

      switch (fx.type) {
        case 'blur':
          blurPx += Math.max(0.5, 12 * k);
          break;
        case 'gaussian-blur':
          blurPx += Math.max(0.5, 16 * k);
          break;
        case 'motion-blur':
          blurPx += Math.max(0.5, 4.5 * k);
          break;
        case 'blur-transition':
          blurPx += Math.max(0, Math.sin(p * Math.PI) * 18 * k);
          break;
        case 'soft-focus':
          blurPx += 3.2 * k;
          extraBright += 0.08 * k;
          break;
        case 'dream-effect':
          blurPx += 2.4 * k;
          extraBright += 0.12 * k;
          extraSat += 0.22 * k;
          glowAmt = Math.max(glowAmt, 0.45 * k);
          break;
        case 'sharpen':
          extraContrast += 0.18 * k;
          extraSat += 0.08 * k;
          break;
        case 'glow':
        case 'soft-glow':
        case 'bloom':
          glowAmt = Math.max(glowAmt, (fx.type === 'bloom' ? 0.65 : 0.5) * k);
          extraBright += 0.08 * k;
          break;
        case 'neon-glow':
          neonAmt = Math.max(neonAmt, 0.65 * k);
          neonHue = fx.hueShiftDeg ?? 0;
          extraContrast += 0.24 * k;
          extraSat += 0.65 * k;
          hueShiftDeg += (fx.hueShiftDeg ?? 0) * rawInt;
          break;
        case 'color-shift':
          hueShiftDeg += (fx.hueShiftDeg ?? 0) + currentTime * spd * 90 * rawInt;
          extraSat += 0.35 * k;
          break;
        case 'pixelate':
        case 'mosaic': {
          const blk = Math.max(4, Math.min(64, fx.blockSize ?? (fx.type === 'mosaic' ? 18 : 12)));
          pixelateBlockSize = Math.max(pixelateBlockSize, Math.round(blk * (0.5 + 0.7 * rawInt)));
          pixelateOpacity = Math.max(pixelateOpacity, op);
          break;
        }
        case 'background-blur':
          bgBlurPx = Math.max(bgBlurPx, Math.max(4, 15 * k));
          bgBlurOrigin = `${Math.round((fx.posX ?? 0.5) * 100)}% ${Math.round((fx.posY ?? 0.48) * 100)}%`;
          break;
        case 'vignette':
          vignetteFxAlpha = Math.max(vignetteFxAlpha, 0.85 * k);
          vignetteOrigin = `${Math.round((fx.posX ?? 0.5) * 100)}% ${Math.round((fx.posY ?? 0.5) * 100)}%`;
          break;
        case 'slow-zoom':
          zoomScale *= 1 + 0.22 * rawInt * p;
          originXSum += (fx.posX ?? 0.5) * 100;
          originYSum += (fx.posY ?? 0.5) * 100;
          originWeight += 1;
          break;
        case 'zoom':
          zoomScale *= 1 + 0.35 * rawInt * Math.min(2, spd) * p;
          originXSum += (fx.posX ?? 0.5) * 100;
          originYSum += (fx.posY ?? 0.5) * 100;
          originWeight += 1;
          break;
        case 'zoom-out':
          zoomScale *= 1 + 0.35 * rawInt * Math.min(2, spd) * (1 - p);
          originXSum += (fx.posX ?? 0.5) * 100;
          originYSum += (fx.posY ?? 0.5) * 100;
          originWeight += 1;
          break;
        case 'zoom-transition': {
          const peak = Math.pow(Math.sin(p * Math.PI), 1.4);
          zoomScale *= 1 + 0.55 * rawInt * peak;
          originXSum += (fx.posX ?? 0.5) * 100;
          originYSum += (fx.posY ?? 0.5) * 100;
          originWeight += 1;
          break;
        }
        case 'camera-shake':
          shakeDx += Math.sin(currentTime * 28 * spd) * 7 * rawInt;
          shakeDy += Math.cos(currentTime * 34 * spd) * 7 * rawInt;
          needsEdgeScale = true;
          break;
        case 'cinematic-shake':
          shakeDx += Math.sin(currentTime * 17 * spd) * 9 * rawInt;
          shakeDy += Math.cos(currentTime * 22 * spd) * 5 * rawInt;
          needsEdgeScale = true;
          break;
        case 'handheld-camera':
          shakeDx +=
            (Math.sin(currentTime * 3.1 * spd) * 0.65 + Math.sin(currentTime * 6.4 * spd) * 0.35) *
            6 *
            rawInt;
          shakeDy +=
            (Math.cos(currentTime * 2.5 * spd) * 0.65 + Math.cos(currentTime * 5.2 * spd) * 0.35) *
            5 *
            rawInt;
          needsEdgeScale = true;
          break;
        case 'slide-transition': {
          const rem = 1 - p;
          const dir = fx.direction || 'left';
          if (dir === 'left') slideTxPct += rem * 100 * rawInt;
          else if (dir === 'right') slideTxPct -= rem * 100 * rawInt;
          else if (dir === 'up') slideTyPct += rem * 100 * rawInt;
          else slideTyPct -= rem * 100 * rawInt;
          break;
        }
        case 'wipe-transition': {
          const cov = Math.max(0, Math.min(100, (1 - p) * 100 * rawInt));
          const dir = fx.direction || 'left';
          if (dir === 'left') wipeClipPath = `inset(0 ${cov.toFixed(1)}% 0 0)`;
          else if (dir === 'right') wipeClipPath = `inset(0 0 0 ${cov.toFixed(1)}%)`;
          else if (dir === 'up') wipeClipPath = `inset(0 0 ${cov.toFixed(1)}% 0)`;
          else wipeClipPath = `inset(${cov.toFixed(1)}% 0 0 0)`;
          break;
        }
        case 'lens-distortion':
          lensDistortAmt = Math.max(lensDistortAmt, k);
          originXSum += (fx.posX ?? 0.5) * 100;
          originYSum += (fx.posY ?? 0.5) * 100;
          originWeight += 1;
          break;
        case 'distortion':
          waveDistortAmt = Math.max(waveDistortAmt, k);
          shakeDx += Math.sin(currentTime * 8 * spd) * 3 * k;
          needsEdgeScale = true;
          break;
        case 'film-grain':
          fxGrainAlpha = Math.max(fxGrainAlpha, 0.58 * k);
          break;
        case 'dust':
          dustAmt = Math.max(dustAmt, k);
          dustSpeed = spd;
          break;
        case 'scratches':
          scratchAmt = Math.max(scratchAmt, k);
          scratchSpeed = spd;
          break;
        case 'chromatic-aberration':
        case 'rgb-split':
          rgbSplitAmt = Math.max(rgbSplitAmt, k);
          break;
        case 'vhs':
          vhsAmt = Math.max(vhsAmt, k);
          rgbSplitAmt = Math.max(rgbSplitAmt, 0.55 * k);
          break;
        case 'glitch':
        case 'rgb-glitch':
        case 'digital-glitch':
        case 'glitch-transition': {
          const burst =
            fx.type === 'glitch-transition'
              ? Math.sin(p * Math.PI)
              : 0.45 + 0.55 * Math.pow(Math.abs(Math.sin(currentTime * 7 * spd)), 2);
          glitchAmt = Math.max(glitchAmt, k * burst);
          glitchSpeed = spd;
          rgbSplitAmt = Math.max(rgbSplitAmt, k * burst);
          if (fx.type === 'digital-glitch') {
            glitchBlock = Math.max(6, fx.blockSize ?? 16);
          }
          break;
        }
        case 'lens-flare':
          flares.push({
            kind: 'flare',
            xPct: Math.round((fx.posX ?? 0.8) * 100),
            yPct: Math.round((fx.posY ?? 0.2) * 100),
            alpha: Math.min(0.85, 0.7 * k),
          });
          break;
        case 'light-leaks':
        case 'film-burn':
          flares.push({
            kind: fx.type === 'film-burn' ? 'burn' : 'leak',
            xPct: Math.round((fx.posX ?? 0.84) * 100),
            yPct: Math.round((fx.posY ?? 0.16) * 100),
            alpha: Math.min(0.75, 0.6 * k),
          });
          break;
        case 'flash':
          flashWhiteAlpha = Math.max(
            flashWhiteAlpha,
            Math.pow(Math.max(0, Math.sin(currentTime * Math.PI * (2 + spd * 4))), 6) * 0.85 * k
          );
          break;
        case 'light-flash':
          flashWhiteAlpha = Math.max(
            flashWhiteAlpha,
            Math.pow(Math.max(0, Math.sin(currentTime * Math.PI * (1.2 + spd * 2.2))), 4) * 0.9 * k
          );
          break;
        case 'flash-transition':
          flashWhiteAlpha = Math.max(flashWhiteAlpha, Math.pow(Math.sin(p * Math.PI), 1.6) * 0.95 * k);
          break;
        case 'retro-flash':
          flashWarmAlpha = Math.max(
            flashWarmAlpha,
            Math.pow(Math.max(0, Math.sin(currentTime * Math.PI * (1.5 + spd * 2.5))), 4) * 0.78 * k
          );
          break;
        case 'beat-flash': {
          const beat = Math.pow(Math.max(0, Math.sin(currentTime * Math.PI * 2 * spd)), 6);
          flashWhiteAlpha = Math.max(flashWhiteAlpha, beat * 0.72 * k);
          zoomScale *= 1 + 0.08 * rawInt * beat;
          break;
        }
        case 'fade-in':
          fadeBlackAlpha = Math.max(fadeBlackAlpha, (1 - p) * k);
          break;
        case 'fade-out':
          fadeBlackAlpha = Math.max(fadeBlackAlpha, p * k);
          break;
        case 'cross-dissolve':
          fadeBlackAlpha = Math.max(fadeBlackAlpha, Math.sin(p * Math.PI) * 0.75 * k);
          break;
        case 'fade-in-out': {
          const s = fx.startTime || 0;
          const e = fx.endTime > s ? fx.endTime : effectiveDuration;
          const inSec = Math.max(0, fx.fadeInSec ?? 0.6);
          const outSec = Math.max(0, fx.fadeOutSec ?? 0.6);
          if (inSec > 0.02 && currentTime >= s && currentTime - s < inSec) {
            fadeBlackAlpha = Math.max(fadeBlackAlpha, (1 - (currentTime - s) / inSec) * k);
          }
          if (outSec > 0.02 && currentTime <= e && e - currentTime < outSec) {
            fadeBlackAlpha = Math.max(fadeBlackAlpha, (1 - (e - currentTime) / outSec) * k);
          }
          break;
        }
      }
    }

    const transformOrigin =
      originWeight > 0
        ? `${(originXSum / originWeight).toFixed(1)}% ${(originYSum / originWeight).toFixed(1)}%`
        : 'center center';

    return {
      blurPx,
      extraBright,
      extraContrast,
      extraSat,
      hueShiftDeg,
      zoomScale,
      transformOrigin,
      shakeDx,
      shakeDy,
      needsEdgeScale,
      slideTxPct,
      slideTyPct,
      wipeClipPath,
      lensDistortAmt,
      waveDistortAmt,
      pixelateBlockSize,
      pixelateOpacity,
      vignetteFxAlpha,
      vignetteOrigin,
      bgBlurPx,
      bgBlurOrigin,
      fxGrainAlpha,
      dustAmt,
      dustSpeed,
      scratchAmt,
      scratchSpeed,
      glowAmt,
      neonAmt,
      neonHue,
      rgbSplitAmt,
      vhsAmt,
      glitchAmt,
      glitchSpeed,
      glitchBlock,
      flashWhiteAlpha,
      flashWarmAlpha,
      fadeBlackAlpha: Math.min(1, fadeBlackAlpha),
      flares,
      hasTransformFx:
        Math.abs(zoomScale - 1) > 0.002 ||
        Math.abs(shakeDx) > 0.1 ||
        Math.abs(shakeDy) > 0.1 ||
        Math.abs(slideTxPct) > 0.1 ||
        Math.abs(slideTyPct) > 0.1 ||
        Boolean(wipeClipPath) ||
        lensDistortAmt > 0.01 ||
        waveDistortAmt > 0.01 ||
        pixelateBlockSize > 0,
    };
  }, [activeFx, currentTime, effectiveDuration]);

  const effectiveVideoFilterCss = useMemo(() => {
    const parts: string[] = [];
    if (resolvedFilter.filterCss) parts.push(resolvedFilter.filterCss);
    if (fxEval.blurPx > 0.2) parts.push(`blur(${fxEval.blurPx.toFixed(1)}px)`);
    if (fxEval.extraBright > 0.005) {
      parts.push(`brightness(${(1 + fxEval.extraBright).toFixed(2)})`);
    }
    if (fxEval.extraContrast > 0.005) {
      parts.push(`contrast(${(1 + fxEval.extraContrast).toFixed(2)})`);
    }
    if (fxEval.extraSat > 0.005) {
      parts.push(`saturate(${(1 + fxEval.extraSat).toFixed(2)})`);
    }
    if (Math.abs(fxEval.hueShiftDeg) > 0.5) {
      parts.push(`hue-rotate(${Math.round(fxEval.hueShiftDeg)}deg)`);
    }
    return parts.length > 0 ? parts.join(' ') : undefined;
  }, [resolvedFilter.filterCss, fxEval]);

  const fadeMatteOpacity =
    !previewEffects || compareModeActive ? 0 : resolvedFilter.fadeAlpha;

  const combinedGrainAlpha =
    !previewEffects || compareModeActive
      ? 0
      : Math.min(0.75, Math.max(resolvedFilter.grainAlpha, fxEval.fxGrainAlpha));

  const vignetteAmt =
    !previewEffects || compareModeActive
      ? 0
      : Math.min(0.92, Math.max(resolvedFilter.vignetteAlpha, fxEval.vignetteFxAlpha));

  // Real-time Pixelation / Mosaic Canvas Ref & Frame Sync
  const pixelCanvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (fxEval.pixelateBlockSize <= 0) return;
    let rafId = 0;
    const drawPixelFrame = () => {
      const c = pixelCanvasRef.current;
      const v = videoRef.current;
      if (c && v && v.readyState >= 2) {
        const blk = Math.max(4, fxEval.pixelateBlockSize);
        const w = Math.max(12, Math.round((srcW || 640) / blk));
        const h = Math.max(12, Math.round((srcH || 360) / blk));
        if (c.width !== w || c.height !== h) {
          c.width = w;
          c.height = h;
        }
        const ctx = c.getContext('2d');
        if (ctx) {
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(v, 0, 0, w, h);
        }
      }
      if (isPlaying) {
        rafId = window.requestAnimationFrame(drawPixelFrame);
      }
    };
    drawPixelFrame();
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [fxEval.pixelateBlockSize, isPlaying, currentTime]);

  const computeAngleFromCenter = (cx: number, cy: number, px: number, py: number) => {
    const deg = (Math.atan2(px - cx, -(py - cy)) * 180) / Math.PI;
    const snapped = Math.round(deg / 45) * 45;
    if (Math.abs(deg - snapped) < 3) return snapped;
    return Math.round(deg);
  };

  const srcW = naturalSize?.w || project.metadata?.width || 1280;
  const srcH = naturalSize?.h || project.metadata?.height || 720;
  const cropRect = resolveCanvasCropPct(canvas, srcW, srcH);

  const videoFrameGeom = useMemo(
    () => getVideoFrameStageGeometry(project, aspectPreviewMode, srcW, srcH),
    [project, aspectPreviewMode, srcW, srcH]
  );

  const togglePlayRef = useRef<() => Promise<void>>(async () => {});
  togglePlayRef.current = togglePlay;

  // Pointer handlers for stage drawing & unified element transform interactions (supports mouse + touch)
  const handleStagePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (readOnlyPreview) return;
    if (drawMode !== 'none' && stageRef.current) {
      e.preventDefault();
      const rect = stageRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      setDragDraw({ startX: x, startY: y, curX: x, curY: y });
      return;
    }
    onSelectElement?.(null);
  };

  const processPointerMove = useCallback(
    (clientX: number, clientY: number) => {
      if (!stageRef.current) return;
      const rect = stageRef.current.getBoundingClientRect();

      if (dragDraw) {
        const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
        setDragDraw((prev) => (prev ? { ...prev, curX: x, curY: y } : null));
        return;
      }

      if (!interaction) return;
      if (interaction.locked) {
        if (
          Math.abs(clientX - interaction.startClientX) > 4 ||
          Math.abs(clientY - interaction.startClientY) > 4
        ) {
          if (interaction.kind === 'video') interaction.moved = true;
          if (!lockedNotifySentRef.current) {
            lockedNotifySentRef.current = true;
            onNotify?.(LOCKED_LAYER_MESSAGE);
          }
        }
        return;
      }
      const dx = (clientX - interaction.startClientX) / Math.max(1, rect.width);
      const dy = (clientY - interaction.startClientY) / Math.max(1, rect.height);

      if (interaction.kind === 'crop-box' && onUpdateCanvas && cropBoxContainerRef.current) {
        const boxRect = cropBoxContainerRef.current.getBoundingClientRect();
        const cdxPct = ((clientX - interaction.startClientX) / Math.max(1, boxRect.width)) * 100;
        const cdyPct = ((clientY - interaction.startClientY) / Math.max(1, boxRect.height)) * 100;

        let nextLeft = interaction.origLeft;
        let nextRight = interaction.origRight;
        let nextTop = interaction.origTop;
        let nextBottom = interaction.origBottom;

        if (interaction.action === 'move') {
          const wPct = Math.max(10, 100 - interaction.origLeft - interaction.origRight);
          const hPct = Math.max(10, 100 - interaction.origTop - interaction.origBottom);
          const rawLeft = Math.max(0, Math.min(100 - wPct, interaction.origLeft + cdxPct));
          const rawTop = Math.max(0, Math.min(100 - hPct, interaction.origTop + cdyPct));
          nextLeft = rawLeft;
          nextRight = Math.max(0, 100 - rawLeft - wPct);
          nextTop = rawTop;
          nextBottom = Math.max(0, 100 - rawTop - hPct);
        } else if (interaction.action === 'resize') {
          const dir = interaction.dir || 'se';
          if (dir.includes('w')) {
            nextLeft = Math.max(0, Math.min(90 - interaction.origRight, interaction.origLeft + cdxPct));
          }
          if (dir.includes('e')) {
            nextRight = Math.max(0, Math.min(90 - nextLeft, interaction.origRight - cdxPct));
          }
          if (dir.includes('n')) {
            nextTop = Math.max(0, Math.min(90 - interaction.origBottom, interaction.origTop + cdyPct));
          }
          if (dir.includes('s')) {
            nextBottom = Math.max(0, Math.min(90 - nextTop, interaction.origBottom - cdyPct));
          }
        }

        const cropLeft = Number(Math.max(0, Math.min(45, nextLeft)).toFixed(1));
        const cropRight = Number(Math.max(0, Math.min(45, nextRight)).toFixed(1));
        const cropTop = Number(Math.max(0, Math.min(45, nextTop)).toFixed(1));
        const cropBottom = Number(Math.max(0, Math.min(45, nextBottom)).toFixed(1));

        const cropX = Math.max(0, Math.round((srcW * nextLeft) / 100));
        const cropY = Math.max(0, Math.round((srcH * nextTop) / 100));
        const cropWidth = Math.max(16, Math.round((srcW * (100 - nextLeft - nextRight)) / 100) & ~1);
        const cropHeight = Math.max(16, Math.round((srcH * (100 - nextTop - nextBottom)) / 100) & ~1);

        onUpdateCanvas({
          cropMode:
            canvas.cropMode === 'custom-region'
              ? 'custom-region'
              : canvas.cropMode === 'zoom'
              ? 'zoom'
              : 'crop',
          cropLeft,
          cropRight,
          cropTop,
          cropBottom,
          cropX,
          cropY,
          cropWidth,
          cropHeight,
        });
        return;
      }

      if (interaction.kind === 'blur' && onUpdateBlur) {
        const targetBlur = project.blurs.find((b) => b.id === interaction.id);
        const isVideoSpace = targetBlur?.coordSpace === 'video';
        const origStage = isVideoSpace
          ? videoBoxToStageBox(
              {
                x: interaction.origX,
                y: interaction.origY,
                width: interaction.origW,
                height: interaction.origH,
              },
              videoFrameGeom
            )
          : {
              x: interaction.origX,
              y: interaction.origY,
              width: interaction.origW,
              height: interaction.origH,
            };

        if (interaction.action === 'move') {
          const rawCenterX = (origStage.x + dx + origStage.width / 2) * 100;
          const rawCenterY = (origStage.y + dy + origStage.height / 2) * 100;
          const sx = snapPercent(rawCenterX);
          const sy = snapPercent(rawCenterY);
          setSnapGuides({ x: sx.line, y: sy.line });

          const stageX = Math.max(-0.2, Math.min(1.1, sx.snapped / 100 - origStage.width / 2));
          const stageY = Math.max(-0.2, Math.min(1.1, sy.snapped / 100 - origStage.height / 2));

          if (isVideoSpace) {
            const vidBox = stageBoxToVideoBox(
              { x: stageX, y: stageY, width: origStage.width, height: origStage.height },
              videoFrameGeom
            );
            onUpdateBlur(interaction.id, { x: vidBox.x, y: vidBox.y });
          } else {
            onUpdateBlur(interaction.id, {
              x: Number(Math.max(0, Math.min(1 - interaction.origW, stageX)).toFixed(3)),
              y: Number(Math.max(0, Math.min(1 - interaction.origH, stageY)).toFixed(3)),
            });
          }
        } else if (interaction.action === 'resize') {
          const dir = interaction.dir || 'se';
          let nextX = origStage.x;
          let nextY = origStage.y;
          let nextW = origStage.width;
          let nextH = origStage.height;

          const minStageW = isVideoSpace ? 0.03 * videoFrameGeom.vw : 0.04;
          const minStageH = isVideoSpace ? 0.025 * videoFrameGeom.vh : 0.03;

          if (dir.includes('e')) {
            nextW = Math.max(minStageW, Math.min(1.2 - nextX, origStage.width + dx));
          }
          if (dir.includes('s')) {
            nextH = Math.max(minStageH, Math.min(1.2 - nextY, origStage.height + dy));
          }
          if (dir.includes('w')) {
            const clampedDx = Math.min(origStage.width - minStageW, dx);
            nextX = origStage.x + clampedDx;
            nextW = origStage.width - clampedDx;
          }
          if (dir.includes('n')) {
            const clampedDy = Math.min(origStage.height - minStageH, dy);
            nextY = origStage.y + clampedDy;
            nextH = origStage.height - clampedDy;
          }

          if (isVideoSpace) {
            const vidBox = stageBoxToVideoBox(
              { x: nextX, y: nextY, width: nextW, height: nextH },
              videoFrameGeom
            );
            onUpdateBlur(interaction.id, vidBox);
          } else {
            onUpdateBlur(interaction.id, {
              x: Number(Math.max(0, nextX).toFixed(3)),
              y: Number(Math.max(0, nextY).toFixed(3)),
              width: Number(Math.min(1 - Math.max(0, nextX), nextW).toFixed(3)),
              height: Number(Math.min(1 - Math.max(0, nextY), nextH).toFixed(3)),
            });
          }
        } else if (
          interaction.action === 'rotate' &&
          interaction.centerClientX &&
          interaction.centerClientY
        ) {
          const deg = computeAngleFromCenter(
            interaction.centerClientX,
            interaction.centerClientY,
            clientX,
            clientY
          );
          onUpdateBlur(interaction.id, { rotation: deg });
        }
        return;
      }

      if (interaction.kind === 'logo' && onUpdateLogo) {
        if (interaction.action === 'move') {
          const estCenterX = (interaction.origX + dx) * 100 + interaction.origW / 2;
          const estCenterY = (interaction.origY + dy) * 100 + 5;
          const sx = snapPercent(estCenterX);
          const sy = snapPercent(estCenterY);
          setSnapGuides({ x: sx.line, y: sy.line });
          const finalX = sx.line !== null ? (sx.snapped - interaction.origW / 2) / 100 : interaction.origX + dx;
          const finalY = sy.line !== null ? (sy.snapped - 5) / 100 : interaction.origY + dy;

          onUpdateLogo(interaction.id, {
            presetPosition: 'custom',
            x: Number(Math.max(0, Math.min(0.95, finalX)).toFixed(3)),
            y: Number(Math.max(0, Math.min(0.95, finalY)).toFixed(3)),
          });
        } else if (interaction.action === 'resize') {
          const dir = interaction.dir || 'se';
          const sign = dir.includes('w') ? -1 : 1;
          onUpdateLogo(interaction.id, {
            widthPct: Number(Math.max(4, Math.min(60, interaction.origW + sign * dx * 100)).toFixed(1)),
          });
        } else if (interaction.action === 'rotate' && interaction.centerClientX && interaction.centerClientY) {
          const deg = computeAngleFromCenter(
            interaction.centerClientX,
            interaction.centerClientY,
            clientX,
            clientY
          );
          onUpdateLogo(interaction.id, { rotation: deg });
        }
        return;
      }

      if (interaction.kind === 'captions' && onUpdateSubtitleStyle) {
        if (interaction.action === 'move') {
          const rawX = Math.max(5, Math.min(95, interaction.origX + dx * 100));
          const rawY = Math.max(5, Math.min(95, interaction.origY + dy * 100));
          const sx = snapPercent(rawX);
          const sy = snapPercent(rawY);
          setSnapGuides({ x: sx.line, y: sy.line });
          onUpdateSubtitleStyle({
            position: 'custom',
            posX: Math.round(sx.snapped),
            posY: Math.round(sy.snapped),
          });
        } else if (interaction.action === 'resize') {
          const dir = interaction.dir || 'se';
          const sign = dir.includes('w') ? -1 : 1;
          const nextScale = Math.max(0.5, Math.min(2.5, interaction.origScale + sign * dx * 1.6));
          onUpdateSubtitleStyle({ scale: Number(nextScale.toFixed(2)) });
        } else if (interaction.action === 'rotate' && interaction.centerClientX && interaction.centerClientY) {
          const deg = computeAngleFromCenter(
            interaction.centerClientX,
            interaction.centerClientY,
            clientX,
            clientY
          );
          onUpdateSubtitleStyle({ rotation: deg });
        }
        return;
      }

      if (interaction.kind === 'caption-element' && onUpdateSubtitleStyle) {
        const existing = project.subtitleStyle.extraElements || [];
        const updateEl = (patchStyle: Partial<SubtitleStyle>) => {
          const nextEls = existing.map((item) =>
            item.id === interaction.id
              ? { ...item, style: { ...item.style, ...patchStyle } }
              : item
          );
          onUpdateSubtitleStyle({ extraElements: nextEls });
        };
        if (interaction.action === 'move') {
          const rawX = Math.max(5, Math.min(95, interaction.origX + dx * 100));
          const rawY = Math.max(5, Math.min(95, interaction.origY + dy * 100));
          const sx = snapPercent(rawX);
          const sy = snapPercent(rawY);
          setSnapGuides({ x: sx.line, y: sy.line });
          updateEl({ position: 'custom', posX: Math.round(sx.snapped), posY: Math.round(sy.snapped) });
        } else if (interaction.action === 'resize') {
          const dir = interaction.dir || 'se';
          const sign = dir.includes('w') ? -1 : 1;
          const nextScale = Math.max(0.4, Math.min(3.0, interaction.origScale + sign * dx * 1.6));
          updateEl({ scale: Number(nextScale.toFixed(2)) });
        } else if (interaction.action === 'rotate' && interaction.centerClientX && interaction.centerClientY) {
          const deg = computeAngleFromCenter(
            interaction.centerClientX,
            interaction.centerClientY,
            clientX,
            clientY
          );
          updateEl({ rotation: deg });
        }
        return;
      }

      if (interaction.kind === 'video' && onUpdateCanvas) {
        if (Math.abs(clientX - interaction.startClientX) > 4 || Math.abs(clientY - interaction.startClientY) > 4) {
          interaction.moved = true;
        }
        if (interaction.action === 'move') {
          const rawX = interaction.origOffsetX + dx * 100;
          const rawY = interaction.origOffsetY + dy * 100;
          const sx = Math.abs(rawX) < 1.8 ? 0 : rawX;
          const sy = Math.abs(rawY) < 1.8 ? 0 : rawY;
          setSnapGuides({ x: sx === 0 ? 50 : null, y: sy === 0 ? 50 : null });
          onUpdateCanvas({
            offsetX: Math.round(Math.max(-100, Math.min(100, sx))),
            offsetY: Math.round(Math.max(-100, Math.min(100, sy))),
          });
        } else if (interaction.action === 'resize') {
          const dir = interaction.dir || 'se';
          const delta = Math.abs(dx) > Math.abs(dy) ? (dir.includes('w') ? -dx : dx) : (dir.includes('n') ? -dy : dy);
          const nextZoom = Math.max(0.25, Math.min(3.0, interaction.origZoom + delta * 1.8));
          onUpdateCanvas({ zoom: Number(nextZoom.toFixed(2)) });
        } else if (interaction.action === 'rotate' && interaction.centerClientX && interaction.centerClientY) {
          const deg = computeAngleFromCenter(
            interaction.centerClientX,
            interaction.centerClientY,
            clientX,
            clientY
          );
          onUpdateCanvas({ videoRotation: deg });
        }
        return;
      }

      if (interaction.kind === 'bg-image' && onUpdateCanvas) {
        if (interaction.action === 'move') {
          onUpdateCanvas({
            bgImageOffsetX: Math.round(Math.max(-50, Math.min(50, interaction.origOffsetX + dx * 100))),
            bgImageOffsetY: Math.round(Math.max(-50, Math.min(50, interaction.origOffsetY + dy * 100))),
          });
        } else if (interaction.action === 'resize') {
          onUpdateCanvas({
            bgImageScale: Number(Math.max(0.5, Math.min(2.5, interaction.origScale + dx * 1.6)).toFixed(2)),
          });
        } else if (interaction.action === 'rotate' && interaction.centerClientX && interaction.centerClientY) {
          const deg = computeAngleFromCenter(
            interaction.centerClientX,
            interaction.centerClientY,
            clientX,
            clientY
          );
          onUpdateCanvas({ bgImageRotation: deg });
        }
      }
    },
    [
      dragDraw,
      interaction,
      onUpdateBlur,
      onUpdateCanvas,
      onUpdateLogo,
      onUpdateSubtitleStyle,
      onNotify,
      project.blurs,
      project.subtitleStyle.extraElements,
      canvas.cropMode,
      srcW,
      srcH,
      videoFrameGeom,
    ]
  );

  const finishPointerInteraction = useCallback(() => {
    if (dragDraw && onFinishDrawBox) {
      const x = Math.min(dragDraw.startX, dragDraw.curX);
      const y = Math.min(dragDraw.startY, dragDraw.curY);
      const width = Math.abs(dragDraw.curX - dragDraw.startX);
      const height = Math.abs(dragDraw.curY - dragDraw.startY);
      if (width > 0.025 && height > 0.025) {
        const targetBlur =
          project.blurs.find((b) => b.id === selectedBlurId) || project.blurs[0];
        if (targetBlur?.coordSpace === 'video') {
          onFinishDrawBox(stageBoxToVideoBox({ x, y, width, height }, videoFrameGeom));
        } else {
          onFinishDrawBox({
            x: Number(x.toFixed(3)),
            y: Number(y.toFixed(3)),
            width: Number(width.toFixed(3)),
            height: Number(height.toFixed(3)),
          });
        }
      }
      setDragDraw(null);
    }

    if (
      interaction?.kind === 'video' &&
      interaction.action === 'move' &&
      !interaction.moved &&
      drawMode === 'none' &&
      !isCropEditActive
    ) {
      void togglePlayRef.current();
    }

    if (interaction) {
      setInteraction(null);
      setSnapGuides({ x: null, y: null });
    }
  }, [
    dragDraw,
    onFinishDrawBox,
    interaction,
    drawMode,
    isCropEditActive,
    project.blurs,
    selectedBlurId,
    videoFrameGeom,
  ]);

  useEffect(() => {
    if (!interaction && !dragDraw) return;
    const onMove = (e: PointerEvent) => {
      processPointerMove(e.clientX, e.clientY);
    };
    const onUp = () => {
      finishPointerInteraction();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [interaction, dragDraw, processPointerMove, finishPointerInteraction]);

  const cropMode = canvas.cropMode || 'fit';
  const hasCustomCanvas =
    canvas.aspectRatio !== 'original' ||
    cropMode !== 'fit' ||
    Math.abs((canvas.zoom || 1) - 1) > 0.005 ||
    Math.abs(canvas.offsetX || 0) > 0.1 ||
    Math.abs(canvas.offsetY || 0) > 0.1 ||
    Math.abs(canvas.videoRotation || 0) > 0.2 ||
    Boolean(canvas.flipH) ||
    Boolean(canvas.flipV) ||
    fxEval.hasTransformFx ||
    (canvas.videoOpacity ?? 1) < 0.99 ||
    canvas.videoVisible === false ||
    (canvas.cropTop || 0) > 0 ||
    (canvas.cropRight || 0) > 0 ||
    (canvas.cropBottom || 0) > 0 ||
    (canvas.cropLeft || 0) > 0 ||
    Boolean(canvas.cropWidth && canvas.cropHeight) ||
    canvas.backgroundType !== 'solid' ||
    (canvas.bgColor || '#09090B').toUpperCase() !== '#09090B';

  const latestSourceTimeRef = useRef(0);
  latestSourceTimeRef.current = activeVideoMatch?.sourceTime ?? 0;

  // Assign previewVideoUrl to mounted <video>, explicitly call load(), wait for loadedmetadata/canplay, and log diagnostics
  useEffect(() => {
    if (!previewVideoUrl) return;
    const vid = videoRef.current;
    if (!vid) return;

    const bgVid = bgVideoRef.current;
    if (vid.getAttribute('src') !== previewVideoUrl) {
      vid.src = previewVideoUrl;
    }
    vid.load();

    if (bgVid) {
      if (bgVid.getAttribute('src') !== previewVideoUrl) {
        bgVid.src = previewVideoUrl;
      }
      bgVid.load();
    }

    const handleLoadedMetadata = () => {
      if (vid.videoWidth && vid.videoHeight) {
        setNaturalSize({ w: vid.videoWidth, h: vid.videoHeight });
      }
      const targetSrcTime = latestSourceTimeRef.current;
      if (vid.duration && Number.isFinite(vid.duration) && targetSrcTime > 0.02) {
        const clamped = Math.min(targetSrcTime, Math.max(0, vid.duration - 0.05));
        vid.currentTime = clamped;
        if (bgVid) bgVid.currentTime = clamped;
      }
      console.info('[VideoPreview] loadedmetadata:', {
        projectId: project.id,
        readyState: vid.readyState,
        networkState: vid.networkState,
        videoWidth: vid.videoWidth,
        videoHeight: vid.videoHeight,
        duration: vid.duration,
      });
      if (vid.readyState >= 2) {
        setPreviewVideoStatus('ready');
        setPreviewVideoError(null);
      }
    };

    const handleCanPlay = () => {
      console.info('[VideoPreview] canplay:', {
        projectId: project.id,
        readyState: vid.readyState,
        networkState: vid.networkState,
      });
      setPreviewVideoStatus('ready');
      setPreviewVideoError(null);
    };

    const handleError = () => {
      const code = vid.error?.code ?? null;
      const codeDesc =
        code === 1
          ? 'Playback aborted (MEDIA_ERR_ABORTED)'
          : code === 2
          ? 'Network/read failure while loading video (MEDIA_ERR_NETWORK)'
          : code === 3
          ? 'Video codec/stream decode error (MEDIA_ERR_DECODE)'
          : code === 4
          ? 'Video source or MIME format not supported by browser (MEDIA_ERR_SRC_NOT_SUPPORTED)'
          : 'Unknown video loading error';
      const detail = vid.error?.message ? `${codeDesc}: ${vid.error.message}` : codeDesc;
      console.error('[VideoPreview] Video element error:', {
        projectId: project.id,
        readyState: vid.readyState,
        networkState: vid.networkState,
        errorCode: code,
        errorMessage: detail,
      });
      setPreviewVideoStatus('error');
      setPreviewVideoError(
        `${detail} (readyState=${vid.readyState}, networkState=${vid.networkState}).`
      );
    };

    vid.addEventListener('loadedmetadata', handleLoadedMetadata);
    vid.addEventListener('canplay', handleCanPlay);
    vid.addEventListener('error', handleError);

    if (vid.readyState >= 1) {
      handleLoadedMetadata();
    }
    if (vid.readyState >= 3) {
      handleCanPlay();
    }

    return () => {
      vid.removeEventListener('loadedmetadata', handleLoadedMetadata);
      vid.removeEventListener('canplay', handleCanPlay);
      vid.removeEventListener('error', handleError);
    };
  }, [previewVideoUrl, project.id, hasCustomCanvas, videoRef]);

  const stageMetrics = useMemo(() => {
    let ratioW = srcW;
    let ratioH = srcH;

    if (aspectPreviewMode === 'export' && effectiveAspect !== 'original') {
      if (effectiveAspect === '9:16') {
        ratioW = 9;
        ratioH = 16;
      } else if (effectiveAspect === '4:5') {
        ratioW = 4;
        ratioH = 5;
      } else if (effectiveAspect === '3:4') {
        ratioW = 3;
        ratioH = 4;
      } else if (effectiveAspect === '1:1') {
        ratioW = 1;
        ratioH = 1;
      } else if (effectiveAspect === 'custom') {
        ratioW = Math.max(240, canvas.customWidth || 1080);
        ratioH = Math.max(240, canvas.customHeight || 1920);
      } else {
        ratioW = 16;
        ratioH = 9;
      }
    }

    const canvasAR = ratioW / Math.max(1, ratioH);
    const isPortraitOrSquare = canvasAR <= 1.05;
    const fitClass =
      aspectPreviewMode === 'original'
        ? 'object-contain'
        : project.exportSettings.fitMode === 'crop'
        ? 'object-cover'
        : 'object-contain';

    let capcutStyle: React.CSSProperties;
    if (variant === 'capcut' && viewportSize.width > 40 && viewportSize.height > 40) {
      const pad = isFullscreen ? 24 : 16;
      const availW = Math.max(120, viewportSize.width - pad);
      const availH = Math.max(120, viewportSize.height - pad);
      if (availW / availH > canvasAR) {
        const fittedH = Math.floor(availH);
        const fittedW = Math.max(120, Math.floor(fittedH * canvasAR));
        capcutStyle = {
          width: `${fittedW}px`,
          height: `${fittedH}px`,
          aspectRatio: `${ratioW} / ${ratioH}`,
        };
      } else {
        const fittedW = Math.floor(availW);
        const fittedH = Math.max(120, Math.floor(fittedW / canvasAR));
        capcutStyle = {
          width: `${fittedW}px`,
          height: `${fittedH}px`,
          aspectRatio: `${ratioW} / ${ratioH}`,
        };
      }
    } else {
      capcutStyle = isPortraitOrSquare
        ? {
            aspectRatio: `${ratioW} / ${ratioH}`,
            height: timelineExpanded ? 'min(260px, 34dvh)' : '100%',
            maxHeight: '100%',
            width: 'auto',
            maxWidth: '100%',
          }
        : {
            aspectRatio: `${ratioW} / ${ratioH}`,
            width: 'min(100%, 920px)',
            maxHeight: '100%',
            height: 'auto',
          };
    }

    const style: React.CSSProperties =
      variant === 'capcut'
        ? capcutStyle
        : isPortraitOrSquare
        ? {
            aspectRatio: `${ratioW} / ${ratioH}`,
            height: 'min(450px, 56vh)',
            width: 'auto',
            maxWidth: '100%',
          }
        : {
            aspectRatio: `${ratioW} / ${ratioH}`,
            width: 'min(100%, 820px)',
            maxHeight: '450px',
            height: 'auto',
          };

    // Apply Smart Center auto-framing when no manual crop box is set
    let effLeft = cropRect.left;
    let effTop = cropRect.top;
    let effRight = cropRect.right;
    let effBottom = cropRect.bottom;

    if (
      cropMode === 'smart-center' &&
      effLeft === 0 &&
      effRight === 0 &&
      effTop === 0 &&
      effBottom === 0
    ) {
      const srcAR = srcW / Math.max(1, srcH);
      if (srcAR > canvasAR) {
        const keepW = (srcH * canvasAR) / srcW;
        const trimPct = Math.max(0, ((1 - keepW) / 2) * 100);
        effLeft = trimPct;
        effRight = trimPct;
      } else if (srcAR < canvasAR) {
        const keepH = (srcW / canvasAR) / srcH;
        const trimTotal = Math.max(0, (1 - keepH) * 100);
        effTop = trimTotal * 0.35;
        effBottom = trimTotal * 0.65;
      }
    }

    const cropScaleX = Math.max(0.1, 1 - (effLeft + effRight) / 100);
    const cropScaleY = Math.max(0.1, 1 - (effTop + effBottom) / 100);
    const croppedAR = (srcW * cropScaleX) / Math.max(1, srcH * cropScaleY);

    let fitW = 100;
    let fitH = 100;
    if (cropMode === 'stretch') {
      fitW = 100;
      fitH = 100;
    } else if (cropMode === 'fill') {
      if (croppedAR > canvasAR) {
        fitH = 100;
        fitW = (croppedAR / canvasAR) * 100;
      } else {
        fitW = 100;
        fitH = (canvasAR / croppedAR) * 100;
      }
    } else {
      if (croppedAR > canvasAR) {
        fitW = 100;
        fitH = (canvasAR / croppedAR) * 100;
      } else {
        fitH = 100;
        fitW = (croppedAR / canvasAR) * 100;
      }
    }

    const distortScale = 1 + fxEval.lensDistortAmt * 0.14;
    const zoom =
      Math.max(0.25, Math.min(3.5, canvas.zoom || 1)) *
      fxEval.zoomScale *
      (fxEval.needsEdgeScale ? 1.05 : 1) *
      distortScale;
    const fgW = fitW * zoom;
    const fgH = fitH * zoom;
    const fgLeft = 50 + (canvas.offsetX || 0) - fgW / 2;
    const fgTop = 50 + (canvas.offsetY || 0) - fgH / 2;

    const fgTransformParts: string[] = [];
    if (Math.abs(fxEval.slideTxPct) > 0.05 || Math.abs(fxEval.slideTyPct) > 0.05) {
      fgTransformParts.push(
        `translate(${fxEval.slideTxPct.toFixed(2)}%, ${fxEval.slideTyPct.toFixed(2)}%)`
      );
    }
    if (Math.abs(fxEval.shakeDx) > 0.05 || Math.abs(fxEval.shakeDy) > 0.05) {
      fgTransformParts.push(`translate(${fxEval.shakeDx.toFixed(2)}px, ${fxEval.shakeDy.toFixed(2)}px)`);
    }
    if (fxEval.waveDistortAmt > 0.05) {
      const skew = Math.sin(currentTime * 6) * 2.5 * fxEval.waveDistortAmt;
      fgTransformParts.push(`skewX(${skew.toFixed(2)}deg)`);
    }
    if (canvas.videoRotation) {
      fgTransformParts.push(`rotate(${canvas.videoRotation}deg)`);
    }
    if (canvas.flipH || canvas.flipV) {
      fgTransformParts.push(`scale(${canvas.flipH ? -1 : 1}, ${canvas.flipV ? -1 : 1})`);
    }

    const fgBoxStyle: React.CSSProperties = {
      position: 'absolute',
      left: `${fgLeft}%`,
      top: `${fgTop}%`,
      width: `${fgW}%`,
      height: `${fgH}%`,
      opacity:
        !isVideoLayerVisible ? 0 : canvas.videoOpacity ?? 1,
      transform: fgTransformParts.length > 0 ? fgTransformParts.join(' ') : undefined,
      transformOrigin: fxEval.transformOrigin,
      clipPath: fxEval.wipeClipPath,
    };

    const denomX = Math.max(10, 100 - effLeft - effRight);
    const denomY = Math.max(10, 100 - effTop - effBottom);

    const fgVideoStyle: React.CSSProperties = {
      position: 'absolute',
      width: `${(1 / cropScaleX) * 100}%`,
      height: `${(1 / cropScaleY) * 100}%`,
      maxWidth: 'none',
      maxHeight: 'none',
      left: `${-(effLeft / denomX) * 100}%`,
      top: `${-(effTop / denomY) * 100}%`,
      objectFit: 'fill',
      filter: effectiveVideoFilterCss,
    };

    // Uncropped container aspect for interactive crop overlay
    const cropBoxWrapperStyle: React.CSSProperties =
      srcW / Math.max(1, srcH) > canvasAR
        ? {
            width: '92%',
            aspectRatio: `${srcW} / ${srcH}`,
            maxHeight: '92%',
          }
        : {
            height: '92%',
            aspectRatio: `${srcW} / ${srcH}`,
            maxWidth: '92%',
          };

    return { style, fitClass, fgBoxStyle, fgVideoStyle, cropBoxWrapperStyle };
  }, [
    srcW,
    srcH,
    aspectPreviewMode,
    effectiveAspect,
    cropMode,
    canvas.customWidth,
    canvas.customHeight,
    cropRect.left,
    cropRect.right,
    cropRect.top,
    cropRect.bottom,
    canvas.zoom,
    canvas.offsetX,
    canvas.offsetY,
    canvas.videoOpacity,
    canvas.videoRotation,
    canvas.flipH,
    canvas.flipV,
    canvas.videoVisible,
    activeVideoMatch,
    project.exportSettings.fitMode,
    effectiveVideoFilterCss,
    fxEval,
    currentTime,
    variant,
    viewportSize.width,
    viewportSize.height,
    isFullscreen,
    timelineExpanded,
  ]);

  // Exact scale ratio between stage pixel height & actual export resolution height
  const exportDims = useMemo(
    () => resolveCanvasDimensions(canvas, project.exportSettings, project.metadata),
    [canvas, project.exportSettings, project.metadata]
  );
  const previewScale =
    stageSize.height > 10 && exportDims.height > 10
      ? stageSize.height / exportDims.height
      : 0.42;

  const getBlurBoxRect = (blur: BlurEffect) => {
    if (blur.mode === 'motion' && blur.keyframes && blur.keyframes.length > 0) {
      return interpolateTrackingBox(blur.keyframes, currentTime) || blur;
    }
    return blur;
  };

  const getAnimatedLogoPosition = (logo: LogoOverlay) => {
    const m = logo.motion;
    if (!m || !m.enabled || m.pattern === 'static') {
      return { x: logo.x, y: logo.y };
    }
    const speed = Math.max(0.2, Math.min(3.0, m.speed || 1));
    const maxW = Math.max(0.05, 1 - logo.widthPct / 100);
    const maxH = 0.86;
    const t = currentTime;

    if (m.pattern === 'bounce') {
      const vx = 0.16 * speed;
      const vy = 0.13 * speed;
      const rx = Math.abs(((logo.x + t * vx) % (2 * maxW)) - maxW);
      const ry = Math.abs(((logo.y + t * vy) % (2 * maxH)) - maxH);
      return { x: rx, y: ry };
    }
    if (m.pattern === 'horizontal') {
      const vx = 0.18 * speed;
      const rx = Math.abs(((logo.x + t * vx) % (2 * maxW)) - maxW);
      return { x: rx, y: logo.y };
    }
    if (m.pattern === 'orbit') {
      const omega = 1.6 * speed;
      const rx = Math.max(0, Math.min(maxW, logo.x + 0.14 * Math.sin(t * omega)));
      const ry = Math.max(0, Math.min(maxH, logo.y + 0.12 * Math.cos(t * omega)));
      return { x: rx, y: ry };
    }
    if (m.pattern === 'custom') {
      const endX = m.endX ?? 0.78;
      const endY = m.endY ?? 0.8;
      const cycle = Math.max(1.5, 6 / speed);
      const phase = (1 - Math.cos((Math.PI * (t % cycle)) / cycle)) / 2;
      return {
        x: Math.max(0, Math.min(maxW, logo.x + (endX - logo.x) * phase)),
        y: Math.max(0, Math.min(maxH, logo.y + (endY - logo.y) * phase)),
      };
    }
    return { x: logo.x, y: logo.y };
  };

  const renderTransformHandles = (
    onStartResize: (dir: ResizeHandleDir, e: React.PointerEvent<HTMLDivElement>) => void,
    onStartRotate: (e: React.PointerEvent<HTMLDivElement>) => void,
    showRotate = true
  ) => (
    <>
      {(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as ResizeHandleDir[]).map((dir) => (
        <div
          key={dir}
          onPointerDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onStartResize(dir, e);
          }}
          title="Drag to resize"
          className={`w-3.5 h-3.5 sm:w-2.5 sm:h-2.5 bg-white border-2 border-violet-600 rounded-[3px] absolute z-40 shadow touch-none ${HANDLE_POSITIONS[dir]} ${HANDLE_CURSORS[dir]}`}
        />
      ))}
      {showRotate && (
        <div
          onPointerDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onStartRotate(e);
          }}
          title="Drag to rotate"
          className="absolute -top-8 left-1/2 -translate-x-1/2 flex flex-col items-center z-40 cursor-grab active:cursor-grabbing touch-none"
        >
          <div className="w-6 h-6 sm:w-5 sm:h-5 rounded-full bg-violet-600 border border-white flex items-center justify-center shadow text-white">
            <RotateCw className="w-3 h-3" />
          </div>
          <div className="w-px h-2 bg-violet-400" />
        </div>
      )}
    </>
  );

  // Full 18-mode caption text & active-word renderer strictly from translatedText
  const renderStyledCaptionContent = (
    textToRender: string,
    wordsToUse: ReturnType<typeof getSyncedCaptionsForPreview>[number]['words'],
    style: SubtitleStyle,
    keyPrefix: string
  ) => {
    const mode = normalizeCanonicalMode(style.mode);
    const animPreset = style.animationPreset || 'none';
    const highlightBehavior = style.highlightBehavior || 'color';
    const transMs = Math.max(50, Math.min(600, style.transitionDurationMs || 180));

    if (!textToRender.trim()) {
      return (
        <span className="inline-flex items-center gap-1 text-[11px] font-mono text-amber-200 bg-amber-950/90 border border-amber-500/50 px-2 py-0.5 rounded">
          <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" />
          Missing translatedText
        </span>
      );
    }

    const getKeyframeAnimation = () => {
      switch (animPreset) {
        case 'word-popup':
        case 'pop':
        case 'word-emphasis':
          return `captionPop ${transMs}ms cubic-bezier(0.22, 1, 0.36, 1)`;
        case 'bounce':
          return `captionBounce ${Math.round(transMs * 1.3)}ms cubic-bezier(0.22, 1, 0.36, 1)`;
        case 'scale':
          return `captionScaleIn ${transMs}ms ease-out`;
        case 'slide-up':
          return `captionSlideUp ${transMs}ms ease-out`;
        case 'fade':
          return `captionFade ${transMs}ms ease-out`;
        default:
          return undefined;
      }
    };

    const renderWordSpan = (
      wInfo: {
        word: string;
        globalIndex: number;
        isActive: boolean;
        isPast: boolean;
        isEmphasized: boolean;
      },
      opts?: { singleMode?: boolean; dimmed?: boolean; showCursor?: boolean; highlightPast?: boolean }
    ) => {
      const displayWord = applyTextTransform(wInfo.word, style);
      const isLit = opts?.highlightPast ? wInfo.isPast : wInfo.isActive;
      const isEmphasisGlow =
        mode === 'emphasis-mode' && wInfo.isEmphasized && !wInfo.isActive;

      const useGradient =
        isLit &&
        (style.gradientEnabled || animPreset === 'gradient-emphasis') &&
        Boolean(style.gradientColor || '#38BDF8');

      const useBox =
        isLit &&
        (highlightBehavior === 'box' ||
          mode === 'boxed-captions' ||
          style.highlightBoxEnabled ||
          animPreset === 'box-highlight');

      const pillBg = useBox
        ? hexToRgba(style.highlightBoxColor || '#7C3AED', style.highlightBoxOpacity ?? 0.85)
        : undefined;

      const textColor = useGradient
        ? 'transparent'
        : isLit
        ? opts?.singleMode
          ? style.primaryColor
          : style.highlightColor
        : isEmphasisGlow
        ? style.highlightColor
        : style.primaryColor;

      const scaleVal =
        !opts?.singleMode && isLit && (highlightBehavior === 'scale' || mode === 'pop-up-words' || mode === 'dynamic-highlight')
          ? animPreset === 'bounce'
            ? 'translateY(-3px) scale(1.1)'
            : 'scale(1.09)'
          : undefined;

      const glowShadow =
        (isLit && (highlightBehavior === 'glow' || animPreset === 'highlight-sweep' || animPreset === 'word-emphasis')) ||
        isEmphasisGlow
          ? `0 0 ${Math.max(6, Math.round(12 * previewScale))}px ${style.highlightColor || '#FACC15'}`
          : undefined;

      return (
        <span
          key={`${keyPrefix}_w_${wInfo.globalIndex}`}
          style={{
            display: 'inline-block',
            animation: wInfo.isActive && opts?.singleMode ? getKeyframeAnimation() : undefined,
            color: textColor,
            backgroundImage: useGradient
              ? `linear-gradient(135deg, ${style.highlightColor || '#FACC15'}, ${
                  style.gradientColor || '#38BDF8'
                })`
              : undefined,
            WebkitBackgroundClip: useGradient ? 'text' : undefined,
            backgroundClip: useGradient ? 'text' : undefined,
            backgroundColor: pillBg,
            padding: useBox ? `${Math.max(1, Math.round(2 * previewScale))}px ${Math.max(4, Math.round(8 * previewScale))}px` : undefined,
            borderRadius: useBox ? `${Math.max(3, Math.round((style.borderRadius ?? 8) * previewScale))}px` : undefined,
            borderBottom:
              isLit && highlightBehavior === 'underline'
                ? `${Math.max(2, Math.round(3 * previewScale))}px solid ${style.highlightColor || '#FACC15'}`
                : undefined,
            transform: scaleVal,
            opacity: opts?.dimmed && !wInfo.isActive ? 0.48 : !opts?.singleMode && !isLit && animPreset === 'word-emphasis' ? 0.78 : 1,
            transition: `transform ${Math.round(transMs * 0.6)}ms ease-out, color ${Math.round(
              transMs * 0.5
            )}ms ease`,
            textShadow: glowShadow,
          }}
        >
          {displayWord}
          {opts?.showCursor && wInfo.isActive ? (
            <span className="inline-block w-[2px] h-[0.9em] bg-current ml-0.5 align-middle animate-pulse" />
          ) : null}
        </span>
      );
    };

    if (
      mode === 'full-sentence' ||
      mode === 'subtitle-classic' ||
      mode === 'minimal-clean'
    ) {
      return (
        <span
          key={keyPrefix}
          style={{
            animation: getKeyframeAnimation(),
            display: 'inline-block',
            whiteSpace: style.textWrap === false ? 'nowrap' : 'pre-wrap',
          }}
        >
          {applyTextTransform(textToRender, style)}
        </span>
      );
    }

    const slice = buildCaptionDisplaySlice({
      mode,
      words: wordsToUse || [],
      currentTime,
      wordsPerDisplay: style.wordsPerDisplay,
      chunkSize: style.chunkSize,
    });

    if (slice.words.length === 0) {
      return <span>{applyTextTransform(textToRender, style)}</span>;
    }

    if (mode === 'word-by-word') {
      return renderWordSpan(slice.words[0], { singleMode: true });
    }

    const isKaraoke = mode === 'karaoke';
    const isProgressive = mode === 'progressive-reveal' || mode === 'typewriter';
    const isContext = mode === 'active-word-context';

    return (
      <span
        key={`${keyPrefix}_${slice.chunkKey}`}
        className="inline-flex flex-wrap items-center gap-x-[0.28em] gap-y-[0.12em]"
        style={{
          justifyContent:
            style.textAlign === 'left'
              ? 'flex-start'
              : style.textAlign === 'right'
              ? 'flex-end'
              : 'center',
          animation: !isProgressive ? getKeyframeAnimation() : undefined,
        }}
      >
        {slice.words.map((w) =>
          renderWordSpan(w, {
            singleMode: false,
            dimmed: isContext,
            highlightPast: isKaraoke,
            showCursor: mode === 'typewriter',
          })
        )}
      </span>
    );
  };

  const renderCaptionInner = () => {
    if (!activeCaption) return null;
    const style = { ...project.subtitleStyle, ...(activeCaption.styleOverride || {}) };
    const activeSource = getActiveCaptionSourceText(activeCaption, true);
    return renderStyledCaptionContent(activeSource, activeCaption.words || [], style, activeCaption.id);
  };

  const buildScaledBoxStyle = (style: SubtitleStyle): React.CSSProperties => {
    const resolvedWeight =
      style.fontWeightNum ||
      (style.fontWeight === '900' ? 900 : style.fontWeight === 'bold' ? 700 : 400);
    const fontPx = Math.max(9, Math.round((style.fontSize || 42) * previewScale));
    const padV = Math.max(0, Math.round((style.paddingV ?? 6) * previewScale));
    const padH = Math.max(0, Math.round((style.paddingH ?? 14) * previewScale));
    const radius = Math.max(0, Math.round((style.borderRadius ?? 8) * previewScale));
    const strokePx = Math.max(0, Number(((style.outlineWidth || 0) * previewScale).toFixed(2)));
    const shadowBlurPx = Math.max(0, Math.round((style.shadowBlur ?? 4) * previewScale));
    const shadowDistPx = Math.max(0, Math.round((style.shadowDistance ?? 2) * previewScale));
    const letterSpPx = Number(((style.letterSpacing || 0) * previewScale).toFixed(2));
    const isMinimalMode = normalizeCanonicalMode(style.mode) === 'minimal-clean';
    const bgOp = isMinimalMode ? 0 : style.backgroundOpacity ?? 0.55;

    return {
      fontFamily: `'${style.fontFamily || 'Montserrat'}', sans-serif`,
      fontSize: `${fontPx}px`,
      fontWeight: resolvedWeight,
      fontStyle: style.italic ? 'italic' : 'normal',
      textDecoration: style.underline ? 'underline' : 'none',
      letterSpacing: `${letterSpPx}px`,
      lineHeight: style.lineSpacing || 1.2,
      textAlign: style.textAlign || 'center',
      borderRadius: `${radius}px`,
      padding: `${padV}px ${padH}px`,
      color: style.primaryColor || '#FFFFFF',
      backgroundColor:
        bgOp > 0.01 ? hexToRgba(style.backgroundColor || '#09090B', bgOp) : 'transparent',
      textShadow: style.shadowEnabled
        ? `0 ${shadowDistPx}px ${shadowBlurPx}px ${hexToRgba(
            style.shadowColor || style.outlineColor || '#000000',
            style.shadowOpacity ?? 0.85
          )}`
        : undefined,
      WebkitTextStroke:
        strokePx > 0.1
          ? `${Math.min(4, strokePx * 0.55)}px ${style.outlineColor || '#09090B'}`
          : undefined,
      paintOrder: strokePx > 0.1 ? 'stroke fill' : undefined,
      overflowWrap: style.textWrap === false ? 'normal' : 'break-word',
      display: style.maxLines && style.textWrap !== false ? '-webkit-box' : 'inline-block',
      WebkitLineClamp: style.maxLines && style.textWrap !== false ? style.maxLines : undefined,
      WebkitBoxOrient: style.maxLines && style.textWrap !== false ? 'vertical' : undefined,
      overflow: style.maxLines && style.textWrap !== false ? 'hidden' : undefined,
    };
  };

  // Original Video Audio status for quick toggle indicator
  const origAudioMuted =
    project.voice.originalAudioMuted !== undefined
      ? Boolean(project.voice.originalAudioMuted)
      : !Boolean(project.voice.preserveOriginalAudio);
  const origAudioEnabled =
    project.voice.originalAudioEnabled !== undefined
      ? Boolean(project.voice.originalAudioEnabled)
      : Boolean(project.voice.preserveOriginalAudio);
  const isOrigAudioAudible = origAudioEnabled && !origAudioMuted;

  return (
    <div
      ref={containerRef}
      className={
        variant === 'capcut'
          ? 'bg-[#09090B] flex flex-col h-full w-full min-h-0 overflow-hidden'
          : 'bg-[#111115] border border-white/[0.08] rounded-xl overflow-hidden flex flex-col'
      }
    >
      {customFontCss && <style>{customFontCss}</style>}

      {/* Classic Top Bar of Preview Stage (hidden in compact CapCut mode) */}
      {variant !== 'capcut' && (
        <div className="h-10 px-4 border-b border-white/[0.08] flex items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-3 text-zinc-400 truncate">
            <span className="font-medium text-zinc-200 truncate">
              {project.sourceFilename || 'No source video loaded'}
            </span>
            {(naturalSize || project.metadata) && (
              <span className="hidden sm:inline font-mono text-[11px] text-zinc-500 tabular-nums whitespace-nowrap">
                {naturalSize?.w || project.metadata?.width}×{naturalSize?.h || project.metadata?.height}
                {project.metadata ? ` · ${project.metadata.fps} fps` : ''}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {drawMode !== 'none' && !readOnlyPreview && (
              <span className="text-[11px] font-medium text-violet-300 hidden md:inline">
                Drag on video to draw {drawMode === 'motion' ? 'tracking target' : 'blur region'}
              </span>
            )}

            {/* Original True Ratio vs Export Ratio Frame Toggle */}
            <div className="flex items-center bg-zinc-900 border border-white/[0.08] rounded-md p-0.5">
              <button
                type="button"
                onClick={() => setAspectPreviewMode('original')}
                className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors whitespace-nowrap cursor-pointer ${
                  aspectPreviewMode === 'original'
                    ? 'bg-violet-600 text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Original Ratio
              </button>
              <button
                type="button"
                onClick={() => setAspectPreviewMode('export')}
                className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors whitespace-nowrap cursor-pointer ${
                  aspectPreviewMode === 'export'
                    ? 'bg-violet-600 text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Export Frame ({effectiveAspect === 'original' ? 'Raw' : effectiveAspect})
              </button>
            </div>

            {!readOnlyPreview && onUpdateCanvas && hasVideoSource && (
              <button
                type="button"
                onClick={() => setCropEditActive(!isCropEditActive)}
                title="Toggle interactive crop rectangle on video preview"
                className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 flex items-center gap-1 cursor-pointer ${
                  isCropEditActive
                    ? 'bg-emerald-600 text-white border border-emerald-400/50'
                    : 'bg-zinc-850 text-zinc-300 hover:text-white border border-white/[0.08]'
                }`}
              >
                <Crop className="w-3 h-3" />
                {isCropEditActive ? 'Done Crop' : 'Crop Box'}
              </button>
            )}

            {/* Compare Raw Video vs Filtered Effects Toggle */}
            <button
              type="button"
              onClick={() => setCompareModeActive(!compareModeActive)}
              title="Toggle Before / After Color Grading Comparison"
              className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                compareModeActive
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                  : 'bg-zinc-850 text-zinc-400 hover:text-zinc-200 border border-white/[0.08]'
              }`}
            >
              {compareModeActive ? 'Before (Raw)' : 'Filters / Effects'}
            </button>

            {/* Editing Guides & Selection Bounds Toggle */}
            {!readOnlyPreview && onUpdateCanvas && (
              <button
                type="button"
                onClick={() =>
                  onUpdateCanvas(
                    { showEditingGuides: !(canvas.showEditingGuides !== false) },
                    { immediate: true }
                  )
                }
                title="Toggle selection borders, resize handles, and editing guides"
                className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 flex items-center gap-1 cursor-pointer ${
                  editingGuidesOn
                    ? 'bg-violet-500/20 text-violet-300 border border-violet-500/40'
                    : 'bg-zinc-850 text-zinc-400 hover:text-zinc-200 border border-white/[0.08]'
                }`}
              >
                <Grid className="w-3 h-3" />
                Guides
              </button>
            )}

            {/* Safe Area Guides Overlay Toggle */}
            {!readOnlyPreview && (
              <button
                type="button"
                onClick={() => setShowSafeGuides(!showSafeGuides)}
                title="Toggle TikTok 9:16 and 16:9 safe-area guides"
                className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  showSafeGuides
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                    : 'bg-zinc-850 text-zinc-400 hover:text-zinc-200 border border-white/[0.08]'
                }`}
              >
                Safe Guides
              </button>
            )}

            <button
              type="button"
              onClick={() => onTogglePreviewEffects(!previewEffects)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                previewEffects
                  ? 'bg-violet-600/20 text-violet-300 border border-violet-500/40'
                  : 'bg-zinc-800 text-zinc-400 border border-white/[0.08]'
              }`}
            >
              {previewEffects ? 'Effects: On' : 'Effects: Off'}
            </button>
          </div>
        </div>
      )}

      {/* Video Stage */}
      <div
        ref={stageViewportRef}
        className={
          variant === 'capcut'
            ? mobileCollapsed
              ? 'relative h-0 min-h-0 p-0 overflow-hidden opacity-0 pointer-events-none lg:opacity-100 lg:pointer-events-auto lg:h-auto lg:flex-1 lg:min-h-[160px] bg-[#07070A] flex items-center justify-center lg:p-3 transition-all duration-150'
              : 'relative flex-1 min-h-[176px] sm:min-h-[220px] lg:min-h-[160px] bg-[#07070A] flex items-center justify-center p-1.5 sm:p-3 overflow-hidden'
            : 'relative bg-[#060608] flex items-center justify-center p-3 sm:p-4 min-h-[280px] sm:min-h-[380px]'
        }
      >
        {/* CapCut Floating Top-Left Aspect Ratio Selector & Top-Right Stage Controls */}
        {variant === 'capcut' && !readOnlyPreview && (
          <>
            <div className="absolute top-2 left-2 sm:top-2.5 sm:left-2.5 z-30">
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setAspectMenuOpen((v) => !v)}
                  className="min-h-[36px] lg:min-h-[30px] px-2.5 py-1 rounded-lg bg-zinc-900/90 hover:bg-zinc-800 backdrop-blur-sm border border-white/15 text-[11px] font-mono font-semibold text-white flex items-center gap-1 cursor-pointer shadow-lg"
                  title="Change Canvas Aspect Ratio"
                >
                  <span>{effectiveAspect === 'original' ? 'Original' : effectiveAspect}</span>
                  <ChevronDown className="w-3.5 h-3.5 text-zinc-300" />
                </button>

                {aspectMenuOpen && (
                  <div className="absolute left-0 mt-1.5 w-36 rounded-xl bg-[#18181D] border border-white/15 shadow-2xl p-1 z-50 space-y-0.5">
                    {(
                      [
                        ['9:16', '9:16 TikTok'],
                        ['16:9', '16:9 Wide'],
                        ['1:1', '1:1 Square'],
                        ['4:5', '4:5 Portrait'],
                        ['3:4', '3:4 Classic'],
                        ['original', 'Original'],
                        ['custom', 'Custom'],
                      ] as Array<[CanvasAspectRatio, string]>
                    ).map(([ratio, label]) => (
                      <button
                        key={ratio}
                        type="button"
                        onClick={() => {
                          setAspectMenuOpen(false);
                          if (onAspectRatioChange) {
                            onAspectRatioChange(ratio);
                          } else {
                            onUpdateCanvas?.({ aspectRatio: ratio }, { immediate: true });
                          }
                          setAspectPreviewMode(ratio === 'original' ? 'original' : 'export');
                        }}
                        className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center justify-between cursor-pointer ${
                          effectiveAspect === ratio
                            ? 'bg-violet-600 text-white'
                            : 'text-zinc-200 hover:bg-white/[0.06]'
                        }`}
                      >
                        <span>{label}</span>
                        {effectiveAspect === ratio && <Check className="w-3 h-3" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="absolute top-2 right-2 sm:top-2.5 sm:right-2.5 z-30 flex items-center gap-1.5">
              {drawMode !== 'none' && (
                <span className="px-2.5 py-1 rounded-lg bg-violet-600/95 text-[11px] font-medium text-white shadow-lg">
                  Drag on video to draw {drawMode}
                </span>
              )}
              {isCropEditActive && (
                <button
                  type="button"
                  onClick={() => setCropEditActive(false)}
                  className="min-h-[36px] lg:min-h-[30px] px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white flex items-center gap-1 shadow-lg cursor-pointer"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>Done Crop</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowSafeGuides(!showSafeGuides)}
                title="Toggle Safe Area Guides"
                aria-label="Toggle Safe Area Guides"
                className={`min-h-[36px] min-w-[36px] lg:min-h-[30px] lg:min-w-[30px] px-2 py-1 rounded-lg backdrop-blur-sm border text-[11px] font-medium flex items-center justify-center cursor-pointer transition-colors ${
                  showSafeGuides
                    ? 'bg-cyan-500/25 border-cyan-400/50 text-cyan-200'
                    : 'bg-zinc-900/85 border-white/15 text-zinc-300 hover:text-white'
                }`}
              >
                <Grid className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={toggleFullscreen}
                title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen Preview'}
                className="min-h-[36px] min-w-[36px] lg:min-h-[30px] lg:min-w-[30px] p-1.5 rounded-lg bg-zinc-900/85 hover:bg-zinc-800 backdrop-blur-sm border border-white/15 text-zinc-200 hover:text-white flex items-center justify-center cursor-pointer"
                aria-label={isFullscreen ? 'Exit Fullscreen' : 'Toggle fullscreen'}
              >
                {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
              </button>
            </div>
          </>
        )}
        {hasVideoSource ? (
          <div
            ref={stageRef}
            onPointerDown={handleStagePointerDown}
            style={{
              ...stageMetrics.style,
              backgroundColor:
                canvas.backgroundType === 'solid'
                  ? canvas.bgColor || '#09090B'
                  : '#09090B',
            }}
            className={`relative overflow-hidden rounded-lg border border-white/[0.08] shadow-2xl select-none touch-none ${
              drawMode !== 'none' ? 'cursor-crosshair' : ''
            }`}
          >
            {/* Background Fill Layer (Image or Blurred Duplicate Video) */}
            {canvas.backgroundType === 'image' &&
              canvas.bgImageUrl &&
              canvas.bgImageVisible !== false && (
                <div
                  onPointerDown={(e) => {
                    if (readOnlyPreview || drawMode !== 'none' || isCropEditActive) return;
                    e.stopPropagation();
                    onSelectElement?.({ kind: 'bg-image' });
                    if (!onUpdateCanvas) return;
                    lockedNotifySentRef.current = false;
                    setInteraction({
                      kind: 'bg-image',
                      action: 'move',
                      startClientX: e.clientX,
                      startClientY: e.clientY,
                      origOffsetX: canvas.bgImageOffsetX || 0,
                      origOffsetY: canvas.bgImageOffsetY || 0,
                      origScale: canvas.bgImageScale || 1,
                      origRot: canvas.bgImageRotation || 0,
                      locked: Boolean(canvas.bgImageLocked),
                    });
                  }}
                  style={{
                    zIndex: layerZIndexMap.get('bg-image') ?? 5,
                    opacity: canvas.bgImageOpacity ?? 1,
                    transform: `translate(calc(-50% + ${canvas.bgImageOffsetX || 0}%), calc(-50% + ${
                      canvas.bgImageOffsetY || 0
                    }%)) scale(${canvas.bgImageScale || 1}) rotate(${
                      canvas.bgImageRotation || 0
                    }deg)`,
                  }}
                  className={`absolute left-1/2 top-1/2 w-full h-full select-none ${
                    editingGuidesOn && isSelectedEl({ kind: 'bg-image' })
                      ? canvas.bgImageLocked
                        ? 'ring-2 ring-amber-400'
                        : 'ring-2 ring-cyan-400'
                      : ''
                  } ${
                    onUpdateCanvas
                      ? canvas.bgImageLocked
                        ? 'cursor-pointer'
                        : 'cursor-move'
                      : ''
                  }`}
                >
                  <img
                    src={resolvedUrls.bgImage || canvas.bgImageUrl}
                    alt="Canvas background"
                    draggable={false}
                    className="w-full h-full object-cover pointer-events-none select-none"
                  />
                </div>
              )}

            {canvas.backgroundType === 'blur' && canvas.bgImageVisible !== false && previewVideoUrl && (
              <video
                ref={bgVideoRef}
                key={`${project.id}:bg`}
                src={previewVideoUrl}
                muted
                playsInline
                preload="auto"
                aria-hidden="true"
                className="absolute inset-0 w-full h-full object-cover pointer-events-none select-none"
                style={{
                  zIndex: 5,
                  opacity: isVideoLayerVisible ? canvas.bgBlurOpacity ?? 0.9 : 0,
                  filter: `blur(${Math.max(2, Math.round((canvas.bgBlurIntensity || 24) * 0.65))}px) brightness(${Math.max(
                    0.3,
                    1 + (canvas.bgBlurBrightness ?? -15) / 100
                  ).toFixed(2)})`,
                  transform: 'scale(1.06)',
                }}
              />
            )}

            {/* Foreground Video Layer (only mounted after async Blob / URL resolution completes) */}
            {previewVideoUrl ? (
              hasCustomCanvas ? (
                <div
                  style={{
                    ...stageMetrics.fgBoxStyle,
                    zIndex: layerZIndexMap.get('video') ?? 10,
                  }}
                  onPointerDown={(e) => {
                    if (readOnlyPreview || drawMode !== 'none' || isCropEditActive) return;
                    e.stopPropagation();
                    onSelectElement?.({ kind: 'video', clipId: activeVideoMatch?.clip.id });
                    const videoIsLocked = Boolean(
                      canvas.videoLocked || activeVideoMatch?.clip.locked
                    );
                    if (!onUpdateCanvas) {
                      void togglePlay();
                      return;
                    }
                    lockedNotifySentRef.current = false;
                    setInteraction({
                      kind: 'video',
                      action: 'move',
                      startClientX: e.clientX,
                      startClientY: e.clientY,
                      origOffsetX: canvas.offsetX || 0,
                      origOffsetY: canvas.offsetY || 0,
                      origZoom: canvas.zoom || 1,
                      origRot: canvas.videoRotation || 0,
                      moved: false,
                      locked: videoIsLocked,
                    });
                  }}
                  className={`touch-none ${
                    editingGuidesOn && isSelectedEl({ kind: 'video' })
                      ? canvas.videoLocked || activeVideoMatch?.clip.locked
                        ? 'ring-2 ring-amber-400'
                        : 'ring-2 ring-violet-400'
                      : ''
                  } ${
                    onUpdateCanvas && drawMode === 'none'
                      ? canvas.videoLocked || activeVideoMatch?.clip.locked
                        ? 'cursor-pointer'
                        : 'cursor-move'
                      : ''
                  }`}
                >
                  <div className="w-full h-full overflow-hidden relative">
                    <video
                      ref={videoRef}
                      key={`${project.id}:fg-custom`}
                      src={previewVideoUrl}
                      playsInline
                      preload="auto"
                      style={stageMetrics.fgVideoStyle}
                      onLoadedMetadata={(e) => {
                        const v = e.currentTarget;
                        if (v.videoWidth && v.videoHeight) {
                          setNaturalSize({ w: v.videoWidth, h: v.videoHeight });
                        }
                      }}
                      onEnded={() => {
                        videoRef.current?.pause();
                        bgVideoRef.current?.pause();
                      }}
                    />
                    {fxEval.pixelateBlockSize > 0 && (
                      <canvas
                        ref={pixelCanvasRef}
                        style={{
                          ...stageMetrics.fgVideoStyle,
                          imageRendering: 'pixelated',
                          opacity: fxEval.pixelateOpacity,
                        }}
                        className="pointer-events-none"
                      />
                    )}
                  </div>
                  {editingGuidesOn &&
                    isSelectedEl({ kind: 'video' }) &&
                    !canvas.videoLocked &&
                    !activeVideoMatch?.clip.locked &&
                    onUpdateCanvas &&
                    !isCropEditActive &&
                    renderTransformHandles(
                      (dir, ev) => {
                        setInteraction({
                          kind: 'video',
                          action: 'resize',
                          dir,
                          startClientX: ev.clientX,
                          startClientY: ev.clientY,
                          origOffsetX: canvas.offsetX || 0,
                          origOffsetY: canvas.offsetY || 0,
                          origZoom: canvas.zoom || 1,
                          origRot: canvas.videoRotation || 0,
                          moved: true,
                        });
                      },
                      (ev) => {
                        const elRect = ev.currentTarget.parentElement?.getBoundingClientRect();
                        setInteraction({
                          kind: 'video',
                          action: 'rotate',
                          startClientX: ev.clientX,
                          startClientY: ev.clientY,
                          origOffsetX: canvas.offsetX || 0,
                          origOffsetY: canvas.offsetY || 0,
                          origZoom: canvas.zoom || 1,
                          origRot: canvas.videoRotation || 0,
                          centerClientX: elRect ? elRect.left + elRect.width / 2 : ev.clientX,
                          centerClientY: elRect ? elRect.top + elRect.height / 2 : ev.clientY,
                          moved: true,
                        });
                      }
                    )}
                </div>
              ) : (
                <video
                  ref={videoRef}
                  key={`${project.id}:fg-raw`}
                  src={previewVideoUrl}
                  playsInline
                  preload="auto"
                  style={{
                    filter: effectiveVideoFilterCss,
                    opacity: isVideoLayerVisible ? 1 : 0,
                    zIndex: layerZIndexMap.get('video') ?? 10,
                  }}
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    if (v.videoWidth && v.videoHeight) {
                      setNaturalSize({ w: v.videoWidth, h: v.videoHeight });
                    }
                  }}
                  onEnded={() => {
                    videoRef.current?.pause();
                  }}
                  onClick={() => {
                    if (drawMode === 'none' && !isCropEditActive) {
                      onSelectElement?.({ kind: 'video', clipId: activeVideoMatch?.clip.id });
                      void togglePlay();
                    }
                  }}
                  className={`w-full h-full relative ${stageMetrics.fitClass}`}
                />
              )
            ) : null}

            {/* Async Loading & Error States for Video Preview */}
            {previewVideoStatus === 'loading' && (
              <div className="absolute inset-0 z-40 bg-black/70 backdrop-blur-[2px] flex flex-col items-center justify-center gap-2 px-4 text-center pointer-events-none">
                <Loader2 className="w-6 h-6 text-violet-400 animate-spin" />
                <div className="text-xs font-medium text-zinc-200">
                  Loading video preview...
                </div>
              </div>
            )}

            {previewVideoStatus === 'error' && (
              <div className="absolute inset-0 z-40 bg-black/85 flex flex-col items-center justify-center gap-3 px-5 text-center">
                <AlertTriangle className="w-7 h-7 text-amber-400" />
                <div className="space-y-1 max-w-sm">
                  <div className="text-xs font-semibold text-white">Video Preview Unavailable</div>
                  <p className="text-[11px] text-zinc-300 leading-relaxed">
                    {previewVideoError || 'Unable to load the original video file for preview.'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setVideoReloadNonce((n) => n + 1);
                  }}
                  className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-medium text-white flex items-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Retry Video Load
                </button>
              </div>
            )}

            {/* Interactive Crop Rectangle Editor Overlay directly over full source frame */}
            {isCropEditActive && onUpdateCanvas && (
              <div
                onPointerDown={(e) => e.stopPropagation()}
                className="absolute inset-0 bg-black/75 z-50 flex flex-col items-center justify-center p-3 touch-none"
              >
                <div
                  ref={cropBoxContainerRef}
                  className="relative bg-black rounded overflow-hidden border border-white/20 shadow-2xl"
                  style={stageMetrics.cropBoxWrapperStyle}
                >
                  {/* Dimmed full original video preview */}
                  {previewVideoUrl && (
                    <video
                      src={previewVideoUrl}
                      muted
                      playsInline
                      preload="auto"
                      ref={(el) => {
                        if (el && Math.abs(el.currentTime - currentTime) > 0.25) {
                          el.currentTime = Math.min(currentTime, Math.max(0, srcDuration - 0.05));
                        }
                      }}
                      className="w-full h-full object-fill opacity-35 pointer-events-none"
                    />
                  )}

                  {/* Draggable & 8-handle Resizable Crop Region */}
                  <div
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setInteraction({
                        kind: 'crop-box',
                        action: 'move',
                        startClientX: e.clientX,
                        startClientY: e.clientY,
                        origLeft: cropRect.left,
                        origTop: cropRect.top,
                        origRight: cropRect.right,
                        origBottom: cropRect.bottom,
                      });
                    }}
                    style={{
                      left: `${cropRect.left}%`,
                      top: `${cropRect.top}%`,
                      width: `${Math.max(10, 100 - cropRect.left - cropRect.right)}%`,
                      height: `${Math.max(10, 100 - cropRect.top - cropRect.bottom)}%`,
                    }}
                    className="absolute border-2 border-emerald-400 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)] cursor-move touch-none"
                  >
                    {/* Crisp rule-of-thirds overlay */}
                    <div className="absolute inset-0 pointer-events-none grid grid-cols-3 grid-rows-3">
                      <div className="border-r border-b border-white/25" />
                      <div className="border-r border-b border-white/25" />
                      <div className="border-b border-white/25" />
                      <div className="border-r border-b border-white/25" />
                      <div className="border-r border-b border-white/25" />
                      <div className="border-b border-white/25" />
                      <div className="border-r border-white/25" />
                      <div className="border-r border-white/25" />
                      <div />
                    </div>

                    <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/80 text-[10px] font-mono text-emerald-300 pointer-events-none whitespace-nowrap">
                      {cropRect.cw}×{cropRect.ch}px @ {cropRect.cx},{cropRect.cy}
                    </div>

                    {renderTransformHandles(
                      (dir, ev) => {
                        setInteraction({
                          kind: 'crop-box',
                          action: 'resize',
                          dir,
                          startClientX: ev.clientX,
                          startClientY: ev.clientY,
                          origLeft: cropRect.left,
                          origTop: cropRect.top,
                          origRight: cropRect.right,
                          origBottom: cropRect.bottom,
                        });
                      },
                      () => {},
                      false
                    )}
                  </div>
                </div>

                {/* Floating Crop Quick Actions Bar */}
                <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5 sm:gap-2 max-w-full bg-[#111115]/95 border border-white/15 rounded-lg px-2.5 sm:px-3 py-1.5 text-[11px] shadow-xl">
                  <span className="text-zinc-300 font-mono tabular-nums">
                    Crop: {cropRect.cw}×{cropRect.ch}px
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateCanvas(
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
                    className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 flex items-center gap-1 cursor-pointer"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Reset Crop
                  </button>
                  <button
                    type="button"
                    onClick={() => setCropEditActive(false)}
                    className="px-2.5 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-semibold flex items-center gap-1 cursor-pointer"
                  >
                    <Check className="w-3 h-3" />
                    Apply Crop
                  </button>
                </div>
              </div>
            )}

            {/* Fade Matte Lift Overlay (from Adjustments or Filter Preset) */}
            {fadeMatteOpacity > 0 && (
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  zIndex: (layerZIndexMap.get('video') ?? 10) + 1,
                  backgroundColor: `rgba(28, 28, 36, ${fadeMatteOpacity.toFixed(3)})`,
                  mixBlendMode: 'lighten',
                }}
              />
            )}

            {/* Background Blur FX Simulation Overlay */}
            {fxEval.bgBlurPx > 0 && (
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  zIndex: (layerZIndexMap.get('video') ?? 10) + 1,
                  backdropFilter: `blur(${fxEval.bgBlurPx.toFixed(1)}px)`,
                  WebkitBackdropFilter: `blur(${fxEval.bgBlurPx.toFixed(1)}px)`,
                  maskImage: `radial-gradient(ellipse 46% 68% at ${fxEval.bgBlurOrigin}, transparent 45%, black 85%)`,
                  WebkitMaskImage: `radial-gradient(ellipse 46% 68% at ${fxEval.bgBlurOrigin}, transparent 45%, black 85%)`,
                }}
              />
            )}

            {/* Lens / Optical Distortion Curvature Rim */}
            {(fxEval.lensDistortAmt > 0.01 || fxEval.waveDistortAmt > 0.01) && (
              <div
                className="absolute inset-0 pointer-events-none z-15"
                style={{
                  boxShadow: `inset 0 0 ${Math.round(
                    32 + Math.max(fxEval.lensDistortAmt, fxEval.waveDistortAmt) * 48
                  )}px rgba(0, 0, 0, ${(Math.max(fxEval.lensDistortAmt, fxEval.waveDistortAmt) * 0.45).toFixed(2)})`,
                  borderRadius:
                    fxEval.lensDistortAmt > 0.05
                      ? `${Math.round(fxEval.lensDistortAmt * 18)}px`
                      : undefined,
                }}
              />
            )}

            {/* Vignette Filter & Effect Overlay */}
            {vignetteAmt > 0 && (
              <div
                className="absolute inset-0 pointer-events-none z-15"
                style={{
                  background: `radial-gradient(circle at ${fxEval.vignetteOrigin}, transparent 38%, rgba(0,0,0,${Math.min(
                    0.88,
                    vignetteAmt * 0.9
                  )}) 100%)`,
                }}
              />
            )}

            {/* Film Grain (Filter / Grading Grain / Film Grain FX) */}
            {combinedGrainAlpha > 0 && (
              <div
                className="absolute inset-0 pointer-events-none mix-blend-overlay z-15"
                style={{
                  opacity: combinedGrainAlpha,
                  backgroundImage: `radial-gradient(rgba(255,255,255,0.42) 1px, transparent 1px), radial-gradient(rgba(0,0,0,0.42) 1px, transparent 1px)`,
                  backgroundSize: '4px 4px',
                  backgroundPosition: `${(Math.floor(currentTime * 24) * 7) % 13}px ${(Math.floor(currentTime * 24) * 5) % 11}px, ${(Math.floor(currentTime * 24) * 3) % 9}px 2px`,
                }}
              />
            )}

            {/* Vintage Projector Dust Flecks */}
            {fxEval.dustAmt > 0 && (
              <div
                className="absolute inset-0 pointer-events-none mix-blend-screen z-15"
                style={{
                  opacity: Math.min(0.65, fxEval.dustAmt * 0.58),
                  backgroundImage:
                    'radial-gradient(rgba(255,248,220,0.75) 1px, transparent 1.5px), radial-gradient(rgba(255,255,255,0.45) 0.8px, transparent 1.4px)',
                  backgroundSize: '64px 52px, 42px 38px',
                  backgroundPosition: `${Math.round(currentTime * 48 * fxEval.dustSpeed) % 64}px ${Math.round(currentTime * 29 * fxEval.dustSpeed) % 52}px, ${Math.round(currentTime * 21 * fxEval.dustSpeed) % 42}px 12px`,
                }}
              />
            )}

            {/* Analog Print Vertical Scratches */}
            {fxEval.scratchAmt > 0 && (
              <div
                className="absolute inset-0 pointer-events-none mix-blend-screen z-15"
                style={{
                  opacity: Math.min(0.55, fxEval.scratchAmt * 0.5),
                  backgroundImage:
                    'linear-gradient(90deg, transparent 14%, rgba(255,255,255,0.35) 14.3%, transparent 14.7%, transparent 62%, rgba(255,240,210,0.28) 62.2%, transparent 62.6%)',
                  backgroundSize: '180px 100%',
                  backgroundPosition: `${Math.round((Math.sin(currentTime * 11 * fxEval.scratchSpeed) + 1) * 90)}px 0`,
                }}
              />
            )}

            {/* Glow / Soft Glow / Bloom Live Simulation */}
            {fxEval.glowAmt > 0 && (
              <div
                className="absolute inset-0 pointer-events-none mix-blend-screen z-15"
                style={{
                  backdropFilter: 'blur(7px)',
                  WebkitBackdropFilter: 'blur(7px)',
                  opacity: Math.min(0.75, fxEval.glowAmt),
                  backgroundColor: 'rgba(255, 252, 240, 0.09)',
                }}
              />
            )}

            {/* Neon Glow Live Simulation */}
            {fxEval.neonAmt > 0 && (
              <div
                className="absolute inset-0 pointer-events-none mix-blend-screen z-15"
                style={{
                  backdropFilter: 'blur(5px)',
                  WebkitBackdropFilter: 'blur(5px)',
                  opacity: Math.min(0.75, fxEval.neonAmt * 0.72),
                  filter: fxEval.neonHue ? `hue-rotate(${Math.round(fxEval.neonHue)}deg)` : undefined,
                  background:
                    'radial-gradient(circle at 50% 50%, rgba(217, 70, 239, 0.16), rgba(34, 211, 238, 0.14))',
                }}
              />
            )}

            {/* RGB Split / Chromatic Aberration / VHS / Glitch Live Simulation */}
            {(fxEval.rgbSplitAmt > 0 || fxEval.vhsAmt > 0 || fxEval.glitchAmt > 0) && (
              <div
                className="absolute inset-0 pointer-events-none mix-blend-screen z-15 overflow-hidden"
                style={{
                  opacity: Math.min(0.72, Math.max(fxEval.rgbSplitAmt * 0.5, fxEval.vhsAmt * 0.45, fxEval.glitchAmt * 0.65)),
                  background:
                    fxEval.vhsAmt > 0
                      ? 'linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.38) 50%), linear-gradient(90deg, rgba(255, 0, 60, 0.22), rgba(0, 255, 120, 0.05), rgba(0, 180, 255, 0.22))'
                      : 'linear-gradient(90deg, rgba(255, 0, 80, 0.28) 0%, transparent 18%, transparent 82%, rgba(0, 235, 255, 0.28) 100%)',
                  backgroundSize: fxEval.vhsAmt > 0 ? '100% 3px, 6px 100%' : undefined,
                }}
              >
                {fxEval.glitchAmt > 0.05 && (
                  <>
                    <div
                      className="absolute left-0 right-0 bg-fuchsia-500/35"
                      style={{
                        top: `${Math.round(((Math.sin(currentTime * 19 * fxEval.glitchSpeed) + 1) * 42))}%`,
                        height: `${Math.max(4, fxEval.glitchBlock * 0.55)}px`,
                        transform: `translateX(${Math.round(Math.cos(currentTime * 27 * fxEval.glitchSpeed) * 14)}px)`,
                      }}
                    />
                    <div
                      className="absolute left-0 right-0 bg-cyan-400/35"
                      style={{
                        top: `${Math.round(((Math.cos(currentTime * 15 * fxEval.glitchSpeed) + 1) * 44))}%`,
                        height: `${Math.max(3, fxEval.glitchBlock * 0.4)}px`,
                        transform: `translateX(${Math.round(Math.sin(currentTime * 23 * fxEval.glitchSpeed) * -16)}px)`,
                      }}
                    />
                  </>
                )}
              </div>
            )}

            {/* Stacked Filter Preset Tint Overlays */}
            {resolvedFilter.tintOverlays.map((tintColor, tintIdx) => (
              <div
                key={`tint-${tintIdx}`}
                className="absolute inset-0 pointer-events-none z-15"
                style={{
                  backgroundColor: tintColor,
                  mixBlendMode: 'screen',
                }}
              />
            ))}

            {/* Light Leaks / Film Burn / Anamorphic Lens Flare Overlays */}
            {fxEval.flares.map((fl, flIdx) => (
              <div
                key={`flare-${flIdx}`}
                className="absolute inset-0 pointer-events-none mix-blend-screen z-15 overflow-hidden"
                style={{
                  opacity: fl.alpha,
                  background:
                    fl.kind === 'flare'
                      ? `radial-gradient(circle at ${fl.xPct}% ${fl.yPct}%, rgba(255,252,220,0.92) 0%, rgba(253,224,71,0.45) 14%, rgba(56,189,248,0.22) 32%, transparent 65%)`
                      : fl.kind === 'burn'
                      ? `radial-gradient(ellipse at ${fl.xPct}% ${fl.yPct}%, rgba(255,115,29,0.85) 0%, rgba(220,38,38,0.48) 38%, transparent 72%)`
                      : `radial-gradient(ellipse at ${fl.xPct}% ${fl.yPct}%, rgba(255,160,70,0.75) 0%, rgba(255,80,40,0.34) 46%, transparent 76%)`,
                }}
              >
                {fl.kind === 'flare' && (
                  <div
                    className="absolute left-0 right-0 -translate-y-1/2"
                    style={{
                      top: `${fl.yPct}%`,
                      height: '4px',
                      background:
                        'linear-gradient(90deg, transparent 0%, rgba(56,189,248,0.55) 28%, rgba(255,255,245,0.95) 50%, rgba(56,189,248,0.55) 72%, transparent 100%)',
                    }}
                  />
                )}
              </div>
            ))}

            {/* White Flash Strobe / Light Flash / Beat Flash / Flash Transition */}
            {fxEval.flashWhiteAlpha > 0.01 && (
              <div
                className="absolute inset-0 pointer-events-none z-15"
                style={{
                  backgroundColor: `rgba(255, 255, 255, ${fxEval.flashWhiteAlpha.toFixed(3)})`,
                }}
              />
            )}

            {/* Warm Retro Flash */}
            {fxEval.flashWarmAlpha > 0.01 && (
              <div
                className="absolute inset-0 pointer-events-none z-15"
                style={{
                  backgroundColor: `rgba(255, 214, 153, ${fxEval.flashWarmAlpha.toFixed(3)})`,
                }}
              />
            )}

            {/* Fade In / Fade Out / Cross Dissolve Transition Overlay */}
            {fxEval.fadeBlackAlpha > 0.01 && (
              <div
                className="absolute inset-0 pointer-events-none z-35"
                style={{
                  backgroundColor: `rgba(0, 0, 0, ${fxEval.fadeBlackAlpha.toFixed(3)})`,
                }}
              />
            )}

            {/* Full Video Blur Live Preview Overlay */}
            {fullBlurEffect && (
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  zIndex: layerZIndexMap.get(`blur:${fullBlurEffect.id}`) ?? 15,
                  opacity: fullBlurEffect.opacity ?? 1,
                  backdropFilter: `blur(${Math.max(2, fullBlurEffect.radius * 0.6)}px)`,
                  WebkitBackdropFilter: `blur(${Math.max(2, fullBlurEffect.radius * 0.6)}px)`,
                }}
              />
            )}

            {/* Synchronized 1.0x Unlinked Original Audio, AI Dub, Background Music & Sound Effects */}
            {hasUnlinkedAudio && previewVideoUrl && (
              <audio
                ref={origAudioRef}
                src={previewVideoUrl}
                preload="auto"
                crossOrigin="anonymous"
              />
            )}
            {project.voice.fullDubUrl && (
              <audio
                ref={dubAudioRef}
                src={resolvedUrls.dub || project.voice.fullDubUrl}
                preload="auto"
                crossOrigin="anonymous"
              />
            )}
            {project.voice.bgMusicUrl && (
              <audio
                ref={musicAudioRef}
                src={resolvedUrls.music || project.voice.bgMusicUrl}
                loop
                preload="auto"
                crossOrigin="anonymous"
              />
            )}
            {project.voice.sfxUrl && (
              <audio
                ref={sfxAudioRef}
                src={resolvedUrls.sfx || project.voice.sfxUrl}
                preload="auto"
                crossOrigin="anonymous"
              />
            )}

            {/* Background Blur Live Preview Simulation Overlay */}
            {bgBlurEffect && (
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  zIndex: layerZIndexMap.get(`blur:${bgBlurEffect.id}`) ?? 15,
                  opacity: bgBlurEffect.opacity ?? 1,
                  backdropFilter: `blur(${Math.max(4, bgBlurEffect.radius * 0.55)}px)`,
                  WebkitBackdropFilter: `blur(${Math.max(4, bgBlurEffect.radius * 0.55)}px)`,
                  maskImage:
                    'radial-gradient(ellipse 46% 68% at 50% 48%, transparent 45%, black 85%)',
                  WebkitMaskImage:
                    'radial-gradient(ellipse 46% 68% at 50% 48%, transparent 45%, black 85%)',
                }}
              />
            )}

            {/* Selective, Caption Remover & Motion Tracking Blur Region Previews */}
            {boxBlurs.map((blur) => {
              const rawBox = getBlurBoxRect(blur);
              const isVideoSpace = blur.coordSpace === 'video';
              const stageBox = isVideoSpace
                ? videoBoxToStageBox(rawBox, videoFrameGeom)
                : { x: rawBox.x, y: rawBox.y, width: rawBox.width, height: rawBox.height, extraRotation: 0 };
              const isSelected = isSelectedEl({ kind: 'blur', id: blur.id });
              const isBlurLocked = Boolean(blur.locked);
              const canSelectBox = !readOnlyPreview && drawMode === 'none' && !isCropEditActive;
              const canEditBox = canSelectBox && Boolean(onUpdateBlur) && !isBlurLocked;
              const showOutline = isSelected && editingGuidesOn && canEditBox;
              const showLockedOutline = isSelected && editingGuidesOn && isBlurLocked;
              const featherAmt = Math.max(0, Math.min(30, blur.feather ?? 10));
              const innerRadiusPct = Math.max(45, 98 - featherAmt * 1.4);
              const featherEdgePct = Math.min(32, featherAmt * 0.9);
              const rectFeatherMask =
                featherAmt > 0
                  ? `linear-gradient(to right, transparent 0%, black ${featherEdgePct}%, black ${100 - featherEdgePct}%, transparent 100%), linear-gradient(to bottom, transparent 0%, black ${featherEdgePct}%, black ${100 - featherEdgePct}%, transparent 100%)`
                  : undefined;
              const maskCss =
                blur.shape === 'ellipse'
                  ? `radial-gradient(ellipse at center, rgba(0,0,0,1) ${innerRadiusPct}%, rgba(0,0,0,0) 100%)`
                  : rectFeatherMask;

              const backdropCss =
                blur.type === 'strong'
                  ? `blur(${Math.max(8, Math.round(blur.radius * 1.15))}px)`
                  : blur.type === 'pixelate'
                  ? `blur(${Math.max(4, Math.round(blur.radius * 0.45))}px) contrast(1.22)`
                  : blur.type === 'box'
                  ? `blur(${Math.max(4, Math.round(blur.radius * 0.58))}px)`
                  : `blur(${Math.max(4, Math.round(blur.radius * 0.68))}px)`;

              const cornerRadiusCss =
                blur.shape === 'ellipse'
                  ? '9999px'
                  : `${Math.max(0, Math.round((blur.borderRadius ?? 0) * previewScale))}px`;

              const totalRot = (blur.rotation || 0) + stageBox.extraRotation;

              return (
                <div
                  key={blur.id}
                  onPointerDown={(e) => {
                    if (readOnlyPreview || drawMode !== 'none' || isCropEditActive) return;
                    e.stopPropagation();
                    onSelectElement?.({ kind: 'blur', id: blur.id });
                    if (!onUpdateBlur) return;
                    lockedNotifySentRef.current = false;
                    setInteraction({
                      kind: 'blur',
                      id: blur.id,
                      action: 'move',
                      startClientX: e.clientX,
                      startClientY: e.clientY,
                      origX: rawBox.x,
                      origY: rawBox.y,
                      origW: rawBox.width,
                      origH: rawBox.height,
                      origRot: blur.rotation || 0,
                      locked: isBlurLocked,
                    });
                  }}
                  className={`absolute transition-none touch-none ${
                    canEditBox
                      ? 'cursor-move'
                      : canSelectBox
                      ? 'cursor-pointer'
                      : 'pointer-events-none'
                  } ${
                    showLockedOutline
                      ? 'ring-2 ring-amber-400'
                      : showOutline
                      ? blur.isSubtitleMask
                        ? 'ring-2 ring-sky-400'
                        : 'ring-2 ring-violet-400'
                      : ''
                  }`}
                  style={{
                    zIndex: layerZIndexMap.get(`blur:${blur.id}`) ?? 18,
                    left: `${stageBox.x * 100}%`,
                    top: `${stageBox.y * 100}%`,
                    width: `${stageBox.width * 100}%`,
                    height: `${stageBox.height * 100}%`,
                    borderRadius: cornerRadiusCss,
                    transform: totalRot ? `rotate(${totalRot}deg)` : undefined,
                    transformOrigin: 'center center',
                  }}
                >
                  {showLockedOutline && (
                    <span className="absolute -top-2.5 -left-1 z-30 inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber-400 text-zinc-950 shadow pointer-events-none">
                      <Lock className="w-2.5 h-2.5" />
                    </span>
                  )}
                  <div
                    className="w-full h-full pointer-events-none"
                    style={{
                      opacity: blur.opacity ?? 1,
                      borderRadius: cornerRadiusCss,
                      backdropFilter: backdropCss,
                      WebkitBackdropFilter: backdropCss,
                      backgroundImage:
                        blur.type === 'pixelate'
                          ? 'linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px)'
                          : undefined,
                      backgroundSize: blur.type === 'pixelate' ? '8px 8px' : undefined,
                      maskImage: maskCss,
                      WebkitMaskImage: maskCss,
                      maskComposite: blur.shape !== 'ellipse' && featherAmt > 0 ? 'intersect' : undefined,
                      WebkitMaskComposite:
                        blur.shape !== 'ellipse' && featherAmt > 0 ? 'source-in' : undefined,
                    }}
                  />

                  {showOutline &&
                    renderTransformHandles(
                      (dir, ev) => {
                        setInteraction({
                          kind: 'blur',
                          id: blur.id,
                          action: 'resize',
                          dir,
                          startClientX: ev.clientX,
                          startClientY: ev.clientY,
                          origX: rawBox.x,
                          origY: rawBox.y,
                          origW: rawBox.width,
                          origH: rawBox.height,
                          origRot: blur.rotation || 0,
                        });
                      },
                      (ev) => {
                        const elRect = ev.currentTarget.parentElement?.getBoundingClientRect();
                        setInteraction({
                          kind: 'blur',
                          id: blur.id,
                          action: 'rotate',
                          startClientX: ev.clientX,
                          startClientY: ev.clientY,
                          origX: rawBox.x,
                          origY: rawBox.y,
                          origW: rawBox.width,
                          origH: rawBox.height,
                          origRot: blur.rotation || 0,
                          centerClientX: elRect ? elRect.left + elRect.width / 2 : ev.clientX,
                          centerClientY: elRect ? elRect.top + elRect.height / 2 : ev.clientY,
                        });
                      }
                    )}
                </div>
              );
            })}

            {/* Active Drag-Draw Marquee */}
            {dragDraw && (
              <div
                className="absolute border-2 border-dashed border-violet-400 bg-violet-500/15 pointer-events-none z-40"
                style={{
                  left: `${Math.min(dragDraw.startX, dragDraw.curX) * 100}%`,
                  top: `${Math.min(dragDraw.startY, dragDraw.curY) * 100}%`,
                  width: `${Math.abs(dragDraw.curX - dragDraw.startX) * 100}%`,
                  height: `${Math.abs(dragDraw.curY - dragDraw.startY) * 100}%`,
                }}
              />
            )}

            {/* Interactive Logo & Watermark Overlays */}
            {activeLogos.map((logo) => {
              const selected = isSelectedEl({ kind: 'logo', id: logo.id });
              const animPos = getAnimatedLogoPosition(logo);
              const isLogoLocked = Boolean(logo.locked);
              const canSelectLogo = !readOnlyPreview && drawMode === 'none' && !isCropEditActive;
              const canEditLogo = canSelectLogo && Boolean(onUpdateLogo) && !isLogoLocked;
              const showOutline = selected && editingGuidesOn && canEditLogo;
              const showLockedOutline = selected && editingGuidesOn && isLogoLocked;

              return (
                <div
                  key={logo.id}
                  onPointerDown={(e) => {
                    if (readOnlyPreview || drawMode !== 'none' || isCropEditActive) return;
                    e.stopPropagation();
                    onSelectElement?.({ kind: 'logo', id: logo.id });
                    if (!onUpdateLogo) return;
                    lockedNotifySentRef.current = false;
                    setInteraction({
                      kind: 'logo',
                      id: logo.id,
                      action: 'move',
                      startClientX: e.clientX,
                      startClientY: e.clientY,
                      origX: logo.x,
                      origY: logo.y,
                      origW: logo.widthPct,
                      origRot: logo.rotation || 0,
                      locked: isLogoLocked,
                    });
                  }}
                  className={`absolute touch-none ${
                    canEditLogo
                      ? 'cursor-move'
                      : canSelectLogo
                      ? 'cursor-pointer'
                      : 'pointer-events-none'
                  } ${
                    showLockedOutline
                      ? 'ring-2 ring-amber-400 rounded-sm'
                      : showOutline
                      ? 'ring-2 ring-violet-400 rounded-sm'
                      : ''
                  }`}
                  style={{
                    zIndex: layerZIndexMap.get(`logo:${logo.id}`) ?? 22,
                    left: `${animPos.x * 100}%`,
                    top: `${animPos.y * 100}%`,
                    width: `${logo.widthPct}%`,
                    opacity: logo.opacity,
                    transform: logo.rotation ? `rotate(${logo.rotation}deg)` : undefined,
                    transformOrigin: 'center center',
                  }}
                >
                  {showLockedOutline && (
                    <span className="absolute -top-2.5 -left-1 z-30 inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber-400 text-zinc-950 shadow pointer-events-none">
                      <Lock className="w-2.5 h-2.5" />
                    </span>
                  )}
                  <img
                    src={resolvedUrls.logos[logo.id] || logo.url}
                    alt={logo.filename}
                    draggable={false}
                    className="w-full h-auto pointer-events-none select-none"
                  />
                  {showOutline &&
                    renderTransformHandles(
                      (dir, ev) => {
                        setInteraction({
                          kind: 'logo',
                          id: logo.id,
                          action: 'resize',
                          dir,
                          startClientX: ev.clientX,
                          startClientY: ev.clientY,
                          origX: logo.x,
                          origY: logo.y,
                          origW: logo.widthPct,
                          origRot: logo.rotation || 0,
                        });
                      },
                      (ev) => {
                        const elRect = ev.currentTarget.parentElement?.getBoundingClientRect();
                        setInteraction({
                          kind: 'logo',
                          id: logo.id,
                          action: 'rotate',
                          startClientX: ev.clientX,
                          startClientY: ev.clientY,
                          origX: logo.x,
                          origY: logo.y,
                          origW: logo.widthPct,
                          origRot: logo.rotation || 0,
                          centerClientX: elRect ? elRect.left + elRect.width / 2 : ev.clientX,
                          centerClientY: elRect ? elRect.top + elRect.height / 2 : ev.clientY,
                        });
                      }
                    )}
                </div>
              );
            })}

            {/* Live Styled & Animated Translated Caption Overlay */}
            {activeCaption &&
              (() => {
                const effStyle: SubtitleStyle = {
                  ...project.subtitleStyle,
                  ...(activeCaption.styleOverride || {}),
                };
                const rawCap = project.captions.find((c) => c.id === activeCaption.id);
                const isCaptionLocked = Boolean(effStyle.locked || rawCap?.locked);
                const effX = effStyle.posX !== undefined ? effStyle.posX : 50;
                const effY =
                  effStyle.posY !== undefined
                    ? effStyle.posY
                    : effStyle.position === 'top'
                    ? 14
                    : effStyle.position === 'middle'
                    ? 50
                    : 84;
                return (
                  <div
                    onPointerDown={(e) => {
                      if (readOnlyPreview || drawMode !== 'none' || isCropEditActive) return;
                      e.stopPropagation();
                      onSelectElement?.({ kind: 'captions', segmentId: activeCaption.id });
                      if (!onUpdateSubtitleStyle) return;
                      lockedNotifySentRef.current = false;
                      setInteraction({
                        kind: 'captions',
                        action: 'move',
                        startClientX: e.clientX,
                        startClientY: e.clientY,
                        origX: effX,
                        origY: effY,
                        origScale: effStyle.scale ?? 1,
                        origRot: effStyle.rotation ?? 0,
                        locked: isCaptionLocked,
                      });
                    }}
                    style={{
                      zIndex: layerZIndexMap.get('captions') ?? 26,
                      left: `${effX}%`,
                      top: `${effY}%`,
                      maxWidth: `${effStyle.maxWidthPct ?? 88}%`,
                      opacity: effStyle.opacity ?? 1,
                      transform: `translate(-50%, -50%) scale(${effStyle.scale ?? 1}) rotate(${
                        effStyle.rotation ?? 0
                      }deg)`,
                      transformOrigin: 'center center',
                    }}
                    className={`absolute select-none touch-none ${
                      !readOnlyPreview && drawMode === 'none' && !isCropEditActive
                        ? !isCaptionLocked && onUpdateSubtitleStyle
                          ? 'cursor-move'
                          : 'cursor-pointer'
                        : 'pointer-events-none'
                    } ${
                      editingGuidesOn && isSelectedEl({ kind: 'captions' })
                        ? isCaptionLocked
                          ? 'ring-2 ring-amber-400 rounded-lg p-0.5'
                          : onUpdateSubtitleStyle
                          ? 'ring-2 ring-violet-400 rounded-lg p-0.5'
                          : ''
                        : ''
                    }`}
                  >
                    {editingGuidesOn && isSelectedEl({ kind: 'captions' }) && isCaptionLocked && (
                      <span className="absolute -top-2.5 -left-1 z-30 inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber-400 text-zinc-950 shadow pointer-events-none">
                        <Lock className="w-2.5 h-2.5" />
                      </span>
                    )}
                    <div style={buildScaledBoxStyle(effStyle)}>{renderCaptionInner()}</div>

                    {editingGuidesOn &&
                      isSelectedEl({ kind: 'captions' }) &&
                      !isCaptionLocked &&
                      onUpdateSubtitleStyle &&
                      renderTransformHandles(
                        (dir, ev) => {
                          setInteraction({
                            kind: 'captions',
                            action: 'resize',
                            dir,
                            startClientX: ev.clientX,
                            startClientY: ev.clientY,
                            origX: effX,
                            origY: effY,
                            origScale: effStyle.scale ?? 1,
                            origRot: effStyle.rotation ?? 0,
                          });
                        },
                        (ev) => {
                          const elRect = ev.currentTarget.parentElement?.getBoundingClientRect();
                          setInteraction({
                            kind: 'captions',
                            action: 'rotate',
                            startClientX: ev.clientX,
                            startClientY: ev.clientY,
                            origX: effX,
                            origY: effY,
                            origScale: effStyle.scale ?? 1,
                            origRot: effStyle.rotation ?? 0,
                            centerClientX: elRect ? elRect.left + elRect.width / 2 : ev.clientX,
                            centerClientY: elRect ? elRect.top + elRect.height / 2 : ev.clientY,
                          });
                        }
                      )}
                  </div>
                );
              })()}

            {/* Extra Independent Caption Elements */}
            {activeExtraElements.map((el: CaptionElementLayer, idx: number) => {
              const mergedStyle: SubtitleStyle = {
                ...project.subtitleStyle,
                ...el.style,
              };
              const curX = mergedStyle.posX ?? 50;
              const curY = mergedStyle.posY ?? 22;
              const isSel = isSelectedEl({ kind: 'caption-element', id: el.id });
              const rawDisplayText = el.syncToCaptions
                ? currentCaptionSegment
                  ? getActiveCaptionSourceText(currentCaptionSegment, true)
                  : ''
                : el.text.includes('{caption}')
                ? el.text.replace(
                    /\{caption\}/g,
                    currentCaptionSegment ? getActiveCaptionSourceText(currentCaptionSegment, true) : ''
                  )
                : el.text;
              if (el.syncToCaptions && !rawDisplayText.trim()) return null;

              return (
                <div
                  key={el.id}
                  onPointerDown={(e) => {
                    if (readOnlyPreview || drawMode !== 'none' || isCropEditActive) return;
                    e.stopPropagation();
                    onSelectElement?.({ kind: 'caption-element', id: el.id });
                    if (!onUpdateSubtitleStyle) return;
                    lockedNotifySentRef.current = false;
                    setInteraction({
                      kind: 'caption-element',
                      id: el.id,
                      action: 'move',
                      startClientX: e.clientX,
                      startClientY: e.clientY,
                      origX: curX,
                      origY: curY,
                      origScale: mergedStyle.scale ?? 1,
                      origRot: mergedStyle.rotation ?? 0,
                      locked: Boolean(el.locked),
                    });
                  }}
                  style={{
                    zIndex: layerZIndexMap.get(`caption-element:${el.id}`) ?? 27 + idx,
                    left: `${curX}%`,
                    top: `${curY}%`,
                    maxWidth: `${mergedStyle.maxWidthPct ?? 88}%`,
                    opacity: mergedStyle.opacity ?? 1,
                    transform: `translate(-50%, -50%) scale(${mergedStyle.scale ?? 1}) rotate(${
                      mergedStyle.rotation ?? 0
                    }deg)`,
                    transformOrigin: 'center center',
                  }}
                  className={`absolute select-none touch-none ${
                    !readOnlyPreview && drawMode === 'none' && !isCropEditActive
                      ? !el.locked && onUpdateSubtitleStyle
                        ? 'cursor-move'
                        : 'cursor-pointer'
                      : 'pointer-events-none'
                  } ${
                    editingGuidesOn && isSel
                      ? el.locked
                        ? 'ring-2 ring-amber-400 rounded-lg p-0.5'
                        : onUpdateSubtitleStyle
                        ? 'ring-2 ring-cyan-400 rounded-lg p-0.5'
                        : ''
                      : ''
                  }`}
                >
                  {editingGuidesOn && isSel && el.locked && (
                    <span className="absolute -top-2.5 -left-1 z-30 inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber-400 text-zinc-950 shadow pointer-events-none">
                      <Lock className="w-2.5 h-2.5" />
                    </span>
                  )}
                  <div style={buildScaledBoxStyle(mergedStyle)}>
                    <span>{applyTextTransform(rawDisplayText, mergedStyle)}</span>
                  </div>

                  {editingGuidesOn &&
                    isSel &&
                    !el.locked &&
                    onUpdateSubtitleStyle &&
                    renderTransformHandles(
                      (dir, ev) => {
                        setInteraction({
                          kind: 'caption-element',
                          id: el.id,
                          action: 'resize',
                          dir,
                          startClientX: ev.clientX,
                          startClientY: ev.clientY,
                          origX: curX,
                          origY: curY,
                          origScale: mergedStyle.scale ?? 1,
                          origRot: mergedStyle.rotation ?? 0,
                        });
                      },
                      (ev) => {
                        const elRect = ev.currentTarget.parentElement?.getBoundingClientRect();
                        setInteraction({
                          kind: 'caption-element',
                          id: el.id,
                          action: 'rotate',
                          startClientX: ev.clientX,
                          startClientY: ev.clientY,
                          origX: curX,
                          origY: curY,
                          origScale: mergedStyle.scale ?? 1,
                          origRot: mergedStyle.rotation ?? 0,
                          centerClientX: elRect ? elRect.left + elRect.width / 2 : ev.clientX,
                          centerClientY: elRect ? elRect.top + elRect.height / 2 : ev.clientY,
                        });
                      }
                    )}
                </div>
              );
            })}

            {/* Honest Font Status Error Badge if active caption font failed to load */}
            {project.subtitleStyle.enabled && primaryFontStatus.status === 'error' && (
              <div
                title={primaryFontStatus.error}
                className="absolute top-2 left-2 z-40 px-2 py-1 rounded bg-red-950/90 border border-red-500/40 text-[10px] font-mono text-red-200 flex items-center gap-1 pointer-events-none"
              >
                <AlertTriangle className="w-3 h-3 text-red-400" />
                Font unavailable: {project.subtitleStyle.fontFamily}
              </div>
            )}

            {/* Magnetic Snapping Guide Lines */}
            {snapGuides.x !== null && (
              <div
                className="absolute top-0 bottom-0 w-px bg-cyan-400/90 pointer-events-none z-40"
                style={{ left: `${snapGuides.x}%` }}
              />
            )}
            {snapGuides.y !== null && (
              <div
                className="absolute left-0 right-0 h-px bg-cyan-400/90 pointer-events-none z-40"
                style={{ top: `${snapGuides.y}%` }}
              />
            )}

            {/* Safe Area Guides Overlay */}
            {showSafeGuides && !readOnlyPreview && (
              <div className="absolute inset-0 pointer-events-none border border-violet-500/40 z-30">
                <div className="absolute top-[12%] bottom-[18%] left-[6%] right-[16%] border border-dashed border-amber-400/70 rounded-xs flex flex-col justify-between p-2">
                  <span className="self-start text-[9px] font-mono text-amber-300 bg-black/75 px-1.5 py-0.5 rounded">
                    TikTok Header Safe Zone
                  </span>
                  <span className="self-end text-[9px] font-mono text-amber-300 bg-black/75 px-1.5 py-0.5 rounded">
                    Right Action Buttons Safe
                  </span>
                  <span className="self-center text-[9px] font-mono text-amber-300 bg-black/75 px-1.5 py-0.5 rounded">
                    TikTok / Shorts Safe Area
                  </span>
                </div>
                <div className="absolute inset-[10%] border border-dashed border-cyan-400/40 rounded-xs pointer-events-none">
                  <span className="absolute top-1 left-1 text-[9px] font-mono text-cyan-300 bg-black/60 px-1 rounded">
                    16:9 Title Safe (10%)
                  </span>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="text-center space-y-2 py-14 px-6 max-w-md">
            <div className="text-sm font-medium text-zinc-200">No Video Loaded in Workspace</div>
            <p className="text-xs text-zinc-500 leading-relaxed">
              Upload an MP4, MOV, or MKV movie recap video from the Dashboard or Video Editor tab to
              begin editing, transcribing, blurring, and dubbing.
            </p>
          </div>
        )}
      </div>

      {/* Transport Controls Bar */}
      {variant === 'capcut' ? (
        <div className="px-2 sm:px-4 h-12 lg:h-11 border-t border-white/[0.08] bg-[#111115] flex items-center justify-between gap-1.5 sm:gap-2 shrink-0">
          <div className="flex items-center gap-1 sm:gap-2 min-w-0">
            <button
              type="button"
              onClick={togglePlay}
              disabled={!previewVideoUrl}
              className="min-w-[40px] min-h-[40px] lg:min-w-[36px] lg:min-h-[36px] rounded-lg bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-800 disabled:opacity-40 text-white flex items-center justify-center transition-colors cursor-pointer shrink-0"
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? (
                <Pause className="w-4 h-4 fill-white" />
              ) : (
                <Play className="w-4 h-4 fill-white ml-0.5" />
              )}
            </button>

            <div className="hidden min-[380px]:flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => stepFrame(-1)}
                disabled={!previewVideoUrl}
                title="Previous frame"
                aria-label="Previous frame"
                className="min-w-[34px] min-h-[36px] lg:min-w-[30px] lg:min-h-[30px] p-1 rounded-md text-zinc-400 hover:text-white hover:bg-white/[0.06] disabled:opacity-40 flex items-center justify-center cursor-pointer"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => stepFrame(1)}
                disabled={!previewVideoUrl}
                title="Next frame"
                aria-label="Next frame"
                className="min-w-[34px] min-h-[36px] lg:min-w-[30px] lg:min-h-[30px] p-1 rounded-md text-zinc-400 hover:text-white hover:bg-white/[0.06] disabled:opacity-40 flex items-center justify-center cursor-pointer"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            <div className="font-mono text-[11px] min-[380px]:text-xs sm:text-[13px] text-white tabular-nums whitespace-nowrap ml-0.5 truncate">
              {formatTimecode(currentTime)}{' '}
              <span className="text-zinc-500">/ {formatTimecode(effectiveDuration)}</span>
            </div>
          </div>

          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            {Math.abs(activeVideoSpeed - 1.0) > 0.01 && (
              <button
                type="button"
                onClick={onOpenSpeedEditor}
                title="Active video clip speed (narration & other tracks stay 1.0x)"
                className="min-h-[32px] lg:min-h-[28px] px-1.5 sm:px-2 py-0.5 rounded-md bg-violet-600/20 border border-violet-500/40 text-[11px] font-mono font-semibold text-violet-200 cursor-pointer whitespace-nowrap"
              >
                {activeVideoSpeed}x
              </button>
            )}

            <button
              type="button"
              onClick={() => setCompareModeActive(!compareModeActive)}
              title={compareModeActive ? 'Showing Raw Unfiltered Video' : 'Compare Before/After Filters'}
              className={`min-h-[34px] lg:min-h-[30px] px-2 py-1 rounded-md text-[11px] font-medium cursor-pointer transition-colors whitespace-nowrap ${
                compareModeActive
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                  : 'text-zinc-300 hover:text-white hover:bg-white/[0.06]'
              }`}
            >
              <span className="min-[380px]:hidden">{compareModeActive ? 'Raw' : 'FX'}</span>
              <span className="hidden min-[380px]:inline">{compareModeActive ? 'Raw' : 'FX On'}</span>
            </button>

            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setMuted(!muted)}
                className="min-w-[36px] min-h-[36px] lg:min-w-[32px] lg:min-h-[32px] p-1.5 rounded-lg text-zinc-300 hover:text-white hover:bg-white/[0.06] flex items-center justify-center cursor-pointer"
                aria-label={muted ? 'Unmute master output' : 'Mute master output'}
                title={muted ? 'Unmute master output' : 'Mute master output'}
              >
                {muted || volume === 0 ? (
                  <VolumeX className="w-4 h-4 text-zinc-400" />
                ) : (
                  <Volume2 className="w-4 h-4" />
                )}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={(e) => {
                  setMuted(false);
                  setVolume(Number(e.target.value));
                }}
                className="hidden sm:block w-16 accent-violet-500 h-1 bg-zinc-800 rounded cursor-pointer"
                aria-label="Master Volume"
              />
            </div>

            {onToggleMobileCollapsed && (
              <button
                type="button"
                onClick={onToggleMobileCollapsed}
                className={`lg:hidden min-h-[36px] px-2 py-1 rounded-lg border text-[11px] font-medium flex items-center gap-1 cursor-pointer whitespace-nowrap ${
                  mobileCollapsed
                    ? 'bg-violet-600/25 border-violet-500/50 text-violet-200'
                    : 'bg-zinc-900/70 border-white/[0.08] text-zinc-300 hover:text-white'
                }`}
                aria-label={mobileCollapsed ? 'Show video preview' : 'Minimize video preview'}
                title={mobileCollapsed ? 'Show preview' : 'Hide preview to expand timeline'}
              >
                {mobileCollapsed ? (
                  <>
                    <ChevronDown className="w-3.5 h-3.5" />
                    <span className="hidden min-[360px]:inline">Video</span>
                  </>
                ) : (
                  <ChevronUp className="w-3.5 h-3.5" />
                )}
              </button>
            )}

            <button
              type="button"
              onClick={toggleFullscreen}
              className="min-w-[36px] min-h-[36px] lg:min-w-[32px] lg:min-h-[32px] p-1.5 rounded-lg text-zinc-300 hover:text-white hover:bg-white/[0.06] flex items-center justify-center cursor-pointer"
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Toggle fullscreen'}
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen preview'}
            >
              {isFullscreen ? (
                <Minimize2 className="w-4 h-4 text-violet-300" />
              ) : (
                <Maximize2 className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
      ) : (
        <div className="px-4 py-2.5 border-t border-white/[0.08] bg-[#111115] space-y-2">
          <input
            type="range"
            min={0}
            max={Math.max(0.1, effectiveDuration)}
            step={0.02}
            value={Math.min(currentTime, effectiveDuration || 0)}
            disabled={!previewVideoUrl}
            onChange={(e) => seekTo(Number(e.target.value))}
            className="w-full accent-violet-500 h-1.5 bg-zinc-800 rounded-lg cursor-pointer"
            aria-label="Seek video timeline"
          />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={togglePlay}
                disabled={!previewVideoUrl}
                className="w-9 h-9 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white flex items-center justify-center transition-colors cursor-pointer"
                aria-label={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
              </button>

              <button
                type="button"
                onClick={() => stepFrame(-1)}
                disabled={!previewVideoUrl}
                title="Previous frame"
                className="p-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 disabled:opacity-40 text-zinc-200 cursor-pointer"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => stepFrame(1)}
                disabled={!previewVideoUrl}
                title="Next frame"
                className="p-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 disabled:opacity-40 text-zinc-200 cursor-pointer"
              >
                <ChevronRight className="w-4 h-4" />
              </button>

              <div className="ml-2 font-mono text-xs text-zinc-300 tabular-nums whitespace-nowrap">
                {formatTimecode(currentTime)} <span className="text-zinc-600">/</span>{' '}
                <span className="text-zinc-400">{formatTimecode(effectiveDuration)}</span>
              </div>

              <span
                className={`hidden md:inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono border ${
                  isOrigAudioAudible
                    ? 'bg-emerald-500/15 border-emerald-500/35 text-emerald-300'
                    : 'bg-zinc-900 border-white/[0.08] text-zinc-400'
                }`}
                title="Original video audio track status (controlled in Audio Mixer)"
              >
                {isOrigAudioAudible ? 'Orig Audio: On' : 'Orig Audio: Muted'}
              </span>
            </div>

            <div className="flex items-center gap-3">
              <span
                className="px-2 py-0.5 rounded bg-zinc-800/90 border border-white/[0.08] text-[11px] font-mono text-zinc-200 tabular-nums"
                title="Video clip speed is independent; narration & audio tracks always play at 1.0x"
              >
                Clip {activeVideoSpeed}x · Audio 1.0x
              </span>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setMuted(!muted)}
                  className="p-1.5 text-zinc-300 hover:text-white cursor-pointer"
                  aria-label={muted ? 'Unmute master output' : 'Mute master output'}
                >
                  {muted || volume === 0 ? (
                    <VolumeX className="w-4 h-4" />
                  ) : (
                    <Volume2 className="w-4 h-4" />
                  )}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={muted ? 0 : volume}
                  onChange={(e) => {
                    setMuted(false);
                    setVolume(Number(e.target.value));
                  }}
                  className="w-16 sm:w-20 accent-violet-500 h-1 bg-zinc-800 rounded cursor-pointer"
                  aria-label="Master Volume"
                />
              </div>

              <button
                type="button"
                onClick={toggleFullscreen}
                className="p-1.5 text-zinc-400 hover:text-white cursor-pointer"
                aria-label="Toggle fullscreen"
              >
                <Maximize2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
