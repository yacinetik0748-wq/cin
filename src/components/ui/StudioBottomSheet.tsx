import React from 'react';
import { Check, X } from 'lucide-react';

interface StudioBottomSheetProps {
  open: boolean;
  title: string;
  icon?: React.ReactNode;
  headerRight?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}

export function StudioBottomSheet({
  open,
  title,
  icon,
  headerRight,
  onClose,
  children,
}: StudioBottomSheetProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 flex flex-col justify-end pointer-events-none"
      role="dialog"
      aria-label={title}
    >
      <div className="pointer-events-auto w-full max-w-4xl mx-auto bg-[#111115] border-t border-x border-white/[0.12] rounded-t-2xl shadow-[0_-16px_48px_rgba(0,0,0,0.75)] flex flex-col max-h-[48dvh] sm:max-h-[54dvh] animate-sheet-up">
        {/* Compact Drag Handle */}
        <div className="pt-2 pb-1 flex justify-center shrink-0">
          <div className="w-10 h-1 rounded-full bg-white/20" />
        </div>

        {/* Sticky Sheet Header */}
        <div className="px-4 py-2 border-b border-white/[0.08] flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {icon && <span className="text-violet-400 shrink-0">{icon}</span>}
            <h2 className="text-xs sm:text-sm font-display font-semibold text-white truncate">
              {title}
            </h2>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {headerRight}
            <button
              type="button"
              onClick={onClose}
              className="min-h-[40px] px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white flex items-center gap-1 cursor-pointer"
              title="Done editing"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Done</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="min-h-[40px] min-w-[40px] p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] flex items-center justify-center cursor-pointer"
              aria-label="Close tool panel"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Scrollable Sheet Body */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 pb-safe space-y-3">
          {children}
        </div>
      </div>
    </div>
  );
}
