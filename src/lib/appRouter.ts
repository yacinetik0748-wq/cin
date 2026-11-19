import { SettingsTabId } from '../pages/SettingsPage';

export type AppView = 'projects' | 'translator' | 'voice' | 'editor' | 'export' | 'settings' | 'styles';

export interface ParsedRoute {
  view: AppView;
  projectId?: string;
  settingsTab?: SettingsTabId;
  rawPath: string;
}

const KNOWN_SETTINGS_TABS: Set<string> = new Set(['api', 'preferences', 'storage', 'voices', 'styles']);

function normalizeSettingsTab(candidate?: string | null): SettingsTabId {
  if (!candidate) return 'api';
  const cleaned = candidate.trim().toLowerCase();
  if (cleaned === 'workflow') return 'preferences';
  if (KNOWN_SETTINGS_TABS.has(cleaned)) {
    return cleaned as SettingsTabId;
  }
  return 'api';
}

/**
 * Normalizes and parses the current browser URL (window.location.pathname & searchParams).
 * Supports both path-based routes (/editor/:id, /styles, etc.) and search parameters (?project=:id).
 */
export function parseCurrentRoute(): ParsedRoute {
  if (typeof window === 'undefined') {
    return { view: 'projects', rawPath: '/' };
  }

  const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
  const searchParams = new URLSearchParams(window.location.search);
  const queryProjectId = searchParams.get('project') || searchParams.get('projectId') || undefined;
  const queryTab = searchParams.get('tab');

  // 1. Settings (/settings, /settings/:tab)
  if (pathname === '/settings' || pathname.startsWith('/settings/')) {
    const parts = pathname.split('/').filter(Boolean);
    const tabCandidate = parts[1] || queryTab;
    return {
      view: 'settings',
      settingsTab: normalizeSettingsTab(tabCandidate),
      projectId: queryProjectId,
      rawPath: pathname,
    };
  }

  // 2. Saved Styles (/styles, /saved-styles)
  if (pathname === '/styles' || pathname === '/saved-styles' || pathname.startsWith('/styles/')) {
    return {
      view: 'styles',
      projectId: queryProjectId,
      rawPath: pathname,
    };
  }

  // 3. Export Center (/export, /export/:id, /project/:id/export)
  if (pathname === '/export' || pathname.startsWith('/export/')) {
    const parts = pathname.split('/').filter(Boolean);
    const projectId = parts[1] || queryProjectId;
    return {
      view: 'export',
      projectId: projectId || undefined,
      rawPath: pathname,
    };
  }

  // 4. Voice Studio / Audio (/voice, /audio, /voice/:id, /audio/:id, /project/:id/voice)
  if (
    pathname === '/voice' ||
    pathname === '/audio' ||
    pathname.startsWith('/voice/') ||
    pathname.startsWith('/audio/')
  ) {
    const parts = pathname.split('/').filter(Boolean);
    const projectId = parts[1] || queryProjectId;
    return {
      view: 'voice',
      projectId: projectId || undefined,
      rawPath: pathname,
    };
  }

  // 5. Translation Studio (/translator, /translation, /translator/:id, /translation/:id)
  if (
    pathname === '/translator' ||
    pathname === '/translation' ||
    pathname.startsWith('/translator/') ||
    pathname.startsWith('/translation/')
  ) {
    const parts = pathname.split('/').filter(Boolean);
    const projectId = parts[1] || queryProjectId;
    return {
      view: 'translator',
      projectId: projectId || undefined,
      rawPath: pathname,
    };
  }

  // 6. Video Editor (/editor, /editor/:id, /project/:id, /project/:id/editor)
  if (pathname === '/editor' || pathname.startsWith('/editor/')) {
    const parts = pathname.split('/').filter(Boolean);
    const projectId = parts[1] || queryProjectId;
    return {
      view: 'editor',
      projectId: projectId || undefined,
      rawPath: pathname,
    };
  }

  const projectMatch = /^\/project\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
  if (projectMatch) {
    const projectId = projectMatch[1];
    const subRoute = (projectMatch[2] || '').toLowerCase();
    if (subRoute === 'translator' || subRoute === 'translation') {
      return { view: 'translator', projectId, rawPath: pathname };
    }
    if (subRoute === 'voice' || subRoute === 'audio') {
      return { view: 'voice', projectId, rawPath: pathname };
    }
    if (subRoute === 'export') {
      return { view: 'export', projectId, rawPath: pathname };
    }
    return { view: 'editor', projectId, rawPath: pathname };
  }

  // 7. Dashboard / Projects (/dashboard, /projects)
  if (pathname === '/dashboard' || pathname === '/projects') {
    return {
      view: 'projects',
      projectId: queryProjectId,
      rawPath: pathname,
    };
  }

  // 8. Root (/) fallback: restore last active view if user specifically opened /
  let restoredView: AppView = 'projects';
  try {
    const lastView = window.localStorage.getItem('recap_studio_last_active_view');
    if (
      lastView === 'editor' ||
      lastView === 'translator' ||
      lastView === 'voice' ||
      lastView === 'export' ||
      lastView === 'settings' ||
      lastView === 'styles'
    ) {
      restoredView = lastView;
    }
  } catch {
    // ignore
  }

  let restoredProjectId = queryProjectId;
  if (!restoredProjectId) {
    try {
      restoredProjectId = window.localStorage.getItem('recap_studio_last_active_project_id') || undefined;
    } catch {
      // ignore
    }
  }

  return {
    view: restoredView,
    projectId: restoredProjectId,
    rawPath: pathname,
  };
}

