import {
  OriginalAudioClip,
  Project,
  TimelineAudioClip,
  VideoClip,
} from '../types/studio';

export const VIDEO_SPEED_PRESETS = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0] as const;
export const MIN_VIDEO_SPEED = 0.25;
export const MAX_VIDEO_SPEED = 4.0;

function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function clampVideoSpeed(raw: unknown): number {
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return 1.0;
  return r2(Math.max(MIN_VIDEO_SPEED, Math.min(MAX_VIDEO_SPEED, num)));
}

export function getVideoClipTimelineDuration(clip: VideoClip): number {
  const srcSpan = Math.max(0.1, (clip.sourceEnd || 0) - (clip.sourceStart || 0));
  return r3(srcSpan / clampVideoSpeed(clip.speed));
}

export function getVideoClipTimelineEnd(clip: VideoClip): number {
  return r3(Math.max(0, clip.timelineStart || 0) + getVideoClipTimelineDuration(clip));
}

export function createDefaultMainVideoClip(params: {
  filename?: string | null;
  name?: string | null;
  duration?: number | null;
  audioUnlinked?: boolean;
}): VideoClip {
  const rawDur = Math.max(0.5, Number(params.duration) || 12);
  return {
    id: 'vclip_main',
    label: params.filename || params.name || 'Main Video',
    sourceStart: 0,
    sourceEnd: r3(rawDur),
    timelineStart: 0,
    speed: 1.0,
    audioUnlinked: Boolean(params.audioUnlinked),
  };
}

export function getEffectiveVideoClips(project: Project): VideoClip[] {
  const rawDur = Math.max(0.5, project.metadata?.duration || 12);
  if (Array.isArray(project.videoClips)) {
    if (project.videoClips.length === 0) return [];
    return project.videoClips
      .map((c, idx) => {
        const sourceStart = Math.max(0, Number(c.sourceStart || 0));
        const sourceEnd = Math.max(sourceStart + 0.1, Math.min(rawDur, Number(c.sourceEnd || rawDur)));
        return {
          id: c.id || `vclip_${idx + 1}`,
          label: c.label || `Clip ${idx + 1}`,
          sourceStart: r3(sourceStart),
          sourceEnd: r3(sourceEnd),
          timelineStart: r3(Math.max(0, Number(c.timelineStart || 0))),
          speed: clampVideoSpeed(c.speed),
          audioUnlinked: Boolean(c.audioUnlinked),
          ...(c.filterPreset ? { filterPreset: c.filterPreset } : {}),
          ...(c.filterIntensity !== undefined
            ? { filterIntensity: Math.max(0, Math.min(100, Number(c.filterIntensity))) }
            : {}),
          ...(c.locked ? { locked: true } : {}),
        };
      })
      .sort((a, b) => a.timelineStart - b.timelineStart);
  }

  if (!project.sourceVideoUrl && !project.sourceVideoBlobKey) return [];

  return [
    createDefaultMainVideoClip({
      filename: project.sourceFilename,
      name: project.name,
      duration: rawDur,
      audioUnlinked: Boolean(project.originalAudioClips && project.originalAudioClips.length > 0),
    }),
  ];
}

export function hasCustomVideoEdits(project: Project): boolean {
  const clips = project.videoClips;
  if (!Array.isArray(clips)) return false;
  if (clips.length === 0) return true;
  if (clips.length > 1) return true;
  const only = clips[0];
  const srcDur = Math.max(0.5, project.metadata?.duration || 12);
  return (
    Math.abs(clampVideoSpeed(only.speed) - 1.0) > 0.005 ||
    Math.abs(only.timelineStart) > 0.02 ||
    Math.abs(only.sourceStart) > 0.02 ||
    Math.abs(only.sourceEnd - srcDur) > 0.08 ||
    Boolean(only.audioUnlinked)
  );
}

