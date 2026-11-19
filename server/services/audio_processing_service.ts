import fs from 'fs';
import {
  OriginalAudioClip,
  VideoClip,
  VideoExtensionHold,
  VoiceConfig,
} from '../../src/types/studio.ts';
import { clampVideoSpeed } from '../../src/lib/videoTimeline.ts';
import { getAssetByUrl } from '../db.ts';
import { buildAudioHoldFilter } from './timeline_sync_service.ts';

export interface AudioFilterResult {
  extraInputs: string[];
  filterSteps: string[];
  audioMapLabel: string | null;
  nextInputIndex: number;
}

export function isOriginalAudioActive(voice: VoiceConfig): boolean {
  if (voice.originalAudioRemoved) return false;
  const muted =
    voice.originalAudioMuted !== undefined
      ? Boolean(voice.originalAudioMuted)
      : !Boolean(voice.preserveOriginalAudio);
  const enabled =
    voice.originalAudioEnabled !== undefined
      ? Boolean(voice.originalAudioEnabled)
      : Boolean(voice.preserveOriginalAudio);
  const vol = Math.max(0, Math.min(2.0, Number(voice.originalAudioVolume ?? 1.0)));
  return enabled && !muted && vol > 0.005;
}

function buildAtempoChain(rawSpeed: number): string {
  const spd = clampVideoSpeed(rawSpeed);
  if (Math.abs(spd - 1.0) <= 0.005) return '';
  const stages: string[] = [];
  let rem = spd;
  while (rem > 2.0 + 1e-4) {
    stages.push('atempo=2.0');
    rem /= 2.0;
  }
  while (rem < 0.5 - 1e-4) {
    stages.push('atempo=0.5');
    rem /= 0.5;
  }
  if (Math.abs(rem - 1.0) > 0.002) {
    stages.push(`atempo=${rem.toFixed(4)}`);
  }
  return stages.join(',');
}

