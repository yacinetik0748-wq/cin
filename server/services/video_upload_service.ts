import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  AUDIO_DIR,
  BACKGROUNDS_DIR,
  CHUNKS_DIR,
  FONTS_DIR,
  LOGOS_DIR,
  MASKS_DIR,
  UPLOADS_DIR,
  registerAsset,
} from '../db.ts';

const ALLOWED_VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv']);
const ALLOWED_LOGO_EXTS = new Set(['.png', '.svg']);
const ALLOWED_BG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const ALLOWED_FONT_EXTS = new Set(['.ttf', '.otf', '.woff', '.woff2']);
const ALLOWED_AUDIO_EXTS = new Set(['.mp3', '.wav', '.aac', '.m4a', '.ogg']);

interface ChunkSession {
  uploadId: string;
  projectId: string;
  filename: string;
  totalSize: number;
  totalChunks: number;
  receivedChunks: Set<number>;
  tempDir: string;
  createdAt: number;
}

const chunkSessions = new Map<string, ChunkSession>();

export function getMaxUploadBytes(): number {
  const mb = Number(process.env.MAX_UPLOAD_SIZE_MB || '2048');
  return Math.max(50, mb) * 1024 * 1024;
}

export function validateVideoUpload(filename: string, sizeBytes: number) {
  const ext = path.extname(filename).toLowerCase();
  if (!ALLOWED_VIDEO_EXTS.has(ext)) {
    throw new Error(`Unsupported video format "${ext}". Allowed formats: MP4, MOV, MKV.`);
  }
  const maxBytes = getMaxUploadBytes();
  if (sizeBytes > maxBytes) {
    throw new Error(
      `File exceeds maximum allowed size (${Math.round(maxBytes / (1024 * 1024))} MB).`
    );
  }
}

export function initChunkedUpload(params: {
  projectId: string;
  filename: string;
  totalSize: number;
  totalChunks: number;
}): ChunkSession {
  validateVideoUpload(params.filename, params.totalSize);
  const uploadId = uuidv4();
  const tempDir = path.join(CHUNKS_DIR, uploadId);
  fs.mkdirSync(tempDir, { recursive: true });

  const session: ChunkSession = {
    uploadId,
    projectId: params.projectId,
    filename: sanitizeFilename(params.filename),
    totalSize: params.totalSize,
    totalChunks: params.totalChunks,
    receivedChunks: new Set<number>(),
    tempDir,
    createdAt: Date.now(),
  };

  chunkSessions.set(uploadId, session);
  return session;
}

export function saveUploadChunk(uploadId: string, chunkIndex: number, buffer: Buffer) {
  const session = chunkSessions.get(uploadId);
  if (!session) {
    throw new Error('Upload session expired or not found.');
  }
  if (chunkIndex < 0 || chunkIndex >= session.totalChunks) {
    throw new Error(`Invalid chunk index ${chunkIndex}.`);
  }
  const chunkPath = path.join(session.tempDir, `chunk_${String(chunkIndex).padStart(6, '0')}`);
  fs.writeFileSync(chunkPath, buffer);
  session.receivedChunks.add(chunkIndex);
  return {
    received: session.receivedChunks.size,
    totalChunks: session.totalChunks,
  };
}

