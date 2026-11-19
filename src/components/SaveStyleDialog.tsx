import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  BookmarkPlus,
  Camera,
  Check,
  ImagePlus,
  Loader2,
  X,
} from 'lucide-react';
import { Project, SavedFishVoice, StudioPreset } from '../types/studio';
import { api } from '../lib/api';
import { buildSavedStylePayloadFromProject } from '../lib/savedStyles';
import { getFilterPresetMeta } from '../lib/videoFiltersCatalog';

interface SaveStyleDialogProps {
  open: boolean;
  project: Project | null;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  onClose: () => void;
  onSaved: (style: StudioPreset, allStyles: StudioPreset[]) => void;
}

export function SaveStyleDialog({
  open,
  project,
  videoRef,
  onClose,
  onSaved,
}: SaveStyleDialogProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [thumbnailDataUrl, setThumbnailDataUrl] = useState<string | undefined>(undefined);
  const [isDefault, setIsDefault] = useState(false);
  const [savedVoices, setSavedVoices] = useState<SavedFishVoice[]>([]);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !project) return;
    setName(`${project.name} Style`);
    setDescription('');
    setThumbnailDataUrl(undefined);
    setIsDefault(false);
    setErrorMsg(null);
    void api
      .listSavedFishVoices()
      .then((res) => setSavedVoices(res.voices || []))
      .catch(() => {});
  }, [open, project]);

  if (!open || !project) return null;

  const { thumbnailStyle } = buildSavedStylePayloadFromProject(project, {
    savedVoices,
    thumbnailImageUrl: thumbnailDataUrl,
  });

  const vfx = project.videoEffects;
  const sub = project.subtitleStyle;
  const canvas = project.canvas;
  const voice = project.voice;
  const matchedVoice = voice.fishReferenceId
    ? savedVoices.find((v) => v.voiceId === voice.fishReferenceId?.trim())
    : undefined;
  const narratorText =
    matchedVoice?.name ||
    voice.fishVoiceTitle ||
    (voice.fishReferenceId ? `ID: ${voice.fishReferenceId}` : 'Default Neutral Narrator');

  const handleCaptureVideoFrame = () => {
    const video = videoRef?.current;
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) {
      setErrorMsg('Play or load a video frame first to capture a thumbnail.');
      return;
    }
    try {
      const w = 480;
      const h = Math.max(180, Math.round((video.videoHeight / video.videoWidth) * w));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, w, h);
      setThumbnailDataUrl(c.toDataURL('image/jpeg', 0.84));
      setErrorMsg(null);
    } catch {
      setErrorMsg('Unable to capture frame from video element.');
    }
  };

  const handleUploadThumbnail = (file: File) => {
    if (!file.type.startsWith('image/')) {
      setErrorMsg('Please select a PNG, JPG, or WebP image.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setThumbnailDataUrl(reader.result);
        setErrorMsg(null);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) {
      setErrorMsg('Enter a name for this style preset.');
      return;
    }
    setSaving(true);
    setErrorMsg(null);
    try {
      const res = await api.createStyle({
        name: cleanName,
        description: description.trim() || undefined,
        isDefault,
        projectId: project.id,
        thumbnailDataUrl,
        thumbnailStyle,
      });
      onSaved(res.style, res.styles);
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const filterLabel =
    vfx.filterPreset && vfx.filterPreset !== 'none'
      ? getFilterPresetMeta(vfx.filterPreset).label
      : (vfx.filterStack?.length || 0) > 0
      ? `${vfx.filterStack!.length} Filter layer(s)`
      : 'None';

  return (
    <div
      className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-3 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="save-style-title"
    >
      <div className="w-full max-w-lg rounded-xl bg-[#111115] border border-white/[0.1] shadow-2xl overflow-hidden flex flex-col max-h-[92dvh]">
        <div className="px-4 py-3 border-b border-white/[0.08] flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <BookmarkPlus className="w-4 h-4 text-violet-400 shrink-0" />
            <h2 id="save-style-title" className="text-sm font-display font-semibold text-white truncate">
              Save Current Style
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4 overflow-y-auto">
          {errorMsg && (
            <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-200 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          <div className="space-y-3">
            <div>
              <label htmlFor="save-style-name" className="block text-xs font-medium text-zinc-300 mb-1">
                Style Name
              </label>
              <input
                id="save-style-name"
                type="text"
                autoFocus
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Dark Thriller Recap · Male FR"
                className="w-full min-h-[40px] bg-[#18181D] border border-white/[0.1] rounded-lg px-3 py-2 text-xs text-white placeholder:text-zinc-500 focus:outline-none focus:border-violet-500"
              />
            </div>

            <div>
              <label htmlFor="save-style-desc" className="block text-xs font-medium text-zinc-300 mb-1">
                Description (Optional)
              </label>
              <input
                id="save-style-desc"
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Filters, caption template, narrator & framing settings..."
                className="w-full min-h-[38px] bg-[#18181D] border border-white/[0.1] rounded-lg px-3 py-2 text-xs text-white placeholder:text-zinc-500 focus:outline-none focus:border-violet-500"
              />
            </div>

            {/* Optional Preview Thumbnail */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-zinc-300">Preview Image (Optional)</span>
                <div className="flex items-center gap-1.5">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleUploadThumbnail(f);
                      e.target.value = '';
                    }}
                  />
                  {videoRef && (
                    <button
                      type="button"
                      onClick={handleCaptureVideoFrame}
                      className="min-h-[32px] px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 border border-white/[0.08] text-[11px] font-medium text-zinc-200 flex items-center gap-1 whitespace-nowrap cursor-pointer"
                    >
                      <Camera className="w-3.5 h-3.5 text-violet-400" />
                      Capture Frame
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="min-h-[32px] px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 border border-white/[0.08] text-[11px] font-medium text-zinc-200 flex items-center gap-1 whitespace-nowrap cursor-pointer"
                  >
                    <ImagePlus className="w-3.5 h-3.5 text-zinc-300" />
                    Upload
                  </button>
                  {thumbnailDataUrl && (
                    <button
                      type="button"
                      onClick={() => setThumbnailDataUrl(undefined)}
                      className="min-h-[32px] px-2 py-1 rounded-md bg-zinc-900 hover:bg-zinc-800 text-[11px] text-zinc-400 hover:text-zinc-200 cursor-pointer"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {thumbnailDataUrl ? (
                <div className="relative h-24 w-full rounded-lg overflow-hidden border border-white/[0.08] bg-black">
                  <img
                    src={thumbnailDataUrl}
                    alt="Style preview"
                    className="w-full h-full object-cover"
                  />
                </div>
              ) : (
                <div
                  className="h-14 w-full rounded-lg border border-white/[0.08] flex items-center justify-center text-xs font-bold tracking-wide"
                  style={{
                    backgroundColor: sub.backgroundColor || canvas?.bgColor || '#141418',
                    color: sub.primaryColor || '#FFFFFF',
                  }}
                >
                  <span
                    style={{
                      fontFamily: sub.fontFamily || 'Montserrat',
                      textShadow: sub.shadowEnabled ? `0 2px 4px ${sub.shadowColor || '#000'}` : undefined,
                    }}
                  >
                    {sub.uppercase ? 'SAMPLE CAPTION STYLE' : 'Sample Caption Style'}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Captured Settings Summary */}
          <div className="p-3 rounded-lg bg-[#16161B] border border-white/[0.08] space-y-1.5 text-[11px]">
            <div className="font-semibold text-zinc-200">Reusable Settings Included</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-zinc-400">
              <div className="truncate">
                <span className="text-zinc-500">Filters:</span>{' '}
                <span className="text-zinc-200">{filterLabel}</span>
              </div>
              <div className="truncate tabular-nums">
                <span className="text-zinc-500">Effects:</span>{' '}
                <span className="text-zinc-200">{vfx.effects?.length || 0} active</span>
              </div>
              <div className="truncate">
                <span className="text-zinc-500">Captions:</span>{' '}
                <span className="text-zinc-200">
                  {sub.fontFamily} · {sub.fontSize}px
                </span>
              </div>
              <div className="truncate">
                <span className="text-zinc-500">Narrator:</span>{' '}
                <span className="text-zinc-200">{narratorText}</span>
              </div>
              <div className="truncate col-span-2">
                <span className="text-zinc-500">Canvas &amp; Dub:</span>{' '}
                <span className="text-zinc-200">
                  {canvas?.aspectRatio || 'original'} · {voice.narrationStyle || 'cinematic'} ·{' '}
                  {voice.syncMode || 'flexible'} · {Math.round((voice.voiceVolume ?? 1) * 100)}% vol
                </span>
              </div>
            </div>
            <div className="text-[10.5px] text-zinc-500 pt-1 border-t border-white/[0.06]">
              Source video files, project timestamps, caption text, and API keys are excluded.
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="accent-violet-500"
            />
            <span>Mark as Default Style</span>
          </label>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/[0.08]">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[40px] px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-200 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className="min-h-[40px] px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              <span>Save Style</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
