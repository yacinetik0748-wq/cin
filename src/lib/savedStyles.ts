import {
  DEFAULT_SUBTITLE_STYLE,
  DEFAULT_VIDEO_CANVAS,
  DEFAULT_VIDEO_EFFECTS,
  FilterLayerItem,
  Project,
  SavedFishVoice,
  SavedStyleBlurDefaults,
  SavedStyleEffectsConfig,
  SavedStyleFiltersConfig,
  SavedStyleLogoPref,
  SavedStyleNarrationConfig,
  SavedStylePayload,
  StyleApplyScope,
  StyleMissingVoiceWarning,
  StudioPreset,
  StudioPresetAssetRef,
  SubtitleStyle,
  VisualEffectItem,
} from '../types/studio';
import { getEffectCatalogEntry, getFilterPresetMeta } from './videoFiltersCatalog';

const FORBIDDEN_SECRET_KEYS = new Set([
  'apikey',
  'api_key',
  'fishapikey',
  'secret',
  'token',
  'authorization',
  'password',
  'sourcevideourl',
  'sourcefilename',
  'captions',
  'generatedclips',
  'fullduburl',
  'bgmusicurl',
  'sfxurl',
  'videoclips',
  'originalaudioclips',
]);

function stripForbiddenKeysDeep(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map(stripForbiddenKeysDeep);
  }
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (FORBIDDEN_SECRET_KEYS.has(k.toLowerCase())) continue;
      out[k] = stripForbiddenKeysDeep(v);
    }
    return out;
  }
  return input;
}

