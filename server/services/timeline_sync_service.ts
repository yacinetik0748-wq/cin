import {
  BlurEffect,
  CaptionSegment,
  GeneratedVoiceClip,
  LogoOverlay,
  NarrationAuditReport,
  SegmentGapDiagnostic,
  SyncMode,
  TimelineAdjustedSegment,
  TimelineSyncPlan,
  VideoExtensionHold,
} from '../../src/types/studio.ts';

const MIN_BREATH_GAP_SEC = 0.08;
export const DEFAULT_CONTINUOUS_PAUSE_MS = 320;
const VISUAL_MISMATCH_THRESHOLD_SEC = 2.5;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function normalizeSyncMode(mode?: unknown): SyncMode {
  if (mode === 'original' || mode === 'continuous' || mode === 'flexible') {
    return mode;
  }
  return 'flexible';
}

export function clampContinuousPauseMs(ms?: unknown): number {
  const num = Number(ms);
  if (!Number.isFinite(num) || num <= 0) {
    return DEFAULT_CONTINUOUS_PAUSE_MS;
  }
  return Math.max(150, Math.min(800, Math.round(num)));
}

export function hasSpeakableNarrationText(text?: string | null): boolean {
  return Boolean(text && /[\p{L}\p{N}]/u.test(text));
}

export interface TimelineSyncInputClip {
  segmentId: string;
  start: number;
  end: number;
  duration: number;
  speechDuration?: number;
  leadingSilence?: number;
  trailingSilence?: number;
}

/**
 * Compares expected speakable transcript segments against generated audio clips
 * to detect missing, empty/near-empty, duplicate, or out-of-order segments.
 */
export function auditProjectNarration(
  captions: CaptionSegment[],
  measuredClips: TimelineSyncInputClip[]
): NarrationAuditReport {
  const expectedOrdered = [...captions]
    .map((seg, idx) => ({ seg, idx }))
    .filter(({ seg }) =>
      hasSpeakableNarrationText(
        (seg.translatedText && seg.translatedText.trim()
          ? seg.translatedText
          : seg.text
        )?.trim()
      )
    )
    .sort((a, b) => a.seg.start - b.seg.start || a.idx - b.idx);

  const expectedSegmentIds = expectedOrdered.map(({ seg }) => seg.id);
  const expectedIndexMap = new Map<string, number>();
  expectedSegmentIds.forEach((id, i) => expectedIndexMap.set(id, i));

  const seenCounts = new Map<string, number>();
  const clipById = new Map<string, TimelineSyncInputClip>();
  const generatedSegmentIds: string[] = [];

  for (const clip of measuredClips) {
    generatedSegmentIds.push(clip.segmentId);
    seenCounts.set(clip.segmentId, (seenCounts.get(clip.segmentId) || 0) + 1);
    if (!clipById.has(clip.segmentId)) {
      clipById.set(clip.segmentId, clip);
    }
  }

  const duplicateSegmentIds = Array.from(seenCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([id]) => id);

  const missingSegmentIds = expectedSegmentIds.filter((id) => !clipById.has(id));

  const emptySegmentIds = measuredClips
    .filter((clip) => clip.duration <= 0.08 || (clip.speechDuration ?? clip.duration) <= 0.05)
    .map((clip) => clip.segmentId);

  const outOfOrderSegmentIds: string[] = [];
  let maxExpectedIdx = -1;
  for (const clip of measuredClips) {
    const expIdx = expectedIndexMap.get(clip.segmentId);
    if (expIdx === undefined) continue;
    if (expIdx < maxExpectedIdx) {
      outOfOrderSegmentIds.push(clip.segmentId);
    } else {
      maxExpectedIdx = expIdx;
    }
  }

  const isComplete =
    missingSegmentIds.length === 0 &&
    emptySegmentIds.length === 0 &&
    duplicateSegmentIds.length === 0 &&
    outOfOrderSegmentIds.length === 0;

  const issues: string[] = [];
  if (missingSegmentIds.length > 0) {
    issues.push(`${missingSegmentIds.length} missing`);
  }
  if (emptySegmentIds.length > 0) {
    issues.push(`${emptySegmentIds.length} empty/corrupt`);
  }
  if (duplicateSegmentIds.length > 0) {
    issues.push(`${duplicateSegmentIds.length} duplicate`);
  }
  if (outOfOrderSegmentIds.length > 0) {
    issues.push(`${outOfOrderSegmentIds.length} out-of-order`);
  }

  const summary = isComplete
    ? `All ${expectedSegmentIds.length} narration segments verified in chronological order with zero missing clips.`
    : `Narration audit detected issues across ${expectedSegmentIds.length} expected segments: ${issues.join(', ')}.`;

  return {
    expectedSegmentIds,
    generatedSegmentIds,
    missingSegmentIds,
    emptySegmentIds,
    duplicateSegmentIds,
    outOfOrderSegmentIds,
    isComplete,
    summary,
  };
}

