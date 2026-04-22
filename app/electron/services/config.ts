import Store from 'electron-store';

export interface AppTTSConfig {
  /** qwen3-tts-flash / qwen3-tts-instruct-flash */
  model?: string;
  /** 音色,如 Cherry / Ethan / Jennifer / Ryan 等 */
  voice?: string;
  /** 语种提示: auto / en / zh / ja / ko / de / fr / es / it / pt / id */
  language?: string;
  /** 可覆盖的 endpoint(默认值在 tts.ts 里) */
  endpoint?: string;
  /**
   * 朗读倍速,合法区间 0.5 ~ 2.0, 默认 1.0。
   * Qwen-TTS 接口本身没有 speed 字段,所以是纯客户端播放倍速(audio.playbackRate),
   * 语调不变,速度变。参照 TTS_Voice/swift-macos 的 player.rate 实现。
   */
  speed?: number;
}

/**
 * OSS 的 bucket / region / prefix 可以给默认值，
 * AK/SK 默认留空，交给设置页写入本地配置。
 */
const DEFAULT_OSS = {
  region: 'oss-ap-northeast-1.aliyuncs.com',
  bucket: 'youtube-videos-1982',
  accessKeyId: '',
  accessKeySecret: '',
  prefix: 'video-learner/',
} as const;

export interface AppConfig {
  dashscopeApiKey: string;      // 阿里云百炼 / DashScope API Key，用于千问 ASR + 翻译
  oss: {
    region: string;
    bucket: string;
    accessKeyId: string;
    accessKeySecret: string;
    prefix?: string;
  };
  /** 字幕默认翻译目标语言 */
  translateTarget?: string;
  /** Qwen-TTS 配置 */
  tts?: AppTTSConfig;
}

const defaults: AppConfig = {
  dashscopeApiKey: '',
  oss: {
    ...DEFAULT_OSS,
  },
  translateTarget: '中文',
  tts: {
    model: 'qwen3-tts-flash',
    // 英文单词朗读更适配美式女声;仍可在设置里改
    voice: 'Jennifer',
    language: 'en',
    speed: 1.5,
  },
};

const store = new Store<AppConfig>({
  name: 'video-learner-config',
  defaults,
});

export function getConfig(): AppConfig {
  const stored = store.store;
  const storedOss = stored.oss || defaults.oss;
  return {
    dashscopeApiKey: store.get('dashscopeApiKey') || '',
    oss: {
      region: storedOss.region || DEFAULT_OSS.region,
      bucket: storedOss.bucket || DEFAULT_OSS.bucket,
      accessKeyId: storedOss.accessKeyId || '',
      accessKeySecret: storedOss.accessKeySecret || '',
      prefix: storedOss.prefix || DEFAULT_OSS.prefix,
    },
    translateTarget: store.get('translateTarget') || '中文',
    tts: { ...defaults.tts, ...(store.get('tts') || {}) },
  };
}

/**
 * 把 patch 里 undefined 的字段剔掉,避免把已保存的值意外清成 undefined。
 * (例如渲染进程只改 voice, 没传 model, spread 合并时 model=undefined 就会丢失)
 */
function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key in obj) {
    const v = obj[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

export function setConfig(cfg: Partial<AppConfig>) {
  const current = getConfig();

  if (cfg.dashscopeApiKey !== undefined) {
    store.set('dashscopeApiKey', cfg.dashscopeApiKey);
  }
  if (cfg.oss) {
    store.set('oss', { ...current.oss, ...stripUndefined(cfg.oss) });
  }
  if (cfg.translateTarget !== undefined) {
    store.set('translateTarget', cfg.translateTarget);
  }
  if (cfg.tts) {
    store.set('tts', { ...current.tts, ...stripUndefined(cfg.tts) });
  }

  console.log('[config] setConfig done');
  return getConfig();
}
