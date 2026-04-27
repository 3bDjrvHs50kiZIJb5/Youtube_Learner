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
    label: 'VP9 + Opus (播放器里更容易直接播放, 但有些视频清晰度会偏低)',
    format: 'bestvideo[vcodec^=vp9]+bestaudio/best[ext=mp4]/best',
  },
  {
    id: 'mp4',
    label: 'H.264 / MP4 (更通用,通常更容易拿到高清,体积较大)',
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

function normalizeVideoId(value: string): string {
  const trimmed = value.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  return '';
}

function extractVideoId(rawUrl: string): string {
  const value = rawUrl.trim();
  if (!value) return '';
  const directId = normalizeVideoId(value);
  if (directId) return directId;
  try {
    const url = new URL(value);
    const v = url.searchParams.get('v')?.trim();
    const host = url.hostname.toLowerCase();
    if (v) return normalizeVideoId(v) || v;
    if ((host === 'youtu.be' || host.endsWith('.youtu.be')) && url.pathname !== '/') {
      return normalizeVideoId(url.pathname.replace(/^\/+/, ''));
    }
    const pathMatch = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/);
    if (pathMatch?.[1]) {
      return normalizeVideoId(pathMatch[1]) || pathMatch[1];
    }
  } catch {
    // ignore
  }
  const match = value.match(/[?&]v=([^&]+)/);
  return normalizeVideoId(match?.[1] ?? '');
}

function sanitizeYoutubeUrl(rawUrl: string): string {
  const value = rawUrl.trim();
  if (!value) return '';
  const videoId = extractVideoId(value);
  if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
  return value;
}

export function YtDlpModal({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState('https://www.youtube.com/watch?v=tFsETEP01k8');
  const [browser, setBrowser] = useState<Browser>('chrome');
  const [subs, setSubs] = useState(false);
  const [audioOnly, setAudioOnly] = useState(false);
  const [codec, setCodec] = useState<CodecPreset>('mp4');
  const [copied, setCopied] = useState(false);
  const [launching, setLaunching] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const videoId = useMemo(() => extractVideoId(url), [url]);
  const sanitizedUrl = useMemo(() => sanitizeYoutubeUrl(url), [url]);

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
    if (videoId) {
      parts.push('-P', shellQuote(`~/Downloads/${videoId}`));
    }
    parts.push(shellQuote(sanitizedUrl));
    return parts.join(' ');
  }, [browser, subs, audioOnly, codec, videoId, sanitizedUrl]);

  const runCommand = async () => {
    try {
      setLaunching(true);
      const result = await window.api.ytDlpLaunchDownload({
        url: sanitizedUrl,
        browser,
        subs,
        audioOnly,
        codec,
      });
      await navigator.clipboard.writeText(result.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      onClose();
    } catch {
      // 兜底:选中再让用户手动 Ctrl+C
      const ta = document.getElementById('ytdlp-cmd') as HTMLTextAreaElement | null;
      ta?.select();
    } finally {
      setLaunching(false);
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
          使用浏览器 Cookie 下载，避免登录或地区限制。点“运行命令”后会自动在下载目录建文件夹，并打开终端开始下载。
        </div>

        <div className="field">
          <label>视频 URL</label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => {
              const next = sanitizeYoutubeUrl(url);
              if (next && next !== url) setUrl(next);
            }}
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
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
            说明：VP9 兼容当前播放器一些场景，但部分视频只能拿到较低清晰度；想优先下高清时，建议选 H.264 / MP4。
          </div>
        </div>

        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
          {videoId ? `本次会自动下载到：~/Downloads/${videoId}` : '请输入包含 v= 的 YouTube 链接'}
        </div>
        {sanitizedUrl && sanitizedUrl !== url.trim() ? (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
            检测到链接里有多余参数，下载时会自动整理为：{sanitizedUrl}
          </div>
        ) : null}

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
          <button className="primary" onClick={runCommand} disabled={launching || !url.trim()}>
            {launching ? '启动下载中…' : copied ? '已运行 ✓' : '运行命令'}
          </button>
        </div>
      </div>
    </div>
  );
}
