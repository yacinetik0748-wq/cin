import {
  CaptionDisplayMode,
  CaptionHighlightBehavior,
  CaptionTextTransform,
  SubtitleStyle,
  WordTiming,
} from '../types/studio';

export type CanonicalCaptionMode =
  | 'full-sentence'
  | 'two-words'
  | 'three-words'
  | 'four-words'
  | 'word-by-word'
  | 'karaoke'
  | 'progressive-reveal'
  | 'typewriter'
  | 'line-by-line'
  | 'two-lines'
  | 'dynamic-highlight'
  | 'active-word-context'
  | 'phrase-by-phrase'
  | 'subtitle-classic'
  | 'pop-up-words'
  | 'minimal-clean'
  | 'boxed-captions'
  | 'emphasis-mode';

export interface CaptionModeDefinition {
  id: CanonicalCaptionMode;
  label: string;
  category: 'Word Focus' | 'Chunked' | 'Karaoke & Reveal' | 'Classic & Clean' | 'Viral Styled';
  description: string;
  defaultWordsPerDisplay: number;
  supportsWordCount: boolean;
  defaultHighlightBehavior: CaptionHighlightBehavior;
}

export const CAPTION_DISPLAY_MODES: CaptionModeDefinition[] = [
  {
    id: 'full-sentence',
    label: '1. Full Sentence',
    category: 'Classic & Clean',
    description: 'Displays the complete translated sentence with configured wrapping and alignment.',
    defaultWordsPerDisplay: 0,
    supportsWordCount: false,
    defaultHighlightBehavior: 'color',
  },
  {
    id: 'two-words',
    label: '2. Two Words',
    category: 'Chunked',
    description: 'Fast 2-word viral pacing with active word emphasis.',
    defaultWordsPerDisplay: 2,
    supportsWordCount: false,
    defaultHighlightBehavior: 'color',
  },
  {
    id: 'three-words',
    label: '3. Three Words',
    category: 'Chunked',
    description: 'Balanced 3-word Shorts & TikTok chunk pacing.',
    defaultWordsPerDisplay: 3,
    supportsWordCount: false,
    defaultHighlightBehavior: 'color',
  },
  {
    id: 'four-words',
    label: '4. Four Words',
    category: 'Chunked',
    description: 'Readable 4-word narrative chunks synced to speech cadence.',
    defaultWordsPerDisplay: 4,
    supportsWordCount: false,
    defaultHighlightBehavior: 'color',
  },
  {
    id: 'word-by-word',
    label: '5. Word by Word',
    category: 'Word Focus',
    description: 'Shows one spoken word at a time right on the voice beat.',
    defaultWordsPerDisplay: 1,
    supportsWordCount: false,
    defaultHighlightBehavior: 'scale',
  },
  {
    id: 'karaoke',
    label: '6. Karaoke',
    category: 'Karaoke & Reveal',
    description: 'Keeps full line visible and progressively colors spoken words as narration progresses.',
    defaultWordsPerDisplay: 0,
    supportsWordCount: false,
    defaultHighlightBehavior: 'color',
  },
  {
    id: 'progressive-reveal',
    label: '7. Progressive Reveal',
    category: 'Karaoke & Reveal',
    description: 'Builds the sentence word by word smoothly while keeping earlier words visible.',
    defaultWordsPerDisplay: 0,
    supportsWordCount: false,
    defaultHighlightBehavior: 'color',
  },
  {
    id: 'typewriter',
    label: '8. Typewriter',
    category: 'Karaoke & Reveal',
    description: 'Types out words sequentially in crisp crisp rhythm with cursor emphasis on active word.',
    defaultWordsPerDisplay: 0,
    supportsWordCount: false,
    defaultHighlightBehavior: 'color',
  },
  {
    id: 'line-by-line',
    label: '9. Line by Line',
    category: 'Classic & Clean',
    description: 'Splits longer translated narration into clean single-line windows one after another.',
    defaultWordsPerDisplay: 6,
    supportsWordCount: true,
    defaultHighlightBehavior: 'color',
  },
  {
    id: 'two-lines',
    label: '10. Two Lines',
    category: 'Classic & Clean',
    description: 'Balanced two-line broadcast layout highlighting the currently spoken line.',
    defaultWordsPerDisplay: 8,
    supportsWordCount: true,
    defaultHighlightBehavior: 'color',
  },
  {
    id: 'dynamic-highlight',
    label: '11. Dynamic Highlight',
    category: 'Viral Styled',
    description: 'Shows the chunk/sentence while enlarging and glowing/coloring the active word.',
    defaultWordsPerDisplay: 5,
    supportsWordCount: true,
    defaultHighlightBehavior: 'scale',
  },
  {
    id: 'active-word-context',
    label: '12. Active Word + Context',
    category: 'Word Focus',
    description: 'Focuses on the active word with dimmed neighboring context words.',
    defaultWordsPerDisplay: 3,
    supportsWordCount: true,
    defaultHighlightBehavior: 'color',
  },
  {
    id: 'phrase-by-phrase',
    label: '13. Phrase by Phrase',
    category: 'Chunked',
    description: 'Groups words cleanly at punctuation and natural phrase breaks (or custom word count).',
    defaultWordsPerDisplay: 4,
    supportsWordCount: true,
    defaultHighlightBehavior: 'color',
  },
  {
    id: 'subtitle-classic',
    label: '14. Subtitle Classic',
    category: 'Classic & Clean',
    description: 'Traditional cinema bottom subtitle look with readable backdrop and crisp outline.',
    defaultWordsPerDisplay: 0,
    supportsWordCount: false,
    defaultHighlightBehavior: 'color',
  },
  {
    id: 'pop-up-words',
    label: '15. Pop-up Words',
    category: 'Viral Styled',
    description: 'Pops each active word or chunk with kinetic scale punch.',
    defaultWordsPerDisplay: 2,
    supportsWordCount: true,
    defaultHighlightBehavior: 'scale',
  },
  {
    id: 'minimal-clean',
    label: '16. Minimal Clean',
    category: 'Classic & Clean',
    description: 'Distraction-free clean typography without heavy boxes.',
    defaultWordsPerDisplay: 0,
    supportsWordCount: false,
    defaultHighlightBehavior: 'color',
  },
  {
    id: 'boxed-captions',
    label: '17. Boxed Captions',
    category: 'Viral Styled',
    description: 'Highlights active word or chunk inside a crisp accent pill/box.',
    defaultWordsPerDisplay: 3,
    supportsWordCount: true,
    defaultHighlightBehavior: 'box',
  },
  {
    id: 'emphasis-mode',
    label: '18. Emphasis Mode',
    category: 'Viral Styled',
    description: 'Emphasizes key/longest and active words with highlight color, scale, and glow.',
    defaultWordsPerDisplay: 4,
    supportsWordCount: true,
    defaultHighlightBehavior: 'glow',
  },
];

