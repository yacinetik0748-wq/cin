import { DEFAULT_VIDEO_CANVAS, ExportSpeedProfile, Project } from '../types/studio';
import {
  getEffectiveBgmClips,
  getEffectiveOriginalAudioClips,
  getEffectiveSfxClips,
  getEffectiveVideoClips,
  getOriginalAudioClipTimelineEnd,
  getTimelineAudioClipEnd,
  getVideoTimelineTotalDuration,
  hasCustomVideoEdits,
} from './videoTimeline';
import { resolveCanvasDimensions } from './workflowStages';

export const EXPORT_H264_CRF = 27; // Compact CRF 27-28 range (FFmpeg libx264 only)
export const EXPORT_VIDEO_TARGET_KBPS = 1350; // 1.2-1.5 Mbps target bitrate (WebCodecs / MediaRecorder)
export const EXPORT_VIDEO_MAXRATE_KBPS = 1500; // 1.5 Mbps VBV maxrate cap
export const EXPORT_VIDEO_BUFSIZE_KBPS = 3000;
export const EXPORT_AUDIO_BITRATE_KBPS = 96; // 96 kbps AAC
export const EXPORT_AUDIO_SAMPLE_RATE = 44100; // 44.1 kHz
export const EXPORT_TARGET_FPS = 30;

export interface ResolvedExportSpeedPreset {
  profile: ExportSpeedProfile;
  label: string;
  ffmpegPreset: 'ultrafast' | 'superfast' | 'veryfast';
  crf: number;
  videoTargetKbps: number;
  videoMaxrateKbps: number;
  videoBufsizeKbps: number;
  scThreshold: number;
  webCodecsLatencyMode: 'realtime' | 'quality';
}

export function resolveExportSpeedPreset(profile?: ExportSpeedProfile): ResolvedExportSpeedPreset {
  if (profile === 'fast') {
    return {
      profile: 'fast',
      label: 'Fast',
      ffmpegPreset: 'ultrafast',
      crf: 27,
      videoTargetKbps: 1350,
      videoMaxrateKbps: 1500,
      videoBufsizeKbps: 3000,
      scThreshold: 0,
      webCodecsLatencyMode: 'realtime',
    };
  }
  if (profile === 'high-quality') {
    return {
      profile: 'high-quality',
      label: 'High Quality',
      ffmpegPreset: 'veryfast',
      crf: 23,
      videoTargetKbps: 2200,
      videoMaxrateKbps: 2500,
      videoBufsizeKbps: 5000,
      scThreshold: 40,
      webCodecsLatencyMode: 'quality',
    };
  }
  return {
    profile: 'balanced',
    label: 'Balanced',
    ffmpegPreset: 'superfast',
    crf: EXPORT_H264_CRF,
    videoTargetKbps: EXPORT_VIDEO_TARGET_KBPS,
    videoMaxrateKbps: EXPORT_VIDEO_MAXRATE_KBPS,
    videoBufsizeKbps: EXPORT_VIDEO_BUFSIZE_KBPS,
    scThreshold: 20,
    webCodecsLatencyMode: 'quality',
  };
}

export interface ExportSizeEstimate {
  durationSec: number;
  width: number;
  height: number;
  targetFps: number;
  speedProfile: ExportSpeedProfile;
  targetVideoKbps: number;
  targetVideoMaxrateKbps: number;
  targetAudioBitrateKbps: number;
  crf: number;
  isStaticVisualMode: boolean;
  hasAnyAudio: boolean;
  estimatedBytes: number;
  minBytes: number;
  maxBytes: number;
}

