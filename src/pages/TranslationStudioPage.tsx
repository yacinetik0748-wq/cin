import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Eye,
  Languages,
  Loader2,
  Mic,
  Plus,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';
import {
  CaptionSegment,
  NavPage,
  Project,
  SupportedLanguage,
} from '../types/studio';
import { api } from '../lib/api';
import { formatTimecode } from '../lib/formatters';
import {
  createWorkflowUpdate,
  validateProjectReadyForEditor,
} from '../lib/workflowStages';
import { VideoStudioPlayer } from '../components/VideoStudioPlayer';
import { ExternalGeminiTranslatorPanel } from '../components/ExternalGeminiTranslatorPanel';
import {
  StudioBanner,
  StudioButton,
  StudioCard,
  StudioEmptyState,
  StudioSectionHeader,
  StudioSegmentedControl,
} from '../components/ui/StudioPrimitives';

interface TranslationStudioPageProps {
  project: Project;
  onProjectUpdated: (p: Project) => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  currentTime: number;
  onTimeUpdate: (time: number) => void;
  onSeek: (time: number) => void;
  previewEffects: boolean;
  onTogglePreviewEffects: (val: boolean) => void;
  onNavigate: (page: NavPage) => void;
  initialEngine?: 'external-gemini' | 'auto';
  initialFocusOverflow?: number;
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

const TARGET_LANGUAGES: SupportedLanguage[] = [
  'French',
  'Arabic',
  'English',
  'Spanish',
  'German',
  'Portuguese',
  'Italian',
  'Turkish',
  'Hindi',
];

export function TranslationStudioPage({
  project,
  onProjectUpdated,
  videoRef,
  currentTime,
  onTimeUpdate,
  onSeek,
  previewEffects,
  onTogglePreviewEffects,
  onNavigate,
  initialEngine = 'external-gemini',
  initialFocusOverflow = 0,
}: TranslationStudioPageProps) {
  const saveTimerRef = useRef<number | null>(null);

  const [sourceLanguage, setSourceLanguage] = useState<string>(
    project.translation.sourceLanguage || 'Auto'
  );
  const [targetLanguage, setTargetLanguage] = useState<SupportedLanguage>(
    TARGET_LANGUAGES.includes(project.translation.targetLanguage)
      ? project.translation.targetLanguage
      : project.voice.targetLanguage || 'French'
  );
  const [preserveProperNouns, setPreserveProperNouns] = useState<boolean>(
    project.translation.preserveProperNouns
  );
  const [engineMode, setEngineMode] = useState<'external-gemini' | 'auto'>(initialEngine);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [fishConfigured, setFishConfigured] = useState<boolean | null>(null);
  const [busyTranscribe, setBusyTranscribe] = useState(false);
  const [busyTranslate, setBusyTranslate] = useState(false);
  const [busyApplySettings, setBusyApplySettings] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    setSourceLanguage(project.translation.sourceLanguage || 'Auto');
    setTargetLanguage(
      TARGET_LANGUAGES.includes(project.translation.targetLanguage)
        ? project.translation.targetLanguage
        : project.voice.targetLanguage || 'French'
    );
    setPreserveProperNouns(project.translation.preserveProperNouns);
  }, [
    project.id,
    project.translation.sourceLanguage,
    project.translation.targetLanguage,
    project.translation.preserveProperNouns,
    project.voice.targetLanguage,
  ]);

  useEffect(() => {
    if (initialFocusOverflow > 0) {
      setEngineMode('external-gemini');
    }
  }, [initialFocusOverflow]);

  useEffect(() => {
    void api
      .getSystemStatus()
      .then((s) => setFishConfigured(s.fishConfigured))
      .catch(() => setFishConfigured(null));
  }, []);

  const persistCaptionsDebounced = (nextCaptions: CaptionSegment[]) => {
    const nextWorkflow = createWorkflowUpdate(project.workflow, {
      visitStage: 'translator',
      modifiedStage: 'translator',
      hasGeneratedDub: Boolean(project.voice.fullDubUrl),
      hasGeneratedCaptions: Boolean(project.subtitleStyle.captionSync),
      hasExistingExport: Boolean(project.lastExportUrl),
    });
    onProjectUpdated({ ...project, captions: nextCaptions, workflow: nextWorkflow });
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void api
        .updateProject(project.id, { captions: nextCaptions, workflow: nextWorkflow })
        .then(({ project: saved }) => onProjectUpdated(saved))
        .catch(() => {});
    }, 450);
  };

  const handleTranscribeSource = async () => {
    setErrorMsg(null);
    setStatusMsg(null);
    setBusyTranscribe(true);
    try {
      const res = await api.transcribeWithFish(project.id, sourceLanguage);
      onProjectUpdated(res.project);
      setSourceLanguage(res.detectedLanguage);
      setStatusMsg(
        `Transcribed ${res.segmentCount} segments (${res.detectedLanguage}).`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyTranscribe(false);
    }
  };

  const handleAutoTranslate = async () => {
    setErrorMsg(null);
    setStatusMsg(null);
    setBusyTranslate(true);
    try {
      await api.updateProject(project.id, {
        captions: project.captions,
        translation: {
          ...project.translation,
          sourceLanguage,
          targetLanguage,
          preserveProperNouns,
        },
        voice: { ...project.voice, targetLanguage },
      });
      const res = await api.translate(project.id, targetLanguage, preserveProperNouns);
      onProjectUpdated(res.project);
      setStatusMsg(
        `Translated ${res.project.captions.length} segments to ${targetLanguage}.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyTranslate(false);
    }
  };

  const handleSaveAndMarkApplied = async () => {
    setErrorMsg(null);
    setStatusMsg(null);
    setBusyApplySettings(true);
    try {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const nextWorkflow = createWorkflowUpdate(project.workflow, {
        completeStage: 'translator',
        visitStage: 'voice',
        modifiedStage: 'translator',
        hasGeneratedDub: Boolean(project.voice.fullDubUrl),
        hasGeneratedCaptions: Boolean(project.subtitleStyle.captionSync),
        hasExistingExport: Boolean(project.lastExportUrl),
      });
      const { project: saved } = await api.updateProject(project.id, {
        captions: project.captions,
        translation: {
          ...project.translation,
          sourceLanguage,
          targetLanguage,
          preserveProperNouns,
          lastTranslatedAt: new Date().toISOString(),
        },
        subtitleStyle: {
          ...project.subtitleStyle,
          useTranslated: true,
        },
        voice: {
          ...project.voice,
          targetLanguage,
        },
        workflow: nextWorkflow,
      });
      onProjectUpdated(saved);
      setStatusMsg(`Saved translation settings and applied ${targetLanguage} captions.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyApplySettings(false);
    }
  };

  const togglePreviewTranslated = async (checked: boolean) => {
    const nextStyle = { ...project.subtitleStyle, useTranslated: checked };
    onProjectUpdated({ ...project, subtitleStyle: nextStyle });
    try {
      const { project: saved } = await api.updateProject(project.id, {
        subtitleStyle: nextStyle,
      });
      onProjectUpdated(saved);
    } catch {
      // keep optimistic update
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

  const validation = validateProjectReadyForEditor(project);
  const pendingRegenSet = new Set(project.translation.pendingRegenerateSegmentIds || []);

  return (
    <div className="p-3 sm:p-5 max-w-[1520px] mx-auto space-y-4">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/[0.08] pb-3.5">
        <div>
          <h1 className="text-lg sm:text-xl font-display font-bold tracking-tight text-white">
            Translation Studio
          </h1>
          <p className="text-xs text-zinc-400 mt-0.5 font-mono tabular-nums">
            {validation.summary.translatedCount}/{validation.summary.totalSegments} segments translated
            {' · '}Source: {sourceLanguage}
            {' · '}Target: {targetLanguage}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <StudioButton
            variant="secondary"
            size="md"
            loading={busyApplySettings}
            onClick={() => void handleSaveAndMarkApplied()}
          >
            Save &amp; Apply
          </StudioButton>
          <StudioButton
            variant="primary"
            size="md"
            icon={<ArrowRight className="w-4 h-4" />}
            onClick={() => onNavigate('voice')}
          >
            Continue to Voice Studio
          </StudioButton>
        </div>
      </div>

      {fishConfigured === false && (
        <StudioBanner
          tone="warning"
          action={
            <StudioButton
              size="sm"
              variant="secondary"
              icon={<Settings className="w-3.5 h-3.5" />}
              onClick={() => onNavigate('settings')}
            >
              Settings
            </StudioButton>
          }
        >
          Fish Audio API key is not connected yet. You can still use External Gemini prompts or add your key in Settings for auto transcription.
        </StudioBanner>
      )}

      {errorMsg && <StudioBanner tone="error">{errorMsg}</StudioBanner>}
      {statusMsg && <StudioBanner tone="success">{statusMsg}</StudioBanner>}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
        {/* Left: Step 5 Preview & Quick Summary */}
        <div className="xl:col-span-5 space-y-4 xl:sticky xl:top-4">
          <StudioCard>
            <StudioSectionHeader
              stepNumber={5}
              title="Preview &amp; Apply"
              subtitle="Verify subtitle timing &amp; translated lines directly against the video frame."
              className="mb-3"
              actions={
                <label className="flex items-center gap-1.5 text-xs text-zinc-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(project.subtitleStyle.useTranslated)}
                    onChange={(e) => void togglePreviewTranslated(e.target.checked)}
                    className="accent-violet-500"
                  />
                  <span>Show Translated</span>
                </label>
              }
            />

            <VideoStudioPlayer
              project={project}
              currentTime={currentTime}
              onTimeUpdate={onTimeUpdate}
              videoRef={videoRef}
              previewEffects={previewEffects}
              onTogglePreviewEffects={onTogglePreviewEffects}
              drawMode="none"
            />

            <div className="mt-3 pt-3 border-t border-white/[0.08] flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="text-zinc-400 flex items-center gap-1.5">
                <Eye className="w-3.5 h-3.5 text-violet-400" />
                <span>
                  {project.subtitleStyle.useTranslated
                    ? `Previewing ${targetLanguage} captions`
                    : 'Previewing original transcript'}
                </span>
              </div>
              <StudioButton
                variant="success"
                size="sm"
                icon={<CheckCircle2 className="w-3.5 h-3.5" />}
                loading={busyApplySettings}
                onClick={() => void handleSaveAndMarkApplied()}
              >
                Apply Translation
              </StudioButton>
            </div>
          </StudioCard>

          {/* Collapsible Advanced Translation Settings */}
          <div className="rounded-xl bg-[#101015] border border-white/[0.08] overflow-hidden">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              aria-expanded={advancedOpen}
              className="w-full px-4 py-3 flex items-center justify-between text-xs font-semibold text-zinc-200 hover:text-white hover:bg-white/[0.03] cursor-pointer"
            >
              <span className="flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4 text-violet-400" />
                <span>Advanced Translation Rules</span>
              </span>
              {advancedOpen ? (
                <ChevronDown className="w-4 h-4 text-zinc-400" />
              ) : (
                <ChevronRight className="w-4 h-4 text-zinc-400" />
              )}
            </button>

            {advancedOpen && (
              <div className="px-4 pb-4 pt-2 border-t border-white/[0.08] space-y-2.5 text-xs text-zinc-300">
                <p className="text-[11px] text-zinc-400 leading-relaxed">
                  Dubbing-friendly length guards keep translated narration within the visual slot at constant 1.00x voice speed without rushing speech or distorting video frames.
                </p>
                <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
                  <div className="p-2 rounded-lg bg-[#16161D] border border-white/[0.07]">
                    <div className="text-zinc-500">Min / Max W/S</div>
                    <div className="text-zinc-100 mt-0.5">
                      {(project.translation.validationConfig?.minWordsPerSec ?? 2.0).toFixed(1)} –{' '}
                      {(project.translation.validationConfig?.maxWordsPerSec ?? 2.8).toFixed(1)} w/s
                    </div>
                  </div>
                  <div className="p-2 rounded-lg bg-[#16161D] border border-white/[0.07]">
                    <div className="text-zinc-500">Overflow Tolerance</div>
                    <div className="text-zinc-100 mt-0.5">
                      {(project.translation.validationConfig?.audioOverflowToleranceSec ?? 0.15).toFixed(2)}s
                    </div>
                  </div>
                </div>
                {project.translation.lastTranslatedAt && (
                  <div className="text-[11px] text-zinc-500 font-mono">
                    Last applied: {new Date(project.translation.lastTranslatedAt).toLocaleString()}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right: Steps 1 -> 2 -> 3 -> 4 */}
        <div className="xl:col-span-7 space-y-4">
          {/* Step 1: Source Language & Transcription */}
          <StudioCard>
            <StudioSectionHeader
              stepNumber={1}
              title="Source Language &amp; Transcription"
              subtitle="Detect spoken language and extract timestamped transcript segments from video audio."
              className="mb-3"
            />
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
              <div className="sm:col-span-7">
                <label className="text-[11px] text-zinc-400 block mb-1">Source Language</label>
                <select
                  value={sourceLanguage}
                  onChange={(e) => setSourceLanguage(e.target.value)}
                  className="w-full bg-[#17171F] border border-white/[0.09] rounded-lg px-3 py-2 text-xs text-zinc-100"
                >
                  {SOURCE_LANGUAGES.map((l) => (
                    <option key={l} value={l}>
                      {l === 'Auto' ? 'Auto-Detect' : l}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-5">
                <StudioButton
                  variant="secondary"
                  size="md"
                  className="w-full"
                  loading={busyTranscribe}
                  disabled={!project.sourceVideoUrl}
                  icon={<Mic className="w-3.5 h-3.5 text-violet-400" />}
                  onClick={() => void handleTranscribeSource()}
                >
                  {busyTranscribe ? 'Transcribing...' : 'Transcribe Source Audio'}
                </StudioButton>
              </div>
            </div>
          </StudioCard>

          {/* Step 2: Translation Engine */}
          <StudioCard>
            <StudioSectionHeader
              stepNumber={2}
              title="Translation Engine"
              subtitle="Choose External Gemini workflow (free copy/paste + pacing validator) or Automatic API translation."
              className="mb-3"
              actions={
                <StudioSegmentedControl
                  value={engineMode}
                  onChange={setEngineMode}
                  options={[
                    { value: 'external-gemini', label: 'External Gemini' },
                    { value: 'auto', label: 'Automatic API' },
                  ]}
                />
              }
            />

            {/* Step 3: Translation Settings (always visible cleanly) */}
            <div className="p-3 rounded-lg bg-[#16161D] border border-white/[0.07] space-y-2.5 mb-3">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                Step 3 · Translation Settings
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
                <div>
                  <label className="text-[11px] text-zinc-400 block mb-1">Target Language</label>
                  <select
                    value={targetLanguage}
                    onChange={(e) => setTargetLanguage(e.target.value as SupportedLanguage)}
                    className="w-full bg-[#0E0E13] border border-white/[0.09] rounded-lg px-3 py-2 text-xs text-zinc-100"
                  >
                    {TARGET_LANGUAGES.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                </div>

                <label className="flex items-center gap-2 min-h-[36px] text-xs text-zinc-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={preserveProperNouns}
                    onChange={(e) => setPreserveProperNouns(e.target.checked)}
                    className="accent-violet-500"
                  />
                  <span>Preserve character names &amp; terminology</span>
                </label>
              </div>
            </div>

            {engineMode === 'external-gemini' ? (
              <ExternalGeminiTranslatorPanel
                project={project}
                onProjectUpdated={onProjectUpdated}
                sourceLanguage={sourceLanguage}
                targetLanguage={targetLanguage}
                onChangeTargetLanguage={(nextLang) => setTargetLanguage(nextLang)}
                preserveProperNouns={preserveProperNouns}
                onChangePreserveProperNouns={setPreserveProperNouns}
                allowedTargetLanguages={TARGET_LANGUAGES}
                focusAudioOverflowSignal={initialFocusOverflow}
                onApprovedSuccess={(count, lang) => {
                  setStatusMsg(`Approved ${count} translated segment(s) in ${lang}.`);
                }}
              />
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <span className="text-xs text-zinc-400 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-violet-400" />
                  Uses server-side Gemini API for automatic segment localization.
                </span>
                <StudioButton
                  variant="primary"
                  size="md"
                  loading={busyTranslate}
                  disabled={project.captions.length === 0}
                  icon={<Wand2 className="w-3.5 h-3.5" />}
                  onClick={() => void handleAutoTranslate()}
                >
                  {busyTranslate ? 'Translating...' : `Translate to ${targetLanguage}`}
                </StudioButton>
              </div>
            )}
          </StudioCard>

          {/* Step 4: Translation Editor */}
          <StudioCard>
            <StudioSectionHeader
              stepNumber={4}
              title={`Translation Editor (${project.captions.length} segments)`}
              subtitle="Edit original and translated lines side by side with exact timestamps."
              className="mb-3"
              actions={
                <StudioButton
                  variant="secondary"
                  size="sm"
                  icon={<Plus className="w-3.5 h-3.5" />}
                  onClick={addSegment}
                >
                  Add Segment
                </StudioButton>
              }
            />

            {project.captions.length === 0 ? (
              <StudioEmptyState
                icon={<Languages className="w-5 h-5" />}
                title="No Transcript Segments Yet"
                description="Use Step 1 to transcribe the video audio, paste a validated JSON response in External Gemini mode, or add a segment manually."
                action={
                  <StudioButton
                    variant="primary"
                    size="sm"
                    icon={<Plus className="w-3.5 h-3.5" />}
                    onClick={addSegment}
                  >
                    Create First Segment
                  </StudioButton>
                }
              />
            ) : (
              <div className="max-h-[520px] overflow-y-auto space-y-2.5 pr-1">
                {project.captions.map((seg, idx) => {
                  const isActive = currentTime >= seg.start && currentTime <= seg.end;
                  const needsRegen = pendingRegenSet.has(seg.id);
                  const segClip = project.voice.generatedClips?.find(
                    (c) => c.segmentId === seg.id
                  );
                  const slotDur = segClip?.slotDuration ?? Math.max(0.2, seg.end - seg.start);
                  const overflow = segClip
                    ? segClip.overflowSeconds ??
                      Math.max(0, Math.round((segClip.duration - slotDur) * 100) / 100)
                    : 0;

                  return (
                    <div
                      key={seg.id}
                      className={`p-3 rounded-lg border space-y-2 ${
                        isActive
                          ? 'bg-violet-950/20 border-violet-500/45'
                          : overflow > 0.15
                          ? 'bg-amber-950/15 border-amber-500/35'
                          : 'bg-[#16161D] border-white/[0.07]'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => onSeek(seg.start)}
                            className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-[11px] font-mono text-violet-300 cursor-pointer"
                          >
                            #{idx + 1} · {formatTimecode(seg.start)}
                          </button>

                          {seg.speaker && (
                            <span className="text-[11px] text-zinc-400">{seg.speaker}</span>
                          )}

                          {needsRegen && (
                            <span className="text-[10.5px] font-mono text-violet-300 flex items-center gap-1">
                              <AlertCircle className="w-3 h-3" />
                              Needs voice regen
                            </span>
                          )}

                          {overflow > 0.15 && (
                            <span className="text-[10.5px] font-mono text-amber-300 flex items-center gap-1">
                              <AlertTriangle className="w-3 h-3" />
                              +{overflow.toFixed(1)}s over slot
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
                            aria-label="Segment start seconds"
                            className="w-16 bg-[#0E0E13] border border-white/[0.08] rounded px-1.5 py-0.5 text-[11px] font-mono text-zinc-200"
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
                            aria-label="Segment end seconds"
                            className="w-16 bg-[#0E0E13] border border-white/[0.08] rounded px-1.5 py-0.5 text-[11px] font-mono text-zinc-200"
                          />
                          <button
                            type="button"
                            onClick={() => removeSegment(seg.id)}
                            className="p-1 text-zinc-500 hover:text-red-400 cursor-pointer"
                            aria-label="Delete segment"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        <div>
                          <div className="text-[10px] text-zinc-500 mb-1">Original</div>
                          <textarea
                            rows={2}
                            value={seg.text}
                            onChange={(e) => updateSegment(seg.id, { text: e.target.value })}
                            placeholder="Original dialogue or narration..."
                            className="w-full bg-[#0E0E13] border border-white/[0.08] rounded-md px-2.5 py-1.5 text-xs text-zinc-100 resize-none"
                          />
                        </div>
                        <div>
                          <div className="text-[10px] text-zinc-500 mb-1">
                            Translated ({targetLanguage})
                          </div>
                          <textarea
                            rows={2}
                            value={seg.translatedText || ''}
                            onChange={(e) =>
                              updateSegment(seg.id, { translatedText: e.target.value })
                            }
                            placeholder={`${targetLanguage} script...`}
                            className="w-full bg-[#0E0E13] border border-white/[0.08] rounded-md px-2.5 py-1.5 text-xs text-zinc-100 resize-none"
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </StudioCard>
        </div>
      </div>
    </div>
  );
}
