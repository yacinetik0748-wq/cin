import React from 'react';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Eye,
  EyeOff,
  Lock,
  Plus,
  Trash2,
  Type,
  Unlock,
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import {
  CaptionElementLayer,
  DEFAULT_SUBTITLE_STYLE,
  Project,
  StudioElementSelection,
  SubtitleStyle,
} from '../../types/studio';
import { BUILTIN_FONT_CATALOG, ensureFontLoaded } from '../../lib/fontCatalog';
import { LOCKED_LAYER_MESSAGE } from '../../lib/layerLock';
import { CollapsibleSection } from '../ui/CollapsibleSection';
import { StudioToolMemory } from './toolMemory';

interface TextToolSheetProps {
  project: Project;
  onUpdateSubtitleStyle: (
    patch: Partial<SubtitleStyle>,
    opts?: { undoGroupKey?: string; immediate?: boolean }
  ) => void;
  selectedElement: StudioElementSelection;
  onSelectElement: (el: StudioElementSelection) => void;
  onOpenCaptionsTool: () => void;
  onShowNotice?: (msg: string) => void;
  memory: StudioToolMemory;
  onUpdateMemory: (patch: Partial<StudioToolMemory>) => void;
}

export function TextToolSheet({
  project,
  onUpdateSubtitleStyle,
  selectedElement,
  onSelectElement,
  onOpenCaptionsTool,
  onShowNotice,
  memory,
  onUpdateMemory,
}: TextToolSheetProps) {
  const extraElements = project.subtitleStyle.extraElements || [];
  const activeExtraEl: CaptionElementLayer | null =
    selectedElement?.kind === 'caption-element'
      ? extraElements.find((el) => el.id === selectedElement.id) || null
      : extraElements[0] || null;

  const duration = project.metadata?.duration || 30;
  const activeStyle = activeExtraEl
    ? { ...DEFAULT_SUBTITLE_STYLE, ...project.subtitleStyle, ...activeExtraEl.style }
    : null;

  const handleAddTextOverlay = () => {
    const newEl: CaptionElementLayer = {
      id: uuidv4(),
      label: `Title ${extraElements.length + 1}`,
      text: 'PART 1',
      visible: true,
      locked: false,
      startTime: 0,
      endTime: 0,
      style: {
        fontFamily: project.subtitleStyle.fontFamily || 'Montserrat',
        fontSize: 38,
        fontWeightNum: 800,
        fontWeight: 'bold',
        primaryColor: '#FACC15',
        outlineColor: '#000000',
        outlineWidth: 3,
        backgroundOpacity: 0.45,
        backgroundColor: '#09090B',
        posX: 50,
        posY: 16,
        opacity: 1,
        rotation: 0,
        scale: 1,
        maxWidthPct: 86,
        textTransform: 'uppercase',
      },
    };
    onUpdateSubtitleStyle({ extraElements: [...extraElements, newEl] }, { immediate: true });
    onSelectElement({ kind: 'caption-element', id: newEl.id });
  };

  const updateActiveEl = (
    patch: Partial<CaptionElementLayer>,
    opts?: { undoGroupKey?: string; immediate?: boolean }
  ) => {
    if (!activeExtraEl) return;
    const keys = Object.keys(patch);
    const isVisOrLockOnly = keys.length > 0 && keys.every((k) => k === 'visible' || k === 'locked');
    if (activeExtraEl.locked && !isVisOrLockOnly) {
      onShowNotice?.(LOCKED_LAYER_MESSAGE);
      return;
    }
    onUpdateSubtitleStyle(
      {
        extraElements: extraElements.map((item) =>
          item.id === activeExtraEl.id ? { ...item, ...patch } : item
        ),
      },
      opts
    );
  };

  const updateActiveElStyle = (
    patch: Partial<SubtitleStyle>,
    opts?: { undoGroupKey?: string; immediate?: boolean }
  ) => {
    if (!activeExtraEl) return;
    if (activeExtraEl.locked) {
      onShowNotice?.(LOCKED_LAYER_MESSAGE);
      return;
    }
    updateActiveEl({ style: { ...activeExtraEl.style, ...patch } }, opts);
  };

  const handleDuplicate = (el: CaptionElementLayer) => {
    if (el.locked) {
      onShowNotice?.(LOCKED_LAYER_MESSAGE);
      return;
    }
    const copy: CaptionElementLayer = {
      ...el,
      id: uuidv4(),
      label: `${el.label} Copy`,
      locked: false,
      style: {
        ...el.style,
        posX: Math.min(90, (el.style.posX ?? 50) + 4),
        posY: Math.min(90, (el.style.posY ?? 18) + 6),
      },
    };
    onUpdateSubtitleStyle({ extraElements: [...extraElements, copy] }, { immediate: true });
    onSelectElement({ kind: 'caption-element', id: copy.id });
  };

  const handleDelete = (id: string) => {
    const target = extraElements.find((el) => el.id === id);
    if (target?.locked) {
      onShowNotice?.(LOCKED_LAYER_MESSAGE);
      return;
    }
    const next = extraElements.filter((el) => el.id !== id);
    onUpdateSubtitleStyle({ extraElements: next }, { immediate: true });
    onSelectElement(next[0] ? { kind: 'caption-element', id: next[0].id } : null);
  };

  const handleReorder = (id: string, dir: 'up' | 'down') => {
    const idx = extraElements.findIndex((el) => el.id === id);
    if (idx === -1) return;
    const swapIdx = dir === 'up' ? idx + 1 : idx - 1;
    if (swapIdx < 0 || swapIdx >= extraElements.length) return;
    if (extraElements[idx].locked || extraElements[swapIdx].locked) {
      onShowNotice?.(LOCKED_LAYER_MESSAGE);
      return;
    }
    const next = [...extraElements];
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    onUpdateSubtitleStyle({ extraElements: next }, { immediate: true });
  };

  return (
    <div className="space-y-3">
      {/* Top Action Strip */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleAddTextOverlay}
          className="min-h-[40px] flex-1 px-3 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white flex items-center justify-center gap-1.5 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          Add Text Layer
        </button>
        <button
          type="button"
          onClick={onOpenCaptionsTool}
          className="min-h-[40px] px-3 py-2 rounded-xl bg-[#18181D] hover:bg-zinc-800 border border-white/[0.08] text-xs font-medium text-amber-300 flex items-center gap-1.5 cursor-pointer shrink-0"
        >
          <Type className="w-3.5 h-3.5" />
          Captions Tool
        </button>
      </div>

      {/* Text Elements List */}
      {extraElements.length === 0 ? (
        <div className="p-4 rounded-xl bg-[#18181D] border border-white/[0.06] text-xs text-zinc-400 text-center">
          No custom text overlays yet. Tap &ldquo;Add Text Layer&rdquo; above to add a persistent title, hook, or badge.
        </div>
      ) : (
        <div className="space-y-1.5">
          {extraElements.map((el, idx) => {
            const isSel = activeExtraEl?.id === el.id;
            return (
              <div
                key={el.id}
                onClick={() => onSelectElement({ kind: 'caption-element', id: el.id })}
                className={`px-3 py-2 rounded-xl border flex flex-wrap sm:flex-nowrap items-center justify-between gap-2 text-xs cursor-pointer ${
                  isSel
                    ? 'bg-violet-600/15 border-violet-500/60 text-white'
                    : 'bg-[#18181D] border-white/[0.06] text-zinc-300'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <Type className="w-3.5 h-3.5 text-fuchsia-400 shrink-0" />
                  <span className="font-medium truncate">{el.label}</span>
                  <span className="text-[11px] text-zinc-500 truncate">({el.text})</span>
                </div>
                <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    disabled={idx === extraElements.length - 1}
                    onClick={() => handleReorder(el.id, 'up')}
                    className="min-w-[30px] min-h-[30px] flex items-center justify-center rounded-lg hover:bg-white/[0.06] text-zinc-400 hover:text-white disabled:opacity-30 cursor-pointer"
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={idx === 0}
                    onClick={() => handleReorder(el.id, 'down')}
                    className="min-w-[30px] min-h-[30px] flex items-center justify-center rounded-lg hover:bg-white/[0.06] text-zinc-400 hover:text-white disabled:opacity-30 cursor-pointer"
                  >
                    <ArrowDown className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateSubtitleStyle(
                        {
                          extraElements: extraElements.map((item) =>
                            item.id === el.id ? { ...item, visible: !item.visible } : item
                          ),
                        },
                        { immediate: true }
                      )
                    }
                    className="min-w-[30px] min-h-[30px] flex items-center justify-center rounded-lg hover:bg-white/[0.06] text-zinc-400 hover:text-white cursor-pointer"
                  >
                    {el.visible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateSubtitleStyle(
                        {
                          extraElements: extraElements.map((item) =>
                            item.id === el.id ? { ...item, locked: !item.locked } : item
                          ),
                        },
                        { immediate: true }
                      )
                    }
                    className={`min-w-[30px] min-h-[30px] flex items-center justify-center rounded-lg hover:bg-white/[0.06] cursor-pointer ${
                      el.locked ? 'text-amber-400' : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    {el.locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDuplicate(el)}
                    className="min-w-[30px] min-h-[30px] flex items-center justify-center rounded-lg hover:bg-white/[0.06] text-zinc-400 hover:text-white cursor-pointer"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(el.id)}
                    className="min-w-[30px] min-h-[30px] flex items-center justify-center rounded-lg hover:bg-white/[0.06] text-zinc-500 hover:text-red-400 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Selected Text Element Essential Controls */}
      {activeExtraEl && activeStyle && (
        <div className="space-y-3">
          {activeExtraEl.locked && (
            <div className="px-3 py-2 rounded-xl bg-amber-500/12 border border-amber-500/35 text-xs text-amber-200 flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 min-w-0">
                <Lock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span className="truncate">Layer locked — editing blocked</span>
              </span>
              <button
                type="button"
                onClick={() => updateActiveEl({ locked: false }, { immediate: true })}
                className="min-h-[28px] px-2.5 py-0.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 text-[11px] font-semibold text-amber-100 shrink-0 cursor-pointer"
              >
                Unlock
              </button>
            </div>
          )}
          <div className="p-3 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-3">
            <div>
              <div className="flex items-center justify-between gap-2">
                <label className="text-[10.5px] text-zinc-400">Text Content</label>
                <button
                  type="button"
                  onClick={() => {
                    const isMirroring = activeExtraEl.text.includes('{caption}');
                    updateActiveEl(
                      { text: isMirroring ? 'PART 1' : '{caption}' },
                      { immediate: true }
                    );
                  }}
                  className={`px-2 py-0.5 rounded text-[10.5px] font-medium border cursor-pointer ${
                    activeExtraEl.text.includes('{caption}')
                      ? 'bg-violet-600/25 border-violet-500/50 text-violet-200'
                      : 'bg-zinc-900 border-white/[0.08] text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {activeExtraEl.text.includes('{caption}') ? 'Mirroring Captions' : 'Mirror Captions'}
                </button>
              </div>
              <input
                type="text"
                value={activeExtraEl.text}
                onChange={(e) =>
                  updateActiveEl(
                    { text: e.target.value },
                    { undoGroupKey: `text:${activeExtraEl.id}:text` }
                  )
                }
                className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-violet-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="text-[10.5px] text-zinc-400">Font Family</label>
                <select
                  value={activeStyle.fontFamily}
                  onChange={(e) => {
                    const family = e.target.value;
                    void ensureFontLoaded({ family, weight: 700 });
                    updateActiveElStyle({ fontFamily: family }, { immediate: true });
                  }}
                  className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded-lg px-2 py-1.5 text-xs text-zinc-100"
                >
                  {BUILTIN_FONT_CATALOG.slice(0, 24).map((f) => (
                    <option key={f.family} value={f.family}>
                      {f.family}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10.5px] text-zinc-400">Text Color</label>
                <div className="mt-1 flex items-center gap-1.5">
                  <input
                    type="color"
                    value={activeStyle.primaryColor || '#FACC15'}
                    onChange={(e) =>
                      updateActiveElStyle(
                        { primaryColor: e.target.value },
                        { undoGroupKey: `text:${activeExtraEl.id}:color` }
                      )
                    }
                    className="w-8 h-8 rounded bg-transparent cursor-pointer shrink-0"
                  />
                  {['#FFFFFF', '#FACC15', '#38BDF8', '#F43F5E', '#4ADE80'].map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => updateActiveElStyle({ primaryColor: c }, { immediate: true })}
                      style={{ backgroundColor: c }}
                      className="w-5 h-5 rounded-full border border-white/25 cursor-pointer"
                    />
                  ))}
                </div>
              </div>
            </div>

            <div>
              <div className="flex justify-between text-[11px] text-zinc-300">
                <span>Font Size</span>
                <span className="font-mono tabular-nums">{activeStyle.fontSize}px</span>
              </div>
              <input
                type="range"
                min={14}
                max={100}
                value={activeStyle.fontSize}
                onChange={(e) =>
                  updateActiveElStyle(
                    { fontSize: Number(e.target.value) },
                    { undoGroupKey: `text:${activeExtraEl.id}:size` }
                  )
                }
                className="mt-1 w-full accent-violet-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="text-[10.5px] text-zinc-400">Start Time (0 = always)</label>
                <input
                  type="number"
                  min={0}
                  max={duration}
                  step={0.1}
                  value={activeExtraEl.startTime}
                  onChange={(e) =>
                    updateActiveEl(
                      { startTime: Math.max(0, Number(e.target.value)) },
                      { undoGroupKey: `text:${activeExtraEl.id}:time` }
                    )
                  }
                  className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded px-2 py-1 text-xs font-mono text-zinc-100"
                />
              </div>
              <div>
                <label className="text-[10.5px] text-zinc-400">End Time (0 = full)</label>
                <input
                  type="number"
                  min={0}
                  max={duration}
                  step={0.1}
                  value={activeExtraEl.endTime}
                  onChange={(e) =>
                    updateActiveEl(
                      { endTime: Math.max(0, Number(e.target.value)) },
                      { undoGroupKey: `text:${activeExtraEl.id}:time` }
                    )
                  }
                  className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded px-2 py-1 text-xs font-mono text-zinc-100"
                />
              </div>
            </div>
          </div>

          <CollapsibleSection
            title="Advanced Settings"
            subtitle="Label, outline, backdrop pill, position X/Y, scale & rotation"
            open={memory.textAdvancedOpen}
            onToggle={(open) => onUpdateMemory({ textAdvancedOpen: open })}
          >
            <div className="space-y-3">
              <div>
                <label className="text-[10.5px] text-zinc-400">Layer Name</label>
                <input
                  type="text"
                  value={activeExtraEl.label}
                  onChange={(e) =>
                    updateActiveEl(
                      { label: e.target.value },
                      { undoGroupKey: `text:${activeExtraEl.id}:label` }
                    )
                  }
                  className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded px-2.5 py-1.5 text-xs text-zinc-100"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="flex justify-between text-[11px] text-zinc-300">
                    <span>Position X</span>
                    <span className="font-mono">{activeStyle.posX ?? 50}%</span>
                  </div>
                  <input
                    type="range"
                    min={5}
                    max={95}
                    value={activeStyle.posX ?? 50}
                    onChange={(e) =>
                      updateActiveElStyle(
                        { posX: Number(e.target.value), position: 'custom' },
                        { undoGroupKey: `text:${activeExtraEl.id}:pos` }
                      )
                    }
                    className="mt-1 w-full accent-violet-500"
                  />
                </div>
                <div>
                  <div className="flex justify-between text-[11px] text-zinc-300">
                    <span>Position Y</span>
                    <span className="font-mono">{activeStyle.posY ?? 16}%</span>
                  </div>
                  <input
                    type="range"
                    min={5}
                    max={95}
                    value={activeStyle.posY ?? 16}
                    onChange={(e) =>
                      updateActiveElStyle(
                        { posY: Number(e.target.value), position: 'custom' },
                        { undoGroupKey: `text:${activeExtraEl.id}:pos` }
                      )
                    }
                    className="mt-1 w-full accent-violet-500"
                  />
                </div>
                <div>
                  <div className="flex justify-between text-[11px] text-zinc-300">
                    <span>Background Opacity</span>
                    <span className="font-mono">{Math.round((activeStyle.backgroundOpacity ?? 0.45) * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round((activeStyle.backgroundOpacity ?? 0.45) * 100)}
                    onChange={(e) =>
                      updateActiveElStyle(
                        { backgroundOpacity: Number(e.target.value) / 100 },
                        { undoGroupKey: `text:${activeExtraEl.id}:bgop` }
                      )
                    }
                    className="mt-1 w-full accent-violet-500"
                  />
                </div>
                <div>
                  <div className="flex justify-between text-[11px] text-zinc-300">
                    <span>Stroke Width</span>
                    <span className="font-mono">{activeStyle.outlineWidth ?? 3}px</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={10}
                    value={activeStyle.outlineWidth ?? 3}
                    onChange={(e) =>
                      updateActiveElStyle(
                        { outlineWidth: Number(e.target.value) },
                        { undoGroupKey: `text:${activeExtraEl.id}:stroke` }
                      )
                    }
                    className="mt-1 w-full accent-violet-500"
                  />
                </div>
                <div>
                  <div className="flex justify-between text-[11px] text-zinc-300">
                    <span>Rotation</span>
                    <span className="font-mono">{Math.round(activeStyle.rotation ?? 0)}°</span>
                  </div>
                  <input
                    type="range"
                    min={-180}
                    max={180}
                    value={activeStyle.rotation ?? 0}
                    onChange={(e) =>
                      updateActiveElStyle(
                        { rotation: Number(e.target.value) },
                        { undoGroupKey: `text:${activeExtraEl.id}:rot` }
                      )
                    }
                    className="mt-1 w-full accent-violet-500"
                  />
                </div>
                <div>
                  <div className="flex justify-between text-[11px] text-zinc-300">
                    <span>Opacity</span>
                    <span className="font-mono">{Math.round((activeStyle.opacity ?? 1) * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min={10}
                    max={100}
                    value={Math.round((activeStyle.opacity ?? 1) * 100)}
                    onChange={(e) =>
                      updateActiveElStyle(
                        { opacity: Number(e.target.value) / 100 },
                        { undoGroupKey: `text:${activeExtraEl.id}:op` }
                      )
                    }
                    className="mt-1 w-full accent-violet-500"
                  />
                </div>
              </div>
            </div>
          </CollapsibleSection>
        </div>
      )}
    </div>
  );
}
