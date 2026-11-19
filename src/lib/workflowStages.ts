import {
  CaptionSegment,
  CaptionSyncSnapshot,
  DEFAULT_VIDEO_CANVAS,
  Project,
  ProjectWorkflowState,
  StageStatus,
  SupportedLanguage,
  VideoCanvasConfig,
  WorkflowStageId,
  WordTiming,
} from '../types/studio';

export interface WorkflowStageDef {
  id: WorkflowStageId;
  stepLabel: string;
  title: string;
  shortTitle: string;
  optional: boolean;
}

export const WORKFLOW_STAGES: WorkflowStageDef[] = [
  {
    id: 'translator',
    stepLabel: '1',
    title: 'Translation Studio',
    shortTitle: 'Translation',
    optional: false,
  },
  {
    id: 'voice',
    stepLabel: '2',
    title: 'Voice Studio',
    shortTitle: 'Voice',
    optional: false,
  },
  {
    id: 'editor',
    stepLabel: '3',
    title: 'Video Editor',
    shortTitle: 'Editor',
    optional: false,
  },
  {
    id: 'export',
    stepLabel: '4',
    title: 'Export',
    shortTitle: 'Export',
    optional: false,
  },
  {
    id: 'dashboard',
    stepLabel: '0',
    title: 'Projects & Import',
    shortTitle: 'Import',
    optional: false,
  },
  {
    id: 'captions',
    stepLabel: '3B',
    title: 'Captions (Editor)',
    shortTitle: 'Captions',
    optional: true,
  },
];

export function getActiveCaptionSourceText(
  seg: CaptionSegment,
  _useTranslated = true
): string {
  // MANDATORY RULE: Captions NEVER use originalText (seg.text). Only segment.translatedText.
  return (seg.translatedText || '').trim();
}

export function countMissingTranslations(captions: CaptionSegment[]): number {
  return captions.filter((seg) => !seg.translatedText || !seg.translatedText.trim()).length;
}

export function normalizeCaptionDisplayMode(
  mode: Project['subtitleStyle']['mode']
): 'word-by-word' | 'karaoke' | 'phrase-chunk' | 'sentence' {
  if (mode === 'word' || mode === 'word-by-word') return 'word-by-word';
  if (mode === 'karaoke') return 'karaoke';
  if (mode === 'phrase-chunk' || mode === 'two-words' || mode === 'three-words' || mode === 'four-words') {
    return 'phrase-chunk';
  }
  return 'sentence';
}

export function distributeWordsEvenly(
  text: string,
  start: number,
  end: number
): WordTiming[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const safeStart = Math.max(0, start);
  const safeEnd = Math.max(safeStart + 0.15, end);
  const totalDur = safeEnd - safeStart;
  const weights = words.map((w) =>
    Math.max(2, w.replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, '').length)
  );
  const weightSum = weights.reduce((a, b) => a + b, 0) || words.length;

  let cursor = safeStart;
  return words.map((word, idx) => {
    const share = (weights[idx] / weightSum) * totalDur;
    const wStart = cursor;
    const wEnd = idx === words.length - 1 ? safeEnd : wStart + share;
    cursor = wEnd;
    return {
      word,
      start: Number(wStart.toFixed(3)),
      end: Number(Math.max(wStart + 0.05, wEnd).toFixed(3)),
    };
  });
}

export interface SyncedPreviewCaption extends CaptionSegment {
  syncedStart: number;
  syncedEnd: number;
  speechStart: number;
  speechEnd: number;
  leadingSilence: number;
  trailingSilence: number;
  audioDuration: number;
  timingSource: 'actual' | 'estimated';
}