export async function finalizeChunkedUpload(uploadId: string): Promise<{
  filePath: string;
  filename: string;
  url: string;
  sizeBytes: number;
}> {
  const session = chunkSessions.get(uploadId);
  if (!session) {
    throw new Error('Upload session not found.');
  }
  if (session.receivedChunks.size !== session.totalChunks) {
    throw new Error(
      `Incomplete upload: received ${session.receivedChunks.size} of ${session.totalChunks} chunks.`
    );
  }

  const ext = path.extname(session.filename).toLowerCase();
  const safeBase = path.basename(session.filename, ext);
  const finalFilename = `${session.projectId.slice(0, 8)}_${Date.now()}_${safeBase}${ext}`;
  const finalPath = path.join(UPLOADS_DIR, finalFilename);

  const writeStream = fs.createWriteStream(finalPath);
  for (let i = 0; i < session.totalChunks; i++) {
    const chunkPath = path.join(session.tempDir, `chunk_${String(i).padStart(6, '0')}`);
    const data = fs.readFileSync(chunkPath);
    writeStream.write(data);
  }
  await new Promise<void>((resolve, reject) => {
    writeStream.on('finish', () => resolve());
    writeStream.on('error', reject);
    writeStream.end();
  });

  // Clean chunk temp directory
  fs.rmSync(session.tempDir, { recursive: true, force: true });
  chunkSessions.delete(uploadId);

  const stat = fs.statSync(finalPath);
  const url = `/media/uploads/${finalFilename}`;
  registerAsset({
    id: uuidv4(),
    projectId: session.projectId,
    kind: 'video',
    filename: session.filename,
    filePath: finalPath,
    url,
    mimeType: ext === '.mov' ? 'video/quicktime' : ext === '.mkv' ? 'video/x-matroska' : 'video/mp4',
    sizeBytes: stat.size,
  });

  return {
    filePath: finalPath,
    filename: session.filename,
    url,
    sizeBytes: stat.size,
  };
}

export function saveLogoFile(
  projectId: string,
  originalName: string,
  buffer: Buffer
): { filePath: string; filename: string; url: string } {
  const ext = path.extname(originalName).toLowerCase();
  if (!ALLOWED_LOGO_EXTS.has(ext)) {
    throw new Error(`Unsupported logo format "${ext}". Allowed formats: PNG, SVG.`);
  }
  const safeName = sanitizeFilename(originalName);
  const finalName = `${projectId.slice(0, 8)}_${Date.now()}_${safeName}`;
  const filePath = path.join(LOGOS_DIR, finalName);
  fs.writeFileSync(filePath, buffer);

  const url = `/media/logos/${finalName}`;
  registerAsset({
    id: uuidv4(),
    projectId,
    kind: 'logo',
    filename: safeName,
    filePath,
    url,
    mimeType: ext === '.svg' ? 'image/svg+xml' : 'image/png',
    sizeBytes: buffer.length,
  });

  return { filePath, filename: safeName, url };
}

export function saveCanvasBackgroundFile(
  projectId: string,
  originalName: string,
  buffer: Buffer
): { filePath: string; filename: string; url: string } {
  const ext = path.extname(originalName).toLowerCase();
  if (!ALLOWED_BG_EXTS.has(ext)) {
    throw new Error(
      `Unsupported background image format "${ext}". Allowed formats: PNG, JPG, JPEG, WEBP.`
    );
  }
  const safeName = sanitizeFilename(originalName);
  const finalName = `bg_${projectId.slice(0, 8)}_${Date.now()}_${safeName}`;
  const filePath = path.join(BACKGROUNDS_DIR, finalName);
  fs.writeFileSync(filePath, buffer);

  const url = `/media/backgrounds/${finalName}`;
  const mimeType =
    ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  registerAsset({
    id: uuidv4(),
    projectId,
    kind: 'background',
    filename: safeName,
    filePath,
    url,
    mimeType,
    sizeBytes: buffer.length,
  });

  return { filePath, filename: safeName, url };
}

export function saveMusicFile(
  projectId: string,
  originalName: string,
  buffer: Buffer
): { filePath: string; filename: string; url: string } {
  const ext = path.extname(originalName).toLowerCase();
  if (!ALLOWED_AUDIO_EXTS.has(ext)) {
    throw new Error(`Unsupported audio format "${ext}". Allowed: MP3, WAV, AAC, M4A, OGG.`);
  }
  const safeName = sanitizeFilename(originalName);
  const finalName = `music_${projectId.slice(0, 8)}_${Date.now()}_${safeName}`;
  const filePath = path.join(AUDIO_DIR, finalName);
  fs.writeFileSync(filePath, buffer);

  const url = `/media/audio/${finalName}`;
  registerAsset({
    id: uuidv4(),
    projectId,
    kind: 'music',
    filename: safeName,
    filePath,
    url,
    mimeType: 'audio/mpeg',
    sizeBytes: buffer.length,
  });

  return { filePath, filename: safeName, url };
}

