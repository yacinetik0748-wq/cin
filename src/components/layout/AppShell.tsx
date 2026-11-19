import React, { useState } from 'react';
import {
  Archive,
  BookmarkPlus,
  Captions,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CloudOff,
  Film,
  FolderKanban,
  FolderOpen,
  Languages,
  Layers,
  LayoutDashboard,
  Loader2,
  Menu,
  Mic,
  PanelLeftClose,
  PanelLeftOpen,
  Palette,
  Redo2,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Undo2,
  Upload,
  Volume2,
  X,
} from 'lucide-react';
import { NavPage, Project } from '../../types/studio';
import { SaveStatus } from '../../hooks/useProjectSync';

export interface AppShellProps {
  activePage: NavPage;
  onNavigate: (page: NavPage) => void;
  projects: Project[];
  activeProject: Project | null;
  onSelectProject: (project: Project, navigateTo?: NavPage) => void;
  saveStatus: SaveStatus;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onOpenBackupModal: () => void;
  onOpenSaveStyleModal: () => void;
  onOpenMyStylesModal: () => void;
  onOpenExport: () => void;
  isEditorPage: boolean;
  workflowBar?: React.ReactNode;
  banners?: React.ReactNode;
  children: React.ReactNode;
}

interface NavGroup {
  label: string;
  items: Array<{
    id: NavPage;
    label: string;
    Icon: typeof LayoutDashboard;
    requiresProject?: boolean;
  }>;
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Workspace',
    items: [
      { id: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard },
      { id: 'projects', label: 'Projects', Icon: FolderKanban },
      { id: 'media', label: 'Media Library', Icon: FolderOpen, requiresProject: true },
    ],
  },
  {
    label: 'Production',
    items: [
      { id: 'translator', label: 'Translation Studio', Icon: Languages, requiresProject: true },
      { id: 'voice', label: 'Voice Studio', Icon: Mic, requiresProject: true },
      { id: 'editor', label: 'Video Editor', Icon: Film, requiresProject: true },
      { id: 'captions', label: 'Captions', Icon: Captions, requiresProject: true },
      { id: 'effects', label: 'Effects', Icon: Sparkles, requiresProject: true },
      { id: 'export', label: 'Export Center', Icon: Upload, requiresProject: true },
    ],
  },
  {
    label: 'Libraries',
    items: [
      { id: 'styles', label: 'Saved Styles', Icon: Palette },
      { id: 'voices', label: 'Saved Voices', Icon: Volume2 },
    ],
  },
  {
    label: 'System',
    items: [{ id: 'settings', label: 'Settings', Icon: Settings }],
  },
];

const PAGE_TITLES: Record<NavPage, string> = {
  dashboard: 'Dashboard',
  projects: 'Projects',
  media: 'Media Library',
  translator: 'Translation Studio',
  voice: 'Voice Studio',
  editor: 'Video Editor',
  captions: 'Captions Studio',
  effects: 'Effects & Filters',
  blur: 'Blur & Masking',
  branding: 'Branding & Watermarks',
  styles: 'Saved Styles',
  voices: 'Saved Voices',
  export: 'Export Center',
  settings: 'Settings',
};

