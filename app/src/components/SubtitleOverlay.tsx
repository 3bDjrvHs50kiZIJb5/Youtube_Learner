import { useEffect, useMemo, useRef, useState } from 'react';
import { usePlayerStore } from '../store/player';
import { subscribeVideoTime } from '../hooks/videoTime';
import { speakViaTTS, getSentenceSpeed } from '../utils/tts';
import type { SubtitleCue, SubtitleWord, WordExplanation } from '../types';

interface Props {
  onAddWord: (
    word: string,
    context: string,
    cueId: number,
    explanation?: {
      phonetic?: string;
      pos?: string;
      meaning?: string;
      contextual?: string;
    }
  ) => void;
}

/** 没有字级时间戳时,按空格/标点 fallback 切分英文句子 */
function tokenizeFallback(text: string): Array<{ token: string; isWord: boolean }> {
  const out: Array<{ token: string; isWord: boolean }> = [];
  const regex = /([A-Za-z][A-Za-z'-]*)|(\s+)|([^A-Za-z\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m[1]) out.push({ token: m[1], isWord: true });
    else out.push({ token: m[0], isWord: false });
  }
  return out;
}

/**
 * 把 cue.words 渲染成一串 <span.kw>,
 * 并在 useEffect 里直接通过 DOM ref 随 rAF 时钟更新
 * 状态(已读/进行中/未读)与内部 karaoke 填色百分比,
 * 避免每帧 re-render。
 */
function KaraokeLine({
  words,
  onWordClick,
}: {
  words: SubtitleWord[];
  onWordClick: (word: string, e: React.MouseEvent) => void;
}) {
  const wordRefs = useRef<Array<HTMLSpanElement | null>>([]);
  // words 变化时(换句)把长度对齐
  wordRefs.current.length = words.length;

  useEffect(() => {
    // 每次 words 变化重置一次状态,防止残留
    for (const el of wordRefs.current) {
      if (!el) continue;
      el.classList.remove('kw--active', 'kw--passed');
      el.style.setProperty('--kw-progress', '0');
    }
    // KARAOKE_LEAD_MS: 视觉补偿。<video> 的 currentTime 相对实际音画渲染会有
    // 几十毫秒的管线延迟(Chromium/Electron 不同机器差异不小),订阅时稍微往
    // 前探一点,让字幕填色刚好压在听到的音节上而不是慢半拍。
    // 如果在你的机器上感觉"过快/滑过头",把它调小或设 0 即可。
    const KARAOKE_LEAD_MS = 120;
    const unsub = subscribeVideoTime((rawMs) => {
      const ms = rawMs + KARAOKE_LEAD_MS;
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const el = wordRefs.current[i];
        if (!el) continue;
        if (ms >= w.endMs) {
          if (!el.classList.contains('kw--passed')) {
            el.classList.add('kw--passed');
            el.classList.remove('kw--active');
            el.style.setProperty('--kw-progress', '1');
          }
        } else if (ms >= w.startMs) {
          const total = Math.max(1, w.endMs - w.startMs);
          const ratio = Math.min(1, Math.max(0, (ms - w.startMs) / total));
          if (!el.classList.contains('kw--active')) {
            el.classList.add('kw--active');
            el.classList.remove('kw--passed');
          }
          // scaleX(0~1),不走 transition,rAF 每帧直写,不会慢半拍
          el.style.setProperty('--kw-progress', ratio.toFixed(4));
        } else {
          if (el.classList.contains('kw--active') || el.classList.contains('kw--passed')) {
            el.classList.remove('kw--active', 'kw--passed');
            el.style.setProperty('--kw-progress', '0');
          }
        }
      }
    });
    return unsub;
  }, [words]);

  return (
    <>
      {words.map((w, i) => {
        // 词之间塞一个普通空格(英文)。中文逐字就没空格,自然拼接。
        const needSpace = i > 0 && /[A-Za-z]$/.test(words[i - 1].text) && /^[A-Za-z]/.test(w.text);
        return (
          <span key={i}>
            {needSpace && ' '}
            <span
              className="kw word"
              ref={(el) => {
                wordRefs.current[i] = el;
              }}
              onClick={(e) => onWordClick(w.text, e)}
            >
              <span className="kw-bg">{w.text}</span>
              <span className="kw-clip" aria-hidden="true">
                <span className="kw-fg">{w.text}</span>
              </span>
            </span>
            {w.punctuation ? <span className="kw-punct">{w.punctuation}</span> : null}
          </span>
        );
      })}
    </>
  );
}

interface PopoverState {
  word: string;
  cueId: number;
  context: string;
  x: number;
  y: number;
}