export function buildTimelineSyncPlan(params: {
  captions: CaptionSegment[];
  measuredClips: TimelineSyncInputClip[];
  originalVideoDuration: number;
  syncMode: SyncMode;
  continuousPauseMs?: number;
}): TimelineSyncPlan {
  const originalDur = Math.max(0.5, params.originalVideoDuration || 10);
  const syncMode = normalizeSyncMode(params.syncMode);
  const pauseDurationMs = clampContinuousPauseMs(params.continuousPauseMs);
  const pauseSec = pauseDurationMs / 1000;

  const narrationAudit = auditProjectNarration(params.captions, params.measuredClips);

  const clipById = new Map<string, TimelineSyncInputClip>();
  for (const c of params.measuredClips) {
    if (!clipById.has(c.segmentId)) {
      clipById.set(c.segmentId, c);
    }
  }

  const ordered = params.captions
    .map((seg, origIndex) => {
      const clip = clipById.get(seg.id);
      const origStart = Math.max(0, seg.start);
      const origEnd = Math.max(origStart + 0.2, seg.end);
      const audioDuration = clip ? Math.max(0.08, clip.duration) : Math.max(0.2, origEnd - origStart);
      const leadingSilence = clip?.leadingSilence ?? 0;
      const trailingSilence = clip?.trailingSilence ?? 0;
      const speechDuration =
        clip?.speechDuration !== undefined && clip.speechDuration > 0
          ? Math.min(audioDuration, clip.speechDuration)
          : Math.max(0.05, audioDuration - leadingSilence - trailingSilence);
      return {
        seg,
        origIndex,
        origStart,
        origEnd,
        audioDuration,
        speechDuration,
        leadingSilence,
        trailingSilence,
        hasClip: Boolean(clip),
      };
    })
    .filter((item) => item.hasClip)
    .sort((a, b) => a.origStart - b.origStart || a.origIndex - b.origIndex);

  const segments: TimelineAdjustedSegment[] = [];
  const rawHolds: VideoExtensionHold[] = [];
  const warnings: string[] = [];

  let cumulativeHold = 0;
  let prevSyncedEnd = 0;

  for (let i = 0; i < ordered.length; i++) {
    const cur = ordered[i];
    const next = i + 1 < ordered.length ? ordered[i + 1] : null;
    const nextOrigStart = next ? Math.max(cur.origStart, next.origStart) : originalDur;

    const mappedOrigStart = cur.origStart + cumulativeHold;
    const mappedOrigEnd = cur.origEnd + cumulativeHold;

    let desiredStart = mappedOrigStart;
    if (syncMode === 'original') {
      // Original Scene Timing: keep original start timestamps unless strictly required to avoid overlap
      desiredStart = i === 0 ? mappedOrigStart : Math.max(mappedOrigStart, prevSyncedEnd + 0.04);
    } else if (syncMode === 'continuous') {
      // Continuous Narration Engine:
      // Place every segment sequentially right after the previous spoken audio ends + natural pause (default 320ms).
      // Never wait for original segment boundaries or insert multi-second dead gaps.
      if (i === 0) {
        desiredStart = cur.origStart <= 0.5 ? cur.origStart : 0.15;
      } else {
        desiredStart = prevSyncedEnd + pauseSec;
      }
    } else {
      // Smart Gap Removal (flexible mode):
      // Collapse unnecessarily long silent intervals (> 0.65s) after previous speech while respecting scene order.
      if (i === 0) {
        desiredStart = cur.origStart <= 0.8 ? mappedOrigStart : 0.25;
      } else {
        const naturalStart = prevSyncedEnd + pauseSec;
        const unusedGap = mappedOrigStart - prevSyncedEnd;
        if (unusedGap > 0.65) {
          // Safely pull next segment forward right after previous speech + short rhythmic breathing pause
          const extraBreath = Math.min(0.25, unusedGap * 0.08);
          desiredStart = naturalStart + extraBreath;
        } else {
          desiredStart = Math.max(mappedOrigStart, prevSyncedEnd + MIN_BREATH_GAP_SEC);
        }
      }
    }

    const neededEnd = desiredStart + cur.audioDuration;
    const nextMappedStart = nextOrigStart + cumulativeHold;
    const availableEndBeforeNext = next
      ? nextMappedStart - MIN_BREATH_GAP_SEC
      : originalDur + cumulativeHold;

    let adjustmentType: TimelineAdjustedSegment['adjustmentType'] = 'unchanged';
    let holdAddedSec = 0;
    let conflict = false;
    let conflictReason: string | undefined;

    if (syncMode === 'original') {
      adjustmentType = desiredStart > mappedOrigStart + 0.03 ? 'shifted' : 'unchanged';
      if (neededEnd > mappedOrigEnd + 0.2 || desiredStart > mappedOrigStart + 0.05) {
        conflict = true;
        conflictReason = `1.0x narration (${cur.audioDuration.toFixed(2)}s) exceeds original slot (${(
          cur.origEnd - cur.origStart
        ).toFixed(2)}s) in Original Timing mode.`;
        warnings.push(`Segment #${cur.origIndex + 1}: ${conflictReason}`);
      }
    } else if (syncMode === 'continuous') {
      adjustmentType =
        Math.abs(desiredStart - cur.origStart) > 0.03 ? 'shifted' : 'unchanged';
    } else if (neededEnd <= mappedOrigEnd + 0.02) {
      if (Math.abs(desiredStart - mappedOrigStart) > 0.03) {
        adjustmentType = 'shifted';
      }
    } else if (neededEnd <= availableEndBeforeNext + 0.02) {
      adjustmentType = desiredStart > mappedOrigStart + 0.03 ? 'shifted' : 'gap-expanded';
    } else {
      const shortfall = neededEnd - availableEndBeforeNext;
      let absorbableShift = 0;
      if (next) {
        const nextSlot = Math.max(0.2, next.origEnd - next.origStart);
        const afterNextOrigStart =
          i + 2 < ordered.length ? ordered[i + 2].origStart : originalDur;
        const gapAfterNext = Math.max(0, afterNextOrigStart - next.origEnd);
        const nextSlack = Math.max(
          0,
          nextSlot - next.audioDuration + gapAfterNext - MIN_BREATH_GAP_SEC
        );
        const maxSafeShift = Math.min(0.85, nextSlot * 0.35);
        absorbableShift = Math.max(0, Math.min(shortfall, nextSlack, maxSafeShift));
      }

      const remainingShortfall = Math.max(0, shortfall - absorbableShift);

      if (remainingShortfall > 0.02) {
        const holdDur = round2(remainingShortfall + 0.04);
        const holdAt = next
          ? round3(Math.min(originalDur, Math.max(0.04, cur.origEnd)))
          : round3(originalDur);

        rawHolds.push({
          id: `hold_${cur.seg.id}`,
          atVideoTime: holdAt,
          holdDuration: holdDur,
          segmentId: cur.seg.id,
          reason: `Extend shot at ${holdAt.toFixed(2)}s by +${holdDur.toFixed(
            2
          )}s so constant 1.0x narration completes naturally without cutting or overlapping.`,
        });

        cumulativeHold = round3(cumulativeHold + holdDur);
        holdAddedSec = holdDur;
        adjustmentType = 'frame-hold';
      } else {
        adjustmentType = 'shifted';
      }
    }

    const syncedStart = round2(desiredStart);
    const syncedEnd = round2(Math.max(neededEnd, syncedStart + cur.audioDuration));

    // Visual Synchronization Preservation & Reporting:
    // Report clearly when continuous/smart-gap scheduling shifts narration significantly away from the original visual cue
    const timingDeltaSec = syncedStart - cur.origStart;
    const visualMismatch =
      syncMode !== 'original' && Math.abs(timingDeltaSec) > VISUAL_MISMATCH_THRESHOLD_SEC;
    const visualMismatchReason = visualMismatch
      ? `Audio placed at ${syncedStart.toFixed(2)}s vs visual scene cue at ${cur.origStart.toFixed(
          2
        )}s (${timingDeltaSec >= 0 ? '+' : ''}${timingDeltaSec.toFixed(2)}s offset)`
      : undefined;

    segments.push({
      segmentId: cur.seg.id,
      originalStart: round2(cur.origStart),
      originalEnd: round2(cur.origEnd),
      syncedStart,
      syncedEnd,
      audioDuration: round2(cur.audioDuration),
      speechDuration: round2(cur.speechDuration),
      leadingSilence: round2(cur.leadingSilence),
      trailingSilence: round2(cur.trailingSilence),
      adjustmentType,
      holdAddedSec: round2(holdAddedSec),
      conflict,
      conflictReason,
      visualMismatch,
      visualMismatchReason,
    });

    prevSyncedEnd = neededEnd;
  }

  const sortedHolds = [...rawHolds].sort((a, b) => a.atVideoTime - b.atVideoTime);
  const holds: VideoExtensionHold[] = [];
  for (const h of sortedHolds) {
    const prev = holds[holds.length - 1];
    if (prev && Math.abs(prev.atVideoTime - h.atVideoTime) <= 0.05) {
      prev.holdDuration = round2(prev.holdDuration + h.holdDuration);
      prev.reason = `${prev.reason} + ${h.reason}`;
    } else {
      holds.push({ ...h });
    }
  }

  const totalHoldAdded = round2(holds.reduce((sum, h) => sum + h.holdDuration, 0));
  const lastAudioEnd = segments.reduce((m, s) => Math.max(m, s.syncedEnd), 0);
  const totalSpeechDuration = round2(
    segments.reduce((sum, s) => sum + (s.speechDuration ?? s.audioDuration), 0)
  );
  const totalAudioTrackDuration = round2(lastAudioEnd);

  const estimatedFinalDuration =
    syncMode === 'continuous'
      ? totalAudioTrackDuration
      : syncMode === 'flexible'
      ? round2(Math.max(originalDur + totalHoldAdded, lastAudioEnd))
      : round2(originalDur);

  const additionalDuration =
    syncMode === 'flexible'
      ? round2(Math.max(0, estimatedFinalDuration - originalDur))
      : 0;

  const conflictCount = segments.filter((s) => s.conflict).length;
  const visualMismatchCount = segments.filter((s) => s.visualMismatch).length;
  const adjustedCount = segments.filter((s) => s.adjustmentType !== 'unchanged').length;

  if (!narrationAudit.isComplete) {
    warnings.unshift(narrationAudit.summary);
  }
  if (visualMismatchCount > 0) {
    warnings.push(
      `${visualMismatchCount} segment(s) shifted more than ${VISUAL_MISMATCH_THRESHOLD_SEC.toFixed(
        1
      )}s from their original visual scene timestamps due to ${
        syncMode === 'continuous' ? 'Continuous Narration' : 'Smart Gap Removal'
      }. Inspect Audio Diagnostics or switch to Original Scene Timing if exact shot sync is required.`
    );
  }

  const gapDiagnostics: SegmentGapDiagnostic[] = segments.map((seg, idx) => {
    const nextSeg = segments[idx + 1];
    const speechEnd = round2(
      seg.syncedStart + (seg.leadingSilence ?? 0) + (seg.speechDuration ?? seg.audioDuration)
    );
    const gapBeforeNext = nextSeg
      ? round2(Math.max(0, nextSeg.syncedStart - speechEnd))
      : syncMode === 'original'
      ? round2(Math.max(0, originalDur - speechEnd))
      : 0;
    const isUnnecessarilyLongGap = Boolean(nextSeg && gapBeforeNext > 1.2);
    const recommendedAdjustment = isUnnecessarilyLongGap
      ? `Long silent gap (${gapBeforeNext.toFixed(
          2
        )}s) before next segment. Switch to Continuous Narration (${pauseDurationMs}ms pause) or Smart Gap Removal.`
      : seg.visualMismatch
      ? `Placed continuously (${gapBeforeNext.toFixed(2)}s pause) — ${seg.visualMismatchReason}`
      : nextSeg
      ? `Natural pause (${gapBeforeNext.toFixed(2)}s).`
      : 'Final spoken segment complete.';

    return {
      segmentId: seg.segmentId,
      originalStart: seg.originalStart,
      originalEnd: seg.originalEnd,
      audioDuration: seg.audioDuration,
      speechDuration: seg.speechDuration ?? seg.audioDuration,
      leadingSilence: seg.leadingSilence ?? 0,
      trailingSilence: seg.trailingSilence ?? 0,
      finalStart: seg.syncedStart,
      speechEnd,
      gapBeforeNext,
      visualMismatch: seg.visualMismatch,
      visualMismatchReason: seg.visualMismatchReason,
      recommendedAdjustment,
      isUnnecessarilyLongGap,
    };
  });

  return {
    syncMode,
    pauseDurationMs,
    originalVideoDuration: round2(originalDur),
    estimatedFinalDuration,
    totalSpeechDuration,
    totalAudioTrackDuration,
    additionalDuration,
    conflictCount,
    visualMismatchCount,
    adjustedCount,
    holds,
    segments,
    gapDiagnostics,
    narrationAudit,
    warnings,
    computedAt: new Date().toISOString(),
  };
}

