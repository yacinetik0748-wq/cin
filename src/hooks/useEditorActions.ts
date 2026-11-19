import { useCallback, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import {
  Columns2,
  Copy,
  Crop,
  Droplet,
  Eye,
  EyeOff,
  FileText,
  FlipHorizontal2,
  Gauge,
  Layers,
  Lock,
  Mic,
  MoreHorizontal,
  Move,
  RefreshCw,
  RotateCw,
  Scissors,
  Sparkles,
  SquareDashed,
  Trash2,
  Type,
  Unlink,
  Unlock,
  Volume2,
  VolumeX,
  Wand2,
} from 'lucide-react';
import {
  BlurEffect,
  CaptionSegment,
  DEFAULT_VIDEO_CANVAS,
  DEFAULT_VIDEO_EFFECTS,
  EditSubActionId,
  FilterLayerItem,
  LogoOverlay,
  Project,
  ProjectPatchFn,
  StudioElementSelection,
  StudioToolId,
  SubtitleStyle,
  VideoCanvasConfig,
  VideoClip,
  VideoEffectsConfig,
  VisualEffectItem,
} from '../types/studio';
import { api } from '../lib/api';
import {
  findActiveTimelineAudioAtTime,
  findActiveVideoClipAtTime,
  getEffectiveBgmClips,
  getEffectiveOriginalAudioClips,
  getEffectiveSfxClips,
  getEffectiveVideoClips,
  getProjectEffectiveDuration,
  getVideoClipTimelineEnd,
  splitTimelineAudioClipAtTime,
  splitVideoClipAtTime,
  unlinkVideoClipAudio,
} from '../lib/videoTimeline';
import { getEffectCatalogEntry, getFilterPresetMeta } from '../lib/videoFiltersCatalog';
import {
  createWorkflowUpdate,
  deleteCaptionWithSync,
  getCaptionTimelineOffset,
  getSyncedCaptionsForPreview,
  splitCaptionWithSync,
} from '../lib/workflowStages';
import { getBlurTimelineSpan } from '../lib/blurMasks';
import { StudioToolMemory } from '../components/sheets/toolMemory';

export interface SubToolbarActionItem {
  id: EditSubActionId;
  label: string;
  Icon: typeof Scissors;
  active?: boolean;
}

const DEFAULT_SUB_TOOLBAR_ITEMS: SubToolbarActionItem[] = [
  { id: 'trim', label: 'Trim', Icon: Scissors },
  { id: 'split', label: 'Split', Icon: Columns2 },
  { id: 'speed', label: 'Speed', Icon: Gauge },
  { id: 'volume', label: 'Volume', Icon: Volume2 },
  { id: 'rotate', label: 'Rotate', Icon: RotateCw },
  { id: 'crop', label: 'Crop', Icon: Crop },
  { id: 'flip', label: 'Flip H', Icon: FlipHorizontal2 },
  { id: 'duplicate', label: 'Duplicate', Icon: Copy },
  { id: 'more', label: 'More', Icon: MoreHorizontal },
];

interface UseEditorActionsParams {
  activeProject: Project | null;
  currentTime: number;
  selectedElement: StudioElementSelection;
  drawMode: 'none' | 'selective' | 'motion';
  moreMenuOpen: boolean;
  setMoreMenuOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  setActiveTool: (tool: StudioToolId | null | ((prev: StudioToolId | null) => StudioToolId | null)) => void;
  setDrawMode: (mode: 'none' | 'selective' | 'motion' | ((prev: 'none' | 'selective' | 'motion') => 'none' | 'selective' | 'motion')) => void;
  setCropEditMode: (val: boolean | ((prev: boolean) => boolean)) => void;
  setSelectedBlurId: (id: string | null) => void;
  setSelectedLogoId: (id: string | null) => void;
  setSelectedElement: (el: StudioElementSelection) => void;
  handleSelectElement: (el: StudioElementSelection) => void;
  handleOpenTool: (tool: StudioToolId, subTab?: string) => void;
  updateToolMemory: (patch: Partial<StudioToolMemory>) => void;
  commitProjectPatch: ProjectPatchFn;
  handleProjectUpdated: (project: Project) => void;
  handleInteractiveLogoUpdate: (logoId: string, patch: Partial<LogoOverlay>) => void;
  handleInteractiveBlurUpdate: (blurId: string, patch: Partial<BlurEffect>) => void;
  handleInteractiveSubtitleStyleUpdate: (
    patch: Partial<SubtitleStyle>,
    opts?: { undoGroupKey?: string; immediate?: boolean }
  ) => void;
  handleInteractiveCanvasUpdate: (
    patch: Partial<VideoCanvasConfig>,
    opts?: { immediate?: boolean; undoGroupKey?: string }
  ) => void;
  showNotice: (msg: string, opts?: { allowUndo?: boolean; durationMs?: number }) => void;
}

export function useEditorActions({
  activeProject,
  currentTime,
  selectedElement,
  drawMode,
  moreMenuOpen,
  setMoreMenuOpen,
  setActiveTool,
  setDrawMode,
  setCropEditMode,
  setSelectedBlurId,
  setSelectedLogoId,
  setSelectedElement,
  handleSelectElement,
  handleOpenTool,
  updateToolMemory,
  commitProjectPatch,
  handleProjectUpdated,
  handleInteractiveLogoUpdate,
  handleInteractiveBlurUpdate,
  handleInteractiveSubtitleStyleUpdate,
  handleInteractiveCanvasUpdate,
  showNotice,
}: UseEditorActionsParams) {
  const handleDuplicateSelected = useCallback(() => {
    if (!activeProject) return;

    if (selectedElement?.kind === 'video') {
      const clips = getEffectiveVideoClips(activeProject);
      const orig =
        (selectedElement.clipId ? clips.find((c) => c.id === selectedElement.clipId) : null) ||
        findActiveVideoClipAtTime(clips, currentTime)?.clip ||
        clips[0];
      if (orig) {
        const copyId = uuidv4();
        const copyStart = getVideoClipTimelineEnd(orig);
        commitProjectPatch(
          activeProject.id,
          (cur) => {
            const curClips = getEffectiveVideoClips(cur);
            const copy: VideoClip = {
              ...orig,
              id: copyId,
              label: `${orig.label || 'Clip'} Copy`,
              timelineStart: copyStart,
            };
            return {
              videoClips: [...curClips, copy].sort((a, b) => a.timelineStart - b.timelineStart),
              workflow: createWorkflowUpdate(cur.workflow, {
                completeStage: 'editor',
                modifiedStage: 'editor',
                hasExistingExport: Boolean(cur.lastExportUrl),
              }),
            };
          },
          { immediate: true }
        );
        handleSelectElement({ kind: 'video', clipId: copyId });
        showNotice(`Duplicated video clip at ${copyStart.toFixed(2)}s.`);
        return;
      }
    }

    if (selectedElement?.kind === 'blur') {
      const orig = activeProject.blurs.find((b) => b.id === selectedElement.id);
      if (orig && !orig.locked) {
        const copyId = uuidv4();
        commitProjectPatch(
          activeProject.id,
          (cur) => {
            const copy: BlurEffect = {
              ...orig,
              id: copyId,
              name: `${orig.name} Copy`,
              x: Math.min(0.95 - orig.width, orig.x + 0.03),
              y: Math.min(0.95 - orig.height, orig.y + 0.03),
            };
            const nextBlurs = [...cur.blurs, copy];
            const nextCanvas: VideoCanvasConfig = {
              ...DEFAULT_VIDEO_CANVAS,
              ...(cur.canvas || {}),
              ...(cur.canvas?.layerOrder
                ? { layerOrder: [...cur.canvas.layerOrder, `blur:${copy.id}`] }
                : {}),
            };
            return {
              blurs: nextBlurs,
              canvas: nextCanvas,
              workflow: createWorkflowUpdate(cur.workflow, {
                completeStage: 'editor',
                modifiedStage: 'editor',
                hasExistingExport: Boolean(cur.lastExportUrl),
              }),
            };
          },
          { immediate: true }
        );
        handleSelectElement({ kind: 'blur', id: copyId });
        showNotice(`Duplicated blur "${orig.name}".`);
        return;
      }
    }

    if (selectedElement?.kind === 'logo') {
      const orig = activeProject.logos.find((l) => l.id === selectedElement.id);
      if (orig && !orig.locked) {
        const copyId = uuidv4();
        commitProjectPatch(
          activeProject.id,
          (cur) => {
            const copy: LogoOverlay = {
              ...orig,
              id: copyId,
              x: Math.min(0.92, orig.x + 0.03),
              y: Math.min(0.92, orig.y + 0.03),
              presetPosition: 'custom',
            };
            const nextLogos = [...cur.logos, copy];
            const nextCanvas: VideoCanvasConfig = {
              ...DEFAULT_VIDEO_CANVAS,
              ...(cur.canvas || {}),
              ...(cur.canvas?.layerOrder
                ? { layerOrder: [...cur.canvas.layerOrder, `logo:${copy.id}`] }
                : {}),
            };
            return {
              logos: nextLogos,
              canvas: nextCanvas,
              workflow: createWorkflowUpdate(cur.workflow, {
                completeStage: 'editor',
                modifiedStage: 'editor',
                hasExistingExport: Boolean(cur.lastExportUrl),
              }),
            };
          },
          { immediate: true }
        );
        handleSelectElement({ kind: 'logo', id: copyId });
        showNotice(`Duplicated overlay "${orig.filename}".`);
        return;
      }
    }

    if (selectedElement?.kind === 'caption-element') {
      const orig = (activeProject.subtitleStyle.extraElements || []).find(
        (el) => el.id === selectedElement.id
      );
      if (orig && !orig.locked) {
        const copyId = uuidv4();
        commitProjectPatch(
          activeProject.id,
          (cur) => {
            const copy = {
              ...orig,
              id: copyId,
              label: `${orig.label} Copy`,
              style: {
                ...orig.style,
                posX: Math.min(92, (orig.style.posX ?? 50) + 4),
                posY: Math.min(92, (orig.style.posY ?? 22) + 4),
              },
            };
            const nextEls = [...(cur.subtitleStyle.extraElements || []), copy];
            const nextCanvas: VideoCanvasConfig = {
              ...DEFAULT_VIDEO_CANVAS,
              ...(cur.canvas || {}),
              ...(cur.canvas?.layerOrder
                ? { layerOrder: [...cur.canvas.layerOrder, `caption-element:${copy.id}`] }
                : {}),
            };
            return {
              subtitleStyle: { ...cur.subtitleStyle, extraElements: nextEls },
              canvas: nextCanvas,
              workflow: createWorkflowUpdate(cur.workflow, {
                visitStage: 'captions',
                modifiedStage: 'captions',
                hasExistingExport: Boolean(cur.lastExportUrl),
              }),
            };
          },
          { immediate: true }
        );
        handleSelectElement({ kind: 'caption-element', id: copyId });
        showNotice(`Duplicated text "${orig.label}".`);
        return;
      }
    }

    if (selectedElement?.kind === 'filter' && selectedElement.filterId) {
      const fxConfig = activeProject.videoEffects || DEFAULT_VIDEO_EFFECTS;
      const orig = (fxConfig.filterStack || []).find((f) => f.id === selectedElement.filterId);
      if (orig) {
        if (orig.locked) {
          showNotice('Unlock this filter layer before duplicating.');
          return;
        }
        const copyId = uuidv4();
        const label = orig.name || getFilterPresetMeta(orig.preset).label;
        commitProjectPatch(
          activeProject.id,
          (cur) => {
            const curFx = cur.videoEffects || DEFAULT_VIDEO_EFFECTS;
            const copy: FilterLayerItem = {
              ...orig,
              id: copyId,
              name: `${label} Copy`,
              locked: false,
            };
            return {
              videoEffects: {
                ...curFx,
                filterStack: [...(curFx.filterStack || []), copy],
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
        handleSelectElement({ kind: 'filter', filterId: copyId });
        showNotice(`Duplicated filter layer "${label}".`);
        return;
      }
    }

    if (selectedElement?.kind === 'effect' && selectedElement.effectId) {
      const fxConfig = activeProject.videoEffects || DEFAULT_VIDEO_EFFECTS;
      const orig = (fxConfig.effects || []).find((e) => e.id === selectedElement.effectId);
      if (orig) {
        if (orig.locked) {
          showNotice('Unlock this effect before duplicating.');
          return;
        }
        const copyId = uuidv4();
        const label = orig.name || getEffectCatalogEntry(orig.type).label;
        commitProjectPatch(
          activeProject.id,
          (cur) => {
            const curFx = cur.videoEffects || DEFAULT_VIDEO_EFFECTS;
            const copy: VisualEffectItem = {
              ...orig,
              id: copyId,
              name: `${label} Copy`,
              locked: false,
            };
            return {
              videoEffects: {
                ...curFx,
                effects: [...(curFx.effects || []), copy],
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
        handleSelectElement({ kind: 'effect', effectId: copyId });
        showNotice(`Duplicated effect "${label}".`);
        return;
      }
    }

    const syncedList = getSyncedCaptionsForPreview(activeProject);
    const segIdx =
      selectedElement?.kind === 'captions' && selectedElement.segmentId
        ? syncedList.findIndex((c) => c.id === selectedElement.segmentId)
        : syncedList.findIndex(
            (c) => currentTime >= c.syncedStart && currentTime <= c.syncedEnd
          );
    if (segIdx >= 0) {
      const syncedOrig = syncedList[segIdx];
      const rawOrig = activeProject.captions[segIdx];
      const dur = Math.max(0.4, Number((syncedOrig.syncedEnd - syncedOrig.syncedStart).toFixed(2)));
      const offset = getCaptionTimelineOffset(activeProject);
      const baseStart = Math.max(0, Number((syncedOrig.syncedEnd - offset).toFixed(3)));
      const baseEnd = Number((baseStart + dur).toFixed(3));
      const copyId = uuidv4();
      commitProjectPatch(
        activeProject.id,
        (cur) => {
          const copySeg: CaptionSegment = {
            ...rawOrig,
            id: copyId,
            start: baseStart,
            end: baseEnd,
            words: undefined,
            wordsSource: 'estimated',
          };
          const nextCaptions = [...cur.captions];
          nextCaptions.splice(segIdx + 1, 0, copySeg);
          let nextVoice = cur.voice;
          if (cur.voice.syncPlan?.segments?.length) {
            const syncIdx = cur.voice.syncPlan.segments.findIndex(
              (s) => s.segmentId === rawOrig.id
            );
            if (syncIdx >= 0) {
              const origSync = cur.voice.syncPlan.segments[syncIdx];
              const nextSyncSegs = [...cur.voice.syncPlan.segments];
              nextSyncSegs.splice(syncIdx + 1, 0, {
                ...origSync,
                segmentId: copyId,
                originalStart: baseStart,
                originalEnd: baseEnd,
                syncedStart: baseStart,
                syncedEnd: baseEnd,
              });
              nextVoice = {
                ...cur.voice,
                syncPlan: { ...cur.voice.syncPlan, segments: nextSyncSegs },
              };
            }
          }
          return {
            captions: nextCaptions,
            voice: nextVoice,
            workflow: createWorkflowUpdate(cur.workflow, {
              visitStage: 'captions',
              modifiedStage: 'captions',
              hasExistingExport: Boolean(cur.lastExportUrl),
            }),
          };
        },
        { immediate: true }
      );
      handleSelectElement({ kind: 'captions', segmentId: copyId });
      showNotice('Duplicated caption segment.');
      return;
    }

    showNotice('Select an overlay, blur, text element, or caption segment to duplicate.');
  }, [
    activeProject,
    commitProjectPatch,
    currentTime,
    handleSelectElement,
    selectedElement,
    showNotice,
  ]);

  const handleDeleteSelected = useCallback(() => {
    if (!activeProject) return;
    const effDur = getProjectEffectiveDuration(activeProject);

    if (selectedElement?.kind === 'blur') {
      const orig = activeProject.blurs.find((b) => b.id === selectedElement.id);
      if (orig && !orig.locked) {
        const nextRemaining = activeProject.blurs.filter((b) => b.id !== orig.id);
        commitProjectPatch(
          activeProject.id,
          (cur) => ({
            blurs: cur.blurs.filter((b) => b.id !== orig.id),
            ...(cur.canvas?.layerOrder
              ? {
                  canvas: {
                    ...DEFAULT_VIDEO_CANVAS,
                    ...cur.canvas,
                    layerOrder: cur.canvas.layerOrder.filter((t) => t !== `blur:${orig.id}`),
                  },
                }
              : {}),
            workflow: createWorkflowUpdate(cur.workflow, {
              completeStage: 'editor',
              modifiedStage: 'editor',
              hasExistingExport: Boolean(cur.lastExportUrl),
            }),
          }),
          { immediate: true }
        );
        setSelectedElement(null);
        setSelectedBlurId(nextRemaining[0]?.id || null);
        showNotice(`Deleted blur "${orig.name}".`, { allowUndo: true });
        return;
      }
    }

    if (selectedElement?.kind === 'logo') {
      const orig = activeProject.logos.find((l) => l.id === selectedElement.id);
      if (orig && !orig.locked) {
        const nextRemaining = activeProject.logos.filter((l) => l.id !== orig.id);
        commitProjectPatch(
          activeProject.id,
          (cur) => ({
            logos: cur.logos.filter((l) => l.id !== orig.id),
            ...(cur.canvas?.layerOrder
              ? {
                  canvas: {
                    ...DEFAULT_VIDEO_CANVAS,
                    ...cur.canvas,
                    layerOrder: cur.canvas.layerOrder.filter((t) => t !== `logo:${orig.id}`),
                  },
                }
              : {}),
            workflow: createWorkflowUpdate(cur.workflow, {
              completeStage: 'editor',
              modifiedStage: 'editor',
              hasExistingExport: Boolean(cur.lastExportUrl),
            }),
          }),
          { immediate: true }
        );
        setSelectedElement(null);
        setSelectedLogoId(nextRemaining[0]?.id || null);
        showNotice(`Removed overlay "${orig.filename}".`, { allowUndo: true });
        return;
      }
    }

    if (selectedElement?.kind === 'caption-element') {
      const orig = (activeProject.subtitleStyle.extraElements || []).find(
        (el) => el.id === selectedElement.id
      );
      if (orig && !orig.locked) {
        commitProjectPatch(
          activeProject.id,
          (cur) => ({
            subtitleStyle: {
              ...cur.subtitleStyle,
              extraElements: (cur.subtitleStyle.extraElements || []).filter(
                (el) => el.id !== orig.id
              ),
            },
            ...(cur.canvas?.layerOrder
              ? {
                  canvas: {
                    ...DEFAULT_VIDEO_CANVAS,
                    ...cur.canvas,
                    layerOrder: cur.canvas.layerOrder.filter(
                      (t) => t !== `caption-element:${orig.id}`
                    ),
                  },
                }
              : {}),
            workflow: createWorkflowUpdate(cur.workflow, {
              visitStage: 'captions',
              modifiedStage: 'captions',
              hasExistingExport: Boolean(cur.lastExportUrl),
            }),
          }),
          { immediate: true }
        );
        setSelectedElement(null);
        showNotice(`Removed text overlay "${orig.label}".`, { allowUndo: true });
        return;
      }
    }

    if (selectedElement?.kind === 'video') {
      const clips = getEffectiveVideoClips(activeProject);
      if (clips.length === 0) {
        showNotice('No video clips remaining to delete.');
        return;
      }
      const target =
        (selectedElement.clipId ? clips.find((c) => c.id === selectedElement.clipId) : null) ||
        findActiveVideoClipAtTime(clips, currentTime)?.clip ||
        clips[0];
      if (target) {
        const remaining = clips.filter((c) => c.id !== target.id);
        commitProjectPatch(
          activeProject.id,
          (cur) => ({
            videoClips: getEffectiveVideoClips(cur).filter((c) => c.id !== target.id),
            workflow: createWorkflowUpdate(cur.workflow, {
              completeStage: 'editor',
              modifiedStage: 'editor',
              hasExistingExport: Boolean(cur.lastExportUrl),
            }),
          }),
          { immediate: true }
        );
        setSelectedElement(remaining[0] ? { kind: 'video', clipId: remaining[0].id } : null);
        showNotice(`Deleted video clip "${target.label || 'Clip'}".`, { allowUndo: true });
        return;
      }
    }

    if (selectedElement?.kind === 'audio' && selectedElement.track === 'orig') {
      const origClips = getEffectiveOriginalAudioClips(activeProject);
      if (origClips.length > 0) {
        const target =
          (selectedElement.clipId
            ? origClips.find((c) => c.id === selectedElement.clipId)
            : null) ||
          origClips.find(
            (c) =>
              currentTime >= c.timelineStart &&
              currentTime <= c.timelineStart + Math.max(0.1, c.sourceEnd - c.sourceStart)
          ) ||
          origClips[0];
        if (target) {
          const remaining = origClips.filter((c) => c.id !== target.id);
          commitProjectPatch(
            activeProject.id,
            (cur) => {
              const nextOrig = getEffectiveOriginalAudioClips(cur).filter((c) => c.id !== target.id);
              return {
                originalAudioClips: nextOrig,
                ...(nextOrig.length === 0
                  ? {
                      voice: {
                        ...cur.voice,
                        originalAudioEnabled: false,
                        originalAudioMuted: true,
                        preserveOriginalAudio: false,
                      },
                    }
                  : {}),
                workflow: createWorkflowUpdate(cur.workflow, {
                  visitStage: 'voice',
                  modifiedStage: 'editor',
                  hasExistingExport: Boolean(cur.lastExportUrl),
                }),
              };
            },
            { immediate: true }
          );
          setSelectedElement(
            remaining[0] ? { kind: 'audio', track: 'orig', clipId: remaining[0].id } : null
          );
          showNotice('Deleted original audio clip.', { allowUndo: true });
          return;
        }
      } else if (activeProject.metadata?.hasAudio) {
        commitProjectPatch(
          activeProject.id,
          (cur) => ({
            originalAudioClips: [],
            voice: {
              ...cur.voice,
              originalAudioEnabled: false,
              originalAudioMuted: true,
              preserveOriginalAudio: false,
            },
            workflow: createWorkflowUpdate(cur.workflow, {
              visitStage: 'voice',
              modifiedStage: 'editor',
              hasExistingExport: Boolean(cur.lastExportUrl),
            }),
          }),
          { immediate: true }
        );
        setSelectedElement(null);
        showNotice('Removed linked original audio from project.', { allowUndo: true });
        return;
      }
    }

    if (selectedElement?.kind === 'audio' && selectedElement.track === 'dub') {
      const genClips = activeProject.voice.generatedClips || [];
      if (selectedElement.clipId && genClips.some((c) => c.segmentId === selectedElement.clipId)) {
        const targetClipId = selectedElement.clipId;
        const nextClips = genClips.filter((c) => c.segmentId !== targetClipId);
        commitProjectPatch(
          activeProject.id,
          (cur) => {
            const remainingDub = cur.voice.generatedClips.filter((c) => c.segmentId !== targetClipId);
            return {
              voice: {
                ...cur.voice,
                generatedClips: remainingDub,
                ...(remainingDub.length === 0 ? { fullDubUrl: undefined, enabled: false } : {}),
              },
              workflow: createWorkflowUpdate(cur.workflow, {
                visitStage: 'voice',
                modifiedStage: 'voice',
                hasExistingExport: Boolean(cur.lastExportUrl),
              }),
            };
          },
          { immediate: true }
        );
        window.setTimeout(() => {
          void api
            .rebuildFishDubTrack(activeProject.id, { generatedClips: nextClips })
            .then(({ project: rebuilt }) => handleProjectUpdated(rebuilt))
            .catch(() => {});
        }, 80);
        setSelectedElement(
          nextClips[0] ? { kind: 'audio', track: 'dub', clipId: nextClips[0].segmentId } : null
        );
        showNotice('Deleted narration clip.', { allowUndo: true });
        return;
      }

      if (genClips.length > 0 || activeProject.voice.fullDubUrl) {
        const clipAtPlayhead = genClips.find(
          (c) => currentTime >= c.start && currentTime <= c.end
        );
        if (clipAtPlayhead && genClips.length > 1) {
          const nextClips = genClips.filter((c) => c.segmentId !== clipAtPlayhead.segmentId);
          commitProjectPatch(
            activeProject.id,
            (cur) => ({
              voice: {
                ...cur.voice,
                generatedClips: cur.voice.generatedClips.filter(
                  (c) => c.segmentId !== clipAtPlayhead.segmentId
                ),
              },
              workflow: createWorkflowUpdate(cur.workflow, {
                visitStage: 'voice',
                modifiedStage: 'voice',
                hasExistingExport: Boolean(cur.lastExportUrl),
              }),
            }),
            { immediate: true }
          );
          window.setTimeout(() => {
            void api
              .rebuildFishDubTrack(activeProject.id, { generatedClips: nextClips })
              .then(({ project: rebuilt }) => handleProjectUpdated(rebuilt))
              .catch(() => {});
          }, 80);
          setSelectedElement(
            nextClips[0] ? { kind: 'audio', track: 'dub', clipId: nextClips[0].segmentId } : null
          );
          showNotice('Deleted narration clip at playhead.', { allowUndo: true });
          return;
        }

        commitProjectPatch(
          activeProject.id,
          (cur) => ({
            voice: {
              ...cur.voice,
              generatedClips: [],
              fullDubUrl: undefined,
              enabled: false,
            },
            workflow: createWorkflowUpdate(cur.workflow, {
              visitStage: 'voice',
              modifiedStage: 'voice',
              hasExistingExport: Boolean(cur.lastExportUrl),
            }),
          }),
          { immediate: true }
        );
        window.setTimeout(() => {
          void api
            .rebuildFishDubTrack(activeProject.id, { generatedClips: [] })
            .then(({ project: rebuilt }) => handleProjectUpdated(rebuilt))
            .catch(() => {});
        }, 80);
        setSelectedElement(null);
        showNotice('Removed narration track.', { allowUndo: true });
        return;
      }
    }

    if (selectedElement?.kind === 'audio' && selectedElement.track === 'bgm') {
      const bgmClips = getEffectiveBgmClips(activeProject, effDur);
      if (bgmClips.length > 0 || activeProject.voice.bgMusicUrl) {
        const target =
          (selectedElement.clipId ? bgmClips.find((c) => c.id === selectedElement.clipId) : null) ||
          findActiveTimelineAudioAtTime(bgmClips, currentTime)?.clip ||
          bgmClips[0];
        const remaining = target ? bgmClips.filter((c) => c.id !== target.id) : [];
        commitProjectPatch(
          activeProject.id,
          (cur) => ({
            voice: {
              ...cur.voice,
              bgMusicClips: remaining,
              ...(remaining.length === 0
                ? {
                    bgMusicEnabled: false,
                    bgMusicMuted: true,
                    bgMusicUrl: undefined,
                    bgMusicFilename: undefined,
                  }
                : {}),
            },
            workflow: createWorkflowUpdate(cur.workflow, {
              visitStage: 'voice',
              modifiedStage: 'editor',
              hasExistingExport: Boolean(cur.lastExportUrl),
            }),
          }),
          { immediate: true }
        );
        setSelectedElement(
          remaining[0] ? { kind: 'audio', track: 'bgm', clipId: remaining[0].id } : null
        );
        showNotice(
          remaining.length === 0 ? 'Removed background music.' : 'Deleted music clip.',
          { allowUndo: true }
        );
        return;
      }
    }

    if (selectedElement?.kind === 'audio' && selectedElement.track === 'sfx') {
      const sfxClips = getEffectiveSfxClips(activeProject, effDur);
      if (sfxClips.length > 0 || activeProject.voice.sfxUrl) {
        const target =
          (selectedElement.clipId ? sfxClips.find((c) => c.id === selectedElement.clipId) : null) ||
          findActiveTimelineAudioAtTime(sfxClips, currentTime)?.clip ||
          sfxClips[0];
        const remaining = target ? sfxClips.filter((c) => c.id !== target.id) : [];
        commitProjectPatch(
          activeProject.id,
          (cur) => ({
            voice: {
              ...cur.voice,
              sfxClips: remaining,
              ...(remaining.length === 0
                ? {
                    sfxEnabled: false,
                    sfxMuted: true,
                    sfxUrl: undefined,
                    sfxFilename: undefined,
                  }
                : {}),
            },
            workflow: createWorkflowUpdate(cur.workflow, {
              visitStage: 'voice',
              modifiedStage: 'editor',
              hasExistingExport: Boolean(cur.lastExportUrl),
            }),
          }),
          { immediate: true }
        );
        setSelectedElement(
          remaining[0] ? { kind: 'audio', track: 'sfx', clipId: remaining[0].id } : null
        );
        showNotice(remaining.length === 0 ? 'Removed SFX track.' : 'Deleted sound effect clip.', {
          allowUndo: true,
        });
        return;
      }
    }

    if (selectedElement?.kind === 'captions') {
      const syncedList = getSyncedCaptionsForPreview(activeProject);
      const targetSeg = selectedElement.segmentId
        ? syncedList.find((c) => c.id === selectedElement.segmentId)
        : syncedList.find((c) => currentTime >= c.syncedStart && currentTime <= c.syncedEnd);
      if (targetSeg) {
        commitProjectPatch(
          activeProject.id,
          (cur) => ({
            ...deleteCaptionWithSync(cur, targetSeg.id),
            workflow: createWorkflowUpdate(cur.workflow, {
              visitStage: 'captions',
              modifiedStage: 'captions',
              hasExistingExport: Boolean(cur.lastExportUrl),
            }),
          }),
          { immediate: true }
        );
        setSelectedElement({ kind: 'captions' });
        showNotice('Deleted caption segment.', { allowUndo: true });
        return;
      }
    }

    if (selectedElement?.kind === 'filter') {
      const curFx = activeProject.videoEffects || DEFAULT_VIDEO_EFFECTS;
      if (selectedElement.filterId) {
        const targetFilter = (curFx.filterStack || []).find(
          (f) => f.id === selectedElement.filterId
        );
        if (targetFilter?.locked) {
          showNotice('Unlock this filter layer before deleting.');
          return;
        }
        commitProjectPatch(
          activeProject.id,
          (cur) => {
            const fx = cur.videoEffects || DEFAULT_VIDEO_EFFECTS;
            return {
              videoEffects: {
                ...fx,
                filterStack: (fx.filterStack || []).filter(
                  (f) => f.id !== selectedElement.filterId
                ),
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
        setSelectedElement(null);
        showNotice('Removed filter layer from timeline.', { allowUndo: true });
        return;
      }
      if (curFx.filterPreset !== 'none') {
        commitProjectPatch(
          activeProject.id,
          (cur) => {
            const fx = cur.videoEffects || DEFAULT_VIDEO_EFFECTS;
            return {
              videoEffects: {
                ...fx,
                filterPreset: 'none',
                filterIntensity: 100,
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
        setSelectedElement(null);
        showNotice('Reset global filter to Original.', { allowUndo: true });
        return;
      }
    }

    if (selectedElement?.kind === 'effect' && selectedElement.effectId) {
      const targetFxId = selectedElement.effectId;
      const targetFx = (activeProject.videoEffects?.effects || []).find(
        (e) => e.id === targetFxId
      );
      if (targetFx?.locked) {
        showNotice('Unlock this effect before removing it.');
        return;
      }
      commitProjectPatch(
        activeProject.id,
        (cur) => {
          const curFx = cur.videoEffects || DEFAULT_VIDEO_EFFECTS;
          return {
            videoEffects: {
              ...curFx,
              effects: (curFx.effects || []).filter((e) => e.id !== targetFxId),
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
      setSelectedElement(null);
      showNotice('Removed visual effect from timeline.', { allowUndo: true });
      return;
    }

    showNotice('Select a video clip, audio clip, overlay, blur, filter, effect, or caption segment to delete.');
  }, [
    activeProject,
    commitProjectPatch,
    currentTime,
    handleProjectUpdated,
    selectedElement,
    setSelectedBlurId,
    setSelectedElement,
    setSelectedLogoId,
    showNotice,
  ]);

  const handleSplitAtPlayhead = useCallback(() => {
    if (!activeProject) return;
    const dur = getProjectEffectiveDuration(activeProject);

    if (selectedElement?.kind === 'video' || !selectedElement) {
      const clips = getEffectiveVideoClips(activeProject);
      const targetClip =
        selectedElement?.kind === 'video' && selectedElement.clipId
          ? clips.find((c) => c.id === selectedElement.clipId) ||
            findActiveVideoClipAtTime(clips, currentTime)?.clip
          : findActiveVideoClipAtTime(clips, currentTime)?.clip;
      if (targetClip) {
        const res = splitVideoClipAtTime([targetClip], currentTime, uuidv4);
        if (res) {
          const splitTime = res.splitTime;
          commitProjectPatch(
            activeProject.id,
            (cur) => {
              const curClips = getEffectiveVideoClips(cur);
              const nextClips = curClips
                .flatMap((c) => (c.id === targetClip.id ? res.clips : [c]))
                .sort((a, b) => a.timelineStart - b.timelineStart);
              return {
                videoClips: nextClips,
                workflow: createWorkflowUpdate(cur.workflow, {
                  completeStage: 'editor',
                  modifiedStage: 'editor',
                  hasExistingExport: Boolean(cur.lastExportUrl),
                }),
              };
            },
            { immediate: true }
          );
          handleSelectElement({ kind: 'video', clipId: res.secondId });
          showNotice(`Split video clip at ${splitTime.toFixed(2)}s (other tracks untouched).`);
          return;
        }
        if (selectedElement?.kind === 'video') {
          showNotice('Video clip must be at least 0.4s long to split.');
          return;
        }
      } else if (selectedElement?.kind === 'video') {
        showNotice('Move playhead inside a video clip to split.');
        return;
      }
    }

    if (selectedElement?.kind === 'audio' && selectedElement.track === 'orig') {
      const existingOrig = getEffectiveOriginalAudioClips(activeProject);
      if (existingOrig.length === 0 && activeProject.metadata?.hasAudio) {
        const unlinked = unlinkVideoClipAudio(activeProject, undefined, uuidv4);
        const target =
          unlinked.originalAudioClips.find(
            (c) =>
              currentTime >= c.timelineStart &&
              currentTime <= c.timelineStart + Math.max(0.1, c.sourceEnd - c.sourceStart)
          ) || unlinked.originalAudioClips[0];
        if (!target) {
          showNotice('No original audio clip found at playhead.');
          return;
        }
        const span = Math.max(0.1, target.sourceEnd - target.sourceStart);
        if (span < 0.4) {
          showNotice('Audio clip must be at least 0.4s long to split.');
          return;
        }
        const tlEnd = target.timelineStart + span;
        const splitTl =
          currentTime > target.timelineStart + 0.2 && currentTime < tlEnd - 0.2
            ? Number(currentTime.toFixed(3))
            : Number(((target.timelineStart + tlEnd) / 2).toFixed(3));
        const splitSrc = Number((target.sourceStart + (splitTl - target.timelineStart)).toFixed(3));
        const secondId = uuidv4();
        const nextOrig = unlinked.originalAudioClips
          .flatMap((c) =>
            c.id === target.id
              ? [
                  { ...c, sourceEnd: splitSrc },
                  {
                    ...c,
                    id: secondId,
                    label: `${c.label || 'Audio'} (2)`,
                    sourceStart: splitSrc,
                    timelineStart: splitTl,
                  },
                ]
              : [c]
          )
          .sort((a, b) => a.timelineStart - b.timelineStart);
        commitProjectPatch(
          activeProject.id,
          (cur) => ({
            videoClips: unlinked.videoClips,
            originalAudioClips: nextOrig,
            voice: {
              ...cur.voice,
              originalAudioMuted: false,
              originalAudioEnabled: true,
              preserveOriginalAudio: true,
            },
            workflow: createWorkflowUpdate(cur.workflow, {
              visitStage: 'voice',
              modifiedStage: 'editor',
              hasExistingExport: Boolean(cur.lastExportUrl),
            }),
          }),
          { immediate: true }
        );
        handleSelectElement({ kind: 'audio', track: 'orig', clipId: secondId });
        showNotice(`Unlinked & split original audio at ${splitTl.toFixed(2)}s.`);
        return;
      }

      const oa = selectedElement.clipId
        ? existingOrig.find((c) => c.id === selectedElement.clipId)
        : existingOrig.find(
            (c) =>
              currentTime >= c.timelineStart &&
              currentTime <= c.timelineStart + Math.max(0.1, c.sourceEnd - c.sourceStart)
          ) || existingOrig[0];
      if (oa) {
        const span = Math.max(0.1, oa.sourceEnd - oa.sourceStart);
        if (span < 0.4) {
          showNotice('Audio clip must be at least 0.4s long to split.');
          return;
        }
        const tlEnd = oa.timelineStart + span;
        const splitTl =
          currentTime > oa.timelineStart + 0.2 && currentTime < tlEnd - 0.2
            ? Number(currentTime.toFixed(3))
            : Number(((oa.timelineStart + tlEnd) / 2).toFixed(3));
        const splitSrc = Number((oa.sourceStart + (splitTl - oa.timelineStart)).toFixed(3));
        const secondId = uuidv4();
        commitProjectPatch(
          activeProject.id,
          (cur) => ({
            originalAudioClips: getEffectiveOriginalAudioClips(cur)
              .flatMap((c) =>
                c.id === oa.id
                  ? [
                      { ...c, sourceEnd: splitSrc },
                      {
                        ...c,
                        id: secondId,
                        label: `${c.label || 'Audio'} (2)`,
                        sourceStart: splitSrc,
                        timelineStart: splitTl,
                      },
                    ]
                  : [c]
              )
              .sort((a, b) => a.timelineStart - b.timelineStart),
            workflow: createWorkflowUpdate(cur.workflow, {
              visitStage: 'voice',
              modifiedStage: 'editor',
              hasExistingExport: Boolean(cur.lastExportUrl),
            }),
          }),
          { immediate: true }
        );
        handleSelectElement({ kind: 'audio', track: 'orig', clipId: secondId });
        showNotice(`Split 1.0x original audio clip at ${splitTl.toFixed(2)}s.`);
        return;
      }
    }

    if (selectedElement?.kind === 'audio' && selectedElement.track === 'dub') {
      const dubClips = activeProject.voice.generatedClips || [];
      const target =
        (selectedElement.clipId
          ? dubClips.find((c) => c.segmentId === selectedElement.clipId)
          : null) ||
        dubClips.find((c) => currentTime >= c.start && currentTime <= c.end) ||
        dubClips[0];
      if (!target) {
        showNotice('No Fish Audio narration clip available to split.');
        return;
      }
      const span = target.end - target.start;
      if (span < 0.4) {
        showNotice('Narration clip must be at least 0.4s long to split.');
        return;
      }
      const splitTl =
        currentTime > target.start + 0.18 && currentTime < target.end - 0.18
          ? Number(currentTime.toFixed(3))
          : Number(((target.start + target.end) / 2).toFixed(3));
      const baseTrimStart = Math.max(0, target.trimStartSec ?? 0);
      const firstLen = splitTl - target.start;
      const splitAudioSec = Number((baseTrimStart + firstLen).toFixed(3));
      const secondId = `${target.segmentId}__p_${uuidv4().slice(0, 6)}`;
      const nextDubClips = dubClips
        .flatMap((c) =>
          c.segmentId === target.segmentId
            ? [
                {
                  ...c,
                  end: splitTl,
                  trimStartSec: baseTrimStart > 0.005 ? Number(baseTrimStart.toFixed(3)) : undefined,
                  trimEndSec: splitAudioSec,
                },
                {
                  ...c,
                  segmentId: secondId,
                  start: splitTl,
                  trimStartSec: splitAudioSec,
                  trimEndSec: c.trimEndSec,
                },
              ]
            : [c]
        )
        .sort((a, b) => a.start - b.start);

      commitProjectPatch(
        activeProject.id,
        (cur) => ({
          voice: {
            ...cur.voice,
            generatedClips: nextDubClips,
          },
          workflow: createWorkflowUpdate(cur.workflow, {
            visitStage: 'voice',
            modifiedStage: 'voice',
            hasExistingExport: Boolean(cur.lastExportUrl),
          }),
        }),
        { immediate: true }
      );
      window.setTimeout(() => {
        void api
          .rebuildFishDubTrack(activeProject.id, { generatedClips: nextDubClips })
          .then(({ project: rebuilt }) => handleProjectUpdated(rebuilt))
          .catch(() => {});
      }, 80);
      handleSelectElement({ kind: 'audio', track: 'dub', clipId: secondId });
      showNotice(`Split narration clip at ${splitTl.toFixed(2)}s.`);
      return;
    }

    if (selectedElement?.kind === 'audio' && selectedElement.track === 'bgm') {
      const bgmClips = getEffectiveBgmClips(activeProject, dur);
      const res = splitTimelineAudioClipAtTime(bgmClips, currentTime, uuidv4, selectedElement.clipId);
      if (!res) {
        showNotice('Music clip must be at least 0.4s long to split.');
        return;
      }
      commitProjectPatch(
        activeProject.id,
        (cur) => ({
          voice: { ...cur.voice, bgMusicClips: res.clips },
          workflow: createWorkflowUpdate(cur.workflow, {
            visitStage: 'voice',
            modifiedStage: 'editor',
            hasExistingExport: Boolean(cur.lastExportUrl),
          }),
        }),
        { immediate: true }
      );
      handleSelectElement({ kind: 'audio', track: 'bgm', clipId: res.secondId });
      showNotice(`Split music clip at ${res.splitTime.toFixed(2)}s.`);
      return;
    }

    if (selectedElement?.kind === 'audio' && selectedElement.track === 'sfx') {
      const sfxClips = getEffectiveSfxClips(activeProject, dur);
      const res = splitTimelineAudioClipAtTime(sfxClips, currentTime, uuidv4, selectedElement.clipId);
      if (!res) {
        showNotice('Sound effect clip must be at least 0.4s long to split.');
        return;
      }
      commitProjectPatch(
        activeProject.id,
        (cur) => ({
          voice: { ...cur.voice, sfxClips: res.clips },
          workflow: createWorkflowUpdate(cur.workflow, {
            visitStage: 'voice',
            modifiedStage: 'editor',
            hasExistingExport: Boolean(cur.lastExportUrl),
          }),
        }),
        { immediate: true }
      );
      handleSelectElement({ kind: 'audio', track: 'sfx', clipId: res.secondId });
      showNotice(`Split sound effect clip at ${res.splitTime.toFixed(2)}s.`);
      return;
    }

    if (selectedElement?.kind === 'blur') {
      const b = activeProject.blurs.find((x) => x.id === selectedElement.id);
      if (b) {
        if (b.locked) {
          showNotice('Unlock this blur layer before splitting.');
          return;
        }
        const span = getBlurTimelineSpan(b, activeProject);
        if (span.endTime - span.startTime < 0.6) {
          showNotice('Blur region must be at least 0.6s long to split.');
          return;
        }
        const splitTime =
          currentTime > span.startTime + 0.25 && currentTime < span.endTime - 0.25
            ? Number(currentTime.toFixed(2))
            : Number(((span.startTime + span.endTime) / 2).toFixed(2));
        const secondId = uuidv4();
        commitProjectPatch(
          activeProject.id,
          (cur) => {
            const first: BlurEffect = {
              ...b,
              startTime: span.startTime,
              endTime: splitTime,
              subtitleLink: { mode: 'manual' },
              keyframes: undefined,
            };
            const second: BlurEffect = {
              ...b,
              id: secondId,
              name: `${b.name} 2`,
              startTime: splitTime,
              endTime: span.endTime,
              subtitleLink: { mode: 'manual' },
              keyframes: undefined,
            };
            return {
              blurs: cur.blurs.flatMap((x) => (x.id === b.id ? [first, second] : [x])),
              workflow: createWorkflowUpdate(cur.workflow, {
                completeStage: 'editor',
                modifiedStage: 'editor',
                hasExistingExport: Boolean(cur.lastExportUrl),
              }),
            };
          },
          { immediate: true }
        );
        handleSelectElement({ kind: 'blur', id: secondId });
        showNotice(`Split blur "${b.name}" at ${splitTime.toFixed(2)}s.`, { allowUndo: true });
        return;
      }
    }

    if (selectedElement?.kind === 'logo') {
      const l = activeProject.logos.find((x) => x.id === selectedElement.id);
      if (l) {
        if (l.locked) {
          showNotice('Unlock this overlay before splitting.');
          return;
        }
        const start = l.permanent ? 0 : l.startTime;
        const end = l.permanent ? dur : l.endTime;
        if (end - start < 0.6) {
          showNotice('Overlay duration must be at least 0.6s long to split.');
          return;
        }
        const splitTime =
          currentTime > start + 0.25 && currentTime < end - 0.25
            ? Number(currentTime.toFixed(2))
            : Number(((start + end) / 2).toFixed(2));
        commitProjectPatch(
          activeProject.id,
          (cur) => {
            const first: LogoOverlay = {
              ...l,
              permanent: false,
              startTime: start,
              endTime: splitTime,
            };
            const second: LogoOverlay = {
              ...l,
              id: uuidv4(),
              permanent: false,
              startTime: splitTime,
              endTime: end,
            };
            return {
              logos: cur.logos.flatMap((x) => (x.id === l.id ? [first, second] : [x])),
              workflow: createWorkflowUpdate(cur.workflow, {
                completeStage: 'editor',
                modifiedStage: 'editor',
                hasExistingExport: Boolean(cur.lastExportUrl),
              }),
            };
          },
          { immediate: true }
        );
        showNotice(`Split overlay "${l.filename}" at ${splitTime.toFixed(2)}s.`);
        return;
      }
    }

    if (selectedElement?.kind === 'caption-element') {
      const els = activeProject.subtitleStyle.extraElements || [];
      const el = els.find((x) => x.id === selectedElement.id);
      if (el) {
        if (el.locked) {
          showNotice('Unlock this text layer before splitting.');
          return;
        }
        const start = el.startTime || 0;
        const end = el.endTime > start ? el.endTime : dur;
        if (end - start < 0.6) {
          showNotice('Text layer duration must be at least 0.6s long to split.');
          return;
        }
        const splitTime =
          currentTime > start + 0.25 && currentTime < end - 0.25
            ? Number(currentTime.toFixed(2))
            : Number(((start + end) / 2).toFixed(2));
        const first = { ...el, startTime: start, endTime: splitTime };
        const second = {
          ...el,
          id: uuidv4(),
          label: `${el.label} 2`,
          startTime: splitTime,
          endTime: end,
        };
        const nextEls = els.flatMap((x) => (x.id === el.id ? [first, second] : [x]));
        handleInteractiveSubtitleStyleUpdate({ extraElements: nextEls }, { immediate: true });
        showNotice(`Split text layer "${el.label}" at ${splitTime.toFixed(2)}s.`);
        return;
      }
    }

    if (selectedElement?.kind === 'filter' && selectedElement.filterId) {
      const curFx = activeProject.videoEffects || DEFAULT_VIDEO_EFFECTS;
      const fl = (curFx.filterStack || []).find((x) => x.id === selectedElement.filterId);
      if (fl) {
        if (fl.locked) {
          showNotice('Unlock this filter layer before splitting.');
          return;
        }
        const start = Math.max(0, fl.startTime || 0);
        const end = fl.endTime > start ? fl.endTime : dur;
        if (end - start < 0.5) {
          showNotice('Filter layer must be at least 0.5s long to split.');
          return;
        }
        const splitTime =
          currentTime > start + 0.25 && currentTime < end - 0.25
            ? Number(currentTime.toFixed(2))
            : Number(((start + end) / 2).toFixed(2));
        const secondId = uuidv4();
        const label = fl.name || getFilterPresetMeta(fl.preset).label;
        commitProjectPatch(
          activeProject.id,
          (cur) => {
            const fx = cur.videoEffects || DEFAULT_VIDEO_EFFECTS;
            const first: FilterLayerItem = { ...fl, startTime: start, endTime: splitTime };
            const second: FilterLayerItem = {
              ...fl,
              id: secondId,
              name: `${label} 2`,
              startTime: splitTime,
              endTime: end,
            };
            return {
              videoEffects: {
                ...fx,
                filterStack: (fx.filterStack || []).flatMap((x) =>
                  x.id === fl.id ? [first, second] : [x]
                ),
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
        handleSelectElement({ kind: 'filter', filterId: secondId });
        showNotice(`Split filter "${label}" at ${splitTime.toFixed(2)}s.`, { allowUndo: true });
        return;
      }
    }

    if (selectedElement?.kind === 'effect' && selectedElement.effectId) {
      const curFx = activeProject.videoEffects || DEFAULT_VIDEO_EFFECTS;
      const fx = (curFx.effects || []).find((x) => x.id === selectedElement.effectId);
      if (fx) {
        if (fx.locked) {
          showNotice('Unlock this effect before splitting.');
          return;
        }
        const start = Math.max(0, fx.startTime || 0);
        const end = fx.endTime > start ? fx.endTime : dur;
        if (end - start < 0.5) {
          showNotice('Effect duration must be at least 0.5s long to split.');
          return;
        }
        const splitTime =
          currentTime > start + 0.25 && currentTime < end - 0.25
            ? Number(currentTime.toFixed(2))
            : Number(((start + end) / 2).toFixed(2));
        const secondId = uuidv4();
        const label = fx.name || getEffectCatalogEntry(fx.type).label;
        commitProjectPatch(
          activeProject.id,
          (cur) => {
            const cFx = cur.videoEffects || DEFAULT_VIDEO_EFFECTS;
            const first: VisualEffectItem = { ...fx, startTime: start, endTime: splitTime };
            const second: VisualEffectItem = {
              ...fx,
              id: secondId,
              name: `${label} 2`,
              startTime: splitTime,
              endTime: end,
            };
            return {
              videoEffects: {
                ...cFx,
                effects: (cFx.effects || []).flatMap((x) =>
                  x.id === fx.id ? [first, second] : [x]
                ),
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
        handleSelectElement({ kind: 'effect', effectId: secondId });
        showNotice(`Split effect "${label}" at ${splitTime.toFixed(2)}s.`, { allowUndo: true });
        return;
      }
    }

    const syncedCaptions = getSyncedCaptionsForPreview(activeProject);
    if (syncedCaptions.length === 0) {
      showNotice(
        'Select a video clip, audio clip, blur, overlay, filter, effect, text layer, or caption segment to split.'
      );
      return;
    }

    let targetSeg =
      selectedElement?.kind === 'captions' && selectedElement.segmentId
        ? syncedCaptions.find(
            (c) =>
              c.id === selectedElement.segmentId && c.syncedEnd - c.syncedStart >= 0.4
          )
        : undefined;
    if (!targetSeg) {
      targetSeg = syncedCaptions.find(
        (c) => currentTime > c.syncedStart + 0.2 && currentTime < c.syncedEnd - 0.2
      );
    }
    if (!targetSeg) {
      targetSeg = syncedCaptions.find(
        (c) =>
          currentTime >= c.syncedStart &&
          currentTime <= c.syncedEnd &&
          c.syncedEnd - c.syncedStart >= 0.4
      );
    }
    if (!targetSeg) {
      showNotice('Move playhead inside a segment (≥0.4s long) to split.');
      return;
    }

    const splitTime =
      currentTime > targetSeg.syncedStart + 0.15 && currentTime < targetSeg.syncedEnd - 0.15
        ? Number(currentTime.toFixed(2))
        : Number(((targetSeg.syncedStart + targetSeg.syncedEnd) / 2).toFixed(2));

    commitProjectPatch(
      activeProject.id,
      (cur) => {
        const res = splitCaptionWithSync(cur, targetSeg!.id, splitTime);
        return {
          captions: res.captions,
          voice: res.voice,
          workflow: createWorkflowUpdate(cur.workflow, {
            visitStage: 'captions',
            modifiedStage: 'captions',
            hasExistingExport: Boolean(cur.lastExportUrl),
          }),
        };
      },
      { immediate: true }
    );
    showNotice(`Split caption segment at ${splitTime.toFixed(2)}s.`);
  }, [
    activeProject,
    commitProjectPatch,
    currentTime,
    handleInteractiveSubtitleStyleUpdate,
    handleProjectUpdated,
    handleSelectElement,
    selectedElement,
    showNotice,
  ]);

  const handleSubAction = useCallback(
    (action: EditSubActionId) => {
      if (!activeProject) return;
      if (action !== 'more' && moreMenuOpen) {
        setMoreMenuOpen(false);
      }
      switch (action) {
        case 'trim':
          handleOpenTool('edit', 'timing');
          break;
        case 'split':
          handleSplitAtPlayhead();
          break;
        case 'delete':
          handleDeleteSelected();
          break;
        case 'duplicate':
          handleDuplicateSelected();
          break;
        case 'speed':
          handleOpenTool('edit', 'timing');
          break;
        case 'volume':
          handleOpenTool('audio', 'mixer');
          break;
        case 'flip': {
          const cv = { ...DEFAULT_VIDEO_CANVAS, ...(activeProject.canvas || {}) };
          if (cv.videoLocked) {
            showNotice('Unlock the video layer to flip it.');
            break;
          }
          const next = !Boolean(cv.flipH);
          handleInteractiveCanvasUpdate({ flipH: next }, { immediate: true });
          showNotice(next ? 'Flipped video horizontally.' : 'Horizontal flip cleared.');
          break;
        }
        case 'draw': {
          if (selectedElement?.kind === 'blur') {
            const b = activeProject.blurs.find((x) => x.id === selectedElement.id);
            const targetMode: 'selective' | 'motion' =
              b?.mode === 'motion' ? 'motion' : 'selective';
            setActiveTool('blur');
            setDrawMode((prev) => (prev === targetMode ? 'none' : targetMode));
          } else {
            setActiveTool('blur');
            setDrawMode((prev) => (prev === 'selective' ? 'none' : 'selective'));
          }
          break;
        }
        case 'style': {
          if (selectedElement?.kind === 'blur') handleOpenTool('blur');
          else if (selectedElement?.kind === 'logo') handleOpenTool('overlay');
          else if (selectedElement?.kind === 'captions') handleOpenTool('captions', 'style');
          else if (selectedElement?.kind === 'caption-element') handleOpenTool('text');
          else if (selectedElement?.kind === 'filter') handleOpenTool('filters');
          else if (selectedElement?.kind === 'effect') handleOpenTool('effects');
          else handleOpenTool('edit', 'transform');
          break;
        }
        case 'opacity': {
          if (selectedElement?.kind === 'logo') handleOpenTool('overlay');
          else handleOpenTool('layers');
          break;
        }
        case 'motion': {
          updateToolMemory({ overlayAdvancedOpen: true });
          handleOpenTool('overlay');
          break;
        }
        case 'lock': {
          if (selectedElement?.kind === 'blur') {
            const b = activeProject.blurs.find((x) => x.id === selectedElement.id);
            if (b) {
              handleInteractiveBlurUpdate(b.id, { locked: !b.locked });
              showNotice(!b.locked ? `Locked "${b.name}".` : `Unlocked "${b.name}".`);
            }
          } else if (selectedElement?.kind === 'logo') {
            const l = activeProject.logos.find((x) => x.id === selectedElement.id);
            if (l) {
              handleInteractiveLogoUpdate(l.id, { locked: !l.locked });
              showNotice(!l.locked ? `Locked "${l.filename}".` : `Unlocked "${l.filename}".`);
            }
          } else if (selectedElement?.kind === 'captions') {
            const nextLocked = !Boolean(activeProject.subtitleStyle.locked);
            handleInteractiveSubtitleStyleUpdate({ locked: nextLocked }, { immediate: true });
            showNotice(nextLocked ? 'Locked captions position.' : 'Unlocked captions position.');
          } else if (selectedElement?.kind === 'caption-element') {
            const el = (activeProject.subtitleStyle.extraElements || []).find(
              (x) => x.id === selectedElement.id
            );
            if (el) {
              const nextLocked = !Boolean(el.locked);
              const nextEls = (activeProject.subtitleStyle.extraElements || []).map((x) =>
                x.id === el.id ? { ...x, locked: nextLocked } : x
              );
              handleInteractiveSubtitleStyleUpdate({ extraElements: nextEls }, { immediate: true });
              showNotice(nextLocked ? `Locked "${el.label}".` : `Unlocked "${el.label}".`);
            }
          } else if (selectedElement?.kind === 'filter' && selectedElement.filterId) {
            const fl = (activeProject.videoEffects?.filterStack || []).find(
              (x) => x.id === selectedElement.filterId
            );
            if (fl) {
              const nextLocked = !Boolean(fl.locked);
              commitProjectPatch(
                activeProject.id,
                (cur) => {
                  const curFx = cur.videoEffects || DEFAULT_VIDEO_EFFECTS;
                  return {
                    videoEffects: {
                      ...curFx,
                      filterStack: (curFx.filterStack || []).map((x) =>
                        x.id === fl.id ? { ...x, locked: nextLocked } : x
                      ),
                    },
                  };
                },
                { immediate: true }
              );
              showNotice(nextLocked ? 'Locked filter layer.' : 'Unlocked filter layer.');
            }
          } else if (selectedElement?.kind === 'effect' && selectedElement.effectId) {
            const fx = (activeProject.videoEffects?.effects || []).find(
              (x) => x.id === selectedElement.effectId
            );
            if (fx) {
              const nextLocked = !Boolean(fx.locked);
              commitProjectPatch(
                activeProject.id,
                (cur) => {
                  const curFx = cur.videoEffects || DEFAULT_VIDEO_EFFECTS;
                  return {
                    videoEffects: {
                      ...curFx,
                      effects: (curFx.effects || []).map((x) =>
                        x.id === fx.id ? { ...x, locked: nextLocked } : x
                      ),
                    },
                  };
                },
                { immediate: true }
              );
              showNotice(nextLocked ? 'Locked effect.' : 'Unlocked effect.');
            }
          } else {
            const cv = { ...DEFAULT_VIDEO_CANVAS, ...(activeProject.canvas || {}) };
            const nextLocked = !Boolean(cv.videoLocked);
            handleInteractiveCanvasUpdate({ videoLocked: nextLocked }, { immediate: true });
            showNotice(nextLocked ? 'Locked video layer.' : 'Unlocked video layer.');
          }
          break;
        }
        case 'visibility': {
          if (selectedElement?.kind === 'captions') {
            const nextVis = !(
              activeProject.subtitleStyle.enabled &&
              activeProject.subtitleStyle.visible !== false
            );
            handleInteractiveSubtitleStyleUpdate(
              { enabled: nextVis ? true : activeProject.subtitleStyle.enabled, visible: nextVis },
              { immediate: true }
            );
            showNotice(nextVis ? 'Captions visible.' : 'Captions hidden.');
          } else if (selectedElement?.kind === 'blur') {
            const b = activeProject.blurs.find((x) => x.id === selectedElement.id);
            if (b) handleInteractiveBlurUpdate(b.id, { enabled: !b.enabled });
          } else if (selectedElement?.kind === 'logo') {
            const l = activeProject.logos.find((x) => x.id === selectedElement.id);
            if (l) handleInteractiveLogoUpdate(l.id, { enabled: !l.enabled });
          } else if (selectedElement?.kind === 'filter' && selectedElement.filterId) {
            commitProjectPatch(
              activeProject.id,
              (cur) => {
                const curFx = cur.videoEffects || DEFAULT_VIDEO_EFFECTS;
                return {
                  videoEffects: {
                    ...curFx,
                    filterStack: (curFx.filterStack || []).map((x) =>
                      x.id === selectedElement.filterId ? { ...x, enabled: !x.enabled } : x
                    ),
                  },
                };
              },
              { immediate: true }
            );
          } else if (selectedElement?.kind === 'effect' && selectedElement.effectId) {
            commitProjectPatch(
              activeProject.id,
              (cur) => {
                const curFx = cur.videoEffects || DEFAULT_VIDEO_EFFECTS;
                return {
                  videoEffects: {
                    ...curFx,
                    effects: (curFx.effects || []).map((x) =>
                      x.id === selectedElement.effectId ? { ...x, enabled: !x.enabled } : x
                    ),
                  },
                };
              },
              { immediate: true }
            );
          }
          break;
        }
        case 'voice':
          handleOpenTool('audio', 'voice');
          break;
        case 'script':
          handleOpenTool('audio', 'script');
          break;
        case 'sync':
          updateToolMemory({ audioAdvancedOpen: true });
          handleOpenTool('audio', 'mixer');
          break;
        case 'music':
        case 'sfx':
          handleOpenTool('audio', 'mixer');
          break;
        case 'unlink-audio': {
          if (!activeProject.metadata?.hasAudio) {
            showNotice('Source video has no audio track to unlink.');
            break;
          }
          const targetClipId =
            selectedElement?.kind === 'video' ? selectedElement.clipId : undefined;
          let createdCount = 0;
          commitProjectPatch(
            activeProject.id,
            (cur) => {
              const res = unlinkVideoClipAudio(cur, targetClipId, uuidv4);
              createdCount = res.unlinkedCount;
              return {
                videoClips: res.videoClips,
                originalAudioClips: res.originalAudioClips,
                voice: {
                  ...cur.voice,
                  originalAudioMuted: false,
                  originalAudioEnabled: true,
                  preserveOriginalAudio: true,
                },
                workflow: createWorkflowUpdate(cur.workflow, {
                  visitStage: 'voice',
                  modifiedStage: 'editor',
                  hasExistingExport: Boolean(cur.lastExportUrl),
                }),
              };
            },
            { immediate: true }
          );
          if (createdCount > 0) {
            showNotice('Separated original audio onto its own 1.0x track.');
          } else {
            showNotice('Original audio is already on an independent 1.0x track.');
          }
          break;
        }
        case 'mute': {
          const track = selectedElement?.kind === 'audio' ? selectedElement.track : undefined;
          const origClipId =
            selectedElement?.kind === 'audio' && track === 'orig'
              ? selectedElement.clipId
              : undefined;
          commitProjectPatch(
            activeProject.id,
            (cur) => {
              if (track === 'orig' && origClipId) {
                return {
                  originalAudioClips: getEffectiveOriginalAudioClips(cur).map((oa) =>
                    oa.id === origClipId ? { ...oa, muted: !oa.muted } : oa
                  ),
                };
              }
              if (track === 'bgm') {
                const muted = Boolean(cur.voice.bgMusicMuted || cur.voice.bgMusicEnabled === false);
                return {
                  voice: {
                    ...cur.voice,
                    bgMusicMuted: !muted,
                    bgMusicEnabled: muted ? true : cur.voice.bgMusicEnabled,
                    bgMusicVolume:
                      muted && (cur.voice.bgMusicVolume ?? 0) <= 0.01 ? 0.25 : cur.voice.bgMusicVolume,
                  },
                };
              }
              if (track === 'sfx') {
                const muted = Boolean(cur.voice.sfxMuted || cur.voice.sfxEnabled === false);
                return {
                  voice: {
                    ...cur.voice,
                    sfxMuted: !muted,
                    sfxEnabled: muted ? true : cur.voice.sfxEnabled,
                    sfxVolume:
                      muted && (cur.voice.sfxVolume ?? 0) <= 0.01 ? 1.0 : cur.voice.sfxVolume,
                  },
                };
              }
              if (
                track === 'dub' ||
                (!track && (cur.voice.fullDubUrl || cur.voice.generatedClips.length > 0))
              ) {
                const muted = Boolean(cur.voice.voiceMuted || !cur.voice.enabled);
                return {
                  voice: {
                    ...cur.voice,
                    voiceMuted: !muted,
                    enabled: muted ? true : cur.voice.enabled,
                  },
                };
              }
              const origMuted = Boolean(
                cur.voice.originalAudioMuted ?? !cur.voice.preserveOriginalAudio
              );
              return {
                voice: {
                  ...cur.voice,
                  originalAudioMuted: !origMuted,
                  originalAudioEnabled: origMuted,
                  preserveOriginalAudio: origMuted,
                },
              };
            },
            { immediate: true }
          );
          break;
        }
        case 'rotate': {
          if (selectedElement?.kind === 'blur') {
            const b = activeProject.blurs.find((x) => x.id === selectedElement.id);
            if (b && !b.locked) {
              const nextRot = ((b.rotation || 0) + 90) % 360;
              handleInteractiveBlurUpdate(b.id, { rotation: nextRot });
              showNotice(`Rotated blur to ${nextRot}°.`);
              break;
            }
          }
          if (selectedElement?.kind === 'logo') {
            const l = activeProject.logos.find((x) => x.id === selectedElement.id);
            if (l && !l.locked) {
              const nextRot = ((l.rotation || 0) + 90) % 360;
              handleInteractiveLogoUpdate(l.id, { rotation: nextRot });
              showNotice(`Rotated overlay to ${nextRot}°.`);
              break;
            }
          }
          if (selectedElement?.kind === 'caption-element') {
            const el = (activeProject.subtitleStyle.extraElements || []).find(
              (x) => x.id === selectedElement.id
            );
            if (el && !el.locked) {
              const nextRot = ((el.style.rotation || 0) + 90) % 360;
              const nextEls = (activeProject.subtitleStyle.extraElements || []).map((x) =>
                x.id === el.id ? { ...x, style: { ...x.style, rotation: nextRot } } : x
              );
              handleInteractiveSubtitleStyleUpdate({ extraElements: nextEls }, { immediate: true });
              showNotice(`Rotated text to ${nextRot}°.`);
              break;
            }
          }
          const cv = { ...DEFAULT_VIDEO_CANVAS, ...(activeProject.canvas || {}) };
          if (cv.videoLocked) {
            showNotice('Unlock the video layer to rotate it.');
            break;
          }
          const nextRot = ((cv.videoRotation || 0) + 90) % 360;
          handleInteractiveCanvasUpdate({ videoRotation: nextRot }, { immediate: true });
          showNotice(`Rotated video to ${nextRot}°.`);
          break;
        }
        case 'crop':
          setCropEditMode((prev) => !prev);
          handleOpenTool('edit', 'transform');
          break;
        case 'more':
          setMoreMenuOpen((prev) => !prev);
          break;
      }
    },
    [
      activeProject,
      commitProjectPatch,
      handleDeleteSelected,
      handleDuplicateSelected,
      handleInteractiveBlurUpdate,
      handleInteractiveCanvasUpdate,
      handleInteractiveLogoUpdate,
      handleInteractiveSubtitleStyleUpdate,
      handleOpenTool,
      handleSplitAtPlayhead,
      moreMenuOpen,
      selectedElement,
      setActiveTool,
      setCropEditMode,
      setDrawMode,
      setMoreMenuOpen,
      showNotice,
      updateToolMemory,
    ]
  );

  const contextualSubToolbarItems = useMemo<SubToolbarActionItem[]>(() => {
    if (!activeProject || !selectedElement || selectedElement.kind === 'video' || selectedElement.kind === 'bg-image') {
      const clips = activeProject ? getEffectiveVideoClips(activeProject) : [];
      const activeClip =
        (selectedElement?.kind === 'video' && selectedElement.clipId
          ? clips.find((c) => c.id === selectedElement.clipId)
          : null) ||
        findActiveVideoClipAtTime(clips, currentTime)?.clip ||
        clips[0];
      const base = DEFAULT_SUB_TOOLBAR_ITEMS.map((item) =>
        item.id === 'flip'
          ? { ...item, active: Boolean(activeProject?.canvas?.flipH) }
          : item.id === 'speed'
          ? {
              ...item,
              active: Boolean(activeClip && Math.abs(activeClip.speed - 1.0) > 0.01),
            }
          : item
      );
      const result: SubToolbarActionItem[] = [];
      for (const item of base) {
        if (item.id === 'more') {
          if (activeProject?.metadata?.hasAudio && !activeClip?.audioUnlinked) {
            result.push({ id: 'unlink-audio', label: 'Unlink Audio', Icon: Unlink });
          }
          if (clips.length >= 1) {
            result.push({ id: 'delete', label: 'Delete', Icon: Trash2 });
          }
        }
        result.push(item);
      }
      return result;
    }

    if (selectedElement.kind === 'blur') {
      const b = activeProject.blurs.find((x) => x.id === selectedElement.id);
      const isLocked = Boolean(b?.locked);
      return [
        { id: 'style', label: 'Edit Blur', Icon: Droplet },
        { id: 'draw', label: 'Draw Box', Icon: SquareDashed, active: drawMode !== 'none' },
        { id: 'trim', label: 'Timing', Icon: Scissors },
        { id: 'rotate', label: 'Rotate', Icon: RotateCw },
        { id: 'duplicate', label: 'Duplicate', Icon: Copy },
        { id: 'lock', label: isLocked ? 'Unlock' : 'Lock', Icon: isLocked ? Unlock : Lock, active: isLocked },
        { id: 'delete', label: 'Delete', Icon: Trash2 },
        { id: 'more', label: 'More', Icon: MoreHorizontal },
      ];
    }

    if (selectedElement.kind === 'logo') {
      const l = activeProject.logos.find((x) => x.id === selectedElement.id);
      const isLocked = Boolean(l?.locked);
      return [
        { id: 'style', label: 'Edit Overlay', Icon: Layers },
        { id: 'split', label: 'Split', Icon: Columns2 },
        { id: 'motion', label: 'Motion', Icon: Move, active: Boolean(l?.motion?.enabled) },
        { id: 'rotate', label: 'Rotate', Icon: RotateCw },
        { id: 'duplicate', label: 'Duplicate', Icon: Copy },
        { id: 'lock', label: isLocked ? 'Unlock' : 'Lock', Icon: isLocked ? Unlock : Lock, active: isLocked },
        { id: 'delete', label: 'Delete', Icon: Trash2 },
        { id: 'more', label: 'More', Icon: MoreHorizontal },
      ];
    }

    if (selectedElement.kind === 'captions') {
      const isLocked = Boolean(activeProject.subtitleStyle.locked);
      const isVisible = Boolean(
        activeProject.subtitleStyle.enabled && activeProject.subtitleStyle.visible !== false
      );
      return [
        { id: 'style', label: 'Edit Caps', Icon: Wand2 },
        { id: 'split', label: 'Split', Icon: Columns2 },
        {
          id: 'visibility',
          label: isVisible ? 'Hide' : 'Show',
          Icon: isVisible ? Eye : EyeOff,
          active: !isVisible,
        },
        { id: 'rotate', label: 'Rotate', Icon: RotateCw },
        { id: 'duplicate', label: 'Duplicate', Icon: Copy },
        { id: 'lock', label: isLocked ? 'Unlock' : 'Lock', Icon: isLocked ? Unlock : Lock, active: isLocked },
        { id: 'delete', label: 'Delete', Icon: Trash2 },
        { id: 'more', label: 'More', Icon: MoreHorizontal },
      ];
    }

    if (selectedElement.kind === 'caption-element') {
      const el = (activeProject.subtitleStyle.extraElements || []).find(
        (x) => x.id === selectedElement.id
      );
      const isLocked = Boolean(el?.locked);
      return [
        { id: 'style', label: 'Edit Text', Icon: Type },
        { id: 'split', label: 'Split', Icon: Columns2 },
        { id: 'trim', label: 'Timing', Icon: Scissors },
        { id: 'rotate', label: 'Rotate', Icon: RotateCw },
        { id: 'duplicate', label: 'Duplicate', Icon: Copy },
        { id: 'lock', label: isLocked ? 'Unlock' : 'Lock', Icon: isLocked ? Unlock : Lock, active: isLocked },
        { id: 'delete', label: 'Delete', Icon: Trash2 },
        { id: 'more', label: 'More', Icon: MoreHorizontal },
      ];
    }

    if (selectedElement.kind === 'audio') {
      const track = selectedElement.track;
      const origClip =
        track === 'orig' && selectedElement.clipId
          ? getEffectiveOriginalAudioClips(activeProject).find(
              (c) => c.id === selectedElement.clipId
            )
          : undefined;
      const isMuted = origClip
        ? Boolean(origClip.muted)
        : track === 'bgm'
        ? Boolean(activeProject.voice.bgMusicMuted || activeProject.voice.bgMusicEnabled === false)
        : track === 'sfx'
        ? Boolean(activeProject.voice.sfxMuted || activeProject.voice.sfxEnabled === false)
        : track === 'dub' ||
          (!track &&
            (activeProject.voice.fullDubUrl || activeProject.voice.generatedClips.length > 0))
        ? Boolean(activeProject.voice.voiceMuted || !activeProject.voice.enabled)
        : Boolean(
            activeProject.voice.originalAudioMuted ?? !activeProject.voice.preserveOriginalAudio
          );
      const origUnlinked = getEffectiveOriginalAudioClips(activeProject).length > 0;
      const canSplitTrack =
        (track === 'orig' && Boolean(activeProject.metadata?.hasAudio)) ||
        (track === 'dub' && activeProject.voice.generatedClips.length > 0) ||
        (track === 'bgm' && Boolean(activeProject.voice.bgMusicUrl)) ||
        (track === 'sfx' && Boolean(activeProject.voice.sfxUrl));
      const canDeleteTrack =
        (track === 'orig' && (origUnlinked || Boolean(activeProject.metadata?.hasAudio))) ||
        (track === 'dub' &&
          (activeProject.voice.generatedClips.length > 0 || Boolean(activeProject.voice.fullDubUrl))) ||
        (track === 'bgm' && Boolean(activeProject.voice.bgMusicUrl)) ||
        (track === 'sfx' && Boolean(activeProject.voice.sfxUrl));

      return [
        { id: 'volume', label: 'Mixer', Icon: Volume2 },
        {
          id: 'mute',
          label: isMuted ? 'Unmute' : 'Mute',
          Icon: isMuted ? VolumeX : Volume2,
          active: isMuted,
        },
        ...(track === 'orig' && activeProject.metadata?.hasAudio && !origUnlinked
          ? [{ id: 'unlink-audio' as EditSubActionId, label: 'Unlink 1.0x', Icon: Unlink }]
          : []),
        ...(canSplitTrack ? [{ id: 'split' as EditSubActionId, label: 'Split', Icon: Columns2 }] : []),
        ...(canDeleteTrack ? [{ id: 'delete' as EditSubActionId, label: 'Delete', Icon: Trash2 }] : []),
        { id: 'voice', label: 'AI Voice', Icon: Mic },
        { id: 'script', label: 'Script', Icon: FileText },
        { id: 'sync', label: 'Sync', Icon: RefreshCw },
        { id: 'more', label: 'More', Icon: MoreHorizontal },
      ];
    }

    if (selectedElement.kind === 'filter') {
      const fl = selectedElement.filterId
        ? (activeProject.videoEffects?.filterStack || []).find(
            (x) => x.id === selectedElement.filterId
          )
        : undefined;
      const isLocked = Boolean(fl?.locked);
      const isVis = fl ? fl.enabled : true;
      return [
        { id: 'style', label: 'Edit Filter', Icon: Wand2 },
        ...(fl
          ? [
              { id: 'split' as EditSubActionId, label: 'Split', Icon: Columns2 },
              {
                id: 'visibility' as EditSubActionId,
                label: isVis ? 'Hide' : 'Show',
                Icon: isVis ? Eye : EyeOff,
                active: !isVis,
              },
              { id: 'duplicate' as EditSubActionId, label: 'Duplicate', Icon: Copy },
              {
                id: 'lock' as EditSubActionId,
                label: isLocked ? 'Unlock' : 'Lock',
                Icon: isLocked ? Unlock : Lock,
                active: isLocked,
              },
              { id: 'delete' as EditSubActionId, label: 'Delete', Icon: Trash2 },
            ]
          : activeProject.videoEffects?.filterPreset !== 'none'
          ? [{ id: 'delete' as EditSubActionId, label: 'Reset', Icon: Trash2 }]
          : []),
        { id: 'more', label: 'More', Icon: MoreHorizontal },
      ];
    }

    if (selectedElement.kind === 'effect') {
      const fx = selectedElement.effectId
        ? (activeProject.videoEffects?.effects || []).find(
            (x) => x.id === selectedElement.effectId
          )
        : undefined;
      const isLocked = Boolean(fx?.locked);
      const isVis = fx ? fx.enabled : true;
      return [
        { id: 'style', label: 'Edit FX', Icon: Sparkles },
        ...(fx
          ? [
              { id: 'split' as EditSubActionId, label: 'Split', Icon: Columns2 },
              {
                id: 'visibility' as EditSubActionId,
                label: isVis ? 'Hide' : 'Show',
                Icon: isVis ? Eye : EyeOff,
                active: !isVis,
              },
              { id: 'duplicate' as EditSubActionId, label: 'Duplicate', Icon: Copy },
              {
                id: 'lock' as EditSubActionId,
                label: isLocked ? 'Unlock' : 'Lock',
                Icon: isLocked ? Unlock : Lock,
                active: isLocked,
              },
              { id: 'delete' as EditSubActionId, label: 'Delete', Icon: Trash2 },
            ]
          : []),
        { id: 'more', label: 'More', Icon: MoreHorizontal },
      ];
    }

    return DEFAULT_SUB_TOOLBAR_ITEMS;
  }, [activeProject, currentTime, drawMode, selectedElement]);

  return {
    handleDuplicateSelected,
    handleDeleteSelected,
    handleSplitAtPlayhead,
    handleSubAction,
    contextualSubToolbarItems,
  };
}
