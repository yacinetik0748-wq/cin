import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import type {
  BlurEffect,
  CaptionSegment,
  DetectedSubtitleRegion,
  FilmstripFrame,
  GeneratedVoiceClip,
  Project,
  ProjectAudioWaveforms,
  SubtitleRemovalState,
  SyncMode,
  TimelineSyncPlan,
  VideoMetadata,
} from '../types/studio';
import {
  applySyncPlanToClips,
  buildTimelineSyncPlan,
  clampContinuousPauseMs,
  normalizeSyncMode,
} from '../../server/services/timeline_sync_service';
import { getBlobAssetByKey } from './browserStorage';
import { indexedDbStore } from './indexedDbStore';

const FFMPEG_CACHE_NAME = 'recap-ffmpeg-core-cache-v1';

const CORE_ST_CDN_BASES = [
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm',
  'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm',
];

const CORE_MT_CDN_BASES = [
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.6/dist/esm',
  'https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm',
];

let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoadingPromise: Promise<FFmpeg> | null = null;
let ffmpegQueue: Promise<unknown> = Promise.resolve();
let ffmpegMultiThreaded = false;
const cachedObjectCoreUrls = new Map<string, string>();

export function supportsFFmpegMultiThread(): boolean {
  return (
    typeof SharedArrayBuffer !== 'undefined' &&
    typeof globalThis !== 'undefined' &&
    Boolean((globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated)
  );
}

export function isBrowserFFmpegMultiThreaded(): boolean {
  return ffmpegMultiThreaded;
}

async function fetchCoreAssetAsBlobUrl(url: string, mimeType: string): Promise<string> {
  const memCached = cachedObjectCoreUrls.get(url);
  if (memCached) return memCached;

  let blob: Blob | null = null;
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(FFMPEG_CACHE_NAME);
      const cachedResp = await cache.match(url);
      if (cachedResp && cachedResp.ok) {
        const buf = await cachedResp.arrayBuffer();
        if (buf.byteLength > 0) {
          blob = new Blob([buf], { type: mimeType });
        }
      }
      if (!blob) {
        const netResp = await fetch(url);
        if (netResp.ok) {
          const clone = netResp.clone();
          const buf = await netResp.arrayBuffer();
          if (buf.byteLength > 0) {
            void cache.put(url, clone).catch(() => {});
            blob = new Blob([buf], { type: mimeType });
          }
        }
      }
    } catch {
      // Fallback cleanly to toBlobURL if Cache API is restricted
    }
  }

  const blobUrl = blob ? URL.createObjectURL(blob) : await toBlobURL(url, mimeType);
  cachedObjectCoreUrls.set(url, blobUrl);
  return blobUrl;
}

export async function getBrowserFFmpeg(
  onLog?: (msg: string) => void
): Promise<FFmpeg> {
  if (ffmpegInstance && ffmpegInstance.loaded) {
    return ffmpegInstance;
  }
  if (!ffmpegLoadingPromise) {
    ffmpegLoadingPromise = (async () => {
      const canMt = supportsFFmpegMultiThread();
      const attempts: Array<{ base: string; mt: boolean }> = [
        ...(canMt ? CORE_MT_CDN_BASES.map((base) => ({ base, mt: true })) : []),
        ...CORE_ST_CDN_BASES.map((base) => ({ base, mt: false })),
      ];

      let lastErr: unknown = null;
      for (const attempt of attempts) {
        const ff = new FFmpeg();
        try {
          if (attempt.mt) {
            const [coreURL, wasmURL, workerURL] = await Promise.all([
              fetchCoreAssetAsBlobUrl(`${attempt.base}/ffmpeg-core.js`, 'text/javascript'),
              fetchCoreAssetAsBlobUrl(`${attempt.base}/ffmpeg-core.wasm`, 'application/wasm'),
              fetchCoreAssetAsBlobUrl(`${attempt.base}/ffmpeg-core.worker.js`, 'text/javascript'),
            ]);
            await ff.load({ coreURL, wasmURL, workerURL });
            ffmpegMultiThreaded = true;
          } else {
            const [coreURL, wasmURL] = await Promise.all([
              fetchCoreAssetAsBlobUrl(`${attempt.base}/ffmpeg-core.js`, 'text/javascript'),
              fetchCoreAssetAsBlobUrl(`${attempt.base}/ffmpeg-core.wasm`, 'application/wasm'),
            ]);
            await ff.load({ coreURL, wasmURL });
            ffmpegMultiThreaded = false;
          }
          ffmpegInstance = ff;
          return ff;
        } catch (err) {
          try {
            ff.terminate();
          } catch {
            // ignore
          }
          lastErr = err;
        }
      }
      ffmpegLoadingPromise = null;
      throw new Error(
        `Failed to initialize browser FFmpeg WebAssembly core: ${
          lastErr instanceof Error ? lastErr.message : String(lastErr)
        }`
      );
    })();
  }
  const ff = await ffmpegLoadingPromise;
  if (onLog) {
    ff.on('log', ({ message }) => onLog(message));
  }
  return ff;
}

export function terminateBrowserFFmpeg(): void {
  if (ffmpegInstance) {
    try {
      ffmpegInstance.terminate();
    } catch {
      // ignore
    }
  }
  ffmpegInstance = null;
  ffmpegLoadingPromise = null;
  ffmpegMultiThreaded = false;
  ffmpegQueue = Promise.resolve();
}