export function applySyncPlanToClips(
  clips: GeneratedVoiceClip[],
  plan: TimelineSyncPlan
): GeneratedVoiceClip[] {
  const byId = new Map(plan.segments.map((s) => [s.segmentId, s]));
  return clips.map((clip) => {
    const synced = byId.get(clip.segmentId);
    if (!synced) return clip;
    return {
      ...clip,
      start: synced.syncedStart,
      end: synced.syncedEnd,
      speechDuration: synced.speechDuration ?? clip.speechDuration,
      leadingSilence: synced.leadingSilence ?? clip.leadingSilence,
      trailingSilence: synced.trailingSilence ?? clip.trailingSilence,
      slotDuration: round2(synced.originalEnd - synced.originalStart),
      overflowSeconds: synced.conflict
        ? round2(Math.max(0, synced.audioDuration - (synced.originalEnd - synced.originalStart)))
        : 0,
    };
  });
}

export function remapOriginalTimeToSynced(
  t: number,
  holds: VideoExtensionHold[],
  isEndBoundary = false
): number {
  let offset = 0;
  for (const h of holds) {
    if (isEndBoundary ? t >= h.atVideoTime - 0.005 : t > h.atVideoTime + 0.005) {
      offset += h.holdDuration;
    }
  }
  return round3(t + offset);
}