export function resolveExportTimelineDuration(project: Project): number {
  const origDur = Math.max(0.5, project.metadata?.duration || 10);
  const videoClips = getEffectiveVideoClips(project);
  const origAudioClips = getEffectiveOriginalAudioClips(project);
  const customVideoEdits = hasCustomVideoEdits(project);

  const voiceVol = Math.max(0, Math.min(2.0, Number(project.voice.voiceVolume ?? 1.0)));
  const dubRequested = Boolean(
    project.exportSettings.applyDubbing &&
      project.voice.enabled &&
      !project.voice.voiceMuted &&
      voiceVol > 0.005
  );
  const hasDubClips = (project.voice.generatedClips || []).some((c) => Boolean(c.audioUrl));
  const dubbingAvailable = dubRequested && Boolean(project.voice.fullDubUrl || hasDubClips);
  const syncMode = project.voice.syncMode || 'flexible';
  const activeSyncPlan =
    !customVideoEdits &&
    dubbingAvailable &&
    syncMode === 'flexible' &&
    (project.voice.syncPlan?.holds?.length || 0) > 0
      ? project.voice.syncPlan
      : undefined;

  const captionsWillBurn =
    project.exportSettings.applyCaptions &&
    project.subtitleStyle.enabled &&
    project.subtitleStyle.visible !== false &&
    project.captions.length > 0;

  const videoTrackDur =
    videoClips.length > 0
      ? getVideoTimelineTotalDuration(videoClips)
      : Array.isArray(project.videoClips) && project.videoClips.length === 0
      ? 0
      : origDur;

  const dubClipsMax = dubbingAvailable
    ? (project.voice.generatedClips || []).reduce(
        (m, c) => Math.max(m, (c.end || 0) + Number(project.voice.timingOffsetSec || 0)),
        0
      )
    : 0;
  const dubTrackDur = dubbingAvailable
    ? Math.max(project.voice.syncPlan?.estimatedFinalDuration || 0, dubClipsMax)
    : 0;
  const origAudioTrackDur = origAudioClips.reduce(
    (m, c) => Math.max(m, getOriginalAudioClipTimelineEnd(c)),
    0
  );
  const bgmTrackDur = Array.isArray(project.voice.bgMusicClips)
    ? getEffectiveBgmClips(project, origDur).reduce((m, c) => Math.max(m, getTimelineAudioClipEnd(c)), 0)
    : 0;
  const sfxTrackDur = Array.isArray(project.voice.sfxClips)
    ? getEffectiveSfxClips(project, origDur).reduce((m, c) => Math.max(m, getTimelineAudioClipEnd(c)), 0)
    : 0;
  const captionsTrackDur = captionsWillBurn
    ? (project.captions || []).reduce((m, c) => Math.max(m, c.end || 0), 0)
    : 0;

  return customVideoEdits
    ? Math.max(1.0, videoTrackDur, dubTrackDur, origAudioTrackDur, bgmTrackDur, sfxTrackDur, captionsTrackDur)
    : activeSyncPlan
    ? Math.max(origDur, activeSyncPlan.estimatedFinalDuration)
    : dubbingAvailable
    ? Math.max(origDur, dubTrackDur)
    : origDur;
}

export function computeExportTargetFps(params: {
  sourceFps?: number | null;
  videoVisible: boolean;
  videoClipCount: number;
}): number {
  if (!params.videoVisible || params.videoClipCount === 0) {
    return EXPORT_TARGET_FPS;
  }
  const raw = Number(params.sourceFps || EXPORT_TARGET_FPS);
  if (!Number.isFinite(raw) || raw <= 0) return EXPORT_TARGET_FPS;
  if (raw > 30.5) return EXPORT_TARGET_FPS;
  return Math.max(15, Math.min(EXPORT_TARGET_FPS, Math.round(raw)));
}

