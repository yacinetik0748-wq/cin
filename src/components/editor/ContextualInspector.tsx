import React, { useMemo, useState } from 'react';
import {
  Archive,
  Captions,
  Check,
  Columns2,
  Copy,
  Crop,
  Droplet,
  Eye,
  EyeOff,
  Film,
  FlipHorizontal2,
  FlipVertical2,
  Layers,
  Layers3,
  Lock,
  MoreHorizontal,
  Move,
  Palette,
  Scissors,
  Settings,
  ShieldCheck,
  Sliders,
  Sparkles,
  SquareDashed,
  Trash2,
  Type,
  Unlink,
  Unlock,
  Volume2,
  VolumeX,
  Wand2,
  X,
} from 'lucide-react';
import {
  DEFAULT_VIDEO_CANVAS,
  DEFAULT_VIDEO_EFFECTS,
  Project,
  ProjectPatchFn,
  SavedFontAsset,
  StudioElementSelection,
  StudioToolId,
  SubtitleStyle,
  VideoCanvasConfig,
} from '../../types/studio';
import {
  findActiveVideoClipAtTime,
  getEffectiveBgmClips,
  getEffectiveOriginalAudioClips,
  getEffectiveSfxClips,
  getEffectiveVideoClips,
} from '../../lib/videoTimeline';
import { getSyncedCaptionsForPreview } from '../../lib/workflowStages';
import { getEffectCatalogEntry, getFilterPresetMeta } from '../../lib/videoFiltersCatalog';
import { EditToolSheet } from '../sheets/EditToolSheet';
import { AudioToolSheet } from '../sheets/AudioToolSheet';
import { TextToolSheet } from '../sheets/TextToolSheet';
import { CaptionsToolSheet } from '../sheets/CaptionsToolSheet';
import { OverlayToolSheet } from '../sheets/OverlayToolSheet';
import { BlurToolSheet } from '../sheets/BlurToolSheet';
import { EffectsToolSheet } from '../sheets/EffectsToolSheet';
import { LayersToolSheet } from '../sheets/LayersToolSheet';
import { StudioToolMemory } from '../sheets/toolMemory';
import { formatTimecode } from '../../lib/formatters';
import {
  getSelectedLayerTiming,
  isClipOrLayerLocked,
  LOCKED_LAYER_MESSAGE,
} from '../../lib/layerLock';

export interface ContextualActionButton {
  id: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  active?: boolean;
  danger?: boolean;
  onClick: () => void;
}

export const INSPECTOR_TOOL_LABELS: Record<StudioToolId, { title: string; category: string }> = {
  edit: { title: 'Clip, Transform & Media', category: 'Media & Transform' },
  audio: { title: 'Audio Mixer & AI Voice', category: 'Audio' },
  captions: { title: 'Captions & Subtitles', category: 'Text' },
  text: { title: 'Text Overlays', category: 'Text' },
  overlay: { title: 'Logos, Watermarks & Motion', category: 'Visual' },
  blur: { title: 'Blur & Motion Tracking', category: 'Visual' },
  filters: { title: 'Color Filters', category: 'Visual' },
  effects: { title: 'Visual Effects', category: 'Visual' },
  adjust: { title: 'Color Adjustments', category: 'Visual' },
  layers: { title: 'Project Layers Stack', category: 'Layers' },
};

export const INSPECTOR_TOOL_TABS: Array<{
  id: StudioToolId;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'edit', label: 'Edit', Icon: Scissors },
  { id: 'audio', label: 'Audio', Icon: Volume2 },
  { id: 'captions', label: 'Captions', Icon: Captions },
  { id: 'text', label: 'Text', Icon: Type },
  { id: 'overlay', label: 'Overlay', Icon: Layers },
  { id: 'blur', label: 'Blur', Icon: Droplet },
  { id: 'filters', label: 'Filters', Icon: Wand2 },
  { id: 'effects', label: 'Effects', Icon: Sparkles },
  { id: 'adjust', label: 'Adjust', Icon: Sliders },
  { id: 'layers', label: 'Layers', Icon: Layers3 },
];

interface ContextualInspectorProps {
  project: Project;
  projectsCount: number;
  allProjects: Project[];
  activeTool: StudioToolId;
  onSelectTool: (tool: StudioToolId, subTab?: string) => void;
  selectedElement: StudioElementSelection;
  onSelectElement: (el: StudioElementSelection) => void;
  selectedBlurId: string | null;
  onSelectBlur: (id: string | null) => void;
  selectedLogoId: string | null;
  onSelectLogo: (id: string | null) => void;
  currentTime: number;
  onSeek: (t: number) => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  previewEffects: boolean;
  onTogglePreviewEffects: (val: boolean) => void;
  drawMode: 'none' | 'selective' | 'motion';
  onSetDrawMode: (mode: 'none' | 'selective' | 'motion') => void;
  cropEditMode: boolean;
  onToggleCropEditMode: (val: boolean) => void;
  customFonts: SavedFontAsset[];
  onReloadCustomFonts: () => void;
  memory: StudioToolMemory;
  onUpdateMemory: (patch: Partial<StudioToolMemory>) => void;
  onProjectUpdated: (p: Project) => void;
  onPatchProject: ProjectPatchFn;
  onFlushSaves?: (projectId?: string) => Promise<boolean>;
  onUpdateCanvas: (
    patch: Partial<VideoCanvasConfig>,
    opts?: { immediate?: boolean; undoGroupKey?: string }
  ) => void;
  onUpdateSubtitleStyle: (
    patch: Partial<SubtitleStyle>,
    opts?: { undoGroupKey?: string; immediate?: boolean }
  ) => void;
  onSwitchProject: (p: Project) => void;
  onOpenBackup: () => void;
  onOpenSettings: () => void;
  onShowNotice: (msg: string) => void;
  onSplitAtPlayhead: () => void;
  onDuplicateSelected: () => void;
  onDeleteSelected: () => void;
  onSubAction: (
    action:
      | 'trim'
      | 'split'
      | 'delete'
      | 'duplicate'
      | 'speed'
      | 'volume'
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
      | 'unlink-audio'
      | 'mute'
      | 'rotate'
      | 'crop'
      | 'more'
  ) => void;
  variant?: 'docked' | 'sheet';
}

