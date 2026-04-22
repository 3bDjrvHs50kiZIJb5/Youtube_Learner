import fs from 'node:fs';
import path from 'node:path';
import type { AudioSegment } from './ffmpeg';
import type { SubtitleCue } from './subtitle';

export type StepStatus = 'idle' | 'running' | 'done' | 'error';

export interface UploadedRef {
  path: string;
  offsetMs: number;
  durationMs: number;
  objectKey: string;
}

export interface PipelineState {
  version: 1;
  videoPath: string;
  videoSize: number;
  videoMtimeMs: number;
  segmentSec: number;
  segments: AudioSegment[];
  uploaded: UploadedRef[];
  steps: { split: StepStatus; upload: StepStatus; asr: StepStatus; translate: StepStatus };
  srtPath?: string;
  /** 字幕条数(用于 UI 展示,避免恢复时必须读 SRT) */
  cueCount?: number;
  /** 上次播放到的位置(毫秒),下次打开同一视频时可以续播 */
  lastPositionMs?: number;
  updatedAt: number;
}

function stateFilePath(videoPath: string): string {
  const dir = path.dirname(videoPath);
  const name = path.parse(videoPath).name;
  return path.join(dir, `.${name}.state.json`);
}

function videoFingerprint(videoPath: string): { size: number; mtimeMs: number } | null {
  try {
    const s = fs.statSync(videoPath);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

function emptyState(videoPath: string): PipelineState {
  const fp = videoFingerprint(videoPath);
  return {
    version: 1,
    videoPath,
    videoSize: fp?.size ?? 0,
    videoMtimeMs: fp?.mtimeMs ?? 0,
    segmentSec: 120,
    segments: [],
    uploaded: [],
    steps: { split: 'idle', upload: 'idle', asr: 'idle', translate: 'idle' },
    updatedAt: Date.now(),
  };
}

/**
 * 读取状态文件。如果文件不存在、格式错误,或视频指纹不匹配(视频被替换了),返回 null。
 * 恢复时还会校验切段文件是否还在磁盘,不在就把 split 状态降级为 idle。
 */
export function loadState(videoPath: string): PipelineState | null {
  const file = stateFilePath(videoPath);
  if (!fs.existsSync(file)) return null;
  let state: PipelineState;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf-8')) as PipelineState;
  } catch {
    return null;
  }
  if (state.version !== 1) return null;

  const fp = videoFingerprint(videoPath);
  if (!fp) return null;
  if (state.videoSize !== fp.size || Math.abs(state.videoMtimeMs - fp.mtimeMs) > 1) {
    return null;
  }

  // 校验切段文件是否还存在
  const allSegsExist =
    state.segments.length > 0 && state.segments.every((s) => fs.existsSync(s.path));
  if (!allSegsExist) {
    state.segments = [];
    state.uploaded = [];
    state.steps = {
      split: 'idle',
      upload: 'idle',
      asr: state.steps.asr,
      translate: state.steps.translate,
    };
  }

  return state;
}

export type StatePatch = Partial<
  Omit<PipelineState, 'videoPath' | 'videoSize' | 'videoMtimeMs' | 'version' | 'updatedAt' | 'steps'>
> & { steps?: Partial<PipelineState['steps']> };

export function saveState(videoPath: string, partial: StatePatch): PipelineState {
  const file = stateFilePath(videoPath);
  const current = loadState(videoPath) || emptyState(videoPath);
  const next: PipelineState = {
    ...current,
    ...partial,
    steps: { ...current.steps, ...(partial.steps || {}) },
    videoPath,
    updatedAt: Date.now(),
  };
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

export function clearState(videoPath: string): void {
  const file = stateFilePath(videoPath);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

/** 导出给其他模块引用的 cue 类型占位(防止循环引用) */
export type { SubtitleCue };
