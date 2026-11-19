import { GoogleGenAI } from '@google/genai';

export function isGeminiConfigured(): boolean {
  const key = process.env.GEMINI_API_KEY;
  return Boolean(key && key.trim().length > 0 && key !== 'MY_GEMINI_API_KEY');
}

export function getGeminiClient(apiVersion: 'v1' | 'v1beta' = 'v1beta'): GoogleGenAI {
  if (!isGeminiConfigured()) {
    const err = new Error(
      'GEMINI_API_KEY is not configured on the server. Add GEMINI_API_KEY in the Settings > Secrets panel to enable AI transcription, translation, and voice generation.'
    );
    (err as Error & { statusCode?: number }).statusCode = 503;
    throw err;
  }

  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    apiVersion,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}
