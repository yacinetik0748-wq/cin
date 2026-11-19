import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_VIDEO_CANVAS, Project } from '../../src/types/studio.ts';
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
} from '../../src/lib/videoTimeline.ts';
import { resolveCanvasDimensions } from '../../src/lib/workflowStages.ts';
import {
  mapBlurToExportCanvasNormalized,
  resolveBlurIntervals,
} from '../../src/lib/blurMasks.ts';
import { EXPORTS_DIR, FONTS_DIR, getAssetByUrl, registerAsset } from '../db.ts';
import { buildAudioMixFilters } from './audio_processing_service.ts';
import { buildBlurFilters, BlurRenderOverride } from './blur_processing_service.ts';
import { ensureFontAvailable } from './font_service.ts';
import { buildLogoOverlayFilters } from './logo_overlay_service.ts';
import { generateAssFile } from './subtitle_service.ts';
import { buildVideoEffectsFilters } from './video_effects_service.ts';
import { analyzeVideoFile } from './video_analysis_service.ts';
import {
  buildSyncedCaptionsForRender,
  buildVideoFrameHoldFilter,
  remapBlursForSyncPlan,
  remapLogosForSyncPlan,
} from './timeline_sync_service.ts';

function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

export function resolveSourceCropRect(
  srcW: number,
  srcH: number,
  canvas: typeof DEFAULT_VIDEO_CANVAS
): { cx: number; cy: number; cw: number; ch: number } {
  // Prefer explicit pixel crop rectangle when provided and valid
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

export async function renderProjectVideo(params: {
  project: Project;
  onProgress: (progress: number, stage: string, etaSeconds: number | null) => void;
}): Promise<{ outputPath: string; outputUrl: string; outputSize: number }> {
  const { project, onProgress } = params;
  if (!project.sourceVideoUrl || !project.metadata) {
    throw new Error('Project has no uploaded source video.');
  }

  const videoAsset = getAssetByUrl(project.sourceVideoUrl);
  if (!videoAsset || !fs.existsSync(videoAsset.file_path)) {
    throw new Error('Source video file is missing from storage.');
  }

  const { exportSettings } = project;
  const canvas = { ...DEFAULT_VIDEO_CANVAS, ...(project.canvas || {}) };
  const { width, height } = resolveCanvasDimensions(
    canvas,
    exportSettings,
    project.metadata
  );
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
  // Video clip speed/trim/gaps must NEVER be overridden by flexible sync holds
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

  const hasExplicitEmptyVideo =
    Array.isArray(project.videoClips) && project.videoClips.length === 0;
  const videoTrackDur =
    videoClips.length > 0
      ? getVideoTimelineTotalDuration(videoClips)
      : hasExplicitEmptyVideo
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
  const origAudioTrackDur = origAudioClips.reduce(
    (m, c) => Math.max(m, getOriginalAudioClipTimelineEnd(c)),
    0
  );
  const bgmTrackDur = Array.isArray(project.voice.bgMusicClips)
    ? getEffectiveBgmClips(project, origDur).reduce(
        (m, c) => Math.max(m, getTimelineAudioClipEnd(c)),
        0
      )
    : 0;
  const sfxTrackDur = Array.isArray(project.voice.sfxClips)
    ? getEffectiveSfxClips(project, origDur).reduce(
        (m, c) => Math.max(m, getTimelineAudioClipEnd(c)),
        0
      )
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

  onProgress(5, 'Verifying fonts & filter graph', null);

  // Pre-verify fonts BEFORE building/starting FFmpeg render so no unavailable font silently falls back
  const visibleExtraElements = (project.subtitleStyle.extraElements || []).filter(
    (el) => el.visible && (el.syncToCaptions || Boolean(el.text?.trim()))
  );

  if (captionsWillBurn) {
    const primaryFontCheck = await ensureFontAvailable({
      family: project.subtitleStyle.fontFamily || 'Montserrat',
      weight:
        project.subtitleStyle.fontWeightNum ??
        (project.subtitleStyle.fontWeight === '900'
          ? 900
          : project.subtitleStyle.fontWeight === 'bold'
          ? 700
          : 400),
      italic: project.subtitleStyle.italic,
    });
    if (!primaryFontCheck.available || !primaryFontCheck.exportCompatible) {
      throw new Error(
        primaryFontCheck.error ||
          `Font "${project.subtitleStyle.fontFamily}" is not available in TTF/OTF format for MP4 export.`
      );
    }

    // Also ensure any per-caption template override fonts are cached locally before FFmpeg starts
    const seenSegFonts = new Set<string>();
    for (const seg of project.captions) {
      if (!seg.styleOverride) continue;
      const fam = seg.styleOverride.fontFamily || project.subtitleStyle.fontFamily || 'Montserrat';
      const weight =
        seg.styleOverride.fontWeightNum ??
        (seg.styleOverride.fontWeight === '900'
          ? 900
          : seg.styleOverride.fontWeight === 'bold'
          ? 700
          : seg.styleOverride.fontWeight === 'normal'
          ? 400
          : project.subtitleStyle.fontWeightNum || 700);
      const italic = seg.styleOverride.italic ?? project.subtitleStyle.italic;
      const key = `${fam}:${weight}:${italic ? 1 : 0}`;
      if (seenSegFonts.has(key)) continue;
      seenSegFonts.add(key);
      const ovCheck = await ensureFontAvailable({ family: fam, weight, italic });
      if (!ovCheck.available || !ovCheck.exportCompatible) {
        throw new Error(
          ovCheck.error || `Caption segment font "${fam}" failed to load for export.`
        );
      }
    }
  }

  for (const el of visibleExtraElements) {
    const fam = el.style?.fontFamily || project.subtitleStyle.fontFamily || 'Montserrat';
    const extraCheck = await ensureFontAvailable({
      family: fam,
      weight: el.style?.fontWeightNum || project.subtitleStyle.fontWeightNum || 700,
      italic: el.style?.italic ?? project.subtitleStyle.italic,
    });
    if (!extraCheck.available || !extraCheck.exportCompatible) {
      throw new Error(
        extraCheck.error || `Text layer font "${fam}" failed to load for export.`
      );
    }
  }

  const tempFilesToClean: string[] = [];
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

  // Step 1: Prepare Foreground Video, Per-Clip Independent Speed/Timing, Crop Mode & Canvas Background Fill
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
    const fpsVal = Math.max(1, Math.round(project.metadata.fps || 30));
    const srcW = Math.max(16, project.metadata.width || 1280);
    const srcH = Math.max(16, project.metadata.height || 720);
    const { cx: baseCx, cy: baseCy, cw: baseCw, ch: baseCh } = resolveSourceCropRect(
      srcW,
      srcH,
      canvas
    );

    let cx = baseCx;
    let cy = baseCy;
    let cw = baseCw;
    let ch = baseCh;

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
      Math.abs(videoRotDeg) > 0.2 ||
      videoOpacity < 0.99 ||
      Boolean(canvas.flipH) ||
      Boolean(canvas.flipV);
    let fgTransformSuffix = `crop=${cw}:${ch}:${cx}:${cy},scale=${fgW}:${fgH},setsar=1`;
    if (canvas.flipH) fgTransformSuffix += `,hflip`;
    if (canvas.flipV) fgTransformSuffix += `,vflip`;
    if (Math.abs(videoRotDeg) > 0.2 || videoOpacity < 0.99) {
      fgTransformSuffix += `,format=rgba`;
      if (videoOpacity < 0.99) {
        fgTransformSuffix += `,colorchannelmixer=aa=${videoOpacity.toFixed(2)}`;
      }
      if (Math.abs(videoRotDeg) > 0.2) {
        const rad = ((videoRotDeg * Math.PI) / 180).toFixed(4);
        fgTransformSuffix += `,rotate=${rad}:ow='rotw(${rad})':oh='roth(${rad})':c=none`;
      }
    }

    const fgOverlayX = needsFgTransform
      ? `${Math.round(centerX)}-w/2`
      : String(Math.round(centerX - fgW / 2));
    const fgOverlayY = needsFgTransform
      ? `${Math.round(centerY)}-h/2`
      : String(Math.round(centerY - fgH / 2));

    const bgAsset =
      canvas.backgroundType === 'image' && canvas.bgImageUrl && bgVisible
        ? getAssetByUrl(canvas.bgImageUrl)
        : null;

    // Build background canvas stream [bgOut] and split [0:v] inputs for video clips
    let bgOut = 'v_canvas_bg';
    const clipCount = videoVisible ? videoClips.length : 0;
    const clipInLabels: string[] = [];

    if (canvas.backgroundType === 'blur' && bgVisible) {
      const sigma = Math.max(1, Math.min(60, Math.round(canvas.bgBlurIntensity || 24)));
      const brightVal = Math.max(
        -0.6,
        Math.min(0.6, (canvas.bgBlurBrightness ?? -15) / 100)
      ).toFixed(2);
      const blurOpacity = Math.max(0.1, Math.min(1.0, canvas.bgBlurOpacity ?? 0.9));

      const splitTargets = ['v_bg_raw'];
      for (let i = 0; i < clipCount; i++) {
        const lbl = `v_clip_in_${i}`;
        clipInLabels.push(lbl);
        splitTargets.push(lbl);
      }
      if (splitTargets.length === 1) {
        filterSteps.push(`[0:v]null[v_bg_raw]`);
      } else {
        filterSteps.push(
          `[0:v]split=${splitTargets.length}${splitTargets.map((l) => `[${l}]`).join('')}`
        );
      }

      let bgBlurChain = `[v_bg_raw]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=${sigma},eq=brightness=${brightVal},fps=${fpsVal},setsar=1`;
      if (totalDur > origDur + 0.05) {
        bgBlurChain += `,tpad=stop_mode=clone:stop_duration=${(totalDur - origDur + 0.3).toFixed(2)}`;
      }
      filterSteps.push(`${bgBlurChain}[v_bg_blurred]`);

      if (blurOpacity < 0.99 || totalDur > origDur + 0.05) {
        filterSteps.push(
          `color=c=#09090B:s=${width}x${height}:r=${fpsVal}:d=${totalDur.toFixed(3)}[v_bg_dark]`
        );
        const alphaFilter =
          blurOpacity < 0.99
            ? `format=yuva420p,colorchannelmixer=aa=${blurOpacity.toFixed(2)}`
            : 'null';
        filterSteps.push(`[v_bg_blurred]${alphaFilter}[v_bg_alpha]`);
        filterSteps.push(
          `[v_bg_dark][v_bg_alpha]overlay=0:0:shortest=1,trim=0:${totalDur.toFixed(3)},setsar=1[v_canvas_bg]`
        );
      } else {
        bgOut = 'v_bg_blurred';
      }
    } else {
      if (clipCount === 1) {
        clipInLabels.push('0:v');
      } else if (clipCount > 1) {
        for (let i = 0; i < clipCount; i++) {
          clipInLabels.push(`v_clip_in_${i}`);
        }
        filterSteps.push(
          `[0:v]split=${clipCount}${clipInLabels.map((l) => `[${l}]`).join('')}`
        );
      }

      if (bgAsset && fs.existsSync(bgAsset.file_path)) {
        const bgIdx = nextInputIdx++;
        extraInputs.push('-loop', '1', '-t', totalDur.toFixed(3), '-i', bgAsset.file_path);
        const bgScale = Math.max(0.5, Math.min(2.5, canvas.bgImageScale || 1));
        const targetBgW = Math.max(16, Math.round(width * bgScale) & ~1);
        const targetBgH = Math.max(16, Math.round(height * bgScale) & ~1);
        const bgShiftX = Math.round(((canvas.bgImageOffsetX || 0) / 100) * width);
        const bgShiftY = Math.round(((canvas.bgImageOffsetY || 0) / 100) * height);

        filterSteps.push(
          `color=c=#09090B:s=${width}x${height}:r=${fpsVal}:d=${totalDur.toFixed(3)}[v_bg_dark]`
        );
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
        filterSteps.push(
          `[v_bg_dark][v_bg_img]overlay=x=(W-w)/2+${bgShiftX}:y=(H-h)/2+${bgShiftY}:shortest=1[v_canvas_bg]`
        );
      } else {
        const bgHex = /^#[0-9a-fA-F]{6}$/.test(canvas.bgColor || '') ? canvas.bgColor : '#09090B';
        filterSteps.push(
          `color=c=${bgHex}:s=${width}x${height}:r=${fpsVal}:d=${totalDur.toFixed(3)}[v_canvas_bg]`
        );
      }
    }

    if (!videoVisible || videoClips.length === 0) {
      filterSteps.push(`[${bgOut}]setsar=1[${currentV}]`);
    } else if (!customVideoEdits) {
      filterSteps.push(`[${clipInLabels[0]}]${fgTransformSuffix}[v_fg_scaled]`);
      filterSteps.push(
        `[${bgOut}][v_fg_scaled]overlay=x='${fgOverlayX}':y='${fgOverlayY}':shortest=1,setsar=1[${currentV}]`
      );
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
          `[${clipInLabels[idx]}]trim=start=${sStart.toFixed(3)}:end=${sEnd.toFixed(
            3
          )},setpts=(PTS-STARTPTS)/${spd.toFixed(4)}+${tlStart.toFixed(
            3
          )}/TB,fps=${fpsVal}:start_time=${tlStart.toFixed(3)},${fgTransformSuffix}[${clipOut}]`
        );
        filterSteps.push(
          `[${bgRunner}][${clipOut}]overlay=x='${fgOverlayX}':y='${fgOverlayY}':enable='between(t,${tlStart.toFixed(
            3
          )},${tlEnd.toFixed(3)})':eof_action=pass${isLast ? ',setsar=1' : ''}[${nextRunner}]`
        );
        bgRunner = nextRunner;
      });
    }
  }

  // Step 1.5: Timeline Visual Frame Holds (only when video clips are unedited)
  if (activeSyncPlan && activeSyncPlan.holds.length > 0) {
    const holdSteps = buildVideoFrameHoldFilter({
      inputLabel: currentV,
      outputLabel: 'v_held',
      originalDuration: origDur,
      holds: activeSyncPlan.holds,
    });
    filterSteps.push(...holdSteps);
    currentV = 'v_held';
  } else if (continuousExtendSec > 0.05) {
    filterSteps.push(
      `[${currentV}]tpad=stop_mode=clone:stop_duration=${continuousExtendSec.toFixed(3)}[v_cont_ext]`
    );
    currentV = 'v_cont_ext';
  }

  // Step 1.8: Video Filters & Visual Effects (global + per-clip filters + 14 working effects)
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

  // Prepare ordered overlays (Blurs, Logos, Captions) respecting canvas.layerOrder
  const captionOffset =
    (dubbingActive ? Number(project.voice.timingOffsetSec || 0) : 0) +
    Number(project.subtitleStyle.timingOffsetSec || 0);
  const renderCaptions =
    dubbingActive && project.voice.syncPlan
      ? buildSyncedCaptionsForRender(project.captions, project.voice.syncPlan, captionOffset)
      : captionOffset !== 0
      ? buildSyncedCaptionsForRender(project.captions, undefined, captionOffset)
      : project.captions;

  const syncedCaptionIntervals = renderCaptions.map((c) => ({
    id: c.id,
    syncedStart: c.start,
    syncedEnd: c.end,
  }));

  const blurSrcW = Math.max(16, project.metadata.width || 1280);
  const blurSrcH = Math.max(16, project.metadata.height || 720);
  const blurOverrides: Record<string, BlurRenderOverride> = {};

  const renderBlurs = project.blurs.map((b) => {
    const linkMode = b.subtitleLink?.mode || 'manual';
    let remapped = b;
    let intervals: Array<{ start: number; end: number }> | undefined;

    if (linkMode === 'translated') {
      intervals = resolveBlurIntervals(b, project, {
        syncedCaptionsOverride: syncedCaptionIntervals,
      });
    } else if (linkMode === 'original') {
      intervals = resolveBlurIntervals(b, project, {
        holdsOverride: activeSyncPlan?.holds || [],
      });
    } else if (activeSyncPlan) {
      remapped = remapBlursForSyncPlan([b], activeSyncPlan.holds)[0] || b;
      intervals = [{ start: remapped.startTime, end: remapped.endTime }];
    } else {
      intervals = [{ start: b.startTime, end: b.endTime }];
    }

    const mappedRect =
      b.coordSpace === 'video'
        ? mapBlurToExportCanvasNormalized(remapped, project, blurSrcW, blurSrcH, {
            hasCustomCanvasOverride: hasCustomCropOrTransform || customVideoEdits,
          })
        : undefined;

    blurOverrides[remapped.id] = {
      mappedRect,
      intervals,
    };
    return remapped;
  });

  const renderLogos = activeSyncPlan
    ? remapLogosForSyncPlan(project.logos, activeSyncPlan.holds)
    : project.logos;

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
  const seenTokens = new Set<string>();
  for (const tok of canvas.layerOrder || []) {
    if (
      (tok.startsWith('blur:') && blurMap.has(tok.slice(5))) ||
      (tok.startsWith('logo:') && logoMap.has(tok.slice(5))) ||
      (tok === 'captions' && captionsEnabled) ||
      (tok.startsWith('caption-element:') && extraElementMap.has(tok.slice('caption-element:'.length)))
    ) {
      orderedTokens.push(tok);
      seenTokens.add(tok);
    }
  }
  for (const tok of defaultOrder) {
    if (!seenTokens.has(tok)) {
      orderedTokens.push(tok);
      seenTokens.add(tok);
    }
  }

  let layerStep = 0;
  for (const token of orderedTokens) {
    layerStep += 1;
    if (token.startsWith('blur:') && exportSettings.applyBlur) {
      const blur = blurMap.get(token.slice(5));
      if (!blur) continue;
      const blurRes = buildBlurFilters({
        blurs: [blur],
        startLabel: currentV,
        targetWidth: width,
        targetHeight: height,
        nextInputIndex: nextInputIdx,
        labelPrefix: `lb${layerStep}`,
        overrides: blurOverrides,
      });
      extraInputs.push(...blurRes.extraInputs);
      filterSteps.push(...blurRes.filterSteps);
      currentV = blurRes.currentLabel;
      nextInputIdx += blurRes.extraInputs.filter((a) => a === '-i').length;
    } else if (token.startsWith('logo:') && exportSettings.applyLogo) {
      const logo = logoMap.get(token.slice(5));
      if (!logo) continue;
      const logoRes = buildLogoOverlayFilters({
        logos: [logo],
        startLabel: currentV,
        targetWidth: width,
        targetHeight: height,
        nextInputIndex: nextInputIdx,
        labelPrefix: `ll${layerStep}`,
      });
      extraInputs.push(...logoRes.extraInputs);
      filterSteps.push(...logoRes.filterSteps);
      currentV = logoRes.currentLabel;
      nextInputIdx = logoRes.nextInputIndex;
    } else if (token === 'captions' && captionsEnabled) {
      const assPath = generateAssFile({
        projectId: project.id,
        captions: renderCaptions,
        style: project.subtitleStyle,
        videoWidth: width,
        videoHeight: height,
        totalDuration: totalDur,
        includeMainCaptions: true,
        includeExtraElements: false,
      });
      tempFilesToClean.push(assPath);
      const escapedAss = escapeFilterPath(assPath);
      const escapedFonts = fs.existsSync(FONTS_DIR) ? escapeFilterPath(FONTS_DIR) : '';
      const outLabel = `v_sub_${layerStep}`;
      const fontsOpt = escapedFonts ? `:fontsdir='${escapedFonts}'` : '';
      filterSteps.push(`[${currentV}]ass='${escapedAss}'${fontsOpt}[${outLabel}]`);
      currentV = outLabel;
    } else if (token.startsWith('caption-element:')) {
      const elId = token.slice('caption-element:'.length);
      if (!extraElementMap.has(elId)) continue;
      const assPath = generateAssFile({
        projectId: project.id,
        captions: renderCaptions,
        style: project.subtitleStyle,
        videoWidth: width,
        videoHeight: height,
        totalDuration: totalDur,
        includeMainCaptions: false,
        includeExtraElements: true,
        onlyExtraElementIds: [elId],
      });
      tempFilesToClean.push(assPath);
      const escapedAss = escapeFilterPath(assPath);
      const escapedFonts = fs.existsSync(FONTS_DIR) ? escapeFilterPath(FONTS_DIR) : '';
      const outLabel = `v_tx_${layerStep}`;
      const fontsOpt = escapedFonts ? `:fontsdir='${escapedFonts}'` : '';
      filterSteps.push(`[${currentV}]ass='${escapedAss}'${fontsOpt}[${outLabel}]`);
      currentV = outLabel;
    }
  }

  // Step 5: Audio Mixing & Synchronization
  const audioRes = buildAudioMixFilters({
    hasSourceAudio: project.metadata.hasAudio,
    duration: totalDur,
    originalDuration: origDur,
    holds: activeSyncPlan?.holds,
    videoClips,
    originalAudioClips: origAudioClips,
    voice: project.voice,
    applyDubbing: exportSettings.applyDubbing,
    applyAudioMix: exportSettings.applyAudioMix,
    nextInputIndex: nextInputIdx,
  });
  extraInputs.push(...audioRes.extraInputs);
  filterSteps.push(...audioRes.filterSteps);

  const outFilename = `recap_export_${project.id.slice(0, 8)}_${Date.now()}.mp4`;
  const outputPath = path.join(EXPORTS_DIR, outFilename);

  const ffmpegArgs = [
    '-y',
    '-i',
    videoAsset.file_path,
    ...extraInputs,
    '-filter_complex',
    filterSteps.join(';'),
    '-map',
    `[${currentV}]`,
  ];

  if (audioRes.audioMapLabel) {
    ffmpegArgs.push('-map', audioRes.audioMapLabel, '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2');
  } else {
    ffmpegArgs.push('-an');
  }

  ffmpegArgs.push(
    '-c:v',
    'libx264',
    '-profile:v',
    'main',
    '-level',
    '4.0',
    '-preset',
    'medium',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    outputPath
  );

  onProgress(10, 'Encoding video with FFmpeg (H.264 / AAC)', null);

  const startedAt = Date.now();

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('ffmpeg', ffmpegArgs);
      let stderrBuf = '';

      proc.stdout.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (line.startsWith('out_time_us=')) {
            const us = Number(line.split('=')[1] || 0);
            const curSec = us / 1_000_000;
            const pct = Math.min(97, Math.max(10, Math.round(10 + (curSec / totalDur) * 87)));
            const elapsedSec = (Date.now() - startedAt) / 1000;
            let eta: number | null = null;
            if (curSec > 0.5 && elapsedSec > 0.5) {
              const rate = curSec / elapsedSec;
              eta = Math.max(1, Math.round((totalDur - curSec) / rate));
            }
            onProgress(pct, 'Rendering video frames', eta);
          }
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        if (stderrBuf.length > 8000) {
          stderrBuf = stderrBuf.slice(-4000);
        }
      });

      proc.on('error', (err) => reject(err));
      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg render failed (exit ${code}): ${stderrBuf.slice(-600)}`));
        }
      });
    });

    if (!fs.existsSync(outputPath)) {
      throw new Error('FFmpeg exited cleanly but no MP4 file was written.');
    }

    const stat = fs.statSync(outputPath);
    if (stat.size < 1024) {
      fs.unlinkSync(outputPath);
      throw new Error(`Exported MP4 file is invalid or empty (${stat.size} bytes).`);
    }

    const probed = await analyzeVideoFile(outputPath);
    if (!probed.videoCodec || probed.duration <= 0) {
      fs.unlinkSync(outputPath);
      throw new Error('Rendered MP4 failed stream verification (missing video track or zero duration).');
    }

    const outputUrl = `/media/exports/${outFilename}`;
    registerAsset({
      id: uuidv4(),
      projectId: project.id,
      kind: 'export',
      filename: outFilename,
      filePath: outputPath,
      url: outputUrl,
      mimeType: 'video/mp4',
      sizeBytes: stat.size,
    });

    onProgress(100, 'Export completed', 0);
    return { outputPath, outputUrl, outputSize: stat.size };
  } finally {
    for (const f of tempFilesToClean) {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
      }
    }
  }
}
