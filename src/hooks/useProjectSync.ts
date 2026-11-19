import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PendingSyncOp,
  Project,
  ProjectPatchFn,
  RenderJob,
  SavedFontAsset,
} from '../types/studio';
import { api } from '../lib/api';
import { indexedDbStore } from '../lib/indexedDbStore';
import {
  getCloudSession,
  getSupabaseClient,
  hydrateProjectAssetsFromCloud,
  queueDebouncedMetadataSync,
  subscribeToCloudProjectsRealtime,
} from '../lib/supabaseCloud';
import { cloneEditableSnapshot, snapshotsEqual, useUndoRedo } from './useUndoRedo';

interface ProjectPatchQueueEntry {
  pendingKeys: Set<keyof Project>;
  dirtySeq: Map<keyof Project, number>;
  inFlight: boolean;
  timerId: number | null;
  needsResend: boolean;
}

export type SaveStatus = 'saved' | 'saving' | 'offline' | 'error';

export function useProjectSync() {
  const projectsRef = useRef<Project[]>([]);
  const activeProjectIdRef = useRef<string | null>(null);
  const patchQueueRef = useRef<Map<string, ProjectPatchQueueEntry>>(new Map());
  const patchSeqRef = useRef(0);

  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [recentJobs, setRecentJobs] = useState<RenderJob[]>([]);
  const [customFonts, setCustomFonts] = useState<SavedFontAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [cloudUserId, setCloudUserId] = useState<string | null>(null);
  const [pendingOps, setPendingOps] = useState<PendingSyncOp[]>([]);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);

  projectsRef.current = projects;
  activeProjectIdRef.current = activeProjectId;

  const activeProject = projects.find((p) => p && p.id === activeProjectId) || null;

  const getQueueEntry = useCallback((projectId: string): ProjectPatchQueueEntry => {
    let entry = patchQueueRef.current.get(projectId);
    if (!entry) {
      entry = {
        pendingKeys: new Set(),
        dirtySeq: new Map(),
        inFlight: false,
        timerId: null,
        needsResend: false,
      };
      patchQueueRef.current.set(projectId, entry);
    }
    return entry;
  }, []);

  const applySnapshotToBackend = useCallback(
    async (project: Project, patch: Partial<Project>) => {
      const entry = getQueueEntry(project.id);
      if (entry.timerId !== null) {
        window.clearTimeout(entry.timerId);
        entry.timerId = null;
      }
      entry.pendingKeys.clear();
      entry.dirtySeq.clear();

      const nextProject: Project = { ...project, ...patch };
      const nextProjects = projectsRef.current.map((p) =>
        p.id === project.id ? nextProject : p
      );
      projectsRef.current = nextProjects;
      setProjects(nextProjects);
      setSaveStatus('saving');

      try {
        const { project: saved } = await api.updateProject(project.id, patch);
        if (saved && saved.id && entry.pendingKeys.size === 0) {
          const syncedList = projectsRef.current.map((p) => (p.id === saved.id ? saved : p));
          projectsRef.current = syncedList;
          setProjects(syncedList);
        }
        setSaveStatus('saved');
        setLastSavedAt(new Date().toISOString());
      } catch {
        setSaveStatus(navigator.onLine ? 'error' : 'offline');
      }
    },
    [getQueueEntry]
  );

  const undoRedo = useUndoRedo({
    activeProject,
    activeProjectId,
    onApplySnapshotToBackend: applySnapshotToBackend,
  });

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
    try {
      const [projRes, jobRes, fontRes] = await Promise.all([
        api.listProjects(),
        api.listAllJobs(),
        api.listCustomFonts().catch(() => ({ fonts: [] as SavedFontAsset[] })),
      ]);
      const validProjects = Array.isArray(projRes?.projects)
        ? projRes.projects.filter((p): p is Project => Boolean(p && p.id))
        : [];
      const validJobs = Array.isArray(jobRes?.jobs) ? jobRes.jobs : [];
      projectsRef.current = validProjects;
      setProjects(validProjects);
      void indexedDbStore.saveAllProjectSnapshots(validProjects);
      setRecentJobs(validJobs);
      if (Array.isArray(fontRes?.fonts)) {
        setCustomFonts(fontRes.fonts);
      }
      setActiveProjectId((prev) => {
        if (prev && validProjects.some((p) => p.id === prev)) return prev;
        return validProjects[0]?.id || null;
      });
      setSaveStatus('saved');
    } catch {
      const cached = await indexedDbStore.listProjectSnapshots();
      if (cached.length > 0) {
        projectsRef.current = cached;
        setProjects(cached);
        setActiveProjectId((prev) => prev || cached[0]?.id || null);
      }
      setSaveStatus(navigator.onLine ? 'error' : 'offline');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkspaceData();
    void refreshCloudAuth();
  }, [loadWorkspaceData, refreshCloudAuth]);

  useEffect(() => {
    const onOnline = () => {
      setSaveStatus('saved');
      void refreshPendingOps();
    };
    const onOffline = () => {
      setSaveStatus('offline');
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    const client = getSupabaseClient();
    const authSub = client?.auth.onAuthStateChange((_evt, session) => {
      setCloudUserId(session?.user?.id || null);
    });

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
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

  const flushProjectPatch = useCallback(
    async (projectId: string) => {
      const entry = getQueueEntry(projectId);
      if (entry.timerId !== null) {
        window.clearTimeout(entry.timerId);
        entry.timerId = null;
      }
      if (entry.inFlight) {
        entry.needsResend = true;
        return;
      }
      const keysToSend = Array.from(entry.pendingKeys);
      if (keysToSend.length === 0) return;
      entry.pendingKeys.clear();

      const latest = projectsRef.current.find((p) => p.id === projectId);
      if (!latest) return;

      const body: Partial<Project> = {};
      const sentSeq = new Map<keyof Project, number>();
      for (const k of keysToSend) {
        (body as Record<string, unknown>)[k] = latest[k];
        sentSeq.set(k, entry.dirtySeq.get(k) ?? 0);
      }

      entry.inFlight = true;
      entry.needsResend = false;
      setSaveStatus('saving');
      try {
        const { project: saved } = await api.updateProject(projectId, body);
        if (saved && saved.id) {
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
          setSaveStatus('saved');
          setLastSavedAt(new Date().toISOString());
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
            void refreshPendingOps();
          });
        }
      } catch {
        for (const k of keysToSend) {
          entry.pendingKeys.add(k);
        }
        setSaveStatus(navigator.onLine ? 'error' : 'offline');
      } finally {
        entry.inFlight = false;
        if (entry.needsResend || entry.pendingKeys.size > 0) {
          void flushProjectPatch(projectId);
        }
      }
    },
    [getQueueEntry, refreshPendingOps]
  );

  const commitProjectPatch = useCallback<ProjectPatchFn>(
    (projectId, updater, opts) => {
      const current = projectsRef.current.find((p) => p.id === projectId);
      if (!current) return;

      const patch = typeof updater === 'function' ? updater(current) : updater;
      const patchKeys = Object.keys(patch) as Array<keyof Project>;
      if (patchKeys.length === 0) return;

      const nextProject: Project = { ...current, ...patch };

      const shouldRecordUndo =
        opts?.recordUndo !== false &&
        !undoRedo.isUndoRedoApplyingRef.current &&
        projectId === activeProjectIdRef.current;

      if (shouldRecordUndo) {
        undoRedo.maybeRecordUndo(current, nextProject, opts?.undoGroupKey);
      }

      const nextProjects = projectsRef.current.map((p) =>
        p.id === projectId ? nextProject : p
      );
      projectsRef.current = nextProjects;
      setProjects(nextProjects);
      setSaveStatus('saving');

      const entry = getQueueEntry(projectId);
      const seq = ++patchSeqRef.current;
      for (const k of patchKeys) {
        entry.pendingKeys.add(k);
        entry.dirtySeq.set(k, seq);
      }

      if (entry.timerId !== null) {
        window.clearTimeout(entry.timerId);
        entry.timerId = null;
      }

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
    [flushProjectPatch, getQueueEntry, undoRedo]
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
        !undoRedo.isUndoRedoApplyingRef.current &&
        !undoRedo.activeUndoGroupRef.current
      ) {
        const prevSnap = cloneEditableSnapshot(existing);
        const nextSnap = cloneEditableSnapshot(updated);
        if (!snapshotsEqual(prevSnap, nextSnap)) {
          undoRedo.pushUndoSnapshot(existing);
        }
      }
      const entry = getQueueEntry(updated.id);
      const merged: Project = { ...updated };
      if (existing) {
        for (const k of entry.pendingKeys) {
          Object.assign(merged, { [k]: existing[k] });
        }
      }
      const nextProjects = existing
        ? safePrev.map((p) => (p.id === merged.id ? merged : p))
        : [merged, ...safePrev];
      projectsRef.current = nextProjects;
      setProjects(nextProjects);
      void indexedDbStore.saveProjectSnapshot(merged);
      setSaveStatus('saved');
      setLastSavedAt(new Date().toISOString());
      queueDebouncedMetadataSync(merged, (syncedProject) => {
        const nextList = projectsRef.current.map((p) =>
          p.id === syncedProject.id
            ? { ...p, cloudSync: syncedProject.cloudSync, cloudAssets: syncedProject.cloudAssets }
            : p
        );
        projectsRef.current = nextList;
        setProjects(nextList);
        void refreshPendingOps();
      });
    },
    [getQueueEntry, refreshPendingOps, undoRedo]
  );

  return {
    projects,
    activeProjectId,
    setActiveProjectId,
    activeProject,
    recentJobs,
    customFonts,
    loading,
    cloudUserId,
    pendingOps,
    saveStatus,
    lastSavedAt,
    loadWorkspaceData,
    reloadCustomFonts,
    refreshPendingOps,
    refreshCloudAuth,
    commitProjectPatch,
    handleProjectUpdated,
    undoStack: undoRedo.undoStack,
    redoStack: undoRedo.redoStack,
    handleUndo: undoRedo.handleUndo,
    handleRedo: undoRedo.handleRedo,
  };
}
