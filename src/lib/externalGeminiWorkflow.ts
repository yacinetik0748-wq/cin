import { v4 as uuidv4 } from 'uuid';
import {
  CaptionSegment,
  GeneratedVoiceClip,
  NarrationValidationConfig,
  Project,
  SegmentNarrationStatus,
  SupportedLanguage,
  WordTiming,
} from '../types/studio';

export const MANDATORY_COMPLETENESS_INSTRUCTION =
  'Do not summarize the original narration. Do not remove important details. Your task is to produce a complete and faithful spoken translation, not the shortest possible translation. If the current translation is too short, restore missing information from the original text. If it is too long, make only the minimum necessary reductions while preserving all essential information.';

export type CorrectionDirection = 'NONE' | 'SHORTEN' | 'EXPAND' | 'REVIEW';

export interface ExternalGeminiValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  parsedMetadata?: {
    sourceLanguage?: string;
    targetLanguage?: string;
    characters: string[];
    locations: string[];
  };
  normalizedSegments?: CaptionSegment[];
  formattedJson?: string;
}

function distributeWordsEvenlyClient(text: string, start: number, end: number): WordTiming[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const step = Math.max(0.05, (end - start) / tokens.length);
  return tokens.map((word, idx) => ({
    word,
    start: Math.round((start + idx * step) * 100) / 100,
    end: Math.round((start + (idx + 1) * step) * 100) / 100,
  }));
}

export function extractJsonFromGeminiText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    return fenceMatch[1].trim();
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1).trim();
  }

  return trimmed;
}

export function buildExternalGeminiPrompt(params: {
  project: Project;
  sourceLanguage: string;
  targetLanguage: SupportedLanguage;
  preserveProperNouns: boolean;
}): string {
  const { project, sourceLanguage, targetLanguage, preserveProperNouns } = params;
  const duration = project.metadata?.duration || 0;
  const videoName = project.sourceFilename || project.name;
  const resolution = project.metadata
    ? `${project.metadata.width}x${project.metadata.height} (${project.metadata.fps} fps)`
    : 'Original resolution';
  const existingSegments = project.captions || [];

  const hasExisting = existingSegments.length > 0;
  const existingTemplate = hasExisting
    ? JSON.stringify(
        existingSegments.map((s) => ({
          id: s.id,
          start: s.start,
          end: s.end,
          speaker: s.speaker || 'Narrator',
          originalText: s.text,
        })),
        null,
        2
      )
    : null;

  return [
    `You are a professional film localization translator, cinematic recap scriptwriter, and professional voice-over script editor.`,
    `I have attached the original video "${videoName}" (Duration: ${duration > 0 ? `${duration.toFixed(2)}s` : 'check attached video'}, Format: ${resolution}).`,
    ``,
    `TASK:`,
    `1. Watch and listen carefully to the entire attached video from beginning to end (0.00s to end).`,
    `2. Transcribe all audible narration and dialogue accurately in strict chronological order.`,
    `3. Identify every speaker/character and key story locations shown or mentioned in the video.`,
    `4. Translate and adapt the narration from ${sourceLanguage === 'Auto' ? 'the detected spoken language' : sourceLanguage} into natural, engaging ${targetLanguage} suitable for professional voice-over dubbing.`,
    ``,
    `PROFESSIONAL CINEMATIC LOCALIZATION & COMPLETENESS RULES:`,
    `- Story Completeness & Fidelity (CRITICAL): Preserve ALL important information, story events, character actions, explanations, transitions, cause-and-effect, and storytelling detail from the original narration. NEVER turn a complete narration into a short summary or strip essential details just to reduce word count.`,
    `- Proper Nouns & Locations: ${
      preserveProperNouns
        ? `Keep character names, actor names, movie titles, organization names, and key location names intact (only transliterate script where required for ${targetLanguage}, keeping pronunciation recognizable).`
        : `Preserve key character names and major locations accurately in ${targetLanguage}.`
    }`,
    `- Timeline Synchronization: The original video duration is ${duration > 0 ? `${duration.toFixed(2)}s` : '112 seconds'}. Analyze each segment's duration (end - start) before translating so the complete, natural spoken ${targetLanguage} narration fits the available window comfortably at 1.0x fixed speaking speed without becoming overly verbose or overly brief.`,
    `- Natural Spoken Style: Maintain the original storytelling tone and level of detail. Prefer natural spoken phrasing over literal word-for-word awkwardness, while keeping every key fact and story beat intact.`,
    `- Multi-Part Handling: If the video is long and your response exceeds token length limits, divide your output into numbered parts (e.g. Part 1 of N, Part 2 of N) with consistent IDs and include a clear final completion marker [COMPLETED].`,
    hasExisting
      ? [
          ``,
          `EXISTING TIMESTAMPS & SEGMENT IDs (MUST PRESERVE EXACTLY):`,
          `- You MUST return one output segment for EVERY existing segment below.`,
          `- Preserve each segment's exact "id", "start", and "end" numbers.`,
          `- Refine "originalText" and "speaker" if needed from the video audio, and provide "translatedText" in ${targetLanguage}.`,
          existingTemplate!,
        ].join('\n')
      : [
          ``,
          `TIMESTAMP & SEGMENTATION RULES:`,
          `- Divide the narration into clean, natural sentence-level segments covering the full spoken audio.`,
          `- Every segment MUST have numeric "start" and "end" timestamps in seconds (0 <= start < end${duration > 0 ? ` <= ${duration.toFixed(2)}` : ''}) in strictly non-decreasing chronological order.`,
          `- Assign a unique string "id" (e.g. "seg-1", "seg-2", ...) and "speaker" (e.g. "Narrator") to each segment.`,
        ].join('\n'),
    ``,
    `OUTPUT FORMAT (STRICT RAW JSON ONLY — NO MARKDOWN EXPLANATION OUTSIDE JSON):`,
    `{`,
    `  "sourceLanguage": "Detected language name",`,
    `  "targetLanguage": "${targetLanguage}",`,
    `  "characters": ["Character 1", "Character 2"],`,
    `  "locations": ["Location 1"],`,
    `  "segments": [`,
    `    {`,
    `      "id": "${hasExisting ? existingSegments[0].id : 'seg-1'}",`,
    `      "start": 0.0,`,
    `      "end": 3.5,`,
    `      "speaker": "Narrator",`,
    `      "originalText": "Verbatim transcribed narration in source language",`,
    `      "translatedText": "Complete, natural cinematic ${targetLanguage} dubbing line"`,
    `    }`,
    `  ]`,
    `}`,
  ].join('\n');
}

