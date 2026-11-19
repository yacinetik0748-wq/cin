import { BlurEffect, TrackingKeyframe } from '../../src/types/studio.ts';
import { getAssetByUrl } from '../db.ts';

export interface BlurFilterResult {
  extraInputs: string[];
  filterSteps: string[];
  currentLabel: string;
  nextInputIndex?: number;
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
    if (i === 0) {
      expr = `if(lt(t,${t0}),${v0},if(lt(t,${t1}),${interp},${expr}))`;
    } else {
      expr = `if(lt(t,${t1}),${interp},${expr})`;
    }
  }
  return expr;
}

export interface BlurRenderOverride {
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

function buildEnableExpr(
  blur: BlurEffect,
  intervals?: Array<{ start: number; end: number }>
): string {
  const list =
    intervals && intervals.length > 0
      ? intervals
      : [{ start: Math.max(0, blur.startTime), end: Math.max(blur.startTime + 0.1, blur.endTime) }];
  return list
    .map((iv) => {
      const s = Math.max(0, iv.start).toFixed(3);
      const e = Math.max(iv.start + 0.08, iv.end).toFixed(3);
      return `between(t,${s},${e})`;
    })
    .join('+');
}

function buildMaskAlphaFilter(blur: BlurEffect, patchW?: number, patchH?: number): string {
  const opacity = Math.max(0.05, Math.min(1, blur.opacity ?? 1));
  const opacityInt = Math.round(opacity * 255);
  const needsEllipse = blur.shape === 'ellipse';
  const featherPct = Math.max(0, Math.min(0.45, (blur.feather ?? (needsEllipse ? 12 : 4)) / 100));
  const radiusRaw = Math.max(0, Math.min(48, Number(blur.borderRadius ?? 0)));

  if (!needsEllipse && featherPct <= 0.005 && radiusRaw <= 0.5) {
    return opacity < 0.99
      ? `,format=rgba,colorchannelmixer=aa=${opacity.toFixed(2)}`
      : '';
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
    // Pure rectangular smooth edge feathering
    const fRatio = featherPct.toFixed(3);
    return `,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='round(${opacityInt}*min(1,min(min(X,W-1-X)/max(1,W*${fRatio}),min(Y,H-1-Y)/max(1,H*${fRatio}))))'`;
  }

  // Exact rounded-rectangle SDF alpha with optional edge feathering
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

export function buildBlurFilters(params: {
  blurs: BlurEffect[];
  startLabel: string;
  targetWidth: number;
  targetHeight: number;
  nextInputIndex: number;
  labelPrefix?: string;
  overrides?: Record<string, BlurRenderOverride>;
}): BlurFilterResult {
  const enabledBlurs = params.blurs.filter((b) => b.enabled);
  const extraInputs: string[] = [];
  const filterSteps: string[] = [];
  let currentLabel = params.startLabel;
  let inputIdx = params.nextInputIndex;
  let stepCounter = 0;
  const pfx = params.labelPrefix || 'b';

  for (const blur of enabledBlurs) {
    const ov = params.overrides?.[blur.id];
    if (ov?.mappedRect?.visible === false) continue;
    if (ov?.intervals && ov.intervals.length === 0) continue;

    const enableExpr = buildEnableExpr(blur, ov?.intervals);
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

      const pw = Math.min(
        params.targetWidth,
        Math.max(16, Math.round(rw * params.targetWidth) & ~1)
      );
      const ph = Math.min(
        params.targetHeight,
        Math.max(16, Math.round(rh * params.targetHeight) & ~1)
      );
      const px = Math.max(
        0,
        Math.min(params.targetWidth - pw, Math.round(rx * params.targetWidth))
      );
      const py = Math.max(
        0,
        Math.min(params.targetHeight - ph, Math.round(ry * params.targetHeight))
      );

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

      const pw = Math.min(
        params.targetWidth,
        Math.max(24, Math.round((kfs[0].width || blur.width) * params.targetWidth) & ~1)
      );
      const ph = Math.min(
        params.targetHeight,
        Math.max(24, Math.round((kfs[0].height || blur.height) * params.targetHeight) & ~1)
      );

      const xExpr = buildPiecewiseExpr(
        kfs,
        (k) => Math.max(0, Math.min(1 - k.width, k.x)),
        params.targetWidth
      );
      const yExpr = buildPiecewiseExpr(
        kfs,
        (k) => Math.max(0, Math.min(1 - k.height, k.y)),
        params.targetHeight
      );

      const base = `${pfx}_mbase_${stepCounter}`;
      const fullBlur = `${pfx}_mblur_${stepCounter}`;
      const cropBox = `${pfx}_mcrop_${stepCounter}`;
      const out = `${pfx}_mot_${stepCounter}`;

      const clampedCropX = `max(0,min(iw-${pw},${xExpr}))`;
      const clampedCropY = `max(0,min(ih-${ph},${yExpr}))`;
      const clampedOverlayX = `max(0,min(W-${pw},${xExpr}))`;
      const clampedOverlayY = `max(0,min(H-${ph},${yExpr}))`;

      const maskStep = buildMaskAlphaFilter(blur, pw, ph);
      filterSteps.push(`[${currentLabel}]split[${base}][${fullBlur}]`);
      filterSteps.push(
        `[${fullBlur}]${makeBlurExpr(blur, params.targetWidth, params.targetHeight)},crop=w=${pw}:h=${ph}:x='${clampedCropX}':y='${clampedCropY}'${maskStep}[${cropBox}]`
      );
      filterSteps.push(
        `[${base}][${cropBox}]overlay=x='${clampedOverlayX}':y='${clampedOverlayY}':enable='${enableExpr}'[${out}]`
      );
      currentLabel = out;
    } else if (blur.mode === 'background') {
      const maskAsset = blur.maskAssetId ? getAssetByUrl(blur.maskAssetId) : null;
      const blurFilter = makeBlurExpr(blur, params.targetWidth, params.targetHeight);
      if (maskAsset) {
        const maskIdx = inputIdx++;
        extraInputs.push('-loop', '1', '-i', maskAsset.file_path);

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
        filterSteps.push(
          `[${maskIdx}:v]scale=${params.targetWidth}:${params.targetHeight},format=gray[${maskScaled}]`
        );
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

  return {
    extraInputs,
    filterSteps,
    currentLabel,
    nextInputIndex: inputIdx,
  };
}
