import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Languages,
  Loader2,
  Mic,
  Plus,
  Save,
  Search,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';
import {
  CaptionSegment,
  Project,
  ProjectPatchFn,
  SUPPORTED_LANGUAGES,
  SupportedLanguage,
} from '../types/studio';
import { api } from '../lib/api';
import { formatTimecode } from '../lib/formatters';
import {
  createWorkflowUpdate,
  validateProjectReadyForEditor,
} from '../lib/workflowStages';
import { ExternalGeminiTranslatorPanel } from '../components/ExternalGeminiTranslatorPanel';

interface TranslatorPageProps {
  project: Project;
  onProjectUpdated: (p: Project) => void;
  onPatchProject?: ProjectPatchFn;
  onFlushSaves?: (projectId?: string) => Promise<boolean>;
  onContinueToVoice?: (p: Project) => void;
  focusAudioOverflowSignal?: number;
}

const SOURCE_LANGUAGES = [
  'Auto',
  'English',
  'French',
  'Arabic',
  'Spanish',
  'German',
  'Portuguese',
  'Italian',
  'Turkish',
  'Hindi',
];

export function TranslatorPage({
  project,
  onProjectUpdated,
  onPatchProject,
  onFlushSaves,
  onContinueToVoice,
  focusAudioOverflowSignal,
}: TranslatorPageProps) {
  const saveTimerRef = useRef<number | null>(null);

  const [mode, setMode] = useState<'external-gemini' | 'api'>('external-gemini');
  const [sourceLang, setSourceLang] = useState<string>(
    project.translation.sourceLanguage || 'Auto'
  );
  const [targetLang, setTargetLang] = useState<SupportedLanguage>(
    project.translation.targetLanguage || 'French'
  );
  const [preserveNames, setPreserveNames] = useState<boolean>(
    project.translation.preserveProperNouns
  );

  // Sync language dropdowns when switching projects
  useEffect(() => {
    setSourceLang(project.translation.sourceLanguage || 'Auto');
    setTargetLang(project.translation.targetLanguage || 'French');
    setPreserveNames(project.translation.preserveProperNouns);
    setStatusMsg(null);
    setErrorMsg(null);
  }, [project.id]);

  const [segmentFilter, setSegmentFilter] = useState<'all' | 'missing'>('all');
  const [segmentQuery, setSegmentQuery] = useState('');

  const [busyTranscribe, setBusyTranscribe] = useState(false);
  const [busyTranslate, setBusyTranslate] = useState(false);
  const [busySave, setBusySave] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const validation = useMemo(() => validateProjectReadyForEditor(project), [project]);
  const totalSegments = project.captions.length;
  const translatedCount = validation.summary.translatedCount;
  const translationPct =
    totalSegments > 0 ? Math.round((translatedCount / totalSegments) * 100) : 0;
  const pendingRegenIds = project.translation.pendingRegenerateSegmentIds || [];

  const filteredCaptions = useMemo(() => {
    const q = segmentQuery.trim().toLowerCase();
    return project.captions
      .map((seg, idx) => ({ seg, idx }))
      .filter(({ seg }) => {
        if (segmentFilter === 'missing' && seg.translatedText?.trim()) {
          return false;
        }
        if (!q) return true;
        return (
          seg.text.toLowerCase().includes(q) ||
          (seg.translatedText || '').toLowerCase().includes(q) ||
          (seg.speaker || '').toLowerCase().includes(q)
        );
      });
  }, [project.captions, segmentFilter, segmentQuery]);

  const persistCaptionsDebounced = (nextCaptions: CaptionSegment[]) => {
    const nextWorkflow = createWorkflowUpdate(project.workflow, {
      visitStage: 'translator',
      modifiedStage: 'translator',
      hasGeneratedDub: Boolean(project.voice.fullDubUrl),
      hasGeneratedCaptions: Boolean(project.subtitleStyle.captionSync),
      hasExistingExport: Boolean(project.lastExportUrl),
    });
    if (onPatchProject) {
      onPatchProject(
        project.id,
        {
          captions: nextCaptions,
          workflow: nextWorkflow,
        },
        { debounceMs: 400 }
      );
      return;
    }
    onProjectUpdated({
      ...project,
      captions: nextCaptions,
      workflow: nextWorkflow,
    });
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void api
        .updateProject(project.id, {
          captions: nextCaptions,
          workflow: nextWorkflow,
        })
        .then(({ project: saved }) => {
          onProjectUpdated(saved);
        })
        .catch(() => {});
    }, 450);
  };

  const handleTranscribeSource = async () => {
    setErrorMsg(null);
    setStatusMsg(null);
    setBusyTranscribe(true);
    try {
      await onFlushSaves?.(project.id);
      const res = await api.transcribeWithFish(project.id, sourceLang);
      onProjectUpdated(res.project);
      setSourceLang(res.detectedLanguage);
      setStatusMsg(
        `Extracted ${res.segmentCount} timestamped segments (${res.detectedLanguage}).`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyTranscribe(false);
    }
  };

  const handleTranslate = async () => {
    setErrorMsg(null);
    setStatusMsg(null);
    setBusyTranslate(true);
    try {
      await onFlushSaves?.(project.id);
      await api.updateProject(project.id, {
        captions: project.captions,
        translation: {
          ...project.translation,
          sourceLanguage: sourceLang,
          targetLanguage: targetLang,
          preserveProperNouns: preserveNames,
        },
        voice: {
          ...project.voice,
          targetLanguage: targetLang,
        },
      });
      const res = await api.translate(project.id, targetLang, preserveNames);
      const nextWorkflow = createWorkflowUpdate(res.project.workflow, {
        completeStage: 'translator',
        modifiedStage: 'translator',
        hasGeneratedDub: Boolean(res.project.voice.fullDubUrl),
        hasGeneratedCaptions: Boolean(res.project.subtitleStyle.captionSync),
        hasExistingExport: Boolean(res.project.lastExportUrl),
      });
      const { project: synced } = await api.updateProject(project.id, {
        workflow: nextWorkflow,
      });
      onProjectUpdated(synced);
      setStatusMsg(
        `Translated ${synced.captions.length} segment(s) to ${targetLang}.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyTranslate(false);
    }
  };

  const toggleShowTranslated = async (checked: boolean) => {
    const nextStyle = { ...project.subtitleStyle, useTranslated: checked };
    if (onPatchProject) {
      onPatchProject(project.id, { subtitleStyle: nextStyle }, { immediate: true });
      return;
    }
    onProjectUpdated({ ...project, subtitleStyle: nextStyle });
    const { project: saved } = await api.updateProject(project.id, {
      subtitleStyle: nextStyle,
    });
    onProjectUpdated(saved);
  };

  const handleSaveChanges = async (continueToVoice = false) => {
    setErrorMsg(null);
    setStatusMsg(null);
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    setBusySave(true);
    try {
      await onFlushSaves?.(project.id);
      const hasAnyTranslation = project.captions.some((c) =>
        Boolean(c.translatedText?.trim())
      );
      const nextWorkflow = createWorkflowUpdate(project.workflow, {
        visitStage: continueToVoice ? 'voice' : 'translator',
        completeStage: hasAnyTranslation ? 'translator' : undefined,
        modifiedStage: 'translator',
        hasGeneratedDub: Boolean(project.voice.fullDubUrl),
        hasGeneratedCaptions: Boolean(project.subtitleStyle.captionSync),
        hasExistingExport: Boolean(project.lastExportUrl),
      });
      const { project: saved } = await api.updateProject(project.id, {
        captions: project.captions,
        translation: {
          ...project.translation,
          sourceLanguage: sourceLang,
          targetLanguage: targetLang,
          preserveProperNouns: preserveNames,
        },
        voice: {
          ...project.voice,
          targetLanguage: targetLang,
        },
        workflow: nextWorkflow,
      });
      onProjectUpdated(saved);
      if (continueToVoice && onContinueToVoice) {
        onContinueToVoice(saved);
      } else {
        setStatusMsg('Saved translation script and segment timestamps.');
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySave(false);
    }
  };

  const updateSegment = (id: string, patch: Partial<CaptionSegment>) => {
    const next = project.captions.map((c) => (c.id === id ? { ...c, ...patch } : c));
    persistCaptionsDebounced(next);
  };

  const addSegment = () => {
    const last = project.captions[project.captions.length - 1];
    const start = last ? Number(last.end.toFixed(2)) : 0;
    const end = Number(
      Math.min(project.metadata?.duration || start + 4, start + 3).toFixed(2)
    );
    const next: CaptionSegment[] = [
      ...project.captions,
      {
        id: `seg_${Date.now()}`,
        start,
        end: Math.max(start + 0.5, end),
        text: '',
        translatedText: '',
      },
    ];
    persistCaptionsDebounced(next);
  };

  const removeSegment = (id: string) => {
    const next = project.captions.filter((c) => c.id !== id);
    persistCaptionsDebounced(next);
  };

  return (
    <div className="p-3 sm:p-5 max-w-[1560px] mx-auto space-y-4">
      {/* Header Bar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b border-white/[0.08] pb-3.5">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="px-2 py-0.5 rounded bg-violet-600/20 border border-violet-500/40 text-[11px] font-mono font-semibold text-violet-200">
              STEP 1
            </span>
            <h1 className="text-lg sm:text-xl font-display font-bold tracking-tight text-white">
              Translation Studio
            </h1>
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono">
              <span
                className={`px-2 py-0.5 rounded border ${
                  validation.translationValid
                    ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                    : 'bg-zinc-900 border-white/[0.08] text-zinc-400'
                }`}
              >
                {translatedCount}/{totalSegments} translated ({translationPct}%)
              </span>
              {pendingRegenIds.length > 0 && (
                <span className="px-2 py-0.5 rounded border bg-amber-500/10 border-amber-500/30 text-amber-300">
                  {pendingRegenIds.length} modified
                </span>
              )}
            </div>
          </div>
          <p className="text-xs text-zinc-400">
            Text-focused workspace for transcription, Gemini prompt or automatic AI translation, pacing checks, and segment script editing.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void handleSaveChanges(false)}
            disabled={busySave}
            className="min-h-[40px] px-3.5 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-white/[0.08] disabled:opacity-50 text-xs font-semibold text-zinc-100 flex items-center gap-1.5 cursor-pointer"
          >
            {busySave ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Save className="w-3.5 h-3.5 text-violet-400" />
            )}
            <span>Save &amp; Apply</span>
          </button>

          {onContinueToVoice && (
            <button
              type="button"
              onClick={() => void handleSaveChanges(true)}
              disabled={busySave}
              className="min-h-[40px] px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-xs sm:text-sm font-semibold text-white flex items-center gap-2 cursor-pointer shadow-lg shadow-violet-600/25"
            >
              <span>Save &amp; Continue to Voice Studio</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Translation Progress Bar */}
      <div className="p-3 rounded-xl bg-[#111115] border border-white/[0.08] space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="font-medium text-zinc-200 flex items-center gap-1.5">
            <Languages className="w-3.5 h-3.5 text-violet-400" />
            Translation Progress
          </span>
          <span className="font-mono text-[11px] text-zinc-400">
            {totalSegments === 0
              ? 'No segments yet — transcribe audio or paste Gemini JSON below'
              : `${translatedCount} of ${totalSegments} segments translated · Target: ${targetLang}`}
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-zinc-900 overflow-hidden">
          <div
            className={`h-full transition-all ${
              validation.translationValid ? 'bg-emerald-500' : 'bg-violet-500'
            }`}
            style={{ width: `${translationPct}%` }}
          />
        </div>
      </div>

      {errorMsg && (
        <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <span>{errorMsg}</span>
        </div>
      )}

      {statusMsg && (
        <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-200 flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <span>{statusMsg}</span>
        </div>
      )}

      {/* Main Text-Focused Two-Column Workspace (NO Video Player) */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
        {/* LEFT COLUMN: Translation Settings, Gemini Integration & Automatic Translation */}
        <div className="xl:col-span-5 space-y-3.5">
          <section className="p-4 rounded-xl bg-[#111115] border border-white/[0.08] space-y-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-display font-semibold text-white flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-violet-400" />
                  Translation Settings &amp; Tools
                </h2>
                <p className="text-[11px] text-zinc-400 mt-0.5">
                  Translate via External Gemini (free, no API key) or Automatic API.
                </p>
              </div>
            </div>

            {/* Mode Switcher */}
            <div className="grid grid-cols-2 bg-zinc-900 border border-white/[0.08] rounded-lg p-0.5">
              <button
                type="button"
                onClick={() => setMode('external-gemini')}
                className={`py-1.5 px-2.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                  mode === 'external-gemini'
                    ? 'bg-violet-600 text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                External Gemini (No Key)
              </button>
              <button
                type="button"
                onClick={() => setMode('api')}
                className={`py-1.5 px-2.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                  mode === 'api'
                    ? 'bg-violet-600 text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Automatic API
              </button>
            </div>

            {mode === 'external-gemini' ? (
              <ExternalGeminiTranslatorPanel
                project={project}
                onProjectUpdated={onProjectUpdated}
                sourceLanguage={sourceLang}
                targetLanguage={targetLang}
                onChangeTargetLanguage={setTargetLang}
                preserveProperNouns={preserveNames}
                onChangePreserveProperNouns={setPreserveNames}
                focusAudioOverflowSignal={focusAudioOverflowSignal}
                onApprovedSuccess={(count, lang) => {
                  setStatusMsg(`Approved & saved ${count} translated segment(s) (${lang}).`);
                }}
              />
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div>
                    <label className="text-[11px] font-medium text-zinc-400">
                      Source Language
                    </label>
                    <select
                      value={sourceLang}
                      onChange={(e) => setSourceLang(e.target.value)}
                      className="mt-1 w-full bg-[#18181D] border border-white/[0.08] rounded-lg px-2.5 py-2 text-xs text-zinc-100"
                    >
                      {SOURCE_LANGUAGES.map((lang) => (
                        <option key={lang} value={lang}>
                          {lang === 'Auto' ? 'Auto-Detect' : lang}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="text-[11px] font-medium text-zinc-400">
                      Target Language
                    </label>
                    <select
                      value={targetLang}
                      onChange={(e) => setTargetLang(e.target.value as SupportedLanguage)}
                      className="mt-1 w-full bg-[#18181D] border border-white/[0.08] rounded-lg px-2.5 py-2 text-xs text-zinc-100"
                    >
                      {SUPPORTED_LANGUAGES.map((lang) => (
                        <option key={lang} value={lang}>
                          {lang}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={preserveNames}
                    onChange={(e) => setPreserveNames(e.target.checked)}
                    className="accent-violet-500"
                  />
                  Preserve character names &amp; movie terminology
                </label>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => void handleTranscribeSource()}
                    disabled={!project.sourceVideoUrl || busyTranscribe}
                    className="min-h-[38px] py-2 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-xs font-semibold text-white flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    {busyTranscribe ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Mic className="w-3.5 h-3.5 text-violet-400" />
                    )}
                    {busyTranscribe ? 'Extracting...' : 'Extract Transcript'}
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleTranslate()}
                    disabled={busyTranslate || project.captions.length === 0}
                    className="min-h-[38px] py-2 px-3 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    {busyTranslate ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Wand2 className="w-3.5 h-3.5" />
                    )}
                    {busyTranslate
                      ? `Translating...`
                      : `Translate to ${targetLang}`}
                  </button>
                </div>
              </div>
            )}

            <div className="pt-2.5 border-t border-white/[0.06] space-y-2">
              <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={project.subtitleStyle.useTranslated}
                  onChange={(e) => void toggleShowTranslated(e.target.checked)}
                  className="accent-violet-500"
                />
                Use translated text for captions &amp; subtitles in Video Editor
              </label>
            </div>
          </section>
        </div>

        {/* RIGHT COLUMN: Original vs. Translated Script & Timestamp Workspace */}
        <div className="xl:col-span-7">
          <section className="p-4 rounded-xl bg-[#111115] border border-white/[0.08] space-y-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-display font-semibold text-white">
                  Original &amp; Translated Segments ({project.captions.length})
                </h2>
                <p className="text-[11px] text-zinc-400 mt-0.5">
                  Edit timestamps, original lines, and translated narration script directly.
                </p>
              </div>

              <button
                type="button"
                onClick={addSegment}
                className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/[0.08] text-xs font-medium text-zinc-200 flex items-center gap-1.5 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5 text-violet-400" />
                Add Segment
              </button>
            </div>

            {/* Search & Filter Controls */}
            {project.captions.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[180px]">
                  <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={segmentQuery}
                    onChange={(e) => setSegmentQuery(e.target.value)}
                    placeholder="Filter original or translated text..."
                    className="w-full bg-zinc-900 border border-white/[0.08] rounded-lg pl-8 pr-3 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-violet-500"
                  />
                </div>
                <div className="flex items-center bg-zinc-900 border border-white/[0.08] rounded-lg p-0.5 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setSegmentFilter('all')}
                    className={`px-2.5 py-1 rounded-md font-medium cursor-pointer ${
                      segmentFilter === 'all'
                        ? 'bg-violet-600 text-white'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    All ({project.captions.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setSegmentFilter('missing')}
                    className={`px-2.5 py-1 rounded-md font-medium cursor-pointer ${
                      segmentFilter === 'missing'
                        ? 'bg-violet-600 text-white'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    Missing ({Math.max(0, totalSegments - translatedCount)})
                  </button>
                </div>
              </div>
            )}

            {/* Segment Cards */}
            {project.captions.length === 0 ? (
              <div className="py-12 px-4 rounded-xl bg-[#09090B] border border-white/[0.06] text-center space-y-3">
                <Languages className="w-6 h-6 text-zinc-600 mx-auto" />
                <div className="space-y-1">
                  <div className="text-sm font-medium text-zinc-200">
                    No Transcript Segments Yet
                  </div>
                  <p className="text-xs text-zinc-500 max-w-md mx-auto">
                    Use External Gemini on the left to analyze and translate your video, switch to Automatic API to extract transcript, or add a segment manually.
                  </p>
                </div>
              </div>
            ) : filteredCaptions.length === 0 ? (
              <div className="py-8 rounded-xl bg-[#09090B] border border-white/[0.06] text-center text-xs text-zinc-500">
                No segments match your current filter.
              </div>
            ) : (
              <div className="space-y-2.5 max-h-[calc(100dvh-290px)] overflow-y-auto pr-1">
                {filteredCaptions.map(({ seg, idx }) => {
                  const slotDur = Math.max(0.1, seg.end - seg.start);
                  const translatedWords = (seg.translatedText || '')
                    .trim()
                    .split(/\s+/)
                    .filter(Boolean).length;
                  const isMissing = !(seg.translatedText || '').trim();
                  const isPendingRegen = pendingRegenIds.includes(seg.id);

                  return (
                    <div
                      key={seg.id}
                      className={`p-3 rounded-xl border space-y-2.5 ${
                        isMissing
                          ? 'bg-amber-950/10 border-amber-500/25'
                          : isPendingRegen
                          ? 'bg-violet-950/15 border-violet-500/35'
                          : 'bg-[#18181D] border-white/[0.07]'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="px-2 py-0.5 rounded bg-zinc-800 text-[11px] font-mono font-semibold text-violet-300">
                            #{idx + 1}
                          </span>
                          <span className="text-[11px] font-mono text-zinc-400 tabular-nums">
                            {formatTimecode(seg.start)} → {formatTimecode(seg.end)}
                          </span>
                          <span className="text-[10px] font-mono text-zinc-500">
                            ({slotDur.toFixed(1)}s slot · {translatedWords} words)
                          </span>
                          {seg.speaker && (
                            <span className="px-1.5 py-0.5 rounded bg-zinc-900 border border-white/[0.06] text-[10px] text-zinc-300">
                              {seg.speaker}
                            </span>
                          )}
                          {isPendingRegen && (
                            <span className="px-1.5 py-0.5 rounded bg-violet-500/15 text-[10px] font-mono text-violet-300">
                              Audio regen pending
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            step={0.1}
                            min={0}
                            value={seg.start}
                            onChange={(e) =>
                              updateSegment(seg.id, {
                                start: Math.max(0, Number(e.target.value)),
                              })
                            }
                            aria-label={`Segment ${idx + 1} start seconds`}
                            className="w-16 bg-zinc-900 border border-white/[0.08] rounded px-1.5 py-0.5 text-[11px] font-mono text-zinc-200"
                          />
                          <span className="text-[10px] text-zinc-500">–</span>
                          <input
                            type="number"
                            step={0.1}
                            min={0}
                            value={seg.end}
                            onChange={(e) =>
                              updateSegment(seg.id, {
                                end: Math.max(seg.start + 0.2, Number(e.target.value)),
                              })
                            }
                            aria-label={`Segment ${idx + 1} end seconds`}
                            className="w-16 bg-zinc-900 border border-white/[0.08] rounded px-1.5 py-0.5 text-[11px] font-mono text-zinc-200"
                          />
                          <button
                            type="button"
                            onClick={() => removeSegment(seg.id)}
                            className="p-1 text-zinc-500 hover:text-red-400 cursor-pointer"
                            aria-label={`Delete segment ${idx + 1}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                        <div className="space-y-1">
                          <label className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                            Original Text
                          </label>
                          <textarea
                            rows={2}
                            value={seg.text}
                            onChange={(e) =>
                              updateSegment(seg.id, { text: e.target.value })
                            }
                            placeholder="Original narration or dialogue..."
                            className="w-full bg-zinc-900 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 resize-y focus:outline-none focus:border-violet-500"
                          />
                        </div>

                        <div className="space-y-1">
                          <label className="text-[10px] font-medium uppercase tracking-wider text-violet-300/80">
                            Translated Text ({targetLang})
                          </label>
                          <textarea
                            rows={2}
                            value={seg.translatedText || ''}
                            onChange={(e) =>
                              updateSegment(seg.id, {
                                translatedText: e.target.value,
                              })
                            }
                            placeholder={`Enter ${targetLang} translation...`}
                            className="w-full bg-zinc-900 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-zinc-100 resize-y focus:outline-none focus:border-violet-500"
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