export function SubtitleOverlay({ onAddWord }: Props) {
  const { cues, activeCueId, showEnglish, showTranslation } = usePlayerStore();
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const [explanation, setExplanation] = useState<WordExplanation | null>(null);
  const [explainLoading, setExplainLoading] = useState(false);
  const [explainError, setExplainError] = useState<string | null>(null);
  // 正在朗读当前字幕: 用来把按钮切成"停止/加载"态
  const [speaking, setSpeaking] = useState(false);

  const cur: SubtitleCue | undefined = useMemo(
    () => cues.find((c) => c.id === activeCueId),
    [cues, activeCueId]
  );

  // 打开新的 popover 时自动请求 AI 解释;切换单词需要取消上一个请求的回写
  useEffect(() => {
    if (!popover) {
      setExplanation(null);
      setExplainError(null);
      setExplainLoading(false);
      return;
    }
    let cancelled = false;
    setExplanation(null);
    setExplainError(null);
    setExplainLoading(true);
    window.api
      .wordExplain(popover.word, popover.context)
      .then((res) => {
        if (cancelled) return;
        setExplanation(res);
        setExplainLoading(false);
      })
      .catch((err: any) => {
        if (cancelled) return;
        setExplainError(err?.message || '解释失败');
        setExplainLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [popover?.word, popover?.cueId]);

  // 切换字幕时,状态自动重置 (正在朗读的那条会被 speakViaTTS 自己打断)
  // 注意: 这个 Hook 必须放在任何 early return 之前, 否则切字幕时 Hooks 数量变化会抛
  // "Rendered more hooks than during the previous render"
  useEffect(() => {
    setSpeaking(false);
  }, [cur?.id]);

  if (!cur) return null;

  const handleSpeakCue = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!cur?.text) return;
    const speed = await getSentenceSpeed();
    setSpeaking(true);
    await speakViaTTS(cur.text, {
      speed,
      language: 'en',
      onDone: () => setSpeaking(false),
    });
  };

  const handleWordClick = (word: string, cueId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    const cleanWord = word.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/gi, '');
    if (!cleanWord) return;
    // 用 fixed 定位 + 视口坐标,popover 可以跨越 stage 边界而不偏位
    setPopover({
      word: cleanWord,
      cueId,
      context: cur.text,
      x: rect.left + rect.width / 2,
      y: rect.top,
    });
  };


  return (
    <>
      <div className="subtitle-overlay" onClick={() => setPopover(null)}>
        {showEnglish && (
          <div className="subtitle-en-wrap">
            <div className="line en">
              {cur.words && cur.words.length > 0 ? (
                <KaraokeLine
                  words={cur.words}
                  onWordClick={(w, e) => handleWordClick(w, cur.id, e)}
                />
              ) : (
                // 没有字级时间戳(老字幕),走原始 fallback 渲染
                tokenizeFallback(cur.text).map((t, i) =>
                  t.isWord ? (
                    <span
                      key={i}
                      className="word"
                      onClick={(e) => handleWordClick(t.token, cur.id, e)}
                    >
                      {t.token}
                    </span>
                  ) : (
                    <span key={i}>{t.token}</span>
                  )
                )
              )}
            </div>
            <button
              className="ghost icon-btn subtitle-speak-btn"
              title="朗读当前字幕 (Qwen-TTS)"
              onClick={handleSpeakCue}
              disabled={speaking}
            >
              {speaking ? '⏳' : '🔊'}
            </button>
          </div>
        )}
        {showTranslation && cur.translation && (
          <div>
            <div className="line zh">{cur.translation}</div>
          </div>
        )}
      </div>

      {popover && (
        <div
          className="word-popover"
          style={{ left: popover.x, top: popover.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="word-popover-head">
            <span className="w">{popover.word}</span>
            {explanation?.phonetic && (
              <span className="phonetic">{explanation.phonetic}</span>
            )}
            {explanation?.pos && <span className="pos">{explanation.pos}</span>}
            <button
              className="ghost close-x"
              onClick={() => setPopover(null)}
              title="关闭"
            >
              ×
            </button>
          </div>

          <div className="word-popover-body">
            {explainLoading && <div className="hint">正在查询解释…</div>}
            {explainError && <div className="hint err">解释失败: {explainError}</div>}
            {explanation && !explainLoading && !explainError && (
              <>
                {explanation.meaning && (
                  <div className="meaning">{explanation.meaning}</div>
                )}
                {explanation.contextual && (
                  <div className="contextual">
                    <span className="tag">语境</span>
                    {explanation.contextual}
                  </div>
                )}
                {!explanation.meaning && !explanation.contextual && (
                  <div className="hint">未获得有效解释</div>
                )}
              </>
            )}
          </div>

          <div className="word-popover-foot">
            <button
              className="primary"
              onClick={() => {
                onAddWord(
                  popover.word,
                  popover.context,
                  popover.cueId,
                  explanation
                    ? {
                        phonetic: explanation.phonetic,
                        pos: explanation.pos,
                        meaning: explanation.meaning,
                        contextual: explanation.contextual,
                      }
                    : undefined
                );
                setPopover(null);
              }}
            >
              加入生词本
            </button>
          </div>
        </div>
      )}
    </>
  );
}
