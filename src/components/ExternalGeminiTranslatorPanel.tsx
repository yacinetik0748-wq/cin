import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  ExternalLink,
  FileCode2,
  History,
  Loader2,
  Mic,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import {
  CaptionSegment,
  CorrectionHistoryEntry,
  NarrationValidationConfig,
  Project,
  SUPPORTED_LANGUAGES,
  SupportedLanguage,
} from '../types/studio';
import { api } from '../lib/api';
import { createWorkflowUpdate } from '../lib/workflowStages';
import {
  DEFAULT_NARRATION_VALIDATION_CONFIG,
  ExternalGeminiValidationResult,
  NarrationValidationReport,
  RejectedPartialCorrection,
  applyPartialGeminiCorrections,
  buildConciseShorteningPrompt,
  buildCorrectionPrompt,
  buildExternalGeminiPrompt,
  buildTargetedFixPrompt,
  validateExternalGeminiJson,
  validateNarrationSegments,
} from '../lib/externalGeminiWorkflow';

interface ExternalGeminiTranslatorPanelProps {
  project: Project;
  onProjectUpdated: (p: Project) => void;
  sourceLanguage?: string;
  targetLanguage?: SupportedLanguage;
  onChangeTargetLanguage?: (lang: SupportedLanguage) => void;
  preserveProperNouns?: boolean;
  onChangePreserveProperNouns?: (val: boolean) => void;
  allowedTargetLanguages?: SupportedLanguage[];
  onApprovedSuccess?: (segmentCount: number, targetLang: SupportedLanguage) => void;
  focusAudioOverflowSignal?: number;
}