export function withFFmpegLock<T>(task: (ffmpeg: FFmpeg) => Promise<T>): Promise<T> {
  const run = ffmpegQueue.then(async () => {
    const ff = await getBrowserFFmpeg();
    return task(ff);
  });
  ffmpegQueue = run.catch(() => undefined);
  return run;
}

export async function safeDeleteMemfsFile(ff: FFmpeg, path: string): Promise<void> {
  try {
    await ff.deleteFile(path);
  } catch {
    // ignore missing file
  }
}

export interface MemfsMediaInspection {
  hasVideo: boolean;
  hasAudio: boolean;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string | null;
  audioCodec: string | null;
  maxVolumeDb: number | null;
  meanVolumeDb: number | null;
}

export async function inspectMemfsMedia(
  ff: FFmpeg,
  memPath: string,
  options?: { measureAudioVolume?: boolean }
): Promise<MemfsMediaInspection> {
  const logs: string[] = [];
  const onLog = ({ message }: { message: string }) => {
    logs.push(message);
  };
  ff.on('log', onLog);
  try {
    if (options?.measureAudioVolume) {
      await ff
        .exec(['-hide_banner', '-i', memPath, '-vn', '-af', 'volumedetect', '-f', 'null', '-'])
        .catch(() => 1);
    } else {
      await ff.exec(['-hide_banner', '-i', memPath]).catch(() => 1);
    }
  } finally {
    ff.off('log', onLog);
  }

  const joined = logs.join('\n');
  let durationSec = 0;
  const durMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(joined);
  if (durMatch) {
    durationSec =
      Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]);
  }

  const videoLineMatch = /Stream #0:\d+[^\n]*Video:\s*([^,\s(]+)[^\n]*?,\s*(\d{2,5})x(\d{2,5})(?:[^\n]*?(\d+(?:\.\d+)?)\s*(?:fps|tbr))?/i.exec(
    joined
  );
  const audioLineMatch = /Stream #0:\d+[^\n]*Audio:\s*([^,\s(]+)/i.exec(joined);
  const maxVolMatch = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i.exec(joined);
  const meanVolMatch = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i.exec(joined);

  return {
    hasVideo: Boolean(videoLineMatch),
    hasAudio: Boolean(audioLineMatch),
    durationSec,
    width: videoLineMatch ? Number(videoLineMatch[2]) : 0,
    height: videoLineMatch ? Number(videoLineMatch[3]) : 0,
    fps: videoLineMatch && videoLineMatch[4] ? Math.max(1, Number(videoLineMatch[4])) : 30,
    videoCodec: videoLineMatch ? videoLineMatch[1] : null,
    audioCodec: audioLineMatch ? audioLineMatch[1] : null,
    maxVolumeDb: maxVolMatch ? Number(maxVolMatch[1]) : null,
    meanVolumeDb: meanVolMatch ? Number(meanVolMatch[1]) : null,
  };
}

export async function resolveMediaBlob(url: string, resolveUrlFn?: (u: string) => string): Promise<Blob> {
  if (!url) throw new Error('Asset URL is empty.');

  if (url.startsWith('idb://blobs/')) {
    const key = url.slice('idb://blobs/'.length);
    const localBlob = await getBlobAssetByKey(key).catch(() => null);
    if (localBlob && localBlob.size > 0) {
      return localBlob;
    }
  }

  const cached = await indexedDbStore.getCachedMediaByUrl(url);
  if (cached && cached.blob && cached.blob.size > 0) {
    return cached.blob;
  }

  const target =
    url.startsWith('blob:') ||
    url.startsWith('data:') ||
    url.startsWith('http://') ||
    url.startsWith('https://')
      ? url
      : resolveUrlFn
      ? resolveUrlFn(url)
      : url;

  const res = await fetch(target);
  if (!res.ok) {
    throw new Error(`Unable to load media asset (${res.status}): ${url}`);
  }
  const blob = await res.blob();
  if (blob.size === 0) {
    throw new Error(`Media asset is empty (0 bytes): ${url}`);
  }
  return blob;
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read blob as data URL.'));
    reader.readAsDataURL(blob);
  });
}

export async function computeAudioPeaksFromBlob(
  blob: Blob,
  barCount = 120
): Promise<{ peaks: number[]; duration: number; hasAudio: boolean }> {
  try {
    if (blob.size > 85 * 1024 * 1024) {
      // Avoid multi-hundred-MB full decode spikes inside browser memory
      return {
        peaks: new Array(barCount).fill(0.28),
        duration: 0,
        hasAudio: true,
      };
    }
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) {
      return { peaks: new Array(barCount).fill(0.22), duration: 0, hasAudio: false };
    }
    const ctx = new AudioCtx();
    try {
      const arrayBuf = await blob.arrayBuffer();
      const audioBuf = await ctx.decodeAudioData(arrayBuf.slice(0));
      const chan = audioBuf.getChannelData(0);
      const step = Math.max(1, Math.floor(chan.length / barCount));
      const peaks: number[] = [];
      let maxPeak = 0;
      for (let i = 0; i < barCount; i++) {
        const start = i * step;
        const end = Math.min(chan.length, start + step);
        let peak = 0;
        const stride = Math.max(1, Math.floor((end - start) / 64));
        for (let j = start; j < end; j += stride) {
          const abs = Math.abs(chan[j]);
          if (abs > peak) peak = abs;
        }
        if (peak > maxPeak) maxPeak = peak;
        peaks.push(peak);
      }
      const norm = maxPeak > 0.01 ? peaks.map((p) => Number((p / maxPeak).toFixed(3))) : peaks.map(() => 0.05);
      return { peaks: norm, duration: audioBuf.duration, hasAudio: true };
    } finally {
      await ctx.close().catch(() => {});
    }
  } catch {
    return { peaks: new Array(barCount).fill(0.15), duration: 0, hasAudio: false };
  }
}