export function getVideoTimelineTotalDuration(clips: VideoClip[]): number {
  if (!clips || clips.length === 0) return 0;
  return r3(clips.reduce((max, c) => Math.max(max, getVideoClipTimelineEnd(c)), 0));
}

export function findActiveVideoClipAtTime(
  clips: VideoClip[],
  timelineTime: number
): { clip: VideoClip; sourceTime: number; tlStart: number; tlEnd: number } | null {
  if (!clips || clips.length === 0) return null;
  const t = Math.max(0, timelineTime);
  // Reverse scan so later clip wins if adjacent clips overlap slightly
  for (let i = clips.length - 1; i >= 0; i--) {
    const clip = clips[i];
    const tlStart = clip.timelineStart;
    const tlEnd = getVideoClipTimelineEnd(clip);
    if (t >= tlStart - 0.005 && t <= tlEnd + 0.005) {
      const localTl = Math.max(0, t - tlStart);
      const sourceTime = Math.min(
        clip.sourceEnd,
        Math.max(clip.sourceStart, clip.sourceStart + localTl * clampVideoSpeed(clip.speed))
      );
      return { clip, sourceTime, tlStart, tlEnd };
    }
  }
  return null;
}

export function getOriginalAudioClipTimelineEnd(clip: OriginalAudioClip): number {
  const span = Math.max(0.1, (clip.sourceEnd || 0) - (clip.sourceStart || 0)) / clampVideoSpeed(clip.speed ?? 1.0);
  return r3(Math.max(0, clip.timelineStart || 0) + span);
}

export function getEffectiveOriginalAudioClips(project: Project): OriginalAudioClip[] {
  const rawDur = Math.max(0.5, project.metadata?.duration || 12);
  if (!Array.isArray(project.originalAudioClips)) return [];
  return project.originalAudioClips
    .map((c, idx) => {
      const sourceStart = Math.max(0, Number(c.sourceStart || 0));
      const sourceEnd = Math.max(sourceStart + 0.1, Math.min(rawDur, Number(c.sourceEnd || rawDur)));
      return {
        id: c.id || `oa_${idx + 1}`,
        label: c.label || `Original Audio ${idx + 1}`,
        sourceStart: r3(sourceStart),
        sourceEnd: r3(sourceEnd),
        timelineStart: r3(Math.max(0, Number(c.timelineStart || 0))),
        speed: clampVideoSpeed(c.speed ?? 1.0),
        preservePitch: c.preservePitch !== false,
        volume: Math.max(0, Math.min(2.0, Number(c.volume ?? 1.0))),
        muted: Boolean(c.muted),
        linkedVideoClipId: c.linkedVideoClipId,
        ...(c.locked ? { locked: true } : {}),
      };
    })
    .sort((a, b) => a.timelineStart - b.timelineStart);
}

export function findActiveOriginalAudioAtTime(
  clips: OriginalAudioClip[],
  timelineTime: number
): { clip: OriginalAudioClip; sourceTime: number; tlEnd: number } | null {
  if (!clips || clips.length === 0) return null;
  const t = Math.max(0, timelineTime);
  for (let i = clips.length - 1; i >= 0; i--) {
    const clip = clips[i];
    const tlEnd = getOriginalAudioClipTimelineEnd(clip);
    if (t >= clip.timelineStart - 0.005 && t <= tlEnd + 0.005) {
      const spd = clampVideoSpeed(clip.speed ?? 1.0);
      const sourceTime = Math.min(
        clip.sourceEnd,
        Math.max(clip.sourceStart, clip.sourceStart + Math.max(0, t - clip.timelineStart) * spd)
      );
      return { clip, sourceTime, tlEnd };
    }
  }
  return null;
}

export function getTimelineAudioClipEnd(clip: TimelineAudioClip): number {
  const span = Math.max(0.1, (clip.sourceEnd || 0) - (clip.sourceStart || 0)) / clampVideoSpeed(clip.speed ?? 1.0);
  return r3(Math.max(0, clip.timelineStart || 0) + span);
}

