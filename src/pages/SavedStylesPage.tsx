import React from 'react';
import { BookmarkPlus, Palette } from 'lucide-react';
import { NavPage, Project } from '../types/studio';
import { MyStylesManager } from '../components/MyStylesManager';
import { StudioButton, StudioCard } from '../components/ui/StudioPrimitives';

interface SavedStylesPageProps {
  activeProject: Project | null;
  onProjectUpdated: (p: Project) => void;
  onOpenSaveStyleDialog: () => void;
  onNavigate: (page: NavPage) => void;
  onNotice?: (msg: string) => void;
}

export function SavedStylesPage({
  activeProject,
  onProjectUpdated,
  onOpenSaveStyleDialog,
  onNavigate,
  onNotice,
}: SavedStylesPageProps) {
  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-display font-bold tracking-tight text-white flex items-center gap-2.5">
            <Palette className="w-6 h-6 text-violet-400" />
            <span>Saved Styles</span>
          </h1>
          <p className="text-xs sm:text-sm text-zinc-400 mt-1">
            Reusable lookbooks storing color filters, visual effects, caption typography, framing, and narrator preferences.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {activeProject && (
            <StudioButton
              variant="secondary"
              size="sm"
              onClick={() => onNavigate('editor')}
            >
              Open Video Editor
            </StudioButton>
          )}
          {activeProject && (
            <StudioButton
              variant="primary"
              size="sm"
              onClick={onOpenSaveStyleDialog}
              icon={<BookmarkPlus className="w-3.5 h-3.5" />}
            >
              Save Current Project Style
            </StudioButton>
          )}
        </div>
      </div>

      <StudioCard padding="lg">
        <MyStylesManager
          activeProject={activeProject}
          onProjectUpdated={onProjectUpdated}
          onOpenSaveStyleDialog={onOpenSaveStyleDialog}
          onNotice={onNotice}
          compactHeader={true}
        />
      </StudioCard>
    </div>
  );
}
