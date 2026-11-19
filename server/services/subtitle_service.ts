import fs from 'fs';
import path from 'path';
import {
  buildAssContent,
  generateSrtContent,
  generateVttContent,
  parseSrtOrVtt,
  resolveSegmentWordsForAss,
} from '../../src/lib/subtitleAss.ts';
import { CaptionSegment, SubtitleStyle } from '../../src/types/studio.ts';
import { TEMP_DIR } from '../db.ts';

export {
  buildAssContent,
  generateSrtContent,
  generateVttContent,
  parseSrtOrVtt,
  resolveSegmentWordsForAss,
};

export function generateAssFile(params: {
  projectId: string;
  captions: CaptionSegment[];
  style: SubtitleStyle;
  videoWidth: number;
  videoHeight: number;
  totalDuration?: number;
  includeMainCaptions?: boolean;
  includeExtraElements?: boolean;
  onlyExtraElementIds?: string[];
}): string {
  const assText = buildAssContent(params);
  const assPath = path.join(TEMP_DIR, `subs_${params.projectId.slice(0, 8)}_${Date.now()}.ass`);
  fs.writeFileSync(assPath, assText, 'utf-8');
  return assPath;
}