export function getEffectiveBgmClips(project: Project, fallbackDur?: number): TimelineAudioClip[] {
  const v = project.voice;
  if (Array.isArray(v.bgMusicClips)) {
    return v.bgMusicClips
      .map((c, idx) => {
        const sStart = Math.max(0, Number(c.sourceStart || 0));
        const sEnd = Math.max(sStart + 0.1, Number(c.sourceEnd || fallbackDur || 12));
        return {
          ...c,
          id: c.id || `bgm_${idx + 1}`,
          audioUrl: c.audioUrl || v.bgMusicUrl || '',
          sourceStart: r3(sStart),
          sourceEnd: r3(sEnd),
          timelineStart: r3(Math.max(0, Number(c.timelineStart || 0))),
          speed: clampVideoSpeed(c.speed ?? 1.0),
          preservePitch: c.preservePitch !== false,
          volume: Math.max(0, Math.min(2.0, Number(c.volume ?? 1.0))),
          muted: Boolean(c.muted),
        };
      })
      .filter((c) => Boolean(c.audioUrl))
      .sort((a, b) => a.timelineStart - b.timelineStart);
  }
  if (!v.bgMusicUrl) return [];
  const dur = Math.max(0.5, fallbackDur || project.metadata?.duration || 12);
  return [
    {
      id: 'bgm_main',
      label: v.bgMusicFilename || 'Background Music',
      audioUrl: v.bgMusicUrl,
      sourceStart: 0,
      sourceEnd: r3(dur),
      timelineStart: 0,
      speed: 1.0,
      preservePitch: true,
      volume: 1.0,
      muted: Boolean(v.bgMusicMuted),
      loop: true,
    },
  ];
}

export function getEffectiveSfxClips(project: Project, fallbackDur?: number): TimelineAudioClip[] {
  const v = project.voice;
  if (Array.isArray(v.sfxClips)) {
    return v.sfxClips
      .map((c, idx) => {
        const sStart = Math.max(0, Number(c.sourceStart || 0));
        const sEnd = Math.max(sStart + 0.1, Number(c.sourceEnd || fallbackDur || 4));
        return {
          ...c,
          id: c.id || `sfx_${idx + 1}`,
          audioUrl: c.audioUrl || v.sfxUrl || '',
          sourceStart: r3(sStart),
          sourceEnd: r3(sEnd),
          timelineStart: r3(Math.max(0, Number(c.timelineStart || 0))),
          speed: clampVideoSpeed(c.speed ?? 1.0),
          preservePitch: c.preservePitch !== false,
          volume: Math.max(0, Math.min(2.0, Number(c.volume ?? 1.0))),
          muted: Boolean(c.muted),
        };
      })
      .filter((c) => Boolean(c.audioUrl))
      .sort((a, b) => a.timelineStart - b.timelineStart);
  }
  if (!v.sfxUrl) return [];
  const dur = Math.max(0.5, Math.min(fallbackDur || project.metadata?.duration || 12, project.metadata?.duration || 12));
  return [
    {
      id: 'sfx_main',
      label: v.sfxFilename || 'Sound Effect',
      audioUrl: v.sfxUrl,
      sourceStart: 0,
      sourceEnd: r3(dur),
      timelineStart: 0,
      speed: 1.0,
      preservePitch: true,
      volume: 1.0,
      muted: Boolean(v.sfxMuted),
      loop: false,
    },
  ];
}

export function findActiveTimelineAudioAtTime(
  clips: TimelineAudioClip[],
  timelineTime: number
): { clip: TimelineAudioClip; sourceTime: number; tlEnd: number } | null {
  if (!clips || clips.length === 0) return null;
  const t = Math.max(0, timelineTime);
  for (let i = clips.length - 1; i >= 0; i--) {
    const clip = clips[i];
    const tlEnd = getTimelineAudioClipEnd(clip);
    if (t >= clip.timelineStart - 0.005 && t <= tlEnd + 0.005) {
      const spd = clampVideoSpeed(clip.speed ?? 1.0);
      const sourceTime = Math.min(
        clip.sourceEnd,
        Math.max(clip.sourceStart, clip.sourceStart + Math.max(0, t - clip.timelineStart) * spd)
      );
      return { clip, sourceTime, tlEnd };
    }
  }
  return null;
}

