import {
  ColorFilterPreset,
  FilterLayerItem,
  VideoClip,
  VideoEffectsConfig,
  VisualEffectItem,
} from '../../src/types/studio.ts';
import { normalizeFilterPresetId } from '../../src/lib/videoFiltersCatalog.ts';
import { getVideoClipTimelineEnd } from '../../src/lib/videoTimeline.ts';

function buildIntervalEnableExpr(intervals: Array<{ start: number; end: number }>): string | null {
  const valid = intervals.filter((iv) => iv.end > iv.start + 0.01);
  if (valid.length === 0) return null;
  return valid
    .map((iv) => `between(t,${Math.max(0, iv.start).toFixed(3)},${iv.end.toFixed(3)})`)
    .join('+');
}

export function buildVideoEffectsFilters(params: {
  config: VideoEffectsConfig;
  startLabel: string;
  outputLabel: string;
  duration?: number;
  width?: number;
  height?: number;
  videoClips?: VideoClip[];
}): { filterSteps: string[]; currentLabel: string } {
  const { config, startLabel, outputLabel, duration, width, height, videoClips } = params;
  const filterSteps: string[] = [];
  let cur = startLabel;

  if (config.compareMode) {
    return { filterSteps: [], currentLabel: startLabel };
  }

  const adj = config.adjustments;
  const hasAdjustments = Object.values(adj || {}).some((v) => Number(v || 0) !== 0);
  const globalPreset = normalizeFilterPresetId(config.filterPreset);
  const globalIntensity = Math.max(0, Math.min(100, Number(config.filterIntensity ?? 100)));
  const hasGlobalPreset = globalPreset !== 'none' && globalIntensity > 0.5;
  const activeFilterStack: FilterLayerItem[] = (config.filterStack || []).filter(
    (f) => f.enabled && normalizeFilterPresetId(f.preset) !== 'none' && (f.intensity ?? 100) > 0.5
  );
  const clipCustomFilters = (videoClips || []).filter(
    (c) =>
      c.filterPreset &&
      normalizeFilterPresetId(c.filterPreset) !== 'none' &&
      (c.filterIntensity ?? 100) > 0.5
  );
  const activeEffects = (config.effects || []).filter(
    (e) => e.enabled && e.intensity > 0 && (e.opacity ?? 1) > 0.01
  );

  if (
    !hasAdjustments &&
    !hasGlobalPreset &&
    activeFilterStack.length === 0 &&
    clipCustomFilters.length === 0 &&
    activeEffects.length === 0
  ) {
    return { filterSteps: [], currentLabel: startLabel };
  }

  let stepIdx = 0;
  const nextLabel = (prefix: string) => `fx_${prefix}_${stepIdx++}`;
  const totalLen = Math.max(0.5, duration || 12);

  const applyPresetWithIntensity = (
    inLbl: string,
    preset: ColorFilterPreset,
    intensityPct: number,
    enableExpr?: string | null
  ): string => {
    const filterStr = getFilterPresetString(preset);
    if (!filterStr || intensityPct <= 0.5) return inLbl;
    const k = Math.max(0, Math.min(1, intensityPct / 100));
    if (k >= 0.985 && !enableExpr) {
      const out = nextLabel('preset');
      filterSteps.push(`[${inLbl}]${filterStr}[${out}]`);
      return out;
    }
    const base = nextLabel('pbase');
    const wet = nextLabel('pwet');
    const filtered = nextLabel('pfilt');
    const out = nextLabel('pblend');
    filterSteps.push(`[${inLbl}]split[${base}][${wet}]`);
    filterSteps.push(`[${wet}]${filterStr}[${filtered}]`);
    if (k >= 0.985 && enableExpr) {
      filterSteps.push(`[${base}][${filtered}]overlay=0:0:enable='${enableExpr}'[${out}]`);
    } else {
      const dryWeight = (1 - k).toFixed(3);
      const enPart = enableExpr ? `:enable='${enableExpr}'` : '';
      filterSteps.push(
        `[${base}][${filtered}]blend=all_mode=normal:all_opacity=${dryWeight}${enPart}[${out}]`
      );
    }
    return out;
  };

  // 1. Global Color Filter Preset (when active)
  if (hasGlobalPreset) {
    cur = applyPresetWithIntensity(cur, globalPreset, globalIntensity);
  }

  // 1b. Independent Stacked / Timeline Filter Layers (filterStack)
  for (const fl of activeFilterStack) {
    const filterStr = getFilterPresetString(fl.preset);
    if (!filterStr) continue;

    let intervals: Array<{ start: number; end: number }> = [];
    if (fl.clipIds && fl.clipIds.length > 0 && videoClips?.length) {
      intervals = videoClips
        .filter((vc) => fl.clipIds!.includes(vc.id))
        .map((vc) => ({
          start: Math.max(0, Number(vc.timelineStart || 0)),
          end: Math.max(Number(vc.timelineStart || 0) + 0.05, getVideoClipTimelineEnd(vc)),
        }));
    } else {
      const s = Math.max(0, Number(fl.startTime || 0));
      const e = fl.endTime && fl.endTime > s ? Math.min(totalLen, fl.endTime) : totalLen;
      if (s > 0.02 || (fl.endTime && fl.endTime > s && e < totalLen - 0.04)) {
        intervals = [{ start: s, end: e }];
      }
    }

    const enableExpr = buildIntervalEnableExpr(intervals);
    if (enableExpr) {
      cur = applyPresetWithIntensity(cur, fl.preset, fl.intensity ?? 100, enableExpr);
    } else if (!fl.clipIds?.length) {
      cur = applyPresetWithIntensity(cur, fl.preset, fl.intensity ?? 100);
    }
  }

  // 1c. Per-clip Color Filter overrides (bounded cleanly by clip timeline interval)
  for (const clip of clipCustomFilters) {
    const filterStr = getFilterPresetString(clip.filterPreset!);
    if (!filterStr) continue;
    const tlStart = Math.max(0, Number(clip.timelineStart || 0));
    const tlEnd = Math.max(tlStart + 0.05, getVideoClipTimelineEnd(clip));
    cur = applyPresetWithIntensity(
      cur,
      clip.filterPreset!,
      clip.filterIntensity ?? 100,
      `between(t,${tlStart.toFixed(3)},${tlEnd.toFixed(3)})`
    );
  }

  // 2. Color Adjustments (Brightness, Contrast, Saturation, Exposure, Highlights, Shadows, Fade, Temperature, Tint, Sharpness, Vignette, Grain)
  if (adj && hasAdjustments) {
    const eqFilters: string[] = [];

    const totalBrightness = Math.max(
      -0.8,
      Math.min(0.8, ((adj.brightness || 0) + (adj.exposure || 0) * 0.7) / 250)
    );
    if (totalBrightness !== 0) {
      eqFilters.push(`brightness=${totalBrightness.toFixed(3)}`);
    }

    const totalContrast = Math.max(0.2, Math.min(2.2, 1.0 + (adj.contrast || 0) / 100));
    if (totalContrast !== 1.0) {
      eqFilters.push(`contrast=${totalContrast.toFixed(3)}`);
    }

    let totalSat = Math.max(0.0, Math.min(3.0, 1.0 + (adj.saturation || 0) / 100));
    if ((adj.fade || 0) > 0) {
      totalSat *= Math.max(0.4, 1.0 - ((adj.fade || 0) / 100) * 0.4);
    }
    if (totalSat !== 1.0) {
      eqFilters.push(`saturation=${totalSat.toFixed(3)}`);
    }

    if (eqFilters.length > 0) {
      const eqLabel = nextLabel('eq');
      filterSteps.push(`[${cur}]eq=${eqFilters.join(':')}[${eqLabel}]`);
      cur = eqLabel;
    }

    if ((adj.fade || 0) > 0 || (adj.highlights || 0) !== 0 || (adj.shadows || 0) !== 0) {
      const blackLift = Math.max(0, Math.min(0.24, ((adj.fade || 0) / 100) * 0.22));
      const shadowY = Math.max(
        blackLift + 0.04,
        Math.min(0.6, 0.25 + (adj.shadows || 0) / 450 + blackLift * 0.45)
      );
      const highlightY = Math.max(
        shadowY + 0.1,
        Math.min(0.98, 0.75 + (adj.highlights || 0) / 450)
      );
      const curvePts = `0/${blackLift.toFixed(3)} 0.25/${shadowY.toFixed(3)} 0.75/${highlightY.toFixed(3)} 1/1`;
      const curveLabel = nextLabel('curves');
      filterSteps.push(`[${cur}]curves=master='${curvePts}'[${curveLabel}]`);
      cur = curveLabel;
    }

    const tempNorm = (adj.temperature || 0) / 100;
    const tintNorm = (adj.tint || 0) / 100;
    if (tempNorm !== 0 || tintNorm !== 0) {
      const rm = (tempNorm * 0.25 + tintNorm * 0.1).toFixed(3);
      const gm = (-tintNorm * 0.2).toFixed(3);
      const bm = (-tempNorm * 0.25 + tintNorm * 0.1).toFixed(3);
      const cbLabel = nextLabel('temp');
      filterSteps.push(`[${cur}]colorbalance=rm=${rm}:gm=${gm}:bm=${bm}[${cbLabel}]`);
      cur = cbLabel;
    }

    if ((adj.sharpness || 0) > 0) {
      const sharpAmt = Math.min(2.5, ((adj.sharpness || 0) / 100) * 2.0).toFixed(2);
      const sharpLabel = nextLabel('sharp');
      filterSteps.push(`[${cur}]unsharp=5:5:${sharpAmt}:5:5:0.0[${sharpLabel}]`);
      cur = sharpLabel;
    }

    if ((adj.vignette || 0) > 0) {
      const vigAngle = (0.2 + ((adj.vignette || 0) / 100) * 0.6).toFixed(2);
      const vigLabel = nextLabel('vig');
      filterSteps.push(`[${cur}]vignette=PI*${vigAngle}[${vigLabel}]`);
      cur = vigLabel;
    }

    if ((adj.grain || 0) > 0) {
      const grainAmt = Math.max(2, Math.round(((adj.grain || 0) / 100) * 28));
      const grainLabel = nextLabel('adjgrain');
      filterSteps.push(`[${cur}]noise=alls=${grainAmt}:allf=t+u[${grainLabel}]`);
      cur = grainLabel;
    }
  }

  // 3. Visual Effects & Transitions (supports full-timeline, explicit [startTime..endTime] intervals, or clipId binding + opacity blend)
  for (const fx of activeEffects) {
    let startT = Math.max(0, fx.startTime || 0);
    let endT = fx.endTime && fx.endTime > startT ? fx.endTime : 0;

    if (fx.clipId && videoClips?.length) {
      const bound = videoClips.find((c) => c.id === fx.clipId);
      if (bound) {
        const cStart = Math.max(0, bound.timelineStart || 0);
        const cEnd = getVideoClipTimelineEnd(bound);
        if (startT <= 0.01 && endT <= 0.01) {
          startT = cStart;
          endT = cEnd;
        } else {
          startT = Math.max(cStart, startT);
          endT = endT > startT ? Math.min(cEnd, endT) : cEnd;
        }
      }
    }

    const resolvedEnd = endT > startT ? Math.min(totalLen, endT) : totalLen;
    const isTimed =
      startT > 0.02 || (endT > startT && (!duration || resolvedEnd < duration - 0.05));
    const opacity = Math.max(0.05, Math.min(1, Number(fx.opacity ?? 1)));
    const enableExpr = isTimed
      ? `between(t,${startT.toFixed(3)},${resolvedEnd.toFixed(3)})`
      : null;

    if (enableExpr && opacity < 0.98) {
      const dry = nextLabel('dry');
      const wetIn = nextLabel('wet');
      const fxSteps = getVisualEffectFilter(
        fx,
        wetIn,
        nextLabel,
        width,
        height,
        startT,
        resolvedEnd,
        enableExpr
      );
      if (fxSteps) {
        const opOut = nextLabel('opm');
        filterSteps.push(`[${cur}]split[${dry}][${wetIn}]`);
        filterSteps.push(...fxSteps.steps);
        filterSteps.push(
          `[${dry}][${fxSteps.lastLabel}]blend=all_mode=normal:all_opacity=${(1 - opacity).toFixed(3)}:enable='${enableExpr}'[${opOut}]`
        );
        cur = opOut;
      }
    } else if (enableExpr) {
      const fxSelfTimed = getVisualEffectFilter(
        fx,
        cur,
        nextLabel,
        width,
        height,
        startT,
        resolvedEnd,
        enableExpr
      );
      if (fxSelfTimed?.selfTimed) {
        filterSteps.push(...fxSelfTimed.steps);
        cur = fxSelfTimed.lastLabel;
      } else {
        const dry = nextLabel('dry');
        const wetIn = nextLabel('wet');
        const fxSteps = getVisualEffectFilter(
          fx,
          wetIn,
          nextLabel,
          width,
          height,
          startT,
          resolvedEnd,
          enableExpr
        );
        if (fxSteps) {
          const timedOut = nextLabel('fxt');
          filterSteps.push(`[${cur}]split[${dry}][${wetIn}]`);
          filterSteps.push(...fxSteps.steps);
          filterSteps.push(
            `[${dry}][${fxSteps.lastLabel}]overlay=0:0:enable='${enableExpr}'[${timedOut}]`
          );
          cur = timedOut;
        }
      }
    } else if (opacity < 0.98) {
      const dry = nextLabel('fopd');
      const wetIn = nextLabel('fopw');
      const fxSteps = getVisualEffectFilter(fx, wetIn, nextLabel, width, height, 0, totalLen, null);
      if (fxSteps) {
        const opOut = nextLabel('fop');
        filterSteps.push(`[${cur}]split[${dry}][${wetIn}]`);
        filterSteps.push(...fxSteps.steps);
        filterSteps.push(
          `[${dry}][${fxSteps.lastLabel}]blend=all_mode=normal:all_opacity=${(1 - opacity).toFixed(3)}[${opOut}]`
        );
        cur = opOut;
      }
    } else {
      const fxSteps = getVisualEffectFilter(fx, cur, nextLabel, width, height, 0, totalLen, null);
      if (fxSteps) {
        filterSteps.push(...fxSteps.steps);
        cur = fxSteps.lastLabel;
      }
    }
  }

  if (cur !== outputLabel) {
    filterSteps.push(`[${cur}]null[${outputLabel}]`);
    cur = outputLabel;
  }

  return { filterSteps, currentLabel: cur };
}