export function remapBlursForSyncPlan(
  blurs: BlurEffect[],
  holds: VideoExtensionHold[]
): BlurEffect[] {
  if (holds.length === 0) return blurs;
  return blurs.map((b) => ({
    ...b,
    startTime: remapOriginalTimeToSynced(b.startTime, holds, false),
    endTime: remapOriginalTimeToSynced(b.endTime, holds, true),
    keyframes: b.keyframes?.map((kf) => ({
      ...kf,
      time: remapOriginalTimeToSynced(kf.time, holds, false),
    })),
  }));
}

export function remapLogosForSyncPlan(
  logos: LogoOverlay[],
  holds: VideoExtensionHold[]
): LogoOverlay[] {
  if (holds.length === 0) return logos;
  return logos.map((l) => ({
    ...l,
    startTime: remapOriginalTimeToSynced(l.startTime, holds, false),
    endTime: remapOriginalTimeToSynced(l.endTime, holds, true),
  }));
}

export function buildSyncedCaptionsForRender(
  captions: CaptionSegment[],
  plan?: TimelineSyncPlan,
  totalTimingOffsetSec = 0
): CaptionSegment[] {
  const offset = Number(totalTimingOffsetSec || 0);
  const byId = new Map((plan?.segments || []).map((s) => [s.segmentId, s]));

  return captions.map((seg) => {
    const synced = byId.get(seg.id);
    const baseStart = synced
      ? synced.syncedStart
      : plan?.holds?.length
      ? remapOriginalTimeToSynced(seg.start, plan.holds, false)
      : seg.start;
    const baseEnd = synced
      ? synced.syncedEnd
      : plan?.holds?.length
      ? remapOriginalTimeToSynced(seg.end, plan.holds, true)
      : seg.end;

    const start = Math.max(0, round3(baseStart + offset));
    const end = Math.max(start + 0.18, round3(baseEnd + offset));
    const leadSil = Math.max(0, synced?.leadingSilence ?? 0);
    const trailSil = Math.max(0, synced?.trailingSilence ?? 0);
    const speechStart = Math.min(end - 0.12, start + leadSil);
    const speechEnd = Math.max(speechStart + 0.12, end - trailSil);

    // STRICT: Compute words solely from translatedText (never seg.text)
    const translated = (seg.translatedText || '').trim();
    const tokens = translated.split(/\s+/).filter(Boolean);
    const existingJoined = (seg.words || []).map((w) => w.word).join(' ').trim();
    const hasActualWords =
      seg.wordsSource === 'actual' &&
      Boolean(seg.words?.length && translated && existingJoined === translated.replace(/\s+/g, ' '));

    let words = seg.words;
    if (tokens.length > 0) {
      if (hasActualWords && seg.words) {
        words = seg.words.map((w) => ({
          word: w.word,
          start: Math.max(0, round3(w.start + offset)),
          end: Math.max(0.05, round3(w.end + offset)),
        }));
      } else {
        const weights = tokens.map((t) =>
          Math.max(2, t.replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, '').length)
        );
        const weightSum = weights.reduce((a, b) => a + b, 0) || tokens.length;
        const dur = Math.max(0.12, speechEnd - speechStart);
        let cursor = speechStart;
        words = tokens.map((word, idx) => {
          const share = (weights[idx] / weightSum) * dur;
          const wStart = cursor;
          const wEnd = idx === tokens.length - 1 ? speechEnd : wStart + share;
          cursor = wEnd;
          return {
            word,
            start: round3(wStart),
            end: round3(Math.max(wStart + 0.05, wEnd)),
          };
        });
      }
    } else {
      words = [];
    }

    return {
      ...seg,
      start,
      end,
      words,
    };
  });
}

