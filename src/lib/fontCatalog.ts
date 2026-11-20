export * from './fontCatalogData.ts';
import { BUILTIN_FONT_CATALOG, FontStatusEntry, resolveClosestSupportedWeight } from './fontCatalogData.ts';
import { getBlobAssetUrl, idbList } from './browserStorage.ts';
import type { SavedFontAsset } from '../types/studio.ts';

// Runtime browser FontFace registry so we NEVER pretend an unloaded font succeeded
const statusCache = new Map<string, FontStatusEntry>();
const pendingLoads = new Map<string, Promise<FontStatusEntry>>();
const listeners = new Set<() => void>();

function notifyFontListeners() {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      // ignore
    }
  }
}

export function subscribeFontStatus(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getFontStatus(family: string, weight = 400): FontStatusEntry {
  const key = `${family}::${weight}`;
  return (
    statusCache.get(key) ||
    statusCache.get(`${family}::any`) || {
      family,
      status: 'idle',
    }
  );
}

export function getAllLoadedFontStatuses(): Record<string, FontStatusEntry> {
  const out: Record<string, FontStatusEntry> = {};
  for (const [k, v] of statusCache.entries()) {
    out[k] = v;
  }
  return out;
}

export async function ensureFontLoaded(params: {
  family: string;
  weight?: number;
  italic?: boolean;
  customUrl?: string;
}): Promise<FontStatusEntry> {
  const { family, italic = false, customUrl } = params;
  const cleanFamily = (family || '').trim();
  if (!cleanFamily) {
    return { family: '', status: 'error', error: 'No font family selected.' };
  }

  const resolvedWeight = customUrl
    ? params.weight || 400
    : resolveClosestSupportedWeight(cleanFamily, params.weight || 700);
  const key = `${cleanFamily}::${resolvedWeight}${italic ? 'i' : ''}`;

  const existing = statusCache.get(key);
  if (existing && existing.status === 'loaded') {
    return existing;
  }

  const inflight = pendingLoads.get(key);
  if (inflight) return inflight;

  const task = (async (): Promise<FontStatusEntry> => {
    statusCache.set(key, { family: cleanFamily, status: 'loading' });
    notifyFontListeners();

    try {
      let fontUrl = customUrl;
      let availableForExport = true;
      let source: FontStatusEntry['source'] = customUrl ? 'custom' : 'builtin';

      if (!fontUrl) {
        try {
          const customFonts = await idbList<SavedFontAsset>('fonts');
          const customMatch = (customFonts || []).find(
            (f) => f.family.toLowerCase() === cleanFamily.toLowerCase()
          );
          if (customMatch?.url) {
            fontUrl = customMatch.url;
            source = 'custom';
          }
        } catch {
          // ignore IDB read failure and fall through to Google Fonts CSS
        }

        if (!fontUrl) {
          const catalogEntry = BUILTIN_FONT_CATALOG.find(
            (f) => f.family.toLowerCase() === cleanFamily.toLowerCase()
          );
          if (catalogEntry && catalogEntry.family !== 'Impact' && typeof document !== 'undefined') {
            const familyQuery = encodeURIComponent(catalogEntry.family).replace(/%20/g, '+');
            const cssHref = italic
              ? `https://fonts.googleapis.com/css2?family=${familyQuery}:ital,wght@1,${resolvedWeight}&display=swap`
              : `https://fonts.googleapis.com/css2?family=${familyQuery}:wght@${resolvedWeight}&display=swap`;
            const id = `gfont_${catalogEntry.family.replace(/[^a-z0-9]/gi, '_')}_${resolvedWeight}`;
            if (!document.getElementById(id)) {
              const link = document.createElement('link');
              link.id = id;
              link.rel = 'stylesheet';
              link.href = cssHref;
              document.head.appendChild(link);
            }
            const okEntry: FontStatusEntry = {
              family: cleanFamily,
              status: 'loaded',
              availableForExport: true,
              source: 'builtin',
              loadedWeights: [resolvedWeight],
            };
            statusCache.set(key, okEntry);
            statusCache.set(`${cleanFamily}::any`, okEntry);
            notifyFontListeners();
            return okEntry;
          }
          const entry: FontStatusEntry = {
            family: cleanFamily,
            status: 'error',
            availableForExport: false,
            error: `Font "${cleanFamily}" file could not be loaded.`,
          };
          statusCache.set(key, entry);
          statusCache.set(`${cleanFamily}::any`, entry);
          notifyFontListeners();
          return entry;
        }
      } else if (fontUrl.startsWith('idb://blobs/')) {
        const blobKey = fontUrl.slice('idb://blobs/'.length);
        const resolved = await getBlobAssetUrl(blobKey);
        if (!resolved) {
          throw new Error(`Custom font "${cleanFamily}" was not found in IndexedDB.`);
        }
        if (/\.woff2?$/i.test(blobKey)) {
          availableForExport = false;
        }
        fontUrl = resolved;
      } else {
        // Verify custom URL is reachable & non-empty
        const head = await fetch(fontUrl, { method: 'HEAD' });
        if (!head.ok) {
          throw new Error(`Font file "${fontUrl}" is missing (HTTP ${head.status}).`);
        }
        if (/\.woff2?$/i.test(fontUrl)) {
          availableForExport = false;
        }
      }

      if (fontUrl.startsWith('idb://blobs/')) {
        const blobKey = fontUrl.slice('idb://blobs/'.length);
        const resolved = await getBlobAssetUrl(blobKey);
        if (!resolved) {
          throw new Error(`Font asset "${cleanFamily}" missing from IndexedDB.`);
        }
        fontUrl = resolved;
      }

      if (typeof FontFace !== 'undefined' && typeof document !== 'undefined') {
        const descriptors: FontFaceDescriptors = {
          weight: String(resolvedWeight),
          style: italic ? 'italic' : 'normal',
        };
        const face = new FontFace(cleanFamily, `url('${fontUrl}')`, descriptors);
        const loadedFace = await face.load();
        document.fonts.add(loadedFace);
        await document.fonts.ready;
      }

      const okEntry: FontStatusEntry = {
        family: cleanFamily,
        status: 'loaded',
        availableForExport,
        source,
        loadedWeights: [resolvedWeight],
      };
      statusCache.set(key, okEntry);
      statusCache.set(`${cleanFamily}::any`, okEntry);
      notifyFontListeners();
      return okEntry;
    } catch (err) {
      const failEntry: FontStatusEntry = {
        family: cleanFamily,
        status: 'error',
        availableForExport: false,
        error: err instanceof Error ? err.message : String(err),
      };
      statusCache.set(key, failEntry);
      statusCache.set(`${cleanFamily}::any`, failEntry);
      notifyFontListeners();
      return failEntry;
    } finally {
      pendingLoads.delete(key);
    }
  })();

  pendingLoads.set(key, task);
  return task;
}
