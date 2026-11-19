export interface StudioToolMemory {
  editTab: 'transform' | 'timing' | 'background' | 'media';
  editAdvancedOpen: boolean;
  audioTab: 'mixer' | 'voice' | 'script';
  audioAdvancedOpen: boolean;
  voiceTranslationMode: 'external-gemini' | 'auto';
  captionsTab: 'templates' | 'style' | 'fonts' | 'modes' | 'segments';
  captionsAdvancedOpen: boolean;
  blurAdvancedOpen: boolean;
  overlayAdvancedOpen: boolean;
  effectsAdvancedOpen: boolean;
  adjustAdvancedOpen: boolean;
  textAdvancedOpen: boolean;
}

export const DEFAULT_TOOL_MEMORY: StudioToolMemory = {
  editTab: 'transform',
  editAdvancedOpen: false,
  audioTab: 'mixer',
  audioAdvancedOpen: false,
  voiceTranslationMode: 'external-gemini',
  captionsTab: 'templates',
  captionsAdvancedOpen: false,
  blurAdvancedOpen: false,
  overlayAdvancedOpen: false,
  effectsAdvancedOpen: false,
  adjustAdvancedOpen: false,
  textAdvancedOpen: false,
};
