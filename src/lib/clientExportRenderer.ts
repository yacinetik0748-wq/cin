import { FFmpeg } from '@ffmpeg/ffmpeg';
import {
  BlurEffect,
  DEFAULT_VIDEO_CANVAS,
  LogoMotionConfig,
  LogoOverlay,
  OriginalAudioClip,
  Project,
  TrackingKeyframe,
  VideoClip,
  VideoExtensionHold,
  VoiceConfig,
} from '../types/studio';
import {
  clampVideoSpeed,
  getEffectiveBgmClips,
  getEffectiveOriginalAudioClips,
  getEffectiveSfxClips,
  getEffectiveVideoClips,
  getOriginalAudioClipTimelineEnd,
  getTimelineAudioClipEnd,
  getVideoClipTimelineDuration,
  getVideoTimelineTotalDuration,
  hasCustomVideoEdits,
} from './videoTimeline';
import { resolveCanvasDimensions } from './workflowStages';
import { mapBlurToExportCanvasNormalized, resolveBlurIntervals } from './blurMasks';
import { buildAssContent } from './subtitleAss';
import { buildVideoEffectsFilters } from '../../server/services/video_effects_service';
import {
  buildAudioHoldFilter,
  buildSyncedCaptionsForRender,
  buildVideoFrameHoldFilter,
  remapBlursForSyncPlan,
  remapLogosForSyncPlan,
} from '../../server/services/timeline_sync_service';
import { resolveMediaBlob, safeDeleteMemfsFile, withFFmpegLock } from './clientMediaEngine';
import { retrieveProjectVideoBlob } from './browserStorage';

interface MemfsBlurOverride {
  mappedRect?: {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation?: number;
    visible?: boolean;
  };
  intervals?: Array<{ start: number; end: number }>;
}

function resolveSourceCropRect(
  srcW: number,
  srcH: number,
  canvas: typeof DEFAULT_VIDEO_CANVAS
): { cx: number; cy: number; cw: number; ch: number } {
  if (
    canvas.cropWidth &&
    canvas.cropHeight &&
    canvas.cropWidth >= 16 &&
    canvas.cropHeight >= 16
  ) {
    const cw = Math.max(16, Math.min(srcW, Math.round(canvas.cropWidth) & ~1));
    const ch = Math.max(16, Math.min(srcH, Math.round(canvas.cropHeight) & ~1));
    const cx = Math.max(0, Math.min(srcW - cw, Math.round(canvas.cropX || 0)));
    const cy = Math.max(0, Math.min(srcH - ch, Math.round(canvas.cropY || 0)));
    return { cx, cy, cw, ch };
  }

  const cropLeft = Math.max(0, Math.min(45, canvas.cropLeft || 0));
  const cropRight = Math.max(0, Math.min(45, canvas.cropRight || 0));
  const cropTop = Math.max(0, Math.min(45, canvas.cropTop || 0));
  const cropBottom = Math.max(0, Math.min(45, canvas.cropBottom || 0));

  const cw = Math.max(16, Math.round(srcW * (1 - (cropLeft + cropRight) / 100)) & ~1);
  const ch = Math.max(16, Math.round(srcH * (1 - (cropTop + cropBottom) / 100)) & ~1);
  const cx = Math.max(0, Math.min(srcW - cw, Math.round((srcW * cropLeft) / 100)));
  const cy = Math.max(0, Math.min(srcH - ch, Math.round((srcH * cropTop) / 100)));
  return { cx, cy, cw, ch };
}

function buildPiecewiseExpr(
  keyframes: TrackingKeyframe[],
  accessor: (k: TrackingKeyframe) => number,
  scaleFactor: number
): string {
  if (keyframes.length === 0) return '0';
  if (keyframes.length === 1) return String(Math.round(accessor(keyframes[0]) * scaleFactor));
  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  let expr = String(Math.round(accessor(sorted[sorted.length - 1]) * scaleFactor));
  for (let i = sorted.length - 2; i >= 0; i--) {
    const k0 = sorted[i];
    const k1 = sorted[i + 1];
    const t0 = k0.time.toFixed(3);
    const t1 = k1.time.toFixed(3);
    const dt = Math.max(0.01, k1.time - k0.time).toFixed(3);
    const v0 = Math.round(accessor(k0) * scaleFactor);
    const v1 = Math.round(accessor(k1) * scaleFactor);
    const interp = `${v0}+(${v1}-${v0})*(t-${t0})/${dt}`;
    expr =
      i === 0
        ? `if(lt(t,${t0}),${v0},if(lt(t,${t1}),${interp},${expr}))`
        : `if(lt(t,${t1}),${interp},${expr})`;
  }
  return expr;
}

function makeBlurExpr(blur: BlurEffect, targetWidth?: number, targetHeight?: number): string {
  const sigma = Math.max(1, Math.min(45, blur.radius || blur.intensity || 15));
  if (blur.type === 'strong') {
    const strongSigma = Math.max(24, Math.min(85, Math.round(sigma * 2.35)));
    return `gblur=sigma=${strongSigma}:steps=3`;
  }
  if (blur.type === 'box') {
    const r = Math.max(1, Math.min(30, Math.round(sigma * 0.75)));
    return `boxblur=${r}:2`;
  }
  if (blur.type === 'pixelate') {
    const factor = Math.max(4, Math.min(40, Math.round(sigma * 0.9)));
    const restore =
      targetWidth && targetHeight
        ? `scale=${targetWidth}:${targetHeight}:flags=neighbor`
        : `scale=iw*${factor}:ih*${factor}:flags=neighbor`;
    return `scale=max(2\\,trunc(iw/${factor})):max(2\\,trunc(ih/${factor})):flags=neighbor,${restore}`;
  }
  return `gblur=sigma=${sigma}`;
}

function buildBlurEnableExpr(
  blur: BlurEffect,
  intervals?: Array<{ start: number; end: number }>
): string {
  const list =
    intervals && intervals.length > 0
      ? intervals
      : [{ start: Math.max(0, blur.startTime), end: Math.max(blur.startTime + 0.1, blur.endTime) }];
  return list
    .map((iv) => `between(t,${Math.max(0, iv.start).toFixed(3)},${Math.max(iv.start + 0.08, iv.end).toFixed(3)})`)
    .join('+');
}

function buildMaskAlphaFilter(blur: BlurEffect, patchW?: number, patchH?: number): string {
  const opacity = Math.max(0.05, Math.min(1, blur.opacity ?? 1));
  const opacityInt = Math.round(opacity * 255);
  const needsEllipse = blur.shape === 'ellipse';
  const featherPct = Math.max(0, Math.min(0.45, (blur.feather ?? (needsEllipse ? 12 : 4)) / 100));
  const radiusRaw = Math.max(0, Math.min(48, Number(blur.borderRadius ?? 0)));

  if (!needsEllipse && featherPct <= 0.005 && radiusRaw <= 0.5) {
    return opacity < 0.99 ? `,format=rgba,colorchannelmixer=aa=${opacity.toFixed(2)}` : '';
  }
  if (needsEllipse) {
    const inner = Math.max(0.55, 1.0 - featherPct * 1.4).toFixed(3);
    const span = Math.max(0.05, 1.0 - Number(inner)).toFixed(3);
    return `,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(hypot((X-W/2)/(W/2),(Y-H/2)/(H/2)),${inner}),${opacityInt},if(gte(hypot((X-W/2)/(W/2),(Y-H/2)/(H/2)),1.0),0,round(${opacityInt}*(1.0-(hypot((X-W/2)/(W/2),(Y-H/2)/(H/2))-${inner})/${span}))))'`;
  }

  const w = Math.max(16, patchW || 200);
  const h = Math.max(16, patchH || 100);
  const rPx = Math.min(Math.floor(Math.min(w, h) / 2) - 1, Math.round(radiusRaw));
  const fPx = Math.max(0, Math.round(Math.min(w, h) * featherPct));

  if (rPx <= 0) {
    const fRatio = featherPct.toFixed(3);
    return `,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='round(${opacityInt}*min(1,min(min(X,W-1-X)/max(1,W*${fRatio}),min(Y,H-1-Y)/max(1,H*${fRatio}))))'`;
  }
  const cx = ((w - 1) / 2).toFixed(2);
  const cy = ((h - 1) / 2).toFixed(2);
  const bx = Math.max(0, (w - 1) / 2 - rPx).toFixed(2);
  const by = Math.max(0, (h - 1) / 2 - rPx).toFixed(2);
  const sdf = `(hypot(max(abs(X-${cx})-${bx},0),max(abs(Y-${cy})-${by},0))+min(max(abs(X-${cx})-${bx},abs(Y-${cy})-${by}),0)-${rPx})`;
  if (fPx <= 1) {
    return `,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(${sdf},0),${opacityInt},0)'`;
  }
  return `,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='round(${opacityInt}*clip(-(${sdf})/${fPx},0,1))'`;
}