export function buildAudioMixFilters(params: {
  hasSourceAudio: boolean;
  duration: number;
  originalDuration?: number;
  holds?: VideoExtensionHold[];
  videoClips?: VideoClip[];
  originalAudioClips?: OriginalAudioClip[];
  voice: VoiceConfig;
  applyDubbing: boolean;
  applyAudioMix: boolean;
  nextInputIndex: number;
}): AudioFilterResult {
  const extraInputs: string[] = [];
  const filterSteps: string[] = [];
  const mixBranches: string[] = [];
  let inputIdx = params.nextInputIndex;

  const dubAsset =
    params.applyDubbing &&
    params.voice.enabled &&
    !params.voice.voiceMuted &&
    Math.max(0, Number(params.voice.voiceVolume ?? 1.0)) > 0.005 &&
    params.voice.fullDubUrl
      ? getAssetByUrl(params.voice.fullDubUrl)
      : null;

  const bgmEnabled =
    params.voice.bgMusicEnabled !== undefined
      ? Boolean(params.voice.bgMusicEnabled)
      : Boolean(params.voice.bgMusicUrl && Number(params.voice.bgMusicVolume ?? 0) > 0.005);
  const musicAsset =
    params.applyAudioMix &&
    bgmEnabled &&
    !params.voice.bgMusicMuted &&
    Math.max(0, Number(params.voice.bgMusicVolume ?? 0)) > 0.005 &&
    params.voice.bgMusicUrl
      ? getAssetByUrl(params.voice.bgMusicUrl)
      : null;

  const sfxEnabled = Boolean(params.voice.sfxEnabled);
  const sfxAsset =
    params.applyAudioMix &&
    sfxEnabled &&
    !params.voice.sfxMuted &&
    Math.max(0, Number(params.voice.sfxVolume ?? 1.0)) > 0.005 &&
    params.voice.sfxUrl
      ? getAssetByUrl(params.voice.sfxUrl)
      : null;

  // 1. Original Video Audio (independent of voiceover; unlinked clips ALWAYS stay 1.0x)
  const origActive = params.hasSourceAudio && isOriginalAudioActive(params.voice);
  const trackOrigVol = Math.max(0, Math.min(2.0, Number(params.voice.originalAudioVolume ?? 1.0)));
  const fadeSuffix = (() => {
    let f = '';
    if (params.applyAudioMix && params.voice.fadeInSec > 0) {
      f += `,afade=t=in:st=0:d=${params.voice.fadeInSec.toFixed(2)}`;
    }
    if (
      params.applyAudioMix &&
      params.voice.fadeOutSec > 0 &&
      params.duration > params.voice.fadeOutSec
    ) {
      const fadeStart = Math.max(0, params.duration - params.voice.fadeOutSec).toFixed(2);
      f += `,afade=t=out:st=${fadeStart}:d=${params.voice.fadeOutSec.toFixed(2)}`;
    }
    return f;
  })();

  if (origActive) {
    const unlinkedClips = (params.originalAudioClips || []).filter(
      (c) => !c.muted && Math.max(0, Number(c.volume ?? 1.0)) > 0.005
    );
    const hasUnlinkedTrack = Boolean(params.originalAudioClips && params.originalAudioClips.length > 0);

    if (hasUnlinkedTrack) {
      // Unlinked original audio clips: ALWAYS strictly 1.0x speed and preserved pitch
      if (unlinkedClips.length > 0) {
        const inLabels =
          unlinkedClips.length === 1
            ? ['0:a']
            : unlinkedClips.map((_, i) => `oa_in_${i}`);
        if (unlinkedClips.length > 1) {
          filterSteps.push(
            `[0:a]asplit=${unlinkedClips.length}${inLabels.map((l) => `[${l}]`).join('')}`
          );
        }
        const outLabels: string[] = [];
        unlinkedClips.forEach((c, i) => {
          const sStart = Math.max(0, Number(c.sourceStart || 0));
          const sEnd = Math.max(sStart + 0.05, Number(c.sourceEnd || params.originalDuration || params.duration));
          const tlStartMs = Math.max(0, Math.round(Number(c.timelineStart || 0) * 1000));
          const clipVol = Math.max(0, Math.min(2.0, trackOrigVol * Number(c.volume ?? 1.0)));
          const atempo = buildAtempoChain(c.speed ?? 1.0);
          const outLbl = unlinkedClips.length === 1 && !fadeSuffix ? 'a_orig' : `oa_out_${i}`;
          filterSteps.push(
            `[${inLabels[i]}]atrim=start=${sStart.toFixed(3)}:end=${sEnd.toFixed(3)},asetpts=PTS-STARTPTS${atempo ? `,${atempo}` : ''},aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=${clipVol.toFixed(2)}${tlStartMs > 0 ? `,adelay=${tlStartMs}|${tlStartMs}` : ''},apad=whole_dur=${params.duration.toFixed(3)},atrim=0:${params.duration.toFixed(3)}[${outLbl}]`
          );
          outLabels.push(`[${outLbl}]`);
        });

        if (unlinkedClips.length === 1) {
          if (fadeSuffix) {
            filterSteps.push(
              `${outLabels[0]}asetpts=PTS-STARTPTS${fadeSuffix},apad=whole_dur=${params.duration.toFixed(3)},atrim=0:${params.duration.toFixed(3)}[a_orig]`
            );
          }
        } else {
          filterSteps.push(
            `${outLabels.join('')}amix=inputs=${unlinkedClips.length}:duration=first:dropout_transition=0:normalize=0${fadeSuffix},apad=whole_dur=${params.duration.toFixed(3)},atrim=0:${params.duration.toFixed(3)}[a_orig]`
          );
        }
        mixBranches.push('[a_orig]');
      }
    } else if (params.videoClips && params.videoClips.length > 0 && !params.holds?.length) {
      // Linked video clip(s): trim/place per clip, only using atempo for clips with speed != 1.0
      const linkedClips = params.videoClips.filter((c) => !c.audioUnlinked);
      if (linkedClips.length > 0) {
        const inLabels =
          linkedClips.length === 1
            ? ['0:a']
            : linkedClips.map((_, i) => `va_in_${i}`);
        if (linkedClips.length > 1) {
          filterSteps.push(
            `[0:a]asplit=${linkedClips.length}${inLabels.map((l) => `[${l}]`).join('')}`
          );
        }
        const outLabels: string[] = [];
        linkedClips.forEach((c, i) => {
          const sStart = Math.max(0, Number(c.sourceStart || 0));
          const sEnd = Math.max(
            sStart + 0.05,
            Number(c.sourceEnd || params.originalDuration || params.duration)
          );
          const tlStartMs = Math.max(0, Math.round(Number(c.timelineStart || 0) * 1000));
          const atempo = buildAtempoChain(c.speed);
          const outLbl = linkedClips.length === 1 && !fadeSuffix ? 'a_orig' : `va_out_${i}`;
          filterSteps.push(
            `[${inLabels[i]}]atrim=start=${sStart.toFixed(3)}:end=${sEnd.toFixed(3)},asetpts=PTS-STARTPTS${atempo ? `,${atempo}` : ''},aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=${trackOrigVol.toFixed(2)}${tlStartMs > 0 ? `,adelay=${tlStartMs}|${tlStartMs}` : ''},apad=whole_dur=${params.duration.toFixed(3)},atrim=0:${params.duration.toFixed(3)}[${outLbl}]`
          );
          outLabels.push(`[${outLbl}]`);
        });

        if (linkedClips.length === 1) {
          if (fadeSuffix) {
            filterSteps.push(
              `${outLabels[0]}asetpts=PTS-STARTPTS${fadeSuffix},apad=whole_dur=${params.duration.toFixed(3)},atrim=0:${params.duration.toFixed(3)}[a_orig]`
            );
          }
        } else {
          filterSteps.push(
            `${outLabels.join('')}amix=inputs=${linkedClips.length}:duration=first:dropout_transition=0:normalize=0${fadeSuffix},apad=whole_dur=${params.duration.toFixed(3)},atrim=0:${params.duration.toFixed(3)}[a_orig]`
          );
        }
        mixBranches.push('[a_orig]');
      }
    } else {
      const chain = `[0:a]volume=${trackOrigVol.toFixed(2)}${fadeSuffix}`;
      if (params.holds && params.holds.length > 0) {
        const holdSteps = buildAudioHoldFilter({
          sourceAudioChainPrefix: chain,
          outputLabel: 'a_orig',
          originalDuration: params.originalDuration || params.duration,
          holds: params.holds,
        });
        filterSteps.push(...holdSteps);
      } else {
        filterSteps.push(
          `${chain},apad=whole_dur=${params.duration.toFixed(2)},atrim=0:${params.duration.toFixed(2)}[a_orig]`
        );
      }
      mixBranches.push('[a_orig]');
    }
  }

  // 2. Fish Audio Voiceover (ALWAYS 1.0x speed, never scaled by video speed)
  if (dubAsset && fs.existsSync(dubAsset.file_path)) {
    const dubIdx = inputIdx++;
    extraInputs.push('-i', dubAsset.file_path);

    const offsetSec = Number(params.voice.timingOffsetSec || 0);
    const filters: string[] = [];

    if (offsetSec > 0.02) {
      const delayMs = Math.round(offsetSec * 1000);
      filters.push(`adelay=${delayMs}|${delayMs}`);
    } else if (offsetSec < -0.02) {
      const trimStart = Math.abs(offsetSec).toFixed(2);
      filters.push(`atrim=start=${trimStart},asetpts=PTS-STARTPTS`);
    }

    const voiceVol = Math.max(0, Math.min(2.0, Number(params.voice.voiceVolume ?? 1.0)));
    filters.push(`volume=${voiceVol.toFixed(2)}`);
    if (params.applyAudioMix && params.voice.fadeInSec > 0) {
      filters.push(`afade=t=in:st=0:d=${params.voice.fadeInSec.toFixed(2)}`);
    }
    if (
      params.applyAudioMix &&
      params.voice.fadeOutSec > 0 &&
      params.duration > params.voice.fadeOutSec
    ) {
      const fadeStart = Math.max(0, params.duration - params.voice.fadeOutSec).toFixed(2);
      filters.push(`afade=t=out:st=${fadeStart}:d=${params.voice.fadeOutSec.toFixed(2)}`);
    }
    filters.push(`apad=whole_dur=${params.duration.toFixed(2)}`);
    filters.push(`atrim=0:${params.duration.toFixed(2)}`);

    filterSteps.push(`[${dubIdx}:a]${filters.join(',')}[a_dub]`);
    mixBranches.push('[a_dub]');
  }

  // 3. Background Music (ALWAYS 1.0x; supports split/trimmed/deleted clips or legacy whole-track loop)
  const hasExplicitBgmClips = Array.isArray(params.voice.bgMusicClips);
  if (params.applyAudioMix && bgmEnabled && !params.voice.bgMusicMuted && Math.max(0, Number(params.voice.bgMusicVolume ?? 0)) > 0.005) {
    const trackBgmVol = Math.max(0, Math.min(2.0, Number(params.voice.bgMusicVolume ?? 0)));
    if (hasExplicitBgmClips) {
      const validBgmClips = (params.voice.bgMusicClips || []).filter((c) => {
        if (c.muted || Math.max(0, Number(c.volume ?? 1.0)) <= 0.005) return false;
        const asset = getAssetByUrl(c.audioUrl || params.voice.bgMusicUrl || '');
        return Boolean(asset && fs.existsSync(asset.file_path));
      });
      if (validBgmClips.length > 0) {
        const bgmBranchLabels: string[] = [];
        validBgmClips.forEach((c, i) => {
          const asset = getAssetByUrl(c.audioUrl || params.voice.bgMusicUrl || '')!;
          const idx = inputIdx++;
          if (c.loop) {
            extraInputs.push('-stream_loop', '-1', '-i', asset.file_path);
          } else {
            extraInputs.push('-i', asset.file_path);
          }
          const sStart = Math.max(0, Number(c.sourceStart || 0));
          const sEnd = Math.max(sStart + 0.05, Number(c.sourceEnd || params.duration));
          const tlStartMs = Math.max(0, Math.round(Number(c.timelineStart || 0) * 1000));
          const clipVol = Math.max(0, Math.min(2.0, trackBgmVol * Number(c.volume ?? 1.0)));
          const outLbl = validBgmClips.length === 1 && params.voice.fadeInSec <= 0 && params.voice.fadeOutSec <= 0 ? 'a_bgm' : `bgm_c_${i}`;
          filterSteps.push(
            `[${idx}:a]atrim=start=${sStart.toFixed(3)}:end=${sEnd.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=${clipVol.toFixed(2)}${tlStartMs > 0 ? `,adelay=${tlStartMs}|${tlStartMs}` : ''},apad=whole_dur=${params.duration.toFixed(3)},atrim=0:${params.duration.toFixed(3)}[${outLbl}]`
          );
          bgmBranchLabels.push(`[${outLbl}]`);
        });

        let bgmFade = '';
        if (params.voice.fadeInSec > 0) {
          bgmFade += `,afade=t=in:st=0:d=${params.voice.fadeInSec.toFixed(2)}`;
        }
        if (params.voice.fadeOutSec > 0 && params.duration > params.voice.fadeOutSec) {
          const fadeStart = Math.max(0, params.duration - params.voice.fadeOutSec).toFixed(2);
          bgmFade += `,afade=t=out:st=${fadeStart}:d=${params.voice.fadeOutSec.toFixed(2)}`;
        }
        if (validBgmClips.length === 1) {
          if (bgmFade) {
            filterSteps.push(`${bgmBranchLabels[0]}asetpts=PTS-STARTPTS${bgmFade}[a_bgm]`);
          }
        } else {
          filterSteps.push(
            `${bgmBranchLabels.join('')}amix=inputs=${validBgmClips.length}:duration=first:dropout_transition=0:normalize=0${bgmFade},apad=whole_dur=${params.duration.toFixed(3)},atrim=0:${params.duration.toFixed(3)}[a_bgm]`
          );
        }
        mixBranches.push('[a_bgm]');
      }
    } else if (musicAsset && fs.existsSync(musicAsset.file_path)) {
      const musicIdx = inputIdx++;
      extraInputs.push('-stream_loop', '-1', '-i', musicAsset.file_path);
      let chain = `[${musicIdx}:a]atrim=0:${params.duration.toFixed(2)},asetpts=PTS-STARTPTS,volume=${trackBgmVol.toFixed(2)}`;
      if (params.voice.fadeInSec > 0) {
        chain += `,afade=t=in:st=0:d=${params.voice.fadeInSec.toFixed(2)}`;
      }
      if (params.voice.fadeOutSec > 0 && params.duration > params.voice.fadeOutSec) {
        const fadeStart = Math.max(0, params.duration - params.voice.fadeOutSec).toFixed(2);
        chain += `,afade=t=out:st=${fadeStart}:d=${params.voice.fadeOutSec.toFixed(2)}`;
      }
      chain += `[a_bgm]`;
      filterSteps.push(chain);
      mixBranches.push('[a_bgm]');
    }
  }

  // 4. Sound Effects track (ALWAYS 1.0x; supports split/trimmed/deleted clips or legacy whole clip)
  const hasExplicitSfxClips = Array.isArray(params.voice.sfxClips);
  if (params.applyAudioMix && sfxEnabled && !params.voice.sfxMuted && Math.max(0, Number(params.voice.sfxVolume ?? 1.0)) > 0.005) {
    const trackSfxVol = Math.max(0, Math.min(2.0, Number(params.voice.sfxVolume ?? 1.0)));
    if (hasExplicitSfxClips) {
      const validSfxClips = (params.voice.sfxClips || []).filter((c) => {
        if (c.muted || Math.max(0, Number(c.volume ?? 1.0)) <= 0.005) return false;
        const asset = getAssetByUrl(c.audioUrl || params.voice.sfxUrl || '');
        return Boolean(asset && fs.existsSync(asset.file_path));
      });
      if (validSfxClips.length > 0) {
        const sfxBranchLabels: string[] = [];
        validSfxClips.forEach((c, i) => {
          const asset = getAssetByUrl(c.audioUrl || params.voice.sfxUrl || '')!;
          const idx = inputIdx++;
          extraInputs.push('-i', asset.file_path);
          const sStart = Math.max(0, Number(c.sourceStart || 0));
          const sEnd = Math.max(sStart + 0.05, Number(c.sourceEnd || params.duration));
          const tlStartMs = Math.max(0, Math.round(Number(c.timelineStart || 0) * 1000));
          const clipVol = Math.max(0, Math.min(2.0, trackSfxVol * Number(c.volume ?? 1.0)));
          const outLbl = validSfxClips.length === 1 ? 'a_sfx' : `sfx_c_${i}`;
          filterSteps.push(
            `[${idx}:a]atrim=start=${sStart.toFixed(3)}:end=${sEnd.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=${clipVol.toFixed(2)}${tlStartMs > 0 ? `,adelay=${tlStartMs}|${tlStartMs}` : ''},apad=whole_dur=${params.duration.toFixed(3)},atrim=0:${params.duration.toFixed(3)}[${outLbl}]`
          );
          sfxBranchLabels.push(`[${outLbl}]`);
        });
        if (validSfxClips.length > 1) {
          filterSteps.push(
            `${sfxBranchLabels.join('')}amix=inputs=${validSfxClips.length}:duration=first:dropout_transition=0:normalize=0,apad=whole_dur=${params.duration.toFixed(3)},atrim=0:${params.duration.toFixed(3)}[a_sfx]`
          );
        }
        mixBranches.push('[a_sfx]');
      }
    } else if (sfxAsset && fs.existsSync(sfxAsset.file_path)) {
      const sfxIdx = inputIdx++;
      extraInputs.push('-i', sfxAsset.file_path);
      filterSteps.push(
        `[${sfxIdx}:a]volume=${trackSfxVol.toFixed(2)},apad=whole_dur=${params.duration.toFixed(2)},atrim=0:${params.duration.toFixed(2)}[a_sfx]`
      );
      mixBranches.push('[a_sfx]');
    }
  }

  if (mixBranches.length === 0) {
    return {
      extraInputs,
      filterSteps,
      audioMapLabel: null,
      nextInputIndex: inputIdx,
    };
  }

  if (mixBranches.length === 1) {
    return {
      extraInputs,
      filterSteps,
      audioMapLabel: mixBranches[0],
      nextInputIndex: inputIdx,
    };
  }

  filterSteps.push(
    `${mixBranches.join('')}amix=inputs=${mixBranches.length}:duration=first:dropout_transition=2:normalize=0[a_final]`
  );

  return {
    extraInputs,
    filterSteps,
    audioMapLabel: '[a_final]',
    nextInputIndex: inputIdx,
  };
}
