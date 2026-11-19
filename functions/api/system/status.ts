import { resolveFishApiKey } from '../../_lib/crypto.ts';
import { jsonResponse, optionsResponse } from '../../_lib/http.ts';
import type { Env } from '../../_lib/types.ts';

export const onRequest = async (context: {
  request: Request;
  env: Env;
}): Promise<Response> => {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return optionsResponse(request);

  const fishResolved = await resolveFishApiKey(env);
  return jsonResponse(
    {
      geminiConfigured: Boolean(env.GEMINI_API_KEY && env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
      fishConfigured: Boolean(fishResolved.apiKey),
      ffmpegAvailable: false,
      ffprobeAvailable: false,
      ffmpegVersion: 'ffmpeg.wasm (browser)',
      storageDir: env.MEDIA_BUCKET ? 'Cloudflare D1 + R2' : 'Cloudflare D1 + IndexedDB',
      maxUploadSizeMb: Number(env.MAX_UPLOAD_SIZE_MB || '1500'),
      tempRetentionHours: Number(env.TEMP_RETENTION_HOURS || '24'),
      supportedVideoFormats: ['MP4', 'MOV', 'MKV', 'WEBM'],
      supportedLogoFormats: ['PNG', 'SVG', 'JPG', 'WEBP'],
      runtime: 'cloudflare-pages',
      d1Available: Boolean(env.DB),
      r2Available: Boolean(env.MEDIA_BUCKET),
      clientProcessingAvailable: true,
    },
    200,
    request
  );
};