export function normalizeCanonicalMode(mode?: CaptionDisplayMode | string): CanonicalCaptionMode {
  if (!mode) return 'word-by-word';
  if (mode === 'word' || mode === 'word-by-word') return 'word-by-word';
  if (mode === 'sentence' || mode === 'full-sentence') return 'full-sentence';
  if (mode === 'phrase-chunk' || mode === 'three-words') return 'three-words';
  const match = CAPTION_DISPLAY_MODES.find((m) => m.id === mode);
  return match ? match.id : 'full-sentence';
}

export function applyTextTransform(
  text: string,
  style: Pick<SubtitleStyle, 'textTransform' | 'uppercase'>
): string {
  const mode: CaptionTextTransform =
    style.textTransform || (style.uppercase ? 'uppercase' : 'none');
  if (mode === 'uppercase') return text.toUpperCase();
  if (mode === 'lowercase') return text.toLowerCase();
  return text;
}

export function findActiveWordIndex(words: WordTiming[], currentTime: number): number {
  if (words.length === 0) return -1;
  const exact = words.findIndex((w) => currentTime >= w.start && currentTime <= w.end);
  if (exact !== -1) return exact;
  if (currentTime < words[0].start) return 0;
  for (let i = words.length - 1; i >= 0; i--) {
    if (currentTime >= words[i].start) return i;
  }
  return words.length - 1;
}

export function splitWordsIntoPhrases(
  words: WordTiming[],
  maxWordsPerGroup: number
): WordTiming[][] {
  if (words.length === 0) return [];
  const cap = Math.max(1, maxWordsPerGroup);
  const groups: WordTiming[][] = [];
  let cur: WordTiming[] = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    cur.push(w);
    const endsPunct = /[,.;:!?،؛؟]$/.test(w.word);
    if (cur.length >= cap || (endsPunct && cur.length >= 2)) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}

export interface CaptionChunkSlice {
  words: Array<{
    word: string;
    start: number;
    end: number;
    globalIndex: number;
    isActive: boolean;
    isPast: boolean;
    isEmphasized: boolean;
  }>;
  chunkKey: string;
  activeGlobalIndex: number;
}

