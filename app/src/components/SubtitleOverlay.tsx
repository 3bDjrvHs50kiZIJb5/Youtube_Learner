import { useEffect, useMemo, useRef, useState } from 'react';
import { usePlayerStore } from '../store/player';
import { subscribeVideoTime } from '../hooks/videoTime';
import type { SubtitleCue, SubtitleWord } from '../types';

interface Props {
  onAddWord: (word: string, context: string, cueId: number) => void;
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

export function SubtitleOverlay({ onAddWord }: Props) {
  const { cues, activeCueId, showEnglish, showTranslation } = usePlayerStore();
  const [popover, setPopover] = useState<{ word: string; cueId: number; x: number; y: number } | null>(
    null
  );

  const cur: SubtitleCue | undefined = useMemo(
    () => cues.find((c) => c.id === activeCueId),
    [cues, activeCueId]
  );
  if (!cur) return null;

  const handleWordClick = (word: string, cueId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    setPopover({
      word: word.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/gi, ''),
      cueId,
      x: rect.left,
      y: rect.top - 44,
    });
  };

  return (
    <>
      <div className="subtitle-overlay" onClick={() => setPopover(null)}>
        {showEnglish && (
          <div>
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
          <span className="w">{popover.word}</span>
          <button
            className="primary"
            onClick={() => {
              onAddWord(popover.word, cur.text, popover.cueId);
              setPopover(null);
            }}
          >
            加入生词本
          </button>
          <button className="ghost" onClick={() => setPopover(null)}>×</button>
        </div>
      )}
    </>
  );
}
