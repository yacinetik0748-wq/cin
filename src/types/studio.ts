export type NavPage =
  | 'dashboard'
  | 'projects'
  | 'editor'
  | 'captions'
  | 'effects'
  | 'translator'
  | 'voice'
  | 'blur'
  | 'branding'
  | 'media'
  | 'styles'
  | 'voices'
  | 'export'
  | 'settings';

export type EditorToolCategoryId =
  | 'media'
  | 'transform'
  | 'visual'
  | 'text'
  | 'animation'
  | 'audio'
  | 'export';

export type StudioToolId =
  | 'edit'
  | 'audio'
  | 'text'
  | 'captions'
  | 'overlay'
  | 'blur'
  | 'filters'
  | 'effects'
  | 'adjust'
  | 'layers';

export type EditSubActionId =
  | 'trim'
  | 'split'
  | 'delete'
  | 'duplicate'
  | 'speed'
  | 'volume'
  | 'rotate'
  | 'crop'
  | 'flip'
  | 'draw'
  | 'style'
  | 'opacity'
  | 'motion'
  | 'lock'
  | 'visibility'
  | 'voice'
  | 'script'
  | 'sync'
  | 'music'
  | 'sfx'
  | 'mute'
  | 'unlink-audio'
  | 'more';

export type SupportedLanguage =
  | 'English'
  | 'Arabic'
  | 'French'
  | 'Spanish'
  | 'German'
  | 'Portuguese'
  | 'Italian'
  | 'Turkish'
  | 'Hindi';

export const SUPPORTED_LANGUAGES: SupportedLanguage[] = [
  'English',
  'Arabic',
  'French',
  'Spanish',
  'German',
  'Portuguese',
  'Italian',
  'Turkish',
  'Hindi',
];

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec: string | null;
  bitrate: number;
  fileSize: number;
  hasAudio: boolean;
  formatName: string;
}

export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

export interface CaptionSegment {
  id: string;
  start: number;
  end: number;
  text: string;
  translatedText?: string;
  speaker?: string;
  words?: WordTiming[];
  wordsSource?: 'actual' | 'estimated';
  styleOverride?: Partial<SubtitleStyle>;
  locked?: boolean;
}

export type SubtitleTemplate =
  | 'tiktok'
  | 'shorts'
  | 'cinematic'
  | 'minimal'
  | 'capcut'
  | 'custom'
  | (string & {});

export type CaptionDisplayMode =
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
  | 'emphasis-mode'
  // Legacy aliases kept for saved projects
  | 'phrase-chunk'
  | 'sentence'
  | 'word';

export type CaptionTextTransform = 'none' | 'uppercase' | 'lowercase';
export type CaptionHighlightBehavior = 'color' | 'box' | 'scale' | 'underline' | 'glow';

export type CaptionAnimationPreset =
  | 'none'
  | 'word-popup'
  | 'karaoke'
  | 'typewriter'
  | 'fade'
  | 'bounce'
  | 'pop'
  | 'slide-up'
  | 'scale'
  | 'highlight-sweep'
  | 'word-emphasis'
  | 'gradient-emphasis'
  | 'box-highlight';

export interface SavedSubtitlePreset {
  id: string;
  name: string;
  style: Partial<SubtitleStyle>;
}

export type PresetCategory = 'caption' | 'filter' | 'editing' | 'style';

export type StyleApplyScope = 'all' | 'filters' | 'effects' | 'captions' | 'narration';

export interface SavedStyleBlurDefaults {
  type?: BlurType;
  intensity?: number;
  radius?: number;
  opacity?: number;
  feather?: number;
  borderRadius?: number;
  shape?: 'rect' | 'ellipse';
  coordSpace?: 'video' | 'stage';
}

export interface SavedStyleLogoPref {
  presetPosition: LogoOverlay['presetPosition'];
  x: number;
  y: number;
  widthPct: number;
  opacity: number;
  rotation?: number;
  permanent: boolean;
  motion?: LogoMotionConfig;
}

export interface SavedStyleFiltersConfig {
  filterPreset: ColorFilterPreset;
  filterIntensity: number;
  filterStack: Array<Omit<FilterLayerItem, 'startTime' | 'endTime' | 'clipIds'>>;
  adjustments: ColorAdjustments;
  compareMode?: boolean;
}

export interface SavedStyleEffectsConfig {
  effects: Array<
    Omit<VisualEffectItem, 'startTime' | 'endTime' | 'clipId'> & {
      applyMode?: 'full' | 'intro' | 'outro';
      durationRatio?: number;
    }
  >;
}

export interface SavedStyleNarrationConfig {
  savedVoiceId?: string;
  fishReferenceId?: string;
  fishVoiceTitle?: string;
  narrationStyle: NarrationStyle;
  speakingSpeed: number;
  voiceVolume: number;
  preserveOriginalAudio: boolean;
  originalAudioVolume: number;
  syncMode: SyncMode;
  continuousPauseMs?: number;
  bgMusicVolume: number;
  sfxVolume?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  timingOffsetSec?: number;
  targetLanguage?: SupportedLanguage;
  preserveProperNouns?: boolean;
}

