import { IpcMain, dialog, BrowserWindow, screen, app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  splitAudioSegments,
  splitVideoByDuration,
  exportStudyVideos,
  exportChineseDubbedVideo,
  AudioSegment,
  DubbedVideoResult,
  ExportedVideoSet,
  VideoSplitResult,
} from '../services/ffmpeg';
import { uploadToOss, signOssUrl } from '../services/oss';
import { transcribe } from '../services/asr';
import { pMap } from '../services/pMap';
import {
  SubtitleCue,
  SubtitleWord,
  retimeCuesFromWords,
  saveSubtitleBesideVideo,
  loadSubtitle,
  translateCues,
  explainWord,
} from '../services/subtitle';
import { addWord, listWords, deleteWord, updateWord, WordEntry } from '../services/db';
import { getConfig, setConfig, AppConfig } from '../services/config';
import { synthesizeSpeech, TTSOptions } from '../services/tts';
import { loadState, saveState, clearState, PipelineState } from '../services/state';

function sendProgress(stage: string, message: string, percent?: number) {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) win.webContents.send('pipeline:progress', { stage, message, percent });
}

export type WorkerStatus = 'idle' | 'submitting' | 'pending' | 'running' | 'fetching' | 'done' | 'error';
export type WorkerPhase = 'asr' | 'translate';
export interface WorkerEvent {
  phase: WorkerPhase;
  workerId: number;
  workerTotal: number;
  /** ASR 时是 segment index,translate 时是 batch index */
  segmentIndex: number;
  segmentTotal: number;
  status: WorkerStatus;
  message: string;
  cues?: SubtitleCue[];
  offsetMs?: number;
  durationMs?: number;
}
function sendWorker(ev: WorkerEvent) {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) win.webContents.send('pipeline:worker', ev);
}

function resetWorkerPanel(phase: WorkerPhase) {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) win.webContents.send('pipeline:reset-workers', phase);
}

function cleanupSegments(dirs: string[]) {
  for (const d of dirs) {
    try {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    } catch (e) {
      console.warn('清理分段目录失败:', d, e);
    }
  }
}

type YtDlpBrowser = 'chrome' | 'edge' | 'safari' | 'firefox' | 'brave' | 'chromium' | 'vivaldi' | 'opera';
type YtDlpCodecPreset = 'vp9' | 'mp4' | 'default';

interface YtDlpLaunchOptions {
  url: string;
  browser: YtDlpBrowser;
  subs: boolean;
  audioOnly: boolean;
  codec: YtDlpCodecPreset;
  outDir?: string;
}

function shellQuote(value: string): string {
  if (!value) return "''";
  if (/^[a-zA-Z0-9_\-./:=@%+,]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveYtDlpFormat(codec: YtDlpCodecPreset): string | null {
  if (codec === 'vp9') {
    return 'bestvideo[vcodec^=vp9]+bestaudio/best[ext=mp4]/best';
  }
  if (codec === 'mp4') {
    return 'bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/b';
  }
  return null;
}

function extractYoutubeVideoId(rawUrl: string): string {
  let value = (rawUrl || '').trim();
  if (!value) throw new Error('请先输入视频链接');
  try {
    const url = new URL(value);
    const v = url.searchParams.get('v')?.trim();
    if (v) return safeFolderName(v);
    if ((url.hostname === 'youtu.be' || url.hostname.endsWith('.youtu.be')) && url.pathname !== '/') {
      return safeFolderName(url.pathname.replace(/^\/+/, ''));
    }
  } catch {
    // ignore
  }
  const match = value.match(/[?&]v=([^&]+)/);
  if (match?.[1]) return safeFolderName(match[1]);
  throw new Error('没有识别到视频链接里的 v= 参数');
}

function safeFolderName(name: string): string {
  const cleaned = name.trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
  return cleaned || 'youtube-video';
}

function buildYtDlpCommand(opts: YtDlpLaunchOptions, targetDir: string): string {
  const parts = ['yt-dlp', '--cookies-from-browser', opts.browser];
  if (opts.audioOnly) {
    parts.push('-x', '--audio-format', 'mp3');
  } else {
    const format = resolveYtDlpFormat(opts.codec);
    if (format) parts.push('-f', shellQuote(format));
  }
  if (opts.subs) {
    parts.push('--write-subs', '--write-auto-subs', '--sub-langs', 'en,zh-Hans');
  }
  parts.push('-P', shellQuote(targetDir));
  parts.push(shellQuote(opts.url.trim()));
  return parts.join(' ');
}

function escapeAppleScript(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function openTerminalAndRun(command: string, cwd: string): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('当前只支持在 macOS 自动打开终端');
  }

  const script = [
    'tell application "Terminal"',
    'activate',
    `do script "${escapeAppleScript(`cd ${shellQuote(cwd)} && ${command}`)}"`,
    'end tell',
  ].join('\n');

  await new Promise<void>((resolve, reject) => {
    const child = spawn('osascript', ['-e', script]);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `osascript 退出码 ${code}`));
    });
  });
}

