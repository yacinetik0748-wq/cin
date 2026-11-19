import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  CheckCircle2,
  Clock,
  Film,
  FolderOpen,
  Layers,
  Loader2,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import {
  DefaultStudioPreferences,
  NavPage,
  Project,
  RenderJob,
  StyleMissingVoiceWarning,
  StudioPreset,
} from '../types/studio';
import { api, ApiHttpError, isValidProjectId, PresetWarning, uploadVideoChunked } from '../lib/api';
import { formatBytes, formatDurationShort } from '../lib/formatters';
import { indexedDbStore } from '../lib/indexedDbStore';
import { importProjectBackupZip } from '../lib/projectBackup';
import { createWorkflowUpdate } from '../lib/workflowStages';
import { CollapsibleSection } from '../components/ui/CollapsibleSection';

interface DashboardPageProps {
  projects: Project[];
  activeProjectId: string | null;
  recentJobs: RenderJob[];
  onSelectProject: (project: Project, navigateTo?: NavPage) => void;
  onRefreshProjects: () => Promise<void>;
  onPresetWarnings?: (warnings: PresetWarning[]) => void;
  onOpenCloudModal?: () => void;
  pendingSyncProjectIds?: Set<string>;
}

export function DashboardPage({
  projects,
  activeProjectId,
  recentJobs,
  onSelectProject,
  onRefreshProjects,
  onPresetWarnings,
  onOpenCloudModal,
  pendingSyncProjectIds,
}: DashboardPageProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const backupImportRef = useRef<HTMLInputElement>(null);
  const [newName, setNewName] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [uploadStage, setUploadStage] = useState('');
  const [busySample, setBusySample] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [failedUploadState, setFailedUploadState] = useState<{
    file: File;
    code?: string;
    projectId?: string;
  } | null>(null);
  const [presetWarnings, setPresetWarnings] = useState<PresetWarning[]>([]);
  const [voiceMissingWarning, setVoiceMissingWarning] = useState<StyleMissingVoiceWarning | null>(null);
  const [presets, setPresets] = useState<StudioPreset[]>([]);
  const [savedStyles, setSavedStyles] = useState<StudioPreset[]>([]);
  const [defaultPrefs, setDefaultPrefs] = useState<DefaultStudioPreferences | null>(null);
  const [selectedStyleId, setSelectedStyleId] = useState<string>('none');
  const [captionPresetId, setCaptionPresetId] = useState<string>('none');
  const [filterPresetId, setFilterPresetId] = useState<string>('none');
  const [editingPresetId, setEditingPresetId] = useState<string>('none');
  const [applyingToActive, setApplyingToActive] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([
      api.listPresets().catch(() => null),
      api.listStyles().catch(() => null),
      api.getDefaultPreferences().catch(() => null),
    ]).then(([presetsRes, stylesRes, prefsRes]) => {
      if (!active) return;
      const list = Array.isArray(presetsRes?.presets) ? presetsRes.presets : [];
      setPresets(list);
      const defCap = list.find((p) => p.category === 'caption' && p.isDefault);
      const defFil = list.find((p) => p.category === 'filter' && p.isDefault);
      const defEdt = list.find((p) => p.category === 'editing' && p.isDefault);
      setCaptionPresetId(defCap ? defCap.id : 'none');
      setFilterPresetId(defFil ? defFil.id : 'none');
      setEditingPresetId(defEdt ? defEdt.id : 'none');

      const stList = Array.isArray(stylesRes?.styles) ? stylesRes.styles : [];
      setSavedStyles(stList);
      const p = prefsRes?.preferences || null;
      setDefaultPrefs(p);
      if (p?.autoApplyDefaultStyleOnImport && p.defaultStyleId) {
        const exists = stList.some((s) => s.id === p.defaultStyleId);
        setSelectedStyleId(exists ? p.defaultStyleId : 'none');
      } else {
        setSelectedStyleId('none');
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const captionPresets = presets.filter((p) => p.category === 'caption');
  const filterPresets = presets.filter((p) => p.category === 'filter');
  const editingPresets = presets.filter((p) => p.category === 'editing');

  const hasSelectedPreset =
    captionPresetId !== 'none' || filterPresetId !== 'none' || editingPresetId !== 'none';

  const handleResetPresetsToOriginal = () => {
    setCaptionPresetId('none');
    setFilterPresetId('none');
    setEditingPresetId('none');
  };

  const handleUseDefaults = () => {
    const defCap = captionPresets.find((p) => p.isDefault);
    const defFil = filterPresets.find((p) => p.isDefault);
    const defEdt = editingPresets.find((p) => p.isDefault);
    setCaptionPresetId(defCap ? defCap.id : 'none');
    setFilterPresetId(defFil ? defFil.id : 'none');
    setEditingPresetId(defEdt ? defEdt.id : 'none');
  };

  const getSelectedPresetOptions = () => ({
    captionPresetId,
    filterPresetId,
    editingPresetId,
    applyDefaults: false,
    styleId: selectedStyleId !== 'none' ? selectedStyleId : 'none',
    applyDefaultStyle: selectedStyleId !== 'none',
  });

  const handleReportWarnings = (
    warnings?: PresetWarning[],
    voiceWarn?: StyleMissingVoiceWarning | null
  ) => {
    const list = Array.isArray(warnings) ? warnings : [];
    setPresetWarnings(list);
    setVoiceMissingWarning(voiceWarn || null);
    if (list.length > 0) {
      onPresetWarnings?.(list);
    }
  };

  const handleApplyToActiveProject = async () => {
    if (!activeProjectId || (!hasSelectedPreset && selectedStyleId === 'none')) return;
    setErrorMsg(null);
    setApplyingToActive(true);
    try {
      let latestProject: Project | null = null;
      if (hasSelectedPreset) {
        const res = await api.applyPresetsToProject(
          activeProjectId,
          getSelectedPresetOptions()
        );
        latestProject = res.project;
        handleReportWarnings(res.presetWarnings);
      }
      if (selectedStyleId !== 'none') {
        const sRes = await api.applyStyleToProject(activeProjectId, selectedStyleId, 'all');
        latestProject = sRes.project;
        handleReportWarnings(sRes.warnings, sRes.voiceMissingWarning);
      }
      await onRefreshProjects();
      if (latestProject) onSelectProject(latestProject);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setApplyingToActive(false);
    }
  };

  const handleCreateAndUpload = async (file: File) => {
    setErrorMsg(null);
    setFailedUploadState(null);
    setPresetWarnings([]);
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    if (!['mp4', 'mov', 'mkv'].includes(ext)) {
      setErrorMsg('Unsupported file type. Please upload an MP4, MOV, or MKV video.');
      return;
    }

    let createdProjectId: string | undefined;
    try {
      setUploadPct(1);
      setUploadStage('Creating project...');
      const baseName = file.name.replace(/\.[^.]+$/, '');
      const { project, presetWarnings: warnings, voiceMissingWarning: voiceWarn } =
        await api.createProject(
          newName.trim() || baseName,
          getSelectedPresetOptions()
        );
      if (!isValidProjectId(project?.id)) {
        throw new Error('Project creation did not return a valid project ID. Please try again.');
      }
      createdProjectId = project.id;
      handleReportWarnings(warnings, voiceWarn);

      const updated = await uploadVideoChunked({
        projectId: project.id,
        file,
        onProgress: (pct, stage) => {
          setUploadPct(pct);
          setUploadStage(stage);
        },
      });

      const nextWorkflow = createWorkflowUpdate(updated.workflow, {
        completeStage: 'dashboard',
        visitStage: 'translator',
        modifiedStage: 'dashboard',
        hasGeneratedDub: Boolean(updated.voice.fullDubUrl),
        hasGeneratedCaptions: Boolean(updated.subtitleStyle.captionSync),
        hasExistingExport: Boolean(updated.lastExportUrl),
      });
      const { project: saved } = await api.updateProject(updated.id, { workflow: nextWorkflow });

      setNewName('');
      await onRefreshProjects();
      onSelectProject(saved, 'translator');
    } catch (err) {
      const code = err instanceof ApiHttpError ? err.code : undefined;
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setFailedUploadState({
        file,
        code,
        projectId: createdProjectId,
      });
      if (createdProjectId) {
        await onRefreshProjects().catch(() => undefined);
      }
    } finally {
      setUploadPct(null);
      setUploadStage('');
    }
  };

  const handleGenerateSampleProject = async () => {
    setErrorMsg(null);
    setPresetWarnings([]);
    setBusySample(true);
    try {
      const { project, presetWarnings: warnings, voiceMissingWarning: voiceWarn } =
        await api.createProject(
          newName.trim() || 'Observatory Mystery Recap',
          getSelectedPresetOptions()
        );
      handleReportWarnings(warnings, voiceWarn);
      const res = await api.createSampleVideo(project.id);
      const nextWorkflow = createWorkflowUpdate(res.project.workflow, {
        completeStage: 'dashboard',
        visitStage: 'translator',
      });
      const { project: saved } = await api.updateProject(res.project.id, {
        workflow: nextWorkflow,
      });
      setNewName('');
      await onRefreshProjects();
      onSelectProject(saved, 'translator');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySample(false);
    }
  };

  const handleCreateEmptyProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setErrorMsg(null);
    setPresetWarnings([]);
    try {
      const { project, presetWarnings: warnings, voiceMissingWarning: voiceWarn } =
        await api.createProject(
          newName.trim(),
          getSelectedPresetOptions()
        );
      handleReportWarnings(warnings, voiceWarn);
      setNewName('');
      await onRefreshProjects();
      onSelectProject(project, 'dashboard');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setErrorMsg(null);
    try {
      await api.deleteProject(id);
      await indexedDbStore.deleteProjectSnapshot(id);
      await onRefreshProjects();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-white/[0.08] pb-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-display font-bold tracking-tight text-white">
            Studio Projects
          </h1>
          <p className="text-sm text-zinc-400">
            Import a video to translate, dub, edit, caption, and export.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={backupImportRef}
            type="file"
            accept=".zip,.recapbackup.zip"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setErrorMsg(null);
              setUploadPct(5);
              setUploadStage('Restoring backup archive...');
              void importProjectBackupZip(f, (pct, label) => {
                setUploadPct(pct);
                setUploadStage(label);
              })
                .then(async (restored) => {
                  await onRefreshProjects();
                  onSelectProject(restored, 'editor');
                })
                .catch((err) => {
                  setErrorMsg(err instanceof Error ? err.message : String(err));
                })
                .finally(() => {
                  setUploadPct(null);
                  setUploadStage('');
                });
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => backupImportRef.current?.click()}
            className="px-3.5 py-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-white/[0.1] text-xs font-medium text-zinc-200 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Archive className="w-3.5 h-3.5 text-zinc-400" />
            Import Backup
          </button>

          <form onSubmit={handleCreateEmptyProject} className="flex items-center gap-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New project name..."
              className="bg-[#111115] border border-white/[0.1] rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-violet-500 w-48"
            />
            <button
              type="submit"
              disabled={!newName.trim()}
              className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-xs font-medium text-zinc-100 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              New Blank
            </button>
          </form>
        </div>
      </div>

      {errorMsg && (
        <div
          role="alert"
          className="p-3.5 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
        >
          <div className="flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <span>{errorMsg}</span>
          </div>
          {failedUploadState && (
            <div className="flex flex-wrap items-center gap-2 shrink-0 pl-6 sm:pl-0">
              <button
                type="button"
                onClick={() => void onRefreshProjects()}
                className="px-2.5 py-1 rounded-md bg-white/10 hover:bg-white/15 text-xs font-medium text-white cursor-pointer"
              >
                Refresh Projects
              </button>
              <button
                type="button"
                onClick={() => void handleCreateAndUpload(failedUploadState.file)}
                className="px-2.5 py-1 rounded-md bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white cursor-pointer"
              >
                Create New Project &amp; Retry
              </button>
            </div>
          )}
        </div>
      )}

      {presetWarnings.length > 0 && (
        <div className="p-3.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 space-y-1.5">
          <div className="flex items-center gap-2 font-medium text-amber-300">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>Preset applied with missing media assets</span>
          </div>
          {presetWarnings.map((w, idx) => (
            <div key={idx} className="text-amber-100/90 pl-6">
              <span className="font-semibold">{w.presetName}:</span>{' '}
              {w.missingAssets.map((a) => `${a.kind} (${a.label})`).join(', ')} missing. Re-upload in Editor.
            </div>
          ))}
        </div>
      )}

      {voiceMissingWarning && (
        <div
          role="alert"
          className="p-3.5 rounded-lg bg-amber-500/10 border border-amber-500/35 text-xs text-amber-200 flex items-start gap-2.5"
        >
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold text-amber-100">Saved Narrator Missing</div>
            <p className="text-amber-100/90 mt-0.5">{voiceMissingWarning.message}</p>
          </div>
        </div>
      )}

      {/* Choose Saved Style on Import */}
      <div className="p-4 rounded-xl bg-[#111115] border border-white/[0.08] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <Layers className="w-4 h-4 text-violet-400 shrink-0 mt-0.5" />
          <div>
            <div className="text-xs font-semibold text-white">
              Choose Saved Style on Import (Optional)
            </div>
            <div className="text-[11px] text-zinc-400 mt-0.5">
              {defaultPrefs?.autoApplyDefaultStyleOnImport && defaultPrefs.defaultStyleId
                ? 'Default style auto-apply is enabled in Settings (can be overridden below).'
                : 'Select a Saved Style to apply its filters, effects, caption style, canvas & narrator on import.'}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <select
            aria-label="Choose Saved Style"
            value={selectedStyleId}
            onChange={(e) => setSelectedStyleId(e.target.value)}
            className="min-h-[38px] bg-[#18181D] border border-white/[0.1] rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-violet-500 cursor-pointer min-w-[210px]"
          >
            <option value="none">None — Keep Original</option>
            {savedStyles.map((s) => (
              <option key={s.id} value={s.id}>
                {s.isDefault || defaultPrefs?.defaultStyleId === s.id
                  ? `${s.name} (Default)`
                  : s.name}
              </option>
            ))}
          </select>

          {activeProjectId && selectedStyleId !== 'none' && (
            <button
              type="button"
              onClick={() => void handleApplyToActiveProject()}
              disabled={applyingToActive}
              className="min-h-[38px] px-3 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/35 text-xs font-medium text-emerald-200 flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              {applyingToActive && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <span>Apply to Active</span>
            </button>
          )}
        </div>
      </div>

      {/* Optional Style Presets on Import (Collapsed by default) */}
      <CollapsibleSection
        title="Import Style Presets (Optional)"
        subtitle="Optional canvas, filter & caption style applied to newly imported videos"
        badge={hasSelectedPreset ? 'Active' : 'Original'}
        defaultOpen={false}
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {presets.some((p) => p.isDefault) && (
              <button
                type="button"
                onClick={handleUseDefaults}
                className="px-2.5 py-1 rounded-md bg-violet-600/15 hover:bg-violet-600/25 border border-violet-500/30 text-[11px] text-violet-200 font-medium cursor-pointer"
              >
                Use Saved Defaults
              </button>
            )}
            <button
              type="button"
              onClick={handleResetPresetsToOriginal}
              disabled={!hasSelectedPreset}
              className="px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-[11px] text-zinc-300 flex items-center gap-1 cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              Keep Original
            </button>
            {activeProjectId && hasSelectedPreset && (
              <button
                type="button"
                onClick={() => void handleApplyToActiveProject()}
                disabled={applyingToActive}
                className="px-2.5 py-1 rounded-md bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/30 text-[11px] text-emerald-200 font-medium flex items-center gap-1 cursor-pointer"
              >
                {applyingToActive && <Loader2 className="w-3 h-3 animate-spin" />}
                Apply to Active
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-zinc-400 block">
                Editing &amp; Canvas Preset
              </label>
              <select
                value={editingPresetId}
                onChange={(e) => setEditingPresetId(e.target.value)}
                className="w-full bg-[#18181D] border border-white/[0.1] rounded-lg px-2.5 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-violet-500 cursor-pointer"
              >
                <option value="none">None (Original)</option>
                {editingPresets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.isDefault ? `★ ${p.name}` : p.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-zinc-400 block">
                Color Filter &amp; Effects Preset
              </label>
              <select
                value={filterPresetId}
                onChange={(e) => setFilterPresetId(e.target.value)}
                className="w-full bg-[#18181D] border border-white/[0.1] rounded-lg px-2.5 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-violet-500 cursor-pointer"
              >
                <option value="none">None (Original)</option>
                {filterPresets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.isDefault ? `★ ${p.name}` : p.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-zinc-400 block">
                Caption Style Preset
              </label>
              <select
                value={captionPresetId}
                onChange={(e) => setCaptionPresetId(e.target.value)}
                className="w-full bg-[#18181D] border border-white/[0.1] rounded-lg px-2.5 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-violet-500 cursor-pointer"
              >
                <option value="none">None (Default)</option>
                {captionPresets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.isDefault ? `★ ${p.name}` : p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </CollapsibleSection>

      {/* Chunked Upload Dropzone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void handleCreateAndUpload(file);
        }}
        className={`rounded-xl border border-dashed p-8 text-center transition-colors ${
          dragOver
            ? 'border-violet-500 bg-violet-600/10'
            : 'border-white/[0.14] bg-[#111115] hover:border-white/[0.25]'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".mp4,.mov,.mkv,video/mp4,video/quicktime,video/x-matroska"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleCreateAndUpload(file);
            e.target.value = '';
          }}
        />

        {uploadPct !== null ? (
          <div className="max-w-md mx-auto space-y-3 py-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-200 font-medium">{uploadStage}</span>
              <span className="font-mono text-violet-300 tabular-nums">{uploadPct}%</span>
            </div>
            <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-violet-500 transition-all duration-200"
                style={{ width: `${uploadPct}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="w-11 h-11 rounded-xl bg-violet-600/15 border border-violet-500/30 text-violet-400 flex items-center justify-center mx-auto">
              <UploadCloud className="w-5 h-5" />
            </div>
            <div className="space-y-1">
              <div className="text-sm font-medium text-zinc-100">
                Drop MP4, MOV, or MKV movie recap video here
              </div>
              <p className="text-xs text-zinc-500">
                Chunked upload supports large files up to 2 GB and videos up to 30 minutes
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-medium text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Select Video File
              </button>
              <button
                type="button"
                onClick={handleGenerateSampleProject}
                disabled={busySample}
                className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-xs font-medium text-zinc-200 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {busySample ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5 text-violet-400" />
                )}
                Create Sample Recap Clip
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Saved Projects Grid */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-display font-semibold text-white">
            Saved Projects ({projects.length})
          </h2>
        </div>

        {projects.length === 0 ? (
          <div className="p-8 rounded-xl bg-[#111115] border border-white/[0.08] text-center text-sm text-zinc-500">
            No projects yet. Upload a video or create a sample recap clip above to start editing.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {projects.map((p) => {
              const isSelected = p.id === activeProjectId;
              return (
                <div
                  key={p.id}
                  onClick={() =>
                    onSelectProject(
                      p,
                      !p.sourceVideoUrl ? 'dashboard' : undefined
                    )
                  }
                  className={`group rounded-xl bg-[#111115] border transition-colors overflow-hidden cursor-pointer flex flex-col ${
                    isSelected
                      ? 'border-violet-500/70'
                      : 'border-white/[0.08] hover:border-white/[0.18]'
                  }`}
                >
                  <div className="aspect-video bg-[#070709] relative overflow-hidden border-b border-white/[0.06] flex items-center justify-center">
                    {p.thumbnailUrl ? (
                      <img
                        src={p.thumbnailUrl}
                        alt={p.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <Film className="w-8 h-8 text-zinc-700" />
                    )}
                    {p.metadata && (
                      <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-black/80 text-[11px] font-mono text-zinc-200 tabular-nums">
                        {formatDurationShort(p.metadata.duration)}
                      </div>
                    )}
                  </div>

                  <div className="p-4 flex-1 flex flex-col justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="text-sm font-semibold text-zinc-100 truncate">
                          {p.name}
                        </h3>
                        <button
                          type="button"
                          onClick={(e) => handleDelete(p.id, e)}
                          title="Delete project"
                          className="p-1 text-zinc-500 hover:text-red-400 rounded transition-colors shrink-0 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="text-xs text-zinc-500 font-mono tabular-nums truncate">
                        {p.metadata
                          ? `${p.metadata.height}p · ${formatBytes(p.metadata.fileSize)} · ${p.captions.length} captions`
                          : 'Awaiting video upload'}
                      </div>
                    </div>

                    <div className="pt-2 border-t border-white/[0.06] flex items-center justify-between text-xs">
                      <span className="text-[11px] text-zinc-500">
                        {p.lastExportUrl ? 'Exported' : 'Draft'}
                      </span>
                      <span className="text-violet-400 font-medium flex items-center gap-1 group-hover:text-violet-300">
                        <FolderOpen className="w-3.5 h-3.5" />
                        Open Studio
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Recent Render Jobs (Collapsed by default) */}
      {recentJobs.length > 0 && (
        <CollapsibleSection
          title="Recent Render Jobs"
          subtitle="Completed and active export history"
          badge={String(recentJobs.length)}
          defaultOpen={false}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-white/[0.08] text-zinc-500">
                <tr>
                  <th className="py-2 px-3 font-medium">Stage</th>
                  <th className="py-2 px-3 font-medium">Status</th>
                  <th className="py-2 px-3 font-medium text-right">Progress</th>
                  <th className="py-2 px-3 font-medium text-right">Size</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {recentJobs.slice(0, 8).map((job) => (
                  <tr key={job.id} className="hover:bg-white/[0.02]">
                    <td className="py-2 px-3 text-zinc-300">{job.stage}</td>
                    <td className="py-2 px-3">
                      <span className="inline-flex items-center gap-1.5 text-zinc-200">
                        {job.status === 'completed' ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        ) : job.status === 'failed' ? (
                          <AlertCircle className="w-3.5 h-3.5 text-red-400" />
                        ) : (
                          <Clock className="w-3.5 h-3.5 text-violet-400" />
                        )}
                        <span className="capitalize">{job.status}</span>
                      </span>
                    </td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-zinc-300">
                      {Math.round(job.progress)}%
                    </td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-zinc-400">
                      {job.outputSize ? formatBytes(job.outputSize) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CollapsibleSection>
      )}
    </div>
  );
}