export function buildCaptionDisplaySlice(params: {
  mode: CaptionDisplayMode;
  words: WordTiming[];
  currentTime: number;
  wordsPerDisplay?: number;
  chunkSize?: number;
}): CaptionChunkSlice {
  const mode = normalizeCanonicalMode(params.mode);
  const words = params.words;
  if (words.length === 0) {
    return { words: [], chunkKey: 'empty', activeGlobalIndex: -1 };
  }

  const activeIdx = Math.max(0, findActiveWordIndex(words, params.currentTime));

  const mapWord = (w: WordTiming, globalIndex: number) => {
    const cleanLen = w.word.replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, '').length;
    return {
      word: w.word,
      start: w.start,
      end: w.end,
      globalIndex,
      isActive: globalIndex === activeIdx,
      isPast: globalIndex <= activeIdx,
      isEmphasized: globalIndex === activeIdx || cleanLen >= 6,
    };
  };

  if (mode === 'word-by-word') {
    const w = words[activeIdx];
    return {
      words: [mapWord(w, activeIdx)],
      chunkKey: `w_${activeIdx}`,
      activeGlobalIndex: activeIdx,
    };
  }

  if (mode === 'progressive-reveal' || mode === 'typewriter') {
    const visible = words.slice(0, activeIdx + 1).map((w, idx) => mapWord(w, idx));
    return {
      words: visible,
      chunkKey: `rev_${words.length}`,
      activeGlobalIndex: activeIdx,
    };
  }

  if (
    mode === 'full-sentence' ||
    mode === 'karaoke' ||
    mode === 'subtitle-classic' ||
    mode === 'minimal-clean'
  ) {
    return {
      words: words.map((w, idx) => mapWord(w, idx)),
      chunkKey: `all_${words.length}`,
      activeGlobalIndex: activeIdx,
    };
  }

  if (mode === 'phrase-by-phrase') {
    const cap = params.wordsPerDisplay || params.chunkSize || 4;
    const phrases = splitWordsIntoPhrases(words, cap);
    let offset = 0;
    for (let p = 0; p < phrases.length; p++) {
      const grp = phrases[p];
      if (activeIdx >= offset && activeIdx < offset + grp.length) {
        return {
          words: grp.map((w, i) => mapWord(w, offset + i)),
          chunkKey: `phr_${p}`,
          activeGlobalIndex: activeIdx,
        };
      }
      offset += grp.length;
    }
  }

  if (mode === 'active-word-context') {
    const ctxSpan = Math.max(2, params.wordsPerDisplay || 3);
    const half = Math.floor((ctxSpan - 1) / 2);
    const startIdx = Math.max(0, Math.min(words.length - ctxSpan, activeIdx - half));
    const endIdx = Math.min(words.length, startIdx + ctxSpan);
    return {
      words: words.slice(startIdx, endIdx).map((w, i) => mapWord(w, startIdx + i)),
      chunkKey: `ctx_${startIdx}_${endIdx}`,
      activeGlobalIndex: activeIdx,
    };
  }

  // Fixed chunk sizes: two-words, three-words, four-words, pop-up-words, line-by-line, two-lines, dynamic-highlight, boxed-captions, emphasis-mode
  let groupSize = params.wordsPerDisplay || params.chunkSize || 3;
  if (mode === 'two-words') groupSize = 2;
  else if (mode === 'three-words') groupSize = 3;
  else if (mode === 'four-words') groupSize = 4;
  else if (mode === 'line-by-line') groupSize = Math.max(3, params.wordsPerDisplay || 6);
  else if (mode === 'two-lines') groupSize = Math.max(4, params.wordsPerDisplay || 10);
  else if (mode === 'pop-up-words') groupSize = Math.max(1, params.wordsPerDisplay || 2);
  else if (mode === 'dynamic-highlight') groupSize = Math.max(2, params.wordsPerDisplay || 5);
  else if (mode === 'boxed-captions') groupSize = Math.max(1, params.wordsPerDisplay || 3);
  else if (mode === 'emphasis-mode') groupSize = Math.max(2, params.wordsPerDisplay || 4);

  const chunkStart = Math.floor(activeIdx / groupSize) * groupSize;
  const chunkEnd = Math.min(words.length, chunkStart + groupSize);
  return {
    words: words.slice(chunkStart, chunkEnd).map((w, i) => mapWord(w, chunkStart + i)),
    chunkKey: `chk_${chunkStart}_${chunkEnd}`,
    activeGlobalIndex: activeIdx,
  };
}