export function ContextualInspector({
  project,
  allProjects,
  activeTool,
  onSelectTool,
  selectedElement,
  onSelectElement,
  selectedBlurId,
  onSelectBlur,
  selectedLogoId,
  onSelectLogo,
  currentTime,
  onSeek,
  videoRef,
  previewEffects,
  onTogglePreviewEffects,
  drawMode,
  onSetDrawMode,
  cropEditMode,
  onToggleCropEditMode,
  customFonts,
  onReloadCustomFonts,
  memory,
  onUpdateMemory,
  onProjectUpdated,
  onPatchProject,
  onFlushSaves,
  onUpdateCanvas,
  onUpdateSubtitleStyle,
  onSwitchProject,
  onOpenBackup,
  onOpenSettings,
  onShowNotice,
  onSplitAtPlayhead,
  onDuplicateSelected,
  onDeleteSelected,
  onSubAction,
  variant = 'docked',
}: ContextualInspectorProps) {
  const [moreOpen, setMoreOpen] = useState(false);

  const selectedTiming = useMemo(
    () => getSelectedLayerTiming(project, selectedElement ?? { kind: 'video' }, currentTime),
    [project, selectedElement, currentTime]
  );

  const selectionSummary = useMemo(() => {
    if (!selectedElement || selectedElement.kind === 'video') {
      const clips = getEffectiveVideoClips(project);
      const activeClip =
        (selectedElement?.kind === 'video' && selectedElement.clipId
          ? clips.find((c) => c.id === selectedElement.clipId)
          : null) ||
        findActiveVideoClipAtTime(clips, currentTime)?.clip ||
        clips[0];
      return {
        badge: 'Video',
        colorClass: 'text-violet-300 bg-violet-500/15 border-violet-500/35',
        name: activeClip ? `${activeClip.label || 'Main Video'} (${activeClip.speed}x)` : 'Main Video',
      };
    }
    if (selectedElement.kind === 'bg-image') {
      return {
        badge: 'Canvas',
        colorClass: 'text-cyan-300 bg-cyan-500/15 border-cyan-500/35',
        name: 'Background Fill',
      };
    }
    if (selectedElement.kind === 'captions') {
      const seg = selectedElement.segmentId
        ? getSyncedCaptionsForPreview(project).find((c) => c.id === selectedElement.segmentId)
        : null;
      const snippet = seg
        ? (seg.translatedText || seg.text || '').trim().slice(0, 26)
        : `${project.captions.length} segments`;
      return {
        badge: 'Captions',
        colorClass: 'text-amber-300 bg-amber-500/15 border-amber-500/35',
        name: snippet || 'Subtitle Track',
      };
    }
    if (selectedElement.kind === 'caption-element') {
      const el = (project.subtitleStyle.extraElements || []).find(
        (x) => x.id === selectedElement.id
      );
      return {
        badge: 'Text',
        colorClass: 'text-fuchsia-300 bg-fuchsia-500/15 border-fuchsia-500/35',
        name: el?.text || el?.label || 'Text Layer',
      };
    }
    if (selectedElement.kind === 'logo') {
      const logo = project.logos.find((l) => l.id === selectedElement.id);
      return {
        badge: 'Overlay',
        colorClass: 'text-violet-300 bg-violet-500/15 border-violet-500/35',
        name: logo?.filename || 'Overlay',
      };
    }
    if (selectedElement.kind === 'blur') {
      const blur = project.blurs.find((b) => b.id === selectedElement.id);
      return {
        badge: 'Blur',
        colorClass: 'text-sky-300 bg-sky-500/15 border-sky-500/35',
        name: blur?.name || 'Blur Region',
      };
    }
    if (selectedElement.kind === 'audio') {
      const track = selectedElement.track;
      let clipName: string | undefined;
      if (selectedElement.clipId) {
        if (track === 'orig') {
          clipName = getEffectiveOriginalAudioClips(project).find(
            (c) => c.id === selectedElement.clipId
          )?.label;
        } else if (track === 'dub') {
          const dClip = project.voice.generatedClips.find(
            (c) => c.segmentId === selectedElement.clipId
          );
          if (dClip) clipName = dClip.text?.slice(0, 24) || 'Narration Clip';
        } else if (track === 'bgm') {
          clipName = getEffectiveBgmClips(project).find(
            (c) => c.id === selectedElement.clipId
          )?.label;
        } else if (track === 'sfx') {
          clipName = getEffectiveSfxClips(project).find(
            (c) => c.id === selectedElement.clipId
          )?.label;
        }
      }
      const trackLabel =
        clipName ||
        (selectedElement.track === 'dub'
          ? 'Narration'
          : selectedElement.track === 'orig'
          ? 'Original Audio'
          : selectedElement.track === 'bgm'
          ? 'Music'
          : selectedElement.track === 'sfx'
          ? 'SFX'
          : 'Audio');
      return {
        badge: 'Audio',
        colorClass: 'text-teal-300 bg-teal-500/15 border-teal-500/35',
        name: trackLabel,
      };
    }
    if (selectedElement.kind === 'filter') {
      const fxConfig = project.videoEffects || DEFAULT_VIDEO_EFFECTS;
      const layer = selectedElement.filterId
        ? (fxConfig.filterStack || []).find((f) => f.id === selectedElement.filterId)
        : null;
      const label = layer
        ? layer.name || getFilterPresetMeta(layer.preset).label
        : getFilterPresetMeta(fxConfig.filterPreset).label;
      return {
        badge: 'Filter',
        colorClass: 'text-pink-300 bg-pink-500/15 border-pink-500/35',
        name: label,
      };
    }
    if (selectedElement.kind === 'effect') {
      const fxConfig = project.videoEffects || DEFAULT_VIDEO_EFFECTS;
      const fx = selectedElement.effectId
        ? (fxConfig.effects || []).find((e) => e.id === selectedElement.effectId)
        : null;
      return {
        badge: 'FX',
        colorClass: 'text-fuchsia-300 bg-fuchsia-500/15 border-fuchsia-500/35',
        name: fx
          ? fx.name || getEffectCatalogEntry(fx.type).label
          : `Filter: ${getFilterPresetMeta(fxConfig.filterPreset).label}`,
      };
    }
    return {
      badge: 'Canvas',
      colorClass: 'text-zinc-300 bg-zinc-800 border-white/10',
      name: project.name,
    };
  }, [currentTime, project, selectedElement]);

  // Strict contextual quick actions for the selected element (zero unrelated buttons)
  const contextualActions = useMemo<ContextualActionButton[]>(() => {
    if (!selectedElement || selectedElement.kind === 'video' || selectedElement.kind === 'bg-image') {
      const clips = getEffectiveVideoClips(project);
      const activeClip =
        (selectedElement?.kind === 'video' && selectedElement.clipId
          ? clips.find((c) => c.id === selectedElement.clipId)
          : null) ||
        findActiveVideoClipAtTime(clips, currentTime)?.clip ||
        clips[0];
      const isLocked = isClipOrLayerLocked(
        project,
        selectedElement || { kind: 'video', clipId: activeClip?.id },
        currentTime
      );
      const list: ContextualActionButton[] = [
        {
          id: 'split',
          label: 'Split',
          Icon: Columns2,
          onClick: onSplitAtPlayhead,
        },
        {
          id: 'crop',
          label: cropEditMode ? 'Done Crop' : 'Crop',
          Icon: Crop,
          active: cropEditMode,
          onClick: () => onSubAction('crop'),
        },
        {
          id: 'flip',
          label: 'Flip H',
          Icon: FlipHorizontal2,
          active: Boolean(project.canvas?.flipH),
          onClick: () => onSubAction('flip'),
        },
        {
          id: 'lock',
          label: isLocked ? 'Unlock' : 'Lock',
          Icon: isLocked ? Unlock : Lock,
          active: isLocked,
          onClick: () => onSubAction('lock'),
        },
      ];
      if (project.metadata?.hasAudio && !activeClip?.audioUnlinked) {
        list.push({
          id: 'unlink',
          label: 'Unlink Audio',
          Icon: Unlink,
          onClick: () => onSubAction('unlink-audio'),
        });
      }
      if (clips.length >= 1) {
        list.push({
          id: 'delete',
          label: 'Delete',
          Icon: Trash2,
          danger: true,
          onClick: onDeleteSelected,
        });
      }
      return list;
    }

    if (selectedElement.kind === 'blur') {
      const b = project.blurs.find((x) => x.id === selectedElement.id);
      const isLocked = Boolean(b?.locked);
      return [
        {
          id: 'draw',
          label: drawMode !== 'none' ? 'Drawing...' : 'Draw Box',
          Icon: SquareDashed,
          active: drawMode !== 'none',
          onClick: () => onSubAction('draw'),
        },
        {
          id: 'split',
          label: 'Split',
          Icon: Columns2,
          onClick: onSplitAtPlayhead,
        },
        {
          id: 'dup',
          label: 'Duplicate',
          Icon: Copy,
          onClick: onDuplicateSelected,
        },
        {
          id: 'lock',
          label: isLocked ? 'Unlock' : 'Lock',
          Icon: isLocked ? Unlock : Lock,
          active: isLocked,
          onClick: () => onSubAction('lock'),
        },
        {
          id: 'del',
          label: 'Delete',
          Icon: Trash2,
          danger: true,
          onClick: onDeleteSelected,
        },
      ];
    }

    if (selectedElement.kind === 'logo') {
      const l = project.logos.find((x) => x.id === selectedElement.id);
      const isLocked = Boolean(l?.locked);
      return [
        {
          id: 'split',
          label: 'Split',
          Icon: Columns2,
          onClick: onSplitAtPlayhead,
        },
        {
          id: 'motion',
          label: 'Motion',
          Icon: Move,
          active: Boolean(l?.motion?.enabled),
          onClick: () => onSubAction('motion'),
        },
        {
          id: 'dup',
          label: 'Duplicate',
          Icon: Copy,
          onClick: onDuplicateSelected,
        },
        {
          id: 'lock',
          label: isLocked ? 'Unlock' : 'Lock',
          Icon: isLocked ? Unlock : Lock,
          active: isLocked,
          onClick: () => onSubAction('lock'),
        },
        {
          id: 'del',
          label: 'Delete',
          Icon: Trash2,
          danger: true,
          onClick: onDeleteSelected,
        },
      ];
    }

    if (selectedElement.kind === 'captions') {
      const isLocked = isClipOrLayerLocked(project, selectedElement, currentTime);
      const isVisible = Boolean(
        project.subtitleStyle.enabled && project.subtitleStyle.visible !== false
      );
      return [
        {
          id: 'split',
          label: 'Split',
          Icon: Columns2,
          onClick: onSplitAtPlayhead,
        },
        {
          id: 'dup',
          label: 'Duplicate',
          Icon: Copy,
          onClick: onDuplicateSelected,
        },
        {
          id: 'vis',
          label: isVisible ? 'Hide' : 'Show',
          Icon: isVisible ? Eye : EyeOff,
          active: !isVisible,
          onClick: () => onSubAction('visibility'),
        },
        {
          id: 'lock',
          label: isLocked ? 'Unlock' : 'Lock',
          Icon: isLocked ? Unlock : Lock,
          active: isLocked,
          onClick: () => onSubAction('lock'),
        },
        {
          id: 'del',
          label: 'Delete',
          Icon: Trash2,
          danger: true,
          onClick: onDeleteSelected,
        },
      ];
    }

    if (selectedElement.kind === 'caption-element') {
      const el = (project.subtitleStyle.extraElements || []).find(
        (x) => x.id === selectedElement.id
      );
      const isLocked = Boolean(el?.locked);
      return [
        {
          id: 'split',
          label: 'Split',
          Icon: Columns2,
          onClick: onSplitAtPlayhead,
        },
        {
          id: 'dup',
          label: 'Duplicate',
          Icon: Copy,
          onClick: onDuplicateSelected,
        },
        {
          id: 'lock',
          label: isLocked ? 'Unlock' : 'Lock',
          Icon: isLocked ? Unlock : Lock,
          active: isLocked,
          onClick: () => onSubAction('lock'),
        },
        {
          id: 'del',
          label: 'Delete',
          Icon: Trash2,
          danger: true,
          onClick: onDeleteSelected,
        },
      ];
    }

    if (selectedElement.kind === 'audio') {
      const track = selectedElement.track;
      const origClip =
        track === 'orig' && selectedElement.clipId
          ? getEffectiveOriginalAudioClips(project).find((c) => c.id === selectedElement.clipId)
          : undefined;
      const bgmClip =
        track === 'bgm' && selectedElement.clipId
          ? getEffectiveBgmClips(project).find((c) => c.id === selectedElement.clipId)
          : undefined;
      const sfxClip =
        track === 'sfx' && selectedElement.clipId
          ? getEffectiveSfxClips(project).find((c) => c.id === selectedElement.clipId)
          : undefined;

      const isMuted = origClip
        ? Boolean(origClip.muted)
        : bgmClip
        ? Boolean(bgmClip.muted)
        : sfxClip
        ? Boolean(sfxClip.muted)
        : track === 'bgm'
        ? Boolean(project.voice.bgMusicMuted || project.voice.bgMusicEnabled === false)
        : track === 'sfx'
        ? Boolean(project.voice.sfxMuted || project.voice.sfxEnabled === false)
        : track === 'dub' ||
          (!track && (project.voice.fullDubUrl || project.voice.generatedClips.length > 0))
        ? Boolean(project.voice.voiceMuted || !project.voice.enabled)
        : Boolean(project.voice.originalAudioMuted ?? !project.voice.preserveOriginalAudio);

      const origUnlinked = getEffectiveOriginalAudioClips(project).length > 0;
      const hasTrackMedia =
        track === 'bgm'
          ? Boolean(project.voice.bgMusicUrl || (project.voice.bgMusicClips && project.voice.bgMusicClips.length > 0))
          : track === 'sfx'
          ? Boolean(project.voice.sfxUrl || (project.voice.sfxClips && project.voice.sfxClips.length > 0))
          : track === 'dub'
          ? Boolean(project.voice.fullDubUrl || project.voice.generatedClips.length > 0)
          : origUnlinked || Boolean(project.metadata?.hasAudio);

      const isLocked = isClipOrLayerLocked(project, selectedElement, currentTime);
      const list: ContextualActionButton[] = [
        {
          id: 'mute',
          label: isMuted ? 'Unmute' : 'Mute',
          Icon: isMuted ? VolumeX : Volume2,
          active: isMuted,
          onClick: () => onSubAction('mute'),
        },
        {
          id: 'lock',
          label: isLocked ? 'Unlock' : 'Lock',
          Icon: isLocked ? Unlock : Lock,
          active: isLocked,
          onClick: () => onSubAction('lock'),
        },
      ];
      if (track === 'orig' && project.metadata?.hasAudio && !origUnlinked) {
        list.push({
          id: 'unlink',
          label: 'Unlink 1.0x',
          Icon: Unlink,
          onClick: () => onSubAction('unlink-audio'),
        });
      }
      if (hasTrackMedia) {
        list.push({
          id: 'split',
          label: 'Split',
          Icon: Columns2,
          onClick: onSplitAtPlayhead,
        });
        list.push({
          id: 'del',
          label: 'Delete',
          Icon: Trash2,
          danger: true,
          onClick: onDeleteSelected,
        });
      }
      return list;
    }

    if (selectedElement.kind === 'filter') {
      const fxConfig = project.videoEffects || DEFAULT_VIDEO_EFFECTS;
      const layer = selectedElement.filterId
        ? (fxConfig.filterStack || []).find((f) => f.id === selectedElement.filterId)
        : null;
      const isLocked = isClipOrLayerLocked(project, selectedElement, currentTime);
      const list: ContextualActionButton[] = [
        {
          id: 'fx-preview',
          label: previewEffects ? 'FX On' : 'Raw View',
          Icon: previewEffects ? Eye : EyeOff,
          active: previewEffects,
          onClick: () => onTogglePreviewEffects(!previewEffects),
        },
      ];
      if (layer) {
        list.push(
          {
            id: 'split',
            label: 'Split',
            Icon: Columns2,
            onClick: onSplitAtPlayhead,
          },
          {
            id: 'dup',
            label: 'Duplicate',
            Icon: Copy,
            onClick: onDuplicateSelected,
          }
        );
      }
      if (layer || fxConfig.filterPreset !== 'none') {
        list.push(
          {
            id: 'lock',
            label: isLocked ? 'Unlock' : 'Lock',
            Icon: isLocked ? Unlock : Lock,
            active: isLocked,
            onClick: () => onSubAction('lock'),
          },
          {
            id: 'del-filter',
            label: layer ? 'Delete' : 'Reset',
            Icon: Trash2,
            danger: true,
            onClick: onDeleteSelected,
          }
        );
      }
      return list;
    }

    if (selectedElement.kind === 'effect') {
      const fxConfig = project.videoEffects || DEFAULT_VIDEO_EFFECTS;
      const fx = selectedElement.effectId
        ? (fxConfig.effects || []).find((e) => e.id === selectedElement.effectId)
        : null;
      const isLocked = Boolean(fx?.locked);
      const list: ContextualActionButton[] = [
        {
          id: 'fx-preview',
          label: previewEffects ? 'FX On' : 'Raw View',
          Icon: previewEffects ? Eye : EyeOff,
          active: previewEffects,
          onClick: () => onTogglePreviewEffects(!previewEffects),
        },
      ];
      if (fx) {
        list.push(
          {
            id: 'split',
            label: 'Split',
            Icon: Columns2,
            onClick: onSplitAtPlayhead,
          },
          {
            id: 'dup',
            label: 'Duplicate',
            Icon: Copy,
            onClick: onDuplicateSelected,
          },
          {
            id: 'lock',
            label: isLocked ? 'Unlock' : 'Lock',
            Icon: isLocked ? Unlock : Lock,
            active: isLocked,
            onClick: () => onSubAction('lock'),
          },
          {
            id: 'del-fx',
            label: 'Remove FX',
            Icon: Trash2,
            danger: true,
            onClick: onDeleteSelected,
          }
        );
      }
      return list;
    }

    return [];
  }, [
    cropEditMode,
    currentTime,
    drawMode,
    onDeleteSelected,
    onDuplicateSelected,
    onSplitAtPlayhead,
    onSubAction,
    onTogglePreviewEffects,
    previewEffects,
    project,
    selectedElement,
  ]);

  const activeSegmentId =
    selectedElement?.kind === 'captions' ? selectedElement.segmentId || null : null;

  const toolSheetBody = (
    <>
      {activeTool === 'edit' && (
        <EditToolSheet
          project={project}
          onProjectUpdated={onProjectUpdated}
          onPatchProject={onPatchProject}
          currentTime={currentTime}
          selectedElement={selectedElement}
          onSelectElement={onSelectElement}
          cropEditMode={cropEditMode}
          onToggleCropEditMode={onToggleCropEditMode}
          onDuplicateSelected={onDuplicateSelected}
          onDeleteSelected={onDeleteSelected}
          onSplitAtPlayhead={onSplitAtPlayhead}
          onShowNotice={onShowNotice}
          memory={memory}
          onUpdateMemory={onUpdateMemory}
        />
      )}

      {activeTool === 'audio' && (
        <AudioToolSheet
          project={project}
          onProjectUpdated={onProjectUpdated}
          onPatchProject={onPatchProject}
          onFlushSaves={onFlushSaves}
          currentTime={currentTime}
          onSeek={onSeek}
          onShowNotice={onShowNotice}
          memory={memory}
          onUpdateMemory={onUpdateMemory}
        />
      )}

      {activeTool === 'text' && (
        <TextToolSheet
          project={project}
          onUpdateSubtitleStyle={onUpdateSubtitleStyle}
          selectedElement={selectedElement}
          onSelectElement={onSelectElement}
          onOpenCaptionsTool={() => onSelectTool('captions', 'style')}
          onShowNotice={onShowNotice}
          memory={memory}
          onUpdateMemory={onUpdateMemory}
        />
      )}

      {activeTool === 'captions' && (
        <CaptionsToolSheet
          project={project}
          onProjectUpdated={onProjectUpdated}
          onPatchProject={onPatchProject}
          onFlushSaves={onFlushSaves}
          currentTime={currentTime}
          onSeek={onSeek}
          customFonts={customFonts}
          onCustomFontsChanged={onReloadCustomFonts}
          selectedSegmentId={activeSegmentId}
          onSelectSegment={(segId) =>
            onSelectElement({ kind: 'captions', segmentId: segId || undefined })
          }
          onShowNotice={onShowNotice}
          memory={memory}
          onUpdateMemory={onUpdateMemory}
        />
      )}

      {activeTool === 'overlay' && (
        <OverlayToolSheet
          project={project}
          onProjectUpdated={onProjectUpdated}
          onPatchProject={onPatchProject}
          selectedLogoId={selectedLogoId}
          onSelectLogo={onSelectLogo}
          onShowNotice={onShowNotice}
          memory={memory}
          onUpdateMemory={onUpdateMemory}
        />
      )}

      {activeTool === 'blur' && (
        <BlurToolSheet
          project={project}
          onProjectUpdated={onProjectUpdated}
          onPatchProject={onPatchProject}
          videoRef={videoRef}
          currentTime={currentTime}
          drawMode={drawMode}
          onSetDrawMode={onSetDrawMode}
          selectedBlurId={selectedBlurId}
          onSelectBlur={onSelectBlur}
          onShowNotice={onShowNotice}
          memory={memory}
          onUpdateMemory={onUpdateMemory}
        />
      )}

      {(activeTool === 'filters' || activeTool === 'effects' || activeTool === 'adjust') && (
        <EffectsToolSheet
          mode={activeTool}
          onSwitchMode={(nextMode) => onSelectTool(nextMode)}
          project={project}
          onProjectUpdated={onProjectUpdated}
          onPatchProject={onPatchProject}
          previewEffects={previewEffects}
          onTogglePreviewEffects={onTogglePreviewEffects}
          selectedElement={selectedElement}
          onSelectElement={onSelectElement}
          currentTime={currentTime}
          onShowNotice={onShowNotice}
          memory={memory}
          onUpdateMemory={onUpdateMemory}
        />
      )}

      {activeTool === 'layers' && (
        <LayersToolSheet
          project={project}
          currentTime={currentTime}
          onPatchProject={onPatchProject}
          selectedElement={selectedElement}
          onSelectElement={onSelectElement}
          onOpenTool={onSelectTool}
          onShowNotice={onShowNotice}
        />
      )}
    </>
  );

  if (variant === 'sheet') {
    return (
      <div className="space-y-3">
        {selectedTiming && (
          <div className="px-2.5 py-1.5 rounded-lg bg-[#181820] border border-white/[0.08] flex flex-wrap items-center justify-between gap-2 text-[10.5px] font-mono tabular-nums text-zinc-300">
            <span className="text-zinc-200 font-sans font-medium truncate flex items-center gap-1.5">
              {selectedTiming.locked && <Lock className="w-3 h-3 text-amber-300 shrink-0" />}
              {selectionSummary.name}
            </span>
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
              <span>Start {formatTimecode(selectedTiming.start)}</span>
              <span>End {formatTimecode(selectedTiming.end)}</span>
              <span className="text-white font-semibold">
                Dur {formatTimecode(selectedTiming.duration)}
              </span>
              {selectedTiming.fps && selectedTiming.durationFrames !== undefined && (
                <span className="text-zinc-400">
                  ({selectedTiming.durationFrames}f)
                </span>
              )}
            </div>
          </div>
        )}
        {contextualActions.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar">
            {contextualActions.map((act) => (
              <button
                key={act.id}
                type="button"
                onClick={act.onClick}
                className={`min-h-[34px] px-2.5 py-1 rounded-lg border text-[11px] font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer ${
                  act.danger
                    ? 'bg-red-500/10 border-red-500/30 text-red-300 hover:bg-red-500/20'
                    : act.active
                    ? 'bg-violet-600/25 border-violet-500/50 text-violet-100'
                    : 'bg-[#181820] border-white/[0.08] text-zinc-200 hover:bg-[#22222E]'
                }`}
              >
                <act.Icon className="w-3.5 h-3.5 shrink-0" />
                <span>{act.label}</span>
              </button>
            ))}
          </div>
        )}
        {toolSheetBody}
      </div>
    );
  }

  return (
    <aside
      aria-label="Contextual inspector"
      className="h-full w-full bg-[#111116] flex flex-col overflow-hidden relative"
    >
      {/* Top Category Bar + Compact More Menu */}
      <div className="px-2.5 pt-2 pb-1.5 border-b border-white/[0.08] bg-[#131319] shrink-0">
        <div className="flex items-center justify-between gap-1.5 mb-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold uppercase tracking-wide shrink-0 ${selectionSummary.colorClass}`}
            >
              {selectionSummary.badge}
            </span>
            <span className="text-xs font-medium text-zinc-200 truncate">
              {selectionSummary.name}
            </span>
            {selectedElement && (
              <button
                type="button"
                onClick={() => onSelectElement(null)}
                title="Clear selection"
                className="w-5 h-5 rounded hover:bg-white/[0.08] text-zinc-400 hover:text-white flex items-center justify-center shrink-0 cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              title="More workspace tools"
              className={`min-h-[28px] px-2 py-1 rounded-md border text-[11px] font-medium flex items-center gap-1 cursor-pointer ${
                moreOpen
                  ? 'bg-violet-600/20 border-violet-500/50 text-violet-200'
                  : 'bg-[#191922] border-white/[0.08] text-zinc-300 hover:text-white'
              }`}
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
              <span>More</span>
            </button>

            {moreOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMoreOpen(false)} />
                <div
                  role="menu"
                  aria-label="More studio actions"
                  className="absolute right-0 top-9 z-40 w-60 rounded-xl bg-[#16161E] border border-white/[0.12] shadow-2xl p-1.5 space-y-1 text-xs"
                >
                  {allProjects.length > 1 && (
                    <div className="md:hidden px-2 py-1.5 border-b border-white/[0.08] mb-1">
                      <label className="text-[10px] uppercase tracking-wider text-zinc-400 block mb-1">
                        Switch Project
                      </label>
                      <select
                        value={project.id}
                        onChange={(e) => {
                          const found = allProjects.find((p) => p.id === e.target.value);
                          if (found) {
                            onSwitchProject(found);
                            setMoreOpen(false);
                          }
                        }}
                        className="w-full bg-zinc-900 border border-white/[0.08] rounded-md px-2 py-1 text-xs text-zinc-100"
                      >
                        {allProjects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div className="flex items-center gap-1 pb-1 border-b border-white/[0.08]">
                    <button
                      type="button"
                      onClick={() => {
                        const cv = { ...DEFAULT_VIDEO_CANVAS, ...(project.canvas || {}) };
                        if (cv.videoLocked) {
                          onShowNotice(LOCKED_LAYER_MESSAGE);
                          return;
                        }
                        const next = !Boolean(cv.flipH);
                        onUpdateCanvas({ flipH: next }, { immediate: true });
                        onShowNotice(next ? 'Flipped video horizontally.' : 'Horizontal flip cleared.');
                        setMoreOpen(false);
                      }}
                      className={`flex-1 min-h-[32px] px-2 rounded-lg border text-[11px] flex items-center justify-center gap-1 cursor-pointer ${
                        project.canvas?.flipH
                          ? 'bg-violet-600/20 border-violet-500/40 text-violet-200'
                          : 'bg-zinc-900 border-white/[0.08] hover:bg-zinc-800 text-zinc-200'
                      }`}
                    >
                      <FlipHorizontal2 className="w-3.5 h-3.5 text-sky-400" />
                      <span>Flip H</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const cv = { ...DEFAULT_VIDEO_CANVAS, ...(project.canvas || {}) };
                        if (cv.videoLocked) {
                          onShowNotice(LOCKED_LAYER_MESSAGE);
                          return;
                        }
                        const next = !Boolean(cv.flipV);
                        onUpdateCanvas({ flipV: next }, { immediate: true });
                        onShowNotice(next ? 'Flipped video vertically.' : 'Vertical flip cleared.');
                        setMoreOpen(false);
                      }}
                      className={`flex-1 min-h-[32px] px-2 rounded-lg border text-[11px] flex items-center justify-center gap-1 cursor-pointer ${
                        project.canvas?.flipV
                          ? 'bg-violet-600/20 border-violet-500/40 text-violet-200'
                          : 'bg-zinc-900 border-white/[0.08] hover:bg-zinc-800 text-zinc-200'
                      }`}
                    >
                      <FlipVertical2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Flip V</span>
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      onSelectTool('edit', 'background');
                    }}
                    className="w-full min-h-[34px] px-2 py-1 rounded-lg hover:bg-white/[0.06] text-zinc-200 flex items-center gap-2 cursor-pointer"
                  >
                    <Palette className="w-3.5 h-3.5 text-violet-400" />
                    <span>Canvas &amp; Background Fill</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      onSelectTool('edit', 'media');
                    }}
                    className="w-full min-h-[34px] px-2 py-1 rounded-lg hover:bg-white/[0.06] text-zinc-200 flex items-center gap-2 cursor-pointer"
                  >
                    <Film className="w-3.5 h-3.5 text-sky-400" />
                    <span>Replace Source Media</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      const next = !Boolean(project.subtitleStyle.showSafeGuides);
                      onUpdateSubtitleStyle({ showSafeGuides: next }, { immediate: true });
                      onShowNotice(next ? 'Safe guides enabled.' : 'Safe guides hidden.');
                      setMoreOpen(false);
                    }}
                    className="w-full min-h-[34px] px-2 py-1 rounded-lg hover:bg-white/[0.06] text-zinc-200 flex items-center justify-between gap-2 cursor-pointer"
                  >
                    <span className="flex items-center gap-2">
                      <ShieldCheck className="w-3.5 h-3.5 text-amber-400" />
                      <span>Safe Area Guides</span>
                    </span>
                    {project.subtitleStyle.showSafeGuides && (
                      <Check className="w-3.5 h-3.5 text-violet-400" />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      const cv = { ...DEFAULT_VIDEO_CANVAS, ...(project.canvas || {}) };
                      const next = cv.showEditingGuides === false;
                      onUpdateCanvas({ showEditingGuides: next }, { immediate: true });
                      onShowNotice(next ? 'Stage selection handles shown.' : 'Stage handles hidden.');
                      setMoreOpen(false);
                    }}
                    className="w-full min-h-[34px] px-2 py-1 rounded-lg hover:bg-white/[0.06] text-zinc-200 flex items-center justify-between gap-2 cursor-pointer"
                  >
                    <span className="flex items-center gap-2">
                      <Eye className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Stage Selection Handles</span>
                    </span>
                    {(project.canvas?.showEditingGuides ?? true) && (
                      <Check className="w-3.5 h-3.5 text-violet-400" />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      const next = !previewEffects;
                      onTogglePreviewEffects(next);
                      onShowNotice(next ? 'Filter & FX preview enabled.' : 'Showing raw video.');
                      setMoreOpen(false);
                    }}
                    className="w-full min-h-[34px] px-2 py-1 rounded-lg hover:bg-white/[0.06] text-zinc-200 flex items-center justify-between gap-2 cursor-pointer"
                  >
                    <span className="flex items-center gap-2">
                      <Sparkles className="w-3.5 h-3.5 text-fuchsia-400" />
                      <span>Preview FX / Filters</span>
                    </span>
                    {previewEffects && <Check className="w-3.5 h-3.5 text-violet-400" />}
                  </button>

                  {((!selectedElement && getEffectiveVideoClips(project).length >= 1) ||
                    (selectedElement &&
                      (selectedElement.kind === 'video' ||
                        selectedElement.kind === 'blur' ||
                        selectedElement.kind === 'logo' ||
                        selectedElement.kind === 'caption-element' ||
                        (selectedElement.kind === 'captions' && project.captions.length > 0) ||
                        selectedElement.kind === 'audio' ||
                        selectedElement.kind === 'filter' ||
                        (selectedElement.kind === 'effect' && Boolean(selectedElement.effectId))))) && (
                    <button
                      type="button"
                      onClick={() => {
                        setMoreOpen(false);
                        onDeleteSelected();
                      }}
                      className="w-full min-h-[34px] px-2 py-1 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-300 flex items-center gap-2 cursor-pointer border border-red-500/25"
                    >
                      <Trash2 className="w-3.5 h-3.5 text-red-400" />
                      <span>Delete Selected Clip</span>
                    </button>
                  )}

                  <div className="pt-1 border-t border-white/[0.08] flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setMoreOpen(false);
                        onOpenBackup();
                      }}
                      className="flex-1 min-h-[32px] px-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-200 flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <Archive className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Backup</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMoreOpen(false);
                        onOpenSettings();
                      }}
                      className="flex-1 min-h-[32px] px-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-200 flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <Settings className="w-3.5 h-3.5 text-zinc-300" />
                      <span>Settings</span>
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Active Tool Header + Quick Layers Switcher (Desktop relies on Left ToolCategoryRail) */}
        <div className="flex items-center justify-between gap-2 pb-1">
          <div className="min-w-0">
            <div className="text-xs font-display font-semibold text-white truncate">
              {INSPECTOR_TOOL_LABELS[activeTool].title}
            </div>
            <div className="text-[10.5px] text-zinc-500">
              {INSPECTOR_TOOL_LABELS[activeTool].category}
            </div>
          </div>

          <button
            type="button"
            onClick={() => onSelectTool(activeTool === 'layers' ? 'edit' : 'layers')}
            className={`min-h-[28px] px-2 py-1 rounded-md border text-[11px] font-medium flex items-center gap-1 shrink-0 cursor-pointer transition-colors ${
              activeTool === 'layers'
                ? 'bg-violet-600 text-white border-violet-500'
                : 'bg-[#181822] border-white/[0.08] text-zinc-300 hover:text-white'
            }`}
            title="Toggle Layers Stack"
          >
            <Layers3 className="w-3.5 h-3.5" />
            <span>Layers</span>
          </button>
        </div>

        {/* Strict Contextual Quick Actions Row */}
        {selectedTiming && (
          <div className="pt-1 border-t border-white/[0.06] flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] font-mono tabular-nums text-zinc-400">
            {selectedTiming.locked && <Lock className="w-2.5 h-2.5 text-amber-300 shrink-0" />}
            <span>Start {formatTimecode(selectedTiming.start)}</span>
            <span>End {formatTimecode(selectedTiming.end)}</span>
            <span className="text-zinc-200 font-semibold">
              Dur {formatTimecode(selectedTiming.duration)}
            </span>
            {selectedTiming.fps && selectedTiming.durationFrames !== undefined && (
              <span>
                ({selectedTiming.durationFrames}f @ {selectedTiming.fps}fps)
              </span>
            )}
          </div>
        )}
        {contextualActions.length > 0 && (
          <div className="mt-1.5 pt-1.5 border-t border-white/[0.06] flex items-center gap-1 overflow-x-auto no-scrollbar">
            {contextualActions.map((act) => (
              <button
                key={act.id}
                type="button"
                onClick={act.onClick}
                className={`min-h-[28px] px-2 py-1 rounded-md border text-[10.5px] font-medium flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                  act.danger
                    ? 'bg-red-500/10 border-red-500/25 text-red-300 hover:bg-red-500/20'
                    : act.active
                    ? 'bg-violet-600/25 border-violet-500/45 text-violet-100'
                    : 'bg-[#181822] border-white/[0.07] text-zinc-300 hover:text-white hover:bg-[#22222E]'
                }`}
              >
                <act.Icon className="w-3 h-3 shrink-0" />
                <span>{act.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Scrollable Contextual Controls Body */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3.5 py-3 space-y-3">
        {toolSheetBody}
      </div>
    </aside>
  );
}