export interface SavedStyleEditorSettings {
  canvas: Partial<VideoCanvasConfig>;
  exportSettings: Partial<ExportSettings>;
  blurDefaults?: SavedStyleBlurDefaults;
  logoPreferences?: SavedStyleLogoPref[];
}

export interface SavedStylePayload {
  version: 1;
  thumbnailImageUrl?: string;
  filters: SavedStyleFiltersConfig;
  effects: SavedStyleEffectsConfig;
  captionStyle: Partial<SubtitleStyle>;
  narration: SavedStyleNarrationConfig;
  editorSettings: SavedStyleEditorSettings;
}

export interface DefaultStudioPreferences {
  autoApplyDefaultStyleOnImport: boolean;
  defaultStyleId: string | null;
  defaultTargetLanguage: SupportedLanguage;
  defaultSyncMode: SyncMode;
}

export interface StyleMissingVoiceWarning {
  styleName: string;
  missingVoiceName?: string;
  missingVoiceId: string;
  message: string;
}

export interface StudioPresetAssetRef {
  kind: 'background-image' | 'logo' | 'font' | 'thumbnail';
  label: string;
  url: string;
  filename?: string;
}

export interface StudioPreset {
  id: string;
  category: PresetCategory;
  name: string;
  description?: string;
  isDefault?: boolean;
  thumbnailStyle?: {
    bg?: string;
    fg?: string;
    accent?: string;
    sampleText?: string;
    badge?: string;
    imageUrl?: string;
  };
  payload: Record<string, unknown>;
  assetRefs?: StudioPresetAssetRef[];
  missingAssets?: StudioPresetAssetRef[];
  createdAt: string;
  updatedAt: string;
}

export interface SavedFontAsset {
  id: string;
  family: string;
  filename: string;
  url: string;
  createdAt: string;
}

export interface VideoClip {
  id: string;
  label?: string;
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number;
  speed: number; // 0.25..4.0 independent speed for this video clip only
  audioUnlinked?: boolean;
  filterPreset?: ColorFilterPreset;
  filterIntensity?: number; // 0..100
  locked?: boolean;
}

export interface OriginalAudioClip {
  id: string;
  label?: string;
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number;
  speed: number; // 0.25..4.0
  preservePitch?: boolean;
  volume?: number; // 0..2.0 clip gain multiplier
  muted?: boolean;
  linkedVideoClipId?: string;
  locked?: boolean;
}

export interface TimelineAudioClip {
  id: string;
  label?: string;
  audioUrl: string;
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number;
  speed: number; // 0.25..4.0
  preservePitch?: boolean;
  sourceDuration?: number;
  volume?: number; // 0..2.0 clip gain multiplier
  muted?: boolean;
  loop?: boolean;
  locked?: boolean;
}

export type StudioElementSelection =
  | { kind: 'video'; clipId?: string }
  | { kind: 'bg-image' }
  | { kind: 'blur'; id: string }
  | { kind: 'logo'; id: string }
  | { kind: 'captions'; segmentId?: string }
  | { kind: 'caption-element'; id: string }
  | { kind: 'audio'; track?: 'dub' | 'orig' | 'bgm' | 'sfx'; clipId?: string }
  | { kind: 'filter'; filterId?: string }
  | { kind: 'effect'; effectId?: string }
  | null;

export interface FilmstripFrame {
  url: string;
  time: number;
}

export interface ProjectAudioWaveforms {
  orig: number[];
  dub: number[];
  dubClips: Record<string, number[]>;
  bgm: number[];
  sfx: number[];
}

export type WorkflowStageId =
  | 'dashboard'
  | 'translator'
  | 'voice'
  | 'prepare'
  | 'validate'
  | 'editor'
  | 'captions'
  | 'export';

export type StageStatus = 'Not Started' | 'In Progress' | 'Completed' | 'Needs Attention';

export interface ProjectWorkflowState {
  visitedStages: WorkflowStageId[];
  completedStages: WorkflowStageId[];
  needsAttentionStages: WorkflowStageId[];
  lastModifiedStage?: WorkflowStageId;
  revisions?: {
    mediaRev?: number;
    translationRev?: number;
    voiceRev?: number;
    editorRev?: number;
    captionsRev?: number;
    exportedMediaRev?: number;
    exportedTranslationRev?: number;
    exportedVoiceRev?: number;
    exportedEditorRev?: number;
    exportedCaptionsRev?: number;
  };
}

