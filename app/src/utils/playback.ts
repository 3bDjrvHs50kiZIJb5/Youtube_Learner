import type { SubtitleCue } from '../types';

export function alignAutoPausedResumePoint(params: {
  video: HTMLVideoElement;
  cues: SubtitleCue[];
  activeCueId: number | null;
  autoPauseAtSentenceEnd: boolean;
}) {
  const { video, cues, activeCueId, autoPauseAtSentenceEnd } = params;
  if (!autoPauseAtSentenceEnd || !cues.length) return;

  const currentMs = video.currentTime * 1000;
  const activeCue =
    cues.find((c) => c.id === activeCueId) ??
    cues.find((c) => currentMs >= c.startMs && currentMs < c.endMs + 80);
  if (!activeCue) return;

  // 精读现在不再提前截断句尾,但浏览器暂停时仍可能停在句尾附近的极小窗口里。
  // 恢复播放前先把时间对齐到 endMs,避免刚点播放又被句末钩子立刻拦住。
  if (currentMs >= activeCue.endMs - 80 && currentMs <= activeCue.endMs + 80) {
    video.currentTime = activeCue.endMs / 1000;
  }
}
