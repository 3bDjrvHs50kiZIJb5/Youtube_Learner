import { create } from 'zustand';
import type {
  AudioSegment,
  SubtitleCue,
  UploadedSegment,
  WorkerEvent,
  WorkerPhase,
  WorkerStatus,
} from '../types';

export type StepStatus = 'idle' | 'running' | 'done' | 'error';
export interface PipelineSteps {
  split: StepStatus;
  upload: StepStatus;
  asr: StepStatus;
  translate: StepStatus;
}

export interface WorkerState {
  workerId: number;
  segmentIndex: number;
  segmentTotal: number;
  status: WorkerStatus;
  message: string;
  offsetMs?: number;
  durationMs?: number;
  /** 该 worker 最近处理过的 N 段的字幕日志(最新在前) */
  log: Array<{ segmentIndex: number; cues: SubtitleCue[]; offsetMs: number }>;
}

export interface PlayerState {
  videoPath: string | null;
  mediaUrl: string | null;
  cues: SubtitleCue[];
  activeCueId: number | null;
  editingCueId: number | null;

  showEnglish: boolean;
  showTranslation: boolean;

  loopCueId: number | null;
  loopRemaining: number;
  autoPauseAtSentenceEnd: boolean;

  progress: { stage: string; message: string; percent?: number } | null;

  /** 打开视频时待恢复的播放位置(毫秒);Player 在 loadedmetadata 后消费并清空 */
  initialSeekMs: number | null;

  // 分步骤状态
  steps: PipelineSteps;
  segments: AudioSegment[];
  uploaded: UploadedSegment[];

  setVideo: (videoPath: string, mediaUrl: string) => void;
  setInitialSeek: (ms: number | null) => void;
  setCues: (cues: SubtitleCue[]) => void;
  updateCueTranslation: (cueId: number, translation: string) => void;
  /** 编辑字幕字段(未传的字段保持不变) */
  updateCue: (
    cueId: number,
    patch: {
      text?: string;
      translation?: string;
      startMs?: number;
      endMs?: number;
      words?: SubtitleCue['words'];
    }
  ) => void;
  setActiveCue: (id: number | null) => void;
  setEditingCue: (id: number | null) => void;
  toggleEnglish: () => void;
  toggleTranslation: () => void;
  setLoop: (cueId: number | null, times?: number) => void;
  decLoop: () => void;
  toggleAutoPause: () => void;
  setProgress: (p: PlayerState['progress']) => void;

  setStep: (name: keyof PipelineSteps, status: StepStatus) => void;
  setSegments: (segs: AudioSegment[]) => void;
  setUploaded: (ups: UploadedSegment[]) => void;
  resetPipeline: () => void;

  // worker 面板:ASR 和 翻译 各一组
  currentPhase: WorkerPhase;
  asrWorkers: Record<number, WorkerState>;
  asrWorkerTotal: number;
  translateWorkers: Record<number, WorkerState>;
  translateWorkerTotal: number;
  updateWorker: (ev: WorkerEvent) => void;
  resetWorkerPanel: (phase: WorkerPhase) => void;
  setCurrentPhase: (phase: WorkerPhase) => void;
}

const initialSteps: PipelineSteps = { split: 'idle', upload: 'idle', asr: 'idle', translate: 'idle' };