function getFilterPresetString(rawPreset: ColorFilterPreset): string | null {
  const preset = normalizeFilterPresetId(rawPreset);
  switch (preset) {
    // === CINEMATIC ===
    case 'cinematic':
      return 'colorbalance=rs=-0.08:gs=0.03:bs=0.12:rm=0.14:gm=0.04:bm=-0.08:rh=0.08:gh=0.02:bh=-0.06,eq=contrast=1.18:saturation=1.12,vignette=PI/4';
    case 'teal-orange':
      return 'colorbalance=rs=-0.16:gs=0.04:bs=0.18:rm=0.08:gm=0.01:bm=-0.10:rh=0.18:gh=0.06:bh=-0.16,eq=contrast=1.22:saturation=1.24,vignette=PI/4.2';
    case 'hollywood':
      return 'colorbalance=rs=-0.06:gs=0.0:bs=0.10:rm=0.16:gm=0.05:bm=-0.10:rh=0.12:gh=0.04:bh=-0.08,eq=contrast=1.25:brightness=-0.02:saturation=1.14,vignette=PI/3.8';
    case 'film-look':
      return 'colorbalance=rm=0.06:gm=0.02:bm=-0.04:rs=-0.04:gs=-0.02:bs=0.06,curves=master=\'0/0.03 0.25/0.24 0.75/0.77 1/0.97\',eq=contrast=1.12:saturation=1.05';
    case 'movie-warm':
      return 'colorbalance=rm=0.20:gm=0.06:bm=-0.14:rh=0.16:gh=0.05:bh=-0.12,eq=contrast=1.16:saturation=1.16,vignette=PI/4.2';
    case 'movie-cold':
      return 'colorbalance=rm=-0.18:gm=-0.02:bm=0.24:rs=-0.10:gs=0.02:bs=0.18,eq=contrast=1.18:brightness=-0.03:saturation=0.88,vignette=PI/4.0';
    case 'dramatic':
      return 'colorbalance=rs=-0.10:bs=0.08:rh=0.10:bh=-0.08,eq=contrast=1.36:brightness=-0.06:saturation=1.14,vignette=PI/3.4';
    case 'dark-cinematic':
      return 'colorbalance=rs=-0.12:gs=-0.06:bs=0.06:rm=-0.05:gm=-0.04:bm=0.08,eq=contrast=1.30:brightness=-0.14:saturation=0.80,vignette=PI/3.1';
    case 'moody':
      return 'colorbalance=rm=-0.06:gm=0.02:bm=0.10:rs=-0.12:gs=-0.02:bs=0.06,eq=contrast=1.20:brightness=-0.09:saturation=0.78,vignette=PI/3.8';
    case 'epic':
      return 'colorbalance=rs=-0.12:gs=0.02:bs=0.14:rh=0.18:gh=0.08:bh=-0.12,eq=contrast=1.32:brightness=-0.04:saturation=1.22,vignette=PI/3.5';

    // === COLOR & LIGHTING ===
    case 'warm':
      return 'colorbalance=rm=0.22:gm=0.06:bm=-0.18:rh=0.15:gh=0.04:bh=-0.12,eq=contrast=1.06:brightness=0.02:saturation=1.16';
    case 'cool':
      return 'colorbalance=rm=-0.14:gm=-0.02:bm=0.20:rs=-0.06:gs=0.0:bs=0.12,eq=contrast=1.08:saturation=0.94';
    case 'vintage':
      return 'colorbalance=rm=0.18:gm=0.08:bm=-0.16,curves=master=\'0/0.06 0.5/0.52 1/0.94\',eq=contrast=0.92:brightness=0.03:saturation=0.76,vignette=PI/3.6';
    case 'faded':
      return 'curves=master=\'0/0.11 0.25/0.29 0.75/0.76 1/0.94\',eq=contrast=0.84:brightness=0.05:saturation=0.82';
    case 'bright':
      return 'eq=contrast=1.06:brightness=0.13:saturation=1.18';
    case 'contrast':
      return 'eq=contrast=1.22:saturation=1.08';
    case 'high-contrast':
      return 'eq=contrast=1.38:brightness=-0.03:saturation=1.15';
    case 'desaturated':
      return 'eq=contrast=1.08:saturation=0.52';
    case 'vibrant':
      return 'eq=contrast=1.14:brightness=0.02:saturation=1.46';
    case 'pastel':
      return 'colorbalance=rm=0.10:gm=-0.02:bm=0.12,curves=master=\'0/0.07 0.5/0.55 1/0.96\',eq=contrast=0.90:brightness=0.07:saturation=0.92';
    case 'golden-hour':
      return 'colorbalance=rm=0.24:gm=0.10:bm=-0.20:rh=0.20:gh=0.08:bh=-0.18,eq=contrast=1.10:brightness=0.04:saturation=1.24';
    case 'sunset':
      return 'colorbalance=rs=0.10:gs=-0.06:bs=0.06:rm=0.26:gm=0.02:bm=-0.14:rh=0.22:gh=-0.04:bh=0.04,eq=contrast=1.16:saturation=1.32,vignette=PI/4.5';

    // === FILM & RETRO ===
    case '35mm-film':
      return 'colorbalance=rm=0.08:gm=0.03:bm=-0.06:rs=-0.04:gs=0.0:bs=0.05,eq=contrast=1.14:saturation=1.05,noise=alls=7:allf=t+u';
    case '16mm-film':
      return 'colorbalance=rm=0.12:gm=0.05:bm=-0.10,curves=master=\'0/0.05 0.5/0.50 1/0.95\',eq=contrast=1.18:brightness=-0.02:saturation=0.90,noise=alls=14:allf=t+u,vignette=PI/3.8';
    case 'vhs':
      return 'rgbashift=rh=3:bh=-3,colorbalance=rs=0.08:gs=-0.04:bs=0.12:rm=0.06:bm=-0.04,eq=contrast=1.10:saturation=1.18,noise=alls=11:allf=t+u';
    case 'retro':
      return 'colorbalance=rs=0.08:gs=-0.06:bs=0.14:rm=0.16:gm=0.04:bm=-0.10,eq=contrast=1.14:brightness=0.02:saturation=1.24,vignette=PI/4.2';
    case 'old-film':
      return 'colorbalance=rm=0.18:gm=0.10:bm=-0.18,curves=master=\'0/0.07 0.5/0.52 1/0.92\',eq=contrast=1.08:saturation=0.55,noise=alls=18:allf=t+u,vignette=PI/3.2';
    case 'sepia':
      return 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131,eq=contrast=1.08,vignette=PI/4.2';
    case 'black-white':
      return 'hue=s=0,eq=contrast=1.28:brightness=-0.02';
    case 'noir':
      return 'hue=s=0,eq=contrast=1.50:brightness=-0.08,vignette=PI/2.8';
    case 'grainy-film':
      return 'colorbalance=rm=0.08:gm=0.04:bm=-0.06,curves=master=\'0/0.04 1/0.96\',eq=contrast=1.12:saturation=0.88,noise=alls=22:allf=t+u';
    case 'polaroid':
      return 'colorbalance=rs=0.02:gs=0.08:bs=-0.04:rm=0.12:gm=0.10:bm=-0.12,curves=master=\'0/0.06 0.5/0.54 1/0.95\',eq=contrast=0.96:brightness=0.04:saturation=0.94';

    // === SOCIAL MEDIA & TRENDING ===
    case 'instagram':
      return 'colorbalance=rm=0.12:gm=0.04:bm=-0.06:rh=0.10:gh=0.02:bh=-0.06,eq=contrast=1.12:brightness=0.04:saturation=1.22';
    case 'tiktok':
      return 'colorbalance=rs=-0.04:bs=0.08:rh=0.04:bh=0.06,eq=contrast=1.20:brightness=0.03:saturation=1.32,unsharp=5:5:0.4:5:5:0.0';
    case 'clean':
      return 'eq=contrast=1.07:brightness=0.03:saturation=1.06';
    case 'aesthetic':
      return 'colorbalance=rm=0.10:gm=-0.02:bm=0.10,curves=master=\'0/0.05 0.5/0.53 1/0.96\',eq=contrast=0.94:brightness=0.04:saturation=0.88';
    case 'soft-glow':
      return 'colorbalance=rh=0.12:gh=0.08:bh=-0.04,eq=contrast=0.98:brightness=0.08:saturation=1.10';
    case 'dreamy':
      return 'colorbalance=rm=0.08:gm=0.0:bm=0.14,curves=master=\'0/0.06 0.5/0.55 1/0.97\',eq=contrast=0.92:brightness=0.07:saturation=1.04';
    case 'neon':
      return 'hue=h=16,colorbalance=rs=0.10:bs=0.16:rm=0.08:bm=0.14,eq=contrast=1.24:saturation=1.54,vignette=PI/4.2';
    case 'cyberpunk':
      return 'hue=h=24,colorbalance=rs=-0.12:gs=0.08:bs=0.22:rh=0.18:gh=-0.08:bh=0.18,eq=contrast=1.30:brightness=-0.03:saturation=1.48,vignette=PI/3.6';
    case 'orange-blue':
      return 'colorbalance=rs=-0.18:gs=0.02:bs=0.22:rm=0.14:gm=0.04:bm=-0.12:rh=0.20:gh=0.06:bh=-0.18,eq=contrast=1.22:saturation=1.30';
    case 'viral':
      return 'eq=contrast=1.28:brightness=0.03:saturation=1.38,unsharp=5:5:0.5:5:5:0.0,vignette=PI/4.8';

    // === ADDITIONAL STYLES ===
    case 'portrait':
      return 'colorbalance=rm=0.10:gm=0.04:bm=-0.06:rh=0.08:gh=0.03:bh=-0.04,eq=contrast=1.05:brightness=0.04:saturation=1.08';
    case 'nature':
      return 'colorbalance=gs=0.04:gm=0.10:bm=-0.06:bh=0.08,eq=contrast=1.12:brightness=0.02:saturation=1.32';
    case 'night':
      return 'colorbalance=rs=-0.12:gs=-0.04:bs=0.20:rm=-0.08:bm=0.18,eq=contrast=1.22:brightness=-0.10:saturation=0.92,vignette=PI/3.3';
    case 'urban':
      return 'colorbalance=rs=-0.06:bs=0.10,eq=contrast=1.24:brightness=-0.03:saturation=0.78,vignette=PI/4.0';
    case 'sports':
      return 'eq=contrast=1.28:brightness=0.02:saturation=1.34,unsharp=5:5:0.45:5:5:0.0';
    case 'documentary':
      return 'colorbalance=rs=-0.04:bs=0.05,eq=contrast=1.10:saturation=0.88';
    case 'travel':
      return 'colorbalance=rs=-0.06:bs=0.08:rh=0.10:gh=0.04:bh=-0.04,eq=contrast=1.16:brightness=0.03:saturation=1.28';
    case 'wedding':
      return 'colorbalance=rm=0.08:gm=0.04:bm=0.02,curves=master=\'0/0.04 0.5/0.54 1/0.98\',eq=contrast=0.98:brightness=0.06:saturation=0.98';
    default:
      return null;
  }
}

