import {
  CaptionElementLayer,
  CaptionSegment,
  Project,
  SubtitleStyle,
  WordTiming,
} from '../types/studio';
import {
  applyTextTransform,
  buildCaptionDisplaySlice,
  CaptionChunkSlice,
  normalizeCanonicalMode,
} from './captionModes';

type CaptionWordState = CaptionChunkSlice['words'][number];
import { getSyncedCaptionsForPreview } from './workflowStages';

function hexToRgba(hex: string, opacity: number): string {
  const clean = (hex || '#000000').replace('#', '').slice(0, 6);
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean.padEnd(6, '0');
  const num = parseInt(full, 16);
  const r = Number.isFinite(num) ? (num >> 16) & 255 : 0;
  const g = Number.isFinite(num) ? (num >> 8) & 255 : 0;
  const b = Number.isFinite(num) ? num & 255 : 0;
  const normOp = opacity > 1 ? opacity / 100 : opacity;
  const a = Math.max(0, Math.min(1, normOp));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export type SyncedCaptionInput = CaptionSegment & {
  syncedStart?: number;
  syncedEnd?: number;
};

export interface CachedCaptionToken {
  text: string;
  width: number;
  globalIndex: number;
  isActive: boolean;
  isPast: boolean;
  isEmphasized: boolean;
}

export interface CachedCaptionLine {
  tokens: CachedCaptionToken[];
  totalWidth: number;
}

export interface CachedChunkLayout {
  chunkKey: string;
  lines: CachedCaptionLine[];
  boxW: number;
  boxH: number;
}

export interface ResolvedCaptionStyleMetrics {
  style: SubtitleStyle;
  mode: ReturnType<typeof normalizeCanonicalMode>;
  font: string;
  fontSize: number;
  lineHeight: number;
  spaceWidth: number;
  maxTextWidth: number;
  posYFrac: number;
  baseCenterX: number;
  primaryColor: string;
  highlightColor: string;
  gradientColor: string;
  outlineColor: string;
  outlineWidth: number;
  bgColor: string | null;
  padH: number;
  padV: number;
  borderRadius: number;
  shadowColor: string | null;
  shadowBlur: number;
  shadowDist: number;
  globalOpacity: number;
  useBoxHighlight: boolean;
  useGradientHighlight: boolean;
  useScaleHighlight: boolean;
  useGlowHighlight: boolean;
  useUnderlineHighlight: boolean;
  useDimmedContext: boolean;
  highlightBoxFill: string;
  isStaticWholeSegment: boolean;
}

export interface PrecomputedCaptionSegment {
  id: string;
  start: number;
  end: number;
  rawText: string;
  transformedText: string;
  words: WordTiming[];
  metrics: ResolvedCaptionStyleMetrics;
  // Precomputed chunk layouts keyed by quantized state signature
  chunkLayoutCache: Map<string, CachedCaptionLine[]>;
}

export interface PrecomputedCaptionCache {
  targetWidth: number;
  targetHeight: number;
  segments: PrecomputedCaptionSegment[];
  extraElements: Array<{
    el: CaptionElementLayer;
    metrics: ResolvedCaptionStyleMetrics;
    start: number;
    end: number;
  }>;
  textWidthCache: Map<string, number>;
  measureCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}

function createMeasureContext(): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  if (typeof OffscreenCanvas !== 'undefined') {
    const oc = new OffscreenCanvas(16, 16);
    const ctx = oc.getContext('2d');
    if (ctx) return ctx;
  }
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 16;
  return c.getContext('2d')!;
}

function resolveWordTimingsFast(seg: {
  start: number;
  end: number;
  text: string;
  translatedText?: string;
  words?: WordTiming[];
}): WordTiming[] {
  const sourceText = (seg.translatedText || seg.text || '').trim().replace(/\s+/g, ' ');
  if (!sourceText) return [];
  if (seg.words && seg.words.length > 0) {
    return seg.words;
  }
  const tokens = sourceText.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const s = Math.max(0, seg.start);
  const e = Math.max(s + 0.12, seg.end);
  const dur = e - s;
  const step = dur / tokens.length;
  return tokens.map((word, idx) => ({
    word,
    start: s + idx * step,
    end: s + (idx + 1) * step,
  }));
}