function buildBlurFiltersMemfs(params: {
  blurs: BlurEffect[];
  startLabel: string;
  targetWidth: number;
  targetHeight: number;
  nextInputIndex: number;
  labelPrefix: string;
  overrides: Record<string, MemfsBlurOverride>;
  memfsPaths: Map<string, string>;
}): {
  extraInputs: string[];
  filterSteps: string[];
  currentLabel: string;
  nextInputIndex: number;
} {
  const extraInputs: string[] = [];
  const filterSteps: string[] = [];
  let currentLabel = params.startLabel;
  let inputIdx = params.nextInputIndex;
  let stepCounter = 0;
  const pfx = params.labelPrefix;

  for (const blur of params.blurs.filter((b) => b.enabled)) {
    const ov = params.overrides[blur.id];
    if (ov?.mappedRect?.visible === false) continue;
    if (ov?.intervals && ov.intervals.length === 0) continue;

    const enableExpr = buildBlurEnableExpr(blur, ov?.intervals);
    const opacity = Math.max(0.05, Math.min(1, blur.opacity ?? 1));
    const opacityStr = opacity.toFixed(2);
    stepCounter += 1;

    if (blur.mode === 'full') {
      const out = `${pfx}_full_${stepCounter}`;
      if (blur.type === 'pixelate' || opacity < 0.99) {
        const base = `${pfx}_fbase_${stepCounter}`;
        const blurSrc = `${pfx}_fsrc_${stepCounter}`;
        const blurOut = `${pfx}_fout_${stepCounter}`;
        filterSteps.push(`[${currentLabel}]split[${base}][${blurSrc}]`);
        const alphaStep = opacity < 0.99 ? `,format=rgba,colorchannelmixer=aa=${opacityStr}` : '';
        filterSteps.push(
          `[${blurSrc}]${makeBlurExpr(blur, params.targetWidth, params.targetHeight)}${alphaStep}[${blurOut}]`
        );
        filterSteps.push(`[${base}][${blurOut}]overlay=0:0:enable='${enableExpr}'[${out}]`);
      } else {
        filterSteps.push(
          `[${currentLabel}]${makeBlurExpr(blur, params.targetWidth, params.targetHeight)}:enable='${enableExpr}'[${out}]`
        );
      }
      currentLabel = out;
    } else if (blur.mode === 'selective') {
      const srcBox = ov?.mappedRect ?? {
        x: blur.x,
        y: blur.y,
        width: blur.width,
        height: blur.height,
        rotation: blur.rotation,
      };
      const rx = Math.max(0, Math.min(0.97, srcBox.x));
      const ry = Math.max(0, Math.min(0.97, srcBox.y));
      const rw = Math.max(0.02, Math.min(1 - rx, srcBox.width));
      const rh = Math.max(0.02, Math.min(1 - ry, srcBox.height));

      const pw = Math.min(params.targetWidth, Math.max(16, Math.round(rw * params.targetWidth) & ~1));
      const ph = Math.min(params.targetHeight, Math.max(16, Math.round(rh * params.targetHeight) & ~1));
      const px = Math.max(0, Math.min(params.targetWidth - pw, Math.round(rx * params.targetWidth)));
      const py = Math.max(0, Math.min(params.targetHeight - ph, Math.round(ry * params.targetHeight)));

      const base = `${pfx}_base_${stepCounter}`;
      const cropSrc = `${pfx}_csrc_${stepCounter}`;
      const cropped = `${pfx}_crop_${stepCounter}`;
      const out = `${pfx}_sel_${stepCounter}`;
      const maskStep = buildMaskAlphaFilter(blur, pw, ph);
      const rotDeg = srcBox.rotation ?? blur.rotation ?? 0;
      const rotStep =
        Math.abs(rotDeg) > 0.2
          ? `,rotate=${((rotDeg * Math.PI) / 180).toFixed(4)}:ow='rotw(${((rotDeg * Math.PI) / 180).toFixed(4)})':oh='roth(${((rotDeg * Math.PI) / 180).toFixed(4)})':c=none`
          : '';
      const overlayX = Math.abs(rotDeg) > 0.2 ? `${px}+(${pw}-w)/2` : String(px);
      const overlayY = Math.abs(rotDeg) > 0.2 ? `${py}+(${ph}-h)/2` : String(py);

      filterSteps.push(`[${currentLabel}]split[${base}][${cropSrc}]`);
      filterSteps.push(
        `[${cropSrc}]crop=${pw}:${ph}:${px}:${py},${makeBlurExpr(blur, pw, ph)}${maskStep}${rotStep}[${cropped}]`
      );
      filterSteps.push(`[${base}][${cropped}]overlay=x='${overlayX}':y='${overlayY}':enable='${enableExpr}'[${out}]`);
      currentLabel = out;
    } else if (blur.mode === 'motion') {
      const kfs =
        blur.keyframes && blur.keyframes.length > 0
          ? blur.keyframes
          : [{ time: blur.startTime, x: blur.x, y: blur.y, width: blur.width, height: blur.height }];
      const pw = Math.min(params.targetWidth, Math.max(24, Math.round((kfs[0].width || blur.width) * params.targetWidth) & ~1));
      const ph = Math.min(params.targetHeight, Math.max(24, Math.round((kfs[0].height || blur.height) * params.targetHeight) & ~1));
      const xExpr = buildPiecewiseExpr(kfs, (k) => Math.max(0, Math.min(1 - k.width, k.x)), params.targetWidth);
      const yExpr = buildPiecewiseExpr(kfs, (k) => Math.max(0, Math.min(1 - k.height, k.y)), params.targetHeight);
      const base = `${pfx}_mbase_${stepCounter}`;
      const fullBlur = `${pfx}_mblur_${stepCounter}`;
      const cropBox = `${pfx}_mcrop_${stepCounter}`;
      const out = `${pfx}_mot_${stepCounter}`;
      const maskStep = buildMaskAlphaFilter(blur, pw, ph);

      filterSteps.push(`[${currentLabel}]split[${base}][${fullBlur}]`);
      filterSteps.push(
        `[${fullBlur}]${makeBlurExpr(blur, params.targetWidth, params.targetHeight)},crop=w=${pw}:h=${ph}:x='max(0,min(iw-${pw},${xExpr}))':y='max(0,min(ih-${ph},${yExpr}))'${maskStep}[${cropBox}]`
      );
      filterSteps.push(
        `[${base}][${cropBox}]overlay=x='max(0,min(W-${pw},${xExpr}))':y='max(0,min(H-${ph},${yExpr}))':enable='${enableExpr}'[${out}]`
      );
      currentLabel = out;
    } else if (blur.mode === 'background') {
      const maskPath = blur.maskAssetId ? params.memfsPaths.get(blur.maskAssetId) : undefined;
      const blurFilter = makeBlurExpr(blur, params.targetWidth, params.targetHeight);
      if (maskPath) {
        const maskIdx = inputIdx++;
        extraInputs.push('-loop', '1', '-i', maskPath);
        const bgSrc = `${pfx}_bgsrc_${stepCounter}`;
        const fgSrc = `${pfx}_fgsrc_${stepCounter}`;
        const origRef = `${pfx}_orig_${stepCounter}`;
        const bgBlurred = `${pfx}_bgblur_${stepCounter}`;
        const maskScaled = `${pfx}_mask_${stepCounter}`;
        const fgMasked = `${pfx}_fgmask_${stepCounter}`;
        const bgComp = `${pfx}_bgcomp_${stepCounter}`;
        const out = `${pfx}_bgout_${stepCounter}`;

        filterSteps.push(`[${currentLabel}]split=3[${origRef}][${bgSrc}][${fgSrc}]`);
        filterSteps.push(`[${bgSrc}]${blurFilter}[${bgBlurred}]`);
        filterSteps.push(`[${maskIdx}:v]scale=${params.targetWidth}:${params.targetHeight},format=gray[${maskScaled}]`);
        filterSteps.push(`[${fgSrc}]format=rgba[${fgSrc}_rgba]`);
        filterSteps.push(`[${fgSrc}_rgba][${maskScaled}]alphamerge[${fgMasked}]`);
        filterSteps.push(`[${bgBlurred}][${fgMasked}]overlay=0:0[${bgComp}]`);
        if (opacity < 0.99) {
          filterSteps.push(`[${bgComp}]format=rgba,colorchannelmixer=aa=${opacityStr}[${bgComp}_op]`);
          filterSteps.push(`[${origRef}][${bgComp}_op]overlay=0:0:enable='${enableExpr}'[${out}]`);
        } else {
          filterSteps.push(`[${origRef}][${bgComp}]overlay=0:0:enable='${enableExpr}'[${out}]`);
        }
        currentLabel = out;
      } else {
        const cx = Math.round(params.targetWidth * 0.25);
        const cy = Math.round(params.targetHeight * 0.12);
        const cw = Math.round(params.targetWidth * 0.5) & ~1;
        const ch = Math.round(params.targetHeight * 0.76) & ~1;
        const bgSrc = `${pfx}_bgsrc_${stepCounter}`;
        const fgSrc = `${pfx}_fgsrc_${stepCounter}`;
        const origRef = `${pfx}_orig_${stepCounter}`;
        const bgBlurred = `${pfx}_bgblur_${stepCounter}`;
        const fgCropped = `${pfx}_fgcrop_${stepCounter}`;
        const bgComp = `${pfx}_bgcomp_${stepCounter}`;
        const out = `${pfx}_bgout_${stepCounter}`;

        filterSteps.push(`[${currentLabel}]split=3[${origRef}][${bgSrc}][${fgSrc}]`);
        filterSteps.push(`[${bgSrc}]${blurFilter}[${bgBlurred}]`);
        filterSteps.push(`[${fgSrc}]crop=${cw}:${ch}:${cx}:${cy}[${fgCropped}]`);
        filterSteps.push(`[${bgBlurred}][${fgCropped}]overlay=${cx}:${cy}[${bgComp}]`);
        if (opacity < 0.99) {
          filterSteps.push(`[${bgComp}]format=rgba,colorchannelmixer=aa=${opacityStr}[${bgComp}_op]`);
          filterSteps.push(`[${origRef}][${bgComp}_op]overlay=0:0:enable='${enableExpr}'[${out}]`);
        } else {
          filterSteps.push(`[${origRef}][${bgComp}]overlay=0:0:enable='${enableExpr}'[${out}]`);
        }
        currentLabel = out;
      }
    }
  }

  return { extraInputs, filterSteps, currentLabel, nextInputIndex: inputIdx };
}

