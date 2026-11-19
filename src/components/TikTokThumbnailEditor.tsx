import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Check,
  Cloud,
  Download,
  Eye,
  Film,
  Loader2,
  RotateCcw,
  Shield,
  Sparkles,
  Type,
  Upload,
} from 'lucide-react';
import JSZip from 'jszip';
import { Project, SavedFontAsset } from '../types/studio';
import { api } from '../lib/api';
import { downloadProjectAsset } from '../lib/supabaseCloud';
import {
  BUILTIN_FONT_CATALOG,
  ensureFontLoaded,
  getFontStatus,
  resolveClosestSupportedWeight,
  subscribeFontStatus,
} from '../lib/fontCatalog';

export type ThumbnailDesignPreset =
  | 'cinematic-viral'
  | 'bold-tiktok'
  | 'storytelling'
  | 'creative-poster'
  | 'high-impact';

export type ThumbnailSticker = 'TRENDING' | 'EXPLAINED' | 'PART 1' | 'SHOCKING' | 'NONE';

export interface ThumbnailSizePreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

export const THUMBNAIL_SIZES: ThumbnailSizePreset[] = [
  { id: '1080x1920', label: '1080×1920 (TikTok 9:16)', width: 1080, height: 1920 },
  { id: '720x1280', label: '720×1280 (HD 9:16)', width: 720, height: 1280 },
  { id: '1080x1350', label: '1080×1350 (4:5 Feed)', width: 1080, height: 1350 },
  { id: '1080x1080', label: '1080×1080 (1:1 Square)', width: 1080, height: 1080 },
  { id: '1280x720', label: '1280×720 (16:9 Wide)', width: 1280, height: 720 },
];

export interface ThumbnailItemDesign {
  index: number;
  imageUrl: string;
  preset: ThumbnailDesignPreset;
  title: string;
  subtitle: string;
  sticker: ThumbnailSticker;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  textColor: string;
  accentColor: string;
  outlineColor: string;
  outlineWidth: number;
  shadowEnabled: boolean;
  textAlign: 'left' | 'center' | 'right';
  titlePosX: number; // % 10..90
  titlePosY: number; // % 10..90
  subtitlePosX: number; // % 10..90
  subtitlePosY: number; // % 15..94
  gradientColor: string;
  overlayOpacity: number; // 0..0.95
  borderColor: string;
  borderWidth: number; // 0..24 px
  cropZoom: number; // 1.0..2.2
  cropOffsetX: number; // -50..50
  cropOffsetY: number; // -50..50
  brightness: number; // 60..140
  contrast: number; // 70..160
  saturation: number; // 50..180
  blur: number; // 0..12
  vignette: number; // 0..0.9
}

