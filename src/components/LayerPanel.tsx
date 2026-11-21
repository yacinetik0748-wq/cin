import React from 'react';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Eye,
  EyeOff,
  Film,
  Image as ImageIcon,
  Layers,
  Lock,
  RotateCcw,
  Sparkles,
  Trash2,
  Type,
  Unlock,
  Wand2,
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import {
  BlurEffect,
  DEFAULT_VIDEO_CANVAS,
  DEFAULT_VIDEO_EFFECTS,
  LogoOverlay,
  Project,
  StudioElementSelection,
  SubtitleStyle,
  VideoCanvasConfig,
  VideoEffectsConfig,
} from '../types/studio';
import { getEffectCatalogEntry, getFilterPresetMeta } from '../lib/videoFiltersCatalog';
import { LOCKED_LAYER_MESSAGE } from '../lib/layerLock';

interface LayerPanelProps {
  project: Project;
  selectedElement: StudioElementSelection;
  onSelectElement: (sel: StudioElementSelection) => void;
  onUpdateCanvas: (patch: Partial<VideoCanvasConfig>, opts?: { immediate?: boolean }) => void;
  onUpdateBlurs: (nextBlurs: BlurEffect[]) => void;
  onUpdateLogos: (nextLogos: LogoOverlay[]) => void;
  onUpdateSubtitleStyle: (patch: Partial<SubtitleStyle>) => void;
  onUpdateVideoEffects?: (patch: Partial<VideoEffectsConfig>) => void;
  onShowNotice?: (msg: string) => void;
}

interface LayerRow {
  token: string;
  selection: Exclude<StudioElementSelection, null>;
  label: string;
  sublabel: string;
  kind: 'video' | 'bg-image' | 'blur' | 'logo' | 'captions' | 'caption-element';
  visible: boolean;
  locked: boolean;
  opacity: number;
  rotation: number;
  canReorder: boolean;
  canDuplicate: boolean;
  canDelete: boolean;
}

export function buildOrderedLayerTokens(project: Project): string[] {
  const canvas = { ...DEFAULT_VIDEO_CANVAS, ...(project.canvas || {}) };
  const baseTokens: string[] = [];
  if (canvas.backgroundType === 'image') baseTokens.push('bg-image');
  baseTokens.push('video');
  for (const b of project.blurs) baseTokens.push(`blur:${b.id}`);
  for (const l of project.logos) baseTokens.push(`logo:${l.id}`);
  if (project.captions.length > 0 || project.subtitleStyle.enabled) {
    baseTokens.push('captions');
  }
  for (const el of project.subtitleStyle.extraElements || []) {
    baseTokens.push(`caption-element:${el.id}`);
  }

  const validSet = new Set(baseTokens);
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const tok of canvas.layerOrder || []) {
    if (validSet.has(tok) && !seen.has(tok)) {
      ordered.push(tok);
      seen.add(tok);
    }
  }
  for (const tok of baseTokens) {
    if (!seen.has(tok)) {
      ordered.push(tok);
      seen.add(tok);
    }
  }
  return ordered;
}

