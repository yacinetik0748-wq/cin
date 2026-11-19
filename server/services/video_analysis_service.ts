import { execFile, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { FilmstripFrame, VideoMetadata } from '../../src/types/studio.ts';
import { THUMBS_DIR, UPLOADS_DIR, registerAsset } from '../db.ts';
import { getGeminiClient, isGeminiConfigured } from './gemini_client.ts';
import { v4 as uuidv4 } from 'uuid';

const execFileAsync = promisify(execFile);

export async function checkFfmpegCapabilities(): Promise<{
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  ffmpegVersion: string;
}> {
  let ffmpegAvailable = false;
  let ffprobeAvailable = false;
  let ffmpegVersion = 'Not detected';

  try {
    const { stdout } = await execFileAsync('ffmpeg', ['-version']);
    ffmpegAvailable = true;
    const firstLine = stdout.split('\n')[0] || 'ffmpeg';
    ffmpegVersion = firstLine.replace('ffmpeg version ', '').split(' ')[0] || 'available';
  } catch {
    ffmpegAvailable = false;
  }

  try {
    await execFileAsync('ffprobe', ['-version']);
    ffprobeAvailable = true;
  } catch {
    ffprobeAvailable = false;
  }

  return { ffmpegAvailable, ffprobeAvailable, ffmpegVersion };
}

export async function analyzeVideoFile(filePath: string): Promise<VideoMetadata> {
  const stats = fs.statSync(filePath);
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);

  const parsed = JSON.parse(stdout);
  const streams = (parsed.streams || []) as Array<Record<string, unknown>>;
  const format = (parsed.format || {}) as Record<string, unknown>;

  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');

  if (!videoStream) {
    throw new Error('No video stream found in uploaded file.');
  }

  let fps = 30;
  const rFrameRate = String(videoStream.r_frame_rate || '30/1');
  const [num, den] = rFrameRate.split('/').map(Number);
  if (num && den) {
    fps = Math.round((num / den) * 100) / 100;
  }

  const duration = Number(format.duration || videoStream.duration || 0);
  const width = Number(videoStream.width || 1280);
  const height = Number(videoStream.height || 720);
  const bitrate = Number(format.bit_rate || 0);

  return {
    duration: Math.round(duration * 100) / 100,
    width,
    height,
    fps,
    videoCodec: String(videoStream.codec_name || 'unknown'),
    audioCodec: audioStream ? String(audioStream.codec_name || 'aac') : null,
    bitrate,
    fileSize: stats.size,
    hasAudio: Boolean(audioStream),
    formatName: String(format.format_name || 'mp4'),
  };
}

export async function generateVideoThumbnail(
  filePath: string,
  projectId: string,
  seekSeconds = 1
): Promise<string> {
  const thumbName = `${projectId}_thumb_${Date.now()}.jpg`;
  const thumbPath = path.join(THUMBS_DIR, thumbName);

  await execFileAsync('ffmpeg', [
    '-y',
    '-ss',
    String(Math.max(0, seekSeconds)),
    '-i',
    filePath,
    '-frames:v',
    '1',
    '-vf',
    'scale=640:-2',
    '-q:v',
    '3',
    thumbPath,
  ]);

  const url = `/media/thumbs/${thumbName}`;
  const stat = fs.statSync(thumbPath);
  registerAsset({
    id: uuidv4(),
    projectId,
    kind: 'thumb',
    filename: thumbName,
    filePath: thumbPath,
    url,
    mimeType: 'image/jpeg',
    sizeBytes: stat.size,
  });
  return url;
}

export async function generateHighResVideoFrame(
  filePath: string,
  projectId: string,
  seekSeconds = 1,
  vfFilter?: string
): Promise<string> {
  const thumbName = `${projectId}_hqframe_${Date.now()}_${Math.floor(Math.random() * 1000)}.jpg`;
  const thumbPath = path.join(THUMBS_DIR, thumbName);

  const args = [
    '-y',
    '-ss',
    String(Math.max(0, seekSeconds)),
    '-i',
    filePath,
    '-frames:v',
    '1',
  ];
  if (vfFilter) {
    args.push('-vf', vfFilter);
  }
  args.push('-q:v', '2', thumbPath);

  await execFileAsync('ffmpeg', args);

  const url = `/media/thumbs/${thumbName}`;
  const stat = fs.statSync(thumbPath);
  registerAsset({
    id: uuidv4(),
    projectId,
    kind: 'thumb',
    filename: thumbName,
    filePath: thumbPath,
    url,
    mimeType: 'image/jpeg',
    sizeBytes: stat.size,
  });
  return url;
}

