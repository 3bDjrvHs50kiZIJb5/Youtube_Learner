import { useEffect, useMemo, useState } from 'react';

type Browser = 'chrome' | 'edge' | 'safari' | 'firefox' | 'brave' | 'chromium' | 'vivaldi' | 'opera';

const BROWSERS: { id: Browser; label: string }[] = [
  { id: 'chrome', label: 'Chrome' },
  { id: 'edge', label: 'Edge' },
  { id: 'safari', label: 'Safari' },
  { id: 'firefox', label: 'Firefox' },
  { id: 'brave', label: 'Brave' },
  { id: 'chromium', label: 'Chromium' },
  { id: 'vivaldi', label: 'Vivaldi' },
  { id: 'opera', label: 'Opera' },
];

type CodecPreset = 'vp9' | 'mp4' | 'default';

const CODEC_PRESETS: { id: CodecPreset; label: string; format?: string }[] = [
  {
    id: 'vp9',
    label: 'VP9 + Opus (推荐,Electron 内置可播)',
    format: 'bestvideo[vcodec^=vp9]+bestaudio/best[ext=mp4]/best',
  },
  {
    id: 'mp4',
    label: 'H.264 / MP4 (通用,体积较大)',
    format: 'bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/b',
  },
  {
    id: 'default',
    label: '默认(可能是 AV1,Electron 播放失败)',
  },
];

/** 给包含空格或特殊字符的字符串加 shell 单引号 */
function shellQuote(s: string): string {
  if (!s) return "''";
  if (/^[a-zA-Z0-9_\-./:=@%+,]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function YtDlpModal({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState('https://www.youtube.com/watch?v=tFsETEP01k8');
  const [browser, setBrowser] = useState<Browser>('chrome');
  const [outDir, setOutDir] = useState('');
  const [subs, setSubs] = useState(false);
  const [audioOnly, setAudioOnly] = useState(false);
  const [codec, setCodec] = useState<CodecPreset>('vp9');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const command = useMemo(() => {
    const parts = ['yt-dlp'];
    parts.push('--cookies-from-browser', browser);
    if (audioOnly) {
      parts.push('-x', '--audio-format', 'mp3');
    } else {
      const preset = CODEC_PRESETS.find((p) => p.id === codec);
      if (preset?.format) {
        parts.push('-f', shellQuote(preset.format));
      }
    }
    if (subs) {
      parts.push('--write-subs', '--write-auto-subs', '--sub-langs', 'en,zh-Hans');
    }
    if (outDir.trim()) {
      parts.push('-P', shellQuote(outDir.trim()));
    }
    parts.push(shellQuote(url.trim()));
    return parts.join(' ');
  }, [url, browser, outDir, subs, audioOnly, codec]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 兜底:选中再让用户手动 Ctrl+C
      const ta = document.getElementById('ytdlp-cmd') as HTMLTextAreaElement | null;
      ta?.select();
    }
  };

  return (
    <div className="modal-mask">
      <div className="modal">
        <div className="header">
          <h3>yt-dlp 下载命令</h3>
          <button className="close-x" onClick={onClose} title="关闭 (Esc)">
            ×
          </button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
          使用浏览器 Cookie 下载,避免登录/地区限制。生成命令后在终端执行即可。
        </div>

        <div className="field">
          <label>视频 URL</label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=..."
          />
        </div>

        <div className="field">
          <label>浏览器(从中读取 Cookie)</label>
          <select value={browser} onChange={(e) => setBrowser(e.target.value as Browser)}>
            {BROWSERS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>视频编码(影响能否在播放器里直接播放)</label>
          <select
            value={codec}
            onChange={(e) => setCodec(e.target.value as CodecPreset)}
            disabled={audioOnly}
          >
            {CODEC_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>输出目录(可选)</label>
          <input
            value={outDir}
            onChange={(e) => setOutDir(e.target.value)}
            placeholder="如 ~/Movies/yt 留空则下载到当前目录"
          />
        </div>

        <div style={{ display: 'flex', gap: 16, marginBottom: 12, fontSize: 13 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <input type="checkbox" checked={subs} onChange={(e) => setSubs(e.target.checked)} />
            同时下载字幕(en/zh)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={audioOnly}
              onChange={(e) => setAudioOnly(e.target.checked)}
            />
            仅音频(mp3)
          </label>
        </div>

        <div className="field">
          <label>命令</label>
          <textarea
            id="ytdlp-cmd"
            readOnly
            value={command}
            onFocus={(e) => e.currentTarget.select()}
            style={{
              minHeight: 72,
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
              fontSize: 12,
              padding: 8,
              resize: 'vertical',
            }}
          />
        </div>

        <div className="footer">
          <button onClick={onClose}>关闭</button>
          <button className="primary" onClick={copy}>
            {copied ? '已复制 ✓' : '复制命令'}
          </button>
        </div>
      </div>
    </div>
  );
}
