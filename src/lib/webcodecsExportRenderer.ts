import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import {
  BlurEffect,
  DEFAULT_VIDEO_CANVAS,
  LogoOverlay,
  Project,
  TrackingKeyframe,
  VideoClip,
} from '../types/studio';
import { getBlobAssetByKey, retrieveProjectVideoBlob } from './browserStorage';
import {
  buildPrecomputedCaptionCache,
  drawCachedCaptionsAtTime,
  PrecomputedCaptionCache,
} from './captionLayoutCache';
import { isOrigAudioActive } from './clientExportRenderer';
import {
  isBrowserFFmpegMultiThreaded,
  resolveMediaBlob,
  safeDeleteMemfsFile,
  withFFmpegLock,
} from './clientMediaEngine';
import {
  computeExportTargetFps,
  EXPORT_AUDIO_BITRATE_KBPS,
  EXPORT_AUDIO_SAMPLE_RATE,
  EXPORT_TARGET_FPS,
  EXPORT_VIDEO_TARGET_KBPS,
  resolveExportSpeedPreset,
  resolveExportTimelineDuration,
} from './exportEstimation';
import { resolveCombinedVideoFilter } from './videoFiltersCatalog';
import {
  clampVideoSpeed,
  getEffectiveBgmClips,
  getEffectiveOriginalAudioClips,
  getEffectiveSfxClips,
  getEffectiveVideoClips,
  getVideoClipTimelineDuration,
  hasCustomVideoEdits,
} from './videoTimeline';
import { getSyncedCaptionsForPreview, resolveCanvasDimensions } from './workflowStages';
import {
  buildSyncedCaptionsForRender,
  remapBlursForSyncPlan,
  remapLogosForSyncPlan,
} from '../../server/services/timeline_sync_service';
import { resolveBlurIntervals } from './blurMasks';

export interface SmartExportCapabilities {
  webCodecsVideo: boolean;
  webCodecsAudio: boolean;
  hardwareAccelerated: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  audioChannels: number;
  offscreenCanvas: boolean;
  ffmpegMultiThread: boolean;
  mediaRecorderFormat: string;
}

export interface WebCodecsExportResult {
  blob: Blob;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  engine: 'webcodecs-hardware' | 'webcodecs-software';
  hardwareAccelerated: boolean;
  videoCodec: string;
  audioCodec: string | null;
  bitrateControl: 'vbr-bitrate';
  targetVideoKbps: number;
  targetAudioKbps: number;
  renderDurationMs: number;
  audioBranches: string[];
  framesRendered: number;
  staticFramesReused: number;
  peakHeapMb: number | null;
}

const AVC_CODEC_CANDIDATES = [
  'avc1.4d002a', // H.264 Main Level 4.2 (1080x1920@30)
  'avc1.64002a', // H.264 High Level 4.2
  'avc1.42E02A', // Constrained Baseline Level 4.2 (broad Android HW compatibility)
  'avc1.4d0028', // Main Level 4.0
  'avc1.42001f', // Baseline fallback
];

type CanvasSurface = OffscreenCanvas | HTMLCanvasElement;
type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function createSurface(width: number, height: number): { canvas: CanvasSurface; ctx: Canvas2D } {
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const oc = new OffscreenCanvas(width, height);
      const ctx = oc.getContext('2d', { alpha: false });
      if (ctx) return { canvas: oc, ctx };
    } catch {
      // fallback to HTMLCanvasElement
    }
  }
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Failed to create 2D rendering surface.');
  return { canvas: c, ctx };
}

function createAlphaSurface(width: number, height: number): { canvas: CanvasSurface; ctx: Canvas2D } {
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const oc = new OffscreenCanvas(width, height);
      const ctx = oc.getContext('2d');
      if (ctx) return { canvas: oc, ctx };
    } catch {
      // fallback
    }
  }
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Failed to create alpha scratch surface.');
  return { canvas: c, ctx };
}

function readHeapMb(): number | null {
  try {
    const perf = performance as unknown as { memory?: { usedJSHeapSize?: number } };
    if (perf.memory?.usedJSHeapSize) {
      return Number((perf.memory.usedJSHeapSize / (1024 * 1024)).toFixed(1));
    }
  } catch {
    // ignore
  }
  return null;
}

export async function detectSmartExportCapabilities(
  width = 1080,
  height = 1920,
  fps = EXPORT_TARGET_FPS
): Promise<SmartExportCapabilities> {
  const safeW = Math.max(64, Math.round(width) & ~1);
  const safeH = Math.max(64, Math.round(height) & ~1);
  const offscreenCanvas = typeof OffscreenCanvas !== 'undefined';
  const ffmpegMultiThread = isBrowserFFmpegMultiThreaded();

  let webCodecsVideo = false;
  let hardwareAccelerated = false;
  let videoCodec: string | null = null;

  if (typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined') {
    // Pass 1: Prefer hardware H.264 encoder
    for (const codec of AVC_CODEC_CANDIDATES) {
      try {
        const res = await VideoEncoder.isConfigSupported({
          codec,
          width: safeW,
          height: safeH,
          bitrate: EXPORT_VIDEO_TARGET_KBPS * 1000,
          framerate: fps,
          bitrateMode: 'variable',
          hardwareAcceleration: 'prefer-hardware',
          avc: { format: 'avc' },
        });
        if (res.supported) {
          webCodecsVideo = true;
          hardwareAccelerated = true;
          videoCodec = res.config?.codec || codec;
          break;
        }
      } catch {
        // try next codec
      }
    }

    // Pass 2: Any available H.264 WebCodecs encoder ('no-preference')
    if (!webCodecsVideo) {
      for (const codec of AVC_CODEC_CANDIDATES) {
        try {
          const res = await VideoEncoder.isConfigSupported({
            codec,
            width: safeW,
            height: safeH,
            bitrate: EXPORT_VIDEO_TARGET_KBPS * 1000,
            framerate: fps,
            bitrateMode: 'variable',
            hardwareAcceleration: 'no-preference',
            avc: { format: 'avc' },
          });
          if (res.supported) {
            webCodecsVideo = true;
            hardwareAccelerated = false;
            videoCodec = res.config?.codec || codec;
            break;
          }
        } catch {
          // try next codec
        }
      }
    }
  }

  let webCodecsAudio = false;
  let audioCodec: string | null = null;
  let audioChannels = 2;

  if (typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined') {
    for (const ch of [2, 1]) {
      try {
        const res = await AudioEncoder.isConfigSupported({
          codec: 'mp4a.40.2',
          sampleRate: EXPORT_AUDIO_SAMPLE_RATE,
          numberOfChannels: ch,
          bitrate: EXPORT_AUDIO_BITRATE_KBPS * 1000,
        });
        if (res.supported) {
          webCodecsAudio = true;
          audioCodec = 'mp4a.40.2';
          audioChannels = ch;
          break;
        }
      } catch {
        // try next channel count
      }
    }
  }

  let mediaRecorderFormat = 'webm';
  if (typeof MediaRecorder !== 'undefined') {
    if (MediaRecorder.isTypeSupported('video/mp4;codecs=avc1,mp4a.40.2')) {
      mediaRecorderFormat = 'mp4 (H.264)';
    } else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) {
      mediaRecorderFormat = 'webm (VP9)';
    }
  }

  return {
    webCodecsVideo,
    webCodecsAudio,
    hardwareAccelerated,
    videoCodec,
    audioCodec,
    audioChannels,
    offscreenCanvas,
    ffmpegMultiThread,
    mediaRecorderFormat,
  };
}

/**
 * Checks if FFmpeg stream-copy (-c:v copy) is valid (zero visual modifications, matching dimensions, <=30fps).
 */
