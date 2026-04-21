import { useEffect, useState } from 'react';
import type { WordEntry } from '../types';

export function WordBook({ refreshKey }: { refreshKey: number }) {
  const [words, setWords] = useState<WordEntry[]>([]);

  useEffect(() => {
    window.api.wordList().then(setWords);
  }, [refreshKey]);

  const del = async (id: number) => {
    await window.api.wordDelete(id);
    setWords((s) => s.filter((w) => w.id !== id));
  };

  const jumpTo = (w: WordEntry) => {
    if (w.sentenceStartMs == null) return;
    window.dispatchEvent(new CustomEvent('seekToCue', { detail: { startMs: w.sentenceStartMs, play: true } }));
  };

  if (!words.length) {
    return <div className="word-list" style={{ color: 'var(--muted)', padding: 16 }}>生词本为空。在字幕上点单词 → 加入生词本。</div>;
  }

  return (
    <div className="word-list">
      {words.map((w) => (
        <div key={w.id} className="word-card">
          <div className="w">{w.word}</div>
          {w.context && <div className="ctx">"{w.context}"</div>}
          {w.translation && <div className="tr">{w.translation}</div>}
          <div className="bar">
            <a onClick={() => jumpTo(w)}>↪ 回到语境</a>
            <a onClick={() => del(w.id!)} style={{ color: 'var(--danger)' }}>删除</a>
          </div>
        </div>
      ))}
    </div>
  );
}