export function resolveStyleMetrics(
  style: SubtitleStyle,
  targetWidth: number,
  targetHeight: number,
  measureCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  widthCache: Map<string, number>
): ResolvedCaptionStyleMetrics {
  const mode = normalizeCanonicalMode(style.mode);
  const animPreset = style.animationPreset || 'none';
  const highlightBehavior = style.highlightBehavior || 'color';
  const scaleMul = Math.max(0.5, Math.min(2.5, style.scale || 1));
  const rawFontSize = style.fontSize || Math.round(targetHeight * 0.042);
  const fontSize = Math.max(18, Math.round(rawFontSize * (targetHeight / 1080) * scaleMul));
  const weightNum =
    style.fontWeightNum ||
    (style.fontWeight === '900' ? 900 : style.fontWeight === 'bold' ? 700 : 400);
  const font = `${style.italic ? 'italic ' : ''}${weightNum} ${fontSize}px "${
    style.fontFamily || 'Montserrat'
  }", sans-serif`;

  measureCtx.font = font;
  const spaceKey = `${font}:: `;
  let spaceWidth = widthCache.get(spaceKey);
  if (spaceWidth === undefined) {
    spaceWidth = measureCtx.measureText(' ').width;
    widthCache.set(spaceKey, spaceWidth);
  }

  const maxTextWidth =
    (Math.max(25, Math.min(100, style.maxWidthPct || 88)) / 100) * targetWidth;

  const posYFrac =
    style.position === 'top'
      ? 0.14
      : style.position === 'middle'
      ? 0.5
      : style.position === 'custom'
      ? Math.max(0.08, Math.min(0.92, (style.posY ?? 85) / 100))
      : 0.85;

  const baseCenterX =
    style.position === 'custom'
      ? Math.max(0.08, Math.min(0.92, (style.posX ?? 50) / 100)) * targetWidth
      : style.textAlign === 'left'
      ? targetWidth * 0.1 + maxTextWidth / 2
      : style.textAlign === 'right'
      ? targetWidth * 0.9 - maxTextWidth / 2
      : targetWidth / 2;

  const isMinimal = mode === 'minimal-clean';
  const rawBgOp = style.backgroundOpacity ?? 0.55;
  const bgOp = isMinimal ? 0 : rawBgOp > 1 ? rawBgOp / 100 : rawBgOp;
  const bgColor =
    bgOp > 0.02 ? hexToRgba(style.backgroundColor || '#09090B', bgOp) : null;

  const scaleFactor = targetHeight / 1080;
  const outlineWidth = Math.max(0, (style.outlineWidth || 0) * scaleFactor * 1.15);
  const padH = Math.max(6, Math.round((style.paddingH ?? 14) * scaleFactor));
  const padV = Math.max(4, Math.round((style.paddingV ?? 8) * scaleFactor));
  const borderRadius = Math.max(0, Math.round((style.borderRadius ?? 8) * scaleFactor));
  const lineHeight = fontSize * Math.max(1.1, style.lineSpacing || 1.24);

  const shadowBlur = style.shadowEnabled
    ? Math.max(0, Math.round((style.shadowBlur ?? 6) * scaleFactor))
    : 0;
  const shadowDist = style.shadowEnabled
    ? Math.max(0, Math.round((style.shadowDistance ?? 2) * scaleFactor))
    : 0;
  const shadowColor = style.shadowEnabled
    ? hexToRgba(style.shadowColor || '#000000', style.shadowOpacity ?? 0.85)
    : null;

  return {
    style,
    mode,
    font,
    fontSize,
    lineHeight,
    spaceWidth,
    maxTextWidth,
    posYFrac,
    baseCenterX,
    primaryColor: style.primaryColor || '#FFFFFF',
    highlightColor: style.highlightColor || '#FACC15',
    gradientColor: style.gradientColor || '#38BDF8',
    outlineColor: style.outlineColor || '#09090B',
    outlineWidth,
    bgColor,
    padH,
    padV,
    borderRadius,
    shadowColor,
    shadowBlur,
    shadowDist,
    globalOpacity: Math.max(0.05, Math.min(1, style.opacity ?? 1)),
    useBoxHighlight:
      highlightBehavior === 'box' ||
      mode === 'boxed-captions' ||
      Boolean(style.highlightBoxEnabled) ||
      animPreset === 'box-highlight',
    useGradientHighlight:
      Boolean(style.gradientEnabled || animPreset === 'gradient-emphasis'),
    useScaleHighlight:
      highlightBehavior === 'scale' ||
      mode === 'pop-up-words' ||
      mode === 'dynamic-highlight',
    useGlowHighlight:
      highlightBehavior === 'glow' ||
      animPreset === 'highlight-sweep' ||
      animPreset === 'word-emphasis',
    useUnderlineHighlight: highlightBehavior === 'underline',
    useDimmedContext: mode === 'active-word-context',
    highlightBoxFill: hexToRgba(
      style.highlightBoxColor || '#7C3AED',
      style.highlightBoxOpacity ?? 0.85
    ),
    isStaticWholeSegment:
      mode === 'full-sentence' ||
      mode === 'subtitle-classic' ||
      mode === 'minimal-clean',
  };
}

