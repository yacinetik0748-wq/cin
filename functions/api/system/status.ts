import { resolveFishApiKey } from '../../_lib/crypto.ts';
import { jsonResponse, optionsResponse } from '../../_lib/http.ts';
import type { Env } from '../../_lib/types.ts';

export const onRequest = async (context: {
  request: Request;
  env: Env;
}): Promise<Response> => {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return optionsResponse(request);

  const hasD1 = Boolean(env.DB);
  const fishResolved = await resolveFishApiKey(env);
  return jsonResponse(
    {
      geminiConfigured: Boolean(env.GEMINI_API_KEY && env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
      fishConfigured: Boolean(fishResolved.apiKey),
      ffmpegAvailable: false,
      ffprobeAvailable: false,
      ffmpegVersion: 'ffmpeg.wasm (browser)',
      storageDir: !hasD1
        ? 'Browser IndexedDB (Local Only)'
        : env.MEDIA_BUCKET
        ? 'Cloudflare D1 + R2'
        : 'Cloudflare D1 + IndexedDB',
      storageMode: !hasD1 ? 'local-indexeddb' : 'cloudflare-d1',
      localOnly: !hasD1,
      maxUploadSizeMb: Number(env.MAX_UPLOAD_SIZE_MB || '1500'),
      tempRetentionHours: Number(env.TEMP_RETENTION_HOURS || '24'),
      supportedVideoFormats: ['MP4', 'MOV', 'MKV', 'WEBM'],
      supportedLogoFormats: ['PNG', 'SVG', 'JPG', 'WEBP'],
      runtime: 'cloudflare-pages',
      databaseConfigured: hasD1,
      d1Available: hasD1,
      r2Available: Boolean(env.MEDIA_BUCKET),
      clientProcessingAvailable: true,
    },
    200,
    request
  );
};
