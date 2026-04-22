import { useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../store/player';
import { SubtitleOverlay } from './SubtitleOverlay';
import { ControlBar } from './ControlBar';
import { publishVideoTime } from '../hooks/videoTime';
import type { SubtitleCue } from '../types';

interface Props {
  onAddWord: (
    word: string,
    context: string,
    cueId: number,
    explanation?: {
      phonetic?: string;
      pos?: string;
      meaning?: string;
      contextual?: string;
    }
  ) => void;
  onDropVideo?: (absolutePath: string) => void | Promise<void>;
}

// 拖拽支持的视频扩展名,和选择框里的 filter 保持一致
const VIDEO_EXT_RE = /\.(mp4|webm|mkv|mov|avi|m4v)$/i;

export function Player({ onAddWord, onDropVideo }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const {
    mediaUrl,
    videoPath,
    cues,
    activeCueId,
    editingCueId,
    setActiveCue,
    loopCueId,
    decLoop,
    autoPauseAtSentenceEnd,
    initialSeekMs,
    setInitialSeek,
  } = usePlayerStore();
  const [dragOver, setDragOver] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);

  // 当前排好的"到句末"定时器 id, 跨 effect 重建保留
  const schedRef = useRef<{ endTimer: number | null }>({ endTimer: null });

  // 字幕编辑"试听"期间置位:
  // 用来压制 精读(autoPauseAtSentenceEnd) / 复读(loopCueId) 的句末钩子,
  // 保证试听严格按"编辑后的起止点"播一次,不会在原始 cue.endMs 就被拦截掉。
  const previewActiveRef = useRef(false);

  // 只负责根据 currentTime 更新 activeCueId,给字幕 overlay 和调度器当"换句"信号
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => {
      const curId =
        editingCueId ??
        (() => {
          const ms = v.currentTime * 1000;
          const cur = cues.find((c) => ms >= c.startMs && ms < c.endMs);
          return cur?.id ?? null;
        })();
      if (curId !== activeCueId) setActiveCue(curId);
    };
    onTime();
    v.addEventListener('timeupdate', onTime);
    return () => v.removeEventListener('timeupdate', onTime);
  }, [cues, activeCueId, editingCueId, setActiveCue]);

  // 句末预约调度:
  // 不再等"越过 endMs 才反应"(timeupdate 粒度 250ms / rAF 也至少差 1 帧,
  // 两种都会让下一句先漏出一点音画再被拉回来)。
  // 改成进入某一句时就算好剩余毫秒, setTimeout 精准触发,
  // 到点按模式决定倒带 / 停住。
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    // 比 endMs 提前一点触发,保证 pause 发生在下一句音画被解码送出之前。
    // ~1 帧。调大会截掉句尾,调小会开始漏播。
    const LEAD_MS = 12;

    const state = schedRef.current;

    const clearTimer = () => {
      if (state.endTimer !== null) {
        window.clearTimeout(state.endTimer);
        state.endTimer = null;
      }
    };

    // 到句末统一入口。分支: 复读 > 精读 > 兜底。
    //
    // 关键不变量:
    // 1) 复读锁在本句时, 绝对不要先 seek 到 endMs 再 seek 到 startMs。
    //    浏览器会先把 endMs 那一帧渲出来 (下一句的开头画面) 再跳回去,
    //    肉眼看就是"闪了一下下一句"。所以复读分支直接一步跳 startMs。
    // 2) 精读模式: 原地停住, 等用户手动继续。
    // 3) 一切分支开头都 pin 一次 activeCueId, 防止 timeupdate 在
    //    pause 前刚好触发并把字幕切走。
    const onCueEnd = (cue: SubtitleCue) => {
      const cur = videoRef.current;
      if (!cur) return;
      cur.pause();
      if (activeCueId !== cue.id) setActiveCue(cue.id);

      // 复读锁在本句: 一步倒回 startMs, 不经过 endMs
      if (loopCueId === cue.id) {
        cur.currentTime = cue.startMs / 1000;
        decLoop();
        cur.play().catch(() => {});
        return;
      }

      // 精读: 原地停住, 等用户手动继续。
      // 不再 seek 到 endMs, 否则 activeCueId 会被 timeupdate 切到下一句,
      // 表现成"播完当前句 -> 跳一下下一句 -> 暂停"。
      if (autoPauseAtSentenceEnd) {
        return;
      }

      // 兜底: 理论上 schedule 不会给这种情形排钩子
      cur.currentTime = cue.endMs / 1000;
      cur.play().catch(() => {});
    };

    const schedule = () => {
      clearTimer();
      if (v.paused) return;
      // 试听中: 不排句末钩子, 交给 previewCueRange 自己的定时器按编辑后的 endMs 暂停
      if (previewActiveRef.current) return;
      const needHook = autoPauseAtSentenceEnd || loopCueId !== null;
      if (!needHook) return;

      const ms = v.currentTime * 1000;
      const cur = cues.find((c) => ms >= c.startMs && ms < c.endMs);
      if (!cur) return;
      // 只开了复读、没开精读时,只对被锁那句排钩子;路过其他句照常放
      if (!autoPauseAtSentenceEnd && loopCueId !== cur.id) return;

      const rate = v.playbackRate || 1;
      const remainMs = (cur.endMs - ms) / rate - LEAD_MS;
      if (remainMs <= 0) {
        // 已经贴到/越过句末(比如用户 seek 过来的),立即处理
        onCueEnd(cur);
        return;
      }
      state.endTimer = window.setTimeout(() => {
        state.endTimer = null;
        onCueEnd(cur);
      }, remainMs);
    };

    schedule();

    v.addEventListener('play', schedule);
    v.addEventListener('playing', schedule);
    v.addEventListener('pause', clearTimer);
    v.addEventListener('seeked', schedule);
    v.addEventListener('ratechange', schedule);
    v.addEventListener('ended', clearTimer);

    return () => {
      clearTimer();
      v.removeEventListener('play', schedule);
      v.removeEventListener('playing', schedule);
      v.removeEventListener('pause', clearTimer);
      v.removeEventListener('seeked', schedule);
      v.removeEventListener('ratechange', schedule);
      v.removeEventListener('ended', clearTimer);
    };
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

  // 视频加载完拿到真实像素尺寸后, 把视频比例和"非视频区"尺寸一起传给主进程:
  //   extraWidth  = 侧边栏宽度
  //   extraHeight = 顶栏高度 + 控制条高度
  // 主进程据此保证"视频区域"本身按视频比例显示, 顶/底/右的工具区保持固定像素,
  // 用户手动拖拽缩放时, 视频区域也会继续保持该比例。
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    // 等布局稳定一帧, 避免首次打开时 DOM 高度还没算好
    let raf = 0;
    const measureChrome = () => {
      const topbar = document.querySelector('.topbar') as HTMLElement | null;
      const sidebar = document.querySelector('.sidebar') as HTMLElement | null;
      // .controls 在 Player 内部, 用 stage 限定一下防止别处出现同类名
      const controls = document.querySelector('.stage .controls') as HTMLElement | null;
      return {
        extraWidth: Math.round(sidebar?.getBoundingClientRect().width ?? 0),
        extraHeight: Math.round(
          (topbar?.getBoundingClientRect().height ?? 0) +
            (controls?.getBoundingClientRect().height ?? 0)
        ),
      };
    };

    const applyAspect = () => {
      const w = v.videoWidth;
      const h = v.videoHeight;
      if (!w || !h) return;
      const ratio = w / h;
      if (!Number.isFinite(ratio) || ratio <= 0) return;
      // 下一帧再测, 确保控制条已经按视频渲染完布局 (部分按钮依赖 cues)
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const { extraWidth, extraHeight } = measureChrome();
        window.api
          .setWindowAspectRatio(ratio, { extraWidth, extraHeight })
          .catch(() => {});
      });
    };

    if (v.videoWidth && v.videoHeight) applyAspect();
    v.addEventListener('loadedmetadata', applyAspect);
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener('loadedmetadata', applyAspect);
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

  // 打开视频后,如果 store 里有上次的播放位置,等元数据加载完(拿到 duration)再 seek 过去。
  // 要等 loadedmetadata 是因为在此之前给 currentTime 赋值无效。
  // 距离片尾 5 秒以内就不续播了,从头开始更符合预期。
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (initialSeekMs == null) return;
    const applySeek = () => {
      const dur = v.duration;
      const target = initialSeekMs / 1000;
      if (Number.isFinite(dur) && dur > 0 && target < dur - 5) {
        v.currentTime = target;
      }
      setInitialSeek(null);
    };
    if (v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0) {
      applySeek();
    } else {
      v.addEventListener('loadedmetadata', applySeek, { once: true });
      return () => v.removeEventListener('loadedmetadata', applySeek);
    }
  }, [mediaUrl, initialSeekMs, setInitialSeek]);

  // 定期把当前播放位置写回状态文件,下次打开同一视频时可以续播。
  // 节流:每 5 秒一次,暂停/跳转/页面隐藏/关闭时立即写一次。
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !videoPath) return;
    let lastSavedMs = -1;
    const save = () => {
      if (!videoPath) return;
      const ms = Math.floor(v.currentTime * 1000);
      if (ms < 0) return;
      // 相同位置不重复写
      if (Math.abs(ms - lastSavedMs) < 500) return;
      lastSavedMs = ms;
      window.api.stateSavePosition(videoPath, ms).catch(() => {});
    };
    const timer = window.setInterval(() => {
      if (!v.paused && !v.ended) save();
    }, 5000);
    const onPause = () => save();
    const onSeeked = () => save();
    const onEnded = () => save();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') save();
    };
    v.addEventListener('pause', onPause);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('ended', onEnded);
    window.addEventListener('beforeunload', save);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      // 注意:这里不在 cleanup 里再调一次 save(),
      // 因为切换视频时 <video> 的 src 已经换了,currentTime 可能被浏览器重置为 0,
      // 此时 videoPath 闭包还是旧视频,会把旧视频的续播位置写成 0。
      window.clearInterval(timer);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('ended', onEnded);
      window.removeEventListener('beforeunload', save);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [videoPath, mediaUrl]);

  // 当外部跳转到某一句时,同步到 video
  useEffect(() => {
    const handler = (e: Event) => {
      const v = videoRef.current;
      if (!v) return;
      const detail = (e as CustomEvent).detail as {
        startMs: number;
        play?: boolean;
        fromCueList?: boolean;
        enableAutoPause?: boolean;
      };
      // 从右侧字幕列表点选跳转时,按这次点击的句长决定是否切到精读:
      // 长句(>=10 词)自动句末暂停,短句则保持连续播放。
      if (detail.fromCueList) {
        const { autoPauseAtSentenceEnd: cur, toggleAutoPause } = usePlayerStore.getState();
        const shouldEnable = detail.enableAutoPause ?? true;
        if (cur !== shouldEnable) toggleAutoPause();
      }
      v.currentTime = detail.startMs / 1000;
      // play() 在没有 src / 被自动播放策略拦截时会 reject,吞掉防止未捕获 Promise
      if (detail.play) v.play().catch(() => {});
    };
    window.addEventListener('seekToCue', handler as EventListener);
    return () => window.removeEventListener('seekToCue', handler as EventListener);
  }, []);

  // 外部触发暂停视频 (比如点 AI 复读时,避免原声和 TTS 同时响)
  useEffect(() => {
    const handler = () => {
      const v = videoRef.current;
      if (v && !v.paused) v.pause();
    };
    window.addEventListener('pauseVideo', handler);
    return () => window.removeEventListener('pauseVideo', handler);
  }, []);

  // 字幕时间微调的"试听"能力:从 startMs 播到 endMs 后自动暂停。
  // 区别于 seekToCue(只跳转不限终点) / 复读(到末尾再倒带),这里是"一次性播一段"。
  //
  // 注意: 试听期间通过 previewActiveRef 压制上面的句末钩子, 否则如果用户
  // 开着精读/复读, 视频一到原始 cue.endMs 就会被截停/倒回, 没法验证新的起止点。
  useEffect(() => {
    let timer: number | null = null;
    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
    const endPreview = () => {
      previewActiveRef.current = false;
      const sched = schedRef.current;
      if (sched.endTimer !== null) {
        window.clearTimeout(sched.endTimer);
        sched.endTimer = null;
      }
    };
    const handler = (e: Event) => {
      const v = videoRef.current;
      if (!v) return;
      const { startMs, endMs } = (e as CustomEvent).detail as {
        startMs: number;
        endMs: number;
      };
      if (!isFinite(startMs) || !isFinite(endMs) || endMs <= startMs) return;
      clearTimer();
      previewActiveRef.current = true;
      const sched = schedRef.current;
      if (sched.endTimer !== null) {
        window.clearTimeout(sched.endTimer);
        sched.endTimer = null;
      }
      v.currentTime = startMs / 1000;
      v.play().catch(() => {});
      const rate = v.playbackRate || 1;
      // +30ms 余量,减少因为 setTimeout 抖动导致的末尾一点被截掉
      const waitMs = (endMs - startMs) / rate + 30;
      timer = window.setTimeout(() => {
        timer = null;
        const cur = videoRef.current;
        if (cur && !cur.paused) cur.pause();
        endPreview();
      }, waitMs);
    };
    window.addEventListener('previewCueRange', handler as EventListener);
    return () => {
      clearTimer();
      endPreview();
      window.removeEventListener('previewCueRange', handler as EventListener);
    };
  }, []);

  // 拖拽处理:允许把视频文件直接拖进播放区打开
  const handleDragOver = (e: React.DragEvent) => {
    if (!onDropVideo) return;
    // 只有外部文件拖入时才显示 hover 态
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragOver) setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    // 避免子元素冒泡造成的闪烁:只有真正离开 .stage 才关
    if (e.currentTarget === e.target) setDragOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    if (!onDropVideo) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);

    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;

    const file = files.find((f) => VIDEO_EXT_RE.test(f.name)) || files[0];
    if (!VIDEO_EXT_RE.test(file.name)) {
      setDropError('仅支持 mp4 / webm / mkv / mov / avi / m4v 格式');
      setTimeout(() => setDropError(null), 2500);
      return;
    }

    const absPath = window.api.getPathForFile(file);
    if (!absPath) {
      setDropError('无法获取文件路径,请改用「打开视频」按钮');
      setTimeout(() => setDropError(null), 2500);
      return;
    }
    await onDropVideo(absPath);
  };

  const stageDnD = {
    onDragOver: handleDragOver,
    onDragEnter: handleDragOver,
    onDragLeave: handleDragLeave,
    onDrop: handleDrop,
  };

  const dropHint = dragOver && (
    <div className="drop-hint">
      <div className="drop-hint-inner">
        <div className="drop-hint-icon">⬇</div>
        <div className="drop-hint-title">松开以打开视频</div>
        <div className="drop-hint-sub">支持 mp4 / webm / mkv / mov / avi / m4v</div>
      </div>
    </div>
  );

  if (!mediaUrl) {
    return (
      <div className={`stage ${dragOver ? 'stage--drag' : ''}`} {...stageDnD}>
        <div className="video-wrap">
          <div className="empty">
            <h2>选择一个视频开始</h2>
            <p>
              直接把视频文件拖到这里，或顶部依次点击 ① 打开视频 → ② 分离音频 → ③ 上传 → ④ 字幕输出 → ⑤ 翻译输出，即可生成双语字幕。
            </p>
          </div>
        </div>
        {dropHint}
        {dropError && <div className="drop-error">{dropError}</div>}
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
    <div className={`stage ${dragOver ? 'stage--drag' : ''}`} {...stageDnD}>
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
      {dropHint}
      {dropError && <div className="drop-error">{dropError}</div>}
    </div>
  );
}
