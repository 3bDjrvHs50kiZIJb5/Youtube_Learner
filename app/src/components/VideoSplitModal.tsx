import { useEffect, useState } from 'react';

const PRESET_MINUTES = [5, 10, 15, 20, 30, 60];

export function VideoSplitModal({ onClose }: { onClose: () => void }) {
  const [videoPath, setVideoPath] = useState<string>('');
  const [minutes, setMinutes] = useState<number>(10);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ message: string; percent?: number } | null>(null);
  const [result, setResult] = useState<{ outputDir: string; files: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  // 监听主进程的 split-video 进度事件
  useEffect(() => {
    const off = window.api.onProgress((e) => {
      if (e.stage === 'split-video') {
        setProgress({ message: e.message, percent: e.percent });
      }
    });
    return () => off();
  }, []);

  const pickVideo = async () => {
    const p = await window.api.pickVideo();
    if (p) {
      setVideoPath(p);
      setResult(null);
      setError(null);
    }
  };

  const doSplit = async () => {
    if (!videoPath) return;
    setBusy(true);
    setResult(null);
    setError(null);
    setProgress({ message: '准备切分…', percent: 0 });
    try {
      const r = await window.api.videoSplitByTime(videoPath, minutes);
      setResult(r);
      setProgress({ message: `完成,共 ${r.files.length} 段`, percent: 100 });
    } catch (e: any) {
      setError(e?.message || String(e));
      setProgress(null);
    } finally {
      setBusy(false);
    }
  };

  const fileName = videoPath ? videoPath.split('/').pop() : '';

  return (
    <div className="modal-mask">
      <div className="modal">
        <div className="header">
          <h3>分割视频</h3>
          <button className="close-x" onClick={onClose} disabled={busy} title="关闭 (Esc)">
            ×
          </button>
        </div>

        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
          按固定时长把一个长视频切成多段(不重新编码,速度快)。实际切点会落在最近的关键帧,段长是近似值。
        </div>

        <div className="field">
          <label>视频文件</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={fileName}
              readOnly
              placeholder="点右侧按钮选择本地视频…"
              style={{ flex: 1 }}
              title={videoPath}
            />
            <button onClick={pickVideo} disabled={busy}>
              选择视频…
            </button>
          </div>
        </div>

        <div className="field">
          <label>每段时长(分钟)</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select
              value={PRESET_MINUTES.includes(minutes) ? String(minutes) : 'custom'}
              onChange={(e) => {
                const v = e.target.value;
                if (v !== 'custom') setMinutes(Number(v));
              }}
              disabled={busy}
            >
              {PRESET_MINUTES.map((m) => (
                <option key={m} value={m}>
                  {m} 分钟
                </option>
              ))}
              <option value="custom">自定义…</option>
            </select>
            <input
              type="number"
              min={1}
              max={600}
              step={1}
              value={minutes}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!isNaN(v) && v > 0) setMinutes(v);
              }}
              disabled={busy}
              style={{ width: 90 }}
            />
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>分钟 / 段</span>
          </div>
        </div>

        {progress && (
          <div className="field">
            <label>进度</label>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>
              {progress.message}
              {progress.percent != null && ` (${progress.percent}%)`}
            </div>
            <div
              style={{
                width: '100%',
                height: 6,
                background: 'var(--bg-alt, #e5e7eb)',
                borderRadius: 3,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${progress.percent ?? 0}%`,
                  height: '100%',
                  background: 'var(--accent, #2563eb)',
                  transition: 'width 0.2s',
                }}
              />
            </div>
          </div>
        )}

        {error && (
          <div className="field">
            <div style={{ color: 'var(--danger, #dc2626)', fontSize: 13 }}>失败: {error}</div>
          </div>
        )}

        {result && (
          <div className="field">
            <label>输出</label>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
              目录: <code>{result.outputDir}</code>
            </div>
            <div
              style={{
                maxHeight: 160,
                overflow: 'auto',
                border: '1px solid var(--border, #e5e7eb)',
                borderRadius: 4,
                padding: 8,
                fontSize: 12,
                fontFamily:
                  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
              }}
            >
              {result.files.map((f) => (
                <div key={f}>{f.split('/').pop()}</div>
              ))}
            </div>
          </div>
        )}

        <div className="footer">
          <button onClick={onClose} disabled={busy}>
            关闭
          </button>
          <button className="primary" onClick={doSplit} disabled={!videoPath || busy}>
            {busy ? '切分中…' : '开始分割'}
          </button>
        </div>
      </div>
    </div>
  );
}
