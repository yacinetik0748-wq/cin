/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Project, VideoMetadata } from '../../src/types/studio.ts';
import { STORAGE_DIR } from '../db.ts';
import { analyzeVideoFile } from './video_analysis_service.ts';

function getProjectStorageDir(projectId: string): string {
  const dir = path.join(STORAGE_DIR, 'projects', projectId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export type CompressionPreset = 'under-45mb' | '720p-compact' | '480p-compact';

export function computeLocalStorageUsage() {
  const buckets: Record<string, { bytes: number; files: number }> = {
    uploads: { bytes: 0, files: 0 },
    exports: { bytes: 0, files: 0 },
    audio: { bytes: 0, files: 0 },
    fonts: { bytes: 0, files: 0 },
    thumbnails: { bytes: 0, files: 0 },
  };

  let totalBytes = 0;

  function scanDir(dir: string, bucketName: string) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const fullPath = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        scanDir(fullPath, bucketName);
      } else if (ent.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          totalBytes += stat.size;
          if (buckets[bucketName]) {
            buckets[bucketName].bytes += stat.size;
            buckets[bucketName].files += 1;
          }
        } catch {
          // ignore
        }
      }
    }
  }

  scanDir(path.join(STORAGE_DIR, 'uploads'), 'uploads');
  scanDir(path.join(STORAGE_DIR, 'exports'), 'exports');
  scanDir(path.join(STORAGE_DIR, 'audio'), 'audio');
  scanDir(path.join(STORAGE_DIR, 'fonts'), 'fonts');
  scanDir(path.join(STORAGE_DIR, 'thumbnails'), 'thumbnails');

  return { totalBytes, buckets };
}

export function inspectProjectAssets(project: Project) {
  const assets: Array<{
    localUrl: string;
    bucket: string;
    filename: string;
    assetKind: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    exists: boolean;
    exceedsFree50MbCap: boolean;
    necessaryForCloudSync: boolean;
  }> = [];

  const checkUrl = (url: string | null, bucket: string, assetKind: string) => {
    if (!url || url.startsWith('blob:') || url.startsWith('data:')) return;
    const rel = url.replace(/^\//, '');
    const absPath = path.resolve(STORAGE_DIR, rel);
    const exists = fs.existsSync(absPath);
    let sizeBytes = 0;
    let sha256 = 'local_hash';
    if (exists) {
      try {
        const stat = fs.statSync(absPath);
        sizeBytes = stat.size;
        const buf = fs.readFileSync(absPath);
        sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      } catch {
        // ignore
      }
    }
    assets.push({
      localUrl: url,
      bucket,
      filename: path.basename(absPath),
      assetKind,
      mimeType: 'video/mp4',
      sizeBytes,
      sha256,
      exists,
      exceedsFree50MbCap: sizeBytes > 50 * 1024 * 1024,
      necessaryForCloudSync: true,
    });
  };

  checkUrl(project.sourceVideoUrl, 'uploads', 'video');
  checkUrl(project.lastExportUrl, 'exports', 'video');
  checkUrl(project.thumbnailUrl, 'thumbnails', 'image');

  const totalBytes = assets.reduce((acc, a) => acc + a.sizeBytes, 0);
  const necessaryBytes = totalBytes;
  const oversizedCount = assets.filter((a) => a.exceedsFree50MbCap).length;

  return { assets, totalBytes, necessaryBytes, oversizedCount };
}

export async function compressProjectVideoForFreeCloud(opts: {
  project: Project;
  preset: CompressionPreset;
  target: 'source' | 'final-export';
}) {
  const { project, preset, target } = opts;
  const targetUrl = target === 'final-export' ? project.lastExportUrl : project.sourceVideoUrl;
  if (!targetUrl) {
    throw new Error('No video URL found for compression.');
  }

  const rel = targetUrl.replace(/^\//, '');
  const inputPath = path.resolve(STORAGE_DIR, rel);
  if (!fs.existsSync(inputPath)) {
    throw new Error('Video file not found on local disk.');
  }

  const projDir = getProjectStorageDir(project.id);
  const outFilename = `compressed_${Date.now()}.mp4`;
  const outputPath = path.resolve(projDir, outFilename);

  // Use local FFmpeg compression via spawn
  const { spawn } = await import('node:child_process');
  let vf = 'scale=-2:720';
  let crf = '28';
  if (preset === 'under-45mb') {
    vf = 'scale=-2:480';
    crf = '32';
  } else if (preset === '480p-compact') {
    vf = 'scale=-2:480';
    crf = '30';
  }

  await new Promise<void>((resolve, reject) => {
    const cp = spawn('ffmpeg', [
      '-y',
      '-i',
      inputPath,
      '-vf',
      vf,
      '-c:v',
      'libx264',
      '-crf',
      crf,
      '-preset',
      'fast',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      outputPath,
    ]);
    cp.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg compression exited with code ${code}`));
    });
    cp.on('error', (err) => reject(err));
  });

  const stat = fs.statSync(outputPath);
  const compressedBytes = stat.size;
  const originalStat = fs.statSync(inputPath);
  const originalBytes = originalStat.size;
  const metadata: VideoMetadata = await analyzeVideoFile(outputPath);

  const compressedUrl = `/storage/projects/${project.id}/${outFilename}`;
  return {
    project,
    compressedUrl,
    filename: outFilename,
    originalSourceUrl: targetUrl,
    originalBytes,
    compressedBytes,
    metadata,
    target,
  };
}

export function hydrateAssetToLocalBucket(opts: {
  projectId: string;
  targetLocalUrl?: string;
  bucket: string;
  filename: string;
  assetKind: string;
  mimeType: string;
  buffer: Buffer;
}) {
  const projDir = getProjectStorageDir(opts.projectId);
  if (!fs.existsSync(projDir)) {
    fs.mkdirSync(projDir, { recursive: true });
  }
  const safeName = opts.filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const filePath = path.resolve(projDir, safeName);
  fs.writeFileSync(filePath, opts.buffer);

  const localUrl = `/storage/projects/${opts.projectId}/${safeName}`;
  return {
    success: true,
    localUrl,
    filename: safeName,
    sizeBytes: opts.buffer.length,
  };
}
