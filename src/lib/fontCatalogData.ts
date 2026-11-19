export type FontCategoryId =
  | 'Modern'
  | 'Bold & Viral'
  | 'Condensed'
  | 'Clean'
  | 'Elegant'
  | 'Arabic'
  | 'Custom';

export interface FontCatalogItem {
  family: string;
  category: Exclude<FontCategoryId, 'Custom'>;
  weights: number[];
  defaultWeight: number;
  supportsItalic: boolean;
  isArabic?: boolean;
  sampleText?: string;
}

export type FontLoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

export interface FontStatusEntry {
  family: string;
  status: FontLoadStatus;
  error?: string;
  availableForExport?: boolean;
  source?: 'builtin' | 'custom' | 'system';
  loadedWeights?: number[];
}

export const FONT_CATEGORIES: FontCategoryId[] = [
  'Modern',
  'Bold & Viral',
  'Condensed',
  'Clean',
  'Elegant',
  'Arabic',
  'Custom',
];

export const BUILTIN_FONT_CATALOG: FontCatalogItem[] = [
  // Modern
  { family: 'Inter', category: 'Modern', weights: [300, 400, 500, 600, 700, 800, 900], defaultWeight: 700, supportsItalic: true },
  { family: 'Poppins', category: 'Modern', weights: [300, 400, 500, 600, 700, 800, 900], defaultWeight: 700, supportsItalic: true },
  { family: 'Montserrat', category: 'Modern', weights: [300, 400, 500, 600, 700, 800, 900], defaultWeight: 700, supportsItalic: true },
  { family: 'Manrope', category: 'Modern', weights: [300, 400, 500, 600, 700, 800], defaultWeight: 700, supportsItalic: false },
  { family: 'DM Sans', category: 'Modern', weights: [400, 500, 700, 800, 900], defaultWeight: 700, supportsItalic: true },
  { family: 'Plus Jakarta Sans', category: 'Modern', weights: [400, 500, 600, 700, 800], defaultWeight: 700, supportsItalic: true },

  // Bold and viral
  { family: 'Anton', category: 'Bold & Viral', weights: [400], defaultWeight: 400, supportsItalic: false },
  { family: 'Bebas Neue', category: 'Bold & Viral', weights: [400], defaultWeight: 400, supportsItalic: false },
  { family: 'Oswald', category: 'Bold & Viral', weights: [400, 500, 600, 700], defaultWeight: 700, supportsItalic: false },
  { family: 'Archivo Black', category: 'Bold & Viral', weights: [400], defaultWeight: 400, supportsItalic: false },
  { family: 'Impact', category: 'Bold & Viral', weights: [400, 700, 900], defaultWeight: 700, supportsItalic: false },

  // Condensed
  { family: 'Roboto Condensed', category: 'Condensed', weights: [400, 500, 700, 800, 900], defaultWeight: 700, supportsItalic: true },
  { family: 'Barlow Condensed', category: 'Condensed', weights: [400, 500, 600, 700, 800, 900], defaultWeight: 700, supportsItalic: true },
  { family: 'Teko', category: 'Condensed', weights: [400, 500, 600, 700], defaultWeight: 700, supportsItalic: false },

  // Clean
  { family: 'Roboto', category: 'Clean', weights: [300, 400, 500, 700, 900], defaultWeight: 700, supportsItalic: true },
  { family: 'Open Sans', category: 'Clean', weights: [400, 600, 700, 800], defaultWeight: 700, supportsItalic: true },
  { family: 'Lato', category: 'Clean', weights: [400, 700, 900], defaultWeight: 700, supportsItalic: true },
  { family: 'Nunito Sans', category: 'Clean', weights: [400, 600, 700, 800, 900], defaultWeight: 700, supportsItalic: true },

  // Elegant
  { family: 'Playfair Display', category: 'Elegant', weights: [400, 600, 700, 800, 900], defaultWeight: 700, supportsItalic: true },
  { family: 'Cormorant Garamond', category: 'Elegant', weights: [400, 500, 600, 700], defaultWeight: 700, supportsItalic: true },
  { family: 'Libre Baskerville', category: 'Elegant', weights: [400, 700], defaultWeight: 700, supportsItalic: true },

  // Arabic
  { family: 'Cairo', category: 'Arabic', weights: [400, 500, 600, 700, 800, 900], defaultWeight: 700, supportsItalic: false, isArabic: true, sampleText: 'ملخص فيلم مشوق جداً' },
  { family: 'Tajawal', category: 'Arabic', weights: [400, 500, 700, 800, 900], defaultWeight: 700, supportsItalic: false, isArabic: true, sampleText: 'أحداث مثيرة ومفاجئة' },
  { family: 'IBM Plex Sans Arabic', category: 'Arabic', weights: [400, 500, 600, 700], defaultWeight: 700, supportsItalic: false, isArabic: true, sampleText: 'القصة الكاملة باحترافية' },
  { family: 'Noto Sans Arabic', category: 'Arabic', weights: [400, 500, 600, 700, 800, 900], defaultWeight: 700, supportsItalic: false, isArabic: true, sampleText: 'نهاية غير متوقعة للقصة' },
  { family: 'Almarai', category: 'Arabic', weights: [400, 700, 800], defaultWeight: 700, supportsItalic: false, isArabic: true, sampleText: 'ترجمة عربية احترافية' },
  { family: 'Changa', category: 'Arabic', weights: [400, 500, 600, 700, 800], defaultWeight: 700, supportsItalic: false, isArabic: true, sampleText: 'عنوان عربي قوي وجذاب' },
  { family: 'Readex Pro', category: 'Arabic', weights: [400, 500, 600, 700], defaultWeight: 700, supportsItalic: false, isArabic: true, sampleText: 'مشهد حاسم في الفيلم' },
];

export const WEIGHT_LABELS: Record<number, string> = {
  100: '100 Thin',
  200: '200 ExtraLight',
  300: '300 Light',
  400: '400 Regular',
  500: '500 Medium',
  600: '600 SemiBold',
  700: '700 Bold',
  800: '800 ExtraBold',
  900: '900 Black',
};

export function resolveClosestSupportedWeight(family: string, desired: number): number {
  const item = BUILTIN_FONT_CATALOG.find((f) => f.family.toLowerCase() === family.toLowerCase());
  if (!item || item.weights.length === 0) return desired;
  if (item.weights.includes(desired)) return desired;
  return item.weights.reduce((best, cur) =>
    Math.abs(cur - desired) < Math.abs(best - desired) ? cur : best
  );
}
