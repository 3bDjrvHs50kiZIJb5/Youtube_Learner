import { useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../store/player';
import { speakViaTTS, getSentenceSpeed } from '../utils/tts';
import { getVideoTimeMs } from '../hooks/videoTime';
import type { SubtitleWord } from '../types';

export function CueList() {
  const {
    cues,
    activeCueId,
    videoPath,
    updateCueTranslation,
    updateCue,
    setActiveCue,
    setEditingCue,
  } = usePlayerStore();
  const listRef = useRef<HTMLDivElement>(null);
  const [translatingId, setTranslatingId] = useState<number | null>(null);
  // 正在朗读的 cueId: 防止连点 & 给按钮切换加载态
  const [speakingId, setSpeakingId] = useState<number | null>(null);
  // 当前正在编辑的 cueId;null 表示没有在编辑
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editEn, setEditEn] = useState('');
  // 编辑中的起止时间(ms);和 editEn 同时编辑,保存时一起写入
  const [editStartMs, setEditStartMs] = useState(0);
  const [editEndMs, setEditEndMs] = useState(0);
  // 时间输入框的本地缓冲,允许用户自由输入"半成品"字符串,失焦/回车时再解析回 ms。
  const [startInput, setStartInput] = useState('');
  const [endInput, setEndInput] = useState('');
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

  useEffect(() => {
    return () => setEditingCue(null);
  }, [setEditingCue]);

  const startEdit = (cueId: number) => {
    const cue = cues.find((c) => c.id === cueId);
    if (!cue) return;
    setEditingId(cueId);
    setEditingCue(cueId);
    setActiveCue(cueId);
    setEditEn(cue.text || '');
    setEditStartMs(cue.startMs);
    setEditEndMs(cue.endMs);
    setStartInput(formatTimeMs(cue.startMs));
    setEndInput(formatTimeMs(cue.endMs));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingCue(null);
    setEditEn('');
    setEditStartMs(0);
    setEditEndMs(0);
    setStartInput('');
    setEndInput('');
  };

  // 把 ms 变化同步回输入框文本(按钮微调 / ⏺用当前 时触发)
  const setStart = (ms: number) => {
    const v = Math.max(0, Math.round(ms));
    setEditStartMs(v);
    setStartInput(formatTimeMs(v));
  };
  const setEnd = (ms: number) => {
    const v = Math.max(0, Math.round(ms));
    setEditEndMs(v);
    setEndInput(formatTimeMs(v));
  };

  // 失焦 / 回车时,把文本框的文本解析回 ms;解析失败则 snap 回上次有效值
  const commitStartInput = () => {
    const v = parseTimeMs(startInput);
    if (v !== null) setStart(v);
    else setStartInput(formatTimeMs(editStartMs));
  };
  const commitEndInput = () => {
    const v = parseTimeMs(endInput);
    if (v !== null) setEnd(v);
    else setEndInput(formatTimeMs(editEndMs));
  };

  const resolveDraftRange = () => {
    const parsedStart = parseTimeMs(startInput);
    const parsedEnd = parseTimeMs(endInput);
    return {
      startMs: Math.max(0, Math.round(parsedStart !== null ? parsedStart : editStartMs)),
      endMs: Math.max(0, Math.round(parsedEnd !== null ? parsedEnd : editEndMs)),
      startValid: parsedStart !== null,
      endValid: parsedEnd !== null,
    };
  };

  /**
   * 把原区间 [oldStart, oldEnd] 里的字级时间戳线性映射到新区间 [newStart, newEnd]。
   * 如果用户只是整体平移(首尾差一样),等价于统一偏移;如果拉伸/压缩,字级时间也会被按比例压扁/拉长,
   * 这样 karaoke 高亮不会整体错位。
   */
  const scaleWords = (
    words: SubtitleWord[] | undefined,
    oldStart: number,
    oldEnd: number,
    newStart: number,
    newEnd: number
  ): SubtitleWord[] | undefined => {
    if (!words || !words.length) return words;
    const oldSpan = oldEnd - oldStart;
    // 原区间退化(理论不该出现),用纯偏移兜底
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

  const saveEdit = async (cueId: number) => {
    const text = editEn.trim();
    if (!text) {
      alert('英文字幕不能为空');
      return;
    }
    // 用户可能没让时间输入框失焦就直接点保存,优先解析当前文本框里的值
    const { startMs: newStart, endMs: newEnd } = resolveDraftRange();
    if (newEnd <= newStart) {
      alert('终点时间必须大于起点时间');
      return;
    }
    const cueIndex = cues.findIndex((c) => c.id === cueId);
    if (cueIndex === -1) return;
    const cue = cues[cueIndex];
    if (!cue) return;
    const scaledWords = scaleWords(cue.words, cue.startMs, cue.endMs, newStart, newEnd);

    setSavingEdit(true);
    try {
      updateCue(cueId, {
        text,
        startMs: newStart,
        endMs: newEnd,
        words: scaledWords,
      });
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

  const nudgeStart = (delta: number) => setStart(editStartMs + delta);
  const nudgeEnd = (delta: number) => setEnd(editEndMs + delta);
  const useCurrentAsStart = () => setStart(getVideoTimeMs());
  const useCurrentAsEnd = () => setEnd(getVideoTimeMs());

  const previewEditRange = () => {
    const {
      startMs: previewStartMs,
      endMs: previewEndMs,
      startValid,
      endValid,
    } = resolveDraftRange();
    if (!startValid) setStartInput(formatTimeMs(editStartMs));
    if (!endValid) setEndInput(formatTimeMs(editEndMs));
    if (previewEndMs <= previewStartMs) return;
    setEditStartMs(previewStartMs);
    setEditEndMs(previewEndMs);
    setStartInput(formatTimeMs(previewStartMs));
    setEndInput(formatTimeMs(previewEndMs));
    window.dispatchEvent(
      new CustomEvent('previewCueRange', {
        detail: { startMs: previewStartMs, endMs: previewEndMs },
      })
    );
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

  const jump = (cue: { startMs: number; text: string; words?: SubtitleWord[] }) => {
    const shouldEnableAutoPause = countCueWords(cue) >= 10;
    // fromCueList: 标识这次跳转来自右侧字幕列表,Player 据此决定这次点击
    // 是否要自动切到精读,让较长句子播到句末自动停住。
    window.dispatchEvent(
      new CustomEvent('seekToCue', {
        detail: {
          startMs: cue.startMs,
          play: true,
          fromCueList: true,
          enableAutoPause: shouldEnableAutoPause,
        },
      })
    );
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

  const {
    startMs: previewStartMs,
    endMs: previewEndMs,
    startValid: isPreviewStartValid,
    endValid: isPreviewEndValid,
  } = resolveDraftRange();
  const canPreview =
    isPreviewStartValid && isPreviewEndValid && previewEndMs > previewStartMs;

  return (
    <div className="cue-list" ref={listRef}>
      {cues.map((c) => (
        <div
          key={c.id}
          data-cue-id={c.id}
          className={`cue-item ${c.id === activeCueId ? 'active' : ''}`}
          onClick={() => jump(c)}
        >
          <div className="time">
            {formatTimeMs(c.startMs)} — {formatTimeMs(c.endMs)}
          </div>
          <div className="en">{c.text}</div>
          {c.translation && <div className="zh">{c.translation}</div>}
          <div className="actions">
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

              <div className="cue-edit-time-row">
                <span className="cue-edit-time-label">起点</span>
                <input
                  type="text"
                  className="cue-edit-time-input"
                  value={startInput}
                  onChange={(e) => setStartInput(e.target.value)}
                  onBlur={commitStartInput}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                  }}
                  placeholder="00:00.000"
                />
                <button onClick={() => nudgeStart(-500)} title="提前 500ms">−500</button>
                <button onClick={() => nudgeStart(500)} title="延后 500ms">+500</button>
                <button onClick={useCurrentAsStart} title="用当前视频时间作为起点">
                  ⏺ 用当前
                </button>
              </div>

              <div className="cue-edit-time-row">
                <span className="cue-edit-time-label">终点</span>
                <input
                  type="text"
                  className="cue-edit-time-input"
                  value={endInput}
                  onChange={(e) => setEndInput(e.target.value)}
                  onBlur={commitEndInput}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                  }}
                  placeholder="00:00.000"
                />
                <button onClick={() => nudgeEnd(-500)} title="提前 500ms">−500</button>
                <button onClick={() => nudgeEnd(500)} title="延后 500ms">+500</button>
                <button onClick={useCurrentAsEnd} title="用当前视频时间作为终点">
                  ⏺ 用当前
                </button>
              </div>

              <div className="cue-edit-buttons">
                <button disabled={savingEdit} onClick={() => saveEdit(c.id)}>
                  {savingEdit ? '⋯ 保存中' : '💾 保存'}
                </button>
                <button
                  disabled={savingEdit || !canPreview}
                  onClick={previewEditRange}
                  title="按当前起止时间试听这一段"
                >
                  ▶ 试听
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

// 带毫秒的可读时间,用于精细时间编辑框 (MM:SS.mmm)
function formatTimeMs(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const totalSec = Math.floor(safe / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const mss = safe % 1000;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(mss).padStart(3, '0')}`;
}

/**
 * 宽松地把用户输入解析成毫秒。支持:
 *  - "123"          → 123ms
 *  - "1.5"          → 1500ms (按秒解释)
 *  - "12.345"       → 12345ms (按秒解释)
 *  - "01:23"        → 1m23s
 *  - "01:23.456"    → 1m23s456ms
 *  - "1:02:03.4"    → 1h2m3.4s
 * 解析失败返回 null。
 */
function parseTimeMs(input: string): number | null {
  const s = input.trim();
  if (!s) return 0;
  if (!s.includes(':')) {
    const n = Number(s);
    if (!isFinite(n)) return null;
    return s.includes('.') ? Math.round(n * 1000) : Math.round(n);
  }
  const parts = s.split(':');
  if (parts.length > 3) return null;
  const tail = Number(parts[parts.length - 1]);
  if (!isFinite(tail)) return null;
  let total = Math.round(tail * 1000);
  if (parts.length >= 2) {
    const mins = Number(parts[parts.length - 2]);
    if (!isFinite(mins)) return null;
    total += mins * 60_000;
  }
  if (parts.length === 3) {
    const hours = Number(parts[0]);
    if (!isFinite(hours)) return null;
    total += hours * 3_600_000;
  }
  return total < 0 ? null : total;
}

function countCueWords(cue: { text: string; words?: SubtitleWord[] }): number {
  if (cue.words?.length) return cue.words.length;
  const matches = cue.text.match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g);
  return matches?.length ?? 0;
}