export function splitTimelineAudioClipAtTime(
  clips: TimelineAudioClip[],
  timelineTime: number,
  generateId: () => string,
  targetClipId?: string
): { clips: TimelineAudioClip[]; firstId: string; secondId: string; splitTime: number } | null {
  let clip: TimelineAudioClip | undefined;
  let tlEnd = 0;

  if (targetClipId) {
    const c = clips.find((item) => item.id === targetClipId);
    if (c) {
      const cEnd = getTimelineAudioClipEnd(c);
      if (timelineTime >= c.timelineStart - 0.05 && timelineTime <= cEnd + 0.05) {
        clip = c;
        tlEnd = cEnd;
      }
    }
  }
  if (!clip) {
    const active = findActiveTimelineAudioAtTime(clips, timelineTime);
    if (active) {
      clip = active.clip;
      tlEnd = active.tlEnd;
    }
  }
  if (!clip) return null;

  const tlStart = clip.timelineStart;
  if (tlEnd - tlStart < 0.4) return null;

  const safeSplit =
    timelineTime > tlStart + 0.2 && timelineTime < tlEnd - 0.2
      ? r3(timelineTime)
      : r3((tlStart + tlEnd) / 2);
  const splitSource = r3(
    Math.min(
      clip.sourceEnd - 0.1,
      Math.max(clip.sourceStart + 0.1, clip.sourceStart + (safeSplit - tlStart))
    )
  );
  const secondId = generateId();
  const first: TimelineAudioClip = {
    ...clip,
    sourceEnd: splitSource,
  };
  const second: TimelineAudioClip = {
    ...clip,
    id: secondId,
    label: `${clip.label || 'Audio'} (2)`,
    sourceStart: splitSource,
    timelineStart: safeSplit,
  };
  return {
    clips: clips
      .flatMap((c) => (c.id === clip!.id ? [first, second] : [c]))
      .sort((a, b) => a.timelineStart - b.timelineStart),
    firstId: clip.id,
    secondId,
    splitTime: safeSplit,
  };
}

export function getProjectEffectiveDuration(project: Project): number {
  const videoClips = getEffectiveVideoClips(project);
  const hasExplicitEmptyVideo = Array.isArray(project.videoClips) && project.videoClips.length === 0;
  const videoDur =
    videoClips.length > 0
      ? getVideoTimelineTotalDuration(videoClips)
      : hasExplicitEmptyVideo
      ? 0
      : project.metadata?.duration || 0;

  const dubClipsMax = (project.voice.generatedClips || []).reduce(
    (m, c) => Math.max(m, (c.end || 0) + Number(project.voice.timingOffsetSec || 0)),
    0
  );
  const dubDur = project.voice.enabled
    ? Math.max(
        project.voice.syncPlan?.estimatedFinalDuration || 0,
        dubClipsMax
      )
    : 0;

  const origAudioDur = getEffectiveOriginalAudioClips(project).reduce(
    (m, c) => Math.max(m, getOriginalAudioClipTimelineEnd(c)),
    0
  );

  const bgmClipsDur = Array.isArray(project.voice.bgMusicClips)
    ? project.voice.bgMusicClips.reduce((m, c) => Math.max(m, getTimelineAudioClipEnd(c)), 0)
    : 0;
  const sfxClipsDur = Array.isArray(project.voice.sfxClips)
    ? project.voice.sfxClips.reduce((m, c) => Math.max(m, getTimelineAudioClipEnd(c)), 0)
    : 0;

  const captionsDur =
    project.subtitleStyle?.enabled && project.subtitleStyle?.visible !== false
      ? (project.captions || []).reduce((m, c) => Math.max(m, c.end || 0), 0)
      : 0;

  const extraTextDur = (project.subtitleStyle?.extraElements || []).reduce(
    (m, el) => Math.max(m, el.endTime || 0),
    0
  );

  const blursDur = (project.blurs || []).reduce(
    (m, b) => Math.max(m, b.enabled ? b.endTime || 0 : 0),
    0
  );

  const logosDur = (project.logos || []).reduce(
    (m, l) => Math.max(m, l.enabled ? l.endTime || 0 : 0),
    0
  );

  const effectsDur = (project.videoEffects?.effects || []).reduce(
    (m, fx) => Math.max(m, fx.enabled ? fx.endTime || 0 : 0),
    0
  );

  return Math.max(
    1,
    r3(
      Math.max(
        videoDur,
        dubDur,
        origAudioDur,
        bgmClipsDur,
        sfxClipsDur,
        captionsDur,
        extraTextDur,
        blursDur,
        logosDur,
        effectsDur
      )
    )
  );
}