export function saveSfxFile(
  projectId: string,
  originalName: string,
  buffer: Buffer
): { filePath: string; filename: string; url: string } {
  const ext = path.extname(originalName).toLowerCase();
  if (!ALLOWED_AUDIO_EXTS.has(ext)) {
    throw new Error(`Unsupported SFX audio format "${ext}". Allowed: MP3, WAV, AAC, M4A, OGG.`);
  }
  const safeName = sanitizeFilename(originalName);
  const finalName = `sfx_${projectId.slice(0, 8)}_${Date.now()}_${safeName}`;
  const filePath = path.join(AUDIO_DIR, finalName);
  fs.writeFileSync(filePath, buffer);

  const url = `/media/audio/${finalName}`;
  registerAsset({
    id: uuidv4(),
    projectId,
    kind: 'sfx',
    filename: safeName,
    filePath,
    url,
    mimeType: ext === '.wav' ? 'audio/wav' : 'audio/mpeg',
    sizeBytes: buffer.length,
  });

  return { filePath, filename: safeName, url };
}

export function saveSegmentationMaskImage(
  projectId: string,
  blurId: string,
  base64Png: string
): { assetId: string; filePath: string; url: string } {
  const clean = base64Png.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(clean, 'base64');
  const assetId = uuidv4();
  const filename = `mask_${projectId.slice(0, 8)}_${blurId.slice(0, 8)}_${Date.now()}.png`;
  const filePath = path.join(MASKS_DIR, filename);
  fs.writeFileSync(filePath, buffer);

  const url = `/media/masks/${filename}`;
  registerAsset({
    id: assetId,
    projectId,
    kind: 'mask',
    filename,
    filePath,
    url,
    mimeType: 'image/png',
    sizeBytes: buffer.length,
  });

  return { assetId, filePath, url };
}

export function saveFontFile(
  originalName: string,
  buffer: Buffer,
  customFamily?: string
): { filePath: string; filename: string; url: string; family: string } {
  const ext = path.extname(originalName).toLowerCase();
  if (!ALLOWED_FONT_EXTS.has(ext)) {
    throw new Error(`Unsupported font format "${ext}". Allowed formats: TTF, OTF, WOFF, WOFF2.`);
  }
  const safeName = sanitizeFilename(originalName);
  const finalName = `${Date.now()}_${safeName}`;
  const filePath = path.join(FONTS_DIR, finalName);
  fs.writeFileSync(filePath, buffer);

  const rawBase = path.basename(safeName, ext).replace(/[_-]+/g, ' ').trim();
  const family = (customFamily || rawBase || 'Custom Font').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'Custom Font';
  const url = `/media/fonts/${finalName}`;
  return { filePath, filename: safeName, url, family };
}

export function saveDirectVideoFile(
  projectId: string,
  originalName: string,
  buffer: Buffer
): { filePath: string; filename: string; url: string; sizeBytes: number } {
  validateVideoUpload(originalName, buffer.length);
  const ext = path.extname(originalName).toLowerCase();
  const safeBase = sanitizeFilename(path.basename(originalName, ext));
  const finalFilename = `${projectId.slice(0, 8)}_${Date.now()}_${safeBase}${ext}`;
  const filePath = path.join(UPLOADS_DIR, finalFilename);
  fs.writeFileSync(filePath, buffer);

  const url = `/media/uploads/${finalFilename}`;
  registerAsset({
    id: uuidv4(),
    projectId,
    kind: 'video',
    filename: sanitizeFilename(originalName),
    filePath,
    url,
    mimeType: ext === '.mov' ? 'video/quicktime' : ext === '.mkv' ? 'video/x-matroska' : 'video/mp4',
    sizeBytes: buffer.length,
  });

  return { filePath, filename: sanitizeFilename(originalName), url, sizeBytes: buffer.length };
}

export function sanitizeFilename(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
}

