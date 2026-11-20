import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  AudioWaveform,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Edit3,
  Languages,
  Loader2,
  Mic,
  Music,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Star,
  Square,
  Trash2,
  Volume2,
} from 'lucide-react';
import {
  FishVoiceModel,
  NavPage,
  Project,
  ProjectAudioWaveforms,
  ProjectPatchFn,
  RenderJob,
  SavedFishVoice,
  SupportedLanguage,
  VoiceConfig,
} from '../types/studio';
import { api } from '../lib/api';
import { formatTimecode } from '../lib/formatters';
import {
  createWorkflowUpdate,
  validateProjectReadyForEditor,
} from '../lib/workflowStages';
import { TimelineSyncCard } from '../components/TimelineSyncCard';
import { NarratorSelector } from '../components/NarratorSelector';
import { downloadProjectAsset, resolvePlayableAssetUrl } from '../lib/supabaseCloud';

interface VoiceStudioPageProps {
  project: Project;
  onProjectUpdated: (p: Project) => void;
  onPatchProject?: ProjectPatchFn;
  onFlushSaves?: (projectId?: string) => Promise<boolean>;
  onNavigate?: (page: NavPage) => void;
  onValidatedContinue?: (validatedProject: Project) => void;
  onRequestTranslationShorten?: () => void;
}

