import React, { useState } from 'react';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';

interface CollapsibleSectionProps {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  open?: boolean;
  onToggle?: (nextOpen: boolean) => void;
  badge?: string;
  children: React.ReactNode;
}

export function CollapsibleSection({
  title,
  subtitle,
  defaultOpen = false,
  open: controlledOpen,
  onToggle,
  badge,
  children,
}: CollapsibleSectionProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen;

  const handleToggle = () => {
    const next = !isOpen;
    if (onToggle) {
      onToggle(next);
    } else {
      setInternalOpen(next);
    }
  };

  return (
    <div className="rounded-xl bg-[#18181D] border border-white/[0.08] overflow-hidden">
      <button
        type="button"
        onClick={handleToggle}
        className="w-full min-h-[44px] px-3.5 py-2.5 flex items-center justify-between gap-2 text-left hover:bg-white/[0.03] transition-colors cursor-pointer"
        aria-expanded={isOpen}
      >
        <div className="flex items-center gap-2 min-w-0">
          <SlidersHorizontal className="w-3.5 h-3.5 text-violet-400 shrink-0" />
          <div className="min-w-0">
            <div className="text-xs font-semibold text-zinc-100 flex items-center gap-2">
              <span className="truncate">{title}</span>
              {badge && (
                <span className="text-[10px] font-mono text-violet-300 bg-violet-500/15 px-1.5 py-0.5 rounded shrink-0">
                  {badge}
                </span>
              )}
            </div>
            {subtitle && (
              <div className="text-[10.5px] text-zinc-500 truncate">{subtitle}</div>
            )}
          </div>
        </div>
        <ChevronDown
          className={`w-4 h-4 text-zinc-400 shrink-0 transition-transform duration-150 ${
            isOpen ? 'rotate-180 text-violet-300' : ''
          }`}
        />
      </button>

      {isOpen && (
        <div className="px-3.5 pb-3.5 pt-2 border-t border-white/[0.06] space-y-3">
          {children}
        </div>
      )}
    </div>
  );
}