export async function probeVideoInBrowser(
  file: Blob,
  filename = 'video.mp4'
): Promise<{
  metadata: VideoMetadata;
  thumbnailBlob: Blob | null;
  thumbnailDataUrl: string | null;
  waveformPeaks: number[];
}> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.src = objectUrl;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out reading video metadata.')), 20_000);
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Unsupported video codec or corrupted video container in browser.'));
      };
    });

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 10;
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;

    let thumbnailBlob: Blob | null = null;
    let thumbnailDataUrl: string | null = null;
    try {
      const targetTime = Math.min(Math.max(0.1, duration * 0.12), Math.max(0.2, duration - 0.1));
      await seekVideoElement(video, targetTime);
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 640 / Math.max(1, width));
      canvas.width = Math.max(2, Math.round(width * scale) & ~1);
      canvas.height = Math.max(2, Math.round(height * scale) & ~1);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        thumbnailDataUrl = canvas.toDataURL('image/jpeg', 0.85);
        thumbnailBlob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85)
        );
      }
    } catch {
      // thumbnail capture optional
    }

    const audioInfo = await computeAudioPeaksFromBlob(file, 120);
    const ext = filename.split('.').pop()?.toLowerCase() || 'mp4';

    const metadata: VideoMetadata = {
      duration: Number(duration.toFixed(3)),
      width,
      height,
      fps: 30,
      videoCodec: 'h264',
      audioCodec: audioInfo.hasAudio ? 'aac' : null,
      bitrate: duration > 0 ? Math.round((file.size * 8) / duration) : 0,
      fileSize: file.size,
      hasAudio: audioInfo.hasAudio,
      formatName: ext,
    };

    return {
      metadata,
      thumbnailBlob,
      thumbnailDataUrl,
      waveformPeaks: audioInfo.peaks,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function seekVideoElement(video: HTMLVideoElement, timeSec: number): Promise<void> {
  const clamped = Math.max(0, Math.min(timeSec, Math.max(0, (video.duration || 10) - 0.04)));
  if (Math.abs(video.currentTime - clamped) < 0.02 && video.readyState >= 2) {
    return;
  }
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeEventListener('seeked', finish);
      resolve();
    };
    const timer = setTimeout(finish, 3000);
    video.addEventListener('seeked', finish, { once: true });
    video.currentTime = clamped;
  });
}

function buildSineWavBytes(durationSec: number, sampleRate = 22050): Uint8Array<ArrayBuffer> {
  const numSamples = Math.floor(durationSec * sampleRate);
  const dataSize = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const freq = t < 3.3 ? 220 : t < 6.6 ? 277.18 : 329.63;
    const env = Math.sin(Math.PI * ((t % 1.0) / 1.0)) * 0.16;
    const sample = Math.max(-1, Math.min(1, Math.sin(2 * Math.PI * freq * t) * env));
    view.setInt16(44 + i * 2, Math.round(sample * 32767), true);
  }
  return new Uint8Array(buf);
}