function buildMotionExprs(
  m: LogoMotionConfig | undefined,
  px: number,
  py: number,
  targetWidth: number,
  targetHeight: number
): { xExpr: string; yExpr: string } {
  if (!m || !m.enabled || m.pattern === 'static') {
    return { xExpr: String(px), yExpr: String(py) };
  }
  const speed = Math.max(0.2, Math.min(3.0, m.speed || 1));
  if (m.pattern === 'bounce') {
    const vx = Math.round(140 * speed);
    const vy = Math.round(95 * speed);
    return {
      xExpr: `abs(mod(${px}+t*${vx},max(2,2*(W-w)))-max(1,W-w))`,
      yExpr: `abs(mod(${py}+t*${vy},max(2,2*(H-h)))-max(1,H-h))`,
    };
  }
  if (m.pattern === 'horizontal') {
    const vx = Math.round(160 * speed);
    return { xExpr: `abs(mod(${px}+t*${vx},max(2,2*(W-w)))-max(1,W-w))`, yExpr: String(py) };
  }
  if (m.pattern === 'orbit') {
    const radX = Math.round(targetWidth * 0.14);
    const radY = Math.round(targetHeight * 0.12);
    const omega = (1.6 * speed).toFixed(2);
    return {
      xExpr: `max(0,min(W-w,${px}+${radX}*sin(t*${omega})))`,
      yExpr: `max(0,min(H-h,${py}+${radY}*cos(t*${omega})))`,
    };
  }
  if (m.pattern === 'custom') {
    const endX = Math.max(0, Math.round((m.endX ?? 0.75) * targetWidth));
    const endY = Math.max(0, Math.round((m.endY ?? 0.75) * targetHeight));
    const cycle = Math.max(1.5, 6 / speed).toFixed(2);
    const phase = `(1-cos(PI*mod(t,${cycle})/${cycle}))/2`;
    return {
      xExpr: `max(0,min(W-w,${px}+(${endX - px})*${phase}))`,
      yExpr: `max(0,min(H-h,${py}+(${endY - py})*${phase}))`,
    };
  }
  return { xExpr: String(px), yExpr: String(py) };
}

function buildLogoFiltersMemfs(params: {
  logos: LogoOverlay[];
  startLabel: string;
  targetWidth: number;
  targetHeight: number;
  nextInputIndex: number;
  labelPrefix: string;
  memfsPaths: Map<string, string>;
}) {
  const extraInputs: string[] = [];
  const filterSteps: string[] = [];
  let currentLabel = params.startLabel;
  let inputIdx = params.nextInputIndex;
  let counter = 0;
  const pfx = params.labelPrefix;

  for (const logo of params.logos.filter((l) => l.enabled)) {
    const memPath = params.memfsPaths.get(logo.url);
    if (!memPath) continue;
    counter += 1;
    const idx = inputIdx++;
    extraInputs.push('-i', memPath);

    const targetW = Math.max(24, Math.round((logo.widthPct / 100) * params.targetWidth) & ~1);
    const opacity = Math.max(0.05, Math.min(1, logo.opacity)).toFixed(2);
    const px = Math.max(0, Math.round(logo.x * params.targetWidth));
    const py = Math.max(0, Math.round(logo.y * params.targetHeight));
    const { xExpr, yExpr } = buildMotionExprs(logo.motion, px, py, params.targetWidth, params.targetHeight);
    const scaledLogo = `${pfx}_s_${counter}`;
    const out = `${pfx}_out_${counter}`;
    const rotDeg = logo.rotation || 0;
    const rotRad = ((rotDeg * Math.PI) / 180).toFixed(4);
    const rotStep =
      Math.abs(rotDeg) > 0.2
        ? `,rotate=${rotRad}:ow='rotw(${rotRad})':oh='roth(${rotRad})':c=none`
        : '';

    filterSteps.push(
      `[${idx}:v]scale=${targetW}:-1,format=rgba,colorchannelmixer=aa=${opacity}${rotStep}[${scaledLogo}]`
    );
    if (logo.permanent) {
      filterSteps.push(`[${currentLabel}][${scaledLogo}]overlay=x='${xExpr}':y='${yExpr}'[${out}]`);
    } else {
      const s = Math.max(0, logo.startTime).toFixed(2);
      const e = Math.max(logo.startTime + 0.1, logo.endTime).toFixed(2);
      filterSteps.push(
        `[${currentLabel}][${scaledLogo}]overlay=x='${xExpr}':y='${yExpr}':enable='between(t,${s},${e})'[${out}]`
      );
    }
    currentLabel = out;
  }

  return { extraInputs, filterSteps, currentLabel, nextInputIndex: inputIdx };
}

function isOrigAudioActive(voice: VoiceConfig): boolean {
  if (voice.originalAudioRemoved) return false;
  const muted =
    voice.originalAudioMuted !== undefined
      ? Boolean(voice.originalAudioMuted)
      : !Boolean(voice.preserveOriginalAudio);
  const enabled =
    voice.originalAudioEnabled !== undefined
      ? Boolean(voice.originalAudioEnabled)
      : Boolean(voice.preserveOriginalAudio);
  const vol = Math.max(0, Math.min(2.0, Number(voice.originalAudioVolume ?? 1.0)));
  return enabled && !muted && vol > 0.005;
}

function buildAtempoChain(rawSpeed: number): string {
  const spd = clampVideoSpeed(rawSpeed);
  if (Math.abs(spd - 1.0) <= 0.005) return '';
  const stages: string[] = [];
  let rem = spd;
  while (rem > 2.0 + 1e-4) {
    stages.push('atempo=2.0');
    rem /= 2.0;
  }
  while (rem < 0.5 - 1e-4) {
    stages.push('atempo=0.5');
    rem /= 0.5;
  }
  if (Math.abs(rem - 1.0) > 0.002) {
    stages.push(`atempo=${rem.toFixed(4)}`);
  }
  return stages.join(',');
}

