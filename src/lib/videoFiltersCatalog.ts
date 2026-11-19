import {
  ColorAdjustments,
  ColorFilterPreset,
  FilterLayerItem,
  VideoEffectsConfig,
  VisualEffectType,
} from '../types/studio';

export type FilterCategoryId =
  | 'All'
  | 'Cinematic'
  | 'Color & Lighting'
  | 'Film & Retro'
  | 'Social Media & Trending'
  | 'Additional Styles';

export const FILTER_CATEGORIES: FilterCategoryId[] = [
  'All',
  'Cinematic',
  'Color & Lighting',
  'Film & Retro',
  'Social Media & Trending',
  'Additional Styles',
];

export type EffectCategoryId =
  | 'All'
  | 'Visual Effects'
  | 'Cinematic Effects'
  | 'Trending Effects'
  | 'Transitions';

export const EFFECT_CATEGORIES: EffectCategoryId[] = [
  'All',
  'Visual Effects',
  'Cinematic Effects',
  'Trending Effects',
  'Transitions',
];

export interface FilterPresetMeta {
  id: ColorFilterPreset;
  label: string;
  category: Exclude<FilterCategoryId, 'All'> | 'Original';
  description: string;
  badgeColor: string;
  css: {
    contrast: number;
    brightness: number;
    saturate: number;
    sepia: number;
    hueRotateDeg: number;
    grayscale: number;
  };
  tintOverlay?: string;
  vignetteAlpha?: number;
  grainAlpha?: number;
  fadeAlpha?: number;
}

