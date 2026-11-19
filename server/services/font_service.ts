import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import {
  BUILTIN_FONT_CATALOG,
  resolveClosestSupportedWeight,
} from '../../src/lib/fontCatalog.ts';
import { FONTS_DIR, listCustomFonts } from '../db.ts';

const execFileAsync = promisify(execFile);

export interface EnsureFontResult {
  available: boolean;
  family: string;
  resolvedWeight: number;
  italic: boolean;
  url?: string;
  filePath?: string;
  source?: 'builtin' | 'custom' | 'system';
  exportCompatible?: boolean;
  error?: string;
}

function slugifyFont(family: string): string {
  return family.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function isValidSfntBuffer(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  const sigHex = buf.subarray(0, 4).toString('hex');
  const sigAscii = buf.subarray(0, 4).toString('ascii');
  // TTF (00010000 or 'true'), OTF ('OTTO'), TTC ('ttcf')
  return sigHex === '00010000' || sigAscii === 'true' || sigAscii === 'OTTO' || sigAscii === 'ttcf';
}

async function findExactSystemFont(family: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('fc-match', ['-f', '%{family}\t%{file}', family]);
    const [matchedFamilyRaw, filePathRaw] = stdout.trim().split('\t');
    if (!matchedFamilyRaw || !filePathRaw) return null;
    const matchedFamilies = matchedFamilyRaw.split(',').map((s) => s.trim().toLowerCase());
    const target = family.trim().toLowerCase();
    if (matchedFamilies.includes(target) && fs.existsSync(filePathRaw.trim())) {
      return filePathRaw.trim();
    }
  } catch {
    // fc-match unavailable
  }
  return null;
}

async function fetchGoogleFontTtf(
  family: string,
  weight: number,
  italic: boolean
): Promise<{ filePath: string; url: string } | null> {
  const slug = slugifyFont(family);
  const filename = `builtin_${slug}_w${weight}${italic ? '_i' : ''}.ttf`;
  const targetPath = path.join(FONTS_DIR, filename);
  const url = `/media/fonts/${filename}`;

  if (fs.existsSync(targetPath)) {
    const stat = fs.statSync(targetPath);
    if (stat.size > 1024) {
      return { filePath: targetPath, url };
    }
  }

  const familyQuery = encodeURIComponent(family).replace(/%20/g, '+');
  const cssUrl = italic
    ? `https://fonts.googleapis.com/css2?family=${familyQuery}:ital,wght@1,${weight}&display=swap`
    : `https://fonts.googleapis.com/css2?family=${familyQuery}:wght@${weight}&display=swap`;

  try {
    // Wget user-agent instructs Google Fonts CSS2 API to serve direct .ttf URLs compatible with libass/FFmpeg
    const cssResp = await fetch(cssUrl, {
      headers: {
        'User-Agent': 'Wget/1.21.1',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!cssResp.ok) return null;
    const cssText = await cssResp.text();

    // Find all url(...) entries and prefer the last @font-face (typically latin/arabic full block)
    const matches = Array.from(cssText.matchAll(/url\((https:\/\/[^)]+\.ttf)\)/g));
    if (matches.length === 0) return null;

    const ttfUrl = matches[matches.length - 1][1];
    const ttfResp = await fetch(ttfUrl, { signal: AbortSignal.timeout(15000) });
    if (!ttfResp.ok) return null;
    const arr = await ttfResp.arrayBuffer();
    const buf = Buffer.from(arr);
    if (!isValidSfntBuffer(buf)) return null;

    fs.mkdirSync(FONTS_DIR, { recursive: true });
    fs.writeFileSync(targetPath, buf);
    return { filePath: targetPath, url };
  } catch {
    return null;
  }
}

export async function ensureFontAvailable(params: {
  family: string;
  weight?: number;
  italic?: boolean;
}): Promise<EnsureFontResult> {
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

  // 1. Check custom uploaded fonts first
  const customFonts = listCustomFonts();
  const customMatch = customFonts.find(
    (f) => f.family.toLowerCase() === family.toLowerCase()
  );
  if (customMatch) {
    const filename = path.basename(customMatch.url);
    const localPath = path.join(FONTS_DIR, filename);
    if (fs.existsSync(localPath)) {
      const ext = path.extname(filename).toLowerCase();
      return {
        available: true,
        family: customMatch.family,
        resolvedWeight: desiredWeight,
        italic,
        url: customMatch.url,
        filePath: localPath,
        source: 'custom',
        exportCompatible: ext === '.ttf' || ext === '.otf',
      };
    }
    return {
      available: false,
      family: customMatch.family,
      resolvedWeight: desiredWeight,
      italic,
      source: 'custom',
      error: `Custom font file "${customMatch.filename}" is missing from storage.`,
    };
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
    const fetched = await fetchGoogleFontTtf(catalogEntry.family, resolvedWeight, resolvedItalic);
    if (fetched) {
      return {
        available: true,
        family: catalogEntry.family,
        resolvedWeight,
        italic: resolvedItalic,
        url: fetched.url,
        filePath: fetched.filePath,
        source: 'builtin',
        exportCompatible: true,
      };
    }
    // Retry regular non-italic if italic specific weight wasn't offered
    if (resolvedItalic) {
      const fallbackNonItalic = await fetchGoogleFontTtf(catalogEntry.family, resolvedWeight, false);
      if (fallbackNonItalic) {
        return {
          available: true,
          family: catalogEntry.family,
          resolvedWeight,
          italic: false,
          url: fallbackNonItalic.url,
          filePath: fallbackNonItalic.filePath,
          source: 'builtin',
          exportCompatible: true,
        };
      }
    }
  }

  // 3. Check exact system font match (never accept unrelated fallback like DejaVu Sans unless requested)
  const sysPath = await findExactSystemFont(family);
  if (sysPath) {
    const safeName = `sys_${slugifyFont(family)}${path.extname(sysPath) || '.ttf'}`;
    const cachedSysPath = path.join(FONTS_DIR, safeName);
    if (!fs.existsSync(cachedSysPath)) {
      fs.copyFileSync(sysPath, cachedSysPath);
    }
    return {
      available: true,
      family,
      resolvedWeight,
      italic: resolvedItalic,
      url: `/media/fonts/${safeName}`,
      filePath: cachedSysPath,
      source: 'system',
      exportCompatible: /\.(ttf|otf|ttc)$/i.test(cachedSysPath),
    };
  }

  return {
    available: false,
    family,
    resolvedWeight,
    italic,
    exportCompatible: false,
    error:
      family.toLowerCase() === 'impact'
        ? 'Impact font file is not installed on this Linux server. Upload Impact.ttf or choose Anton / Archivo Black.'
        : `Font file for "${family}" (${resolvedWeight}) could not be loaded.`,
  };
}