export interface SavedFishVoice {
  id: string;
  name: string;
  voiceId: string;
  description?: string;
  language?: string;
  sampleUrl?: string;
  previewText?: string;
  validated?: boolean;
  isDefault?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CaptionSyncSnapshot {
  generatedAt: string;
  sourceMode: 'translated' | 'original';
  targetLanguage: SupportedLanguage;
  segmentTexts: Record<string, string>;
  segmentTimes?: Record<string, string>;
}

export interface CaptionElementLayer {
  id: string;
  label: string;
  text: string; // Supports fixed overlay text or '{caption}' to mirror active translated caption
  syncToCaptions?: boolean;
  startTime: number;
  endTime: number; // 0 = entire video
  visible: boolean;
  locked: boolean;
  zIndex?: number;
  style: Partial<SubtitleStyle>;
}

export interface SubtitleStyle {
  enabled: boolean; // MANDATORY: Default false - never automatic
  mode: CaptionDisplayMode;
  chunkSize?: 2 | 3 | 4; // Words per group for chunked modes
  wordsPerDisplay?: number; // 1..8 configurable words per display
  highlightBehavior?: CaptionHighlightBehavior;
  transitionDurationMs?: number; // 50..600ms animation transition duration
  timingOffsetSec?: number; // -2.0..2.0s caption display offset
  template: SubtitleTemplate;
  fontFamily: string;
  customFontId?: string;
  customFontUrl?: string;
  fontSize: number;
  fontWeight: 'normal' | 'bold' | '900';
  fontWeightNum?: number; // 100..900
  italic: boolean;
  underline: boolean;
  primaryColor: string;
  highlightColor: string;
  gradientEnabled?: boolean;
  gradientColor?: string;
  highlightBoxEnabled?: boolean;
  highlightBoxColor?: string;
  highlightBoxOpacity?: number;
  outlineColor: string;
  outlineWidth: number;
  backgroundColor: string;
  backgroundOpacity: number;
  borderRadius: number;
  paddingH: number;
  paddingV: number;
  shadowEnabled: boolean;
  shadowColor: string;
  shadowBlur: number;
  shadowOpacity?: number; // 0..1
  shadowDistance?: number; // 0..24 px
  letterSpacing: number;
  lineSpacing: number;
  textAlign: 'left' | 'center' | 'right';
  textTransform?: CaptionTextTransform;
  position: 'bottom' | 'middle' | 'top' | 'custom';
  posX: number; // 0..100 (percentage horizontal position)
  posY: number; // 0..100 (percentage vertical position)
  marginV: number;
  maxWidthPct?: number; // 25..100%
  textWrap?: boolean;
  maxLines?: number; // 1..6
  uppercase: boolean;
  useTranslated: boolean;
  animationPreset: CaptionAnimationPreset;
  opacity?: number; // 0.1..1
  rotation?: number; // -180..180 degrees
  scale?: number; // 0.5..2.5
  locked?: boolean;
  visible?: boolean;
  zIndex?: number;
  showSafeGuides?: boolean;
  favoriteFonts?: string[];
  extraElements?: CaptionElementLayer[];
  customPresets?: SavedSubtitlePreset[];
  captionSync?: CaptionSyncSnapshot;
}

export type BlurMode = 'full' | 'background' | 'selective' | 'motion';
export type BlurType = 'gaussian' | 'strong' | 'pixelate' | 'box';

export interface TrackingKeyframe {
  time: number;
  x: number; // normalized 0..1
  y: number; // normalized 0..1
  width: number; // normalized 0..1
  height: number; // normalized 0..1
}

export interface BlurSubtitleLink {
  mode: 'manual' | 'original' | 'translated';
  segmentId?: string;
  followAllCaptions?: boolean;
}

export interface BlurDetectionMeta {
  band?: 'bottom' | 'top' | 'middle';
  detectedText?: string;
  confidence?: number;
  method?: 'ocr' | 'visual' | 'hybrid';
  framesMatched?: number;
}

export interface BlurEffect {
  id: string;
  name: string;
  mode: BlurMode;
  type: BlurType;
  enabled: boolean;
  intensity: number; // 1..45
  radius: number; // 2..50
  opacity: number; // 0.1..1.0 transparency/blend
  feather?: number; // 0..30 soft edge blend
  borderRadius?: number; // 0..48 rounded corners (px on 1080p ref)
  rotation?: number; // -180..180 degrees
  locked?: boolean;
  zIndex?: number;
  startTime: number;
  endTime: number;
  x: number; // normalized 0..1
  y: number; // normalized 0..1
  width: number; // normalized 0..1
  height: number; // normalized 0..1
  shape: 'rect' | 'ellipse';
  coordSpace?: 'video' | 'stage'; // 'video' normalizes to actual video frame rect
  isSubtitleMask?: boolean;
  subtitleLink?: BlurSubtitleLink;
  detectionMeta?: BlurDetectionMeta;
  keyframes?: TrackingKeyframe[];
  maskAssetId?: string;
}

export interface DetectedSubtitleRegion {
  id: string;
  x: number; // normalized 0..1 relative to video frame
  y: number;
  width: number;
  height: number;
  startTime: number;
  endTime: number;
  band: 'bottom' | 'top' | 'middle';
  confidence: number; // 0..1
  detectedText?: string;
  method: 'ocr' | 'visual' | 'hybrid';
  framesMatched: number;
  selected: boolean;
  appliedMaskId?: string;
}

export interface SubtitleRemovalState {
  lastAnalyzedAt?: string;
  ocrAvailable?: boolean;
  method?: 'ocr' | 'visual' | 'hybrid' | 'unavailable';
  analysisMessage?: string;
  framesAnalyzed?: number;
  detections: DetectedSubtitleRegion[];
}

export type LogoMotionPattern = 'static' | 'bounce' | 'horizontal' | 'orbit' | 'custom';

export interface LogoMotionConfig {
  enabled: boolean;
  pattern: LogoMotionPattern;
  speed: number; // 0.2..3.0
  endX?: number; // normalized 0..1
  endY?: number; // normalized 0..1
}

export interface LogoOverlay {
  id: string;
  filename: string;
  url: string;
  enabled: boolean;
  x: number; // normalized 0..1 (left)
  y: number; // normalized 0..1 (top)
  widthPct: number; // 4..60 (% of video width)
  opacity: number; // 0.05..1
  rotation?: number; // -180..180 degrees
  locked?: boolean;
  zIndex?: number;
  permanent: boolean;
  startTime: number;
  endTime: number;
  presetPosition: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center' | 'custom';
  motion?: LogoMotionConfig;
}

export type VoiceGender = 'male' | 'female';
export type GeminiVoiceName = 'Puck' | 'Charon' | 'Fenrir' | 'Kore' | 'Zephyr';
export type DubbingProvider = 'fish' | 'gemini';
export type SyncMode = 'flexible' | 'original' | 'continuous';
export type NarrationStyle = 'cinematic' | 'natural';

export interface VideoExtensionHold {
  id: string;
  atVideoTime: number;
  holdDuration: number;
  segmentId: string;
  reason: string;
}

export interface TimelineAdjustedSegment {
  segmentId: string;
  originalStart: number;
  originalEnd: number;
  syncedStart: number;
  syncedEnd: number;
  audioDuration: number;
  speechDuration?: number;
  leadingSilence?: number;
  trailingSilence?: number;
  adjustmentType: 'unchanged' | 'gap-expanded' | 'shifted' | 'frame-hold';
  holdAddedSec: number;
  conflict: boolean;
  conflictReason?: string;
  visualMismatch?: boolean;
  visualMismatchReason?: string;
}

export interface SegmentGapDiagnostic {
  segmentId: string;
  originalStart: number;
  originalEnd: number;
  audioDuration: number;
  speechDuration: number;
  leadingSilence: number;
  trailingSilence: number;
  finalStart: number;
  speechEnd: number;
  gapBeforeNext: number;
  visualMismatch?: boolean;
  visualMismatchReason?: string;
  recommendedAdjustment: string;
  isUnnecessarilyLongGap: boolean;
}

export interface NarrationAuditReport {
  expectedSegmentIds: string[];
  generatedSegmentIds: string[];
  missingSegmentIds: string[];
  emptySegmentIds: string[];
  duplicateSegmentIds: string[];
  outOfOrderSegmentIds: string[];
  isComplete: boolean;
  summary: string;
}

export interface TimelineSyncPlan {
  syncMode: SyncMode;
  pauseDurationMs?: number;
  originalVideoDuration: number;
  estimatedFinalDuration: number;
  totalSpeechDuration?: number;
  totalAudioTrackDuration?: number;
  additionalDuration: number;
  conflictCount: number;
  visualMismatchCount?: number;
  adjustedCount: number;
  holds: VideoExtensionHold[];
  segments: TimelineAdjustedSegment[];
  gapDiagnostics?: SegmentGapDiagnostic[];
  narrationAudit?: NarrationAuditReport;
  warnings: string[];
  computedAt: string;
}

export interface FishVoiceModel {
  id: string;
  title: string;
  description: string;
  languages: string[];
  author: string;
  tags: string[];
  visibility?: string;
  coverImage?: string;
}

export interface GeneratedVoiceClip {
  segmentId: string;
  audioUrl: string;
  start: number;
  end: number;
  duration: number;
  speed?: number; // 0.25..4.0
  preservePitch?: boolean;
  speechDuration?: number;
  leadingSilence?: number;
  trailingSilence?: number;
  speechStartOffset?: number;
  speechEndOffset?: number;
  slotDuration?: number;
  overflowSeconds?: number;
  trimStartSec?: number;
  trimEndSec?: number;
  text: string;
  speaker?: string;
  locked?: boolean;
}

export interface VoiceConfig {
  enabled: boolean;
  provider: DubbingProvider;
  syncMode: SyncMode;
  continuousPauseMs?: number;
  targetLanguage: SupportedLanguage;
  gender: VoiceGender;
  voiceName: GeminiVoiceName;
  fishReferenceId?: string;
  fishVoiceTitle?: string;
  style: string;
  narrationStyle: NarrationStyle;
  speakingSpeed: number; // 0.25..4.0
  voiceVolume: number; // 0..2.0
  voiceMuted?: boolean;
  dubLocked?: boolean;
  timingOffsetSec: number; // -3.0..3.0
  preserveOriginalAudio: boolean;
  originalAudioEnabled?: boolean;
  originalAudioMuted?: boolean;
  originalAudioRemoved?: boolean;
  origLocked?: boolean;
  originalAudioVolume: number; // 0..2.0
  fadeInSec: number;
  fadeOutSec: number;
  bgMusicEnabled?: boolean;
  bgMusicMuted?: boolean;
  bgmLocked?: boolean;
  bgMusicFilename?: string;
  bgMusicUrl?: string;
  bgMusicVolume: number; // 0..2.0
  bgMusicClips?: TimelineAudioClip[];
  sfxEnabled?: boolean;
  sfxMuted?: boolean;
  sfxLocked?: boolean;
  sfxFilename?: string;
  sfxUrl?: string;
  sfxVolume?: number; // 0..2.0
  sfxClips?: TimelineAudioClip[];
  generatedClips: GeneratedVoiceClip[];
  fullDubUrl?: string;
  syncPlan?: TimelineSyncPlan;
}

export interface NarrationValidationConfig {
  minWordsPerSec: number;
  maxWordsPerSec: number;
  audioOverflowToleranceSec: number;
}

export type SegmentNarrationStatus = 'PASS' | 'TOO LONG' | 'TOO SHORT' | 'NEEDS REVIEW';

export interface CorrectionHistoryEntry {
  id: string;
  timestamp: string;
  source: 'word-validation' | 'audio-overflow' | 'manual';
  updatedSegmentIds: string[];
  note: string;
  beforeSnapshot: Record<string, string>;
  afterSnapshot: Record<string, string>;
}

export interface TranslationConfig {
  sourceLanguage: string;
  targetLanguage: SupportedLanguage;
  preserveProperNouns: boolean;
  lastTranslatedAt?: string;
  externalGeminiDraftJson?: string;
  validationConfig?: NarrationValidationConfig;
  correctionHistory?: CorrectionHistoryEntry[];
  pendingRegenerateSegmentIds?: string[];
}

export type ColorFilterPreset =
  | 'none'
  // Cinematic
  | 'cinematic'
  | 'teal-orange'
  | 'hollywood'
  | 'film-look'
  | 'movie-warm'
  | 'movie-cold'
  | 'dramatic'
  | 'dark-cinematic'
  | 'moody'
  | 'epic'
  | 'movie'
  | 'film'
  | 'dark'
  // Color & Lighting
  | 'warm'
  | 'cool'
  | 'cold'
  | 'vintage'
  | 'faded'
  | 'bright'
  | 'contrast'
  | 'high-contrast'
  | 'desaturated'
  | 'vibrant'
  | 'pastel'
  | 'golden-hour'
  | 'sunset'
  | 'natural'
  // Film & Retro
  | '35mm-film'
  | '16mm-film'
  | 'vhs'
  | 'retro'
  | 'old-film'
  | 'sepia'
  | 'black-white'
  | 'noir'
  | 'grainy-film'
  | 'polaroid'
  // Social Media & Trending
  | 'instagram'
  | 'tiktok'
  | 'clean'
  | 'aesthetic'
  | 'soft-glow'
  | 'dreamy'
  | 'neon'
  | 'cyberpunk'
  | 'orange-blue'
  | 'viral'
  // Additional Styles
  | 'portrait'
  | 'nature'
  | 'night'
  | 'urban'
  | 'sports'
  | 'documentary'
  | 'travel'
  | 'wedding';

export interface ColorAdjustments {
  brightness: number; // -100..100
  contrast: number; // -100..100
  saturation: number; // -100..100
  exposure: number; // -100..100
  temperature: number; // -100..100
  tint: number; // -100..100
  highlights: number; // -100..100
  shadows: number; // -100..100
  sharpness: number; // 0..100
  vignette: number; // 0..100
  fade: number; // 0..100
  grain?: number; // 0..100
}

export type VisualEffectType =
  // Visual Effects
  | 'glow'
  | 'soft-glow'
  | 'bloom'
  | 'blur'
  | 'motion-blur'
  | 'gaussian-blur'
  | 'pixelate'
  | 'mosaic'
  | 'sharpen'
  | 'vignette'
  | 'chromatic-aberration'
  | 'rgb-split'
  | 'glitch'
  | 'distortion'
  | 'lens-distortion'
  | 'light-leaks'
  | 'lens-flare'
  | 'background-blur'
  // Cinematic Effects
  | 'film-grain'
  | 'dust'
  | 'scratches'
  | 'film-burn'
  | 'light-flash'
  | 'flash-transition'
  | 'cinematic-shake'
  | 'handheld-camera'
  | 'slow-zoom'
  | 'zoom'
  | 'zoom-out'
  | 'camera-shake'
  // Trending Effects
  | 'vhs'
  | 'rgb-glitch'
  | 'neon-glow'
  | 'retro-flash'
  | 'digital-glitch'
  | 'color-shift'
  | 'dream-effect'
  | 'soft-focus'
  | 'beat-flash'
  // Transitions
  | 'fade-in'
  | 'fade-out'
  | 'fade-in-out'
  | 'cross-dissolve'
  | 'zoom-transition'
  | 'slide-transition'
  | 'wipe-transition'
  | 'flash'
  | 'glitch-transition'
  | 'blur-transition';

export interface FilterLayerItem {
  id: string;
  preset: ColorFilterPreset;
  name?: string;
  enabled: boolean;
  locked?: boolean;
  intensity: number; // 0..100
  startTime: number;
  endTime: number; // 0 = entire timeline unless explicit range
  clipIds?: string[]; // optional specific clip bindings (1 or multiple clips)
}

export interface VisualEffectItem {
  id: string;
  type: VisualEffectType;
  name?: string;
  enabled: boolean;
  locked?: boolean;
  intensity: number; // 0..100
  opacity?: number; // 0.05..1.0 blend strength
  startTime: number;
  endTime: number; // 0 = entire video
  clipId?: string; // optional target clip binding
  speed?: number; // 0.2..3.0 animation rate for flash/shake/glitch/zoom
  fadeInSec?: number; // fade-in duration
  fadeOutSec?: number; // fade-out duration
  posX?: number; // 0..1 normalized horizontal position (lens flare, leak, vignette focus)
  posY?: number; // 0..1 normalized vertical position
  direction?: 'left' | 'right' | 'up' | 'down'; // slide/wipe transition direction
  blockSize?: number; // 4..48 px for pixelate/mosaic
  hueShiftDeg?: number; // -180..180 for color-shift/neon-glow
}

export interface VideoEffectsConfig {
  filterPreset: ColorFilterPreset;
  filterIntensity?: number; // 0..100 (default 100)
  globalFilterLocked?: boolean;
  filterStack?: FilterLayerItem[]; // multiple stacked & timeline-bound color filter layers
  adjustments: ColorAdjustments;
  effects: VisualEffectItem[];
  compareMode: boolean; // toggle before/after comparison
  favoriteFilters?: ColorFilterPreset[];
  recentFilters?: ColorFilterPreset[];
  favoriteEffects?: VisualEffectType[];
  recentEffects?: VisualEffectType[];
}

export type CanvasAspectRatio = 'original' | '9:16' | '16:9' | '1:1' | '4:5' | '3:4' | 'custom';
export type CanvasBackgroundType = 'solid' | 'image' | 'blur';
export type CanvasCropMode =
  | 'fit'
  | 'fill'
  | 'crop'
  | 'zoom'
  | 'stretch'
  | 'smart-center'
  | 'custom-region';

export interface VideoCanvasConfig {
  aspectRatio: CanvasAspectRatio;
  cropMode?: CanvasCropMode;
  customWidth: number;
  customHeight: number;
  zoom: number; // 0.25..3.0 (1.0 = fit inside canvas)
  offsetX: number; // -100..100 (% of canvas width)
  offsetY: number; // -100..100 (% of canvas height)
  videoRotation?: number; // -180..180 degrees
  flipH?: boolean;
  flipV?: boolean;
  videoOpacity?: number; // 0.05..1
  videoVisible?: boolean;
  videoLocked?: boolean;
  cropTop: number; // 0..45 (%)
  cropRight: number; // 0..45 (%)
  cropBottom: number; // 0..45 (%)
  cropLeft: number; // 0..45 (%)
  cropX?: number; // optional source pixel X
  cropY?: number; // optional source pixel Y
  cropWidth?: number; // optional source pixel width
  cropHeight?: number; // optional source pixel height
  backgroundType: CanvasBackgroundType;
  bgColor: string; // HEX color
  bgImageUrl?: string;
  bgImageFilename?: string;
  bgImageScale: number; // 0.5..2.5
  bgImageOffsetX: number; // -50..50 (%)
  bgImageOffsetY: number; // -50..50 (%)
  bgImageRotation?: number; // -180..180 degrees
  bgImageOpacity?: number; // 0.05..1
  bgImageVisible?: boolean;
  bgImageLocked?: boolean;
  bgBlurIntensity: number; // 4..60
  bgBlurBrightness: number; // -60..60
  bgBlurOpacity: number; // 0.1..1.0
  showEditingGuides?: boolean; // toggle editing borders/handles on stage
  layerOrder?: string[]; // ordered bottom-to-top: 'bg-image', 'video', 'blur:<id>', 'logo:<id>', 'captions'
}

export const DEFAULT_VIDEO_CANVAS: VideoCanvasConfig = {
  aspectRatio: 'original',
  cropMode: 'fit',
  customWidth: 1080,
  customHeight: 1920,
  zoom: 1.0,
  offsetX: 0,
  offsetY: 0,
  videoRotation: 0,
  flipH: false,
  flipV: false,
  videoOpacity: 1.0,
  videoVisible: true,
  videoLocked: false,
  cropTop: 0,
  cropRight: 0,
  cropBottom: 0,
  cropLeft: 0,
  backgroundType: 'solid',
  bgColor: '#09090B',
  bgImageScale: 1.0,
  bgImageOffsetX: 0,
  bgImageOffsetY: 0,
  bgImageRotation: 0,
  bgImageOpacity: 1.0,
  bgImageVisible: true,
  bgImageLocked: false,
  bgBlurIntensity: 24,
  bgBlurBrightness: -15,
  bgBlurOpacity: 0.9,
  showEditingGuides: true,
};

export const DEFAULT_COLOR_ADJUSTMENTS: ColorAdjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  exposure: 0,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  sharpness: 0,
  vignette: 0,
  fade: 0,
  grain: 0,
};