/**
 * Builds the canonical URL path for a given view, project, and settings tab.
 */
export function buildPathForView(
  view: AppView,
  projectId?: string | null,
  settingsTab?: SettingsTabId
): string {
  switch (view) {
    case 'settings':
      return settingsTab && settingsTab !== 'api' ? `/settings/${settingsTab}` : '/settings';
    case 'styles':
      return '/styles';
    case 'editor':
      return projectId ? `/editor/${projectId}` : '/editor';
    case 'translator':
      return projectId ? `/translator/${projectId}` : '/translator';
    case 'voice':
      return projectId ? `/voice/${projectId}` : '/voice';
    case 'export':
      return projectId ? `/export/${projectId}` : '/export';
    case 'projects':
    default:
      return '/projects';
  }
}

/**
 * Pushes or replaces the current browser URL to match the target view and options.
 * Preserves /dashboard alias on replace so refreshing /dashboard keeps its exact URL.
 * Also synchronizes localStorage so session continuity is maintained across restarts.
 */
export function syncBrowserUrl(
  view: AppView,
  options?: {
    projectId?: string | null;
    settingsTab?: SettingsTabId;
    replace?: boolean;
  }
): void {
  if (typeof window === 'undefined') return;

  const currentPathname = window.location.pathname.replace(/\/+$/, '') || '/';
  let targetPath = buildPathForView(view, options?.projectId, options?.settingsTab);

  // Preserve /dashboard when replacing on mount or syncing while already on /dashboard
  if (view === 'projects' && currentPathname === '/dashboard' && options?.replace) {
    targetPath = '/dashboard';
  }

  const currentFull = currentPathname + window.location.search;

  try {
    window.localStorage.setItem('recap_studio_last_active_view', view);
    if (options?.projectId) {
      window.localStorage.setItem('recap_studio_last_active_project_id', options.projectId);
    }
  } catch {
    // ignore
  }

  if (currentFull !== targetPath) {
    const stateObj = {
      view,
      projectId: options?.projectId || null,
      settingsTab: options?.settingsTab || null,
    };
    if (options?.replace) {
      window.history.replaceState(stateObj, '', targetPath);
    } else {
      window.history.pushState(stateObj, '', targetPath);
    }
  }
}
