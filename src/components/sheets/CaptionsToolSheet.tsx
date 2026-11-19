import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Download,
  Eye,
  EyeOff,
  Flame,
  Loader2,
  Merge,
  Plus,
  RefreshCw,
  RotateCcw,
  Scissors,
  Search,
  Sparkles,
  Star,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import {
  CaptionAnimationPreset,
  CaptionDisplayMode,
  CaptionHighlightBehavior,
  CaptionTextTransform,
  DEFAULT_SUBTITLE_STYLE,
  Project,
  ProjectPatchFn,
  SavedFontAsset,
  StudioPreset,
  StudioPresetAssetRef,
  SubtitleStyle,
} from '../../types/studio';
import { api } from '../../lib/api';
import {
  BUILTIN_FONT_CATALOG,
  ensureFontLoaded,
  FONT_CATEGORIES,
  FontCategoryId,
  getFontStatus,
  resolveClosestSupportedWeight,
  subscribeFontStatus,
  WEIGHT_LABELS,
} from '../../lib/fontCatalog';
import { CAPTION_DISPLAY_MODES, normalizeCanonicalMode } from '../../lib/captionModes';
import {
  CAPTION_TEMPLATE_CATEGORIES,
  CAPTION_TEMPLATES_LIBRARY,
  CaptionTemplateCategoryId,
  CaptionTemplateItem,
} from '../../lib/captionTemplates';
import {
  buildCaptionsFromTranscript,
  computeCaptionSyncStatus,
  countMissingTranslations,
  createWorkflowUpdate,
  deleteCaptionWithSync,
  getSyncedCaptionsForPreview,
  mergeCaptionWithSync,
  splitCaptionWithSync,
  updateCaptionTimingWithSync,
} from '../../lib/workflowStages';
import { PresetLibraryPanel } from '../PresetLibraryPanel';
import { CollapsibleSection } from '../ui/CollapsibleSection';
import { StudioToolMemory } from './toolMemory';

interface CaptionsToolSheetProps {
  project: Project;
  onProjectUpdated: (p: Project) => void;
  onPatchProject: ProjectPatchFn;
  onFlushSaves?: (projectId?: string) => Promise<boolean>;
  currentTime?: number;
  onSeek: (time: number) => void;
  customFonts: SavedFontAsset[];
  onCustomFontsChanged: () => void;
  memory: StudioToolMemory;
  onUpdateMemory: (patch: Partial<StudioToolMemory>) => void;
  selectedSegmentId?: string | null;
  onSelectSegment?: (id: string | null) => void;
}

const TRENDING_PRESETS: Array<{
  id: string;
  name: string;
  tag: string;
  previewBg: string;
  previewFg: string;
  sampleWord: string;
  style: Partial<SubtitleStyle>;
}> = [
  {
    id: 'tiktok-pop',
    name: 'TikTok Pop',
    tag: '1 Word',
    previewBg: '#09090B',
    previewFg: '#FFFFFF',
    sampleWord: 'SHOCKING',
    style: {
      template: 'tiktok',
      mode: 'word-by-word',
      fontFamily: 'Montserrat',
      fontSize: 44,
      fontWeight: '900',
      fontWeightNum: 900,
      primaryColor: '#FFFFFF',
      highlightColor: '#FACC15',
      gradientEnabled: false,
      highlightBoxEnabled: false,
      outlineColor: '#000000',
      outlineWidth: 4,
      backgroundOpacity: 0,
      shadowEnabled: true,
      textTransform: 'uppercase',
      uppercase: true,
      animationPreset: 'word-popup',
      highlightBehavior: 'scale',
    },
  },
  {
    id: 'hormozi-bold',
    name: 'Bold Viral',
    tag: 'Two Words',
    previewBg: '#111827',
    previewFg: '#4ADE80',
    sampleWord: 'THE TWIST',
    style: {
      template: 'custom',
      mode: 'two-words',
      fontFamily: 'Bebas Neue',
      fontSize: 48,
      fontWeight: 'bold',
      fontWeightNum: 400,
      primaryColor: '#4ADE80',
      highlightColor: '#FACC15',
      gradientEnabled: false,
      highlightBoxEnabled: false,
      outlineColor: '#000000',
      outlineWidth: 5,
      backgroundOpacity: 0,
      shadowEnabled: true,
      textTransform: 'uppercase',
      uppercase: true,
      animationPreset: 'bounce',
      highlightBehavior: 'color',
    },
  },
  {
    id: 'highlight-pill',
    name: 'Boxed Pill',
    tag: 'Boxed',
    previewBg: '#7C3AED',
    previewFg: '#FFFFFF',
    sampleWord: 'FOCUS',
    style: {
      template: 'shorts',
      mode: 'boxed-captions',
      fontFamily: 'Poppins',
      fontSize: 38,
      fontWeight: 'bold',
      fontWeightNum: 700,
      primaryColor: '#FFFFFF',
      highlightColor: '#FFFFFF',
      gradientEnabled: false,
      highlightBoxEnabled: true,
      highlightBoxColor: '#7C3AED',
      highlightBoxOpacity: 0.9,
      outlineColor: '#09090B',
      outlineWidth: 2,
      backgroundOpacity: 0.35,
      textTransform: 'none',
      uppercase: false,
      animationPreset: 'box-highlight',
      highlightBehavior: 'box',
    },
  },
  {
    id: 'arabic-modern',
    name: 'Arabic Cairo',
    tag: 'Arabic',
    previewBg: '#18181B',
    previewFg: '#FACC15',
    sampleWord: 'ملخص الفيلم',
    style: {
      template: 'custom',
      mode: 'three-words',
      fontFamily: 'Cairo',
      fontSize: 40,
      fontWeight: 'bold',
      fontWeightNum: 700,
      primaryColor: '#FFFFFF',
      highlightColor: '#FACC15',
      gradientEnabled: false,
      highlightBoxEnabled: false,
      outlineColor: '#000000',
      outlineWidth: 4,
      backgroundColor: '#09090B',
      backgroundOpacity: 0.5,
      textTransform: 'none',
      uppercase: false,
      animationPreset: 'pop',
      highlightBehavior: 'color',
    },
  },
];

const ANIMATIONS: Array<{ id: CaptionAnimationPreset; label: string }> = [
  { id: 'none', label: 'Static' },
  { id: 'word-popup', label: 'Word Pop' },
  { id: 'karaoke', label: 'Karaoke' },
  { id: 'bounce', label: 'Bounce' },
  { id: 'pop', label: 'Pop Spring' },
  { id: 'scale', label: 'Scale-In' },
  { id: 'slide-up', label: 'Slide Up' },
  { id: 'fade', label: 'Fade' },
  { id: 'typewriter', label: 'Typewriter' },
  { id: 'gradient-emphasis', label: 'Gradient' },
  { id: 'box-highlight', label: 'Pill Box' },
  { id: 'highlight-sweep', label: 'Neon Glow' },
];