export const DEFAULT_VIDEO_EFFECTS: VideoEffectsConfig = {
  filterPreset: 'none',
  filterIntensity: 100,
  filterStack: [],
  adjustments: DEFAULT_COLOR_ADJUSTMENTS,
  effects: [],
  compareMode: false,
  favoriteFilters: [],
  recentFilters: [],
  favoriteEffects: [],
  recentEffects: [],
};

export type ExportSpeedProfile = 'fast' | 'balanced' | 'high-quality';

export interface ExportSettings {
  aspectRatio: 'original' | '16:9' | '9:16' | '1:1' | '4:5' | '3:4' | 'custom';
  resolution: '480p' | '720p' | '1080p';
  fitMode: 'crop' | 'blur-pad' | 'letterbox';
  speedProfile?: ExportSpeedProfile;
  format: 'mp4';
  videoCodec: 'h264';
  audioCodec: 'aac';
  applyBlur: boolean;
  applyLogo: boolean;
  applyVideoEffects: boolean;
  applyCaptions: boolean; // STRICT: Default false
  applyDubbing: boolean;
  applyAudioMix: boolean;
}

export type CloudSyncStatus =
  | 'local-only'
  | 'cloud-synced'
  | 'pending-sync'
  | 'quota-blocked'
  | 'conflict'
  | 'offline';

