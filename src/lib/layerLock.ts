import { getBlurTimelineSpan } from './blurMasks';
import { getEffectCatalogEntry, getFilterPresetMeta } from './videoFiltersCatalog';
import {
  findActiveTimelineAudioAtTime,
  findActiveVideoClipAtTime,
  getEffectiveBgmClips,
  getEffectiveOriginalAudioClips,
  getEffectiveSfxClips,
  getEffectiveVideoClips,
  getOriginalAudioClipTimelineEnd,
  getProjectEffectiveDuration,
  getTimelineAudioClipEnd,
  getVideoClipTimelineEnd,
  getVideoTimelineTotalDuration,
} from './videoTimeline';
import { getSyncedCaptionsForPreview } from './workflowStages';
import {
  DEFAULT_VIDEO_CANVAS,
  DEFAULT_VIDEO_EFFECTS,
  Project,
  StudioElementSelection,
} from '../types/studio';

export const LOCKED_LAYER_MESSAGE = 'Layer is locked. Unlock it to edit.';

export type TimelineTrackId =
  | 'video'
  | 'captions'
  | 'dub'
  | 'orig'
  | 'bgm'
  | 'sfx'
  | 'overlays'
  | 'blur'
  | 'filters'
  | 'effects';

export interface SelectedLayerTimingInfo {
  label: string;
  category: string;
  start: number;
  end: number;
  duration: number;
  locked: boolean;
  fps?: number;
  startFrame?: number;
  endFrame?: number;
  durationFrames?: number;
}

function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function isTrackLocked(project: Project, trackId: TimelineTrackId): boolean {
  switch (trackId) {
    case 'video':
      return Boolean(project.canvas?.videoLocked);
    case 'captions':
      return Boolean(project.subtitleStyle?.locked);
    case 'dub':
      return Boolean(project.voice?.dubLocked);
    case 'orig':
      return Boolean(project.voice?.origLocked);
    case 'bgm':
      return Boolean(project.voice?.bgmLocked);
    case 'sfx':
      return Boolean(project.voice?.sfxLocked);
    case 'overlays': {
      const extras = project.subtitleStyle?.extraElements || [];
      const total = project.logos.length + extras.length;
      if (total === 0) return false;
      return (
        project.logos.every((l) => Boolean(l.locked)) &&
        extras.every((el) => Boolean(el.locked))
      );
    }
    case 'blur':
      return project.blurs.length > 0 && project.blurs.every((b) => Boolean(b.locked));
    case 'filters': {
      const fxConfig = project.videoEffects || DEFAULT_VIDEO_EFFECTS;
      const stack = fxConfig.filterStack || [];
      if (stack.length > 0) return stack.every((f) => Boolean(f.locked));
      return Boolean(fxConfig.globalFilterLocked);
    }
    case 'effects': {
      const effects = project.videoEffects?.effects || [];
      return effects.length > 0 && effects.every((fx) => Boolean(fx.locked));
    }
    default:
      return false;
  }
}

