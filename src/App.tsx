import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Captions,
  Check,
  ChevronLeft,
  Columns2,
  Copy,
  Crop,
  Droplet,
  Eye,
  EyeOff,
  FileText,
  Film,
  FlipHorizontal2,
  FlipVertical2,
  Gauge,
  Layers,
  Layers3,
  Loader2,
  Lock,
  Mic,
  MoreHorizontal,
  Move,
  Music2,
  Palette,
  Redo2,
  RefreshCw,
  RotateCw,
  Scissors,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SquareDashed,
  SunMedium,
  Trash2,
  Type,
  Undo2,
  Unlock,
  Unlink,
  Upload,
  Volume2,
  VolumeX,
  Wand2,
  X,
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import {
  BlurEffect,
  CanvasAspectRatio,
  CaptionSegment,
  DEFAULT_VIDEO_CANVAS,
  DEFAULT_VIDEO_EFFECTS,
  EditSubActionId,
  FilterLayerItem,
  LogoOverlay,
  NavPage,
  OriginalAudioClip,
  PendingSyncOp,
  Project,
  ProjectPatchFn,
  RenderJob,
  SavedFontAsset,
  StudioElementSelection,
  StudioToolId,
  SubtitleStyle,
  VideoCanvasConfig,
  VideoClip,
  VideoEffectsConfig,
  VisualEffectItem,
  VoiceConfig,
} from './types/studio';
import { api, PresetWarning } from './lib/api';
import { indexedDbStore } from './lib/indexedDbStore';
import { localProjectService } from './lib/localProjectService';
import { LocalBackupModal } from './components/LocalBackupModal';
import {
  getCloudSession,
  getSupabaseClient,
  hydrateProjectAssetsFromCloud,
  queueDebouncedMetadataSync,
  subscribeToCloudProjectsRealtime,
} from './lib/supabaseCloud';
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
} from './lib/videoTimeline';
import { getEffectCatalogEntry, getFilterPresetMeta } from './lib/videoFiltersCatalog';
import {
  createWorkflowUpdate,
  deleteCaptionWithSync,
  getCaptionTimelineOffset,
  getPipelineSteps,
  getSyncedCaptionsForPreview,
  PipelineStepId,
  splitCaptionWithSync,
  validateProjectReadyForEditor,
} from './lib/workflowStages';
import { getBlurTimelineSpan } from './lib/blurMasks';
import { VideoStudioPlayer } from './components/VideoStudioPlayer';
import { TimelineEditor } from './components/TimelineEditor';
import { WorkflowStepperBar } from './components/WorkflowStepperBar';
import { StudioBottomSheet } from './components/ui/StudioBottomSheet';
import { DEFAULT_TOOL_MEMORY, StudioToolMemory } from './components/sheets/toolMemory';
import { ContextualInspector } from './components/editor/ContextualInspector';
import { DashboardPage } from './pages/DashboardPage';
import { TranslatorPage } from './pages/TranslatorPage';
import { VoiceStudioPage } from './pages/VoiceStudioPage';
import { ExportCenterPage } from './pages/ExportCenterPage';
import { SavedStylesPage } from './pages/SavedStylesPage';
import { SettingsPage, SettingsTabId } from './pages/SettingsPage';
import { SaveStyleDialog } from './components/SaveStyleDialog';
import { MyStylesManager } from './components/MyStylesManager';
import { AppView, parseCurrentRoute, syncBrowserUrl } from './lib/appRouter';
import { BookmarkPlus } from 'lucide-react';

interface EditableSnapshot {
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

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface ProjectPatchQueueEntry {
  pendingKeys: Set<keyof Project>;
  dirtySeq: Map<keyof Project, number>;
  inFlight: boolean;
  inFlightKeys: Set<keyof Project>;
  timerId: number | null;
  retryTimerId: number | null;
  retryAttempt: number;
  needsResend: boolean;
  flushWaiters: Array<(ok: boolean) => void>;
}

function cloneEditableSnapshot(project: Project): EditableSnapshot {
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

function snapshotsEqual(a: EditableSnapshot, b: EditableSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const TOOL_DOCK_ITEMS: Array<{
  id: StudioToolId;
  label: string;
  Icon: typeof SlidersHorizontal;
}> = [
  { id: 'edit', label: 'Edit', Icon: SlidersHorizontal },
  { id: 'audio', label: 'Audio', Icon: Music2 },
  { id: 'text', label: 'Text', Icon: Type },
  { id: 'captions', label: 'Captions', Icon: Captions },
  { id: 'overlay', label: 'Overlay', Icon: Layers },
  { id: 'blur', label: 'Blur', Icon: Droplet },
  { id: 'filters', label: 'Filters', Icon: Palette },
  { id: 'effects', label: 'Effects', Icon: Sparkles },
  { id: 'adjust', label: 'Adjust', Icon: SunMedium },
  { id: 'layers', label: 'Layers', Icon: Layers3 },
];

const TOOL_TITLES: Record<StudioToolId, string> = {
  edit: 'Edit Clip & Canvas',
  audio: 'Audio, Voice & Script',
  text: 'Text Overlays',
  captions: 'Manual Captions',
  overlay: 'Logo & Watermark Overlay',
  blur: 'Blur & Motion Tracking',
  filters: 'Color Filters',
  effects: 'Visual Effects',
  adjust: 'Color Adjustments',
  layers: 'Project Layers',
};

interface SubToolbarActionItem {
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

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const isUndoRedoApplyingRef = useRef(false);
  const noticeTimerRef = useRef<number | null>(null);
  const projectsRef = useRef<Project[]>([]);
  const activeProjectIdRef = useRef<string | null>(null);
  const patchQueueRef = useRef<Map<string, ProjectPatchQueueEntry>>(new Map());
  const patchSeqRef = useRef(0);
  const activeUndoGroupRef = useRef<{ key: string; timerId: number } | null>(null);

  // Top-level Shell Views & Modals (Parsed from initial URL route or session cache)
  const initialRoute = useMemo(() => parseCurrentRoute(), []);
  const [activeView, setActiveView] = useState<AppView>(initialRoute.view);
  const activeViewRef = useRef<AppView>(initialRoute.view);
  activeViewRef.current = activeView;
  const [settingsReturnView, setSettingsReturnView] = useState<AppView>('projects');
  const [focusTranslationOverflowSignal, setFocusTranslationOverflowSignal] = useState(0);
  const [cloudModalOpen, setCloudModalOpen] = useState(false);
  const [saveStyleModalOpen, setSaveStyleModalOpen] = useState(false);
  const [myStylesModalOpen, setMyStylesModalOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTabId>(initialRoute.settingsTab || 'api');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const updateActiveView = useCallback(
    (
      view: AppView,
      opts?: {
        projectId?: string | null;
        settingsTab?: SettingsTabId;
        replace?: boolean;
      }
    ) => {
      activeViewRef.current = view;
      setActiveView(view);
      const targetProjId =
        opts?.projectId !== undefined ? opts.projectId : activeProjectIdRef.current;
      if (opts?.settingsTab) {
        setSettingsInitialTab(opts.settingsTab);
      }
      syncBrowserUrl(view, {
        projectId: targetProjId,
        settingsTab: opts?.settingsTab,
        replace: opts?.replace,
      });
    },
    []
  );

  const openSettingsPage = useCallback(
    (tab: SettingsTabId = 'api') => {
      videoRef.current?.pause();
      setActiveTool(null);
      setMoreMenuOpen(false);
      setSettingsInitialTab(tab);
      const currentView = activeViewRef.current;
      if (currentView !== 'settings') {
        setSettingsReturnView(currentView);
      }
      updateActiveView('settings', { settingsTab: tab });
    },
    [updateActiveView]
  );

  // Active Tool Sheet (mobile drawer), Docked Inspector Tool (desktop), & Resizable Timeline Height
  const [activeTool, setActiveTool] = useState<StudioToolId | null>(null);
  const [inspectorTool, setInspectorTool] = useState<StudioToolId>('edit');
  const [toolMemory, setToolMemory] = useState<StudioToolMemory>(DEFAULT_TOOL_MEMORY);
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [timelineHeightPx, setTimelineHeightPx] = useState(256);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);

  const handleTimelineSplitterDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = timelineExpanded ? 390 : timelineHeightPx;
      setTimelineExpanded(false);
      const handleMove = (mv: PointerEvent) => {
        const delta = startY - mv.clientY;
        const maxH = Math.max(260, window.innerHeight - 300);
        const clamped = Math.max(176, Math.min(maxH, Math.round(startH + delta)));
        setTimelineHeightPx(clamped);
      };
      const handleUp = () => {
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', handleUp);
        window.removeEventListener('pointercancel', handleUp);
      };
      window.addEventListener('pointermove', handleMove);
      window.addEventListener('pointerup', handleUp);
      window.addEventListener('pointercancel', handleUp);
    },
    [timelineExpanded, timelineHeightPx]
  );

  // Workspace Data State
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => {
    try {
      const route = parseCurrentRoute();
      if (route.projectId) {
        return route.projectId;
      }
      return window.localStorage.getItem('recap_studio_last_active_project_id') || null;
    } catch {
      return null;
    }
  });
  const [recentJobs, setRecentJobs] = useState<RenderJob[]>([]);
  const [customFonts, setCustomFonts] = useState<SavedFontAsset[]>([]);
  const [presetWarnings, setPresetWarnings] = useState<PresetWarning[]>([]);
  const [actionNotice, setActionNotice] = useState<{ text: string; allowUndo?: boolean } | null>(null);
  const [loading, setLoading] = useState(true);

  // Studio Interaction State
  const [currentTime, setCurrentTime] = useState(0);
  const [previewEffects, setPreviewEffects] = useState(true);
  const [drawMode, setDrawMode] = useState<'none' | 'selective' | 'motion'>('none');
  const [selectedBlurId, setSelectedBlurId] = useState<string | null>(null);
  const [selectedLogoId, setSelectedLogoId] = useState<string | null>(null);
  const [selectedElement, setSelectedElement] = useState<StudioElementSelection>(null);
  const [cropEditMode, setCropEditMode] = useState(false);

  // Undo / Redo Stacks
  const [undoStack, setUndoStack] = useState<EditableSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<EditableSnapshot[]>([]);

  projectsRef.current = projects;
  activeProjectIdRef.current = activeProjectId;