export function getSyncedCaptionsForPreview(project: Project): SyncedPreviewCaption[] {
  const useDubTimeline = Boolean(
    project.voice.enabled && (project.voice.syncPlan?.segments?.length || project.voice.generatedClips?.length)
  );
  const voiceOffset = Number(project.voice.timingOffsetSec || 0);
  const capOffset = Number(project.subtitleStyle.timingOffsetSec || 0);
  const totalOffset = (useDubTimeline ? voiceOffset : 0) + capOffset;

  const syncById = new Map(
    (project.voice.syncPlan?.segments || []).map((s) => [s.segmentId, s])
  );
  const clipById = new Map(
    (project.voice.generatedClips || []).map((c) => [c.segmentId, c])
  );

  return project.captions.map((seg) => {
    const syncSeg = useDubTimeline ? syncById.get(seg.id) : undefined;
    const clip = useDubTimeline ? clipById.get(seg.id) : undefined;

    const baseStart = syncSeg
      ? syncSeg.syncedStart
      : clip
      ? clip.start
      : seg.start;
    const baseEnd = syncSeg
      ? syncSeg.syncedEnd
      : clip
      ? clip.end
      : seg.end;

    const leadingSilence = syncSeg?.leadingSilence ?? clip?.leadingSilence ?? 0;
    const trailingSilence = syncSeg?.trailingSilence ?? clip?.trailingSilence ?? 0;
    const syncedStart = Math.max(0, Number((baseStart + totalOffset).toFixed(3)));
    const syncedEnd = Math.max(syncedStart + 0.15, Number((baseEnd + totalOffset).toFixed(3)));

    const rawSpeechStart = syncedStart + Math.max(0, leadingSilence);
    const rawSpeechEnd = Math.max(rawSpeechStart + 0.12, syncedEnd - Math.max(0, trailingSilence));
    const speechStart = Math.min(rawSpeechStart, syncedEnd - 0.12);
    const speechEnd = Math.min(syncedEnd, rawSpeechEnd);

    const activeText = getActiveCaptionSourceText(seg, true);
    const normalized = activeText.replace(/\s+/g, ' ').trim();
    const existingJoined = (seg.words || []).map((w) => w.word).join(' ').trim();
    const hasMatchingActualWords =
      seg.wordsSource === 'actual' &&
      Boolean(seg.words && seg.words.length > 0 && normalized && existingJoined === normalized);

    const words = hasMatchingActualWords
      ? seg.words!.map((w) => ({
          word: w.word,
          start: Math.max(0, Number((w.start + totalOffset).toFixed(3))),
          end: Math.max(0.05, Number((w.end + totalOffset).toFixed(3))),
        }))
      : distributeWordsEvenly(activeText, speechStart, speechEnd);

    return {
      ...seg,
      start: syncedStart,
      end: syncedEnd,
      syncedStart,
      syncedEnd,
      speechStart,
      speechEnd,
      leadingSilence,
      trailingSilence,
      audioDuration: clip?.duration ?? syncSeg?.audioDuration ?? Math.max(0, syncedEnd - syncedStart),
      words,
      wordsSource: hasMatchingActualWords ? 'actual' : 'estimated',
      timingSource: hasMatchingActualWords ? 'actual' : 'estimated',
    };
  });
}

export function getCaptionTimelineOffset(project: Project): number {
  const useDubTimeline = Boolean(
    project.voice.enabled && (project.voice.syncPlan?.segments?.length || project.voice.generatedClips?.length)
  );
  const voiceOffset = Number(project.voice.timingOffsetSec || 0);
  const capOffset = Number(project.subtitleStyle.timingOffsetSec || 0);
  return (useDubTimeline ? voiceOffset : 0) + capOffset;
}

export function updateCaptionTimingWithSync(
  project: Project,
  captionId: string,
  nextSyncedStart: number,
  nextSyncedEnd: number
): Pick<Project, 'captions' | 'voice'> {
  const safeStart = Math.max(0, Number(nextSyncedStart.toFixed(3)));
  const safeEnd = Math.max(safeStart + 0.15, Number(nextSyncedEnd.toFixed(3)));
  const totalOffset = getCaptionTimelineOffset(project);
  const baseStart = Math.max(0, Number((safeStart - totalOffset).toFixed(3)));
  const baseEnd = Math.max(baseStart + 0.15, Number((safeEnd - totalOffset).toFixed(3)));

  const captions = project.captions.map((c) =>
    c.id === captionId
      ? {
          ...c,
          start: baseStart,
          end: baseEnd,
          words: undefined,
          wordsSource: 'estimated' as const,
        }
      : c
  );

  let voice = project.voice;
  const hasSyncSeg = Boolean(voice.syncPlan?.segments?.some((s) => s.segmentId === captionId));
  const hasClip = Boolean(voice.generatedClips?.some((c) => c.segmentId === captionId));
  if (hasSyncSeg || hasClip) {
    voice = {
      ...voice,
      syncPlan: voice.syncPlan
        ? {
            ...voice.syncPlan,
            segments: voice.syncPlan.segments.map((s) =>
              s.segmentId === captionId
                ? {
                    ...s,
                    syncedStart: baseStart,
                    syncedEnd: baseEnd,
                  }
                : s
            ),
          }
        : undefined,
      generatedClips: (voice.generatedClips || []).map((c) =>
        c.segmentId === captionId
          ? {
              ...c,
              start: baseStart,
              end: baseEnd,
            }
          : c
      ),
    };
  }

  return { captions, voice };
}

