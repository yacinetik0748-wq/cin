import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { Type } from '@google/genai';
import { v4 as uuidv4 } from 'uuid';
import { DetectedSubtitleRegion } from '../../src/types/studio.ts';
import { getGeminiClient, isGeminiConfigured } from './gemini_client.ts';
import { TEMP_DIR } from '../db.ts';

export interface CaptionDetectionResult {
  detections: DetectedSubtitleRegion[];
  ocrAvailable: boolean;
  method: 'hybrid' | 'ocr' | 'visual' | 'unavailable';
  analysisMessage: string;
  framesAnalyzed: number;
}

interface RawFrameCandidate {
  frameIndex: number;
  timestamp: number;
  band: 'bottom' | 'top' | 'middle';
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  detectedText?: string;
  method: 'ocr' | 'visual' | 'hybrid';
}

function classifyBand(centerY: number): 'bottom' | 'top' | 'middle' {
  if (centerY < 0.34) return 'top';
  if (centerY > 0.65) return 'bottom';
  return 'middle';
}

async function extractGrayscaleFrames(params: {
  videoPath: string;
  fps: number;
  width: number;
  height: number;
  maxFrames: number;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      '-v',
      'error',
      '-i',
      params.videoPath,
      '-vf',
      `fps=${params.fps.toFixed(4)},scale=${params.width}:${params.height},format=gray`,
      '-frames:v',
      String(params.maxFrames),
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      'pipe:1',
    ];
    const proc = spawn('ffmpeg', args);
    const chunks: Buffer[] = [];
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`FFmpeg frame analysis failed (exit ${code}): ${stderr.slice(-300)}`));
      }
    });
  });
}

async function extractJpegFrameAt(
  videoPath: string,
  timestampSec: number,
  outPath: string
): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-ss',
      Math.max(0, timestampSec).toFixed(3),
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-vf',
      'scale=640:-2',
      '-q:v',
      '4',
      outPath,
    ]);
    proc.on('close', (code) => resolve(code === 0 && fs.existsSync(outPath)));
    proc.on('error', () => resolve(false));
  });
}

/**
 * Pure pixel luminance & high-contrast stroke band detector on real decoded video frames.
 * Targets crisp burned-in subtitle glyphs (bright-on-dark or dark-on-light boxes) across
 * bottom, top, and middle bands while filtering background textures and corner logos.
 */
