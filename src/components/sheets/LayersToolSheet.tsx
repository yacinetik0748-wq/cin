import React from 'react';
import {
  Captions,
  Droplet,
  Eye,
  EyeOff,
  Film,
  Layers,
  Lock,
  Mic,
  Music,
  Sliders,
  Sparkles,
  Unlock,
  Volume2,
  VolumeX,
  Wand2,
  Zap,
} from 'lucide-react';
import {
  BlurEffect,
  DEFAULT_VIDEO_CANVAS,
  DEFAULT_VIDEO_EFFECTS,
  LogoOverlay,
  Project,
  ProjectPatchFn,
  StudioElementSelection,
  StudioToolId,
  SubtitleStyle,
  VideoEffectsConfig,
} from '../../types/studio';
import { createWorkflowUpdate } from '../../lib/workflowStages';
import {
  getEffectiveBgmClips,
  getEffectiveOriginalAudioClips,
  getEffectiveSfxClips,
  getEffectiveVideoClips,
  getProjectEffectiveDuration,
} from '../../lib/videoTimeline';
import { LayerPanel } from '../LayerPanel';
import { formatTimecode } from '../../lib/formatters';
import {
  getSelectedLayerTiming,
  isTrackLocked,
  TimelineTrackId,
  toggleTrackLockPatch,
} from '../../lib/layerLock';

interface LayersToolSheetProps {
  project: Project;
  currentTime?: number;
  onPatchProject: ProjectPatchFn;
  selectedElement: StudioElementSelection;
  onSelectElement: (el: StudioElementSelection) => void;
  onOpenTool: (tool: StudioToolId, subTab?: string) => void;
  onShowNotice?: (msg: string) => void;
}

