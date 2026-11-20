import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Bookmark,
  Check,
  CheckCircle2,
  Edit3,
  Film,
  Languages,
  Link2,
  Loader2,
  Mic,
  Music,
  Play,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  Trash2,
  Unlink,
  UploadCloud,
  Volume2,
  VolumeX,
  Wand2,
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import {
  CaptionSegment,
  FishVoiceModel,
  OriginalAudioClip,
  Project,
  ProjectPatchFn,
  RenderJob,
  SavedFishVoice,
  SupportedLanguage,
  VoiceConfig,
} from '../../types/studio';
import { api } from '../../lib/api';
import { formatTimecode } from '../../lib/formatters';
import {
  getEffectiveOriginalAudioClips,
  getOriginalAudioClipTimelineEnd,
  unlinkVideoClipAudio,
} from '../../lib/videoTimeline';
import { createWorkflowUpdate } from '../../lib/workflowStages';
import { ExternalGeminiTranslatorPanel } from '../ExternalGeminiTranslatorPanel';
import { TimelineSyncCard } from '../TimelineSyncCard';
import { NarratorSelector } from '../NarratorSelector';
import { CollapsibleSection } from '../ui/CollapsibleSection';
import { StudioToolMemory } from './toolMemory';
import { downloadProjectAsset, resolvePlayableAssetUrl } from '../../lib/supabaseCloud';

interface AudioToolSheetProps {
  project: Project;
  onProjectUpdated: (p: Project) => void;
  onPatchProject: ProjectPatchFn;
  onFlushSaves?: (projectId?: string) => Promise<boolean>;
  currentTime: number;
  onSeek: (time: number) => void;
  memory: StudioToolMemory;
  onUpdateMemory: (patch: Partial<StudioToolMemory>) => void;
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

const DUB_TARGET_LANGUAGES: SupportedLanguage[] = [
  'French',
  'Arabic',
  'English',
  'Spanish',
  'German',
  'Portuguese',
];

export function AudioToolSheet({
  project,
  onProjectUpdated,
  onPatchProject,
  onFlushSaves,
  currentTime,
  onSeek,
  memory,
  onUpdateMemory,
}: AudioToolSheetProps) {
  const musicInputRef = useRef<HTMLInputElement>(null);
  const sfxInputRef = useRef<HTMLInputElement>(null);

  const [fishConfigured, setFishConfigured] = useState<boolean | null>(null);
  const [sourceLanguage, setSourceLanguage] = useState<string>(
    project.translation.sourceLanguage || 'Auto'
  );
  const [targetLanguage, setTargetLanguage] = useState<SupportedLanguage>(
    DUB_TARGET_LANGUAGES.includes(project.voice.targetLanguage)
      ? project.voice.targetLanguage
      : 'French'
  );
  const [preserveProperNouns, setPreserveProperNouns] = useState<boolean>(
    project.translation.preserveProperNouns
  );

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

  const [busyTrackUpload, setBusyTrackUpload] = useState<'bgm' | 'sfx' | null>(null);
  const [busyTranscribe, setBusyTranscribe] = useState(false);
  const [busyTranslate, setBusyTranslate] = useState(false);
  const [busyPreview, setBusyPreview] = useState(false);
  const [busyGenerate, setBusyGenerate] = useState(false);
  const [busyRegenSegments, setBusyRegenSegments] = useState(false);
  const [focusAudioOverflowSignal, setFocusAudioOverflowSignal] = useState(0);

  const [previewAudioUrl, setPreviewAudioUrl] = useState<string | null>(null);
  const [resolvedFullDubUrl, setResolvedFullDubUrl] = useState<string | null>(null);
  const [activeDubJob, setActiveDubJob] = useState<RenderJob | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const voice = project.voice;

  useEffect(() => {
    void api
      .getSystemStatus()
      .then((s) => setFishConfigured(s.fishConfigured))
      .catch(() => setFishConfigured(null));
    void api
      .listSavedFishVoices()
      .then(({ voices: sv }) => setSavedVoices(sv))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setSourceLanguage(project.translation.sourceLanguage || 'Auto');
    setActiveDubJob(null);
    void api
      .listProjectJobs(project.id)
      .then(({ jobs }) => {
        const runningVoice = jobs.find(
          (j) => j.type === 'voice' && (j.status === 'queued' || j.status === 'processing')
        );
        if (runningVoice) setActiveDubJob(runningVoice);
      })
      .catch(() => {});
  }, [project.id, project.translation.sourceLanguage]);

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
    if (fishConfigured && memory.audioTab === 'voice' && voices.length === 0) {
      void loadFishVoices();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fishConfigured, memory.audioTab]);