const DESIGN_PRESETS: Array<{
  id: ThumbnailDesignPreset;
  label: string;
  defaults: Omit<ThumbnailItemDesign, 'index' | 'imageUrl' | 'title' | 'subtitle'>;
}> = [
  {
    id: 'cinematic-viral',
    label: '1. Cinematic Viral',
    defaults: {
      preset: 'cinematic-viral',
      sticker: 'EXPLAINED',
      fontFamily: 'Playfair Display',
      fontSize: 82,
      fontWeight: 700,
      textColor: '#FFFFFF',
      accentColor: '#FACC15',
      outlineColor: '#09090B',
      outlineWidth: 8,
      shadowEnabled: true,
      textAlign: 'center',
      titlePosX: 50,
      titlePosY: 68,
      subtitlePosX: 50,
      subtitlePosY: 80,
      gradientColor: '#09090B',
      overlayOpacity: 0.72,
      borderColor: '#FACC15',
      borderWidth: 0,
      cropZoom: 1.04,
      cropOffsetX: 0,
      cropOffsetY: 0,
      brightness: 98,
      contrast: 116,
      saturation: 112,
      blur: 0,
      vignette: 0.45,
    },
  },
  {
    id: 'bold-tiktok',
    label: '2. Bold TikTok',
    defaults: {
      preset: 'bold-tiktok',
      sticker: 'TRENDING',
      fontFamily: 'Montserrat',
      fontSize: 88,
      fontWeight: 900,
      textColor: '#FACC15',
      accentColor: '#FFFFFF',
      outlineColor: '#000000',
      outlineWidth: 14,
      shadowEnabled: true,
      textAlign: 'center',
      titlePosX: 50,
      titlePosY: 34,
      subtitlePosX: 50,
      subtitlePosY: 78,
      gradientColor: '#1E1B4B',
      overlayOpacity: 0.62,
      borderColor: '#FACC15',
      borderWidth: 8,
      cropZoom: 1.08,
      cropOffsetX: 0,
      cropOffsetY: 0,
      brightness: 102,
      contrast: 122,
      saturation: 125,
      blur: 0,
      vignette: 0.35,
    },
  },
  {
    id: 'storytelling',
    label: '3. Storytelling',
    defaults: {
      preset: 'storytelling',
      sticker: 'PART 1',
      fontFamily: 'Poppins',
      fontSize: 74,
      fontWeight: 800,
      textColor: '#F8FAFC',
      accentColor: '#7C3AED',
      outlineColor: '#09090B',
      outlineWidth: 9,
      shadowEnabled: true,
      textAlign: 'left',
      titlePosX: 12,
      titlePosY: 64,
      subtitlePosX: 12,
      subtitlePosY: 77,
      gradientColor: '#0F172A',
      overlayOpacity: 0.78,
      borderColor: '#7C3AED',
      borderWidth: 0,
      cropZoom: 1.0,
      cropOffsetX: 0,
      cropOffsetY: 0,
      brightness: 95,
      contrast: 112,
      saturation: 105,
      blur: 0,
      vignette: 0.5,
    },
  },
  {
    id: 'creative-poster',
    label: '4. Creative Poster',
    defaults: {
      preset: 'creative-poster',
      sticker: 'NONE',
      fontFamily: 'Bebas Neue',
      fontSize: 104,
      fontWeight: 400,
      textColor: '#FFFFFF',
      accentColor: '#38BDF8',
      outlineColor: '#09090B',
      outlineWidth: 10,
      shadowEnabled: true,
      textAlign: 'center',
      titlePosX: 50,
      titlePosY: 24,
      subtitlePosX: 50,
      subtitlePosY: 82,
      gradientColor: '#020617',
      overlayOpacity: 0.65,
      borderColor: '#38BDF8',
      borderWidth: 12,
      cropZoom: 1.12,
      cropOffsetX: 0,
      cropOffsetY: 0,
      brightness: 100,
      contrast: 126,
      saturation: 115,
      blur: 0,
      vignette: 0.42,
    },
  },
  {
    id: 'high-impact',
    label: '5. High Impact',
    defaults: {
      preset: 'high-impact',
      sticker: 'SHOCKING',
      fontFamily: 'Oswald',
      fontSize: 92,
      fontWeight: 700,
      textColor: '#FFFFFF',
      accentColor: '#EF4444',
      outlineColor: '#000000',
      outlineWidth: 13,
      shadowEnabled: true,
      textAlign: 'center',
      titlePosX: 50,
      titlePosY: 62,
      subtitlePosX: 50,
      subtitlePosY: 76,
      gradientColor: '#450A0A',
      overlayOpacity: 0.7,
      borderColor: '#EF4444',
      borderWidth: 10,
      cropZoom: 1.15,
      cropOffsetX: 0,
      cropOffsetY: 0,
      brightness: 100,
      contrast: 130,
      saturation: 130,
      blur: 0,
      vignette: 0.58,
    },
  },
];

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let line = words[0];
  for (let i = 1; i < words.length; i++) {
    const candidate = `${line} ${words[i]}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
    } else {
      lines.push(line);
      line = words[i];
    }
  }
  lines.push(line);
  return lines.slice(0, 4);
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = (hex || '#000000').replace('#', '');
  const r = parseInt(clean.slice(0, 2) || '00', 16) || 0;
  const g = parseInt(clean.slice(2, 4) || '00', 16) || 0;
  const b = parseInt(clean.slice(4, 6) || '00', 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

async function drawThumbnailToCanvas(
  canvas: HTMLCanvasElement,
  design: ThumbnailItemDesign,
  width: number,
  height: number,
  customFonts: SavedFontAsset[],
  showSafeGuides: boolean
): Promise<void> {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Wait for exact font file BEFORE rendering text
  const customMatch = customFonts.find(
    (cf) => cf.family.toLowerCase() === design.fontFamily.toLowerCase()
  );
  const weight = customMatch
    ? design.fontWeight
    : resolveClosestSupportedWeight(design.fontFamily, design.fontWeight);
  await ensureFontLoaded({
    family: design.fontFamily,
    weight,
    customUrl: customMatch?.url,
  });
  if (typeof document !== 'undefined' && document.fonts) {
    await document.fonts.ready;
  }

  // Load source frame image cleanly
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`Failed to load thumbnail frame: ${design.imageUrl}`));
    img.src = design.imageUrl;
  });
  if (typeof img.decode === 'function') {
    await img.decode().catch(() => {});
  }

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#09090B';
  ctx.fillRect(0, 0, width, height);

  // Draw cover-fitted image with zoom, pan, and color filters
  ctx.save();
  ctx.filter = `brightness(${design.brightness}%) contrast(${design.contrast}%) saturate(${design.saturation}%)${
    design.blur > 0 ? ` blur(${design.blur}px)` : ''
  }`;
  const imgAR = img.naturalWidth / Math.max(1, img.naturalHeight);
  const dstAR = width / Math.max(1, height);
  let baseW = width;
  let baseH = height;
  if (imgAR > dstAR) {
    baseH = height;
    baseW = height * imgAR;
  } else {
    baseW = width;
    baseH = width / Math.max(0.01, imgAR);
  }
  const drawW = baseW * design.cropZoom;
  const drawH = baseH * design.cropZoom;
  const drawX = (width - drawW) / 2 + (design.cropOffsetX / 100) * width;
  const drawY = (height - drawH) / 2 + (design.cropOffsetY / 100) * height;
  ctx.drawImage(img, drawX, drawY, drawW, drawH);
  ctx.restore();

  // Gradient / scrim overlay for contrast readability
  if (design.overlayOpacity > 0.01) {
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, hexToRgba(design.gradientColor, design.overlayOpacity * 0.45));
    grad.addColorStop(0.45, hexToRgba(design.gradientColor, design.overlayOpacity * 0.15));
    grad.addColorStop(1, hexToRgba(design.gradientColor, Math.min(0.96, design.overlayOpacity * 1.15)));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
  }

  // Vignette
  if (design.vignette > 0.01) {
    const rad = ctx.createRadialGradient(
      width / 2,
      height / 2,
      Math.min(width, height) * 0.28,
      width / 2,
      height / 2,
      Math.max(width, height) * 0.72
    );
    rad.addColorStop(0, 'rgba(0,0,0,0)');
    rad.addColorStop(1, `rgba(0,0,0,${Math.min(0.9, design.vignette)})`);
    ctx.fillStyle = rad;
    ctx.fillRect(0, 0, width, height);
  }

  // Optional decorative frame border
  if (design.borderWidth > 0) {
    ctx.save();
    ctx.strokeStyle = design.borderColor || design.accentColor;
    ctx.lineWidth = design.borderWidth;
    const inset = design.borderWidth / 2;
    ctx.strokeRect(inset, inset, width - design.borderWidth, height - design.borderWidth);
    ctx.restore();
  }

  // Scale font metrics naturally with output width relative to 1080px
  const scaleFactor = width / 1080;
  const titleFontSize = Math.max(28, Math.round(design.fontSize * scaleFactor));
  const subFontSize = Math.max(18, Math.round(titleFontSize * 0.44));
  const maxTextWidth = width * 0.84;

  // Title + Optional Sticker Badge
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.textAlign = design.textAlign;
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const titleAnchorX =
    design.textAlign === 'left'
      ? Math.max(width * 0.08, (design.titlePosX / 100) * width)
      : design.textAlign === 'right'
      ? Math.min(width * 0.92, (design.titlePosX / 100) * width)
      : (design.titlePosX / 100) * width;
  const titleAnchorY = (design.titlePosY / 100) * height;

  ctx.font = `${weight} ${titleFontSize}px '${design.fontFamily}', sans-serif`;
  const titleLines = wrapLines(ctx, (design.title || '').toUpperCase(), maxTextWidth);
  const titleLineH = titleFontSize * 1.12;
  const titleBlockTop = titleAnchorY - ((titleLines.length - 1) * titleLineH) / 2;

  // Sticker pill just above title block
  if (design.sticker && design.sticker !== 'NONE') {
    const badgeFontSz = Math.max(16, Math.round(28 * scaleFactor));
    ctx.save();
    ctx.font = `800 ${badgeFontSz}px 'Montserrat', sans-serif`;
    const badgeText = design.sticker;
    const bw = ctx.measureText(badgeText).width + 36 * scaleFactor;
    const bh = badgeFontSz + 18 * scaleFactor;
    const bx =
      design.textAlign === 'left'
        ? titleAnchorX
        : design.textAlign === 'right'
        ? titleAnchorX - bw
        : titleAnchorX - bw / 2;
    const by = titleBlockTop - titleLineH * 0.55 - bh - 12 * scaleFactor;
    ctx.fillStyle = design.accentColor || '#FACC15';
    const r = 10 * scaleFactor;
    ctx.beginPath();
    ctx.moveTo(bx + r, by);
    ctx.lineTo(bx + bw - r, by);
    ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
    ctx.lineTo(bx + bw, by + bh - r);
    ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
    ctx.lineTo(bx + r, by + bh);
    ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
    ctx.lineTo(bx, by + r);
    ctx.quadraticCurveTo(bx, by, bx + r, by);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#09090B';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(badgeText, bx + bw / 2, by + bh / 2 + 1);
    ctx.restore();
  }

  if (design.shadowEnabled) {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
    ctx.shadowBlur = Math.round(22 * scaleFactor);
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = Math.round(6 * scaleFactor);
  }

  for (let i = 0; i < titleLines.length; i++) {
    const y = titleBlockTop + i * titleLineH;
    if (design.outlineWidth > 0) {
      ctx.strokeStyle = design.outlineColor || '#000000';
      ctx.lineWidth = Math.max(2, design.outlineWidth * scaleFactor);
      ctx.strokeText(titleLines[i], titleAnchorX, y);
    }
    ctx.fillStyle = design.textColor || '#FFFFFF';
    ctx.fillText(titleLines[i], titleAnchorX, y);
  }

  // Subtitle
  if (design.subtitle.trim()) {
    ctx.font = `700 ${subFontSize}px '${design.fontFamily}', sans-serif`;
    const subLines = wrapLines(ctx, design.subtitle.trim(), maxTextWidth);
    const subLineH = subFontSize * 1.25;
    const subAnchorX =
      design.textAlign === 'left'
        ? Math.max(width * 0.08, (design.subtitlePosX / 100) * width)
        : design.textAlign === 'right'
        ? Math.min(width * 0.92, (design.subtitlePosX / 100) * width)
        : (design.subtitlePosX / 100) * width;
    const subAnchorY = (design.subtitlePosY / 100) * height;
    const subTop = subAnchorY - ((subLines.length - 1) * subLineH) / 2;

    for (let i = 0; i < subLines.length; i++) {
      const y = subTop + i * subLineH;
      if (design.outlineWidth > 0) {
        ctx.strokeStyle = design.outlineColor || '#000000';
        ctx.lineWidth = Math.max(2, (design.outlineWidth * 0.65) * scaleFactor);
        ctx.strokeText(subLines[i], subAnchorX, y);
      }
      ctx.fillStyle = '#F4F4F5';
      ctx.fillText(subLines[i], subAnchorX, y);
    }
  }
  ctx.restore();

  // Preview-only TikTok safe area guides (never included in final downloaded blob)
  if (showSafeGuides) {
    ctx.save();
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.75)';
    ctx.lineWidth = Math.max(2, Math.round(3 * scaleFactor));
    ctx.setLineDash([14 * scaleFactor, 10 * scaleFactor]);
    const sx = width * 0.06;
    const sy = height * 0.12;
    const sw = width * 0.78;
    const sh = height * 0.7;
    ctx.strokeRect(sx, sy, sw, sh);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(9, 9, 11, 0.75)';
    ctx.fillRect(sx + 8, sy + 8, 250 * scaleFactor, 32 * scaleFactor);
    ctx.fillStyle = '#38BDF8';
    ctx.font = `600 ${Math.round(18 * scaleFactor)}px monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('TIKTOK SAFE ZONE', sx + 18, sy + 24 * scaleFactor);
    ctx.restore();
  }
}

