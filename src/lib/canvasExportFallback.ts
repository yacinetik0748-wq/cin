import {
  DEFAULT_VIDEO_CANVAS,
  Project,
} from '../types/studio';
import { getSyncedCaptionsForPreview, resolveCanvasDimensions } from './workflowStages';
import { buildPrecomputedCaptionCache, drawCachedCaptionsAtTime } from './captionLayoutCache';
import { retrieveProjectVideoBlob, getBlobAssetByKey } from './browserStorage';
import { isOrigAudioActive } from './clientExportRenderer';
import { resolveMediaBlob } from './clientMediaEngine';
import {
  computeExportTargetFps,
  EXPORT_AUDIO_BITRATE_KBPS,
  EXPORT_AUDIO_SAMPLE_RATE,
  resolveExportSpeedPreset,
  resolveExportTimelineDuration,
} from './exportEstimation';
import { getEffectiveVideoClips } from './videoTimeline';

export interface CanvasExportResult {
  blob: Blob;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  engine: 'canvas-mediarecorder';
}

export function detectBrowserMediaRecorderFormat(): { mimeType: string; extension: string; isMp4: boolean } {
  if (typeof MediaRecorder === 'undefined') {
    return { mimeType: 'video/webm', extension: 'webm', isMp4: false };
  }
  const candidates = [
    { mimeType: 'video/mp4;codecs=avc1,mp4a.40.2', extension: 'mp4', isMp4: true },
    { mimeType: 'video/mp4;codecs=h264,aac', extension: 'mp4', isMp4: true },
    { mimeType: 'video/mp4', extension: 'mp4', isMp4: true },
    { mimeType: 'video/webm;codecs=vp9,opus', extension: 'webm', isMp4: false },
    { mimeType: 'video/webm;codecs=vp8,opus', extension: 'webm', isMp4: false },
    { mimeType: 'video/webm', extension: 'webm', isMp4: false },
  ];

  for (const cand of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(cand.mimeType)) {
        return cand;
      }
    } catch {
      // ignore
    }
  }
  return { mimeType: 'video/webm', extension: 'webm', isMp4: false };
}

async function loadImageFromAssetUrl(url: string): Promise<HTMLImageElement | null> {
  if (!url) return null;
  let objectUrl: string | null = null;
  try {
    let src = url;
    if (url.startsWith('idb://blobs/')) {
      const blob = await getBlobAssetByKey(url.slice('idb://blobs/'.length));
      if (!blob) return null;
      objectUrl = URL.createObjectURL(blob);
      src = objectUrl;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Image load failed'));
      img.src = src;
    });
    return img;
  } catch {
    return null;
  } finally {
    if (objectUrl) {
      // keep alive until image decoded; safe to revoke slightly later
      setTimeout(() => URL.revokeObjectURL(objectUrl!), 60000);
    }
  }
}