export function splitCaptionWithSync(
  project: Project,
  captionId: string,
  splitSyncedTime?: number
): { captions: CaptionSegment[]; voice: Project['voice']; newSegmentId: string | null } {
  const syncedList = getSyncedCaptionsForPreview(project);
  const idx = syncedList.findIndex((c) => c.id === captionId);
  if (idx === -1) {
    return { captions: project.captions, voice: project.voice, newSegmentId: null };
  }
  const targetSynced = syncedList[idx];
  const rawSeg = project.captions[idx];
  const dur = Math.max(0.2, targetSynced.syncedEnd - targetSynced.syncedStart);
  if (dur < 0.32) {
    return { captions: project.captions, voice: project.voice, newSegmentId: null };
  }

  const totalOffset = getCaptionTimelineOffset(project);
  const rawSplit =
    splitSyncedTime !== undefined &&
    splitSyncedTime > targetSynced.syncedStart + 0.12 &&
    splitSyncedTime < targetSynced.syncedEnd - 0.12
      ? splitSyncedTime
      : Number((targetSynced.syncedStart + dur / 2).toFixed(3));

  const syncedStartA = Math.max(0, Number(targetSynced.syncedStart.toFixed(3)));
  const syncedEndA = Math.max(syncedStartA + 0.12, Number(rawSplit.toFixed(3)));
  const syncedStartB = syncedEndA;
  const syncedEndB = Math.max(syncedStartB + 0.12, Number(targetSynced.syncedEnd.toFixed(3)));

  const baseStartA = Math.max(0, Number((syncedStartA - totalOffset).toFixed(3)));
  const baseEndA = Math.max(baseStartA + 0.12, Number((syncedEndA - totalOffset).toFixed(3)));
  const baseStartB = baseEndA;
  const baseEndB = Math.max(baseStartB + 0.12, Number((syncedEndB - totalOffset).toFixed(3)));

  const ratio = Math.max(0.15, Math.min(0.85, (syncedEndA - syncedStartA) / dur));
  const splitWords = (txt: string | undefined): [string, string] => {
    const words = (txt || '').trim().split(/\s+/).filter(Boolean);
    if (words.length <= 1) return [txt || '', ''];
    const cut = Math.max(1, Math.min(words.length - 1, Math.round(words.length * ratio)));
    return [words.slice(0, cut).join(' '), words.slice(cut).join(' ')];
  };

  const [origA, origB] = splitWords(rawSeg.text);
  const [trA, trB] = splitWords(rawSeg.translatedText);
  const newSegmentId = `${rawSeg.id}-part-${Date.now().toString(36).slice(-4)}`;

  const segA: CaptionSegment = {
    ...rawSeg,
    start: baseStartA,
    end: baseEndA,
    text: origA || rawSeg.text,
    translatedText: rawSeg.translatedText ? trA || rawSeg.translatedText : '',
    words: undefined,
    wordsSource: 'estimated',
  };
  const segB: CaptionSegment = {
    ...rawSeg,
    id: newSegmentId,
    start: baseStartB,
    end: baseEndB,
    text: origB || rawSeg.text,
    translatedText: rawSeg.translatedText ? trB || rawSeg.translatedText : '',
    words: undefined,
    wordsSource: 'estimated',
  };

  const captions = [...project.captions];
  captions.splice(idx, 1, segA, segB);

  let voice = project.voice;
  if (voice.syncPlan?.segments?.some((s) => s.segmentId === captionId)) {
    const segIdx = voice.syncPlan.segments.findIndex((s) => s.segmentId === captionId);
    const origSync = voice.syncPlan.segments[segIdx];
    const nextSyncSegs = [...voice.syncPlan.segments];
    nextSyncSegs.splice(
      segIdx,
      1,
      {
        ...origSync,
        syncedStart: baseStartA,
        syncedEnd: baseEndA,
      },
      {
        ...origSync,
        segmentId: newSegmentId,
        originalStart: baseStartB,
        originalEnd: baseEndB,
        syncedStart: baseStartB,
        syncedEnd: baseEndB,
      }
    );
    voice = {
      ...voice,
      syncPlan: {
        ...voice.syncPlan,
        segments: nextSyncSegs,
      },
    };
  }
  if (voice.generatedClips?.some((c) => c.segmentId === captionId)) {
    voice = {
      ...voice,
      generatedClips: voice.generatedClips.map((c) =>
        c.segmentId === captionId ? { ...c, start: baseStartA, end: baseEndA } : c
      ),
    };
  }

  return { captions, voice, newSegmentId };
}

export function deleteCaptionWithSync(
  project: Project,
  captionId: string
): Pick<Project, 'captions' | 'voice'> {
  const captions = project.captions.filter((c) => c.id !== captionId);
  let voice = project.voice;
  if (voice.syncPlan?.segments?.some((s) => s.segmentId === captionId)) {
    voice = {
      ...voice,
      syncPlan: {
        ...voice.syncPlan,
        segments: voice.syncPlan.segments.filter((s) => s.segmentId !== captionId),
      },
    };
  }
  if (voice.generatedClips?.some((c) => c.segmentId === captionId)) {
    voice = {
      ...voice,
      generatedClips: voice.generatedClips.filter((c) => c.segmentId !== captionId),
    };
  }
  return { captions, voice };
}

