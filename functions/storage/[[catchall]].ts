import { optionsResponse } from '../_lib/http.ts';
import { serveMediaKey } from '../_lib/storage.ts';
import type { Env } from '../_lib/types.ts';

export const onRequest = async (context: {
  request: Request;
  env: Env;
  params: { catchall?: string[] | string };
}): Promise<Response> => {
  const { request, env, params } = context;

  if (request.method === 'OPTIONS') {
    return optionsResponse(request);
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const rawParts = Array.isArray(params.catchall)
    ? params.catchall
    : typeof params.catchall === 'string'
    ? params.catchall.split('/').filter(Boolean)
    : [];

  const url = new URL(request.url);
  const key =
    rawParts.length > 0
      ? rawParts.join('/')
      : url.pathname.replace(/^\/storage\//, '');

  if (key) {
    const served = await serveMediaKey(env, request, key);
    if (served) return served;
  }

  const backendBase = (env.BACKEND_URL || env.VITE_API_BASE_URL || env.API_URL || '').replace(
    /\/+$/,
    ''
  );
  if (backendBase) {
    try {
      const upstream = await fetch(`${backendBase}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        redirect: 'follow',
      });
      const headers = new Headers(upstream.headers);
      headers.set('Access-Control-Allow-Origin', request.headers.get('Origin') || '*');
      headers.set(
        'Access-Control-Expose-Headers',
        'Content-Length, Content-Range, Accept-Ranges, Content-Disposition'
      );
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } catch {
      return new Response('Failed to reach upstream storage server', { status: 502 });
    }
  }

  return new Response('Storage asset not found', { status: 404 });
};
