import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Film,
  Layers,
  Loader2,
  PauseCircle,
  Sparkles,
} from 'lucide-react';
import { Project, SyncMode } from '../types/studio';
import { api } from '../lib/api';
import { formatTimecode } from '../lib/formatters';

interface TimelineSyncCardProps {
  project: Project;
  onProjectUpdated: (p: Project) => void;
  onSeek?: (time: number) => void;
  compact?: boolean;
}

export function TimelineSyncCard({
  project,
  onProjectUpdated,
  onSeek,
  compact = false,
}: TimelineSyncCardProps) {
  const voice = project.voice;
  const syncMode: SyncMode = voice.syncMode || 'flexible';
  const syncPlan = voice.syncPlan;

  const savedPauseMs = voice.continuousPauseMs ?? syncPlan?.pauseDurationMs ?? 320;
  const [pauseMs, setPauseMs] = useState<number>(savedPauseMs);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  useEffect(() => {
    setPauseMs(savedPauseMs);
  }, [savedPauseMs]);

  const originalDuration =
    syncPlan?.originalVideoDuration ?? project.metadata?.duration ?? 0;
  const estimatedFinalDuration =
    syncPlan?.estimatedFinalDuration ?? originalDuration;
  const totalSpeechDuration =
    syncPlan?.totalSpeechDuration ??
    (voice.generatedClips || []).reduce(
      (sum, c) => sum + (c.speechDuration ?? c.duration),
      0
    );
  const totalAudioTrackDuration =
    syncPlan?.totalAudioTrackDuration ?? estimatedFinalDuration;
  const conflictCount = syncPlan?.conflictCount ?? 0;
  const visualMismatchCount = syncPlan?.visualMismatchCount ?? 0;
  const holds = syncPlan?.holds ?? [];
  const warnings = syncPlan?.warnings ?? [];
  const gapDiagnostics = syncPlan?.gapDiagnostics ?? [];
  const narrationAudit = syncPlan?.narrationAudit;

  const applySyncSettings = async (nextMode: SyncMode, nextPauseMs: number) => {
    if (switching) return;
    setSwitchError(null);
    setSwitching(true);
    try {
      const res = await api.resyncFishDub(project.id, nextMode, nextPauseMs);
      onProjectUpdated(res.project);
    } catch (err) {
      setSwitchError(err instanceof Error ? err.message : String(err));
    } finally {
      setSwitching(false);
    }
  };

  const handleSelectMode = async (nextMode: SyncMode) => {
    if (nextMode === syncMode && pauseMs === savedPauseMs) return;
    await applySyncSettings(nextMode, pauseMs);
  };

  const handleApplyPause = async () => {
    if (pauseMs === savedPauseMs) return;
    await applySyncSettings(syncMode, pauseMs);
  };

  const longGapCount = gapDiagnostics.filter((d) => d.isUnnecessarilyLongGap).length;

  return (
    <div className="p-4 rounded-xl bg-[#111115] border border-white/[0.08] space-y-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-violet-400" />
          <h2 className="text-sm font-display font-semibold text-white">
            Continuous Narration &amp; Timeline Synchronization
          </h2>
        </div>

        <span className="text-[11px] font-mono text-zinc-400 flex items-center gap-1.5">
          {switching && <Loader2 className="w-3 h-3 animate-spin text-violet-400" />}
          1.00x Constant Voice
        </span>
      </div>

      {/* 3 Synchronization Modes */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <button
          type="button"
          onClick={() => void handleSelectMode('continuous')}
          disabled={switching}
          className={`text-left p-2.5 rounded-lg border transition-colors cursor-pointer ${
            syncMode === 'continuous'
              ? 'bg-sky-600/20 border-sky-500/60 text-white'
              : 'bg-[#18181D] border-white/[0.06] text-zinc-300 hover:border-white/20'
          }`}
        >
          <div className="flex items-center justify-between gap-1">
            <span className="text-xs font-semibold flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-sky-400" />
              Continuous Narration
            </span>
            <span className="text-[9px] font-mono px-1 py-0.2 rounded bg-sky-500/20 text-sky-300">
              No Gaps
            </span>
          </div>
          <p className="text-[10px] text-zinc-400 mt-1 leading-relaxed">
            Places every segment immediately after previous speech with a {pauseMs}ms natural pause.
          </p>
        </button>

        <button
          type="button"
          onClick={() => void handleSelectMode('flexible')}
          disabled={switching}
          className={`text-left p-2.5 rounded-lg border transition-colors cursor-pointer ${
            syncMode === 'flexible'
              ? 'bg-violet-600/20 border-violet-500/60 text-white'
              : 'bg-[#18181D] border-white/[0.06] text-zinc-300 hover:border-white/20'
          }`}
        >
          <div className="flex items-center justify-between gap-1">
            <span className="text-xs font-semibold flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-violet-400" />
              Smart Gap Removal
            </span>
            <span className="text-[9px] font-mono px-1 py-0.2 rounded bg-violet-500/20 text-violet-300">
              Balanced
            </span>
          </div>
          <p className="text-[10px] text-zinc-400 mt-1 leading-relaxed">
            Collapses long dead silences and adds shot frame-holds only if narration overflows.
          </p>
        </button>

        <button
          type="button"
          onClick={() => void handleSelectMode('original')}
          disabled={switching}
          className={`text-left p-2.5 rounded-lg border transition-colors cursor-pointer ${
            syncMode === 'original'
              ? 'bg-violet-600/20 border-violet-500/60 text-white'
              : 'bg-[#18181D] border-white/[0.06] text-zinc-300 hover:border-white/20'
          }`}
        >
          <div className="flex items-center justify-between gap-1">
            <span className="text-xs font-semibold flex items-center gap-1.5">
              <Film className="w-3.5 h-3.5 text-zinc-300" />
              Original Scene Timing
            </span>
            <span className="text-[9px] font-mono px-1 py-0.2 rounded bg-zinc-800 text-zinc-300">
              Scene Lock
            </span>
          </div>
          <p className="text-[10px] text-zinc-400 mt-1 leading-relaxed">
            Locks narration strictly to original video timestamps; warns if speech exceeds window.
          </p>
        </button>
      </div>

      {/* Configurable Natural Pause Duration (250-450ms recommended) */}
      {syncMode !== 'original' && (
        <div className="p-2.5 rounded-lg bg-[#18181D] border border-white/[0.06] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex-1 space-y-1">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-zinc-300 font-medium">
                Natural Pause Between Narration Lines
              </span>
              <span className="font-mono text-sky-300 tabular-nums font-semibold">
                {pauseMs} ms ({(pauseMs / 1000).toFixed(2)}s)
              </span>
            </div>
            <input
              type="range"
              min={200}
              max={600}
              step={10}
              value={pauseMs}
              onChange={(e) => setPauseMs(Number(e.target.value))}
              className="w-full accent-sky-500"
            />
            <div className="flex justify-between text-[9.5px] font-mono text-zinc-500">
              <span>200ms (Fast)</span>
              <span>250–450ms Recommended</span>
              <span>600ms (Dramatic)</span>
            </div>
          </div>

          {pauseMs !== savedPauseMs && (
            <button
              type="button"
              onClick={() => void handleApplyPause()}
              disabled={switching}
              className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-xs font-semibold text-white shrink-0 cursor-pointer"
            >
              {switching ? 'Updating...' : 'Apply Pause'}
            </button>
          )}
        </div>
      )}

      {switchError && (
        <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/30 text-[11px] text-red-200">
          {switchError}
        </div>
      )}

      {/* Key Metrics: Speech Duration vs Total Audio Track Duration vs Video Duration */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <div className="p-2.5 rounded-lg bg-[#18181D] border border-white/[0.06]">
          <div className="text-[10px] text-zinc-400">Original Video</div>
          <div className="text-xs font-mono font-semibold text-zinc-100 mt-0.5 tabular-nums">
            {formatTimecode(originalDuration)}
          </div>
        </div>

        <div className="p-2.5 rounded-lg bg-[#18181D] border border-white/[0.06]">
          <div className="text-[10px] text-zinc-400">Total Speech</div>
          <div className="text-xs font-mono font-semibold text-emerald-300 mt-0.5 tabular-nums">
            {formatTimecode(totalSpeechDuration)}
          </div>
        </div>

        <div className="p-2.5 rounded-lg bg-[#18181D] border border-white/[0.06]">
          <div className="text-[10px] text-zinc-400">Audio Track</div>
          <div className="text-xs font-mono font-semibold text-sky-300 mt-0.5 tabular-nums">
            {formatTimecode(totalAudioTrackDuration)}
          </div>
        </div>

        <div className="p-2.5 rounded-lg bg-[#18181D] border border-white/[0.06]">
          <div className="text-[10px] text-zinc-400">Visual Offsets</div>
          <div
            className={`text-xs font-mono font-semibold mt-0.5 tabular-nums ${
              visualMismatchCount > 0 ? 'text-amber-300' : 'text-zinc-200'
            }`}
          >
            {visualMismatchCount}
          </div>
        </div>

        <div className="p-2.5 rounded-lg bg-[#18181D] border border-white/[0.06] col-span-2 sm:col-span-1">
          <div className="text-[10px] text-zinc-400">Sync Conflicts</div>
          <div
            className={`text-xs font-mono font-semibold mt-0.5 tabular-nums ${
              conflictCount > 0 ? 'text-amber-300' : 'text-emerald-300'
            }`}
          >
            {conflictCount}
          </div>
        </div>
      </div>

      {/* Missing Narration & Order Verification Audit */}
      {narrationAudit && !narrationAudit.isComplete && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/35 space-y-1.5">
          <div className="text-[11px] font-semibold text-red-200 flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
            Missing or Incomplete Narration Detected Before Export
          </div>
          <p className="text-[11px] text-red-200/85">{narrationAudit.summary}</p>
          <div className="flex flex-wrap gap-3 text-[10px] font-mono text-red-300">
            {narrationAudit.missingSegmentIds.length > 0 && (
              <span>Missing IDs: {narrationAudit.missingSegmentIds.join(', ')}</span>
            )}
            {narrationAudit.emptySegmentIds.length > 0 && (
              <span>Empty IDs: {narrationAudit.emptySegmentIds.join(', ')}</span>
            )}
            {narrationAudit.outOfOrderSegmentIds.length > 0 && (
              <span>Out of order: {narrationAudit.outOfOrderSegmentIds.join(', ')}</span>
            )}
          </div>
        </div>
      )}

      {/* Detailed Audio & Gap Diagnostics Panel */}
      {syncPlan && gapDiagnostics.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs pt-1">
            <span className="text-zinc-300 font-medium">
              Audio Diagnostics ({gapDiagnostics.length} segments ·{' '}
              <span className={longGapCount > 0 ? 'text-amber-300' : 'text-emerald-300'}>
                {longGapCount} long gaps &gt;1.2s
              </span>
              )
            </span>
            <button
              type="button"
              onClick={() => setShowDiagnostics((v) => !v)}
              className="text-[11px] font-medium text-violet-300 hover:text-violet-200 underline cursor-pointer"
            >
              {showDiagnostics ? 'Hide Audio Diagnostics' : 'Inspect Detailed Audio Diagnostics'}
            </button>
          </div>

          {showDiagnostics && (
            <div className="p-3 rounded-lg bg-[#18181D] border border-white/[0.08] max-h-64 overflow-y-auto space-y-2">
              {gapDiagnostics.map((diag, idx) => (
                <div
                  key={diag.segmentId}
                  onClick={() => onSeek?.(diag.finalStart)}
                  className={`p-2.5 rounded border text-[11px] space-y-1 cursor-pointer transition-colors ${
                    diag.isUnnecessarilyLongGap
                      ? 'bg-amber-500/10 border-amber-500/30 text-amber-200'
                      : diag.visualMismatch
                      ? 'bg-sky-500/10 border-sky-500/25 text-zinc-200'
                      : 'bg-black/30 border-white/[0.06] text-zinc-300 hover:bg-black/50'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 font-mono">
                    <span className="font-semibold">
                      #{idx + 1} [{diag.segmentId.slice(0, 8)}] · Orig:{' '}
                      {formatTimecode(diag.originalStart)}–{formatTimecode(diag.originalEnd)} →{' '}
                      <span className="text-sky-300">
                        Final Start: {formatTimecode(diag.finalStart)}
                      </span>
                    </span>
                    <span
                      className={`px-1.5 py-0.2 rounded text-[10px] ${
                        diag.isUnnecessarilyLongGap
                          ? 'bg-amber-500/25 text-amber-300 font-bold'
                          : 'bg-zinc-800 text-zinc-300'
                      }`}
                    >
                      Gap Before Next: {diag.gapBeforeNext.toFixed(2)}s
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-mono text-zinc-400">
                    <span>Audio: {diag.audioDuration.toFixed(2)}s</span>
                    <span>Speech: {diag.speechDuration.toFixed(2)}s</span>
                    <span>Lead Silence: {diag.leadingSilence.toFixed(2)}s</span>
                    <span>Trail Silence: {diag.trailingSilence.toFixed(2)}s</span>
                    <span>Speech Ends: {formatTimecode(diag.speechEnd)}</span>
                  </div>

                  <div className="text-[10.5px] text-zinc-300">{diag.recommendedAdjustment}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Hold Breakdown & Sync Status */}
      {!syncPlan ? (
        <div className="text-[11px] text-zinc-500">
          Generate Fish Audio MP3 dubbing to measure speech boundaries, trim edge silence safely,
          and verify continuous timeline assembly.
        </div>
      ) : (
        <>
          {holds.length > 0 && !compact && (
            <div className="p-3 rounded-lg bg-violet-950/20 border border-violet-500/30 space-y-1.5">
              <div className="text-[11px] font-semibold text-violet-200 flex items-center gap-1.5">
                <PauseCircle className="w-3.5 h-3.5 text-violet-400" />
                Visual Frame Holds Planned ({holds.length}) — Video Motion Speed Untouched
              </div>
              <div className="max-h-24 overflow-y-auto space-y-1 pr-1">
                {holds.map((hold) => (
                  <button
                    key={hold.id}
                    type="button"
                    onClick={() => onSeek?.(hold.atVideoTime)}
                    className="w-full text-left px-2 py-1 rounded bg-black/30 hover:bg-black/45 border border-violet-500/20 text-[11px] text-zinc-200 flex items-center justify-between gap-2 cursor-pointer"
                  >
                    <span className="truncate">
                      Hold +{hold.holdDuration.toFixed(2)}s at {formatTimecode(hold.atVideoTime)}
                    </span>
                    <span className="text-[10px] font-mono text-violet-300 shrink-0">
                      {hold.reason}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {warnings.length > 0 ? (
            <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 space-y-1.5">
              <div className="text-[11px] font-semibold text-amber-200 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                Synchronization &amp; Visual Cue Notices ({warnings.length})
              </div>
              <ul className="max-h-24 overflow-y-auto space-y-1 text-[11px] text-amber-200/85 list-disc pl-4">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-[11px] text-emerald-300">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              All {syncPlan.segments.length} constant-speed 1.0x narration segments verified
              {syncMode === 'continuous'
                ? ` continuously with ${pauseMs}ms natural pauses and zero dead gaps.`
                : ' cleanly with zero audio overlap.'}
            </div>
          )}
        </>
      )}
    </div>
  );
}
