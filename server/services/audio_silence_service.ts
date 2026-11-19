import { execFile } from 'child_process';
import fs from 'fs';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface SilenceInterval {
  start: number;
  end: number;
  duration: number;
}

export interface AudioSilenceAnalysis {
  duration: number;
  meanVolumeDb: number | null;
  maxVolumeDb: number | null;
  noiseThresholdDb: number;
  leadingSilence: number;
  trailingSilence: number;
  speechStartOffset: number;
  speechEndOffset: number;
  speechDuration: number;
  silenceIntervals: SilenceInterval[];
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export async function probeAudioDurationExact(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'quiet',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const val = Number(stdout.trim());
  return Number.isFinite(val) && val > 0 ? round3(val) : 0;
}

/**
 * Uses FFmpeg `volumedetect` + `silencedetect` to measure exact leading silence,
 * trailing silence, internal gaps, and true speech boundaries without mistaking
 * quiet spoken consonants for silence.
 */
export async function analyzeAudioFileSilence(
  filePath: string,
  options?: { minSilenceDurationSec?: number; safetyMarginSec?: number }
): Promise<AudioSilenceAnalysis> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Audio file does not exist: ${filePath}`);
  }

  const duration = Math.max(0.05, await probeAudioDurationExact(filePath));
  const minDur = options?.minSilenceDurationSec ?? 0.06;
  const safetyMargin = options?.safetyMarginSec ?? 0.06;

  // Step 1: Measure volume floor so quiet speech is never treated as silence
  let meanVolumeDb: number | null = null;
  let maxVolumeDb: number | null = null;
  try {
    const { stderr } = await execFileAsync('ffmpeg', [
      '-i',
      filePath,
      '-af',
      'volumedetect',
      '-f',
      'null',
      '-',
    ]);
    const meanMatch = stderr.match(/mean_volume:\s*([-\d.]+)\s*dB/i);
    const maxMatch = stderr.match(/max_volume:\s*([-\d.]+)\s*dB/i);
    if (meanMatch) meanVolumeDb = Number(meanMatch[1]);
    if (maxMatch) maxVolumeDb = Number(maxMatch[1]);
  } catch {
    // fallback to default threshold
  }

  // Adaptive threshold: keep at least 26 dB below mean speech level, clamped between -55 dB and -38 dB
  const adaptiveThreshold =
    meanVolumeDb !== null && Number.isFinite(meanVolumeDb)
      ? Math.max(-55, Math.min(-38, Math.round(meanVolumeDb - 26)))
      : -44;

  // Step 2: Detect silence intervals via FFmpeg silencedetect
  const silenceIntervals: SilenceInterval[] = [];
  try {
    const { stderr } = await execFileAsync('ffmpeg', [
      '-i',
      filePath,
      '-af',
      `silencedetect=noise=${adaptiveThreshold}dB:d=${minDur.toFixed(2)}`,
      '-f',
      'null',
      '-',
    ]);

    let pendingStart: number | null = null;
    for (const line of stderr.split('\n')) {
      const startMatch = line.match(/silence_start:\s*([\d.]+)/);
      if (startMatch) {
        pendingStart = Number(startMatch[1]);
        continue;
      }
      const endMatch = line.match(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/);
      if (endMatch) {
        const end = Number(endMatch[1]);
        const dur = Number(endMatch[2]);
        const start = pendingStart !== null ? pendingStart : Math.max(0, end - dur);
        silenceIntervals.push({
          start: round3(start),
          end: round3(end),
          duration: round3(dur),
        });
        pendingStart = null;
      }
    }

    // Handle trailing silence reaching EOF without explicit silence_end
    if (pendingStart !== null && pendingStart < duration) {
      silenceIntervals.push({
        start: round3(pendingStart),
        end: round3(duration),
        duration: round3(Math.max(0, duration - pendingStart)),
      });
    }
  } catch {
    // if silencedetect fails, assume full file is speech
  }

  let leadingSilence = 0;
  let trailingSilence = 0;

  if (silenceIntervals.length > 0) {
    const first = silenceIntervals[0];
    if (first.start <= 0.04) {
      leadingSilence = Math.min(duration * 0.8, first.end);
    }

    const last = silenceIntervals[silenceIntervals.length - 1];
    if (last.end >= duration - 0.05 && last.start > leadingSilence) {
      trailingSilence = Math.min(duration - leadingSilence, Math.max(0, duration - last.start));
    }
  }

  // Apply safety margins so soft consonants, breaths, and sentence endings are never clipped
  const safeStart = Math.max(0, round3(leadingSilence - safetyMargin));
  const safeEnd = Math.min(
    duration,
    round3(duration - Math.max(0, trailingSilence - safetyMargin))
  );

  // Guard: never let safeEnd collapse onto safeStart
  const validRange = safeEnd - safeStart >= Math.min(0.12, duration * 0.5);
  const speechStartOffset = validRange ? safeStart : 0;
  const speechEndOffset = validRange ? safeEnd : duration;
  const speechDuration = round3(Math.max(0.05, duration - leadingSilence - trailingSilence));

  return {
    duration: round3(duration),
    meanVolumeDb,
    maxVolumeDb,
    noiseThresholdDb: adaptiveThreshold,
    leadingSilence: round3(leadingSilence),
    trailingSilence: round3(trailingSilence),
    speechStartOffset,
    speechEndOffset,
    speechDuration,
    silenceIntervals,
  };
}

/**
 * Safely trims ONLY unnecessary leading and trailing silence outside [speechStartOffset, speechEndOffset]
 * using FFmpeg `atrim` + 15ms micro-fades. Internal pauses inside sentences are NEVER modified.
 */
export async function trimAudioEdgeSilenceSafely(params: {
  inputPath: string;
  outputPath: string;
  analysis?: AudioSilenceAnalysis;
}): Promise<{ analysisAfterTrim: AudioSilenceAnalysis; trimmedSec: number }> {
  const analysis =
    params.analysis || (await analyzeAudioFileSilence(params.inputPath));

  const trimBefore = analysis.speechStartOffset;
  const trimAfter = Math.max(0, analysis.duration - analysis.speechEndOffset);
  const trimmedSec = round3(trimBefore + trimAfter);

  const canTrim =
    (trimBefore >= 0.05 || trimAfter >= 0.05) &&
    analysis.speechEndOffset - analysis.speechStartOffset >= 0.12;

  if (!canTrim) {
    if (params.inputPath !== params.outputPath) {
      fs.copyFileSync(params.inputPath, params.outputPath);
    }
    return { analysisAfterTrim: analysis, trimmedSec: 0 };
  }

  const clipLen = Math.max(0.12, analysis.speechEndOffset - analysis.speechStartOffset);
  const fadeOutStart = Math.max(0, clipLen - 0.015);

  await execFileAsync('ffmpeg', [
    '-y',
    '-i',
    params.inputPath,
    '-af',
    `atrim=start=${analysis.speechStartOffset.toFixed(3)}:end=${analysis.speechEndOffset.toFixed(
      3
    )},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.015,afade=t=out:st=${fadeOutStart.toFixed(
      3
    )}:d=0.015`,
    '-ar',
    '44100',
    '-ac',
    '2',
    '-codec:a',
    'libmp3lame',
    '-b:a',
    '192k',
    params.outputPath,
  ]);

  const afterAnalysis = await analyzeAudioFileSilence(params.outputPath);
  return { analysisAfterTrim: afterAnalysis, trimmedSec };
}

/**
 * Diagnostic helper for inspecting a full assembled audio track (e.g. an uploaded 112s dub)
 * to report all long silent gaps and speech vs total track duration.
 */
export async function diagnoseFullNarrationTrackSilences(
  filePath: string,
  minLongGapSec = 0.6
): Promise<{
  totalTrackDuration: number;
  totalSilenceDuration: number;
  estimatedSpeechDuration: number;
  longGaps: SilenceInterval[];
}> {
  const analysis = await analyzeAudioFileSilence(filePath, {
    minSilenceDurationSec: minLongGapSec,
    safetyMarginSec: 0,
  });
  const longGaps = analysis.silenceIntervals.filter((g) => g.duration >= minLongGapSec);
  const totalSilenceDuration = round3(
    longGaps.reduce((sum, g) => sum + g.duration, 0)
  );
  const estimatedSpeechDuration = round3(
    Math.max(0, analysis.duration - totalSilenceDuration)
  );
  return {
    totalTrackDuration: analysis.duration,
    totalSilenceDuration,
    estimatedSpeechDuration,
    longGaps,
  };
}
