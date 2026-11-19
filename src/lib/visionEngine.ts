import { TrackingKeyframe } from '../types/studio';

function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const clamped = Math.max(0, Math.min(video.duration || 10, time));
    if (Math.abs(video.currentTime - clamped) < 0.02) {
      resolve();
      return;
    }
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.currentTime = clamped;
  });
}

function getPatchGray(
  img: ImageData,
  px: number,
  py: number,
  pw: number,
  ph: number
): Float32Array {
  const out = new Float32Array(pw * ph);
  const w = img.width;
  const data = img.data;
  for (let y = 0; y < ph; y++) {
    const iy = Math.max(0, Math.min(img.height - 1, py + y));
    for (let x = 0; x < pw; x++) {
      const ix = Math.max(0, Math.min(w - 1, px + x));
      const idx = (iy * w + ix) * 4;
      out[y * pw + x] = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
    }
  }
  return out;
}

/**
 * Tracks a selected bounding box across video frames using Normalized Cross-Correlation
 * (NCC) block-matching in an adaptive local search window.
 */
export async function trackObjectAcrossVideo(params: {
  video: HTMLVideoElement;
  initialBox: { x: number; y: number; width: number; height: number };
  startTime: number;
  endTime: number;
  onProgress?: (pct: number) => void;
}): Promise<TrackingKeyframe[]> {
  const { video, initialBox, startTime, endTime, onProgress } = params;
  const wasPaused = video.paused;
  const prevTime = video.currentTime;
  video.pause();

  const canvas = document.createElement('canvas');
  const W = 320;
  const H = Math.max(180, Math.round((video.videoHeight / Math.max(1, video.videoWidth)) * W));
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

  const duration = Math.max(0.5, endTime - startTime);
  const stepSec = Math.max(0.15, Math.min(0.35, duration / 24));

  await seekVideo(video, startTime);
  ctx.drawImage(video, 0, 0, W, H);
  let frameImg = ctx.getImageData(0, 0, W, H);

  let curX = Math.round(initialBox.x * W);
  let curY = Math.round(initialBox.y * H);
  const boxW = Math.max(16, Math.round(initialBox.width * W));
  const boxH = Math.max(16, Math.round(initialBox.height * H));

  let template = getPatchGray(frameImg, curX, curY, boxW, boxH);

  const keyframes: TrackingKeyframe[] = [
    {
      time: Number(startTime.toFixed(2)),
      x: initialBox.x,
      y: initialBox.y,
      width: initialBox.width,
      height: initialBox.height,
    },
  ];

  // Mean-zero helper for NCC
  const computeMean = (arr: Float32Array) => {
    let sum = 0;
    for (let i = 0; i < arr.length; i++) sum += arr[i];
    return sum / arr.length;
  };

  let t = startTime + stepSec;
  while (t <= endTime + 0.01) {
    const sampleT = Math.min(endTime, t);
    await seekVideo(video, sampleT);
    ctx.drawImage(video, 0, 0, W, H);
    frameImg = ctx.getImageData(0, 0, W, H);

    const searchRadiusX = Math.round(W * 0.18);
    const searchRadiusY = Math.round(H * 0.18);
    const minX = Math.max(0, curX - searchRadiusX);
    const maxX = Math.min(W - boxW, curX + searchRadiusX);
    const minY = Math.max(0, curY - searchRadiusY);
    const maxY = Math.min(H - boxH, curY + searchRadiusY);

    const tMean = computeMean(template);
    let bestScore = -Infinity;
    let bestX = curX;
    let bestY = curY;

    // Coarse-to-fine search: step 3px first, then 1px refinement
    for (let sy = minY; sy <= maxY; sy += 3) {
      for (let sx = minX; sx <= maxX; sx += 3) {
        const cand = getPatchGray(frameImg, sx, sy, boxW, boxH);
        const cMean = computeMean(cand);
        let num = 0;
        let denA = 0;
        let denB = 0;
        for (let i = 0; i < cand.length; i += 2) {
          const da = template[i] - tMean;
          const db = cand[i] - cMean;
          num += da * db;
          denA += da * da;
          denB += db * db;
        }
        const score = num / Math.sqrt((denA * denB) + 1e-6);
        if (score > bestScore) {
          bestScore = score;
          bestX = sx;
          bestY = sy;
        }
      }
    }

    // Fine 1px neighborhood search around coarse peak
    for (let sy = Math.max(minY, bestY - 2); sy <= Math.min(maxY, bestY + 2); sy++) {
      for (let sx = Math.max(minX, bestX - 2); sx <= Math.min(maxX, bestX + 2); sx++) {
        const cand = getPatchGray(frameImg, sx, sy, boxW, boxH);
        const cMean = computeMean(cand);
        let num = 0;
        let denA = 0;
        let denB = 0;
        for (let i = 0; i < cand.length; i++) {
          const da = template[i] - tMean;
          const db = cand[i] - cMean;
          num += da * db;
          denA += da * da;
          denB += db * db;
        }
        const score = num / Math.sqrt((denA * denB) + 1e-6);
        if (score > bestScore) {
          bestScore = score;
          bestX = sx;
          bestY = sy;
        }
      }
    }

    curX = bestX;
    curY = bestY;
    // Gentle template blend when match confidence is strong
    if (bestScore > 0.65) {
      const fresh = getPatchGray(frameImg, curX, curY, boxW, boxH);
      for (let i = 0; i < template.length; i++) {
        template[i] = template[i] * 0.8 + fresh[i] * 0.2;
      }
    }

    keyframes.push({
      time: Number(sampleT.toFixed(2)),
      x: Number((curX / W).toFixed(4)),
      y: Number((curY / H).toFixed(4)),
      width: Number((boxW / W).toFixed(4)),
      height: Number((boxH / H).toFixed(4)),
    });

    if (onProgress) {
      onProgress(Math.min(100, Math.round(((sampleT - startTime) / duration) * 100)));
    }
    t += stepSec;
  }

  await seekVideo(video, prevTime);
  if (!wasPaused) {
    void video.play();
  }
  return keyframes;
}

