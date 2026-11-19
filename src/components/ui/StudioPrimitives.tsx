import React from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, Loader2 } from 'lucide-react';

export interface StudioCardProps extends React.HTMLAttributes<HTMLDivElement> {
  elevated?: boolean;
  padding?: 'none' | 'sm' | 'md' | 'lg';
}

export function StudioCard({
  elevated = false,
  padding = 'md',
  className = '',
  children,
  ...rest
}: StudioCardProps) {
  const padClass =
    padding === 'none'
      ? ''
      : padding === 'sm'
      ? 'p-3'
      : padding === 'lg'
      ? 'p-5 sm:p-6'
      : 'p-4';

  return (
    <div
      className={`rounded-xl border border-white/[0.08] ${
        elevated ? 'bg-[#15151C]' : 'bg-[#101015]'
      } ${padClass} ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface StudioSectionHeaderProps {
  title: string;
  subtitle?: string;
  stepNumber?: string | number;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export function StudioSectionHeader({
  title,
  subtitle,
  stepNumber,
  icon,
  actions,
  className = '',
}: StudioSectionHeaderProps) {
  return (
    <div className={`flex flex-wrap items-start justify-between gap-3 ${className}`}>
      <div className="min-w-0 flex items-start gap-2.5">
        {stepNumber !== undefined ? (
          <span className="w-6 h-6 rounded-md bg-violet-600/20 border border-violet-500/35 text-xs font-mono font-semibold text-violet-300 flex items-center justify-center shrink-0 mt-0.5 tabular-nums">
            {stepNumber}
          </span>
        ) : icon ? (
          <span className="w-7 h-7 rounded-lg bg-white/[0.04] border border-white/[0.08] text-violet-400 flex items-center justify-center shrink-0">
            {icon}
          </span>
        ) : null}
        <div className="min-w-0">
          <h2 className="text-sm sm:text-base font-display font-semibold text-white tracking-tight">
            {title}
          </h2>
          {subtitle && (
            <p className="text-xs text-zinc-400 mt-0.5 leading-relaxed">{subtitle}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0 flex-wrap">{actions}</div>}
    </div>
  );
}

export type StudioButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
export type StudioButtonSize = 'sm' | 'md' | 'lg';

export interface StudioButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: StudioButtonVariant;
  size?: StudioButtonSize;
  loading?: boolean;
  icon?: React.ReactNode;
}

export function StudioButton({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  children,
  className = '',
  disabled,
  type = 'button',
  ...rest
}: StudioButtonProps) {
  const variantClasses: Record<StudioButtonVariant, string> = {
    primary:
      'bg-violet-600 hover:bg-violet-500 text-white border border-violet-500/40 shadow-sm shadow-violet-900/30',
    secondary:
      'bg-[#181820] hover:bg-[#22222C] text-zinc-100 border border-white/[0.09]',
    ghost:
      'bg-transparent hover:bg-white/[0.06] text-zinc-300 hover:text-white border border-transparent',
    danger:
      'bg-red-500/15 hover:bg-red-500/25 text-red-200 border border-red-500/30',
    success:
      'bg-emerald-600 hover:bg-emerald-500 text-white border border-emerald-500/40',
  };

  const sizeClasses: Record<StudioButtonSize, string> = {
    sm: 'min-h-[34px] px-2.5 py-1 text-xs rounded-lg gap-1.5',
    md: 'min-h-[38px] px-3.5 py-1.5 text-xs sm:text-sm rounded-lg gap-2',
    lg: 'min-h-[44px] px-4 py-2 text-sm rounded-xl gap-2',
  };

  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      {...rest}
    >
      {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> : icon}
      {children}
    </button>
  );
}

export type StudioBannerTone = 'info' | 'success' | 'warning' | 'error';

export function StudioBanner({
  tone = 'info',
  title,
  children,
  action,
  className = '',
}: {
  tone?: StudioBannerTone;
  title?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  const styles: Record<StudioBannerTone, { wrap: string; Icon: typeof Info; iconColor: string }> = {
    info: {
      wrap: 'bg-sky-500/10 border-sky-500/30 text-sky-100',
      Icon: Info,
      iconColor: 'text-sky-400',
    },
    success: {
      wrap: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-100',
      Icon: CheckCircle2,
      iconColor: 'text-emerald-400',
    },
    warning: {
      wrap: 'bg-amber-500/10 border-amber-500/30 text-amber-100',
      Icon: AlertTriangle,
      iconColor: 'text-amber-400',
    },
    error: {
      wrap: 'bg-red-500/10 border-red-500/30 text-red-100',
      Icon: AlertCircle,
      iconColor: 'text-red-400',
    },
  };

  const { wrap, Icon, iconColor } = styles[tone];

  return (
    <div
      className={`rounded-xl border px-3.5 py-2.5 text-xs flex items-start justify-between gap-3 ${wrap} ${className}`}
    >
      <div className="flex items-start gap-2.5 min-w-0">
        <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${iconColor}`} />
        <div className="min-w-0 space-y-0.5">
          {title && <div className="font-semibold text-white">{title}</div>}
          <div className="leading-relaxed opacity-95">{children}</div>
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function StudioEmptyState({
  icon,
  title,
  description,
  action,
  className = '',
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-dashed border-white/[0.12] bg-[#101015] px-6 py-10 text-center flex flex-col items-center justify-center gap-3 ${className}`}
    >
      <div className="w-11 h-11 rounded-xl bg-white/[0.04] border border-white/[0.08] text-violet-400 flex items-center justify-center">
        {icon}
      </div>
      <div className="space-y-1 max-w-md">
        <h3 className="text-sm font-display font-semibold text-white">{title}</h3>
        <p className="text-xs text-zinc-400 leading-relaxed">{description}</p>
      </div>
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}

export function StudioSegmentedControl<T extends string>({
  value,
  onChange,
  options,
  className = '',
}: {
  value: T;
  onChange: (val: T) => void;
  options: Array<{ value: T; label: string; icon?: React.ReactNode }>;
  className?: string;
}) {
  return (
    <div
      className={`inline-flex flex-wrap items-center gap-1 p-1 rounded-lg bg-[#0B0B0F] border border-white/[0.08] ${className}`}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`min-h-[34px] px-3 py-1 rounded-md text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
              active
                ? 'bg-violet-600 text-white shadow-sm'
                : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]'
            }`}
          >
            {opt.icon}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function StudioMetric({
  label,
  value,
  subValue,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  subValue?: string;
  tone?: 'default' | 'accent' | 'success' | 'warning';
}) {
  const valColor =
    tone === 'accent'
      ? 'text-violet-300'
      : tone === 'success'
      ? 'text-emerald-300'
      : tone === 'warning'
      ? 'text-amber-300'
      : 'text-white';

  return (
    <div className="px-3 py-2.5 rounded-lg bg-[#16161D] border border-white/[0.07]">
      <div className="text-[11px] text-zinc-400 truncate">{label}</div>
      <div className={`text-sm font-mono font-semibold tabular-nums mt-0.5 ${valColor}`}>
        {value}
      </div>
      {subValue && <div className="text-[10.5px] text-zinc-500 mt-0.5 truncate">{subValue}</div>}
    </div>
  );
}
