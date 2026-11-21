import React, { useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, X } from 'lucide-react';

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
  const [expanded, setExpanded] = useState(false);
  const [dragOffsetY, setDragOffsetY] = useState(0);
  const dragStartRef = useRef<{ y: number; time: number } | null>(null);

  if (!open) return null;

  const handleDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragStartRef.current = { y: e.clientY, time: performance.now() };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const handleDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return;
    const dy = e.clientY - dragStartRef.current.y;
    if (dy > 0) {
      setDragOffsetY(Math.min(280, dy));
    } else if (dy < -36 && !expanded) {
      setDragOffsetY(Math.max(-24, dy * 0.35));
    }
  };

  const handleDragEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    dragStartRef.current = null;
    if (!start) return;
    const dy = e.clientY - start.y;
    const dt = Math.max(16, performance.now() - start.time);
    const velocity = dy / dt;

    setDragOffsetY(0);

    if (dy > 76 || velocity > 0.55) {
      if (expanded && dy < 150 && velocity < 0.75) {
        setExpanded(false);
      } else {
        setExpanded(false);
        onClose();
      }
      return;
    }

    if (dy < -48 || velocity < -0.55) {
      setExpanded(true);
    }
  };

  const handleClose = () => {
    setExpanded(false);
    setDragOffsetY(0);
    onClose();
  };

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 flex flex-col justify-end pointer-events-none"
      role="dialog"
      aria-label={title}
    >
      <div
        style={
          dragOffsetY !== 0
            ? { transform: `translateY(${dragOffsetY}px)`, transition: 'none' }
            : undefined
        }
        className={`pointer-events-auto w-full max-w-4xl mx-auto bg-[#111116] border-t border-x border-white/[0.14] rounded-t-2xl shadow-[0_-18px_52px_rgba(0,0,0,0.82)] flex flex-col transition-[max-height,transform] duration-200 animate-sheet-up ${
          expanded ? 'max-h-[76dvh]' : 'max-h-[50dvh] sm:max-h-[54dvh]'
        }`}
      >
        {/* Interactive Touch Drag Handle */}
        <div
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
          title="Drag down to close, drag up to expand"
          className="pt-2.5 pb-1.5 flex justify-center shrink-0 touch-none cursor-ns-resize"
        >
          <div className="w-11 h-1.5 rounded-full bg-white/25" />
        </div>

        {/* Sticky Sheet Header */}
        <div className="px-3 sm:px-4 py-1.5 border-b border-white/[0.08] flex items-center justify-between gap-2 shrink-0">
          <div
            onPointerDown={handleDragStart}
            onPointerMove={handleDragMove}
            onPointerUp={handleDragEnd}
            onPointerCancel={handleDragEnd}
            className="flex items-center gap-2 min-w-0 flex-1 touch-none py-1"
          >
            {icon && <span className="text-violet-400 shrink-0">{icon}</span>}
            <h2 className="text-xs sm:text-sm font-display font-semibold text-white truncate">
              {title}
            </h2>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {headerRight}
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="min-h-[40px] min-w-[40px] p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] flex items-center justify-center cursor-pointer"
              aria-label={expanded ? 'Compact sheet height' : 'Expand sheet height'}
              title={expanded ? 'Compact height' : 'Expand height'}
            >
              {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={handleClose}
              className="min-h-[40px] px-2.5 sm:px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white flex items-center gap-1 cursor-pointer whitespace-nowrap shrink-0"
              title="Done editing"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Done</span>
            </button>
            <button
              type="button"
              onClick={handleClose}
              className="min-h-[40px] min-w-[40px] p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] flex items-center justify-center cursor-pointer"
              aria-label="Close tool panel"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Scrollable Sheet Body */}
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain px-3 sm:px-4 py-3 pb-safe space-y-3">
          {children}
        </div>
      </div>
    </div>
  );
}
