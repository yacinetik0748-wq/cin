import {
  applyTextTransform,
  buildCaptionDisplaySlice,
  normalizeCanonicalMode,
} from './captionModes.ts';
import {
  CaptionSegment,
  SubtitleStyle,
  WordTiming,
} from '../types/studio.ts';

function formatSrtTime(sec: number): string {
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function formatVttTime(sec: number): string {
  return formatSrtTime(sec).replace(',', '.');
}

function formatAssTime(sec: number): string {
  const totalCs = Math.max(0, Math.round(sec * 100));
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function hexToAssColor(hex: string, alpha = 1): string {
  const clean = (hex || '#FFFFFF').replace('#', '');
  const r = clean.slice(0, 2) || 'FF';
  const g = clean.slice(2, 4) || 'FF';
  const b = clean.slice(4, 6) || 'FF';
  const aByte = Math.max(0, Math.min(255, Math.round((1 - Math.max(0, Math.min(1, alpha))) * 255)))
    .toString(16)
    .toUpperCase()
    .padStart(2, '0');
  return `&H${aByte}${b.toUpperCase()}${g.toUpperCase()}${r.toUpperCase()}`;
}

function hexToBgrTag(hex: string): string {
  const clean = (hex || '#FFFFFF').replace('#', '');
  const r = clean.slice(0, 2) || 'FF';
  const g = clean.slice(2, 4) || 'FF';
  const b = clean.slice(4, 6) || 'FF';
  return `&H${b.toUpperCase()}${g.toUpperCase()}${r.toUpperCase()}&`;
}

function getStrictTranslatedText(seg: CaptionSegment, style: SubtitleStyle): string {
  const raw = (seg.translatedText || '').trim();
  if (!raw) return '';
  return applyTextTransform(raw, style);
}

export function resolveSegmentWordsForAss(seg: CaptionSegment): WordTiming[] {
  const rawNormalized = (seg.translatedText || '').trim().replace(/\s+/g, ' ');
  if (!rawNormalized) return [];

  const existingJoined = (seg.words || []).map((w) => w.word).join(' ').trim();
  if (
    seg.words &&
    seg.words.length > 0 &&
    existingJoined === rawNormalized
  ) {
    return seg.words.map((w, idx) => {
      const next = seg.words![idx + 1];
      const start = idx === 0 ? Math.min(seg.start, w.start) : w.start;
      const end = next ? Math.max(w.end, next.start) : Math.max(seg.end, w.end);
      return {
        word: w.word,
        start,
        end: Math.max(start + 0.05, end),
      };
    });
  }

  const tokens = rawNormalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const safeStart = Math.max(0, seg.start);
  const safeEnd = Math.max(safeStart + 0.15, seg.end);
  const totalDur = safeEnd - safeStart;
  const weights = tokens.map((t) => Math.max(2, t.replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, '').length));
  const weightSum = weights.reduce((a, b) => a + b, 0) || tokens.length;

  let cursor = safeStart;
  return tokens.map((word, idx) => {
    const share = (weights[idx] / weightSum) * totalDur;
    const start = cursor;
    const end = idx === tokens.length - 1 ? safeEnd : start + share;
    cursor = end;
    return {
      word,
      start: Number(start.toFixed(3)),
      end: Number(Math.max(start + 0.05, end).toFixed(3)),
    };
  });
}

function wrapLinesForAss(words: string[], maxCharsPerLine: number, maxLines: number): string {
  if (words.length === 0) return '';
  const lines: string[] = [];
  let curLine = '';
  for (const w of words) {
    const candidate = curLine ? `${curLine} ${w}` : w;
    if (curLine && candidate.length > maxCharsPerLine && lines.length + 1 < maxLines) {
      lines.push(curLine);
      curLine = w;
    } else {
      curLine = candidate;
    }
  }
  if (curLine) lines.push(curLine);
  return lines.slice(0, maxLines).join('\\N');
}

export function generateSrtContent(captions: CaptionSegment[], style: SubtitleStyle): string {
  return captions
    .filter((seg) => Boolean(seg.translatedText?.trim()))
    .map((seg, idx) => {
      const text = getStrictTranslatedText(seg, style);
      return `${idx + 1}\n${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}\n${text}`;
    })
    .join('\n\n');
}

export function generateVttContent(captions: CaptionSegment[], style: SubtitleStyle): string {
  const body = captions
    .filter((seg) => Boolean(seg.translatedText?.trim()))
    .map((seg) => {
      const text = getStrictTranslatedText(seg, style);
      return `${formatVttTime(seg.start)} --> ${formatVttTime(seg.end)}\n${text}`;
    })
    .join('\n\n');
  return `WEBVTT\n\n${body}`;
}

export function parseSrtOrVtt(content: string): CaptionSegment[] {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const segments: CaptionSegment[] = [];

  const timeRegex = /(?:(\d{2}):)?(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(?:(\d{2}):)?(\d{2}):(\d{2})[,.](\d{3})/;

  let curStart = 0;
  let curEnd = 0;
  let curTextLines: string[] = [];
  let inSegment = false;

  const pushCurrent = () => {
    if (inSegment && curEnd > curStart && curTextLines.length > 0) {
      const cleanText = curTextLines.join(' ').replace(/<[^>]+>/g, '').trim();
      if (cleanText) {
        segments.push({
          id: `cap_${Date.now()}_${segments.length}`,
          start: Number(curStart.toFixed(2)),
          end: Number(curEnd.toFixed(2)),
          text: cleanText,
          translatedText: cleanText,
        });
      }
    }
    curTextLines = [];
    inSegment = false;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('WEBVTT') || line.startsWith('NOTE')) {
      if (!line) pushCurrent();
      continue;
    }

    const match = line.match(timeRegex);
    if (match) {
      pushCurrent();
      const h1 = Number(match[1] || 0);
      const m1 = Number(match[2] || 0);
      const s1 = Number(match[3] || 0);
      const ms1 = Number(match[4] || 0);
      curStart = h1 * 3600 + m1 * 60 + s1 + ms1 / 1000;

      const h2 = Number(match[5] || 0);
      const m2 = Number(match[6] || 0);
      const s2 = Number(match[7] || 0);
      const ms2 = Number(match[8] || 0);
      curEnd = h2 * 3600 + m2 * 60 + s2 + ms2 / 1000;
      inSegment = true;
    } else if (inSegment && !/^\d+$/.test(line)) {
      curTextLines.push(line);
    }
  }
  pushCurrent();

  return segments;
}

function buildStyleLine(
  styleName: string,
  style: SubtitleStyle,
  videoWidth: number,
  videoHeight: number
): { line: string; fontSize: number; marginLR: number; marginV: number; wrapTag: string } {
  let alignBase = 2;
  if (style.position === 'top') alignBase = 8;
  else if (style.position === 'middle') alignBase = 5;

  if (style.textAlign === 'left') {
    alignBase = alignBase === 8 ? 7 : alignBase === 5 ? 4 : 1;
  } else if (style.textAlign === 'right') {
    alignBase = alignBase === 8 ? 9 : alignBase === 5 ? 6 : 3;
  }

  const globalOpacity = Math.max(0.05, Math.min(1, style.opacity ?? 1));
  const scaleFactor = Math.max(0.5, Math.min(2.5, style.scale ?? 1));
  const weightNum = style.fontWeightNum ?? (style.fontWeight === '900' ? 900 : style.fontWeight === 'bold' ? 700 : 400);

  const primaryCol = hexToAssColor(style.primaryColor, globalOpacity);
  const secondaryCol = hexToAssColor(style.highlightColor, globalOpacity);
  const outlineCol = hexToAssColor(style.outlineColor, globalOpacity);
  const backAlpha = (style.backgroundOpacity ?? 0.55) * globalOpacity;
  const shadowAlpha = (style.shadowOpacity ?? 0.85) * globalOpacity;
  const useBox = (style.backgroundOpacity ?? 0) > 0.05;
  const backCol = useBox
    ? hexToAssColor(style.backgroundColor, backAlpha)
    : hexToAssColor(style.shadowColor || '#000000', shadowAlpha);

  const borderStyle = useBox ? 3 : 1;
  const shadowVal = style.shadowEnabled
    ? Math.max(1, Math.round(((style.shadowDistance ?? 2) + (style.shadowBlur ?? 4) * 0.25) * (videoHeight / 720)))
    : 0;
  const fontSize = Math.max(14, Math.round(((style.fontSize * scaleFactor) / 720) * videoHeight));
  const marginV = Math.max(12, Math.round(((style.marginV || 48) / 720) * videoHeight));
  const maxWidthPct = Math.max(25, Math.min(100, style.maxWidthPct ?? 88));
  const marginLR = Math.max(16, Math.round(((100 - maxWidthPct) / 200) * videoWidth));
  const isBold = weightNum >= 600 || style.fontWeight === 'bold' || style.fontWeight === '900' ? -1 : 0;
  const isItalic = style.italic ? -1 : 0;
  const isUnderline = style.underline ? -1 : 0;
  const spacing = Math.round((style.letterSpacing || 0) * (videoHeight / 720));
  const outlinePx = Number((((style.outlineWidth || 0) * (videoHeight / 720))).toFixed(1));
  const wrapTag = style.textWrap === false ? '\\q2' : '\\q0';

  const line = `Style: ${styleName},${style.fontFamily || 'Montserrat'},${fontSize},${primaryCol},${secondaryCol},${outlineCol},${backCol},${isBold},${isItalic},${isUnderline},0,100,100,${spacing},0,${borderStyle},${outlinePx},${shadowVal},${alignBase},${marginLR},${marginLR},${marginV},1`;
  return { line, fontSize, marginLR, marginV, wrapTag };
}

function buildAnimPrefix(style: SubtitleStyle): string {
  const durMs = Math.max(50, Math.min(600, style.transitionDurationMs || 180));
  const halfMs = Math.round(durMs / 2);
  if (style.animationPreset === 'fade') {
    return `{\\fad(${Math.round(durMs * 0.65)},${Math.round(durMs * 0.65)})}`;
  }
  if (
    style.animationPreset === 'pop' ||
    style.animationPreset === 'bounce' ||
    style.animationPreset === 'word-popup'
  ) {
    return `{\\t(0,${halfMs},\\fscx114\\fscy114)\\t(${halfMs},${durMs},\\fscx100\\fscy100)}`;
  }
  if (style.animationPreset === 'scale') {
    return `{\\fscx82\\fscy82\\t(0,${durMs},\\fscx100\\fscy100)}`;
  }
  if (style.animationPreset === 'slide-up') {
    return `{\\fad(${Math.round(durMs * 0.45)},${Math.round(durMs * 0.35)})}`;
  }
  return '';
}

function buildPosAndRotTags(style: SubtitleStyle, videoWidth: number, videoHeight: number): string {
  const rotDeg = style.rotation || 0;
  const rotTag = Math.abs(rotDeg) > 0.2 ? `{\\frz${(-rotDeg).toFixed(1)}}` : '';
  const hasCustomPos =
    style.position === 'custom' ||
    (style.posX !== 50 && style.posX !== undefined) ||
    (style.posY !== undefined && style.position !== 'bottom' && style.position !== 'middle' && style.position !== 'top');

  let posTag = '';
  if (hasCustomPos) {
    const px = Math.round(((style.posX ?? 50) / 100) * videoWidth);
    const py = Math.round(((style.posY ?? 84) / 100) * videoHeight);
    let alignCode = 5;
    if (style.textAlign === 'left') alignCode = 4;
    else if (style.textAlign === 'right') alignCode = 6;
    posTag = `{\\pos(${px},${py})\\an${alignCode}}`;
  }
  return `${posTag}${rotTag}`;
}

export function buildAssContent(params: {
  captions: CaptionSegment[];
  style: SubtitleStyle;
  videoWidth: number;
  videoHeight: number;
  totalDuration?: number;
  includeMainCaptions?: boolean;
  includeExtraElements?: boolean;
  onlyExtraElementIds?: string[];
}): string {
  const { style, videoWidth, videoHeight, captions } = params;
  const includeMain = params.includeMainCaptions !== false;
  const includeExtra = params.includeExtraElements !== false;

  const translatedSegments = captions.filter((seg) => Boolean(seg.translatedText?.trim()));
  if (includeMain && captions.length > 0 && translatedSegments.length === 0) {
    throw new Error(
      'Cannot burn captions into MP4: all segments are missing translatedText. Captions strictly require translated narration text and never fall back to original text.'
    );
  }

  const baseStyleInfo = buildStyleLine('Default', style, videoWidth, videoHeight);
  const styleLines: string[] = [baseStyleInfo.line];
  const events: string[] = [];

  const onlyIds = params.onlyExtraElementIds ? new Set(params.onlyExtraElementIds) : null;
  const extraElements = includeExtra
    ? (style.extraElements || []).filter(
        (el) => el.visible && (!onlyIds || onlyIds.has(el.id))
      )
    : [];
  extraElements.forEach((el, idx) => {
    const merged: SubtitleStyle = { ...style, ...(el.style || {}) };
    styleLines.push(buildStyleLine(`Extra_${idx}`, merged, videoWidth, videoHeight).line);
  });

  const hlTag = hexToBgrTag(style.highlightColor || '#FACC15');
  const gradTag = style.gradientEnabled && style.gradientColor ? hexToBgrTag(style.gradientColor) : hlTag;
  const dimPrimaryTag = hexToAssColor(style.primaryColor || '#FFFFFF', (style.opacity ?? 1) * 0.55);

  if (includeMain) {
    for (let segIdx = 0; segIdx < captions.length; segIdx++) {
      const seg = captions[segIdx];
      const hasOverride = Boolean(seg.styleOverride && Object.keys(seg.styleOverride).length > 0);
      const effStyle: SubtitleStyle = hasOverride
        ? { ...style, ...seg.styleOverride }
        : style;
      const rawTranslated = getStrictTranslatedText(seg, effStyle);
      if (!rawTranslated) continue;

      let segStyleName = 'Default';
      let segFontSize = baseStyleInfo.fontSize;
      let segHlTag = hlTag;
      let segGradTag = gradTag;
      let segDimPrimaryTag = dimPrimaryTag;
      if (hasOverride) {
        segStyleName = `Seg_${segIdx}`;
        const segStyleInfo = buildStyleLine(segStyleName, effStyle, videoWidth, videoHeight);
        styleLines.push(segStyleInfo.line);
        segFontSize = segStyleInfo.fontSize;
        segHlTag = hexToBgrTag(effStyle.highlightColor || '#FACC15');
        segGradTag =
          effStyle.gradientEnabled && effStyle.gradientColor
            ? hexToBgrTag(effStyle.gradientColor)
            : segHlTag;
        segDimPrimaryTag = hexToAssColor(
          effStyle.primaryColor || '#FFFFFF',
          (effStyle.opacity ?? 1) * 0.55
        );
      }

      const canonicalMode = normalizeCanonicalMode(effStyle.mode);
      const animPrefix = buildAnimPrefix(effStyle);
      const posRot = buildPosAndRotTags(effStyle, videoWidth, videoHeight);
      const wrapTag = effStyle.textWrap === false ? '{\\q2}' : '';
      const maxLines = Math.max(1, Math.min(6, effStyle.maxLines ?? 2));
      const maxWidthPct = Math.max(25, Math.min(100, effStyle.maxWidthPct ?? 88));
      const approxCharsPerLine = Math.max(
        12,
        Math.round(((videoWidth * (maxWidthPct / 100)) / Math.max(14, segFontSize * 0.56)))
      );

      const activeWords = resolveSegmentWordsForAss(seg);
      const segStart = Math.max(0, seg.start);
      const segEnd = Math.max(segStart + 0.15, seg.end);

      if (activeWords.length === 0) {
        const wrapped = effStyle.textWrap === false
          ? rawTranslated
          : wrapLinesForAss(rawTranslated.split(/\s+/), approxCharsPerLine, maxLines);
        events.push(
          `Dialogue: 0,${formatAssTime(segStart)},${formatAssTime(segEnd)},${segStyleName},,0,0,0,,${posRot}${wrapTag}${animPrefix}${wrapped}`
        );
        continue;
      }

      if (canonicalMode === 'full-sentence' || canonicalMode === 'subtitle-classic' || canonicalMode === 'minimal-clean') {
        const wordsTransformed = activeWords.map((w) => applyTextTransform(w.word, effStyle));
        const textOut =
          effStyle.textWrap === false
            ? wordsTransformed.join(' ')
            : wrapLinesForAss(wordsTransformed, approxCharsPerLine, maxLines);
        events.push(
          `Dialogue: 0,${formatAssTime(segStart)},${formatAssTime(segEnd)},${segStyleName},,0,0,0,,${posRot}${wrapTag}${animPrefix}${textOut}`
        );
        continue;
      }

      const transformedLabels = activeWords.map((w) => applyTextTransform(w.word, effStyle));
      let pendingDiag: { start: number; end: number; payload: string } | null = null;
      const flushPendingDiag = () => {
        if (!pendingDiag) return;
        events.push(
          `Dialogue: 0,${formatAssTime(pendingDiag.start)},${formatAssTime(pendingDiag.end)},${segStyleName},,0,0,0,,${pendingDiag.payload}`
        );
        pendingDiag = null;
      };

      for (let i = 0; i < activeWords.length; i++) {
        const w = activeWords[i];
        const midTime = (w.start + w.end) / 2;
        const slice = buildCaptionDisplaySlice({
          mode: canonicalMode,
          words: activeWords,
          currentTime: midTime,
          wordsPerDisplay: effStyle.wordsPerDisplay,
          chunkSize: effStyle.chunkSize,
        });

        const lineTokens = slice.words.map((item) => {
          const label = transformedLabels[item.globalIndex] ?? applyTextTransform(item.word, effStyle);
          const isHighlighted =
            canonicalMode === 'karaoke'
              ? item.isPast
              : canonicalMode === 'emphasis-mode'
              ? item.isEmphasized
              : item.isActive;
          const activeCol =
            effStyle.gradientEnabled && item.globalIndex % 2 === 1 ? segGradTag : segHlTag;
          const behavior = effStyle.highlightBehavior || (effStyle.highlightBoxEnabled ? 'box' : 'color');

          if (canonicalMode === 'active-word-context' && !item.isActive) {
            return `{\\1c${segDimPrimaryTag}}${label}{\\r}`;
          }

          if (!isHighlighted) return label;

          if (
            canonicalMode === 'boxed-captions' ||
            behavior === 'box' ||
            effStyle.highlightBoxEnabled ||
            effStyle.animationPreset === 'box-highlight'
          ) {
            const boxBgr = hexToBgrTag(effStyle.highlightBoxColor || '#7C3AED');
            return `{\\1c${activeCol}\\3c${boxBgr}\\bord${Math.max(4, effStyle.outlineWidth + 2)}}${label}{\\r}`;
          }
          if (
            canonicalMode === 'pop-up-words' ||
            canonicalMode === 'dynamic-highlight' ||
            behavior === 'scale' ||
            item.isActive
          ) {
            const scaleUp =
              canonicalMode === 'pop-up-words' || canonicalMode === 'dynamic-highlight' || behavior === 'scale'
                ? '\\fscx114\\fscy114'
                : '';
            const ul = behavior === 'underline' ? '\\u1' : '';
            return `{\\1c${activeCol}${scaleUp}${ul}}${label}{\\r}`;
          }
          return `{\\1c${activeCol}}${label}{\\r}`;
        });

        const formattedLine =
          canonicalMode === 'two-lines' && lineTokens.length >= 4
            ? (() => {
                const splitAt = Math.ceil(lineTokens.length / 2);
                return `${lineTokens.slice(0, splitAt).join(' ')}\\N${lineTokens.slice(splitAt).join(' ')}`;
              })()
            : lineTokens.join(' ');

        const popAnim =
          canonicalMode === 'pop-up-words' && !animPrefix
            ? '{\\t(0,75,\\fscx116\\fscy116)\\t(75,150,\\fscx100\\fscy100)}'
            : animPrefix;

        const payload = `${posRot}${wrapTag}${popAnim}${formattedLine}`;
        if (pendingDiag && pendingDiag.payload === payload && w.start <= pendingDiag.end + 0.04) {
          pendingDiag.end = Math.max(pendingDiag.end, w.end);
        } else {
          flushPendingDiag();
          pendingDiag = { start: w.start, end: w.end, payload };
        }
      }
      flushPendingDiag();
    }
  }

  const maxDur = Math.max(params.totalDuration || 0, ...captions.map((c) => c.end), 10);
  extraElements.forEach((el, idx) => {
    const merged: SubtitleStyle = { ...style, ...(el.style || {}) };
    const posRot = buildPosAndRotTags(merged, videoWidth, videoHeight);
    const animPrefix = buildAnimPrefix(merged);
    if (el.syncToCaptions) {
      for (const seg of captions) {
        const txt = getStrictTranslatedText(seg, merged);
        if (!txt) continue;
        events.push(
          `Dialogue: 1,${formatAssTime(seg.start)},${formatAssTime(seg.end)},Extra_${idx},,0,0,0,,${posRot}${animPrefix}${txt.replace(/\n/g, '\\N')}`
        );
      }
    } else if (el.text.trim()) {
      const start = Math.max(0, el.startTime || 0);
      const end = el.endTime && el.endTime > start ? el.endTime : maxDur;
      if (el.text.includes('{caption}')) {
        const overlapping = captions
          .filter((seg) => Boolean(seg.translatedText?.trim()) && seg.end > start && seg.start < end)
          .sort((a, b) => a.start - b.start);
        if (overlapping.length === 0) {
          const clean = el.text.replace(/\{caption\}/g, '').trim();
          if (clean) {
            const txt = applyTextTransform(clean, merged).replace(/\n/g, '\\N');
            events.push(
              `Dialogue: 1,${formatAssTime(start)},${formatAssTime(end)},Extra_${idx},,0,0,0,,${posRot}${animPrefix}${txt}`
            );
          }
        } else {
          let cursor = start;
          for (const seg of overlapping) {
            const segS = Math.max(start, seg.start);
            const segE = Math.min(end, seg.end);
            if (segS > cursor + 0.05) {
              const gapClean = el.text.replace(/\{caption\}/g, '').trim();
              if (gapClean) {
                const gapTxt = applyTextTransform(gapClean, merged).replace(/\n/g, '\\N');
                events.push(
                  `Dialogue: 1,${formatAssTime(cursor)},${formatAssTime(segS)},Extra_${idx},,0,0,0,,${posRot}${animPrefix}${gapTxt}`
                );
              }
            }
            const capTxt = (seg.translatedText || '').trim();
            const replaced = el.text.replace(/\{caption\}/g, capTxt).trim();
            if (replaced && segE > segS + 0.02) {
              const txt = applyTextTransform(replaced, merged).replace(/\n/g, '\\N');
              events.push(
                `Dialogue: 1,${formatAssTime(segS)},${formatAssTime(segE)},Extra_${idx},,0,0,0,,${posRot}${animPrefix}${txt}`
              );
            }
            cursor = Math.max(cursor, segE);
          }
          if (cursor < end - 0.05) {
            const tailClean = el.text.replace(/\{caption\}/g, '').trim();
            if (tailClean) {
              const tailTxt = applyTextTransform(tailClean, merged).replace(/\n/g, '\\N');
              events.push(
                `Dialogue: 1,${formatAssTime(cursor)},${formatAssTime(end)},Extra_${idx},,0,0,0,,${posRot}${animPrefix}${tailTxt}`
              );
            }
          }
        }
      } else {
        const txt = applyTextTransform(el.text.trim(), merged).replace(/\n/g, '\\N');
        events.push(
          `Dialogue: 1,${formatAssTime(start)},${formatAssTime(end)},Extra_${idx},,0,0,0,,${posRot}${animPrefix}${txt}`
        );
      }
    }
  });

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${videoWidth}
PlayResY: ${videoHeight}
WrapStyle: ${style.textWrap === false ? 2 : 0}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleLines.join('\n')}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  return `${header}\n${events.join('\n')}\n`;
}
