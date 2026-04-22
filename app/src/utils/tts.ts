/**
 * 朗读 (Qwen-TTS) 公共工具。
 * WordBook、SubtitleOverlay 等组件共用, 保证:
 *   - 音频增益(比 HTMLAudioElement.volume 上限 1.0 更响) 只写在一处
 *   - 同时最多只有一条朗读在播,避免重叠
 *   - 失败时自动降级到浏览器原生 Web Speech
 */

import { useEffect, useState } from 'react';
import { showToast } from './toast';

// 本次会话是否已经提示过"首次 AI 朗读需要等一会儿"。
// 刷新页面会重置,属于预期行为。
let firstTTSHintShown = false;

/**
 * 全局 TTS 发声状态事件。
 * 派发时机:
 *   - activeOps 从 0 变 1 (开始朗读) -> detail.speaking = true
 *   - activeOps 回到 0 (所有朗读结束)-> detail.speaking = false
 * 用计数是为了覆盖"快速连点触发多次 speakViaTTS"的极端场景,不会中间误闪。
 */
export const TTS_SPEAKING_EVENT = 'tts:speaking';

let activeOps = 0;
let lastEmittedSpeaking = false;
function emitSpeaking() {
  const speaking = activeOps > 0;
  if (speaking === lastEmittedSpeaking) return;
  lastEmittedSpeaking = speaking;
  try {
    window.dispatchEvent(
      new CustomEvent(TTS_SPEAKING_EVENT, { detail: { speaking } })
    );
  } catch {
    // 非浏览器环境忽略
  }
}

/**
 * 朗读增益:HTMLAudioElement.volume 上限是 1.0,想更响就得走 Web Audio 的 GainNode。
 * 2.0 ≈ +6dB,再高容易削顶。
 */
const TTS_GAIN = 2.0;

let sharedAudioCtx: AudioContext | null = null;
function getAudioContext(): AudioContext {
  if (!sharedAudioCtx) {
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    sharedAudioCtx = new Ctor();
  }
  return sharedAudioCtx;
}

function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const len = bin.length;
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function speakFallback(text: string) {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 0.9;
    synth.speak(u);
  } catch {
    // 平台不支持就放弃
  }
}

// 进程内只保留一条正在播放的朗读;再次调用会打断前一条
let currentAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;

function stopCurrent() {
  if (currentAudio) {
    try {
      currentAudio.pause();
    } catch {
      // ignore
    }
    currentAudio = null;
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
}

export interface SpeakOptions {
  /** 播放倍速,默认 1.0 */
  speed?: number;
  /** 语种提示,默认 'en' */
  language?: string;
  /** 播放真正结束(ended/error)时的回调,用来给 UI 清理 loading 状态 */
  onDone?: () => void;
}

/**
 * 朗读一段文本。立即返回一个 stop 函数, 调用可中断当前播放。
 * 网络/接口错误会自动走 Web Speech 降级,尽量不让按钮彻底哑掉。
 */
export async function speakViaTTS(
  text: string,
  opts: SpeakOptions = {}
): Promise<() => void> {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    opts.onDone?.();
    return () => {};
  }

  stopCurrent();

  // 任何 TTS 开始前都通知 Player 暂停视频,避免原声和合成语音同时响。
  // 用自定义事件解耦,不直接依赖 videoRef。
  try {
    window.dispatchEvent(new Event('pauseVideo'));
  } catch {
    // 非浏览器环境忽略
  }

  const speed = Math.min(2.0, Math.max(0.5, opts.speed ?? 1.0));
  const language = opts.language ?? 'en';

  // 首次调用提示一下:首轮可能要去阿里云拉音频,有几秒等待;
  // 同一句文本命中缓存后会秒回,所以只提示一次。
  if (!firstTTSHintShown) {
    firstTTSHintShown = true;
    showToast('首次 AI 朗读正在生成音频,首轮约需几秒,命中缓存后会秒回');
  }

  // 本次 speakViaTTS 调用占用一个 activeOps 名额,只减一次
  activeOps++;
  emitSpeaking();
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    activeOps = Math.max(0, activeOps - 1);
    emitSpeaking();
  };

  try {
    const res = await window.api.ttsSynthesize({ text: trimmed, language });
    const blob = base64ToBlob(res.dataBase64, res.mime || 'audio/wav');
    const url = URL.createObjectURL(blob);
    currentUrl = url;
    const audio = new Audio(url);
    audio.playbackRate = speed;
    (audio as any).preservesPitch = true;
    (audio as any).mozPreservesPitch = true;
    (audio as any).webkitPreservesPitch = true;

    try {
      const ctx = getAudioContext();
      if (ctx.state === 'suspended') void ctx.resume();
      const source = ctx.createMediaElementSource(audio);
      const gain = ctx.createGain();
      gain.gain.value = TTS_GAIN;
      source.connect(gain).connect(ctx.destination);
    } catch (e) {
      // Web Audio 初始化失败就退化为原始音量播放
      console.warn('[tts] Web Audio 增益失败,使用默认音量:', e);
    }

    currentAudio = audio;
    const cleanup = () => {
      if (currentAudio === audio) {
        currentAudio = null;
      }
      URL.revokeObjectURL(url);
      if (currentUrl === url) currentUrl = null;
      opts.onDone?.();
      finish();
    };
    audio.onended = cleanup;
    audio.onerror = cleanup;
    await audio.play();
  } catch (err) {
    console.warn('Qwen-TTS 失败,降级到本地语音:', err);
    speakFallback(trimmed);
    opts.onDone?.();
    finish();
  }

  return () => {
    stopCurrent();
    opts.onDone?.();
    finish();
  };
}

/**
 * React 组件用:订阅全局 TTS 发声状态,用于给按钮展示 loading 动画。
 * 多处同时订阅互不干扰。
 */
export function useTTSSpeaking(): boolean {
  const [speaking, setSpeaking] = useState(lastEmittedSpeaking);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ speaking: boolean }>).detail;
      setSpeaking(!!detail?.speaking);
    };
    window.addEventListener(TTS_SPEAKING_EVENT, handler);
    return () => window.removeEventListener(TTS_SPEAKING_EVENT, handler);
  }, []);
  return speaking;
}

/**
 * 读取设置里配置的句子朗读倍速 (cfg.tts.speed), 失败时回落到 1.5。
 */
export async function getSentenceSpeed(): Promise<number> {
  try {
    const cfg = await window.api.configGet();
    const s = cfg?.tts?.speed;
    if (typeof s === 'number' && isFinite(s)) {
      return Math.min(2.0, Math.max(0.5, s));
    }
  } catch {
    // 读配置失败就用默认
  }
  return 1.5;
}
