import { useEffect, useMemo, useState } from 'react';
import type { StudyVideoExportSelection } from '../types';

const EXPORT_OPTIONS: Array<{
  key: keyof StudyVideoExportSelection;
  title: string;
  desc: string;
}> = [
  { key: 'plain', title: '无字幕视频', desc: '只导出干净视频，不带任何字幕。' },
  { key: 'english', title: '英文字幕视频', desc: '保留英文字幕，适合精听和跟读。' },
  { key: 'bilingual', title: '中英双语字幕视频', desc: '同时显示英文和中文字幕。' },
  { key: 'dubbed', title: '中文配音视频', desc: '生成中文配音，并带中英双语字幕。' },
];

const DEFAULT_SELECTION: StudyVideoExportSelection = {
  plain: false,
  english: false,
  bilingual: true,
  dubbed: true,
};

export function ExportVideoModal({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: (selection: StudyVideoExportSelection) => Promise<void> | void;
}) {
  const [selection, setSelection] = useState<StudyVideoExportSelection>(DEFAULT_SELECTION);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  const selectedCount = useMemo(
    () => Object.values(selection).filter(Boolean).length,
    [selection]
  );

  const toggle = (key: keyof StudyVideoExportSelection) => {
    setSelection((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const submit = async () => {
    if (!selectedCount || submitting) return;
    setSubmitting(true);
    try {
      await onConfirm(selection);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-mask">
      <div className="modal export-video-modal">
        <div className="header">
          <h3>选择导出内容</h3>
          <button className="close-x" onClick={onClose} disabled={submitting} title="关闭 (Esc)">
            ×
          </button>
        </div>

        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
          勾选这次要导出的版本。你可以一次导出多个，也可以只导出其中一个。
        </div>

        <div className="export-option-list">
          {EXPORT_OPTIONS.map((item) => {
            const checked = selection[item.key];
            return (
              <label key={item.key} className={`export-option ${checked ? 'checked' : ''}`}>
                <div className="export-option-main">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(item.key)}
                    disabled={submitting}
                  />
                  <div>
                    <div className="export-option-title">{item.title}</div>
                    <div className="export-option-desc">{item.desc}</div>
                  </div>
                </div>
              </label>
            );
          })}
        </div>

        <div
          style={{
            fontSize: 12,
            color: selectedCount ? 'var(--muted)' : 'var(--danger)',
            marginTop: 10,
          }}
        >
          {selectedCount ? `已选择 ${selectedCount} 项` : '请至少勾选一个导出项'}
        </div>

        <div className="footer">
          <button onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button className="primary" onClick={submit} disabled={!selectedCount || submitting}>
            {submitting ? '准备导出…' : '开始导出'}
          </button>
        </div>
      </div>
    </div>
  );
}