export async function createSampleVideoInBrowser(): Promise<{
  blob: Blob;
  filename: string;
  metadata: VideoMetadata;
  thumbnailDataUrl: string | null;
  waveformPeaks: number[];
}> {
  const scenes = [
    { title: 'RECAP STUDIO AI', sub: 'SCENE 01 · OPENING SEQUENCE', bg1: '#0f172a', bg2: '#312e81' },
    { title: 'RISING TENSION', sub: 'SCENE 02 · DISCOVERY IN THE VAULT', bg1: '#18181b', bg2: '#4c1d95' },
    { title: 'TURNING POINT', sub: 'SCENE 03 · THE SECRET REVEALED', bg1: '#09090b', bg2: '#7c2d12' },
    { title: 'FINAL CLIMAX', sub: 'SCENE 04 · RACE AGAINST TIME', bg1: '#111827', bg2: '#065f46' },
  ];

  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d')!;

  const frameBlobs: Uint8Array[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const grad = ctx.createLinearGradient(0, 0, 1280, 720);
    grad.addColorStop(0, s.bg1);
    grad.addColorStop(1, s.bg2);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1280, 720);

    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(60, 60, 1160, 600);
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 3;
    ctx.strokeRect(60, 60, 1160, 600);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 58px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(s.title, 640, 325);

    ctx.fillStyle = '#e4e4e7';
    ctx.font = '600 26px sans-serif';
    ctx.fillText(s.sub, 640, 390);

    ctx.fillStyle = '#a1a1aa';
    ctx.font = '20px monospace';
    ctx.fillText(`SAMPLE RECAP FOOTAGE · 1280x720 · 00:0${i * 2}`, 640, 610);

    const jpgBlob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Canvas frame failed'))),
        'image/jpeg',
        0.9
      )
    );
    frameBlobs.push(new Uint8Array(await jpgBlob.arrayBuffer()));
  }

  const mp4Bytes = await withFFmpegLock(async (ff) => {
    const wav = buildSineWavBytes(8);
    await ff.writeFile('sample_audio.wav', wav);
    for (let i = 0; i < frameBlobs.length; i++) {
      await ff.writeFile(`sample_scene_${i}.jpg`, frameBlobs[i]);
    }
    const exitCode = await ff.exec([
      '-loop', '1', '-t', '2', '-i', 'sample_scene_0.jpg',
      '-loop', '1', '-t', '2', '-i', 'sample_scene_1.jpg',
      '-loop', '1', '-t', '2', '-i', 'sample_scene_2.jpg',
      '-loop', '1', '-t', '2', '-i', 'sample_scene_3.jpg',
      '-i', 'sample_audio.wav',
      '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0,fps=24,format=yuv420p[vout]',
      '-map', '[vout]',
      '-map', '4:a',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-shortest',
      '-movflags', '+faststart',
      'sample_recap_8s.mp4',
    ]);
    const out = exitCode === 0 ? ((await ff.readFile('sample_recap_8s.mp4')) as Uint8Array) : null;
    await safeDeleteMemfsFile(ff, 'sample_audio.wav');
    await safeDeleteMemfsFile(ff, 'sample_recap_8s.mp4');
    for (let i = 0; i < frameBlobs.length; i++) {
      await safeDeleteMemfsFile(ff, `sample_scene_${i}.jpg`);
    }
    if (!out || out.byteLength < 1024) {
      throw new Error(`Failed to synthesize sample video in browser FFmpeg (exit ${exitCode}).`);
    }
    return new Uint8Array(out);
  });

  const blob = new Blob([mp4Bytes], { type: 'video/mp4' });
  const probed = await probeVideoInBrowser(blob, 'sample_recap.mp4');
  return {
    blob,
    filename: 'sample_recap.mp4',
    metadata: probed.metadata,
    thumbnailDataUrl: probed.thumbnailDataUrl,
    waveformPeaks: probed.waveformPeaks,
  };
}

export async function extractTimelineFilmstripInBrowser(
  project: Project,
  requestedFrames = 32,
  resolveUrlFn?: (u: string) => string
): Promise<{ frames: FilmstripFrame[]; duration: number }> {
  if (!project.sourceVideoUrl) {
    return { frames: [], duration: 0 };
  }
  const blob = await resolveMediaBlob(project.sourceVideoUrl, resolveUrlFn);
  const objectUrl = URL.createObjectURL(blob);
  const count = Math.max(8, Math.min(48, requestedFrames));

  try {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.src = objectUrl;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out loading video for filmstrip.')), 20_000);
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Could not decode source video frames.'));
      };
    });

    const dur = Math.max(0.5, video.duration || project.metadata?.duration || 10);
    const canvas = document.createElement('canvas');
    const aspect = (video.videoWidth || 1280) / Math.max(1, video.videoHeight || 720);
    canvas.height = 72;
    canvas.width = Math.max(64, Math.round(72 * aspect) & ~1);
    const ctx = canvas.getContext('2d')!;

    const frames: FilmstripFrame[] = [];
    for (let i = 0; i < count; i++) {
      const time = Number((((i + 0.5) / count) * dur).toFixed(2));
      await seekVideoElement(video, time);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push({
        time,
        url: canvas.toDataURL('image/jpeg', 0.65),
      });
    }
    return { frames, duration: dur };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function extractProjectWaveformsInBrowser(
  project: Project,
  resolveUrlFn?: (u: string) => string
): Promise<ProjectAudioWaveforms> {
  const extractBars = async (url?: string | null, bars = 120): Promise<number[]> => {
    if (!url) return [];
    try {
      const blob = await resolveMediaBlob(url, resolveUrlFn);
      const { peaks } = await computeAudioPeaksFromBlob(blob, bars);
      return peaks;
    } catch {
      return [];
    }
  };

  const [orig, dub, bgm, sfx] = await Promise.all([
    project.metadata?.hasAudio !== false
      ? extractBars(project.sourceVideoUrl, 120)
      : Promise.resolve([]),
    extractBars(project.voice.fullDubUrl, 120),
    extractBars(project.voice.bgMusicUrl, 120),
    extractBars(project.voice.sfxUrl, 120),
  ]);

  const dubClips: Record<string, number[]> = {};
  for (const clip of project.voice.generatedClips || []) {
    if (clip.audioUrl) {
      dubClips[clip.segmentId] = await extractBars(clip.audioUrl, 40);
    }
  }

  return { orig, dub, dubClips, bgm, sfx };
}