async function copyTextSafely(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fallback below
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function ExternalGeminiTranslatorPanel({
  project,
  onProjectUpdated,
  sourceLanguage = project.translation.sourceLanguage || 'Auto',
  targetLanguage: controlledTarget,
  onChangeTargetLanguage,
  preserveProperNouns: controlledPreserve,
  onChangePreserveProperNouns,
  allowedTargetLanguages = SUPPORTED_LANGUAGES,
  onApprovedSuccess,
  focusAudioOverflowSignal,
}: ExternalGeminiTranslatorPanelProps) {
  const [localTarget, setLocalTarget] = useState<SupportedLanguage>(
    controlledTarget || project.translation.targetLanguage || 'French'
  );
  const [localPreserve, setLocalPreserve] = useState<boolean>(
    controlledPreserve ?? project.translation.preserveProperNouns
  );

  const activeTarget = controlledTarget ?? localTarget;
  const activePreserve = controlledPreserve ?? localPreserve;

  const [promptText, setPromptText] = useState<string>(() =>
    buildExternalGeminiPrompt({
      project,
      sourceLanguage,
      targetLanguage: activeTarget,
      preserveProperNouns: activePreserve,
    })
  );
  const [rawJsonAnswer, setRawJsonAnswer] = useState<string>(
    project.translation.externalGeminiDraftJson || ''
  );

  // Configurable word-count screening & audio overflow settings
  const [validationConfig, setValidationConfig] = useState<NarrationValidationConfig>(
    project.translation.validationConfig || DEFAULT_NARRATION_VALIDATION_CONFIG
  );
  const [showConfigPanel, setShowConfigPanel] = useState(false);

  // Expandable sections
  const [promptExpanded, setPromptExpanded] = useState<boolean>(
    !(project.translation.externalGeminiDraftJson || '').trim()
  );
  const [fixPromptExpanded, setFixPromptExpanded] = useState(false);
  const [correctionsExpanded, setCorrectionsExpanded] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [showAllValidatedSegments, setShowAllValidatedSegments] = useState(false);

  // Validation & loop state
  const [validation, setValidation] = useState<ExternalGeminiValidationResult | null>(null);
  const [narrationReport, setNarrationReport] = useState<NarrationValidationReport | null>(null);
  const [workingSegments, setWorkingSegments] = useState<CaptionSegment[] | null>(null);
  const [fixPromptText, setFixPromptText] = useState<string>('');
  const [syntaxCorrectionPrompt, setSyntaxCorrectionPrompt] = useState<string>('');
  const [partialCorrectionsInput, setPartialCorrectionsInput] = useState<string>('');

  // Clipboard & async feedback
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [copiedFixPrompt, setCopiedFixPrompt] = useState(false);
  const [copiedSyntaxCorrection, setCopiedSyntaxCorrection] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyingCorrections, setApplyingCorrections] = useState(false);
  const [regeneratingAudio, setRegeneratingAudio] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  const [rejectedCorrections, setRejectedCorrections] = useState<RejectedPartialCorrection[]>([]);
  const [applySuccessMsg, setApplySuccessMsg] = useState<string | null>(null);

  const correctionHistory: CorrectionHistoryEntry[] = project.translation.correctionHistory || [];
  const pendingRegenIds: string[] = project.translation.pendingRegenerateSegmentIds || [];

  useEffect(() => {
    setRawJsonAnswer(project.translation.externalGeminiDraftJson || '');
    setValidationConfig(
      project.translation.validationConfig || DEFAULT_NARRATION_VALIDATION_CONFIG
    );
    setPromptText(
      buildExternalGeminiPrompt({
        project,
        sourceLanguage: project.translation.sourceLanguage || 'Auto',
        targetLanguage: controlledTarget || project.translation.targetLanguage || 'French',
        preserveProperNouns: controlledPreserve ?? project.translation.preserveProperNouns,
      })
    );
    setValidation(null);
    setNarrationReport(null);
    setWorkingSegments(null);
    setFixPromptText('');
    setSyntaxCorrectionPrompt('');
    setPartialCorrectionsInput('');
    setApplyError(null);
    setCorrectionError(null);
    setRejectedCorrections([]);
    setApplySuccessMsg(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  // Triggered when user clicks "Verify Audio Overflow in Correction Loop" from VoiceStudioPage
  useEffect(() => {
    if (!focusAudioOverflowSignal || project.captions.length === 0) return;
    const report = validateNarrationSegments({
      segments: project.captions,
      generatedClips: project.voice.generatedClips,
      config: validationConfig,
    });
    setNarrationReport(report);
    setWorkingSegments(project.captions);
    const audioPrompt = buildTargetedFixPrompt({
      report,
      targetLanguage: activeTarget,
      onlyAudioOverflows: report.audioOverflowCount > 0,
    });
    if (audioPrompt) {
      setFixPromptText(audioPrompt);
      setFixPromptExpanded(true);
      setCorrectionsExpanded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAudioOverflowSignal]);

  // Keep measured Fish Audio durations reflected if a report is currently visible and clips changed
  useEffect(() => {
    if (!narrationReport) return;
    const baseSegments = workingSegments || project.captions;
    if (baseSegments.length === 0) return;
    const updatedReport = validateNarrationSegments({
      segments: baseSegments,
      generatedClips: project.voice.generatedClips,
      config: validationConfig,
    });
    setNarrationReport(updatedReport);
    if (updatedReport.problemCount > 0) {
      setFixPromptText(
        buildTargetedFixPrompt({
          report: updatedReport,
          targetLanguage: activeTarget,
          onlyAudioOverflows: updatedReport.audioOverflowCount > 0,
        })
      );
    } else {
      setFixPromptText('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.voice.generatedClips]);

  const duration = project.metadata?.duration || 0;

  const promptStats = useMemo(() => {
    return {
      segmentAnchorCount: project.captions.length,
      charCount: promptText.length,
    };
  }, [project.captions.length, promptText]);

  const handleGeneratePrompt = (
    overrideTarget?: SupportedLanguage,
    overridePreserve?: boolean
  ) => {
    const nextPrompt = buildExternalGeminiPrompt({
      project,
      sourceLanguage,
      targetLanguage: overrideTarget ?? activeTarget,
      preserveProperNouns: overridePreserve ?? activePreserve,
    });
    setPromptText(nextPrompt);
    setPromptExpanded(true);
    setApplySuccessMsg(null);
  };

  const handleTargetChange = (nextLang: SupportedLanguage) => {
    if (onChangeTargetLanguage) {
      onChangeTargetLanguage(nextLang);
    } else {
      setLocalTarget(nextLang);
    }
    handleGeneratePrompt(nextLang, activePreserve);
  };

  const handlePreserveChange = (val: boolean) => {
    if (onChangePreserveProperNouns) {
      onChangePreserveProperNouns(val);
    } else {
      setLocalPreserve(val);
    }
    handleGeneratePrompt(activeTarget, val);
  };

  const handleCopyPrompt = async () => {
    const ok = await copyTextSafely(promptText);
    if (ok) {
      setCopiedPrompt(true);
      window.setTimeout(() => setCopiedPrompt(false), 1800);
    }
  };

  const runNarrationValidation = (
    segmentsToValidate: CaptionSegment[],
    overrideConfig?: NarrationValidationConfig
  ) => {
    const cfg = overrideConfig || validationConfig;
    const report = validateNarrationSegments({
      segments: segmentsToValidate,
      generatedClips: project.voice.generatedClips,
      config: cfg,
    });
    setNarrationReport(report);
    setWorkingSegments(segmentsToValidate);

    if (report.problemCount > 0) {
      const targeted = buildTargetedFixPrompt({
        report,
        targetLanguage: activeTarget,
        onlyAudioOverflows: false,
      });
      setFixPromptText(targeted);
      setFixPromptExpanded(true);
      setCorrectionsExpanded(true);
    } else {
      setFixPromptText('');
    }
    return report;
  };

  const handleValidateNarration = () => {
    setApplyError(null);
    setCorrectionError(null);
    setApplySuccessMsg(null);

    if (rawJsonAnswer.trim()) {
      const jsonResult = validateExternalGeminiJson({
        rawAnswer: rawJsonAnswer,
        existingCaptions: project.captions,
        videoDuration: duration,
        expectedTargetLanguage: activeTarget,
      });
      setValidation(jsonResult);

      if (!jsonResult.valid || !jsonResult.normalizedSegments) {
        setNarrationReport(null);
        setWorkingSegments(null);
        setFixPromptText('');
        return;
      }

      if (jsonResult.formattedJson) {
        setRawJsonAnswer(jsonResult.formattedJson);
      }
      setSyntaxCorrectionPrompt('');
      runNarrationValidation(jsonResult.normalizedSegments);
      return;
    }

    // Fallback: if user already has segments in the project, validate those directly
    if (project.captions.length > 0) {
      setValidation({
        valid: true,
        errors: [],
        warnings: [],
        normalizedSegments: project.captions,
        parsedMetadata: {
          sourceLanguage: project.translation.sourceLanguage,
          targetLanguage: activeTarget,
          characters: [],
          locations: [],
        },
      });
      runNarrationValidation(project.captions);
    } else {
      setApplyError('Paste Gemini’s JSON response first before validating narration.');
    }
  };

  const handleGenerateSyntaxCorrectionPrompt = () => {
    const latest = validateExternalGeminiJson({
      rawAnswer: rawJsonAnswer,
      existingCaptions: project.captions,
      videoDuration: duration,
      expectedTargetLanguage: activeTarget,
    });
    setValidation(latest);
    const corr = buildCorrectionPrompt({
      rawAnswer: rawJsonAnswer,
      errors: latest.errors,
      warnings: latest.warnings,
      targetLanguage: activeTarget,
      existingCaptions: project.captions,
      videoDuration: duration,
    });
    setSyntaxCorrectionPrompt(corr);
  };

  const handleGenerateShorteningPrompt = () => {
    const baseSegments = workingSegments || validation?.normalizedSegments || project.captions;
    const prompt = buildConciseShorteningPrompt({
      videoDuration: duration,
      targetLanguage: activeTarget,
      existingCaptions: baseSegments,
      generatedClips: project.voice.generatedClips,
    });
    setFixPromptText(prompt);
    setFixPromptExpanded(true);
    setCorrectionsExpanded(true);
  };

  const handleCopyFixPrompt = async () => {
    if (!fixPromptText) return;
    const ok = await copyTextSafely(fixPromptText);
    if (ok) {
      setCopiedFixPrompt(true);
      window.setTimeout(() => setCopiedFixPrompt(false), 1800);
    }
  };

  const handleCopySyntaxCorrection = async () => {
    if (!syntaxCorrectionPrompt) return;
    const ok = await copyTextSafely(syntaxCorrectionPrompt);
    if (ok) {
      setCopiedSyntaxCorrection(true);
      window.setTimeout(() => setCopiedSyntaxCorrection(false), 1800);
    }
  };

  const handleApplyPartialCorrections = async () => {
    setCorrectionError(null);
    setRejectedCorrections([]);
    setApplyError(null);
    setApplySuccessMsg(null);

    const baseSegments =
      workingSegments || validation?.normalizedSegments || project.captions;
    if (!baseSegments || baseSegments.length === 0) {
      setCorrectionError(
        'Validate your initial Gemini JSON segments first before applying partial corrections.'
      );
      return;
    }

    const activeReport =
      narrationReport ||
      validateNarrationSegments({
        segments: baseSegments,
        generatedClips: project.voice.generatedClips,
        config: validationConfig,
      });
    const passingSegmentIds = activeReport.checks
      .filter((c) => c.status === 'PASS')
      .map((c) => c.segmentId);

    const patchResult = applyPartialGeminiCorrections({
      rawCorrections: partialCorrectionsInput,
      currentSegments: baseSegments,
      currentFullJson: rawJsonAnswer,
      sourceLanguage: validation?.parsedMetadata?.sourceLanguage || project.translation.sourceLanguage,
      targetLanguage: activeTarget,
      passingSegmentIds,
      validationChecks: activeReport.checks,
    });

    if (!patchResult.ok) {
      setCorrectionError(patchResult.error);
      setRejectedCorrections(patchResult.rejectedCorrections || []);
      return;
    }

    const rejectedList = patchResult.rejectedCorrections || [];
    setRejectedCorrections(rejectedList);

    setApplyingCorrections(true);
    try {
      const hadAudioIssues = Boolean(
        narrationReport && narrationReport.audioOverflowCount > 0
      );
      const historyEntry: CorrectionHistoryEntry = {
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        source: hadAudioIssues ? 'audio-overflow' : 'word-validation',
        updatedSegmentIds: patchResult.updatedSegmentIds,
        note: `Updated ${patchResult.updatedSegmentIds.length} segment(s): ${patchResult.updatedSegmentIds.join(', ')}`,
        beforeSnapshot: patchResult.beforeSnapshot,
        afterSnapshot: patchResult.afterSnapshot,
      };

      const nextHistory = [historyEntry, ...correctionHistory].slice(0, 30);

      // Track segments that already have Fish Audio clips so the user can regenerate ONLY those clips
      const existingClipIds = new Set((project.voice.generatedClips || []).map((c) => c.segmentId));
      const newlyAffectedClipIds = patchResult.updatedSegmentIds.filter((id) =>
        existingClipIds.has(id)
      );
      const nextPendingRegen = Array.from(
        new Set([...pendingRegenIds, ...newlyAffectedClipIds])
      );

      const nextWorkflow = createWorkflowUpdate(project.workflow, {
        completeStage: 'translator',
        modifiedStage: 'translator',
        hasGeneratedDub: Boolean(project.voice.fullDubUrl),
        hasGeneratedCaptions: Boolean(project.subtitleStyle.captionSync),
        hasExistingExport: Boolean(project.lastExportUrl),
      });

      // Persist updated segments + full JSON draft + correction history to DB (keeping subtitleStyle.enabled untouched!)
      const { project: saved } = await api.updateProject(project.id, {
        captions: patchResult.updatedSegments,
        translation: {
          ...project.translation,
          sourceLanguage:
            validation?.parsedMetadata?.sourceLanguage ||
            project.translation.sourceLanguage ||
            'Auto',
          targetLanguage: activeTarget,
          preserveProperNouns: activePreserve,
          lastTranslatedAt: new Date().toISOString(),
          externalGeminiDraftJson: patchResult.updatedFullJson,
          validationConfig,
          correctionHistory: nextHistory,
          pendingRegenerateSegmentIds: nextPendingRegen,
        },
        subtitleStyle: {
          ...project.subtitleStyle,
          useTranslated: true,
        },
        voice: {
          ...project.voice,
          targetLanguage: activeTarget,
        },
        workflow: nextWorkflow,
      });

      onProjectUpdated(saved);
      setRawJsonAnswer(patchResult.updatedFullJson);
      setWorkingSegments(patchResult.updatedSegments);
      setPartialCorrectionsInput('');

      // Re-run JSON + Narration validation automatically after applying corrections
      const revalidatedJson = validateExternalGeminiJson({
        rawAnswer: patchResult.updatedFullJson,
        existingCaptions: patchResult.updatedSegments,
        videoDuration: duration,
        expectedTargetLanguage: activeTarget,
      });
      setValidation(revalidatedJson);

      const newReport = runNarrationValidation(patchResult.updatedSegments);
      const skippedNotice =
        patchResult.skippedPassingIds.length > 0
          ? ` Preserved ${patchResult.skippedPassingIds.length} PASS segment(s) untouched (${patchResult.skippedPassingIds.join(', ')}).`
          : '';
      const rejectedNotice =
        rejectedList.length > 0
          ? ` Rejected ${rejectedList.length} INVALID over-shortened/summarized patch(es) (${rejectedList.map((r) => r.segmentId).join(', ')}) — kept original translation for those.`
          : '';

      setApplySuccessMsg(
        newReport.problemCount === 0
          ? `Applied corrections to ${patchResult.updatedSegmentIds.length} segment(s) (${patchResult.updatedSegmentIds.join(', ')}). All segments now pass validation!${skippedNotice}${rejectedNotice}${newlyAffectedClipIds.length > 0 ? ' Click "Regenerate Audio for Corrected Segments Only" to update their MP3 clips.' : ''}`
          : `Applied corrections to ${patchResult.updatedSegmentIds.length} segment(s).${skippedNotice}${rejectedNotice} ${newReport.problemCount} segment(s) still need correction — updated Fix Prompt generated below.`
      );
    } catch (err) {
      setCorrectionError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplyingCorrections(false);
    }
  };

  const handleRegenerateAffectedAudio = async (idsToRegen: string[]) => {
    if (idsToRegen.length === 0) return;
    setApplyError(null);
    setCorrectionError(null);
    setApplySuccessMsg(null);
    setRegeneratingAudio(true);

    try {
      const targetSegs = workingSegments || project.captions;
      const res = await api.regenerateFishSegments(project.id, {
        segmentIds: idsToRegen,
        captions: targetSegs,
        voice: {
          ...project.voice,
          targetLanguage: activeTarget,
          provider: 'fish',
          speakingSpeed: 1.0,
        },
        useTranslated: true,
      });
      onProjectUpdated(res.project);

      const postReport = validateNarrationSegments({
        segments: res.project.captions,
        generatedClips: res.project.voice.generatedClips,
        config: validationConfig,
      });
      setNarrationReport(postReport);
      setWorkingSegments(res.project.captions);

      if (postReport.problemCount > 0) {
        const nextPrompt = buildTargetedFixPrompt({
          report: postReport,
          targetLanguage: activeTarget,
          onlyAudioOverflows: postReport.audioOverflowCount > 0,
        });
        setFixPromptText(nextPrompt);
        setFixPromptExpanded(true);
        setCorrectionsExpanded(true);
        setApplySuccessMsg(
          `Regenerated ${res.regeneratedIds.length} Fish Audio clip(s) at 1.0x and verified via FFprobe. ${postReport.problemCount} segment(s) still exceed duration — updated Fix Prompt ready.`
        );
      } else {
        setFixPromptText('');
        setApplySuccessMsg(
          `Regenerated ${res.regeneratedIds.length} Fish Audio clip(s) at 1.0x. All measured FFprobe durations now fit cleanly within their timeline windows!`
        );
      }
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err));
    } finally {
      setRegeneratingAudio(false);
    }
  };

  const handleApproveAndApply = async () => {
    setApplyError(null);
    setApplySuccessMsg(null);
    const result = validateExternalGeminiJson({
      rawAnswer: rawJsonAnswer,
      existingCaptions: project.captions,
      videoDuration: duration,
      expectedTargetLanguage: activeTarget,
    });
    setValidation(result);

    if (!result.valid || !result.normalizedSegments) {
      setApplyError('Please resolve JSON validation errors before applying segments to the project.');
      return;
    }

    const report = runNarrationValidation(result.normalizedSegments);

    setApplying(true);
    try {
      const detectedSrc =
        result.parsedMetadata?.sourceLanguage || project.translation.sourceLanguage || 'Auto';
      const nextWorkflow = createWorkflowUpdate(project.workflow, {
        completeStage: 'translator',
        modifiedStage: 'translator',
        hasGeneratedDub: Boolean(project.voice.fullDubUrl),
        hasGeneratedCaptions: Boolean(project.subtitleStyle.captionSync),
        hasExistingExport: Boolean(project.lastExportUrl),
      });
      const { project: saved } = await api.updateProject(project.id, {
        captions: result.normalizedSegments,
        translation: {
          ...project.translation,
          sourceLanguage: detectedSrc,
          targetLanguage: activeTarget,
          preserveProperNouns: activePreserve,
          lastTranslatedAt: new Date().toISOString(),
          externalGeminiDraftJson: rawJsonAnswer,
          validationConfig,
        },
        subtitleStyle: {
          ...project.subtitleStyle,
          useTranslated: true,
        },
        voice: {
          ...project.voice,
          targetLanguage: activeTarget,
        },
        workflow: nextWorkflow,
      });
      onProjectUpdated(saved);
      const count = result.normalizedSegments.length;
      setApplySuccessMsg(
        report.problemCount > 0
          ? `Saved ${count} translated segments in ${activeTarget}. Note: ${report.problemCount} segment(s) are flagged for duration correction above.`
          : `Approved ${count} translated segments in ${activeTarget}. Ready for Fish Audio s2.1-pro-free dubbing & FFprobe duration verification.`
      );
      if (onApprovedSuccess) {
        onApprovedSuccess(count, activeTarget);
      }
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  };

  // Determine which segments need selective audio regeneration right now
  const audioOverflowIds = (narrationReport?.problemChecks || [])
    .filter((c) => c.actualAudioDuration !== null && (c.audioOverflowSec || 0) > validationConfig.audioOverflowToleranceSec)
    .map((c) => c.segmentId);

  const selectiveRegenIds = useMemo(() => {
    if (project.voice.generatedClips.length === 0) return [];
    return Array.from(new Set([...pendingRegenIds, ...audioOverflowIds]));
  }, [project.voice.generatedClips.length, pendingRegenIds, audioOverflowIds]);

  const displayedChecks = useMemo(() => {
    if (!narrationReport) return [];
    return showAllValidatedSegments ? narrationReport.checks : narrationReport.problemChecks;
  }, [narrationReport, showAllValidatedSegments]);

  return (
    <div className="space-y-3.5">
      {/* Workflow Info + Language & Rules */}
      <div className="p-3 rounded-lg bg-[#18181D] border border-violet-500/25 space-y-2.5">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-xs font-semibold text-white flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-violet-400" />
              External Gemini Workflow (Free)
            </div>
            <p className="text-[11px] text-zinc-400 mt-0.5">
              Copy prompt → paste Gemini JSON → validate pacing → apply to project.
            </p>
          </div>
          <span className="text-[10px] font-mono text-violet-300 shrink-0">
            {promptStats.segmentAnchorCount > 0
              ? `${promptStats.segmentAnchorCount} segments`
              : 'Full video'}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <div>
            <label className="text-[11px] text-zinc-400">Target Language</label>
            <select
              value={activeTarget}
              onChange={(e) => handleTargetChange(e.target.value as SupportedLanguage)}
              className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded-md px-2.5 py-1.5 text-xs text-zinc-100"
            >
              {allowedTargetLanguages.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-end pb-1">
            <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={activePreserve}
                onChange={(e) => handlePreserveChange(e.target.checked)}
                className="accent-violet-500"
              />
              Preserve names, locations &amp; story facts
            </label>
          </div>
        </div>
      </div>

      {/* Expandable Step 1: Generated Gemini Prompt */}
      <div className="rounded-lg bg-[#18181D] border border-white/[0.08] overflow-hidden">
        <div
          onClick={() => setPromptExpanded((v) => !v)}
          className="px-3 py-2.5 flex items-center justify-between gap-2 cursor-pointer hover:bg-white/[0.02]"
        >
          <span className="text-xs font-medium text-zinc-200 flex items-center gap-1.5">
            {promptExpanded ? (
              <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
            )}
            Step 1: Video Analysis &amp; Localization Prompt
          </span>
          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => handleGeneratePrompt()}
              className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-[11px] font-medium text-zinc-200 flex items-center gap-1 cursor-pointer"
            >
              <RefreshCw className="w-3 h-3 text-violet-400" />
              Generate Prompt
            </button>
          </div>
        </div>

        {promptExpanded && (
          <div className="px-3 pb-3 space-y-2 border-t border-white/[0.06] pt-2.5">
            <textarea
              rows={6}
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              aria-label="External Gemini Prompt"
              className="w-full bg-[#09090B] border border-white/[0.08] rounded-lg p-2.5 text-[11px] font-mono text-zinc-200 leading-relaxed resize-y focus:outline-none focus:border-violet-500"
            />

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleCopyPrompt}
                className="flex-1 py-2 px-3 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white flex items-center justify-center gap-1.5 cursor-pointer"
              >
                {copiedPrompt ? (
                  <Check className="w-3.5 h-3.5" />
                ) : (
                  <ClipboardCopy className="w-3.5 h-3.5" />
                )}
                {copiedPrompt ? 'Prompt Copied!' : 'Copy Prompt'}
              </button>

              <a
                href="https://gemini.google.com/app"
                target="_blank"
                rel="noopener noreferrer"
                className="px-3.5 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/[0.08] text-xs font-semibold text-zinc-100 flex items-center justify-center gap-1.5 whitespace-nowrap"
              >
                <ExternalLink className="w-3.5 h-3.5 text-violet-400" />
                Open Gemini
              </a>
            </div>
          </div>
        )}
      </div>

      {/* Step 2: Editable Gemini JSON Answer + VALIDATE NARRATION */}
      <div className="space-y-2 pt-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium text-zinc-200 flex items-center gap-1.5">
            <FileCode2 className="w-3.5 h-3.5 text-violet-400" />
            Step 2: Paste Gemini JSON Response
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowConfigPanel((v) => !v)}
              className="text-[11px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1 cursor-pointer"
            >
              <SlidersHorizontal className="w-3 h-3 text-violet-400" />
              Rate Bounds ({validationConfig.minWordsPerSec}–{validationConfig.maxWordsPerSec} w/s)
            </button>
            {rawJsonAnswer && (
              <button
                type="button"
                onClick={() => {
                  setRawJsonAnswer('');
                  setValidation(null);
                  setNarrationReport(null);
                  setWorkingSegments(null);
                  setFixPromptText('');
                  setSyntaxCorrectionPrompt('');
                }}
                className="text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Configurable Word-Count Screening Settings */}
        {showConfigPanel && (
          <div className="p-2.5 rounded-lg bg-[#18181D] border border-white/[0.08] grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <div>
              <label className="text-[10px] text-zinc-400">Min Words / Sec</label>
              <input
                type="number"
                step={0.1}
                min={0.8}
                max={4.0}
                value={validationConfig.minWordsPerSec}
                onChange={(e) =>
                  setValidationConfig((prev) => ({
                    ...prev,
                    minWordsPerSec: Math.max(0.8, Number(e.target.value) || 2.0),
                  }))
                }
                className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded px-2 py-1 text-xs font-mono text-zinc-100"
              />
            </div>
            <div>
              <label className="text-[10px] text-zinc-400">Max Words / Sec</label>
              <input
                type="number"
                step={0.1}
                min={1.2}
                max={5.0}
                value={validationConfig.maxWordsPerSec}
                onChange={(e) =>
                  setValidationConfig((prev) => ({
                    ...prev,
                    maxWordsPerSec: Math.max(prev.minWordsPerSec + 0.2, Number(e.target.value) || 2.8),
                  }))
                }
                className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded px-2 py-1 text-xs font-mono text-zinc-100"
              />
            </div>
            <div>
              <label className="text-[10px] text-zinc-400">FFprobe Overflow Tolerance (s)</label>
              <input
                type="number"
                step={0.05}
                min={0}
                max={2.0}
                value={validationConfig.audioOverflowToleranceSec}
                onChange={(e) =>
                  setValidationConfig((prev) => ({
                    ...prev,
                    audioOverflowToleranceSec: Math.max(0, Number(e.target.value) || 0.15),
                  }))
                }
                className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded px-2 py-1 text-xs font-mono text-zinc-100"
              />
            </div>
          </div>
        )}

        <textarea
          rows={6}
          value={rawJsonAnswer}
          onChange={(e) => {
            setRawJsonAnswer(e.target.value);
            setValidation(null);
            setNarrationReport(null);
            setApplySuccessMsg(null);
          }}
          placeholder='Paste Gemini JSON response here (e.g. {"sourceLanguage":"English","targetLanguage":"French","segments":[...]})'
          aria-label="Gemini JSON Answer"
          className="w-full bg-[#09090B] border border-white/[0.08] rounded-lg p-2.5 text-[11px] font-mono text-zinc-100 placeholder:text-zinc-600 leading-relaxed resize-y focus:outline-none focus:border-violet-500"
        />

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleValidateNarration}
            disabled={!rawJsonAnswer.trim() && project.captions.length === 0}
            className="flex-1 py-2 px-3 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            VALIDATE NARRATION
          </button>

          <button
            type="button"
            onClick={handleGenerateSyntaxCorrectionPrompt}
            disabled={!rawJsonAnswer.trim()}
            className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-xs font-medium text-zinc-200 flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer"
          >
            <Wrench className="w-3.5 h-3.5 text-amber-400" />
            Fix JSON Syntax
          </button>

          <button
            type="button"
            onClick={handleGenerateShorteningPrompt}
            disabled={project.captions.length === 0 && !(workingSegments && workingSegments.length > 0)}
            className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 border border-white/[0.08] text-xs font-medium text-zinc-200 flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5 text-violet-400" />
            Balance All Pacing
          </button>
        </div>
      </div>

      {/* JSON Structural Validation Error Banner */}
      {validation && !validation.valid && (
        <div className="p-3 rounded-lg border bg-red-500/10 border-red-500/30 text-xs text-red-200 space-y-2">
          <div className="flex items-center gap-1.5 font-semibold">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
            <span>
              JSON Structure Errors ({validation.errors.length} issue
              {validation.errors.length === 1 ? '' : 's'})
            </span>
          </div>
          <ul className="list-disc pl-4 space-y-0.5 text-[11px] text-red-200">
            {validation.errors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        </div>
      )}

      {/* JSON Syntax Correction Prompt Box */}
      {syntaxCorrectionPrompt && (
        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-amber-200">
              JSON Syntax Repair Prompt (Paste into Gemini)
            </span>
            <button
              type="button"
              onClick={handleCopySyntaxCorrection}
              className="px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 text-[11px] font-medium text-amber-100 flex items-center gap-1 cursor-pointer"
            >
              {copiedSyntaxCorrection ? (
                <Check className="w-3 h-3" />
              ) : (
                <ClipboardCopy className="w-3 h-3" />
              )}
              {copiedSyntaxCorrection ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <textarea
            rows={4}
            readOnly
            value={syntaxCorrectionPrompt}
            className="w-full bg-[#09090B] border border-white/[0.08] rounded p-2 text-[11px] font-mono text-zinc-200 resize-y"
          />
        </div>
      )}

      {/* Intelligent Narration Validation Report */}
      {narrationReport && (
        <div
          className={`p-3 rounded-lg border space-y-2.5 ${
            narrationReport.problemCount > 0
              ? 'bg-amber-500/10 border-amber-500/30'
              : 'bg-emerald-500/10 border-emerald-500/30'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-white">
              {narrationReport.problemCount > 0 ? (
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
              ) : (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              )}
              <span>{narrationReport.summaryText}</span>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono">
              <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                PASS: {narrationReport.passingCount}
              </span>
              {narrationReport.tooLongCount > 0 && (
                <span className="px-1.5 py-0.5 rounded bg-red-500/20 text-red-300">
                  TOO LONG: {narrationReport.tooLongCount}
                </span>
              )}
              {narrationReport.tooShortCount > 0 && (
                <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">
                  TOO SHORT: {narrationReport.tooShortCount}
                </span>
              )}
              {narrationReport.needsReviewCount > 0 && (
                <span className="px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300">
                  NEEDS REVIEW: {narrationReport.needsReviewCount}
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-300">
            <span>
              {narrationReport.hasMeasuredAudio
                ? 'Verified with measured audio durations.'
                : 'Estimated pacing — confirmed after dubbing.'}
            </span>
            <button
              type="button"
              onClick={() => setShowAllValidatedSegments((v) => !v)}
              className="text-[11px] text-violet-300 hover:text-violet-200 underline cursor-pointer shrink-0"
            >
              {showAllValidatedSegments
                ? `Show Problematic Only (${narrationReport.problemCount})`
                : `Inspect All ${narrationReport.totalSegments} Segments`}
            </button>
          </div>

          {displayedChecks.length > 0 && (
            <div className="max-h-[260px] overflow-y-auto space-y-2 pr-1">
              {displayedChecks.map((check) => {
                const badgeClass =
                  check.status === 'PASS'
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                    : check.status === 'TOO LONG'
                    ? 'bg-red-500/20 text-red-300 border-red-500/30'
                    : check.status === 'TOO SHORT'
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                    : 'bg-sky-500/20 text-sky-300 border-sky-500/30';

                return (
                  <div
                    key={check.segmentId}
                    className="p-2.5 rounded-md bg-[#09090B]/90 border border-white/[0.08] space-y-1.5 text-[11px]"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 font-mono">
                        <span className="text-zinc-200 font-semibold">{check.segmentId}</span>
                        <span className="text-zinc-500">
                          {check.start.toFixed(2)}s → {check.end.toFixed(2)}s (Slot:{' '}
                          {check.allocatedDuration.toFixed(2)}s)
                        </span>
                      </div>
                      <span className={`px-1.5 py-0.5 rounded border font-mono text-[10px] font-bold ${badgeClass}`}>
                        {check.status}
                      </span>
                    </div>

                    <div className="text-zinc-100 leading-snug">
                      {check.translatedText || <span className="italic text-zinc-500">(empty)</span>}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-mono text-zinc-400">
                      <span>
                        Words: {check.wordCount}w (orig {check.originalWordCount}w)
                      </span>
                      <span>
                        Rec Range: {check.minRecommendedWords}–{check.maxRecommendedWords}w
                      </span>
                      <span>Est: ~{check.estimatedDuration.toFixed(2)}s</span>
                      {check.correctionDirection !== 'NONE' && (
                        <span className="text-violet-300 font-semibold">
                          Direction: {check.correctionDirection}
                        </span>
                      )}
                      {check.actualAudioDuration !== null && (
                        <span
                          className={
                            (check.audioOverflowSec || 0) > validationConfig.audioOverflowToleranceSec
                              ? 'text-red-300 font-semibold'
                              : 'text-emerald-300'
                          }
                        >
                          Fish FFprobe: {check.actualAudioDuration.toFixed(2)}s
                          {check.actualSpeechDuration !== null
                            ? ` (speech ${check.actualSpeechDuration.toFixed(2)}s)`
                            : ''}
                          {check.audioOverflowSec !== null && check.audioOverflowSec > 0
                            ? ` (+${check.audioOverflowSec.toFixed(2)}s)`
                            : ''}
                        </span>
                      )}
                    </div>

                    {check.status !== 'PASS' && (
                      <div className="text-[10.5px] text-amber-300/90">{check.reason}</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Expandable FIX PROMPT — COPY THIS WHEN A CORRECTION IS NEEDED */}
      {(fixPromptText || (narrationReport && narrationReport.problemCount > 0)) && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/35 overflow-hidden">
          <div
            onClick={() => setFixPromptExpanded((v) => !v)}
            className="px-3 py-2.5 flex items-center justify-between gap-2 cursor-pointer hover:bg-amber-500/5"
          >
            <span className="text-xs font-semibold text-amber-200 flex items-center gap-1.5">
              {fixPromptExpanded ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
              Fix Prompt (Flagged Segments)
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void handleCopyFixPrompt();
              }}
              className="px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 text-[11px] font-semibold text-amber-100 flex items-center gap-1 cursor-pointer shrink-0"
            >
              {copiedFixPrompt ? (
                <Check className="w-3 h-3" />
              ) : (
                <ClipboardCopy className="w-3 h-3" />
              )}
              {copiedFixPrompt ? 'Copied!' : 'Copy Fix Prompt'}
            </button>
          </div>

          {fixPromptExpanded && (
            <div className="px-3 pb-3 pt-2 border-t border-amber-500/20 space-y-2">
              <p className="text-[11px] text-amber-200/80">
                Includes only failing segments. Paste into Gemini, then paste its reply below.
              </p>
              <textarea
                rows={7}
                readOnly
                value={fixPromptText}
                aria-label="Fix Prompt"
                className="w-full bg-[#09090B] border border-white/[0.08] rounded p-2 text-[11px] font-mono text-zinc-200 resize-y"
              />
            </div>
          )}
        </div>
      )}

      {/* Expandable Corrections from Gemini */}
      <div className="rounded-lg bg-[#18181D] border border-white/[0.08] overflow-hidden">
        <div
          onClick={() => setCorrectionsExpanded((v) => !v)}
          className="px-3 py-2.5 flex items-center justify-between gap-2 cursor-pointer hover:bg-white/[0.02]"
        >
          <span className="text-xs font-semibold text-zinc-100 flex items-center gap-1.5">
            {correctionsExpanded ? (
              <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
            )}
            Corrections from Gemini (Optional)
          </span>
          <span className="text-[10px] font-mono text-zinc-400">
            Patch by segment ID
          </span>
        </div>

        {correctionsExpanded && (
          <div className="px-3 pb-3 pt-2 border-t border-white/[0.06] space-y-2.5">
            <textarea
              rows={5}
              value={partialCorrectionsInput}
              onChange={(e) => {
                setPartialCorrectionsInput(e.target.value);
                setCorrectionError(null);
                setRejectedCorrections([]);
              }}
              placeholder="Paste Gemini's corrected segments here..."
              aria-label="Corrections from Gemini"
              className="w-full bg-[#09090B] border border-white/[0.08] rounded-lg p-2.5 text-[11px] font-mono text-zinc-100 placeholder:text-zinc-600 resize-y focus:outline-none focus:border-violet-500"
            />

            {correctionError && (
              <div className="p-2 rounded bg-red-500/10 border border-red-500/30 text-[11px] text-red-200 flex items-start gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                <span>{correctionError}</span>
              </div>
            )}

            {rejectedCorrections.length > 0 && (
              <div className="p-2.5 rounded bg-red-500/10 border border-red-500/30 space-y-1.5">
                <div className="text-[11px] font-semibold text-red-200 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                  INVALID Corrections Rejected (Not Applied)
                </div>
                <ul className="space-y-1">
                  {rejectedCorrections.map((rej) => (
                    <li
                      key={rej.segmentId}
                      className="text-[11px] text-red-100/90 bg-[#09090B]/70 border border-red-500/20 rounded px-2 py-1.5"
                    >
                      <span className="font-mono font-semibold text-red-300 mr-1.5">
                        {rej.segmentId}
                      </span>
                      <span className="inline-block px-1.5 py-0.5 rounded bg-red-500/25 text-red-200 font-semibold text-[10px] mr-1.5">
                        {rej.status}
                      </span>
                      <span>{rej.reasons.join(' ')}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <button
              type="button"
              onClick={handleApplyPartialCorrections}
              disabled={!partialCorrectionsInput.trim() || applyingCorrections}
              className="w-full py-2 px-3 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center justify-center gap-1.5 cursor-pointer"
            >
              {applyingCorrections ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="w-3.5 h-3.5" />
              )}
              {applyingCorrections ? 'Applying Partial Corrections...' : 'APPLY CORRECTIONS'}
            </button>
          </div>
        )}
      </div>

      {/* Selective Fish Audio Regeneration for Corrected / Overflowing Segments */}
      {selectiveRegenIds.length > 0 && (
        <div className="p-3 rounded-lg bg-violet-500/10 border border-violet-500/35 space-y-2">
          <div className="flex items-center justify-between gap-2 text-xs font-semibold text-violet-200">
            <span className="flex items-center gap-1.5">
              <Mic className="w-3.5 h-3.5 text-violet-400" />
              Selective Fish Audio Regeneration Ready
            </span>
            <span className="text-[10px] font-mono text-violet-300">
              {selectiveRegenIds.length} segment(s) · 1.0x fixed voice
            </span>
          </div>
          <p className="text-[11px] text-zinc-300 leading-relaxed">
            Passing MP3 clips remain untouched. Only {selectiveRegenIds.join(', ')} will be
            re-synthesized via Fish Audio (<code className="font-mono">s2.1-pro-free</code>) and
            verified via FFprobe.
          </p>
          <button
            type="button"
            onClick={() => void handleRegenerateAffectedAudio(selectiveRegenIds)}
            disabled={regeneratingAudio}
            className="w-full py-2 px-3 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center justify-center gap-1.5 cursor-pointer"
          >
            {regeneratingAudio ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            {regeneratingAudio
              ? `Regenerating ${selectiveRegenIds.length} Clip(s) & Measuring FFprobe...`
              : `Regenerate Audio for Corrected Segments Only (${selectiveRegenIds.length})`}
          </button>
        </div>
      )}

      {/* Expandable Correction History */}
      {correctionHistory.length > 0 && (
        <div className="rounded-lg bg-[#18181D] border border-white/[0.08] overflow-hidden">
          <div
            onClick={() => setHistoryExpanded((v) => !v)}
            className="px-3 py-2 flex items-center justify-between gap-2 cursor-pointer hover:bg-white/[0.02]"
          >
            <span className="text-xs font-medium text-zinc-200 flex items-center gap-1.5">
              {historyExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
              )}
              <History className="w-3.5 h-3.5 text-violet-400" />
              Correction History ({correctionHistory.length})
            </span>
            <span className="text-[10px] font-mono text-zinc-500">Audit Log</span>
          </div>

          {historyExpanded && (
            <div className="px-3 pb-3 pt-2 border-t border-white/[0.06] max-h-56 overflow-y-auto space-y-2">
              {correctionHistory.map((entry) => (
                <div
                  key={entry.id}
                  className="p-2 rounded bg-[#09090B] border border-white/[0.06] text-[11px] space-y-1"
                >
                  <div className="flex items-center justify-between gap-2 text-[10px] font-mono text-zinc-400">
                    <span className="text-violet-300">{entry.source}</span>
                    <span>{new Date(entry.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <div className="text-zinc-200 font-medium">{entry.note}</div>
                  {entry.updatedSegmentIds.map((segId) => (
                    <div key={segId} className="text-[10px] pl-2 border-l border-violet-500/40 space-y-0.5">
                      <div className="font-mono text-zinc-400">{segId}</div>
                      <div className="text-red-300/80 line-through">
                        {entry.beforeSnapshot[segId] || '(empty)'}
                      </div>
                      <div className="text-emerald-300">{entry.afterSnapshot[segId]}</div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {applyError && (
        <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <span>{applyError}</span>
        </div>
      )}

      {applySuccessMsg && (
        <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-200 flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <span>{applySuccessMsg}</span>
        </div>
      )}

      {/* Step 3: Approve & Apply to Project (Connects to Fish Audio & FFmpeg Export) */}
      <button
        type="button"
        onClick={handleApproveAndApply}
        disabled={!validation?.valid || applying}
        className="w-full py-2.5 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center justify-center gap-2 cursor-pointer"
      >
        <CheckCircle2 className="w-4 h-4" />
        {applying
          ? 'Saving Approved Segments...'
          : 'Approve & Apply Translated Segments to Dubbing'}
      </button>
    </div>
  );
}
