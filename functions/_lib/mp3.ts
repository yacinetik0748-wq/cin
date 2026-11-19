/**
 * Lightweight pure-TypeScript MPEG Audio (MP3) duration scanner for Cloudflare Workers.
 * Avoids requiring ffprobe on the edge when computing exact Fish Audio clip durations.
 */

const MPEG1_BITRATES_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG2_BITRATES_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];

const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000],  // MPEG 2.5
};

export function parseMp3DurationSeconds(bytes: Uint8Array): number {
  if (!bytes || bytes.length < 16) return 0;

  let offset = 0;

  // Skip ID3v2 header if present
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33 && bytes.length >= 10) {
    const size =
      ((bytes[6] & 0x7f) << 21) |
      ((bytes[7] & 0x7f) << 14) |
      ((bytes[8] & 0x7f) << 7) |
      (bytes[9] & 0x7f);
    offset = Math.min(bytes.length, 10 + size);
  }

  let endLimit = bytes.length;
  if (
    endLimit >= 128 &&
    bytes[endLimit - 128] === 0x54 &&
    bytes[endLimit - 127] === 0x41 &&
    bytes[endLimit - 126] === 0x47
  ) {
    endLimit -= 128; // Ignore ID3v1 tag
  }

  let totalSamples = 0;
  let sampleRate = 44100;
  let validFrames = 0;

  while (offset + 4 <= endLimit) {
    // Check 11-bit frame sync: 0xFF followed by top 3 bits = 111
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) {
      offset += 1;
      continue;
    }

    const b1 = bytes[offset + 1];
    const b2 = bytes[offset + 2];
    const versionBits = (b1 >> 3) & 0x03; // 0=2.5, 1=reserved, 2=2, 3=1
    const layerBits = (b1 >> 1) & 0x03;   // 1=Layer III, 2=Layer II, 3=Layer I
    const bitrateIdx = (b2 >> 4) & 0x0f;
    const srIdx = (b2 >> 2) & 0x03;
    const padding = (b2 >> 1) & 0x01;

    if (versionBits === 1 || layerBits !== 1 || bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) {
      offset += 1;
      continue;
    }

    const sr = SAMPLE_RATES[versionBits]?.[srIdx];
    const kbps =
      versionBits === 3 ? MPEG1_BITRATES_L3[bitrateIdx] : MPEG2_BITRATES_L3[bitrateIdx];

    if (!sr || !kbps) {
      offset += 1;
      continue;
    }

    const samplesPerFrame = versionBits === 3 ? 1152 : 576;
    const frameLength = Math.floor(((samplesPerFrame / 8) * (kbps * 1000)) / sr) + padding;

    if (frameLength < 24 || offset + frameLength > endLimit + 4) {
      offset += 1;
      continue;
    }

    // Check Xing / Info header on the very first frame for instant exact duration
    if (validFrames === 0 && offset + 48 < endLimit) {
      const channelMode = (bytes[offset + 3] >> 6) & 0x03;
      const sideInfoLen =
        versionBits === 3 ? (channelMode === 3 ? 17 : 32) : channelMode === 3 ? 9 : 17;
      const xingOffset = offset + 4 + sideInfoLen;
      if (xingOffset + 12 <= endLimit) {
        const tag = String.fromCharCode(
          bytes[xingOffset],
          bytes[xingOffset + 1],
          bytes[xingOffset + 2],
          bytes[xingOffset + 3]
        );
        if (tag === 'Xing' || tag === 'Info') {
          const flags =
            (bytes[xingOffset + 4] << 24) |
            (bytes[xingOffset + 5] << 16) |
            (bytes[xingOffset + 6] << 8) |
            bytes[xingOffset + 7];
          if ((flags & 0x01) !== 0 && xingOffset + 12 <= endLimit) {
            const frameCount =
              ((bytes[xingOffset + 8] << 24) >>> 0) +
              (bytes[xingOffset + 9] << 16) +
              (bytes[xingOffset + 10] << 8) +
              bytes[xingOffset + 11];
            if (frameCount > 0) {
              return Number(((frameCount * samplesPerFrame) / sr).toFixed(3));
            }
          }
        }
      }
    }

    sampleRate = sr;
    totalSamples += samplesPerFrame;
    validFrames += 1;
    offset += frameLength;
  }

  if (validFrames > 0 && sampleRate > 0) {
    return Number((totalSamples / sampleRate).toFixed(3));
  }

  // Fallback rough estimate assuming 64 kbps MP3
  return Number(Math.max(0.2, (bytes.length * 8) / 64000).toFixed(3));
}
