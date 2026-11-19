import React from 'react';
import { AlertTriangle, Mic, Settings, Star } from 'lucide-react';
import { FishVoiceModel, SavedFishVoice } from '../types/studio';

interface NarratorSelectorProps {
  savedVoices: SavedFishVoice[];
  catalogVoices?: FishVoiceModel[];
  selectedVoiceId?: string;
  selectedVoiceTitle?: string;
  onSelectVoice: (voiceId: string, voiceTitle: string) => void;
  onOpenSettings?: () => void;
  compact?: boolean;
}

export function NarratorSelector({
  savedVoices,
  catalogVoices = [],
  selectedVoiceId = '',
  selectedVoiceTitle,
  onSelectVoice,
  onOpenSettings,
  compact = false,
}: NarratorSelectorProps) {
  const cleanId = selectedVoiceId.trim();
  const matchedSaved = cleanId ? savedVoices.find((s) => s.voiceId.trim() === cleanId) : undefined;
  const matchedCatalog = cleanId ? catalogVoices.find((c) => c.id === cleanId) : undefined;
  const isMissingSelected =
    !cleanId && selectedVoiceTitle === 'Narrator Missing — Select Voice';

  const activeName = matchedSaved
    ? matchedSaved.name
    : matchedCatalog
    ? matchedCatalog.title
    : cleanId
    ? selectedVoiceTitle || `Custom Voice (${cleanId.slice(0, 8)}...)`
    : isMissingSelected
    ? 'Narrator Missing — Choose Replacement'
    : 'Default Neutral Narrator';

  const selectVal = cleanId ? `id:${cleanId}` : '';

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
          <Mic className="w-3.5 h-3.5 text-violet-400 shrink-0" />
          <span>SELECT NARRATOR</span>
        </label>

        {onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            className="text-[11px] font-medium text-violet-300 hover:text-violet-200 flex items-center gap-1 whitespace-nowrap cursor-pointer"
          >
            <Settings className="w-3 h-3" />
            <span>Manage My Voices</span>
          </button>
        )}
      </div>

      <select
        value={selectVal}
        aria-label="Select Narrator"
        onChange={(e) => {
          const val = e.target.value;
          if (!val) {
            onSelectVoice('', 'Default Fish Audio Voice (s2.1-pro-free)');
            return;
          }
          const rawId = val.replace(/^id:/, '');
          const sv = savedVoices.find((s) => s.voiceId === rawId);
          if (sv) {
            onSelectVoice(sv.voiceId, sv.name);
            return;
          }
          const cv = catalogVoices.find((c) => c.id === rawId);
          onSelectVoice(rawId, cv?.title || selectedVoiceTitle || rawId);
        }}
        className={`w-full bg-[#18181D] border rounded-lg px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-violet-500 cursor-pointer ${
          isMissingSelected ? 'border-amber-500/60' : 'border-white/[0.1]'
        } ${compact ? 'min-h-[36px]' : 'min-h-[40px]'}`}
      >
        <option value="">Default Neutral Narrator (s2.1-pro-free)</option>
        {savedVoices.length > 0 && (
          <optgroup label="My Voices">
            {savedVoices.map((sv) => (
              <option key={`my-${sv.id}`} value={`id:${sv.voiceId}`}>
                {sv.name}
                {sv.language ? ` · ${sv.language}` : ''}
                {sv.isDefault ? ' (Default)' : ''}
              </option>
            ))}
          </optgroup>
        )}
        {catalogVoices.length > 0 && (
          <optgroup label="Fish Audio Catalog">
            {catalogVoices
              .filter((cv) => !savedVoices.some((sv) => sv.voiceId === cv.id))
              .map((cv) => (
                <option key={cv.id} value={`id:${cv.id}`}>
                  {cv.title}
                </option>
              ))}
          </optgroup>
        )}
        {cleanId && !matchedSaved && !matchedCatalog && (
          <option value={`id:${cleanId}`}>
            {selectedVoiceTitle || `Custom ID (${cleanId.slice(0, 10)}...)`}
          </option>
        )}
      </select>

      {/* Active Narrator Readout */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] px-1">
        <div className="flex items-center gap-1.5 min-w-0">
          {isMissingSelected ? (
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          ) : matchedSaved?.isDefault ? (
            <Star className="w-3 h-3 text-amber-400 fill-amber-400 shrink-0" />
          ) : null}
          <span className={`font-medium truncate ${isMissingSelected ? 'text-amber-300' : 'text-zinc-200'}`}>
            {activeName}
          </span>
          {matchedSaved?.language && (
            <span className="text-zinc-500 shrink-0">· {matchedSaved.language}</span>
          )}
        </div>
        {cleanId && (
          <span className="text-[10.5px] font-mono text-zinc-500 truncate max-w-[180px]">
            {cleanId}
          </span>
        )}
      </div>
    </div>
  );
}
