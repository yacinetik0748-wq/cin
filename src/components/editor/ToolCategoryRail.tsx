import React, { useState } from 'react';
import {
  Captions,
  ChevronDown,
  ChevronRight,
  Clock,
  Crop,
  Droplet,
  Film,
  Image as ImageIcon,
  Layers,
  Layers3,
  Mic,
  Move,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Sliders,
  Sparkles,
  Type,
  Upload,
  Volume2,
  Wand2,
} from 'lucide-react';
import { EditorToolCategoryId, StudioToolId } from '../../types/studio';
import { StudioToolMemory } from '../sheets/toolMemory';

interface ToolCategoryRailProps {
  activeTool: StudioToolId;
  toolMemory: StudioToolMemory;
  onSelectTool: (tool: StudioToolId, subTab?: string, extraMemory?: Partial<StudioToolMemory>) => void;
  onOpenExport: () => void;
}

interface ToolRailEntry {
  id: string;
  label: string;
  tool: StudioToolId;
  subTab?: string;
  extraMemory?: Partial<StudioToolMemory>;
  Icon: React.ComponentType<{ className?: string }>;
  matchActive: (activeTool: StudioToolId, memory: StudioToolMemory) => boolean;
}

interface ToolCategoryGroup {
  id: EditorToolCategoryId;
  title: string;
  items: ToolRailEntry[];
}

const TOOL_CATEGORY_GROUPS: ToolCategoryGroup[] = [
  {
    id: 'media',
    title: 'MEDIA',
    items: [
      {
        id: 'media-video',
        label: 'Video & Assets',
        tool: 'edit',
        subTab: 'media',
        Icon: Film,
        matchActive: (t, m) => t === 'edit' && m.editTab === 'media',
      },
      {
        id: 'media-bg',
        label: 'Background',
        tool: 'edit',
        subTab: 'background',
        Icon: ImageIcon,
        matchActive: (t, m) => t === 'edit' && m.editTab === 'background',
      },
      {
        id: 'media-timing',
        label: 'Trim & Speed',
        tool: 'edit',
        subTab: 'timing',
        Icon: Clock,
        matchActive: (t, m) => t === 'edit' && m.editTab === 'timing',
      },
    ],
  },
  {
    id: 'transform',
    title: 'TRANSFORM',
    items: [
      {
        id: 'transform-canvas',
        label: 'Crop & Ratio',
        tool: 'edit',
        subTab: 'transform',
        Icon: Crop,
        matchActive: (t, m) => t === 'edit' && m.editTab === 'transform',
      },
    ],
  },
  {
    id: 'visual',
    title: 'VISUAL',
    items: [
      {
        id: 'visual-blur',
        label: 'Blur & Masks',
        tool: 'blur',
        Icon: Droplet,
        matchActive: (t) => t === 'blur',
      },
      {
        id: 'visual-filters',
        label: 'Filters',
        tool: 'filters',
        Icon: Wand2,
        matchActive: (t) => t === 'filters',
      },
      {
        id: 'visual-effects',
        label: 'Effects',
        tool: 'effects',
        Icon: Sparkles,
        matchActive: (t) => t === 'effects',
      },
      {
        id: 'visual-adjust',
        label: 'Color Adjust',
        tool: 'adjust',
        Icon: Sliders,
        matchActive: (t) => t === 'adjust',
      },
      {
        id: 'visual-overlay',
        label: 'Logos & Watermark',
        tool: 'overlay',
        Icon: Layers,
        matchActive: (t, m) => t === 'overlay' && !m.overlayAdvancedOpen,
      },
    ],
  },
  {
    id: 'text',
    title: 'TEXT',
    items: [
      {
        id: 'text-captions',
        label: 'Captions',
        tool: 'captions',
        Icon: Captions,
        matchActive: (t) => t === 'captions',
      },
      {
        id: 'text-overlays',
        label: 'Text Overlays',
        tool: 'text',
        Icon: Type,
        matchActive: (t) => t === 'text',
      },
    ],
  },
  {
    id: 'animation',
    title: 'ANIMATION',
    items: [
      {
        id: 'anim-logo',
        label: 'Overlay Motion',
        tool: 'overlay',
        extraMemory: { overlayAdvancedOpen: true },
        Icon: Move,
        matchActive: (t, m) => t === 'overlay' && m.overlayAdvancedOpen,
      },
      {
        id: 'anim-track',
        label: 'Motion Tracking',
        tool: 'blur',
        extraMemory: { blurAdvancedOpen: true },
        Icon: Palette,
        matchActive: () => false,
      },
    ],
  },
  {
    id: 'audio',
    title: 'AUDIO',
    items: [
      {
        id: 'audio-mixer',
        label: 'Audio Mixer',
        tool: 'audio',
        subTab: 'mixer',
        Icon: Volume2,
        matchActive: (t, m) => t === 'audio' && m.audioTab === 'mixer',
      },
      {
        id: 'audio-voice',
        label: 'AI Voice',
        tool: 'audio',
        subTab: 'voice',
        Icon: Mic,
        matchActive: (t, m) => t === 'audio' && m.audioTab === 'voice',
      },
    ],
  },
];