function analyzeFrameLuminanceForSubtitles(
  frame: Buffer,
  w: number,
  h: number,
  frameIndex: number,
  timestamp: number
): RawFrameCandidate[] {
  const strokeMap = new Uint8Array(w * h);
  const rowStrokeCount = new Float32Array(h);

  for (let y = 2; y < h - 2; y++) {
    let rowCount = 0;
    const rowOff = y * w;
    for (let x = 3; x < w - 3; x++) {
      const idx = rowOff + x;
      const cur = frame[idx];
      const hx = Math.abs(frame[idx + 1] - frame[idx - 1]);
      const vy = Math.abs(frame[idx + w] - frame[idx - w]);

      if (hx < 34 && vy < 34) continue;

      let localMin = cur;
      let localMax = cur;
      for (let dy = -1; dy <= 1; dy++) {
        const r = (y + dy) * w;
        for (let dx = -2; dx <= 2; dx++) {
          const v = frame[r + x + dx];
          if (v < localMin) localMin = v;
          if (v > localMax) localMax = v;
        }
      }

      const contrast = localMax - localMin;
      // Subtitle text has sharp local polarity jump between bright glyph/box and dark outline/bg
      if (contrast >= 82 && localMax >= 150 && localMin <= 110) {
        strokeMap[idx] = 1;
        rowCount += 1;
      }
    }
    rowStrokeCount[y] = rowCount;
  }

  const bands: Array<{ name: 'bottom' | 'top' | 'middle'; yStart: number; yEnd: number }> = [
    { name: 'bottom', yStart: Math.floor(h * 0.65), yEnd: Math.floor(h * 0.96) },
    { name: 'top', yStart: Math.floor(h * 0.04), yEnd: Math.floor(h * 0.33) },
    { name: 'middle', yStart: Math.floor(h * 0.35), yEnd: Math.floor(h * 0.64) },
  ];

  const results: RawFrameCandidate[] = [];
  const minLineH = Math.max(6, Math.round(h * 0.022));
  const maxLineH = Math.max(minLineH + 6, Math.round(h * 0.22));

  for (const band of bands) {
    // Active rows have meaningful stroke pixel counts, but not full-row busy scenery noise (>72%)
    const activeRows: boolean[] = new Array(h).fill(false);
    for (let y = band.yStart; y <= band.yEnd; y++) {
      const ratio = rowStrokeCount[y] / w;
      if (ratio >= 0.022 && ratio <= 0.65) {
        activeRows[y] = true;
      }
    }

    // Group contiguous active rows allowing small gaps between multi-line subtitles
    const rowGroups: Array<{ y0: number; y1: number }> = [];
    let curStart = -1;
    let gap = 0;
    const maxGap = Math.max(2, Math.round(h * 0.015));

    for (let y = band.yStart; y <= band.yEnd; y++) {
      if (activeRows[y]) {
        if (curStart === -1) curStart = y;
        gap = 0;
      } else if (curStart !== -1) {
        gap += 1;
        if (gap > maxGap) {
          rowGroups.push({ y0: curStart, y1: y - gap });
          curStart = -1;
          gap = 0;
        }
      }
    }
    if (curStart !== -1) {
      rowGroups.push({ y0: curStart, y1: band.yEnd - gap });
    }

    let bestBandCandidate: RawFrameCandidate | null = null;

    for (const grp of rowGroups) {
      const gh = grp.y1 - grp.y0 + 1;
      if (gh < minLineH || gh > maxLineH) continue;

      // Project strokes horizontally across the row group
      const colProj = new Float32Array(w);
      for (let x = 2; x < w - 2; x++) {
        let sum = 0;
        for (let y = grp.y0; y <= grp.y1; y++) {
          sum += strokeMap[y * w + x];
        }
        colProj[x] = sum / gh;
      }

      // Smooth horizontally across word spaces (~2.5% of frame width)
      const smoothR = Math.max(4, Math.round(w * 0.022));
      const smoothed = new Float32Array(w);
      for (let x = 2; x < w - 2; x++) {
        let acc = 0;
        let cnt = 0;
        const lx = Math.max(0, x - smoothR);
        const rx = Math.min(w - 1, x + smoothR);
        for (let k = lx; k <= rx; k++) {
          acc += colProj[k];
          cnt += 1;
        }
        smoothed[x] = acc / Math.max(1, cnt);
      }

      // Extract horizontal spans above threshold
      let runStart = -1;
      const colSpans: Array<{ x0: number; x1: number; avg: number }> = [];
      for (let x = 4; x < w - 4; x++) {
        if (smoothed[x] >= 0.055) {
          if (runStart === -1) runStart = x;
        } else if (runStart !== -1) {
          let avg = 0;
          for (let k = runStart; k < x; k++) avg += colProj[k];
          colSpans.push({ x0: runStart, x1: x - 1, avg: avg / Math.max(1, x - runStart) });
          runStart = -1;
        }
      }
      if (runStart !== -1) {
        let avg = 0;
        for (let k = runStart; k < w - 4; k++) avg += colProj[k];
        colSpans.push({ x0: runStart, x1: w - 5, avg: avg / Math.max(1, w - 4 - runStart) });
      }

      // Merge nearby horizontal spans on the same line
      const mergedSpans: Array<{ x0: number; x1: number; avg: number }> = [];
      const mergeGap = Math.max(8, Math.round(w * 0.04));
      for (const sp of colSpans) {
        if (sp.x1 - sp.x0 < Math.max(10, w * 0.03)) continue;
        const prev = mergedSpans[mergedSpans.length - 1];
        if (prev && sp.x0 - prev.x1 <= mergeGap) {
          const w1 = prev.x1 - prev.x0 + 1;
          const w2 = sp.x1 - sp.x0 + 1;
          prev.avg = (prev.avg * w1 + sp.avg * w2) / (w1 + w2);
          prev.x1 = sp.x1;
        } else {
          mergedSpans.push({ ...sp });
        }
      }

      for (const sp of mergedSpans) {
        const bw = sp.x1 - sp.x0 + 1;
        const nx = sp.x0 / w;
        const ny = grp.y0 / h;
        const nw = bw / w;
        const nh = gh / h;
        const cx = nx + nw / 2;

        // Subtitle shape constraints
        if (nw < 0.08 || nw > 0.94) continue;
        if (bw / Math.max(1, gh) < 1.35) continue;

        // Filter typical corner logos / watermarks
        if (nw < 0.24 && (cx < 0.22 || cx > 0.78) && band.name !== 'middle') {
          continue;
        }

        // Measure quietness immediately above & below to separate subtitle bars from busy textures
        const padRows = Math.max(2, Math.round(h * 0.015));
        let borderDensity = 0;
        let borderSamples = 0;
        for (
          let y = Math.max(0, grp.y0 - padRows);
          y < grp.y0;
          y++
        ) {
          for (let x = sp.x0; x <= sp.x1; x++) {
            borderDensity += strokeMap[y * w + x];
            borderSamples += 1;
          }
        }
        for (
          let y = grp.y1 + 1;
          y <= Math.min(h - 1, grp.y1 + padRows);
          y++
        ) {
          for (let x = sp.x0; x <= sp.x1; x++) {
            borderDensity += strokeMap[y * w + x];
            borderSamples += 1;
          }
        }
        const avgBorder = borderSamples > 0 ? borderDensity / borderSamples : 0;
        const contrastRatio = sp.avg / Math.max(0.015, avgBorder);
        if (contrastRatio < 1.35) continue;

        // Favor horizontally centered subtitle placements
        const centerDist = Math.abs(cx - 0.5);
        if (centerDist > 0.28 && nw < 0.45) continue;

        const centerBonus = Math.max(0.3, 1 - centerDist * 1.4);
        const densityScore = Math.min(1, sp.avg * 3.5);
        const isolationScore = Math.min(1, (contrastRatio - 1.2) / 3.0);
        const score = Number(
          Math.min(0.96, 0.35 * densityScore + 0.4 * isolationScore + 0.25 * centerBonus).toFixed(3)
        );

        if (score < 0.42) continue;

        if (!bestBandCandidate || score > bestBandCandidate.score) {
          bestBandCandidate = {
            frameIndex,
            timestamp,
            band: band.name,
            x: nx,
            y: ny,
            width: nw,
            height: nh,
            score,
            method: 'visual',
          };
        }
      }
    }

    if (bestBandCandidate) {
      results.push(bestBandCandidate);
    }
  }

  return results;
}

