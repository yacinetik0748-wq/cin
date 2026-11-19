import React from 'react';
import { Check, ChevronRight } from 'lucide-react';
import { PipelineStepId, PipelineStepInfo } from '../lib/workflowStages';

interface WorkflowStepperBarProps {
  steps: PipelineStepInfo[];
  onSelectStep: (step: PipelineStepId) => void;
  compact?: boolean;
}

export function WorkflowStepperBar({
  steps,
  onSelectStep,
  compact = false,
}: WorkflowStepperBarProps) {
  return (
    <nav
      aria-label="Production workflow steps"
      className={`border-b border-white/[0.08] bg-[#0C0C10] shrink-0 ${
        compact ? 'px-2.5 sm:px-4 py-1.5' : 'px-3 sm:px-5 py-2'
      }`}
    >
      <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
        {steps.map((step, idx) => {
          const isCurrent = step.active;
          const isDone = step.completed && !isCurrent;

          return (
            <React.Fragment key={step.id}>
              <button
                type="button"
                disabled={!step.accessible}
                onClick={() => onSelectStep(step.id)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium whitespace-nowrap shrink-0 transition-colors ${
                  isCurrent
                    ? 'bg-violet-600/25 border border-violet-500/60 text-white cursor-pointer'
                    : isDone
                    ? 'bg-emerald-500/10 border border-emerald-500/25 text-emerald-200 hover:bg-emerald-500/20 cursor-pointer'
                    : step.accessible
                    ? 'bg-zinc-900/70 border border-white/[0.06] text-zinc-300 hover:bg-zinc-800 cursor-pointer'
                    : 'bg-zinc-900/40 border border-white/[0.04] text-zinc-600 cursor-not-allowed'
                }`}
              >
                <span
                  className={`w-4 h-4 rounded-full text-[10px] font-mono flex items-center justify-center shrink-0 ${
                    isCurrent
                      ? 'bg-violet-500 text-white'
                      : isDone
                      ? 'bg-emerald-500/25 text-emerald-300'
                      : 'bg-zinc-800 text-zinc-400'
                  }`}
                >
                  {isDone ? <Check className="w-2.5 h-2.5" /> : step.number}
                </span>
                <span className="hidden sm:inline">{step.label}</span>
                <span className="sm:hidden">{step.shortLabel}</span>
              </button>

              {idx < steps.length - 1 && (
                <ChevronRight className="w-3.5 h-3.5 text-zinc-600 shrink-0" />
              )}
            </React.Fragment>
          );
        })}
      </div>
    </nav>
  );
}
