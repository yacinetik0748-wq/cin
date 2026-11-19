import JSZip from 'jszip';
import { Project } from '../types/studio';
import { api, LocalAssetManifestItem } from './api';
import { indexedDbStore } from './indexedDbStore';

interface BackupManifestFile {
  format: 'recap-studio-backup-v1';
  exportedAt: string;
  projectId: string;
  projectName: string;
  assets: Array<{
    archivePath: string;
    localUrl: string;
    bucket: string;
    filename: string;
    assetKind: LocalAssetManifestItem['assetKind'];
    mimeType: string;
    sha256: string;
    sizeBytes: number;
  }>;
}

export async function exportProjectBackupZip(
  project: Project,
  onProgress?: (pct: number, label: string) => void
): Promise<{ filename: string; totalBytes: number; assetCount: number }> {
  onProgress?.(5, 'Inspecting project assets...');
  const manifestRes = await api.getProjectAssetManifest(project.id);
  const existingAssets = (manifestRes.assets || []).filter((a) => a.exists && a.sizeBytes > 0);

  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(project, null, 2));

  const backupAssets: BackupManifestFile['assets'] = [];
  for (let i = 0; i < existingAssets.length; i++) {
    const asset = existingAssets[i];
    const pct = Math.round(15 + ((i + 1) / Math.max(1, existingAssets.length)) * 65);
    onProgress?.(pct, `Packaging ${asset.filename}...`);

    let blob: Blob | null = null;
    try {
      const resp = await fetch(asset.localUrl);
      if (resp.ok) {
        blob = await resp.blob();
      }
    } catch {
      const cached = asset.sha256 ? await indexedDbStore.getCachedMedia(asset.sha256) : null;
      if (cached) blob = cached.blob;
    }

    if (blob) {
      const archivePath = `assets/${asset.bucket}/${asset.filename}`;
      zip.file(archivePath, blob);
      backupAssets.push({
        archivePath,
        localUrl: asset.localUrl,
        bucket: asset.bucket,
        filename: asset.filename,
        assetKind: asset.assetKind,
        mimeType: asset.mimeType,
        sha256: asset.sha256,
        sizeBytes: blob.size,
      });
    }
  }

  const backupManifest: BackupManifestFile = {
    format: 'recap-studio-backup-v1',
    exportedAt: new Date().toISOString(),
    projectId: project.id,
    projectName: project.name,
    assets: backupAssets,
  };
  zip.file('manifest.json', JSON.stringify(backupManifest, null, 2));

  onProgress?.(90, 'Finalizing portable backup archive...');
  const outBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  const safeName = (project.name || 'project')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 48);
  const downloadName = `${safeName}.recapbackup.zip`;

  const url = URL.createObjectURL(outBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = downloadName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);

  onProgress?.(100, 'Backup archive downloaded');
  return {
    filename: downloadName,
    totalBytes: outBlob.size,
    assetCount: backupAssets.length,
  };
}

export async function importProjectBackupZip(
  file: File,
  onProgress?: (pct: number, label: string) => void
): Promise<Project> {
  onProgress?.(10, 'Reading backup archive...');
  const zip = await JSZip.loadAsync(file);
  const projectEntry = zip.file('project.json');
  if (!projectEntry) {
    throw new Error('Invalid backup archive: missing project.json');
  }

  const rawProject = JSON.parse(await projectEntry.async('text')) as Project;
  if (!rawProject || !rawProject.id) {
    throw new Error('Invalid project.json inside backup archive.');
  }

  const manifestEntry = zip.file('manifest.json');
  const manifest = manifestEntry
    ? (JSON.parse(await manifestEntry.async('text')) as BackupManifestFile)
    : null;

  const assetsToHydrate = manifest?.assets || [];
  for (let i = 0; i < assetsToHydrate.length; i++) {
    const item = assetsToHydrate[i];
    const zipAsset = zip.file(item.archivePath);
    if (!zipAsset) continue;
    const pct = Math.round(25 + ((i + 1) / Math.max(1, assetsToHydrate.length)) * 60);
    onProgress?.(pct, `Restoring ${item.filename}...`);
    const blob = await zipAsset.async('blob');
    await api.hydrateAssetFromBlob(rawProject.id, {
      blob,
      bucket: item.bucket,
      filename: item.filename,
      assetKind: item.assetKind,
      mimeType: item.mimeType,
      targetLocalUrl: item.localUrl,
    });
    if (item.sha256) {
      await indexedDbStore.putCachedMedia({
        sha256: item.sha256,
        filename: item.filename,
        mimeType: item.mimeType,
        sizeBytes: blob.size,
        blob,
        cachedAt: new Date().toISOString(),
      });
    }
  }

  onProgress?.(92, 'Saving restored project...');
  const restoredProject: Project = {
    ...rawProject,
    cloudSync: {
      ...(rawProject.cloudSync || { syncStatus: 'local-only' }),
      syncStatus: 'pending-sync',
    },
  };
  const { project: saved } = await api.upsertProjectFromCloud(restoredProject);
  await indexedDbStore.saveProjectSnapshot(saved);
  onProgress?.(100, 'Backup restored');
  return saved;
}