export function canProjectUseStreamCopy(project: Project): boolean {
  const canvas = { ...DEFAULT_VIDEO_CANVAS, ...(project.canvas || {}) };
  const { exportSettings } = project;
  const meta = project.metadata;
  if (!meta) return false;
  const dims = resolveCanvasDimensions(canvas, exportSettings, meta);
  const customEdits = hasCustomVideoEdits(project);
  const hasHolds = (project.voice.syncPlan?.holds?.length || 0) > 0;
  const hasEffects =
    exportSettings.applyVideoEffects !== false &&
    Boolean(
      project.videoEffects &&
        !project.videoEffects.compareMode &&
        ((project.videoEffects.filterPreset && project.videoEffects.filterPreset !== 'none') ||
          (project.videoEffects.filterStack || []).some((f) => f.enabled) ||
          (project.videoEffects.effects || []).some((e) => e.enabled && e.intensity > 0) ||
          Object.values(project.videoEffects.adjustments || {}).some((v) => Number(v || 0) !== 0))
    );
  const hasBlurs = exportSettings.applyBlur && project.blurs.some((b) => b.enabled);
  const hasLogos = exportSettings.applyLogo && project.logos.some((l) => l.enabled);
  const hasCaptions =
    exportSettings.applyCaptions &&
    project.subtitleStyle.enabled &&
    project.subtitleStyle.visible !== false &&
    project.captions.length > 0;
  const hasCustomTransform =
    canvas.aspectRatio !== 'original' ||
    (canvas.cropMode && canvas.cropMode !== 'fit') ||
    Math.abs((canvas.zoom || 1) - 1) > 0.005 ||
    Math.abs(canvas.offsetX || 0) > 0.1 ||
    Math.abs(canvas.offsetY || 0) > 0.1 ||
    Math.abs(canvas.videoRotation || 0) > 0.2 ||
    Boolean(canvas.flipH) ||
    Boolean(canvas.flipV) ||
    (canvas.videoOpacity ?? 1) < 0.99 ||
    canvas.videoVisible === false ||
    (canvas.cropTop || 0) > 0 ||
    (canvas.cropRight || 0) > 0 ||
    (canvas.cropBottom || 0) > 0 ||
    (canvas.cropLeft || 0) > 0 ||
    canvas.backgroundType !== 'solid';

  const totalDur = resolveExportTimelineDuration(project);
  return (
    exportSettings.aspectRatio === 'original' &&
    dims.width === meta.width &&
    dims.height === meta.height &&
    (meta.fps || 30) <= 30.5 &&
    (meta.bitrate || 0) <= 3_000_000 &&
    !hasCustomTransform &&
    !customEdits &&
    !hasHolds &&
    !hasEffects &&
    !hasBlurs &&
    !hasLogos &&
    !hasCaptions &&
    Math.abs(totalDur - meta.duration) <= 0.25 &&
    ['h264', 'hevc', 'av1'].includes((meta.videoCodec || '').toLowerCase())
  );
}

function encodeAudioBufferToWav(buf: AudioBuffer): Uint8Array {
  const numChannels = buf.numberOfChannels;
  const sampleRate = buf.sampleRate;
  const numSamples = buf.length;
  const dataSize = numSamples * numChannels * 2;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true);
  view.setUint16(32, numChannels * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  const channels = Array.from({ length: numChannels }, (_, ch) => buf.getChannelData(ch));
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, Math.round(sample * 32767), true);
      offset += 2;
    }
  }
  return new Uint8Array(out);
}

async function mixProjectAudioOffline(params: {
  project: Project;
  sourceVideoBlob: Blob;
  durationSec: number;
  channels: number;
  signal?: AbortSignal;
}): Promise<{ buffer: AudioBuffer | null; activeBranches: string[] }> {
  const { project, sourceVideoBlob, durationSec, channels, signal } = params;
  const activeBranches: string[] = [];
  const { exportSettings, voice } = project;
  const sampleRate = EXPORT_AUDIO_SAMPLE_RATE;
  const totalSamples = Math.max(sampleRate, Math.ceil(durationSec * sampleRate));

  const origActive = project.metadata?.hasAudio !== false && isOrigAudioActive(voice);
  const voiceVol = Math.max(0, Math.min(2.0, Number(voice.voiceVolume ?? 1.0)));
  const dubRequested = Boolean(
    exportSettings.applyDubbing && voice.enabled && !voice.voiceMuted && voiceVol > 0.005
  );
  const bgmVol = Math.max(0, Math.min(2.0, Number(voice.bgMusicVolume ?? 0)));
  const bgmEnabled = Boolean(
    exportSettings.applyAudioMix &&
      (voice.bgMusicEnabled !== undefined
        ? voice.bgMusicEnabled
        : Boolean(voice.bgMusicUrl && bgmVol > 0.005)) &&
      !voice.bgMusicMuted &&
      bgmVol > 0.005
  );
  const sfxVol = Math.max(0, Math.min(2.0, Number(voice.sfxVolume ?? 1.0)));
  const sfxEnabled = Boolean(
    exportSettings.applyAudioMix && voice.sfxEnabled && !voice.sfxMuted && sfxVol > 0.005
  );

  if (!origActive && !dubRequested && !bgmEnabled && !sfxEnabled) {
    return { buffer: null, activeBranches };
  }

  const offline = new OfflineAudioContext(channels, totalSamples, sampleRate);
  const decodedCache = new Map<string, AudioBuffer | null>();

  const decodeOnce = async (key: string, loader: () => Promise<Blob | null>): Promise<AudioBuffer | null> => {
    if (decodedCache.has(key)) return decodedCache.get(key) || null;
    try {
      const b = await loader();
      if (!b || b.size === 0) {
        decodedCache.set(key, null);
        return null;
      }
      const ab = await b.arrayBuffer();
      const buf = await offline.decodeAudioData(ab.slice(0));
      decodedCache.set(key, buf);
      return buf;
    } catch {
      decodedCache.set(key, null);
      return null;
    }
  };

  const scheduleClip = (
    buf: AudioBuffer,
    timelineStart: number,
    srcStart: number,
    srcDur: number,
    vol: number,
    speed = 1.0,
    loop = false,
    applyFades = false
  ) => {
    const src = offline.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.max(0.25, Math.min(4.0, speed));
    src.loop = loop;
    const gain = offline.createGain();
    const safeVol = Math.max(0, Math.min(2.0, vol));
    gain.gain.setValueAtTime(safeVol, Math.max(0, timelineStart));
    if (applyFades && exportSettings.applyAudioMix) {
      const fin = Math.max(0, voice.fadeInSec || 0);
      const fout = Math.max(0, voice.fadeOutSec || 0);
      if (fin > 0.04) {
        gain.gain.setValueAtTime(0.001, 0);
        gain.gain.linearRampToValueAtTime(safeVol, Math.min(durationSec, fin));
      }
      if (fout > 0.04 && durationSec > fout + 0.05) {
        const fs = Math.max(0, durationSec - fout);
        gain.gain.setValueAtTime(safeVol, fs);
        gain.gain.linearRampToValueAtTime(0.001, durationSec);
      }
    }
    src.connect(gain);
    gain.connect(offline.destination);
    const playOffset = Math.max(0, srcStart);
    const safeTimelineStart = Math.max(0, timelineStart);
    if (loop) {
      src.start(safeTimelineStart, playOffset, Math.max(0.05, durationSec - safeTimelineStart));
    } else {
      const playDur = Math.max(0.02, Math.min(buf.duration - playOffset, srcDur));
      src.start(safeTimelineStart, playOffset, playDur);
    }
  };

  // 1. Original Audio
  if (origActive) {
    const srcAudioBuf = await decodeOnce('__source_video__', async () => sourceVideoBlob);
    if (srcAudioBuf) {
      const trackOrigVol = Math.max(0, Math.min(2.0, Number(voice.originalAudioVolume ?? 1.0)));
      const origClips = getEffectiveOriginalAudioClips(project).filter(
        (c) => !c.muted && Math.max(0, Number(c.volume ?? 1.0)) > 0.005
      );
      if (project.originalAudioClips && project.originalAudioClips.length > 0) {
        for (const c of origClips) {
          const sStart = Math.max(0, Number(c.sourceStart || 0));
          const sEnd = Math.max(sStart + 0.05, Number(c.sourceEnd || srcAudioBuf.duration));
          scheduleClip(
            srcAudioBuf,
            Math.max(0, Number(c.timelineStart || 0)),
            sStart,
            sEnd - sStart,
            trackOrigVol * Number(c.volume ?? 1.0),
            c.speed ?? 1.0,
            false,
            true
          );
        }
        if (origClips.length > 0) activeBranches.push('original-audio-unlinked');
      } else {
        const vClips = getEffectiveVideoClips(project).filter((c) => !c.audioUnlinked);
        if (vClips.length > 0 && hasCustomVideoEdits(project)) {
          for (const c of vClips) {
            const sStart = Math.max(0, Number(c.sourceStart || 0));
            const sEnd = Math.max(sStart + 0.05, Number(c.sourceEnd || srcAudioBuf.duration));
            scheduleClip(
              srcAudioBuf,
              Math.max(0, Number(c.timelineStart || 0)),
              sStart,
              sEnd - sStart,
              trackOrigVol,
              c.speed ?? 1.0,
              false,
              true
            );
          }
        } else {
          scheduleClip(srcAudioBuf, 0, 0, srcAudioBuf.duration, trackOrigVol, 1.0, false, true);
        }
        activeBranches.push('original-audio');
      }
    }
  }

  if (signal?.aborted) throw new DOMException('Export cancelled by user.', 'AbortError');

  // 2. AI Voiceover Dubbing
  if (dubRequested) {
    const clips = voice.generatedClips || [];
    const hasPerClipSpeed = clips.some((c) => Math.abs(clampVideoSpeed(c.speed ?? 1.0) - 1.0) > 0.005);
    const offsetSec = Number(voice.timingOffsetSec || 0);
    const globalSpd = clampVideoSpeed(voice.speakingSpeed ?? 1.0);

    if (voice.fullDubUrl && (!hasPerClipSpeed || clips.length === 0)) {
      const dubBuf = await decodeOnce(voice.fullDubUrl, () =>
        resolveMediaBlob(voice.fullDubUrl!).catch(() => null)
      );
      if (dubBuf) {
        const srcSkip = offsetSec < 0 ? Math.abs(offsetSec) : 0;
        scheduleClip(
          dubBuf,
          Math.max(0, offsetSec),
          srcSkip,
          dubBuf.duration - srcSkip,
          voiceVol,
          globalSpd,
          false,
          true
        );
        activeBranches.push('voiceover-full-dub');
      }
    } else if (clips.length > 0) {
      let count = 0;
      for (const clip of clips) {
        if (!clip.audioUrl) continue;
        const cBuf = await decodeOnce(clip.audioUrl, () =>
          resolveMediaBlob(clip.audioUrl).catch(() => null)
        );
        if (!cBuf) continue;
        const trimStart = Math.max(0, Number(clip.trimStartSec ?? clip.leadingSilence ?? 0));
        const trimEndOff = Math.max(0, Number(clip.trimEndSec ?? clip.trailingSilence ?? 0));
        const playDur = Math.max(0.05, cBuf.duration - trimStart - trimEndOff);
        const tlStart = Number(clip.start || 0) + offsetSec;
        const srcSkip = tlStart < 0 ? trimStart + Math.abs(tlStart) : trimStart;
        scheduleClip(
          cBuf,
          Math.max(0, tlStart),
          srcSkip,
          playDur,
          voiceVol,
          clampVideoSpeed((clip.speed ?? 1.0) * globalSpd),
          false,
          true
        );
        count++;
      }
      if (count > 0) activeBranches.push(`voiceover-clips(${count})`);
    }
  }

  // 3. Background Music
  if (bgmEnabled) {
    const bgmClips = getEffectiveBgmClips(project, durationSec).filter(
      (c) => !c.muted && Math.max(0, Number(c.volume ?? 1.0)) > 0.005
    );
    if (bgmClips.length > 0) {
      let count = 0;
      for (const c of bgmClips) {
        const u = c.audioUrl || voice.bgMusicUrl || '';
        if (!u) continue;
        const bBuf = await decodeOnce(u, () => resolveMediaBlob(u).catch(() => null));
        if (!bBuf) continue;
        const sStart = Math.max(0, Number(c.sourceStart || 0));
        const sEnd = Math.max(sStart + 0.05, Number(c.sourceEnd || bBuf.duration));
        scheduleClip(
          bBuf,
          Math.max(0, Number(c.timelineStart || 0)),
          sStart,
          sEnd - sStart,
          bgmVol * Number(c.volume ?? 1.0),
          1.0,
          Boolean(c.loop),
          true
        );
        count++;
      }
      if (count > 0) activeBranches.push(`bgm-clips(${count})`);
    } else if (voice.bgMusicUrl) {
      const bBuf = await decodeOnce(voice.bgMusicUrl, () =>
        resolveMediaBlob(voice.bgMusicUrl!).catch(() => null)
      );
      if (bBuf) {
        scheduleClip(bBuf, 0, 0, durationSec, bgmVol, 1.0, true, true);
        activeBranches.push('bgm');
      }
    }
  }

  // 4. Sound Effects
  if (sfxEnabled) {
    const sfxClips = getEffectiveSfxClips(project, durationSec).filter(
      (c) => !c.muted && Math.max(0, Number(c.volume ?? 1.0)) > 0.005
    );
    if (sfxClips.length > 0) {
      let count = 0;
      for (const c of sfxClips) {
        const u = c.audioUrl || voice.sfxUrl || '';
        if (!u) continue;
        const sBuf = await decodeOnce(u, () => resolveMediaBlob(u).catch(() => null));
        if (!sBuf) continue;
        const sStart = Math.max(0, Number(c.sourceStart || 0));
        const sEnd = Math.max(sStart + 0.05, Number(c.sourceEnd || sBuf.duration));
        scheduleClip(
          sBuf,
          Math.max(0, Number(c.timelineStart || 0)),
          sStart,
          sEnd - sStart,
          sfxVol * Number(c.volume ?? 1.0),
          1.0,
          Boolean(c.loop),
          false
        );
        count++;
      }
      if (count > 0) activeBranches.push(`sfx-clips(${count})`);
    } else if (voice.sfxUrl) {
      const sBuf = await decodeOnce(voice.sfxUrl, () =>
        resolveMediaBlob(voice.sfxUrl!).catch(() => null)
      );
      if (sBuf) {
        scheduleClip(sBuf, 0, 0, sBuf.duration, sfxVol, 1.0, false, false);
        activeBranches.push('sfx');
      }
    }
  }

  if (activeBranches.length === 0) {
    return { buffer: null, activeBranches };
  }

  const rendered = await offline.startRendering();
  return { buffer: rendered, activeBranches };
}