function getVisualEffectFilter(
  fx: VisualEffectItem,
  inputLabel: string,
  nextLabel: (prefix: string) => string,
  width?: number,
  height?: number,
  intervalStart = 0,
  intervalEnd = 10,
  enableExpr: string | null = null
): { steps: string[]; lastLabel: string; selfTimed?: boolean } | null {
  const intensityNorm = Math.max(0.05, Math.min(1.0, fx.intensity / 100));
  const speedRate = Math.max(0.25, Math.min(3.5, Number(fx.speed ?? 1.0)));
  const span = Math.max(0.2, intervalEnd - intervalStart);
  const posX = Math.max(0.05, Math.min(0.95, Number(fx.posX ?? 0.5)));
  const posY = Math.max(0.05, Math.min(0.95, Number(fx.posY ?? 0.5)));
  const safeW = Math.max(64, width || 1280);
  const safeH = Math.max(64, height || 720);
  const enSuffix = enableExpr ? `:enable='${enableExpr}'` : '';
  const steps: string[] = [];

  const smallW = Math.max(32, Math.round(safeW / 4) & ~1);
  const smallH = Math.max(32, Math.round(safeH / 4) & ~1);
  const halfW = Math.max(48, Math.round(safeW / 2) & ~1);
  const halfH = Math.max(48, Math.round(safeH / 2) & ~1);

  switch (fx.type) {
    // === VISUAL EFFECTS ===
    case 'glow':
    case 'soft-glow':
    case 'bloom': {
      const split0 = nextLabel('g0');
      const split1 = nextLabel('g1');
      const blurred = nextLabel('gb');
      const out = nextLabel('glow');
      const sigma =
        fx.type === 'soft-glow'
          ? Math.max(5, Math.round(intensityNorm * 24))
          : fx.type === 'bloom'
          ? Math.max(4, Math.round(intensityNorm * 22))
          : Math.max(3, Math.round(intensityNorm * 18));
      const smallSigma = Math.max(1.5, Number((sigma / 4).toFixed(1)));
      const brightBoost = fx.type === 'bloom' ? 0.2 : fx.type === 'soft-glow' ? 0.1 : 0.14;
      const opacity = Math.min(0.88, Number((intensityNorm * (fx.type === 'bloom' ? 0.78 : 0.68)).toFixed(2)));
      steps.push(`[${inputLabel}]split[${split0}][${split1}]`);
      steps.push(
        `[${split1}]scale=${smallW}:${smallH}:flags=bilinear,gblur=sigma=${smallSigma}:steps=1,scale=${safeW}:${safeH}:flags=bilinear,eq=brightness=${brightBoost}${enSuffix}[${blurred}]`
      );
      steps.push(`[${split0}][${blurred}]blend=all_mode=screen:all_opacity=${opacity}${enSuffix}[${out}]`);
      return { steps, lastLabel: out, selfTimed: Boolean(enableExpr) };
    }
    case 'blur':
    case 'gaussian-blur': {
      const sigma = Math.max(1.5, Number((intensityNorm * (fx.type === 'gaussian-blur' ? 28 : 22)).toFixed(1)));
      const out = nextLabel('blur');
      if (sigma >= 9) {
        const halfSigma = Math.max(2, Number((sigma / 2).toFixed(1)));
        const blurChain = `scale=${halfW}:${halfH}:flags=bilinear,gblur=sigma=${halfSigma}:steps=2,scale=${safeW}:${safeH}:flags=bilinear,setsar=1`;
        if (enableExpr) {
          const s0 = nextLabel('bl0');
          const s1 = nextLabel('bl1');
          const bf = nextLabel('blf');
          steps.push(`[${inputLabel}]split[${s0}][${s1}]`);
          steps.push(`[${s1}]${blurChain}[${bf}]`);
          steps.push(`[${s0}][${bf}]overlay=0:0:enable='${enableExpr}'[${out}]`);
          return { steps, lastLabel: out, selfTimed: true };
        }
        steps.push(`[${inputLabel}]${blurChain}[${out}]`);
        return { steps, lastLabel: out };
      }
      steps.push(`[${inputLabel}]gblur=sigma=${sigma}:steps=1${enSuffix}[${out}]`);
      return { steps, lastLabel: out, selfTimed: Boolean(enableExpr) };
    }
    case 'motion-blur': {
      const out = nextLabel('mblur');
      const base = nextLabel('mb0');
      const blendedIn = nextLabel('mb1');
      const blendedOut = nextLabel('mbo');
      if (intensityNorm >= 0.85) {
        steps.push(`[${inputLabel}]tmix=frames=4:weights='1 2 3 4'${enSuffix}[${out}]`);
        return { steps, lastLabel: out, selfTimed: Boolean(enableExpr) };
      }
      steps.push(`[${inputLabel}]split[${base}][${blendedIn}]`);
      steps.push(`[${blendedIn}]tblend=all_mode=average${enSuffix}[${blendedOut}]`);
      steps.push(
        `[${base}][${blendedOut}]blend=all_mode=normal:all_opacity=${(1 - intensityNorm).toFixed(2)}${enSuffix}[${out}]`
      );
      return { steps, lastLabel: out, selfTimed: Boolean(enableExpr) };
    }
    case 'pixelate':
    case 'mosaic': {
      const out = nextLabel('pix');
      const block = Math.max(
        4,
        Math.min(
          64,
          Math.round(fx.blockSize ?? (fx.type === 'mosaic' ? 12 + intensityNorm * 32 : 6 + intensityNorm * 26))
        )
      );
      const downW = Math.max(16, Math.round(safeW / block));
      const downH = Math.max(16, Math.round(safeH / block));
      steps.push(
        `[${inputLabel}]scale=${downW}:${downH}:flags=neighbor,scale=${safeW}:${safeH}:flags=neighbor,setsar=1[${out}]`
      );
      return { steps, lastLabel: out };
    }
    case 'sharpen': {
      const amount = Math.max(0.3, Number((intensityNorm * 2.4).toFixed(2)));
      const out = nextLabel('sharp');
      steps.push(`[${inputLabel}]unsharp=5:5:${amount}:5:5:0.0${enSuffix}[${out}]`);
      return { steps, lastLabel: out, selfTimed: Boolean(enableExpr) };
    }
    case 'vignette': {
      const angle = (0.15 + intensityNorm * 0.65).toFixed(2);
      const out = nextLabel('vigfx');
      steps.push(`[${inputLabel}]vignette=PI*${angle}${enSuffix}[${out}]`);
      return { steps, lastLabel: out, selfTimed: Boolean(enableExpr) };
    }
    case 'chromatic-aberration':
    case 'rgb-split': {
      const out = nextLabel('rgbsplit');
      const shift = Math.max(
        2,
        Math.round(intensityNorm * (fx.type === 'chromatic-aberration' ? 12 : 20))
      );
      steps.push(
        `[${inputLabel}]rgbashift=rh=${shift}:bh=${-shift}:bv=${-Math.max(1, Math.round(shift * 0.45))}${enSuffix}[${out}]`
      );
      return { steps, lastLabel: out, selfTimed: Boolean(enableExpr) };
    }
    case 'glitch':
    case 'rgb-glitch':
    case 'digital-glitch':
    case 'glitch-transition': {
      const out = nextLabel('glitch');
      const shift = Math.max(4, Math.round(intensityNorm * (fx.type === 'glitch-transition' ? 28 : 22)));
      const grain = Math.max(4, Math.round(intensityNorm * 24));
      const base = nextLabel('gl0');
      const wet = nextLabel('gl1');
      const shifted = nextLabel('gls');
      const period = Math.max(0.2, 1.0 / speedRate);
      const burstDur =
        fx.type === 'glitch-transition' ? period : Math.max(0.08, period * 0.28);
      const burstExpr = `lt(mod(t,${period.toFixed(2)}),${burstDur.toFixed(2)})`;
      const combinedEn = enableExpr ? `(${enableExpr})*${burstExpr}` : burstExpr;
      steps.push(`[${inputLabel}]split[${base}][${wet}]`);
      if (fx.type === 'digital-glitch') {
        const blk = Math.max(6, Math.round(fx.blockSize ?? 8 + intensityNorm * 14));
        const dw = Math.max(16, Math.round(safeW / blk));
        const dh = Math.max(16, Math.round(safeH / blk));
        steps.push(
          `[${wet}]scale=${dw}:${dh}:flags=neighbor,scale=${safeW}:${safeH}:flags=neighbor,rgbashift=rh=${shift}:bh=${-shift}${enSuffix},noise=alls=${grain}:allf=t${enSuffix}[${shifted}]`
        );
      } else {
        steps.push(
          `[${wet}]rgbashift=rh=${shift}:bh=${-shift}:rv=${Math.max(2, Math.round(shift * 0.45))}${enSuffix},noise=alls=${grain}:allf=t${enSuffix}[${shifted}]`
        );
      }
      steps.push(
        `[${base}][${shifted}]overlay=0:0:enable='${combinedEn}'[${out}]`
      );
      return { steps, lastLabel: out, selfTimed: Boolean(enableExpr) };
    }
    case 'distortion':
    case 'lens-distortion': {
      const out = nextLabel('lens');
      const k1 = Number((-0.08 - intensityNorm * (fx.type === 'lens-distortion' ? 0.36 : 0.28)).toFixed(3));
      const k2 = Number((k1 * 0.25).toFixed(3));
      steps.push(
        `[${inputLabel}]lenscorrection=cx=${posX.toFixed(2)}:cy=${posY.toFixed(2)}:k1=${k1}:k2=${k2}${enSuffix}[${out}]`
      );
      return { steps, lastLabel: out, selfTimed: Boolean(enableExpr) };
    }
    case 'light-leaks':
    case 'lens-flare':
    case 'film-burn': {
      const out = nextLabel('flare');
      const s0 = nextLabel('flr0');
      const s1 = nextLabel('flr1');
      const warm = fx.type === 'lens-flare' ? 0.58 : fx.type === 'film-burn' ? 0.74 : 0.64;
      const amp = Number((intensityNorm * warm).toFixed(2));
      const vigAngle = (Math.PI * (0.28 + intensityNorm * 0.14)).toFixed(3);
      steps.push(`[${inputLabel}]split[${s0}][${s1}]`);
      steps.push(
        `[${s1}]scale=${smallW}:${smallH}:flags=bilinear,eq=brightness=${(0.2 + intensityNorm * 0.25).toFixed(2)}:contrast=1.12,colorbalance=rh=0.38:gh=0.14:bh=-0.18,vignette=angle=${vigAngle}:x0=w*${posX.toFixed(2)}:y0=h*${posY.toFixed(2)}:mode=forward:eval=init,scale=${safeW}:${safeH}:flags=bilinear,setsar=1[${out}_glow]`
      );
      steps.push(
        `[${s0}][${out}_glow]blend=all_mode=screen:all_opacity=${amp}${enSuffix}[${out}]`
      );
      return { steps, lastLabel: out, selfTimed: Boolean(enableExpr) };
    }
    case 'background-blur': {
      const s0 = nextLabel('bg0');
      const s1 = nextLabel('bg1');
      const blurred = nextLabel('bgb');
      const fgCrop = nextLabel('bgfg');
      const comp = nextLabel('bgcomp');
      const out = nextLabel('bgfocus');
      const sigma = Math.max(4, Math.round(intensityNorm * 24));
      const smallSigma = Math.max(1.5, Number((sigma / 4).toFixed(1)));
      const fw = Math.max(32, Math.round(safeW * 0.52) & ~1);
      const fh = Math.max(32, Math.round(safeH * 0.52) & ~1);
      const fxPos = Math.max(0, Math.min(safeW - fw, Math.round(safeW * posX - fw / 2)));
      const fyPos = Math.max(0, Math.min(safeH - fh, Math.round(safeH * posY - fh / 2)));
      if (enableExpr) {
        const dry = nextLabel('bgdry');
        steps.push(`[${inputLabel}]split=3[${dry}][${s0}][${s1}]`);
        steps.push(
          `[${s1}]scale=${smallW}:${smallH}:flags=bilinear,gblur=sigma=${smallSigma}:steps=1,scale=${safeW}:${safeH}:flags=bilinear,setsar=1[${blurred}]`
        );
        steps.push(`[${s0}]crop=${fw}:${fh}:${fxPos}:${fyPos}[${fgCrop}]`);
        steps.push(`[${blurred}][${fgCrop}]overlay=${fxPos}:${fyPos}[${comp}]`);
        steps.push(`[${dry}][${comp}]overlay=0:0:enable='${enableExpr}'[${out}]`);
        return { steps, lastLabel: out, selfTimed: true };
      }
      steps.push(`[${inputLabel}]split[${s0}][${s1}]`);
      steps.push(
        `[${s1}]scale=${smallW}:${smallH}:flags=bilinear,gblur=sigma=${smallSigma}:steps=1,scale=${safeW}:${safeH}:flags=bilinear,setsar=1[${blurred}]`
      );
      steps.push(`[${s0}]crop=${fw}:${fh}:${fxPos}:${fyPos}[${fgCrop}]`);
      steps.push(`[${blurred}][${fgCrop}]overlay=${fxPos}:${fyPos}[${out}]`);
      return { steps, lastLabel: out };
    }

    // === CINEMATIC EFFECTS ===
    case 'film-grain':
    case 'dust':
    case 'scratches': {
      const amt = Math.max(
        3,
        Math.round(intensityNorm * (fx.type === 'dust' ? 28 : fx.type === 'scratches' ? 22 : 32))
      );
      const out = nextLabel('grain');
      if (fx.type === 'scratches') {
        const s0 = nextLabel('sc0');
        const s1 = nextLabel('sc1');
        const noised = nextLabel('scn');
        const line = nextLabel('scl');
        steps.push(`[${inputLabel}]split[${s0}][${s1}]`);
        steps.push(
          `[${s0}]noise=alls=${amt}:allf=t+u${enSuffix},eq=contrast=1.06:saturation=0.92${enSuffix}[${noised}]`
        );
        steps.push(`[${s1}]crop=2:${safeH}:0:0,format=yuva420p,drawbox=t=fill:c=white@0.48[${line}]`);
        steps.push(
          `[${noised}][${line}]overlay=x='W*(0.15+0.7*abs(sin(t*${(speedRate * 3.1).toFixed(2)})))':y=0${enSuffix}[${out}]`
        );
      } else {
        steps.push(`[${inputLabel}]noise=alls=${amt}:allf=${fx.type === 'dust' ? 't+p' : 't+u'}${enSuffix}[${out}]`);
      }
      return { steps, lastLabel: out, selfTimed: Boolean(enableExpr) };
    }
    case 'light-flash':
    case 'retro-flash':
    case 'beat-flash':
    case 'flash': {
      const out = nextLabel('flash');
      const base = nextLabel('fl0');
      const wet = nextLabel('fl1');
      const flashed = nextLabel('flb');
      const period = Math.max(0.22, 1.0 / speedRate);
      const onDur = Math.max(0.06, Math.min(0.24, period * 0.22));
      const amp = Number((0.18 + intensityNorm * 0.56).toFixed(2));
      const tint =
        fx.type === 'retro-flash'
          ? `,colorbalance=rm=0.16:gm=0.06:bm=-0.12${enSuffix}`
          : '';
      const burstExpr = `lt(mod(t,${period.toFixed(2)}),${onDur.toFixed(2)})`;
      const combinedEn = enableExpr ? `(${enableExpr})*${burstExpr}` : burstExpr;
      steps.push(`[${inputLabel}]split[${base}][${wet}]`);
      steps.push(`[${wet}]eq=brightness=${amp}:contrast=1.12${enSuffix}${tint}[${flashed}]`);
      steps.push(
        `[${base}][${flashed}]overlay=0:0:enable='${combinedEn}'[${out}]`
      );
      return { steps, lastLabel: out, selfTimed: Boolean(enableExpr) };
    }
    case 'cinematic-shake':
    case 'handheld-camera':
    case 'camera-shake': {
      const out = nextLabel('shake');
      const scalePct =
        fx.type === 'handheld-camera'
          ? 1.0 + Math.min(0.08, intensityNorm * 0.06)
          : fx.type === 'cinematic-shake'
          ? 1.0 + Math.min(0.11, intensityNorm * 0.09)
          : 1.0 + Math.min(0.16, intensityNorm * 0.14);
      const freqX = (
        (fx.type === 'handheld-camera' ? 4.5 : fx.type === 'cinematic-shake' ? 14 : 26) * speedRate
      ).toFixed(1);
      const freqY = (
        (fx.type === 'handheld-camera' ? 6.2 : fx.type === 'cinematic-shake' ? 18 : 32) * speedRate
      ).toFixed(1);
      steps.push(
        `[${inputLabel}]scale=${Math.round(safeW * scalePct)}:${Math.round(
          safeH * scalePct
        )},crop=w=${safeW}:h=${safeH}:x='max(0,min(iw-ow,(iw-ow)/2+sin(t*${freqX})*(iw-ow)*0.45))':y='max(0,min(ih-oh,(ih-oh)/2+cos(t*${freqY})*(ih-oh)*0.45))',setsar=1[${out}]`
      );
      return { steps, lastLabel: out };
    }
    case 'slow-zoom':
    case 'zoom':
    case 'zoom-out': {
      const out = nextLabel('zoom');
      const maxBoost = intensityNorm * (fx.type === 'slow-zoom' ? 0.22 : 0.36);
      const progExpr = `clip((t-${intervalStart.toFixed(3)})/${span.toFixed(3)},0,1)`;
      const zExpr =
        fx.type === 'zoom-out'
          ? `(1+${maxBoost.toFixed(3)}*(1-${progExpr}))`
          : `(1+${maxBoost.toFixed(3)}*${progExpr})`;
      steps.push(
        `[${inputLabel}]scale=w='iw*${zExpr}':h='ih*${zExpr}':eval=frame,crop=w=${safeW}:h=${safeH}:x='max(0,min(iw-ow,(iw-ow)*${posX.toFixed(
          2
        )}))':y='max(0,min(ih-oh,(ih-oh)*${posY.toFixed(2)}))',setsar=1[${out}]`
      );
      return { steps, lastLabel: out };
    }

    // === TRENDING EFFECTS ===
    case 'vhs': {
      const out = nextLabel('vhs');
      const shift = Math.max(2, Math.round(intensityNorm * 10));
      const noiseAmt = Math.max(3, Math.round(intensityNorm * 22));
      steps.push(
        `[${inputLabel}]rgbashift=rh=${shift}:bh=${-shift}${enSuffix},noise=alls=${noiseAmt}:allf=t+u${enSuffix},eq=contrast=1.12:saturation=1.22${enSuffix},colorbalance=rm=0.08:bm=-0.08${enSuffix}[${out}]`
      );
      return { steps, lastLabel: out, selfTimed: Boolean(enableExpr) };
    }
    case 'neon-glow': {
      const s0 = nextLabel('ng0');
      const s1 = nextLabel('ng1');
      const blurred = nextLabel('ngb');
      const out = nextLabel('neonglow');
      const sigma = Math.max(4, Math.round(intensityNorm * 20));
      const smallSigma = Math.max(1.5, Number((sigma / 4).toFixed(1)));
      const opacity = Math.min(0.85, Number((intensityNorm * 0.72).toFixed(2)));
      const hue = Math.round(fx.hueShiftDeg ?? 18);
      steps.push(`[${inputLabel}]split[${s0}][${s1}]`);
      steps.push(
        `[${s1}]scale=${smallW}:${smallH}:flags=bilinear,gblur=sigma=${smallSigma}:steps=1,scale=${safeW}:${safeH}:flags=bilinear,eq=saturation=1.65:brightness=0.14:contrast=1.18${enSuffix},hue=h=${hue}${enSuffix}[${blurred}]`
      );
      steps.push(`[${s0}][${blurred}]blend=all_mode=screen:all_opacity=${opacity}${enSuffix}[${out}]`);
      return { steps, lastLabel: out, selfTimed: Boolean(enableExpr) };
    }
    case 'color-shift': {
      const out = nextLabel('cshift');
      const baseHue = Number(fx.hueShiftDeg ?? 0);
      const speed = Number((speedRate * 2.2 * intensityNorm).toFixed(2));
      steps.push(
        `[${inputLabel}]hue=H='${((baseHue * Math.PI) / 180).toFixed(3)}+t*${speed}':s=${(
          1 +
          intensityNorm * 0.4
        ).toFixed(2)}${enSuffix}[${out}]`
      );
      return { steps, lastLabel: out, selfTimed: Boolean(enableExpr) };
    }
    case 'dream-effect':
    case 'soft-focus': {
      const s0 = nextLabel('dr0');
      const s1 = nextLabel('dr1');
      const blurred = nextLabel('drb');
      const out = nextLabel('dream');
      const sigma = Math.max(3, Math.round(intensityNorm * (fx.type === 'dream-effect' ? 18 : 12)));
      const smallSigma = Math.max(1.2, Number((sigma / 4).toFixed(1)));
      const opacity = Number((0.25 + intensityNorm * 0.45).toFixed(2));
      const extra =
        fx.type === 'dream-effect'
          ? `,eq=brightness=0.10:saturation=1.12${enSuffix}`
          : `,eq=brightness=0.04${enSuffix}`;
      steps.push(`[${inputLabel}]split[${s0}][${s1}]`);
      steps.push(
        `[${s1}]scale=${smallW}:${smallH}:flags=bilinear,gblur=sigma=${smallSigma}:steps=1,scale=${safeW}:${safeH}:flags=bilinear${extra}[${blurred}]`
      );
      steps.push(
        `[${s0}][${blurred}]blend=all_mode=normal:all_opacity=${(1 - opacity).toFixed(2)}${enSuffix}[${out}]`
      );
      return { steps, lastLabel: out, selfTimed: Boolean(enableExpr) };
    }

    // === TRANSITIONS ===
    case 'fade-in': {
      const out = nextLabel('fadein');
      const dur = Math.max(0.1, span * Math.max(0.2, intensityNorm));
      steps.push(`[${inputLabel}]fade=t=in:st=${intervalStart.toFixed(2)}:d=${dur.toFixed(2)}[${out}]`);
      return { steps, lastLabel: out };
    }
    case 'fade-out': {
      const out = nextLabel('fadeout');
      const dur = Math.max(0.1, span * Math.max(0.2, intensityNorm));
      const st = Math.max(intervalStart, intervalEnd - dur);
      steps.push(`[${inputLabel}]fade=t=out:st=${st.toFixed(2)}:d=${dur.toFixed(2)}[${out}]`);
      return { steps, lastLabel: out };
    }
    case 'cross-dissolve':
    case 'fade-in-out': {
      const out = nextLabel('fadeio');
      const fIn =
        fx.type === 'cross-dissolve'
          ? span * 0.45
          : Math.min(span * 0.45, Math.max(0, Number(fx.fadeInSec ?? 0.6) * intensityNorm));
      const fOut =
        fx.type === 'cross-dissolve'
          ? span * 0.45
          : Math.min(span * 0.45, Math.max(0, Number(fx.fadeOutSec ?? 0.6) * intensityNorm));
      const fOutStart = Math.max(intervalStart + 0.05, intervalEnd - fOut);
      const parts: string[] = [];
      if (fIn > 0.04) parts.push(`fade=t=in:st=${intervalStart.toFixed(2)}:d=${fIn.toFixed(2)}`);
      if (fOut > 0.04) parts.push(`fade=t=out:st=${fOutStart.toFixed(2)}:d=${fOut.toFixed(2)}`);
      steps.push(`[${inputLabel}]${parts.length ? parts.join(',') : 'null'}[${out}]`);
      return { steps, lastLabel: out };
    }
    case 'flash-transition': {
      const out = nextLabel('fltr');
      const half = Math.max(0.08, span / 2);
      const mid = intervalStart + half;
      const amp = Number((0.45 + intensityNorm * 0.5).toFixed(2));
      steps.push(
        `[${inputLabel}]eq=brightness='${amp}*max(0,1-abs(t-${mid.toFixed(3)})/${half.toFixed(3)})':eval=frame${enSuffix}[${out}]`
      );
      return { steps, lastLabel: out, selfTimed: Boolean(enableExpr) };
    }
    case 'zoom-transition': {
      const out = nextLabel('zoomtr');
      const half = Math.max(0.08, span / 2);
      const mid = intervalStart + half;
      const peak = Number((0.45 * intensityNorm).toFixed(3));
      const zExpr = `(1+${peak}*max(0,1-abs(t-${mid.toFixed(3)})/${half.toFixed(3)}))`;
      steps.push(
        `[${inputLabel}]scale=w='iw*${zExpr}':h='ih*${zExpr}':eval=frame,crop=w=${safeW}:h=${safeH}:x='max(0,min(iw-ow,(iw-ow)*${posX.toFixed(
          2
        )}))':y='max(0,min(ih-oh,(ih-oh)*${posY.toFixed(2)}))',setsar=1[${out}]`
      );
      return { steps, lastLabel: out };
    }
    case 'slide-transition': {
      const s0 = nextLabel('sl0');
      const s1 = nextLabel('sl1');
      const blk = nextLabel('slb');
      const out = nextLabel('slide');
      const dir = fx.direction || 'left';
      const pExpr = `clip((t-${intervalStart.toFixed(3)})/${span.toFixed(3)},0,1)`;
      const xExpr =
        dir === 'left'
          ? `(1-${pExpr})*W`
          : dir === 'right'
          ? `-(1-${pExpr})*W`
          : '0';
      const yExpr =
        dir === 'up' ? `(1-${pExpr})*H` : dir === 'down' ? `-(1-${pExpr})*H` : '0';
      steps.push(`[${inputLabel}]split[${s0}][${s1}]`);
      steps.push(`[${s0}]drawbox=t=fill:c=black[${blk}]`);
      steps.push(`[${blk}][${s1}]overlay=x='${xExpr}':y='${yExpr}'[${out}]`);
      return { steps, lastLabel: out };
    }
    case 'wipe-transition': {
      const s0 = nextLabel('wp0');
      const s1 = nextLabel('wp1');
      const blk = nextLabel('wpb');
      const out = nextLabel('wipe');
      const dir = fx.direction || 'left';
      const pExpr = `clip((t-${intervalStart.toFixed(3)})/${span.toFixed(3)},0,1)`;
      const xExpr =
        dir === 'left' ? `W*${pExpr}` : dir === 'right' ? `-W*${pExpr}` : '0';
      const yExpr =
        dir === 'up' ? `H*${pExpr}` : dir === 'down' ? `-H*${pExpr}` : '0';
      steps.push(`[${inputLabel}]split[${s0}][${s1}]`);
      steps.push(`[${s1}]drawbox=t=fill:c=black[${blk}]`);
      steps.push(`[${s0}][${blk}]overlay=x='${xExpr}':y='${yExpr}'${enSuffix}[${out}]`);
      return { steps, lastLabel: out, selfTimed: Boolean(enableExpr) };
    }
    case 'blur-transition': {
      const s0 = nextLabel('bt0');
      const s1 = nextLabel('bt1');
      const blurred = nextLabel('btb');
      const out = nextLabel('blurtr');
      const sigma = Math.max(6, Math.round(intensityNorm * 24));
      const smallSigma = Math.max(2, Number((sigma / 4).toFixed(1)));
      const half = Math.max(0.08, span / 2);
      const mid = intervalStart + half;
      steps.push(`[${inputLabel}]split[${s0}][${s1}]`);
      steps.push(
        `[${s1}]scale=${smallW}:${smallH}:flags=bilinear,gblur=sigma=${smallSigma}:steps=1,scale=${safeW}:${safeH}:flags=bilinear,format=yuva420p,fade=t=in:st=${intervalStart.toFixed(
          3
        )}:d=${half.toFixed(3)}:alpha=1,fade=t=out:st=${mid.toFixed(3)}:d=${half.toFixed(3)}:alpha=1[${blurred}]`
      );
      steps.push(`[${s0}][${blurred}]overlay=0:0${enSuffix}[${out}]`);
      return { steps, lastLabel: out, selfTimed: Boolean(enableExpr) };
    }
    default:
      return null;
  }
}