export function mergeCaptionWithSync(
  project: Project,
  firstCaptionId: string
): Pick<Project, 'captions' | 'voice'> {
  const syncedList = getSyncedCaptionsForPreview(project);
  const idx = syncedList.findIndex((c) => c.id === firstCaptionId);
  if (idx === -1 || idx >= project.captions.length - 1) {
    return { captions: project.captions, voice: project.voice };
  }
  const aSynced = syncedList[idx];
  const bSynced = syncedList[idx + 1];
  const aRaw = project.captions[idx];
  const bRaw = project.captions[idx + 1];

  const totalOffset = getCaptionTimelineOffset(project);
  const baseStart = Math.max(0, Number((aSynced.syncedStart - totalOffset).toFixed(3)));
  const baseEnd = Math.max(baseStart + 0.15, Number((bSynced.syncedEnd - totalOffset).toFixed(3)));

  const mergedSeg: CaptionSegment = {
    ...aRaw,
    start: baseStart,
    end: baseEnd,
    text: [aRaw.text, bRaw.text].filter(Boolean).join(' ').trim(),
    translatedText: [aRaw.translatedText || '', bRaw.translatedText || '']
      .filter(Boolean)
      .join(' ')
      .trim(),
    words: undefined,
    wordsSource: 'estimated',
  };

  const captions = [...project.captions];
  captions.splice(idx, 2, mergedSeg);

  let voice = project.voice;
  if (voice.syncPlan?.segments?.length) {
    const nextSyncSegs = voice.syncPlan.segments
      .filter((s) => s.segmentId !== bRaw.id)
      .map((s) =>
        s.segmentId === aRaw.id
          ? {
              ...s,
              syncedStart: baseStart,
              syncedEnd: baseEnd,
            }
          : s
      );
    voice = {
      ...voice,
      syncPlan: {
        ...voice.syncPlan,
        segments: nextSyncSegs,
      },
    };
  }
  if (voice.generatedClips?.length) {
    voice = {
      ...voice,
      generatedClips: voice.generatedClips
        .filter((c) => c.segmentId !== bRaw.id)
        .map((c) => (c.segmentId === aRaw.id ? { ...c, start: baseStart, end: baseEnd } : c)),
    };
  }

  return { captions, voice };
}

export function resolveCaptionWords(
  seg: CaptionSegment,
  _useTranslated = true
): WordTiming[] {
  const activeSource = getActiveCaptionSourceText(seg, true);
  if (!activeSource) return [];
  const normalized = activeSource.replace(/\s+/g, ' ').trim();
  const existingJoined = (seg.words || []).map((w) => w.word).join(' ').trim();

  if (seg.words && seg.words.length > 0 && existingJoined === normalized) {
    return seg.words.map((w, idx) => {
      const next = seg.words![idx + 1];
      const start = idx === 0 ? Math.min(seg.start, w.start) : w.start;
      const end = next ? Math.max(w.end, next.start) : Math.max(seg.end, w.end);
      return {
        word: w.word,
        start,
        end: Math.max(start + 0.05, end),
      };
    });
  }
  return distributeWordsEvenly(activeSource, seg.start, seg.end);
}

export interface CaptionSyncStatus {
  hasSnapshot: boolean;
  generatedAt: string | null;
  sourceMode: 'translated' | 'original';
  targetLanguage: SupportedLanguage;
  outdatedSegmentIds: string[];
  outdatedReasons: Record<string, string>;
  hasOutdated: boolean;
}

export function computeCaptionSyncStatus(project: Project): CaptionSyncStatus {
  const snap = project.subtitleStyle.captionSync;
  const activeMode: 'translated' | 'original' = 'translated';
  const targetLanguage =
    project.voice.targetLanguage || project.translation.targetLanguage || 'French';

  if (!snap) {
    return {
      hasSnapshot: false,
      generatedAt: null,
      sourceMode: activeMode,
      targetLanguage,
      outdatedSegmentIds: [],
      outdatedReasons: {},
      hasOutdated: false,
    };
  }

  const outdatedSegmentIds: string[] = [];
  const outdatedReasons: Record<string, string> = {};
  const syncById = new Map(
    (project.voice.syncPlan?.segments || []).map((s) => [s.segmentId, s])
  );

  for (const seg of project.captions) {
    const currentText = getActiveCaptionSourceText(seg, true);
    const prevText = snap.segmentTexts?.[seg.id];
    const synced = syncById.get(seg.id);
    const currentTimeKey = synced
      ? `${synced.syncedStart.toFixed(2)}-${synced.syncedEnd.toFixed(2)}`
      : `${seg.start.toFixed(2)}-${seg.end.toFixed(2)}`;
    const prevTimeKey = snap.segmentTimes?.[seg.id];

    if (prevText === undefined) {
      outdatedSegmentIds.push(seg.id);
      outdatedReasons[seg.id] = 'Segment added after captions were generated';
    } else if (currentText !== prevText) {
      outdatedSegmentIds.push(seg.id);
      outdatedReasons[seg.id] = 'translatedText edited in Transcript & Translation Editor';
    } else if (prevTimeKey && prevTimeKey !== currentTimeKey) {
      outdatedSegmentIds.push(seg.id);
      outdatedReasons[seg.id] = 'Voiceover narration timeline updated';
    }
  }

  return {
    hasSnapshot: true,
    generatedAt: snap.generatedAt,
    sourceMode: activeMode,
    targetLanguage,
    outdatedSegmentIds,
    outdatedReasons,
    hasOutdated: outdatedSegmentIds.length > 0,
  };
}

/**
 * Generates timed captions strictly from segment.translatedText and the FINAL voiceover timeline
 * (NEVER falls back to originalText / ASR).
 */
