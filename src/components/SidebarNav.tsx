import React from 'react';
import {
  AlertTriangle,
  Captions,
  CheckCircle2,
  Download,
  Film,
  Languages,
  LayoutDashboard,
  Mic,
  Palette,
  Settings,
  ShieldCheck,
  X,
} from 'lucide-react';
import { NavPage, Project } from '../types/studio';
import { StageStatusInfo } from '../lib/workflowStages';

interface SidebarNavProps {
  activePage: NavPage;
  onSelectPage: (page: NavPage) => void;
  activeProject: Project | null;
  stageStatuses: StageStatusInfo[];
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

interface NavItemDef {
  id: NavPage;
  label: string;
  stageBadge: string;
  icon: React.ComponentType<{ className?: string }>;
}

const STAGE_NAV_ITEMS: NavItemDef[] = [
  { id: 'translator', label: 'Translation Studio', stageBadge: '1', icon: Languages },
  { id: 'voice', label: 'Voice Studio', stageBadge: '2', icon: Mic },
  { id: 'editor', label: 'Video Editor', stageBadge: '3', icon: Film },
  { id: 'export', label: 'Export', stageBadge: '4', icon: Download },
  { id: 'styles', label: 'My Saved Styles', stageBadge: '★', icon: Palette },
  { id: 'dashboard', label: 'Projects & Import', stageBadge: '•', icon: LayoutDashboard },
];

export function SidebarNav({
  activePage,
  onSelectPage,
  activeProject,
  stageStatuses,
  mobileOpen,
  onCloseMobile,
}: SidebarNavProps) {
  const navContent = (
    <aside className="w-[248px] h-full bg-[#111115] border-r border-white/[0.08] flex flex-col justify-between select-none">
      <div>
        <div className="h-14 px-5 flex items-center justify-between border-b border-white/[0.08]">
          <button
            type="button"
            onClick={() => {
              onSelectPage('dashboard');
              onCloseMobile();
            }}
            className="text-left font-display font-bold text-[15px] tracking-tight text-white whitespace-nowrap shrink-0 cursor-pointer"
          >
            Recap Studio <span className="text-violet-400">AI</span>
          </button>
          <button
            type="button"
            onClick={onCloseMobile}
            className="lg:hidden p-1.5 text-zinc-400 hover:text-white rounded-md"
            aria-label="Close navigation"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <nav className="p-3 space-y-5">
          <div>
            <div className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
              Sequential Workflow
            </div>
            <div className="space-y-1">
              {STAGE_NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = activePage === item.id;
                const info = stageStatuses.find((s) => s.id === item.id);
                const status = info?.status || 'Not Started';

                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      onSelectPage(item.id);
                      onCloseMobile();
                    }}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-[13px] font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      active
                        ? 'bg-violet-600 text-white shadow-sm font-semibold'
                        : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 truncate">
                      <Icon className="w-4 h-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {status === 'Completed' && !active && (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      )}
                      {status === 'Needs Attention' && !active && (
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                      )}
                      <span
                        className={`text-[10px] font-mono px-1.5 py-0.2 rounded font-bold ${
                          active ? 'bg-white/20 text-white' : 'bg-zinc-800 text-zinc-400'
                        }`}
                      >
                        {item.stageBadge}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
              Preferences
            </div>
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => {
                  onSelectPage('settings');
                  onCloseMobile();
                }}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[12.5px] font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  activePage === 'settings'
                    ? 'bg-violet-600 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]'
                }`}
              >
                <Settings className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">System Settings</span>
              </button>
            </div>
          </div>
        </nav>
      </div>

      <div className="p-4 border-t border-white/[0.08] space-y-3">
        {activeProject ? (
          <div className="space-y-1">
            <div className="text-[11px] font-medium text-zinc-500">Active Project</div>
            <div className="text-xs font-medium text-zinc-200 truncate">{activeProject.name}</div>
            <div className="text-[11px] text-zinc-500 font-mono tabular-nums truncate">
              {activeProject.metadata
                ? `${activeProject.metadata.width}x${activeProject.metadata.height} · ${activeProject.metadata.fps} fps`
                : 'No video loaded'}
            </div>
          </div>
        ) : (
          <div className="text-xs text-zinc-500">Select or import a project video to begin.</div>
        )}

        <div className="pt-2 border-t border-white/[0.06] flex items-start gap-2 text-[11px] text-zinc-500 leading-relaxed">
          <ShieldCheck className="w-3.5 h-3.5 text-zinc-400 shrink-0 mt-0.5" />
          <span>Edit only media you own or are authorized to modify.</span>
        </div>
      </div>
    </aside>
  );

  return (
    <>
      <div className="hidden lg:block h-full shrink-0">{navContent}</div>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/70 backdrop-blur-xs"
            onClick={onCloseMobile}
          />
          <div className="relative z-10 h-full">{navContent}</div>
        </div>
      )}
    </>
  );
}