/**
 * Splits a video stream at each hold point and clones the last frame for `holdDuration` seconds
 * using FFmpeg `tpad=stop_mode=clone`, preserving 1.0x motion during all non-held shots.
 */
export function buildVideoFrameHoldFilter(params: {
  inputLabel: string;
  outputLabel: string;
  originalDuration: number;
  holds: VideoExtensionHold[];
}): string[] {
  const { inputLabel, outputLabel, originalDuration, holds } = params;
  if (holds.length === 0) {
    return [`[${inputLabel}]null[${outputLabel}]`];
  }

  // Filter valid cut points inside (0.04 .. originalDuration]
  const cleanHolds = holds
    .filter((h) => h.holdDuration > 0.02)
    .map((h) => ({
      at: Math.max(0.04, Math.min(originalDuration, h.atVideoTime)),
      dur: h.holdDuration,
    }))
    .sort((a, b) => a.at - b.at);

  if (cleanHolds.length === 0) {
    return [`[${inputLabel}]null[${outputLabel}]`];
  }

  // Single hold right at the end of video needs no split/concat
  if (cleanHolds.length === 1 && cleanHolds[0].at >= originalDuration - 0.06) {
    return [
      `[${inputLabel}]tpad=stop_mode=clone:stop_duration=${cleanHolds[0].dur.toFixed(3)}[${outputLabel}]`,
    ];
  }

  const slices: Array<{ start: number; end: number | null; padAfter: number }> = [];
  let prev = 0;

  for (const h of cleanHolds) {
    if (h.at - prev >= 0.04) {
      const isAtEnd = h.at >= originalDuration - 0.06;
      slices.push({
        start: prev,
        end: isAtEnd ? null : h.at,
        padAfter: h.dur,
      });
      prev = h.at;
    } else if (slices.length > 0) {
      slices[slices.length - 1].padAfter += h.dur;
    }
  }

  if (originalDuration - prev > 0.06) {
    slices.push({
      start: prev,
      end: null,
      padAfter: 0,
    });
  }

  if (slices.length === 1) {
    const s = slices[0];
    return [
      s.padAfter > 0
        ? `[${inputLabel}]tpad=stop_mode=clone:stop_duration=${s.padAfter.toFixed(3)}[${outputLabel}]`
        : `[${inputLabel}]null[${outputLabel}]`,
    ];
  }

  const steps: string[] = [];
  const splitLabels = slices.map((_, idx) => `v_hsplit_${idx}`);
  steps.push(
    `[${inputLabel}]split=${slices.length}${splitLabels.map((l) => `[${l}]`).join('')}`
  );

  const sliceOutLabels: string[] = [];
  slices.forEach((s, idx) => {
    const out = `v_hslice_${idx}`;
    const trimExpr =
      s.end !== null
        ? `trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)}`
        : `trim=start=${s.start.toFixed(3)}`;
    const padExpr =
      s.padAfter > 0 ? `,tpad=stop_mode=clone:stop_duration=${s.padAfter.toFixed(3)}` : '';
    steps.push(`[${splitLabels[idx]}]${trimExpr},setpts=PTS-STARTPTS${padExpr}[${out}]`);
    sliceOutLabels.push(`[${out}]`);
  });

  steps.push(`${sliceOutLabels.join('')}concat=n=${slices.length}:v=1:a=0[${outputLabel}]`);
  return steps;
}