export function buildCaptionsFromTranscript(project: Project): {
  captions: CaptionSegment[];
  subtitleStyle: Project['subtitleStyle'];
  sourceMode: 'translated';
  targetLanguage: SupportedLanguage;
  missingCount: number;
} {
  if (!project.captions || project.captions.length === 0) {
    throw new Error(
      'No segments found in Transcript & Translation Editor. Add or import translated JSON in Stage 2 / Stage 3–4 first.'
    );
  }

  const translatedCount = project.captions.filter((c) => Boolean(c.translatedText?.trim())).length;
  if (translatedCount === 0) {
    throw new Error(
      'Missing translatedText on all segments. Captions are generated exclusively from segment.translatedText and never fall back to original text.'
    );
  }

  const missingCount = project.captions.length - translatedCount;
  const targetLanguage =
    project.voice.targetLanguage || project.translation.targetLanguage || 'French';

  const syncById = new Map(
    (project.voice.syncPlan?.segments || []).map((s) => [s.segmentId, s])
  );
  const clipById = new Map(
    (project.voice.generatedClips || []).map((c) => [c.segmentId, c])
  );

  const segmentTexts: Record<string, string> = {};
  const segmentTimes: Record<string, string> = {};

  const updatedCaptions: CaptionSegment[] = project.captions.map((seg) => {
    const activeText = getActiveCaptionSourceText(seg, true);
    const synced = syncById.get(seg.id);
    const clip = clipById.get(seg.id);
    const tStart = synced ? synced.syncedStart : clip ? clip.start : seg.start;
    const tEnd = synced ? synced.syncedEnd : clip ? clip.end : seg.end;
    const leadSil = synced?.leadingSilence ?? clip?.leadingSilence ?? 0;
    const trailSil = synced?.trailingSilence ?? clip?.trailingSilence ?? 0;
    const speechStart = Math.min(tEnd - 0.12, tStart + Math.max(0, leadSil));
    const speechEnd = Math.max(speechStart + 0.12, tEnd - Math.max(0, trailSil));

    segmentTexts[seg.id] = activeText;
    segmentTimes[seg.id] = `${tStart.toFixed(2)}-${tEnd.toFixed(2)}`;

    return {
      ...seg,
      wordsSource: 'estimated' as const,
      words: activeText ? distributeWordsEvenly(activeText, speechStart, speechEnd) : [],
    };
  });

  const captionSync: CaptionSyncSnapshot = {
    generatedAt: new Date().toISOString(),
    sourceMode: 'translated',
    targetLanguage,
    segmentTexts,
    segmentTimes,
  };

  return {
    captions: updatedCaptions,
    subtitleStyle: {
      ...project.subtitleStyle,
      enabled: true,
      useTranslated: true,
      captionSync,
    },
    sourceMode: 'translated',
    targetLanguage,
    missingCount,
  };
}

export interface StageStatusInfo {
  id: WorkflowStageId;
  stepLabel: string;
  title: string;
  shortTitle: string;
  status: StageStatus;
  canContinue: boolean;
  validationMessage?: string;
  attentionReason?: string;
  optional: boolean;
}