export function estimateExportOutputSize(project: Project): ExportSizeEstimate {
  const { exportSettings } = project;
  const speedPreset = resolveExportSpeedPreset(exportSettings.speedProfile);
  const canvas = { ...DEFAULT_VIDEO_CANVAS, ...(project.canvas || {}) };
  const { width, height } = resolveCanvasDimensions(canvas, exportSettings, project.metadata);
  const durationSec = resolveExportTimelineDuration(project);
  const videoClips = getEffectiveVideoClips(project);
  const videoVisible = canvas.videoVisible !== false;
  const isStaticVisualMode = !videoVisible || videoClips.length === 0;

  const targetFps = computeExportTargetFps({
    sourceFps: project.metadata?.fps,
    videoVisible,
    videoClipCount: videoClips.length,
  });

  const voiceVol = Math.max(0, Math.min(2.0, Number(project.voice.voiceVolume ?? 1.0)));
  const dubActive = Boolean(
    exportSettings.applyDubbing &&
      project.voice.enabled &&
      !project.voice.voiceMuted &&
      voiceVol > 0.005 &&
      (project.voice.fullDubUrl || (project.voice.generatedClips || []).some((c) => Boolean(c.audioUrl)))
  );
  const origMuted =
    project.voice.originalAudioRemoved ||
    (project.voice.originalAudioMuted !== undefined
      ? Boolean(project.voice.originalAudioMuted)
      : !Boolean(project.voice.preserveOriginalAudio)) ||
    Math.max(0, Number(project.voice.originalAudioVolume ?? 1.0)) <= 0.005;
  const origActive = Boolean(project.metadata?.hasAudio !== false && !origMuted);
  const bgmActive = Boolean(
    exportSettings.applyAudioMix &&
      !project.voice.bgMusicMuted &&
      Number(project.voice.bgMusicVolume ?? 0) > 0.005 &&
      (project.voice.bgMusicUrl || (project.voice.bgMusicClips || []).length > 0)
  );
  const sfxActive = Boolean(
    exportSettings.applyAudioMix &&
      project.voice.sfxEnabled &&
      !project.voice.sfxMuted &&
      Number(project.voice.sfxVolume ?? 1.0) > 0.005 &&
      (project.voice.sfxUrl || (project.voice.sfxClips || []).length > 0)
  );

  const hasAnyAudio = dubActive || origActive || bgmActive || sfxActive;
  const targetAudioBitrateKbps = hasAnyAudio ? EXPORT_AUDIO_BITRATE_KBPS : 0;

  // Estimate realistic H.264 VBR bitrate scaled by pixel area, motion complexity, and chosen speed preset
  const pixelFactor = Math.max(0.25, Math.min(1.12, (width * height) / (1920 * 1080)));
  const fpsFactor = Math.max(0.5, Math.min(1.0, targetFps / 30));

  let estVideoKbps: number;
  let minVideoKbps: number;
  let maxVideoKbps: number;

  if (isStaticVisualMode) {
    // Static background + karaoke captions skips unchanged macroblocks aggressively
    const hasMotionOverlays =
      (exportSettings.applyCaptions && project.captions.length > 0) ||
      (exportSettings.applyLogo && project.logos.some((l) => l.enabled && l.motion?.enabled));
    estVideoKbps = Math.round((hasMotionOverlays ? 480 : 220) * Math.sqrt(pixelFactor));
    minVideoKbps = Math.round((hasMotionOverlays ? 280 : 120) * Math.sqrt(pixelFactor));
    maxVideoKbps = Math.min(speedPreset.videoMaxrateKbps, Math.round(850 * Math.sqrt(pixelFactor)));
  } else {
    estVideoKbps = Math.min(
      speedPreset.videoMaxrateKbps,
      Math.round(speedPreset.videoTargetKbps * pixelFactor * fpsFactor)
    );
    minVideoKbps = Math.min(
      speedPreset.videoMaxrateKbps,
      Math.round(speedPreset.videoTargetKbps * 0.7 * pixelFactor * fpsFactor)
    );
    maxVideoKbps = Math.min(
      speedPreset.videoMaxrateKbps,
      Math.round(speedPreset.videoMaxrateKbps * Math.min(1, pixelFactor * 1.1))
    );
  }

  const containerOverhead = 1.012; // MP4 moov/mdat framing (~1.2%)
  const toBytes = (vKbps: number) =>
    Math.round((((vKbps + targetAudioBitrateKbps) * 1000) / 8) * durationSec * containerOverhead);

  return {
    durationSec,
    width,
    height,
    targetFps,
    speedProfile: speedPreset.profile,
    targetVideoKbps: speedPreset.videoTargetKbps,
    targetVideoMaxrateKbps: speedPreset.videoMaxrateKbps,
    targetAudioBitrateKbps,
    crf: speedPreset.crf,
    isStaticVisualMode,
    hasAnyAudio,
    estimatedBytes: toBytes(estVideoKbps),
    minBytes: toBytes(minVideoKbps),
    maxBytes: toBytes(maxVideoKbps),
  };
}