export function sanitizeSavedStylePayload(raw: unknown): SavedStylePayload {
  const cleaned = (stripForbiddenKeysDeep(raw) || {}) as Partial<SavedStylePayload>;
  const rawFilters = (cleaned.filters || {}) as Partial<SavedStyleFiltersConfig>;
  const rawEffects = (cleaned.effects || {}) as Partial<SavedStyleEffectsConfig>;
  const rawCaption = (cleaned.captionStyle || {}) as Partial<SubtitleStyle>;
  const rawNarration = (cleaned.narration || {}) as Partial<SavedStyleNarrationConfig>;
  const rawEditor = (cleaned.editorSettings || {}) as Partial<SavedStylePayload['editorSettings']>;

  const cleanCaption: Partial<SubtitleStyle> = { ...rawCaption };
  delete cleanCaption.captionSync;
  delete cleanCaption.extraElements;
  delete cleanCaption.customPresets;
  delete cleanCaption.favoriteFonts;

  const cleanFilterStack = Array.isArray(rawFilters.filterStack)
    ? rawFilters.filterStack.map((fl) => ({
        id: fl.id || `fl_${Math.random().toString(36).slice(2, 8)}`,
        preset: fl.preset || 'none',
        name: fl.name,
        enabled: fl.enabled !== false,
        locked: Boolean(fl.locked),
        intensity: Number.isFinite(fl.intensity) ? fl.intensity : 100,
      }))
    : [];

  const cleanEffects = Array.isArray(rawEffects.effects)
    ? rawEffects.effects.map((fx) => ({
        id: fx.id || `fx_${Math.random().toString(36).slice(2, 8)}`,
        type: fx.type,
        name: fx.name,
        enabled: fx.enabled !== false,
        locked: Boolean(fx.locked),
        intensity: Number.isFinite(fx.intensity) ? fx.intensity : 50,
        opacity: fx.opacity,
        speed: fx.speed,
        fadeInSec: fx.fadeInSec,
        fadeOutSec: fx.fadeOutSec,
        posX: fx.posX,
        posY: fx.posY,
        direction: fx.direction,
        blockSize: fx.blockSize,
        hueShiftDeg: fx.hueShiftDeg,
        applyMode: fx.applyMode || 'full',
        durationRatio: fx.durationRatio,
      }))
    : [];

  const cleanCanvas = { ...(rawEditor.canvas || {}) };

  return {
    version: 1,
    thumbnailImageUrl:
      typeof cleaned.thumbnailImageUrl === 'string' && cleaned.thumbnailImageUrl.trim()
        ? cleaned.thumbnailImageUrl.trim()
        : undefined,
    filters: {
      filterPreset: rawFilters.filterPreset || 'none',
      filterIntensity:
        typeof rawFilters.filterIntensity === 'number' ? rawFilters.filterIntensity : 100,
      filterStack: cleanFilterStack,
      adjustments: {
        ...DEFAULT_VIDEO_EFFECTS.adjustments,
        ...(rawFilters.adjustments || {}),
      },
      compareMode: false,
    },
    effects: {
      effects: cleanEffects,
    },
    captionStyle: cleanCaption,
    narration: {
      savedVoiceId:
        typeof rawNarration.savedVoiceId === 'string' && rawNarration.savedVoiceId.trim()
          ? rawNarration.savedVoiceId.trim()
          : undefined,
      fishReferenceId:
        typeof rawNarration.fishReferenceId === 'string' && rawNarration.fishReferenceId.trim()
          ? rawNarration.fishReferenceId.trim()
          : '',
      fishVoiceTitle:
        typeof rawNarration.fishVoiceTitle === 'string' && rawNarration.fishVoiceTitle.trim()
          ? rawNarration.fishVoiceTitle.trim()
          : 'Default Fish Audio Voice (s2.1-pro-free)',
      narrationStyle: rawNarration.narrationStyle || 'cinematic',
      speakingSpeed:
        typeof rawNarration.speakingSpeed === 'number' ? rawNarration.speakingSpeed : 1.0,
      voiceVolume:
        typeof rawNarration.voiceVolume === 'number' ? rawNarration.voiceVolume : 1.0,
      preserveOriginalAudio: Boolean(rawNarration.preserveOriginalAudio),
      originalAudioVolume:
        typeof rawNarration.originalAudioVolume === 'number'
          ? rawNarration.originalAudioVolume
          : 1.0,
      syncMode: rawNarration.syncMode || 'flexible',
      continuousPauseMs: rawNarration.continuousPauseMs,
      bgMusicVolume:
        typeof rawNarration.bgMusicVolume === 'number' ? rawNarration.bgMusicVolume : 0,
      sfxVolume:
        typeof rawNarration.sfxVolume === 'number' ? rawNarration.sfxVolume : 1.0,
      fadeInSec:
        typeof rawNarration.fadeInSec === 'number' ? rawNarration.fadeInSec : 0.3,
      fadeOutSec:
        typeof rawNarration.fadeOutSec === 'number' ? rawNarration.fadeOutSec : 0.5,
      timingOffsetSec:
        typeof rawNarration.timingOffsetSec === 'number' ? rawNarration.timingOffsetSec : 0,
      targetLanguage: rawNarration.targetLanguage,
      preserveProperNouns: rawNarration.preserveProperNouns,
    },
    editorSettings: {
      canvas: cleanCanvas,
      exportSettings: { ...(rawEditor.exportSettings || {}) },
      blurDefaults: rawEditor.blurDefaults ? { ...rawEditor.blurDefaults } : undefined,
      logoPreferences: Array.isArray(rawEditor.logoPreferences)
        ? rawEditor.logoPreferences.map((lp) => ({ ...lp }))
        : undefined,
    },
  };
}