export function CaptionsToolSheet({
  project,
  onProjectUpdated,
  onPatchProject,
  onFlushSaves,
  currentTime = 0,
  onSeek,
  customFonts,
  onCustomFontsChanged,
  memory,
  onUpdateMemory,
  selectedSegmentId,
  onSelectSegment,
}: CaptionsToolSheetProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fontInputRef = useRef<HTMLInputElement>(null);

  const [busy, setBusy] = useState(false);
  const [uploadingFont, setUploadingFont] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [fontCategory, setFontCategory] = useState<'All' | 'Favorites' | FontCategoryId>('All');
  const [fontSearch, setFontSearch] = useState('');
  const [modeSearch, setModeSearch] = useState('');
  const [templateCategory, setTemplateCategory] = useState<CaptionTemplateCategoryId>('All');
  const [templateSearch, setTemplateSearch] = useState('');
  const [applyTarget, setApplyTarget] = useState<'all' | 'selected'>('all');
  const [localSelectedCaptionId, setLocalSelectedCaptionId] = useState<string | null>(null);
  const selectedCaptionId = selectedSegmentId ?? localSelectedCaptionId;
  const setSelectedCaptionId = (id: string | null) => {
    setLocalSelectedCaptionId(id);
    onSelectSegment?.(id);
  };
  const [, setFontStatusTick] = useState(0);

  const syncedCaptions = useMemo(() => getSyncedCaptionsForPreview(project), [project]);
  const missingTranslatedCount = useMemo(
    () => countMissingTranslations(project.captions),
    [project.captions]
  );
  const syncStatus = computeCaptionSyncStatus(project);

  const captionAtPlayhead = useMemo(
    () => syncedCaptions.find((c) => currentTime >= c.syncedStart && currentTime <= c.syncedEnd) || null,
    [syncedCaptions, currentTime]
  );

  const quickSelectedCaption = useMemo(() => {
    if (selectedCaptionId) {
      const exact = syncedCaptions.find((c) => c.id === selectedCaptionId);
      if (exact) return exact;
    }
    return captionAtPlayhead || syncedCaptions[0] || null;
  }, [selectedCaptionId, syncedCaptions, captionAtPlayhead]);

  const effectiveTarget: 'all' | 'selected' =
    applyTarget === 'selected' && quickSelectedCaption ? 'selected' : 'all';

  const style: SubtitleStyle = useMemo(
    () =>
      effectiveTarget === 'selected' && quickSelectedCaption?.styleOverride
        ? { ...project.subtitleStyle, ...quickSelectedCaption.styleOverride }
        : project.subtitleStyle,
    [effectiveTarget, quickSelectedCaption, project.subtitleStyle]
  );

  const canonicalMode = normalizeCanonicalMode(style.mode);
  const activeModeDef =
    CAPTION_DISPLAY_MODES.find((m) => m.id === canonicalMode) || CAPTION_DISPLAY_MODES[0];

  useEffect(() => subscribeFontStatus(() => setFontStatusTick((n) => n + 1)), []);

  const activeWeightNum =
    style.fontWeightNum ??
    (style.fontWeight === '900' ? 900 : style.fontWeight === 'bold' ? 700 : 400);

  useEffect(() => {
    void ensureFontLoaded({
      family: style.fontFamily,
      weight: activeWeightNum,
      italic: style.italic,
      customUrl: style.customFontUrl,
    });
  }, [style.fontFamily, activeWeightNum, style.italic, style.customFontUrl]);

  const filteredTemplates = useMemo(() => {
    const q = templateSearch.trim().toLowerCase();
    return CAPTION_TEMPLATES_LIBRARY.filter((tpl) => {
      if (templateCategory !== 'All' && tpl.category !== templateCategory) return false;
      if (
        q &&
        !tpl.name.toLowerCase().includes(q) &&
        !tpl.category.toLowerCase().includes(q) &&
        !tpl.badge.toLowerCase().includes(q) &&
        !tpl.description.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [templateCategory, templateSearch]);

  useEffect(() => {
    if (memory.captionsTab !== 'templates') return;
    filteredTemplates.slice(0, 18).forEach((tpl) => {
      const fam = tpl.style.fontFamily;
      if (!fam) return;
      const w =
        tpl.style.fontWeightNum ||
        (tpl.style.fontWeight === '900' ? 900 : tpl.style.fontWeight === 'bold' ? 700 : 400);
      void ensureFontLoaded({ family: fam, weight: w, italic: Boolean(tpl.style.italic) });
    });
  }, [memory.captionsTab, filteredTemplates]);

  const updateStyle = (
    patch: Partial<SubtitleStyle>,
    immediate = false,
    undoGroupKey?: string
  ) => {
    if (effectiveTarget === 'selected' && quickSelectedCaption) {
      const targetId = quickSelectedCaption.id;
      onPatchProject(
        project.id,
        (cur) => ({
          captions: cur.captions.map((c) =>
            c.id === targetId
              ? {
                  ...c,
                  styleOverride: {
                    ...(c.styleOverride || {}),
                    ...patch,
                  },
                }
              : c
          ),
          workflow: createWorkflowUpdate(cur.workflow, {
            visitStage: 'captions',
            modifiedStage: 'captions',
            hasExistingExport: Boolean(cur.lastExportUrl),
          }),
        }),
        {
          immediate,
          debounceMs: immediate ? 0 : 200,
          undoGroupKey: undoGroupKey ? `seg:${targetId}:${undoGroupKey}` : undefined,
        }
      );
      return;
    }

    onPatchProject(
      project.id,
      (cur) => ({
        subtitleStyle: { ...cur.subtitleStyle, ...patch, useTranslated: true },
        workflow: createWorkflowUpdate(cur.workflow, {
          visitStage: 'captions',
          modifiedStage: 'captions',
          hasExistingExport: Boolean(cur.lastExportUrl),
        }),
      }),
      {
        immediate,
        debounceMs: immediate ? 0 : 200,
        undoGroupKey,
      }
    );
  };

  const applyTemplateToTarget = async (tpl: CaptionTemplateItem) => {
    setErrorMsg(null);
    const fam = tpl.style.fontFamily || 'Montserrat';
    const w =
      tpl.style.fontWeightNum ||
      (tpl.style.fontWeight === '900' ? 900 : tpl.style.fontWeight === 'bold' ? 700 : 400);
    await ensureFontLoaded({ family: fam, weight: w, italic: Boolean(tpl.style.italic) });
    const nextPatch: Partial<SubtitleStyle> = {
      ...tpl.style,
      template: tpl.id,
      useTranslated: true,
    };
    updateStyle(nextPatch, true);
    setSuccessMsg(
      effectiveTarget === 'selected' && quickSelectedCaption
        ? `Applied "${tpl.name}" template to selected caption.`
        : `Applied "${tpl.name}" template to all captions.`
    );
  };

  const resetSelectedSegmentOverride = () => {
    if (!quickSelectedCaption) return;
    const targetId = quickSelectedCaption.id;
    onPatchProject(
      project.id,
      (cur) => ({
        captions: cur.captions.map((c) => {
          if (c.id !== targetId) return c;
          const { styleOverride: _ignored, ...rest } = c;
          return rest;
        }),
        workflow: createWorkflowUpdate(cur.workflow, {
          visitStage: 'captions',
          modifiedStage: 'captions',
          hasExistingExport: Boolean(cur.lastExportUrl),
        }),
      }),
      { immediate: true }
    );
    setSuccessMsg('Cleared segment style override (using project style).');
  };

  // Strictly manual caption generation trigger
  const handleManualGenerateCaptions = async () => {
    setErrorMsg(null);
    setSuccessMsg(null);
    setBusy(true);
    try {
      await onFlushSaves?.(project.id);
      const built = buildCaptionsFromTranscript(project);
      const nextWorkflow = createWorkflowUpdate(project.workflow, {
        completeStage: 'captions',
        modifiedStage: 'captions',
        hasExistingExport: Boolean(project.lastExportUrl),
      });
      const { project: saved } = await api.updateProject(project.id, {
        captions: built.captions,
        subtitleStyle: built.subtitleStyle,
        workflow: nextWorkflow,
      });
      onProjectUpdated(saved);
      setSuccessMsg(
        `Generated ${built.captions.length} captions from translated narration (${built.targetLanguage}).`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSelectFont = async (params: {
    family: string;
    weight?: number;
    customId?: string;
    customUrl?: string;
  }) => {
    setErrorMsg(null);
    const weightToUse = resolveClosestSupportedWeight(params.family, params.weight ?? activeWeightNum);
    const res = await ensureFontLoaded({
      family: params.family,
      weight: weightToUse,
      italic: style.italic,
      customUrl: params.customUrl,
    });
    if (res.status === 'error') {
      setErrorMsg(res.error || `Font "${params.family}" could not be loaded.`);
      return;
    }
    updateStyle(
      {
        fontFamily: params.family,
        fontWeightNum: weightToUse,
        fontWeight: weightToUse >= 850 ? '900' : weightToUse >= 600 ? 'bold' : 'normal',
        customFontId: params.customId,
        customFontUrl: params.customUrl,
        template: 'custom',
      },
      true
    );
  };

  const handleUploadFont = async (file: File) => {
    setErrorMsg(null);
    setSuccessMsg(null);
    setUploadingFont(true);
    try {
      const res = await api.uploadCustomFont(file);
      onCustomFontsChanged();
      await ensureFontLoaded({ family: res.font.family, weight: 400, customUrl: res.font.url });
      updateStyle(
        {
          fontFamily: res.font.family,
          customFontId: res.font.id,
          customFontUrl: res.font.url,
          template: 'custom',
        },
        true
      );
      setSuccessMsg(`Uploaded font "${res.font.family}".`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadingFont(false);
    }
  };

  const filteredCatalogFonts = useMemo(() => {
    const q = fontSearch.trim().toLowerCase();
    const favs = new Set((style.favoriteFonts || []).map((f) => f.toLowerCase()));
    return BUILTIN_FONT_CATALOG.filter((item) => {
      if (fontCategory === 'Favorites' && !favs.has(item.family.toLowerCase())) return false;
      if (
        fontCategory !== 'All' &&
        fontCategory !== 'Favorites' &&
        fontCategory !== 'Custom' &&
        item.category !== fontCategory
      ) {
        return false;
      }
      if (fontCategory === 'Custom') return false;
      if (q && !item.family.toLowerCase().includes(q) && !item.category.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [fontCategory, fontSearch, style.favoriteFonts]);

  useEffect(() => {
    if (memory.captionsTab !== 'fonts') return;
    filteredCatalogFonts.slice(0, 12).forEach((item) => {
      void ensureFontLoaded({ family: item.family, weight: item.defaultWeight });
    });
  }, [memory.captionsTab, filteredCatalogFonts]);

  const patchCaptionState = (
    updater: (cur: Project) => Partial<Project>,
    opts?: { immediate?: boolean; undoGroupKey?: string }
  ) => {
    onPatchProject(
      project.id,
      (cur) => ({
        ...updater(cur),
        workflow: createWorkflowUpdate(cur.workflow, {
          visitStage: 'captions',
          modifiedStage: 'captions',
          hasExistingExport: Boolean(cur.lastExportUrl),
        }),
      }),
      {
        immediate: opts?.immediate,
        debounceMs: opts?.immediate ? 0 : 260,
        undoGroupKey: opts?.undoGroupKey,
      }
    );
  };

  const currentTransform: CaptionTextTransform =
    style.textTransform || (style.uppercase ? 'uppercase' : 'none');

  return (
    <div className="space-y-3">
      {/* Manual Generate / Resync CTA + Quick Toggles */}
      <div className="p-2.5 rounded-xl bg-[#18181D] border border-violet-500/35 flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={handleManualGenerateCaptions}
          disabled={
            busy || project.captions.length === 0 || missingTranslatedCount === project.captions.length
          }
          className="min-h-[38px] px-3.5 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-bold text-white flex items-center gap-1.5 cursor-pointer"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Flame className="w-3.5 h-3.5" />}
          {busy
            ? 'Generating...'
            : syncStatus.hasSnapshot
            ? 'Resync Captions'
            : 'Generate Captions'}
        </button>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => updateStyle({ enabled: !style.enabled }, true)}
            className={`min-h-[36px] px-2.5 py-1.5 rounded-lg text-[11px] font-medium border flex items-center gap-1 cursor-pointer ${
              style.enabled
                ? 'bg-violet-600/25 border-violet-500/45 text-violet-200'
                : 'bg-zinc-900 border-white/[0.08] text-zinc-400'
            }`}
          >
            {style.enabled ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            {style.enabled ? 'Visible' : 'Hidden'}
          </button>

          <label className="min-h-[36px] px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-white/[0.08] flex items-center gap-1.5 text-[11px] text-zinc-200 cursor-pointer">
            <input
              type="checkbox"
              checked={project.exportSettings.applyCaptions}
              onChange={(e) => {
                const checked = e.target.checked;
                onPatchProject(
                  project.id,
                  (cur) => ({
                    exportSettings: { ...cur.exportSettings, applyCaptions: checked },
                  }),
                  { immediate: true }
                );
              }}
              className="accent-violet-500"
            />
            Burn MP4
          </label>
        </div>
      </div>

      {/* Outdated / Missing Translation Warning */}
      {(syncStatus.hasOutdated || (project.captions.length > 0 && missingTranslatedCount > 0)) && (
        <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/35 text-xs text-amber-200 flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            {missingTranslatedCount > 0
              ? `${missingTranslatedCount} segment(s) need translation.`
              : `${syncStatus.outdatedSegmentIds.length} segment(s) changed since last sync.`}
          </span>
          {syncStatus.hasOutdated && (
            <button
              type="button"
              onClick={handleManualGenerateCaptions}
              className="px-2.5 py-1 rounded bg-amber-500/20 border border-amber-500/40 text-[11px] font-semibold text-amber-100 shrink-0 cursor-pointer"
            >
              <RefreshCw className="w-3 h-3 inline mr-1" />
              Resync
            </button>
          )}
        </div>
      )}

      {errorMsg && (
        <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <span>{errorMsg}</span>
        </div>
      )}
      {successMsg && (
        <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-200 flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Sub-Tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
        {(
          [
            { id: 'templates', label: `Templates (${CAPTION_TEMPLATES_LIBRARY.length})` },
            { id: 'style', label: 'Style & Position' },
            { id: 'fonts', label: 'Fonts' },
            { id: 'modes', label: 'Modes & Anim' },
            { id: 'segments', label: `Segments (${syncedCaptions.length})` },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => onUpdateMemory({ captionsTab: tab.id })}
            className={`min-h-[34px] px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 border cursor-pointer ${
              memory.captionsTab === tab.id
                ? 'bg-violet-600 border-violet-500 text-white'
                : 'bg-[#18181D] border-white/[0.08] text-zinc-300 hover:text-white'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Apply Target Scope Switcher (All Captions vs Selected Segment) */}
      {syncedCaptions.length > 0 && memory.captionsTab !== 'segments' && (
        <div className="px-2.5 py-1.5 rounded-lg bg-[#15151B] border border-white/[0.07] flex items-center justify-between gap-2 text-[11px]">
          <span className="text-zinc-400 truncate">
            Editing:{' '}
            <strong className="text-zinc-100">
              {effectiveTarget === 'selected' && quickSelectedCaption
                ? `Selected Caption (${(quickSelectedCaption.translatedText || quickSelectedCaption.text || '').slice(0, 18)})`
                : 'All Captions'}
            </strong>
          </span>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setApplyTarget('all')}
              className={`px-2 py-0.5 rounded text-[10.5px] font-medium cursor-pointer ${
                effectiveTarget === 'all'
                  ? 'bg-violet-600 text-white'
                  : 'bg-zinc-900 text-zinc-400 hover:text-white'
              }`}
            >
              All
            </button>
            <button
              type="button"
              disabled={!quickSelectedCaption}
              onClick={() => setApplyTarget('selected')}
              className={`px-2 py-0.5 rounded text-[10.5px] font-medium cursor-pointer disabled:opacity-40 ${
                effectiveTarget === 'selected'
                  ? 'bg-amber-500/25 border border-amber-500/45 text-amber-200'
                  : 'bg-zinc-900 text-zinc-400 hover:text-white'
              }`}
            >
              Selected
            </button>
            {effectiveTarget === 'selected' && quickSelectedCaption?.styleOverride && (
              <button
                type="button"
                onClick={resetSelectedSegmentOverride}
                title="Clear per-caption override"
                className="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] cursor-pointer"
              >
                Reset
              </button>
            )}
          </div>
        </div>
      )}

      {/* TAB 0: TRENDING CAPTION TEMPLATE LIBRARY (33 TEMPLATES ACROSS 14 CATEGORIES) */}
      {memory.captionsTab === 'templates' && (
        <div className="space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={templateSearch}
                onChange={(e) => setTemplateSearch(e.target.value)}
                placeholder="Search 33 caption templates..."
                className="w-full bg-zinc-900 border border-white/[0.08] rounded-lg pl-8 pr-2.5 py-1.5 text-xs text-zinc-100"
              />
            </div>
            <button
              type="button"
              onClick={() => onUpdateMemory({ captionsTab: 'style' })}
              className="px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-white/[0.08] text-[11px] font-medium text-zinc-200 flex items-center gap-1 shrink-0 cursor-pointer"
            >
              <Sparkles className="w-3 h-3 text-violet-400" />
              Customize
            </button>
          </div>

          <div className="flex items-center gap-1 overflow-x-auto no-scrollbar pb-0.5">
            {CAPTION_TEMPLATE_CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setTemplateCategory(cat)}
                className={`px-2.5 py-1 rounded-md text-[10.5px] font-medium border whitespace-nowrap shrink-0 cursor-pointer ${
                  templateCategory === cat
                    ? 'bg-violet-600 border-violet-500 text-white'
                    : 'bg-zinc-900 border-white/[0.08] text-zinc-300 hover:text-white'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {filteredTemplates.map((tpl) => {
              const s = tpl.style;
              const active = style.template === tpl.id;
              const transform = s.textTransform || (s.uppercase ? 'uppercase' : 'none');
              const renderWord = (word: string) =>
                transform === 'uppercase'
                  ? word.toUpperCase()
                  : transform === 'lowercase'
                  ? word.toLowerCase()
                  : word;

              const bgOpacity = s.backgroundOpacity ?? 0;
              const outlineW = Math.min(2.5, (s.outlineWidth ?? 0) * 0.45);
              const wordWeight =
                s.fontWeightNum ||
                (s.fontWeight === '900' ? 900 : s.fontWeight === 'bold' ? 700 : 400);

              return (
                <button
                  key={tpl.id}
                  type="button"
                  title={tpl.description}
                  onClick={() => void applyTemplateToTarget(tpl)}
                  className={`p-2 rounded-xl border text-left cursor-pointer transition-all overflow-hidden ${
                    active
                      ? 'bg-violet-600/20 border-violet-500 ring-1 ring-violet-400/50'
                      : 'bg-[#18181D] border-white/[0.07] hover:border-white/[0.18]'
                  }`}
                >
                  {/* Visual Preview Box */}
                  <div
                    className="h-14 rounded-lg px-2 flex items-center justify-center relative overflow-hidden mb-1.5 border border-white/[0.05]"
                    style={{
                      background:
                        'radial-gradient(circle at 50% 35%, #272734 0%, #101016 70%, #09090D 100%)',
                    }}
                  >
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded max-w-full truncate"
                      style={{
                        fontFamily: `'${s.fontFamily || 'Montserrat'}', sans-serif`,
                        fontWeight: wordWeight,
                        fontStyle: s.italic ? 'italic' : 'normal',
                        fontSize: `${Math.max(12, Math.min(18, Math.round((s.fontSize || 42) * 0.36)))}px`,
                        letterSpacing: s.letterSpacing ? `${s.letterSpacing * 0.4}px` : undefined,
                        backgroundColor:
                          bgOpacity > 0.05
                            ? `${s.backgroundColor || '#09090B'}${Math.round(bgOpacity * 255)
                                .toString(16)
                                .padStart(2, '0')}`
                            : 'transparent',
                        WebkitTextStroke:
                          outlineW > 0.1
                            ? `${outlineW}px ${s.outlineColor || '#000000'}`
                            : undefined,
                        paintOrder: outlineW > 0.1 ? 'stroke fill' : undefined,
                        textShadow: s.shadowEnabled
                          ? `0 2px 6px ${s.shadowColor || '#000000'}`
                          : undefined,
                      }}
                    >
                      <span style={{ color: s.primaryColor || '#FFFFFF' }}>
                        {renderWord(tpl.sampleWords[0])}
                      </span>
                      <span
                        className={s.highlightBoxEnabled ? 'px-1.5 py-0.2 rounded' : ''}
                        style={{
                          color: s.highlightColor || '#FACC15',
                          backgroundColor: s.highlightBoxEnabled
                            ? s.highlightBoxColor || '#7C3AED'
                            : undefined,
                          WebkitTextFillColor: s.gradientEnabled ? 'transparent' : undefined,
                          backgroundImage: s.gradientEnabled
                            ? `linear-gradient(90deg, ${s.highlightColor || '#FACC15'}, ${
                                s.gradientColor || '#EC4899'
                              })`
                            : undefined,
                          backgroundClip: s.gradientEnabled ? 'text' : undefined,
                        }}
                      >
                        {renderWord(tpl.sampleWords[1])}
                      </span>
                      <span style={{ color: s.primaryColor || '#FFFFFF' }}>
                        {renderWord(tpl.sampleWords[2])}
                      </span>
                    </span>

                    <span className="absolute top-1 left-1.5 text-[8.5px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-black/65 text-zinc-200 border border-white/10">
                      {tpl.badge}
                    </span>
                  </div>

                  <div className="flex items-center justify-between gap-1.5 px-0.5">
                    <span className="text-[11px] font-semibold text-white truncate">
                      {tpl.name}
                    </span>
                    <span className="text-[9.5px] text-zinc-400 truncate shrink-0">
                      {tpl.style.fontFamily}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-[10.5px] text-zinc-500">
              Showing {filteredTemplates.length} of {CAPTION_TEMPLATES_LIBRARY.length} templates
            </span>
            <button
              type="button"
              onClick={() => {
                if (effectiveTarget === 'selected' && quickSelectedCaption?.styleOverride) {
                  resetSelectedSegmentOverride();
                } else {
                  updateStyle(
                    {
                      ...DEFAULT_SUBTITLE_STYLE,
                      enabled: project.subtitleStyle.enabled,
                      captionSync: project.subtitleStyle.captionSync,
                      favoriteFonts: project.subtitleStyle.favoriteFonts,
                      extraElements: project.subtitleStyle.extraElements,
                    },
                    true
                  );
                  setSuccessMsg('Reset captions to clean default style.');
                }
              }}
              className="px-2.5 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-white/[0.08] text-[11px] text-zinc-300 flex items-center gap-1 cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              Reset to Original
            </button>
          </div>
        </div>
      )}

      {/* TAB 1: STYLE, TEMPLATES & POSITION */}
      {memory.captionsTab === 'style' && (
        <div className="space-y-3">
          {/* Quick Selected Caption Text & Timing Editor */}
          {quickSelectedCaption && (
            <div className="p-3 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <select
                  value={quickSelectedCaption.id}
                  onChange={(e) => {
                    setSelectedCaptionId(e.target.value);
                    const picked = syncedCaptions.find((c) => c.id === e.target.value);
                    if (picked) onSeek(picked.syncedStart);
                  }}
                  className="flex-1 min-w-0 bg-zinc-900 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-zinc-100 truncate"
                >
                  {syncedCaptions.map((c, idx) => (
                    <option key={c.id} value={c.id}>
                      #{idx + 1} ({c.syncedStart.toFixed(1)}s–{c.syncedEnd.toFixed(1)}s){' '}
                      {(c.translatedText || '[Empty]').slice(0, 32)}
                    </option>
                  ))}
                </select>
                {captionAtPlayhead && captionAtPlayhead.id !== quickSelectedCaption.id && (
                  <button
                    type="button"
                    onClick={() => setSelectedCaptionId(captionAtPlayhead.id)}
                    className="min-h-[32px] px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-[11px] text-amber-300 font-medium shrink-0 cursor-pointer"
                  >
                    At Playhead
                  </button>
                )}
              </div>

              <textarea
                rows={2}
                value={quickSelectedCaption.translatedText || ''}
                onChange={(e) => {
                  const val = e.target.value;
                  const targetId = quickSelectedCaption.id;
                  patchCaptionState(
                    (cur) => ({
                      captions: cur.captions.map((c) =>
                        c.id === targetId
                          ? { ...c, translatedText: val, words: undefined }
                          : c
                      ),
                    }),
                    { undoGroupKey: `cap-text:${targetId}` }
                  );
                }}
                placeholder="Edit selected caption text..."
                className="w-full bg-zinc-900 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-white resize-none focus:outline-none focus:border-violet-500"
              />

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="text-[10.5px] text-zinc-400">Caption Start (s)</label>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={Number(quickSelectedCaption.syncedStart.toFixed(2))}
                    onChange={(e) => {
                      const val = Math.max(0, Number(e.target.value));
                      const targetId = quickSelectedCaption.id;
                      const currentEnd = quickSelectedCaption.syncedEnd;
                      patchCaptionState(
                        (cur) =>
                          updateCaptionTimingWithSync(
                            cur,
                            targetId,
                            val,
                            Math.max(val + 0.15, currentEnd)
                          ),
                        { undoGroupKey: `cap-time:${targetId}` }
                      );
                    }}
                    className="mt-0.5 w-full bg-zinc-900 border border-white/[0.08] rounded px-2 py-1 text-xs font-mono text-zinc-100"
                  />
                </div>
                <div>
                  <label className="text-[10.5px] text-zinc-400">Caption End (s)</label>
                  <input
                    type="number"
                    min={0.15}
                    step={0.1}
                    value={Number(quickSelectedCaption.syncedEnd.toFixed(2))}
                    onChange={(e) => {
                      const startVal = quickSelectedCaption.syncedStart;
                      const val = Math.max(startVal + 0.15, Number(e.target.value));
                      const targetId = quickSelectedCaption.id;
                      patchCaptionState(
                        (cur) => updateCaptionTimingWithSync(cur, targetId, startVal, val),
                        { undoGroupKey: `cap-time:${targetId}` }
                      );
                    }}
                    className="mt-0.5 w-full bg-zinc-900 border border-white/[0.08] rounded px-2 py-1 text-xs font-mono text-zinc-100"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Quick Viral Templates */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {TRENDING_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => updateStyle(preset.style, true)}
                className="p-2 rounded-xl bg-[#18181D] hover:bg-zinc-800 border border-white/[0.08] text-left cursor-pointer"
              >
                <div
                  className="h-7 rounded flex items-center justify-center font-extrabold text-[11px] mb-1 px-1.5 truncate"
                  style={{ backgroundColor: preset.previewBg, color: preset.previewFg }}
                >
                  {preset.sampleWord}
                </div>
                <div className="text-[10.5px] font-medium text-zinc-200 truncate">{preset.name}</div>
              </button>
            ))}
          </div>

          {/* Core Size, Colors, Position X/Y */}
          <div className="p-3 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-3">
            <div>
              <div className="flex justify-between text-[11px] text-zinc-300">
                <span>Font Size</span>
                <span className="font-mono tabular-nums text-violet-300">{style.fontSize || 42}px</span>
              </div>
              <input
                type="range"
                min={14}
                max={110}
                value={style.fontSize || 42}
                onChange={(e) =>
                  updateStyle({ fontSize: Number(e.target.value) }, false, 'cap:fontSize')
                }
                className="mt-1 w-full accent-violet-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10.5px] text-zinc-400 block mb-1">Text Color</label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="color"
                    value={style.primaryColor || '#FFFFFF'}
                    onChange={(e) =>
                      updateStyle({ primaryColor: e.target.value }, false, 'cap:primaryColor')
                    }
                    className="w-7 h-7 rounded bg-transparent cursor-pointer shrink-0"
                  />
                  {['#FFFFFF', '#FACC15', '#38BDF8', '#4ADE80'].map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => updateStyle({ primaryColor: c }, true)}
                      style={{ backgroundColor: c }}
                      className="w-5 h-5 rounded-full border border-white/25 cursor-pointer"
                    />
                  ))}
                </div>
              </div>
              <div>
                <label className="text-[10.5px] text-zinc-400 block mb-1">Highlight Color</label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="color"
                    value={style.highlightColor || '#FACC15'}
                    onChange={(e) =>
                      updateStyle({ highlightColor: e.target.value }, false, 'cap:highlightColor')
                    }
                    className="w-7 h-7 rounded bg-transparent cursor-pointer shrink-0"
                  />
                  {['#FACC15', '#38BDF8', '#F43F5E', '#A855F7'].map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => updateStyle({ highlightColor: c }, true)}
                      style={{ backgroundColor: c }}
                      className="w-5 h-5 rounded-full border border-white/25 cursor-pointer"
                    />
                  ))}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-1 border-t border-white/[0.06]">
              <div>
                <div className="flex justify-between text-[11px] text-zinc-300">
                  <span>Position X</span>
                  <span className="font-mono">{style.posX ?? 50}%</span>
                </div>
                <input
                  type="range"
                  min={5}
                  max={95}
                  value={style.posX ?? 50}
                  onChange={(e) =>
                    updateStyle({ posX: Number(e.target.value), position: 'custom' }, false, 'cap:posX')
                  }
                  className="mt-1 w-full accent-violet-500"
                />
              </div>
              <div>
                <div className="flex justify-between text-[11px] text-zinc-300">
                  <span>Position Y</span>
                  <span className="font-mono">{style.posY ?? 82}%</span>
                </div>
                <input
                  type="range"
                  min={5}
                  max={95}
                  value={style.posY ?? 82}
                  onChange={(e) =>
                    updateStyle({ posY: Number(e.target.value), position: 'custom' }, false, 'cap:posY')
                  }
                  className="mt-1 w-full accent-violet-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-4 gap-1.5 pt-1">
              {[
                { pos: 'top' as const, y: 14, label: 'Top' },
                { pos: 'middle' as const, y: 50, label: 'Center' },
                { pos: 'bottom' as const, y: 82, label: 'Bottom' },
              ].map((p) => (
                <button
                  key={p.pos}
                  type="button"
                  onClick={() => updateStyle({ position: p.pos, posX: 50, posY: p.y }, true)}
                  className="min-h-[34px] rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-white/[0.08] text-[11px] text-zinc-200 cursor-pointer"
                >
                  {p.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() =>
                  updateStyle(
                    {
                      ...DEFAULT_SUBTITLE_STYLE,
                      enabled: style.enabled,
                      captionSync: style.captionSync,
                      favoriteFonts: style.favoriteFonts,
                      extraElements: style.extraElements,
                    },
                    true
                  )
                }
                className="min-h-[34px] rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-white/[0.08] text-[11px] text-zinc-400 hover:text-white flex items-center justify-center gap-1 cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" /> Reset
              </button>
            </div>
          </div>

          <CollapsibleSection
            title="Advanced Typography, Box, Shadows & Presets"
            subtitle="Stroke, drop shadow, backdrop pill, alignment, wrapping & saved presets"
            open={memory.captionsAdvancedOpen}
            onToggle={(open) => onUpdateMemory({ captionsAdvancedOpen: open })}
          >
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="text-[10.5px] text-zinc-400">Text Case</label>
                <div className="mt-1 grid grid-cols-3 gap-1 bg-zinc-900 p-0.5 rounded-lg">
                  {(['none', 'uppercase', 'lowercase'] as const).map((tf) => (
                    <button
                      key={tf}
                      type="button"
                      onClick={() =>
                        updateStyle({ textTransform: tf, uppercase: tf === 'uppercase' })
                      }
                      className={`py-1 rounded text-[10.5px] cursor-pointer ${
                        currentTransform === tf ? 'bg-violet-600 text-white' : 'text-zinc-400'
                      }`}
                    >
                      {tf === 'none' ? 'Normal' : tf === 'uppercase' ? 'UPPER' : 'lower'}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-[10.5px] text-zinc-400">Alignment</label>
                <div className="mt-1 grid grid-cols-3 gap-1 bg-zinc-900 p-0.5 rounded-lg">
                  {(['left', 'center', 'right'] as const).map((align) => (
                    <button
                      key={align}
                      type="button"
                      onClick={() => updateStyle({ textAlign: align })}
                      className={`py-1 rounded text-[10.5px] capitalize cursor-pointer ${
                        (style.textAlign || 'center') === align
                          ? 'bg-violet-600 text-white'
                          : 'text-zinc-400'
                      }`}
                    >
                      {align}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="flex justify-between text-[11px] text-zinc-300">
                  <span>Outline Thickness</span>
                  <span className="font-mono">{style.outlineWidth ?? 3}px</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={12}
                  step={0.5}
                  value={style.outlineWidth ?? 3}
                  onChange={(e) =>
                    updateStyle({ outlineWidth: Number(e.target.value) }, false, 'cap:outline')
                  }
                  className="mt-1 w-full accent-violet-500"
                />
              </div>
              <div>
                <div className="flex justify-between text-[11px] text-zinc-300">
                  <span>Background Opacity</span>
                  <span className="font-mono">{Math.round((style.backgroundOpacity ?? 0.55) * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round((style.backgroundOpacity ?? 0.55) * 100)}
                  onChange={(e) =>
                    updateStyle(
                      { backgroundOpacity: Number(e.target.value) / 100 },
                      false,
                      'cap:bgOpacity'
                    )
                  }
                  className="mt-1 w-full accent-violet-500"
                />
              </div>
              <div>
                <div className="flex justify-between text-[11px] text-zinc-300">
                  <span>Max Width</span>
                  <span className="font-mono">{style.maxWidthPct ?? 88}%</span>
                </div>
                <input
                  type="range"
                  min={25}
                  max={98}
                  value={style.maxWidthPct ?? 88}
                  onChange={(e) =>
                    updateStyle({ maxWidthPct: Number(e.target.value) }, false, 'cap:maxWidth')
                  }
                  className="mt-1 w-full accent-violet-500"
                />
              </div>
              <div>
                <div className="flex justify-between text-[11px] text-zinc-300">
                  <span>Rotation</span>
                  <span className="font-mono">{Math.round(style.rotation ?? 0)}°</span>
                </div>
                <input
                  type="range"
                  min={-180}
                  max={180}
                  value={style.rotation ?? 0}
                  onChange={(e) =>
                    updateStyle({ rotation: Number(e.target.value) }, false, 'cap:rotation')
                  }
                  className="mt-1 w-full accent-violet-500"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-white/[0.06]">
              <label className="flex items-center gap-1.5 text-xs text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={style.shadowEnabled !== false}
                  onChange={(e) => updateStyle({ shadowEnabled: e.target.checked }, true)}
                  className="accent-violet-500"
                />
                Drop Shadow
              </label>
              <label className="flex items-center gap-1.5 text-xs text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(style.showSafeGuides)}
                  onChange={(e) => updateStyle({ showSafeGuides: e.target.checked }, true)}
                  className="accent-violet-500"
                />
                TikTok Safe Guides
              </label>
            </div>

            <PresetLibraryPanel
              category="caption"
              title="Saved Caption Presets"
              subtitle="Save font, colors, shadows & mode across videos."
              getPayload={() => {
                const assetRefs: StudioPresetAssetRef[] = [];
                if (style.customFontUrl) {
                  assetRefs.push({
                    kind: 'font',
                    label: style.fontFamily,
                    url: style.customFontUrl,
                  });
                }
                const { enabled: _e, captionSync: _cs, ...cleanStyle } = style;
                return {
                  payload: cleanStyle as Record<string, unknown>,
                  assetRefs,
                  thumbnailStyle: {
                    bg: style.backgroundColor || '#09090B',
                    fg: style.highlightColor || '#FACC15',
                    sampleText: 'Aa',
                    badge: `${canonicalMode} · ${style.fontFamily}`,
                  },
                };
              }}
              onApplyPreset={async (preset: StudioPreset) => {
                const res = await api.applyPresetsToProject(project.id, {
                  captionPresetId: preset.id,
                });
                onProjectUpdated(res.project);
                setSuccessMsg(`Applied caption preset "${preset.name}".`);
              }}
            />
          </CollapsibleSection>
        </div>
      )}

      {/* TAB 2: FONT LIBRARY & CUSTOM UPLOAD */}
      {memory.captionsTab === 'fonts' && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <div className="relative flex-1 min-w-[160px]">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={fontSearch}
                onChange={(e) => setFontSearch(e.target.value)}
                placeholder="Search fonts..."
                className="w-full bg-zinc-900 border border-white/[0.08] rounded-lg pl-8 pr-2.5 py-1.5 text-xs text-zinc-100"
              />
            </div>

            <input
              ref={fontInputRef}
              type="file"
              accept=".ttf,.otf,.woff,.woff2"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleUploadFont(f);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              disabled={uploadingFont}
              onClick={() => fontInputRef.current?.click()}
              className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer shrink-0"
            >
              {uploadingFont ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UploadCloud className="w-3.5 h-3.5" />}
              Upload Font
            </button>
          </div>

          <div className="flex gap-1 overflow-x-auto no-scrollbar pb-0.5">
            {(['All', 'Favorites', ...FONT_CATEGORIES] as const).map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setFontCategory(cat)}
                className={`px-2.5 py-1 rounded-md text-[10.5px] font-medium border whitespace-nowrap shrink-0 cursor-pointer ${
                  fontCategory === cat
                    ? 'bg-violet-600 border-violet-500 text-white'
                    : 'bg-zinc-900 border-white/[0.07] text-zinc-300'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-52 overflow-y-auto pr-1">
            {customFonts.map((cf) => (
              <button
                key={cf.id}
                type="button"
                onClick={() =>
                  void handleSelectFont({ family: cf.family, weight: 400, customId: cf.id, customUrl: cf.url })
                }
                className={`p-2 rounded-lg border text-left cursor-pointer flex items-center justify-between ${
                  style.customFontId === cf.id
                    ? 'bg-violet-600/20 border-violet-500 text-white'
                    : 'bg-zinc-900 border-white/[0.06] text-zinc-200'
                }`}
              >
                <span className="text-xs font-medium truncate" style={{ fontFamily: `'${cf.family}'` }}>
                  {cf.family} (Custom)
                </span>
              </button>
            ))}

            {fontCategory !== 'Custom' &&
              filteredCatalogFonts.map((item) => {
                const status = getFontStatus(item.family, item.defaultWeight);
                const isSelected = style.fontFamily.toLowerCase() === item.family.toLowerCase();
                const isFav = (style.favoriteFonts || []).some(
                  (f) => f.toLowerCase() === item.family.toLowerCase()
                );
                return (
                  <div
                    key={item.family}
                    onClick={() =>
                      void handleSelectFont({ family: item.family, weight: item.defaultWeight })
                    }
                    className={`p-2 rounded-lg border cursor-pointer flex items-center justify-between gap-2 ${
                      isSelected
                        ? 'bg-violet-600/20 border-violet-500 text-white'
                        : 'bg-[#18181D] border-white/[0.06] text-zinc-200 hover:border-white/[0.16]'
                    }`}
                  >
                    <div className="min-w-0">
                      <div
                        className="text-xs font-semibold truncate"
                        style={{
                          fontFamily: status.status === 'loaded' ? `'${item.family}', sans-serif` : 'inherit',
                        }}
                      >
                        {item.family}
                      </div>
                      <div className="text-[10px] text-zinc-500">{item.category}</div>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        const existing = style.favoriteFonts || [];
                        const next = isFav
                          ? existing.filter((f) => f.toLowerCase() !== item.family.toLowerCase())
                          : [...existing, item.family];
                        updateStyle({ favoriteFonts: next }, true);
                      }}
                      className={`p-1 cursor-pointer ${isFav ? 'text-amber-400' : 'text-zinc-600'}`}
                    >
                      <Star className="w-3.5 h-3.5" fill={isFav ? 'currentColor' : 'none'} />
                    </button>
                  </div>
                );
              })}
          </div>

          <div className="grid grid-cols-3 gap-2 pt-1">
            <select
              value={resolveClosestSupportedWeight(style.fontFamily, activeWeightNum)}
              onChange={(e) =>
                void handleSelectFont({
                  family: style.fontFamily,
                  weight: Number(e.target.value),
                  customId: style.customFontId,
                  customUrl: style.customFontUrl,
                })
              }
              className="bg-zinc-900 border border-white/[0.08] rounded-lg px-2 py-1.5 text-xs text-zinc-100"
            >
              {[100, 300, 400, 500, 600, 700, 800, 900].map((w) => (
                <option key={w} value={w}>
                  {WEIGHT_LABELS[w] || w}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => updateStyle({ italic: !style.italic }, true)}
              className={`py-1.5 rounded-lg text-xs italic border cursor-pointer ${
                style.italic
                  ? 'bg-violet-600 border-violet-500 text-white'
                  : 'bg-zinc-900 border-white/[0.08] text-zinc-300'
              }`}
            >
              Italic
            </button>
            <button
              type="button"
              onClick={() => updateStyle({ underline: !style.underline }, true)}
              className={`py-1.5 rounded-lg text-xs underline border cursor-pointer ${
                style.underline
                  ? 'bg-violet-600 border-violet-500 text-white'
                  : 'bg-zinc-900 border-white/[0.08] text-zinc-300'
              }`}
            >
              Underline
            </button>
          </div>
        </div>
      )}

      {/* TAB 3: 18 DISPLAY MODES & ANIMATIONS */}
      {memory.captionsTab === 'modes' && (
        <div className="space-y-3">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={modeSearch}
              onChange={(e) => setModeSearch(e.target.value)}
              placeholder="Filter 18 caption display modes..."
              className="w-full bg-zinc-900 border border-white/[0.08] rounded-lg pl-8 pr-2.5 py-1.5 text-xs text-zinc-100"
            />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-40 overflow-y-auto pr-1">
            {CAPTION_DISPLAY_MODES.filter((m) =>
              modeSearch.trim()
                ? m.label.toLowerCase().includes(modeSearch.toLowerCase()) ||
                  m.description.toLowerCase().includes(modeSearch.toLowerCase())
                : true
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() =>
                  updateStyle(
                    {
                      mode: m.id as CaptionDisplayMode,
                      wordsPerDisplay:
                        m.defaultWordsPerDisplay > 0 ? m.defaultWordsPerDisplay : style.wordsPerDisplay,
                      highlightBehavior: m.defaultHighlightBehavior,
                      template: 'custom',
                    },
                    true
                  )
                }
                className={`p-2 rounded-lg text-left border cursor-pointer ${
                  canonicalMode === m.id
                    ? 'bg-violet-600/25 border-violet-500 text-white'
                    : 'bg-[#18181D] border-white/[0.06] text-zinc-300'
                }`}
              >
                <div className="text-[11px] font-semibold truncate">{m.label}</div>
                <div className="text-[9.5px] text-zinc-500 truncate">{m.category}</div>
              </button>
            ))}
          </div>

          {/* Animation Grid */}
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium text-zinc-400">Word &amp; Line Animation</div>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
              {ANIMATIONS.map((anim) => (
                <button
                  key={anim.id}
                  type="button"
                  onClick={() => updateStyle({ animationPreset: anim.id, template: 'custom' }, true)}
                  className={`py-1.5 px-2 rounded-lg text-[11px] border cursor-pointer truncate ${
                    (style.animationPreset || 'none') === anim.id
                      ? 'bg-violet-600 border-violet-500 text-white'
                      : 'bg-zinc-900 border-white/[0.06] text-zinc-300'
                  }`}
                >
                  {anim.label}
                </button>
              ))}
            </div>
          </div>

          <CollapsibleSection title="Timing, Words Per Group & Highlight Settings">
            <div className="space-y-2.5">
              {activeModeDef.supportsWordCount && (
                <div>
                  <div className="flex justify-between text-[11px] text-zinc-300">
                    <span>Words Per Display</span>
                    <span className="font-mono">{style.wordsPerDisplay || 3}</span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={14}
                    value={style.wordsPerDisplay || 3}
                    onChange={(e) =>
                      updateStyle({ wordsPerDisplay: Number(e.target.value) }, false, 'cap:words')
                    }
                    className="mt-1 w-full accent-violet-500"
                  />
                </div>
              )}
              <div>
                <label className="text-[11px] text-zinc-400">Highlight Behavior</label>
                <div className="mt-1 grid grid-cols-5 gap-1 bg-zinc-900 p-0.5 rounded-lg">
                  {(['color', 'box', 'scale', 'underline', 'glow'] as CaptionHighlightBehavior[]).map(
                    (hb) => (
                      <button
                        key={hb}
                        type="button"
                        onClick={() => updateStyle({ highlightBehavior: hb }, true)}
                        className={`py-1 rounded text-[10.5px] capitalize cursor-pointer ${
                          (style.highlightBehavior || 'color') === hb
                            ? 'bg-violet-600 text-white'
                            : 'text-zinc-400'
                        }`}
                      >
                        {hb}
                      </button>
                    )
                  )}
                </div>
              </div>
              <div>
                <div className="flex justify-between text-[11px] text-zinc-300">
                  <span>Caption Timing Offset</span>
                  <span className="font-mono">{style.timingOffsetSec ?? 0}s</span>
                </div>
                <input
                  type="range"
                  min={-3}
                  max={3}
                  step={0.05}
                  value={style.timingOffsetSec ?? 0}
                  onChange={(e) =>
                    updateStyle(
                      { timingOffsetSec: Number(e.target.value) },
                      false,
                      'cap:timingOffset'
                    )
                  }
                  className="mt-1 w-full accent-violet-500"
                />
              </div>
            </div>
          </CollapsibleSection>
        </div>
      )}

      {/* TAB 4: SEGMENTS & SRT/VTT */}
      {memory.captionsTab === 'segments' && (
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                patchCaptionState(
                  (cur) => {
                    const lastEnd = cur.captions.length
                      ? cur.captions[cur.captions.length - 1].end
                      : 0;
                    const dur = cur.metadata?.duration || 12;
                    const start = Math.min(dur - 1, Math.max(0, lastEnd));
                    const end = Math.min(dur, start + 2.5);
                    return {
                      captions: [
                        ...cur.captions,
                        {
                          id: uuidv4(),
                          start: Number(start.toFixed(2)),
                          end: Number(end.toFixed(2)),
                          text: '',
                          translatedText: 'New translated caption',
                        },
                      ],
                    };
                  },
                  { immediate: true }
                );
              }}
              className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-100 flex items-center gap-1 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" /> Add Line
            </button>

            <div className="flex items-center gap-1.5">
              <input
                ref={fileInputRef}
                type="file"
                accept=".srt,.vtt,text/plain"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  try {
                    await onFlushSaves?.(project.id);
                    const text = await file.text();
                    const res = await api.importCaptions(project.id, text);
                    const imported = res.project.captions.map((c) => ({
                      ...c,
                      translatedText: c.translatedText?.trim() || c.text,
                    }));
                    const updatedStyle = { ...res.project.subtitleStyle, enabled: true, useTranslated: true };
                    const { project: saved } = await api.updateProject(project.id, {
                      captions: imported,
                      subtitleStyle: updatedStyle,
                    });
                    onProjectUpdated(saved);
                    setSuccessMsg(`Imported ${res.count} lines from ${file.name}.`);
                  } catch (err) {
                    setErrorMsg(err instanceof Error ? err.message : String(err));
                  }
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-2.5 py-1.5 rounded-lg bg-zinc-800 text-xs text-zinc-200 flex items-center gap-1 cursor-pointer"
              >
                <UploadCloud className="w-3.5 h-3.5" /> Import SRT
              </button>
              {project.captions.length > 0 && (
                <>
                  <a
                    href={`/api/projects/${project.id}/subtitles/srt`}
                    className="px-2 py-1.5 rounded-lg bg-zinc-800 text-xs text-zinc-200 flex items-center gap-1"
                  >
                    <Download className="w-3 h-3" /> SRT
                  </a>
                  <a
                    href={`/api/projects/${project.id}/subtitles/vtt`}
                    className="px-2 py-1.5 rounded-lg bg-zinc-800 text-xs text-zinc-200 flex items-center gap-1"
                  >
                    <Download className="w-3 h-3" /> VTT
                  </a>
                </>
              )}
            </div>
          </div>

          <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
            {syncedCaptions.map((seg, idx) => (
              <div
                key={seg.id}
                onClick={() => onSeek(seg.syncedStart)}
                className="p-2.5 rounded-xl bg-[#18181D] border border-white/[0.06] space-y-1.5"
              >
                <div className="flex items-center justify-between gap-2 text-[11px] font-mono">
                  <span className="text-sky-300">
                    #{idx + 1} · {seg.syncedStart.toFixed(2)}s → {seg.syncedEnd.toFixed(2)}s
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        patchCaptionState(
                          (cur) => {
                            const res = splitCaptionWithSync(cur, seg.id);
                            return { captions: res.captions, voice: res.voice };
                          },
                          { immediate: true }
                        );
                      }}
                      title="Split segment"
                      className="p-1 text-zinc-400 hover:text-white cursor-pointer"
                    >
                      <Scissors className="w-3.5 h-3.5" />
                    </button>
                    {idx < syncedCaptions.length - 1 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          patchCaptionState(
                            (cur) => mergeCaptionWithSync(cur, seg.id),
                            { immediate: true }
                          );
                        }}
                        title="Merge with next"
                        className="p-1 text-zinc-400 hover:text-white cursor-pointer"
                      >
                        <Merge className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        patchCaptionState(
                          (cur) => deleteCaptionWithSync(cur, seg.id),
                          { immediate: true }
                        );
                      }}
                      title="Delete segment"
                      className="p-1 text-zinc-500 hover:text-red-400 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <textarea
                  rows={2}
                  value={seg.translatedText || ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    patchCaptionState(
                      (cur) => ({
                        captions: cur.captions.map((c) =>
                          c.id === seg.id ? { ...c, translatedText: val, words: undefined } : c
                        ),
                      }),
                      { undoGroupKey: `cap-seg-text:${seg.id}` }
                    );
                  }}
                  placeholder="Enter translated caption..."
                  className="w-full bg-zinc-900 border border-white/[0.08] rounded px-2 py-1.5 text-xs text-zinc-100 resize-none"
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
