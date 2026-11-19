import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Archive,
  Database,
  HardDrive,
  Loader2,
  Trash2,
  Upload,
  WifiOff,
  X,
} from 'lucide-react';
import { Project } from '../types/studio';
import { api, LocalAssetManifestItem } from '../lib/api';
import { formatBytes } from '../lib/formatters';
import { indexedDbStore } from '../lib/indexedDbStore';
import { exportProjectBackupZip, importProjectBackupZip } from '../lib/projectBackup';
import { CollapsibleSection } from './ui/CollapsibleSection';

interface LocalBackupModalProps {
  open: boolean;
  onClose: () => void;
  activeProject: Project | null;
  onProjectUpdated: (p: Project) => void;
  onRefreshProjects: () => Promise<void>;
}

export function LocalBackupModal({
  open,
  onClose,
  activeProject,
  onProjectUpdated,
  onRefreshProjects,
}: LocalBackupModalProps) {
  const backupInputRef = useRef<HTMLInputElement>(null);

  const [busyMsg, setBusyMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [localUsage, setLocalUsage] = useState<{
    totalBytes: number;
    buckets: Record<string, { bytes: number; files: number }>;
  } | null>(null);
  const [idbUsage, setIdbUsage] = useState<{
    cachedProjects: number;
    pendingSyncCount: number;
    cachedMediaFiles: number;
    cachedMediaBytes: number;
  } | null>(null);
  const [manifest, setManifest] = useState<LocalAssetManifestItem[]>([]);

  const refreshDiagnostics = useCallback(async () => {
    try {
      const [loc, idb] = await Promise.all([
        api.getLocalStorageUsage().catch(() => null),
        indexedDbStore.getUsageSummary(),
      ]);
      if (loc) setLocalUsage(loc);
      setIdbUsage(idb);

      if (activeProject) {
        const mf = await api.getProjectAssetManifest(activeProject.id).catch(() => null);
        if (mf?.assets) {
          setManifest(mf.assets);
        }
      } else {
        setManifest([]);
      }
    } catch {
      // ignore
    }
  }, [activeProject]);

  useEffect(() => {
    if (!open) return;
    setErrorMsg(null);
    setStatusMsg(null);
    void refreshDiagnostics();
  }, [open, refreshDiagnostics]);

  if (!open) return null;

  const handleExportBackup = async () => {
    if (!activeProject) return;
    setErrorMsg(null);
    setStatusMsg(null);
    setBusyMsg('Creating portable project archive (.recapbackup.zip)...');
    try {
      const res = await exportProjectBackupZip(activeProject, (_pct, label) => setBusyMsg(label));
      setStatusMsg(
        `Exported ${res.filename} (${formatBytes(res.totalBytes)}, ${res.assetCount} asset(s)).`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMsg(null);
    }
  };

  const handleImportBackup = async (file: File) => {
    setErrorMsg(null);
    setStatusMsg(null);
    setBusyMsg('Restoring project backup...');
    try {
      const restored = await importProjectBackupZip(file, (_pct, label) => setBusyMsg(label));
      onProjectUpdated(restored);
      await onRefreshProjects();
      await refreshDiagnostics();
      setStatusMsg(`Restored "${restored.name}" from local backup archive.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMsg(null);
    }
  };

  const handleClearBrowserCache = async () => {
    await indexedDbStore.clearCachedMedia();
    await refreshDiagnostics();
    setStatusMsg('Cleared browser IndexedDB blob cache. Projects & local disk files unchanged.');
  };

  const handleRunCleanup = async () => {
    setBusyMsg('Cleaning expired temp files...');
    try {
      const res = await api.runCleanup();
      setStatusMsg(`Removed ${res.removedFiles} expired temporary file(s).`);
      await refreshDiagnostics();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMsg(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div className="w-full max-w-4xl max-h-[90vh] rounded-xl bg-[#111115] border border-white/[0.1] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-white/[0.08] flex items-center justify-between gap-4 shrink-0">
          <div>
            <h2 className="text-base font-display font-semibold text-white">
              Local Storage &amp; Backups
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Export or restore portable project archives and manage local cache.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] cursor-pointer shrink-0"
            aria-label="Close Backup Modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Notifications */}
        {(busyMsg || errorMsg || statusMsg) && (
          <div className="px-6 pt-4 space-y-2 shrink-0">
            {busyMsg && (
              <div className="p-3 rounded-lg bg-violet-600/10 border border-violet-500/30 text-xs text-violet-200 flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-violet-400 shrink-0" />
                <span>{busyMsg}</span>
              </div>
            )}
            {errorMsg && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-200">
                {errorMsg}
              </div>
            )}
            {statusMsg && !busyMsg && (
              <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-200">
                {statusMsg}
              </div>
            )}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Storage Accounting Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-4 rounded-lg bg-[#09090B] border border-white/[0.08] space-y-2">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span>Local Server Disk</span>
                <HardDrive className="w-3.5 h-3.5 text-violet-400" />
              </div>
              <div className="text-sm font-mono tabular-nums font-semibold text-white">
                {formatBytes(localUsage?.totalBytes ?? 0)}
              </div>
              <div className="text-[11px] font-mono tabular-nums text-zinc-500">
                SQLite DB + Local FFmpeg buckets
              </div>
            </div>

            <div className="p-4 rounded-lg bg-[#09090B] border border-white/[0.08] space-y-2">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span>IndexedDB Blob Cache</span>
                <WifiOff className="w-3.5 h-3.5 text-zinc-400" />
              </div>
              <div className="text-sm font-mono tabular-nums font-semibold text-white">
                {formatBytes(idbUsage?.cachedMediaBytes ?? 0)}
              </div>
              <div className="flex items-center justify-between text-[11px] text-zinc-500">
                <span className="font-mono tabular-nums">
                  {idbUsage?.cachedMediaFiles ?? 0} blob(s) cached
                </span>
                {(idbUsage?.cachedMediaFiles ?? 0) > 0 && (
                  <button
                    type="button"
                    onClick={() => void handleClearBrowserCache()}
                    className="text-violet-400 hover:text-violet-300 cursor-pointer"
                  >
                    Clear Cache
                  </button>
                )}
              </div>
            </div>

            <div className="p-4 rounded-lg bg-[#09090B] border border-white/[0.08] space-y-2">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span>Temp Cleanup</span>
                <Database className="w-3.5 h-3.5 text-emerald-400" />
              </div>
              <button
                type="button"
                onClick={() => void handleRunCleanup()}
                disabled={Boolean(busyMsg)}
                className="w-full mt-1 px-3 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-200 flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clean Expired Temp Files
              </button>
            </div>
          </div>

          {/* Active Project Backup & Export */}
          {activeProject ? (
            <div className="p-5 rounded-lg bg-[#09090B] border border-white/[0.08] space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h3 className="text-sm font-semibold text-white">
                    Active Project Archive: {activeProject.name}
                  </h3>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    Export this project and its media assets into a single portable <span className="font-mono text-zinc-200">.recapbackup.zip</span> file.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleExportBackup()}
                  disabled={Boolean(busyMsg)}
                  className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Archive className="w-4 h-4" />
                  Export Project Backup (.zip)
                </button>
              </div>

              {/* Manifest table (Collapsible) */}
              <CollapsibleSection
                title="Project Asset Manifest"
                badge={String(manifest.length)}
                defaultOpen={false}
              >
                {manifest.length === 0 ? (
                  <div className="p-2 text-xs text-zinc-500">No media assets attached yet.</div>
                ) : (
                  <div className="rounded-lg bg-[#111115] border border-white/[0.06] overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-white/[0.08] text-zinc-500">
                        <tr>
                          <th className="py-2 px-3 font-medium">Filename</th>
                          <th className="py-2 px-3 font-medium">Type</th>
                          <th className="py-2 px-3 font-medium text-right">Size</th>
                          <th className="py-2 px-3 font-medium">SHA-256</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.04]">
                        {manifest.map((item) => (
                          <tr key={item.localUrl}>
                            <td className="py-2 px-3 text-zinc-200 max-w-[220px] truncate">
                              {item.filename}
                            </td>
                            <td className="py-2 px-3 text-zinc-400 capitalize">{item.assetKind}</td>
                            <td className="py-2 px-3 text-right font-mono tabular-nums text-zinc-300">
                              {formatBytes(item.sizeBytes)}
                            </td>
                            <td className="py-2 px-3 font-mono text-zinc-500">
                              {item.sha256 ? item.sha256.slice(0, 12) : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CollapsibleSection>
            </div>
          ) : (
            <div className="p-5 rounded-lg bg-[#09090B] border border-white/[0.08] text-xs text-zinc-400">
              Select an active project on the Dashboard to export portable backup archives.
            </div>
          )}

          {/* Import Backup Archive */}
          <div className="p-5 rounded-lg bg-[#09090B] border border-white/[0.08] flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1 max-w-xl">
              <h3 className="text-sm font-semibold text-white">Import Project Archive (.zip)</h3>
              <p className="text-xs text-zinc-400">
                Restore any recap project and its underlying video, audio, logos, and fonts from a previously exported backup file.
              </p>
            </div>
            <div>
              <input
                ref={backupInputRef}
                type="file"
                accept=".zip,.recapbackup.zip"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleImportBackup(f);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => backupInputRef.current?.click()}
                disabled={Boolean(busyMsg)}
                className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-100 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Upload className="w-4 h-4 text-violet-400" />
                Import Backup Archive
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