export function buildSavedStylePayloadFromProject(
  project: Project,
  opts?: {
    savedVoices?: SavedFishVoice[];
    thumbnailImageUrl?: string;
  }
): {
  payload: SavedStylePayload;
  thumbnailStyle: NonNullable<StudioPreset['thumbnailStyle']>;
  assetRefs: StudioPresetAssetRef[];
} {
  const duration = Math.max(1, project.metadata?.duration || 10);
  const vfx = project.videoEffects || DEFAULT_VIDEO_EFFECTS;
  const sub = { ...DEFAULT_SUBTITLE_STYLE, ...project.subtitleStyle };
  const canvas = { ...DEFAULT_VIDEO_CANVAS, ...(project.canvas || {}) };
  const voice = project.voice;
  const savedVoices = opts?.savedVoices || [];

  const matchedVoice = voice.fishReferenceId
    ? savedVoices.find((sv) => sv.voiceId === voice.fishReferenceId?.trim())
    : undefined;

  const {
    captionSync: _cs,
    extraElements: _ee,
    customPresets: _cp,
    favoriteFonts: _ff,
    ...reusableCaptionStyle
  } = sub;

  const {
    bgImageUrl,
    bgImageFilename,
    ...reusableCanvasBase
  } = canvas;

  const reusableCanvas = {
    ...reusableCanvasBase,
    ...(canvas.backgroundType === 'image' && bgImageUrl ? { bgImageUrl, bgImageFilename } : {}),
  };

  const firstBlur = project.blurs?.[0];
  const blurDefaults: SavedStyleBlurDefaults | undefined = firstBlur
    ? {
        type: firstBlur.type,
        intensity: firstBlur.intensity,
        radius: firstBlur.radius,
        opacity: firstBlur.opacity,
        feather: firstBlur.feather,
        borderRadius: firstBlur.borderRadius,
        shape: firstBlur.shape,
        coordSpace: firstBlur.coordSpace,
      }
    : undefined;

  const logoPreferences: SavedStyleLogoPref[] | undefined =
    project.logos && project.logos.length > 0
      ? project.logos.map((logo) => ({
          presetPosition: logo.presetPosition,
          x: logo.x,
          y: logo.y,
          widthPct: logo.widthPct,
          opacity: logo.opacity,
          rotation: logo.rotation,
          permanent: logo.permanent,
          motion: logo.motion,
        }))
      : undefined;

  const effectsMapped = (vfx.effects || []).map((fx) => {
    const start = Math.max(0, fx.startTime || 0);
    const end = fx.endTime > start ? fx.endTime : 0;
    let applyMode: 'full' | 'intro' | 'outro' = 'full';
    let durationRatio: number | undefined;
    if (end > 0) {
      const span = Math.max(0.2, end - start);
      if (start <= 0.15 && span < duration * 0.65) {
        applyMode = 'intro';
        durationRatio = Number((span / duration).toFixed(3));
      } else if (end >= duration - 0.25 && start > duration * 0.35) {
        applyMode = 'outro';
        durationRatio = Number((span / duration).toFixed(3));
      }
    }
    const { startTime: _st, endTime: _et, clipId: _cid, ...rest } = fx;
    return {
      ...rest,
      applyMode,
      durationRatio,
    };
  });

  const payload = sanitizeSavedStylePayload({
    version: 1,
    thumbnailImageUrl: opts?.thumbnailImageUrl,
    filters: {
      filterPreset: vfx.filterPreset || 'none',
      filterIntensity: vfx.filterIntensity ?? 100,
      filterStack: (vfx.filterStack || []).map(({ startTime: _s, endTime: _e, clipIds: _c, ...rest }) => rest),
      adjustments: { ...DEFAULT_VIDEO_EFFECTS.adjustments, ...(vfx.adjustments || {}) },
    },
    effects: {
      effects: effectsMapped,
    },
    captionStyle: reusableCaptionStyle,
    narration: {
      savedVoiceId: matchedVoice?.id,
      fishReferenceId: voice.fishReferenceId?.trim() || '',
      fishVoiceTitle:
        matchedVoice?.name ||
        voice.fishVoiceTitle ||
        (voice.fishReferenceId ? 'Custom Voice' : 'Default Fish Audio Voice (s2.1-pro-free)'),
      narrationStyle: voice.narrationStyle || 'cinematic',
      speakingSpeed: voice.speakingSpeed || 1.0,
      voiceVolume: voice.voiceVolume ?? 1.0,
      preserveOriginalAudio: Boolean(voice.preserveOriginalAudio),
      originalAudioVolume: voice.originalAudioVolume ?? 1.0,
      syncMode: voice.syncMode || 'flexible',
      continuousPauseMs: voice.continuousPauseMs,
      bgMusicVolume: voice.bgMusicVolume ?? 0,
      sfxVolume: voice.sfxVolume ?? 1.0,
      fadeInSec: voice.fadeInSec ?? 0.3,
      fadeOutSec: voice.fadeOutSec ?? 0.5,
      timingOffsetSec: voice.timingOffsetSec ?? 0,
      targetLanguage: voice.targetLanguage || project.translation.targetLanguage,
      preserveProperNouns: project.translation.preserveProperNouns,
    },
    editorSettings: {
      canvas: reusableCanvas,
      exportSettings: {
        aspectRatio: project.exportSettings.aspectRatio,
        resolution: project.exportSettings.resolution,
        fitMode: project.exportSettings.fitMode,
        applyBlur: project.exportSettings.applyBlur,
        applyLogo: project.exportSettings.applyLogo,
        applyVideoEffects: project.exportSettings.applyVideoEffects,
        applyCaptions: project.exportSettings.applyCaptions,
        applyDubbing: project.exportSettings.applyDubbing,
        applyAudioMix: project.exportSettings.applyAudioMix,
      },
      blurDefaults,
      logoPreferences,
    },
  });

  const filterMeta = getFilterPresetMeta(vfx.filterPreset || 'none');
  const assetRefs: StudioPresetAssetRef[] = [];
  if (sub.customFontUrl) {
    assetRefs.push({
      kind: 'font',
      label: sub.fontFamily || 'Custom Font',
      url: sub.customFontUrl,
    });
  }
  if (canvas.backgroundType === 'image' && canvas.bgImageUrl) {
    assetRefs.push({
      kind: 'background-image',
      label: canvas.bgImageFilename || 'Canvas Background',
      url: canvas.bgImageUrl,
      filename: canvas.bgImageFilename,
    });
  }
  if (opts?.thumbnailImageUrl) {
    assetRefs.push({
      kind: 'thumbnail',
      label: 'Style Preview Thumbnail',
      url: opts.thumbnailImageUrl,
    });
  }

  const narratorBadge =
    matchedVoice?.name ||
    (voice.fishReferenceId ? voice.fishVoiceTitle || 'Custom Narrator' : 'Default Narrator');
  const filterLabel =
    vfx.filterPreset && vfx.filterPreset !== 'none'
      ? filterMeta.label
      : (vfx.filterStack?.length || 0) > 0
      ? `${vfx.filterStack!.length} Filter(s)`
      : 'Original Color';

  const thumbnailStyle: NonNullable<StudioPreset['thumbnailStyle']> = {
    bg: sub.backgroundColor || canvas.bgColor || '#111115',
    fg: sub.primaryColor || '#FFFFFF',
    accent: sub.highlightColor || '#7C3AED',
    sampleText: sub.uppercase ? 'STYLE PREVIEW' : 'Style Preview',
    badge: `${canvas.aspectRatio || 'original'} · ${filterLabel} · ${narratorBadge}`,
    imageUrl: opts?.thumbnailImageUrl || project.thumbnailUrl || undefined,
  };

  return { payload, thumbnailStyle, assetRefs };
}