export async function renderProjectCanvasFallback(params: {
  project: Project;
  onProgress: (pct: number, stage: string, etaSec?: number | null) => void;
  signal?: AbortSignal;
}): Promise<CanvasExportResult> {
  const { project, onProgress, signal } = params;
  if (signal?.aborted) {
    throw new DOMException('Export cancelled by user.', 'AbortError');
  }

  if (typeof MediaRecorder === 'undefined') {
    throw new Error('MediaRecorder API is not available in this browser.');
  }

  onProgress(5, 'Detecting browser canvas rendering and recording support...');
  const retrieved = await retrieveProjectVideoBlob(project);
  if (!retrieved?.blob || retrieved.blob.size === 0) {
    throw new Error('Project video file not found in local IndexedDB storage.');
  }

  const { exportSettings } = project;
  const canvasConfig = { ...DEFAULT_VIDEO_CANVAS, ...(project.canvas || {}) };
  const { width: targetW, height: targetH } = resolveCanvasDimensions(
    canvasConfig,
    exportSettings,
    project.metadata
  );

  const videoUrl = URL.createObjectURL(retrieved.blob);
  const video = document.createElement('video');
  video.src = videoUrl;
  video.muted = false;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.crossOrigin = 'anonymous';

  onProgress(10, 'Loading media into local canvas renderer...');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Video load timeout in canvas renderer')), 20000);
    video.onloadedmetadata = () => {
      clearTimeout(timer);
      resolve();
    };
    video.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Failed to load video element in browser canvas renderer'));
    };
    video.load();
  });

  const clips = getEffectiveVideoClips(project);
  const videoVisible = canvasConfig.videoVisible !== false;
  const sourceDuration = Math.max(1, project.metadata?.duration || video.duration || 10);
  const totalDuration = resolveExportTimelineDuration(project);
  const targetFps = computeExportTargetFps({
    sourceFps: project.metadata?.fps,
    videoVisible,
    videoClipCount: clips.length,
  });

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) {
    URL.revokeObjectURL(videoUrl);
    throw new Error('Could not create 2D canvas context for local rendering.');
  }

  if (typeof canvas.captureStream !== 'function') {
    URL.revokeObjectURL(videoUrl);
    throw new Error('HTMLCanvasElement.captureStream() is not supported by this browser.');
  }

  // Preload static background image when configured
  const bgImage =
    canvasConfig.backgroundType === 'image' &&
    canvasConfig.bgImageUrl &&
    canvasConfig.bgImageVisible !== false
      ? await loadImageFromAssetUrl(canvasConfig.bgImageUrl)
      : null;

  // Preload enabled logos
  const loadedLogos: Array<{ logo: Project['logos'][number]; img: HTMLImageElement }> = [];
  if (exportSettings.applyLogo && project.logos.length > 0) {
    for (const logo of project.logos.filter((l) => l.enabled && l.url)) {
      const img = await loadImageFromAssetUrl(logo.url);
      if (img) loadedLogos.push({ logo, img });
    }
  }

  const syncedCaptions = getSyncedCaptionsForPreview(project);
  const captionsEnabled = Boolean(
    exportSettings.applyCaptions &&
      project.subtitleStyle.enabled &&
      project.subtitleStyle.visible !== false &&
      (syncedCaptions.length > 0 || (project.subtitleStyle.extraElements || []).some((e) => e.visible))
  );
  const captionCache = captionsEnabled
    ? buildPrecomputedCaptionCache(project, targetW, targetH, syncedCaptions)
    : null;
  const captionCursor = { index: 0 };

  // Reusable quarter-res scratch canvas for blur-pad & selective blurs (16x fewer pixels per frame)
  const qW = Math.max(32, Math.round(targetW / 4) & ~1);
  const qH = Math.max(32, Math.round(targetH / 4) & ~1);
  const qCanvas = document.createElement('canvas');
  qCanvas.width = qW;
  qCanvas.height = qH;
  const qCtx = qCanvas.getContext('2d');

  // Web Audio Context for audio mixing (Android Chrome safe, 44.1 kHz target)
  const AudioContextClass =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  let audioCtx: AudioContext | null = null;
  let audioDest: MediaStreamAudioDestinationNode | null = null;
  let dubAudioEl: HTMLAudioElement | null = null;
  let dubUrl: string | null = null;
  let bgmAudioEl: HTMLAudioElement | null = null;
  let bgmUrl: string | null = null;
  let sfxAudioEl: HTMLAudioElement | null = null;
  let sfxUrl: string | null = null;
  const scheduledSources: AudioBufferSourceNode[] = [];

  try {
    if (AudioContextClass) {
      try {
        audioCtx = new AudioContextClass({ sampleRate: EXPORT_AUDIO_SAMPLE_RATE });
      } catch {
        audioCtx = new AudioContextClass();
      }
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume().catch(() => {});
      }
      audioDest = audioCtx.createMediaStreamDestination();

      const origActive = isOrigAudioActive(project.voice);
      try {
        const vidSource = audioCtx.createMediaElementSource(video);
        const vidGain = audioCtx.createGain();
        vidGain.gain.value = origActive
          ? Math.max(0, Math.min(2.0, Number(project.voice.originalAudioVolume ?? 1.0)))
          : 0;
        vidSource.connect(vidGain);
        vidGain.connect(audioDest);
        if (!origActive) {
          video.muted = true;
        }
      } catch {
        if (!origActive) video.muted = true;
      }

      const voiceVol = Math.max(0, Math.min(2.0, Number(project.voice.voiceVolume ?? 1.0)));
      const dubEnabled = Boolean(
        exportSettings.applyDubbing &&
          project.voice.enabled &&
          !project.voice.voiceMuted &&
          voiceVol > 0.005
      );

      if (dubEnabled && project.voice.fullDubUrl) {
        const dubBlob = await resolveMediaBlob(project.voice.fullDubUrl).catch(() => null);
        if (dubBlob && dubBlob.size > 0) {
          dubUrl = URL.createObjectURL(dubBlob);
          dubAudioEl = new Audio(dubUrl);
          dubAudioEl.crossOrigin = 'anonymous';
          dubAudioEl.playbackRate = Math.max(0.25, Math.min(4.0, Number(project.voice.speakingSpeed || 1.0)));
          try {
            const dubSource = audioCtx.createMediaElementSource(dubAudioEl);
            const dubGain = audioCtx.createGain();
            dubGain.gain.value = voiceVol;
            dubSource.connect(dubGain);
            dubGain.connect(audioDest);
          } catch {
            // ignore
          }
        }
      } else if (dubEnabled && (project.voice.generatedClips || []).length > 0) {
        const dubGain = audioCtx.createGain();
        dubGain.gain.value = voiceVol;
        dubGain.connect(audioDest);
        const offsetSec = Number(project.voice.timingOffsetSec || 0);
        const baseWhen = audioCtx.currentTime;
        for (const clip of project.voice.generatedClips) {
          if (!clip.audioUrl) continue;
          const clipBlob = await resolveMediaBlob(clip.audioUrl).catch(() => null);
          if (!clipBlob || clipBlob.size === 0) continue;
          try {
            const ab = await clipBlob.arrayBuffer();
            const buf = await audioCtx.decodeAudioData(ab.slice(0));
            const src = audioCtx.createBufferSource();
            src.buffer = buf;
            src.playbackRate.value = Math.max(
              0.25,
              Math.min(4.0, (clip.speed ?? 1.0) * (project.voice.speakingSpeed ?? 1.0))
            );
            src.connect(dubGain);
            const startAt = Math.max(0, Number(clip.start || 0) + offsetSec);
            src.start(baseWhen + startAt, Math.max(0, Number(clip.trimStartSec ?? 0)));
            scheduledSources.push(src);
          } catch {
            // ignore undecodable clip
          }
        }
      }

      const bgmVol = Math.max(0, Math.min(2.0, Number(project.voice.bgMusicVolume ?? 0)));
      const bgmEnabled =
        exportSettings.applyAudioMix &&
        (project.voice.bgMusicEnabled !== undefined
          ? Boolean(project.voice.bgMusicEnabled)
          : Boolean(project.voice.bgMusicUrl && bgmVol > 0.005)) &&
        !project.voice.bgMusicMuted &&
        bgmVol > 0.005;

      if (bgmEnabled && project.voice.bgMusicUrl) {
        const bgmBlob = await resolveMediaBlob(project.voice.bgMusicUrl).catch(() => null);
        if (bgmBlob && bgmBlob.size > 0) {
          bgmUrl = URL.createObjectURL(bgmBlob);
          bgmAudioEl = new Audio(bgmUrl);
          bgmAudioEl.crossOrigin = 'anonymous';
          bgmAudioEl.loop = true;
          try {
            const bgmSrc = audioCtx.createMediaElementSource(bgmAudioEl);
            const bgmGain = audioCtx.createGain();
            bgmGain.gain.value = bgmVol;
            bgmSrc.connect(bgmGain);
            bgmGain.connect(audioDest);
          } catch {
            // ignore
          }
        }
      }

      const sfxVol = Math.max(0, Math.min(2.0, Number(project.voice.sfxVolume ?? 1.0)));
      const sfxEnabled =
        exportSettings.applyAudioMix &&
        Boolean(project.voice.sfxEnabled) &&
        !project.voice.sfxMuted &&
        sfxVol > 0.005;

      if (sfxEnabled && project.voice.sfxUrl) {
        const sfxBlob = await resolveMediaBlob(project.voice.sfxUrl).catch(() => null);
        if (sfxBlob && sfxBlob.size > 0) {
          sfxUrl = URL.createObjectURL(sfxBlob);
          sfxAudioEl = new Audio(sfxUrl);
          sfxAudioEl.crossOrigin = 'anonymous';
          try {
            const sfxSrc = audioCtx.createMediaElementSource(sfxAudioEl);
            const sfxGain = audioCtx.createGain();
            sfxGain.gain.value = sfxVol;
            sfxSrc.connect(sfxGain);
            sfxGain.connect(audioDest);
          } catch {
            // ignore
          }
        }
      }
    }
  } catch {
    // Audio context initialization non-fatal
  }

  const { mimeType: chosenMime, extension } = detectBrowserMediaRecorderFormat();
  const canvasStream = canvas.captureStream(targetFps);

  const combinedTracks = [...canvasStream.getVideoTracks()];
  if (audioDest && audioDest.stream.getAudioTracks().length > 0) {
    combinedTracks.push(...audioDest.stream.getAudioTracks());
  }
  const combinedStream = new MediaStream(combinedTracks);

  // Standard W3C MediaRecorder bitrate targets ONLY (FFmpeg flags do not apply to MediaRecorder)
  const speedPreset = resolveExportSpeedPreset(exportSettings.speedProfile);
  const targetVideoBps = speedPreset.videoTargetKbps * 1000;
  const targetAudioBps = EXPORT_AUDIO_BITRATE_KBPS * 1000;
  const recorderOptionsAttempts: Array<MediaRecorderOptions | undefined> = [
    {
      mimeType: chosenMime,
      videoBitsPerSecond: targetVideoBps,
      audioBitsPerSecond: targetAudioBps,
    },
    {
      mimeType: chosenMime,
      videoBitsPerSecond: targetVideoBps,
    },
    { mimeType: chosenMime },
    undefined,
  ];

  let recorder: MediaRecorder | null = null;
  for (const opts of recorderOptionsAttempts) {
    try {
      recorder = opts
        ? new MediaRecorder(combinedStream, opts)
        : new MediaRecorder(combinedStream);
      break;
    } catch {
      // Try next supported option combination
    }
  }
  if (!recorder) {
    recorder = new MediaRecorder(combinedStream);
  }
  const activeRecorder = recorder;

  const recordedChunks: Blob[] = [];
  activeRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      recordedChunks.push(e.data);
    }
  };

  onProgress(
    20,
    `Rendering video frames locally via Canvas (${targetW}×${targetH} @ ${targetFps} FPS ${extension.toUpperCase()})...`
  );

  return new Promise<CanvasExportResult>((resolve, reject) => {
    let animId = 0;
    let clipIdx = 0;
    let stopped = false;
    let lastDrawAt = 0;
    const frameIntervalMs = 1000 / targetFps;
    const renderStartPerf = performance.now();

    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(animId);
      URL.revokeObjectURL(videoUrl);
      if (dubUrl) URL.revokeObjectURL(dubUrl);
      if (bgmUrl) URL.revokeObjectURL(bgmUrl);
      if (sfxUrl) URL.revokeObjectURL(sfxUrl);
      for (const s of scheduledSources) {
        try { s.stop(); } catch { /* ignore */ }
      }
      if (dubAudioEl) {
        dubAudioEl.pause();
        dubAudioEl.src = '';
      }
      if (bgmAudioEl) {
        bgmAudioEl.pause();
        bgmAudioEl.src = '';
      }
      if (sfxAudioEl) {
        sfxAudioEl.pause();
        sfxAudioEl.src = '';
      }
      if (audioCtx && audioCtx.state !== 'closed') {
        audioCtx.close().catch(() => {});
      }
      video.pause();
      video.src = '';
    };

    const onAbort = () => {
      if (activeRecorder.state === 'recording') {
        try { activeRecorder.stop(); } catch { /* ignore */ }
      }
      cleanup();
      reject(new DOMException('Export cancelled by user.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    activeRecorder.onerror = (err) => {
      cleanup();
      reject(err);
    };

    activeRecorder.onstop = () => {
      cleanup();
      const finalBlob = new Blob(recordedChunks, { type: activeRecorder.mimeType || chosenMime });
      if (finalBlob.size === 0) {
        reject(new Error('Canvas fallback produced an empty video blob (0 bytes).'));
        return;
      }
      onProgress(100, `Export complete (${extension.toUpperCase()})`);
      resolve({
        blob: finalBlob,
        filename: `${project.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_final.${extension}`,
        mimeType: activeRecorder.mimeType || chosenMime,
        sizeBytes: finalBlob.size,
        engine: 'canvas-mediarecorder',
      });
    };

    activeRecorder.start(250);

    const activeClips =
      clips.length > 0
        ? clips
        : [
            {
              id: 'default',
              name: 'Main Clip',
              sourceStart: 0,
              sourceEnd: sourceDuration,
              timelineStart: 0,
              speed: 1,
            },
          ];

    let timelineElapsedOffset = 0;

    const drawFrame = (now: number) => {
      let timelineTime = 0;

      if (!videoVisible || clips.length === 0) {
        // Static visual mode (e.g., background image + narration + karaoke captions)
        timelineTime = Math.min(totalDuration, Math.max(0, (now - renderStartPerf) / 1000));
        if (timelineTime >= totalDuration - 0.02) {
          if (activeRecorder.state === 'recording') activeRecorder.stop();
          return;
        }
      } else {
        const currentClip = activeClips[clipIdx];
        if (!currentClip) {
          if (activeRecorder.state === 'recording') activeRecorder.stop();
          return;
        }

        const speed = Math.max(0.25, currentClip.speed || 1);
        video.playbackRate = speed;

        const curSource = video.currentTime;
        if (curSource >= currentClip.sourceEnd - 0.04 || video.ended) {
          timelineElapsedOffset += (currentClip.sourceEnd - currentClip.sourceStart) / speed;
          clipIdx += 1;
          const nextClip = activeClips[clipIdx];
          if (!nextClip) {
            if (activeRecorder.state === 'recording') activeRecorder.stop();
            return;
          }
          video.currentTime = nextClip.sourceStart;
        }

        timelineTime = Math.min(
          totalDuration,
          timelineElapsedOffset + Math.max(0, curSource - currentClip.sourceStart) / speed
        );
      }

      // Throttle canvas painting to targetFps (prevents 60-120 Hz over-drawing & frame duplication)
      if (lastDrawAt !== 0 && now - lastDrawAt < frameIntervalMs - 2) {
        animId = requestAnimationFrame(drawFrame);
        return;
      }
      lastDrawAt = now;

      const progress = Math.min(95, 20 + Math.round((timelineTime / totalDuration) * 75));
      onProgress(
        progress,
        `Encoding frame at ${timelineTime.toFixed(1)}s / ${totalDuration.toFixed(1)}s (${extension.toUpperCase()})...`
      );

      // 1. Background fill
      ctx.fillStyle = canvasConfig.bgColor || '#09090B';
      ctx.fillRect(0, 0, targetW, targetH);

      // 1b. Static background image when configured
      if (bgImage && bgImage.naturalWidth > 0 && bgImage.naturalHeight > 0) {
        const bgScale = Math.max(0.5, Math.min(2.5, canvasConfig.bgImageScale || 1));
        const coverScale = Math.max(targetW / bgImage.naturalWidth, targetH / bgImage.naturalHeight) * bgScale;
        const bw = bgImage.naturalWidth * coverScale;
        const bh = bgImage.naturalHeight * coverScale;
        const bx = (targetW - bw) / 2 + ((canvasConfig.bgImageOffsetX || 0) / 100) * targetW;
        const by = (targetH - bh) / 2 + ((canvasConfig.bgImageOffsetY || 0) / 100) * targetH;
        const bgOpacity = Math.max(0.05, Math.min(1, canvasConfig.bgImageOpacity ?? 1));
        const bgRot = ((canvasConfig.bgImageRotation || 0) * Math.PI) / 180;
        ctx.save();
        ctx.globalAlpha = bgOpacity;
        if (Math.abs(bgRot) > 0.003) {
          ctx.translate(bx + bw / 2, by + bh / 2);
          ctx.rotate(bgRot);
          ctx.drawImage(bgImage, -bw / 2, -bh / 2, bw, bh);
        } else {
          ctx.drawImage(bgImage, bx, by, bw, bh);
        }
        ctx.restore();
      }

      // 2. Draw video frame with fit / crop mode (when video track is visible)
      const vw = video.videoWidth || targetW;
      const vh = video.videoHeight || targetH;
      const useCrop =
        exportSettings.fitMode === 'crop' ||
        canvasConfig.cropMode === 'fill' ||
        canvasConfig.cropMode === 'crop';
      const scale = useCrop
        ? Math.max(targetW / vw, targetH / vh)
        : Math.min(targetW / vw, targetH / vh);
      const dw = vw * scale * (canvasConfig.zoom || 1);
      const dh = vh * scale * (canvasConfig.zoom || 1);
      const dx = (targetW - dw) / 2 + ((canvasConfig.offsetX || 0) / 100) * targetW;
      const dy = (targetH - dh) / 2 + ((canvasConfig.offsetY || 0) / 100) * targetH;

      if (videoVisible && clips.length > 0) {
        ctx.save();
        ctx.globalAlpha = Math.max(0.05, Math.min(1, canvasConfig.videoOpacity ?? 1));
        if (exportSettings.fitMode === 'blur-pad') {
          if (qCtx) {
            const bgScale = Math.max(qW / vw, qH / vh);
            const bw = vw * bgScale;
            const bh = vh * bgScale;
            qCtx.save();
            qCtx.filter = 'blur(6px) brightness(0.72)';
            qCtx.drawImage(video, (qW - bw) / 2, (qH - bh) / 2, bw, bh);
            qCtx.restore();
            ctx.drawImage(qCanvas, 0, 0, targetW, targetH);
          } else {
            const bgScale = Math.max(targetW / vw, targetH / vh);
            const bw = vw * bgScale;
            const bh = vh * bgScale;
            ctx.filter = 'blur(18px) brightness(0.7)';
            ctx.drawImage(video, (targetW - bw) / 2, (targetH - bh) / 2, bw, bh);
            ctx.filter = 'none';
          }
        }
        ctx.drawImage(video, dx, dy, dw, dh);
        ctx.restore();

        // 3. Draw active blur zones via quarter-res canvas (fast & crisp)
        if (exportSettings.applyBlur && project.blurs.length > 0) {
          const activeBlurs = project.blurs.filter(
            (b) => b.enabled && timelineTime >= b.startTime && timelineTime <= b.endTime
          );
          if (activeBlurs.length > 0) {
            if (qCtx) {
              qCtx.save();
              qCtx.clearRect(0, 0, qW, qH);
              qCtx.filter = 'blur(5px)';
              qCtx.drawImage(canvas, 0, 0, qW, qH);
              qCtx.restore();
            }
            for (const blur of activeBlurs) {
              const bx = blur.mode === 'full' ? 0 : blur.x * targetW;
              const by = blur.mode === 'full' ? 0 : blur.y * targetH;
              const bw = blur.mode === 'full' ? targetW : blur.width * targetW;
              const bh = blur.mode === 'full' ? targetH : blur.height * targetH;
              ctx.save();
              ctx.beginPath();
              ctx.rect(bx, by, bw, bh);
              ctx.clip();
              if (qCtx) {
                ctx.drawImage(qCanvas, 0, 0, targetW, targetH);
              } else {
                ctx.filter = `blur(${Math.max(4, Math.min(32, blur.radius || blur.intensity || 16))}px)`;
                ctx.drawImage(video, dx, dy, dw, dh);
              }
              ctx.restore();
            }
          }
        }
      }

      // 4. Draw logos
      if (loadedLogos.length > 0) {
        for (const { logo, img } of loadedLogos) {
          if (!logo.permanent && (timelineTime < logo.startTime || timelineTime > logo.endTime)) {
            continue;
          }
          const lw = (Math.max(4, Math.min(60, logo.widthPct || 15)) / 100) * targetW;
          const aspect = img.naturalWidth > 0 ? img.naturalHeight / img.naturalWidth : 1;
          const lh = lw * aspect;
          ctx.save();
          ctx.globalAlpha = Math.max(0.05, Math.min(1, logo.opacity ?? 1));
          ctx.drawImage(img, logo.x * targetW, logo.y * targetH, lw, lh);
          ctx.restore();
        }
      }

      // 5. Draw active synced captions via precomputed cache (zero per-frame text measurement)
      if (captionCache) {
        drawCachedCaptionsAtTime(ctx, captionCache, timelineTime, captionCursor);
      }

      animId = requestAnimationFrame(drawFrame);
    };

    const startPlayback = async () => {
      if (videoVisible && clips.length > 0) {
        video.currentTime = activeClips[0]?.sourceStart || 0;
        try {
          await video.play();
        } catch {
          // Android Chrome fallback when autoplay policy blocks unmuted playback after async gap
          video.muted = true;
          await video.play();
        }
      } else if (isOrigAudioActive(project.voice)) {
        video.currentTime = 0;
        video.play().catch(() => {});
      }
      if (dubAudioEl) {
        const offsetSec = Number(project.voice.timingOffsetSec || 0);
        if (offsetSec > 0.05) {
          setTimeout(() => {
            if (!stopped && dubAudioEl) {
              dubAudioEl.currentTime = 0;
              dubAudioEl.play().catch(() => {});
            }
          }, Math.round(offsetSec * 1000));
        } else {
          dubAudioEl.currentTime = Math.max(0, -offsetSec);
          dubAudioEl.play().catch(() => {});
        }
      }
      if (bgmAudioEl) {
        bgmAudioEl.currentTime = 0;
        bgmAudioEl.play().catch(() => {});
      }
      if (sfxAudioEl) {
        sfxAudioEl.currentTime = 0;
        sfxAudioEl.play().catch(() => {});
      }
      animId = requestAnimationFrame(drawFrame);
    };

    startPlayback().catch((err) => {
      if (activeRecorder.state === 'recording') {
        try {
          activeRecorder.stop();
        } catch {
          // ignore
        }
      }
      cleanup();
      reject(err);
    });
  });
}
