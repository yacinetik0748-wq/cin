export * from './fontCatalogData.ts';
import { BUILTIN_FONT_CATALOG, FontStatusEntry, resolveClosestSupportedWeight } from './fontCatalogData.ts';

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
        // Ask server to resolve & cache real TTF file for both browser + FFmpeg libass
        const resp = await fetch(
          `/api/fonts/ensure?family=${encodeURIComponent(cleanFamily)}&weight=${resolvedWeight}&italic=${italic ? '1' : '0'}`
        );
        const data = (await resp.json()) as {
          available?: boolean;
          url?: string;
          error?: string;
          source?: 'builtin' | 'custom' | 'system';
          resolvedWeight?: number;
        };
        if (!resp.ok || !data.available || !data.url) {
          const entry: FontStatusEntry = {
            family: cleanFamily,
            status: 'error',
            availableForExport: false,
            error: data.error || `Font "${cleanFamily}" file could not be loaded.`,
          };
          statusCache.set(key, entry);
          statusCache.set(`${cleanFamily}::any`, entry);
          notifyFontListeners();
          return entry;
        }
        fontUrl = data.url;
        source = data.source || 'builtin';
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