export function applySavedStyleToProjectData(params: {
  project: Project;
  style: StudioPreset;
  scope: StyleApplyScope;
  savedVoices: SavedFishVoice[];
  checkAssetAvailable: (url: string) => boolean;
  generateId: () => string;
  preserveCaptionEnabledState?: boolean;
}): {
  patch: Partial<Project>;
  warnings: Array<{ presetName: string; missingAssets: StudioPresetAssetRef[] }>;
  voiceMissingWarning: StyleMissingVoiceWarning | null;
} {
  const { project, style, scope, savedVoices, checkAssetAvailable, generateId } = params;
  const payload = sanitizeSavedStylePayload(style.payload);
  const patch: Partial<Project> = {};
  const warnings: Array<{ presetName: string; missingAssets: StudioPresetAssetRef[] }> = [];
  let voiceMissingWarning: StyleMissingVoiceWarning | null = null;

  const missingAssets = (style.missingAssets || []).filter((a) => a.kind !== 'thumbnail');
  const duration = Math.max(1, project.metadata?.duration || 10);

  const includeFilters = scope === 'all' || scope === 'filters';
  const includeEffects = scope === 'all' || scope === 'effects';
  const includeCaptions = scope === 'all' || scope === 'captions';
  const includeNarration = scope === 'all' || scope === 'narration';
  const includeEditor = scope === 'all';

  if (includeFilters || includeEffects) {
    const curFx = project.videoEffects || DEFAULT_VIDEO_EFFECTS;
    const nextFx = { ...DEFAULT_VIDEO_EFFECTS, ...curFx };

    if (includeFilters) {
      nextFx.filterPreset = payload.filters.filterPreset || 'none';
      nextFx.filterIntensity = payload.filters.filterIntensity ?? 100;
      nextFx.adjustments = {
        ...DEFAULT_VIDEO_EFFECTS.adjustments,
        ...(payload.filters.adjustments || {}),
      };
      nextFx.filterStack = (payload.filters.filterStack || []).map(
        (fl): FilterLayerItem => ({
          id: generateId(),
          preset: fl.preset,
          name: fl.name,
          enabled: fl.enabled !== false,
          locked: Boolean(fl.locked),
          intensity: fl.intensity ?? 100,
          startTime: 0,
          endTime: 0, // full duration of target project
        })
      );
      nextFx.compareMode = false;
    }

    if (includeEffects) {
      nextFx.effects = (payload.effects.effects || []).map((fx): VisualEffectItem => {
        let startTime = 0;
        let endTime = 0;
        if (fx.applyMode === 'intro') {
          const span = Math.max(0.5, Math.min(duration, duration * (fx.durationRatio || 0.25)));
          startTime = 0;
          endTime = Number(span.toFixed(2));
        } else if (fx.applyMode === 'outro') {
          const span = Math.max(0.5, Math.min(duration, duration * (fx.durationRatio || 0.25)));
          startTime = Number(Math.max(0, duration - span).toFixed(2));
          endTime = Number(duration.toFixed(2));
        }
        const { applyMode: _am, durationRatio: _dr, ...rest } = fx;
        return {
          ...rest,
          id: generateId(),
          startTime,
          endTime,
        };
      });
    }

    patch.videoEffects = nextFx;
  }

  if (includeCaptions) {
    const cap = payload.captionStyle || {};
    const missingFonts = missingAssets.filter((a) => a.kind === 'font');
    if (missingFonts.length > 0) {
      warnings.push({ presetName: style.name, missingAssets: missingFonts });
    }
    const validCustomFontUrl =
      typeof cap.customFontUrl === 'string' && checkAssetAvailable(cap.customFontUrl)
        ? cap.customFontUrl
        : undefined;
    const hasCaptions = project.captions.length > 0;
    const nextEnabled = params.preserveCaptionEnabledState
      ? hasCaptions
        ? Boolean(project.subtitleStyle.enabled || cap.enabled)
        : Boolean(project.subtitleStyle.enabled)
      : hasCaptions
      ? Boolean(cap.enabled ?? project.subtitleStyle.enabled)
      : false;

    patch.subtitleStyle = {
      ...DEFAULT_SUBTITLE_STYLE,
      ...project.subtitleStyle,
      ...cap,
      customFontUrl: validCustomFontUrl,
      customFontId: validCustomFontUrl ? cap.customFontId : undefined,
      // Preserve project-specific caption overlays & sync snapshots cleanly
      extraElements: project.subtitleStyle.extraElements || [],
      captionSync: project.subtitleStyle.captionSync,
      favoriteFonts: project.subtitleStyle.favoriteFonts || [],
      customPresets: project.subtitleStyle.customPresets || [],
      enabled: nextEnabled,
      useTranslated: true,
    };
  }

  if (includeNarration) {
    const nar = payload.narration;
    const hadCustomVoice = Boolean(nar.savedVoiceId || (nar.fishReferenceId && nar.fishReferenceId.trim()));
    let resolvedVoiceId = '';
    let resolvedVoiceTitle = 'Default Fish Audio Voice (s2.1-pro-free)';

    if (hadCustomVoice) {
      const bySavedId = nar.savedVoiceId
        ? savedVoices.find((v) => v.id === nar.savedVoiceId)
        : undefined;
      const byVoiceId = nar.fishReferenceId
        ? savedVoices.find((v) => v.voiceId === nar.fishReferenceId?.trim())
        : undefined;
      const matched = bySavedId || byVoiceId;

      if (matched) {
        resolvedVoiceId = matched.voiceId;
        resolvedVoiceTitle = matched.name;
      } else {
        // Saved narrator was deleted or no longer exists: NEVER invent or substitute a Voice ID
        resolvedVoiceId = '';
        resolvedVoiceTitle = 'Narrator Missing — Select Voice';
        voiceMissingWarning = {
          styleName: style.name,
          missingVoiceName: nar.fishVoiceTitle || 'Saved Narrator',
          missingVoiceId: nar.fishReferenceId || '',
          message: `Narrator "${nar.fishVoiceTitle || nar.fishReferenceId}" saved in "${style.name}" was not found in My Voices. Select another voice before generating narration.`,
        };
      }
    }

    patch.voice = {
      ...project.voice,
      provider: 'fish',
      fishReferenceId: resolvedVoiceId,
      fishVoiceTitle: resolvedVoiceTitle,
      narrationStyle: nar.narrationStyle || project.voice.narrationStyle,
      speakingSpeed: nar.speakingSpeed || 1.0,
      voiceVolume: nar.voiceVolume ?? project.voice.voiceVolume,
      preserveOriginalAudio: nar.preserveOriginalAudio ?? project.voice.preserveOriginalAudio,
      originalAudioEnabled: nar.preserveOriginalAudio ?? project.voice.originalAudioEnabled,
      originalAudioMuted: !(nar.preserveOriginalAudio ?? project.voice.preserveOriginalAudio),
      originalAudioVolume: nar.originalAudioVolume ?? project.voice.originalAudioVolume,
      syncMode: nar.syncMode || project.voice.syncMode,
      continuousPauseMs: nar.continuousPauseMs ?? project.voice.continuousPauseMs,
      bgMusicVolume: nar.bgMusicVolume ?? project.voice.bgMusicVolume,
      sfxVolume: nar.sfxVolume ?? project.voice.sfxVolume,
      fadeInSec: nar.fadeInSec ?? project.voice.fadeInSec,
      fadeOutSec: nar.fadeOutSec ?? project.voice.fadeOutSec,
      timingOffsetSec: nar.timingOffsetSec ?? project.voice.timingOffsetSec,
      targetLanguage: nar.targetLanguage || project.voice.targetLanguage,
      // Strictly preserve target project's media/dub tracks
      generatedClips: project.voice.generatedClips,
      fullDubUrl: project.voice.fullDubUrl,
      bgMusicUrl: project.voice.bgMusicUrl,
      bgMusicFilename: project.voice.bgMusicFilename,
      sfxUrl: project.voice.sfxUrl,
      sfxFilename: project.voice.sfxFilename,
    };

    if (nar.targetLanguage || nar.preserveProperNouns !== undefined) {
      patch.translation = {
        ...project.translation,
        ...(nar.targetLanguage ? { targetLanguage: nar.targetLanguage } : {}),
        ...(nar.preserveProperNouns !== undefined
          ? { preserveProperNouns: nar.preserveProperNouns }
          : {}),
      };
    }
  }

  if (includeEditor) {
    const ed = payload.editorSettings;
    if (ed.canvas) {
      const nextCanvas = {
        ...DEFAULT_VIDEO_CANVAS,
        ...(project.canvas || {}),
        ...ed.canvas,
      };
      if (nextCanvas.bgImageUrl && !checkAssetAvailable(nextCanvas.bgImageUrl)) {
        nextCanvas.bgImageUrl = undefined;
        nextCanvas.bgImageFilename = undefined;
        if (nextCanvas.backgroundType === 'image') {
          nextCanvas.backgroundType = 'blur';
        }
        const missingBg = missingAssets.filter((a) => a.kind === 'background-image');
        if (missingBg.length > 0) {
          warnings.push({ presetName: style.name, missingAssets: missingBg });
        }
      }
      patch.canvas = nextCanvas;
    }

    if (ed.exportSettings) {
      patch.exportSettings = {
        ...project.exportSettings,
        ...ed.exportSettings,
        // Never force captions burn-in unexpectedly if target has 0 captions
        applyCaptions:
          project.captions.length > 0
            ? ed.exportSettings.applyCaptions ?? project.exportSettings.applyCaptions
            : false,
      };
    }

    // Apply reusable blur styling defaults ONLY to existing blurs' appearance if any? No: keep blur positions/times untouched!
    // Blur defaults live inside style & can guide new blurs; existing blurs keep their masks intact.
  }

  return { patch, warnings, voiceMissingWarning };
}

