import React, { useMemo, useState } from 'react';
import {
  Check,
  Clock,
  Copy,
  Eye,
  EyeOff,
  Film,
  Layers,
  Lock,
  Plus,
  RotateCcw,
  Search,
  Sliders,
  Sparkles,
  Star,
  Trash2,
  Unlock,
  Wand2,
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import {
  ColorAdjustments,
  ColorFilterPreset,
  DEFAULT_COLOR_ADJUSTMENTS,
  DEFAULT_VIDEO_EFFECTS,
  FilterLayerItem,
  Project,
  ProjectPatchFn,
  ProjectPatchOptions,
  StudioElementSelection,
  VideoEffectsConfig,
  VisualEffectItem,
  VisualEffectType,
} from '../../types/studio';
import { api } from '../../lib/api';
import { createWorkflowUpdate } from '../../lib/workflowStages';
import {
  findActiveVideoClipAtTime,
  getEffectiveVideoClips,
  getProjectEffectiveDuration,
  getVideoClipTimelineEnd,
} from '../../lib/videoTimeline';
import {
  buildFilterCssWithIntensity,
  EFFECT_CATEGORIES,
  EffectCategoryId,
  FILTER_CATEGORIES,
  FILTER_PRESETS_CATALOG,
  FilterCategoryId,
  getEffectCatalogEntry,
  getFilterPresetMeta,
  VIDEO_EFFECTS_CATALOG,
  VideoEffectCatalogEntry,
} from '../../lib/videoFiltersCatalog';
import { PresetLibraryPanel } from '../PresetLibraryPanel';
import { CollapsibleSection } from '../ui/CollapsibleSection';
import { StudioToolMemory } from './toolMemory';

interface EffectsToolSheetProps {
  mode: 'filters' | 'effects' | 'adjust';
  onSwitchMode: (mode: 'filters' | 'effects' | 'adjust') => void;
  project: Project;
  onProjectUpdated: (p: Project) => void;
  onPatchProject: ProjectPatchFn;
  previewEffects: boolean;
  onTogglePreviewEffects: (val: boolean) => void;
  selectedElement?: StudioElementSelection;
  onSelectElement?: (el: StudioElementSelection) => void;
  currentTime?: number;
  memory: StudioToolMemory;
  onUpdateMemory: (patch: Partial<StudioToolMemory>) => void;
}

export function EffectsToolSheet({
  mode,
  onSwitchMode,
  project,
  onProjectUpdated,
  onPatchProject,
  previewEffects,
  onTogglePreviewEffects,
  selectedElement,
  onSelectElement,
  currentTime = 0,
  memory,
  onUpdateMemory,
}: EffectsToolSheetProps) {
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Filters state
  const [filterCategory, setFilterCategory] = useState<FilterCategoryId | 'Favorites' | 'Recent'>('All');
  const [filterSearch, setFilterSearch] = useState('');
  const [hoveredPresetId, setHoveredPresetId] = useState<ColorFilterPreset | null>(null);
  const [filterTargetMode, setFilterTargetMode] = useState<'global' | 'clip' | 'multi-clip'>(() =>
    selectedElement?.kind === 'video' && selectedElement.clipId ? 'clip' : 'global'
  );
  const [multiClipIds, setMultiClipIds] = useState<string[]>([]);

  // Effects state
  const [fxCategory, setFxCategory] = useState<EffectCategoryId | 'Favorites' | 'Recent'>('All');
  const [fxSearch, setFxSearch] = useState('');
  const [fxPlacementScope, setFxPlacementScope] = useState<'playhead' | 'clip' | 'full'>('playhead');

  const fxConfig: VideoEffectsConfig = project.videoEffects || DEFAULT_VIDEO_EFFECTS;
  const adjustments: ColorAdjustments = fxConfig.adjustments || DEFAULT_COLOR_ADJUSTMENTS;
  const filterStack = fxConfig.filterStack || [];
  const effectsList = fxConfig.effects || [];
  const activeEffectsCount = effectsList.filter((e) => e.enabled).length;
  const favoriteFilters = fxConfig.favoriteFilters || [];
  const recentFilters = fxConfig.recentFilters || [];
  const favoriteEffects = fxConfig.favoriteEffects || [];
  const recentEffects = fxConfig.recentEffects || [];

  const totalDuration = useMemo(() => getProjectEffectiveDuration(project), [project]);
  const videoClips = useMemo(() => getEffectiveVideoClips(project), [project]);
  const targetClip = useMemo(() => {
    if (selectedElement?.kind === 'video' && selectedElement.clipId) {
      const exact = videoClips.find((c) => c.id === selectedElement.clipId);
      if (exact) return exact;
    }
    return findActiveVideoClipAtTime(videoClips, currentTime)?.clip || videoClips[0] || null;
  }, [selectedElement, videoClips, currentTime]);

  const effectiveTargetMode: 'global' | 'clip' | 'multi-clip' =
    filterTargetMode === 'clip' && targetClip
      ? 'clip'
      : filterTargetMode === 'multi-clip' && videoClips.length > 0
      ? 'multi-clip'
      : 'global';

  const selectedFilterLayer = useMemo(
    () =>
      selectedElement?.kind === 'filter' && selectedElement.filterId
        ? filterStack.find((f) => f.id === selectedElement.filterId) || null
        : null,
    [selectedElement, filterStack]
  );

  const selectedEffectItem = useMemo(() => {
    if (selectedElement?.kind === 'effect' && selectedElement.effectId) {
      return effectsList.find((e) => e.id === selectedElement.effectId) || null;
    }
    return effectsList[0] || null;
  }, [selectedElement, effectsList]);

  const currentFilterPreset: ColorFilterPreset = selectedFilterLayer
    ? selectedFilterLayer.preset
    : effectiveTargetMode === 'clip' && targetClip
    ? targetClip.filterPreset || 'none'
    : effectiveTargetMode === 'multi-clip' && multiClipIds.length > 0
    ? videoClips.find((c) => multiClipIds.includes(c.id))?.filterPreset || 'none'
    : fxConfig.filterPreset || 'none';

  const currentFilterIntensity = selectedFilterLayer
    ? selectedFilterLayer.intensity
    : effectiveTargetMode === 'clip' && targetClip
    ? targetClip.filterIntensity ?? 100
    : effectiveTargetMode === 'multi-clip' && multiClipIds.length > 0
    ? videoClips.find((c) => multiClipIds.includes(c.id))?.filterIntensity ?? 100
    : fxConfig.filterIntensity ?? 100;

  const filteredPresets = useMemo(() => {
    const q = filterSearch.trim().toLowerCase();
    return FILTER_PRESETS_CATALOG.filter((p) => {
      if (filterCategory === 'Favorites') {
        if (!favoriteFilters.includes(p.id)) return false;
      } else if (filterCategory === 'Recent') {
        if (!recentFilters.includes(p.id)) return false;
      } else if (filterCategory !== 'All') {
        if (p.id === 'none' || p.category !== filterCategory) return false;
      }
      if (
        q &&
        !p.label.toLowerCase().includes(q) &&
        !p.category.toLowerCase().includes(q) &&
        !p.description.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [filterCategory, filterSearch, favoriteFilters, recentFilters]);

  const updateEffectsConfig = (
    updater: Partial<VideoEffectsConfig> | ((cur: VideoEffectsConfig) => Partial<VideoEffectsConfig>),
    opts?: ProjectPatchOptions
  ) => {
    onPatchProject(
      project.id,
      (cur) => {
        const curFx = cur.videoEffects || DEFAULT_VIDEO_EFFECTS;
        const patch = typeof updater === 'function' ? updater(curFx) : updater;
        return {
          videoEffects: { ...curFx, ...patch },
          workflow: createWorkflowUpdate(cur.workflow, {
            completeStage: 'editor',
            modifiedStage: 'editor',
            hasExistingExport: Boolean(cur.lastExportUrl),
          }),
        };
      },
      opts ?? { immediate: true }
    );
  };

  const recordRecentFilter = (preset: ColorFilterPreset, prevRecents: ColorFilterPreset[]) => {
    if (preset === 'none') return prevRecents;
    return [preset, ...prevRecents.filter((id) => id !== preset)].slice(0, 8);
  };

  const toggleFavoriteFilter = (preset: ColorFilterPreset) => {
    if (preset === 'none') return;
    updateEffectsConfig((curFx) => {
      const prev = curFx.favoriteFilters || [];
      const next = prev.includes(preset) ? prev.filter((x) => x !== preset) : [...prev, preset];
      return { favoriteFilters: next };
    });
  };

  const applyFilterChange = (
    patch: { filterPreset?: ColorFilterPreset; filterIntensity?: number },
    opts?: ProjectPatchOptions
  ) => {
    if (selectedFilterLayer && !selectedFilterLayer.locked) {
      updateEffectsConfig(
        (curFx) => ({
          filterStack: (curFx.filterStack || []).map((f) =>
            f.id === selectedFilterLayer.id
              ? {
                  ...f,
                  ...(patch.filterPreset !== undefined
                    ? {
                        preset: patch.filterPreset,
                        name: getFilterPresetMeta(patch.filterPreset).label,
                      }
                    : {}),
                  ...(patch.filterIntensity !== undefined
                    ? { intensity: patch.filterIntensity }
                    : {}),
                }
              : f
          ),
          ...(patch.filterPreset
            ? { recentFilters: recordRecentFilter(patch.filterPreset, curFx.recentFilters || []) }
            : {}),
        }),
        opts ?? { immediate: true }
      );
      return;
    }

    if (effectiveTargetMode === 'clip' && targetClip) {
      onPatchProject(
        project.id,
        (cur) => {
          const curFx = cur.videoEffects || DEFAULT_VIDEO_EFFECTS;
          const baseClips = getEffectiveVideoClips(cur);
          const nextClips = baseClips.map((c) =>
            c.id === targetClip.id
              ? {
                  ...c,
                  ...(patch.filterPreset !== undefined ? { filterPreset: patch.filterPreset } : {}),
                  ...(patch.filterIntensity !== undefined
                    ? { filterIntensity: patch.filterIntensity }
                    : {}),
                }
              : c
          );
          return {
            videoClips: nextClips,
            ...(patch.filterPreset
              ? {
                  videoEffects: {
                    ...curFx,
                    recentFilters: recordRecentFilter(patch.filterPreset, curFx.recentFilters || []),
                  },
                }
              : {}),
            workflow: createWorkflowUpdate(cur.workflow, {
              completeStage: 'editor',
              modifiedStage: 'editor',
              hasExistingExport: Boolean(cur.lastExportUrl),
            }),
          };
        },
        opts ?? { immediate: true }
      );
      return;
    }

    if (effectiveTargetMode === 'multi-clip' && multiClipIds.length > 0) {
      onPatchProject(
        project.id,
        (cur) => {
          const curFx = cur.videoEffects || DEFAULT_VIDEO_EFFECTS;
          const baseClips = getEffectiveVideoClips(cur);
          const idSet = new Set(multiClipIds);
          const nextClips = baseClips.map((c) =>
            idSet.has(c.id)
              ? {
                  ...c,
                  ...(patch.filterPreset !== undefined ? { filterPreset: patch.filterPreset } : {}),
                  ...(patch.filterIntensity !== undefined
                    ? { filterIntensity: patch.filterIntensity }
                    : {}),
                }
              : c
          );
          return {
            videoClips: nextClips,
            ...(patch.filterPreset
              ? {
                  videoEffects: {
                    ...curFx,
                    recentFilters: recordRecentFilter(patch.filterPreset, curFx.recentFilters || []),
                  },
                }
              : {}),
            workflow: createWorkflowUpdate(cur.workflow, {
              completeStage: 'editor',
              modifiedStage: 'editor',
              hasExistingExport: Boolean(cur.lastExportUrl),
            }),
          };
        },
        opts ?? { immediate: true }
      );
      return;
    }

    updateEffectsConfig(
      (curFx) => ({
        filterPreset: patch.filterPreset !== undefined ? patch.filterPreset : curFx.filterPreset,
        filterIntensity:
          patch.filterIntensity !== undefined
            ? patch.filterIntensity
            : curFx.filterIntensity ?? 100,
        ...(patch.filterPreset
          ? { recentFilters: recordRecentFilter(patch.filterPreset, curFx.recentFilters || []) }
          : {}),
      }),
      opts ?? { immediate: true }
    );
  };

  const addStackedFilterLayer = (preset: ColorFilterPreset) => {
    const resolvedPreset = preset === 'none' ? 'cinematic' : preset;
    const meta = getFilterPresetMeta(resolvedPreset);
    const start = Number(Math.max(0, Math.min(totalDuration - 0.5, currentTime)).toFixed(2));
    const end = Number(Math.min(totalDuration, start + 5).toFixed(2));
    const newId = uuidv4();
    const layer: FilterLayerItem = {
      id: newId,
      preset: resolvedPreset,
      name: meta.label,
      enabled: true,
      locked: false,
      intensity: 85,
      startTime: effectiveTargetMode === 'clip' && targetClip ? targetClip.timelineStart : start,
      endTime:
        effectiveTargetMode === 'clip' && targetClip
          ? getVideoClipTimelineEnd(targetClip)
          : end > start
          ? end
          : totalDuration,
      ...(effectiveTargetMode === 'clip' && targetClip
        ? { clipIds: [targetClip.id] }
        : effectiveTargetMode === 'multi-clip' && multiClipIds.length > 0
        ? { clipIds: [...multiClipIds] }
        : {}),
    };
    updateEffectsConfig((curFx) => ({
      filterStack: [...(curFx.filterStack || []), layer],
      recentFilters: recordRecentFilter(resolvedPreset, curFx.recentFilters || []),
    }));
    onSelectElement?.({ kind: 'filter', filterId: newId });
    setStatusMsg(`Added timed filter layer "${meta.label}".`);
  };

  const updateFilterLayer = (
    filterId: string,
    patch: Partial<FilterLayerItem>,
    opts?: ProjectPatchOptions
  ) => {
    updateEffectsConfig(
      (curFx) => ({
        filterStack: (curFx.filterStack || []).map((f) =>
          f.id === filterId ? { ...f, ...patch } : f
        ),
      }),
      opts
    );
  };

  const removeFilterLayer = (filterId: string) => {
    updateEffectsConfig(
      (curFx) => ({
        filterStack: (curFx.filterStack || []).filter((f) => f.id !== filterId),
      }),
      { immediate: true }
    );
    if (selectedElement?.kind === 'filter' && selectedElement.filterId === filterId) {
      onSelectElement?.(null);
    }
  };

  const resetAllFiltersToOriginal = () => {
    onPatchProject(
      project.id,
      (cur) => {
        const curFx = cur.videoEffects || DEFAULT_VIDEO_EFFECTS;
        const nextClips = Array.isArray(cur.videoClips)
          ? cur.videoClips.map((c) => ({
              ...c,
              filterPreset: 'none' as ColorFilterPreset,
              filterIntensity: 100,
            }))
          : cur.videoClips;
        return {
          videoClips: nextClips,
          videoEffects: {
            ...curFx,
            filterPreset: 'none',
            filterIntensity: 100,
            filterStack: [],
          },
          workflow: createWorkflowUpdate(cur.workflow, {
            completeStage: 'editor',
            modifiedStage: 'editor',
            hasExistingExport: Boolean(cur.lastExportUrl),
          }),
        };
      },
      { immediate: true }
    );
    if (selectedElement?.kind === 'filter') {
      onSelectElement?.(null);
    }
    setStatusMsg('Reset all global, clip & stacked filters to Original footage.');
  };

  const updateAdjustments = (patch: Partial<ColorAdjustments>, opts?: ProjectPatchOptions) => {
    updateEffectsConfig(
      (curFx) => ({
        adjustments: { ...(curFx.adjustments || DEFAULT_COLOR_ADJUSTMENTS), ...patch },
      }),
      opts
    );
  };

  const toggleFavoriteEffect = (type: VisualEffectType) => {
    updateEffectsConfig((curFx) => {
      const prev = curFx.favoriteEffects || [];
      const next = prev.includes(type) ? prev.filter((x) => x !== type) : [...prev, type];
      return { favoriteEffects: next };
    });
  };

  const addEffectInstance = (fxDef: VideoEffectCatalogEntry) => {
    const newId = uuidv4();
    let startTime = 0;
    let endTime = 0;
    let clipId: string | undefined;

    if (fxPlacementScope === 'clip' && targetClip) {
      clipId = targetClip.id;
      startTime = Number(targetClip.timelineStart.toFixed(2));
      endTime = Number(getVideoClipTimelineEnd(targetClip).toFixed(2));
    } else if (fxPlacementScope === 'playhead') {
      const maxStart = Math.max(0, totalDuration - 0.3);
      startTime = Number(Math.max(0, Math.min(maxStart, currentTime)).toFixed(2));
      endTime = Number(Math.min(totalDuration, startTime + fxDef.defaultDurationSec).toFixed(2));
      if (endTime <= startTime) {
        endTime = Number(Math.min(totalDuration, startTime + 1).toFixed(2));
      }
    } else {
      startTime = 0;
      endTime = Number(totalDuration.toFixed(2));
    }

    const item: VisualEffectItem = {
      id: newId,
      type: fxDef.type,
      name: fxDef.label,
      enabled: true,
      locked: false,
      intensity: fxDef.defaultIntensity,
      opacity: fxDef.supportsOpacity ? 1 : undefined,
      startTime,
      endTime,
      clipId,
      speed: fxDef.supportsSpeed ? 1 : undefined,
      posX: fxDef.supportsPosition ? (fxDef.type === 'lens-flare' || fxDef.type === 'light-leaks' || fxDef.type === 'film-burn' ? 0.8 : 0.5) : undefined,
      posY: fxDef.supportsPosition ? (fxDef.type === 'lens-flare' || fxDef.type === 'light-leaks' || fxDef.type === 'film-burn' ? 0.2 : 0.5) : undefined,
      direction: fxDef.supportsDirection ? 'left' : undefined,
      blockSize: fxDef.supportsBlockSize ? (fxDef.type === 'mosaic' ? 18 : 12) : undefined,
      hueShiftDeg: fxDef.supportsHueShift ? 0 : undefined,
      fadeInSec: fxDef.supportsFadeDurations ? 0.6 : undefined,
      fadeOutSec: fxDef.supportsFadeDurations ? 0.6 : undefined,
    };

    updateEffectsConfig(
      (curFx) => ({
        effects: [...(curFx.effects || []), item],
        recentEffects: [
          fxDef.type,
          ...(curFx.recentEffects || []).filter((x) => x !== fxDef.type),
        ].slice(0, 8),
      }),
      { immediate: true }
    );
    onSelectElement?.({ kind: 'effect', effectId: newId });
    setStatusMsg(
      `Added ${fxDef.label} (${startTime.toFixed(1)}s → ${
        endTime > 0 ? `${endTime.toFixed(1)}s` : 'End'
      }).`
    );
  };

  const duplicateEffectInstance = (fx: VisualEffectItem) => {
    if (fx.locked) return;
    const newId = uuidv4();
    const copy: VisualEffectItem = {
      ...fx,
      id: newId,
      name: `${fx.name || getEffectCatalogEntry(fx.type).label} Copy`,
      locked: false,
    };
    updateEffectsConfig(
      (curFx) => ({
        effects: [...(curFx.effects || []), copy],
      }),
      { immediate: true }
    );
    onSelectElement?.({ kind: 'effect', effectId: newId });
  };

  const removeEffectById = (effectId: string) => {
    updateEffectsConfig(
      (curFx) => ({
        effects: (curFx.effects || []).filter((e) => e.id !== effectId),
      }),
      { immediate: true }
    );
    if (selectedElement?.kind === 'effect' && selectedElement.effectId === effectId) {
      onSelectElement?.(null);
    }
  };

  const updateEffectById = (
    effectId: string,
    patch: Partial<VisualEffectItem>,
    opts?: ProjectPatchOptions
  ) => {
    updateEffectsConfig(
      (curFx) => ({
        effects: (curFx.effects || []).map((e) => (e.id === effectId ? { ...e, ...patch } : e)),
      }),
      opts
    );
  };

  const visibleEffectsCatalog = useMemo(() => {
    const q = fxSearch.trim().toLowerCase();
    return VIDEO_EFFECTS_CATALOG.filter((e) => {
      if (fxCategory === 'Favorites') {
        if (!favoriteEffects.includes(e.type)) return false;
      } else if (fxCategory === 'Recent') {
        if (!recentEffects.includes(e.type)) return false;
      } else if (fxCategory !== 'All') {
        if (e.category !== fxCategory) return false;
      }
      if (
        q &&
        !e.label.toLowerCase().includes(q) &&
        !e.category.toLowerCase().includes(q) &&
        !e.description.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [fxCategory, fxSearch, favoriteEffects, recentEffects]);

  const hoveredPreviewMeta = hoveredPresetId ? getFilterPresetMeta(hoveredPresetId) : null;
  const hoveredPreviewData = hoveredPresetId
    ? buildFilterCssWithIntensity(hoveredPresetId, 100)
    : null;

  const selectedFxCatalog = selectedEffectItem
    ? getEffectCatalogEntry(selectedEffectItem.type)
    : null;

  return (
    <div className="space-y-3">
      {/* Subcategory Switcher + Raw Compare */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {[
            { id: 'filters' as const, label: 'Filters', icon: <Wand2 className="w-3.5 h-3.5" /> },
            {
              id: 'effects' as const,
              label: `Effects${activeEffectsCount > 0 ? ` (${activeEffectsCount})` : ''}`,
              icon: <Sparkles className="w-3.5 h-3.5" />,
            },
            { id: 'adjust' as const, label: 'Adjust', icon: <Sliders className="w-3.5 h-3.5" /> },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onSwitchMode(tab.id)}
              className={`min-h-[34px] px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 border cursor-pointer ${
                mode === tab.id
                  ? 'bg-violet-600 border-violet-500 text-white'
                  : 'bg-[#18181D] border-white/[0.08] text-zinc-300 hover:text-white'
              }`}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => onTogglePreviewEffects(!previewEffects)}
          className={`min-h-[34px] px-2.5 py-1.5 rounded-lg text-[11px] font-medium border flex items-center gap-1 cursor-pointer shrink-0 ${
            previewEffects
              ? 'bg-emerald-500/15 border-emerald-500/35 text-emerald-300'
              : 'bg-zinc-900 border-white/[0.08] text-zinc-400'
          }`}
        >
          {previewEffects ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
          <span>{previewEffects ? 'FX On' : 'Raw'}</span>
        </button>
      </div>

      {statusMsg && (
        <div className="px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-200 flex items-center justify-between gap-2">
          <span className="truncate">{statusMsg}</span>
          <button
            type="button"
            onClick={() => setStatusMsg(null)}
            className="text-[10.5px] text-emerald-300 hover:text-white cursor-pointer shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* SUBCATEGORY 1: PROFESSIONAL FILTER LIBRARY (50 FILTERS + MULTI-CLIP + STACKING) */}
      {mode === 'filters' && (
        <div className="space-y-3">
          {/* Target Scope + Intensity + Quick Actions */}
          <div className="p-2.5 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[10.5px] uppercase tracking-wider text-zinc-400 font-semibold">
                {selectedFilterLayer ? 'Timed Layer Target' : 'Filter Target'}
              </span>
              {!selectedFilterLayer ? (
                <div className="flex items-center bg-zinc-900 border border-white/[0.08] rounded-lg p-0.5">
                  <button
                    type="button"
                    onClick={() => setFilterTargetMode('global')}
                    className={`px-2 py-1 rounded text-[11px] font-medium cursor-pointer ${
                      effectiveTargetMode === 'global'
                        ? 'bg-violet-600 text-white'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    Global
                  </button>
                  <button
                    type="button"
                    disabled={!targetClip}
                    onClick={() => setFilterTargetMode('clip')}
                    className={`px-2 py-1 rounded text-[11px] font-medium cursor-pointer disabled:opacity-40 flex items-center gap-1 ${
                      effectiveTargetMode === 'clip'
                        ? 'bg-violet-600 text-white'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    <Film className="w-3 h-3" />
                    Clip
                  </button>
                  {videoClips.length > 1 && (
                    <button
                      type="button"
                      onClick={() => {
                        setFilterTargetMode('multi-clip');
                        if (multiClipIds.length === 0 && targetClip) {
                          setMultiClipIds([targetClip.id]);
                        }
                      }}
                      className={`px-2 py-1 rounded text-[11px] font-medium cursor-pointer ${
                        effectiveTargetMode === 'multi-clip'
                          ? 'bg-violet-600 text-white'
                          : 'text-zinc-400 hover:text-white'
                      }`}
                    >
                      Multi ({multiClipIds.length})
                    </button>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => onSelectElement?.(null)}
                  className="px-2 py-0.5 rounded bg-pink-500/20 border border-pink-400/40 text-[10.5px] text-pink-200 cursor-pointer"
                >
                  Editing Layer · Done
                </button>
              )}
            </div>

            {!selectedFilterLayer && effectiveTargetMode === 'clip' && targetClip && (
              <div className="text-[11px] text-violet-300 flex items-center justify-between bg-violet-500/10 border border-violet-500/25 rounded-lg px-2 py-1">
                <span className="truncate font-medium">Clip: {targetClip.label || 'Clip'}</span>
                <span className="font-mono text-[10px] text-zinc-300 shrink-0">
                  {targetClip.timelineStart.toFixed(1)}s–{getVideoClipTimelineEnd(targetClip).toFixed(1)}s
                </span>
              </div>
            )}

            {!selectedFilterLayer && effectiveTargetMode === 'multi-clip' && videoClips.length > 0 && (
              <div className="p-2 rounded-lg bg-zinc-900/90 border border-white/[0.06] space-y-1 max-h-28 overflow-y-auto">
                <div className="text-[10px] text-zinc-400 font-medium">Select clips to color grade:</div>
                {videoClips.map((vc, idx) => {
                  const checked = multiClipIds.includes(vc.id);
                  return (
                    <label
                      key={vc.id}
                      className="flex items-center justify-between gap-2 text-[11px] text-zinc-200 cursor-pointer py-0.5"
                    >
                      <span className="flex items-center gap-1.5 min-w-0">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setMultiClipIds((prev) =>
                              prev.includes(vc.id)
                                ? prev.filter((id) => id !== vc.id)
                                : [...prev, vc.id]
                            )
                          }
                          className="accent-violet-500"
                        />
                        <span className="truncate">
                          Clip {idx + 1}: {vc.label || 'Video'}
                        </span>
                      </span>
                      <span className="text-[10px] font-mono text-zinc-400 shrink-0">
                        {vc.filterPreset && vc.filterPreset !== 'none'
                          ? getFilterPresetMeta(vc.filterPreset).label
                          : 'Orig'}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}

            {/* Intensity Slider + Fine Adjust Shortcut */}
            <div>
              <div className="flex items-center justify-between text-[11px] mb-1">
                <span className="text-zinc-300 font-medium truncate">
                  {selectedFilterLayer ? 'Layer:' : 'Active:'}{' '}
                  <strong className="text-white">
                    {getFilterPresetMeta(currentFilterPreset).label}
                  </strong>
                </span>
                <span className="font-mono tabular-nums text-violet-300 shrink-0">
                  {currentFilterPreset === 'none' ? '0%' : `${currentFilterIntensity}%`}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={currentFilterPreset === 'none' ? 0 : currentFilterIntensity}
                disabled={currentFilterPreset === 'none' || Boolean(selectedFilterLayer?.locked)}
                onChange={(e) =>
                  applyFilterChange(
                    { filterIntensity: Number(e.target.value) },
                    {
                      undoGroupKey: `filter-int:${selectedFilterLayer?.id || effectiveTargetMode}:${targetClip?.id || 'global'}`,
                      debounceMs: 180,
                    }
                  )
                }
                className="w-full accent-violet-500 disabled:opacity-40"
              />
            </div>

            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <button
                type="button"
                onClick={() => addStackedFilterLayer(currentFilterPreset)}
                className="min-h-[30px] px-2.5 rounded-lg bg-pink-600/20 hover:bg-pink-600/35 border border-pink-500/40 text-[11px] text-pink-100 font-medium flex items-center justify-center gap-1 cursor-pointer"
                title="Add compatible timed filter layer onto Filters track"
              >
                <Plus className="w-3 h-3" />
                Stack Layer
              </button>
              <button
                type="button"
                onClick={() => onSwitchMode('adjust')}
                className="min-h-[30px] px-2.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-white/[0.08] text-[11px] text-zinc-200 font-medium flex items-center justify-center gap-1 cursor-pointer"
              >
                <Sliders className="w-3 h-3 text-violet-400" />
                Tune Sliders
              </button>
              {currentFilterPreset !== 'none' && !selectedFilterLayer && (
                <button
                  type="button"
                  onClick={() => applyFilterChange({ filterPreset: 'none', filterIntensity: 100 })}
                  className="min-h-[30px] px-2.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-[11px] text-red-200 font-medium flex items-center justify-center gap-1 cursor-pointer"
                >
                  <Trash2 className="w-3 h-3" />
                  Remove
                </button>
              )}
              <button
                type="button"
                onClick={resetAllFiltersToOriginal}
                className="min-h-[30px] px-2.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-white/[0.08] text-[11px] text-zinc-300 hover:text-white font-medium flex items-center justify-center gap-1 cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                Reset All
              </button>
            </div>
          </div>

          {/* Live Hover Preview Swatch Banner */}
          {hoveredPreviewMeta && hoveredPreviewData && (
            <div className="px-2.5 py-2 rounded-xl bg-zinc-900/95 border border-violet-500/40 flex items-center gap-2.5">
              <div className="w-12 h-8 rounded overflow-hidden shrink-0 relative bg-zinc-950">
                <div
                  className="w-full h-full"
                  style={{
                    background:
                      'linear-gradient(135deg, #0EA5E9 0%, #F59E0B 48%, #EC4899 78%, #1E1B4B 100%)',
                    filter: hoveredPreviewData.filterCss || undefined,
                  }}
                />
                {hoveredPreviewData.vignetteAlpha > 0 && (
                  <div
                    className="absolute inset-0"
                    style={{
                      background: `radial-gradient(circle, transparent 40%, rgba(0,0,0,${hoveredPreviewData.vignetteAlpha}) 100%)`,
                    }}
                  />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-semibold text-white truncate">
                  Preview: {hoveredPreviewMeta.label}{' '}
                  <span className="text-[10px] font-normal text-zinc-400">
                    ({hoveredPreviewMeta.category})
                  </span>
                </div>
                <div className="text-[10px] text-zinc-400 truncate">
                  {hoveredPreviewMeta.description}
                </div>
              </div>
            </div>
          )}

          {/* Search & Category / Favorites / Recent Filter Bar */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={filterSearch}
              onChange={(e) => setFilterSearch(e.target.value)}
              placeholder="Search 50 filters (Teal & Orange, Noir, VHS, Golden Hour...)"
              className="w-full bg-zinc-900 border border-white/[0.08] rounded-lg pl-8 pr-2.5 py-1.5 text-xs text-zinc-100"
            />
          </div>

          <div className="flex items-center gap-1 overflow-x-auto no-scrollbar pb-0.5">
            {(['All', 'Favorites', 'Recent', ...FILTER_CATEGORIES.filter((c) => c !== 'All')] as const).map(
              (cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setFilterCategory(cat)}
                  className={`px-2.5 py-1 rounded-md text-[10.5px] font-medium border whitespace-nowrap shrink-0 cursor-pointer flex items-center gap-1 ${
                    filterCategory === cat
                      ? 'bg-violet-600 border-violet-500 text-white'
                      : 'bg-zinc-900 border-white/[0.08] text-zinc-300 hover:text-white'
                  }`}
                >
                  {cat === 'Favorites' && <Star className="w-2.5 h-2.5 text-amber-400" />}
                  {cat === 'Recent' && <Clock className="w-2.5 h-2.5 text-sky-400" />}
                  <span>{cat}</span>
                </button>
              )
            )}
          </div>

          {/* Visual Filter Preview Grid (50 Filters + Original) */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {filteredPresets.map((preset) => {
              const active = currentFilterPreset === preset.id;
              const isFav = favoriteFilters.includes(preset.id);
              const previewData = buildFilterCssWithIntensity(preset.id, 100);
              return (
                <div
                  key={preset.id}
                  onMouseEnter={() => setHoveredPresetId(preset.id)}
                  onMouseLeave={() => setHoveredPresetId((cur) => (cur === preset.id ? null : cur))}
                  className={`group relative rounded-xl border transition-all overflow-hidden ${
                    active
                      ? 'bg-violet-600/20 border-violet-500 text-white ring-1 ring-violet-400/50'
                      : 'bg-[#18181D] border-white/[0.07] text-zinc-300 hover:border-white/[0.22]'
                  }`}
                >
                  <button
                    type="button"
                    title={preset.description}
                    onClick={() =>
                      applyFilterChange({
                        filterPreset: preset.id,
                        filterIntensity:
                          preset.id === 'none' ? 100 : currentFilterIntensity || 85,
                      })
                    }
                    className="w-full p-1.5 text-left cursor-pointer"
                  >
                    <div className="relative h-12 rounded-lg overflow-hidden mb-1.5 bg-zinc-950">
                      <div
                        className="w-full h-full"
                        style={{
                          background:
                            'linear-gradient(135deg, #0EA5E9 0%, #F59E0B 48%, #EC4899 78%, #1E1B4B 100%)',
                          filter: previewData.filterCss || undefined,
                        }}
                      >
                        <div className="w-full h-full flex items-end justify-between px-2 pb-1 bg-gradient-to-t from-black/65 via-transparent to-transparent">
                          <span className="w-3 h-3 rounded-full bg-amber-200/90 shadow-sm mb-2" />
                          <span className="text-[8.5px] font-bold tracking-wide text-white/95 drop-shadow truncate max-w-[75%]">
                            {preset.category}
                          </span>
                        </div>
                      </div>
                      {previewData.tintOverlay && (
                        <div
                          className="absolute inset-0 pointer-events-none"
                          style={{ backgroundColor: previewData.tintOverlay, mixBlendMode: 'screen' }}
                        />
                      )}
                      {previewData.vignetteAlpha > 0 && (
                        <div
                          className="absolute inset-0 pointer-events-none"
                          style={{
                            background: `radial-gradient(circle, transparent 40%, rgba(0,0,0,${previewData.vignetteAlpha}) 100%)`,
                          }}
                        />
                      )}
                      {active && (
                        <span className="absolute top-1 left-1 w-4 h-4 rounded-full bg-violet-600 text-white flex items-center justify-center shadow">
                          <Check className="w-2.5 h-2.5" />
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] font-semibold truncate px-0.5 pr-4">
                      {preset.label}
                    </div>
                  </button>

                  {preset.id !== 'none' && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFavoriteFilter(preset.id);
                      }}
                      title={isFav ? 'Remove from favorites' : 'Save to favorites'}
                      className={`absolute top-2 right-2 w-5 h-5 rounded-full flex items-center justify-center bg-black/55 backdrop-blur-sm cursor-pointer transition-opacity ${
                        isFav ? 'opacity-100 text-amber-400' : 'opacity-0 group-hover:opacity-100 text-zinc-300 hover:text-amber-300'
                      }`}
                    >
                      <Star className={`w-3 h-3 ${isFav ? 'fill-amber-400' : ''}`} />
                    </button>
                  )}
                </div>
              );
            })}
            {filteredPresets.length === 0 && (
              <div className="col-span-full py-6 text-center text-xs text-zinc-500">
                No filters match &ldquo;{filterSearch || filterCategory}&rdquo;.
              </div>
            )}
          </div>

          {/* Stacked Timed Filter Layers (filterStack) */}
          {filterStack.length > 0 && (
            <div className="p-2.5 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-2">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-semibold text-white flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5 text-pink-400" />
                  Stacked Filter Layers ({filterStack.length})
                </span>
                <button
                  type="button"
                  onClick={() => updateEffectsConfig({ filterStack: [] })}
                  className="text-[10.5px] text-red-300 hover:text-red-200 cursor-pointer"
                >
                  Clear Stack
                </button>
              </div>
              <div className="space-y-1.5">
                {filterStack.map((fl) => {
                  const isSel = selectedElement?.kind === 'filter' && selectedElement.filterId === fl.id;
                  const meta = getFilterPresetMeta(fl.preset);
                  return (
                    <div
                      key={fl.id}
                      onClick={() => onSelectElement?.({ kind: 'filter', filterId: fl.id })}
                      className={`p-2 rounded-lg border space-y-1.5 cursor-pointer ${
                        isSel
                          ? 'bg-pink-950/30 border-pink-400/60'
                          : 'bg-zinc-900/75 border-white/[0.06] hover:border-white/[0.15]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: meta.badgeColor }}
                          />
                          <span className="text-[11px] font-semibold text-white truncate">
                            {fl.name || meta.label}
                          </span>
                          <span className="text-[10px] font-mono text-zinc-400 shrink-0">
                            {fl.startTime.toFixed(1)}s–{(fl.endTime > fl.startTime ? fl.endTime : totalDuration).toFixed(1)}s
                          </span>
                        </div>
                        <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => updateFilterLayer(fl.id, { enabled: !fl.enabled })}
                            className="p-1 rounded hover:bg-white/[0.08] text-zinc-300 cursor-pointer"
                            title={fl.enabled ? 'Disable' : 'Enable'}
                          >
                            {fl.enabled ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3 text-zinc-500" />}
                          </button>
                          <button
                            type="button"
                            onClick={() => updateFilterLayer(fl.id, { locked: !fl.locked })}
                            className={`p-1 rounded hover:bg-white/[0.08] cursor-pointer ${
                              fl.locked ? 'text-amber-400' : 'text-zinc-400'
                            }`}
                            title={fl.locked ? 'Unlock' : 'Lock'}
                          >
                            {fl.locked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                          </button>
                          <button
                            type="button"
                            onClick={() => removeFilterLayer(fl.id)}
                            disabled={fl.locked}
                            className="p-1 rounded hover:bg-red-500/20 text-zinc-400 hover:text-red-300 disabled:opacity-35 cursor-pointer"
                            title="Delete filter layer"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-1.5 items-center" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          disabled={fl.locked}
                          value={fl.intensity}
                          onChange={(e) =>
                            updateFilterLayer(
                              fl.id,
                              { intensity: Number(e.target.value) },
                              { undoGroupKey: `fstack:${fl.id}:int`, debounceMs: 180 }
                            )
                          }
                          className="col-span-1 accent-pink-500 disabled:opacity-40"
                          title={`Intensity: ${fl.intensity}%`}
                        />
                        <input
                          type="number"
                          min={0}
                          step={0.1}
                          disabled={fl.locked}
                          value={fl.startTime}
                          onChange={(e) =>
                            updateFilterLayer(
                              fl.id,
                              { startTime: Math.max(0, Number(e.target.value)) },
                              { undoGroupKey: `fstack:${fl.id}:time`, debounceMs: 200 }
                            )
                          }
                          className="bg-zinc-950 border border-white/[0.08] rounded px-1.5 py-0.5 text-[10.5px] font-mono text-zinc-100 disabled:opacity-40"
                        />
                        <input
                          type="number"
                          min={0}
                          step={0.1}
                          disabled={fl.locked}
                          value={fl.endTime}
                          onChange={(e) =>
                            updateFilterLayer(
                              fl.id,
                              { endTime: Math.max(0, Number(e.target.value)) },
                              { undoGroupKey: `fstack:${fl.id}:time`, debounceMs: 200 }
                            )
                          }
                          className="bg-zinc-950 border border-white/[0.08] rounded px-1.5 py-0.5 text-[10.5px] font-mono text-zinc-100 disabled:opacity-40"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <CollapsibleSection
            title="Saved Filter Presets Library"
            subtitle="Save & apply custom color recipes across projects"
            open={memory.effectsAdvancedOpen}
            onToggle={(open) => onUpdateMemory({ effectsAdvancedOpen: open })}
          >
            <PresetLibraryPanel
              category="filter"
              title="Filter Presets"
              subtitle="Save current filter, adjustments & FX together."
              getPayload={() => {
                const found = getFilterPresetMeta(fxConfig.filterPreset);
                return {
                  payload: fxConfig as unknown as Record<string, unknown>,
                  thumbnailStyle: {
                    bg: found.badgeColor || '#7C3AED',
                    fg: '#FFFFFF',
                    sampleText: 'FX',
                    badge: `${fxConfig.filterPreset} · ${activeEffectsCount} FX`,
                  },
                };
              }}
              onApplyPreset={async (preset) => {
                const res = await api.applyPresetsToProject(project.id, {
                  filterPresetId: preset.id,
                });
                onProjectUpdated(res.project);
                setStatusMsg(`Applied filter preset "${preset.name}".`);
              }}
            />
          </CollapsibleSection>
        </div>
      )}

      {/* SUBCATEGORY 2: PROFESSIONAL VIDEO EFFECTS LIBRARY (49 WORKING EFFECTS & TRANSITIONS) */}
      {mode === 'effects' && (
        <div className="space-y-3">
          {/* Search + Placement Scope */}
          <div className="p-2.5 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={fxSearch}
                onChange={(e) => setFxSearch(e.target.value)}
                placeholder="Search 49 effects (Lens Flare, Pixelate, VHS, Wipe...)"
                className="w-full bg-zinc-900 border border-white/[0.08] rounded-lg pl-8 pr-2.5 py-1.5 text-xs text-zinc-100"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[10.5px] uppercase tracking-wider text-zinc-400 font-semibold">
                Add Range
              </span>
              <div className="flex items-center bg-zinc-900 border border-white/[0.08] rounded-lg p-0.5">
                {[
                  { id: 'playhead' as const, label: 'At Playhead' },
                  { id: 'clip' as const, label: 'Clip', disabled: !targetClip },
                  { id: 'full' as const, label: 'Full Timeline' },
                ].map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    disabled={opt.disabled}
                    onClick={() => setFxPlacementScope(opt.id)}
                    className={`px-2 py-1 rounded text-[10.5px] font-medium cursor-pointer disabled:opacity-40 ${
                      fxPlacementScope === opt.id
                        ? 'bg-fuchsia-600 text-white'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Categories + Favorites + Recent */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1 overflow-x-auto no-scrollbar pb-0.5 flex-1">
              {(
                ['All', 'Favorites', 'Recent', ...EFFECT_CATEGORIES.filter((c) => c !== 'All')] as const
              ).map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setFxCategory(cat)}
                  className={`px-2 py-1 rounded-md text-[10.5px] font-medium border whitespace-nowrap shrink-0 cursor-pointer flex items-center gap-1 ${
                    fxCategory === cat
                      ? 'bg-fuchsia-600 border-fuchsia-500 text-white'
                      : 'bg-zinc-900 border-white/[0.08] text-zinc-300 hover:text-white'
                  }`}
                >
                  {cat === 'Favorites' && <Star className="w-2.5 h-2.5 text-amber-400" />}
                  {cat === 'Recent' && <Clock className="w-2.5 h-2.5 text-sky-400" />}
                  <span>{cat}</span>
                </button>
              ))}
            </div>
            {effectsList.length > 0 && (
              <button
                type="button"
                onClick={() => updateEffectsConfig({ effects: [] })}
                className="px-2 py-1 rounded-md bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-[10.5px] text-red-300 shrink-0 cursor-pointer"
              >
                Clear ({effectsList.length})
              </button>
            )}
          </div>

          {/* Selected Effect Inspector Controls (strictly tailored per catalog capability) */}
          {selectedEffectItem && selectedFxCatalog && (
            <div className="p-2.5 rounded-xl bg-fuchsia-950/25 border border-fuchsia-500/45 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: selectedFxCatalog.accent }}
                  />
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-white truncate">
                      {selectedEffectItem.name || selectedFxCatalog.label} Controls
                    </div>
                    <div className="text-[10px] text-fuchsia-200/80 font-mono">
                      Duration:{' '}
                      {Math.max(
                        0.1,
                        (selectedEffectItem.endTime > selectedEffectItem.startTime
                          ? selectedEffectItem.endTime
                          : totalDuration) - selectedEffectItem.startTime
                      ).toFixed(2)}
                      s
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() =>
                      updateEffectById(selectedEffectItem.id, {
                        enabled: !selectedEffectItem.enabled,
                      })
                    }
                    className="p-1 rounded hover:bg-white/[0.1] text-zinc-200 cursor-pointer"
                    title={selectedEffectItem.enabled ? 'Disable' : 'Enable'}
                  >
                    {selectedEffectItem.enabled ? (
                      <Eye className="w-3.5 h-3.5" />
                    ) : (
                      <EyeOff className="w-3.5 h-3.5 text-zinc-500" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      updateEffectById(selectedEffectItem.id, {
                        locked: !selectedEffectItem.locked,
                      })
                    }
                    className={`p-1 rounded hover:bg-white/[0.1] cursor-pointer ${
                      selectedEffectItem.locked ? 'text-amber-400' : 'text-zinc-300'
                    }`}
                    title={selectedEffectItem.locked ? 'Unlock' : 'Lock'}
                  >
                    {selectedEffectItem.locked ? (
                      <Lock className="w-3.5 h-3.5" />
                    ) : (
                      <Unlock className="w-3.5 h-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(selectedEffectItem.locked)}
                    onClick={() => duplicateEffectInstance(selectedEffectItem)}
                    className="p-1 rounded hover:bg-white/[0.1] text-zinc-300 disabled:opacity-35 cursor-pointer"
                    title="Duplicate effect"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(selectedEffectItem.locked)}
                    onClick={() => removeEffectById(selectedEffectItem.id)}
                    className="p-1 rounded hover:bg-red-500/20 text-red-300 disabled:opacity-35 cursor-pointer"
                    title="Delete effect"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Intensity */}
              <div>
                <div className="flex justify-between text-[10.5px] text-zinc-300">
                  <span>Intensity</span>
                  <span className="font-mono text-fuchsia-300">{selectedEffectItem.intensity}%</span>
                </div>
                <input
                  type="range"
                  min={5}
                  max={100}
                  disabled={Boolean(selectedEffectItem.locked)}
                  value={selectedEffectItem.intensity}
                  onChange={(e) =>
                    updateEffectById(
                      selectedEffectItem.id,
                      { intensity: Number(e.target.value) },
                      { undoGroupKey: `fx:${selectedEffectItem.id}:int`, debounceMs: 180 }
                    )
                  }
                  className="w-full accent-fuchsia-500 disabled:opacity-40"
                />
              </div>

              {/* Capability: Opacity */}
              {selectedFxCatalog.supportsOpacity && (
                <div>
                  <div className="flex justify-between text-[10.5px] text-zinc-300">
                    <span>Opacity</span>
                    <span className="font-mono text-fuchsia-300">
                      {Math.round((selectedEffectItem.opacity ?? 1) * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={5}
                    max={100}
                    disabled={Boolean(selectedEffectItem.locked)}
                    value={Math.round((selectedEffectItem.opacity ?? 1) * 100)}
                    onChange={(e) =>
                      updateEffectById(
                        selectedEffectItem.id,
                        { opacity: Number(e.target.value) / 100 },
                        { undoGroupKey: `fx:${selectedEffectItem.id}:op`, debounceMs: 180 }
                      )
                    }
                    className="w-full accent-fuchsia-500 disabled:opacity-40"
                  />
                </div>
              )}

              {/* Capability: Speed / Rate */}
              {selectedFxCatalog.supportsSpeed && (
                <div>
                  <div className="flex justify-between text-[10.5px] text-zinc-300">
                    <span>Speed / Rate</span>
                    <span className="font-mono text-fuchsia-300">
                      {(selectedEffectItem.speed ?? 1).toFixed(1)}x
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0.2}
                    max={3}
                    step={0.1}
                    disabled={Boolean(selectedEffectItem.locked)}
                    value={selectedEffectItem.speed ?? 1}
                    onChange={(e) =>
                      updateEffectById(
                        selectedEffectItem.id,
                        { speed: Number(e.target.value) },
                        { undoGroupKey: `fx:${selectedEffectItem.id}:spd`, debounceMs: 180 }
                      )
                    }
                    className="w-full accent-fuchsia-500 disabled:opacity-40"
                  />
                </div>
              )}

              {/* Capability: Position X / Y */}
              {selectedFxCatalog.supportsPosition && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className="flex justify-between text-[10px] text-zinc-400">
                      <span>Position X</span>
                      <span className="font-mono text-fuchsia-300">
                        {Math.round((selectedEffectItem.posX ?? 0.5) * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      disabled={Boolean(selectedEffectItem.locked)}
                      value={Math.round((selectedEffectItem.posX ?? 0.5) * 100)}
                      onChange={(e) =>
                        updateEffectById(
                          selectedEffectItem.id,
                          { posX: Number(e.target.value) / 100 },
                          { undoGroupKey: `fx:${selectedEffectItem.id}:posX`, debounceMs: 180 }
                        )
                      }
                      className="w-full accent-fuchsia-500 disabled:opacity-40"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between text-[10px] text-zinc-400">
                      <span>Position Y</span>
                      <span className="font-mono text-fuchsia-300">
                        {Math.round((selectedEffectItem.posY ?? 0.5) * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      disabled={Boolean(selectedEffectItem.locked)}
                      value={Math.round((selectedEffectItem.posY ?? 0.5) * 100)}
                      onChange={(e) =>
                        updateEffectById(
                          selectedEffectItem.id,
                          { posY: Number(e.target.value) / 100 },
                          { undoGroupKey: `fx:${selectedEffectItem.id}:posY`, debounceMs: 180 }
                        )
                      }
                      className="w-full accent-fuchsia-500 disabled:opacity-40"
                    />
                  </div>
                </div>
              )}

              {/* Capability: Direction */}
              {selectedFxCatalog.supportsDirection && (
                <div>
                  <label className="text-[10px] text-zinc-400 block mb-1">Direction</label>
                  <div className="grid grid-cols-4 gap-1">
                    {(['left', 'right', 'up', 'down'] as const).map((dir) => (
                      <button
                        key={dir}
                        type="button"
                        disabled={Boolean(selectedEffectItem.locked)}
                        onClick={() => updateEffectById(selectedEffectItem.id, { direction: dir })}
                        className={`py-1 rounded text-[10.5px] font-medium capitalize border cursor-pointer disabled:opacity-40 ${
                          (selectedEffectItem.direction || 'left') === dir
                            ? 'bg-fuchsia-600 border-fuchsia-400 text-white'
                            : 'bg-zinc-900 border-white/[0.08] text-zinc-300'
                        }`}
                      >
                        {dir}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Capability: Block Size */}
              {selectedFxCatalog.supportsBlockSize && (
                <div>
                  <div className="flex justify-between text-[10.5px] text-zinc-300">
                    <span>Block Size</span>
                    <span className="font-mono text-fuchsia-300">
                      {selectedEffectItem.blockSize ?? 12}px
                    </span>
                  </div>
                  <input
                    type="range"
                    min={4}
                    max={48}
                    step={2}
                    disabled={Boolean(selectedEffectItem.locked)}
                    value={selectedEffectItem.blockSize ?? 12}
                    onChange={(e) =>
                      updateEffectById(
                        selectedEffectItem.id,
                        { blockSize: Number(e.target.value) },
                        { undoGroupKey: `fx:${selectedEffectItem.id}:blk`, debounceMs: 180 }
                      )
                    }
                    className="w-full accent-fuchsia-500 disabled:opacity-40"
                  />
                </div>
              )}

              {/* Capability: Hue Shift */}
              {selectedFxCatalog.supportsHueShift && (
                <div>
                  <div className="flex justify-between text-[10.5px] text-zinc-300">
                    <span>Hue Shift</span>
                    <span className="font-mono text-fuchsia-300">
                      {selectedEffectItem.hueShiftDeg ?? 0}°
                    </span>
                  </div>
                  <input
                    type="range"
                    min={-180}
                    max={180}
                    step={5}
                    disabled={Boolean(selectedEffectItem.locked)}
                    value={selectedEffectItem.hueShiftDeg ?? 0}
                    onChange={(e) =>
                      updateEffectById(
                        selectedEffectItem.id,
                        { hueShiftDeg: Number(e.target.value) },
                        { undoGroupKey: `fx:${selectedEffectItem.id}:hue`, debounceMs: 180 }
                      )
                    }
                    className="w-full accent-fuchsia-500 disabled:opacity-40"
                  />
                </div>
              )}

              {/* Capability: Fade In / Out durations */}
              {selectedFxCatalog.supportsFadeDurations && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-zinc-400 block">Fade In (s)</label>
                    <input
                      type="number"
                      min={0}
                      max={5}
                      step={0.1}
                      disabled={Boolean(selectedEffectItem.locked)}
                      value={selectedEffectItem.fadeInSec ?? 0.6}
                      onChange={(e) =>
                        updateEffectById(
                          selectedEffectItem.id,
                          { fadeInSec: Math.max(0, Number(e.target.value)) },
                          { undoGroupKey: `fx:${selectedEffectItem.id}:fin`, debounceMs: 200 }
                        )
                      }
                      className="mt-0.5 w-full bg-zinc-950 border border-white/[0.08] rounded px-2 py-1 text-[11px] font-mono text-zinc-100 disabled:opacity-40"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-zinc-400 block">Fade Out (s)</label>
                    <input
                      type="number"
                      min={0}
                      max={5}
                      step={0.1}
                      disabled={Boolean(selectedEffectItem.locked)}
                      value={selectedEffectItem.fadeOutSec ?? 0.6}
                      onChange={(e) =>
                        updateEffectById(
                          selectedEffectItem.id,
                          { fadeOutSec: Math.max(0, Number(e.target.value)) },
                          { undoGroupKey: `fx:${selectedEffectItem.id}:fout`, debounceMs: 200 }
                        )
                      }
                      className="mt-0.5 w-full bg-zinc-950 border border-white/[0.08] rounded px-2 py-1 text-[11px] font-mono text-zinc-100 disabled:opacity-40"
                    />
                  </div>
                </div>
              )}

              {/* Timing & Optional Clip Binding */}
              <div className="grid grid-cols-3 gap-1.5 items-end">
                <div>
                  <label className="text-[10px] text-zinc-400 block">Bind Clip</label>
                  <select
                    disabled={Boolean(selectedEffectItem.locked)}
                    value={selectedEffectItem.clipId || ''}
                    onChange={(e) => {
                      const cid = e.target.value || undefined;
                      const boundClip = cid ? videoClips.find((vc) => vc.id === cid) : undefined;
                      updateEffectById(
                        selectedEffectItem.id,
                        {
                          clipId: cid,
                          ...(boundClip
                            ? {
                                startTime: Number(boundClip.timelineStart.toFixed(2)),
                                endTime: Number(getVideoClipTimelineEnd(boundClip).toFixed(2)),
                              }
                            : {}),
                        },
                        { immediate: true }
                      );
                    }}
                    className="mt-0.5 w-full bg-zinc-950 border border-white/[0.08] rounded px-1.5 py-1 text-[10.5px] text-zinc-100 truncate disabled:opacity-40"
                  >
                    <option value="">All Clips</option>
                    {videoClips.map((vc, idx) => (
                      <option key={vc.id} value={vc.id}>
                        Clip {idx + 1}: {vc.label || 'Video'}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-zinc-400 block">Start (s)</label>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    disabled={Boolean(selectedEffectItem.locked)}
                    value={selectedEffectItem.startTime}
                    onChange={(e) =>
                      updateEffectById(
                        selectedEffectItem.id,
                        { startTime: Math.max(0, Number(e.target.value)) },
                        { undoGroupKey: `fx:${selectedEffectItem.id}:time`, debounceMs: 200 }
                      )
                    }
                    className="mt-0.5 w-full bg-zinc-950 border border-white/[0.08] rounded px-2 py-1 text-[11px] font-mono text-zinc-100 disabled:opacity-40"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-zinc-400 block">End (s, 0=end)</label>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    disabled={Boolean(selectedEffectItem.locked)}
                    value={selectedEffectItem.endTime}
                    onChange={(e) =>
                      updateEffectById(
                        selectedEffectItem.id,
                        { endTime: Math.max(0, Number(e.target.value)) },
                        { undoGroupKey: `fx:${selectedEffectItem.id}:time`, debounceMs: 200 }
                      )
                    }
                    className="mt-0.5 w-full bg-zinc-950 border border-white/[0.08] rounded px-2 py-1 text-[11px] font-mono text-zinc-100 disabled:opacity-40"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Active Timeline Effects List (if multiple instances exist) */}
          {effectsList.length > 0 && (
            <div className="p-2 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-1">
              <div className="text-[10.5px] font-semibold text-zinc-300 px-1 mb-1">
                Active Timeline Effects ({effectsList.length})
              </div>
              <div className="max-h-36 overflow-y-auto space-y-1 pr-0.5">
                {effectsList.map((fx) => {
                  const cat = getEffectCatalogEntry(fx.type);
                  const isSel = selectedEffectItem?.id === fx.id;
                  return (
                    <div
                      key={fx.id}
                      onClick={() => onSelectElement?.({ kind: 'effect', effectId: fx.id })}
                      className={`px-2 py-1.5 rounded-lg border flex items-center justify-between gap-2 cursor-pointer text-[11px] ${
                        isSel
                          ? 'bg-fuchsia-600/20 border-fuchsia-400/70 text-white'
                          : 'bg-zinc-900/70 border-white/[0.06] text-zinc-300 hover:border-white/[0.15]'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: cat.accent }}
                        />
                        <span className="font-medium truncate">{fx.name || cat.label}</span>
                        <span className="text-[10px] font-mono text-zinc-400 shrink-0">
                          {fx.startTime.toFixed(1)}s–{(fx.endTime > fx.startTime ? fx.endTime : totalDuration).toFixed(1)}s
                        </span>
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={() => updateEffectById(fx.id, { enabled: !fx.enabled })}
                          className="p-1 rounded hover:bg-white/[0.08] cursor-pointer"
                          title={fx.enabled ? 'Disable' : 'Enable'}
                        >
                          {fx.enabled ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3 text-zinc-500" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => updateEffectById(fx.id, { locked: !fx.locked })}
                          className={`p-1 rounded hover:bg-white/[0.08] cursor-pointer ${
                            fx.locked ? 'text-amber-400' : 'text-zinc-400'
                          }`}
                          title={fx.locked ? 'Unlock' : 'Lock'}
                        >
                          {fx.locked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                        </button>
                        <button
                          type="button"
                          disabled={Boolean(fx.locked)}
                          onClick={() => removeEffectById(fx.id)}
                          className="p-1 rounded hover:bg-red-500/20 text-zinc-400 hover:text-red-300 disabled:opacity-35 cursor-pointer"
                          title="Delete effect"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Effects Catalog Cards (Add Independent Instances) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {visibleEffectsCatalog.map((fxDef) => {
              const countOnTrack = effectsList.filter((e) => e.type === fxDef.type).length;
              const isFav = favoriteEffects.includes(fxDef.type);

              return (
                <div
                  key={fxDef.type}
                  className={`p-2 rounded-xl border transition-colors flex items-center justify-between gap-2 ${
                    countOnTrack > 0
                      ? 'bg-fuchsia-950/20 border-fuchsia-500/40'
                      : 'bg-[#18181D] border-white/[0.06] hover:border-white/[0.16]'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => addEffectInstance(fxDef)}
                    className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer"
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: fxDef.accent }}
                    />
                    <div className="min-w-0">
                      <div className="text-[11.5px] font-semibold text-white truncate flex items-center gap-1.5">
                        <span className="truncate">{fxDef.label}</span>
                        {countOnTrack > 0 && (
                          <span className="px-1 rounded bg-fuchsia-600/35 text-[9.5px] font-mono text-fuchsia-200">
                            ×{countOnTrack}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-zinc-400 truncate">{fxDef.description}</div>
                    </div>
                  </button>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => toggleFavoriteEffect(fxDef.type)}
                      title={isFav ? 'Unfavorite' : 'Favorite effect'}
                      className={`p-1 rounded hover:bg-white/[0.08] cursor-pointer ${
                        isFav ? 'text-amber-400' : 'text-zinc-500 hover:text-amber-300'
                      }`}
                    >
                      <Star className={`w-3 h-3 ${isFav ? 'fill-amber-400' : ''}`} />
                    </button>
                    <button
                      type="button"
                      onClick={() => addEffectInstance(fxDef)}
                      title={`Add ${fxDef.label} to timeline`}
                      className="min-h-[26px] px-2 rounded-lg bg-fuchsia-600/25 hover:bg-fuchsia-600 border border-fuchsia-500/40 text-[10.5px] font-medium text-fuchsia-100 hover:text-white flex items-center gap-1 cursor-pointer"
                    >
                      <Plus className="w-3 h-3" />
                      Add
                    </button>
                  </div>
                </div>
              );
            })}
            {visibleEffectsCatalog.length === 0 && (
              <div className="col-span-full py-6 text-center text-xs text-zinc-500">
                No effects match &ldquo;{fxSearch || fxCategory}&rdquo;.
              </div>
            )}
          </div>
        </div>
      )}

      {/* SUBCATEGORY 3: COLOR ADJUSTMENTS (12 REAL-TIME + FFMPEG SLIDERS INCL. GRAIN) */}
      {mode === 'adjust' && (
        <div className="space-y-3">
          <div className="p-3 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-white">Essential Color Sliders</span>
              <button
                type="button"
                onClick={() => void updateEffectsConfig({ adjustments: DEFAULT_COLOR_ADJUSTMENTS })}
                className="text-[11px] text-zinc-400 hover:text-white flex items-center gap-1 cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                Reset
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {(
                [
                  { key: 'brightness', label: 'Brightness' },
                  { key: 'contrast', label: 'Contrast' },
                  { key: 'saturation', label: 'Saturation' },
                  { key: 'exposure', label: 'Exposure' },
                ] as const
              ).map((item) => (
                <div key={item.key}>
                  <div className="flex justify-between text-[11px] text-zinc-300">
                    <span>{item.label}</span>
                    <span className="font-mono tabular-nums text-zinc-400">
                      {adjustments[item.key]}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={-100}
                    max={100}
                    value={adjustments[item.key]}
                    onChange={(e) =>
                      updateAdjustments(
                        { [item.key]: Number(e.target.value) },
                        { undoGroupKey: `adj:${item.key}`, debounceMs: 220 }
                      )
                    }
                    className="mt-1 w-full accent-violet-500"
                  />
                </div>
              ))}
            </div>
          </div>

          <CollapsibleSection
            title="Advanced Color Grading"
            subtitle="Temperature, tint, highlights, shadows, sharpness, fade, vignette & grain"
            open={memory.adjustAdvancedOpen}
            onToggle={(open) => onUpdateMemory({ adjustAdvancedOpen: open })}
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {(
                [
                  { key: 'temperature', label: 'Temperature (Cool/Warm)', min: -100, max: 100 },
                  { key: 'tint', label: 'Tint (Green/Magenta)', min: -100, max: 100 },
                  { key: 'highlights', label: 'Highlights', min: -100, max: 100 },
                  { key: 'shadows', label: 'Shadows', min: -100, max: 100 },
                  { key: 'sharpness', label: 'Sharpness', min: 0, max: 100 },
                  { key: 'fade', label: 'Matte Fade', min: 0, max: 100 },
                  { key: 'vignette', label: 'Vignette', min: 0, max: 100 },
                  { key: 'grain', label: 'Film Grain', min: 0, max: 100 },
                ] as const
              ).map((item) => (
                <div key={item.key}>
                  <div className="flex justify-between text-[11px] text-zinc-300">
                    <span>{item.label}</span>
                    <span className="font-mono tabular-nums text-zinc-400">
                      {adjustments[item.key] ?? 0}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={item.min}
                    max={item.max}
                    value={adjustments[item.key] ?? 0}
                    onChange={(e) =>
                      updateAdjustments(
                        { [item.key]: Number(e.target.value) },
                        { undoGroupKey: `adj:${item.key}`, debounceMs: 220 }
                      )
                    }
                    className="mt-1 w-full accent-violet-500"
                  />
                </div>
              ))}
            </div>
          </CollapsibleSection>
        </div>
      )}
    </div>
  );
}
