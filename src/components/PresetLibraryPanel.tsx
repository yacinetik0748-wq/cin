import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookmarkCheck,
  Check,
  Download,
  Pencil,
  RefreshCw,
  Save,
  Star,
  Trash2,
  Upload,
} from 'lucide-react';
import { PresetCategory, StudioPreset, StudioPresetAssetRef } from '../types/studio';
import { api } from '../lib/api';

interface PresetLibraryPanelProps {
  category: PresetCategory;
  title: string;
  subtitle?: string;
  getPayload: () => {
    payload: Record<string, unknown>;
    assetRefs?: StudioPresetAssetRef[];
    thumbnailStyle?: StudioPreset['thumbnailStyle'];
  };
  onApplyPreset: (preset: StudioPreset) => void | Promise<void>;
  onReuploadMissingAsset?: (missing: StudioPresetAssetRef, preset: StudioPreset, file: File) => void | Promise<void>;
}

export function PresetLibraryPanel({
  category,
  title,
  subtitle,
  getPayload,
  onApplyPreset,
  onReuploadMissingAsset,
}: PresetLibraryPanelProps) {
  const importInputRef = useRef<HTMLInputElement>(null);
  const reuploadInputRef = useRef<HTMLInputElement>(null);

  const [presets, setPresets] = useState<StudioPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [presetName, setPresetName] = useState('');
  const [markDefault, setMarkDefault] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [appliedId, setAppliedId] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pendingReupload, setPendingReupload] = useState<{
    preset: StudioPreset;
    asset: StudioPresetAssetRef;
  } | null>(null);

  const loadPresets = async () => {
    try {
      const res = await api.listPresets(category);
      setPresets(res.presets || []);
    } catch {
      // ignore transient error
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadPresets();
  }, [category]);

  const handleSaveNew = async () => {
    const clean = presetName.trim();
    if (!clean) return;
    setErrorMsg(null);
    setStatusMsg(null);
    setSaving(true);
    try {
      const snap = getPayload();
      const res = await api.createPreset({
        category,
        name: clean,
        isDefault: markDefault,
        payload: snap.payload,
        assetRefs: snap.assetRefs,
        thumbnailStyle: snap.thumbnailStyle,
      });
      setPresets(res.presets.filter((p) => p.category === category));
      setPresetName('');
      setMarkDefault(false);
      setStatusMsg(`Saved "${clean}" to persistent library.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleOverwritePreset = async (preset: StudioPreset) => {
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const snap = getPayload();
      const res = await api.updatePreset(preset.id, {
        payload: snap.payload,
        assetRefs: snap.assetRefs,
        thumbnailStyle: snap.thumbnailStyle,
      });
      setPresets(res.presets.filter((p) => p.category === category));
      setStatusMsg(`Updated "${preset.name}" with current settings.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRenameSubmit = async (preset: StudioPreset) => {
    const clean = renameText.trim();
    setEditingId(null);
    if (!clean || clean === preset.name) return;
    try {
      const res = await api.updatePreset(preset.id, { name: clean });
      setPresets(res.presets.filter((p) => p.category === category));
      setStatusMsg(`Renamed preset to "${clean}".`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleToggleDefault = async (preset: StudioPreset) => {
    try {
      const res = await api.updatePreset(preset.id, { isDefault: !preset.isDefault });
      setPresets(res.presets.filter((p) => p.category === category));
      setStatusMsg(
        !preset.isDefault
          ? `"${preset.name}" set as default for new videos.`
          : `Removed default status from "${preset.name}".`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (preset: StudioPreset) => {
    try {
      const res = await api.deletePreset(preset.id);
      setPresets(res.presets.filter((p) => p.category === category));
      setStatusMsg(`Deleted "${preset.name}".`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleApply = async (preset: StudioPreset) => {
    setErrorMsg(null);
    try {
      await onApplyPreset(preset);
      setAppliedId(preset.id);
      setStatusMsg(`Applied "${preset.name}".`);
      window.setTimeout(() => setAppliedId(null), 1600);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleImportFile = async (file: File) => {
    setErrorMsg(null);
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw);
      const res = await api.importPresets(parsed);
      setPresets(res.presets.filter((p) => p.category === category));
      setStatusMsg(`Imported ${res.importedCount} preset(s).`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Invalid JSON preset bundle.');
    }
  };

  return (
    <div className="p-3.5 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-white flex items-center gap-1.5">
            <BookmarkCheck className="w-3.5 h-3.5 text-violet-400" />
            {title}
          </div>
          {subtitle && <p className="text-[11px] text-zinc-400 mt-0.5">{subtitle}</p>}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleImportFile(f);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            title="Import presets JSON"
            className="px-2 py-1 rounded bg-zinc-900 hover:bg-zinc-800 border border-white/[0.08] text-[10.5px] text-zinc-300 flex items-center gap-1 cursor-pointer"
          >
            <Upload className="w-3 h-3" />
            Import
          </button>
          <a
            href={api.exportPresetsUrl}
            download="recap-studio-presets.json"
            title="Export all saved presets as JSON"
            className="px-2 py-1 rounded bg-zinc-900 hover:bg-zinc-800 border border-white/[0.08] text-[10.5px] text-zinc-300 flex items-center gap-1 cursor-pointer"
          >
            <Download className="w-3 h-3" />
            Export
          </a>
        </div>
      </div>

      {/* Hidden re-upload input for missing preset assets */}
      <input
        ref={reuploadInputRef}
        type="file"
        accept=".png,.jpg,.jpeg,.webp,.svg,.ttf,.otf,.woff,.woff2"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f && pendingReupload && onReuploadMissingAsset) {
            await onReuploadMissingAsset(pendingReupload.asset, pendingReupload.preset, f);
            await loadPresets();
          }
          setPendingReupload(null);
          e.target.value = '';
        }}
      />

      {/* Save Current as Preset */}
      <div className="space-y-2 pt-1 border-t border-white/[0.06]">
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder={`Save current ${category} style as...`}
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSaveNew();
            }}
            className="flex-1 bg-zinc-900 border border-white/[0.08] rounded-md px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-violet-500"
          />
          <button
            type="button"
            disabled={!presetName.trim() || saving}
            onClick={() => void handleSaveNew()}
            className="px-3 py-1.5 rounded-md bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center gap-1 cursor-pointer shrink-0"
          >
            <Save className="w-3.5 h-3.5" />
            Save
          </button>
        </div>

        <label className="flex items-center gap-2 text-[11px] text-zinc-400 cursor-pointer">
          <input
            type="checkbox"
            checked={markDefault}
            onChange={(e) => setMarkDefault(e.target.checked)}
            className="accent-violet-500 rounded"
          />
          <span>Set as Default for future video imports</span>
        </label>
      </div>

      {errorMsg && (
        <div className="p-2 rounded bg-red-500/10 border border-red-500/30 text-[11px] text-red-200">
          {errorMsg}
        </div>
      )}
      {statusMsg && (
        <div className="p-2 rounded bg-emerald-500/10 border border-emerald-500/30 text-[11px] text-emerald-200">
          {statusMsg}
        </div>
      )}

      {/* Saved Presets List */}
      {loading ? (
        <div className="text-[11px] text-zinc-500 py-2">Loading saved presets...</div>
      ) : presets.length === 0 ? (
        <div className="p-3 rounded-lg bg-zinc-900/70 border border-white/[0.05] text-[11px] text-zinc-500 text-center">
          No saved {category} presets yet. Save your configuration above to reuse it across videos.
        </div>
      ) : (
        <div className="space-y-2 max-h-[260px] overflow-y-auto pr-0.5">
          {presets.map((preset) => {
            const hasMissing = (preset.missingAssets?.length || 0) > 0;
            const thumb = preset.thumbnailStyle;
            return (
              <div
                key={preset.id}
                className="p-2.5 rounded-lg bg-zinc-900/80 border border-white/[0.06] hover:border-white/[0.15] space-y-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {thumb && (
                      <div
                        className="w-8 h-6 rounded border border-white/15 flex items-center justify-center text-[10px] font-bold shrink-0"
                        style={{
                          backgroundColor: thumb.bg || '#111115',
                          color: thumb.fg || '#FFFFFF',
                        }}
                      >
                        {thumb.sampleText || 'Aa'}
                      </div>
                    )}

                    <div className="min-w-0">
                      {editingId === preset.id ? (
                        <input
                          type="text"
                          autoFocus
                          value={renameText}
                          onChange={(e) => setRenameText(e.target.value)}
                          onBlur={() => void handleRenameSubmit(preset)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleRenameSubmit(preset);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          className="bg-zinc-950 border border-violet-500 rounded px-1.5 py-0.5 text-xs text-white w-36"
                        />
                      ) : (
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-xs font-medium text-zinc-100 truncate">
                            {preset.name}
                          </span>
                          {preset.isDefault && (
                            <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[9.5px] font-mono shrink-0">
                              DEFAULT
                            </span>
                          )}
                        </div>
                      )}
                      {thumb?.badge && (
                        <div className="text-[10px] text-zinc-500 font-mono truncate">
                          {thumb.badge}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => void handleApply(preset)}
                      className={`px-2.5 py-1 rounded text-[11px] font-semibold cursor-pointer flex items-center gap-1 ${
                        appliedId === preset.id
                          ? 'bg-emerald-600 text-white'
                          : 'bg-violet-600 hover:bg-violet-500 text-white'
                      }`}
                    >
                      {appliedId === preset.id && <Check className="w-3 h-3" />}
                      {appliedId === preset.id ? 'Applied' : 'Apply'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleToggleDefault(preset)}
                      title={preset.isDefault ? 'Unset default preset' : 'Set as default preset'}
                      className={`p-1 rounded hover:bg-white/[0.06] cursor-pointer ${
                        preset.isDefault ? 'text-amber-400' : 'text-zinc-500 hover:text-zinc-200'
                      }`}
                    >
                      <Star className="w-3.5 h-3.5" fill={preset.isDefault ? 'currentColor' : 'none'} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleOverwritePreset(preset)}
                      title="Update preset with current settings"
                      className="p-1 text-zinc-400 hover:text-white rounded hover:bg-white/[0.06] cursor-pointer"
                    >
                      <RefreshCw className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(preset.id);
                        setRenameText(preset.name);
                      }}
                      title="Rename preset"
                      className="p-1 text-zinc-400 hover:text-white rounded hover:bg-white/[0.06] cursor-pointer"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(preset)}
                      title="Delete preset"
                      className="p-1 text-zinc-500 hover:text-red-400 rounded hover:bg-white/[0.06] cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                {hasMissing && (
                  <div className="p-2 rounded bg-amber-500/10 border border-amber-500/30 text-[10.5px] text-amber-200 flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      <span className="truncate">
                        Missing asset: {preset.missingAssets![0].label}
                      </span>
                    </span>
                    {onReuploadMissingAsset && (
                      <button
                        type="button"
                        onClick={() => {
                          setPendingReupload({ preset, asset: preset.missingAssets![0] });
                          reuploadInputRef.current?.click();
                        }}
                        className="px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 font-medium shrink-0 cursor-pointer"
                      >
                        Re-upload
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