/**
 * Applies matching silence holds to the original audio stream `[0:a]` so original dialogue
 * and SFX after each freeze frame remain 100% synchronized with the video visuals.
 */
export function buildAudioHoldFilter(params: {
  sourceAudioChainPrefix: string;
  outputLabel: string;
  originalDuration: number;
  holds: VideoExtensionHold[];
}): string[] {
  const { sourceAudioChainPrefix, outputLabel, originalDuration, holds } = params;
  const cleanHolds = holds
    .filter((h) => h.holdDuration > 0.02)
    .map((h) => ({
      at: Math.max(0.04, Math.min(originalDuration, h.atVideoTime)),
      dur: h.holdDuration,
    }))
    .sort((a, b) => a.at - b.at);

  if (cleanHolds.length === 0) {
    return [`${sourceAudioChainPrefix}[${outputLabel}]`];
  }

  if (cleanHolds.length === 1 && cleanHolds[0].at >= originalDuration - 0.06) {
    return [
      `${sourceAudioChainPrefix},aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,apad=pad_dur=${cleanHolds[0].dur.toFixed(3)}[${outputLabel}]`,
    ];
  }

  const slices: Array<{ start: number; end: number | null; padAfter: number }> = [];
  let prev = 0;

  for (const h of cleanHolds) {
    if (h.at - prev >= 0.04) {
      const isAtEnd = h.at >= originalDuration - 0.06;
      slices.push({
        start: prev,
        end: isAtEnd ? null : h.at,
        padAfter: h.dur,
      });
      prev = h.at;
    } else if (slices.length > 0) {
      slices[slices.length - 1].padAfter += h.dur;
    }
  }

  if (originalDuration - prev > 0.06) {
    slices.push({
      start: prev,
      end: null,
      padAfter: 0,
    });
  }

  if (slices.length === 1) {
    const s = slices[0];
    return [
      `${sourceAudioChainPrefix},aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo${
        s.padAfter > 0 ? `,apad=pad_dur=${s.padAfter.toFixed(3)}` : ''
      }[${outputLabel}]`,
    ];
  }

  const steps: string[] = [];
  steps.push(
    `${sourceAudioChainPrefix},aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a_hold_base]`
  );
  const splitLabels = slices.map((_, idx) => `a_hsplit_${idx}`);
  steps.push(`[a_hold_base]asplit=${slices.length}${splitLabels.map((l) => `[${l}]`).join('')}`);

  const sliceOutLabels: string[] = [];
  slices.forEach((s, idx) => {
    const out = `a_hslice_${idx}`;
    const trimExpr =
      s.end !== null
        ? `atrim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)}`
        : `atrim=start=${s.start.toFixed(3)}`;
    const padExpr = s.padAfter > 0 ? `,apad=pad_dur=${s.padAfter.toFixed(3)}` : '';
    steps.push(`[${splitLabels[idx]}]${trimExpr},asetpts=PTS-STARTPTS${padExpr}[${out}]`);
    sliceOutLabels.push(`[${out}]`);
  });

  steps.push(`${sliceOutLabels.join('')}concat=n=${slices.length}:v=0:a=1[${outputLabel}]`);
  return steps;
}
