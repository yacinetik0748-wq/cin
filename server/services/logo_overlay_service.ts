import fs from 'fs';
import { LogoOverlay } from '../../src/types/studio.ts';
import { getAssetByUrl } from '../db.ts';

export interface LogoFilterResult {
  extraInputs: string[];
  filterSteps: string[];
  currentLabel: string;
  nextInputIndex: number;
}

function buildMotionExpressions(
  logo: LogoOverlay,
  px: number,
  py: number,
  targetWidth: number,
  targetHeight: number
): { xExpr: string; yExpr: string } {
  const m = logo.motion;
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
    return {
      xExpr: `abs(mod(${px}+t*${vx},max(2,2*(W-w)))-max(1,W-w))`,
      yExpr: String(py),
    };
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

export function buildLogoOverlayFilters(params: {
  logos: LogoOverlay[];
  startLabel: string;
  targetWidth: number;
  targetHeight: number;
  nextInputIndex: number;
  labelPrefix?: string;
}): LogoFilterResult {
  const extraInputs: string[] = [];
  const filterSteps: string[] = [];
  let currentLabel = params.startLabel;
  let inputIdx = params.nextInputIndex;
  let counter = 0;
  const pfx = params.labelPrefix || 'logo';

  for (const logo of params.logos.filter((l) => l.enabled)) {
    const asset = getAssetByUrl(logo.url);
    if (!asset || !fs.existsSync(asset.file_path)) continue;

    counter += 1;
    const idx = inputIdx++;
    extraInputs.push('-i', asset.file_path);

    const targetW = Math.max(24, Math.round((logo.widthPct / 100) * params.targetWidth) & ~1);
    const opacity = Math.max(0.05, Math.min(1, logo.opacity)).toFixed(2);
    const px = Math.max(0, Math.round(logo.x * params.targetWidth));
    const py = Math.max(0, Math.round(logo.y * params.targetHeight));

    const { xExpr, yExpr } = buildMotionExpressions(
      logo,
      px,
      py,
      params.targetWidth,
      params.targetHeight
    );

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

  return {
    extraInputs,
    filterSteps,
    currentLabel,
    nextInputIndex: inputIdx,
  };
}