export function computeStageStatuses(
  project: Project | null,
  activeStage: WorkflowStageId
): StageStatusInfo[] {
  const wf = project?.workflow;
  const visited = new Set<WorkflowStageId>(wf?.visitedStages || []);
  const completed = new Set<WorkflowStageId>(wf?.completedStages || []);
  const attention = new Set<WorkflowStageId>(wf?.needsAttentionStages || []);
  const captionSync = project ? computeCaptionSyncStatus(project) : null;

  return WORKFLOW_STAGES.map((def): StageStatusInfo => {
    if (!project) {
      return {
        ...def,
        status: def.id === activeStage ? 'In Progress' : 'Not Started',
        canContinue: false,
        validationMessage: 'Create or upload a project video first.',
      };
    }

    const hasVideo = Boolean(project.sourceVideoUrl && project.metadata);
    const hasTranscript = project.captions.length > 0;
    const hasTranslations = project.captions.some((c) => Boolean(c.translatedText?.trim()));
    const hasDub = Boolean(project.voice.enabled && project.voice.fullDubUrl);
    const hasPendingVoiceRegen =
      (project.translation.pendingRegenerateSegmentIds?.length || 0) > 0;
    const hasVoiceConflict = Boolean(
      project.voice.syncPlan &&
        (project.voice.syncPlan.conflictCount > 0 ||
          (project.voice.syncPlan.narrationAudit &&
            !project.voice.syncPlan.narrationAudit.isComplete))
    );
    const canvasEdited =
      project.canvas &&
      (project.canvas.aspectRatio !== 'original' ||
        project.canvas.zoom !== 1 ||
        project.canvas.offsetX !== 0 ||
        project.canvas.offsetY !== 0 ||
        (project.canvas.videoRotation || 0) !== 0 ||
        Boolean(project.canvas.flipH) ||
        Boolean(project.canvas.flipV) ||
        (project.canvas.videoOpacity ?? 1) !== 1 ||
        project.canvas.videoVisible === false ||
        (project.canvas.cropMode && project.canvas.cropMode !== 'fit') ||
        Boolean(project.canvas.cropWidth && project.canvas.cropHeight) ||
        (project.canvas.backgroundType && project.canvas.backgroundType !== 'solid') ||
        project.canvas.cropTop > 0 ||
        project.canvas.cropRight > 0 ||
        project.canvas.cropBottom > 0 ||
        project.canvas.cropLeft > 0);
    const hasVisualEdits =
      project.videoEffects?.filterPreset !== 'none' ||
      (project.videoEffects?.effects?.some((e) => e.enabled) ?? false) ||
      project.blurs.some((b) => b.enabled) ||
      project.logos.some((l) => l.enabled) ||
      Boolean(canvasEdited);

    let canContinue = true;
    let validationMessage: string | undefined;
    let attentionReason: string | undefined;
    let status: StageStatus = 'Not Started';

    if (def.id === 'dashboard') {
      if (!hasVideo) {
        canContinue = false;
        validationMessage = 'Upload a source video (MP4, MOV, or MKV) before continuing to Stage 2.';
        status = activeStage === 'dashboard' || project.id ? 'In Progress' : 'Not Started';
      } else {
        status = 'Completed';
      }
    } else if (def.id === 'translator') {
      if (!hasVideo) {
        canContinue = false;
        validationMessage = 'Stage 1 requires a source video first.';
      }
      if (attention.has('translator')) {
        status = 'Needs Attention';
        attentionReason = 'Source video changed — review transcript and translations.';
      } else if (hasTranslations || completed.has('translator')) {
        status = 'Completed';
      } else if (hasTranscript || visited.has('translator') || activeStage === 'translator') {
        status = 'In Progress';
      }
    } else if (def.id === 'voice') {
      if (!hasVideo) {
        canContinue = false;
        validationMessage = 'Stage 1 requires a source video first.';
      }
      if (attention.has('voice') || hasPendingVoiceRegen || hasVoiceConflict) {
        status = 'Needs Attention';
        attentionReason = hasPendingVoiceRegen
          ? `${project.translation.pendingRegenerateSegmentIds?.length} edited segment(s) need Fish Audio regeneration.`
          : hasVoiceConflict
          ? 'Audio sync conflicts or missing narration segments detected.'
          : 'Upstream script or media changed — review Voiceover & Sync.';
      } else if (hasDub || completed.has('voice')) {
        status = 'Completed';
      } else if (visited.has('voice') || activeStage === 'voice' || hasTranscript) {
        status = 'In Progress';
      }
    } else if (def.id === 'editor') {
      if (!hasVideo) {
        canContinue = false;
        validationMessage = 'Stage 1 requires a source video first.';
      }
      if (attention.has('editor')) {
        status = 'Needs Attention';
        attentionReason = 'Source video changed — review canvas, blurs, and logos.';
      } else if (completed.has('editor') || (hasVisualEdits && activeStage !== 'editor')) {
        status = 'Completed';
      } else if (visited.has('editor') || activeStage === 'editor' || hasVisualEdits) {
        status = 'In Progress';
      }
    } else if (def.id === 'captions') {
      if (!hasVideo) {
        canContinue = false;
        validationMessage = 'Stage 1 requires a source video first.';
      }
      if (attention.has('captions') || captionSync?.hasOutdated) {
        status = 'Needs Attention';
        attentionReason = captionSync?.hasOutdated
          ? `${captionSync.outdatedSegmentIds.length} caption segment(s) outdated after translation edits.`
          : 'Upstream transcript changed — review manual captions.';
      } else if (completed.has('captions') || captionSync?.hasSnapshot || project.subtitleStyle.enabled) {
        status = 'Completed';
      } else if (visited.has('captions') || activeStage === 'captions') {
        status = 'In Progress';
      }
    } else if (def.id === 'export') {
      canContinue = false; // Final stage
      if (!hasVideo) {
        validationMessage = 'Stage 1 requires a source video before exporting.';
      }
      if (attention.has('export')) {
        status = 'Needs Attention';
        attentionReason = 'Project settings changed since last MP4 export — re-render when ready.';
      } else if (project.lastExportUrl) {
        status = 'Completed';
      } else if (visited.has('export') || activeStage === 'export') {
        status = 'In Progress';
      }
    }

    return {
      ...def,
      status,
      canContinue,
      validationMessage,
      attentionReason,
    };
  });
}

