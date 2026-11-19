import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Edit3,
  Loader2,
  Mic,
  Play,
  Plus,
  Square,
  Star,
  Trash2,
  Volume2,
  X,
} from 'lucide-react';
import { Project, SavedFishVoice, SUPPORTED_LANGUAGES } from '../types/studio';
import { api } from '../lib/api';

interface MyVoicesManagerProps {
  activeProject?: Project | null;
  onProjectUpdated?: (p: Project) => void;
  onVoicesChanged?: (voices: SavedFishVoice[]) => void;
  onNotice?: (msg: string) => void;
}

export function MyVoicesManager({
  activeProject,
  onProjectUpdated,
  onVoicesChanged,
  onNotice,
}: MyVoicesManagerProps) {
  const [voices, setVoices] = useState<SavedFishVoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [fishConfigured, setFishConfigured] = useState<boolean>(false);

  // Add Voice Dialog / Form
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newVoiceId, setNewVoiceId] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newLang, setNewLang] = useState('');
  const [newSampleUrl, setNewSampleUrl] = useState('');
  const [newDefault, setNewDefault] = useState(false);
  const [savingNew, setSavingNew] = useState(false);

  // Edit Voice State
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editVoiceId, setEditVoiceId] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editLang, setEditLang] = useState('');
  const [editSampleUrl, setEditSampleUrl] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  // Preview / Delete Confirmation / Row Action State
  const [busyId, setBusyId] = useState<string | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [previewAudioUrl, setPreviewAudioUrl] = useState<string | null>(null);
  const [previewTitle, setPreviewTitle] = useState<string>('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadVoices = useCallback(async () => {
    try {
      const [voicesRes, sysRes] = await Promise.all([
        api.listSavedFishVoices(),
        api.getSystemStatus().catch(() => null),
      ]);
      setVoices(voicesRes.voices || []);
      setFishConfigured(Boolean(sysRes?.fishConfigured));
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadVoices();
  }, [loadVoices]);

  const handleAddVoice = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = newName.trim();
    const cleanId = newVoiceId.trim();
    if (!cleanName || !cleanId) {
      setErrorMsg('Narrator Name and Fish Audio Voice ID are required.');
      return;
    }

    setErrorMsg(null);
    setStatusMsg(null);
    setSavingNew(true);
    try {
      const res = await api.createSavedFishVoice({
        name: cleanName,
        voiceId: cleanId,
        description: newDesc.trim() || undefined,
        language: newLang.trim() || undefined,
        sampleUrl: newSampleUrl.trim() || undefined,
        isDefault: newDefault,
      });
      setVoices(res.voices);
      onVoicesChanged?.(res.voices);
      setAddOpen(false);
      setNewName('');
      setNewVoiceId('');
      setNewDesc('');
      setNewLang('');
      setNewSampleUrl('');
      setNewDefault(false);
      const msg = res.validationMessage
        ? `Saved "${res.voice.name}" (${res.validationMessage})`
        : `Saved narrator "${res.voice.name}".`;
      setStatusMsg(msg);
      onNotice?.(`Added narrator "${res.voice.name}".`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingNew(false);
    }
  };

  const handleSaveEdit = async (id: string) => {
    const cleanName = editName.trim();
    const cleanId = editVoiceId.trim();
    if (!cleanName || !cleanId) {
      setErrorMsg('Narrator Name and Fish Audio Voice ID cannot be empty.');
      return;
    }
    setErrorMsg(null);
    setSavingEdit(true);
    try {
      const old = voices.find((v) => v.id === id);
      const res = await api.updateSavedFishVoice(id, {
        name: cleanName,
        voiceId: cleanId,
        description: editDesc.trim(),
        language: editLang.trim(),
        sampleUrl: editSampleUrl.trim(),
      });
      setVoices(res.voices);
      onVoicesChanged?.(res.voices);
      setEditingId(null);
      if (
        activeProject &&
        old &&
        activeProject.voice.fishReferenceId?.trim() === old.voiceId.trim()
      ) {
        const { project: savedProj } = await api.updateProject(activeProject.id, {
          voice: {
            ...activeProject.voice,
            fishReferenceId: res.voice.voiceId,
            fishVoiceTitle: res.voice.name,
          },
        });
        onProjectUpdated?.(savedProj);
      }
      setStatusMsg(`Updated narrator "${res.voice.name}".`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingEdit(false);
    }
  };

  const handleSetDefault = async (voice: SavedFishVoice) => {
    setErrorMsg(null);
    setBusyId(voice.id);
    try {
      const res = await api.updateSavedFishVoice(voice.id, { isDefault: true });
      setVoices(res.voices);
      onVoicesChanged?.(res.voices);
      setStatusMsg(`Set "${voice.name}" as default narrator for new videos.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleDuplicate = async (voice: SavedFishVoice) => {
    setErrorMsg(null);
    setBusyId(voice.id);
    try {
      const res = await api.duplicateSavedFishVoice(voice.id);
      setVoices(res.voices);
      onVoicesChanged?.(res.voices);
      setStatusMsg(`Duplicated "${voice.name}".`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteConfirmed = async (voice: SavedFishVoice) => {
    setErrorMsg(null);
    setBusyId(voice.id);
    try {
      const res = await api.deleteSavedFishVoice(voice.id);
      setVoices(res.voices);
      onVoicesChanged?.(res.voices);
      setConfirmDeleteId(null);
      setStatusMsg(`Removed narrator "${voice.name}" from My Voices.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const handlePreviewVoice = async (voice: SavedFishVoice) => {
    setErrorMsg(null);
    if (previewingId === voice.id) {
      setPreviewingId(null);
      setPreviewAudioUrl(null);
      return;
    }

    if (voice.sampleUrl && !fishConfigured) {
      setPreviewTitle(voice.name);
      setPreviewAudioUrl(voice.sampleUrl);
      setPreviewingId(voice.id);
      return;
    }

    setPreviewingId(voice.id);
    try {
      if (voice.sampleUrl) {
        setPreviewTitle(voice.name);
        setPreviewAudioUrl(voice.sampleUrl);
      } else {
        const res = await api.previewSavedFishVoice({
          voiceId: voice.voiceId,
          text:
            voice.previewText ||
            'Everything changed the moment the vault door swung open in silence.',
        });
        setPreviewTitle(voice.name);
        setPreviewAudioUrl(res.audioUrl);
      }
    } catch (err) {
      setPreviewingId(null);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleUseInActiveProject = async (voice: SavedFishVoice) => {
    if (!activeProject) return;
    setErrorMsg(null);
    setBusyId(voice.id);
    try {
      const { project: savedProj } = await api.updateProject(activeProject.id, {
        voice: {
          ...activeProject.voice,
          provider: 'fish',
          fishReferenceId: voice.voiceId,
          fishVoiceTitle: voice.name,
        },
      });
      onProjectUpdated?.(savedProj);
      setStatusMsg(`Assigned "${voice.name}" to active project "${activeProject.name}".`);
      onNotice?.(`Narrator set to "${voice.name}".`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-display font-semibold text-white">
            Fish Audio · My Voices
          </h2>
          <p className="text-xs text-zinc-400 mt-0.5">
            Save and manage custom Fish Audio Voice IDs so you can select narrators by name across projects.
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            setAddOpen((v) => !v);
            setErrorMsg(null);
          }}
          className="min-h-[40px] px-3.5 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
        >
          {addOpen ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
          <span>{addOpen ? 'Cancel' : 'Add Voice'}</span>
        </button>
      </div>

      {errorMsg && (
        <div
          role="alert"
          className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-200 flex items-start gap-2"
        >
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

      {/* Add Voice Form */}
      {addOpen && (
        <form
          onSubmit={handleAddVoice}
          className="p-4 rounded-xl bg-[#16161B] border border-violet-500/40 space-y-3"
        >
          <div className="text-xs font-semibold text-white">Add Custom Fish Audio Voice</div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="add-voice-name" className="block text-[11px] font-medium text-zinc-300 mb-1">
                Narrator Name
              </label>
              <input
                id="add-voice-name"
                type="text"
                required
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g., Thriller Male FR"
                className="w-full min-h-[38px] bg-[#111115] border border-white/[0.1] rounded-lg px-3 py-1.5 text-xs text-white placeholder:text-zinc-500 focus:outline-none focus:border-violet-500"
              />
            </div>

            <div>
              <label htmlFor="add-voice-id" className="block text-[11px] font-medium text-zinc-300 mb-1">
                Fish Audio Voice ID
              </label>
              <input
                id="add-voice-id"
                type="text"
                required
                value={newVoiceId}
                onChange={(e) => setNewVoiceId(e.target.value)}
                placeholder="Paste exact Fish Audio reference_id..."
                spellCheck={false}
                className="w-full min-h-[38px] bg-[#111115] border border-white/[0.1] rounded-lg px-3 py-1.5 text-xs font-mono text-white placeholder:text-zinc-500 focus:outline-none focus:border-violet-500"
              />
            </div>

            <div>
              <label htmlFor="add-voice-lang" className="block text-[11px] font-medium text-zinc-300 mb-1">
                Language (Optional)
              </label>
              <select
                id="add-voice-lang"
                value={newLang}
                onChange={(e) => setNewLang(e.target.value)}
                className="w-full min-h-[38px] bg-[#111115] border border-white/[0.1] rounded-lg px-2.5 py-1.5 text-xs text-white"
              >
                <option value="">Any / Multilingual</option>
                {SUPPORTED_LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="add-voice-sample" className="block text-[11px] font-medium text-zinc-300 mb-1">
                Sample Audio URL (Optional)
              </label>
              <input
                id="add-voice-sample"
                type="url"
                value={newSampleUrl}
                onChange={(e) => setNewSampleUrl(e.target.value)}
                placeholder="https://... (uses Fish TTS if empty)"
                className="w-full min-h-[38px] bg-[#111115] border border-white/[0.1] rounded-lg px-3 py-1.5 text-xs text-white placeholder:text-zinc-500"
              />
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="add-voice-desc" className="block text-[11px] font-medium text-zinc-300 mb-1">
                Description (Optional)
              </label>
              <input
                id="add-voice-desc"
                type="text"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="Deep dramatic voice for movie recaps..."
                className="w-full min-h-[38px] bg-[#111115] border border-white/[0.1] rounded-lg px-3 py-1.5 text-xs text-white placeholder:text-zinc-500"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={newDefault}
                onChange={(e) => setNewDefault(e.target.checked)}
                className="accent-violet-500"
              />
              <span>Set as Default Voice for new projects</span>
            </label>

            <button
              type="submit"
              disabled={savingNew || !newName.trim() || !newVoiceId.trim()}
              className="min-h-[38px] px-4 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer"
            >
              {savingNew ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              <span>{fishConfigured ? 'Validate & Save Voice' : 'Save Voice'}</span>
            </button>
          </div>
        </form>
      )}

      {/* Inline Audio Preview Player */}
      {previewAudioUrl && (
        <div className="p-3 rounded-xl bg-[#16161B] border border-white/[0.08] space-y-1.5">
          <div className="flex items-center justify-between text-xs text-zinc-200">
            <span className="flex items-center gap-1.5 font-medium">
              <Volume2 className="w-3.5 h-3.5 text-violet-400" />
              Preview: {previewTitle}
            </span>
            <button
              type="button"
              onClick={() => {
                setPreviewAudioUrl(null);
                setPreviewingId(null);
              }}
              className="text-zinc-400 hover:text-white text-[11px] cursor-pointer"
            >
              Close
            </button>
          </div>
          <audio src={previewAudioUrl} controls autoPlay className="w-full h-9" />
        </div>
      )}

      {/* Saved Voices List */}
      {loading ? (
        <div className="py-8 flex items-center justify-center gap-2 text-xs text-zinc-400">
          <Loader2 className="w-4 h-4 animate-spin text-violet-400" />
          Loading saved voices...
        </div>
      ) : voices.length === 0 ? (
        <div className="p-8 rounded-xl bg-[#111115] border border-white/[0.08] text-center space-y-2">
          <Mic className="w-6 h-6 text-zinc-600 mx-auto" />
          <div className="text-xs font-semibold text-zinc-200">No Custom Voices Saved</div>
          <p className="text-[11px] text-zinc-500 max-w-md mx-auto">
            Click Add Voice above to store your favorite Fish Audio Voice IDs and reuse them cleanly across dubbing workflows and Saved Styles.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-white/[0.07] rounded-xl bg-[#111115] border border-white/[0.08] overflow-hidden">
          {voices.map((v) => {
            const isEditing = editingId === v.id;
            const isConfirmDelete = confirmDeleteId === v.id;
            const isActiveInProj =
              Boolean(activeProject?.voice.fishReferenceId) &&
              activeProject?.voice.fishReferenceId?.trim() === v.voiceId.trim();
            const isBusy = busyId === v.id;

            if (isEditing) {
              return (
                <div key={v.id} className="p-3.5 bg-[#16161B] space-y-2.5">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="Narrator name"
                      className="min-h-[36px] bg-[#111115] border border-white/[0.1] rounded-lg px-2.5 py-1.5 text-xs text-white"
                    />
                    <input
                      type="text"
                      value={editVoiceId}
                      onChange={(e) => setEditVoiceId(e.target.value)}
                      placeholder="Fish Audio Voice ID"
                      spellCheck={false}
                      className="min-h-[36px] bg-[#111115] border border-white/[0.1] rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                    />
                    <select
                      value={editLang}
                      onChange={(e) => setEditLang(e.target.value)}
                      className="min-h-[36px] bg-[#111115] border border-white/[0.1] rounded-lg px-2.5 py-1.5 text-xs text-white"
                    >
                      <option value="">Any / Multilingual</option>
                      {SUPPORTED_LANGUAGES.map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                    </select>
                    <input
                      type="url"
                      value={editSampleUrl}
                      onChange={(e) => setEditSampleUrl(e.target.value)}
                      placeholder="Optional sample URL"
                      className="min-h-[36px] bg-[#111115] border border-white/[0.1] rounded-lg px-2.5 py-1.5 text-xs text-white"
                    />
                    <input
                      type="text"
                      value={editDesc}
                      onChange={(e) => setEditDesc(e.target.value)}
                      placeholder="Optional description"
                      className="sm:col-span-2 min-h-[36px] bg-[#111115] border border-white/[0.1] rounded-lg px-2.5 py-1.5 text-xs text-white"
                    />
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="min-h-[34px] px-3 py-1 rounded-lg bg-zinc-800 text-xs text-zinc-300 cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={savingEdit || !editName.trim() || !editVoiceId.trim()}
                      onClick={() => void handleSaveEdit(v.id)}
                      className="min-h-[34px] px-3 py-1 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer"
                    >
                      {savingEdit ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                      Save Changes
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <div
                key={v.id}
                className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-white/[0.02]"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs sm:text-sm font-semibold text-white">{v.name}</span>
                    {v.isDefault && (
                      <span className="text-[10px] font-mono font-semibold text-amber-300 uppercase tracking-wide">
                        · Default
                      </span>
                    )}
                    {isActiveInProj && (
                      <span className="text-[10px] font-mono font-semibold text-emerald-300 uppercase tracking-wide">
                        · Active in Project
                      </span>
                    )}
                    {v.language && (
                      <span className="text-[11px] text-zinc-400">· {v.language}</span>
                    )}
                  </div>

                  <div className="text-[11px] font-mono text-zinc-400 truncate">
                    ID: {v.voiceId}
                    {v.validated ? ' · Verified' : ''}
                  </div>

                  {v.description && (
                    <div className="text-[11px] text-zinc-500 truncate">{v.description}</div>
                  )}
                </div>

                {isConfirmDelete ? (
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-red-300">Delete voice?</span>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(null)}
                      className="min-h-[34px] px-2.5 py-1 rounded-lg bg-zinc-800 text-xs text-zinc-200 cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleDeleteConfirmed(v)}
                      className="min-h-[34px] px-2.5 py-1 rounded-lg bg-red-600 hover:bg-red-500 text-xs font-semibold text-white cursor-pointer"
                    >
                      Confirm
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => void handlePreviewVoice(v)}
                      className="min-h-[34px] px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/[0.08] text-xs text-zinc-200 flex items-center gap-1 whitespace-nowrap cursor-pointer"
                    >
                      {previewingId === v.id ? (
                        <Square className="w-3 h-3 text-violet-400" />
                      ) : (
                        <Play className="w-3 h-3 text-violet-400" />
                      )}
                      <span>Preview</span>
                    </button>

                    {activeProject && (
                      <button
                        type="button"
                        disabled={isBusy || isActiveInProj}
                        onClick={() => void handleUseInActiveProject(v)}
                        className="min-h-[34px] px-2.5 py-1 rounded-lg bg-violet-600/20 hover:bg-violet-600/30 disabled:opacity-50 border border-violet-500/40 text-xs font-medium text-violet-200 whitespace-nowrap cursor-pointer"
                      >
                        {isActiveInProj ? 'Selected' : 'Use in Project'}
                      </button>
                    )}

                    <button
                      type="button"
                      disabled={isBusy || Boolean(v.isDefault)}
                      onClick={() => void handleSetDefault(v)}
                      title={v.isDefault ? 'Default Voice' : 'Set as Default Voice'}
                      className={`min-h-[34px] min-w-[34px] p-1.5 rounded-lg hover:bg-white/[0.06] cursor-pointer flex items-center justify-center ${
                        v.isDefault ? 'text-amber-400' : 'text-zinc-500 hover:text-amber-300'
                      }`}
                    >
                      <Star className="w-3.5 h-3.5" fill={v.isDefault ? 'currentColor' : 'none'} />
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(v.id);
                        setEditName(v.name);
                        setEditVoiceId(v.voiceId);
                        setEditDesc(v.description || '');
                        setEditLang(v.language || '');
                        setEditSampleUrl(v.sampleUrl || '');
                      }}
                      title="Edit Voice"
                      aria-label="Edit Voice"
                      className="min-h-[34px] min-w-[34px] p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] cursor-pointer flex items-center justify-center"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>

                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleDuplicate(v)}
                      title="Duplicate Voice"
                      aria-label="Duplicate Voice"
                      className="min-h-[34px] min-w-[34px] p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] cursor-pointer flex items-center justify-center"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>

                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => setConfirmDeleteId(v.id)}
                      title="Delete Voice"
                      aria-label="Delete Voice"
                      className="min-h-[34px] min-w-[34px] p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-white/[0.06] cursor-pointer flex items-center justify-center"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
