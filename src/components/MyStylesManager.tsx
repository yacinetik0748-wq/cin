import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Edit3,
  Eye,
  ImagePlus,
  Loader2,
  Plus,
  RefreshCw,
  Star,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import {
  Project,
  SavedFishVoice,
  StyleApplyScope,
  StyleMissingVoiceWarning,
  StudioPreset,
} from '../types/studio';
import { api } from '../lib/api';
import { sanitizeSavedStylePayload, summarizeSavedStyle } from '../lib/savedStyles';

interface MyStylesManagerProps {
  activeProject?: Project | null;
  onProjectUpdated?: (p: Project) => void;
  onOpenSaveStyleDialog?: () => void;
  onStylesChanged?: () => void;
  onNotice?: (msg: string) => void;
  compactHeader?: boolean;
}

const SCOPE_OPTIONS: Array<{ scope: StyleApplyScope; label: string }> = [
  { scope: 'filters', label: 'Apply Filters Only' },
  { scope: 'effects', label: 'Apply Effects Only' },
  { scope: 'captions', label: 'Apply Caption Style Only' },
  { scope: 'narration', label: 'Apply Narration Settings Only' },
];

export function MyStylesManager({
  activeProject,
  onProjectUpdated,
  onOpenSaveStyleDialog,
  onStylesChanged,
  onNotice,
  compactHeader = false,
}: MyStylesManagerProps) {
  const thumbFileRef = useRef<HTMLInputElement>(null);

  const [styles, setStyles] = useState<StudioPreset[]>([]);
  const [defaultStyleId, setDefaultStyleId] = useState<string | null>(null);
  const [savedVoices, setSavedVoices] = useState<SavedFishVoice[]>([]);
  const [loading, setLoading] = useState(true);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [scopeMenuId, setScopeMenuId] = useState<string | null>(null);
  const [previewStyleId, setPreviewStyleId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Edit / Rename state
  const [editingStyle, setEditingStyle] = useState<StudioPreset | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editThumbDataUrl, setEditThumbDataUrl] = useState<string | undefined>(undefined);
  const [savingEdit, setSavingEdit] = useState(false);

  // Feedback & missing voice prompt
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [missingVoicePrompt, setMissingVoicePrompt] = useState<StyleMissingVoiceWarning | null>(null);
  const [replacementVoiceId, setReplacementVoiceId] = useState('');

  const loadAll = useCallback(async () => {
    try {
      const [stylesRes, voicesRes] = await Promise.all([
        api.listStyles(),
        api.listSavedFishVoices().catch(() => ({ voices: [] as SavedFishVoice[] })),
      ]);
      setStyles(stylesRes.styles || []);
      setDefaultStyleId(stylesRes.defaultStyleId || null);
      setSavedVoices(voicesRes.voices || []);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleApplyStyle = async (style: StudioPreset, scope: StyleApplyScope) => {
    if (!activeProject) return;
    setErrorMsg(null);
    setStatusMsg(null);
    setMissingVoicePrompt(null);
    setScopeMenuId(null);
    setBusyId(style.id);

    try {
      const res = await api.applyStyleToProject(activeProject.id, style.id, scope);
      onProjectUpdated?.(res.project);
      if (res.voiceMissingWarning) {
        setMissingVoicePrompt(res.voiceMissingWarning);
      }
      const scopeLabel =
        scope === 'all'
          ? 'entire style'
          : scope === 'filters'
          ? 'filters'
          : scope === 'effects'
          ? 'effects'
          : scope === 'captions'
          ? 'caption style'
          : 'narration settings';
      const msg = `Applied ${scopeLabel} from "${style.name}" without altering timeline or media.`;
      setStatusMsg(msg);
      onNotice?.(msg);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleAssignReplacementVoice = async () => {
    if (!activeProject || !replacementVoiceId) return;
    const chosen = savedVoices.find((v) => v.id === replacementVoiceId);
    if (!chosen) return;
    try {
      const { project: saved } = await api.updateProject(activeProject.id, {
        voice: {
          ...activeProject.voice,
          fishReferenceId: chosen.voiceId,
          fishVoiceTitle: chosen.name,
        },
      });
      onProjectUpdated?.(saved);
      setMissingVoicePrompt(null);
      setReplacementVoiceId('');
      setStatusMsg(`Selected replacement narrator "${chosen.name}".`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSetDefault = async (style: StudioPreset) => {
    setErrorMsg(null);
    setBusyId(style.id);
    try {
      const nextDefault = !(style.isDefault || defaultStyleId === style.id);
      const res = await api.updateStyle(style.id, { isDefault: nextDefault });
      setStyles(res.styles);
      setDefaultStyleId(nextDefault ? style.id : null);
      onStylesChanged?.();
      setStatusMsg(
        nextDefault
          ? `"${style.name}" marked as default style.`
          : `Removed default status from "${style.name}".`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleDuplicate = async (style: StudioPreset) => {
    setErrorMsg(null);
    setBusyId(style.id);
    try {
      const res = await api.duplicateStyle(style.id);
      setStyles(res.styles);
      onStylesChanged?.();
      setStatusMsg(`Duplicated "${style.name}".`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteConfirmed = async (style: StudioPreset) => {
    setErrorMsg(null);
    setBusyId(style.id);
    try {
      const res = await api.deleteStyle(style.id);
      setStyles(res.styles);
      setConfirmDeleteId(null);
      if (defaultStyleId === style.id) setDefaultStyleId(null);
      onStylesChanged?.();
      setStatusMsg(`Deleted "${style.name}".`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingStyle || !editName.trim()) return;
    setSavingEdit(true);
    setErrorMsg(null);
    try {
      const res = await api.updateStyle(editingStyle.id, {
        name: editName.trim(),
        description: editDesc.trim(),
        ...(editThumbDataUrl ? { thumbnailDataUrl: editThumbDataUrl } : {}),
      });
      setStyles(res.styles);
      setEditingStyle(null);
      setEditThumbDataUrl(undefined);
      onStylesChanged?.();
      setStatusMsg(`Updated "${res.style.name}".`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingEdit(false);
    }
  };

  const handleUpdateFromActiveProject = async (style: StudioPreset) => {
    if (!activeProject) return;
    setErrorMsg(null);
    setBusyId(style.id);
    try {
      const res = await api.updateStyle(style.id, { fromProjectId: activeProject.id });
      setStyles(res.styles);
      onStylesChanged?.();
      setStatusMsg(`Updated "${style.name}" from "${activeProject.name}".`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const previewStyle = previewStyleId ? styles.find((s) => s.id === previewStyleId) || null : null;

  return (
    <div className="space-y-4">
      {!compactHeader && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-display font-semibold text-white">
              My Styles · Reusable Presets
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Save complete filter, effect, caption, canvas, and narrator configurations to reuse across videos.
            </p>
          </div>
          {onOpenSaveStyleDialog && activeProject && (
            <button
              type="button"
              onClick={onOpenSaveStyleDialog}
              className="min-h-[40px] px-3.5 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Save Current Style</span>
            </button>
          )}
        </div>
      )}

      {errorMsg && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <span>{errorMsg}</span>
        </div>
      )}

      {statusMsg && (
        <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-200 flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <span>{statusMsg}</span>
        </div>
      )}

      {/* Missing Voice Warning & Immediate Recovery Selector */}
      {missingVoicePrompt && (
        <div
          role="alert"
          className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/35 text-xs text-amber-100 space-y-2.5"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-amber-200">Saved Narrator Missing</div>
              <p className="text-amber-100/90 mt-0.5">{missingVoicePrompt.message}</p>
            </div>
          </div>

          {activeProject && savedVoices.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 pl-6">
              <select
                value={replacementVoiceId}
                onChange={(e) => setReplacementVoiceId(e.target.value)}
                className="min-h-[36px] bg-zinc-900 border border-white/[0.12] rounded-lg px-2.5 py-1.5 text-xs text-white"
              >
                <option value="">Choose another saved narrator...</option>
                {savedVoices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} ({v.voiceId})
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!replacementVoiceId}
                onClick={() => void handleAssignReplacementVoice()}
                className="min-h-[36px] px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-xs font-semibold text-zinc-950 cursor-pointer"
              >
                Use Selected Voice
              </button>
            </div>
          )}
        </div>
      )}

      {/* Edit Style Inline Dialog */}
      {editingStyle && (
        <form
          onSubmit={handleSaveEdit}
          className="p-4 rounded-xl bg-[#18181D] border border-violet-500/40 space-y-3"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-white">Edit Style: {editingStyle.name}</span>
            <button
              type="button"
              onClick={() => {
                setEditingStyle(null);
                setEditThumbDataUrl(undefined);
              }}
              className="text-zinc-400 hover:text-white cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Style Name</label>
              <input
                type="text"
                required
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="w-full min-h-[38px] bg-[#111115] border border-white/[0.1] rounded-lg px-2.5 py-1.5 text-xs text-white"
              />
            </div>
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Description</label>
              <input
                type="text"
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                className="w-full min-h-[38px] bg-[#111115] border border-white/[0.1] rounded-lg px-2.5 py-1.5 text-xs text-white"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <input
                ref={thumbFileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    const reader = new FileReader();
                    reader.onload = () => {
                      if (typeof reader.result === 'string') setEditThumbDataUrl(reader.result);
                    };
                    reader.readAsDataURL(f);
                  }
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => thumbFileRef.current?.click()}
                className="min-h-[34px] px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-[11px] text-zinc-200 flex items-center gap-1.5 cursor-pointer"
              >
                <ImagePlus className="w-3.5 h-3.5" />
                {editThumbDataUrl ? 'Thumbnail Selected' : 'Change Thumbnail'}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditingStyle(null);
                  setEditThumbDataUrl(undefined);
                }}
                className="min-h-[36px] px-3 py-1.5 rounded-lg bg-zinc-800 text-xs text-zinc-300 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingEdit || !editName.trim()}
                className="min-h-[36px] px-3.5 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer"
              >
                {savingEdit ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                Save Changes
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Preview Inspector Modal/Panel */}
      {previewStyle && (
        <div className="p-4 rounded-xl bg-[#16161B] border border-white/[0.12] space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-xs font-semibold text-white">
                Style Breakdown: {previewStyle.name}
              </div>
              {previewStyle.description && (
                <div className="text-[11px] text-zinc-400 mt-0.5">{previewStyle.description}</div>
              )}
            </div>
            <button
              type="button"
              onClick={() => setPreviewStyleId(null)}
              className="p-1 text-zinc-400 hover:text-white cursor-pointer"
              aria-label="Close preview"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          {(() => {
            const parsed = sanitizeSavedStylePayload(previewStyle.payload);
            const sum = summarizeSavedStyle(previewStyle, savedVoices);
            return (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 text-[11px]">
                <div className="p-2.5 rounded-lg bg-[#111115] border border-white/[0.06] space-y-1">
                  <div className="font-semibold text-zinc-300">Filters &amp; Color</div>
                  <div className="text-zinc-400">
                    Preset: <span className="text-zinc-100">{sum.filterLabel}</span>
                  </div>
                  <div className="text-zinc-400 tabular-nums">
                    Intensity: {parsed.filters.filterIntensity}% · Brightness:{' '}
                    {parsed.filters.adjustments.brightness}
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-[#111115] border border-white/[0.06] space-y-1">
                  <div className="font-semibold text-zinc-300">Effects &amp; Canvas</div>
                  <div className="text-zinc-400">
                    Effects: <span className="text-zinc-100">{sum.effectsLabel}</span>
                  </div>
                  <div className="text-zinc-400">
                    Canvas: <span className="text-zinc-100">{sum.aspectRatioLabel}</span> ·{' '}
                    {parsed.editorSettings.canvas?.backgroundType || 'solid'}
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-[#111115] border border-white/[0.06] space-y-1">
                  <div className="font-semibold text-zinc-300">Captions &amp; Narrator</div>
                  <div className="text-zinc-400">
                    Captions: <span className="text-zinc-100">{sum.captionLabel}</span>
                  </div>
                  <div className="text-zinc-400">
                    Narrator:{' '}
                    <span className={sum.narratorMissing ? 'text-amber-300' : 'text-zinc-100'}>
                      {sum.narratorLabel}
                    </span>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* Styles Card Grid */}
      {loading ? (
        <div className="py-8 flex items-center justify-center gap-2 text-xs text-zinc-400">
          <Loader2 className="w-4 h-4 animate-spin text-violet-400" />
          Loading saved styles...
        </div>
      ) : styles.length === 0 ? (
        <div className="p-8 rounded-xl bg-[#111115] border border-white/[0.08] text-center space-y-2">
          <Wand2 className="w-6 h-6 text-zinc-600 mx-auto" />
          <div className="text-xs font-semibold text-zinc-200">No Saved Styles Yet</div>
          <p className="text-[11px] text-zinc-500 max-w-md mx-auto">
            Configure filters, effects, captions, framing, and narrator voice on a video, then click
            Save Current Style in the Editor.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {styles.map((style) => {
            const sum = summarizeSavedStyle(style, savedVoices);
            const isDef = Boolean(style.isDefault || defaultStyleId === style.id);
            const isBusy = busyId === style.id;
            const parsed = sanitizeSavedStylePayload(style.payload);

            return (
              <div
                key={style.id}
                className={`rounded-xl bg-[#111115] border flex flex-col justify-between overflow-hidden transition-colors ${
                  isDef ? 'border-amber-500/45' : 'border-white/[0.08] hover:border-white/[0.16]'
                }`}
              >
                {/* Visual Preview Banner */}
                <div
                  className="relative h-24 w-full border-b border-white/[0.07] flex items-center justify-center overflow-hidden"
                  style={{
                    backgroundColor:
                      style.thumbnailStyle?.bg || parsed.editorSettings.canvas?.bgColor || '#15151A',
                  }}
                >
                  {sum.thumbnailUrl ? (
                    <img
                      src={sum.thumbnailUrl}
                      alt={style.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div
                      className="px-4 text-center select-none"
                      style={{
                        color: parsed.captionStyle.primaryColor || '#FFFFFF',
                        fontFamily: parsed.captionStyle.fontFamily || 'Montserrat',
                        fontSize: '15px',
                        fontWeight: 800,
                        textShadow: '0 2px 6px rgba(0,0,0,0.85)',
                      }}
                    >
                      {parsed.captionStyle.uppercase ? 'CAPTION PREVIEW' : 'Caption Preview'}
                    </div>
                  )}

                  {isDef && (
                    <span className="absolute top-2 left-2 px-2 py-0.5 rounded bg-amber-500/90 text-[10px] font-bold text-zinc-950 uppercase tracking-wide">
                      Default
                    </span>
                  )}

                  <span className="absolute bottom-2 right-2 px-2 py-0.5 rounded bg-black/75 border border-white/[0.12] text-[10px] font-mono text-zinc-200 tabular-nums">
                    {sum.aspectRatioLabel}
                  </span>
                </div>

                {/* Metadata & Breakdown */}
                <div className="p-3.5 space-y-2.5 flex-1 flex flex-col justify-between">
                  <div className="space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-white truncate">
                          {style.name}
                        </div>
                        {style.description && (
                          <div className="text-[11px] text-zinc-400 line-clamp-1">
                            {style.description}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleSetDefault(style)}
                        disabled={isBusy}
                        title={isDef ? 'Unset Default Style' : 'Set as Default Style'}
                        className={`p-1.5 rounded-lg hover:bg-white/[0.06] cursor-pointer shrink-0 ${
                          isDef ? 'text-amber-400' : 'text-zinc-500 hover:text-amber-300'
                        }`}
                      >
                        <Star className="w-4 h-4" fill={isDef ? 'currentColor' : 'none'} />
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px] pt-1">
                      <div className="truncate text-zinc-400">
                        <span className="text-zinc-500">Filter:</span>{' '}
                        <span className="text-zinc-200">{sum.filterLabel}</span>
                      </div>
                      <div className="truncate text-zinc-400">
                        <span className="text-zinc-500">Effects:</span>{' '}
                        <span className="text-zinc-200">{sum.effectsLabel}</span>
                      </div>
                      <div className="truncate text-zinc-400 col-span-2">
                        <span className="text-zinc-500">Captions:</span>{' '}
                        <span className="text-zinc-200">{sum.captionLabel}</span>
                      </div>
                      <div className="truncate text-zinc-400 col-span-2">
                        <span className="text-zinc-500">Narrator:</span>{' '}
                        <span className={sum.narratorMissing ? 'text-amber-300 font-medium' : 'text-zinc-200'}>
                          {sum.narratorLabel}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Confirmation or Actions */}
                  {confirmDeleteId === style.id ? (
                    <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/30 flex items-center justify-between gap-2 text-xs">
                      <span className="text-red-200 font-medium">Delete this style?</span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="px-2.5 py-1 rounded bg-zinc-800 text-zinc-200 text-[11px] cursor-pointer"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteConfirmed(style)}
                          disabled={isBusy}
                          className="px-2.5 py-1 rounded bg-red-600 hover:bg-red-500 text-white text-[11px] font-semibold cursor-pointer"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2 pt-2 border-t border-white/[0.06]">
                      {activeProject && (
                        <div className="relative flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void handleApplyStyle(style, 'all')}
                            className="flex-1 min-h-[36px] px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer"
                          >
                            {isBusy ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Wand2 className="w-3.5 h-3.5" />
                            )}
                            <span>Apply Entire Style</span>
                          </button>

                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() =>
                              setScopeMenuId((prev) => (prev === style.id ? null : style.id))
                            }
                            aria-label="Apply specific category"
                            title="Apply specific category"
                            className="min-h-[36px] px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/[0.08] text-xs text-zinc-200 flex items-center gap-1 whitespace-nowrap cursor-pointer"
                          >
                            <span>Partial</span>
                            <ChevronDown className="w-3.5 h-3.5" />
                          </button>

                          {scopeMenuId === style.id && (
                            <div className="absolute right-0 bottom-10 z-30 w-56 rounded-xl bg-[#18181D] border border-white/[0.12] shadow-2xl p-1.5 space-y-0.5">
                              {SCOPE_OPTIONS.map((opt) => (
                                <button
                                  key={opt.scope}
                                  type="button"
                                  onClick={() => void handleApplyStyle(style, opt.scope)}
                                  className="w-full text-left min-h-[34px] px-2.5 py-1.5 rounded-lg hover:bg-white/[0.07] text-xs text-zinc-200 cursor-pointer"
                                >
                                  {opt.label}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      <div className="flex flex-wrap items-center justify-between gap-1 text-[11px]">
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() =>
                              setPreviewStyleId((prev) => (prev === style.id ? null : style.id))
                            }
                            className="px-2 py-1 rounded hover:bg-white/[0.06] text-zinc-300 hover:text-white flex items-center gap-1 cursor-pointer"
                          >
                            <Eye className="w-3 h-3" />
                            Preview
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingStyle(style);
                              setEditName(style.name);
                              setEditDesc(style.description || '');
                              setEditThumbDataUrl(undefined);
                            }}
                            className="px-2 py-1 rounded hover:bg-white/[0.06] text-zinc-300 hover:text-white flex items-center gap-1 cursor-pointer"
                          >
                            <Edit3 className="w-3 h-3" />
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDuplicate(style)}
                            disabled={isBusy}
                            className="px-2 py-1 rounded hover:bg-white/[0.06] text-zinc-300 hover:text-white flex items-center gap-1 cursor-pointer"
                          >
                            <Copy className="w-3 h-3" />
                            Duplicate
                          </button>
                        </div>

                        <div className="flex items-center gap-1">
                          {activeProject && (
                            <button
                              type="button"
                              onClick={() => void handleUpdateFromActiveProject(style)}
                              disabled={isBusy}
                              title="Update this style from active project settings"
                              className="px-2 py-1 rounded hover:bg-white/[0.06] text-zinc-400 hover:text-white flex items-center gap-1 cursor-pointer"
                            >
                              <RefreshCw className="w-3 h-3" />
                              Overwrite
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(style.id)}
                            disabled={isBusy}
                            className="px-2 py-1 rounded hover:bg-red-500/15 text-zinc-400 hover:text-red-300 flex items-center gap-1 cursor-pointer"
                          >
                            <Trash2 className="w-3 h-3" />
                            Delete
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