function measureTextCached(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  font: string,
  text: string,
  cache: Map<string, number>
): number {
  const key = `${font}::${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  ctx.font = font;
  const w = ctx.measureText(text).width;
  cache.set(key, w);
  return w;
}

function wrapWordsIntoLines(
  words: CaptionWordState[],
  metrics: ResolvedCaptionStyleMetrics,
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  widthCache: Map<string, number>,
  mode: ReturnType<typeof normalizeCanonicalMode>
): CachedCaptionLine[] {
  const tokens: CachedCaptionToken[] = words.map((w) => {
    const text = applyTextTransform(w.word, metrics.style);
    const width = measureTextCached(ctx, metrics.font, text, widthCache);
    return {
      text,
      width,
      globalIndex: w.globalIndex,
      isActive: w.isActive,
      isPast: w.isPast,
      isEmphasized: w.isEmphasized,
    };
  });

  if (mode === 'two-lines' && tokens.length >= 4) {
    const splitAt = Math.ceil(tokens.length / 2);
    const l1 = tokens.slice(0, splitAt);
    const l2 = tokens.slice(splitAt);
    return [l1, l2].map((lineTokens) => ({
      tokens: lineTokens,
      totalWidth:
        lineTokens.reduce((s, t) => s + t.width, 0) +
        Math.max(0, lineTokens.length - 1) * metrics.spaceWidth,
    }));
  }

  const lines: CachedCaptionLine[] = [];
  let cur: CachedCaptionToken[] = [];
  let curW = 0;
  const allowWrap = metrics.style.textWrap !== false;
  const maxLines = Math.max(1, Math.min(6, metrics.style.maxLines ?? 3));

  for (const tok of tokens) {
    const nextW = cur.length === 0 ? tok.width : curW + metrics.spaceWidth + tok.width;
    if (allowWrap && cur.length > 0 && nextW > metrics.maxTextWidth && lines.length + 1 < maxLines) {
      lines.push({ tokens: cur, totalWidth: curW });
      cur = [tok];
      curW = tok.width;
    } else {
      cur.push(tok);
      curW = nextW;
    }
  }
  if (cur.length > 0) {
    lines.push({ tokens: cur, totalWidth: curW });
  }
  return lines;
}

/**
 * Precomputes caption segments, word timings, text measurements, and line wrapping
 * once before rendering so frame loops execute zero layout allocation.
 */
export function buildPrecomputedCaptionCache(
  project: Project,
  targetWidth: number,
  targetHeight: number,
  syncedOverride?: SyncedCaptionInput[]
): PrecomputedCaptionCache {
  const measureCtx = createMeasureContext();
  const textWidthCache = new Map<string, number>();
  const synced: SyncedCaptionInput[] = syncedOverride || getSyncedCaptionsForPreview(project);
  const baseMetrics = resolveStyleMetrics(
    project.subtitleStyle,
    targetWidth,
    targetHeight,
    measureCtx,
    textWidthCache
  );

  const segments: PrecomputedCaptionSegment[] = [];

  for (const seg of synced) {
    const segStart = seg.syncedStart ?? seg.start;
    const segEnd = Math.max(segStart + 0.12, seg.syncedEnd ?? seg.end);
    const rawText = (seg.translatedText || seg.text || '').trim();
    if (!rawText) continue;

    const hasOverride = Boolean(
      seg.styleOverride && Object.keys(seg.styleOverride).length > 0
    );
    const metrics = hasOverride
      ? resolveStyleMetrics(
          { ...project.subtitleStyle, ...seg.styleOverride },
          targetWidth,
          targetHeight,
          measureCtx,
          textWidthCache
        )
      : baseMetrics;

    const words = resolveWordTimingsFast({
      start: segStart,
      end: segEnd,
      text: seg.text,
      translatedText: seg.translatedText,
      words: seg.words,
    });

    const chunkLayoutCache = new Map<string, CachedCaptionLine[]>();
    const transformedText = applyTextTransform(rawText, metrics.style);

    if (metrics.isStaticWholeSegment || words.length === 0) {
      const staticStates: CaptionWordState[] = transformedText
        .split(/\s+/)
        .filter(Boolean)
        .map((w, idx) => ({
          word: w,
          start: segStart,
          end: segEnd,
          globalIndex: idx,
          isActive: false,
          isPast: false,
          isEmphasized: false,
        }));
      chunkLayoutCache.set(
        'static',
        wrapWordsIntoLines(staticStates, metrics, measureCtx, textWidthCache, metrics.mode)
      );
    }

    segments.push({
      id: seg.id,
      start: segStart,
      end: segEnd,
      rawText,
      transformedText,
      words,
      metrics,
      chunkLayoutCache,
    });
  }

  segments.sort((a, b) => a.start - b.start);

  const extraElements = (project.subtitleStyle.extraElements || [])
    .filter((el) => el.visible)
    .map((el) => {
      const merged: SubtitleStyle = {
        ...project.subtitleStyle,
        ...(el.style || {}),
      };
      return {
        el,
        metrics: resolveStyleMetrics(
          merged,
          targetWidth,
          targetHeight,
          measureCtx,
          textWidthCache
        ),
        start: Math.max(0, el.startTime || 0),
        end: el.endTime && el.endTime > (el.startTime || 0) ? el.endTime : Infinity,
      };
    });

  return {
    targetWidth,
    targetHeight,
    segments,
    extraElements,
    textWidthCache,
    measureCtx,
  };
}

/**
 * Finds the active caption segment at timeSec using an amortized sequential cursor
 * (O(1) during forward rendering).
 */
export function findSegmentAtTime(
  segments: PrecomputedCaptionSegment[],
  timeSec: number,
  cursorHint?: { index: number }
): PrecomputedCaptionSegment | null {
  if (segments.length === 0) return null;
  let i = cursorHint ? Math.max(0, Math.min(cursorHint.index, segments.length - 1)) : 0;

  while (i > 0 && segments[i].start > timeSec) {
    i--;
  }
  while (i < segments.length && segments[i].end < timeSec) {
    i++;
  }
  if (cursorHint) {
    cursorHint.index = Math.min(i, segments.length - 1);
  }
  if (i < segments.length) {
    const seg = segments[i];
    if (timeSec >= seg.start && timeSec <= seg.end) {
      return seg;
    }
  }
  return null;
}

/**
 * Draws active captions & extra caption elements onto a 2D canvas context
 * using strictly precomputed word timings and cached glyph measurements.
 * Returns a state signature string so static-frame encoders can detect visual caption changes.
 */
export function drawCachedCaptionsAtTime(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  cache: PrecomputedCaptionCache,
  timeSec: number,
  cursorHint?: { index: number }
): string {
  const seg = findSegmentAtTime(cache.segments, timeSec, cursorHint);
  let stateSig = '';

  if (seg) {
    const { metrics } = seg;
    let lines: CachedCaptionLine[] | undefined;

    if (metrics.isStaticWholeSegment || seg.words.length === 0) {
      lines = seg.chunkLayoutCache.get('static');
      stateSig = `s:${seg.id}`;
    } else {
      const slice = buildCaptionDisplaySlice({
        mode: metrics.mode,
        words: seg.words,
        currentTime: timeSec,
        wordsPerDisplay: metrics.style.wordsPerDisplay,
        chunkSize: metrics.style.chunkSize,
      });

      const activeSig = slice.words
        .map((w) => `${w.globalIndex}:${w.isActive ? 1 : 0}${w.isPast ? 1 : 0}`)
        .join(',');
      const cacheKey = `${slice.chunkKey}|${activeSig}`;
      lines = seg.chunkLayoutCache.get(cacheKey);
      if (!lines) {
        lines = wrapWordsIntoLines(
          slice.words,
          metrics,
          cache.measureCtx,
          cache.textWidthCache,
          metrics.mode
        );
        seg.chunkLayoutCache.set(cacheKey, lines);
      }
      stateSig = `d:${seg.id}:${cacheKey}`;
    }

    if (lines && lines.length > 0) {
      drawCaptionLinesOnCanvas(ctx, lines, metrics, cache.targetWidth, cache.targetHeight);
    }
  }

  // Extra caption elements (e.g., episode label, watermark title, {caption} template)
  for (const item of cache.extraElements) {
    if (timeSec < item.start || timeSec > item.end) continue;
    let raw = item.el.text || '';
    if (item.el.syncToCaptions) {
      raw = seg ? seg.rawText : '';
    } else if (raw.includes('{caption}')) {
      raw = raw.replace(/\{caption\}/g, seg ? seg.rawText : '').trim();
    }
    if (!raw.trim()) continue;
    const text = applyTextTransform(raw.trim(), item.metrics.style);
    const w = measureTextCached(
      cache.measureCtx,
      item.metrics.font,
      text,
      cache.textWidthCache
    );
    const singleLine: CachedCaptionLine[] = [
      {
        tokens: [
          {
            text,
            width: w,
            globalIndex: 0,
            isActive: false,
            isPast: false,
            isEmphasized: false,
          },
        ],
        totalWidth: w,
      },
    ];
    drawCaptionLinesOnCanvas(ctx, singleLine, item.metrics, cache.targetWidth, cache.targetHeight);
    stateSig += `|ex:${item.el.id}:${text}`;
  }

  return stateSig;
}

function drawCaptionLinesOnCanvas(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  lines: CachedCaptionLine[],
  metrics: ResolvedCaptionStyleMetrics,
  targetW: number,
  targetH: number
): void {
  const maxLineW = lines.reduce((m, l) => Math.max(m, l.totalWidth), 0);
  const totalTextH = lines.length * metrics.lineHeight;
  const centerY = targetH * metrics.posYFrac;
  const startY = centerY - totalTextH / 2 + metrics.lineHeight / 2;

  ctx.save();
  ctx.globalAlpha = metrics.globalOpacity;
  ctx.font = metrics.font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  // Optional background box behind caption block
  if (metrics.bgColor && maxLineW > 0) {
    const boxW = Math.min(targetW * 0.96, maxLineW + metrics.padH * 2);
    const boxH = totalTextH + metrics.padV * 2;
    const bx = metrics.baseCenterX - boxW / 2;
    const by = centerY - boxH / 2;
    ctx.fillStyle = metrics.bgColor;
    if (metrics.borderRadius > 0 && typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(bx, by, boxW, boxH, metrics.borderRadius);
      ctx.fill();
    } else {
      ctx.fillRect(bx, by, boxW, boxH);
    }
  }

  for (let lIdx = 0; lIdx < lines.length; lIdx++) {
    const line = lines[lIdx];
    let cursorX =
      metrics.style.textAlign === 'left'
        ? metrics.baseCenterX - metrics.maxTextWidth / 2
        : metrics.style.textAlign === 'right'
        ? metrics.baseCenterX + metrics.maxTextWidth / 2 - line.totalWidth
        : metrics.baseCenterX - line.totalWidth / 2;
    const y = startY + lIdx * metrics.lineHeight;

    for (const tok of line.tokens) {
      const isLit =
        metrics.mode === 'karaoke'
          ? tok.isPast
          : metrics.mode === 'emphasis-mode'
          ? tok.isEmphasized || tok.isActive
          : tok.isActive;

      const isSingleMode = metrics.mode === 'word-by-word';

      if (isLit && metrics.useBoxHighlight) {
        const bpX = Math.max(4, Math.round(metrics.fontSize * 0.18));
        const bpY = Math.max(2, Math.round(metrics.fontSize * 0.1));
        ctx.fillStyle = metrics.highlightBoxFill;
        if (metrics.borderRadius > 0 && typeof ctx.roundRect === 'function') {
          ctx.beginPath();
          ctx.roundRect(
            cursorX - bpX,
            y - metrics.fontSize * 0.56 - bpY,
            tok.width + bpX * 2,
            metrics.fontSize * 1.12 + bpY * 2,
            Math.max(4, metrics.borderRadius)
          );
          ctx.fill();
        } else {
          ctx.fillRect(
            cursorX - bpX,
            y - metrics.fontSize * 0.56 - bpY,
            tok.width + bpX * 2,
            metrics.fontSize * 1.12 + bpY * 2
          );
        }
      }

      const scaleWord = !isSingleMode && isLit && metrics.useScaleHighlight ? 1.09 : 1.0;

      ctx.save();
      if (metrics.useDimmedContext && !tok.isActive) {
        ctx.globalAlpha = metrics.globalOpacity * 0.5;
      }
      if (scaleWord !== 1.0) {
        const cx = cursorX + tok.width / 2;
        ctx.translate(cx, y);
        ctx.scale(scaleWord, scaleWord);
        ctx.translate(-cx, -y);
      }

      if (metrics.shadowColor && metrics.shadowBlur > 0) {
        ctx.shadowColor = metrics.shadowColor;
        ctx.shadowBlur = metrics.shadowBlur;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = metrics.shadowDist;
      }

      if (isLit && metrics.useGlowHighlight) {
        ctx.shadowColor = metrics.highlightColor;
        ctx.shadowBlur = Math.max(8, Math.round(metrics.fontSize * 0.25));
      }

      if (metrics.outlineWidth > 0.2) {
        ctx.strokeStyle = metrics.outlineColor;
        ctx.lineWidth = metrics.outlineWidth * 2;
        ctx.strokeText(tok.text, cursorX, y);
      }

      if (isLit && metrics.useGradientHighlight && !isSingleMode) {
        const grad = ctx.createLinearGradient(
          cursorX,
          y - metrics.fontSize * 0.5,
          cursorX + tok.width,
          y + metrics.fontSize * 0.5
        );
        grad.addColorStop(0, metrics.highlightColor);
        grad.addColorStop(1, metrics.gradientColor);
        ctx.fillStyle = grad;
      } else if (isLit && !isSingleMode) {
        ctx.fillStyle = metrics.highlightColor;
      } else {
        ctx.fillStyle = metrics.primaryColor;
      }

      ctx.fillText(tok.text, cursorX, y);

      if (isLit && metrics.useUnderlineHighlight) {
        const ulY = y + metrics.fontSize * 0.52;
        ctx.fillStyle = metrics.highlightColor;
        ctx.fillRect(cursorX, ulY, tok.width, Math.max(2, Math.round(metrics.fontSize * 0.08)));
      }

      ctx.restore();
      cursorX += tok.width + metrics.spaceWidth;
    }
  }

  ctx.restore();
}