export function LayersToolSheet({
  project,
  currentTime = 0,
  onPatchProject,
  selectedElement,
  onSelectElement,
  onOpenTool,
  onShowNotice,
}: LayersToolSheetProps) {
  const handleOpenSelectedTool = () => {
    if (!selectedElement) return;
    if (selectedElement.kind === 'blur') onOpenTool('blur');
    else if (selectedElement.kind === 'logo') onOpenTool('overlay');
    else if (selectedElement.kind === 'captions') onOpenTool('captions');
    else if (selectedElement.kind === 'caption-element') onOpenTool('text');
    else if (selectedElement.kind === 'audio') onOpenTool('audio');
    else if (selectedElement.kind === 'filter') onOpenTool('filters');
    else if (selectedElement.kind === 'effect') onOpenTool('effects');
    else onOpenTool('edit');
  };

  const selectedLabel =
    selectedElement?.kind === 'audio'
      ? `Audio (${selectedElement.track || 'mixer'})`
      : selectedElement?.kind === 'caption-element'
      ? 'Text Layer'
      : selectedElement?.kind === 'bg-image'
      ? 'Background'
      : selectedElement?.kind === 'filter'
      ? 'Color Filter'
      : selectedElement?.kind === 'effect'
      ? 'Visual Effect'
      : selectedElement?.kind;

  const duration = getProjectEffectiveDuration(project);
  const canvasConfig = { ...DEFAULT_VIDEO_CANVAS, ...(project.canvas || {}) };
  const fxConfig = project.videoEffects || DEFAULT_VIDEO_EFFECTS;
  const videoClips = getEffectiveVideoClips(project);
  const origClips = getEffectiveOriginalAudioClips(project);
  const bgmClips = getEffectiveBgmClips(project, duration);
  const sfxClips = getEffectiveSfxClips(project, duration);

  const videoVisible = canvasConfig.videoVisible !== false;
  const captionsVisible = project.subtitleStyle.visible !== false && project.subtitleStyle.enabled;
  const hasDubAudio = Boolean(project.voice.fullDubUrl || project.voice.generatedClips.length > 0);
  const dubMuted = Boolean(
    !hasDubAudio ||
      project.voice.voiceMuted ||
      !project.voice.enabled ||
      (project.voice.voiceVolume ?? 1) <= 0.01
  );
  const origAudioEnabled =
    project.voice.originalAudioEnabled !== undefined
      ? Boolean(project.voice.originalAudioEnabled)
      : Boolean(project.voice.preserveOriginalAudio);
  const origAudioMuted =
    project.voice.originalAudioMuted !== undefined
      ? Boolean(project.voice.originalAudioMuted)
      : !Boolean(project.voice.preserveOriginalAudio);
  const origMuted = Boolean(
    !project.sourceVideoUrl ||
      !origAudioEnabled ||
      origAudioMuted ||
      (project.voice.originalAudioVolume ?? 1) <= 0.01
  );
  const bgmMuted = Boolean(
    !project.voice.bgMusicUrl ||
      project.voice.bgMusicEnabled === false ||
      project.voice.bgMusicMuted ||
      (project.voice.bgMusicVolume ?? 0) <= 0.01
  );
  const sfxMuted = Boolean(
    !project.voice.sfxUrl ||
      project.voice.sfxEnabled === false ||
      project.voice.sfxMuted ||
      (project.voice.sfxVolume ?? 0) <= 0.01
  );
  const overlaysCount =
    project.logos.length + (project.subtitleStyle.extraElements || []).length;
  const overlaysVisible =
    project.logos.some((l) => l.enabled) ||
    (project.subtitleStyle.extraElements || []).some((el) => el.visible !== false);
  const blursVisible = project.blurs.some((b) => b.enabled);
  const filterStack = fxConfig.filterStack || [];
  const filtersVisible =
    fxConfig.filterPreset !== 'none' || filterStack.some((f) => f.enabled);
  const effectsList = fxConfig.effects || [];
  const effectsVisible = effectsList.some((e) => e.enabled);

  const selectedTiming = getSelectedLayerTiming(project, selectedElement, currentTime);

  const trackRows: Array<{
    id: TimelineTrackId;
    label: string;
    meta: string;
    Icon: React.ComponentType<{ className?: string }>;
    accent: string;
    isAudio?: boolean;
    active: boolean;
    locked: boolean;
    toggleOn: boolean;
    onSelect: () => void;
    onEdit: () => void;
    onToggle: () => void;
  }> = [
    {
      id: 'video',
      label: 'Video',
      meta: `${videoClips.length} clip${videoClips.length === 1 ? '' : 's'}`,
      Icon: Film,
      accent: 'text-violet-400',
      active: selectedElement?.kind === 'video',
      locked: isTrackLocked(project, 'video'),
      toggleOn: videoVisible,
      onSelect: () => onSelectElement({ kind: 'video', clipId: videoClips[0]?.id }),
      onEdit: () => {
        onSelectElement({ kind: 'video', clipId: videoClips[0]?.id });
        onOpenTool('edit');
      },
      onToggle: () =>
        onPatchProject(
          project.id,
          (cur) => ({
            canvas: {
              ...DEFAULT_VIDEO_CANVAS,
              ...(cur.canvas || {}),
              videoVisible: !videoVisible,
            },
          }),
          { immediate: true }
        ),
    },
    {
      id: 'captions',
      label: 'Captions',
      meta: `${project.captions.length} lines`,
      Icon: Captions,
      accent: 'text-amber-400',
      active: selectedElement?.kind === 'captions',
      locked: isTrackLocked(project, 'captions'),
      toggleOn: captionsVisible,
      onSelect: () =>
        onSelectElement({ kind: 'captions', segmentId: project.captions[0]?.id }),
      onEdit: () => {
        onSelectElement({ kind: 'captions', segmentId: project.captions[0]?.id });
        onOpenTool('captions');
      },
      onToggle: () =>
        onPatchProject(
          project.id,
          (cur) => ({
            subtitleStyle: {
              ...cur.subtitleStyle,
              enabled: !captionsVisible ? true : cur.subtitleStyle.enabled,
              visible: !captionsVisible,
            },
          }),
          { immediate: true }
        ),
    },
    {
      id: 'dub',
      label: 'Narration',
      meta: hasDubAudio
        ? `${project.voice.generatedClips.length || 1} clip${
            project.voice.generatedClips.length === 1 ? '' : 's'
          }`
        : 'Empty',
      Icon: Mic,
      accent: 'text-teal-400',
      isAudio: true,
      active:
        selectedElement?.kind === 'audio' &&
        (!selectedElement.track || selectedElement.track === 'dub'),
      locked: isTrackLocked(project, 'dub'),
      toggleOn: !dubMuted,
      onSelect: () => onSelectElement({ kind: 'audio', track: 'dub' }),
      onEdit: () => {
        onSelectElement({ kind: 'audio', track: 'dub' });
        onOpenTool('audio', hasDubAudio ? 'mixer' : 'voice');
      },
      onToggle: () => {
        if (!hasDubAudio) {
          onOpenTool('audio', 'voice');
          return;
        }
        onPatchProject(
          project.id,
          (cur) => ({
            voice: {
              ...cur.voice,
              voiceMuted: !dubMuted,
              enabled: dubMuted ? true : cur.voice.enabled,
              voiceVolume:
                dubMuted && (cur.voice.voiceVolume ?? 0) <= 0.01 ? 1.0 : cur.voice.voiceVolume,
            },
          }),
          { immediate: true }
        );
      },
    },
    {
      id: 'orig',
      label: 'Original Audio',
      meta: origClips.length > 0 ? `${origClips.length} unlinked` : 'Linked',
      Icon: Volume2,
      accent: 'text-cyan-400',
      isAudio: true,
      active: selectedElement?.kind === 'audio' && selectedElement.track === 'orig',
      locked: isTrackLocked(project, 'orig'),
      toggleOn: !origMuted,
      onSelect: () => onSelectElement({ kind: 'audio', track: 'orig' }),
      onEdit: () => {
        onSelectElement({ kind: 'audio', track: 'orig' });
        onOpenTool('audio', 'mixer');
      },
      onToggle: () =>
        onPatchProject(
          project.id,
          (cur) => ({
            voice: {
              ...cur.voice,
              originalAudioMuted: !origMuted,
              originalAudioEnabled: origMuted,
              preserveOriginalAudio: origMuted,
              originalAudioVolume:
                origMuted && (cur.voice.originalAudioVolume ?? 0) <= 0.01
                  ? 1.0
                  : cur.voice.originalAudioVolume,
            },
          }),
          { immediate: true }
        ),
    },
    {
      id: 'bgm',
      label: 'Music',
      meta: bgmClips.length > 0 ? `${bgmClips.length} clip${bgmClips.length === 1 ? '' : 's'}` : 'Empty',
      Icon: Music,
      accent: 'text-indigo-400',
      isAudio: true,
      active: selectedElement?.kind === 'audio' && selectedElement.track === 'bgm',
      locked: isTrackLocked(project, 'bgm'),
      toggleOn: !bgmMuted,
      onSelect: () => onSelectElement({ kind: 'audio', track: 'bgm' }),
      onEdit: () => {
        onSelectElement({ kind: 'audio', track: 'bgm' });
        onOpenTool('audio', 'mixer');
      },
      onToggle: () => {
        if (!project.voice.bgMusicUrl) {
          onOpenTool('audio', 'mixer');
          return;
        }
        onPatchProject(
          project.id,
          (cur) => ({
            voice: {
              ...cur.voice,
              bgMusicMuted: !bgmMuted,
              bgMusicEnabled: bgmMuted ? true : cur.voice.bgMusicEnabled,
              bgMusicVolume:
                bgmMuted && (cur.voice.bgMusicVolume ?? 0) <= 0.01 ? 0.25 : cur.voice.bgMusicVolume,
            },
          }),
          { immediate: true }
        );
      },
    },
    {
      id: 'sfx',
      label: 'SFX',
      meta: sfxClips.length > 0 ? `${sfxClips.length} clip${sfxClips.length === 1 ? '' : 's'}` : 'Empty',
      Icon: Zap,
      accent: 'text-emerald-400',
      isAudio: true,
      active: selectedElement?.kind === 'audio' && selectedElement.track === 'sfx',
      locked: isTrackLocked(project, 'sfx'),
      toggleOn: !sfxMuted,
      onSelect: () => onSelectElement({ kind: 'audio', track: 'sfx' }),
      onEdit: () => {
        onSelectElement({ kind: 'audio', track: 'sfx' });
        onOpenTool('audio', 'mixer');
      },
      onToggle: () => {
        if (!project.voice.sfxUrl) {
          onOpenTool('audio', 'mixer');
          return;
        }
        onPatchProject(
          project.id,
          (cur) => ({
            voice: {
              ...cur.voice,
              sfxMuted: !sfxMuted,
              sfxEnabled: sfxMuted ? true : cur.voice.sfxEnabled,
              sfxVolume:
                sfxMuted && (cur.voice.sfxVolume ?? 0) <= 0.01 ? 1.0 : cur.voice.sfxVolume,
            },
          }),
          { immediate: true }
        );
      },
    },
    {
      id: 'overlays',
      label: 'Overlays & Text',
      meta: overlaysCount > 0 ? `${overlaysCount} item${overlaysCount === 1 ? '' : 's'}` : 'Empty',
      Icon: Layers,
      accent: 'text-purple-400',
      active: selectedElement?.kind === 'logo' || selectedElement?.kind === 'caption-element',
      locked: isTrackLocked(project, 'overlays'),
      toggleOn: overlaysVisible,
      onSelect: () => {
        if (project.logos[0]) onSelectElement({ kind: 'logo', id: project.logos[0].id });
        else if ((project.subtitleStyle.extraElements || [])[0]) {
          onSelectElement({
            kind: 'caption-element',
            id: project.subtitleStyle.extraElements![0].id,
          });
        }
      },
      onEdit: () => {
        if (project.logos[0]) onOpenTool('overlay');
        else if ((project.subtitleStyle.extraElements || [])[0]) onOpenTool('text');
        else onOpenTool('overlay');
      },
      onToggle: () => {
        if (overlaysCount === 0) {
          onOpenTool('overlay');
          return;
        }
        const nextVis = !overlaysVisible;
        onPatchProject(
          project.id,
          (cur) => ({
            logos: cur.logos.map((l) => ({ ...l, enabled: nextVis })),
            subtitleStyle: {
              ...cur.subtitleStyle,
              extraElements: (cur.subtitleStyle.extraElements || []).map((el) => ({
                ...el,
                visible: nextVis,
              })),
            },
          }),
          { immediate: true }
        );
      },
    },
    {
      id: 'blur',
      label: 'Blur',
      meta: project.blurs.length > 0 ? `${project.blurs.length} zone${project.blurs.length === 1 ? '' : 's'}` : 'Empty',
      Icon: Droplet,
      accent: 'text-sky-400',
      active: selectedElement?.kind === 'blur',
      locked: isTrackLocked(project, 'blur'),
      toggleOn: blursVisible,
      onSelect: () => {
        if (project.blurs[0]) onSelectElement({ kind: 'blur', id: project.blurs[0].id });
      },
      onEdit: () => onOpenTool('blur'),
      onToggle: () => {
        if (project.blurs.length === 0) {
          onOpenTool('blur');
          return;
        }
        const nextVis = !blursVisible;
        onPatchProject(
          project.id,
          (cur) => ({ blurs: cur.blurs.map((b) => ({ ...b, enabled: nextVis })) }),
          { immediate: true }
        );
      },
    },
    {
      id: 'filters',
      label: 'Filters',
      meta:
        filterStack.length > 0
          ? `${filterStack.length} layer${filterStack.length === 1 ? '' : 's'}`
          : fxConfig.filterPreset !== 'none'
          ? fxConfig.filterPreset
          : 'None',
      Icon: Wand2,
      accent: 'text-pink-400',
      active: selectedElement?.kind === 'filter',
      locked: isTrackLocked(project, 'filters'),
      toggleOn: filtersVisible,
      onSelect: () => onSelectElement({ kind: 'filter', filterId: filterStack[0]?.id }),
      onEdit: () => onOpenTool('filters'),
      onToggle: () => {
        if (filterStack.length === 0) {
          onOpenTool('filters');
          return;
        }
        const nextVis = !filterStack.some((f) => f.enabled);
        onPatchProject(
          project.id,
          (cur) => {
            const curFx = cur.videoEffects || DEFAULT_VIDEO_EFFECTS;
            return {
              videoEffects: {
                ...curFx,
                filterStack: (curFx.filterStack || []).map((f) => ({ ...f, enabled: nextVis })),
              },
            };
          },
          { immediate: true }
        );
      },
    },
    {
      id: 'effects',
      label: 'Effects',
      meta: effectsList.length > 0 ? `${effectsList.length} FX` : 'Empty',
      Icon: Sparkles,
      accent: 'text-fuchsia-400',
      active: selectedElement?.kind === 'effect',
      locked: isTrackLocked(project, 'effects'),
      toggleOn: effectsVisible,
      onSelect: () => onSelectElement({ kind: 'effect', effectId: effectsList[0]?.id }),
      onEdit: () => onOpenTool('effects'),
      onToggle: () => {
        if (effectsList.length === 0) {
          onOpenTool('effects');
          return;
        }
        const nextVis = !effectsVisible;
        onPatchProject(
          project.id,
          (cur) => {
            const curFx = cur.videoEffects || DEFAULT_VIDEO_EFFECTS;
            return {
              videoEffects: {
                ...curFx,
                effects: (curFx.effects || []).map((fx) => ({ ...fx, enabled: nextVis })),
              },
            };
          },
          { immediate: true }
        );
      },
    },
  ];

  return (
    <div className="space-y-3">
      {selectedElement && (
        <div className="px-3 py-2 rounded-xl bg-violet-600/15 border border-violet-500/40 flex flex-col gap-1.5 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="text-violet-100 font-medium capitalize truncate flex items-center gap-1.5">
              {selectedTiming?.locked && <Lock className="w-3 h-3 text-amber-300 shrink-0" />}
              Selected: {selectedLabel}
            </span>
            <button
              type="button"
              onClick={handleOpenSelectedTool}
              className="min-h-[36px] px-2.5 py-1 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white flex items-center gap-1 cursor-pointer shrink-0 whitespace-nowrap"
            >
              <Sliders className="w-3 h-3" />
              Edit Properties
            </button>
          </div>
          {selectedTiming && (
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10.5px] font-mono tabular-nums text-zinc-300">
              <span>Start {formatTimecode(selectedTiming.start)}</span>
              <span>End {formatTimecode(selectedTiming.end)}</span>
              <span className="text-white font-semibold">
                Dur {formatTimecode(selectedTiming.duration)}
              </span>
              {selectedTiming.fps && selectedTiming.durationFrames !== undefined && (
                <span className="text-zinc-400">
                  ({selectedTiming.durationFrames}f @ {selectedTiming.fps}fps)
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Timeline Tracks Quick Manager */}
      <div className="p-3 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-white">Timeline Tracks</span>
          <span className="text-[11px] font-mono text-zinc-500 tabular-nums">
            {trackRows.length} Tracks
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {trackRows.map((tr) => {
            const Icon = tr.Icon;
            return (
              <div
                key={tr.id}
                className={`px-2 py-1.5 rounded-lg border flex items-center justify-between gap-1 text-xs transition-colors ${
                  tr.active
                    ? tr.locked
                      ? 'bg-amber-950/30 border-amber-400/55 text-white'
                      : 'bg-violet-600/18 border-violet-500/60 text-white'
                    : tr.locked
                    ? 'bg-amber-950/20 border-amber-500/35 text-zinc-200 hover:border-amber-400/55'
                    : 'bg-zinc-900/70 border-white/[0.06] text-zinc-200 hover:border-white/[0.14]'
                }`}
              >
                <button
                  type="button"
                  onClick={tr.onSelect}
                  className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer py-0.5"
                >
                  <Icon className={`w-3.5 h-3.5 shrink-0 ${tr.accent}`} />
                  <div className="min-w-0">
                    <div className="font-medium text-xs truncate">{tr.label}</div>
                    <div className="text-[10px] font-mono text-zinc-500 truncate">{tr.meta}</div>
                  </div>
                </button>

                <div className="flex items-center gap-0.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      const res = toggleTrackLockPatch(project, tr.id);
                      onPatchProject(
                        project.id,
                        () => ({
                          ...res.patch,
                          workflow: createWorkflowUpdate(project.workflow, {
                            modifiedStage: 'editor',
                            hasExistingExport: Boolean(project.lastExportUrl),
                          }),
                        }),
                        { immediate: true }
                      );
                      onShowNotice?.(
                        res.locked ? `Locked ${res.label}.` : `Unlocked ${res.label}.`
                      );
                    }}
                    title={tr.locked ? `Unlock ${tr.label}` : `Lock ${tr.label}`}
                    aria-label={tr.locked ? `Unlock ${tr.label}` : `Lock ${tr.label}`}
                    aria-pressed={tr.locked}
                    className={`min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg hover:bg-white/[0.06] cursor-pointer ${
                      tr.locked ? 'text-amber-300 bg-amber-500/15' : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {tr.locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={tr.onToggle}
                    title={
                      tr.isAudio
                        ? tr.toggleOn
                          ? `Mute ${tr.label}`
                          : `Unmute ${tr.label}`
                        : tr.toggleOn
                        ? `Hide ${tr.label}`
                        : `Show ${tr.label}`
                    }
                    className={`min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg hover:bg-white/[0.06] cursor-pointer ${
                      tr.toggleOn ? 'text-zinc-200' : 'text-zinc-600'
                    }`}
                  >
                    {tr.isAudio ? (
                      tr.toggleOn ? (
                        <Volume2 className="w-3.5 h-3.5" />
                      ) : (
                        <VolumeX className="w-3.5 h-3.5 text-red-400" />
                      )
                    ) : tr.toggleOn ? (
                      <Eye className="w-3.5 h-3.5" />
                    ) : (
                      <EyeOff className="w-3.5 h-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={tr.onEdit}
                    className="min-h-[36px] px-2 rounded-lg bg-white/[0.05] hover:bg-violet-600/30 text-[11px] font-medium text-zinc-200 hover:text-white cursor-pointer whitespace-nowrap"
                  >
                    Edit
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <LayerPanel
        project={project}
        selectedElement={selectedElement}
        onSelectElement={onSelectElement}
        onShowNotice={onShowNotice}
        onUpdateCanvas={(patch) => {
          onPatchProject(
            project.id,
            (cur) => ({
              canvas: { ...DEFAULT_VIDEO_CANVAS, ...(cur.canvas || {}), ...patch },
              workflow: createWorkflowUpdate(cur.workflow, {
                completeStage: 'editor',
                modifiedStage: 'editor',
                hasExistingExport: Boolean(cur.lastExportUrl),
              }),
            }),
            { immediate: true }
          );
        }}
        onUpdateBlurs={(nextBlurs: BlurEffect[]) => {
          onPatchProject(
            project.id,
            (cur) => ({
              blurs: nextBlurs,
              workflow: createWorkflowUpdate(cur.workflow, {
                completeStage: 'editor',
                modifiedStage: 'editor',
                hasExistingExport: Boolean(cur.lastExportUrl),
              }),
            }),
            { immediate: true }
          );
        }}
        onUpdateLogos={(nextLogos: LogoOverlay[]) => {
          onPatchProject(
            project.id,
            (cur) => ({
              logos: nextLogos,
              workflow: createWorkflowUpdate(cur.workflow, {
                completeStage: 'editor',
                modifiedStage: 'editor',
                hasExistingExport: Boolean(cur.lastExportUrl),
              }),
            }),
            { immediate: true }
          );
        }}
        onUpdateSubtitleStyle={(patch: Partial<SubtitleStyle>) => {
          onPatchProject(
            project.id,
            (cur) => ({
              subtitleStyle: { ...cur.subtitleStyle, ...patch },
              workflow: createWorkflowUpdate(cur.workflow, {
                visitStage: 'captions',
                modifiedStage: 'captions',
                hasExistingExport: Boolean(cur.lastExportUrl),
              }),
            }),
            { immediate: true }
          );
        }}
        onUpdateVideoEffects={(patch: Partial<VideoEffectsConfig>) => {
          onPatchProject(
            project.id,
            (cur) => ({
              videoEffects: {
                ...(cur.videoEffects || DEFAULT_VIDEO_EFFECTS),
                ...patch,
              },
              workflow: createWorkflowUpdate(cur.workflow, {
                completeStage: 'editor',
                modifiedStage: 'editor',
                hasExistingExport: Boolean(cur.lastExportUrl),
              }),
            }),
            { immediate: true }
          );
        }}
      />
    </div>
  );
}
