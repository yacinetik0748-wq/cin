import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import { FilmstripFrame, ProjectAudioWaveforms, VideoMetadata } from '../types/studio';
import { buildProjectVideoBlobKey, normalizeVideoBlobMime, storeBlobAsset } from './browserStorage';

let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoadingPromise: Promise<FFmpeg> | null = null;

export async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpegInstance && ffmpegInstance.loaded) {
    return ffmpegInstance;
  }
  if (ffmpegLoadingPromise) {
    return ffmpegLoadingPromise;
  }

  ffmpegLoadingPromise = (async () => {
    const ffmpeg = new FFmpeg();
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
    
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });

    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })();

  return ffmpegLoadingPromise;
}

export async function analyzeVideoFileInBrowser(file: File): Promise<{ metadata: VideoMetadata; duration: number }> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    const objectUrl = URL.createObjectURL(file);

    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      URL.revokeObjectURL(objectUrl);
      video.src = '';
      video.load();
    };

    const doneWith = (dur: number, w: number, h: number) => {
      cleanup();
      const safeDuration = Number.isFinite(dur) && dur > 0 ? dur : 10;
      const width = w > 0 ? w : 1920;
      const height = h > 0 ? h : 1080;
      const fileSize = file.size;

      const metadata: VideoMetadata = {
        duration: safeDuration,
        width,
        height,
        fps: 30,
        videoCodec: 'h264',
        audioCodec: 'aac',
        bitrate: Math.round((fileSize * 8) / safeDuration),
        fileSize,
        hasAudio: true,
        formatName: file.type || 'mp4',
      };

      resolve({ metadata, duration: safeDuration });
    };

    // Safety timeout: 4s max so metadata detection never hangs
    const timer = setTimeout(() => {
      doneWith(video.duration || 10, video.videoWidth || 1920, video.videoHeight || 1080);
    }, 4000);

    video.onloadedmetadata = () => {
      clearTimeout(timer);
      doneWith(video.duration, video.videoWidth, video.videoHeight);
    };

    video.onerror = () => {
      clearTimeout(timer);
      doneWith(10, 1920, 1080);
    };

    video.src = objectUrl;
    video.load();
  });
}

export async function generateFilmstripInBrowser(
  file: File,
  frameCount = 12,
  onProgress?: (pct: number, stage: string) => void,
  knownDuration?: number
): Promise<{ frames: FilmstripFrame[]; duration: number }> {
  let duration = knownDuration && knownDuration > 0 ? knownDuration : 0;
  if (!duration) {
    const analyzed = await analyzeVideoFileInBrowser(file);
    duration = analyzed.duration;
  }
  if (!duration || duration <= 0) {
    duration = 10;
  }

  const frames: FilmstripFrame[] = [];
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.crossOrigin = 'anonymous';
  video.preload = 'auto';

  try {
    // Wait for video ready to render frames with 4s safety timeout
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      video.onloadeddata = finish;
      video.oncanplay = finish;
      video.onloadedmetadata = finish;
      video.onerror = finish;
      setTimeout(finish, 4000);
      video.src = objectUrl;
      video.load();
    });

    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const step = duration / Math.max(1, frameCount);

    for (let i = 0; i < frameCount; i++) {
      // Avoid exactly 0.0s to ensure seeking event always fires reliably across all browsers
      const targetTime = Math.min(Math.max(0.05, i * step), Math.max(0.1, duration - 0.05));

      // Seek with strict 1.5s timeout per frame so it NEVER hangs
      await new Promise<void>((resolveSeek) => {
        let resolved = false;
        const done = () => {
          if (resolved) return;
          resolved = true;
          video.removeEventListener('seeked', onSeeked);
          resolveSeek();
        };
        const onSeeked = () => done();

        // If already within 0.1s and readyState is high enough
        if (Math.abs(video.currentTime - targetTime) < 0.1 && video.readyState >= 2) {
          done();
          return;
        }

        const timer = setTimeout(done, 1500);
        video.addEventListener('seeked', onSeeked, { once: true });
        try {
          video.currentTime = targetTime;
        } catch {
          clearTimeout(timer);
          done();
        }
      });

      let frameUrl = '';
      if (ctx) {
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          frameUrl = canvas.toDataURL('image/jpeg', 0.6);
        } catch {
          frameUrl = '';
        }
      }

      frames.push({
        url: frameUrl,
        time: targetTime,
      });

      if (onProgress) {
        const pct = Math.round(60 + ((i + 1) / frameCount) * 24); // 60% -> 84%
        onProgress(pct, `Generating filmstrip frames (${i + 1}/${frameCount})...`);
      }
    }
  } finally {
    URL.revokeObjectURL(objectUrl);
    video.src = '';
    video.load();
  }

  // Fallback placeholder frames if none captured
  if (frames.length === 0) {
    const step = duration / Math.max(1, frameCount);
    for (let i = 0; i < frameCount; i++) {
      frames.push({
        url: '',
        time: i * step,
      });
    }
  }

  return { frames, duration };
}

