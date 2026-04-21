import { useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../store/player';

export function CueList() {
  const { cues, activeCueId, videoPath, setLoop, updateCueTranslation } = usePlayerStore();
  const listRef = useRef<HTMLDivElement>(null);
  const [translatingId, setTranslatingId] = useState<number | null>(null);

  useEffect(() => {
    if (activeCueId === null) return;
    const el = listRef.current?.querySelector(`[data-cue-id="${activeCueId}"]`) as HTMLElement | null;
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeCueId]);

  const jump = (startMs: number) => {
    window.dispatchEvent(new CustomEvent('seekToCue', { detail: { startMs, play: true } }));
  };

  const translateOne = async (cueId: number) => {
    const cue = cues.find((c) => c.id === cueId);
    if (!cue) return;
    setTranslatingId(cueId);
    try {
      const out = await window.api.translateSubtitle([cue], '中文');
      const translated = out?.[0]?.translation?.trim();
      if (!translated) throw new Error('翻译结果为空');
      updateCueTranslation(cueId, translated);

      // 立即把最新状态写入 .bilingual.srt,避免刷新丢失
      if (videoPath) {
        const latest = usePlayerStore.getState().cues;
        try {
          await window.api.saveSubtitle(videoPath, latest, '.bilingual');
        } catch (err) {
          console.warn('写入双语 SRT 失败:', err);
        }
      }
    } catch (err: any) {
      alert(`翻译失败: ${err?.message || err}`);
    } finally {
      setTranslatingId(null);
    }
  };

  if (!cues.length) {
    return <div className="cue-list" style={{ color: 'var(--muted)', padding: 16 }}>暂无字幕，点顶部「生成字幕」开始。</div>;
  }

  return (
    <div className="cue-list" ref={listRef}>
      {cues.map((c) => (
        <div
          key={c.id}
          data-cue-id={c.id}
          className={`cue-item ${c.id === activeCueId ? 'active' : ''}`}
          onClick={() => jump(c.startMs)}
        >
          <div className="time">
            {formatTime(c.startMs)} — {formatTime(c.endMs)}
          </div>
          <div className="en">{c.text}</div>
          {c.translation && <div className="zh">{c.translation}</div>}
          <div className="actions">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setLoop(c.id, -1);
                jump(c.startMs);
              }}
            >
              🔁 复读此句
            </button>
            <button
              disabled={translatingId === c.id}
              onClick={(e) => {
                e.stopPropagation();
                translateOne(c.id);
              }}
              title={c.translation ? '重新翻译此句' : '翻译此句并写入中文字幕'}
            >
              {translatingId === c.id ? '⋯ 翻译中' : c.translation ? '🈯 重新翻译' : '🈯 翻译此句'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}
