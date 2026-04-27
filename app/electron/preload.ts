import { contextBridge, ipcRenderer, webUtils } from 'electron';

// 渲染进程可以用 window.api.xxx 调用这些方法，全部走 IPC
const api = {
  // 窗口控制: 视频加载完后按视频比例调整窗口
  // extra = { extraWidth: 侧栏宽, extraHeight: 顶栏+控制条高 }
  setWindowAspectRatio: (
    ratio: number,
    extra?: { extraWidth?: number; extraHeight?: number }
  ) => ipcRenderer.invoke('window:set-video-aspect-ratio', ratio, extra),
  clearWindowAspectRatio: () => ipcRenderer.invoke('window:clear-aspect-ratio'),

  // 文件 & 视频
  pickVideo: () => ipcRenderer.invoke('video:pick'),
  toMediaUrl: (absolutePath: string) => ipcRenderer.invoke('video:to-media-url', absolutePath),
  // Electron 32 起 File.path 已被移除,必须通过 webUtils.getPathForFile 取绝对路径
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  videoSplitByTime: (videoPath: string, segmentMinutes: number) =>
    ipcRenderer.invoke('video:split-by-time', videoPath, segmentMinutes),
  exportStudyVideos: (videoPath: string, cues: unknown, selection?: unknown) =>
    ipcRenderer.invoke('video:export-study-videos', videoPath, cues, selection),
  exportChineseDubbedVideo: (videoPath: string, cues: unknown) =>
    ipcRenderer.invoke('video:export-chinese-dubbed', videoPath, cues),
  ytDlpLaunchDownload: (options: unknown) =>
    ipcRenderer.invoke('yt-dlp:launch-download', options),

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
  stateSavePosition: (videoPath: string, positionMs: number) =>
    ipcRenderer.invoke('state:save-position', videoPath, positionMs),

  // 文件系统
  fileExists: (p: string) => ipcRenderer.invoke('fs:exists', p),
  consumePendingOpenFile: () => ipcRenderer.invoke('app:consume-pending-open-file'),

  // 字幕
  loadSubtitle: (subtitlePath: string) => ipcRenderer.invoke('subtitle:load', subtitlePath),
  saveSubtitle: (videoPath: string, subtitle: unknown, suffix: string) =>
    ipcRenderer.invoke('subtitle:save', videoPath, subtitle, suffix),
  translateSubtitle: (subtitle: unknown, target: string) =>
    ipcRenderer.invoke('subtitle:translate', subtitle, target),

  // 生词本
  wordAdd: (entry: unknown) => ipcRenderer.invoke('word:add', entry),
  wordList: (videoPath?: string) => ipcRenderer.invoke('word:list', videoPath),
  wordDelete: (id: number, bucketKey?: string) => ipcRenderer.invoke('word:delete', id, bucketKey),
  wordExplain: (word: string, context: string) =>
    ipcRenderer.invoke('word:explain', word, context),
  wordUpdate: (id: number, patch: unknown, bucketKey?: string) =>
    ipcRenderer.invoke('word:update', id, patch, bucketKey),

  ttsSynthesize: (opts: { text: string; voice?: string; model?: string; language?: string }) =>
    ipcRenderer.invoke('tts:synthesize', opts),

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
  onOpenVideoFile: (cb: (absolutePath: string) => void) => {
    const listener = (_: unknown, absolutePath: string) => cb(absolutePath);
    ipcRenderer.on('app:open-file', listener);
    return () => ipcRenderer.removeListener('app:open-file', listener);
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
