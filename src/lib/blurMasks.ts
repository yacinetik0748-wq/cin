import {
  BlurEffect,
  CaptionSegment,
  DEFAULT_VIDEO_CANVAS,
  DetectedSubtitleRegion,
  Project,
  VideoCanvasConfig,
  VideoExtensionHold,
} from '../types/studio';
import { getSyncedCaptionsForPreview } from './workflowStages';

export function resolveCanvasCropPct(
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

export interface BlurTimeInterval {
  start: number;
  end: number;
  segmentId?: string;
}

export interface NormalizedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VideoFrameStageGeometry {
  /** Uncropped full source video frame mapped into stage [0..1] x [0..1] */
  vx: number;
  vy: number;
  vw: number;
  vh: number;
  /** Visible (clipped) video box in stage [0..1] x [0..1] */
  visX: number;
  visY: number;
  visW: number;
  visH: number;
  flipH: boolean;
  flipV: boolean;
  videoRotation: number;
}

export function clampNormBox(box: NormalizedBox, minW = 0.03, minH = 0.025): NormalizedBox {
  const width = Math.max(minW, Math.min(1, Number(box.width) || minW));
  const height = Math.max(minH, Math.min(1, Number(box.height) || minH));
  const x = Math.max(0, Math.min(1 - width, Number(box.x) || 0));
  const y = Math.max(0, Math.min(1 - height, Number(box.y) || 0));
  return {
    x: Number(x.toFixed(4)),
    y: Number(y.toFixed(4)),
    width: Number(width.toFixed(4)),
    height: Number(height.toFixed(4)),
  };
}

function mapOriginalTimestampWithHolds(t: number, holds: VideoExtensionHold[]): number {
  if (!holds || holds.length === 0) return t;
  const sorted = [...holds].sort((a, b) => a.atVideoTime - b.atVideoTime);
  let shift = 0;
  for (const h of sorted) {
    if (t >= h.atVideoTime - 0.001) {
      shift += Math.max(0, h.holdDuration);
    }
  }
  return t + shift;
}

function mergeIntervals(intervals: BlurTimeInterval[], gapTol = 0.04): BlurTimeInterval[] {
  if (intervals.length <= 1) return intervals;
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out: BlurTimeInterval[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const prev = out[out.length - 1];
    if (cur.start <= prev.end + gapTol) {
      prev.end = Math.max(prev.end, cur.end);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

/**
 * Resolves exact active time intervals for any BlurEffect without ever mutating
 * captions, voiceover timing, or video duration.
 */
export function resolveBlurIntervals(
  blur: BlurEffect,
  project: Project,
  options?: {
    syncedCaptionsOverride?: Array<{ id: string; syncedStart: number; syncedEnd: number }>;
    holdsOverride?: VideoExtensionHold[];
  }
): BlurTimeInterval[] {
  const link = blur.subtitleLink;
  if (!link || link.mode === 'manual') {
    const s = Math.max(0, Number(blur.startTime) || 0);
    const e = Math.max(s + 0.1, Number(blur.endTime) || s + 0.1);
    return [{ start: s, end: e }];
  }

  const captions = project.captions || [];
  if (link.mode === 'original') {
    const holds =
      options?.holdsOverride ??
      (project.voice?.enabled && project.voice.syncPlan?.holds?.length
        ? project.voice.syncPlan.holds
        : []);
    const targets: CaptionSegment[] =
      link.followAllCaptions || !link.segmentId
        ? captions
        : captions.filter((c) => c.id === link.segmentId);

    const raw = targets
      .map((seg) => {
        const s = Math.max(0, mapOriginalTimestampWithHolds(seg.start, holds));
        const e = Math.max(s + 0.1, mapOriginalTimestampWithHolds(seg.end, holds));
        return { start: Number(s.toFixed(3)), end: Number(e.toFixed(3)), segmentId: seg.id };
      })
      .filter((iv) => iv.end > iv.start);
    return mergeIntervals(raw, link.followAllCaptions ? 0.04 : 0);
  }

  // link.mode === 'translated'
  const syncedList =
    options?.syncedCaptionsOverride ??
    getSyncedCaptionsForPreview(project).map((c) => ({
      id: c.id,
      syncedStart: c.syncedStart,
      syncedEnd: c.syncedEnd,
    }));

  const targets =
    link.followAllCaptions || !link.segmentId
      ? syncedList
      : syncedList.filter((c) => c.id === link.segmentId);

  const raw = targets
    .map((seg) => {
      const s = Math.max(0, Number(seg.syncedStart));
      const e = Math.max(s + 0.1, Number(seg.syncedEnd));
      return { start: Number(s.toFixed(3)), end: Number(e.toFixed(3)), segmentId: seg.id };
    })
    .filter((iv) => iv.end > iv.start);

  return mergeIntervals(raw, link.followAllCaptions ? 0.04 : 0);
}

export function isBlurActiveAtTime(
  blur: BlurEffect,
  time: number,
  project: Project,
  syncedCaptionsOverride?: Array<{ id: string; syncedStart: number; syncedEnd: number }>
): boolean {
  if (!blur.enabled) return false;
  const intervals = resolveBlurIntervals(blur, project, { syncedCaptionsOverride });
  return intervals.some((iv) => time >= iv.start - 0.015 && time <= iv.end + 0.015);
}

export function getBlurTimelineSpan(
  blur: BlurEffect,
  project: Project,
  syncedCaptionsOverride?: Array<{ id: string; syncedStart: number; syncedEnd: number }>
): { startTime: number; endTime: number; intervals: BlurTimeInterval[] } {
  const intervals = resolveBlurIntervals(blur, project, { syncedCaptionsOverride });
  if (intervals.length === 0) {
    return {
      startTime: Math.max(0, blur.startTime),
      endTime: Math.max(blur.startTime + 0.1, blur.endTime),
      intervals: [],
    };
  }
  return {
    startTime: intervals[0].start,
    endTime: intervals[intervals.length - 1].end,
    intervals,
  };
}

function getEffectiveStageRatio(
  canvas: VideoCanvasConfig,
  aspectRatio: Project['exportSettings']['aspectRatio'],
  aspectPreviewMode: 'original' | 'export',
  srcW: number,
  srcH: number
): { ratioW: number; ratioH: number; effAspect: Project['exportSettings']['aspectRatio'] } {
  const effAspect =
    canvas.aspectRatio && canvas.aspectRatio !== 'original' ? canvas.aspectRatio : aspectRatio;
  if (aspectPreviewMode === 'original' || effAspect === 'original') {
    return { ratioW: srcW, ratioH: srcH, effAspect };
  }
  if (effAspect === '9:16') return { ratioW: 9, ratioH: 16, effAspect };
  if (effAspect === '4:5') return { ratioW: 4, ratioH: 5, effAspect };
  if (effAspect === '3:4') return { ratioW: 3, ratioH: 4, effAspect };
  if (effAspect === '1:1') return { ratioW: 1, ratioH: 1, effAspect };
  if (effAspect === 'custom') {
    return {
      ratioW: Math.max(240, canvas.customWidth || 1080),
      ratioH: Math.max(240, canvas.customHeight || 1920),
      effAspect,
    };
  }
  return { ratioW: 16, ratioH: 9, effAspect };
}

/**
 * Computes exact normalized [0..1] geometry of the source video frame inside
 * the stage canvas, matching VideoStudioPlayer.tsx & video_render_service.ts.
 */
export function getVideoFrameStageGeometry(
  project: Project,
  aspectPreviewMode: 'original' | 'export',
  srcW: number,
  srcH: number,
  options?: { isExport?: boolean; hasCustomCanvasOverride?: boolean }
): VideoFrameStageGeometry {
  const canvas: VideoCanvasConfig = { ...DEFAULT_VIDEO_CANVAS, ...(project.canvas || {}) };
  const safeSrcW = Math.max(16, srcW || project.metadata?.width || 1280);
  const safeSrcH = Math.max(16, srcH || project.metadata?.height || 720);
  const cropMode = canvas.cropMode || 'fit';
  const cropRect = resolveCanvasCropPct(canvas, safeSrcW, safeSrcH);
  const { ratioW, ratioH, effAspect } = getEffectiveStageRatio(
    canvas,
    project.exportSettings.aspectRatio,
    aspectPreviewMode,
    safeSrcW,
    safeSrcH
  );
  const canvasAR = ratioW / Math.max(1, ratioH);
  const srcAR = safeSrcW / Math.max(1, safeSrcH);

  const hasCustomCanvas =
    options?.hasCustomCanvasOverride !== undefined
      ? options.hasCustomCanvasOverride
      : canvas.aspectRatio !== 'original' ||
        cropMode !== 'fit' ||
        Math.abs((canvas.zoom || 1) - 1) > 0.005 ||
        Math.abs(canvas.offsetX || 0) > 0.1 ||
        Math.abs(canvas.offsetY || 0) > 0.1 ||
        Math.abs(canvas.videoRotation || 0) > 0.2 ||
        Boolean(canvas.flipH) ||
        Boolean(canvas.flipV) ||
        (canvas.videoOpacity ?? 1) < 0.99 ||
        canvas.videoVisible === false ||
        cropRect.top > 0 ||
        cropRect.right > 0 ||
        cropRect.bottom > 0 ||
        cropRect.left > 0 ||
        Boolean(canvas.cropWidth && canvas.cropHeight) ||
        canvas.backgroundType !== 'solid' ||
        (canvas.bgColor || '#09090B').toUpperCase() !== '#09090B';

  if (!hasCustomCanvas) {
    if (aspectPreviewMode === 'original' || effAspect === 'original') {
      return {
        vx: 0,
        vy: 0,
        vw: 1,
        vh: 1,
        visX: 0,
        visY: 0,
        visW: 1,
        visH: 1,
        flipH: false,
        flipV: false,
        videoRotation: 0,
      };
    }

    // Simple fitMode: 'crop' -> cover, 'letterbox' | 'blur-pad' -> contain
    let vw = 1;
    let vh = 1;
    if (project.exportSettings.fitMode === 'crop') {
      if (srcAR > canvasAR) {
        vh = 1;
        vw = srcAR / canvasAR;
      } else {
        vw = 1;
        vh = canvasAR / srcAR;
      }
    } else {
      if (srcAR > canvasAR) {
        vw = 1;
        vh = canvasAR / srcAR;
      } else {
        vh = 1;
        vw = srcAR / canvasAR;
      }
    }
    const vx = (1 - vw) / 2;
    const vy = (1 - vh) / 2;
    return {
      vx,
      vy,
      vw,
      vh,
      visX: Math.max(0, vx),
      visY: Math.max(0, vy),
      visW: Math.min(1, vw),
      visH: Math.min(1, vh),
      flipH: false,
      flipV: false,
      videoRotation: 0,
    };
  }

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
    if (srcAR > canvasAR) {
      const keepW = (safeSrcH * canvasAR) / safeSrcW;
      const trimPct = Math.max(0, ((1 - keepW) / 2) * 100);
      effLeft = trimPct;
      effRight = trimPct;
    } else if (srcAR < canvasAR) {
      const keepH = safeSrcW / canvasAR / safeSrcH;
      const trimTotal = Math.max(0, (1 - keepH) * 100);
      effTop = trimTotal * 0.35;
      effBottom = trimTotal * 0.65;
    }
  }

  const cropScaleX = Math.max(0.1, 1 - (effLeft + effRight) / 100);
  const cropScaleY = Math.max(0.1, 1 - (effTop + effBottom) / 100);
  const croppedAR = (safeSrcW * cropScaleX) / Math.max(1, safeSrcH * cropScaleY);

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

  const zoom = Math.max(0.25, Math.min(3.0, canvas.zoom || 1));
  const fgW = fitW * zoom;
  const fgH = fitH * zoom;
  const fgLeft = 50 + (canvas.offsetX || 0) - fgW / 2;
  const fgTop = 50 + (canvas.offsetY || 0) - fgH / 2;

  const visX = fgLeft / 100;
  const visY = fgTop / 100;
  const visW = fgW / 100;
  const visH = fgH / 100;

  const vw = visW / cropScaleX;
  const vh = visH / cropScaleY;
  const vx = visX - (effLeft / 100) * vw;
  const vy = visY - (effTop / 100) * vh;

  return {
    vx,
    vy,
    vw,
    vh,
    visX,
    visY,
    visW,
    visH,
    flipH: Boolean(canvas.flipH),
    flipV: Boolean(canvas.flipV),
    videoRotation: canvas.videoRotation || 0,
  };
}

/**
 * Maps a normalized box in video-frame space [0..1] -> stage space [0..1],
 * applying flip & video rotation around the visible video frame center.
 */
export function videoBoxToStageBox(
  box: NormalizedBox,
  geom: VideoFrameStageGeometry
): { x: number; y: number; width: number; height: number; extraRotation: number } {
  let sx = geom.vx + box.x * geom.vw;
  let sy = geom.vy + box.y * geom.vh;
  const sw = box.width * geom.vw;
  const sh = box.height * geom.vh;

  if (geom.flipH) {
    const centerX = geom.visX + geom.visW / 2;
    sx = 2 * centerX - (sx + sw);
  }
  if (geom.flipV) {
    const centerY = geom.visY + geom.visH / 2;
    sy = 2 * centerY - (sy + sh);
  }

  if (Math.abs(geom.videoRotation) > 0.2) {
    const cx = geom.visX + geom.visW / 2;
    const cy = geom.visY + geom.visH / 2;
    const bx = sx + sw / 2 - cx;
    const by = sy + sh / 2 - cy;
    const rad = (geom.videoRotation * Math.PI) / 180;
    const rx = bx * Math.cos(rad) - by * Math.sin(rad);
    const ry = bx * Math.sin(rad) + by * Math.cos(rad);
    sx = cx + rx - sw / 2;
    sy = cy + ry - sh / 2;
  }

  return {
    x: sx,
    y: sy,
    width: sw,
    height: sh,
    extraRotation: geom.videoRotation || 0,
  };
}

/**
 * Inverse-maps a stage-space normalized box [0..1] -> video-frame normalized space [0..1].
 */
export function stageBoxToVideoBox(
  stageBox: NormalizedBox,
  geom: VideoFrameStageGeometry
): NormalizedBox {
  let sx = stageBox.x;
  let sy = stageBox.y;
  const sw = stageBox.width;
  const sh = stageBox.height;

  if (Math.abs(geom.videoRotation) > 0.2) {
    const cx = geom.visX + geom.visW / 2;
    const cy = geom.visY + geom.visH / 2;
    const bx = sx + sw / 2 - cx;
    const by = sy + sh / 2 - cy;
    const rad = (-geom.videoRotation * Math.PI) / 180;
    const rx = bx * Math.cos(rad) - by * Math.sin(rad);
    const ry = bx * Math.sin(rad) + by * Math.cos(rad);
    sx = cx + rx - sw / 2;
    sy = cy + ry - sh / 2;
  }

  if (geom.flipH) {
    const centerX = geom.visX + geom.visW / 2;
    sx = 2 * centerX - (sx + sw);
  }
  if (geom.flipV) {
    const centerY = geom.visY + geom.visH / 2;
    sy = 2 * centerY - (sy + sh);
  }

  return clampNormBox({
    x: (sx - geom.vx) / Math.max(0.05, geom.vw),
    y: (sy - geom.vy) / Math.max(0.05, geom.vh),
    width: sw / Math.max(0.05, geom.vw),
    height: sh / Math.max(0.05, geom.vh),
  });
}

/**
 * Maps a BlurEffect (either `video` or legacy `stage` coordSpace) into
 * normalized export canvas coordinates [0..1] clipped to the export canvas.
 */
export function mapBlurToExportCanvasNormalized(
  blur: BlurEffect,
  project: Project,
  srcW: number,
  srcH: number,
  options?: { hasCustomCanvasOverride?: boolean }
): {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  visible: boolean;
} {
  if (blur.coordSpace !== 'video') {
    const clamped = clampNormBox(
      { x: blur.x, y: blur.y, width: blur.width, height: blur.height },
      0.02,
      0.02
    );
    return { ...clamped, rotation: blur.rotation || 0, visible: true };
  }

  const geom = getVideoFrameStageGeometry(project, 'export', srcW, srcH, {
    isExport: true,
    hasCustomCanvasOverride: options?.hasCustomCanvasOverride,
  });
  const mapped = videoBoxToStageBox(
    { x: blur.x, y: blur.y, width: blur.width, height: blur.height },
    geom
  );

  // Clip against stage bounds [0..1] x [0..1]
  const x0 = Math.max(0, mapped.x);
  const y0 = Math.max(0, mapped.y);
  const x1 = Math.min(1, mapped.x + mapped.width);
  const y1 = Math.min(1, mapped.y + mapped.height);
  const cw = x1 - x0;
  const ch = y1 - y0;
  if (cw < 0.015 || ch < 0.015) {
    return { x: 0, y: 0, width: 0.02, height: 0.02, rotation: 0, visible: false };
  }

  return {
    x: x0,
    y: y0,
    width: cw,
    height: ch,
    rotation: (blur.rotation || 0) + mapped.extraRotation,
    visible: true,
  };
}

export function createSubtitleBlurMask(params: {
  id: string;
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  startTime: number;
  endTime: number;
  band?: 'bottom' | 'top' | 'middle';
  blurType?: BlurEffect['type'];
  intensity?: number;
  opacity?: number;
  feather?: number;
  borderRadius?: number;
  subtitleLink?: BlurEffect['subtitleLink'];
  detectionMeta?: BlurEffect['detectionMeta'];
}): BlurEffect {
  const band = params.band ?? 'bottom';
  const defaultBox =
    band === 'top'
      ? { x: 0.14, y: 0.06, width: 0.72, height: 0.12 }
      : band === 'middle'
      ? { x: 0.14, y: 0.44, width: 0.72, height: 0.12 }
      : { x: 0.12, y: 0.78, width: 0.76, height: 0.14 };

  const clamped = clampNormBox({
    x: params.x ?? defaultBox.x,
    y: params.y ?? defaultBox.y,
    width: params.width ?? defaultBox.width,
    height: params.height ?? defaultBox.height,
  });

  const intensity = Math.max(3, Math.min(45, params.intensity ?? 26));
  const startTime = Math.max(0, Number(params.startTime.toFixed(2)));
  const endTime = Math.max(startTime + 0.15, Number(params.endTime.toFixed(2)));

  return {
    id: params.id,
    name: params.name || `Caption Mask (${band})`,
    mode: 'selective',
    type: params.blurType ?? 'gaussian',
    enabled: true,
    intensity,
    radius: intensity,
    opacity: params.opacity ?? 1.0,
    feather: params.feather ?? 10,
    borderRadius: params.borderRadius ?? 8,
    rotation: 0,
    locked: false,
    startTime,
    endTime,
    ...clamped,
    shape: 'rect',
    coordSpace: 'video',
    isSubtitleMask: true,
    subtitleLink: params.subtitleLink ?? { mode: 'manual' },
    detectionMeta: params.detectionMeta,
  };
}

export function detectedRegionToBlurMask(
  region: DetectedSubtitleRegion,
  maskId: string,
  indexLabel?: number,
  subtitleLink?: BlurEffect['subtitleLink']
): BlurEffect {
  const bandLabel =
    region.band === 'top' ? 'Top' : region.band === 'middle' ? 'Middle' : 'Bottom';
  const suffix = indexLabel !== undefined ? ` #${indexLabel}` : '';
  return createSubtitleBlurMask({
    id: maskId,
    name: `Caption Mask · ${bandLabel}${suffix}`,
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
    startTime: region.startTime,
    endTime: region.endTime,
    band: region.band,
    blurType: 'strong',
    intensity: 28,
    opacity: 1,
    feather: 10,
    borderRadius: 8,
    subtitleLink: subtitleLink ?? { mode: 'manual' },
    detectionMeta: {
      band: region.band,
      detectedText: region.detectedText,
      confidence: region.confidence,
      method: region.method,
      framesMatched: region.framesMatched,
    },
  });
}