  // Cloud / Offline Sync State
  const [cloudUserId, setCloudUserId] = useState<string | null>(null);
  const [pendingOps, setPendingOps] = useState<PendingSyncOp[]>([]);

  const showNotice = useCallback(
    (msg: string, opts?: { allowUndo?: boolean; durationMs?: number }) => {
      setActionNotice({ text: msg, allowUndo: opts?.allowUndo });
      if (noticeTimerRef.current) {
        window.clearTimeout(noticeTimerRef.current);
      }
      noticeTimerRef.current = window.setTimeout(() => {
        setActionNotice(null);
        noticeTimerRef.current = null;
      }, opts?.durationMs ?? (opts?.allowUndo ? 5000 : 3200));
    },
    []
  );

  const updateToolMemory = useCallback((patch: Partial<StudioToolMemory>) => {
    setToolMemory((prev) => ({ ...prev, ...patch }));
  }, []);

  const reloadCustomFonts = useCallback(async () => {
    try {
      const res = await api.listCustomFonts();
      if (Array.isArray(res?.fonts)) {
        setCustomFonts(res.fonts);
      }
    } catch {
      // ignore transient font list errors
    }
  }, []);

  const refreshPendingOps = useCallback(async () => {
    const ops = await indexedDbStore.listPendingSyncOps();
    setPendingOps(ops);
  }, []);

  const refreshCloudAuth = useCallback(async () => {
    const { user } = await getCloudSession();
    setCloudUserId(user?.id || null);
    await refreshPendingOps();
  }, [refreshPendingOps]);