export const usePlayerStore = create<PlayerState>((set) => ({
  videoPath: null,
  mediaUrl: null,
  cues: [],
  activeCueId: null,
  editingCueId: null,
  showEnglish: true,
  showTranslation: true,
  loopCueId: null,
  loopRemaining: 0,
  autoPauseAtSentenceEnd: false,
  progress: null,
  initialSeekMs: null,

  steps: { ...initialSteps },
  segments: [],
  uploaded: [],

  setVideo: (videoPath, mediaUrl) =>
    set({
      videoPath,
      mediaUrl,
      cues: [],
      activeCueId: null,
      editingCueId: null,
      steps: { ...initialSteps },
      segments: [],
      uploaded: [],
      initialSeekMs: null,
    }),
  setInitialSeek: (ms) => set({ initialSeekMs: ms }),
  setCues: (cues) => set({ cues }),
  updateCueTranslation: (cueId, translation) =>
    set((s) => ({
      cues: s.cues.map((c) => (c.id === cueId ? { ...c, translation } : c)),
    })),
  updateCue: (cueId, patch) =>
    set((s) => {
      const index = s.cues.findIndex((c) => c.id === cueId);
      if (index === -1) return s;

      const nextStartMs = patch.startMs ?? s.cues[index].startMs;
      const nextEndMs = patch.endMs ?? s.cues[index].endMs;
      if (nextEndMs <= nextStartMs) return s;

      const remapWords = (
        words: typeof s.cues[number]['words'],
        oldStart: number,
        oldEnd: number,
        newStart: number,
        newEnd: number
      ) => {
        if (!words || !words.length) return words;
        const oldSpan = oldEnd - oldStart;
        if (oldSpan <= 0) {
          const delta = newStart - oldStart;
          return words.map((w) => ({ ...w, startMs: w.startMs + delta, endMs: w.endMs + delta }));
        }
        const scale = (newEnd - newStart) / oldSpan;
        return words.map((w) => ({
          ...w,
          startMs: Math.round(newStart + (w.startMs - oldStart) * scale),
          endMs: Math.round(newStart + (w.endMs - oldStart) * scale),
        }));
      };

      const cues = s.cues.map((cue) => ({ ...cue }));

      const applyRange = (cueIndex: number, newStart: number, newEnd: number) => {
        const cue = cues[cueIndex];
        if (!cue) return;
        if (cue.startMs === newStart && cue.endMs === newEnd) return;
        cues[cueIndex] = {
          ...cue,
          startMs: newStart,
          endMs: newEnd,
          words: remapWords(cue.words, cue.startMs, cue.endMs, newStart, newEnd),
        };
      };

      const repairBackward = (cueIndex: number, boundaryEnd: number) => {
        if (cueIndex < 0) return;
        const cue = cues[cueIndex];
        if (!cue) return;

        let newStart = cue.startMs;
        const newEnd = boundaryEnd;

        if (newEnd <= newStart) {
          const duration = Math.max(1, cue.endMs - cue.startMs);
          newStart = Math.max(0, newEnd - duration);
        }

        applyRange(cueIndex, newStart, newEnd);

        if (newStart !== cue.startMs) {
          repairBackward(cueIndex - 1, newStart);
        }
      };

      const repairForward = (cueIndex: number, boundaryStart: number) => {
        if (cueIndex >= cues.length) return;
        const cue = cues[cueIndex];
        if (!cue) return;

        const newStart = boundaryStart;
        let newEnd = cue.endMs;

        if (newStart >= newEnd) {
          const duration = Math.max(1, cue.endMs - cue.startMs);
          newEnd = newStart + duration;
        }

        applyRange(cueIndex, newStart, newEnd);

        if (newEnd !== cue.endMs) {
          repairForward(cueIndex + 1, newEnd);
        }
      };

      const current = cues[index];
      cues[index] = {
        ...current,
        startMs: nextStartMs,
        endMs: nextEndMs,
        text: patch.text ?? current.text,
        translation: patch.translation ?? current.translation,
        words:
          patch.words !== undefined
            ? patch.words
            : remapWords(current.words, current.startMs, current.endMs, nextStartMs, nextEndMs),
      };

      if (patch.startMs !== undefined) {
        repairBackward(index - 1, nextStartMs);
      }
      if (patch.endMs !== undefined) {
        repairForward(index + 1, nextEndMs);
      }

      return { cues };
    }),
  setActiveCue: (id) => set({ activeCueId: id }),
  setEditingCue: (id) => set({ editingCueId: id }),
  toggleEnglish: () => set((s) => ({ showEnglish: !s.showEnglish })),
  toggleTranslation: () => set((s) => ({ showTranslation: !s.showTranslation })),
  setLoop: (cueId, times = -1) => set({ loopCueId: cueId, loopRemaining: times }),
  decLoop: () =>
    set((s) => {
      if (s.loopRemaining === -1) return s;
      const next = s.loopRemaining - 1;
      return next <= 0 ? { loopCueId: null, loopRemaining: 0 } : { loopRemaining: next };
    }),
  toggleAutoPause: () => set((s) => ({ autoPauseAtSentenceEnd: !s.autoPauseAtSentenceEnd })),
  setProgress: (progress) => set({ progress }),

  setStep: (name, status) => set((s) => ({ steps: { ...s.steps, [name]: status } })),
  setSegments: (segments) => set({ segments }),
  setUploaded: (uploaded) => set({ uploaded }),
  resetPipeline: () =>
    set({ steps: { ...initialSteps }, segments: [], uploaded: [] }),

  currentPhase: 'asr',
  asrWorkers: {},
  asrWorkerTotal: 0,
  translateWorkers: {},
  translateWorkerTotal: 0,
  updateWorker: (ev) =>
    set((s) => {
      const key = ev.phase === 'asr' ? 'asrWorkers' : 'translateWorkers';
      const totalKey = ev.phase === 'asr' ? 'asrWorkerTotal' : 'translateWorkerTotal';
      const prevMap = s[key];
      const prev = prevMap[ev.workerId];
      const log = prev?.log ? [...prev.log] : [];
      if (ev.status === 'done' && ev.cues && ev.cues.length) {
        log.unshift({
          segmentIndex: ev.segmentIndex,
          cues: ev.cues,
          offsetMs: ev.offsetMs ?? 0,
        });
        if (log.length > 3) log.length = 3;
      }
      return {
        currentPhase: ev.phase,
        [totalKey]: Math.max(s[totalKey] as number, ev.workerTotal),
        [key]: {
          ...prevMap,
          [ev.workerId]: {
            workerId: ev.workerId,
            segmentIndex: ev.segmentIndex,
            segmentTotal: ev.segmentTotal,
            status: ev.status,
            message: ev.message,
            offsetMs: ev.offsetMs,
            durationMs: ev.durationMs,
            log,
          },
        },
      } as Partial<PlayerState>;
    }),
  resetWorkerPanel: (phase) =>
    set(() => ({
      currentPhase: phase,
      ...(phase === 'asr'
        ? { asrWorkers: {}, asrWorkerTotal: 0 }
        : { translateWorkers: {}, translateWorkerTotal: 0 }),
    })),
  setCurrentPhase: (phase) => set({ currentPhase: phase }),
}));
