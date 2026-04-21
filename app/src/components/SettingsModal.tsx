import { useEffect, useState } from 'react';
import type { AppConfig } from '../types';

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [cfg, setCfg] = useState<AppConfig | null>(null);

  useEffect(() => {
    window.api.configGet().then(setCfg);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!cfg) return null;

  const save = async () => {
    await window.api.configSet(cfg);
    onClose();
  };

  return (
    <div className="modal-mask">
      <div className="modal">
        <div className="header">
          <h3>设置</h3>
          <button className="close-x" onClick={onClose} title="关闭 (Esc)">
            ×
          </button>
        </div>

        <div className="field">
          <label>DashScope API Key（千问 / 阿里云百炼）</label>
          <input
            type="password"
            value={cfg.dashscopeApiKey}
            onChange={(e) => setCfg({ ...cfg, dashscopeApiKey: e.target.value })}
            placeholder="sk-xxxxxxxx"
          />
        </div>

        <h4 style={{ marginTop: 20, marginBottom: 8 }}>阿里云 OSS</h4>
        <div className="field">
          <label>
            Region（如 <code>oss-cn-hangzhou</code>、<code>cn-hangzhou</code>，或完整 endpoint）
          </label>
          <input
            value={cfg.oss.region}
            onChange={(e) => setCfg({ ...cfg, oss: { ...cfg.oss, region: e.target.value } })}
            placeholder="oss-cn-hangzhou"
          />
          <span style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
            阿里云控制台「概览 → Region」显示的是 <code>cn-hangzhou</code>，会自动补 <code>oss-</code> 前缀。
          </span>
        </div>
        <div className="field">
          <label>Bucket</label>
          <input
            value={cfg.oss.bucket}
            onChange={(e) => setCfg({ ...cfg, oss: { ...cfg.oss, bucket: e.target.value } })}
          />
        </div>
        <div className="field">
          <label>AccessKey ID</label>
          <input
            value={cfg.oss.accessKeyId}
            onChange={(e) => setCfg({ ...cfg, oss: { ...cfg.oss, accessKeyId: e.target.value } })}
          />
        </div>
        <div className="field">
          <label>AccessKey Secret</label>
          <input
            type="password"
            value={cfg.oss.accessKeySecret}
            onChange={(e) => setCfg({ ...cfg, oss: { ...cfg.oss, accessKeySecret: e.target.value } })}
          />
        </div>
        <div className="field">
          <label>对象前缀</label>
          <input
            value={cfg.oss.prefix || ''}
            onChange={(e) => setCfg({ ...cfg, oss: { ...cfg.oss, prefix: e.target.value } })}
            placeholder="video-learner/"
          />
        </div>
        <div className="field">
          <label>翻译目标语言</label>
          <input
            value={cfg.translateTarget || ''}
            onChange={(e) => setCfg({ ...cfg, translateTarget: e.target.value })}
            placeholder="中文"
          />
        </div>

        <div className="footer">
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={save}>保存</button>
        </div>
      </div>
    </div>
  );
}