  const loadWorkspaceData = useCallback(async () => {
    await localProjectService.init();
    const route = parseCurrentRoute();
    const resolveProjectSelection = (list: Project[], prevId: string | null): string | null => {
      // If URL explicitly names a project, preserve it if found (and never hijack to another project)
      if (route.projectId) {
        if (list.some((p) => p.id === route.projectId)) {
          activeProjectIdRef.current = route.projectId;
          return route.projectId;
        }
        activeProjectIdRef.current = route.projectId;
        return route.projectId;
      }
      let restoredId = prevId;
      try {
        if (!restoredId) {
          restoredId = window.localStorage.getItem('recap_studio_last_active_project_id');
        }
      } catch {
        // ignore
      }
      if (restoredId && list.some((p) => p.id === restoredId)) {
        activeProjectIdRef.current = restoredId;
        return restoredId;
      }
      const fallback = list[0]?.id || null;
      activeProjectIdRef.current = fallback;
      return fallback;
    };

    try {
      const [projRes, jobRes, fontRes] = await Promise.all([
        api.listProjects(),
        api.listAllJobs().catch(() => ({ jobs: [] as RenderJob[] })),
        api.listCustomFonts().catch(() => ({ fonts: [] as SavedFontAsset[] })),
      ]);
      const validProjects = Array.isArray(projRes?.projects)
        ? projRes.projects.filter((p): p is Project => Boolean(p && p.id))
        : [];

      // If route references a specific project missing from list, try fetching directly or from IDB snapshot
      if (route.projectId && !validProjects.some((p) => p.id === route.projectId)) {
        try {
          const direct = await api.getProject(route.projectId);
          if (direct?.project?.id) {
            validProjects.unshift(direct.project);
          }
        } catch {
          const cached = await indexedDbStore.listProjectSnapshots();
          const cachedMatch = cached.find((p) => p.id === route.projectId);
          if (cachedMatch) {
            validProjects.unshift(cachedMatch);
          }
        }
      }

      const validJobs = Array.isArray(jobRes?.jobs) ? jobRes.jobs : [];
      projectsRef.current = validProjects;
      setProjects(validProjects);
      void indexedDbStore.saveAllProjectSnapshots(validProjects);
      setRecentJobs(validJobs);
      if (Array.isArray(fontRes?.fonts)) {
        setCustomFonts(fontRes.fonts);
      }

      setActiveProjectId((prev) => resolveProjectSelection(validProjects, prev));
    } catch {
      const cached = await indexedDbStore.listProjectSnapshots();
      if (cached.length > 0) {
        projectsRef.current = cached;
        setProjects(cached);
        setActiveProjectId((prev) => resolveProjectSelection(cached, prev));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Synchronize browser URL on first mount without overwriting /dashboard or valid subroutes
  useEffect(() => {
    const route = parseCurrentRoute();
    const resolvedProjId = route.projectId || activeProjectIdRef.current;
    if (route.rawPath === '/' || (['editor', 'translator', 'voice', 'export'].includes(route.view) && !route.projectId && resolvedProjId)) {
      syncBrowserUrl(route.view, {
        projectId: resolvedProjId,
        settingsTab: route.settingsTab,
        replace: true,
      });
    } else if (route.rawPath === '/dashboard' || route.rawPath === '/projects') {
      syncBrowserUrl('projects', {
        projectId: resolvedProjId,
        replace: true,
      });
    } else {
      syncBrowserUrl(route.view, {
        projectId: resolvedProjId,
        settingsTab: route.settingsTab,
        replace: true,
      });
    }
  }, []);

  // Listen to browser Back/Forward (popstate) navigation
  useEffect(() => {
    const handlePopState = () => {
      const route = parseCurrentRoute();
      activeViewRef.current = route.view;
      setActiveView(route.view);
      if (route.settingsTab) {
        setSettingsInitialTab(route.settingsTab);
      }
      if (route.projectId) {
        setActiveProjectId(route.projectId);
        activeProjectIdRef.current = route.projectId;
        try {
          window.localStorage.setItem('recap_studio_last_active_project_id', route.projectId);
        } catch {
          // ignore
        }
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    void loadWorkspaceData();
    void refreshCloudAuth();
  }, [loadWorkspaceData, refreshCloudAuth]);

  useEffect(() => {
    const onOnline = () => {
      void refreshPendingOps();
    };
    window.addEventListener('online', onOnline);

    const client = getSupabaseClient();
    const authSub = client?.auth.onAuthStateChange((_evt, session) => {
      setCloudUserId(session?.user?.id || null);
    });

    return () => {
      window.removeEventListener('online', onOnline);
      authSub?.data.subscription.unsubscribe();
    };
  }, [refreshPendingOps]);

  useEffect(() => {
    if (!cloudUserId) return;
    const unsubscribe = subscribeToCloudProjectsRealtime(cloudUserId, async (evt) => {
      if (evt.eventType === 'DELETE') {
        setProjects((prev) => prev.filter((p) => p.id !== evt.projectId));
        return;
      }
      if (!evt.project) return;
      try {
        const { project: savedLocal } = await api.upsertProjectFromCloud(evt.project);
        await indexedDbStore.saveProjectSnapshot(savedLocal);
        setProjects((prev) => {
          const exists = prev.some((p) => p.id === savedLocal.id);
          return exists
            ? prev.map((p) => (p.id === savedLocal.id ? savedLocal : p))
            : [savedLocal, ...prev];
        });
        void hydrateProjectAssetsFromCloud(savedLocal);
      } catch {
        // ignore transient realtime sync hydration issues
      }
    });
    return unsubscribe;
  }, [cloudUserId]);

  useEffect(() => {
    setUndoStack([]);
    setRedoStack([]);
    if (activeUndoGroupRef.current) {
      window.clearTimeout(activeUndoGroupRef.current.timerId);
      activeUndoGroupRef.current = null;
    }
  }, [activeProjectId]);

  const activeProject = projects.find((p) => p && p.id === activeProjectId) || null;

  const getQueueEntry = useCallback((projectId: string): ProjectPatchQueueEntry => {
    let entry = patchQueueRef.current.get(projectId);
    if (!entry) {
      entry = {
        pendingKeys: new Set(),
        dirtySeq: new Map(),
        inFlight: false,
        inFlightKeys: new Set(),
        timerId: null,
        retryTimerId: null,
        retryAttempt: 0,
        needsResend: false,
        flushWaiters: [],
      };
      patchQueueRef.current.set(projectId, entry);
    }
    return entry;
  }, []);

  const recomputeSaveFlags = useCallback(() => {
    let anyUnsaved = false;
    let anyInFlight = false;
    for (const q of patchQueueRef.current.values()) {
      if (q.pendingKeys.size > 0 || q.inFlight || q.needsResend) {
        anyUnsaved = true;
      }
      if (q.inFlight) {
        anyInFlight = true;
      }
    }
    setHasUnsavedChanges(anyUnsaved);
    return { anyUnsaved, anyInFlight };
  }, []);

  const clearActiveUndoGroup = useCallback(() => {
    if (activeUndoGroupRef.current) {
      window.clearTimeout(activeUndoGroupRef.current.timerId);
      activeUndoGroupRef.current = null;
    }
  }, []);

  const pushUndoSnapshot = useCallback((projectToSave: Project) => {
    const snap = cloneEditableSnapshot(projectToSave);
    setUndoStack((prev) => {
      const top = prev[prev.length - 1];
      if (top && snapshotsEqual(top, snap)) return prev;
      return [...prev.slice(-29), snap];
    });
    setRedoStack([]);
  }, []);

  const resolveEntryWaiters = useCallback((entry: ProjectPatchQueueEntry, ok: boolean) => {
    if (entry.flushWaiters.length === 0) return;
    const waiters = entry.flushWaiters.splice(0, entry.flushWaiters.length);
    for (const resolve of waiters) {
      resolve(ok);
    }
  }, []);

  const flushProjectPatch = useCallback(
    async (projectId: string): Promise<boolean> => {
      const entry = getQueueEntry(projectId);
      if (entry.timerId !== null) {
        window.clearTimeout(entry.timerId);
        entry.timerId = null;
      }
      if (entry.retryTimerId !== null) {
        window.clearTimeout(entry.retryTimerId);
        entry.retryTimerId = null;
      }
      if (entry.inFlight) {
        entry.needsResend = true;
        return new Promise<boolean>((resolve) => {
          entry.flushWaiters.push(resolve);
        });
      }
      const keysToSend = Array.from(entry.pendingKeys);
      if (keysToSend.length === 0) {
        resolveEntryWaiters(entry, true);
        recomputeSaveFlags();
        return true;
      }
      entry.pendingKeys.clear();
      entry.inFlightKeys = new Set(keysToSend);

      const latest = projectsRef.current.find((p) => p.id === projectId);
      if (!latest) {
        entry.inFlightKeys.clear();
        resolveEntryWaiters(entry, false);
        recomputeSaveFlags();
        return false;
      }

      const body: Partial<Project> = {};
      const sentSeq = new Map<keyof Project, number>();
      for (const k of keysToSend) {
        (body as Record<string, unknown>)[k] = latest[k];
        sentSeq.set(k, entry.dirtySeq.get(k) ?? 0);
      }

      entry.inFlight = true;
      entry.needsResend = false;
      setSaveStatus('saving');
      setSaveError(null);
      setHasUnsavedChanges(true);

      let succeeded = false;
      let shouldScheduleFollowUp = false;

      try {
        const { project: saved } = await api.updateProject(projectId, body);
        if (saved && saved.id) {
          entry.retryAttempt = 0;
          const cur = projectsRef.current.find((p) => p.id === projectId);
          const merged: Project = { ...saved };
          for (const [k, seq] of entry.dirtySeq.entries()) {
            const sent = sentSeq.get(k) ?? 0;
            if (cur && (seq > sent || entry.pendingKeys.has(k))) {
              Object.assign(merged, { [k]: cur[k] });
            } else {
              entry.dirtySeq.delete(k);
            }
          }
          const nextProjects = projectsRef.current.map((p) =>
            p.id === merged.id ? merged : p
          );
          projectsRef.current = nextProjects;
          setProjects(nextProjects);
          void indexedDbStore.saveProjectSnapshot(merged);
          queueDebouncedMetadataSync(merged, (syncedProject) => {
            const curAfterSync = projectsRef.current.find((p) => p.id === syncedProject.id);
            if (!curAfterSync) return;
            const nextList = projectsRef.current.map((p) =>
              p.id === syncedProject.id
                ? { ...p, cloudSync: syncedProject.cloudSync, cloudAssets: syncedProject.cloudAssets }
                : p
            );
            projectsRef.current = nextList;
            setProjects(nextList);
            void indexedDbStore.saveProjectSnapshot(
              nextList.find((p) => p.id === syncedProject.id) || syncedProject
            );
            void refreshPendingOps();
          });
        }
        succeeded = true;
        shouldScheduleFollowUp = entry.needsResend || entry.pendingKeys.size > 0;
      } catch (err) {
        for (const k of keysToSend) {
          entry.pendingKeys.add(k);
        }
        entry.retryAttempt += 1;
        const msg = err instanceof Error ? err.message : 'Failed to save changes';
        setSaveStatus('error');
        setSaveError(msg);
        // Controlled exponential backoff (up to 3 automatic retries) — never a tight loop
        if (entry.retryAttempt <= 3) {
          const delayMs = Math.min(12000, 2000 * Math.pow(2, entry.retryAttempt - 1));
          entry.retryTimerId = window.setTimeout(() => {
            entry.retryTimerId = null;
            void flushProjectPatch(projectId);
          }, delayMs);
        }
      } finally {
        entry.inFlight = false;
        entry.inFlightKeys.clear();
        entry.needsResend = false;
      }

      if (succeeded && shouldScheduleFollowUp) {
        return flushProjectPatch(projectId);
      }

      const { anyUnsaved } = recomputeSaveFlags();
      if (succeeded) {
        if (!anyUnsaved) {
          setSaveStatus('saved');
          setSaveError(null);
          setLastSavedAt(new Date().toISOString());
        }
        resolveEntryWaiters(entry, true);
        return true;
      }

      resolveEntryWaiters(entry, false);
      return false;
    },
    [getQueueEntry, recomputeSaveFlags, refreshPendingOps, resolveEntryWaiters]
  );

  const flushPendingSaves = useCallback(
    async (projectId?: string): Promise<boolean> => {
      if (projectId) {
        const entry = getQueueEntry(projectId);
        if (
          !entry.inFlight &&
          entry.pendingKeys.size === 0 &&
          entry.timerId === null
        ) {
          return true;
        }
        entry.retryAttempt = 0;
        return flushProjectPatch(projectId);
      }
      const ids = Array.from(patchQueueRef.current.keys());
      if (ids.length === 0) return true;
      const results = await Promise.all(
        ids.map((id) => {
          const entry = getQueueEntry(id);
          if (!entry.inFlight && entry.pendingKeys.size === 0 && entry.timerId === null) {
            return Promise.resolve(true);
          }
          entry.retryAttempt = 0;
          return flushProjectPatch(id);
        })
      );
      return results.every(Boolean);
    },
    [flushProjectPatch, getQueueEntry]
  );

  const commitProjectPatch = useCallback<ProjectPatchFn>(
    (projectId, updater, opts) => {
      const current = projectsRef.current.find((p) => p.id === projectId);
      if (!current) return;

      const patch = typeof updater === 'function' ? updater(current) : updater;
      const patchKeys = Object.keys(patch) as Array<keyof Project>;
      if (patchKeys.length === 0) return;

      const nextProject: Project = {
        ...current,
        ...patch,
      };

      const shouldRecordUndo =
        opts?.recordUndo !== false &&
        !isUndoRedoApplyingRef.current &&
        projectId === activeProjectIdRef.current;

      if (shouldRecordUndo) {
        const prevSnap = cloneEditableSnapshot(current);
        const nextSnap = cloneEditableSnapshot(nextProject);
        if (!snapshotsEqual(prevSnap, nextSnap)) {
          if (opts?.undoGroupKey) {
            const activeGroup = activeUndoGroupRef.current;
            if (activeGroup && activeGroup.key === opts.undoGroupKey) {
              window.clearTimeout(activeGroup.timerId);
              activeGroup.timerId = window.setTimeout(() => {
                activeUndoGroupRef.current = null;
              }, 700);
            } else {
              if (activeGroup) window.clearTimeout(activeGroup.timerId);
              pushUndoSnapshot(current);
              const timerId = window.setTimeout(() => {
                activeUndoGroupRef.current = null;
              }, 700);
              activeUndoGroupRef.current = { key: opts.undoGroupKey, timerId };
            }
          } else {
            clearActiveUndoGroup();
            pushUndoSnapshot(current);
          }
        }
      }

      const nextProjects = projectsRef.current.map((p) =>
        p.id === projectId ? nextProject : p
      );
      projectsRef.current = nextProjects;
      setProjects(nextProjects);
      void indexedDbStore.saveProjectSnapshot(nextProject);

      const entry = getQueueEntry(projectId);
      entry.retryAttempt = 0;
      const seq = ++patchSeqRef.current;
      for (const k of patchKeys) {
        entry.pendingKeys.add(k);
        entry.dirtySeq.set(k, seq);
      }

      if (entry.timerId !== null) {
        window.clearTimeout(entry.timerId);
        entry.timerId = null;
      }
      if (entry.retryTimerId !== null) {
        window.clearTimeout(entry.retryTimerId);
        entry.retryTimerId = null;
      }

      setSaveStatus('saving');
      setSaveError(null);
      setHasUnsavedChanges(true);

      const waitMs = opts?.immediate ? 0 : opts?.debounceMs ?? 220;
      if (waitMs <= 0) {
        void flushProjectPatch(projectId);
      } else {
        entry.timerId = window.setTimeout(() => {
          entry.timerId = null;
          void flushProjectPatch(projectId);
        }, waitMs);
      }
    },
    [clearActiveUndoGroup, flushProjectPatch, getQueueEntry, pushUndoSnapshot]
  );

  const handleProjectUpdated = useCallback(
    (updated: Project) => {
      if (!updated || !updated.id) return;
      const safePrev = (Array.isArray(projectsRef.current) ? projectsRef.current : []).filter(
        (p): p is Project => Boolean(p && p.id)
      );
      const existing = safePrev.find((p) => p.id === updated.id);
      if (
        existing &&
        updated.id === activeProjectIdRef.current &&
        !isUndoRedoApplyingRef.current &&
        !activeUndoGroupRef.current
      ) {
        const prevSnap = cloneEditableSnapshot(existing);
        const nextSnap = cloneEditableSnapshot(updated);
        if (!snapshotsEqual(prevSnap, nextSnap)) {
          pushUndoSnapshot(existing);
        }
      }
      const entry = getQueueEntry(updated.id);
      const merged: Project = { ...updated };
      if (existing) {
        for (const k of entry.pendingKeys) {
          Object.assign(merged, { [k]: existing[k] });
        }
        for (const k of entry.inFlightKeys) {
          Object.assign(merged, { [k]: existing[k] });
        }
      }
      const nextProjects = existing
        ? safePrev.map((p) => (p.id === merged.id ? merged : p))
        : [merged, ...safePrev];
      projectsRef.current = nextProjects;
      setProjects(nextProjects);
      void indexedDbStore.saveProjectSnapshot(merged);

      const { anyUnsaved } = recomputeSaveFlags();
      if (!anyUnsaved) {
        setSaveStatus('saved');
        setSaveError(null);
        setLastSavedAt(merged.updatedAt || new Date().toISOString());
      }

      queueDebouncedMetadataSync(merged, (syncedProject) => {
        const nextList = projectsRef.current.map((p) =>
          p.id === syncedProject.id
            ? { ...p, cloudSync: syncedProject.cloudSync, cloudAssets: syncedProject.cloudAssets }
            : p
        );
        projectsRef.current = nextList;
        setProjects(nextList);
        void indexedDbStore.saveProjectSnapshot(
          nextList.find((p) => p.id === syncedProject.id) || syncedProject
        );
        void refreshPendingOps();
      });
    },
    [getQueueEntry, pushUndoSnapshot, recomputeSaveFlags, refreshPendingOps]
  );

  // Warn user on browser close/refresh ONLY when there are unsaved or failing saves
  useEffect(() => {
    if (!hasUnsavedChanges && saveStatus !== 'error') return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges, saveStatus]);

  const applySnapshot = useCallback(
    async (snap: EditableSnapshot) => {
      if (!activeProject) return;
      isUndoRedoApplyingRef.current = true;
      clearActiveUndoGroup();
      const entry = getQueueEntry(activeProject.id);
      if (entry.timerId !== null) {
        window.clearTimeout(entry.timerId);
        entry.timerId = null;
      }
      entry.pendingKeys.clear();
      entry.dirtySeq.clear();

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
      const nextProject: Project = {
        ...activeProject,
        ...patch,
      };
      const nextProjects = projectsRef.current.map((p) =>
        p.id === activeProject.id ? nextProject : p
      );
      projectsRef.current = nextProjects;
      setProjects(nextProjects);

      try {
        const { project: saved } = await api.updateProject(activeProject.id, patch);
        if (saved && saved.id && entry.pendingKeys.size === 0) {
          const syncedList = projectsRef.current.map((p) =>
            p.id === saved.id ? saved : p
          );
          projectsRef.current = syncedList;
          setProjects(syncedList);
        }
      } catch {
        // keep reverted local state
      } finally {
        isUndoRedoApplyingRef.current = false;
      }
    },
    [activeProject, clearActiveUndoGroup, getQueueEntry]
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

  const handleSelectElement = useCallback((el: StudioElementSelection) => {
    setSelectedElement(el);
    if (el?.kind === 'blur') {
      setSelectedBlurId(el.id);
      setInspectorTool('blur');
    } else if (el?.kind === 'logo') {
      setSelectedLogoId(el.id);
      setInspectorTool('overlay');
    } else if (el?.kind === 'captions') {
      setInspectorTool('captions');
    } else if (el?.kind === 'caption-element') {
      setInspectorTool('text');
    } else if (el?.kind === 'audio') {
      setInspectorTool('audio');
    } else if (el?.kind === 'filter') {
      setInspectorTool('filters');
    } else if (el?.kind === 'effect') {
      setInspectorTool(el.effectId ? 'effects' : 'filters');
    } else if (el?.kind === 'video' || el?.kind === 'bg-image') {
      setInspectorTool('edit');
    }
  }, []);

  const handleSelectBlurSynced = useCallback((id: string | null) => {
    setSelectedBlurId(id);
    setSelectedElement(id ? { kind: 'blur', id } : null);
    if (id) setInspectorTool('blur');
  }, []);

  const handleSelectLogoSynced = useCallback((id: string | null) => {
    setSelectedLogoId(id);
    setSelectedElement(id ? { kind: 'logo', id } : null);
    if (id) setInspectorTool('overlay');
  }, []);

  const handleOpenTool = useCallback(
    (tool: StudioToolId, subTab?: string) => {
      if (tool === 'edit' && subTab) {
        if (
          subTab === 'transform' ||
          subTab === 'timing' ||
          subTab === 'background' ||
          subTab === 'media'
        ) {
          updateToolMemory({ editTab: subTab });
        }
      } else if (tool === 'audio' && subTab) {
        if (subTab === 'mixer' || subTab === 'voice' || subTab === 'script') {
          updateToolMemory({ audioTab: subTab });
        }
      } else if (tool === 'captions' && subTab) {
        if (
          subTab === 'templates' ||
          subTab === 'style' ||
          subTab === 'fonts' ||
          subTab === 'modes' ||
          subTab === 'segments'
        ) {
          updateToolMemory({ captionsTab: subTab });
        }
      }
      setInspectorTool(tool);
      setActiveTool(tool);
    },
    [updateToolMemory]
  );

  // Persist active project ID and active view in localStorage whenever changed
  const updateActiveProjectId = useCallback((id: string | null) => {
    setActiveProjectId(id);
    activeProjectIdRef.current = id;
    try {
      if (id) {
        window.localStorage.setItem('recap_studio_last_active_project_id', id);
      } else {
        window.localStorage.removeItem('recap_studio_last_active_project_id');
      }
    } catch {
      // ignore
    }
    syncBrowserUrl(activeViewRef.current, { projectId: id, replace: true });
  }, []);

  const handleSelectProject = useCallback(
    (project: Project, navigateTo?: NavPage, opts?: { preserveView?: boolean }) => {
      if (!project || !project.id) return;
      const previousProjectId = activeProjectIdRef.current;
      if (previousProjectId && previousProjectId !== project.id) {
        void flushPendingSaves(previousProjectId);
      }
      videoRef.current?.pause();
      handleProjectUpdated(project);
      updateActiveProjectId(project.id);
      setCurrentTime(0);
      setSelectedBlurId(project.blurs?.[0]?.id || null);
      setSelectedLogoId(project.logos?.[0]?.id || null);
      setSelectedElement(null);
      setDrawMode('none');
      setCropEditMode(false);
      setMoreMenuOpen(false);

      if (opts?.preserveView && !navigateTo) {
        const currentView = activeViewRef.current;
        if (currentView !== 'projects') {
          updateActiveView(currentView, { projectId: project.id });
          return;
        }
      }

      if (navigateTo === 'dashboard') {
        updateActiveView('projects');
        setActiveTool(null);
        return;
      }

      if (navigateTo === 'settings') {
        openSettingsPage();
        return;
      }

      if (navigateTo === 'styles') {
        updateActiveView('styles');
        setActiveTool(null);
        return;
      }

      if (!project.sourceVideoUrl && !project.sourceVideoBlobKey && !navigateTo) {
        updateActiveView('projects');
        setActiveTool(null);
        return;
      }

      if (navigateTo === 'export') {
        setActiveTool(null);
        updateActiveView('export', { projectId: project.id });
        return;
      }

      if (navigateTo === 'translator') {
        setActiveTool(null);
        updateActiveView('translator', { projectId: project.id });
        return;
      }

      if (navigateTo === 'voice') {
        setActiveTool(null);
        updateActiveView('voice', { projectId: project.id });
        return;
      }

      if (
        navigateTo === 'editor' ||
        navigateTo === 'captions' ||
        navigateTo === 'blur' ||
        navigateTo === 'branding'
      ) {
        updateActiveView('editor', { projectId: project.id });
        if (navigateTo === 'captions') {
          handleOpenTool('captions', 'style');
        } else if (navigateTo === 'blur') {
          handleOpenTool('blur');
        } else if (navigateTo === 'branding') {
          handleOpenTool('overlay');
        } else {
          setActiveTool(null);
        }
        return;
      }

      // Default routing: Step 1 (Translation Studio) -> Step 2 (Voice Studio) -> Step 3 (Video Editor)
      const ready = validateProjectReadyForEditor(project);
      const alreadyValidated =
        ready.valid &&
        Boolean(project.voice?.enabled) &&
        Boolean(project.workflow?.completedStages?.includes('voice'));

      if (alreadyValidated || project.workflow?.completedStages?.includes('editor')) {
        updateActiveView('editor', { projectId: project.id });
        setActiveTool(null);
      } else if (ready.translationValid) {
        updateActiveView('voice', { projectId: project.id });
        setActiveTool(null);
      } else {
        updateActiveView('translator', { projectId: project.id });
        setActiveTool(null);
      }
    },
    [flushPendingSaves, handleOpenTool, handleProjectUpdated, openSettingsPage, updateActiveProjectId, updateActiveView]
  );

  const handleValidatedContinue = useCallback(
    (validatedProject: Project) => {
      videoRef.current?.pause();
      handleProjectUpdated(validatedProject);
      setCurrentTime(0);
      setSelectedElement(null);
      setActiveTool(null);
      updateActiveView('editor');
      showNotice(
        `Loaded video, narration audio (${validatedProject.voice.generatedClips.length} clips), and timing into Editor.`
      );
    },
    [handleProjectUpdated, showNotice, updateActiveView]
  );

  const handleSeek = useCallback((t: number) => {
    setCurrentTime(t);
    if (videoRef.current) {
      videoRef.current.currentTime = t;
    }
  }, []);

  const handleFinishDrawBox = async (box: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => {
    if (!activeProject) return;
    const targetId = selectedBlurId || activeProject.blurs[0]?.id;
    if (!targetId) return;

    setDrawMode('none');
    commitProjectPatch(
      activeProject.id,
      (cur) => ({
        blurs: cur.blurs.map((b) =>
          b.id === targetId ? { ...b, ...box, keyframes: undefined } : b
        ),
        workflow: createWorkflowUpdate(cur.workflow, {
          completeStage: 'editor',
          modifiedStage: 'editor',
          hasExistingExport: Boolean(cur.lastExportUrl),
        }),
      }),
      { immediate: true }
    );
  };

  const handleInteractiveLogoUpdate = useCallback(
    (logoId: string, patch: Partial<LogoOverlay>) => {
      if (!activeProject) return;
      commitProjectPatch(
        activeProject.id,
        (cur) => ({
          logos: cur.logos.map((l) => (l.id === logoId ? { ...l, ...patch } : l)),
          workflow: createWorkflowUpdate(cur.workflow, {
            completeStage: 'editor',
            modifiedStage: 'editor',
            hasExistingExport: Boolean(cur.lastExportUrl),
          }),
        }),
        { undoGroupKey: `logo:${logoId}`, debounceMs: 220 }
      );
    },
    [activeProject, commitProjectPatch]
  );

  const handleInteractiveBlurUpdate = useCallback(
    (blurId: string, patch: Partial<BlurEffect>) => {
      if (!activeProject) return;
      setSelectedBlurId(blurId);
      const geometryChanged =
        'x' in patch || 'y' in patch || 'width' in patch || 'height' in patch;
      commitProjectPatch(
        activeProject.id,
        (cur) => ({
          blurs: cur.blurs.map((b) =>
            b.id === blurId
              ? {
                  ...b,
                  ...patch,
                  keyframes: geometryChanged ? undefined : b.keyframes,
                }
              : b
          ),
          workflow: createWorkflowUpdate(cur.workflow, {
            completeStage: 'editor',
            modifiedStage: 'editor',
            hasExistingExport: Boolean(cur.lastExportUrl),
          }),
        }),
        { undoGroupKey: `blur:${blurId}`, debounceMs: 220 }
      );
    },
    [activeProject, commitProjectPatch]
  );

  const handleInteractiveSubtitleStyleUpdate = useCallback(
    (patch: Partial<SubtitleStyle>, opts?: { undoGroupKey?: string; immediate?: boolean }) => {
      if (!activeProject) return;
      commitProjectPatch(
        activeProject.id,
        (cur) => ({
          subtitleStyle: { ...cur.subtitleStyle, ...patch },
          workflow: createWorkflowUpdate(cur.workflow, {
            visitStage: 'captions',
            modifiedStage: 'captions',
            hasExistingExport: Boolean(cur.lastExportUrl),
          }),
        }),
        {
          undoGroupKey: opts?.undoGroupKey ?? 'subtitleStyle:interactive',
          immediate: opts?.immediate,
          debounceMs: opts?.immediate ? 0 : 220,
        }
      );
    },
    [activeProject, commitProjectPatch]
  );

  const handleInteractiveCanvasUpdate = useCallback(
    (patch: Partial<VideoCanvasConfig>, opts?: { immediate?: boolean; undoGroupKey?: string }) => {
      if (!activeProject) return;
      const onlyGuidesToggle =
        Object.keys(patch).length === 1 && 'showEditingGuides' in patch;
      commitProjectPatch(
        activeProject.id,
        (cur) => ({
          canvas: {
            ...DEFAULT_VIDEO_CANVAS,
            ...(cur.canvas || {}),
            ...patch,
          },
          ...(onlyGuidesToggle
            ? {}
            : {
                workflow: createWorkflowUpdate(cur.workflow, {
                  completeStage: 'editor',
                  modifiedStage: 'editor',
                  hasExistingExport: Boolean(cur.lastExportUrl),
                }),
              }),
        }),
        {
          immediate: opts?.immediate,
          debounceMs: opts?.immediate ? 0 : 220,
          undoGroupKey: onlyGuidesToggle ? undefined : opts?.undoGroupKey ?? 'canvas:interactive',
          recordUndo: !onlyGuidesToggle,
        }
      );
    },
    [activeProject, commitProjectPatch]
  );

  const handleAspectRatioChange = useCallback(
    (ratio: CanvasAspectRatio) => {
      if (!activeProject) return;
      commitProjectPatch(
        activeProject.id,
        (cur) => ({
          canvas: {
            ...DEFAULT_VIDEO_CANVAS,
            ...(cur.canvas || {}),
            aspectRatio: ratio,
          },
          exportSettings: { ...cur.exportSettings, aspectRatio: ratio },
          workflow: createWorkflowUpdate(cur.workflow, {
            completeStage: 'editor',
            modifiedStage: 'editor',
            hasExistingExport: Boolean(cur.lastExportUrl),
          }),
        }),
        { immediate: true }
      );
    },
    [activeProject, commitProjectPatch]
  );

  // Contextual Element Actions (shared by Sub-Toolbar, Edit Sheet, and Keyboard Shortcuts)
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

    // Duplicate selected caption segment or active synced caption segment at playhead
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
          origClips.find((c) => currentTime >= c.timelineStart && currentTime <= c.timelineStart + Math.max(0.1, c.sourceEnd - c.sourceStart)) ||
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
  }, [activeProject, commitProjectPatch, currentTime, handleProjectUpdated, selectedElement, showNotice]);

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
      showNotice('Select a video clip, audio clip, blur, overlay, filter, effect, text layer, or caption segment to split.');
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

  // Global Keyboard Shortcuts (Undo/Redo, Delete, Duplicate, Arrow Nudge) using stable listener ref
  const keydownHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keydownHandlerRef.current = (e: KeyboardEvent) => {
    if (!activeProject) return;
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    ) {
      return;
    }

    const meta = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();

    if (meta && key === 'z' && !e.shiftKey) {
      e.preventDefault();
      handleUndo();
      return;
    }
    if ((meta && key === 'z' && e.shiftKey) || (meta && key === 'y')) {
      e.preventDefault();
      handleRedo();
      return;
    }

    if (activeView !== 'editor') return;

    if (meta && key === 'd' && selectedElement) {
      e.preventDefault();
      handleDuplicateSelected();
      return;
    }

    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedElement) {
      e.preventDefault();
      handleDeleteSelected();
      return;
    }

    if (
      ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) &&
      selectedElement
    ) {
      e.preventDefault();
      const mult = e.shiftKey ? 3 : 1;
      const dxNorm =
        e.key === 'ArrowRight' ? 0.01 * mult : e.key === 'ArrowLeft' ? -0.01 * mult : 0;
      const dyNorm =
        e.key === 'ArrowDown' ? 0.01 * mult : e.key === 'ArrowUp' ? -0.01 * mult : 0;
      const dxPct = e.key === 'ArrowRight' ? 1 * mult : e.key === 'ArrowLeft' ? -1 * mult : 0;
      const dyPct = e.key === 'ArrowDown' ? 1 * mult : e.key === 'ArrowUp' ? -1 * mult : 0;

      if (selectedElement.kind === 'blur') {
        const orig = activeProject.blurs.find((b) => b.id === selectedElement.id);
        if (orig && !orig.locked) {
          handleInteractiveBlurUpdate(orig.id, {
            x: Math.max(0, Math.min(1 - orig.width, Number((orig.x + dxNorm).toFixed(4)))),
            y: Math.max(0, Math.min(1 - orig.height, Number((orig.y + dyNorm).toFixed(4)))),
          });
        }
      } else if (selectedElement.kind === 'logo') {
        const orig = activeProject.logos.find((l) => l.id === selectedElement.id);
        if (orig && !orig.locked) {
          handleInteractiveLogoUpdate(orig.id, {
            x: Math.max(0, Math.min(0.95, Number((orig.x + dxNorm).toFixed(4)))),
            y: Math.max(0, Math.min(0.95, Number((orig.y + dyNorm).toFixed(4)))),
            presetPosition: 'custom',
          });
        }
      } else if (selectedElement.kind === 'captions') {
        if (!activeProject.subtitleStyle.locked) {
          handleInteractiveSubtitleStyleUpdate({
            position: 'custom',
            posX: Math.max(5, Math.min(95, (activeProject.subtitleStyle.posX ?? 50) + dxPct)),
            posY: Math.max(5, Math.min(95, (activeProject.subtitleStyle.posY ?? 84) + dyPct)),
          });
        }
      } else if (selectedElement.kind === 'caption-element') {
        const orig = (activeProject.subtitleStyle.extraElements || []).find(
          (el) => el.id === selectedElement.id
        );
        if (orig && !orig.locked) {
          const nextEls = (activeProject.subtitleStyle.extraElements || []).map((el) =>
            el.id === orig.id
              ? {
                  ...el,
                  style: {
                    ...el.style,
                    position: 'custom' as const,
                    posX: Math.max(5, Math.min(95, (el.style.posX ?? 50) + dxPct)),
                    posY: Math.max(5, Math.min(95, (el.style.posY ?? 22) + dyPct)),
                  },
                }
              : el
          );
          handleInteractiveSubtitleStyleUpdate({ extraElements: nextEls });
        }
      } else if (selectedElement.kind === 'video') {
        const cv = { ...DEFAULT_VIDEO_CANVAS, ...(activeProject.canvas || {}) };
        if (!cv.videoLocked) {
          handleInteractiveCanvasUpdate({
            offsetX: Math.max(-100, Math.min(100, cv.offsetX + dxPct)),
            offsetY: Math.max(-100, Math.min(100, cv.offsetY + dyPct)),
          });
        }
      } else if (selectedElement.kind === 'bg-image') {
        const cv = { ...DEFAULT_VIDEO_CANVAS, ...(activeProject.canvas || {}) };
        if (!cv.bgImageLocked) {
          handleInteractiveCanvasUpdate({
            bgImageOffsetX: Math.max(-50, Math.min(50, cv.bgImageOffsetX + dxPct)),
            bgImageOffsetY: Math.max(-50, Math.min(50, cv.bgImageOffsetY + dyPct)),
          });
        }
      }
    }
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => keydownHandlerRef.current(e);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Clear draw/crop modes cleanly when leaving blur or edit tool
  useEffect(() => {
    const activeEffectiveTool = activeTool ?? inspectorTool;
    if (activeEffectiveTool !== 'blur' && drawMode !== 'none') {
      setDrawMode('none');
    }
    if (activeEffectiveTool !== 'edit' && cropEditMode) {
      setCropEditMode(false);
    }
  }, [activeTool, inspectorTool, drawMode, cropEditMode]);

  const activeToolMeta = activeTool ? TOOL_DOCK_ITEMS.find((t) => t.id === activeTool) : null;

  const currentPipelineStep: PipelineStepId =
    activeView === 'translator'
      ? 'translator'
      : activeView === 'voice'
      ? 'voice'
      : activeView === 'export'
      ? 'export'
      : activeView === 'styles'
      ? 'styles'
      : 'editor';

  const pipelineSteps = useMemo(
    () => getPipelineSteps(activeProject, currentPipelineStep),
    [activeProject, currentPipelineStep]
  );

  const handleSelectPipelineStep = useCallback(
    async (step: PipelineStepId) => {
      videoRef.current?.pause();
      setMoreMenuOpen(false);
      if (!activeProject) return;
      await flushPendingSaves(activeProject.id);
      if (step === 'translator') {
        setActiveTool(null);
        updateActiveView('translator', { projectId: activeProject.id });
        return;
      }
      if (step === 'voice') {
        setActiveTool(null);
        updateActiveView('voice', { projectId: activeProject.id });
        return;
      }
      if (step === 'editor') {
        const check = validateProjectReadyForEditor(activeProject);
        const isValidated =
          check.valid &&
          Boolean(activeProject.voice?.enabled) &&
          Boolean(activeProject.workflow?.completedStages?.includes('voice'));
        if (!isValidated) {
          setActiveTool(null);
          updateActiveView(check.translationValid ? 'voice' : 'translator', {
            projectId: activeProject.id,
          });
          showNotice(
            check.errors[0] ||
              'Complete Translation & Voice Studio and click VALIDATE & CONTINUE TO VIDEO EDITOR first.'
          );
          return;
        }
        setActiveTool(null);
        updateActiveView('editor', { projectId: activeProject.id });
        return;
      }
      if (step === 'export') {
        setActiveTool(null);
        updateActiveView('export', { projectId: activeProject.id });
        return;
      }
      if (step === 'styles') {
        setActiveTool(null);
        updateActiveView('styles');
      }
    },
    [activeProject, flushPendingSaves, showNotice, updateActiveView]
  );

  return (
    <div className="h-dvh w-screen overflow-hidden bg-[#09090B] text-zinc-100 flex flex-col">
      {/* Compact CapCut-Style Top Bar */}
      <header className="h-13 px-2.5 sm:px-4 border-b border-white/[0.08] bg-[#0B0B0F] flex items-center justify-between gap-2 shrink-0 z-30">
        <div className="flex items-center gap-1.5 sm:gap-2.5 min-w-0">
          {activeView !== 'projects' ? (
            <button
              type="button"
              onClick={async () => {
                videoRef.current?.pause();
                setActiveTool(null);
                if (activeProject?.id) {
                  await flushPendingSaves(activeProject.id);
                }
                if (activeView === 'settings') {
                  updateActiveView(
                    settingsReturnView !== 'projects' && !activeProject
                      ? 'projects'
                      : settingsReturnView,
                    { projectId: activeProject?.id }
                  );
                } else if (activeView === 'export') {
                  updateActiveView('editor', { projectId: activeProject?.id });
                } else if (activeView === 'editor') {
                  updateActiveView('voice', { projectId: activeProject?.id });
                } else if (activeView === 'voice') {
                  updateActiveView('translator', { projectId: activeProject?.id });
                } else {
                  updateActiveView('projects');
                }
              }}
              className="min-w-[38px] min-h-[38px] p-1.5 rounded-xl text-zinc-200 hover:text-white hover:bg-white/[0.06] flex items-center justify-center cursor-pointer shrink-0"
              aria-label="Go Back"
              title={
                activeView === 'settings'
                  ? 'Back'
                  : activeView === 'export'
                  ? 'Back to Video Editor'
                  : activeView === 'editor'
                  ? 'Back to Voice Studio'
                  : activeView === 'voice'
                  ? 'Back to Translation Studio'
                  : 'Back to Projects'
              }
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
          ) : (
            activeProject && (
              <button
                type="button"
                onClick={() => handleSelectProject(activeProject)}
                className="min-h-[36px] px-2.5 py-1.5 rounded-xl bg-violet-600/20 hover:bg-violet-600/30 border border-violet-500/40 text-xs font-semibold text-violet-200 whitespace-nowrap shrink-0 cursor-pointer"
              >
                Continue Project
              </button>
            )
          )}

          <button
            type="button"
            onClick={async () => {
              videoRef.current?.pause();
              setActiveTool(null);
              if (activeProject?.id) {
                await flushPendingSaves(activeProject.id);
              }
              updateActiveView('projects');
            }}
            className="flex items-center gap-1.5 text-sm sm:text-base font-display font-bold tracking-tight whitespace-nowrap cursor-pointer"
          >
            <span className="text-white">RECAP</span>
            <span className="text-violet-400">STUDIO AI</span>
          </button>

          {activeView !== 'projects' && activeProject && projects.length > 0 && (
            <div className="hidden md:flex items-center gap-2 ml-1 pl-2 border-l border-white/[0.08] min-w-0">
              <select
                value={activeProject.id}
                onChange={(e) => {
                  const found = projects.find((p) => p.id === e.target.value);
                  if (found) handleSelectProject(found, undefined, { preserveView: true });
                }}
                className="bg-[#141419] border border-white/[0.08] rounded-lg px-2 py-1 text-xs text-zinc-200 font-medium truncate max-w-[200px] focus:outline-none focus:border-violet-500 cursor-pointer"
                aria-label="Switch active project"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id} className="bg-[#111115] text-zinc-100">
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 sm:gap-2 shrink-0">
          {/* Visible Auto-Save Status Indicator */}
          {activeProject && activeView !== 'projects' && (
            <div
              role="status"
              aria-live="polite"
              data-save-status={saveStatus}
              title={
                saveStatus === 'error'
                  ? saveError || 'Save failed — click Retry'
                  : saveStatus === 'saving' || hasUnsavedChanges
                  ? 'Saving changes automatically...'
                  : lastSavedAt
                  ? `All changes saved (${new Date(lastSavedAt).toLocaleTimeString()})`
                  : 'All changes saved'
              }
              className={`flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-lg border text-[11px] font-medium whitespace-nowrap shrink-0 transition-colors ${
                saveStatus === 'error'
                  ? 'bg-red-500/15 border-red-500/40 text-red-200'
                  : saveStatus === 'saving' || hasUnsavedChanges
                  ? 'bg-amber-500/10 border-amber-500/30 text-amber-200'
                  : 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
              }`}
            >
              {saveStatus === 'error' ? (
                <>
                  <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                  <span>Save failed</span>
                  <button
                    type="button"
                    onClick={() => void flushPendingSaves(activeProject.id)}
                    className="ml-1 px-1.5 py-0.5 rounded bg-red-500/30 hover:bg-red-500/45 text-white text-[10px] font-semibold cursor-pointer"
                  >
                    Retry
                  </button>
                </>
              ) : saveStatus === 'saving' || hasUnsavedChanges ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-300 shrink-0" />
                  <span className="hidden xs:inline">Saving...</span>
                </>
              ) : (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span className="hidden xs:inline">Saved</span>
                </>
              )}
            </div>
          )}

          {activeView === 'editor' && activeProject && (
            <>
              <button
                type="button"
                onClick={handleUndo}
                disabled={undoStack.length === 0}
                title="Undo (Ctrl+Z)"
                aria-label="Undo"
                className="min-w-[38px] min-h-[38px] p-1.5 rounded-xl text-zinc-300 hover:text-white hover:bg-white/[0.06] disabled:opacity-30 flex items-center justify-center cursor-pointer"
              >
                <Undo2 className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={handleRedo}
                disabled={redoStack.length === 0}
                title="Redo (Ctrl+Shift+Z)"
                aria-label="Redo"
                className="min-w-[38px] min-h-[38px] p-1.5 rounded-xl text-zinc-300 hover:text-white hover:bg-white/[0.06] disabled:opacity-30 flex items-center justify-center cursor-pointer"
              >
                <Redo2 className="w-4 h-4" />
              </button>
            </>
          )}

          {activeView === 'projects' && (
            <button
              type="button"
              onClick={() => setCloudModalOpen(true)}
              title="Local Storage, Cache & Portable Backup"
              aria-label="Local Storage and Backup"
              className="min-w-[40px] min-h-[38px] px-2.5 sm:px-3 py-1.5 rounded-xl bg-zinc-900/90 hover:bg-zinc-800 border border-white/[0.08] text-xs font-medium text-zinc-200 flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <Archive className="w-4 h-4 text-emerald-400 shrink-0" />
              <span className="hidden sm:inline whitespace-nowrap">Backup</span>
            </button>
          )}

          {activeView === 'editor' && activeProject && (
            <>
              <button
                type="button"
                onClick={() => setSaveStyleModalOpen(true)}
                title="Save Current Style"
                className="min-h-[38px] px-2.5 sm:px-3 py-1.5 rounded-xl bg-zinc-900/90 hover:bg-zinc-800 border border-white/[0.08] text-xs font-medium text-zinc-200 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <BookmarkPlus className="w-3.5 h-3.5 text-violet-400 shrink-0" />
                <span className="hidden md:inline">Save Style</span>
              </button>
              <button
                type="button"
                onClick={() => setMyStylesModalOpen(true)}
                title="My Styles / Saved Presets"
                className="min-h-[38px] px-2.5 sm:px-3 py-1.5 rounded-xl bg-zinc-900/90 hover:bg-zinc-800 border border-white/[0.08] text-xs font-medium text-zinc-200 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Layers className="w-3.5 h-3.5 text-violet-400 shrink-0" />
                <span className="hidden md:inline">My Styles</span>
              </button>
            </>
          )}

          {activeView === 'editor' && activeProject && (
            <button
              type="button"
              onClick={async () => {
                videoRef.current?.pause();
                setActiveTool(null);
                setMoreMenuOpen(false);
                await flushPendingSaves(activeProject.id);
                updateActiveView('export', { projectId: activeProject.id });
              }}
              disabled={!activeProject.sourceVideoUrl && !activeProject.sourceVideoBlobKey}
              className="min-h-[38px] px-3 sm:px-4 py-1.5 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs sm:text-sm font-semibold text-white flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer shadow-lg shadow-violet-600/25"
            >
              <Upload className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              <span>Export</span>
            </button>
          )}

          {activeView === 'export' && activeProject && (
            <button
              type="button"
              onClick={async () => {
                await flushPendingSaves(activeProject.id);
                updateActiveView('editor', { projectId: activeProject.id });
              }}
              className="min-h-[38px] px-3 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-white/[0.08] text-xs font-semibold text-zinc-200 whitespace-nowrap shrink-0 cursor-pointer"
            >
              Back to Editor
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              if (activeView === 'settings') {
                updateActiveView(
                  settingsReturnView !== 'projects' && !activeProject
                    ? 'projects'
                    : settingsReturnView,
                  { projectId: activeProject?.id }
                );
              } else {
                openSettingsPage();
              }
            }}
            title="Settings"
            aria-label="Settings"
            aria-current={activeView === 'settings' ? 'page' : undefined}
            className={`min-w-[38px] min-h-[38px] px-2.5 sm:px-3 py-1.5 rounded-xl border text-xs font-medium flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
              activeView === 'settings'
                ? 'bg-violet-600/20 border-violet-500/50 text-violet-200'
                : 'bg-zinc-900/90 hover:bg-zinc-800 border-white/[0.08] text-zinc-300 hover:text-white'
            }`}
          >
            <Settings className="w-4 h-4 shrink-0" />
            <span className="hidden sm:inline">Settings</span>
          </button>
        </div>
      </header>

      {/* 5-Step Pipeline Progress Bar */}
      {activeView !== 'projects' && activeView !== 'settings' && activeProject && (
        <WorkflowStepperBar
          steps={pipelineSteps}
          onSelectStep={handleSelectPipelineStep}
          compact={activeView === 'editor'}
        />
      )}

      {/* Preset Warnings Banner */}
      {presetWarnings.length > 0 && (
        <div className="px-3 sm:px-4 py-1.5 bg-amber-500/15 border-b border-amber-500/30 flex items-center justify-between gap-2 text-xs text-amber-200 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="truncate">
              Missing preset asset(s):{' '}
              {presetWarnings
                .map(
                  (w) =>
                    `${w.presetName} (${w.missingAssets.map((a) => a.label).join(', ')})`
                )
                .join(' · ')}{' '}
              — re-upload inside Overlay / Fonts.
            </span>
          </div>
          <button
            type="button"
            onClick={() => setPresetWarnings([])}
            className="p-1 text-amber-300 hover:text-white shrink-0 cursor-pointer"
            aria-label="Dismiss warning"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Subtle Contextual Feedback Notice with One-Click Undo */}
      {actionNotice && (
        <div className="px-3 sm:px-4 py-1 bg-violet-600/20 border-b border-violet-500/30 text-[11px] font-medium text-violet-100 flex items-center justify-center gap-3 shrink-0">
          <span>{actionNotice.text}</span>
          {actionNotice.allowUndo && undoStack.length > 0 && (
            <button
              type="button"
              onClick={() => {
                handleUndo();
                setActionNotice(null);
              }}
              className="px-2 py-0.5 rounded bg-violet-600 hover:bg-violet-500 text-white text-[10.5px] font-semibold cursor-pointer"
            >
              Undo
            </button>
          )}
        </div>
      )}

      {/* Main Content */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center gap-2 text-sm text-zinc-400">
          <Loader2 className="w-4 h-4 animate-spin text-violet-400" />
          Loading Studio workspace...
        </div>
      ) : activeView === 'settings' ? (
        <main className="flex-1 min-h-0 overflow-y-auto">
          <SettingsPage
            activeProject={activeProject}
            onProjectUpdated={handleProjectUpdated}
            onOpenBackupModal={() => setCloudModalOpen(true)}
            onSettingsUpdated={() => showNotice('Fish Audio API settings updated.')}
            initialTab={settingsInitialTab}
            onTabChange={(tab) => {
              setSettingsInitialTab(tab);
              syncBrowserUrl('settings', {
                settingsTab: tab,
                projectId: activeProjectIdRef.current,
              });
            }}
            onOpenSaveStyleDialog={() => setSaveStyleModalOpen(true)}
            onNotice={showNotice}
          />
        </main>
      ) : activeView === 'styles' ? (
        <main className="flex-1 min-h-0 overflow-y-auto">
          <SavedStylesPage
            activeProject={activeProject}
            onProjectUpdated={handleProjectUpdated}
            onOpenSaveStyleDialog={() => setSaveStyleModalOpen(true)}
            onNavigate={(page) => {
              if (activeProject) {
                handleSelectProject(activeProject, page);
              } else {
                updateActiveView(page === 'dashboard' ? 'projects' : (page as AppView));
              }
            }}
            onNotice={showNotice}
          />
        </main>
      ) : activeView === 'projects' ? (
        <main className="flex-1 min-h-0 overflow-y-auto">
          <DashboardPage
            projects={projects}
            activeProjectId={activeProjectId}
            recentJobs={recentJobs}
            onSelectProject={handleSelectProject}
            onRefreshProjects={loadWorkspaceData}
            onPresetWarnings={setPresetWarnings}
            onOpenCloudModal={() => setCloudModalOpen(true)}
            pendingSyncProjectIds={new Set(pendingOps.map((p) => p.projectId))}
          />
        </main>
      ) : !activeProject ? (
        <main className="flex-1 min-h-0 flex items-center justify-center p-6 bg-[#09090B]">
          <div className="max-w-md w-full p-8 rounded-2xl bg-[#111115] border border-white/[0.08] text-center space-y-4 shadow-2xl">
            <div className="w-12 h-12 rounded-xl bg-violet-600/20 border border-violet-500/30 flex items-center justify-center mx-auto text-violet-400">
              <Film className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-base font-display font-bold text-white">
                No Video Project Selected
              </h2>
              <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                Choose an existing project or import a new video to continue in{' '}
                <span className="text-zinc-200 font-semibold capitalize">{activeView}</span>.
              </p>
            </div>
            <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-2.5">
              <button
                type="button"
                onClick={() => updateActiveView('projects')}
                className="w-full sm:w-auto px-4 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white transition-colors cursor-pointer"
              >
                Go to Projects &amp; Import
              </button>
            </div>
          </div>
        </main>
      ) : activeView === 'translator' ? (
        <main className="flex-1 min-h-0 overflow-y-auto">
          <TranslatorPage
            project={activeProject}
            onProjectUpdated={handleProjectUpdated}
            onPatchProject={commitProjectPatch}
            onFlushSaves={flushPendingSaves}
            focusAudioOverflowSignal={focusTranslationOverflowSignal}
            onContinueToVoice={async (updatedProject) => {
              handleProjectUpdated(updatedProject);
              await flushPendingSaves(updatedProject.id);
              updateActiveView('voice', { projectId: updatedProject.id });
            }}
          />
        </main>
      ) : activeView === 'voice' ? (
        <main className="flex-1 min-h-0 overflow-y-auto">
          <VoiceStudioPage
            project={activeProject}
            onProjectUpdated={handleProjectUpdated}
            onPatchProject={commitProjectPatch}
            onFlushSaves={flushPendingSaves}
            onRequestTranslationShorten={() =>
              setFocusTranslationOverflowSignal((n) => n + 1)
            }
            onNavigate={async (page) => {
              await flushPendingSaves(activeProject.id);
              if (page === 'settings') {
                openSettingsPage();
                return;
              }
              handleSelectProject(activeProject, page);
            }}
            onValidatedContinue={async (validatedProject) => {
              handleProjectUpdated(validatedProject);
              await flushPendingSaves(validatedProject.id);
              handleValidatedContinue(validatedProject);
            }}
          />
        </main>
      ) : activeView === 'export' ? (
        <main className="flex-1 min-h-0 overflow-y-auto">
          <ExportCenterPage
            project={activeProject}
            onProjectUpdated={handleProjectUpdated}
            onPatchProject={commitProjectPatch}
            onFlushSaves={flushPendingSaves}
            customFonts={customFonts}
          />
        </main>
      ) : (
        <main className="flex-1 min-h-0 flex flex-col overflow-hidden bg-[#09090B]">
          {/* Upper Area: Video Preview Stage + Docked Desktop Contextual Inspector */}
          <div className="flex-1 min-h-[210px] flex overflow-hidden">
            {/* Area 1: Video Preview & Playback Controls */}
            <section
              aria-label="Video preview"
              className="flex-1 min-w-0 h-full overflow-hidden flex flex-col"
            >
              <VideoStudioPlayer
                variant="capcut"
                project={activeProject}
                currentTime={currentTime}
                onTimeUpdate={setCurrentTime}
                videoRef={videoRef}
                previewEffects={previewEffects}
                onTogglePreviewEffects={setPreviewEffects}
                drawMode={drawMode}
                onFinishDrawBox={handleFinishDrawBox}
                selectedLogoId={selectedLogoId}
                onUpdateLogo={handleInteractiveLogoUpdate}
                selectedBlurId={selectedBlurId}
                onUpdateBlur={handleInteractiveBlurUpdate}
                onUpdateSubtitleStyle={handleInteractiveSubtitleStyleUpdate}
                selectedElement={selectedElement}
                onSelectElement={handleSelectElement}
                onUpdateCanvas={handleInteractiveCanvasUpdate}
                customFonts={customFonts}
                cropEditMode={cropEditMode}
                onToggleCropEditMode={setCropEditMode}
                timelineExpanded={timelineExpanded}
                onToggleTimelineExpanded={() => setTimelineExpanded((v) => !v)}
                onAspectRatioChange={handleAspectRatioChange}
                onOpenSpeedEditor={() => handleOpenTool('edit', 'timing')}
              />
            </section>

            {/* Area 3 (Desktop): Docked Contextual Inspector */}
            <div className="hidden lg:flex w-[348px] xl:w-[392px] shrink-0 h-full border-l border-white/[0.08] overflow-hidden">
              <ContextualInspector
                variant="docked"
                project={activeProject}
                projectsCount={projects.length}
                allProjects={projects}
                activeTool={inspectorTool}
                onSelectTool={(tool, subTab) => {
                  if (tool === 'edit' && subTab) {
                    if (
                      subTab === 'transform' ||
                      subTab === 'timing' ||
                      subTab === 'background' ||
                      subTab === 'media'
                    ) {
                      updateToolMemory({ editTab: subTab });
                    }
                  } else if (tool === 'audio' && subTab) {
                    if (subTab === 'mixer' || subTab === 'voice' || subTab === 'script') {
                      updateToolMemory({ audioTab: subTab });
                    }
                  } else if (tool === 'captions' && subTab) {
                    if (
                      subTab === 'templates' ||
                      subTab === 'style' ||
                      subTab === 'fonts' ||
                      subTab === 'modes' ||
                      subTab === 'segments'
                    ) {
                      updateToolMemory({ captionsTab: subTab });
                    }
                  }
                  setInspectorTool(tool);
                }}
                selectedElement={selectedElement}
                onSelectElement={handleSelectElement}
                selectedBlurId={selectedBlurId}
                onSelectBlur={handleSelectBlurSynced}
                selectedLogoId={selectedLogoId}
                onSelectLogo={handleSelectLogoSynced}
                currentTime={currentTime}
                onSeek={handleSeek}
                videoRef={videoRef}
                previewEffects={previewEffects}
                onTogglePreviewEffects={setPreviewEffects}
                drawMode={drawMode}
                onSetDrawMode={setDrawMode}
                cropEditMode={cropEditMode}
                onToggleCropEditMode={setCropEditMode}
                customFonts={customFonts}
                onReloadCustomFonts={() => void reloadCustomFonts()}
                memory={toolMemory}
                onUpdateMemory={updateToolMemory}
                onProjectUpdated={handleProjectUpdated}
                onPatchProject={commitProjectPatch}
                onFlushSaves={flushPendingSaves}
                onUpdateCanvas={handleInteractiveCanvasUpdate}
                onUpdateSubtitleStyle={handleInteractiveSubtitleStyleUpdate}
                onSwitchProject={(found) => handleSelectProject(found, undefined, { preserveView: true })}
                onOpenBackup={() => setCloudModalOpen(true)}
                onOpenSettings={openSettingsPage}
                onShowNotice={showNotice}
                onSplitAtPlayhead={handleSplitAtPlayhead}
                onDuplicateSelected={handleDuplicateSelected}
                onDeleteSelected={handleDeleteSelected}
                onSubAction={handleSubAction}
              />
            </div>
          </div>

          {/* Desktop Resizable Horizontal Splitter */}
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize preview and timeline height"
            onPointerDown={handleTimelineSplitterDown}
            onDoubleClick={() => {
              setTimelineExpanded(false);
              setTimelineHeightPx(256);
            }}
            title="Drag to resize timeline height (double-click to reset)"
            className="hidden lg:flex h-2.5 bg-[#0A0A0E] hover:bg-violet-600/35 border-y border-white/[0.08] cursor-row-resize items-center justify-center group shrink-0 touch-none transition-colors"
          >
            <div className="w-12 h-1 rounded-full bg-white/20 group-hover:bg-violet-400 transition-colors" />
          </div>

          {/* Area 2: Resizable Multi-Track Timeline */}
          <div
            style={
              {
                '--tl-h': `${timelineExpanded ? 390 : timelineHeightPx}px`,
              } as React.CSSProperties
            }
            className={`${
              timelineExpanded ? 'h-[320px] sm:h-[360px]' : 'h-[235px] sm:h-[260px]'
            } lg:h-[var(--tl-h)] shrink-0 overflow-hidden flex flex-col`}
          >
            <TimelineEditor
              project={activeProject}
              currentTime={currentTime}
              onSeek={handleSeek}
              onProjectUpdated={handleProjectUpdated}
              onPatchProject={commitProjectPatch}
              selectedElement={selectedElement}
              onSelectElement={handleSelectElement}
              onOpenTool={handleOpenTool}
              onRequestAddMedia={() => handleOpenTool('edit', 'media')}
              onSplitAtPlayhead={handleSplitAtPlayhead}
              onDuplicateSelected={handleDuplicateSelected}
              onDeleteSelected={handleDeleteSelected}
              expanded={timelineExpanded}
              onToggleExpanded={() => setTimelineExpanded((v) => !v)}
            />
          </div>

          {/* Mobile / Tablet (< lg) Compact Contextual Bar + Tool Launcher */}
          <div className="lg:hidden relative shrink-0 border-t border-white/[0.08] bg-[#0B0B10]">
            {moreMenuOpen && (
              <>
                <div
                  className="fixed inset-0 z-30"
                  onClick={() => setMoreMenuOpen(false)}
                />
                <div
                  role="menu"
                  aria-label="More studio actions"
                  className="absolute right-2 bottom-24 z-40 w-64 rounded-2xl bg-[#141419] border border-white/[0.12] shadow-2xl p-2 space-y-1 text-xs"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      handleOpenTool('edit', 'background');
                    }}
                    className="w-full min-h-[38px] px-2.5 py-1.5 rounded-xl hover:bg-white/[0.06] text-zinc-200 flex items-center gap-2 cursor-pointer"
                  >
                    <Palette className="w-3.5 h-3.5 text-violet-400" />
                    <span>Canvas &amp; Background Fill</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      handleOpenTool('edit', 'media');
                    }}
                    className="w-full min-h-[38px] px-2.5 py-1.5 rounded-xl hover:bg-white/[0.06] text-zinc-200 flex items-center gap-2 cursor-pointer"
                  >
                    <Film className="w-3.5 h-3.5 text-sky-400" />
                    <span>Replace Source Media</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const next = !Boolean(activeProject.subtitleStyle.showSafeGuides);
                      handleInteractiveSubtitleStyleUpdate({ showSafeGuides: next }, { immediate: true });
                      showNotice(next ? 'Safe guides enabled.' : 'Safe guides hidden.');
                      setMoreMenuOpen(false);
                    }}
                    className="w-full min-h-[38px] px-2.5 py-1.5 rounded-xl hover:bg-white/[0.06] text-zinc-200 flex items-center justify-between gap-2 cursor-pointer"
                  >
                    <span className="flex items-center gap-2">
                      <ShieldCheck className="w-3.5 h-3.5 text-amber-400" />
                      <span>Safe Area Guides</span>
                    </span>
                    {activeProject.subtitleStyle.showSafeGuides && (
                      <Check className="w-3.5 h-3.5 text-violet-400" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      openSettingsPage();
                    }}
                    className="w-full min-h-[38px] px-2.5 py-1.5 rounded-xl hover:bg-white/[0.06] text-zinc-200 flex items-center gap-2 cursor-pointer"
                  >
                    <Settings className="w-3.5 h-3.5 text-zinc-300" />
                    <span>Settings</span>
                  </button>
                </div>
              </>
            )}

            {/* Mobile Contextual Quick Actions */}
            <nav
              aria-label="Contextual actions"
              className="h-11 px-2 flex items-center gap-1 overflow-x-auto no-scrollbar border-b border-white/[0.06]"
            >
              {contextualSubToolbarItems.map(({ id, label, Icon, active }) => {
                const isCropActive = id === 'crop' && cropEditMode;
                const isMoreActive = id === 'more' && moreMenuOpen;
                const isHighlight = isCropActive || isMoreActive || Boolean(active);
                return (
                  <button
                    key={`${selectedElement?.kind || 'root'}-${id}`}
                    type="button"
                    onClick={() => handleSubAction(id)}
                    className={`min-h-[34px] px-2.5 rounded-lg flex items-center gap-1.5 text-[11px] font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                      isCropActive
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                        : isHighlight
                        ? 'bg-violet-600/20 text-violet-200 border border-violet-500/40'
                        : id === 'delete'
                        ? 'text-red-300 hover:bg-red-500/15'
                        : 'text-zinc-300 hover:text-white bg-[#14141B] border border-white/[0.06]'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5 shrink-0" />
                    <span>{label}</span>
                  </button>
                );
              })}
            </nav>

            {/* Mobile Tool Category Bar (>=44px touch targets) */}
            <nav
              aria-label="Studio editing categories"
              className="px-2 py-1.5 pb-safe flex items-center gap-1.5 overflow-x-auto no-scrollbar"
            >
              {TOOL_DOCK_ITEMS.map(({ id, label, Icon }) => {
                const isActive = activeTool === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      setInspectorTool(id);
                      setActiveTool((prev) => (prev === id ? null : id));
                    }}
                    className={`min-w-[58px] min-h-[44px] px-2.5 py-1 rounded-lg border flex flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                      isActive
                        ? 'bg-violet-600/25 border-violet-500 text-white'
                        : 'bg-[#141419] border-white/[0.08] text-zinc-300 hover:text-white'
                    }`}
                  >
                    <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-violet-300' : ''}`} />
                    <span>{label}</span>
                  </button>
                );
              })}
            </nav>
          </div>

