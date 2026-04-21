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
  updatedAt: number;
}

export interface WordEntry {
  id?: number;
  word: string;
  context?: string;
  translation?: string;
  videoPath?: string;
  sentenceStartMs?: number;
  sentenceEndMs?: number;
  note?: string;
  createdAt?: number;
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
}

declare global {
  interface Window {
    api: {
      pickVideo: () => Promise<string | null>;
      toMediaUrl: (p: string) => Promise<string>;
      videoSplitByTime: (
        videoPath: string,
        segmentMinutes: number
      ) => Promise<{ outputDir: string; files: string[] }>;
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
      onWorker: (cb: (e: WorkerEvent) => void) => () => void;
      onResetWorkers: (cb: (phase: WorkerPhase) => void) => () => void;
      loadSubtitle: (p: string) => Promise<SubtitleCue[]>;
      saveSubtitle: (videoPath: string, cues: SubtitleCue[], suffix: string) => Promise<string>;
      translateSubtitle: (cues: SubtitleCue[], target: string) => Promise<SubtitleCue[]>;
      wordAdd: (entry: WordEntry) => Promise<WordEntry>;
      wordList: () => Promise<WordEntry[]>;
      wordDelete: (id: number) => Promise<boolean>;
      configGet: () => Promise<AppConfig>;
      configSet: (cfg: Partial<AppConfig>) => Promise<AppConfig>;
      onProgress: (
        cb: (e: { stage: string; message: string; percent?: number }) => void
      ) => () => void;
    };
  }
}
