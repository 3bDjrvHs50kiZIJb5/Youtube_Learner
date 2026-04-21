/**
 * 视频当前播放时间(ms)的全局广播器。
 * 不走 Zustand 是为了避免每帧 re-render 整棵组件树;
 * 订阅者自己用 DOM 级的方式(ref/style)消费。
 */
type Listener = (ms: number) => void;

const listeners = new Set<Listener>();
let currentMs = 0;

export function publishVideoTime(ms: number) {
  currentMs = ms;
  for (const l of listeners) l(ms);
}

export function subscribeVideoTime(l: Listener): () => void {
  listeners.add(l);
  l(currentMs);
  return () => {
    listeners.delete(l);
  };
}

export function getVideoTimeMs(): number {
  return currentMs;
}