          {/* Mobile Contextual Tool Drawer */}
          <div className="lg:hidden">
            <StudioBottomSheet
              open={activeTool !== null}
              title={activeTool ? TOOL_TITLES[activeTool] : ''}
              icon={activeToolMeta ? <activeToolMeta.Icon className="w-4 h-4" /> : undefined}
              onClose={() => {
                setActiveTool(null);
                setDrawMode('none');
                setCropEditMode(false);
              }}
            >
              {activeTool && (
                <ContextualInspector
                  variant="sheet"
                  project={activeProject}
                  projectsCount={projects.length}
                  allProjects={projects}
                  activeTool={activeTool}
                  onSelectTool={(tool, subTab) => handleOpenTool(tool, subTab)}
                  selectedElement={selectedElement}
                  onSelectElement={handleSelectElement}
                  selectedBlurId={selectedBlurId}
                  onSelectBlur={handleSelectBlurSynced}
                  selectedLogoId={selectedLogoId}
                  onSelectLogo={handleSelectLogoSynced}
                  currentTime={currentTime}
                  onSeek={handleSeek}
                  videoRef={videoRef}
                  previewEffects={previewEffects}
                  onTogglePreviewEffects={setPreviewEffects}
                  drawMode={drawMode}
                  onSetDrawMode={setDrawMode}
                  cropEditMode={cropEditMode}
                  onToggleCropEditMode={setCropEditMode}
                  customFonts={customFonts}
                  onReloadCustomFonts={() => void reloadCustomFonts()}
                  memory={toolMemory}
                  onUpdateMemory={updateToolMemory}
                  onProjectUpdated={handleProjectUpdated}
                  onPatchProject={commitProjectPatch}
                  onFlushSaves={flushPendingSaves}
                  onUpdateCanvas={handleInteractiveCanvasUpdate}
                  onUpdateSubtitleStyle={handleInteractiveSubtitleStyleUpdate}
                  onSwitchProject={(found) => handleSelectProject(found, undefined, { preserveView: true })}
                  onOpenBackup={() => setCloudModalOpen(true)}
                  onOpenSettings={openSettingsPage}
                  onShowNotice={showNotice}
                  onSplitAtPlayhead={handleSplitAtPlayhead}
                  onDuplicateSelected={handleDuplicateSelected}
                  onDeleteSelected={handleDeleteSelected}
                  onSubAction={handleSubAction}
                />
              )}
            </StudioBottomSheet>
          </div>
        </main>
      )}

      {/* Local Storage & Portable Backup Modal */}
      <LocalBackupModal
        open={cloudModalOpen}
        onClose={() => setCloudModalOpen(false)}
        activeProject={activeProject}
        onProjectUpdated={handleProjectUpdated}
        onRefreshProjects={loadWorkspaceData}
      />

      {/* Save Style Dialog */}
      <SaveStyleDialog
        open={saveStyleModalOpen}
        project={activeProject}
        videoRef={videoRef}
        onClose={() => setSaveStyleModalOpen(false)}
        onSaved={(style) => {
          showNotice(`Saved style "${style.name}" successfully.`);
        }}
      />

      {/* My Styles Modal */}
      {myStylesModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-3 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="my-styles-modal-title"
        >
          <div className="w-full max-w-4xl rounded-xl bg-[#111115] border border-white/[0.1] shadow-2xl overflow-hidden flex flex-col max-h-[92dvh]">
            <div className="px-5 py-4 border-b border-white/[0.08] flex items-center justify-between gap-3">
              <div>
                <h2 id="my-styles-modal-title" className="text-base font-display font-semibold text-white">
                  My Styles / Saved Presets
                </h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Apply or manage reusable filter, effect, caption, canvas & narrator presets.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setMyStylesModalOpen(false)}
                className="min-w-[38px] min-h-[38px] rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] flex items-center justify-center cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 overflow-y-auto flex-1">
              <MyStylesManager
                activeProject={activeProject}
                onProjectUpdated={handleProjectUpdated}
                onOpenSaveStyleDialog={() => {
                  setMyStylesModalOpen(false);
                  setSaveStyleModalOpen(true);
                }}
                onNotice={showNotice}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