export async function extractAudioTrackInBrowser(
  project: Project,
  opts: { format: 'mp3' | 'wav'; sampleRate?: number; mono?: boolean; bitrate?: string },
  resolveUrlFn?: (u: string) => string
): Promise<{ blob: Blob; filename: string; mimeType: string; durationSec: number }> {
  if (!project.sourceVideoUrl) {
    throw new Error('Project has no uploaded video.');
  }
  const srcBlob = await resolveMediaBlob(project.sourceVideoUrl, resolveUrlFn);
  const ext = (project.sourceFilename || 'source.mp4').split('.').pop() || 'mp4';
  const inName = `extract_in.${ext}`;
  const outName = opts.format === 'wav' ? 'extract_out.wav' : 'extract_out.mp3';

  const outBytes = await withFFmpegLock(async (ff) => {
    await ff.writeFile(inName, new Uint8Array(await srcBlob.arrayBuffer()));
    const args = ['-i', inName, '-vn'];
    if (opts.mono) args.push('-ac', '1');
    if (opts.sampleRate) args.push('-ar', String(opts.sampleRate));
    if (opts.format === 'wav') {
      args.push('-c:a', 'pcm_s16le', outName);
    } else {
      args.push('-c:a', 'libmp3lame', '-b:a', opts.bitrate || '128k', outName);
    }
    const exitCode = await ff.exec(args);
    const data = exitCode === 0 ? ((await ff.readFile(outName)) as Uint8Array) : null;
    await safeDeleteMemfsFile(ff, inName);
    await safeDeleteMemfsFile(ff, outName);
    if (!data || data.byteLength < 64) {
      throw new Error('FFmpeg WASM could not extract audio from this video (video may have no audio stream).');
    }
    return new Uint8Array(data);
  });

  const safeTitle = project.name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'audio';
  return {
    blob: new Blob([outBytes], {
      type: opts.format === 'wav' ? 'audio/wav' : 'audio/mpeg',
    }),
    filename: `${safeTitle}_extracted.${opts.format}`,
    mimeType: opts.format === 'wav' ? 'audio/wav' : 'audio/mpeg',
    durationSec: project.metadata?.duration || 15,
  };
}

function measureTrimPoints(buf: AudioBuffer): {
  duration: number;
  leadingSilence: number;
  trailingSilence: number;
  speechDuration: number;
} {
  const sr = buf.sampleRate;
  const chan = buf.getChannelData(0);
  const duration = Number(buf.duration.toFixed(3));
  const winSize = Math.max(1, Math.floor(sr * 0.02));
  const thresh = 0.01;
  let firstActive = -1;
  let lastActive = -1;

  for (let start = 0; start < chan.length; start += winSize) {
    const end = Math.min(chan.length, start + winSize);
    let sumSq = 0;
    for (let i = start; i < end; i++) sumSq += chan[i] * chan[i];
    const rms = Math.sqrt(sumSq / Math.max(1, end - start));
    if (rms >= thresh) {
      if (firstActive < 0) firstActive = start / sr;
      lastActive = end / sr;
    }
  }

  if (firstActive < 0 || lastActive < 0) {
    return {
      duration,
      leadingSilence: 0,
      trailingSilence: 0,
      speechDuration: duration,
    };
  }
  const leading = Math.max(0, Number(Math.max(0, firstActive - 0.03).toFixed(3)));
  const trailing = Math.max(0, Number(Math.max(0, duration - (lastActive + 0.05)).toFixed(3)));
  const speechDuration = Math.max(0.15, Number((duration - leading - trailing).toFixed(3)));
  return { duration, leadingSilence: leading, trailingSilence: trailing, speechDuration };
}

function encodeAudioBufferToWav(buf: AudioBuffer): Uint8Array<ArrayBuffer> {
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
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, buf.getChannelData(ch)[i]));
      view.setInt16(offset, Math.round(sample * 32767), true);
      offset += 2;
    }
  }
  return new Uint8Array(out);
}