const DUB_TARGET_LANGUAGES: SupportedLanguage[] = [
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

function WaveformStrip({
  peaks,
  colorClass = 'bg-violet-400/75',
  heightClass = 'h-7',
  emptyLabel,
}: {
  peaks: number[];
  colorClass?: string;
  heightClass?: string;
  emptyLabel?: string;
}) {
  if (!peaks || peaks.length === 0) {
    return emptyLabel ? (
      <div
        className={`${heightClass} rounded-md bg-zinc-950/70 border border-white/[0.05] px-2 flex items-center text-[10px] font-mono text-zinc-600`}
      >
        {emptyLabel}
      </div>
    ) : null;
  }

  return (
    <div
      className={`${heightClass} rounded-md bg-zinc-950/80 border border-white/[0.06] px-1.5 py-1 flex items-center gap-[2px] overflow-hidden`}
      aria-hidden="true"
    >
      {peaks.map((pk, idx) => {
        const clamped = Math.max(0.08, Math.min(1, pk));
        return (
          <div
            key={idx}
            className={`flex-1 min-w-[2px] rounded-full ${colorClass}`}
            style={{ height: `${Math.round(clamped * 100)}%` }}
          />
        );
      })}
    </div>
  );
}

export function VoiceStudioPage({
  project,
  onProjectUpdated,
  onPatchProject,
  onFlushSaves,
  onNavigate,
  onValidatedContinue,
  onRequestTranslationShorten,
}: VoiceStudioPageProps) {
  const musicInputRef = useRef<HTMLInputElement>(null);
  const sfxInputRef = useRef<HTMLInputElement>(null);
  const segAudioRef = useRef<HTMLAudioElement | null>(null);

  const [playingSegmentId, setPlayingSegmentId] = useState<string | null>(null);
  const [busyValidate, setBusyValidate] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const [fishConfigured, setFishConfigured] = useState<boolean | null>(null);
  const [targetLanguage, setTargetLanguage] = useState<SupportedLanguage>(
    DUB_TARGET_LANGUAGES.includes(project.voice.targetLanguage)
      ? project.voice.targetLanguage
      : project.translation.targetLanguage || 'French'
  );

  // Progressive Disclosure Toggles
  const [voiceBrowserOpen, setVoiceBrowserOpen] = useState(false);
  const [savedLibraryOpen, setSavedLibraryOpen] = useState(true);
  const [syncOpen, setSyncOpen] = useState(true);

  // Fish Audio Voices Browser & Saved Voice Library
  const [voices, setVoices] = useState<FishVoiceModel[]>([]);
  const [voiceQuery, setVoiceQuery] = useState('');
  const [selfVoicesOnly, setSelfVoicesOnly] = useState(false);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [savedVoices, setSavedVoices] = useState<SavedFishVoice[]>([]);
  const [newVoiceName, setNewVoiceName] = useState('');
  const [newVoiceId, setNewVoiceId] = useState('');
  const [setAsDefaultOnSave, setSetAsDefaultOnSave] = useState(false);
  const [editingSavedVoiceId, setEditingSavedVoiceId] = useState<string | null>(null);
  const [editVoiceName, setEditVoiceName] = useState('');
  const [editVoiceId, setEditVoiceId] = useState('');
  const [busySavedVoice, setBusySavedVoice] = useState(false);

  // Operation States
  const [busyPreview, setBusyPreview] = useState(false);
  const [busyGenerate, setBusyGenerate] = useState(false);
  const [busyRegenSegments, setBusyRegenSegments] = useState(false);
  const [regeneratingSegmentId, setRegeneratingSegmentId] = useState<string | null>(null);
  const [busyMusic, setBusyMusic] = useState(false);
  const [busySfx, setBusySfx] = useState(false);

  const [previewAudioUrl, setPreviewAudioUrl] = useState<string | null>(null);
  const [resolvedFullDubUrl, setResolvedFullDubUrl] = useState<string | null>(null);
  const [audioWaveforms, setAudioWaveforms] = useState<ProjectAudioWaveforms | null>(null);
  const [activeDubJob, setActiveDubJob] = useState<RenderJob | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const voice = project.voice;

  useEffect(() => {
    const loadConfig = () => {
      void api
        .getSystemStatus()
        .then((s) => setFishConfigured(s.fishConfigured))
        .catch(() => setFishConfigured(null));
    };
    loadConfig();
    void api
      .listSavedFishVoices()
      .then(({ voices: sv }) => setSavedVoices(sv))
      .catch(() => {});

    window.addEventListener('focus', loadConfig);
    return () => window.removeEventListener('focus', loadConfig);
  }, []);

  useEffect(() => {
    setTargetLanguage(
      DUB_TARGET_LANGUAGES.includes(project.voice.targetLanguage)
        ? project.voice.targetLanguage
        : project.translation.targetLanguage || 'French'
    );
    setActiveDubJob(null);
    void api
      .listProjectJobs(project.id)
      .then(({ jobs }) => {
        const runningVoice = jobs.find(
          (j) => j.type === 'voice' && (j.status === 'queued' || j.status === 'processing')
        );
        if (runningVoice) {
          setActiveDubJob(runningVoice);
        }
      })
      .catch(() => {});
  }, [project.id, project.voice.targetLanguage, project.translation.targetLanguage]);

  // Resolve durable idb://blobs/... fullDubUrl to a playable browser URL
  useEffect(() => {
    let active = true;
    if (!project.voice.fullDubUrl) {
      setResolvedFullDubUrl(null);
      return;
    }
    void resolvePlayableAssetUrl(project.voice.fullDubUrl, project.cloudAssets)
      .then((url) => {
        if (active) setResolvedFullDubUrl(url || project.voice.fullDubUrl || null);
      })
      .catch(() => {
        if (active) setResolvedFullDubUrl(project.voice.fullDubUrl || null);
      });
    return () => {
      active = false;
    };
  }, [project.voice.fullDubUrl, project.cloudAssets]);

  // Fetch genuine PCM audio waveforms for dub track, per-segment clips, original audio, music, and SFX
  useEffect(() => {
    let cancelled = false;
    if (!project.id) {
      setAudioWaveforms(null);
      return;
    }
    void api
      .getAudioWaveforms(project.id)
      .then((res) => {
        if (!cancelled) setAudioWaveforms(res);
      })
      .catch(() => {
        if (!cancelled) setAudioWaveforms(null);
      });
    return () => {
      cancelled = true;
    };
  }, [
    project.id,
    project.sourceVideoUrl,
    project.voice.fullDubUrl,
    project.voice.generatedClips.length,
    project.voice.bgMusicUrl,
    project.voice.sfxUrl,
  ]);

  const loadFishVoices = async (opts?: { q?: string; self?: boolean }) => {
    setLoadingVoices(true);
    setVoicesError(null);
    try {
      const res = await api.listFishVoices({
        query: opts?.q ?? voiceQuery,
        selfOnly: opts?.self ?? selfVoicesOnly,
      });
      setVoices(res.voices);
    } catch (err) {
      setVoicesError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingVoices(false);
    }
  };

  useEffect(() => {
    if (fishConfigured) {
      void loadFishVoices();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fishConfigured]);

  // Poll active Fish Audio dubbing job
  useEffect(() => {
    if (
      !activeDubJob ||
      (activeDubJob.status !== 'queued' && activeDubJob.status !== 'processing')
    ) {
      return;
    }

    const timer = setInterval(async () => {
      try {
        const res = await api.getJob(activeDubJob.id);
        setActiveDubJob(res.job);
        if (res.job.status === 'completed') {
          const pRes = await api.getProject(project.id);
          const nextWorkflow = createWorkflowUpdate(pRes.project.workflow, {
            completeStage: 'voice',
            modifiedStage: 'voice',
            hasExistingExport: Boolean(pRes.project.lastExportUrl),
          });
          const { project: syncedProject } = await api.updateProject(project.id, {
            workflow: nextWorkflow,
          });
          onProjectUpdated(syncedProject);
          setStatusMsg(
            `Generated ${syncedProject.voice.generatedClips.length} narration clip(s).`
          );
        } else if (res.job.status === 'failed') {
          setErrorMsg(res.job.error || 'Voice generation failed.');
        }
      } catch {
        // ignore transient poll error
      }
    }, 700);

    return () => clearInterval(timer);
  }, [activeDubJob, project.id, onProjectUpdated]);

  const updateVoice = async (patch: Partial<VoiceConfig>) => {
    const nextVoice: VoiceConfig = { ...voice, ...patch, provider: 'fish' };
    const nextWorkflow = createWorkflowUpdate(project.workflow, {
      visitStage: 'voice',
      modifiedStage: 'voice',
      hasExistingExport: Boolean(project.lastExportUrl),
    });
    if (onPatchProject) {
      onPatchProject(
        project.id,
        (cur) => ({
          voice: { ...cur.voice, ...patch, provider: 'fish' },
          workflow: createWorkflowUpdate(cur.workflow, {
            visitStage: 'voice',
            modifiedStage: 'voice',
            hasExistingExport: Boolean(cur.lastExportUrl),
          }),
        }),
        { immediate: true }
      );
      return;
    }
    onProjectUpdated({ ...project, voice: nextVoice, workflow: nextWorkflow });
    const { project: saved } = await api.updateProject(project.id, {
      voice: nextVoice,
      workflow: nextWorkflow,
    });
    onProjectUpdated(saved);
  };

  const handleSaveFishVoice = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = newVoiceName.trim();
    const trimmedId = newVoiceId.trim();
    if (!trimmedName || !trimmedId) return;
    setErrorMsg(null);
    setBusySavedVoice(true);
    try {
      const res = await api.createSavedFishVoice({
        name: trimmedName,
        voiceId: trimmedId,
        isDefault: setAsDefaultOnSave,
      });
      setSavedVoices(res.voices);
      setNewVoiceName('');
      setNewVoiceId('');
      setSetAsDefaultOnSave(false);
      await updateVoice({
        fishReferenceId: res.voice.voiceId,
        fishVoiceTitle: res.voice.name,
      });
      setStatusMsg(`Saved voice "${res.voice.name}".`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySavedVoice(false);
    }
  };

  const handleUseSavedVoice = async (savedVoice: SavedFishVoice) => {
    await updateVoice({
      fishReferenceId: savedVoice.voiceId,
      fishVoiceTitle: savedVoice.name,
    });
    setStatusMsg(`Voice selected: ${savedVoice.name}`);
  };

  const handleSetDefaultSavedVoice = async (savedVoice: SavedFishVoice) => {
    setErrorMsg(null);
    setBusySavedVoice(true);
    try {
      const res = await api.updateSavedFishVoice(savedVoice.id, { isDefault: true });
      setSavedVoices(res.voices);
      await updateVoice({
        fishReferenceId: savedVoice.voiceId,
        fishVoiceTitle: savedVoice.name,
      });
      setStatusMsg(`Set "${savedVoice.name}" as default.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySavedVoice(false);
    }
  };

  const handleSaveEditedSavedVoice = async (id: string) => {
    const trimmedName = editVoiceName.trim();
    const trimmedId = editVoiceId.trim();
    if (!trimmedName || !trimmedId) return;
    setErrorMsg(null);
    setBusySavedVoice(true);
    try {
      const oldVoice = savedVoices.find((v) => v.id === id);
      const res = await api.updateSavedFishVoice(id, {
        name: trimmedName,
        voiceId: trimmedId,
      });
      setSavedVoices(res.voices);
      setEditingSavedVoiceId(null);
      if (oldVoice && voice.fishReferenceId === oldVoice.voiceId) {
        await updateVoice({
          fishReferenceId: res.voice.voiceId,
          fishVoiceTitle: res.voice.name,
        });
      }
      setStatusMsg(`Updated voice "${res.voice.name}".`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySavedVoice(false);
    }
  };

  const handleDeleteSavedVoice = async (savedVoice: SavedFishVoice) => {
    setErrorMsg(null);
    setBusySavedVoice(true);
    try {
      const res = await api.deleteSavedFishVoice(savedVoice.id);
      setSavedVoices(res.voices);
      if (editingSavedVoiceId === savedVoice.id) {
        setEditingSavedVoiceId(null);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySavedVoice(false);
    }
  };

  const handlePreviewVoice = async () => {
    setErrorMsg(null);
    setBusyPreview(true);
    try {
      const firstSeg = project.captions[0];
      const sampleText =
        (firstSeg && (firstSeg.translatedText || firstSeg.text)) ||
        (targetLanguage === 'French'
          ? 'Tout a bascule au moment ou la porte du coffre s est ouverte en silence.'
          : targetLanguage === 'Arabic'
          ? 'تغير كل شيء في اللحة التي انفتح فيها باب الخزنة في صمت تام.'
          : targetLanguage === 'Spanish'
          ? 'Todo cambio en el momento en que la puerta de la boveda se abrio en silencio.'
          : targetLanguage === 'German'
          ? 'Alles anderte sich in dem Moment, als sich die Tresortur lautlos offnete.'
          : targetLanguage === 'Portuguese'
          ? 'Tudo mudou no momento em que a porta do cofre se abriu em silencio.'
          : 'Everything changed the moment the vault door swung open in silence.');

      const res = await api.previewFishDub(project.id, {
        text: sampleText,
        referenceId: voice.fishReferenceId,
        speakingSpeed: 1.0,
      });
      setPreviewAudioUrl(res.audioUrl);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyPreview(false);
    }
  };

  const handleGenerateDub = async () => {
    setErrorMsg(null);
    setStatusMsg(null);
    setBusyGenerate(true);
    try {
      const hasTranslations = project.captions.some((c) => Boolean(c.translatedText?.trim()));
      const res = await api.generateFishDub(project.id, {
        voice: { ...voice, targetLanguage, provider: 'fish', speakingSpeed: 1.0, enabled: true },
        captions: project.captions,
        useTranslated: hasTranslations,
      });
      setActiveDubJob(res.job);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyGenerate(false);
    }
  };

  const handleRegenerateSelectedSegments = async (segmentIds: string[]) => {
    if (segmentIds.length === 0) return;
    setErrorMsg(null);
    setStatusMsg(null);
    setBusyRegenSegments(true);
    if (segmentIds.length === 1) {
      setRegeneratingSegmentId(segmentIds[0]);
    }
    try {
      const hasTranslations = project.captions.some((c) => Boolean(c.translatedText?.trim()));
      const res = await api.regenerateFishSegments(project.id, {
        segmentIds,
        captions: project.captions,
        voice: { ...voice, targetLanguage, provider: 'fish', speakingSpeed: 1.0, enabled: true },
        useTranslated: hasTranslations,
      });
      onProjectUpdated(res.project);
      setStatusMsg(`Regenerated ${res.regeneratedIds.length} segment(s).`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyRegenSegments(false);
      setRegeneratingSegmentId(null);
    }
  };

  const handleMusicUpload = async (file: File) => {
    setErrorMsg(null);
    setBusyMusic(true);
    try {
      const res = await api.uploadMusic(project.id, file);
      onProjectUpdated(res.project);
      setStatusMsg(`Loaded background music "${file.name}".`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMusic(false);
    }
  };

  const handleSfxUpload = async (file: File) => {
    setErrorMsg(null);
    setBusySfx(true);
    try {
      const res = await api.uploadSfx(project.id, file);
      onProjectUpdated(res.project);
      setStatusMsg(`Loaded sound effect "${file.name}".`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySfx(false);
    }
  };

  const isDubGenerating =
    busyGenerate ||
    Boolean(
      activeDubJob &&
        (activeDubJob.status === 'queued' || activeDubJob.status === 'processing')
    );

  const pendingRegenIds = project.translation.pendingRegenerateSegmentIds || [];

  const syncWarnings = (voice.generatedClips || [])
    .map((clip, idx) => {
      const slotDur = clip.slotDuration ?? Math.max(0.2, clip.end - clip.start);
      const overflow =
        clip.overflowSeconds ?? Math.max(0, Math.round((clip.duration - slotDur) * 100) / 100);
      return { clip, idx, slotDur, overflow };
    })
    .filter((item) => item.overflow > 0.15);

  const toggleSegmentAudioPreview = async (segmentId: string, audioUrl: string) => {
    if (playingSegmentId === segmentId && segAudioRef.current) {
      segAudioRef.current.pause();
      setPlayingSegmentId(null);
      return;
    }
    if (segAudioRef.current) {
      segAudioRef.current.pause();
    }
    const playableUrl =
      (await resolvePlayableAssetUrl(audioUrl, project.cloudAssets).catch(() => null)) || audioUrl;
    const audio = new Audio(playableUrl);
    segAudioRef.current = audio;
    setPlayingSegmentId(segmentId);
    audio.onended = () => setPlayingSegmentId(null);
    audio.onerror = () => {
      setPlayingSegmentId(null);
      setErrorMsg('Unable to play generated audio for this segment.');
    };
    void audio.play().catch(() => {
      setPlayingSegmentId(null);
      setErrorMsg('Browser blocked audio preview playback.');
    });
  };

  useEffect(() => {
    return () => {
      segAudioRef.current?.pause();
    };
  }, []);

  const validation = validateProjectReadyForEditor(project, activeDubJob?.status ?? null);

  useEffect(() => {
    if (validation.valid && validationError) {
      setValidationError(null);
    }
  }, [validation.valid, validationError]);

  const handleValidateAndContinue = async () => {
    setErrorMsg(null);
    setValidationError(null);

    const check = validateProjectReadyForEditor(project, activeDubJob?.status ?? null);
    if (!check.valid) {
      setValidationError(check.errors.join(' '));
      return;
    }

    setBusyValidate(true);
    try {
      await onFlushSaves?.(project.id);
      const nextWorkflow = createWorkflowUpdate(project.workflow, {
        completeStage: 'voice',
        visitStage: 'editor',
        clearAttentionFor: 'voice',
        hasExistingExport: Boolean(project.lastExportUrl),
      });
      const nextVoice: VoiceConfig = {
        ...project.voice,
        provider: 'fish',
        speakingSpeed: 1.0,
        enabled: true,
      };
      const { project: saved } = await api.updateProject(project.id, {
        voice: nextVoice,
        workflow: nextWorkflow,
      });
      onProjectUpdated(saved);
      if (onValidatedContinue) {
        onValidatedContinue(saved);
      } else {
        onNavigate?.('editor');
      }
    } catch (err) {
      setValidationError(
        err instanceof Error ? err.message : 'Failed to validate voice & audio setup.'
      );
    } finally {
      setBusyValidate(false);
    }
  };

  const origPeaks = audioWaveforms?.orig?.length
    ? audioWaveforms.orig
    : project.waveformPeaks || [];
  const dubPeaks = audioWaveforms?.dub || [];
  const bgmPeaks = audioWaveforms?.bgm || [];
  const sfxPeaks = audioWaveforms?.sfx || [];

  return (
    <div className="p-3 sm:p-5 max-w-[1560px] mx-auto space-y-4">
      {/* Header with Readiness Summary & Single Primary Validate CTA */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b border-white/[0.08] pb-3.5">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="px-2 py-0.5 rounded bg-violet-600/20 border border-violet-500/40 text-[11px] font-mono font-semibold text-violet-200">
              STEP 2
            </span>
            <h1 className="text-lg sm:text-xl font-display font-bold tracking-tight text-white">
              Voice Studio
            </h1>
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono">
              <span
                className={`px-2 py-0.5 rounded border ${
                  validation.translationValid
                    ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                    : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                }`}
              >
                {validation.summary.translatedCount}/{validation.summary.totalSegments} translated
              </span>
              <span
                className={`px-2 py-0.5 rounded border ${
                  validation.audioCompleted
                    ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                    : 'bg-zinc-900 border-white/[0.08] text-zinc-400'
                }`}
              >
                {isDubGenerating
                  ? 'Generating audio...'
                  : validation.audioCompleted
                  ? `${validation.summary.matchedAudioCount}/${validation.summary.totalSegments} clips ready`
                  : 'Audio pending'}
              </span>
            </div>
          </div>
          <p className="text-xs text-zinc-400">
            Audio-focused workspace for Fish Audio voice selection, narration dubbing, PCM waveform inspection, audio mixing, and timeline sync.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {onNavigate && (
            <button
              type="button"
              onClick={() => onNavigate('translator')}
              className="min-h-[40px] px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-white/[0.08] text-xs font-medium text-zinc-200 flex items-center gap-1.5 cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Edit Translation</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => void handleValidateAndContinue()}
            disabled={busyValidate}
            className="min-h-[40px] px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-xs sm:text-sm font-semibold text-white flex items-center justify-center gap-2 shrink-0 cursor-pointer shadow-lg shadow-violet-600/25"
          >
            {busyValidate ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <CheckCircle2 className="w-4 h-4" />
            )}
            <span>VALIDATE &amp; CONTINUE TO VIDEO EDITOR</span>
          </button>
        </div>
      </div>

      {/* Step 1 Translation Readiness Notice if script is incomplete */}
      {!validation.translationValid && (
        <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-center gap-2">
            <Languages className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              {project.captions.length === 0
                ? 'No script segments yet. Complete Step 1 (Translation Studio) first to transcribe and translate your script.'
                : `${validation.summary.totalSegments - validation.summary.translatedCount} segment(s) still missing translated text in Step 1 (Translation Studio).`}
            </span>
          </div>
          {onNavigate && (
            <button
              type="button"
              onClick={() => onNavigate('translator')}
              className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-xs font-semibold text-amber-100 flex items-center gap-1.5 shrink-0 cursor-pointer"
            >
              <Languages className="w-3.5 h-3.5" />
              <span>Open Translation Studio</span>
            </button>
          )}
        </div>
      )}

      {/* Actionable Banners */}
      {fishConfigured === false && (
        <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              Fish Audio API key is not connected. Add it in Settings to synthesize voices.
            </span>
          </div>
          {onNavigate && (
            <button
              type="button"
              onClick={() => onNavigate('settings')}
              className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-xs font-semibold text-amber-100 flex items-center gap-1.5 shrink-0 cursor-pointer"
            >
              <Settings className="w-3.5 h-3.5" />
              <span>Open Settings</span>
            </button>
          )}
        </div>
      )}

      {validationError && (
        <div
          role="alert"
          className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-200 flex items-start gap-2"
        >
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <span>{validationError}</span>
        </div>
      )}

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

      {/* Audio-Focused Two-Column Workspace (NO Video Player) */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
        {/* LEFT COLUMN: Voice Selection, Generation Controls, Saved Narrators & Voice IDs */}
        <div className="xl:col-span-5 space-y-3.5">
          {/* Voice Selection & Generation Card */}
          <section className="p-4 rounded-xl bg-[#111115] border border-white/[0.08] space-y-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-display font-semibold text-white flex items-center gap-2">
                <Mic className="w-4 h-4 text-violet-400" />
                Voice Selection &amp; Generation
              </h2>

              <button
                type="button"
                onClick={() => setVoiceBrowserOpen((v) => !v)}
                className="text-xs font-medium text-violet-300 hover:text-violet-200 flex items-center gap-1 cursor-pointer"
              >
                <Search className="w-3.5 h-3.5" />
                <span>{voiceBrowserOpen ? 'Hide Voice Catalog' : 'Browse Fish Voices'}</span>
              </button>
            </div>

            <NarratorSelector
              savedVoices={savedVoices}
              catalogVoices={voices}
              selectedVoiceId={voice.fishReferenceId}
              selectedVoiceTitle={voice.fishVoiceTitle}
              onSelectVoice={(voiceId, voiceTitle) => {
                void updateVoice({
                  fishReferenceId: voiceId,
                  fishVoiceTitle: voiceTitle,
                });
              }}
              onOpenSettings={() => onNavigate?.('settings')}
            />

            {/* Voice Target Language, Style, Speed & Direct Voice ID */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label className="text-[11px] text-zinc-400">Dubbing Language</label>
                <select
                  value={targetLanguage}
                  onChange={(e) => {
                    const nextLang = e.target.value as SupportedLanguage;
                    setTargetLanguage(nextLang);
                    void updateVoice({ targetLanguage: nextLang });
                  }}
                  className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-zinc-100 cursor-pointer"
                >
                  {DUB_TARGET_LANGUAGES.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-[11px] text-zinc-400">Narration Style</label>
                <select
                  value={voice.narrationStyle || 'cinematic'}
                  onChange={(e) =>
                    void updateVoice({
                      narrationStyle: e.target.value as 'cinematic' | 'natural',
                    })
                  }
                  className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-zinc-100 cursor-pointer"
                >
                  <option value="cinematic">Cinematic</option>
                  <option value="natural">Natural</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 items-end">
              <div>
                <label className="text-[11px] text-zinc-400">Direct Voice ID</label>
                <input
                  type="text"
                  value={voice.fishReferenceId || ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    const match = savedVoices.find((s) => s.voiceId === val.trim());
                    onProjectUpdated({
                      ...project,
                      voice: {
                        ...voice,
                        fishReferenceId: val,
                        fishVoiceTitle: match
                          ? match.name
                          : val
                          ? `Voice Reference ${val.slice(0, 8)}...`
                          : 'Default Fish Audio Voice',
                      },
                    });
                  }}
                  onBlur={(e) => {
                    const trimmed = e.target.value.trim();
                    const match = savedVoices.find((s) => s.voiceId === trimmed);
                    void updateVoice({
                      fishReferenceId: trimmed,
                      fishVoiceTitle: match
                        ? match.name
                        : trimmed
                        ? `Voice Reference ${trimmed.slice(0, 8)}...`
                        : 'Default Fish Audio Voice (s2.1-pro-free)',
                    });
                  }}
                  placeholder="Paste reference_id..."
                  className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs font-mono text-zinc-100 placeholder:text-zinc-600"
                />
              </div>

              <div className="px-2.5 py-1.5 rounded-lg bg-zinc-900/70 border border-white/[0.06] flex items-center justify-between text-[11px]">
                <span className="text-zinc-400">Voice Speed</span>
                <span className="font-mono font-semibold text-zinc-200">
                  {(voice.speakingSpeed || 1.0).toFixed(2)}x (Constant)
                </span>
              </div>
            </div>

            {/* Expandable Fish Audio Catalog Browser */}
            {voiceBrowserOpen && (
              <div className="p-3 rounded-lg bg-[#16161B] border border-white/[0.07] space-y-2.5">
                <div className="flex flex-wrap gap-2">
                  <div className="relative flex-1 min-w-[150px]">
                    <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={voiceQuery}
                      onChange={(e) => setVoiceQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void loadFishVoices({ q: voiceQuery });
                      }}
                      placeholder="Search Fish Audio voices..."
                      className="w-full bg-zinc-900 border border-white/[0.08] rounded-lg pl-8 pr-3 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500"
                    />
                  </div>

                  <label className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-white/[0.08] text-[11px] text-zinc-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selfVoicesOnly}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setSelfVoicesOnly(checked);
                        void loadFishVoices({ self: checked });
                      }}
                      className="accent-violet-500"
                    />
                    My Voices
                  </label>

                  <button
                    type="button"
                    onClick={() => void loadFishVoices()}
                    disabled={loadingVoices}
                    className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-200 flex items-center gap-1.5 cursor-pointer"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${loadingVoices ? 'animate-spin' : ''}`} />
                    Fetch
                  </button>
                </div>

                {voicesError && (
                  <div className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-1.5">
                    {voicesError}
                  </div>
                )}

                {voices.length > 0 && (
                  <div className="max-h-44 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-1.5 pr-1">
                    <button
                      type="button"
                      onClick={() =>
                        void updateVoice({
                          fishReferenceId: '',
                          fishVoiceTitle: 'Default Fish Audio Voice (s2.1-pro-free)',
                        })
                      }
                      className={`text-left p-2 rounded-lg border text-xs transition-colors cursor-pointer ${
                        !voice.fishReferenceId
                          ? 'bg-violet-600/20 border-violet-500/60 text-white'
                          : 'bg-zinc-900 border-white/[0.06] text-zinc-300 hover:border-white/20'
                      }`}
                    >
                      <div className="font-medium truncate">Default Neutral Narrator</div>
                      <div className="text-[10px] text-zinc-500 font-mono">Built-in</div>
                    </button>

                    {voices.map((v) => {
                      const selected = voice.fishReferenceId === v.id;
                      return (
                        <button
                          key={v.id}
                          type="button"
                          onClick={() =>
                            void updateVoice({
                              fishReferenceId: v.id,
                              fishVoiceTitle: v.title,
                            })
                          }
                          className={`text-left p-2 rounded-lg border text-xs transition-colors cursor-pointer ${
                            selected
                              ? 'bg-violet-600/20 border-violet-500/60 text-white'
                              : 'bg-zinc-900 border-white/[0.06] text-zinc-300 hover:border-white/20'
                          }`}
                        >
                          <div className="font-medium truncate">{v.title}</div>
                          <div className="text-[10px] text-zinc-500 truncate">
                            {v.author} {v.languages.length > 0 ? `· ${v.languages.join(', ')}` : ''}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Generation Action Buttons */}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => void handlePreviewVoice()}
                disabled={busyPreview}
                className="min-h-[40px] px-3.5 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-xs font-medium text-zinc-100 flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                {busyPreview ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5 text-violet-400" />
                )}
                <span>Preview Sample</span>
              </button>

              <button
                type="button"
                onClick={() => void handleGenerateDub()}
                disabled={isDubGenerating || project.captions.length === 0}
                className="flex-1 min-h-[40px] px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center justify-center gap-2 whitespace-nowrap cursor-pointer shadow-md shadow-violet-600/20"
              >
                {isDubGenerating ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Mic className="w-3.5 h-3.5" />
                )}
                <span>
                  {isDubGenerating
                    ? `Generating (${Math.round(activeDubJob?.progress || 0)}%)...`
                    : voice.fullDubUrl
                    ? 'Regenerate Full Voiceover'
                    : 'Generate Voice'}
                </span>
              </button>
            </div>

            {/* Active Generation Progress */}
            {activeDubJob && (
              <div className="space-y-1">
                <div className="flex justify-between gap-2 text-[11px] font-mono text-zinc-400">
                  <span className="truncate">{activeDubJob.stage}</span>
                  <span className="shrink-0">
                    {Math.round(activeDubJob.progress)}%
                    {activeDubJob.etaSeconds !== null && activeDubJob.etaSeconds > 0
                      ? ` · ~${activeDubJob.etaSeconds}s`
                      : ''}
                  </span>
                </div>
                <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all ${
                      activeDubJob.status === 'failed'
                        ? 'bg-red-500'
                        : activeDubJob.status === 'completed'
                        ? 'bg-emerald-500'
                        : 'bg-violet-500'
                    }`}
                    style={{ width: `${activeDubJob.progress}%` }}
                  />
                </div>
              </div>
            )}

            {/* Conditional Selective Regeneration Prompt */}
            {pendingRegenIds.length > 0 && (
              <div className="p-2.5 rounded-lg bg-violet-500/10 border border-violet-500/35 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-violet-200">
                  {pendingRegenIds.length} edited segment(s) need audio regeneration.
                </span>
                <button
                  type="button"
                  onClick={() => void handleRegenerateSelectedSegments(pendingRegenIds)}
                  disabled={busyRegenSegments}
                  className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center gap-1.5 shrink-0 cursor-pointer"
                >
                  {busyRegenSegments ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5" />
                  )}
                  Regenerate ({pendingRegenIds.length})
                </button>
              </div>
            )}

            {/* Conditional Audio Overflow Fix Banner */}
            {syncWarnings.length > 0 && (
              <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 space-y-2">
                <div className="flex items-center gap-2 text-xs text-amber-200">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>
                    {syncWarnings.length} segment{syncWarnings.length === 1 ? '' : 's'} exceed slot duration
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {onNavigate && (
                    <button
                      type="button"
                      onClick={() => {
                        onRequestTranslationShorten?.();
                        onNavigate('translator');
                      }}
                      className="px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-[11px] font-semibold text-amber-100 flex items-center gap-1 cursor-pointer"
                    >
                      <Sparkles className="w-3 h-3 text-amber-300" />
                      Shorten in Translation Studio
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      void handleRegenerateSelectedSegments(
                        syncWarnings.map((w) => w.clip.segmentId)
                      )
                    }
                    disabled={busyRegenSegments}
                    className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/[0.08] text-[11px] font-medium text-zinc-200 flex items-center gap-1 cursor-pointer"
                  >
                    <RefreshCw className={`w-3 h-3 ${busyRegenSegments ? 'animate-spin' : ''}`} />
                    Regenerate ({syncWarnings.length})
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* Saved Narrators & Voice IDs Library */}
          <section className="rounded-xl bg-[#111115] border border-white/[0.08] overflow-hidden">
            <button
              type="button"
              onClick={() => setSavedLibraryOpen((v) => !v)}
              aria-expanded={savedLibraryOpen}
              className="w-full px-4 py-3 flex items-center justify-between text-xs font-semibold text-zinc-200 hover:text-white hover:bg-white/[0.03] cursor-pointer"
            >
              <span className="flex items-center gap-2">
                <Star className="w-4 h-4 text-amber-400" />
                <span>Saved Narrators &amp; Voice IDs ({savedVoices.length})</span>
              </span>
              {savedLibraryOpen ? (
                <ChevronDown className="w-4 h-4 text-zinc-400" />
              ) : (
                <ChevronRight className="w-4 h-4 text-zinc-400" />
              )}
            </button>

            {savedLibraryOpen && (
              <div className="p-3.5 pt-2 border-t border-white/[0.08] space-y-2.5">
                {savedVoices.length > 0 && (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                    {savedVoices.map((sv) => {
                      const isSelected = voice.fishReferenceId === sv.voiceId;
                      const isEditing = editingSavedVoiceId === sv.id;

                      if (isEditing) {
                        return (
                          <div
                            key={sv.id}
                            className="p-2 rounded-lg bg-zinc-900 border border-violet-500/40 space-y-2"
                          >
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              <input
                                type="text"
                                value={editVoiceName}
                                onChange={(e) => setEditVoiceName(e.target.value)}
                                placeholder="Voice name"
                                className="bg-[#111115] border border-white/[0.08] rounded px-2 py-1 text-xs text-zinc-100"
                              />
                              <input
                                type="text"
                                value={editVoiceId}
                                onChange={(e) => setEditVoiceId(e.target.value)}
                                placeholder="Fish Audio Voice ID"
                                className="bg-[#111115] border border-white/[0.08] rounded px-2 py-1 text-xs font-mono text-zinc-100"
                              />
                            </div>
                            <div className="flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => setEditingSavedVoiceId(null)}
                                className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-[11px] text-zinc-300 cursor-pointer"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                disabled={
                                  busySavedVoice || !editVoiceName.trim() || !editVoiceId.trim()
                                }
                                onClick={() => void handleSaveEditedSavedVoice(sv.id)}
                                className="px-2.5 py-1 rounded bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-[11px] font-semibold text-white flex items-center gap-1 cursor-pointer"
                              >
                                <Check className="w-3 h-3" />
                                Save
                              </button>
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div
                          key={sv.id}
                          className={`px-2.5 py-1.5 rounded-lg border flex items-center justify-between gap-2 text-xs ${
                            isSelected
                              ? 'bg-violet-600/15 border-violet-500/50 text-white'
                              : 'bg-zinc-900/70 border-white/[0.06] text-zinc-300'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => void handleUseSavedVoice(sv)}
                            className="flex-1 text-left min-w-0 cursor-pointer"
                          >
                            <div className="font-medium truncate flex items-center gap-1.5">
                              <span>{sv.name}</span>
                              {sv.isDefault && (
                                <span className="text-[10px] font-mono text-amber-300">
                                  Default
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] font-mono text-zinc-500 truncate">
                              {sv.voiceId}
                            </div>
                          </button>

                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => void handleSetDefaultSavedVoice(sv)}
                              title="Set as default voice"
                              className={`p-1 rounded hover:bg-zinc-800 cursor-pointer ${
                                sv.isDefault
                                  ? 'text-amber-400'
                                  : 'text-zinc-500 hover:text-amber-300'
                              }`}
                            >
                              <Star
                                className={`w-3.5 h-3.5 ${sv.isDefault ? 'fill-amber-400' : ''}`}
                              />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingSavedVoiceId(sv.id);
                                setEditVoiceName(sv.name);
                                setEditVoiceId(sv.voiceId);
                              }}
                              title="Edit saved voice"
                              className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 cursor-pointer"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDeleteSavedVoice(sv)}
                              title="Delete saved voice"
                              className="p-1 rounded text-zinc-500 hover:text-red-400 hover:bg-zinc-800 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                <form
                  onSubmit={handleSaveFishVoice}
                  className="pt-2 border-t border-white/[0.06] space-y-2"
                >
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <input
                      type="text"
                      value={newVoiceName}
                      onChange={(e) => setNewVoiceName(e.target.value)}
                      placeholder="Custom voice name"
                      className="bg-zinc-900 border border-white/[0.08] rounded-md px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500"
                    />
                    <input
                      type="text"
                      value={newVoiceId}
                      onChange={(e) => setNewVoiceId(e.target.value)}
                      placeholder="Fish voiceId"
                      className="bg-zinc-900 border border-white/[0.08] rounded-md px-2.5 py-1.5 text-xs font-mono text-zinc-100 placeholder:text-zinc-500"
                    />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="flex items-center gap-1.5 text-[11px] text-zinc-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={setAsDefaultOnSave}
                        onChange={(e) => setSetAsDefaultOnSave(e.target.checked)}
                        className="accent-violet-500"
                      />
                      Default for new projects
                    </label>
                    <button
                      type="submit"
                      disabled={busySavedVoice || !newVoiceName.trim() || !newVoiceId.trim()}
                      className="px-3 py-1.5 rounded-md bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Save Voice
                    </button>
                  </div>
                </form>
              </div>
            )}
          </section>
        </div>

        {/* RIGHT COLUMN: Audio Preview & Waveforms, Audio Processing/Mixing, Synchronization & Segments */}
        <div className="xl:col-span-7 space-y-3.5">
          {/* Audio Preview & Waveform Deck */}
          <section className="p-4 rounded-xl bg-[#111115] border border-white/[0.08] space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-display font-semibold text-white flex items-center gap-2">
                <AudioWaveform className="w-4 h-4 text-violet-400" />
                Audio Preview &amp; Waveforms
              </h2>
              <span className="text-[11px] font-mono text-zinc-400">
                {voice.fishVoiceTitle || 'Default Fish Audio Voice'}
              </span>
            </div>

            {previewAudioUrl && (
              <div className="p-3 rounded-lg bg-[#18181D] border border-white/[0.06] space-y-1.5">
                <div className="text-[11px] font-medium text-zinc-300">Sample Voice Preview</div>
                <audio src={previewAudioUrl} controls autoPlay className="w-full h-9" />
              </div>
            )}

            {voice.fullDubUrl ? (
              <div className="p-3 rounded-lg bg-[#18181D] border border-emerald-500/25 space-y-2">
                <div className="text-[11px] font-medium text-emerald-300 flex items-center justify-between gap-2">
                  <span>
                    Full Dub Track ({voice.generatedClips.length} clips ·{' '}
                    {validation.summary.totalAudioDuration.toFixed(1)}s speech)
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (!voice.fullDubUrl) return;
                      const ext = voice.fullDubUrl.toLowerCase().endsWith('.wav') ? 'wav' : 'mp3';
                      void downloadProjectAsset({
                        url: voice.fullDubUrl,
                        cloudAssets: project.cloudAssets,
                        filename: `${project.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_dub.${ext}`,
                      }).catch((err) => setErrorMsg(err instanceof Error ? err.message : String(err)));
                    }}
                    className="font-mono text-violet-300 hover:text-violet-200 cursor-pointer"
                  >
                    Download Audio
                  </button>
                </div>
                <WaveformStrip
                  peaks={dubPeaks}
                  colorClass="bg-emerald-400/80"
                  heightClass="h-8"
                  emptyLabel="Narration waveform ready"
                />
                {resolvedFullDubUrl && (
                  <audio src={resolvedFullDubUrl} controls className="w-full h-9" />
                )}
              </div>
            ) : (
              <div className="p-3 rounded-lg bg-[#09090B] border border-white/[0.06] text-xs text-zinc-500 flex items-center justify-between gap-2">
                <span>No full dub track generated yet. Click &quot;Generate Voice&quot; to synthesize narration.</span>
              </div>
            )}

            {/* Original Audio & Music/SFX Waveforms */}
            {(origPeaks.length > 0 || bgmPeaks.length > 0 || sfxPeaks.length > 0) && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                {origPeaks.length > 0 && (
                  <div className="p-2.5 rounded-lg bg-[#16161B] border border-white/[0.06] space-y-1">
                    <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400">
                      <span>Original Audio Waveform</span>
                      <span>
                        {voice.preserveOriginalAudio
                          ? `${Math.round(voice.originalAudioVolume * 100)}%`
                          : 'Muted'}
                      </span>
                    </div>
                    <WaveformStrip peaks={origPeaks} colorClass="bg-sky-400/70" heightClass="h-6" />
                  </div>
                )}

                {bgmPeaks.length > 0 && (
                  <div className="p-2.5 rounded-lg bg-[#16161B] border border-white/[0.06] space-y-1">
                    <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400">
                      <span className="truncate">{voice.bgMusicFilename || 'Background Music'}</span>
                      <span>{Math.round(voice.bgMusicVolume * 100)}%</span>
                    </div>
                    <WaveformStrip peaks={bgmPeaks} colorClass="bg-amber-400/75" heightClass="h-6" />
                  </div>
                )}

                {sfxPeaks.length > 0 && (
                  <div className="p-2.5 rounded-lg bg-[#16161B] border border-white/[0.06] space-y-1">
                    <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400">
                      <span className="truncate">{voice.sfxFilename || 'Sound Effect'}</span>
                      <span>{Math.round((voice.sfxVolume ?? 1) * 100)}%</span>
                    </div>
                    <WaveformStrip peaks={sfxPeaks} colorClass="bg-pink-400/75" heightClass="h-6" />
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Audio Processing & Mixing Controls */}
          <section className="p-4 rounded-xl bg-[#111115] border border-white/[0.08] space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-display font-semibold text-white flex items-center gap-2">
                <Volume2 className="w-4 h-4 text-violet-400" />
                Audio Processing &amp; Mixing
              </h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <div className="flex justify-between text-[11px] text-zinc-400">
                  <span>Narrator Volume</span>
                  <span className="font-mono text-zinc-200">
                    {Math.round(voice.voiceVolume * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0.1}
                  max={1.8}
                  step={0.05}
                  value={voice.voiceVolume}
                  onChange={(e) => void updateVoice({ voiceVolume: Number(e.target.value) })}
                  className="mt-1 w-full accent-violet-500"
                />
              </div>

              <div>
                <div className="flex justify-between text-[11px] text-zinc-400">
                  <span>Timing Offset</span>
                  <span className="font-mono text-zinc-200">
                    {voice.timingOffsetSec >= 0 ? '+' : ''}
                    {(voice.timingOffsetSec || 0).toFixed(2)}s
                  </span>
                </div>
                <input
                  type="range"
                  min={-2.5}
                  max={2.5}
                  step={0.05}
                  value={voice.timingOffsetSec || 0}
                  onChange={(e) =>
                    void updateVoice({ timingOffsetSec: Number(e.target.value) })
                  }
                  className="mt-1 w-full accent-violet-500"
                />
              </div>

              <div>
                <div className="flex justify-between text-[11px] text-zinc-400">
                  <span>Fade In</span>
                  <span className="font-mono text-zinc-200">
                    {(voice.fadeInSec || 0).toFixed(1)}s
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={5}
                  step={0.2}
                  value={voice.fadeInSec || 0}
                  onChange={(e) => void updateVoice({ fadeInSec: Number(e.target.value) })}
                  className="mt-1 w-full accent-violet-500"
                />
              </div>

              <div>
                <div className="flex justify-between text-[11px] text-zinc-400">
                  <span>Fade Out</span>
                  <span className="font-mono text-zinc-200">
                    {(voice.fadeOutSec || 0).toFixed(1)}s
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={5}
                  step={0.2}
                  value={voice.fadeOutSec || 0}
                  onChange={(e) => void updateVoice({ fadeOutSec: Number(e.target.value) })}
                  className="mt-1 w-full accent-violet-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2 border-t border-white/[0.06]">
              {/* Original Audio */}
              <div className="p-2.5 rounded-lg bg-[#16161B] border border-white/[0.06] space-y-1.5">
                <label className="flex items-center justify-between text-xs text-zinc-200 cursor-pointer">
                  <span>Keep Original Audio</span>
                  <input
                    type="checkbox"
                    checked={voice.preserveOriginalAudio}
                    onChange={(e) =>
                      void updateVoice({ preserveOriginalAudio: e.target.checked })
                    }
                    className="accent-violet-500"
                  />
                </label>
                {voice.preserveOriginalAudio && (
                  <div>
                    <div className="flex justify-between text-[11px] text-zinc-400">
                      <span>Original Level</span>
                      <span className="font-mono">
                        {Math.round(voice.originalAudioVolume * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1.2}
                      step={0.05}
                      value={voice.originalAudioVolume}
                      onChange={(e) =>
                        void updateVoice({ originalAudioVolume: Number(e.target.value) })
                      }
                      className="mt-1 w-full accent-violet-500"
                    />
                  </div>
                )}
              </div>

              {/* Background Music */}
              <div className="p-2.5 rounded-lg bg-[#16161B] border border-white/[0.06] space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-300 flex items-center gap-1.5">
                    <Music className="w-3.5 h-3.5 text-zinc-400" />
                    Background Music
                  </span>
                  <input
                    ref={musicInputRef}
                    type="file"
                    accept=".mp3,.wav,.aac,.m4a,.ogg,audio/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleMusicUpload(f);
                      e.target.value = '';
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => musicInputRef.current?.click()}
                    disabled={busyMusic}
                    className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-[11px] font-medium text-zinc-200 cursor-pointer"
                  >
                    {busyMusic ? 'Uploading...' : voice.bgMusicUrl ? 'Replace' : 'Add Track'}
                  </button>
                </div>
                {voice.bgMusicFilename && (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px] text-zinc-400">
                      <span className="truncate">{voice.bgMusicFilename}</span>
                      <button
                        type="button"
                        onClick={() =>
                          void updateVoice({
                            bgMusicFilename: undefined,
                            bgMusicUrl: undefined,
                          })
                        }
                        className="text-red-400 hover:text-red-300 ml-2 cursor-pointer"
                      >
                        Remove
                      </button>
                    </div>
                    <input
                      type="range"
                      min={0.02}
                      max={1}
                      step={0.02}
                      value={voice.bgMusicVolume}
                      onChange={(e) =>
                        void updateVoice({ bgMusicVolume: Number(e.target.value) })
                      }
                      className="w-full accent-violet-500"
                    />
                  </div>
                )}
              </div>

              {/* Sound Effects (SFX) */}
              <div className="p-2.5 rounded-lg bg-[#16161B] border border-white/[0.06] space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-300 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-zinc-400" />
                    Sound Effects (SFX)
                  </span>
                  <input
                    ref={sfxInputRef}
                    type="file"
                    accept=".mp3,.wav,.aac,.m4a,.ogg,audio/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleSfxUpload(f);
                      e.target.value = '';
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => sfxInputRef.current?.click()}
                    disabled={busySfx}
                    className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-[11px] font-medium text-zinc-200 cursor-pointer"
                  >
                    {busySfx ? 'Uploading...' : voice.sfxUrl ? 'Replace' : 'Add SFX'}
                  </button>
                </div>
                {voice.sfxFilename && (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px] text-zinc-400">
                      <span className="truncate">{voice.sfxFilename}</span>
                      <button
                        type="button"
                        onClick={() =>
                          void updateVoice({
                            sfxFilename: undefined,
                            sfxUrl: undefined,
                          })
                        }
                        className="text-red-400 hover:text-red-300 ml-2 cursor-pointer"
                      >
                        Remove
                      </button>
                    </div>
                    <input
                      type="range"
                      min={0.05}
                      max={1.5}
                      step={0.05}
                      value={voice.sfxVolume ?? 1.0}
                      onChange={(e) =>
                        void updateVoice({ sfxVolume: Number(e.target.value) })
                      }
                      className="w-full accent-violet-500"
                    />
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Synchronization Settings */}
          <section className="rounded-xl bg-[#111115] border border-white/[0.08] overflow-hidden">
            <button
              type="button"
              onClick={() => setSyncOpen((v) => !v)}
              aria-expanded={syncOpen}
              className="w-full px-4 py-3 flex items-center justify-between text-xs font-semibold text-zinc-200 hover:text-white hover:bg-white/[0.03] cursor-pointer"
            >
              <span className="flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4 text-violet-400" />
                <span>Synchronization Settings</span>
                <span className="text-[11px] font-normal text-zinc-500">
                  Mode: {voice.syncMode || 'flexible'}
                </span>
              </span>
              {syncOpen ? (
                <ChevronDown className="w-4 h-4 text-zinc-400" />
              ) : (
                <ChevronRight className="w-4 h-4 text-zinc-400" />
              )}
            </button>

            {syncOpen && (
              <div className="p-3.5 pt-2 border-t border-white/[0.08]">
                <TimelineSyncCard
                  project={project}
                  onProjectUpdated={onProjectUpdated}
                  compact
                />
              </div>
            )}
          </section>

          {/* Voice Segments & Per-Segment Audio Review / Regeneration */}
          <section className="p-4 rounded-xl bg-[#111115] border border-white/[0.08] space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-display font-semibold text-white">
                  Narration Segments &amp; Audio Clips ({project.captions.length})
                </h2>
                <p className="text-[11px] text-zinc-400 mt-0.5">
                  Preview individual audio clips, inspect waveforms, or regenerate specific segments.
                </p>
              </div>
              {onNavigate && (
                <button
                  type="button"
                  onClick={() => onNavigate('translator')}
                  className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-200 flex items-center gap-1.5 cursor-pointer"
                >
                  <Languages className="w-3.5 h-3.5 text-violet-400" />
                  Edit Script in Step 1
                </button>
              )}
            </div>

            {project.captions.length === 0 ? (
              <div className="py-8 text-center space-y-2 rounded-lg bg-[#09090B] border border-white/[0.06]">
                <Mic className="w-5 h-5 text-zinc-600 mx-auto" />
                <div className="text-xs font-medium text-zinc-300">No Script Segments Yet</div>
                <p className="text-[11px] text-zinc-500">
                  Add or translate segments in Step 1 (Translation Studio) first.
                </p>
              </div>
            ) : (
              <div className="max-h-[460px] overflow-y-auto space-y-2 pr-1">
                {project.captions.map((seg, idx) => {
                  const segClip = voice.generatedClips?.find((c) => c.segmentId === seg.id);
                  const segSync = voice.syncPlan?.segments?.find((s) => s.segmentId === seg.id);
                  const segSlot = segClip?.slotDuration ?? Math.max(0.2, seg.end - seg.start);
                  const segOverflow = segClip
                    ? segClip.overflowSeconds ??
                      Math.max(0, Math.round((segClip.duration - segSlot) * 100) / 100)
                    : 0;
                  const hasConflict = Boolean(segSync?.conflict);
                  const clipPeaks = audioWaveforms?.dubClips?.[seg.id] || [];
                  const isRegenPending = pendingRegenIds.includes(seg.id);
                  const isThisRegen = busyRegenSegments && regeneratingSegmentId === seg.id;

                  return (
                    <div
                      key={seg.id}
                      className={`p-3 rounded-lg border space-y-2 ${
                        hasConflict || (!segSync && segOverflow > 0.15)
                          ? 'bg-amber-950/15 border-amber-500/35'
                          : isRegenPending
                          ? 'bg-violet-950/15 border-violet-500/35'
                          : 'bg-[#18181D] border-white/[0.06]'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="px-2 py-0.5 rounded bg-zinc-800 text-[11px] font-mono text-violet-300">
                            #{idx + 1} · {formatTimecode(seg.start)} → {formatTimecode(seg.end)}
                          </span>

                          {segClip?.audioUrl && (
                            <button
                              type="button"
                              onClick={() =>
                                toggleSegmentAudioPreview(seg.id, segClip.audioUrl)
                              }
                              className={`px-2 py-0.5 rounded text-[11px] font-medium flex items-center gap-1 cursor-pointer border ${
                                playingSegmentId === seg.id
                                  ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-200'
                                  : 'bg-zinc-800 hover:bg-zinc-700 border-white/[0.06] text-zinc-200'
                              }`}
                            >
                              {playingSegmentId === seg.id ? (
                                <Square className="w-2.5 h-2.5" />
                              ) : (
                                <Play className="w-2.5 h-2.5" />
                              )}
                              {playingSegmentId === seg.id ? 'Stop' : 'Play'}
                            </button>
                          )}

                          {segClip ? (
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                                hasConflict || segOverflow > 0.15
                                  ? 'bg-amber-500/15 text-amber-300'
                                  : 'bg-emerald-500/15 text-emerald-300'
                              }`}
                            >
                              {segClip.duration.toFixed(1)}s / {segSlot.toFixed(1)}s slot
                            </span>
                          ) : (
                            <span className="text-[10px] font-mono text-zinc-500">
                              No audio clip
                            </span>
                          )}
                        </div>

                        <button
                          type="button"
                          onClick={() => void handleRegenerateSelectedSegments([seg.id])}
                          disabled={busyRegenSegments || !(seg.translatedText || seg.text).trim()}
                          className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 border border-white/[0.08] text-[11px] font-medium text-zinc-200 flex items-center gap-1 cursor-pointer"
                        >
                          <RefreshCw
                            className={`w-3 h-3 text-violet-400 ${isThisRegen ? 'animate-spin' : ''}`}
                          />
                          <span>{segClip ? 'Regenerate' : 'Generate'}</span>
                        </button>
                      </div>

                      {clipPeaks.length > 0 && (
                        <WaveformStrip
                          peaks={clipPeaks}
                          colorClass={
                            hasConflict || segOverflow > 0.15
                              ? 'bg-amber-400/75'
                              : 'bg-violet-400/75'
                          }
                          heightClass="h-5"
                        />
                      )}

                      <div className="space-y-1">
                        <div className="text-xs text-zinc-100 leading-relaxed">
                          {seg.translatedText?.trim() ? (
                            seg.translatedText
                          ) : (
                            <span className="text-amber-300/80 italic">
                              Missing translation in Step 1
                            </span>
                          )}
                        </div>
                        {seg.text?.trim() && (
                          <div className="text-[11px] text-zinc-500 truncate">
                            Original: {seg.text}
                          </div>
                        )}
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
