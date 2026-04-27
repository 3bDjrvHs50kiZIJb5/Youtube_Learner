export interface SubtitleWord {
  text: string;
  startMs: number;
  endMs: number;
  /** Paraformer 里紧跟该词的标点(如 "," "." "?"),可选。主要用于拼回原句时补标点 */
  punctuation?: string;
}

export interface SubtitleCue {
  id: number;
  startMs: number;
  endMs: number;
  text: string;
  translation?: string;
  /** 字级时间戳。英文是逐单词,中文是逐字。没有时走整句级别的 startMs/endMs 即可 */
  words?: SubtitleWord[];
}

export interface AudioSegment {
  path: string;
  offsetMs: number;
  durationMs: number;
}

export interface UploadedSegment extends AudioSegment {
  signedUrl?: string;
  objectKey: string;
}

export interface ExportedVideoSet {
  outputDir: string;
  plainVideoPath?: string;
  englishSubtitleVideoPath?: string;
  bilingualSubtitleVideoPath?: string;
  dubbedVideoPath?: string;
}

export type StudyVideoExportKind = 'plain' | 'english' | 'bilingual' | 'dubbed';

export interface StudyVideoExportSelection {
  plain: boolean;
  english: boolean;
  bilingual: boolean;
  dubbed: boolean;
}

export interface DubbedVideoResult {
  outputDir: string;
  dubbedVideoPath: string;
}

export interface YtDlpLaunchResult {
  command: string;
  targetDir: string;
  videoId: string;
}

export type StepStatus = 'idle' | 'running' | 'done' | 'error';

export type WorkerStatus = 'idle' | 'submitting' | 'pending' | 'running' | 'fetching' | 'done' | 'error';
export type WorkerPhase = 'asr' | 'translate';

export interface WorkerEvent {
  phase: WorkerPhase;
  workerId: number;
  workerTotal: number;
  segmentIndex: number;
  segmentTotal: number;
  status: WorkerStatus;
  message: string;
  cues?: SubtitleCue[];
  offsetMs?: number;
  durationMs?: number;
}

export interface PipelineState {
  version: 1;
  videoPath: string;
  videoSize: number;
  videoMtimeMs: number;
  segmentSec: number;
  segments: AudioSegment[];
  uploaded: UploadedSegment[];
  steps: { split: StepStatus; upload: StepStatus; asr: StepStatus; translate: StepStatus };
  srtPath?: string;
  cueCount?: number;
  lastPositionMs?: number;
  updatedAt: number;
}

export interface WordEntry {
  id?: number;
  bucketKey?: string;
  word: string;
  context?: string;
  translation?: string;
  videoPath?: string;
  sentenceStartMs?: number;
  sentenceEndMs?: number;
  note?: string;
  createdAt?: number;
  phonetic?: string;
  pos?: string;
  meaning?: string;
  contextual?: string;
}

export interface WordExplanation {
  word: string;
  phonetic?: string;
  pos?: string;
  meaning?: string;
  contextual?: string;
}

export interface AppTTSConfig {
  model?: string;
  voice?: string;
  language?: string;
  endpoint?: string;
  /** 朗读倍速, 0.5~2.0, 默认 1.0。纯客户端 audio.playbackRate 实现 */
  speed?: number;
}

export interface AppConfig {
  dashscopeApiKey: string;
  oss: {
    region: string;
    bucket: string;
    accessKeyId: string;
    accessKeySecret: string;
    prefix?: string;
  };
  translateTarget?: string;
  tts?: AppTTSConfig;
}

export interface TTSResult {
  dataBase64: string;
  mime: string;
}

declare global {
  interface Window {
    api: {
      setWindowAspectRatio: (
        ratio: number,
        extra?: { extraWidth?: number; extraHeight?: number }
      ) => Promise<boolean>;
      clearWindowAspectRatio: () => Promise<boolean>;
      pickVideo: () => Promise<string | null>;
      toMediaUrl: (p: string) => Promise<string>;
      getPathForFile: (file: File) => string;
      videoSplitByTime: (
        videoPath: string,
        segmentMinutes: number
      ) => Promise<{ outputDir: string; files: string[] }>;
      exportStudyVideos: (
        videoPath: string,
        cues: SubtitleCue[],
        selection?: StudyVideoExportSelection
      ) => Promise<ExportedVideoSet>;
      exportChineseDubbedVideo: (
        videoPath: string,
        cues: SubtitleCue[]
      ) => Promise<DubbedVideoResult>;
      ytDlpLaunchDownload: (options: {
        url: string;
        browser: string;
        subs: boolean;
        audioOnly: boolean;
        codec: string;
      }) => Promise<YtDlpLaunchResult>;
      audioSplit: (
        videoPath: string,
        segmentSec?: number,
        options?: { toleranceSec?: number; silenceNoiseDb?: number; minSilenceSec?: number }
      ) => Promise<AudioSegment[]>;
      audioUpload: (
        videoPath: string,
        segments: AudioSegment[],
        concurrency?: number
      ) => Promise<UploadedSegment[]>;
      asrRun: (
        videoPath: string,
        uploaded: UploadedSegment[],
        options?: { languageHints?: string[]; concurrency?: number }
      ) => Promise<{ cues: SubtitleCue[]; srtPath: string }>;
      translateRun: (
        videoPath: string,
        cues: SubtitleCue[],
        options?: { target?: string; concurrency?: number }
      ) => Promise<{ cues: SubtitleCue[]; srtPath: string }>;
      audioCleanup: (videoPath: string, opts?: { clearState?: boolean }) => Promise<boolean>;
      stateLoad: (videoPath: string) => Promise<PipelineState | null>;
      stateClear: (videoPath: string) => Promise<boolean>;
      stateSavePosition: (videoPath: string, positionMs: number) => Promise<boolean>;
      fileExists: (p: string) => Promise<boolean>;
      consumePendingOpenFile: () => Promise<string | null>;
      onWorker: (cb: (e: WorkerEvent) => void) => () => void;
      onResetWorkers: (cb: (phase: WorkerPhase) => void) => () => void;
      onOpenVideoFile: (cb: (absolutePath: string) => void) => () => void;
      loadSubtitle: (p: string) => Promise<SubtitleCue[]>;
      saveSubtitle: (videoPath: string, cues: SubtitleCue[], suffix: string) => Promise<string>;
      translateSubtitle: (cues: SubtitleCue[], target: string) => Promise<SubtitleCue[]>;
      wordAdd: (entry: WordEntry) => Promise<WordEntry>;
      wordList: (videoPath?: string) => Promise<WordEntry[]>;
      wordDelete: (id: number, bucketKey?: string) => Promise<boolean>;
      wordExplain: (word: string, context: string) => Promise<WordExplanation>;
      wordUpdate: (id: number, patch: Partial<WordEntry>, bucketKey?: string) => Promise<WordEntry | null>;
      ttsSynthesize: (opts: {
        text: string;
        voice?: string;
        model?: string;
        language?: string;
      }) => Promise<TTSResult>;
      configGet: () => Promise<AppConfig>;
      configSet: (cfg: Partial<AppConfig>) => Promise<AppConfig>;
      onProgress: (
        cb: (e: { stage: string; message: string; percent?: number }) => void
      ) => () => void;
    };
  }
}