export function summarizeSavedStyle(preset: StudioPreset, savedVoices?: SavedFishVoice[]): {
  filterLabel: string;
  effectsLabel: string;
  captionLabel: string;
  narratorLabel: string;
  narratorMissing: boolean;
  aspectRatioLabel: string;
  thumbnailUrl?: string;
} {
  const payload = sanitizeSavedStylePayload(preset.payload);
  const filterMeta = getFilterPresetMeta(payload.filters.filterPreset || 'none');
  const stackCount = payload.filters.filterStack?.length || 0;
  const filterLabel =
    payload.filters.filterPreset && payload.filters.filterPreset !== 'none'
      ? `${filterMeta.label}${stackCount > 0 ? ` +${stackCount}` : ''}`
      : stackCount > 0
      ? `${stackCount} Filter layer(s)`
      : 'None';

  const fxList = payload.effects.effects || [];
  const effectsLabel =
    fxList.length === 0
      ? 'None'
      : fxList.length <= 2
      ? fxList.map((e) => e.name || getEffectCatalogEntry(e.type).label).join(', ')
      : `${fxList.length} Effects`;

  const cap = payload.captionStyle;
  const captionLabel = cap.fontFamily
    ? `${cap.fontFamily} ${cap.fontSize || 42}px · ${cap.template || 'custom'}`
    : 'Default Captions';

  const nar = payload.narration;
  const hasCustomVoice = Boolean(nar.savedVoiceId || (nar.fishReferenceId && nar.fishReferenceId.trim()));
  let narratorLabel = 'Default Neutral Narrator';
  let narratorMissing = false;
  if (hasCustomVoice) {
    const matched = savedVoices
      ? savedVoices.find(
          (v) =>
            (nar.savedVoiceId && v.id === nar.savedVoiceId) ||
            (nar.fishReferenceId && v.voiceId === nar.fishReferenceId.trim())
        )
      : undefined;
    if (matched) {
      narratorLabel = matched.name;
    } else if (savedVoices) {
      narratorLabel = `${nar.fishVoiceTitle || 'Saved Narrator'} (Missing)`;
      narratorMissing = true;
    } else {
      narratorLabel = nar.fishVoiceTitle || 'Custom Narrator';
    }
  }

  const aspect = payload.editorSettings.canvas?.aspectRatio || 'original';
  const thumbnailUrl =
    payload.thumbnailImageUrl || preset.thumbnailStyle?.imageUrl || undefined;

  return {
    filterLabel,
    effectsLabel,
    captionLabel,
    narratorLabel,
    narratorMissing,
    aspectRatioLabel: aspect === 'original' ? 'Original Ratio' : aspect,
    thumbnailUrl,
  };
}