export async function trimAndMergeDubClipsInBrowser(params: {
  captions: CaptionSegment[];
  clips: Array<{
    segmentId: string;
    start: number;
    end: number;
    audioUrl: string;
    blob: Blob;
    text: string;
    speaker?: string;
    speed?: number;
  }>;
  syncMode: SyncMode;
  continuousPauseMs?: number;
  originalDuration: number;
  onProgress?: (pct: number, stage: string) => void;
}): Promise<{
  fullDubBlob: Blob;
  generatedClips: GeneratedVoiceClip[];
  syncPlan: TimelineSyncPlan;
}> {
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();

  const decodedMap = new Map<
    string,
    {
      buffer: AudioBuffer;
      duration: number;
      leadingSilence: number;
      trailingSilence: number;
      speechDuration: number;
    }
  >();

  try {
    params.onProgress?.(68, 'Measuring generated voice clips & trimming silence...');
    for (const c of params.clips) {
      const ab = await c.blob.arrayBuffer();
      const buf = await ctx.decodeAudioData(ab.slice(0));
      const metrics = measureTrimPoints(buf);
      decodedMap.set(c.segmentId, { buffer: buf, ...metrics });
    }
  } finally {
    await ctx.close().catch(() => {});
  }

  const normalizedMode = normalizeSyncMode(params.syncMode);
  const clampedPause = clampContinuousPauseMs(params.continuousPauseMs);

  const measuredInputs = params.clips.map((c) => {
    const m = decodedMap.get(c.segmentId);
    return {
      segmentId: c.segmentId,
      start: c.start,
      end: c.end,
      duration: m ? m.speechDuration : Math.max(0.2, c.end - c.start),
      speechDuration: m?.speechDuration,
      leadingSilence: m?.leadingSilence,
      trailingSilence: m?.trailingSilence,
    };
  });

  const syncPlan = buildTimelineSyncPlan({
    captions: params.captions,
    measuredClips: measuredInputs,
    originalVideoDuration: params.originalDuration,
    syncMode: normalizedMode,
    continuousPauseMs: clampedPause,
  });

  const initialClips: GeneratedVoiceClip[] = params.clips.map((c) => {
    const m = decodedMap.get(c.segmentId);
    const dur = m ? m.speechDuration : Math.max(0.2, c.end - c.start);
    return {
      segmentId: c.segmentId,
      audioUrl: c.audioUrl,
      start: c.start,
      end: c.start + dur,
      duration: dur,
      speed: c.speed ?? 1.0,
      preservePitch: true,
      speechDuration: m?.speechDuration ?? dur,
      leadingSilence: m?.leadingSilence ?? 0,
      trailingSilence: m?.trailingSilence ?? 0,
      trimStartSec: m?.leadingSilence ?? 0,
      trimEndSec: m?.trailingSilence ?? 0,
      text: c.text,
      speaker: c.speaker,
    };
  });

  const generatedClips = applySyncPlanToClips(initialClips, syncPlan);

  // Mix all trimmed clips on a sample-accurate OfflineAudioContext timeline
  params.onProgress?.(82, 'Assembling synchronized dub audio track...');
  const sampleRate = 44100;
  const maxClipEnd = generatedClips.reduce((m, c) => Math.max(m, c.end), 0);
  const totalSec = Math.max(1.0, params.originalDuration, syncPlan.estimatedFinalDuration, maxClipEnd + 0.25);
  const offline = new OfflineAudioContext(2, Math.ceil(totalSec * sampleRate), sampleRate);

  for (const clip of generatedClips) {
    const dec = decodedMap.get(clip.segmentId);
    if (!dec) continue;
    const src = offline.createBufferSource();
    src.buffer = dec.buffer;
    const spd = Math.max(0.25, Math.min(4.0, clip.speed ?? 1.0));
    src.playbackRate.value = spd;
    src.connect(offline.destination);
    const trimStart = Math.max(0, clip.trimStartSec ?? dec.leadingSilence);
    const durToPlay = Math.max(0.08, dec.duration - trimStart - (clip.trimEndSec ?? dec.trailingSilence));
    src.start(Math.max(0, clip.start), trimStart, durToPlay);
  }

  const renderedBuf = await offline.startRendering();
  const wavBytes = encodeAudioBufferToWav(renderedBuf);

  params.onProgress?.(90, 'Encoding merged dub track to MP3...');
  const mp3Bytes = await withFFmpegLock(async (ff) => {
    await ff.writeFile('dub_merge.wav', wavBytes);
    const code = await ff.exec([
      '-i', 'dub_merge.wav',
      '-c:a', 'libmp3lame',
      '-b:a', '128k',
      'dub_merge.mp3',
    ]);
    const data = code === 0 ? ((await ff.readFile('dub_merge.mp3')) as Uint8Array) : null;
    await safeDeleteMemfsFile(ff, 'dub_merge.wav');
    await safeDeleteMemfsFile(ff, 'dub_merge.mp3');
    if (!data || data.byteLength < 128) {
      // Fallback to WAV blob if libmp3lame is unavailable in core
      return null;
    }
    return new Uint8Array(data);
  });

  const fullDubBlob = mp3Bytes
    ? new Blob([mp3Bytes], { type: 'audio/mpeg' })
    : new Blob([wavBytes], { type: 'audio/wav' });

  return { fullDubBlob, generatedClips, syncPlan };
}

