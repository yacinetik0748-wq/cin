import React from 'react';
import { Sliders } from 'lucide-react';
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
import { LayerPanel } from '../LayerPanel';

interface LayersToolSheetProps {
  project: Project;
  onPatchProject: ProjectPatchFn;
  selectedElement: StudioElementSelection;
  onSelectElement: (el: StudioElementSelection) => void;
  onOpenTool: (tool: StudioToolId) => void;
}

export function LayersToolSheet({
  project,
  onPatchProject,
  selectedElement,
  onSelectElement,
  onOpenTool,
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

  return (
    <div className="space-y-3">
      {selectedElement && (
        <div className="px-3 py-2 rounded-xl bg-violet-600/15 border border-violet-500/40 flex items-center justify-between gap-2 text-xs">
          <span className="text-violet-100 font-medium capitalize truncate">
            Selected: {selectedLabel}
          </span>
          <button
            type="button"
            onClick={handleOpenSelectedTool}
            className="min-h-[34px] px-2.5 py-1 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white flex items-center gap-1 cursor-pointer shrink-0"
          >
            <Sliders className="w-3 h-3" />
            Edit Properties
          </button>
        </div>
      )}

      <LayerPanel
        project={project}
        selectedElement={selectedElement}
        onSelectElement={onSelectElement}
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
