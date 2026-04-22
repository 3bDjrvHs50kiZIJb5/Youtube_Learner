import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

// 使用系统 ffmpeg（用户机器必须安装 ffmpeg，或把 ffmpeg 静态包放到 resources 下）
// 这里优先读环境变量 FFMPEG_PATH，然后回退到系统 PATH
function getFfmpegPath(): string {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

function getFfprobePath(): string {
  return process.env.FFPROBE_PATH || 'ffprobe';
}

/** 用 ffprobe 读取视频时长(秒) */
export function getDuration(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ff = spawn(getFfprobePath(), [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ]);
    let out = '';
    ff.stdout.on('data', (c) => (out += c.toString()));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe 退出码 ${code}`));
      const d = parseFloat(out.trim());
      if (isNaN(d)) return reject(new Error('无法解析视频时长'));
      resolve(d);
    });
  });
}

export interface ExtractAudioOptions {
  videoPath: string;
  /** 输出音频路径，默认跟视频同目录同名 .wav */
  outputPath?: string;
  /** 采样率，千问 ASR 推荐 16000 */
  sampleRate?: number;
  /** 单声道 */
  mono?: boolean;
  onProgress?: (percent: number) => void;
}

/** 从视频中抽取音频，转成 16kHz 单声道 WAV（千问 Paraformer 友好） */
export function extractAudio(opts: ExtractAudioOptions): Promise<string> {
  const { videoPath, sampleRate = 16000, mono = true, onProgress } = opts;
  if (!fs.existsSync(videoPath)) {
    throw new Error(`视频不存在: ${videoPath}`);
  }
  const outputPath =
    opts.outputPath || path.join(path.dirname(videoPath), `${path.parse(videoPath).name}.wav`);

  const args = [
    '-y',
    '-i', videoPath,
    '-vn',
    '-ar', String(sampleRate),
    '-ac', mono ? '1' : '2',
    '-f', 'wav',
    outputPath,
  ];

  return new Promise((resolve, reject) => {
    const ff = spawn(getFfmpegPath(), args);
    let duration = 0;

    ff.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      const durMatch = text.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
      if (durMatch) {
        duration = +durMatch[1] * 3600 + +durMatch[2] * 60 + +durMatch[3];
      }
      const timeMatch = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (timeMatch && duration > 0 && onProgress) {
        const cur = +timeMatch[1] * 3600 + +timeMatch[2] * 60 + +timeMatch[3];
        onProgress(Math.min(100, Math.round((cur / duration) * 100)));
      }
    });

    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code === 0) resolve(outputPath);
      else reject(new Error(`ffmpeg 退出码 ${code}`));
    });
  });
}

export interface AudioSegment {
  /** 分段文件绝对路径 */
  path: string;
  /** 该段在原视频中的起始时间(ms) */
  offsetMs: number;
  /** 段时长(ms) */
  durationMs: number;
}

export interface SilenceInterval {
  /** 静音开始(秒) */
  startSec: number;
  /** 静音结束(秒) */
  endSec: number;
}

export interface DetectSilenceOptions {
  /** 噪声阈值(dB),低于此值视为静音,默认 -30 */
  noiseDb?: number;
  /** 最短静音时长(秒),默认 0.4 */
  minSilenceSec?: number;
  /** 检测进度(0~100),占整个切分流程的前 20% */
  onProgress?: (percent: number) => void;
}

/**
 * 用 ffmpeg 的 silencedetect 过滤器扫描音视频,得到所有静音区间。
 * 静音区间大多出现在句子之间,用它做切点比硬切时间更自然。
 */
export function detectSilence(
  inputPath: string,
  opts: DetectSilenceOptions = {}
): Promise<SilenceInterval[]> {
  const noiseDb = opts.noiseDb ?? -30;
  const minSilenceSec = opts.minSilenceSec ?? 0.4;
  if (!fs.existsSync(inputPath)) throw new Error(`文件不存在: ${inputPath}`);

  return new Promise((resolve, reject) => {
    const args = [
      '-nostdin',
      '-i', inputPath,
      '-vn',
      '-af', `silencedetect=noise=${noiseDb}dB:d=${minSilenceSec}`,
      '-f', 'null',
      '-',
    ];
    const ff = spawn(getFfmpegPath(), args);
    let log = '';
    let duration = 0;

    ff.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      log += text;
      const durMatch = text.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
      if (durMatch) {
        duration = +durMatch[1] * 3600 + +durMatch[2] * 60 + +durMatch[3];
      }
      const timeMatch = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (timeMatch && duration > 0 && opts.onProgress) {
        const cur = +timeMatch[1] * 3600 + +timeMatch[2] * 60 + +timeMatch[3];
        opts.onProgress(Math.min(100, Math.round((cur / duration) * 100)));
      }
    });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`silencedetect 退出码 ${code}`));
      const starts: number[] = [];
      const ends: number[] = [];
      const startRe = /silence_start:\s*([\d.]+)/g;
      const endRe = /silence_end:\s*([\d.]+)/g;
      let m: RegExpExecArray | null;
      while ((m = startRe.exec(log))) starts.push(+m[1]);
      while ((m = endRe.exec(log))) ends.push(+m[1]);
      const intervals: SilenceInterval[] = [];
      const n = Math.min(starts.length, ends.length);
      for (let i = 0; i < n; i++) {
        intervals.push({ startSec: starts[i], endSec: ends[i] });
      }
      resolve(intervals);
    });
  });
}

export interface SplitAudioOptions {
  videoPath: string;
  /** 每段的目标时长(秒),默认 120s = 2 分钟 */
  segmentSec?: number;
  /**
   * 允许切点偏离目标的最大秒数,默认 min(60, max(24, segmentSec * 0.2))。
   * 越大越能避开语句,但段长会更不均匀。
   */
  toleranceSec?: number;
  /** silencedetect 噪声阈值(dB),默认 -30 */
  silenceNoiseDb?: number;
  /** silencedetect 最短静音时长(秒),默认 0.4 */
  minSilenceSec?: number;
  sampleRate?: number;
  mono?: boolean;
  onProgress?: (percent: number) => void;
}

/**
 * 根据静音区间与目标段长计算切点。
 * 从 0 出发每次推进 segmentSec,在 [target-tol, target+tol] 窗口里找静音中点最接近 target 的。
 * 找不到就在 target 硬切,保证段不会无限长。
 */
interface PickCutResult {
  cuts: number[];
  matchedCuts: number;
  hardCuts: number;
}

function pickCutPoints(
  silences: SilenceInterval[],
  duration: number,
  segmentSec: number,
  toleranceSec: number
): PickCutResult {
  const cuts: number[] = [];
  let matchedCuts = 0;
  let hardCuts = 0;
  // 至少保留一段尾巴,避免切出过短的段
  const minSegmentSec = Math.max(5, segmentSec * 0.3);
  let lastCut = 0;
  let target = segmentSec;

  while (target < duration - minSegmentSec) {
    const lo = target - toleranceSec;
    const hi = target + toleranceSec;
    let best: { point: number; distance: number } | null = null;
    for (const s of silences) {
      // 静音中点作为候选切点,听感上最自然
      const mid = (s.startSec + s.endSec) / 2;
      if (mid < lo || mid > hi) continue;
      if (mid <= lastCut + minSegmentSec) continue;
      const d = Math.abs(mid - target);
      if (!best || d < best.distance) best = { point: mid, distance: d };
    }
    const cut = best ? best.point : target;
    if (best) matchedCuts++;
    else hardCuts++;
    cuts.push(cut);
    lastCut = cut;
    target = cut + segmentSec;
  }

  return { cuts, matchedCuts, hardCuts };
}

/**
 * 把视频的音频切成多段 WAV。
 * 先 silencedetect 扫出所有静音区间,再在目标切点附近挑最接近的静音做切点,
 * 避免把一句话切成两半,对 ASR 边界更友好。
 */
export async function splitAudioSegments(opts: SplitAudioOptions): Promise<AudioSegment[]> {
  const {
    videoPath,
    segmentSec = 120,
    sampleRate = 16000,
    mono = true,
    silenceNoiseDb = -30,
    minSilenceSec = 0.4,
    onProgress,
  } = opts;
  const toleranceSec = opts.toleranceSec ?? Math.min(60, Math.max(24, segmentSec * 0.2));
  if (!fs.existsSync(videoPath)) throw new Error(`视频不存在: ${videoPath}`);

  const duration = await getDuration(videoPath);
  const dir = path.dirname(videoPath);
  const name = path.parse(videoPath).name;
  const segDir = path.join(dir, `.${name}.segments`);
  if (fs.existsSync(segDir)) {
    for (const f of fs.readdirSync(segDir)) fs.unlinkSync(path.join(segDir, f));
  } else {
    fs.mkdirSync(segDir, { recursive: true });
  }

  // 视频短于一段目标长度,直接抽一段,跳过静音检测
  if (duration <= segmentSec) {
    const segPath = path.join(segDir, 'seg_0000.wav');
    await extractRange(videoPath, segPath, 0, duration, sampleRate, mono, (p) => {
      onProgress?.(Math.round(p * 100));
    });
    return [{ path: segPath, offsetMs: 0, durationMs: Math.round(duration * 1000) }];
  }

  // 第 1 阶段:扫静音(占 0~25%)
  const silences = await detectSilence(videoPath, {
    noiseDb: silenceNoiseDb,
    minSilenceSec,
    onProgress: (p) => onProgress?.(Math.round(p * 0.25)),
  });
  onProgress?.(25);

  // 第 2 阶段:挑切点
  let cutPlan = pickCutPoints(silences, duration, segmentSec, toleranceSec);

  // 如果当前参数几乎都退化成“按目标时间硬切”，自动放宽一次静音检测再试。
  // 这类视频常见于带底噪/底乐的解说内容，默认 -30dB / 0.4s 会过严。
  if (cutPlan.hardCuts > 0) {
    const relaxedNoiseDb = Math.min(-15, silenceNoiseDb + 5);
    const relaxedMinSilenceSec = Math.max(0.2, Math.min(minSilenceSec, 0.25));
    const relaxedToleranceSec = Math.max(
      toleranceSec,
      Math.min(60, Math.max(36, segmentSec * 0.4))
    );

    const relaxedSilences = await detectSilence(videoPath, {
      noiseDb: relaxedNoiseDb,
      minSilenceSec: relaxedMinSilenceSec,
    });
    const relaxedPlan = pickCutPoints(
      relaxedSilences,
      duration,
      segmentSec,
      relaxedToleranceSec
    );

    if (
      relaxedPlan.hardCuts < cutPlan.hardCuts ||
      (relaxedPlan.hardCuts === cutPlan.hardCuts &&
        relaxedPlan.matchedCuts > cutPlan.matchedCuts)
    ) {
      cutPlan = relaxedPlan;
      console.log(
        `[split-audio] 使用放宽静音参数: noise=${relaxedNoiseDb}dB d=${relaxedMinSilenceSec}s tol=${relaxedToleranceSec}s, matched=${relaxedPlan.matchedCuts}, hard=${relaxedPlan.hardCuts}`
      );
    } else {
      console.log(
        `[split-audio] 保持默认静音参数: noise=${silenceNoiseDb}dB d=${minSilenceSec}s tol=${toleranceSec}s, matched=${cutPlan.matchedCuts}, hard=${cutPlan.hardCuts}`
      );
    }
  } else {
    console.log(
      `[split-audio] 默认静音参数已命中切点: noise=${silenceNoiseDb}dB d=${minSilenceSec}s tol=${toleranceSec}s, matched=${cutPlan.matchedCuts}, hard=${cutPlan.hardCuts}`
    );
  }

  const boundaries = [0, ...cutPlan.cuts, duration];

  // 第 3 阶段:逐段抽出音频(占 25~100%)
  const segments: AudioSegment[] = [];
  const totalSegs = boundaries.length - 1;
  for (let i = 0; i < totalSegs; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    const segPath = path.join(segDir, `seg_${String(i).padStart(4, '0')}.wav`);
    await extractRange(videoPath, segPath, start, end, sampleRate, mono, (p) => {
      const segProgress = (i + p) / totalSegs;
      onProgress?.(25 + Math.round(segProgress * 75));
    });
    segments.push({
      path: segPath,
      offsetMs: Math.round(start * 1000),
      durationMs: Math.round((end - start) * 1000),
    });
  }
  onProgress?.(100);
  return segments;
}

export interface VideoSplitOptions {
  videoPath: string;
  /** 每段时长(分钟),默认 10 */
  segmentMinutes?: number;
  /** 输出目录,默认 视频同目录/`<name>.parts/` */
  outputDir?: string;
  onProgress?: (percent: number) => void;
}

export interface VideoSplitResult {
  /** 输出目录 */
  outputDir: string;
  /** 生成的分片文件绝对路径 */
  files: string[];
}

/**
 * 按固定时长把视频切成多段。用 ffmpeg 的 segment muxer + `-c copy`,
 * 不重新编码,速度快;实际切点会落在最近的关键帧上,所以段长是近似 10 分钟。
 */
export async function splitVideoByDuration(opts: VideoSplitOptions): Promise<VideoSplitResult> {
  const { videoPath, segmentMinutes = 10, onProgress } = opts;
  if (!fs.existsSync(videoPath)) throw new Error(`视频不存在: ${videoPath}`);
  if (segmentMinutes <= 0) throw new Error('分段时长必须大于 0 分钟');

  const dir = path.dirname(videoPath);
  const name = path.parse(videoPath).name;
  const ext = path.extname(videoPath) || '.mp4';
  const outputDir = opts.outputDir || path.join(dir, `${name}.parts`);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  } else {
    // 清理同名旧分片
    for (const f of fs.readdirSync(outputDir)) {
      if (f.startsWith(`${name}_part`) && f.endsWith(ext)) {
        fs.unlinkSync(path.join(outputDir, f));
      }
    }
  }

  const duration = await getDuration(videoPath);
  const segmentSec = Math.round(segmentMinutes * 60);
  const pattern = path.join(outputDir, `${name}_part%03d${ext}`);

  // -c copy 不重编码; reset_timestamps 让每段从 0 开始,避免播放器时间轴错乱
  const args = [
    '-y',
    '-nostdin',
    '-i', videoPath,
    '-c', 'copy',
    '-map', '0',
    '-f', 'segment',
    '-segment_time', String(segmentSec),
    '-reset_timestamps', '1',
    pattern,
  ];

  await new Promise<void>((resolve, reject) => {
    const ff = spawn(getFfmpegPath(), args);
    ff.stderr.on('data', (chunk: Buffer) => {
      if (!onProgress || duration <= 0) return;
      const text = chunk.toString();
      const timeMatch = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (timeMatch) {
        const cur = +timeMatch[1] * 3600 + +timeMatch[2] * 60 + +timeMatch[3];
        onProgress(Math.min(100, Math.round((cur / duration) * 100)));
      }
    });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 分割退出码 ${code}`));
    });
  });

  const files = fs
    .readdirSync(outputDir)
    .filter((f) => f.startsWith(`${name}_part`) && f.endsWith(ext))
    .sort()
    .map((f) => path.join(outputDir, f));

  onProgress?.(100);
  return { outputDir, files };
}