// 根据视频宽高比调整主窗口尺寸, 让"视频播放区"保持视频比例, 其他 chrome (顶栏/侧栏/控制条)
// 作为固定像素的 extraSize, 不参与比例计算。拖拽缩放时也继续保持该比例。
//
// 设: ratio = videoW / videoH, extraW = 侧栏宽, extraH = 顶栏 + 控制条高
//     videoAreaW = webContentW - extraW, videoAreaH = webContentH - extraH
//     约束: videoAreaW / videoAreaH = ratio
//
// 策略:
//  - 以当前内容区宽度为起点反推高度, 如果总高超过屏幕, 就用最大高反推宽。
//  - 位置尽量保持左上角, 超出工作区就推回来。
//  - 最大化/全屏状态下 setBounds 无效, 先退出再改。
//
// 重要: 全程用 getContentBounds/setContentBounds 而不是 getBounds/setBounds。
//   - macOS 原生窗口有 ~28px 标题栏在外窗口里、但不在 web 内容里。
//   - 前端测量 extraHeight 是 DOM 元素 (topbar + controls), 不含系统标题栏。
//   - setBounds 操作的是外窗口尺寸, 直接把 extra + 视频区当成外窗口高度会
//     少算一个标题栏高度, 第一次打开视频比例就是扁的;
//     而 setAspectRatio 在 macOS 上作用于内容区 (NSWindow.setContentAspectRatio:),
//     手动缩放时才会把比例矫正回来 —— 这正是 bug 现象。
//   - 用 setContentBounds 之后, 初始重置和后续缩放约束都基于同一个内容区坐标系。
function applyVideoAspectRatio(
  win: BrowserWindow,
  ratio: number,
  extraWidth: number,
  extraHeight: number
) {
  if (!Number.isFinite(ratio) || ratio <= 0) return;

  if (win.isMaximized()) win.unmaximize();
  if (win.isFullScreen()) win.setFullScreen(false);

  const display = screen.getDisplayMatching(win.getBounds());
  const workArea = display.workArea;

  const contentBounds = win.getContentBounds();
  const { x: curX, y: curY, width: curContentW, height: curContentH } = contentBounds;

  // 外窗口与内容区的高度/宽度差 (macOS 上主要是原生标题栏高度)
  const outerBounds = win.getBounds();
  const frameWidth = outerBounds.width - curContentW;
  const frameHeight = outerBounds.height - curContentH;

  // 内容区可用的最大尺寸 (把工作区的 95% 扣掉系统 frame)
  const maxContentW = Math.max(1, Math.floor(workArea.width * 0.95) - frameWidth);
  const maxContentH = Math.max(1, Math.floor(workArea.height * 0.95) - frameHeight);

  // 视频区可用最大值 = 内容区最大值 - 前端测量的 chrome
  const maxVideoW = Math.max(1, maxContentW - extraWidth);
  const maxVideoH = Math.max(1, maxContentH - extraHeight);

  // 起点: 当前内容区宽度里视频区占的部分, 再按比例反推视频高度
  let videoW = Math.max(1, Math.min(curContentW - extraWidth, maxVideoW));
  let videoH = Math.round(videoW / ratio);

  if (videoH > maxVideoH) {
    videoH = maxVideoH;
    videoW = Math.round(videoH * ratio);
  }
  if (videoW > maxVideoW) {
    videoW = maxVideoW;
    videoH = Math.round(videoW / ratio);
  }

  // 最小尺寸兜底: 保证视频区至少有 480x270 的显示空间
  const MIN_VIDEO_W = 480;
  const MIN_VIDEO_H = 270;
  if (videoW < MIN_VIDEO_W) {
    videoW = MIN_VIDEO_W;
    videoH = Math.round(videoW / ratio);
  }
  if (videoH < MIN_VIDEO_H) {
    videoH = MIN_VIDEO_H;
    videoW = Math.round(videoH * ratio);
  }

  const newContentW = videoW + extraWidth;
  const newContentH = videoH + extraHeight;

  // 位置基于外窗口校正: 把外窗口推回工作区内, 再回推到内容区 x/y
  const newOuterW = newContentW + frameWidth;
  const newOuterH = newContentH + frameHeight;
  const outerX = outerBounds.x;
  const outerY = outerBounds.y;
  let newOuterX = outerX;
  let newOuterY = outerY;
  if (newOuterX + newOuterW > workArea.x + workArea.width) {
    newOuterX = workArea.x + workArea.width - newOuterW;
  }
  if (newOuterY + newOuterH > workArea.y + workArea.height) {
    newOuterY = workArea.y + workArea.height - newOuterH;
  }
  if (newOuterX < workArea.x) newOuterX = workArea.x;
  if (newOuterY < workArea.y) newOuterY = workArea.y;
  const newX = curX + (newOuterX - outerX);
  const newY = curY + (newOuterY - outerY);

  win.setContentBounds({ x: newX, y: newY, width: newContentW, height: newContentH }, true);
  // 锁定后续手动拖拽缩放也保持"视频区"比例
  // macOS 上 setAspectRatio 作用在内容区, extraSize 与上面的 content 尺寸是同一坐标系。
  // 其他平台 extraSize 被忽略, 但主流开发机是 macOS, 先满足这个场景。
  win.setAspectRatio(ratio, { width: extraWidth, height: extraHeight });
}

