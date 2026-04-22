import { useCallback, useEffect, useState } from 'react';
import { usePlayerStore, StepStatus } from './store/player';
import { Player } from './components/Player';
import { CueList } from './components/CueList';
import { WordBook } from './components/WordBook';
import { SettingsModal } from './components/SettingsModal';
import { YtDlpModal } from './components/YtDlpModal';
import { VideoSplitModal } from './components/VideoSplitModal';
import { ProgressPanel } from './components/ProgressPanel';
import { APP_TOAST_EVENT, AppToastDetail } from './utils/toast';

function StepIcon({ status }: { status: StepStatus }) {
  if (status === 'done') return <span style={{ color: 'var(--success)' }}>✓</span>;
  if (status === 'running') return <span style={{ color: 'var(--warn)' }}>⋯</span>;
  if (status === 'error') return <span style={{ color: 'var(--danger)' }}>!</span>;
  return <span style={{ color: 'var(--muted)' }}>○</span>;
}

export default function App() {
  const {
    videoPath,
    cues,
    steps,
    segments,
    uploaded,
    setVideo,
    setCues,
    setProgress,
    progress,
    setStep,
    setSegments,
    setUploaded,
    updateWorker,
    resetWorkerPanel,
    setInitialSeek,
  } = usePlayerStore();
  const [tab, setTab] = useState<'cue' | 'word' | 'progress'>('cue');
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ytdlpOpen, setYtdlpOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [wordRefresh, setWordRefresh] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const offs = [
      window.api.onProgress((e) => setProgress(e)),
      window.api.onWorker((e) => updateWorker(e)),
      window.api.onResetWorkers((phase) => resetWorkerPanel(phase)),
    ];
    return () => offs.forEach((f) => f());
  }, [setProgress, updateWorker, resetWorkerPanel]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // 监听来自非 App 组件(比如 utils/tts.ts)派发的全局 toast
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<AppToastDetail>).detail;
      if (detail?.message) setToast(detail.message);
    };
    window.addEventListener(APP_TOAST_EVENT, handler);
    return () => window.removeEventListener(APP_TOAST_EVENT, handler);
  }, []);

  // 根据绝对路径打开视频(pickVideo 和 拖拽入口共用)
  const openVideoByPath = useCallback(
    async (p: string) => {
      const url = await window.api.toMediaUrl(p);
      setVideo(p, url);

      // 恢复上次的 pipeline 状态
      const state = await window.api.stateLoad(p);
      if (state) {
        setSegments(state.segments);
        setUploaded(state.uploaded);
        setStep('split', state.steps.split);
        setStep('upload', state.steps.upload);
        setStep('asr', state.steps.asr);
        setStep('translate', state.steps.translate);
        const restored: string[] = [];
        if (state.steps.split === 'done') restored.push(`${state.segments.length} 段已切分`);
        if (state.steps.upload === 'done') restored.push(`${state.uploaded.length} 段已上传`);
        if (state.steps.asr === 'done') restored.push(`字幕已生成`);
        if (state.steps.translate === 'done') restored.push(`翻译已完成`);
        // 记录上次播放位置(超过 3 秒才值得续播)
        if (state.lastPositionMs && state.lastPositionMs > 3000) {
          setInitialSeek(state.lastPositionMs);
          const sec = Math.floor(state.lastPositionMs / 1000);
          const mm = String(Math.floor(sec / 60)).padStart(2, '0');
          const ss = String(sec % 60).padStart(2, '0');
          restored.push(`续播自 ${mm}:${ss}`);
        }
        if (restored.length) setToast(`已恢复上次进度: ${restored.join(' · ')}`);
      }

      // 优先加载状态里记录的 SRT 路径,否则尝试同名 .srt
      const tryPaths = [
        state?.srtPath,
        p.replace(/\.[^.]+$/, '.bilingual.srt'),
        p.replace(/\.[^.]+$/, '.srt'),
      ].filter(Boolean) as string[];
      for (const srt of tryPaths) {
        try {
          const loaded = await window.api.loadSubtitle(srt);
          if (loaded.length) {
            setCues(loaded);
            break;
          }
        } catch {
          // ignore
        }
      }
    },
    [setVideo, setSegments, setUploaded, setStep, setCues, setInitialSeek]
  );

  // WordBook 的"回到语境"触发跨视频跳转:先切换到目标视频,再按 startMs 续播
  useEffect(() => {
    const handler = async (e: Event) => {
      const detail = (e as CustomEvent).detail as { videoPath: string; startMs: number };
      if (!detail?.videoPath) return;
      try {
        await openVideoByPath(detail.videoPath);
        // openVideoByPath 内部可能用 lastPositionMs 覆盖了 initialSeek,
        // 这里再强制改回生词所在的句子起点
        setInitialSeek(detail.startMs);
      } catch (err: any) {
        // 常见:生词记录的视频被移走/删掉,toMediaUrl 或后续步骤抛错
        setToast(`打开原视频失败: ${err?.message || err}`);
      }
    };
    window.addEventListener('openAndSeek', handler as EventListener);
    return () => window.removeEventListener('openAndSeek', handler as EventListener);
  }, [openVideoByPath, setInitialSeek]);

  // ① 打开视频
  const pickVideo = async () => {
    const p = await window.api.pickVideo();
    if (!p) return;
    await openVideoByPath(p);
  };

  // ② 分离音频
  const doSplit = async () => {
    if (!videoPath) return;
    setBusy(true);
    setStep('split', 'running');
    try {
      const segs = await window.api.audioSplit(videoPath, 120);
      setSegments(segs);
      setStep('split', 'done');
      setToast(`音频已切成 ${segs.length} 段`);
    } catch (e: any) {
      setStep('split', 'error');
      setToast(`分离失败: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  // ③ 上传到 OSS
  const doUpload = async () => {
    if (!videoPath || !segments.length) return;
    setBusy(true);
    setStep('upload', 'running');
    try {
      const ups = await window.api.audioUpload(videoPath, segments, 3);
      setUploaded(ups);
      setStep('upload', 'done');
      setToast(`已上传 ${ups.length} 段到 OSS`);
    } catch (e: any) {
      setStep('upload', 'error');
      setToast(`上传失败: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  // ④ 字幕输出(只做 ASR)
  const doTranscribe = async () => {
    if (!videoPath || !uploaded.length) return;
    setBusy(true);
    setStep('asr', 'running');
    setStep('translate', 'idle');
    resetWorkerPanel('asr');
    setTab('progress');
    try {
      const { cues: out, srtPath } = await window.api.asrRun(videoPath, uploaded, {
        languageHints: ['en'],
        concurrency: 6,
      });
      setCues(out);
      setStep('asr', 'done');
      setTab('cue');
      setToast(`字幕已生成,共 ${out.length} 句 · ${srtPath.split('/').pop()}`);
    } catch (e: any) {
      setStep('asr', 'error');
      setToast(`识别失败: ${e?.message || e}`);
    } finally {
      setBusy(false);
      setTimeout(() => setProgress(null), 4000);
    }
  };

  // 🚀 一键处理: 打开视频 → 分离音频 → 上传 → 字幕输出(不翻译)
  // 每次点击都先弹出视频选择框,随后自动跑完整条 pipeline;已完成的步骤会跳过
  const doOneClick = async () => {
    const path = await window.api.pickVideo();
    if (!path) return;

    const url = await window.api.toMediaUrl(path);
    setVideo(path, url);

    // 恢复上次的 pipeline 状态,作为跳过已完成步骤的依据
    const state = await window.api.stateLoad(path);
    let segs: typeof segments = [];
    let ups: typeof uploaded = [];
    let splitDone = false;
    let uploadDone = false;
    let asrDone = false;
    if (state) {
      segs = state.segments;
      ups = state.uploaded;
      setSegments(segs);
      setUploaded(ups);
      setStep('split', state.steps.split);
      setStep('upload', state.steps.upload);
      setStep('asr', state.steps.asr);
      setStep('translate', state.steps.translate);
      if (state.lastPositionMs && state.lastPositionMs > 3000) {
        setInitialSeek(state.lastPositionMs);
      }
      splitDone = state.steps.split === 'done' && segs.length > 0;
      uploadDone = state.steps.upload === 'done' && ups.length > 0;
      asrDone = state.steps.asr === 'done';
    }

    setBusy(true);
    setTab('progress');
    try {
      if (!splitDone) {
        setStep('split', 'running');
        segs = await window.api.audioSplit(path, 120);
        setSegments(segs);
        setStep('split', 'done');
      }

      if (!uploadDone) {
        setStep('upload', 'running');
        ups = await window.api.audioUpload(path, segs, 3);
        setUploaded(ups);
        setStep('upload', 'done');
      }

      if (!asrDone) {
        setStep('asr', 'running');
        resetWorkerPanel('asr');
        const { cues: out, srtPath } = await window.api.asrRun(path, ups, {
          languageHints: ['en'],
          concurrency: 6,
        });
        setCues(out);
        setStep('asr', 'done');
        setToast(`一键处理完成,共 ${out.length} 句 · ${srtPath.split('/').pop()}`);
      } else {
        // 已全部完成,尝试加载已有 SRT 供播放
        const tryPaths = [
          state?.srtPath,
          path.replace(/\.[^.]+$/, '.bilingual.srt'),
          path.replace(/\.[^.]+$/, '.srt'),
        ].filter(Boolean) as string[];
        for (const srt of tryPaths) {
          try {
            const loaded = await window.api.loadSubtitle(srt);
            if (loaded.length) {
              setCues(loaded);
              break;
            }
          } catch {
            // ignore
          }
        }
        setToast('所有步骤已完成,已加载现有字幕');
      }
      setTab('cue');
    } catch (e: any) {
      if (!asrDone) setStep('asr', 'error');
      setToast(`一键处理失败: ${e?.message || e}`);
    } finally {
      setBusy(false);
      setTimeout(() => setProgress(null), 4000);
    }
  };

  // ⑤ 翻译输出(并发翻译现有 cues)
  const doTranslate = async () => {
    if (!videoPath || !cues.length) return;
    setBusy(true);
    setStep('translate', 'running');
    resetWorkerPanel('translate');
    setTab('progress');
    try {
      const { cues: out, srtPath } = await window.api.translateRun(videoPath, cues, {
        target: '中文',
        concurrency: 3,
      });
      setCues(out);
      setStep('translate', 'done');
      setTab('cue');
      setToast(`翻译完成,共 ${out.length} 句 · ${srtPath.split('/').pop()}`);
    } catch (e: any) {
      setStep('translate', 'error');
      setToast(`翻译失败: ${e?.message || e}`);
    } finally {
      setBusy(false);
      setTimeout(() => setProgress(null), 4000);
    }
  };

  const addWord = useCallback(
    async (
      word: string,
      context: string,
      cueId: number,
      explanation?: {
        phonetic?: string;
        pos?: string;
        meaning?: string;
        contextual?: string;
      }
    ) => {
      const cue = cues.find((c) => c.id === cueId);
      // translation 字段保留兼容旧数据:优先 AI 释义,其次整句翻译
      const translation =
        [explanation?.pos, explanation?.meaning].filter(Boolean).join(' ').trim() ||
        explanation?.contextual ||
        cue?.translation;
      await window.api.wordAdd({
        word,
        context,
        translation,
        videoPath: videoPath || undefined,
        sentenceStartMs: cue?.startMs,
        sentenceEndMs: cue?.endMs,
        phonetic: explanation?.phonetic,
        pos: explanation?.pos,
        meaning: explanation?.meaning,
        contextual: explanation?.contextual,
      });
      setWordRefresh((k) => k + 1);
      setToast(`已加入生词本: ${word}`);
    },
    [cues, videoPath]
  );

  const canSplit = !!videoPath && !busy && steps.split !== 'done';
  const canUpload = !!segments.length && !busy && steps.upload !== 'done';
  const canTranscribe = !!uploaded.length && !busy && steps.asr !== 'done';
  const canTranslate = !!cues.length && !busy && steps.translate !== 'done';

  return (
    <div className="app">
      <div className="topbar">
        <div className="title">🎬 Video Learner</div>

        <button
          className="step-btn"
          onClick={() => setYtdlpOpen(true)}
          title="生成 yt-dlp 下载命令(使用浏览器 Cookie)"
        >
          ⬇ 下载视频
        </button>

        <button
          className="step-btn"
          onClick={() => setSplitOpen(true)}
          disabled={busy}
          title="按固定时长(默认 10 分钟)把长视频切成多段"
        >
          ✂ 分割视频
        </button>

        <button
          className="step-btn"
          onClick={doOneClick}
          disabled={busy}
          title="一键处理: 分离音频 → 上传 → 字幕输出(不翻译)。未打开视频时会先弹出选择框。"
        >
          🚀 一键处理
        </button>

        <button className="step-btn" onClick={pickVideo} disabled={busy} title="选择本地视频">
          <span className="num">①</span> 打开视频
        </button>

        <button
          className={`step-btn ${steps.split === 'done' ? 'step-done' : ''}`}
          onClick={doSplit}
          disabled={!canSplit}
          title={steps.split === 'done' ? '已完成,如需重跑请先点「重置」' : '本地 FFmpeg 把音频切成 10 分钟一段'}
        >
          <StepIcon status={steps.split} />
          <span className="num">②</span> 分离音频
          {steps.split === 'done' && <span className="badge">{segments.length} 段</span>}
        </button>

        <button
          className={`step-btn ${steps.upload === 'done' ? 'step-done' : ''}`}
          onClick={doUpload}
          disabled={!canUpload}
          title={steps.upload === 'done' ? '已完成,如需重跑请先点「重置」' : '并发上传到阿里云 OSS'}
        >
          <StepIcon status={steps.upload} />
          <span className="num">③</span> 上传
          {steps.upload === 'done' && <span className="badge">{uploaded.length}/{segments.length}</span>}
        </button>

        <button
          className={`step-btn ${steps.asr === 'done' ? 'step-done' : ''}`}
          onClick={doTranscribe}
          disabled={!canTranscribe}
          title={steps.asr === 'done' ? '已完成,如需重跑请先点「重置」' : '并发 ASR,输出英文 SRT'}
        >
          <StepIcon status={steps.asr} />
          <span className="num">④</span> 字幕输出
          {steps.asr === 'done' && <span className="badge">{cues.length} 句</span>}
        </button>

        <button
          className={`step-btn ${steps.translate === 'done' ? 'step-done' : ''}`}
          onClick={doTranslate}
          disabled={!canTranslate}
          title={steps.translate === 'done' ? '已完成,如需重跑请先点「重置」' : '并发 qwen-turbo 翻译,输出双语 SRT'}
        >
          <StepIcon status={steps.translate} />
          <span className="num">⑤</span> 翻译输出
          {steps.translate === 'done' && <span className="badge">已翻译</span>}
        </button>

        <button onClick={() => setSettingsOpen(true)}>⚙ 设置</button>
      </div>

      <Player onAddWord={addWord} onDropVideo={openVideoByPath} />

      <div className="sidebar">
        <div className="tabs">
          <div className={`tab ${tab === 'cue' ? 'active' : ''}`} onClick={() => setTab('cue')}>
            字幕 ({cues.length})
          </div>
          <div className={`tab ${tab === 'progress' ? 'active' : ''}`} onClick={() => setTab('progress')}>
            进度
          </div>
          <div className={`tab ${tab === 'word' ? 'active' : ''}`} onClick={() => setTab('word')}>
            生词本
          </div>
        </div>
        <div className="tab-content">
          {tab === 'cue' && <CueList />}
          {tab === 'progress' && <ProgressPanel />}
          {tab === 'word' && <WordBook refreshKey={wordRefresh} />}
        </div>
      </div>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {ytdlpOpen && <YtDlpModal onClose={() => setYtdlpOpen(false)} />}
      {splitOpen && <VideoSplitModal onClose={() => setSplitOpen(false)} />}

      {(progress || toast) && (
        <div className="toast">
          {progress ? (
            <>
              <strong>[{progress.stage}]</strong> {progress.message}
              {progress.percent != null && ` (${progress.percent}%)`}
            </>
          ) : (
            toast
          )}
        </div>
      )}
    </div>
  );
}