export function updateSingleVideoClipSpeed(
  clips: VideoClip[],
  clipId: string,
  newSpeed: number
): VideoClip[] {
  const clamped = clampVideoSpeed(newSpeed);
  return clips.map((c) => (c.id === clipId ? { ...c, speed: clamped } : c));
}

export function splitVideoClipAtTime(
  clips: VideoClip[],
  timelineTime: number,
  generateId: () => string
): { clips: VideoClip[]; firstId: string; secondId: string; splitTime: number } | null {
  const found = findActiveVideoClipAtTime(clips, timelineTime);
  if (!found) return null;
  const { clip, tlStart, tlEnd } = found;
  if (tlEnd - tlStart < 0.4) return null;

  const safeTlSplit =
    timelineTime > tlStart + 0.2 && timelineTime < tlEnd - 0.2
      ? r3(timelineTime)
      : r3((tlStart + tlEnd) / 2);

  const spd = clampVideoSpeed(clip.speed);
  const splitSource = r3(
    Math.min(
      clip.sourceEnd - 0.1,
      Math.max(clip.sourceStart + 0.1, clip.sourceStart + (safeTlSplit - tlStart) * spd)
    )
  );

  const secondId = generateId();
  const first: VideoClip = {
    ...clip,
    sourceEnd: splitSource,
  };
  const second: VideoClip = {
    ...clip,
    id: secondId,
    label: `${clip.label || 'Clip'} (2)`,
    sourceStart: splitSource,
    timelineStart: safeTlSplit,
    speed: spd,
  };

  return {
    clips: clips
      .flatMap((c) => (c.id === clip.id ? [first, second] : [c]))
      .sort((a, b) => a.timelineStart - b.timelineStart),
    firstId: clip.id,
    secondId,
    splitTime: safeTlSplit,
  };
}

export function unlinkVideoClipAudio(
  project: Project,
  clipId: string | undefined,
  generateId: () => string
): {
  videoClips: VideoClip[];
  originalAudioClips: OriginalAudioClip[];
  unlinkedCount: number;
} {
  const videoClips = getEffectiveVideoClips(project);
  const existingAudio = getEffectiveOriginalAudioClips(project);
  const nextAudio = [...existingAudio];
  let unlinkedCount = 0;

  const nextVideoClips = videoClips.map((vc) => {
    if (clipId && vc.id !== clipId) return vc;
    if (vc.audioUnlinked && nextAudio.some((oa) => oa.linkedVideoClipId === vc.id)) {
      return vc;
    }
    unlinkedCount += 1;
    const alreadyExists = nextAudio.some(
      (oa) =>
        oa.linkedVideoClipId === vc.id ||
        (Math.abs(oa.sourceStart - vc.sourceStart) < 0.05 &&
          Math.abs(oa.sourceEnd - vc.sourceEnd) < 0.05)
    );
    if (!alreadyExists) {
      nextAudio.push({
        id: generateId(),
        label: vc.label ? `${vc.label} Audio` : 'Original Audio (1.0x)',
        sourceStart: vc.sourceStart,
        sourceEnd: vc.sourceEnd,
        timelineStart: vc.timelineStart,
        speed: 1.0,
        preservePitch: true,
        volume: 1.0,
        muted: false,
        linkedVideoClipId: vc.id,
      });
    }
    return { ...vc, audioUnlinked: true };
  });

  return {
    videoClips: nextVideoClips,
    originalAudioClips: nextAudio.sort((a, b) => a.timelineStart - b.timelineStart),
    unlinkedCount,
  };
}

