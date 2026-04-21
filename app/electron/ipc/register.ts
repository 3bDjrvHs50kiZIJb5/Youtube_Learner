import { IpcMain, dialog, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  splitAudioSegments,
  splitVideoByDuration,
  AudioSegment,
  VideoSplitResult,
} from '../services/ffmpeg';
import { uploadToOss, signOssUrl } from '../services/oss';
import { transcribe } from '../services/asr';
import { pMap } from '../services/pMap';
import {
  SubtitleCue,
  SubtitleWord,
  saveSubtitleBesideVideo,
  loadSubtitle,
  translateCues,
} from '../services/subtitle';
import { addWord, listWords, deleteWord, WordEntry } from '../services/db';
import { getConfig, setConfig, AppConfig } from '../services/config';
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

export function registerIpcHandlers(ipcMain: IpcMain) {
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

        const allCues: SubtitleCue[] = perSegCues
          .flat()
          .sort((a, b) => a.startMs - b.startMs)
          .map((c, i) => ({ ...c, id: i }));

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