export async function detectOriginalCaptionsInBrowser(
  project: Project,
  resolveUrlFn?: (u: string) => string
): Promise<{
  detections: DetectedSubtitleRegion[];
  ocrAvailable: boolean;
  method: 'hybrid' | 'ocr' | 'visual' | 'unavailable';
  analysisMessage: string;
  framesAnalyzed: number;
  subtitleRemoval: SubtitleRemovalState;
  blurs: BlurEffect[];
}> {
  if (!project.sourceVideoUrl) {
    throw new Error('Upload a source video before scanning for hardcoded subtitles.');
  }
  const blob = await resolveMediaBlob(project.sourceVideoUrl, resolveUrlFn);
  const objectUrl = URL.createObjectURL(blob);

  try {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.src = objectUrl;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out loading video for caption scan.')), 20_000);
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Could not decode video for caption detection.'));
      };
    });

    const duration = Math.max(1, video.duration || project.metadata?.duration || 10);
    const frameCount = Math.min(12, Math.max(6, Math.round(duration / 2)));
    const w = 320;
    const h = 180;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

    const bandScores = {
      bottom: { hits: 0, totalXMin: w, totalXMax: 0, sumScore: 0 },
      top: { hits: 0, totalXMin: w, totalXMax: 0, sumScore: 0 },
    };

    const bands: Array<{ key: 'bottom' | 'top'; yStart: number; yEnd: number }> = [
      { key: 'bottom', yStart: Math.floor(h * 0.72), yEnd: Math.floor(h * 0.94) },
      { key: 'top', yStart: Math.floor(h * 0.05), yEnd: Math.floor(h * 0.24) },
    ];

    for (let f = 0; f < frameCount; f++) {
      const t = ((f + 0.5) / frameCount) * duration;
      await seekVideoElement(video, t);
      ctx.drawImage(video, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h).data;

      for (const band of bands) {
        let highContrastEdges = 0;
        let brightTextPixels = 0;
        let bandMinX = w;
        let bandMaxX = 0;
        const xStart = Math.floor(w * 0.08);
        const xEnd = Math.floor(w * 0.92);

        for (let y = band.yStart; y < band.yEnd; y++) {
          for (let x = xStart; x < xEnd - 1; x++) {
            const idx = (y * w + x) * 4;
            const idxRight = idx + 4;
            const lum = 0.299 * img[idx] + 0.587 * img[idx + 1] + 0.114 * img[idx + 2];
            const lumR =
              0.299 * img[idxRight] + 0.587 * img[idxRight + 1] + 0.114 * img[idxRight + 2];
            if (Math.abs(lum - lumR) > 75) {
              highContrastEdges++;
              if (x < bandMinX) bandMinX = x;
              if (x > bandMaxX) bandMaxX = x;
            }
            if (lum > 225) brightTextPixels++;
          }
        }

        const area = (xEnd - xStart) * (band.yEnd - band.yStart);
        const edgeRatio = highContrastEdges / Math.max(1, area);
        const brightRatio = brightTextPixels / Math.max(1, area);
        if (edgeRatio > 0.032 && brightRatio > 0.01) {
          bandScores[band.key].hits += 1;
          bandScores[band.key].sumScore += Math.min(0.95, 0.45 + edgeRatio * 6);
          bandScores[band.key].totalXMin = Math.min(bandScores[band.key].totalXMin, bandMinX);
          bandScores[band.key].totalXMax = Math.max(bandScores[band.key].totalXMax, bandMaxX);
        }
      }
    }

    const detections: DetectedSubtitleRegion[] = [];
    const pushBand = (key: 'bottom' | 'top', yNorm: number, hNorm: number) => {
      const info = bandScores[key];
      if (info.hits === 0) return;
      const x1 = Math.max(0.06, info.totalXMin / w - 0.03);
      const x2 = Math.min(0.94, Math.max(x1 + 0.35, info.totalXMax / w + 0.03));
      detections.push({
        id: `det_${key}_${Date.now()}`,
        x: Number(x1.toFixed(3)),
        y: yNorm,
        width: Number((x2 - x1).toFixed(3)),
        height: hNorm,
        startTime: 0,
        endTime: Number(duration.toFixed(2)),
        band: key,
        confidence: Number((info.sumScore / info.hits).toFixed(2)),
        method: 'visual',
        framesMatched: info.hits,
        selected: true,
      });
    };

    pushBand('bottom', 0.74, 0.18);
    if (bandScores.top.hits >= 2) {
      pushBand('top', 0.06, 0.16);
    }
    if (detections.length === 0) {
      // Provide an editable lower-third starter mask when scene has subtle embedded text
      detections.push({
        id: `det_bottom_default_${Date.now()}`,
        x: 0.12,
        y: 0.76,
        width: 0.76,
        height: 0.16,
        startTime: 0,
        endTime: Number(duration.toFixed(2)),
        band: 'bottom',
        confidence: 0.42,
        method: 'visual',
        framesMatched: 0,
        selected: true,
      });
    }

    const subtitleRemoval: SubtitleRemovalState = {
      lastAnalyzedAt: new Date().toISOString(),
      ocrAvailable: false,
      method: 'visual',
      analysisMessage: `Visual high-contrast subtitle scan inspected ${frameCount} browser frames (Tesseract OCR runs only with Node backend; adjust mask position if needed).`,
      framesAnalyzed: frameCount,
      detections,
    };

    const existingManualBlurs = (project.blurs || []).filter((b) => !b.isSubtitleMask);
    const maskBlurs: BlurEffect[] = detections.map((det, idx) => ({
      id: `submask_${idx}_${Date.now()}`,
      name: `Detected ${det.band.toUpperCase()} Subtitle Mask`,
      mode: 'selective',
      type: 'strong',
      enabled: true,
      intensity: 24,
      radius: 22,
      opacity: 0.96,
      feather: 10,
      borderRadius: 8,
      startTime: det.startTime,
      endTime: det.endTime,
      x: det.x,
      y: det.y,
      width: det.width,
      height: det.height,
      shape: 'rect',
      coordSpace: 'video',
      isSubtitleMask: true,
      detectionMeta: {
        band: det.band,
        confidence: det.confidence,
        method: 'visual',
        framesMatched: det.framesMatched,
      },
    }));

    return {
      detections,
      ocrAvailable: false,
      method: 'visual',
      analysisMessage: subtitleRemoval.analysisMessage || '',
      framesAnalyzed: frameCount,
      subtitleRemoval,
      blurs: [...existingManualBlurs, ...maskBlurs],
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function generateThumbnailsInBrowser(
  project: Project,
  resolveUrlFn?: (u: string) => string
): Promise<{
  thumbnails: string[];
  sourceMode: 'final-export' | 'edited-source';
  suggestedTitle: string;
  suggestedSubtitle: string;
  suggestedTitles: string[];
  translationMissingWarning: boolean;
}> {
  const sourceMode: 'final-export' | 'edited-source' = project.lastExportUrl
    ? 'final-export'
    : 'edited-source';
  const targetUrl = project.lastExportUrl || project.sourceVideoUrl;
  if (!targetUrl) {
    throw new Error('No uploaded or exported video available to capture thumbnails from.');
  }

  const blob = await resolveMediaBlob(targetUrl, resolveUrlFn);
  const objectUrl = URL.createObjectURL(blob);
  const thumbnails: string[] = [];

  try {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.src = objectUrl;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out capturing thumbnails.')), 20_000);
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Could not decode video for thumbnails.'));
      };
    });

    const dur = Math.max(1, video.duration || project.metadata?.duration || 10);
    const canvas = document.createElement('canvas');
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    const scale = Math.min(1, 720 / Math.max(vw, vh));
    canvas.width = Math.max(2, Math.round(vw * scale) & ~1);
    canvas.height = Math.max(2, Math.round(vh * scale) & ~1);
    const ctx = canvas.getContext('2d')!;

    const fractions = [0.08, 0.26, 0.48, 0.72, 0.9];
    for (const frac of fractions) {
      await seekVideoElement(video, dur * frac);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      thumbnails.push(canvas.toDataURL('image/jpeg', 0.88));
    }
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  // Strictly derive title suggestions from project name & translated captions (never hallucinate)
  const translatedLines = (project.captions || [])
    .map((c) => (c.translatedText || '').trim())
    .filter(Boolean);
  const translationMissingWarning = translatedLines.length === 0;
  const firstTranslated = translatedLines[0] || '';
  const dramaticLine =
    translatedLines.reduce((best, line) => (line.length > best.length && line.length <= 72 ? line : best), firstTranslated) ||
    '';

  const suggestedTitle =
    (firstTranslated ? firstTranslated.split(/[.!?]/)[0].trim().slice(0, 48) : project.name) ||
    project.name;
  const suggestedSubtitle = dramaticLine.slice(0, 64) || project.name;
  const suggestedTitles = Array.from(
    new Set(
      [suggestedTitle, project.name, ...translatedLines.slice(0, 3).map((l) => l.slice(0, 48))].filter(
        Boolean
      )
    )
  ).slice(0, 4);

  return {
    thumbnails,
    sourceMode,
    suggestedTitle,
    suggestedSubtitle,
    suggestedTitles,
    translationMissingWarning,
  };
}

