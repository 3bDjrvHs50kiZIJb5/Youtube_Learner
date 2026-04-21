import { usePlayerStore, WorkerState } from '../store/player';
import type { WorkerPhase, WorkerStatus } from '../types';

function statusColor(s: WorkerStatus): string {
  switch (s) {
    case 'done': return 'var(--success)';
    case 'error': return 'var(--danger)';
    case 'running':
    case 'fetching':
    case 'submitting':
    case 'pending': return 'var(--warn)';
    default: return 'var(--muted)';
  }
}

function statusLabel(s: WorkerStatus): string {
  switch (s) {
    case 'submitting': return '提交中';
    case 'pending': return '排队';
    case 'running': return '处理中';
    case 'fetching': return '拉结果';
    case 'done': return '完成';
    case 'error': return '失败';
    default: return '空闲';
  }
}

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(r).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function AsrWorkerCard({ w }: { w: WorkerState }) {
  return (
    <div className="worker-card">
      <div className="worker-head">
        <span className="worker-id">Worker #{w.workerId}</span>
        <span className="worker-status" style={{ color: statusColor(w.status) }}>
          ● {statusLabel(w.status)}
        </span>
      </div>
      <div className="worker-meta">
        第 {w.segmentIndex + 1} / {w.segmentTotal} 段
        {w.offsetMs != null && w.durationMs != null && (
          <> · {fmtTime(w.offsetMs)} – {fmtTime(w.offsetMs + w.durationMs)}</>
        )}
      </div>
      <div className="worker-msg">{w.message}</div>
      <div className="worker-log">
        {w.log.length === 0 ? (
          <div className="worker-empty">等待识别结果…</div>
        ) : (
          w.log.map((entry) => (
            <div key={entry.segmentIndex} className="worker-log-block">
              <div className="worker-log-title">▸ 第 {entry.segmentIndex + 1} 段 · {entry.cues.length} 句</div>
              {entry.cues.slice(0, 10).map((c) => (
                <div key={c.id} className="worker-log-line">
                  <span className="t">{fmtTime(c.startMs)}</span>
                  <span className="tx">{c.text}</span>
                </div>
              ))}
              {entry.cues.length > 10 && (
                <div className="worker-log-more">…还有 {entry.cues.length - 10} 句</div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function TranslateWorkerCard({ w }: { w: WorkerState }) {
  return (
    <div className="worker-card">
      <div className="worker-head">
        <span className="worker-id">Worker #{w.workerId}</span>
        <span className="worker-status" style={{ color: statusColor(w.status) }}>
          ● {statusLabel(w.status)}
        </span>
      </div>
      <div className="worker-meta">
        第 {w.segmentIndex + 1} / {w.segmentTotal} 批
      </div>
      <div className="worker-msg">{w.message}</div>
      <div className="worker-log">
        {w.log.length === 0 ? (
          <div className="worker-empty">等待翻译结果…</div>
        ) : (
          w.log.map((entry) => (
            <div key={entry.segmentIndex} className="worker-log-block">
              <div className="worker-log-title">▸ 第 {entry.segmentIndex + 1} 批 · {entry.cues.length} 句</div>
              {entry.cues.slice(0, 6).map((c) => (
                <div key={c.id} className="translate-line">
                  <div className="en">{c.text}</div>
                  {c.translation && <div className="zh">{c.translation}</div>}
                </div>
              ))}
              {entry.cues.length > 6 && (
                <div className="worker-log-more">…还有 {entry.cues.length - 6} 句</div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function ProgressPanel() {
  const {
    currentPhase,
    asrWorkers,
    asrWorkerTotal,
    translateWorkers,
    translateWorkerTotal,
    setCurrentPhase,
  } = usePlayerStore();

  const asrList = Object.values(asrWorkers).sort((a, b) => a.workerId - b.workerId);
  const translateList = Object.values(translateWorkers).sort((a, b) => a.workerId - b.workerId);

  const hasAsr = asrList.length > 0;
  const hasTranslate = translateList.length > 0;

  if (!hasAsr && !hasTranslate) {
    return (
      <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>
        暂无实时结果。点④「字幕输出」或⑤「翻译输出」后,这里会展示每个并发 worker 的实时进度。
      </div>
    );
  }

  const tab = (phase: WorkerPhase, label: string, has: boolean) => (
    <button
      className={`pp-tab ${currentPhase === phase ? 'pp-tab-active' : ''}`}
      disabled={!has}
      onClick={() => setCurrentPhase(phase)}
    >
      {label}
    </button>
  );

  const list = currentPhase === 'asr' ? asrList : translateList;
  const total = currentPhase === 'asr' ? asrWorkerTotal : translateWorkerTotal;
  const title = currentPhase === 'asr' ? 'ASR 字幕输出' : '翻译输出';

  return (
    <div className="progress-panel">
      <div className="pp-tabs">
        {tab('asr', 'ASR', hasAsr)}
        {tab('translate', '翻译', hasTranslate)}
      </div>
      <div className="pp-section">
        <div className="pp-section-title">
          {title} · {list.length}/{total} workers
        </div>
        <div className="worker-grid">
          {list.map((w) =>
            currentPhase === 'asr' ? (
              <AsrWorkerCard key={w.workerId} w={w} />
            ) : (
              <TranslateWorkerCard key={w.workerId} w={w} />
            )
          )}
        </div>
      </div>
    </div>
  );
}