export const FILTER_PRESETS_CATALOG: FilterPresetMeta[] = [
  {
    id: 'none',
    label: 'Original',
    category: 'Original',
    description: 'Unfiltered original source video',
    badgeColor: '#52525B',
    css: { contrast: 1, brightness: 1, saturate: 1, sepia: 0, hueRotateDeg: 0, grayscale: 0 },
  },

  // === CINEMATIC (10) ===
  {
    id: 'cinematic',
    label: 'Cinematic',
    category: 'Cinematic',
    description: 'Cool slate shadows, warm highlights & subtle vignette',
    badgeColor: '#0EA5E9',
    css: { contrast: 1.18, brightness: 0.98, saturate: 1.1, sepia: 0.08, hueRotateDeg: -4, grayscale: 0 },
    tintOverlay: 'rgba(14, 165, 233, 0.06)',
    vignetteAlpha: 0.34,
  },
  {
    id: 'teal-orange',
    label: 'Teal & Orange',
    category: 'Cinematic',
    description: 'Signature Hollywood cyan shadows and amber skin tones',
    badgeColor: '#06B6D4',
    css: { contrast: 1.22, brightness: 0.98, saturate: 1.24, sepia: 0.14, hueRotateDeg: -10, grayscale: 0 },
    tintOverlay: 'rgba(6, 182, 212, 0.09)',
    vignetteAlpha: 0.3,
  },
  {
    id: 'hollywood',
    label: 'Hollywood',
    category: 'Cinematic',
    description: 'Theatrical punchy midtones and crisp highlights',
    badgeColor: '#F59E0B',
    css: { contrast: 1.26, brightness: 0.97, saturate: 1.14, sepia: 0.1, hueRotateDeg: -5, grayscale: 0 },
    tintOverlay: 'rgba(245, 158, 11, 0.07)',
    vignetteAlpha: 0.38,
  },
  {
    id: 'film-look',
    label: 'Film Look',
    category: 'Cinematic',
    description: 'Balanced cinema print curves with soft highlight rolloff',
    badgeColor: '#EAB308',
    css: { contrast: 1.14, brightness: 1.01, saturate: 1.04, sepia: 0.12, hueRotateDeg: -2, grayscale: 0 },
    fadeAlpha: 0.04,
  },
  {
    id: 'movie-warm',
    label: 'Movie Warm',
    category: 'Cinematic',
    description: 'Rich amber cinema palette for drama and romance',
    badgeColor: '#EA580C',
    css: { contrast: 1.16, brightness: 1.0, saturate: 1.16, sepia: 0.24, hueRotateDeg: -7, grayscale: 0 },
    tintOverlay: 'rgba(234, 88, 12, 0.09)',
    vignetteAlpha: 0.3,
  },
  {
    id: 'movie-cold',
    label: 'Movie Cold',
    category: 'Cinematic',
    description: 'Steel-blue thriller grading with crisp shadow detail',
    badgeColor: '#38BDF8',
    css: { contrast: 1.18, brightness: 0.96, saturate: 0.88, sepia: 0, hueRotateDeg: 14, grayscale: 0 },
    tintOverlay: 'rgba(56, 189, 248, 0.11)',
    vignetteAlpha: 0.32,
  },
  {
    id: 'dramatic',
    label: 'Dramatic',
    category: 'Cinematic',
    description: 'High-impact contrast, deep blacks & intense highlights',
    badgeColor: '#EF4444',
    css: { contrast: 1.38, brightness: 0.93, saturate: 1.14, sepia: 0.05, hueRotateDeg: -4, grayscale: 0 },
    vignetteAlpha: 0.44,
  },
  {
    id: 'dark-cinematic',
    label: 'Dark Cinematic',
    category: 'Cinematic',
    description: 'Low-key obsidian shadows and brooding cinema mood',
    badgeColor: '#334155',
    css: { contrast: 1.3, brightness: 0.82, saturate: 0.8, sepia: 0.04, hueRotateDeg: 6, grayscale: 0 },
    vignetteAlpha: 0.48,
  },
  {
    id: 'moody',
    label: 'Moody',
    category: 'Cinematic',
    description: 'Muted emerald-slate atmosphere with lifted deep blacks',
    badgeColor: '#475569',
    css: { contrast: 1.2, brightness: 0.88, saturate: 0.78, sepia: 0.08, hueRotateDeg: 8, grayscale: 0 },
    tintOverlay: 'rgba(51, 65, 85, 0.1)',
    vignetteAlpha: 0.36,
  },
  {
    id: 'epic',
    label: 'Epic',
    category: 'Cinematic',
    description: 'Widescreen blockbuster clarity, rich gold & deep cyan',
    badgeColor: '#B91C1C',
    css: { contrast: 1.32, brightness: 0.95, saturate: 1.22, sepia: 0.1, hueRotateDeg: -6, grayscale: 0 },
    tintOverlay: 'rgba(217, 119, 6, 0.08)',
    vignetteAlpha: 0.42,
  },

  // === COLOR & LIGHTING (12) ===
  {
    id: 'warm',
    label: 'Warm',
    category: 'Color & Lighting',
    description: 'Golden amber midtones and welcoming sunlight warmth',
    badgeColor: '#F97316',
    css: { contrast: 1.06, brightness: 1.03, saturate: 1.16, sepia: 0.22, hueRotateDeg: -6, grayscale: 0 },
    tintOverlay: 'rgba(249, 115, 22, 0.08)',
  },
  {
    id: 'cool',
    label: 'Cool',
    category: 'Color & Lighting',
    description: 'Refreshing cyan-blue balance and clean crisp whites',
    badgeColor: '#60A5FA',
    css: { contrast: 1.08, brightness: 1.0, saturate: 0.94, sepia: 0, hueRotateDeg: 11, grayscale: 0 },
    tintOverlay: 'rgba(96, 165, 250, 0.08)',
  },
  {
    id: 'vintage',
    label: 'Vintage',
    category: 'Color & Lighting',
    description: 'Faded blacks and warm sepia-tinted nostalgia',
    badgeColor: '#D97706',
    css: { contrast: 0.92, brightness: 1.03, saturate: 0.76, sepia: 0.36, hueRotateDeg: -5, grayscale: 0 },
    tintOverlay: 'rgba(217, 119, 6, 0.08)',
    vignetteAlpha: 0.28,
    fadeAlpha: 0.08,
  },
  {
    id: 'faded',
    label: 'Faded',
    category: 'Color & Lighting',
    description: 'Soft matte blacks with airy low-contrast tones',
    badgeColor: '#94A3B8',
    css: { contrast: 0.84, brightness: 1.08, saturate: 0.82, sepia: 0.1, hueRotateDeg: 0, grayscale: 0 },
    fadeAlpha: 0.12,
  },
  {
    id: 'bright',
    label: 'Bright',
    category: 'Color & Lighting',
    description: 'Luminous high-key exposure with lively color pop',
    badgeColor: '#FDE047',
    css: { contrast: 1.06, brightness: 1.16, saturate: 1.18, sepia: 0, hueRotateDeg: 0, grayscale: 0 },
  },
  {
    id: 'contrast',
    label: 'Contrast',
    category: 'Color & Lighting',
    description: 'Balanced punchy S-curve contrast without crushing highlights',
    badgeColor: '#6366F1',
    css: { contrast: 1.22, brightness: 1.0, saturate: 1.08, sepia: 0, hueRotateDeg: 0, grayscale: 0 },
  },
  {
    id: 'high-contrast',
    label: 'High Contrast',
    category: 'Color & Lighting',
    description: 'Bold darks and luminous whites for crisp impact',
    badgeColor: '#F43F5E',
    css: { contrast: 1.38, brightness: 0.97, saturate: 1.15, sepia: 0, hueRotateDeg: 0, grayscale: 0 },
  },
  {
    id: 'desaturated',
    label: 'Desaturated',
    category: 'Color & Lighting',
    description: 'Muted low-chroma palette for subtle editorial stories',
    badgeColor: '#71717A',
    css: { contrast: 1.08, brightness: 0.99, saturate: 0.52, sepia: 0.06, hueRotateDeg: 0, grayscale: 0 },
  },
  {
    id: 'vibrant',
    label: 'Vibrant',
    category: 'Color & Lighting',
    description: 'Rich saturated hues with crisp micro-contrast',
    badgeColor: '#EC4899',
    css: { contrast: 1.14, brightness: 1.03, saturate: 1.46, sepia: 0, hueRotateDeg: 0, grayscale: 0 },
  },
  {
    id: 'pastel',
    label: 'Pastel',
    category: 'Color & Lighting',
    description: 'Soft dreamy highlights and gentle cotton-candy tones',
    badgeColor: '#F9A8D4',
    css: { contrast: 0.9, brightness: 1.1, saturate: 0.92, sepia: 0.1, hueRotateDeg: -6, grayscale: 0 },
    tintOverlay: 'rgba(249, 168, 212, 0.09)',
    fadeAlpha: 0.07,
  },
  {
    id: 'golden-hour',
    label: 'Golden Hour',
    category: 'Color & Lighting',
    description: 'Warm late-afternoon sunlight and glowing amber skin',
    badgeColor: '#FBBF24',
    css: { contrast: 1.1, brightness: 1.06, saturate: 1.24, sepia: 0.28, hueRotateDeg: -8, grayscale: 0 },
    tintOverlay: 'rgba(251, 191, 36, 0.11)',
  },
  {
    id: 'sunset',
    label: 'Sunset',
    category: 'Color & Lighting',
    description: 'Deep magenta-orange dusk glow across highlights',
    badgeColor: '#FB7185',
    css: { contrast: 1.16, brightness: 0.98, saturate: 1.32, sepia: 0.24, hueRotateDeg: -14, grayscale: 0 },
    tintOverlay: 'rgba(251, 113, 133, 0.11)',
    vignetteAlpha: 0.24,
  },

  // === FILM & RETRO (10) ===
  {
    id: '35mm-film',
    label: '35mm Film',
    category: 'Film & Retro',
    description: 'Classic silver-halide contrast with subtle analog grain',
    badgeColor: '#CA8A04',
    css: { contrast: 1.14, brightness: 1.0, saturate: 1.05, sepia: 0.12, hueRotateDeg: 0, grayscale: 0 },
    grainAlpha: 0.16,
  },
  {
    id: '16mm-film',
    label: '16mm Film',
    category: 'Film & Retro',
    description: 'Gritty indie cinema stock with lifted blacks and rich grain',
    badgeColor: '#B45309',
    css: { contrast: 1.18, brightness: 0.97, saturate: 0.9, sepia: 0.2, hueRotateDeg: -3, grayscale: 0 },
    vignetteAlpha: 0.32,
    grainAlpha: 0.28,
    fadeAlpha: 0.06,
  },
  {
    id: 'vhs',
    label: 'VHS',
    category: 'Film & Retro',
    description: 'Analog magnetic tape wash with magenta-cyan tint',
    badgeColor: '#9333EA',
    css: { contrast: 1.1, brightness: 1.02, saturate: 1.18, sepia: 0.14, hueRotateDeg: -12, grayscale: 0 },
    tintOverlay: 'rgba(147, 51, 234, 0.09)',
    grainAlpha: 0.22,
  },
  {
    id: 'retro',
    label: 'Retro',
    category: 'Film & Retro',
    description: '80s synth warmth and bold nostalgic color balance',
    badgeColor: '#A855F7',
    css: { contrast: 1.14, brightness: 1.02, saturate: 1.24, sepia: 0.24, hueRotateDeg: -14, grayscale: 0 },
    tintOverlay: 'rgba(168, 85, 247, 0.09)',
    vignetteAlpha: 0.26,
  },
  {
    id: 'old-film',
    label: 'Old Film',
    category: 'Film & Retro',
    description: 'Aged archival print with warm fade, grain & vignette',
    badgeColor: '#78350F',
    css: { contrast: 1.08, brightness: 0.98, saturate: 0.56, sepia: 0.5, hueRotateDeg: -4, grayscale: 0.15 },
    vignetteAlpha: 0.42,
    grainAlpha: 0.34,
    fadeAlpha: 0.09,
  },
  {
    id: 'sepia',
    label: 'Sepia',
    category: 'Film & Retro',
    description: 'Warm monochrome brown-toned archival print',
    badgeColor: '#92400E',
    css: { contrast: 1.1, brightness: 1.0, saturate: 0.72, sepia: 0.85, hueRotateDeg: 0, grayscale: 0 },
    vignetteAlpha: 0.26,
  },
  {
    id: 'black-white',
    label: 'Black & White',
    category: 'Film & Retro',
    description: 'Crisp high-contrast silver screen monochrome',
    badgeColor: '#A1A1AA',
    css: { contrast: 1.28, brightness: 0.98, saturate: 0, sepia: 0, hueRotateDeg: 0, grayscale: 1 },
  },
  {
    id: 'noir',
    label: 'Noir',
    category: 'Film & Retro',
    description: 'Deep dramatic B&W shadows with heavy edge vignette',
    badgeColor: '#27272A',
    css: { contrast: 1.5, brightness: 0.88, saturate: 0, sepia: 0.04, hueRotateDeg: 0, grayscale: 1 },
    vignetteAlpha: 0.56,
  },
  {
    id: 'grainy-film',
    label: 'Grainy Film',
    category: 'Film & Retro',
    description: 'Textured high-ISO analog emulsion with matte midtones',
    badgeColor: '#57534E',
    css: { contrast: 1.12, brightness: 0.99, saturate: 0.88, sepia: 0.16, hueRotateDeg: 0, grayscale: 0 },
    grainAlpha: 0.4,
    fadeAlpha: 0.05,
  },
  {
    id: 'polaroid',
    label: 'Polaroid',
    category: 'Film & Retro',
    description: 'Creamy instant-print greens/yellows and faded blacks',
    badgeColor: '#10B981',
    css: { contrast: 0.96, brightness: 1.06, saturate: 0.94, sepia: 0.26, hueRotateDeg: 8, grayscale: 0 },
    tintOverlay: 'rgba(16, 185, 129, 0.06)',
    fadeAlpha: 0.08,
  },

  // === SOCIAL MEDIA & TRENDING (10) ===
  {
    id: 'instagram',
    label: 'Instagram Style',
    category: 'Social Media & Trending',
    description: 'Warm airy feed aesthetic with clean lifted contrast',
    badgeColor: '#E1306C',
    css: { contrast: 1.12, brightness: 1.05, saturate: 1.22, sepia: 0.14, hueRotateDeg: -5, grayscale: 0 },
    tintOverlay: 'rgba(225, 48, 108, 0.05)',
  },
  {
    id: 'tiktok',
    label: 'TikTok Style',
    category: 'Social Media & Trending',
    description: 'Crisp high-clarity pop engineered for short-form feeds',
    badgeColor: '#00F2EA',
    css: { contrast: 1.2, brightness: 1.04, saturate: 1.32, sepia: 0, hueRotateDeg: 3, grayscale: 0 },
    tintOverlay: 'rgba(0, 242, 234, 0.05)',
  },
  {
    id: 'clean',
    label: 'Clean',
    category: 'Social Media & Trending',
    description: 'Neutral modern studio whites and balanced saturation',
    badgeColor: '#E4E4E7',
    css: { contrast: 1.07, brightness: 1.04, saturate: 1.06, sepia: 0, hueRotateDeg: 0, grayscale: 0 },
  },
  {
    id: 'aesthetic',
    label: 'Aesthetic',
    category: 'Social Media & Trending',
    description: 'Muted pastel tones, gentle warmth & editorial matte curve',
    badgeColor: '#C084FC',
    css: { contrast: 0.94, brightness: 1.05, saturate: 0.88, sepia: 0.16, hueRotateDeg: -8, grayscale: 0 },
    tintOverlay: 'rgba(192, 132, 252, 0.08)',
    fadeAlpha: 0.06,
  },
  {
    id: 'soft-glow',
    label: 'Soft Glow',
    category: 'Social Media & Trending',
    description: 'Luminous skin highlights with gentle halation softness',
    badgeColor: '#FDE68A',
    css: { contrast: 0.98, brightness: 1.11, saturate: 1.1, sepia: 0.1, hueRotateDeg: -3, grayscale: 0 },
    tintOverlay: 'rgba(254, 240, 138, 0.09)',
  },
  {
    id: 'dreamy',
    label: 'Dreamy',
    category: 'Social Media & Trending',
    description: 'Ethereal lavender warmth and airy lifted blacks',
    badgeColor: '#818CF8',
    css: { contrast: 0.92, brightness: 1.09, saturate: 1.04, sepia: 0.14, hueRotateDeg: -10, grayscale: 0 },
    tintOverlay: 'rgba(129, 140, 248, 0.1)',
    fadeAlpha: 0.08,
  },
  {
    id: 'neon',
    label: 'Neon',
    category: 'Social Media & Trending',
    description: 'Electric magenta-violet highlights for nightlife clips',
    badgeColor: '#D946EF',
    css: { contrast: 1.24, brightness: 1.02, saturate: 1.54, sepia: 0, hueRotateDeg: 18, grayscale: 0 },
    tintOverlay: 'rgba(217, 70, 239, 0.11)',
    vignetteAlpha: 0.26,
  },
  {
    id: 'cyberpunk',
    label: 'Cyberpunk',
    category: 'Social Media & Trending',
    description: 'High-contrast electric teal & magenta neon grading',
    badgeColor: '#22D3EE',
    css: { contrast: 1.3, brightness: 0.96, saturate: 1.48, sepia: 0, hueRotateDeg: 26, grayscale: 0 },
    tintOverlay: 'rgba(34, 211, 238, 0.1)',
    vignetteAlpha: 0.36,
  },
  {
    id: 'orange-blue',
    label: 'Orange & Blue',
    category: 'Social Media & Trending',
    description: 'Punchy dual-tone orange skin vs deep sapphire shadows',
    badgeColor: '#FB923C',
    css: { contrast: 1.22, brightness: 1.0, saturate: 1.3, sepia: 0.16, hueRotateDeg: -12, grayscale: 0 },
    tintOverlay: 'rgba(59, 130, 246, 0.08)',
  },
  {
    id: 'viral',
    label: 'Viral Look',
    category: 'Social Media & Trending',
    description: 'Ultra-crisp contrast & punch tuned to pop on mobile',
    badgeColor: '#F43F5E',
    css: { contrast: 1.28, brightness: 1.04, saturate: 1.38, sepia: 0.04, hueRotateDeg: -3, grayscale: 0 },
    vignetteAlpha: 0.2,
  },

  // === ADDITIONAL STYLES (8) ===
  {
    id: 'portrait',
    label: 'Portrait',
    category: 'Additional Styles',
    description: 'Flattering natural skin warmth and gentle contrast',
    badgeColor: '#FB7185',
    css: { contrast: 1.05, brightness: 1.06, saturate: 1.08, sepia: 0.1, hueRotateDeg: -3, grayscale: 0 },
    tintOverlay: 'rgba(251, 113, 133, 0.05)',
  },
  {
    id: 'nature',
    label: 'Nature',
    category: 'Additional Styles',
    description: 'Lush greens, deep sky blues & crisp outdoor clarity',
    badgeColor: '#22C55E',
    css: { contrast: 1.12, brightness: 1.02, saturate: 1.32, sepia: 0, hueRotateDeg: 6, grayscale: 0 },
    tintOverlay: 'rgba(34, 197, 94, 0.05)',
  },
  {
    id: 'night',
    label: 'Night',
    category: 'Additional Styles',
    description: 'Deep indigo shadows with preserved street-light glow',
    badgeColor: '#3B82F6',
    css: { contrast: 1.22, brightness: 0.86, saturate: 0.92, sepia: 0, hueRotateDeg: 14, grayscale: 0 },
    tintOverlay: 'rgba(30, 64, 175, 0.14)',
    vignetteAlpha: 0.42,
  },
  {
    id: 'urban',
    label: 'Urban',
    category: 'Additional Styles',
    description: 'Gritty concrete contrast with desaturated steel tones',
    badgeColor: '#64748B',
    css: { contrast: 1.24, brightness: 0.96, saturate: 0.78, sepia: 0.04, hueRotateDeg: 6, grayscale: 0 },
    vignetteAlpha: 0.28,
  },
  {
    id: 'sports',
    label: 'Sports',
    category: 'Additional Styles',
    description: 'High-energy punchy contrast and vibrant jersey colors',
    badgeColor: '#EF4444',
    css: { contrast: 1.28, brightness: 1.03, saturate: 1.34, sepia: 0, hueRotateDeg: 0, grayscale: 0 },
  },
  {
    id: 'documentary',
    label: 'Documentary',
    category: 'Additional Styles',
    description: 'Neutral journalistic realism with honest dynamic range',
    badgeColor: '#14B8A6',
    css: { contrast: 1.1, brightness: 0.99, saturate: 0.88, sepia: 0.02, hueRotateDeg: 4, grayscale: 0 },
  },
  {
    id: 'travel',
    label: 'Travel',
    category: 'Additional Styles',
    description: 'Sunlit turquoise skies and vivid landscape contrast',
    badgeColor: '#0EA5E9',
    css: { contrast: 1.16, brightness: 1.04, saturate: 1.28, sepia: 0.08, hueRotateDeg: -4, grayscale: 0 },
    tintOverlay: 'rgba(14, 165, 233, 0.06)',
  },
  {
    id: 'wedding',
    label: 'Wedding',
    category: 'Additional Styles',
    description: 'Airy ivory highlights, creamy skin & romantic warmth',
    badgeColor: '#FDA4AF',
    css: { contrast: 0.98, brightness: 1.08, saturate: 0.98, sepia: 0.14, hueRotateDeg: -4, grayscale: 0 },
    tintOverlay: 'rgba(255, 241, 242, 0.09)',
    fadeAlpha: 0.05,
  },
];