function buildAudioMixMemfs(params: {
  hasSourceAudio: boolean;
  duration: number;
  originalDuration?: number;
  holds?: VideoExtensionHold[];
  videoClips?: VideoClip[];
  originalAudioClips?: OriginalAudioClip[];
  voice: VoiceConfig;
  applyDubbing: boolean;
  applyAudioMix: boolean;
  nextInputIndex: number;
  memfsPaths: Map<string, string>;
}) {
  const extraInputs: string[] = [];
  const filterSteps: string[] = [];
  const mixBranches: string[] = [];
  let inputIdx = params.nextInputIndex;

  const dubPath =
    params.applyDubbing &&
    params.voice.enabled &&
    !params.voice.voiceMuted &&
    Math.max(0, Number(params.voice.voiceVolume ?? 1.0)) > 0.005 &&
    params.voice.fullDubUrl
      ? params.memfsPaths.get(params.voice.fullDubUrl)
      : undefined;

  const bgmEnabled =
    params.voice.bgMusicEnabled !== undefined
      ? Boolean(params.voice.bgMusicEnabled)
      : Boolean(params.voice.bgMusicUrl && Number(params.voice.bgMusicVolume ?? 0) > 0.005);

  const sfxEnabled = Boolean(params.voice.sfxEnabled);

  const origActive = params.hasSourceAudio && isOrigAudioActive(params.voice);
  const trackOrigVol = Math.max(0, Math.min(2.0, Number(params.voice.originalAudioVolume ?? 1.0)));
  let fadeSuffix = '';
  if (params.applyAudioMix && params.voice.fadeInSec > 0) {
    fadeSuffix += `,afade=t=in:st=0:d=${params.voice.fadeInSec.toFixed(2)}`;
  }
  if (
    params.applyAudioMix &&
    params.voice.fadeOutSec > 0 &&
    params.duration > params.voice.fadeOutSec
  ) {
    const fadeStart = Math.max(0, params.duration - params.voice.fadeOutSec).toFixed(2);
    fadeSuffix += `,afade=t=out:st=${fadeStart}:d=${params.voice.fadeOutSec.toFixed(2)}`;
  }

  if (origActive) {
    const unlinkedClips = (params.originalAudioClips || []).filter(
      (c) => !c.muted && Math.max(0, Number(c.volume ?? 1.0)) > 0.005
    );
    const hasUnlinkedTrack = Boolean(params.originalAudioClips && params.originalAudioClips.length > 0);
    if (hasUnlinkedTrack) {
      if (unlinkedClips.length > 0) {
        const inLabels =
          unlinkedClips.length === 1 ? ['0:a'] : unlinkedClips.map((_, i) => `oa_in_${i}`);
        if (unlinkedClips.length > 1) {
          filterSteps.push(`[0:a]asplit=${unlinkedClips.length}${inLabels.map((l) => `[${l}]`).join('')}`);
        }
        const outLabels: string[] = [];
        unlinkedClips.forEach((c, i) => {
          const sStart = Math.max(0, Number(c.sourceStart || 0));
          const sEnd = Math.max(sStart + 0.05, Number(c.sourceEnd || params.originalDuration || params.duration));
          const tlStartMs = Math.max(0, Math.round(Number(c.timelineStart || 0) * 1000));
          const clipVol = Math.max(0, Math.min(2.0, trackOrigVol * Number(c.volume ?? 1.0)));
          const atempo = buildAtempoChain(c.speed ?? 1.0);
          const outLbl = unlinkedClips.length === 1 && !fadeSuffix ? 'a_orig' : `oa_out_${i}`;
          filterSteps.push(
            `[${inLabels[i]}]atrim=start=${sStart.toFixed(3)}:end=${sEnd.toFixed(3)},asetpts=PTS-STARTPTS${atempo ? `,${atempo}` : ''},aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=${clipVol.toFixed(2)}${tlStartMs > 0 ? `,adelay=${tlStartMs}|${tlStartMs}` : ''},apad=whole_dur=${params.duration.toFixed(3)},atrim=0:${params.duration.toFixed(3)}[${outLbl}]`
          );
          outLabels.push(`[${outLbl}]`);
        });
        if (unlinkedClips.length === 1) {
          if (fadeSuffix) {
            filterSteps.push(`${outLabels[0]}asetpts=PTS-STARTPTS${fadeSuffix},apad=whole_dur=${params.duration.toFixed(3)},atrim=0:${params.duration.toFixed(3)}[a_orig]`);
          }
        } else {
          filterSteps.push(`${outLabels.join('')}amix=inputs=${unlinkedClips.length}:duration=first:dropout_transition=0:normalize=0${fadeSuffix},apad=whole_dur=${params.duration.toFixed(3)},atrim=0:${params.duration.toFixed(3)}[a_orig]`);
        }
        mixBranches.push('[a_orig]');
      }
    } else if (params.videoClips && params.videoClips.length > 0 && !params.holds?.length) {
      const linkedClips = params.videoClips.filter((c) => !c.audioUnlinked);
      if (linkedClips.length > 0) {
        const inLabels =
          linkedClips.length === 1 ? ['0:a'] : linkedClips.map((_, i) => `va_in_${i}`);
        if (linkedClips.length > 1) {
          filterSteps.push(`[0:a]asplit=${linkedClips.length}${inLabels.map((l) => `[${l}]`).join('')}`);
        }
        const outLabels: string[] = [];
        linkedClips.forEach((c, i) => {
          const sStart = Math.max(0, Number(c.sourceStart || 0));
          const sEnd = Math.max(sStart + 0.05, Number(c.sourceEnd || params.originalDuration || params.duration));
          const tlStartMs = Math.max(0, Math.round(Number(c.timelineStart || 0) * 1000));
          const atempo = buildAtempoChain(c.speed);
          const outLbl = linkedClips.length === 1 && !fadeSuffix ? 'a_orig' : `va_out_${i}`;
          filterSteps.push(
            `[${inLabels[i]}]atrim=start=${sStart.toFixed(3)}:end=${sEnd.toFixed(3)},asetpts=PTS-STARTPTS${atempo ? `,${atempo}` : ''},aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=${trackOrigVol.toFixed(2)}${tlStartMs > 0 ? `,adelay=${tlStartMs}|${tlStartMs}` : ''},apad=whole_dur=${params.duration.toFixed(3)},atrim=0:${params.duration.toFixed(3)}[${outLbl}]`
          );
          outLabels.push(`[${outLbl}]`);
        });
        if (linkedClips.length === 1) {
          if (fadeSuffix) {
            filterSteps.push(`${outLabels[0]}asetpts=PTS-STARTPTS${fadeSuffix},apad=whole_dur=${params.duration.toFixed(3)},atrim=0:${params.duration.toFixed(3)}[a_orig]`);
          }
        } else {
          filterSteps.push(`${outLabels.join('')}amix=inputs=${linkedClips.length}:duration=first:dropout_transition=0:normalize=0${fadeSuffix},apad=whole_dur=${params.duration.toFixed(3)},atrim=0:${params.duration.toFixed(3)}[a_orig]`);
        }
        mixBranches.push('[a_orig]');
      }
    } else {
      const chain = `[0:a]volume=${trackOrigVol.toFixed(2)}${fadeSuffix}`;
      if (params.holds && params.holds.length > 0) {
        filterSteps.push(
          ...buildAudioHoldFilter({
            sourceAudioChainPrefix: chain,
            outputLabel: 'a_orig',
            originalDuration: params.originalDuration || params.duration,
            holds: params.holds,
          })
        );
      } else {
        filterSteps.push(`${chain},apad=whole_dur=${params.duration.toFixed(2)},atrim=0:${params.duration.toFixed(2)}[a_orig]`);
      }
      mixBranches.push('[a_orig]');
    }
  }

  if (dubPath) {
    const dubIdx = inputIdx++;
    extraInputs.push('-i', dubPath);
    const offsetSec = Number(params.voice.timingOffsetSec || 0);
    const filters: string[] = [];
    if (offsetSec > 0.02) {
      const delayMs = Math.round(offsetSec * 1000);
      filters.push(`adelay=${delayMs}|${delayMs}`);
    } else if (offsetSec < -0.02) {
      filters.push(`atrim=start=${Math.abs(offsetSec).toFixed(2)},asetpts=PTS-STARTPTS`);
    }
    const voiceVol = Math.max(0, Math.min(2.0, Number(params.voice.voiceVolume ?? 1.0)));
    filters.push(`volume=${voiceVol.toFixed(2)}`);
    if (params.applyAudioMix && params.voice.fadeInSec > 0) {
      filters.push(`afade=t=in:st=0:d=${params.voice.fadeInSec.toFixed(2)}`);
    }
    if (params.applyAudioMix && params.voice.fadeOutSec > 0 && params.duration > params.voice.fadeOutSec) {
      filters.push(`afade=t=out:st=${Math.max(0, params.duration - params.voice.fadeOutSec).toFixed(2)}:d=${params.voice.fadeOutSec.toFixed(2)}`);
    }
    filters.push(`apad=whole_dur=${params.duration.toFixed(2)}`, `atrim=0:${params.duration.toFixed(2)}`);
    filterSteps.push(`[${dubIdx}:a]${filters.join(',')}[a_dub]`);
    mixBranches.push('[a_dub]');
  }

  const hasExplicitBgmClips = Array.isArray(params.voice.bgMusicClips);
  if (params.applyAudioMix && bgmEnabled && !params.voice.bgMusicMuted && Math.max(0, Number(params.voice.bgMusicVolume ?? 0)) > 0.005) {
    const trackBgmVol = Math.max(0, Math.min(2.0, Number(params.voice.bgMusicVolume ?? 0)));
    if (hasExplicitBgmClips) {
      const valid = (params.voice.bgMusicClips || []).filter(
        (c) => !c.muted && Math.max(0, Number(c.volume ?? 1.0)) > 0.005 && params.memfsPaths.has(c.audioUrl || params.voice.bgMusicUrl || '')
      );
      if (valid.length > 0) {
        const labels: string[] = [];
        valid.forEach((c, i) => {
          const p = params.memfsPaths.get(c.audioUrl || params.voice.bgMusicUrl || '')!;
          const idx = inputIdx++;
          if (c.loop) extraInputs.push('-stream_loop', '-1', '-i', p);
          else extraInputs.push('-i', p);
          const sStart = Math.max(0, Number(c.sourceStart || 0));
          const sEnd = Math.max(sStart + 0.05, Number(c.sourceEnd || params.duration));
          const tlStartMs = Math.max(0, Math.round(Number(c.timelineStart || 0) * 1000));
          const clipVol = Math.max(0, Math.min(2.0, trackBgmVol * Number(c.volume ?? 1.0)));
          const outLbl = valid.length === 1 && params.voice.fadeInSec <= 0 && params.voice.fadeOutSec <= 0 ? 'a_bgm' : `bgm_c_${i}`;
          filterSteps.push(
            `[${idx}:a]atrim=start=${sStart.toFixed(3)}:end=${sEnd.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=${clipVol.toFixed(2)}${tlStartMs > 0 ? `,adelay=${tlStartMs}|${tlStartMs}` : ''},apad=whole_dur=${params.duration.toFixed(3)},atrim=0:${params.duration.toFixed(3)}[${outLbl}]`
          );
          labels.push(`[${outLbl}]`);
        });
        let bgmFade = '';
        if (params.voice.fadeInSec > 0) bgmFade += `,afade=t=in:st=0:d=${params.voice.fadeInSec.toFixed(2)}`;
        if (params.voice.fadeOutSec > 0 && params.duration > params.voice.fadeOutSec) {
          bgmFade += `,afade=t=out:st=${Math.max(0, params.duration - params.voice.fadeOutSec).toFixed(2)}:d=${params.voice.fadeOutSec.toFixed(2)}`;
        }
        if (valid.length === 1 && bgmFade) {
          filterSteps.push(`${labels[0]}asetpts=PTS-STARTPTS${bgmFade}[a_bgm]`);
        } else if (valid.length > 1) {
          filterSteps.push(`${labels.join('')}amix=inputs=${valid.length}:duration=first:dropout_transition=0:normalize=0${bgmFade},apad=whole_dur=${params.duration.toFixed(3)},atrim=0:${params.duration.toFixed(3)}[a_bgm]`);
        }
        mixBranches.push('[a_bgm]');
      }
    } else if (params.voice.bgMusicUrl && params.memfsPaths.has(params.voice.bgMusicUrl)) {
      const musicIdx = inputIdx++;
      extraInputs.push('-stream_loop', '-1', '-i', params.memfsPaths.get(params.voice.bgMusicUrl)!);
      let chain = `[${musicIdx}:a]atrim=0:${params.duration.toFixed(2)},asetpts=PTS-STARTPTS,volume=${trackBgmVol.toFixed(2)}`;
      if (params.voice.fadeInSec > 0) chain += `,afade=t=in:st=0:d=${params.voice.fadeInSec.toFixed(2)}`;
      if (params.voice.fadeOutSec > 0 && params.duration > params.voice.fadeOutSec) {
        chain += `,afade=t=out:st=${Math.max(0, params.duration - params.voice.fadeOutSec).toFixed(2)}:d=${params.voice.fadeOutSec.toFixed(2)}`;
      }
      filterSteps.push(`${chain}[a_bgm]`);
      mixBranches.push('[a_bgm]');
    }
  }

  const hasExplicitSfxClips = Array.isArray(params.voice.sfxClips);
  if (params.applyAudioMix && sfxEnabled && !params.voice.sfxMuted && Math.max(0, Number(params.voice.sfxVolume ?? 1.0)) > 0.005) {
    const trackSfxVol = Math.max(0, Math.min(2.0, Number(params.voice.sfxVolume ?? 1.0)));
    if (hasExplicitSfxClips) {
      const valid = (params.voice.sfxClips || []).filter(
        (c) => !c.muted && Math.max(0, Number(c.volume ?? 1.0)) > 0.005 && params.memfsPaths.has(c.audioUrl || params.voice.sfxUrl || '')
      );
      if (valid.length > 0) {
        const labels: string[] = [];
        valid.forEach((c, i) => {
          const p = params.memfsPaths.get(c.audioUrl || params.voice.sfxUrl || '')!;
          const idx = inputIdx++;
          extraInputs.push('-i', p);
          const sStart = Math.max(0, Number(c.sourceStart || 0));
          const sEnd = Math.max(sStart + 0.05, Number(c.sourceEnd || params.duration));
          const tlStartMs = Math.max(0, Math.round(Number(c.timelineStart || 0) * 1000));
          const clipVol = Math.max(0, Math.min(2.0, trackSfxVol * Number(c.volume ?? 1.0)));
          const outLbl = valid.length === 1 ? 'a_sfx' : `sfx_c_${i}`;
          filterSteps.push(
            `[${idx}:a]atrim=start=${sStart.toFixed(3)}:end=${sEnd.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=${clipVol.toFixed(2)}${tlStartMs > 0 ? `,adelay=${tlStartMs}|${tlStartMs}` : ''},apad=whole_dur=${params.duration.toFixed(3)},atrim=0:${params.duration.toFixed(3)}[${outLbl}]`
          );
          labels.push(`[${outLbl}]`);
        });
        if (valid.length > 1) {
          filterSteps.push(`${labels.join('')}amix=inputs=${valid.length}:duration=first:dropout_transition=0:normalize=0,apad=whole_dur=${params.duration.toFixed(3)},atrim=0:${params.duration.toFixed(3)}[a_sfx]`);
        }
        mixBranches.push('[a_sfx]');
      }
    } else if (params.voice.sfxUrl && params.memfsPaths.has(params.voice.sfxUrl)) {
      const sfxIdx = inputIdx++;
      extraInputs.push('-i', params.memfsPaths.get(params.voice.sfxUrl)!);
      filterSteps.push(
        `[${sfxIdx}:a]volume=${trackSfxVol.toFixed(2)},apad=whole_dur=${params.duration.toFixed(2)},atrim=0:${params.duration.toFixed(2)}[a_sfx]`
      );
      mixBranches.push('[a_sfx]');
    }
  }

  if (mixBranches.length === 0) return { extraInputs, filterSteps, audioMapLabel: null };
  if (mixBranches.length === 1) return { extraInputs, filterSteps, audioMapLabel: mixBranches[0] };
  filterSteps.push(`${mixBranches.join('')}amix=inputs=${mixBranches.length}:duration=first:dropout_transition=2:normalize=0[a_final]`);
  return { extraInputs, filterSteps, audioMapLabel: '[a_final]' };
}

