import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { SubtitleCue } from './subtitle';
import { synthesizeSpeech } from './tts';

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

export interface ExportedVideoSet {
  outputDir: string;
  plainVideoPath: string;
  englishSubtitleVideoPath: string;
  bilingualSubtitleVideoPath: string;
}

export interface DubbedVideoResult {
  outputDir: string;
  dubbedVideoPath: string;
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

export interface ExportStudyVideosOptions {
  videoPath: string;
  cues: SubtitleCue[];
  outputDir?: string;
  onProgress?: (percent: number, message: string) => void;
}

export async function exportStudyVideos(opts: ExportStudyVideosOptions): Promise<ExportedVideoSet> {
  const { videoPath, cues, onProgress } = opts;
  if (!fs.existsSync(videoPath)) throw new Error(`视频不存在: ${videoPath}`);
  if (!cues.length) throw new Error('没有可导出的字幕');
  if (!cues.some((c) => c.translation?.trim())) {
    throw new Error('请先完成翻译输出，再导出双语字幕视频');
  }

  const dir = path.dirname(videoPath);
  const name = path.parse(videoPath).name;
  const outputDir = opts.outputDir || path.join(dir, `${name}.exports`);
  fs.mkdirSync(outputDir, { recursive: true });

  const plainVideoPath = path.join(outputDir, `${name}.plain.mp4`);
  const englishSubtitleVideoPath = path.join(outputDir, `${name}.english-subtitles.mp4`);
  const bilingualSubtitleVideoPath = path.join(outputDir, `${name}.bilingual-subtitles.mp4`);
  const englishAssPath = path.join(outputDir, `.${name}.english.export.ass`);
  const bilingualAssPath = path.join(outputDir, `.${name}.bilingual.export.ass`);

  fs.writeFileSync(englishAssPath, cuesToStyledAss(cues, 'english'), 'utf-8');
  fs.writeFileSync(bilingualAssPath, cuesToStyledAss(cues, 'bilingual'), 'utf-8');

  try {
    onProgress?.(0, '导出 1/3：生成无字幕视频');
    await transcodeVideo(videoPath, plainVideoPath);
    onProgress?.(34, '导出 2/3：烧录英文字幕');
    await transcodeVideo(videoPath, englishSubtitleVideoPath, englishAssPath);
    onProgress?.(67, '导出 3/3：烧录中英文字幕');
    await transcodeVideo(videoPath, bilingualSubtitleVideoPath, bilingualAssPath);
    onProgress?.(100, '三种视频导出完成');

    return {
      outputDir,
      plainVideoPath,
      englishSubtitleVideoPath,
      bilingualSubtitleVideoPath,
    };
  } finally {
    safeUnlink(englishAssPath);
    safeUnlink(bilingualAssPath);
  }
}

export interface ExportDubbedVideoOptions {
  videoPath: string;
  cues: SubtitleCue[];
  outputDir?: string;
  onProgress?: (percent: number, message: string) => void;
}

export async function exportChineseDubbedVideo(
  opts: ExportDubbedVideoOptions
): Promise<DubbedVideoResult> {
  const { videoPath, cues, onProgress } = opts;
  if (!fs.existsSync(videoPath)) throw new Error(`视频不存在: ${videoPath}`);
  if (!cues.length) throw new Error('没有可导出的字幕');

  const translatedCues = cues.filter((cue) => cue.translation?.trim());
  if (!translatedCues.length) {
    throw new Error('请先完成翻译输出，再导出中文配音视频');
  }

  const dir = path.dirname(videoPath);
  const name = path.parse(videoPath).name;
  const outputDir = opts.outputDir || path.join(dir, `${name}.exports`);
  const tempDir = path.join(outputDir, `.${name}.dub-tmp`);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });

  const dubbedAudioPath = path.join(tempDir, `${name}.dubbed-track.m4a`);
  const concatListPath = path.join(tempDir, 'concat.txt');
  const bilingualAssPath = path.join(tempDir, `.${name}.dubbed.bilingual.export.ass`);
  const dubbedVideoPath = path.join(outputDir, `${name}.chinese-dubbed.mp4`);
  const totalDurationSec = await getDuration(videoPath);

  try {
    fs.writeFileSync(bilingualAssPath, cuesToStyledAss(cues, 'bilingual'), 'utf-8');

    const concatParts: string[] = [];
    let cursorMs = 0;
    let partIndex = 0;

    for (let i = 0; i < translatedCues.length; i++) {
      const cue = translatedCues[i];
      const targetText = cue.translation!.trim();
      const cueStartMs = Math.max(cursorMs, Math.max(0, Math.round(cue.startMs)));
      const cueEndMs = Math.max(cueStartMs + 1, Math.round(cue.endMs));
      const gapMs = cueStartMs - cursorMs;

      if (gapMs > 0) {
        const gapPath = path.join(tempDir, `part_${String(partIndex).padStart(4, '0')}_gap.wav`);
        await createSilenceAudio(gapPath, gapMs / 1000);
        concatParts.push(gapPath);
        partIndex++;
      }

      onProgress?.(
        Math.round((i / Math.max(1, translatedCues.length)) * 80),
        `生成中文配音 ${i + 1}/${translatedCues.length}`
      );

      const tts = await synthesizeSpeech({
        text: targetText,
        language: 'zh',
      });
      const rawClipPath = path.join(tempDir, `tts_${String(i).padStart(4, '0')}${extFromMime(tts.mime)}`);
      fs.writeFileSync(rawClipPath, Buffer.from(tts.dataBase64, 'base64'));

      const fittedPath = path.join(tempDir, `part_${String(partIndex).padStart(4, '0')}_voice.wav`);
      const slotDurationSec = Math.max(0.1, (cueEndMs - cueStartMs) / 1000);
      await fitAudioToDuration(rawClipPath, fittedPath, slotDurationSec);
      concatParts.push(fittedPath);
      partIndex++;
      cursorMs = cueEndMs;
    }

    const remainingMs = Math.max(0, Math.round(totalDurationSec * 1000) - cursorMs);
    if (remainingMs > 0) {
      const tailPath = path.join(tempDir, `part_${String(partIndex).padStart(4, '0')}_tail.wav`);
      await createSilenceAudio(tailPath, remainingMs / 1000);
      concatParts.push(tailPath);
    }

    fs.writeFileSync(
      concatListPath,
      concatParts.map((filePath) => `file '${escapeConcatPath(filePath)}'`).join('\n'),
      'utf-8'
    );

    onProgress?.(85, '拼接中文配音音轨');
    await concatAudioFiles(concatListPath, dubbedAudioPath);
    onProgress?.(95, '合成中文配音视频并烧录中英文字幕');
    await muxVideoWithAudio(videoPath, dubbedAudioPath, dubbedVideoPath, bilingualAssPath);
    onProgress?.(100, '中文配音视频导出完成（含中英文字幕）');

    return { outputDir, dubbedVideoPath };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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

function transcodeVideo(
  inputPath: string,
  outputPath: string,
  subtitlePath?: string
): Promise<void> {
  const args = [
    '-y',
    '-nostdin',
    '-i', inputPath,
  ];

  if (subtitlePath) {
    args.push('-vf', buildSubtitleFilter(subtitlePath));
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    outputPath
  );

  return new Promise<void>((resolve, reject) => {
    const ff = spawn(getFfmpegPath(), args);
    let stderr = '';
    ff.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 导出失败(退出码 ${code}): ${lastLogLine(stderr)}`));
    });
  });
}

function fitAudioToDuration(
  inputPath: string,
  outputPath: string,
  targetDurationSec: number
): Promise<void> {
  return (async () => {
    const clipDurationSec = await getDuration(inputPath);
    const filters: string[] = [];

    if (clipDurationSec > 0 && clipDurationSec > targetDurationSec * 1.02) {
      const speed = clipDurationSec / targetDurationSec;
      filters.push(...buildAtempoFilters(speed));
    }

    filters.push('apad', `atrim=0:${targetDurationSec.toFixed(3)}`);

    const args = [
      '-y',
      '-nostdin',
      '-i', inputPath,
      '-vn',
      '-ac', '1',
      '-ar', '24000',
      '-c:a', 'pcm_s16le',
      '-af', filters.join(','),
      outputPath,
    ];

    await runFfmpeg(args, '音频时长适配失败');
  })();
}

function createSilenceAudio(outputPath: string, durationSec: number): Promise<void> {
  const safeDuration = Math.max(0.01, durationSec);
  return runFfmpeg(
    [
      '-y',
      '-nostdin',
      '-f', 'lavfi',
      '-i', `anullsrc=channel_layout=mono:sample_rate=24000`,
      '-t', safeDuration.toFixed(3),
      '-c:a', 'pcm_s16le',
      outputPath,
    ],
    '生成静音音频失败'
  );
}

function concatAudioFiles(concatListPath: string, outputPath: string): Promise<void> {
  return runFfmpeg(
    [
      '-y',
      '-nostdin',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c:a', 'aac',
      '-b:a', '192k',
      outputPath,
    ],
    '拼接配音音轨失败'
  );
}

function muxVideoWithAudio(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  subtitlePath?: string
): Promise<void> {
  const args = [
    '-y',
    '-nostdin',
    '-i', videoPath,
    '-i', audioPath,
  ];

  if (subtitlePath) {
    args.push('-vf', buildSubtitleFilter(subtitlePath));
  }

  args.push(
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-shortest',
    outputPath
  );

  return runFfmpeg(args, '合成配音视频失败');
}

function buildSubtitleFilter(subtitlePath: string): string {
  const normalized = subtitlePath
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\\\'");
  if (subtitlePath.toLowerCase().endsWith('.ass')) {
    return `ass='${normalized}'`;
  }
  return `subtitles='${normalized}':force_style='FontName=Arial,FontSize=18,Outline=2,Shadow=0,MarginV=28'`;
}

type ExportSubtitleMode = 'english' | 'bilingual';

function cuesToStyledAss(cues: SubtitleCue[], mode: ExportSubtitleMode): string {
  // 播放器字幕容器:
  // width: 100%; max-width: 1200px; padding: 0 40px;
  // 在 1920 基准宽度下,实际可用字幕宽度约 1120px,左右边距约 400px。
  // 这里同步到导出字幕,并开启 ASS 自动换行,避免长句被硬塞成一整行。
  const exportSubtitleMarginX = 400;
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'PlayResX: 1920',
    'PlayResY: 1080',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // 参考当前播放器: 底部居中、黑色半透明底、英文偏绿色、中文偏金黄。
    `Style: ExportEN,Arial,28,&H00A8FFB8,&H00A8FFB8,&H00000000,&H7A000000,1,0,0,0,100,100,0,0,4,0,0,2,${exportSubtitleMarginX},${exportSubtitleMarginX},134,1`,
    `Style: ExportZH,Arial,24,&H007AD2FF,&H007AD2FF,&H00000000,&H7A000000,1,0,0,0,100,100,0,0,4,0,0,2,${exportSubtitleMarginX},${exportSubtitleMarginX},78,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  for (const cue of cues) {
    const start = msToAssTime(cue.startMs);
    const end = msToAssTime(cue.endMs);
    const enText = escapeAssText(cue.text);
    const zhText = escapeAssText(cue.translation || '');

    if (enText) {
      lines.push(`Dialogue: 0,${start},${end},ExportEN,,0,0,0,,${enText}`);
    }
    if (mode === 'bilingual' && zhText) {
      lines.push(`Dialogue: 0,${start},${end},ExportZH,,0,0,0,,${zhText}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function msToAssTime(ms: number): string {
  const safeMs = Math.max(0, Math.round(ms));
  const h = Math.floor(safeMs / 3600000);
  const m = Math.floor((safeMs % 3600000) / 60000);
  const s = Math.floor((safeMs % 60000) / 1000);
  const cs = Math.floor((safeMs % 1000) / 10);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r\n|\r|\n/g, '\\N');
}

function lastLogLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) || '未知错误';
}

function safeUnlink(filePath: string) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.warn('删除临时字幕文件失败:', filePath, err);
  }
}

function buildAtempoFilters(speed: number): string[] {
  const filters: string[] = [];
  let remaining = speed;
  while (remaining > 2.0) {
    filters.push('atempo=2.0');
    remaining /= 2.0;
  }
  while (remaining < 0.5) {
    filters.push('atempo=0.5');
    remaining /= 0.5;
  }
  filters.push(`atempo=${remaining.toFixed(4)}`);
  return filters;
}

function extFromMime(mime: string): string {
  if (mime.includes('wav')) return '.wav';
  if (mime.includes('ogg')) return '.ogg';
  if (mime.includes('flac')) return '.flac';
  if (mime.includes('mp4')) return '.m4a';
  return '.mp3';
}

function escapeConcatPath(filePath: string): string {
  return filePath.replace(/'/g, `'\\''`);
}

function runFfmpeg(args: string[], errorPrefix: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ff = spawn(getFfmpegPath(), args);
    let stderr = '';
    ff.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${errorPrefix}: ${lastLogLine(stderr)} (退出码 ${code})`));
    });
  });
}
