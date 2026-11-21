import React, { useRef, useState } from 'react';
import {
  AlertCircle,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Move,
  Trash2,
  Unlock,
  UploadCloud,
} from 'lucide-react';
import {
  LogoMotionConfig,
  LogoMotionPattern,
  LogoOverlay,
  Project,
  ProjectPatchFn,
  ProjectPatchOptions,
} from '../../types/studio';
import { api } from '../../lib/api';
import { createWorkflowUpdate } from '../../lib/workflowStages';
import { LOCKED_LAYER_MESSAGE } from '../../lib/layerLock';
import { CollapsibleSection } from '../ui/CollapsibleSection';
import { StudioToolMemory } from './toolMemory';

interface OverlayToolSheetProps {
  project: Project;
  onProjectUpdated: (p: Project) => void;
  onPatchProject: ProjectPatchFn;
  selectedLogoId: string | null;
  onSelectLogo: (id: string | null) => void;
  onShowNotice?: (msg: string) => void;
  memory: StudioToolMemory;
  onUpdateMemory: (patch: Partial<StudioToolMemory>) => void;
}

const DEFAULT_MOTION: LogoMotionConfig = {
  enabled: false,
  pattern: 'bounce',
  speed: 1.0,
  endX: 0.78,
  endY: 0.8,
};

