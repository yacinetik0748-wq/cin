import React from 'react';
import { Mic, Volume2 } from 'lucide-react';
import { NavPage, Project } from '../types/studio';
import { MyVoicesManager } from '../components/MyVoicesManager';
import { StudioButton, StudioCard } from '../components/ui/StudioPrimitives';

interface SavedVoicesPageProps {
  activeProject: Project | null;
  onProjectUpdated: (p: Project) => void;
  onNavigate: (page: NavPage) => void;
  onNotice?: (msg: string) => void;
}

export function SavedVoicesPage({
  activeProject,
  onProjectUpdated,
  onNavigate,
  onNotice,
}: SavedVoicesPageProps) {
  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-display font-bold tracking-tight text-white flex items-center gap-2.5">
            <Volume2 className="w-6 h-6 text-violet-400" />
            <span>Saved Voices</span>
          </h1>
          <p className="text-xs sm:text-sm text-zinc-400 mt-1">
            Store, preview, validate, and set default Fish Audio narrator IDs for one-click dubbing across projects.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {activeProject && (
            <StudioButton
              variant="primary"
              size="sm"
              onClick={() => onNavigate('voice')}
              icon={<Mic className="w-3.5 h-3.5" />}
            >
              Open Voice Studio
            </StudioButton>
          )}
        </div>
      </div>

      <StudioCard padding="lg">
        <MyVoicesManager
          activeProject={activeProject}
          onProjectUpdated={onProjectUpdated}
          onNotice={onNotice}
        />
      </StudioCard>
    </div>
  );
}
