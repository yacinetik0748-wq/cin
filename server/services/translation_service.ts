import { Type } from '@google/genai';
import { CaptionSegment, SupportedLanguage } from '../../src/types/studio.ts';
import { getGeminiClient } from './gemini_client.ts';
import { distributeWordsEvenly } from './transcription_service.ts';

export async function translateCaptionsWithGemini(params: {
  captions: CaptionSegment[];
  sourceLanguage: string;
  targetLanguage: SupportedLanguage;
  preserveProperNouns: boolean;
}): Promise<CaptionSegment[]> {
  if (!params.captions || params.captions.length === 0) {
    throw new Error('No caption segments available to translate. Generate or add captions first.');
  }

  const ai = getGeminiClient();

  const payload = params.captions.map((c) => ({
    id: c.id,
    start: c.start,
    end: c.end,
    text: c.text,
  }));

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: `Translate the following movie recap subtitle segments from ${params.sourceLanguage} into ${params.targetLanguage}.
Rules:
1. Preserve the complete meaning, story facts, chronology, and dramatic tone. Improve wording naturally in ${params.targetLanguage}, but do NOT force unnecessary shortening or omit important details to match original segment length. If tightening is ever needed for flow, retain 100% of essential information.
2. ${params.preserveProperNouns ? 'Do NOT translate character names, actor names, movie titles, key locations, or iconic movie terminology; transliterate only if writing script requires it (e.g. Arabic/Hindi) while keeping the name recognizable.' : 'Preserve key character names and major locations accurately while translating naturally.'}
3. Keep each segment aligned to its exact id and timing; return one translated entry per input segment.
Input segments JSON:
${JSON.stringify(payload)}`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          translations: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING },
                translatedText: { type: Type.STRING },
              },
              required: ['id', 'translatedText'],
            },
          },
        },
        required: ['translations'],
      },
    },
  });

  const parsed = JSON.parse((response.text || '{}').trim()) as {
    translations?: Array<{ id: string; translatedText: string }>;
  };

  const map = new Map<string, string>();
  for (const item of parsed.translations || []) {
    map.set(item.id, item.translatedText.trim());
  }

  return params.captions.map((seg) => {
    const translatedText = map.get(seg.id) || seg.translatedText || seg.text;
    return {
      ...seg,
      translatedText,
      words: distributeWordsEvenly(translatedText, seg.start, seg.end),
    };
  });
}