export function OverlayToolSheet({
  project,
  onProjectUpdated,
  onPatchProject,
  selectedLogoId,
  onSelectLogo,
  onShowNotice,
  memory,
  onUpdateMemory,
}: OverlayToolSheetProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const duration = project.metadata?.duration || 30;
  const selectedLogo =
    project.logos.find((l) => l.id === selectedLogoId) || project.logos[0] || null;
  const motion = selectedLogo?.motion || DEFAULT_MOTION;

  const notifyLocked = () => {
    setErrorMsg(LOCKED_LAYER_MESSAGE);
    onShowNotice?.(LOCKED_LAYER_MESSAGE);
  };

  const handleUploadLogo = async (file: File) => {
    setErrorMsg(null);
    setBusy(true);
    try {
      const res = await api.uploadLogo(project.id, file);
      onProjectUpdated(res.project);
      const added = res.project.logos[res.project.logos.length - 1];
      if (added) onSelectLogo(added.id);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const updateLogo = (id: string, patch: Partial<LogoOverlay>, opts?: ProjectPatchOptions) => {
    const patchKeys = Object.keys(patch);
    const isLockOrVisOnly =
      patchKeys.length > 0 && patchKeys.every((k) => k === 'locked' || k === 'enabled');
    if (!isLockOrVisOnly) {
      const target = project.logos.find((l) => l.id === id);
      if (target?.locked) {
        notifyLocked();
        return;
      }
    }
    if (errorMsg === LOCKED_LAYER_MESSAGE) setErrorMsg(null);
    onPatchProject(
      project.id,
      (cur) => ({
        logos: cur.logos.map((l) => (l.id === id ? { ...l, ...patch } : l)),
        workflow: createWorkflowUpdate(cur.workflow, {
          completeStage: 'editor',
          modifiedStage: 'editor',
          hasExistingExport: Boolean(cur.lastExportUrl),
        }),
      }),
      opts ?? { immediate: true }
    );
  };

  const updateLogoMotion = (
    logo: LogoOverlay,
    patch: Partial<LogoMotionConfig>,
    opts?: ProjectPatchOptions
  ) => {
    updateLogo(logo.id, { motion: { ...(logo.motion || DEFAULT_MOTION), ...patch } }, opts);
  };

  const applyPreset = (logo: LogoOverlay, preset: LogoOverlay['presetPosition']) => {
    if (logo.locked) {
      notifyLocked();
      return;
    }
    const wNorm = logo.widthPct / 100;
    const coords: Record<LogoOverlay['presetPosition'], { x: number; y: number }> = {
      'top-left': { x: 0.04, y: 0.05 },
      'top-right': { x: Math.max(0.05, 0.96 - wNorm), y: 0.05 },
      'bottom-left': { x: 0.04, y: 0.82 },
      'bottom-right': { x: Math.max(0.05, 0.96 - wNorm), y: 0.82 },
      center: { x: Math.max(0.05, (1 - wNorm) / 2), y: 0.42 },
      custom: { x: logo.x, y: logo.y },
    };
    updateLogo(logo.id, {
      presetPosition: preset,
      x: Number(coords[preset].x.toFixed(3)),
      y: Number(coords[preset].y.toFixed(3)),
    });
  };

  const removeLogo = (id: string) => {
    const target = project.logos.find((l) => l.id === id);
    if (target?.locked) {
      notifyLocked();
      return;
    }
    const remaining = project.logos.filter((l) => l.id !== id);
    onPatchProject(
      project.id,
      (cur) => ({
        logos: cur.logos.filter((l) => l.id !== id),
        workflow: createWorkflowUpdate(cur.workflow, {
          completeStage: 'editor',
          modifiedStage: 'editor',
          hasExistingExport: Boolean(cur.lastExportUrl),
        }),
      }),
      { immediate: true }
    );
    if (selectedLogoId === id) {
      onSelectLogo(remaining[0]?.id || null);
    }
  };

  return (
    <div className="space-y-3">
      {errorMsg && (
        <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <span>{errorMsg}</span>
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept=".png,.svg,image/png,image/svg+xml"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleUploadLogo(f);
          e.target.value = '';
        }}
      />

      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        className="min-h-[42px] w-full py-2.5 px-4 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center justify-center gap-2 cursor-pointer"
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />}
        {busy ? 'Uploading Overlay...' : 'Add PNG / SVG Logo or Watermark'}
      </button>

      {project.logos.length > 0 && (
        <div className="space-y-1.5">
          {project.logos.map((logo) => (
            <div
              key={logo.id}
              onClick={() => onSelectLogo(logo.id)}
              className={`px-3 py-2 rounded-xl border flex items-center justify-between gap-2 cursor-pointer text-xs ${
                selectedLogo?.id === logo.id
                  ? 'bg-violet-600/15 border-violet-500/60 text-white'
                  : 'bg-[#18181D] border-white/[0.06] text-zinc-300'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <img
                  src={logo.url}
                  alt={logo.filename}
                  className="w-7 h-7 object-contain bg-zinc-900 rounded p-0.5 shrink-0"
                />
                <span className="truncate font-medium">{logo.filename}</span>
                {logo.motion?.enabled && (
                  <span className="text-[10px] font-mono text-violet-300 shrink-0">
                    {logo.motion.pattern}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-0.5 shrink-0">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void updateLogo(logo.id, { locked: !logo.locked });
                  }}
                  className={`min-w-[32px] min-h-[32px] flex items-center justify-center rounded-lg hover:bg-white/[0.06] cursor-pointer ${
                    logo.locked ? 'text-amber-400' : 'text-zinc-500 hover:text-zinc-200'
                  }`}
                >
                  {logo.locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void updateLogo(logo.id, { enabled: !logo.enabled });
                  }}
                  className="min-w-[32px] min-h-[32px] flex items-center justify-center rounded-lg hover:bg-white/[0.06] text-zinc-400 hover:text-white cursor-pointer"
                >
                  {logo.enabled ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeLogo(logo.id);
                  }}
                  className="min-w-[32px] min-h-[32px] flex items-center justify-center rounded-lg hover:bg-white/[0.06] text-zinc-500 hover:text-red-400 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {selectedLogo && (
        <div className="space-y-3">
          {selectedLogo.locked && (
            <div className="px-3 py-2 rounded-xl bg-amber-500/12 border border-amber-500/35 text-xs text-amber-200 flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 min-w-0">
                <Lock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span className="truncate">Layer locked — editing blocked</span>
              </span>
              <button
                type="button"
                onClick={() => updateLogo(selectedLogo.id, { locked: false })}
                className="min-h-[28px] px-2.5 py-0.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 text-[11px] font-semibold text-amber-100 shrink-0 cursor-pointer"
              >
                Unlock
              </button>
            </div>
          )}
          <div className="p-3 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-3">
            <div className="grid grid-cols-3 min-[360px]:grid-cols-5 gap-1.5">
              {(
                [
                  ['top-left', 'Top L'],
                  ['top-right', 'Top R'],
                  ['center', 'Center'],
                  ['bottom-left', 'Bot L'],
                  ['bottom-right', 'Bot R'],
                ] as Array<[LogoOverlay['presetPosition'], string]>
              ).map(([preset, label]) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => void applyPreset(selectedLogo, preset)}
                  className={`min-h-[34px] px-1.5 py-1 rounded-lg text-[11px] font-medium cursor-pointer ${
                    selectedLogo.presetPosition === preset
                      ? 'bg-violet-600 text-white'
                      : 'bg-zinc-900 text-zinc-300 hover:bg-zinc-800'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <div className="flex justify-between text-[11px] text-zinc-300">
                  <span>Size (Width)</span>
                  <span className="font-mono tabular-nums">{selectedLogo.widthPct}%</span>
                </div>
                <input
                  type="range"
                  min={4}
                  max={55}
                  value={selectedLogo.widthPct}
                  onChange={(e) =>
                    updateLogo(
                      selectedLogo.id,
                      { widthPct: Number(e.target.value) },
                      { undoGroupKey: `logo:${selectedLogo.id}:width`, debounceMs: 220 }
                    )
                  }
                  className="mt-1 w-full accent-violet-500"
                />
              </div>

              <div>
                <div className="flex justify-between text-[11px] text-zinc-300">
                  <span>Opacity</span>
                  <span className="font-mono tabular-nums">
                    {Math.round(selectedLogo.opacity * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={selectedLogo.opacity}
                  onChange={(e) =>
                    updateLogo(
                      selectedLogo.id,
                      { opacity: Number(e.target.value) },
                      { undoGroupKey: `logo:${selectedLogo.id}:opacity`, debounceMs: 220 }
                    )
                  }
                  className="mt-1 w-full accent-violet-500"
                />
              </div>
            </div>

            <label className="flex items-center justify-between text-xs text-zinc-300 cursor-pointer pt-1">
              <span>Show for Entire Video (Permanent)</span>
              <input
                type="checkbox"
                checked={selectedLogo.permanent}
                onChange={(e) => void updateLogo(selectedLogo.id, { permanent: e.target.checked })}
                className="accent-violet-500"
              />
            </label>

            {!selectedLogo.permanent && (
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="text-[10.5px] text-zinc-400">Start Time (s)</label>
                  <input
                    type="number"
                    min={0}
                    max={duration}
                    step={0.1}
                    value={selectedLogo.startTime}
                    onChange={(e) =>
                      void updateLogo(selectedLogo.id, { startTime: Number(e.target.value) })
                    }
                    className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded px-2 py-1 text-xs font-mono text-zinc-100"
                  />
                </div>
                <div>
                  <label className="text-[10.5px] text-zinc-400">End Time (s)</label>
                  <input
                    type="number"
                    min={0}
                    max={duration}
                    step={0.1}
                    value={selectedLogo.endTime}
                    onChange={(e) =>
                      void updateLogo(selectedLogo.id, { endTime: Number(e.target.value) })
                    }
                    className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded px-2 py-1 text-xs font-mono text-zinc-100"
                  />
                </div>
              </div>
            )}
          </div>

          <CollapsibleSection
            title="Advanced Settings"
            subtitle="Rotation & animated anti-crop logo motion"
            badge={motion.enabled ? motion.pattern : undefined}
            open={memory.overlayAdvancedOpen}
            onToggle={(open) => onUpdateMemory({ overlayAdvancedOpen: open })}
          >
            <div>
              <div className="flex justify-between text-[11px] text-zinc-300">
                <span>Rotation Angle</span>
                <span className="font-mono tabular-nums">{Math.round(selectedLogo.rotation ?? 0)}°</span>
              </div>
              <input
                type="range"
                min={-180}
                max={180}
                value={selectedLogo.rotation ?? 0}
                onChange={(e) =>
                  updateLogo(
                    selectedLogo.id,
                    { rotation: Number(e.target.value) },
                    { undoGroupKey: `logo:${selectedLogo.id}:rot`, debounceMs: 220 }
                  )
                }
                className="mt-1 w-full accent-violet-500"
              />
            </div>

            <div className="pt-2 border-t border-white/[0.06] space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
                  <Move className="w-3.5 h-3.5 text-violet-400" />
                  Animated Logo Motion
                </span>
                <label className="flex items-center gap-1.5 text-xs text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={motion.enabled}
                    onChange={(e) =>
                      updateLogoMotion(selectedLogo, {
                        enabled: e.target.checked,
                        pattern:
                          e.target.checked && motion.pattern === 'static' ? 'bounce' : motion.pattern,
                      })
                    }
                    className="accent-violet-500"
                  />
                  Enable
                </label>
              </div>

              {motion.enabled && (
                <div className="space-y-2.5">
                  <select
                    value={motion.pattern}
                    onChange={(e) =>
                      updateLogoMotion(selectedLogo, {
                        pattern: e.target.value as LogoMotionPattern,
                      })
                    }
                    className="w-full bg-zinc-900 border border-white/[0.08] rounded-md px-2.5 py-1.5 text-xs text-zinc-100"
                  >
                    <option value="bounce">Bounce Across Frame</option>
                    <option value="horizontal">Horizontal Patrol</option>
                    <option value="orbit">Circular Orbit Drift</option>
                    <option value="custom">Custom Glide (Start → Target)</option>
                  </select>

                  <div>
                    <div className="flex justify-between text-[11px] text-zinc-400">
                      <span>Motion Speed</span>
                      <span className="font-mono tabular-nums">{motion.speed.toFixed(1)}x</span>
                    </div>
                    <input
                      type="range"
                      min={0.2}
                      max={3.0}
                      step={0.1}
                      value={motion.speed}
                      onChange={(e) =>
                        updateLogoMotion(
                          selectedLogo,
                          { speed: Number(e.target.value) },
                          { undoGroupKey: `logo:${selectedLogo.id}:speed`, debounceMs: 220 }
                        )
                      }
                      className="mt-1 w-full accent-violet-500"
                    />
                  </div>

                  {motion.pattern === 'custom' && (
                    <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
                      <div>
                        <span className="text-zinc-400">Target X</span>
                        <input
                          type="number"
                          min={0}
                          max={0.92}
                          step={0.05}
                          value={motion.endX ?? 0.78}
                          onChange={(e) =>
                            void updateLogoMotion(selectedLogo, { endX: Number(e.target.value) })
                          }
                          className="mt-0.5 w-full bg-zinc-900 border border-white/[0.08] rounded px-2 py-1 text-zinc-200"
                        />
                      </div>
                      <div>
                        <span className="text-zinc-400">Target Y</span>
                        <input
                          type="number"
                          min={0}
                          max={0.92}
                          step={0.05}
                          value={motion.endY ?? 0.8}
                          onChange={(e) =>
                            void updateLogoMotion(selectedLogo, { endY: Number(e.target.value) })
                          }
                          className="mt-0.5 w-full bg-zinc-900 border border-white/[0.08] rounded px-2 py-1 text-zinc-200"
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </CollapsibleSection>
        </div>
      )}
    </div>
  );
}