export function isClipOrLayerLocked(
  project: Project,
  sel: StudioElementSelection,
  currentTime = 0
): boolean {
  if (!sel) {
    if (project.canvas?.videoLocked) return true;
    const clips = getEffectiveVideoClips(project);
    const active = findActiveVideoClipAtTime(clips, currentTime)?.clip || clips[0];
    return Boolean(active?.locked);
  }

  switch (sel.kind) {
    case 'video': {
      if (project.canvas?.videoLocked) return true;
      const clips = getEffectiveVideoClips(project);
      const target =
        (sel.clipId ? clips.find((c) => c.id === sel.clipId) : null) ||
        findActiveVideoClipAtTime(clips, currentTime)?.clip ||
        clips[0];
      return Boolean(target?.locked);
    }
    case 'bg-image':
      return Boolean(project.canvas?.bgImageLocked);
    case 'blur': {
      const b = project.blurs.find((x) => x.id === sel.id);
      return Boolean(b?.locked);
    }
    case 'logo': {
      const l = project.logos.find((x) => x.id === sel.id);
      return Boolean(l?.locked);
    }
    case 'caption-element': {
      const el = (project.subtitleStyle?.extraElements || []).find((x) => x.id === sel.id);
      return Boolean(el?.locked);
    }
    case 'captions': {
      if (project.subtitleStyle?.locked) return true;
      if (sel.segmentId) {
        const seg = project.captions.find((c) => c.id === sel.segmentId);
        return Boolean(seg?.locked);
      }
      const synced = getSyncedCaptionsForPreview(project);
      const active = synced.find(
        (c) => currentTime >= c.syncedStart && currentTime <= c.syncedEnd
      );
      if (active) {
        const raw = project.captions.find((c) => c.id === active.id);
        return Boolean(raw?.locked);
      }
      return false;
    }
    case 'audio': {
      const track = sel.track;
      if (track === 'orig') {
        if (project.voice?.origLocked) return true;
        if (sel.clipId) {
          const oa = getEffectiveOriginalAudioClips(project).find((c) => c.id === sel.clipId);
          return Boolean(oa?.locked);
        }
        return false;
      }
      if (track === 'bgm') {
        if (project.voice?.bgmLocked) return true;
        if (sel.clipId) {
          const bc = getEffectiveBgmClips(project).find((c) => c.id === sel.clipId);
          return Boolean(bc?.locked);
        }
        return false;
      }
      if (track === 'sfx') {
        if (project.voice?.sfxLocked) return true;
        if (sel.clipId) {
          const sc = getEffectiveSfxClips(project).find((c) => c.id === sel.clipId);
          return Boolean(sc?.locked);
        }
        return false;
      }
      // 'dub' or default
      if (project.voice?.dubLocked) return true;
      if (sel.clipId) {
        const dc = (project.voice?.generatedClips || []).find(
          (c) => c.segmentId === sel.clipId
        );
        return Boolean(dc?.locked);
      }
      return false;
    }
    case 'filter': {
      const fxConfig = project.videoEffects || DEFAULT_VIDEO_EFFECTS;
      if (sel.filterId) {
        const fl = (fxConfig.filterStack || []).find((f) => f.id === sel.filterId);
        return Boolean(fl?.locked);
      }
      return Boolean(fxConfig.globalFilterLocked);
    }
    case 'effect': {
      const fxConfig = project.videoEffects || DEFAULT_VIDEO_EFFECTS;
      if (sel.effectId) {
        const fx = (fxConfig.effects || []).find((e) => e.id === sel.effectId);
        return Boolean(fx?.locked);
      }
      return false;
    }
    default:
      return false;
  }
}