export function LayerPanel({
  project,
  selectedElement,
  onSelectElement,
  onUpdateCanvas,
  onUpdateBlurs,
  onUpdateLogos,
  onUpdateSubtitleStyle,
  onUpdateVideoEffects,
  onShowNotice,
}: LayerPanelProps) {
  const fxConfig = project.videoEffects || DEFAULT_VIDEO_EFFECTS;
  const filterStack = fxConfig.filterStack || [];
  const effectsList = fxConfig.effects || [];
  const canvas = { ...DEFAULT_VIDEO_CANVAS, ...(project.canvas || {}) };
  const orderedBottomToTop = buildOrderedLayerTokens(project);

  const rowMap = new Map<string, LayerRow>();
  if (canvas.backgroundType === 'image') {
    rowMap.set('bg-image', {
      token: 'bg-image',
      selection: { kind: 'bg-image' },
      label: canvas.bgImageFilename || 'Background Image',
      sublabel: 'Canvas Backdrop',
      kind: 'bg-image',
      visible: canvas.bgImageVisible !== false,
      locked: Boolean(canvas.bgImageLocked),
      opacity: canvas.bgImageOpacity ?? 1,
      rotation: canvas.bgImageRotation ?? 0,
      canReorder: false,
      canDuplicate: false,
      canDelete: false,
    });
  }

  rowMap.set('video', {
    token: 'video',
    selection: { kind: 'video' },
    label: project.sourceFilename || 'Main Video Layer',
    sublabel: `${Math.round((canvas.zoom || 1) * 100)}% zoom`,
    kind: 'video',
    visible: canvas.videoVisible !== false,
    locked: Boolean(canvas.videoLocked),
    opacity: canvas.videoOpacity ?? 1,
    rotation: canvas.videoRotation ?? 0,
    canReorder: false,
    canDuplicate: false,
    canDelete: false,
  });

  for (const b of project.blurs) {
    const linkSuffix =
      b.subtitleLink && b.subtitleLink.mode !== 'manual'
        ? ` · ${b.subtitleLink.mode}`
        : '';
    rowMap.set(`blur:${b.id}`, {
      token: `blur:${b.id}`,
      selection: { kind: 'blur', id: b.id },
      label: b.name || 'Blur Region',
      sublabel: `${b.isSubtitleMask ? 'caption mask' : b.mode} · ${b.type} ${b.radius}px${linkSuffix}`,
      kind: 'blur',
      visible: b.enabled,
      locked: Boolean(b.locked),
      opacity: b.opacity ?? 1,
      rotation: b.rotation ?? 0,
      canReorder: true,
      canDuplicate: true,
      canDelete: true,
    });
  }

  for (const l of project.logos) {
    rowMap.set(`logo:${l.id}`, {
      token: `logo:${l.id}`,
      selection: { kind: 'logo', id: l.id },
      label: l.filename || 'Brand Logo',
      sublabel: `${Math.round(l.widthPct)}% width`,
      kind: 'logo',
      visible: l.enabled,
      locked: Boolean(l.locked),
      opacity: l.opacity ?? 1,
      rotation: l.rotation ?? 0,
      canReorder: true,
      canDuplicate: true,
      canDelete: true,
    });
  }

  if (project.captions.length > 0 || project.subtitleStyle.enabled) {
    rowMap.set('captions', {
      token: 'captions',
      selection: { kind: 'captions' },
      label: 'Captions Overlay',
      sublabel: project.subtitleStyle.enabled
        ? `${project.subtitleStyle.mode} · ${project.captions.length} lines`
        : 'Preview Hidden',
      kind: 'captions',
      visible: project.subtitleStyle.enabled && project.subtitleStyle.visible !== false,
      locked: Boolean(project.subtitleStyle.locked),
      opacity: project.subtitleStyle.opacity ?? 1,
      rotation: project.subtitleStyle.rotation ?? 0,
      canReorder: true,
      canDuplicate: false,
      canDelete: false,
    });
  }

  for (const el of project.subtitleStyle.extraElements || []) {
    rowMap.set(`caption-element:${el.id}`, {
      token: `caption-element:${el.id}`,
      selection: { kind: 'caption-element', id: el.id },
      label: el.label || el.text || 'Text Element',
      sublabel: `${el.style?.fontFamily || project.subtitleStyle.fontFamily} · ${el.style?.fontSize || 32}px`,
      kind: 'caption-element',
      visible: el.visible !== false,
      locked: Boolean(el.locked),
      opacity: el.style?.opacity ?? 1,
      rotation: el.style?.rotation ?? 0,
      canReorder: true,
      canDuplicate: true,
      canDelete: true,
    });
  }

  // UI lists top-most layer first
  const rowsTopToBottom = [...orderedBottomToTop]
    .reverse()
    .map((tok) => rowMap.get(tok))
    .filter((r): r is LayerRow => Boolean(r));

  const isRowSelected = (row: LayerRow): boolean => {
    if (!selectedElement) return false;
    if (row.selection.kind !== selectedElement.kind) return false;
    if (row.selection.kind === 'blur' && selectedElement.kind === 'blur') {
      return row.selection.id === selectedElement.id;
    }
    if (row.selection.kind === 'logo' && selectedElement.kind === 'logo') {
      return row.selection.id === selectedElement.id;
    }
    if (row.selection.kind === 'caption-element' && selectedElement.kind === 'caption-element') {
      return row.selection.id === selectedElement.id;
    }
    return true;
  };

  const selectedRow = rowsTopToBottom.find(isRowSelected) || null;

  const moveOverlayOrder = (token: string, direction: 'forward' | 'backward') => {
    const row = rowMap.get(token);
    if (row?.locked) {
      onShowNotice?.(LOCKED_LAYER_MESSAGE);
      return;
    }
    const overlayOnly = orderedBottomToTop.filter((t) => t !== 'bg-image' && t !== 'video');
    const idx = overlayOnly.indexOf(token);
    if (idx === -1) return;
    const swapIdx = direction === 'forward' ? idx + 1 : idx - 1;
    if (swapIdx < 0 || swapIdx >= overlayOnly.length) return;
    const nextOverlays = [...overlayOnly];
    [nextOverlays[idx], nextOverlays[swapIdx]] = [nextOverlays[swapIdx], nextOverlays[idx]];
    const base = orderedBottomToTop.filter((t) => t === 'bg-image' || t === 'video');
    onUpdateCanvas({ layerOrder: [...base, ...nextOverlays] }, { immediate: true });
  };

  const toggleVisibility = (row: LayerRow) => {
    if (row.kind === 'video') {
      onUpdateCanvas({ videoVisible: !row.visible }, { immediate: true });
    } else if (row.kind === 'bg-image') {
      onUpdateCanvas({ bgImageVisible: !row.visible }, { immediate: true });
    } else if (row.kind === 'blur' && row.selection.kind === 'blur') {
      const id = row.selection.id;
      onUpdateBlurs(project.blurs.map((b) => (b.id === id ? { ...b, enabled: !b.enabled } : b)));
    } else if (row.kind === 'logo' && row.selection.kind === 'logo') {
      const id = row.selection.id;
      onUpdateLogos(project.logos.map((l) => (l.id === id ? { ...l, enabled: !l.enabled } : l)));
    } else if (row.kind === 'captions') {
      onUpdateSubtitleStyle({ visible: !row.visible });
    } else if (row.kind === 'caption-element' && row.selection.kind === 'caption-element') {
      const id = row.selection.id;
      const next = (project.subtitleStyle.extraElements || []).map((el) =>
        el.id === id ? { ...el, visible: !el.visible } : el
      );
      onUpdateSubtitleStyle({ extraElements: next });
    }
  };

  const toggleLock = (row: LayerRow) => {
    if (row.kind === 'video') {
      onUpdateCanvas({ videoLocked: !row.locked }, { immediate: true });
    } else if (row.kind === 'bg-image') {
      onUpdateCanvas({ bgImageLocked: !row.locked }, { immediate: true });
    } else if (row.kind === 'blur' && row.selection.kind === 'blur') {
      const id = row.selection.id;
      onUpdateBlurs(project.blurs.map((b) => (b.id === id ? { ...b, locked: !b.locked } : b)));
    } else if (row.kind === 'logo' && row.selection.kind === 'logo') {
      const id = row.selection.id;
      onUpdateLogos(project.logos.map((l) => (l.id === id ? { ...l, locked: !l.locked } : l)));
    } else if (row.kind === 'captions') {
      onUpdateSubtitleStyle({ locked: !row.locked });
    } else if (row.kind === 'caption-element' && row.selection.kind === 'caption-element') {
      const id = row.selection.id;
      const next = (project.subtitleStyle.extraElements || []).map((el) =>
        el.id === id ? { ...el, locked: !el.locked } : el
      );
      onUpdateSubtitleStyle({ extraElements: next });
    }
  };

  const duplicateLayer = (row: LayerRow) => {
    if (row.locked) {
      onShowNotice?.(LOCKED_LAYER_MESSAGE);
      return;
    }
    if (row.kind === 'blur' && row.selection.kind === 'blur') {
      const targetId = row.selection.id;
      const orig = project.blurs.find((b) => b.id === targetId);
      if (!orig) return;
      const copy: BlurEffect = {
        ...orig,
        id: uuidv4(),
        name: `${orig.name} Copy`,
        x: Math.min(0.85, orig.x + 0.04),
        y: Math.min(0.85, orig.y + 0.04),
        locked: false,
      };
      onUpdateBlurs([...project.blurs, copy]);
      onSelectElement({ kind: 'blur', id: copy.id });
    } else if (row.kind === 'logo' && row.selection.kind === 'logo') {
      const targetId = row.selection.id;
      const orig = project.logos.find((l) => l.id === targetId);
      if (!orig) return;
      const copy: LogoOverlay = {
        ...orig,
        id: uuidv4(),
        presetPosition: 'custom',
        x: Math.min(0.85, orig.x + 0.05),
        y: Math.min(0.85, orig.y + 0.05),
        locked: false,
      };
      onUpdateLogos([...project.logos, copy]);
      onSelectElement({ kind: 'logo', id: copy.id });
    } else if (row.kind === 'caption-element' && row.selection.kind === 'caption-element') {
      const targetId = row.selection.id;
      const orig = (project.subtitleStyle.extraElements || []).find((el) => el.id === targetId);
      if (!orig) return;
      const copy = {
        ...orig,
        id: uuidv4(),
        label: `${orig.label || 'Text'} Copy`,
        locked: false,
        style: {
          ...orig.style,
          posX: Math.min(90, (orig.style?.posX ?? 50) + 4),
          posY: Math.min(90, (orig.style?.posY ?? 20) + 5),
        },
      };
      onUpdateSubtitleStyle({
        extraElements: [...(project.subtitleStyle.extraElements || []), copy],
      });
      onSelectElement({ kind: 'caption-element', id: copy.id });
    }
  };

  const deleteLayer = (row: LayerRow) => {
    if (row.locked) {
      onShowNotice?.(LOCKED_LAYER_MESSAGE);
      return;
    }
    if (row.kind === 'blur' && row.selection.kind === 'blur') {
      const targetId = row.selection.id;
      const next = project.blurs.filter((b) => b.id !== targetId);
      onUpdateBlurs(next);
      onSelectElement(null);
    } else if (row.kind === 'logo' && row.selection.kind === 'logo') {
      const targetId = row.selection.id;
      const next = project.logos.filter((l) => l.id !== targetId);
      onUpdateLogos(next);
      onSelectElement(null);
    } else if (row.kind === 'caption-element' && row.selection.kind === 'caption-element') {
      const targetId = row.selection.id;
      const next = (project.subtitleStyle.extraElements || []).filter((el) => el.id !== targetId);
      onUpdateSubtitleStyle({ extraElements: next });
      onSelectElement(null);
    }
  };

  const updateSelectedOpacity = (opacity: number) => {
    if (!selectedRow) return;
    if (selectedRow.locked) {
      onShowNotice?.(LOCKED_LAYER_MESSAGE);
      return;
    }
    if (selectedRow.kind === 'video') {
      onUpdateCanvas({ videoOpacity: opacity });
    } else if (selectedRow.kind === 'bg-image') {
      onUpdateCanvas({ bgImageOpacity: opacity });
    } else if (selectedRow.kind === 'blur' && selectedRow.selection.kind === 'blur') {
      const id = selectedRow.selection.id;
      onUpdateBlurs(project.blurs.map((b) => (b.id === id ? { ...b, opacity } : b)));
    } else if (selectedRow.kind === 'logo' && selectedRow.selection.kind === 'logo') {
      const id = selectedRow.selection.id;
      onUpdateLogos(project.logos.map((l) => (l.id === id ? { ...l, opacity } : l)));
    } else if (selectedRow.kind === 'captions') {
      onUpdateSubtitleStyle({ opacity });
    } else if (
      selectedRow.kind === 'caption-element' &&
      selectedRow.selection.kind === 'caption-element'
    ) {
      const id = selectedRow.selection.id;
      onUpdateSubtitleStyle({
        extraElements: (project.subtitleStyle.extraElements || []).map((el) =>
          el.id === id ? { ...el, style: { ...el.style, opacity } } : el
        ),
      });
    }
  };

  const updateSelectedRotation = (rotation: number) => {
    if (!selectedRow) return;
    if (selectedRow.locked) {
      onShowNotice?.(LOCKED_LAYER_MESSAGE);
      return;
    }
    if (selectedRow.kind === 'video') {
      onUpdateCanvas({ videoRotation: rotation });
    } else if (selectedRow.kind === 'bg-image') {
      onUpdateCanvas({ bgImageRotation: rotation });
    } else if (selectedRow.kind === 'blur' && selectedRow.selection.kind === 'blur') {
      const id = selectedRow.selection.id;
      onUpdateBlurs(project.blurs.map((b) => (b.id === id ? { ...b, rotation } : b)));
    } else if (selectedRow.kind === 'logo' && selectedRow.selection.kind === 'logo') {
      const id = selectedRow.selection.id;
      onUpdateLogos(project.logos.map((l) => (l.id === id ? { ...l, rotation } : l)));
    } else if (selectedRow.kind === 'captions') {
      onUpdateSubtitleStyle({ rotation });
    } else if (
      selectedRow.kind === 'caption-element' &&
      selectedRow.selection.kind === 'caption-element'
    ) {
      const id = selectedRow.selection.id;
      onUpdateSubtitleStyle({
        extraElements: (project.subtitleStyle.extraElements || []).map((el) =>
          el.id === id ? { ...el, style: { ...el.style, rotation } } : el
        ),
      });
    }
  };

  const iconForKind = (kind: LayerRow['kind']) => {
    if (kind === 'video') return <Film className="w-3.5 h-3.5 text-violet-400 shrink-0" />;
    if (kind === 'bg-image') return <ImageIcon className="w-3.5 h-3.5 text-cyan-400 shrink-0" />;
    if (kind === 'blur') return <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0" />;
    if (kind === 'logo') return <Layers className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
    if (kind === 'caption-element') return <Type className="w-3.5 h-3.5 text-sky-400 shrink-0" />;
    return <Type className="w-3.5 h-3.5 text-pink-400 shrink-0" />;
  };

  return (
    <div className="space-y-3.5">
      <div className="p-3 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-white flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-violet-400" />
            Canvas Layer Stack
          </span>
          <span className="text-[11px] font-mono text-zinc-500 tabular-nums">
            {rowsTopToBottom.length} Layers
          </span>
        </div>

        <p className="text-[11px] text-zinc-400 leading-relaxed">
          Click any layer or element on the stage to move, resize, rotate, lock, or reorder depth.
          Use <span className="font-mono text-zinc-300">Ctrl/Cmd+Z</span> to undo.
        </p>

        <div className="space-y-1.5 max-h-[290px] overflow-y-auto pr-0.5">
          {rowsTopToBottom.map((row) => {
            const active = isRowSelected(row);
            return (
              <div
                key={row.token}
                onClick={() => onSelectElement(row.selection)}
                className={`px-2.5 py-2 rounded-lg border flex flex-wrap sm:flex-nowrap items-center justify-between gap-2 cursor-pointer transition-colors text-xs ${
                  active
                    ? 'bg-violet-600/18 border-violet-500/70 text-white'
                    : 'bg-zinc-900/70 border-white/[0.06] text-zinc-300 hover:border-white/[0.16]'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  {iconForKind(row.kind)}
                  <div className="min-w-0">
                    <div className="font-medium truncate">{row.label}</div>
                    <div className="text-[10px] text-zinc-500 font-mono truncate">
                      {row.sublabel}
                    </div>
                  </div>
                </div>

                <div
                  className="flex items-center gap-0.5 shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  {row.canReorder && (
                    <>
                      <button
                        type="button"
                        onClick={() => moveOverlayOrder(row.token, 'forward')}
                        title={row.locked ? LOCKED_LAYER_MESSAGE : 'Bring Forward'}
                        aria-disabled={row.locked}
                        className={`min-w-[36px] min-h-[36px] lg:min-w-[30px] lg:min-h-[30px] flex items-center justify-center rounded hover:bg-white/[0.06] cursor-pointer ${
                          row.locked ? 'text-zinc-600 opacity-50' : 'text-zinc-400 hover:text-white'
                        }`}
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveOverlayOrder(row.token, 'backward')}
                        title={row.locked ? LOCKED_LAYER_MESSAGE : 'Send Backward'}
                        aria-disabled={row.locked}
                        className={`min-w-[36px] min-h-[36px] lg:min-w-[30px] lg:min-h-[30px] flex items-center justify-center rounded hover:bg-white/[0.06] cursor-pointer ${
                          row.locked ? 'text-zinc-600 opacity-50' : 'text-zinc-400 hover:text-white'
                        }`}
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => toggleVisibility(row)}
                    title={row.visible ? 'Hide layer' : 'Show layer'}
                    className={`min-w-[36px] min-h-[36px] lg:min-w-[30px] lg:min-h-[30px] flex items-center justify-center rounded hover:bg-white/[0.06] cursor-pointer ${
                      row.visible ? 'text-zinc-300 hover:text-white' : 'text-zinc-600'
                    }`}
                  >
                    {row.visible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleLock(row)}
                    title={row.locked ? 'Unlock layer' : 'Lock layer'}
                    className={`min-w-[36px] min-h-[36px] lg:min-w-[30px] lg:min-h-[30px] flex items-center justify-center rounded hover:bg-white/[0.06] cursor-pointer ${
                      row.locked ? 'text-amber-400' : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    {row.locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                  </button>
                  {row.canDuplicate && (
                    <button
                      type="button"
                      onClick={() => duplicateLayer(row)}
                      title="Duplicate layer (Ctrl/Cmd+D)"
                      className="min-w-[36px] min-h-[36px] lg:min-w-[30px] lg:min-h-[30px] flex items-center justify-center text-zinc-400 hover:text-white rounded hover:bg-white/[0.06] cursor-pointer"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {row.canDelete && (
                    <button
                      type="button"
                      onClick={() => deleteLayer(row)}
                      title="Delete layer"
                      className="min-w-[36px] min-h-[36px] lg:min-w-[30px] lg:min-h-[30px] flex items-center justify-center text-zinc-500 hover:text-red-400 rounded hover:bg-white/[0.06] cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Selected Element Precision Transform Panel */}
      {selectedRow && (
        <div className="p-3.5 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-3">
          <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] pb-2">
            <div className="flex items-center gap-2 min-w-0">
              {iconForKind(selectedRow.kind)}
              <span className="text-xs font-semibold text-white truncate">
                {selectedRow.label}
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                if (selectedRow.locked) {
                  onShowNotice?.(LOCKED_LAYER_MESSAGE);
                  return;
                }
                updateSelectedRotation(0);
                updateSelectedOpacity(1);
              }}
              aria-disabled={selectedRow.locked}
              title={selectedRow.locked ? LOCKED_LAYER_MESSAGE : 'Reset Transform'}
              className={`text-[11px] flex items-center gap-1 cursor-pointer shrink-0 ${
                selectedRow.locked
                  ? 'text-amber-400/75 opacity-60'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <RotateCcw className="w-3 h-3" />
              Reset Transform
            </button>
          </div>

          {selectedRow.locked && (
            <div className="px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-400/30 flex items-center justify-between gap-2 text-[11px] text-amber-200">
              <span className="flex items-center gap-1.5">
                <Lock className="w-3 h-3 text-amber-300 shrink-0" />
                {LOCKED_LAYER_MESSAGE}
              </span>
              <button
                type="button"
                onClick={() => toggleLock(selectedRow)}
                className="px-2 py-0.5 rounded bg-amber-400 text-zinc-950 font-semibold text-[10.5px] cursor-pointer shrink-0"
              >
                Unlock
              </button>
            </div>
          )}

          {selectedRow.kind === 'blur' && selectedRow.selection.kind === 'blur' && (
            <div>
              <label className="text-[10.5px] text-zinc-400">Layer Name</label>
              <input
                type="text"
                value={selectedRow.label}
                disabled={selectedRow.locked}
                onChange={(e) => {
                  const id = selectedRow.selection.kind === 'blur' ? selectedRow.selection.id : '';
                  const nextName = e.target.value;
                  onUpdateBlurs(
                    project.blurs.map((b) => (b.id === id ? { ...b, name: nextName } : b))
                  );
                }}
                className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-zinc-100 disabled:opacity-40"
              />
            </div>
          )}

          <div>
            <div className="flex justify-between text-[11px] text-zinc-300">
              <span>Layer Opacity</span>
              <span className="font-mono tabular-nums text-zinc-400">
                {Math.round(selectedRow.opacity * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0.05}
              max={1}
              step={0.05}
              disabled={selectedRow.locked}
              value={selectedRow.opacity}
              onChange={(e) => updateSelectedOpacity(Number(e.target.value))}
              className="mt-1 w-full accent-violet-500 disabled:opacity-40"
            />
          </div>

          <div>
            <div className="flex justify-between text-[11px] text-zinc-300">
              <span>Rotation Angle</span>
              <span className="font-mono tabular-nums text-zinc-400">
                {Math.round(selectedRow.rotation)}°
              </span>
            </div>
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              disabled={selectedRow.locked}
              value={selectedRow.rotation}
              onChange={(e) => updateSelectedRotation(Number(e.target.value))}
              className="mt-1 w-full accent-violet-500 disabled:opacity-40"
            />
          </div>
        </div>
      )}
      {/* Filters & Effects Layer Stack */}
      {onUpdateVideoEffects && (filterStack.length > 0 || effectsList.length > 0) && (
        <div className="p-3 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-white flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-fuchsia-400" />
              Filters &amp; Effects Layers
            </span>
            <span className="text-[11px] font-mono text-zinc-500 tabular-nums">
              {filterStack.length + effectsList.length} Items
            </span>
          </div>

          <div className="space-y-1.5 max-h-[240px] overflow-y-auto pr-0.5">
            {filterStack.map((fl) => {
              const isSel =
                selectedElement?.kind === 'filter' && selectedElement.filterId === fl.id;
              const meta = getFilterPresetMeta(fl.preset);
              return (
                <div
                  key={fl.id}
                  onClick={() => onSelectElement({ kind: 'filter', filterId: fl.id })}
                  className={`px-2.5 py-2 rounded-lg border flex items-center justify-between gap-2 cursor-pointer text-xs ${
                    isSel
                      ? 'bg-pink-600/20 border-pink-400/70 text-white'
                      : 'bg-zinc-900/70 border-white/[0.06] text-zinc-300 hover:border-white/[0.16]'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <Wand2 className="w-3.5 h-3.5 text-pink-400 shrink-0" />
                    <div className="min-w-0">
                      <div className="font-medium truncate">{fl.name || meta.label}</div>
                      <div className="text-[10px] text-zinc-500 font-mono truncate">
                        Filter · {fl.intensity}% · {fl.startTime.toFixed(1)}s–
                        {(fl.endTime || 0).toFixed(1)}s
                      </div>
                    </div>
                  </div>
                  <div
                    className="flex items-center gap-0.5 shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateVideoEffects({
                          filterStack: filterStack.map((x) =>
                            x.id === fl.id ? { ...x, enabled: !x.enabled } : x
                          ),
                        })
                      }
                      className="min-w-[34px] min-h-[34px] lg:min-w-[28px] lg:min-h-[28px] flex items-center justify-center rounded hover:bg-white/[0.06] cursor-pointer"
                      title={fl.enabled ? 'Hide filter' : 'Show filter'}
                    >
                      {fl.enabled ? (
                        <Eye className="w-3.5 h-3.5 text-zinc-300" />
                      ) : (
                        <EyeOff className="w-3.5 h-3.5 text-zinc-600" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateVideoEffects({
                          filterStack: filterStack.map((x) =>
                            x.id === fl.id ? { ...x, locked: !x.locked } : x
                          ),
                        })
                      }
                      className={`min-w-[34px] min-h-[34px] lg:min-w-[28px] lg:min-h-[28px] flex items-center justify-center rounded hover:bg-white/[0.06] cursor-pointer ${
                        fl.locked ? 'text-amber-400' : 'text-zinc-400'
                      }`}
                      title={fl.locked ? 'Unlock' : 'Lock'}
                    >
                      {fl.locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      type="button"
                      aria-disabled={Boolean(fl.locked)}
                      onClick={() => {
                        if (fl.locked) {
                          onShowNotice?.(LOCKED_LAYER_MESSAGE);
                          return;
                        }
                        const copy = {
                          ...fl,
                          id: uuidv4(),
                          name: `${fl.name || meta.label} Copy`,
                          locked: false,
                        };
                        onUpdateVideoEffects({ filterStack: [...filterStack, copy] });
                        onSelectElement({ kind: 'filter', filterId: copy.id });
                      }}
                      className={`min-w-[34px] min-h-[34px] lg:min-w-[28px] lg:min-h-[28px] flex items-center justify-center rounded hover:bg-white/[0.06] cursor-pointer ${
                        fl.locked ? 'text-zinc-600 opacity-35' : 'text-zinc-400 hover:text-white'
                      }`}
                      title={fl.locked ? LOCKED_LAYER_MESSAGE : 'Duplicate'}
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-disabled={Boolean(fl.locked)}
                      onClick={() => {
                        if (fl.locked) {
                          onShowNotice?.(LOCKED_LAYER_MESSAGE);
                          return;
                        }
                        onUpdateVideoEffects({
                          filterStack: filterStack.filter((x) => x.id !== fl.id),
                        });
                        if (isSel) onSelectElement(null);
                      }}
                      className={`min-w-[34px] min-h-[34px] lg:min-w-[28px] lg:min-h-[28px] flex items-center justify-center rounded hover:bg-white/[0.06] cursor-pointer ${
                        fl.locked ? 'text-zinc-600 opacity-35' : 'text-zinc-500 hover:text-red-400'
                      }`}
                      title={fl.locked ? LOCKED_LAYER_MESSAGE : 'Delete'}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}

            {effectsList.map((fx) => {
              const isSel =
                selectedElement?.kind === 'effect' && selectedElement.effectId === fx.id;
              const cat = getEffectCatalogEntry(fx.type);
              return (
                <div
                  key={fx.id}
                  onClick={() => onSelectElement({ kind: 'effect', effectId: fx.id })}
                  className={`px-2.5 py-2 rounded-lg border flex items-center justify-between gap-2 cursor-pointer text-xs ${
                    isSel
                      ? 'bg-fuchsia-600/20 border-fuchsia-400/70 text-white'
                      : 'bg-zinc-900/70 border-white/[0.06] text-zinc-300 hover:border-white/[0.16]'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <Sparkles className="w-3.5 h-3.5 text-fuchsia-400 shrink-0" />
                    <div className="min-w-0">
                      <div className="font-medium truncate">{fx.name || cat.label}</div>
                      <div className="text-[10px] text-zinc-500 font-mono truncate">
                        {cat.category} · {fx.intensity}% · {fx.startTime.toFixed(1)}s–
                        {(fx.endTime || 0).toFixed(1)}s
                      </div>
                    </div>
                  </div>
                  <div
                    className="flex items-center gap-0.5 shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateVideoEffects({
                          effects: effectsList.map((x) =>
                            x.id === fx.id ? { ...x, enabled: !x.enabled } : x
                          ),
                        })
                      }
                      className="min-w-[34px] min-h-[34px] lg:min-w-[28px] lg:min-h-[28px] flex items-center justify-center rounded hover:bg-white/[0.06] cursor-pointer"
                      title={fx.enabled ? 'Hide effect' : 'Show effect'}
                    >
                      {fx.enabled ? (
                        <Eye className="w-3.5 h-3.5 text-zinc-300" />
                      ) : (
                        <EyeOff className="w-3.5 h-3.5 text-zinc-600" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateVideoEffects({
                          effects: effectsList.map((x) =>
                            x.id === fx.id ? { ...x, locked: !x.locked } : x
                          ),
                        })
                      }
                      className={`min-w-[34px] min-h-[34px] lg:min-w-[28px] lg:min-h-[28px] flex items-center justify-center rounded hover:bg-white/[0.06] cursor-pointer ${
                        fx.locked ? 'text-amber-400' : 'text-zinc-400'
                      }`}
                      title={fx.locked ? 'Unlock' : 'Lock'}
                    >
                      {fx.locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      type="button"
                      aria-disabled={Boolean(fx.locked)}
                      onClick={() => {
                        if (fx.locked) {
                          onShowNotice?.(LOCKED_LAYER_MESSAGE);
                          return;
                        }
                        const copy = {
                          ...fx,
                          id: uuidv4(),
                          name: `${fx.name || cat.label} Copy`,
                          locked: false,
                        };
                        onUpdateVideoEffects({ effects: [...effectsList, copy] });
                        onSelectElement({ kind: 'effect', effectId: copy.id });
                      }}
                      className={`min-w-[34px] min-h-[34px] lg:min-w-[28px] lg:min-h-[28px] flex items-center justify-center rounded hover:bg-white/[0.06] cursor-pointer ${
                        fx.locked ? 'text-zinc-600 opacity-35' : 'text-zinc-400 hover:text-white'
                      }`}
                      title={fx.locked ? LOCKED_LAYER_MESSAGE : 'Duplicate'}
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-disabled={Boolean(fx.locked)}
                      onClick={() => {
                        if (fx.locked) {
                          onShowNotice?.(LOCKED_LAYER_MESSAGE);
                          return;
                        }
                        onUpdateVideoEffects({
                          effects: effectsList.filter((x) => x.id !== fx.id),
                        });
                        if (isSel) onSelectElement(null);
                      }}
                      className={`min-w-[34px] min-h-[34px] lg:min-w-[28px] lg:min-h-[28px] flex items-center justify-center rounded hover:bg-white/[0.06] cursor-pointer ${
                        fx.locked ? 'text-zinc-600 opacity-35' : 'text-zinc-500 hover:text-red-400'
                      }`}
                      title={fx.locked ? LOCKED_LAYER_MESSAGE : 'Delete'}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