export interface VideoTimelineMismatch {
  kind: 'overlap' | 'gap' | 'video-shorter-than-audio' | 'video-longer-than-audio';
  severity: 'warning' | 'info';
  message: string;
  atTime: number;
}

export function detectVideoTimelineMismatches(project: Project): VideoTimelineMismatch[] {
  const clips = getEffectiveVideoClips(project);
  if (clips.length === 0) return [];
  const warnings: VideoTimelineMismatch[] = [];

  for (let i = 0; i < clips.length - 1; i++) {
    const cur = clips[i];
    const next = clips[i + 1];
    const curEnd = getVideoClipTimelineEnd(cur);
    if (curEnd > next.timelineStart + 0.05) {
      warnings.push({
        kind: 'overlap',
        severity: 'warning',
        atTime: next.timelineStart,
        message: `Video clip "${cur.label || `Clip ${i + 1}`}" ends at ${curEnd.toFixed(
          2
        )}s and overlaps "${next.label || `Clip ${i + 2}`}" starting at ${next.timelineStart.toFixed(2)}s.`,
      });
    } else if (next.timelineStart - curEnd > 0.08) {
      warnings.push({
        kind: 'gap',
        severity: 'warning',
        atTime: curEnd,
        message: `${(next.timelineStart - curEnd).toFixed(2)}s video gap between ${curEnd.toFixed(
          2
        )}s and ${next.timelineStart.toFixed(2)}s (narration & captions stay at 1.0x).`,
      });
    }
  }

  const videoEnd = getVideoTimelineTotalDuration(clips);
  const dubMax = project.voice.enabled
    ? Math.max(
        project.voice.syncPlan?.estimatedFinalDuration || 0,
        ...(project.voice.generatedClips || []).map(
          (c) => (c.end || 0) + Number(project.voice.timingOffsetSec || 0)
        )
      )
    : 0;
  const captionMax = (project.captions || []).reduce((m, c) => Math.max(m, c.end || 0), 0);
  const audioOrCapEnd = Math.max(dubMax, captionMax);

  const hasSpeedEdit = clips.some((c) => Math.abs(c.speed - 1.0) > 0.01);
  if (hasSpeedEdit && audioOrCapEnd > videoEnd + 0.25) {
    warnings.push({
      kind: 'video-shorter-than-audio',
      severity: 'warning',
      atTime: videoEnd,
      message: `Video ends at ${videoEnd.toFixed(2)}s while 1.0x narration/captions continue to ${audioOrCapEnd.toFixed(
        2
      )}s (+${(audioOrCapEnd - videoEnd).toFixed(2)}s). Other tracks were left untouched.`,
    });
  } else if (hasSpeedEdit && dubMax > 0.5 && videoEnd > dubMax + 0.25) {
    warnings.push({
      kind: 'video-longer-than-audio',
      severity: 'info',
      atTime: dubMax,
      message: `Video now runs to ${videoEnd.toFixed(2)}s while 1.0x narration finishes at ${dubMax.toFixed(
        2
      )}s (+${(videoEnd - dubMax).toFixed(2)}s silent tail).`,
    });
  }

  return warnings;
}
