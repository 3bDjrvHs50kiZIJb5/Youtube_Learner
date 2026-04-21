import { RefObject, useEffect, useState } from 'react';
import { usePlayerStore } from '../store/player';

function fmt(sec: number): string {
  if (!isFinite(sec)) return '00:00';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(r).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function ControlBar({ videoRef }: { videoRef: RefObject<HTMLVideoElement> }) {
  const {
    cues,
    activeCueId,
    showEnglish,
    showTranslation,
    loopCueId,
    autoPauseAtSentenceEnd,
    toggleEnglish,
    toggleTranslation,
    setLoop,
    toggleAutoPause,
  } = usePlayerStore();

  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTime = () => setCurrent(v.currentTime);
    const onMeta = () => setDuration(v.duration);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('loadedmetadata', onMeta);
    return () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('loadedmetadata', onMeta);
    };
  }, [videoRef]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  };

  const seekBy = (delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + delta));
  };

  const jumpCue = (dir: -1 | 1) => {
    const v = videoRef.current;
    if (!v || !cues.length) return;

    // 不能只靠 activeCueId:视频未播放 / 当前时间落在两句缝隙时,它是 null。
    // 以视频当前时间为准,反推"隐含的当前 cue 索引",再加方向偏移。
    let curIdx = cues.findIndex((c) => c.id === activeCueId);
    if (curIdx < 0) {
      const ms = v.currentTime * 1000;
      if (ms < cues[0].startMs) {
        curIdx = dir > 0 ? -1 : 0;
      } else {
        curIdx = cues.length - 1;
        for (let i = 0; i < cues.length; i++) {
          if (cues[i].startMs > ms) {
            curIdx = i - 1;
            break;
          }
        }
      }
    }
    const idx = Math.max(0, Math.min(cues.length - 1, curIdx + dir));
    const target = cues[idx];
    if (target) v.currentTime = target.startMs / 1000;
  };

  const toggleLoopCurrent = () => {
    if (loopCueId !== null) setLoop(null);
    else if (activeCueId !== null) setLoop(activeCueId, -1);
  };

  const changeRate = (r: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = r;
    setRate(r);
  };

  const onSeekClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const v = videoRef.current;
    if (!v || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    v.currentTime = duration * ratio;
  };

  // 键盘快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.code) {
        case 'Space':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          seekBy(-3);
          break;
        case 'ArrowRight':
          seekBy(3);
          break;
        case 'KeyA':
          jumpCue(-1);
          break;
        case 'KeyD':
          jumpCue(1);
          break;
        case 'KeyR':
          toggleLoopCurrent();
          break;
        case 'KeyE':
          toggleEnglish();
          break;
        case 'KeyZ':
          toggleTranslation();
          break;
        case 'KeyP':
          toggleAutoPause();
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  return (
    <div className="controls">
      <div className="row">
        <div className="progress-bar" onClick={onSeekClick}>
          <div className="fill" style={{ width: duration ? `${(current / duration) * 100}%` : '0%' }} />
        </div>
        <div className="time">
          {fmt(current)} / {fmt(duration)}
        </div>
      </div>
      <div className="row">
        <button onClick={() => jumpCue(-1)} title="上一句 (A)">⏮</button>
        <button className="primary" onClick={togglePlay} title="播放/暂停 (Space)">
          {playing ? '暂停' : '播放'}
        </button>
        <button onClick={() => jumpCue(1)} title="下一句 (D)">⏭</button>

        <span
          className={`chip ${loopCueId !== null ? 'active' : ''}`}
          onClick={toggleLoopCurrent}
          title="整句复读 (R)"
        >
          🔁 复读
        </span>
        <span
          className={`chip ${autoPauseAtSentenceEnd ? 'active' : ''}`}
          onClick={toggleAutoPause}
          title="精读模式:句末自动暂停 (P)"
        >
          ⏸ 精读
        </span>
        <span className={`chip ${showEnglish ? 'active' : ''}`} onClick={toggleEnglish} title="E">
          EN
        </span>
        <span
          className={`chip ${showTranslation ? 'active' : ''}`}
          onClick={toggleTranslation}
          title="Z"
        >
          中文
        </span>

        <select value={rate} onChange={(e) => changeRate(+e.target.value)}>
          {[0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2].map((r) => (
            <option key={r} value={r}>
              {r}x
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