export async function compressVideoInBrowser(
  project: Project,
  preset: 'under-45mb' | '720p-compact' | '480p-compact',
  target: 'source' | 'final-export',
  resolveUrlFn?: (u: string) => string
): Promise<{
  blob: Blob;
  filename: string;
  originalUrl: string;
  originalBytes: number;
  compressedBytes: number;
  metadata: VideoMetadata;
}> {
  const originalUrl = target === 'final-export' ? project.lastExportUrl : project.sourceVideoUrl;
  if (!originalUrl) {
    throw new Error(`No ${target} video available to compress.`);
  }
  const srcBlob = await resolveMediaBlob(originalUrl, resolveUrlFn);
  const ext = (originalUrl.split('.').pop()?.split('?')[0] || 'mp4').toLowerCase();
  const inName = `compress_in.${ext}`;
  const outName = `compress_out.mp4`;
  const dur = Math.max(1, project.metadata?.duration || 20);

  let scaleFilter = 'scale=-2:720';
  let videoBitrate = '1400k';
  if (preset === '480p-compact') {
    scaleFilter = 'scale=-2:480';
    videoBitrate = '800k';
  } else if (preset === 'under-45mb') {
    scaleFilter = 'scale=-2:720';
    const targetBitsPerSec = Math.max(300_000, Math.min(2_500_000, Math.floor((38 * 8 * 1024 * 1024) / dur) - 96_000));
    videoBitrate = `${Math.round(targetBitsPerSec / 1000)}k`;
  }

  const outBytes = await withFFmpegLock(async (ff) => {
    await ff.writeFile(inName, new Uint8Array(await srcBlob.arrayBuffer()));
    const args = [
      '-i', inName,
      '-vf', scaleFilter,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-b:v', videoBitrate,
      '-maxrate', videoBitrate,
      '-bufsize', '2000k',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-movflags', '+faststart',
      outName,
    ];
    const code = await ff.exec(args);
    const data = code === 0 ? ((await ff.readFile(outName)) as Uint8Array) : null;
    await safeDeleteMemfsFile(ff, inName);
    await safeDeleteMemfsFile(ff, outName);
    if (!data || data.byteLength < 1024) {
      throw new Error(`Browser video compression failed (exit ${code}).`);
    }
    return new Uint8Array(data);
  });

  const blob = new Blob([outBytes], { type: 'video/mp4' });
  const probed = await probeVideoInBrowser(blob, `${project.name}_${preset}.mp4`);
  const safeBase = project.name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'video';
  return {
    blob,
    filename: `${safeBase}_${preset}.mp4`,
    originalUrl,
    originalBytes: srcBlob.size,
    compressedBytes: blob.size,
    metadata: probed.metadata,
  };
}