export async function extractAudioWaveformInBrowser(file: File, bars = 120): Promise<ProjectAudioWaveforms> {
  const fallbackPeaks = Array.from({ length: bars }, () =>
    Number((0.15 + Math.random() * 0.7).toFixed(2))
  );
  const fallbackResult: ProjectAudioWaveforms = {
    orig: fallbackPeaks,
    dub: [],
    dubClips: {},
    bgm: [],
    sfx: [],
  };

  // If file is > 50 MB, avoid allocating huge ArrayBuffer in mobile memory
  if (file.size > 50 * 1024 * 1024) {
    return fallbackResult;
  }

  let audioCtx: AudioContext | null = null;
  try {
    const arrayBuffer = await file.arrayBuffer();
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return fallbackResult;
    audioCtx = new AudioContextClass();

    // Use a strict 3.5s timeout on decodeAudioData so it never stalls the upload
    const audioBuffer = await new Promise<AudioBuffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Audio decode timeout')), 3500);
      audioCtx!.decodeAudioData(
        arrayBuffer,
        (buf) => {
          clearTimeout(timer);
          resolve(buf);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });

    const rawData = audioBuffer.getChannelData(0);
    const blockSz = Math.floor(rawData.length / bars);
    const peaks: number[] = [];

    for (let i = 0; i < bars; i++) {
      let sum = 0;
      const start = i * blockSz;
      const end = Math.min(rawData.length, start + blockSz);
      for (let j = start; j < end; j++) {
        sum += Math.abs(rawData[j]);
      }
      const avg = sum / (end - start || 1);
      peaks.push(Number(Math.min(1, Math.max(0.05, avg * 2.5)).toFixed(3)));
    }

    return {
      orig: peaks,
      dub: [],
      dubClips: {},
      bgm: [],
      sfx: [],
    };
  } catch {
    return fallbackResult;
  } finally {
    if (audioCtx && audioCtx.state !== 'closed') {
      try {
        await audioCtx.close();
      } catch {}
    }
  }
}

export async function processVideoUploadInBrowser(
  file: File,
  onProgress: (pct: number, stage: string) => void,
  projectId?: string
): Promise<{
  sourceVideoUrl: string;
  sourceVideoBlobKey: string;
  metadata: VideoMetadata;
  duration: number;
  filmstrip: FilmstripFrame[];
  waveforms: ProjectAudioWaveforms;
}> {
  onProgress(10, 'Reading video file in browser...');
  const { metadata, duration } = await analyzeVideoFileInBrowser(file);

  onProgress(35, 'Storing video locally in browser (IndexedDB)...');
  const sourceVideoBlobKey = buildProjectVideoBlobKey(projectId, file.name);
  const normalizedBlob = normalizeVideoBlobMime(file, file.name);
  const sourceVideoUrl = await storeBlobAsset(sourceVideoBlobKey, normalizedBlob);

  onProgress(60, 'Generating visual filmstrip frames (0/12)...');
  const { frames: filmstrip } = await generateFilmstripInBrowser(file, 12, onProgress, duration);

  onProgress(88, 'Extracting audio waveform peaks...');
  const waveforms = await extractAudioWaveformInBrowser(file, 140);

  onProgress(100, 'Video ready for studio editing');
  return {
    sourceVideoUrl,
    sourceVideoBlobKey,
    metadata,
    duration,
    filmstrip,
    waveforms,
  };
}
