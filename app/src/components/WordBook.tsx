import { useEffect, useState } from 'react';
import type { WordEntry } from '../types';
import { usePlayerStore } from '../store/player';
import { exportWordsToDocx } from '../utils/wordExport';
import { speakViaTTS, getSentenceSpeed } from '../utils/tts';

export function WordBook({ refreshKey }: { refreshKey: number }) {
  const [words, setWords] = useState<WordEntry[]>([]);
  const [loadingId, setLoadingId] = useState<number | null>(null);
  // 用 `${id}-word` / `${id}-ctx` 作为 key,区分"朗读单词"和"朗读原句"两个按钮
  const [speakingKey, setSpeakingKey] = useState<string | null>(null);
  // 行内提示:跳转失败/需要切换视频时给一点视觉反馈
  const [banner, setBanner] = useState<string | null>(null);
  // 导出 Word 文档时短暂禁用按钮,避免重复点击
  const [exporting, setExporting] = useState(false);
  // 用来判断"回到语境"是要直接 seek 还是先切换视频
  const currentVideoPath = usePlayerStore((s) => s.videoPath);

  useEffect(() => {
    if (!currentVideoPath) {
      setWords([]);
      return;
    }
    window.api.wordList(currentVideoPath).then(setWords);
  }, [refreshKey, currentVideoPath]);

  // banner 3 秒后自动消失
  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 3000);
    return () => clearTimeout(t);
  }, [banner]);

  /**
   * 通用朗读:单词和原句复用同一套播放逻辑,用 key 区分当前是哪个按钮在转圈。
   * mode:
   *  - 'word': 单词逐词朗读, 固定 1.0 倍速 (方便跟读、听清音节)
   *  - 'sentence': 整句朗读, 使用设置里的 cfg.tts.speed 倍速 (默认 1.5)
   */
  const speakText = async (text: string, key: string, mode: 'word' | 'sentence') => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const speed = mode === 'sentence' ? await getSentenceSpeed() : 1.0;
    setSpeakingKey(key);
    await speakViaTTS(trimmed, {
      speed,
      language: 'en',
      onDone: () => setSpeakingKey((cur) => (cur === key ? null : cur)),
    });
  };

  const speakContext = (entry: WordEntry) => {
    if (!entry.id || !entry.context) return;
    void speakText(entry.context, `${entry.id}-ctx`, 'sentence');
  };

  /**
   * 「求解释」按钮的合并行为: 点一下同时做两件事 ——
   *   1) 朗读单词 (1.0 倍速, 方便跟读);
   *   2) 如果这个词还没有详细解释, 顺手调 AI 把音标/词性/释义/语境补齐。
   * 已经有解释的词点击就只朗读, 不重复请求 AI。
   */
  const explainAndSpeak = (entry: WordEntry) => {
    if (!entry.id) return;
    const hasExplain = !!(entry.phonetic || entry.pos || entry.meaning || entry.contextual);
    void speakText(entry.word, `${entry.id}-word`, 'word');
    if (!hasExplain) {
      void fetchExplain(entry);
    }
  };

  const del = async (w: WordEntry) => {
    if (!w.id) return;
    const ok = window.confirm(`确定要从生词本中删除「${w.word}」吗?\n该操作无法撤销。`);
    if (!ok) return;
    await window.api.wordDelete(w.id, w.bucketKey);
    setWords((s) => s.filter((x) => x.id !== w.id));
  };

  /**
   * 回到语境:
   *  1) 没有时间戳:不能跳,直接提示。
   *  2) 当前已经是同一个视频:发 seekToCue,Player 直接 seek 即可。
   *  3) 生词带了 videoPath,但当前没加载 / 加载的是别的视频:
   *     发 openAndSeek,交给 App 先打开目标视频再 seek。
   *  4) 老数据没记录 videoPath,且当前没加载视频:只能提示用户手动打开。
   */
  const jumpTo = (w: WordEntry) => {
    if (w.sentenceStartMs == null) {
      setBanner('该生词没有记录时间戳,无法回到语境');
      return;
    }

    const sameVideo = !!currentVideoPath && w.videoPath === currentVideoPath;
    if (sameVideo) {
      window.dispatchEvent(
        new CustomEvent('seekToCue', { detail: { startMs: w.sentenceStartMs, play: true } })
      );
      return;
    }

    if (w.videoPath) {
      // 跨视频跳转:App 会打开目标视频,再按 startMs 续播
      setBanner(`正在切换到原视频…`);
      window.dispatchEvent(
        new CustomEvent('openAndSeek', {
          detail: { videoPath: w.videoPath, startMs: w.sentenceStartMs },
        })
      );
      return;
    }

    // 兜底:老数据 + 当前无视频
    setBanner('该生词没有记录视频路径,请先手动打开对应视频');
  };

  /**
   * 把当前生词本导出成 Word 文档,方便打印。
   * 排版交给 utils/wordExport.ts 处理,这里只负责触发 + 状态反馈。
   */
  const handleExport = async () => {
    if (!words.length || exporting) return;
    setExporting(true);
    try {
      await exportWordsToDocx(words);
      setBanner(`已导出 ${words.length} 个单词为 Word 文档`);
    } catch (err: any) {
      console.warn('导出 Word 失败:', err);
      setBanner(`导出失败: ${err?.message || err}`);
    } finally {
      setExporting(false);
    }
  };

  /** 重新拉一次 AI 解释并写回;老条目/首次查询时用。 */
  const fetchExplain = async (w: WordEntry) => {
    if (!w.id) return;
    setLoadingId(w.id);
    try {
      const exp = await window.api.wordExplain(w.word, w.context || '');
      const patch: Partial<WordEntry> = {
        phonetic: exp.phonetic,
        pos: exp.pos,
        meaning: exp.meaning,
        contextual: exp.contextual,
        // translation 字段向下兼容,没有值时合成一下
        translation:
          w.translation ||
          [exp.pos, exp.meaning].filter(Boolean).join(' ').trim() ||
          exp.contextual,
      };
      const updated = await window.api.wordUpdate(w.id, patch, w.bucketKey);
      if (updated) {
        setWords((s) => s.map((x) => (x.id === w.id ? updated : x)));
      }
    } catch (err: any) {
      console.warn('查询单词解释失败:', err);
    } finally {
      setLoadingId(null);
    }
  };

  if (!words.length) {
    return (
      <div className="word-list" style={{ color: 'var(--muted)', padding: 16 }}>
        {currentVideoPath ? '当前视频的生词本为空。在字幕上点单词 → 加入生词本。' : '请先打开一个视频，再查看它的生词本。'}
      </div>
    );
  }

  return (
    <div className="word-list">
      <div className="word-toolbar">
        <span className="word-count">共 {words.length} 个单词</span>
        <button
          className="word-export-btn"
          onClick={handleExport}
          disabled={exporting}
          title="导出当前生词本为 Word 文档,排版适合打印"
        >
          {exporting ? '⏳ 导出中…' : '📄 导出 Word'}
        </button>
      </div>
      {banner && <div className="word-banner">{banner}</div>}
      {words.map((w) => {
        const hasExplain = !!(w.phonetic || w.pos || w.meaning || w.contextual);
        return (
          <div key={w.id} className="word-card">
            <div className="word-card-head">
              <span className="w">{w.word}</span>
              {w.phonetic && <span className="phonetic">{w.phonetic}</span>}
              {w.pos && <span className="pos">{w.pos}</span>}
              {/* 合并按钮: 朗读单词 + (首次)顺手让 AI 补齐详细解释 */}
              <button
                className="ghost icon-btn explain-btn"
                title={hasExplain ? '朗读单词 (Qwen-TTS)' : '朗读 + AI 详细解释 (音标 / 词性 / 释义 / 语境)'}
                onClick={() => explainAndSpeak(w)}
                disabled={speakingKey === `${w.id}-word` || loadingId === w.id}
              >
                {loadingId === w.id
                  ? '⏳'
                  : speakingKey === `${w.id}-word`
                  ? '🔊'
                  : '💡'}
              </button>
            </div>

            {w.meaning && <div className="meaning">{w.meaning}</div>}
            {w.contextual && (
              <div className="contextual">
                <span className="tag">语境</span>
                {w.contextual}
              </div>
            )}
            {/* 没有详细解释但有老字段 translation 时,退化展示 translation */}
            {!hasExplain && w.translation && <div className="tr">{w.translation}</div>}

            {w.context && (
              <div className="ctx">
                <span className="ctx-text">"{w.context}"</span>
                <button
                  className="ghost icon-btn ctx-speak"
                  title="朗读原句 (Qwen-TTS)"
                  onClick={() => speakContext(w)}
                  disabled={speakingKey === `${w.id}-ctx`}
                >
                  {speakingKey === `${w.id}-ctx` ? '⏳' : '🔊'}
                </button>
              </div>
            )}

            <div className="bar">
              <a onClick={() => jumpTo(w)}>↪ 回到语境</a>
              {loadingId === w.id && (
                <span style={{ color: 'var(--muted)' }}>查询中…</span>
              )}
              <a onClick={() => del(w)} style={{ color: 'var(--danger)' }}>
                删除
              </a>
            </div>
          </div>
        );
      })}
    </div>
  );
}