interface TikTokThumbnailEditorProps {
  project: Project;
  customFonts?: SavedFontAsset[];
  onProjectUpdated?: (p: Project) => void;
}

export function TikTokThumbnailEditor({
  project,
  customFonts = [],
  onProjectUpdated,
}: TikTokThumbnailEditorProps) {
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const bgUploadInputRef = useRef<HTMLInputElement>(null);

  const [sizeId, setSizeId] = useState<string>('1080x1920'); // Default TikTok 9:16
  const [downloadFormat, setDownloadFormat] = useState<'png' | 'jpg'>('png');
  const [showSafeGuides, setShowSafeGuides] = useState(true);
  const [designs, setDesigns] = useState<ThumbnailItemDesign[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [downloadingIdx, setDownloadingIdx] = useState<number | null>(null);
  const [savingToProject, setSavingToProject] = useState(false);
  const [savedThumbNotice, setSavedThumbNotice] = useState<string | null>(null);
  const [zipDownloading, setZipDownloading] = useState(false);
  const [sourceModeLabel, setSourceModeLabel] = useState<string | null>(null);
  const [translationMissingWarning, setTranslationMissingWarning] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<'title' | 'subtitle'>('title');
  const [isDraggingCanvas, setIsDraggingCanvas] = useState(false);
  const [, setFontTick] = useState(0);

  const activeSize =
    THUMBNAIL_SIZES.find((s) => s.id === sizeId) || THUMBNAIL_SIZES[0];
  const activeDesign = designs[selectedIdx] || null;

  useEffect(() => {
    const unsub = subscribeFontStatus(() => setFontTick((t) => t + 1));
    return unsub;
  }, []);

  // Re-render interactive live canvas preview whenever active design changes
  useEffect(() => {
    if (!activeDesign || !previewCanvasRef.current) return;
    let cancelled = false;
    void drawThumbnailToCanvas(
      previewCanvasRef.current,
      activeDesign,
      activeSize.width,
      activeSize.height,
      customFonts,
      showSafeGuides
    ).catch((err) => {
      if (!cancelled) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeDesign, activeSize, customFonts, showSafeGuides]);

  const handleGenerate = async () => {
    setErrorMsg(null);
    setGenerating(true);
    try {
      const res = await api.generateThumbnails(project.id);
      const urls = res.thumbnails || [];
      const titles = res.suggestedTitles || [];
      setTranslationMissingWarning(Boolean(res.translationMissingWarning));
      setSourceModeLabel(
        res.sourceMode === 'final-export'
          ? 'Frames extracted from Final Exported Video'
          : 'Frames extracted from Edited Source Video (cropped & graded)'
      );

      const nextDesigns: ThumbnailItemDesign[] = urls.map((url, idx) => {
        const presetDef = DESIGN_PRESETS[idx % DESIGN_PRESETS.length];
        const title = titles[idx] || res.suggestedTitle || project.name || 'Movie Recap';
        return {
          ...presetDef.defaults,
          index: idx,
          imageUrl: url,
          title,
          subtitle: res.suggestedSubtitle || '',
        };
      });
      setDesigns(nextDesigns);
      setSelectedIdx(0);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  const updateActiveDesign = (patch: Partial<ThumbnailItemDesign>) => {
    setDesigns((prev) =>
      prev.map((d, idx) => (idx === selectedIdx ? { ...d, ...patch } : d))
    );
  };

  const applyPresetToActive = (presetId: ThumbnailDesignPreset) => {
    const def = DESIGN_PRESETS.find((p) => p.id === presetId);
    if (!def) return;
    updateActiveDesign({ ...def.defaults });
  };

  const renderDesignBlob = async (design: ThumbnailItemDesign, fmt: 'png' | 'jpg'): Promise<Blob> => {
    const offscreen = document.createElement('canvas');
    await drawThumbnailToCanvas(
      offscreen,
      design,
      activeSize.width,
      activeSize.height,
      customFonts,
      false // Never burn safe guides into exported image
    );
    return new Promise<Blob>((resolve, reject) => {
      offscreen.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Failed to encode thumbnail image blob.'));
        },
        fmt === 'png' ? 'image/png' : 'image/jpeg',
        0.95
      );
    });
  };

  const handleDownloadSingle = async (idx: number) => {
    const target = designs[idx];
    if (!target) return;
    setErrorMsg(null);
    setDownloadingIdx(idx);
    try {
      const blob = await renderDesignBlob(target, downloadFormat);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${project.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_tiktok_thumb_${idx + 1}_${
        activeSize.width
      }x${activeSize.height}.${downloadFormat}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloadingIdx(null);
    }
  };

  const handleDownloadAllZip = async () => {
    if (designs.length === 0) return;
    setErrorMsg(null);
    setZipDownloading(true);
    try {
      const zip = new JSZip();
      const folder = zip.folder('tiktok_thumbnails');
      for (let i = 0; i < designs.length; i++) {
        const blob = await renderDesignBlob(designs[i], downloadFormat);
        folder?.file(
          `thumbnail_${i + 1}_${designs[i].preset}_${activeSize.width}x${activeSize.height}.${downloadFormat}`,
          blob
        );
      }
      const content = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${project.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_tiktok_thumbnails_5pack.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setZipDownloading(false);
    }
  };

  const handleSaveSelectedToProject = async () => {
    const target = designs[selectedIdx];
    if (!target) return;
    setErrorMsg(null);
    setSavedThumbNotice(null);
    setSavingToProject(true);
    try {
      const blob = await renderDesignBlob(target, downloadFormat);
      const res = await api.saveProjectThumbnail(project.id, {
        blob,
        label: target.title || `Thumbnail #${selectedIdx + 1}`,
        width: activeSize.width,
        height: activeSize.height,
        format: downloadFormat,
        setAsCover: true,
      });
      onProjectUpdated?.(res.project);
      setSavedThumbNotice(`Saved Thumbnail #${selectedIdx + 1} to project & cloud manifest.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingToProject(false);
    }
  };

  const handleCanvasPointer = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!activeDesign || !previewCanvasRef.current) return;
    const rect = previewCanvasRef.current.getBoundingClientRect();
    const xPct = Math.round(Math.max(8, Math.min(92, ((e.clientX - rect.left) / rect.width) * 100)));
    const yPct = Math.round(Math.max(10, Math.min(92, ((e.clientY - rect.top) / rect.height) * 100)));
    if (dragTarget === 'title') {
      updateActiveDesign({ titlePosX: xPct, titlePosY: yPct });
    } else {
      updateActiveDesign({ subtitlePosX: xPct, subtitlePosY: yPct });
    }
  };

  const activeFontStatus = activeDesign
    ? getFontStatus(
        activeDesign.fontFamily,
        resolveClosestSupportedWeight(activeDesign.fontFamily, activeDesign.fontWeight)
      )
    : null;

  return (
    <div className="p-5 rounded-xl bg-[#111115] border border-white/[0.08] space-y-4">
      {/* Header & Top Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-display font-semibold text-white flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-violet-400" />
            TikTok Thumbnail Studio
          </h2>
          <p className="text-xs text-zinc-400">
            Generate 5 cover designs using your video frames and translated story text.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={sizeId}
            onChange={(e) => setSizeId(e.target.value)}
            className="bg-zinc-900 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 font-mono"
            aria-label="Thumbnail Output Resolution"
          >
            {THUMBNAIL_SIZES.map((sz) => (
              <option key={sz.id} value={sz.id}>
                {sz.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={generating || !project.sourceVideoUrl}
            className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-45 text-xs font-semibold text-white flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            {generating ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5" />
            )}
            {designs.length > 0 ? 'Regenerate 5 Thumbnails' : 'Generate 5 Thumbnails'}
          </button>
        </div>
      </div>

      {sourceModeLabel && (
        <div className="text-[11px] font-mono text-emerald-300/90 flex items-center gap-1.5">
          <Check className="w-3.5 h-3.5 text-emerald-400" />
          {sourceModeLabel}
        </div>
      )}

      {translationMissingWarning && (
        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/35 text-xs text-amber-200 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <span>
            No translated script found yet — titles default to the project name.
          </span>
        </div>
      )}

      {errorMsg && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-200">
          {errorMsg}
        </div>
      )}

      {designs.length > 0 && activeDesign && (
        <div className="space-y-4 pt-1">
          {/* 5 Thumbnail Option Cards with Dedicated Download Button Each */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {designs.map((d, idx) => {
              const isSelected = idx === selectedIdx;
              const presetLabel = DESIGN_PRESETS.find((p) => p.id === d.preset)?.label || `Option #${idx + 1}`;
              return (
                <div
                  key={idx}
                  onClick={() => setSelectedIdx(idx)}
                  className={`rounded-lg overflow-hidden border transition-all cursor-pointer bg-[#18181D] flex flex-col ${
                    isSelected
                      ? 'border-violet-500 ring-2 ring-violet-500/40'
                      : 'border-white/[0.08] hover:border-white/[0.22]'
                  }`}
                >
                  <div className="relative aspect-[9/16] max-h-36 bg-black overflow-hidden">
                    <img
                      src={d.imageUrl}
                      alt={`Thumbnail frame ${idx + 1}`}
                      className="w-full h-full object-cover"
                    />
                    <div
                      className="absolute inset-0 flex flex-col justify-end p-2 text-center"
                      style={{
                        background: `linear-gradient(to top, ${hexToRgba(
                          d.gradientColor,
                          Math.min(0.9, d.overlayOpacity)
                        )} 0%, transparent 65%)`,
                      }}
                    >
                      <span
                        className="text-[10px] font-black leading-tight line-clamp-2 uppercase drop-shadow"
                        style={{ color: d.textColor }}
                      >
                        {d.title}
                      </span>
                    </div>
                    <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/75 text-[9px] font-mono text-zinc-200">
                      #{idx + 1}
                    </span>
                  </div>

                  <div className="p-1.5 flex items-center justify-between gap-1 border-t border-white/[0.06]">
                    <span className="text-[9.5px] font-medium text-zinc-300 truncate">
                      {presetLabel}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDownloadSingle(idx);
                      }}
                      disabled={downloadingIdx === idx}
                      title={`Download Thumbnail #${idx + 1} (${downloadFormat.toUpperCase()})`}
                      className="px-1.5 py-0.5 rounded bg-violet-600/80 hover:bg-violet-500 text-white text-[9.5px] font-semibold flex items-center gap-0.5 shrink-0 cursor-pointer"
                    >
                      {downloadingIdx === idx ? (
                        <Loader2 className="w-2.5 h-2.5 animate-spin" />
                      ) : (
                        <Download className="w-2.5 h-2.5" />
                      )}
                      #{idx + 1}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Selected Thumbnail Interactive Canvas & Full Creative Inspector */}
          <div className="p-4 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] pb-3">
              <div>
                <div className="text-xs font-semibold text-white">
                  Editing Thumbnail #{selectedIdx + 1} — {activeSize.width}×{activeSize.height}px
                </div>
                <p className="text-[11px] text-zinc-400">
                  Drag directly on the canvas to position {dragTarget === 'title' ? 'Main Title' : 'Subtitle'}.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowSafeGuides(!showSafeGuides)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium border flex items-center gap-1 cursor-pointer ${
                    showSafeGuides
                      ? 'bg-cyan-500/20 border-cyan-500/40 text-cyan-300'
                      : 'bg-zinc-900 border-white/[0.08] text-zinc-400'
                  }`}
                >
                  <Shield className="w-3 h-3" />
                  Safe Zone
                </button>

                <div className="flex items-center bg-zinc-900 border border-white/[0.08] rounded-md p-0.5 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setDragTarget('title')}
                    className={`px-2 py-0.5 rounded cursor-pointer ${
                      dragTarget === 'title' ? 'bg-violet-600 text-white' : 'text-zinc-400'
                    }`}
                  >
                    Drag Title
                  </button>
                  <button
                    type="button"
                    onClick={() => setDragTarget('subtitle')}
                    className={`px-2 py-0.5 rounded cursor-pointer ${
                      dragTarget === 'subtitle' ? 'bg-violet-600 text-white' : 'text-zinc-400'
                    }`}
                  >
                    Drag Subtitle
                  </button>
                </div>

                <div className="flex items-center bg-zinc-900 border border-white/[0.08] rounded-md p-0.5 text-[11px]">
                  {(['png', 'jpg'] as const).map((fmt) => (
                    <button
                      key={fmt}
                      type="button"
                      onClick={() => setDownloadFormat(fmt)}
                      className={`px-2 py-0.5 rounded uppercase font-mono cursor-pointer ${
                        downloadFormat === fmt ? 'bg-emerald-600 text-white' : 'text-zinc-400'
                      }`}
                    >
                      {fmt}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
              {/* High-Resolution Interactive Canvas Preview */}
              <div className="lg:col-span-5 flex flex-col items-center gap-3">
                <div className="w-full flex items-center justify-center bg-[#09090B] border border-white/[0.08] rounded-xl p-3">
                  <canvas
                    ref={previewCanvasRef}
                    onMouseDown={(e) => {
                      setIsDraggingCanvas(true);
                      handleCanvasPointer(e);
                    }}
                    onMouseMove={(e) => {
                      if (isDraggingCanvas) handleCanvasPointer(e);
                    }}
                    onMouseUp={() => setIsDraggingCanvas(false)}
                    onMouseLeave={() => setIsDraggingCanvas(false)}
                    style={{
                      aspectRatio: `${activeSize.width} / ${activeSize.height}`,
                      maxHeight: '460px',
                      maxWidth: '100%',
                    }}
                    className="rounded-lg shadow-2xl cursor-crosshair bg-black"
                  />
                </div>

                <div className="w-full flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => void handleDownloadSingle(selectedIdx)}
                    disabled={downloadingIdx === selectedIdx}
                    className="flex-1 px-3 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-xs font-semibold text-white flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    {downloadingIdx === selectedIdx ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Download className="w-3.5 h-3.5" />
                    )}
                    Download #{selectedIdx + 1} ({downloadFormat.toUpperCase()})
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSaveSelectedToProject()}
                    disabled={savingToProject}
                    className="px-3 py-2 rounded-lg bg-emerald-600/80 hover:bg-emerald-500 disabled:opacity-50 text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer"
                  >
                    {savingToProject ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Cloud className="w-3.5 h-3.5" />
                    )}
                    Save to Project
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDownloadAllZip()}
                    disabled={zipDownloading}
                    className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-xs font-semibold text-zinc-100 flex items-center gap-1.5 cursor-pointer"
                  >
                    {zipDownloading ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Archive className="w-3.5 h-3.5 text-violet-400" />
                    )}
                    ZIP (All 5)
                  </button>
                </div>
                {savedThumbNotice && (
                  <div className="w-full text-[11px] text-emerald-300 text-center">
                    {savedThumbNotice}
                  </div>
                )}
              </div>

              {/* Creative Design & Typography Controls */}
              <div className="lg:col-span-7 space-y-3.5 text-xs">
                {/* Change Background Screen / Image */}
                <div className="p-3 rounded-xl bg-zinc-900/80 border border-white/[0.08] space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-white flex items-center gap-1.5">
                      <Film className="w-3.5 h-3.5 text-violet-400" />
                      Background Screen / Frame (Change Screen)
                    </span>
                    <input
                      ref={bgUploadInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const blobUrl = URL.createObjectURL(file);
                        updateActiveDesign({ imageUrl: blobUrl });
                        e.target.value = '';
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => bgUploadInputRef.current?.click()}
                      className="px-2.5 py-1 rounded bg-violet-600 hover:bg-violet-500 text-white text-[11px] font-medium flex items-center gap-1 cursor-pointer"
                    >
                      <Upload className="w-3 h-3" />
                      Upload Custom Screen
                    </button>
                  </div>
                  {project.thumbnailUrl && (
                    <div className="flex items-center gap-2 pt-1 text-[11px] text-zinc-400">
                      <span>Quick source:</span>
                      <button
                        type="button"
                        onClick={() => updateActiveDesign({ imageUrl: project.thumbnailUrl! })}
                        className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 cursor-pointer"
                      >
                        Use Project Thumbnail
                      </button>
                    </div>
                  )}
                </div>

                {/* 5 Design Styles Switcher */}
                <div className="space-y-1.5">
                  <span className="text-[11px] text-zinc-400 font-medium">Creative Design Style</span>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                    {DESIGN_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => applyPresetToActive(p.id)}
                        className={`py-1.5 px-2 rounded-lg text-[11px] font-medium border transition-colors cursor-pointer ${
                          activeDesign.preset === p.id
                            ? 'bg-emerald-600/25 border-emerald-500 text-emerald-200'
                            : 'bg-zinc-900 border-white/[0.06] text-zinc-300 hover:bg-zinc-800'
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Title, Subtitle & Sticker */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div>
                    <label className="text-[11px] text-zinc-400">Main Headline Title</label>
                    <input
                      type="text"
                      value={activeDesign.title}
                      onChange={(e) => updateActiveDesign({ title: e.target.value })}
                      className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded-md px-2.5 py-1.5 text-xs text-zinc-100"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-zinc-400">Subtitle / Hook</label>
                    <input
                      type="text"
                      value={activeDesign.subtitle}
                      onChange={(e) => updateActiveDesign({ subtitle: e.target.value })}
                      className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded-md px-2.5 py-1.5 text-xs text-zinc-100"
                    />
                  </div>
                </div>

                {/* Font, Sticker & Text Align */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <div>
                    <div className="flex items-center justify-between text-[11px] text-zinc-400">
                      <span className="flex items-center gap-1">
                        <Type className="w-3 h-3" /> Font Family
                      </span>
                      {activeFontStatus?.status === 'loaded' && (
                        <span className="text-[9.5px] font-mono text-emerald-400">Loaded</span>
                      )}
                      {activeFontStatus?.status === 'error' && (
                        <span className="text-[9.5px] font-mono text-red-400">Unavailable</span>
                      )}
                    </div>
                    <select
                      value={activeDesign.fontFamily}
                      onChange={(e) => updateActiveDesign({ fontFamily: e.target.value })}
                      className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded-md px-2 py-1.5 text-xs text-zinc-100"
                    >
                      {BUILTIN_FONT_CATALOG.map((f) => (
                        <option key={f.family} value={f.family}>
                          {f.family} ({f.category})
                        </option>
                      ))}
                      {customFonts.map((cf) => (
                        <option key={cf.id} value={cf.family}>
                          {cf.family} (Custom)
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="text-[11px] text-zinc-400">Badge / Sticker</label>
                    <select
                      value={activeDesign.sticker}
                      onChange={(e) =>
                        updateActiveDesign({ sticker: e.target.value as ThumbnailSticker })
                      }
                      className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded-md px-2 py-1.5 text-xs text-zinc-100"
                    >
                      <option value="TRENDING">TRENDING</option>
                      <option value="EXPLAINED">EXPLAINED</option>
                      <option value="PART 1">PART 1</option>
                      <option value="SHOCKING">SHOCKING</option>
                      <option value="NONE">None</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-[11px] text-zinc-400">Alignment</label>
                    <div className="mt-1 grid grid-cols-3 gap-1">
                      {(['left', 'center', 'right'] as const).map((al) => (
                        <button
                          key={al}
                          type="button"
                          onClick={() => updateActiveDesign({ textAlign: al })}
                          className={`py-1 rounded border text-[11px] capitalize cursor-pointer ${
                            activeDesign.textAlign === al
                              ? 'bg-violet-600 border-violet-500 text-white'
                              : 'bg-zinc-900 border-white/[0.08] text-zinc-400'
                          }`}
                        >
                          {al}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Colors: Text, Accent, Outline, Gradient, Border */}
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                  {[
                    { key: 'textColor' as const, label: 'Text' },
                    { key: 'accentColor' as const, label: 'Badge' },
                    { key: 'outlineColor' as const, label: 'Stroke' },
                    { key: 'gradientColor' as const, label: 'Overlay' },
                    { key: 'borderColor' as const, label: 'Border' },
                  ].map((c) => (
                    <label
                      key={c.key}
                      className="p-1.5 rounded bg-zinc-900 border border-white/[0.08] flex items-center justify-between gap-1 cursor-pointer"
                    >
                      <span className="text-[10.5px] text-zinc-300">{c.label}</span>
                      <input
                        type="color"
                        value={activeDesign[c.key]}
                        onChange={(e) => updateActiveDesign({ [c.key]: e.target.value })}
                        className="w-6 h-5 rounded bg-transparent cursor-pointer"
                      />
                    </label>
                  ))}
                </div>

                {/* Typography & Overlay Sliders */}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 p-3 rounded-lg bg-zinc-900/70 border border-white/[0.06]">
                  <div>
                    <div className="flex justify-between text-[10.5px] text-zinc-300">
                      <span>Font Size</span>
                      <span className="font-mono">{activeDesign.fontSize}px</span>
                    </div>
                    <input
                      type="range"
                      min={36}
                      max={150}
                      value={activeDesign.fontSize}
                      onChange={(e) => updateActiveDesign({ fontSize: Number(e.target.value) })}
                      className="mt-1 w-full accent-violet-500"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between text-[10.5px] text-zinc-300">
                      <span>Outline Width</span>
                      <span className="font-mono">{activeDesign.outlineWidth}px</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={24}
                      value={activeDesign.outlineWidth}
                      onChange={(e) => updateActiveDesign({ outlineWidth: Number(e.target.value) })}
                      className="mt-1 w-full accent-violet-500"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between text-[10.5px] text-zinc-300">
                      <span>Overlay Darken</span>
                      <span className="font-mono">{Math.round(activeDesign.overlayOpacity * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={0.95}
                      step={0.05}
                      value={activeDesign.overlayOpacity}
                      onChange={(e) => updateActiveDesign({ overlayOpacity: Number(e.target.value) })}
                      className="mt-1 w-full accent-violet-500"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between text-[10.5px] text-zinc-300">
                      <span>Frame Zoom</span>
                      <span className="font-mono">{Math.round(activeDesign.cropZoom * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={2.2}
                      step={0.02}
                      value={activeDesign.cropZoom}
                      onChange={(e) => updateActiveDesign({ cropZoom: Number(e.target.value) })}
                      className="mt-1 w-full accent-emerald-500"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between text-[10.5px] text-zinc-300">
                      <span>Contrast</span>
                      <span className="font-mono">{activeDesign.contrast}%</span>
                    </div>
                    <input
                      type="range"
                      min={70}
                      max={160}
                      value={activeDesign.contrast}
                      onChange={(e) => updateActiveDesign({ contrast: Number(e.target.value) })}
                      className="mt-1 w-full accent-amber-500"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between text-[10.5px] text-zinc-300">
                      <span>Border Width</span>
                      <span className="font-mono">{activeDesign.borderWidth}px</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={24}
                      value={activeDesign.borderWidth}
                      onChange={(e) => updateActiveDesign({ borderWidth: Number(e.target.value) })}
                      className="mt-1 w-full accent-cyan-500"
                    />
                  </div>
                </div>

                {/* Reset Text Positions + Drop Shadow toggle */}
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                  <label className="flex items-center gap-1.5 text-zinc-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={activeDesign.shadowEnabled}
                      onChange={(e) => updateActiveDesign({ shadowEnabled: e.target.checked })}
                      className="accent-violet-500"
                    />
                    Drop Shadow
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      updateActiveDesign({
                        titlePosX: 50,
                        titlePosY: 66,
                        subtitlePosX: 50,
                        subtitlePosY: 79,
                        cropZoom: 1.04,
                        cropOffsetX: 0,
                        cropOffsetY: 0,
                      })
                    }
                    className="px-2.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 border border-white/[0.08] text-zinc-300 flex items-center gap-1 cursor-pointer"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Reset Positions &amp; Crop
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {designs.length === 0 && (
        <div className="py-8 text-center rounded-lg border border-dashed border-white/[0.1] bg-[#18181D]/60 space-y-1.5">
          <Eye className="w-5 h-5 text-zinc-500 mx-auto" />
          <div className="text-xs font-medium text-zinc-300">
            Click &ldquo;Generate 5 Thumbnails&rdquo; to create 5 custom TikTok thumbnail designs
          </div>
          <p className="text-[11px] text-zinc-500">
            Default output size: {activeSize.width}×{activeSize.height}px · PNG / JPG · Save &amp; sync across devices
          </p>
        </div>
      )}

      {(project.savedThumbnails?.length || 0) > 0 && (
        <div className="pt-3 border-t border-white/[0.08] space-y-2.5">
          <div className="text-xs font-semibold text-zinc-200 flex items-center justify-between">
            <span>Saved Project Thumbnails (Synced Across Devices)</span>
            <span className="text-[11px] font-mono text-zinc-500 tabular-nums">
              {project.savedThumbnails!.length} saved
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            {project.savedThumbnails!.map((st) => (
              <div
                key={st.id}
                className="rounded-lg bg-[#18181D] border border-white/[0.08] overflow-hidden flex flex-col"
              >
                <div className="aspect-[9/16] max-h-32 bg-black overflow-hidden">
                  <img
                    src={st.url}
                    alt={st.label}
                    className="w-full h-full object-cover"
                  />
                </div>
                <div className="p-2 flex items-center justify-between gap-1.5 text-[11px]">
                  <span className="truncate text-zinc-300">{st.label}</span>
                  <button
                    type="button"
                    onClick={() =>
                      void downloadProjectAsset({
                        url: st.url,
                        cloudAssets: project.cloudAssets,
                        filename: `${project.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_thumb_${st.id.slice(
                          0,
                          6
                        )}.${st.format}`,
                      }).catch((err) =>
                        setErrorMsg(err instanceof Error ? err.message : String(err))
                      )
                    }
                    className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100 inline-flex items-center gap-1 shrink-0 cursor-pointer"
                  >
                    <Download className="w-3 h-3" />
                    {st.format.toUpperCase()}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