  useEffect(() => {
    if (
      !activeDubJob ||
      (activeDubJob.status !== 'queued' && activeDubJob.status !== 'processing')
    ) {
      return;
    }
    const timer = window.setInterval(async () => {
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
          const { project: synced } = await api.updateProject(project.id, {
            workflow: nextWorkflow,
          });
          onProjectUpdated(synced);
          setStatusMsg(
            `Generated ${synced.voice.generatedClips.length} synchronized MP3 segments using Fish Audio s2.1-pro-free.`
          );
        } else if (res.job.status === 'failed') {
          setErrorMsg(res.job.error || 'Fish Audio dubbing job failed.');
        }
      } catch {
        // ignore poll error
      }
    }, 700);
    return () => window.clearInterval(timer);
  }, [activeDubJob, project.id, onProjectUpdated]);

  const updateVoiceMixer = (
    patch: Partial<VoiceConfig>,
    immediate = false,
    undoGroupKey?: string
  ) => {
    onPatchProject(
      project.id,
      (cur) => {
        const merged: VoiceConfig = {
          ...cur.voice,
          ...patch,
          provider: 'fish',
          speakingSpeed: 1.0,
        };
        if (
          'originalAudioMuted' in patch ||
          'originalAudioEnabled' in patch ||
          'preserveOriginalAudio' in patch
        ) {
          const origMuted =
            merged.originalAudioMuted !== undefined
              ? Boolean(merged.originalAudioMuted)
              : !Boolean(merged.preserveOriginalAudio);
          const origEnabled =
            merged.originalAudioEnabled !== undefined
              ? Boolean(merged.originalAudioEnabled)
              : Boolean(merged.preserveOriginalAudio);
          merged.originalAudioMuted = origMuted;
          merged.originalAudioEnabled = origEnabled;
          merged.preserveOriginalAudio = origEnabled && !origMuted;
        }

        return {
          voice: merged,
          workflow: createWorkflowUpdate(cur.workflow, {
            visitStage: 'voice',
            modifiedStage: 'editor',
            hasExistingExport: Boolean(cur.lastExportUrl),
          }),
        };
      },
      {
        immediate,
        debounceMs: immediate ? 0 : 250,
        undoGroupKey,
      }
    );
  };

  const patchScriptCaptions = (
    updater: (curCaptions: CaptionSegment[]) => CaptionSegment[],
    opts?: { immediate?: boolean; undoGroupKey?: string }
  ) => {
    onPatchProject(
      project.id,
      (cur) => ({
        captions: updater(cur.captions),
        workflow: createWorkflowUpdate(cur.workflow, {
          visitStage: 'voice',
          modifiedStage: 'translator',
          hasGeneratedDub: Boolean(cur.voice.fullDubUrl),
          hasGeneratedCaptions: Boolean(cur.subtitleStyle.captionSync),
          hasExistingExport: Boolean(cur.lastExportUrl),
        }),
      }),
      {
        immediate: opts?.immediate,
        debounceMs: opts?.immediate ? 0 : 350,
        undoGroupKey: opts?.undoGroupKey,
      }
    );
  };

  const handleTranscribeFish = async () => {
    setErrorMsg(null);
    setStatusMsg(null);
    setBusyTranscribe(true);
    try {
      await onFlushSaves?.(project.id);
      const res = await api.transcribeWithFish(project.id, sourceLanguage);
      onProjectUpdated(res.project);
      setSourceLanguage(res.detectedLanguage);
      setStatusMsg(
        `Fish Audio ASR extracted ${res.segmentCount} timestamped segments (${res.detectedLanguage}).`
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
          sourceLanguage,
          targetLanguage,
          preserveProperNouns,
        },
        voice: { ...voice, targetLanguage, provider: 'fish' },
      });
      const res = await api.translate(project.id, targetLanguage, preserveProperNouns);
      onProjectUpdated(res.project);
      setStatusMsg(`Translated ${res.project.captions.length} segments to ${targetLanguage}.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyTranslate(false);
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
          ? 'تغير كل شيء في اللحظة التي انفتح فيها باب الخزنة في صمت تام.'
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
    try {
      const hasTranslations = project.captions.some((c) => Boolean(c.translatedText?.trim()));
      const res = await api.regenerateFishSegments(project.id, {
        segmentIds,
        captions: project.captions,
        voice: { ...voice, targetLanguage, provider: 'fish', speakingSpeed: 1.0, enabled: true },
        useTranslated: hasTranslations,
      });
      onProjectUpdated(res.project);
      setStatusMsg(
        `Regenerated ${res.regeneratedIds.length} segment(s) at 1.0x and re-merged dub track.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyRegenSegments(false);
    }
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
      updateVoiceMixer({ fishReferenceId: res.voice.voiceId, fishVoiceTitle: res.voice.name }, true);
      setStatusMsg(`Saved voice "${res.voice.name}".`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySavedVoice(false);
    }
  };

  const origMuted =
    voice.originalAudioMuted !== undefined
      ? Boolean(voice.originalAudioMuted)
      : !Boolean(voice.preserveOriginalAudio);
  const origEnabled =
    voice.originalAudioEnabled !== undefined
      ? Boolean(voice.originalAudioEnabled)
      : Boolean(voice.preserveOriginalAudio);
  const origActive = origEnabled && !origMuted;
  const origVolPct = Math.round((voice.originalAudioVolume ?? 1.0) * 100);
  const voiceVolPct = Math.round((voice.voiceVolume ?? 1.0) * 100);
  const bgmEnabled =
    voice.bgMusicEnabled !== undefined
      ? Boolean(voice.bgMusicEnabled)
      : Number(voice.bgMusicVolume ?? 0) > 0.005;
  const bgmEffectivelyMuted =
    Boolean(voice.bgMusicMuted) || !bgmEnabled || Number(voice.bgMusicVolume ?? 0) <= 0.01;
  const bgmVolPct = Math.round((voice.bgMusicVolume ?? 0) * 100);
  const sfxEnabled = Boolean(voice.sfxEnabled);
  const sfxEffectivelyMuted =
    Boolean(voice.sfxMuted) || !sfxEnabled || Number(voice.sfxVolume ?? 0) <= 0.01;
  const sfxVolPct = Math.round((voice.sfxVolume ?? 1.0) * 100);

  const isDubGenerating =
    busyGenerate ||
    Boolean(
      activeDubJob && (activeDubJob.status === 'queued' || activeDubJob.status === 'processing')
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

  const unlinkedOrigClips = getEffectiveOriginalAudioClips(project);
  const hasUnlinkedOrigAudio = unlinkedOrigClips.length > 0;
  const maxSrcDur = Math.max(0.5, project.metadata?.duration || 12);

  const matchedSaved = savedVoices.find((s) => s.voiceId === (voice.fishReferenceId || '').trim());
  const activeVoiceName =
    matchedSaved?.name ||
    voice.fishVoiceTitle ||
    (voice.fishReferenceId
      ? `Voice (${voice.fishReferenceId.slice(0, 8)}...)`
      : 'Default Neutral Narrator');

  return (
    <div className="space-y-3">
      {/* Top Sub-Tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
        {(
          [
            { id: 'mixer', label: 'Mixer & Music' },
            { id: 'voice', label: 'Dubbing Voice' },
            { id: 'script', label: `Script & Translate (${project.captions.length})` },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => onUpdateMemory({ audioTab: tab.id })}
            className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 border cursor-pointer ${
              memory.audioTab === tab.id
                ? 'bg-violet-600 border-violet-500 text-white'
                : 'bg-[#18181D] border-white/[0.08] text-zinc-300 hover:text-white'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {errorMsg && (
        <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <span>{errorMsg}</span>
        </div>
      )}
      {statusMsg && (
        <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-200 flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <span>{statusMsg}</span>
        </div>
      )}

      {/* TAB 1: 4-TRACK MIXER, MUSIC, SFX & SYNC */}
      {memory.audioTab === 'mixer' && (
        <div className="space-y-3">
          {/* Original Audio Track */}
          <div className="p-3 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs font-semibold text-white">
                  <Film className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                  <span className="truncate">Original Video Audio</span>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[9.5px] font-medium ${
                      hasUnlinkedOrigAudio
                        ? 'bg-sky-500/15 text-sky-300 border border-sky-500/30'
                        : 'bg-zinc-800 text-zinc-400'
                    }`}
                  >
                    {hasUnlinkedOrigAudio ? 'Unlinked · 1.0x' : 'Linked'}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {!hasUnlinkedOrigAudio && project.metadata?.hasAudio && (
                  <button
                    type="button"
                    onClick={() =>
                      onPatchProject(
                        project.id,
                        (cur) => {
                          const res = unlinkVideoClipAudio(cur, undefined, uuidv4);
                          return {
                            videoClips: res.videoClips,
                            originalAudioClips: res.originalAudioClips,
                            voice: {
                              ...cur.voice,
                              originalAudioMuted: false,
                              originalAudioEnabled: true,
                              originalAudioRemoved: false,
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
                      )
                    }
                    className="min-h-[32px] px-2.5 py-1 rounded-lg bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/35 text-[11px] font-semibold text-sky-200 flex items-center gap-1 cursor-pointer"
                    title="Extract and separate original audio onto an independent track"
                  >
                    <Unlink className="w-3 h-3" />
                    Separate Audio
                  </button>
                )}
                {voice.originalAudioRemoved ? (
                  <button
                    type="button"
                    onClick={() => updateVoiceMixer({ originalAudioRemoved: false, originalAudioMuted: false }, true)}
                    className="min-h-[32px] px-2.5 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/35 text-[11px] font-semibold text-emerald-200 flex items-center gap-1 cursor-pointer"
                    title="Restore original video audio stream"
                  >
                    <CheckCircle2 className="w-3 h-3" />
                    Restore Audio
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => updateVoiceMixer({ originalAudioRemoved: true, originalAudioMuted: true }, true)}
                    className="min-h-[32px] px-2.5 py-1 rounded-lg bg-red-500/15 hover:bg-red-500/25 border border-red-500/35 text-[11px] font-semibold text-red-200 flex items-center gap-1 cursor-pointer"
                    title="Permanently remove original audio stream from timeline and final export"
                  >
                    <Trash2 className="w-3 h-3" />
                    Remove Audio
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    updateVoiceMixer(
                      origActive
                        ? { originalAudioMuted: true, originalAudioEnabled: false, preserveOriginalAudio: false }
                        : { originalAudioMuted: false, originalAudioEnabled: true, preserveOriginalAudio: true },
                      true
                    )
                  }
                  className={`min-h-[32px] px-2.5 py-1 rounded-lg text-[11px] font-semibold border cursor-pointer flex items-center gap-1 ${
                    origActive
                      ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                      : 'bg-amber-500/15 border-amber-500/40 text-amber-200'
                  }`}
                >
                  {origActive ? <Volume2 className="w-3 h-3" /> : <VolumeX className="w-3 h-3" />}
                  {origActive ? 'On' : 'Muted'}
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={200}
                step={5}
                value={origVolPct}
                onChange={(e) =>
                  updateVoiceMixer(
                    { originalAudioVolume: Number(e.target.value) / 100 },
                    false,
                    'audio:orig-vol'
                  )
                }
                className="flex-1 accent-violet-500"
              />
              <span className="text-[11px] font-mono text-zinc-300 tabular-nums w-10 text-right">
                {origVolPct}%
              </span>
            </div>

            {hasUnlinkedOrigAudio && (
              <div className="pt-2 border-t border-white/[0.06] space-y-2">
                <div className="text-[10.5px] text-sky-300/90">
                  Unlinked clips stay strictly at 1.0x speed and original pitch regardless of video speed.
                </div>
                {unlinkedOrigClips.map((oa, idx) => {
                  const endTl = getOriginalAudioClipTimelineEnd(oa);
                  const patchOa = (patch: Partial<OriginalAudioClip>, immediate = false) => {
                    onPatchProject(
                      project.id,
                      (cur) => ({
                        originalAudioClips: getEffectiveOriginalAudioClips(cur).map((item) =>
                          item.id === oa.id ? { ...item, ...patch } : item
                        ),
                      }),
                      {
                        immediate,
                        debounceMs: immediate ? 0 : 250,
                        undoGroupKey: `oa:${oa.id}`,
                      }
                    );
                  };
                  return (
                    <div
                      key={oa.id}
                      className="p-2 rounded-lg bg-zinc-900/70 border border-white/[0.06] space-y-1.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-medium text-zinc-200 truncate">
                          {oa.label || `Audio ${idx + 1}`} · {oa.timelineStart.toFixed(1)}s–{endTl.toFixed(1)}s (1.0x)
                        </span>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => patchOa({ muted: !oa.muted }, true)}
                            className={`px-2 py-0.5 rounded text-[10px] font-medium cursor-pointer border ${
                              oa.muted
                                ? 'bg-amber-500/15 border-amber-500/35 text-amber-200'
                                : 'bg-emerald-500/15 border-emerald-500/35 text-emerald-200'
                            }`}
                          >
                            {oa.muted ? 'Muted' : 'Active'}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              onPatchProject(
                                project.id,
                                (cur) => ({
                                  originalAudioClips: getEffectiveOriginalAudioClips(cur).filter(
                                    (x) => x.id !== oa.id
                                  ),
                                }),
                                { immediate: true }
                              )
                            }
                            className="p-1 rounded text-red-300/80 hover:text-red-200 hover:bg-red-500/10 cursor-pointer"
                            title="Delete unlinked audio clip"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-1.5 text-[10px]">
                        <label className="text-zinc-400">
                          Start (s)
                          <input
                            type="number"
                            min={0}
                            step={0.1}
                            value={Number(oa.timelineStart.toFixed(2))}
                            onChange={(e) =>
                              patchOa({ timelineStart: Math.max(0, Number(e.target.value) || 0) })
                            }
                            className="mt-0.5 w-full bg-zinc-950 border border-white/[0.08] rounded px-1.5 py-1 text-[11px] font-mono text-zinc-100"
                          />
                        </label>
                        <label className="text-zinc-400">
                          In (s)
                          <input
                            type="number"
                            min={0}
                            max={Math.max(0, oa.sourceEnd - 0.1)}
                            step={0.1}
                            value={Number(oa.sourceStart.toFixed(2))}
                            onChange={(e) =>
                              patchOa({
                                sourceStart: Math.max(
                                  0,
                                  Math.min(oa.sourceEnd - 0.1, Number(e.target.value) || 0)
                                ),
                              })
                            }
                            className="mt-0.5 w-full bg-zinc-950 border border-white/[0.08] rounded px-1.5 py-1 text-[11px] font-mono text-zinc-100"
                          />
                        </label>
                        <label className="text-zinc-400">
                          Out (s)
                          <input
                            type="number"
                            min={oa.sourceStart + 0.1}
                            max={maxSrcDur}
                            step={0.1}
                            value={Number(oa.sourceEnd.toFixed(2))}
                            onChange={(e) =>
                              patchOa({
                                sourceEnd: Math.max(
                                  oa.sourceStart + 0.1,
                                  Math.min(maxSrcDur, Number(e.target.value) || maxSrcDur)
                                ),
                              })
                            }
                            className="mt-0.5 w-full bg-zinc-950 border border-white/[0.08] rounded px-1.5 py-1 text-[11px] font-mono text-zinc-100"
                          />
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Track 2: Dubbed Narration */}
          <div className="p-3 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs font-semibold text-white">
                  <Mic className="w-3.5 h-3.5 text-teal-400 shrink-0" />
                  <span>Dubbed Narration</span>
                </div>
                <div className="text-[10.5px] text-zinc-400 truncate mt-0.5">
                  {voice.fishVoiceTitle || 'Default Fish Audio Voice'} · {voice.targetLanguage} ·{' '}
                  {voice.generatedClips.length} clip(s) · 1.0x
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  const isActiveNow = Boolean(voice.enabled && !voice.voiceMuted);
                  updateVoiceMixer(
                    isActiveNow
                      ? { voiceMuted: true }
                      : { enabled: true, voiceMuted: false },
                    true
                  );
                }}
                className={`min-h-[34px] px-2.5 py-1 rounded-lg text-[11px] font-semibold border cursor-pointer flex items-center gap-1 ${
                  voice.enabled && !voice.voiceMuted
                    ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                    : 'bg-amber-500/15 border-amber-500/40 text-amber-200'
                }`}
              >
                {voice.enabled && !voice.voiceMuted ? (
                  <Volume2 className="w-3 h-3" />
                ) : (
                  <VolumeX className="w-3 h-3" />
                )}
                {voice.enabled && !voice.voiceMuted ? 'On' : 'Muted'}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={200}
                step={5}
                value={voiceVolPct}
                onChange={(e) =>
                  updateVoiceMixer(
                    { voiceVolume: Number(e.target.value) / 100 },
                    false,
                    'audio:voice-vol'
                  )
                }
                className="flex-1 accent-teal-500"
              />
              <span className="text-[11px] font-mono text-zinc-300 tabular-nums w-10 text-right">
                {voiceVolPct}%
              </span>
            </div>
          </div>

          {/* Track 3: Background Music */}
          <div className="p-3 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-2.5">
            <input
              ref={musicInputRef}
              type="file"
              accept="audio/*,.mp3,.wav,.m4a,.aac"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                setBusyTrackUpload('bgm');
                setErrorMsg(null);
                try {
                  const res = await api.uploadMusic(project.id, f);
                  onProjectUpdated(res.project);
                  setStatusMsg(`Added music "${f.name}".`);
                } catch (err) {
                  setErrorMsg(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusyTrackUpload(null);
                }
              }}
            />
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-white flex items-center gap-1.5">
                  <Music className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                  <span className="truncate">{voice.bgMusicFilename || 'Background Music'}</span>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  disabled={busyTrackUpload === 'bgm'}
                  onClick={() => musicInputRef.current?.click()}
                  className="min-h-[34px] px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-[11px] font-medium text-zinc-200 flex items-center gap-1 cursor-pointer"
                >
                  {busyTrackUpload === 'bgm' ? <Loader2 className="w-3 h-3 animate-spin" /> : <UploadCloud className="w-3 h-3" />}
                  {voice.bgMusicUrl ? 'Replace' : 'Add Music'}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    updateVoiceMixer(
                      bgmEffectivelyMuted
                        ? {
                            bgMusicMuted: false,
                            bgMusicEnabled: true,
                            bgMusicVolume:
                              Number(voice.bgMusicVolume ?? 0) > 0.01 ? voice.bgMusicVolume : 0.25,
                          }
                        : { bgMusicMuted: true },
                      true
                    )
                  }
                  className={`min-h-[34px] px-2.5 py-1 rounded-lg text-[11px] font-semibold border flex items-center gap-1 cursor-pointer ${
                    bgmEffectivelyMuted
                      ? 'bg-amber-500/15 border-amber-500/40 text-amber-200'
                      : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                  }`}
                >
                  {bgmEffectivelyMuted ? <VolumeX className="w-3 h-3" /> : <Volume2 className="w-3 h-3" />}
                  {bgmEffectivelyMuted ? 'Muted' : 'On'}
                </button>
                {voice.bgMusicUrl && (
                  <button
                    type="button"
                    onClick={() =>
                      updateVoiceMixer(
                        { bgMusicUrl: '', bgMusicFilename: '', bgMusicEnabled: false, bgMusicVolume: 0 },
                        true
                      )
                    }
                    className="min-w-[34px] min-h-[34px] flex items-center justify-center rounded-lg text-zinc-500 hover:text-red-400 hover:bg-white/[0.05] cursor-pointer"
                    title="Remove music track"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={200}
                step={5}
                value={bgmVolPct}
                onChange={(e) => {
                  const val = Number(e.target.value) / 100;
                  updateVoiceMixer(
                    {
                      bgMusicVolume: val,
                      bgMusicEnabled: val > 0,
                      ...(val > 0 ? { bgMusicMuted: false } : {}),
                    },
                    false,
                    'audio:bgm-vol'
                  );
                }}
                className="flex-1 accent-indigo-500"
              />
              <span className="text-[11px] font-mono text-zinc-300 tabular-nums w-10 text-right">
                {bgmVolPct}%
              </span>
            </div>
          </div>

          {/* Track 4: SFX */}
          <div className="p-3 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-2.5">
            <input
              ref={sfxInputRef}
              type="file"
              accept="audio/*,.mp3,.wav,.m4a,.aac"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                setBusyTrackUpload('sfx');
                setErrorMsg(null);
                try {
                  const res = await api.uploadSfx(project.id, f);
                  onProjectUpdated(res.project);
                  setStatusMsg(`Added SFX "${f.name}".`);
                } catch (err) {
                  setErrorMsg(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusyTrackUpload(null);
                }
              }}
            />
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-white flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span className="truncate">{voice.sfxFilename || 'Sound Effects (SFX)'}</span>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  disabled={busyTrackUpload === 'sfx'}
                  onClick={() => sfxInputRef.current?.click()}
                  className="min-h-[34px] px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-[11px] font-medium text-zinc-200 flex items-center gap-1 cursor-pointer"
                >
                  {busyTrackUpload === 'sfx' ? <Loader2 className="w-3 h-3 animate-spin" /> : <UploadCloud className="w-3 h-3" />}
                  {voice.sfxUrl ? 'Replace' : 'Add SFX'}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    updateVoiceMixer(
                      sfxEffectivelyMuted
                        ? {
                            sfxMuted: false,
                            sfxEnabled: true,
                            sfxVolume: Number(voice.sfxVolume ?? 0) > 0.01 ? voice.sfxVolume : 1.0,
                          }
                        : { sfxMuted: true, sfxEnabled: false },
                      true
                    )
                  }
                  className={`min-h-[34px] px-2.5 py-1 rounded-lg text-[11px] font-semibold border flex items-center gap-1 cursor-pointer ${
                    sfxEffectivelyMuted
                      ? 'bg-amber-500/15 border-amber-500/40 text-amber-200'
                      : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                  }`}
                >
                  {sfxEffectivelyMuted ? <VolumeX className="w-3 h-3" /> : <Volume2 className="w-3 h-3" />}
                  {sfxEffectivelyMuted ? 'Muted' : 'On'}
                </button>
                {voice.sfxUrl && (
                  <button
                    type="button"
                    onClick={() =>
                      updateVoiceMixer(
                        { sfxUrl: '', sfxFilename: '', sfxEnabled: false },
                        true
                      )
                    }
                    className="min-w-[34px] min-h-[34px] flex items-center justify-center rounded-lg text-zinc-500 hover:text-red-400 hover:bg-white/[0.05] cursor-pointer"
                    title="Remove SFX track"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={200}
                step={5}
                value={sfxVolPct}
                onChange={(e) => {
                  const val = Number(e.target.value) / 100;
                  updateVoiceMixer(
                    {
                      sfxVolume: val,
                      ...(val > 0 ? { sfxEnabled: true, sfxMuted: false } : {}),
                    },
                    false,
                    'audio:sfx-vol'
                  );
                }}
                className="flex-1 accent-emerald-500"
              />
              <span className="text-[11px] font-mono text-zinc-300 tabular-nums w-10 text-right">
                {sfxVolPct}%
              </span>
            </div>
          </div>

          <CollapsibleSection
            title="Advanced Settings"
            subtitle="Fade in/out, dub timing offset & Timeline Sync System"
            open={memory.audioAdvancedOpen}
            onToggle={(open) => onUpdateMemory({ audioAdvancedOpen: open })}
          >
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <div className="flex justify-between text-[11px] text-zinc-300">
                  <span>Fade In</span>
                  <span className="font-mono text-zinc-400">{voice.fadeInSec}s</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={3}
                  step={0.1}
                  value={voice.fadeInSec}
                  onChange={(e) =>
                    updateVoiceMixer({ fadeInSec: Number(e.target.value) }, false, 'audio:fade-in')
                  }
                  className="mt-1 w-full accent-violet-500"
                />
              </div>
              <div>
                <div className="flex justify-between text-[11px] text-zinc-300">
                  <span>Fade Out</span>
                  <span className="font-mono text-zinc-400">{voice.fadeOutSec}s</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={3}
                  step={0.1}
                  value={voice.fadeOutSec}
                  onChange={(e) =>
                    updateVoiceMixer({ fadeOutSec: Number(e.target.value) }, false, 'audio:fade-out')
                  }
                  className="mt-1 w-full accent-violet-500"
                />
              </div>
              <div>
                <div className="flex justify-between text-[11px] text-zinc-300">
                  <span>Dub Timing Offset</span>
                  <span className="font-mono text-zinc-400">
                    {(voice.timingOffsetSec || 0) >= 0 ? '+' : ''}
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
                    updateVoiceMixer(
                      { timingOffsetSec: Number(e.target.value) },
                      false,
                      'audio:timing-offset'
                    )
                  }
                  className="mt-1 w-full accent-violet-500"
                />
              </div>
            </div>

            <TimelineSyncCard
              project={project}
              onProjectUpdated={onProjectUpdated}
              onSeek={onSeek}
              compact
            />
          </CollapsibleSection>
        </div>
      )}

      {/* TAB 2: FISH AUDIO VOICE & DUB SYNTHESIS */}
      {memory.audioTab === 'voice' && (
        <div className="space-y-3">
          {fishConfigured === false && (
            <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200">
              Add <code className="font-mono">FISH_API_KEY</code> in Secrets to enable Fish Audio synthesis.
            </div>
          )}

          {/* Active Voice & Quick Controls */}
          <div className="p-3 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-3">
            <NarratorSelector
              savedVoices={savedVoices}
              catalogVoices={voices}
              selectedVoiceId={voice.fishReferenceId}
              selectedVoiceTitle={voice.fishVoiceTitle}
              onSelectVoice={(voiceId, voiceTitle) => {
                updateVoiceMixer(
                  {
                    fishReferenceId: voiceId,
                    fishVoiceTitle: voiceTitle,
                  },
                  true
                );
              }}
              compact
            />

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="text-[10.5px] text-zinc-400">Dub Language</label>
                <select
                  value={targetLanguage}
                  onChange={(e) => {
                    const nextLang = e.target.value as SupportedLanguage;
                    setTargetLanguage(nextLang);
                    updateVoiceMixer({ targetLanguage: nextLang }, true);
                  }}
                  className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-zinc-100"
                >
                  {DUB_TARGET_LANGUAGES.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10.5px] text-zinc-400">Narration Style</label>
                <select
                  value={voice.narrationStyle || 'cinematic'}
                  onChange={(e) =>
                    updateVoiceMixer(
                      { narrationStyle: e.target.value as 'cinematic' | 'natural' },
                      true
                    )
                  }
                  className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-zinc-100"
                >
                  <option value="cinematic">Cinematic (Dramatic)</option>
                  <option value="natural">Natural (Clear)</option>
                </select>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handlePreviewVoice}
                disabled={busyPreview}
                className="min-h-[40px] px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-xs font-medium text-zinc-100 flex items-center gap-1.5 cursor-pointer"
              >
                {busyPreview ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5 text-violet-400" />}
                Sample
              </button>

              <button
                type="button"
                onClick={handleGenerateDub}
                disabled={isDubGenerating || project.captions.length === 0}
                className="min-h-[40px] flex-1 py-2 px-3 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center justify-center gap-1.5 cursor-pointer"
              >
                {isDubGenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mic className="w-3.5 h-3.5" />}
                {isDubGenerating
                  ? `Generating (${Math.round(activeDubJob?.progress || 0)}%)...`
                  : 'Generate Dub (MP3)'}
              </button>
            </div>

            {activeDubJob && (
              <div className="space-y-1">
                <div className="flex justify-between text-[11px] font-mono text-zinc-400">
                  <span className="truncate">{activeDubJob.stage}</span>
                  <span>{Math.round(activeDubJob.progress)}%</span>
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

            {previewAudioUrl && <audio src={previewAudioUrl} controls autoPlay className="w-full h-8" />}
            {voice.fullDubUrl && (
              <div className="pt-1 border-t border-white/[0.06] space-y-1">
                <div className="flex items-center justify-between text-[11px] text-emerald-300">
                  <span>Full Dub Ready ({voice.generatedClips.length} clips)</span>
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
                    className="text-violet-300 hover:text-violet-200 font-mono cursor-pointer"
                  >
                    Download Audio
                  </button>
                </div>
                {resolvedFullDubUrl && (
                  <audio src={resolvedFullDubUrl} controls className="w-full h-8" />
                )}
              </div>
            )}
          </div>

          {pendingRegenIds.length > 0 && (
            <div className="p-2.5 rounded-xl bg-violet-500/10 border border-violet-500/35 flex items-center justify-between gap-2 text-xs text-violet-200">
              <span>{pendingRegenIds.length} corrected segment(s) ready to resynthesize.</span>
              <button
                type="button"
                onClick={() => void handleRegenerateSelectedSegments(pendingRegenIds)}
                disabled={busyRegenSegments}
                className="px-2.5 py-1.5 rounded-lg bg-violet-600 text-xs font-semibold text-white shrink-0 cursor-pointer"
              >
                {busyRegenSegments ? 'Regenerating...' : 'Regenerate Corrected'}
              </button>
            </div>
          )}

          {syncWarnings.length > 0 && (
            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 space-y-2 text-xs">
              <div className="flex items-center gap-2 text-amber-200 font-semibold">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                <span>{syncWarnings.length} segment(s) exceed slot duration at 1.0x speed</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    onUpdateMemory({ audioTab: 'script', voiceTranslationMode: 'external-gemini' });
                    setFocusAudioOverflowSignal((n) => n + 1);
                  }}
                  className="px-2.5 py-1.5 rounded-lg bg-amber-500/20 border border-amber-500/40 text-[11px] font-semibold text-amber-100 cursor-pointer"
                >
                  Open Gemini Fix Prompt
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void handleRegenerateSelectedSegments(syncWarnings.map((w) => w.clip.segmentId))
                  }
                  disabled={busyRegenSegments}
                  className="px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-white/[0.08] text-[11px] text-zinc-200 cursor-pointer"
                >
                  Regenerate Overflow
                </button>
              </div>
            </div>
          )}

          <CollapsibleSection
            title="Manage Saved Voices & Fish Audio Library"
            subtitle="Save custom Reference IDs, search Fish Audio catalog & browse My Voices"
          >
            {/* Saved Voice Cards */}
            {savedVoices.length > 0 && (
              <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                {savedVoices.map((sv) => {
                  const isEditing = editingSavedVoiceId === sv.id;
                  if (isEditing) {
                    return (
                      <div key={sv.id} className="p-2 rounded-lg bg-zinc-900 border border-violet-500/40 space-y-2">
                        <div className="grid grid-cols-2 gap-1.5">
                          <input
                            type="text"
                            value={editVoiceName}
                            onChange={(e) => setEditVoiceName(e.target.value)}
                            className="bg-[#111115] border border-white/[0.08] rounded px-2 py-1 text-xs text-white"
                          />
                          <input
                            type="text"
                            value={editVoiceId}
                            onChange={(e) => setEditVoiceId(e.target.value)}
                            className="bg-[#111115] border border-white/[0.08] rounded px-2 py-1 text-xs font-mono text-white"
                          />
                        </div>
                        <div className="flex justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => setEditingSavedVoiceId(null)}
                            className="px-2 py-1 rounded bg-zinc-800 text-[11px] text-zinc-300 cursor-pointer"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              setBusySavedVoice(true);
                              try {
                                const res = await api.updateSavedFishVoice(sv.id, {
                                  name: editVoiceName.trim(),
                                  voiceId: editVoiceId.trim(),
                                });
                                setSavedVoices(res.voices);
                                setEditingSavedVoiceId(null);
                              } finally {
                                setBusySavedVoice(false);
                              }
                            }}
                            className="px-2 py-1 rounded bg-violet-600 text-[11px] text-white cursor-pointer"
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div
                      key={sv.id}
                      className="px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-white/[0.06] flex items-center justify-between gap-2 text-xs"
                    >
                      <button
                        type="button"
                        onClick={() =>
                          updateVoiceMixer({ fishReferenceId: sv.voiceId, fishVoiceTitle: sv.name }, true)
                        }
                        className="flex-1 text-left truncate cursor-pointer text-zinc-200"
                      >
                        <Bookmark className="w-3 h-3 inline mr-1.5 text-violet-400" />
                        {sv.name}
                      </button>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={async () => {
                            const res = await api.updateSavedFishVoice(sv.id, { isDefault: true });
                            setSavedVoices(res.voices);
                          }}
                          className={`p-1 cursor-pointer ${sv.isDefault ? 'text-amber-400' : 'text-zinc-500'}`}
                        >
                          <Star className={`w-3 h-3 ${sv.isDefault ? 'fill-amber-400' : ''}`} />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingSavedVoiceId(sv.id);
                            setEditVoiceName(sv.name);
                            setEditVoiceId(sv.voiceId);
                          }}
                          className="p-1 text-zinc-400 hover:text-white cursor-pointer"
                        >
                          <Edit3 className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            const res = await api.deleteSavedFishVoice(sv.id);
                            setSavedVoices(res.voices);
                          }}
                          className="p-1 text-zinc-500 hover:text-red-400 cursor-pointer"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Add New Saved Voice */}
            <form onSubmit={handleSaveFishVoice} className="space-y-2 pt-2 border-t border-white/[0.06]">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                <input
                  type="text"
                  value={newVoiceName}
                  onChange={(e) => setNewVoiceName(e.target.value)}
                  placeholder="Voice name..."
                  className="bg-zinc-900 border border-white/[0.08] rounded px-2.5 py-1.5 text-xs text-white"
                />
                <input
                  type="text"
                  value={newVoiceId}
                  onChange={(e) => setNewVoiceId(e.target.value)}
                  placeholder="Reference ID..."
                  className="bg-zinc-900 border border-white/[0.08] rounded px-2.5 py-1.5 text-xs font-mono text-white"
                />
              </div>
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer">
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
                  className="px-2.5 py-1 rounded bg-violet-600 disabled:opacity-40 text-xs font-semibold text-white cursor-pointer"
                >
                  Save Voice
                </button>
              </div>
            </form>

            {/* Fish Catalog Search */}
            <div className="pt-2 border-t border-white/[0.06] space-y-2">
              <div className="flex gap-1.5">
                <div className="relative flex-1">
                  <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={voiceQuery}
                    onChange={(e) => setVoiceQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void loadFishVoices({ q: voiceQuery });
                    }}
                    placeholder="Search Fish Audio voices..."
                    className="w-full bg-zinc-900 border border-white/[0.08] rounded-lg pl-8 pr-2.5 py-1.5 text-xs text-zinc-100"
                  />
                </div>
                <label className="flex items-center gap-1 px-2 rounded-lg bg-zinc-900 border border-white/[0.08] text-[11px] text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selfVoicesOnly}
                    onChange={(e) => {
                      setSelfVoicesOnly(e.target.checked);
                      void loadFishVoices({ self: e.target.checked });
                    }}
                    className="accent-violet-500"
                  />
                  Mine
                </label>
                <button
                  type="button"
                  onClick={() => void loadFishVoices()}
                  className="px-2.5 rounded-lg bg-zinc-800 text-xs text-zinc-200 cursor-pointer"
                >
                  {loadingVoices ? '...' : 'Fetch'}
                </button>
              </div>
              {voicesError && <div className="text-[11px] text-amber-300">{voicesError}</div>}
              {voices.length > 0 && (
                <div className="max-h-36 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {voices.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() =>
                        updateVoiceMixer({ fishReferenceId: v.id, fishVoiceTitle: v.title }, true)
                      }
                      className={`text-left p-2 rounded-lg border text-xs cursor-pointer ${
                        voice.fishReferenceId === v.id
                          ? 'bg-violet-600/20 border-violet-500 text-white'
                          : 'bg-zinc-900 border-white/[0.06] text-zinc-300'
                      }`}
                    >
                      <div className="font-medium truncate">{v.title}</div>
                      <div className="text-[10px] text-zinc-500 truncate">{v.author}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Direct Reference ID Input */}
            <input
              type="text"
              value={voice.fishReferenceId || ''}
              onChange={(e) =>
                updateVoiceMixer(
                  { fishReferenceId: e.target.value },
                  false,
                  'audio:direct-ref'
                )
              }
              onBlur={(e) =>
                updateVoiceMixer({ fishReferenceId: e.target.value.trim() }, true)
              }
              placeholder="Direct Fish Audio reference_id..."
              className="w-full bg-zinc-900 border border-white/[0.08] rounded px-2.5 py-1.5 text-xs font-mono text-zinc-100"
            />
          </CollapsibleSection>
        </div>
      )}

      {/* TAB 3: TRANSCRIPTION & EXTERNAL GEMINI / AUTO TRANSLATION */}
      {memory.audioTab === 'script' && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 bg-zinc-900 border border-white/[0.08] rounded-xl p-0.5">
            <button
              type="button"
              onClick={() => onUpdateMemory({ voiceTranslationMode: 'external-gemini' })}
              className={`min-h-[36px] py-1.5 px-2 rounded-lg text-xs font-medium cursor-pointer ${
                memory.voiceTranslationMode === 'external-gemini'
                  ? 'bg-violet-600 text-white'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              External Gemini (Free JSON)
            </button>
            <button
              type="button"
              onClick={() => onUpdateMemory({ voiceTranslationMode: 'auto' })}
              className={`min-h-[36px] py-1.5 px-2 rounded-lg text-xs font-medium cursor-pointer ${
                memory.voiceTranslationMode === 'auto'
                  ? 'bg-violet-600 text-white'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Fish ASR + Translate
            </button>
          </div>

          {memory.voiceTranslationMode === 'external-gemini' ? (
            <ExternalGeminiTranslatorPanel
              project={project}
              onProjectUpdated={onProjectUpdated}
              sourceLanguage={sourceLanguage}
              targetLanguage={targetLanguage}
              onChangeTargetLanguage={(nextLang) => {
                setTargetLanguage(nextLang);
                updateVoiceMixer({ targetLanguage: nextLang }, true);
              }}
              preserveProperNouns={preserveProperNouns}
              onChangePreserveProperNouns={setPreserveProperNouns}
              allowedTargetLanguages={DUB_TARGET_LANGUAGES}
              focusAudioOverflowSignal={focusAudioOverflowSignal}
              onApprovedSuccess={(count, lang) => {
                setStatusMsg(
                  `Approved ${count} translated segments (${lang}). Switch to Dubbing Voice tab to generate MP3.`
                );
              }}
            />
          ) : (
            <div className="p-3 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-2.5">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10.5px] text-zinc-400">Source Language</label>
                  <select
                    value={sourceLanguage}
                    onChange={(e) => setSourceLanguage(e.target.value)}
                    className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded-lg px-2 py-1.5 text-xs text-zinc-100"
                  >
                    {SOURCE_LANGUAGES.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[10.5px] text-zinc-400">Target Language</label>
                  <select
                    value={targetLanguage}
                    onChange={(e) => {
                      const nextLang = e.target.value as SupportedLanguage;
                      setTargetLanguage(nextLang);
                      updateVoiceMixer({ targetLanguage: nextLang }, true);
                    }}
                    className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded-lg px-2 py-1.5 text-xs text-zinc-100"
                  >
                    {DUB_TARGET_LANGUAGES.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={preserveProperNouns}
                  onChange={(e) => setPreserveProperNouns(e.target.checked)}
                  className="accent-violet-500"
                />
                Preserve proper nouns &amp; character names
              </label>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={handleTranscribeFish}
                  disabled={!project.sourceVideoUrl || busyTranscribe}
                  className="min-h-[38px] py-2 px-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-xs font-semibold text-white flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  {busyTranscribe ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mic className="w-3.5 h-3.5 text-violet-400" />}
                  {busyTranscribe ? 'Transcribing...' : 'Fish Audio ASR'}
                </button>
                <button
                  type="button"
                  onClick={handleTranslate}
                  disabled={project.captions.length === 0 || busyTranslate}
                  className="min-h-[38px] py-2 px-3 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  {busyTranslate ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
                  {busyTranslate ? 'Translating...' : `Translate (${targetLanguage})`}
                </button>
              </div>
            </div>
          )}

          {/* Transcript & Translation Segment List */}
          <CollapsibleSection
            title={`Script Segments (${project.captions.length})`}
            subtitle="Edit original/translated script lines and timestamps"
            defaultOpen={project.captions.length > 0 && memory.voiceTranslationMode === 'auto'}
          >
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  patchScriptCaptions(
                    (curCaps) => {
                      const last = curCaps[curCaps.length - 1];
                      const start = last ? Number(last.end.toFixed(2)) : 0;
                      const end = Number(
                        Math.min(project.metadata?.duration || start + 4, start + 3).toFixed(2)
                      );
                      return [
                        ...curCaps,
                        {
                          id: `seg_${Date.now()}`,
                          start,
                          end: Math.max(start + 0.5, end),
                          text: '',
                          translatedText: '',
                        },
                      ];
                    },
                    { immediate: true }
                  );
                }}
                className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200 flex items-center gap-1 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" /> Add Segment
              </button>
            </div>

            <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
              {project.captions.map((seg, idx) => {
                const isActive = currentTime >= seg.start && currentTime <= seg.end;
                return (
                  <div
                    key={seg.id}
                    className={`p-2.5 rounded-lg border space-y-1.5 ${
                      isActive ? 'bg-violet-950/25 border-violet-500/45' : 'bg-zinc-900 border-white/[0.06]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <button
                        type="button"
                        onClick={() => onSeek(seg.start)}
                        className="font-mono text-violet-300 cursor-pointer"
                      >
                        #{idx + 1} · {formatTimecode(seg.start)} → {formatTimecode(seg.end)}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          patchScriptCaptions(
                            (curCaps) => curCaps.filter((c) => c.id !== seg.id),
                            { immediate: true }
                          )
                        }
                        className="text-zinc-500 hover:text-red-400 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <textarea
                      rows={2}
                      value={seg.translatedText || ''}
                      onChange={(e) => {
                        const val = e.target.value;
                        patchScriptCaptions(
                          (curCaps) =>
                            curCaps.map((c) =>
                              c.id === seg.id ? { ...c, translatedText: val } : c
                            ),
                          { undoGroupKey: `audio-seg-text:${seg.id}` }
                        );
                      }}
                      placeholder={`Translated dubbing line (${targetLanguage})...`}
                      className="w-full bg-[#111115] border border-white/[0.08] rounded px-2 py-1.5 text-xs text-zinc-100 resize-none"
                    />
                    {seg.text && (
                      <div className="text-[10px] text-zinc-500 truncate">Source: {seg.text}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </CollapsibleSection>
        </div>
      )}
    </div>
  );
}