export function createWorkflowUpdate(
  existing: ProjectWorkflowState | undefined,
  opts: {
    visitStage?: WorkflowStageId;
    completeStage?: WorkflowStageId;
    clearAttentionFor?: WorkflowStageId;
    modifiedStage?: WorkflowStageId;
    hasExistingExport?: boolean;
    hasGeneratedDub?: boolean;
    hasGeneratedCaptions?: boolean;
  }
): ProjectWorkflowState {
  const visited = new Set<WorkflowStageId>(existing?.visitedStages || []);
  const completed = new Set<WorkflowStageId>(existing?.completedStages || []);
  const attention = new Set<WorkflowStageId>(existing?.needsAttentionStages || []);

  if (opts.visitStage) visited.add(opts.visitStage);
  if (opts.completeStage) {
    visited.add(opts.completeStage);
    completed.add(opts.completeStage);
    attention.delete(opts.completeStage);
  }
  if (opts.clearAttentionFor) {
    attention.delete(opts.clearAttentionFor);
  }

  if (opts.modifiedStage === 'dashboard') {
    if (completed.has('translator') || visited.has('translator')) attention.add('translator');
    if (opts.hasGeneratedDub || completed.has('voice')) attention.add('voice');
    if (completed.has('editor')) attention.add('editor');
    if (opts.hasGeneratedCaptions || completed.has('captions')) attention.add('captions');
    if (opts.hasExistingExport) attention.add('export');
  } else if (opts.modifiedStage === 'translator') {
    if (opts.hasGeneratedDub) attention.add('voice');
    if (opts.hasGeneratedCaptions) attention.add('captions');
    if (opts.hasExistingExport) attention.add('export');
  } else if (opts.modifiedStage === 'voice') {
    if (opts.hasGeneratedCaptions) attention.add('captions');
    if (opts.hasExistingExport) attention.add('export');
  } else if (opts.modifiedStage === 'editor') {
    if (opts.hasExistingExport) attention.add('export');
  } else if (opts.modifiedStage === 'captions') {
    if (opts.hasExistingExport) attention.add('export');
  }

  return {
    visitedStages: Array.from(visited),
    completedStages: Array.from(completed),
    needsAttentionStages: Array.from(attention),
    lastModifiedStage: opts.modifiedStage || existing?.lastModifiedStage,
    revisions: existing?.revisions,
  };
}

export function resolveCanvasDimensions(
  canvas: VideoCanvasConfig | undefined,
  exportSettings: Project['exportSettings'],
  metadata: Project['metadata']
): { width: number; height: number } {
  const c = canvas || DEFAULT_VIDEO_CANVAS;
  const effectiveRatio =
    c.aspectRatio && c.aspectRatio !== 'original'
      ? c.aspectRatio
      : exportSettings.aspectRatio;

  if (effectiveRatio === 'custom') {
    const w = Math.max(240, Math.min(3840, Math.round(c.customWidth || 1080))) & ~1;
    const h = Math.max(240, Math.min(3840, Math.round(c.customHeight || 1920))) & ~1;
    return { width: w, height: h };
  }

  const shortSide =
    exportSettings.resolution === '480p'
      ? 480
      : exportSettings.resolution === '720p'
      ? 720
      : 1080;

  if (effectiveRatio === 'original' && metadata?.width && metadata?.height) {
    if (metadata.width >= metadata.height) {
      const height = shortSide & ~1;
      const width = Math.max(2, Math.round((metadata.width / metadata.height) * height) & ~1);
      return { width, height };
    }
    const width = shortSide & ~1;
    const height = Math.max(2, Math.round((metadata.height / metadata.width) * width) & ~1);
    return { width, height };
  }

  if (effectiveRatio === '9:16') {
    const width = shortSide & ~1;
    const height = Math.round((width * 16) / 9) & ~1;
    return { width, height };
  }
  if (effectiveRatio === '4:5') {
    const width = shortSide & ~1;
    const height = Math.round((width * 5) / 4) & ~1;
    return { width, height };
  }
  if (effectiveRatio === '3:4') {
    const width = shortSide & ~1;
    const height = Math.round((width * 4) / 3) & ~1;
    return { width, height };
  }
  if (effectiveRatio === '1:1') {
    return { width: shortSide & ~1, height: shortSide & ~1 };
  }

  const height = shortSide & ~1;
  const width = Math.round((height * 16) / 9) & ~1;
  return { width, height };
}

export type PipelineStepId = 'translator' | 'voice' | 'editor' | 'export' | 'styles';

export interface EditorValidationResult {
  valid: boolean;
  errors: string[];
  translationValid: boolean;
  audioCompleted: boolean;
  segmentsMapped: boolean;
  summary: {
    totalSegments: number;
    translatedCount: number;
    matchedAudioCount: number;
    pendingRegenCount: number;
    totalAudioDuration: number;
  };
}