export function registerIpcHandlers(ipcMain: IpcMain) {
  // 视频加载完成后, 渲染进程把 videoWidth/videoHeight 和 chrome 尺寸传过来,
  // 主进程据此调整窗口, 让视频区保持视频比例
  ipcMain.handle(
    'window:set-video-aspect-ratio',
    (
      event,
      ratio: number,
      extra?: { extraWidth?: number; extraHeight?: number }
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return false;
      const extraWidth = Math.max(0, Math.round(extra?.extraWidth ?? 0));
      const extraHeight = Math.max(0, Math.round(extra?.extraHeight ?? 0));
      applyVideoAspectRatio(win, ratio, extraWidth, extraHeight);
      return true;
    }
  );

  // 清空视频时解除比例锁, 允许窗口随意缩放
  ipcMain.handle('window:clear-aspect-ratio', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    win.setAspectRatio(0);
    return true;
  });

  ipcMain.handle('video:pick', async () => {
    const res = await dialog.showOpenDialog({
      title: '选择视频',
      properties: ['openFile'],
      filters: [
        { name: '视频', extensions: ['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  // 按时长把视频切成多段(不重编码,速度快)
  ipcMain.handle(
    'video:split-by-time',
    async (
      _e,
      videoPath: string,
      segmentMinutes = 10
    ): Promise<VideoSplitResult> => {
      try {
        sendProgress('split-video', `按 ${segmentMinutes} 分钟切分中…`, 0);
        const result = await splitVideoByDuration({
          videoPath,
          segmentMinutes,
          onProgress: (p) => sendProgress('split-video', `切分中 ${p}%`, p),
        });
        sendProgress('split-video', `切分完成,共 ${result.files.length} 段`, 100);
        return result;
      } catch (err: any) {
        sendProgress('error', `视频切分失败: ${err?.message || err}`);
        throw err;
      }
    }
  );

  ipcMain.handle('video:to-media-url', async (_e, absolutePath: string) => {
    // 把绝对路径转换为 app-media:// URL，供 <video> 使用
    //
    // 坑 1: scheme 注册为 standard:true,Chromium 按 `scheme://host/path` 解析,
    //       首段会被当作 host 且 lowercase(如 /Users/... 会变成 host=users),
    //       所以必须用一个固定伪 host("local"),把真实路径放到 pathname 里。
    // 坑 2: encodeURI 不会编码方括号 [ ],但它们在 URL path 里是非法的,
    //       Chromium 会直接把整个 URL 判为 invalid,<video> 会静默失败,必须手动补编码。
    const forward = absolutePath.replace(/\\/g, '/');
    const withSlash = forward.startsWith('/') ? forward : '/' + forward;
    const encoded = encodeURI(withSlash).replace(/\[/g, '%5B').replace(/\]/g, '%5D');
    return `app-media://local${encoded}`;
  });

  ipcMain.handle(
    'yt-dlp:launch-download',
    async (_e, options: YtDlpLaunchOptions) => {
      const url = options?.url?.trim();
      if (!url) throw new Error('请先输入视频链接');

      const videoId = extractYoutubeVideoId(url);
      const baseDir = (options?.outDir || '').trim() || app.getPath('downloads');
      const targetDir = path.join(baseDir, videoId);
      fs.mkdirSync(targetDir, { recursive: true });

      const command = buildYtDlpCommand(
        {
          ...options,
          url,
        },
        targetDir
      );

      await openTerminalAndRun(command, targetDir);
      return { command, targetDir, videoId };
    }
  );

  ipcMain.handle(
    'video:export-study-videos',
    async (
      _e,
      videoPath: string,
      cues: SubtitleCue[]
    ): Promise<ExportedVideoSet> => {
      try {
        sendProgress('export-video', '开始导出学习视频…', 0);
        const result = await exportStudyVideos({
          videoPath,
          cues,
          onProgress: (percent, message) => sendProgress('export-video', message, percent),
        });
        sendProgress('done', '视频导出完成', 100);
        return result;
      } catch (err: any) {
        sendProgress('error', `视频导出失败: ${err?.message || err}`);
        throw err;
      }
    }
  );

  ipcMain.handle(
    'video:export-chinese-dubbed',
    async (
      _e,
      videoPath: string,
      cues: SubtitleCue[]
    ): Promise<DubbedVideoResult> => {
      try {
        sendProgress('export-dubbed', '开始导出中文配音视频…', 0);
        const result = await exportChineseDubbedVideo({
          videoPath,
          cues,
          onProgress: (percent, message) => sendProgress('export-dubbed', message, percent),
        });
        sendProgress('done', '中文配音视频导出完成', 100);
        return result;
      } catch (err: any) {
        sendProgress('error', `中文配音视频导出失败: ${err?.message || err}`);
        throw err;
      }
    }
  );

  // 步骤 1: 切分音频(静音感知)
  ipcMain.handle(
    'audio:split',
    async (
      _e,
      videoPath: string,
      segmentSec = 120,
      options?: { toleranceSec?: number; silenceNoiseDb?: number; minSilenceSec?: number }
    ): Promise<AudioSegment[]> => {
      try {
        saveState(videoPath, { steps: { split: 'running' } });
        sendProgress('extract', '正在检测静音…', 0);
        const segments = await splitAudioSegments({
          videoPath,
          segmentSec,
          toleranceSec: options?.toleranceSec,
          silenceNoiseDb: options?.silenceNoiseDb,
          minSilenceSec: options?.minSilenceSec,
          onProgress: (p) => {
            // 0~25% 是扫静音, 25~100% 是逐段抽取
            const msg = p < 25 ? `检测静音 ${Math.round(p * 4)}%` : `切分音频 ${p}%`;
            sendProgress('extract', msg, p);
          },
        });
        if (segments.length === 0) throw new Error('切分后没有得到任何音频段');
        sendProgress('extract', `切分完成,共 ${segments.length} 段`, 100);
        saveState(videoPath, {
          segmentSec,
          segments,
          uploaded: [],
          steps: { split: 'done', upload: 'idle', asr: 'idle', translate: 'idle' },
        });
        return segments;
      } catch (err: any) {
        saveState(videoPath, { steps: { split: 'error' } });
        sendProgress('error', `分离音频失败: ${err?.message || err}`);
        throw err;
      }
    }
  );

  // 步骤 2: 批量上传到 OSS
  ipcMain.handle(
    'audio:upload',
    async (
      _e,
      videoPath: string,
      segments: AudioSegment[],
      concurrency = 3
    ): Promise<Array<AudioSegment & { signedUrl: string; objectKey: string }>> => {
      try {
        saveState(videoPath, { steps: { upload: 'running' } });
        const total = segments.length;
        let done = 0;
        sendProgress('upload', `上传 0/${total} 段`, 0);
        const results = await pMap(
          segments,
          async (seg) => {
            const { signedUrl, objectKey } = await uploadToOss(seg.path);
            done++;
            sendProgress(
              'upload',
              `上传 ${done}/${total} 段`,
              Math.round((done / total) * 100)
            );
            return { ...seg, signedUrl, objectKey };
          },
          concurrency
        );
        sendProgress('upload', `上传完成,共 ${total} 段`, 100);
        saveState(videoPath, {
          // 状态里只存 objectKey,signedUrl 每次 ASR 时重新签
          uploaded: results.map((r) => ({
            path: r.path,
            offsetMs: r.offsetMs,
            durationMs: r.durationMs,
            objectKey: r.objectKey,
          })),
          steps: { upload: 'done', asr: 'idle', translate: 'idle' },
        });
        return results;
      } catch (err: any) {
        saveState(videoPath, { steps: { upload: 'error' } });
        sendProgress('error', `上传失败: ${err?.message || err}`);
        throw err;
      }
    }
  );

  // 步骤 3: 并发 ASR,保存英文 SRT
  ipcMain.handle(
    'asr:run',
    async (
      _e,
      videoPath: string,
      uploaded: Array<AudioSegment & { objectKey: string; signedUrl?: string }>,
      options?: {
        languageHints?: string[];
        concurrency?: number;
      }
    ): Promise<{ cues: SubtitleCue[]; srtPath: string }> => {
      const langHints = options?.languageHints ?? ['en'];
      const concurrency = options?.concurrency ?? 3;

      try {
        // 重做 ASR 会让旧翻译作废
        saveState(videoPath, { steps: { asr: 'running', translate: 'idle' } });
        resetWorkerPanel('asr');
        const refreshed = uploaded.map((u) => ({
          ...u,
          signedUrl: signOssUrl(u.objectKey),
        }));

        const total = refreshed.length;
        const workerTotal = Math.min(concurrency, total);
        let done = 0;
        sendProgress('asr', `识别 0/${total} 段`, 0);
        const perSegCues = await pMap(
          refreshed,
          async (seg, idx, workerId) => {
            const base = {
              phase: 'asr' as const,
              workerId,
              workerTotal,
              segmentIndex: idx,
              segmentTotal: total,
              offsetMs: seg.offsetMs,
              durationMs: seg.durationMs,
            };
            sendWorker({ ...base, status: 'submitting', message: '提交 ASR 任务…' });
            const cues = await transcribe(seg.signedUrl, {
              languageHints: langHints,
              onStatus: (s) => {
                const status: WorkerStatus =
                  s === 'SUCCEEDED' ? 'fetching' :
                  s === 'PENDING' ? 'pending' :
                  s === 'RUNNING' ? 'running' :
                  s.startsWith('任务已提交') ? 'submitting' : 'running';
                sendWorker({ ...base, status, message: s });
              },
            });
            const shifted = cues.map((c) => ({
              ...c,
              startMs: c.startMs + seg.offsetMs,
              endMs: c.endMs + seg.offsetMs,
              words: c.words?.map((w: SubtitleWord) => ({
                ...w,
                startMs: w.startMs + seg.offsetMs,
                endMs: w.endMs + seg.offsetMs,
              })),
            }));
            done++;
            sendWorker({
              ...base,
              status: 'done',
              message: `完成 · ${shifted.length} 句`,
              cues: shifted,
            });
            sendProgress(
              'asr',
              `识别 ${done}/${total} 段完成`,
              Math.round((done / total) * 100)
            );
            return shifted;
          },
          concurrency
        );

        const allCues: SubtitleCue[] = retimeCuesFromWords(
          perSegCues
            .flat()
            .sort((a, b) => a.startMs - b.startMs)
            .map((c, i) => ({ ...c, id: i }))
        );

        const srtPath = saveSubtitleBesideVideo(videoPath, allCues, '');
        sendProgress('done', `识别完成,共 ${allCues.length} 条`, 100);
        saveState(videoPath, {
          steps: { asr: 'done', translate: 'idle' },
          srtPath,
          cueCount: allCues.length,
        });
        return { cues: allCues, srtPath };
      } catch (err: any) {
        saveState(videoPath, { steps: { asr: 'error' } });
        sendProgress('error', `识别失败: ${err?.message || err}`);
        throw err;
      }
    }
  );

  // 步骤 4: 并发翻译已有 cues,保存双语 SRT
  ipcMain.handle(
    'translate:run',
    async (
      _e,
      videoPath: string,
      cues: SubtitleCue[],
      options?: { target?: string; concurrency?: number }
    ): Promise<{ cues: SubtitleCue[]; srtPath: string }> => {
      const target = options?.target || '中文';
      const concurrency = options?.concurrency ?? 3;
      try {
        saveState(videoPath, { steps: { translate: 'running' } });
        resetWorkerPanel('translate');
        const batchTotal = Math.max(1, Math.ceil(cues.length / 40));
        const workerTotal = Math.min(concurrency, batchTotal);
        let done = 0;
        sendProgress('translate', `翻译 0/${batchTotal} 批`, 0);

        const translated = await translateCues(cues, {
          target,
          concurrency,
          onStart: (info) => {
            sendWorker({
              phase: 'translate',
              workerId: info.workerId,
              workerTotal,
              segmentIndex: info.batchIndex,
              segmentTotal: info.batchTotal,
              status: 'running',
              message: `翻译第 ${info.batchIndex + 1}/${info.batchTotal} 批 · ${info.batchSize} 句`,
            });
          },
          onBatch: (info) => {
            done++;
            sendWorker({
              phase: 'translate',
              workerId: info.workerId,
              workerTotal,
              segmentIndex: info.batchIndex,
              segmentTotal: info.batchTotal,
              status: 'done',
              message: `完成第 ${info.batchIndex + 1}/${info.batchTotal} 批 · ${info.batchSize} 句`,
              cues: info.translated,
            });
            sendProgress(
              'translate',
              `翻译 ${done}/${info.batchTotal} 批`,
              Math.round((done / info.batchTotal) * 100)
            );
          },
        });

        const srtPath = saveSubtitleBesideVideo(videoPath, translated, '.bilingual');
        sendProgress('done', `翻译完成,共 ${translated.length} 条`, 100);
        saveState(videoPath, {
          steps: { translate: 'done' },
          srtPath,
          cueCount: translated.length,
        });
        return { cues: translated, srtPath };
      } catch (err: any) {
        saveState(videoPath, { steps: { translate: 'error' } });
        sendProgress('error', `翻译失败: ${err?.message || err}`);
        throw err;
      }
    }
  );

  // 手动清理切段文件 + 状态(比如用户想从头来过)
  ipcMain.handle(
    'audio:cleanup',
    async (_e, videoPath: string, opts?: { clearState?: boolean }) => {
      const name = path.parse(videoPath).name;
      const segDir = path.join(path.dirname(videoPath), `.${name}.segments`);
      cleanupSegments([segDir]);
      if (opts?.clearState) {
        clearState(videoPath);
      } else {
        saveState(videoPath, {
          segments: [],
          uploaded: [],
          steps: { split: 'idle', upload: 'idle', asr: 'idle', translate: 'idle' },
        });
      }
      return true;
    }
  );

  // 恢复:加载视频对应的已保存状态
  ipcMain.handle(
    'state:load',
    async (_e, videoPath: string): Promise<PipelineState | null> => {
      return loadState(videoPath);
    }
  );

  ipcMain.handle('state:clear', async (_e, videoPath: string) => {
    clearState(videoPath);
    return true;
  });

  // 记录视频当前播放位置,用于下次打开时续播
  ipcMain.handle(
    'state:save-position',
    async (_e, videoPath: string, positionMs: number) => {
      if (!videoPath || !Number.isFinite(positionMs) || positionMs < 0) return false;
      saveState(videoPath, { lastPositionMs: Math.floor(positionMs) });
      return true;
    }
  );

  // 判断文件是否存在(WordBook 跨视频跳转前用来校验原视频是否还在)
  ipcMain.handle('fs:exists', async (_e, p: string) => {
    if (!p) return false;
    try {
      const st = fs.statSync(p);
      return st.isFile();
    } catch {
      return false;
    }
  });

  ipcMain.handle('subtitle:load', async (_e, srtPath: string) => loadSubtitle(srtPath));
  ipcMain.handle('subtitle:save', async (_e, videoPath: string, cues: SubtitleCue[], suffix: string) =>
    saveSubtitleBesideVideo(videoPath, cues, suffix || '')
  );
  ipcMain.handle('subtitle:translate', async (_e, cues: SubtitleCue[], target: string) =>
    translateCues(cues, target || '中文')
  );

  ipcMain.handle('word:add', async (_e, entry: WordEntry) => addWord(entry));
  ipcMain.handle('word:list', async () => listWords());
  ipcMain.handle('word:delete', async (_e, id: number) => {
    deleteWord(id);
    return true;
  });
  ipcMain.handle('word:explain', async (_e, word: string, context: string) =>
    explainWord(word, context)
  );
  ipcMain.handle('word:update', async (_e, id: number, patch: Partial<WordEntry>) =>
    updateWord(id, patch)
  );

  ipcMain.handle('tts:synthesize', async (_e, opts: TTSOptions) => synthesizeSpeech(opts));

  ipcMain.handle('config:get', async () => {
    const cfg = getConfig();
    // 不暴露完整的 secret，但渲染进程需要自己的配置页能编辑，所以照实返回
    return cfg;
  });
  ipcMain.handle('config:set', async (_e, cfg: Partial<AppConfig>) => {
    setConfig(cfg);
    return getConfig();
  });
}
