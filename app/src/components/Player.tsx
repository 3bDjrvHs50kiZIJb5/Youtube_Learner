import { useEffect, useRef } from 'react';
import { usePlayerStore } from '../store/player';
import { SubtitleOverlay } from './SubtitleOverlay';
import { ControlBar } from './ControlBar';
import { publishVideoTime } from '../hooks/videoTime';

interface Props {
  onAddWord: (word: string, context: string, cueId: number) => void;
}

export function Player({ onAddWord }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { mediaUrl, cues, activeCueId, setActiveCue, loopCueId, decLoop, autoPauseAtSentenceEnd } =
    usePlayerStore();

  // 监听播放进度,更新当前字幕
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => {
      const ms = v.currentTime * 1000;
      const cur = cues.find((c) => ms >= c.startMs && ms < c.endMs);
      const curId = cur?.id ?? null;
      if (curId !== activeCueId) setActiveCue(curId);

      // 整句复读
      if (loopCueId !== null) {
        const loopCue = cues.find((c) => c.id === loopCueId);
        if (loopCue && ms >= loopCue.endMs) {
          v.currentTime = loopCue.startMs / 1000;
          decLoop();
        }
      } else if (autoPauseAtSentenceEnd && cur) {
        // 精读模式:句末自动暂停
        const nextCue = cues[cur.id + 1];
        const boundary = cur.endMs;
        // 播放越过 boundary 时暂停到 boundary
        if (ms >= boundary && ms < boundary + 250 && !v.paused) {
          v.pause();
          v.currentTime = boundary / 1000;
        }
      }
    };
    v.addEventListener('timeupdate', onTime);
    return () => v.removeEventListener('timeupdate', onTime);
  }, [cues, activeCueId, loopCueId, autoPauseAtSentenceEnd, decLoop, setActiveCue]);

  // rAF 循环把 currentTime 广播出去,供字幕 karaoke 逐词高亮用。
  // 不用 timeupdate(~250ms 一次,会一顿一顿);播放暂停时自动停掉循环。
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let raf = 0;
    const tick = () => {
      publishVideoTime(v.currentTime * 1000);
      raf = requestAnimationFrame(tick);
    };
    const start = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      publishVideoTime(v.currentTime * 1000);
    };
    // seek 结束后:
    // - 暂停中:只发一次最终值
    // - 播放中:重新开 rAF(不然填色永远停在旧位置)
    const onSeeked = () => {
      publishVideoTime(v.currentTime * 1000);
      if (v.paused) stop();
      else start();
    };
    v.addEventListener('play', start);
    v.addEventListener('playing', start);
    v.addEventListener('pause', stop);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('ended', stop);
    publishVideoTime(v.currentTime * 1000);
    return () => {
      stop();
      v.removeEventListener('play', start);
      v.removeEventListener('playing', start);
      v.removeEventListener('pause', stop);
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('ended', stop);
    };
  }, [mediaUrl]);

  // 监听 <video> 的错误/加载事件,便于排查播放失败
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onError = () => {
      const err = v.error;
      const map: Record<number, string> = {
        1: 'MEDIA_ERR_ABORTED (被中止)',
        2: 'MEDIA_ERR_NETWORK (网络/协议错误)',
        3: 'MEDIA_ERR_DECODE (解码失败)',
        4: 'MEDIA_ERR_SRC_NOT_SUPPORTED (格式/容器不支持)',
      };
      console.error('[video] error:', err?.code, map[err?.code ?? 0], err?.message, 'src =', v.currentSrc);
    };
    const onLoaded = () => console.log('[video] loadedmetadata, duration=', v.duration, 'src =', v.currentSrc);
    const onCanPlay = () => console.log('[video] canplay');
    const onStalled = () => console.warn('[video] stalled');
    v.addEventListener('error', onError);
    v.addEventListener('loadedmetadata', onLoaded);
    v.addEventListener('canplay', onCanPlay);
    v.addEventListener('stalled', onStalled);
    return () => {
      v.removeEventListener('error', onError);
      v.removeEventListener('loadedmetadata', onLoaded);
      v.removeEventListener('canplay', onCanPlay);
      v.removeEventListener('stalled', onStalled);
    };
  }, [mediaUrl]);

  // 当外部跳转到某一句时,同步到 video
  useEffect(() => {
    const handler = (e: Event) => {
      const v = videoRef.current;
      if (!v) return;
      const detail = (e as CustomEvent).detail as { startMs: number; play?: boolean };
      v.currentTime = detail.startMs / 1000;
      if (detail.play) v.play();
    };
    window.addEventListener('seekToCue', handler as EventListener);
    return () => window.removeEventListener('seekToCue', handler as EventListener);
  }, []);

  if (!mediaUrl) {
    return (
      <div className="stage">
        <div className="video-wrap">
          <div className="empty">
            <h2>选择一个视频开始</h2>
            <p>顶部依次点击 ① 打开视频 → ② 分离音频 → ③ 上传 → ④ 字幕输出 → ⑤ 翻译输出，即可生成双语字幕。</p>
          </div>
        </div>
      </div>
    );
  }

  // 点击视频切换播放/暂停
  const togglePlayPause = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  };

  return (
    <div className="stage">
      <div className="video-wrap">
        <video
          ref={videoRef}
          src={mediaUrl}
          controls={false}
          autoPlay={false}
          onClick={togglePlayPause}
          style={{ cursor: 'pointer' }}
        />
        <SubtitleOverlay onAddWord={onAddWord} />
      </div>
      <ControlBar videoRef={videoRef} />
    </div>
  );
}