// Backward-compatible legacy filter aliases mapped cleanly to canonical catalog entries
const FILTER_LEGACY_MAP: Record<string, ColorFilterPreset> = {
  movie: 'hollywood',
  film: '35mm-film',
  dark: 'dark-cinematic',
  cold: 'movie-cold',
  natural: 'clean',
};

export function normalizeFilterPresetId(preset?: ColorFilterPreset): ColorFilterPreset {
  if (!preset) return 'none';
  return FILTER_LEGACY_MAP[preset] || preset;
}

export function getFilterPresetMeta(preset?: ColorFilterPreset): FilterPresetMeta {
  const norm = normalizeFilterPresetId(preset);
  return FILTER_PRESETS_CATALOG.find((p) => p.id === norm) || FILTER_PRESETS_CATALOG[0];
}

export function lerpNum(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

export function buildFilterCssWithIntensity(
  preset: ColorFilterPreset | undefined,
  intensityPct = 100
): {
  filterCss: string;
  vignetteAlpha: number;
  tintOverlay?: string;
  grainAlpha: number;
  fadeAlpha: number;
} {
  const meta = getFilterPresetMeta(preset);
  if (meta.id === 'none' || intensityPct <= 0) {
    return { filterCss: '', vignetteAlpha: 0, grainAlpha: 0, fadeAlpha: 0 };
  }
  const k = Math.max(0, Math.min(1, intensityPct / 100));
  const c = lerpNum(1, meta.css.contrast, k);
  const b = lerpNum(1, meta.css.brightness, k);
  const s = lerpNum(1, meta.css.saturate, k);
  const sep = lerpNum(0, meta.css.sepia, k);
  const hue = lerpNum(0, meta.css.hueRotateDeg, k);
  const gray = lerpNum(0, meta.css.grayscale, k);

  const parts: string[] = [];
  if (Math.abs(c - 1) > 0.005) parts.push(`contrast(${c.toFixed(3)})`);
  if (Math.abs(b - 1) > 0.005) parts.push(`brightness(${b.toFixed(3)})`);
  if (Math.abs(s - 1) > 0.005) parts.push(`saturate(${s.toFixed(3)})`);
  if (sep > 0.005) parts.push(`sepia(${sep.toFixed(3)})`);
  if (Math.abs(hue) > 0.1) parts.push(`hue-rotate(${hue.toFixed(1)}deg)`);
  if (gray > 0.005) parts.push(`grayscale(${gray.toFixed(3)})`);

  return {
    filterCss: parts.join(' '),
    vignetteAlpha: (meta.vignetteAlpha || 0) * k,
    tintOverlay: meta.tintOverlay,
    grainAlpha: (meta.grainAlpha || 0) * k,
    fadeAlpha: (meta.fadeAlpha || 0) * k,
  };
}

export function buildAdjustmentsCss(adj?: Partial<ColorAdjustments>): string {
  if (!adj) return '';
  const parts: string[] = [];
  const bright =
    1 +
    ((adj.brightness || 0) + (adj.exposure || 0) * 0.7 + (adj.highlights || 0) * 0.15 + (adj.shadows || 0) * 0.15) /
      100;
  const cont = 1 + ((adj.contrast || 0) + (adj.sharpness || 0) * 0.18 + ((adj.highlights || 0) - (adj.shadows || 0)) * 0.12) / 100;
  const sat = Math.max(
    0,
    (1 + (adj.saturation || 0) / 100) *
      ((adj.fade || 0) > 0 ? Math.max(0.45, 1 - (adj.fade || 0) * 0.004) : 1)
  );
  if (Math.abs(bright - 1) > 0.005) parts.push(`brightness(${Math.max(0.25, bright).toFixed(2)})`);
  if (Math.abs(cont - 1) > 0.005) parts.push(`contrast(${Math.max(0.25, cont).toFixed(2)})`);
  if (Math.abs(sat - 1) > 0.005) parts.push(`saturate(${sat.toFixed(2)})`);
  if ((adj.temperature || 0) > 0) parts.push(`sepia(${((adj.temperature || 0) / 220).toFixed(2)})`);
  if ((adj.temperature || 0) < 0 || (adj.tint || 0) !== 0) {
    parts.push(
      `hue-rotate(${Math.round(((adj.temperature || 0) * -0.15) + (adj.tint || 0) * 0.25)}deg)`
    );
  }
  return parts.join(' ');
}

export function isFilterLayerActiveAtTime(
  layer: FilterLayerItem,
  time: number,
  activeClipId?: string
): boolean {
  if (!layer.enabled || layer.preset === 'none' || layer.intensity <= 0) return false;
  if (layer.clipIds && layer.clipIds.length > 0) {
    if (activeClipId && !layer.clipIds.includes(activeClipId)) {
      return false;
    }
  }
  const s = Math.max(0, layer.startTime || 0);
  const e = layer.endTime || 0;
  return time >= s - 0.01 && (e > s ? time <= e + 0.01 : true);
}

export function resolveCombinedVideoFilter(params: {
  effectsConfig?: VideoEffectsConfig;
  clipFilterPreset?: ColorFilterPreset;
  clipFilterIntensity?: number;
  currentTime?: number;
  activeClipId?: string;
}): {
  filterCss: string;
  vignetteAlpha: number;
  tintOverlay?: string;
  tintOverlays: string[];
  grainAlpha: number;
  fadeAlpha: number;
} {
  const cfg = params.effectsConfig;
  if (cfg?.compareMode) {
    return { filterCss: '', vignetteAlpha: 0, tintOverlays: [], grainAlpha: 0, fadeAlpha: 0 };
  }

  const time = params.currentTime ?? 0;
  const activePreset =
    params.clipFilterPreset && params.clipFilterPreset !== 'none'
      ? params.clipFilterPreset
      : cfg?.filterPreset || 'none';
  const activeIntensity =
    params.clipFilterPreset && params.clipFilterPreset !== 'none'
      ? params.clipFilterIntensity ?? 100
      : cfg?.filterIntensity ?? 100;

  const basePresetRes = buildFilterCssWithIntensity(activePreset, activeIntensity);
  const cssParts: string[] = [];
  const tintOverlays: string[] = [];
  let maxVignette = basePresetRes.vignetteAlpha;
  let maxGrain = basePresetRes.grainAlpha;
  let maxFade = basePresetRes.fadeAlpha;

  if (basePresetRes.filterCss) cssParts.push(basePresetRes.filterCss);
  if (basePresetRes.tintOverlay) tintOverlays.push(basePresetRes.tintOverlay);

  // Stack compatible active FilterLayerItem entries from filterStack
  for (const layer of cfg?.filterStack || []) {
    if (!isFilterLayerActiveAtTime(layer, time, params.activeClipId)) continue;
    const layerRes = buildFilterCssWithIntensity(layer.preset, layer.intensity);
    if (layerRes.filterCss) cssParts.push(layerRes.filterCss);
    if (layerRes.tintOverlay) tintOverlays.push(layerRes.tintOverlay);
    maxVignette = Math.max(maxVignette, layerRes.vignetteAlpha);
    maxGrain = Math.max(maxGrain, layerRes.grainAlpha);
    maxFade = Math.max(maxFade, layerRes.fadeAlpha);
  }

  const adjCss = buildAdjustmentsCss(cfg?.adjustments);
  if (adjCss) cssParts.push(adjCss);

  const adjVignette = Math.max(0, Math.min(0.65, ((cfg?.adjustments?.vignette || 0) / 100) * 0.6));
  const adjGrain = Math.max(0, Math.min(0.65, ((cfg?.adjustments?.grain || 0) / 100) * 0.55));
  const adjFade = Math.max(0, Math.min(0.32, ((cfg?.adjustments?.fade || 0) / 100) * 0.28));

  return {
    filterCss: cssParts.join(' '),
    vignetteAlpha: Math.min(0.85, Math.max(maxVignette, adjVignette)),
    tintOverlay: tintOverlays[0],
    tintOverlays,
    grainAlpha: Math.min(0.7, Math.max(maxGrain, adjGrain)),
    fadeAlpha: Math.min(0.35, Math.max(maxFade, adjFade)),
  };
}

export interface VideoEffectCatalogEntry {
  type: VisualEffectType;
  label: string;
  category: Exclude<EffectCategoryId, 'All'>;
  description: string;
  defaultIntensity: number;
  defaultDurationSec: number;
  supportsOpacity?: boolean;
  supportsSpeed?: boolean;
  supportsFadeDurations?: boolean;
  supportsPosition?: boolean;
  supportsDirection?: boolean;
  supportsBlockSize?: boolean;
  supportsHueShift?: boolean;
  accent: string;
}

export const VIDEO_EFFECTS_CATALOG: VideoEffectCatalogEntry[] = [
  // === VISUAL EFFECTS (18) ===
  {
    type: 'glow',
    label: 'Glow',
    category: 'Visual Effects',
    description: 'Luminous highlight halation bloom',
    defaultIntensity: 55,
    defaultDurationSec: 4,
    supportsOpacity: true,
    accent: '#FACC15',
  },
  {
    type: 'soft-glow',
    label: 'Soft Glow',
    category: 'Visual Effects',
    description: 'Velvety low-threshold highlight halo',
    defaultIntensity: 50,
    defaultDurationSec: 4,
    supportsOpacity: true,
    accent: '#FDE68A',
  },
  {
    type: 'bloom',
    label: 'Bloom',
    category: 'Visual Effects',
    description: 'Bright optical light bleed over highlights',
    defaultIntensity: 60,
    defaultDurationSec: 4,
    supportsOpacity: true,
    accent: '#FBBF24',
  },
  {
    type: 'blur',
    label: 'Blur',
    category: 'Visual Effects',
    description: 'Clean full-frame optical defocus',
    defaultIntensity: 40,
    defaultDurationSec: 3,
    supportsOpacity: true,
    accent: '#3B82F6',
  },
  {
    type: 'motion-blur',
    label: 'Motion Blur',
    category: 'Visual Effects',
    description: 'Temporal frame blending for fluid movement',
    defaultIntensity: 50,
    defaultDurationSec: 3,
    supportsOpacity: true,
    accent: '#06B6D4',
  },
  {
    type: 'gaussian-blur',
    label: 'Gaussian Blur',
    category: 'Visual Effects',
    description: 'Silky multi-pass Gaussian lens blur',
    defaultIntensity: 48,
    defaultDurationSec: 3,
    supportsOpacity: true,
    accent: '#60A5FA',
  },
  {
    type: 'pixelate',
    label: 'Pixelate',
    category: 'Visual Effects',
    description: 'Crisp retro pixel grid quantization',
    defaultIntensity: 55,
    defaultDurationSec: 3,
    supportsOpacity: true,
    supportsBlockSize: true,
    accent: '#8B5CF6',
  },
  {
    type: 'mosaic',
    label: 'Mosaic',
    category: 'Visual Effects',
    description: 'Large stylized tile mosaic blocks',
    defaultIntensity: 60,
    defaultDurationSec: 3,
    supportsOpacity: true,
    supportsBlockSize: true,
    accent: '#6366F1',
  },
  {
    type: 'sharpen',
    label: 'Sharpen',
    category: 'Visual Effects',
    description: 'Unsharp micro-contrast detail boost',
    defaultIntensity: 55,
    defaultDurationSec: 4,
    supportsOpacity: true,
    accent: '#10B981',
  },
  {
    type: 'vignette',
    label: 'Vignette',
    category: 'Visual Effects',
    description: 'Adjustable darkened perimeter framing',
    defaultIntensity: 60,
    defaultDurationSec: 5,
    supportsOpacity: true,
    supportsPosition: true,
    accent: '#64748B',
  },
  {
    type: 'chromatic-aberration',
    label: 'Chromatic Aberration',
    category: 'Visual Effects',
    description: 'Optical red/cyan prism fringe offset',
    defaultIntensity: 55,
    defaultDurationSec: 3,
    supportsOpacity: true,
    accent: '#EC4899',
  },
  {
    type: 'rgb-split',
    label: 'RGB Split',
    category: 'Visual Effects',
    description: 'Bold separated R/G/B color channels',
    defaultIntensity: 55,
    defaultDurationSec: 3,
    supportsOpacity: true,
    accent: '#F43F5E',
  },
  {
    type: 'glitch',
    label: 'Glitch',
    category: 'Visual Effects',
    description: 'Intermittent RGB tear bursts & static jitter',
    defaultIntensity: 60,
    defaultDurationSec: 2.5,
    supportsOpacity: true,
    supportsSpeed: true,
    accent: '#E11D48',
  },
  {
    type: 'distortion',
    label: 'Distortion',
    category: 'Visual Effects',
    description: 'Dynamic optical warp & edge curvature',
    defaultIntensity: 50,
    defaultDurationSec: 3,
    supportsOpacity: true,
    supportsSpeed: true,
    accent: '#0EA5E9',
  },
  {
    type: 'lens-distortion',
    label: 'Lens Distortion',
    category: 'Visual Effects',
    description: 'Wide-angle fisheye barrel curvature',
    defaultIntensity: 55,
    defaultDurationSec: 4,
    supportsOpacity: true,
    supportsPosition: true,
    accent: '#38BDF8',
  },
  {
    type: 'light-leaks',
    label: 'Light Leak',
    category: 'Visual Effects',
    description: 'Warm analog film light bleed across frame',
    defaultIntensity: 55,
    defaultDurationSec: 3,
    supportsOpacity: true,
    supportsPosition: true,
    accent: '#F97316',
  },
  {
    type: 'lens-flare',
    label: 'Lens Flare',
    category: 'Visual Effects',
    description: 'Positioned anamorphic sun flare streak & glow',
    defaultIntensity: 60,
    defaultDurationSec: 3,
    supportsOpacity: true,
    supportsPosition: true,
    accent: '#FDE047',
  },
  {
    type: 'background-blur',
    label: 'Background Blur',
    category: 'Visual Effects',
    description: 'Radial shallow depth-of-field center focus',
    defaultIntensity: 55,
    defaultDurationSec: 4,
    supportsOpacity: true,
    supportsPosition: true,
    accent: '#2563EB',
  },

  // === CINEMATIC EFFECTS (12) ===
  {
    type: 'film-grain',
    label: 'Film Grain',
    category: 'Cinematic Effects',
    description: 'Organic moving celluloid grain texture',
    defaultIntensity: 48,
    defaultDurationSec: 5,
    supportsOpacity: true,
    accent: '#D97706',
  },
  {
    type: 'dust',
    label: 'Dust',
    category: 'Cinematic Effects',
    description: 'Vintage projector dust flecks & matte texture',
    defaultIntensity: 50,
    defaultDurationSec: 4,
    supportsOpacity: true,
    supportsSpeed: true,
    accent: '#A8A29E',
  },
  {
    type: 'scratches',
    label: 'Scratches',
    category: 'Cinematic Effects',
    description: 'Vertical analog print scratches & gate weave',
    defaultIntensity: 52,
    defaultDurationSec: 4,
    supportsOpacity: true,
    supportsSpeed: true,
    accent: '#78716C',
  },
  {
    type: 'film-burn',
    label: 'Film Burn',
    category: 'Cinematic Effects',
    description: 'Fiery amber edge burn exposure flare',
    defaultIntensity: 60,
    defaultDurationSec: 2,
    supportsOpacity: true,
    supportsPosition: true,
    accent: '#EA580C',
  },
  {
    type: 'light-flash',
    label: 'Light Flash',
    category: 'Cinematic Effects',
    description: 'Bright cinematic camera bulb exposure flash',
    defaultIntensity: 65,
    defaultDurationSec: 1.5,
    supportsOpacity: true,
    supportsSpeed: true,
    accent: '#FEF08A',
  },
  {
    type: 'flash-transition',
    label: 'Flash Transition',
    category: 'Cinematic Effects',
    description: 'Smooth white flash peak fade across transition window',
    defaultIntensity: 80,
    defaultDurationSec: 0.9,
    supportsOpacity: true,
    accent: '#FFFFFF',
  },
  {
    type: 'cinematic-shake',
    label: 'Cinematic Shake',
    category: 'Cinematic Effects',
    description: 'Subtle organic impact tremor & lens rumble',
    defaultIntensity: 45,
    defaultDurationSec: 2,
    supportsSpeed: true,
    accent: '#F59E0B',
  },
  {
    type: 'handheld-camera',
    label: 'Handheld Camera',
    category: 'Cinematic Effects',
    description: 'Natural slow documentary shoulder-rig sway',
    defaultIntensity: 42,
    defaultDurationSec: 5,
    supportsSpeed: true,
    accent: '#14B8A6',
  },
  {
    type: 'slow-zoom',
    label: 'Slow Zoom',
    category: 'Cinematic Effects',
    description: 'Smooth progressive Ken Burns push-in over interval',
    defaultIntensity: 40,
    defaultDurationSec: 5,
    supportsPosition: true,
    accent: '#8B5CF6',
  },
  {
    type: 'zoom',
    label: 'Zoom In',
    category: 'Cinematic Effects',
    description: 'Progressive scale punch-in centered on focus point',
    defaultIntensity: 50,
    defaultDurationSec: 3,
    supportsPosition: true,
    supportsSpeed: true,
    accent: '#7C3AED',
  },
  {
    type: 'zoom-out',
    label: 'Zoom Out',
    category: 'Cinematic Effects',
    description: 'Smooth pull-back from magnified framing to full shot',
    defaultIntensity: 50,
    defaultDurationSec: 3,
    supportsPosition: true,
    supportsSpeed: true,
    accent: '#6366F1',
  },
  {
    type: 'camera-shake',
    label: 'Camera Shake',
    category: 'Cinematic Effects',
    description: 'Energetic high-frequency kinetic shake',
    defaultIntensity: 55,
    defaultDurationSec: 2,
    supportsSpeed: true,
    accent: '#EF4444',
  },

  // === TRENDING EFFECTS (9) ===
  {
    type: 'vhs',
    label: 'VHS Glitch',
    category: 'Trending Effects',
    description: 'Scanlines, chroma tracking offset & tape static',
    defaultIntensity: 58,
    defaultDurationSec: 3,
    supportsOpacity: true,
    supportsSpeed: true,
    accent: '#A855F7',
  },
  {
    type: 'rgb-glitch',
    label: 'RGB Glitch',
    category: 'Trending Effects',
    description: 'Rapid pulsing chromatic split & digital noise',
    defaultIntensity: 62,
    defaultDurationSec: 2.5,
    supportsOpacity: true,
    supportsSpeed: true,
    accent: '#F43F5E',
  },
  {
    type: 'neon-glow',
    label: 'Neon Glow',
    category: 'Trending Effects',
    description: 'Vibrant electric highlight bloom with vivid chroma boost',
    defaultIntensity: 60,
    defaultDurationSec: 4,
    supportsOpacity: true,
    supportsHueShift: true,
    accent: '#D946EF',
  },
  {
    type: 'retro-flash',
    label: 'Retro Flash',
    category: 'Trending Effects',
    description: 'Warm vintage strobe pulse with subtle sepia glow',
    defaultIntensity: 60,
    defaultDurationSec: 2.5,
    supportsOpacity: true,
    supportsSpeed: true,
    accent: '#FB923C',
  },
  {
    type: 'digital-glitch',
    label: 'Digital Glitch',
    category: 'Trending Effects',
    description: 'Blocky pixel artifacts & crisp RGB offset snaps',
    defaultIntensity: 65,
    defaultDurationSec: 2,
    supportsOpacity: true,
    supportsSpeed: true,
    supportsBlockSize: true,
    accent: '#EC4899',
  },
  {
    type: 'color-shift',
    label: 'Color Shift',
    category: 'Trending Effects',
    description: 'Smooth or static hue rotation & vivid neon palette',
    defaultIntensity: 65,
    defaultDurationSec: 4,
    supportsOpacity: true,
    supportsSpeed: true,
    supportsHueShift: true,
    accent: '#22D3EE',
  },
  {
    type: 'dream-effect',
    label: 'Dream Effect',
    category: 'Trending Effects',
    description: 'Soft hazy bloom + pastel highlight diffusion',
    defaultIntensity: 55,
    defaultDurationSec: 4,
    supportsOpacity: true,
    accent: '#C084FC',
  },
  {
    type: 'soft-focus',
    label: 'Soft Focus',
    category: 'Trending Effects',
    description: 'Flattering Orton-style blended Gaussian softness',
    defaultIntensity: 48,
    defaultDurationSec: 4,
    supportsOpacity: true,
    accent: '#FDA4AF',
  },
  {
    type: 'beat-flash',
    label: 'Beat Flash',
    category: 'Trending Effects',
    description: 'Rhythmic beat-synced exposure & zoom pulse',
    defaultIntensity: 68,
    defaultDurationSec: 3,
    supportsOpacity: true,
    supportsSpeed: true,
    accent: '#FACC15',
  },

  // === TRANSITIONS (10) ===
  {
    type: 'fade-in',
    label: 'Fade In',
    category: 'Transitions',
    description: 'Smooth fade from black across clip start',
    defaultIntensity: 100,
    defaultDurationSec: 1.2,
    supportsOpacity: true,
    accent: '#6366F1',
  },
  {
    type: 'fade-out',
    label: 'Fade Out',
    category: 'Transitions',
    description: 'Smooth fade to black across clip end',
    defaultIntensity: 100,
    defaultDurationSec: 1.2,
    supportsOpacity: true,
    accent: '#4F46E5',
  },
  {
    type: 'cross-dissolve',
    label: 'Cross Dissolve',
    category: 'Transitions',
    description: 'Gentle dip dissolve through soft mid-blend',
    defaultIntensity: 85,
    defaultDurationSec: 1.0,
    supportsOpacity: true,
    accent: '#818CF8',
  },
  {
    type: 'fade-in-out',
    label: 'Fade In / Fade Out',
    category: 'Transitions',
    description: 'Configurable fade-in and fade-out black ramps',
    defaultIntensity: 90,
    defaultDurationSec: 4,
    supportsOpacity: true,
    supportsFadeDurations: true,
    accent: '#6366F1',
  },
  {
    type: 'zoom-transition',
    label: 'Zoom Transition',
    category: 'Transitions',
    description: 'Fast ramp zoom-in whip peak at transition midpoint',
    defaultIntensity: 75,
    defaultDurationSec: 0.9,
    supportsPosition: true,
    accent: '#A855F7',
  },
  {
    type: 'slide-transition',
    label: 'Slide',
    category: 'Transitions',
    description: 'Directional push slide reveal across transition span',
    defaultIntensity: 85,
    defaultDurationSec: 0.9,
    supportsDirection: true,
    accent: '#0EA5E9',
  },
  {
    type: 'wipe-transition',
    label: 'Wipe',
    category: 'Transitions',
    description: 'Clean directional edge curtain reveal wipe',
    defaultIntensity: 90,
    defaultDurationSec: 0.9,
    supportsDirection: true,
    accent: '#14B8A6',
  },
  {
    type: 'flash',
    label: 'Flash',
    category: 'Transitions',
    description: 'Rapid white exposure strobe beats',
    defaultIntensity: 70,
    defaultDurationSec: 1.5,
    supportsOpacity: true,
    supportsSpeed: true,
    accent: '#F8FAFC',
  },
  {
    type: 'glitch-transition',
    label: 'Glitch Transition',
    category: 'Transitions',
    description: 'Intense RGB tear & digital burst transition',
    defaultIntensity: 80,
    defaultDurationSec: 0.9,
    supportsOpacity: true,
    supportsSpeed: true,
    accent: '#EC4899',
  },
  {
    type: 'blur-transition',
    label: 'Blur Transition',
    category: 'Transitions',
    description: 'Ramped Gaussian blur whip peaking mid-transition',
    defaultIntensity: 80,
    defaultDurationSec: 1.0,
    supportsOpacity: true,
    accent: '#38BDF8',
  },
];

export function getEffectCatalogEntry(type: VisualEffectType): VideoEffectCatalogEntry {
  return VIDEO_EFFECTS_CATALOG.find((e) => e.type === type) || VIDEO_EFFECTS_CATALOG[0];
}