function interpolateKeyframes(kfs: TrackingKeyframe[], t: number): TrackingKeyframe {
  if (kfs.length <= 1) return kfs[0];
  let prev = kfs[0];
  let next = kfs[kfs.length - 1];
  for (let i = 0; i < kfs.length; i++) {
    if (kfs[i].time <= t) prev = kfs[i];
    if (kfs[i].time >= t) {
      next = kfs[i];
      break;
    }
  }
  if (prev === next || next.time <= prev.time) return prev;
  const r = Math.max(0, Math.min(1, (t - prev.time) / (next.time - prev.time)));
  return {
    time: t,
    x: prev.x + (next.x - prev.x) * r,
    y: prev.y + (next.y - prev.y) * r,
    width: prev.width + (next.width - prev.width) * r,
    height: prev.height + (next.height - prev.height) * r,
  };
}

function resolveLogoPos(logo: LogoOverlay, t: number): { x: number; y: number } {
  const m = logo.motion;
  if (!m || !m.enabled || m.pattern === 'static') {
    return { x: logo.x, y: logo.y };
  }
  const speed = Math.max(0.2, Math.min(3.0, m.speed || 1));
  const maxW = Math.max(0.05, 1 - logo.widthPct / 100);
  const maxH = 0.86;
  if (m.pattern === 'bounce') {
    return {
      x: Math.abs(((logo.x + t * 0.16 * speed) % (2 * maxW)) - maxW),
      y: Math.abs(((logo.y + t * 0.13 * speed) % (2 * maxH)) - maxH),
    };
  }
  if (m.pattern === 'horizontal') {
    return {
      x: Math.abs(((logo.x + t * 0.18 * speed) % (2 * maxW)) - maxW),
      y: logo.y,
    };
  }
  if (m.pattern === 'orbit') {
    const omega = 1.6 * speed;
    return {
      x: Math.max(0, Math.min(maxW, logo.x + 0.14 * Math.sin(t * omega))),
      y: Math.max(0, Math.min(maxH, logo.y + 0.12 * Math.cos(t * omega))),
    };
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
}

function findTimelineClipAtTime(
  clips: VideoClip[],
  timeSec: number,
  origDur: number,
  holds: NonNullable<Project['voice']['syncPlan']>['holds'] | undefined
): { clip: VideoClip | null; sourceTime: number; isHold: boolean } {
  // Handle flexible sync holds if unedited video clips
  if (holds && holds.length > 0) {
    let accumulatedHold = 0;
    for (const h of holds) {
      const srcAt = Number(h.atVideoTime || 0);
      const holdStartOnTimeline = srcAt + accumulatedHold;
      const holdDur = Math.max(0, h.holdDuration || 0);
      if (timeSec >= holdStartOnTimeline && timeSec <= holdStartOnTimeline + holdDur) {
        return { clip: clips[0] || null, sourceTime: Math.min(origDur - 0.04, srcAt), isHold: true };
      }
      if (timeSec < holdStartOnTimeline) break;
      accumulatedHold += holdDur;
    }
    const mappedSrc = Math.min(origDur - 0.04, Math.max(0, timeSec - accumulatedHold));
    return { clip: clips[0] || null, sourceTime: mappedSrc, isHold: false };
  }

  for (let i = clips.length - 1; i >= 0; i--) {
    const c = clips[i];
    const tlStart = Math.max(0, Number(c.timelineStart || 0));
    const tlDur = getVideoClipTimelineDuration(c);
    const tlEnd = tlStart + tlDur;
    if (timeSec >= tlStart - 0.002 && timeSec <= tlEnd + 0.002) {
      const spd = clampVideoSpeed(c.speed);
      const localOffset = Math.max(0, timeSec - tlStart);
      const sTime = Math.min(
        Math.max(0, Number(c.sourceEnd || origDur) - 0.02),
        Math.max(0, Number(c.sourceStart || 0) + localOffset * spd)
      );
      return { clip: c, sourceTime: sTime, isHold: false };
    }
  }
  return { clip: null, sourceTime: -1, isHold: false };
}

function seekVideoToExactTime(video: HTMLVideoElement, targetSec: number): Promise<void> {
  const clamped = Math.max(0, Math.min(targetSec, Math.max(0.05, (video.duration || 10) - 0.03)));
  if (Math.abs(video.currentTime - clamped) <= 0.004 && video.readyState >= 2) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('seeked', finish);
      resolve();
    };
    const timer = setTimeout(finish, 400);
    video.addEventListener('seeked', finish, { once: true });
    video.currentTime = clamped;
  });
}

