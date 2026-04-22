import { useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../store/player';
import { speakViaTTS, getSentenceSpeed } from '../utils/tts';

export function CueList() {
  const { cues, activeCueId, videoPath, setLoop, updateCueTranslation, updateCue } = usePlayerStore();
  const listRef = useRef<HTMLDivElement>(null);
  const [translatingId, setTranslatingId] = useState<number | null>(null);
  // 正在朗读的 cueId: 防止连点 & 给按钮切换加载态
  const [speakingId, setSpeakingId] = useState<number | null>(null);
  // 当前正在编辑的 cueId;null 表示没有在编辑
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editEn, setEditEn] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);

  // textarea 根据内容自适应高度
  const autoResize = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };

  // 打开编辑器或切换编辑目标时,撑开到内容高度
  useEffect(() => {
    if (editingId !== null) autoResize(editTextareaRef.current);
  }, [editingId]);

  const startEdit = (cueId: number) => {
    const cue = cues.find((c) => c.id === cueId);
    if (!cue) return;
    setEditingId(cueId);
    setEditEn(cue.text || '');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditEn('');
  };

  const saveEdit = async (cueId: number) => {
    const text = editEn.trim();
    if (!text) {
      alert('英文字幕不能为空');
      return;
    }
    setSavingEdit(true);
    try {
      updateCue(cueId, { text });
      if (videoPath) {
        const latest = usePlayerStore.getState().cues;
        try {
          await window.api.saveSubtitle(videoPath, latest, '.bilingual');
        } catch (err) {
          console.warn('写入双语 SRT 失败:', err);
        }
      }
      cancelEdit();
    } finally {
      setSavingEdit(false);
    }
  };

  const speakCue = async (cueId: number, text: string) => {
    if (!text?.trim()) return;
    const speed = await getSentenceSpeed();
    setSpeakingId(cueId);
    await speakViaTTS(text, {
      speed,
      language: 'en',
      onDone: () => setSpeakingId((cur) => (cur === cueId ? null : cur)),
    });
  };

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
              🔁 复读
            </button>
            <button
              disabled={speakingId === c.id}
              title="AI 复读此句 (Qwen-TTS)"
              onClick={(e) => {
                e.stopPropagation();
                speakCue(c.id, c.text);
              }}
            >
              {speakingId === c.id ? (
                <>
                  <span className="tts-spinner" aria-label="loading" /> AI 复读
                </>
              ) : (
                '🔊 AI 复读'
              )}
            </button>
            <button
              disabled={translatingId === c.id}
              onClick={(e) => {
                e.stopPropagation();
                translateOne(c.id);
              }}
              title={c.translation ? '重新翻译此句' : '翻译此句并写入中文字幕'}
            >
              {translatingId === c.id ? (
                <>
                  <span className="tts-spinner" aria-label="loading" /> 翻译
                </>
              ) : c.translation ? (
                '🌐 重翻'
              ) : (
                '🌐 翻译'
              )}
            </button>
            <button
              disabled={editingId === c.id}
              onClick={(e) => {
                e.stopPropagation();
                startEdit(c.id);
              }}
              title="编辑此句的英文字幕"
            >
              ✏️ 编辑
            </button>
          </div>

          {editingId === c.id && (
            <div className="cue-edit" onClick={(e) => e.stopPropagation()}>
              <textarea
                ref={editTextareaRef}
                className="cue-edit-input"
                value={editEn}
                onChange={(e) => {
                  setEditEn(e.target.value);
                  autoResize(e.currentTarget);
                }}
                rows={1}
                placeholder="英文字幕"
                autoFocus
              />
              <div className="cue-edit-buttons">
                <button disabled={savingEdit} onClick={() => saveEdit(c.id)}>
                  {savingEdit ? '⋯ 保存中' : '💾 保存'}
                </button>
                <button disabled={savingEdit} onClick={cancelEdit}>
                  取消
                </button>
              </div>
            </div>
          )}
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
