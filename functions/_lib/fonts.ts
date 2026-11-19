import {
  BUILTIN_FONT_CATALOG,
  resolveClosestSupportedWeight,
} from '../../src/lib/fontCatalogData.ts';
import { listCustomFonts } from './d1.ts';
import { readBinaryAssetBytes, saveBinaryAsset } from './storage.ts';
import type { Env } from './types.ts';

export interface EnsureFontResult {
  available: boolean;
  family: string;
  resolvedWeight: number;
  italic: boolean;
  url?: string;
  remoteTtfUrl?: string;
  source?: 'builtin' | 'custom' | 'system';
  exportCompatible?: boolean;
  error?: string;
}

function slugifyFont(family: string): string {
  return family.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function isValidSfntBytes(buf: Uint8Array): boolean {
  if (buf.length < 12) return false;
  const sigAscii = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
  const is00010000 = buf[0] === 0x00 && buf[1] === 0x01 && buf[2] === 0x00 && buf[3] === 0x00;
  return is00010000 || sigAscii === 'true' || sigAscii === 'OTTO' || sigAscii === 'ttcf';
}

async function fetchGoogleFontTtf(
  env: Env,
  family: string,
  weight: number,
  italic: boolean
): Promise<{ url: string; remoteTtfUrl: string } | null> {
  const slug = slugifyFont(family);
  const filename = `builtin_${slug}_w${weight}${italic ? '_i' : ''}.ttf`;
  const mediaUrl = `/media/fonts/${filename}`;

  // Check if already cached in R2 or D1 media_blobs
  const cached = await readBinaryAssetBytes(env, mediaUrl).catch(() => null);
  if (cached && cached.bytes.byteLength > 1024) {
    return { url: mediaUrl, remoteTtfUrl: mediaUrl };
  }

  const familyQuery = encodeURIComponent(family).replace(/%20/g, '+');
  const cssUrl = italic
    ? `https://fonts.googleapis.com/css2?family=${familyQuery}:ital,wght@1,${weight}&display=swap`
    : `https://fonts.googleapis.com/css2?family=${familyQuery}:wght@${weight}&display=swap`;

  try {
    const cssResp = await fetch(cssUrl, {
      headers: { 'User-Agent': 'Wget/1.21.1' },
    });
    if (!cssResp.ok) return null;
    const cssText = await cssResp.text();
    const matches = Array.from(cssText.matchAll(/url\((https:\/\/[^)]+\.ttf)\)/g));
    if (matches.length === 0) return null;

    const ttfUrl = matches[matches.length - 1][1];
    const ttfResp = await fetch(ttfUrl);
    if (!ttfResp.ok) return null;
    const bytes = new Uint8Array(await ttfResp.arrayBuffer());
    if (!isValidSfntBytes(bytes)) return null;

    const saved = await saveBinaryAsset(env, {
      projectId: null,
      kind: 'font',
      bucket: 'fonts',
      filename,
      mimeType: 'font/ttf',
      bytes,
    });

    // Note: if font > 700 KB and R2 isn't bound, return direct Google Fonts CDN TTF URL so browser WASM can still fetch it cleanly!
    return {
      url: saved.storedIn === 'client-only' ? ttfUrl : saved.url,
      remoteTtfUrl: ttfUrl,
    };
  } catch {
    return null;
  }
}

export async function ensureFontAvailableEdge(
  env: Env,
  params: { family: string; weight?: number; italic?: boolean }
): Promise<EnsureFontResult> {
  const family = (params.family || '').trim();
  const desiredWeight = Math.max(100, Math.min(900, Math.round(params.weight || 700)));
  const italic = Boolean(params.italic);

  if (!family) {
    return {
      available: false,
      family: '',
      resolvedWeight: desiredWeight,
      italic,
      error: 'No font family provided.',
    };
  }

  // 1. Check custom uploaded fonts in D1
  if (env.DB) {
    const customFonts = await listCustomFonts(env.DB);
    const customMatch = customFonts.find((f) => f.family.toLowerCase() === family.toLowerCase());
    if (customMatch) {
      const extOk = !/\.woff2?$/i.test(customMatch.filename);
      return {
        available: true,
        family: customMatch.family,
        resolvedWeight: desiredWeight,
        italic,
        url: customMatch.url,
        source: 'custom',
        exportCompatible: extOk,
      };
    }
  }

  // 2. Built-in Google Fonts catalog
  const catalogEntry = BUILTIN_FONT_CATALOG.find(
    (f) => f.family.toLowerCase() === family.toLowerCase()
  );
  const resolvedWeight = catalogEntry
    ? resolveClosestSupportedWeight(catalogEntry.family, desiredWeight)
    : desiredWeight;
  const resolvedItalic = catalogEntry ? italic && catalogEntry.supportsItalic : italic;

  if (catalogEntry && catalogEntry.family !== 'Impact') {
    const fetched = await fetchGoogleFontTtf(env, catalogEntry.family, resolvedWeight, resolvedItalic);
    if (fetched) {
      return {
        available: true,
        family: catalogEntry.family,
        resolvedWeight,
        italic: resolvedItalic,
        url: fetched.url,
        remoteTtfUrl: fetched.remoteTtfUrl,
        source: 'builtin',
        exportCompatible: true,
      };
    }
    if (resolvedItalic) {
      const fallback = await fetchGoogleFontTtf(env, catalogEntry.family, resolvedWeight, false);
      if (fallback) {
        return {
          available: true,
          family: catalogEntry.family,
          resolvedWeight,
          italic: false,
          url: fallback.url,
          remoteTtfUrl: fallback.remoteTtfUrl,
          source: 'builtin',
          exportCompatible: true,
        };
      }
    }
  }

  return {
    available: false,
    family,
    resolvedWeight,
    italic,
    exportCompatible: false,
    error:
      family.toLowerCase() === 'impact'
        ? 'Impact font is not installed on edge servers. Upload Impact.ttf or choose Anton / Archivo Black.'
        : `Font file for "${family}" (${resolvedWeight}) could not be loaded.`,
  };
}