export function getSelectedLayerTiming(
  project: Project,
  selection: StudioElementSelection,
  currentTime = 0
): SelectedLayerTimingInfo | null {
  if (!selection) return null;

  const effDur = getProjectEffectiveDuration(project);
  const srcDur = Math.max(0.5, project.metadata?.duration || effDur);
  const fpsRaw = project.metadata?.fps;
  const fps = fpsRaw && Number.isFinite(fpsRaw) && fpsRaw > 0 ? Math.round(fpsRaw * 100) / 100 : undefined;

  const build = (
    label: string,
    category: string,
    rawStart: number,
    rawEnd: number,
    locked: boolean
  ): SelectedLayerTimingInfo => {
    const start = Math.max(0, r3(rawStart));
    const end = Math.max(start, r3(rawEnd));
    const duration = Math.max(0, r3(end - start));
    if (fps) {
      const startFrame = Math.round(start * fps);
      const endFrame = Math.round(end * fps);
      return {
        label,
        category,
        start,
        end,
        duration,
        locked,
        fps,
        startFrame,
        endFrame,
        durationFrames: Math.max(0, endFrame - startFrame),
      };
    }
    return { label, category, start, end, duration, locked };
  };

  switch (selection.kind) {
    case 'video': {
      const clips = getEffectiveVideoClips(project);
      const target =
        (selection.clipId ? clips.find((c) => c.id === selection.clipId) : null) ||
        findActiveVideoClipAtTime(clips, currentTime)?.clip ||
        clips[0];
      if (!target) {
        return build('Main Video', 'Video', 0, srcDur, Boolean(project.canvas?.videoLocked));
      }
      return build(
        target.label || 'Main Video',
        'Video',
        target.timelineStart,
        getVideoClipTimelineEnd(target),
        Boolean(project.canvas?.videoLocked || target.locked)
      );
    }
    case 'bg-image':
      return build(
        project.canvas?.bgImageFilename || 'Background Fill',
        'Canvas',
        0,
        effDur,
        Boolean(project.canvas?.bgImageLocked)
      );
    case 'captions': {
      const synced = getSyncedCaptionsForPreview(project);
      const target =
        (selection.segmentId ? synced.find((c) => c.id === selection.segmentId) : null) ||
        synced.find((c) => currentTime >= c.syncedStart && currentTime <= c.syncedEnd) ||
        synced[0];
      if (!target) {
        return build(
          'Captions Track',
          'Captions',
          0,
          effDur,
          Boolean(project.subtitleStyle?.locked)
        );
      }
      const rawCap = project.captions.find((c) => c.id === target.id);
      const snippet = (target.translatedText || target.text || '').trim().slice(0, 28) || 'Caption';
      return build(
        snippet,
        'Caption',
        target.syncedStart,
        target.syncedEnd,
        Boolean(project.subtitleStyle?.locked || rawCap?.locked)
      );
    }
    case 'caption-element': {
      const el = (project.subtitleStyle?.extraElements || []).find((x) => x.id === selection.id);
      if (!el) return null;
      const start = Math.max(0, el.startTime || 0);
      const end = el.endTime > start ? el.endTime : effDur;
      return build(el.label || el.text || 'Text Layer', 'Text', start, end, Boolean(el.locked));
    }
    case 'logo': {
      const l = project.logos.find((x) => x.id === selection.id);
      if (!l) return null;
      const start = l.permanent ? 0 : Math.max(0, l.startTime || 0);
      const end = l.permanent ? effDur : Math.max(start + 0.1, l.endTime || effDur);
      return build(l.filename || 'Logo Overlay', 'Overlay', start, end, Boolean(l.locked));
    }
    case 'blur': {
      const b = project.blurs.find((x) => x.id === selection.id);
      if (!b) return null;
      const span = getBlurTimelineSpan(b, project);
      return build(b.name || 'Blur Mask', 'Blur', span.startTime, span.endTime, Boolean(b.locked));
    }
    case 'audio': {
      const track = selection.track || 'dub';
      if (track === 'orig') {
        const origClips = getEffectiveOriginalAudioClips(project);
        if (origClips.length > 0) {
          const oa =
            (selection.clipId ? origClips.find((c) => c.id === selection.clipId) : null) ||
            origClips.find(
              (c) => currentTime >= c.timelineStart && currentTime <= getOriginalAudioClipTimelineEnd(c)
            ) ||
            origClips[0];
          if (oa) {
            return build(
              oa.label || 'Original Audio',
              'Orig Audio',
              oa.timelineStart,
              getOriginalAudioClipTimelineEnd(oa),
              Boolean(project.voice?.origLocked || oa.locked)
            );
          }
        }
        const vClips = getEffectiveVideoClips(project);
        const start = vClips[0]?.timelineStart ?? 0;
        const end = vClips.length > 0 ? getVideoTimelineTotalDuration(vClips) : srcDur;
        return build(
          'Original Audio (Linked)',
          'Orig Audio',
          start,
          end,
          Boolean(project.voice?.origLocked)
        );
      }
      if (track === 'bgm') {
        const bgmClips = getEffectiveBgmClips(project, effDur);
        const bc =
          (selection.clipId ? bgmClips.find((c) => c.id === selection.clipId) : null) ||
          findActiveTimelineAudioAtTime(bgmClips, currentTime)?.clip ||
          bgmClips[0];
        if (bc) {
          return build(
            bc.label || project.voice.bgMusicFilename || 'Music',
            'Music',
            bc.timelineStart,
            getTimelineAudioClipEnd(bc),
            Boolean(project.voice?.bgmLocked || bc.locked)
          );
        }
        return build('Background Music', 'Music', 0, effDur, Boolean(project.voice?.bgmLocked));
      }
      if (track === 'sfx') {
        const sfxClips = getEffectiveSfxClips(project, effDur);
        const sc =
          (selection.clipId ? sfxClips.find((c) => c.id === selection.clipId) : null) ||
          findActiveTimelineAudioAtTime(sfxClips, currentTime)?.clip ||
          sfxClips[0];
        if (sc) {
          return build(
            sc.label || project.voice.sfxFilename || 'SFX',
            'SFX',
            sc.timelineStart,
            getTimelineAudioClipEnd(sc),
            Boolean(project.voice?.sfxLocked || sc.locked)
          );
        }
        return build('Sound Effect', 'SFX', 0, effDur, Boolean(project.voice?.sfxLocked));
      }
      // dub track
      const dubOffset = Number(project.voice?.timingOffsetSec || 0);
      const genClips = project.voice?.generatedClips || [];
      if (genClips.length > 0 && selection.clipId) {
        const dc = genClips.find((c) => c.segmentId === selection.clipId);
        if (dc) {
          const start = Math.max(0, dc.start + dubOffset);
          const end = Math.max(start + 0.1, dc.end + dubOffset);
          return build(
            dc.text?.trim().slice(0, 26) || 'Narration Clip',
            'Narration',
            start,
            end,
            Boolean(project.voice?.dubLocked || dc.locked)
          );
        }
      }
      const dubStart = Math.max(0, dubOffset);
      const lastClipEnd = genClips.reduce(
        (m, c) => Math.max(m, Math.max(0, c.end + dubOffset)),
        0
      );
      const dubEnd = Math.max(
        dubStart + 0.2,
        lastClipEnd || project.voice?.syncPlan?.estimatedFinalDuration || srcDur
      );
      return build(
        genClips.length > 0 ? 'Narration Track' : 'Dub Track',
        'Narration',
        dubStart,
        dubEnd,
        Boolean(project.voice?.dubLocked)
      );
    }
    case 'filter': {
      const fxConfig = project.videoEffects || DEFAULT_VIDEO_EFFECTS;
      if (selection.filterId) {
        const fl = (fxConfig.filterStack || []).find((f) => f.id === selection.filterId);
        if (fl) {
          const start = Math.max(0, fl.startTime || 0);
          const end = fl.endTime > start ? fl.endTime : effDur;
          return build(
            fl.name || getFilterPresetMeta(fl.preset).label,
            'Filter',
            start,
            end,
            Boolean(fl.locked)
          );
        }
      }
      const vTotal = getVideoTimelineTotalDuration(getEffectiveVideoClips(project)) || effDur;
      return build(
        `Global: ${getFilterPresetMeta(fxConfig.filterPreset).label}`,
        'Filter',
        0,
        vTotal,
        Boolean(fxConfig.globalFilterLocked)
      );
    }
    case 'effect': {
      const fxConfig = project.videoEffects || DEFAULT_VIDEO_EFFECTS;
      if (selection.effectId) {
        const fx = (fxConfig.effects || []).find((e) => e.id === selection.effectId);
        if (fx) {
          const start = Math.max(0, fx.startTime || 0);
          const end = fx.endTime > start ? fx.endTime : effDur;
          return build(
            fx.name || getEffectCatalogEntry(fx.type).label,
            'Effect',
            start,
            end,
            Boolean(fx.locked)
          );
        }
      }
      return build('Effects Track', 'Effect', 0, effDur, isTrackLocked(project, 'effects'));
    }
    default:
      return null;
  }
}

