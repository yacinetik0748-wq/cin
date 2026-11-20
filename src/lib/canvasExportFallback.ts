import {
  DEFAULT_VIDEO_CANVAS,
  Project,
} from '../types/studio';
import { resolveCanvasDimensions } from './workflowStages';
import { retrieveProjectVideoBlob, getBlobAssetByKey } from './browserStorage';
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
  onProgress: (pct: number, stage: string) => void;
}): Promise<CanvasExportResult> {
  const { project, onProgress } = params;

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
  const sourceDuration = Math.max(1, project.metadata?.duration || video.duration || 10);
  const totalDuration =
    clips.length > 0
      ? Math.max(
          0.5,
          clips.reduce(
            (sum, c) => sum + Math.max(0.1, (c.sourceEnd - c.sourceStart) / Math.max(0.25, c.speed || 1)),
            0
          )
        )
      : sourceDuration;

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

  // Preload enabled logos
  const loadedLogos: Array<{ logo: Project['logos'][number]; img: HTMLImageElement }> = [];
  if (exportSettings.applyLogo && project.logos.length > 0) {
    for (const logo of project.logos.filter((l) => l.enabled && l.url)) {
      const img = await loadImageFromAssetUrl(logo.url);
      if (img) loadedLogos.push({ logo, img });
    }
  }

  // Web Audio Context for audio mixing (Android Chrome safe)
  const AudioContextClass =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  let audioCtx: AudioContext | null = null;
  let audioDest: MediaStreamAudioDestinationNode | null = null;
  let dubAudioEl: HTMLAudioElement | null = null;
  let dubUrl: string | null = null;

  try {
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume().catch(() => {});
      }
      audioDest = audioCtx.createMediaStreamDestination();

      try {
        const vidSource = audioCtx.createMediaElementSource(video);
        const vidGain = audioCtx.createGain();
        vidGain.gain.value = project.voice.preserveOriginalAudio
          ? project.voice.originalAudioVolume ?? 0.3
          : exportSettings.applyDubbing && project.voice.enabled
          ? 0
          : 1.0;
        vidSource.connect(vidGain);
        vidGain.connect(audioDest);
      } catch {
        // media element source unavailable
      }

      if (exportSettings.applyDubbing && project.voice.enabled && project.voice.fullDubUrl) {
        let dubBlob: Blob | null = null;
        if (project.voice.fullDubUrl.startsWith('idb://blobs/')) {
          dubBlob = await getBlobAssetByKey(project.voice.fullDubUrl.slice('idb://blobs/'.length));
        }
        if (dubBlob) {
          dubUrl = URL.createObjectURL(dubBlob);
          dubAudioEl = new Audio(dubUrl);
          dubAudioEl.crossOrigin = 'anonymous';
          try {
            const dubSource = audioCtx.createMediaElementSource(dubAudioEl);
            const dubGain = audioCtx.createGain();
            dubGain.gain.value = project.voice.voiceVolume ?? 1.0;
            dubSource.connect(dubGain);
            dubGain.connect(audioDest);
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
  const canvasStream = canvas.captureStream(30);

  const combinedTracks = [...canvasStream.getVideoTracks()];
  if (audioDest && audioDest.stream.getAudioTracks().length > 0) {
    combinedTracks.push(...audioDest.stream.getAudioTracks());
  }
  const combinedStream = new MediaStream(combinedTracks);

  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(combinedStream, {
      mimeType: chosenMime,
      videoBitsPerSecond: 2_500_000,
    });
  } catch {
    recorder = new MediaRecorder(combinedStream);
  }

  const recordedChunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      recordedChunks.push(e.data);
    }
  };

  onProgress(
    20,
    `Rendering video frames locally via Canvas (${targetW}×${targetH} ${extension.toUpperCase()})...`
  );

  return new Promise<CanvasExportResult>((resolve, reject) => {
    let animId = 0;
    let clipIdx = 0;
    let stopped = false;

    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(animId);
      URL.revokeObjectURL(videoUrl);
      if (dubUrl) URL.revokeObjectURL(dubUrl);
      if (dubAudioEl) {
        dubAudioEl.pause();
        dubAudioEl.src = '';
      }
      if (audioCtx && audioCtx.state !== 'closed') {
        audioCtx.close().catch(() => {});
      }
      video.pause();
      video.src = '';
    };

    recorder.onerror = (err) => {
      cleanup();
      reject(err);
    };

    recorder.onstop = () => {
      cleanup();
      const finalBlob = new Blob(recordedChunks, { type: recorder.mimeType || chosenMime });
      if (finalBlob.size === 0) {
        reject(new Error('Canvas fallback produced an empty video blob (0 bytes).'));
        return;
      }
      onProgress(100, `Export complete (${extension.toUpperCase()})`);
      resolve({
        blob: finalBlob,
        filename: `${project.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_final.${extension}`,
        mimeType: recorder.mimeType || chosenMime,
        sizeBytes: finalBlob.size,
        engine: 'canvas-mediarecorder',
      });
    };

    recorder.start(250);

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

    const drawFrame = () => {
      const currentClip = activeClips[clipIdx];
      if (!currentClip) {
        if (recorder.state === 'recording') recorder.stop();
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
          if (recorder.state === 'recording') recorder.stop();
          return;
        }
        video.currentTime = nextClip.sourceStart;
      }

      const timelineTime = Math.min(
        totalDuration,
        timelineElapsedOffset + Math.max(0, curSource - currentClip.sourceStart) / speed
      );

      const progress = Math.min(95, 20 + Math.round((timelineTime / totalDuration) * 75));
      onProgress(
        progress,
        `Encoding frame at ${timelineTime.toFixed(1)}s / ${totalDuration.toFixed(1)}s (${extension.toUpperCase()})...`
      );

      // 1. Background fill
      ctx.fillStyle = canvasConfig.bgColor || '#09090B';
      ctx.fillRect(0, 0, targetW, targetH);

      // 2. Draw video frame with fit / crop mode
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

      ctx.save();
      if (exportSettings.fitMode === 'blur-pad') {
        const bgScale = Math.max(targetW / vw, targetH / vh);
        const bw = vw * bgScale;
        const bh = vh * bgScale;
        ctx.filter = 'blur(18px) brightness(0.7)';
        ctx.drawImage(video, (targetW - bw) / 2, (targetH - bh) / 2, bw, bh);
        ctx.filter = 'none';
      }
      ctx.drawImage(video, dx, dy, dw, dh);
      ctx.restore();

      // 3. Draw active blur zones
      if (exportSettings.applyBlur && project.blurs.length > 0) {
        for (const blur of project.blurs.filter(
          (b) => b.enabled && timelineTime >= b.startTime && timelineTime <= b.endTime
        )) {
          const bx = blur.mode === 'full' ? 0 : blur.x * targetW;
          const by = blur.mode === 'full' ? 0 : blur.y * targetH;
          const bw = blur.mode === 'full' ? targetW : blur.width * targetW;
          const bh = blur.mode === 'full' ? targetH : blur.height * targetH;
          ctx.save();
          ctx.beginPath();
          ctx.rect(bx, by, bw, bh);
          ctx.clip();
          ctx.filter = `blur(${Math.max(4, Math.min(32, blur.radius || blur.intensity || 16))}px)`;
          ctx.drawImage(video, dx, dy, dw, dh);
          ctx.restore();
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

      // 5. Draw active captions
      if (exportSettings.applyCaptions && project.captions.length > 0) {
        const activeCaption = project.captions.find(
          (c) => timelineTime >= c.start && timelineTime <= c.end
        );
        const text = activeCaption?.translatedText || activeCaption?.text;
        if (text) {
          const fs = Math.max(18, Math.round(targetH * 0.042));
          ctx.font = `bold ${fs}px ${project.subtitleStyle.fontFamily || 'sans-serif'}`;
          ctx.textAlign = 'center';
          ctx.fillStyle = project.subtitleStyle.primaryColor || '#FFFFFF';
          ctx.strokeStyle = project.subtitleStyle.outlineColor || '#000000';
          ctx.lineWidth = Math.max(2, Math.round(fs * 0.12));
          const cx = targetW / 2;
          const cy = targetH * 0.85;
          ctx.strokeText(text, cx, cy, targetW * 0.88);
          ctx.fillText(text, cx, cy, targetW * 0.88);
        }
      }

      animId = requestAnimationFrame(drawFrame);
    };

    const startPlayback = async () => {
      video.currentTime = activeClips[0]?.sourceStart || 0;
      try {
        await video.play();
      } catch {
        // Android Chrome fallback when autoplay policy blocks unmuted playback after async gap
        video.muted = true;
        await video.play();
      }
      if (dubAudioEl) {
        dubAudioEl.currentTime = 0;
        dubAudioEl.play().catch(() => {});
      }
      animId = requestAnimationFrame(drawFrame);
    };

    startPlayback().catch((err) => {
      if (recorder.state === 'recording') {
        try {
          recorder.stop();
        } catch {
          // ignore
        }
      }
      cleanup();
      reject(err);
    });
  });
}