export type CloudAssetKind =
  | 'video'
  | 'final-export'
  | 'voice'
  | 'voice-segment'
  | 'music'
  | 'sfx'
  | 'logo'
  | 'background'
  | 'font'
  | 'thumbnail'
  | 'mask'
  | 'other';

export interface CloudAssetManifestEntry {
  localUrl: string;
  bucketPath: string;
  sha256: string;
  sizeBytes: number;
  assetKind: CloudAssetKind;
  filename: string;
  mimeType: string;
  compressed?: boolean;
  verified?: boolean;
  verifiedSizeBytes?: number;
  verifiedAt?: string;
  syncedAt: string;
}

export interface CloudAssetRecord {
  id: string;
  userId: string;
  projectId: string;
  bucketPath: string;
  assetKind: CloudAssetKind;
  filename: string;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
  originalLocalUrl: string;
  compressed: boolean;
  verified?: boolean;
  verifiedAt?: string;
  createdAt: string;
}

export type CloudUploadTaskStatus =
  | 'queued'
  | 'uploading'
  | 'verifying'
  | 'verified'
  | 'deduplicated'
  | 'failed'
  | 'cancelled'
  | 'quota-blocked'
  | 'exceeds-free-cap';

export interface CloudUploadTask {
  id: string;
  localUrl: string;
  filename: string;
  assetKind: CloudAssetKind;
  sizeBytes: number;
  uploadedBytes: number;
  progressPct: number;
  status: CloudUploadTaskStatus;
  sha256?: string;
  bucketPath?: string;
  error?: string;
}