export function toggleTrackLockPatch(
  cur: Project,
  trackId: TimelineTrackId
): { patch: Partial<Project>; locked: boolean; label: string } {
  const nextLocked = !isTrackLocked(cur, trackId);
  switch (trackId) {
    case 'video':
      return {
        patch: {
          canvas: { ...DEFAULT_VIDEO_CANVAS, ...(cur.canvas || {}), videoLocked: nextLocked },
        },
        locked: nextLocked,
        label: 'Video Track',
      };
    case 'captions':
      return {
        patch: {
          subtitleStyle: { ...cur.subtitleStyle, locked: nextLocked },
        },
        locked: nextLocked,
        label: 'Captions Track',
      };
    case 'dub':
      return {
        patch: { voice: { ...cur.voice, dubLocked: nextLocked } },
        locked: nextLocked,
        label: 'Narration Track',
      };
    case 'orig':
      return {
        patch: { voice: { ...cur.voice, origLocked: nextLocked } },
        locked: nextLocked,
        label: 'Original Audio Track',
      };
    case 'bgm':
      return {
        patch: { voice: { ...cur.voice, bgmLocked: nextLocked } },
        locked: nextLocked,
        label: 'Music Track',
      };
    case 'sfx':
      return {
        patch: { voice: { ...cur.voice, sfxLocked: nextLocked } },
        locked: nextLocked,
        label: 'SFX Track',
      };
    case 'overlays':
      return {
        patch: {
          logos: cur.logos.map((l) => ({ ...l, locked: nextLocked })),
          subtitleStyle: {
            ...cur.subtitleStyle,
            extraElements: (cur.subtitleStyle.extraElements || []).map((el) => ({
              ...el,
              locked: nextLocked,
            })),
          },
        },
        locked: nextLocked,
        label: 'Overlays & Text',
      };
    case 'blur':
      return {
        patch: { blurs: cur.blurs.map((b) => ({ ...b, locked: nextLocked })) },
        locked: nextLocked,
        label: 'Blur Masks',
      };
    case 'filters': {
      const fxConfig = cur.videoEffects || DEFAULT_VIDEO_EFFECTS;
      const stack = fxConfig.filterStack || [];
      return {
        patch: {
          videoEffects: {
            ...fxConfig,
            globalFilterLocked: nextLocked,
            filterStack: stack.map((f) => ({ ...f, locked: nextLocked })),
          },
        },
        locked: nextLocked,
        label: 'Color Filters',
      };
    }
    case 'effects': {
      const fxConfig = cur.videoEffects || DEFAULT_VIDEO_EFFECTS;
      return {
        patch: {
          videoEffects: {
            ...fxConfig,
            effects: (fxConfig.effects || []).map((fx) => ({ ...fx, locked: nextLocked })),
          },
        },
        locked: nextLocked,
        label: 'Visual Effects',
      };
    }
  }
}