/** 从视频里抽一段 [startSec, endSec) 的音频到 WAV */
function extractRange(
  videoPath: string,
  outputPath: string,
  startSec: number,
  endSec: number,
  sampleRate: number,
  mono: boolean,
  onProgress?: (ratio: number) => void
): Promise<void> {
  const segDuration = Math.max(0, endSec - startSec);
  // -ss 放在 -i 之前是快速输入 seek,配合音频重编码对 WAV 来说精度足够
  const args = [
    '-y',
    '-nostdin',
    '-ss', String(startSec),
    '-to', String(endSec),
    '-i', videoPath,
    '-vn',
    '-ar', String(sampleRate),
    '-ac', mono ? '1' : '2',
    '-f', 'wav',
    outputPath,
  ];
  return new Promise<void>((resolve, reject) => {
    const ff = spawn(getFfmpegPath(), args);
    ff.stderr.on('data', (chunk: Buffer) => {
      if (!onProgress || segDuration <= 0) return;
      const text = chunk.toString();
      const timeMatch = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (timeMatch) {
        const cur = +timeMatch[1] * 3600 + +timeMatch[2] * 60 + +timeMatch[3];
        onProgress(Math.min(1, cur / segDuration));
      }
    });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 退出码 ${code}`));
    });
  });
}
