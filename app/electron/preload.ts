import { contextBridge, ipcRenderer } from 'electron';

// 渲染进程可以用 window.api.xxx 调用这些方法，全部走 IPC
const api = {
  // 文件 & 视频
  pickVideo: () => ipcRenderer.invoke('video:pick'),
  toMediaUrl: (absolutePath: string) => ipcRenderer.invoke('video:to-media-url', absolutePath),
  videoSplitByTime: (videoPath: string, segmentMinutes: number) =>
    ipcRenderer.invoke('video:split-by-time', videoPath, segmentMinutes),

  // 分步骤: 1)切分 2)上传 3)ASR 字幕 4)翻译
  audioSplit: (
    videoPath: string,
    segmentSec?: number,
    options?: { toleranceSec?: number; silenceNoiseDb?: number; minSilenceSec?: number }
  ) => ipcRenderer.invoke('audio:split', videoPath, segmentSec, options),
  audioUpload: (videoPath: string, segments: unknown, concurrency?: number) =>
    ipcRenderer.invoke('audio:upload', videoPath, segments, concurrency),
  asrRun: (
    videoPath: string,
    uploaded: unknown,
    options?: { languageHints?: string[]; concurrency?: number }
  ) => ipcRenderer.invoke('asr:run', videoPath, uploaded, options),
  translateRun: (
    videoPath: string,
    cues: unknown,
    options?: { target?: string; concurrency?: number }
  ) => ipcRenderer.invoke('translate:run', videoPath, cues, options),
  audioCleanup: (videoPath: string, opts?: { clearState?: boolean }) =>
    ipcRenderer.invoke('audio:cleanup', videoPath, opts),

  // 状态持久化
  stateLoad: (videoPath: string) => ipcRenderer.invoke('state:load', videoPath),
  stateClear: (videoPath: string) => ipcRenderer.invoke('state:clear', videoPath),

  // 字幕
  loadSubtitle: (subtitlePath: string) => ipcRenderer.invoke('subtitle:load', subtitlePath),
  saveSubtitle: (videoPath: string, subtitle: unknown, suffix: string) =>
    ipcRenderer.invoke('subtitle:save', videoPath, subtitle, suffix),
  translateSubtitle: (subtitle: unknown, target: string) =>
    ipcRenderer.invoke('subtitle:translate', subtitle, target),

  // 生词本
  wordAdd: (entry: unknown) => ipcRenderer.invoke('word:add', entry),
  wordList: () => ipcRenderer.invoke('word:list'),
  wordDelete: (id: number) => ipcRenderer.invoke('word:delete', id),

  // 配置（AccessKey 等）
  configGet: () => ipcRenderer.invoke('config:get'),
  configSet: (cfg: unknown) => ipcRenderer.invoke('config:set', cfg),

  // 进度监听
  onProgress: (cb: (e: { stage: string; message: string; percent?: number }) => void) => {
    const listener = (_: unknown, data: { stage: string; message: string; percent?: number }) => cb(data);
    ipcRenderer.on('pipeline:progress', listener);
    return () => ipcRenderer.removeListener('pipeline:progress', listener);
  },
  onWorker: (cb: (e: unknown) => void) => {
    const listener = (_: unknown, data: unknown) => cb(data);
    ipcRenderer.on('pipeline:worker', listener);
    return () => ipcRenderer.removeListener('pipeline:worker', listener);
  },
  onResetWorkers: (cb: (phase: 'asr' | 'translate') => void) => {
    const listener = (_: unknown, phase: 'asr' | 'translate') => cb(phase);
    ipcRenderer.on('pipeline:reset-workers', listener);
    return () => ipcRenderer.removeListener('pipeline:reset-workers', listener);
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