export function toggleSelectionLockPatch(
  cur: Project,
  selection: StudioElementSelection,
  currentTime = 0
): { patch: Partial<Project>; locked: boolean; label: string } | null {
  if (!selection || selection.kind === 'video') {
    const trackLocked = Boolean(cur.canvas?.videoLocked);
    if (selection?.kind === 'video' && selection.clipId && Array.isArray(cur.videoClips)) {
      const clip = cur.videoClips.find((c) => c.id === selection.clipId);
      if (clip && cur.videoClips.length > 1) {
        if (trackLocked && !clip.locked) {
          return {
            patch: {
              canvas: { ...DEFAULT_VIDEO_CANVAS, ...(cur.canvas || {}), videoLocked: false },
            },
            locked: false,
            label: 'Video Track',
          };
        }
        const nextLocked = !Boolean(clip.locked);
        return {
          patch: {
            ...(trackLocked && !nextLocked
              ? { canvas: { ...DEFAULT_VIDEO_CANVAS, ...(cur.canvas || {}), videoLocked: false } }
              : {}),
            videoClips: cur.videoClips.map((c) =>
              c.id === clip.id ? { ...c, locked: nextLocked } : c
            ),
          },
          locked: nextLocked,
          label: clip.label || 'Video Clip',
        };
      }
    }
    const nextLocked = !trackLocked;
    return {
      patch: {
        canvas: { ...DEFAULT_VIDEO_CANVAS, ...(cur.canvas || {}), videoLocked: nextLocked },
        ...(!nextLocked && Array.isArray(cur.videoClips) && cur.videoClips.length === 1
          ? { videoClips: cur.videoClips.map((c) => ({ ...c, locked: false })) }
          : {}),
      },
      locked: nextLocked,
      label: 'Video Layer',
    };
  }

  if (selection.kind === 'bg-image') {
    const nextLocked = !Boolean(cur.canvas?.bgImageLocked);
    return {
      patch: {
        canvas: { ...DEFAULT_VIDEO_CANVAS, ...(cur.canvas || {}), bgImageLocked: nextLocked },
      },
      locked: nextLocked,
      label: 'Background Image',
    };
  }

  if (selection.kind === 'blur') {
    const b = cur.blurs.find((x) => x.id === selection.id);
    if (!b) return null;
    const nextLocked = !Boolean(b.locked);
    return {
      patch: {
        blurs: cur.blurs.map((x) => (x.id === b.id ? { ...x, locked: nextLocked } : x)),
      },
      locked: nextLocked,
      label: b.name || 'Blur',
    };
  }

  if (selection.kind === 'logo') {
    const l = cur.logos.find((x) => x.id === selection.id);
    if (!l) return null;
    const nextLocked = !Boolean(l.locked);
    return {
      patch: {
        logos: cur.logos.map((x) => (x.id === l.id ? { ...x, locked: nextLocked } : x)),
      },
      locked: nextLocked,
      label: l.filename || 'Overlay',
    };
  }

  if (selection.kind === 'captions') {
    const trackLocked = Boolean(cur.subtitleStyle?.locked);
    if (selection.segmentId) {
      const seg = cur.captions.find((c) => c.id === selection.segmentId);
      if (seg) {
        if (trackLocked && !seg.locked) {
          return {
            patch: { subtitleStyle: { ...cur.subtitleStyle, locked: false } },
            locked: false,
            label: 'Captions Track',
          };
        }
        const nextLocked = !Boolean(seg.locked);
        return {
          patch: {
            ...(trackLocked && !nextLocked
              ? { subtitleStyle: { ...cur.subtitleStyle, locked: false } }
              : {}),
            captions: cur.captions.map((c) =>
              c.id === seg.id ? { ...c, locked: nextLocked } : c
            ),
          },
          locked: nextLocked,
          label: 'Caption Segment',
        };
      }
    }
    const nextLocked = !trackLocked;
    return {
      patch: { subtitleStyle: { ...cur.subtitleStyle, locked: nextLocked } },
      locked: nextLocked,
      label: 'Captions Track',
    };
  }

  if (selection.kind === 'caption-element') {
    const el = (cur.subtitleStyle?.extraElements || []).find((x) => x.id === selection.id);
    if (!el) return null;
    const nextLocked = !Boolean(el.locked);
    return {
      patch: {
        subtitleStyle: {
          ...cur.subtitleStyle,
          extraElements: (cur.subtitleStyle.extraElements || []).map((x) =>
            x.id === el.id ? { ...x, locked: nextLocked } : x
          ),
        },
      },
      locked: nextLocked,
      label: el.label || 'Text Layer',
    };
  }

  if (selection.kind === 'audio') {
    const track = selection.track || 'dub';
    if (track === 'orig') {
      const trackLocked = Boolean(cur.voice?.origLocked);
      if (selection.clipId && Array.isArray(cur.originalAudioClips)) {
        const oa = cur.originalAudioClips.find((c) => c.id === selection.clipId);
        if (oa) {
          if (trackLocked && !oa.locked) {
            return {
              patch: { voice: { ...cur.voice, origLocked: false } },
              locked: false,
              label: 'Original Audio Track',
            };
          }
          const nextLocked = !Boolean(oa.locked);
          return {
            patch: {
              ...(trackLocked && !nextLocked
                ? { voice: { ...cur.voice, origLocked: false } }
                : {}),
              originalAudioClips: cur.originalAudioClips.map((c) =>
                c.id === oa.id ? { ...c, locked: nextLocked } : c
              ),
            },
            locked: nextLocked,
            label: oa.label || 'Original Audio Clip',
          };
        }
      }
      return toggleTrackLockPatch(cur, 'orig');
    }
    if (track === 'bgm') {
      const trackLocked = Boolean(cur.voice?.bgmLocked);
      if (selection.clipId && Array.isArray(cur.voice.bgMusicClips)) {
        const bc = cur.voice.bgMusicClips.find((c) => c.id === selection.clipId);
        if (bc) {
          if (trackLocked && !bc.locked) {
            return {
              patch: { voice: { ...cur.voice, bgmLocked: false } },
              locked: false,
              label: 'Music Track',
            };
          }
          const nextLocked = !Boolean(bc.locked);
          return {
            patch: {
              voice: {
                ...cur.voice,
                ...(trackLocked && !nextLocked ? { bgmLocked: false } : {}),
                bgMusicClips: cur.voice.bgMusicClips.map((c) =>
                  c.id === bc.id ? { ...c, locked: nextLocked } : c
                ),
              },
            },
            locked: nextLocked,
            label: bc.label || 'Music Clip',
          };
        }
      }
      return toggleTrackLockPatch(cur, 'bgm');
    }
    if (track === 'sfx') {
      const trackLocked = Boolean(cur.voice?.sfxLocked);
      if (selection.clipId && Array.isArray(cur.voice.sfxClips)) {
        const sc = cur.voice.sfxClips.find((c) => c.id === selection.clipId);
        if (sc) {
          if (trackLocked && !sc.locked) {
            return {
              patch: { voice: { ...cur.voice, sfxLocked: false } },
              locked: false,
              label: 'SFX Track',
            };
          }
          const nextLocked = !Boolean(sc.locked);
          return {
            patch: {
              voice: {
                ...cur.voice,
                ...(trackLocked && !nextLocked ? { sfxLocked: false } : {}),
                sfxClips: cur.voice.sfxClips.map((c) =>
                  c.id === sc.id ? { ...c, locked: nextLocked } : c
                ),
              },
            },
            locked: nextLocked,
            label: sc.label || 'SFX Clip',
          };
        }
      }
      return toggleTrackLockPatch(cur, 'sfx');
    }
    // dub
    const trackLocked = Boolean(cur.voice?.dubLocked);
    if (selection.clipId) {
      const dc = (cur.voice.generatedClips || []).find(
        (c) => c.segmentId === selection.clipId
      );
      if (dc) {
        if (trackLocked && !dc.locked) {
          return {
            patch: { voice: { ...cur.voice, dubLocked: false } },
            locked: false,
            label: 'Narration Track',
          };
        }
        const nextLocked = !Boolean(dc.locked);
        return {
          patch: {
            voice: {
              ...cur.voice,
              ...(trackLocked && !nextLocked ? { dubLocked: false } : {}),
              generatedClips: cur.voice.generatedClips.map((c) =>
                c.segmentId === dc.segmentId ? { ...c, locked: nextLocked } : c
              ),
            },
          },
          locked: nextLocked,
          label: 'Narration Clip',
        };
      }
    }
    return toggleTrackLockPatch(cur, 'dub');
  }

  if (selection.kind === 'filter') {
    const fxConfig = cur.videoEffects || DEFAULT_VIDEO_EFFECTS;
    if (selection.filterId) {
      const fl = (fxConfig.filterStack || []).find((f) => f.id === selection.filterId);
      if (fl) {
        const nextLocked = !Boolean(fl.locked);
        return {
          patch: {
            videoEffects: {
              ...fxConfig,
              filterStack: (fxConfig.filterStack || []).map((f) =>
                f.id === fl.id ? { ...f, locked: nextLocked } : f
              ),
            },
          },
          locked: nextLocked,
          label: fl.name || 'Filter Layer',
        };
      }
    }
    const nextLocked = !Boolean(fxConfig.globalFilterLocked);
    return {
      patch: {
        videoEffects: { ...fxConfig, globalFilterLocked: nextLocked },
      },
      locked: nextLocked,
      label: 'Global Filter',
    };
  }

  if (selection.kind === 'effect') {
    const fxConfig = cur.videoEffects || DEFAULT_VIDEO_EFFECTS;
    if (selection.effectId) {
      const fx = (fxConfig.effects || []).find((e) => e.id === selection.effectId);
      if (fx) {
        const nextLocked = !Boolean(fx.locked);
        return {
          patch: {
            videoEffects: {
              ...fxConfig,
              effects: (fxConfig.effects || []).map((e) =>
                e.id === fx.id ? { ...e, locked: nextLocked } : e
              ),
            },
          },
          locked: nextLocked,
          label: fx.name || 'Effect',
        };
      }
    }
    return toggleTrackLockPatch(cur, 'effects');
  }

  // Fallback unused param silence
  void currentTime;
  return null;
}