export function validateExternalGeminiJson(params: {
  rawAnswer: string;
  existingCaptions: CaptionSegment[];
  videoDuration: number;
  expectedTargetLanguage: SupportedLanguage;
}): ExternalGeminiValidationResult {
  const { rawAnswer, existingCaptions, videoDuration, expectedTargetLanguage } = params;
  const errors: string[] = [];
  const warnings: string[] = [];

  const cleaned = rawAnswer.trim();
  if (!cleaned) {
    return {
      valid: false,
      errors: ['Gemini JSON Answer field is empty. Paste Gemini’s JSON response first.'],
      warnings: [],
    };
  }

  // Support multi-part JSON responses by extracting and combining segments from all JSON blocks / arrays found
  const rawSegments: unknown[] = [];
  const characters: string[] = [];
  const locations: string[] = [];
  let detectedSource: string | undefined;
  let detectedTarget: string | undefined;

  try {
    const single = JSON.parse(extractJsonFromGeminiText(cleaned));
    if (single && typeof single === 'object') {
      if (Array.isArray(single.segments)) rawSegments.push(...single.segments);
      else if (Array.isArray(single)) rawSegments.push(...single);
      if (typeof single.sourceLanguage === 'string') detectedSource = single.sourceLanguage;
      if (typeof single.targetLanguage === 'string') detectedTarget = single.targetLanguage;
      if (Array.isArray(single.characters)) characters.push(...single.characters.map(String));
      if (Array.isArray(single.locations)) locations.push(...single.locations.map(String));
    }
  } catch {
    // Multi-block search for parts 1, 2, 3...
    const jsonBlockRegex = /({[\s\S]*?}|\[[\s\S]*?\])/g;
    let match;
    let foundAny = false;
    while ((match = jsonBlockRegex.exec(cleaned)) !== null) {
      try {
        const obj = JSON.parse(match[1]);
        foundAny = true;
        if (Array.isArray(obj)) {
          rawSegments.push(...obj);
        } else if (obj && typeof obj === 'object') {
          if (Array.isArray(obj.segments)) rawSegments.push(...obj.segments);
          else if (obj.id && (obj.translatedText || obj.text)) rawSegments.push(obj);
          if (typeof obj.sourceLanguage === 'string') detectedSource = obj.sourceLanguage;
          if (typeof obj.targetLanguage === 'string') detectedTarget = obj.targetLanguage;
          if (Array.isArray(obj.characters)) characters.push(...obj.characters.map(String));
          if (Array.isArray(obj.locations)) locations.push(...obj.locations.map(String));
        }
      } catch {
        // skip
      }
    }
    if (!foundAny) {
      return {
        valid: false,
        errors: [
          `Invalid JSON syntax: Unable to parse JSON response. Use "Fix JSON Syntax" to ask Gemini to repair the JSON formatting.`,
        ],
        warnings: [],
      };
    }
  }

  if (rawSegments.length === 0) {
    return {
      valid: false,
      errors: ['JSON must include a non-empty "segments" array or list of segment objects.'],
      warnings: [],
    };
  }

  const existingById = new Map(existingCaptions.map((c) => [c.id, c]));
  const seenIds = new Set<string>();
  const normalizedSegments: CaptionSegment[] = [];
  let prevStart = -1;

  rawSegments.forEach((item, idx) => {
    const label = `Segment #${idx + 1}`;
    if (!item || typeof item !== 'object') {
      errors.push(`${label} must be a JSON object.`);
      return;
    }

    const seg = item as Record<string, unknown>;
    const rawId = typeof seg.id === 'string' && seg.id.trim() ? seg.id.trim() : uuidv4();
    if (seenIds.has(rawId)) {
      errors.push(`${label} has duplicate segment id "${rawId}".`);
    }
    seenIds.add(rawId);

    const startNum = Number(seg.start);
    const endNum = Number(seg.end);
    if (!Number.isFinite(startNum) || startNum < 0) {
      errors.push(`${label} ("${rawId}") has an invalid start timestamp (${String(seg.start)}).`);
    }
    if (!Number.isFinite(endNum) || endNum <= startNum) {
      errors.push(`${label} ("${rawId}") must have end > start (${startNum} -> ${endNum}).`);
    }
    if (Number.isFinite(startNum) && startNum < prevStart - 0.05) {
      errors.push(`${label} ("${rawId}") is out of chronological order (${startNum}s < previous ${prevStart}s).`);
    }
    if (videoDuration > 0 && Number.isFinite(endNum) && endNum > videoDuration + 1.5) {
      warnings.push(
        `${label} end time (${endNum.toFixed(2)}s) exceeds video duration (${videoDuration.toFixed(2)}s) and will be clamped.`
      );
    }

    const originalText = String(
      seg.originalText ?? seg.text ?? existingById.get(rawId)?.text ?? ''
    ).trim();
    const translatedText = String(seg.translatedText ?? '').trim();
    const speaker =
      typeof seg.speaker === 'string' && seg.speaker.trim()
        ? seg.speaker.trim()
        : existingById.get(rawId)?.speaker;

    if (!originalText) {
      warnings.push(`${label} ("${rawId}") has an empty originalText.`);
    }
    if (!translatedText) {
      errors.push(`${label} ("${rawId}") is missing "translatedText".`);
    }

    const safeStart = Math.max(
      0,
      videoDuration > 0
        ? Math.min(videoDuration, Number.isFinite(startNum) ? startNum : 0)
        : Number.isFinite(startNum)
        ? startNum
        : 0
    );
    const safeEnd = Math.max(
      safeStart + 0.2,
      videoDuration > 0
        ? Math.min(videoDuration, Number.isFinite(endNum) ? endNum : safeStart + 2)
        : Number.isFinite(endNum)
        ? endNum
        : safeStart + 2
    );

    const estSpokenDuration = translatedText.split(/\s+/).filter(Boolean).length / 2.6;
    const slotDuration = safeEnd - safeStart;
    if (estSpokenDuration > slotDuration * 1.4) {
      warnings.push(
        `${label} ("${rawId}") preliminary estimate (~${estSpokenDuration.toFixed(1)}s at 1.0x) is longer than allocated window (${slotDuration.toFixed(1)}s). Run VALIDATE NARRATION or Fish Audio to confirm.`
      );
    }

    prevStart = Math.max(prevStart, safeStart);

    normalizedSegments.push({
      id: rawId,
      start: Math.round(safeStart * 100) / 100,
      end: Math.round(safeEnd * 100) / 100,
      text: originalText || translatedText,
      translatedText,
      speaker,
      words: distributeWordsEvenlyClient(translatedText || originalText, safeStart, safeEnd),
    });
  });

  const totalEstDuration = normalizedSegments.reduce(
    (sum, s) => sum + (s.translatedText || s.text).split(/\s+/).filter(Boolean).length / 2.6,
    0
  );
  if (videoDuration > 0 && totalEstDuration > videoDuration * 1.2) {
    warnings.push(
      `TIMELINE NOTICE: Total preliminary translation estimate (~${totalEstDuration.toFixed(0)}s) exceeds original video duration (${videoDuration.toFixed(0)}s). Click VALIDATE NARRATION to adjust only over-long segments without losing story details.`
    );
  }

  if (existingCaptions.length > 0) {
    const missingIds = existingCaptions
      .filter((c) => !seenIds.has(c.id))
      .map((c) => c.id);
    if (missingIds.length > 0) {
      warnings.push(
        `${missingIds.length} existing project segment ID(s) were not matched (${missingIds.slice(0, 3).join(', ')}${missingIds.length > 3 ? '...' : ''}). Applying will replace those segment IDs.`
      );
    }
  }

  const parsedTarget = detectedTarget ? detectedTarget.trim() : '';
  if (
    parsedTarget &&
    parsedTarget.toLowerCase() !== expectedTargetLanguage.toLowerCase()
  ) {
    warnings.push(
      `JSON targetLanguage is "${parsedTarget}", while selected target language is "${expectedTargetLanguage}".`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    parsedMetadata: {
      sourceLanguage: detectedSource,
      targetLanguage: parsedTarget || expectedTargetLanguage,
      characters: Array.from(new Set(characters)),
      locations: Array.from(new Set(locations)),
    },
    normalizedSegments: errors.length === 0 ? normalizedSegments : undefined,
    formattedJson: JSON.stringify(
      {
        sourceLanguage: detectedSource || 'Auto',
        targetLanguage: expectedTargetLanguage,
        characters: Array.from(new Set(characters)),
        locations: Array.from(new Set(locations)),
        segments: rawSegments,
      },
      null,
      2
    ),
  };
}

export function buildCorrectionPrompt(params: {
  rawAnswer: string;
  errors: string[];
  warnings: string[];
  targetLanguage: SupportedLanguage;
  existingCaptions: CaptionSegment[];
  videoDuration: number;
}): string {
  const { rawAnswer, errors, warnings, targetLanguage, existingCaptions, videoDuration } = params;
  const issues = [...errors, ...warnings];

  return [
    `Your previous JSON response for the video translation has formatting or validation issues that must be corrected.`,
    ``,
    `MANDATORY COMPLETENESS RULE:`,
    MANDATORY_COMPLETENESS_INSTRUCTION,
    ``,
    `DETECTED ISSUES TO FIX:`,
    ...(issues.length > 0
      ? issues.map((issue, i) => `${i + 1}. ${issue}`)
      : ['1. Ensure the output is strictly valid JSON matching the required schema.']),
    ``,
    `REQUIREMENTS:`,
    `- Return ONLY raw valid JSON (no markdown commentary outside the JSON object).`,
    `- Target language MUST be ${targetLanguage}.`,
    `- Every segment in "segments" MUST contain: "id" (string), "start" (number in seconds), "end" (number > start${videoDuration > 0 ? ` and <= ${videoDuration.toFixed(2)}` : ''}), "speaker" (string), "originalText" (string), and "translatedText" (complete, natural spoken translation in ${targetLanguage}).`,
    `- Segments MUST be in strictly chronological order.`,
    ...(existingCaptions.length > 0
      ? [
          `- Preserve these exact existing segment IDs and timestamps: ${existingCaptions
            .map((c) => `${c.id} (${c.start}s-${c.end}s)`)
            .join(', ')}`,
        ]
      : []),
    ``,
    `PREVIOUS RESPONSE TO REPAIR:`,
    `"""`,
    rawAnswer.trim() || '(empty)',
    `"""`,
    ``,
    `Output the corrected complete JSON object now.`,
  ].join('\n');
}

export function buildConciseShorteningPrompt(params: {
  videoDuration: number;
  targetLanguage: SupportedLanguage;
  existingCaptions: CaptionSegment[];
  generatedClips?: GeneratedVoiceClip[];
}): string {
  const { videoDuration, targetLanguage, existingCaptions, generatedClips = [] } = params;
  const clipsBySeg = new Map(generatedClips.map((c) => [c.segmentId, c]));

  return [
    `NARRATION TIMELINE ALIGNMENT & STORY COMPLETENESS REQUEST (TARGET LANGUAGE: ${targetLanguage}):`,
    `The original video duration is ${videoDuration > 0 ? `${videoDuration.toFixed(1)} seconds` : '112 seconds'}. Align the narration segments so they match the original video timeline naturally at 1.0x fixed speech speed WITHOUT over-shortening or losing story details.`,
    ``,
    `MANDATORY CONTENT COMPLETENESS RULE:`,
    MANDATORY_COMPLETENESS_INSTRUCTION,
    ``,
    `BALANCED ALIGNMENT RULES:`,
    `1. Compare "originalText" with "currentTranslation" for EVERY segment before changing anything.`,
    `2. If a segment is already well-paced and complete for its allocated duration, keep it faithful and natural.`,
    `3. If a segment is TOO SHORT or summarized away important facts, EXPAND it by restoring missing actions, explanations, and transitions already present in "originalText" (do NOT invent unrelated facts).`,
    `4. If a segment exceeds its allocated duration (or measured Fish Audio duration), make ONLY the minimum necessary reductions while preserving all essential story details, character names, and natural cinematic tone.`,
    `5. Return ONLY raw valid JSON matching the partial patch schema ({ "segments": [{ "id": "...", "translatedText": "..." }] }) with exact segment IDs preserved.`,
    ``,
    `SEGMENTS TO INSPECT & BALANCE:`,
    JSON.stringify(
      existingCaptions.map((c) => {
        const clip = clipsBySeg.get(c.id);
        return {
          id: c.id,
          start: c.start,
          end: c.end,
          allocatedDuration: Number(Math.max(0.2, c.end - c.start).toFixed(2)),
          actualFishAudioDuration: clip ? Number(clip.duration.toFixed(2)) : null,
          actualSpeechDuration: clip?.speechDuration !== undefined ? Number(clip.speechDuration.toFixed(2)) : null,
          targetLanguage,
          originalText: c.text,
          currentTranslation: c.translatedText || '',
        };
      }),
      null,
      2
    ),
    ``,
    `Output the balanced JSON segments now.`,
  ].join('\n');
}

export const DEFAULT_NARRATION_VALIDATION_CONFIG: NarrationValidationConfig = {
  minWordsPerSec: 2.0,
  maxWordsPerSec: 2.8,
  audioOverflowToleranceSec: 0.15,
};

export interface SegmentNarrationCheck {
  segmentId: string;
  index: number;
  start: number;
  end: number;
  allocatedDuration: number;
  speaker?: string;
  originalText: string;
  translatedText: string;
  originalWordCount: number;
  wordCount: number;
  completenessRatio: number | null;
  estimatedDuration: number;
  minRecommendedWords: number;
  maxRecommendedWords: number;
  targetWords: number;
  actualAudioDuration: number | null;
  actualSpeechDuration: number | null;
  audioOverflowSec: number | null;
  status: SegmentNarrationStatus;
  correctionDirection: CorrectionDirection;
  reason: string;
}

export interface NarrationValidationReport {
  config: NarrationValidationConfig;
  totalSegments: number;
  passingCount: number;
  problemCount: number;
  tooLongCount: number;
  tooShortCount: number;
  needsReviewCount: number;
  audioOverflowCount: number;
  hasMeasuredAudio: boolean;
  summaryText: string;
  checks: SegmentNarrationCheck[];
  problemChecks: SegmentNarrationCheck[];
}

export function countNarrationWords(text: string): number {
  const cleaned = text.trim();
  if (!cleaned) return 0;
  return cleaned.split(/\s+/).filter(Boolean).length;
}

export function validateNarrationSegments(params: {
  segments: CaptionSegment[];
  generatedClips?: GeneratedVoiceClip[];
  config?: Partial<NarrationValidationConfig>;
}): NarrationValidationReport {
  const config: NarrationValidationConfig = {
    minWordsPerSec: Math.max(
      0.5,
      params.config?.minWordsPerSec ?? DEFAULT_NARRATION_VALIDATION_CONFIG.minWordsPerSec
    ),
    maxWordsPerSec: Math.max(
      (params.config?.minWordsPerSec ?? DEFAULT_NARRATION_VALIDATION_CONFIG.minWordsPerSec) + 0.2,
      params.config?.maxWordsPerSec ?? DEFAULT_NARRATION_VALIDATION_CONFIG.maxWordsPerSec
    ),
    audioOverflowToleranceSec: Math.max(
      0,
      params.config?.audioOverflowToleranceSec ??
        DEFAULT_NARRATION_VALIDATION_CONFIG.audioOverflowToleranceSec
    ),
  };

  const clipsBySegment = new Map((params.generatedClips || []).map((c) => [c.segmentId, c]));
  const midWordsPerSec = (config.minWordsPerSec + config.maxWordsPerSec) / 2;
  let hasMeasuredAudio = false;
  let audioOverflowCount = 0;

  const checks: SegmentNarrationCheck[] = params.segments.map((seg, index) => {
    const start = Number(seg.start);
    const end = Number(seg.end);
    const validTimestamps = Number.isFinite(start) && Number.isFinite(end) && end > start;
    const allocatedDuration = validTimestamps
      ? Math.max(0.2, Math.round((end - start) * 100) / 100)
      : 0;
    const translatedText = (seg.translatedText || '').trim();
    const originalText = (seg.text || '').trim();
    const originalWordCount = countNarrationWords(originalText);
    const wordCount = countNarrationWords(translatedText);
    const completenessRatio =
      originalWordCount >= 4 ? Math.round((wordCount / originalWordCount) * 100) / 100 : null;
    const estimatedDuration = Math.round((wordCount / midWordsPerSec) * 100) / 100;

    const minRecommendedWords = validTimestamps
      ? Math.max(1, Math.floor(allocatedDuration * config.minWordsPerSec))
      : 1;
    const maxRecommendedWords = validTimestamps
      ? Math.max(minRecommendedWords + 1, Math.ceil(allocatedDuration * config.maxWordsPerSec))
      : 1;
    const targetWords = Math.max(
      minRecommendedWords,
      Math.round((minRecommendedWords + maxRecommendedWords) / 2)
    );

    const clip = clipsBySegment.get(seg.id);
    const actualAudioDuration =
      clip && Number.isFinite(clip.duration) ? Math.round(clip.duration * 100) / 100 : null;
    const actualSpeechDuration =
      clip && Number.isFinite(clip.speechDuration ?? clip.duration)
        ? Math.round((clip.speechDuration ?? clip.duration) * 100) / 100
        : null;

    if (actualAudioDuration !== null) {
      hasMeasuredAudio = true;
    }

    const audioOverflowSec =
      actualAudioDuration !== null && validTimestamps
        ? Math.round((actualAudioDuration - allocatedDuration) * 100) / 100
        : null;

    // Detect if translation looks overly summarized relative to originalText
    const isSeverelyCondensedVsOriginal =
      originalWordCount >= 6 &&
      completenessRatio !== null &&
      completenessRatio < 0.48 &&
      wordCount < minRecommendedWords + 1;

    let status: SegmentNarrationStatus = 'PASS';
    let correctionDirection: CorrectionDirection = 'NONE';
    let reason =
      actualAudioDuration !== null
        ? `Real Fish Audio (${actualAudioDuration.toFixed(2)}s, speech ${(actualSpeechDuration ?? actualAudioDuration).toFixed(2)}s) fits within ${allocatedDuration.toFixed(2)}s with complete story coverage (${wordCount}w vs ${originalWordCount}w original).`
        : `Preliminary estimate (${wordCount}w) is within ${minRecommendedWords}–${maxRecommendedWords}w for ${allocatedDuration.toFixed(2)}s. Generate Fish Audio to confirm actual FFprobe spoken duration.`;

    if (!validTimestamps) {
      status = 'NEEDS REVIEW';
      correctionDirection = 'REVIEW';
      reason = `Invalid segment timestamps (start: ${seg.start}, end: ${seg.end}).`;
    } else if (!translatedText || wordCount === 0) {
      status = 'NEEDS REVIEW';
      correctionDirection = 'REVIEW';
      reason = `Translated narration is empty for a ${allocatedDuration.toFixed(2)}s segment. Translate originalText completely and naturally.`;
    } else if (actualAudioDuration !== null) {
      // REAL AUDIO DURATION PRIORITY: evaluate using actual FFprobe audio/speech + completeness, NOT word count alone
      const speechDur = actualSpeechDuration ?? actualAudioDuration;
      const fillRatio = allocatedDuration > 0 ? speechDur / allocatedDuration : 1;

      if (audioOverflowSec !== null && audioOverflowSec > config.audioOverflowToleranceSec) {
        status = 'TOO LONG';
        correctionDirection = 'SHORTEN';
        audioOverflowCount += 1;
        reason = `Actual Fish Audio duration (${actualAudioDuration.toFixed(2)}s, speech ${speechDur.toFixed(2)}s) exceeds allocated duration (${allocatedDuration.toFixed(2)}s) by +${audioOverflowSec.toFixed(2)}s at 1.0x speed. Make only the minimum necessary reductions while preserving all essential story information.`;
      } else if (
        (allocatedDuration >= 2.2 && fillRatio < 0.52) ||
        (isSeverelyCondensedVsOriginal && actualAudioDuration <= allocatedDuration * 0.85)
      ) {
        status = 'TOO SHORT';
        correctionDirection = 'EXPAND';
        reason =
          isSeverelyCondensedVsOriginal
            ? `Current translation (${wordCount}w vs ${originalWordCount}w in originalText; actual speech ${speechDur.toFixed(2)}s / ${allocatedDuration.toFixed(2)}s) appears over-shortened and may be missing story details. Expand using information already in originalText.`
            : `Actual speech duration (${speechDur.toFixed(2)}s) fills only ${Math.round(fillRatio * 100)}% of the ${allocatedDuration.toFixed(2)}s window, leaving long silence. Expand naturally using details already present in originalText.`;
      } else if (
        wordCount > maxRecommendedWords &&
        actualAudioDuration > allocatedDuration - 0.1
      ) {
        status = 'NEEDS REVIEW';
        correctionDirection = 'REVIEW';
        reason = `Measured audio (${actualAudioDuration.toFixed(2)}s) is near the ${allocatedDuration.toFixed(2)}s boundary with ${wordCount} words. Review pacing and completeness carefully without automatically shortening.`;
      } else if (
        originalWordCount >= 6 &&
        completenessRatio !== null &&
        completenessRatio < 0.42
      ) {
        status = 'NEEDS REVIEW';
        correctionDirection = 'REVIEW';
        reason = `Translation is very short (${wordCount}w vs ${originalWordCount}w original) even though audio (${actualAudioDuration.toFixed(2)}s) fits ${allocatedDuration.toFixed(2)}s. Verify no important story details were omitted.`;
      }
    } else {
      // PRELIMINARY SCREENING (no Fish Audio clips yet)
      if (wordCount > maxRecommendedWords) {
        status = 'TOO LONG';
        correctionDirection = 'SHORTEN';
        reason = `Preliminary estimate: ${wordCount} words (~${estimatedDuration.toFixed(2)}s at 1.0x) exceeds preliminary ${minRecommendedWords}–${maxRecommendedWords}w guideline for ${allocatedDuration.toFixed(2)}s. Trim only minimum unnecessary words while preserving all story details.`;
      } else if (
        (allocatedDuration >= 1.8 && wordCount < minRecommendedWords) ||
        isSeverelyCondensedVsOriginal
      ) {
        status = 'TOO SHORT';
        correctionDirection = 'EXPAND';
        reason = isSeverelyCondensedVsOriginal
          ? `Translation (${wordCount}w vs ${originalWordCount}w in originalText) is much shorter than the original narration for a ${allocatedDuration.toFixed(2)}s slot. Restore missing details from originalText without inventing facts.`
          : `Preliminary estimate: ${wordCount} words is below ${minRecommendedWords}–${maxRecommendedWords}w for ${allocatedDuration.toFixed(2)}s and may omit story details or leave awkward silence. Expand using facts already in originalText.`;
      } else if (
        wordCount > 0 &&
        translatedText.replace(/\s+/g, '').length / wordCount > 10.5 &&
        wordCount >= maxRecommendedWords
      ) {
        status = 'NEEDS REVIEW';
        correctionDirection = 'REVIEW';
        reason = `Long average word length (${(translatedText.replace(/\s+/g, '').length / wordCount).toFixed(1)} chars/word) near upper limit for ${allocatedDuration.toFixed(2)}s. Review natural pacing without automatically shortening.`;
      }
    }

    return {
      segmentId: seg.id,
      index,
      start: Number.isFinite(start) ? start : 0,
      end: Number.isFinite(end) ? end : 0,
      allocatedDuration,
      speaker: seg.speaker,
      originalText,
      translatedText,
      originalWordCount,
      wordCount,
      completenessRatio,
      estimatedDuration,
      minRecommendedWords,
      maxRecommendedWords,
      targetWords,
      actualAudioDuration,
      actualSpeechDuration,
      audioOverflowSec,
      status,
      correctionDirection,
      reason,
    };
  });

  const problemChecks = checks.filter((c) => c.status !== 'PASS');
  const passingCount = checks.length - problemChecks.length;
  const tooLongCount = checks.filter((c) => c.status === 'TOO LONG').length;
  const tooShortCount = checks.filter((c) => c.status === 'TOO SHORT').length;
  const needsReviewCount = checks.filter((c) => c.status === 'NEEDS REVIEW').length;

  let summaryText: string;
  if (checks.length === 0) {
    summaryText = 'No narration segments to validate.';
  } else if (problemChecks.length > 0) {
    summaryText = `${checks.length} segment${checks.length === 1 ? '' : 's'} checked — ${problemChecks.length} narration segment${problemChecks.length === 1 ? '' : 's'} need${problemChecks.length === 1 ? 's' : ''} balanced correction.`;
  } else if (hasMeasuredAudio) {
    summaryText = `${checks.length} segment${checks.length === 1 ? '' : 's'} checked — All narration segments fit measured Fish Audio FFprobe durations cleanly with complete storytelling.`;
  } else {
    summaryText = `${checks.length} segment${checks.length === 1 ? '' : 's'} checked — All pass preliminary screening (generate Fish Audio to verify real FFprobe speech durations).`;
  }

  return {
    config,
    totalSegments: checks.length,
    passingCount,
    problemCount: problemChecks.length,
    tooLongCount,
    tooShortCount,
    needsReviewCount,
    audioOverflowCount,
    hasMeasuredAudio,
    summaryText,
    checks,
    problemChecks,
  };
}

export function buildTargetedFixPrompt(params: {
  report: NarrationValidationReport;
  targetLanguage: SupportedLanguage;
  onlyAudioOverflows?: boolean;
}): string {
  const { report, targetLanguage, onlyAudioOverflows = false } = params;
  const targetChecks = onlyAudioOverflows
    ? report.problemChecks.filter(
        (c) =>
          c.actualAudioDuration !== null &&
          c.audioOverflowSec !== null &&
          c.audioOverflowSec > report.config.audioOverflowToleranceSec
      )
    : report.problemChecks;

  if (targetChecks.length === 0) {
    return '';
  }

  const hasAudioIssues = targetChecks.some((c) => c.actualAudioDuration !== null);

  const lines: string[] = [
    hasAudioIssues
      ? `FIX PROMPT — REAL FISH AUDIO TIMELINE CORRECTION (TARGET LANGUAGE: ${targetLanguage}, 1.0x FIXED SPEED):`
      : `FIX PROMPT — BALANCED NARRATION CORRECTION (TARGET LANGUAGE: ${targetLanguage}, 1.0x FIXED SPEED):`,
    `Compare "Original text" with "Current translated text" for EVERY segment listed below before making any change.`,
    `A corrected translation must be ONLY as short as necessary, NEVER shorter than necessary. It must remain a complete and faithful translation, not a summary.`,
    ``,
    `STRICT RULES:`,
    `1. NEVER summarize the original narration.`,
    `2. NEVER remove important facts, actions, events, explanations, or story details.`,
    `3. NEVER rewrite a complete translation into a short summary.`,
    `4. Preserve the original meaning, storytelling style, and as much information as possible.`,
    `5. Word count is ONLY a warning indicator, NOT a target. Do NOT force every segment to have the same number of words. Actual Fish Audio duration is more important than word count. Never alter fixed 1.0x speech speed.`,
    ``,
    `CORRECTION RULES BY STATUS:`,
    `A. TOO LONG (MINIMAL SHORTENING ONLY): Make only the smallest necessary reduction to fit the allocated duration. Remove redundant wording and unnecessary repetitions first. Use concise, natural spoken ${targetLanguage}. Preserve every important fact and action. Do not aggressively shorten the sentence. Do not turn narration into a summary.`,
    `B. TOO SHORT (EXPANSION FROM ORIGINAL TEXT): Expand the translation using originalText. Restore missing information and omitted details. Keep the narration natural and complete. Never add invented information.`,
    `C. PASS: Segments with status PASS are NOT included below. Keep their translatedText EXACTLY unchanged. Do not rewrite or improve them unnecessarily.`,
    `D. NEEDS REVIEW: Preserve the existing translation unless a clear factual or linguistic problem exists.`,
    ``,
    `REQUIRED OUTPUT RULES (PARTIAL JSON PATCH ONLY):`,
    `1. Return a partial JSON patch containing ONLY the segment IDs listed below (${targetChecks.length} segment(s)) that need correction.`,
    `2. For every corrected segment: return the exact existing segment "id" and modify "translatedText" ONLY. Preserve start, end, speaker, originalText, and all other fields untouched.`,
    `3. Do NOT omit any important information from originalText. Do NOT return a complete replacement JSON.`,
    `4. Return ONLY raw valid JSON (no markdown explanations outside JSON).`,
    ``,
    `FAILING SEGMENTS TO CORRECT (${targetChecks.length}):`,
  ];

  targetChecks.forEach((c, idx) => {
    const requiredAction =
      c.status === 'TOO LONG'
        ? 'MINIMAL SHORTENING ONLY (remove redundant filler first; keep every essential fact and action)'
        : c.status === 'TOO SHORT'
        ? 'EXPANSION FROM ORIGINAL TEXT (restore missing information and omitted details from originalText; never invent details)'
        : 'NEEDS REVIEW (preserve existing translation unless a clear factual or linguistic problem exists)';

    lines.push(``);
    lines.push(`--- Segment ${idx + 1}: "${c.segmentId}" [${c.status}] ---`);
    lines.push(`- Exact segment ID: ${c.segmentId}`);
    lines.push(`- Target language: ${targetLanguage}`);
    lines.push(`- Window: ${c.start.toFixed(2)}s -> ${c.end.toFixed(2)}s`);
    lines.push(`- Allocated duration: ${c.allocatedDuration.toFixed(2)}s`);
    if (c.actualAudioDuration !== null) {
      lines.push(
        `- Actual Fish Audio duration: ${c.actualAudioDuration.toFixed(2)}s${
          c.actualSpeechDuration !== null
            ? ` (measured speech: ${c.actualSpeechDuration.toFixed(2)}s)`
            : ''
        }`
      );
      if (c.audioOverflowSec !== null && c.audioOverflowSec > 0) {
        lines.push(`- Overflow over slot: +${c.audioOverflowSec.toFixed(2)}s`);
      }
    } else {
      lines.push(`- Actual Fish Audio duration: Not generated yet`);
    }
    lines.push(
      `- Word count: ${c.wordCount} words in current translation / ${c.originalWordCount} words in originalText (warning indicator only, NOT a word-count target)`
    );
    if (c.speaker) {
      lines.push(`- Speaker: ${c.speaker}`);
    }
    lines.push(`- Original text: ${c.originalText || '(not provided)'}`);
    lines.push(`- Current translated text: ${c.translatedText || '(empty)'}`);
    lines.push(`- Exact reason for correction: ${c.reason}`);
    lines.push(`- Required correction action: ${requiredAction}`);
  });

  lines.push(``);
  lines.push(`REQUIRED OUTPUT FORMAT (Partial JSON patch by segment ID — ONLY listed segments, translatedText ONLY):`);
  lines.push(
    JSON.stringify(
      {
        segments: targetChecks.slice(0, 2).map((c) => ({
          id: c.segmentId,
          translatedText:
            c.status === 'TOO SHORT'
              ? `Complete, natural ${targetLanguage} translation restoring omitted details from originalText without inventing facts`
              : c.status === 'TOO LONG'
              ? `Natural ${targetLanguage} translation with only the smallest necessary reduction, preserving all important story facts and actions`
              : `Faithful ${targetLanguage} translation preserving existing meaning unless a clear factual or linguistic issue needed fixing`,
        })),
      },
      null,
      2
    )
  );

  return lines.join('\n');
}

export interface RejectedPartialCorrection {
  segmentId: string;
  status: 'INVALID';
  reasons: string[];
  attemptedText: string;
}

export type ApplyPartialCorrectionsResult =
  | {
      ok: true;
      updatedSegments: CaptionSegment[];
      updatedSegmentIds: string[];
      skippedPassingIds: string[];
      rejectedCorrections: RejectedPartialCorrection[];
      beforeSnapshot: Record<string, string>;
      afterSnapshot: Record<string, string>;
      updatedFullJson: string;
    }
  | {
      ok: false;
      error: string;
      rejectedCorrections?: RejectedPartialCorrection[];
    };

function extractDigits(text: string): string[] {
  return text.match(/\b\d+(?:[.,]\d+)?\b/g) || [];
}

function extractMidSentenceProperNouns(text: string): string[] {
  const words = text.split(/\s+/);
  const found: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1];
    if (/[.!?؟]$/.test(prev)) continue;
    const clean = words[i].replace(/^[^a-zA-ZÀ-ÿ]+|[^a-zA-ZÀ-ÿ'-]+$/g, '');
    if (clean.length >= 3 && /^[A-ZÀ-Ý][a-zà-ÿ'-]{2,}$/.test(clean)) {
      found.push(clean);
    }
  }
  return Array.from(new Set(found));
}

function validatePartialCorrectionCandidate(params: {
  seg: CaptionSegment;
  newTranslatedText: string;
  check?: SegmentNarrationCheck;
}): string[] {
  const { seg, newTranslatedText, check } = params;
  const reasons: string[] = [];
  const originalText = (seg.text || '').trim();
  const prevText = (seg.translatedText || '').trim();
  const nextText = newTranslatedText.trim();

  const origWords = countNarrationWords(originalText);
  const prevWords = countNarrationWords(prevText);
  const newWords = countNarrationWords(nextText);

  // 1. Detect summary meta-phrases
  if (
    /^(?:in short|in summary|to summarize|summary\s*:|en résumé|en bref|résumé\s*:|bref\s*:)/i.test(
      nextText
    ) &&
    !/^(?:in short|in summary|to summarize|summary\s*:|en résumé|en bref|résumé\s*:|bref\s*:)/i.test(
      originalText
    )
  ) {
    reasons.push('Appears to summarize instead of translating the narration.');
  }

  // 2. Check numeric facts (preserve original numbers, reject invented numbers)
  const origDigits = new Set(extractDigits(originalText));
  const prevDigits = new Set(extractDigits(prevText));
  const nextDigits = new Set(extractDigits(nextText));

  const missingDigits = Array.from(origDigits).filter(
    (d) => prevDigits.has(d) && !nextDigits.has(d)
  );
  if (missingDigits.length > 0) {
    reasons.push(
      `Removed important numeric fact(s) from originalText: ${missingDigits.join(', ')}.`
    );
  }

  const inventedDigits = Array.from(nextDigits).filter(
    (d) => !origDigits.has(d) && !prevDigits.has(d)
  );
  if (inventedDigits.length > 0) {
    reasons.push(
      `Invented numeric detail(s) not present in originalText: ${inventedDigits.join(', ')}.`
    );
  }

  // 3. Check proper nouns / character & location names present in both originalText & previous translation
  const origNames = extractMidSentenceProperNouns(originalText);
  const nextLower = nextText.toLowerCase();
  const prevLower = prevText.toLowerCase();
  const droppedNames = origNames.filter(
    (name) => prevLower.includes(name.toLowerCase()) && !nextLower.includes(name.toLowerCase())
  );
  if (droppedNames.length > 0) {
    reasons.push(
      `Removed important character/location name(s): ${droppedNames.join(', ')}.`
    );
  }

  // 4. Status-specific checks comparing new translatedText against originalText & previous translatedText
  const status = check?.status;
  if (status === 'TOO SHORT') {
    if (prevWords > 0 && newWords <= prevWords) {
      reasons.push(
        `Segment was flagged TOO SHORT — correction must expand using details from originalText instead of staying at or below ${prevWords} words (got ${newWords} words).`
      );
    }
  } else if (status === 'NEEDS REVIEW') {
    if (prevWords >= 6 && newWords < Math.ceil(prevWords * 0.8)) {
      reasons.push(
        `Segment was flagged NEEDS REVIEW — correction shortened text excessively (${prevWords}w -> ${newWords}w) instead of preserving existing meaning.`
      );
    }
  } else if (status === 'TOO LONG') {
    const slotDur = check?.allocatedDuration || Math.max(0.2, seg.end - seg.start);
    const actualDur = check?.actualAudioDuration;
    // Allow proportional reduction with a fair margin; block aggressive summarization
    const minFractionOfPrev =
      actualDur && actualDur > slotDur
        ? Math.max(0.45, Math.min(0.65, (slotDur / actualDur) * 0.72))
        : 0.55;

    if (prevWords >= 8 && newWords < Math.floor(prevWords * minFractionOfPrev)) {
      reasons.push(
        `Excessively shorter without a clear reason (${prevWords}w -> ${newWords}w) — appears to aggressively shorten or summarize instead of making only the smallest necessary reduction.`
      );
    } else if (origWords >= 8 && newWords < Math.max(4, Math.ceil(origWords * 0.48))) {
      reasons.push(
        `Over-shortened relative to originalText (${newWords}w vs ${origWords}w original) — important story facts or actions were likely removed.`
      );
    }
  } else {
    if (origWords >= 8 && newWords < Math.max(4, Math.ceil(origWords * 0.48))) {
      reasons.push(
        `Excessively shorter than originalText (${newWords}w vs ${origWords}w original) without justification.`
      );
    }
  }

  // 5. Reject invented content / runaway expansion
  if (origWords >= 4 && newWords > Math.max(origWords * 2.2 + 4, prevWords * 2.5 + 6)) {
    reasons.push(
      `Significantly longer than originalText (${newWords}w vs ${origWords}w original) — may have invented extra information.`
    );
  }

  return reasons;
}

export function applyPartialGeminiCorrections(params: {
  rawCorrections: string;
  currentSegments: CaptionSegment[];
  currentFullJson?: string;
  sourceLanguage?: string;
  targetLanguage: SupportedLanguage;
  passingSegmentIds?: Set<string> | string[];
  validationChecks?: SegmentNarrationCheck[];
}): ApplyPartialCorrectionsResult {
  const {
    rawCorrections,
    currentSegments,
    currentFullJson,
    sourceLanguage,
    targetLanguage,
    passingSegmentIds,
    validationChecks = [],
  } = params;
  const trimmed = rawCorrections.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: 'Corrections box is empty. Paste Gemini’s corrected JSON segments first.',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonFromGeminiText(trimmed));
  } catch {
    return {
      ok: false,
      error:
        'Malformed JSON in Corrections input. Ensure Gemini returned valid JSON with "segments" or an array of { id, translatedText }.',
    };
  }

  let items: unknown[] = [];
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.segments)) {
      items = obj.segments;
    } else if (typeof obj.id === 'string') {
      items = [obj];
    }
  }

  if (items.length === 0) {
    return {
      ok: false,
      error:
        'No corrected segment entries found. Expected { "segments": [{ "id": "...", "translatedText": "..." }] }.',
    };
  }

  const passingSet = new Set<string>(
    passingSegmentIds ? Array.from(passingSegmentIds) : []
  );
  const checkById = new Map(validationChecks.map((c) => [c.segmentId, c]));
  const existingById = new Map(currentSegments.map((s) => [s.id, s]));
  const patches = new Map<string, string>();
  const unknownIds: string[] = [];
  const skippedPassingIds: string[] = [];
  const rejectedCorrections: RejectedPartialCorrection[] = [];

  for (let i = 0; i < items.length; i++) {
    const entry = items[i];
    if (!entry || typeof entry !== 'object') {
      return {
        ok: false,
        error: `Correction entry #${i + 1} must be a JSON object with "id" and "translatedText".`,
      };
    }
    const rec = entry as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    if (!id) {
      return {
        ok: false,
        error: `Correction entry #${i + 1} is missing a valid string "id".`,
      };
    }
    const existingSeg = existingById.get(id);
    if (!existingSeg) {
      unknownIds.push(id);
      continue;
    }
    if (
      patches.has(id) ||
      skippedPassingIds.includes(id) ||
      rejectedCorrections.some((r) => r.segmentId === id)
    ) {
      return {
        ok: false,
        error: `Duplicate segment ID "${id}" in pasted corrections.`,
      };
    }
    const nextText = typeof rec.translatedText === 'string' ? rec.translatedText.trim() : '';
    if (!nextText) {
      return {
        ok: false,
        error: `Segment "${id}" is missing a non-empty "translatedText".`,
      };
    }

    // Never allow timestamp or immutable field mutations in a partial patch
    const metadataReasons: string[] = [];
    if (rec.start !== undefined && Math.abs(Number(rec.start) - existingSeg.start) > 0.02) {
      metadataReasons.push(
        `Changed start timestamp (${String(rec.start)}s != ${existingSeg.start}s).`
      );
    }
    if (rec.end !== undefined && Math.abs(Number(rec.end) - existingSeg.end) > 0.02) {
      metadataReasons.push(
        `Changed end timestamp (${String(rec.end)}s != ${existingSeg.end}s).`
      );
    }
    if (
      typeof rec.speaker === 'string' &&
      rec.speaker.trim() !== (existingSeg.speaker || '').trim()
    ) {
      metadataReasons.push(
        `Changed speaker (${rec.speaker.trim()} != ${existingSeg.speaker || ''}).`
      );
    }
    if (
      typeof rec.originalText === 'string' &&
      rec.originalText.trim() !== (existingSeg.text || '').trim()
    ) {
      metadataReasons.push('Altered immutable originalText field.');
    }

    // Never modify segments whose validation status is PASS
    if (passingSet.has(id)) {
      skippedPassingIds.push(id);
      continue;
    }

    const contentReasons = validatePartialCorrectionCandidate({
      seg: existingSeg,
      newTranslatedText: nextText,
      check: checkById.get(id),
    });
    const allReasons = [...metadataReasons, ...contentReasons];

    if (allReasons.length > 0) {
      rejectedCorrections.push({
        segmentId: id,
        status: 'INVALID',
        reasons: allReasons,
        attemptedText: nextText,
      });
      continue;
    }

    patches.set(id, nextText);
  }

  if (unknownIds.length > 0) {
    return {
      ok: false,
      error: `Rejected unknown segment ID(s): ${unknownIds.join(
        ', '
      )}. Correction IDs must match existing project segments.`,
    };
  }

  if (patches.size === 0 && rejectedCorrections.length > 0) {
    const summary = rejectedCorrections
      .map((r) => `[${r.segmentId}: INVALID] ${r.reasons.join(' ')}`)
      .join(' | ');
    return {
      ok: false,
      error: `All pasted corrections were marked INVALID and were NOT applied: ${summary}`,
      rejectedCorrections,
    };
  }

  if (patches.size === 0 && skippedPassingIds.length > 0) {
    return {
      ok: false,
      error: `Rejected patch: segment(s) ${skippedPassingIds.join(
        ', '
      )} already have status PASS and must remain unchanged.`,
    };
  }

  const beforeSnapshot: Record<string, string> = {};
  const afterSnapshot: Record<string, string> = {};
  const updatedSegmentIds: string[] = [];

  // Preserve original segment order, timestamps, speaker names, and originalText
  const updatedSegments: CaptionSegment[] = currentSegments.map((seg) => {
    const replacement = patches.get(seg.id);
    if (replacement === undefined) return seg;
    beforeSnapshot[seg.id] = seg.translatedText || '';
    afterSnapshot[seg.id] = replacement;
    updatedSegmentIds.push(seg.id);
    return {
      ...seg,
      translatedText: replacement,
      words: distributeWordsEvenlyClient(replacement, seg.start, seg.end),
    };
  });

  // Preserve metadata and untouched segments in full JSON, updating ONLY translatedText on matched non-passing IDs
  let fullObj: Record<string, unknown> = {
    sourceLanguage: sourceLanguage || 'Auto',
    targetLanguage,
    characters: [] as string[],
    locations: [] as string[],
    segments: [] as unknown[],
  };

  if (currentFullJson && currentFullJson.trim()) {
    try {
      const existingParsed = JSON.parse(extractJsonFromGeminiText(currentFullJson));
      if (
        existingParsed &&
        typeof existingParsed === 'object' &&
        !Array.isArray(existingParsed)
      ) {
        fullObj = { ...(existingParsed as Record<string, unknown>) };
      }
    } catch {
      // fall back to reconstructed full JSON below
    }
  }

  const existingRawById = new Map<string, Record<string, unknown>>();
  if (Array.isArray(fullObj.segments)) {
    for (const rawSeg of fullObj.segments) {
      if (rawSeg && typeof rawSeg === 'object') {
        const rec = rawSeg as Record<string, unknown>;
        if (typeof rec.id === 'string' && rec.id.trim()) {
          existingRawById.set(rec.id.trim(), rec);
        }
      }
    }
  }

  fullObj.segments = updatedSegments.map((seg) => {
    const existingRaw = existingRawById.get(seg.id);
    const replacement = patches.get(seg.id);
    if (existingRaw) {
      return replacement !== undefined
        ? {
            ...existingRaw,
            id: seg.id,
            start: seg.start,
            end: seg.end,
            speaker: seg.speaker || existingRaw.speaker || 'Narrator',
            originalText: seg.text,
            translatedText: replacement,
          }
        : existingRaw;
    }
    return {
      id: seg.id,
      start: seg.start,
      end: seg.end,
      speaker: seg.speaker || 'Narrator',
      originalText: seg.text,
      translatedText: seg.translatedText || '',
    };
  });

  return {
    ok: true,
    updatedSegments,
    updatedSegmentIds,
    skippedPassingIds,
    rejectedCorrections,
    beforeSnapshot,
    afterSnapshot,
    updatedFullJson: JSON.stringify(fullObj, null, 2),
  };
}