export interface SavedProjectThumbnail {
  id: string;
  url: string;
  label: string;
  width: number;
  height: number;
  format: 'png' | 'jpg';
  createdAt: string;
}

export interface ProjectCloudMeta {
  syncStatus: CloudSyncStatus;
  cloudUpdatedAt?: string;
  syncVersion?: number;
  lastDeviceId?: string;
  skippedLargeAssets?: Array<{ filename: string; sizeBytes: number; reason: string }>;
  failedUploads?: Array<{ localUrl: string; filename: string; reason: string }>;
  unverifiedCount?: number;
  error?: string;
}

export interface CloudStorageUsage {
  storageUsedBytes: number;
  storageLimitBytes: number;
  dbUsedBytes: number;
  dbLimitBytes: number;
  maxSingleFileBytes: number;
  egressTrackedBytes: number;
  egressLimitBytes: number;
  fileCount: number;
  projectCount: number;
  assets: CloudAssetRecord[];
}

export interface PendingSyncOp {
  projectId: string;
  projectName: string;
  queuedAt: string;
  updatedAt: string;
  reason: string;
}

export interface SupabaseFreeConfig {
  url: string;
  anonKey: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  sourceVideoUrl: string | null;
  sourceVideoBlobKey?: string | null;
  sourceFilename: string | null;
  thumbnailUrl: string | null;
  savedThumbnails?: SavedProjectThumbnail[];
  metadata: VideoMetadata | null;
  waveformPeaks: number[];
  captions: CaptionSegment[];
  subtitleStyle: SubtitleStyle;
  translation: TranslationConfig;
  voice: VoiceConfig;
  blurs: BlurEffect[];
  subtitleRemoval?: SubtitleRemovalState;
  logos: LogoOverlay[];
  videoClips?: VideoClip[];
  originalAudioClips?: OriginalAudioClip[];
  videoEffects: VideoEffectsConfig;
  canvas?: VideoCanvasConfig;
  workflow?: ProjectWorkflowState;
  exportSettings: ExportSettings;
  lastExportUrl: string | null;
  lastExportSize: number | null;
  lastExportedAt: string | null;
  cloudSync?: ProjectCloudMeta;
  cloudAssets?: Record<string, CloudAssetManifestEntry>;
}