export async function extractWaveformPeaks(
  filePath: string,
  hasAudio: boolean,
  targetBins = 120
): Promise<number[]> {
  if (!hasAudio) {
    return new Array(targetBins).fill(0.05);
  }

  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-i',
      filePath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '4000',
      '-f',
      's16le',
      'pipe:1',
    ]);

    const chunks: Buffer[] = [];
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.on('error', () => resolve(new Array(targetBins).fill(0.1)));
    proc.on('close', () => {
      const pcm = Buffer.concat(chunks);
      const totalSamples = Math.floor(pcm.length / 2);
      if (totalSamples < targetBins) {
        resolve(new Array(targetBins).fill(0.1));
        return;
      }
      const binSize = Math.floor(totalSamples / targetBins);
      const peaks: number[] = [];
      let maxPeak = 0.01;
      for (let i = 0; i < targetBins; i++) {
        let peak = 0;
        const start = i * binSize;
        const end = Math.min(totalSamples, start + binSize);
        const step = Math.max(1, Math.floor((end - start) / 64));
        for (let j = start; j < end; j += step) {
          const sample = Math.abs(pcm.readInt16LE(j * 2)) / 32768;
          if (sample > peak) peak = sample;
        }
        if (peak > maxPeak) maxPeak = peak;
        peaks.push(peak);
      }
      resolve(peaks.map((p) => Math.max(0.04, Math.min(1, Math.round((p / maxPeak) * 100) / 100))));
    });
  });
}

const filmstripInFlight = new Map<string, Promise<FilmstripFrame[]>>();

export async function extractVideoFilmstrip(
  filePath: string,
  projectId: string,
  durationSeconds: number,
  targetFrames?: number
): Promise<FilmstripFrame[]> {
  if (!fs.existsSync(filePath)) return [];
  const stat = fs.statSync(filePath);
  const safeDur = Math.max(0.5, durationSeconds || 12);
  const desiredCount = Math.min(
    32,
    Math.max(8, targetFrames || Math.ceil(Math.min(28, safeDur * 1.6)))
  );
  const hash = crypto
    .createHash('sha1')
    .update(`${filePath}:${stat.size}:${Math.floor(stat.mtimeMs)}:${desiredCount}`)
    .digest('hex')
    .slice(0, 12);
  const dirName = `filmstrip_${projectId.slice(0, 8)}_${hash}`;
  const outDir = path.join(THUMBS_DIR, dirName);
  const manifestPath = path.join(outDir, 'manifest.json');

  if (fs.existsSync(manifestPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as FilmstripFrame[];
      if (Array.isArray(cached) && cached.length > 0) {
        return cached;
      }
    } catch {
      // regenerate below
    }
  }

  const inflightKey = `${projectId}:${hash}`;
  const existing = filmstripInFlight.get(inflightKey);
  if (existing) return existing;

  const task = (async () => {
    try {
      fs.mkdirSync(outDir, { recursive: true });
      const fps = desiredCount / safeDur;
      const outPattern = path.join(outDir, 'frame_%03d.jpg');
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-i',
          filePath,
          '-vf',
          `fps=${fps.toFixed(5)},scale=160:-2`,
          '-frames:v',
          String(desiredCount),
          '-q:v',
          '5',
          outPattern,
        ],
        { timeout: 45000 }
      );

      const files = fs
        .readdirSync(outDir)
        .filter((f) => f.startsWith('frame_') && f.endsWith('.jpg'))
        .sort();

      if (files.length === 0) return [];
      const frames: FilmstripFrame[] = files.map((file, idx) => ({
        url: `/media/thumbs/${dirName}/${file}`,
        time: Number(((idx / Math.max(1, files.length)) * safeDur).toFixed(3)),
      }));
      fs.writeFileSync(manifestPath, JSON.stringify(frames));
      return frames;
    } catch {
      return [];
    } finally {
      filmstripInFlight.delete(inflightKey);
    }
  })();

  filmstripInFlight.set(inflightKey, task);
  return task;
}

