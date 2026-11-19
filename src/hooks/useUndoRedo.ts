import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BlurEffect,
  CaptionSegment,
  LogoOverlay,
  OriginalAudioClip,
  Project,
  SubtitleStyle,
  VideoCanvasConfig,
  VideoClip,
  VideoEffectsConfig,
  VoiceConfig,
} from '../types/studio';
import { createWorkflowUpdate } from '../lib/workflowStages';

export interface EditableSnapshot {
  canvas?: VideoCanvasConfig;
  videoEffects: VideoEffectsConfig;
  blurs: BlurEffect[];
  logos: LogoOverlay[];
  subtitleStyle: SubtitleStyle;
  captions: CaptionSegment[];
  voice: VoiceConfig;
  videoClips?: VideoClip[];
  originalAudioClips?: OriginalAudioClip[];
}

export function cloneEditableSnapshot(project: Project): EditableSnapshot {
  return JSON.parse(
    JSON.stringify({
      canvas: project.canvas,
      videoEffects: project.videoEffects,
      blurs: project.blurs,
      logos: project.logos,
      subtitleStyle: project.subtitleStyle,
      captions: project.captions,
      voice: project.voice,
      videoClips: project.videoClips,
      originalAudioClips: project.originalAudioClips,
    })
  ) as EditableSnapshot;
}

export function snapshotsEqual(a: EditableSnapshot, b: EditableSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface UseUndoRedoOptions {
  activeProject: Project | null;
  activeProjectId: string | null;
  onApplySnapshotToBackend: (project: Project, patch: Partial<Project>) => Promise<void>;
}

export function useUndoRedo({
  activeProject,
  activeProjectId,
  onApplySnapshotToBackend,
}: UseUndoRedoOptions) {
  const [undoStack, setUndoStack] = useState<EditableSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<EditableSnapshot[]>([]);
  const isUndoRedoApplyingRef = useRef(false);
  const activeUndoGroupRef = useRef<{ key: string; timerId: number } | null>(null);

  const clearActiveUndoGroup = useCallback(() => {
    if (activeUndoGroupRef.current) {
      window.clearTimeout(activeUndoGroupRef.current.timerId);
      activeUndoGroupRef.current = null;
    }
  }, []);

  useEffect(() => {
    setUndoStack([]);
    setRedoStack([]);
    clearActiveUndoGroup();
  }, [activeProjectId, clearActiveUndoGroup]);

  const pushUndoSnapshot = useCallback((projectToSave: Project) => {
    const snap = cloneEditableSnapshot(projectToSave);
    setUndoStack((prev) => {
      const top = prev[prev.length - 1];
      if (top && snapshotsEqual(top, snap)) return prev;
      return [...prev.slice(-29), snap];
    });
    setRedoStack([]);
  }, []);

  const maybeRecordUndo = useCallback(
    (prevProject: Project, nextProject: Project, undoGroupKey?: string) => {
      if (isUndoRedoApplyingRef.current) return;
      const prevSnap = cloneEditableSnapshot(prevProject);
      const nextSnap = cloneEditableSnapshot(nextProject);
      if (snapshotsEqual(prevSnap, nextSnap)) return;

      if (undoGroupKey) {
        const activeGroup = activeUndoGroupRef.current;
        if (activeGroup && activeGroup.key === undoGroupKey) {
          window.clearTimeout(activeGroup.timerId);
          activeGroup.timerId = window.setTimeout(() => {
            activeUndoGroupRef.current = null;
          }, 700);
        } else {
          if (activeGroup) window.clearTimeout(activeGroup.timerId);
          pushUndoSnapshot(prevProject);
          const timerId = window.setTimeout(() => {
            activeUndoGroupRef.current = null;
          }, 700);
          activeUndoGroupRef.current = { key: undoGroupKey, timerId };
        }
      } else {
        clearActiveUndoGroup();
        pushUndoSnapshot(prevProject);
      }
    },
    [clearActiveUndoGroup, pushUndoSnapshot]
  );

  const applySnapshot = useCallback(
    async (snap: EditableSnapshot) => {
      if (!activeProject) return;
      isUndoRedoApplyingRef.current = true;
      clearActiveUndoGroup();
      const nextWorkflow = createWorkflowUpdate(activeProject.workflow, {
        modifiedStage: 'editor',
        hasExistingExport: Boolean(activeProject.lastExportUrl),
      });
      const patch: Partial<Project> = {
        canvas: snap.canvas,
        videoEffects: snap.videoEffects,
        blurs: snap.blurs,
        logos: snap.logos,
        subtitleStyle: snap.subtitleStyle,
        captions: snap.captions,
        voice: snap.voice,
        videoClips: snap.videoClips,
        originalAudioClips: snap.originalAudioClips,
        workflow: nextWorkflow,
      };
      try {
        await onApplySnapshotToBackend(activeProject, patch);
      } finally {
        isUndoRedoApplyingRef.current = false;
      }
    },
    [activeProject, clearActiveUndoGroup, onApplySnapshotToBackend]
  );

  const handleUndo = useCallback(() => {
    if (!activeProject || undoStack.length === 0) return;
    const prevSnap = undoStack[undoStack.length - 1];
    const currentSnap = cloneEditableSnapshot(activeProject);
    setUndoStack((u) => u.slice(0, -1));
    setRedoStack((r) => [...r.slice(-29), currentSnap]);
    void applySnapshot(prevSnap);
  }, [activeProject, undoStack, applySnapshot]);

  const handleRedo = useCallback(() => {
    if (!activeProject || redoStack.length === 0) return;
    const nextSnap = redoStack[redoStack.length - 1];
    const currentSnap = cloneEditableSnapshot(activeProject);
    setRedoStack((r) => r.slice(0, -1));
    setUndoStack((u) => [...u.slice(-29), currentSnap]);
    void applySnapshot(nextSnap);
  }, [activeProject, redoStack, applySnapshot]);

  return {
    undoStack,
    redoStack,
    isUndoRedoApplyingRef,
    activeUndoGroupRef,
    clearActiveUndoGroup,
    pushUndoSnapshot,
    maybeRecordUndo,
    handleUndo,
    handleRedo,
  };
}
