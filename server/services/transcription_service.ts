import { Type } from '@google/genai';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import { CaptionSegment } from '../../src/types/studio.ts';
import { AUDIO_DIR, TEMP_DIR } from '../db.ts';
import { getGeminiClient } from './gemini_client.ts';

const execFileAsync = promisify(execFile);

export async function extractAudioTrack(
  videoPath: string,
  projectId: string,
  format: 'mp3' | 'wav' = 'mp3'
): Promise<string> {
  const outPath = path.join(AUDIO_DIR, `extracted_${projectId.slice(0, 8)}_${Date.now()}.${format}`);
  const args =
    format === 'mp3'
      ? ['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', outPath]
      : ['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', outPath];
  await execFileAsync('ffmpeg', args);
  return outPath;
}

export async function transcribeVideoWithGemini(params: {
  videoPath: string;
  projectId: string;
  duration: number;
  hasAudio: boolean;
}): Promise<{ segments: CaptionSegment[]; detectedLanguage: string }> {
  if (!params.hasAudio) {
    throw new Error('The uploaded video does not contain an audio track to transcribe.');
  }

  const ai = getGeminiClient();
  const tempAudio = path.join(TEMP_DIR, `stt_${params.projectId}_${Date.now()}.mp3`);

  try {
    // Extract compact 16kHz mono MP3 so even 20-30 min videos fit cleanly within inline/file payload limits
    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      params.videoPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '32k',
      tempAudio,
    ]);

    const audioBytes = fs.readFileSync(tempAudio);
    const audioBase64 = audioBytes.toString('base64');

    // Step 1: High-accuracy verbatim transcript using gemini-3.5-transcribe (with fallback)
    let rawTranscript = '';
    try {
      const transcribeResp = await ai.models.generateContent({
        model: 'gemini-3.5-transcribe',
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: 'audio/mp3',
                data: audioBase64,
              },
            },
            {
              text: 'Transcribe all spoken narration and dialogue accurately.',
            },
          ],
        },
      });
      rawTranscript = (transcribeResp.text || '').trim();
    } catch {
      rawTranscript = '';
    }

    // Step 2: Generate precise timestamped segments and word timings via gemini-4-hydrogen audio+transcript alignment
    const alignedResp = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: 'audio/mp3',
              data: audioBase64,
            },
          },
          {
            text: `You are a professional subtitle timing engineer for movie recap videos.
Audio duration is ${params.duration.toFixed(2)} seconds.
Reference verbatim transcript:
"""
${rawTranscript}
"""
Produce accurate sentence-level caption segments covering the spoken audio, with start/end timestamps in seconds (strictly between 0 and ${params.duration.toFixed(2)}), plus word-level start/end timestamps for each word in every segment. Also detect the primary spoken language name (e.g. English, Arabic, French, Spanish, German, Portuguese, Italian, Turkish, Hindi).`,
          },
        ],
      },
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            detectedLanguage: { type: Type.STRING },
            segments: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  start: { type: Type.NUMBER },
                  end: { type: Type.NUMBER },
                  text: { type: Type.STRING },
                  words: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        word: { type: Type.STRING },
                        start: { type: Type.NUMBER },
                        end: { type: Type.NUMBER },
                      },
                      required: ['word', 'start', 'end'],
                    },
                  },
                },
                required: ['start', 'end', 'text'],
              },
            },
          },
          required: ['detectedLanguage', 'segments'],
        },
      },
    });

    const jsonText = (alignedResp.text || '{}').trim();
    const parsed = JSON.parse(jsonText) as {
      detectedLanguage?: string;
      segments?: Array<{
        start: number;
        end: number;
        text: string;
        words?: Array<{ word: string; start: number; end: number }>;
      }>;
    };

    const segments: CaptionSegment[] = (parsed.segments || [])
      .filter((s) => s.text && s.text.trim().length > 0)
      .map((s) => {
        const start = Math.max(0, Math.min(params.duration, Number(s.start) || 0));
        const end = Math.max(start + 0.25, Math.min(params.duration, Number(s.end) || start + 2));
        const text = s.text.trim();
        const words =
          s.words && s.words.length > 0
            ? s.words.map((w) => ({
                word: w.word,
                start: Math.max(start, Math.min(end, Number(w.start) || start)),
                end: Math.max(start, Math.min(end, Number(w.end) || end)),
              }))
            : distributeWordsEvenly(text, start, end);
        return {
          id: uuidv4(),
          start: Math.round(start * 100) / 100,
          end: Math.round(end * 100) / 100,
          text,
          words,
        };
      });

    return {
      detectedLanguage: parsed.detectedLanguage || 'English',
      segments,
    };
  } finally {
    if (fs.existsSync(tempAudio)) {
      fs.unlinkSync(tempAudio);
    }
  }
}

export function distributeWordsEvenly(text: string, start: number, end: number) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const step = Math.max(0.05, (end - start) / tokens.length);
  return tokens.map((word, idx) => ({
    word,
    start: Math.round((start + idx * step) * 100) / 100,
    end: Math.round((start + (idx + 1) * step) * 100) / 100,
  }));
}