const waveformCache = new Map<string, number[]>();

export async function extractAudioPeaksCached(
  filePath: string,
  targetBins = 96
): Promise<number[]> {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const stat = fs.statSync(filePath);
  const cacheKey = `${filePath}:${stat.size}:${Math.floor(stat.mtimeMs)}:${targetBins}`;
  const memHit = waveformCache.get(cacheKey);
  if (memHit) return memHit;

  const hash = crypto.createHash('sha1').update(cacheKey).digest('hex').slice(0, 14);
  const diskPath = path.join(THUMBS_DIR, `peaks_${hash}.json`);
  if (fs.existsSync(diskPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(diskPath, 'utf-8')) as number[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        waveformCache.set(cacheKey, parsed);
        return parsed;
      }
    } catch {
      // regenerate
    }
  }

  const peaks = await extractWaveformPeaks(filePath, true, targetBins).catch(() => []);
  if (peaks.length > 0) {
    waveformCache.set(cacheKey, peaks);
    try {
      fs.writeFileSync(diskPath, JSON.stringify(peaks));
    } catch {
      // ignore disk write error
    }
  }
  return peaks;
}

export async function createDemoMovieRecapClip(projectId: string): Promise<{
  filePath: string;
  filename: string;
  url: string;
}> {
  const filename = `sample_recap_${projectId.slice(0, 8)}.mp4`;
  const videoPath = path.join(UPLOADS_DIR, filename);

  // Synthesize a 12-second 1280x720 cinematic motion scene with moving tracked subject
  // and optionally Gemini-generated narration audio (or clean synthesized tone if no key)
  const audioTempPath = path.join(THUMBS_DIR, `narration_${projectId.slice(0, 8)}.wav`);
  let hasNarration = false;

  if (isGeminiConfigured()) {
    try {
      const ai = getGeminiClient();
      const ttsResp = await ai.models.generateContent({
        model: 'gemini-3.8-flash-lite-tts',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: 'In the dead of night, Detective Marcus steps into the abandoned observatory. Little does he know the vault has already been opened.',
                speechMetadata: {
                  style: 'Suspenseful cinematic movie recap narrator',
                },
              },
            ],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Charon' },
            },
          },
        },
      });
      const b64 = ttsResp.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (b64) {
        fs.writeFileSync(audioTempPath, Buffer.from(b64, 'base64'));
        hasNarration = true;
      }
    } catch {
      hasNarration = false;
    }
  }

  // Generate animated cinema-grade backdrop + moving target box so motion tracking & blur demos work genuinely
  const videoFilter =
    "color=c=#0d1020:s=1280x720:d=12,format=yuv420p," +
    "drawbox=x='160+420*sin(t*0.65)^2':y='210+120*cos(t*0.9)^2':w=220:h=260:color=#7c3aed@0.9:t=fill," +
    "drawbox=x='185+420*sin(t*0.65)^2':y='235+120*cos(t*0.9)^2':w=170:h=210:color=#f4f4f5@0.95:t=4," +
    "drawbox=x=80:y=60:w=260:h=70:color=#18181b@0.85:t=fill," +
    "drawbox=x=920:y=560:w=280:h=90:color=#18181b@0.85:t=fill";

  const args: string[] = ['-y', '-f', 'lavfi', '-i', videoFilter];

  if (hasNarration && fs.existsSync(audioTempPath)) {
    args.push('-i', audioTempPath);
    args.push(
      '-filter_complex',
      '[1:a]apad=whole_dur=12[aout]',
      '-map',
      '0:v',
      '-map',
      '[aout]',
      '-t',
      '12',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      videoPath
    );
  } else {
    args.push(
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:duration=12,volume=0.08',
      '-t',
      '12',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      videoPath
    );
  }

  await execFileAsync('ffmpeg', args);
  if (fs.existsSync(audioTempPath)) {
    fs.unlinkSync(audioTempPath);
  }

  const stat = fs.statSync(videoPath);
  const url = `/media/uploads/${filename}`;
  registerAsset({
    id: uuidv4(),
    projectId,
    kind: 'video',
    filename,
    filePath: videoPath,
    url,
    mimeType: 'video/mp4',
    sizeBytes: stat.size,
  });

  return { filePath: videoPath, filename, url };
}
