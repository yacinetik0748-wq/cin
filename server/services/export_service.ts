import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { RenderJob } from '../../src/types/studio.ts';
import {
  CHUNKS_DIR,
  TEMP_DIR,
  createJob,
  getJob,
  getProject,
  updateJob,
  updateProject,
} from '../db.ts';
import { renderProjectVideo } from './video_render_service.ts';

const activeQueue: string[] = [];
let workerRunning = false;

export function enqueueRenderJob(projectId: string): RenderJob {
  const project = getProject(projectId);
  if (!project) {
    throw new Error('Project not found.');
  }
  if (!project.sourceVideoUrl) {
    throw new Error('Upload a source video before starting export.');
  }

  const job = createJob({
    id: uuidv4(),
    projectId,
    type: 'render',
    status: 'queued',
    progress: 0,
    stage: 'Queued for background render',
    etaSeconds: null,
    outputUrl: null,
    outputSize: null,
    error: null,
  });

  activeQueue.push(job.id);
  void processQueue();
  return job;
}

async function processQueue() {
  if (workerRunning) return;
  workerRunning = true;

  try {
    while (activeQueue.length > 0) {
      const jobId = activeQueue.shift()!;
      const job = getJob(jobId);
      if (!job) continue;

      const project = getProject(job.projectId);
      if (!project) {
        updateJob(jobId, { status: 'failed', error: 'Project was deleted.' });
        continue;
      }

      updateJob(jobId, {
        status: 'processing',
        progress: 2,
        stage: 'Initializing render pipeline',
      });

      try {
        const result = await renderProjectVideo({
          project,
          onProgress: (progress, stage, etaSeconds) => {
            updateJob(jobId, { progress, stage, etaSeconds });
          },
        });

        updateProject(project.id, {
          lastExportUrl: result.outputUrl,
          lastExportSize: result.outputSize,
          lastExportedAt: new Date().toISOString(),
        });

        updateJob(jobId, {
          status: 'completed',
          progress: 100,
          stage: 'Export ready for download',
          etaSeconds: 0,
          outputUrl: result.outputUrl,
          outputSize: result.outputSize,
        });
      } catch (err) {
        updateJob(jobId, {
          status: 'failed',
          stage: 'Render failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    workerRunning = false;
  }
}

export function cleanupTempStorage(maxAgeHours = 24): { removedFiles: number } {
  const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
  let removed = 0;

  for (const dir of [TEMP_DIR, CHUNKS_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        // ignore race
      }
    }
  }
  return { removedFiles: removed };
}