export function AppShell({
  activePage,
  onNavigate,
  projects,
  activeProject,
  onSelectProject,
  saveStatus,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onOpenBackupModal,
  onOpenSaveStyleModal,
  onOpenMyStylesModal,
  onOpenExport,
  isEditorPage,
  workflowBar,
  banners,
  children,
}: AppShellProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // In Video Editor, default visually to slim rail unless user explicitly expands, or obey toggle
  const isCompactRail = isEditorPage ? !sidebarCollapsed : sidebarCollapsed;

  const isNavItemActive = (itemId: NavPage) => {
    if (activePage === itemId) return true;
    if (itemId === 'editor' && (activePage === 'blur' || activePage === 'branding')) return true;
    return false;
  };

  const renderNavContent = (compact: boolean, onAfterClick?: () => void) => (
    <div className="flex flex-col h-full">
      <div
        className={`h-13 px-3 border-b border-white/[0.08] flex items-center ${
          compact ? 'justify-center' : 'justify-between'
        } shrink-0`}
      >
        <button
          type="button"
          onClick={() => {
            onNavigate('dashboard');
            onAfterClick?.();
          }}
          className="flex items-center gap-2 font-display font-bold tracking-tight text-sm cursor-pointer whitespace-nowrap"
          title="Recap Studio AI"
        >
          <span className="w-7 h-7 rounded-lg bg-violet-600/20 border border-violet-500/40 text-violet-300 flex items-center justify-center shrink-0">
            <SlidersHorizontal className="w-3.5 h-3.5" />
          </span>
          {!compact && (
            <span>
              <span className="text-white">RECAP</span>{' '}
              <span className="text-violet-400">STUDIO AI</span>
            </span>
          )}
        </button>

        {!compact && (
          <button
            type="button"
            onClick={() => setSidebarCollapsed((v) => !v)}
            className="hidden lg:flex w-7 h-7 rounded-md text-zinc-400 hover:text-white hover:bg-white/[0.06] items-center justify-center cursor-pointer"
            title={isEditorPage ? 'Expand navigation' : 'Collapse navigation'}
            aria-label="Toggle navigation sidebar"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        )}
      </div>

      <nav
        aria-label="Primary Workspace Navigation"
        className="flex-1 overflow-y-auto px-2 py-3 space-y-4"
      >
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="space-y-1">
            {!compact && (
              <div className="px-2.5 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                {group.label}
              </div>
            )}
            {group.items.map(({ id, label, Icon, requiresProject }) => {
              const active = isNavItemActive(id);
              const disabled = Boolean(requiresProject && !activeProject);
              return (
                <button
                  key={id}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onNavigate(id);
                    onAfterClick?.();
                  }}
                  title={compact ? (disabled ? `${label} (Select a project first)` : label) : undefined}
                  aria-current={active ? 'page' : undefined}
                  className={`w-full min-h-[38px] rounded-lg flex items-center ${
                    compact ? 'justify-center px-0' : 'px-2.5 gap-2.5'
                  } text-xs font-medium transition-colors cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed ${
                    active
                      ? 'bg-violet-600/20 text-white border border-violet-500/40'
                      : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.05] border border-transparent'
                  }`}
                >
                  <Icon
                    className={`w-4 h-4 shrink-0 ${active ? 'text-violet-300' : 'text-zinc-400'}`}
                  />
                  {!compact && <span className="truncate">{label}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="p-2 border-t border-white/[0.08] shrink-0">
        {compact ? (
          <button
            type="button"
            onClick={() => setSidebarCollapsed((v) => !v)}
            className="w-full min-h-[36px] rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] flex items-center justify-center cursor-pointer"
            title="Expand sidebar"
            aria-label="Expand sidebar"
          >
            <PanelLeftOpen className="w-4 h-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              onOpenBackupModal();
              onAfterClick?.();
            }}
            className="w-full min-h-[38px] px-2.5 rounded-lg bg-[#16161D] hover:bg-[#1E1E28] border border-white/[0.08] text-xs font-medium text-zinc-200 flex items-center gap-2 cursor-pointer"
          >
            <Archive className="w-4 h-4 text-emerald-400 shrink-0" />
            <span className="truncate">Backup &amp; Cache</span>
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="h-dvh w-screen overflow-hidden bg-[#09090B] text-zinc-100 flex">
      {/* Desktop Workspace Sidebar */}
      <aside
        className={`hidden lg:flex flex-col shrink-0 bg-[#0C0C10] border-r border-white/[0.08] transition-[width] duration-150 ${
          isCompactRail ? 'w-[60px]' : 'w-[228px]'
        }`}
      >
        {renderNavContent(isCompactRail)}
      </aside>

      {/* Mobile Slide-Over Navigation Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/70"
            onClick={() => setMobileMenuOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative z-10 w-[264px] max-w-[82vw] h-full bg-[#0C0C10] border-r border-white/[0.1] flex flex-col shadow-2xl">
            <div className="absolute top-2.5 right-2.5 z-20">
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="w-8 h-8 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.08] flex items-center justify-center cursor-pointer"
                aria-label="Close navigation menu"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {renderNavContent(false, () => setMobileMenuOpen(false))}
          </aside>
        </div>
      )}

      {/* Main Column */}
      <div className="flex-1 min-w-0 h-full flex flex-col overflow-hidden">
        {/* Clean 3-Zone Top Header */}
        <header className="h-13 px-2.5 sm:px-4 border-b border-white/[0.08] bg-[#0C0C10] flex items-center justify-between gap-2 shrink-0 z-30">
          {/* Zone 1: Menu + Breadcrumb / Active Project */}
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden min-w-[38px] min-h-[38px] rounded-lg text-zinc-200 hover:text-white hover:bg-white/[0.06] flex items-center justify-center cursor-pointer shrink-0"
              aria-label="Open menu"
            >
              <Menu className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-1.5 text-xs sm:text-sm min-w-0">
              <span className="font-display font-semibold text-white truncate">
                {PAGE_TITLES[activePage]}
              </span>
              {activeProject && (
                <>
                  <ChevronRight className="w-3.5 h-3.5 text-zinc-600 shrink-0 hidden sm:inline" />
                  <select
                    value={activeProject.id}
                    onChange={(e) => {
                      const found = projects.find((p) => p.id === e.target.value);
                      if (found) onSelectProject(found, activePage);
                    }}
                    className="hidden sm:block bg-[#15151C] border border-white/[0.08] rounded-lg px-2 py-1 text-xs text-zinc-200 font-medium truncate max-w-[190px] focus:outline-none focus:border-violet-500 cursor-pointer"
                    aria-label="Switch active project"
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id} className="bg-[#111115] text-zinc-100">
                        {p.name}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>
          </div>

          {/* Zone 2: Save / Offline Status (Unboxed inline indicator) */}
          <div className="hidden md:flex items-center gap-2 text-[11px] text-zinc-400 shrink-0">
            {saveStatus === 'saving' ? (
              <span className="inline-flex items-center gap-1 text-violet-300">
                <Loader2 className="w-3 h-3 animate-spin" />
                Saving
              </span>
            ) : saveStatus === 'offline' ? (
              <span className="inline-flex items-center gap-1 text-amber-300">
                <CloudOff className="w-3 h-3" />
                Offline Cache
              </span>
            ) : saveStatus === 'error' ? (
              <span className="inline-flex items-center gap-1 text-red-300">
                Sync Retry Pending
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-zinc-400">
                <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                Saved
              </span>
            )}
          </div>

          {/* Zone 3: Contextual Actions */}
          <div className="flex items-center gap-1.5 shrink-0">
            {isEditorPage && activeProject && (
              <>
                <button
                  type="button"
                  onClick={onUndo}
                  disabled={!canUndo}
                  title="Undo (Ctrl+Z)"
                  aria-label="Undo"
                  className="min-w-[36px] min-h-[36px] p-1.5 rounded-lg text-zinc-300 hover:text-white hover:bg-white/[0.06] disabled:opacity-30 flex items-center justify-center cursor-pointer"
                >
                  <Undo2 className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={onRedo}
                  disabled={!canRedo}
                  title="Redo (Ctrl+Shift+Z)"
                  aria-label="Redo"
                  className="min-w-[36px] min-h-[36px] p-1.5 rounded-lg text-zinc-300 hover:text-white hover:bg-white/[0.06] disabled:opacity-30 flex items-center justify-center cursor-pointer"
                >
                  <Redo2 className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={onOpenSaveStyleModal}
                  title="Save Current Style"
                  className="min-h-[36px] px-2.5 py-1 rounded-lg bg-[#16161D] hover:bg-[#1E1E28] border border-white/[0.08] text-xs font-medium text-zinc-200 hidden sm:flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                >
                  <BookmarkPlus className="w-3.5 h-3.5 text-violet-400" />
                  <span className="hidden xl:inline">Save Style</span>
                </button>
                <button
                  type="button"
                  onClick={onOpenMyStylesModal}
                  title="My Styles"
                  className="min-h-[36px] px-2.5 py-1 rounded-lg bg-[#16161D] hover:bg-[#1E1E28] border border-white/[0.08] text-xs font-medium text-zinc-200 hidden sm:flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                >
                  <Layers className="w-3.5 h-3.5 text-violet-400" />
                  <span className="hidden xl:inline">Styles</span>
                </button>
              </>
            )}

            {activeProject && activePage !== 'export' && (
              <button
                type="button"
                onClick={onOpenExport}
                disabled={!activeProject.sourceVideoUrl}
                className="min-h-[36px] px-3 py-1 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Export</span>
              </button>
            )}

            {activePage === 'export' && activeProject && (
              <button
                type="button"
                onClick={() => onNavigate('editor')}
                className="min-h-[36px] px-3 py-1 rounded-lg bg-[#181820] hover:bg-[#22222C] border border-white/[0.09] text-xs font-medium text-zinc-200 flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                <span>Back to Editor</span>
              </button>
            )}
          </div>
        </header>

        {/* Workflow Pipeline Stepper (when inside a project production stage) */}
        {workflowBar}

        {/* Warning / Undo Notices */}
        {banners}

        {/* Active Page Body */}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