/**
 * Generates an edge-and-saliency-aware foreground segmentation alpha matte PNG
 * from the active video frame for Background Blur compositing.
 */
export function generateForegroundMaskPng(video: HTMLVideoElement): string {
  const W = 320;
  const H = Math.max(180, Math.round((video.videoHeight / Math.max(1, video.videoWidth)) * W));

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = W;
  srcCanvas.height = H;
  const sCtx = srcCanvas.getContext('2d', { willReadFrequently: true })!;
  sCtx.drawImage(video, 0, 0, W, H);
  const srcData = sCtx.getImageData(0, 0, W, H).data;

  // Estimate border background median color from outer 6% ring
  let bgR = 0;
  let bgG = 0;
  let bgB = 0;
  let bgCount = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x < W * 0.07 || x > W * 0.93 || y < H * 0.07 || y > H * 0.93) {
        const idx = (y * W + x) * 4;
        bgR += srcData[idx];
        bgG += srcData[idx + 1];
        bgB += srcData[idx + 2];
        bgCount++;
      }
    }
  }
  bgR /= Math.max(1, bgCount);
  bgG /= Math.max(1, bgCount);
  bgB /= Math.max(1, bgCount);

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = W;
  maskCanvas.height = H;
  const mCtx = maskCanvas.getContext('2d')!;
  const outImg = mCtx.createImageData(W, H);

  for (let y = 0; y < H; y++) {
    const ny = (y / H - 0.52) * 2;
    for (let x = 0; x < W; x++) {
      const nx = (x / W - 0.5) * 2;
      const idx = (y * W + x) * 4;

      const dr = srcData[idx] - bgR;
      const dg = srcData[idx + 1] - bgG;
      const db = srcData[idx + 2] - bgB;
      const colorDist = Math.sqrt(dr * dr + dg * dg + db * db) / 255;

      // Combine color separation with central subject spatial prior
      const radialDist = Math.sqrt((nx * nx) / 0.65 + (ny * ny) / 0.95);
      const spatialPrior = Math.max(0, Math.min(1, 1.15 - radialDist * 0.85));
      const score = colorDist * 0.85 + spatialPrior * 0.65;
      const alpha = Math.max(0, Math.min(255, Math.round(((score - 0.42) / 0.35) * 255)));

      outImg.data[idx] = alpha;
      outImg.data[idx + 1] = alpha;
      outImg.data[idx + 2] = alpha;
      outImg.data[idx + 3] = 255;
    }
  }

  mCtx.putImageData(outImg, 0, 0);

  // Smooth the matte edges cleanly
  const smoothCanvas = document.createElement('canvas');
  smoothCanvas.width = W;
  smoothCanvas.height = H;
  const smCtx = smoothCanvas.getContext('2d')!;
  smCtx.filter = 'blur(4px)';
  smCtx.drawImage(maskCanvas, 0, 0);

  return smoothCanvas.toDataURL('image/png');
}

export function interpolateTrackingBox(
  keyframes: TrackingKeyframe[],
  time: number
): { x: number; y: number; width: number; height: number } | null {
  if (!keyframes || keyframes.length === 0) return null;
  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  if (time <= sorted[0].time) return sorted[0];
  if (time >= sorted[sorted.length - 1].time) return sorted[sorted.length - 1];

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (time >= a.time && time <= b.time) {
      const ratio = (time - a.time) / Math.max(0.001, b.time - a.time);
      return {
        x: a.x + (b.x - a.x) * ratio,
        y: a.y + (b.y - a.y) * ratio,
        width: a.width + (b.width - a.width) * ratio,
        height: a.height + (b.height - a.height) * ratio,
      };
    }
  }
  return sorted[0];
}
