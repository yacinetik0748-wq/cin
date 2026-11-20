import { DEFAULT_VIDEO_CANVAS, Project } from '../types/studio';
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

export const EXPORT_H264_CRF = 24; // Within target CRF 23-26 range
export const EXPORT_VIDEO_MAXRATE_KBPS = 2500; // 2.5 Mbps target cap
export const EXPORT_VIDEO_BUFSIZE_KBPS = 5000;
export const EXPORT_AUDIO_BITRATE_KBPS = 128; // 128 kbps AAC
export const EXPORT_AUDIO_SAMPLE_RATE = 44100; // 44.1 kHz
export const EXPORT_TARGET_FPS = 30;

export interface ExportSizeEstimate {
  durationSec: number;
  width: number;
  height: number;
  targetFps: number;
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

  // Estimate realistic H.264 CRF 24 bitrate scaled by pixel area and motion complexity, capped at 2.5 Mbps
  const pixelFactor = Math.max(0.2, Math.min(1.15, (width * height) / (1920 * 1080)));
  const fpsFactor = Math.max(0.5, Math.min(1.0, targetFps / 30));

  let estVideoKbps: number;
  let minVideoKbps: number;
  let maxVideoKbps: number;

  if (isStaticVisualMode) {
    // Static background + karaoke captions skips unchanged macroblocks aggressively
    const hasMotionOverlays =
      (exportSettings.applyCaptions && project.captions.length > 0) ||
      (exportSettings.applyLogo && project.logos.some((l) => l.enabled && l.motion?.enabled));
    estVideoKbps = Math.round((hasMotionOverlays ? 720 : 320) * Math.sqrt(pixelFactor));
    minVideoKbps = Math.round((hasMotionOverlays ? 420 : 180) * Math.sqrt(pixelFactor));
    maxVideoKbps = Math.min(EXPORT_VIDEO_MAXRATE_KBPS, Math.round(1350 * Math.sqrt(pixelFactor)));
  } else {
    // Normal recap motion footage capped by -maxrate 2500k
    estVideoKbps = Math.min(EXPORT_VIDEO_MAXRATE_KBPS, Math.round(1950 * pixelFactor * fpsFactor));
    minVideoKbps = Math.min(EXPORT_VIDEO_MAXRATE_KBPS, Math.round(1250 * pixelFactor * fpsFactor));
    maxVideoKbps = Math.min(EXPORT_VIDEO_MAXRATE_KBPS, Math.round(EXPORT_VIDEO_MAXRATE_KBPS * Math.min(1, pixelFactor * 1.15)));
  }

  const containerOverhead = 1.015; // MP4 moov/mdat framing (~1.5%)
  const toBytes = (vKbps: number) =>
    Math.round((((vKbps + targetAudioBitrateKbps) * 1000) / 8) * durationSec * containerOverhead);

  return {
    durationSec,
    width,
    height,
    targetFps,
    targetVideoMaxrateKbps: EXPORT_VIDEO_MAXRATE_KBPS,
    targetAudioBitrateKbps,
    crf: EXPORT_H264_CRF,
    isStaticVisualMode,
    hasAnyAudio,
    estimatedBytes: toBytes(estVideoKbps),
    minBytes: toBytes(minVideoKbps),
    maxBytes: toBytes(maxVideoKbps),
  };
}
