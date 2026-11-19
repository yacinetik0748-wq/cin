import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import {
  CaptionSegment,
  GeminiVoiceName,
  GeneratedVoiceClip,
  SupportedLanguage,
  VoiceConfig,
} from '../../src/types/studio.ts';
import { AUDIO_DIR, TEMP_DIR, registerAsset } from '../db.ts';
import { getGeminiClient } from './gemini_client.ts';

const execFileAsync = promisify(execFile);

export async function generateSingleVoicePreview(params: {
  projectId: string;
  text: string;
  voiceName: GeminiVoiceName;
  style: string;
  targetLanguage: SupportedLanguage;
  speakingSpeed: number;
}): Promise<{ audioUrl: string; filePath: string }> {
  const ai = getGeminiClient();
  const finalName = `voice_preview_${params.projectId.slice(0, 8)}_${Date.now()}.wav`;
  const finalWav = path.join(AUDIO_DIR, finalName);

  const response = await ai.models.generateContent({
    model: 'gemini-3.8-flash-lite-tts',
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: params.text,
            speechMetadata: {
              style: `${params.style} (Spoken in ${params.targetLanguage})`,
            },
          },
        ],
      },
    ],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: params.voiceName },
        },
      },
    },
  });

  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64Audio) {
    throw new Error('Gemini TTS returned no audio payload.');
  }

  fs.writeFileSync(finalWav, Buffer.from(base64Audio, 'base64'));

  const stat = fs.statSync(finalWav);
  const audioUrl = `/media/audio/${finalName}`;
  registerAsset({
    id: uuidv4(),
    projectId: params.projectId,
    kind: 'audio',
    filename: finalName,
    filePath: finalWav,
    url: audioUrl,
    mimeType: 'audio/wav',
    sizeBytes: stat.size,
  });

  return { audioUrl, filePath: finalWav };
}

export async function generateSynchronizedVoiceover(params: {
  projectId: string;
  captions: CaptionSegment[];
  voiceConfig: VoiceConfig;
  useTranslated: boolean;
  totalDuration: number;
}): Promise<{ clips: GeneratedVoiceClip[]; fullDubUrl: string; fullDubPath: string }> {
  if (!params.captions || params.captions.length === 0) {
    throw new Error('No caption segments found. Generate or add captions before generating voiceover.');
  }

  const ai = getGeminiClient();
  const clips: GeneratedVoiceClip[] = [];
  const clipPaths: Array<{ path: string; startMs: number; maxDuration: number }> = [];

  for (const seg of params.captions) {
    const spokenText = (params.useTranslated && seg.translatedText ? seg.translatedText : seg.text).trim();
    if (!spokenText) continue;

    const rawWav = path.join(TEMP_DIR, `seg_raw_${seg.id}_${Date.now()}.wav`);
    const clipFilename = `dub_seg_${params.projectId.slice(0, 8)}_${seg.id.slice(0, 8)}_${Date.now()}.wav`;
    const clipPath = path.join(AUDIO_DIR, clipFilename);

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash-lite-tts',
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: spokenText,
              speechMetadata: {
                style: `${params.voiceConfig.style}. Spoken in ${params.voiceConfig.targetLanguage}.`,
              },
            },
          ],
        },
      ],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: params.voiceConfig.voiceName },
          },
        },
      },
    });

    const b64 = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!b64) {
      throw new Error(`TTS generation failed for segment "${spokenText.slice(0, 40)}..."`);
    }
    fs.writeFileSync(rawWav, Buffer.from(b64, 'base64'));

    // Constant 1.0x speed: never apply automatic time-stretching or atempo
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'quiet',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      rawWav,
    ]);
    const rawDur = Math.max(0.1, Number(stdout.trim()) || 1);
    const slotDur = Math.max(0.2, seg.end - seg.start);
    const overflowSec = rawDur > slotDur + 0.15 ? Math.round((rawDur - slotDur) * 100) / 100 : 0;

    await execFileAsync('ffmpeg', ['-y', '-i', rawWav, '-ar', '24000', '-ac', '1', clipPath]);
    fs.unlinkSync(rawWav);

    const stat = fs.statSync(clipPath);
    const clipUrl = `/media/audio/${clipFilename}`;
    registerAsset({
      id: uuidv4(),
      projectId: params.projectId,
      kind: 'audio',
      filename: clipFilename,
      filePath: clipPath,
      url: clipUrl,
      mimeType: 'audio/wav',
      sizeBytes: stat.size,
    });

    clips.push({
      segmentId: seg.id,
      audioUrl: clipUrl,
      start: seg.start,
      end: seg.end,
      duration: Math.round(rawDur * 100) / 100,
      slotDuration: Math.round(slotDur * 100) / 100,
      overflowSeconds: overflowSec,
      text: spokenText,
    });
    clipPaths.push({
      path: clipPath,
      startMs: Math.max(0, Math.round(seg.start * 1000)),
      maxDuration: slotDur,
    });
  }

  if (clipPaths.length === 0) {
    throw new Error('No valid spoken text found in caption segments.');
  }

  // Merge all clips onto a single synchronized timeline WAV track
  const fullDubName = `full_dub_${params.projectId.slice(0, 8)}_${Date.now()}.wav`;
  const fullDubPath = path.join(AUDIO_DIR, fullDubName);

  const inputs: string[] = ['-y'];
  const filters: string[] = [];
  const mixInputs: string[] = [];

  clipPaths.forEach((c, idx) => {
    inputs.push('-i', c.path);
    filters.push(`[${idx}:a]adelay=${c.startMs}|${c.startMs},apad=whole_dur=${params.totalDuration.toFixed(2)}[d${idx}]`);
    mixInputs.push(`[d${idx}]`);
  });

  filters.push(
    `${mixInputs.join('')}amix=inputs=${clipPaths.length}:duration=longest:normalize=0,apad=whole_dur=${params.totalDuration.toFixed(2)}[outa]`
  );

  await execFileAsync('ffmpeg', [
    ...inputs,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[outa]',
    '-t',
    params.totalDuration.toFixed(2),
    '-ar',
    '44100',
    '-ac',
    '2',
    fullDubPath,
  ]);

  const dubStat = fs.statSync(fullDubPath);
  const fullDubUrl = `/media/audio/${fullDubName}`;
  registerAsset({
    id: uuidv4(),
    projectId: params.projectId,
    kind: 'audio',
    filename: fullDubName,
    filePath: fullDubPath,
    url: fullDubUrl,
    mimeType: 'audio/wav',
    sizeBytes: dubStat.size,
  });

  return { clips, fullDubUrl, fullDubPath };
}