export async function renderProjectExportInBrowser(params: {
  project: Project;
  resolveUrlFn: (u: string) => string;
  onProgress: (pct: number, stage: string, etaSec: number | null) => void;
}): Promise<{ blob: Blob; filename: string; sizeBytes: number }> {
  const { project, resolveUrlFn, onProgress } = params;
  if (!project.sourceVideoUrl || !project.metadata) {
    throw new Error('Project has no uploaded source video.');
  }

  const { exportSettings } = project;
  const canvas = { ...DEFAULT_VIDEO_CANVAS, ...(project.canvas || {}) };
  const { width, height } = resolveCanvasDimensions(canvas, exportSettings, project.metadata);
  const origDur = Math.max(0.5, project.metadata.duration || 10);
  const videoClips = getEffectiveVideoClips(project);
  const origAudioClips = getEffectiveOriginalAudioClips(project);
  const customVideoEdits = hasCustomVideoEdits(project);

  const dubbingActive = Boolean(
    exportSettings.applyDubbing &&
      project.voice.enabled &&
      project.voice.fullDubUrl &&
      project.voice.syncPlan
  );
  const syncMode = project.voice.syncMode || 'flexible';
  const activeSyncPlan =
    !customVideoEdits &&
    dubbingActive &&
    syncMode === 'flexible' &&
    (project.voice.syncPlan?.holds?.length || 0) > 0
      ? project.voice.syncPlan
      : undefined;
  const continuousExtendSec =
    !customVideoEdits &&
    dubbingActive &&
    syncMode === 'continuous' &&
    (project.voice.syncPlan?.estimatedFinalDuration || 0) > origDur + 0.05
      ? Number(((project.voice.syncPlan?.estimatedFinalDuration || origDur) - origDur).toFixed(3))
      : 0;

  const captionsWillBurn =
    exportSettings.applyCaptions &&
    project.subtitleStyle.enabled &&
    project.subtitleStyle.visible !== false &&
    project.captions.length > 0;
  const visibleExtraElements = (project.subtitleStyle.extraElements || []).filter(
    (el) => el.visible && (el.syncToCaptions || Boolean(el.text?.trim()))
  );

  const videoTrackDur =
    videoClips.length > 0
      ? getVideoTimelineTotalDuration(videoClips)
      : Array.isArray(project.videoClips) && project.videoClips.length === 0
      ? 0
      : origDur;
  const dubClipsMax = dubbingActive
    ? (project.voice.generatedClips || []).reduce(
        (m, c) => Math.max(m, (c.end || 0) + Number(project.voice.timingOffsetSec || 0)),
        0
      )
    : 0;
  const dubTrackDur = dubbingActive
    ? Math.max(project.voice.syncPlan?.estimatedFinalDuration || 0, dubClipsMax)
    : 0;
  const origAudioTrackDur = origAudioClips.reduce((m, c) => Math.max(m, getOriginalAudioClipTimelineEnd(c)), 0);
  const bgmTrackDur = Array.isArray(project.voice.bgMusicClips)
    ? getEffectiveBgmClips(project, origDur).reduce((m, c) => Math.max(m, getTimelineAudioClipEnd(c)), 0)
    : 0;
  const sfxTrackDur = Array.isArray(project.voice.sfxClips)
    ? getEffectiveSfxClips(project, origDur).reduce((m, c) => Math.max(m, getTimelineAudioClipEnd(c)), 0)
    : 0;
  const captionsTrackDur = captionsWillBurn
    ? (project.captions || []).reduce((m, c) => Math.max(m, c.end || 0), 0)
    : 0;

  const totalDur = customVideoEdits
    ? Math.max(1.0, videoTrackDur, dubTrackDur, origAudioTrackDur, bgmTrackDur, sfxTrackDur, captionsTrackDur)
    : activeSyncPlan
    ? Math.max(origDur, activeSyncPlan.estimatedFinalDuration)
    : dubbingActive
    ? Math.max(origDur, project.voice.syncPlan?.estimatedFinalDuration || origDur)
    : origDur;

  onProgress(4, 'Loading browser FFmpeg WebAssembly engine & media assets', null);

  // Gather external asset URLs to load into MEMFS
  const urlsToLoad = new Set<string>();
  urlsToLoad.add(project.sourceVideoUrl);
  if (canvas.backgroundType === 'image' && canvas.bgImageUrl && canvas.bgImageVisible !== false) {
    urlsToLoad.add(canvas.bgImageUrl);
  }
  for (const logo of project.logos.filter((l) => l.enabled && exportSettings.applyLogo)) {
    urlsToLoad.add(logo.url);
  }
  for (const blur of project.blurs.filter((b) => b.enabled && exportSettings.applyBlur)) {
    if (blur.maskAssetId) urlsToLoad.add(blur.maskAssetId);
  }
  if (dubbingActive && project.voice.fullDubUrl) urlsToLoad.add(project.voice.fullDubUrl);
  if (exportSettings.applyAudioMix) {
    if (project.voice.bgMusicUrl) urlsToLoad.add(project.voice.bgMusicUrl);
    for (const c of project.voice.bgMusicClips || []) if (c.audioUrl) urlsToLoad.add(c.audioUrl);
    if (project.voice.sfxUrl) urlsToLoad.add(project.voice.sfxUrl);
    for (const c of project.voice.sfxClips || []) if (c.audioUrl) urlsToLoad.add(c.audioUrl);
  }

  // Fetch font files for ASS captions if needed
  const fontRequests: Array<{ family: string; weight: number; italic: boolean }> = [];
  if (captionsWillBurn || visibleExtraElements.length > 0) {
    if (captionsWillBurn) {
      fontRequests.push({
        family: project.subtitleStyle.fontFamily || 'Montserrat',
        weight:
          project.subtitleStyle.fontWeightNum ??
          (project.subtitleStyle.fontWeight === '900' ? 900 : project.subtitleStyle.fontWeight === 'bold' ? 700 : 400),
        italic: project.subtitleStyle.italic,
      });
    }
    for (const el of visibleExtraElements) {
      fontRequests.push({
        family: el.style?.fontFamily || project.subtitleStyle.fontFamily || 'Montserrat',
        weight: el.style?.fontWeightNum || project.subtitleStyle.fontWeightNum || 700,
        italic: el.style?.italic ?? project.subtitleStyle.italic,
      });
    }
  }

  const assetBytesMap = new Map<string, Uint8Array>();
  for (const u of urlsToLoad) {
    try {
      if (u === project.sourceVideoUrl && (project.sourceVideoBlobKey || u.startsWith('blob:') || u.startsWith('idb://'))) {
        const retrieved = await retrieveProjectVideoBlob(project);
        if (retrieved?.blob && retrieved.blob.size > 0) {
          assetBytesMap.set(u, new Uint8Array(await retrieved.blob.arrayBuffer()));
          continue;
        }
      }
      const b = await resolveMediaBlob(u, resolveUrlFn);
      assetBytesMap.set(u, new Uint8Array(await b.arrayBuffer()));
    } catch (err) {
      if (u === project.sourceVideoUrl) {
        const retrieved = await retrieveProjectVideoBlob(project).catch(() => null);
        if (retrieved?.blob && retrieved.blob.size > 0) {
          assetBytesMap.set(u, new Uint8Array(await retrieved.blob.arrayBuffer()));
          continue;
        }
        throw err;
      }
    }
  }

  const loadedFonts: Array<{ filename: string; bytes: Uint8Array }> = [];
  const seenFontKeys = new Set<string>();
  for (const fr of fontRequests) {
    const key = `${fr.family}:${fr.weight}:${fr.italic ? 1 : 0}`;
    if (seenFontKeys.has(key)) continue;
    seenFontKeys.add(key);
    try {
      const ensureRes = await fetch(
        resolveUrlFn(
          `/api/fonts/ensure?family=${encodeURIComponent(fr.family)}&weight=${fr.weight}&italic=${fr.italic ? '1' : '0'}`
        )
      );
      if (ensureRes.ok) {
        const info = (await ensureRes.json()) as { available?: boolean; url?: string };
        if (info.available && info.url) {
          const fRes = await fetch(resolveUrlFn(info.url));
          if (fRes.ok) {
            const bytes = new Uint8Array(await fRes.arrayBuffer());
            loadedFonts.push({
              filename: `font_${loadedFonts.length}_${fr.family.replace(/[^a-zA-Z0-9]/g, '')}.ttf`,
              bytes,
            });
          }
        }
      }
    } catch {
      // non-fatal; libass will fallback to available font if font fetch fails offline
    }
  }

  const outFilename = `recap_export_${project.id.slice(0, 8)}_${Date.now()}.mp4`;

  const mp4Bytes = await withFFmpegLock(async (ff: FFmpeg) => {
    const memfsPaths = new Map<string, string>();
    const tempFiles: string[] = [];

    const writeTemp = async (memPath: string, data: Uint8Array | string) => {
      await ff.writeFile(memPath, data);
      tempFiles.push(memPath);
    };

    try {
      let assetIdx = 0;
      const srcBytes = assetBytesMap.get(project.sourceVideoUrl!);
      if (!srcBytes) throw new Error('Source video bytes could not be loaded.');
      const srcExt = (project.sourceFilename || 'source.mp4').split('.').pop()?.toLowerCase() || 'mp4';
      const srcMem = `in_source.${srcExt}`;
      await writeTemp(srcMem, srcBytes);
      memfsPaths.set(project.sourceVideoUrl!, srcMem);

      for (const [u, bytes] of assetBytesMap.entries()) {
        if (u === project.sourceVideoUrl) continue;
        const cleanExt = (u.split('.').pop()?.split('?')[0] || 'bin').toLowerCase().slice(0, 5);
        const memPath = `in_asset_${assetIdx++}.${cleanExt}`;
        await writeTemp(memPath, bytes);
        memfsPaths.set(u, memPath);
      }

      if (loadedFonts.length > 0) {
        try {
          await ff.createDir('/fonts');
        } catch {
          // directory already exists
        }
        for (const f of loadedFonts) {
          await writeTemp(`/fonts/${f.filename}`, f.bytes);
        }
      }

      const extraInputs: string[] = [];
      const filterSteps: string[] = [];
      let nextInputIdx = 1;

      const videoVisible = canvas.videoVisible !== false;
      const videoOpacity = Math.max(0.05, Math.min(1, canvas.videoOpacity ?? 1));
      const videoRotDeg = canvas.videoRotation || 0;
      const bgVisible = canvas.bgImageVisible !== false;
      const bgOpacity = Math.max(0.05, Math.min(1, canvas.bgImageOpacity ?? 1));
      const bgRotDeg = canvas.bgImageRotation || 0;
      const cropMode = canvas.cropMode || 'fit';

      let currentV = 'v_scaled';
      const hasCustomCropOrTransform =
        canvas.aspectRatio !== 'original' ||
        cropMode !== 'fit' ||
        Math.abs((canvas.zoom || 1) - 1) > 0.005 ||
        Math.abs(canvas.offsetX || 0) > 0.1 ||
        Math.abs(canvas.offsetY || 0) > 0.1 ||
        Math.abs(videoRotDeg) > 0.2 ||
        Boolean(canvas.flipH) ||
        Boolean(canvas.flipV) ||
        videoOpacity < 0.99 ||
        !videoVisible ||
        (canvas.cropTop || 0) > 0 ||
        (canvas.cropRight || 0) > 0 ||
        (canvas.cropBottom || 0) > 0 ||
        (canvas.cropLeft || 0) > 0 ||
        Boolean(canvas.cropWidth && canvas.cropHeight) ||
        canvas.backgroundType !== 'solid' ||
        (canvas.bgColor || '#09090B').toUpperCase() !== '#09090B';

      if (!hasCustomCropOrTransform && !customVideoEdits) {
        if (exportSettings.aspectRatio === 'original') {
          filterSteps.push(`[0:v]scale=${width}:${height},setsar=1[${currentV}]`);
        } else if (exportSettings.fitMode === 'crop') {
          filterSteps.push(
            `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[${currentV}]`
          );
        } else if (exportSettings.fitMode === 'blur-pad') {
          filterSteps.push(
            `[0:v]split[v_bg][v_fg];` +
              `[v_bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=24[v_bg_b];` +
              `[v_fg]scale=${width}:${height}:force_original_aspect_ratio=decrease[v_fg_s];` +
              `[v_bg_b][v_fg_s]overlay=(W-w)/2:(H-h)/2,setsar=1[${currentV}]`
          );
        } else {
          filterSteps.push(
            `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=#09090B,setsar=1[${currentV}]`
          );
        }
      } else {
        const fpsVal = Math.max(1, Math.round(project.metadata!.fps || 30));
        const srcW = Math.max(16, project.metadata!.width || 1280);
        const srcH = Math.max(16, project.metadata!.height || 720);
        let { cx, cy, cw, ch } = resolveSourceCropRect(srcW, srcH, canvas);

        if (cropMode === 'smart-center' && cw === srcW && ch === srcH) {
          const targetRatio = width / Math.max(1, height);
          const srcRatio = srcW / Math.max(1, srcH);
          if (srcRatio > targetRatio) {
            cw = Math.max(16, Math.round(srcH * targetRatio) & ~1);
            cx = Math.max(0, Math.round((srcW - cw) / 2));
          } else if (srcRatio < targetRatio) {
            ch = Math.max(16, Math.round(srcW / targetRatio) & ~1);
            cy = Math.max(0, Math.round((srcH - ch) * 0.35));
          }
        }

        let fitW: number;
        let fitH: number;
        if (cropMode === 'stretch') {
          fitW = width;
          fitH = height;
        } else if (cropMode === 'fill') {
          if (cw / ch > width / height) {
            fitH = height;
            fitW = Math.max(2, Math.round((height * cw) / ch) & ~1);
          } else {
            fitW = width;
            fitH = Math.max(2, Math.round((width * ch) / cw) & ~1);
          }
        } else {
          if (cw / ch > width / height) {
            fitW = width;
            fitH = Math.max(2, Math.round((width * ch) / cw) & ~1);
          } else {
            fitH = height;
            fitW = Math.max(2, Math.round((height * cw) / ch) & ~1);
          }
        }

        const zoom = Math.max(0.25, Math.min(3.0, canvas.zoom || 1));
        const fgW = Math.max(16, Math.round(fitW * zoom) & ~1);
        const fgH = Math.max(16, Math.round(fitH * zoom) & ~1);
        const centerX = width / 2 + ((canvas.offsetX || 0) / 100) * width;
        const centerY = height / 2 + ((canvas.offsetY || 0) / 100) * height;
        const needsFgTransform =
          Math.abs(videoRotDeg) > 0.2 || videoOpacity < 0.99 || Boolean(canvas.flipH) || Boolean(canvas.flipV);

        let fgTransformSuffix = `crop=${cw}:${ch}:${cx}:${cy},scale=${fgW}:${fgH},setsar=1`;
        if (canvas.flipH) fgTransformSuffix += `,hflip`;
        if (canvas.flipV) fgTransformSuffix += `,vflip`;
        if (Math.abs(videoRotDeg) > 0.2 || videoOpacity < 0.99) {
          fgTransformSuffix += `,format=rgba`;
          if (videoOpacity < 0.99) fgTransformSuffix += `,colorchannelmixer=aa=${videoOpacity.toFixed(2)}`;
          if (Math.abs(videoRotDeg) > 0.2) {
            const rad = ((videoRotDeg * Math.PI) / 180).toFixed(4);
            fgTransformSuffix += `,rotate=${rad}:ow='rotw(${rad})':oh='roth(${rad})':c=none`;
          }
        }

        const fgOverlayX = needsFgTransform ? `${Math.round(centerX)}-w/2` : String(Math.round(centerX - fgW / 2));
        const fgOverlayY = needsFgTransform ? `${Math.round(centerY)}-h/2` : String(Math.round(centerY - fgH / 2));
        const bgMemPath = canvas.backgroundType === 'image' && canvas.bgImageUrl && bgVisible ? memfsPaths.get(canvas.bgImageUrl) : undefined;

        let bgOut = 'v_canvas_bg';
        const clipCount = videoVisible ? videoClips.length : 0;
        const clipInLabels: string[] = [];

        if (canvas.backgroundType === 'blur' && bgVisible) {
          const sigma = Math.max(1, Math.min(60, Math.round(canvas.bgBlurIntensity || 24)));
          const brightVal = Math.max(-0.6, Math.min(0.6, (canvas.bgBlurBrightness ?? -15) / 100)).toFixed(2);
          const blurOpacity = Math.max(0.1, Math.min(1.0, canvas.bgBlurOpacity ?? 0.9));
          const splitTargets = ['v_bg_raw'];
          for (let i = 0; i < clipCount; i++) {
            const lbl = `v_clip_in_${i}`;
            clipInLabels.push(lbl);
            splitTargets.push(lbl);
          }
          if (splitTargets.length === 1) filterSteps.push(`[0:v]null[v_bg_raw]`);
          else filterSteps.push(`[0:v]split=${splitTargets.length}${splitTargets.map((l) => `[${l}]`).join('')}`);

          let bgBlurChain = `[v_bg_raw]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=${sigma},eq=brightness=${brightVal},fps=${fpsVal},setsar=1`;
          if (totalDur > origDur + 0.05) {
            bgBlurChain += `,tpad=stop_mode=clone:stop_duration=${(totalDur - origDur + 0.3).toFixed(2)}`;
          }
          filterSteps.push(`${bgBlurChain}[v_bg_blurred]`);

          if (blurOpacity < 0.99 || totalDur > origDur + 0.05) {
            filterSteps.push(`color=c=#09090B:s=${width}x${height}:r=${fpsVal}:d=${totalDur.toFixed(3)}[v_bg_dark]`);
            const alphaFilter = blurOpacity < 0.99 ? `format=yuva420p,colorchannelmixer=aa=${blurOpacity.toFixed(2)}` : 'null';
            filterSteps.push(`[v_bg_blurred]${alphaFilter}[v_bg_alpha]`);
            filterSteps.push(`[v_bg_dark][v_bg_alpha]overlay=0:0:shortest=1,trim=0:${totalDur.toFixed(3)},setsar=1[v_canvas_bg]`);
          } else {
            bgOut = 'v_bg_blurred';
          }
        } else {
          if (clipCount === 1) clipInLabels.push('0:v');
          else if (clipCount > 1) {
            for (let i = 0; i < clipCount; i++) clipInLabels.push(`v_clip_in_${i}`);
            filterSteps.push(`[0:v]split=${clipCount}${clipInLabels.map((l) => `[${l}]`).join('')}`);
          }
          if (bgMemPath) {
            const bgIdx = nextInputIdx++;
            extraInputs.push('-loop', '1', '-t', totalDur.toFixed(3), '-i', bgMemPath);
            const bgScale = Math.max(0.5, Math.min(2.5, canvas.bgImageScale || 1));
            const targetBgW = Math.max(16, Math.round(width * bgScale) & ~1);
            const targetBgH = Math.max(16, Math.round(height * bgScale) & ~1);
            const bgShiftX = Math.round(((canvas.bgImageOffsetX || 0) / 100) * width);
            const bgShiftY = Math.round(((canvas.bgImageOffsetY || 0) / 100) * height);
            filterSteps.push(`color=c=#09090B:s=${width}x${height}:r=${fpsVal}:d=${totalDur.toFixed(3)}[v_bg_dark]`);
            let bgChain = `[${bgIdx}:v]scale=${targetBgW}:${targetBgH}:force_original_aspect_ratio=increase,fps=${fpsVal},setsar=1`;
            if (bgOpacity < 0.99 || Math.abs(bgRotDeg) > 0.2) {
              bgChain += `,format=rgba`;
              if (bgOpacity < 0.99) bgChain += `,colorchannelmixer=aa=${bgOpacity.toFixed(2)}`;
              if (Math.abs(bgRotDeg) > 0.2) {
                const rad = ((bgRotDeg * Math.PI) / 180).toFixed(4);
                bgChain += `,rotate=${rad}:ow='rotw(${rad})':oh='roth(${rad})':c=none`;
              }
            }
            filterSteps.push(`${bgChain}[v_bg_img]`);
            filterSteps.push(`[v_bg_dark][v_bg_img]overlay=x=(W-w)/2+${bgShiftX}:y=(H-h)/2+${bgShiftY}:shortest=1[v_canvas_bg]`);
          } else {
            const bgHex = /^#[0-9a-fA-F]{6}$/.test(canvas.bgColor || '') ? canvas.bgColor : '#09090B';
            filterSteps.push(`color=c=${bgHex}:s=${width}x${height}:r=${fpsVal}:d=${totalDur.toFixed(3)}[v_canvas_bg]`);
          }
        }

        if (!videoVisible || videoClips.length === 0) {
          filterSteps.push(`[${bgOut}]setsar=1[${currentV}]`);
        } else if (!customVideoEdits) {
          filterSteps.push(`[${clipInLabels[0]}]${fgTransformSuffix}[v_fg_scaled]`);
          filterSteps.push(`[${bgOut}][v_fg_scaled]overlay=x='${fgOverlayX}':y='${fgOverlayY}':shortest=1,setsar=1[${currentV}]`);
        } else {
          let bgRunner = bgOut;
          videoClips.forEach((clip, idx) => {
            const sStart = Math.max(0, Number(clip.sourceStart || 0));
            const sEnd = Math.max(sStart + 0.05, Number(clip.sourceEnd || origDur));
            const spd = clampVideoSpeed(clip.speed);
            const tlStart = Math.max(0, Number(clip.timelineStart || 0));
            const tlEnd = tlStart + getVideoClipTimelineDuration(clip);
            const clipOut = `v_clip_out_${idx}`;
            const isLast = idx === videoClips.length - 1;
            const nextRunner = isLast ? currentV : `v_comp_${idx}`;
            filterSteps.push(
              `[${clipInLabels[idx]}]trim=start=${sStart.toFixed(3)}:end=${sEnd.toFixed(3)},setpts=(PTS-STARTPTS)/${spd.toFixed(4)}+${tlStart.toFixed(3)}/TB,fps=${fpsVal}:start_time=${tlStart.toFixed(3)},${fgTransformSuffix}[${clipOut}]`
            );
            filterSteps.push(
              `[${bgRunner}][${clipOut}]overlay=x='${fgOverlayX}':y='${fgOverlayY}':enable='between(t,${tlStart.toFixed(3)},${tlEnd.toFixed(3)})':eof_action=pass${isLast ? ',setsar=1' : ''}[${nextRunner}]`
            );
            bgRunner = nextRunner;
          });
        }
      }

      if (activeSyncPlan && activeSyncPlan.holds.length > 0) {
        filterSteps.push(
          ...buildVideoFrameHoldFilter({
            inputLabel: currentV,
            outputLabel: 'v_held',
            originalDuration: origDur,
            holds: activeSyncPlan.holds,
          })
        );
        currentV = 'v_held';
      } else if (continuousExtendSec > 0.05) {
        filterSteps.push(`[${currentV}]tpad=stop_mode=clone:stop_duration=${continuousExtendSec.toFixed(3)}[v_cont_ext]`);
        currentV = 'v_cont_ext';
      }

      if (exportSettings.applyVideoEffects !== false && project.videoEffects) {
        const effectsRes = buildVideoEffectsFilters({
          config: project.videoEffects,
          startLabel: currentV,
          outputLabel: 'v_effects',
          duration: totalDur,
          width,
          height,
          videoClips,
        });
        if (effectsRes.filterSteps.length > 0) {
          filterSteps.push(...effectsRes.filterSteps);
          currentV = effectsRes.currentLabel;
        }
      }

      const captionOffset =
        (dubbingActive ? Number(project.voice.timingOffsetSec || 0) : 0) +
        Number(project.subtitleStyle.timingOffsetSec || 0);
      const renderCaptions =
        dubbingActive && project.voice.syncPlan
          ? buildSyncedCaptionsForRender(project.captions, project.voice.syncPlan, captionOffset)
          : captionOffset !== 0
          ? buildSyncedCaptionsForRender(project.captions, undefined, captionOffset)
          : project.captions;
      const syncedIntervals = renderCaptions.map((c) => ({ id: c.id, syncedStart: c.start, syncedEnd: c.end }));

      const blurOverrides: Record<string, MemfsBlurOverride> = {};
      const renderBlurs = project.blurs.map((b) => {
        const linkMode = b.subtitleLink?.mode || 'manual';
        let remapped = b;
        let intervals: Array<{ start: number; end: number }> | undefined;
        if (linkMode === 'translated') {
          intervals = resolveBlurIntervals(b, project, { syncedCaptionsOverride: syncedIntervals });
        } else if (linkMode === 'original') {
          intervals = resolveBlurIntervals(b, project, { holdsOverride: activeSyncPlan?.holds || [] });
        } else if (activeSyncPlan) {
          remapped = remapBlursForSyncPlan([b], activeSyncPlan.holds)[0] || b;
          intervals = [{ start: remapped.startTime, end: remapped.endTime }];
        } else {
          intervals = [{ start: b.startTime, end: b.endTime }];
        }
        const mappedRect =
          b.coordSpace === 'video'
            ? mapBlurToExportCanvasNormalized(remapped, project, Math.max(16, project.metadata!.width || 1280), Math.max(16, project.metadata!.height || 720), {
                hasCustomCanvasOverride: hasCustomCropOrTransform || customVideoEdits,
              })
            : undefined;
        blurOverrides[remapped.id] = { mappedRect, intervals };
        return remapped;
      });
      const renderLogos = activeSyncPlan ? remapLogosForSyncPlan(project.logos, activeSyncPlan.holds) : project.logos;

      const captionsEnabled =
        exportSettings.applyCaptions &&
        project.subtitleStyle.enabled &&
        project.subtitleStyle.visible !== false &&
        renderCaptions.length > 0;
      const blurMap = new Map(renderBlurs.filter((b) => b.enabled).map((b) => [b.id, b]));
      const logoMap = new Map(renderLogos.filter((l) => l.enabled).map((l) => [l.id, l]));
      const extraElementMap = new Map(visibleExtraElements.map((el) => [el.id, el]));

      const defaultOrder: string[] = [
        ...renderBlurs.filter((b) => b.enabled).map((b) => `blur:${b.id}`),
        ...renderLogos.filter((l) => l.enabled).map((l) => `logo:${l.id}`),
        ...(captionsEnabled ? ['captions'] : []),
        ...visibleExtraElements.map((el) => `caption-element:${el.id}`),
      ];
      const orderedTokens: string[] = [];
      const seen = new Set<string>();
      for (const tok of canvas.layerOrder || []) {
        if (
          (tok.startsWith('blur:') && blurMap.has(tok.slice(5))) ||
          (tok.startsWith('logo:') && logoMap.has(tok.slice(5))) ||
          (tok === 'captions' && captionsEnabled) ||
          (tok.startsWith('caption-element:') && extraElementMap.has(tok.slice('caption-element:'.length)))
        ) {
          orderedTokens.push(tok);
          seen.add(tok);
        }
      }
      for (const tok of defaultOrder) {
        if (!seen.has(tok)) {
          orderedTokens.push(tok);
          seen.add(tok);
        }
      }

      let layerStep = 0;
      const fontsOpt = loadedFonts.length > 0 ? `:fontsdir='/fonts'` : '';
      for (const token of orderedTokens) {
        layerStep += 1;
        if (token.startsWith('blur:') && exportSettings.applyBlur) {
          const blur = blurMap.get(token.slice(5));
          if (!blur) continue;
          const blurRes = buildBlurFiltersMemfs({
            blurs: [blur],
            startLabel: currentV,
            targetWidth: width,
            targetHeight: height,
            nextInputIndex: nextInputIdx,
            labelPrefix: `lb${layerStep}`,
            overrides: blurOverrides,
            memfsPaths,
          });
          extraInputs.push(...blurRes.extraInputs);
          filterSteps.push(...blurRes.filterSteps);
          currentV = blurRes.currentLabel;
          nextInputIdx = blurRes.nextInputIndex;
        } else if (token.startsWith('logo:') && exportSettings.applyLogo) {
          const logo = logoMap.get(token.slice(5));
          if (!logo) continue;
          const logoRes = buildLogoFiltersMemfs({
            logos: [logo],
            startLabel: currentV,
            targetWidth: width,
            targetHeight: height,
            nextInputIndex: nextInputIdx,
            labelPrefix: `ll${layerStep}`,
            memfsPaths,
          });
          extraInputs.push(...logoRes.extraInputs);
          filterSteps.push(...logoRes.filterSteps);
          currentV = logoRes.currentLabel;
          nextInputIdx = logoRes.nextInputIndex;
        } else if (token === 'captions' && captionsEnabled) {
          const assContent = buildAssContent({
            captions: renderCaptions,
            style: project.subtitleStyle,
            videoWidth: width,
            videoHeight: height,
            totalDuration: totalDur,
            includeMainCaptions: true,
            includeExtraElements: false,
          });
          const assMem = `subs_${layerStep}.ass`;
          await writeTemp(assMem, assContent);
          const outLabel = `v_sub_${layerStep}`;
          filterSteps.push(`[${currentV}]ass='${assMem}'${fontsOpt}[${outLabel}]`);
          currentV = outLabel;
        } else if (token.startsWith('caption-element:')) {
          const elId = token.slice('caption-element:'.length);
          if (!extraElementMap.has(elId)) continue;
          const assContent = buildAssContent({
            captions: renderCaptions,
            style: project.subtitleStyle,
            videoWidth: width,
            videoHeight: height,
            totalDuration: totalDur,
            includeMainCaptions: false,
            includeExtraElements: true,
            onlyExtraElementIds: [elId],
          });
          const assMem = `subs_el_${layerStep}.ass`;
          await writeTemp(assMem, assContent);
          const outLabel = `v_tx_${layerStep}`;
          filterSteps.push(`[${currentV}]ass='${assMem}'${fontsOpt}[${outLabel}]`);
          currentV = outLabel;
        }
      }

      const audioRes = buildAudioMixMemfs({
        hasSourceAudio: Boolean(project.metadata!.hasAudio),
        duration: totalDur,
        originalDuration: origDur,
        holds: activeSyncPlan?.holds,
        videoClips,
        originalAudioClips: origAudioClips,
        voice: project.voice,
        applyDubbing: exportSettings.applyDubbing,
        applyAudioMix: exportSettings.applyAudioMix,
        nextInputIndex: nextInputIdx,
        memfsPaths,
      });
      extraInputs.push(...audioRes.extraInputs);
      filterSteps.push(...audioRes.filterSteps);

      const args = ['-i', srcMem, ...extraInputs, '-filter_complex', filterSteps.join(';'), '-map', `[${currentV}]`];
      if (audioRes.audioMapLabel) {
        args.push('-map', audioRes.audioMapLabel, '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2');
      } else {
        args.push('-an');
      }
      args.push(
        '-c:v', 'libx264',
        '-profile:v', 'main',
        '-level', '4.0',
        '-preset', 'veryfast',
        '-crf', '21',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        outFilename
      );

      onProgress(12, 'Encoding MP4 video frames in browser WebAssembly', null);
      const startedAt = Date.now();
      let lastLogs = '';
      const onLog = ({ message }: { message: string }) => {
        lastLogs = `${lastLogs}\n${message}`.slice(-2000);
      };
      const onProg = ({ progress }: { progress: number }) => {
        const clamped = Math.max(0, Math.min(1, Number(progress || 0)));
        const pct = Math.min(97, Math.max(12, Math.round(12 + clamped * 85)));
        const elapsed = (Date.now() - startedAt) / 1000;
        const eta = clamped > 0.03 ? Math.max(1, Math.round((elapsed / clamped) * (1 - clamped))) : null;
        onProgress(pct, 'Rendering MP4 video in browser', eta);
      };

      ff.on('log', onLog);
      ff.on('progress', onProg);
      try {
        const exitCode = await ff.exec(args);
        if (exitCode !== 0) {
          throw new Error(`Browser FFmpeg export failed (exit ${exitCode}): ${lastLogs.slice(-500)}`);
        }
        const rawOut = (await ff.readFile(outFilename)) as Uint8Array;
        if (!rawOut || rawOut.byteLength < 1024) {
          throw new Error('Rendered MP4 is empty or incomplete.');
        }
        return new Uint8Array(rawOut);
      } finally {
        ff.off('log', onLog);
        ff.off('progress', onProg);
      }
    } finally {
      for (const f of tempFiles) {
        await safeDeleteMemfsFile(ff, f);
      }
      await safeDeleteMemfsFile(ff, outFilename);
    }
  });

  const blob = new Blob([mp4Bytes], { type: 'video/mp4' });
  onProgress(100, 'Export completed', 0);
  return {
    blob,
    filename: outFilename,
    sizeBytes: blob.size,
  };
}