async function runGeminiSubtitleOcr(
  videoPath: string,
  timestamps: number[],
  projectId: string
): Promise<{
  available: boolean;
  candidates: RawFrameCandidate[];
  errorMessage?: string;
}> {
  if (!isGeminiConfigured()) {
    return {
      available: false,
      candidates: [],
      errorMessage:
        'AI OCR is not configured (GEMINI_API_KEY is unset). Running real visual frame contrast analysis instead.',
    };
  }

  const tempDir = path.join(TEMP_DIR, `ocr_${projectId}_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // Sample up to 14 key frames for OCR to keep payload compact & fast
    const maxOcrFrames = 14;
    const step = Math.max(1, Math.ceil(timestamps.length / maxOcrFrames));
    const sampledIndices: number[] = [];
    for (let i = 0; i < timestamps.length; i += step) {
      sampledIndices.push(i);
    }

    const parts: Array<
      | { text: string }
      | { inlineData: { mimeType: string; data: string } }
    > = [];
    const includedFrames: Array<{ frameIndex: number; timestamp: number }> = [];

    for (const idx of sampledIndices) {
      const ts = timestamps[idx];
      const imgPath = path.join(tempDir, `f_${idx}.jpg`);
      const ok = await extractJpegFrameAt(videoPath, ts, imgPath);
      if (!ok) continue;
      const b64 = fs.readFileSync(imgPath).toString('base64');
      includedFrames.push({ frameIndex: idx, timestamp: ts });
      parts.push({ text: `Frame ${idx} (${ts.toFixed(2)}s):` });
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: b64 } });
    }

    if (includedFrames.length === 0) {
      return { available: false, candidates: [], errorMessage: 'No frames could be extracted for OCR.' };
    }

    parts.push({
      text: `Analyze these sequential video frames for burned-in subtitles / captions ONLY.
Ignore scene text such as street signs, store signs, clothing text, watermarks, channel logos, or HUD counters unless they are dialogue subtitles.
For each frame where a burned-in subtitle or caption appears, output its bounding box in normalized 0..1000 coordinates (ymin, xmin, ymax, xmax), the OCR subtitle text, band ('bottom', 'top', or 'middle'), and confidence (0..1).
Return only genuine burned-in subtitle regions.`,
    });

    const ai = getGeminiClient();
    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: { parts },
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            frames: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  frameIndex: { type: Type.INTEGER },
                  subtitles: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        band: { type: Type.STRING },
                        text: { type: Type.STRING },
                        ymin: { type: Type.NUMBER },
                        xmin: { type: Type.NUMBER },
                        ymax: { type: Type.NUMBER },
                        xmax: { type: Type.NUMBER },
                        confidence: { type: Type.NUMBER },
                      },
                      required: ['ymin', 'xmin', 'ymax', 'xmax', 'text'],
                    },
                  },
                },
                required: ['frameIndex', 'subtitles'],
              },
            },
          },
          required: ['frames'],
        },
      },
    });

    const rawText = (response.text || '').trim();
    if (!rawText) {
      return { available: true, candidates: [] };
    }

    const parsed = JSON.parse(rawText) as {
      frames?: Array<{
        frameIndex: number;
        subtitles?: Array<{
          band?: string;
          text?: string;
          ymin: number;
          xmin: number;
          ymax: number;
          xmax: number;
          confidence?: number;
        }>;
      }>;
    };

    const tsByFrame = new Map(includedFrames.map((f) => [f.frameIndex, f.timestamp]));
    const candidates: RawFrameCandidate[] = [];

    for (const fr of parsed.frames || []) {
      const ts = tsByFrame.get(fr.frameIndex);
      if (ts === undefined) continue;
      for (const sub of fr.subtitles || []) {
        const text = String(sub.text || '').trim();
        if (!text) continue;
        const ymin = Math.max(0, Math.min(0.98, sub.ymin / 1000));
        const xmin = Math.max(0, Math.min(0.98, sub.xmin / 1000));
        const ymax = Math.max(ymin + 0.02, Math.min(1, sub.ymax / 1000));
        const xmax = Math.max(xmin + 0.04, Math.min(1, sub.xmax / 1000));
        const cy = (ymin + ymax) / 2;
        const band =
          sub.band === 'top' || sub.band === 'middle' || sub.band === 'bottom'
            ? sub.band
            : classifyBand(cy);
        candidates.push({
          frameIndex: fr.frameIndex,
          timestamp: ts,
          band,
          x: xmin,
          y: ymin,
          width: xmax - xmin,
          height: ymax - ymin,
          score: Math.max(0.5, Math.min(1, Number(sub.confidence ?? 0.9))),
          detectedText: text,
          method: 'ocr',
        });
      }
    }

    return { available: true, candidates };
  } catch (err) {
    return {
      available: false,
      candidates: [],
      errorMessage: `AI OCR request failed (${err instanceof Error ? err.message : String(err)}). Using real visual contrast analysis instead.`,
    };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  }
}

function textMatchesRoughly(a?: string, b?: string): boolean {
  if (!a || !b) return true;
  const na = a.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ').trim();
  const nb = b.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ').trim();
  if (!na || !nb) return true;
  if (na === nb) return true;
  return na.includes(nb) || nb.includes(na);
}

/**
 * Groups consecutive frame candidates into clean temporal subtitle intervals & bounding boxes.
 */
function groupCandidatesIntoIntervals(
  candidates: RawFrameCandidate[],
  sampleStepSec: number,
  duration: number
): DetectedSubtitleRegion[] {
  if (candidates.length === 0) return [];

  const byBand: Record<'bottom' | 'top' | 'middle', RawFrameCandidate[]> = {
    bottom: [],
    top: [],
    middle: [],
  };
  for (const c of candidates) {
    byBand[c.band].push(c);
  }

  const regions: DetectedSubtitleRegion[] = [];
  const halfStep = sampleStepSec * 0.55;

  for (const band of ['bottom', 'top', 'middle'] as const) {
    const list = [...byBand[band]].sort((a, b) => a.timestamp - b.timestamp);
    if (list.length === 0) continue;

    interface Cluster {
      items: RawFrameCandidate[];
      startTs: number;
      endTs: number;
      lastText?: string;
    }

    const clusters: Cluster[] = [];
    for (const cand of list) {
      const prev = clusters[clusters.length - 1];
      if (!prev) {
        clusters.push({
          items: [cand],
          startTs: cand.timestamp,
          endTs: cand.timestamp,
          lastText: cand.detectedText,
        });
        continue;
      }

      const lastItem = prev.items[prev.items.length - 1];
      const dt = cand.timestamp - lastItem.timestamp;
      const yMidDiff = Math.abs(
        cand.y + cand.height / 2 - (lastItem.y + lastItem.height / 2)
      );
      const sameText = textMatchesRoughly(prev.lastText, cand.detectedText);

      // Group consecutive frames belonging to the same subtitle line/interval
      if (dt <= sampleStepSec * 1.85 && yMidDiff <= 0.085 && sameText) {
        prev.items.push(cand);
        prev.endTs = cand.timestamp;
        if (cand.detectedText) prev.lastText = cand.detectedText;
      } else {
        clusters.push({
          items: [cand],
          startTs: cand.timestamp,
          endTs: cand.timestamp,
          lastText: cand.detectedText,
        });
      }
    }

    for (const cl of clusters) {
      // Suppress transient single-frame background artifacts unless high-confidence
      const avgScore =
        cl.items.reduce((s, it) => s + it.score, 0) / Math.max(1, cl.items.length);
      if (cl.items.length < 2 && avgScore < 0.68) continue;

      let minX = 1;
      let minY = 1;
      let maxX = 0;
      let maxY = 0;
      let hasOcr = false;
      let hasVisual = false;
      let bestText: string | undefined;

      for (const it of cl.items) {
        minX = Math.min(minX, it.x);
        minY = Math.min(minY, it.y);
        maxX = Math.max(maxX, it.x + it.width);
        maxY = Math.max(maxY, it.y + it.height);
        if (it.method === 'ocr' || it.method === 'hybrid') hasOcr = true;
        if (it.method === 'visual' || it.method === 'hybrid') hasVisual = true;
        if (it.detectedText && (!bestText || it.detectedText.length > bestText.length)) {
          bestText = it.detectedText;
        }
      }

      // Gentle padding around glyphs so outlines/drop-shadows are fully covered
      const padX = 0.025;
      const padY = 0.018;
      const fx = Math.max(0, minX - padX);
      const fy = Math.max(0, minY - padY);
      const fx2 = Math.min(1, maxX + padX);
      const fy2 = Math.min(1, maxY + padY);

      const startTime = Math.max(0, Number((cl.startTs - halfStep).toFixed(2)));
      const endTime = Math.min(
        duration,
        Math.max(startTime + 0.35, Number((cl.endTs + halfStep).toFixed(2)))
      );

      regions.push({
        id: uuidv4(),
        x: Number(fx.toFixed(4)),
        y: Number(fy.toFixed(4)),
        width: Number(Math.max(0.08, fx2 - fx).toFixed(4)),
        height: Number(Math.max(0.04, fy2 - fy).toFixed(4)),
        startTime,
        endTime,
        band,
        confidence: Number(Math.min(0.99, avgScore).toFixed(2)),
        detectedText: bestText,
        method: hasOcr && hasVisual ? 'hybrid' : hasOcr ? 'ocr' : 'visual',
        framesMatched: cl.items.length,
        selected: true,
      });
    }
  }

  return regions.sort((a, b) => a.startTime - b.startTime);
}

export async function detectOriginalCaptionsInVideo(params: {
  projectId: string;
  videoPath: string;
  duration: number;
  videoWidth: number;
  videoHeight: number;
}): Promise<CaptionDetectionResult> {
  if (!params.videoPath || !fs.existsSync(params.videoPath)) {
    throw new Error('Source video file is missing on disk.');
  }
  const duration = Math.max(0.5, Number(params.duration || 0));
  const srcW = Math.max(64, Number(params.videoWidth || 1280));
  const srcH = Math.max(64, Number(params.videoHeight || 720));

  // Sample up to 24 evenly spaced frames across the video
  const targetCount = Math.min(24, Math.max(6, Math.round(duration * 2.2)));
  const fps = Math.max(0.35, Math.min(3.0, targetCount / duration));
  const sampleStepSec = 1 / fps;

  const aw = 480;
  const ah = Math.max(64, Math.round((aw * srcH) / srcW) & ~1);
  const frameByteSize = aw * ah;

  const rawBuffer = await extractGrayscaleFrames({
    videoPath: params.videoPath,
    fps,
    width: aw,
    height: ah,
    maxFrames: targetCount + 2,
  });

  const framesAnalyzed = Math.floor(rawBuffer.length / frameByteSize);
  if (framesAnalyzed === 0) {
    return {
      detections: [],
      ocrAvailable: false,
      method: 'unavailable',
      analysisMessage:
        'Could not decode video frames for automatic caption detection. Create a manual blur mask instead.',
      framesAnalyzed: 0,
    };
  }

  const timestamps: number[] = [];
  const visualCandidates: RawFrameCandidate[] = [];

  for (let i = 0; i < framesAnalyzed; i++) {
    const ts = Math.min(duration - 0.02, Math.max(0, (i + 0.5) * sampleStepSec));
    timestamps.push(ts);
    const frameBuf = rawBuffer.subarray(i * frameByteSize, (i + 1) * frameByteSize);
    const found = analyzeFrameLuminanceForSubtitles(frameBuf, aw, ah, i, ts);
    visualCandidates.push(...found);
  }

  const ocrRes = await runGeminiSubtitleOcr(params.videoPath, timestamps, params.projectId);

  // Merge OCR + visual candidates cleanly
  const mergedCandidates: RawFrameCandidate[] = [];
  if (ocrRes.available && ocrRes.candidates.length > 0) {
    // Combine OCR candidates with aligned visual detections
    const usedVisual = new Set<number>();
    for (const ocr of ocrRes.candidates) {
      let matchedVisIdx = -1;
      for (let vi = 0; vi < visualCandidates.length; vi++) {
        if (usedVisual.has(vi)) continue;
        const v = visualCandidates[vi];
        if (v.band === ocr.band && Math.abs(v.timestamp - ocr.timestamp) <= sampleStepSec * 0.9) {
          matchedVisIdx = vi;
          break;
        }
      }
      if (matchedVisIdx >= 0) {
        usedVisual.add(matchedVisIdx);
        const v = visualCandidates[matchedVisIdx];
        const x0 = Math.min(ocr.x, v.x);
        const y0 = Math.min(ocr.y, v.y);
        const x1 = Math.max(ocr.x + ocr.width, v.x + v.width);
        const y1 = Math.max(ocr.y + ocr.height, v.y + v.height);
        mergedCandidates.push({
          ...ocr,
          x: x0,
          y: y0,
          width: x1 - x0,
          height: y1 - y0,
          score: Math.min(0.99, (ocr.score + v.score) / 2 + 0.12),
          method: 'hybrid',
        });
      } else {
        mergedCandidates.push(ocr);
      }
    }
    // Also retain high-confidence visual detections on intermediate timestamps between OCR samples
    for (let vi = 0; vi < visualCandidates.length; vi++) {
      if (usedVisual.has(vi)) continue;
      const v = visualCandidates[vi];
      const matchesOcrBand = ocrRes.candidates.some(
        (o) => o.band === v.band && Math.abs(o.timestamp - v.timestamp) <= sampleStepSec * 2.5
      );
      if (matchesOcrBand && v.score >= 0.5) {
        mergedCandidates.push({ ...v, method: 'hybrid' });
      }
    }
  } else {
    mergedCandidates.push(...visualCandidates);
  }

  const detections = groupCandidatesIntoIntervals(mergedCandidates, sampleStepSec, duration);

  const method: CaptionDetectionResult['method'] =
    ocrRes.available && ocrRes.candidates.length > 0
      ? visualCandidates.length > 0
        ? 'hybrid'
        : 'ocr'
      : 'visual';

  let analysisMessage: string;
  if (!ocrRes.available) {
    analysisMessage = detections.length > 0
      ? `OCR text recognition unavailable (${ocrRes.errorMessage || 'no API key'}). Visual frame contrast analysis analyzed ${framesAnalyzed} frames and found ${detections.length} candidate subtitle region(s). Review before applying or create masks manually.`
      : `OCR text recognition unavailable (${ocrRes.errorMessage || 'no API key'}). Visual frame analysis checked ${framesAnalyzed} frames and found no repeated subtitle bands. You can create manual blur masks instead.`;
  } else if (detections.length === 0) {
    analysisMessage = `Analyzed ${framesAnalyzed} frames with OCR & visual contrast analysis; no burned-in subtitles were detected. You can create manual blur masks anytime.`;
  } else {
    analysisMessage = `Analyzed ${framesAnalyzed} frames (${method === 'hybrid' ? 'OCR + Visual Analysis' : 'AI OCR'}) and detected ${detections.length} subtitle region(s). Review and apply below.`;
  }

  return {
    detections,
    ocrAvailable: ocrRes.available,
    method,
    analysisMessage,
    framesAnalyzed,
  };
}