async function loadImageAsset(url: string): Promise<ImageBitmap | HTMLImageElement | null> {
  try {
    let blob: Blob | null = null;
    if (url.startsWith('idb://blobs/')) {
      blob = await getBlobAssetByKey(url.slice('idb://blobs/'.length)).catch(() => null);
    } else {
      blob = await resolveMediaBlob(url).catch(() => null);
    }
    if (!blob || blob.size === 0) return null;
    if (typeof createImageBitmap === 'function') {
      return await createImageBitmap(blob);
    }
    const objUrl = URL.createObjectURL(blob);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej();
      img.src = objUrl;
    });
    setTimeout(() => URL.revokeObjectURL(objUrl), 60_000);
    return img;
  } catch {
    return null;
  }
}

export async function renderProjectWithWebCodecs(params: {
  project: Project;
  capabilities: SmartExportCapabilities;
  onProgress: (pct: number, stage: string, etaSec?: number | null) => void;
  signal?: AbortSignal;
}): Promise<WebCodecsExportResult> {
  const { project, capabilities, onProgress, signal } = params;
  const startedAt = performance.now();

  if (signal?.aborted) throw new DOMException('Export cancelled by user.', 'AbortError');
  if (!capabilities.webCodecsVideo || !capabilities.videoCodec) {
    throw new Error('WebCodecs H.264 VideoEncoder is not supported on this device.');
  }

  onProgress(4, 'Initializing hardware-accelerated WebCodecs exporter...', null);

  const retrieved = await retrieveProjectVideoBlob(project).catch(() => null);
  if (!retrieved?.blob || retrieved.blob.size === 0) {
    throw new Error('Project video file not found in local IndexedDB storage.');
  }

  const { exportSettings } = project;
  const speedPreset = resolveExportSpeedPreset(exportSettings.speedProfile);
  const canvasConfig = { ...DEFAULT_VIDEO_CANVAS, ...(project.canvas || {}) };
  const { width, height } = resolveCanvasDimensions(canvasConfig, exportSettings, project.metadata);
  const targetW = Math.max(64, Math.round(width) & ~1);
  const targetH = Math.max(64, Math.round(height) & ~1);

  const videoClips = getEffectiveVideoClips(project);
  const videoVisible = canvasConfig.videoVisible !== false;
  const isStaticVisualMode = !videoVisible || videoClips.length === 0;
  const targetFps = computeExportTargetFps({
    sourceFps: project.metadata?.fps,
    videoVisible,
    videoClipCount: videoClips.length,
  });
  const totalDuration = resolveExportTimelineDuration(project);
  const totalFrames = Math.max(1, Math.round(totalDuration * targetFps));
  const frameDurUs = Math.round(1_000_000 / targetFps);

  // Load source video into single reusable decoder element (when video clips are visible)
  let videoUrl: string | null = null;
  let videoEl: HTMLVideoElement | null = null;
  let srcW = project.metadata?.width || targetW;
  let srcH = project.metadata?.height || targetH;
  let origDur = Math.max(0.5, project.metadata?.duration || totalDuration);

  if (!isStaticVisualMode) {
    videoUrl = URL.createObjectURL(retrieved.blob);
    videoEl = document.createElement('video');
    videoEl.src = videoUrl;
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.preload = 'auto';
    videoEl.crossOrigin = 'anonymous';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Video metadata load timeout.')), 20_000);
      videoEl!.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve();
      };
      videoEl!.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Failed to decode source video in browser.'));
      };
      videoEl!.load();
    });
    srcW = videoEl.videoWidth || srcW;
    srcH = videoEl.videoHeight || srcH;
    origDur = Math.max(0.5, videoEl.duration || origDur);
  }

  // Preload background image, logos & precompute caption layout cache
  onProgress(8, 'Precomputing captions, graphics & audio mix...', null);
  const bgImg =
    canvasConfig.backgroundType === 'image' &&
    canvasConfig.bgImageUrl &&
    canvasConfig.bgImageVisible !== false
      ? await loadImageAsset(canvasConfig.bgImageUrl)
      : null;

  const logoAssets: Array<{ logo: LogoOverlay; bitmap: ImageBitmap | HTMLImageElement }> = [];
  if (exportSettings.applyLogo && project.logos.length > 0) {
    for (const l of project.logos.filter((item) => item.enabled && item.url)) {
      const bm = await loadImageAsset(l.url);
      if (bm) logoAssets.push({ logo: l, bitmap: bm });
    }
  }

  const dubVol = Math.max(0, Math.min(2.0, Number(project.voice.voiceVolume ?? 1.0)));
  const dubbingAvailable = Boolean(
    exportSettings.applyDubbing &&
      project.voice.enabled &&
      !project.voice.voiceMuted &&
      dubVol > 0.005 &&
      (project.voice.fullDubUrl || (project.voice.generatedClips || []).some((c) => c.audioUrl))
  );
  const activeSyncPlan =
    !hasCustomVideoEdits(project) &&
    dubbingAvailable &&
    (project.voice.syncMode || 'flexible') === 'flexible' &&
    (project.voice.syncPlan?.holds?.length || 0) > 0
      ? project.voice.syncPlan
      : undefined;

  const captionOffset =
    (dubbingAvailable ? Number(project.voice.timingOffsetSec || 0) : 0) +
    Number(project.subtitleStyle.timingOffsetSec || 0);
  const syncedCaptions =
    dubbingAvailable && project.voice.syncPlan
      ? buildSyncedCaptionsForRender(project.captions, project.voice.syncPlan, captionOffset)
      : captionOffset !== 0
      ? buildSyncedCaptionsForRender(project.captions, undefined, captionOffset)
      : getSyncedCaptionsForPreview(project);

  const captionsEnabled = Boolean(
    exportSettings.applyCaptions &&
      project.subtitleStyle.enabled &&
      project.subtitleStyle.visible !== false &&
      (project.captions.length > 0 || (project.subtitleStyle.extraElements || []).some((e) => e.visible))
  );

  let captionCache: PrecomputedCaptionCache | null = null;
  if (captionsEnabled) {
    captionCache = buildPrecomputedCaptionCache(project, targetW, targetH, syncedCaptions);
  }

  // Mix all audio non-real-time via OfflineAudioContext (<0.5s for 90s!)
  const mixedAudio = await mixProjectAudioOffline({
    project,
    sourceVideoBlob: retrieved.blob,
    durationSec: totalDuration,
    channels: capabilities.audioChannels,
    signal,
  });

  const hasAudioTrack = Boolean(mixedAudio.buffer && mixedAudio.activeBranches.length > 0);
  const usePureWebCodecsAudio = Boolean(hasAudioTrack && capabilities.webCodecsAudio);

  // Setup reusable surfaces ONCE (zero per-frame canvas allocations)
  const mainSurf = createSurface(targetW, targetH);
  const staticBgSurf = createSurface(targetW, targetH);
  const quarterW = Math.max(32, Math.round(targetW / 4) & ~1);
  const quarterH = Math.max(32, Math.round(targetH / 4) & ~1);
  const quarterSurf = createAlphaSurface(quarterW, quarterH);
  const scratchSurf = createAlphaSurface(targetW, targetH);

  // Pre-bake 128x128 film grain noise tile ONCE
  const grainSurf = createAlphaSurface(128, 128);
  {
    const gImg = grainSurf.ctx.createImageData(128, 128);
    const d = gImg.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.random() > 0.5 ? 255 : 0;
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
      d[i + 3] = 55;
    }
    grainSurf.ctx.putImageData(gImg, 0, 0);
  }

  // Pre-render static canvas background onto staticBgSurf ONCE
  {
    const sctx = staticBgSurf.ctx;
    sctx.fillStyle = canvasConfig.bgColor || '#09090B';
    sctx.fillRect(0, 0, targetW, targetH);
    if (bgImg) {
      const iw = 'naturalWidth' in bgImg ? bgImg.naturalWidth : bgImg.width;
      const ih = 'naturalHeight' in bgImg ? bgImg.naturalHeight : bgImg.height;
      if (iw > 0 && ih > 0) {
        const bgScale = Math.max(0.5, Math.min(2.5, canvasConfig.bgImageScale || 1));
        const cover = Math.max(targetW / iw, targetH / ih) * bgScale;
        const bw = iw * cover;
        const bh = ih * cover;
        const bx = (targetW - bw) / 2 + ((canvasConfig.bgImageOffsetX || 0) / 100) * targetW;
        const by = (targetH - bh) / 2 + ((canvasConfig.bgImageOffsetY || 0) / 100) * targetH;
        const op = Math.max(0.05, Math.min(1, canvasConfig.bgImageOpacity ?? 1));
        const rot = ((canvasConfig.bgImageRotation || 0) * Math.PI) / 180;
        sctx.save();
        sctx.globalAlpha = op;
        if (Math.abs(rot) > 0.003) {
          sctx.translate(bx + bw / 2, by + bh / 2);
          sctx.rotate(rot);
          sctx.drawImage(bgImg, -bw / 2, -bh / 2, bw, bh);
        } else {
          sctx.drawImage(bgImg, bx, by, bw, bh);
        }
        sctx.restore();
      }
    }
  }

  // Precompute blur metadata + logo remappings
  const blurList = exportSettings.applyBlur ? project.blurs.filter((b) => b.enabled) : [];
  const blurIntervals = new Map<string, Array<{ start: number; end: number }>>();
  const remappedBlurs = blurList.map((b) => {
    const linkMode = b.subtitleLink?.mode || 'manual';
    let remapped = b;
    let ivs: Array<{ start: number; end: number }>;
    if (linkMode === 'translated') {
      ivs = resolveBlurIntervals(b, project, {
        syncedCaptionsOverride: syncedCaptions.map((c) => {
          const s = (c as { syncedStart?: number }).syncedStart ?? c.start;
          const e = (c as { syncedEnd?: number }).syncedEnd ?? c.end;
          return {
            id: c.id,
            syncedStart: s,
            syncedEnd: e,
          };
        }),
      });
    } else if (linkMode === 'original') {
      ivs = resolveBlurIntervals(b, project, { holdsOverride: activeSyncPlan?.holds || [] });
    } else if (activeSyncPlan) {
      remapped = remapBlursForSyncPlan([b], activeSyncPlan.holds)[0] || b;
      ivs = [{ start: remapped.startTime, end: remapped.endTime }];
    } else {
      ivs = [{ start: b.startTime, end: b.endTime }];
    }
    blurIntervals.set(remapped.id, ivs);
    return remapped;
  });

  const remappedLogos = activeSyncPlan
    ? remapLogosForSyncPlan(
        logoAssets.map((l) => l.logo),
        activeSyncPlan.holds
      )
    : logoAssets.map((l) => l.logo);

  const flareCache = new Map<string, { canvas: CanvasSurface; ctx: Canvas2D }>();
  const getOrBakeFlare = (kind: string, xPct: number, yPct: number) => {
    const key = `${kind}_${xPct}_${yPct}`;
    let surf = flareCache.get(key);
    if (surf) return surf;
    surf = createAlphaSurface(quarterW, quarterH);
    const fctx = surf.ctx;
    const cx = (xPct / 100) * quarterW;
    const cy = (yPct / 100) * quarterH;
    const rad = Math.max(quarterW, quarterH) * 0.72;
    const g = fctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    if (kind === 'flare') {
      g.addColorStop(0, 'rgba(255,248,220,0.95)');
      g.addColorStop(0.28, 'rgba(251,191,36,0.55)');
      g.addColorStop(1, 'rgba(249,115,22,0)');
    } else if (kind === 'burn') {
      g.addColorStop(0, 'rgba(254,240,138,0.9)');
      g.addColorStop(0.4, 'rgba(220,38,38,0.55)');
      g.addColorStop(1, 'rgba(124,45,18,0)');
    } else {
      g.addColorStop(0, 'rgba(253,186,116,0.9)');
      g.addColorStop(0.45, 'rgba(234,88,12,0.5)');
      g.addColorStop(1, 'rgba(234,88,12,0)');
    }
    fctx.fillStyle = g;
    fctx.fillRect(0, 0, quarterW, quarterH);
    flareCache.set(key, surf);
    return surf;
  };

  // Setup Muxer + VideoEncoder + AudioEncoder
  const muxerTarget = new ArrayBufferTarget();
  const muxer = new Muxer({
    target: muxerTarget,
    video: {
      codec: 'avc',
      width: targetW,
      height: targetH,
      frameRate: targetFps,
    },
    ...(usePureWebCodecsAudio
      ? {
          audio: {
            codec: 'aac',
            numberOfChannels: capabilities.audioChannels,
            sampleRate: EXPORT_AUDIO_SAMPLE_RATE,
          },
        }
      : {}),
    fastStart: 'in-memory',
  });

  let encoderError: unknown = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta?: EncodedVideoChunkMetadata) => {
      muxer.addVideoChunk(chunk, meta);
    },
    error: (err) => {
      encoderError = err;
    },
  });

  videoEncoder.configure({
    codec: capabilities.videoCodec,
    width: targetW,
    height: targetH,
    bitrate: speedPreset.videoTargetKbps * 1000,
    framerate: targetFps,
    bitrateMode: 'variable',
    latencyMode: speedPreset.webCodecsLatencyMode,
    hardwareAcceleration: capabilities.hardwareAccelerated ? 'prefer-hardware' : 'no-preference',
    avc: { format: 'avc' },
  });

  let audioEncoder: AudioEncoder | null = null;
  if (usePureWebCodecsAudio) {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta?: EncodedAudioChunkMetadata) => {
        muxer.addAudioChunk(chunk, meta);
      },
      error: (err) => {
        encoderError = err;
      },
    });
    audioEncoder.configure({
      codec: capabilities.audioCodec || 'mp4a.40.2',
      sampleRate: EXPORT_AUDIO_SAMPLE_RATE,
      numberOfChannels: capabilities.audioChannels,
      bitrate: EXPORT_AUDIO_BITRATE_KBPS * 1000,
    });
  }

  let framesRendered = 0;
  let staticFramesReused = 0;
  let peakHeapMb: number | null = readHeapMb();
  const captionCursor = { index: 0 };

  try {
    // Encode audio track cleanly first if pure WebCodecs AAC (fast synchronous planar slice loop)
    if (usePureWebCodecsAudio && audioEncoder && mixedAudio.buffer) {
      onProgress(14, 'Encoding AAC audio track (96 kbps · 44.1 kHz)...', null);
      const buf = mixedAudio.buffer;
      const chCount = Math.min(capabilities.audioChannels, buf.numberOfChannels);
      const totalLen = buf.length;
      const chunkFrames = 1024;
      const chanArrays = Array.from({ length: chCount }, (_, i) => buf.getChannelData(i));
      const scratchPlanar = new Float32Array(chunkFrames * chCount);

      for (let off = 0; off < totalLen; off += chunkFrames) {
        if (signal?.aborted) throw new DOMException('Export cancelled by user.', 'AbortError');
        if (encoderError) throw encoderError;
        while (audioEncoder.encodeQueueSize > 16) {
          await new Promise((r) => setTimeout(r, 2));
        }
        const count = Math.min(chunkFrames, totalLen - off);
        const targetArr =
          count === chunkFrames ? scratchPlanar : new Float32Array(count * chCount);
        for (let c = 0; c < chCount; c++) {
          targetArr.set(chanArrays[c].subarray(off, off + count), c * count);
        }
        const timestampUs = Math.round((off / EXPORT_AUDIO_SAMPLE_RATE) * 1_000_000);
        const ad = new AudioData({
          format: 'f32-planar',
          sampleRate: EXPORT_AUDIO_SAMPLE_RATE,
          numberOfChannels: chCount,
          numberOfFrames: count,
          timestamp: timestampUs,
          data: targetArr,
        });
        try {
          audioEncoder.encode(ad);
        } finally {
          ad.close();
        }
      }
      await audioEncoder.flush();
      audioEncoder.close();
      audioEncoder = null;
    }

    const engineLabel = capabilities.hardwareAccelerated
      ? 'WebCodecs Hardware H.264'
      : 'WebCodecs Smart H.264';
    onProgress(18, `Encoding ${targetW}×${targetH} @ ${targetFps} FPS (${engineLabel})...`, null);

    let lastDecodedSrcFrame = -999999;
    let lastStaticSignature = '';
    const srcFps = Math.max(15, Math.min(60, project.metadata?.fps || 30));
    const encodeLoopStart = performance.now();

    for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
      if (signal?.aborted) throw new DOMException('Export cancelled by user.', 'AbortError');
      if (encoderError) throw encoderError;

      // Bound encoder queue for low peak RAM usage on desktop & Android Chrome
      while (videoEncoder.encodeQueueSize > 6) {
        await new Promise((r) => setTimeout(r, 2));
      }

      const t = frameIdx / targetFps;
      const timestampUs = Math.round(t * 1_000_000);

      let activeClip: VideoClip | null = null;
      let srcTime = -1;
      let canReuseStaticFrame = false;

      if (!isStaticVisualMode && videoEl) {
        const match = findTimelineClipAtTime(videoClips, t, origDur, activeSyncPlan?.holds);
        activeClip = match.clip;
        srcTime = match.sourceTime;
        if (srcTime >= 0) {
          const quantizedSrcFrame = Math.round(srcTime * srcFps);
          if (quantizedSrcFrame !== lastDecodedSrcFrame) {
            await seekVideoToExactTime(videoEl, srcTime);
            lastDecodedSrcFrame = quantizedSrcFrame;
          }
        }
      }

      // Evaluate visual effects at t
      const activeFx =
        exportSettings.applyVideoEffects !== false &&
        project.videoEffects &&
        !project.videoEffects.compareMode
          ? (project.videoEffects.effects || []).filter((e) => {
              if (!e.enabled) return false;
              if (e.clipId && activeClip?.id !== e.clipId) return false;
              const s = e.startTime || 0;
              const end = e.endTime || 0;
              return t >= s && (end > s ? t <= end : true);
            })
          : [];

      const filterRes =
        exportSettings.applyVideoEffects !== false && project.videoEffects
          ? resolveCombinedVideoFilter({
              effectsConfig: project.videoEffects,
              clipFilterPreset: activeClip?.filterPreset,
              clipFilterIntensity: activeClip?.filterIntensity,
              currentTime: t,
              activeClipId: activeClip?.id,
            })
          : {
              filterCss: '',
              vignetteAlpha: 0,
              tintOverlays: [] as string[],
              grainAlpha: 0,
              fadeAlpha: 0,
            };

      const activeBlurs = remappedBlurs.filter((b) => {
        const ivs = blurIntervals.get(b.id) || [{ start: b.startTime, end: b.endTime }];
        return ivs.some((iv) => t >= iv.start && t <= iv.end);
      });

      const activeLogoSig = remappedLogos
        .filter((l) => l.permanent || (t >= l.startTime && t <= l.endTime))
        .map((l) => {
          const p = resolveLogoPos(l, t);
          return `${l.id}:${p.x.toFixed(3)},${p.y.toFixed(3)}`;
        })
        .join(';');

      // Check if static frame can be reused verbatim (zero redraw when visual state unchanged)
      if (isStaticVisualMode && activeFx.length === 0 && activeBlurs.length === 0 && frameIdx > 0) {
        let capSig = '';
        if (captionCache) {
          // Peek active caption signature quickly via draw only if needed — check time boundary first
          const seg = captionCache.segments.find((s) => t >= s.start && t <= s.end);
          capSig = seg
            ? `${seg.id}:${seg.words.findIndex((w) => t >= w.start && t <= w.end)}`
            : 'none';
        }
        const sig = `${filterRes.filterCss}|${activeLogoSig}|${capSig}`;
        if (sig === lastStaticSignature) {
          canReuseStaticFrame = true;
          staticFramesReused++;
        }
        lastStaticSignature = sig;
      }

      if (!canReuseStaticFrame) {
        const ctx = mainSurf.ctx;

        // Evaluate transform/color effects at timestamp t
        let zoomScale = 1;
        let shakeDx = 0;
        let shakeDy = 0;
        let slideTx = 0;
        let slideTy = 0;
        let wipeClip: { dir: string; cov: number } | null = null;
        let fxBlurPx = 0;
        let glowAmt = 0;
        let flashWhite = 0;
        let flashWarm = 0;
        let fadeBlack = 0;
        let rgbSplit = 0;
        let pixelateBlk = 0;
        let extraVig = 0;
        let extraGrain = 0;
        let extraBright = 0;
        let extraContrast = 0;
        let extraSat = 0;
        let extraHue = 0;
        let scratchIntensity = 0;
        let scratchSpeed = 1;
        const flares: Array<{ kind: string; xPct: number; yPct: number; alpha: number }> = [];

        for (const fx of activeFx) {
          const rawInt = Math.max(0, Math.min(1, fx.intensity / 100));
          const op = Math.max(0.05, Math.min(1, fx.opacity ?? 1));
          const k = rawInt * op;
          const spd = Math.max(0.2, Math.min(3, fx.speed ?? 1));
          const s = Math.max(0, fx.startTime || 0);
          const e = fx.endTime > s ? fx.endTime : totalDuration;
          const p = Math.max(0, Math.min(1, (t - s) / Math.max(0.1, e - s)));

          switch (fx.type) {
            case 'blur':
              fxBlurPx += Math.max(1, 14 * k);
              break;
            case 'gaussian-blur':
              fxBlurPx += Math.max(1, 18 * k);
              break;
            case 'motion-blur':
              fxBlurPx += Math.max(1, 5 * k);
              break;
            case 'blur-transition':
              fxBlurPx += Math.max(0, Math.sin(p * Math.PI) * 20 * k);
              break;
            case 'soft-focus':
              fxBlurPx += 3 * k;
              extraBright += 0.08 * k;
              break;
            case 'dream-effect':
              glowAmt = Math.max(glowAmt, 0.5 * k);
              extraBright += 0.1 * k;
              extraSat += 0.2 * k;
              break;
            case 'glow':
            case 'soft-glow':
            case 'bloom':
            case 'neon-glow':
              glowAmt = Math.max(glowAmt, 0.65 * k);
              extraBright += 0.08 * k;
              if (fx.type === 'neon-glow') {
                extraSat += 0.5 * k;
                extraHue += (fx.hueShiftDeg ?? 18) * rawInt;
              }
              break;
            case 'sharpen':
              extraContrast += 0.16 * k;
              extraSat += 0.08 * k;
              break;
            case 'color-shift':
              extraHue += (fx.hueShiftDeg ?? 0) + t * spd * 90 * rawInt;
              extraSat += 0.3 * k;
              break;
            case 'vignette':
              extraVig = Math.max(extraVig, 0.85 * k);
              break;
            case 'slow-zoom':
              zoomScale *= 1 + 0.22 * rawInt * p;
              break;
            case 'zoom':
              zoomScale *= 1 + 0.35 * rawInt * p;
              break;
            case 'zoom-out':
              zoomScale *= 1 + 0.35 * rawInt * (1 - p);
              break;
            case 'zoom-transition':
              zoomScale *= 1 + 0.5 * rawInt * Math.pow(Math.sin(p * Math.PI), 1.4);
              break;
            case 'camera-shake':
              shakeDx += Math.sin(t * 28 * spd) * 14 * rawInt;
              shakeDy += Math.cos(t * 34 * spd) * 14 * rawInt;
              zoomScale = Math.max(zoomScale, 1.05);
              break;
            case 'cinematic-shake':
              shakeDx += Math.sin(t * 17 * spd) * 18 * rawInt;
              shakeDy += Math.cos(t * 22 * spd) * 10 * rawInt;
              zoomScale = Math.max(zoomScale, 1.05);
              break;
            case 'handheld-camera':
              shakeDx += (Math.sin(t * 3.1 * spd) * 0.65 + Math.sin(t * 6.4 * spd) * 0.35) * 12 * rawInt;
              shakeDy += (Math.cos(t * 2.5 * spd) * 0.65 + Math.cos(t * 5.2 * spd) * 0.35) * 10 * rawInt;
              zoomScale = Math.max(zoomScale, 1.04);
              break;
            case 'slide-transition': {
              const rem = 1 - p;
              const d = fx.direction || 'left';
              if (d === 'left') slideTx += rem * targetW * rawInt;
              else if (d === 'right') slideTx -= rem * targetW * rawInt;
              else if (d === 'up') slideTy += rem * targetH * rawInt;
              else slideTy -= rem * targetH * rawInt;
              break;
            }
            case 'wipe-transition':
              wipeClip = { dir: fx.direction || 'left', cov: Math.max(0, Math.min(1, p)) };
              break;
            case 'pixelate':
            case 'mosaic':
              pixelateBlk = Math.max(pixelateBlk, Math.round(fx.blockSize ?? 14));
              break;
            case 'film-grain':
            case 'dust':
              extraGrain = Math.max(extraGrain, 0.5 * k);
              break;
            case 'scratches':
              extraGrain = Math.max(extraGrain, 0.35 * k);
              scratchIntensity = Math.max(scratchIntensity, k);
              scratchSpeed = spd;
              break;
            case 'chromatic-aberration':
            case 'rgb-split':
            case 'vhs':
              rgbSplit = Math.max(rgbSplit, k);
              break;
            case 'glitch':
            case 'rgb-glitch':
            case 'digital-glitch':
            case 'glitch-transition': {
              const burst =
                fx.type === 'glitch-transition'
                  ? Math.sin(p * Math.PI)
                  : 0.45 + 0.55 * Math.pow(Math.abs(Math.sin(t * 7 * spd)), 2);
              rgbSplit = Math.max(rgbSplit, k * burst);
              shakeDx += Math.sin(t * 48) * 10 * k * burst;
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
              flashWhite = Math.max(
                flashWhite,
                Math.pow(Math.max(0, Math.sin(t * Math.PI * (2 + spd * 4))), 6) * 0.85 * k
              );
              break;
            case 'light-flash':
              flashWhite = Math.max(
                flashWhite,
                Math.pow(Math.max(0, Math.sin(t * Math.PI * (1.2 + spd * 2.2))), 4) * 0.9 * k
              );
              break;
            case 'flash-transition':
              flashWhite = Math.max(flashWhite, Math.pow(Math.sin(p * Math.PI), 1.6) * 0.95 * k);
              break;
            case 'retro-flash':
              flashWarm = Math.max(
                flashWarm,
                Math.pow(Math.max(0, Math.sin(t * Math.PI * (1.5 + spd * 2.5))), 4) * 0.78 * k
              );
              break;
            case 'beat-flash': {
              const beat = Math.pow(Math.max(0, Math.sin(t * Math.PI * 2 * spd)), 6);
              flashWhite = Math.max(flashWhite, beat * 0.72 * k);
              zoomScale *= 1 + 0.08 * rawInt * beat;
              break;
            }
            case 'fade-in':
              fadeBlack = Math.max(fadeBlack, (1 - p) * k);
              break;
            case 'fade-out':
              fadeBlack = Math.max(fadeBlack, p * k);
              break;
            case 'cross-dissolve':
              fadeBlack = Math.max(fadeBlack, Math.sin(p * Math.PI) * 0.75 * k);
              break;
            case 'fade-in-out': {
              const inSec = Math.max(0, fx.fadeInSec ?? 0.6);
              const outSec = Math.max(0, fx.fadeOutSec ?? 0.6);
              if (inSec > 0.02 && t >= s && t - s < inSec) {
                fadeBlack = Math.max(fadeBlack, (1 - (t - s) / inSec) * k);
              }
              if (outSec > 0.02 && t <= e && e - t < outSec) {
                fadeBlack = Math.max(fadeBlack, (1 - (e - t) / outSec) * k);
              }
              break;
            }
          }
        }

        // 1. Blit precomputed static background canvas (instant GPU copy)
        ctx.drawImage(staticBgSurf.canvas, 0, 0);

        // 2. Draw moving video scene + blur-pad + filters + transforms
        if (!isStaticVisualMode && videoEl && activeClip && srcTime >= 0) {
          const filterParts: string[] = [];
          if (filterRes.filterCss) filterParts.push(filterRes.filterCss);
          if (fxBlurPx > 0.2) filterParts.push(`blur(${fxBlurPx.toFixed(1)}px)`);
          if (extraBright > 0.01) filterParts.push(`brightness(${(1 + extraBright).toFixed(2)})`);
          if (extraContrast > 0.01) filterParts.push(`contrast(${(1 + extraContrast).toFixed(2)})`);
          if (extraSat > 0.01) filterParts.push(`saturate(${(1 + extraSat).toFixed(2)})`);
          if (Math.abs(extraHue) > 0.5) filterParts.push(`hue-rotate(${Math.round(extraHue)}deg)`);
          const cssFilter = filterParts.length > 0 ? filterParts.join(' ') : 'none';

          const vw = videoEl.videoWidth || srcW;
          const vh = videoEl.videoHeight || srcH;
          const useCrop =
            exportSettings.fitMode === 'crop' ||
            canvasConfig.cropMode === 'fill' ||
            canvasConfig.cropMode === 'crop';
          const fitScale = useCrop
            ? Math.max(targetW / vw, targetH / vh)
            : Math.min(targetW / vw, targetH / vh);
          const zoom = Math.max(0.25, Math.min(3.5, (canvasConfig.zoom || 1) * zoomScale));
          const dw = vw * fitScale * zoom;
          const dh = vh * fitScale * zoom;
          const dx =
            (targetW - dw) / 2 +
            ((canvasConfig.offsetX || 0) / 100) * targetW +
            shakeDx +
            slideTx;
          const dy =
            (targetH - dh) / 2 +
            ((canvasConfig.offsetY || 0) / 100) * targetH +
            shakeDy +
            slideTy;

          // Optional wipe clip
          ctx.save();
          if (wipeClip) {
            ctx.beginPath();
            if (wipeClip.dir === 'right') {
              const x0 = targetW * (1 - wipeClip.cov);
              ctx.rect(x0, 0, targetW - x0, targetH);
            } else if (wipeClip.dir === 'up') {
              ctx.rect(0, 0, targetW, targetH * wipeClip.cov);
            } else if (wipeClip.dir === 'down') {
              const y0 = targetH * (1 - wipeClip.cov);
              ctx.rect(0, y0, targetW, targetH - y0);
            } else {
              ctx.rect(0, 0, targetW * wipeClip.cov, targetH);
            }
            ctx.clip();
          }

          // Blur background fill (blur-pad or backgroundType === 'blur') using quarter-res scratch buffer
          if (exportSettings.fitMode === 'blur-pad' || canvasConfig.backgroundType === 'blur') {
            const qctx = quarterSurf.ctx;
            const bgCover = Math.max(quarterW / vw, quarterH / vh);
            const qbw = vw * bgCover;
            const qbh = vh * bgCover;
            qctx.save();
            qctx.filter = 'blur(6px) brightness(0.72)';
            qctx.drawImage(videoEl, (quarterW - qbw) / 2, (quarterH - qbh) / 2, qbw, qbh);
            qctx.restore();
            ctx.drawImage(quarterSurf.canvas, 0, 0, targetW, targetH);
          }

          ctx.globalAlpha = Math.max(0.05, Math.min(1, canvasConfig.videoOpacity ?? 1));
          ctx.filter = cssFilter;

          if (pixelateBlk > 2) {
            const pw = Math.max(12, Math.round(targetW / pixelateBlk));
            const ph = Math.max(12, Math.round(targetH / pixelateBlk));
            const qctx = quarterSurf.ctx;
            qctx.save();
            qctx.imageSmoothingEnabled = false;
            qctx.drawImage(videoEl, 0, 0, pw, ph);
            qctx.restore();
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(quarterSurf.canvas, 0, 0, pw, ph, dx, dy, dw, dh);
            ctx.imageSmoothingEnabled = true;
          } else if (
            Math.abs(canvasConfig.videoRotation || 0) > 0.2 ||
            canvasConfig.flipH ||
            canvasConfig.flipV
          ) {
            ctx.save();
            ctx.translate(dx + dw / 2, dy + dh / 2);
            if (canvasConfig.videoRotation) {
              ctx.rotate((canvasConfig.videoRotation * Math.PI) / 180);
            }
            ctx.scale(canvasConfig.flipH ? -1 : 1, canvasConfig.flipV ? -1 : 1);
            ctx.drawImage(videoEl, -dw / 2, -dh / 2, dw, dh);
            ctx.restore();
          } else {
            ctx.drawImage(videoEl, dx, dy, dw, dh);
          }
          ctx.filter = 'none';

          // Quarter-res optical glow/bloom screen pass (16x faster than full-res)
          if (glowAmt > 0.02) {
            const qctx = quarterSurf.ctx;
            qctx.save();
            qctx.clearRect(0, 0, quarterW, quarterH);
            qctx.filter = 'blur(7px) brightness(1.25)';
            qctx.drawImage(videoEl, 0, 0, quarterW, quarterH);
            qctx.restore();
            ctx.save();
            ctx.globalCompositeOperation = 'screen';
            ctx.globalAlpha = Math.min(0.78, glowAmt);
            ctx.drawImage(quarterSurf.canvas, 0, 0, targetW, targetH);
            ctx.restore();
          }

          // Fast RGB split / glitch tint pulse without pixel copy
          if (rgbSplit > 0.05) {
            const offPx = Math.round(6 + rgbSplit * 18);
            ctx.save();
            ctx.globalCompositeOperation = 'screen';
            ctx.globalAlpha = 0.26 * rgbSplit;
            ctx.drawImage(videoEl, dx + offPx, dy, dw, dh);
            ctx.drawImage(videoEl, dx - offPx, dy, dw, dh);
            ctx.restore();
          }

          // Active blur regions (selective/motion/full/background) rendered via quarter-res scratch buffer (avoids self-draw & runs 16x faster)
          if (activeBlurs.length > 0) {
            const qctx = quarterSurf.ctx;
            qctx.save();
            qctx.clearRect(0, 0, quarterW, quarterH);
            qctx.filter = 'blur(5px)';
            qctx.drawImage(mainSurf.canvas, 0, 0, quarterW, quarterH);
            qctx.restore();
            for (const blur of activeBlurs) {
              const box =
                blur.mode === 'motion' && blur.keyframes && blur.keyframes.length > 0
                  ? interpolateKeyframes(blur.keyframes, t)
                  : blur;
              const bx = blur.mode === 'full' ? 0 : box.x * targetW;
              const by = blur.mode === 'full' ? 0 : box.y * targetH;
              const bw = blur.mode === 'full' ? targetW : box.width * targetW;
              const bh = blur.mode === 'full' ? targetH : box.height * targetH;
              ctx.save();
              ctx.globalAlpha = Math.max(0.05, Math.min(1, blur.opacity ?? 1));
              ctx.beginPath();
              if (blur.shape === 'ellipse') {
                ctx.ellipse(bx + bw / 2, by + bh / 2, bw / 2, bh / 2, 0, 0, Math.PI * 2);
              } else {
                ctx.rect(bx, by, bw, bh);
              }
              ctx.clip();
              ctx.drawImage(quarterSurf.canvas, 0, 0, targetW, targetH);
              ctx.restore();
            }
          }

          ctx.restore(); // end wipeClip / video transform
        }

        // 3. Color tint overlays & flare gradients & vignette & grain & flashes
        for (const tint of filterRes.tintOverlays) {
          ctx.save();
          ctx.fillStyle = tint;
          ctx.fillRect(0, 0, targetW, targetH);
          ctx.restore();
        }
        for (const f of flares) {
          const flareSurf = getOrBakeFlare(f.kind, f.xPct, f.yPct);
          ctx.save();
          ctx.globalCompositeOperation = 'screen';
          ctx.globalAlpha = f.alpha;
          ctx.drawImage(flareSurf.canvas, 0, 0, targetW, targetH);
          ctx.restore();
        }

        const totalVig = Math.min(0.92, Math.max(filterRes.vignetteAlpha, extraVig));
        if (totalVig > 0.02) {
          const vg = ctx.createRadialGradient(
            targetW * 0.5,
            targetH * 0.5,
            targetW * 0.25,
            targetW * 0.5,
            targetH * 0.5,
            targetH * 0.72
          );
          vg.addColorStop(0, 'rgba(0,0,0,0)');
          vg.addColorStop(1, `rgba(0,0,0,${totalVig.toFixed(2)})`);
          ctx.fillStyle = vg;
          ctx.fillRect(0, 0, targetW, targetH);
        }

        const totalGrain = Math.min(0.75, Math.max(filterRes.grainAlpha, extraGrain));
        if (totalGrain > 0.03) {
          const gPat = ctx.createPattern(grainSurf.canvas, 'repeat');
          if (gPat) {
            ctx.save();
            ctx.globalAlpha = totalGrain * 0.55;
            ctx.translate((frameIdx * 37) % 128, (frameIdx * 71) % 128);
            ctx.fillStyle = gPat;
            ctx.fillRect(-128, -128, targetW + 256, targetH + 256);
            ctx.restore();
          }
        }

        if (scratchIntensity > 0.03) {
          const sx = targetW * (0.15 + 0.7 * Math.abs(Math.sin(t * scratchSpeed * 3.1)));
          ctx.save();
          ctx.fillStyle = `rgba(255,255,255,${(0.35 * scratchIntensity).toFixed(2)})`;
          ctx.fillRect(sx, 0, 2, targetH);
          ctx.restore();
        }

        if (flashWhite > 0.02) {
          ctx.save();
          ctx.fillStyle = `rgba(255,255,255,${flashWhite.toFixed(2)})`;
          ctx.fillRect(0, 0, targetW, targetH);
          ctx.restore();
        }
        if (flashWarm > 0.02) {
          ctx.save();
          ctx.fillStyle = `rgba(255,220,160,${flashWarm.toFixed(2)})`;
          ctx.fillRect(0, 0, targetW, targetH);
          ctx.restore();
        }
        const totalFade = Math.min(1, Math.max(filterRes.fadeAlpha, fadeBlack));
        if (totalFade > 0.01) {
          ctx.save();
          ctx.fillStyle = `rgba(0,0,0,${totalFade.toFixed(2)})`;
          ctx.fillRect(0, 0, targetW, targetH);
          ctx.restore();
        }

        // 4. Logo Overlays
        for (let i = 0; i < remappedLogos.length; i++) {
          const logo = remappedLogos[i];
          const asset = logoAssets[i]?.bitmap;
          if (!asset) continue;
          if (!logo.permanent && (t < logo.startTime || t > logo.endTime)) continue;
          const pos = resolveLogoPos(logo, t);
          const aw = 'naturalWidth' in asset ? asset.naturalWidth : asset.width;
          const ah = 'naturalHeight' in asset ? asset.naturalHeight : asset.height;
          if (!aw || !ah) continue;
          const lw = (Math.max(4, Math.min(60, logo.widthPct || 15)) / 100) * targetW;
          const lh = lw * (ah / aw);
          ctx.save();
          ctx.globalAlpha = Math.max(0.05, Math.min(1, logo.opacity ?? 1));
          if (Math.abs(logo.rotation || 0) > 0.2) {
            ctx.translate(pos.x * targetW + lw / 2, pos.y * targetH + lh / 2);
            ctx.rotate(((logo.rotation || 0) * Math.PI) / 180);
            ctx.drawImage(asset, -lw / 2, -lh / 2, lw, lh);
          } else {
            ctx.drawImage(asset, pos.x * targetW, pos.y * targetH, lw, lh);
          }
          ctx.restore();
        }

        // 5. Precomputed Karaoke Captions (zero layout calculation per frame)
        if (captionCache) {
          drawCachedCaptionsAtTime(ctx, captionCache, t, captionCursor);
        }
      }

      // Encode current VideoFrame directly from OffscreenCanvas/Canvas (hardware zero-copy when supported)
      const videoFrame = new VideoFrame(mainSurf.canvas as CanvasImageSource, {
        timestamp: timestampUs,
        duration: frameDurUs,
      });
      try {
        videoEncoder.encode(videoFrame, {
          keyFrame: frameIdx % (targetFps * 2) === 0,
        });
        framesRendered++;
      } finally {
        videoFrame.close();
      }

      if (frameIdx % 10 === 0 || frameIdx === totalFrames - 1) {
        const curHeap = readHeapMb();
        if (curHeap !== null && (peakHeapMb === null || curHeap > peakHeapMb)) {
          peakHeapMb = curHeap;
        }
        const frac = (frameIdx + 1) / totalFrames;
        const pct = Math.min(93, Math.round(18 + frac * 75));
        const elapsedSec = (performance.now() - encodeLoopStart) / 1000;
        const etaSec =
          elapsedSec > 1.2 && frac > 0.03
            ? Math.max(1, Math.round((elapsedSec / frac) * (1 - frac)))
            : null;
        onProgress(
          pct,
          `Encoding frame ${frameIdx + 1}/${totalFrames} (${engineLabel})`,
          etaSec
        );
        // Yield briefly to keep UI responsive and allow GC
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    onProgress(95, 'Finalizing MP4 container...', 1);
    await videoEncoder.flush();
    videoEncoder.close();
    if (encoderError) throw encoderError;

    muxer.finalize();
    let finalMp4Bytes = new Uint8Array(muxerTarget.buffer);

    // Hybrid fallback: If VideoEncoder ran in HW WebCodecs cleanly but AudioEncoder lacked mp4a.40.2 (rare Chromium/Android),
    // mux the pre-rendered OfflineAudioContext WAV via FFmpeg using instant `-c:v copy` (<1s)!
    if (hasAudioTrack && !usePureWebCodecsAudio && mixedAudio.buffer) {
      onProgress(97, 'Muxing AAC 96k audio into hardware MP4...', 1);
      const wavBytes = encodeAudioBufferToWav(mixedAudio.buffer);
      finalMp4Bytes = await withFFmpegLock(async (ff) => {
        await ff.writeFile('wc_vid.mp4', finalMp4Bytes);
        await ff.writeFile('wc_aud.wav', wavBytes);
        const exitCode = await ff.exec([
          '-i', 'wc_vid.mp4',
          '-i', 'wc_aud.wav',
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', `${EXPORT_AUDIO_BITRATE_KBPS}k`,
          '-ar', String(EXPORT_AUDIO_SAMPLE_RATE),
          '-ac', String(mixedAudio.buffer!.numberOfChannels),
          '-shortest',
          '-movflags', '+faststart',
          'wc_muxed.mp4',
        ]);
        const outData =
          exitCode === 0 ? ((await ff.readFile('wc_muxed.mp4')) as Uint8Array) : null;
        await safeDeleteMemfsFile(ff, 'wc_vid.mp4');
        await safeDeleteMemfsFile(ff, 'wc_aud.wav');
        await safeDeleteMemfsFile(ff, 'wc_muxed.mp4');
        if (!outData || outData.byteLength < 1024) {
          throw new Error('Failed to mux AAC audio into WebCodecs MP4.');
        }
        return new Uint8Array(outData);
      });
    }

    const blob = new Blob([finalMp4Bytes.slice()], { type: 'video/mp4' });
    if (blob.size < 1024) {
      throw new Error('WebCodecs exporter produced an incomplete MP4 file.');
    }

    onProgress(100, 'Completed', 0);
    return {
      blob,
      filename: `${project.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_final.mp4`,
      mimeType: 'video/mp4',
      sizeBytes: blob.size,
      engine: capabilities.hardwareAccelerated ? 'webcodecs-hardware' : 'webcodecs-software',
      hardwareAccelerated: capabilities.hardwareAccelerated,
      videoCodec: capabilities.videoCodec,
      audioCodec: hasAudioTrack ? capabilities.audioCodec || 'aac' : null,
      bitrateControl: 'vbr-bitrate',
      targetVideoKbps: speedPreset.videoTargetKbps,
      targetAudioKbps: hasAudioTrack ? EXPORT_AUDIO_BITRATE_KBPS : 0,
      renderDurationMs: Math.round(performance.now() - startedAt),
      audioBranches: mixedAudio.activeBranches,
      framesRendered,
      staticFramesReused,
      peakHeapMb,
    };
  } finally {
    // Strictly release GPU / media memory buffers
    try {
      if (videoEncoder.state !== 'closed') videoEncoder.close();
    } catch {
      // ignore
    }
    try {
      if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close();
    } catch {
      // ignore
    }
    if (videoEl) {
      videoEl.pause();
      videoEl.src = '';
    }
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    if (bgImg && 'close' in bgImg && typeof bgImg.close === 'function') {
      try { bgImg.close(); } catch { /* ignore */ }
    }
    for (const item of logoAssets) {
      if ('close' in item.bitmap && typeof item.bitmap.close === 'function') {
        try { item.bitmap.close(); } catch { /* ignore */ }
      }
    }
    // Clear scratch references cleanly
    scratchSurf.canvas.width = 1;
    scratchSurf.canvas.height = 1;
    quarterSurf.canvas.width = 1;
    quarterSurf.canvas.height = 1;
    flareCache.clear();
  }
}