export function ToolCategoryRail({
  activeTool,
  toolMemory,
  onSelectTool,
  onOpenExport,
}: ToolCategoryRailProps) {
  const [compact, setCompact] = useState(false);
  const [collapsedCats, setCollapsedCats] = useState<Record<string, boolean>>({});

  const toggleCat = (catId: string) => {
    setCollapsedCats((prev) => ({ ...prev, [catId]: !prev[catId] }));
  };

  return (
    <aside
      aria-label="Editor tool categories"
      className={`hidden lg:flex flex-col shrink-0 h-full bg-[#0E0E13] border-r border-white/[0.08] transition-[width] duration-150 ${
        compact ? 'w-[54px]' : 'w-[186px]'
      }`}
    >
      <div
        className={`h-10 px-2.5 border-b border-white/[0.08] flex items-center ${
          compact ? 'justify-center' : 'justify-between'
        } shrink-0`}
      >
        {!compact && (
          <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
            Tools
          </span>
        )}
        <button
          type="button"
          onClick={() => setCompact((v) => !v)}
          className="w-7 h-7 rounded-md text-zinc-400 hover:text-white hover:bg-white/[0.06] flex items-center justify-center cursor-pointer"
          title={compact ? 'Expand tool panel' : 'Collapse tool panel'}
          aria-label="Toggle tool panel width"
        >
          {compact ? (
            <PanelLeftOpen className="w-3.5 h-3.5" />
          ) : (
            <PanelLeftClose className="w-3.5 h-3.5" />
          )}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-1.5 py-2 space-y-2.5">
        {TOOL_CATEGORY_GROUPS.map((group) => {
          const isCatCollapsed = Boolean(collapsedCats[group.id]);
          return (
            <div key={group.id} className="space-y-0.5">
              {!compact && (
                <button
                  type="button"
                  onClick={() => toggleCat(group.id)}
                  className="w-full px-2 py-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-300 cursor-pointer"
                >
                  <span>{group.title}</span>
                  {isCatCollapsed ? (
                    <ChevronRight className="w-3 h-3" />
                  ) : (
                    <ChevronDown className="w-3 h-3" />
                  )}
                </button>
              )}

              {(!isCatCollapsed || compact) &&
                group.items.map((item) => {
                  const isActive = item.matchActive(activeTool, toolMemory);
                  const { Icon } = item;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onSelectTool(item.tool, item.subTab, item.extraMemory)}
                      title={compact ? `${group.title}: ${item.label}` : undefined}
                      className={`w-full min-h-[34px] rounded-lg flex items-center ${
                        compact ? 'justify-center px-0' : 'px-2 gap-2'
                      } text-xs font-medium transition-colors cursor-pointer ${
                        isActive
                          ? 'bg-violet-600/20 text-white border border-violet-500/45'
                          : 'text-zinc-300 hover:text-white hover:bg-white/[0.05] border border-transparent'
                      }`}
                    >
                      <Icon
                        className={`w-3.5 h-3.5 shrink-0 ${
                          isActive ? 'text-violet-300' : 'text-zinc-400'
                        }`}
                      />
                      {!compact && <span className="truncate">{item.label}</span>}
                    </button>
                  );
                })}
            </div>
          );
        })}
      </div>

      {/* Bottom Export & Layers Quick Switch */}
      <div className="p-1.5 border-t border-white/[0.08] space-y-1 shrink-0 bg-[#0B0B0F]">
        <button
          type="button"
          onClick={() => onSelectTool('layers')}
          title="Layers Stack"
          className={`w-full min-h-[34px] rounded-lg flex items-center ${
            compact ? 'justify-center px-0' : 'px-2 gap-2'
          } text-xs font-medium transition-colors cursor-pointer ${
            activeTool === 'layers'
              ? 'bg-violet-600/20 text-white border border-violet-500/45'
              : 'text-zinc-300 hover:text-white hover:bg-white/[0.05] border border-transparent'
          }`}
        >
          <Layers3
            className={`w-3.5 h-3.5 shrink-0 ${
              activeTool === 'layers' ? 'text-violet-300' : 'text-zinc-400'
            }`}
          />
          {!compact && <span>Layers</span>}
        </button>

        <button
          type="button"
          onClick={onOpenExport}
          title="EXPORT: Format, Resolution & Render"
          className={`w-full min-h-[34px] rounded-lg flex items-center ${
            compact ? 'justify-center px-0' : 'px-2 gap-2'
          } text-xs font-medium bg-violet-600/15 hover:bg-violet-600/25 border border-violet-500/35 text-violet-200 transition-colors cursor-pointer`}
        >
          <Upload className="w-3.5 h-3.5 shrink-0 text-violet-300" />
          {!compact && <span>Export Settings</span>}
        </button>
      </div>
    </aside>
  );
}