export function validateProjectReadyForEditor(
  project: Project | null,
  activeDubJobStatus?: string | null
): EditorValidationResult {
  if (!project) {
    return {
      valid: false,
      errors: ['Select or import a project video first.'],
      translationValid: false,
      audioCompleted: false,
      segmentsMapped: false,
      summary: {
        totalSegments: 0,
        translatedCount: 0,
        matchedAudioCount: 0,
        pendingRegenCount: 0,
        totalAudioDuration: 0,
      },
    };
  }

  const errors: string[] = [];
  if (!project.sourceVideoUrl) {
    errors.push('Import a source video before continuing.');
  }

  const captions = project.captions || [];
  if (captions.length === 0) {
    errors.push('Create or transcribe at least one script segment.');
  }

  const speakableCaptions = captions.filter(
    (c) => Boolean((c.translatedText || '').trim()) || Boolean((c.text || '').trim())
  );
  const missingTransIndices = captions
    .map((c, idx) => ({ idx: idx + 1, hasTr: Boolean((c.translatedText || '').trim()) }))
    .filter((item) => !item.hasTr)
    .map((item) => `#${item.idx}`);

  const translatedCount = captions.length - missingTransIndices.length;
  const translationValid = captions.length > 0 && missingTransIndices.length === 0;
  if (captions.length > 0 && missingTransIndices.length > 0) {
    const previewList = missingTransIndices.slice(0, 4).join(', ');
    const moreSuffix = missingTransIndices.length > 4 ? ` (+${missingTransIndices.length - 4} more)` : '';
    errors.push(
      `Translation is missing text for segment(s) ${previewList}${moreSuffix}. Complete all translated lines first.`
    );
  }

  const pendingRegen = (project.translation?.pendingRegenerateSegmentIds || []).filter((id) =>
    captions.some((c) => c.id === id)
  );
  if (pendingRegen.length > 0) {
    errors.push(
      `${pendingRegen.length} edited segment(s) need audio regeneration ("Regenerate Corrected Only") before entering the Editor.`
    );
  }

  if (activeDubJobStatus === 'queued' || activeDubJobStatus === 'processing') {
    errors.push('Audio generation is still in progress. Wait for it to finish.');
  } else if (activeDubJobStatus === 'failed') {
    errors.push('Last audio generation failed. Generate the voiceover again before continuing.');
  }

  const clips = project.voice?.generatedClips || [];
  const clipsBySegId = new Map<string, (typeof clips)[number]>();
  for (const clip of clips) {
    if (clip.segmentId) clipsBySegId.set(clip.segmentId, clip);
  }

  const missingAudioSegNums: string[] = [];
  let matchedAudioCount = 0;
  let totalAudioDuration = 0;

  speakableCaptions.forEach((seg, idx) => {
    const clip = clipsBySegId.get(seg.id);
    if (!clip || !clip.audioUrl || !clip.audioUrl.trim() || !(clip.duration > 0)) {
      missingAudioSegNums.push(`#${idx + 1}`);
    } else {
      matchedAudioCount += 1;
      totalAudioDuration += clip.duration;
    }
  });

  const hasDubUrl = Boolean(project.voice?.fullDubUrl && project.voice.fullDubUrl.trim());
  const audioCompleted =
    activeDubJobStatus !== 'queued' &&
    activeDubJobStatus !== 'processing' &&
    activeDubJobStatus !== 'failed' &&
    hasDubUrl &&
    clips.length > 0 &&
    pendingRegen.length === 0;

  if (!hasDubUrl || clips.length === 0) {
    errors.push('Generate the Fish Audio voiceover before validating and opening the Editor.');
  } else if (missingAudioSegNums.length > 0) {
    const previewMissing = missingAudioSegNums.slice(0, 4).join(', ');
    const moreSuffix = missingAudioSegNums.length > 4 ? ` (+${missingAudioSegNums.length - 4} more)` : '';
    errors.push(
      `Generated audio is missing or unlinked for segment ID(s) ${previewMissing}${moreSuffix}.`
    );
  }

  const segmentsMapped =
    speakableCaptions.length > 0 &&
    matchedAudioCount === speakableCaptions.length &&
    missingAudioSegNums.length === 0;

  return {
    valid: errors.length === 0,
    errors,
    translationValid,
    audioCompleted,
    segmentsMapped,
    summary: {
      totalSegments: captions.length,
      translatedCount,
      matchedAudioCount,
      pendingRegenCount: pendingRegen.length,
      totalAudioDuration: Number(totalAudioDuration.toFixed(2)),
    },
  };
}

export interface PipelineStepInfo {
  id: PipelineStepId;
  number: string;
  label: string;
  shortLabel: string;
  completed: boolean;
  active: boolean;
  accessible: boolean;
}

export function getPipelineSteps(
  project: Project | null,
  activeStep: PipelineStepId
): PipelineStepInfo[] {
  const hasVideo = Boolean(project?.sourceVideoUrl);
  const validation = validateProjectReadyForEditor(project);
  const isValidated =
    validation.valid &&
    Boolean(project?.voice?.enabled) &&
    Boolean(project?.workflow?.completedStages?.includes('voice'));
  const hasExport = Boolean(project?.lastExportUrl);

  return [
    {
      id: 'translator',
      number: '1',
      label: 'Translation Studio',
      shortLabel: 'Translate',
      completed: validation.translationValid,
      active: activeStep === 'translator',
      accessible: hasVideo,
    },
    {
      id: 'voice',
      number: '2',
      label: 'Voice Studio',
      shortLabel: 'Voice',
      completed: isValidated,
      active: activeStep === 'voice',
      accessible: hasVideo,
    },
    {
      id: 'editor',
      number: '3',
      label: 'Video Editor',
      shortLabel: 'Editor',
      completed: Boolean(project?.workflow?.completedStages?.includes('editor')) || hasExport,
      active: activeStep === 'editor',
      accessible: hasVideo && isValidated,
    },
    {
      id: 'export',
      number: '4',
      label: 'Export',
      shortLabel: 'Export',
      completed: hasExport,
      active: activeStep === 'export',
      accessible: hasVideo,
    },
    {
      id: 'styles',
      number: '★',
      label: 'My Saved Styles',
      shortLabel: 'Styles',
      completed: false,
      active: activeStep === 'styles',
      accessible: true,
    },
  ];
}