export interface ProjectPatchOptions {
  immediate?: boolean;
  debounceMs?: number;
  undoGroupKey?: string;
  recordUndo?: boolean;
}

export type ProjectPatchFn = (
  projectId: string,
  updater: Partial<Project> | ((current: Project) => Partial<Project>),
  opts?: ProjectPatchOptions
) => void;

export interface RenderJob {
  id: string;
  projectId: string;
  type: 'render' | 'transcribe' | 'translate' | 'voice' | 'analysis';
  status: 'queued' | 'processing' | 'completed' | 'failed';
  progress: number;
  stage: string;
  etaSeconds: number | null;
  outputUrl: string | null;
  outputSize: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SystemStatus {
  geminiConfigured: boolean;
  fishConfigured: boolean;
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  ffmpegVersion: string;
  storageDir: string;
  maxUploadSizeMb: number;
  tempRetentionHours: number;
  supportedVideoFormats: string[];
  supportedLogoFormats: string[];
  runtime?: 'express' | 'cloudflare-pages';
  storageMode?: string;
  localOnly?: boolean;
  databaseConfigured?: boolean;
  d1Available?: boolean;
  r2Available?: boolean;
  clientProcessingAvailable?: boolean;
}

export type FishConnectionStatus = 'connected' | 'not_connected' | 'error';

export interface FishAudioSettingsSummary {
  configured: boolean;
  source: 'encrypted_store' | 'env' | 'none' | 'local_storage';
  maskedKey: string | null;
  secureStorageAvailable: boolean;
  secureStorageMode: 'env_master_key' | 'server_key_file' | 'unavailable' | 'local_indexeddb';
  secureStorageDetail: string;
  connectionStatus: FishConnectionStatus;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  enabled: false, // STRICT: Never automatic, requires manual user trigger
  mode: 'word-by-word',
  chunkSize: 3,
  wordsPerDisplay: 3,
  highlightBehavior: 'color',
  transitionDurationMs: 180,
  timingOffsetSec: 0,
  template: 'tiktok',
  fontFamily: 'Montserrat',
  fontSize: 42,
  fontWeight: 'bold',
  fontWeightNum: 700,
  italic: false,
  underline: false,
  primaryColor: '#FFFFFF',
  highlightColor: '#FACC15',
  gradientEnabled: false,
  gradientColor: '#38BDF8',
  highlightBoxEnabled: false,
  highlightBoxColor: '#7C3AED',
  highlightBoxOpacity: 0.85,
  outlineColor: '#09090B',
  outlineWidth: 3,
  backgroundColor: '#09090B',
  backgroundOpacity: 0.55,
  borderRadius: 8,
  paddingH: 14,
  paddingV: 6,
  shadowEnabled: true,
  shadowColor: '#000000',
  shadowBlur: 4,
  shadowOpacity: 0.85,
  shadowDistance: 2,
  letterSpacing: 0,
  lineSpacing: 1.2,
  textAlign: 'center',
  textTransform: 'none',
  position: 'bottom',
  posX: 50,
  posY: 84,
  marginV: 48,
  maxWidthPct: 88,
  textWrap: true,
  maxLines: 2,
  uppercase: false,
  useTranslated: true,
  animationPreset: 'none',
  opacity: 1,
  rotation: 0,
  scale: 1,
  locked: false,
  visible: true,
  showSafeGuides: false,
  favoriteFonts: [],
  extraElements: [],
  customPresets: [],
};

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  enabled: false,
  provider: 'fish',
  syncMode: 'flexible',
  continuousPauseMs: 320,
  targetLanguage: 'French',
  gender: 'male',
  voiceName: 'Charon',
  fishReferenceId: '',
  fishVoiceTitle: 'Default Fish Audio Voice (s2.1-pro-free)',
  style: 'Dramatic, gripping movie recap narrator with clear pacing',
  narrationStyle: 'cinematic',
  speakingSpeed: 1.0,
  voiceVolume: 1.0,
  voiceMuted: false,
  timingOffsetSec: 0,
  preserveOriginalAudio: false,
  originalAudioEnabled: false,
  originalAudioMuted: true,
  originalAudioVolume: 1.0,
  fadeInSec: 0.3,
  fadeOutSec: 0.5,
  bgMusicEnabled: false,
  bgMusicMuted: false,
  bgMusicVolume: 0,
  sfxEnabled: false,
  sfxMuted: false,
  sfxVolume: 1.0,
  generatedClips: [],
};

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  aspectRatio: 'original',
  resolution: '1080p',
  fitMode: 'crop',
  speedProfile: 'balanced',
  format: 'mp4',
  videoCodec: 'h264',
  audioCodec: 'aac',
  applyBlur: true,
  applyLogo: true,
  applyVideoEffects: true,
  applyCaptions: false, // STRICT: Default false - never burned into export unless requested
  applyDubbing: true,
  applyAudioMix: true,
};
